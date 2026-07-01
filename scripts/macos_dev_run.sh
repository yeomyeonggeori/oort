#!/usr/bin/env bash
# Build and run the SwiftPM macOS development app without entering M4 packaging.
set -euo pipefail

PRODUCT="MomoMacDevApp"
BUNDLE_ID="app.momo.dev.MomoMacDevApp"
APP_NAME="MomoMacDevApp"
MIN_SYSTEM_VERSION="14.0"
LAUNCH=1
VERIFY=0
CAPTURE_LOGS=0
CAPTURE_TELEMETRY=0
DEBUG=0
TERMINATE_AFTER=0
TERMINATE_ONLY=0
LOG_WINDOW="2m"
WAIT_SECONDS=20
OUT_DIR="${MACOS_DEV_RUN_OUT_DIR:-${TMPDIR:-/tmp}/momo-macos-dev-run}"

usage() {
  cat <<'EOF'
Usage: scripts/macos_dev_run.sh [options]

Builds clients/macOS product MomoMacDevApp, stages a dev-only .app bundle under
dist/MomoMacDevApp.app, and launches it with open -n.

Options:
  --build-only          Build and stage the .app, but do not launch it.
  --launch              Build, stage, and launch. This is the default.
  --verify              After launch, verify process and window presence.
  --debug               Build and stage, then launch the executable under lldb.
  --logs                Capture recent unified logs for the app process.
  --telemetry           Capture recent unified logs for the dev bundle subsystem.
  --log-window DURATION Duration for log show --last. Default: 2m.
  --wait SECONDS        Seconds to wait for process/window verification. Default: 20.
  --terminate           Terminate the app after launch/verify/log capture.
  --terminate-only      Terminate any running MomoMacDevApp and exit.
  -h, --help            Show this help.

Environment:
  MACOS_DEV_RUN_DIRECT_EXEC=1  Launch Contents/MacOS/MomoMacDevApp directly so
                               MOMO_* environment variables reach the process.

Examples:
  scripts/macos_dev_run.sh
  scripts/macos_dev_run.sh --verify --logs
  scripts/macos_dev_run.sh --verify --logs --terminate
  scripts/macos_dev_run.sh --terminate-only
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only)
      LAUNCH=0
      shift
      ;;
    --launch)
      LAUNCH=1
      shift
      ;;
    --verify)
      VERIFY=1
      shift
      ;;
    --debug)
      DEBUG=1
      LAUNCH=0
      shift
      ;;
    --logs)
      CAPTURE_LOGS=1
      shift
      ;;
    --telemetry)
      CAPTURE_TELEMETRY=1
      shift
      ;;
    --log-window)
      LOG_WINDOW="${2:-}"
      shift 2
      ;;
    --wait)
      WAIT_SECONDS="${2:-}"
      shift 2
      ;;
    --terminate)
      TERMINATE_AFTER=1
      shift
      ;;
    --terminate-only)
      TERMINATE_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || [ "$WAIT_SECONDS" -lt 1 ]; then
  echo "--wait must be a positive integer" >&2
  exit 2
fi

if [ -z "$LOG_WINDOW" ]; then
  echo "--log-window requires a duration such as 2m or 30s" >&2
  exit 2
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "scripts/macos_dev_run.sh must run inside a git repository" >&2
  exit 1
fi
cd "$REPO_ROOT" || exit 1

APP_BUNDLE="$REPO_ROOT/dist/$APP_NAME.app"
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
LOG_FILE="$OUT_DIR/$APP_NAME-$STAMP.log"

terminate_app() {
  local pids
  pids="$(pgrep -x "$APP_NAME" || true)"
  if [ -z "$pids" ]; then
    echo "No running $APP_NAME process found."
    return 0
  fi

  echo "Terminating $APP_NAME: $pids"
  pkill -x "$APP_NAME" || true
  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! pgrep -x "$APP_NAME" >/dev/null 2>&1; then
      echo "$APP_NAME terminated."
      return 0
    fi
    sleep 0.5
  done

  echo "$APP_NAME did not terminate gracefully; sending SIGKILL."
  pkill -9 -x "$APP_NAME" || true
}

