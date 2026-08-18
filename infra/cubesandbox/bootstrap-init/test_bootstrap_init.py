#!/usr/bin/env python3
"""The invariants of `momo-bootstrap-init`, proved by running it.

WHAT THIS PROVES, AND HOW
=========================

`momo-bootstrap-init` is PID 1 in a momo CubeSandbox template: it answers the
one `POST /init` Cubelet sends inside the create call, lands the workd bootstrap
material, and becomes the workload. Everything it guarantees is a *runtime*
property — file modes, what is and is not in the exec'd process's environment,
whether a second delivery can reach it, whether it ever stops waiting — so every
check below starts a real process, speaks real HTTP to it over a loopback
socket, and reads what it left on disk. Nothing is asserted by importing a
function and trusting it.

The cases, and the claim each one is the evidence for:

  `happy`            the material lands as mode-0600 files and the workload's
                     environ carries `…_TOKEN_FILE`, never the raw token
                     (ADR-0144, README "the token never enters a process
                     environment").
  `rejections`       a name that is not a shell identifier, a name on the
                     forbidden list, a value carrying a control character and an
                     empty `envVars` are each refused `400` with nothing written
                     — and the listener survives all four, because Cubelet
                     retries and a receiver that burns its one shot on a bad
                     body is a receiver that fails the create.
  `write_failure`    a delivery that cannot be written is answered `500`, not
                     `200`. Upstream turns that into a failed create, which is
                     the whole reason `201` is a receipt.
  `one_shot`         after a delivery lands, the port is *gone*: the second
                     connection is refused at TCP.
  `slowloris`        a peer that opens a connection and never finishes its
                     request line does not park PID 1 past `--timeout`.
                     (#1437 M1 — the accepted socket had no read deadline;
                     `HTTPServer.timeout` bounds only the wait *between*
                     connections.)
  `keepalive`        two POSTs pipelined into one connection land the first and
                     only the first. (#1437 L1 — `land()` must not be reachable
                     twice, independent of the response's connection header.)
  `keepalive_guard`  the same pair against a receiver whose only change is a
                     keep-alive answer, where the second POST really is read:
                     `409`, and the material the first receipt covered is
                     untouched. Without it `keepalive` would still pass with the
                     guard deleted, since `Connection: close` alone hides it.
  `inherited_token`  a template baked with `--env MOMO_WORKD_REGISTRATION_TOKEN`
                     does not smuggle that copy into the workload's environ.
                     (#1437 L2 — the delivered token is popped, the inherited one
                     used not to be.)

WHY STDLIB ONLY, AND WHY A SUBPROCESS
=====================================

Stdlib only for `scripts/display_signaling_probe.py`'s reason: this runs in the
`scripts/local_gate.sh` static lane, and a gate that needs `pip install` is a
gate that gets skipped. A subprocess rather than an import because two of the
invariants — "the token is not in the *process* environment" and "the listener
is gone" — are not observable from inside the module that owns them.

RED PROOFS
==========

`--prove-red` re-runs three cases against a deliberately broken copy of the
receiver and requires each to go red. A gate nobody has seen fail is a gate
nobody knows is wired up, and each mutation is the exact code the finding it
belongs to describes:

  slowloris        the accepted socket goes back to blocking reads
  keepalive        the one-delivery guard is removed and the answer is keep-alive
  inherited_token  the inherited `MOMO_WORKD_REGISTRATION_TOKEN` is left in place

Every mutation asserts that its anchor text was actually found, so a refactor
that moves the code fails loudly here instead of quietly proving nothing.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RECEIVER = os.path.join(HERE, "momo-bootstrap-init")

TOKEN_NAME = "MOMO_WORKD_REGISTRATION_TOKEN"
TOKEN_FILE_NAME = "MOMO_WORKD_REGISTRATION_TOKEN_FILE"
SIGNING_KEY_NAME = "MOMO_WORK_HOST_SIGNING_KEY"
SIGNING_KEY_FILE_NAME = "MOMO_WORK_HOST_KEY_PATH"

# What the adapter actually sends (`workd_env_vars` in
# server-rust/crates/momo-t3/src/provider/cubesandbox.rs). Kept whole rather than
# reduced to "some names", because the shape of the delivery is the contract.
DELIVERY = {
    "MOMO_WORKD_SERVER_URL": "https://momo.invalid",
    "MOMO_WORKD_WORKSPACE_ID": "00000000-0000-0000-0000-00000000000d",
    "MOMO_WORKD_DISPLAY_NAME": "cube conformance",
    TOKEN_NAME: "one-shot-workd-token",
}

# The workload the receiver execs. It writes its own environment out and exits,
# which is the only way to observe what `execvpe` was handed.
WORKLOAD_SOURCE = """\
import json, os, sys

