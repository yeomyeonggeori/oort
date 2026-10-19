#!/opt/hermes/.venv/bin/python
"""oort Hermes login relay sidecar (L-S1, #4078; ADR-0203 증보 2026-10-19 「Hermes 로그인 중계」 L2·L3).

A process INSIDE the Hermes container. oort's api calls it to run one login from the oort screen:

  provider/openai-codex   `hermes auth add openai-codex --type oauth --no-browser`   mode=device (URL + device code)
  provider/anthropic      `hermes auth add anthropic  --type oauth --no-browser`   mode=paste  (`code#state`)
  mcp/<server>            `hermes mcp login -- <server>`  (Google servers: `mcp_login_probe.py <server>`)  mode=paste

Only those argv lists exist. A request never chooses a command, an argument or an environment variable.
Tokens (access/refresh) never pass through here: the child exchanges the code with the vendor and writes
/opt/data itself. What this process does see and must not keep: the authorization URL, the device code and the
pasted one-time code (Q1, ADR-0004 증보 7: relayed once, never stored/logged/echoed).

API (JSON; every response `Cache-Control: no-store`; every route but /healthz needs `Authorization: Bearer <key>`):
  POST   /v1/login               {kind, target, operator}        -> {login_id, mode, url, user_code?, expires_at}
  POST   /v1/login/{id}/complete {pasted}      X-Operator        -> {status}            (paste mode, once)
  GET    /v1/login/{id}                        X-Operator        -> {status, reason?}
  DELETE /v1/login/{id}                        X-Operator        -> {status}            (kills the process GROUP)
  GET    /v1/status                                              -> {targets:[{kind,target,connected}]}
  GET    /healthz                                                -> {ok:true}           (no data, no key)

Run:
  login_relay.py launch   as root, from the container start command, AFTER lockgate passed. Reads the key from
                          $HERMES_LOGIN_RELAY_KEY (no key / short key = relay off, exit 0), writes it to a 0400 file owned
                          by a dedicated uid, snapshots the oauth `mcp_servers` of config.yaml (root can read it,
                          the relay uid cannot enter /opt/data), then execs `serve` as that uid with an empty env and
                          only CAP_SETUID/SETGID/KILL so it can lower the CHILD to the hermes uid (and kill its group).
  login_relay.py serve    the HTTP server (tests call it with --no-drop).

Key separation (L2, 보안 검수 H1): the `hermes` uid cannot read the key file, the relay's /proc/<pid>/environ has no
key, and every child gets a rebuilt env (HOME, HERMES_HOME, PATH, ...) in a new process group with no
capabilities, so the agent's `file` tool cannot reach the key. stdlib only; Python 3.11 syntax.
"""
import argparse
import collections
import hmac
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, quote, urlsplit

KEY_ENV = "HERMES_LOGIN_RELAY_KEY"
KEY_DIR = "/run/oort-login-relay"
DEFAULT_RELAY_UID = 10001
DEFAULT_PORT = 8643
DATA_DIR = "/opt/data"
HERMES_BIN = "/opt/hermes/.venv/bin/hermes"
PYTHON_BIN = "/opt/hermes/.venv/bin/python"
SETPRIV_BIN = "/usr/bin/setpriv"
TEST_BIN = "/usr/bin/test"
PROBE_DEFAULT = "/oort/mcp_login_probe.py"
# A key is 32+ characters of this set. `$`, `{`, spaces are out on purpose: a Railway reference that did not
# resolve stays the literal text `${{shared.X}}` (34 characters) and must never become the bearer secret.
KEY_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{32,256}$")

PROVIDERS = ("openai-codex", "anthropic")
PROVIDER_MODE = {"openai-codex": "device", "anthropic": "paste"}
PROVIDER_HOSTS = {"openai-codex": ("auth.openai.com",), "anthropic": ("claude.ai",)}
GOOGLE_PROBE_SERVERS = ("gmail", "google_calendar", "google_drive")  # keep equal to mcp_login_probe.PROBE
GOOGLE_AS_HOSTS = ("accounts.google.com",)
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
TARGET_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
OPERATOR_RE = re.compile(r"^[A-Za-z0-9._@+-]{1,128}$")
LOGIN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

