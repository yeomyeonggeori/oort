#!/usr/bin/env python3
"""Runs INSIDE the pinned Hermes image, with no network, for scripts/tests/test_hermes_image_guard_docker.sh (#4820 review,
ADR-0203 I2). Stdlib only. The repo's infra/hermes is mounted read-only at /oort; /opt/data is the container's own volume.

  hermes_image_guard_inimage.py <scenario>

It sets up /opt/data the way the start commands do (config.yaml + the two guard plugin files), applies ONE scenario's
change, runs the REAL `lockgate.py gate` and prints one JSON line: {"scenario", "rc", "lockgate", "tail"}.
`lockgate` is the parsed LOCKGATE record (ok, problems, image_guard evidence incl. the canary counts and the plugin
listing Hermes itself reports), `tail` the last stderr/stdout lines when the gate printed no record.

Every gate run carries `HERMES_MEDIA_DELIVERY_STRICT=1` unless a scenario removes or changes it (#4820 C2b 3부: the gate
requires it whenever the picture tool is exposed, exactly as the shipped templates provide it).
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

OORT = "/oort"
DATA = "/opt/data"
PLUGIN = "oort-image-guard"
PY = "/opt/hermes/.venv/bin/python"
GUARD_DIR = os.path.join(DATA, "plugins", PLUGIN)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def install(plugin=True):
    os.makedirs(DATA, exist_ok=True)
    shutil.copyfile(os.path.join(OORT, "config.yaml"), os.path.join(DATA, "config.yaml"))
    if plugin:
        os.makedirs(GUARD_DIR, exist_ok=True)
        for name in ("__init__.py", "plugin.yaml"):
            shutil.copyfile(os.path.join(OORT, "plugins", PLUGIN, name), os.path.join(GUARD_DIR, name))


def read(path):
    with open(path, "rb") as handle:
        return handle.read()


def write(path, raw):
    with open(path, "wb") as handle:
        handle.write(raw)


STRICT_ENV = "HERMES_MEDIA_DELIVERY_STRICT"


def run_gate(gate=os.path.join(OORT, "lockgate.py"), env=None):
    environment = dict(os.environ)
    environment.setdefault(STRICT_ENV, "1")
    environment.update(env or {})
    environment = {name: value for name, value in environment.items() if value is not None}  # None removes a name
    done = subprocess.run([PY, gate, "gate", os.path.join(DATA, "config.yaml")], capture_output=True, text=True,
                          timeout=600, env=environment)
    record = None
    for line in done.stdout.splitlines():
        if line.startswith("LOCKGATE "):
            record = json.loads(line[len("LOCKGATE "):])
    tail = None
    if record is None:
        tail = (done.stderr.strip().splitlines() + done.stdout.strip().splitlines())[-12:]
    return done.returncode, record, tail


def scenario_healthy():
    install()
    return run_gate()


def scenario_no_plugin():
    install(plugin=False)
    return run_gate()


def scenario_edited_plugin():
    install()
    write(os.path.join(GUARD_DIR, "__init__.py"), read(os.path.join(GUARD_DIR, "__init__.py")) + b"\n# edited\n")
    return run_gate()


def scenario_widened_plugin():
    """A guard that also lets https:// through, with the gate's pinned hash patched to match it: only the canary can object."""
    install()
    path = os.path.join(GUARD_DIR, "__init__.py")
    original = read(path)
    old = b"    for prefix in _PREFIXES:\n        if value.startswith(prefix):"
    assert old in original, "the plugin source changed; update this scenario"
    widened = original.replace(old, b'    if value.startswith("https://"):\n        return True\n' + old)
    write(path, widened)
    gate_text = read(os.path.join(OORT, "lockgate.py")).decode("utf-8")
    assert sha(original) in gate_text
    patched = "/tmp/lockgate_patched.py"
    write(patched, gate_text.replace(sha(original), sha(widened)).encode("utf-8"))
    return run_gate(gate=patched)


