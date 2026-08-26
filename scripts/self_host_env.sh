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
# 같은 이유로 `PLATFORM_ADMIN_EMAILS`도 그 오너 주소로 채운다(#1534). 그 줄이
# 없으면 인스턴스-전역 표면(설정 › AI 연결 · 워크스페이스 생성)은 **아무에게도**
# 열리지 않고 — 셀프호스트 스택은 대안인 `platform:read` 토큰을 발급할 수 없다 —
# 그 상태에서 사람이 겪는 일은 「에이전트를 만들었는데 영영 대답이 없다」이다
# (#1526 실측 F1). MOMO-583 정책은 그대로이고, 바뀌는 것은 **이 인스턴스의 첫
# owner는 이 인스턴스의 운영자**라는 선언이 셀프호스트 경로에 존재하느냐뿐이다.
#
# `MOMO_CORS_ALLOWED_ORIGINS`도 같은 이유다(#1607). compose 기본값은 빈 값
# (CORS 레이어 비장착 = same-origin 웹 전용)이고, 패키징된 Tauri 릴리스는
# webview origin 이 `tauri://localhost`(Windows/Android 는 `http://tauri.localhost`)
# 이라 `/v1` 이 진짜 교차 오리진이다. 셀프호스트 생성 env 만 그 2종을 기본
# 포함한다. `infra/rust/docker-compose.rust.yml` 의 빈 기본값과
# `caddy.override.yml` 운영 경로는 이 파일을 읽지 않으므로 운영 형상에
# 파급이 없다. Centrifugo WSS origin 은 별개 노브(공백 구분)라, 새 env 의
# `CENTRIFUGO_ALLOWED_ORIGINS`에도 같은 2종을 넣는다 — REST 만 열고 WSS 를
# 안 열면 로그인은 되고 실시간이 403이다.
#
# `MOMO_DRIVE_ARCHIVE_BACKEND=local` 도 같다(#1696 / ADR-0169). compose 기본값은
# 빈 값(첨부 라우트 503 no-archive)이고, 셀프호스트 생성 env 만 로컬 볼륨을
# 켠다. stub 은 MOMO_ENV=staging 에서 부팅 거부라 쓰지 않는다. 운영 google
# 경로는 이 파일을 읽지 않는다.
#
# ## 규율
#
# * 이미 파일이 있으면 **시크릿을 다시 만들지 않는다.** 볼륨이 살아 있는 상태에서
#   시크릿을 다시 만들면 DB 안의 롤 비밀번호와 env가 어긋나 스택이 부팅하지 못한다.
#   `--public-origin` 유지보수는 시크릿을 건드리지 않는다. claim 모드
#   (`MOMO_BOOTSTRAP_CLAIM=1`, 비밀번호 키 없음)에서도 그 경로만 통과한다(#1790).
#   `--compose`는 비밀번호 키를 계속 요구한다(ADR-0166).
# * 값은 openssl로 만들고, 파일은 0600으로 쓴다. `*.secrets.env` 는 레포 전역
#   gitignore 대상이다.
# * 포트가 이미 쓰이고 있으면 **비어 있는 다음 포트를 골라** 알려 준다. 사람이
#   충돌을 진단하고 파일을 고치는 왕복이 이 스크립트가 없애려는 바로 그것이다.
#
# 환경변수로 바꿀 수 있는 것(전부 선택):
#   COMPOSE_PROJECT_NAME        기본 oort. 체크아웃이 달라도 이 값이 같으면
#                               같은 compose 프로젝트다 (#1613). --compose up/down
#                               은 산 타 체크아웃(working_dir 라벨이 다른 스택)을
#                               거절한다. 인스턴스를 분리하려면 이 값과
#                               DB_VOLUME_NAME 을 함께 바꾼다.
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
#
# #1613 — pgdata 볼륨 정체성은 프로젝트 스코프다(`DB_VOLUME_NAME=$PROJECT-pgdata`).
# 기본 프로젝트명 `oort` 를 유지하는 것은 기존 `oort-pgdata` 를 무언 대체하지
# 않기 위해서다. 고정 전역 이름+무조건 선점은 채택하지 않는다: 프로젝트명을
# 분리해도 볼륨 문자열이 같으면 PostgreSQL이 같은 datadir로 이중 기동된다.
# 산 타 체크아웃은 `com.docker.compose.project.working_dir` 대조로 fail-closed.
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
PUBLIC_ORIGINS=()
# bash 3.2 + set -u treats an empty array as unbound (`${arr[@]}` / `${#arr[@]}`).
# Count is the only length we read without expanding the array.
PUBLIC_ORIGIN_COUNT=0

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

# #1607 — packaged Tauri webview origins. REST CORS is comma-separated
# (`CorsConfig`); Centrifugo v6 env is space-separated. These cannot be
# derived from APP_DOMAIN. compose 기본값과 운영 overlay 는 이 상수를
# 읽지 않는다.
SELF_HOST_DESKTOP_CORS_ORIGINS="tauri://localhost,http://tauri.localhost"
SELF_HOST_DESKTOP_CENTRIFUGO_ORIGINS="tauri://localhost http://tauri.localhost"
SELF_HOST_DRIVE_LOCAL_DIR="/var/lib/oort/drive"