TTL_DEVICE = 900  # Codex: the vendor's expires_in
TTL_PASTE = 300  # same as Hermes' MCP callback wait
START_WAIT = 30  # seconds to find the URL (and device code) in the child's output
KEEP_AFTER_FINISH = 60
MAX_BODY = 4096
MAX_PASTE = 2048
MAX_ATTEMPTS = 3
MAX_SESSIONS = 8
RATE_PER_MIN = 6
STATUS_CACHE = 15
OUTPUT_CAP = 65536  # parse window; bytes past it are drained and dropped

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]")
BOX_CHARS = frozenset("╭╮╰╯│─┌┐└┘┃━ ")
ANCHOR_URL_RE = re.compile(r"Open this (?:URL|link) in your browser:")
ANCHOR_CODE_RE = re.compile(r"Enter this code:")
URL_LINE_RE = re.compile(r"^https?://[^\s]+$")
DEVICE_CODE_RE = re.compile(r"^[A-Z0-9]{4}-[A-Z0-9]{4,8}$")
CODE_CLAUDE_RE = re.compile(r"^[A-Za-z0-9._~-]{1,1024}$")
# Google authorization codes look like `4/0A...`; a percent-encoded `/` must survive, so the MCP shape allows it
# (the ADR charset is `[A-Za-z0-9._~-]`; widened by ONE character, re-encoded when rebuilt, still one line).
CODE_MCP_RE = re.compile(r"^[A-Za-z0-9._~/-]{1,1024}$")
STATE_RE = re.compile(r"^[A-Za-z0-9._~-]{1,512}$")
ASCII_PRINTABLE_RE = re.compile(r"^[\x20-\x7e]+$")


def log(msg):
    """The ONLY logging path. Callers pass fixed words, an 8-char login prefix, kind/target, a state, an exit
    code or a duration — never child output, a URL, a code or a request body."""
    try:
        sys.stderr.write("login-relay: " + msg + "\n")
        sys.stderr.flush()
    except Exception:
        pass


class RelayError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


def const_eq(a, b):
    return hmac.compare_digest(a.encode("utf-8", "surrogatepass"), b.encode("utf-8", "surrogatepass"))


# --- config ---------------------------------------------------------------------------------------------------
class Config:
    def __init__(self, **kw):
        self.key = kw.pop("key")
        self.servers = kw.pop("servers", {})  # name -> {"host": str, "probe": bool}
        self.hermes_bin = kw.pop("hermes_bin", HERMES_BIN)
        self.python_bin = kw.pop("python_bin", PYTHON_BIN)
        self.probe_path = kw.pop("probe_path", PROBE_DEFAULT)
        self.test_bin = kw.pop("test_bin", TEST_BIN)
        self.setpriv_bin = kw.pop("setpriv_bin", SETPRIV_BIN)
        self.data_dir = kw.pop("data_dir", DATA_DIR)
        self.drop = kw.pop("drop", None)  # None | (uid, gid): lower every child to this uid/gid
        self.ttl_device = kw.pop("ttl_device", TTL_DEVICE)
        self.ttl_paste = kw.pop("ttl_paste", TTL_PASTE)
        self.start_wait = kw.pop("start_wait", START_WAIT)
        self.keep_after_finish = kw.pop("keep_after_finish", KEEP_AFTER_FINISH)
        self.rate_per_min = kw.pop("rate_per_min", RATE_PER_MIN)
        self.max_sessions = kw.pop("max_sessions", MAX_SESSIONS)
        self.status_cache = kw.pop("status_cache", STATUS_CACHE)
        self.allow_http_loopback = kw.pop("allow_http_loopback", False)  # test harness only (mock AS on 127.0.0.1)
        self.extra_mcp_hosts = tuple(kw.pop("extra_mcp_hosts", ()))
        self.provider_hosts = kw.pop("provider_hosts", PROVIDER_HOSTS)
        if kw:
            raise TypeError("unknown config: " + ", ".join(sorted(kw)))
        if not isinstance(self.key, str) or not KEY_RE.match(self.key):
            raise ValueError("key rejected")


