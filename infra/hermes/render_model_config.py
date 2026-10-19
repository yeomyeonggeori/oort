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

Nothing here is a secret: only provider ids and model names. Both come from the Hermes v0.22.2 catalog
(image nousresearch/hermes-agent@sha256:36099926..., hermes_cli/models_catalog_static.py `_PROVIDER_MODELS`);
note `claude-sonnet-5` is the catalog name (`claude-sonnet-5-5` is not in it).

Usage (stdlib only, no PyYAML on purpose):
  render_model_config.py --auth codex-oauth [--fallback claude-oauth] [--model M] [--fallback-model M]
                         [--base infra/hermes/config.yaml]     # base given -> full config, else the fragment
"""
import argparse
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


class RenderError(ValueError):
    pass


def _pick(method, model, role):
    if method not in METHODS:
        raise RenderError("unknown %s auth method %r (choose: %s)" % (role, method, ", ".join(sorted(METHODS))))
    provider, catalog, default, note = METHODS[method]
    model = default if model is None else model
    if not MODEL_RE.match(model) or model not in catalog:
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


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--auth", required=True, choices=sorted(METHODS))
    ap.add_argument("--fallback", choices=sorted(METHODS))
    ap.add_argument("--model")
    ap.add_argument("--fallback-model")
    ap.add_argument("--base", help="base config.yaml to append to; without it only the fragment is printed")
    args = ap.parse_args(argv)
    try:
        if args.base:
            with open(args.base) as handle:
                text = render(handle.read(), args.auth, args.fallback, args.model, args.fallback_model)
        else:
            text = fragment(args.auth, args.fallback, args.model, args.fallback_model)
    except (RenderError, OSError) as exc:
        print("render_model_config: %s" % exc, file=sys.stderr)
        return 2
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
