#!/usr/bin/env bash
# #2258 — local-build overlay forwards MOMO_BUILD_SHA as a build arg only.
set -euo pipefail

fail() { printf '[test-self-host-build-sha] FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf '[test-self-host-build-sha] PASS %s\n' "$*"; }

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

GENERATOR="$ROOT/scripts/self_host_env.sh"
OVERLAY="$ROOT/infra/rust/docker-compose.rust.build.yml"
DOCKERFILE="$ROOT/server-rust/Dockerfile"
GOOD_DIGEST="ghcr.io/yeomyeonggeori/oort@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
FIXTURE_HOST="app.example.test"
FIXTURE_DB_URL="postgres://momo:fixturepass@pg.example.test:5432/momo?sslmode=require"

[ -f "$GENERATOR" ] || fail "scripts/self_host_env.sh missing"
[ -f "$OVERLAY" ] || fail "infra/rust/docker-compose.rust.build.yml missing"
[ -f "$DOCKERFILE" ] || fail "server-rust/Dockerfile missing"
command -v openssl >/dev/null 2>&1 || fail "openssl 없음"
command -v git >/dev/null 2>&1 || fail "git 없음"
command -v docker >/dev/null 2>&1 || fail "docker 없음"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 없음"
command -v python3 >/dev/null 2>&1 || fail "python3 없음"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/oort-self-host-build-sha.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

overlay_declares_arg() {
  grep -Eq '^[[:space:]]*MOMO_BUILD_SHA:[[:space:]]*\$\{MOMO_BUILD_SHA:-unknown\}[[:space:]]*$' "$1"
}

overlay_declares_arg "$OVERLAY" || fail "overlay does not declare MOMO_BUILD_SHA: \${MOMO_BUILD_SHA:-unknown}"
pass "overlay declares MOMO_BUILD_SHA build arg with unknown default"

sabotaged="$TMP/overlay.sabotaged.yml"
# Drop the args mapping. A check that still passed here would not be load-bearing.
awk '
  /^[[:space:]]*args:[[:space:]]*$/ { skip_args = 1; next }
  skip_args && /^[[:space:]]*MOMO_BUILD_SHA:/ { skip_args = 0; next }
  { print }
' "$OVERLAY" >"$sabotaged"
if overlay_declares_arg "$sabotaged"; then
  fail "sabotage (drop overlay args) still declared the build arg — check is not load-bearing"
fi
pass "sabotage drop overlay args → RED"

dockerfile_line203="$(sed -n '203p' "$DOCKERFILE")"
[ "$dockerfile_line203" = "ARG MOMO_BUILD_SHA=unknown" ] ||
  fail "Dockerfile line 203 must be ARG MOMO_BUILD_SHA=unknown, got: $dockerfile_line203"
pass "Dockerfile line 203 defaults MOMO_BUILD_SHA=unknown"

make_fixture() {
  local name="$1"
  local fixture="$TMP/$name"
  mkdir -p "$fixture/scripts" "$fixture/infra/rust" "$fixture/fake-bin"
  cp "$GENERATOR" "$fixture/scripts/self_host_env.sh"
  cp "$ROOT/infra/rust/docker-compose.rust.yml" "$fixture/infra/rust/docker-compose.rust.yml"
  cp "$OVERLAY" "$fixture/infra/rust/docker-compose.rust.build.yml"
  cp "$ROOT/infra/rust/local.override.yml" "$fixture/infra/rust/local.override.yml"
  cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env sh
if [ "${1:-}" = "compose" ]; then
  exit 0
fi
exit 0
EOF
  chmod +x "$fixture/fake-bin/docker" "$fixture/scripts/self_host_env.sh"
  printf '%s' "$fixture"
}

run_gen() {
  local fixture="$1" output="$2"
  shift 2
  (
    cd "$fixture"
    PATH="$fixture/fake-bin:$(dirname -- "$(command -v openssl)"):/usr/bin:/bin" \
      MOMO_WEB_PORT=49120 \
      MOMO_RUST_API_PORT=49121 \
      CENT_HOST_PORT=49122 \
      bash scripts/self_host_env.sh "$@"
  ) >"$output" 2>&1
}

env_build_sha() {
  awk -F= '$1 == "MOMO_BUILD_SHA" { print substr($0, index($0, "=") + 1); exit }' "$1"
}

# No .git in the fixture → unknown.
nogit="$(make_fixture nogit)"
if ! run_gen "$nogit" "$nogit/out" --local-build; then
  fail "nogit --local-build failed:
$(cat "$nogit/out")"
fi
nogit_env="$nogit/infra/rust/local.secrets.env"
[ "$(env_build_sha "$nogit_env")" = "unknown" ] ||
  fail "fixture without git must write MOMO_BUILD_SHA=unknown, got: $(env_build_sha "$nogit_env")"
pass "generator without git writes MOMO_BUILD_SHA=unknown"

# Real git checkout → 40 hex.
withgit="$(make_fixture withgit)"
(
  cd "$withgit"
  git init -q
  git -c user.email=buildsha@example.test -c user.name=buildsha \
    commit --allow-empty -m init -q
)
want_sha="$(git -C "$withgit" rev-parse HEAD)"
printf '%s' "$want_sha" | grep -Eq '^[0-9a-f]{40}$' ||
  fail "fixture HEAD is not a 40-hex SHA: $want_sha"
if ! run_gen "$withgit" "$withgit/out" --local-build; then
  fail "withgit --local-build failed:
$(cat "$withgit/out")"
fi
got_sha="$(env_build_sha "$withgit/infra/rust/local.secrets.env")"
[ "$got_sha" = "$want_sha" ] ||
  fail "generator must write git HEAD, expected=$want_sha got=$got_sha"
pass "generator with git writes MOMO_BUILD_SHA=<40 hex>"

# Existing env without the key: no backfill, --compose still runs.
legacy="$(make_fixture legacy)"
if ! run_gen "$legacy" "$legacy/out" --local-build; then
  fail "legacy create failed:
$(cat "$legacy/out")"
fi
legacy_env="$legacy/infra/rust/local.secrets.env"
awk 'index($0, "MOMO_BUILD_SHA=") != 1 { print }' "$legacy_env" >"$legacy/stripped.env"
mv "$legacy/stripped.env" "$legacy_env"
if grep -q '^MOMO_BUILD_SHA=' "$legacy_env"; then
  fail "fixture setup failed: MOMO_BUILD_SHA still present"
fi
legacy_before="$(cksum "$legacy_env")"
if ! run_gen "$legacy" "$legacy/rerun" --local-build; then
  fail "existing env without MOMO_BUILD_SHA must not force regenerate:
$(cat "$legacy/rerun")"
fi
if grep -q '^MOMO_BUILD_SHA=' "$legacy_env"; then
  fail "existing env was backfilled with MOMO_BUILD_SHA"
fi
[ "$legacy_before" = "$(cksum "$legacy_env")" ] ||
  fail "existing env without MOMO_BUILD_SHA was rewritten"
if ! run_gen "$legacy" "$legacy/compose" --compose config; then
  fail "existing env without MOMO_BUILD_SHA must still --compose:
$(cat "$legacy/compose")"
fi
pass "existing env without MOMO_BUILD_SHA is left alone (compose treats unknown)"

# Railway canonical set is the generator heredoc + public-edge keys (43).
# T2 stdout adds MOMO_SELF_HOST_PLATFORM outside the heredoc (not compared
# here). MOMO_BUILD_SHA is appended after the heredoc and must not appear.
canonical_keys() {
  {
    awk '
      /^cat >"\$ENV_FILE" <<EOF$/ { grab = 1; next }
      grab && /^EOF$/ { exit }
      grab && /^[A-Za-z_][A-Za-z0-9_]*=/ {
        key = $0
        sub(/=.*/, "", key)
        print key
      }
    ' "$GENERATOR"
    awk '
      /^oort_public_edge_env_keys\(\) \{/,/^}/ {
        while (match($0, /'\''OORT_[A-Z0-9_]+'\''/)) {
          token = substr($0, RSTART + 1, RLENGTH - 2)
          print token
          $0 = substr($0, RSTART + RLENGTH)
        }
      }
    ' "$GENERATOR"
  } | LC_ALL=C sort -u
}

railway_out="$TMP/railway.env"
set +e
env \
  RAILWAY_PUBLIC_DOMAIN="$FIXTURE_HOST" \
  DATABASE_URL="$FIXTURE_DB_URL" \
  MOMO_RUST_IMAGE="$GOOD_DIGEST" \
  "$GENERATOR" --railway >"$railway_out" 2>"$railway_out.err"
railway_ec=$?
set -e
[ "$railway_ec" = "0" ] || {
  cat "$railway_out.err" >&2
  fail "--railway fixture failed exit=$railway_ec"
}
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 }' "$railway_out" | LC_ALL=C sort -u >"$TMP/railway.keys"
canonical_keys >"$TMP/canonical.keys"
grep -Fxv 'MOMO_SELF_HOST_PLATFORM' "$TMP/railway.keys" >"$TMP/railway.canonical.keys"
if grep -Fxq 'MOMO_BUILD_SHA' "$TMP/canonical.keys" "$TMP/railway.keys"; then
  fail "MOMO_BUILD_SHA leaked into Railway canonical/output key set"