with open(sys.argv[1], "w") as handle:
    json.dump(dict(os.environ), handle)
"""


class CheckFailed(Exception):
    """One named invariant did not hold."""


# ---------------------------------------------------------------------------
# harness
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class Workspace:
    """One receiver's worth of scratch: its file paths, its port, its workload."""

    def __init__(self, root: str) -> None:
        self.root = root
        self.private_dir = os.path.join(root, "etc", "momo")
        self.env_file = os.path.join(self.private_dir, "workd.env")
        self.token_file = os.path.join(self.private_dir, "registration.token")
        self.signing_key_file = os.path.join(self.private_dir, "work-host-signing.key")
        self.out_file = os.path.join(root, "workload-environ.json")
        self.workload = os.path.join(root, "workload.py")
        self.port = _free_port()
        with open(self.workload, "w") as handle:
            handle.write(WORKLOAD_SOURCE)

    def landed(self) -> dict[str, str]:
        """`/etc/momo/workd.env` parsed back into names and values."""
        landed: dict[str, str] = {}
        with open(self.env_file) as handle:
            for line in handle:
                if line.startswith("#") or not line.strip():
                    continue
                name, _, quoted = line.rstrip("\n").partition("=")
                if not (quoted.startswith("'") and quoted.endswith("'")):
                    raise CheckFailed(f"env file value for {name} is not shell-quoted: {quoted!r}")
                landed[name] = quoted[1:-1].replace("'\\''", "'")
        return landed

    def workload_environ(self) -> dict[str, str]:
        with open(self.out_file) as handle:
            return json.load(handle)


@contextlib.contextmanager
def _workspace():
    root = tempfile.mkdtemp(prefix="momo-bootstrap-init-")
    try:
        yield Workspace(root)
    finally:
        subprocess.run(["rm", "-rf", root], check=False)


def _start(
    receiver: str,
    workspace: Workspace,
    *,
    timeout: int = 30,
    env_file: str | None = None,
    command: list[str] | None = None,
    environ: dict[str, str] | None = None,
) -> subprocess.Popen:
    """Run the receiver the way a template's `CMD` does.

    `--bind 127.0.0.1` is the one difference from production: the receiver
    listens on `0.0.0.0` inside a microVM because that is where the delivery
    arrives, and a gate has no business opening a port to the LAN of whoever is
    running it.
    """
    child_environ = dict(os.environ)
    child_environ.update(environ or {})
    argv = [
        sys.executable,
        receiver,
        "--bind",
        "127.0.0.1",
        "--port",
        str(workspace.port),
        "--env-file",
        env_file or workspace.env_file,
        "--token-file",
        workspace.token_file,
        "--signing-key-file",
        workspace.signing_key_file,
        "--timeout",
        str(timeout),
        "--",
    ]
    argv += command or [sys.executable, workspace.workload, workspace.out_file]
    return subprocess.Popen(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=child_environ,
    )


def _wait_for_listener(proc: subprocess.Popen, port: int, seconds: float = 10.0) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise CheckFailed(f"the receiver exited (rc={proc.returncode}) before it listened")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.05)
    raise CheckFailed(f"the receiver never listened on :{port}")


def _wait_exit(proc: subprocess.Popen, seconds: float, what: str) -> int:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        code = proc.poll()
        if code is not None:
            return code
        time.sleep(0.05)
    raise CheckFailed(f"{what}: the receiver was still running after {seconds}s")


def _request(payload: dict, *, path: str = "/init") -> bytes:
    body = json.dumps(payload).encode()
    head = (
        f"POST {path} HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "\r\n"
    ).encode()
    return head + body


