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

The scenarios about the volume's `.env` (#4886) do not rest on what their author expects. Each one also feeds the same bytes to THIS
image's own `hermes_cli.env_loader.load_hermes_dotenv` (infra/hermes/env_loader_oracle.py) and records what it applies in
`lockgate["oracle"]`; `env-loader-oracle` does that for the whole named table and a few thousand seeded random inputs and compares
the loader with the gate's functions. The judge in the shell script holds the gate to the loader's answer.
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


HERMES_INSTALL = "/opt/hermes"  # the image's own Hermes: its hermes_cli.env_loader is the REAL loader the oracle runs
ORACLE_SEED, ORACLE_RANDOM = 4886, 4000  # the seeded random inputs of the `env-loader-oracle` scenario, on top of the named table


def oracle_modules():
    """(env_loader_oracle, this image's hermes_cli.env_loader, the gate's lockgate.py), imported into THIS process. The oracle and
    lockgate.py come from /oort (read-only, no bytecode); the loader is the image's own, from /opt/hermes, not a copy and not a stand-in.
    The loader imports some of its helpers lazily, on its first call: they are imported here, under the container's real environment,
    because the oracle replaces `os.environ` around every load."""
    sys.dont_write_bytecode = True
    if HERMES_INSTALL not in sys.path:
        sys.path.insert(0, HERMES_INSTALL)
    if OORT not in sys.path:
        sys.path.append(OORT)
    import importlib
    import importlib.util
    oracle = importlib.import_module("env_loader_oracle")
    env_loader = importlib.import_module("hermes_cli.env_loader")
    for name in ("utils", "hermes_constants", "agent.secret_scope", "hermes_cli.config", "hermes_cli._early_recovery",
                 "hermes_cli.managed_scope", "dotenv.main", "dotenv.variables"):
        importlib.import_module(name)
    spec = importlib.util.spec_from_file_location("lockgate_under_proof", os.path.join(OORT, "lockgate.py"))
    lockgate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lockgate)
    return oracle, env_loader, lockgate


def loader_evidence(raw):
    """What this image's REAL loader applies for a volume `.env` holding `raw`: the names it ends with that the policy does not allow
    (#4950: any name outside the allow-list, a seeded one with another value). The scenario's own expectation says what its author
    thinks; this says what Hermes does."""
    oracle, env_loader, _lockgate = oracle_modules()
    violated, error = oracle.loader_violations(env_loader, raw)
    return {"loader_file": os.path.realpath(env_loader.__file__), "error": error, "violated": sorted(violated)}


def with_loader(result, raw):
    """A scenario's `(rc, record, tail)` with the real loader's verdict on the same bytes added to the record (`record["oracle"]`)."""
    rc, record, tail = result
    record = dict(record or {})
    record["oracle"] = loader_evidence(raw)
    return rc, record, tail


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
    raw = b"\xef\xbb\xbfHTTPS_PROXY=http://proxy.invalid:3128\nOPENAI_API_KEY=keep\n"
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


def scenario_bom_env_file_double():
    """#4886 review: two byte order marks in front and a later line the loader's clean-up changes (a blank in front of it), so it
    rewrites the file and the loader decodes the rewritten one again: it drops BOTH marks and applies the proxy."""
    install()
    raw = b"\xef\xbb\xbf\xef\xbb\xbfHTTPS_PROXY=http://proxy.invalid:3128\n OPENAI_API_KEY=keep\n"
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


def scenario_bom_env_file_kept():
    """#4886 review, the other half: two marks and nothing for the clean-up to change. The loader keeps one in the first name, so it
    applies nothing under the plain name but a name with a mark in it, which is not on the allow-list either (#4950): the gate reads the
    same name and refuses it."""
    install()
    raw = b"\xef\xbb\xbf\xef\xbb\xbfHERMES_SAFE_MODE=1\nOPENAI_API_KEY=keep\n"
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


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
    write(os.path.join(DATA, ".env"), ("OORT_SELF_MEDIA_ORIGIN=" + SELF_ORIGIN + "\nOPENAI_API_KEY=keep\n").encode("utf-8"))
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
    write(os.path.join(DATA, ".env"), b"\xef\xbb\xbfOPENAI_API_KEY=keep\n")
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
    write(os.path.join(DATA, ".env"), ("HERMES_MEDIA_DELIVERY_STRICT=1\nOPENAI_API_KEY=keep\n").encode("utf-8"))
    return run_gate()


