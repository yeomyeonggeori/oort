#!/usr/bin/env bash
# Collect a redacted internal-alpha diagnostics bundle.
set -u -o pipefail

OUT_PARENT="${DIAGNOSTICS_OUT_DIR:-${TMPDIR:-/tmp}/momo-diagnostics}"
SINCE="15m"
MAKE_TAR=1
SMOKE=0

usage() {
  cat <<'EOF'
Usage: scripts/collect_diagnostics.sh [--output-dir DIR] [--since 15m] [--no-tar] [--smoke]

Collects best-effort diagnostics for internal alpha debugging:
  - git commit/status and toolchain shape
  - redacted env/config shape
  - Docker/Centrifugo logs when available
  - recent server/relay/worker/local gate/macOS evidence files
  - recent MomoMac unified logs when available
  - markdown summary plus optional tar.gz

The collector is failure-tolerant: missing Docker, stopped services, absent logs,
or failing commands are recorded instead of aborting the bundle.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      OUT_PARENT="${2:-}"
      shift 2
      ;;
    --since)
      SINCE="${2:-}"
      shift 2
      ;;
    --no-tar)
      MAKE_TAR=0
      shift
      ;;
    --smoke)
      SMOKE=1
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

redact_stream() {
  perl -pe '
    s#(postgres(?:ql)?://)([^:/@\s]+):([^@\s]+)@#${1}[redacted-user]:[redacted-password]\@#gi;
    s#(://)([^:/@\s]+):([^@\s]+)@#${1}[redacted-user]:[redacted-password]\@#g;
    s#(?i)(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+#${1}${2} [REDACTED]#g;
    s#(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}#${1}[REDACTED]#g;
    s#(?i)\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|hmac|dsn|database_url|connection_string|authorization)[A-Za-z0-9_.-]*\s*[=:]\s*)("[^"]*"|[^[:space:],;]+)#${1}[REDACTED]#g;
    s#(?i)("(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|hmac|dsn|database_url|connection_string|authorization)"\s*:\s*)"[^"]*"#${1}"[REDACTED]"#g;
  '
}

run_smoke() {
  local tmp raw redacted
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/momo-diagnostics-smoke.XXXXXX")" || exit 1
  raw="$tmp/raw.txt"
  redacted="$tmp/redacted.txt"
  cat >"$raw" <<'EOF'
DATABASE_URL=postgres://momo:super-db-pass@localhost:5432/momo
CENT_API_KEY=super-secret-token
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt
{"accessToken":"raw-access-token-value","password":"dev-password"}
HERMES_API_KEY=hermes-token-123
EOF
  redact_stream <"$raw" >"$redacted"
  if grep -E 'super-db-pass|super-secret-token|raw-access-token-value|dev-password|hermes-token-123|eyJhbGci' "$redacted" >/dev/null; then
    echo "diagnostics redaction smoke FAIL" >&2
    cat "$redacted" >&2
    exit 1
  fi
  echo "diagnostics redaction smoke PASS: $redacted"
}

if [ "$SMOKE" -eq 1 ]; then
  run_smoke
  exit 0
fi

if [ -z "$OUT_PARENT" ]; then
  echo "--output-dir must not be empty" >&2
  exit 2
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "scripts/collect_diagnostics.sh must run inside a git repository" >&2
  exit 1
fi
cd "$REPO_ROOT" || exit 1

STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
RUN_RANDOM="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-12)"
if [ "$RUN_RANDOM" = "" ]; then
  RUN_RANDOM="$(date -u +"%s")"
fi
BUNDLE_NAME="momo-diagnostics-${STAMP}-pid$$-${RUN_RANDOM}"
BUNDLE_DIR="$OUT_PARENT/$BUNDLE_NAME"
SUMMARY="$BUNDLE_DIR/summary.md"
COMMAND_LOG="$BUNDLE_DIR/collection.log"
mkdir -p "$BUNDLE_DIR"/{env,git,logs,recent-evidence,system} || exit 1

log_note() {
  printf '%s\n' "$*" >>"$COMMAND_LOG"
}

