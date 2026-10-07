package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMissingFileIsEmpty(t *testing.T) {
	s := &Store{Path: filepath.Join(t.TempDir(), "nope.json")}
	f, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Profiles) != 0 {
		t.Fatalf("want no profiles, got %v", f.Profiles)
	}
}

func TestSaveRoundTripAndPermissions(t *testing.T) {
	s := &Store{Path: filepath.Join(t.TempDir(), "sub", ".chatctl.yml")}
	err := s.Update(func(f *File) error {
		f.CurrentProfile = "work"
		f.Profiles["work"] = &Profile{Server: "https://chat.example.com", RefreshToken: "r", User: &User{ID: 1, Username: "a"}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	f, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if f.CurrentProfile != "work" || f.Profiles["work"].RefreshToken != "r" || f.Profiles["work"].User.Username != "a" {
		t.Fatalf("round trip lost data: %+v", f)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(s.Path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("dotfile holds tokens; want 0600, got %o", perm)
		}
	}
}

func TestSavesReadableYAML(t *testing.T) {
	s := &Store{Path: filepath.Join(t.TempDir(), ".chatctl.yml")}
	err := s.Update(func(f *File) error {
		f.Profiles["alice"] = &Profile{Server: "https://chat.example.com", RefreshToken: "r", User: &User{ID: 1, Username: "alice"}}
		f.Switch("alice")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(s.Path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{"# chatctl config", "currentProfile: alice", "profiles:\n    alice:\n", "server: https://chat.example.com"} {
		if !strings.Contains(text, want) {
			t.Errorf("dotfile missing %q:\n%s", want, text)
		}
	}
}

func TestSelected(t *testing.T) {
	t.Setenv("CHATCTL_PROFILE", "")
	f := &File{}
	if got := f.Selected(""); got != "" {
		t.Fatalf("got %q", got)
	}
	f.CurrentProfile = "work"
	if got := f.Selected(""); got != "work" {
		t.Fatalf("got %q", got)
	}
	t.Setenv("CHATCTL_PROFILE", "env")
	if got := f.Selected(""); got != "env" {
		t.Fatalf("got %q", got)
	}
	if got := f.Selected("flag"); got != "flag" {
		t.Fatalf("got %q", got)
	}
}

func TestFind(t *testing.T) {
	f := &File{Profiles: map[string]*Profile{
		"alice":     {Server: "https://a", User: &User{Username: "alice"}},
		"work":      {Server: "https://w", User: &User{Username: "bob"}},
		"carol":     {Server: "https://a", User: &User{Username: "carol"}},
		"carol-dev": {Server: "http://localhost:3000", User: &User{Username: "carol"}},
	}}
	cases := map[string]string{"alice": "alice", "@alice": "alice", "work": "work", "@bob": "work", "bob": "work", "@carol": "carol"}
	for ref, want := range cases {
		got, _, err := f.Find(ref)
		if err != nil || got != want {
			t.Errorf("Find(%q) = %q, %v; want %q", ref, got, err, want)
		}
	}
	if _, _, err := f.Find("dave"); err == nil {
		t.Error("Find(dave) should fail")
	}
	// "carol" is an exact profile name, so it wins; drop it and @carol becomes ambiguous.
	delete(f.Profiles, "carol")
	f.Profiles["carol-prod"] = &Profile{Server: "https://a", User: &User{Username: "carol"}}
	if _, _, err := f.Find("@carol"); err == nil || !strings.Contains(err.Error(), "several servers") {
		t.Errorf("want ambiguity error, got %v", err)
	}
}

func TestSwitchTogglesBetweenLastTwo(t *testing.T) {
	f := &File{}
	f.Switch("alice")
	f.Switch("bob")
	if f.CurrentProfile != "bob" || f.PreviousProfile != "alice" {
		t.Fatalf("got current=%q previous=%q", f.CurrentProfile, f.PreviousProfile)
	}
	f.Switch(f.PreviousProfile) // `use -`
	if f.CurrentProfile != "alice" || f.PreviousProfile != "bob" {
		t.Fatalf("got current=%q previous=%q", f.CurrentProfile, f.PreviousProfile)
	}
	f.Switch("alice") // no-op keeps the toggle target
	if f.PreviousProfile != "bob" {
		t.Fatalf("re-selecting the current profile lost previous: %q", f.PreviousProfile)
	}
	f.Remove("bob")
	if f.PreviousProfile != "" {
		t.Fatal("removed profile still referenced as previous")
	}
}
