#!/usr/bin/env bash
# sourced by scripts/oort — SH-3b day-2 verbs. bash 3.2.
# Requires oort_doctor.sh and oort_common.sh already sourced.

oort_status_usage() {
  cat <<'EOF'
Usage: scripts/oort status [--env FILE] [--json]

Compose health, /healthz, outbox, and image digest vs releases/latest.json.
Exit codes match doctor: 0 pass, 1 major-only, 2 any blocker.
EOF
}

oort_status() {
  local env_path="" json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        [ "$#" -ge 2 ] || { oort_status_usage >&2; return 2; }
        env_path="$2"
        shift 2
        ;;
      --env=*)
        env_path="${1#--env=}"
        shift
        ;;
      --json)
        json=1
        shift
        ;;
      --tier)
        [ "$#" -ge 2 ] || { oort_status_usage >&2; return 2; }
        oort_set_tier_override "$2"
        shift 2
        ;;
      --tier=*)
        oort_set_tier_override "${1#--tier=}"
        shift
        ;;
      -h | --help)
        oort_status_usage
        return 0
        ;;
      *)
        printf 'oort status: 알 수 없는 인자: %s\n' "$1" >&2
        oort_status_usage >&2
        return 2
        ;;
    esac
  done

  local report code env_file current manifest state
  report="$(mktemp "${TMPDIR:-/tmp}/oort-status.XXXXXX")"
  if [ -n "$env_path" ]; then
    env_file="$env_path"
  else
    env_file="$OORT_ROOT/infra/rust/local.secrets.env"
  fi

  set +e
  set --
  if [ -n "$env_path" ]; then
    set -- "$@" --env "$env_path"
  fi
  if [ "$json" -eq 1 ]; then
    set -- "$@" --json
  fi
  if [ -n "${OORT_TIER_OVERRIDE:-}" ]; then
    set -- "$@" --tier "$OORT_TIER_OVERRIDE"
  fi
  if [ "$json" -eq 1 ]; then
    oort_doctor "$@" >"$report"
  else
    oort_doctor "$@"
  fi
  code=$?
  set -e

  current=""
  manifest=""
  state="unknown"
  if [ -f "$env_file" ]; then
    current="$(oort_image_state_from_env "$env_file" | awk 'NR==1')"
    manifest="$(oort_image_state_from_env "$env_file" | awk 'NR==2')"
    state="$(oort_image_state_from_env "$env_file" | awk 'NR==3')"
  fi

  if [ "$json" -eq 1 ]; then
    python3 - "$report" "$current" "$manifest" "$state" <<'PY'
import json
import sys

path, current, manifest, state = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(path, encoding="utf-8") as fh:
    doc = json.load(fh)
doc["image"] = {
    "current": current,
    "manifest_list": manifest,
    "state": state,
}
json.dump(doc, sys.stdout, ensure_ascii=False, indent=2)
sys.stdout.write("\n")
PY
  else
    printf '\nimage: current=%s manifest_list=%s state=%s\n' \
      "$current" "$manifest" "$state"
  fi
  rm -f "$report"
  return "$code"
}

oort_logs_usage() {
  cat <<'EOF'
Usage: scripts/oort logs [service] [--since 10m] [--follow] [--env FILE] [--tier t1|t2]

docker compose logs wrapper. Secret values, Bearer tokens, and postgres
URL passwords are replaced with ***.
--tier must match MOMO_SELF_HOST_PLATFORM when that stamp exists.
EOF
}

oort_logs() {
  local env_path="" since="10m" follow=0 service=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        [ "$#" -ge 2 ] || { oort_logs_usage >&2; return 2; }
        env_path="$2"
        shift 2
        ;;
      --env=*)
        env_path="${1#--env=}"
        shift
        ;;
      --since)
        [ "$#" -ge 2 ] || { oort_logs_usage >&2; return 2; }
        since="$2"
        shift 2
        ;;
      --since=*)
        since="${1#--since=}"
        shift
        ;;
      --follow | -f)
        follow=1
        shift
        ;;
      --tier)
        [ "$#" -ge 2 ] || { oort_logs_usage >&2; return 2; }
        oort_set_tier_override "$2"
        shift 2
        ;;
      --tier=*)
        oort_set_tier_override "${1#--tier=}"
        shift
        ;;
      -h | --help)
        oort_logs_usage
        return 0
        ;;
      --*)
        printf 'oort logs: 알 수 없는 인자: %s\n' "$1" >&2
        oort_logs_usage >&2
        return 2
        ;;
      *)
        if [ -n "$service" ]; then
          oort_die "logs 서비스는 하나만 지정한다."
        fi
        service="$1"
        shift
        ;;
    esac
  done

  oort_prepare_env "$env_path"
  oort_tier >/dev/null
  if [ "$(oort_tier)" = "t2" ]; then
    printf 'T2 로그는 compose 가 아니다. 플랫폼 레시피 CLI/MCP 로 서비스 로그를 보라.\n'
    oort_release_env
    return 0
  fi
  local secrets rc
  secrets="$(mktemp "${TMPDIR:-/tmp}/oort-log-secrets.XXXXXX")"
  chmod 600 "$secrets"
  oort_secret_values_file "$secrets"

  set +e
  if [ "$follow" -eq 1 ] && [ -n "$service" ]; then
    oort_compose logs --since "$since" -f "$service" | oort_mask_stream "$secrets"
  elif [ "$follow" -eq 1 ]; then
    oort_compose logs --since "$since" -f | oort_mask_stream "$secrets"
  elif [ -n "$service" ]; then
    oort_compose logs --since "$since" "$service" | oort_mask_stream "$secrets"
  else
    oort_compose logs --since "$since" | oort_mask_stream "$secrets"
  fi
  rc=$?
  set -e
  rm -f "$secrets"
  oort_release_env
  return "$rc"
}

