"""Tests for infra/hermes/login_relay.py (L-S1, #4078). Run: python3 -m unittest infra/hermes/test_login_relay.py

stdlib only, no Docker, no vendor. A fake `hermes` CLI (generated into a temp dir) prints the real CLI's guidance
lines (measured on v0.22.2, see the spike) and records what it receives on stdin into $HOME/stdin.log, so a test
can prove that NOTHING was written to the child (red proofs 3 and 8) and that the process GROUP is gone (5, 11).

The `rpNN` in a test name is the ADR-0203 증보 2026-10-19 「red proof」 number it covers. uid separation (9, the
file permission half) and the real CLI (1, 10) need the Hermes image: scripts/tests/test_login_relay_docker.sh.
"""
import hashlib
import importlib.util
import io
import json
import os
import secrets
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import warnings
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import login_relay as lr  # noqa: E402

warnings.simplefilter("ignore", ResourceWarning)  # the tests read tiny files inline
KEY = "k" * 40
OP = "owner@example.com"
MARK_CODE = "MARKER-CODE-" + secrets.token_hex(6)
MARK_ACCESS = "MOCK-ACCESS-TOKEN-" + secrets.token_hex(6)
MARK_REFRESH = "MOCK-REFRESH-TOKEN-" + secrets.token_hex(6)
MARKERS = (MARK_CODE, MARK_ACCESS, MARK_REFRESH)

FAKE_HERMES = textwrap.dedent(
    '''\
    #!{py}
    import json, os, subprocess, sys, time
    home = os.environ["HOME"]
    def rd(name, default=None):
        try:
            return json.load(open(os.path.join(home, name)))
        except OSError:
            return default
    sc = rd("scenario.json", {{}})
    argv = sys.argv[1:]
    open(os.path.join(home, "pids"), "a").write("%d\\n" % os.getpid())
    json.dump(dict(os.environ), open(os.path.join(home, "env.json"), "w"))
    json.dump(argv, open(os.path.join(home, "argv.json"), "w"))
    if sc.get("grandchild"):
        gc = subprocess.Popen(["sleep", "300"])
        open(os.path.join(home, "pids"), "a").write("%d\\n" % gc.pid)
    def out(s):
        sys.stdout.write(s + "\\n"); sys.stdout.flush()
    flow = "mcp" if (argv[:1] == ["mcp"] or len(argv) == 1) else ("codex" if "openai-codex" in argv else "anthropic")
    if sc.get("stderr_bait"):
        sys.stderr.write("bait " + sc["stderr_bait"] + "\\n"); sys.stderr.flush()
    state = "STATE" + os.urandom(6).hex()
    json.dump(state, open(os.path.join(home, "state.json"), "w"))
    def finish(line):
        open(os.path.join(home, "stdin.log"), "a").write(line + "\\n")
        out("DEBUG child saw " + line)  # leak bait: a relay that logs or returns child output would show the code
    if flow == "codex":
        out("Signing in to OpenAI Codex...")
        if sc.get("url_before_anchor"):
            out(sc["url_before_anchor"])
        else:
            out("  1. Open this URL in your browser:")
            out("")
            out("     \\x1b[94m" + sc.get("url", "https://auth.openai.com/codex/device") + "\\x1b[0m")
        out("")
        out("  2. Enter this code:")
        out("     \\x1b[94m" + sc.get("device_code", "ABCD-12345") + "\\x1b[0m")
        out("Waiting for sign-in... (press Ctrl+C to cancel)")
        for _ in range(600):
            if os.path.exists(os.path.join(home, "approve")):
                os.makedirs(home, exist_ok=True)
                open(os.path.join(home, "auth.json"), "w").write("%s %s" % (sc["access"], sc["refresh"]))
                out("DEBUG token " + sc["access"])
                sys.exit(0)
            time.sleep(0.05)
        sys.exit(1)
    if flow == "anthropic":
        out("Authorize Hermes with your Claude Pro/Max subscription.")
        out("\\u256d\\u2500 Claude Pro/Max Authorization \\u2500\\u2500\\u2500\\u256e")
        out("\\u2502  Open this link in your browser:  \\u2502")
        out("\\u2570\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u256f")
        out("")
        out("  " + sc.get("url", "https://claude.ai/oauth/authorize?code=true&client_id=c&response_type=code"
            "&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback"
            "&code_challenge=CHAL&code_challenge_method=S256&state=" + state))
        out("")
        out("After authorizing, you'll see a code. Paste it below.")
        sys.stdout.write("Authorization code: "); sys.stdout.flush()
        line = sys.stdin.readline().strip()
        finish(line)
        code, _, st = line.partition("#")
        if st != state:
            sys.exit(1)
        open(os.path.join(home, "auth.json"), "w").write("%s %s %s" % (code, sc["access"], sc["refresh"]))
        sys.exit(0)
    # mcp (hermes mcp login -- NAME) and the probe (python probe.py NAME) share this shape
    host = sc.get("host", "mock.example")
    redirect = sc.get("redirect", "http%3A%2F%2F127.0.0.1%3A27890%2Fcallback")
    out("  MCP OAuth: authorization required.")
    out("  Open this URL in your browser:")
    out("")
    out("    " + sc.get("url", "https://%s/authorize?response_type=code&client_id=c&redirect_uri=%s"
        "&state=%s&code_challenge=CHAL&code_challenge_method=S256" % (host, redirect, state)))
    out("  Or paste the redirect URL here and press Enter. Type skip to continue without this server:")
    line = sys.stdin.readline().strip()
    finish(line)
    from urllib.parse import urlsplit, parse_qs
    q = parse_qs(urlsplit(line).query)
    if q.get("state", [""])[0] != state:
        sys.exit(1)
    os.makedirs(os.path.join(home, "mcp-tokens"), exist_ok=True)
    open(os.path.join(home, "mcp-tokens", argv[-1] + ".json"), "w").write("%s %s %s" % (q["code"][0], sc["access"], sc["refresh"]))
    sys.exit(0)
    '''
)