def _speak(port: int, request: bytes, *, seconds: float = 10.0) -> bytes:
    """Send raw bytes, read until the peer closes or goes quiet."""
    with socket.create_connection(("127.0.0.1", port), timeout=seconds) as sock:
        sock.sendall(request)
        sock.settimeout(seconds)
        chunks = []
        while True:
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)


def _statuses(raw: bytes) -> list[int]:
    return [int(code) for code in re.findall(rb"HTTP/1\.\d (\d{3})", raw)]


def _deliver(port: int, payload: dict, *, path: str = "/init") -> list[int]:
    return _statuses(_speak(port, _request(payload, path=path)))


def _mode(path: str) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def _reap(proc: subprocess.Popen) -> str:
    if proc.poll() is None:
        proc.kill()
    _, stderr = proc.communicate(timeout=10)
    return (stderr or b"").decode(errors="replace")


# ---------------------------------------------------------------------------
# the cases
# ---------------------------------------------------------------------------


def case_happy(receiver: str) -> None:
    """The delivery lands 0600, and the workload never sees the raw token."""
    with _workspace() as workspace:
        proc = _start(receiver, workspace)
        try:
            _wait_for_listener(proc, workspace.port)
            statuses = _deliver(workspace.port, {"envVars": DELIVERY})
            if statuses != [200]:
                raise CheckFailed(f"a well-formed delivery must be answered 200, got {statuses}")
            code = _wait_exit(proc, 10, "happy")
            if code != 0:
                raise CheckFailed(f"the workload must run and exit 0, got rc={code}")
        finally:
            _reap(proc)

        for path in (workspace.env_file, workspace.token_file):
            if _mode(path) != 0o600:
                raise CheckFailed(f"{path} is mode {_mode(path):04o}, not 0600 — /proc is not the "
                                  "only way to read a credential")
        if _mode(workspace.private_dir) != 0o700:
            raise CheckFailed(
                f"{workspace.private_dir} is mode {_mode(workspace.private_dir):04o}, not 0700"
            )

        with open(workspace.token_file) as handle:
            if handle.read() != DELIVERY[TOKEN_NAME] + "\n":
                raise CheckFailed("the token file must hold exactly the delivered token")

        landed = workspace.landed()
        if TOKEN_NAME in landed:
            raise CheckFailed("the raw token must not be written into the env file")
        if landed.get(TOKEN_FILE_NAME) != workspace.token_file:
            raise CheckFailed(f"the env file must name the token file, got {landed!r}")
        for name, value in DELIVERY.items():
            if name == TOKEN_NAME:
                continue
            if landed.get(name) != value:
                raise CheckFailed(f"{name} landed as {landed.get(name)!r}, not {value!r}")

        environ = workspace.workload_environ()
        if TOKEN_NAME in environ:
            raise CheckFailed(
                "named regression: the raw registration token reached the workload's environment "
                "— /proc/<pid>/environ is readable by anything else in the sandbox (ADR-0144)"
            )
        if environ.get(TOKEN_FILE_NAME) != workspace.token_file:
            raise CheckFailed("the workload must be handed the token *file* name")
        if environ.get("MOMO_WORKD_SERVER_URL") != DELIVERY["MOMO_WORKD_SERVER_URL"]:
            raise CheckFailed("the non-secret material must reach the workload unchanged")


