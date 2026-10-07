package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/johannesjahn/chat-platform/cli/internal/api"
	"github.com/johannesjahn/chat-platform/cli/internal/config"
)

func loginCmd(a *app) *cobra.Command {
	var server, username string
	var passwordStdin bool
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Log in to an account (adds a profile and switches to it)",
		Long: `Log in to a chat-platform account. Each account gets its own profile in the
dotfile, named after the username unless you pass --profile, so logging in as
a second account adds it next to the first instead of replacing it. The new
profile becomes the current one (` + "`chatctl use -`" + ` switches back).

The session (a short-lived access token plus a refresh token) is stored with
0600 permissions and refreshed automatically from then on. Logging in to an
existing profile again replaces its session.

The server defaults to the profile's own server, then the current profile's
server (so a second account on the same server needs no --server), then
$CHATCTL_SERVER, then ` + config.DefaultServer + `.`,
		Example: `  chatctl login --server https://chat.example.com -u alice
  chatctl login -u bob                      # second account, same server
  echo "$PASSWORD" | chatctl login -u ci-bot --password-stdin
  chatctl login --profile alice-local -s http://localhost:3000 -u alice`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			f, err := a.store.Load()
			if err != nil {
				return err
			}

			stdin := bufio.NewReader(a.in)
			if username == "" {
				// Re-logging into a named profile can reuse its username.
				if p := f.Profiles[a.profile]; p != nil && p.User != nil {
					username = p.User.Username
				} else if !isTerminal(a.in) {
					return errors.New("--username is required when stdin is not a terminal")
				} else {
					fmt.Fprint(a.errOut, "Username: ")
					line, err := stdin.ReadString('\n')
					if err != nil {
						return err
					}
					username = strings.TrimSpace(line)
				}
			}
			username = strings.TrimPrefix(username, "@")
			if username == "" {
				return errors.New("username is required")
			}

			name := a.profile
			if name == "" {
				name = username
			}
			existing := f.Profiles[name]
			if server == "" {
				switch cur := f.Profiles[f.CurrentProfile]; {
				case existing != nil && existing.Server != "":
					server = existing.Server
				case cur != nil && cur.Server != "":
					server = cur.Server
				case os.Getenv("CHATCTL_SERVER") != "":
					server = os.Getenv("CHATCTL_SERVER")
				default:
					server = config.DefaultServer
				}
			}
			server = strings.TrimRight(server, "/")
			if !strings.HasPrefix(server, "http://") && !strings.HasPrefix(server, "https://") {
				return fmt.Errorf("server must start with http:// or https:// (got %q)", server)
			}
			// Don't silently repoint an auto-named profile at another server:
			// "alice" on two servers needs two profile names.
			if a.profile == "" && existing != nil && existing.Server != server {
				return fmt.Errorf("profile %q already belongs to %s — choose a name for this one with --profile, e.g. --profile %s-2",
					name, existing.Server, name)
			}

			var password string
			switch {
			case passwordStdin:
				line, err := stdin.ReadString('\n')
				if err != nil && line == "" {
					return fmt.Errorf("reading password from stdin: %w", err)
				}
				password = strings.TrimRight(line, "\r\n")
			case isTerminal(a.in):
				fmt.Fprintf(a.errOut, "Password for @%s: ", username)
				b, err := term.ReadPassword(int(a.in.(*os.File).Fd()))
				fmt.Fprintln(a.errOut)
				if err != nil {
					return err
				}
				password = string(b)
			default:
				return errors.New("use --password-stdin to pass a password when stdin is not a terminal")
			}

			// Start from a fresh profile on the chosen server: a login replaces
			// whatever session the profile held.
			profile := &config.Profile{Server: server}
			c := api.New(a.store, name, profile)
			c.UserAgent = "chatctl/" + Version
			res, err := c.Login(ctx, username, password)
			if err != nil {
				if api.IsStatus(err, 401) {
					return errors.New("invalid username or password")
				}
				return err
			}
			var previous string
			if err := a.store.Update(func(f *config.File) error {
				f.Switch(name)
				previous = f.PreviousProfile
				return nil
			}); err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(res.User)
			}
			fmt.Fprintf(a.out, "Logged in to %s as %s — now using profile %q.\n", server, styleBold(res.User.Name()), name)
			if previous != "" && previous != name {
				fmt.Fprintln(a.errOut, styleDim(fmt.Sprintf("`chatctl use -` switches back to %q.", previous)))
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&server, "server", "s", "", "server base URL, e.g. https://chat.example.com")
	cmd.Flags().StringVarP(&username, "username", "u", "", "username (prompted if omitted)")
	cmd.Flags().BoolVar(&passwordStdin, "password-stdin", false, "read the password from stdin")
	return cmd
}

func logoutCmd(a *app) *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "logout",
		Short: "Revoke the session and remove it from the dotfile",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			if err := c.Logout(cmd.Context(), all); err != nil {
				fmt.Fprintln(a.errOut, styleDim("Server-side logout failed ("+err.Error()+"); local session removed anyway."))
				return nil
			}
			if all {
				fmt.Fprintln(a.out, "Logged out of all sessions.")
			} else {
				fmt.Fprintln(a.out, "Logged out.")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "also revoke every other session of this account (all devices)")
	return cmd
}

func whoamiCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the logged-in user",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			if c.Profile.User == nil {
				return errors.New("profile has no user recorded — run `chatctl login` again")
			}
			// A live fetch both shows current profile data and proves the
			// session still works.
			u, err := c.GetUser(cmd.Context(), c.Profile.User.ID)
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
			fmt.Fprintln(a.out, styleDim(fmt.Sprintf("server %s · profile %q", c.Profile.Server, c.ProfileName)))
			return nil
		},
	}
}

