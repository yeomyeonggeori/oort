#!/usr/bin/env bash
# Local PR gate runner for the GitHub Actions disabled/manual-only period.
# shellcheck disable=SC2016
set -u -o pipefail

PROFILE=""
PROFILE_EXPLICIT=0
AUTO_MODE=0
OUT_DIR="${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}"

usage() {
  cat <<'EOF'
Usage: scripts/local_gate.sh [--auto] [--profile docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|macos-ui|m3-dbc|all]

Options:
  --auto              Pick the profile from changed paths (MOMO-316):
                      git diff --name-only <base>...HEAD plus uncommitted changes,
                      mapped conservatively (ambiguous paths widen to `all`, never
                      narrow). An explicit --profile always wins over --auto; the
                      suggested profile and per-path reasons are still recorded in
                      the evidence markdown.
  --profile PROFILE   Gate profile to run. Default: docs (when --auto is not given)
  --output-dir DIR    Directory for log/evidence files. Default: $TMPDIR/momo-local-gate
  -h, --help          Show this help.

Environment:
  LOCAL_GATE_OUT_DIR      Override evidence output directory.
  LOCAL_GATE_LAUNCH_UI=1  In macos-ui/local-alpha/all, launch MomoMacDevApp instead of smoke only.
                          Required by internal-alpha.
  LOCAL_GATE_ALLOW_DIRTY=1 Allow pre-commit exploratory runs with dirty files.
  LOCAL_GATE_BASE_REF      Defaults to origin/main for committed PR diff checks and
                          --auto profile selection (falls back to local main).
  DEVELOPER_DIR           Defaults to /Applications/Xcode.app/Contents/Developer for Swift gates.
  ENV_FILE                Optional runtime env file consumed by Makefile/runtime scripts.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      PROFILE_EXPLICIT=1
      shift 2
      ;;
    --auto)
      AUTO_MODE=1
      shift
      ;;
    --output-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|macos-ui|m3-dbc|all)
      PROFILE="$1"
      PROFILE_EXPLICIT=1
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$PROFILE_EXPLICIT" -eq 0 ] && [ "$AUTO_MODE" -eq 0 ]; then
  PROFILE="docs"
fi

if [ "$PROFILE_EXPLICIT" -eq 1 ]; then
  case "$PROFILE" in
    docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|macos-ui|m3-dbc|all) ;;
    *)
      echo "unknown profile: $PROFILE" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "scripts/local_gate.sh must run inside a git repository" >&2
  exit 1
fi
cd "$REPO_ROOT" || exit 1

# =============================================================================
# --auto profile selection (MOMO-316)
#
# 원칙: 보수적 경로 매핑. 모호하면 항상 더 넓은 커버리지(all)로 fail-closed —
# 좁게 줄이는 방향의 추측 금지. --profile 명시가 항상 우선(동시 지정 시
# --profile 승리, 로그/evidence로 알림). 선택된 프로파일과 per-path 이유는
# evidence markdown의 "Auto profile selection" 섹션에 기록된다.
# (bash 3.2 호환: 연관배열 없이 unit 플래그 + case 매핑만 사용)
# =============================================================================
AUTO_SUGGESTED=""
AUTO_BASE_DESC=""
declare -a AUTO_REASONS=()
AUTO_NEED_MACOS=0
AUTO_NEED_DB=0
AUTO_NEED_RELAY=0
AUTO_NEED_AGENT=0
AUTO_NEED_LIVE=0
AUTO_NEED_STAGING=0
AUTO_NEED_HOSTRT=0
AUTO_NEED_DIAG=0
AUTO_NEED_ALL=0

auto_classify_script() {
  # scripts/** → docs + 해당 스크립트가 속한 runtime 프로파일. 모호하면 all.
  case "$1" in
    scripts/migrate.sh|scripts/verify_rls.sh|scripts/verify_roster.sh|scripts/verify_channel_list.sh|scripts/verify_channel_management.sh|scripts/verify_join.sh|scripts/verify_platform_admin.sh|scripts/verify_approval_decision.sh|scripts/verify_auth_hardening.sh)
      AUTO_NEED_DB=1; AUTO_REASONS+=("$1 -> runtime-db") ;;
    scripts/verify_relay.sh)
      AUTO_NEED_RELAY=1; AUTO_REASONS+=("$1 -> runtime-relay") ;;
    scripts/verify_realtime_live.sh)
      AUTO_NEED_LIVE=1; AUTO_REASONS+=("$1 -> runtime-live") ;;
    scripts/ensure_runtime_env.sh|scripts/verify_agent_worker.sh|scripts/verify_agent_live_channel.sh|scripts/verify_local_hermes_bridge.sh|scripts/verify_hermes_gateway_adapter.sh|scripts/verify_local_hermes_credentialed_smoke.sh|scripts/verify_external_agent_provider.sh|scripts/mock_hermes.py)
      AUTO_NEED_AGENT=1; AUTO_REASONS+=("$1 -> runtime-agent") ;;
    scripts/verify_staging_smoke.sh|scripts/verify_internal_hosting_smoke.sh|scripts/prod_env_preflight.sh|scripts/aws_internal_alpha_preflight.sh)
      AUTO_NEED_STAGING=1; AUTO_REASONS+=("$1 -> staging-smoke") ;;
    scripts/verify_internal_host_runtime.sh|scripts/verify_backup_restore_rehearsal.sh)
      AUTO_NEED_HOSTRT=1; AUTO_REASONS+=("$1 -> host-runtime") ;;
    scripts/verify_macos_real_backend_ui.sh|scripts/macos_dev_run.sh)
      AUTO_NEED_MACOS=1; AUTO_REASONS+=("$1 -> macos-ui") ;;
    scripts/collect_diagnostics.sh)
      AUTO_NEED_DIAG=1; AUTO_REASONS+=("$1 -> diagnostics") ;;
    *)
      # local_gate.sh 자신, goal_*, github/* 등 게이트 인프라 스크립트는
      # 어느 runtime 프로파일에 속하는지 모호 → 좁히지 않고 all로 넓힌다.
      AUTO_NEED_ALL=1; AUTO_REASONS+=("$1 -> all (ambiguous script; widen, do not narrow)") ;;
  esac
}

