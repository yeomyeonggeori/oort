#!/usr/bin/env bash
# Behavioral contract for #1266's mutually exclusive self-host image modes.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-self-host-modes.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

GOOD_DIGEST="ghcr.io/yeomyeonggeori/oort@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
printf -v DOTENV_DOLLAR '\x24'

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    sha256sum "$1"
  fi
}

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

make_fixture() {
  local name="$1"
  local fixture="$TMP_ROOT/$name"
  mkdir -p "$fixture/scripts" "$fixture/infra/rust" "$fixture/fake-bin"
  cp "$ROOT/scripts/self_host_env.sh" "$fixture/scripts/self_host_env.sh"
  cp "$ROOT/infra/rust/docker-compose.rust.yml" "$fixture/infra/rust/docker-compose.rust.yml"
  cp "$ROOT/infra/rust/docker-compose.rust.build.yml" "$fixture/infra/rust/docker-compose.rust.build.yml"
  cp "$ROOT/infra/rust/local.override.yml" "$fixture/infra/rust/local.override.yml"

  cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env sh
# Model the Compose precedence that caused #1331's review finding: process env
# wins over --env-file. The generator must remove that ambient override before
# asking for the rendered application images.
#
# #1613 — also models `docker ps`/`inspect`/`volume inspect` so the stack
# collision guard can be unit-tested without a daemon. Default: no containers,
# no volumes. Tests opt in with SELF_HOST_FAKE_*.
if [ -n "${SELF_HOST_DOCKER_ENV_TRACE:-}" ]; then
  {
    printf 'DOCKER_HOST=%s\n' "${DOCKER_HOST:-}"
    printf 'DOCKER_CONTEXT=%s\n' "${DOCKER_CONTEXT:-}"
    printf 'DOCKER_CONFIG=%s\n' "${DOCKER_CONFIG:-}"
  } >"$SELF_HOST_DOCKER_ENV_TRACE"
fi
if [ "${1:-}" = "compose" ]; then
  env_file=""
  previous=""
  is_images=0
  for argument in "$@"; do
    if [ "$previous" = "--env-file" ]; then
      env_file="$argument"
    fi
    [ "$argument" = "--images" ] && is_images=1
    previous="$argument"
  done
  if [ "$is_images" -eq 1 ]; then
    [ -n "$env_file" ] && [ -f "$env_file" ] || exit 3
    file_image="$(awk -F= '$1 == "MOMO_RUST_IMAGE" { value = substr($0, index($0, "=") + 1) } END { print value }' "$env_file")"
    effective_image="${MOMO_RUST_IMAGE:-$file_image}"
    count=0
    while [ "$count" -lt 7 ]; do
      printf '%s\n' "$effective_image"
      count=$((count + 1))
    done
  fi
  exit 0
fi
if [ "${1:-}" = "ps" ]; then
  filter=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--filter" ]; then
      filter="$argument"
    fi
    previous="$argument"
  done
  case "$filter" in
    label=com.docker.compose.project=*)
      want="${filter#label=com.docker.compose.project=}"
      if [ -n "${SELF_HOST_FAKE_PROJECT:-}" ] && [ "$want" = "$SELF_HOST_FAKE_PROJECT" ]; then
        [ -n "${SELF_HOST_FAKE_CONTAINER_ID:-}" ] && printf '%s\n' "$SELF_HOST_FAKE_CONTAINER_ID"
      fi
      ;;
    volume=*)
      want="${filter#volume=}"
      if [ -n "${SELF_HOST_FAKE_VOLUME_NAME:-}" ] && [ "$want" = "$SELF_HOST_FAKE_VOLUME_NAME" ]; then
        id="${SELF_HOST_FAKE_VOLUME_CONTAINER_ID:-${SELF_HOST_FAKE_CONTAINER_ID:-}}"
        [ -n "$id" ] && printf '%s\n' "$id"
      fi
      ;;
  esac
  exit 0
fi
if [ "${1:-}" = "inspect" ]; then
  format=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--format" ]; then
      format="$argument"
    fi
    previous="$argument"
  done
  case "$format" in
    *working_dir*)
      printf '%s\n' "${SELF_HOST_FAKE_WORKING_DIR:-}"
      ;;
    *com.docker.compose.project*)
      printf '%s\n' "${SELF_HOST_FAKE_INSPECT_PROJECT:-${SELF_HOST_FAKE_PROJECT:-}}"
      ;;
    *)
      exit 1
      ;;
  esac
  exit 0
fi
if [ "${1:-}" = "volume" ] && [ "${2:-}" = "inspect" ]; then
  name="${3:-}"
  if [ -n "$name" ] && [ "$name" = "${SELF_HOST_FAKE_VOLUME_NAME:-}" ]; then
    printf '%s\n' "$name"
    exit 0
  fi
  exit 1
fi
exit 0
EOF
  cat >"$fixture/fake-bin/openssl" <<'EOF'
#!/usr/bin/env sh
if [ "${1:-}" = "rand" ] && [ "${2:-}" = "-hex" ]; then
  count=$((${3:-1} * 2))
  i=0
  while [ "$i" -lt "$count" ]; do
    printf 'a'
    i=$((i + 1))
  done
  printf '\n'
  exit 0
fi
exit 2
EOF
  chmod +x "$fixture/fake-bin/docker" "$fixture/fake-bin/openssl" "$fixture/scripts/self_host_env.sh"
  printf '%s\n' "$fixture"
}

run_generator() {
  local fixture="$1" output="$2" web_port="$3"
  shift 3
  (
    cd "$fixture"
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
      MOMO_WEB_PORT="$web_port" \
      MOMO_RUST_API_PORT="$((web_port + 1))" \
      CENT_HOST_PORT="$((web_port + 2))" \
      bash scripts/self_host_env.sh "$@"
  ) >"$output" 2>&1
}

local_fixture="$(make_fixture local)"
local_output="$local_fixture/output"
run_generator "$local_fixture" "$local_output" 49100 --local-build
grep -Fxq 'MOMO_SELF_HOST_MODE=local-build' "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_RUST_IMAGE=oort:local' "$local_fixture/infra/rust/local.secrets.env"
# #1613 — default identity stays oort / oort-pgdata so an existing volume is
# not silently replaced by a new empty name on upgrade.
grep -Fxq 'COMPOSE_PROJECT_NAME=oort' "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'DB_VOLUME_NAME=oort-pgdata' "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_MIGRATE_ENV=development' "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_PITR_EVIDENCE_REQUIRED=0' "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_PITR_BOOTSTRAP_EMPTY=0' "$local_fixture/infra/rust/local.secrets.env"
test "$(file_mode "$local_fixture/infra/rust/local.secrets.env")" = "600"
# #1534 — the instance-operator declaration. An env that names a first owner but
# no operator produces a stack whose AI-연결 surface is 403 for that very owner,
# which is what made "설치 → 첫 에이전트 응답" unreachable (#1526 F1).
grep -Fxq 'PLATFORM_ADMIN_EMAILS=owner@oort.local' "$local_fixture/infra/rust/local.secrets.env"
test "$(sed -n 's/^PLATFORM_ADMIN_EMAILS=//p' "$local_fixture/infra/rust/local.secrets.env")" \
   = "$(sed -n 's/^MOMO_INITIAL_OWNER_EMAIL=//p' "$local_fixture/infra/rust/local.secrets.env")"
