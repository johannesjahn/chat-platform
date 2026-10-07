// Package api is a small typed client for the chat-platform HTTP API.
package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/johannesjahn/chat-platform/cli/internal/config"
)

// ErrNotLoggedIn is returned when a call needs a session the profile lacks.
var ErrNotLoggedIn = errors.New("not logged in — run `chatctl login`")

// ErrSessionExpired is returned when the refresh token is no longer
// accepted (expired, revoked by a logout elsewhere, or reuse-detected).
var ErrSessionExpired = errors.New("session expired — run `chatctl login` again")

// APIError is a non-2xx response. The backend encodes errors as
// {"_tag": "...", "message": "..."} (see the *Encoded schemas in openapi.json).
type APIError struct {
	Status  int
	Tag     string
	Message string
}

func (e *APIError) Error() string {
	switch {
	case e.Message != "" && e.Tag != "":
		return fmt.Sprintf("%s: %s (HTTP %d)", e.Tag, e.Message, e.Status)
	case e.Message != "":
		return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
	default:
		return fmt.Sprintf("HTTP %d %s", e.Status, http.StatusText(e.Status))
	}
}

// IsStatus reports whether err is an APIError with the given status.
func IsStatus(err error, status int) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == status
}

// refreshLeeway refreshes an access token this long before it expires, so a
// request doesn't race the expiry in flight.
const refreshLeeway = 30 * time.Second

// Client talks to one server on behalf of one profile. Token rotations are
// persisted back to the dotfile as they happen.
type Client struct {
	HTTP        *http.Client
	Store       *config.Store
	ProfileName string
	Profile     *config.Profile
	UserAgent   string

	mu  sync.Mutex
	now func() time.Time
}

// New builds a client for a profile.
func New(store *config.Store, name string, profile *config.Profile) *Client {
	return &Client{
		HTTP:        &http.Client{Timeout: 60 * time.Second},
		Store:       store,
		ProfileName: name,
		Profile:     profile,
		UserAgent:   "chatctl",
		now:         time.Now,
	}
}

// BaseURL is the profile's server without a trailing slash.
func (c *Client) BaseURL() string { return strings.TrimRight(c.Profile.Server, "/") }

// request is one HTTP call, kept as bytes so it can be replayed after a
// token refresh.
type request struct {
	method      string
	path        string
	query       url.Values
	body        []byte
	contentType string
	auth        bool
}

// Do performs an authenticated JSON request. body (if non-nil) is
// JSON-encoded; out (if non-nil) receives the decoded response.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	req := request{method: method, path: path, query: query, auth: true}
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		req.body, req.contentType = b, "application/json"
	}
	return c.send(ctx, req, out)
}

func (c *Client) send(ctx context.Context, req request, out any) error {
	if !req.auth {
		_, err := c.roundTrip(ctx, req, "", out)
		return err
	}
	token, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	status, err := c.roundTrip(ctx, req, token, out)
	if status != http.StatusUnauthorized {
		return err
	}
	// The token was rejected before its expiry (e.g. a role change bumped
	// the user's token version server-side): refresh once and replay.
	if rerr := c.refresh(ctx, token); rerr != nil {
		return rerr
	}
	_, err = c.roundTrip(ctx, req, c.currentAccess(), out)
	return err
}

func (c *Client) roundTrip(ctx context.Context, req request, token string, out any) (int, error) {
	u := c.BaseURL() + req.path
	if len(req.query) > 0 {
		u += "?" + req.query.Encode()
	}
	var body io.Reader
	if req.body != nil {
		body = bytes.NewReader(req.body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.method, u, body)
	if err != nil {
		return 0, err
	}
	if req.contentType != "" {
		httpReq.Header.Set("Content-Type", req.contentType)
	}
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("User-Agent", c.UserAgent)
	if token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return 0, fmt.Errorf("%s %s: %w", req.method, req.path, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return resp.StatusCode, decodeError(resp.StatusCode, data)
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if raw, ok := out.(*json.RawMessage); ok {
			*raw = append((*raw)[:0], data...)
			return resp.StatusCode, nil
		}
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("decoding %s %s response: %w", req.method, req.path, err)
		}
	}
	return resp.StatusCode, nil
}