def case_rejections(receiver: str) -> None:
    """Four bad bodies, four 400s, nothing written — and the listener survives."""
    refusals = [
        ("a name that is not a shell identifier", {"envVars": {"1BAD": "x"}}),
        ("a name on the forbidden list", {"envVars": {"PYTHONPATH": "/tmp/evil", **DELIVERY}}),
        ("a value carrying a control character", {"envVars": {**DELIVERY,
                                                              "MOMO_WORKD_DISPLAY_NAME": "a\nb"}}),
        ("an empty envVars", {"envVars": {}}),
    ]
    with _workspace() as workspace:
        proc = _start(receiver, workspace)
        try:
            _wait_for_listener(proc, workspace.port)
            for what, payload in refusals:
                statuses = _deliver(workspace.port, payload)
                if statuses != [400]:
                    raise CheckFailed(f"{what} must be refused 400, got {statuses}")
                if os.path.exists(workspace.env_file) or os.path.exists(workspace.token_file):
                    raise CheckFailed(f"{what} must leave nothing on disk")

            # The path is screened too: only /init is a delivery.
            statuses = _deliver(workspace.port, {"envVars": DELIVERY}, path="/anything-else")
            if statuses != [404]:
                raise CheckFailed(f"a POST to another path must be 404, got {statuses}")

            # …and the one shot is still unspent, which is what makes Cubelet's
            # bounded retry survivable.
            statuses = _deliver(workspace.port, {"envVars": DELIVERY})
            if statuses != [200]:
                raise CheckFailed(f"a good delivery after four refusals must land, got {statuses}")
            if _wait_exit(proc, 10, "rejections") != 0:
                raise CheckFailed("the workload must run after the retry landed")
        finally:
            _reap(proc)

        if workspace.landed().get("PYTHONPATH") is not None:
            raise CheckFailed("a refused name must never appear in the landed env file")


def case_write_failure(receiver: str) -> None:
    """A delivery that cannot be written is answered 500 — never 200."""
    with _workspace() as workspace:
        # The env file's parent is a *file*, so `os.makedirs` raises whoever we
        # are. A chmod-based denial would be a no-op for root, and the gate's
        # containers run as root.
        blocked_parent = os.path.join(workspace.root, "not-a-directory")
        with open(blocked_parent, "w") as handle:
            handle.write("this is a regular file\n")
        env_file = os.path.join(blocked_parent, "workd.env")

        proc = _start(receiver, workspace, env_file=env_file)
        try:
            _wait_for_listener(proc, workspace.port)
            statuses = _deliver(workspace.port, {"envVars": DELIVERY})
            if statuses != [500]:
                raise CheckFailed(
                    "named regression: a delivery that could not be written must be answered 500. "
                    f"A 200 turns the substrate's `create 201` into a lie. Got {statuses}"
                )
            if proc.poll() is not None:
                raise CheckFailed("a write failure must not end the wait — Cubelet retries")
            if os.path.exists(workspace.out_file):
                raise CheckFailed("the workload must not run on a failed landing")
        finally:
            stderr = _reap(proc)
        for value in DELIVERY.values():
            if value in stderr:
                raise CheckFailed("the failure log must not print a delivered value")


def case_one_shot(receiver: str) -> None:
    """After the delivery, the port is gone — not merely ignoring you."""
    sleeper = [sys.executable, "-c", "import time; time.sleep(60)"]
    with _workspace() as workspace:
        proc = _start(receiver, workspace, command=sleeper)
        try:
            _wait_for_listener(proc, workspace.port)
            if _deliver(workspace.port, {"envVars": DELIVERY}) != [200]:
                raise CheckFailed("the first delivery must land")

            # The listener closes between the response and the exec, so give the
            # refusal a moment to become true rather than racing it.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    with socket.create_connection(("127.0.0.1", workspace.port), timeout=1):
                        time.sleep(0.05)
                except ConnectionRefusedError:
                    break
                except OSError:
                    break
            else:
                raise CheckFailed(
                    "named regression: the listener outlived its one delivery. CubeProxy routes "
                    "/sandbox/<id>/49983/ unauthenticated, so a port that stays open is reachable "
                    "by anything that learns a sandbox id (ADR-0157)"
                )
            if proc.poll() is not None:
                raise CheckFailed("the workload must be running, not the receiver")
        finally:
            _reap(proc)


