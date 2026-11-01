"""Offline tests for how lockgate.py judges image generation's guard (#4820 security review, ADR-0203 I2/I4):

    python3 -m unittest infra/hermes/test_lockgate_image_guard.py -v

Covers: the plugin files and config the gate demands, the environment and config switches that turn the SSRF filter or
the guard off, the `.env` byte order mark, the `image_gen` allowed keys, and the CANARY, both as a pure function against
doubles that fail in each way and through `gate()`/`report()` with a miniature Hermes that really loads the shipped
plugin and dispatches through it. Only Hermes itself, HTTP and PID 1 are doubles; the real Hermes image runs the same
gate in scripts/tests/test_hermes_image_guard_docker.sh. Each rule has a case that fails when the rule is removed.
"""
import copy
import hashlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.join(HERE, "plugins", "oort-image-guard")


def load(path, name):
    previous, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


lockgate = load(os.path.join(HERE, "lockgate.py"), "lockgate_for_image_guard_gate_test")
NAME = lockgate.IMAGE_GUARD_PLUGIN
BOM = b"\xef\xbb\xbf"
KEY = "test-only-" * 4


def real_files():
    out = {}
    for name in lockgate.IMAGE_GUARD_FILES:
        with open(os.path.join(PLUGIN_DIR, name), "rb") as handle:
            out[name] = handle.read()
    return out


def install(data_dir, files=None):
    """Write a plugin directory under a fake Hermes volume. `files` defaults to the shipped bytes."""
    root = os.path.join(data_dir, "plugins", NAME)
    os.makedirs(root, exist_ok=True)
    for name, raw in (real_files() if files is None else files).items():
        with open(os.path.join(root, name), "wb") as handle:
            handle.write(raw)
    return root


def baseline_env(data_dir, env=None):
    """The environment of a healthy boot: the API key, the volume, and the strict media flag (#4820 C2b 3부). A test's `env`
    adds to it; a name given as `None` is removed from it (how a test boots WITHOUT the flag)."""
    merged = {"API_SERVER_KEY": KEY, "HERMES_DATA_DIR": data_dir,
              lockgate.MEDIA_STRICT_ENV: lockgate.MEDIA_STRICT_VALUE, **(env or {})}
    return {name: value for name, value in merged.items() if value is not None}


def healthy_cfg(**over):
    cfg = {"web": {"search_backend": "openai-native", "keyless_fallback": False},
           "image_gen": {"provider": "openai-codex"},
           "plugins": {"enabled": [NAME], "isolation": "in_process"},
           "security": {"allow_private_urls": False, "fake_ip_ranges": []}}
    cfg.update(over)
    return cfg


TOOLS = {"memory", "todo_list", "session_search", "web_search", "image_generate"}


class FakeHermes:
    """A miniature of the Hermes pieces the gate drives. It is faithful where the canary depends on it:
    plugin discovery runs ONCE, at the first model_tools call (real Hermes runs it when model_tools is imported), reads
    `<HERMES_HOME>/plugins/<name>/` as it is at that moment, loads it only when the config enables it, and every tool
    call asks the registered hooks first (a block becomes an error result) before the registry handler runs."""

    def __init__(self, cfg, tools=TOOLS):
        self.cfg, self.tools = cfg, set(tools)
        self.hooks, self.listing, self.discovered = [], [], False
        self.real_calls = []
        self.entry = types.SimpleNamespace(handler=self._real_handler, is_async=False)

    def _real_handler(self, args, **kwargs):
        self.real_calls.append(dict(args))
        return json.dumps({"success": True, "real_handler": True})

    def discover(self):
        if self.discovered:
            return
        self.discovered = True
        home = os.environ.get("HERMES_HOME")  # report() runs without a scratch home and never dispatches
        enabled = (self.cfg.get("plugins") or {}).get("enabled") or []
        path = os.path.join(home or "", "plugins", NAME, "__init__.py")
        if home and NAME in enabled and os.path.isfile(path):
            module = load(path, "hermes_plugins.oort_image_guard_fake")
            ctx = types.SimpleNamespace(register_hook=lambda hook, fn: self.hooks.append((hook, fn)))
            module.register(ctx)
            self.listing.append({"name": NAME, "source": "user", "enabled": True, "hooks": len(self.hooks), "error": None})

    def dispatch_hooks(self, tool_name, args, **kwargs):
        self.discover()
        for hook, callback in self.hooks:
            if hook == "pre_tool_call":
                result = callback(tool_name=tool_name, args=args, **kwargs)
                if isinstance(result, dict) and result.get("action") == "block" and result.get("message"):
                    return result["message"], None
        return None, None

    def handle_function_call(self, name, args, **kwargs):
        blocked = self.dispatch_hooks(name, args, **kwargs)[0]
        if blocked:
            return json.dumps({"error": blocked})
        return self.entry.handler(args, **kwargs)

    def modules(self):
        names = ("hermes_cli", "hermes_cli.config", "hermes_cli.tools_config", "hermes_cli.plugins",
                 "model_tools", "tools", "tools.registry")
        modules = {name: types.ModuleType(name) for name in names}
        modules["hermes_cli.config"].load_config = mock.Mock(return_value=self.cfg)
        modules["hermes_cli.tools_config"]._get_platform_tools = mock.Mock(return_value={"memory", "search"})

        def select(*args, **kwargs):
            self.discover()  # real Hermes: importing model_tools has already run discovery by the time this is callable
            return self.tools
        modules["model_tools"]._select_tool_names = select
        modules["model_tools"].get_tool_definitions = mock.Mock(return_value=[{"function": {"name": "memory"}}])
        modules["model_tools"].handle_function_call = self.handle_function_call
        modules["hermes_cli.plugins"]._dispatch_pre_tool_call_hooks = self.dispatch_hooks
        modules["hermes_cli.plugins"].get_plugin_manager = lambda: types.SimpleNamespace(list_plugins=lambda: list(self.listing))
        registry = types.SimpleNamespace(get_entry=lambda name, scope=None: self.entry if name == "image_generate" else None)
        modules["tools.registry"].registry = registry
        return modules


class GateHarness(unittest.TestCase):
    def boot(self, cfg=None, tools=TOOLS, env=None, files=None, env_file=None, install_guard=True, fake=None, config_bytes=None, setup=None,
             swap_config_after_hash=None):
        """`config_bytes`: the bytes of config.yaml the gate hashes. Without them the file is a fixture (the config is doubled by `FakeHermes`)
        and the gate accepts exactly that fixture; with them the gate's real `ACCEPTED_CONFIG_SHA256` judges them (`AcceptedConfigs`).
        `setup(data)`: more of the volume, made before the gate runs. `swap_config_after_hash`: bytes written over config.yaml the moment the
        gate has hashed it; `fake.scratch_configs` holds the config.yaml the migration step found in the scratch home."""
        cfg = healthy_cfg() if cfg is None else cfg
        fake = fake or FakeHermes(cfg, tools)
        with tempfile.TemporaryDirectory() as data:
            if install_guard:
                install(data, files)
            if env_file is not None:
                with open(os.path.join(data, ".env"), "wb") as handle:
                    handle.write(env_file)
            if setup is not None:
                setup(data)
            path = os.path.join(data, "config.yaml")
            fixture = b"# isolated boot fixture; load_config is doubled\n" if config_bytes is None else config_bytes
            with open(path, "wb") as handle:
                handle.write(fixture)
            fake.scratch_configs = []
            real_sha256 = hashlib.sha256

            def sha256_then_swap(*args, **kwargs):
                digest = real_sha256(*args, **kwargs)
                if swap_config_after_hash is not None and args and args[0] == fixture:
                    with open(path, "wb") as handle:
                        handle.write(swap_config_after_hash)
                return digest

            def migrate(*args, **kwargs):
                with open(os.path.join(os.environ["HERMES_HOME"], "config.yaml"), "rb") as handle:
                    fake.scratch_configs.append(handle.read())
                return types.SimpleNamespace(returncode=0)
            accepted = {hashlib.sha256(fixture).hexdigest(): "fixture"} if config_bytes is None else lockgate.ACCEPTED_CONFIG_SHA256
            # the image's own `ENV HERMES_HOME=/opt/data` (#4886): a test passes `{"HERMES_HOME": None}` or another folder to break it
            environment = baseline_env(data, {"HERMES_HOME": data, **(env or {})})
            with mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch.dict(sys.modules, fake.modules()), \
                    mock.patch.object(sys, "path", list(sys.path)), \
                    mock.patch.object(lockgate, "ACCEPTED_CONFIG_SHA256", accepted), \
                    mock.patch.object(lockgate.hashlib, "sha256", side_effect=sha256_then_swap), \
                    mock.patch.object(lockgate.subprocess, "run", side_effect=migrate), \
                    mock.patch.object(lockgate, "emit") as emit:
                rc = lockgate.gate(path)
                return rc, emit.call_args.kwargs, fake

    def monitor(self, cfg, tools=TOOLS, env=None, data_files=None, env_file=None, setup=None):
        fake = FakeHermes(cfg, tools)
        data = [{"name": "fixture", "enabled": True, "tools": sorted(tools)}]
        body = json.dumps({"data": data}).encode()
        with tempfile.TemporaryDirectory() as data_dir:
            install(data_dir, data_files)
            if env_file is not None:
                with open(os.path.join(data_dir, ".env"), "wb") as handle:
                    handle.write(env_file)
            if setup is not None:
                setup(data_dir)
            environment = baseline_env(data_dir, env)
            with mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch.dict(sys.modules, fake.modules()), \
                    mock.patch.object(sys, "path", list(sys.path)), \
                    mock.patch.object(lockgate, "_status", side_effect=lambda url, *a: (200 if url.endswith("/health") else 401, {})), \
                    mock.patch.object(lockgate.urllib.request, "urlopen", return_value=io.BytesIO(body)), \
                    mock.patch.object(lockgate.socket, "create_connection", side_effect=OSError), \
                    mock.patch.object(lockgate.os, "kill") as kill, \
                    mock.patch.object(lockgate, "emit") as emit:
                rc = lockgate.report()
                return rc, kill.call_args_list, emit.call_args.kwargs

    def assertRefused(self, rc, record, fragment):
        self.assertEqual(rc, 3, record.get("problems"))
        self.assertFalse(record["ok"])
        self.assertTrue(any(fragment in p for p in record["problems"]), (fragment, record["problems"]))