# --- child output parser --------------------------------------------------------------------------------------
class OutputParser:
    """Reads the child's lines ONLY to find the URL (and device code) after fixed guidance lines. It keeps no
    text. A URL anywhere else in the output is ignored; the line after the guidance must be exactly a URL."""

    def __init__(self, need_code):
        self.need_code = need_code
        self.want = None
        self.url = None
        self.code = None
        self.error = None

    @property
    def done(self):
        return self.url is not None and (not self.need_code or self.code is not None)

    def feed(self, raw):
        if self.done or self.error:
            return
        line = ANSI_RE.sub("", raw).strip()
        if not line:
            return
        if self.want is not None:
            if all(c in BOX_CHARS for c in line):  # the bottom border of the Claude banner
                return
            want, self.want = self.want, None
            if want == "url":
                if URL_LINE_RE.match(line):
                    self.url = line
                else:
                    self.error = "url_line"
            else:
                if DEVICE_CODE_RE.match(line):
                    self.code = line
                else:
                    self.error = "code_line"
            return
        if self.url is None and ANCHOR_URL_RE.search(line):
            self.want = "url"
        elif self.need_code and self.code is None and ANCHOR_CODE_RE.search(line):
            self.want = "code"


# --- URL and paste validation ---------------------------------------------------------------------------------
def validate_auth_url(url, allowed_hosts, allow_http_loopback):
    """The ONLY URLs that reach the screen (ADR L2 보안 검수 M2). Returns the SplitResult or raises url_rejected."""
    bad = RelayError(502, "url_rejected")
    if not isinstance(url, str) or len(url) > 2048 or not ASCII_PRINTABLE_RE.match(url) or "\\" in url:
        raise bad
    try:
        sp = urlsplit(url)
        port = sp.port
    except ValueError:
        raise bad from None
    host = (sp.hostname or "").lower()
    if "@" in sp.netloc or sp.username is not None or sp.password is not None or not host or sp.fragment:
        raise bad
    if sp.scheme == "https":
        if port not in (None, 443) and not allow_http_loopback:
            raise bad
    elif sp.scheme == "http" and allow_http_loopback and host in LOOPBACK_HOSTS:
        pass
    else:
        raise bad
    if host not in allowed_hosts:
        raise bad
    return sp


def _loopback_redirect(redirect):
    """MCP redirect_uri from the authorization URL: `http://127.0.0.1:<port>/path`, nothing else."""
    try:
        sp = urlsplit(redirect)
        port = sp.port
    except ValueError:
        return None
    host = (sp.hostname or "").lower()
    if (
        sp.scheme != "http"
        or host not in LOOPBACK_HOSTS
        or port is None
        or "@" in sp.netloc
        or sp.query
        or sp.fragment
        or not sp.path.startswith("/")
        or not ASCII_PRINTABLE_RE.match(redirect)
    ):
        return None
    return redirect


def _norm_url(u):
    sp = urlsplit(u)
    return (sp.scheme.lower(), (sp.hostname or "").lower(), sp.port, sp.path)


def _query_pairs(query):
    try:
        pairs = parse_qsl(query, keep_blank_values=True, strict_parsing=True, max_num_fields=12)
    except ValueError:
        raise RelayError(400, "bad_paste") from None
    keys = [k for k, _ in pairs]
    if len(set(keys)) != len(keys):
        raise RelayError(400, "bad_paste")
    d = dict(pairs)
    if set(d) - {"code", "state"}:
        raise RelayError(400, "extra_params")  # `error=`, `iss=`, ...: never forwarded
    if set(d) != {"code", "state"}:
        raise RelayError(400, "bad_paste")
    return d["code"], d["state"]


def canonicalize_paste(kind, target, raw, expected_state, expected_redirect):
    """L3: shape check -> redirect check -> state (constant time) -> REBUILD the line. Raises RelayError (nothing is
    written to the child on any raise). Returns the exact text for the child's stdin (without newline)."""
    if (
        not isinstance(raw, str)
        or not raw
        or len(raw) > MAX_PASTE
        or not ASCII_PRINTABLE_RE.match(raw.strip() or "\0")
    ):
        raise RelayError(400, "bad_paste")
    text = raw.strip()
    if kind == "provider" and target == "anthropic":  # `code#state` (the vendor page shows exactly this)
        if text.count("#") != 1:
            raise RelayError(400, "bad_paste")
        code, state = text.split("#")
        code_re = CODE_CLAUDE_RE
        build = lambda c, s: c + "#" + s  # noqa: E731
    else:  # MCP: the address-bar URL, or its `?code=..&state=..` portion
        code_re = CODE_MCP_RE
        if text.lower().startswith(("http://", "https://")):
            try:
                sp = urlsplit(text)
                port = sp.port
            except ValueError:
                raise RelayError(400, "bad_paste") from None
            if "@" in sp.netloc or sp.username is not None or sp.fragment:
                raise RelayError(400, "redirect_mismatch")
            exp = _norm_url(expected_redirect)
            if (sp.scheme.lower(), (sp.hostname or "").lower(), port, sp.path) != exp:
                raise RelayError(400, "redirect_mismatch")
            code, state = _query_pairs(sp.query)
        elif text.startswith("?") or text.startswith("code="):
            code, state = _query_pairs(text.lstrip("?"))
        else:
            raise RelayError(400, "bad_paste")  # includes `skip` and any other command word
        build = lambda c, s: expected_redirect + "?code=" + quote(c, safe="") + "&state=" + quote(s, safe="")  # noqa: E731
    if not code_re.match(code) or not STATE_RE.match(state):
        raise RelayError(400, "bad_paste")
    if not const_eq(state, expected_state):
        raise RelayError(400, "state_mismatch")
    return build(code, state)


