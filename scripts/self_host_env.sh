#!/usr/bin/env bash
# oort 셀프호스트 env 생성기 (#1229). 정본 절차: docs/SELF_HOST.md
#
# `infra/rust/local.secrets.env` 를 만든다 — 이름을 채워 넣을 자리가 하나도 없는,
# 그대로 기동에 쓰는 파일이다. 이미지 공급 모드는 둘이며 섞지 않는다:
#
# * `--local-build`: 현재 checkout을 `server-rust/Dockerfile`로 빌드한다.
# * `--published-image <ref@sha256:digest>`: 공개된 불변 이미지를 pull한다.
#
# 발행 모드에서 mutable tag나 digest 없는 ref를 받으면 env를 쓰기 전에
# 실패한다. 그 경계가 없으면 사용자는 "공개 이미지"를 골랐다고
# 믿으면서 실제로는 로컬 Dockerfile을 조용히 다시 빌드할 수 있다(#1266).
#
# ## 왜 스크립트인가
#
# 템플릿(`rust-smoke.env.example`)을 손으로 채우는 경로는 값 12개를 사람이
# 만들어 넣는 일이고, 그중 넷은 **다른 줄과 정확히 같아야 한다**
# (`MOMO_APP_POSTGRES_PASSWORD` ↔ `MOMO_APP_DATABASE_URL` 안의 비밀번호, relay도
# 마찬가지). 그 두 쌍이 어긋나면 스택은 뜨고 마이그레이션도 지나간 뒤 api만
# 인증 실패로 죽는다 — 신규 셀프호스터가 원인을 찾을 수 없는 종류의 실패다.
# 여기서 한 번에 만들면 어긋날 자리가 없어진다.
#
# 첫 로그인 2줄(`MOMO_INITIAL_OWNER_*`)도 같이 채운다. 비워 두면 마이그레이션
# 012가 시드 오너의 공개 비밀번호를 잠그기 때문에(fail-closed, 옳다) **healthy한
# 스택에 쓸 수 있는 자격증명이 하나도 없다** — 2026-08-10 진단에서 time-to-hello를
# 가장 크게 늘린 단일 원인이 이것이었다.
#
# ## 규율
#
# * 이미 파일이 있으면 **절대 덮어쓰지 않는다.** 볼륨이 살아 있는 상태에서 시크릿을
#   다시 만들면 DB 안의 롤 비밀번호와 env가 어긋나 스택이 부팅하지 못한다. 이 경우
#   현재 로그인 정보만 다시 출력하고 끝낸다.
# * 값은 openssl로 만들고, 파일은 0600으로 쓴다. `*.secrets.env` 는 레포 전역
#   gitignore 대상이다.
# * 포트가 이미 쓰이고 있으면 **비어 있는 다음 포트를 골라** 알려 준다. 사람이
#   충돌을 진단하고 파일을 고치는 왕복이 이 스크립트가 없애려는 바로 그것이다.
#
# 환경변수로 바꿀 수 있는 것(전부 선택):
#   COMPOSE_PROJECT_NAME        기본 oort
#   MOMO_WEB_PORT               기본 8088 (브라우저가 여는 포트)
#   MOMO_RUST_API_PORT          기본 8080 (루프백 직접 접속용)
#   CENT_HOST_PORT              기본 8000 (루프백 직접 접속용)
#   MOMO_RUST_IMAGE             --local-build 태그(기본 oort:local)
#   MOMO_INITIAL_OWNER_EMAIL    기본 owner@oort.local (소문자여야 한다)
#   MOMO_INITIAL_OWNER_PASSWORD 기본 생성
#
# 생성 뒤의 모든 Compose 명령은 이 스크립트의 `--compose` 경유로 실행한다.
# `--env-file`보다 process env가 우선인 Compose 규칙 때문에, 파일을 만들 때만
# 검증하고 사용 시점의 ambient env를 그대로 두면 같은 파일이 다른 스택이 된다.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="infra/rust/local.secrets.env"
CANONICAL_PUBLISHED_IMAGE="ghcr.io/yeomyeonggeori/oort"
PUBLISHED_IMAGE_CONSUMERS=7
REQUESTED_MODE=""
REQUESTED_IMAGE=""
REQUESTED_ACTION="prepare"
COMPOSE_COMMAND_ARGS=()