class HealthyBoot(GateHarness):
    def test_the_shipped_plugin_and_config_pass_and_the_canary_is_reported(self):
        rc, record, fake = self.boot()
        self.assertEqual((rc, record["problems"]), (0, []))
        guard = record["image_guard"]
        self.assertTrue(guard["files_verified"])
        # No origin configured: the exception is off, and the canary adds one refused address of the allowed shape.
        self.assertEqual(guard["canary"]["refused"],
                         len(lockgate.IMAGE_GUARD_CANARY_REFUSED) + len(lockgate.canary_self_media_examples(None)[0]))
        self.assertEqual(guard["canary"]["accepted"], len(lockgate.IMAGE_GUARD_CANARY_ACCEPTED))
        self.assertEqual(guard["canary"]["plugin"][0]["name"], NAME)
        # The stand-in took every accepted call; the real handler never ran, and it is back in place afterwards.
        self.assertEqual(fake.real_calls, [])
        self.assertEqual(fake.entry.handler.__name__, "_real_handler")
        self.assertIs(fake.entry.is_async, False)

    def test_the_default_config_file_enables_exactly_the_guard(self):
        with open(os.path.join(HERE, "config.yaml"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertRegex(text, r"(?m)^plugins:\n  enabled:\n    - oort-image-guard\b[^\n]*\n(?!    - )")
        self.assertEqual(lockgate.image_guard_config_problems(
            {"plugins": {"enabled": re.findall(r"(?m)^    - (oort-image-guard)\b", text.split("plugins:")[1])}}), [])

    def test_the_guard_rules_do_not_apply_when_image_generation_is_not_exposed(self):
        chat_only = TOOLS - {"image_generate"}
        cfg = {"web": healthy_cfg()["web"]}
        rc, record, _ = self.boot(cfg, chat_only, env={"HTTPS_PROXY": "http://proxy.example:3128", "HERMES_SAFE_MODE": "1"},
                                  install_guard=False)
        self.assertEqual((rc, record["problems"]), (0, []))
        self.assertIsNone(record["image_guard"])
        # the volume's `.env` is judged by its allow-list whatever tools are exposed (#4950): no name outside it, with or without the picture tool
        rc, record, _ = self.boot(cfg, chat_only, env_file=b"HTTPS_PROXY=http://proxy.example:3128\n", install_guard=False)
        self.assertRefused(rc, record, "the volume's .env sets HTTPS_PROXY")


class PluginFilesAndConfig(GateHarness):
    def test_a_missing_or_partial_or_edited_or_extra_plugin_is_refused_before_listening(self):
        files = real_files()
        for name, kwargs, fragment in (
            ("directory missing", {"install_guard": False}, "is not installed"),
            ("manifest missing", {"files": {"__init__.py": files["__init__.py"]}}, "plugin.yaml is missing"),
            ("code missing", {"files": {"plugin.yaml": files["plugin.yaml"]}}, "__init__.py is missing"),
            ("code edited", {"files": {**files, "__init__.py": files["__init__.py"] + b"\n# edited\n"}}, "does not match the pinned sha256"),
            ("manifest edited", {"files": {**files, "plugin.yaml": files["plugin.yaml"].replace(b"1.0.0", b"1.0.1")}}, "does not match the pinned sha256"),
            ("widened code", {"files": {**files, "__init__.py": files["__init__.py"].replace(b'"png", "jpeg"', b'"png", "svg+xml"')}}, "does not match the pinned sha256"),
            ("third file", {"files": {**files, "extra.py": b"import os\n"}}, "extra.py"),
        ):
            with self.subTest(name):
                rc, record, fake = self.boot(**kwargs)
                self.assertRefused(rc, record, fragment)
                self.assertNotIn("canary", record["image_guard"], "bytes that failed the hash must never run")
                self.assertEqual(fake.hooks, [])

    def test_a_symlinked_or_directory_file_is_refused(self):
        with tempfile.TemporaryDirectory() as data:
            root = install(data)
            os.remove(os.path.join(root, "plugin.yaml"))
            os.symlink(os.path.join(PLUGIN_DIR, "plugin.yaml"), os.path.join(root, "plugin.yaml"))
            files, problems = lockgate.read_image_guard_files(data)
            self.assertIsNone(files)
            self.assertTrue(any("not a regular file" in p for p in problems), problems)
        with tempfile.TemporaryDirectory() as data:
            root = install(data)
            os.remove(os.path.join(root, "__init__.py"))
            os.mkdir(os.path.join(root, "__init__.py"))
            self.assertTrue(any("not a regular file" in p for p in lockgate.read_image_guard_files(data)[1]))
        with tempfile.TemporaryDirectory() as data:
            real = os.path.join(data, "elsewhere")
            os.makedirs(real)
            os.makedirs(os.path.join(data, "plugins"))
            os.symlink(real, os.path.join(data, "plugins", NAME))
            self.assertTrue(any("is not installed" in p for p in lockgate.read_image_guard_files(data)[1]))

    def test_nothing_unpinned_may_sit_beside_the_two_files_not_even_a_bytecode_cache(self):
        # A valid .pyc is read in place of its source; the image never writes one (PYTHONDONTWRITEBYTECODE=1), so none is allowed.
        for entry, make in (("__pycache__", os.mkdir), ("extra.py", lambda path: open(path, "wb").close()),
                            (".hidden", lambda path: open(path, "wb").close())):
            with self.subTest(entry=entry), tempfile.TemporaryDirectory() as data:
                root = install(data)
                self.assertEqual(lockgate.read_image_guard_files(data)[1], [])
                make(os.path.join(root, entry))
                files, problems = lockgate.read_image_guard_files(data)
                self.assertIsNone(files)
                self.assertTrue(any(entry in p for p in problems), problems)

    def test_the_verified_bytes_are_the_ones_installed_for_the_canary(self):
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as scratch:
            install(data)
            files, problems = lockgate.read_image_guard_files(data)
            self.assertEqual(problems, [])
            lockgate.install_image_guard(scratch, files)
            for name, raw in real_files().items():
                with open(os.path.join(scratch, "plugins", NAME, name), "rb") as handle:
                    self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), hashlib.sha256(raw).hexdigest())

    def test_config_must_enable_exactly_the_guard_and_keep_it_in_process(self):
        for name, plugins, fragment in (
            ("no plugins section", None, "plugins.enabled"),
            ("enabled key missing", {"isolation": "in_process"}, "plugins.enabled"),
            ("enabled empty", {"enabled": []}, "plugins.enabled"),
            ("enabled null", {"enabled": None}, "plugins.enabled"),
            ("enabled is a string", {"enabled": NAME}, "plugins.enabled"),
            ("another plugin only", {"enabled": ["other"]}, "plugins.enabled"),
            ("another plugin beside", {"enabled": [NAME, "other"]}, "plugins.enabled"),
            ("guard listed twice", {"enabled": [NAME, NAME]}, "plugins.enabled"),
            ("guard also disabled", {"enabled": [NAME], "disabled": [NAME]}, "plugins.disabled"),
            ("plugin host isolation", {"enabled": [NAME], "isolation": "host"}, "plugins.isolation"),
            ("isolation null", {"enabled": [NAME], "isolation": None}, "plugins.isolation"),
        ):
            with self.subTest(name):
                cfg = healthy_cfg()
                if plugins is None:
                    del cfg["plugins"]
                else:
                    cfg["plugins"] = plugins
                rc, record, _ = self.boot(cfg)
                self.assertRefused(rc, record, fragment)
        self.assertEqual(lockgate.image_guard_config_problems({"plugins": {"enabled": [NAME], "disabled": []}}), [])
        self.assertEqual(lockgate.image_guard_config_problems({"plugins": {"enabled": [NAME], "disabled": ["other"]}}), [])

    def test_a_guard_the_config_does_not_enable_is_not_loaded_and_the_canary_says_so(self):
        cfg = healthy_cfg()
        cfg["plugins"] = {"enabled": []}
        rc, record, fake = self.boot(cfg)
        self.assertRefused(rc, record, "canary: the pre_tool_call hooks did not refuse")
        self.assertEqual(fake.hooks, [])

    def test_image_gen_holds_only_the_provider(self):
        for extra in ({"use_gateway": True}, {"model": "gpt-image-2"}, {"backend": "fal"}, {"openai-codex": {"model": "x"}},
                      {"use_gateway": False}):
            with self.subTest(extra=sorted(extra)):
                cfg = healthy_cfg(image_gen={"provider": "openai-codex", **extra})
                rc, record, _ = self.boot(cfg)
                self.assertRefused(rc, record, "image_gen must hold only 'provider'")
                self.assertTrue(any(sorted(extra)[0] in p for p in record["problems"]))
        self.assertEqual(lockgate.tool_problems(healthy_cfg(), TOOLS), [])
        # Rolling image generation back must not leave this rule behind.
        self.assertEqual(lockgate.tool_problems({"image_gen": {"provider": "fal", "model": "x"}}, {"memory"}), [])