fi
grep -Fxq 'MOMO_SELF_HOST_PLATFORM' "$TMP/railway.keys" || \
  fail "T2 stdout missing MOMO_SELF_HOST_PLATFORM stamp"
if ! diff -u "$TMP/canonical.keys" "$TMP/railway.canonical.keys" >"$TMP/keys.diff"; then
  cat "$TMP/keys.diff" >&2
  fail "Railway key-set diff not empty"
fi
key_count="$(grep -c . "$TMP/canonical.keys" | tr -d ' ')"
[ "$key_count" = "43" ] || fail "Railway canonical key set must stay 43, got $key_count"
pass "Railway canonical key set unchanged (43, no MOMO_BUILD_SHA; stamp outside)"

# Compose interpolation: build.args only, never service environment.
local_fix="$(make_fixture compose-local)"
if ! run_gen "$local_fix" "$local_fix/out" --local-build; then
  fail "compose-local --local-build failed:
$(cat "$local_fix/out")"
fi
expect_sha="$(env_build_sha "$local_fix/infra/rust/local.secrets.env")"
real_docker_dir="$(dirname -- "$(command -v docker)")"
real_config="$local_fix/compose.json"
(
  cd "$local_fix"
  PATH="$real_docker_dir:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose config --format json
) >"$real_config" 2>"$local_fix/compose.stderr"

