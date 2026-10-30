"""oort image-guard: a Hermes `pre_tool_call` plugin that closes the address door of `image_generate`.

ADR-0203 augmentation of 2026-10-30 (I2), #4820. Stdlib only, no Hermes import, no I/O.

Why it exists: `image_generate` accepts `image_url` and `reference_image_urls`. Hermes' own handler turns a
`http(s)://` value into a GET it performs itself, and a bare path into a file read. The SSRF filter keeps private
addresses out, but it cannot stop a prompt-injected model from carrying conversation text to a public host in the
path, the query or the host name, and no Hermes setting turns the argument off. So this guard refuses, BEFORE the
tool runs (before any download, DNS lookup or file read), every value that is not either empty or a small inline
`data:image/(png|jpeg|webp|gif);base64,` picture. Everything else is refused: http(s), any other scheme, local
paths, other case, surrounding whitespace, other MIME types, JSON-encoded lists, oversized pictures, wrong types.

The decision is a pure function of the arguments. It never raises: an unexpected failure while checking is a
refusal, because Hermes' own dispatcher fails OPEN when it cannot run a hook (model_tools._pre_dispatch_guards).
It never echoes an argument value back (the refusal text goes to the model and into logs).

lockgate.py pins this file and plugin.yaml by sha256 and, at boot, calls the real dispatch path with refused and
accepted examples (a "canary"); a start where this guard is missing, disabled, edited or not consulted is refused.
"""
import re

PLUGIN_NAME = "oort-image-guard"
GUARDED_TOOL = "image_generate"
# Stable token inside every refusal: lockgate's canary uses it to tell this guard's refusal from any other failure.
MARKER = "[oort-image-guard]"

MAX_DECODED_BYTES = 4 * 1024 * 1024  # the ADR-0218 appendix A budget for one source picture
MAX_BASE64_CHARS = 4 * ((MAX_DECODED_BYTES + 2) // 3)  # 5_592_408 characters decode to at most 4 MiB
_PREFIXES = tuple("data:image/%s;base64," % kind for kind in ("png", "jpeg", "webp", "gif"))
_MAX_VALUE_CHARS = max(len(prefix) for prefix in _PREFIXES) + MAX_BASE64_CHARS
_BASE64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")

_FIELD_IMAGE = "image_url"
_FIELD_REFERENCES = "reference_image_urls"


def _is_small_inline_picture(value):
    """True only for the exact accepted shape. Length is checked before the pattern, nothing is decoded."""
    if not isinstance(value, str) or len(value) > _MAX_VALUE_CHARS:
        return False
    for prefix in _PREFIXES:
        if value.startswith(prefix):
            payload = value[len(prefix):]
            return 0 < len(payload) <= MAX_BASE64_CHARS and _BASE64.fullmatch(payload) is not None
    return False


def _is_empty_or_picture(value):
    return (isinstance(value, str) and value == "") or _is_small_inline_picture(value)


def refusal_field(args):
    """None when the call may run, otherwise the NAME of the first argument that is refused (never its value)."""
    if not isinstance(args, dict):
        return "arguments"
    image = args.get(_FIELD_IMAGE)
    if image is not None and not _is_empty_or_picture(image):
        return _FIELD_IMAGE
    references = args.get(_FIELD_REFERENCES)
    if references is None:
        return None
    # Hermes wraps a bare string as a one-item list and keeps going over every item: judge the same shape here,
    # all items (Hermes itself only reads the first 16), and let a JSON-encoded list fail the picture pattern.
    items = [references] if isinstance(references, str) else references
    if not isinstance(items, (list, tuple)):
        return _FIELD_REFERENCES
    for item in items:
        if not _is_empty_or_picture(item):
            return _FIELD_REFERENCES
    return None


def _is_guarded_tool(tool_name):
    if not isinstance(tool_name, str):
        return False
    return tool_name.strip().lower().replace("-", "_").replace(" ", "_") == GUARDED_TOOL


def _refusal(field):
    return {
        "action": "block",
        "message": (
            "%s image_generate was not run: %s accepts only an inline picture "
            "(data:image/png|jpeg|webp|gif;base64,... up to 4 MiB) or nothing. Remote addresses, file paths, other "
            "schemes and lists encoded as text are refused. Call image_generate again with a text prompt only, "
            "leaving image_url and reference_image_urls out." % (MARKER, field)
        ),
    }


def pre_tool_call(tool_name=None, args=None, **_kwargs):
    """Hermes `pre_tool_call` hook: a block directive for a refused `image_generate` call, otherwise None."""
    if not _is_guarded_tool(tool_name):
        return None
    try:
        field = refusal_field(args)
    except Exception:  # fail CLOSED: a guard that cannot decide must not wave the call through
        field = "arguments"
    if field is None:
        return None
    return _refusal(field)


def register(ctx):
    """Hermes plugin entry point: one hook, nothing else."""
    ctx.register_hook("pre_tool_call", pre_tool_call)
