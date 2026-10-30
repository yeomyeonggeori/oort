#!/opt/hermes/.venv/bin/python
"""oort Hermes tool-lock gate (ADR-0203 D6, K4). Fail-closed. Python 3, stdlib + the image's own Hermes modules.

Why a gate: Hermes' platform toolset selection and deny-list do not enforce our exact allow-list, and its container boot
(`02-reconcile-profiles`) starts the gateway BEFORE the CMD runs. So the only place to refuse to start is
in front of the image entrypoint. This script is the allow-list that the deny-list lacks.

  lockgate.py gate   <config.yaml>   pre-start: replay seed -> migrate -> load in a SCRATCH HERMES_HOME,
                                     resolve what the api_server platform would expose, exit 3 unless
                                     every resolved tool is in ALLOWED_TOOLS (and env invariants hold).
  lockgate.py report                 post-start (background): wait for /health, then read the LIVE
                                     /v1/toolsets, re-resolve config (the API omits `search`), check auth/CORS/dashboard.
                                     SIGTERMs PID 1 on a definitive live tool-policy violation.

Exit codes (gate): 0 verified | 3 lock violated | 4 could not verify (also a failure).
Never prints secret values: only names, counts, booleans and the config sha256.

Image generation (#4820, ADR-0203 augmentation I1-I4). `image_generate` is allowed only with the Codex subscription
provider, and only together with the oort-owned `oort-image-guard` plugin (infra/hermes/plugins/oort-image-guard): a
`pre_tool_call` hook that refuses every `image_url` / `reference_image_urls` value that is not empty or a small inline
data:image picture, before the tool runs (Hermes would otherwise GET a model-chosen public address itself). When the
tool is exposed this gate requires, in this order: the plugin files under the Hermes volume are exactly the pinned
bytes; `plugins.enabled` is exactly the guard; no setting or environment variable that turns the guard or Hermes'
SSRF filter off (private-URL switches, proxies, safe mode, project plugins); and a CANARY: the verified plugin is
loaded into the scratch home and the real dispatch path (`_dispatch_pre_tool_call_hooks`, `handle_function_call`) is
called with refused and accepted examples against a stand-in handler, so a guard that is present but not consulted
is still refused. The stand-in is why a failing guard cannot reach the network from here.

Connector mode (#3948, ADR-0203 증보 K2·K4). The tool-lock rule above is unchanged. The one thing that
changes is `mcp_servers`:

  * empty (the D6 default)  -> nothing to judge, exactly as before.
  * non-empty               -> the operator is running a 「커넥터 시험」. The config is accepted ONLY if every
                               rule in `connector_problems` holds; any one failing is exit 3. There is no
                               separate switch to forget: writing an `mcp_servers` entry IS the opt-in, and it
                               is judged by the strict rules, never waved through.

Why the config and not the live toolsets: K-S1a measured that MCP tools are absent from `GET /v1/toolsets`
and that `agent.disabled_toolsets` does not block them, so `report` cannot see them. The gate therefore
inspects what Hermes would load (`mcp_servers`), and the post-start `report` keeps judging the toolsets it can
see. This gate checks the operator's CONFIG; whether the vendor server really exposes only the listed tools is
the operator's attestation (OORT_COHOSTED_AGENT_CONNECTORS_LOCKED), not something this script proves.
"""
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

