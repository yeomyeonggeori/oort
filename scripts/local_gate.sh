#!/usr/bin/env bash
# Local PR gate runner for the GitHub Actions disabled/manual-only period.
# shellcheck disable=SC2016
set -u -o pipefail

PROFILE="docs"
OUT_DIR="${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}"

usage() {
  cat <<'EOF'
Usage: scripts/local_gate.sh --profile docs|swift|staging-smoke|runtime-db|runtime-relay|runtime-live|runtime-agent|macos-ui|m3-dbc|all

Options:
  --profile PROFILE   Gate profile to run. Default: docs
  --output-dir DIR    Directory for log/evidence files. Default: $TMPDIR/momo-local-gate
  -h, --help          Show this help.

Environment:
  LOCAL_GATE_OUT_DIR      Override evidence output directory.
  LOCAL_GATE_LAUNCH_UI=1  In macos-ui/all, launch MomoMacDevApp instead of smoke only.
  LOCAL_GATE_ALLOW_DIRTY=1 Allow pre-commit exploratory runs with dirty files.
  LOCAL_GATE_BASE_REF      Defaults to origin/main for committed PR diff checks.
  DEVELOPER_DIR           Defaults to /Applications/Xcode.app/Contents/Developer for Swift gates.
  ENV_FILE                Optional runtime env file consumed by Makefile/runtime scripts.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    docs|swift|staging-smoke|runtime-db|runtime-relay|runtime-live|runtime-agent|macos-ui|m3-dbc|all)
      PROFILE="$1"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$PROFILE" in
  docs|swift|staging-smoke|runtime-db|runtime-relay|runtime-live|runtime-agent|macos-ui|m3-dbc|all) ;;
  *)
    echo "unknown profile: $PROFILE" >&2
    usage >&2
    exit 2
    ;;
esac

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "scripts/local_gate.sh must run inside a git repository" >&2
  exit 1
fi
cd "$REPO_ROOT" || exit 1

mkdir -p "$OUT_DIR" || exit 1
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
START_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

RUN_NANOS="$(
  python3 - <<'PY' 2>/dev/null || date -u +"%s000000000"
import time
print(time.time_ns())
PY
)"
WORKTREE_HASH="$(
  printf '%s' "$REPO_ROOT" | shasum -a 256 2>/dev/null | awk '{ print substr($1, 1, 12) }'
)"
if [ "$WORKTREE_HASH" = "" ]; then
  WORKTREE_HASH="$(printf '%s' "$REPO_ROOT" | cksum | awk '{ print $1 }')"
fi
RUN_RANDOM="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-12)"
if [ "$RUN_RANDOM" = "" ]; then
  RUN_RANDOM="$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 12)"
fi
if [ "$RUN_RANDOM" = "" ]; then
  RUN_RANDOM="$(date -u +"%s")"
fi
RUN_ID="${STAMP}-pid$$-ns${RUN_NANOS}-wt${WORKTREE_HASH}-r${RUN_RANDOM}"
LOG_FILE="$OUT_DIR/local-gate-${PROFILE}-${RUN_ID}.log"
EVIDENCE_FILE="$OUT_DIR/local-gate-${PROFILE}-${RUN_ID}.md"

declare -a CMD_LABELS=()
declare -a CMD_STRINGS=()
declare -a CMD_STATUS=()
declare -a RUNTIME_COVERAGE=()
declare -a NOT_COVERED=()
BOOTSTRAP_ADDED=0

add_cmd() {
  local label="$1"
  local command="$2"
  CMD_LABELS+=("$label")
  CMD_STRINGS+=("$command")
  CMD_STATUS+=("not-run")
}

add_cmd_once() {
  local label="$1"
  local command="$2"
  local existing
  for existing in "${CMD_STRINGS[@]:-}"; do
    if [ "$existing" = "$command" ]; then
      return 0
    fi
  done
  CMD_LABELS+=("$label")
  CMD_STRINGS+=("$command")
  CMD_STATUS+=("not-run")
}

