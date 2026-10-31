#!/usr/bin/env bash
# In-image proof of the oort image guard (#4820 security review; ADR-0203 I2): the REAL lockgate.py, the REAL plugin and
# the REAL Hermes dispatch path inside the pinned Hermes image, with NO network (`--network none`).
#
#   scripts/tests/test_hermes_image_guard_docker.sh [output-dir]
#
# Needs Docker and the pinned image (compose `hermes`; a pull happens only if it is not local). Nothing is published and
# nothing is mounted writable: infra/hermes is bind-mounted read-only at /oort, /opt/data is the container's own volume
# (removed with `--rm`). What it proves, scenario by scenario (python helper: fixtures/hermes_image_guard_inimage.py):
#   healthy ................ the shipped files pass: files verified, the plugin is loaded and enabled by Hermes itself,
#                            every refused canary example is blocked before the tool runs, every accepted one reaches it
#   no-plugin / edited ..... a missing or edited guard is refused before Hermes listens
#   widened-plugin ......... a guard that also lets https:// through, with its hash patched into the gate, is refused by
#                            the canary alone (the verdict comes from behavior, not from the hash)
#   not-enabled ............ plugins.enabled missing: the plugin is not loaded and the canary says so
#   safe-mode .............. HERMES_SAFE_MODE=1 makes real Hermes skip every plugin: refused
#   proxy / private / BOM .. the SSRF switches, in the environment, in config and in a BOM-prefixed volume .env; two marks in front
#                            with a line the loader's clean-up rewrites (bom-env-file-double: Hermes drops both marks, the gate must
#                            refuse) and two marks with nothing to rewrite (bom-env-file-kept: Hermes keeps one in the name and applies
#                            nothing, the gate must not refuse) (#4886 review)
#   self-origin ............ the owner's 10-30 exception (#4820 C2a): OORT_SELF_MEDIA_ORIGIN set to a canonical origin boots,
#                            and the canary accepts the one allowed address and refuses its 28 bypass variants through the
#                            real Hermes dispatch path; unset keeps the exception off and adds one refused example
#   self-origin-bad / -env-file  a non-canonical origin, and the variable in the volume's .env, are refused before listening
#   prefix-only-plugin ..... the exception weakened to a bare prefix comparison, its hash patched into the gate: refused by
#                            the canary alone (the same shape of proof as widened-plugin)
#   compose-start / railway-start  the real start command text (compose and railway.json) runs to the point where it would
#                            exec Hermes, with an edited guard variable stopping it before any gate output; the strict media
#                            flag is passed exactly as the SHIPPED template carries it, and without it the same command is
#                            refused by the gate before it would exec Hermes (#4820 C2b 3부)
#   strict-missing / -wrong / -env-file  HERMES_MEDIA_DELIVERY_STRICT absent, `true` (strict to Hermes itself, but the gate
#                            takes one spelling) or present in the volume's .env: refused before listening
#   media-policy ........... the premise, measured with Hermes' own validate_media_delivery_path: strict keeps an old file
#                            outside Hermes' cache dirs from being delivered (`true` too), unset delivers it
#   env-shapes / env-inert-shapes  (#4886) the volume's .env read like Hermes' loader, by the REAL gate with this image's own
#                            python-dotenv: an inline comment, `export<TAB>`, a single-quoted name and a quoted value + comment are refused;
#                            a comment, an unterminated quote, a name with no value and the like are not. The judge does not take the
#                            author's word for which are which: the same bytes go through THIS image's real `hermes_cli.env_loader`, and the
#                            names it applies must be exactly the ones the shapes are said to apply and all be named by the gate
#   env-reference-shapes ... a judged name given `${...}` (a variable only Hermes' service slot has, HOME, an unset name with a default):
#                            refused for the reference itself, whatever the real loader ends with (#4886 review)
#   env-loader-oracle ...... the gate's reading against the REAL loader on the whole named table and 4000 seeded random inputs
#                            (infra/hermes/env_loader_oracle.py): the loader runs on a copy in the service slot's environment; the names it
#                            ends with a forbidden value for must all be named by the gate (also for the file as the loader leaves it),
#                            a refusal beyond them needs a designed reason, and the judge demands thresholds so an empty comparison fails
#   hermes-home-other ...... a HERMES_HOME that names another folder than the one the gate reads is refused (the image sets /opt/data)
#   env-parser-parity ...... the input table and rule tables of infra/hermes/test_lockgate_env.py (and the two test files that
#                            changed with it), run by this image's python with python-dotenv: the fallback parser and the real one
#                            reproduce every row, and nothing may be skipped (OORT_REQUIRE_DOTENV=1)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/infra/rust/docker-compose.rust.yml"
IMG="$(grep -o 'nousresearch/hermes-agent@sha256:[0-9a-f]*' "$COMPOSE" | head -1)"
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/hermes-image-guard.XXXXXX")}"
KEY="$(python3 -c 'print("fixture-api-key-" * 3)')"
# python-dotenv in the pinned Hermes image: the uv.lock of Hermes v0.22.2 (the image's source) pins 1.2.2, and the input table of
# infra/hermes/test_lockgate_env.py was measured on it. Moving the image to another version means measuring that table again.
EXPECTED_DOTENV="1.2.2"
fail() { echo "[hermes-image-guard] FAIL: $*" >&2; exit 1; }
say() { echo "[hermes-image-guard] $*"; }

