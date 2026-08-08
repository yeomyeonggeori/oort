#!/usr/bin/env bash
# Workspace isolation, proved and disproved. Runs INSIDE the adapter image.
#
#   tenancy_probe.sh <off|home|full> <expect-leak|expect-isolated>
#
# Promoted from `scripts/spikes/prime-agent/tenancy_probe.sh` (#1130 ③), which
# stays as the spike record. The difference is what it is pointed at: this one
# tests **this adapter's** entrypoint, so the guarantee the README makes is the
# guarantee a script can break.
#
# The shape under test is the one that leaks: two workspaces run sequentially in
# the SAME container as the SAME uid, exactly as a shared worker host would run
# them. ws-a writes a global harness memory through the kernel (`rlm.harness` —
# the door the agent itself has); ws-b then lists what it can see. If ws-a's
# marker is in ws-b's list, tenancy leaked.
#
# The script asserts against the expectation and exits non-zero when reality and
# expectation disagree. So `off -> expect-leak` fails loudly the day upstream
# fixes this, and `full -> expect-isolated` fails loudly the day our isolation
# stops working. An assertion that can only pass is not an assertion.
set -euo pipefail

ISOLATION="${1:?usage: tenancy_probe.sh <off|home|full> <expect-leak|expect-isolated>}"
EXPECT="${2:?usage: tenancy_probe.sh <off|home|full> <expect-leak|expect-isolated>}"
HOME_DIR="${OORT_PRIME_HOME:-/opt/oort/prime}"
OUT="${OORT_PRIME_OUT_ROOT:-/work/out}/tenancy-$ISOLATION"
mkdir -p "$OUT"

for WS in ws-a ws-b; do
  echo "── workspace $WS (isolation=$ISOLATION) ──" >&2
  # The cell prologue carries the workspace id rather than trusting env
  # inheritance through daemon -> worker -> kernel; that chain is precisely what
  # is under test and must not be assumed.
  CODE="import os
os.environ['OORT_WS'] = '$WS'
exec(open('$HOME_DIR/tests/harness_probe.py').read())
"
  OORT_PRIME_WORKSPACE_ID="$WS" \
  OORT_PRIME_ISOLATION="$ISOLATION" \
  OORT_PRIME_ALLOW_UNSAFE_ISOLATION=1 \
  OORT_PRIME_MOCK_PROVIDER=1 \
  MOCK_SCENARIO=cell \
  MOCK_CELL_CODE="$CODE" \
    bash "$HOME_DIR/container/entrypoint.sh" \
      python3 "$HOME_DIR/tests/rpc_probe.py" \
        --model oort-mock/oort-mock-1 \
        --timeout "${OORT_PRIME_TIMEOUT:-180}" \
        --prompt "tenancy probe $WS" \
        --out "$OUT/probe-$WS.json" \
    >"$OUT/run-$WS.log" 2>"$OUT/run-$WS.err" \
    || { echo "!! $WS run failed" >&2; tail -20 "$OUT/run-$WS.err" >&2; }
done

python3 - "$OUT" "$ISOLATION" "$EXPECT" <<'PY'
import json, sys, pathlib

out, isolation, expect = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
MARKER = "OORT_TENANCY_PROBE "


def probe(ws):
    path = out / f"probe-{ws}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    for chunk in data.get("cellOutput", []):
        for line in chunk.splitlines():
            index = line.find(MARKER)
            if index >= 0:
                return json.loads(line[index + len(MARKER):])
    return None


a, b = probe("ws-a"), probe("ws-b")
report = {"isolation": isolation, "expect": expect, "ws-a": a, "ws-b": b}

if a is None or b is None:
    report["verdict"] = "inconclusive: probe line missing"
    print(json.dumps(report, indent=2, sort_keys=True))
    (out / "verdict.json").write_text(json.dumps(report, indent=2, sort_keys=True))
    sys.exit(3)

leaked = "oort-tenancy-ws-a" in (b.get("visible_before_write") or [])
report.update(
    {
        "aMarkerVisibleToB": leaked,
        "sharedStateFile": a.get("state_file") == b.get("state_file"),
        "observed": "leak" if leaked else "isolated",
    }
)
report["verdict"] = "MATCH" if report["observed"] == expect.replace("expect-", "") else "MISMATCH"
print(json.dumps(report, indent=2, sort_keys=True))
(out / "verdict.json").write_text(json.dumps(report, indent=2, sort_keys=True))
sys.exit(0 if report["verdict"] == "MATCH" else 1)
PY
