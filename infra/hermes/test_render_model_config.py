"""Offline checks of the model-provider template renderer (#4082): python3 -m unittest infra/hermes/test_render_model_config.py -v

Stdlib only on purpose. The rendered config is judged by the same readers as the default config, and the
committed fragments are compared byte for byte so the examples cannot drift from the renderer."""
import hashlib
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
APPS = "com.momo.plugins.gmail,com.momo.plugins.google-calendar,com.momo.plugins.google-drive"
try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

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

    def test_the_catalog_of_fragments_is_the_renderers_own_list(self):
        self.assertEqual(FRAGMENTS, {name + ".yaml": spec for name, spec in R.FRAGMENT_SPECS.items()})
        self.assertEqual(sorted(os.listdir(os.path.join(HERE, "model-fragments"))), sorted(FRAGMENTS), "no fragment file the list does not know")

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
            self.assertEqual(len(off), 22)
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


class ConnectorConfig(unittest.TestCase):
    """#4935: the connector-mode config is the connector reference with ONLY its model sections swapped for the chosen fragment, in their place."""

    def test_only_the_model_sections_differ_from_the_reference_and_they_stay_where_they_were(self):
        for name, spec in R.FRAGMENT_SPECS.items():
            with self.subTest(fragment=name):
                out = R.render_connector(GOOGLE, **spec)
                kept_out, at_out = R._model_blocks(out)
                kept_ref, at_ref = R._model_blocks(GOOGLE)
                self.assertEqual(kept_out, kept_ref, "everything else is the reference's, byte for byte")
                self.assertEqual(at_out, at_ref, "the model sections stay in their place")
                self.assertIn(R.fragment(**spec), out)
                self.assertEqual(len(re.findall(r"(?m)^model:", out)), 1)
                self.assertEqual(len(re.findall(r"(?m)^fallback_model:", out)), 1 if "fallback" in spec else 0)
                self.assertEqual(DEFAULT.top_level_keys(out) - {"model", "fallback_model"}, DEFAULT.top_level_keys(GOOGLE) - {"model", "fallback_model"})
                self.assertEqual(out[out.index("mcp_servers:"):], GOOGLE[GOOGLE.index("mcp_servers:"):], "the connectors are the reference's")

    def test_the_reference_choice_renders_the_reference_providers(self):
        out = R.render_connector(GOOGLE, **R.FRAGMENT_SPECS["codex-oauth.fallback-claude-oauth"])
        self.assertEqual(section(out, "model"), section(GOOGLE, "model"))
        self.assertEqual(section(out, "fallback_model")["provider"], section(GOOGLE, "fallback_model")["provider"])

    def test_every_connector_config_keeps_the_connector_lock(self):
        for name, spec in R.FRAGMENT_SPECS.items():
            out = R.render_connector(GOOGLE, **spec)
            with self.subTest(fragment=name):
                off = DEFAULT.disabled_toolsets(out)
                self.assertEqual(off, DEFAULT.disabled_toolsets(GOOGLE))
                self.assertEqual(len(off), 24)
                self.assertTrue(DEFAULT.MANDATED <= set(off))
                self.assertTrue({"web", "image_gen", "cronjob", "delegation"} <= set(off), "the connector rules need these four denied")
                keys = DEFAULT.top_level_keys(out)
                self.assertIn("mcp_servers", keys)
                self.assertFalse(keys & {"platform_toolsets", "plugins", "web", "image_gen"}, "no picture tool, no search, no guard plugin here")
                self.assertRegex(out, r"(?m)^  mode: manual\b")
                self.assertRegex(out, r"(?m)^  unattended_mode: deny\b")
                self.assertEqual(LOCK.connector_problems({"agent": {"disabled_toolsets": off}, "mcp_servers": {}}, {}), [])
                if yaml is not None:
                    self.assertEqual(LOCK.connector_problems(yaml.safe_load(out), {LOCK.APPS_ENV: APPS}), [])

    def test_same_input_same_bytes_and_the_hash_is_the_hash_of_those_bytes(self):
        for name, spec in R.FRAGMENT_SPECS.items():
            with self.subTest(fragment=name):
                self.assertEqual(R.render_connector(GOOGLE, **spec), R.render_connector(GOOGLE, **spec))
        out = io.StringIO()
        with redirect_stdout(out):
            rc = R.main(["--auth", "claude-oauth", "--fallback", "codex-oauth", "--connector-base", os.path.join(HERE, "google-connectors.config.yaml"), "--sha256"])
        want = hashlib.sha256(R.render_connector(GOOGLE, **R.FRAGMENT_SPECS["claude-oauth.fallback-codex-oauth"]).encode()).hexdigest()
        self.assertEqual((rc, out.getvalue()), (0, want + "\n"))

    def test_refusals(self):
        for label, call in (
            ("a reference with no model section", lambda: R.render_connector(BASE, "codex-oauth")),
            ("a reference with no mcp_servers", lambda: R.render_connector("agent:\n  max_turns: 1\nmodel:\n  provider: x\n", "codex-oauth")),
            ("an unknown method", lambda: R.render_connector(GOOGLE, "nope")),
            ("a fallback of the same provider", lambda: R.render_connector(GOOGLE, "codex-oauth", "codex-oauth")),
            ("a model that is not in the catalog", lambda: R.render_connector(GOOGLE, "codex-oauth", model="gpt-9")),
        ):
            with self.subTest(case=label), self.assertRaises(R.RenderError):
                call()