build_and_stage() {
  echo "Building $PRODUCT with SwiftPM..."
  DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
    swift build --package-path clients/macOS --product "$PRODUCT"

  local bin_dir
  bin_dir="$(
    DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
      swift build --package-path clients/macOS --product "$PRODUCT" --show-bin-path
  )"
  local built_executable="$bin_dir/$PRODUCT"
  if [ ! -x "$built_executable" ]; then
    echo "built executable not found: $built_executable" >&2
    exit 1
  fi

  echo "Staging dev bundle: $APP_BUNDLE"
  mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
  cp "$built_executable" "$APP_EXECUTABLE"
  chmod +x "$APP_EXECUTABLE"
  cat > "$INFO_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0-dev</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
EOF
}

launch_app() {
  if [ "${MACOS_DEV_RUN_DIRECT_EXEC:-0}" = "1" ]; then
    echo "Launching $APP_EXECUTABLE directly with inherited environment"
    "$APP_EXECUTABLE" >/dev/null 2>&1 &
    echo "$APP_NAME direct pid=$!"
  else
    echo "Launching $APP_BUNDLE"
    /usr/bin/open -n "$APP_BUNDLE"
  fi
}

process_pid() {
  pgrep -x "$APP_NAME" | head -n 1
}

wait_for_process() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  local pid=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(process_pid || true)"
    if [ -n "$pid" ]; then
      echo "$APP_NAME process is running: pid=$pid"
      return 0
    fi
    sleep 0.5
  done

  echo "$APP_NAME process did not appear within ${WAIT_SECONDS}s" >&2
  return 1
}

window_count() {
  /usr/bin/osascript <<EOF 2>/dev/null
tell application "System Events"
  if exists process "$APP_NAME" then
    tell process "$APP_NAME"
      return count of windows
    end tell
  end if
end tell
return 0
EOF
}

wait_for_window() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  local count="0"
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(window_count || echo 0)"
    if [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -ge 1 ]; then
      echo "$APP_NAME window smoke passed: window_count=$count"
      return 0
    fi
    sleep 0.5
  done

  echo "$APP_NAME window smoke failed: window_count=$count" >&2
  echo "If this machine blocks System Events automation, rerun manually from an allowed Terminal/Codex process." >&2
  return 1
}

capture_logs() {
  mkdir -p "$OUT_DIR"
  echo "Capturing unified logs to $LOG_FILE"
  if /usr/bin/log show --style compact --last "$LOG_WINDOW" --predicate "process == \"$APP_NAME\"" > "$LOG_FILE" 2>&1; then
    echo "Log file: $LOG_FILE"
  else
    echo "log show failed; partial output may exist at $LOG_FILE" >&2
    return 1
  fi
}

capture_telemetry() {
  mkdir -p "$OUT_DIR"
  local telemetry_file="$OUT_DIR/$APP_NAME-telemetry-$STAMP.log"
  echo "Capturing subsystem telemetry to $telemetry_file"
  if /usr/bin/log show --style compact --last "$LOG_WINDOW" --predicate "subsystem == \"$BUNDLE_ID\"" > "$telemetry_file" 2>&1; then
    echo "Telemetry file: $telemetry_file"
  else
    echo "telemetry capture failed; partial output may exist at $telemetry_file" >&2
    return 1
  fi
}

if [ "$TERMINATE_ONLY" -eq 1 ]; then
  terminate_app
  exit 0
fi

terminate_app
build_and_stage

if [ "$DEBUG" -eq 1 ]; then
  echo "Starting lldb for $APP_EXECUTABLE"
  exec lldb -- "$APP_EXECUTABLE"
fi

if [ "$LAUNCH" -eq 1 ]; then
  launch_app
  if [ "$VERIFY" -eq 1 ]; then
    wait_for_process
    wait_for_window
  fi
  if [ "$CAPTURE_LOGS" -eq 1 ]; then
    capture_logs
  fi
  if [ "$CAPTURE_TELEMETRY" -eq 1 ]; then
    capture_telemetry
  fi
else
  echo "Build-only mode complete."
fi

if [ "$TERMINATE_AFTER" -eq 1 ]; then
  terminate_app
fi

echo "macOS dev run complete."
