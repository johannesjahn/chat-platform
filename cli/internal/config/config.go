// Package config reads and writes the chatctl dotfile (~/.chatctl.yml by
// default), which holds one named profile per account — a server URL plus
// the session tokens issued by `POST /users/login` — and which one is
// current.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// DefaultServer is the backend's local dev address (`PORT` defaults to 3000).
const DefaultServer = "http://localhost:3000"

// header is written at the top of the dotfile.
const header = `# chatctl config — managed by ` + "`chatctl login` / `chatctl use`" + `.
# Holds live session tokens: keep it private (it is written 0600).
`

// User is the slice of the logged-in user worth caching locally, so
// `whoami` and "is this message mine?" don't need a round trip.
type User struct {
	ID       int64  `yaml:"id"`
	Username string `yaml:"username"`
}

// Profile is one account on one server.
type Profile struct {
	Server       string `yaml:"server"`
	User         *User  `yaml:"user,omitempty"`
	AccessToken  string `yaml:"accessToken,omitempty"`
	RefreshToken string `yaml:"refreshToken,omitempty"`
}

// LoggedIn reports whether the profile holds a session.
func (p *Profile) LoggedIn() bool { return p.RefreshToken != "" || p.AccessToken != "" }

// File is the on-disk dotfile.
type File struct {
	CurrentProfile string `yaml:"currentProfile,omitempty"`
	// PreviousProfile is what `chatctl use -` switches back to.
	PreviousProfile string              `yaml:"previousProfile,omitempty"`
	Profiles        map[string]*Profile `yaml:"profiles"`
}

// Store is a dotfile at a fixed path.
type Store struct {
	Path string
}

// DefaultPath resolves the dotfile location: $CHATCTL_CONFIG, else
// ~/.chatctl.yml.
func DefaultPath() (string, error) {
	if p := os.Getenv("CHATCTL_CONFIG"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locating home directory: %w", err)
	}
	return filepath.Join(home, ".chatctl.yml"), nil
}

// Load reads the dotfile. A missing file is not an error — it yields an
// empty config, so the first `chatctl login` can create it.
func (s *Store) Load() (*File, error) {
	f := &File{Profiles: map[string]*Profile{}}
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", s.Path, err)
	}
	if err := yaml.Unmarshal(data, f); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", s.Path, err)
	}
	if f.Profiles == nil {
		f.Profiles = map[string]*Profile{}
	}
	for name, p := range f.Profiles {
		if p == nil {
			delete(f.Profiles, name)
		}
	}
	return f, nil
}

// Save writes the dotfile atomically (temp file + rename) with 0600
// permissions — it holds bearer tokens, so it must not be world-readable,
// and a crash mid-write must not leave a truncated file behind.
func (s *Store) Save(f *File) error {
	body, err := yaml.Marshal(f)
	if err != nil {
		return err
	}
	data := append([]byte(header), body...)
	dir := filepath.Dir(s.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".chatctl-*.tmp")
	if err != nil {
		return fmt.Errorf("writing config: %w", err)
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("writing config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("writing config: %w", err)
	}
	if err := os.Rename(tmp.Name(), s.Path); err != nil {
		return fmt.Errorf("writing config: %w", err)
	}
	return nil
}

// Update loads the dotfile, applies fn, and saves it. Re-reading right
// before writing keeps a concurrent chatctl process's changes to *other*
// profiles from being clobbered.
func (s *Store) Update(fn func(*File) error) error {
	f, err := s.Load()
	if err != nil {
		return err
	}
	if err := fn(f); err != nil {
		return err
	}
	return s.Save(f)
}

// Selected names the profile a command runs as: an explicit choice (the
// --profile/--as flag, then $CHATCTL_PROFILE), else the current profile.
// Empty means nothing is selected yet.
func (f *File) Selected(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if env := os.Getenv("CHATCTL_PROFILE"); env != "" {
		return env
	}
	return f.CurrentProfile
}

// Find resolves a profile reference: an exact profile name, or "@user" /
// "user" matching the account's username (if exactly one profile has it).
// It returns the canonical profile name.
func (f *File) Find(ref string) (string, *Profile, error) {
	if p, ok := f.Profiles[ref]; ok {
		return ref, p, nil
	}
	username := strings.TrimPrefix(ref, "@")
	if p, ok := f.Profiles[username]; ok {
		return username, p, nil
	}
	var matches []string
	for name, p := range f.Profiles {
		if p.User != nil && strings.EqualFold(p.User.Username, username) {
			matches = append(matches, name)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], f.Profiles[matches[0]], nil
	case 0:
		return "", nil, fmt.Errorf("no profile %q — add one with `chatctl login -u %s`", ref, username)
	default:
		sort.Strings(matches)
		return "", nil, fmt.Errorf("@%s is logged in on several servers (%s) — pick one by profile name",
			username, strings.Join(matches, ", "))
	}
}

// Switch makes name current, remembering the old current profile for
// `chatctl use -`. Switching to the profile that's already current is a
// no-op, so `use -` keeps toggling between the last two.
func (f *File) Switch(name string) {
	if f.CurrentProfile == name {
		return
	}
	f.PreviousProfile, f.CurrentProfile = f.CurrentProfile, name
}

// Remove deletes a profile, clearing any reference to it.
func (f *File) Remove(name string) {
	delete(f.Profiles, name)
	if f.CurrentProfile == name {
		f.CurrentProfile = ""
	}
	if f.PreviousProfile == name {
		f.PreviousProfile = ""
	}
}

// Names returns the profile names, sorted.
func (f *File) Names() []string {
	names := make([]string, 0, len(f.Profiles))
	for n := range f.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