oort_upgrade_usage() {
  cat <<'EOF'
Usage: scripts/oort upgrade [--to <image ref pinned by its list digest, read from releases/latest.json>|--manifest URL|--local-build]
                          [--yes] [--no-backup] [--env FILE] [--tier t1|t2]

Idempotent image replace. Backs up first unless --no-backup.
local-build rebuilds (`compose build`, not `pull`) then `up -d --wait`.
Digest mode still `pull` then `up -d`. Never creates or deletes volumes.
Never auto-rolls back — prints a rollback command that is not the
failed command (local-build: previous-commit checkout or restore).
--tier must match MOMO_SELF_HOST_PLATFORM when that stamp exists.
EOF
}

# Mode → compose refresh lines (one compose subcommand + flags per line).
# local-build must never emit `pull`. Digest must never emit `build`.
oort_upgrade_refresh_plan() {
  local mode="$1"
  case "$mode" in
    local-build)
      printf 'build\n'
      printf 'up -d --wait\n'
      ;;
    *)
      printf 'pull\n'
      printf 'up -d\n'
      ;;
  esac
}

oort_upgrade_refresh() {
  local mode="$1" line
  OORT_UPGRADE_REFRESH_STEP=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    OORT_UPGRADE_REFRESH_STEP="$line"
    printf 'oort upgrade: compose %s\n' "$line"
    # Intentional splitting of the plan line into compose argv.
    # shellcheck disable=SC2086
    set -- $line
    if ! oort_compose "$@" </dev/null; then
      return 1
    fi
  done <<EOF
$(oort_upgrade_refresh_plan "$mode")
EOF
  return 0
}

# Rollback is keyed on the *previous* mode, not the target. local-build has
# no prior image tag to pull, so printing the same `upgrade --local-build`
# is not a rollback.
oort_print_rollback() {
  local previous="$1"
  local previous_mode="${2:-}"
  local dump="${3:-}"
  local env_path="${OORT_DOCTOR_ENV:-infra/rust/local.secrets.env}"
  printf '자동 롤백은 하지 않는다.\n' >&2
  if [ "$previous_mode" = "local-build" ]; then
    printf '로컬 빌드는 이전 이미지 태그로 되돌릴 수 없다.\n' >&2
    printf '이전 커밋을 체크아웃한 뒤 같은 upgrade를 다시 실행하거나, 백업 덤프를 복원한다:\n' >&2
    printf '  git checkout <이전 커밋> && scripts/oort upgrade --local-build --yes --env %s\n' \
      "$env_path" >&2
    if [ -n "$dump" ]; then
      printf '  scripts/oort restore %s --yes --env %s\n' "$dump" "$env_path" >&2
    else
      printf '  scripts/oort restore <dump> --yes --env %s\n' "$env_path" >&2
    fi
    return 0
  fi
  printf '이전 이미지로 되돌리려면:\n' >&2
  printf '  scripts/oort upgrade --to %s --no-backup --yes --env %s\n' \
    "$previous" "$env_path" >&2
}

oort_upgrade_t2() {
  local previous="$1" target_image="$2" dump_path="$3"
  local env_path platform
  env_path="${OORT_DOCTOR_ENV:-infra/rust/local.secrets.env}"
  platform="$(oort_platform_name)"
  [ -n "$platform" ] || platform="t2"
  printf 'oort upgrade: T2 — compose/volume 를 쓰지 않는다. 선행 백업 후 플랫폼 digest 교체.\n'
  if [ -n "$dump_path" ]; then
    printf 'oort upgrade: backup path %s\n' "$dump_path"
  fi
  printf '대상 image: %s\n' "$target_image"
  printf 'oort upgrade: 플랫폼 digest 교체 명령 (실행은 레시피/에이전트 — 이 CLI 는 토큰을 쥐지 않는다, ADR-0004):\n'
  printf '  # platform=%s\n' "$platform"
  printf '  # Pin the managed service image to %s via the official CLI/MCP in the user session.\n' \
    "$target_image"
  momo_t2_done_condition_line
  printf '롤백 안내 (이전 digest 문자열): %s\n' "$previous"
  if [ -n "$dump_path" ]; then
    printf '  scripts/oort restore %s --yes --tier t2 --env %s\n' "$dump_path" "$env_path"
  fi
}

