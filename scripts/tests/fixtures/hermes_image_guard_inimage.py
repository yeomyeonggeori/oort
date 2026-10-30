#!/usr/bin/env python3
"""Runs INSIDE the pinned Hermes image, with no network, for scripts/tests/test_hermes_image_guard_docker.sh (#4820 review,
ADR-0203 I2). Stdlib only. The repo's infra/hermes is mounted read-only at /oort; /opt/data is the container's own volume.

  hermes_image_guard_inimage.py <scenario>

It sets up /opt/data the way the start commands do (config.yaml + the two guard plugin files), applies ONE scenario's
change, runs the REAL `lockgate.py gate` and prints one JSON line: {"scenario", "rc", "lockgate", "tail"}.
`lockgate` is the parsed LOCKGATE record (ok, problems, image_guard evidence incl. the canary counts and the plugin
listing Hermes itself reports), `tail` the last stderr/stdout lines when the gate printed no record.
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


def run_gate(gate=os.path.join(OORT, "lockgate.py"), env=None):
    environment = dict(os.environ)
    environment.update(env or {})
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


def scenario_clean_env_file():
    install()
    write(os.path.join(DATA, ".env"), b"\xef\xbb\xbfOPENROUTER_API_KEY=keep\n")
    return run_gate()


SCENARIOS = {name[len("scenario_"):].replace("_", "-"): fn for name, fn in sorted(globals().items())
             if name.startswith("scenario_")}


def main():
    name = sys.argv[1]
    rc, record, tail = SCENARIOS[name]()
    print("RESULT " + json.dumps({"scenario": name, "rc": rc, "lockgate": record, "tail": tail}, sort_keys=True))


if __name__ == "__main__":
    main()
