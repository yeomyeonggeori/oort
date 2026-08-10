#!/usr/bin/env bash
# Capture lightweight evidence during a local dogfood soak.
set -u -o pipefail

DURATION_HOURS="${LOCAL_SOAK_DURATION_HOURS:-72}"
INTERVAL_SECONDS="${LOCAL_SOAK_INTERVAL_SECONDS:-300}"
MAX_SAMPLES="${LOCAL_SOAK_SAMPLES:-0}"
OUT_PARENT="${LOCAL_SOAK_EVIDENCE_DIR:-${TMPDIR:-/tmp}/momo-local-soak}"
ENV_FILE="${ENV_FILE:-}"
COMPOSE_FILE="${LOCAL_SOAK_COMPOSE_FILE:-infra/docker-compose.yml}"

OUTBOX_WARN_COUNT="${LOCAL_SOAK_OUTBOX_WARN_COUNT:-10}"
OUTBOX_FAIL_COUNT="${LOCAL_SOAK_OUTBOX_FAIL_COUNT:-100}"
OUTBOX_WARN_AGE_SECONDS="${LOCAL_SOAK_OUTBOX_WARN_AGE_SECONDS:-60}"
OUTBOX_FAIL_AGE_SECONDS="${LOCAL_SOAK_OUTBOX_FAIL_AGE_SECONDS:-600}"
DISK_WARN_FREE_GB="${LOCAL_SOAK_DISK_WARN_FREE_GB:-10}"
DISK_FAIL_FREE_GB="${LOCAL_SOAK_DISK_FAIL_FREE_GB:-2}"

RUN_DIR=""
EVENTS_FILE=""
STOP_REQUESTED=0

usage() {
  cat <<'EOF'
Usage: scripts/local_soak_monitor.sh [options]

Options:
  --duration-hours N       Total monitor duration. Default: 72.
  --interval-seconds N     Seconds between snapshots. Default: 300.
  --samples N              Stop after N snapshots. Useful for smoke runs.
  --evidence-dir DIR       Parent directory outside the repo. Default: $TMPDIR/momo-local-soak.
  --env-file FILE          Env file to source. Default: .env.worktree, .env, then infra/.env.example.
  --compose-file FILE      Compose file for compose ps fallback. Default: infra/docker-compose.yml.
  --smoke                  One snapshot, no sleep. Does not require a 72h run.
  -h, --help               Show this help.

Environment:
  LOCAL_SOAK_EVIDENCE_DIR       Parent output directory.
  LOCAL_SOAK_DURATION_HOURS     Default duration.
  LOCAL_SOAK_INTERVAL_SECONDS   Default interval.
  LOCAL_SOAK_SAMPLES            Default sample cap.
  LOCAL_SOAK_OUTBOX_WARN_COUNT  Warn threshold for pending outbox rows. Default: 10.
  LOCAL_SOAK_OUTBOX_FAIL_COUNT  Fail threshold for pending outbox rows. Default: 100.
  LOCAL_SOAK_OUTBOX_WARN_AGE_SECONDS  Warn threshold for oldest pending row. Default: 60.
  LOCAL_SOAK_OUTBOX_FAIL_AGE_SECONDS  Fail threshold for oldest pending row. Default: 600.
  LOCAL_SOAK_OUTBOX_KINDS       SQL kind list the pending alarm watches.
                                Default: 'broadcast','agent_job' (MOMO-404:
                                push_candidate rows are expected to pend when
                                the NotifierWorker is not deployed).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --duration-hours)
      DURATION_HOURS="${2:-}"
      shift 2
      ;;
    --interval-seconds)
      INTERVAL_SECONDS="${2:-}"
      shift 2
      ;;
    --samples)
      MAX_SAMPLES="${2:-}"
      shift 2
      ;;
    --evidence-dir)
      OUT_PARENT="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:-}"
      shift 2
      ;;
    --smoke)
      DURATION_HOURS=0
      INTERVAL_SECONDS=0
      MAX_SAMPLES=1
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

