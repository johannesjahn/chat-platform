package api

import "time"

// These mirror the schemas in the backend's openapi.json (generated from
// src/Api.ts). Only fields the CLI reads are declared; unknown fields are
// ignored on decode, so additive backend changes don't break the CLI.

// Millis is a Unix-epoch timestamp in milliseconds, as the API sends them.
type Millis int64

// Time converts to a local time.Time.
func (m Millis) Time() time.Time { return time.UnixMilli(int64(m)) }

type User struct {
	ID          int64   `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"displayName"`
	Role        string  `json:"role"`
	StatusText  *string `json:"statusText"`
	StatusEmoji *string `json:"statusEmoji"`
}

// Name is how a user is shown: "Display Name (@user)" or just "@user".
func (u User) Name() string {
	if u.DisplayName != nil && *u.DisplayName != "" {
		return *u.DisplayName + " (@" + u.Username + ")"
	}
	return "@" + u.Username
}

type LoginResponse struct {
	User         User   `json:"user"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

type RefreshResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

type ReactionSummary struct {
	Emoji       string `json:"emoji"`
	Count       int    `json:"count"`
	ReactedByMe bool   `json:"reactedByMe"`
}

type ReactionState struct {
	Reactions []ReactionSummary `json:"reactions"`
}

type Attachment struct {
	ID       int64  `json:"id"`
	Filename string `json:"filename"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	URL      string `json:"url"`
}

// ContentType is shared by posts and messages: "text", "image_url" or
// "attachment".
type ContentType = string

const (
	ContentText       ContentType = "text"
	ContentImageURL   ContentType = "image_url"
	ContentAttachment ContentType = "attachment"
)

type Post struct {
	ID           int64             `json:"id"`
	AuthorID     int64             `json:"authorId"`
	ContentType  ContentType       `json:"contentType"`
	Content      string            `json:"content"`
	Attachment   *Attachment       `json:"attachment"`
	CreatedAt    Millis            `json:"createdAt"`
	UpdatedAt    Millis            `json:"updatedAt"`
	Reactions    []ReactionSummary `json:"reactions"`
	CommentCount int               `json:"commentCount"`
}

type PostsPage struct {
	Posts      []Post  `json:"posts"`
	NextCursor *string `json:"nextCursor"`
}

type Comment struct {
	ID              int64             `json:"id"`
	PostID          int64             `json:"postId"`
	ParentCommentID *int64            `json:"parentCommentId"`
	AuthorID        int64             `json:"authorId"`
	Content         string            `json:"content"`
	CreatedAt       Millis            `json:"createdAt"`
	Reactions       []ReactionSummary `json:"reactions"`
	ReplyCount      int               `json:"replyCount"`
}

type CommentsPage struct {
	Comments   []Comment `json:"comments"`
	NextCursor *string   `json:"nextCursor"`
}

type ChatParticipant struct {
	UserID      int64   `json:"userId"`
	Username    string  `json:"username"`
	DisplayName *string `json:"displayName"`
	Role        string  `json:"role"`
}

type ParentMessagePreview struct {
	ID         int64  `json:"id"`
	SenderName string `json:"senderName"`
	Content    string `json:"content"`
}

type Message struct {
	ID            int64                 `json:"id"`
	ChatID        int64                 `json:"chatId"`
	SenderID      int64                 `json:"senderId"`
	ContentType   ContentType           `json:"contentType"`
	Content       string                `json:"content"`
	Attachment    *Attachment           `json:"attachment"`
	ParentMessage *ParentMessagePreview `json:"parentMessage"`
	CreatedAt     Millis                `json:"createdAt"`
	UpdatedAt     Millis                `json:"updatedAt"`
	Reactions     []ReactionSummary     `json:"reactions"`
	Pinned        bool                  `json:"pinned"`
}

type MessagesPage struct {
	Messages       []Message `json:"messages"`
	HasEarlier     bool      `json:"hasEarlier"`
	HasNewer       bool      `json:"hasNewer"`
	EarliestCursor *string   `json:"earliestCursor"`
	LatestCursor   *string   `json:"latestCursor"`
}

type Chat struct {
	ID           int64             `json:"id"`
	Type         string            `json:"type"` // "direct" | "group"
	Title        *string           `json:"title"`
	Participants []ChatParticipant `json:"participants"`
	LastMessage  *Message          `json:"lastMessage"`
	UnreadCount  int               `json:"unreadCount"`
	UpdatedAt    Millis            `json:"updatedAt"`
	Version      int64             `json:"version"`
}

type ChatsPage struct {
	Chats      []Chat  `json:"chats"`
	NextCursor *string `json:"nextCursor"`
}

type Notification struct {
	ID        int64   `json:"id"`
	Type      string  `json:"type"`
	Actor     User    `json:"actor"`
	PostID    *int64  `json:"postId"`
	CommentID *int64  `json:"commentId"`
	Emoji     *string `json:"emoji"`
	Game      *string `json:"game"`
	LobbyID   *int64  `json:"lobbyId"`
	Excerpt   *string `json:"excerpt"`
	Read      bool    `json:"read"`
	CreatedAt Millis  `json:"createdAt"`
}

type NotificationsPage struct {
	Notifications []Notification `json:"notifications"`
	NextCursor    *string        `json:"nextCursor"`
	UnreadCount   int            `json:"unreadCount"`
}

type SnippetSegment struct {
	Text  string `json:"text"`
	Match bool   `json:"match"`
}

type UserSearchResult struct {
	User    User             `json:"user"`
	Snippet []SnippetSegment `json:"snippet"`
}

type PostSearchResult struct {
	ID        int64            `json:"id"`
	Author    User             `json:"author"`
	CreatedAt Millis           `json:"createdAt"`
	Snippet   []SnippetSegment `json:"snippet"`
}

type CommentSearchResult struct {
	ID        int64            `json:"id"`
	PostID    int64            `json:"postId"`
	Author    User             `json:"author"`
	CreatedAt Millis           `json:"createdAt"`
	Snippet   []SnippetSegment `json:"snippet"`
}

type MessageSearchResult struct {
	ID        int64            `json:"id"`
	ChatID    int64            `json:"chatId"`
	Sender    User             `json:"sender"`
	CreatedAt Millis           `json:"createdAt"`
	Snippet   []SnippetSegment `json:"snippet"`
}

type SearchPage[T any] struct {
	Results    []T     `json:"results"`
	NextCursor *string `json:"nextCursor"`
}

type SearchAll struct {
	Users    SearchPage[UserSearchResult]    `json:"users"`
	Posts    SearchPage[PostSearchResult]    `json:"posts"`
	Comments SearchPage[CommentSearchResult] `json:"comments"`
	Messages SearchPage[MessageSearchResult] `json:"messages"`
}

type WsTicket struct {
	Ticket string `json:"ticket"`
}

// Event is a realtime frame from /ws. Only the fields the CLI acts on are
// decoded; see src/Realtime.ts for the full set of event types.
type Event struct {
	Type   string `json:"type"`
	ChatID int64  `json:"chatId"`
	UserID int64  `json:"userId"`
}

// ReactionEmojis is the fixed set the backend accepts (ReactionEmoji in
// src/Api.ts).
var ReactionEmojis = []string{"👍", "❤️", "😂", "😮", "😢", "😡"}
