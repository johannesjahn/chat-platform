package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/johannesjahn/chat-platform/cli/internal/api"
)

func userCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "user",
		Short: "Look up users",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "show @USER|ID",
		Short: "Show a user's profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			u, err := a.resolveUser(cmd.Context(), c, args[0])
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(u)
			}
			fmt.Fprintf(a.out, "%s  %s\n", styleBold(u.Name()), styleDim(fmt.Sprintf("id %d · %s", u.ID, u.Role)))
			if s := statusString(u); s != "" {
				fmt.Fprintln(a.out, "status: "+s)
			}
			return nil
		},
	}, &cobra.Command{
		Use:   "search QUERY",
		Short: "Find users by username or display name",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			users, err := c.SearchUsers(cmd.Context(), strings.Join(args, " "))
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(users)
			}
			if len(users) == 0 {
				fmt.Fprintln(a.out, "No users found.")
			}
			for _, u := range users {
				fmt.Fprintf(a.out, "%s %s\n", u.Name(), styleDim(fmt.Sprintf("· id %d", u.ID)))
			}
			return nil
		},
	})
	return cmd
}

func searchCmd(a *app) *cobra.Command {
	var limit int
	cmd := &cobra.Command{
		Use:     "search QUERY",
		Short:   "Search users, posts, comments, and your messages",
		Example: `  chatctl search deploy`,
		Args:    cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			res, err := c.SearchAll(cmd.Context(), strings.Join(args, " "), limit)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(res)
			}
			found := false
			section := func(title string, n int) bool {
				if n == 0 {
					return false
				}
				if found {
					fmt.Fprintln(a.out)
				}
				found = true
				fmt.Fprintln(a.out, styleBold(title))
				return true
			}
			if section("Users", len(res.Users.Results)) {
				for _, r := range res.Users.Results {
					fmt.Fprintf(a.out, "  %s %s\n", r.User.Name(), styleDim(fmt.Sprintf("· id %d", r.User.ID)))
				}
			}
			if section("Posts", len(res.Posts.Results)) {
				for _, r := range res.Posts.Results {
					fmt.Fprintf(a.out, "  %s %s: %s\n", styleDim(fmt.Sprintf("#%d", r.ID)), styleUser("@"+r.Author.Username), snippet(r.Snippet))
				}
			}
			if section("Comments", len(res.Comments.Results)) {
				for _, r := range res.Comments.Results {
					fmt.Fprintf(a.out, "  %s %s: %s\n", styleDim(fmt.Sprintf("#%d on post #%d", r.ID, r.PostID)), styleUser("@"+r.Author.Username), snippet(r.Snippet))
				}
			}
			if section("Messages", len(res.Messages.Results)) {
				for _, r := range res.Messages.Results {
					fmt.Fprintf(a.out, "  %s %s: %s\n", styleDim(fmt.Sprintf("chat %d #%d", r.ChatID, r.ID)), styleUser("@"+r.Sender.Username), snippet(r.Snippet))
				}
			}
			if !found {
				fmt.Fprintln(a.out, "No results.")
			}
			return nil
		},
	}
	cmd.Flags().IntVarP(&limit, "limit", "n", 5, "results per category")
	return cmd
}

func notificationText(n *api.Notification) string {
	actor := styleUser("@" + n.Actor.Username)
	ref := func(prefix string, id *int64) string {
		if id == nil {
			return ""
		}
		return fmt.Sprintf(" %s#%d", prefix, *id)
	}
	game := ""
	if n.Game != nil {
		game = *n.Game
	}
	var s string
	switch n.Type {
	case "comment":
		s = actor + " commented on your post" + ref("", n.PostID)
	case "reply":
		s = actor + " replied to your comment on post" + ref("", n.PostID)
	case "reaction":
		emoji := ""
		if n.Emoji != nil {
			emoji = " " + *n.Emoji
		}
		if n.CommentID != nil {
			s = actor + " reacted" + emoji + " to your comment on post" + ref("", n.PostID)
		} else {
			s = actor + " reacted" + emoji + " to your post" + ref("", n.PostID)
		}
	case "mention":
		if n.CommentID != nil {
			s = actor + " mentioned you in a comment on post" + ref("", n.PostID)
		} else {
			s = actor + " mentioned you in post" + ref("", n.PostID)
		}
	case "game_invite":
		s = actor + " invited you to a " + game + " lobby" + ref("", n.LobbyID)
	case "game_record":
		s = actor + " took your #1 spot on the " + game + " leaderboard"
	default:
		s = actor + " · " + n.Type
	}
	if n.Excerpt != nil && *n.Excerpt != "" {
		ex := strings.ReplaceAll(*n.Excerpt, "\n", " ")
		if r := []rune(ex); len(r) > 60 {
			ex = string(r[:60]) + "…"
		}
		s += styleDim(": “" + ex + "”")
	}
	return s
}

