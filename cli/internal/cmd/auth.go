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
		Short: "Log in and store the session in the dotfile",
		Long: `Log in to a chat-platform server. The session (a short-lived access token plus
a refresh token) is saved to the active profile in the dotfile with 0600
permissions, and is refreshed automatically from then on.

The server defaults to the profile's existing server, then $CHATCTL_SERVER,
then ` + config.DefaultServer + `.`,
		Example: `  chatctl login --server https://chat.example.com --username alice
  echo "$PASSWORD" | chatctl login -u alice --password-stdin
  chatctl login --profile local --server http://localhost:3000`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			f, err := a.store.Load()
			if err != nil {
				return err
			}
			name := f.ResolveName(a.profile)
			if server == "" {
				if p := f.Profiles[name]; p != nil && p.Server != "" {
					server = p.Server
				} else if env := os.Getenv("CHATCTL_SERVER"); env != "" {
					server = env
				} else {
					server = config.DefaultServer
				}
			}
			server = strings.TrimRight(server, "/")
			if !strings.HasPrefix(server, "http://") && !strings.HasPrefix(server, "https://") {
				return fmt.Errorf("server must start with http:// or https:// (got %q)", server)
			}

			stdin := bufio.NewReader(a.in)
			if username == "" {
				if !isTerminal(a.in) {
					return errors.New("--username is required when stdin is not a terminal")
				}
				fmt.Fprint(a.errOut, "Username: ")
				line, err := stdin.ReadString('\n')
				if err != nil {
					return err
				}
				username = strings.TrimSpace(line)
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
				fmt.Fprint(a.errOut, "Password: ")
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
			becameCurrent := false
			if err := a.store.Update(func(f *config.File) error {
				if f.CurrentProfile == "" {
					f.CurrentProfile, becameCurrent = name, true
				}
				return nil
			}); err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(res.User)
			}
			fmt.Fprintf(a.out, "Logged in to %s as %s (profile %q).\n", server, styleBold(res.User.Name()), name)
			if f.CurrentProfile != "" && f.CurrentProfile != name && !becameCurrent {
				fmt.Fprintln(a.errOut, styleDim(fmt.Sprintf("Current profile is still %q — switch with `chatctl profiles use %s`.", f.CurrentProfile, name)))
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

func profilesCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profiles",
		Short: "List profiles in the dotfile",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			f, err := a.store.Load()
			if err != nil {
				return err
			}
			current := f.ResolveName(a.profile)
			if len(f.Profiles) == 0 {
				fmt.Fprintln(a.out, "No profiles yet — run `chatctl login`.")
				return nil
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
				fmt.Fprintf(a.out, "%s%-12s %-36s %s\n", marker, name, p.Server, who)
			}
			fmt.Fprintln(a.errOut, styleDim("config: "+a.store.Path))
			return nil
		},
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "use NAME",
		Short: "Switch the current profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			err := a.store.Update(func(f *config.File) error {
				if _, ok := f.Profiles[name]; !ok {
					return fmt.Errorf("no profile %q (log in with `chatctl login --profile %s`)", name, name)
				}
				f.CurrentProfile = name
				return nil
			})
			if err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Switched to profile %q.\n", name)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "remove NAME",
		Short: "Delete a profile from the dotfile (does not revoke its session; use logout for that)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			err := a.store.Update(func(f *config.File) error {
				if _, ok := f.Profiles[name]; !ok {
					return fmt.Errorf("no profile %q", name)
				}
				delete(f.Profiles, name)
				if f.CurrentProfile == name {
					f.CurrentProfile = ""
				}
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