oort_wait_idempotency() {
  local i=0 logs
  while [ "$i" -lt 90 ]; do
    logs="$(oort_compose logs migrate 2>/dev/null || true)"
    if printf '%s' "$logs" | grep -Fq 'IDEMPOTENCY_OK'; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  return 1
}

oort_wait_healthz() {
  local base body code i db
  base="$(oort_base_url)" || return 1
  command -v curl >/dev/null 2>&1 || return 1
  body="$(mktemp "${TMPDIR:-/tmp}/oort-healthz.XXXXXX")"
  i=0
  while [ "$i" -lt 60 ]; do
    code="$(curl -sS -m 3 -o "$body" -w '%{http_code}' "${base}/healthz" 2>/dev/null || true)"
    [ -n "$code" ] || code="000"
    db=""
    if grep -Eq '"database"[[:space:]]*:[[:space:]]*"ok"' "$body" 2>/dev/null; then
      db=ok
    fi
    if [ "$code" = "200" ] && [ "$db" = "ok" ]; then
      rm -f "$body"
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  rm -f "$body"
  return 1
}

oort_fetch_manifest_digest() {
  local url="$1" body digest
  command -v curl >/dev/null 2>&1 || oort_die "curl 이 필요하다 (--manifest)."
  body="$(mktemp "${TMPDIR:-/tmp}/oort-manifest.XXXXXX")"
  chmod 600 "$body"
  curl -fsSL "$url" >"$body" || {
    rm -f "$body"
    oort_die "--manifest URL 을 읽지 못했다."
  }
  digest="$(jq -r '.images.app.digest_list // empty' "$body" 2>/dev/null || true)"
  rm -f "$body"
  [ -n "$digest" ] || oort_die "매니페스트에 images.app.digest_list 가 없다."
  printf '%s' "$digest"
}

