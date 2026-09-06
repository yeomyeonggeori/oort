#!/usr/bin/env bash
# sourced by scripts/oort day-2 commands. bash 3.2.
# Reuses oort_doctor_* (load, get, sanitize, record, JSON). Do not copy those.
# Relies on OORT_ROOT from the dispatcher.

OORT_DIGEST_RE='^sha256:[0-9a-f]{64}$'
OORT_PUBLISHED_REF='ghcr.io/yeomyeonggeori/oort'

oort_die() {
  printf 'scripts/oort: %s\n' "$*" >&2
  exit 1
}

oort_common_is_secret_key() {
  case "$1" in
    *PASSWORD* | *SECRET* | *HMAC* | *DATABASE_URL | PROVIDER_LINK_MASTER_KEY | CENT_API_KEY)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

oort_prepare_env() {
  local env_path="${1:-}"
  : "${OORT_ROOT:?oort: OORT_ROOT unset}"
  if [ -z "$env_path" ]; then
    env_path="$OORT_ROOT/infra/rust/local.secrets.env"
  fi
  if [ ! -f "$env_path" ]; then
    oort_die "env 파일이 없다: $env_path. scripts/self_host_env.sh 로 생성하라."
  fi
  OORT_DOCTOR_ENV="$env_path"
  # Used by oort_doctor_count / duplicate-key readers in the doctor library.
  # shellcheck disable=SC2034
  OORT_DOCTOR_ENV_RAW="$env_path"
  if [ -n "${OORT_DOCTOR_ENV_NORM:-}" ]; then
    rm -f "$OORT_DOCTOR_ENV_NORM"
  fi
  OORT_DOCTOR_ENV_NORM="$(mktemp "${TMPDIR:-/tmp}/oort-env-norm.XXXXXX")"
  chmod 600 "$OORT_DOCTOR_ENV_NORM" 2>/dev/null || true
  oort_doctor_load_env "$OORT_DOCTOR_ENV"
}

oort_release_env() {
  if [ -n "${OORT_DOCTOR_ENV_NORM:-}" ]; then
    rm -f "$OORT_DOCTOR_ENV_NORM"
    OORT_DOCTOR_ENV_NORM=""
  fi
}

oort_project_name() {
  local project
  project="$(oort_doctor_get COMPOSE_PROJECT_NAME)"
  if [ -z "$project" ]; then
    printf 'oort'
  else
    printf '%s' "$project"
  fi
}

oort_compose() {
  local project mode envfile
  project="$(oort_project_name)"
  mode="$(oort_doctor_get MOMO_SELF_HOST_MODE)"
  envfile="$OORT_DOCTOR_ENV"
  (
    CDPATH='' cd -- "$OORT_ROOT" || exit 1
    if [ "$mode" = "local-build" ]; then
      docker compose --env-file "$envfile" -p "$project" \
        -f infra/rust/docker-compose.rust.yml \
        -f infra/rust/docker-compose.rust.build.yml \
        -f infra/rust/local.override.yml \
        "$@"
    else
      docker compose --env-file "$envfile" -p "$project" \
        -f infra/rust/docker-compose.rust.yml \
        -f infra/rust/local.override.yml \
        "$@"
    fi
  )
}

oort_extract_digest() {
  local spec="$1"
  case "$spec" in
    *@sha256:*) printf '%s' "${spec##*@}" ;;
    sha256:*) printf '%s' "$spec" ;;
    *) return 1 ;;
  esac
}

