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
grep -Fq '@sha256:<64 lowercase hex>' "$injection_fixture/output"

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
grep -Fq '공백 없는 소문자 OCI tag' "$local_injection_fixture/output"

# The historical no-argument command remains a local-build alias.
legacy_fixture="$(make_fixture legacy)"
run_generator "$legacy_fixture" "$legacy_fixture/output" 49400
grep -Fxq 'MOMO_SELF_HOST_MODE=local-build' "$legacy_fixture/infra/rust/local.secrets.env"
grep -Fq -- 'up -d --build --wait' "$legacy_fixture/output"

echo "self-host image mode contract: PASS"
