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

The guard has one narrow exception (owner 10-30 decision, #4820 C2a): `image_url` may also be exactly this instance's own
short-lived photo address under `OORT_SELF_MEDIA_ORIGIN`. This gate validates that variable's format (process environment
and the volume's `.env`; unset means the exception is off), and the canary adds the one allowed address (accepted) and
28 bypass variants (refused) when it is set, or one refused address of the allowed shape when it is not.

Strict media delivery (#4820 C2b 3부, ADR-0218 G3.7 (b)). Hermes turns a `MEDIA:` line of a final answer into the bytes of
the file it names; outside strict mode that is ANY readable regular file that is not on a short denylist (gateway/platforms/
base.py `validate_media_delivery_path`), so a model that was talked into writing `MEDIA:/opt/data/...` hands that file to the
person who asked. oort's hosted expression door reads its picture out of exactly such an answer, so when `image_generate` is
exposed this gate requires `HERMES_MEDIA_DELIVERY_STRICT=1` in the process environment (exactly `1`: Hermes itself also takes
true/yes/on, but one spelling leaves no judgement about what an operator meant) and refuses the name in the volume's `.env`
(loaded into the Hermes process after this gate ran, it could replace the checked value, whatever its own value is). `report`
re-checks both on the live volume. The worker half is `OORT_HOSTED_MEDIA_STRICT` (the door opens only with both).

The volume's `.env` (#4886). Hermes loads `<HERMES_HOME>/.env` after this gate ran and its values replace what was judged, so the file
is read the way Hermes reads it (hermes_cli/env_loader.py, v0.22.2): `env_text` (its decoding and the NUL / whitespace clean-up it
applies before loading), python-dotenv's own statement parser with interpolation off (the image's module; outside the image, e.g. the
offline tests, a fallback with the same grammar), then the `${VAR}` / `${VAR:-default}` references resolved the way Hermes resolves them
right after parsing (against the environment and the file's earlier values), the last assignment of a name winning. A name this gate
judges may not be given a value that holds a reference at all (`${...}` or `$NAME`): Hermes resolves `${...}` in ITS process environment,
which has variables this gate's shell does not (its service slot adds some), so what the gate computed and what Hermes ends with can
differ, and nothing can be proven about such a value from here. The data folder this gate reads must be Hermes' own `$HERMES_HOME`,
written out (`~` and `$HOME` mean another folder under Hermes' HOME than under this gate's), or the file judged is not the file loaded.
The LOCKGATE line names the parser used.

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
import codecs
import hashlib
import io
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
    "__init__.py": "c84147c4bfdd15914b11447c39311225b21017e3f1e317c4329bb422f5be639f",
    "plugin.yaml": "10d3fd436927cf819380016614edbe12d029d372a2bd995da128726d905bc936",
}
# Environment names that undo the guard or Hermes' SSRF filter (tools/url_safety.py, hermes_cli/plugins.py v0.22.2).
IMAGE_ENV_FLAG_REASONS = {
    "HERMES_ALLOW_PRIVATE_URLS": "private-address blocking is off",
    "HERMES_SAFE_MODE": "Hermes skips every plugin, so the image guard would not load",
    "HERMES_ENABLE_PROJECT_PLUGINS": "a project plugin could replace the image guard",
}
IMAGE_PROVIDER_ONLY_KEYS = frozenset({"provider"})
# The one narrow exception of the guard (owner 10-30 decision, #4820 C2a): `image_url` may also be this instance's own
# short-lived photo address. The origin is this variable; the path prefix is fixed in the plugin. The grammar below is the
# plugin's and the Rust worker's (infra/hermes/self_media_vectors.json is the shared accept/reject list all three are
# tested against). Unset (or empty) the exception is off; set to anything that is not canonical the start is refused;
# in the volume's `.env` it is refused outright, because Hermes loads that file into the process after this gate ran.
SELF_ORIGIN_ENV = "OORT_SELF_MEDIA_ORIGIN"
SELF_MEDIA_PATH_PREFIX = "/v1/self-media/"
# Hermes' media delivery policy (#4820 C2b 3부): required in the process environment, exactly this value, whenever the picture
# tool is exposed; refused in the volume's `.env` whatever its value, in every spelling python-dotenv accepts (#4886). Only this exact
# name is judged: the widening siblings HERMES_MEDIA_ALLOW_DIRS / HERMES_MEDIA_TRUST_RECENT_* are not (a follow-up, not #4886).
MEDIA_STRICT_ENV = "HERMES_MEDIA_DELIVERY_STRICT"
MEDIA_STRICT_VALUE = "1"
SELF_ORIGIN_RE = re.compile(
    r"https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?"
)
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
# Every name `volume_env_problems` judges by its value. A value that holds a reference is refused for these (`_referenced_names`).
VOLUME_ENV_JUDGED = frozenset(VOLUME_ENV_TRUTHY_KEYS + ("API_SERVER_CORS_ORIGINS", "API_SERVER_KEY") + IMAGE_KEY_ENV_NAMES)

# --- the volume's `.env`, read the way Hermes reads it (#4886) ---------------------------------------------------------------
try:  # the image's own parser; the fallback below is for runs without it (the offline tests)
    from dotenv.main import DotEnv as _DotEnv
    try:
        from importlib.metadata import version as _distribution_version
        _DOTENV_VERSION = _distribution_version("python-dotenv")
    except Exception:  # a version we cannot name is still the module Hermes uses
        _DOTENV_VERSION = "unknown"
except Exception:  # missing, or broken enough to raise anything: never a reason to skip the gate; the fallback judges instead
    _DotEnv, _DOTENV_VERSION = None, None

# The same statements as python-dotenv's parser (parser.py, BSD-3-Clause, https://github.com/theskumar/python-dotenv), written out
# again for runs where the module is absent. infra/hermes/test_lockgate_env.py holds both to one table of inputs.
_RX = {name: re.compile(pattern) for name, pattern in {
    "blank_lines": r"\s*",
    "blanks": r"[^\S\r\n]*",
    "export": r"(?:export[^\S\r\n]+)?",
    "quoted_key": r"'([^']+)'",
    "key": r"([^=\#\s]+)",
    "equals": r"=[^\S\r\n]*",
    "single_value": r"'((?:\\'|[^'])*)'",
    "double_value": r'"((?:\\"|[^"])*)"',
    "bare_value": r"[^\r\n]*",
    "comment": r"(?:[^\S\r\n]*#[^\r\n]*)?",
    "line_end": r"[^\S\r\n]*(?:\r\n|\n|\r|$)",
    "rest_of_line": r"[^\r\n]*(?:\r|\n|\r\n)?",
    "double_escape": r"\\[\\'\"abfnrtv]",
    "single_escape": r"\\[\\']",
}.items()}
_TRAILING_COMMENT_RE = re.compile(r"\s+#.*")
_REFERENCE_RE = re.compile(r"\$\{([^}:]*)(?::-([^}]*))?\}")  # python-dotenv's `${NAME}` / `${NAME:-default}`
# What counts as "a reference" in a judged value: `${` (Hermes resolves `${NAME}` / `${NAME:-default}`; an unclosed one is refused
# too) or a bare `$NAME` (Hermes leaves it as it is, but it is the other spelling of the same thing and nothing here reads a
# judged value through it, so it is refused as well).
_REFERENCE_SHAPE_RE = re.compile(r"\$(?:\{|[A-Za-z_])")


class _Unreadable(Exception):
    pass


def _fallback_assignments(text):
    """`(name, value)` per statement of `text`, like python-dotenv's `DotEnv(..., interpolate=False).parse()`: `value` is None for a
    bare `NAME`, and a statement the grammar cannot read is dropped up to the end of the line it failed on."""
    out, pos, end = [], 0, len(text)

    def take(piece):  # the next piece of the statement; it has to be there
        nonlocal pos
        match = _RX[piece].match(text, pos)
        if match is None:
            raise _Unreadable()
        pos = match.end()
        return match

    def unescape(piece, value):
        return _RX[piece].sub(lambda m: codecs.decode(m.group(0), "unicode-escape"), value)

    while pos < end:
        try:
            take("blank_lines")
            if pos >= end:
                break
            take("export")
            ahead = text[pos:pos + 1]
            name = None if ahead == "#" else take("quoted_key" if ahead == "'" else "key").group(1)
            take("blanks")
            value = None
            if text[pos:pos + 1] == "=":
                take("equals")
                ahead = text[pos:pos + 1]
                if ahead == "'":
                    value = unescape("single_escape", take("single_value").group(1))
                elif ahead == '"':
                    value = unescape("double_escape", take("double_value").group(1))
                elif ahead in ("", "\n", "\r"):
                    value = ""
                else:
                    value = _TRAILING_COMMENT_RE.sub("", take("bare_value").group(0)).rstrip()
            take("comment")
            take("line_end")
        except _Unreadable:
            take("rest_of_line")
            continue
        if name is not None:
            out.append((name, value))
    return out


def _real_assignments(text):
    """Exactly the call Hermes makes (env_loader `_load_dotenv_with_fallback`): its interpolation happens afterwards."""
    return list(_DotEnv(dotenv_path=None, stream=io.StringIO(text), interpolate=False).parse())


def dotenv_assignments(text):
    return _real_assignments(text) if _DotEnv is not None else _fallback_assignments(text)


def env_parser():
    """Which parser read the volume's `.env`: named in the LOCKGATE line, so a proof can tell the image's from the fallback."""
    return {"impl": "python-dotenv", "version": _DOTENV_VERSION} if _DotEnv is not None else {"impl": "fallback"}


def env_text(raw):
    """The text Hermes' loader ends up parsing for these bytes (hermes_cli/env_loader.py v0.22.2), or None when that is not one
    answer. UTF-16 is decoded by its byte order mark, anything else as `utf-8-sig`; bytes that are not UTF-8 give None: its
    sanitizer may rewrite such a file in place (bad bytes become U+FFFD) or leave it for the loader to read as Latin-1, the two
    texts differ, and no reading of either one would be safe. Then the two things its sanitizer does to a text: NUL bytes are
    dropped and every line that is neither blank nor a comment is stripped (lines end at CRLF, CR or LF only, not at the other
    separators `str.splitlines` knows). It never splits a line in v0.22.2.

    Then the byte order marks, exactly as many as the loader strips and no more. `str.strip` does not count U+FEFF as blank, so after
    the clean-up a mark can sit at the front of the first line (a second mark, or one behind blanks the clean-up stripped). When the
    sanitizer REWRITES the file (a NUL, a line it changed, a last line with no newline, any UTF-16 file), the loader decodes the new
    file as `utf-8-sig` once more and strips one mark; when it does not rewrite, the loader reads the original bytes and the one
    mark `utf-8-sig` took above is all that went. A mark that stays is part of the first name for Hermes and is read as such here:
    dropping every leading mark instead would read that name differently and could move where the first statement ends, which moves
    the statements after it. A mark anywhere else stays too, as it does for Hermes: there it makes another name."""
    text, utf16 = None, False
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) and not raw.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        try:
            text, utf16 = raw.decode("utf-16"), True
        except UnicodeDecodeError:
            text = None
    if text is None:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return None
    lines = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    complete = lines[-1] == ""  # the text is empty or ends with a newline
    if complete:
        lines.pop()
    kept = []
    for line in lines:
        stripped = line.strip()
        kept.append(line if not stripped or stripped.startswith("#") else stripped)
    cleaned = "".join(line + "\n" for line in kept)
    rewritten = utf16 or "\x00" in text or not complete or kept != lines
    if rewritten and cleaned.startswith("\ufeff"):
        cleaned = cleaned[1:]
    return cleaned