oort_upgrade() {
  local env_path="" to="" manifest="" local_build=0 yes=0 no_backup=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        [ "$#" -ge 2 ] || { oort_upgrade_usage >&2; return 2; }
        env_path="$2"
        shift 2
        ;;
      --env=*)
        env_path="${1#--env=}"
        shift
        ;;
      --to)
        [ "$#" -ge 2 ] || { oort_upgrade_usage >&2; return 2; }
        to="$2"
        shift 2
        ;;
      --to=*)
        to="${1#--to=}"
        shift
        ;;
      --manifest)
        [ "$#" -ge 2 ] || { oort_upgrade_usage >&2; return 2; }
        manifest="$2"
        shift 2
        ;;
      --manifest=*)
        manifest="${1#--manifest=}"
        shift
        ;;
      --local-build)
        local_build=1
        shift
        ;;
      --yes | -y)
        yes=1
        shift
        ;;
      --no-backup)
        no_backup=1
        shift
        ;;
      --tier)
        [ "$#" -ge 2 ] || { oort_upgrade_usage >&2; return 2; }
        oort_set_tier_override "$2"
        shift 2
        ;;
      --tier=*)
        oort_set_tier_override "${1#--tier=}"
        shift
        ;;
      -h | --help)
        oort_upgrade_usage
        return 0
        ;;
      *)
        printf 'oort upgrade: 알 수 없는 인자: %s\n' "$1" >&2
        oort_upgrade_usage >&2
        return 2
        ;;
    esac
  done

  if [ "$local_build" -eq 1 ] && { [ -n "$to" ] || [ -n "$manifest" ]; }; then
    oort_die "--local-build 과 --to/--manifest 를 함께 쓸 수 없다."
  fi
  if [ -n "$to" ] && [ -n "$manifest" ]; then
    oort_die "--to 와 --manifest 를 함께 쓸 수 없다."
  fi

  oort_prepare_env "$env_path"
  oort_tier >/dev/null

  local target_image target_mode digest previous previous_mode dump_path="" backup_out backup_rc
  previous="$(oort_doctor_get MOMO_RUST_IMAGE)"
  previous_mode="$(oort_doctor_get MOMO_SELF_HOST_MODE)"
  if [ "$local_build" -ne 1 ] && [ -z "$to" ] && [ -z "$manifest" ] && \
    [ "$previous_mode" = "local-build" ]; then
    local_build=1
  fi
  if [ "$local_build" -eq 1 ]; then
    target_image="oort:local"
    target_mode="local-build"
  else
    if [ -n "$manifest" ]; then
      digest="$(oort_fetch_manifest_digest "$manifest")"
    elif [ -n "$to" ]; then
      digest="$(oort_extract_digest "$to" || true)"
      [ -n "$digest" ] || oort_die "digest 형식이 아니다. ${OORT_DIGEST_RE} 또는 ${OORT_PUBLISHED_REF}@sha256:… 이어야 한다."
    else
      digest="$(oort_manifest_list_digest)"
      [ -n "$digest" ] || oort_die "releases/latest.json 에서 digest_list 를 읽지 못했다."
    fi
    oort_validate_list_digest "$digest"
    target_image="$(oort_image_ref_for_digest "$digest")"
    target_mode="published-digest"
  fi

  if [ "$yes" -ne 1 ]; then
    if [ ! -t 0 ]; then
      oort_die "확인이 필요하다. --yes 를 붙여라."
    fi
    printf 'upgrade %s → %s 를 진행할까? [y/N] ' "$previous" "$target_image"
    local ans
    IFS= read -r ans || ans=""
    case "$ans" in
      y | Y | yes | YES) ;;
      *) oort_die "취소했다." ;;
    esac
  fi

  if [ "$(oort_tier)" = "t2" ]; then
    if [ "$local_build" -eq 1 ]; then
      oort_die "T2 는 --local-build 가 없다. 플랫폼 digest 교체다."
    fi
    dump_path=""
    if [ "$no_backup" -ne 1 ]; then
      printf 'oort upgrade: 선행 백업\n'
      backup_out="$(mktemp "${TMPDIR:-/tmp}/oort-upgrade-backup.XXXXXX")"
      set +e
      if [ -n "${OORT_TIER_OVERRIDE:-}" ]; then
        oort_backup --env "$OORT_DOCTOR_ENV" --tier "$OORT_TIER_OVERRIDE" >"$backup_out"
      else
        oort_backup --env "$OORT_DOCTOR_ENV" >"$backup_out"
      fi
      backup_rc=$?
      set -e
      if [ -s "$backup_out" ]; then
        sed -E 's#(postgres(ql)?://)[^:/@]+:[^@]+@#\1***:***@#g' "$backup_out"
      fi
      dump_path="$(awk -F': ' '$1 == "[oort backup] path" { print $2; exit }' "$backup_out")"
      rm -f "$backup_out"
      if [ "$backup_rc" -ne 0 ]; then
        oort_die "선행 백업이 실패했다."
      fi
      oort_prepare_env "$OORT_DOCTOR_ENV"
    fi
    oort_upgrade_t2 "$previous" "$target_image" "$dump_path"
    oort_release_env
    return 0
  fi

  oort_require_volumes

  if [ "$no_backup" -ne 1 ]; then
    printf 'oort upgrade: 선행 백업\n'
    backup_out="$(mktemp "${TMPDIR:-/tmp}/oort-upgrade-backup.XXXXXX")"
    set +e
    oort_backup --env "$OORT_DOCTOR_ENV" >"$backup_out"
    backup_rc=$?
    set -e
    cat "$backup_out"
    dump_path="$(awk -F': ' '$1 == "[oort backup] path" { print $2; exit }' "$backup_out")"
    rm -f "$backup_out"
    if [ "$backup_rc" -ne 0 ]; then
      oort_print_rollback "$previous" "$previous_mode" "$dump_path"
      oort_die "선행 백업이 실패했다."
    fi
    oort_prepare_env "$OORT_DOCTOR_ENV"
  fi

  oort_rewrite_image_line "$OORT_DOCTOR_ENV" "$target_image" "$target_mode"
  oort_doctor_load_env "$OORT_DOCTOR_ENV"

  if ! oort_upgrade_refresh "$target_mode"; then
    oort_print_rollback "$previous" "$previous_mode" "$dump_path"
    oort_die "compose ${OORT_UPGRADE_REFRESH_STEP:-refresh} 가 실패했다."
  fi
  if ! oort_wait_idempotency; then
    oort_print_rollback "$previous" "$previous_mode" "$dump_path"
    oort_die "migrate 로그에 IDEMPOTENCY_OK 가 없다."
  fi
  if ! oort_wait_healthz; then
    oort_print_rollback "$previous" "$previous_mode" "$dump_path"
    oort_die "/healthz 가 200 database:ok 가 되지 않았다."
  fi

  local doctor_json doctor_code verdict
  doctor_json="$(mktemp "${TMPDIR:-/tmp}/oort-upgrade-doctor.XXXXXX")"
  set +e
  oort_doctor --env "$OORT_DOCTOR_ENV" --json >"$doctor_json"
  doctor_code=$?
  set -e
  verdict="$(jq -r '.summary.verdict // empty' "$doctor_json" 2>/dev/null || true)"
  printf 'oort upgrade: doctor summary %s\n' \
    "$(jq -c '.summary' "$doctor_json" 2>/dev/null || printf '{"verdict":"unknown"}')"
  rm -f "$doctor_json"
  if [ "$doctor_code" -ne 0 ] || [ "$verdict" != "PASS" ]; then
    oort_print_rollback "$previous" "$previous_mode" "$dump_path"
    oort_release_env
    return "$doctor_code"
  fi

  printf 'oort upgrade: %s → %s\n' "$previous" "$target_image"
  oort_release_env
  return 0
}