# #1607 — packaged Tauri origins. REST CORS is comma-separated; Centrifugo
# v6 env is space-separated. Both knobs must carry the two desktop origins
# or login works and realtime 403s (or the reverse).
grep -Fxq 'MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost' \
  "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49100 http://127.0.0.1:49100 tauri://localhost http://tauri.localhost' \
  "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_CENTRIFUGO_WS_URL=same-origin' "$local_fixture/infra/rust/local.secrets.env"
# #1696 / ADR-0169 — self-host default archive is a named local volume, not
# stub (boot-refused in staging) and not Google SA.
grep -Fxq 'MOMO_DRIVE_ARCHIVE_BACKEND=local' "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive' "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=http://localhost:49100' \
  "$local_fixture/infra/rust/local.secrets.env"
grep -Fxq 'DRIVE_VOLUME_NAME=oort-drive' "$local_fixture/infra/rust/local.secrets.env"
grep -Fq 'scripts/self_host_env.sh --compose' "$local_output"
grep -Fq 'production 백업/PITR가 아니다' "$local_output"
grep -Fq -- 'up -d --build --wait' "$local_output"
if grep -Fq -- '--pull missing' "$local_output"; then
  echo "local-build output unexpectedly contains pull-only argv" >&2
  exit 1
fi

# An existing local database must not be silently switched to a published image.
local_before="$(hash_file "$local_fixture/infra/rust/local.secrets.env")"
if run_generator "$local_fixture" "$local_fixture/mismatch-output" 49100 --published-image "$GOOD_DIGEST"; then
  echo "mode switch over an existing env unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'local-build 모드' "$local_fixture/mismatch-output"
test "$local_before" = "$(hash_file "$local_fixture/infra/rust/local.secrets.env")"

published_fixture="$(make_fixture published)"
published_output="$published_fixture/output"
run_generator "$published_fixture" "$published_output" 49200 --published-image "$GOOD_DIGEST"
grep -Fxq 'MOMO_SELF_HOST_MODE=published-digest' "$published_fixture/infra/rust/local.secrets.env"
grep -Fxq "MOMO_RUST_IMAGE=$GOOD_DIGEST" "$published_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost' \
  "$published_fixture/infra/rust/local.secrets.env"
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49200 http://127.0.0.1:49200 tauri://localhost http://tauri.localhost' \
  "$published_fixture/infra/rust/local.secrets.env"
grep -Fq -- 'up -d --pull missing --wait' "$published_output"
grep -Fq 'scripts/self_host_env.sh --compose' "$published_output"
if grep -Fq -- '--build' "$published_output"; then
  echo "published-digest output unexpectedly contains --build" >&2
  exit 1
fi

# Re-reading the same pinned env is idempotent and prints the pull-only command.
run_generator "$published_fixture" "$published_fixture/rerun-output" 49200 --published-image "$GOOD_DIGEST"
grep -Fq -- 'up -d --pull missing --wait' "$published_fixture/rerun-output"
published_password="$(sed -n 's/^MOMO_INITIAL_OWNER_PASSWORD=//p' "$published_fixture/infra/rust/local.secrets.env")"
test -n "$published_password"
if grep -Fq "$published_password" "$published_fixture/rerun-output"; then
  echo "existing owner password leaked to stdout" >&2
  exit 1
fi

# Ambient Compose interpolation must not replace the generated env authority.
override_fixture="$(make_fixture ambient-image-override)"
(
  export MOMO_RUST_IMAGE=busybox:latest
  run_generator "$override_fixture" "$override_fixture/output" 49250 \
    --published-image "$GOOD_DIGEST"
)
grep -Fxq "MOMO_RUST_IMAGE=$GOOD_DIGEST" "$override_fixture/infra/rust/local.secrets.env"
grep -Fq 'scripts/self_host_env.sh --compose' "$override_fixture/output"

