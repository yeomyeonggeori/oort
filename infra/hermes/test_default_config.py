"""Offline checks of the default Hermes config (#4072): python3 -m unittest infra/hermes/test_default_config.py -v

infra/hermes/config.yaml is what the compose `agents` profile mounts and what the Railway `hermes` service receives as
HERMES_CONFIG_B64. Stdlib only on purpose: a check that skips when PyYAML is missing cannot fail where it matters.
The deny-list is read as a plain list; the boot gate (lockgate.py) is the judge of everything else, and its own
rules are exercised in test_lockgate_connectors.py."""
import copy
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lockgate", os.path.join(HERE, "lockgate.py"))
lockgate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lockgate)

# ADR-0203 D6 owner-mandated three, then what K-S1b measured as bypasses of them.
MANDATED = {"terminal", "code_execution", "browser"}
# `image_gen` was measured as a bypass in K-S1b and left this set on purpose: the 2026-10-30 augmentation for #4820 (I1-I4)
# turns it on in the default config with the Codex subscription provider only. The connector reference config still
# denies it, and the lockgate rules below (provider, FAL_KEY, connector exclusivity) are what keep that door narrow.
MEASURED_BYPASSES = {"file", "connections", "delegation", "cronjob", "skills", "vision"}


def disabled_toolsets(text):
    """The `agent.disabled_toolsets` list of a config written in this repo's flat style."""
    found, inside = [], False
    for line in text.splitlines():
        if re.match(r"^  disabled_toolsets:\s*$", line):
            inside = True
            continue
        if inside:
            item = re.match(r"^    - ([a-z0-9_]+)\b", line)
            if item:
                found.append(item.group(1))
            elif line.strip() and not line.lstrip().startswith("#"):
                break
    return found


def top_level_keys(text):
    return {m.group(1) for m in re.finditer(r"^([A-Za-z_][A-Za-z0-9_]*):", text, re.M)}


def install_guard_files(data_dir):
    """The shipped image-guard plugin under a fake Hermes volume, as the start command leaves it (#4820 review)."""
    root = os.path.join(data_dir, "plugins", lockgate.IMAGE_GUARD_PLUGIN)
    os.makedirs(root)
    for name in lockgate.IMAGE_GUARD_FILES:
        shutil.copyfile(os.path.join(HERE, "plugins", lockgate.IMAGE_GUARD_PLUGIN, name), os.path.join(root, name))


def cfg_from_text(text):
    """The `web` and `image_gen` sections of a config written in this repo's flat style, as `tool_problems` reads them.

    Stdlib only, like the readers above: it reads exactly `  key: value` lines under a top-level section."""
    cfg = {}
    for section in ("web", "image_gen"):
        match = re.search(r"(?m)^%s:\n((?:  [a-z_]+: .*\n)+)" % section, text)
        if not match:
            continue
        values = {}
        for key, raw in re.findall(r"(?m)^  ([a-z_]+): (\S+)", match.group(1)):
            values[key] = {"true": True, "false": False}.get(raw, raw)
        cfg[section] = values
    return cfg