# Compose contract의 단일 권위는 generated env의 실제 KEY= 행 + canonical file
# 세 개의 `${KEY...}` interpolation이다. `compose_ambient_keys`가 둘을 실행 시
# 추출하므로 새 secret/URL/port가 추가돼도 static unset 목록과 갈라지지 않는다.
# 아래에는 파일 밖에서 동작을 바꾸는 Compose CLI 제어 키만 명시한다.
COMPOSE_CONTRACT_FILES=(
  infra/rust/docker-compose.rust.yml
  infra/rust/docker-compose.rust.build.yml
  infra/rust/local.override.yml
)
COMPOSE_CONTROL_KEYS=(
  COMPOSE_ANSI COMPOSE_BAKE COMPOSE_CONVERT_WINDOWS_PATHS
  COMPOSE_DISABLE_ENV_FILE COMPOSE_ENV_FILES COMPOSE_EXPERIMENTAL COMPOSE_FILE
  COMPOSE_IGNORE_ORPHANS COMPOSE_MENU COMPOSE_PARALLEL_LIMIT
  COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES COMPOSE_PROGRESS
  COMPOSE_REMOVE_ORPHANS COMPOSE_STATUS_STDOUT
)

fail() { printf '[self-host] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  scripts/self_host_env.sh --local-build
  scripts/self_host_env.sh --published-image ghcr.io/yeomyeonggeori/oort@sha256:<64 lowercase hex>
  scripts/self_host_env.sh --compose <docker-compose arguments...>

No argument is a backwards-compatible alias for --local-build.
After preparation, use --compose for every start/stop/log command so ambient
Compose variables cannot override infra/rust/local.secrets.env.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-build)
      [ -z "$REQUESTED_MODE" ] || fail "이미지 모드는 한 번만 지정하라."
      REQUESTED_MODE="local-build"
      shift
      ;;
    --published-image)
      [ -z "$REQUESTED_MODE" ] || fail "이미지 모드는 한 번만 지정하라."
      [ "$#" -ge 2 ] || fail "--published-image 뒤에 ref@sha256:digest가 필요하다."
      REQUESTED_MODE="published-digest"
      REQUESTED_IMAGE="$2"
      shift 2
      ;;
    --compose)
      [ "$REQUESTED_ACTION" = "prepare" ] || fail "--compose는 한 번만 지정하라."
      [ -z "$REQUESTED_MODE" ] || fail "--compose와 이미지 생성 모드를 함께 지정할 수 없다."
      shift
      [ "$#" -gt 0 ] || fail "--compose 뒤에 docker compose 인자가 필요하다."
      REQUESTED_ACTION="compose"
      COMPOSE_COMMAND_ARGS=("$@")
      set --
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "알 수 없는 인자: $1"
      ;;
  esac
done

validate_local_image() {
  local image="$1"
  validate_env_scalar MOMO_RUST_IMAGE "$image"
  # `grep` would validate line by line: a valid first line followed by an
  # injected `KEY=value` line could then enter the generated env file. Match
  # the Bash string as one value so embedded newlines fail closed.
  [[ "$image" =~ ^[a-z0-9][a-z0-9./:_-]*$ ]] ||
    fail "로컬 빌드 이미지는 공백 없는 소문자 OCI tag여야 한다."
  case "$image" in
    *@*) fail "--local-build에서는 digest ref를 받지 않는다." ;;
  esac
}

validate_published_image() {
  local image="$1"
  validate_env_scalar MOMO_RUST_IMAGE "$image"
  [[ "$image" =~ ^ghcr\.io/yeomyeonggeori/oort@sha256:[0-9a-f]{64}$ ]] ||
    fail "공개 이미지는 ${CANONICAL_PUBLISHED_IMAGE}@sha256:<64 lowercase hex>로 pin해야 한다."
}

# Docker env files are line-oriented. Every external value written to one must
# remain one scalar line; otherwise a password can become a second KEY=value
# assignment. POSIX argv/environment entries cannot contain NUL (execve rejects
# it and Bash cannot represent it); reject both representable record separators
# before the file exists. Diagnostics name only the key, never a secret value.
validate_env_scalar() {
  local key="$1" value="$2"
  case "$value" in
    *$'\n'*|*$'\r'*) fail "$key 값에는 LF/CR 줄바꿈을 넣을 수 없다." ;;
  esac
}