ENV_SHAPES_APPLIED = (
    "HERMES_SAFE_MODE=1 # note",
    "export\tHERMES_ALLOW_PRIVATE_URLS=true",
    "'HERMES_ENABLE_PROJECT_PLUGINS'=1",
    'HERMES_YOLO_MODE="1" # c',
    "export\tHERMES_DASHBOARD=true",
    "export\t'OORT_SELF_MEDIA_ORIGIN'=\"https://oort.example.com\" # c",
    "'HERMES_MEDIA_DELIVERY_STRICT'=1",
    'export  HTTPS_PROXY="http://proxy.invalid:3128" # c',
)
ENV_SHAPES_APPLIED_UNLISTED = (  # #4950: names that were never judged, and a name that was judged by its value, given a harmless one
    "HERMES_MEDIA_ALLOW_DIRS=/oort-proof/none",
    "export HERMES_MANAGED_DIR='/oort-proof/none'",
    "HERMES_HOME=/oort-proof/none",
    "GATEWAY_PROXY_URL=https://relay.invalid",
    "OPENROUTER_API_KEY=" + "o" * 12,
    "HERMES_SAFE_MODE=0 # =1",
    "hermes_safe_mode=1",
)
ENV_SHAPES_IGNORED = (
    "# HERMES_SAFE_MODE=1",
    'HERMES_SAFE_MODE="1',
    "HERMES_SAFE_MODE",
    'HERMES_SAFE_MODE="1" junk',
    "OORT_SELF_MEDIA_ORIGIN",
    "HERMES_YOLO_MODE=1\nHERMES_YOLO_MODE",
    'OPENAI_API_KEY="one\nHERMES_SAFE_MODE=1"',
)


def scenario_env_shapes():
    """#4886, #4950: spellings of the volume's .env that Hermes' loader (python-dotenv, then its own `${}` resolution) APPLIES: inline
    comment, `export<TAB>`, a single-quoted name, a quoted value + comment, and names that no rule ever judged (where media may be
    delivered from, the managed folder, the home folder, request forwarding, a lower-case spelling, a harmless value). The REAL gate
    reads them with the REAL python-dotenv of this image; every name must be refused, because none is on the allow-list."""
    install()
    raw = ("OPENAI_API_KEY=keep\n" + "\n".join(ENV_SHAPES_APPLIED + ENV_SHAPES_APPLIED_UNLISTED) + "\n").encode("utf-8")
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


def scenario_env_inert_shapes():
    """#4886: the other half: what the loader ignores (a comment, an unterminated quote, a name with no value, junk after the closing
    quote, a name followed by a bare one of its own, a statement inside a quoted value) must not stop the start."""
    install()
    raw = ("OPENAI_API_KEY=keep\n" + "\n".join(ENV_SHAPES_IGNORED) + "\n").encode("utf-8")
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


ENV_SHAPES_REFERENCES = (
    "HERMES_SAFE_MODE=${HERMES_SUPERVISED_CHILD:-0}",
    "HERMES_DASHBOARD=${OORT_PROOF_UNSET:-1}",
    "HTTPS_PROXY=${HOME}",
    "API_SERVER_KEY=${OORT_PROOF_UNSET:-" + "k" * 40 + "}",
    "FAL_KEY=${OORT_PROOF_UNSET:-}",
)


def scenario_env_reference_shapes():
    """#4886 review, #4950: a name that is not allowed given a `${...}` reference. Hermes resolves it in ITS environment, where the
    service slot has variables the gate's shell has not (and HOME is the volume); the gate reads no value, so none of this changes its
    answer: every one is refused by name, and the real loader applies every one of them (the record carries that for the judge)."""
    install()
    raw = ("OPENAI_API_KEY=keep\n" + "\n".join(ENV_SHAPES_REFERENCES) + "\n").encode("utf-8")
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