# --- sessions -------------------------------------------------------------------------------------------------
class Session:
    def __init__(self, login_id, operator, kind, target, mode, ttl):
        self.login_id = login_id
        self.operator = operator
        self.kind = kind
        self.target = target
        self.mode = mode
        self.created = time.monotonic()
        self.deadline = self.created + ttl
        self.status = "pending"
        self.reason = None
        self.finished_at = None
        self.proc = None
        self.parser = OutputParser(need_code=(mode == "device"))
        self.ready = threading.Event()
        self.state = None  # authorization `state` (paste mode); not a secret, never returned
        self.redirect = None
        self.submitted = False
        self.attempts = 0
        self.reader = None

    @property
    def tag(self):
        return self.login_id[:8]


class Relay:
    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.sessions = {}
        self.starts = collections.defaultdict(collections.deque)
        self._status_cache = (0.0, None)
        self._stop = threading.Event()
        t = threading.Thread(target=self._reaper, daemon=True)
        t.start()

    # ---- argv: the fixed list ----
    def _argv(self, kind, target):
        c = self.cfg
        if kind == "provider":
            cmd = [c.hermes_bin, "auth", "add", target, "--type", "oauth", "--no-browser"]
        elif c.servers[target].get("probe") and os.path.isfile(c.probe_path):
            cmd = [c.python_bin, c.probe_path, target]
        else:
            cmd = [c.hermes_bin, "mcp", "login", "--", target]
        return self._wrap(cmd)

    def _wrap(self, cmd):
        c = self.cfg
        if not c.drop:
            return cmd
        uid, gid = c.drop
        return [
            c.setpriv_bin, "--reuid=%d" % uid, "--regid=%d" % gid, "--clear-groups",
            "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
        ] + cmd  # fmt: skip

    def _child_env(self):
        d = self.cfg.data_dir
        return {
            "HOME": d,
            "HERMES_HOME": d,
            "PATH": "/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "PYTHONUNBUFFERED": "1",
            "NO_COLOR": "1",
        }

    def _spawn(self, argv, stdin):
        return subprocess.Popen(
            argv,
            shell=False,
            stdin=subprocess.PIPE if stdin else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=self._child_env(),
            cwd="/",  # the relay uid cannot enter /opt/data (0700 hermes); the CLI finds it through HERMES_HOME
            start_new_session=True,  # own process GROUP: TTL / cancel kill the grandchildren too
            close_fds=True,
        )

    # ---- lifecycle ----
    def start(self, kind, target, operator):
        c = self.cfg
        if kind not in ("provider", "mcp") or not isinstance(target, str) or not TARGET_RE.match(target):
            raise RelayError(400, "invalid_target")
        if kind == "provider" and target not in PROVIDERS:
            raise RelayError(400, "invalid_target")
        if kind == "mcp" and target not in c.servers:
            raise RelayError(400, "invalid_target")
        if not isinstance(operator, str) or not OPERATOR_RE.match(operator):
            raise RelayError(400, "invalid_operator")
        mode = PROVIDER_MODE[target] if kind == "provider" else "paste"
        with self.lock:
            now = time.monotonic()
            dq = self.starts[operator]
            while dq and now - dq[0] > 60:
                dq.popleft()
            if len(dq) >= c.rate_per_min:
                raise RelayError(429, "rate_limited")
            for s in self.sessions.values():
                if s.status == "pending" and s.kind == kind and s.target == target:
                    raise RelayError(409, "login_in_progress")
            if sum(1 for s in self.sessions.values() if s.status == "pending") >= c.max_sessions:
                raise RelayError(429, "rate_limited")
            dq.append(now)
            login_id = secrets.token_urlsafe(24)  # 192 bits
            s = Session(login_id, operator, kind, target, mode, c.ttl_device if mode == "device" else c.ttl_paste)
            try:
                s.proc = self._spawn(self._argv(kind, target), stdin=(mode == "paste"))
            except OSError:
                raise RelayError(502, "start_failed") from None
            self.sessions[login_id] = s
        log("start login=%s kind=%s target=%s mode=%s" % (s.tag, kind, target, mode))
        s.reader = threading.Thread(target=self._read, args=(s,), daemon=True)
        s.reader.start()
        threading.Thread(target=self._watch, args=(s,), daemon=True).start()
        s.ready.wait(c.start_wait)
        with self.lock:
            if s.status != "pending":
                raise RelayError(502, "start_failed")
            if not s.parser.done:
                self._finish(s, "failed", "start_timeout" if not s.parser.error else "parse_failed")
                raise RelayError(504 if not s.parser.error else 502, "start_timeout" if not s.parser.error else "parse_failed")
            try:
                sp = validate_auth_url(s.parser.url, self._allowed_hosts(kind, target), c.allow_http_loopback)
                if mode == "paste":
                    q = dict(parse_qsl(sp.query, keep_blank_values=True))
                    qs = [k for k, _ in parse_qsl(sp.query, keep_blank_values=True)]
                    if qs.count("state") != 1 or not STATE_RE.match(q.get("state", "")):
                        raise RelayError(502, "url_rejected")
                    s.state = q["state"]
                    if kind == "mcp":
                        if qs.count("redirect_uri") != 1:
                            raise RelayError(502, "url_rejected")
                        s.redirect = _loopback_redirect(q["redirect_uri"])
                        if s.redirect is None:
                            raise RelayError(502, "url_rejected")
            except RelayError:
                self._finish(s, "failed", "url_rejected")
                raise
            url, user_code = s.parser.url, s.parser.code
            s.parser.url = s.parser.code = None  # the screen gets them once, in this response only
            expires = int(time.time() + (s.deadline - time.monotonic()))
        out = {"login_id": s.login_id, "mode": mode, "url": url, "expires_at": expires}
        if user_code:
            out["user_code"] = user_code
        return out

    def _allowed_hosts(self, kind, target):
        c = self.cfg
        if kind == "provider":
            return tuple(c.provider_hosts[target])
        hosts = [c.servers[target].get("host", "")] + list(c.extra_mcp_hosts)
        if target in GOOGLE_PROBE_SERVERS:
            hosts += list(GOOGLE_AS_HOSTS)
        return tuple(h.lower() for h in hosts if h)

    def _read(self, s):
        """Memory-only: feed lines to the parser until it has what it needs, then just drain."""
        fd = s.proc.stdout.fileno()
        buf = b""
        total = 0
        parsing = True
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            if not parsing:
                continue
            total += len(chunk)
            buf += chunk
            lines = re.split(rb"[\r\n]", buf)
            buf = lines.pop()
            for ln in lines:
                s.parser.feed(ln.decode("utf-8", "replace"))
                if s.parser.done or s.parser.error:
                    parsing = False
                    s.ready.set()
                    break
            if total > OUTPUT_CAP:
                parsing = False
            if not parsing:
                buf = b""
        s.ready.set()

    def _watch(self, s):
        rc = s.proc.wait()
        self._sweep(s)
        s.ready.set()
        if s.reader is not None:
            s.reader.join(2)
        with self.lock:
            if s.status == "pending":
                if rc == 0:
                    self._finish(s, "done", None)
                else:
                    self._finish(s, "failed", "exit_nonzero")
        log("exit login=%s rc=%s elapsed=%ds" % (s.tag, rc, int(time.monotonic() - s.created)))

    def _sweep(self, s):
        """Kill the whole process group (grandchildren included). pgid == pid (start_new_session)."""
        try:
            os.killpg(s.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            log("kill_denied login=%s" % s.tag)

    def _finish(self, s, status, reason):
        with self.lock:
            if s.status != "pending":
                return
            s.status = status
            s.reason = reason
            s.finished_at = time.monotonic()
            s.state = None
            s.redirect = None
            s.parser.url = s.parser.code = None
            if status != "done":
                self._sweep(s)
        log("state login=%s status=%s reason=%s" % (s.tag, status, reason or "-"))

    def _reaper(self):
        while not self._stop.wait(0.5):
            now = time.monotonic()
            with self.lock:
                for lid, s in list(self.sessions.items()):
                    if s.status == "pending" and now > s.deadline:
                        self._finish(s, "expired", "timeout")
                    elif s.status != "pending" and now - (s.finished_at or now) > self.cfg.keep_after_finish:
                        self._sweep(s)
                        del self.sessions[lid]

    def close(self):
        self._stop.set()
        with self.lock:
            for s in self.sessions.values():
                self._sweep(s)

    # ---- per-login operations ----
    def _owned(self, login_id, operator):
        if not isinstance(login_id, str) or not LOGIN_ID_RE.match(login_id):
            raise RelayError(404, "not_found")
        if not isinstance(operator, str) or not OPERATOR_RE.match(operator):
            raise RelayError(400, "operator_required")
        s = self.sessions.get(login_id)
        if s is None:
            raise RelayError(404, "not_found")
        if not const_eq(operator, s.operator):
            raise RelayError(403, "operator_mismatch")
        return s

    def complete(self, login_id, operator, pasted):
        with self.lock:
            s = self._owned(login_id, operator)
            if s.mode != "paste":
                raise RelayError(409, "not_paste_mode")
            if s.status != "pending":
                raise RelayError(409, "not_pending")
            if s.submitted:
                raise RelayError(409, "already_submitted")
            try:
                line = canonicalize_paste(s.kind, s.target, pasted, s.state, s.redirect)
            except RelayError:
                s.attempts += 1
                if s.attempts >= MAX_ATTEMPTS:
                    self._finish(s, "cancelled", "too_many_attempts")
                raise
            s.submitted = True
            try:
                s.proc.stdin.write((line + "\n").encode("ascii"))
                s.proc.stdin.flush()
                s.proc.stdin.close()
            except (OSError, ValueError):
                self._finish(s, "failed", "exit_nonzero")
                raise RelayError(409, "not_pending") from None
        log("submitted login=%s" % s.tag)
        return {"status": "submitted"}

    def get(self, login_id, operator):
        with self.lock:
            s = self._owned(login_id, operator)
            out = {"status": s.status}
            if s.reason:
                out["reason"] = s.reason
            return out

    def cancel(self, login_id, operator):
        with self.lock:
            s = self._owned(login_id, operator)
            self._finish(s, "cancelled", "cancelled")
            return {"status": s.status}

    # ---- status of the targets (non-secret signals only) ----
    def status(self):
        now = time.monotonic()
        with self.lock:
            at, cached = self._status_cache
            if cached is not None and now - at < self.cfg.status_cache:
                return cached
        c = self.cfg
        targets = []
        snippet = (
            "import sys;sys.path.insert(0,'/opt/hermes');"
            "from hermes_cli.auth import get_auth_status as g;"
            "print('LOGGED_IN=1' if g(sys.argv[1]).get('logged_in') else 'LOGGED_IN=0')"
        )
        for p in PROVIDERS:
            ok = self._run_check([c.python_bin, "-c", snippet, p], want_line="LOGGED_IN=1")
            targets.append({"kind": "provider", "target": p, "connected": ok})
        for name in sorted(c.servers):
            ok = self._run_check([c.test_bin, "-e", "%s/mcp-tokens/%s.json" % (c.data_dir.rstrip("/"), name)], rc_only=True)
            targets.append({"kind": "mcp", "target": name, "connected": ok})
        out = {"targets": targets}
        with self.lock:
            self._status_cache = (time.monotonic(), out)
        return out

    def _run_check(self, cmd, want_line=None, rc_only=False):
        try:
            r = subprocess.run(
                self._wrap(cmd), shell=False, stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                env=self._child_env(), cwd="/", close_fds=True, start_new_session=True,
            )  # fmt: skip
        except (OSError, subprocess.TimeoutExpired):
            return False
        if rc_only:
            return r.returncode == 0
        if r.returncode != 0:
            return False
        lines = r.stdout.decode("utf-8", "replace").strip().splitlines()
        return bool(lines) and lines[-1].strip() == want_line


# --- HTTP -----------------------------------------------------------------------------------------------------
LOGIN_PATH_RE = re.compile(r"^/v1/login/([A-Za-z0-9_-]{1,80})(/complete)?$")


def make_handler(relay):
    cfg = relay.cfg

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "oort-login-relay"
        sys_version = ""
        timeout = 20

        def log_message(self, *a):  # request lines carry login ids: never logged
            pass

        def log_error(self, *a):
            pass

        def _send(self, status, obj):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def _authed(self):
            h = self.headers.get("Authorization", "")
            return h.startswith("Bearer ") and const_eq(h[7:], cfg.key)

        def _body(self):
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise RelayError(400, "bad_request") from None
            if n < 0 or n > MAX_BODY:
                raise RelayError(413, "too_large")
            try:
                obj = json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, UnicodeDecodeError):
                raise RelayError(400, "bad_request") from None
            if not isinstance(obj, dict):
                raise RelayError(400, "bad_request")
            return obj

        def _dispatch(self, method):
            try:
                path = self.path.split("?", 1)[0]
                if method == "GET" and path == "/healthz":
                    return self._send(200, {"ok": True})
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                op = self.headers.get("X-Operator", "")
                if method == "POST" and path == "/v1/login":
                    b = self._body()
                    return self._send(200, relay.start(b.get("kind"), b.get("target"), b.get("operator")))
                if method == "GET" and path == "/v1/status":
                    return self._send(200, relay.status())
                m = LOGIN_PATH_RE.match(path)
                if m:
                    lid, complete = m.group(1), m.group(2)
                    if method == "POST" and complete:
                        return self._send(200, relay.complete(lid, op, self._body().get("pasted")))
                    if method == "GET" and not complete:
                        return self._send(200, relay.get(lid, op))
                    if method == "DELETE" and not complete:
                        return self._send(200, relay.cancel(lid, op))
                self._send(404, {"error": "not_found"})
            except RelayError as e:
                self._send(e.status, {"error": e.code})
            except Exception as e:  # noqa: BLE001 — type name only: a message could carry pasted text
                log("internal error=%s" % type(e).__name__)
                try:
                    self._send(500, {"error": "internal"})
                except Exception:
                    pass

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_PATCH(self):
            self._dispatch("PATCH")

    return Handler


