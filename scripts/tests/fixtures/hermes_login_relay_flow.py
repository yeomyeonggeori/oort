#!/opt/hermes/.venv/bin/python
"""Measurements run INSIDE the Hermes container as root by scripts/tests/test_login_relay_docker.sh (#4078).

  hermes_login_relay_flow.py A   compose `hermes` service (the real start command, lockgate on the default config):
                                  uid/cap/env separation of the relay and its children, real Codex device code and
                                  real Claude URL (NO vendor approval), cancel = process group gone.
  hermes_login_relay_flow.py B   second container with a mock OAuth MCP: the real `hermes mcp login` and the real
                                  mcp_login_probe.py run to the end (state mismatch refused, code relayed once,
                                  tokens land in /opt/data and nowhere else).

Reads RELAY_KEY and RELAY_URL from the env. Prints `ok:` / `FAIL:` lines, exits 1 on any FAIL. Never prints the key,
a code or a token. Every HTTP body goes to /tmp/relay-bodies.log so the bash side can scan it for the markers.
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit

KEY = os.environ["RELAY_KEY"]
URL = os.environ.get("RELAY_URL", "http://127.0.0.1:8643")
OPERATOR = "owner@example.com"
FAILS = []
CONFIG = "/opt/data/config.yaml"


def check(cond, what):
    print(("ok: " if cond else "FAIL: ") + what, flush=True)
    if not cond:
        FAILS.append(what)


def call(method, path, body=None, op=None, key=KEY):
    req = urllib.request.Request(URL + path, method=method)
    if key is not None:
        req.add_header("Authorization", "Bearer " + key)
    if op:
        req.add_header("X-Operator", op)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=60) as r:
            raw, status = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    with open("/tmp/relay-bodies.log", "ab") as f:
        f.write(raw + b"\n")
    return status, json.loads(raw)


def procs():
    out = []
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            cmd = open("/proc/%s/cmdline" % d, "rb").read().split(b"\0")
            st = dict(l.split(":\t", 1) for l in open("/proc/%s/status" % d).read().splitlines() if ":\t" in l)
            env = open("/proc/%s/environ" % d, "rb").read()
            stat = open("/proc/%s/stat" % d).read().rsplit(")", 1)[1].split()
        except OSError:
            continue
        out.append({
            "pid": int(d), "cmd": " ".join(c.decode("utf-8", "replace") for c in cmd if c), "uid": int(st["Uid"].split()[0]),
            "capeff": int(st["CapEff"], 16), "capprm": int(st["CapPrm"], 16), "nnp": st.get("NoNewPrivs", "?").strip(),
            "env": env, "state": stat[0], "pgrp": int(stat[2]), "sid": int(stat[3]),
        })  # fmt: skip
    return out


def find(substr):
    return [p for p in procs() if substr in p["cmd"] and p["state"] != "Z"]


def env_names(p):
    return {e.split(b"=", 1)[0].decode() for e in p["env"].split(b"\0") if e}


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def find_children(substr):
    """CLI children only: the relay's own argv (`--probe /oort/mcp_login_probe.py`) names the probe too."""
    return [p for p in find(substr) if p["uid"] == 10000]


