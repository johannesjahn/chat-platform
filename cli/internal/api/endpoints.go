package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/coder/websocket"
)

func id(n int64) string { return strconv.FormatInt(n, 10) }

func page(cursor string, limit int) url.Values {
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return q
}

// --- users ---

func (c *Client) GetUser(ctx context.Context, userID int64) (*User, error) {
	var u User
	return &u, c.Do(ctx, http.MethodGet, "/users/"+id(userID), nil, nil, &u)
}

// LookupUsername resolves a username (with or without a leading "@").
func (c *Client) LookupUsername(ctx context.Context, username string) (*User, error) {
	username = strings.TrimPrefix(username, "@")
	var users []User
	if err := c.Do(ctx, http.MethodGet, "/users/by-username", url.Values{"usernames": {username}}, nil, &users); err != nil {
		return nil, err
	}
	for _, u := range users {
		if strings.EqualFold(u.Username, username) {
			return &u, nil
		}
	}
	return nil, fmt.Errorf("no user named @%s", username)
}

func (c *Client) SearchUsers(ctx context.Context, q string) ([]User, error) {
	var users []User
	return users, c.Do(ctx, http.MethodGet, "/users/search", url.Values{"q": {q}}, nil, &users)
}

// SetStatus sets (or, with empty text and emoji, clears) the user's status.
func (c *Client) SetStatus(ctx context.Context, text, emoji string, expiresInMinutes int) (*User, error) {
	body := map[string]any{"statusText": nilIfEmpty(text), "statusEmoji": nilIfEmpty(emoji)}
	if expiresInMinutes > 0 {
		body["expiresInMinutes"] = expiresInMinutes
	}
	var u User
	return &u, c.Do(ctx, http.MethodPut, "/users/me/status", nil, body, &u)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// --- posts & comments ---

func (c *Client) ListPosts(ctx context.Context, cursor string, limit int) (*PostsPage, error) {
	var p PostsPage
	return &p, c.Do(ctx, http.MethodGet, "/posts", page(cursor, limit), nil, &p)
}

func (c *Client) ListUserPosts(ctx context.Context, userID int64, cursor string, limit int) (*PostsPage, error) {
	var p PostsPage
	return &p, c.Do(ctx, http.MethodGet, "/users/"+id(userID)+"/posts", page(cursor, limit), nil, &p)
}

func (c *Client) GetPost(ctx context.Context, postID int64) (*Post, error) {
	var p Post
	return &p, c.Do(ctx, http.MethodGet, "/posts/"+id(postID), nil, nil, &p)
}

// Content is a post or message body: text, an image URL, or an uploaded
// attachment (whose Content is then its caption/filename).
type Content struct {
	Type         ContentType
	Text         string
	AttachmentID int64
}

func (ct Content) fields() map[string]any {
	m := map[string]any{"contentType": ct.Type, "content": ct.Text}
	if ct.AttachmentID != 0 {
		m["attachmentId"] = ct.AttachmentID
	}
	return m
}

func (c *Client) CreatePost(ctx context.Context, content Content) (*Post, error) {
	var p Post
	return &p, c.Do(ctx, http.MethodPost, "/posts", nil, content.fields(), &p)
}

func (c *Client) UpdatePost(ctx context.Context, postID int64, content Content) (*Post, error) {
	var p Post
	return &p, c.Do(ctx, http.MethodPut, "/posts/"+id(postID), nil, content.fields(), &p)
}

func (c *Client) DeletePost(ctx context.Context, postID int64) error {
	return c.Do(ctx, http.MethodDelete, "/posts/"+id(postID), nil, nil, nil)
}

// React adds (or with remove=true, removes) an emoji reaction. kind is
// "posts" or "comments".
func (c *Client) React(ctx context.Context, kind string, targetID int64, emoji string, remove bool) (*ReactionState, error) {
	method := http.MethodPost
	if remove {
		method = http.MethodDelete
	}
	var s ReactionState
	return &s, c.Do(ctx, method, "/"+kind+"/"+id(targetID)+"/reactions", nil, map[string]string{"emoji": emoji}, &s)
}

func (c *Client) ListComments(ctx context.Context, postID int64, cursor string, limit int) (*CommentsPage, error) {
	var p CommentsPage
	return &p, c.Do(ctx, http.MethodGet, "/posts/"+id(postID)+"/comments", page(cursor, limit), nil, &p)
}

func (c *Client) ListReplies(ctx context.Context, commentID int64, cursor string, limit int) (*CommentsPage, error) {
	var p CommentsPage
	return &p, c.Do(ctx, http.MethodGet, "/comments/"+id(commentID)+"/replies", page(cursor, limit), nil, &p)
}

func (c *Client) CreateComment(ctx context.Context, postID int64, text string) (*Comment, error) {
	var cm Comment
	return &cm, c.Do(ctx, http.MethodPost, "/posts/"+id(postID)+"/comments", nil, map[string]string{"content": text}, &cm)
}

func (c *Client) CreateReply(ctx context.Context, commentID int64, text string) (*Comment, error) {
	var cm Comment
	return &cm, c.Do(ctx, http.MethodPost, "/comments/"+id(commentID)+"/replies", nil, map[string]string{"content": text}, &cm)
}

func (c *Client) UpdateComment(ctx context.Context, commentID int64, text string) (*Comment, error) {
	var cm Comment
	return &cm, c.Do(ctx, http.MethodPatch, "/comments/"+id(commentID), nil, map[string]string{"content": text}, &cm)
}

func (c *Client) DeleteComment(ctx context.Context, commentID int64) error {
	return c.Do(ctx, http.MethodDelete, "/comments/"+id(commentID), nil, nil, nil)
}

// --- chats ---

func (c *Client) ListChats(ctx context.Context, cursor string, limit int) (*ChatsPage, error) {
	var p ChatsPage
	return &p, c.Do(ctx, http.MethodGet, "/chats", page(cursor, limit), nil, &p)
}

func (c *Client) GetChat(ctx context.Context, chatID int64) (*Chat, error) {
	var ch Chat
	return &ch, c.Do(ctx, http.MethodGet, "/chats/"+id(chatID), nil, nil, &ch)
}

// DirectChat returns the 1:1 chat with a user, creating it if needed (the
// endpoint is idempotent per pair).
func (c *Client) DirectChat(ctx context.Context, userID int64) (*Chat, error) {
	var ch Chat
	return &ch, c.Do(ctx, http.MethodPost, "/chats/direct", nil, map[string]int64{"userId": userID}, &ch)
}

func (c *Client) CreateGroupChat(ctx context.Context, title string, participantIDs []int64) (*Chat, error) {
	var ch Chat
	return &ch, c.Do(ctx, http.MethodPost, "/chats/group", nil,
		map[string]any{"title": title, "participantIds": participantIDs}, &ch)
}

// MessageQuery pages a chat's history: newest page by default, or the page
// before/after a cursor.
type MessageQuery struct {
	Before, After string
	Limit         int
}

func (c *Client) ListMessages(ctx context.Context, chatID int64, mq MessageQuery) (*MessagesPage, error) {
	q := url.Values{}
	if mq.Before != "" {
		q.Set("before", mq.Before)
	}
	if mq.After != "" {
		q.Set("after", mq.After)
	}
	if mq.Limit > 0 {
		q.Set("limit", strconv.Itoa(mq.Limit))
	}
	var p MessagesPage
	return &p, c.Do(ctx, http.MethodGet, "/chats/"+id(chatID)+"/messages", q, nil, &p)
}

func (c *Client) SendMessage(ctx context.Context, chatID int64, content Content, replyTo int64) (*Message, error) {
	body := content.fields()
	if replyTo != 0 {
		body["parentMessageId"] = replyTo
	}
	var m Message
	return &m, c.Do(ctx, http.MethodPost, "/chats/"+id(chatID)+"/messages", nil, body, &m)
}

func (c *Client) EditMessage(ctx context.Context, chatID, messageID int64, text string) (*Message, error) {
	var m Message
	return &m, c.Do(ctx, http.MethodPut, "/chats/"+id(chatID)+"/messages/"+id(messageID), nil,
		map[string]string{"contentType": ContentText, "content": text}, &m)
}

func (c *Client) DeleteMessage(ctx context.Context, chatID, messageID int64) error {
	return c.Do(ctx, http.MethodDelete, "/chats/"+id(chatID)+"/messages/"+id(messageID), nil, nil, nil)
}

func (c *Client) ReactMessage(ctx context.Context, chatID, messageID int64, emoji string, remove bool) error {
	method := http.MethodPost
	if remove {
		method = http.MethodDelete
	}
	return c.Do(ctx, method, "/chats/"+id(chatID)+"/messages/"+id(messageID)+"/reactions", nil,
		map[string]string{"emoji": emoji}, nil)
}

func (c *Client) MarkRead(ctx context.Context, chatID, messageID int64) error {
	return c.Do(ctx, http.MethodPost, "/chats/"+id(chatID)+"/read", nil, map[string]int64{"messageId": messageID}, nil)
}

// --- notifications ---

func (c *Client) ListNotifications(ctx context.Context, cursor string, limit int) (*NotificationsPage, error) {
	var p NotificationsPage
	return &p, c.Do(ctx, http.MethodGet, "/notifications", page(cursor, limit), nil, &p)
}

func (c *Client) MarkAllNotificationsRead(ctx context.Context) error {
	return c.Do(ctx, http.MethodPost, "/notifications/read-all", nil, nil, nil)
}

// --- search ---

func (c *Client) SearchAll(ctx context.Context, q string, limit int) (*SearchAll, error) {
	query := page("", limit)
	query.Set("q", q)
	var s SearchAll
	return &s, c.Do(ctx, http.MethodGet, "/search", query, nil, &s)
}

// Raw performs an authenticated request and returns the response body
// verbatim — the escape hatch behind `chatctl api`.
func (c *Client) Raw(ctx context.Context, method, path string, query url.Values, body []byte) (json.RawMessage, error) {
	req := request{method: method, path: path, query: query, auth: true}
	if body != nil {
		req.body, req.contentType = body, "application/json"
	}
	var out json.RawMessage
	return out, c.send(ctx, req, &out)
}

// --- attachments ---

// Upload sends a local file to POST /attachments (a multipart "file" field).
// The body is buffered so it can be replayed after a token refresh; the
// server caps attachment size well within what that costs.
func (c *Client) Upload(ctx context.Context, path string) (*Attachment, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filepath.Base(path)))
	h.Set("Content-Type", http.DetectContentType(head[:n]))
	part, err := mw.CreatePart(h)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, f); err != nil {
		return nil, err
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	var a Attachment
	err = c.send(ctx, request{
		method: http.MethodPost, path: "/attachments", body: buf.Bytes(),
		contentType: mw.FormDataContentType(), auth: true,
	}, &a)
	return &a, err
}

// --- realtime ---

// DialRealtime opens the /ws socket. The socket authenticates with a
// short-lived single-use ticket minted over HTTP, not the bearer token.
func (c *Client) DialRealtime(ctx context.Context) (*websocket.Conn, error) {
	var t WsTicket
	if err := c.Do(ctx, http.MethodPost, "/realtime/ws-ticket", nil, nil, &t); err != nil {
		return nil, fmt.Errorf("minting realtime ticket: %w", err)
	}
	u, err := url.Parse(c.BaseURL() + "/ws")
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.RawQuery = url.Values{"ticket": {t.Ticket}}.Encode()
	conn, _, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{
		HTTPHeader: http.Header{"User-Agent": {c.UserAgent}},
	})
	if err != nil {
		return nil, fmt.Errorf("connecting to realtime socket: %w", err)
	}
	conn.SetReadLimit(1 << 20)
	return conn, nil
}