is_non_negative_int() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

for value_name in DURATION_HOURS INTERVAL_SECONDS MAX_SAMPLES OUTBOX_WARN_COUNT OUTBOX_FAIL_COUNT OUTBOX_WARN_AGE_SECONDS OUTBOX_FAIL_AGE_SECONDS DISK_WARN_FREE_GB DISK_FAIL_FREE_GB; do
  value="$(eval "printf '%s' \"\${$value_name}\"")"
  if ! is_non_negative_int "$value"; then
    echo "$value_name must be a non-negative integer, got: $value" >&2
    exit 2
  fi
done

if [ "$INTERVAL_SECONDS" -eq 0 ] && [ "$MAX_SAMPLES" -eq 0 ]; then
  MAX_SAMPLES=1
fi
if [ "$DURATION_HOURS" -eq 0 ] && [ "$MAX_SAMPLES" -eq 0 ]; then
  MAX_SAMPLES=1
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "scripts/local_soak_monitor.sh must run inside a git repository" >&2
  exit 1
fi
cd "$REPO_ROOT" || exit 1

if [ -z "$ENV_FILE" ]; then
  for candidate in ".env.worktree" ".env" "infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE="$candidate"
      break
    fi
  done
fi

if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

stamp() {
  date -u +"%Y%m%dT%H%M%SZ"
}

redact_stream() {
  perl -pe '
    s#(postgres(?:ql)?://)([^:/@\s]+):([^@\s]+)@#${1}[redacted-user]:[redacted-password]\@#gi;
    s#(?i)(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+#${1}${2} [REDACTED]#g;
    s#(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}#${1}[REDACTED]#g;
    s#(?i)\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|hmac|dsn|database_url|connection_string|authorization)[A-Za-z0-9_.-]*\s*[=:]\s*)("[^"]*"|[^[:space:],;]+)#${1}[REDACTED]#g;
    s#(?i)("(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|hmac|dsn|database_url|connection_string|authorization)"\s*:\s*)"[^"]*"#${1}"[REDACTED]"#g;
  '
}

sanitize_field() {
  printf '%s' "$1" | tr '\t\r\n' '   ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//'
}

record_event() {
  local severity="$1"
  local area="$2"
  local message="$3"
  printf '%s\t%s\t%s\t%s\n' "$(timestamp)" "$severity" "$(sanitize_field "$area")" "$(sanitize_field "$message")" >> "$EVENTS_FILE"
}

run_capture() {
  local out="$1"
  local command="$2"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/momo-soak-capture.XXXXXX")" || return 1
  set +e
  bash -lc "$command" >"$tmp" 2>&1
  local code=$?
  set +e
  redact_stream <"$tmp" >"$out"
  rm -f "$tmp"
  return "$code"
}

psql_bin() {
  if command -v psql >/dev/null 2>&1; then
    command -v psql
  elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
    printf '%s\n' /opt/homebrew/opt/libpq/bin/psql
  else
    return 1
  fi
}