def case_slowloris(receiver: str) -> None:
    """A held-open connection must not park PID 1 past `--timeout` (#1437 M1)."""
    with _workspace() as workspace:
        proc = _start(receiver, workspace, timeout=3)
        held = None
        try:
            _wait_for_listener(proc, workspace.port)
            held = socket.create_connection(("127.0.0.1", workspace.port), timeout=5)
            # Legal HTTP as far as it goes. It simply never goes any further.
            held.sendall(b"POST /init HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            code = _wait_exit(
                proc,
                # Four times the deadline the receiver was given. Long enough
                # that a loaded machine is not the reason this fails; short
                # enough that the red proof does not dominate the static lane.
                12,
                "named regression: a peer that opens a connection and never finishes its request "
                "line parks the receiver forever. `HTTPServer.timeout` bounds only the wait "
                "*between* connections, so --timeout is never consulted again and the template "
                "never fails closed (#1437 M1)",
            )
            if code != 3:
                raise CheckFailed(f"the deadline exit is 3 (no delivery), got rc={code}")
            for path in (workspace.env_file, workspace.token_file, workspace.out_file):
                if os.path.exists(path):
                    raise CheckFailed(f"{path} must not exist after a timed-out wait")
        finally:
            if held is not None:
                held.close()
            _reap(proc)


def case_keepalive(receiver: str) -> None:
    """Two POSTs in one connection land the first, and only the first (#1437 L1)."""
    second = dict(DELIVERY)
    second[TOKEN_NAME] = "a-token-the-first-receipt-never-covered"
    second["MOMO_WORKD_SERVER_URL"] = "https://attacker.invalid"

    with _workspace() as workspace:
        proc = _start(receiver, workspace)
        try:
            _wait_for_listener(proc, workspace.port)
            pipelined = _request({"envVars": DELIVERY}) + _request({"envVars": second})
            statuses = _statuses(_speak(workspace.port, pipelined))
            if not statuses or statuses[0] != 200:
                raise CheckFailed(f"the first delivery must land, got {statuses}")
            if statuses[1:] not in ([], [409]):
                raise CheckFailed(
                    "a second POST on the same connection is either never read (the answer says "
                    f"Connection: close) or refused 409 — got {statuses}"
                )
            if _wait_exit(proc, 10, "keepalive") != 0:
                raise CheckFailed("the workload must run on the first delivery")
        finally:
            _reap(proc)

        landed = workspace.landed()
        with open(workspace.token_file) as handle:
            token = handle.read().strip()
        if landed.get("MOMO_WORKD_SERVER_URL") != DELIVERY["MOMO_WORKD_SERVER_URL"] or token != DELIVERY[TOKEN_NAME]:
            raise CheckFailed(
                "named regression: a second POST re-ran land() and rewrote the material the "
                "substrate already took a receipt for (#1437 L1)"
            )


def case_inherited_token(receiver: str) -> None:
    """A template-baked token must not ride into the workload (#1437 L2)."""
    baked = "a-stale-token-baked-into-the-template"
    with _workspace() as workspace:
        proc = _start(receiver, workspace, environ={TOKEN_NAME: baked})
        try:
            _wait_for_listener(proc, workspace.port)
            if _deliver(workspace.port, {"envVars": DELIVERY}) != [200]:
                raise CheckFailed("the delivery must land")
            if _wait_exit(proc, 10, "inherited_token") != 0:
                raise CheckFailed("the workload must run")
        finally:
            _reap(proc)

        environ = workspace.workload_environ()
        if TOKEN_NAME in environ:
            raise CheckFailed(
                "named regression: `--env MOMO_WORKD_REGISTRATION_TOKEN` baked into the template "
                "survives into the workload's environ, because only the *delivered* copy was "
                f"popped. Value seen: {'the baked one' if environ[TOKEN_NAME] == baked else 'the delivered one'} "
                "(#1437 L2)"
            )
        if environ.get(TOKEN_FILE_NAME) != workspace.token_file:
            raise CheckFailed("the workload must still be handed the token file name")
        with open(workspace.token_file) as handle:
            if handle.read().strip() != DELIVERY[TOKEN_NAME]:
                raise CheckFailed("the token file must hold the delivered token, not the baked one")


