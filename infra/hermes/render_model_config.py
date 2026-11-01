#!/usr/bin/env python3
"""Render the `model:` / `fallback_model:` part of the oort Hermes config (#4082; ADR-0203 증보 2026-10-19).

Why this exists: signing in to a model provider (Codex device code, Claude `code#state`) stores a credential in
Hermes' volume (auth.json) but does NOT make Hermes use it. `model.provider` / `model.default` in config.yaml
decide that, and the Railway boot overwrites /opt/data/config.yaml from HERMES_CONFIG_B64 on every start, so
the template chosen at install time is the only owner of those keys. The sidecar never writes a config file.

Three authentication methods (four choices, because "API key" is per vendor):
  codex-oauth        provider openai-codex   login: hermes auth add openai-codex --type oauth --no-browser
  claude-oauth       provider anthropic      login: hermes auth add anthropic --type oauth --no-browser
  api-key-openai     provider openai-api     secret: OPENAI_API_KEY    (a service variable / .env, never this file)
  api-key-anthropic  provider anthropic      secret: ANTHROPIC_API_KEY (a service variable / .env, never this file)

claude-oauth and api-key-anthropic share the provider id `anthropic`: the config cannot say which credential
is used, so set only the one you mean (an ANTHROPIC_API_KEY / ANTHROPIC_TOKEN / CLAUDE_CODE_OAUTH_TOKEN variable
may win over the volume login). `--model` accepts only the names listed in METHODS (a curated subset of the
catalog: no -900k / -pro variants).

Nothing here is a secret: only provider ids and model names. Both come from the Hermes v0.22.2 catalog
(image nousresearch/hermes-agent@sha256:36099926..., hermes_cli/models_catalog_static.py `_PROVIDER_MODELS`);
note `claude-sonnet-5` is the catalog name (`claude-sonnet-5-5` is not in it).

Connector mode (#4935). A connector Hermes (Gmail, calendar, drive read-only) is not the default config plus a few lines: it denies the whole `web` and
`image_gen` toolsets and has no picture plugin, so its lock section is the one of `google-connectors.config.yaml`. `--connector-base` takes that file,
swaps its own `model:` / `fallback_model:` for the chosen model fragment (in the same place) and keeps everything else byte for byte: same input,
same bytes, same sha256. The Railway start command and `lockgate.py` accept `config.yaml` only when its sha256 is one of the `--catalog` lines
(the default config, and a connector config for each of the four model fragments); the operator compares by hash and never prints a value.

Usage (stdlib only, no PyYAML on purpose):
  render_model_config.py --auth codex-oauth [--fallback claude-oauth] [--model M] [--fallback-model M]
                         [--base infra/hermes/config.yaml]     # base given -> full config, else the fragment
  render_model_config.py --auth claude-oauth --fallback codex-oauth --connector-base infra/hermes/google-connectors.config.yaml
                                                                 # the connector-mode config
  ... --sha256                                                   # print only the sha256 of what would be printed
  render_model_config.py --catalog                               # `<name>  <sha256>` of every config the gate accepts
"""
import argparse
import hashlib
import os
import re
import sys

# method -> (hermes provider id, models in the catalog for that provider, default model, how it signs in)
METHODS = {
    "codex-oauth": ("openai-codex", ("gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
                                     "gpt-5.4-mini", "gpt-5.4", "gpt-5.3-codex-spark"), "gpt-5.6-sol",
                    "login: hermes auth add openai-codex --type oauth --no-browser (device code; credentials stay in the Hermes volume)"),
    "claude-oauth": ("anthropic", ("claude-fable-5.1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5",
                                   "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"), "claude-sonnet-5",
                     "login: hermes auth add anthropic --type oauth --no-browser (paste code#state; credentials stay in the Hermes volume)"),
    "api-key-openai": ("openai-api", ("gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
                                      "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5-mini"), "gpt-5.6-sol",
                       "secret: OPENAI_API_KEY as a service variable or in the volume .env, never in this file"),
    "api-key-anthropic": ("anthropic", ("claude-fable-5.1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5",
                                        "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"), "claude-sonnet-5",
                          "secret: ANTHROPIC_API_KEY as a service variable or in the volume .env, never in this file"),
}
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")  # one plain YAML scalar: no quoting, no injection
HERE = os.path.dirname(os.path.abspath(__file__))
CONNECTOR_REFERENCE = "google-connectors.config.yaml"  # the connector-mode lock section and `mcp_servers` (K-S1b, #3952)
# The four combinations the repo ships as `model-fragments/<name>.yaml`: the one list the connector catalog is built from.
FRAGMENT_SPECS = {
    "codex-oauth.fallback-claude-oauth": dict(auth="codex-oauth", fallback="claude-oauth"),
    "claude-oauth.fallback-codex-oauth": dict(auth="claude-oauth", fallback="codex-oauth"),
    "api-key-openai.fallback-api-key-anthropic": dict(auth="api-key-openai", fallback="api-key-anthropic"),
    "api-key-anthropic": dict(auth="api-key-anthropic"),
}


class RenderError(ValueError):
    pass


