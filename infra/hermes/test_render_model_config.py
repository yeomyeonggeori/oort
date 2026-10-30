"""Offline checks of the model-provider template renderer (#4082): python3 -m unittest infra/hermes/test_render_model_config.py -v

Stdlib only on purpose. The rendered config is judged by the same readers as the default config, and the
committed fragments are compared byte for byte so the examples cannot drift from the renderer."""
import importlib.util
import io
import os
import re
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load("render_model_config")
LOCK = load("lockgate")
DEFAULT = load("test_default_config")  # its helpers read the deny-list and top-level keys

BASE = open(os.path.join(HERE, "config.yaml")).read()
GOOGLE = open(os.path.join(HERE, "google-connectors.config.yaml")).read()

# Names read from the Hermes v0.22.2 image catalog (_PROVIDER_MODELS / PROVIDER_REGISTRY), not from memory.
CATALOG_PROVIDERS = {"codex-oauth": "openai-codex", "claude-oauth": "anthropic",
                     "api-key-openai": "openai-api", "api-key-anthropic": "anthropic"}
FRAGMENTS = {
    "codex-oauth.fallback-claude-oauth.yaml": dict(auth="codex-oauth", fallback="claude-oauth"),
    "claude-oauth.fallback-codex-oauth.yaml": dict(auth="claude-oauth", fallback="codex-oauth"),
    "api-key-openai.fallback-api-key-anthropic.yaml": dict(auth="api-key-openai", fallback="api-key-anthropic"),
    "api-key-anthropic.yaml": dict(auth="api-key-anthropic"),
}


def section(text, name):
    """The two-space-indented `key: value` pairs under a top-level `name:` of this repo's flat style."""
    found, inside = {}, False
    for line in text.splitlines():
        if re.match(r"^%s:" % re.escape(name), line):
            inside = True
            continue
        if inside:
            pair = re.match(r"^  ([a-z_]+): ([^\s#]+)", line)
            if pair:
                found[pair.group(1)] = pair.group(2)
            elif line.strip() and not line.startswith("  "):
                break
    return found


class Templates(unittest.TestCase):
    def test_every_method_names_the_catalog_provider_and_a_catalog_default(self):
        self.assertEqual({k: v[0] for k, v in R.METHODS.items()}, CATALOG_PROVIDERS)
        for method, (provider, catalog, default, _note) in R.METHODS.items():
            with self.subTest(method=method):
                self.assertIn(default, catalog)
                self.assertEqual(len(set(catalog)), len(catalog))

    def test_oauth_primary_with_the_other_oauth_as_fallback(self):
        text = R.fragment("codex-oauth", "claude-oauth")
        self.assertEqual(section(text, "model"), {"provider": "openai-codex", "default": "gpt-5.6-sol"})
        self.assertEqual(section(text, "fallback_model"), {"provider": "anthropic", "model": "claude-sonnet-5"})

    def test_no_fallback_means_no_fallback_section(self):
        self.assertNotIn("fallback_model", R.fragment("api-key-anthropic"))

    def test_model_override_must_be_in_the_catalog(self):
        self.assertEqual(section(R.fragment("codex-oauth", model="gpt-5.6-terra"), "model")["default"], "gpt-5.6-terra")
        for bad in ("claude-sonnet-5-5", "gpt-9", "gpt-5.6-sol\nx: 1", "gpt-5.6-sol\n", "", " gpt-5.6-sol"):
            with self.subTest(model=bad), self.assertRaises(R.RenderError):
                R.fragment("codex-oauth", model=bad)

    def test_unknown_method_and_same_provider_fallback_are_refused(self):
        with self.assertRaises(R.RenderError):
            R.fragment("codex-oauth-typo")
        with self.assertRaises(R.RenderError):
            R.fragment("codex-oauth", "codex-oauth")
        with self.assertRaises(R.RenderError):
            R.fragment("claude-oauth", "api-key-anthropic")  # both provider anthropic: no real fallback
        with self.assertRaises(R.RenderError):
            R.fragment("codex-oauth", fallback_model="claude-sonnet-5")  # fallback model without a fallback

    def test_committed_fragments_equal_the_renderer_output(self):
        for name, kwargs in FRAGMENTS.items():
            with self.subTest(name=name):
                self.assertEqual(open(os.path.join(HERE, "model-fragments", name)).read(), R.fragment(**kwargs))

    def test_no_secret_shaped_value_is_ever_rendered(self):
        for kwargs in FRAGMENTS.values():
            body = re.sub(r"(?m)#.*$", "", R.fragment(**kwargs))
            self.assertNotRegex(body, r"(?i)(api_?key|token|secret|sk-)")

    def test_the_reference_google_config_uses_the_same_providers_as_the_renderer(self):
        # #4076's connector config is the live example: codex primary, anthropic fallback (model names are reported, not pinned).
        live = (section(GOOGLE, "model"), section(GOOGLE, "fallback_model"))
        ours = (section(R.fragment("codex-oauth", "claude-oauth"), "model"),
                section(R.fragment("codex-oauth", "claude-oauth"), "fallback_model"))
        self.assertEqual(live[0], ours[0])
        self.assertEqual(live[1]["provider"], ours[1]["provider"])


