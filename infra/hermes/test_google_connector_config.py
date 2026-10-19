"""Offline checks of the K-S1b Google connector config (#3952): python3 -m unittest infra/hermes/test_google_connector_config.py -v

The config is judged by the same `connector_problems` the boot gate uses, plus two things the gate cannot know:
no write tool name and no write-capable scope in the reference config, and no client secret literal in it.
Needs PyYAML (skips without it)."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lockgate", os.path.join(HERE, "lockgate.py"))
lockgate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lockgate)
try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

APPS = "com.momo.plugins.gmail,com.momo.plugins.google-calendar,com.momo.plugins.google-drive"
# Vendor tools without readOnlyHint (measured with an unauthenticated tools/list on 2026-10-19).
WRITE_TOOLS = {
    "create_draft", "label_thread", "unlabel_thread", "apply_sensitive_thread_label", "trash_thread", "untrash_thread",
    "mark_thread_spam", "unmark_thread_spam", "label_message", "update_message_labels", "unlabel_message",
    "apply_sensitive_message_label", "trash_message", "untrash_message", "mark_message_spam", "unmark_message_spam",
    "create_label", "create_event", "update_event", "delete_event", "respond_to_event", "copy_file", "create_file",
}
WRITE_SCOPE_MARKS = ("mail.google.com", "gmail.modify", "gmail.compose", "gmail.send", "gmail.drafts",
                     "gmail.labels", "calendar.events\n", "drive.file", "auth/drive ", "auth/calendar ")


@unittest.skipIf(yaml is None, "PyYAML not installed")
class GoogleConnectorConfig(unittest.TestCase):
    def setUp(self):
        self.text = open(os.path.join(HERE, "google-connectors.config.yaml")).read()
        self.cfg = yaml.safe_load(self.text)

    def test_passes_the_boot_gate_rules(self):
        self.assertEqual(lockgate.connector_problems(self.cfg, {lockgate.APPS_ENV: APPS}), [])

    def test_servers_are_the_three_google_apps(self):
        self.assertEqual(set(self.cfg["mcp_servers"]), {"gmail", "google_calendar", "google_drive"})

    def test_no_write_tool_is_included(self):
        for name, server in self.cfg["mcp_servers"].items():
            self.assertFalse(WRITE_TOOLS & set(server["tools"]["include"]), name)

    def test_scopes_are_read_only(self):
        for name, server in self.cfg["mcp_servers"].items():
            scope = server["oauth"]["scope"] + " "
            for mark in WRITE_SCOPE_MARKS:
                self.assertNotIn(mark, scope, f"{name}: {mark!r}")
            for part in scope.split():
                self.assertRegex(part, r"readonly$|freebusy$", f"{name}: {part}")

    def test_model_auth_is_subscription_oauth_not_a_key(self):
        self.assertEqual(self.cfg["model"]["provider"], "openai-codex")
        self.assertEqual(self.cfg["fallback_model"]["provider"], "anthropic")
        # Names must exist in the pinned Hermes v0.22.2 catalogs (hermes_cli/models_catalog_static.py):
        # anthropic has claude-sonnet-5 but NOT claude-sonnet-5-5 (#4082).
        self.assertEqual(self.cfg["fallback_model"]["model"], "claude-sonnet-5")
        self.assertEqual(self.cfg["model"]["default"], "gpt-5.6-sol")
        for key in ("api_key", "base_url"):
            self.assertNotIn(key, self.cfg["model"])
            self.assertNotIn(key, self.cfg["fallback_model"])

    def test_client_values_come_from_variables_and_ports_are_fixed(self):
        ports = set()
        for server in self.cfg["mcp_servers"].values():
            self.assertEqual(server["oauth"]["client_id"], "${GOOGLE_OAUTH_CLIENT_ID}")
            self.assertEqual(server["oauth"]["client_secret"], "${GOOGLE_OAUTH_CLIENT_SECRET}")
            ports.add(server["oauth"]["redirect_port"])
        self.assertEqual(len(ports), 3)


if __name__ == "__main__":
    unittest.main()