capture_cmd() {
  local rel="$1"
  local label="$2"
  local command="$3"
  local out="$BUNDLE_DIR/$rel"
  mkdir -p "$(dirname "$out")"
  {
    echo "# $label"
    echo "\$ $command"
    echo
    set +e
    bash -lc "$command"
    code=$?
    set +e
    echo
    echo "exit_code=$code"
  } 2>&1 | redact_stream >"$out"
  log_note "$label -> $rel"
}

copy_redacted_file() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$src" ]; then
    redact_stream <"$src" >"$dest"
    log_note "copied $src -> ${dest#$BUNDLE_DIR/}"
  fi
}

hash_name() {
  local input="$1"
  local hash
  hash="$(printf '%s' "$input" | shasum -a 256 2>/dev/null | awk '{print substr($1,1,10)}')"
  if [ "$hash" = "" ]; then
    hash="$(printf '%s' "$input" | cksum | awk '{print $1}')"
  fi
  printf '%s' "$hash"
}

collect_recent_files() {
  local src_dir="$1"
  local label="$2"
  local max="${3:-40}"
  [ -d "$src_dir" ] || return 0
  find "$src_dir" -type f \( \
      -name '*.log' -o -name '*.md' -o -name '*evidence*.json' -o -name '*history*.json' -o \
      -name 'login-*.json' -o -name 'send-*.json' -o -name 'channels-*.json' \
    \) -mtime -7 2>/dev/null \
    | sort \
    | tail -n "$max" \
    | while IFS= read -r file; do
        h="$(hash_name "$file")"
        base="$(basename "$file")"
        copy_redacted_file "$file" "$BUNDLE_DIR/recent-evidence/${label}-${h}-${base}"
      done
}

ENV_FILE="${ENV_FILE:-}"
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE="$candidate"
      break
    fi
  done
fi

capture_cmd "git/commit.txt" "git commit" "git rev-parse --short HEAD && git show -s --format=fuller HEAD"
capture_cmd "git/status.txt" "git status" "git status --short --branch"
capture_cmd "git/diff-stat.txt" "git diff stat" "base=\"\${LOCAL_GATE_BASE_REF:-origin/main}\"; if git rev-parse --verify \"\$base\" >/dev/null 2>&1; then git diff --stat \"\$base\"...HEAD; git diff --name-status \"\$base\"...HEAD; else git diff --stat; git diff --name-status; fi"

capture_cmd "system/toolchain.txt" "toolchain" "hostname; sw_vers 2>/dev/null || uname -a; swift --version 2>/dev/null || true; xcodebuild -version 2>/dev/null || true; docker --version 2>/dev/null || true; docker compose version 2>/dev/null || true; psql --version 2>/dev/null || /opt/homebrew/opt/libpq/bin/psql --version 2>/dev/null || true"
capture_cmd "system/processes.txt" "momo process snapshot" "ps ax -o pid,ppid,stat,command | grep -E 'MomoServer|OutboxRelay|AgentWorker|MomoMac|centrifugo|postgres|mock_hermes' | grep -v grep || true"
capture_cmd "env/process-env.txt" "process environment redacted" "env | sort"

for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/.conductor/local.env" "$REPO_ROOT/infra/.env.example" "$REPO_ROOT/infra/prod/internal-smoke.env.example" "$REPO_ROOT/infra/prod/secrets.env.example"; do
  if [ -f "$candidate" ]; then
    rel="${candidate#$REPO_ROOT/}"
    safe_rel="$(printf '%s' "$rel" | tr '/.' '__')"
    copy_redacted_file "$candidate" "$BUNDLE_DIR/env/${safe_rel}.txt"
  fi
done