class Harness:
    def __init__(self, tc, servers=None, **cfg_kw):
        self.tc = tc
        self.tmp = tempfile.TemporaryDirectory()
        tc.addCleanup(self.tmp.cleanup)
        self.data = os.path.join(self.tmp.name, "data")
        os.makedirs(self.data)
        self.fake = os.path.join(self.tmp.name, "fake_hermes.py")
        with open(self.fake, "w") as f:
            f.write(FAKE_HERMES.format(py=sys.executable))
        os.chmod(self.fake, 0o755)
        self.logs = []
        self._orig_log = lr.log
        lr.log = self.logs.append
        tc.addCleanup(setattr, lr, "log", self._orig_log)
        self.stderr = io.StringIO()
        self._orig_err, sys.stderr = sys.stderr, self.stderr
        tc.addCleanup(setattr, sys, "stderr", self._orig_err)
        self.bodies = []
        kw = dict(
            key=KEY, hermes_bin=self.fake, python_bin=sys.executable, probe_path=self.fake, data_dir=self.data,
            servers=servers if servers is not None else {"notes": {"host": "mock.example", "probe": False}},
            start_wait=5, rate_per_min=50,
        )  # fmt: skip
        kw.update(cfg_kw)
        self.cfg = lr.Config(**kw)
        self.srv = lr.build_server(self.cfg)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        tc.addCleanup(self.close)
        self.scenario({})

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.srv.relay.close()
        for pid in self.pids():
            try:
                os.kill(pid, 9)
            except OSError:
                pass

    def scenario(self, sc):
        sc = dict(sc)
        sc.setdefault("access", MARK_ACCESS)
        sc.setdefault("refresh", MARK_REFRESH)
        with open(os.path.join(self.data, "scenario.json"), "w") as f:
            json.dump(sc, f)

    def call(self, method, path, body=None, op=None, key=KEY):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), method=method)
        if key is not None:
            req.add_header("Authorization", "Bearer " + key)
        if op is not None:
            req.add_header("X-Operator", op)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data=data, timeout=15) as r:
                raw, status, hdr = r.read(), r.status, r.headers
        except urllib.error.HTTPError as e:
            raw, status, hdr = e.read(), e.code, e.headers
        self.bodies.append(raw.decode())
        return status, json.loads(raw), hdr

    def start(self, kind, target, op=OP):
        return self.call("POST", "/v1/login", {"kind": kind, "target": target, "operator": op})

    def state(self):
        return json.load(open(os.path.join(self.data, "state.json")))

    def stdin_log(self):
        p = os.path.join(self.data, "stdin.log")
        return open(p).read() if os.path.exists(p) else None

    def pids(self):
        p = os.path.join(self.data, "pids")
        return [int(x) for x in open(p).read().split()] if os.path.exists(p) else []

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        try:  # a zombie is dead for our purpose
            return "Z" not in open("/proc/%d/stat" % pid).read().split(")")[-1][:3]
        except OSError:
            return True

    def wait_until(self, fn, timeout=8.0):
        end = time.time() + timeout
        while time.time() < end:
            if fn():
                return True
            time.sleep(0.05)
        return fn()

    def wait_status(self, lid, want, op=OP):
        got = {}

        def ok():
            got["r"] = self.call("GET", "/v1/login/" + lid, op=op)[1]
            return got["r"].get("status") == want

        self.tc.assertTrue(self.wait_until(ok), "status never became %s: %s" % (want, got.get("r")))
        return got["r"]

    def data_files_text(self):
        out = []
        for root, _, files in os.walk(self.data):
            for n in files:
                if n in ("env.json", "argv.json", "scenario.json", "stdin.log", "state.json"):
                    continue
                out.append(open(os.path.join(root, n)).read())
        return "\n".join(out)

    def everything_relay_said(self):
        return "\n".join(self.logs) + self.stderr.getvalue() + "\n".join(self.bodies)