oort_backup_usage() {
  cat <<'EOF'
Usage: scripts/oort backup [--out DIR] [--env FILE] [--tier t1|t2]

Calls scripts/self_host_pg_dump.sh. The dump name gets version, UTC time,
and image digest suffixes. Does not print secrets.
--tier must match MOMO_SELF_HOST_PLATFORM when that stamp exists.
EOF
}

oort_backup() {
  local env_path="" out_dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        [ "$#" -ge 2 ] || { oort_backup_usage >&2; return 2; }
        env_path="$2"
        shift 2
        ;;
      --env=*)
        env_path="${1#--env=}"
        shift
        ;;
      --out | --output-dir)
        [ "$#" -ge 2 ] || { oort_backup_usage >&2; return 2; }
        out_dir="$2"
        shift 2
        ;;
      --out=* | --output-dir=*)
        out_dir="${1#*=}"
        shift
        ;;
      --tier)
        [ "$#" -ge 2 ] || { oort_backup_usage >&2; return 2; }
        oort_set_tier_override "$2"
        shift 2
        ;;
      --tier=*)
        oort_set_tier_override "${1#--tier=}"
        shift
        ;;
      -h | --help)
        oort_backup_usage
        return 0
        ;;
      *)
        printf 'oort backup: 알 수 없는 인자: %s\n' "$1" >&2
        oort_backup_usage >&2
        return 2
        ;;
    esac
  done

  oort_prepare_env "$env_path"
  oort_tier >/dev/null
  if [ -z "$out_dir" ]; then
    out_dir="${HOME}/oort-backups"
  fi
  mkdir -p "$out_dir"
  chmod 700 "$out_dir" 2>/dev/null || true

  local dump_log path stamp version digest_slug image digest
  dump_log="$(mktemp "${TMPDIR:-/tmp}/oort-backup-log.XXXXXX")"
  chmod 600 "$dump_log"
  if [ "$(oort_tier)" = "t2" ]; then
    "$OORT_ROOT/scripts/self_host_pg_dump.sh" \
      --env-file "$OORT_DOCTOR_ENV" \
      --output-dir "$out_dir" \
      --migrate-url \
      >"$dump_log"
  else
    "$OORT_ROOT/scripts/self_host_pg_dump.sh" \
      --env-file "$OORT_DOCTOR_ENV" \
      --output-dir "$out_dir" \
      --compose-project "$(oort_project_name)" \
      >"$dump_log"
  fi
  if [ "$(oort_tier)" = "t2" ]; then
    sed -E 's#(postgres(ql)?://)[^:/@]+:[^@]+@#\1***:***@#g' "$dump_log"
  else
    cat "$dump_log"
  fi
  path="$(awk -F': ' '$1 == "[self-host-backup] path" { print $2; exit }' "$dump_log")"
  rm -f "$dump_log"
  [ -n "$path" ] && [ -s "$path" ] || oort_die "덤프 경로를 읽지 못했다."

  stamp="$(date -u +"%Y%m%dT%H%M%SZ")"
  version="$(jq -r '.version // "unknown"' "$OORT_ROOT/releases/latest.json" 2>/dev/null || printf 'unknown')"
  image="$(oort_doctor_get MOMO_RUST_IMAGE)"
  digest="$(oort_extract_digest "$image" || true)"
  if [ -n "$digest" ]; then
    digest_slug="$(printf '%s' "$digest" | tr ':' '_')"
  else
    digest_slug="local"
  fi
  local dest
  dest="$(CDPATH='' cd -- "$out_dir" && pwd)/oort-pg-${version}-${stamp}-${digest_slug}.dump"
  mv "$path" "$dest"
  chmod 600 "$dest"
  printf '[oort backup] path: %s\n' "$dest"
  oort_release_env
}

oort_restore_usage() {
  cat <<'EOF'
Usage: scripts/oort restore <dump> [--yes] [--env FILE] [--tier t1|t2]

Restores into an empty stack only (message count == 0). Ensures the
destination has runtime roles (compose service runtime-roles) then calls
scripts/self_host_pg_restore.sh. Never prints secrets.
--tier must match MOMO_SELF_HOST_PLATFORM when that stamp exists.
EOF
}

oort_runtime_roles_count() {
  local user db out
  if [ "$(oort_tier)" = "t2" ]; then
    out="$(oort_psql_migrate "SELECT count(*)::text FROM pg_roles WHERE rolname IN ('momo_app','momo_relay','momo_worker','momo_notifier');" || true)"
    if [ -z "$out" ]; then
      return 1
    fi
    printf '%s' "$out"
    return 0
  fi
  user="$(oort_doctor_get POSTGRES_USER)"
  db="$(oort_doctor_get POSTGRES_DB)"
  [ -n "$user" ] || user=momo
  [ -n "$db" ] || db=momo
  out="$(oort_compose exec -T postgres \
    psql -U "$user" -d "$db" -At -c \
    "SELECT count(*)::text FROM pg_roles WHERE rolname IN ('momo_app','momo_relay','momo_worker','momo_notifier');" \
    2>/dev/null || true)"
  out="$(printf '%s' "$out" | tr -d '\r' | awk 'NF { print; exit }')"
  if [ -z "$out" ]; then
    return 1
  fi
  printf '%s' "$out"
}