add_note_once() {
  local target="$1"
  local note="$2"
  local existing
  if [ "$target" = "coverage" ]; then
    for existing in "${RUNTIME_COVERAGE[@]:-}"; do
      [ "$existing" = "$note" ] && return 0
    done
    RUNTIME_COVERAGE+=("$note")
  else
    for existing in "${NOT_COVERED[@]:-}"; do
      [ "$existing" = "$note" ] && return 0
    done
    NOT_COVERED+=("$note")
  fi
}

add_static_commands() {
  add_cmd_once "worktree clean" 'if [ "${LOCAL_GATE_ALLOW_DIRTY:-0}" = "1" ]; then echo "LOCAL_GATE_ALLOW_DIRTY=1; dirty state is recorded but not failed"; git status --short; else test -z "$(git status --porcelain)" || { echo "worktree has uncommitted changes"; git status --short; exit 1; }; fi'
  add_cmd_once "diff whitespace" 'base="${LOCAL_GATE_BASE_REF:-origin/main}"; if git rev-parse --verify "$base" >/dev/null 2>&1; then git diff --check "$base"...HEAD; else echo "base ref $base unavailable; falling back to working tree whitespace checks"; fi; git diff --cached --check; git diff --check'
  add_cmd_once "workflow yaml parse" "ruby -e 'require \"yaml\"; Dir[\".github/workflows/*.yml\"].sort.each { |f| YAML.load_file(f); puts f }'"
  add_cmd_once "workflow lint" 'if command -v actionlint >/dev/null 2>&1; then actionlint .github/workflows/*.yml; else base="${LOCAL_GATE_BASE_REF:-origin/main}"; changed=""; if git rev-parse --verify "$base" >/dev/null 2>&1; then changed="$(git diff --name-only "$base"...HEAD -- .github/workflows/*.yml)"; else changed="$(git diff --name-only -- .github/workflows/*.yml)"; fi; if [ -n "$changed" ]; then echo "actionlint is not installed and workflow files changed:"; printf "%s\n" "$changed"; exit 1; fi; echo "actionlint not installed; workflow files unchanged; skipped"; fi'
  add_cmd_once "e2e compose config" 'env_file="${ENV_FILE:-}"; if [ -z "$env_file" ]; then for f in .env.worktree .env infra/.env.example; do if [ -f "$f" ]; then env_file="$f"; break; fi; done; fi; test -n "$env_file" || { echo "no env file found for e2e compose config"; exit 1; }; docker compose --env-file "$env_file" -f infra/docker-compose.e2e.yml config >/tmp/momo-compose-e2e-config.yml; echo "wrote /tmp/momo-compose-e2e-config.yml using $env_file"'
  add_cmd_once "json syntax" 'jq empty .github/labels.json infra/centrifugo.json infra/prod/centrifugo.prod.json && find research/11-agent-runtime/fixtures -name "*.json" -print0 | xargs -0 jq empty'
  add_cmd_once "shell syntax" 'for f in .conductor/setup.sh scripts/local_gate.sh scripts/compose_janitor.sh scripts/macos_dev_run.sh scripts/goal_claim.sh scripts/goal_status.sh scripts/goal_release.sh scripts/github_bootstrap.sh scripts/github/bootstrap.sh scripts/migrate.sh scripts/verify_rls.sh scripts/verify_roster.sh scripts/verify_channel_list.sh scripts/verify_join.sh scripts/verify_platform_admin.sh scripts/verify_approval_decision.sh scripts/verify_relay.sh scripts/verify_realtime_live.sh scripts/verify_agent_worker.sh scripts/verify_agent_live_channel.sh scripts/verify_staging_smoke.sh scripts/verify_macos_real_backend_ui.sh; do [ -e "$f" ] || { echo "missing shell script: $f"; exit 1; }; bash -n "$f"; done'
  add_cmd_once "python syntax" 'PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 -m py_compile adapters/hermes/momo_adapter.py scripts/mock_hermes.py adapters/hermes/tests/test_momo_adapter_contract.py adapters/hermes/tests/smoke_momo_adapter.py; PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/hermes/tests/test_momo_adapter_contract.py; PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/hermes/tests/smoke_momo_adapter.py'
}

add_swift_commands() {
  add_cmd_once "swift build" 'DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" make build'
  add_cmd_once "swift test" 'DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" make test'
}