if command -v docker >/dev/null 2>&1; then
  if [ "$ENV_FILE" != "" ] && [ -f "$ENV_FILE" ]; then
    capture_cmd "logs/docker-compose-ps.txt" "docker compose ps" "docker compose --env-file '$ENV_FILE' -f infra/docker-compose.yml ps"
    capture_cmd "logs/docker-compose-logs.txt" "docker compose logs" "docker compose --env-file '$ENV_FILE' -f infra/docker-compose.yml logs --no-color --timestamps --tail 300"
    capture_cmd "logs/centrifugo.log" "centrifugo logs" "docker compose --env-file '$ENV_FILE' -f infra/docker-compose.yml logs --no-color --timestamps --tail 300 centrifugo"
  else
    capture_cmd "logs/docker-compose-unavailable.txt" "docker compose skipped" "echo 'No ENV_FILE found; docker compose log collection skipped.'"
  fi
else
  capture_cmd "logs/docker-unavailable.txt" "docker unavailable" "echo 'docker unavailable; compose logs skipped.'"
fi

if [ -x /usr/bin/log ]; then
  capture_cmd "logs/macos-unified-momomac.log" "MomoMac unified logs" "/usr/bin/log show --style compact --last '$SINCE' --predicate 'process == \"MomoMacDevApp\" OR process == \"MomoMacSmoke\" OR subsystem CONTAINS \"momo\"' || true"
else
  capture_cmd "logs/macos-unified-unavailable.txt" "macOS unified logs unavailable" "echo '/usr/bin/log unavailable; macOS unified logs skipped.'"
fi

TMP_ROOT="${TMPDIR:-/tmp}"
collect_recent_files "${LOCAL_GATE_OUT_DIR:-$TMP_ROOT/momo-local-gate}" "local-gate" 60
collect_recent_files "$TMP_ROOT/momo-local-gate" "local-gate" 60
collect_recent_files "$TMP_ROOT/momo-host-runtime" "host-runtime" 40
collect_recent_files "$TMP_ROOT/momo-macos-real-backend" "macos-real-backend" 40
collect_recent_files "$TMP_ROOT/momo-macos-dev-run" "macos-dev-run" 40
find "$TMP_ROOT" -maxdepth 1 -type f \( \
    -name 'momo-*-server-*.log' -o -name 'momo-*-relay-*.log' -o -name 'momo-agent-worker-*.log' -o \
    -name 'momo-mock-hermes-*.log' -o -name 'momo-*-evidence-*.md' -o -name 'momo-realtime-live-*.log' \
  \) -mtime -7 2>/dev/null \
  | sort \
  | tail -n 80 \
  | while IFS= read -r file; do
      h="$(hash_name "$file")"
      copy_redacted_file "$file" "$BUNDLE_DIR/recent-evidence/tmp-${h}-$(basename "$file")"
    done

{
  echo "# momo diagnostics bundle"
  echo
  echo "- Result: collected"
  echo "- Created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "- Worktree: \`$REPO_ROOT\`"
  echo "- Commit: \`$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\`"
  echo "- Branch: \`$(git branch --show-current 2>/dev/null || echo unknown)\`"
  echo "- Env file: \`${ENV_FILE:-none}\`"
  echo "- Redaction: secrets/password/token/key/hmac/database URL credentials are redacted before writing bundle files."
  echo
  echo "## Contents"
  echo
  find "$BUNDLE_DIR" -type f | sed "s#^$BUNDLE_DIR/##" | sort | sed 's/^/- `/' | sed 's/$/`/'
  echo
  echo "## Runtime Notes"
  echo
  echo "- Missing Docker, stopped services, or absent local gate logs are recorded as files instead of failing collection."
  echo "- Server/relay/worker evidence comes from recent verifier/local gate logs under \`${TMP_ROOT}\` when present."
  echo "- macOS logs are best-effort via Unified Logging for the last \`$SINCE\`."
} >"$SUMMARY"

TAR_FILE=""
if [ "$MAKE_TAR" -eq 1 ]; then
  TAR_FILE="$OUT_PARENT/${BUNDLE_NAME}.tar.gz"
  tar -C "$OUT_PARENT" -czf "$TAR_FILE" "$BUNDLE_NAME"
fi

echo "Diagnostics summary: $SUMMARY"
echo "Diagnostics directory: $BUNDLE_DIR"
if [ "$TAR_FILE" != "" ]; then
  echo "Diagnostics archive: $TAR_FILE"
fi
