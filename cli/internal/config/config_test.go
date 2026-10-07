package config

import (
	"os"
	"path/filepath"
	"runtime"
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
	s := &Store{Path: filepath.Join(t.TempDir(), "sub", ".chatctl.json")}
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

func TestResolveName(t *testing.T) {
	t.Setenv("CHATCTL_PROFILE", "")
	f := &File{}
	if got := f.ResolveName(""); got != DefaultProfile {
		t.Fatalf("got %q", got)
	}
	f.CurrentProfile = "work"
	if got := f.ResolveName(""); got != "work" {
		t.Fatalf("got %q", got)
	}
	t.Setenv("CHATCTL_PROFILE", "env")
	if got := f.ResolveName(""); got != "env" {
		t.Fatalf("got %q", got)
	}
	if got := f.ResolveName("flag"); got != "flag" {
		t.Fatalf("got %q", got)
	}
}