command -v docker >/dev/null 2>&1 || fail "docker not found"
[ -n "$IMG" ] || fail "no pinned Hermes image in $COMPOSE"
mkdir -p "$OUT"
say "image $IMG ; output $OUT"

docker_run() {  # docker_run <extra docker args...> -- <command...>
  local extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  docker run --rm --network none --memory 2g -e "API_SERVER_KEY=$KEY" \
    -v "$ROOT/infra/hermes:/oort:ro" -v "$ROOT/scripts/tests/fixtures:/fx:ro" "${extra[@]}" "$IMG" "$@"
}

scenario() {  # scenario <name> -> $OUT/<name>.json (the RESULT line)
  local name="$1"
  say "scenario $name"
  docker_run --entrypoint /opt/hermes/.venv/bin/python -- /fx/hermes_image_guard_inimage.py "$name" >"$OUT/$name.stdout" 2>"$OUT/$name.stderr" || true
  grep '^RESULT ' "$OUT/$name.stdout" | sed 's/^RESULT //' >"$OUT/$name.json" || true
  [ -s "$OUT/$name.json" ] || { tail -n 20 "$OUT/$name.stderr" >&2; fail "scenario $name printed no RESULT"; }
}

for name in healthy no-plugin edited-plugin widened-plugin not-enabled extra-image-gen-key security-private-urls \
  safe-mode proxy-env private-env bom-env-file bom-env-file-double bom-env-file-kept clean-env-file self-origin self-origin-bad \
  self-origin-env-file prefix-only-plugin strict-missing strict-wrong strict-env-file media-policy env-shapes env-inert-shapes \
  env-reference-shapes hermes-home-other env-parser-parity env-loader-oracle; do
  scenario "$name"
done

# --- the real start commands, cut where they would exec Hermes ------------------------------------------------------------
python3 - "$ROOT" "$OUT" <<'PY'
import json, re, sys
root, out = sys.argv[1], sys.argv[2]
railway = json.load(open(root + "/infra/railway/railway.json"))["services"]["hermes"]["startCommand"]
m = re.fullmatch(r"/bin/sh -c '(.*)'", railway, re.S)
assert m, "unexpected railway start command shape"
cut = " /opt/hermes/.venv/bin/python /tmp/lockgate.py report & exec /opt/hermes/docker/entrypoint-dispatch.sh gateway run"
script = m.group(1)
assert script.endswith(cut.strip()), "railway start command tail changed"
open(out + "/railway-start.sh", "w").write(script[: -len(cut.strip())] + "echo START_COMMAND_REACHED_EXEC")
text = open(root + "/infra/rust/docker-compose.rust.yml").read()
line = re.search(r"(?m)^      - (set -eu; umask 022; mkdir -p /opt/data/plugins/oort-image-guard;.*)$", text)
assert line, "compose hermes command not found"
command = line.group(1).replace("$$", "$")
head = command[: command.index("; [ -z ")]
open(out + "/compose-start.sh", "w").write(head + "; echo START_COMMAND_REACHED_EXEC")
open(out + "/compose-full.sh", "w").write(command)
PY

