package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/johannesjahn/chat-platform/cli/internal/config"
)

// jwt builds an unsigned token with the given expiry; the client only reads
// `exp`, the server is what verifies.
func jwt(exp time.Time) string {
	enc := base64.RawURLEncoding.EncodeToString
	payload, _ := json.Marshal(map[string]any{"exp": exp.Unix(), "sub": "1"})
	return enc([]byte(`{"alg":"HS256"}`)) + "." + enc(payload) + ".sig"
}

// fakeServer issues rotating refresh tokens like the real backend: each
// refresh token works once.
type fakeServer struct {
	mu        sync.Mutex
	valid     map[string]string // access token -> ok
	refresh   map[string]bool   // live refresh tokens
	refreshes int
	n         int
	accessTTL time.Duration
}

func newFakeServer(t *testing.T) (*fakeServer, *httptest.Server) {
	f := &fakeServer{valid: map[string]string{}, refresh: map[string]bool{}, accessTTL: time.Hour}
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeServer) issue() (string, string) {
	f.n++
	access := jwt(time.Now().Add(f.accessTTL)) + fmt.Sprint(f.n)
	refresh := fmt.Sprintf("refresh-%d", f.n)
	f.valid[access] = "ok"
	f.refresh[refresh] = true
	return access, refresh
}

func (f *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/users/login":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["password"] != "secret" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"_tag":"InvalidCredentials","message":"Invalid username or password"}`)
			return
		}
		access, refresh := f.issue()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user": map[string]any{"id": 7, "username": body["username"]}, "accessToken": access, "refreshToken": refresh,
		})
	case "/users/refresh":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.refreshes++
		if !f.refresh[body["refreshToken"]] {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"_tag":"Unauthorized","message":"Invalid or expired refresh token"}`)
			return
		}
		delete(f.refresh, body["refreshToken"])
		access, refresh := f.issue()
		_ = json.NewEncoder(w).Encode(map[string]string{"accessToken": access, "refreshToken": refresh})
	default:
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if f.valid[token] == "" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"_tag":"Unauthorized","message":"Invalid token"}`)
			return
		}
		fmt.Fprint(w, `{"id":7,"username":"alice","displayName":null,"role":"user","statusText":null,"statusEmoji":null}`)
	}
}

func newTestClient(t *testing.T, srv *httptest.Server) (*Client, *config.Store) {
	store := &config.Store{Path: filepath.Join(t.TempDir(), "chatctl.json")}
	return New(store, "default", &config.Profile{Server: srv.URL}), store
}

func TestLoginPersistsSession(t *testing.T) {
	_, srv := newFakeServer(t)
	c, store := newTestClient(t, srv)
	if _, err := c.Login(context.Background(), "alice", "secret"); err != nil {
		t.Fatal(err)
	}
	f, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	p := f.Profiles["default"]
	if p == nil || p.RefreshToken == "" || p.AccessToken == "" || p.User == nil || p.User.Username != "alice" {
		t.Fatalf("session not persisted: %+v", p)
	}
}

func TestLoginBadPassword(t *testing.T) {
	_, srv := newFakeServer(t)
	c, _ := newTestClient(t, srv)
	_, err := c.Login(context.Background(), "alice", "nope")
	if !IsStatus(err, 401) {
		t.Fatalf("want 401 APIError, got %v", err)
	}
	if !strings.Contains(err.Error(), "Invalid username or password") {
		t.Fatalf("error message not surfaced: %v", err)
	}
}

func TestRefreshesExpiredTokenAndPersistsRotation(t *testing.T) {
	fake, srv := newFakeServer(t)
	c, store := newTestClient(t, srv)
	ctx := context.Background()
	if _, err := c.Login(ctx, "alice", "secret"); err != nil {
		t.Fatal(err)
	}
	oldRefresh := c.Profile.RefreshToken
	// Pretend the access token is about to expire.
	c.now = func() time.Time { return time.Now().Add(2 * time.Hour) }

	if _, err := c.GetUser(ctx, 7); err != nil {
		t.Fatal(err)
	}
	if fake.refreshes != 1 {
		t.Fatalf("want 1 refresh, got %d", fake.refreshes)
	}
	f, _ := store.Load()
	if got := f.Profiles["default"].RefreshToken; got == oldRefresh || got != c.Profile.RefreshToken {
		t.Fatalf("rotated refresh token not persisted: file=%q client=%q old=%q", got, c.Profile.RefreshToken, oldRefresh)
	}
}

func TestRetriesOnceAfter401(t *testing.T) {
	fake, srv := newFakeServer(t)
	c, _ := newTestClient(t, srv)
	ctx := context.Background()
	if _, err := c.Login(ctx, "alice", "secret"); err != nil {
		t.Fatal(err)
	}
	// Server-side revocation of a not-yet-expired access token.
	fake.mu.Lock()
	fake.valid = map[string]string{}
	fake.mu.Unlock()
	if _, err := c.GetUser(ctx, 7); err != nil {
		t.Fatalf("want transparent refresh + retry, got %v", err)
	}
	if fake.refreshes != 1 {
		t.Fatalf("want 1 refresh, got %d", fake.refreshes)
	}
}

func TestAdoptsTokensRotatedByAnotherProcess(t *testing.T) {
	fake, srv := newFakeServer(t)
	ctx := context.Background()
	store := &config.Store{Path: filepath.Join(t.TempDir(), "chatctl.json")}
	first := New(store, "default", &config.Profile{Server: srv.URL})
	if _, err := first.Login(ctx, "alice", "secret"); err != nil {
		t.Fatal(err)
	}
	// A second process loaded the same (soon-stale) session.
	f, _ := store.Load()
	second := New(store, "default", f.Profiles["default"])

	// The first process refreshes, spending the shared refresh token.
	first.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err := first.GetUser(ctx, 7); err != nil {
		t.Fatal(err)
	}
	// The second must pick up the rotated tokens from disk rather than
	// replaying the spent refresh token (which the real server would treat
	// as theft and revoke the whole session family for).
	fake.mu.Lock()
	fake.valid = map[string]string{first.Profile.AccessToken: "ok"}
	fake.mu.Unlock()
	if _, err := second.GetUser(ctx, 7); err != nil {
		t.Fatalf("second process failed: %v", err)
	}
	if fake.refreshes != 1 {
		t.Fatalf("want the second process to reuse the first's refresh, got %d refreshes", fake.refreshes)
	}
}

func TestSessionExpired(t *testing.T) {
	fake, srv := newFakeServer(t)
	c, _ := newTestClient(t, srv)
	ctx := context.Background()
	if _, err := c.Login(ctx, "alice", "secret"); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.valid, fake.refresh = map[string]string{}, map[string]bool{}
	fake.mu.Unlock()
	if _, err := c.GetUser(ctx, 7); err != ErrSessionExpired {
		t.Fatalf("want ErrSessionExpired, got %v", err)
	}
}

func TestNotLoggedIn(t *testing.T) {
	_, srv := newFakeServer(t)
	c, _ := newTestClient(t, srv)
	if _, err := c.GetUser(context.Background(), 7); err != ErrNotLoggedIn {
		t.Fatalf("want ErrNotLoggedIn, got %v", err)
	}
}

func TestTokenExpiry(t *testing.T) {
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	got, ok := tokenExpiry(jwt(exp))
	if !ok || !got.Equal(exp) {
		t.Fatalf("got %v %v, want %v", got, ok, exp)
	}
	if _, ok := tokenExpiry("not-a-jwt"); ok {
		t.Fatal("garbage token parsed")
	}
}