func notificationsCmd(a *app) *cobra.Command {
	var limit int
	var cursor string
	var unreadOnly, markRead bool
	cmd := &cobra.Command{
		Use:     "notifications",
		Aliases: []string{"notifs", "inbox"},
		Short:   "Show your notifications",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			page, err := c.ListNotifications(ctx, cursor, limit)
			if err != nil {
				return err
			}
			if unreadOnly {
				kept := page.Notifications[:0]
				for _, n := range page.Notifications {
					if !n.Read {
						kept = append(kept, n)
					}
				}
				page.Notifications = kept
			}
			if markRead {
				if err := c.MarkAllNotificationsRead(ctx); err != nil {
					return err
				}
			}
			if a.jsonOut {
				return a.emitJSON(page)
			}
			if len(page.Notifications) == 0 {
				fmt.Fprintln(a.out, "No notifications.")
			}
			for i := range page.Notifications {
				n := &page.Notifications[i]
				dot := "  "
				if !n.Read {
					dot = styleUnread("● ")
				}
				fmt.Fprintf(a.out, "%s%s %s\n", dot, notificationText(n), styleDim("· "+ago(n.CreatedAt.Time())))
			}
			if page.UnreadCount > 0 && !markRead {
				fmt.Fprintln(a.errOut, styleDim(fmt.Sprintf("%d unread — mark them read with --read", page.UnreadCount)))
			}
			nextPageHint(a, page.NextCursor, "--cursor")
			return nil
		},
	}
	cmd.Flags().IntVarP(&limit, "limit", "n", 20, "number of notifications")
	cmd.Flags().StringVar(&cursor, "cursor", "", "page cursor from a previous call")
	cmd.Flags().BoolVar(&unreadOnly, "unread", false, "only unread notifications")
	cmd.Flags().BoolVar(&markRead, "read", false, "mark all notifications read after listing")
	return cmd
}

func apiCmd(a *app) *cobra.Command {
	var data string
	cmd := &cobra.Command{
		Use:   "api METHOD PATH",
		Short: "Make an authenticated request to any endpoint and print the JSON",
		Long: `Make an authenticated request to any API endpoint — an escape hatch for
everything without a dedicated command. See the server's openapi.json for the
full list. The body (-d) is sent as JSON; "-d -" reads it from stdin.`,
		Example: `  chatctl api GET /games/typing/leaderboard
  chatctl api GET '/posts?limit=2'
  chatctl api PUT /users/me -d '{"displayName":"Alice"}'`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			method := strings.ToUpper(args[0])
			path, rawQuery, _ := strings.Cut(args[1], "?")
			if !strings.HasPrefix(path, "/") {
				path = "/" + path
			}
			query, err := url.ParseQuery(rawQuery)
			if err != nil {
				return fmt.Errorf("invalid query string: %w", err)
			}
			var body []byte
			if data == "-" {
				if body, err = io.ReadAll(a.in); err != nil {
					return err
				}
			} else if data != "" {
				body = []byte(data)
			}
			if body != nil && !json.Valid(body) {
				return fmt.Errorf("-d is not valid JSON")
			}
			raw, err := c.Raw(cmd.Context(), method, path, query, body)
			if err != nil {
				return err
			}
			if len(raw) == 0 {
				return nil
			}
			var buf bytes.Buffer
			if json.Indent(&buf, raw, "", "  ") != nil {
				_, err = a.out.Write(raw)
				return err
			}
			buf.WriteByte('\n')
			_, err = buf.WriteTo(a.out)
			return err
		},
	}
	cmd.Flags().StringVarP(&data, "data", "d", "", "JSON request body (\"-\" for stdin)")
	return cmd
}
