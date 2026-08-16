#!/usr/bin/env bash
# Local PR gate runner for the GitHub Actions disabled/manual-only period.
# shellcheck disable=SC2016
set -u -o pipefail

PROFILE=""
PROFILE_EXPLICIT=0
AUTO_MODE=0
KEEP_STACK=0
OUT_DIR="${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}"

usage() {
  cat <<'EOF'
Usage: scripts/local_gate.sh [--auto] [--profile docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|m3-dbc|web-serving|web|license|secrets|all]

Options:
  --auto              Pick the profile from changed paths (MOMO-316):
                      git diff --name-only <base>...HEAD plus uncommitted changes,
                      mapped conservatively (ambiguous paths widen to `all`, never
                      narrow). An explicit --profile always wins over --auto; the
                      suggested profile and per-path reasons are still recorded in
                      the evidence markdown.
  --profile PROFILE   Gate profile to run. Default: docs (when --auto is not given)
  --output-dir DIR    Directory for log/evidence files. Default: $TMPDIR/momo-local-gate
  --keep-stack        Keep the main runtime-* Compose stack after the gate exits.
                      By default it is taken down on success, failure, or interruption.
  -h, --help          Show this help.

Environment:
  LOCAL_GATE_OUT_DIR      Override evidence output directory.
                          Required by internal-alpha.
  LOCAL_GATE_ALLOW_DIRTY=1 Allow pre-commit exploratory runs with dirty files.
  LOCAL_GATE_BASE_REF      Defaults to origin/main for committed PR diff checks and
                          --auto profile selection (falls back to local main).
  MOMO_GATE_SKEW_REF       Branch-skew upstream. Default: origin/main.
  MOMO_GATE_SKIP_SKEW      Reviewed override reason. The reason is recorded in evidence.
  LOCAL_GATE_FORCE=1       Run a runtime-* profile even when host load(1min) is > 12.
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
    --keep-stack)
      KEEP_STACK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|m3-dbc|web-serving|web|license|secrets|all)
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
    docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|m3-dbc|web-serving|web|license|secrets|all) ;;
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

local_gate_load_1m() {
  local load=""

  if [ -r /proc/loadavg ]; then
    load="$(awk '{ print $1; exit }' /proc/loadavg 2>/dev/null)"
  elif command -v sysctl >/dev/null 2>&1; then
    load="$(sysctl -n vm.loadavg 2>/dev/null | awk '{ gsub(/[{}]/, ""); print $1; exit }')"
  fi

  case "$load" in
    ""|*[!0-9.]*) return 1 ;;
  esac
  printf '%s\n' "$load"
}

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
AUTO_NEED_DB=0
AUTO_NEED_RELAY=0
AUTO_NEED_AGENT=0
AUTO_NEED_LIVE=0
AUTO_NEED_STAGING=0
AUTO_NEED_HOSTRT=0
AUTO_NEED_DIAG=0
AUTO_NEED_WEB=0
AUTO_NEED_LICENSE=0
AUTO_NEED_SECRETS=0
AUTO_NEED_ALL=0

