package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	"github.com/johannesjahn/chat-platform/cli/internal/api"
)

const chatTargetHelp = `CHAT is a chat id (42), a username for a direct message (@alice — the DM
is created on first use), or a group chat's title.`

// resolveChat turns a CHAT argument into a chat.
func (a *app) resolveChat(ctx context.Context, c *api.Client, target string) (*api.Chat, error) {
	if strings.HasPrefix(target, "@") {
		u, err := c.LookupUsername(ctx, target)
		if err != nil {
			return nil, err
		}
		return c.DirectChat(ctx, u.ID)
	}
	if n, err := strconv.ParseInt(strings.TrimPrefix(target, "#"), 10, 64); err == nil {
		return c.GetChat(ctx, n)
	}
	// Fall back to a title match over the user's chats.
	cursor := ""
	for range 10 {
		page, err := c.ListChats(ctx, cursor, 100)
		if err != nil {
			return nil, err
		}
		for i, ch := range page.Chats {
			if ch.Title != nil && strings.EqualFold(*ch.Title, target) {
				return &page.Chats[i], nil
			}
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	return nil, fmt.Errorf("no chat matching %q (use a chat id, @username, or exact group title)", target)
}

// chatName is a chat's display name from the viewer's side.
func (a *app) chatName(ch *api.Chat) string {
	if ch.Type == "group" && ch.Title != nil {
		return *ch.Title
	}
	var names []string
	for _, p := range ch.Participants {
		if p.UserID != a.me() {
			names = append(names, "@"+p.Username)
		}
	}
	if len(names) == 0 {
		return "(just you)"
	}
	return strings.Join(names, ", ")
}

// chatView renders messages for one chat, resolving senders from its
// participant list (falling back to a lookup for people who've left).
type chatView struct {
	a       *app
	chat    *api.Chat
	lastDay string
}

func (v *chatView) sender(ctx context.Context, id int64) string {
	name := ""
	for _, p := range v.chat.Participants {
		if p.UserID == id {
			name = "@" + p.Username
		}
	}
	if name == "" {
		name = "@" + v.a.user(ctx, id).Username
	}
	if id == v.a.me() {
		return styleMe(name)
	}
	return styleUser(name)
}

func (v *chatView) print(ctx context.Context, m *api.Message) {
	t := m.CreatedAt.Time()
	if day := t.Format("Mon 2 Jan 2006"); day != v.lastDay {
		v.lastDay = day
		fmt.Fprintln(v.a.out, styleDim("── "+day+" ──"))
	}
	if m.ParentMessage != nil {
		quote := strings.ReplaceAll(m.ParentMessage.Content, "\n", " ")
		if r := []rune(quote); len(r) > 60 {
			quote = string(r[:60]) + "…"
		}
		fmt.Fprintln(v.a.out, styleDim(fmt.Sprintf("       ↱ %s: %s", m.ParentMessage.SenderName, quote)))
	}
	body := contentText(m.ContentType, m.Content, m.Attachment)
	body = strings.ReplaceAll(body, "\n", "\n       ")
	extra := ""
	if m.UpdatedAt > m.CreatedAt {
		extra += " (edited)"
	}
	if m.Pinned {
		extra += " 📌"
	}
	fmt.Fprintf(v.a.out, "%s  %s: %s%s %s\n", styleDim(t.Format("15:04")), v.sender(ctx, m.SenderID), body,
		styleDim(extra), styleDim(fmt.Sprintf("#%d", m.ID)))
	if r := reactionsLine(m.Reactions); r != "" {
		fmt.Fprintln(v.a.out, "       "+r)
	}
}

func chatsCmd(a *app) *cobra.Command {
	var limit int
	var cursor string
	var unread bool
	cmd := &cobra.Command{
		Use:   "chats",
		Short: "List your chats, most recent first",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			page, err := c.ListChats(cmd.Context(), cursor, limit)
			if err != nil {
				return err
			}
			if unread {
				kept := page.Chats[:0]
				for _, ch := range page.Chats {
					if ch.UnreadCount > 0 {
						kept = append(kept, ch)
					}
				}
				page.Chats = kept
			}
			if a.jsonOut {
				return a.emitJSON(page)
			}
			if len(page.Chats) == 0 {
				fmt.Fprintln(a.out, "No chats.")
				return nil
			}
			for i := range page.Chats {
				ch := &page.Chats[i]
				name := a.chatName(ch)
				if ch.UnreadCount > 0 {
					name = styleUnread(fmt.Sprintf("%s (%d new)", name, ch.UnreadCount))
				} else {
					name = styleBold(name)
				}
				fmt.Fprintf(a.out, "%s  %s %s\n", styleDim(fmt.Sprintf("%5d", ch.ID)), name, styleDim("· "+ago(ch.UpdatedAt.Time())))
				if m := ch.LastMessage; m != nil {
					preview := strings.ReplaceAll(contentText(m.ContentType, m.Content, nil), "\n", " ")
					if r := []rune(preview); len(r) > 70 {
						preview = string(r[:70]) + "…"
					}
					who := ""
					for _, p := range ch.Participants {
						if p.UserID == m.SenderID {
							who = "@" + p.Username + ": "
						}
					}
					fmt.Fprintln(a.out, "       "+styleDim(who)+preview)
				}
			}
			nextPageHint(a, page.NextCursor, "--cursor")
			return nil
		},
	}
	cmd.Flags().IntVarP(&limit, "limit", "n", 20, "number of chats")
	cmd.Flags().StringVar(&cursor, "cursor", "", "page cursor from a previous call")
	cmd.Flags().BoolVar(&unread, "unread", false, "only chats with unread messages")
	return cmd
}

func chatCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "chat",
		Short: "Read, send, and live-follow chat messages",
		Long:  "Read, send, and live-follow chat messages.\n\n" + chatTargetHelp,
	}

	var showLimit int
	var before string
	var markRead bool
	show := &cobra.Command{
		Use:   "show CHAT",
		Short: "Show recent messages in a chat",
		Example: `  chatctl chat show @alice
  chatctl chat show 12 -n 50
  chatctl chat show "Team standup" --read`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			ch, err := a.resolveChat(ctx, c, args[0])
			if err != nil {
				return err
			}
			page, err := c.ListMessages(ctx, ch.ID, api.MessageQuery{Before: before, Limit: showLimit})
			if err != nil {
				return err
			}
			if markRead && len(page.Messages) > 0 && before == "" {
				if err := c.MarkRead(ctx, ch.ID, page.Messages[len(page.Messages)-1].ID); err != nil {
					return err
				}
			}
			if a.jsonOut {
				return a.emitJSON(page)
			}
			fmt.Fprintf(a.out, "%s %s\n", styleBold(a.chatName(ch)), styleDim(fmt.Sprintf("· chat %d", ch.ID)))
			if len(page.Messages) == 0 {
				fmt.Fprintln(a.out, styleDim("No messages yet."))
			}
			v := &chatView{a: a, chat: ch}
			for i := range page.Messages {
				v.print(ctx, &page.Messages[i])
			}
			if page.HasEarlier && page.EarliestCursor != nil {
				nextPageHint(a, page.EarliestCursor, "earlier: --before")
			}
			return nil
		},
	}
	show.Flags().IntVarP(&showLimit, "limit", "n", 20, "number of messages")
	show.Flags().StringVar(&before, "before", "", "show the page before this cursor")
	show.Flags().BoolVar(&markRead, "read", false, "mark the chat read up to the newest message shown")

	cmd.AddCommand(show, sendCmd(a, "send CHAT [TEXT | -]", "Send a message to a chat"), openCmd(a))

	group := &cobra.Command{
		Use:     "group TITLE @user...",
		Short:   "Create a group chat",
		Example: `  chatctl chat group "Weekend plans" @alice @bob`,
		Args:    cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			var ids []int64
			for _, name := range args[1:] {
				u, err := a.resolveUser(ctx, c, name)
				if err != nil {
					return err
				}
				ids = append(ids, u.ID)
			}
			ch, err := c.CreateGroupChat(ctx, args[0], ids)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(ch)
			}
			fmt.Fprintf(a.out, "Created group %q (chat %d).\n", args[0], ch.ID)
			return nil
		},
	}

	read := &cobra.Command{
		Use:   "read CHAT",
		Short: "Mark a chat as read",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			ch, err := a.resolveChat(ctx, c, args[0])
			if err != nil {
				return err
			}
			if ch.LastMessage == nil {
				return nil
			}
			return c.MarkRead(ctx, ch.ID, ch.LastMessage.ID)
		},
	}

	edit := &cobra.Command{
		Use:   "edit CHAT MESSAGE_ID [TEXT | -]",
		Short: "Edit one of your messages",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, ch, msgID, err := a.chatAndMessage(ctx, args)
			if err != nil {
				return err
			}
			text, err := a.readText(args[2:], false)
			if err != nil {
				return err
			}
			m, err := c.EditMessage(ctx, ch.ID, msgID, text)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(m)
			}
			fmt.Fprintf(a.out, "Edited #%d.\n", m.ID)
			return nil
		},
	}

	del := &cobra.Command{
		Use:   "delete CHAT MESSAGE_ID",
		Short: "Delete one of your messages",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, ch, msgID, err := a.chatAndMessage(ctx, args)
			if err != nil {
				return err
			}
			if err := c.DeleteMessage(ctx, ch.ID, msgID); err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Deleted #%d.\n", msgID)
			return nil
		},
	}

	var remove bool
	react := &cobra.Command{
		Use:     "react CHAT MESSAGE_ID EMOJI",
		Short:   "React to a message",
		Example: "  chatctl chat react @alice 931 haha",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			emoji, err := parseReaction(args[2])
			if err != nil {
				return err
			}
			c, ch, msgID, err := a.chatAndMessage(ctx, args)
			if err != nil {
				return err
			}
			return c.ReactMessage(ctx, ch.ID, msgID, emoji, remove)
		},
	}
	react.Flags().BoolVar(&remove, "remove", false, "remove the reaction instead of adding it")

	cmd.AddCommand(group, read, edit, del, react)
	return cmd
}