validate_owner_email() {
  local email="$1"
  validate_env_scalar MOMO_INITIAL_OWNER_EMAIL "$email"
  [ "${#email}" -le 254 ] &&
    [[ "$email" =~ ^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9]([a-z0-9.-]{0,187}[a-z0-9])?$ ]] ||
    fail "MOMO_INITIAL_OWNER_EMAIL은 dotenv-safe 소문자 이메일 형식이어야 한다."
}

validate_owner_password() {
  local password="$1"
  validate_env_scalar MOMO_INITIAL_OWNER_PASSWORD "$password"
  # Compose dotenv에서 $, quotes, backslash, whitespace, #는 보간/인용/주석
  # 의미가 있다. 생성 경로는 hex이고, 수동 override도 아래 literal 집합으로
  # 제한해 파일 bytes와 컨테이너 credential이 정확히 같게 만든다.
  [[ "$password" =~ ^[-A-Za-z0-9._~!@%^+=,:/]{12,128}$ ]] ||
    fail "MOMO_INITIAL_OWNER_PASSWORD는 12..128자 dotenv-safe literal이어야 한다."
}

validate_project_name() {
  local project="$1"
  validate_env_scalar COMPOSE_PROJECT_NAME "$project"
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && [ "${#project}" -le 63 ] ||
    fail "COMPOSE_PROJECT_NAME은 63자 이하 소문자 영숫자·_·- 형식이어야 한다."
}

normalize_port() {
  local key="$1" raw="$2" port
  validate_env_scalar "$key" "$raw"
  [[ "$raw" =~ ^[0123456789]{1,5}$ ]] ||
    fail "$key 값은 1..65535 범위의 ASCII 10진수여야 한다."
  port=$((10#$raw))
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] ||
    fail "$key 값은 1..65535 범위의 ASCII 10진수여야 한다."
  printf '%s' "$port"
}

env_key_count() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { count += 1 } END { print count + 0 }' "$ENV_FILE"
}

env_value_once() {
  local key="$1" count
  count="$(env_key_count "$key")"
  [ "$count" -eq 1 ] || fail "${ENV_FILE}의 $key 항목은 정확히 한 번 있어야 한다."
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2) }' "$ENV_FILE"
}

reject_duplicate_env_keys() {
  local duplicate
  duplicate="$(awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      if (++seen[$1] == 2) { print $1; exit }
    }
  ' "$ENV_FILE")"
  [ -z "$duplicate" ] || fail "${ENV_FILE}에 중복 env 키가 있다: $duplicate"
}

compose_ambient_keys() {
  local file key
  {
    awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 }' "$ENV_FILE"
    for file in "${COMPOSE_CONTRACT_FILES[@]}"; do
      awk '
        {
          line = $0
          while (match(line, /\$\{[A-Za-z_][A-Za-z0-9_]*/)) {
            print substr(line, RSTART + 2, RLENGTH - 2)
            line = substr(line, RSTART + RLENGTH)
          }
        }
      ' "$file"
    done
    for key in "${COMPOSE_CONTROL_KEYS[@]}"; do
      printf '%s\n' "$key"
    done
  } | LC_ALL=C sort -u
}

validate_compose_command_args() {
  local subcommand="${1:-}" argument after_delimiter=0
  case "$subcommand" in
    build|config|cp|create|down|events|exec|help|images|kill|logs|ls|pause|port|ps|pull|restart|rm|run|start|stop|top|unpause|up|version|wait|watch) ;;
    *) fail "--compose는 허용된 compose subcommand로 시작해야 한다." ;;
  esac
  for argument in "$@"; do
    if [ "$after_delimiter" -eq 1 ]; then
      continue
    fi
    if [ "$argument" = "--" ]; then
      after_delimiter=1
      continue
    fi
    case "$argument" in
      -f|-f?*|--file|--file=*|-p|-p?*|--project-name|--project-name=*|--env-file|--env-file=*|--project-directory|--project-directory=*|--profile|--profile=*|--all-resources|--ansi|--ansi=*|--compatibility|--dry-run|--parallel|--parallel=*|--progress|--progress=*)
        fail "--compose에서는 canonical env/file/project/profile 또는 Compose global control을 바꾸는 인자를 사용할 수 없다."
        ;;
    esac
  done
}