fail() { printf '[self-host] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  scripts/self_host_env.sh --local-build
  scripts/self_host_env.sh --published-image ghcr.io/yeomyeonggeori/oort@sha256:<64 lowercase hex>
  scripts/self_host_env.sh --public-origin https://<host>
  scripts/self_host_env.sh --compose <docker-compose arguments...>

No argument is a backwards-compatible alias for --local-build.
--public-origin may be repeated. It idempotently adds the origin (and its
ws/wss twin, for React Native) to CENTRIFUGO_ALLOWED_ORIGINS and rewrites
MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL; existing Centrifugo tokens are preserved.
On an existing env it does not regenerate secrets. Claim-mode env
(MOMO_BOOTSTRAP_CLAIM=1, no owner password) may use this maintenance path;
--compose still requires the password key (ADR-0166).
After preparation, use --compose for every start/stop/log command so ambient
Compose variables cannot override infra/rust/local.secrets.env. Use the
playbook's docker compose helper in claim mode instead of --compose.
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
    --public-origin)
      [ "$#" -ge 2 ] || fail "--public-origin 뒤에 http(s)://host 가 필요하다."
      PUBLIC_ORIGINS+=("$2")
      PUBLIC_ORIGIN_COUNT=$((PUBLIC_ORIGIN_COUNT + 1))
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

# ADR-0166 claim bootstrap: the playbook strips MOMO_INITIAL_OWNER_PASSWORD
# and writes MOMO_BOOTSTRAP_CLAIM=1. That absence is the contract, not a
# malformed env. Other values (created/skipped) are migrate stdout, not this file.
is_claim_bootstrap_env() {
  [ "$(env_key_count MOMO_BOOTSTRAP_CLAIM)" -eq 1 ] || return 1
  [ "$(env_value_once MOMO_BOOTSTRAP_CLAIM)" = "1" ]
}

