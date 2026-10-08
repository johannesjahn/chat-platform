package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/johannesjahn/chat-platform/cli/internal/api"
)

// --- color ---

// colorOn is decided once: color only on a terminal, and never with NO_COLOR.
var colorOn = os.Getenv("NO_COLOR") == "" && term.IsTerminal(int(os.Stdout.Fd()))

func ansi(code, s string) string {
	if !colorOn {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func styleDim(s string) string    { return ansi("2", s) }
func styleBold(s string) string   { return ansi("1", s) }
func styleUser(s string) string   { return ansi("1;36", s) }
func styleMe(s string) string     { return ansi("1;32", s) }
func styleMatch(s string) string  { return ansi("1;33", s) }
func styleErr(s string) string    { return ansi("1;31", s) }
func styleUnread(s string) string { return ansi("1;35", s) }

// --- time ---

func ago(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	default:
		return t.Format("2 Jan 2006")
	}
}

// --- input ---

func parseID(s, what string) (int64, error) {
	n, err := strconv.ParseInt(strings.TrimPrefix(s, "#"), 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid %s id %q", what, s)
	}
	return n, nil
}

// readText gets the body of a post/comment/message: the positional args
// joined with spaces; "-" or piped stdin reads stdin; with nothing given on
// a terminal it opens $EDITOR, like `git commit`.
func (a *app) readText(args []string, allowEmpty bool) (string, error) {
	var text string
	switch {
	case len(args) == 1 && args[0] == "-":
		b, err := io.ReadAll(a.in)
		if err != nil {
			return "", err
		}
		text = string(b)
	case len(args) > 0:
		text = strings.Join(args, " ")
	case !isTerminal(a.in):
		b, err := io.ReadAll(a.in)
		if err != nil {
			return "", err
		}
		text = string(b)
	case allowEmpty:
		return "", nil
	default:
		var err error
		if text, err = editText(""); err != nil {
			return "", err
		}
	}
	text = strings.TrimSpace(text)
	if text == "" && !allowEmpty {
		return "", errors.New("nothing to send (empty text)")
	}
	return text, nil
}

func isTerminal(r io.Reader) bool {
	f, ok := r.(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}

// editText opens $VISUAL/$EDITOR on a temp file seeded with initial.
func editText(initial string) (string, error) {
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = "vi"
	}
	f, err := os.CreateTemp("", "chatctl-*.md")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(initial); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	// Run through the shell so EDITOR="code --wait" style values work.
	c := exec.Command("sh", "-c", editor+` "$1"`, "sh", f.Name())
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		return "", fmt.Errorf("editor exited with error: %w", err)
	}
	b, err := os.ReadFile(f.Name())
	return string(b), err
}

// reactionAliases lets reactions be typed without an emoji keyboard.
var reactionAliases = map[string]string{
	"like": "👍", "+1": "👍", "thumbsup": "👍",
	"love": "❤️", "heart": "❤️",
	"haha": "😂", "laugh": "😂", "lol": "😂",
	"wow": "😮", "surprised": "😮",
	"sad": "😢", "cry": "😢",
	"angry": "😡", "mad": "😡",
}

func parseReaction(s string) (string, error) {
	if e, ok := reactionAliases[strings.ToLower(s)]; ok {
		return e, nil
	}
	for _, e := range api.ReactionEmojis {
		// Accept ❤ without the variation selector too.
		if s == e || s+"️" == e {
			return e, nil
		}
	}
	return "", fmt.Errorf("unsupported reaction %q — use one of %s or like/love/haha/wow/sad/angry",
		s, strings.Join(api.ReactionEmojis, " "))
}

// content builds a post/message body from text plus the --image/--attach
// flags shared by `post create` and `chat send`.
func (a *app) content(ctx context.Context, c *api.Client, text, imageURL, attach string) (api.Content, error) {
	switch {
	case imageURL != "" && attach != "":
		return api.Content{}, errors.New("--image and --attach are mutually exclusive")
	case imageURL != "":
		return api.Content{Type: api.ContentImageURL, Text: imageURL}, nil
	case attach != "":
		att, err := c.Upload(ctx, attach)
		if err != nil {
			return api.Content{}, fmt.Errorf("uploading %s: %w", attach, err)
		}
		if text == "" {
			text = att.Filename
		}
		return api.Content{Type: api.ContentAttachment, Text: text, AttachmentID: att.ID}, nil
	case text == "":
		return api.Content{}, errors.New("nothing to send (empty text)")
	default:
		return api.Content{Type: api.ContentText, Text: text}, nil
	}
}