IMAGE_GUARD_TOOL = "image_generate"
ALLOWED_TOOLS = frozenset({"memory", "todo_list", "session_search", "web_search", IMAGE_GUARD_TOOL})
WEB_TOOLS = frozenset({"web_search", "web_extract"})
IMAGE_TOOLS = frozenset({IMAGE_GUARD_TOOL})
IMAGE_PROVIDER = "openai-codex"  # the only image provider: gpt-image-2 through the Codex subscription OAuth (#4820)
# Another image provider's credential. Hermes' tool entry point probes FAL before the explicitly configured provider and falls
# through to FAL when plugin discovery raises (v0.22.2 tools/image_generation_tool.py), so a key here would be a second door.
IMAGE_KEY_ENV_NAMES = ("FAL_KEY",)
# The oort image guard (a Hermes user plugin). The sha256 values pin the two files of infra/hermes/plugins/oort-image-guard
# (test_image_guard.py recomputes both); the Railway start command checks the same hashes next to the decoded files and
# compose has no such line, so for compose this gate is the check. Editing a plugin file means updating the value here,
# and then the lockgate checksum in infra/railway/railway.json.
IMAGE_GUARD_PLUGIN = "oort-image-guard"
IMAGE_GUARD_MARKER = "[oort-image-guard]"  # the plugin's MARKER: every refusal it returns carries it
IMAGE_GUARD_FILES = {
    "__init__.py": "216d5bb13f01e2b887b88c821f42a327a5dd4119eb18c5f6743d94e72c3a9c92",
    "plugin.yaml": "791fefcef68dfe8b71f3eac7c685c6d9a0cc0de8f4214830d3be0ec3ab9de675",
}
# Environment names that undo the guard or Hermes' SSRF filter (tools/url_safety.py, hermes_cli/plugins.py v0.22.2).
IMAGE_ENV_FLAG_REASONS = {
    "HERMES_ALLOW_PRIVATE_URLS": "private-address blocking is off",
    "HERMES_SAFE_MODE": "Hermes skips every plugin, so the image guard would not load",
    "HERMES_ENABLE_PROJECT_PLUGINS": "a project plugin could replace the image guard",
}
IMAGE_PROVIDER_ONLY_KEYS = frozenset({"provider"})
REQUIRED_TOOL = "memory"  # positive control: the allow-list must resolve something real
INSTALL = "/opt/hermes"
TRUTHY = ("1", "true", "yes", "on")

# --- connector mode (K4) -------------------------------------------------------------------------------
APPS_ENV = "OORT_COHOSTED_AGENT_CONNECTOR_APPS"  # the same list as oort's env, set on THIS service too
PLUGIN_PREFIX = "com.momo.plugins."
PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")  # plugin_registry_id_ck
CONNECTOR_REQUIRED_DISABLED = ("cronjob", "delegation", "web", "image_gen")  # K4-1 on top of D6; image_gen: #4820 I3
HTTPS_URL_RE = re.compile(r"^https://[^\s]+$")  # one line, no whitespace: a value Hermes reads as ONE address
GLOB_CHARS = ("*", "?", "[")  # Hermes matches `tools.include` entries containing these as fnmatch globs


def app_server_key(app_id):
    """The `mcp_servers` key an oort app id must use. Hermes treats `foo-bar` and `foo_bar` alike (it sanitizes
    both), so the key is compared after the same normalization: the id without `com.momo.plugins.`, lowercase,
    with `-` and `.` turned into `_`. `com.momo.plugins.google-calendar` -> `google_calendar`."""
    name = app_id[len(PLUGIN_PREFIX):] if app_id.startswith(PLUGIN_PREFIX) else app_id
    return re.sub(r"[-.]", "_", name.lower())


def parse_apps(raw):
    """The operator's comma list -> distinct valid plugin ids, or None when any entry is malformed (all or nothing)."""
    apps = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        if not PLUGIN_ID_RE.match(part):
            return None
        if part not in apps:
            apps.append(part)
    return apps


def connector_problems(cfg, env):
    """Every reason a config with `mcp_servers` is NOT an acceptable 「커넥터 시험」. [] = acceptable (or no servers).

    Pure over a parsed config and an env mapping: no Hermes import, no I/O, so it is testable anywhere."""
    servers = cfg.get("mcp_servers")
    if not servers:
        return []
    problems = []
    if not isinstance(servers, dict):
        return ["mcp_servers must be a mapping of server name to settings"]
    apps = parse_apps(env.get(APPS_ENV, ""))
    if not apps:
        problems.append(f"connector mode needs {APPS_ENV} on this service (the same list oort holds), valid and non-empty")
        apps = []
    wanted = {}
    for app in apps:
        wanted.setdefault(app_server_key(app), app)
    have = {}
    for name in servers:
        key = re.sub(r"[-.]", "_", str(name).lower())
        if key in have:
            problems.append(f"mcp_servers has two entries that are the same server after normalization: {key}")
        have[key] = name
    for key in sorted(set(have) - set(wanted)):
        problems.append(f"mcp server {have[key]} is not one of the attested apps")
    for key in sorted(set(wanted) - set(have)):
        problems.append(f"attested app {wanted[key]} has no mcp_servers entry named {key}")
    for name, server in servers.items():
        label = f"mcp_servers.{name}"
        if not isinstance(server, dict):
            problems.append(f"{label} must be a mapping")
            continue
        if "command" in server or "args" in server:
            problems.append(f"{label} must be a remote server: command/args would run a local process")
        if not isinstance(server.get("url"), str) or not HTTPS_URL_RE.match(server["url"]):
            problems.append(f"{label}.url must be a single-line https:// address")
        # Hermes: a missing `trust` means FULL; only the literal value below keeps the write gate on.
        if server.get("trust") != "untrusted":
            problems.append(f"{label}.trust must be exactly 'untrusted' (missing means full)")
        # Hermes: `sampling.enabled` defaults to TRUE; only an explicit false turns the server's LLM requests off.
        sampling = server.get("sampling")
        if not isinstance(sampling, dict) or sampling.get("enabled") is not False:
            problems.append(f"{label}.sampling.enabled must be explicitly false (default is on)")
        tools = server.get("tools")
        # Hermes registers resource and prompt UTILITY tools (list/read_resource, list/get_prompt) per server
        # outside `tools.include`, and both default to ON: only an explicit false closes that second door.
        for door in ("resources", "prompts"):
            if not isinstance(tools, dict) or tools.get(door) is not False:
                problems.append(f"{label}.tools.{door} must be explicitly false (default is on, outside tools.include)")
        include = tools.get("include") if isinstance(tools, dict) else None
        if not isinstance(include, list) or not include or not all(isinstance(x, str) and x for x in include):
            problems.append(f"{label}.tools.include must be a non-empty list of tool names")
        elif any(ch in x for x in include for ch in GLOB_CHARS):
            problems.append(f"{label}.tools.include must list exact names, no globs")
    disabled = {str(x) for x in ((cfg.get("agent") or {}).get("disabled_toolsets") or [])}
    for toolset in CONNECTOR_REQUIRED_DISABLED:
        if toolset not in disabled:
            problems.append(f"agent.disabled_toolsets must include {toolset} in connector mode")
    return problems