container_ids_for_project() {
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  if [ "${COMPOSE_PROJECT_NAME:-}" != "" ]; then
    docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null
    return 0
  fi
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && [ -f "$COMPOSE_FILE" ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q 2>/dev/null
  fi
}

check_http() {
  local url="$1"
  local label="$2"
  local body="$3"
  local err="$4"
  local tmp_err
  tmp_err="$(mktemp "${TMPDIR:-/tmp}/momo-soak-http.XXXXXX")" || return 1
  set +e
  curl -fsS --max-time 5 "$url" >"$body" 2>"$tmp_err"
  local code=$?
  set +e
  redact_stream <"$tmp_err" >"$err"
  rm -f "$tmp_err"
  if [ "$code" -eq 0 ]; then
    record_event "PASS" "$label" "$url responded"
  else
    record_event "FAIL" "$label" "$url failed with curl exit $code"
  fi
}

check_centrifugo_health() {
  local snap_dir="$1"
  local body="$snap_dir/centrifugo-health.body"
  local err="$snap_dir/centrifugo-health.err"
  local url="http://127.0.0.1:${CENT_PORT:-8000}/health"
  local tmp_err
  tmp_err="$(mktemp "${TMPDIR:-/tmp}/momo-soak-http.XXXXXX")" || return 1
  set +e
  curl -fsS --max-time 5 "$url" >"$body" 2>"$tmp_err"
  local code=$?
  set +e
  redact_stream <"$tmp_err" >"$err"
  rm -f "$tmp_err"
  if [ "$code" -eq 0 ]; then
    record_event "PASS" "centrifugo-health" "$url responded"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    record_event "FAIL" "centrifugo-health" "$url failed with curl exit $code and docker is unavailable"
    return 0
  fi

  local cid status
  cid="$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-}" \
    --filter "label=com.docker.compose.service=centrifugo" 2>/dev/null | head -n 1)"
  if [ "$cid" = "" ]; then
    record_event "FAIL" "centrifugo-health" "$url failed with curl exit $code and no Centrifugo compose container was found"
    return 0
  fi
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
  printf 'http_health_curl_exit=%s\ndocker_container=%s\ndocker_health=%s\n' "$code" "$cid" "$status" >"$body"
  if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
    record_event "PASS" "centrifugo-health" "HTTP /health unavailable, Docker health is $status"
  else
    record_event "FAIL" "centrifugo-health" "HTTP /health failed with curl exit $code and Docker health is ${status:-unknown}"
  fi
}

psql_capture() {
  local query="$1"
  local out="$2"
  local err="$3"
  local tmp_err code psql_path cid
  : >"$err"

  tmp_err="$(mktemp "${TMPDIR:-/tmp}/momo-soak-db.XXXXXX")" || return 1
  if psql_path="$(psql_bin 2>/dev/null)" && [ "${DATABASE_URL:-}" != "" ]; then
    set +e
    "$psql_path" "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "$query" >"$out" 2>"$tmp_err"
    code=$?
    set +e
    redact_stream <"$tmp_err" >>"$err"
    rm -f "$tmp_err"
    if [ "$code" -eq 0 ]; then
      return 0
    fi
  else
    rm -f "$tmp_err"
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is unavailable for DB fallback" >>"$err"
    return 1
  fi
  cid="$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-}" \
    --filter "label=com.docker.compose.service=postgres" 2>/dev/null | head -n 1)"
  if [ "$cid" = "" ]; then
    echo "no postgres compose container found for DB fallback" >>"$err"
    return 1
  fi

  tmp_err="$(mktemp "${TMPDIR:-/tmp}/momo-soak-db.XXXXXX")" || return 1
  set +e
  docker exec "$cid" psql \
    -U "${POSTGRES_USER:-momo}" \
    -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 \
    -Atqc "$query" >"$out" 2>"$tmp_err"
  code=$?
  set +e
  redact_stream <"$tmp_err" >>"$err"
  rm -f "$tmp_err"
  [ "$code" -eq 0 ]
}