def scenario_env_seed_template():
    """#4950: Hermes' first boot copies the image's own /opt/hermes/.env.example into a fresh volume's `.env` (docker/stage2-hook.sh
    `seed_one`) AFTER the gate ran, so `report` and the next boot read it. The gate's table of those lines (`VOLUME_ENV_SEEDED`) has to be
    what the pinned image's file holds, the file as the image ships it has to pass the gate, and the real loader must end with nothing
    the policy forbids when it loads it. Refusing it would end every fresh install in a restart loop."""
    install()
    path = os.path.join(HERMES_INSTALL, ".env.example")
    if not os.path.isfile(path):
        return 1, {"ok": False, "problems": ["the image has no /opt/hermes/.env.example: Hermes seeds nothing, VOLUME_ENV_SEEDED has no premise"],
                   "seed": {"image_has_the_file": False}}, None
    example = read(path)
    _oracle, _env_loader, lockgate = oracle_modules()
    final = {name: value for name, value in dict(lockgate.dotenv_assignments(example.decode("utf-8"))).items() if value is not None}
    write(os.path.join(DATA, ".env"), example)
    rc, record, tail = run_gate()
    record = dict(record or {})
    record["seed"] = {"image_has_the_file": True, "example_sha256": sha(example), "image_assignments": final,
                      "gate_table": dict(lockgate.VOLUME_ENV_SEEDED), "equal": final == dict(lockgate.VOLUME_ENV_SEEDED)}
    record["oracle"] = loader_evidence(example)
    return rc, record, tail


def scenario_env_loader_oracle():
    """#4886 review, #4950: the gate's reading of the volume's `.env` against Hermes' REAL loader, not against what its author expects.
    For every input of the named table (each name the policy forbids on every spelling, reference, byte order mark and load-chain shape,
    the names it allows, the seeded lines) and a few thousand seeded random ones, `hermes_cli.env_loader.load_hermes_dotenv` of this image
    runs on a copy in the service slot's environment, again on the file it leaves behind until a load leaves the file as it was (at most
    `oracle.LOAD_CAP` loads), and once more on each of those files as it stands (its clean-up switched off). The names it adds that the
    policy does not allow, in ANY of those loads, must all be named by the gate's problems; a refusal beyond them must have a designed
    reason; and the gate's model of the files the loader leaves is held to the loader's own. Not a gate run: the record carries the counts,
    the judge in the shell script holds them to thresholds so that an empty comparison cannot pass."""
    install()  # the volume as the start commands leave it, like every other scenario: Hermes' modules are imported against it
    oracle, env_loader, lockgate = oracle_modules()
    summary = oracle.run(env_loader, lockgate, oracle.table_cases() + oracle.random_cases(ORACLE_SEED, ORACLE_RANDOM))
    loader_file = os.path.realpath(env_loader.__file__)
    summary.update({"loader_file": loader_file, "loader_sha256": sha(read(loader_file)), "env_parser": lockgate.env_parser()})
    return (0 if summary["ok"] else 1), {"ok": summary["ok"], "problems": [], "oracle": summary}, None


CONNECTOR_APPS = "com.momo.plugins.gmail,com.momo.plugins.google-calendar,com.momo.plugins.google-drive"
CONNECTOR_ENV = {"OORT_COHOSTED_AGENT_CONNECTOR_APPS": CONNECTOR_APPS, "GOOGLE_OAUTH_CLIENT_ID": "oort-proof-id",
                 "GOOGLE_OAUTH_CLIENT_SECRET": "oort-proof-secret"}  # names as the connector config reads them; dummy values, nothing is dialed