func (a *app) chatAndMessage(ctx context.Context, args []string) (*api.Client, *api.Chat, int64, error) {
	msgID, err := parseID(args[1], "message")
	if err != nil {
		return nil, nil, 0, err
	}
	c, err := a.Client()
	if err != nil {
		return nil, nil, 0, err
	}
	ch, err := a.resolveChat(ctx, c, args[0])
	if err != nil {
		return nil, nil, 0, err
	}
	return c, ch, msgID, nil
}

// dmCmd is a top-level shortcut: `chatctl dm @alice hi` == `chatctl chat send @alice hi`.
func dmCmd(a *app) *cobra.Command {
	cmd := sendCmd(a, "dm @USER [TEXT | -]", "Send a direct message (shortcut for `chat send @USER`)")
	inner := cmd.RunE
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		if !strings.HasPrefix(args[0], "@") {
			args[0] = "@" + args[0]
		}
		return inner(cmd, args)
	}
	return cmd
}

func sendCmd(a *app, use, short string) *cobra.Command {
	var imageURL, attach string
	var replyTo int64
	cmd := &cobra.Command{
		Use:   use,
		Short: short,
		Long:  short + ".\n\n" + chatTargetHelp,
		Example: `  chatctl chat send @alice "lunch?"
  chatctl dm alice "lunch?"
  chatctl chat send 12 --reply-to 931 "sounds good"
  make test 2>&1 | tail -5 | chatctl chat send "CI alerts" -
  chatctl chat send @bob --attach ./notes.pdf "here you go"`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			text, err := a.readText(args[1:], imageURL != "" || attach != "")
			if err != nil {
				return err
			}
			ch, err := a.resolveChat(ctx, c, args[0])
			if err != nil {
				return err
			}
			content, err := a.content(ctx, c, text, imageURL, attach)
			if err != nil {
				return err
			}
			m, err := c.SendMessage(ctx, ch.ID, content, replyTo)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(m)
			}
			fmt.Fprintf(a.out, "Sent #%d to %s.\n", m.ID, a.chatName(ch))
			return nil
		},
	}
	cmd.Flags().StringVar(&imageURL, "image", "", "send an image by URL instead of text")
	cmd.Flags().StringVar(&attach, "attach", "", "upload a local file and send it (TEXT becomes its caption)")
	cmd.Flags().Int64Var(&replyTo, "reply-to", 0, "quote-reply to this message id")
	return cmd
}