class SsrfSwitches(GateHarness):
    FLAGS = ("HERMES_ALLOW_PRIVATE_URLS", "HERMES_SAFE_MODE", "HERMES_ENABLE_PROJECT_PLUGINS")

    def test_truthy_flags_in_the_process_environment_are_named_without_their_value(self):
        for flag in self.FLAGS:
            for value in ("1", "true", "TRUE", "yes", "on", " true "):
                with self.subTest(flag=flag, value=value):
                    rc, record, _ = self.boot(env={flag: value})
                    self.assertRefused(rc, record, flag)
                    self.assertNotIn("the volume", " ".join(record["problems"]))

    def test_falsy_flags_are_fine(self):
        for flag in self.FLAGS:
            for value in ("", "0", "false", "no", "off"):
                with self.subTest(flag=flag, value=value):
                    rc, record, _ = self.boot(env={flag: value})
                    self.assertEqual((rc, record["problems"]), (0, []))

    def test_proxies_in_the_process_environment_are_refused_by_name(self):
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "FTP_PROXY", "SOCKS_PROXY"):
            with self.subTest(name=name):
                rc, record, _ = self.boot(env={name: "http://user:pw@proxy.example:3128"})
                self.assertRefused(rc, record, name)
                self.assertNotIn("proxy.example", json.dumps(record))
                self.assertNotIn("pw@", json.dumps(record))

    def test_no_proxy_an_empty_proxy_and_lookalike_names_are_not_proxies(self):
        for env in ({"NO_PROXY": "localhost"}, {"no_proxy": "localhost,.internal"}, {"HTTP_PROXY": ""}, {"HTTPS_PROXY": "  "},
                    {"PROXY_HOST": "proxy.example"}, {"PROXYCHAINS": "1"}):
            with self.subTest(env=env):
                rc, record, _ = self.boot(env=env)
                self.assertEqual((rc, record["problems"]), (0, []))

    def test_the_same_names_in_the_volumes_env_file_are_refused_too(self):
        for line in ("HERMES_ALLOW_PRIVATE_URLS=true", "export HERMES_SAFE_MODE=1", 'HERMES_ENABLE_PROJECT_PLUGINS="yes"',
                     "HTTPS_PROXY=http://proxy.example:3128", "export all_proxy='socks5://proxy.example:1080'"):
            with self.subTest(line=line):
                rc, record, _ = self.boot(env_file=("OPENAI_API_KEY=keep\n" + line + "\n").encode())
                self.assertRefused(rc, record, "the volume's .env")
                self.assertNotIn("proxy.example", json.dumps(record))
                self.assertEqual(len([p for p in record["problems"] if "the volume's .env" in p]), 1)
        for line in ("# HTTPS_PROXY=http://proxy.example:3128", "OPENAI_API_KEY=keep", "# HERMES_SAFE_MODE=1"):
            with self.subTest(harmless=line):
                rc, record, _ = self.boot(env_file=(line + "\n").encode())
                self.assertEqual((rc, record["problems"]), (0, []))
        # a name that is not allowed is refused whatever its value: the old rules let an empty or a false one through
        for line in ("NO_PROXY=localhost", "HTTP_PROXY=", "HERMES_SAFE_MODE=0", "HERMES_ALLOW_PRIVATE_URLS=false"):
            with self.subTest(refused=line):
                rc, record, _ = self.boot(env_file=(line + "\n").encode())
                self.assertRefused(rc, record, "the volume's .env sets " + line.split("=")[0])

    def test_a_byte_order_mark_on_the_first_line_does_not_hide_any_env_rule(self):
        # Hermes reads the file as utf-8-sig; reading it as utf-8 left U+FEFF on the first key name and every rule missed it.
        for line, fragment in (("HERMES_YOLO_MODE=1", "HERMES_YOLO_MODE"), ("HERMES_DASHBOARD=true", "HERMES_DASHBOARD"),
                               ("API_SERVER_CORS_ORIGINS=https://evil.example", "API_SERVER_CORS_ORIGINS"),
                               ("API_SERVER_KEY=short", "API_SERVER_KEY"), ("FAL_KEY=fixture-secret-value", "FAL_KEY"),
                               ("HTTPS_PROXY=http://proxy.example:3128", "HTTPS_PROXY"),
                               ("HERMES_ALLOW_PRIVATE_URLS=1", "HERMES_ALLOW_PRIVATE_URLS"),
                               ("HERMES_SAFE_MODE=1", "HERMES_SAFE_MODE")):
            with self.subTest(line=line):
                rc, record, _ = self.boot(env_file=BOM + (line + "\nOPENAI_API_KEY=keep\n").encode())
                self.assertRefused(rc, record, fragment)
                self.assertNotIn("fixture-secret-value", json.dumps(record))
            # Two marks in front, and a line after the first that the loader's clean-up changes (so it rewrites the file, and the loader
            # decodes the rewritten one again and drops the second mark): Hermes applies the line, so the gate must see it. Also a blank
            # in front of the mark, and a mark behind blanks inside UTF-16.
            for label, raw in (("two marks", BOM + BOM + (line + "\n OPENAI_API_KEY=keep\n").encode()),
                               ("blank, mark", b"\t" + BOM + (line + "\n").encode()),
                               ("utf-16, two marks", b"\xff\xfe" + ("\ufeff" + line + "\n").encode("utf-16-le"))):
                with self.subTest(line=line, shape=label):
                    rc, record, _ = self.boot(env_file=raw)
                    self.assertRefused(rc, record, fragment)
                    self.assertNotIn("fixture-secret-value", json.dumps(record))
                    rc, kills, record = self.monitor(healthy_cfg(), env_file=raw)
                    self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)
        with tempfile.TemporaryDirectory() as data:
            path = os.path.join(data, ".env")
            with open(path, "wb") as handle:
                handle.write(BOM + b"HERMES_YOLO_MODE=1\n")
            self.assertEqual(len(lockgate.volume_env_problems(path)), 1)

    def test_a_private_address_switch_in_the_config_is_refused(self):
        for section in ("security", "browser"):
            for value in (True, "true", "1", "yes", "on", 1):
                with self.subTest(section=section, value=value):
                    rc, record, _ = self.boot(healthy_cfg(**{section: {"allow_private_urls": value}}))
                    self.assertRefused(rc, record, f"{section}.allow_private_urls")
            for value in (False, "false", "0", "no", "off", "", None, 0):
                with self.subTest(section=section, harmless=value):
                    rc, record, _ = self.boot(healthy_cfg(**{section: {"allow_private_urls": value}}))
                    self.assertEqual((rc, record["problems"]), (0, []))

    def test_declared_fake_ip_ranges_are_refused_and_the_empty_default_is_fine(self):
        for value in (["198.18.0.0/15"], "198.18.0.0/15", ["198.18.0.0/15", "fc00::/7"]):
            with self.subTest(value=value):
                rc, record, _ = self.boot(healthy_cfg(security={"allow_private_urls": False, "fake_ip_ranges": value}))
                self.assertRefused(rc, record, "security.fake_ip_ranges")
        for value in ([], "", None, "  "):
            with self.subTest(harmless=value):
                rc, record, _ = self.boot(healthy_cfg(security={"fake_ip_ranges": value}))
                self.assertEqual((rc, record["problems"]), (0, []))

    def test_the_rules_hold_on_the_live_volume_after_start_too(self):
        cfg = healthy_cfg()
        self.assertEqual(self.monitor(cfg)[:2], (0, []))
        for kwargs, fragment in (
            ({"env": {"HTTPS_PROXY": "http://proxy.example:3128"}}, "HTTPS_PROXY"),
            ({"env_file": b"HERMES_SAFE_MODE=1\n"}, "HERMES_SAFE_MODE"),
            ({"data_files": {**real_files(), "__init__.py": real_files()["__init__.py"] + b"#\n"}}, "pinned sha256"),
        ):
            with self.subTest(fragment=fragment):
                rc, kills, record = self.monitor(cfg, **kwargs)
                self.assertEqual(rc, 3)
                self.assertEqual(kills, [mock.call(1, lockgate.signal.SIGTERM)])
                self.assertTrue(any(fragment in p for p in record["problems"]), record["problems"])
        for live in (healthy_cfg(plugins={"enabled": []}), healthy_cfg(image_gen={"provider": "openai-codex", "model": "x"}),
                     healthy_cfg(security={"allow_private_urls": True})):
            with self.subTest(live=sorted(live)):
                rc, kills, _ = self.monitor(live)
                self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]))


ORIGIN = "https://oort.example.com"
VECTORS = json.load(open(os.path.join(HERE, "self_media_vectors.json"), encoding="utf-8"))["origin"]