check_db_and_outbox() {
  local snap_dir="$1"
  local connect_out="$snap_dir/db-connect.txt"
  local connect_err="$snap_dir/db-connect.err"
  if psql_capture "SELECT 1;" "$connect_out" "$connect_err" && grep -Fxq "1" "$connect_out"; then
    record_event "PASS" "db" "PostgreSQL connectivity check passed"
  else
    record_event "FAIL" "db" "PostgreSQL connectivity check failed"
    return 0
  fi

  local outbox_out="$snap_dir/outbox-pending.tsv"
  local outbox_err="$snap_dir/outbox-pending.err"
  # MOMO-404: kind-scoped. Every message insert now also enqueues a
  # kind='push_candidate' row (011 trigger); stacks that do not run the
  # NotifierWorker accumulate those rows legitimately, so the stuck-row alarm
  # only watches kinds whose consumers this soak stack actually runs. Set
  # LOCAL_SOAK_OUTBOX_KINDS="'broadcast','agent_job','push_candidate'" when the
  # notifier is part of the soak deployment.
  local outbox_kinds="${LOCAL_SOAK_OUTBOX_KINDS:-'broadcast','agent_job'}"
  if ! psql_capture "SELECT count(*)::text || E'\t' || COALESCE(max(EXTRACT(EPOCH FROM (now() - created_at)))::bigint, 0)::text FROM outbox WHERE status = 'pending' AND kind::text IN ($outbox_kinds);" "$outbox_out" "$outbox_err"; then
    record_event "FAIL" "outbox" "pending outbox query failed"
    return 0
  fi

  local pending_count oldest_age
  pending_count="$(awk -F '\t' 'NR==1 { print $1 }' "$outbox_out")"
  oldest_age="$(awk -F '\t' 'NR==1 { print $2 }' "$outbox_out")"
  pending_count="${pending_count:-0}"
  oldest_age="${oldest_age:-0}"
  if [ "$pending_count" -ge "$OUTBOX_FAIL_COUNT" ] || [ "$oldest_age" -ge "$OUTBOX_FAIL_AGE_SECONDS" ]; then
    record_event "FAIL" "outbox" "pending=$pending_count oldest_age_seconds=$oldest_age crossed P0 threshold"
  elif [ "$pending_count" -ge "$OUTBOX_WARN_COUNT" ] || [ "$oldest_age" -ge "$OUTBOX_WARN_AGE_SECONDS" ]; then
    record_event "WARN" "outbox" "pending=$pending_count oldest_age_seconds=$oldest_age crossed P1 threshold"
  else
    record_event "PASS" "outbox" "pending=$pending_count oldest_age_seconds=$oldest_age"
  fi
}

check_docker() {
  local snap_dir="$1"
  if ! command -v docker >/dev/null 2>&1; then
    record_event "FAIL" "docker" "docker is unavailable"
    return 0
  fi

  run_capture "$snap_dir/docker-version.txt" "docker --version; docker compose version" || true
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && [ -f "$COMPOSE_FILE" ]; then
    run_capture "$snap_dir/docker-compose-ps.txt" "docker compose --env-file '$ENV_FILE' -f '$COMPOSE_FILE' ps" || true
  fi

  local ids_file="$snap_dir/docker-container-ids.txt"
  container_ids_for_project | sort >"$ids_file"
  if [ ! -s "$ids_file" ]; then
    record_event "FAIL" "docker" "no Docker containers found for COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-<unset>}"
    return 0
  fi

  run_capture "$snap_dir/docker-ps.txt" "docker ps -a --filter 'label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-}' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'" || true
  run_capture "$snap_dir/docker-stats.txt" "ids=\$(tr '\n' ' ' < '$ids_file'); docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}' \$ids" || true
  run_capture "$snap_dir/docker-system-df.txt" "docker system df" || true

  if awk '
    NR > 1 && $1 !~ /-migrate-1$/ && tolower($0) ~ /(unhealthy|exited|created|restarting|dead)/ { bad = 1 }
    END { exit bad ? 0 : 1 }
  ' "$snap_dir/docker-ps.txt"; then
    record_event "FAIL" "docker" "one or more compose containers are not running healthy"
  else
    record_event "PASS" "docker" "compose containers found and no stopped/unhealthy status observed"
  fi
}

