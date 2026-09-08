#!/usr/bin/env bash
# SH-6a-e / #2215 — generator flag, compose pass-through, doctor three states.
set -euo pipefail

fail() { printf '[test-local-provider-optin] FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf '[test-local-provider-optin] PASS %s\n' "$*"; }

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

GENERATOR="$ROOT/scripts/self_host_env.sh"
COMPOSE="$ROOT/infra/rust/docker-compose.rust.yml"
OORT="$ROOT/scripts/oort"
TEMPLATE="$ROOT/scripts/tests/fixtures/oort-doctor/valid.env.template"
SMOKE="$ROOT/infra/rust/rust-smoke.env.example"

[ -f "$GENERATOR" ] || fail "scripts/self_host_env.sh missing"
[ -f "$COMPOSE" ] || fail "infra/rust/docker-compose.rust.yml missing"
[ -x "$OORT" ] || chmod +x "$OORT"
[ -f "$TEMPLATE" ] || fail "doctor fixture template missing"
command -v openssl >/dev/null 2>&1 || fail "openssl 없음"
command -v jq >/dev/null 2>&1 || fail "jq 없음"
command -v docker >/dev/null 2>&1 || fail "docker 없음"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 없음"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/oort-local-provider-optin.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

canonical_local_keys() {
  awk '
    /^oort_local_provider_env_keys\(\) \{/,/^}/ {
      while (match($0, /'\''AGENT_PROVIDER_[A-Z0-9_]+'\''/)) {
        token = substr($0, RSTART + 1, RLENGTH - 2)
        print token
        $0 = substr($0, RSTART + RLENGTH)
      }
    }
  ' "$GENERATOR" | LC_ALL=C sort
}

keys="$(canonical_local_keys)"
printf '%s\n' "$keys" | grep -Fxq 'AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK' \
  || fail "oort_local_provider_env_keys missing AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK"
printf '%s\n' "$keys" | grep -Fxq 'AGENT_PROVIDER_LOCAL_HOSTS' \
  || fail "oort_local_provider_env_keys missing AGENT_PROVIDER_LOCAL_HOSTS"
[ "$(printf '%s\n' "$keys" | grep -c .)" -eq 2 ] \
  || fail "oort_local_provider_env_keys must be exactly two keys, got:
$keys"
pass "canonical key function lists the two names"

make_fixture() {
  local name="$1"
  local fixture="$TMP/$name"
  mkdir -p "$fixture/scripts" "$fixture/infra/rust" "$fixture/fake-bin"
  cp "$GENERATOR" "$fixture/scripts/self_host_env.sh"
  cp "$COMPOSE" "$fixture/infra/rust/docker-compose.rust.yml"
  cp "$ROOT/infra/rust/docker-compose.rust.build.yml" \
    "$fixture/infra/rust/docker-compose.rust.build.yml"
  cp "$ROOT/infra/rust/local.override.yml" "$fixture/infra/rust/local.override.yml"
  cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env sh
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
      MOMO_WEB_PORT=49110 \
      MOMO_RUST_API_PORT=49111 \
      CENT_HOST_PORT=49112 \
      bash scripts/self_host_env.sh "$@"
  ) >"$output" 2>&1
}

off_fix="$(make_fixture off)"
if ! run_gen "$off_fix" "$off_fix/out" --local-build; then
  fail "generator --local-build failed:
$(cat "$off_fix/out")"
fi
off_env="$off_fix/infra/rust/local.secrets.env"
[ -f "$off_env" ] || fail "off env was not written"
if grep -E '^(AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK|AGENT_PROVIDER_LOCAL_HOSTS)=' "$off_env" >/dev/null; then
  fail "without --allow-local-provider the two keys must be absent:
$(grep -E 'AGENT_PROVIDER_' "$off_env" || true)"
fi
pass "generator without flag: two keys absent"

on_fix="$(make_fixture on)"
if ! run_gen "$on_fix" "$on_fix/out" --local-build --allow-local-provider; then
  fail "generator --allow-local-provider failed:
$(cat "$on_fix/out")"
fi
on_env="$on_fix/infra/rust/local.secrets.env"
grep -Fxq 'AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1' "$on_env" \
  || fail "flag on must write ALLOW_LOCAL_LOOPBACK=1"
grep -Fxq 'AGENT_PROVIDER_LOCAL_HOSTS=host.docker.internal' "$on_env" \
  || fail "flag on must write LOCAL_HOSTS=host.docker.internal"
pass "generator with flag: two keys present (values from canonical function)"

existing="$on_fix"
if ! run_gen "$existing" "$existing/rerun" --local-build --allow-local-provider; then
  fail "existing-env --allow-local-provider failed:
$(cat "$existing/rerun")"
fi
grep -Fxq 'AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1' "$on_env" \
  || fail "rerun must keep the two keys"
pass "existing env + flag is idempotent"

if run_gen "$(make_fixture railway-reject)" "$TMP/railway-reject.out" \
  --railway --allow-local-provider; then
  fail "--railway --allow-local-provider should fail"
fi
grep -Fq '로컬 provider' "$TMP/railway-reject.out" \
  || fail "railway+flag refusal did not name local provider:
$(cat "$TMP/railway-reject.out")"
pass "generator refuses --railway with --allow-local-provider"

# Compose config: both keys on api + agent-worker, extra_hosts on both.
RENDER="$TMP/compose.config.yml"
if ! docker compose --env-file "$SMOKE" -f "$COMPOSE" config >"$RENDER" 2>"$TMP/compose.err"; then
  fail "docker compose config failed:
$(cat "$TMP/compose.err")"
fi
python3 - "$RENDER" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
needles = [
    "AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK",
    "AGENT_PROVIDER_LOCAL_HOSTS",
    "host.docker.internal",
    "host-gateway",
]
missing = [n for n in needles if n not in text]
if missing:
    raise SystemExit("compose config missing " + ", ".join(missing))
# Count extra_hosts / host.docker.internal on api and agent-worker by
# splitting on service headings is brittle; require at least two
# host.docker.internal occurrences (api + agent-worker).
n = text.count("host.docker.internal")
if n < 2:
    raise SystemExit(f"host.docker.internal appears {n} times, want >= 2")
print("compose-config-ok")
PY
pass "docker compose config renders two keys and extra_hosts on api+agent-worker"

materialize_doctor() {
  local dest="$1"
  python3 - "$TEMPLATE" "$dest" <<'PY'
import sys
src, dest = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
repl = {
    "__TOKEN_PG__": "aa" * 12,
    "__TOKEN_APP__": "bb" * 12,
    "__TOKEN_RELAY__": "cc" * 12,
    "__TOKEN_WORKER__": "dd" * 12,
    "__TOKEN_JWT__": "ee" * 12,
    "__TOKEN_CENT_TOKEN__": "ff" * 12,
    "__TOKEN_CENT_API__": "11" * 12,
    "__TOKEN_CENT_PROXY__": "22" * 12,
    "__TOKEN_PLINK__": "33" * 12,
    "__TOKEN_OWNER__": "44" * 12,
    "__TOKEN_WEB_PORT__": "18088",
    "__TOKEN_API_PORT__": "18080",
    "__TOKEN_CENT_PORT__": "18000",
}
for k, v in repl.items():
    text = text.replace(k, v)
open(dest, "w", encoding="utf-8").write(text)
PY
  chmod 600 "$dest"
}

run_doctor_json() {
  local env="$1" out="$2"
  set +e
  "$OORT" doctor --env "$env" --json >"$out" 2>"$out.err"
  local ec=$?
  set -e
  printf '%s' "$ec"
}

check_doctor() {
  local file="$1" id="$2" field="$3"
  jq -r --arg id "$id" --arg field "$field" \
    '.checks[] | select(.id == $id) | .[$field]' "$file" | head -1
}

OFF_ENV="$TMP/doctor-off.env"
materialize_doctor "$OFF_ENV"
OFF_JSON="$TMP/doctor-off.json"
off_ec="$(run_doctor_json "$OFF_ENV" "$OFF_JSON")"
[ "$off_ec" = "0" ] || fail "doctor off exit $off_ec $(cat "$OFF_JSON.err")"
[ "$(check_doctor "$OFF_JSON" env.local_provider status)" = "pass" ] \
  || fail "off status want pass: $(check_doctor "$OFF_JSON" env.local_provider status)"
[ "$(check_doctor "$OFF_JSON" env.local_provider severity)" = "minor" ] \
  || fail "off severity want minor"
detail="$(check_doctor "$OFF_JSON" env.local_provider detail)"
printf '%s' "$detail" | grep -Fq '꺼짐' \
  || fail "off detail should say 꺼짐: $detail"
pass "doctor off = informational pass"

ON_ENV="$TMP/doctor-on.env"
materialize_doctor "$ON_ENV"
printf '\nAGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1\nAGENT_PROVIDER_LOCAL_HOSTS=host.docker.internal\n' \
  >>"$ON_ENV"
ON_JSON="$TMP/doctor-on.json"
on_ec="$(run_doctor_json "$ON_ENV" "$ON_JSON")"
[ "$on_ec" = "0" ] || fail "doctor on exit $on_ec (warn must not fail verdict) $(cat "$ON_JSON.err")"
[ "$(check_doctor "$ON_JSON" env.local_provider status)" = "pass" ] \
  || fail "on status want pass (warn)"
[ "$(check_doctor "$ON_JSON" env.local_provider severity)" = "major" ] \
  || fail "on severity want major"
detail="$(check_doctor "$ON_JSON" env.local_provider detail)"
printf '%s' "$detail" | grep -Fq '로컬 provider 허용 — 같은 머신의 provider만' \
  || fail "on detail mismatch: $detail"
pass "doctor on = warn (major pass)"

PUB_ENV="$TMP/doctor-public.env"
materialize_doctor "$PUB_ENV"
printf '\nAGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1\nAGENT_PROVIDER_LOCAL_HOSTS=host.docker.internal\nOORT_SITE_ADDRESS=app.example.test\n' \
  >>"$PUB_ENV"
PUB_JSON="$TMP/doctor-public.json"
pub_ec="$(run_doctor_json "$PUB_ENV" "$PUB_JSON")"
[ "$pub_ec" != "0" ] || fail "doctor public+flag should fail closed, exit $pub_ec"
[ "$(check_doctor "$PUB_JSON" env.local_provider status)" = "fail" ] \
  || fail "public status want fail"
[ "$(check_doctor "$PUB_JSON" env.local_provider severity)" = "major" ] \
  || fail "public severity want major"
detail="$(check_doctor "$PUB_JSON" env.local_provider detail)"
printf '%s' "$detail" | grep -Fq '공개 오리진에서 로컬 provider 허용은 권장하지 않는다' \
  || fail "public detail mismatch: $detail"
pass "doctor on + public origin = major fail"

printf '[test-local-provider-optin] all cases passed\n'