def tool_problems(cfg, tools):
    """Judge pre-filter tool names at boot and observed live tools with the same policy (#4794, #4820).

    Search and image generation are subscription-only. A connector config narrows the allow-list back to
    chat-only even if Hermes ever stops honoring the required `disabled_toolsets: [web, image_gen]`.
    No credentials are read here.
    """
    tools = set(tools)
    problems = []
    extra = sorted(tools - ALLOWED_TOOLS)
    if extra:
        problems.append("tools outside the allow-list would be exposed: " + ",".join(extra))
    if cfg.get("mcp_servers") and tools & WEB_TOOLS:
        problems.append("connector mode forbids all web tools: " + ",".join(sorted(tools & WEB_TOOLS)))
    if cfg.get("mcp_servers") and tools & IMAGE_TOOLS:
        problems.append("connector mode forbids image generation: " + ",".join(sorted(tools & IMAGE_TOOLS)))
    if "web_search" in tools:
        web = cfg.get("web") or {}
        if not isinstance(web, dict) or web.get("search_backend") != "openai-native":
            problems.append("web.search_backend must be exactly 'openai-native' when web_search is exposed")
        if not isinstance(web, dict) or web.get("keyless_fallback") is not False:
            problems.append("web.keyless_fallback must be explicitly false when web_search is exposed")
    if tools & IMAGE_TOOLS:
        image = cfg.get("image_gen") or {}
        if not isinstance(image, dict) or image.get("provider") != IMAGE_PROVIDER:
            problems.append("image_gen.provider must be exactly 'openai-codex' when image_generate is exposed")
        elif set(image) - IMAGE_PROVIDER_ONLY_KEYS:
            # use_gateway / backend / model ... are other doors into Hermes' image routing (managed gateways, FAL).
            problems.append("image_gen must hold only 'provider' when image_generate is exposed (other keys: "
                            + ",".join(sorted(str(k) for k in set(image) - IMAGE_PROVIDER_ONLY_KEYS)) + ")")
    return problems


DATA_DIR = "/opt/data"  # the Hermes volume; the gate judges a scratch HERMES_HOME, so the volume's .env is read here
VOLUME_ENV_TRUTHY_KEYS = ("HERMES_YOLO_MODE", "HERMES_DASHBOARD")


def _read_env_pairs(env_path):
    """(pairs, problems) of the volume's `.env`: `(name, value)` per assignment line, read the way Hermes reads the file.

    `utf-8-sig` drops a leading byte order mark (PowerShell 5.1 and Notepad write one); plain utf-8 keeps U+FEFF on the
    first key name, so a rule about that line's name would never match. A missing file is fine (nothing there); an
    unreadable one is a problem."""
    try:
        with open(env_path, "r", encoding="utf-8-sig", errors="replace") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return [], []
    except OSError as exc:
        return [], [f"cannot read {env_path}: {type(exc).__name__}"]
    pairs = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        pairs.append((key, value.strip().strip("\"'").strip()))
    return pairs, []