check_processes() {
  local snap_dir="$1"
  local process_file="$snap_dir/momo-processes.txt"
  run_capture "$process_file" "ps ax -o pid,ppid,stat,etime,command | grep -E 'MomoServer|OutboxRelay|AgentWorker|mock_hermes' | grep -v grep || true" || true

  if grep -E "OutboxRelay" "$process_file" >/dev/null 2>&1 || docker ps --format '{{.Names}}' 2>/dev/null | grep -Ei 'relay|outbox' >/dev/null 2>&1; then
    record_event "PASS" "relay" "OutboxRelay process/container observed"
  else
    record_event "WARN" "relay" "OutboxRelay process/container not observed"
  fi

  if grep -E "AgentWorker" "$process_file" >/dev/null 2>&1 || docker ps --format '{{.Names}}' 2>/dev/null | grep -Ei 'worker|agent' >/dev/null 2>&1; then
    record_event "PASS" "worker" "AgentWorker process/container observed"
  else
    record_event "WARN" "worker" "AgentWorker process/container not observed"
  fi

  # W-S1(#1215): 여기 있던 `macos-app` 관측(MomoMacDevApp/MomoMacSmoke 프로세스,
  # --launch-macos-smoke, --require-macos-evidence)은 SwiftUI 클라 트리 삭제와 함께
  # 제거됐다. 클라이언트 표면의 소크 증거는 이제 웹/데스크톱/RN 쪽 몫이며, 이
  # 모니터는 백엔드(서버·릴레이·워커·outbox·Docker·디스크)만 잰다.
}

check_disk() {
  local snap_dir="$1"
  local out="$snap_dir/disk-free.txt"
  run_capture "$out" "df -Pk '$OUT_PARENT' '$REPO_ROOT' 2>/dev/null || df -Pk '$OUT_PARENT'" || true
  local available_kb
  available_kb="$(df -Pk "$OUT_PARENT" 2>/dev/null | awk 'NR==2 { print $4 }')"
  available_kb="${available_kb:-0}"
  local warn_kb fail_kb
  warn_kb=$((DISK_WARN_FREE_GB * 1024 * 1024))
  fail_kb=$((DISK_FAIL_FREE_GB * 1024 * 1024))
  if [ "$available_kb" -gt 0 ] && [ "$available_kb" -lt "$fail_kb" ]; then
    record_event "FAIL" "disk" "free disk below ${DISK_FAIL_FREE_GB}GB at evidence directory"
  elif [ "$available_kb" -gt 0 ] && [ "$available_kb" -lt "$warn_kb" ]; then
    record_event "WARN" "disk" "free disk below ${DISK_WARN_FREE_GB}GB at evidence directory"
  else
    record_event "PASS" "disk" "free disk is above warn threshold at evidence directory"
  fi
}

write_snapshot_index() {
  local snap_dir="$1"
  local sample="$2"
  local snap_started="$3"
  local md="$snap_dir/snapshot.md"
  {
    echo "## Local Soak Snapshot"
    echo "- Sample: \`$sample\`"
    echo "- Timestamp: $snap_started"
    echo "- API URL: \`http://127.0.0.1:${PORT:-8080}/health\`"
    echo "- Centrifugo URL: \`http://127.0.0.1:${CENT_PORT:-8000}/health\`"
    echo "- Env file: \`${ENV_FILE:-<none>}\`"
    echo "- Compose project: \`${COMPOSE_PROJECT_NAME:-<unset>}\`"
    echo "- Files:"
    find "$snap_dir" -maxdepth 1 -type f | sort | while IFS= read -r file; do
      echo "  - \`$(basename "$file")\`"
    done
  } >"$md"
}