add_staging_smoke_commands() {
  add_cmd_once "staging smoke config verification" "scripts/verify_staging_smoke.sh"
  add_note_once coverage "MOMO-007 local/staging smoke: prod compose config, Caddyfile structure, Centrifugo Redis config, secret-template guard, and SOPS/pgBackRest checklist."
  add_note_once not_covered "Real staging VPS URL/TLS, pgBackRest stanza/check/full backup/PITR restore rehearsal, and external hermes staging connectivity remain runtime-unverified without host secrets/infrastructure."
}

add_runtime_bootstrap_commands() {
  if [ "$BOOTSTRAP_ADDED" -eq 1 ]; then
    return 0
  fi
  add_cmd "docker compose up" "make up"
  add_cmd "migrate first pass" "make migrate"
  add_cmd "migrate idempotency pass" "make migrate"
  BOOTSTRAP_ADDED=1
}

add_runtime_db_commands() {
  add_runtime_bootstrap_commands
  add_cmd "RLS runtime verification" "scripts/verify_rls.sh"
  add_cmd "Workspace roster runtime verification" "scripts/verify_roster.sh"
  add_cmd "Workspace channel list runtime verification" "scripts/verify_channel_list.sh"
  add_cmd "Public join runtime verification" "scripts/verify_join.sh"
  add_cmd "Platform admin read-only runtime verification" "scripts/verify_platform_admin.sh"
  add_cmd "Approval decision endpoint runtime verification" "scripts/verify_approval_decision.sh"
  add_note_once coverage "Docker compose, migration idempotency, RLS tenant isolation via scripts/verify_rls.sh, workspace roster tenant/member guard via scripts/verify_roster.sh, workspace channel list active membership/cross-workspace guard via scripts/verify_channel_list.sh, public /v1/join invite self-signup via scripts/verify_join.sh, platform-admin read-only cross-tenant inspection via scripts/verify_platform_admin.sh, and approval decision endpoint approve/reject/idempotency/expiry/membership via scripts/verify_approval_decision.sh."
}

add_runtime_relay_commands() {
  add_runtime_bootstrap_commands
  if [ -x scripts/verify_relay.sh ]; then
    add_cmd "OutboxRelay runtime verification" "scripts/verify_relay.sh"
    add_note_once coverage "OutboxRelay runtime verification via scripts/verify_relay.sh: Docker compose/migrate, server REST send, outbox pending, relay claim, Centrifugo history, outbox done, and version=message.seq evidence."
  else
    add_cmd "OutboxRelay runtime verification" "echo 'scripts/verify_relay.sh is not present; runtime-relay cannot produce PASS evidence until relay automation exists.'; exit 1"
    add_note_once not_covered "Full OutboxRelay -> Centrifugo publish/history roundtrip is not automated yet; MOMO-002 manual path remains required when relay/realtime changes."
  fi
}

add_runtime_host_api_cleanup_command() {
  local label="${1:-Runtime host MomoServer cleanup}"
  add_cmd "$label" 'env_file="${ENV_FILE:-}"; if [ -z "$env_file" ]; then for f in .env.worktree .env infra/.env.example; do if [ -f "$f" ]; then env_file="$f"; break; fi; done; fi; if [ -n "$env_file" ] && [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi; port="${PORT:-8080}"; if ! command -v lsof >/dev/null 2>&1; then echo "lsof unavailable; skip host MomoServer cleanup"; exit 0; fi; pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"; if [ -z "$pids" ]; then echo "no listener on port $port"; exit 0; fi; killed=""; for pid in $pids; do cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"; case "$cmd" in *MomoServer*) echo "stopping MomoServer listener pid=$pid port=$port"; kill "$pid" 2>/dev/null || true; killed="$killed $pid" ;; *) echo "leaving non-MomoServer listener pid=$pid port=$port command=$cmd" ;; esac; done; sleep 1; for pid in $killed; do if kill -0 "$pid" 2>/dev/null; then cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"; case "$cmd" in *MomoServer*) echo "force stopping MomoServer listener pid=$pid port=$port"; kill -9 "$pid" 2>/dev/null || true ;; esac; fi; done'
}