run_self_host_compose() {
  local mode="$1"
  shift
  local key
  local -a unset_args=() compose_args=(
    --env-file "$ENV_FILE"
    -f infra/rust/docker-compose.rust.yml
  )
  validate_compose_command_args "$@"
  for key in "${COMPOSE_CONTRACT_FILES[@]}"; do
    [ -f "$key" ] || fail "canonical Compose file이 없다: $key"
  done
  while IFS= read -r key; do
    case "$key" in
      DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG) continue ;;
    esac
    unset_args+=(-u "$key")
  done < <(compose_ambient_keys)
  case "$mode" in
    local-build)
      compose_args+=(
        -f infra/rust/docker-compose.rust.build.yml
        -f infra/rust/local.override.yml
      )
      ;;
    published-digest)
      compose_args+=(-f infra/rust/local.override.yml)
      ;;
    *) fail "저장된 MOMO_SELF_HOST_MODE가 잘못됐다: $mode" ;;
  esac
  env "${unset_args[@]}" "$DOCKER_BIN" compose "${compose_args[@]}" "$@"
}

verify_published_compose_image() {
  local expected_image="$1" rendered_images count
  validate_published_image "$expected_image"
  rendered_images="$(run_self_host_compose published-digest config --images)" ||
    fail "published-digest Compose 렌더링에 실패했다."
  count="$(printf '%s\n' "$rendered_images" | awk -v expected="$expected_image" '
    $0 == expected { count += 1 }
    END { print count + 0 }
  ')"
  [ "$count" -eq "$PUBLISHED_IMAGE_CONSUMERS" ] ||
    fail "published-digest Compose의 앱 이미지가 pin과 다르다(expected consumers=$PUBLISHED_IMAGE_CONSUMERS, matched=$count)."
}

command -v openssl >/dev/null 2>&1 || fail "openssl 없음 — 시크릿을 만들 수 없다."
DOCKER_BIN="$(command -v docker || true)"
[ -n "$DOCKER_BIN" ] || fail "docker 없음 — https://docs.docker.com/get-docker/"

# 이미 쓰이는 포트인가. bash /dev/tcp 로만 재므로 추가 의존이 없다.
port_busy() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && { exec 3>&- 3<&-; return 0; }
  return 1
}

# 요청한 포트가 비어 있으면 그대로, 아니면 비어 있는 다음 포트를 돌려준다.
pick_port() {
  local port="$1" limit
  # The caller has normalized `port`. Never feed an untrusted string to Bash
  # arithmetic: arithmetic expressions recursively evaluate their contents.
  limit=$((port + 40))
  [ "$limit" -le 65536 ] || limit=65536
  while [ "$port" -lt "$limit" ]; do
    port_busy "$port" || { printf '%s' "$port"; return 0; }
    port=$((port + 1))
  done
  fail "포트 $1..$limit 가 전부 사용 중이다. MOMO_WEB_PORT 등으로 직접 지정하라."
}

print_next_steps() {
  local mode="$1" web_port="$2" owner_email="$3"
  local up_args mode_summary
  case "$mode" in
    local-build)
      up_args="up -d --build --wait"
      mode_summary="로컬 빌드 — 현재 checkout을 server-rust/Dockerfile로 짓는다."
      ;;
    published-digest)
      # Pull only absent artifacts. The oort ref is immutable, while `always`
      # would also refresh unrelated mutable helper images such as caddy:2-alpine.
      up_args="up -d --pull missing --wait"
      mode_summary="공개 digest pull — 로컬 빌드 오버레이와 빌드 실행을 생략한다."
      ;;
    *) fail "저장된 MOMO_SELF_HOST_MODE가 잘못됐다: $mode" ;;
  esac
  cat <<EOF

[self-host] 준비됐다. 모드: $mode_summary
[self-host] 다음 한 줄이 스택을 띄운다:

  scripts/self_host_env.sh --compose $up_args