b64() { base64 < "$1" | tr -d '\n'; }
export HERMES_CONFIG_B64 HERMES_LOCKGATE_B64 HERMES_IMAGE_GUARD_B64 HERMES_IMAGE_GUARD_MANIFEST_B64
HERMES_CONFIG_B64="$(b64 "$ROOT/infra/hermes/config.yaml")"
HERMES_LOCKGATE_B64="$(b64 "$ROOT/infra/hermes/lockgate.py")"
HERMES_IMAGE_GUARD_B64="$(b64 "$ROOT/infra/hermes/plugins/oort-image-guard/__init__.py")"
HERMES_IMAGE_GUARD_MANIFEST_B64="$(b64 "$ROOT/infra/hermes/plugins/oort-image-guard/plugin.yaml")"

# The strict media flag exactly as the shipped templates carry it (empty when a template lost it, which the gate then refuses).
STRICT_RAILWAY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["services"]["hermes"]["variables"].get("HERMES_MEDIA_DELIVERY_STRICT", ""))' "$ROOT/infra/railway/railway.json")"
STRICT_COMPOSE="$(python3 - "$COMPOSE" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r'(?m)^      HERMES_MEDIA_DELIVERY_STRICT: (?:"?\$\{HERMES_MEDIA_DELIVERY_STRICT:-([^}"]*)\}"?|"?([^"\s]*)"?)\s*$', text)
print((m.group(1) if m and m.group(1) is not None else (m.group(2) if m else "")) or "")
PY
)"
say "shipped strict flag: railway=[$STRICT_RAILWAY] compose=[$STRICT_COMPOSE]"

say "scenario compose-start"
docker_run --entrypoint /bin/sh -e "HERMES_MEDIA_DELIVERY_STRICT=$STRICT_COMPOSE" -- -c "$(cat "$OUT/compose-start.sh")" >"$OUT/compose-start.stdout" 2>"$OUT/compose-start.stderr" && echo 0 >"$OUT/compose-start.rc" || echo $? >"$OUT/compose-start.rc"

say "scenario compose-start-no-strict (the same command without the flag must be refused by the gate before it would exec Hermes)"
docker_run --entrypoint /bin/sh -- -c "$(cat "$OUT/compose-start.sh")" >"$OUT/compose-start-nostrict.stdout" 2>"$OUT/compose-start-nostrict.stderr" && echo 0 >"$OUT/compose-start-nostrict.rc" || echo $? >"$OUT/compose-start-nostrict.rc"

say "scenario railway-start"
docker_run --entrypoint /bin/sh -e HERMES_CONFIG_B64 -e HERMES_LOCKGATE_B64 -e HERMES_IMAGE_GUARD_B64 -e HERMES_IMAGE_GUARD_MANIFEST_B64 \
  -e "HERMES_MEDIA_DELIVERY_STRICT=$STRICT_RAILWAY" \
  -- -c "$(cat "$OUT/railway-start.sh")" >"$OUT/railway-start.stdout" 2>"$OUT/railway-start.stderr" && echo 0 >"$OUT/railway-start.rc" || echo $? >"$OUT/railway-start.rc"

say "scenario railway-start-no-strict (every checksum passes, the flag is missing: the gate must refuse before it would exec Hermes)"
docker_run --entrypoint /bin/sh -e HERMES_CONFIG_B64 -e HERMES_LOCKGATE_B64 -e HERMES_IMAGE_GUARD_B64 -e HERMES_IMAGE_GUARD_MANIFEST_B64 \
  -- -c "$(cat "$OUT/railway-start.sh")" >"$OUT/railway-start-nostrict.stdout" 2>"$OUT/railway-start-nostrict.stderr" && echo 0 >"$OUT/railway-start-nostrict.rc" || echo $? >"$OUT/railway-start-nostrict.rc"