def case_keepalive_guard(receiver: str) -> None:
    """The one-delivery guard holds even when the answer is keep-alive (#1437 L1).

    `case_keepalive` above proves the *outcome* on the shipping receiver, but it
    cannot prove which mechanism produced it: `Connection: close` means the
    second POST is never read, so `do_POST`'s guard is never reached and could be
    deleted without that case noticing. This runs the same pipelined pair against
    a receiver whose only change is a keep-alive answer — the one edit a future
    refactor might plausibly make — and requires the guard to be what stops it.
    """
    with open(receiver) as handle:
        source = handle.read()
    anchor = 'self.send_header("Connection", "close")'
    if source.count(anchor) != 1:
        raise CheckFailed(f"expected exactly one {anchor!r} in the receiver")
    keep_alive = source.replace(anchor, 'self.send_header("Connection", "keep-alive")')

    second = dict(DELIVERY)
    second[TOKEN_NAME] = "a-token-the-first-receipt-never-covered"
    second["MOMO_WORKD_SERVER_URL"] = "https://attacker.invalid"

    with _workspace() as workspace:
        variant = os.path.join(workspace.root, "momo-bootstrap-init-keepalive")
        with open(variant, "w") as handle:
            handle.write(keep_alive)
        proc = _start(variant, workspace)
        try:
            _wait_for_listener(proc, workspace.port)
            pipelined = _request({"envVars": DELIVERY}) + _request({"envVars": second})
            statuses = _statuses(_speak(workspace.port, pipelined, seconds=20))
            if statuses != [200, 409]:
                raise CheckFailed(
                    "named regression: with a keep-alive answer the second POST *is* read, and "
                    "only do_POST's one-delivery guard stops it from re-running land(). Expected "
                    f"[200, 409], got {statuses}"
                )
        finally:
            _reap(proc)

        with open(workspace.token_file) as handle:
            if handle.read().strip() != DELIVERY[TOKEN_NAME]:
                raise CheckFailed("the refused second delivery must not have rewritten the token")
        if workspace.landed().get("MOMO_WORKD_SERVER_URL") != DELIVERY["MOMO_WORKD_SERVER_URL"]:
            raise CheckFailed("the refused second delivery must not have rewritten the env file")


def case_signing_key(receiver: str) -> None:
    """LIVE-5c: the work-host signing key takes the token's road, not the environ's.

    The producer signs `display-attach/validate` as its work host, so the seed is
    a longer-lived secret than the registration token — which makes
    `/proc/<pid>/environ` a worse place for it, not a better one. This asserts it
    lands in its own 0600 file and that the workload is handed the PATH.
    """
    delivery = dict(DELIVERY)
    delivery[SIGNING_KEY_NAME] = "c2VlZC10aGF0LWlzLW5vdC1hLXJlYWwtb25lLXBhZGRpbmc="
    with _workspace() as workspace:
        proc = _start(receiver, workspace)
        try:
            _wait_for_listener(proc, workspace.port)
            if _deliver(workspace.port, {"envVars": delivery}) != [200]:
                raise CheckFailed("a well-formed delivery must be answered 200")
            if _wait_exit(proc, 10, "signing_key") != 0:
                raise CheckFailed("the workload must run and exit 0")
        finally:
            _reap(proc)

        if _mode(workspace.signing_key_file) != 0o600:
            raise CheckFailed(
                f"{workspace.signing_key_file} is mode {_mode(workspace.signing_key_file):04o}, "
                "not 0600 — a signing key is not less private than a token"
            )
        with open(workspace.signing_key_file) as handle:
            if handle.read() != delivery[SIGNING_KEY_NAME] + "\n":
                raise CheckFailed("the key file must hold exactly the delivered seed")

        landed = workspace.landed()
        if SIGNING_KEY_NAME in landed:
            raise CheckFailed("the raw signing key must not be written into the env file")
        if landed.get(SIGNING_KEY_FILE_NAME) != workspace.signing_key_file:
            raise CheckFailed(f"the env file must name the key file, got {landed!r}")

        environ = workspace.workload_environ()
        if SIGNING_KEY_NAME in environ:
            raise CheckFailed(
                "the raw signing key reached the workload's environment — "
                "/proc/<pid>/environ is readable by anything else in the sandbox"
            )
        if environ.get(SIGNING_KEY_FILE_NAME) != workspace.signing_key_file:
            raise CheckFailed("the workload must be handed the key file path")


