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

Log in once with ` + "`chatctl login`" + `; the session is stored in ~/.chatctl.json
(override with --config or $CHATCTL_CONFIG) and refreshed automatically.`,
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
	root.PersistentFlags().StringVar(&a.configPath, "config", "", "path to the config dotfile (default ~/.chatctl.json, or $CHATCTL_CONFIG)")
	root.PersistentFlags().StringVarP(&a.profile, "profile", "p", "", "profile to use (default: the current profile, or $CHATCTL_PROFILE)")
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
	add("auth", loginCmd(a), logoutCmd(a), whoamiCmd(a), profilesCmd(a), statusCmd(a))
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
	name := f.ResolveName(a.profile)
	p := f.Profiles[name]
	if p == nil || !p.LoggedIn() {
		if name == config.DefaultProfile {
			return nil, api.ErrNotLoggedIn
		}
		return nil, fmt.Errorf("profile %q is not logged in — run `chatctl login --profile %s`", name, name)
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