say "scenario railway-start-edited-guard (a swapped variable must stop the command before the gate prints anything)"
EDITED="$(python3 -c 'import base64, os; print(base64.b64encode(base64.b64decode(os.environ["HERMES_IMAGE_GUARD_B64"]) + b"\n# edited\n").decode())')"
docker_run --entrypoint /bin/sh -e HERMES_CONFIG_B64 -e HERMES_LOCKGATE_B64 -e "HERMES_IMAGE_GUARD_B64=$EDITED" -e HERMES_IMAGE_GUARD_MANIFEST_B64 \
  -- -c "$(cat "$OUT/railway-start.sh")" >"$OUT/railway-start-edited.stdout" 2>"$OUT/railway-start-edited.stderr" && echo 0 >"$OUT/railway-start-edited.rc" || echo $? >"$OUT/railway-start-edited.rc"

say "scenario railway-start-guard-variable-missing"
docker_run --entrypoint /bin/sh -e HERMES_CONFIG_B64 -e HERMES_LOCKGATE_B64 -e HERMES_IMAGE_GUARD_MANIFEST_B64 \
  -- -c "$(cat "$OUT/railway-start.sh")" >"$OUT/railway-start-missing.stdout" 2>"$OUT/railway-start-missing.stderr" && echo 0 >"$OUT/railway-start-missing.rc" || echo $? >"$OUT/railway-start-missing.rc"

# --- the real gateway: compose command in full (gate, report, s6 init, gateway) with no network ---------------------------
say "scenario gateway-boot (real gateway + real lockgate report, no network)"
NAME="oort-guardproof-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$NAME" --network none --memory 2g -e "API_SERVER_KEY=$KEY" -e API_SERVER_ENABLED=true \
  -e OORT_SELF_MEDIA_ORIGIN=https://oort.example.com -e "HERMES_MEDIA_DELIVERY_STRICT=$STRICT_COMPOSE" \
  -e API_SERVER_HOST=0.0.0.0 -e API_SERVER_PORT=8642 -v "$ROOT/infra/hermes:/oort:ro" -v "$ROOT/scripts/tests/fixtures:/fx:ro" \
  --entrypoint /bin/sh "$IMG" -c "$(cat "$OUT/compose-full.sh")" >"$OUT/gateway-boot.id"
healthy=0
for _ in $(seq 1 80); do
  if docker exec "$NAME" /opt/hermes/.venv/bin/python -c 'import urllib.request;urllib.request.urlopen("http://127.0.0.1:8642/health",timeout=3)' >/dev/null 2>&1; then healthy=1; break; fi
  sleep 3
done
echo "$healthy" >"$OUT/gateway-boot.healthy"
for _ in $(seq 1 60); do
  docker logs "$NAME" 2>&1 | grep -q '^LOCKREPORT ' && break
  sleep 3
done
sleep 3
docker logs "$NAME" >"$OUT/gateway-boot.log" 2>&1 || true
docker exec "$NAME" ls -ln /opt/data/plugins/oort-image-guard >"$OUT/gateway-boot.ls" 2>&1 || true
docker exec -u hermes "$NAME" /opt/hermes/.venv/bin/python /fx/hermes_image_guard_live_probe.py >"$OUT/gateway-boot.probe" 2>"$OUT/gateway-boot.probe.err" || true
docker inspect -f '{{.State.Running}}' "$NAME" >"$OUT/gateway-boot.running" 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true

# --- judge ---------------------------------------------------------------------------------------------------------------
python3 - "$OUT" "$EXPECTED_DOTENV" "$ROOT" <<'PY'
import json, sys
out, expected_dotenv, root = sys.argv[1], sys.argv[2], sys.argv[3]
sys.dont_write_bytecode = True
sys.path.insert(0, root + "/infra/hermes")
import env_loader_oracle as oracle  # pure functions: the reading of the gate's problems, the same as the oracle scenario uses
failures = []


def result(name):
    return json.load(open("%s/%s.json" % (out, name)))


def expect(name, rc, fragments=(), absent=()):
    r = result(name)
    problems = (r["lockgate"] or {}).get("problems", [])
    text = " | ".join(problems)
    if r["rc"] != rc:
        failures.append("%s: rc %s != %s (%s; tail %s)" % (name, r["rc"], rc, text[:300], r["tail"]))
    for fragment in fragments:
        if fragment not in text:
            failures.append("%s: no problem contains %r (%s)" % (name, fragment, text[:300]))
    for fragment in absent:
        if fragment in text:
            failures.append("%s: problem text unexpectedly has %r" % (name, fragment))
    return r


LOADER_PREFIX = "/opt/hermes/hermes_cli/env_loader"


