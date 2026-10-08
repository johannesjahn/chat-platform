# chatctl

A command-line client for chat-platform, written in Go. Read the feed, post,
comment and react, send direct and group messages, follow a chat live, search,
and check notifications — all from the terminal.

## Install

Requires Go 1.26+.

```sh
cd cli
go build -o chatctl .      # or: go install .   (puts chatctl in $(go env GOPATH)/bin)
```

To stamp a version: `go build -ldflags "-X github.com/johannesjahn/chat-platform/cli/internal/cmd.Version=0.1.0" -o chatctl .`

## Log in

```sh
chatctl login --server https://chat.example.com -u alice   # prompts for the password
echo "$PASSWORD" | chatctl login -u alice --password-stdin  # non-interactive
```

Each login is stored as a **profile** in the dotfile **`~/.chatctl.yml`**
(override with `--config` or `$CHATCTL_CONFIG`), written with `0600`
permissions:

```yaml
# chatctl config — managed by `chatctl login` / `chatctl use`.
currentProfile: alice
previousProfile: bob
profiles:
  alice:
    server: https://chat.example.com
    user:
      id: 1
      username: alice
    accessToken: …
    refreshToken: …
  bob:
    server: https://chat.example.com
    # …
```

You never need to log in again while you keep using it. The access token is
short-lived, so chatctl refreshes it automatically — before it expires, or when
the server rejects it — and saves the new tokens to the dotfile. The backend
rotates refresh tokens and treats a reused one as stolen, so before refreshing,
chatctl checks the dotfile for tokens another chatctl process already rotated
and uses those instead.

## Switching accounts

Every account you log into is kept, so hopping between them is one command:

```sh
chatctl login -u alice -s https://chat.example.com
chatctl login -u bob          # adds bob (same server as the current profile) and switches to him
chatctl use alice             # switch back to alice (or: chatctl use @alice)
chatctl use -                 # toggle to the previous account, like `cd -`
chatctl use                   # list accounts; * marks the current one
chatctl --as bob dm alice "hi"   # run one command as bob without switching
```

- A login's profile is **named after the username** (pass `--profile` to pick
  another name, e.g. the same username on a second server:
  `chatctl login --profile alice-local -s http://localhost:3000 -u alice`).
- Logging in makes that profile current; `chatctl use -` goes back.
- Anywhere a profile is expected (`use`, `--as`, `-p/--profile`,
  `$CHATCTL_PROFILE`) you can give the profile name or `@username`.
  `$CHATCTL_PROFILE` is handy for pinning one terminal to one account.
- Profile names tab-complete once shell completion is installed.
- `chatctl logout [--all]` revokes the current account's session (or all of
  its sessions); `chatctl profiles rm NAME` forgets a profile.

## Usage

```sh
# Feed & posts
chatctl feed                              # newest posts (--by @alice, -n 20, --cursor …)
chatctl post create "Hello 👋"            # text as args…
git log -1 --format=%B | chatctl post create   # …or piped stdin…
chatctl post create                       # …or $EDITOR, like git commit
chatctl post create --attach ./diagram.png "caption"
chatctl post show 42                      # post + comments
chatctl post react 42 like                # 👍 ❤️ 😂 😮 😢 😡 or like/love/haha/wow/sad/angry
chatctl post comment 42 "nice"
chatctl comment reply 7 "thanks!"
chatctl post edit 42                      # opens $EDITOR pre-filled

# Chats — CHAT is a chat id, @username (DM, created on first use), or a group title
chatctl chats [--unread]
chatctl dm alice "lunch?"
chatctl chat send "Team standup" "running late"
chatctl chat send 12 --reply-to 931 "agreed"
chatctl chat show @alice -n 50 --read
chatctl chat open @alice                  # live: messages stream in, typed lines are sent
chatctl chat follow "CI alerts"           # live, read-only
chatctl chat group "Weekend plans" @alice @bob

# Everything else
chatctl notifications [--unread] [--read]
chatctl search deploy
chatctl user show @alice
chatctl status "Heads down" --emoji 🎧 --expires 2h    # no args clears it
chatctl api GET /games/typing/leaderboard               # raw call to any endpoint
```

Every command accepts `--json` for machine-readable output, which makes chatctl
easy to script:

```sh
chatctl chats --unread --json | jq -r '.chats[].id'
make test 2>&1 | tail -20 | chatctl chat send "CI alerts" -
```

Color is used only on a terminal and is disabled by `NO_COLOR`. Shell
completion: `chatctl completion zsh|bash|fish --help`.

## Development

```sh
go test -race ./...     # unit tests (refresh/rotation logic against a fake server)
go vet ./...
gofmt -l .
```

`internal/api` mirrors the backend schemas in the repo's `openapi.json` by hand
(only the fields the CLI reads; unknown fields are ignored, so additive API
changes don't break it). When a backend change renames or removes a field the
CLI uses, update `internal/api/types.go` too. The `cli` job in
`.github/workflows/ci.yml` runs format/vet/test/build.