def _pick(method, model, role):
    if method not in METHODS:
        raise RenderError("unknown %s auth method %r (choose: %s)" % (role, method, ", ".join(sorted(METHODS))))
    provider, catalog, default, note = METHODS[method]
    model = default if model is None else model
    if not MODEL_RE.fullmatch(model) or model not in catalog:
        raise RenderError("%s model %r is not in the Hermes v0.22.2 catalog for provider %s" % (role, model, provider))
    return provider, model, note


def fragment(auth, fallback=None, model=None, fallback_model=None):
    provider, model, note = _pick(auth, model, "primary")
    out = ["model:                    # #4082: %s" % note,
           "  provider: %s" % provider,
           "  default: %s" % model]
    if fallback is not None:
        fb_provider, fb_model, fb_note = _pick(fallback, fallback_model, "fallback")
        if fb_provider == provider:
            raise RenderError("fallback provider %s equals the primary: a fallback must be a different provider" % provider)
        out += ["fallback_model:           # tried when the primary fails (rate limit / overload / connection); %s" % fb_note,
                "  provider: %s" % fb_provider,
                "  model: %s" % fb_model]
    elif fallback_model is not None:
        raise RenderError("--fallback-model needs --fallback")
    return "\n".join(out) + "\n"


def render(base_text, auth, fallback=None, model=None, fallback_model=None):
    """The base config (no `model` / `fallback_model` of its own) followed by the model fragment."""
    if re.search(r"(?m)^(model|fallback_model):", base_text):
        raise RenderError("base config already has a model/fallback_model section")
    if base_text and not base_text.endswith("\n"):
        base_text += "\n"
    return base_text + fragment(auth, fallback, model, fallback_model)


def _model_blocks(reference_text):
    """(the lines of `reference_text` without its `model:` and `fallback_model:` sections, the index where the first one stood). A section is
    its key line and the indented lines under it; it ends at the first line that is not indented, a comment at the left margin included."""
    kept, skipping, at = [], False, None
    for line in reference_text.splitlines(keepends=True):
        if re.match(r"(?:model|fallback_model):", line):
            skipping = True
            at = len(kept) if at is None else at
            continue
        if skipping and line[:1] in (" ", "\t"):
            continue
        skipping = False
        kept.append(line)
    return kept, at


def render_connector(reference_text, auth, fallback=None, model=None, fallback_model=None):
    """The connector-mode config: the reference's text with its own model sections replaced, in their place, by the chosen fragment."""
    kept, at = _model_blocks(reference_text)
    if at is None:
        raise RenderError("the connector reference has no model section to replace")
    if not re.search(r"(?m)^mcp_servers:", reference_text):
        raise RenderError("the connector reference has no mcp_servers section: it is not a connector config")
    return "".join(kept[:at]) + fragment(auth, fallback, model, fallback_model) + "".join(kept[at:])


def sha256_of(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_text(path):
    with open(path, encoding="utf-8", newline="") as handle:  # no newline translation: the bytes are what is hashed
        return handle.read()


def catalog(base_text, connector_reference_text):
    """`{name: text}` of every config the gate accepts, in a fixed order: the default config as it is, and the connector-mode config for each
    of the four model fragments (`connector/<fragment>`). lockgate.py's `ACCEPTED_CONFIG_SHA256` and the Railway start command carry their sha256."""
    out = {"default": base_text}
    for name, spec in FRAGMENT_SPECS.items():
        out["connector/" + name] = render_connector(connector_reference_text, **spec)
    return out


def repo_catalog(directory=HERE):
    return catalog(read_text(os.path.join(directory, "config.yaml")), read_text(os.path.join(directory, CONNECTOR_REFERENCE)))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--auth", choices=sorted(METHODS))
    ap.add_argument("--fallback", choices=sorted(METHODS))
    ap.add_argument("--model")
    ap.add_argument("--fallback-model")
    ap.add_argument("--base", help="base config.yaml to append to; without it only the fragment is printed")
    ap.add_argument("--connector-base", help="the connector reference config (google-connectors.config.yaml): print the connector-mode config")
    ap.add_argument("--sha256", action="store_true", help="print only the sha256 of what would be printed")
    ap.add_argument("--catalog", action="store_true", help="print `<name>  <sha256>` of every config the gate accepts")
    args = ap.parse_args(argv)
    try:
        if args.catalog:
            if args.auth or args.base or args.connector_base or args.sha256:
                raise RenderError("--catalog takes no other option")
            for name, text in repo_catalog().items():
                print("%s  %s" % (name, sha256_of(text)))
            return 0
        if not args.auth:
            raise RenderError("--auth is required")
        if args.base and args.connector_base:
            raise RenderError("--base and --connector-base are two different configs: pick one")
        if args.connector_base:
            text = render_connector(read_text(args.connector_base), args.auth, args.fallback, args.model, args.fallback_model)
        elif args.base:
            text = render(read_text(args.base), args.auth, args.fallback, args.model, args.fallback_model)
        else:
            text = fragment(args.auth, args.fallback, args.model, args.fallback_model)
    except (RenderError, OSError) as exc:
        print("render_model_config: %s" % exc, file=sys.stderr)
        return 2
    sys.stdout.write(sha256_of(text) + "\n" if args.sha256 else text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