def wait_gone(substr, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if not find_children(substr):
            return True
        time.sleep(0.2)
    return not find_children(substr)


def wait_status(lid, want, timeout=90):
    end = time.time() + timeout
    got = None
    while time.time() < end:
        st, got = call("GET", "/v1/login/" + lid, op=OPERATOR)
        if got.get("status") == want:
            return got
        if got.get("status") not in ("pending",):
            break
        time.sleep(0.5)
    return got


def phase_a():
    cfg_before = sha(CONFIG)
    relay = find("login_relay.py serve")
    check(len(relay) == 1, "exactly one relay process (serve) is running")
    r = relay[0]
    check(r["uid"] == 10001, "relay runs as uid 10001, not root and not hermes (uid=%d)" % r["uid"])
    check(r["capeff"] == 0xE0, "relay holds only CAP_KILL|SETGID|SETUID (CapEff=%x)" % r["capeff"])
    check(r["nnp"] == "1", "relay has no_new_privs")
    check(b"HERMES_LOGIN_RELAY_KEY" not in r["env"] and KEY.encode() not in r["env"], "relay /proc/<pid>/environ has no key")
    check(env_names(r) <= {"PATH", "LANG", "PYTHONUNBUFFERED"}, "relay env is the rebuilt one: %s" % sorted(env_names(r)))
    st = os.stat("/run/oort-login-relay/key")
    check(oct(st.st_mode & 0o777) == "0o400" and st.st_uid == 10001, "key file is 0400 owned by uid 10001")
    gateway = [p for p in procs() if p["uid"] == 10000 and "gateway" in p["cmd"]]
    check(len(gateway) >= 1, "the Hermes gateway runs as hermes (uid 10000)")
    leaks = [p["pid"] for p in procs() if KEY.encode() in p["env"] and p["pid"] != os.getpid()]  # this process got the key from `docker exec -e`
    check(not leaks, "the relay key is in NO process environment (%d found)" % len(leaks))
    argv_leaks = [p["pid"] for p in procs() if KEY in p["cmd"]]
    check(not argv_leaks, "the relay key is in NO command line (%d found)" % len(argv_leaks))

    check(call("GET", "/healthz", key=None) == (200, {"ok": True}), "GET /healthz needs no key and returns no data")
    check(call("GET", "/v1/status", key=None)[0] == 401, "GET /v1/status without the key is 401")
    check(call("GET", "/v1/status", key="x" * 48)[0] == 401, "GET /v1/status with a wrong key is 401")
    st, body = call("GET", "/v1/status")
    got = {(t["kind"], t["target"]): t["connected"] for t in body.get("targets", [])}
    check(st == 200 and got == {("provider", "openai-codex"): False, ("provider", "anthropic"): False}, "status: both providers logged out, no mcp target (default config): %s" % got)
    for kind, target in (("mcp", "mock"), ("mcp", "../x"), ("provider", "evil"), ("mcp", "-h")):
        st, _ = call("POST", "/v1/login", {"kind": kind, "target": target, "operator": OPERATOR})
        check(st == 400, "target %s/%s is refused before any process" % (kind, target))
    check(not find_children("hermes auth add") and not find_children("hermes mcp login"), "no CLI child exists after the refusals")

    # --- Codex: a REAL device code (vendor call, nothing approved) ---
    st, c = call("POST", "/v1/login", {"kind": "provider", "target": "openai-codex", "operator": OPERATOR})
    check(st == 200 and c.get("mode") == "device", "codex start: device mode (%s)" % st)
    check(urlsplit(c.get("url", "")).hostname == "auth.openai.com" and c["url"].startswith("https://"), "codex url host is auth.openai.com over https")
    check(bool(re.match(r"^[A-Z0-9]{4}-[A-Z0-9]{4,8}$", c.get("user_code", ""))), "codex returns a device code")
    child = find("auth add openai-codex")
    check(len(child) >= 1, "the codex CLI child exists")
    if child:
        ch = [p for p in child if "python" in p["cmd"] or "hermes" in p["cmd"]][0]
        check(ch["uid"] == 10000, "codex child runs as hermes uid 10000 (uid=%d)" % ch["uid"])
        check(ch["capeff"] == 0 and ch["capprm"] == 0 and ch["nnp"] == "1", "codex child: no capabilities, no_new_privs")
        check(b"HERMES_LOGIN_RELAY_KEY" not in ch["env"] and KEY.encode() not in ch["env"], "codex child environ has no key")
        rebuilt = {"HOME", "HERMES_HOME", "PATH", "LANG", "PYTHONUNBUFFERED", "NO_COLOR"}
        wrapper_added = {"HERMES_SITE", "PWD", "PYTHONPATH", "PYTHONPYCACHEPREFIX", "SHLVL", "_"}  # set by the `hermes` launcher script itself
        check(env_names(ch) >= rebuilt and not (env_names(ch) - rebuilt - wrapper_added), "codex child env is the rebuilt one plus the launcher's own: %s" % sorted(env_names(ch)))
        check(ch["pgrp"] == ch["pid"] == ch["sid"], "codex child leads its own session/process group")
        check(c["user_code"] not in ch["cmd"], "device code is not in the child argv")
    st, g = call("GET", "/v1/login/" + c["login_id"], op=OPERATOR)
    check((st, g) == (200, {"status": "pending"}), "codex poll: pending, no code in the poll body")
    check(c["user_code"] not in json.dumps(g), "poll body has no device code")
    check(call("GET", "/v1/login/" + c["login_id"], op="other@example.com")[0] == 403, "another operator is refused (403)")
    st, g = call("DELETE", "/v1/login/" + c["login_id"], op=OPERATOR)
    check((st, g["status"]) == (200, "cancelled"), "codex cancel")
    check(wait_gone("auth add openai-codex"), "after cancel no codex process of the group survives")

    # --- Claude: the real authorization URL, no approval ---
    st, a = call("POST", "/v1/login", {"kind": "provider", "target": "anthropic", "operator": OPERATOR})
    check(st == 200 and a.get("mode") == "paste", "claude start: paste mode (%s)" % st)
    q = parse_qs(urlsplit(a.get("url", "")).query)
    check(urlsplit(a["url"]).hostname == "claude.ai" and len(q.get("state", [])) == 1, "claude url host is claude.ai with exactly one state")
    check("user_code" not in a, "claude start has no device code")
    for pasted, want in (("CODE#WRONGSTATE", "state_mismatch"), ("skip", "bad_paste"), ("a#b#c", "bad_paste")):
        st, e = call("POST", "/v1/login/%s/complete" % a["login_id"], {"pasted": pasted}, op=OPERATOR)
        check((st, e.get("error")) == (400, want) or e.get("error") == "too_many_attempts", "claude paste %r refused with %s" % (pasted[:12], want))
    st, g = call("GET", "/v1/login/" + a["login_id"], op=OPERATOR)
    check(g.get("status") in ("pending", "cancelled"), "claude login survives refused pastes (until the 3rd): %s" % g)
    call("DELETE", "/v1/login/" + a["login_id"], op=OPERATOR)
    check(wait_gone("auth add anthropic"), "after cancel no claude process of the group survives")

    check(sha(CONFIG) == cfg_before, "config.yaml sha256 is unchanged by the relay and the CLI (red proof 10)")
    gateway_again = [p for p in procs() if p["uid"] == 10000 and "gateway" in p["cmd"]]
    check(len(gateway_again) >= 1, "the gateway is still running")
    return 0


def phase_b():
    cfg_before = sha(CONFIG)
    marker_code = "MARKER-CODE-" + os.urandom(6).hex()
    for target, port, redirect_check in (("mock", 9300, True), ("gmail", 9301, True)):
        label = "%s (%s)" % (target, "hermes mcp login" if target == "mock" else "mcp_login_probe.py")
        st, r = call("POST", "/v1/login", {"kind": "mcp", "target": target, "operator": OPERATOR})
        check(st == 200 and r.get("mode") == "paste", "%s: start (%s %s)" % (label, st, r.get("error", "")))
        if st != 200:
            continue
        u = urlsplit(r["url"])
        q = parse_qs(u.query)
        check(u.hostname == "127.0.0.1" and u.port == port, "%s: authorization URL is the mock AS" % label)
        state = q["state"][0]
        redirect = q["redirect_uri"][0]
        argv = [p for p in find(" mcp login") + find("mcp_login_probe.py") if p["uid"] == 10000]
        check(len(argv) >= 1, "%s: the CLI child runs as hermes (uid 10000)" % label)
        st, e = call("POST", "/v1/login/%s/complete" % r["login_id"], {"pasted": "%s?code=%s&state=WRONG" % (redirect, marker_code)}, op=OPERATOR)
        check((st, e.get("error")) == (400, "state_mismatch"), "%s: wrong state refused" % label)
        check(not os.path.exists("/opt/data/mcp-tokens/%s.json" % target), "%s: no token file after a refused paste" % label)
        st, e = call("POST", "/v1/login/%s/complete" % r["login_id"], {"pasted": "%s?code=%s&state=%s&error=x" % (redirect, marker_code, state)}, op=OPERATOR)
        check((st, e.get("error")) == (400, "extra_params"), "%s: extra parameter refused" % label)
        st, e = call("POST", "/v1/login/%s/complete" % r["login_id"], {"pasted": "%s?code=%s&state=%s" % (redirect, marker_code, state)}, op=OPERATOR)
        check((st, e) == (200, {"status": "submitted"}), "%s: the right paste is accepted" % label)
        st, e = call("POST", "/v1/login/%s/complete" % r["login_id"], {"pasted": "%s?code=%s&state=%s" % (redirect, marker_code, state)}, op=OPERATOR)
        check(st == 409, "%s: a second paste is refused (%s)" % (label, e.get("error")))
        g = wait_status(r["login_id"], "done")
        check(g.get("status") == "done", "%s: the login finished (%s)" % (label, g))
        tok = "/opt/data/mcp-tokens/%s.json" % target
        check(os.path.exists(tok), "%s: the token file exists under /opt/data (positive control)" % label)
        if os.path.exists(tok):
            check("MOCK-ACCESS-TOKEN-4078" in open(tok).read(), "%s: it holds the mock's access token" % label)
        check(wait_gone("mcp login --") and wait_gone("mcp_login_probe.py"), "%s: no CLI process remains" % label)
    st, body = call("GET", "/v1/status")
    got = {(t["kind"], t["target"]): t["connected"] for t in body.get("targets", [])}
    check(got.get(("mcp", "mock")) is True and got.get(("mcp", "gmail")) is True, "status: both mcp targets connected (token files seen by hermes uid): %s" % got)
    check("MOCK-ACCESS-TOKEN" not in json.dumps(body), "status body carries no token")
    check(sha(CONFIG) == cfg_before, "config.yaml sha256 unchanged across both MCP logins (red proof 10)")
    print("MARKER_CODE=%s" % marker_code)  # the bash side scans logs for it and the tokens
    return 0


if __name__ == "__main__":
    phase = sys.argv[1]
    (phase_a if phase == "A" else phase_b)()
    sys.exit(1 if FAILS else 0)