oort_ensure_runtime_roles() {
  local n
  n="$(oort_runtime_roles_count || true)"
  if [ "$n" = "4" ]; then
    return 0
  fi
  if [ "$(oort_tier)" = "t2" ]; then
    oort_die "runtime roles (momo_app/momo_relay/momo_worker/momo_notifier) are absent (${n:-0}/4). 플랫폼 preDeploy(\`MOMO_RUNTIME_ROLE_PROVISION=1 momo-migrate\`)를 먼저 돌려라"
  fi
  printf 'oort restore: runtime roles absent (%s/4); running compose service runtime-roles\n' \
    "${n:-0}"
  if ! oort_compose run --rm runtime-roles; then
    oort_die "runtime roles (momo_app/momo_relay/momo_worker/momo_notifier) are absent. The destination must complete the stack's runtime-roles step (compose service runtime-roles, MOMO_RUNTIME_ROLE_PROVISION=1) before restore."
  fi
  n="$(oort_runtime_roles_count || true)"
  if [ "$n" != "4" ]; then
    oort_die "runtime roles (momo_app/momo_relay/momo_worker/momo_notifier) are still absent after runtime-roles. The destination must complete the stack's runtime-roles step (compose service runtime-roles, MOMO_RUNTIME_ROLE_PROVISION=1) before restore."
  fi
}

oort_restore() {
  local env_path="" yes=0 dump=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        [ "$#" -ge 2 ] || { oort_restore_usage >&2; return 2; }
        env_path="$2"
        shift 2
        ;;
      --env=*)
        env_path="${1#--env=}"
        shift
        ;;
      --yes | -y)
        yes=1
        shift
        ;;
      --tier)
        [ "$#" -ge 2 ] || { oort_restore_usage >&2; return 2; }
        oort_set_tier_override "$2"
        shift 2
        ;;
      --tier=*)
        oort_set_tier_override "${1#--tier=}"
        shift
        ;;
      -h | --help)
        oort_restore_usage
        return 0
        ;;
      --*)
        printf 'oort restore: 알 수 없는 인자: %s\n' "$1" >&2
        oort_restore_usage >&2
        return 2
        ;;
      *)
        if [ -n "$dump" ]; then
          oort_die "restore 덤프는 하나만 지정한다."
        fi
        dump="$1"
        shift
        ;;
    esac
  done
  [ -n "$dump" ] || { oort_restore_usage >&2; return 2; }
  [ -s "$dump" ] || oort_die "덤프 파일이 없거나 비었다: $dump"

  oort_prepare_env "$env_path"
  oort_tier >/dev/null

  if [ "$yes" -ne 1 ]; then
    if [ ! -t 0 ]; then
      oort_die "확인이 필요하다. --yes 를 붙여라."
    fi
    printf 'restore %s 를 빈 스택에 넣을까? [y/N] ' "$dump"
    local ans
    IFS= read -r ans || ans=""
    case "$ans" in
      y | Y | yes | YES) ;;
      *) oort_die "취소했다." ;;
    esac
  fi

  local count
  count="$(oort_message_count || true)"
  if [ -z "$count" ]; then
    oort_die "스택 occupancy 를 읽지 못했다. 비어 있는지 확인되지 않으면 복원하지 않는다."
  fi
  if ! printf '%s' "$count" | grep -Eq '^[0-9]+$'; then
    oort_die "스택 occupancy 가 숫자가 아니다."
  fi
  if [ "$count" -gt 0 ]; then
    oort_die "스택이 비어 있지 않다 (message count=${count}). 빈 스택에만 복원한다. 기존 데이터를 덮어쓰지 않는다."
  fi

  oort_ensure_runtime_roles

  if [ "$(oort_tier)" = "t2" ]; then
    if oort_schema_present; then
      "$OORT_ROOT/scripts/self_host_pg_restore.sh" --dump "$dump" \
        --env-file "$OORT_DOCTOR_ENV" \
        --migrate-url \
        --clean
    else
      "$OORT_ROOT/scripts/self_host_pg_restore.sh" --dump "$dump" \
        --env-file "$OORT_DOCTOR_ENV" \
        --migrate-url
    fi
  elif oort_schema_present; then
    # shellcheck disable=SC2086
    "$OORT_ROOT/scripts/self_host_pg_restore.sh" --dump "$dump" \
      --env-file "$OORT_DOCTOR_ENV" \
      --compose-project "$(oort_project_name)" \
      --clean
  else
    "$OORT_ROOT/scripts/self_host_pg_restore.sh" --dump "$dump" \
      --env-file "$OORT_DOCTOR_ENV" \
      --compose-project "$(oort_project_name)"
  fi
  oort_release_env
}