def volume_env_problems(env_path):
    """Invariants a reused volume's own `.env` could undo after the gate passed (#4072 review M2).

    Hermes loads `<volume>/.env` after this gate has judged a scratch home, so a volume that was used by a
    less strict Hermes can carry YOLO / dashboard / CORS / a short API key. A fresh volume has no such lines.
    Only names are returned, never values. A missing file is fine (nothing there); an unreadable one is not."""
    pairs, problems = _read_env_pairs(env_path)
    for key, value in pairs:
        if key in VOLUME_ENV_TRUTHY_KEYS and value.lower() in TRUTHY:
            problems.append(f"the volume's .env enables {key}")
        elif key == "API_SERVER_CORS_ORIGINS" and value:
            problems.append("the volume's .env sets API_SERVER_CORS_ORIGINS")
        elif key == "API_SERVER_KEY" and len(value) < 32:
            problems.append("the volume's .env sets an API_SERVER_KEY shorter than 32 characters")
        elif key in IMAGE_KEY_ENV_NAMES and value:
            problems.append(f"the volume's .env sets {key} (another image provider's credential)")
    return problems


# --- image generation guard (#4820 security review, ADR-0203 I2) -------------------------------------------------
def _truthy(value):
    """Hermes' `is_truthy_value`: a string is true only for 1/true/yes/on, anything else by `bool()`."""
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().lower() in TRUTHY
    return bool(value)


def _is_proxy_name(name):
    """`*_PROXY` in any case except NO_PROXY (a bypass list, not a proxy). tools/url_safety.py treats HTTP(S)_PROXY and
    ALL_PROXY as 'delegate DNS to the proxy', and httpx sends proxied requests without a connect-time check."""
    upper = str(name).upper()
    return upper.endswith("_PROXY") and upper != "NO_PROXY"


def image_environment_problems(pairs, where):
    """Names (never values) in one environment source that turn Hermes' SSRF filter or the image guard off."""
    problems, seen = [], set()
    for name, value in pairs:
        if name in seen:
            continue
        value = str(value).strip()
        if name in IMAGE_ENV_FLAG_REASONS and _truthy(value):
            problems.append(f"{where} enables {name} ({IMAGE_ENV_FLAG_REASONS[name]})")
            seen.add(name)
        elif _is_proxy_name(name) and value:
            problems.append(f"{where} sets {name} (a proxy: Hermes hands DNS and the final-target check to it)")
            seen.add(name)
    return problems


def image_volume_env_problems(env_path):
    pairs, problems = _read_env_pairs(env_path)
    return problems + image_environment_problems(pairs, "the volume's .env")


def image_ssrf_config_problems(cfg):
    """Settings that turn Hermes' private-address filter off (config.yaml `security`/`browser`)."""
    problems = []
    for section in ("security", "browser"):
        block = cfg.get(section)
        if isinstance(block, dict) and _truthy(block.get("allow_private_urls")):
            problems.append(f"{section}.allow_private_urls is enabled (private-address blocking is off)")
    security = cfg.get("security")
    ranges = security.get("fake_ip_ranges") if isinstance(security, dict) else None
    if (isinstance(ranges, str) and ranges.strip()) or (isinstance(ranges, (list, tuple)) and ranges):
        problems.append("security.fake_ip_ranges is set (a declared block is dialed instead of refused as private)")
    return problems


def image_guard_config_problems(cfg):
    """The guard is enabled, alone, and runs inside the Hermes process (where the verified path is)."""
    plugins = cfg.get("plugins")
    plugins = plugins if isinstance(plugins, dict) else {}
    problems = []
    enabled = plugins.get("enabled")
    if not isinstance(enabled, list) or [str(x) for x in enabled] != [IMAGE_GUARD_PLUGIN]:
        problems.append(f"plugins.enabled must be exactly [{IMAGE_GUARD_PLUGIN}] when image_generate is exposed")
    disabled = plugins.get("disabled")
    if isinstance(disabled, list) and IMAGE_GUARD_PLUGIN in {str(x) for x in disabled}:
        problems.append(f"plugins.disabled lists {IMAGE_GUARD_PLUGIN}")
    isolation = plugins.get("isolation", "in_process")
    if not isinstance(isolation, str) or isolation.strip().lower() != "in_process":
        problems.append("plugins.isolation must be in_process when image_generate is exposed (a plugin host moves the hook "
                        "out of the verified path)")
    return problems


