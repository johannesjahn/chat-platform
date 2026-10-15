// Package cmd defines chatctl's command tree.
package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/johannesjahn/chat-platform/cli/internal/api"
	"github.com/johannesjahn/chat-platform/cli/internal/config"
)

// Version is set at build time via -ldflags "-X .../cmd.Version=...".
var Version = "dev"

// app is the state shared by every command: global flags, I/O, and a
// lazily built API client.
type app struct {
	configPath string
	profile    string
	jsonOut    bool

	in     io.Reader
	out    io.Writer
	errOut io.Writer

	store  *config.Store
	client *api.Client
	users  map[int64]*api.User
}

// Execute runs chatctl and returns the process exit code.
func Execute() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a := &app{in: os.Stdin, out: os.Stdout, errOut: os.Stderr}
	root := newRoot(a)
	if err := root.ExecuteContext(ctx); err != nil {
		if errors.Is(err, context.Canceled) {
			return 130
		}
		fmt.Fprintln(a.errOut, styleErr("error: ")+err.Error())
		return 1
	}
	return 0
}

func newRoot(a *app) *cobra.Command {
	root := &cobra.Command{
		Use:   "chatctl",
		Short: "Command-line client for chat-platform",
		Long: `chatctl talks to a chat-platform server from your terminal: read the feed,
create posts, comment and react, send and follow chat messages, search, and
check notifications.

Log in once per account with ` + "`chatctl login -u NAME`" + `; each account gets its own
profile in ~/.chatctl.yml (override with --config or $CHATCTL_CONFIG), and
sessions are refreshed automatically. Hop between accounts with
` + "`chatctl use NAME`" + ` (` + "`chatctl use -`" + ` goes back), or run a single command as
another account with --as NAME.`,
		Version:       Version,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			path := a.configPath
			if path == "" {
				var err error
				if path, err = config.DefaultPath(); err != nil {
					return err
				}
			}
			a.store = &config.Store{Path: path}
			return nil
		},
	}
	root.PersistentFlags().StringVar(&a.configPath, "config", "", "path to the config dotfile (default ~/.chatctl.yml, or $CHATCTL_CONFIG)")
	root.PersistentFlags().StringVarP(&a.profile, "profile", "p", "", "profile (account) to use for this command: a profile name or @username (default: the current profile, or $CHATCTL_PROFILE)")
	// --as reads naturally for hopping accounts: `chatctl --as bob dm alice hi`.
	root.PersistentFlags().StringVar(&a.profile, "as", "", "alias for --profile")
	root.PersistentFlags().BoolVar(&a.jsonOut, "json", false, "print raw JSON responses instead of formatted output")

	root.AddGroup(
		&cobra.Group{ID: "auth", Title: "Account:"},
		&cobra.Group{ID: "social", Title: "Feed & posts:"},
		&cobra.Group{ID: "chat", Title: "Chats:"},
		&cobra.Group{ID: "other", Title: "Other:"},
	)
	add := func(group string, cmds ...*cobra.Command) {
		for _, c := range cmds {
			c.GroupID = group
			root.AddCommand(c)
		}
	}
	add("auth", loginCmd(a), useCmd(a), profilesCmd(a), logoutCmd(a), whoamiCmd(a), statusCmd(a))
	for _, flag := range []string{"profile", "as"} {
		_ = root.RegisterFlagCompletionFunc(flag, a.profileCompletion)
	}
	add("social", feedCmd(a), postCmd(a), commentCmd(a))
	add("chat", chatsCmd(a), chatCmd(a), dmCmd(a))
	add("other", userCmd(a), searchCmd(a), notificationsCmd(a), apiCmd(a))
	return root
}

// Client returns the API client for the active profile.
func (a *app) Client() (*api.Client, error) {
	if a.client != nil {
		return a.client, nil
	}
	f, err := a.store.Load()
	if err != nil {
		return nil, err
	}
	ref := f.Selected(a.profile)
	if ref == "" {
		return nil, api.ErrNotLoggedIn
	}
	name, p, err := f.Find(ref)
	if err != nil {
		return nil, err
	}
	if !p.LoggedIn() {
		return nil, fmt.Errorf("profile %q is logged out — run `chatctl login --profile %s`", name, name)
	}
	a.client = api.New(a.store, name, p)
	a.client.UserAgent = "chatctl/" + Version
	return a.client, nil
}

// me is the logged-in user's id, or 0 if unknown.
func (a *app) me() int64 {
	if a.client != nil && a.client.Profile.User != nil {
		return a.client.Profile.User.ID
	}
	return 0
}

// emitJSON prints v as indented JSON; used for --json output.
func (a *app) emitJSON(v any) error {
	enc := json.NewEncoder(a.out)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}