def scenario_not_enabled():
    install()
    config = read(os.path.join(DATA, "config.yaml")).decode("utf-8")
    stripped = re.sub(r"(?m)^plugins:\n  enabled:\n    - oort-image-guard[^\n]*\n", "", config)
    assert stripped != config, "config.yaml has no plugins.enabled block"
    write(os.path.join(DATA, "config.yaml"), stripped.encode("utf-8"))
    return run_gate()


def scenario_extra_image_gen_key():
    install()
    config = read(os.path.join(DATA, "config.yaml")).decode("utf-8")
    changed = config.replace("image_gen:\n  provider: openai-codex", "image_gen:\n  use_gateway: true\n  provider: openai-codex", 1)
    assert changed != config
    write(os.path.join(DATA, "config.yaml"), changed.encode("utf-8"))
    return run_gate()


def scenario_security_private_urls():
    install()
    config = read(os.path.join(DATA, "config.yaml")).decode("utf-8")
    write(os.path.join(DATA, "config.yaml"), (config + "security:\n  allow_private_urls: true\n").encode("utf-8"))
    return run_gate()


def scenario_safe_mode():
    install()
    return run_gate(env={"HERMES_SAFE_MODE": "1"})


def scenario_proxy_env():
    install()
    return run_gate(env={"HTTPS_PROXY": "http://proxy.invalid:3128"})


def scenario_private_env():
    install()
    return run_gate(env={"HERMES_ALLOW_PRIVATE_URLS": "true"})


def scenario_bom_env_file():
    install()
    write(os.path.join(DATA, ".env"), b"\xef\xbb\xbfHTTPS_PROXY=http://proxy.invalid:3128\nOPENROUTER_API_KEY=keep\n")
    return run_gate()


SELF_ORIGIN = "https://oort.example.com"


def scenario_self_origin():
    """The owner's 10-30 exception, on: the origin is set to a canonical value. The canary must accept the one allowed
    address and refuse its variants through the real Hermes dispatch path."""
    install()
    return run_gate(env={"OORT_SELF_MEDIA_ORIGIN": SELF_ORIGIN})


def scenario_self_origin_bad():
    install()
    return run_gate(env={"OORT_SELF_MEDIA_ORIGIN": "https://Oort.Example.com/"})


def scenario_self_origin_env_file():
    """The volume's .env is loaded into Hermes after the gate: it may not carry the variable even with the same value."""
    install()
    write(os.path.join(DATA, ".env"), ("OORT_SELF_MEDIA_ORIGIN=" + SELF_ORIGIN + "\nOPENROUTER_API_KEY=keep\n").encode("utf-8"))
    return run_gate(env={"OORT_SELF_MEDIA_ORIGIN": SELF_ORIGIN})


def scenario_prefix_only_plugin():
    """The exception weakened to a bare prefix comparison (no tail check, no length check), its hash patched into the gate:
    the hash check passes, so only the canary's bypass variants can object."""
    install()
    path = os.path.join(GUARD_DIR, "__init__.py")
    original = read(path)
    old_check = b"    if not value.startswith(prefix) or len(value) != len(prefix) + _SELF_TAIL_CHARS:\n        return False\n"
    old_tail = b"    return _SELF_TAIL.fullmatch(value, len(prefix)) is not None\n"
    assert old_check in original and old_tail in original, "the plugin source changed; update this scenario"
    weakened = original.replace(old_check, b"    if not value.startswith(prefix):\n        return False\n").replace(old_tail, b"    return True\n")
    write(path, weakened)
    gate_text = read(os.path.join(OORT, "lockgate.py")).decode("utf-8")
    assert sha(original) in gate_text
    patched = "/tmp/lockgate_patched.py"
    write(patched, gate_text.replace(sha(original), sha(weakened)).encode("utf-8"))
    return run_gate(gate=patched, env={"OORT_SELF_MEDIA_ORIGIN": SELF_ORIGIN})