CASES = {
    "happy": case_happy,
    "signing_key": case_signing_key,
    "rejections": case_rejections,
    "write_failure": case_write_failure,
    "one_shot": case_one_shot,
    "slowloris": case_slowloris,
    "keepalive": case_keepalive,
    "keepalive_guard": case_keepalive_guard,
    "inherited_token": case_inherited_token,
}


# ---------------------------------------------------------------------------
# red proofs
# ---------------------------------------------------------------------------

# (case, [(anchor, replacement), …]) — each anchor must be present exactly once
# in the shipping receiver, so a refactor that moves the repaired code breaks
# this list instead of silently proving nothing.
MUTATIONS: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "slowloris": (
        "slowloris",
        [("self.connection.settimeout(limit)", "self.connection.settimeout(None)")],
    ),
    "keepalive": (
        "keepalive",
        [
            ('if getattr(self.server, "child_env", None) is not None:', "if False:"),
            ('self.send_header("Connection", "close")',
             'self.send_header("Connection", "keep-alive")'),
            ("self.close_connection = True", "self.close_connection = False"),
        ],
    ),
    # The guard on its own, with the connection header left alone: this is the
    # one that fails if the L1 repair is deleted and `Connection: close` is not.
    "keepalive_guard": (
        "keepalive_guard",
        [('if getattr(self.server, "child_env", None) is not None:', "if False:")],
    ),
    "inherited_token": (
        "inherited_token",
        # The pop moved into the PRIVATE_FILE_MATERIAL loop when LIVE-5c added
        # the signing key beside the token, so the anchor is the loop's line.
        # Removing it lets an inherited copy of EITHER secret ride through into
        # the workload's environ.
        [("os.environ.pop(value_name, None)", "pass  # mutant: the inherited copy survives")],
    ),
    "signing_key": (
        "signing_key",
        # Landing the seed as a plain env var instead of a 0600 file: the value
        # would reach `/proc/<pid>/environ`, which is what the file exists to
        # avoid.
        [
            (
                "        secret = child_env.pop(value_name, None)",
                "        secret = child_env.get(value_name)  # mutant: the value also stays in env",
            )
        ],
    ),
}


def prove_red() -> int:
    with open(RECEIVER) as handle:
        shipping = handle.read()

    failures = 0
    for name, (case_name, edits) in MUTATIONS.items():
        broken = shipping
        for anchor, replacement in edits:
            if broken.count(anchor) != 1:
                print(
                    f"[bootstrap-init] FAIL red proof {name}: the anchor {anchor!r} appears "
                    f"{broken.count(anchor)} times in the receiver, so the mutation would prove "
                    "nothing. Update MUTATIONS to match the code.",
                    file=sys.stderr,
                )
                failures += 1
                broken = None
                break
            broken = broken.replace(anchor, replacement)
        if broken is None:
            continue

        with tempfile.TemporaryDirectory(prefix="momo-bootstrap-init-mutant-") as root:
            mutant = os.path.join(root, "momo-bootstrap-init")
            with open(mutant, "w") as handle:
                handle.write(broken)
            os.chmod(mutant, 0o755)
            try:
                CASES[case_name](mutant)
            except CheckFailed as failure:
                print(f"[bootstrap-init] red proof {name}: caught — {failure}")
                continue
            print(
                f"[bootstrap-init] FAIL red proof {name}: the {case_name} case passed against a "
                "receiver with the repair removed, so it is not testing the repair",
                file=sys.stderr,
            )
            failures += 1

    if failures:
        return 1
    print(f"[bootstrap-init] PASS red proofs ({', '.join(MUTATIONS)})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prove-red", action="store_true",
                        help="require each repair's case to fail when the repair is removed")
    parser.add_argument("--case", choices=sorted(CASES), help="run one case")
    args = parser.parse_args()

    if args.prove_red:
        return prove_red()

    names = [args.case] if args.case else list(CASES)
    for name in names:
        started = time.monotonic()
        try:
            CASES[name](RECEIVER)
        except CheckFailed as failure:
            print(f"[bootstrap-init] FAIL {name}: {failure}", file=sys.stderr)
            return 1
        print(f"[bootstrap-init] ok {name} ({time.monotonic() - started:.1f}s)")

    print(f"[bootstrap-init] PASS {' '.join(names)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
