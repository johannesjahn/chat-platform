// Command chatctl is a command-line client for chat-platform.
package main

import (
	"os"

	"github.com/johannesjahn/chat-platform/cli/internal/cmd"
)

func main() {
	os.Exit(cmd.Execute())
}