def read_image_guard_files(data_dir):
    """(files, problems): the plugin directory under the Hermes volume must hold exactly the two pinned regular files.

    `files` maps name -> the bytes that were read and hashed (None when anything is wrong), so the canary runs THESE
    bytes and never a file that changed between the check and the load. Names only in problems."""
    root = os.path.join(data_dir, "plugins", IMAGE_GUARD_PLUGIN)
    label = f"plugins/{IMAGE_GUARD_PLUGIN}"
    if os.path.islink(root) or not os.path.isdir(root):
        return None, [f"the image guard plugin is not installed at {label} under the Hermes data volume"]
    try:
        present = sorted(os.listdir(root))
    except OSError as exc:
        return None, [f"cannot list {label}: {type(exc).__name__}"]
    problems = []
    # Nothing else may sit beside the two pinned files: Python would read a valid bytecode cache in place of the source,
    # and the image sets PYTHONDONTWRITEBYTECODE=1, so a healthy volume never has one.
    extra = [name for name in present if name not in IMAGE_GUARD_FILES]
    if extra:
        problems.append(f"{label} holds files that are not part of the guard: {','.join(extra)}")
    files = {}
    for name, want in IMAGE_GUARD_FILES.items():
        path = os.path.join(root, name)
        if name not in present:
            problems.append(f"{label}/{name} is missing")
            continue
        if os.path.islink(path) or not os.path.isfile(path):
            problems.append(f"{label}/{name} is not a regular file")
            continue
        try:
            with open(path, "rb") as handle:
                raw = handle.read()
        except OSError as exc:
            problems.append(f"cannot read {label}/{name}: {type(exc).__name__}")
            continue
        if hashlib.sha256(raw).hexdigest() != want:
            problems.append(f"{label}/{name} does not match the pinned sha256")
            continue
        files[name] = raw
    return (None if problems else files), problems


def install_image_guard(scratch, files):
    """Write the verified bytes into the scratch home's plugin directory (before any Hermes module is imported)."""
    root = os.path.join(scratch, "plugins", IMAGE_GUARD_PLUGIN)
    os.makedirs(root)
    for name, raw in files.items():
        with open(os.path.join(root, name), "wb") as handle:
            handle.write(raw)


_CANARY_PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
# `.invalid` never resolves (RFC 2606) and the stand-in handler below means nothing is fetched even when the guard fails.
IMAGE_GUARD_CANARY_REFUSED = (
    ("image_url", "https://canary.invalid/x.png?q=conversation"),
    ("image_url", "HTTP://CANARY.INVALID/X"),
    ("image_url", " https://canary.invalid/x"),
    ("image_url", "file:///etc/passwd"),
    ("image_url", "/etc/passwd"),
    ("image_url", "./x.png"),
    ("image_url", "data:text/html;base64,AAAA"),
    ("reference_image_urls", ["https://canary.invalid/x.png"]),
    ("reference_image_urls", [_CANARY_PNG, "http://canary.invalid/y"]),
    ("reference_image_urls", "https://canary.invalid/x"),
)
IMAGE_GUARD_CANARY_ACCEPTED = (
    {"prompt": "canary"},
    {"prompt": "canary", "image_url": ""},
    {"prompt": "canary", "image_url": _CANARY_PNG},
    {"prompt": "canary", "reference_image_urls": [_CANARY_PNG]},
)


class _CanarySpy:
    """Stands in for image_generate's real handler while the canary runs: records the call and does nothing else."""

    def __init__(self):
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append(dict(args))
        return json.dumps({"success": True, "canary_spy": True})