class SelfMediaOrigin(GateHarness):
    """`OORT_SELF_MEDIA_ORIGIN` (owner 10-30 decision, #4820 C2a): the gate checks the variable's format, the volume's
    `.env` may not carry it, an unset variable means the exception is off, and the canary proves the plugin about to run
    accepts exactly one address and refuses its bypass variants."""

    def test_a_canonical_origin_boots_and_the_canary_accepts_one_address_and_refuses_the_variants(self):
        refused, accepted = lockgate.canary_self_media_examples(ORIGIN)
        self.assertEqual(len(accepted), 1)
        self.assertGreaterEqual(len(refused), 20)
        for origin in VECTORS["accept"]:
            with self.subTest(origin=origin):
                rc, record, fake = self.boot(env={lockgate.SELF_ORIGIN_ENV: origin})
                self.assertEqual((rc, record["problems"]), (0, []))
                canary = record["image_guard"]["canary"]
                refused, accepted = lockgate.canary_self_media_examples(origin)
                self.assertEqual(canary["refused"], len(lockgate.IMAGE_GUARD_CANARY_REFUSED) + len(refused))
                self.assertEqual(canary["accepted"], len(lockgate.IMAGE_GUARD_CANARY_ACCEPTED) + 1)
                self.assertEqual(fake.real_calls, [], "the stand-in took every call, the real handler never ran")

    def test_an_unset_or_empty_origin_means_the_exception_is_off_and_boot_is_fine(self):
        for env in ({}, {lockgate.SELF_ORIGIN_ENV: ""}):
            with self.subTest(env=env):
                rc, record, _ = self.boot(env=env)
                self.assertEqual((rc, record["problems"]), (0, []))
                refused, accepted = lockgate.canary_self_media_examples(None)
                self.assertEqual((len(refused), accepted), (1, []))
                self.assertEqual(record["image_guard"]["canary"]["accepted"], len(lockgate.IMAGE_GUARD_CANARY_ACCEPTED))

    def test_a_set_origin_that_is_not_canonical_is_refused_by_name_without_its_value(self):
        bad = [origin for origin in VECTORS["reject"] if origin != ""]
        self.assertGreaterEqual(len(bad), 25)
        for origin in bad + ["https://secret-host-4820.example/"]:
            with self.subTest(origin=origin):
                rc, record, _ = self.boot(env={lockgate.SELF_ORIGIN_ENV: origin})
                self.assertRefused(rc, record, lockgate.SELF_ORIGIN_ENV)
                self.assertTrue(any("not a canonical origin" in p for p in record["problems"]), record["problems"])
                self.assertNotIn("secret-host-4820", json.dumps(record))

    def test_the_volumes_env_file_may_not_carry_the_variable_at_all(self):
        for line in (lockgate.SELF_ORIGIN_ENV + "=" + ORIGIN, "export " + lockgate.SELF_ORIGIN_ENV + "=" + ORIGIN,
                     lockgate.SELF_ORIGIN_ENV + '="' + ORIGIN + '"', lockgate.SELF_ORIGIN_ENV + "=https://evil.example",
                     lockgate.SELF_ORIGIN_ENV + "="):
            for process_env in ({}, {lockgate.SELF_ORIGIN_ENV: ORIGIN}):
                with self.subTest(line=line, process=bool(process_env)):
                    rc, record, _ = self.boot(env=process_env, env_file=("OPENAI_API_KEY=keep\n" + line + "\n").encode())
                    self.assertRefused(rc, record, "the volume's .env sets " + lockgate.SELF_ORIGIN_ENV)
                    self.assertNotIn("evil.example", json.dumps(record))
        rc, record, _ = self.boot(env_file=b"# " + lockgate.SELF_ORIGIN_ENV.encode() + b"=" + ORIGIN.encode() + b"\n")
        self.assertEqual((rc, record["problems"]), (0, []), "a comment is not an assignment")

    def test_a_byte_order_mark_does_not_hide_the_variable_in_the_env_file(self):
        rc, record, _ = self.boot(env_file=BOM + (lockgate.SELF_ORIGIN_ENV + "=" + ORIGIN + "\n").encode())
        self.assertRefused(rc, record, "the volume's .env sets " + lockgate.SELF_ORIGIN_ENV)

    def test_the_rules_apply_only_when_image_generation_is_exposed(self):
        chat_only = TOOLS - {"image_generate"}
        cfg = {"web": healthy_cfg()["web"]}
        rc, record, _ = self.boot(cfg, chat_only, env={lockgate.SELF_ORIGIN_ENV: "https://Bad.Example/"}, install_guard=False)
        self.assertEqual((rc, record["problems"]), (0, []))
        # the volume's `.env` has an allow-list that does not depend on the tools (#4950): the variable is refused there either way
        rc, record, _ = self.boot(cfg, chat_only, env_file=(lockgate.SELF_ORIGIN_ENV + "=x\n").encode(), install_guard=False)
        self.assertRefused(rc, record, "the volume's .env sets " + lockgate.SELF_ORIGIN_ENV)

    def test_the_same_rules_hold_on_the_live_volume_after_start(self):
        rc, kills, record = self.monitor(healthy_cfg(), env={lockgate.SELF_ORIGIN_ENV: ORIGIN})
        self.assertEqual(rc, 0, record)
        self.assertEqual(kills, [])
        rc, kills, record = self.monitor(healthy_cfg(), env={lockgate.SELF_ORIGIN_ENV: "https://Bad.Example/"})
        self.assertEqual(rc, 3, record)
        self.assertTrue(any(lockgate.SELF_ORIGIN_ENV in p for p in record["problems"]), record["problems"])
        self.assertEqual(len(kills), 1, "a definitive violation asks PID 1 to stop")
        rc, kills, record = self.monitor(healthy_cfg(), env={lockgate.SELF_ORIGIN_ENV: ORIGIN},
                                         env_file=(lockgate.SELF_ORIGIN_ENV + "=" + ORIGIN + "\n").encode())
        self.assertEqual(rc, 3, record)
        self.assertTrue(any("the volume's .env" in p for p in record["problems"]), record["problems"])

    def test_the_gate_and_the_shipped_plugin_agree_on_every_canary_example(self):
        guard = load(os.path.join(PLUGIN_DIR, "__init__.py"), "oort_image_guard_for_self_media_canary")
        for origin in VECTORS["accept"]:
            refused, accepted = lockgate.canary_self_media_examples(origin)
            with mock.patch.dict(os.environ, {lockgate.SELF_ORIGIN_ENV: origin}):
                for field, value in refused:
                    self.assertIsNotNone(guard.refusal_field({"prompt": "canary", field: value}), (origin, field, value))
                for args in accepted:
                    self.assertIsNone(guard.refusal_field(args), (origin, args))
        refused, _ = lockgate.canary_self_media_examples(None)
        with mock.patch.dict(os.environ):
            os.environ.pop(lockgate.SELF_ORIGIN_ENV, None)
            for field, value in refused:
                self.assertIsNotNone(guard.refusal_field({"prompt": "canary", field: value}), (field, value))

    def test_the_canary_catches_a_guard_that_compares_by_prefix_only(self):
        """A plugin whose comparison were a bare startswith(origin + prefix) accepts the query, the dot segments and the
        suffixes: the canary names the first variant it lets through."""
        refused, accepted = lockgate.canary_self_media_examples(ORIGIN)
        allowed_prefix = ORIGIN + lockgate.SELF_MEDIA_PATH_PREFIX

        def weak_hook(args, call_id):
            value = args.get("image_url") or ""
            if isinstance(value, str) and value.startswith(allowed_prefix):
                return None
            return lockgate.IMAGE_GUARD_MARKER if (value or args.get("reference_image_urls")) else None

        def weak_call(args, call_id):
            return "canary_spy" if weak_hook(args, call_id) is None else lockgate.IMAGE_GUARD_MARKER

        problems, _ = self.run_canary(weak_hook, weak_call)
        self.assertTrue(problems, "a prefix-only comparison must be caught")
        self.assertTrue(any("did not refuse the example" in p for p in problems), problems)

    def test_the_canary_catches_a_guard_widened_to_every_https(self):
        def wide_hook(args, call_id):
            value = args.get("image_url")
            if isinstance(value, str) and value.startswith("https://"):
                return None
            return lockgate.IMAGE_GUARD_MARKER if (value or args.get("reference_image_urls")) else None

        def wide_call(args, call_id):
            return "canary_spy" if wide_hook(args, call_id) is None else lockgate.IMAGE_GUARD_MARKER

        problems, _ = self.run_canary(wide_hook, wide_call)
        self.assertGreaterEqual(len(problems), 10, "every other https example is let through")

    def test_the_canary_fails_the_positive_control_when_the_allowed_address_is_refused(self):
        problems, _ = self.run_canary(lambda args, cid: lockgate.IMAGE_GUARD_MARKER if args.get("image_url") else None,
                                      lambda args, cid: lockgate.IMAGE_GUARD_MARKER)
        self.assertTrue(any("refused the allowed example" in p for p in problems), problems)

    def run_canary(self, hook, call):
        spy_holder = {}

        def install(spy):
            spy_holder["spy"] = spy
            return lambda: None

        def wrapped_call(args, cid):
            result = call(args, cid)
            if result == "canary_spy":
                spy_holder["spy"](args)
                return "canary_spy"
            return result
        return lockgate.run_image_guard_canary(hook, wrapped_call, install, ORIGIN)