add_runtime_live_commands() {
  add_runtime_bootstrap_commands
  add_cmd "Realtime WebSocket live verification" "scripts/verify_realtime_live.sh"
  add_note_once coverage "Realtime WebSocket live subscribe verification via scripts/verify_realtime_live.sh: Docker compose PostgreSQL/Centrifugo bootstrap, host MomoServer/OutboxRelay, compose-network api proxy for Centrifugo subscribe callbacks, demo login, /v1/auth/realtime-token, Centrifugo connect/subscribe, REST message send, live message.new publication, payload.message.seq evidence, and invalid connection token rejection."
  add_note_once not_covered "This profile verifies the repo-local WebSocket protocol helper, not the future SwiftCentrifuge macOS adapter UX or APNs."
}

add_runtime_agent_commands() {
  add_runtime_bootstrap_commands
  add_cmd "AgentWorker runtime verification" "scripts/verify_agent_worker.sh"
  add_cmd "Agent live channel verification" "scripts/verify_agent_live_channel.sh"
  add_note_once coverage "REST @agent mention routing via scripts/verify_agent_worker.sh: same-channel @김인턴 POST /messages creates agent_run/agent_job, duplicate client_msg_id dedupes the job, non-channel agent mention records audit no-op, mock SSE returns agent.partial/tool_call progress on agent:, and OutboxRelay publishes final channel message.new."
  add_note_once coverage "AgentWorker OpenAI-compatible SSE mock, D live tool_call progress with bounded args, cost reserve/reconcile, MomoServer cost-snapshots projection endpoint, and approved deterministic resume_approval -> final tool_result/message.new/audit/job-done via scripts/verify_agent_worker.sh."
  add_note_once coverage "Agent live channel boundary via scripts/verify_agent_live_channel.sh: authorized member receives live agent.status/agent.partial on agent:ws<workspace>.<agent>, invalid token/same-workspace no-shared-channel member/other-workspace token are denied, and client direct publish is rejected."
}

add_macos_ui_commands() {
  add_cmd "macOS real-backend REST/UI smoke" "scripts/verify_macos_real_backend_ui.sh"
  if [ "${LOCAL_GATE_LAUNCH_UI:-0}" = "1" ]; then
    add_note_once coverage "MomoMacDevApp launched against local Docker + host MomoServer with MOMO_SERVER_BASE_URL/MOMO_WORKSPACE_ID/MOMO_CHANNEL_ID env; REST login/channel list/history/send plus approval/cost fixture, process/window smoke, log capture, and termination are automated."
  else
    add_note_once coverage "MomoMac real-backend REST smoke via scripts/verify_macos_real_backend_ui.sh: Docker compose/migrate, MomoServer, REST login/channel list/history/send, and approval/cost structured history evidence."
    add_note_once not_covered "MomoMacDevApp process/window launch is skipped by default; rerun with LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui for GUI process/window evidence."
  fi
}

add_m3_dbc_commands() {
  add_static_commands
  add_swift_commands
  add_runtime_bootstrap_commands
  add_cmd "M3 D/B cost projection and tool-call runtime evidence" "scripts/verify_agent_worker.sh"
  add_runtime_host_api_cleanup_command "Cleanup host MomoServer after D/B verifier"
  add_cmd "M3 C approval decision runtime evidence" "scripts/verify_approval_decision.sh"
  add_runtime_host_api_cleanup_command "Cleanup host MomoServer after C verifier"
  add_macos_ui_commands
  add_note_once coverage "M3 D evidence: repo-local OpenAI-compatible SSE mock emits agent.partial text plus tool_call_name/tool_call_args progress; AgentWorker reconciles to final tool_result/message.new with outbox version equal to message.seq."
  add_note_once coverage "M3 B evidence: AgentWorker reserve/reconcile writes usage_ledger and budget_window, then MomoServer /cost-snapshots exposes the server-owned CostSnapshot projection consumed by MomoMac."
  add_note_once coverage "M3 C evidence: /approvals pending projection, approve/reject, client_decision_id idempotency, conflict, expired click, channel membership guard, audit_log, and resume agent_job durable effects are verified."
  add_note_once coverage "M3 macOS evidence: real-backend smoke verifies REST login/channel list/history/send plus approval/cost structured props; LOCAL_GATE_LAUNCH_UI=1 upgrades this profile to require MomoMacDevApp process/window/log evidence."
  add_note_once coverage "MOMO-020 close-readiness: when this profile passes in the PR evidence, the old staging/Hermes wording can be closed under the MOMO-204 local-gate reinterpretation after review/merge; worker does not close #12."
  add_note_once not_covered "External Hermes/staging provider side effects, M4 Xcode packaging/signing/notary, iOS/APNs, and agent: namespace production presence remain out of scope for MOMO-204."
}

