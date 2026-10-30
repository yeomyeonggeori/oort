"""Offline tests for the connector rules of lockgate.py (#3948, ADR-0203 K4).

    python3 -m unittest infra/hermes/test_lockgate_connectors.py -v

Pure Python: `connector_problems` needs no Hermes install, so this runs anywhere. The same rules are exercised
against the real Hermes image by the gate matrix (see the PR for the run); this file is the part a reviewer can
run without Docker. Each rule has its own test that fails when that rule is removed, and a healthy config that
must stay clean so a rule that rejects everything cannot pass.
"""
import copy
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lockgate", os.path.join(HERE, "lockgate.py"))
lockgate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lockgate)

APPS = "com.momo.plugins.gmail,com.momo.plugins.google-calendar"
ENV = {lockgate.APPS_ENV: APPS}


def healthy():
    server = {
        "url": "https://mcp.example.com/mcp",
        "auth": "oauth",
        "trust": "untrusted",
        "sampling": {"enabled": False},
        "tools": {"include": ["search_threads", "get_thread"], "resources": False, "prompts": False},
    }
    return {
        "agent": {"disabled_toolsets": ["terminal", "code_execution", "browser", "cronjob", "delegation", "web"]},
        "mcp_servers": {"gmail": copy.deepcopy(server), "google_calendar": copy.deepcopy(server)},
    }


class ConnectorRules(unittest.TestCase):
    def problems(self, cfg, env=None):
        return lockgate.connector_problems(cfg, ENV if env is None else env)

    def assertOnly(self, problems, fragment):
        self.assertTrue(problems, "a broken config must be refused")
        self.assertTrue(any(fragment in p for p in problems), f"{fragment!r} not in {problems}")

    def test_no_servers_means_nothing_to_judge(self):
        self.assertEqual(self.problems({}, {}), [])
        self.assertEqual(self.problems({"mcp_servers": {}}, {}), [])

    def test_a_healthy_trial_config_is_clean(self):
        self.assertEqual(self.problems(healthy()), [])

    def test_hyphen_and_underscore_are_the_same_server_name(self):
        cfg = healthy()
        cfg["mcp_servers"]["google-calendar"] = cfg["mcp_servers"].pop("google_calendar")
        self.assertEqual(self.problems(cfg), [])

    def test_servers_without_the_attested_list_are_refused(self):
        self.assertOnly(self.problems(healthy(), {}), lockgate.APPS_ENV)
        self.assertOnly(self.problems(healthy(), {lockgate.APPS_ENV: "com.momo.plugins.gmail,BAD ID"}), lockgate.APPS_ENV)

    def test_the_server_set_is_one_to_one_with_the_attested_apps(self):
        extra = healthy()
        extra["mcp_servers"]["github"] = copy.deepcopy(extra["mcp_servers"]["gmail"])
        self.assertOnly(self.problems(extra), "not one of the attested apps")
        short = healthy()
        del short["mcp_servers"]["gmail"]
        self.assertOnly(self.problems(short), "has no mcp_servers entry")

    def test_trust_must_be_exactly_untrusted(self):
        for value in (None, "full", "Untrusted", True):
            cfg = healthy()
            if value is None:
                del cfg["mcp_servers"]["gmail"]["trust"]
            else:
                cfg["mcp_servers"]["gmail"]["trust"] = value
            self.assertOnly(self.problems(cfg), ".trust must be exactly 'untrusted'")

    def test_sampling_must_be_explicitly_off(self):
        for value in (None, {}, {"enabled": True}, {"enabled": None}, False):
            cfg = healthy()
            if value is None:
                del cfg["mcp_servers"]["gmail"]["sampling"]
            else:
                cfg["mcp_servers"]["gmail"]["sampling"] = value
            self.assertOnly(self.problems(cfg), "sampling.enabled must be explicitly false")

    def test_the_resource_and_prompt_doors_must_be_explicitly_closed(self):
        for door in ("resources", "prompts"):
            for value in (None, True, "false", 0):
                cfg = healthy()
                if value is None:
                    del cfg["mcp_servers"]["gmail"]["tools"][door]
                else:
                    cfg["mcp_servers"]["gmail"]["tools"][door] = value
                self.assertOnly(self.problems(cfg), f"tools.{door} must be explicitly false")

    def test_the_url_must_be_one_clean_https_address(self):
        for url in ("https://a.example/x\nhttp://b.example", "https://a.example/ x", "", None, 5, "https://"):
            cfg = healthy()
            if url is None:
                del cfg["mcp_servers"]["gmail"]["url"]
            else:
                cfg["mcp_servers"]["gmail"]["url"] = url
            self.assertOnly(self.problems(cfg), ".url must be a single-line https:// address")

    def test_include_must_be_a_nonempty_exact_list(self):
        for include in (None, [], "get_thread", [""], ["get_*"], ["get_thread", "list?"], ["[ab]"]):
            cfg = healthy()
            if include is None:
                del cfg["mcp_servers"]["gmail"]["tools"]
            else:
                cfg["mcp_servers"]["gmail"]["tools"] = {"include": include, "resources": False, "prompts": False}
            self.assertTrue(self.problems(cfg), f"include={include!r} must be refused")

    def test_a_local_process_or_plain_http_server_is_refused(self):
        cfg = healthy()
        cfg["mcp_servers"]["gmail"]["command"] = "npx"
        self.assertOnly(self.problems(cfg), "command/args")
        cfg = healthy()
        cfg["mcp_servers"]["gmail"]["url"] = "http://mcp.example.com/mcp"
        self.assertOnly(self.problems(cfg), "single-line https:// address")

    def test_cronjob_delegation_and_web_must_stay_disabled(self):
        for toolset in ("cronjob", "delegation", "web"):
            cfg = healthy()
            cfg["agent"]["disabled_toolsets"].remove(toolset)
            self.assertOnly(self.problems(cfg), toolset)

    def test_selected_web_tools_are_refused_even_with_the_connector_deny_list(self):
        cfg = healthy()
        cfg["web"] = {"search_backend": "openai-native", "keyless_fallback": False}
        self.assertEqual(self.problems(cfg), [])
        self.assertEqual(lockgate.tool_problems(cfg, {"memory", "todo_list", "session_search"}), [])
        for tool in ("web_search", "web_extract"):
            with self.subTest(tool=tool):
                self.assertOnly(lockgate.tool_problems(cfg, {"memory", tool}), "connector mode forbids all web")

    def test_the_app_id_to_server_key_rule(self):
        self.assertEqual(lockgate.app_server_key("com.momo.plugins.google-calendar"), "google_calendar")
        self.assertEqual(lockgate.app_server_key("com.momo.plugins.gmail"), "gmail")


if __name__ == "__main__":
    unittest.main()