def run_image_guard_canary(hook_block, call_tool, install_spy):
    """Exercise the dispatch path with refused and accepted image_generate calls. Returns (problems, evidence).

    hook_block(args, call_id) -> block message or None (what the agent loop asks the hooks);
    call_tool(args, call_id)  -> the result text of the full tool call (what the registry dispatch returns);
    install_spy(spy)          -> restore callable (the registered handler is replaced by `spy` until restored).
    Refused examples must be blocked by this guard's marker and never reach the handler; accepted ones must reach the
    handler exactly once, which is also the positive control that the path is live. Labels only, never a value."""
    import copy
    spy = _CanarySpy()
    restore = install_spy(spy)
    problems = []
    evidence = {"refused": 0, "accepted": 0}
    serial = [0]

    def call_id():
        serial[0] += 1
        return f"lockgate-canary-{serial[0]}"

    try:
        for index, (field, value) in enumerate(IMAGE_GUARD_CANARY_REFUSED):
            label = f"{field}#{index}"
            blocked = hook_block({"prompt": "canary", field: copy.deepcopy(value)}, call_id())
            if not (isinstance(blocked, str) and IMAGE_GUARD_MARKER in blocked):
                problems.append(f"canary: the pre_tool_call hooks did not refuse the example {label}")
            del spy.calls[:]
            result = call_tool({"prompt": "canary", field: copy.deepcopy(value)}, call_id())
            if spy.calls or not (isinstance(result, str) and IMAGE_GUARD_MARKER in result):
                problems.append(f"canary: image_generate was not refused before running for the example {label}")
            evidence["refused"] += 1
        for index, args in enumerate(IMAGE_GUARD_CANARY_ACCEPTED):
            label = f"accepted#{index}"
            if hook_block(copy.deepcopy(args), call_id()) is not None:
                problems.append(f"canary: the pre_tool_call hooks refused the allowed example {label}")
            del spy.calls[:]
            result = call_tool(copy.deepcopy(args), call_id())
            if len(spy.calls) != 1 or "canary_spy" not in str(result):
                problems.append(f"canary: the allowed example {label} did not reach image_generate exactly once")
            evidence["accepted"] += 1
    finally:
        restore()
    return problems, evidence


def hermes_image_guard_canary():
    """The canary against the real Hermes dispatch path. HERMES_HOME must be the scratch home holding the verified
    plugin, and model_tools must have been imported after that (its import runs plugin discovery)."""
    from hermes_cli.plugins import _dispatch_pre_tool_call_hooks, get_plugin_manager
    from model_tools import handle_function_call
    from tools.registry import registry

    entry = registry.get_entry(IMAGE_GUARD_TOOL)
    if entry is None:
        return [f"canary: {IMAGE_GUARD_TOOL} is not registered, so the guard cannot be exercised"], {}
    who = {"task_id": "lockgate-canary", "session_id": "lockgate-canary"}

    def hook_block(args, call_id):
        return _dispatch_pre_tool_call_hooks(IMAGE_GUARD_TOOL, args, tool_call_id=call_id, turn_id=call_id,
                                             api_request_id=call_id, **who)[0]

    def call_tool(args, call_id):
        return handle_function_call(IMAGE_GUARD_TOOL, args, tool_call_id=call_id, turn_id=call_id,
                                    api_request_id=call_id, enabled_tools=[IMAGE_GUARD_TOOL], **who)

    def install_spy(spy):
        handler, is_async = entry.handler, entry.is_async
        entry.handler, entry.is_async = spy, False

        def restore():
            entry.handler, entry.is_async = handler, is_async
        return restore

    problems, evidence = run_image_guard_canary(hook_block, call_tool, install_spy)
    try:  # evidence and diagnosis only; the verdict above comes from behavior, not from this listing
        evidence["plugin"] = [{k: p.get(k) for k in ("name", "source", "enabled", "hooks", "error")}
                              for p in get_plugin_manager().list_plugins() if p.get("name") == IMAGE_GUARD_PLUGIN]
    except Exception as exc:
        evidence["plugin"] = f"unavailable: {type(exc).__name__}"
    if problems:
        problems.append(f"canary: plugin state {json.dumps(evidence['plugin'], sort_keys=True)[:300]}")
    return problems, evidence


def emit(tag, **fields):
    print(tag + " " + json.dumps(fields, sort_keys=True), flush=True)


