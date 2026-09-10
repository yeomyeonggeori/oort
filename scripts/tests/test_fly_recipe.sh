#!/usr/bin/env bash
# SH-11b / ADR-0184 D1 — Fly.io T1 recipe static contract.
# Mounts, always-on Machine, RAM ≥ 2 GiB, public ports {80,443} only,
# zero digest literals, README script refs, entrypoint data-root under /data.
# Sabotages: no mounts → RED; auto_stop_machines=true → RED; data-root
# outside /data → RED.
set -euo pipefail

fail() {
  printf '[test-fly-recipe] FAIL %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[test-fly-recipe] PASS %s\n' "$*"
}

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

FLY_DIR="$ROOT/infra/fly"
FLY_TOML="$FLY_DIR/fly.toml"
DOCKERFILE="$FLY_DIR/Dockerfile.host"
ENTRYPOINT="$FLY_DIR/entrypoint.sh"
README="$FLY_DIR/README.md"

command -v python3 >/dev/null 2>&1 || fail "python3 없음"
[ -f "$FLY_TOML" ] || fail "infra/fly/fly.toml missing"
[ -f "$DOCKERFILE" ] || fail "infra/fly/Dockerfile.host missing"
[ -f "$ENTRYPOINT" ] || fail "infra/fly/entrypoint.sh missing"
[ -f "$README" ] || fail "infra/fly/README.md missing"
[ -x "$ENTRYPOINT" ] || fail "infra/fly/entrypoint.sh is not executable"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-fly-recipe.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

# ---------------------------------------------------------------------------
# Shared python assertions. Exit 0 = contract holds; print FAIL lines otherwise.
# argv: fly.toml [entrypoint]
# ---------------------------------------------------------------------------
run_toml_contract() {
  python3 - "$1" <<'PY'
import sys
import tomllib
from pathlib import Path

path = Path(sys.argv[1])
data = tomllib.loads(path.read_text(encoding="utf-8"))
errors = []

def off(value):
    return value is False or value == "off"

mounts = data.get("mounts")
dests = []
if isinstance(mounts, dict):
    dests = [mounts.get("destination")]
elif isinstance(mounts, list):
    dests = [m.get("destination") for m in mounts if isinstance(m, dict)]
else:
    errors.append("mounts missing")
if "/data" not in dests:
    errors.append("mounts destination is not /data (got %r)" % dests)

auto_stop = []
auto_start = []
min_running = []
http_service = data.get("http_service")
if isinstance(http_service, dict):
    if "auto_stop_machines" in http_service:
        auto_stop.append(http_service["auto_stop_machines"])
    if "auto_start_machines" in http_service:
        auto_start.append(http_service["auto_start_machines"])
    if "min_machines_running" in http_service:
        min_running.append(http_service["min_machines_running"])

services = data.get("services") or []
if not isinstance(services, list) or not services:
    errors.append("[[services]] missing")
for svc in services:
    if not isinstance(svc, dict):
        continue
    if "auto_stop_machines" in svc:
        auto_stop.append(svc["auto_stop_machines"])
    if "auto_start_machines" in svc:
        auto_start.append(svc["auto_start_machines"])
    if "min_machines_running" in svc:
        min_running.append(svc["min_machines_running"])

if not auto_stop:
    errors.append("auto_stop_machines missing")
elif any(not off(v) for v in auto_stop):
    errors.append("auto_stop_machines is not false/off (got %r)" % auto_stop)
if not auto_start:
    errors.append("auto_start_machines missing")
elif any(v is not False for v in auto_start):
    errors.append("auto_start_machines is not false (got %r)" % auto_start)
if not min_running:
    errors.append("min_machines_running missing")
elif any(int(v) < 1 for v in min_running):
    errors.append("min_machines_running < 1 (got %r)" % min_running)

def memory_mb(vm):
    if not isinstance(vm, dict):
        return 0
    mb = 0
    if "memory_mb" in vm:
        try:
            mb = max(mb, int(vm["memory_mb"]))
        except (TypeError, ValueError):
            pass
    mem = vm.get("memory")
    if isinstance(mem, (int, float)):
        mb = max(mb, int(mem))
    elif isinstance(mem, str):
        s = mem.strip().lower().replace(" ", "")
        num = ""
        for ch in s:
            if ch.isdigit() or ch == ".":
                num += ch
            else:
                break
        try:
            n = float(num) if num else 0.0
        except ValueError:
            n = 0.0
        if s.endswith("gb") or s.endswith("gib") or s.endswith("gi"):
            mb = max(mb, int(n * 1024))
        elif s.endswith("mb") or s.endswith("mib") or s.endswith("mi"):
            mb = max(mb, int(n))
    return mb

vms = data.get("vm")
if isinstance(vms, dict):
    vms = [vms]
ram = 0
for vm in vms or []:
    ram = max(ram, memory_mb(vm))
if ram < 2048:
    errors.append("RAM < 2048 MiB (got %s)" % ram)

ports = set()
for svc in services:
    if not isinstance(svc, dict):
        continue
    for p in svc.get("ports") or []:
        if isinstance(p, dict) and "port" in p:
            try:
                ports.add(int(p["port"]))
            except (TypeError, ValueError):
                errors.append("non-integer service port %r" % p.get("port"))
if ports != {80, 443}:
    errors.append("public ports must be exactly {80, 443} (got %r)" % sorted(ports))

passthrough = False
http80 = False
for svc in services:
    if not isinstance(svc, dict):
        continue
    for p in svc.get("ports") or []:
        if not isinstance(p, dict):
            continue
        try:
            port = int(p["port"])
        except (TypeError, ValueError):
            continue
        handlers = p.get("handlers") or []
        if port == 443 and handlers == []:
            passthrough = True
        if port == 80 and "http" in handlers:
            http80 = True
if not passthrough:
    errors.append("443 handlers must be [] (TLS passthrough)")
if not http80:
    errors.append("80 handlers must include http")

if errors:
    for e in errors:
        print("FAIL", e)
    sys.exit(1)
print("ok mounts=/data ram=%s ports=%s auto_stop=%s" % (ram, sorted(ports), auto_stop))
PY
}