class Catalog(unittest.TestCase):
    """#4935: the configs `lockgate.py` and the Railway start command accept are exactly the default config and one connector config per fragment."""

    def test_the_catalog_has_the_default_and_four_connector_configs_in_a_fixed_order(self):
        cat = R.repo_catalog(HERE)
        self.assertEqual(list(cat), ["default"] + ["connector/" + name for name in R.FRAGMENT_SPECS])
        with open(os.path.join(HERE, "config.yaml"), "rb") as handle:
            self.assertEqual(R.sha256_of(cat["default"]), hashlib.sha256(handle.read()).hexdigest())
        hashes = [R.sha256_of(text) for text in cat.values()]
        self.assertEqual(len(set(hashes)), 5, "five different configs")

    def test_the_gates_table_is_the_catalog(self):
        cat = R.repo_catalog(HERE)
        self.assertEqual(LOCK.ACCEPTED_CONFIG_SHA256, {R.sha256_of(text): name for name, text in cat.items()})
        self.assertEqual(list(LOCK.ACCEPTED_CONFIG_SHA256.values()), list(cat), "the same names in the same order")

    def test_the_gate_accepts_each_by_name_and_refuses_one_changed_byte(self):
        for name, text in R.repo_catalog(HERE).items():
            with self.subTest(config=name):
                self.assertEqual(LOCK.config_problems(R.sha256_of(text)), ([], name))
                for changed in (text + "#\n", text[:-1], text.replace("max_turns", "max_turn", 1), text.replace("\n", "\r\n"), " " + text, ""):
                    self.assertNotEqual(changed, text)
                    problems, accepted = LOCK.config_problems(R.sha256_of(changed))
                    self.assertEqual((len(problems), accepted), (1, None))
                    self.assertIn("not one of the accepted configs", problems[0])

    def test_a_hash_that_only_looks_like_an_accepted_one_is_refused(self):
        # the comparison is the whole hash, exactly: a shared beginning, another case, an added or a missing character are all refused
        for want, name in LOCK.ACCEPTED_CONFIG_SHA256.items():
            for label, near in (("a shared beginning", want[:8] + "0" * 56), ("the last character changed", want[:-1] + ("0" if want[-1] != "0" else "1")),
                                ("upper case", want.upper()), ("one more character", want + "0"), ("one character less", want[:-1]),
                                ("a blank in front", " " + want), ("empty", "")):
                with self.subTest(config=name, near=label):
                    self.assertNotEqual(near, want)
                    self.assertEqual(LOCK.config_problems(near)[1], None)
                    self.assertEqual(len(LOCK.config_problems(near)[0]), 1)

    def test_the_catalog_line_of_the_cli_is_the_table(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(R.main(["--catalog"]), 0)
        lines = [line.split("  ") for line in out.getvalue().splitlines()]
        self.assertEqual({sha: name for name, sha in lines}, LOCK.ACCEPTED_CONFIG_SHA256)

    def test_a_base_that_already_holds_a_model_cannot_hide_one_in_the_default(self):
        # the default config is accepted as it is; a default with a model section is another file, so another hash (not accepted)
        with_model = R.render(BASE, "codex-oauth")
        self.assertNotIn(R.sha256_of(with_model), LOCK.ACCEPTED_CONFIG_SHA256)


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

    def test_connector_base_and_base_are_two_configs_and_catalog_takes_no_other_option(self):
        reference = os.path.join(HERE, "google-connectors.config.yaml")
        for argv in (("--auth", "codex-oauth", "--base", os.path.join(HERE, "config.yaml"), "--connector-base", reference),
                     ("--catalog", "--auth", "codex-oauth"), ("--catalog", "--sha256"), ("--sha256",)):
            with self.subTest(argv=argv):
                rc, out, err = self.run_cli(*argv)
                self.assertEqual((rc, out), (2, ""))
                self.assertTrue(err)
        rc, out, err = self.run_cli("--auth", "claude-oauth", "--connector-base", os.path.join(HERE, "config.yaml"))
        self.assertEqual((rc, out), (2, ""), "the default config is no connector reference")

    def test_bad_input_exits_nonzero_and_prints_nothing_to_stdout(self):
        rc, out, err = self.run_cli("--auth", "codex-oauth", "--model", "claude-sonnet-5-5")
        self.assertEqual((rc, out), (2, ""))
        self.assertIn("catalog", err)
        self.assertNotEqual(self.run_cli("--auth", "nope")[0], 0)


if __name__ == "__main__":
    unittest.main()