class MediaStrict(GateHarness):
    """`HERMES_MEDIA_DELIVERY_STRICT` (#4820 C2b 3부, ADR-0218 G3.7 (b), #4935): on every start, in every mode, the process
    environment must carry exactly `1`, the volume's `.env` may not carry the name at all (it is not on the allow-list), and
    `report` re-checks both. Outside strict mode Hermes hands the answer any readable file a `MEDIA:` line names, which is what
    the hosted door's picture harvest, and a connector Hermes that reads mail and drive, must never be able to reach."""

    NAME = lockgate.MEDIA_STRICT_ENV

    def test_the_flag_in_the_process_environment_boots_and_is_reported(self):
        rc, record, _ = self.boot()
        self.assertEqual((rc, record["problems"]), (0, []))
        self.assertIs(record["image_guard"]["media_strict"], True)

    def test_without_the_flag_the_start_is_refused_by_name(self):
        rc, record, _ = self.boot(env={self.NAME: None})
        self.assertRefused(rc, record, self.NAME)
        self.assertTrue(any("must set " + self.NAME + "=1" in p for p in record["problems"]), record["problems"])
        self.assertEqual(len([p for p in record["problems"] if self.NAME in p]), 1)
        self.assertIs(record["image_guard"]["media_strict"], False)

    def test_anything_but_an_exact_one_is_refused_and_the_value_is_never_printed(self):
        # Hermes itself reads true/yes/on as strict too; the gate takes ONE spelling.
        for value in ("", "0", "false", "true", "TRUE", "yes", "on", " 1", "1 ", "01", "11", "1\n", "secret-media-4820"):
            with self.subTest(value=value):
                rc, record, _ = self.boot(env={self.NAME: value})
                self.assertRefused(rc, record, self.NAME)
                self.assertNotIn("secret-media-4820", json.dumps(record))
                self.assertIs(record["image_guard"]["media_strict"], False)

    def test_the_volumes_env_file_may_not_carry_the_name_at_all(self):
        # Hermes loads the file into its process after the gate ran: a line there can replace the value that was checked,
        # so even `=1` is refused. The process environment is healthy in every case.
        for line in (self.NAME + "=1", self.NAME + "=0", self.NAME + "=", "export " + self.NAME + "=1",
                     self.NAME + '="1"', self.NAME + "='true'", "  " + self.NAME + " = 1 "):
            with self.subTest(line=line):
                rc, record, _ = self.boot(env_file=("OPENAI_API_KEY=keep\n" + line + "\n").encode())
                self.assertRefused(rc, record, "the volume's .env sets " + self.NAME)
                self.assertEqual(len([p for p in record["problems"] if "the volume's .env" in p]), 1)
        for harmless in ("# " + self.NAME + "=0", "OPENAI_API_KEY=keep"):
            with self.subTest(harmless=harmless):
                rc, record, _ = self.boot(env_file=(harmless + "\n").encode())
                self.assertEqual((rc, record["problems"]), (0, []))
        rc, record, _ = self.boot(env_file=(self.NAME.lower() + "=0\n").encode())  # another name, and not on the list either
        self.assertRefused(rc, record, "the volume's .env sets " + self.NAME.lower())

    def test_a_byte_order_mark_does_not_hide_the_name_in_the_env_file(self):
        rc, record, _ = self.boot(env_file=BOM + (self.NAME + "=1\n").encode())
        self.assertRefused(rc, record, "the volume's .env sets " + self.NAME)

    def test_the_process_flag_and_the_volume_file_are_judged_separately(self):
        rc, record, _ = self.boot(env={self.NAME: None}, env_file=(self.NAME + "=1\n").encode())
        self.assertEqual(rc, 3)
        text = " | ".join(record["problems"])
        self.assertIn("the process environment must set " + self.NAME, text)
        self.assertIn("the volume's .env sets " + self.NAME, text)

    def test_the_rule_applies_whatever_tools_are_exposed(self):
        # #4935: not only with the picture tool. A chat-only config (a rollback) or a connector config is refused without the flag too.
        chat_only = TOOLS - {"image_generate"}
        cfg = {"web": healthy_cfg()["web"]}
        rc, record, _ = self.boot(cfg, chat_only, install_guard=False)
        self.assertEqual((rc, record["problems"]), (0, []), "with the flag, no picture tool: fine")
        self.assertIsNone(record["image_guard"])
        self.assertIs(record["media_strict"], True)
        for config, tools in ((cfg, chat_only), ({"mcp_servers": {"gmail": {}}}, {"memory", "todo_list", "session_search"})):
            with self.subTest(mcp_servers=bool(config.get("mcp_servers"))):
                rc, record, _ = self.boot(config, tools, env={self.NAME: None}, install_guard=False)
                self.assertRefused(rc, record, self.NAME)
                self.assertIs(record["media_strict"], False)
                self.assertIsNone(record["image_guard"])
        rc, record, _ = self.boot(cfg, chat_only, env_file=(self.NAME + "=0\n").encode(), install_guard=False)
        self.assertRefused(rc, record, "the volume's .env sets " + self.NAME)

    def test_the_same_rules_hold_on_the_live_volume_after_start(self):
        rc, kills, record = self.monitor(healthy_cfg())
        self.assertEqual((rc, kills), (0, []), record)
        for kwargs, fragment in (
            ({"env": {self.NAME: None}}, "the process environment must set " + self.NAME),
            ({"env": {self.NAME: "true"}}, "the process environment must set " + self.NAME),
            ({"env_file": (self.NAME + "=1\n").encode()}, "the volume's .env sets " + self.NAME),
        ):
            with self.subTest(fragment=fragment):
                rc, kills, record = self.monitor(healthy_cfg(), **kwargs)
                self.assertEqual(rc, 3, record)
                self.assertEqual(kills, [mock.call(1, lockgate.signal.SIGTERM)], "a definitive violation asks PID 1 to stop")
                self.assertTrue(any(fragment in p for p in record["problems"]), record["problems"])

    def test_the_function_judges_the_process_environment_and_the_file_is_not_its_business(self):
        judge = lockgate.media_strict_problems
        self.assertEqual(judge({self.NAME: "1"}, "the process environment"), [])
        self.assertEqual(judge([(self.NAME, "1")], "the process environment"), [], "pairs as `environ.items()` gives them")
        self.assertEqual(judge(iter([(self.NAME, "1")]), "the process environment"), [])
        self.assertEqual(judge({}, "the process environment")[0].split(" must set ")[0], "the process environment")
        self.assertEqual(judge({self.NAME: "true"}, "the process environment")[0].split(" must set ")[1].split(" (")[0], self.NAME + "=1")
        # the picture-tool rules no longer carry it, and the file has no function of its own: its allow-list refuses the name
        self.assertEqual(lockgate.image_environment_problems([], "the process environment"), [])
        self.assertEqual(lockgate.image_environment_problems([(self.NAME, "1")], "the process environment"), [])


class CanaryBehavior(GateHarness):
    """The canary is a verdict from behavior: it fails for a guard that is wrong, absent, or not consulted."""

    def widened(self, old, new):
        files = real_files()
        self.assertIn(old, files["__init__.py"])
        files["__init__.py"] = files["__init__.py"].replace(old, new)
        return files

    def boot_with_pinned(self, files):
        """The widened files pass the hash check (their hashes are pinned in a patched gate): only the canary can object."""
        pinned = {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}
        with mock.patch.dict(lockgate.IMAGE_GUARD_FILES, pinned):
            return self.boot(files=files)

    def test_a_guard_that_also_lets_http_through_is_caught_by_the_canary(self):
        files = self.widened(b"    for prefix in _PREFIXES:\n        if value.startswith(prefix):",
                             b"    if value.startswith(\"https://\"):\n        return True\n"
                             b"    for prefix in _PREFIXES:\n        if value.startswith(prefix):")
        rc, record, fake = self.boot_with_pinned(files)
        self.assertRefused(rc, record, "canary: the pre_tool_call hooks did not refuse the example image_url#0")
        self.assertTrue(record["image_guard"]["files_verified"])
        self.assertFalse(any("pinned sha256" in p for p in record["problems"]))
        self.assertNotIn("canary.invalid", json.dumps(record), "the canary reports labels, never an argument value")

    def test_a_guard_that_refuses_everything_fails_the_positive_control(self):
        files = self.widened(b"    if field is None:\n        return None\n", b"    if field is None:\n        field = 'image_url'\n")
        rc, record, fake = self.boot_with_pinned(files)
        self.assertRefused(rc, record, "refused the allowed example")

    def test_a_guard_whose_refusal_has_no_marker_is_not_taken_for_ours(self):
        files = self.widened(b"MARKER = \"[oort-image-guard]\"", b"MARKER = \"[something-else]\"")
        rc, record, _ = self.boot_with_pinned(files)
        self.assertRefused(rc, record, "canary:")

    def test_a_dispatch_that_never_consults_the_hooks_is_caught(self):
        fake = FakeHermes(healthy_cfg())
        fake.handle_function_call = lambda name, args, **kw: fake.entry.handler(args, **kw)
        rc, record, _ = self.boot(fake=fake)
        self.assertRefused(rc, record, "was not refused before running")

    def test_a_hook_path_that_returns_nothing_is_caught(self):
        fake = FakeHermes(healthy_cfg())
        fake.dispatch_hooks = lambda tool_name, args, **kw: (None, None)
        rc, record, _ = self.boot(fake=fake)
        self.assertRefused(rc, record, "pre_tool_call hooks did not refuse")

    def test_a_missing_tool_entry_cannot_be_exercised_and_is_refused(self):
        fake = FakeHermes(healthy_cfg())
        modules = fake.modules()
        modules["tools.registry"].registry = types.SimpleNamespace(get_entry=lambda *a, **k: None)
        fake.modules = lambda: modules
        rc, record, _ = self.boot(fake=fake)
        self.assertRefused(rc, record, "is not registered")

    def test_the_stand_in_handler_is_restored_even_when_the_dispatch_raises(self):
        entry = types.SimpleNamespace(handler=lambda args, **kw: "real", is_async=True)
        original = entry.handler

        def install(spy):
            entry.handler, entry.is_async = spy, False
            return lambda: setattr(entry, "handler", original) or setattr(entry, "is_async", True)

        def boom(args, call_id):
            raise RuntimeError("dispatch failed")
        with self.assertRaises(RuntimeError):
            lockgate.run_image_guard_canary(lambda args, cid: "x", boom, install)
        self.assertIs(entry.handler, original)
        self.assertIs(entry.is_async, True)

    def test_the_canary_examples_cover_every_refusal_class(self):
        values = [value for _, value in lockgate.IMAGE_GUARD_CANARY_REFUSED]
        flat = [v for item in values for v in (item if isinstance(item, list) else [item])]
        self.assertTrue(any(v.startswith("https://") for v in flat))
        self.assertTrue(any(v.startswith("HTTP://") for v in flat))
        self.assertTrue(any(v.startswith(" ") for v in flat))
        self.assertTrue(any(v.startswith("file:") for v in flat))
        self.assertTrue(any(v.startswith("/") for v in flat))
        self.assertTrue(any(v.startswith("./") for v in flat))
        self.assertTrue(any(v.startswith("data:text/html") for v in flat))
        self.assertTrue(any(field == "reference_image_urls" and isinstance(v, str) for field, v in lockgate.IMAGE_GUARD_CANARY_REFUSED))
        self.assertTrue(any(field == "reference_image_urls" and isinstance(v, list) and len(v) == 2
                            for field, v in lockgate.IMAGE_GUARD_CANARY_REFUSED), "a bad item after a good one")

    def test_every_canary_example_is_what_the_shipped_plugin_decides(self):
        guard = load(os.path.join(PLUGIN_DIR, "__init__.py"), "oort_image_guard_for_canary_table")
        for field, value in lockgate.IMAGE_GUARD_CANARY_REFUSED:
            self.assertIsNotNone(guard.refusal_field({"prompt": "canary", field: value}), (field, value))
        for args in lockgate.IMAGE_GUARD_CANARY_ACCEPTED:
            self.assertIsNone(guard.refusal_field(args), args)

    def test_canary_ids_are_unique_so_hermes_never_collapses_two_calls_into_one(self):
        seen = []

        def hook(args, call_id):
            seen.append(call_id)
            return lockgate.IMAGE_GUARD_MARKER if args.get("image_url") or args.get("reference_image_urls") not in (None, [], "") else None

        def call(args, call_id):
            seen.append(call_id)
            return lockgate.IMAGE_GUARD_MARKER

        lockgate.run_image_guard_canary(hook, call, lambda spy: (lambda: None))
        self.assertEqual(len(seen), len(set(seen)))
        refused, accepted = lockgate.canary_self_media_examples(None)
        self.assertEqual(len(seen), 2 * (len(lockgate.IMAGE_GUARD_CANARY_REFUSED) + len(refused)
                                         + len(lockgate.IMAGE_GUARD_CANARY_ACCEPTED) + len(accepted)))