stack_restart_hint() {
  # 두 갈래 모두 %s 로 낸다. 비-claim 문자열은 `--` 로 시작하는데, bash printf 는
  # 그것을 자기 옵션으로 읽어 `invalid option` 으로 죽는다(#1790 회귀).
  if is_claim_bootstrap_env; then
    printf '%s' 'docs/SELF_HOST_AGENT.md §1.4의 docker compose 직접 호출'
  else
    printf '%s' '--compose up -d'
  fi
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

# #1534 — the operator allow-list, for env files written before it existed.
#
# The "never rewrite an existing file" rule guards *secrets*: regenerating one
# desynchronises it from the role password already inside a migrated database.
# This key is not a secret and is not generated — it is a copy of an address the
# file already carries, so appending it can desynchronise nothing. Refusing to
# touch the file here would mean the fix reaches only brand-new installs, while
# every instance that followed the document before today keeps a permanently 403
# AI-연결 surface and no line in any document telling them which key to add.
#
# Only ever ADDS, and only when the key is absent: a value somebody typed on
# purpose (including a deliberately empty one) is left exactly as it is.
ensure_operator_allowlist() {
  local owner_email="$1" count
  count="$(env_key_count PLATFORM_ADMIN_EMAILS)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 PLATFORM_ADMIN_EMAILS 항목은 최대 한 번만 있어야 한다."
  [ "$count" -eq 0 ] || return 0
  validate_owner_email "$owner_email"
  {
    printf '\n# --- 인스턴스 운영자 (#1534, 기존 env에 추가) -----------------------------\n'
    printf '# 이 줄이 없으면 설정 › AI 연결과 워크스페이스 생성이 설치한 본인에게도 403이다.\n'
    printf '# 반영에는 api 재시작이 필요하다(프로세스 env). 시크릿은 하나도 바뀌지 않았다.\n'
    printf 'PLATFORM_ADMIN_EMAILS=%s\n' "$owner_email"
  } >>"$ENV_FILE"
  # stderr: this function also runs on the `--compose` path, whose stdout is a
  # machine surface (`config --format json`, `config --images`). A diagnostic
  # that lands in the middle of rendered Compose JSON is worse than no notice.
  printf '[self-host] %s 에 PLATFORM_ADMIN_EMAILS=%s 를 추가했다 (시크릿은 그대로).\n' \
    "$ENV_FILE" "$owner_email" >&2
  printf '[self-host] 이미 떠 있는 스택이라면 api를 재시작해야 반영된다: %s\n' \
    "$(stack_restart_hint)" >&2
}

# #1607 — desktop CORS allowlist, for env files written before it existed.
#
# Same add-only rule as `ensure_operator_allowlist`: this key is not a secret.
# A value somebody typed (including a deliberately empty one, which is the
# only way to keep CORS unmounted on this instance) is left exactly as it is.
# Existing `CENTRIFUGO_ALLOWED_ORIGINS` is never rewritten — REST and WSS are
# different knobs, and overwriting a space-separated list the operator already
# has would violate the env-file contract. A missing tauri origin is a
# diagnostic on stderr, not a mutation.
ensure_desktop_cors_allowlist() {
  local count
  count="$(env_key_count MOMO_CORS_ALLOWED_ORIGINS)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_CORS_ALLOWED_ORIGINS 항목은 최대 한 번만 있어야 한다."
  [ "$count" -eq 0 ] || return 0
  validate_env_scalar MOMO_CORS_ALLOWED_ORIGINS "$SELF_HOST_DESKTOP_CORS_ORIGINS"
  {
    printf '\n# --- 데스크탑 CORS (#1607, 기존 env에 추가) --------------------------------\n'
    printf '# 패키징된 Tauri 릴리스는 tauri://localhost 에서 /v1 을 부르므로 교차 오리진이다.\n'
    printf '# 반영에는 api 재시작이 필요하다(프로세스 env). 시크릿은 하나도 바뀌지 않았다.\n'
    printf 'MOMO_CORS_ALLOWED_ORIGINS=%s\n' "$SELF_HOST_DESKTOP_CORS_ORIGINS"
  } >>"$ENV_FILE"
  printf '[self-host] %s 에 MOMO_CORS_ALLOWED_ORIGINS=%s 를 추가했다 (시크릿은 그대로).\n' \
    "$ENV_FILE" "$SELF_HOST_DESKTOP_CORS_ORIGINS" >&2
  printf '[self-host] 이미 떠 있는 스택이라면 api를 재시작해야 반영된다: %s\n' \
    "$(stack_restart_hint)" >&2
}

# #1696 / ADR-0169 — local file archive, for env files written before it existed.
#
# Same add-only rule as `ensure_operator_allowlist`: these keys are not secrets.
# A value somebody typed (including a deliberately empty backend, which keeps
# the 503 no-archive surface) is left exactly as it is.
ensure_local_drive_archive() {
  local project count
  project="$(self_host_compose_project_name)"
  validate_project_name "$project"
  validate_env_scalar MOMO_DRIVE_LOCAL_DIR "$SELF_HOST_DRIVE_LOCAL_DIR"
  validate_env_scalar MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL "same-origin"
  validate_env_scalar DRIVE_VOLUME_NAME "${project}-drive"

  count="$(env_key_count MOMO_DRIVE_ARCHIVE_BACKEND)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_DRIVE_ARCHIVE_BACKEND 항목은 최대 한 번만 있어야 한다."
  if [ "$count" -eq 0 ]; then
    {
      printf '\n# --- 첨부 보관소 (#1696, 기존 env에 추가) -------------------------------\n'
      printf '# 셀프호스트 기본은 로컬 볼륨. Google SA 없이 첨부가 켜진다.\n'
      printf '# 반영에는 api 재시작이 필요하다(프로세스 env). 시크릿은 하나도 바뀌지 않았다.\n'
      printf 'MOMO_DRIVE_ARCHIVE_BACKEND=local\n'
    } >>"$ENV_FILE"
    printf '[self-host] %s 에 MOMO_DRIVE_ARCHIVE_BACKEND=local 를 추가했다 (시크릿은 그대로).\n' \
      "$ENV_FILE" >&2
  fi

  count="$(env_key_count MOMO_DRIVE_LOCAL_DIR)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_DRIVE_LOCAL_DIR 항목은 최대 한 번만 있어야 한다."
  if [ "$count" -eq 0 ]; then
    printf 'MOMO_DRIVE_LOCAL_DIR=%s\n' "$SELF_HOST_DRIVE_LOCAL_DIR" >>"$ENV_FILE"
    printf '[self-host] %s 에 MOMO_DRIVE_LOCAL_DIR=%s 를 추가했다 (시크릿은 그대로).\n' \
      "$ENV_FILE" "$SELF_HOST_DRIVE_LOCAL_DIR" >&2
  fi

  count="$(env_key_count MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL 항목은 최대 한 번만 있어야 한다."
  if [ "$count" -eq 0 ]; then
    printf 'MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin\n' >>"$ENV_FILE"
    printf '[self-host] %s 에 MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin 를 추가했다 (시크릿은 그대로).\n' \
      "$ENV_FILE" >&2
  fi

  count="$(env_key_count DRIVE_VOLUME_NAME)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 DRIVE_VOLUME_NAME 항목은 최대 한 번만 있어야 한다."
  if [ "$count" -eq 0 ]; then
    printf 'DRIVE_VOLUME_NAME=%s-drive\n' "$project" >>"$ENV_FILE"
    printf '[self-host] %s 에 DRIVE_VOLUME_NAME=%s-drive 를 추가했다 (시크릿은 그대로).\n' \
      "$ENV_FILE" "$project" >&2
  fi
}

ensure_local_drive_public_base() {
  [ "$PUBLIC_ORIGIN_COUNT" -gt 0 ] || return 0
  local origin="${PUBLIC_ORIGINS[0]}"
  local count
  count="$(env_key_count MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL 항목은 최대 한 번만 있어야 한다."
  # #1788 — same-origin 은 이미 모든 오리진을 덮는다. 공개 오리진 절대 URL로
  # 내리면 터널 URL이 바뀔 때 다시 낡는다(ADR-0169 증보 1이 없애려던 바로 그
  # 상태). 그러므로 센티널은 강등하지 않는다. 절대 URL로 고정하고 싶은 운영자는
  # 그 값을 직접 적으면 되고, 그때는 verbatim으로 유지된다.
  if [ "$count" -eq 1 ]; then
    case "$(printf '%s' "$(env_value_once MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL)" | tr '[:upper:]' '[:lower:]')" in
      same-origin)
        printf '[self-host] MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL 은 same-origin 이라 그대로 둔다 (요청 오리진에서 파생 — 공개 오리진도 덮는다).\n' >&2
        return 0
        ;;
    esac
  fi
  rewrite_env_assignment MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL "$origin"
  printf '[self-host] %s 의 MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL 을 공개 오리진으로 맞췄다.\n' \
    "$ENV_FILE" >&2
}