def against_loader(name, rc, fragments=(), absent=(), violated=None):
    """`expect` plus the verdict of this image's REAL loader on the very same file (the scenario recorded it, #4886 review): it has to
    come from the image's own loader, every name the loader ends with a forbidden value for has to be named by a gate problem, and
    where the scenario says which names those are (`violated`) the loader has to agree: a shape its author calls applied that the
    loader ignores is a wrong table, not a pass."""
    r = expect(name, rc, fragments, absent)
    o = (r["lockgate"] or {}).get("oracle") or {}
    if not str(o.get("loader_file", "")).startswith(LOADER_PREFIX):
        failures.append("%s: the loader's verdict is not from this image's own hermes_cli.env_loader: %r" % (name, o.get("loader_file")))
    if o.get("error"):
        failures.append("%s: the real loader raised %s on this file" % (name, o["error"]))
    named, _ = oracle.named((r["lockgate"] or {}).get("problems", []))
    for missing in sorted(set(o.get("violated", [])) - named):
        failures.append("%s: the real loader ends with a forbidden %s but no gate problem names it" % (name, missing))
    if violated is not None and sorted(o.get("violated", [])) != sorted(violated):
        failures.append("%s: the real loader applies %r, the scenario says %r" % (name, sorted(o.get("violated", [])), sorted(violated)))
    return r


h = expect("healthy", 0)
guard = (h["lockgate"] or {}).get("image_guard") or {}
# #4886: inside the image the gate reads the volume's .env with the image's own python-dotenv, not the fallback
if (h["lockgate"] or {}).get("env_parser") != {"impl": "python-dotenv", "version": expected_dotenv}:
    failures.append("healthy: the gate did not read the volume's .env with the image's python-dotenv %s: %r"
                    % (expected_dotenv, (h["lockgate"] or {}).get("env_parser")))
canary = guard.get("canary") or {}
if not guard.get("files_verified"):
    failures.append("healthy: files were not verified")
if guard.get("media_strict") is not True:
    failures.append("healthy: the gate did not record the strict media flag: %r" % (guard,))
# no origin configured: the exception is off, so the canary has ONE more refused example (an address of the allowed shape)
if (canary.get("refused"), canary.get("accepted")) != (11, 4):
    failures.append("healthy: canary counts %r" % (canary,))
plugin = canary.get("plugin")
if not (isinstance(plugin, list) and len(plugin) == 1 and plugin[0].get("enabled") is True
        and plugin[0].get("error") is None and plugin[0].get("hooks") == 1 and plugin[0].get("source") == "user"):
    failures.append("healthy: Hermes does not report the plugin as loaded: %r" % (plugin,))
if "image_generate" not in (h["lockgate"] or {}).get("selected_tools", []):
    failures.append("healthy: image_generate was not even selected, so nothing was proven")
expect("no-plugin", 3, ["is not installed"])
expect("edited-plugin", 3, ["does not match the pinned sha256"])
w = expect("widened-plugin", 3, ["canary:"], absent=["pinned sha256"])
if not ((w["lockgate"] or {}).get("image_guard") or {}).get("files_verified"):
    failures.append("widened-plugin: the hash check must have passed so that the canary is what refused")
expect("not-enabled", 3, ["plugins.enabled", "canary:"])
expect("extra-image-gen-key", 3, ["image_gen must hold only 'provider'"])
expect("security-private-urls", 3, ["security.allow_private_urls"])
expect("safe-mode", 3, ["HERMES_SAFE_MODE", "canary:"])
expect("proxy-env", 3, ["HTTPS_PROXY"], absent=["proxy.invalid"])
expect("private-env", 3, ["HERMES_ALLOW_PRIVATE_URLS"])
against_loader("bom-env-file", 3, ["the volume's .env sets HTTPS_PROXY"], absent=["proxy.invalid"], violated=["HTTPS_PROXY"])
# two marks and a rewrite: the loader drops both and applies the proxy; two marks and nothing to rewrite: it keeps one in the name
against_loader("bom-env-file-double", 3, ["the volume's .env sets HTTPS_PROXY"], absent=["proxy.invalid"], violated=["HTTPS_PROXY"])
against_loader("bom-env-file-kept", 0, violated=[])
expect("clean-env-file", 0)
so = expect("self-origin", 0)
so_canary = (((so["lockgate"] or {}).get("image_guard") or {}).get("canary")) or {}
if (so_canary.get("refused"), so_canary.get("accepted")) != (38, 5):
    failures.append("self-origin: canary counts %r (want 10+28 refused, 4+1 accepted)" % (so_canary,))