class EnvFileThroughTheGate(GateHarness):
    """#4886, #4950: the volume's `.env` as Hermes loads it, judged through the real `gate()` / `report()` (the rule tables, for both
    parsers, are in test_lockgate_env.py). The file may hold the allowed names and nothing else: every spelling the loader applies of
    any other name stops the start, whatever its value, a value given by reference or not; the live report reads the file the same way
    and with the SAME function; what the loader ignores does not stop it."""

    APPLIED = (
        ("HERMES_SAFE_MODE=1 # note", "HERMES_SAFE_MODE"),
        ("export\tHERMES_ALLOW_PRIVATE_URLS=true", "HERMES_ALLOW_PRIVATE_URLS"),
        ("'HERMES_ENABLE_PROJECT_PLUGINS'=1", "HERMES_ENABLE_PROJECT_PLUGINS"),
        ('export  HTTPS_PROXY="http://proxy.example:3128" # c', "HTTPS_PROXY"),
        ("HERMES_SAFE_MODE=${OORT_PROOF_UNSET:-1}", "HERMES_SAFE_MODE"),
        ("export\t'OORT_SELF_MEDIA_ORIGIN'=\"https://oort.example.com\" # c", "OORT_SELF_MEDIA_ORIGIN"),
        ("'HERMES_MEDIA_DELIVERY_STRICT'=1", "HERMES_MEDIA_DELIVERY_STRICT"),
        ('HERMES_YOLO_MODE="1" # c', "HERMES_YOLO_MODE"),
        ("export\tHERMES_DASHBOARD=true", "HERMES_DASHBOARD"),
        ("API_SERVER_CORS_ORIGINS=https://evil.example # c", "API_SERVER_CORS_ORIGINS"),
        ("HERMES_MEDIA_ALLOW_DIRS=/oort-proof/none", "HERMES_MEDIA_ALLOW_DIRS"),
        ("export HERMES_MANAGED_DIR='/oort-proof/none'", "HERMES_MANAGED_DIR"),
        ("HERMES_HOME=/oort-proof/none", "HERMES_HOME"),
        ("GATEWAY_PROXY_URL=https://relay.example", "GATEWAY_PROXY_URL"),
        ("OPENROUTER_API_KEY=" + "o" * 12, "OPENROUTER_API_KEY"),
    )

    def test_every_spelling_the_loader_applies_stops_the_start(self):
        for line, name in self.APPLIED:
            with self.subTest(line=line):
                rc, record, _ = self.boot(env_file=("OPENAI_API_KEY=keep\n" + line + "\n").encode())
                self.assertRefused(rc, record, "the volume's .env")
                # the name as python-dotenv reads it is refused once; a spelling that Hermes' line-by-line reader reads as another key
                # (`export<TAB>NAME`, a quoted name) adds a line for that key
                self.assertEqual(len([p for p in record["problems"] if p.startswith("the volume's .env sets %s (" % name)]), 1, record["problems"])
                for secret in ("evil.example", "proxy.example", "o" * 12):
                    self.assertNotIn(secret, json.dumps(record))

    def test_what_no_reader_reads_does_not_stop_the_start(self):
        for text in ("# HERMES_SAFE_MODE=1", "HERMES_SAFE_MODE", "OORT_SELF_MEDIA_ORIGIN", "   # HERMES_YOLO_MODE=1"):
            with self.subTest(text=text):
                rc, record, _ = self.boot(env_file=(text + "\n").encode())
                self.assertEqual((rc, record["problems"]), (0, []))

    def test_what_only_the_line_by_line_reader_reads_stops_the_start_and_the_live_report(self):
        # python-dotenv (the loader) sets nothing for these; Hermes' other reader of the file reads the name, so the file is judged as it
        # reads it (one function, also after the start)
        for text in ('HERMES_SAFE_MODE="1', 'HERMES_SAFE_MODE="1" junk', "HERMES_SAFE_MODE=1\nHERMES_SAFE_MODE",
                     'OPENAI_API_KEY="one\nHERMES_SAFE_MODE=1"', "OPENAI_API_KEY=1\x0cHERMES_SAFE_MODE=1", "OPENAI_API_KEY=1 # c\u2029HERMES_SAFE_MODE=1"):
            with self.subTest(text=text):
                body = (text + "\n").encode("utf-8")
                rc, record, _ = self.boot(env_file=body)
                self.assertRefused(rc, record, "the volume's .env sets HERMES_SAFE_MODE (")
                self.assertEqual(len([p for p in record["problems"] if "HERMES_SAFE_MODE" in p]), 1, record["problems"])
                rc, kills, record = self.monitor(healthy_cfg(), env_file=body)
                self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)

    def test_a_line_break_in_an_allowed_value_stops_the_start_and_the_live_report(self):
        body = b"OPENAI_API_KEY='oort-proof-first\noort-proof-second'\n"
        rc, record, _ = self.boot(env_file=body)
        self.assertRefused(rc, record, "the volume's .env sets OPENAI_API_KEY (a line break inside its value")
        self.assertNotIn("oort-proof", json.dumps(record), "the value is never printed")
        rc, kills, record = self.monitor(healthy_cfg(), env_file=body)
        self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)

    def test_a_profile_entry_stops_the_start_and_the_live_report_and_an_empty_folder_does_not(self):
        def empty(data):
            os.mkdir(os.path.join(data, "profiles"))

        def with_entry(data):
            empty(data)
            os.mkdir(os.path.join(data, "profiles", "oort-proof-profile"))

        rc, record, _ = self.boot(setup=empty)
        self.assertEqual((rc, record["problems"]), (0, []))
        rc, kills, record = self.monitor(healthy_cfg(), setup=empty)
        self.assertEqual((rc, kills, record["problems"]), (0, [], []))
        rc, record, _ = self.boot(setup=with_entry)
        self.assertRefused(rc, record, "1 entry under profiles/")
        self.assertNotIn("oort-proof-profile", json.dumps(record))
        rc, kills, record = self.monitor(healthy_cfg(), setup=with_entry)
        self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)

    def test_a_name_that_is_not_allowed_stops_the_start_whatever_its_value_is_and_however_it_is_given(self):
        # Hermes resolves `${...}` in ITS environment, and nothing about a value can make a name acceptable: the name is refused, once, with
        # the same answer whatever the container's variable holds, and after the start too.
        for text, name in ((b"HERMES_SAFE_MODE=${OORT_PROOF_FLAG}\n", "HERMES_SAFE_MODE"), (b"HTTPS_PROXY=${HOME}\n", "HTTPS_PROXY"),
                           (b"HERMES_DASHBOARD=${OORT_PROOF_FLAG}\n", "HERMES_DASHBOARD"), (b"FAL_KEY=${OORT_PROOF_FLAG:-}\n", "FAL_KEY"),
                           (b"API_SERVER_KEY=${OORT_PROOF_FLAG:-" + b"k" * 40 + b"}\n", "API_SERVER_KEY"),
                           (b"HERMES_SAFE_MODE=${HERMES_SUPERVISED_CHILD:-0}\n", "HERMES_SAFE_MODE"),
                           (b"HERMES_YOLO_MODE=0\n", "HERMES_YOLO_MODE"), (b"API_SERVER_KEY=" + b"k" * 40 + b"\n", "API_SERVER_KEY"),
                           (b"API_SERVER_CORS_ORIGINS=\n", "API_SERVER_CORS_ORIGINS"), (b"hermes_safe_mode=1\n", "hermes_safe_mode")):
            for env in ({"OORT_PROOF_FLAG": "1", "HOME": "/home/someone"}, {"OORT_PROOF_FLAG": "0"}, {}):
                with self.subTest(name=name, environment=env, text=text[:30]):
                    rc, record, _ = self.boot(env=env, env_file=text)
                    self.assertRefused(rc, record, "the volume's .env sets %s (" % name)
                    self.assertEqual(len([p for p in record["problems"] if name in p]), 1, record["problems"])
                    self.assertNotIn("k" * 40, json.dumps(record))
                    rc, kills, record = self.monitor(healthy_cfg(), env=env, env_file=text)
                    self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)

    def test_a_name_hermes_applies_at_a_later_load_or_from_a_file_it_left_alone_stops_the_start_and_the_live_report(self):
        # Hermes loads the file again and again and every load rewrites it, so the gate (at boot) and the report (on the live file) judge
        # every text a load may parse, not only the first. One entry per way a text is reached; each is refused once, by name.
        mark = b"\xef\xbb\xbf"
        for label, text, name in (
            ("a later load", (b" " + mark) * 3 + b"HERMES_SAFE_MODE=1\n", "HERMES_SAFE_MODE"),
            ("a later load of a rule on every start", (b" " + mark) * 2 + b"HERMES_YOLO_MODE=1\n", "HERMES_YOLO_MODE"),
            ("a much later load", (b"\t" + mark) * 9 + b"HTTPS_PROXY=http://proxy.example:3128\n", "HTTPS_PROXY"),
            ("a file its clean-up leaves alone", b'\xef\xbf\xbd\n\x00 Q="x\nHERMES_SAFE_MODE=1\n"\n', "HERMES_SAFE_MODE"),
            ("a file its clean-up leaves alone, a rule on every start", b'\xef\xbf\xbd\n\x00 Q="x\nHERMES_YOLO_MODE=1\n"\n', "HERMES_YOLO_MODE"),
        ):
            with self.subTest(file=label):
                rc, record, _ = self.boot(env_file=text)
                self.assertRefused(rc, record, "the volume's .env")
                # a mark left in a name makes it another name, refused as a line of its own
                self.assertEqual(len([p for p in record["problems"] if name in p and "\ufeff" not in p]), 1, record["problems"])
                self.assertNotIn("proxy.example", json.dumps(record))
                rc, kills, record = self.monitor(healthy_cfg(), env_file=text)
                self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)
        with self.subTest(file="no end to the rewriting"):  # more pairs than the gate follows: refused as a whole, whatever the name is
            text = (b" " + mark) * (lockgate.ENV_LOAD_CAP + 1) + b"OPENAI_API_KEY=0\n"
            rc, record, _ = self.boot(env_file=text)
            self.assertRefused(rc, record, "cannot parse the volume's .env")
            rc, kills, record = self.monitor(healthy_cfg(), env_file=text)
            self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)

    def test_a_reference_in_an_allowed_name_does_not_stop_the_start(self):
        rc, record, _ = self.boot(env_file=b"OPENAI_API_KEY=${OORT_PROOF_FLAG}\nANTHROPIC_API_KEY=$HOME\n")
        self.assertEqual((rc, record["problems"]), (0, []))

    def test_the_file_hermes_seeds_into_a_fresh_volume_does_not_stop_the_start_or_the_live_report(self):
        # docker/stage2-hook.sh copies the image's .env.example into a fresh volume AFTER the gate: boot 1 sees no file, the report and boot 2 see
        # this one (#4950). Refusing it would end every fresh install in a restart loop.
        seeded = "# Hermes' own first-boot template\n\n" + "".join("%s=%s\n" % item for item in lockgate.VOLUME_ENV_SEEDED.items())
        rc, record, _ = self.boot(env_file=seeded.encode())
        self.assertEqual((rc, record["problems"]), (0, []))
        rc, kills, record = self.monitor(healthy_cfg(), env_file=seeded.encode())
        self.assertEqual((rc, kills, record["problems"]), (0, [], []))
        rc, record, _ = self.boot(env_file=(seeded + "TERMINAL_TIMEOUT=61\n").encode())
        self.assertRefused(rc, record, "the volume's .env sets TERMINAL_TIMEOUT (")

    def test_the_live_report_judges_the_volumes_env_whichever_tools_are_exposed(self):
        # The boot gate reads the volume's `.env` whatever is exposed; the report does too, so a file edited after the start (or one the
        # boot gate misread) is not left alone until the next restart.
        for label, cfg, tools in (("no picture tool", {"web": healthy_cfg()["web"]}, TOOLS - {"image_generate"}),
                                  ("picture tool exposed", healthy_cfg(), TOOLS)):
            with self.subTest(case=label, file="none"):
                self.assertEqual(self.monitor(cfg, tools=tools)[:2], (0, []))
            for line, fragment in (("HERMES_YOLO_MODE=1", "HERMES_YOLO_MODE"), ("HERMES_DASHBOARD=true", "HERMES_DASHBOARD"),
                                   ("API_SERVER_CORS_ORIGINS=https://evil.example", "API_SERVER_CORS_ORIGINS"),
                                   ("API_SERVER_KEY=short", "API_SERVER_KEY"), ("FAL_KEY=" + "f" * 12, "FAL_KEY"),
                                   ("HERMES_DASHBOARD=${OORT_PROOF_UNSET:-0}", "HERMES_DASHBOARD"), ("HERMES_YOLO_MODE=0", "HERMES_YOLO_MODE")):
                with self.subTest(case=label, line=line):
                    rc, kills, record = self.monitor(cfg, tools=tools, env_file=(line + "\n").encode())
                    self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)
                    self.assertTrue(any(fragment in p and "the volume's .env" in p for p in record["problems"]), record["problems"])
                    self.assertNotIn("f" * 12, json.dumps(record))
            with self.subTest(case=label, file="harmless"):
                rc, kills, record = self.monitor(cfg, tools=tools, env_file=b"OPENAI_API_KEY=keep\n# HERMES_DASHBOARD=true\n")
                self.assertEqual((rc, kills, record["problems"]), (0, [], []))

    def test_boot_and_report_judge_the_volume_with_the_same_function(self):
        # One judgement (#4950): a stand-in for `volume_env_problems` is heard by both entry points, with the same argument, and nothing
        # else in either of them reads the file. A `report` that judged the file by some other function would not hear it.
        sentinel = "the volume's .env sets OORT_PROOF_SENTINEL (stand-in)"
        with mock.patch.object(lockgate, "volume_env_problems", return_value=[sentinel]) as judged:
            rc, record, _ = self.boot()
            self.assertEqual(rc, 3)
            self.assertIn(sentinel, record["problems"])
            rc, kills, record = self.monitor(healthy_cfg())
            self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]))
            self.assertIn(sentinel, record["problems"])
        self.assertEqual(len(judged.call_args_list), 2, "once for the boot gate, once for the report")
        for call in judged.call_args_list:
            self.assertEqual(len(call.args), 1)
            self.assertFalse(call.kwargs)
            self.assertEqual(os.path.basename(call.args[0]), ".env")

    def test_the_gate_names_the_parser_it_used(self):
        rc, record, _ = self.boot()
        self.assertEqual((rc, record["env_parser"]), (0, lockgate.env_parser()))
        with mock.patch.object(lockgate, "_DotEnv", None):
            rc, record, _ = self.boot()
        self.assertEqual((rc, record["env_parser"]), (0, {"impl": "fallback"}))

    def test_the_live_volume_is_read_the_same_way_after_start(self):
        for line in ("HERMES_SAFE_MODE=1 # note", "export\t'OORT_SELF_MEDIA_ORIGIN'=x", "'HERMES_MEDIA_DELIVERY_STRICT'=1"):
            with self.subTest(line=line):
                rc, kills, record = self.monitor(healthy_cfg(), env_file=(line + "\n").encode())
                self.assertEqual((rc, kills), (3, [mock.call(1, lockgate.signal.SIGTERM)]), record)
        rc, kills, record = self.monitor(healthy_cfg(), env_file=b"# HERMES_SAFE_MODE=1\nOPENAI_API_KEY=0 # =1\n")
        self.assertEqual((rc, kills), (0, []), record)