normalize_public_origin() {
  local raw="$1"
  validate_env_scalar MOMO_PUBLIC_ORIGIN "$raw"
  case "$raw" in
    */) raw="${raw%/}" ;;
  esac
  case "$raw" in
    https://*|http://*) ;;
    *) fail "--public-origin 은 http:// 또는 https:// 오리진이어야 한다 (경로·쿼리 불가)." ;;
  esac
  [[ "$raw" =~ ^https://[A-Za-z0-9._-]+(:[1-9][0-9]{0,4})?$ ]] ||
    [[ "$raw" =~ ^http://[A-Za-z0-9._-]+(:[1-9][0-9]{0,4})?$ ]] ||
    fail "--public-origin 은 http(s)://host[:port] 형식이어야 한다."
  if [[ "$raw" =~ :([0-9]+)$ ]]; then
    [ "${BASH_REMATCH[1]}" -le 65535 ] ||
      fail "--public-origin 포트는 1..65535 이어야 한다."
  fi
  printf '%s' "$raw"
}

public_origin_websocket() {
  local origin="$1"
  case "$origin" in
    https://*) printf 'wss://%s' "${origin#https://}" ;;
    http://*) printf 'ws://%s' "${origin#http://}" ;;
    *) fail "--public-origin 내부 오류: 스킴 화이트리스트를 통과한 값이 아니다." ;;
  esac
}

list_has_token() {
  local list="$1" want="$2" item
  for item in $list; do
    [ "$item" = "$want" ] && return 0
  done
  return 1
}

append_space_token() {
  local list="$1" token="$2"
  if [ -z "$list" ]; then
    printf '%s' "$token"
    return
  fi
  if list_has_token "$list" "$token"; then
    printf '%s' "$list"
    return
  fi
  printf '%s %s' "$list" "$token"
}

rewrite_env_assignment() {
  local key="$1" value="$2" tmp
  validate_env_scalar "$key" "$value"
  tmp="$(mktemp "${TMPDIR:-/tmp}/oort-self-host-env.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    index($0, key "=") == 1 && done == 0 {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (done == 0) print key "=" value
    }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

normalize_requested_public_origins() {
  local i=0
  [ "$PUBLIC_ORIGIN_COUNT" -gt 0 ] || return 0
  while [ "$i" -lt "$PUBLIC_ORIGIN_COUNT" ]; do
    PUBLIC_ORIGINS[$i]="$(normalize_public_origin "${PUBLIC_ORIGINS[$i]}")"
    i=$((i + 1))
  done
}

centrifugo_origins_with_public() {
  local current="$1" origin ws_origin i=0
  [ "$PUBLIC_ORIGIN_COUNT" -gt 0 ] || {
    printf '%s' "$current"
    return 0
  }
  while [ "$i" -lt "$PUBLIC_ORIGIN_COUNT" ]; do
    origin="${PUBLIC_ORIGINS[$i]}"
    ws_origin="$(public_origin_websocket "$origin")"
    current="$(append_space_token "$current" "$origin")"
    current="$(append_space_token "$current" "$ws_origin")"
    i=$((i + 1))
  done
  printf '%s' "$current"
}

ensure_public_origins() {
  [ "$PUBLIC_ORIGIN_COUNT" -gt 0 ] || return 0
  local current="" count next
  count="$(env_key_count CENTRIFUGO_ALLOWED_ORIGINS)"
  [ "$count" -le 1 ] ||
    fail "${ENV_FILE}의 CENTRIFUGO_ALLOWED_ORIGINS 항목은 최대 한 번만 있어야 한다."
  if [ "$count" -eq 1 ]; then
    current="$(env_value_once CENTRIFUGO_ALLOWED_ORIGINS)"
  fi
  next="$(centrifugo_origins_with_public "$current")"
  if [ "$next" = "$current" ] && [ "$count" -eq 1 ]; then
    printf '[self-host] CENTRIFUGO_ALLOWED_ORIGINS 에 공개 오리진이 이미 있다 (멱등).\n' >&2
    return 0
  fi
  rewrite_env_assignment CENTRIFUGO_ALLOWED_ORIGINS "$next"
  printf '[self-host] %s 의 CENTRIFUGO_ALLOWED_ORIGINS 에 공개 오리진을 추가했다.\n' \
    "$ENV_FILE" >&2
  printf '[self-host] 브라우저 Origin(https)과 RN 소켓 Origin(wss)을 같이 넣는다. centrifugo 재시작: %s\n' \
    "$(stack_restart_hint)" >&2
}

warn_if_legacy_localhost_drive_base() {
  local count current
  count="$(env_key_count MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL)"
  [ "$count" -eq 1 ] || return 0
  current="$(env_value_once MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL)"
  case "$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]')" in
    same-origin) return 0 ;;
    http://localhost:*|https://localhost:*|http://127.0.0.1:*|https://127.0.0.1:*)
      printf '[self-host] %s 의 MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL 이 루프백을 가리킨다.\n' "$ENV_FILE" >&2
      printf '[self-host] 원격 클라는 자기 localhost 로 첨부를 올린다 (ADR-0169 증보 1). 그 줄을\n' >&2
      printf '[self-host] MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin 으로 고친 뒤 api 를 재시작하라.\n' >&2
      ;;
  esac
}

warn_if_legacy_localhost_realtime_ws() {
  local count current
  count="$(env_key_count MOMO_CENTRIFUGO_WS_URL)"
  [ "$count" -eq 1 ] || return 0
  current="$(env_value_once MOMO_CENTRIFUGO_WS_URL)"
  case "$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]')" in
    same-origin) return 0 ;;
    ws://localhost:*|wss://localhost:*|ws://127.0.0.1:*|wss://127.0.0.1:*)
      printf '[self-host] %s 의 MOMO_CENTRIFUGO_WS_URL 이 루프백을 가리킨다.\n' "$ENV_FILE" >&2
      printf '[self-host] 원격 클라는 자기 localhost 로 WS 를 연다 (ADR-0167). 그 줄을\n' >&2
      printf '[self-host] MOMO_CENTRIFUGO_WS_URL=same-origin 으로 고친 뒤 api 를 재시작하라.\n' >&2
      ;;
  esac
}

warn_if_centrifugo_missing_desktop_origins() {
  local count current missing=0
  count="$(env_key_count CENTRIFUGO_ALLOWED_ORIGINS)"
  [ "$count" -eq 1 ] || return 0
  current="$(env_value_once CENTRIFUGO_ALLOWED_ORIGINS)"
  case "$current" in
    *tauri://localhost*) ;;
    *) missing=1 ;;
  esac
  case "$current" in
    *http://tauri.localhost*) ;;
    *) missing=1 ;;
  esac
  [ "$missing" -eq 0 ] && return 0
  printf '[self-host] %s 의 CENTRIFUGO_ALLOWED_ORIGINS 에 tauri://localhost 또는 http://tauri.localhost 가 없다.\n' \
    "$ENV_FILE" >&2
  printf '[self-host] 데스크탑 실시간은 업그레이드 전 Origin 대조에서 403이 된다. 시크릿을\n' >&2
  printf '[self-host] 건드리지 말고 그 줄 끝에 " tauri://localhost http://tauri.localhost" 를\n' >&2
  printf '[self-host] 추가한 뒤 centrifugo를 재시작하라: %s\n' \
    "$(stack_restart_hint)" >&2
}