def build_server(cfg, host="127.0.0.1", port=0):
    relay = Relay(cfg)
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer((host, port), make_handler(relay))
    srv.relay = relay
    return srv


# --- launch (root) / serve ------------------------------------------------------------------------------------
def _load_oauth_servers(config_path):
    """name -> {"host", "probe"} for `auth: oauth` entries. Root reads the copied config.yaml once at start."""
    try:
        try:
            import yaml  # noqa: PLC0415

            with open(config_path, encoding="utf-8") as f:
                doc = yaml.safe_load(f) or {}
        except ImportError:
            from ruamel.yaml import YAML  # noqa: PLC0415  (the Hermes venv ships ruamel.yaml, not PyYAML)

            with open(config_path, encoding="utf-8") as f:
                doc = YAML(typ="safe").load(f) or {}
    except Exception:  # noqa: BLE001
        log("config unreadable: mcp targets off")
        return {}
    out = {}
    for name, ent in ((doc.get("mcp_servers") or {}) if isinstance(doc, dict) else {}).items():
        if not isinstance(name, str) or not TARGET_RE.match(name) or not isinstance(ent, dict) or ent.get("auth") != "oauth":
            continue
        host = (urlsplit(str(ent.get("url", ""))).hostname or "").lower()
        out[name] = {"host": host, "probe": name in GOOGLE_PROBE_SERVERS}
    return out