auto_classify_path() {
  case "$1" in
    docs/*|research/*|legal/*|*.md)
      AUTO_REASONS+=("$1 -> docs") ;;
    clients/*)
      AUTO_NEED_MACOS=1; AUTO_REASONS+=("$1 -> swift+macos-ui") ;;
    server/Migrations/*)
      AUTO_NEED_DB=1; AUTO_REASONS+=("$1 -> runtime-db") ;;
    server/*)
      # MomoServer 소스는 outbox/realtime token/agent mention 등 relay·live·agent
      # 표면을 포함한다 — runtime-db 단독은 좁힘(리뷰 high). all로 확대하고,
      # 결합 프로파일 도입 시 재조정한다.
      AUTO_NEED_ALL=1; AUTO_REASONS+=("$1 -> all (server touches db+relay+live+agent surfaces; widen)") ;;
    relay/*)
      AUTO_NEED_RELAY=1; AUTO_REASONS+=("$1 -> swift+runtime-relay") ;;
    workers/*)
      AUTO_NEED_AGENT=1; AUTO_REASONS+=("$1 -> swift+runtime-agent") ;;
    adapters/*)
      AUTO_NEED_AGENT=1; AUTO_REASONS+=("$1 -> runtime-agent (hermes adapter surface)") ;;
    infra/prod/*)
      AUTO_NEED_STAGING=1; AUTO_REASONS+=("$1 -> staging-smoke") ;;
    infra/*)
      # 로컬 런타임 정본(compose/centrifugo.json/e2e roles). staging-smoke는 이
      # 파일들을 기동하지 않으므로(리뷰 blocker: silent coverage loss) all로 확대.
      AUTO_NEED_ALL=1; AUTO_REASONS+=("$1 -> all (local runtime compose surface; widen, do not narrow)") ;;
    scripts/*)
      auto_classify_script "$1" ;;
    *)
      # Makefile, .github, .conductor 등 미매핑 경로 → 넓게(all).
      AUTO_NEED_ALL=1; AUTO_REASONS+=("$1 -> all (unmapped path; widen, do not narrow)") ;;
  esac
}

auto_select_profile() {
  local base="${LOCAL_GATE_BASE_REF:-origin/main}"
  if git rev-parse --verify "$base" >/dev/null 2>&1; then
    AUTO_BASE_DESC="$base (three-dot merge-base diff)"
  elif git rev-parse --verify main >/dev/null 2>&1; then
    base="main"
    AUTO_BASE_DESC="main (origin/main unavailable; three-dot merge-base diff)"
  else
    base=""
    AUTO_BASE_DESC="none (no origin/main or main; uncommitted changes only)"
  fi

  local committed=""
  if [ -n "$base" ]; then
    if ! committed="$(git diff --name-only "$base"...HEAD 2>/dev/null)"; then
      # merge-base 부재(unrelated history 등)로 diff 실패 — committed 변경을
      # 놓친 채 dirty-only로 좁히면 fail-open(리뷰 high). all로 확대한다.
      AUTO_NEED_ALL=1
      AUTO_REASONS+=("diff vs $base failed (no merge-base?); widen to all")
    fi
  else
    # 베이스를 못 잡으면(shallow clone 등) committed 변경 전체를 볼 수 없다 —
    # dirty-only 판정으로 좁히지 않고 all로 확대한다(리뷰 high).
    AUTO_NEED_ALL=1
    AUTO_REASONS+=("no diff base available; widen to all (do not narrow to dirty-only)")
  fi
  # LOCAL_GATE_ALLOW_DIRTY=1 pre-commit 탐색 실행도 커버하도록
  # staged/unstaged/untracked 변경 경로를 합산한다(rename은 새 경로 기준).
  local dirty
  dirty="$(git status --porcelain 2>/dev/null | sed -e 's/^...//' -e 's/^.* -> //' -e 's/^"//' -e 's/"$//')"
  local files
  files="$(printf '%s\n%s\n' "$committed" "$dirty" | sed '/^$/d' | LANG=C sort -u)"

  if [ -z "$files" ]; then
    if [ "$AUTO_NEED_ALL" -eq 1 ]; then
      AUTO_SUGGESTED="all"
    else
      AUTO_SUGGESTED="docs"
      AUTO_REASONS+=("no changed paths vs ${base:-<none>}; defaulting to docs")
    fi
    return 0
  fi

  # 변경 경로에 glob 문자(*?[)가 있어도 repo root 기준으로 확장되지 않도록
  # 루프 동안 pathname expansion을 끈다(리뷰 high; 공백 경로는 여전히 미지원).
  local f
  set -f
  for f in $files; do
    auto_classify_path "$f"
  done
  set +f

  local units=$((AUTO_NEED_MACOS + AUTO_NEED_DB + AUTO_NEED_RELAY + AUTO_NEED_AGENT + AUTO_NEED_LIVE + AUTO_NEED_STAGING + AUTO_NEED_HOSTRT + AUTO_NEED_DIAG))
  if [ "$AUTO_NEED_ALL" -eq 1 ] || [ "$units" -gt 1 ]; then
    AUTO_SUGGESTED="all"
    if [ "$AUTO_NEED_LIVE" -eq 1 ]; then
      AUTO_REASONS+=("note: profile 'all' does not include runtime-live; run --profile runtime-live separately")
    fi
    if [ "$AUTO_NEED_DIAG" -eq 1 ]; then
      AUTO_REASONS+=("note: profile 'all' does not include the diagnostics smoke; run --profile diagnostics separately")
    fi
  elif [ "$AUTO_NEED_MACOS" -eq 1 ]; then
    AUTO_SUGGESTED="macos-ui"
  elif [ "$AUTO_NEED_DB" -eq 1 ]; then
    AUTO_SUGGESTED="runtime-db"
  elif [ "$AUTO_NEED_RELAY" -eq 1 ]; then
    AUTO_SUGGESTED="runtime-relay"
  elif [ "$AUTO_NEED_AGENT" -eq 1 ]; then
    AUTO_SUGGESTED="runtime-agent"
  elif [ "$AUTO_NEED_LIVE" -eq 1 ]; then
    AUTO_SUGGESTED="runtime-live"
  elif [ "$AUTO_NEED_STAGING" -eq 1 ]; then
    AUTO_SUGGESTED="staging-smoke"
  elif [ "$AUTO_NEED_HOSTRT" -eq 1 ]; then
    AUTO_SUGGESTED="host-runtime"
  elif [ "$AUTO_NEED_DIAG" -eq 1 ]; then
    AUTO_SUGGESTED="diagnostics"
  else
    AUTO_SUGGESTED="docs"
  fi
}

if [ "$AUTO_MODE" -eq 1 ]; then
  auto_select_profile
  if [ "$PROFILE_EXPLICIT" -eq 1 ]; then
    echo "local gate: --profile $PROFILE overrides --auto (auto suggested: $AUTO_SUGGESTED; base: $AUTO_BASE_DESC)"
  else
    PROFILE="$AUTO_SUGGESTED"
    echo "local gate: --auto selected profile: $PROFILE (base: $AUTO_BASE_DESC)"
  fi
  for auto_note in "${AUTO_REASONS[@]:-}"; do
    [ -n "$auto_note" ] && echo "  auto: $auto_note"
  done
fi

case "$PROFILE" in
  docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|macos-ui|m3-dbc|all) ;;
  *)
    echo "unknown profile: $PROFILE" >&2
    usage >&2
    exit 2
    ;;
esac

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
export LOCAL_GATE_OUTPUT_DIR="$OUT_DIR"
export LOCAL_GATE_RUN_ID="$RUN_ID"
export LOCAL_GATE_LOCAL_ALPHA_DIR="$OUT_DIR/local-alpha-${RUN_ID}"
export LOCAL_GATE_INTERNAL_ALPHA_DIR="$OUT_DIR/internal-alpha-${RUN_ID}"

declare -a CMD_LABELS=()
declare -a CMD_STRINGS=()
declare -a CMD_STATUS=()
declare -a FINAL_CLEANUP_LABELS=()
declare -a FINAL_CLEANUP_STRINGS=()
declare -a FINAL_CLEANUP_STATUS=()
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

add_final_cleanup_cmd() {
  local label="$1"
  local command="$2"
  FINAL_CLEANUP_LABELS+=("$label")
  FINAL_CLEANUP_STRINGS+=("$command")
  FINAL_CLEANUP_STATUS+=("not-run")
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
  add_cmd_once "AWS internal alpha topology preflight" 'out="${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/aws-internal-alpha-preflight"; scripts/aws_internal_alpha_preflight.sh --env-file infra/prod/aws-internal-alpha.env.example --mode recommended --evidence-dir "$out"'
  add_cmd_once "json syntax" 'jq empty .github/labels.json infra/centrifugo.json infra/prod/centrifugo.prod.json && find research/11-agent-runtime/fixtures -name "*.json" -print0 | xargs -0 jq empty'
  add_cmd_once "shell syntax" 'for f in .conductor/setup.sh scripts/momo scripts/local_gate.sh scripts/runtime_process_guard.sh scripts/ensure_runtime_env.sh scripts/local_soak_monitor.sh scripts/collect_diagnostics.sh scripts/compose_janitor.sh scripts/macos_dev_run.sh scripts/local_alpha_runner.sh scripts/goal_claim.sh scripts/goal_status.sh scripts/goal_release.sh scripts/github_bootstrap.sh scripts/github/bootstrap.sh scripts/migrate.sh scripts/prod_env_preflight.sh scripts/aws_internal_alpha_preflight.sh scripts/verify_design_preflight.sh scripts/verify_rls.sh scripts/verify_roster.sh scripts/verify_channel_list.sh scripts/verify_channel_management.sh scripts/verify_join.sh scripts/verify_platform_admin.sh scripts/verify_approval_decision.sh scripts/verify_auth_hardening.sh scripts/verify_relay.sh scripts/verify_realtime_live.sh scripts/verify_agent_worker.sh scripts/verify_agent_context.sh scripts/verify_agent_live_channel.sh scripts/verify_external_agent_provider.sh scripts/verify_local_hermes_bridge.sh scripts/verify_hermes_gateway_adapter.sh scripts/verify_local_hermes_credentialed_smoke.sh scripts/verify_staging_smoke.sh scripts/verify_internal_hosting_smoke.sh scripts/verify_internal_host_runtime.sh scripts/verify_backup_restore_rehearsal.sh scripts/verify_macos_real_backend_ui.sh infra/prod/docker/internal-smoke-migrate.sh; do [ -e "$f" ] || { echo "missing shell script: $f"; exit 1; }; bash -n "$f"; done'
  add_cmd_once "python syntax" 'PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 -m py_compile adapters/hermes/momo_adapter.py adapters/hermes/adapter.py scripts/mock_hermes.py adapters/hermes/tests/test_momo_adapter_contract.py adapters/hermes/tests/smoke_momo_adapter.py; PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/hermes/tests/test_momo_adapter_contract.py; PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/hermes/tests/smoke_momo_adapter.py'
}

add_runtime_env_guard_command() {
  add_cmd_once "runtime env drift guard" "bash scripts/ensure_runtime_env.sh"
  add_note_once coverage "MOMO-320 runtime env drift guard: generated .env.worktree files missing CENT_TOKEN_HMAC/CENT_API_KEY/CENT_PROXY_SECRET/JWT_HMAC or port/runtime keys are regenerated via .conductor/setup.sh before Docker/Centrifugo gates run; custom ENV_FILE values fail clear without printing secrets."
}

add_diagnostics_commands() {
  add_cmd_once "diagnostics redaction smoke" "scripts/collect_diagnostics.sh --smoke"
  add_note_once coverage "MOMO-224 diagnostics smoke: redaction removes database passwords, API keys, bearer/JWT-shaped tokens, accessToken JSON fields, and password fields before evidence is written."
  add_note_once coverage "MOMO-224 diagnostics collector is best-effort and can emit a directory/tar bundle with markdown summary for server/relay/worker/Centrifugo/macOS/local-gate evidence when those logs exist."
  add_note_once not_covered "The diagnostics smoke does not require live Docker services or a running macOS app; it verifies bundle tooling/redaction shape only."
}

add_swift_commands() {
  # MOMO-318: mechanical design pre-flight (SKILL momo-design-taste §5) as a ratchet
  # gate. Runs before the multi-minute build so a new raw-color/fixed-size/em-dash
  # violation fails fast. Pre-existing violations are baselined; only regressions FAIL.
  add_cmd_once "design pre-flight (ratchet)" 'scripts/verify_design_preflight.sh'
  add_cmd_once "swift build" 'DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" make build'
  add_cmd_once "swift test" 'DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" make test'
  add_note_once coverage "MOMO-318 design pre-flight: raw Color(red:)/Font.custom/.font(.system(size:))/user-visible em-dash counts are held at or below scripts/design_preflight_baseline.txt; any new violation fails the swift gate."
}

add_staging_smoke_commands() {
  add_cmd_once "staging smoke config verification" "scripts/verify_staging_smoke.sh"
  add_cmd_once "internal single-node hosting smoke verification" "scripts/verify_internal_hosting_smoke.sh"
  add_note_once coverage "MOMO-007 local/staging smoke: prod compose config, Caddyfile structure, Centrifugo Redis config, secret-template guard, and SOPS/pgBackRest checklist."
  add_note_once coverage "MOMO-229 public host preflight: tracked staging placeholder env fails fast, synthetic public/staging env shape passes, and redacted prod-env-preflight-staging.md/json evidence covers DNS/TLS env, pinned registry image tags, SOPS/age or host-local secret source, named DB/Redis volumes, and pgBackRest WAL/full-backup/PITR required env."
  add_note_once coverage "MOMO-216 internal single-node hosting smoke: prod compose + internal smoke override config, env template guard, Caddy/TLS static wiring, Centrifugo Redis engine, explicit migration path, API health route wiring, relay/worker enablement, and backup/restore placeholder boundary."
  add_note_once not_covered "Real staging VPS URL/TLS, public TLS/DNS, registry image pull/run, SOPS production secret injection, pgBackRest stanza/check/full backup/PITR restore rehearsal, and external hermes staging connectivity remain runtime-unverified without host secrets/infrastructure."
}

add_host_runtime_commands() {
  add_cmd_once "internal host-runtime smoke verification" "scripts/verify_internal_host_runtime.sh"
  add_backup_commands
  add_note_once coverage "MOMO-220/MOMO-227 host-runtime smoke: local api/relay/worker/migrate/mock-Hermes images are built, prod compose + internal-smoke overlay boots from images without source bind mounts, migration one-shot plus idempotent re-run succeeds, Caddy/internal /health returns 200, /v1/agent-runtime/status reports internal-host-mock/mock without provider secret leakage, REST login/message send publishes through OutboxRelay to Centrifugo history, and @김인턴 mock Hermes agent roundtrip publishes agent progress plus final channel message.new."
  add_note_once not_covered "Public TLS/DNS, real registry pull, SOPS production secret injection, production pgBackRest stanza/check/full backup, WAL archive push, and time-target PITR restore remain runtime-unverified(public host)."
}

add_backup_commands() {
  add_cmd_once "backup restore rehearsal verification" "scripts/verify_backup_restore_rehearsal.sh"
  add_note_once coverage "MOMO-222 backup gate: repo-local PostgreSQL 18 source/restore containers verify pg_dump -> pg_restore into a separate non-primary target, compare marker count/checksum, and generate restore evidence markdown/json suitable for PR handoff."
  add_note_once not_covered "Actual production pgBackRest stanza-create/check/full backup, WAL archive push, object-store repository, SOPS secret decrypt, and time-target PITR restore rehearsal remain runtime-unverified(public host)."
}

add_runtime_bootstrap_commands() {
  if [ "$BOOTSTRAP_ADDED" -eq 1 ]; then
    return 0
  fi
  # MOMO-316: make up은 `compose up -d --wait`(postgres/centrifugo healthcheck
  # healthy까지 대기), make migrate는 단일 실행 안에서 apply→verify 2패스를 돌아
  # IDEMPOTENCY_OK 마커를 남긴다(기존 migrate 2회 호출과 동일 판정 경로 + 강한 단정).
  add_cmd "docker compose up (--wait healthy)" "make up"
  # env 파일/프로파일이 MIGRATE_IDEMPOTENCY_CHECK=0을 품고 있어도 게이트 단정이
  # 조용히 꺼지지 않도록(리뷰 high) env를 강제하고 IDEMPOTENCY_OK 마커를 직접 단정한다.
  add_cmd "migrate apply + idempotency verify (single run)" "out=\"\$(MIGRATE_IDEMPOTENCY_CHECK=1 make migrate 2>&1)\"; status=\$?; printf '%s\n' \"\$out\"; [ \$status -eq 0 ] && printf '%s\n' \"\$out\" | grep -F '[migrate] IDEMPOTENCY_OK second-pass applied=0'"
  BOOTSTRAP_ADDED=1
}

add_runtime_db_commands() {
  add_runtime_bootstrap_commands
  add_cmd "RLS runtime verification" "scripts/verify_rls.sh"
  add_cmd "Workspace roster runtime verification" "scripts/verify_roster.sh"
  add_cmd "Workspace channel list runtime verification" "scripts/verify_channel_list.sh"
  add_cmd "Workspace channel management runtime verification" "scripts/verify_channel_management.sh"
  add_cmd "Public join runtime verification" "scripts/verify_join.sh"
  add_cmd "Platform admin read-only runtime verification" "scripts/verify_platform_admin.sh"
  add_cmd "Approval decision endpoint runtime verification" "scripts/verify_approval_decision.sh"
  add_cmd "Auth hardening runtime verification (MOMO-300)" "scripts/verify_auth_hardening.sh"
  add_note_once coverage "Docker compose, migration idempotency, RLS tenant isolation via scripts/verify_rls.sh, workspace roster tenant/member guard via scripts/verify_roster.sh, workspace channel list active membership/cross-workspace guard via scripts/verify_channel_list.sh, channel create + human/agent member add/remove + message send management path via scripts/verify_channel_management.sh, public /v1/join invite self-signup via scripts/verify_join.sh, platform-admin read-only cross-tenant inspection via scripts/verify_platform_admin.sh, and approval decision endpoint approve/reject/idempotency/expiry/membership via scripts/verify_approval_decision.sh."
  add_note_once coverage "MOMO-300 auth hardening via scripts/verify_auth_hardening.sh: subscribe proxy shared-secret 401/allow boundary, session token persistence, logout revocation (revoked-token 401, idempotent + auth.logout audit), refresh rotation replay 401, and per-member rate limit 429 + Retry-After + rate_limit.exceeded audit."
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
  add_cmd "$label" 'env_file="${ENV_FILE:-}"; if [ -z "$env_file" ]; then for f in .env.worktree .env infra/.env.example; do if [ -f "$f" ]; then env_file="$f"; break; fi; done; fi; if [ -n "$env_file" ] && [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi; . scripts/runtime_process_guard.sh; momo_cleanup_port_listener "${PORT:-8080}" "host runtime API"'
}

add_runtime_agent_cleanup_command() {
  local label="${1:-Runtime agent host process cleanup}"
  add_cmd "$label" 'env_file="${ENV_FILE:-}"; if [ -z "$env_file" ]; then for f in .env.worktree .env infra/.env.example; do if [ -f "$f" ]; then env_file="$f"; break; fi; done; fi; if [ -n "$env_file" ] && [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi; export MOMO_RUNTIME_GUARD_REPO_ROOT="$(pwd)"; . scripts/runtime_process_guard.sh; base_port="${PORT:-8080}"; case "$base_port" in ""|*[!0-9]*) base_port=8080 ;; esac; base_hermes_port="${HERMES_PORT:-$((base_port + 3))}"; case "$base_hermes_port" in ""|*[!0-9]*) base_hermes_port=$((base_port + 3)) ;; esac; context_port="${AGENT_CONTEXT_PORT:-$((base_port + 4))}"; context_hermes_port="${AGENT_CONTEXT_HERMES_PORT:-$((base_port + 5))}"; bridge_api="${LOCAL_HERMES_BRIDGE_API_PORT:-$((base_port + 6))}"; momo_cleanup_repo_processes "runtime-agent gate"; momo_cleanup_runtime_ports "runtime-agent gate" "$base_port" "$base_hermes_port" "$context_port" "$context_hermes_port" "$bridge_api"'
}

add_runtime_agent_final_cleanup_command() {
  local label="${1:-Final runtime agent host process cleanup}"
  add_final_cleanup_cmd "$label" 'env_file="${ENV_FILE:-}"; if [ -z "$env_file" ]; then for f in .env.worktree .env infra/.env.example; do if [ -f "$f" ]; then env_file="$f"; break; fi; done; fi; if [ -n "$env_file" ] && [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi; export MOMO_RUNTIME_GUARD_REPO_ROOT="$(pwd)"; . scripts/runtime_process_guard.sh; base_port="${PORT:-8080}"; case "$base_port" in ""|*[!0-9]*) base_port=8080 ;; esac; base_hermes_port="${HERMES_PORT:-$((base_port + 3))}"; case "$base_hermes_port" in ""|*[!0-9]*) base_hermes_port=$((base_port + 3)) ;; esac; context_port="${AGENT_CONTEXT_PORT:-$((base_port + 4))}"; context_hermes_port="${AGENT_CONTEXT_HERMES_PORT:-$((base_port + 5))}"; bridge_api="${LOCAL_HERMES_BRIDGE_API_PORT:-$((base_port + 6))}"; momo_cleanup_repo_processes "runtime-agent gate final"; momo_cleanup_runtime_ports "runtime-agent gate final" "$base_port" "$base_hermes_port" "$context_port" "$context_hermes_port" "$bridge_api"'
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
  add_cmd "Agent context assembly verification" "scripts/verify_agent_context.sh"
  add_cmd "Agent live channel verification" "scripts/verify_agent_live_channel.sh"
  add_cmd "Local Hermes bridge verification" "scripts/verify_local_hermes_bridge.sh"
  add_cmd "Hermes gateway native platform verification" "scripts/verify_hermes_gateway_adapter.sh"
  add_note_once coverage "REST @agent mention routing via scripts/verify_agent_worker.sh: same-channel @hermes POST /messages creates agent_run/agent_job, duplicate client_msg_id dedupes the job, non-channel agent mention records audit no-op, mock SSE returns agent.partial/tool_call progress on agent:, and OutboxRelay publishes final channel message.new."
  add_note_once coverage "AgentWorker OpenAI-compatible SSE mock, D live tool_call progress with bounded args, cost reserve/reconcile, MomoServer cost-snapshots projection endpoint, and approved deterministic resume_approval -> final tool_result/message.new/audit/job-done via scripts/verify_agent_worker.sh."
  add_note_once coverage "MOMO-302 context assembly via scripts/verify_agent_context.sh: a @hermes mention carries the same-channel recent-N history into the hermes chat request (mock request dump), the agent's own prior turn maps to role=assistant while humans map to prefixed user, another channel's message is excluded (session boundary), and a small AGENT_CONTEXT_MAX_CHARS drops the oldest padding while always keeping the trigger."
  add_note_once coverage "MOMO-301 loop-guard trips via scripts/verify_agent_worker.sh: deterministic a2a_depth(depth=2 > MAX_DEPTH=1 env)/G3(step_count=max_steps)/G1(decoy running run)/G2(2 trailing agent text messages at MAX_CONSECUTIVE_AUTO=2 env) fixtures with zeroed payload seeds prove the Postgres SoT gates trip -> agent_run failed(loop_guard_tripped) + audit_log agent.guard.tripped + degraded system channel message + no usage_ledger spend."
  add_note_once coverage "Agent live channel boundary via scripts/verify_agent_live_channel.sh: authorized member receives live agent.status/agent.partial on agent:ws<workspace>.<agent>, invalid token/same-workspace no-shared-channel member/other-workspace token are denied, and client direct publish is rejected."
  add_note_once coverage "MOMO-256 Local Hermes Bridge: scripts/verify_local_hermes_bridge.sh runs the external-hermes verifier against a loopback OpenAI-compatible SSE provider and verifies @hermes -> agent_job -> AgentWorker -> durable channel message.new."
  add_note_once coverage "MOMO-325 Hermes gateway native platform path: scripts/verify_hermes_gateway_adapter.sh runs AGENT_GATEWAY_MODE=gateway, verifies @hermes -> agent_run + agent_job(method=gateway) + agent.job outbox broadcast, gateway callback secret fail-closed, gateway status/complete REST callbacks, durable final message, usage_ledger, audit_log, and agent_job done without direct Centrifugo publish from the adapter."
}

add_external_agent_provider_commands() {
  add_cmd "Local Hermes credentialed provider setup boundary" "scripts/verify_local_hermes_credentialed_smoke.sh"
  add_note_once coverage "MOMO-230/MOMO-236/MOMO-242/MOMO-256/MOMO-257 opt-in external provider gate: when AGENT_PROVIDER_MODE=external-hermes plus HERMES_BASE_URL/HERMES_API_KEY are configured, scripts/verify_local_hermes_credentialed_smoke.sh delegates to scripts/verify_external_agent_provider.sh, checks OpenAI-compatible SSE directly, boots local Postgres/Centrifugo + MomoServer/OutboxRelay/AgentWorker, verifies /v1/agent-runtime/status redacted availability with no degradedReason, proves Hermes is an active invited agent member of #agent-lab, and sends one @hermes roundtrip through the external runtime."
  add_note_once coverage "MOMO-234/MOMO-238 credential boundary: momo app/API/DB/local-gate evidence never receive Codex/OpenAI OAuth tokens or GPT/OpenAI API keys; known Codex/OpenAI credential env vars fail fast and credentials remain provider-owned inside the external runtime host."
  add_note_once coverage "MOMO-238 local-only loopback contract: AGENT_PROVIDER_MODE=external-hermes may use http://127.0.0.1:<port>/v1 or http://localhost:<port>/v1 only with MOMO_ENV=local and AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1; non-loopback HTTP and staging/prod/internal-host loopback fail fast."
  add_note_once coverage "MOMO-257 no-credential behavior: with default local/mock env and no out-of-repo provider env, the wrapper exits successfully with explicit NEEDS_USER_CREDENTIAL/runtime-unverified(external provider credentials) evidence and does not alter deterministic runtime-agent/internal-alpha gates."
  add_note_once not_covered "The default runtime-agent profile remains repo-local mock Hermes only; real provider side effects are covered only by the external-agent-provider opt-in profile."
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

add_internal_alpha_commands() {
  add_static_commands
  add_runtime_env_guard_command
  add_cmd "internal alpha UI launch guard" 'test "${LOCAL_GATE_LAUNCH_UI:-0}" = "1" || { echo "internal-alpha requires LOCAL_GATE_LAUNCH_UI=1 for MomoMacDevApp process/window evidence"; exit 1; }'
  add_cmd "internal alpha packet directory" 'mkdir -p "${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"'
  add_cmd "internal alpha host-runtime evidence" 'packet="${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"; out="$packet/host-runtime"; mkdir -p "$out"; LOCAL_GATE_OUT_DIR="$out" scripts/verify_internal_host_runtime.sh'
  add_cmd "internal alpha backup restore evidence" 'packet="${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"; out="$packet/backup-restore"; mkdir -p "$out"; BACKUP_REHEARSAL_OUT_DIR="$out" scripts/verify_backup_restore_rehearsal.sh'
  add_cmd "internal alpha macOS real-backend UI evidence" 'packet="${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"; out="$packet/macos-real-backend"; mkdir -p "$out"; MACOS_REAL_BACKEND_OUT_DIR="$out" scripts/verify_macos_real_backend_ui.sh'
  add_cmd "internal alpha diagnostics bundle" 'packet="${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"; out="$packet/diagnostics"; mkdir -p "$out"; scripts/collect_diagnostics.sh --output-dir "$out" --since 30m'
  add_note_once coverage "MOMO-225 internal alpha combined local gate: creates one PR-ready packet with host-runtime image boot/health/migrate/message/relay/mock Kim Intern evidence, backup restore rehearsal evidence, MomoMacDevApp real-backend process/window evidence, and a redacted diagnostics bundle path."
  add_note_once coverage "internal-alpha writes verifier artifacts under a run-specific packet directory below the local gate output directory: internal-alpha-<run-id>/{host-runtime,backup-restore,macos-real-backend,diagnostics}/, plus the top-level local-gate markdown/log."
  add_note_once not_covered "Public TLS/DNS, real registry pull, SOPS production secret injection, external Hermes staging connectivity, production pgBackRest stanza/check/full backup, WAL archive push, and time-target PITR remain runtime-unverified(public host)."
}

add_local_alpha_commands() {
  add_static_commands
  add_runtime_env_guard_command
  add_cmd "local alpha packet directory" 'mkdir -p "${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"'
  add_cmd "local alpha host-runtime evidence" 'packet="${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"; out="$packet/host-runtime"; mkdir -p "$out"; LOCAL_GATE_OUT_DIR="$out" scripts/verify_internal_host_runtime.sh'
  add_cmd "local alpha backup restore evidence" 'packet="${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"; out="$packet/backup-restore"; mkdir -p "$out"; BACKUP_REHEARSAL_OUT_DIR="$out" scripts/verify_backup_restore_rehearsal.sh'
  add_cmd "local alpha macOS real-backend evidence" 'packet="${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"; out="$packet/macos-real-backend"; mkdir -p "$out"; MACOS_REAL_BACKEND_OUT_DIR="$out" scripts/verify_macos_real_backend_ui.sh'
  add_cmd "local alpha diagnostics bundle" 'packet="${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"; out="$packet/diagnostics"; mkdir -p "$out"; scripts/collect_diagnostics.sh --output-dir "$out" --since 30m'
  add_note_once coverage "MOMO-237 local-alpha RC gate: creates one local Docker evidence packet with host-runtime image boot/health/migration idempotency/REST message/OutboxRelay publish/mock Kim Intern roundtrip, repo-local backup restore rehearsal, macOS real-backend smoke, and a redacted diagnostics bundle."
  add_note_once coverage "local-alpha is AWS-free: it uses local Docker, local Swift packages, repo-local mock Hermes, and local diagnostics only. It does not call AWS APIs, create cloud resources, trigger release workflows, or require public DNS/TLS."
  if [ "${LOCAL_GATE_LAUNCH_UI:-0}" = "1" ]; then
    add_note_once coverage "LOCAL_GATE_LAUNCH_UI=1 upgrades local-alpha macOS evidence to include MomoMacDevApp process/window/log launch against the local MomoServer."
  else
    add_note_once coverage "The default local-alpha profile keeps foreground GUI launch optional; rerun with LOCAL_GATE_LAUNCH_UI=1 for MomoMacDevApp process/window/log evidence."
  fi
  add_note_once not_covered "Public AWS/staging resources, public TLS/DNS, real registry pull, SOPS production secret injection, external Hermes staging connectivity, production pgBackRest stanza/check/full backup, WAL archive push, time-target PITR, notarization, TestFlight, iOS/APNs, and M7 release gate PASS remain out of scope."
}

add_m3_dbc_commands() {
  add_static_commands
  add_runtime_env_guard_command
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
  diagnostics)
    add_static_commands
    add_diagnostics_commands
    ;;
  staging-smoke)
    add_static_commands
    add_staging_smoke_commands
    ;;
  host-runtime)
    add_static_commands
    add_host_runtime_commands
    ;;
  backup)
    add_static_commands
    add_backup_commands
    ;;
  local-alpha)
    add_local_alpha_commands
    ;;
  internal-alpha)
    add_internal_alpha_commands
    ;;
  runtime-db)
    add_static_commands
    add_runtime_env_guard_command
    add_swift_commands
    add_runtime_db_commands
    ;;
  runtime-relay)
    add_static_commands
    add_runtime_env_guard_command
    add_swift_commands
    add_runtime_relay_commands
    ;;
  runtime-live)
    add_static_commands
    add_runtime_env_guard_command
    add_swift_commands
    add_runtime_live_commands
    ;;
  runtime-agent)
    add_static_commands
    add_runtime_env_guard_command
    add_swift_commands
    add_runtime_agent_cleanup_command "Pre-clean runtime agent host processes"
    add_runtime_agent_commands
    add_runtime_agent_final_cleanup_command "Cleanup runtime agent host processes"
    ;;
  external-agent-provider)
    add_static_commands
    add_runtime_env_guard_command
    add_external_agent_provider_commands
    ;;
  macos-ui)
    add_static_commands
    add_runtime_env_guard_command
    add_swift_commands
    add_macos_ui_commands
    ;;
  m3-dbc)
    add_m3_dbc_commands
    ;;
  all)
    add_static_commands
    add_runtime_env_guard_command
    add_swift_commands
    add_staging_smoke_commands
    add_host_runtime_commands
    add_runtime_db_commands
    add_runtime_host_api_cleanup_command "Cleanup host MomoServer after runtime DB verifiers"
    add_runtime_relay_commands
    add_runtime_host_api_cleanup_command "Cleanup host MomoServer after relay verifier"
    add_runtime_agent_cleanup_command "Pre-clean runtime agent host processes"
    add_runtime_agent_commands
    add_runtime_agent_final_cleanup_command "Cleanup runtime agent host processes after agent verifier"
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
FINAL_CLEANUP_FAILED=0

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

run_final_cleanup_cmd() {
  local index="$1"
  local label="${FINAL_CLEANUP_LABELS[$index]}"
  local command="${FINAL_CLEANUP_STRINGS[$index]}"
  local code

  {
    echo
    echo "==> [final-cleanup $((index + 1))/${#FINAL_CLEANUP_STRINGS[@]}] $label"
    echo "\$ $command"
  } | tee -a "$LOG_FILE"

  set +e
  bash -lc "$command" 2>&1 | tee -a "$LOG_FILE"
  code=${PIPESTATUS[0]}
  set +e

  if [ "$code" -eq 0 ]; then
    FINAL_CLEANUP_STATUS[index]="pass"
    echo "PASS: $label" | tee -a "$LOG_FILE"
  else
    FINAL_CLEANUP_STATUS[index]="fail"
    FINAL_CLEANUP_FAILED=1
    echo "FAIL: $label (exit $code)" | tee -a "$LOG_FILE"
    if [ "$FAILED_INDEX" -eq -1 ]; then
      FAILED_INDEX=-2
      FAILED_CODE="$code"
    fi
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

if [ "${#FINAL_CLEANUP_STRINGS[@]}" -gt 0 ]; then
  idx=0
  while [ "$idx" -lt "${#FINAL_CLEANUP_STRINGS[@]}" ]; do
    run_final_cleanup_cmd "$idx" || true
    idx=$((idx + 1))
  done
fi

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
    if [ "$AUTO_MODE" -eq 1 ]; then
      echo "- Auto profile selection (--auto):"
      echo "  - base: $AUTO_BASE_DESC"
      echo "  - suggested: \`$AUTO_SUGGESTED\`"
      if [ "$PROFILE_EXPLICIT" -eq 1 ]; then
        echo "  - applied: \`$PROFILE\` (explicit --profile overrides --auto)"
      else
        echo "  - applied: \`$PROFILE\`"
      fi
      echo "  - path mapping reasons:"
      for note in "${AUTO_REASONS[@]:-}"; do
        [ -n "$note" ] && echo "    - $note"
      done
    fi
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
    if [ "${#FINAL_CLEANUP_STRINGS[@]}" -gt 0 ]; then
      echo "- Final cleanup:"
      local cleanup_i=0
      while [ "$cleanup_i" -lt "${#FINAL_CLEANUP_STRINGS[@]}" ]; do
        case "${FINAL_CLEANUP_STATUS[$cleanup_i]}" in
          pass) marker="[x]" ;;
          fail) marker="[ ]" ;;
          *) marker="[ ]" ;;
        esac
        echo "  - $marker \`${FINAL_CLEANUP_STRINGS[$cleanup_i]}\`"
        cleanup_i=$((cleanup_i + 1))
      done
    fi
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
      if [ "$FAILED_INDEX" -eq -2 ]; then
        echo "- Failed command: \`final cleanup\`"
      else
        echo "- Failed command: \`${CMD_STRINGS[$FAILED_INDEX]}\`"
      fi
      echo "- Failed exit code: \`$FAILED_CODE\`"
    fi
    if [ "$PROFILE" = "local-alpha" ] || [ "$PROFILE" = "internal-alpha" ]; then
      if [ "$PROFILE" = "local-alpha" ]; then
        packet_label="Local alpha artifact packet"
        packet_dir="$LOCAL_GATE_LOCAL_ALPHA_DIR"
      else
        packet_label="Internal alpha artifact packet"
        packet_dir="$LOCAL_GATE_INTERNAL_ALPHA_DIR"
      fi
      echo "- ${packet_label}:"
      echo "  - packet: \`${packet_dir}\`"
      for artifact_dir in host-runtime backup-restore macos-real-backend diagnostics; do
        path="$packet_dir/$artifact_dir"
        if [ -d "$path" ]; then
          echo "  - ${artifact_dir}: \`$path\`"
          find "$path" -maxdepth 2 -type f \( -name '*.md' -o -name '*.json' -o -name '*.log' -o -name '*.tar.gz' \) 2>/dev/null \
            | sort \
            | tail -n 20 \
            | sed 's/^/    - `/' \
            | sed 's/$/`/'
        else
          echo "  - ${artifact_dir}: not created"
        fi
      done
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