write_summary() {
  local summary="$RUN_DIR/summary.md"
  local fail_count warn_count pass_count result finish_time
  fail_count="$(awk -F '\t' '$2 == "FAIL" { c++ } END { print c + 0 }' "$EVENTS_FILE" 2>/dev/null)"
  warn_count="$(awk -F '\t' '$2 == "WARN" { c++ } END { print c + 0 }' "$EVENTS_FILE" 2>/dev/null)"
  pass_count="$(awk -F '\t' '$2 == "PASS" { c++ } END { print c + 0 }' "$EVENTS_FILE" 2>/dev/null)"
  if [ "$fail_count" -gt 0 ]; then
    result="FAIL"
  elif [ "$warn_count" -gt 0 ]; then
    result="WARN"
  else
    result="PASS"
  fi
  finish_time="$(timestamp)"
  {
    echo "## Local Soak Monitor"
    echo "- Result: \`$result\`"
    echo "- Finished: $finish_time"
    echo "- Repo: \`$REPO_ROOT\`"
    echo "- Commit: \`$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\`"
    echo "- Branch: \`$(git branch --show-current 2>/dev/null || echo detached)\`"
    echo "- Evidence directory: \`$RUN_DIR\`"
    echo "- Env file: \`${ENV_FILE:-<none>}\`"
    echo "- Compose project: \`${COMPOSE_PROJECT_NAME:-<unset>}\`"
    echo "- Duration hours: \`$DURATION_HOURS\`"
    echo "- Interval seconds: \`$INTERVAL_SECONDS\`"
    echo "- Sample cap: \`$MAX_SAMPLES\`"
    echo "- Events: pass=\`$pass_count\`, warn=\`$warn_count\`, fail=\`$fail_count\`"
    if [ "$STOP_REQUESTED" -eq 1 ]; then
      echo "- Stop: interrupted; summary covers completed snapshots only."
    fi
    echo
    echo "### PASS/WARN/FAIL Criteria"
    echo "- PASS: every required health/resource check responds and no operational warning is recorded."
    echo "- WARN: no required check failed, but at least one P1 signal was observed, such as relay/worker/app not observed, outbox backlog crossing warn thresholds, or low free disk."
    echo "- FAIL: any P0 signal was observed, such as API/Centrifugo/DB unavailable, Docker unavailable/unhealthy, outbox backlog crossing fail thresholds, or critically low free disk."
    echo
    echo "### P0/P1 Detection Thresholds"
    echo "- P0: API \`/health\`, Centrifugo \`/health\`, or DB connectivity fails in a snapshot."
    echo "- P0: Docker is unavailable, no compose containers are found for the worktree project, or any observed compose container is unhealthy."
    echo "- P0: pending outbox rows >= \`$OUTBOX_FAIL_COUNT\` or oldest pending outbox age >= \`${OUTBOX_FAIL_AGE_SECONDS}s\`."
    echo "- P0: free disk at the evidence directory drops below \`${DISK_FAIL_FREE_GB}GB\`."
    echo "- P1: pending outbox rows >= \`$OUTBOX_WARN_COUNT\` or oldest pending outbox age >= \`${OUTBOX_WARN_AGE_SECONDS}s\`."
    echo "- P1: relay or worker process/container is not observed while the soak is running."
    echo "- P1: free disk at the evidence directory drops below \`${DISK_WARN_FREE_GB}GB\`."
    echo
    echo "### Events"
    if [ -s "$EVENTS_FILE" ]; then
      awk -F '\t' '{ printf "- %s `%s` **%s**: %s\n", $1, $2, $3, $4 }' "$EVENTS_FILE"
    else
      echo "- No events recorded."
    fi
    echo
    echo "### Snapshot Files"
    find "$RUN_DIR/snapshots" -maxdepth 2 -type f 2>/dev/null | sort | sed "s#^$RUN_DIR/##" | while IFS= read -r file; do
      echo "- \`$file\`"
    done
  } >"$summary"
}

handle_interrupt() {
  STOP_REQUESTED=1
}

trap handle_interrupt INT TERM