class DefaultConfig(unittest.TestCase):
    def setUp(self):
        self.text = open(os.path.join(HERE, "config.yaml")).read()
        self.google = open(os.path.join(HERE, "google-connectors.config.yaml")).read()

    def test_the_mandated_three_and_the_measured_bypasses_are_off(self):
        off = set(disabled_toolsets(self.text))
        self.assertTrue(MANDATED <= off, "missing: %s" % sorted(MANDATED - off))
        self.assertTrue(MEASURED_BYPASSES <= off, "missing: %s" % sorted(MEASURED_BYPASSES - off))

    def test_only_web_and_image_gen_differ_from_the_connector_reference_config(self):
        # The connector reference remains fully web- and image-disabled; the default enables search only (#4794)
        # and the Codex subscription image tool (#4820).
        self.assertEqual(disabled_toolsets(self.text),
                         [x for x in disabled_toolsets(self.google) if x not in ("web", "image_gen")])
        self.assertEqual(len(disabled_toolsets(self.text)), 22)
        self.assertIn("image_gen", disabled_toolsets(self.google))
        self.assertNotIn("image_gen", disabled_toolsets(self.text))

    def test_api_server_uses_the_search_only_toolset_and_subscription_backend(self):
        # Read this small list without depending on optional PyYAML, as for the deny-list above.
        match = re.search(r"(?m)^platform_toolsets:\n  api_server:\n((?:    - .*\n)+)", self.text)
        self.assertIsNotNone(match)
        selected = re.findall(r"(?m)^    - ([a-z_]+)\b", match.group(1))
        self.assertEqual(selected, ["memory", "todo", "session_search", "search", "image_gen"])
        self.assertNotIn("web", selected, "the combined `web` toolset would add web_extract")
        self.assertRegex(self.text, r"(?m)^web:\n  search_backend: openai-native\b.*\n  keyless_fallback: false\b")

    def test_image_generation_is_the_codex_subscription_provider_only(self):
        self.assertRegex(self.text, r"(?m)^image_gen:\n  provider: openai-codex\b")
        # No credential-bearing or alternative provider setting rides in the default config.
        body = re.sub(r"(?m)#.*$", "", self.text)
        for other in ("fal", "openai-api", "krea", "xai", "nous"):
            self.assertNotRegex(body, r"(?m)^\s+provider:\s*%s\b" % other)
        self.assertNotIn("FAL_KEY", body)
        self.assertEqual(lockgate.tool_problems(cfg_from_text(self.text), lockgate.ALLOWED_TOOLS), [])

    def test_no_connector_mode_and_no_model_here(self):
        keys = top_level_keys(self.text)
        self.assertNotIn("mcp_servers", keys, "connector mode is a separate, attested opt-in")
        self.assertNotIn("model", keys, "model authentication is #4073's step, not baked into the image of the config")
        self.assertEqual(lockgate.connector_problems({"agent": {"disabled_toolsets": disabled_toolsets(self.text)}}, {}), [])

    def test_approvals_stay_manual_and_unattended_denies(self):
        self.assertRegex(self.text, r"(?m)^  mode: manual\b")
        self.assertRegex(self.text, r"(?m)^  unattended_mode: deny\b")
        self.assertNotRegex(self.text, r"(?m)^\s*mode:\s*off\b")
        self.assertNotIn("HERMES_YOLO_MODE", re.sub(r"(?m)#.*$", "", self.text))

    def test_telemetry_and_update_checks_stay_off(self):
        self.assertRegex(self.text, r"(?m)^    enabled: false\b")
        self.assertRegex(self.text, r"(?m)^    send: false\b")
        self.assertRegex(self.text, r"(?m)^  check: false\b")

    def test_the_gate_allows_search_and_image_generation_and_keeps_extraction_and_execution_out(self):
        self.assertEqual(set(lockgate.ALLOWED_TOOLS),
                         {"memory", "todo_list", "session_search", "web_search", "image_generate"})
        for tool in ("web_extract", "terminal", "process_manage", "execute_code", "browser_navigate", "read_file",
                     "write_file", "delegate_task", "skill_manage", "manage_connections", "cronjob_manage",
                     "vision_analyze", "video_generate", "xai_video_edit", "text_to_speech", "x_search"):
            self.assertNotIn(tool, lockgate.ALLOWED_TOOLS, tool)

    def test_dropping_a_mandated_toolset_is_detected(self):
        # The sabotage the gate-side test relies on: removing `terminal` must change what this file's reader sees.
        broken = re.sub(r"(?m)^    - terminal\b.*\n", "", self.text)
        self.assertNotIn("terminal", disabled_toolsets(broken))
        self.assertFalse(MANDATED <= set(disabled_toolsets(broken)))


