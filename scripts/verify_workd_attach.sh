#!/usr/bin/env bash
# MOMO-674 / ADR-0125 D10 — the standing attach round trip.
#
# WHAT THIS PROVES that no other gate does: a client dials the daemon the way a
# BROWSER does — TLS terminated by a proxy in front of a plaintext listener, the
# capability riding in `Sec-WebSocket-Protocol: momo.terminal.v1, <token>` — and
# gets the #857 replay contract intact on the other side:
#
#   直前 출력(binary) -> replay_end(text) 정확히 1개 -> send_stdin -> 라이브 출력
#
# and then, with the socket still open, the owner closes observation and the
# stream is CUT with 1008 (MOMO-674 스트림 중 재검증).
#
# It is a thin front on scripts/verify_workd.sh rather than a second verifier:
# the fixture attach needs (isolated stack, real signed daemon, approved spawn,
# a real login-shell PTY that has already printed) is that file, and a copy of
# it would be a second thing to keep true. Same shape as verify_acp_host.sh.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Its own block, so this can run beside verify_workd.sh (27950-27953) and the
# rest of the reserved map. The attach legs are API_PORT+71/+72 by construction
# inside verify_workd.sh, which is why they are listed here too.
API_PORT="${WORKD_ATTACH_GATE_API_PORT:-28430}"
CENT_PORT="${WORKD_ATTACH_GATE_CENTRIFUGO_PORT:-28431}"
PG_PORT="${WORKD_ATTACH_GATE_POSTGRES_PORT:-28432}"
HERMES_PORT="${WORKD_ATTACH_GATE_HERMES_PORT:-28433}"
TLS_PORT=$((API_PORT + 71))
PLAIN_PORT=$((API_PORT + 72))

find_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
        >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "[workd-attach] Python 3.10+ not found" >&2
  return 1
}
PYTHON_BIN="$(find_python)"

echo "[workd-attach] reserved ports: api=$API_PORT centrifugo=$CENT_PORT postgres=$PG_PORT hermes=$HERMES_PORT wss=$TLS_PORT listener=$PLAIN_PORT"
COLLISIONS="$(grep -rn "$TLS_PORT\|$PLAIN_PORT" "$REPO_ROOT/scripts" "$REPO_ROOT/infra" \
  --exclude='verify_workd_attach.sh' --exclude='local_gate.sh' 2>/dev/null || true)"
if [ -n "$COLLISIONS" ]; then
  echo "[workd-attach] reserved attach port collision detected" >&2
  printf '%s\n' "$COLLISIONS" >&2
  exit 1
fi

bash -n "$REPO_ROOT/scripts/verify_workd.sh"
bash -n "$REPO_ROOT/scripts/verify_workd_attach.sh"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-attach-pycache" "$PYTHON_BIN" -m py_compile \
  "$REPO_ROOT/scripts/terminal_attach_probe.py" \
  "$REPO_ROOT/scripts/terminal_attach_tls_proxy.py"

# The probe's own red proof, and it needs no Docker: a verifier whose assertion
# has quietly stopped asserting is worse than no verifier, and "it passed" can
# never tell those two apart. Three wires that BREAK the replay contract (no
# marker, an overflow marker instead of replay_end, a second marker after live
# began) are each required to fail at their own named stage.
echo "[workd-attach] red proof: replay marker assertions must fail by name"
"$PYTHON_BIN" "$REPO_ROOT/scripts/terminal_attach_probe.py" --selftest

# The daemon binary the round trip runs against. WORKD_ATTACH_PROVE_RED rebuilds
# it from an isolated COPY with one token changed, so the marker assertion is
# proven load-bearing against the real daemon and not only against the probe's
# own fake host. The worktree is never modified.
PROVE_RED="${WORKD_ATTACH_PROVE_RED:-0}"
MUTANT_DIR=""
cleanup() {
  local rc=$?
  if [ -n "$MUTANT_DIR" ]; then
    case "$MUTANT_DIR" in
      "${TMPDIR:-/tmp}"/momo-attach-red.*) rm -rf -- "$MUTANT_DIR" ;;
      *) echo "[workd-attach] refusing to remove unexpected path: $MUTANT_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT

RED_BIN=""
if [ "$PROVE_RED" = "replay-marker" ]; then
  MUTANT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-attach-red.XXXXXX")"
  cp -R "$REPO_ROOT/workers/WorkHostDaemon" "$MUTANT_DIR/WorkHostDaemon"
  rm -rf "$MUTANT_DIR/WorkHostDaemon/.build"
  MUTANT_SOURCE="$MUTANT_DIR/WorkHostDaemon/Sources/MomoACPHost/PTYReplayBuffer.swift"
  grep -q 'public let type = "replay_end"' "$MUTANT_SOURCE" || {
    echo "[workd-attach] red proof anchor moved; update the mutation" >&2
    exit 1
  }
  "$PYTHON_BIN" - "$MUTANT_SOURCE" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
mutated = source.replace(
    'public let type = "replay_end"',
    'public let type = "replay_end_disabled"',
    1,
)
if mutated == source:
    raise SystemExit("[workd-attach] red mutation did not apply")
path.write_text(mutated, encoding="utf-8")
PY
  echo "[workd-attach] red proof: rebuilding momo-workd with replay_end renamed"
  swift build --disable-sandbox --package-path "$MUTANT_DIR/WorkHostDaemon"
  RED_BIN="$MUTANT_DIR/WorkHostDaemon/.build/debug/momo-workd"
  [ -x "$RED_BIN" ] || {
    echo "[workd-attach] red proof build produced no binary" >&2
    exit 1
  }
fi

run_round_trip() {
  local -a overrides=()
  if [ -n "$RED_BIN" ]; then
    overrides=("WORKD_GATE_BIN=$RED_BIN")
  fi
  env \
    WORKD_GATE_ATTACH=1 \
    WORKD_GATE_PROJECT=momo674attach \
    WORKD_GATE_API_PORT="$API_PORT" \
    WORKD_GATE_CENTRIFUGO_PORT="$CENT_PORT" \
    WORKD_GATE_POSTGRES_PORT="$PG_PORT" \
    WORKD_GATE_HERMES_PORT="$HERMES_PORT" \
    ${overrides[@]+"${overrides[@]}"} \
    "$REPO_ROOT/scripts/verify_workd.sh"
}

if [ -n "$RED_BIN" ]; then
  if run_round_trip; then
    echo "[workd-attach] RED PROOF FAILED: a daemon that never sends replay_end passed" >&2
    exit 1
  fi
  echo "[workd-attach] RED PROOF PASS: the daemon without replay_end fails the named stage"
  exit 0
fi

run_round_trip
echo "MOMO-674 attach standing verification PASS"