// openCmd is the interactive chat: history, then live messages over the
// realtime socket, with each line typed on stdin sent as a message.
func openCmd(a *app) *cobra.Command {
	var limit int
	var readOnly bool
	cmd := &cobra.Command{
		Use:     "open CHAT",
		Aliases: []string{"follow"},
		Short:   "Open a chat live: new messages stream in, lines you type are sent",
		Long: `Open a chat live. Recent history is shown, new messages stream in over the
realtime socket as they arrive, and every line you type is sent as a message.
Ctrl-D or Ctrl-C leaves. With --read-only (or the "follow" alias) nothing is
read from stdin.

` + chatTargetHelp,
		Example: `  chatctl chat open @alice
  chatctl chat follow "Team standup"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := context.WithCancel(cmd.Context())
			defer cancel()
			c, err := a.Client()
			if err != nil {
				return err
			}
			ch, err := a.resolveChat(ctx, c, args[0])
			if err != nil {
				return err
			}
			if cmd.CalledAs() == "follow" {
				readOnly = true
			}
			f := &follower{a: a, c: c, view: &chatView{a: a, chat: ch}, json: a.jsonOut}

			page, err := c.ListMessages(ctx, ch.ID, api.MessageQuery{Limit: limit})
			if err != nil {
				return err
			}
			if !a.jsonOut {
				hint := "type a message and press Enter · Ctrl-D to leave"
				if readOnly {
					hint = "following · Ctrl-C to stop"
				}
				fmt.Fprintf(a.errOut, "%s %s\n", styleBold(a.chatName(ch)), styleDim("· "+hint))
			}
			f.emit(ctx, page)
			if page.LatestCursor != nil {
				f.cursor = *page.LatestCursor
			}

			errs := make(chan error, 2)
			go func() { errs <- f.listen(ctx) }()
			if !readOnly {
				go func() { errs <- f.sendLines(ctx) }()
			}
			select {
			case err := <-errs:
				return err
			case <-ctx.Done():
				return nil
			}
		},
	}
	cmd.Flags().IntVarP(&limit, "limit", "n", 20, "number of history messages to show first")
	cmd.Flags().BoolVar(&readOnly, "read-only", false, "only watch; don't read messages from stdin")
	return cmd
}

type follower struct {
	a    *app
	c    *api.Client
	view *chatView
	json bool

	mu     sync.Mutex // guards cursor and serializes output
	cursor string
}

func (f *follower) emit(ctx context.Context, page *api.MessagesPage) {
	for i := range page.Messages {
		if f.json {
			_ = f.a.emitJSON(page.Messages[i])
		} else {
			f.view.print(ctx, &page.Messages[i])
		}
	}
}

// catchUp prints everything after the cursor. It's what both a realtime
// nudge and a reconnect trigger, so a dropped socket never loses messages.
func (f *follower) catchUp(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for {
		page, err := f.c.ListMessages(ctx, f.view.chat.ID, api.MessageQuery{After: f.cursor, Limit: 50})
		if err != nil {
			return err
		}
		f.emit(ctx, page)
		if page.LatestCursor != nil {
			f.cursor = *page.LatestCursor
		}
		if !page.HasNewer || len(page.Messages) == 0 {
			return nil
		}
	}
}

// listen holds the realtime socket open, reconnecting with backoff.
func (f *follower) listen(ctx context.Context) error {
	backoff := time.Second
	for {
		err := f.listenOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		var gone chatGone
		if errors.As(err, &gone) {
			return err
		}
		if errors.Is(err, api.ErrSessionExpired) || errors.Is(err, api.ErrNotLoggedIn) {
			return err
		}
		fmt.Fprintln(f.a.errOut, styleDim(fmt.Sprintf("connection lost (%v) — reconnecting in %s", err, backoff)))
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return nil
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

type chatGone struct{}

func (chatGone) Error() string { return "this chat was deleted, or you are no longer in it" }

func (f *follower) listenOnce(ctx context.Context) error {
	conn, err := f.c.DialRealtime(ctx)
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	// Anything sent while we were connecting (or disconnected) shows up now.
	if err := f.catchUp(ctx); err != nil {
		return err
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var ev api.Event
		if json.Unmarshal(data, &ev) != nil || ev.ChatID != f.view.chat.ID {
			continue
		}
		switch ev.Type {
		case "chat_updated":
			if err := f.catchUp(ctx); err != nil {
				return err
			}
		case "chat_deleted":
			return chatGone{}
		}
	}
}

// sendLines sends each stdin line as a message; EOF ends the session.
func (f *follower) sendLines(ctx context.Context) error {
	sc := bufio.NewScanner(f.a.in)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if line == "/quit" || line == "/exit" {
			return nil
		}
		if _, err := f.c.SendMessage(ctx, f.view.chat.ID, api.Content{Type: api.ContentText, Text: line}, 0); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			fmt.Fprintln(f.a.errOut, styleErr("send failed: ")+err.Error())
		}
	}
	return sc.Err()
}
