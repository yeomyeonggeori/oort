#!/usr/bin/env python3
"""The automatic refine path, end to end, against the **real** harness (#1194).

    adapters/prime/run.sh auto-refine            # approve — one automatic refinement
    adapters/prime/run.sh auto-refine-rejected   # decline — the reverse control

Runs INSIDE the adapter image, like `tenancy_probe.sh`, because the thing under
test is not the adapter's arithmetic: it is what prime-agent v0.7.0 actually
does when nobody asks it to refine. Everything else here is a double — the
provider is the loopback mock, oort is `fake_oort`, and there is no network
(`--network none`) and no credential.

## Why this could not be written before

The automatic path makes two LLM passes — a review gate and a plan — and both
carry `<current_harness_state>`. `tests/mock_provider.py` keyed on that marker
alone and answered both with a `RefinementProposal`, which `parseAutoRefineReview`
reads as `shouldRefine !== true`. So **every** automatic refinement was declined,
silently, and a regression test written against that fixture would have passed
without the path under test ever running (실측 §4.5). The fixture's review branch
is the precondition for this file existing, and `--review reject` is the control
that proves the branch is load bearing rather than decorative: same run, gate
closed, zero refinements, and a `plan` pass count of zero.

## Sessions

`--no-session` defaults **on** in `adapter.py` and this probe does not change
that default — it sets `OORT_PRIME_NO_SESSION=0` for its own run only. That is
not a detail: with the default on, `_autoRefineAllowedForSession()` is false and
the automatic path does not exist at all (실측 §4.1, case A — zero review passes
even at `turnInterval: 1`). Whether the deployment turns sessions on is an
operating decision (#1194 out-of-scope); whether the adapter tells the truth when
it does is this file.

## What it asserts

* the review gate **and** the plan pass both ran (from the mock's own tally, not
  inferred from the announcement being tested);
* the channel got a refinement announcement whose `trigger` is `turn_interval` —
  not `command`, which is what every automatic refinement said before #1194;
* no `refine` command was ever sent, so there is nothing the `command` label
  could have been true of;
* the session-local state file — the one the automatic path actually writes — is
  among the files the adapter watched;
* one refinement is one line: the file watcher and the event do not each add one.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, HERE)

from fake_oort import REFINE_PROPS_KEY, FakeOort  # noqa: E402
from prime import adapter as prime_adapter_entry  # noqa: E402
from prime.refine import SESSION_ARTIFACTS_DIR_NAME  # noqa: E402

WS = "00000000-0000-7000-8000-000000000001"
CH = "00000000-0000-7000-8000-000000000201"


def write_auto_refine_settings(turn_interval: int, cooldown_ms: int) -> str:
    """`<agentDir>/settings.json`, the lever `FileSettingsStorage` reads.

    Stock defaults are `turnInterval: 25` and a 20-minute cooldown, and both are
    real — 실측 case C fires at 25 with no settings file at all. They are lowered
    here so one prompt is enough; case I (`enabled: false` → zero) is the reverse
    control for the lever itself.
    """
    agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.join(
        os.path.expanduser("~"), ".prime", "agent"
    )
    os.makedirs(agent_dir, exist_ok=True)
    path = os.path.join(agent_dir, "settings.json")
    existing = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            with contextlib.suppress(json.JSONDecodeError):
                existing = json.load(handle)
    existing["autoRefine"] = {"turnInterval": turn_interval, "cooldownMs": cooldown_ms}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(existing, handle)
    return path


def run_adapter(url: str, prompt: str, timeout: float, transcript: str) -> dict:
    """The shipped entrypoint, called as the container calls it."""
    os.environ.update(
        {
            "OORT_PRIME_API_URL": url,
            "OORT_PRIME_WORKSPACE_ID": WS,
            "OORT_PRIME_CHANNEL_ID": CH,
            "OORT_PRIME_AGENT_TOKEN": "test-bearer",
            # This run only. The shipped default stays where it is (#1194 scope).
            "OORT_PRIME_NO_SESSION": "0",
            "OORT_PRIME_SEND_RUN_ID_FIELD": "0",
            "OORT_PRIME_AGENT_HANDLE": "김인턴",
        }
    )
    argv = [
        "--prompt",
        prompt,
        "--model",
        os.environ.get("OORT_PRIME_MODEL", "oort-mock/oort-mock-1"),
        "--timeout",
        str(timeout),
        "--transcript",
        transcript,
    ]
    # The entrypoint prints its summary; the transcript file is the copy this
    # probe reads, so stdout is swallowed to keep the verdict readable.
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        prime_adapter_entry.main(argv)
    with open(transcript, encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--turn-interval", type=int, default=1)
    parser.add_argument("--cooldown-ms", type=int, default=0)
    parser.add_argument("--review", choices=["approve", "reject"], default="approve")
    parser.add_argument("--prompt", default="자동 refine 회귀 프로브")
    parser.add_argument("--timeout", type=float, default=240.0)
    parser.add_argument("--out", default="/work/out/auto-refine")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    settings_path = write_auto_refine_settings(args.turn_interval, args.cooldown_ms)
    pass_log = os.environ.get("MOCK_PASS_LOG", "")

    started = time.time()
    with FakeOort() as oort:
        summary = run_adapter(
            oort.url,
            args.prompt,
            args.timeout,
            os.path.join(args.out, "transcript.json"),
        )
        announcements = [
            message["props"][REFINE_PROPS_KEY]
            for message in oort.model.messages.values()
            if REFINE_PROPS_KEY in message.get("props", {})
        ]
        systems = oort.model.of_type("system")

    passes: dict[str, int] = {}
    if pass_log and os.path.exists(pass_log):
        with open(pass_log, encoding="utf-8") as handle:
            passes = json.load(handle)

    # The *scan*, not the baseline set: an announcement adopts the file it just
    # wrote, so `harnessSources` would list the local file even with scanning
    # switched off. Only the scan answers "would a file nobody told us about be
    # seen", which is the whole of §4.3.
    local_sources = [
        path for path in summary.get("harnessLocalWatched", []) if SESSION_ARTIFACTS_DIR_NAME in path
    ]
    report = {
        "review": args.review,
        "settingsWritten": settings_path,
        "elapsed": round(time.time() - started, 3),
        "passes": passes,
        "eventCounts": summary.get("eventCounts"),
        "commandsSent": summary.get("commandsSent"),
        "harnessSources": summary.get("harnessSources"),
        "harnessLocalWatched": summary.get("harnessLocalWatched"),
        "harnessLocalRoot": summary.get("harnessLocalRoot"),
        "announcements": announcements,
        "systemMessages": len(systems),
        "stderr": (summary.get("stderr") or [])[-10:],
    }

    failures: list[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)

    require(passes.get("review", 0) >= 1, f"the review gate never ran: passes={passes}")
    require(
        summary.get("commandsSent", {}).get("refine", 0) == 0,
        "this probe must never send a refine command; the point is that nobody asked",
    )

    if args.review == "approve":
        require(passes.get("plan", 0) >= 1, f"the gate approved but no plan pass ran: passes={passes}")
        require(len(announcements) >= 1, "an approved automatic refinement announced nothing")
        require(
            all(block["trigger"] == "turn_interval" for block in announcements),
            "an automatic refinement must not be announced as a command: "
            + json.dumps([block["trigger"] for block in announcements]),
        )
        require(
            bool(local_sources),
            "the session-local state file was never scanned for: "
            + json.dumps(summary.get("harnessLocalWatched")),
        )
        require(
            len(systems) == len(announcements),
            "one refinement must be one line; the file watcher and the event both spoke",
        )
    else:
        require(passes.get("plan", 0) == 0, f"a declined review must not plan: passes={passes}")
        require(not announcements, "a declined review must announce nothing")

    report["verdict"] = "PASS" if not failures else "FAIL"
    report["failures"] = failures
    with open(os.path.join(args.out, "verdict.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