def gate(cfg_path):
    problems = []
    try:
        raw = open(cfg_path, "rb").read()
    except Exception as exc:  # unreadable config is a failure, never a pass
        emit("LOCKGATE", ok=False, problems=[f"cannot read config: {type(exc).__name__}"])
        return 4
    sha = hashlib.sha256(raw).hexdigest()

    env = os.environ
    original_env = dict(os.environ)  # the container's own environment, before HOME/HERMES_HOME are redirected below
    if env.get("HERMES_YOLO_MODE", "").strip().lower() in TRUTHY:
        problems.append("HERMES_YOLO_MODE is enabled")
    if env.get("API_SERVER_CORS_ORIGINS", "").strip():
        problems.append("API_SERVER_CORS_ORIGINS is not empty")
    if len(env.get("API_SERVER_KEY", "")) < 32:
        problems.append("API_SERVER_KEY is shorter than 32 characters")
    if env.get("HERMES_DASHBOARD", "").strip().lower() in TRUTHY:
        problems.append("HERMES_DASHBOARD is enabled")
    for name in IMAGE_KEY_ENV_NAMES:
        if env.get(name, "").strip():
            problems.append(f"{name} is set (another image provider's credential)")

    data_dir = os.environ.get("HERMES_DATA_DIR", DATA_DIR)
    problems.extend(volume_env_problems(os.path.join(data_dir, ".env")))
    # The guard's bytes are read and hashed ONCE here; the scratch home gets exactly these bytes. Whether a missing or
    # edited guard matters depends on the tool being exposed, which is only known after the config is resolved.
    guard_files, guard_file_problems = read_image_guard_files(data_dir)

    scratch = tempfile.mkdtemp(prefix="lockgate-")
    try:
        shutil.copyfile(cfg_path, os.path.join(scratch, "config.yaml"))
        if guard_files:
            install_image_guard(scratch, guard_files)  # before any Hermes import: model_tools runs plugin discovery
        os.environ["HERMES_HOME"] = scratch
        os.environ["HOME"] = scratch
        os.environ.pop("HERMES_CONFIG", None)
        os.environ.pop("HERMES_PROFILE", None)
        # The same schema migration stage2 runs on the real volume, here on the scratch copy.
        mig = subprocess.run([sys.executable, os.path.join(INSTALL, "scripts", "docker_config_migrate.py")],
                             cwd=INSTALL, env=os.environ, capture_output=True, text=True, timeout=120)
        migrate_rc = mig.returncode
        sys.path.insert(0, INSTALL)
        from hermes_cli.config import load_config  # noqa: E402  (must import after HERMES_HOME is set)
        from hermes_cli.tools_config import _get_platform_tools  # noqa: E402
        from model_tools import _select_tool_names, get_tool_definitions  # noqa: E402

        cfg = load_config()
        agent = cfg.get("agent") or {}
        disabled = [str(x) for x in (agent.get("disabled_toolsets") or [])]
        enabled = sorted(_get_platform_tools(cfg, "api_server"))
        # Superset on purpose: names requested by the toolset selection BEFORE any check_fn filtering.
        selected = sorted(_select_tool_names(enabled, disabled, True))
        defs = get_tool_definitions(enabled_toolsets=enabled, disabled_toolsets=disabled, quiet_mode=True,
                                    skip_tool_search_assembly=True)
        resolved = sorted({d["function"]["name"] for d in defs})

        problems.extend(tool_problems(cfg, selected))
        guard_evidence = None
        if set(selected) & IMAGE_TOOLS:
            problems.extend(guard_file_problems)
            problems.extend(image_guard_config_problems(cfg))
            problems.extend(image_ssrf_config_problems(cfg))
            problems.extend(image_environment_problems(original_env.items(), "the process environment"))
            problems.extend(image_volume_env_problems(os.path.join(data_dir, ".env")))
            guard_evidence = {"files": sorted(IMAGE_GUARD_FILES), "files_verified": guard_files is not None}
            if guard_files is not None:  # never run bytes that did not match the pinned hashes
                canary_problems, canary_evidence = hermes_image_guard_canary()
                problems.extend(canary_problems)
                guard_evidence["canary"] = canary_evidence
        if REQUIRED_TOOL not in resolved:
            problems.append(f"positive control failed: {REQUIRED_TOOL} did not resolve (gate cannot be trusted)")
        problems.extend(connector_problems(cfg, os.environ))
        approvals = cfg.get("approvals") or {}
        mode = str(approvals.get("mode", "smart")).strip().lower()
        if mode not in ("manual", "smart"):
            problems.append(f"approvals.mode must be manual or smart (got {mode or 'empty'})")
        if str(approvals.get("unattended_mode", "deny")).strip().lower() != "deny":
            problems.append("approvals.unattended_mode must be deny")
        shared = ((cfg.get("telemetry") or {}).get("shared_metrics") or {})
        if shared.get("send") or shared.get("enabled"):
            problems.append("telemetry.shared_metrics must stay disabled")
        ok = not problems
        emit("LOCKGATE", ok=ok, config_sha256=sha, migrate_rc=migrate_rc, disabled_count=len(disabled),
             enabled_toolsets=enabled, selected_tools=selected, resolved_tools=resolved,
             approvals_mode=mode, image_guard=guard_evidence, problems=problems)
        return 0 if ok else 3
    except SystemExit:
        raise
    except BaseException as exc:  # any failure to verify is a failure
        emit("LOCKGATE", ok=False, config_sha256=sha, problems=problems + [f"could not verify: {type(exc).__name__}: {str(exc)[:160]}"])
        return 4
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _status(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)
    except Exception:
        return 0, {}