oort_validate_list_digest() {
  local digest="$1" arch latest
  if ! printf '%s' "$digest" | grep -Eq "$OORT_DIGEST_RE"; then
    oort_die "digest 형식이 아니다. ${OORT_DIGEST_RE} 이어야 한다 (sha256: + 64 lowercase hex)."
  fi
  latest="$OORT_ROOT/releases/latest.json"
  [ -f "$latest" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  while IFS= read -r arch; do
    [ -n "$arch" ] || continue
    if [ "$digest" = "$arch" ]; then
      oort_die "list≠arch: 이 digest 는 images.app.digests 의 아키텍처 digest 다. releases/latest.json 의 digest_list 를 써라."
    fi
  done <<EOF
$(jq -r '.images.app.digests // {} | .[]' "$latest" 2>/dev/null || true)
EOF
}

oort_image_ref_for_digest() {
  printf '%s@%s' "$OORT_PUBLISHED_REF" "$1"
}

oort_manifest_list_digest() {
  local latest="$OORT_ROOT/releases/latest.json"
  if [ -f "$latest" ] && command -v jq >/dev/null 2>&1; then
    jq -r '.images.app.digest_list // empty' "$latest" 2>/dev/null || true
  fi
}

oort_volume_present() {
  local name="$1"
  [ -n "$name" ] || return 1
  case "$name" in
    /*)
      [ -d "$name" ]
      return
      ;;
  esac
  docker volume inspect "$name" >/dev/null 2>&1
}

oort_require_volumes() {
  local db drive
  db="$(oort_doctor_get DB_VOLUME_NAME)"
  drive="$(oort_doctor_get DRIVE_VOLUME_NAME)"
  [ -n "$db" ] || oort_die "env 에 DB_VOLUME_NAME 이 없다."
  if ! oort_volume_present "$db"; then
    oort_die "볼륨이 없다: ${db} — 만들지도 지우지도 않는다. 이 env 의 스택이 그 볼륨을 쓰도록 올린 뒤 다시 실행하라."
  fi
  if [ -n "$drive" ] && ! oort_volume_present "$drive"; then
    oort_die "볼륨이 없다: ${drive} — 만들지도 지우지도 않는다."
  fi
  [ -f "$OORT_ROOT/infra/rust/Caddyfile.local" ] || \
    oort_die "bind 원본이 없다: infra/rust/Caddyfile.local"
  [ -f "$OORT_ROOT/infra/rust/docker-compose.rust.yml" ] || \
    oort_die "compose 파일이 없다: infra/rust/docker-compose.rust.yml"
}

oort_secret_values_file() {
  local dest="$1" key value pw
  : >"$dest"
  chmod 600 "$dest" 2>/dev/null || true
  [ -n "${OORT_DOCTOR_ENV_NORM:-}" ] && [ -f "$OORT_DOCTOR_ENV_NORM" ] || return 0
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    oort_common_is_secret_key "$key" || continue
    oort_doctor_has "$key" || continue
    value="$(oort_doctor_get "$key")"
    [ -n "$value" ] || continue
    printf '%s\n' "$value" >>"$dest"
    pw="$(oort_doctor_url_password "$value" || true)"
    if [ -n "$pw" ]; then
      printf '%s\n' "$pw" >>"$dest"
    fi
  done <<EOF
$(awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 }' "$OORT_DOCTOR_ENV_NORM")
EOF
}

oort_mask_stream() {
  local secrets_file="$1"
  # Heredoc occupies stdin; the log stream is duplicated onto fd 3.
  python3 -u - "$secrets_file" 3<&0 <<'PY'
import os
import re
import sys

path = sys.argv[1]
secrets = []
try:
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            value = raw.rstrip("\n")
            if value:
                secrets.append(value)
except OSError:
    pass
secrets.sort(key=len, reverse=True)
bearer = re.compile(r"(?i)(Bearer)\s+\S+")
pg = re.compile(r"(postgres(?:ql)?://)[^:/@\s]+:[^@\s]*@")
for line in os.fdopen(3):
    for secret in secrets:
        line = line.replace(secret, "***")
    line = bearer.sub(r"\1 ***", line)
    line = pg.sub(r"\1***:***@", line)
    sys.stdout.write(line)
    sys.stdout.flush()
PY
}

oort_message_count() {
  local user db exists out
  user="$(oort_doctor_get POSTGRES_USER)"
  db="$(oort_doctor_get POSTGRES_DB)"
  [ -n "$user" ] || user=momo
  [ -n "$db" ] || db=momo
  exists="$(oort_compose exec -T postgres \
    psql -U "$user" -d "$db" -At -c \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='message') THEN 1 ELSE 0 END;" \
    2>/dev/null || true)"
  exists="$(printf '%s' "$exists" | tr -d '\r' | awk 'NF { print; exit }')"
  if [ -z "$exists" ]; then
    return 1
  fi
  if [ "$exists" != "1" ]; then
    printf '0'
    return 0
  fi
  out="$(oort_compose exec -T postgres \
    psql -U "$user" -d "$db" -At -c "SELECT count(*)::text FROM message;" \
    2>/dev/null || true)"
  out="$(printf '%s' "$out" | tr -d '\r' | awk 'NF { print; exit }')"
  if [ -z "$out" ]; then
    return 1
  fi
  printf '%s' "$out"
}

oort_schema_present() {
  local user db out
  user="$(oort_doctor_get POSTGRES_USER)"
  db="$(oort_doctor_get POSTGRES_DB)"
  [ -n "$user" ] || user=momo
  [ -n "$db" ] || db=momo
  out="$(oort_compose exec -T postgres \
    psql -U "$user" -d "$db" -At -c \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='message') THEN 1 ELSE 0 END;" \
    2>/dev/null || true)"
  out="$(printf '%s' "$out" | tr -d '\r' | awk 'NF { print; exit }')"
  [ "$out" = "1" ]
}

oort_env_get_file() {
  local key="$1" file="$2"
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$file"
}

oort_image_state_from_env() {
  local env_file="$1"
  local mode image current_digest manifest
  mode="$(oort_env_get_file MOMO_SELF_HOST_MODE "$env_file")"
  image="$(oort_env_get_file MOMO_RUST_IMAGE "$env_file")"
  manifest="$(oort_manifest_list_digest)"
  printf '%s\n' "$image"
  printf '%s\n' "$manifest"
  if [ "$mode" = "local-build" ]; then
    printf 'local\n'
    return
  fi
  current_digest="$(oort_extract_digest "$image" 2>/dev/null || true)"
  if [ -n "$current_digest" ] && [ -n "$manifest" ] && [ "$current_digest" = "$manifest" ]; then
    printf 'current\n'
  elif [ -n "$current_digest" ] && [ -n "$manifest" ]; then
    printf 'behind\n'
  else
    printf 'unknown\n'
  fi
}

oort_base_url() {
  local web api
  web="$(oort_doctor_get MOMO_WEB_PORT)"
  api="$(oort_doctor_get MOMO_RUST_API_PORT)"
  if [ -n "$web" ]; then
    printf 'http://127.0.0.1:%s' "$web"
  elif [ -n "$api" ]; then
    printf 'http://127.0.0.1:%s' "$api"
  else
    return 1
  fi
}

oort_rewrite_image_line() {
  local env_file="$1" image="$2" mode="$3" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/oort-env-rewrite.XXXXXX")"
  chmod 600 "$tmp"
  awk -v img="$image" -v mode="$mode" '
    index($0, "MOMO_RUST_IMAGE=") == 1 { print "MOMO_RUST_IMAGE=" img; next }
    index($0, "MOMO_SELF_HOST_MODE=") == 1 { print "MOMO_SELF_HOST_MODE=" mode; next }
    { print }
  ' "$env_file" >"$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}
