#!/usr/bin/env bash
# Runs the iOS unit + UI tests against a real backend.
#
#   ios/scripts/test.sh                 # everything, light mode
#   APPEARANCE=dark ios/scripts/test.sh # same, with the app in dark mode
#   ios/scripts/test.sh -only-testing:ChatPlatformUITests/AuthFlowTests
#
# Starts the repo's backend on a free port (in-memory DB, test JWT secret),
# waits for /version, runs xcodebuild test on a simulator, exports the UI-test
# screenshots to ios/build/screenshots/, and always stops the backend.
set -uo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_DIR/.." && pwd)"
BUILD_DIR="$IOS_DIR/build"
SIMULATOR_NAME="${SIMULATOR_NAME:-iPhone 18 Pro}"
APPEARANCE="${APPEARANCE:-light}"
RESULT="$BUILD_DIR/ChatPlatform-$APPEARANCE.xcresult"
SHOTS="$BUILD_DIR/screenshots/$APPEARANCE"

mkdir -p "$BUILD_DIR"
BACKEND_PID=""
cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$BACKEND_PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$BACKEND_PID" 2>/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# 1. The real backend: in-memory PGlite (no DB_PATH / DATABASE_URL), a test
#    JWT secret, in-memory realtime (REDIS_URL emptied).
PORT="$(free_port)"
API_BASE_URL="http://localhost:$PORT"
echo "▸ Starting backend on $API_BASE_URL"
(
  cd "$REPO_ROOT" || exit 1
  exec env -u DB_PATH -u DATABASE_URL PORT="$PORT" JWT_SECRET="ios-test-secret" REDIS_URL="" \
    bun run start
) >"$BUILD_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

# 2. Wait for it.
for _ in $(seq 1 150); do
  if curl -fsS "$API_BASE_URL/version" >/dev/null 2>&1; then READY=1; break; fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then echo "✗ Backend exited early:"; tail -30 "$BUILD_DIR/backend.log"; exit 1; fi
  sleep 0.2
done
if [[ -z "${READY:-}" ]]; then echo "✗ Backend never answered /version"; tail -30 "$BUILD_DIR/backend.log"; exit 1; fi
echo "▸ Backend up: $(curl -fsS "$API_BASE_URL/version")"

# 3. Project + tests.
cd "$IOS_DIR" || exit 1
echo "▸ Generating the Xcode project"
xcodegen generate --quiet || { echo "✗ xcodegen failed"; exit 1; }

rm -rf "$RESULT" "$SHOTS"
mkdir -p "$SHOTS"
echo "▸ xcodebuild test on $SIMULATOR_NAME ($APPEARANCE)"
# TEST_RUNNER_* variables are forwarded to the UI-test runner process.
TEST_RUNNER_API_BASE_URL="$API_BASE_URL" TEST_RUNNER_UITEST_APPEARANCE="$APPEARANCE" \
  xcodebuild test \
    -project ChatPlatform.xcodeproj \
    -scheme ChatPlatform \
    -destination "platform=iOS Simulator,name=$SIMULATOR_NAME" \
    -derivedDataPath "$BUILD_DIR/DerivedData" \
    -resultBundlePath "$RESULT" \
    -skipPackagePluginValidation -skipMacroValidation \
    -collect-test-diagnostics never \
    "$@" 2>&1 | tee "$BUILD_DIR/xcodebuild-$APPEARANCE.log" | { command -v xcbeautify >/dev/null && xcbeautify --quieter || grep -E "Test (Case|Suite).*(passed|failed)|error:|warning:|\*\* TEST|✘|✔|Executed" ; }
STATUS=${PIPESTATUS[0]}

# 4. Screenshots out of the result bundle, named after their attachments.
if [[ -d "$RESULT" ]]; then
  xcrun xcresulttool export attachments --path "$RESULT" --output-path "$SHOTS" >/dev/null 2>&1 || true
  python3 - "$SHOTS" <<'PY'
import json, os, shutil, sys
root = sys.argv[1]
manifest = os.path.join(root, "manifest.json")
if os.path.exists(manifest):
    for test in json.load(open(manifest)):
        group = test.get("testIdentifier", "test").split("/")[-1].replace("()", "")
        for att in test.get("attachments", []):
            src = os.path.join(root, att["exportedFileName"])
            name = att.get("suggestedHumanReadableName", att["exportedFileName"])
            base = name.split("_0_")[0]
            if not base.startswith(("light-", "dark-")):
                continue  # Xcode's own attachments (recordings, UI snapshots)
            if os.path.exists(src):
                shutil.move(src, os.path.join(root, f"{group}--{base}.png"))
PY
  # Keep only the named screenshots; drop the rest of the export.
  find "$SHOTS" -type f ! -name '*--*.png' -delete
  echo "▸ Screenshots: $SHOTS ($(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' '))"
fi

if [[ $STATUS -ne 0 ]]; then echo "✗ iOS tests failed (exit $STATUS) — $RESULT"; exit "$STATUS"; fi
echo "✓ iOS tests passed"