func decodeError(status int, data []byte) error {
	e := &APIError{Status: status}
	var body struct {
		Tag     string `json:"_tag"`
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &body) == nil {
		e.Tag, e.Message = body.Tag, body.Message
	} else if text := strings.TrimSpace(string(data)); text != "" {
		if len(text) > 200 {
			text = text[:200] + "…"
		}
		e.Message = text
	}
	return e
}

func (c *Client) currentAccess() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Profile.AccessToken
}

// accessToken returns a usable access token, refreshing first if the stored
// one is missing or about to expire.
func (c *Client) accessToken(ctx context.Context) (string, error) {
	token := c.currentAccess()
	if token != "" && !c.expiring(token) {
		return token, nil
	}
	if err := c.refresh(ctx, token); err != nil {
		return "", err
	}
	return c.currentAccess(), nil
}

func (c *Client) expiring(token string) bool {
	exp, ok := tokenExpiry(token)
	return ok && !c.now().Add(refreshLeeway).Before(exp)
}

// refresh rotates the session. stale is the access token the caller found
// unusable; if another goroutine already replaced it, this is a no-op.
//
// Refresh tokens are single-use: the backend rotates them and treats a
// replayed one as theft, revoking the whole session family. So before
// spending ours, re-read the dotfile — another chatctl process may already
// have rotated it, in which case we adopt its tokens instead.
func (c *Client) refresh(ctx context.Context, stale string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.Profile.AccessToken != stale {
		return nil
	}
	if f, err := c.Store.Load(); err == nil {
		if p := f.Profiles[c.ProfileName]; p != nil && p.Server == c.Profile.Server &&
			p.RefreshToken != "" && p.RefreshToken != c.Profile.RefreshToken {
			c.Profile.AccessToken, c.Profile.RefreshToken = p.AccessToken, p.RefreshToken
			if p.AccessToken != "" && !c.expiring(p.AccessToken) {
				return nil
			}
		}
	}
	if c.Profile.RefreshToken == "" {
		return ErrNotLoggedIn
	}
	var out RefreshResponse
	body, _ := json.Marshal(map[string]string{"refreshToken": c.Profile.RefreshToken})
	_, err := c.roundTrip(ctx, request{
		method: http.MethodPost, path: "/users/refresh", body: body, contentType: "application/json",
	}, "", &out)
	if IsStatus(err, http.StatusUnauthorized) {
		return ErrSessionExpired
	}
	if err != nil {
		return fmt.Errorf("refreshing session: %w", err)
	}
	c.Profile.AccessToken, c.Profile.RefreshToken = out.AccessToken, out.RefreshToken
	return c.persist()
}

// persist writes this client's profile back to the dotfile. Callers hold mu
// (or are single-threaded, as during login).
func (c *Client) persist() error {
	snapshot := *c.Profile
	return c.Store.Update(func(f *config.File) error {
		f.Profiles[c.ProfileName] = &snapshot
		return nil
	})
}

// tokenExpiry reads a JWT's `exp` claim without verifying the signature —
// it's only used to decide when to refresh; the server does the verifying.
func tokenExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp float64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp == 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(claims.Exp), 0), true
}

// Login exchanges credentials for a session and saves it to the profile.
func (c *Client) Login(ctx context.Context, username, password string) (*LoginResponse, error) {
	body, _ := json.Marshal(map[string]string{"username": username, "password": password})
	var out LoginResponse
	if err := c.send(ctx, request{
		method: http.MethodPost, path: "/users/login", body: body, contentType: "application/json",
	}, &out); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Profile.AccessToken, c.Profile.RefreshToken = out.AccessToken, out.RefreshToken
	c.Profile.User = &config.User{ID: out.User.ID, Username: out.User.Username}
	return &out, c.persist()
}

// Logout revokes the session server-side (all of the user's sessions with
// all=true) and clears it from the profile. The local session is cleared
// even if the server call fails, so a dead token can't wedge the profile.
func (c *Client) Logout(ctx context.Context, all bool) error {
	c.mu.Lock()
	refreshToken := c.Profile.RefreshToken
	c.mu.Unlock()
	var serverErr error
	if refreshToken != "" {
		body, _ := json.Marshal(map[string]any{"refreshToken": refreshToken, "allSessions": all})
		serverErr = c.send(ctx, request{
			method: http.MethodPost, path: "/users/logout", body: body, contentType: "application/json",
		}, nil)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Profile.AccessToken, c.Profile.RefreshToken, c.Profile.User = "", "", nil
	if err := c.persist(); err != nil {
		return err
	}
	return serverErr
}