expect("self-origin-bad", 3, ["OORT_SELF_MEDIA_ORIGIN", "not a canonical origin"], absent=["Oort.Example"])
expect("self-origin-env-file", 3, ["the volume's .env sets OORT_SELF_MEDIA_ORIGIN"])
p_only = expect("prefix-only-plugin", 3, ["canary:"], absent=["pinned sha256"])
if not ((p_only["lockgate"] or {}).get("image_guard") or {}).get("files_verified"):
    failures.append("prefix-only-plugin: the hash check must have passed so that the canary is what refused")
if not any("did not refuse the example" in problem for problem in (p_only["lockgate"] or {}).get("problems", [])):
    failures.append("prefix-only-plugin: the canary did not name a bypass variant it let through")
# #4820 C2b 3부: strict media delivery. Absent, `true` (strict to Hermes, one spelling to the gate) and the volume's .env are refused;
# the only gate-passing shape is the exact flag in the process environment (the scenarios above all ran with it).
expect("strict-missing", 3, ["must set HERMES_MEDIA_DELIVERY_STRICT=1"])
expect("strict-wrong", 3, ["must set HERMES_MEDIA_DELIVERY_STRICT=1"])
expect("strict-env-file", 3, ["the volume's .env sets HERMES_MEDIA_DELIVERY_STRICT"])
# #4886: the volume's .env as Hermes' loader reads it. The REAL gate, the image's python-dotenv: every spelling the loader applies
# is refused by name (never with its value), what it ignores is not, a HERMES_HOME that is not the folder read is refused, and the
# tables of the changed test files pass in this image with python-dotenv present (nothing skipped).
shapes = against_loader("env-shapes", 3, [
    "the volume's .env enables HERMES_SAFE_MODE", "the volume's .env enables HERMES_ALLOW_PRIVATE_URLS",
    "the volume's .env enables HERMES_ENABLE_PROJECT_PLUGINS", "the volume's .env enables HERMES_YOLO_MODE",
    "the volume's .env enables HERMES_DASHBOARD", "the volume's .env sets OORT_SELF_MEDIA_ORIGIN",
    "the volume's .env sets HERMES_MEDIA_DELIVERY_STRICT", "the volume's .env sets HTTPS_PROXY"],
    absent=["proxy.invalid", "oort.example.com"],
    violated=["HERMES_SAFE_MODE", "HERMES_ALLOW_PRIVATE_URLS", "HERMES_ENABLE_PROJECT_PLUGINS", "HERMES_YOLO_MODE", "HERMES_DASHBOARD",
              "OORT_SELF_MEDIA_ORIGIN", "HERMES_MEDIA_DELIVERY_STRICT", "HTTPS_PROXY"])
if ((shapes["lockgate"] or {}).get("env_parser") or {}).get("impl") != "python-dotenv":
    failures.append("env-shapes: the gate did not use the image's python-dotenv: %r" % ((shapes["lockgate"] or {}).get("env_parser"),))
against_loader("env-inert-shapes", 0, violated=[])
# a judged name given a reference: refused for the reference itself (all five), whatever the real loader ends with. The loader
# resolves them in the service slot's environment (HERMES_SUPERVISED_CHILD=1, HOME=the volume): three of the five end forbidden there.
against_loader("env-reference-shapes", 3,
               ["the volume's .env sets %s through a reference" % name for name in
                ("HERMES_SAFE_MODE", "HERMES_DASHBOARD", "HTTPS_PROXY", "API_SERVER_KEY", "FAL_KEY")],
               absent=["k" * 40],
               violated=["HERMES_SAFE_MODE", "HERMES_DASHBOARD", "HTTPS_PROXY"])