oort_member_usage() {
  cat <<'EOF'
Usage:
  scripts/oort member invite [--role member] [--expires 24h] [--env FILE]
                           [--token-file FILE] [--workspace UUID]
  scripts/oort member credential --agent <handle> [--scopes s1,s2]
                           [--env FILE] [--token-file FILE] [--workspace UUID]

Operator bearer from --token-file or OORT_OPERATOR_TOKEN, else owner login.
Invite raw code and agent bearer are printed once and never stored.
EOF
}

oort_parse_expires_ms() {
  local spec="$1"
  python3 - "$spec" <<'PY'
import sys
import time

spec = sys.argv[1]
now = int(time.time() * 1000)
if spec.isdigit():
    print(int(spec))
    raise SystemExit(0)
if not spec or spec[-1] not in "smhd":
    raise SystemExit("expires 형식이 아니다 (24h, 7d, 30m, 또는 epoch ms).")
unit = spec[-1]
raw = spec[:-1]
if not raw.isdigit():
    raise SystemExit("expires 형식이 아니다.")
n = int(raw)
mult = {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}[unit]
print(now + n * mult)
PY
}

oort_jwt_workspace() {
  local token="$1"
  python3 - "$token" <<'PY'
import base64
import json
import sys

token = sys.argv[1]
parts = token.split(".")
if len(parts) < 2:
    raise SystemExit(1)
pad = "=" * ((4 - len(parts[1]) % 4) % 4)
payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
ws = payload.get("ws") or payload.get("workspaceId") or ""
if not ws:
    raise SystemExit(1)
print(ws)
PY
}

oort_member_token() {
  local token_file="$1" token=""
  if [ -n "$token_file" ]; then
    [ -f "$token_file" ] || oort_die "token-file 이 없다: $token_file"
    token="$(tr -d '\r\n' <"$token_file")"
    [ -n "$token" ] || oort_die "token-file 이 비었다."
    printf '%s' "$token"
    return 0
  fi
  if [ -n "${OORT_OPERATOR_TOKEN:-}" ]; then
    printf '%s' "$OORT_OPERATOR_TOKEN"
    return 0
  fi
  local email password base body code resp
  email="$(oort_doctor_get MOMO_INITIAL_OWNER_EMAIL)"
  password="$(oort_doctor_get MOMO_INITIAL_OWNER_PASSWORD)"
  [ -n "$email" ] && [ -n "$password" ] || \
    oort_die "운영자 토큰이 없다. --token-file 또는 OORT_OPERATOR_TOKEN 을 지정하라."
  base="$(oort_base_url)" || oort_die "웹/API 포트 키가 없다."
  body="$(mktemp "${TMPDIR:-/tmp}/oort-login-req.XXXXXX")"
  resp="$(mktemp "${TMPDIR:-/tmp}/oort-login-resp.XXXXXX")"
  chmod 600 "$body" "$resp"
  OORT_LOGIN_EMAIL="$email" OORT_LOGIN_PASSWORD="$password" python3 - "$body" <<'PY'
import json
import os
import sys

path = sys.argv[1]
with open(path, "w", encoding="utf-8") as fh:
    json.dump(
        {
            "email": os.environ["OORT_LOGIN_EMAIL"],
            "password": os.environ["OORT_LOGIN_PASSWORD"],
        },
        fh,
        ensure_ascii=False,
    )
PY
  unset OORT_LOGIN_PASSWORD
  code="$(curl -sS -m 10 -o "$resp" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -d @"$body" \
    "${base}/v1/auth/login" 2>/dev/null || true)"
  rm -f "$body"
  [ "$code" = "200" ] || {
    rm -f "$resp"
    oort_die "로그인 실패 (HTTP ${code:-000}). 비밀번호를 출력하지 않는다."
  }
  token="$(jq -r '.accessToken // empty' "$resp")"
  rm -f "$resp"
  [ -n "$token" ] || oort_die "로그인 응답에 accessToken 이 없다."
  printf '%s' "$token"
}

oort_member_invite() {
  local env_path="" role="member" expires="24h" token_file="" workspace=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        env_path="$2"; shift 2 ;;
      --role)
        role="$2"; shift 2 ;;
      --expires)
        expires="$2"; shift 2 ;;
      --token-file)
        token_file="$2"; shift 2 ;;
      --workspace)
        workspace="$2"; shift 2 ;;
      -h | --help)
        oort_member_usage
        return 0
        ;;
      *)
        oort_die "member invite: 알 수 없는 인자: $1"
        ;;
    esac
  done
  case "$role" in
    owner | admin | member | guest) ;;
    *) oort_die "role 은 owner|admin|member|guest 여야 한다." ;;
  esac
  oort_prepare_env "$env_path"
  local expires_ms token base body resp code
  expires_ms="$(oort_parse_expires_ms "$expires")" || oort_die "expires 형식이 아니다: $expires"
  token="$(oort_member_token "$token_file")"
  if [ -z "$workspace" ]; then
    workspace="$(oort_jwt_workspace "$token" || true)"
  fi
  [ -n "$workspace" ] || oort_die "workspace id 를 얻지 못했다. --workspace 를 지정하라."
  base="$(oort_base_url)" || oort_die "웹/API 포트 키가 없다."
  body="$(mktemp "${TMPDIR:-/tmp}/oort-invite-req.XXXXXX")"
  resp="$(mktemp "${TMPDIR:-/tmp}/oort-invite-resp.XXXXXX")"
  chmod 600 "$body" "$resp"
  python3 - "$body" "$role" "$expires_ms" <<'PY'