// --- users ---

// user resolves an id to a user, cached for the life of the command so a
// feed page with many posts by the same author costs one lookup.
func (a *app) user(ctx context.Context, id int64) *api.User {
	if a.users == nil {
		a.users = map[int64]*api.User{}
	}
	if u, ok := a.users[id]; ok {
		return u
	}
	u, err := a.client.GetUser(ctx, id)
	if err != nil {
		u = &api.User{ID: id, Username: "user" + strconv.FormatInt(id, 10)}
	}
	a.users[id] = u
	return u
}

func (a *app) username(ctx context.Context, id int64) string {
	name := "@" + a.user(ctx, id).Username
	if id == a.me() {
		return styleMe(name)
	}
	return styleUser(name)
}

// resolveUser accepts "@name", "name" or a numeric id.
func (a *app) resolveUser(ctx context.Context, c *api.Client, s string) (*api.User, error) {
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return c.GetUser(ctx, n)
	}
	return c.LookupUsername(ctx, s)
}

// --- rendering ---

func indent(s, prefix string) string {
	return prefix + strings.ReplaceAll(s, "\n", "\n"+prefix)
}

func reactionsLine(rs []api.ReactionSummary) string {
	parts := make([]string, 0, len(rs))
	for _, r := range rs {
		p := fmt.Sprintf("%s %d", r.Emoji, r.Count)
		if r.ReactedByMe {
			p = styleBold(p)
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, "  ")
}

func contentText(contentType, content string, att *api.Attachment) string {
	switch contentType {
	case api.ContentImageURL:
		return "🖼  " + content
	case api.ContentAttachment:
		if att != nil {
			return fmt.Sprintf("📎 %s (%s, %s) %s", att.Filename, att.MimeType, humanSize(att.Size), styleDim(att.URL))
		}
		return "📎 attachment"
	default:
		return content
	}
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

func (a *app) printPost(ctx context.Context, p *api.Post) {
	edited := ""
	if p.UpdatedAt > p.CreatedAt {
		edited = styleDim(" (edited)")
	}
	fmt.Fprintf(a.out, "%s  %s %s%s\n", styleDim(fmt.Sprintf("#%d", p.ID)), a.username(ctx, p.AuthorID),
		styleDim("· "+ago(p.CreatedAt.Time())), edited)
	fmt.Fprintln(a.out, indent(contentText(p.ContentType, p.Content, p.Attachment), "  "))
	footer := reactionsLine(p.Reactions)
	if p.CommentCount > 0 {
		comments := fmt.Sprintf("%d comment", p.CommentCount)
		if p.CommentCount != 1 {
			comments += "s"
		}
		if footer != "" {
			footer += "  ·  "
		}
		footer += styleDim(comments)
	}
	if footer != "" {
		fmt.Fprintln(a.out, "  "+footer)
	}
}

func (a *app) printComment(ctx context.Context, cm *api.Comment, prefix string) {
	fmt.Fprintf(a.out, "%s%s  %s %s\n", prefix, styleDim(fmt.Sprintf("#%d", cm.ID)), a.username(ctx, cm.AuthorID),
		styleDim("· "+ago(cm.CreatedAt.Time())))
	fmt.Fprintln(a.out, indent(cm.Content, prefix+"  "))
	footer := reactionsLine(cm.Reactions)
	if cm.ReplyCount > 0 {
		if footer != "" {
			footer += "  ·  "
		}
		footer += styleDim(fmt.Sprintf("%d repl%s", cm.ReplyCount, map[bool]string{true: "y", false: "ies"}[cm.ReplyCount == 1]))
	}
	if footer != "" {
		fmt.Fprintln(a.out, prefix+"  "+footer)
	}
}

func snippet(segs []api.SnippetSegment) string {
	var b strings.Builder
	for _, s := range segs {
		if s.Match {
			b.WriteString(styleMatch(s.Text))
		} else {
			b.WriteString(s.Text)
		}
	}
	return strings.ReplaceAll(b.String(), "\n", " ")
}

func nextPageHint(a *app, cursor *string, flag string) {
	if cursor != nil && *cursor != "" {
		fmt.Fprintln(a.errOut, styleDim(fmt.Sprintf("more: %s %s", flag, *cursor)))
	}
}