class VolumeEnv(unittest.TestCase):
    """A reused volume's own `.env` is loaded after the gate judged a scratch home (#4072 review M2)."""

    def problems(self, text):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".env")
            if text is not None:
                with open(path, "w") as handle:
                    handle.write(text)
            return lockgate.volume_env_problems(path)

    def test_fresh_volume_and_a_template_of_comments_are_fine(self):
        self.assertEqual(self.problems(None), [])
        self.assertEqual(self.problems("# HERMES_YOLO_MODE=1\n# API_SERVER_CORS_ORIGINS=*\nOPENROUTER_API_KEY=x\n"), [])

    def test_each_undoing_line_is_named_without_its_value(self):
        for line, name in (
            ("HERMES_YOLO_MODE=1", "HERMES_YOLO_MODE"),
            ("export HERMES_DASHBOARD=true", "HERMES_DASHBOARD"),
            ('API_SERVER_CORS_ORIGINS="https://evil.example"', "API_SERVER_CORS_ORIGINS"),
            ("API_SERVER_KEY=short", "API_SERVER_KEY"),
        ):
            with self.subTest(line=line):
                found = self.problems("OPENROUTER_API_KEY=keep\n" + line + "\n")
                self.assertEqual(len(found), 1)
                self.assertIn(name, found[0])
                self.assertNotIn("evil.example", found[0])
                self.assertNotIn("short", found[0].replace("shorter", ""))

    def test_another_image_provider_key_is_named_without_its_value(self):
        found = self.problems("OPENROUTER_API_KEY=keep\nexport FAL_KEY=fixture-secret-value\n")
        self.assertEqual(len(found), 1)
        self.assertIn("FAL_KEY", found[0])
        self.assertNotIn("fixture-secret-value", found[0])
        # An empty value or a comment is not a credential.
        self.assertEqual(self.problems("FAL_KEY=\n# FAL_KEY=x\n"), [])

    def test_an_unreadable_env_is_a_problem_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(len(lockgate.volume_env_problems(tmp)), 1)  # a directory cannot be read as a file


class WebToolPolicy(unittest.TestCase):
    def setUp(self):
        self.cfg = {"web": {"search_backend": "openai-native", "keyless_fallback": False}}

    def test_chat_with_subscription_search_is_allowed_and_chat_alone_can_roll_back(self):
        # Search alone, without the image tool: rolling image generation back must leave this passing (ADR-0203 I4).
        self.assertEqual(lockgate.tool_problems(self.cfg, lockgate.ALLOWED_TOOLS - lockgate.IMAGE_TOOLS), [])
        self.assertEqual(lockgate.tool_problems({}, {"memory", "todo_list", "session_search"}), [])

    def test_extraction_and_preexisting_bypasses_are_refused(self):
        for tool in ("web_extract", "terminal", "execute_code", "browser_navigate", "read_file", "delegate_task"):
            with self.subTest(tool=tool):
                self.assertTrue(lockgate.tool_problems(self.cfg, {"memory", tool}))

    def test_missing_or_different_search_backend_is_refused(self):
        for web in (None, "openai-native", {}, {"search_backend": "firecrawl"}, {"backend": "openai-native"}):
            with self.subTest(web=web):
                found = lockgate.tool_problems({"web": web}, {"memory", "web_search"})
                self.assertTrue(any("web.search_backend" in p for p in found))

    def test_keyless_fallback_must_be_explicitly_false(self):
        for value in (None, True, "false", 0):
            cfg = copy.deepcopy(self.cfg)
            cfg["web"]["keyless_fallback"] = value
            with self.subTest(value=value):
                self.assertTrue(any("web.keyless_fallback" in p for p in lockgate.tool_problems(cfg, {"web_search"})))