# Compose itself, not a fake/string fixture, must resolve the exact generated
# secret/URL/port/project/image values even when every category has an ambient
# collision. COMPOSE_FILE/PROFILE/ENV_FILES controls must not add another
# config source. Docker daemon/context variables remain available by design.
real_config="$published_fixture/real-compose.json"
real_docker_dir="$(dirname -- "$(command -v docker)")"
ambient_marker="review-ambient-secret-marker"
(
  cd "$published_fixture"
  PATH="$real_docker_dir:/usr/bin:/bin" \
    JWT_HMAC="$ambient_marker" \
    MOMO_APP_DATABASE_URL="postgres://$ambient_marker@invalid/momo" \
    MOMO_CENTRIFUGO_WS_URL="wss://$ambient_marker.invalid/connection" \
    MOMO_WEB_PORT=59990 MOMO_RUST_API_PORT=59991 CENT_HOST_PORT=59992 \
    MOMO_RUST_IMAGE=busybox:latest MOMO_CADDY_IMAGE=busybox:latest \
    COMPOSE_PROJECT_NAME=ambient-project COMPOSE_FILE=/does/not/exist \
    COMPOSE_ENV_FILES=/also/missing COMPOSE_PROFILES=ambient-profile \
    bash scripts/self_host_env.sh --compose config --format json
) >"$real_config" 2>"$published_fixture/real-compose.stderr"
expected_jwt="$(sed -n 's/^JWT_HMAC=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_db_url="$(sed -n 's/^MOMO_APP_DATABASE_URL=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_ws_url="$(sed -n 's/^MOMO_CENTRIFUGO_WS_URL=//p' "$published_fixture/infra/rust/local.secrets.env")"
# #1534 — the two keys whose absence from the api service made the self-host
# path unable to reach a first agent answer: without the master key the AI-연결
# routes answer 503, and without the allow-list they answer 403 to the operator
# who installed the instance. Reading them off `docker compose config` (rather
# than off the env file) is the point: F1a was precisely "the value is in the
# env file and never reaches the container".
expected_operator="$(sed -n 's/^PLATFORM_ADMIN_EMAILS=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_master_key="$(sed -n 's/^PROVIDER_LINK_MASTER_KEY=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_cors="$(sed -n 's/^MOMO_CORS_ALLOWED_ORIGINS=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_centrifugo="$(sed -n 's/^CENTRIFUGO_ALLOWED_ORIGINS=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_drive_backend="$(sed -n 's/^MOMO_DRIVE_ARCHIVE_BACKEND=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_drive_dir="$(sed -n 's/^MOMO_DRIVE_LOCAL_DIR=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_drive_base="$(sed -n 's/^MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=//p' "$published_fixture/infra/rust/local.secrets.env")"
expected_drive_volume="$(sed -n 's/^DRIVE_VOLUME_NAME=//p' "$published_fixture/infra/rust/local.secrets.env")"
test -n "$expected_operator"
test -n "$expected_master_key"
test "$expected_cors" = "tauri://localhost,http://tauri.localhost"
test "$expected_centrifugo" = "http://localhost:49200 http://127.0.0.1:49200 tauri://localhost http://tauri.localhost"
test "$expected_drive_backend" = "local"
test "$expected_drive_dir" = "/var/lib/oort/drive"
test "$expected_drive_base" = "http://localhost:49200"
test "$expected_drive_volume" = "oort-drive"
jq -e \
  --arg image "$GOOD_DIGEST" \
  --arg jwt "$expected_jwt" \
  --arg db "$expected_db_url" \
  --arg ws "$expected_ws_url" \
  --arg operator "$expected_operator" \
  --arg master "$expected_master_key" \
  --arg cors "$expected_cors" \
  --arg centrifugo "$expected_centrifugo" \
  --arg drive_backend "$expected_drive_backend" \
  --arg drive_dir "$expected_drive_dir" \
  --arg drive_base "$expected_drive_base" \
  --arg drive_volume "$expected_drive_volume" '
    .name == "oort" and
    .services.api.image == $image and
    .services.api.environment.JWT_HMAC == $jwt and
    .services.api.environment.DATABASE_URL == $db and
    .services.api.environment.MOMO_CENTRIFUGO_WS_URL == $ws and
    .services.migrate.environment.MOMO_ENV == "development" and
    .services.migrate.environment.MOMO_PITR_EVIDENCE_REQUIRED == "0" and
    .services.migrate.environment.MOMO_PITR_BOOTSTRAP_EMPTY == "0" and
    .services.api.environment.PLATFORM_ADMIN_EMAILS == $operator and
    .services.api.environment.PROVIDER_LINK_MASTER_KEY == $master and
    .services.api.environment.MOMO_CORS_ALLOWED_ORIGINS == $cors and
    .services["agent-worker"].environment.PROVIDER_LINK_MASTER_KEY == $master and
    .services.centrifugo.environment.CENTRIFUGO_CLIENT_ALLOWED_ORIGINS == $centrifugo and
    .services.api.environment.MOMO_DRIVE_ARCHIVE_BACKEND == $drive_backend and
    .services.api.environment.MOMO_DRIVE_LOCAL_DIR == $drive_dir and
    .services.api.environment.MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL == $drive_base and
    .volumes["drive-archive"].name == $drive_volume and
    .services.web.image == "caddy:2-alpine" and
    .services.web.ports[0].published == "49200" and
    .services.api.ports[0].published == "49201" and
    .services.centrifugo.ports[0].published == "49202"
  ' "$real_config" >/dev/null
if grep -Fq "$ambient_marker" "$real_config" "$published_fixture/real-compose.stderr"; then
  echo "ambient Compose value reached rendered output or diagnostics" >&2
  exit 1
fi
real_images="$(jq -r '.services[].image' "$real_config")"
real_count="$(printf '%s\n' "$real_images" | awk -v expected="$GOOD_DIGEST" '
  $0 == expected { count += 1 }
  END { print count + 0 }
')"
test "$real_count" -eq 7

# Caller argv cannot add a second config source or replace canonical
# env/project/profile authority. A literal service-command argument with the
# same spelling remains possible after an explicit `--` delimiter.
for bypass in \
  '-f /tmp/evil.yml config' \
  '-f/tmp/evil.yml config' \
  '-pevil config' \
  'config --file=/tmp/evil.yml' \
  'config --env-file=/tmp/evil.env' \
  'config --project-name=evil' \
  'config --project-directory=/tmp' \
  'config --profile=evil' \
  'config --all-resources' \
  'config --ansi=never' \
  'up --compatibility' \
  'up --dry-run' \
  'up --parallel=1' \
  'up --progress=plain'; do
  bypass_output="$published_fixture/bypass-$(printf '%s' "$bypass" | tr -c 'A-Za-z0-9' '_')"
  # Deliberate word splitting models shell argv from the fixed test literals.
  # shellcheck disable=SC2086
  if run_generator "$published_fixture" "$bypass_output" 49200 --compose $bypass; then
    echo "compose config-source bypass unexpectedly succeeded: $bypass" >&2
    exit 1
  fi
  grep -Eq '허용된 compose subcommand|canonical env/file/project/profile' "$bypass_output"
done
run_generator "$published_fixture" "$published_fixture/service-argv-output" 49200 \
  --compose run --rm migrate -- --file literal-service-argument

docker_env_trace="$published_fixture/docker-env.trace"
DOCKER_HOST='unix:///review-preserved.sock' \
DOCKER_CONTEXT='review-preserved-context' \
DOCKER_CONFIG='/review/preserved/config' \
SELF_HOST_DOCKER_ENV_TRACE="$docker_env_trace" \
  run_generator "$published_fixture" "$published_fixture/docker-env-output" 49200 \
    --compose ps
grep -Fxq 'DOCKER_HOST=unix:///review-preserved.sock' "$docker_env_trace"
grep -Fxq 'DOCKER_CONTEXT=review-preserved-context' "$docker_env_trace"
grep -Fxq 'DOCKER_CONFIG=/review/preserved/config' "$docker_env_trace"

invalid_fixture="$(make_fixture invalid)"
if run_generator "$invalid_fixture" "$invalid_fixture/output" 49300 \
  --published-image ghcr.io/yeomyeonggeori/oort:latest; then
  echo "mutable published tag unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$invalid_fixture/infra/rust/local.secrets.env"
grep -Fq '@sha256:<64 lowercase hex>' "$invalid_fixture/output"

# Validation must cover the complete argument, not just a valid first line.
# Otherwise the second line is written verbatim into the generated env file.
injection_fixture="$(make_fixture newline-injection)"
injected_image="$GOOD_DIGEST"$'\n''MOMO_SELF_HOST_MODE=local-build'
if run_generator "$injection_fixture" "$injection_fixture/output" 49350 \
  --published-image "$injected_image"; then
  echo "newline-injected published ref unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$injection_fixture/infra/rust/local.secrets.env"
grep -Fq 'LF/CR' "$injection_fixture/output"

local_injection_fixture="$(make_fixture local-newline-injection)"
if (
  cd "$local_injection_fixture"
  PATH="$local_injection_fixture/fake-bin:/usr/bin:/bin" \
    MOMO_WEB_PORT=49360 MOMO_RUST_API_PORT=49361 CENT_HOST_PORT=49362 \
    MOMO_RUST_IMAGE=$'oort:local\nMOMO_SELF_HOST_MODE=published-digest' \
    bash scripts/self_host_env.sh --local-build
) >"$local_injection_fixture/output" 2>&1; then
  echo "newline-injected local ref unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$local_injection_fixture/infra/rust/local.secrets.env"
grep -Fq 'LF/CR' "$local_injection_fixture/output"

# Every external env-file scalar shares the same record-separator guard. The
# secret value itself must not be copied into diagnostics.
secret_injection_fixture="$(make_fixture secret-newline-injection)"
secret_marker="review-secret-marker"
if (
  MOMO_INITIAL_OWNER_PASSWORD="$secret_marker"$'\n''MOMO_RUST_IMAGE=busybox:latest' \
    run_generator "$secret_injection_fixture" "$secret_injection_fixture/output" 49370 --local-build
); then
  echo "newline-injected owner password unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$secret_injection_fixture/infra/rust/local.secrets.env"
if grep -Fq "$secret_marker" "$secret_injection_fixture/output"; then
  echo "rejected owner password leaked to diagnostics" >&2
  exit 1
fi

cr_injection_fixture="$(make_fixture secret-cr-injection)"
if (
  MOMO_INITIAL_OWNER_PASSWORD=$'normal\rMOMO_RUST_IMAGE=busybox:latest' \
    run_generator "$cr_injection_fixture" "$cr_injection_fixture/output" 49380 --local-build
); then
  echo "CR-injected owner password unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$cr_injection_fixture/infra/rust/local.secrets.env"

# Compose dotenv metacharacters are not record separators, but they still
# expand, quote, escape, or comment the credential. Reject them before writing
# and never repeat the rejected secret in diagnostics.
metachar_index=0
for bad_password in \
  "review-${DOTENV_DOLLAR}JWT_HMAC" \
  'review secret value' \
  'review#comment-value' \
  'review-"quoted"-value' \
  "review-'single'-value" \
  'review-\backslash-value'; do
  metachar_index=$((metachar_index + 1))
  metachar_fixture="$(make_fixture "password-metachar-$metachar_index")"
  if MOMO_INITIAL_OWNER_PASSWORD="$bad_password" \
    run_generator "$metachar_fixture" "$metachar_fixture/output" "$((49410 + metachar_index * 3))" --local-build; then
    echo "dotenv metacharacter password unexpectedly succeeded" >&2
    exit 1
  fi
  test ! -e "$metachar_fixture/infra/rust/local.secrets.env"
  grep -Fq 'dotenv-safe literal' "$metachar_fixture/output"
  if grep -Fq "$bad_password" "$metachar_fixture/output"; then
    echo "rejected metacharacter password leaked to diagnostics" >&2
    exit 1
  fi
done

email_fixture="$(make_fixture email-metachar)"
bad_email="owner-${DOTENV_DOLLAR}JWT_HMAC@oort.local"
if MOMO_INITIAL_OWNER_EMAIL="$bad_email" \
  run_generator "$email_fixture" "$email_fixture/output" 49430 --local-build; then
  echo "dotenv metacharacter email unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$email_fixture/infra/rust/local.secrets.env"
grep -Fq 'dotenv-safe 소문자 이메일' "$email_fixture/output"
if grep -Fq "$bad_email" "$email_fixture/output"; then
  echo "rejected metacharacter email leaked to diagnostics" >&2
  exit 1
fi

# Safe custom credentials round-trip byte-for-byte; already-existing files get
# the same validation instead of being grandfathered into an unsafe render.
safe_fixture="$(make_fixture safe-custom-credential)"
safe_email='owner+review@oort.local'
safe_password='Safe-Alpha_123!@%=,.:/+~'
MOMO_INITIAL_OWNER_EMAIL="$safe_email" MOMO_INITIAL_OWNER_PASSWORD="$safe_password" \
  run_generator "$safe_fixture" "$safe_fixture/output" 49440 --local-build
grep -Fxq "MOMO_INITIAL_OWNER_EMAIL=$safe_email" "$safe_fixture/infra/rust/local.secrets.env"
grep -Fxq "MOMO_INITIAL_OWNER_PASSWORD=$safe_password" "$safe_fixture/infra/rust/local.secrets.env"

existing_unsafe_fixture="$(make_fixture existing-unsafe-credential)"
run_generator "$existing_unsafe_fixture" "$existing_unsafe_fixture/first-output" 49450 --local-build
existing_unsafe_marker="existing-${DOTENV_DOLLAR}JWT_HMAC-secret-marker"
awk -v replacement="MOMO_INITIAL_OWNER_PASSWORD=$existing_unsafe_marker" '
  /^MOMO_INITIAL_OWNER_PASSWORD=/ { print replacement; next }
  { print }
' "$existing_unsafe_fixture/infra/rust/local.secrets.env" >"$existing_unsafe_fixture/replacement.env"
mv "$existing_unsafe_fixture/replacement.env" "$existing_unsafe_fixture/infra/rust/local.secrets.env"
if run_generator "$existing_unsafe_fixture" "$existing_unsafe_fixture/rerun-output" 49450 --local-build; then
  echo "existing dotenv-unsafe credential unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'dotenv-safe literal' "$existing_unsafe_fixture/rerun-output"
if grep -Fq "$existing_unsafe_marker" "$existing_unsafe_fixture/rerun-output"; then
  echo "existing unsafe credential leaked to diagnostics" >&2
  exit 1
fi

# An already-poisoned env must be rejected by exact-once parsing. Compose uses
# the last duplicate, so validating only the first value is not a boundary.
duplicate_fixture="$(make_fixture duplicate-image-key)"
run_generator "$duplicate_fixture" "$duplicate_fixture/first-output" 49390 \
  --published-image "$GOOD_DIGEST"
printf '%s\n' 'MOMO_RUST_IMAGE=busybox:latest' >>"$duplicate_fixture/infra/rust/local.secrets.env"
duplicate_before="$(hash_file "$duplicate_fixture/infra/rust/local.secrets.env")"
if run_generator "$duplicate_fixture" "$duplicate_fixture/output" 49390 \
  --published-image "$GOOD_DIGEST"; then
  echo "duplicate critical image key unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq '중복 env 키' "$duplicate_fixture/output"
test "$duplicate_before" = "$(hash_file "$duplicate_fixture/infra/rust/local.secrets.env")"

# Reject arithmetic expressions before Bash arithmetic or /dev/tcp sees them.
port_fixture="$(make_fixture malicious-port)"
port_marker="$port_fixture/arithmetic-executed"
if (
  cd "$port_fixture"
  PATH="$port_fixture/fake-bin:/usr/bin:/bin" \
    MOMO_WEB_PORT="1+\$(touch $port_marker)" \
    MOMO_RUST_API_PORT=49401 CENT_HOST_PORT=49402 \
    bash scripts/self_host_env.sh --local-build
) >"$port_fixture/output" 2>&1; then
  echo "arithmetic-expression port unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$port_marker"
test ! -e "$port_fixture/infra/rust/local.secrets.env"
grep -Fq 'ASCII 10진수' "$port_fixture/output"

# #1534 — an env written before the operator line existed. The generator adds
# that one line on the next run and rotates NOTHING: a regenerated secret would
# desynchronise from the role password already inside a migrated database, which
# is the whole reason this file is never rewritten.
repair_fixture="$(make_fixture operator-allowlist-repair)"
run_generator "$repair_fixture" "$repair_fixture/first-output" 49460 --local-build
repair_env="$repair_fixture/infra/rust/local.secrets.env"
grep -Fxq 'PLATFORM_ADMIN_EMAILS=owner@oort.local' "$repair_env"
grep -v '^PLATFORM_ADMIN_EMAILS=' "$repair_env" >"$repair_fixture/stripped.env"
mv "$repair_fixture/stripped.env" "$repair_env"
if grep -q '^PLATFORM_ADMIN_EMAILS=' "$repair_env"; then
  echo "fixture setup failed: allow-list line still present" >&2
  exit 1
fi
repair_secrets_before="$(grep -E '^(JWT_HMAC|PROVIDER_LINK_MASTER_KEY|MOMO_APP_POSTGRES_PASSWORD|MOMO_INITIAL_OWNER_PASSWORD)=' "$repair_env")"
run_generator "$repair_fixture" "$repair_fixture/repair-output" 49460 --local-build
grep -Fxq 'PLATFORM_ADMIN_EMAILS=owner@oort.local' "$repair_env"
test "$repair_secrets_before" = "$(grep -E '^(JWT_HMAC|PROVIDER_LINK_MASTER_KEY|MOMO_APP_POSTGRES_PASSWORD|MOMO_INITIAL_OWNER_PASSWORD)=' "$repair_env")"
grep -Fq 'PLATFORM_ADMIN_EMAILS' "$repair_fixture/repair-output"
# Idempotent: a second run neither duplicates the key nor trips the
# duplicate-key guard the next invocation runs first.
run_generator "$repair_fixture" "$repair_fixture/repair-output-2" 49460 --local-build
test "$(grep -c '^PLATFORM_ADMIN_EMAILS=' "$repair_env")" = "1"

# The repair also fires on the `--compose` path, and that path's stdout is a
# machine surface the generator itself parses (`config --images`). A notice
# printed there would be read as a rendered image line.
grep -v '^PLATFORM_ADMIN_EMAILS=' "$repair_env" >"$repair_fixture/stripped-again.env"
mv "$repair_fixture/stripped-again.env" "$repair_env"
(
  cd "$repair_fixture"
  PATH="$repair_fixture/fake-bin:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose config --images
) >"$repair_fixture/images.stdout" 2>"$repair_fixture/images.stderr"
grep -Fxq 'PLATFORM_ADMIN_EMAILS=owner@oort.local' "$repair_env"
if grep -Fq 'PLATFORM_ADMIN_EMAILS' "$repair_fixture/images.stdout"; then
  echo "allow-list repair notice reached the machine-parsed --compose stdout" >&2
  exit 1
fi
grep -Fq 'PLATFORM_ADMIN_EMAILS' "$repair_fixture/images.stderr"
test "$(sort -u "$repair_fixture/images.stdout")" = "oort:local"

# A value somebody chose is never overwritten — including a deliberately empty
# one, which is the only way to say "close these surfaces on this instance".
custom_fixture="$(make_fixture operator-allowlist-custom)"
run_generator "$custom_fixture" "$custom_fixture/first-output" 49470 --local-build
custom_env="$custom_fixture/infra/rust/local.secrets.env"
awk '/^PLATFORM_ADMIN_EMAILS=/ { print "PLATFORM_ADMIN_EMAILS=a@example.com,b@example.com"; next } { print }' \
  "$custom_env" >"$custom_fixture/custom.env"
mv "$custom_fixture/custom.env" "$custom_env"
run_generator "$custom_fixture" "$custom_fixture/custom-output" 49470 --local-build
grep -Fxq 'PLATFORM_ADMIN_EMAILS=a@example.com,b@example.com' "$custom_env"
test "$(grep -c '^PLATFORM_ADMIN_EMAILS=' "$custom_env")" = "1"

# #1607 — an env written before the desktop CORS line existed. Same add-only
# rule as PLATFORM_ADMIN_EMAILS: secrets do not rotate, a chosen value
# (including empty) is never overwritten, and --compose stdout stays a
# machine surface.
cors_repair_fixture="$(make_fixture desktop-cors-allowlist-repair)"
run_generator "$cors_repair_fixture" "$cors_repair_fixture/first-output" 49480 --local-build
cors_repair_env="$cors_repair_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost' "$cors_repair_env"
grep -v '^MOMO_CORS_ALLOWED_ORIGINS=' "$cors_repair_env" >"$cors_repair_fixture/stripped.env"
mv "$cors_repair_fixture/stripped.env" "$cors_repair_env"
if grep -q '^MOMO_CORS_ALLOWED_ORIGINS=' "$cors_repair_env"; then
  echo "fixture setup failed: CORS allow-list line still present" >&2
  exit 1
fi
cors_secrets_before="$(grep -E '^(JWT_HMAC|PROVIDER_LINK_MASTER_KEY|MOMO_APP_POSTGRES_PASSWORD|MOMO_INITIAL_OWNER_PASSWORD)=' "$cors_repair_env")"
run_generator "$cors_repair_fixture" "$cors_repair_fixture/repair-output" 49480 --local-build
grep -Fxq 'MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost' "$cors_repair_env"
test "$cors_secrets_before" = "$(grep -E '^(JWT_HMAC|PROVIDER_LINK_MASTER_KEY|MOMO_APP_POSTGRES_PASSWORD|MOMO_INITIAL_OWNER_PASSWORD)=' "$cors_repair_env")"
grep -Fq 'MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost 를 추가했다' \
  "$cors_repair_fixture/repair-output"
run_generator "$cors_repair_fixture" "$cors_repair_fixture/repair-output-2" 49480 --local-build
test "$(grep -c '^MOMO_CORS_ALLOWED_ORIGINS=' "$cors_repair_env")" = "1"

grep -v '^MOMO_CORS_ALLOWED_ORIGINS=' "$cors_repair_env" >"$cors_repair_fixture/stripped-again.env"
mv "$cors_repair_fixture/stripped-again.env" "$cors_repair_env"
(
  cd "$cors_repair_fixture"
  PATH="$cors_repair_fixture/fake-bin:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose config --images
) >"$cors_repair_fixture/images.stdout" 2>"$cors_repair_fixture/images.stderr"
grep -Fxq 'MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost' "$cors_repair_env"
if grep -Fq 'MOMO_CORS_ALLOWED_ORIGINS' "$cors_repair_fixture/images.stdout"; then
  echo "CORS allow-list repair notice reached the machine-parsed --compose stdout" >&2
  exit 1
fi
grep -Fq 'MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost 를 추가했다' \
  "$cors_repair_fixture/images.stderr"
test "$(sort -u "$cors_repair_fixture/images.stdout")" = "oort:local"

cors_custom_fixture="$(make_fixture desktop-cors-allowlist-custom)"
run_generator "$cors_custom_fixture" "$cors_custom_fixture/first-output" 49490 --local-build
cors_custom_env="$cors_custom_fixture/infra/rust/local.secrets.env"
awk '/^MOMO_CORS_ALLOWED_ORIGINS=/ { print "MOMO_CORS_ALLOWED_ORIGINS=https://app.example.com"; next } { print }' \
  "$cors_custom_env" >"$cors_custom_fixture/custom.env"
mv "$cors_custom_fixture/custom.env" "$cors_custom_env"
run_generator "$cors_custom_fixture" "$cors_custom_fixture/custom-output" 49490 --local-build
grep -Fxq 'MOMO_CORS_ALLOWED_ORIGINS=https://app.example.com' "$cors_custom_env"
test "$(grep -c '^MOMO_CORS_ALLOWED_ORIGINS=' "$cors_custom_env")" = "1"

cors_empty_fixture="$(make_fixture desktop-cors-allowlist-empty)"
run_generator "$cors_empty_fixture" "$cors_empty_fixture/first-output" 49500 --local-build
cors_empty_env="$cors_empty_fixture/infra/rust/local.secrets.env"
awk '/^MOMO_CORS_ALLOWED_ORIGINS=/ { print "MOMO_CORS_ALLOWED_ORIGINS="; next } { print }' \
  "$cors_empty_env" >"$cors_empty_fixture/empty.env"
mv "$cors_empty_fixture/empty.env" "$cors_empty_env"
run_generator "$cors_empty_fixture" "$cors_empty_fixture/empty-output" 49500 --local-build
grep -Fxq 'MOMO_CORS_ALLOWED_ORIGINS=' "$cors_empty_env"
test "$(grep -c '^MOMO_CORS_ALLOWED_ORIGINS=' "$cors_empty_env")" = "1"

# #1696 — an env written before the local archive lines existed. Same add-only
# rule: secrets do not rotate, a chosen backend (including empty) is never
# overwritten, and --compose stdout stays a machine surface.
drive_repair_fixture="$(make_fixture local-drive-archive-repair)"
run_generator "$drive_repair_fixture" "$drive_repair_fixture/first-output" 49520 --local-build
drive_repair_env="$drive_repair_fixture/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_DRIVE_ARCHIVE_BACKEND=local' "$drive_repair_env"
grep -vE '^(MOMO_DRIVE_ARCHIVE_BACKEND|MOMO_DRIVE_LOCAL_DIR|MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL|DRIVE_VOLUME_NAME)=' \
  "$drive_repair_env" >"$drive_repair_fixture/stripped.env"
mv "$drive_repair_fixture/stripped.env" "$drive_repair_env"
if grep -q '^MOMO_DRIVE_ARCHIVE_BACKEND=' "$drive_repair_env"; then
  echo "fixture setup failed: drive backend line still present" >&2
  exit 1
fi
drive_secrets_before="$(grep -E '^(JWT_HMAC|PROVIDER_LINK_MASTER_KEY|MOMO_APP_POSTGRES_PASSWORD|MOMO_INITIAL_OWNER_PASSWORD)=' "$drive_repair_env")"
run_generator "$drive_repair_fixture" "$drive_repair_fixture/repair-output" 49520 --local-build
grep -Fxq 'MOMO_DRIVE_ARCHIVE_BACKEND=local' "$drive_repair_env"
grep -Fxq 'MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive' "$drive_repair_env"
grep -Fxq 'MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=http://localhost:49520' "$drive_repair_env"
grep -Fxq 'DRIVE_VOLUME_NAME=oort-drive' "$drive_repair_env"
test "$drive_secrets_before" = "$(grep -E '^(JWT_HMAC|PROVIDER_LINK_MASTER_KEY|MOMO_APP_POSTGRES_PASSWORD|MOMO_INITIAL_OWNER_PASSWORD)=' "$drive_repair_env")"
grep -Fq 'MOMO_DRIVE_ARCHIVE_BACKEND=local 를 추가했다' "$drive_repair_fixture/repair-output"
run_generator "$drive_repair_fixture" "$drive_repair_fixture/repair-output-2" 49520 --local-build
test "$(grep -c '^MOMO_DRIVE_ARCHIVE_BACKEND=' "$drive_repair_env")" = "1"

grep -vE '^(MOMO_DRIVE_ARCHIVE_BACKEND|MOMO_DRIVE_LOCAL_DIR|MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL|DRIVE_VOLUME_NAME)=' \
  "$drive_repair_env" >"$drive_repair_fixture/stripped-again.env"
mv "$drive_repair_fixture/stripped-again.env" "$drive_repair_env"
(
  cd "$drive_repair_fixture"
  PATH="$drive_repair_fixture/fake-bin:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose config --images
) >"$drive_repair_fixture/images.stdout" 2>"$drive_repair_fixture/images.stderr"
grep -Fxq 'MOMO_DRIVE_ARCHIVE_BACKEND=local' "$drive_repair_env"
if grep -Fq 'MOMO_DRIVE_ARCHIVE_BACKEND' "$drive_repair_fixture/images.stdout"; then
  echo "local-drive repair notice reached the machine-parsed --compose stdout" >&2
  exit 1
fi
grep -Fq 'MOMO_DRIVE_ARCHIVE_BACKEND=local 를 추가했다' "$drive_repair_fixture/images.stderr"
test "$(sort -u "$drive_repair_fixture/images.stdout")" = "oort:local"

drive_empty_fixture="$(make_fixture local-drive-archive-empty)"
run_generator "$drive_empty_fixture" "$drive_empty_fixture/first-output" 49530 --local-build
drive_empty_env="$drive_empty_fixture/infra/rust/local.secrets.env"
awk '/^MOMO_DRIVE_ARCHIVE_BACKEND=/ { print "MOMO_DRIVE_ARCHIVE_BACKEND="; next } { print }' \
  "$drive_empty_env" >"$drive_empty_fixture/empty.env"
mv "$drive_empty_fixture/empty.env" "$drive_empty_env"
run_generator "$drive_empty_fixture" "$drive_empty_fixture/empty-output" 49530 --local-build
grep -Fxq 'MOMO_DRIVE_ARCHIVE_BACKEND=' "$drive_empty_env"
test "$(grep -c '^MOMO_DRIVE_ARCHIVE_BACKEND=' "$drive_empty_env")" = "1"

# Existing CENTRIFUGO_ALLOWED_ORIGINS is never rewritten. A pre-#1607 list
# without tauri origins stays byte-for-byte; the generator warns on stderr.
cent_warn_fixture="$(make_fixture centrifugo-desktop-origin-warn)"
run_generator "$cent_warn_fixture" "$cent_warn_fixture/first-output" 49510 --local-build
cent_warn_env="$cent_warn_fixture/infra/rust/local.secrets.env"
awk '/^CENTRIFUGO_ALLOWED_ORIGINS=/ { print "CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49510 http://127.0.0.1:49510"; next } { print }' \
  "$cent_warn_env" >"$cent_warn_fixture/historical.env"
mv "$cent_warn_fixture/historical.env" "$cent_warn_env"
cent_before="$(grep -E '^(CENTRIFUGO_ALLOWED_ORIGINS|JWT_HMAC|MOMO_CORS_ALLOWED_ORIGINS)=' "$cent_warn_env")"
run_generator "$cent_warn_fixture" "$cent_warn_fixture/warn-output" 49510 --local-build
test "$cent_before" = "$(grep -E '^(CENTRIFUGO_ALLOWED_ORIGINS|JWT_HMAC|MOMO_CORS_ALLOWED_ORIGINS)=' "$cent_warn_env")"
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49510 http://127.0.0.1:49510' "$cent_warn_env"
grep -Fq 'CENTRIFUGO_ALLOWED_ORIGINS 에 tauri://localhost 또는 http://tauri.localhost 가 없다' "$cent_warn_fixture/warn-output"
(
  cd "$cent_warn_fixture"
  PATH="$cent_warn_fixture/fake-bin:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose config --images
) >"$cent_warn_fixture/images.stdout" 2>"$cent_warn_fixture/images.stderr"
if grep -Fq 'CENTRIFUGO_ALLOWED_ORIGINS 에 tauri://localhost 또는 http://tauri.localhost 가 없다' "$cent_warn_fixture/images.stdout"; then
  echo "Centrifugo desktop-origin warning reached the machine-parsed --compose stdout" >&2
  exit 1
fi
grep -Fq 'CENTRIFUGO_ALLOWED_ORIGINS 에 tauri://localhost 또는 http://tauri.localhost 가 없다' "$cent_warn_fixture/images.stderr"
test "$(sort -u "$cent_warn_fixture/images.stdout")" = "oort:local"

# The historical no-argument command remains a local-build alias.
legacy_fixture="$(make_fixture legacy)"
run_generator "$legacy_fixture" "$legacy_fixture/output" 49400
grep -Fxq 'MOMO_SELF_HOST_MODE=local-build' "$legacy_fixture/infra/rust/local.secrets.env"
grep -Fq -- 'up -d --build --wait' "$legacy_fixture/output"

run_compose_with_fake() {
  local fixture="$1" output="$2"
  shift 2
  (
    cd "$fixture"
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
      bash scripts/self_host_env.sh --compose "$@"
  ) >"$output" 2>&1
}

# #1613 scenario 1: same compose project, different checkout working_dir.
collision_same_project="$(make_fixture collision-same-project)"
run_generator "$collision_same_project" "$collision_same_project/first-output" 49600 --local-build
grep -Fxq 'COMPOSE_PROJECT_NAME=oort' "$collision_same_project/infra/rust/local.secrets.env"
if (
  SELF_HOST_FAKE_PROJECT=oort \
  SELF_HOST_FAKE_CONTAINER_ID=ctr-foreign-checkout \
  SELF_HOST_FAKE_WORKING_DIR=/foreign/oort-checkout \
  SELF_HOST_FAKE_INSPECT_PROJECT=oort \
  SELF_HOST_FAKE_VOLUME_NAME=oort-pgdata \
    run_compose_with_fake "$collision_same_project" "$collision_same_project/up-output" up -d --wait
); then
  echo "same-project foreign checkout --compose up unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq '다른 체크아웃의 살아있는 스택' "$collision_same_project/up-output"
grep -Fq '/foreign/oort-checkout' "$collision_same_project/up-output"
# config is not a start path — the guard must not fire.
SELF_HOST_FAKE_PROJECT=oort \
SELF_HOST_FAKE_CONTAINER_ID=ctr-foreign-checkout \
SELF_HOST_FAKE_WORKING_DIR=/foreign/oort-checkout \
SELF_HOST_FAKE_INSPECT_PROJECT=oort \
SELF_HOST_FAKE_VOLUME_NAME=oort-pgdata \
  run_compose_with_fake "$collision_same_project" "$collision_same_project/config-output" config --images
test "$(sort -u "$collision_same_project/config-output")" = "oort:local"

# #1613 scenario 2: project names differ, pgdata volume is shared.
collision_shared_volume="$(make_fixture collision-shared-volume)"
COMPOSE_PROJECT_NAME=oort-b \
  run_generator "$collision_shared_volume" "$collision_shared_volume/first-output" 49610 --local-build
grep -Fxq 'COMPOSE_PROJECT_NAME=oort-b' "$collision_shared_volume/infra/rust/local.secrets.env"
grep -Fxq 'DB_VOLUME_NAME=oort-b-pgdata' "$collision_shared_volume/infra/rust/local.secrets.env"
awk '/^DB_VOLUME_NAME=/ { print "DB_VOLUME_NAME=oort-shared-pgdata"; next } { print }' \
  "$collision_shared_volume/infra/rust/local.secrets.env" \
  >"$collision_shared_volume/shared.env"
mv "$collision_shared_volume/shared.env" "$collision_shared_volume/infra/rust/local.secrets.env"
if (
  SELF_HOST_FAKE_PROJECT=oort-a \
  SELF_HOST_FAKE_INSPECT_PROJECT=oort-a \
  SELF_HOST_FAKE_WORKING_DIR=/foreign/oort-a \
  SELF_HOST_FAKE_VOLUME_NAME=oort-shared-pgdata \
  SELF_HOST_FAKE_VOLUME_CONTAINER_ID=ctr-shared-volume \
    run_compose_with_fake "$collision_shared_volume" "$collision_shared_volume/up-output" up -d --wait
); then
  echo "shared-volume foreign checkout --compose up unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq '다른 체크아웃의 살아있는 스택' "$collision_shared_volume/up-output"
grep -Fq 'oort-shared-pgdata' "$collision_shared_volume/up-output"
grep -Fq 'project=oort-a' "$collision_shared_volume/up-output"

# Same checkout = legitimate owner: resume is silent (no collision abort).
owner_resume="$(make_fixture owner-resume)"
run_generator "$owner_resume" "$owner_resume/first-output" 49620 --local-build
owner_wd="$(CDPATH='' cd -P -- "$owner_resume" && pwd)"
SELF_HOST_FAKE_PROJECT=oort \
SELF_HOST_FAKE_CONTAINER_ID=ctr-same-checkout \
SELF_HOST_FAKE_WORKING_DIR="$owner_wd" \
SELF_HOST_FAKE_INSPECT_PROJECT=oort \
SELF_HOST_FAKE_VOLUME_NAME=oort-pgdata \
  run_compose_with_fake "$owner_resume" "$owner_resume/up-output" up -d --wait
if grep -Fq '다른 체크아웃의 살아있는 스택' "$owner_resume/up-output"; then
  echo "same-checkout resume was treated as a foreign collision" >&2
  exit 1
fi

# down from a foreign checkout is also hijacking (could -v the live volume).
if (
  SELF_HOST_FAKE_PROJECT=oort \
  SELF_HOST_FAKE_CONTAINER_ID=ctr-foreign-checkout \
  SELF_HOST_FAKE_WORKING_DIR=/foreign/oort-checkout \
  SELF_HOST_FAKE_INSPECT_PROJECT=oort \
  SELF_HOST_FAKE_VOLUME_NAME=oort-pgdata \
    run_compose_with_fake "$collision_same_project" "$collision_same_project/down-output" down -v
); then
  echo "foreign checkout --compose down -v unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq '다른 체크아웃의 살아있는 스택' "$collision_same_project/down-output"

# Migration: existing oort-pgdata is adopted when the new env keeps the name.
adopt_fixture="$(make_fixture legacy-pgdata-adopt)"
SELF_HOST_FAKE_VOLUME_NAME=oort-pgdata \
  run_generator "$adopt_fixture" "$adopt_fixture/output" 49630 --local-build
grep -Fxq 'DB_VOLUME_NAME=oort-pgdata' "$adopt_fixture/infra/rust/local.secrets.env"
grep -Fq '기존 볼륨 oort-pgdata 를 이 프로젝트의 데이터로 채택한다' "$adopt_fixture/output"

# Migration: a different project name must not quietly leave oort-pgdata behind.
isolate_fixture="$(make_fixture legacy-pgdata-isolate)"
SELF_HOST_FAKE_VOLUME_NAME=oort-pgdata \
COMPOSE_PROJECT_NAME=isolated-clone \
  run_generator "$isolate_fixture" "$isolate_fixture/output" 49640 --local-build
grep -Fxq 'COMPOSE_PROJECT_NAME=isolated-clone' "$isolate_fixture/infra/rust/local.secrets.env"
grep -Fxq 'DB_VOLUME_NAME=isolated-clone-pgdata' "$isolate_fixture/infra/rust/local.secrets.env"
grep -Fq '기존 셀프호스트 볼륨 oort-pgdata 가 있다' "$isolate_fixture/output"
grep -Fq 'DB_VOLUME_NAME 은 isolated-clone-pgdata' "$isolate_fixture/output"

# ADR-0167 — --public-origin is idempotent, preserves existing tokens, and
# registers both the browser Origin and the RN websocket Origin.
public_fixture="$(make_fixture public-origin)"
run_generator "$public_fixture" "$public_fixture/first-output" 49700 --local-build
grep -Fxq 'MOMO_CENTRIFUGO_WS_URL=same-origin' "$public_fixture/infra/rust/local.secrets.env"
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49700 http://127.0.0.1:49700 tauri://localhost http://tauri.localhost' \
  "$public_fixture/infra/rust/local.secrets.env"
jwt_before="$(sed -n 's/^JWT_HMAC=//p' "$public_fixture/infra/rust/local.secrets.env")"
public_before="$(hash_file "$public_fixture/infra/rust/local.secrets.env")"
run_generator "$public_fixture" "$public_fixture/origin-output" 49700 \
  --public-origin https://cursor.tailb1aad3.ts.net
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49700 http://127.0.0.1:49700 tauri://localhost http://tauri.localhost https://cursor.tailb1aad3.ts.net wss://cursor.tailb1aad3.ts.net' \
  "$public_fixture/infra/rust/local.secrets.env"
test "$(sed -n 's/^JWT_HMAC=//p' "$public_fixture/infra/rust/local.secrets.env")" = "$jwt_before"
grep -Fq '공개 오리진을 추가했다' "$public_fixture/origin-output"
run_generator "$public_fixture" "$public_fixture/origin-again" 49700 \
  --public-origin https://cursor.tailb1aad3.ts.net
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49700 http://127.0.0.1:49700 tauri://localhost http://tauri.localhost https://cursor.tailb1aad3.ts.net wss://cursor.tailb1aad3.ts.net' \
  "$public_fixture/infra/rust/local.secrets.env"
grep -Fq '이미 있다 (멱등)' "$public_fixture/origin-again"
test "$(grep -c 'https://cursor.tailb1aad3.ts.net' "$public_fixture/infra/rust/local.secrets.env")" -eq 2
test "$(grep -c 'wss://cursor.tailb1aad3.ts.net' "$public_fixture/infra/rust/local.secrets.env")" -eq 1
grep -Fxq 'MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=https://cursor.tailb1aad3.ts.net' \
  "$public_fixture/infra/rust/local.secrets.env"

# Create-time --public-origin lands in the first write; default localhost tokens stay.
create_public="$(make_fixture public-origin-create)"
run_generator "$create_public" "$create_public/output" 49710 \
  --local-build --public-origin https://cursor.tailb1aad3.ts.net
grep -Fxq 'MOMO_CENTRIFUGO_WS_URL=same-origin' "$create_public/infra/rust/local.secrets.env"
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49710 http://127.0.0.1:49710 tauri://localhost http://tauri.localhost https://cursor.tailb1aad3.ts.net wss://cursor.tailb1aad3.ts.net' \
  "$create_public/infra/rust/local.secrets.env"
grep -Fxq 'MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=https://cursor.tailb1aad3.ts.net' \
  "$create_public/infra/rust/local.secrets.env"

# Wildcard / path / missing env without an image mode all fail closed.
if run_generator "$(make_fixture public-origin-star)" "$TMP_ROOT/star.out" 49720 \
  --local-build --public-origin 'https://*'; then
  echo "--public-origin wildcard unexpectedly succeeded" >&2
  exit 1
fi
if run_generator "$(make_fixture public-origin-path)" "$TMP_ROOT/path.out" 49730 \
  --local-build --public-origin 'https://cursor.tailb1aad3.ts.net/connection'; then
  echo "--public-origin with a path unexpectedly succeeded" >&2
  exit 1
fi
missing_public="$(make_fixture public-origin-missing)"
if run_generator "$missing_public" "$missing_public/output" 49740 \
  --public-origin https://cursor.tailb1aad3.ts.net; then
  echo "--public-origin without an env or image mode unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'ENV_FILE 없음' "$missing_public/output" || grep -Fq '없음' "$missing_public/output"

# Existing env without --public-origin still does not rewrite allowed origins.
test "$public_before" != "$(hash_file "$public_fixture/infra/rust/local.secrets.env")"

# #1790 — claim-mode env (password key removed, MOMO_BOOTSTRAP_CLAIM=1)
# must reach the --public-origin maintenance path. --compose stays closed.
claim_fixture="$(make_fixture claim-public-origin)"
run_generator "$claim_fixture" "$claim_fixture/first-output" 49750 --local-build
claim_env="$claim_fixture/infra/rust/local.secrets.env"
awk '
  index($0, "MOMO_INITIAL_OWNER_PASSWORD=") == 1 { next }
  index($0, "MOMO_BOOTSTRAP_CLAIM=") == 1 { next }
  { print }
  END { print "MOMO_BOOTSTRAP_CLAIM=1" }
' "$claim_env" >"$claim_fixture/claim.env"
mv "$claim_fixture/claim.env" "$claim_env"
chmod 600 "$claim_env"
grep -Fxq 'MOMO_BOOTSTRAP_CLAIM=1' "$claim_env"
if awk 'index($0, "MOMO_INITIAL_OWNER_PASSWORD=") == 1 { found = 1 } END { exit !found }' "$claim_env"; then
  echo "claim surgery left a password key" >&2
  exit 1
fi
jwt_claim_before="$(sed -n 's/^JWT_HMAC=//p' "$claim_env")"
run_generator "$claim_fixture" "$claim_fixture/origin-output" 49750 \
  --public-origin https://example-tunnel.test
grep -Fxq 'CENTRIFUGO_ALLOWED_ORIGINS=http://localhost:49750 http://127.0.0.1:49750 tauri://localhost http://tauri.localhost https://example-tunnel.test wss://example-tunnel.test' \
  "$claim_env"
grep -Fxq 'MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=https://example-tunnel.test' "$claim_env"
test "$(sed -n 's/^JWT_HMAC=//p' "$claim_env")" = "$jwt_claim_before"
grep -Fq '공개 오리진을 추가했다' "$claim_fixture/origin-output"
grep -Fq 'MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL 을 공개 오리진으로 맞췄다' "$claim_fixture/origin-output"
if grep -Fq 'scripts/self_host_env.sh --compose' "$claim_fixture/origin-output"; then
  echo "claim-mode next-steps unexpectedly recommended --compose" >&2
  exit 1
fi
if grep -Fq '재시작: --compose' "$claim_fixture/origin-output"; then
  echo "claim-mode origin refresh unexpectedly recommended --compose restart" >&2
  exit 1
fi
if run_generator "$claim_fixture" "$claim_fixture/compose-output" 49750 --compose up -d; then
  echo "claim-mode --compose unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'claim 모드' "$claim_fixture/compose-output"
grep -Fq '비밀번호 키를 요구한다' "$claim_fixture/compose-output"

# Password absence without the claim marker is still malformed.
no_claim_fixture="$(make_fixture missing-password-no-claim)"
run_generator "$no_claim_fixture" "$no_claim_fixture/first-output" 49760 --local-build
awk '
  index($0, "MOMO_INITIAL_OWNER_PASSWORD=") == 1 { next }
  { print }
' "$no_claim_fixture/infra/rust/local.secrets.env" >"$no_claim_fixture/stripped.env"
mv "$no_claim_fixture/stripped.env" "$no_claim_fixture/infra/rust/local.secrets.env"
if run_generator "$no_claim_fixture" "$no_claim_fixture/origin-output" 49760 \
  --public-origin https://example-tunnel.test; then
  echo "password-less env without claim marker unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'MOMO_INITIAL_OWNER_PASSWORD 항목은 정확히 한 번 있어야 한다' \
  "$no_claim_fixture/origin-output"

echo "self-host image mode contract: PASS"

# Real docker proof is a separate script so local_gate profiles do not each
# spend ~40s on busybox stacks. Invoke explicitly:
#   scripts/tests/test_self_host_stack_collision_docker.sh
bash -n "$ROOT/scripts/tests/test_self_host_stack_collision_docker.sh"
if [ "${SELF_HOST_RUN_DOCKER_PROOF:-}" = "1" ]; then
  bash "$ROOT/scripts/tests/test_self_host_stack_collision_docker.sh"
fi