run_data_root_contract() {
  python3 - "$1" <<'PY'
import re, sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
errors = []
assigns = {}
for m in re.finditer(
    r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$',
    text,
    re.M,
):
    raw = m.group(2).strip().strip('"').strip("'")
    assigns[m.group(1)] = raw

def resolve(token):
    token = token.strip().strip('"').strip("'")
    inner = re.fullmatch(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", token)
    if inner:
        return assigns.get(inner.group(1), token)
    inner = re.fullmatch(r"\$([A-Za-z_][A-Za-z0-9_]*)", token)
    if inner:
        return assigns.get(inner.group(1), token)
    return token

found = []
for rx in (
    r"--data-root(?:=|\s+)(\S+)",
    r"DOCKER_DATA_ROOT=(\S+)",
):
    for m in re.finditer(rx, text):
        found.append(resolve(m.group(1)))
found = [p for p in found if p]
if not found:
    errors.append("no docker data-root under /data (missing --data-root / DOCKER_DATA_ROOT)")
for path in found:
    if path != "/data" and not path.startswith("/data/"):
        errors.append("docker data-root is outside /data: %s" % path)
if errors:
    for e in errors:
        print("FAIL", e)
    sys.exit(1)
print("ok data-root", " ".join(found))
PY
}

# ---------------------------------------------------------------------------
# ①–④ fly.toml contract
# ---------------------------------------------------------------------------
toml_out="$TMP_ROOT/toml.out"
set +e
run_toml_contract "$FLY_TOML" >"$toml_out" 2>"$TMP_ROOT/toml.err"
toml_ec=$?
set -e
[ "$toml_ec" -eq 0 ] || {
  cat "$toml_out" >&2
  cat "$TMP_ROOT/toml.err" >&2
  fail "fly.toml contract"
}
pass "fly.toml mounts=/data always-on RAM ports $(tr '\n' ' ' <"$toml_out")"

# ---------------------------------------------------------------------------
# ⑤ no digest literals in fly.toml / Dockerfile.host
# ---------------------------------------------------------------------------
if grep -F -n 'sha256:' "$FLY_TOML" "$DOCKERFILE"; then
  fail "sha256: literal in fly.toml or Dockerfile.host (pin is a latest.json command)"
fi
pass "no sha256: literal in fly.toml or Dockerfile.host"

# ---------------------------------------------------------------------------
# Dockerfile.host tool set (Local prerequisites)
# ---------------------------------------------------------------------------
for tok in docker-ce git jq openssl curl; do
  grep -Fq "$tok" "$DOCKERFILE" || fail "Dockerfile.host missing $tok"
done
grep -Eq 'docker-compose-plugin|compose-plugin|docker compose' "$DOCKERFILE" \
  || fail "Dockerfile.host missing Compose v2 package"
grep -Eq 'debian|ubuntu' "$DOCKERFILE" || fail "Dockerfile.host is not Debian/Ubuntu based"
pass "Dockerfile.host Debian/Ubuntu + docker-ce + compose v2 + git + jq + openssl + curl"

# ---------------------------------------------------------------------------
# ⑥ README scripts/… refs exist
# ---------------------------------------------------------------------------
python3 - "$README" "$ROOT" <<'PY' || fail "README scripts/ refs"
import re, sys
from pathlib import Path
readme, root = Path(sys.argv[1]), Path(sys.argv[2])
text = readme.read_text(encoding="utf-8")
refs = sorted(set(re.findall(r"scripts/[A-Za-z0-9_./-]+", text)))
if not refs:
    print("FAIL README has no scripts/ references", file=sys.stderr)
    sys.exit(1)
missing = [r for r in refs if not (root / r).exists()]
if missing:
    print("FAIL missing", " ".join(missing), file=sys.stderr)
    sys.exit(1)
print("ok", len(refs), " ".join(refs))
PY
pass "README scripts/ references exist"

# ---------------------------------------------------------------------------
# ⑦ entrypoint bash -n + shellcheck; data-root under /data
# ---------------------------------------------------------------------------
bash -n "$ENTRYPOINT" || fail "entrypoint.sh bash -n"
pass "entrypoint.sh bash -n"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck --shell=bash --severity=warning "$ENTRYPOINT" \
    || fail "entrypoint.sh shellcheck"
  pass "entrypoint.sh shellcheck"
else
  pass "entrypoint.sh shellcheck skipped (not installed; bash -n held)"
fi

dr_out="$TMP_ROOT/dataroot.out"
set +e
run_data_root_contract "$ENTRYPOINT" >"$dr_out" 2>"$TMP_ROOT/dataroot.err"
dr_ec=$?
set -e
[ "$dr_ec" -eq 0 ] || {
  cat "$dr_out" >&2
  cat "$TMP_ROOT/dataroot.err" >&2
  fail "entrypoint data-root contract"
}
pass "entrypoint docker data-root under /data ($(tr '\n' ' ' <"$dr_out"))"

# Secrets never in this tree
if find "$FLY_DIR" -type f \( -name '*.env' -o -name '*.secrets.env' -o -name '.env' \) | grep -q .; then
  fail "secret env file under infra/fly/"
fi
pass "no env/secret files under infra/fly/"

# ---------------------------------------------------------------------------
# Sabotage ① — remove mounts → RED
# ---------------------------------------------------------------------------
python3 - "$FLY_TOML" "$TMP_ROOT/no-mounts.toml" <<'PY'
from pathlib import Path
import sys
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
text = src.read_text(encoding="utf-8")
out, skip = [], False
for line in text.splitlines(True):
    stripped = line.strip()
    if stripped.startswith("[[mounts]]") or stripped == "[mounts]":
        skip = True
        continue
    if skip:
        if stripped.startswith("[") and "mounts" not in stripped.split("]", 1)[0].lower():
            skip = False
            out.append(line)
        continue
    out.append(line)
dst.write_text("".join(out), encoding="utf-8")
PY
set +e
run_toml_contract "$TMP_ROOT/no-mounts.toml" >"$TMP_ROOT/no-mounts.out" 2>"$TMP_ROOT/no-mounts.err"
sab1=$?
set -e
[ "$sab1" -ne 0 ] || fail "sabotage remove mounts still PASS — mounts check is not load-bearing"
grep -Eq 'mounts|destination' "$TMP_ROOT/no-mounts.out" "$TMP_ROOT/no-mounts.err" \
  || fail "sabotage remove mounts did not name mounts"
pass "sabotage remove [mounts] → RED"

# ---------------------------------------------------------------------------
# Sabotage ② — auto_stop_machines = true → RED
# ---------------------------------------------------------------------------
python3 - "$FLY_TOML" "$TMP_ROOT/autostop-true.toml" <<'PY'
from pathlib import Path
import sys
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
text = src.read_text(encoding="utf-8")
text = text.replace("auto_stop_machines = false", "auto_stop_machines = true")
if "auto_stop_machines = true" not in text:
    raise SystemExit("could not sabotage auto_stop_machines")
dst.write_text(text, encoding="utf-8")
PY
set +e
run_toml_contract "$TMP_ROOT/autostop-true.toml" >"$TMP_ROOT/autostop.out" 2>"$TMP_ROOT/autostop.err"
sab2=$?
set -e
[ "$sab2" -ne 0 ] || fail "sabotage auto_stop_machines=true still PASS — always-on check is not load-bearing"
grep -Fq 'auto_stop_machines' "$TMP_ROOT/autostop.out" "$TMP_ROOT/autostop.err" \
  || fail "sabotage auto_stop did not name auto_stop_machines"
pass "sabotage auto_stop_machines = true → RED"

# ---------------------------------------------------------------------------
# Sabotage ③ — data-root outside /data → RED
# ---------------------------------------------------------------------------
python3 - "$ENTRYPOINT" "$TMP_ROOT/entrypoint-root.sh" <<'PY'
from pathlib import Path
import sys
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
text = src.read_text(encoding="utf-8")
old, new = "/data/docker", "/var/lib/docker"
if old not in text:
    raise SystemExit("could not locate /data/docker to sabotage")
dst.write_text(text.replace(old, new), encoding="utf-8")
PY
set +e
run_data_root_contract "$TMP_ROOT/entrypoint-root.sh" >"$TMP_ROOT/root.out" 2>"$TMP_ROOT/root.err"
sab3=$?
set -e
[ "$sab3" -ne 0 ] || fail "sabotage data-root /var/lib/docker still PASS — persist check is not load-bearing"
grep -Eq 'outside /data|/var/lib/docker' "$TMP_ROOT/root.out" "$TMP_ROOT/root.err" \
  || fail "sabotage data-root did not name the path"
pass "sabotage docker data-root outside /data → RED"

printf '[test-fly-recipe] PASS complete\n'