# Historical self-host volume name (#1613). Existing installs used the generator
# default COMPOSE_PROJECT_NAME=oort → DB_VOLUME_NAME=oort-pgdata. Tests may
# retarget this at a throwaway volume; production stays oort-pgdata. Never
# delete or rename that volume from this script.
SELF_HOST_LEGACY_PGDATA_VOLUME="${SELF_HOST_LEGACY_PGDATA_VOLUME:-oort-pgdata}"

self_host_canonical_dir() {
  local path="$1"
  [ -n "$path" ] || return 1
  CDPATH='' cd -P -- "$path" 2>/dev/null && pwd
}

self_host_same_workdir() {
  local left="$1" right="$2" cleft cright
  [ -n "$left" ] && [ -n "$right" ] || return 1
  left="${left%/}"
  right="${right%/}"
  [ "$left" = "$right" ] && return 0
  cleft="$(self_host_canonical_dir "$left")" || return 1
  cright="$(self_host_canonical_dir "$right")" || return 1
  [ "$cleft" = "$cright" ]
}

self_host_compose_project_name() {
  if [ "$(env_key_count COMPOSE_PROJECT_NAME)" -eq 1 ]; then
    env_value_once COMPOSE_PROJECT_NAME
  else
    # Matches infra/rust/docker-compose.rust.yml `name:` fallback.
    printf '%s' 'momo-rust'
  fi
}

self_host_db_volume_name() {
  local project
  if [ "$(env_key_count DB_VOLUME_NAME)" -eq 1 ]; then
    env_value_once DB_VOLUME_NAME
    return 0
  fi
  project="$(self_host_compose_project_name)"
  printf '%s-pgdata' "$project"
}

self_host_volume_exists() {
  local name="$1" rendered
  [ -n "$name" ] || return 1
  rendered="$("$DOCKER_BIN" volume inspect "$name" --format '{{.Name}}' 2>/dev/null || true)"
  [ "$rendered" = "$name" ]
}

self_host_stack_guard_applies() {
  case "${1:-}" in
    up|create|start|run|down|restart|kill|stop|rm|pause|unpause|watch)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

warn_legacy_pgdata_identity() {
  local intended="$1"
  local legacy="$SELF_HOST_LEGACY_PGDATA_VOLUME"
  self_host_volume_exists "$legacy" || return 0
  if [ "$intended" = "$legacy" ]; then
    printf '[self-host] 기존 볼륨 %s 를 이 프로젝트의 데이터로 채택한다. 삭제·복사하지 않는다 (#1613).\n' \
      "$legacy"
    return 0
  fi
  printf '[self-host] 이 머신에 기존 셀프호스트 볼륨 %s 가 있다. 새 env 의 DB_VOLUME_NAME 은 %s 다.\n' \
    "$legacy" "$intended"
  printf '[self-host] 데이터가 사라진 것이 아니다. 이어받으려면 이 파일을 지우고 COMPOSE_PROJECT_NAME=oort 로\n'
  printf '[self-host] 다시 만들거나, DB_VOLUME_NAME=%s 로 고친다. 프로젝트명만 바꾸고 볼륨을 공유한 채\n' \
    "$legacy"
  printf '[self-host] up 하면 PostgreSQL이 같은 데이터 디렉토리로 이중 기동된다 (#1613).\n'
}

