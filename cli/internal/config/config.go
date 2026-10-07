// Package config reads and writes the chatctl dotfile (~/.chatctl.json by
// default), which holds one or more named profiles — a server URL plus the
// session tokens issued by `POST /users/login`.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// DefaultProfile is the profile used when none is selected.
const DefaultProfile = "default"

// DefaultServer is the backend's local dev address (`PORT` defaults to 3000).
const DefaultServer = "http://localhost:3000"

// User is the slice of the logged-in user worth caching locally, so
// `whoami` and "is this message mine?" don't need a round trip.
type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

// Profile is one server + session.
type Profile struct {
	Server       string `json:"server"`
	AccessToken  string `json:"accessToken,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	User         *User  `json:"user,omitempty"`
}

// LoggedIn reports whether the profile holds a session.
func (p *Profile) LoggedIn() bool { return p.RefreshToken != "" || p.AccessToken != "" }

// File is the on-disk dotfile.
type File struct {
	CurrentProfile string              `json:"currentProfile"`
	Profiles       map[string]*Profile `json:"profiles"`
}

// Store is a dotfile at a fixed path.
type Store struct {
	Path string
}

// DefaultPath resolves the dotfile location: $CHATCTL_CONFIG, else
// ~/.chatctl.json.
func DefaultPath() (string, error) {
	if p := os.Getenv("CHATCTL_CONFIG"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locating home directory: %w", err)
	}
	return filepath.Join(home, ".chatctl.json"), nil
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
	if err := json.Unmarshal(data, f); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", s.Path, err)
	}
	if f.Profiles == nil {
		f.Profiles = map[string]*Profile{}
	}
	return f, nil
}

// Save writes the dotfile atomically (temp file + rename) with 0600
// permissions — it holds bearer tokens, so it must not be world-readable,
// and a crash mid-write must not leave a truncated file behind.
func (s *Store) Save(f *File) error {
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
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

// ResolveName picks the active profile name: an explicit choice (flag or
// $CHATCTL_PROFILE), else the dotfile's current profile, else "default".
func (f *File) ResolveName(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if env := os.Getenv("CHATCTL_PROFILE"); env != "" {
		return env
	}
	if f.CurrentProfile != "" {
		return f.CurrentProfile
	}
	return DefaultProfile
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
