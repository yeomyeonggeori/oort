"""Offline checks of the default Hermes config (#4072): python3 -m unittest infra/hermes/test_default_config.py -v

infra/hermes/config.yaml is what the compose `agents` profile mounts and what the Railway `hermes` service receives as
HERMES_CONFIG_B64. Stdlib only on purpose: a check that skips when PyYAML is missing cannot fail where it matters.
The deny-list is read as a plain list; the boot gate (lockgate.py) is the judge of everything else, and its own
rules are exercised in test_lockgate_connectors.py."""
import importlib.util
import os
import re
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lockgate", os.path.join(HERE, "lockgate.py"))
lockgate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lockgate)

# ADR-0203 D6 owner-mandated three, then what K-S1b measured as bypasses of them.
MANDATED = {"terminal", "code_execution", "browser"}
MEASURED_BYPASSES = {"file", "connections", "delegation", "cronjob", "skills", "web", "vision", "image_gen"}


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


class DefaultConfig(unittest.TestCase):
    def setUp(self):
        self.text = open(os.path.join(HERE, "config.yaml")).read()
        self.google = open(os.path.join(HERE, "google-connectors.config.yaml")).read()

    def test_the_mandated_three_and_the_measured_bypasses_are_off(self):
        off = set(disabled_toolsets(self.text))
        self.assertTrue(MANDATED <= off, "missing: %s" % sorted(MANDATED - off))
        self.assertTrue(MEASURED_BYPASSES <= off, "missing: %s" % sorted(MEASURED_BYPASSES - off))

    def test_same_deny_list_as_the_connector_reference_config(self):
        # Two copies of one list drift; the gate's `disabled_count=24` is what Railway measured.
        self.assertEqual(disabled_toolsets(self.text), disabled_toolsets(self.google))
        self.assertEqual(len(disabled_toolsets(self.text)), 24)

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

    def test_the_gate_allow_list_is_chat_only(self):
        self.assertEqual(set(lockgate.ALLOWED_TOOLS), {"memory", "todo_list", "session_search"})

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

    def test_an_unreadable_env_is_a_problem_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(len(lockgate.volume_env_problems(tmp)), 1)  # a directory cannot be read as a file


if __name__ == "__main__":
    unittest.main()