class AcceptedConfigs(GateHarness):
    """#4935: the bytes of config.yaml are pinned. The default config and the connector-mode config of each model fragment (rebuilt from the
    repo's pieces by render_model_config.py) are accepted by name; any other bytes are refused whatever they say, beside every other rule. The
    other tests of this file boot a fixture file and accept exactly that fixture (see `GateHarness.boot`)."""

    @classmethod
    def setUpClass(cls):
        module = load(os.path.join(HERE, "render_model_config.py"), "render_model_config_for_accepted_configs")
        cls.catalog = {name: text.encode("utf-8") for name, text in module.repo_catalog(HERE).items()}

    def test_the_default_and_every_connector_config_are_accepted_by_name(self):
        self.assertEqual(len(self.catalog), 5)
        for name, raw in self.catalog.items():
            with self.subTest(config=name):
                rc, record, _ = self.boot(config_bytes=raw)
                self.assertEqual((rc, record["problems"]), (0, []))
                self.assertEqual(record["config_accepted_as"], name)
                self.assertEqual(record["config_sha256"], hashlib.sha256(raw).hexdigest())

    def test_one_changed_byte_is_refused_and_named_without_a_line_of_the_file(self):
        for name, raw in self.catalog.items():
            for label, changed in (("a comment added", raw + b"#\n"), ("no final newline", raw.rstrip(b"\n")), ("a blank line", raw + b"\n"),
                                   ("one letter changed", raw.replace(b"max_turns", b"max_turn", 1) if b"max_turns" in raw else raw[:-2] + b"x\n"),
                                   ("crlf line ends", raw.replace(b"\n", b"\r\n")), ("a blank in front", b" " + raw), ("empty", b"")):
                with self.subTest(config=name, change=label):
                    self.assertNotEqual(changed, raw)
                    rc, record, _ = self.boot(config_bytes=changed)
                    self.assertRefused(rc, record, "config.yaml is not one of the accepted configs")
                    self.assertIsNone(record["config_accepted_as"])
                    self.assertEqual(record["config_sha256"], hashlib.sha256(changed).hexdigest())
                    text = " ".join(record["problems"])
                    self.assertIn(hashlib.sha256(changed).hexdigest(), text)
                    self.assertNotIn("max_turn", text.replace("max_turns", ""), "no line of the file is printed")

    def test_what_is_judged_is_the_file_that_was_hashed_and_not_a_second_read_of_it(self):
        # the file changes between the hash and the copy the judgement is made on (a writer of the volume, a gap of milliseconds): the scratch
        # home must hold the bytes that were hashed and accepted, never the bytes that replaced them
        raw = self.catalog["default"]
        swapped = raw + b"#\n"
        rc, record, fake = self.boot(config_bytes=raw, swap_config_after_hash=swapped)
        self.assertEqual((rc, record["problems"]), (0, []))
        self.assertEqual(record["config_accepted_as"], "default")
        self.assertEqual(fake.scratch_configs, [raw])
        # the control: the swap really happens, so the file on disk is what a second read would have given
        rc, record, fake = self.boot(config_bytes=raw)
        self.assertEqual(fake.scratch_configs, [raw])

    def test_the_other_rules_still_apply_beside_an_accepted_config_and_beside_a_refused_one(self):
        default = self.catalog["default"]
        rc, record, _ = self.boot(config_bytes=default, env={"HERMES_SAFE_MODE": "1"})
        self.assertRefused(rc, record, "HERMES_SAFE_MODE")
        self.assertFalse(any("accepted configs" in p for p in record["problems"]), record["problems"])
        rc, record, _ = self.boot(config_bytes=default + b"#\n", env={"HERMES_SAFE_MODE": "1"})  # the gate does not stop at the first reason
        self.assertRefused(rc, record, "HERMES_SAFE_MODE")
        self.assertTrue(any("accepted configs" in p for p in record["problems"]), record["problems"])

    def test_a_connector_config_boots_only_with_the_strict_flag_and_the_attested_apps(self):
        cfg, tools = connector_cfg(), {"memory", "todo_list", "session_search"}
        apps = {lockgate.APPS_ENV: "com.momo.plugins.gmail,com.momo.plugins.google-calendar"}
        raw = self.catalog["connector/claude-oauth.fallback-codex-oauth"]
        rc, record, _ = self.boot(cfg, tools, env=apps, install_guard=False, config_bytes=raw)
        self.assertEqual((rc, record["problems"]), (0, []))
        self.assertEqual((record["config_accepted_as"], record["media_strict"], record["image_guard"]), ("connector/claude-oauth.fallback-codex-oauth", True, None))
        rc, record, _ = self.boot(cfg, tools, env={**apps, lockgate.MEDIA_STRICT_ENV: None}, install_guard=False, config_bytes=raw)
        self.assertRefused(rc, record, "must set " + lockgate.MEDIA_STRICT_ENV + "=1")
        self.assertIs(record["media_strict"], False)
        rc, record, _ = self.boot(cfg, tools, env={**apps, lockgate.MEDIA_STRICT_ENV: "true"}, install_guard=False, config_bytes=raw)
        self.assertRefused(rc, record, "must set " + lockgate.MEDIA_STRICT_ENV + "=1")
        rc, record, _ = self.boot(cfg, tools, install_guard=False, config_bytes=raw)  # the apps list is the operator's attestation (K4)
        self.assertRefused(rc, record, lockgate.APPS_ENV)

    def test_the_live_report_does_not_repeat_the_check(self):
        # The image's own boot migrates the volume's copy of config.yaml after the start command, so the live bytes are not the accepted ones.
        rc, kills, record = self.monitor(healthy_cfg())
        self.assertEqual((rc, kills), (0, []), record)
        self.assertFalse(any("accepted configs" in p for p in record["problems"]))