def catalog_configs():
    """`{name: text}` of every config the gate accepts, rebuilt from the repo's own pieces by the repo's own renderer (stdlib only, mounted
    read-only at /oort): the default config and the connector-mode config of each model fragment (#4935)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("render_model_config", os.path.join(OORT, "render_model_config.py"))
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    return {name: text.encode("utf-8") for name, text in renderer.repo_catalog(OORT).items()}, renderer.sha256_of


def scenario_connector_configs():
    """#4935: the REAL gate on every config of the catalog, in this image, with the connector rules of the real Hermes `load_config` and
    tool resolution: the default config and the connector-mode config of each of the four model fragments must each be accepted by name
    (`config_accepted_as`), the connector ones with no web search and no picture tool selected and no `image_guard` evidence (they have
    no picture plugin), the default one with the picture tool. Not one gate run: the record carries one result per config."""
    configs, _sha = catalog_configs()
    entries = {}
    for name, raw in configs.items():
        install()
        write(os.path.join(DATA, "config.yaml"), raw)
        rc, record, tail = run_gate(env=CONNECTOR_ENV if name.startswith("connector/") else None)
        record = record or {}
        entries[name] = {"rc": rc, "ok": record.get("ok"), "accepted_as": record.get("config_accepted_as"), "problems": record.get("problems"),
                         "selected_tools": record.get("selected_tools"), "image_guard": record.get("image_guard"),
                         "media_strict": record.get("media_strict"), "tail": tail}
    ok = all(entry["rc"] == 0 for entry in entries.values())
    return (0 if ok else 1), {"ok": ok, "problems": [], "entries": entries}, None


def scenario_connector_config_edited():
    """#4935: the connector-mode config with ONE byte changed (a trailing comment): refused, not accepted by any name."""
    configs, _sha = catalog_configs()
    install()
    write(os.path.join(DATA, "config.yaml"), configs["connector/claude-oauth.fallback-codex-oauth"] + b"# edited\n")
    return run_gate(env=CONNECTOR_ENV)


def scenario_connector_config_nostrict():
    """#4935: the connector-mode config without the strict media flag: refused by the gate (strict is required in every mode)."""
    configs, _sha = catalog_configs()
    install()
    write(os.path.join(DATA, "config.yaml"), configs["connector/claude-oauth.fallback-codex-oauth"])
    return run_gate(env={**CONNECTOR_ENV, STRICT_ENV: None})


def scenario_connector_config_apps_missing():
    """#4935: the connector-mode config without the operator's attested app list (K4): refused as before."""
    configs, _sha = catalog_configs()
    install()
    write(os.path.join(DATA, "config.yaml"), configs["connector/claude-oauth.fallback-codex-oauth"])
    return run_gate(env={**CONNECTOR_ENV, "OORT_COHOSTED_AGENT_CONNECTOR_APPS": None})


def scenario_hermes_home_other():
    """#4886: the gate reads /opt/data; Hermes loads $HERMES_HOME/.env. This image sets HERMES_HOME=/opt/data (the healthy scenario
    passes with it); a HERMES_HOME that names another folder is refused."""
    install()
    return run_gate(env={"HERMES_HOME": "/tmp/not-the-volume"})


def scenario_env_parser_parity():
    """#4886: the input table and the rule tables of infra/hermes/test_lockgate_env.py (plus the other test files that changed, among them the
    config catalog of render_model_config.py, #4935),
    run by THIS image's python with the REAL python-dotenv: the fallback parser and the installed one must both reproduce every row.
    OORT_REQUIRE_DOTENV=1 makes a missing python-dotenv a failure and never a skip. Not a gate run: the record carries the counts."""
    environment = dict(os.environ, OORT_REQUIRE_DOTENV="1", PYTHONDONTWRITEBYTECODE="1")
    done = subprocess.run([PY, "-B", "-m", "unittest", "-v", "test_lockgate_env", "test_lockgate_image_guard", "test_default_config",
                           "test_render_model_config"],
                          cwd=OORT, capture_output=True, text=True, timeout=900, env=environment)
    output = done.stderr + "\n" + done.stdout
    ran, skipped = re.search(r"Ran (\d+) tests?", output), re.search(r"skipped=(\d+)", output)
    record = {"ok": done.returncode == 0, "problems": [],
              "unittest": {"rc": done.returncode, "ran": int(ran.group(1)) if ran else None,
                           "skipped": int(skipped.group(1)) if skipped else 0, "tail": output.strip().splitlines()[-8:]}}
    return done.returncode, record, None


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