guard_self_host_stack_collision() {
  local our_project our_volume our_wd id their_wd their_project
  local ids_project ids_volume
  local collisions=0
  local -a reports=()

  our_project="$(self_host_compose_project_name)"
  validate_project_name "$our_project"
  our_volume="$(self_host_db_volume_name)"
  validate_env_scalar DB_VOLUME_NAME "$our_volume"
  our_wd="$(self_host_canonical_dir "$REPO_ROOT")" ||
    fail "이 체크아웃 경로를 정규화할 수 없다: $REPO_ROOT"

  if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
    fail "docker daemon에 연결할 수 없다 — 스택 충돌 여부를 확인할 수 없어 중단한다."
  fi

  ids_project="$("$DOCKER_BIN" ps -aq --filter "label=com.docker.compose.project=${our_project}")" ||
    fail "docker ps 실패 — 스택 충돌 여부를 확인할 수 없어 중단한다."
  ids_volume=""
  if [ -n "$our_volume" ]; then
    ids_volume="$("$DOCKER_BIN" ps -aq --filter "volume=${our_volume}")" ||
      fail "docker ps 실패 — 스택 충돌 여부를 확인할 수 없어 중단한다."
  fi

  while IFS= read -r id; do
    [ -n "$id" ] || continue
    their_wd="$("$DOCKER_BIN" inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$id")" ||
      fail "컨테이너 $id 를 inspect할 수 없다 — 스택 충돌 여부를 확인할 수 없어 중단한다."
    their_project="$("$DOCKER_BIN" inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")" ||
      fail "컨테이너 $id 를 inspect할 수 없다 — 스택 충돌 여부를 확인할 수 없어 중단한다."
    if self_host_same_workdir "$their_wd" "$our_wd" && [ "$their_project" = "$our_project" ]; then
      continue
    fi
    collisions=$((collisions + 1))
    reports+=("$id project=${their_project:-?} dir=${their_wd:-?}")
  done < <(printf '%s\n%s\n' "$ids_project" "$ids_volume" | awk 'NF && !seen[$0]++')

  [ "$collisions" -eq 0 ] && return 0

  printf '[self-host] 다른 체크아웃의 살아있는 스택이 같은 compose 프로젝트 또는 pgdata 볼륨을 쓰고 있다.\n' >&2
  printf '[self-host] 이 체크아웃:  project=%s  volume=%s  dir=%s\n' \
    "$our_project" "$our_volume" "$our_wd" >&2
  local report
  for report in "${reports[@]}"; do
    printf '[self-host] 충돌: %s\n' "$report" >&2
  done
  printf '[self-host] 무경고로 재생성하면 그 스택이 이 체크아웃의 이미지/env로 바뀌고,\n' >&2
  printf '[self-host] 같은 PostgreSQL 데이터 디렉토리가 이중 기동될 수 있다 (#1613).\n' >&2
  printf '[self-host] 해법:\n' >&2
  printf '[self-host]   1) 그 체크아웃에서 내린다: 그 트리에서 scripts/self_host_env.sh --compose down\n' >&2
  printf '[self-host]   2) 이 클론을 독립 인스턴스로 쓰려면 COMPOSE_PROJECT_NAME 과 DB_VOLUME_NAME 을\n' >&2
  printf '[self-host]      함께 바꾼다. 프로젝트명만 바꾸면 볼륨 %s 를 계속 공유한다.\n' \
    "$our_volume" >&2
  printf '[self-host]   3) 기존 %s 데이터를 이 체크아웃이 이어받으려면 그 이름을 유지한 채\n' \
    "$SELF_HOST_LEGACY_PGDATA_VOLUME" >&2
  printf '[self-host]      먼저 다른 체크아웃을 down 한다. 볼륨을 삭제·복사하지 않는다.\n' >&2
  exit 1
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
  if self_host_stack_guard_applies "${1:-}"; then
    guard_self_host_stack_collision
  fi
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

normalize_requested_public_origins

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
  if is_claim_bootstrap_env; then
    cat <<EOF

[self-host] 준비됐다. 모드: $mode_summary
[self-host] 이 env는 claim 모드다. --compose는 비밀번호 키를 요구하므로 거절한다.
[self-host] 스택 기동은 docs/SELF_HOST_AGENT.md §1.4의 docker compose 직접 호출을 쓴다.
[self-host] 주의: 이 quickstart는 로컬 named volume만 사용하며 production 백업/PITR가 아니다.
[self-host] 운영 업그레이드는 pgBackRest 오버레이+서명된 fresh evidence gate를 따라야 한다.
[self-host] 브라우저에서 열고 migrate가 출력한 /claim/<token> 으로 첫 비밀번호를 설정한다:

  http://localhost:${web_port}
  email    ${owner_email}