def report():
    key = os.environ.get("API_SERVER_KEY", "")
    port = os.environ.get("API_SERVER_PORT", "8642")
    # `0.0.0.0` is IPv4-only and `::` is IPv6-only for this server (asyncio sets V6ONLY): dial the matching loopback.
    loop = "[::1]" if ":" in os.environ.get("API_SERVER_HOST", "0.0.0.0") else "127.0.0.1"
    base = f"http://{loop}:{port}"
    deadline = time.time() + 240
    while time.time() < deadline:
        if _status(base + "/health")[0] == 200:
            break
        time.sleep(2)
    else:
        emit("LOCKREPORT", ok=False, why="health did not become ready in 240s")
        return 1
    auth = {"Authorization": "Bearer " + key}
    data, last = None, ""
    for _attempt in range(4):  # a cold or emulated start can be slow: retry before calling it unreadable
        try:
            with urllib.request.urlopen(urllib.request.Request(base + "/v1/toolsets", headers=auth), timeout=30) as r:
                data = json.loads(r.read().decode())["data"]
            break
        except Exception as exc:
            last = type(exc).__name__
            time.sleep(5)
    if data is None:
        emit("LOCKREPORT", ok=False, why=f"/v1/toolsets unreadable after 4 tries: {last}")
        return 1
    enabled = sorted(t["name"] for t in data if t.get("enabled"))
    tools = sorted({x for t in data if t.get("enabled") for x in t.get("tools", [])})
    try:
        sys.path.insert(0, INSTALL)
        from hermes_cli.config import load_config  # noqa: E402
        from hermes_cli.tools_config import _get_platform_tools  # noqa: E402
        from model_tools import _select_tool_names  # noqa: E402
        live_cfg = load_config()
        # v0.22.2 /v1/toolsets enumerates configurable categories only: the `search` toolset is absent.
        # Re-resolve the config as well, keeping inferred names separate from observed API names below.
        disabled = (live_cfg.get("agent") or {}).get("disabled_toolsets") or []
        selected = sorted(_select_tool_names(sorted(_get_platform_tools(live_cfg, "api_server")), disabled, True))
        violations = tool_problems(live_cfg, set(tools) | set(selected))
        if (set(tools) | set(selected)) & IMAGE_TOOLS:
            # Files, config and environment again on the live volume; the canary needs the scratch home, so it is boot-only.
            data_dir = os.environ.get("HERMES_DATA_DIR", DATA_DIR)
            violations += read_image_guard_files(data_dir)[1]
            violations += image_guard_config_problems(live_cfg) + image_ssrf_config_problems(live_cfg)
            violations += image_environment_problems(os.environ.items(), "the process environment")
            violations += image_volume_env_problems(os.path.join(data_dir, ".env"))
    except Exception as exc:
        emit("LOCKREPORT", ok=False, why=f"cannot verify live tool policy: {type(exc).__name__}")
        return 1
    dash = False
    try:
        socket.create_connection(("127.0.0.1", 9119), timeout=1).close()
        dash = True
    except OSError:
        pass
    checks = {
        "tools_within_policy": not violations,
        "models_requires_auth": _status(base + "/v1/models")[0] == 401,
        "toolsets_requires_auth": _status(base + "/v1/toolsets")[0] == 401,
        "wrong_key_rejected": _status(base + "/v1/models", {"Authorization": "Bearer " + "x" * 40})[0] == 401,
        "cors_closed": "Access-Control-Allow-Origin" not in _status(
            base + "/v1/models", {**auth, "Origin": "https://evil.example"})[1],
        "dashboard_9119_closed": not dash,
    }
    ok = all(checks.values())
    emit("LOCKREPORT", ok=ok, enabled_toolsets=enabled, live_tools=tools, selected_tools=selected,
         unreported_selected_tools=sorted(set(selected) - set(tools)), checks=checks, problems=violations)
    if violations:  # definitive violation: do not keep serving
        emit("LOCKREPORT", ok=False, action="SIGTERM pid 1", problems=violations)
        os.kill(1, signal.SIGTERM)
        return 3
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "gate":
        sys.exit(gate(sys.argv[2]))
    if len(sys.argv) >= 2 and sys.argv[1] == "report":
        sys.exit(report())
    print("usage: lockgate.py gate <config.yaml> | report", file=sys.stderr)
    sys.exit(2)