[self-host] --wait 가 붙어 있으므로 그 명령이 끝나면 준비가 끝난 것이다.
[self-host] 브라우저에서 열고 아래로 로그인한다:

  http://localhost:${web_port}
  email    ${owner_email}
  password $ENV_FILE 의 MOMO_INITIAL_OWNER_PASSWORD 값

[self-host] 비밀번호는 stdout에 쓰지 않는다. $ENV_FILE 에서 직접 확인하라(파일 권한 600).
EOF
}

# ---------------------------------------------------------------------------
# 이미 있으면 다시 만들지 않는다
# ---------------------------------------------------------------------------
if [ -e "$ENV_FILE" ]; then
  reject_duplicate_env_keys
  existing_image="$(env_value_once MOMO_RUST_IMAGE)"
  existing_web_port="$(env_value_once MOMO_WEB_PORT)"
  existing_email="$(env_value_once MOMO_INITIAL_OWNER_EMAIL)"
  existing_password="$(env_value_once MOMO_INITIAL_OWNER_PASSWORD)"
  mode_count="$(env_key_count MOMO_SELF_HOST_MODE)"
  [ "$mode_count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_SELF_HOST_MODE 항목은 최대 한 번만 있어야 한다."
  existing_mode=""
  if [ "$mode_count" -eq 1 ]; then
    existing_mode="$(env_value_once MOMO_SELF_HOST_MODE)"
  fi
  validate_env_scalar MOMO_RUST_IMAGE "$existing_image"
  validate_owner_email "$existing_email"
  validate_owner_password "$existing_password"
  existing_web_port="$(normalize_port MOMO_WEB_PORT "$existing_web_port")"

  # #1229로 이미 만든 로컬 파일은 mode marker가 없다. 이미지만 보고
  # 가역적으로 승격하되, digest가 없는 ref를 published로 추정하지 않는다.
  if [ -z "$existing_mode" ]; then
    case "$existing_image" in
      "$CANONICAL_PUBLISHED_IMAGE"@sha256:*) existing_mode="published-digest" ;;
      *) existing_mode="local-build" ;;
    esac
    printf '[self-host] 기존 env에 MOMO_SELF_HOST_MODE가 없어 %s로 판정했다.\n' "$existing_mode"
  fi

  case "$existing_mode" in
    local-build) validate_local_image "$existing_image" ;;
    published-digest) validate_published_image "$existing_image" ;;
    *) fail "${ENV_FILE}의 MOMO_SELF_HOST_MODE가 잘못됐다." ;;
  esac
  if [ -n "$REQUESTED_MODE" ] && [ "$REQUESTED_MODE" != "$existing_mode" ]; then
    fail "${ENV_FILE}은 $existing_mode 모드다. 볼륨을 내리고 env를 지운 뒤 모드를 바꾸라."
  fi
  if [ "$REQUESTED_MODE" = "published-digest" ] && [ "$REQUESTED_IMAGE" != "$existing_image" ]; then
    fail "${ENV_FILE}이 다른 digest를 pin하고 있다. 업그레이드는 별도 절차로 하라."
  fi
  if [ "$existing_mode" = "published-digest" ]; then
    verify_published_compose_image "$existing_image"
  fi
  if [ "$REQUESTED_ACTION" = "compose" ]; then
    run_self_host_compose "$existing_mode" "${COMPOSE_COMMAND_ARGS[@]}"
    exit $?
  fi
  printf '[self-host] %s 는 이미 있다 — 그대로 둔다.\n' "$ENV_FILE"
  printf '[self-host] 시크릿을 다시 만들면 이미 마이그레이션된 DB의 롤 비밀번호와 어긋난다.\n'
  printf '[self-host] 정말 처음부터 다시 하려면: 스택을 down -v 로 내리고 이 파일을 지운 뒤 다시 실행.\n'
  print_next_steps "$existing_mode" "$existing_web_port" "${existing_email:-?}"
  exit 0
fi

[ "$REQUESTED_ACTION" = "prepare" ] || fail "$ENV_FILE 없음 — 먼저 이미지 모드를 선택해 env를 생성하라."