python3 - "$real_config" "$expect_sha" <<'PY'
import json, sys
path, expect = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
services = cfg.get("services") or {}
seen_build = 0
for name, svc in services.items():
    env = svc.get("environment") or {}
    if "MOMO_BUILD_SHA" in env:
        raise SystemExit("MOMO_BUILD_SHA leaked into %s environment" % name)
    build = svc.get("build")
    if not build:
        continue
    args = build.get("args") or {}
    if isinstance(args, list):
        parsed = {}
        for item in args:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                parsed[key] = value
        args = parsed
    sha = args.get("MOMO_BUILD_SHA")
    if sha != expect:
        raise SystemExit("%s build.args.MOMO_BUILD_SHA expected=%s got=%s" % (name, expect, sha))
    seen_build += 1
if seen_build < 1:
    raise SystemExit("no service declared a build with MOMO_BUILD_SHA")
print("services_with_build_arg", seen_build)
PY
pass "compose config: MOMO_BUILD_SHA is a build arg only (not container env)"

# Missing key on an existing env interpolates to unknown, still not container env.
legacy_cfg="$legacy/compose.json"
(
  cd "$legacy"
  PATH="$real_docker_dir:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose config --format json
) >"$legacy_cfg" 2>"$legacy/compose-real.stderr"
python3 - "$legacy_cfg" unknown <<'PY'
import json, sys
path, expect = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
for name, svc in (cfg.get("services") or {}).items():
    env = svc.get("environment") or {}
    if "MOMO_BUILD_SHA" in env:
        raise SystemExit("missing-key env leaked MOMO_BUILD_SHA into %s" % name)
    build = svc.get("build")
    if not build:
        continue
    args = build.get("args") or {}
    if isinstance(args, list):
        parsed = {}
        for item in args:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                parsed[key] = value
        args = parsed
    sha = args.get("MOMO_BUILD_SHA")
    if sha != expect:
        raise SystemExit("%s missing-key interpolation expected=%s got=%s" % (name, expect, sha))
print("ok")
PY
pass "existing env without key interpolates build arg unknown"