def connector_cfg():
    """A parsed connector-mode config of the shape `connector_problems` accepts (the real ones are held to it in test_google_connector_config.py)."""
    server = {"url": "https://mcp.example.com/mcp", "auth": "oauth", "trust": "untrusted", "sampling": {"enabled": False},
              "tools": {"include": ["search_threads", "get_thread"], "resources": False, "prompts": False}}
    return {"agent": {"disabled_toolsets": ["terminal", "code_execution", "browser", "cronjob", "delegation", "web", "image_gen"]},
            "mcp_servers": {"gmail": copy.deepcopy(server), "google_calendar": copy.deepcopy(server)}}


class HermesHomeIsTheFolderTheGateReads(GateHarness):
    """#4886: the gate reads `<data folder>/.env`; Hermes loads `$HERMES_HOME/.env`. They have to be the same folder."""

    def test_a_home_that_is_another_folder_stops_the_start(self):
        with tempfile.TemporaryDirectory() as other:
            rc, record, _ = self.boot(env={"HERMES_HOME": other})
        self.assertRefused(rc, record, "HERMES_HOME is not the folder this gate reads")
        self.assertNotIn(other, json.dumps(record))

    def test_no_home_at_all_stops_the_start(self):
        for home in (None, "", "   "):
            with self.subTest(home=home):
                rc, record, _ = self.boot(env={"HERMES_HOME": home})
                self.assertRefused(rc, record, "HERMES_HOME is not set")

    def test_the_check_does_not_depend_on_the_picture_tool(self):
        rc, record, _ = self.boot({"web": healthy_cfg()["web"]}, TOOLS - {"image_generate"}, install_guard=False,
                                  env={"HERMES_HOME": "/nonexistent-4886"})
        self.assertRefused(rc, record, "HERMES_HOME is not the folder this gate reads")
        self.assertNotIn("nonexistent-4886", json.dumps(record))

    def test_the_same_folder_written_another_way_is_the_same_folder(self):
        # Hermes expands `$VAR` and `~` in the variable (hermes_constants `_expand_hermes_home`); the folders are compared by real path.
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as parent:
            link = os.path.join(parent, "link")
            os.symlink(data, link)
            with mock.patch.dict(os.environ, {"OORT_PROOF_VOLUME": data}):
                for home in (data, data + "/", data + "//", os.path.join(data, "."), link, "$OORT_PROOF_VOLUME",
                             "${OORT_PROOF_VOLUME}", "  " + data + "  "):
                    with self.subTest(home=home):
                        self.assertEqual(lockgate.hermes_home_problems({"HERMES_HOME": home}, data), [])
                for home in (parent, os.path.join(data, "sub"), "/", "~", "$OORT_PROOF_UNSET_VARIABLE"):
                    with self.subTest(other=home):
                        self.assertEqual(len(lockgate.hermes_home_problems({"HERMES_HOME": home}, data)), 1)

    def test_a_home_that_needs_a_HOME_is_refused_even_when_this_gates_HOME_would_make_it_right(self):
        # `~` and `$HOME` mean a folder under the HOME of whoever expands them, and Hermes runs in a service slot with a HOME of its own.
        with tempfile.TemporaryDirectory() as data:
            with mock.patch.dict(os.environ, {"HOME": data, "OORT_PROOF_TILDE": "~", "OORT_PROOF_VOLUME": data}):
                for home in ("~", "~/", "~/.", "$HOME", "${HOME}", "$HOME/", "${HOME}/.", "$OORT_PROOF_TILDE", " ~ "):
                    with self.subTest(home=home):
                        problems = lockgate.hermes_home_problems({"HERMES_HOME": home}, data)
                        self.assertEqual(len(problems), 1)
                        self.assertIn("`~` or $HOME", problems[0])
                        self.assertNotIn(data, problems[0])
                # a different variable is not HOME, and any other `$VAR` is still read from the container's environment
                self.assertEqual(lockgate.hermes_home_problems({"HERMES_HOME": "$OORT_PROOF_VOLUME"}, data), [])
                self.assertIn("is not the folder", lockgate.hermes_home_problems({"HERMES_HOME": "$HOMER"}, data)[0])
        rc, record, _ = self.boot(env={"HERMES_HOME": "$HOME"})
        self.assertRefused(rc, record, "`~` or $HOME")


if __name__ == "__main__":
    unittest.main()