# ---------------------------------------------------------------------------
# 값
# ---------------------------------------------------------------------------
gen() { openssl rand -hex 24; }

PROJECT="${COMPOSE_PROJECT_NAME:-oort}"
validate_project_name "$PROJECT"
MODE="${REQUESTED_MODE:-local-build}"
case "$MODE" in
  local-build)
    IMAGE="${MOMO_RUST_IMAGE:-oort:local}"
    validate_local_image "$IMAGE"
    ;;
  published-digest)
    IMAGE="$REQUESTED_IMAGE"
    validate_published_image "$IMAGE"
    ;;
  *) fail "이미지 모드가 잘못됐다: $MODE" ;;
esac

REQUESTED_WEB_PORT="$(normalize_port MOMO_WEB_PORT "${MOMO_WEB_PORT:-8088}")"
REQUESTED_API_PORT="$(normalize_port MOMO_RUST_API_PORT "${MOMO_RUST_API_PORT:-8080}")"
REQUESTED_CENT_PORT="$(normalize_port CENT_HOST_PORT "${CENT_HOST_PORT:-8000}")"
WEB_PORT="$(pick_port "$REQUESTED_WEB_PORT")"
API_PORT="$(pick_port "$REQUESTED_API_PORT")"
CENT_PORT="$(pick_port "$REQUESTED_CENT_PORT")"

# 오너 주소는 소문자여야 한다: 자격증명은 lower(btrim(...))로 저장되는데 로그인
# 조회는 입력을 그대로 비교하므로, 대문자가 섞이면 계정은 생기고 로그인은 영영
# 안 된다. migrate가 부팅에서 거부하지만, 여기서 미리 막는 편이 싸다.
RAW_OWNER_EMAIL="${MOMO_INITIAL_OWNER_EMAIL:-owner@oort.local}"
validate_env_scalar MOMO_INITIAL_OWNER_EMAIL "$RAW_OWNER_EMAIL"
OWNER_EMAIL="$(printf '%s' "$RAW_OWNER_EMAIL" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
validate_owner_email "$OWNER_EMAIL"
# 사람이 브라우저에 타이핑할 값이라 hex로 만든다(96비트). 복붙도 쉽고, base64가
# 흘리는 +/= 가 env 파일과 셸 인용을 지나며 만드는 사고가 없다.
OWNER_PASSWORD="${MOMO_INITIAL_OWNER_PASSWORD:-$(openssl rand -hex 12)}"
validate_owner_password "$OWNER_PASSWORD"

PG_PASSWORD="$(gen)"
APP_PASSWORD="$(gen)"
RELAY_PASSWORD="$(gen)"
WORKER_PASSWORD="$(gen)"
JWT_SECRET="$(gen)"
CENT_TOKEN_SECRET="$(gen)"
CENT_API_SECRET="$(gen)"
CENT_PROXY_SECRET_VALUE="$(gen)"
PROVIDER_LINK_SECRET="$(gen)"

# Keep every interpolation used by the env-file sink on the same scalar guard.
for key in MODE IMAGE PG_PASSWORD APP_PASSWORD RELAY_PASSWORD WORKER_PASSWORD \
           JWT_SECRET CENT_TOKEN_SECRET CENT_API_SECRET CENT_PROXY_SECRET_VALUE \
           PROVIDER_LINK_SECRET WEB_PORT API_PORT CENT_PORT OWNER_EMAIL; do
  validate_env_scalar "$key" "${!key}"
done

mkdir -p "$(dirname "$ENV_FILE")"
cat >"$ENV_FILE" <<EOF
# oort 로컬 셀프호스트 env — scripts/self_host_env.sh 가 생성했다 (#1229).
# 절차: docs/SELF_HOST.md · 커밋 금지(*.secrets.env 는 gitignore 대상).
# 여기 값을 다시 만들려면 스택을 down -v 로 내리고 이 파일을 지운 뒤 재실행한다.

COMPOSE_PROJECT_NAME=$PROJECT
MOMO_SELF_HOST_MODE=$MODE
MOMO_RUST_IMAGE=$IMAGE
MOMO_ENV=staging
LOG_LEVEL=info