case "$PROFILE" in
  docs)
    add_static_commands
    add_note_once coverage "Static docs/CI validation only."
    add_note_once not_covered "Swift build/test and runtime profiles not run for docs profile."
    ;;
  swift)
    add_static_commands
    add_swift_commands
    add_note_once coverage "Static checks plus all Swift package build/test."
    add_note_once not_covered "Docker runtime profiles not run for swift profile."
    ;;
  staging-smoke)
    add_static_commands
    add_staging_smoke_commands
    ;;
  runtime-db)
    add_static_commands
    add_swift_commands
    add_runtime_db_commands
    ;;
  runtime-relay)
    add_static_commands
    add_swift_commands
    add_runtime_relay_commands
    ;;
  runtime-live)
    add_static_commands
    add_swift_commands
    add_runtime_live_commands
    ;;
  runtime-agent)
    add_static_commands
    add_swift_commands
    add_runtime_agent_commands
    ;;
  macos-ui)
    add_static_commands
    add_swift_commands
    add_macos_ui_commands
    ;;
  m3-dbc)
    add_m3_dbc_commands
    ;;
  all)
    add_static_commands
    add_swift_commands
    add_staging_smoke_commands
    add_runtime_db_commands
    add_runtime_host_api_cleanup_command "Cleanup host MomoServer after runtime DB verifiers"
    add_runtime_relay_commands
    add_runtime_host_api_cleanup_command "Cleanup host MomoServer after relay verifier"
    add_runtime_agent_commands
    add_runtime_host_api_cleanup_command "Cleanup host MomoServer after agent verifier"
    add_macos_ui_commands
    add_note_once not_covered "Realtime WebSocket live subscribe is isolated in scripts/local_gate.sh --profile runtime-live because it starts host API/relay processes plus a compose-network api proxy for Centrifugo subscribe callbacks."
    ;;
esac

if [ "${#CMD_STRINGS[@]}" -eq 0 ]; then
  echo "no commands planned for profile: $PROFILE" >&2
  exit 1
fi

{
  echo "momo local gate"
  echo "profile: $PROFILE"
  echo "run_id: $RUN_ID"
  echo "repo: $REPO_ROOT"
  echo "started_at_utc: $STAMP"
  echo "log: $LOG_FILE"
  echo "evidence: $EVIDENCE_FILE"
  echo
  echo "planned commands:"
  local_i=0
  while [ "$local_i" -lt "${#CMD_STRINGS[@]}" ]; do
    printf '  %02d. %s: %s\n' "$((local_i + 1))" "${CMD_LABELS[$local_i]}" "${CMD_STRINGS[$local_i]}"
    local_i=$((local_i + 1))
  done
  echo
} | tee "$LOG_FILE"

FAILED_INDEX=-1
FAILED_CODE=0

run_cmd() {
  local index="$1"
  local label="${CMD_LABELS[$index]}"
  local command="${CMD_STRINGS[$index]}"
  local code

  {
    echo
    echo "==> [$((index + 1))/${#CMD_STRINGS[@]}] $label"
    echo "\$ $command"
  } | tee -a "$LOG_FILE"

  set +e
  bash -lc "$command" 2>&1 | tee -a "$LOG_FILE"
  code=${PIPESTATUS[0]}
  set +e

  if [ "$code" -eq 0 ]; then
    CMD_STATUS[index]="pass"
    echo "PASS: $label" | tee -a "$LOG_FILE"
  else
    CMD_STATUS[index]="fail"
    FAILED_INDEX="$index"
    FAILED_CODE="$code"
    echo "FAIL: $label (exit $code)" | tee -a "$LOG_FILE"
    return "$code"
  fi
}