class ImageToolPolicy(unittest.TestCase):
    """image_generate is allowed with exactly one provider and never beside connectors (ADR-0203 augmentation, #4820)."""

    def setUp(self):
        self.cfg = {"web": {"search_backend": "openai-native", "keyless_fallback": False},
                    "image_gen": {"provider": "openai-codex"}}

    def test_the_full_default_surface_is_allowed_and_each_half_can_roll_back_alone(self):
        self.assertEqual(lockgate.tool_problems(self.cfg, lockgate.ALLOWED_TOOLS), [])
        # Image generation rolled back: no image config is needed and nothing else changes.
        self.assertEqual(lockgate.tool_problems({"web": self.cfg["web"]}, lockgate.ALLOWED_TOOLS - lockgate.IMAGE_TOOLS), [])
        # Search rolled back, image kept.
        self.assertEqual(lockgate.tool_problems({"image_gen": self.cfg["image_gen"]},
                                                {"memory", "todo_list", "session_search", "image_generate"}), [])

    def test_any_provider_but_the_codex_subscription_is_refused(self):
        for image in (None, "openai-codex", {}, {"provider": None}, {"provider": ""}, {"provider": "fal"},
                      {"provider": "nous"}, {"provider": "openai"}, {"provider": "openai-api"}, {"provider": "krea"},
                      {"provider": "xai"}, {"provider": "OpenAI-Codex"}, {"provider": " openai-codex"},
                      {"provider": ["openai-codex"]}, {"model": "gpt-image-2", "providers": "openai-codex"}):
            cfg = copy.deepcopy(self.cfg)
            if image is None:
                del cfg["image_gen"]
            else:
                cfg["image_gen"] = image
            with self.subTest(image=image):
                found = lockgate.tool_problems(cfg, {"memory", "image_generate"})
                self.assertTrue(any("image_gen.provider" in p for p in found), found)

    def test_the_provider_rule_only_applies_when_the_tool_is_exposed(self):
        # A config that does not select image generation needs no provider; the rule must not reject chat-only configs.
        self.assertEqual(lockgate.tool_problems({}, {"memory", "todo_list", "session_search"}), [])
        self.assertEqual(lockgate.tool_problems({"image_gen": {"provider": "fal"}}, {"memory"}), [])

    def test_code_execution_files_urls_and_other_generators_stay_refused_beside_the_image_tool(self):
        for tool in ("execute_code", "terminal", "process_manage", "read_file", "write_file", "patch", "browser_navigate",
                     "web_extract", "delegate_task", "skill_manage", "manage_connections", "cronjob_manage",
                     "vision_analyze", "video_generate", "xai_video_edit", "text_to_speech", "x_search"):
            with self.subTest(tool=tool):
                found = lockgate.tool_problems(self.cfg, {"memory", "image_generate", tool})
                self.assertTrue(any(tool in p and "allow-list" in p for p in found), found)

    def test_connector_mode_refuses_the_image_tool_even_with_the_right_provider(self):
        cfg = {**self.cfg, "mcp_servers": {"gmail": {}}}
        found = lockgate.tool_problems(cfg, {"memory", "image_generate"})
        self.assertTrue(any("connector mode forbids image generation" in p for p in found), found)
        # ...while the same connector config without the image tool is not touched by this rule.
        self.assertFalse(any("image" in p for p in lockgate.tool_problems(cfg, {"memory"})))

    def test_the_connector_rules_require_image_gen_in_the_deny_list(self):
        off = [x for x in lockgate.CONNECTOR_REQUIRED_DISABLED]
        self.assertIn("image_gen", off)
        self.assertIn("web", off)


