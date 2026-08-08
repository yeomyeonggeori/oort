"""Spike #1130 ③ — the cell body that proves (or disproves) harness tenancy.

Runs *inside the prime-agent IPython kernel*, not on the host: `rlm.harness` is
the kernel-side door onto the same `harness_state.json` the host's `/refine`
writes (docs/rlm-runtime.md §"rlm.harness"). Reaching it from anywhere else
would be testing our own file I/O instead of the harness's.

Contract with the caller: `OORT_WS` (workspace id) must already be in os.environ
— `run_spike.sh` sets it in the generated cell prologue rather than relying on
the kernel inheriting it. The probe writes ONE global-scope memory tagged with
that id, then lists every globally visible entry, and prints one line:

    OORT_TENANCY_PROBE {"ws": ..., "visible": [...], ...}

Two workspaces run this in turn. If workspace B's `visible` contains workspace
A's marker, global harness state crossed a tenant boundary.
"""

import json
import os

OUT_MARKER = "OORT_TENANCY_PROBE "


def _report(**fields):
    print(OUT_MARKER + json.dumps(fields, sort_keys=True))


def main() -> None:
    ws = os.environ.get("OORT_WS", "unset")
    env = {
        "HOME": os.environ.get("HOME"),
        "PRIME_AGENT_CODING_AGENT_DIR": os.environ.get("PRIME_AGENT_CODING_AGENT_DIR"),
        "RLM_GLOBAL_HARNESS_STATE_DIR": os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR"),
    }
    try:
        from rlm.harness import get_harness_state
    except Exception as exc:  # noqa: BLE001 — the failure itself is the datum
        _report(ws=ws, env=env, error=f"import failed: {type(exc).__name__}: {exc}")
        return

    state = get_harness_state(global_=True)
    # Read BEFORE writing: what this workspace can see of other tenants' state is
    # the whole question, and writing first would make our own marker noise.
    before = sorted(entry.id for entry in state.list(global_=True))
    state.create_memory(
        f"oort tenancy marker {ws}",
        f"secret belonging to {ws} — must never be visible to another workspace",
        id=f"oort-tenancy-{ws}",
        global_=True,
    )
    after = sorted(entry.id for entry in state.list(global_=True))
    _report(
        ws=ws,
        env=env,
        state_file=str(state.file_path),
        visible_before_write=before,
        visible_after_write=after,
    )


main()