[self-host] 비밀번호 키는 이 파일에 없다. 원문 토큰을 stdout·이슈에 다시 적지 않는다.
[self-host] 이 계정이 이 인스턴스의 운영자다(PLATFORM_ADMIN_EMAILS) — 설정 › AI 연결에서
[self-host] 프로바이더 키를 넣을 수 있다. 절차: docs/SELF_HOST.md §5.
[self-host] 패키징된 데스크탑 릴리스(tauri://localhost)는 같은 스택에 교차 오리진으로
[self-host] 붙는다. 새 env 는 MOMO_CORS_ALLOWED_ORIGINS 와 CENTRIFUGO_ALLOWED_ORIGINS 에
[self-host] tauri origin 2종을 기본으로 넣는다(#1607). 브라우저 경로는 같은 오리진이라
[self-host] CORS가 필요 없다.
EOF
    return
  fi
  cat <<EOF

[self-host] 준비됐다. 모드: $mode_summary
[self-host] 다음 한 줄이 스택을 띄운다:

  scripts/self_host_env.sh --compose $up_args

[self-host] --wait 가 붙어 있으므로 그 명령이 끝나면 준비가 끝난 것이다.
[self-host] 주의: 이 quickstart는 로컬 named volume만 사용하며 production 백업/PITR가 아니다.
[self-host] 운영 업그레이드는 pgBackRest 오버레이+서명된 fresh evidence gate를 따라야 한다.
[self-host] 브라우저에서 열고 아래로 로그인한다:

  http://localhost:${web_port}
  email    ${owner_email}
  password $ENV_FILE 의 MOMO_INITIAL_OWNER_PASSWORD 값

[self-host] 비밀번호는 stdout에 쓰지 않는다. $ENV_FILE 에서 직접 확인하라(파일 권한 600).
[self-host] 이 계정이 이 인스턴스의 운영자다(PLATFORM_ADMIN_EMAILS) — 설정 › AI 연결에서
[self-host] 프로바이더 키를 넣을 수 있다. 절차: docs/SELF_HOST.md §5.
[self-host] 패키징된 데스크탑 릴리스(tauri://localhost)는 같은 스택에 교차 오리진으로
[self-host] 붙는다. 새 env 는 MOMO_CORS_ALLOWED_ORIGINS 와 CENTRIFUGO_ALLOWED_ORIGINS 에
[self-host] tauri origin 2종을 기본으로 넣는다(#1607). 브라우저 경로는 같은 오리진이라
[self-host] CORS가 필요 없다.
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
  password_count="$(env_key_count MOMO_INITIAL_OWNER_PASSWORD)"
  [ "$password_count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_INITIAL_OWNER_PASSWORD 항목은 최대 한 번만 있어야 한다."
  claim_count="$(env_key_count MOMO_BOOTSTRAP_CLAIM)"
  [ "$claim_count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_BOOTSTRAP_CLAIM 항목은 최대 한 번만 있어야 한다."
  if [ "$password_count" -eq 1 ]; then
    validate_owner_password "$(env_value_once MOMO_INITIAL_OWNER_PASSWORD)"
  elif is_claim_bootstrap_env; then
    # #1790 — password absence is normal in claim mode. Origin refresh and
    # other existing-env maintenance may proceed. --compose stays closed
    # (ADR-0166: the launcher still requires the password key).
    if [ "$REQUESTED_ACTION" = "compose" ]; then
      fail "${ENV_FILE}은 claim 모드다. --compose는 비밀번호 키를 요구한다(ADR-0166). 스택 기동은 docs/SELF_HOST_AGENT.md §1.4의 docker compose 직접 호출을 쓴다."
    fi
  else
    fail "${ENV_FILE}의 MOMO_INITIAL_OWNER_PASSWORD 항목은 정확히 한 번 있어야 한다."
  fi
  mode_count="$(env_key_count MOMO_SELF_HOST_MODE)"
  [ "$mode_count" -le 1 ] ||
    fail "${ENV_FILE}의 MOMO_SELF_HOST_MODE 항목은 최대 한 번만 있어야 한다."
  existing_mode=""
  if [ "$mode_count" -eq 1 ]; then
    existing_mode="$(env_value_once MOMO_SELF_HOST_MODE)"
  fi
  validate_env_scalar MOMO_RUST_IMAGE "$existing_image"
  validate_owner_email "$existing_email"
  existing_web_port="$(normalize_port MOMO_WEB_PORT "$existing_web_port")"
  ensure_operator_allowlist "$existing_email"
  ensure_desktop_cors_allowlist
  ensure_local_drive_archive
  warn_if_centrifugo_missing_desktop_origins
  ensure_public_origins
  ensure_local_drive_public_base
  warn_if_legacy_localhost_realtime_ws
  warn_if_legacy_localhost_drive_base

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
  if [ "$PUBLIC_ORIGIN_COUNT" -gt 0 ]; then
    printf '[self-host] %s 시크릿은 그대로 두고 공개 오리진만 반영했다.\n' "$ENV_FILE"
  else
    printf '[self-host] %s 는 이미 있다 — 그대로 둔다.\n' "$ENV_FILE"
  fi
  printf '[self-host] 시크릿을 다시 만들면 이미 마이그레이션된 DB의 롤 비밀번호와 어긋난다.\n'
  printf '[self-host] 정말 처음부터 다시 하려면: 스택을 down -v 로 내리고 이 파일을 지운 뒤 다시 실행.\n'
  print_next_steps "$existing_mode" "$existing_web_port" "${existing_email:-?}"
  exit 0
fi

[ "$REQUESTED_ACTION" = "prepare" ] || fail "$ENV_FILE 없음 — 먼저 이미지 모드를 선택해 env를 생성하라."
if [ -z "$REQUESTED_MODE" ] && [ "$PUBLIC_ORIGIN_COUNT" -gt 0 ]; then
  fail "$ENV_FILE 없음 — 먼저 --local-build 또는 --published-image 로 env를 생성하라."
fi

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

CENTRIFUGO_ORIGINS="http://localhost:$WEB_PORT http://127.0.0.1:$WEB_PORT $SELF_HOST_DESKTOP_CENTRIFUGO_ORIGINS"
CENTRIFUGO_ORIGINS="$(centrifugo_origins_with_public "$CENTRIFUGO_ORIGINS")"
DRIVE_LOCAL_DIR="$SELF_HOST_DRIVE_LOCAL_DIR"
DRIVE_VOLUME="${PROJECT}-drive"
DRIVE_LOCAL_BASE="same-origin"
if [ "$PUBLIC_ORIGIN_COUNT" -gt 0 ]; then
  DRIVE_LOCAL_BASE="${PUBLIC_ORIGINS[0]}"
fi

# Keep every interpolation used by the env-file sink on the same scalar guard.
for key in MODE IMAGE PG_PASSWORD APP_PASSWORD RELAY_PASSWORD WORKER_PASSWORD \
           JWT_SECRET CENT_TOKEN_SECRET CENT_API_SECRET CENT_PROXY_SECRET_VALUE \
           PROVIDER_LINK_SECRET WEB_PORT API_PORT CENT_PORT OWNER_EMAIL \
           SELF_HOST_DESKTOP_CORS_ORIGINS SELF_HOST_DESKTOP_CENTRIFUGO_ORIGINS \
           CENTRIFUGO_ORIGINS DRIVE_LOCAL_DIR DRIVE_VOLUME DRIVE_LOCAL_BASE; do
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
# 이 생성기는 로컬 quickstart이다. API는 staging 시크릿 가드를 유지하지만,
# migrate는 production PITR 증거를 가지고 있다고 거짓말하지 않고 development warning 모드다.
MOMO_MIGRATE_ENV=development
MOMO_PITR_EVIDENCE_REQUIRED=0
MOMO_PITR_BOOTSTRAP_EMPTY=0
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
# 브라우저 경로에서는 CORS가 성립할 여지가 없다(infra/rust/local.override.yml).
# 패키징된 Tauri 릴리스는 예외다: webview origin 이 tauri://localhost
# (Windows/Android 는 http://tauri.localhost) 이라 /v1 이 진짜 교차 오리진이다.
MOMO_WEB_PORT=$WEB_PORT
# 로그인 응답이 클라이언트에게 돌려주는 레일 주소(ADR-0110 유일 권위).
# ADR-0167: same-origin — 로그인 요청 Host/X-Forwarded-Proto에서 WS URL을 파생한다.
MOMO_CENTRIFUGO_WS_URL=same-origin
# Centrifugo는 업그레이드 전에 Origin을 대조한다. **공백 구분** 목록이고,
# localhost 로 열든 127.0.0.1 로 열든 통하도록 둘 다 적는다. tauri 2종은
# REST CORS 와 별개 노브(#1607) — 빠지면 로그인은 되고 실시간이 403이다.
CENTRIFUGO_ALLOWED_ORIGINS=$CENTRIFUGO_ORIGINS
# 엣지를 거치지 않는 직접 접속(curl·디버깅)용 루프백 포트.
MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT

# --- 데스크탑 CORS (#1607) ---------------------------------------------------
# 택일: 셀프호스트 생성 env 는 tauri origin 2종을 기본 포함한다.
# 보안: exact-match, 와일드카드 거부, credentials 미전송, 루프백 바인딩
# (local.override.yml 은 127.0.0.1). compose 기본값은 빈 값
# (MOMO_CORS_ALLOWED_ORIGINS 미설정)이고, caddy.override.yml 운영 경로는
# 이 파일을 읽지 않으므로 운영 형상에 파급이 없다. 빈 값으로 바꿔 끄면
# 이후 실행이 그대로 둔다.
MOMO_CORS_ALLOWED_ORIGINS=$SELF_HOST_DESKTOP_CORS_ORIGINS

# --- 마이그레이션 -----------------------------------------------------------
MOMO_AGENT_SEED_MODE=none
MIGRATE_IDEMPOTENCY_CHECK=1

# --- 첫 로그인 (#1227) ------------------------------------------------------
# 마이그레이션 012가 시드 오너의 공개 비밀번호를 잠그므로, 이 두 줄이 비어 있으면
# healthy한 스택에 쓸 수 있는 자격증명이 하나도 없다. 첫 부팅의 migrate 서비스가
# 이 값으로 로그인을 만든다(멱등 — 이후 재부팅은 아무것도 덮어쓰지 않는다).
MOMO_INITIAL_OWNER_EMAIL=$OWNER_EMAIL
MOMO_INITIAL_OWNER_PASSWORD=$OWNER_PASSWORD

# --- 인스턴스 운영자 (#1534) ------------------------------------------------
# 이 한 줄이 「이 인스턴스의 첫 owner는 이 인스턴스의 운영자다」라는 선언이다.
# MOMO-583 정책은 그대로다: 인스턴스-전역 표면(설정 › AI 연결 · 워크스페이스 생성)은
# platform:read 토큰 **또는** 여기 등재된 검증 이메일의 owner/admin에게만 열린다.
# 그런데 셀프호스트 스택은 platform:read 토큰을 발급할 방법이 없으므로, 이 줄이
# 비어 있으면 그 표면은 **아무에게도** 열리지 않는다 — 설치한 사람 본인에게도.
# 그 상태의 증상은 「에이전트를 만들었는데 영영 대답하지 않는다」이고, 화면은
# 이유를 말해 주지 않는다(#1526 실측 F1).
#
# 값은 쉼표로 나눠 여러 명을 적을 수 있다. 바꾼 뒤에는 **api를 재시작**해야 한다
# (프로세스 env다). provider 키 자체는 DB 행이라 재시작이 필요 없다.
PLATFORM_ADMIN_EMAILS=$OWNER_EMAIL

# --- 첨부 보관소 (ADR-0169 / #1696) ------------------------------------------
# 셀프호스트 기본은 로컬 볼륨. Google SA 없이 첨부가 켜진다. stub 은
# MOMO_ENV=staging 에서 부팅 거부라 쓰지 않는다. 운영 google 경로는 이
# 파일을 읽지 않는다. 디렉터리는 api 컨테이너 안 경로이고, 호스트 볼륨
# 이름은 DRIVE_VOLUME_NAME 이다. 백업 때 pg_dump 와 이 볼륨을 같이 가져가라.
# same-origin: capability URL을 요청 Host/X-Forwarded-Proto에서 파생한다
# (ADR-0169 증보 1 · 0167 준용). 절대 URL이면 verbatim.
MOMO_DRIVE_ARCHIVE_BACKEND=local
MOMO_DRIVE_LOCAL_DIR=$DRIVE_LOCAL_DIR
MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=$DRIVE_LOCAL_BASE
DRIVE_VOLUME_NAME=$DRIVE_VOLUME
EOF
chmod 600 "$ENV_FILE"

reject_duplicate_env_keys
if [ "$MODE" = "published-digest" ]; then
  verify_published_compose_image "$IMAGE"
fi

printf '[self-host] %s 를 만들었다 (권한 600).\n' "$ENV_FILE"
warn_legacy_pgdata_identity "$PROJECT-pgdata"
[ "$REQUESTED_WEB_PORT" = "$WEB_PORT" ] ||
  printf '[self-host] 포트 %s 가 사용 중이라 MOMO_WEB_PORT=%s 로 잡았다.\n' "$REQUESTED_WEB_PORT" "$WEB_PORT"
[ "$REQUESTED_API_PORT" = "$API_PORT" ] ||
  printf '[self-host] 포트 %s 가 사용 중이라 MOMO_RUST_API_PORT=%s 로 잡았다.\n' "$REQUESTED_API_PORT" "$API_PORT"
[ "$REQUESTED_CENT_PORT" = "$CENT_PORT" ] ||
  printf '[self-host] 포트 %s 가 사용 중이라 CENT_HOST_PORT=%s 로 잡았다.\n' "$REQUESTED_CENT_PORT" "$CENT_PORT"
print_next_steps "$MODE" "$WEB_PORT" "$OWNER_EMAIL"