case "$OUT_PARENT" in
  /*)
    requested_out_parent="$OUT_PARENT"
    ;;
  *)
    requested_dirname="$(dirname "$OUT_PARENT")"
    requested_basename="$(basename "$OUT_PARENT")"
    if requested_parent_dir="$(cd "$requested_dirname" 2>/dev/null && pwd)"; then
      requested_out_parent="$requested_parent_dir/$requested_basename"
    else
      requested_out_parent="$REPO_ROOT/$OUT_PARENT"
    fi
    ;;
esac
case "$requested_out_parent/" in
  "$REPO_ROOT"/*)
    echo "--evidence-dir must be outside the repository: $requested_out_parent" >&2
    exit 2
    ;;
esac

mkdir -p "$OUT_PARENT" || exit 1
OUT_PARENT="$(cd "$OUT_PARENT" && pwd)"
case "$OUT_PARENT/" in
  "$REPO_ROOT"/*)
    echo "--evidence-dir must be outside the repository: $OUT_PARENT" >&2
    exit 2
    ;;
esac

RUN_ID="momo-soak-$(stamp)-pid$$"
RUN_DIR="$OUT_PARENT/$RUN_ID"
mkdir -p "$RUN_DIR/snapshots" || exit 1
EVENTS_FILE="$RUN_DIR/events.tsv"
: >"$EVENTS_FILE"

{
  echo "momo local soak monitor"
  echo "run_dir: $RUN_DIR"
  echo "started_at_utc: $(timestamp)"
  echo "repo: $REPO_ROOT"
  echo "branch: $(git branch --show-current 2>/dev/null || echo detached)"
  echo "commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "env_file: ${ENV_FILE:-<none>}"
  echo "compose_project: ${COMPOSE_PROJECT_NAME:-<unset>}"
  echo "duration_hours: $DURATION_HOURS"
  echo "interval_seconds: $INTERVAL_SECONDS"
  echo "sample_cap: $MAX_SAMPLES"
} | tee "$RUN_DIR/monitor.log"

start_epoch="$(date -u +%s)"
duration_seconds=$((DURATION_HOURS * 3600))
deadline_epoch=$((start_epoch + duration_seconds))
sample=1

while true; do
  now_epoch="$(date -u +%s)"
  if [ "$DURATION_HOURS" -gt 0 ] && [ "$now_epoch" -gt "$deadline_epoch" ]; then
    break
  fi
  if [ "$MAX_SAMPLES" -gt 0 ] && [ "$sample" -gt "$MAX_SAMPLES" ]; then
    break
  fi
  if [ "$STOP_REQUESTED" -eq 1 ]; then
    break
  fi

  snap_started="$(timestamp)"
  snap_name="$(printf 'sample-%04d-%s' "$sample" "$(stamp)")"
  snap_dir="$RUN_DIR/snapshots/$snap_name"
  mkdir -p "$snap_dir" || exit 1
  echo "snapshot $sample at $snap_started" | tee -a "$RUN_DIR/monitor.log"

  check_http "http://127.0.0.1:${PORT:-8080}/health" "api-health" "$snap_dir/api-health.body" "$snap_dir/api-health.err"
  check_centrifugo_health "$snap_dir"
  check_db_and_outbox "$snap_dir"
  check_docker "$snap_dir"
  check_processes "$snap_dir"
  check_disk "$snap_dir"
  write_snapshot_index "$snap_dir" "$sample" "$snap_started"
  write_summary

  sample=$((sample + 1))
  if [ "$INTERVAL_SECONDS" -eq 0 ]; then
    continue
  fi
  if [ "$MAX_SAMPLES" -gt 0 ] && [ "$sample" -gt "$MAX_SAMPLES" ]; then
    break
  fi
  if [ "$STOP_REQUESTED" -eq 1 ]; then
    break
  fi
  sleep "$INTERVAL_SECONDS"
done

write_summary
echo "Summary: $RUN_DIR/summary.md"

final_result="$(awk -F '`' '/^- Result:/ { print $2; exit }' "$RUN_DIR/summary.md")"
case "$final_result" in
  PASS) exit 0 ;;
  WARN) exit 0 ;;
  *) exit 1 ;;
esac
