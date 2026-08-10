#!/usr/bin/env python3
"""Entrypoint for the oort prime adapter — env in, one relayed session out.

This is the file `adapter.yaml` names, the file `container/entrypoint.sh` execs,
and the only place in the package that reads `os.environ`. Everything below it
takes its configuration as arguments, which is what lets the tests drive the same
code without a process environment (`tests/smoke_prime_adapter.py`).

Environment is read `OORT_*` first, `MOMO_*` second (ADR-0152 D2-4b: new surfaces
are spelled `OORT_*`, old spellings keep working). The names are listed once, in
`adapter.yaml`, and the README explains what each one is for.

Run it as::

    python3 adapters/prime/adapter.py --prompt "안녕"

but in production the container runs it, because prime-agent is **not a
sandbox** — it executes shell commands and a persistent IPython kernel with the
privileges of whoever launched it. The container is the isolation boundary and
`container/entrypoint.sh` is what draws it.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from typing import Any

if __package__ in (None, ""):  # direct `python3 adapters/prime/adapter.py`
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "prime"

from .oort_client import OortClient  # noqa: E402
from .prime_adapter import AdapterSettings, PrimeAdapter  # noqa: E402
from .rpc import JsonlRpc  # noqa: E402

#: prime release this adapter is pinned to. The pin is not caution for its own
#: sake: `refine_complete` is undocumented and absent from the shipped RPC types,
#: so "the event still exists" is a measurement, not a guarantee. Moving this
#: number means re-running `tests/` against the new tarball first.
PRIME_AGENT_VERSION = "0.7.0"


def env(name: str, default: str | None = None) -> str | None:
    """`OORT_PRIME_<name>` else `MOMO_PRIME_<name>` else `default`."""
    for prefix in ("OORT_PRIME_", "MOMO_PRIME_"):
        value = os.environ.get(prefix + name)
        if value is not None and value != "":
            return value
    return default


def env_flag(name: str, default: bool) -> bool:
    value = env(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def env_float(name: str, default: float) -> float:
    value = env(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        raise SystemExit(f"{name} must be a number, got {value!r}") from None


def build_client(args: argparse.Namespace) -> OortClient:
    base_url = args.api_base or env("API_URL")
    workspace = args.workspace or env("WORKSPACE_ID")
    channel = args.channel or env("CHANNEL_ID")
    token = args.token or env("AGENT_TOKEN")
    missing = [
        name
        for name, value in (
            ("OORT_PRIME_API_URL", base_url),
            ("OORT_PRIME_WORKSPACE_ID", workspace),
            ("OORT_PRIME_CHANNEL_ID", channel),
            ("OORT_PRIME_AGENT_TOKEN", token),
        )
        if not value
    ]
    if missing:
        raise SystemExit("missing required configuration: " + ", ".join(missing))
    return OortClient(
        base_url,
        workspace,
        channel,
        token,
        run_id=args.run_id or env("RUN_ID"),
        # ADR-0158 D5. Sent whenever a run id exists; a server that has not
        # landed D5 answers 400 and this adapter surfaces that rather than
        # quietly dropping the binding, because the binding is what lets the
        # server close a stream this process abandoned.
        send_run_id_field=env_flag("SEND_RUN_ID_FIELD", True),
        allow_insecure_http=env_flag("ALLOW_INSECURE_HTTP", False),
    )


def build_settings(args: argparse.Namespace) -> AdapterSettings:
    return AdapterSettings(
        agent_handle=args.handle or env("AGENT_HANDLE", "prime") or "prime",
        flush_chars=int(env("FLUSH_CHARS", "220") or 220),
        flush_interval=env_float("FLUSH_INTERVAL", 0.8),
        ui_policy=args.ui_policy or env("UI_POLICY", "none") or "none",
        harness_state_path=env("HARNESS_STATE_PATH"),
        harness_local_root=env("HARNESS_LOCAL_ROOT"),
        turn_timeout=args.timeout,
    )


def prime_argv(args: argparse.Namespace) -> list[str]:
    argv = [args.prime_bin, "--mode", "rpc"]
    if args.no_session:
        argv.append("--no-session")
    if args.offline:
        argv.append("--offline")
    if args.model:
        argv += ["--model", args.model]
    for extension in args.extension or []:
        argv += ["-e", extension]
    return argv


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Relay one prime-agent RPC session into an oort channel.")
    parser.add_argument("--prompt", required=False, default=env("PROMPT", "") or "")
    parser.add_argument("--api-base")
    parser.add_argument("--workspace")
    parser.add_argument("--channel")
    parser.add_argument("--token")
    parser.add_argument("--run-id")
    parser.add_argument("--handle")
    parser.add_argument("--ui-policy", choices=["approve", "deny", "cancel", "none"])
    parser.add_argument("--model", default=env("MODEL"))
    parser.add_argument("--extension", action="append")
    parser.add_argument("--prime-bin", default=env("BIN", "prime-agent"))
    parser.add_argument("--no-session", action="store_true", default=env_flag("NO_SESSION", True))
    parser.add_argument("--offline", action="store_true", default=env_flag("OFFLINE", True))
    parser.add_argument("--refine", action="store_true", help="send one `refine` command after the prompt")
    parser.add_argument("--timeout", type=float, default=env_float("TIMEOUT", 300.0))
    parser.add_argument("--transcript", default=env("TRANSCRIPT"))
    parser.add_argument("--workdir", default=env("WORKDIR"))
    args = parser.parse_args(argv)

    client = build_client(args)
    settings = build_settings(args)
    rpc = JsonlRpc(prime_argv(args), env=dict(os.environ), cwd=args.workdir or None)
    adapter = PrimeAdapter(rpc, client, settings)

    # SIGTERM is how an orchestrator says "stop". Closing the open answer as
    # `cancelled` before the process leaves is the difference between a stopped
    # answer and one that looks finished at whatever word it reached.
    def on_stop(_signum, _frame):
        adapter.cancel("signal")
        raise SystemExit(130)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, on_stop)
        except ValueError:  # not on the main thread (tests)
            pass

    deadline = time.time() + args.timeout
    exit_code = 0
    try:
        rpc.send({"id": "state-1", "type": "get_state"})
        time.sleep(0.3)
        adapter.drain()
        rpc.send({"id": "p-1", "type": "prompt", "message": args.prompt})
        adapter.pump(deadline)
        if args.refine:
            # `global: true` is not a choice, it is the only refinement an
            # invocation-scoped session can do. Measured against v0.7.0:
            # `{"type":"refine"}` from a `--no-session` run answers
            # *"Local harness refinement requires a persisted session; use global
            # refinement instead."* And the harness's "global" is this
            # workspace's, because HOME is per-workspace — which is why the
            # channel announcement still says `scope: "workspace"`.
            rpc.send({"id": "refine-1", "type": "refine", "global": True})
            adapter.pump(min(deadline, time.time() + 90))
    except SystemExit as exc:  # signal path
        exit_code = int(exc.code or 0)
    finally:
        adapter.finish()
        # Order matters, and it is measured. A refinement the harness deferred
        # (`_compactAutoRefinePending`) is drained at **disposal** — the passes
        # happen exactly when stdin closes, and they produce zero stdout because
        # the RPC is already down (실측 §2.4, 2/2 runs). A drift check before
        # this line is a check that runs one step too early and sees nothing; the
        # file is the only witness left, and it is written during `close()`.
        rpc.close()
        adapter.drain()
        adapter.check_harness_drift()

    summary: dict[str, Any] = adapter.summary()
    if args.transcript:
        os.makedirs(os.path.dirname(os.path.abspath(args.transcript)), exist_ok=True)
        with open(args.transcript, "w", encoding="utf-8") as handle:
            json.dump({"transcript": adapter.transcript, **summary}, handle, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