import json
import sys

path, role, expires = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"role": role, "expiresAtMs": expires}, fh, ensure_ascii=False)
PY
  code="$(curl -sS -m 15 -o "$resp" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    -d @"$body" \
    "${base}/v1/workspaces/${workspace}/invites" 2>/dev/null || true)"
  rm -f "$body"
  unset token
  [ "$code" = "201" ] || {
    rm -f "$resp"
    oort_die "초대 생성 실패 (HTTP ${code:-000})."
  }
  jq -r '"invite id=" + (.invite.id // "") + "\ncode=" + .code' "$resp"
  rm -f "$resp"
  oort_release_env
}

oort_member_credential() {
  local env_path="" handle="" scopes="" token_file="" workspace=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        env_path="$2"; shift 2 ;;
      --agent)
        handle="$2"; shift 2 ;;
      --scopes)
        scopes="$2"; shift 2 ;;
      --token-file)
        token_file="$2"; shift 2 ;;
      --workspace)
        workspace="$2"; shift 2 ;;
      -h | --help)
        oort_member_usage
        return 0
        ;;
      *)
        oort_die "member credential: 알 수 없는 인자: $1"
        ;;
    esac
  done
  [ -n "$handle" ] || oort_die "member credential 은 --agent <handle> 이 필요하다."
  oort_prepare_env "$env_path"
  local token base roster agent_id body resp code
  token="$(oort_member_token "$token_file")"
  if [ -z "$workspace" ]; then
    workspace="$(oort_jwt_workspace "$token" || true)"
  fi
  [ -n "$workspace" ] || oort_die "workspace id 를 얻지 못했다. --workspace 를 지정하라."
  base="$(oort_base_url)" || oort_die "웹/API 포트 키가 없다."
  roster="$(mktemp "${TMPDIR:-/tmp}/oort-roster.XXXXXX")"
  chmod 600 "$roster"
  code="$(curl -sS -m 15 -o "$roster" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    "${base}/v1/workspaces/${workspace}/roster?kind=agent" 2>/dev/null || true)"
  [ "$code" = "200" ] || {
    rm -f "$roster"
    oort_die "roster 조회 실패 (HTTP ${code:-000})."
  }
  agent_id="$(HANDLE="$handle" python3 - "$roster" <<'PY'
import json
import os
import sys

handle = os.environ["HANDLE"]
doc = json.load(open(sys.argv[1], encoding="utf-8"))
members = doc.get("members") or doc.get("roster") or []
for row in members:
    if str(row.get("handle", "")).lower() == handle.lower():
        print(row.get("id", ""))
        raise SystemExit(0)
raise SystemExit(1)
PY
)" || true
  rm -f "$roster"
  [ -n "$agent_id" ] || oort_die "handle 에 해당하는 agent 가 roster 에 없다."

  body="$(mktemp "${TMPDIR:-/tmp}/oort-cred-req.XXXXXX")"
  resp="$(mktemp "${TMPDIR:-/tmp}/oort-cred-resp.XXXXXX")"
  chmod 600 "$body" "$resp"
  python3 - "$body" "$scopes" <<'PY'
import json
import sys

path, scopes = sys.argv[1], sys.argv[2]
payload = {}
if scopes:
    payload["scopes"] = [s for s in scopes.split(",") if s]
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False)
PY
  code="$(curl -sS -m 15 -o "$resp" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    -H 'Cache-Control: no-store' \
    -d @"$body" \
    "${base}/v1/workspaces/${workspace}/agents/${agent_id}/credentials" 2>/dev/null || true)"
  rm -f "$body"
  unset token
  [ "$code" = "201" ] || {
    rm -f "$resp"
    oort_die "자격 발급 실패 (HTTP ${code:-000})."
  }
  jq -r '"credential id=" + (.credential.id // "") + "\ntoken=" + .token' "$resp"
  rm -f "$resp"
  oort_release_env
}

oort_member() {
  local sub="${1:-}"
  if [ "$#" -gt 0 ]; then
    shift
  fi
  case "$sub" in
    invite)
      oort_member_invite "$@"
      ;;
    credential)
      oort_member_credential "$@"
      ;;
    help | -h | --help | '')
      oort_member_usage
      ;;
    *)
      printf 'oort member: 알 수 없는 하위명령: %s\n' "$sub" >&2
      oort_member_usage >&2
      return 2
      ;;
  esac
}