expect("hermes-home-other", 3, ["HERMES_HOME is not the folder this gate reads"], absent=["not-the-volume"])
expect("env-parser-parity", 0)
unit = ((result("env-parser-parity")["lockgate"] or {}).get("unittest")) or {}
if unit.get("rc") != 0 or not isinstance(unit.get("ran"), int) or unit["ran"] < 100 or unit.get("skipped"):
    failures.append("env-parser-parity: the changed tests did not all run and pass here with python-dotenv: %r" % (unit,))
# #4886 review: the gate against this image's REAL loader on the named table and seeded random inputs. A comparison of nothing against
# nothing passes, so the judge also demands that it was not empty: enough inputs, enough the loader applied, enough both left alone,
# every judged name violated and caught at least once, every designed reason for a refusal beyond the loader exercised.
expect("env-loader-oracle", 0)
orc = (result("env-loader-oracle")["lockgate"] or {}).get("oracle") or {}
if not str(orc.get("loader_file", "")).startswith(LOADER_PREFIX):
    failures.append("env-loader-oracle: the loader is not this image's own hermes_cli.env_loader: %r" % (orc.get("loader_file"),))
for kind in ("missed", "missed_after", "unexplained", "wrong_labels"):
    if orc.get(kind) != 0:
        failures.append("env-loader-oracle: %s = %r (examples %r)" % (kind, orc.get(kind), (orc.get("examples") or {}).get(kind)))
if (orc.get("env_parser") or {}).get("version") != expected_dotenv:
    failures.append("env-loader-oracle: not this image's python-dotenv %s: %r" % (expected_dotenv, orc.get("env_parser")))
for key, floor in (("cases", 4000), ("violating", 1500), ("clean", 1000)):
    if not isinstance(orc.get(key), int) or orc[key] < floor:
        failures.append("env-loader-oracle: only %r %s (at least %d wanted): the comparison was too thin" % (orc.get(key), key, floor))
if orc.get("detected") != sorted(oracle.JUDGED_KEYS):
    failures.append("env-loader-oracle: judged names the loader violated and the gate named: %r (want %r)" % (orc.get("detected"), sorted(oracle.JUDGED_KEYS)))
if (orc.get("needless") or {}).get("reference", 0) < 100:
    failures.append("env-loader-oracle: the reference shapes were barely exercised: %r" % (orc.get("needless"),))
if set(orc.get("needless") or {}) - {"reference", "mark in a proxy name", "name-only rule"}:
    failures.append("env-loader-oracle: refusals beyond the loader with no designed reason: %r" % (orc.get("needless"),))
if not isinstance(orc.get("hermes_errors"), int) or orc["hermes_errors"] > 0.02 * (orc.get("cases") or 1):
    failures.append("env-loader-oracle: the loader raised on %r inputs: it was not run as Hermes runs it" % (orc.get("hermes_errors"),))
# the premise, from Hermes' own validate_media_delivery_path in the pinned image: strict (and `true`) keeps an old file outside
# Hermes' cache dirs from being delivered, a file in a cache dir still goes out; unset delivers the outside file too.
policy = ((result("media-policy")["lockgate"] or {}).get("media_policy")) or {}
want_policy = {"strict": {"outside": False, "cache": True}, "true": {"outside": False, "cache": True},
               "unset": {"outside": True, "cache": True}}
if policy != want_policy:
    failures.append("media-policy: Hermes' delivery policy is not what the gate relies on: %r (want %r)" % (policy, want_policy))


def text(name, ext):
    return open("%s/%s.%s" % (out, name, ext), errors="replace").read()


for name in ("compose-start", "railway-start"):
    rc = text(name, "rc").strip()
    stdout = text(name, "stdout")
    if rc != "0" or "START_COMMAND_REACHED_EXEC" not in stdout or '"ok": true' not in stdout:
        failures.append("%s: rc %s, stdout tail %r" % (name, rc, stdout[-300:]))
for name, why in (("railway-start-edited", "an edited guard variable"), ("railway-start-missing", "a missing guard variable")):
    rc = text(name, "rc").strip()
    stdout, stderr = text(name, "stdout"), text(name, "stderr")
    if rc == "0" or "START_COMMAND_REACHED_EXEC" in stdout or "LOCKGATE" in stdout:
        failures.append("%s: %s did not stop the start command before the gate (rc %s)" % (name, why, rc))