idx=0
while [ "$idx" -lt "${#CMD_STRINGS[@]}" ]; do
  if ! run_cmd "$idx"; then
    break
  fi
  idx=$((idx + 1))
done

END_STAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git branch --show-current 2>/dev/null || echo detached)"
DIRTY_COUNT="$(git status --porcelain 2>/dev/null | wc -l | tr -d '[:space:]')"
MACHINE="$(hostname 2>/dev/null || echo unknown)"
OS_INFO="$(sw_vers -productVersion 2>/dev/null || uname -sr)"
SWIFT_INFO="$(swift --version 2>/dev/null | head -n 1 || echo 'swift unavailable')"
XCODE_INFO="$(xcodebuild -version 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//' || echo 'xcodebuild unavailable')"
DOCKER_INFO="$(docker --version 2>/dev/null || echo 'docker unavailable')"
if command -v psql >/dev/null 2>&1; then
  PSQL_INFO="$(psql --version 2>/dev/null || echo 'psql unavailable')"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_INFO="$(/opt/homebrew/opt/libpq/bin/psql --version 2>/dev/null || echo 'psql unavailable')"
else
  PSQL_INFO="psql unavailable"
fi

if [ "$FAILED_INDEX" -eq -1 ]; then
  RESULT="PASS"
else
  RESULT="FAIL"
fi

write_evidence() {
  local out="$1"
  {
    echo "## Local Gate"
    echo "- Result: $RESULT"
    echo "- Profile: \`$PROFILE\`"
    echo "- Started: $START_ISO"
    echo "- Finished: $END_STAMP"
    echo "- Run ID: \`$RUN_ID\`"
    echo "- Commit: \`$COMMIT\`"
    echo "- Branch: \`$BRANCH\`"
    echo "- Worktree: \`$REPO_ROOT\`"
    echo "- Dirty files: \`$DIRTY_COUNT\`"
    echo "- Evidence markdown: \`$EVIDENCE_FILE\`"
    echo "- Evidence log: \`$LOG_FILE\`"
    echo "- Machine/toolchain:"
    echo "  - Host: \`$MACHINE\`"
    echo "  - OS: \`$OS_INFO\`"
    echo "  - Swift: \`$SWIFT_INFO\`"
    echo "  - Xcode: \`$XCODE_INFO\`"
    echo "  - Docker: \`$DOCKER_INFO\`"
    echo "  - psql: \`$PSQL_INFO\`"
    echo "- Commands:"
    local i=0
    while [ "$i" -lt "${#CMD_STRINGS[@]}" ]; do
      case "${CMD_STATUS[$i]}" in
        pass) marker="[x]" ;;
        fail) marker="[ ]" ;;
        *) marker="[ ]" ;;
      esac
      echo "  - $marker \`${CMD_STRINGS[$i]}\`"
      i=$((i + 1))
    done
    echo "- Runtime coverage:"
    if [ "${#RUNTIME_COVERAGE[@]}" -eq 0 ]; then
      echo "  - None declared."
    else
      for note in "${RUNTIME_COVERAGE[@]}"; do
        echo "  - $note"
      done
    fi
    echo "- Not covered:"
    if [ "${#NOT_COVERED[@]}" -eq 0 ]; then
      echo "  - None."
    else
      for note in "${NOT_COVERED[@]}"; do
        echo "  - $note"
      done
    fi
    if [ "$FAILED_INDEX" -ne -1 ]; then
      echo "- Failed command: \`${CMD_STRINGS[$FAILED_INDEX]}\`"
      echo "- Failed exit code: \`$FAILED_CODE\`"
    fi
  } > "$out"
}

write_evidence "$EVIDENCE_FILE"

{
  echo
  echo "==> evidence markdown"
  cat "$EVIDENCE_FILE"
} | tee -a "$LOG_FILE"

echo
echo "Evidence file: $EVIDENCE_FILE"
echo "Log file: $LOG_FILE"

if [ "$FAILED_INDEX" -ne -1 ]; then
  exit "$FAILED_CODE"
fi

exit 0