func statusString(u *api.User) string {
	var parts []string
	if u.StatusEmoji != nil {
		parts = append(parts, *u.StatusEmoji)
	}
	if u.StatusText != nil {
		parts = append(parts, *u.StatusText)
	}
	return strings.Join(parts, " ")
}

// useProfile switches the current profile; ref "-" means the previous one.
func (a *app) useProfile(ref string) error {
	var name string
	var p *config.Profile
	err := a.store.Update(func(f *config.File) error {
		if ref == "-" {
			if f.PreviousProfile == "" {
				return errors.New("no previous profile to switch back to")
			}
			ref = f.PreviousProfile
		}
		var err error
		if name, p, err = f.Find(ref); err != nil {
			return err
		}
		f.Switch(name)
		return nil
	})
	if err != nil {
		return err
	}
	who := name
	if p.User != nil {
		who = "@" + p.User.Username
	}
	fmt.Fprintf(a.out, "Now using %s %s\n", styleBold(who), styleDim(fmt.Sprintf("(profile %q · %s)", name, p.Server)))
	if !p.LoggedIn() {
		fmt.Fprintln(a.errOut, styleDim(fmt.Sprintf("This profile is logged out — `chatctl login --profile %s`.", name)))
	}
	return nil
}

func (a *app) listProfiles() error {
	f, err := a.store.Load()
	if err != nil {
		return err
	}
	if len(f.Profiles) == 0 {
		fmt.Fprintln(a.out, "No profiles yet — run `chatctl login`.")
		return nil
	}
	current := ""
	if ref := f.Selected(a.profile); ref != "" {
		current, _, _ = f.Find(ref)
	}
	if a.jsonOut {
		type row struct {
			Name     string `json:"name"`
			Server   string `json:"server"`
			Username string `json:"username,omitempty"`
			LoggedIn bool   `json:"loggedIn"`
			Current  bool   `json:"current"`
		}
		rows := []row{}
		for _, name := range f.Names() {
			p := f.Profiles[name]
			r := row{Name: name, Server: p.Server, LoggedIn: p.LoggedIn(), Current: name == current}
			if p.User != nil {
				r.Username = p.User.Username
			}
			rows = append(rows, r)
		}
		return a.emitJSON(rows)
	}
	for _, name := range f.Names() {
		p := f.Profiles[name]
		marker := "  "
		if name == current {
			marker = styleBold("* ")
		}
		who := styleDim("(logged out)")
		if p.LoggedIn() && p.User != nil {
			who = "@" + p.User.Username
		}
		fmt.Fprintf(a.out, "%s%-14s %-16s %s\n", marker, name, who, styleDim(p.Server))
	}
	fmt.Fprintln(a.errOut, styleDim("switch: chatctl use NAME · back: chatctl use - · one-off: --as NAME"))
	return nil
}

// profileCompletion offers profile names for `use`, --profile and --as.
func (a *app) profileCompletion(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
	path := a.configPath
	if path == "" {
		path, _ = config.DefaultPath()
	}
	f, err := (&config.Store{Path: path}).Load()
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	var out []string
	for _, name := range f.Names() {
		desc := f.Profiles[name].Server
		if u := f.Profiles[name].User; u != nil {
			desc = "@" + u.Username + " on " + desc
		}
		out = append(out, name+"\t"+desc)
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}

func useCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:     "use [PROFILE | @USER | -]",
		Aliases: []string{"switch"},
		Short:   "Switch account: make a profile current (- = previous; no args lists)",
		Example: `  chatctl use bob       # switch to the bob profile
  chatctl use @bob      # same, matched by username
  chatctl use -         # back to the previous account
  chatctl use           # list profiles`,
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: a.profileCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				return a.listProfiles()
			}
			return a.useProfile(args[0])
		},
	}
}

func profilesCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profiles",
		Short: "List profiles (accounts) in the dotfile",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := a.listProfiles(); err != nil {
				return err
			}
			fmt.Fprintln(a.errOut, styleDim("config: "+a.store.Path))
			return nil
		},
	}
	use := useCmd(a)
	use.Aliases = nil
	use.Use = "use PROFILE | @USER | -"
	use.Args = cobra.ExactArgs(1)
	cmd.AddCommand(use)
	cmd.AddCommand(&cobra.Command{
		Use:               "remove PROFILE",
		Aliases:           []string{"rm"},
		Short:             "Delete a profile from the dotfile (does not revoke its session; use logout for that)",
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: a.profileCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			err := a.store.Update(func(f *config.File) error {
				var err error
				if name, _, err = f.Find(args[0]); err != nil {
					return err
				}
				f.Remove(name)
				return nil
			})
			if err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Removed profile %q.\n", name)
			return nil
		},
	})
	return cmd
}

func statusCmd(a *app) *cobra.Command {
	var emoji string
	var expires time.Duration
	cmd := &cobra.Command{
		Use:   "status [TEXT]",
		Short: "Set your status (no args clears it)",
		Example: `  chatctl status "Heads down until 3pm" --emoji 🎧 --expires 2h
  chatctl status          # clear`,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			text := strings.Join(args, " ")
			minutes := 0
			if expires > 0 {
				minutes = int(expires.Round(time.Minute) / time.Minute)
				if minutes < 1 {
					minutes = 1
				}
			}
			u, err := c.SetStatus(cmd.Context(), text, emoji, minutes)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(u)
			}
			if s := statusString(u); s != "" {
				fmt.Fprintln(a.out, "Status set: "+s)
			} else {
				fmt.Fprintln(a.out, "Status cleared.")
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&emoji, "emoji", "e", "", "status emoji")
	cmd.Flags().DurationVar(&expires, "expires", 0, "clear the status automatically after this long (e.g. 30m, 4h; max 30 days)")
	return cmd
}
