#!/usr/bin/env bash
# Spike #1130 ③ — two workspaces, one container. Runs INSIDE prime-spike:0.7.0.
#
#   tenancy_probe.sh <off|home|full> <expect-leak|expect-isolated>
#
# The shape under test is the one #1130 ③ names: "한 컨테이너/호스트가 여러
# 워크스페이스를 서빙하면 워크스페이스 간 학습 누출". So both workspaces run
# sequentially in the SAME container, as the same uid, exactly as a shared
# worker host would run them. ws-a writes a global harness memory through the
# kernel (`rlm.harness`, the door the agent itself has); ws-b then lists what it
# can see. If ws-a's marker is in ws-b's list, tenancy leaked.
#
# The script asserts against the expectation and exits non-zero when reality and
# expectation disagree — so `off → expect-leak` is a red proof that fails loudly
# the day upstream fixes this, and `full → expect-isolated` fails loudly the day
# our isolation stops working.
set -euo pipefail

ISOLATION="${1:?usage: tenancy_probe.sh <off|home|full> <expect-leak|expect-isolated>}"
EXPECT="${2:?usage: tenancy_probe.sh <off|home|full> <expect-leak|expect-isolated>}"
OUT="${SPIKE_OUT_ROOT:-/work/out}/tenancy-$ISOLATION"
mkdir -p "$OUT"

for WS in ws-a ws-b; do
  echo "── workspace $WS (isolation=$ISOLATION) ──" >&2
  # The cell prologue carries the workspace id rather than trusting env
  # inheritance through daemon → worker → kernel; that chain is precisely what
  # is under test and must not be assumed.
  CODE="import os
os.environ['OORT_WS'] = '$WS'
exec(open('/spike/harness_probe.py').read())
"
  SPIKE_OUT="$OUT" \
  SPIKE_WORKSPACE="$WS" \
  SPIKE_ISOLATION="$ISOLATION" \
  MOCK_SCENARIO=cell \
  MOCK_CELL_CODE="$CODE" \
    bash /spike/container_entry.sh text --timeout "${SPIKE_TIMEOUT:-180}" \
      --prompt "tenancy probe $WS" >"$OUT/run-$WS.json" 2>"$OUT/run-$WS.err" \
    || { echo "!! $WS run failed" >&2; tail -20 "$OUT/run-$WS.err" >&2; }
done

# Daemons keep running after stdin closes (spike doc §6); leave nothing resident
# behind this probe. `--force` is required: without it the CLI refuses with
# "Shutdown requires confirmation in an interactive terminal" and the daemon
# survives silently — measured.
for D in /tmp /work/tmp/ws-a /work/tmp/ws-b; do
  TMPDIR="$D" prime-agent shutdown --force >/dev/null 2>&1 || true
done

python3 - "$OUT" "$ISOLATION" "$EXPECT" <<'PY'
import json, sys, pathlib

out, isolation, expect = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
MARKER = "OORT_TENANCY_PROBE "

def probe(ws):
    path = out / f"transcript-text-{ws}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    for chunk in data.get("cellOutput", []):
        for line in chunk.splitlines():
            i = line.find(MARKER)
            if i >= 0:
                return json.loads(line[i + len(MARKER):])
    return None

a, b = probe("ws-a"), probe("ws-b")
report = {"isolation": isolation, "expect": expect, "ws-a": a, "ws-b": b}

if a is None or b is None:
    report["verdict"] = "inconclusive: probe line missing"
    print(json.dumps(report, indent=2, sort_keys=True))
    (out / "verdict.json").write_text(json.dumps(report, indent=2, sort_keys=True))
    sys.exit(3)

a_marker = f"oort-tenancy-ws-a"
leaked = a_marker in (b.get("visible_before_write") or [])
same_file = a.get("state_file") == b.get("state_file")
report.update({
    "aMarkerVisibleToB": leaked,
    "sharedStateFile": same_file,
    "observed": "leak" if leaked else "isolated",
})
report["verdict"] = "MATCH" if report["observed"] == expect.replace("expect-", "") else "MISMATCH"
print(json.dumps(report, indent=2, sort_keys=True))
(out / "verdict.json").write_text(json.dumps(report, indent=2, sort_keys=True))
sys.exit(0 if report["verdict"] == "MATCH" else 1)
PY