def _resolve_references(assignments, lookup_env):
    """Hermes interpolates every value right after parsing (`${NAME}`, `${NAME:-default}`): the value NAME has among the file's
    earlier assignments, else in the environment, else the default, else empty. A name given no value (bare `NAME`) is empty."""
    resolved, out = {}, []
    for name, value in assignments:
        if value is not None:
            lookup = {**lookup_env, **resolved}
            value = _REFERENCE_RE.sub(lambda m: _none_is_empty(lookup.get(m.group(1), m.group(2) or "")), value)
        resolved[name] = value
        out.append((name, value))
    return out


def _none_is_empty(value):
    return "" if value is None else value


def _read_env_file(env_path, lookup_env=None):
    """(assignments, pairs, problems) of the volume's `.env`. `assignments` are `(name, value)` per statement in file order as the parser
    gave them, BEFORE any `${...}` is resolved; `pairs` are the same statements after Hermes' own resolution, read the way Hermes
    reads the file (see the module docstring). `value` is None for a bare `NAME`: Hermes sets nothing for it. A name may repeat; the
    last one is in force (callers use `dict(pairs)`). `lookup_env` is the environment `${NAME}` references resolve against (default:
    this process). A missing file is fine (nothing there); an unreadable one, or one that is not valid UTF-8 (`env_text`), is a problem."""
    try:
        with open(env_path, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return [], [], []
    except OSError as exc:
        return [], [], [f"cannot read {env_path}: {type(exc).__name__}"]
    text = env_text(raw)
    if text is None:
        return [], [], ["the volume's .env is not valid UTF-8 (Hermes may repair it in place or read it as Latin-1, and the gate cannot tell which)"]
    try:
        assignments = dotenv_assignments(text)
    except Exception as exc:  # a file the parser could not read is never taken for an empty one
        return [], [], [f"cannot parse the volume's .env: {type(exc).__name__}"]
    return assignments, _resolve_references(assignments, os.environ if lookup_env is None else lookup_env), []


def _read_env_pairs(env_path, lookup_env=None):
    """(pairs, problems): `_read_env_file` without the statements as parsed."""
    _, pairs, problems = _read_env_file(env_path, lookup_env)
    return pairs, problems


def _referenced_names(assignments, judged):
    """The names, in file order, for which `judged(name)` holds and whose value in force (the last assignment, as parsed, before any
    `${...}` is resolved) holds a reference: `${NAME}`, `${NAME:-default}` or `$NAME`. Hermes resolves `${...}` against its own process
    environment, not this gate's, so no verdict on such a value from here is worth anything: the name is refused for the reference
    itself. A bare `NAME` (no value) sets nothing in Hermes and holds no reference."""
    final = dict(assignments)
    return [name for name in final
            if judged(name) and final[name] is not None and _REFERENCE_SHAPE_RE.search(final[name]) is not None]


def _reference_problem(where, name):
    return (f"{where} sets {name} through a reference (${{...}} or $NAME): Hermes resolves it in its own environment, "
            "so what this gate reads is not what Hermes applies")


_HOME_REFERENCE_RE = re.compile(r"\$(?:\{HOME\}|HOME(?!\w))", re.ASCII)  # `$HOME` / `${HOME}` the way `os.path.expandvars` reads them


def hermes_home_problems(env, data_dir):
    """The folder this gate reads the volume's `.env` from must be Hermes' own `$HERMES_HOME` (hermes_constants `get_hermes_home`:
    the variable with `$VAR` and `~` expanded). Anything else, or no variable at all, and the file judged is not the file loaded.

    `~` and `$HOME` are the exception: they name a folder under the HOME of whoever expands them, and Hermes runs in a service slot
    with a HOME of its own, not this gate's. A value that needs a HOME is refused (the image sets the folder out in full); any other
    `$VAR` is expanded against the container's environment, which Hermes inherits."""
    home = str(env.get("HERMES_HOME") or "").strip()
    if not home:
        return ["HERMES_HOME is not set: the folder Hermes loads its .env from is not known to be the one this gate reads"]
    expanded = os.path.expandvars(home)
    if _HOME_REFERENCE_RE.search(home) is not None or expanded.startswith("~"):
        return ["HERMES_HOME is written with `~` or $HOME: Hermes expands it under its own HOME, which is not this gate's (write the folder out)"]
    if os.path.realpath(expanded) != os.path.realpath(data_dir):
        return ["HERMES_HOME is not the folder this gate reads the volume's .env from"]
    return []


def _credential_length(value):
    """Characters of a key that are left once Hermes has loaded it: its loader drops every non-ASCII character from variables
    named `*_KEY`, `*_TOKEN`, `*_SECRET` (`_sanitize_loaded_credentials`). Outer blanks are not counted."""
    return len(str(value).strip().encode("ascii", "ignore"))


def volume_env_problems(env_path, lookup_env=None):
    """Invariants a reused volume's own `.env` could undo after the gate passed (#4072 review M2).

    Hermes loads `<volume>/.env` after this gate has judged a scratch home, so a volume that was used by a
    less strict Hermes can carry YOLO / dashboard / CORS / a short API key. A fresh volume has no such lines.
    Judged on what Hermes ends up with (#4886): the file read as it reads it, the last assignment of a name in force, a bare
    `NAME` setting nothing. A judged name whose value holds a reference (`${...}`, `$NAME`) is refused for that, once, instead of
    being judged by a value resolved in an environment that is not Hermes' (`_referenced_names`). Only names are returned, never
    values. A missing file is fine (nothing there); an unreadable one is not."""
    where = "the volume's .env"
    assignments, pairs, problems = _read_env_file(env_path, lookup_env)
    final = dict(pairs)
    referenced = _referenced_names(assignments, lambda name: name in VOLUME_ENV_JUDGED)
    problems.extend(_reference_problem(where, name) for name in referenced)
    for key in VOLUME_ENV_TRUTHY_KEYS:
        if key not in referenced and _truthy(final.get(key)):
            problems.append(f"{where} enables {key}")
    if "API_SERVER_CORS_ORIGINS" not in referenced and str(final.get("API_SERVER_CORS_ORIGINS") or "").strip():
        problems.append(f"{where} sets API_SERVER_CORS_ORIGINS")
    if "API_SERVER_KEY" not in referenced and final.get("API_SERVER_KEY") is not None \
            and _credential_length(final["API_SERVER_KEY"]) < 32:
        problems.append(f"{where} sets an API_SERVER_KEY shorter than 32 characters")
    for key in IMAGE_KEY_ENV_NAMES:
        if key not in referenced and str(final.get(key) or "").strip():
            problems.append(f"{where} sets {key} (another image provider's credential)")
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


def canonical_origin(raw):
    """`raw` itself when it is exactly `https://<lowercase ASCII host of 2+ labels, last label starting with a letter>`
    plus an optional explicit port in 1..65535 that is not 443; otherwise None. No userinfo, path, slash, query,
    fragment, whitespace, uppercase or non-ASCII. Same grammar as the plugin and the Rust worker."""
    if not isinstance(raw, str) or len(raw) > 300 or SELF_ORIGIN_RE.fullmatch(raw) is None:
        return None
    host, _, port = raw[len("https://"):].partition(":")
    if len(host) > 253:
        return None
    if port and (int(port) > 65535 or int(port) == 443):
        return None
    return raw


def image_environment_problems(pairs, where, volume=False, referenced=()):
    """Names (never values) in one environment source that turn Hermes' SSRF filter or the image guard off, or leave its media
    delivery open.

    `volume=True` for the volume's `.env`: there the self-media origin and the strict media flag may not be set at all, since
    the file is loaded into the Hermes process after this gate ran and could replace the value the gate judged. For the
    process environment the strict media flag must be set, to exactly `1` (#4820 C2b 3부): without it Hermes hands the answer
    any readable file that a `MEDIA:` line names.

    `referenced` (the volume's `.env` only, from `_referenced_names`): the judged names whose value holds a reference. Each is
    refused once for that and is not judged by a value that was resolved here, in an environment that is not Hermes'."""
    pairs = list(pairs)
    final = dict(pairs)  # the last assignment of a name is the one in force (a file may repeat a name, an environment cannot)
    problems, seen = [], set()
    for name, value in pairs:
        if name in seen:
            continue
        if name == MEDIA_STRICT_ENV:
            if volume and value is not None:  # a bare NAME in the file sets nothing in Hermes
                problems.append(f"{where} sets {name} (set it on the service: the file would replace the checked value)")
                seen.add(name)
            continue
        if name == SELF_ORIGIN_ENV:
            raw = str(value)
            if volume:
                if value is not None:
                    problems.append(f"{where} sets {name} (set it on the service: the file would replace the checked value)")
                    seen.add(name)
            elif raw != "" and canonical_origin(raw) is None:
                problems.append(f"{where} sets {name} to a value that is not a canonical origin "
                                "(https://<lowercase host>[:port], no path, no trailing slash, not :443)")
                seen.add(name)
            continue
        if name in referenced:
            problems.append(_reference_problem(where, name))
            seen.add(name)
            continue
        value = "" if final[name] is None else str(final[name]).strip()
        if name in IMAGE_ENV_FLAG_REASONS and _truthy(value):
            problems.append(f"{where} enables {name} ({IMAGE_ENV_FLAG_REASONS[name]})")
            seen.add(name)
        elif _is_proxy_name(name) and value:
            problems.append(f"{where} sets {name} (a proxy: Hermes hands DNS and the final-target check to it)")
            seen.add(name)
    if not volume and dict(pairs).get(MEDIA_STRICT_ENV) != MEDIA_STRICT_VALUE:
        problems.append(f"{where} must set {MEDIA_STRICT_ENV}={MEDIA_STRICT_VALUE} when image_generate is exposed "
                        "(without it Hermes delivers any readable file that a MEDIA: line in an answer names)")
    return problems


def image_volume_env_problems(env_path, lookup_env=None):
    assignments, pairs, problems = _read_env_file(env_path, lookup_env)
    referenced = _referenced_names(assignments, lambda name: name in IMAGE_ENV_FLAG_REASONS or _is_proxy_name(name))
    return problems + image_environment_problems(pairs, "the volume's .env", volume=True, referenced=referenced)


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


# The one allowed address and its bypass variants (#4820 C2a). All derived from the configured origin, so the canary
# proves the plugin that is about to run accepts exactly this shape and nothing near it. The workspace and token are
# canary-only values: nothing is fetched, the stand-in handler below records the call and does nothing else.
CANARY_SELF_WORKSPACE = "0000000a-0000-4000-8000-00000000000b"  # hex letters, so its upper-case form is a different string
CANARY_SELF_TOKEN = "C" * 43
CANARY_OTHER_ORIGIN = "https://canary.invalid"  # never the configured origin: see canary_self_media_examples


def canary_self_media_examples(origin):
    """(refused, accepted) canary lists about the one allowed address.

    With a configured `origin`: the address itself must be accepted as `image_url` (the positive control: the exception is
    live) and every variant must be refused: the same address in the reference list, another scheme case, host case, a
    written-out default port, another port, userinfo (both directions), surrounding whitespace, `..`, `%2e`, doubled
    slashes, a query, a fragment, a trailing slash, another path under the origin, a longer host, another host, plain
    http, a wrong-length token, an upper-case workspace, a lookalike first letter. Without an origin the exception is
    off: an address of the allowed shape under a made-up origin must be refused."""
    tail = CANARY_SELF_WORKSPACE + "/" + CANARY_SELF_TOKEN
    prefix = SELF_MEDIA_PATH_PREFIX
    if origin is None:
        return [("image_url", CANARY_OTHER_ORIGIN + prefix + tail)], []
    hostport = origin[len("https://"):]
    host, _, port = hostport.partition(":")
    good = origin + prefix + tail
    other = CANARY_OTHER_ORIGIN if origin != CANARY_OTHER_ORIGIN else "https://canary2.invalid"
    variants = [
        ("reference_image_urls", [good]),
        ("reference_image_urls", good),
        ("image_url", "HTTPS://" + hostport + prefix + tail),
        ("image_url", "https://" + hostport.upper() + prefix + tail),
        ("image_url", "https://" + host + ":443" + prefix + tail),
        ("image_url", "https://" + host + ("" if port else ":8443") + prefix + tail),
        ("image_url", "https://user@" + hostport + prefix + tail),
        ("image_url", "https://" + hostport + "@" + other[len("https://"):] + prefix + tail),
        ("image_url", " " + good),
        ("image_url", good + " "),
        ("image_url", good + "\n"),
        ("image_url", origin + prefix + "../self-media/" + tail),
        ("image_url", origin + prefix + "%2e%2e/self-media/" + tail),
        ("image_url", origin + "/" + prefix + tail),
        ("image_url", origin + "/v1/" + prefix[len("/v1/"):] + "/" + tail),
        ("image_url", origin + prefix + CANARY_SELF_WORKSPACE + "//" + CANARY_SELF_TOKEN),
        ("image_url", good + "?x=1"),
        ("image_url", good + "#f"),
        ("image_url", good + "/"),
        ("image_url", origin + "/v1/attachments/" + tail),
        ("image_url", origin + "/v1/auth/login"),
        ("image_url", "https://" + host + ".canary.invalid" + (":" + port if port else "") + prefix + tail),
        ("image_url", other + prefix + tail),
        ("image_url", "http://" + hostport + prefix + tail),
        ("image_url", origin + prefix + CANARY_SELF_WORKSPACE + "/" + CANARY_SELF_TOKEN[:-1]),
        ("image_url", origin + prefix + CANARY_SELF_WORKSPACE + "/" + CANARY_SELF_TOKEN + "C"),
        ("image_url", origin + prefix + CANARY_SELF_WORKSPACE.upper() + "/" + CANARY_SELF_TOKEN),
        ("image_url", "https://\u0430" + hostport[1:] + prefix + tail),
    ]
    return variants, [{"prompt": "canary", "image_url": good}]


class _CanarySpy:
    """Stands in for image_generate's real handler while the canary runs: records the call and does nothing else."""

    def __init__(self):
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append(dict(args))
        return json.dumps({"success": True, "canary_spy": True})


def run_image_guard_canary(hook_block, call_tool, install_spy, origin=None):
    """Exercise the dispatch path with refused and accepted image_generate calls. Returns (problems, evidence).

    hook_block(args, call_id) -> block message or None (what the agent loop asks the hooks);
    call_tool(args, call_id)  -> the result text of the full tool call (what the registry dispatch returns);
    install_spy(spy)          -> restore callable (the registered handler is replaced by `spy` until restored).
    Refused examples must be blocked by this guard's marker and never reach the handler; accepted ones must reach the
    handler exactly once, which is also the positive control that the path is live. `origin` is the configured
    self-media origin (None: the exception is off); its address and bypass variants join the lists. Labels only,
    never a value."""
    import copy
    spy = _CanarySpy()
    self_refused, self_accepted = canary_self_media_examples(origin)
    refused_examples = IMAGE_GUARD_CANARY_REFUSED + tuple(self_refused)
    accepted_examples = IMAGE_GUARD_CANARY_ACCEPTED + tuple(self_accepted)
    restore = install_spy(spy)
    problems = []
    evidence = {"refused": 0, "accepted": 0}
    serial = [0]

    def call_id():
        serial[0] += 1
        return f"lockgate-canary-{serial[0]}"

    try:
        for index, (field, value) in enumerate(refused_examples):
            label = f"{field}#{index}"
            blocked = hook_block({"prompt": "canary", field: copy.deepcopy(value)}, call_id())
            if not (isinstance(blocked, str) and IMAGE_GUARD_MARKER in blocked):
                problems.append(f"canary: the pre_tool_call hooks did not refuse the example {label}")
            del spy.calls[:]
            result = call_tool({"prompt": "canary", field: copy.deepcopy(value)}, call_id())
            if spy.calls or not (isinstance(result, str) and IMAGE_GUARD_MARKER in result):
                problems.append(f"canary: image_generate was not refused before running for the example {label}")
            evidence["refused"] += 1
        for index, args in enumerate(accepted_examples):
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


def hermes_image_guard_canary(origin=None):
    """The canary against the real Hermes dispatch path. HERMES_HOME must be the scratch home holding the verified
    plugin, and model_tools must have been imported after that (its import runs plugin discovery). `origin` is the
    configured self-media origin the plugin will read from this process' environment (None when unset or invalid)."""
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

    problems, evidence = run_image_guard_canary(hook_block, call_tool, install_spy, origin)
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
    problems.extend(hermes_home_problems(original_env, data_dir))
    problems.extend(volume_env_problems(os.path.join(data_dir, ".env"), original_env))
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
            problems.extend(image_volume_env_problems(os.path.join(data_dir, ".env"), original_env))
            guard_evidence = {"files": sorted(IMAGE_GUARD_FILES), "files_verified": guard_files is not None,
                              "media_strict": original_env.get(MEDIA_STRICT_ENV) == MEDIA_STRICT_VALUE}
            if guard_files is not None:  # never run bytes that did not match the pinned hashes
                canary_problems, canary_evidence = hermes_image_guard_canary(
                    canonical_origin(original_env.get(SELF_ORIGIN_ENV, "")))
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
             approvals_mode=mode, image_guard=guard_evidence, env_parser=env_parser(), problems=problems)
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
        data_dir = os.environ.get("HERMES_DATA_DIR", DATA_DIR)
        # The volume's `.env` the way the boot gate judged it, whatever tool is exposed: the YOLO / dashboard / CORS / API key / FAL
        # rules hold for the life of the process, not only until the first /health (#4886 review).
        violations += volume_env_problems(os.path.join(data_dir, ".env"))
        if (set(tools) | set(selected)) & IMAGE_TOOLS:
            # Files, config and environment again on the live volume; the canary needs the scratch home, so it is boot-only.
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