def scenario_clean_env_file():
    install()
    write(os.path.join(DATA, ".env"), b"\xef\xbb\xbfOPENROUTER_API_KEY=keep\n")
    return run_gate()


def scenario_strict_missing():
    """#4820 C2b 3부: no strict media flag in the process environment while the picture tool is exposed: refused."""
    install()
    return run_gate(env={STRICT_ENV: None})


def scenario_strict_wrong():
    """`true` is strict to Hermes itself, but the gate takes one spelling: refused."""
    install()
    return run_gate(env={STRICT_ENV: "true"})


def scenario_strict_env_file():
    """The volume's .env is loaded into Hermes after the gate: it may not carry the name even with the same value."""
    install()
    write(os.path.join(DATA, ".env"), ("HERMES_MEDIA_DELIVERY_STRICT=1\nOPENROUTER_API_KEY=keep\n").encode("utf-8"))
    return run_gate()


MEDIA_PROBE = r'''
import json, os, sys, tempfile
home = tempfile.mkdtemp(prefix="oort-media-home-")
os.environ["HERMES_HOME"] = home
os.environ["HOME"] = home
sys.path.insert(0, "/opt/hermes")
from gateway.platforms.base import MEDIA_DELIVERY_SAFE_ROOTS, validate_media_delivery_path
outside_dir = tempfile.mkdtemp(prefix="oort-media-outside-")      # under /tmp: in no cache dir, not on the denylist
outside = os.path.join(outside_dir, "old.png")
with open(outside, "wb") as handle:
    handle.write(b"not a secret, only a file that exists")
os.utime(outside, (1, 1))                                          # decades old: no recency trust either
root = str(MEDIA_DELIVERY_SAFE_ROOTS[0])
assert root.startswith(home), (root, home)                         # the cache root under the SCRATCH home, never the volume
os.makedirs(root, exist_ok=True)
cached = os.path.join(root, "made-by-hermes.png")
with open(cached, "wb") as handle:
    handle.write(b"cache")
os.utime(cached, (1, 1))
print("PROBE " + json.dumps({"outside": validate_media_delivery_path(outside) is not None,
                             "cache": validate_media_delivery_path(cached) is not None}))
'''


def media_probe(strict):
    environment = dict(os.environ)
    environment.pop(STRICT_ENV, None)
    if strict is not None:
        environment[STRICT_ENV] = strict
    done = subprocess.run([PY, "-c", MEDIA_PROBE], capture_output=True, text=True, timeout=300, env=environment)
    for line in done.stdout.splitlines():
        if line.startswith("PROBE "):
            return json.loads(line[len("PROBE "):])
    return {"error": (done.stderr.strip().splitlines() + done.stdout.strip().splitlines())[-6:]}


def scenario_media_policy():
    """The premise the gate relies on, measured in the pinned image with Hermes' own `validate_media_delivery_path`: with
    HERMES_MEDIA_DELIVERY_STRICT=1 an old file outside Hermes' cache dirs is NOT delivered (a file in a cache dir still is);
    without it the same file IS. So requiring the flag is what closes the local-file door of a `MEDIA:` line. Not a gate run:
    the record carries the 2x2 table."""
    table = {"strict": media_probe("1"), "true": media_probe("true"), "unset": media_probe(None)}
    return 0, {"ok": True, "problems": [], "media_policy": table}, None


SCENARIOS = {name[len("scenario_"):].replace("_", "-"): fn for name, fn in sorted(globals().items())
             if name.startswith("scenario_")}


def main():
    name = sys.argv[1]
    rc, record, tail = SCENARIOS[name]()
    print("RESULT " + json.dumps({"scenario": name, "rc": rc, "lockgate": record, "tail": tail}, sort_keys=True))


if __name__ == "__main__":
    main()