class RenderedConfigKeepsTheLock(unittest.TestCase):
    def rendered(self, **kwargs):
        return R.render(BASE, **kwargs)

    def test_the_lock_text_is_untouched_and_only_model_keys_are_added(self):
        for kwargs in FRAGMENTS.values():
            out = self.rendered(**kwargs)
            self.assertTrue(out.startswith(BASE))
            added = DEFAULT.top_level_keys(out) - DEFAULT.top_level_keys(BASE)
            self.assertEqual(added, {"model", "fallback_model"} if "fallback" in kwargs else {"model"})

    def test_deny_list_approvals_and_connector_rules_hold_after_rendering(self):
        for kwargs in FRAGMENTS.values():
            out = self.rendered(**kwargs)
            off = DEFAULT.disabled_toolsets(out)
            self.assertEqual(off, DEFAULT.disabled_toolsets(BASE))
            self.assertEqual(len(off), 23)
            self.assertTrue(DEFAULT.MANDATED <= set(off))
            self.assertNotIn("mcp_servers", DEFAULT.top_level_keys(out))
            self.assertRegex(out, r"(?m)^  mode: manual\b")
            self.assertRegex(out, r"(?m)^  unattended_mode: deny\b")
            self.assertEqual(LOCK.connector_problems({"agent": {"disabled_toolsets": off}}, {}), [])

    def test_a_base_with_its_own_model_is_refused(self):
        with self.assertRaises(R.RenderError):
            R.render(GOOGLE, "codex-oauth")  # the connector config already carries a model

    def test_sabotage_a_dropped_lock_key_is_visible_in_the_rendered_text(self):
        out = self.rendered(auth="codex-oauth")
        broken = re.sub(r"(?m)^    - terminal\b.*\n", "", out)
        self.assertFalse(DEFAULT.MANDATED <= set(DEFAULT.disabled_toolsets(broken)))


class Cli(unittest.TestCase):
    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                rc = R.main(list(argv))
            except SystemExit as exc:
                rc = exc.code
        return rc, out.getvalue(), err.getvalue()

    def test_full_config_with_a_base(self):
        rc, out, _ = self.run_cli("--auth", "codex-oauth", "--fallback", "claude-oauth", "--base", os.path.join(HERE, "config.yaml"))
        self.assertEqual(rc, 0)
        self.assertEqual(out, R.render(BASE, "codex-oauth", "claude-oauth"))

    def test_bad_input_exits_nonzero_and_prints_nothing_to_stdout(self):
        rc, out, err = self.run_cli("--auth", "codex-oauth", "--model", "claude-sonnet-5-5")
        self.assertEqual((rc, out), (2, ""))
        self.assertIn("catalog", err)
        self.assertNotEqual(self.run_cli("--auth", "nope")[0], 0)


if __name__ == "__main__":
    unittest.main()