if "FAILED" not in text("railway-start-edited", "stdout") + text("railway-start-edited", "stderr"):
    failures.append("railway-start-edited: sha256sum did not report the edited file")
if "HERMES_IMAGE_GUARD_B64" not in text("railway-start-missing", "stderr"):
    failures.append("railway-start-missing: the shell did not name the missing variable")
# the shipped templates carry the flag (the runs above passed it from them); without it the SAME start command is refused by the
# gate, with every checksum passing, before it would exec Hermes
for name in ("compose-start-nostrict", "railway-start-nostrict"):
    rc = text(name, "rc").strip()
    stdout = text(name, "stdout")
    if rc == "0" or "START_COMMAND_REACHED_EXEC" in stdout or "must set HERMES_MEDIA_DELIVERY_STRICT=1" not in stdout \
            or '"ok": false' not in stdout:
        failures.append("%s: the gate did not refuse a start without the strict flag (rc %s, stdout tail %r)" % (name, rc, stdout[-300:]))
# the live gateway: the gate passed before it listened, the report (which runs the same rules on the live volume) found
# nothing to shut down, the container is still up, and the plugin is loaded for the hermes uid from the real volume
log = text("gateway-boot", "log")
gate_lines = [json.loads(l[len("LOCKGATE "):]) for l in log.splitlines() if l.startswith("LOCKGATE ")]
report_lines = [json.loads(l[len("LOCKREPORT "):]) for l in log.splitlines() if l.startswith("LOCKREPORT ")]
if text("gateway-boot", "healthy").strip() != "1":
    failures.append("gateway-boot: /health never answered")
if not gate_lines or gate_lines[-1].get("ok") is not True:
    failures.append("gateway-boot: the gate did not pass in the real start command: %r" % (gate_lines[-1:] or log[-400:]))
if not report_lines:
    failures.append("gateway-boot: lockgate report printed no LOCKREPORT")
else:
    last = report_lines[-1]
    if last.get("ok") is not True or last.get("problems") or not all((last.get("checks") or {}).values()) or last.get("action"):
        failures.append("gateway-boot: LOCKREPORT is not clean: %r" % (last,))
    if "image_generate" not in last.get("selected_tools", []):
        failures.append("gateway-boot: the report did not see image_generate selected")
if text("gateway-boot", "running").strip() != "true":
    failures.append("gateway-boot: the container is not running after the report (PID 1 was shut down?)")
probe = [json.loads(l[len("PROBE "):]) for l in text("gateway-boot", "probe").splitlines() if l.startswith("PROBE ")]
if not probe:
    failures.append("gateway-boot: the live probe printed nothing: %s" % text("gateway-boot", "probe.err")[-300:])
else:
    p = probe[-1]
    plugin = p.get("plugin") or []
    if not (len(plugin) == 1 and plugin[0].get("enabled") is True and plugin[0].get("hooks") == 1 and plugin[0].get("error") is None):
        failures.append("gateway-boot: the plugin is not loaded from the live volume: %r" % (p,))
    if not (p.get("refused_is_block") and p.get("accepted_is_none")) or p.get("uid") == 0:
        failures.append("gateway-boot: live hook verdicts or uid wrong: %r" % (p,))
    if not (p.get("origin_set") and p.get("self_address_is_none") and p.get("self_variant_is_block")
            and p.get("self_as_reference_is_block")):
        failures.append("gateway-boot: the live plugin does not judge the self-media address as designed: %r" % (p,))
if failures:
    print("\n".join("FAIL " + f for f in failures))
    sys.exit(1)
print("OK: %d in-image scenarios (gate) + 6 start-command runs + the live gateway boot" % len(
    ["healthy", "no-plugin", "edited-plugin", "widened-plugin", "not-enabled", "extra-image-gen-key", "security-private-urls",
     "safe-mode", "proxy-env", "private-env", "bom-env-file", "bom-env-file-double", "bom-env-file-kept", "clean-env-file", "self-origin",
     "self-origin-bad", "self-origin-env-file", "prefix-only-plugin", "strict-missing", "strict-wrong", "strict-env-file", "media-policy",
     "env-shapes", "env-inert-shapes", "env-reference-shapes", "hermes-home-other", "env-parser-parity", "env-loader-oracle"]))
PY
say "PASS (evidence in $OUT)"