def _write_private(path, data, uid):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    os.chown(path, uid, uid)
    os.chmod(path, 0o400)


def launch():
    if os.geteuid() != 0:
        log("relay off: launch needs root (uid separation impossible)")
        return 0
    key = os.environ.pop(KEY_ENV, "")
    if not key:
        log("relay off: no key")
        return 0
    if not KEY_RE.match(key):
        log("relay off: key rejected (length/charset)")
        return 0
    uid = int(os.environ.get("OORT_LOGIN_RELAY_UID", str(DEFAULT_RELAY_UID)))
    hermes_uid = int(os.environ.get("OORT_LOGIN_RELAY_CHILD_UID", "10000"))
    if uid == hermes_uid or uid == 0:
        log("relay off: relay uid must differ from root and the hermes uid")
        return 0
    os.umask(0o077)
    key_dir = os.environ.get("OORT_LOGIN_RELAY_DIR", KEY_DIR)
    os.makedirs(key_dir, mode=0o700, exist_ok=True)
    os.chown(key_dir, uid, uid)
    os.chmod(key_dir, 0o700)
    key_file = os.path.join(key_dir, "key")
    servers_file = os.path.join(key_dir, "servers.json")
    _write_private(key_file, key.encode("ascii"), uid)
    servers = _load_oauth_servers(os.environ.get("OORT_LOGIN_RELAY_CONFIG", DATA_DIR + "/config.yaml"))
    _write_private(servers_file, json.dumps(servers).encode(), uid)
    del key
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1"}
    probe = os.environ.get("OORT_LOGIN_RELAY_PROBE", PROBE_DEFAULT)
    args = [
        SETPRIV_BIN, "--reuid=%d" % uid, "--regid=%d" % uid, "--clear-groups",
        "--inh-caps=+setuid,+setgid,+kill", "--ambient-caps=+setuid,+setgid,+kill",
        "--bounding-set=-all,+setuid,+setgid,+kill", "--no-new-privs",
        PYTHON_BIN, "-I", "-B", os.path.abspath(__file__), "serve",
        "--key-file", key_file, "--servers-file", servers_file, "--probe", probe,
        "--child-uid", str(hermes_uid), "--host", os.environ.get("OORT_LOGIN_RELAY_HOST", "0.0.0.0"),
        "--port", os.environ.get("OORT_LOGIN_RELAY_PORT", str(DEFAULT_PORT)),
    ]  # fmt: skip
    extra = os.environ.get("OORT_LOGIN_RELAY_EXTRA_MCP_HOSTS", "")
    if extra:
        args += ["--extra-mcp-hosts", extra]
    if os.environ.get("OORT_LOGIN_RELAY_ALLOW_HTTP_LOOPBACK") == "1":  # test harness only: the mock AS is http://127.0.0.1
        args += ["--allow-http-loopback"]
    log("relay on: uid=%d port=%s" % (uid, os.environ.get("OORT_LOGIN_RELAY_PORT", str(DEFAULT_PORT))))
    os.execve(SETPRIV_BIN, args, env)
    return 1  # pragma: no cover