def paste_claude(h, code):
    return "%s#%s" % (code, h.state())


def paste_mcp(h, code, redirect="http://127.0.0.1:27890/callback", state=None):
    return "%s?code=%s&state=%s" % (redirect, code, state or h.state())


class RedProofs(unittest.TestCase):
    # --- 1: token and code bytes never cross the relay, on all four paths (Codex, Claude, MCP, probe) ---------
    def _assert_clean(self, h, extra_secrets=()):
        said = h.everything_relay_said()
        for m in MARKERS + tuple(extra_secrets):
            self.assertNotIn(m, said)
        self.assertNotIn("DEBUG", said)  # the fake CLI's stdout bait must not be relayed or logged

    def test_rp01_codex_device_flow_tokens_zero_bytes(self):
        h = Harness(self)
        st, r, hdr = h.start("provider", "openai-codex")
        self.assertEqual(st, 200)
        self.assertEqual((r["mode"], r["url"], r["user_code"]), ("device", "https://auth.openai.com/codex/device", "ABCD-12345"))
        self.assertEqual(hdr["Cache-Control"], "no-store")
        lid = r["login_id"]
        self.assertEqual(h.call("GET", "/v1/login/" + lid, op=OP)[1], {"status": "pending"})
        self.assertEqual(h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": "x"}, op=OP)[1], {"error": "not_paste_mode"})
        open(os.path.join(h.data, "approve"), "w").close()
        self.assertEqual(h.wait_status(lid, "done"), {"status": "done"})
        self.assertIn(MARK_ACCESS, h.data_files_text())  # positive control: the flow really ran to the end
        self._assert_clean(h)
        # the device code is returned by the start response ONLY
        self.assertEqual(sum("ABCD-12345" in b for b in h.bodies), 1)
        self.assertNotIn("ABCD-12345", "\n".join(h.logs) + h.stderr.getvalue())

    def test_rp01_claude_paste_flow_tokens_zero_bytes(self):
        h = Harness(self)
        st, r, _ = h.start("provider", "anthropic")
        self.assertEqual((st, r["mode"]), (200, "paste"))
        self.assertTrue(r["url"].startswith("https://claude.ai/oauth/authorize?"))
        self.assertNotIn("user_code", r)
        st, r2, _ = h.call("POST", "/v1/login/%s/complete" % r["login_id"], {"pasted": paste_claude(h, MARK_CODE)}, op=OP)
        self.assertEqual((st, r2), (200, {"status": "submitted"}))
        h.wait_status(r["login_id"], "done")
        self.assertIn(MARK_CODE + "#" + h.state(), h.stdin_log())
        self.assertIn(MARK_ACCESS, h.data_files_text())
        self._assert_clean(h)

    def test_rp01_mcp_paste_flow_tokens_zero_bytes(self):
        h = Harness(self)
        st, r, _ = h.start("mcp", "notes")
        self.assertEqual((st, r["mode"]), (200, "paste"))
        self.assertEqual(json.load(open(os.path.join(h.data, "argv.json"))), ["mcp", "login", "--", "notes"])
        h.call("POST", "/v1/login/%s/complete" % r["login_id"], {"pasted": paste_mcp(h, MARK_CODE)}, op=OP)
        h.wait_status(r["login_id"], "done")
        self.assertIn(MARK_ACCESS, h.data_files_text())
        self._assert_clean(h)

    def test_rp01_probe_path_flow_tokens_zero_bytes(self):
        h = Harness(self, servers={"gmail": {"host": "mock.example", "probe": True}})
        st, r, _ = h.start("mcp", "gmail")
        self.assertEqual(st, 200)
        self.assertEqual(json.load(open(os.path.join(h.data, "argv.json"))), ["gmail"])  # python probe.py gmail
        h.call("POST", "/v1/login/%s/complete" % r["login_id"], {"pasted": paste_mcp(h, MARK_CODE)}, op=OP)
        h.wait_status(r["login_id"], "done")
        self.assertIn(MARK_ACCESS, h.data_files_text())
        self._assert_clean(h)

    def test_rp01_child_stderr_and_failure_output_never_relayed(self):
        h = Harness(self)
        h.scenario({"stderr_bait": MARK_CODE})
        st, r, _ = h.start("provider", "anthropic")
        h.call("DELETE", "/v1/login/" + r["login_id"], op=OP)
        self._assert_clean(h)
        self.assertNotIn("bait", h.everything_relay_said())

    # --- 3: state mismatch writes nothing to stdin; redirect mismatch 400; second complete 409 -------------------
    def test_rp03_state_mismatch_writes_nothing_then_retry_then_once(self):
        h = Harness(self)
        r = h.start("mcp", "notes")[1]
        lid = r["login_id"]
        st, body, _ = h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": paste_mcp(h, MARK_CODE, state="WRONG")}, op=OP)
        self.assertEqual((st, body), (400, {"error": "state_mismatch"}))
        time.sleep(0.3)
        self.assertIsNone(h.stdin_log())  # the child's stdin spy saw NOTHING
        self.assertEqual(h.call("GET", "/v1/login/" + lid, op=OP)[1], {"status": "pending"})
        st, body, _ = h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": paste_mcp(h, MARK_CODE, redirect="http://127.0.0.1:9/callback")}, op=OP)
        self.assertEqual((st, body), (400, {"error": "redirect_mismatch"}))
        self.assertIsNone(h.stdin_log())
        st, _, _ = h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": paste_mcp(h, MARK_CODE)}, op=OP)
        self.assertEqual(st, 200)
        st, body, _ = h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": paste_mcp(h, MARK_CODE)}, op=OP)
        self.assertEqual((st, body), (409, {"error": "already_submitted"}))
        h.wait_status(lid, "done")
        self.assertEqual(h.stdin_log().count("\n"), 1)  # exactly one line ever reached the child

    def test_rp03_three_rejections_cancel_the_login_and_kill_the_child(self):
        h = Harness(self)
        r = h.start("provider", "anthropic")[1]
        lid = r["login_id"]
        for _ in range(3):
            self.assertEqual(h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": "WRONGCODE#WRONGSTATE"}, op=OP)[0], 400)
        self.assertEqual(h.call("GET", "/v1/login/" + lid, op=OP)[1], {"status": "cancelled", "reason": "too_many_attempts"})
        self.assertTrue(h.wait_until(lambda: not any(h.alive(p) for p in h.pids())))
        self.assertIsNone(h.stdin_log())

    # --- 4 (sidecar half): wrong key, wrong operator, other operator's login ---------------------------------------
    def test_rp04_key_and_operator_checks(self):
        h = Harness(self)
        self.assertEqual(h.call("GET", "/v1/status", key=None)[0], 401)
        self.assertEqual(h.call("GET", "/v1/status", key="x" * 40)[0], 401)
        self.assertEqual(h.call("GET", "/healthz", key=None)[1], {"ok": True})  # liveness only: no data
        r = h.start("provider", "anthropic")[1]
        lid = r["login_id"]
        self.assertEqual(h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": paste_claude(h, "c")}, op="other@example.com")[0], 403)
        self.assertEqual(h.call("GET", "/v1/login/" + lid, op="other@example.com")[0], 403)
        self.assertEqual(h.call("DELETE", "/v1/login/" + lid, op="other@example.com")[0], 403)
        self.assertEqual(h.call("GET", "/v1/login/" + lid)[0], 400)  # no X-Operator
        self.assertIsNone(h.stdin_log())
        self.assertEqual(h.call("GET", "/v1/login/" + lid, op=OP)[1], {"status": "pending"})

    # --- 5 + 11: TTL kills the child and its process GROUP ---------------------------------------------------------
    def test_rp05_rp11_ttl_expiry_leaves_no_live_pid_in_the_group(self):
        h = Harness(self, ttl_paste=1)
        h.scenario({"grandchild": True})
        lid = h.start("provider", "anthropic")[1]["login_id"]
        pids = h.pids()
        self.assertEqual(len(pids), 2)  # the CLI and the `sleep 300` it spawned
        self.assertTrue(all(h.alive(p) for p in pids))
        self.assertEqual(h.wait_status(lid, "expired"), {"status": "expired", "reason": "timeout"})
        self.assertTrue(h.wait_until(lambda: not any(h.alive(p) for p in pids)), "a process of the group survived the TTL")

    def test_rp05_rp11_cancel_and_device_ttl_kill_the_group(self):
        h = Harness(self, ttl_device=1)
        h.scenario({"grandchild": True})
        lid = h.start("provider", "openai-codex")[1]["login_id"]
        pids = h.pids()
        self.assertEqual(h.wait_status(lid, "expired")["reason"], "timeout")
        self.assertTrue(h.wait_until(lambda: not any(h.alive(p) for p in pids)))
        h2 = Harness(self)
        h2.scenario({"grandchild": True})
        lid2 = h2.start("mcp", "notes")[1]["login_id"]
        pids2 = h2.pids()
        self.assertEqual(h2.call("DELETE", "/v1/login/" + lid2, op=OP)[1]["status"], "cancelled")
        self.assertTrue(h2.wait_until(lambda: not any(h2.alive(p) for p in pids2)), "cancel left a live PID")

    def test_rp11_group_is_swept_when_the_leader_exits_first(self):
        h = Harness(self)
        h.scenario({"grandchild": True, "access": MARK_ACCESS, "refresh": MARK_REFRESH})
        lid = h.start("provider", "openai-codex")[1]["login_id"]
        pids = h.pids()
        open(os.path.join(h.data, "approve"), "w").close()
        h.wait_status(lid, "done")
        self.assertTrue(h.wait_until(lambda: not any(h.alive(p) for p in pids)), "grandchild outlived a finished login")

    # --- 6: only the fixed target list reaches a process -------------------------------------------------------------
    def test_rp06_targets_outside_the_fixed_list_never_spawn(self):
        h = Harness(self)
        bad = [
            ("mcp", "../etc/passwd"), ("mcp", "-rf"), ("mcp", "--help"), ("mcp", "a;b"), ("mcp", "a b"),
            ("mcp", "$(id)"), ("mcp", "NOTES"), ("mcp", "unknown_server"), ("mcp", ""), ("mcp", "x" * 65),
            ("provider", "evil"), ("provider", "openai-codex --extra"), ("provider", "../anthropic"),
            ("shell", "anthropic"), ("provider", None), (None, "anthropic"), ("mcp", ["notes"]),
        ]  # fmt: skip
        for kind, target in bad:
            st, body, _ = h.call("POST", "/v1/login", {"kind": kind, "target": target, "operator": OP})
            self.assertEqual((st, body), (400, {"error": "invalid_target"}), (kind, target))
        self.assertEqual(h.call("POST", "/v1/login", {"kind": "mcp", "target": "notes", "operator": "bad op"})[1], {"error": "invalid_operator"})
        self.assertEqual(h.pids(), [])  # nothing was ever spawned

    # --- 7: only validated URLs reach the screen (stub-injected output) -------------------------------------------------
    def test_rp07_urls_that_are_not_allowed_are_rejected(self):
        cases = [
            ("provider", "openai-codex", {"url": "http://auth.openai.com/codex/device"}),  # http
            ("provider", "openai-codex", {"url": "javascript:alert(1)"}),  # not even http(s): the line is rejected
            ("provider", "openai-codex", {"url": "https://auth.openai.com@evil.example/codex/device"}),  # userinfo
            ("provider", "openai-codex", {"url": "https://evil.example/codex/device"}),  # host outside the allow-list
            ("provider", "openai-codex", {"url": "https://auth.openai.com.evil.example/x"}),
            ("provider", "openai-codex", {"url": "https://auth.openai.com:8443/codex/device"}),  # non-443 port
            ("provider", "openai-codex", {"url": "https://auth.openai.com/codex/device#frag"}),
            ("provider", "openai-codex", {"url_before_anchor": "https://auth.openai.com/codex/device"}),  # URL not after the guidance line
            ("provider", "anthropic", {"url": "https://claude.ai.evil.example/oauth/authorize?state=S"}),
            ("provider", "anthropic", {"url": "https://claude.ai/oauth/authorize?state=A&state=B"}),  # ambiguous state
            ("provider", "anthropic", {"url": "https://claude.ai/oauth/authorize?code=true"}),  # no state
            ("mcp", "notes", {"host": "evil.example"}),  # not the configured server's host
            ("mcp", "notes", {"redirect": "http%3A%2F%2Fevil.example%3A27890%2Fcallback"}),  # redirect not loopback
            ("mcp", "notes", {"redirect": "https%3A%2F%2F127.0.0.1%3A27890%2Fcallback"}),  # not http
            ("mcp", "notes", {"redirect": "http%3A%2F%2F127.0.0.1%2Fcallback"}),  # no port
        ]  # fmt: skip
        for kind, target, sc in cases:
            h = Harness(self, start_wait=2)
            h.scenario(sc)
            st, body, _ = h.start(kind, target)
            self.assertIn(st, (502, 504), (target, sc, body))
            self.assertIn(body["error"], ("url_rejected", "parse_failed", "start_timeout"), (target, sc))
            self.assertNotIn("url", body)
            self.assertTrue(h.wait_until(lambda: not any(h.alive(p) for p in h.pids())), "rejected login left a process")
        # a child that prints no URL line at all
        h = Harness(self, start_wait=1)
        h.scenario({"url_before_anchor": "nothing useful"})
        self.assertIn(h.start("provider", "openai-codex")[0], (502, 504))

    def test_rp07_http_loopback_needs_the_test_flag(self):
        url = "http://127.0.0.1:9300/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A27890%2Fcallback&state=S1"
        h = Harness(self, servers={"notes": {"host": "127.0.0.1", "probe": False}})
        h.scenario({"url": url})
        self.assertEqual(h.start("mcp", "notes")[1], {"error": "url_rejected"})  # same URL, no flag
        h2 = Harness(self, servers={"notes": {"host": "127.0.0.1", "probe": False}}, allow_http_loopback=True)
        h2.scenario({"url": url})
        self.assertEqual(h2.start("mcp", "notes")[0], 200)  # with the flag
        # the flag still does not let a non-loopback http host through
        h3 = Harness(self, allow_http_loopback=True)
        h3.scenario({"host": "mock.example", "url": url.replace("127.0.0.1:9300", "mock.example")})
        self.assertEqual(h3.start("mcp", "notes")[1], {"error": "url_rejected"})

    def test_rp07_google_probe_servers_accept_the_google_authorization_host(self):
        h = Harness(self, servers={"gmail": {"host": "gmailmcp.googleapis.com", "probe": True}})
        h.scenario({"url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A27890%2Fcallback&state=GS1"})
        self.assertEqual(h.start("mcp", "gmail")[0], 200)

    # --- 8: pasted values are rebuilt, never forwarded ---------------------------------------------------------------------
    def test_rp08_unsafe_pastes_are_refused_and_nothing_reaches_stdin(self):
        h = Harness(self)
        lid = h.start("mcp", "notes")[1]["login_id"]
        st_ = h.state()
        base = "http://127.0.0.1:27890/callback"
        pastes = [
            base + "?code=c&state=%s&error=access_denied" % st_,  # extra parameter
            base + "?code=c&state=%s&iss=https://evil" % st_,
            base + "?error=access_denied&state=%s" % st_,
            "skip", "SKIP", "http://127.0.0.1@evil.example/callback?code=c&state=%s" % st_,
            "http://127.0.0.1:27890@evil.example/callback?code=c&state=%s" % st_,
            base + "?code=c&code=d&state=%s" % st_,  # repeated key
            base + "?code=c%0Aevil&state=" + st_,  # decoded newline
            base + "?code=c&state=%s#frag" % st_,
            base + "?code=" + "a" * 3000 + "&state=" + st_,
            "code=c\nstate=" + st_, "http://127.0.0.1:27890/callback?code=c&state=" + st_ + "\nskip",
            "", " ", "\x00", "ünïcode", "javascript:alert(1)", "ftp://127.0.0.1:27890/callback?code=c&state=" + st_,
        ]  # fmt: skip
        alive_before = h.pids()
        for p in pastes:
            st, body, _ = h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": p}, op=OP)
            self.assertEqual(st, 400, p[:60])
            if h.call("GET", "/v1/login/" + lid, op=OP)[1]["status"] != "pending":
                break  # three rejections cancel the login: stop here, the next login continues the list
        self.assertIsNone(h.stdin_log())
        self.assertEqual(alive_before, h.pids())

    def test_rp08_each_unsafe_paste_is_refused_on_a_fresh_login(self):
        pastes = [
            "?code=c&state={s}&error=access_denied", "http://127.0.0.1:27890/callback?code=c&state={s}&iss=x",
            "skip", "http://127.0.0.1@evil.example/callback?code=c&state={s}", "?code=c&code=d&state={s}",
            "http://127.0.0.1:27890/callback?code=c%0Aevil&state={s}", "http://127.0.0.1:27890/other?code=c&state={s}",
            "http://localhost:27890/callback?code=c&state={s}", "https://127.0.0.1:27890/callback?code=c&state={s}",
        ]  # fmt: skip
        for p in pastes:
            h = Harness(self)
            lid = h.start("mcp", "notes")[1]["login_id"]
            st, body, _ = h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": p.format(s=h.state())}, op=OP)
            self.assertEqual(st, 400, p)
            self.assertIn(body["error"], ("extra_params", "bad_paste", "redirect_mismatch"), p)
            if "error=" in p or "iss=" in p:
                self.assertEqual(body["error"], "extra_params", p)
            time.sleep(0.05)
            self.assertIsNone(h.stdin_log(), p)

    def test_rp08_accepted_pastes_are_rebuilt_not_forwarded(self):
        h = Harness(self)
        lid = h.start("mcp", "notes")[1]["login_id"]
        # extra whitespace, a bare query portion, and a percent-encoded Google-style code with a slash
        pasted = "  ?code=4%2F0AbC-d_e.f~g&state=" + h.state() + "  "
        self.assertEqual(h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": pasted}, op=OP)[0], 200)
        h.wait_status(lid, "done")
        self.assertEqual(h.stdin_log(), "http://127.0.0.1:27890/callback?code=4%2F0AbC-d_e.f~g&state=" + h.state() + "\n")
        h2 = Harness(self)
        lid2 = h2.start("provider", "anthropic")[1]["login_id"]
        self.assertEqual(h2.call("POST", "/v1/login/%s/complete" % lid2, {"pasted": "  abc.DEF-123#" + h2.state() + " "}, op=OP)[0], 200)
        h2.wait_status(lid2, "done")
        self.assertEqual(h2.stdin_log(), "abc.DEF-123#" + h2.state() + "\n")
        h3 = Harness(self)  # Claude takes only `code#state`: a URL is not accepted there
        lid3 = h3.start("provider", "anthropic")[1]["login_id"]
        self.assertEqual(h3.call("POST", "/v1/login/%s/complete" % lid3, {"pasted": paste_mcp(h3, "c")}, op=OP)[0], 400)
        self.assertIsNone(h3.stdin_log())

    # --- 9 (process half): the key is not in any child env; the child env is exactly the rebuilt one ------------------------
    def test_rp09_child_env_has_no_key_and_is_rebuilt(self):
        os.environ[lr.KEY_ENV] = KEY  # even if this process had the key in its env, no child may get it
        self.addCleanup(os.environ.pop, lr.KEY_ENV, None)
        os.environ["SOME_SECRET"] = "leak-me"
        self.addCleanup(os.environ.pop, "SOME_SECRET", None)
        h = Harness(self)
        h.start("provider", "anthropic")
        env = json.load(open(os.path.join(h.data, "env.json")))
        self.assertNotIn(lr.KEY_ENV, env)
        self.assertNotIn("SOME_SECRET", env)
        self.assertNotIn(KEY, json.dumps(env))
        self.assertEqual(set(env) - {"__CF_USER_TEXT_ENCODING"}, {"HOME", "HERMES_HOME", "PATH", "LANG", "PYTHONUNBUFFERED", "NO_COLOR"})  # macOS adds one key itself
        self.assertEqual(env["HOME"], h.data)
        pid = h.pids()[0]
        if os.path.exists("/proc/%d/environ" % pid):
            self.assertNotIn(KEY.encode(), open("/proc/%d/environ" % pid, "rb").read())

    def test_rp09_launch_without_root_or_key_is_relay_off(self):
        self.assertEqual(lr.main(["launch"]), 0)  # not root here / no key: exits 0 and starts nothing

    def test_rp09_argv_is_the_fixed_list_and_never_carries_request_data(self):
        h = Harness(self, servers={"notes": {"host": "mock.example", "probe": False}, "gmail": {"host": "g", "probe": True}})
        r = h.cfg
        rel = h.srv.relay
        self.assertEqual(rel._argv("provider", "openai-codex"), [h.fake, "auth", "add", "openai-codex", "--type", "oauth", "--no-browser"])
        self.assertEqual(rel._argv("provider", "anthropic"), [h.fake, "auth", "add", "anthropic", "--type", "oauth", "--no-browser"])
        self.assertEqual(rel._argv("mcp", "notes"), [h.fake, "mcp", "login", "--", "notes"])
        self.assertEqual(rel._argv("mcp", "gmail"), [sys.executable, h.fake, "gmail"])
        r.drop = (10000, 10000)
        self.assertEqual(
            rel._argv("mcp", "notes"),
            [r.setpriv_bin, "--reuid=10000", "--regid=10000", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", h.fake, "mcp", "login", "--", "notes"],
        )

    # --- 10: the relay never writes config.yaml ---------------------------------------------------------------------------------
    def test_rp10_config_yaml_hash_unchanged_across_a_login(self):
        h = Harness(self)
        cfgp = os.path.join(h.data, "config.yaml")
        open(cfgp, "w").write("agent:\n  max_turns: 12\n")
        before = hashlib.sha256(open(cfgp, "rb").read()).hexdigest()
        lid = h.start("provider", "anthropic")[1]["login_id"]
        h.call("POST", "/v1/login/%s/complete" % lid, {"pasted": paste_claude(h, "c")}, op=OP)
        h.wait_status(lid, "done")
        self.assertEqual(before, hashlib.sha256(open(cfgp, "rb").read()).hexdigest())


class Behaviour(unittest.TestCase):
    def test_one_login_per_target_and_start_rate_limit(self):
        h = Harness(self)
        self.assertEqual(h.start("provider", "anthropic")[0], 200)
        st, body, _ = h.start("provider", "anthropic")
        self.assertEqual((st, body), (409, {"error": "login_in_progress"}))
        self.assertEqual(h.start("mcp", "notes")[0], 200)  # a different target is independent
        h2 = Harness(self, rate_per_min=2)
        for t in ("anthropic",):
            lid = h2.start("provider", t)[1]["login_id"]
            h2.call("DELETE", "/v1/login/" + lid, op=OP)
        lid = h2.start("provider", "anthropic")[1]["login_id"]
        h2.call("DELETE", "/v1/login/" + lid, op=OP)
        self.assertEqual(h2.start("provider", "anthropic")[1], {"error": "rate_limited"})
        self.assertEqual(h2.start("provider", "anthropic", op="second@example.com")[0], 200)  # per operator

    def test_finished_sessions_disappear_and_child_output_is_never_stored(self):
        h = Harness(self, keep_after_finish=1)
        lid = h.start("provider", "anthropic")[1]["login_id"]
        h.call("DELETE", "/v1/login/" + lid, op=OP)
        self.assertTrue(h.wait_until(lambda: h.call("GET", "/v1/login/" + lid, op=OP)[0] == 404, 6))
        for s in h.srv.relay.sessions.values():
            self.assertIsNone(s.parser.url)

    def test_body_limits_and_unknown_routes(self):
        h = Harness(self)
        self.assertEqual(h.call("POST", "/v1/login", {"kind": "mcp", "target": "notes", "operator": OP, "junk": "x" * 5000})[0], 413)
        self.assertEqual(h.call("GET", "/v1/nothing")[0], 404)
        self.assertEqual(h.call("GET", "/v1/login/short", op=OP)[0], 404)
        self.assertEqual(h.call("PUT", "/v1/login")[0], 404)

    def test_status_reports_connected_without_reading_secrets(self):
        h = Harness(self)
        stub = os.path.join(h.tmp.name, "py_stub.sh")
        open(stub, "w").write('#!/bin/sh\n[ "$3" = anthropic ] && echo "noise" && echo LOGGED_IN=1 || echo LOGGED_IN=0\n')
        os.chmod(stub, 0o755)
        h.cfg.python_bin = stub
        os.makedirs(os.path.join(h.data, "mcp-tokens"))
        open(os.path.join(h.data, "mcp-tokens", "notes.json"), "w").write(MARK_ACCESS)
        h.cfg.test_bin = "/usr/bin/test" if os.path.exists("/usr/bin/test") else "/bin/test"
        st, body, _ = h.call("GET", "/v1/status")
        self.assertEqual(st, 200)
        got = {(t["kind"], t["target"]): t["connected"] for t in body["targets"]}
        self.assertEqual(got, {("provider", "openai-codex"): False, ("provider", "anthropic"): True, ("mcp", "notes"): True})
        self.assertNotIn(MARK_ACCESS, json.dumps(body))

    def test_status_failure_means_not_connected(self):
        h = Harness(self)
        h.cfg.python_bin = "/nonexistent/python"
        got = [t["connected"] for t in h.call("GET", "/v1/status")[1]["targets"] if t["kind"] == "provider"]
        self.assertEqual(got, [False, False])

    def test_config_rejects_a_short_or_unresolved_reference_key(self):
        for bad in ("short", "${{shared.HERMES_LOGIN_RELAY_KEY}}" + "x" * 3, "has space " * 5, "k" * 31):
            with self.assertRaises(ValueError, msg=bad):
                lr.Config(key=bad)
        lr.Config(key="ab" * 24)

    @unittest.skipUnless(
        any(importlib.util.find_spec(m) for m in ("yaml", "ruamel")), "needs PyYAML or ruamel.yaml (the Hermes venv has ruamel)"
    )
    def test_oauth_servers_are_read_from_config_yaml(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "config.yaml")
        with open(p, "w") as f:
            f.write(
            "mcp_servers:\n  gmail:\n    url: https://gmailmcp.googleapis.com/mcp/v1\n    auth: oauth\n"
            "  notes:\n    url: https://mock.example/mcp\n    auth: oauth\n  plain:\n    url: https://x.example/mcp\n"
            "  -bad:\n    url: https://x.example/mcp\n    auth: oauth\n"
        )
        got = lr._load_oauth_servers(p)
        self.assertEqual(got, {"gmail": {"host": "gmailmcp.googleapis.com", "probe": True}, "notes": {"host": "mock.example", "probe": False}})
        self.assertEqual(lr._load_oauth_servers(os.path.join(d, "missing.yaml")), {})

    def test_key_file_is_the_only_key_input_of_serve(self):
        d = tempfile.mkdtemp()
        kf = os.path.join(d, "key")
        fd = os.open(kf, os.O_WRONLY | os.O_CREAT, 0o400)
        os.write(fd, KEY.encode())
        os.close(fd)
        self.assertEqual(stat.S_IMODE(os.stat(kf).st_mode), 0o400)
        self.assertEqual(open(kf).read(), KEY)


class Parser(unittest.TestCase):
    def feed(self, lines, need_code=False):
        p = lr.OutputParser(need_code)
        for ln in lines:
            p.feed(ln)
        return p

    def test_claude_banner_then_url(self):
        p = self.feed(["Authorize Hermes", "╭──╮", "│  Open this link in your browser:  │", "╰──╯", "", "  https://claude.ai/oauth/authorize?a=1&state=S"])
        self.assertEqual(p.url, "https://claude.ai/oauth/authorize?a=1&state=S")

    def test_codex_ansi_and_code(self):
        p = self.feed(["  1. Open this URL in your browser:", "     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m", "  2. Enter this code:", "     \x1b[94m55H7-X0AWD\x1b[0m"], need_code=True)
        self.assertEqual((p.url, p.code), ("https://auth.openai.com/codex/device", "55H7-X0AWD"))
        self.assertTrue(p.done)

    def test_urls_outside_the_guidance_are_ignored_and_a_non_url_line_is_an_error(self):
        self.assertIsNone(self.feed(["see https://evil.example", "https://evil.example/x"]).url)
        self.assertEqual(self.feed(["Open this URL in your browser:", "not a url"]).error, "url_line")
        self.assertEqual(self.feed(["Open this URL in your browser:", "https://a.example/x extra"]).error, "url_line")
        self.assertEqual(self.feed(["Open this URL in your browser:", "https://a.example/x", "Open this URL in your browser:", "https://evil.example/y"]).url, "https://a.example/x")

    def test_query_parameter_prefixes_are_not_merged(self):
        url = "https://claude.ai/oauth/authorize?code_challenge=C1&code_challenge_method=S256&state=S9"
        sp = lr.validate_auth_url(url, ("claude.ai",), False)
        from urllib.parse import parse_qsl

        self.assertEqual(dict(parse_qsl(sp.query))["state"], "S9")


if __name__ == "__main__":
    unittest.main()