auto_classify_script() {
  # scripts/** → docs + 해당 스크립트가 속한 runtime 프로파일. 모호하면 all.
  case "$1" in
    scripts/migrate.sh|scripts/verify_runtime_role_bootstrap.sh|scripts/verify_prod_seed_password.sh|scripts/verify_owner_bootstrap.sh|scripts/verify_rls.sh|scripts/verify_prod_rls_posture.sh|scripts/verify_roster.sh|scripts/verify_channel_list.sh|scripts/verify_channel_management.sh|scripts/verify_join.sh|scripts/verify_platform_admin.sh|scripts/verify_approval_decision.sh|scripts/verify_auth_hardening.sh|scripts/verify_push_registration.sh|scripts/verify_push_notifier.sh|scripts/verify_notification_mute.sh|scripts/verify_plugin_registry.sh|scripts/verify_signed_webhook_ingress.sh|scripts/verify_drive_mcp.sh|scripts/verify_attachment_upload.sh|scripts/verify_plugin_grant_roundtrip.sh|scripts/verify_huddle_lifecycle.sh|scripts/verify_workspace_search.sh|scripts/verify_thread_reply.sh|scripts/verify_message_interaction.sh|scripts/verify_work_session.sh|scripts/verify_work_session_idle.sh|scripts/verify_work_control.sh|scripts/verify_work_agent_e2e.sh|scripts/verify_work_host.sh|scripts/verify_workd.sh|scripts/verify_workd_attach.sh|scripts/terminal_attach_probe.py|scripts/terminal_attach_tls_proxy.py|scripts/verify_work_pool.sh|scripts/verify_tier_fallback.sh|scripts/verify_t3_migration_repair.sh|scripts/verify_t3_lifecycle_concurrency.sh|scripts/verify_t3_convergence.sh|scripts/verify_work_tool_profile.sh|scripts/verify_agent_create.sh|scripts/verify_agent_credentials_rust.sh|scripts/tests/test_agent_credentials_verifier_safety.sh|scripts/verify_agent_card_onboarding.sh|scripts/verify_agent_profile.sh|scripts/verify_agent_run_history.sh|scripts/verify_agent_interaction_safety.sh|scripts/verify_memory_grant.sh|scripts/verify_membership_lifecycle.sh|scripts/verify_lifecycle_completion.sh|scripts/verify_t3_provider_continuity.sh|scripts/verify_workstream_continuity.sh|scripts/mock_push_relay.py)
      AUTO_NEED_DB=1; AUTO_REASONS+=("$1 -> runtime-db") ;;
    scripts/check_cargo_licenses.sh|scripts/check_npm_licenses.mjs|scripts/tests/test_license_gate.sh)
      AUTO_NEED_LICENSE=1; AUTO_REASONS+=("$1 -> license (#1225 cargo/npm dependency license gate)") ;;
    scripts/check_secrets.sh|scripts/tests/test_secrets_gate.sh)
      AUTO_NEED_SECRETS=1; AUTO_REASONS+=("$1 -> secrets (#1236 gitleaks history scan)") ;;
    scripts/check_design_review_wiring.sh)
      # #1254. The guard is static and already runs in every profile via
      # add_static_commands; the surfaces it names are web + phone, and `web` is
      # the lane that actually renders one of them.
      AUTO_NEED_WEB=1; AUTO_REASONS+=("$1 -> web (#1254 design review loop wiring)") ;;
    scripts/check_compose_env_templates.sh|scripts/tests/test_compose_env_template_gate.sh)
      # #1250. Same shape as deny.toml/.gitleaksignore: the guard itself lives in
      # add_static_commands and therefore runs in every profile, so this only
      # picks the lane that actually renders the templates it guards
      # (verify_internal_hosting_smoke · verify_staging_smoke · prod_env_preflight).
      AUTO_NEED_STAGING=1; AUTO_REASONS+=("$1 -> staging-smoke (#1250 compose env template guard; the profile that renders these templates)") ;;
    scripts/verify_linkshort.sh)
      AUTO_REASONS+=("$1 -> swift") ;;
    scripts/verify_relay.sh|scripts/verify_push_relay.sh|scripts/push_relay_keygen.sh)
      AUTO_NEED_RELAY=1; AUTO_REASONS+=("$1 -> runtime-relay") ;;
    scripts/verify_realtime_live.sh)
      AUTO_NEED_LIVE=1; AUTO_REASONS+=("$1 -> runtime-live") ;;
    scripts/ensure_runtime_env.sh|scripts/verify_agent_worker_bootstrap.sh|scripts/verify_agent_worker.sh|scripts/verify_agent_path_equivalence.sh|scripts/verify_agent_context_bootstrap.sh|scripts/verify_agent_context.sh|scripts/verify_agent_live_channel_bootstrap.sh|scripts/verify_agent_live_channel.sh|scripts/verify_hermes_verifier_bootstrap.sh|scripts/verify_local_hermes_bridge.sh|scripts/verify_hermes_gateway_adapter.sh|scripts/verify_hermes_gateway_real_smoke.sh|scripts/verify_local_hermes_credentialed_smoke.sh|scripts/verify_external_agent_provider.sh|scripts/mock_hermes.py)
      AUTO_NEED_AGENT=1; AUTO_REASONS+=("$1 -> runtime-agent") ;;
    scripts/self_host_env.sh|scripts/tests/test_self_host_env_modes.sh|scripts/tests/test_publish_images_contract.py|scripts/verify_staging_smoke.sh|scripts/verify_internal_hosting_smoke.sh|scripts/verify_prod_install_upgrade.sh|scripts/verify_metrics_observability.sh|scripts/prod_env_preflight.sh|scripts/aws_internal_alpha_preflight.sh|scripts/verify_ncp_centrifugo_contract.sh|scripts/verify_ncp_centrifugo_boundary.sh|scripts/tests/test_ncp_centrifugo_boundary.sh)
      AUTO_NEED_STAGING=1; AUTO_REASONS+=("$1 -> staging-smoke") ;;
    scripts/verify_internal_host_runtime.sh|scripts/verify_backup_restore_rehearsal.sh)
      AUTO_NEED_HOSTRT=1; AUTO_REASONS+=("$1 -> host-runtime") ;;
    scripts/web_serving_smoke.sh|scripts/verify_web_login_smoke.sh|scripts/verify_web_generated_types.sh)
      AUTO_NEED_WEB=1; AUTO_REASONS+=("$1 -> web") ;;
    scripts/verify_openapi_contract.sh|scripts/openapi_shape_check.py)
      AUTO_NEED_WEB=1; AUTO_REASONS+=("$1 -> web (OpenAPI drift gate runs inside the web profile)") ;;
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
    deny.toml)
      # #1225 cargo license policy. Its only consumer is the license gate, so
      # this is targeting rather than narrowing: no build/runtime surface reads it.
      AUTO_NEED_LICENSE=1; AUTO_REASONS+=("$1 -> license (cargo-deny policy)") ;;
    .gitleaksignore)
      # #1236 secret-scan triage baseline. Same shape as deny.toml: the secret
      # gate is its only reader. The scan itself runs in every profile (it is in
      # add_static_commands), so this only picks the cheapest lane that proves
      # an edited baseline still behaves.
      AUTO_NEED_SECRETS=1; AUTO_REASONS+=("$1 -> secrets (gitleaks triage baseline)") ;;
    docs/api/openapi.yaml)
      # The client contract spec: drift is verified against the live server
      # inside the web profile (verify_openapi_contract.sh).
      AUTO_NEED_WEB=1; AUTO_REASONS+=("$1 -> web (contract spec; runtime drift gate)") ;;
    clients/web-legacy/*)
      # Before the docs/*.md pattern on purpose: clients/web-legacy/README.md is
      # the httpOnly promotion-gate canon — a web surface change, not docs.
      # This is the ADR-0119 v0 (MOMO-596 moved it off clients/web); it still owns
      # the live serving/e2e path, so the `web` profile stays pointed here.
      AUTO_NEED_WEB=1; AUTO_REASONS+=("$1 -> web (ADR-0119 alpha at clients/web-legacy)") ;;
    clients/web/*|clients/desktop/*)
      # ADR-0133 canonical UI + Tauri shell (promoted from the MOMO-595 P0 spike
      # by MOMO-596). No gate profile covers this stack yet, and `web` verifies
      # clients/web-legacy — narrowing here would emit a green that proves
      # nothing about the changed files.
      AUTO_NEED_ALL=1; AUTO_REASONS+=("$1 -> all (ADR-0133 stack has no gate profile yet; widen, do not narrow)") ;;
    docs/*|research/*|legal/*|*.md)
      AUTO_REASONS+=("$1 -> docs") ;;
    clients/*)
      # W-S1: clients/macOS·clients/iOS·clients/Core 는 삭제됐다. 남은
      # clients/* 는 위에서 이미 잡히므로(web-legacy / web / desktop), 여기까지
      # 내려오는 것은 새로 생겼거나 분류가 없는 트리다 — 좁히지 않고 넓힌다.
      AUTO_NEED_ALL=1; AUTO_REASONS+=("$1 -> all (unclassified clients/ tree; widen, do not narrow)") ;;
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
    services/LinkShort/*)
      AUTO_REASONS+=("$1 -> swift") ;;
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

  local units=$((AUTO_NEED_DB + AUTO_NEED_RELAY + AUTO_NEED_AGENT + AUTO_NEED_LIVE + AUTO_NEED_STAGING + AUTO_NEED_HOSTRT + AUTO_NEED_DIAG + AUTO_NEED_WEB + AUTO_NEED_LICENSE + AUTO_NEED_SECRETS))
  if [ "$AUTO_NEED_ALL" -eq 1 ] || [ "$units" -gt 1 ]; then
    AUTO_SUGGESTED="all"
    if [ "$AUTO_NEED_LIVE" -eq 1 ]; then
      AUTO_REASONS+=("note: profile 'all' does not include runtime-live; run --profile runtime-live separately")
    fi
    if [ "$AUTO_NEED_DIAG" -eq 1 ]; then
      AUTO_REASONS+=("note: profile 'all' does not include the diagnostics smoke; run --profile diagnostics separately")
    fi
    if [ "$AUTO_NEED_WEB" -eq 1 ]; then
      AUTO_REASONS+=("note: profile 'all' does not include the web profile; run --profile web separately")
    fi
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
  elif [ "$AUTO_NEED_WEB" -eq 1 ]; then
    AUTO_SUGGESTED="web"
  elif [ "$AUTO_NEED_LICENSE" -eq 1 ]; then
    AUTO_SUGGESTED="license"
  elif [ "$AUTO_NEED_SECRETS" -eq 1 ]; then
    AUTO_SUGGESTED="secrets"
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
  docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|m3-dbc|web-serving|web|license|secrets|all) ;;
  *)
    echo "unknown profile: $PROFILE" >&2
    usage >&2
    exit 2
    ;;
esac

RUNTIME_COMPOSE_PROFILE=0
RUNTIME_COMPOSE_PREEXISTING=0
case "$PROFILE" in
  runtime-db|runtime-relay|runtime-live|runtime-agent|all|m3-dbc|web-serving)
    # all/m3-dbc included: they run the same `make up` bootstrap and
    # are Docker-heavy — the incident class this guard exists for.
    RUNTIME_COMPOSE_PROFILE=1
    ;;
esac

if [ "$RUNTIME_COMPOSE_PROFILE" -eq 1 ]; then
  if LOAD_1M="$(local_gate_load_1m)"; then
    if awk -v load="$LOAD_1M" 'BEGIN { exit !(load > 12) }'; then
      if [ "${LOCAL_GATE_FORCE:-0}" != "1" ]; then
        echo "WARNING: host load(1min) is $LOAD_1M (> 12); refusing to start $PROFILE." >&2
        echo "Wait for host load to fall, or confirm the override with LOCAL_GATE_FORCE=1." >&2
        exit 1
      fi
      echo "WARNING: LOCAL_GATE_FORCE=1 set; continuing despite host load(1min) $LOAD_1M (> 12)." >&2
    fi
  else
    echo "WARNING: unable to read host load(1min); continuing without the load guard." >&2
  fi
fi

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
MANIFEST_FILE="$OUT_DIR/local-gate-${PROFILE}-${RUN_ID}.sha256"
RUN_ARTIFACT_DIR="$OUT_DIR/artifacts-${RUN_ID}"
mkdir -p "$RUN_ARTIFACT_DIR" || exit 1
export LOCAL_GATE_OUTPUT_DIR="$RUN_ARTIFACT_DIR"
export LOCAL_GATE_RUN_ID="$RUN_ID"
export LOCAL_GATE_LOCAL_ALPHA_DIR="$RUN_ARTIFACT_DIR/local-alpha-${RUN_ID}"
export LOCAL_GATE_INTERNAL_ALPHA_DIR="$RUN_ARTIFACT_DIR/internal-alpha-${RUN_ID}"
export MOMO_RUNTIME_GUARD_REPO_ROOT="$REPO_ROOT"
RUNTIME_COMPOSE_STARTED=0
case "$PROFILE" in
  local-alpha|internal-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|external-agent-provider|m3-dbc|all)
    # shellcheck source=scripts/runtime_process_guard.sh
    . "$REPO_ROOT/scripts/runtime_process_guard.sh"
    if ! momo_guard_begin_gate_run "$RUN_ID" >/dev/null; then
      echo "failed to create runtime process ownership marker" >&2
      exit 1
    fi

    # shellcheck disable=SC2329 # invoked indirectly by EXIT trap
    local_gate_emergency_cleanup() {
      local original_rc=$?
      trap - EXIT INT TERM
      if [ "$RUNTIME_COMPOSE_STARTED" -eq 1 ] && [ "$KEEP_STACK" -eq 0 ] && [ "${RUNTIME_COMPOSE_PREEXISTING:-0}" -eq 0 ]; then
        echo "local gate: taking down runtime Compose stack" | tee -a "$LOG_FILE"
        if ! bash -lc "make down" 2>&1 | tee -a "$LOG_FILE"; then
          echo "WARNING: runtime Compose teardown failed; run 'make down' manually." | tee -a "$LOG_FILE" >&2
        fi
      elif [ "$RUNTIME_COMPOSE_STARTED" -eq 1 ] && [ "${RUNTIME_COMPOSE_PREEXISTING:-0}" -eq 1 ]; then
        echo "local gate: pre-existing Compose stack retained (not started by this gate)" | tee -a "$LOG_FILE"
      elif [ "$RUNTIME_COMPOSE_STARTED" -eq 1 ]; then
        echo "local gate: --keep-stack set; runtime Compose stack retained" | tee -a "$LOG_FILE"
      fi
      if momo_guard_validate_marker "${MOMO_GATE_RUN_MARKER:-}"; then
        momo_cleanup_gate_marker "$MOMO_GATE_RUN_MARKER" "local gate emergency cleanup" || true
      fi
      exit "$original_rc"
    }
    trap local_gate_emergency_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    ;;
esac

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

add_track_alignment_preflight() {
  # Local wiring is safe to require on repair branches. Global remote drift is
  # the track-alignment workflow's job: requiring it here would deadlock the PR
  # whose candidate repairs a behind/diverged track.
  add_cmd_once "canonical local track wiring preflight" 'scripts/check_track_alignment.sh --local-existing'
}

# --- #1376 ambient-toolchain hardening -------------------------------------
# Two gate steps shell out to third-party toolchains that this repo does not
# version. Both produced a gate that was worse than no gate at all, and they
# stacked: the actionlint spin held the run hostage before anything reached the
# openapi parse, so the second defect stayed invisible for a day.
#
# These fragments are named variables rather than literals inlined at the
# add_cmd_once call so scripts/tests/test_local_gate_lint_timeout.sh can extract
# and execute them in isolation against stub toolchains. Keep them single-line:
# write_evidence renders every command inside an inline backtick span.
#
# 1) actionlint 1.7.12 (go1.26.3, darwin/arm64) spins at 800% CPU indefinitely
#    inside its shellcheck integration layer on three of the five workflows here
#    (policy-integrity, pr-ci, release-desktop). shellcheck itself lints the same
#    run blocks in 0.04s and `actionlint -shellcheck=` clears every file in
#    0.04s, so the defect is the integration layer, not the workflows. macOS has
#    no coreutils `timeout`, so the watchdog is the bg+kill pattern: wait on the
#    child while a detached watchdog (own stdio, so it can never hold the gate
#    tee pipe open and hang the run) drops a marker file and reaps the child plus
#    its shellcheck grandchildren. A timeout degrades to exactly one
#    `-shellcheck=` retry and says so out loud; a genuine actionlint finding is
#    still a hard failure and is never retried into green.
GATE_WORKFLOW_LINT_CMD='if ! command -v actionlint >/dev/null 2>&1; then base="${LOCAL_GATE_BASE_REF:-origin/main}"; changed=""; if git rev-parse --verify "$base" >/dev/null 2>&1; then changed="$(git diff --name-only "$base"...HEAD -- .github/workflows/*.yml)"; else changed="$(git diff --name-only -- .github/workflows/*.yml)"; fi; if [ -n "$changed" ]; then echo "actionlint is not installed and workflow files changed:"; printf "%s\n" "$changed"; exit 1; fi; echo "actionlint not installed; workflow files unchanged; skipped"; exit 0; fi; al_limit="${MOMO_GATE_ACTIONLINT_TIMEOUT:-120}"; al_work="$(mktemp -d "${TMPDIR:-/tmp}/momo-gate-actionlint.XXXXXX")"; gate_actionlint_try() { rm -f "$al_work/timed-out"; actionlint "$@" >"$al_work/out" 2>&1 & al_pid=$!; { al_i=0; while [ "$al_i" -lt "$al_limit" ]; do sleep 1; kill -0 "$al_pid" 2>/dev/null || exit 0; al_i=$((al_i + 1)); done; : >"$al_work/timed-out"; pkill -TERM -P "$al_pid" 2>/dev/null; kill -TERM "$al_pid" 2>/dev/null; sleep 2; pkill -KILL -P "$al_pid" 2>/dev/null; kill -KILL "$al_pid" 2>/dev/null; } >/dev/null 2>&1 & al_dog=$!; wait "$al_pid"; al_code=$?; pkill -P "$al_dog" >/dev/null 2>&1; kill "$al_dog" >/dev/null 2>&1; wait "$al_dog" >/dev/null 2>&1; cat "$al_work/out"; if [ -e "$al_work/timed-out" ]; then return 124; fi; return "$al_code"; }; gate_actionlint_try .github/workflows/*.yml; al_result=$?; if [ "$al_result" -ne 124 ]; then rm -rf "$al_work"; exit "$al_result"; fi; echo "DEGRADED (#1376): actionlint exceeded the ${al_limit}s hard timeout with its shellcheck integration enabled, and was killed with its grandchildren. actionlint 1.7.12 (go1.26.3) spins at 800% CPU in that layer on this repo; shellcheck alone lints the same run blocks in 0.04s. Retrying once with -shellcheck= — shell-script findings inside run: blocks are NOT covered by this run."; gate_actionlint_try -shellcheck= .github/workflows/*.yml; al_result=$?; rm -rf "$al_work"; if [ "$al_result" -eq 124 ]; then echo "actionlint timed out again after ${al_limit}s with -shellcheck= disabled; workflow lint is unusable on this host. Unlink/downgrade actionlint (brew unlink actionlint) and re-run: the gate then falls back to the not-installed branch, which still fails closed when workflow files changed."; exit 1; fi; if [ "$al_result" -ne 0 ]; then exit "$al_result"; fi; echo "workflow lint PASSED in DEGRADED mode: actionlint -shellcheck= only. Restore full coverage by fixing/downgrading actionlint, then re-run with MOMO_GATE_ACTIONLINT_TIMEOUT set to confirm the spin is gone."; exit 0'

# 2) The two YAML parse steps used whatever `ruby` the ambient PATH resolved. In
#    a worker-spawned non-interactive shell that is macOS system Ruby 2.6, whose
#    psych/libyaml rejects colon-bearing plain scalars in flow sequences — the
#    HAP scope enums (`[agent:port:connect, ...]`, docs/api/openapi.yaml:6771)
#    are valid YAML 1.2 and Ruby 3.0+/4.x parse them fine. That produced a bare
#    Psych::SyntaxError pointing at a healthy line: a RED naming the repo for a
#    defect in the host. So resolve a psych-capable Ruby first, by capability
#    (parse a colon-scoped flow scalar) rather than by version string, and when
#    none exists fail with the Homebrew path instead of the parser stack trace.
#    The enum values themselves are generator-owned and must not be quote-fixed.
GATE_RUBY_SELECT_CMD='ruby_bin=""; for cand in "${MOMO_GATE_RUBY:-}" ${MOMO_GATE_RUBY_CANDIDATES:-ruby /opt/homebrew/opt/ruby/bin/ruby /usr/local/opt/ruby/bin/ruby /opt/homebrew/bin/ruby}; do [ -n "$cand" ] || continue; command -v "$cand" >/dev/null 2>&1 || continue; "$cand" -e "require %q(yaml); YAML.load(%q([a:b:c]))" >/dev/null 2>&1 || continue; ruby_bin="$cand"; break; done; if [ -z "$ruby_bin" ]; then echo "no Ruby on this host can parse YAML 1.2 plain scalars containing colons."; echo "macOS system Ruby 2.6 (old psych/libyaml) rejects the colon-scoped HAP enum values in docs/api/openapi.yaml, which Ruby 3.0+ parses fine. This is an ambient toolchain gap on this host, NOT a repo defect (#1376)."; echo "Do NOT quote-fix those enum values: docs/api/openapi.yaml is generator-owned."; echo "Fix the host: brew install ruby (installs /opt/homebrew/opt/ruby/bin/ruby), or export MOMO_GATE_RUBY=/opt/homebrew/opt/ruby/bin/ruby before re-running the gate."; echo "Candidates probed, in order: MOMO_GATE_RUBY, then MOMO_GATE_RUBY_CANDIDATES (default: ruby on PATH, /opt/homebrew/opt/ruby/bin/ruby, /usr/local/opt/ruby/bin/ruby, /opt/homebrew/bin/ruby)."; exit 1; fi; echo "gate ruby: $ruby_bin ($("$ruby_bin" -e "print RUBY_VERSION"))"'
GATE_WORKFLOW_YAML_PARSE_CMD="$GATE_RUBY_SELECT_CMD"'; "$ruby_bin" -e "require %q(yaml); Dir[%q(.github/workflows/*.yml)].sort.each { |f| YAML.load_file(f); puts f }"'
GATE_OPENAPI_YAML_PARSE_CMD="$GATE_RUBY_SELECT_CMD"'; "$ruby_bin" -e "require %q(yaml); YAML.load_file(%q(docs/api/openapi.yaml)); puts %q(docs/api/openapi.yaml)"'
# --- end #1376 ambient-toolchain hardening ---------------------------------

add_static_commands() {
  add_cmd_once "branch skew preflight" 'scripts/check_branch_skew.sh'
  add_cmd_once "worktree clean" 'if [ "${LOCAL_GATE_ALLOW_DIRTY:-0}" = "1" ]; then echo "LOCAL_GATE_ALLOW_DIRTY=1; dirty state is recorded but not failed"; git status --short; else test -z "$(git status --porcelain)" || { echo "worktree has uncommitted changes"; git status --short; exit 1; }; fi'
  # #1236: the secret scan is part of the static block, not a profile someone has
  # to remember. #1224 landed the triage baseline and measured that nothing
  # executed it — a baseline with no executor is a comment. See
  # add_secrets_commands for the cost measurement and the caveats.
  add_secrets_commands
  add_cmd_once "migration number uniqueness" 'scripts/check_migration_numbers.sh server/Migrations'
  add_cmd_once "diff whitespace" 'base="${LOCAL_GATE_BASE_REF:-origin/main}"; if git rev-parse --verify "$base" >/dev/null 2>&1; then git diff --check "$base"...HEAD; else echo "base ref $base unavailable; falling back to working tree whitespace checks"; fi; git diff --cached --check; git diff --check'
  add_cmd_once "workflow yaml parse" "$GATE_WORKFLOW_YAML_PARSE_CMD"
  add_cmd_once "workflow lint" "$GATE_WORKFLOW_LINT_CMD"
  add_cmd_once "e2e compose config" 'env_file="${ENV_FILE:-}"; if [ -z "$env_file" ]; then for f in .env.worktree .env infra/.env.example; do if [ -f "$f" ]; then env_file="$f"; break; fi; done; fi; test -n "$env_file" || { echo "no env file found for e2e compose config"; exit 1; }; docker compose --env-file "$env_file" -f infra/docker-compose.e2e.yml config >/tmp/momo-compose-e2e-config.yml; echo "wrote /tmp/momo-compose-e2e-config.yml using $env_file"'
  # #1250: the e2e rendering above is one of many, and the ones that broke were
  # the prod/rust ones nothing rendered. This checks all eight at once.
  add_cmd_once "compose env template completeness" 'scripts/check_compose_env_templates.sh'
  add_cmd_once "compose env template gate regression (red proofs: #1246 reintroduced, empty value, untabled file)" 'scripts/tests/test_compose_env_template_gate.sh'
  add_note_once coverage "#1250 compose/env template completeness via scripts/check_compose_env_templates.sh: every \${VAR:?} in the eight documented prod/rust compose renderings must be a non-empty line in the env template(s) that rendering is documented to use, and each rendering is then handed to \`docker compose config\` so the static reading cannot drift from what compose does. Two coverage checks keep the table honest — a compose file that requires a variable but appears in no rendering is red, and so is an env template no rendering uses (or an entry in the non-compose allowlist whose file has disappeared). This closes a trap that sprang four times: interpolation happens before profile filtering, so a \`profiles: [\"workhost\"]\` service demands its variables from operators who will never select it, and \`\${VAR:?}\` refuses empty as well as unset. scripts/tests/test_compose_env_template_gate.sh proves red on the exact #1246 shape (all three keys named in one run, where \`docker compose config\` names only the first), on an emptied template value, on a new \${VAR:?} with no template line, on a compose file or env template outside the table, and on an absent docker; and proves green where a false alarm would be easy — \${VAR:?} written inside a YAML comment and \${VAR:-default}."
  add_cmd_once "AWS internal alpha topology preflight" 'out="${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/aws-internal-alpha-preflight"; scripts/aws_internal_alpha_preflight.sh --env-file infra/prod/aws-internal-alpha.env.example --mode recommended --evidence-dir "$out"'
  add_cmd_once "json syntax" 'jq empty .github/labels.json infra/centrifugo.json infra/prod/centrifugo.prod.json docs/api/openapi.undocumented-allowlist.json docs/api/harness-refine-client-msg-id.golden.json && find research/11-agent-runtime/fixtures server/Fixtures -name "*.json" -print0 | xargs -0 jq empty'
  add_cmd_once "openapi contract spec parse" "$GATE_OPENAPI_YAML_PARSE_CMD"
  add_cmd_once "Centrifugo exact credential metadata contract" 'test "$(jq -r ".channel.proxy.subscribe.include_connection_meta" infra/centrifugo.json)" = "true"; test "$(jq -r ".channel.proxy.subscribe.include_connection_meta" infra/prod/centrifugo.prod.json)" = "true"; grep -Fq "\"include_connection_meta\": true" scripts/local_alpha_runner.sh'
  # #1254: CLAUDE.md makes design-review a hard rule for every UI change, so the
  # loop pointing at deleted client trees was a rule that could not be followed.
  add_cmd_once "design review loop wiring contract" 'scripts/check_design_review_wiring.sh'
  add_note_once coverage "#1254 design review loop wiring via scripts/check_design_review_wiring.sh: the files the loop is made of must exist (router skill, web dialect, rubric, canonical design-system page, web pre-flight, both token files), every clients/<tree> named in an agent's or skill's frontmatter description must exist, and the router must still delegate web/desktop to momo-design-taste-web while saying what governs clients/mobile. The frontmatter is checked and the body prose deliberately is not: a description is what routes work to a reviewer (the #1254 defect was design-review's own description aiming at clients/macOS and clients/Core weeks after they were deleted), while writing \"clients/macOS was deleted\" in the body is the correct sentence and must stay legal."
  add_cmd_once "self-host quickstart drift contract" 'for f in docs/SELF_HOST.md scripts/self_host_env.sh infra/rust/local.override.yml infra/rust/Caddyfile.local infra/rust/docker-compose.rust.yml infra/rust/docker-compose.rust.build.yml; do test -s "$f" || { echo "self-host path is missing $f"; exit 1; }; done; for doc in docs/SELF_HOST.md scripts/self_host_env.sh; do for ref in infra/rust/docker-compose.rust.yml infra/rust/docker-compose.rust.build.yml infra/rust/local.override.yml infra/rust/local.secrets.env; do grep -Fq "$ref" "$doc" || { echo "$doc no longer names $ref — the quickstart command has drifted"; exit 1; }; done; done; grep -Eq "^:80 \{" infra/rust/Caddyfile.local || { echo "infra/rust/Caddyfile.local must use a port-only site address (:80) — a hostname turns on automatic HTTPS and orders a real certificate at boot (#1239)"; exit 1; }; grep -Fq "Caddyfile.local" infra/rust/local.override.yml || { echo "local.override.yml must mount Caddyfile.local"; exit 1; }; grep -Fq "infra/rust/Caddyfile:" infra/rust/local.override.yml && { echo "local.override.yml must NOT mount the production Caddyfile"; exit 1; }; echo "self-host quickstart wiring intact"'
  add_note_once coverage "#1229 self-host quickstart drift contract: docs/SELF_HOST.md and scripts/self_host_env.sh must keep naming the same three compose files and the generated env path (a renamed overlay fails the gate instead of failing a self-hoster), infra/rust/Caddyfile.local must keep a port-only site address so a local run cannot order a certificate for the live domain at boot (#1239), and local.override.yml must never mount the production Caddyfile."
  add_cmd_once "NCP Centrifugo internal-only contract" 'scripts/verify_ncp_centrifugo_contract.sh'
  add_cmd_once "NCP Centrifugo boundary regression (403/order/hash/redaction RED proofs)" 'scripts/tests/test_ncp_centrifugo_boundary.sh'
  add_note_once coverage "#1329 Rust/NCP Centrifugo boundary: infra/rust/Caddyfile must terminate /v1/centrifugo/* with an exclusive 403 before the general /v1 proxy; API and Centrifugo must require the same CENT_PROXY_SECRET source; mutation fixtures prove missing/reordered deny, header drift, public 401/401/400, hash mismatch, current-secret 401, and any raw-secret evidence are RED. H1 fixtures additionally prove the runtime accepts only the exact HTTPS origin derived from the canonical Caddy site; attacker/typo/port/userinfo/path/query/fragment/punycode and ambiguous Caddy inputs produce zero secret reads, Docker execs, curl/network calls, or evidence, production/staging cannot enable the synthetic-only loopback escape, and 3xx is never followed."
  add_note_once not_covered "#1329 public app.oor7.com reload/recreate, real host/API/Centrifugo SHA-256 equality, and old-secret rotation evidence remain runtime-unverified(public host) until the attended NCP runbook step executes scripts/verify_ncp_centrifugo_boundary.sh."
  add_cmd_once "pgvector image and migration drift contract" "scripts/verify_pgvector_contract.sh"
  add_cmd_once "eve compose profile drift contract" "scripts/verify_eve_profile.sh --config-only"
  add_cmd_once "shell syntax" 'for f in .conductor/setup.sh adapters/prime/run.sh adapters/prime/container/entrypoint.sh adapters/prime/tests/tenancy_probe.sh scripts/momo scripts/local_gate.sh scripts/planning_context.sh scripts/self_host_env.sh scripts/runtime_process_guard.sh scripts/ensure_runtime_env.sh scripts/check_branch_skew.sh scripts/check_track_alignment.sh scripts/github_track_guardrails.sh scripts/verify_policy_integrity.sh scripts/check_migration_numbers.sh scripts/check_cargo_licenses.sh scripts/check_secrets.sh scripts/check_compose_env_templates.sh scripts/check_design_review_wiring.sh scripts/write_sha256_manifest.sh scripts/install_branch_skew_hook.sh scripts/hooks/pre-push scripts/tests/fixtures/pre-push-branch-skew-v1 scripts/tests/test_license_gate.sh scripts/tests/test_secrets_gate.sh scripts/tests/test_track_alignment_guard.sh scripts/tests/test_github_track_guardrails.sh scripts/tests/test_pr_ci_guardrails.sh scripts/tests/test_policy_integrity_gate.sh scripts/tests/test_compose_env_template_gate.sh scripts/tests/test_ncp_centrifugo_boundary.sh scripts/tests/test_local_gate_hardening.sh scripts/tests/test_local_gate_drift_guard.sh scripts/tests/test_local_gate_lint_timeout.sh scripts/tests/test_goal_claim_base_resolution.sh scripts/tests/test_make_deploy_bundle.sh scripts/cleanup_dogfood_seed_agents.sh scripts/local_soak_monitor.sh scripts/collect_diagnostics.sh scripts/compose_janitor.sh scripts/local_alpha_runner.sh scripts/make_deploy_bundle.sh scripts/goal_claim.sh scripts/goal_status.sh scripts/goal_release.sh scripts/github_bootstrap.sh scripts/github/bootstrap.sh scripts/migrate.sh scripts/prod_env_preflight.sh scripts/aws_internal_alpha_preflight.sh scripts/verify_prod_install_upgrade.sh scripts/verify_multibinary_image.sh scripts/verify_momo_ops.sh scripts/verify_momo_ops_runtime.sh scripts/verify_prod_rls_posture.sh scripts/verify_owner_bootstrap.sh scripts/verify_owner_bootstrap_rust.sh scripts/design_preflight_web.sh scripts/verify_pgvector_contract.sh scripts/verify_eve_profile.sh scripts/verify_ncp_centrifugo_contract.sh scripts/verify_ncp_centrifugo_boundary.sh scripts/verify_runtime_role_bootstrap.sh scripts/verify_prod_seed_password.sh scripts/verify_rls.sh scripts/verify_roster.sh scripts/verify_channel_list.sh scripts/verify_channel_management.sh scripts/verify_join.sh scripts/verify_platform_admin.sh scripts/verify_approval_decision.sh scripts/verify_auth_hardening.sh scripts/verify_push_registration.sh scripts/verify_push_notifier.sh scripts/verify_notification_mute.sh scripts/verify_linkshort.sh scripts/push_relay_keygen.sh scripts/verify_push_relay.sh scripts/verify_plugin_registry.sh scripts/verify_signed_webhook_ingress.sh scripts/verify_drive_mcp.sh scripts/verify_attachment_upload.sh scripts/verify_plugin_grant_roundtrip.sh scripts/verify_huddle_lifecycle.sh scripts/verify_workspace_search.sh scripts/verify_thread_reply.sh scripts/verify_work_session.sh scripts/verify_work_control.sh scripts/verify_work_agent_e2e.sh scripts/verify_workd.sh scripts/verify_workd_attach.sh scripts/verify_work_pool.sh scripts/verify_tier_fallback.sh scripts/verify_t3_migration_repair.sh scripts/verify_t3_provider_continuity.sh scripts/verify_t3_convergence.sh scripts/verify_membership_lifecycle.sh scripts/verify_lifecycle_completion.sh scripts/verify_memory_search.sh scripts/verify_context_packet.sh scripts/verify_memory_grant.sh scripts/verify_agent_card_onboarding.sh scripts/verify_agent_profile.sh scripts/verify_openapi_contract.sh scripts/verify_openapi_contract_rust.sh scripts/openapi_spec_to_json.sh scripts/verify_relay.sh scripts/verify_realtime_live.sh scripts/verify_agent_worker_bootstrap.sh scripts/verify_agent_worker.sh scripts/verify_agent_path_equivalence.sh scripts/verify_agent_context_bootstrap.sh scripts/verify_agent_context.sh scripts/verify_agent_live_channel_bootstrap.sh scripts/verify_agent_live_channel.sh scripts/verify_hermes_verifier_bootstrap.sh scripts/verify_external_agent_provider.sh scripts/verify_local_hermes_bridge.sh scripts/verify_hermes_gateway_adapter.sh scripts/verify_hermes_gateway_real_smoke.sh scripts/verify_local_hermes_credentialed_smoke.sh scripts/verify_staging_smoke.sh scripts/verify_internal_hosting_smoke.sh scripts/web_serving_smoke.sh scripts/verify_web_serving.sh scripts/verify_web_login_smoke.sh scripts/verify_web_generated_types.sh scripts/verify_internal_host_runtime.sh scripts/verify_backup_restore_rehearsal.sh infra/prod/install.sh infra/prod/upgrade.sh infra/prod/momo-ops.sh infra/prod/deploy-lib.sh infra/prod/docker/momo-entrypoint.sh infra/workd/bootstrap.sh infra/workd/momo-workd-run infra/eve/bootstrap_world.sh infra/eve/entrypoint.sh; do [ -e "$f" ] || { echo "missing shell script: $f"; exit 1; }; bash -n "$f"; done'
  add_cmd_once "Rust image publication contract" 'python3 scripts/tests/test_publish_images_contract.py'
  add_cmd_once "self-host local-build/published-digest mode contract" 'scripts/tests/test_self_host_env_modes.sh'
  add_note_once coverage "#1266 Rust publish/self-host security contract: the manual workflow must reject non-main refs before publishing, cross the release Environment, use full-SHA actions, build server-rust/Dockerfile for native linux/amd64, push the image, and bind the canonical subject name plus returned digest to an OCI SLSA attestation; mutation fixtures turn each boundary red and a fake gh locks deploy-lib to the repository plus SLSA v1. The behavioral self-host fixture proves both image modes stay separate, all seven rendered Compose consumers use the exact published digest despite ambient overrides, env-file newline/duplicate injection fails without secret output, and ports are strict decimal before arithmetic."
  add_cmd_once "pgvector image and migration drift contract" "scripts/verify_pgvector_contract.sh"
  add_cmd_once "eve compose profile drift contract" "scripts/verify_eve_profile.sh --config-only"
  add_cmd_once "shell syntax" 'for f in .conductor/setup.sh adapters/prime/run.sh adapters/prime/container/entrypoint.sh adapters/prime/tests/tenancy_probe.sh scripts/momo scripts/local_gate.sh scripts/planning_context.sh scripts/self_host_env.sh scripts/runtime_process_guard.sh scripts/ensure_runtime_env.sh scripts/check_branch_skew.sh scripts/check_track_alignment.sh scripts/github_track_guardrails.sh scripts/verify_policy_integrity.sh scripts/check_migration_numbers.sh scripts/check_cargo_licenses.sh scripts/check_secrets.sh scripts/check_compose_env_templates.sh scripts/check_design_review_wiring.sh scripts/write_sha256_manifest.sh scripts/install_branch_skew_hook.sh scripts/hooks/pre-push scripts/tests/fixtures/pre-push-branch-skew-v1 scripts/tests/test_license_gate.sh scripts/tests/test_secrets_gate.sh scripts/tests/test_track_alignment_guard.sh scripts/tests/test_github_track_guardrails.sh scripts/tests/test_pr_ci_guardrails.sh scripts/tests/test_policy_integrity_gate.sh scripts/tests/test_compose_env_template_gate.sh scripts/tests/test_self_host_env_modes.sh scripts/tests/test_local_gate_hardening.sh scripts/tests/test_local_gate_drift_guard.sh scripts/tests/test_local_gate_lint_timeout.sh scripts/tests/test_goal_claim_base_resolution.sh scripts/tests/test_make_deploy_bundle.sh scripts/cleanup_dogfood_seed_agents.sh scripts/local_soak_monitor.sh scripts/collect_diagnostics.sh scripts/compose_janitor.sh scripts/local_alpha_runner.sh scripts/make_deploy_bundle.sh scripts/goal_claim.sh scripts/goal_status.sh scripts/goal_release.sh scripts/github_bootstrap.sh scripts/github/bootstrap.sh scripts/migrate.sh scripts/prod_env_preflight.sh scripts/aws_internal_alpha_preflight.sh scripts/verify_prod_install_upgrade.sh scripts/verify_multibinary_image.sh scripts/verify_momo_ops.sh scripts/verify_momo_ops_runtime.sh scripts/verify_prod_rls_posture.sh scripts/verify_owner_bootstrap.sh scripts/verify_owner_bootstrap_rust.sh scripts/design_preflight_web.sh scripts/verify_pgvector_contract.sh scripts/verify_eve_profile.sh scripts/verify_runtime_role_bootstrap.sh scripts/verify_prod_seed_password.sh scripts/verify_rls.sh scripts/verify_roster.sh scripts/verify_channel_list.sh scripts/verify_channel_management.sh scripts/verify_join.sh scripts/verify_platform_admin.sh scripts/verify_approval_decision.sh scripts/verify_auth_hardening.sh scripts/verify_push_registration.sh scripts/verify_push_notifier.sh scripts/verify_notification_mute.sh scripts/verify_linkshort.sh scripts/push_relay_keygen.sh scripts/verify_push_relay.sh scripts/verify_plugin_registry.sh scripts/verify_signed_webhook_ingress.sh scripts/verify_drive_mcp.sh scripts/verify_attachment_upload.sh scripts/verify_plugin_grant_roundtrip.sh scripts/verify_huddle_lifecycle.sh scripts/verify_workspace_search.sh scripts/verify_thread_reply.sh scripts/verify_work_session.sh scripts/verify_work_control.sh scripts/verify_work_agent_e2e.sh scripts/verify_workd.sh scripts/verify_workd_attach.sh scripts/verify_work_pool.sh scripts/verify_tier_fallback.sh scripts/verify_t3_migration_repair.sh scripts/verify_t3_provider_continuity.sh scripts/verify_t3_convergence.sh scripts/verify_membership_lifecycle.sh scripts/verify_lifecycle_completion.sh scripts/verify_memory_search.sh scripts/verify_context_packet.sh scripts/verify_memory_grant.sh scripts/verify_agent_card_onboarding.sh scripts/verify_agent_profile.sh scripts/verify_openapi_contract.sh scripts/verify_openapi_contract_rust.sh scripts/openapi_spec_to_json.sh scripts/verify_relay.sh scripts/verify_realtime_live.sh scripts/verify_agent_worker_bootstrap.sh scripts/verify_agent_worker.sh scripts/verify_agent_path_equivalence.sh scripts/verify_agent_context_bootstrap.sh scripts/verify_agent_context.sh scripts/verify_agent_live_channel_bootstrap.sh scripts/verify_agent_live_channel.sh scripts/verify_hermes_verifier_bootstrap.sh scripts/verify_external_agent_provider.sh scripts/verify_local_hermes_bridge.sh scripts/verify_hermes_gateway_adapter.sh scripts/verify_hermes_gateway_real_smoke.sh scripts/verify_local_hermes_credentialed_smoke.sh scripts/verify_staging_smoke.sh scripts/verify_internal_hosting_smoke.sh scripts/web_serving_smoke.sh scripts/verify_web_serving.sh scripts/verify_web_login_smoke.sh scripts/verify_web_generated_types.sh scripts/verify_internal_host_runtime.sh scripts/verify_backup_restore_rehearsal.sh infra/prod/install.sh infra/prod/upgrade.sh infra/prod/momo-ops.sh infra/prod/deploy-lib.sh infra/prod/docker/momo-entrypoint.sh infra/workd/bootstrap.sh infra/workd/momo-workd-run infra/eve/bootstrap_world.sh infra/eve/entrypoint.sh; do [ -e "$f" ] || { echo "missing shell script: $f"; exit 1; }; bash -n "$f"; done'
  add_cmd_once "metrics verifier shell syntax" "bash -n scripts/verify_metrics_observability.sh"
  add_cmd_once "trusted policy runner shell syntax" "bash -n scripts/verify_policy_integrity_from_base.sh scripts/tests/test_trusted_policy_runner.sh"
  add_cmd_once "message interaction verifier shell syntax" "bash -n scripts/verify_message_interaction.sh"
  add_cmd_once "production migration entrypoint shell syntax" "bash -n infra/prod/docker/internal-smoke-migrate.sh"
  add_cmd_once "agent cancel verifier shell syntax" "bash -n scripts/verify_agent_run_cancel.sh"
  add_cmd_once "agent run history verifier shell syntax" "bash -n scripts/verify_agent_run_history.sh"
  add_cmd_once "Hosted Agent Port verifier shell syntax" "bash -n scripts/verify_agent_port.sh"
  add_cmd_once "Hosted Agent Port cleanup ownership contract" "scripts/verify_agent_port.sh --verify-cleanup-contract"
  add_cmd_once "Hosted agent inbox verifier shell syntax" "bash -n scripts/verify_hosted_agent_inbox.sh"
  add_cmd_once "Hosted agent inbox cleanup ownership contract" "scripts/verify_hosted_agent_inbox.sh --verify-cleanup-contract"
  add_cmd_once "Agent Port tools verifier shell syntax" "bash -n scripts/verify_agent_port_tools.sh"
  add_cmd_once "Agent Port tools cleanup ownership contract" "scripts/verify_agent_port_tools.sh --verify-cleanup-contract"
  add_cmd_once "Hosted disconnect verifier shell syntax" "bash -n scripts/verify_hosted_disconnect.sh"
  add_cmd_once "Hosted disconnect cleanup ownership contract" "scripts/verify_hosted_disconnect.sh --verify-cleanup-contract"
  add_cmd_once "Agent Port OAuth verifier shell syntax" "bash -n scripts/verify_agent_port_oauth.sh"
  add_cmd_once "Agent Port OAuth cleanup ownership contract" "scripts/verify_agent_port_oauth.sh --verify-cleanup-contract"
  add_cmd_once "Display attach verifier shell syntax" "bash -n scripts/verify_display_attach.sh"
  add_cmd_once "Display attach cleanup ownership contract" "scripts/verify_display_attach.sh --verify-cleanup-contract"
  # Daemon-free, so it belongs in the static lane beside the syntax checks: two
  # local peers over a real WebSocket, plus the red proof that the probe catches
  # a producer which negotiates an input datachannel (ADR-0165 D4).
  add_cmd_once "Display signalling view-only contract" "python3 scripts/display_signaling_probe.py"
  add_cmd_once "Display signalling red proof" "python3 scripts/display_signaling_probe.py --prove-red"
  # Same lane for the same reason: the CubeSandbox bootstrap receiver is a
  # stdlib-only program whose invariants need nothing but a loopback socket, and
  # it is the guest half of a contract whose host half (the `cubesandbox`
  # adapter) is already under conformance. Both halves must be provable in one
  # gate run or the two drift apart in silence (#1437).
  add_cmd_once "CubeSandbox bootstrap receiver invariants" \
    "python3 infra/cubesandbox/bootstrap-init/test_bootstrap_init.py"
  add_cmd_once "CubeSandbox bootstrap receiver red proof" \
    "python3 infra/cubesandbox/bootstrap-init/test_bootstrap_init.py --prove-red"
  add_note_once coverage "#1437 CubeSandbox bootstrap receiver via infra/cubesandbox/bootstrap-init/test_bootstrap_init.py: the guest half of the envVars delivery contract is proved by running it — a real process, real HTTP on a loopback socket, and the files and exec'd environment it leaves behind. Covers the delivery landing as mode-0600 files with the workload handed MOMO_WORKD_REGISTRATION_TOKEN_FILE and never the raw token (ADR-0144), four malformed bodies refused 400 with nothing written and the one shot unspent (Cubelet retries), a non-/init path 404, a write failure answered 500 rather than turning create's 201 into a lie, the listener gone at TCP after the delivery lands (ADR-0157 — CubeProxy routes /sandbox/<id>/49983/ unauthenticated), a held-open connection failing closed at --timeout instead of parking PID 1, a second pipelined POST never re-running land(), and a template-baked MOMO_WORKD_REGISTRATION_TOKEN popped from the inherited environment. --prove-red runs four mutants (blocking accepted socket, keep-alive answer, keep-alive answer with the one-delivery guard removed, inherited token left in place) and requires the matching case to go red; each mutation asserts its anchor text was found, so a refactor that moves the repaired code fails loudly instead of proving nothing."
  add_cmd_once "Rust OpenAPI verifier foreign-resource contract" "scripts/verify_openapi_contract_rust.sh --verify-cleanup-contract"
  add_cmd_once "work session verifier shell syntax" "bash -n scripts/verify_work_session.sh"
  add_cmd_once "work session idle verifier shell syntax" "bash -n scripts/verify_work_session_idle.sh"
  add_cmd_once "work control verifier shell syntax" "bash -n scripts/verify_work_control.sh"
  add_cmd_once "work agent E2E verifier shell syntax" "bash -n scripts/verify_work_agent_e2e.sh"
  add_cmd_once "work host verifier shell syntax" "bash -n scripts/verify_work_host.sh"
  add_cmd_once "workd verifier shell syntax" "bash -n scripts/verify_workd.sh"
  add_cmd_once "workd attach verifier shell syntax" "bash -n scripts/verify_workd_attach.sh"
  add_cmd_once "work pool verifier shell syntax" "bash -n scripts/verify_work_pool.sh"
  add_cmd_once "tier fallback verifier shell syntax" "bash -n scripts/verify_tier_fallback.sh"
  add_cmd_once "workstream continuity verifier shell syntax" "bash -n scripts/verify_workstream_continuity.sh"
  add_cmd_once "T3 provisioner verifier shell syntax" "bash -n scripts/verify_t3_provisioner.sh"
  add_cmd_once "T3 migration repair verifier shell syntax" "bash -n scripts/verify_t3_migration_repair.sh"
  add_cmd_once "T3 lifecycle concurrency verifier shell syntax" "bash -n scripts/verify_t3_lifecycle_concurrency.sh"
  add_cmd_once "T3 provider continuity verifier shell syntax" \
    "bash -n scripts/verify_t3_provider_continuity.sh"
  add_cmd_once "T3 convergence verifier shell syntax" \
    "bash -n scripts/verify_t3_convergence.sh"
  add_cmd_once "mock provider substrate python syntax" \
    'PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 -m py_compile scripts/mock_provider.py'
  add_cmd_once "work tool profile verifier shell syntax" "bash -n scripts/verify_work_tool_profile.sh"
  add_cmd_once "ACP host verifier shell syntax" "bash -n scripts/verify_acp_host.sh"
  add_cmd_once "terminal attach verifier shell syntax" "bash -n scripts/verify_terminal_attach.sh"
  add_cmd_once "observer attach verifier shell syntax" "bash -n scripts/verify_observer_attach.sh"
  add_cmd_once "agent creation verifier shell syntax" "bash -n scripts/verify_agent_create.sh"
  add_cmd_once "Rust agent credential verifier shell syntax" "bash -n scripts/verify_agent_credentials_rust.sh scripts/tests/test_agent_credentials_verifier_safety.sh"
  add_cmd_once "Rust agent credential verifier ownership regression" "scripts/tests/test_agent_credentials_verifier_safety.sh"
  add_cmd_once "agent card onboarding verifier shell syntax" "bash -n scripts/verify_agent_card_onboarding.sh"
  add_cmd_once "agent profile verifier shell syntax" "bash -n scripts/verify_agent_profile.sh"
  add_cmd_once "agent interaction safety verifier shell syntax" "bash -n scripts/verify_agent_interaction_safety.sh"
  add_cmd_once "membership lifecycle verifier shell syntax" "bash -n scripts/verify_membership_lifecycle.sh"
  add_cmd_once "lifecycle completion verifier shell syntax" "bash -n scripts/verify_lifecycle_completion.sh"
  add_cmd_once "deploy bundle synthetic fixture" 'scripts/tests/test_make_deploy_bundle.sh'
  add_cmd_once "local gate drift guard isolated regression" 'scripts/tests/test_local_gate_drift_guard.sh'
  add_cmd_once "local gate hardening isolated regression" 'scripts/tests/test_local_gate_hardening.sh'
  add_cmd_once "local gate ambient-toolchain timeout/fallback regression" 'scripts/tests/test_local_gate_lint_timeout.sh'
  add_note_once coverage "#1376 ambient-toolchain hardening: the actionlint step now runs under a bg+kill hard timeout (MOMO_GATE_ACTIONLINT_TIMEOUT, default 120s — macOS has no coreutils timeout) that reaps the linter and its shellcheck grandchildren, then retries exactly once with -shellcheck= and prints a DEGRADED notice naming what the retry no longer covers; a genuine actionlint finding is still a hard failure and is never retried into green, and the not-installed branch still fails closed when workflow files changed. Both YAML parse steps now resolve a psych-capable Ruby by capability probe (a colon-scoped flow scalar, the exact shape of the HAP scope enums at docs/api/openapi.yaml:6771) instead of trusting ambient PATH, so a worker shell that resolves macOS system Ruby 2.6 gets an actionable Homebrew-path message instead of a Psych::SyntaxError blaming a healthy line. scripts/tests/test_local_gate_lint_timeout.sh proves each edge with stub toolchains: spin-then-recover, spin-in-both-modes, real finding not laundered, both not-installed branches, 2.6-only rejection, capability-based selection over a stale candidate, and no leaked spinner or watchdog processes."
  add_cmd_once "goal claim base resolution isolated regression" 'scripts/tests/test_goal_claim_base_resolution.sh'
  add_note_once coverage "#1464 goal claim base resolution: scripts/goal_claim.sh no longer hard-defaults every worktree to origin/main. The base is resolved from explicit, authored signals only — --base flag, BASE_BRANCH env, a track:<name> issue label, a 'Base: <branch>' line in the issue body, the repo's own [engine]/[uxui] title tag, or a track/* checkout — and prints which source decided. docs/TRACKS.md file ownership stays a printed hint because engine-track waves routinely land clients/web and clients/mobile fixes, so path ownership does not imply the integration branch. scripts/tests/test_goal_claim_base_resolution.sh runs the real script against a local bare origin and a fake gh, proving the no-signal fallback still branches from main (and says so), that --base and BASE_BRANCH still win, that an unknown or ambiguous track tag is ignored rather than guessed, that prose merely mentioning track/engine is not a declaration, and that a base absent from origin fails before any mutation."
  add_cmd_once "track alignment isolated regression" 'scripts/tests/test_track_alignment_guard.sh'
  add_cmd_once "GitHub track guardrails isolated regression" 'scripts/tests/test_github_track_guardrails.sh'
  add_cmd_once "PR CI track/contract wiring regression" 'scripts/tests/test_pr_ci_guardrails.sh'
  add_cmd_once "trusted policy integrity isolated regression" 'scripts/tests/test_policy_integrity_gate.sh'
  add_cmd_once "trusted policy base-runner isolated regression" 'scripts/tests/test_trusted_policy_runner.sh'
  add_cmd_once "local alpha Centrifugo agent proxy contract" 'agent_block="$(awk '\''/"name": "agent"/,/},/'\'' scripts/local_alpha_runner.sh)"; work_block="$(awk '\''/"name": "agentwork"/,/},/'\'' scripts/local_alpha_runner.sh)"; printf "%s\n" "$agent_block" | grep -F "\"subscribe_proxy_enabled\": true"; printf "%s\n" "$agent_block" | grep -F "\"channel_regex\": \"^ws[0-9A-Fa-f-]{36}\\\\\\\\.[0-9A-Fa-f-]{36}\\\\\\\\.[0-9A-Fa-f-]{36}$\""; printf "%s\n" "$work_block" | grep -F "\"subscribe_proxy_enabled\": true"; printf "%s\n" "$work_block" | grep -F "\"channel_regex\": \"^ws[0-9A-Fa-f-]{36}\\\\\\\\.[0-9A-Fa-f-]{36}$\""'
  add_cmd_once "python syntax" 'PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 -m py_compile adapters/hermes/momo_adapter.py adapters/hermes/provider_chain.py adapters/hermes/adapter.py scripts/mock_hermes.py scripts/mock_push_relay.py scripts/openapi_shape_check.py scripts/tests/test_openapi_shape_oneof.py scripts/terminal_attach_probe.py scripts/terminal_attach_tls_proxy.py adapters/hermes/tests/test_momo_adapter_contract.py adapters/hermes/tests/test_provider_chain_contract.py adapters/hermes/tests/smoke_momo_adapter.py adapters/prime/__init__.py adapters/prime/adapter.py adapters/prime/prime_adapter.py adapters/prime/oort_client.py adapters/prime/stream_relay.py adapters/prime/refine.py adapters/prime/rpc.py adapters/prime/tests/fake_oort.py adapters/prime/tests/fake_prime.py adapters/prime/tests/mock_provider.py adapters/prime/tests/auto_refine_probe.py adapters/prime/tests/rpc_probe.py adapters/prime/tests/harness_probe.py adapters/prime/tests/test_prime_adapter_contract.py adapters/prime/tests/smoke_prime_adapter.py scripts/tests/test_agent_seed_policy_contract.py scripts/tests/test_push_relay_vocabulary_contract.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 scripts/tests/test_openapi_shape_oneof.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/hermes/tests/test_momo_adapter_contract.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/hermes/tests/test_provider_chain_contract.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/hermes/tests/smoke_momo_adapter.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/prime/tests/test_prime_adapter_contract.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 adapters/prime/tests/smoke_prime_adapter.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 scripts/tests/test_agent_seed_policy_contract.py && PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" python3 scripts/tests/test_push_relay_vocabulary_contract.py'
  add_note_once coverage "#1194 자동 refine 유래·범위·적용 여부: refine_complete에는 트리거 필드가 없어(실측 §3.2) 어댑터가 상수 command를 박고 있었다 — 이제 유래는 관측(호스트 refine 명령의 in-flight 창 · 성공한 compaction_end)에서 정하고, 자동 경로가 실제로 쓰는 session-artifacts/<sid>/harness 파일까지 스캔하며, applied:false 편집은 업스트림(agent-session.js:6283)과 동형으로 걸러낸다. 결함당 red proof 1개가 AutoRefineRedProofs에 있고(수리 되돌리면 각각 빨강), 컨테이너 회귀는 adapters/prime/run.sh auto-refine{,-rejected} — 실제 prime-agent v0.7.0에 세션 ON(프로브 자신의 OORT_PRIME_NO_SESSION=0, 출고 기본값 불변)·--network none·자격증명 0. 목 프로바이더는 리뷰 게이트와 플랜 패스를 구분하지 못해 모든 자동 refine을 조용히 거부하고 있었으므로(실측 §4.5) 그 수리가 이 회귀의 선행 조건이다."
  add_note_once coverage "#1190 uuid5 파생 크로스체크: refine 멱등 키 uuid5(momo.harnessRefi, refinementId)는 Rust(momo-messaging)·Python(adapters/prime) 양측 사본이라, 기대 uuid는 docs/api/harness-refine-client-msg-id.golden.json 한 파일에만 있고 양쪽 테스트가 그 같은 경로를 읽어 대조한다(사본 없음 — Rust는 include_str!이라 파일이 사라지면 빌드가 깨진다). 벡터는 실측 RPC id·observed-drift id에 더해 빈 문자열·한글·BMP 밖·200자 상한·양끝 공백 엣지를 포함하고, 파생 바이트(utf8Hex)를 uuid보다 먼저 대조해 실패가 '인코딩'인지 '파생'인지 구분한다."
}

add_runtime_env_guard_command() {
  add_cmd_once "runtime env drift guard" "bash scripts/ensure_runtime_env.sh"
  add_cmd_once "pre-clean stale gate-owned processes" '. scripts/runtime_process_guard.sh; momo_cleanup_stale_gate_runs "local gate pre-clean"'
  add_final_cleanup_cmd "reap current gate-owned processes" '. scripts/runtime_process_guard.sh; momo_cleanup_gate_marker "$MOMO_GATE_RUN_MARKER" "local gate final cleanup"'
  add_note_once coverage "MOMO-320/MOMO-353 runtime drift guard: generated env keys are validated without printing secrets; a running Centrifugo container must carry the current repo config fingerprint (or fail with an opt-in recreate command); pre-clean and EXIT/final cleanup reap only processes that inherited a valid gate-run ownership marker."
  add_note_once not_covered "MOMO-353 running-config comparison and service recreate require Docker access; worker static verification does not execute them, and momo-main records clean/root runtime evidence before merge."
}

add_diagnostics_commands() {
  add_cmd_once "diagnostics redaction smoke" "scripts/collect_diagnostics.sh --smoke"
  add_note_once coverage "MOMO-224 diagnostics smoke: redaction removes database passwords, API keys, bearer/JWT-shaped tokens, accessToken JSON fields, and password fields before evidence is written."
  add_note_once coverage "MOMO-224 diagnostics collector is best-effort and can emit a directory/tar bundle with markdown summary for server/relay/worker/Centrifugo/macOS/local-gate evidence when those logs exist."
  add_note_once not_covered "The diagnostics smoke does not require live Docker services or a running macOS app; it verifies bundle tooling/redaction shape only."
}

add_swift_commands() {
  # W-S1(#1215): 이 함수에서 두 자리가 은퇴했다.
  #   · mac 디자인 pre-flight 래칫(MOMO-318) — 스캔 대상이 `clients/macOS/Sources`
  #     + `clients/Core/Sources` 둘뿐이었고 그 트리가 삭제됐다. 정본 UI 의 후속은
  #     `scripts/design_preflight_web.sh`(web 프로파일 + 병합 트리 8레인)다.
  #   · SwiftPM 라이선스/THIRD_PARTY 드리프트 게이트 — #1201(base 부터 red, 전
  #     프로파일 차단). 성재 기결정으로 Swift 클라 삭제와 함께 은퇴하고,
  #     현행 스택의 후속은 add_license_commands(#1225, cargo+npm)다.
  # #1226: Makefile 의 `build`/`test` 는 현행 스택(cargo + npm)으로 재조준됐고, 은퇴
  # 중인 Swift 트리 순회는 `swift-build`/`swift-test` 로 이름이 바뀌었다. 여기서 이름을
  # 따라가지 않으면 "swift build" 라벨 아래에서 cargo 가 도는 거짓 증거가 되고, 이
  # 함수를 부르는 runtime-* 프로파일이 곧이어 `swift run` 할 바이너리를 아무도 빌드하지
  # 않게 된다.
  add_cmd_once "swift build" 'DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" make swift-build'
  add_cmd_once "swift test" 'DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" make swift-test'
  add_note_once not_covered "W-S1(#1215): SwiftPM 공급망 게이트(MOMO-556)는 #1201 로 은퇴했다 — 잔존 Swift 트리(server·relay·workers·services)의 SwiftPM 의존 라이선스는 지금 어떤 게이트도 재지 않는다. 현행 스택은 add_license_commands(cargo+npm)가 덮는다."
}

add_staging_smoke_commands() {
  add_cmd_once "staging smoke config verification" "scripts/verify_staging_smoke.sh"
  add_cmd_once "internal single-node hosting smoke verification" "scripts/verify_internal_hosting_smoke.sh"
  add_cmd_once "day-2 operator entrypoint verification" "scripts/verify_momo_ops.sh"
  add_cmd_once "metrics observability runtime verification" "scripts/verify_metrics_observability.sh"
  add_note_once coverage "MOMO-007 local/staging smoke: prod compose config, Caddyfile structure, Centrifugo Redis config, secret-template guard, and SOPS/pgBackRest checklist."
  add_note_once coverage "MOMO-229 public host preflight: tracked staging placeholder env fails fast, synthetic public/staging env shape passes, and redacted prod-env-preflight-staging.md/json evidence covers DNS/TLS env, pinned registry image tags, SOPS/age or host-local secret source, named DB/Redis volumes, and pgBackRest WAL/full-backup/PITR required env."
  add_note_once coverage "MOMO-406 install/upgrade static matrix: non-interactive input rejection, per-service sha256 digest enforcement, preflight/compose-config wiring, ordered one-shot migration, backup evidence gate, sequential restart, and previous-image app rollback with forward-only database disclosure."
  add_note_once coverage "MOMO-560 day-2 entrypoint: status-only placeholder exception, strict preflight for other commands, existing upgrade delegation, env-only migrate-image member/invite DB paths, and mode-0600 one-time invite output."
  add_note_once coverage "MOMO-216 internal single-node hosting smoke: prod compose + internal smoke override config, env template guard, Caddy/TLS static wiring, Centrifugo Redis engine, explicit migration path, API health route wiring, relay/worker enablement, and backup/restore placeholder boundary."
  add_note_once coverage "MOMO-562 metrics verifier: cold source builds expose private metrics listeners on reserved 28210-28213 verifier ports, checks the five Prometheus 0.0.4 families and closed APNs code_class values, rejects tenant/content keys, and validates the production observability profile has no public port/network."
  add_note_once not_covered "Real staging VPS URL/TLS, public TLS/DNS, registry image pull/run, SOPS production secret injection, pgBackRest stanza/check/full backup/PITR restore rehearsal, and external hermes staging connectivity remain runtime-unverified without host secrets/infrastructure."
}

add_host_runtime_commands() {
  add_cmd_once "multi-command image six-command smoke" "scripts/verify_multibinary_image.sh"
  add_cmd_once "internal host-runtime smoke verification" "scripts/verify_internal_host_runtime.sh"
  add_backup_commands
  add_note_once coverage "MOMO-565 multi-command image smoke: one swift:6.2-noble image builds all Swift products, bundles migration/web/LICENSE/NOTICE payloads, and boots api/relay/worker/migrate/linkshort/web-assets on reserved ports 28240-28243."
  add_note_once coverage "MOMO-220/MOMO-227 host-runtime smoke: one local momo multi-command image plus mock-Hermes are built, prod compose + internal-smoke overlay boots without source bind mounts, migration one-shot plus idempotent re-run succeeds, Caddy/internal /health returns 200, /v1/agent-runtime/status reports internal-host-mock/mock without provider secret leakage, REST login/message send publishes through OutboxRelay to Centrifugo history, and @김인턴 mock Hermes agent roundtrip publishes agent progress plus final channel message.new."
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
  add_cmd "Centrifugo post-start running-config verification" "bash scripts/ensure_runtime_env.sh"
  # env 파일/프로파일이 MIGRATE_IDEMPOTENCY_CHECK=0을 품고 있어도 게이트 단정이
  # 조용히 꺼지지 않도록(리뷰 high) env를 강제하고 IDEMPOTENCY_OK 마커를 직접 단정한다.
  add_cmd "migrate apply + idempotency verify (single run)" "out=\"\$(MOMO_AGENT_SEED_MODE=e2e MIGRATE_IDEMPOTENCY_CHECK=1 make migrate 2>&1)\"; status=\$?; printf '%s\n' \"\$out\"; [ \$status -eq 0 ] && printf '%s\n' \"\$out\" | grep -F '[migrate] IDEMPOTENCY_OK second-pass applied=0'"
  BOOTSTRAP_ADDED=1
}

add_runtime_db_commands() {
  add_runtime_bootstrap_commands
  add_cmd "Fresh migration-before-role bootstrap verification" "scripts/verify_runtime_role_bootstrap.sh"
  add_cmd "Production seed password fail-closed verification (MOMO-408)" "scripts/verify_prod_seed_password.sh"
  add_cmd "Initial owner migrate-image bootstrap verification (MOMO-561)" "scripts/verify_owner_bootstrap.sh"
  add_cmd "Day-2 operator DB path verification (MOMO-560)" "scripts/verify_momo_ops_runtime.sh"
  add_cmd "RLS runtime verification" "scripts/verify_rls.sh"
  add_cmd "Production API RLS posture verification (MOMO-554)" "scripts/verify_prod_rls_posture.sh"
  add_note_once coverage "MOMO-554 production RLS posture via scripts/verify_prod_rls_posture.sh: prod compose consumes idempotent momo_app/momo_relay/momo_worker provisioning, API starts as momo_app on reserved 28170-28173 ports, current_user is NOSUPERUSER+NOBYPASSRLS, cross-workspace reads return zero, plugin_registry writes are denied, and a superuser API URL makes MomoServer exit fail-closed."
  add_note_once coverage "MOMO-560 operator DB path via scripts/verify_momo_ops_runtime.sh: pinned migrate image on reserved port 28220 lists human/agent members, creates an env-only invite whose raw bearer is absent from argv/logs and database plaintext, and persists the expected hash, role, actor, metadata, and audit row."
  add_cmd "Workspace roster runtime verification" "scripts/verify_roster.sh"
  add_cmd "Workspace channel list runtime verification" "scripts/verify_channel_list.sh"
  add_cmd "Workspace channel management runtime verification" "scripts/verify_channel_management.sh"
  add_cmd "Membership lifecycle verification (MOMO-523)" "scripts/verify_membership_lifecycle.sh"
  add_note_once coverage "MOMO-523 membership lifecycle via scripts/verify_membership_lifecycle.sh: isolated API stack on reserved 28050-28053 ports verifies migration backfill, centralized workspace roles, workspace/channel hierarchy, last-owner 409, suspend token/login denial, reinstate, removal with message preservation, invite redeem/public join bans and unban rejoin, guest roster/channel/search projection, audit rows, and FORCE RLS isolation."
  add_cmd "Memory Plane lifecycle verification (MOMO-526)" "scripts/verify_memory_plane.sh"
  add_note_once coverage "MOMO-526 Memory Plane via scripts/verify_memory_plane.sh: isolated API/worker stack on reserved 28030-28033 ports verifies deterministic mock ADD/UPDATE/INVALIDATE/NOOP extraction, channel watermark progression, identifier-only source refs, lifecycle/audit evidence, transactional closed memory.updated outbox payloads, FORCE RLS isolation, and admin policy-off bulk purge. Real external Hermes extraction remains credential opt-in."
  add_cmd "Hybrid memory retrieval verification (MOMO-527)" "scripts/verify_memory_search.sh"
  add_note_once coverage "MOMO-527 hybrid memory search via scripts/verify_memory_search.sh: pinned pgvector PG18 image, async 384-dimensional deterministic mock backfill, FTS-only/vector-only/RRF fusion, scope+agent filters, FORCE RLS isolation, and dedicated rate limiting on reserved 28090-28093 ports. Real external Hermes embeddings remain credential opt-in/runtime-unverified."
  add_cmd "Immutable Context Packet verification (MOMO-528)" "scripts/verify_context_packet.sh"
  add_note_once coverage "MOMO-528 Context Packet via scripts/verify_context_packet.sh: isolated API stack on reserved 28100-28103 ports verifies repeat-read immutability, expiry reissue, real capability projection/no mock, profile+query memory scopes, active visibility grant then revoke exclusion, worker/gateway payload parity, and FORCE RLS isolation."
  add_cmd "Memory visibility grant CRUD verification (MOMO-549)" "scripts/verify_memory_grant.sh"
  add_note_once coverage "MOMO-549 memory visibility grant via scripts/verify_memory_grant.sh: isolated API stack on preflight-checked 28160-28163 ports verifies scope-subject/admin/agent-owner authorization, active human/agent validation, grant and idempotent revoke audit, migration 030 search visibility, Context Packet reissue exclusion, and FORCE RLS isolation."
  add_cmd "Lifecycle completion verification (MOMO-524)" "scripts/verify_lifecycle_completion.sh"
  add_note_once coverage "MOMO-524 lifecycle completion via scripts/verify_lifecycle_completion.sh: isolated API stack on reserved 28060-28063 ports verifies public/private/DM self-leave, private last-member archive, workspace last-owner guard, token revocation with message preservation, agent suspend/remove credential revocation and gateway denial, explicit credential reissue after reinstate, banned-handle creation/pairing denial, admin audit filters/cursor, and FORCE RLS isolation."
  add_cmd "Agent-global run history verification (MOMO-653)" "scripts/verify_agent_run_history.sh"
  add_note_once coverage "MOMO-653 agent-global run history via scripts/verify_agent_run_history.sh: isolated API stack on reserved 28380-28383 ports verifies actual-login nonmember 403, active channel visibility, newest-first insertion-stable UUID cursors including empty pages, target-agent and cross-workspace filtering, FORCE RLS, bounded credential-free summary fields, and same-run parity with the channel list."
  add_cmd "Public join runtime verification" "scripts/verify_join.sh"
  add_cmd "Platform admin read-only runtime verification" "scripts/verify_platform_admin.sh"
  add_cmd "Approval decision endpoint runtime verification" "scripts/verify_approval_decision.sh"
  add_cmd "Auth hardening runtime verification (MOMO-300)" "scripts/verify_auth_hardening.sh"
  add_cmd "Hosted Agent Port dual-era runtime verification (#1363)" "scripts/verify_agent_port.sh"
  add_note_once coverage "#1363 Hosted Agent Port via scripts/verify_agent_port.sh: isolated PostgreSQL 18 and the real Rust/Axum router verify modern 2026-07-28 plus legacy 2025-11-25 negotiation, agent-only bearer scope/revoke/expiry/FORCE-RLS boundaries, bounded audit provenance, stateless POST-only transport, empty discovery/tool inventory, token/agent/socket-peer abuse axes, zero product writes, and a source-checkout-free deploy-image smoke."
  add_cmd "Hosted agent durable inbox verification (#1365)" "scripts/verify_hosted_agent_inbox.sh"
  add_note_once coverage "#1365 hosted inbox via scripts/verify_hosted_agent_inbox.sh: a verifier-owned pinned PG18 instance proves connection-local ordering, source-reference integrity, opaque bound cursor behavior, current scope/member/profile/channel visibility, append-only/RLS boundaries, rollback, concurrency, and reconnect namespace isolation."
  add_cmd "Agent Port tool surface verification (#1366)" "scripts/verify_agent_port_tools.sh"
  add_cmd "Hosted agent disconnect lifecycle verification (#1367)" "scripts/verify_hosted_disconnect.sh"
  add_cmd "Agent Port OAuth authorization server verification (#1368)" "scripts/verify_agent_port_oauth.sh"
  add_cmd "T3 display attach verification (#1409)" "scripts/verify_display_attach.sh"
  add_note_once coverage "#1409 T3 display attach via scripts/verify_display_attach.sh: a verifier-owned pinned PG18 instance plus the real Rust/Axum router prove the ADR-0165 capability plane as a second KIND of the existing terminal-attach machine rather than a parallel one — a display binding published only by the session's own signing host (human bearer 403, foreign host 403, republish idempotent, a different binding 409, a credentialed or non-wss signalling URL refused before the lock), issuance that is observer-only with controller answered 403 by name and migration 075's CHECK refusing a controllable display row written around the route, fail-closed refusal for a host that does not advertise display_attach (which is also how BYOC is excluded without policy naming a provider) and for a session with no binding, mutual non-substitutability of display and terminal bearers on each other's validate route, remoteDisplayAvailable answered identically by the list, reattach and RETURNING projections beside an unchanged kind-blind observer count and its count-only outbox envelope, and revocation reaching an already-open stream when observation closes, the grantee leaves the channel, or the operator withdraws the host's display advertisement. The signalling half is proved separately and honestly by two local peers in scripts/display_signaling_probe.py (subprotocol, server-vouched capability, an SDP offer with no application m-line, and an input request refused without renegotiation), with a red proof; no CubeSandbox microVM was built or booted, so the producer itself stays runtime-unverified and browser-to-sandbox ICE reachability remains unmeasured (infra/cubesandbox/display-template/README.md)."
  add_note_once coverage "#1368 Agent Port OAuth 2.1 authorization server via scripts/verify_agent_port_oauth.sh: a verifier-owned pinned PG18 instance plus the real Rust/Axum router prove the no-bearer-downgrade spine (every OAuth surface 404 with the flag off; the static-bearer Agent Port path byte-identical with the flag on and off, WWW-Authenticate challenges pinned to frozen literals; static/oauth/refresh/code envelopes non-substitutable because the stored digest covers the whole envelope; migration 074's trigger refusing either credential class on a connection whose auth_mode did not choose it), RFC 9728/8414 metadata that names the operator's issuer and canonical resource under Host/Forwarded spoofing and advertises no DCR, no Client ID Metadata Document, no client secret and no plain PKCE, an authorize endpoint that writes zero rows and refuses an unregistered client or redirect without redirecting, exactly one terminal owner/admin consent decision under duplicate approve/deny with the dedicated agent still paused until the exchange, out-of-ceiling and unrequested scopes refused before any code with bounded secret-free denial audits, the exchange attack matrix (wrong verifier, plain-as-verifier, wrong/unregistered redirect, wrong/absent resource, unknown client, foreign workspace code, unknown grant, expired code) failing closed with code-only bodies, refresh rotation plus code-replay and refresh-reuse each retiring the whole credential family with one audit row, RFC 7009 revocation that is never an existence oracle, an OAuth access credential that is a principal only at /v1/mcp/agent-port with zero mutations on message POST, three gateway verbs and realtime-token REST, and FORCE RLS isolation of authorization requests."
  add_note_once coverage "#1367 hosted disconnect via scripts/verify_hosted_disconnect.sh: a verifier-owned pinned PG18 instance plus the real Rust/Axum router prove the disconnect start as ONE transaction (bearer revoke + cleanup_pending + dedicated agent pause + open gateway job suppression with lease release + per-kind manifest seed + exactly one audit row) with a forced pause failure rolling every effect back; all eight Agent Port tools, the lease verbs holding a handle claimed a moment earlier, the inbox cursor and the foundation request itself closing at once; the #1344 negatives (a connector uninstall never resolving local_plugin_files, an inactive routine staying an observation) and both legal bot dispositions with zero message rows created or deleted; the terminal transition refused while anything required is unresolved, then exactly once and idempotent on replay, with migration 072 refusing a false terminal written around the transition; a reconnect namespace in which the old bearer, sealed lease handle and cursor all keep failing; a disconnect racing a claim leaving one serial outcome with zero claimable jobs and zero leases; an out-of-band credential revoke reconciled fail-closed by the first domain guard and scoped to its own connection so a sibling is untouched; and non-enumerable refusals for ordinary members, foreign workspaces, absent ids and agent bearers."
  add_note_once coverage "#1366 Agent Port tools via scripts/verify_agent_port_tools.sh: a verifier-owned pinned PG18 instance plus the real Rust/Axum router prove the eight thin-binding tools, the connection x token x capability scope intersection across every hosted lifecycle state (connect-only lists and calls nothing), the single momo-messaging write path with client_msg_id idempotency and exactly one outbox row, opaque lease-handle claim/renew/release races, idempotent run event/complete terminal rules with one usage row, non-enumerable unapproved/absent channel refusals, migration 071 outbox-kind and job-run adversarial rejections, the token audience/actor/connection axes, a mixed managed+hosted workspace, and the inactive-hosted fail-closed path that never falls back to a managed provider."
  add_cmd "Push device registration runtime verification (MOMO-403)" "scripts/verify_push_registration.sh"
  add_cmd "Push notifier runtime verification (MOMO-404)" "scripts/verify_push_notifier.sh"
  add_cmd "Channel notification mute verification (MOMO-477)" "scripts/verify_notification_mute.sh"
  add_cmd "Plugin registry runtime verification (MOMO-410)" "scripts/verify_plugin_registry.sh"
  add_note_once coverage "MOMO-410 plugin registry via scripts/verify_plugin_registry.sh: isolated e2e compose API stack, official GitHub/Notion/Linear manifest seeds, whitelist validator rejection matrix (unknown protocol/risk/approval policy, GPL, malformed, digest mismatch, revoked), active-member catalog, owner/admin install policy, delegated-user grant four-tuple, install/grant/revoke audit rows, immediate Capability Cache projection invalidation, raw credential marker non-persistence/non-response/non-audit, cross-workspace 403, and FORCE RLS tenant isolation."
  add_cmd "Signed webhook ingress runtime verification (MOMO-412)" "scripts/verify_signed_webhook_ingress.sh"
  add_cmd "Hosted read-only Drive MCP runtime verification (MOMO-457)" "scripts/verify_drive_mcp.sh"
  add_cmd "Drive archive attachment upload runtime verification (MOMO-474)" "scripts/verify_attachment_upload.sh"
  add_cmd "S3/MinIO attachment upload runtime verification (MOMO-521)" "ATTACHMENT_GATE_BACKEND=s3 scripts/verify_attachment_upload.sh"
  add_cmd "Plugin grant Context Packet roundtrip (MOMO-449/458)" "scripts/verify_plugin_grant_roundtrip.sh"
  add_cmd "Huddle lifecycle + LiveKit JWT verification (MOMO-468)" "scripts/verify_huddle_lifecycle.sh"
  add_cmd "Workspace message search verification (MOMO-475)" "scripts/verify_workspace_search.sh"
  add_note_once coverage "MOMO-475 workspace search via scripts/verify_workspace_search.sh: isolated e2e API stack verifies active channel membership hard filtering, DM inclusion, deleted-message exclusion, Korean/English mixed matching, bounded snippets with offsets, insertion-stable keyset cursors, search-specific 30/min member limiting, FORCE RLS isolation, and EXPLAIN use of message_body_trgm_idx."
  add_note_once coverage "MOMO-468 huddle lifecycle via scripts/verify_huddle_lifecycle.sh: isolated e2e compose API stack without LiveKit, idempotent start, two-member join/leave and last-leave end, Python HS256+claims verification, active transition, cross-workspace 403, momo_app FORCE RLS isolation, and exact started/participants-changed/ended outbox plus audit rows."
  add_cmd "Thread reply + atomic rollup verification (MOMO-476)" "scripts/verify_thread_reply.sh"
  add_note_once coverage "MOMO-476 thread replies via scripts/verify_thread_reply.sh: isolated e2e compose API stack, same-channel undeleted top-level root validation, cross-channel 404 non-disclosure, deleted/nested root 400, response/history/realtime root projection, idempotent retry, concurrent atomic reply_count rollup, participant/last-reply assertions, and FORCE RLS isolation."
  add_cmd "Thread projection + replies + AgentWorker root preservation (MOMO-479)" "scripts/verify_thread_projection.sh"
  add_note_once coverage "MOMO-479 thread projection via scripts/verify_thread_projection.sh: isolated e2e api/relay/worker stack on reserved X-3 ports, top-level history and idempotent-send rollups, ascending cursor reply recovery including tombstones, delivered Centrifugo thread.updated, threaded @hermes durable response root_id preservation with atomic rollup/participant update, and FORCE RLS cross-tenant isolation."
  add_cmd "Message interaction verification (MOMO-478/480)" "scripts/verify_message_interaction.sh"
  add_note_once coverage "MOMO-478/480 message interactions via scripts/verify_message_interaction.sh: isolated e2e API/relay stack verifies author-only non-empty edit, author-only body-null tombstone and reaction cleanup, idempotent add/remove/delete, non-member denial, 32-character emoji and 200-row cap, direct message-to-emoji-to-member snapshot, message.new-established channel version followed by all four Core realtime payload kinds in Centrifugo history, unchanged message/channel seq, audit body privacy, and FORCE RLS isolation."
  add_cmd "Work session ledger + card/thread verification (MOMO-483)" "scripts/verify_work_session.sh"
  add_note_once coverage "MOMO-483 work sessions via scripts/verify_work_session.sh: isolated e2e API/relay stack on reserved 27910-27913 ports verifies lifecycle create/list/end, exact running/ended system-card history props, same-card thread reply reuse, started/ended no-version delivery after message.new establishes the channel version, unique idempotency keys, unchanged card/channel seq on end, owner-only mutation, FORCE RLS cross-tenant isolation, and absence of cwd/path/process/provider state."
  add_cmd "Work session idle lifecycle + WorkHost signing verification (MOMO-648/657)" "scripts/verify_work_session_idle.sh"
  add_note_once coverage "MOMO-648/657 via scripts/verify_work_session_idle.sh: isolated API/relay/notifier/mock-push stack on reserved 28230-28234 ports rejects captured-signature body substitution and duplicate request IDs, verifies replay-row cleanup and a fresh signed normal path, then drives running-to-idle-to-running, idle timeout, and disconnect-to-orphaned lifecycle assertions. WORK_HOST_SIGNING_GATE_PROVE_RED_BODY_DIGEST=1 removes the body digest in an isolated source copy and requires the named body-substitution assertion to fail."
  add_cmd "Work control approval + dispatch/ack verification (MOMO-484)" "scripts/verify_work_control.sh"
  add_note_once coverage "MOMO-484 work controls via scripts/verify_work_control.sh: isolated e2e API/relay stack on reserved 27920-27923 ports verifies agent-only spawn, approval_request reuse, pending/denied dispatch bypass prevention, no-version dispatched/acked delivery, work_session FK ack binding, owner auto-approve with same-transaction audit, nonrunning input rejection, closed payload keys, and FORCE RLS tenant isolation."
  add_cmd "AgentWorker work tool chat-to-session E2E (MOMO-486)" "scripts/verify_work_agent_e2e.sh"
  add_note_once coverage "MOMO-486 work tools via scripts/verify_work_agent_e2e.sh: isolated e2e API/relay/worker/mock-Hermes stack on reserved 27930-27933 ports verifies mention-routed work_spawn, truthful pending-approval thread reply and terminal run, human approval without worker resume, host session/card plus dispatched/acked/started delivery, lineage work_input with no duplicate reply, exact foreign-lineage HTTP 403 thread reply, and FORCE RLS tenant isolation."
  add_cmd "Work host registry + control routing verification (MOMO-487)" "scripts/verify_work_host.sh"
  add_note_once coverage "MOMO-487 work hosts via scripts/verify_work_host.sh: isolated e2e API/relay stack on reserved 27940-27943 ports verifies member/workspace registration, boolean-only capability metadata, Ed25519 signed heartbeat and forged rejection, polling online state, owner/admin revoke with same-transaction audit, 404 non-disclosure, member-scope 403, registered dispatch, revoke-before-dispatch failed settlement plus delivered no-version work.control.acked, validated host FKs, and FORCE RLS tenant isolation."
  add_cmd "Outbound work host daemon verification (MOMO-488)" "scripts/verify_workd.sh"
  add_note_once coverage "MOMO-488 workd via scripts/verify_workd.sh: isolated e2e API stack on reserved 27950-27953 ports starts the host Swift binary, verifies 0600 Ed25519 identity plus one-shot registration-token deletion, signed heartbeat/poll, auto-approved spawn dispatch, local shell-wrapped PTY mock output, ack and the work_session running-to-idle host report followed by the owner idle-to-ended transition (MOMO-672: the #857 login-shell wrapper made idle, not ended, the natural tool-exit status), forged poll 401, raw-output server-ledger absence, and FORCE RLS tenant isolation."
  add_cmd "Terminal attach standing round trip (MOMO-674)" "scripts/verify_workd_attach.sh"
  add_note_once coverage "MOMO-655/674 attach via scripts/verify_workd_attach.sh: the MOMO-488 fixture extended (WORKD_GATE_ATTACH=1) on reserved 28430-28433 plus API_PORT+71/+72, so a real momo-workd with an attach listener is dialled the way a browser dials it — a self-signed TLS proxy in front of the plaintext listener, the capability in Sec-WebSocket-Protocol: momo.terminal.v1, <token>. Asserts the listener-ready line exactly once, the registered terminal_attach host capability, the daemon-published pty_id/attach_endpoint binding, a server-minted capability plus its audit row, then the #857 contract on the wire: replay bytes carrying the pre-attach marker, exactly one replay_end text frame, send_stdin reaching the pty and its output coming back (the typed text and the expected output differ by a shell-removed '' so terminal echo cannot satisfy it). Then MOMO-674: a second OBSERVER stream is held open, the owner closes observation through ordinary REST, and the stream must be cut with close 1008 with the observer capability rows gone. Finally the attach keystrokes, their output and any raw capability token must be absent from message/audit_log/outbox. Red proof: WORKD_ATTACH_PROVE_RED=replay-marker rebuilds momo-workd from an isolated copy with PTYReplayEndFrame.type renamed and requires the named replay_end stage to fail; the probe also self-tests three broken wires without Docker on every run."
  add_cmd "Work tool profile ledger verification (MOMO-533)" "scripts/verify_work_tool_profile.sh"
  add_note_once coverage "MOMO-533/547 work tool profiles via scripts/verify_work_tool_profile.sh: isolated e2e API stack on preflight-checked reserved 28080-28083 ports verifies the four default seeds, admin CRUD/audit, portable credential/path-free launch templates, name-only environment policy projection/rejection, signed workd GET projection, custom spawn, disabled/unregistered fail-closed rejection, and FORCE RLS tenant isolation."
  add_cmd "ACP host verification (MOMO-531)" "scripts/verify_acp_host.sh"
  add_note_once coverage "MOMO-531 ACP host via scripts/verify_acp_host.sh: a credential-free stdio mock proves initialize, session creation, prompt, progress and plan projection, fail-closed approval allow/reject branches, PTY terminal delegation, and host-local raw boundaries on reserved 28110-28113 ports."
  add_cmd "Workspace work-pool quota verification (MOMO-489)" "scripts/verify_work_pool.sh"
  add_note_once coverage "MOMO-489 work pool via scripts/verify_work_pool.sh: isolated e2e API stack on reserved 27960-27963 ports verifies migration defaults and upsert-on-read, shared slot acquire and machine-readable pool_exhausted/member_limit 409s with no session/card/outbox writes, overlapping acquire serialization at max_active, aggregate release after end, member-readable GET, admin-only PUT with same-transaction cap-increase audit, derived-only schema, and FORCE RLS isolation. Automatic queue start/waiting-card UX and warm execution instances remain follow-ups."
  add_cmd "Host-loss tier fallback verification (MOMO-519)" "scripts/verify_tier_fallback.sh"
  add_note_once coverage "MOMO-519 tier fallback via scripts/verify_tier_fallback.sh: isolated API/relay/notifier/mock-push stack on reserved 28020-28023 ports and 2-second grace verifies stale-heartbeat orphan transition, ask resume_offer card plus momo.work push dispatch, t1_only terminal cleanup without card, manual resume refused for a channel non-member (ADR-0143 D3 replaced the owner-only gate), revoked-host conflict, same-thread lineage and spawn dispatch, auto cloud resume with audit, and FORCE RLS isolation."
  add_cmd "Workstream continuity verification (MOMO-671)" "scripts/verify_workstream_continuity.sh"
  add_note_once coverage "MOMO-671 workstream via scripts/verify_workstream_continuity.sh: isolated e2e API/relay stack on reserved 28410-28413 ports verifies implicit workstream creation on the first Run of a thread, a real-bearer non-member refused 403 on resume and 404 on workstream detail/runs with an empty list projection, a second channel member continuing the orphaned Run into the SAME workstream with the first Run's member_id untouched, execution history listing both actors in order, ledger-level trigger attachment for a directly inserted Run, and workstream FORCE RLS plus absence of host-local/credential columns. Red proof: restore the pre-ADR-0143 owner guard in WorkSessionRoutes.resume and the named channel-member takeover assertion must fail."
  add_cmd "T3 migration fail-closed repair verification (MOMO-665)" "scripts/verify_t3_migration_repair.sh"
  add_note_once coverage "MOMO-665 via scripts/verify_t3_migration_repair.sh: isolated PostgreSQL 18 proves named 051 host/count failure, repeat failure without repair, 050 delegation through the 049 settlement primitive, successful retry plus runner second-pass idempotency, actual MomoServer health, and an already-applied 049 database with the legacy index accepting idempotent 051."
  add_cmd "T3 cross-provider continuity verification (MOMO-670)" "scripts/verify_t3_provider_continuity.sh"
  add_note_once coverage "MOMO-670 via scripts/verify_t3_provider_continuity.sh: a session on mock-a survives its substrate's death — the adapter reports the death honestly, the reconciler converges to a named provider_missing terminal state, and the session resumes on mock-b through the ordinary resume REST with resumed_from_session_id linking the two and exactly one settlement. T3_CONTINUITY_PROVE_RED=dishonest-probe makes mock-a report the dead instance as running; momo refuses to settle on that contradiction and the gate fails by name at provider-missing-convergence."
  add_cmd "T3 lifecycle convergence verification (MOMO-668)" "scripts/verify_t3_convergence.sh"
  add_note_once coverage "MOMO-668 via scripts/verify_t3_convergence.sh: one runtime scenario per ADR-0140 D4 convergence row on an isolated stack with reserved 28070-28075 ports — a refused pause returns to running with the active interval never closed (billing continues), a refused resume returns to paused opening no interval, an expired resuming intent converges on the probe answer without issuing a second resume, a provably gone instance settles once through t3_terminate(provider_missing), and a refused destroy retries with growing backoff then converges the moment the substrate recovers. Migration 057 makes the deadline structural (trigger fills, CHECK forbids a deadline-less *ing row). T3_CONVERGENCE_PROVE_RED=stale-response rewrites t3_lifecycle_intent_is_current to RETURN true in an isolated repo copy and requires the named stale-response-changed-state assertion to fail: without the (operation_id, version) revalidation a superseded pause response closes the billing interval of a sandbox the substrate is still running."
  add_cmd "T3 lifecycle advisory concurrency verification (MOMO-666)" "scripts/verify_t3_lifecycle_concurrency.sh"
  add_note_once coverage "MOMO-666 via scripts/verify_t3_lifecycle_concurrency.sh: two independent PostgreSQL connections prove the reconciler owns the host advisory while REST-end and sweep each wait on the same key, assert that overlap through pg_locks and pg_stat_activity, then complete without deadlock. T3_CONCURRENCY_PROVE_RED=1 omits the REST caller's advisory in the isolated scenario and requires named SQLSTATE 40P01 deadlock detected."
  add_cmd "Terminal attach capability verification (MOMO-511)" "scripts/verify_terminal_attach.sh"
  add_note_once coverage "MOMO-511 terminal attach via scripts/verify_terminal_attach.sh: isolated e2e API/relay stack on reserved 27980-27983 ports verifies MomoHost remote PTY binding, exact owner-only ephemeral grant, signed host validation, expiry rejection, immediate host-revoke invalidation, digest-only storage, audit shape, FORCE RLS, and absence of terminal raw bytes or capability values from server/relay ledgers and logs."
  add_cmd "Observer attach capability verification (MOMO-516)" "scripts/verify_observer_attach.sh"
  add_note_once coverage "MOMO-516 observer attach via scripts/verify_observer_attach.sh: preflight-checked isolated API/relay stack on reserved 28010-28013 ports verifies default controller compatibility, active channel-member observer issue, non-member and agent denial, owner_only invalidation, validation mode, immediate host revoke, valid-grant count plus remote PTY projection, count-only realtime outbox, and FORCE RLS isolation."
  add_cmd "Fresh-DB admin agent creation verification (MOMO-509)" "scripts/verify_agent_create.sh"
  add_note_once coverage "MOMO-509 agent creation via scripts/verify_agent_create.sh: isolated seed-none e2e API stack on preflight-checked reserved 27970-27973 ports verifies admin atomic member(kind=agent)+agent+audit creation, no automatic channel membership, workspace handle duplicate 409 without partial rows, non-admin 403, ADR-0004 endpoint/config credential rejection, explicit existing membership-path reuse, sha256-only agent credential issuance, and member/agent/membership/token/audit FORCE RLS isolation."
  add_cmd "Generic agent credential lifecycle verification (#1358)" "scripts/verify_agent_credentials_rust.sh"
  add_cmd_once "Hosted agent durable inbox verification (#1365)" "scripts/verify_hosted_agent_inbox.sh"
  add_cmd_once "Agent Port tool surface verification (#1366)" "scripts/verify_agent_port_tools.sh"
  add_cmd_once "Hosted agent disconnect lifecycle verification (#1367)" "scripts/verify_hosted_disconnect.sh"
  add_cmd_once "Agent Port OAuth authorization server verification (#1368)" "scripts/verify_agent_port_oauth.sh"
  add_cmd_once "T3 display attach verification (#1409)" "scripts/verify_display_attach.sh"
  add_cmd_once "Hosted agent pairing/activation verification (#1364)" "scripts/verify_openapi_contract.sh"
  add_note_once coverage "#1358 Rust agent credential lifecycle via scripts/verify_agent_credentials_rust.sh: a fresh pinned PG18 database plus the real Axum router running as momo_app verifies owner/admin issue-list-rotate-revoke, one-time no-store reveal and digest-only persistence, closed/non-default scopes, agent/human/tenant/target fail-closed authorization, expiry and revoke authentication, idempotent revoke audit, no secret-shaped response/audit projection, no-expiry-extension, and serialized concurrent rotation. Its adversarial ownership fixture independently proves high-entropy per-invocation naming and fail-closed cleanup across id, name, label, and create-collision takeovers without deleting a foreign container."
  add_cmd "A2A Agent Card onboarding verification (MOMO-536)" "scripts/verify_agent_card_onboarding.sh"
  add_note_once coverage "MOMO-536 Agent Card onboarding via scripts/verify_agent_card_onboarding.sh: isolated API plus Python http.server card mock on preflight-checked 28124-28128 ports verifies fetch-to-pending, consent confirmation, atomic agent member plus SHA-256-only gateway bearer and audits, card/local roster origin, loopback SSRF rejection with no partial ledger row, and FORCE RLS isolation."
  add_cmd "Agent profile and native creation verification (MOMO-537)" "scripts/verify_agent_profile.sh"
  add_note_once coverage "MOMO-537 agent profile via scripts/verify_agent_profile.sh: isolated API/worker/mock-Hermes stack on preflight-checked 28150-28153 ports verifies simultaneous create, owner/admin CRUD and versioning, credential-shaped rejection, FORCE RLS, server-preamble-first packet injection, grant/profile tool intersection, disallowed model fallback with one audit, and final mock Hermes request consumption."
  add_note_once coverage "MOMO-449/458 grant roundtrip via scripts/verify_plugin_grant_roundtrip.sh: isolated e2e compose API stack, GitHub+Notion+Linear simultaneous grants with exact three-descriptor tool policy equality, per-plugin revoke set-difference assertions, adapter normalization credential-shape scan, and empty policy after final revoke; no external vendor network call."
  add_note_once coverage "MOMO-457 Drive MCP via scripts/verify_drive_mcp.sh: isolated stub-only e2e compose API stack, hosted descriptor absolute URL, agent bearer + delegated channel binding, install/grant, MCP initialize/tools.list/read-only tools.call 3종, revoke fail-closed, same-transaction success/denial audit rows, and credential-shaped response redaction; no Google network call."
  add_note_once coverage "MOMO-474/521 attachment upload via scripts/verify_attachment_upload.sh: isolated Drive-stub and S3/MinIO modes, presigned direct PUT/GET, metadata completion, same-transaction uploader-only message binding and audit, non-member 403, capability/credential non-persistence, abandoned pending row, 100 MB ceiling, and FORCE RLS isolation; no Google network call."
  add_note_once coverage "MOMO-412 signed webhook ingress via scripts/verify_signed_webhook_ingress.sh: isolated native HMAC forgery/replay/stale/cross-workspace/overlap rotation/revoke, Slack text+Mattermost legacy attachment roundtrip with blocks/ts rejection, receipt+deterministic client_msg_id+message.seq+outbox one-tenant-transaction evidence, one-time secret custody and request-log redaction, and FORCE RLS isolation."
  add_note_once coverage "MOMO-404/503 push notifier via scripts/verify_push_notifier.sh: preflight-checked isolated e2e compose stack on ports 27990-27994 verifies message/mention/approval/work categories, channel-or-root thread grouping, approval-only approval_id, exact ADR-0109 unread-sum badge, author/channel-mute suppression, closed id-only v2 payload, settled-dispatch dedupe, kind-scoped consumers, momo_notifier BYPASSRLS, and dispatch-log FORCE RLS."
  add_note_once coverage "MOMO-477 channel notification mute via scripts/verify_notification_mute.sh: isolated API/notifier/mock-relay compose stack verifies pre-mute dispatch, member-only REST mute/unmute with same-transaction audit, channel-list muted projection, mention suppression before dispatch-log insertion, immediate no-cache resume, member-pair isolation, and notification_pref FORCE RLS."
  add_note_once coverage "MOMO-403 push device registration via scripts/verify_push_registration.sh: isolated e2e compose stack (project momo403push, ports 19500s, api service only), register/idempotent re-register with token rotation, suffix-only receipts (no raw apns_token in responses or audit detail), actor-binding 403s, cross-tenant 403/409, revoke=invalidated_at with row preservation, same-transaction audit rows, momo_app RLS isolation, and 010 migration index presence."
  add_note_once coverage "Docker compose, migration idempotency, production-order roles-absent migration then app-only private lookup bootstrap via scripts/verify_runtime_role_bootstrap.sh, RLS tenant isolation via scripts/verify_rls.sh, workspace roster tenant/member guard via scripts/verify_roster.sh, workspace channel list active membership/cross-workspace guard via scripts/verify_channel_list.sh, workspace identity read/owner-admin rename/member denial/audit plus channel create + human/agent member add/remove + message send management path via scripts/verify_channel_management.sh, public /v1/join invite self-signup via scripts/verify_join.sh, platform-admin read-only cross-tenant inspection via scripts/verify_platform_admin.sh, and approval decision endpoint approve/reject/idempotency/expiry/membership via scripts/verify_approval_decision.sh."
  add_note_once coverage "MOMO-300 auth hardening via scripts/verify_auth_hardening.sh: subscribe proxy shared-secret 401/allow boundary, session token persistence, logout revocation (revoked-token 401, idempotent + auth.logout audit), refresh rotation replay 401, and per-member rate limit 429 + Retry-After + rate_limit.exceeded audit."
  add_note_once coverage "MOMO-408 production seed password via scripts/verify_prod_seed_password.sh: isolated PostgreSQL 18 databases prove seed-none migration makes demo@momo.local/dev-password return HTTP 401, operator takeover updates exactly one owner and the replacement credential logs in, while explicit e2e seed mode preserves the deterministic dev-password login path."
  add_note_once coverage "MOMO-561 owner bootstrap via scripts/verify_owner_bootstrap.sh: the pinned migrate image runs one-shot set-owner on reserved port 28200, accepts email/password through env only, updates exactly the active bootstrap workspace owner, rejects missing input, keeps secrets out of argv/logs, and treats a re-run as credential rotation with active-session revocation."
}

add_runtime_relay_commands() {
  add_runtime_bootstrap_commands
  if [ -x scripts/verify_relay.sh ]; then
    add_cmd "OutboxRelay runtime verification" "scripts/verify_relay.sh"
    add_cmd "PushRelay signed dispatch runtime verification (MOMO-461)" "scripts/verify_push_relay.sh"
    add_note_once coverage "MOMO-461 PushRelay via scripts/verify_push_relay.sh: host Swift process + Stub APNSSender (no Docker/APNs credentials), raw-body Ed25519 valid dispatch, bad signature/unregistered 403, per-server rate limit 429, and closed id-only APNs payload capture."
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
  add_cmd_once "Hosted agent pairing/activation verification (#1364)" "scripts/verify_openapi_contract.sh"
  add_cmd "AgentWorker fresh DB bootstrap, rollback, and persistent repeat verification" "scripts/verify_agent_worker_bootstrap.sh"
  add_cmd "Agent context verifier bootstrap rollback" "scripts/verify_agent_context_bootstrap.sh"
  add_cmd "Agent context assembly verification" "scripts/verify_agent_context.sh"
  add_cmd "Agent live channel verifier bootstrap rollback" "scripts/verify_agent_live_channel_bootstrap.sh"
  add_cmd "Agent live channel verification" "scripts/verify_agent_live_channel.sh"
  add_cmd "Hermes bridge/gateway verifier bootstrap rollback" "scripts/verify_hermes_verifier_bootstrap.sh"
  add_cmd "Local Hermes bridge verification" "scripts/verify_local_hermes_bridge.sh"
  add_cmd "Hermes gateway native platform verification" "scripts/verify_hermes_gateway_adapter.sh"
  add_cmd "Agent worker/gateway path equivalence verification" "scripts/verify_agent_path_equivalence.sh"
  add_note_once coverage "REST @agent mention routing via scripts/verify_agent_worker.sh: a marker-owned separately migrated verifier DB, marker-bound runtime roles, and generation-namespaced workspace/channel send @agent-worker-verifier, create exactly one agent_run/agent_job, dedupe duplicate client_msg_id, record non-channel agent mentions as audited no-ops, emit mock SSE agent.partial/tool_call progress on agent:, and publish the final channel message.new. The verifier runs twice against the same persistent verifier DB and proves the source DB plus unrelated messages, pending jobs, memberships, user-owned Hermes state, and dogfood budget windows remain outside its mutation boundary."
  add_note_once coverage "AgentWorker OpenAI-compatible SSE mock, D live tool_call progress with bounded args, cost reserve/reconcile, MomoServer cost-snapshots projection endpoint, and approved deterministic resume_approval -> final tool_result/message.new/audit/job-done via scripts/verify_agent_worker.sh."
  add_note_once coverage "MOMO-302 context assembly via scripts/verify_agent_context.sh: a @hermes mention carries the same-channel recent-N history into the hermes chat request (mock request dump), the agent's own prior turn maps to role=assistant while humans map to prefixed user, another channel's message is excluded (session boundary), and a small AGENT_CONTEXT_MAX_CHARS drops the oldest padding while always keeping the trigger."
  add_note_once coverage "MOMO-301 loop-guard trips via scripts/verify_agent_worker.sh: deterministic a2a_depth(depth=2 > MAX_DEPTH=1 env)/G3(step_count=max_steps)/G1(decoy running run)/G2(2 trailing agent text messages at MAX_CONSECUTIVE_AUTO=2 env) fixtures with zeroed payload seeds prove the Postgres SoT gates trip -> agent_run failed(loop_guard_tripped) + audit_log agent.guard.tripped + degraded system channel message + no usage_ledger spend."
  add_note_once coverage "MOMO-559 ADR-0132 D3-D5 via the enhanced scripts/verify_agent_worker.sh (scripts/verify_agent_interaction_safety.sh reserves the isolated 28191-28194 stack): agent mentions require a source run, child agent_run.parent_run_id/depth and agent_job.depth consume parent+1, G2 writes the durable human-intervention system notice plus matching message.new outbox, and the final mock Hermes request consumes the server D4 publication policy before profile/base instructions."
  add_note_once coverage "Agent live channel boundary via scripts/verify_agent_live_channel.sh: a marker/OID-owned migrated DB and marker-bound app/worker/relay roles isolate all fixtures and claims from the source dogfood DB; an exact-channel member receives agent.status/agent.partial on agent:ws<workspace>.<channel>.<agent>; invalid tokens, members outside that channel, other-workspace tokens, and a revoked exact credential are denied; a live agent bearer receives its private agentwork publication; and client direct publish is rejected."
  add_note_once coverage "MOMO-256/MOMO-346 Local Hermes Bridge: scripts/verify_local_hermes_bridge.sh runs the external-hermes verifier against a loopback OpenAI-compatible SSE provider in a marker/OID-owned migrated DB with marker-bound app/worker/relay roles, self-seeds Hermes/#agent-lab, verifies @hermes -> agent_job -> AgentWorker -> durable channel message.new, and enforces the source DB digest unchanged on exit."
  add_note_once coverage "MOMO-325/MOMO-337/MOMO-338/MOMO-346 Hermes gateway path: scripts/verify_hermes_gateway_adapter.sh uses its own marker/OID-owned migrated DB and marker-bound NOBYPASSRLS app role, self-seeds Hermes/#agent-lab, runs AGENT_GATEWAY_MODE=gateway, mints sha256-only per-agent bearer credentials, proves self-only agentwork: job delivery is isolated from observable agent: progress, verifies scoped pending/message/callback routes, actor binding, 24h rotation overlap, revoke fail-closed, audit_log.via_token_id, durable final message/usage/job completion, and separately proves the deprecated shared secret works only with MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1 while enforcing the source DB digest unchanged."
  add_note_once coverage "MOMO-352 ADR-0102 path equivalence: scripts/verify_agent_path_equivalence.sh runs the worker and gateway authoritative fixtures in fresh marker/OID-owned databases with per-run uppercase transport channels, proves exit-96 pre-marker rollback and source digest preservation, then compares run-state, approval, usage/audit, durable-message, and realtime-publication guarantees after an explicit timing/provider/lease allowlist."
}

add_external_agent_provider_commands() {
  add_cmd "Local Hermes credentialed provider setup boundary" "scripts/verify_local_hermes_credentialed_smoke.sh"
  add_note_once coverage "MOMO-230/MOMO-236/MOMO-242/MOMO-256/MOMO-257/MOMO-346 opt-in external provider gate: when AGENT_PROVIDER_MODE=external-hermes plus HERMES_BASE_URL/HERMES_API_KEY are configured, scripts/verify_local_hermes_credentialed_smoke.sh delegates to scripts/verify_external_agent_provider.sh, checks OpenAI-compatible SSE directly, uses a marker/OID-owned migrated DB with marker-bound app/worker/relay roles and self-seeded Hermes/#agent-lab, boots MomoServer/OutboxRelay/AgentWorker, verifies /v1/agent-runtime/status redacted availability with no degradedReason, sends one @hermes roundtrip through the external runtime, and enforces the source DB digest unchanged."
  add_note_once coverage "MOMO-234/MOMO-238 credential boundary: momo app/API/DB/local-gate evidence never receive Codex/OpenAI OAuth tokens or GPT/OpenAI API keys; known Codex/OpenAI credential env vars fail fast and credentials remain provider-owned inside the external runtime host."
  add_note_once coverage "MOMO-238 local-only loopback contract: AGENT_PROVIDER_MODE=external-hermes may use http://127.0.0.1:<port>/v1 or http://localhost:<port>/v1 only with MOMO_ENV=local and AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1; non-loopback HTTP and staging/prod/internal-host loopback fail fast."
  add_note_once coverage "MOMO-257 no-credential behavior: with default local/mock env and no out-of-repo provider env, the wrapper exits successfully with explicit NEEDS_USER_CREDENTIAL/runtime-unverified(external provider credentials) evidence and does not alter deterministic runtime-agent/internal-alpha gates."
  add_note_once not_covered "The default runtime-agent profile remains repo-local mock Hermes only; real provider side effects are covered only by the external-agent-provider opt-in profile."
}

add_internal_alpha_commands() {
  add_static_commands
  add_runtime_env_guard_command
  add_cmd "internal alpha packet directory" 'mkdir -p "${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"'
  add_cmd "internal alpha host-runtime evidence" 'packet="${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"; out="$packet/host-runtime"; mkdir -p "$out"; LOCAL_GATE_OUT_DIR="$out" scripts/verify_internal_host_runtime.sh'
  add_cmd "internal alpha backup restore evidence" 'packet="${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"; out="$packet/backup-restore"; mkdir -p "$out"; BACKUP_REHEARSAL_OUT_DIR="$out" scripts/verify_backup_restore_rehearsal.sh'
  add_cmd "internal alpha diagnostics bundle" 'packet="${LOCAL_GATE_INTERNAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/internal-alpha-manual}"; out="$packet/diagnostics"; mkdir -p "$out"; scripts/collect_diagnostics.sh --output-dir "$out" --since 30m'
  add_note_once coverage "MOMO-225 internal alpha combined local gate: creates one PR-ready packet with host-runtime image boot/health/migrate/message/relay/mock Kim Intern evidence, backup restore rehearsal evidence, and a redacted diagnostics bundle path."
  add_note_once coverage "internal-alpha writes verifier artifacts under a run-specific packet directory below the local gate output directory: internal-alpha-<run-id>/{host-runtime,backup-restore,diagnostics}/, plus the top-level local-gate markdown/log."
  add_note_once not_covered "Public TLS/DNS, real registry pull, SOPS production secret injection, external Hermes staging connectivity, production pgBackRest stanza/check/full backup, WAL archive push, and time-target PITR remain runtime-unverified(public host)."
}

add_local_alpha_commands() {
  add_static_commands
  add_runtime_env_guard_command
  add_cmd "local alpha packet directory" 'mkdir -p "${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"'
  add_cmd "local alpha host-runtime evidence" 'packet="${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"; out="$packet/host-runtime"; mkdir -p "$out"; LOCAL_GATE_OUT_DIR="$out" scripts/verify_internal_host_runtime.sh'
  add_cmd "local alpha backup restore evidence" 'packet="${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"; out="$packet/backup-restore"; mkdir -p "$out"; BACKUP_REHEARSAL_OUT_DIR="$out" scripts/verify_backup_restore_rehearsal.sh'
  add_cmd "local alpha diagnostics bundle" 'packet="${LOCAL_GATE_LOCAL_ALPHA_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/local-alpha-manual}"; out="$packet/diagnostics"; mkdir -p "$out"; scripts/collect_diagnostics.sh --output-dir "$out" --since 30m'
  add_note_once coverage "MOMO-237 local-alpha RC gate: creates one local Docker evidence packet with host-runtime image boot/health/migration idempotency/REST message/OutboxRelay publish/mock Kim Intern roundtrip, repo-local backup restore rehearsal, and a redacted diagnostics bundle."
  add_note_once coverage "local-alpha is AWS-free: it uses local Docker, local Swift packages, repo-local mock Hermes, and local diagnostics only. It does not call AWS APIs, create cloud resources, trigger release workflows, or require public DNS/TLS."
  add_note_once not_covered "Public AWS/staging resources, public TLS/DNS, real registry pull, SOPS production secret injection, external Hermes staging connectivity, production pgBackRest stanza/check/full backup, WAL archive push, time-target PITR, notarization, TestFlight, iOS/APNs, and M7 release gate PASS remain out of scope."
}

add_web_commands() {
  # MOMO-391 (ADR-0119 W-2): clients/web-legacy quality + e2e gate. The v0 web
  # client moved to clients/web-legacy in MOMO-596 (ADR-0133 promotion) and is
  # still the client this profile builds, serves and drives in the browser.
  # install -> lint -> unit tests -> typecheck -> generated-types sync -> build -> license
  # gate -> serving smoke (MOMO-390 regression: APP_DOMAIN sentinel
  # fail-closed + strict CSP) -> browser login/timeline smoke (e2e compose)
  # -> OpenAPI runtime drift gate (spec vs live server, MOMO-389).
  add_cmd_once "worktree clean" 'if [ "${LOCAL_GATE_ALLOW_DIRTY:-0}" = "1" ]; then echo "LOCAL_GATE_ALLOW_DIRTY=1; dirty state is recorded but not failed"; git status --short; else test -z "$(git status --porcelain)" || { echo "worktree has uncommitted changes"; git status --short; exit 1; }; fi'
  # #1141: design pre-flight (clients/web 10 분류 + packages/momo-core 3 분류,
  # 둘 다 하드 제로). 이 프로파일이 빌드하는 것은 clients/web-legacy 지만, 이
  # 검사가 답하는 질문은 「이 제품이 화면에 무엇을 내놓는가」이고 그 답은 ADR-0133
  # 정본 UI(clients/web)와 코어의 문장에 있다. #1171 이 편입을 미뤄 둔 이유는 웹이
  # base 빨강(emdash 12)이었기 때문인데, 그 12건은 11이 오탐·1이 검토된 예외로
  # 판정되어 지금 0 이다. 게이트 밖에 남기면 다음 수동 실행까지 침묵하고, 그것이
  # #1138 B2 가 출하 직전에 사람 눈으로 잡힌 이유였다.
  #
  # 순서상 먼저인 것은 값이 싸서다(수 초). 그리고 필요한 것은 워크스페이스 루트의
  # `typescript` 하나인데(emdash·코어가 AST 단계다) 없으면 pre-flight 가 조용히
  # 건너뛰지 않고 exit 2 로 실패하므로, 여기서 미리 채운다.
  add_cmd "design pre-flight deps (workspace root typescript)" 'test -d node_modules/typescript || npm ci --no-audit --no-fund'
  add_cmd "design pre-flight discriminators (--selftest)" 'scripts/design_preflight_web.sh --selftest'
  add_cmd "design pre-flight (web 10 + core 3, hard zero)" 'scripts/design_preflight_web.sh'
  add_cmd "web install (npm ci)" '(cd clients/web-legacy && npm ci --no-audit --no-fund)'
  add_cmd "web lint (eslint)" '(cd clients/web-legacy && npm run lint)'
  add_cmd "web unit tests (vitest)" '(cd clients/web-legacy && npm run test)'
  add_cmd "web typecheck (tsc --noEmit)" '(cd clients/web-legacy && npm run typecheck)'
  # MOMO-678: was an inline `generate:types && git diff --exit-code` that
  # reported a broken generator as client staleness and left the regenerated
  # file in the tree, so a drift failure resurfaced as "worktree has
  # uncommitted changes" on the next run. The verifier names each failure and
  # restores the file on every exit path.
  add_cmd "web generated API types in sync with docs/api/openapi.yaml" 'scripts/verify_web_generated_types.sh'
  add_cmd "web build (vite, CSP-safe output)" '(cd clients/web-legacy && npm run build)'
  # #1225: same script as the `license` profile, aimed at the tree this profile
  # actually builds and serves. The script moved to scripts/check_npm_licenses.mjs
  # and its default roots are now the canonical trees, so clients/web-legacy has
  # to be named — a gate that reports on a tree nobody ships is how the audit
  # found 1,258 packages unchecked.
  add_cmd "web dependency license gate (clients/web-legacy, shared policy)" 'out="${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/web-licenses-${LOCAL_GATE_RUN_ID:-manual}.md"; NPM_LICENSE_REPORT="$out" node scripts/check_npm_licenses.mjs --root clients/web-legacy && echo "license inventory: $out"'
  add_cmd "web serving smoke (Caddy APP_DOMAIN edge + sentinel fail-closed)" 'scripts/web_serving_smoke.sh'
  add_cmd "web login -> timeline browser smoke (e2e compose)" 'scripts/verify_web_login_smoke.sh'
  add_cmd "OpenAPI contract drift gate (spec vs live server)" 'scripts/verify_openapi_contract.sh'
  add_note_once coverage "#1141 design pre-flight in this profile: scripts/design_preflight_web.sh runs its three discriminators as cases (web raw_color 11, web strings 16, core separation 17) and then gates clients/web at 10/10 categories and packages/momo-core at 3/3, both hard zero. The emdash category is an AST scan over string-literal and JSX-text nodes, so comments, JSX comments and describe/it names are out of scope by construction rather than by a filter; the one reviewed exception (clients/web/src/features/timeline/spacing.ts throw copy) carries design-preflight-allow with its evidence."
  add_note_once not_covered "The pre-flight is mechanical only: light/dark review, the four states, keyboard path, and long-Korean overflow remain the manual SKILL §10 checklist. It also cannot see an em-dash written as a JSX entity (&mdash;) — there is no such literal in the tree today."
  add_note_once coverage "MOMO-391 web client gate: npm ci install, eslint, Vitest unit tests, tsc typecheck, openapi-typescript generated types verified in sync with docs/api/openapi.yaml, vite production build, and a permissive-only license gate over the full installed transitive closure (markdown inventory written to the gate output dir)."
  add_note_once coverage "MOMO-678 generated-types step is scripts/verify_web_generated_types.sh: it separates generator-failed (unparseable spec / missing openapi-typescript) from types-stale, prints the offending diff plus the committed-vs-regenerated documented-path counts, and restores src/api/schema.d.ts on every exit path so a drift failure cannot resurface as an unrelated worktree-clean failure on the next run. clients/web-legacy is frozen as a UI but still the served artifact (infra/prod/Dockerfile.web, e2e web-init), so this remains the only compile-time check that a shipped web client matches docs/api/openapi.yaml."
  add_note_once coverage "MOMO-390 serving regression via scripts/web_serving_smoke.sh: prod Caddyfile parse matrix (APP_DOMAIN set/unset/empty), SPA deep-link fallback, /v1 proxy wiring, /v1/centrifugo edge 403, strict SPA CSP headers, and APP_DOMAIN-unset sentinel fail-closed ordering (guard before proxy)."
  add_note_once coverage "MOMO-391 browser smoke via scripts/verify_web_login_smoke.sh: isolated e2e compose stack (project momo391web, loopback ports 18990-18995) serving the built SPA through the real prod Caddyfile; real Chromium login (workspace empty -> demo fallback), channel list, seeded timeline display, wss realtime subscribe under the strict CSP, REST-sent message rendered live through REST -> PG -> outbox -> relay -> Centrifugo, REST ?after= catch-up on subscribe, and zero CSP console violations."
  add_note_once coverage "MOMO-400 (ADR-0119 W-4) inside the same browser smoke: composer clientMsgId idempotency (first send forwarded then answered 500; retry must reuse the SAME clientMsgId; exactly one DOM render and one committed row), read-state rail (bulk GET badge init, external cursor PUT reflected through the user:read-state#<member-id> push with zero extra GETs, strictly monotonic browser cursor PUTs), ADR-0112 approval cards (no tool JSON/cost leakage; in-browser approve receipt 200; externally pre-decided 409 receipt handled as a card state transition), and DM open via POST /dms + composer round-trip + GET /dms listing."
  add_note_once coverage "Goal #593 (ADR-0119 W-5 / ADR-0121 D2) inside the same browser smoke: REST invite issuance by a disposable admin (expired fixture via SQL back-date, exhausted via a real POST /v1/join), /join?code=<code> deep link with the code stripped from browser history after success and leaked into no non-document request URL or console line, browser join establishing the session from the JoinResponse token pair (spec'd join-login; no separate /v1/auth/login), #general timeline entry, logout -> re-login with the join-created credentials, and distinct Korean error copy for expired/exhausted/invalid codes."
  add_note_once coverage "MOMO-389 runtime drift gate via scripts/verify_openapi_contract.sh: every documented web v0 operation sampled against a disposable live server and shape-checked closed-world against docs/api/openapi.yaml."
  add_note_once not_covered "Real DNS/ACME/TLS on public hosts, app deep links, the full invite-create -> short-link -> join -> message round-trip, and Safari/Firefox coverage (the smoke drives Chromium) remain out of scope for the web v0 gate."
}

add_license_commands() {
  # #1225: dependency license gate for the two stacks that actually ship.
  #
  # This was written as a PARALLEL gate to the SwiftPM one in add_swift_commands.
  # That gate retired with the Swift client trees (W-S1 / #1201), so this is now
  # the only dependency license gate in the repo. Audit
  # research/2026-08-10-buzz-audit-A.md measured what the SwiftPM one left
  # uncovered — 644 cargo crates and 1,258 npm packages, i.e. 98.1% of the
  # dependency population, including the MPL-2.0 30 that CONTRIBUTING claimed
  # were rejected fail-closed.
  #
  # Ordering: the regression test runs first. It is seconds long and it is the
  # only step that proves the gate can turn red; if it breaks, a green from the
  # two production checks below means nothing.
  add_cmd_once "license gate regression (red proofs: cargo AGPL inject, MPL removal, npm aim)" 'scripts/tests/test_license_gate.sh'
  add_cmd_once "cargo dependency license gate (server-rust + desktop, deny.toml)" 'scripts/check_cargo_licenses.sh'
  add_cmd_once "npm dependency license gate (clients/web + clients/mobile + packages/momo-core)" 'out="${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}/npm-licenses-${LOCAL_GATE_RUN_ID:-manual}.md"; NPM_LICENSE_REPORT="$out" node scripts/check_npm_licenses.mjs && echo "license inventory: $out"'
  add_note_once coverage "#1225 dependency license gate: deny.toml is one policy for both cargo workspaces (server-rust 309 crates + clients/desktop/src-tauri 528, 644 unique third-party) and scripts/check_npm_licenses.mjs applies the same allowlist to the canonical npm trees (workspace root incl. packages/momo-core, clients/web, clients/mobile — 1,750 lockfile entries). SPDX expressions are evaluated before any name matching, so a permissive OR branch (node-forge \"BSD-3-Clause OR GPL-2.0\", r-efi \"MIT OR Apache-2.0 OR LGPL-2.1-or-later\") passes while an AND with a copyleft half fails. scripts/tests/test_license_gate.sh proves red on an injected AGPL-3.0 crate, on removing the reviewed MPL-2.0 allowance (desktop only — the backbone has zero MPL), on an unlicensed first-party workspace package, and proves the npm half reads the canonical trees rather than clients/web-legacy."
  add_note_once not_covered "#1225 covers licenses only. RUSTSEC advisories (cargo deny check advisories), npm audit, duplicate-crate bans, and source registry pinning are not run — and no license gate runs in GitHub Actions yet, so an external PR is still unchecked until the CI promotion that waits on the public-repo decision."
}

add_secrets_commands() {
  # #1236: the executor #1224 was missing. `.gitleaksignore` pins 61 reviewed
  # false positives by fingerprint so one real leak stops being buried; until now
  # nothing ran the scanner that reads it.
  #
  # Ordering matches the license gate: the regression test runs first because it
  # is the only step that proves the gate can turn red. If it breaks, a green
  # from the scan below is indistinguishable from a gate that fires at nothing.
  #
  # Cost, measured on this tree: 0.2s for the regression test, ~2s for the scan
  # (2,046 commits / 43 MB). That is why this group sits in add_static_commands
  # and therefore in every profile, rather than in a lane someone has to choose.
  add_cmd_once "secret gate regression (red proofs: committed credential, absent scanner, baseline aim)" 'scripts/tests/test_secrets_gate.sh'
  add_cmd_once "secret scan over all refs (gitleaks + .gitleaksignore baseline)" 'scripts/check_secrets.sh'
  add_note_once coverage "#1236 secret scan via scripts/check_secrets.sh: gitleaks over every ref (--log-opts --all), with .gitleaksignore applied — the exact command the baseline documents as the range it guarantees. Missing gitleaks fails the gate instead of skipping it, and there is no reviewed-override env: \"skip the secret scan\" is not a reviewable exception. No findings report file is written even in the artifact dir, because a gitleaks JSON report carries the matched values while --redact only covers stdout. scripts/tests/test_secrets_gate.sh proves red on a committed high-entropy credential in a throwaway repository, red on an absent scanner, red on a missing baseline, red on a baseline line whose fingerprint does not match, and green once the real fingerprint is pinned."
  add_note_once not_covered "#1236 covers committed history only. Uncommitted work has no commit and therefore no fingerprint, so the baseline cannot speak about it — the \"worktree clean\" static check is what closes that gap, and gitleaks --no-git/protect are deliberately not run because the commit-scoped baseline does not apply to them (the regression test measures that divergence rather than asserting it). Rule coverage is stock gitleaks: no repo-specific gitleaks.toml exists yet, so a credential shape gitleaks does not know is still invisible."
}

add_web_serving_commands() {
  # MOMO-576 (ADR-0119 W-3): infrastructure-only runtime profile. It uses the
  # e2e web profile and never joins runtime-db or a developer compose project.
  add_static_commands
  add_cmd "web serving (real dist + Caddy same-origin proxy)" 'scripts/verify_web_serving.sh'
  add_note_once coverage "Goal #593 web-serving infra gate: isolated ports 28070-28074, real Dockerfile.web dist copied by web-init into a named volume, HTTP Caddy SPA/index and /join fallback, /i/* LinkShort proxy, live API login proxy response, Centrifugo callback 403, CSP/X-Frame-Options, and /health proxy."
  add_note_once not_covered "Public DNS, ACME issuance, and production TLS remain orchestrator/public-host evidence; the e2e gate intentionally serves HTTP."
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
  add_note_once coverage "M3 D evidence: repo-local OpenAI-compatible SSE mock emits agent.partial text plus tool_call_name/tool_call_args progress; AgentWorker reconciles to final tool_result/message.new with outbox version equal to message.seq."
  add_note_once coverage "M3 B evidence: AgentWorker reserve/reconcile writes usage_ledger and budget_window, then MomoServer /cost-snapshots exposes the server-owned CostSnapshot projection."
  add_note_once coverage "M3 C evidence: /approvals pending projection, approve/reject, client_decision_id idempotency, conflict, expired click, channel membership guard, audit_log, and resume agent_job durable effects are verified."
  add_note_once coverage "MOMO-020 close-readiness: when this profile passes in the PR evidence, the old staging/Hermes wording can be closed under the MOMO-204 local-gate reinterpretation after review/merge; worker does not close #12."
  add_note_once not_covered "External Hermes/staging provider side effects, M4 Xcode packaging/signing/notary, iOS/APNs, and agent: namespace production presence remain out of scope for MOMO-204."
}

# This preflight is deliberately outside the profile switch. Even the focused
# web/secrets lanes must not create green evidence from a stale or miswired
# canonical local branch; broader static checks remain profile-specific.
add_track_alignment_preflight

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
  m3-dbc)
    add_m3_dbc_commands
    ;;
  web-serving)
    add_web_serving_commands
    ;;
  web)
    add_web_commands
    ;;
  license)
    add_static_commands
    add_license_commands
    ;;
  secrets)
    # Deliberately without add_static_commands: this is the ~3s standalone lane
    # for "did I just commit a credential", and the same two steps already run
    # inside every other profile through the static block.
    add_secrets_commands
    add_note_once not_covered "The secrets profile runs the secret scan alone. It is not a substitute for a profile gate — no build, no docs/CI validation, no runtime evidence."
    ;;
  all)
    add_static_commands
    add_runtime_env_guard_command
    add_swift_commands
    add_license_commands
    add_staging_smoke_commands
    add_host_runtime_commands
    add_runtime_db_commands
    add_runtime_host_api_cleanup_command "Cleanup host MomoServer after runtime DB verifiers"
    add_runtime_relay_commands
    add_runtime_host_api_cleanup_command "Cleanup host MomoServer after relay verifier"
    add_runtime_agent_cleanup_command "Pre-clean runtime agent host processes"
    add_runtime_agent_commands
    add_runtime_agent_final_cleanup_command "Cleanup runtime agent host processes after agent verifier"
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
  if [ "$label" = "docker compose up (--wait healthy)" ] && [ "$RUNTIME_COMPOSE_PROFILE" -eq 1 ]; then
    # Review #439 M1: a stack that was ALREADY running before this gate (e.g.
    # the momo_main dogfood stack when running from the main checkout) must
    # not be torn down by our EXIT trap — we only own what we started.
    # Resolve the project exactly like the Makefile does (ENV_FILE chain),
    # because a bare `docker compose ps` would ignore .env.worktree.
    gate_env_file=""
    for f in .env.worktree .env infra/.env.example; do
      [ -f "$f" ] && { gate_env_file="$f"; break; }
    done
    gate_project=""
    if [ -n "$gate_env_file" ]; then
      gate_project="$(grep -E '^COMPOSE_PROJECT_NAME=' "$gate_env_file" | tail -1 | cut -d= -f2)"
    fi
    if [ -n "$gate_project" ] && docker ps -q --filter "label=com.docker.compose.project=$gate_project" 2>/dev/null | grep -q .; then
      echo "local gate: Compose project '$gate_project' pre-exists this gate run; teardown will be skipped (not owned by this gate)" | tee -a "$LOG_FILE"
      RUNTIME_COMPOSE_PREEXISTING=1
    fi
    # Mark before invoking `make up`: an interrupted/partially successful Compose
    # start still needs the same EXIT-trap teardown as a completed bootstrap.
    RUNTIME_COMPOSE_STARTED=1
  fi
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
    echo "- Evidence sha256 manifest: \`$MANIFEST_FILE\`"
    echo "- Run artifact directory: \`$RUN_ARTIFACT_DIR\`"
    if [ -n "${MOMO_GATE_SKIP_SKEW:-}" ]; then
      skew_reason="$(printf '%s' "$MOMO_GATE_SKIP_SKEW" | tr '\r\n' '  ' | sed 's/`/'\''/g; s/^[[:space:]]*//; s/[[:space:]]*$//')"
      echo "- Branch-skew override: \`$skew_reason\`"
    else
      echo "- Branch-skew upstream: \`${MOMO_GATE_SKEW_REF:-origin/main}\` (enforced)"
    fi
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
      for artifact_dir in host-runtime backup-restore diagnostics; do
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

scripts/write_sha256_manifest.sh "$MANIFEST_FILE" "$EVIDENCE_FILE" "$LOG_FILE" "$RUN_ARTIFACT_DIR"

echo
echo "Evidence file: $EVIDENCE_FILE"
echo "Log file: $LOG_FILE"
echo "SHA256 manifest: $MANIFEST_FILE"

if [ "$FAILED_INDEX" -ne -1 ]; then
  exit "$FAILED_CODE"
fi

exit 0
