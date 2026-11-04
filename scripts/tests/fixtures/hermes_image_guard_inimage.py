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
image's own `hermes_cli.env_loader.load_hermes_dotenv` (infra/hermes/env_loader_oracle.py) and to its second reader of the file, the
line-by-line `agent.secret_scope.load_env_file`, and records what they apply in `lockgate["oracle"]` (`violated`, `line_violated`);
`env-loader-oracle` does that for the whole named table and a few thousand seeded random inputs and compares the readers with the gate's
functions. The judge in the shell script holds the gate to their answers.

The scenarios about cross-run recall (#4898, ADR-0203 augmentation of 2026-11-01) do not rest on the config's own word either: `cross-run-tools-off`
asks THIS image's real Hermes modules (a child process with `HERMES_HOME` on a scratch folder) what the shipped config exposes and whether a
MEMORY.md an earlier run left would reach a system prompt, and asks the same of a copy with the two tools switched on, so a probe that cannot see them
fails; `cross-run-tools-on` runs the real gate on single-fault copies of the config (the gate copy accepts their bytes, so only the rule under test
can refuse) and demands each refusal by its own rule.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

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


def line_reader():
    """This image's own line-by-line reader of `.env` (`agent.secret_scope.load_env_file`, which the credential pool, the config readers and
    the profile scope read the file through), wrapped for the oracle: `raw` bytes -> `{name: value}`."""
    import importlib
    oracle, _env_loader, _lockgate = oracle_modules()
    return oracle.line_reader_of(importlib.import_module("agent.secret_scope").load_env_file)


def loader_evidence(raw):
    """What this image's REAL readers apply for a volume `.env` holding `raw`: the names the loader ends with that the policy does not allow
    (#4950: any name outside the allow-list, a seeded one with another value), and the names the line-by-line reader yields that it does not
    allow either. The scenario's own expectation says what its author thinks; this says what Hermes does."""
    oracle, env_loader, _lockgate = oracle_modules()
    violated, error = oracle.loader_violations(env_loader, raw)
    return {"loader_file": os.path.realpath(env_loader.__file__), "error": error, "violated": sorted(violated),
            "line_violated": sorted(oracle.line_violations(line_reader(), raw))}


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
ENV_SHAPES_IGNORED = (  # no reader of the file sets anything for these
    "# HERMES_SAFE_MODE=1",
    "HERMES_SAFE_MODE",
    "OORT_SELF_MEDIA_ORIGIN",
    "   # HERMES_YOLO_MODE=1",
)
ENV_SHAPES_LINE_READ = (  # python-dotenv (the loader) sets nothing for these; Hermes' line-by-line reader of the file reads the name
    'HERMES_SAFE_MODE="1',
    'HERMES_SAFE_MODE="1" junk',
    "HERMES_YOLO_MODE=1\nHERMES_YOLO_MODE",
    'OPENAI_API_KEY="one\nHERMES_DASHBOARD=true"',
    "OPENAI_API_KEY=1\x0cHERMES_ALLOW_PRIVATE_URLS=1",
    "OPENAI_API_KEY=1 # c\u2029HTTPS_PROXY=http://proxy.invalid:3128",
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
    """#4886: the other half: what no reader of the file reads (a comment, a name with no value) must not stop the start."""
    install()
    raw = ("OPENAI_API_KEY=keep\n" + "\n".join(ENV_SHAPES_IGNORED) + "\n").encode("utf-8")
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


def scenario_env_line_reader_shapes():
    """#4950: what python-dotenv ignores but Hermes' line-by-line reader reads (a statement the loader cannot finish, a bare name that undoes
    an earlier line only for the loader, a statement inside a quoted value, one after a boundary only that reader cuts at, the tail of a
    comment) is read as a name by the credential pool and the config readers: the real gate refuses every name, by name. The record
    carries what each real reader sees: the loader applies none of them, the line-by-line reader reads every one."""
    install()
    raw = ("OPENAI_API_KEY=keep\n" + "\n".join(ENV_SHAPES_LINE_READ) + "\n").encode("utf-8")
    write(os.path.join(DATA, ".env"), raw)
    return with_loader(run_gate(), raw)


def scenario_profile_folder():
    """#4950: the volume's `profiles` folder. Empty the start is fine (the image's own boot leaves it absent or empty); an entry under it
    (Hermes serves it as a profile of its own, with an `.env` of its own) is refused by the real gate, by number."""
    install()
    os.makedirs(os.path.join(DATA, "profiles"), exist_ok=True)
    empty = run_gate()
    os.makedirs(os.path.join(DATA, "profiles", "oort-proof-profile"), exist_ok=True)
    rc, record, tail = run_gate()
    record = dict(record or {})
    record["profiles"] = {"empty_rc": empty[0], "empty_problems": (empty[1] or {}).get("problems")}
    return rc, record, tail


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
    """#4886 review, #4950: the gate's reading of the volume's `.env` against Hermes' REAL readers, not against what its author expects.
    For every input of the named table (each name the policy forbids on every spelling, reference, byte order mark and load-chain shape,
    the names it allows, the seeded lines, what only the line-by-line reader reads) and a few thousand seeded random ones,
    `hermes_cli.env_loader.load_hermes_dotenv` of this image runs on a copy in the service slot's environment, again on the file it leaves
    behind until a load leaves the file as it was (at most `oracle.LOAD_CAP` loads), and once more on each of those files as it stands (its
    clean-up switched off); and the image's own `agent.secret_scope.load_env_file`, Hermes' second reader of the file, reads each of those
    files. The names either reader yields that the policy does not allow, in ANY of those files, must all be named by the gate's problems;
    a refusal beyond them must have a designed reason; the gate's model of the files the loader leaves is held to the loader's own, and its
    copy of the line-by-line reader to the real one. Not a gate run: the record carries the counts, the judge in the shell script holds them
    to thresholds so that an empty comparison cannot pass."""
    install()  # the volume as the start commands leave it, like every other scenario: Hermes' modules are imported against it
    oracle, env_loader, lockgate = oracle_modules()
    import importlib
    secret_scope = importlib.import_module("agent.secret_scope")
    summary = oracle.run(env_loader, lockgate, oracle.table_cases() + oracle.random_cases(ORACLE_SEED, ORACLE_RANDOM),
                         line_reader=oracle.line_reader_of(secret_scope.load_env_file))
    loader_file, reader_file = os.path.realpath(env_loader.__file__), os.path.realpath(secret_scope.__file__)
    summary.update({"loader_file": loader_file, "loader_sha256": sha(read(loader_file)), "line_reader_file": reader_file,
                    "line_reader_sha256": sha(read(reader_file)), "env_parser": lockgate.env_parser()})
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
                         "selected_tools": record.get("selected_tools"), "resolved_tools": record.get("resolved_tools"),
                         "memory_config": record.get("memory_config"), "image_guard": record.get("image_guard"),
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


RECALL_TOOLS = ("memory", "session_search")
RECALL_MARKER = "oort-proof-recall-marker-4898"  # text a run of "another workspace" left in MEMORY.md; a made-up word, never a secret

# What this image's REAL Hermes makes of one config.yaml in a fresh HERMES_HOME: the calls the gate makes (`_get_platform_tools`, `_select_tool_names`,
# `get_tool_definitions`) and the ones agent/agent_init.py `_init_memory` makes before it builds the memory store whose snapshot enters the system
# prompt. Hermes reads HERMES_HOME when its modules are imported, so this runs in a child process of its own. Nothing is dialed.
RECALL_PROBE = r"""
import json, os, sys
sys.path.insert(0, "/opt/hermes")
from hermes_cli.config import load_config
from hermes_cli.tools_config import _get_platform_tools
from model_tools import _select_tool_names, get_tool_definitions
from tools.memory_tool import MemoryStore, check_memory_requirements, get_builtin_memory_config, get_builtin_memory_store_flags
cfg = load_config()
disabled = [str(x) for x in ((cfg.get("agent") or {}).get("disabled_toolsets") or [])]
enabled = sorted(_get_platform_tools(cfg, "api_server"))
selected = sorted(_select_tool_names(enabled, disabled, True))
defs = get_tool_definitions(enabled_toolsets=enabled, disabled_toolsets=disabled, quiet_mode=True, skip_tool_search_assembly=True)
resolved = sorted({d["function"]["name"] for d in defs})
flags = list(get_builtin_memory_store_flags(cfg))
settings = get_builtin_memory_config(cfg)
marker = None
if any(flags):
    store = MemoryStore(memory_char_limit=settings.get("memory_char_limit", 2200), user_char_limit=settings.get("user_char_limit", 1375),
                        memory_enabled=flags[0], user_profile_enabled=flags[1])
    store.load_from_disk()
    marker = os.environ["OORT_RECALL_MARKER"] in (store.format_for_system_prompt("memory") or "")
print("PROBE " + json.dumps({"enabled": enabled, "selected": selected, "resolved": resolved, "memory_flags": flags,
                             "memory_tool_available": bool(check_memory_requirements()), "store_built": any(flags), "marker_in_prompt": marker,
                             "provider_set": bool(settings.get("provider"))}, sort_keys=True))
"""


def recall_probe(config_raw):
    """The real Hermes' view of `config_raw` with a MEMORY.md that holds the marker on the same volume, as a dict (or {"error": [...]})."""
    home = tempfile.mkdtemp(prefix="recall-probe-")  # a new folder every time: nothing is deleted, nothing is reused
    os.makedirs(os.path.join(home, "memories"))
    write(os.path.join(home, "config.yaml"), config_raw)
    write(os.path.join(home, "memories", "MEMORY.md"), ("an earlier run of another workspace wrote this: " + RECALL_MARKER + "\n").encode("utf-8"))
    env = dict(os.environ, HERMES_HOME=home, HOME=home, OORT_RECALL_MARKER=RECALL_MARKER, PYTHONDONTWRITEBYTECODE="1")
    # the same schema migration the gate (and stage2 on the real volume) runs before it loads the file
    subprocess.run([PY, os.path.join(HERMES_INSTALL, "scripts", "docker_config_migrate.py")], cwd=HERMES_INSTALL, env=env, capture_output=True, text=True, timeout=120)
    done = subprocess.run([PY, "-c", RECALL_PROBE], cwd=HERMES_INSTALL, env=env, capture_output=True, text=True, timeout=300)
    for line in done.stdout.splitlines():
        if line.startswith("PROBE "):
            return json.loads(line[len("PROBE "):])
    return {"error": (done.stderr.strip().splitlines() + done.stdout.strip().splitlines())[-8:]}


def with_recall_tools(text, toolsets=RECALL_TOOLS, flags=True):
    """The shipped default config with the recall tools switched on the way an operator would: listed in api_server, their deny-list lines gone,
    the memory switches on. `toolsets` picks which of the two; `flags=False` leaves the switches as shipped."""
    out = text
    for name in toolsets:
        stripped = re.sub(r"(?m)^    - %s +#.*\n" % name, "", out)
        assert stripped != out, "the deny-list has no %s line: update this scenario" % name
        out = stripped.replace("  api_server:\n", "  api_server:\n    - %s\n" % name, 1)
    if flags:
        for key in ("memory_enabled", "user_profile_enabled"):
            flipped = re.sub(r"(?m)^  %s: false" % key, "  %s: true" % key, out)
            assert flipped != out, "the memory section has no %s line: update this scenario" % key
            out = flipped
    return out


def scenario_cross_run_tools_off():
    """#4898: the shipped default config exposes no recall tool and loads no memory file, measured on this image's own Hermes. (1) The REAL gate on the
    shipped files: accepted, `selected_tools` and `resolved_tools` hold neither `memory` nor `session_search`, the positive control (`todo_list`) resolved
    and the gate saw both memory switches explicitly false. (2) The real Hermes modules on the shipped config with a MEMORY.md that holds the marker on
    the volume: neither tool, both switches false, no memory store built, so no marker can reach a prompt. (3) The control: the same probe on a copy with
    the tools switched on sees both tools, the store and the marker, so a probe that was blind would fail here."""
    install()
    rc, record, tail = run_gate()
    record = record or {}
    shipped = read(os.path.join(DATA, "config.yaml"))
    gate = {key: record.get(key) for key in ("ok", "problems", "config_accepted_as", "selected_tools", "resolved_tools", "memory_config")}
    return rc, {"ok": record.get("ok"), "problems": record.get("problems") or [], "gate": {"rc": rc, **gate},
                "real_shipped": recall_probe(shipped),
                "real_opened": recall_probe(with_recall_tools(shipped.decode("utf-8")).encode("utf-8"))}, tail


def scenario_cross_run_tools_on():
    """#4898: the real gate on single-fault copies of the shipped config, each refused by its OWN rule. The gate copy accepts the copy's bytes by hash
    (the same shape as `widened-plugin`), so what refuses is the rule under test and not the hash list. `session-search` and `memory-tool`: one toolset
    on, switches as shipped; `memory-switches`: both switches on, toolsets off; `provider`: an external memory provider named; `all-on`: everything."""
    install()
    shipped = read(os.path.join(DATA, "config.yaml")).decode("utf-8")
    gate_text = read(os.path.join(OORT, "lockgate.py")).decode("utf-8")
    assert sha(shipped.encode("utf-8")) in gate_text, "the gate does not carry the shipped config's hash"
    provider = re.sub(r"(?m)^(  user_profile_enabled: false.*)$", r"\1\n  provider: honcho", shipped)
    assert provider != shipped
    variants = {
        "session-search": with_recall_tools(shipped, ("session_search",), flags=False),
        "memory-tool": with_recall_tools(shipped, ("memory",), flags=False),
        "memory-switches": re.sub(r"(?m)^  (memory_enabled|user_profile_enabled): false", r"  \1: true", shipped),
        "provider": provider,
        "all-on": with_recall_tools(shipped),
    }
    result = {}
    for name, text in variants.items():
        assert text != shipped
        patched = "/tmp/lockgate_cross_run_%s.py" % name
        write(patched, gate_text.replace(sha(shipped.encode("utf-8")), sha(text.encode("utf-8"))).encode("utf-8"))
        install()
        write(os.path.join(DATA, "config.yaml"), text.encode("utf-8"))
        rc, record, tail = run_gate(gate=patched)
        record = record or {}
        result[name] = {"rc": rc, "accepted_as": record.get("config_accepted_as"), "problems": record.get("problems"),
                        "selected_tools": record.get("selected_tools"), "resolved_tools": record.get("resolved_tools"),
                        "memory_config": record.get("memory_config"), "tail": tail}
    return 0, {"ok": True, "problems": [], "variants": result}, None


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