# --- postgres ---------------------------------------------------------------
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=$PG_PASSWORD
MIGRATE_DATABASE_URL=postgres://momo:$PG_PASSWORD@postgres:5432/momo
DB_VOLUME_NAME=$PROJECT-pgdata

# --- 런타임 롤 (MOMO-554) ---------------------------------------------------
# 아래 세 비밀번호와 두 URL 안의 비밀번호는 같아야 한다. 이 파일에서는 같다.
MOMO_APP_POSTGRES_PASSWORD=$APP_PASSWORD
RELAY_POSTGRES_PASSWORD=$RELAY_PASSWORD
WORKER_POSTGRES_PASSWORD=$WORKER_PASSWORD
MOMO_APP_DATABASE_URL=postgres://momo_app:$APP_PASSWORD@postgres:5432/momo
RELAY_DATABASE_URL=postgres://momo_relay:$RELAY_PASSWORD@postgres:5432/momo

# --- 앱 시크릿 --------------------------------------------------------------
JWT_HMAC=$JWT_SECRET
CENT_TOKEN_HMAC=$CENT_TOKEN_SECRET
CENT_API_KEY=$CENT_API_SECRET
CENT_PROXY_SECRET=$CENT_PROXY_SECRET_VALUE
PROVIDER_LINK_MASTER_KEY=$PROVIDER_LINK_SECRET

# --- 주소 -------------------------------------------------------------------
# 브라우저가 여는 곳. SPA · /v1 · /connection 이 전부 이 오리진에서 나오므로
# CORS가 성립할 여지가 없다(infra/rust/local.override.yml).
MOMO_WEB_PORT=$WEB_PORT
# 로그인 응답이 클라이언트에게 돌려주는 레일 주소(ADR-0110 유일 권위).
MOMO_CENTRIFUGO_WS_URL=ws://localhost:$WEB_PORT/connection/websocket
# Centrifugo는 업그레이드 전에 Origin을 대조한다. **공백 구분** 목록이고,
# localhost 로 열든 127.0.0.1 로 열든 통하도록 둘 다 적는다.
CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:$WEB_PORT http://127.0.0.1:$WEB_PORT
# 엣지를 거치지 않는 직접 접속(curl·디버깅)용 루프백 포트.
MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT

# --- 마이그레이션 -----------------------------------------------------------
MOMO_AGENT_SEED_MODE=none
MIGRATE_IDEMPOTENCY_CHECK=1

# --- 첫 로그인 (#1227) ------------------------------------------------------
# 마이그레이션 012가 시드 오너의 공개 비밀번호를 잠그므로, 이 두 줄이 비어 있으면
# healthy한 스택에 쓸 수 있는 자격증명이 하나도 없다. 첫 부팅의 migrate 서비스가
# 이 값으로 로그인을 만든다(멱등 — 이후 재부팅은 아무것도 덮어쓰지 않는다).
MOMO_INITIAL_OWNER_EMAIL=$OWNER_EMAIL
MOMO_INITIAL_OWNER_PASSWORD=$OWNER_PASSWORD
EOF
chmod 600 "$ENV_FILE"

reject_duplicate_env_keys
if [ "$MODE" = "published-digest" ]; then
  verify_published_compose_image "$IMAGE"
fi

printf '[self-host] %s 를 만들었다 (권한 600).\n' "$ENV_FILE"
[ "$REQUESTED_WEB_PORT" = "$WEB_PORT" ] ||
  printf '[self-host] 포트 %s 가 사용 중이라 MOMO_WEB_PORT=%s 로 잡았다.\n' "$REQUESTED_WEB_PORT" "$WEB_PORT"
[ "$REQUESTED_API_PORT" = "$API_PORT" ] ||
  printf '[self-host] 포트 %s 가 사용 중이라 MOMO_RUST_API_PORT=%s 로 잡았다.\n' "$REQUESTED_API_PORT" "$API_PORT"
[ "$REQUESTED_CENT_PORT" = "$CENT_PORT" ] ||
  printf '[self-host] 포트 %s 가 사용 중이라 CENT_HOST_PORT=%s 로 잡았다.\n' "$REQUESTED_CENT_PORT" "$CENT_PORT"
print_next_steps "$MODE" "$WEB_PORT" "$OWNER_EMAIL"