def serve(args):
    with open(args.key_file, encoding="ascii") as f:
        key = f.read().strip()
    servers = {}
    if args.servers_file:
        with open(args.servers_file, encoding="utf-8") as f:
            servers = json.load(f)
    drop = None if args.no_drop else (args.child_uid, args.child_uid)
    cfg = Config(
        key=key, servers=servers, probe_path=args.probe, drop=drop, data_dir=args.data_dir,
        hermes_bin=args.hermes_bin, python_bin=args.python_bin,
        allow_http_loopback=args.allow_http_loopback,
        extra_mcp_hosts=[h for h in args.extra_mcp_hosts.split(",") if h],
    )  # fmt: skip
    srv = build_server(cfg, args.host, args.port)
    log("listening")
    signal.signal(signal.SIGTERM, lambda *_: (srv.relay.close(), os._exit(0)))
    try:
        srv.serve_forever()
    finally:
        srv.relay.close()
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="login_relay.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("launch")
    sp = sub.add_parser("serve")
    sp.add_argument("--key-file", required=True)
    sp.add_argument("--servers-file")
    sp.add_argument("--probe", default=PROBE_DEFAULT)
    sp.add_argument("--host", default="0.0.0.0")
    sp.add_argument("--port", type=int, default=DEFAULT_PORT)
    sp.add_argument("--child-uid", type=int, default=10000)
    sp.add_argument("--no-drop", action="store_true")
    sp.add_argument("--data-dir", default=DATA_DIR)
    sp.add_argument("--hermes-bin", default=HERMES_BIN)
    sp.add_argument("--python-bin", default=PYTHON_BIN)
    sp.add_argument("--allow-http-loopback", action="store_true", help="test harness only (mock AS on 127.0.0.1)")
    sp.add_argument("--extra-mcp-hosts", default="")
    args = ap.parse_args(argv)
    return launch() if args.cmd == "launch" else serve(args)


if __name__ == "__main__":
    sys.exit(main())
