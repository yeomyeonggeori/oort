#!/usr/bin/env bash
# Behavioral contract for #1266's mutually exclusive self-host image modes.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-self-host-modes.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

GOOD_DIGEST="ghcr.io/yeomyeonggeori/oort@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

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

  cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env sh
# Model the Compose precedence that caused #1331's review finding: process env
# wins over --env-file. The generator must remove that ambient override before
# asking for the rendered application images.
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
test "$(file_mode "$local_fixture/infra/rust/local.secrets.env")" = "600"
grep -Fq 'infra/rust/docker-compose.rust.build.yml' "$local_output"
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
grep -Fq -- 'up -d --pull missing --wait' "$published_output"
if grep -Fq 'infra/rust/docker-compose.rust.build.yml' "$published_output"; then
  echo "published-digest output unexpectedly contains the build overlay" >&2
  exit 1
fi
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

# Ambient Compose interpolation must not replace the env-file digest.
override_fixture="$(make_fixture ambient-image-override)"
(
  export MOMO_RUST_IMAGE=busybox:latest
  run_generator "$override_fixture" "$override_fixture/output" 49250 \
    --published-image "$GOOD_DIGEST"
)
grep -Fxq "MOMO_RUST_IMAGE=$GOOD_DIGEST" "$override_fixture/infra/rust/local.secrets.env"
grep -Fq 'env -u MOMO_RUST_IMAGE docker compose' "$override_fixture/output"

# Compose itself, not a string fixture, must resolve all seven application
# consumers to the exact digest and no process-env override.
real_env="$TMP_ROOT/real-compose.env"
awk -v image="$GOOD_DIGEST" '
  /^MOMO_RUST_IMAGE=/ { print "MOMO_RUST_IMAGE=" image; next }
  { print }
' "$ROOT/infra/rust/rust-smoke.env.example" >"$real_env"
real_images="$(
  env -u MOMO_RUST_IMAGE docker compose \
    --project-directory "$ROOT" \
    --env-file "$real_env" \
    -f "$ROOT/infra/rust/docker-compose.rust.yml" \
    -f "$ROOT/infra/rust/local.override.yml" \
    config --images
)"
real_count="$(printf '%s\n' "$real_images" | awk -v expected="$GOOD_DIGEST" '
  $0 == expected { count += 1 }
  END { print count + 0 }
')"
test "$real_count" -eq 7

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

# The historical no-argument command remains a local-build alias.
legacy_fixture="$(make_fixture legacy)"
run_generator "$legacy_fixture" "$legacy_fixture/output" 49400
grep -Fxq 'MOMO_SELF_HOST_MODE=local-build' "$legacy_fixture/infra/rust/local.secrets.env"
grep -Fq -- 'up -d --build --wait' "$legacy_fixture/output"

echo "self-host image mode contract: PASS"