class EnforcedWebToolPolicy(unittest.TestCase):
    """Exercise the actual pre-start/monitor entry points. Only Hermes, HTTP and PID 1 are doubles.

    In particular, gate() sees search before credential availability filtering; hiding it from the
    returned definitions must not hide a policy violation. No service or vendor is contacted.
    """
    def setUp(self):
        self.cfg = {"web": {"search_backend": "openai-native", "keyless_fallback": False}}
        self.tools = {"memory", "todo_list", "session_search", "web_search"}

    def hermes_modules(self, cfg, tools):
        modules = {name: types.ModuleType(name) for name in (
            "hermes_cli", "hermes_cli.config", "hermes_cli.tools_config", "model_tools")}
        modules["hermes_cli.config"].load_config = mock.Mock(return_value=cfg)
        modules["hermes_cli.tools_config"]._get_platform_tools = mock.Mock(return_value={"memory", "search"})
        modules["model_tools"]._select_tool_names = mock.Mock(return_value=tools)
        modules["model_tools"].get_tool_definitions = mock.Mock(return_value=[{"function": {"name": "memory"}}])
        return modules

    def boot(self, cfg, tools, extra_env=None):
        with tempfile.TemporaryDirectory() as tmp:
            install_guard_files(tmp)  # the canary itself is exercised in test_lockgate_image_guard.py; stubbed here
            path = os.path.join(tmp, "config.yaml")
            with open(path, "w") as handle:
                handle.write("# isolated boot fixture; load_config is doubled\n")
            env = {"API_SERVER_KEY": "test-only-" * 4, "HERMES_DATA_DIR": tmp, "HERMES_HOME": tmp,  # the image's ENV HERMES_HOME (#4886)
                   lockgate.MEDIA_STRICT_ENV: lockgate.MEDIA_STRICT_VALUE, **(extra_env or {})}
            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.dict(sys.modules, self.hermes_modules(cfg, tools)), \
                    mock.patch.object(sys, "path", list(sys.path)), \
                    mock.patch.object(lockgate.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)), \
                    mock.patch.object(lockgate, "hermes_image_guard_canary", return_value=([], {"stubbed": True})), \
                    mock.patch.object(lockgate, "emit") as emit:
                rc = lockgate.gate(path)
                return rc, emit.call_args.kwargs

    def monitor(self, cfg, tools, load_error=None, reported_tools=None):
        modules = self.hermes_modules(cfg, tools)
        modules["hermes_cli.config"].load_config.side_effect = load_error
        if reported_tools is None:
            data = [{"name": "fixture", "enabled": True, "tools": sorted(tools)}]
        else:
            # Real v0.22.2 API shape for the search-only config: configurable `web` is off and `search`
            # is not a configurable category, so web_search is missing entirely from the response.
            data = [{"name": "web", "enabled": False, "tools": ["web_search", "web_extract"]}]
            data += [{"name": name, "enabled": True, "tools": [name]} for name in sorted(reported_tools)]
        body = json.dumps({"data": data}).encode()
        volume = tempfile.TemporaryDirectory()
        self.addCleanup(volume.cleanup)
        install_guard_files(volume.name)
        with mock.patch.dict(os.environ, {"API_SERVER_KEY": "test-only-" * 4, "HERMES_DATA_DIR": volume.name,
                                          lockgate.MEDIA_STRICT_ENV: lockgate.MEDIA_STRICT_VALUE}, clear=True), \
                mock.patch.dict(sys.modules, modules), \
                mock.patch.object(sys, "path", list(sys.path)), \
                mock.patch.object(lockgate, "_status", side_effect=lambda url, *args: (200 if url.endswith("/health") else 401, {})), \
                mock.patch.object(lockgate.urllib.request, "urlopen", return_value=io.BytesIO(body)), \
                mock.patch.object(lockgate.socket, "create_connection", side_effect=OSError), \
                mock.patch.object(lockgate.os, "kill") as kill, \
                mock.patch.object(lockgate, "emit") as emit:
            rc = lockgate.report()
            return rc, kill.call_args_list, emit.call_args.kwargs

    def test_healthy_search_and_chat_only_rollback_pass_both_entry_points(self):
        for cfg, tools in ((self.cfg, self.tools), ({}, self.tools - {"web_search"})):
            with self.subTest(cfg=cfg):
                self.assertEqual(self.boot(cfg, tools)[0], 0)
                rc, kills, _ = self.monitor(cfg, tools)
                self.assertEqual((rc, kills), (0, []))

    def test_prestart_refuses_unavailable_tools_and_wrong_backends_before_listening(self):
        for cfg, tools in (
            (self.cfg, self.tools | {"web_extract"}),
            ({"web": {"search_backend": "firecrawl", "keyless_fallback": False}}, self.tools),
            ({"web": {"search_backend": "openai-native", "keyless_fallback": True}}, self.tools),
            ({**self.cfg, "mcp_servers": {"gmail": {}}}, self.tools),
        ):
            with self.subTest(cfg=cfg, tools=tools):
                rc, record = self.boot(cfg, tools)
                self.assertEqual(rc, 3)
                self.assertFalse(record["ok"])
                self.assertTrue(record["problems"])

    def test_live_extraction_wrong_backend_and_connector_search_request_shutdown(self):
        for cfg, tools in (
            (self.cfg, self.tools | {"web_extract"}),
            ({"web": {"search_backend": "firecrawl", "keyless_fallback": False}}, self.tools),
            ({**self.cfg, "mcp_servers": {"gmail": {}}}, self.tools),
        ):
            with self.subTest(cfg=cfg, tools=tools):
                rc, kills, record = self.monitor(cfg, tools)
                self.assertEqual(rc, 3)
                self.assertEqual(kills, [mock.call(1, lockgate.signal.SIGTERM)])
                self.assertTrue(record["problems"])

    def test_unreadable_live_config_is_unverified_and_never_a_success(self):
        rc, kills, record = self.monitor(self.cfg, self.tools, load_error=OSError("fixture"))
        self.assertEqual((rc, kills), (1, []))
        self.assertFalse(record["ok"])
        self.assertIn("cannot verify live tool policy", record["why"])

    def test_real_api_search_omission_does_not_hide_config_drift(self):
        reported = self.tools - {"web_search"}
        rc, kills, record = self.monitor(self.cfg, self.tools, reported_tools=reported)
        self.assertEqual((rc, kills), (0, []))
        self.assertEqual(record["unreported_selected_tools"], ["web_search"])
        self.assertEqual(set(record["live_tools"]), reported)
        for cfg in (
            {"web": {"search_backend": "firecrawl", "keyless_fallback": False}},
            {"web": {"search_backend": "openai-native", "keyless_fallback": True}},
            {**self.cfg, "mcp_servers": {"gmail": {}}},
        ):
            with self.subTest(cfg=cfg):
                rc, kills, record = self.monitor(cfg, self.tools, reported_tools=reported)
                self.assertEqual(rc, 3)
                self.assertEqual(kills, [mock.call(1, lockgate.signal.SIGTERM)])
                self.assertTrue(record["problems"])

    def test_reported_extraction_is_refused_even_when_config_selects_only_search(self):
        rc, kills, record = self.monitor(self.cfg, self.tools, reported_tools=self.tools | {"web_extract"})
        self.assertEqual(rc, 3)
        self.assertEqual(kills, [mock.call(1, lockgate.signal.SIGTERM)])
        self.assertTrue(any("web_extract" in p for p in record["problems"]))

    # --- image generation through the same two entry points (ADR-0203 augmentation, #4820) ---------------------
    def image_cfg(self, **over):
        return {**self.cfg, "image_gen": {"provider": "openai-codex"},
                "plugins": {"enabled": [lockgate.IMAGE_GUARD_PLUGIN], "isolation": "in_process"}, **over}

    def image_tools(self):
        return self.tools | {"image_generate"}

    def test_image_generation_with_the_codex_provider_passes_both_entry_points(self):
        cfg, tools = self.image_cfg(), self.image_tools()
        rc, record = self.boot(cfg, tools)
        self.assertEqual((rc, record["problems"]), (0, []))
        rc, kills, _ = self.monitor(cfg, tools)
        self.assertEqual((rc, kills), (0, []))

    def test_prestart_refuses_another_image_provider_a_connector_and_a_second_provider_key(self):
        tools = self.image_tools()
        for cfg, extra_env, fragment in (
            (self.image_cfg(image_gen={"provider": "fal"}), {}, "image_gen.provider"),
            (self.image_cfg(image_gen={}), {}, "image_gen.provider"),
            ({**self.cfg}, {}, "image_gen.provider"),
            (self.image_cfg(mcp_servers={"gmail": {}}), {}, "connector mode forbids image generation"),
            (self.image_cfg(), {"FAL_KEY": "fixture-not-a-key"}, "FAL_KEY"),
        ):
            with self.subTest(cfg=cfg, extra_env=sorted(extra_env)):
                rc, record = self.boot(cfg, tools, extra_env)
                self.assertEqual(rc, 3)
                self.assertFalse(record["ok"])
                self.assertTrue(any(fragment in p for p in record["problems"]), record["problems"])
                self.assertNotIn("fixture-not-a-key", json.dumps(record))

    def test_prestart_refuses_code_execution_beside_the_image_tool(self):
        for tool in ("execute_code", "terminal", "web_extract"):
            with self.subTest(tool=tool):
                rc, record = self.boot(self.image_cfg(), self.image_tools() | {tool})
                self.assertEqual(rc, 3)
                self.assertTrue(any(tool in p for p in record["problems"]), record["problems"])

    def test_live_provider_drift_and_connector_image_request_shutdown(self):
        tools = self.image_tools()
        for cfg in (self.image_cfg(image_gen={"provider": "fal"}), {**self.cfg},
                    self.image_cfg(mcp_servers={"gmail": {}})):
            with self.subTest(cfg=cfg):
                rc, kills, record = self.monitor(cfg, tools)
                self.assertEqual(rc, 3)
                self.assertEqual(kills, [mock.call(1, lockgate.signal.SIGTERM)])
                self.assertTrue(record["problems"])

    def test_real_api_shape_keeps_judging_the_image_provider(self):
        # /v1/toolsets lists the configurable `image_gen` category with its tool when enabled.
        tools = self.image_tools()
        rc, kills, record = self.monitor(self.image_cfg(), tools, reported_tools=tools - {"web_search"})
        self.assertEqual((rc, kills), (0, []))
        self.assertIn("image_generate", record["live_tools"])
        rc, kills, record = self.monitor(self.image_cfg(image_gen={"provider": "openai"}), tools,
                                         reported_tools=tools - {"web_search"})
        self.assertEqual(rc, 3)
        self.assertEqual(kills, [mock.call(1, lockgate.signal.SIGTERM)])


if __name__ == "__main__":
    unittest.main()
