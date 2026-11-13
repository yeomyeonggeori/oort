#!/usr/bin/env bash
# #5606 regression for the cleanup guards: scripts/lib/leftover_check.sh and
# scripts/check_docker_rm_volumes.sh. No daemon is needed (case R uses the real
# docker CLI only when it exists).
#
#   H  a docker that never answers and ignores ALRM/TERM cannot hold snapshot or
#      report past the deadline: each ends in seconds with a "건너뜀" line and rc 0
#      (perl `alarm` does not stop the Go docker CLI; the helper must kill the PID)
#   R  the real docker CLI against a TCP "daemon" that accepts and never replies
#   S  scope: only this run's labels and the given temp globs count — another lane's
#      container (other label) and a shared-TMPDIR path are not reported
#   D  detection: a labelled container and volume plus a .tmp-* sandbox left after
#      the snapshot are named in one WARNING line; rc 0
#   L  lint: the tree passes; a removal without -v (docker / "$DOCKER_BIN" forms)
#      fails; -v / -fv / --volumes pass; comments and the operator allow-list pass
#   G  local_gate wiring: explicit scope, bounded timeout, snapshot before the first
#      step, report after the final cleanup, evidence line, lint + this test in the
#      static block
#
# LEFTOVER_CHECK_UNDER_TEST / DOCKER_RM_LINT_UNDER_TEST / LOCAL_GATE_UNDER_TEST point
# at sabotaged copies.
# shellcheck disable=SC2016 # literal $ in grep patterns and fixture script bodies
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
HELPER="${LEFTOVER_CHECK_UNDER_TEST:-$REPO_ROOT/scripts/lib/leftover_check.sh}"
LINT="${DOCKER_RM_LINT_UNDER_TEST:-$REPO_ROOT/scripts/check_docker_rm_volumes.sh}"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-leftover-test.XXXXXX")"
SRV_PID=""

fail() { echo "[leftover-check-test] FAIL: $*" >&2; exit 1; }
pass() { echo "[leftover-check-test] PASS $*"; }

kill_tree() {  # exact PIDs only: the given one and its descendants
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done
  kill -KILL "$p" 2>/dev/null || true
}
cleanup() {
  local p
  [ -n "$SRV_PID" ] && kill_tree "$SRV_PID"
  if [ -f "$SANDBOX/fake/pids" ]; then
    while IFS= read -r p; do
      case "$p" in ''|*[!0-9]*) continue ;; esac
      kill -KILL "$p" 2>/dev/null || true
    done <"$SANDBOX/fake/pids"
  fi
  case "$SANDBOX" in "${TMPDIR:-/tmp}"/momo-leftover-test.*) rm -rf -- "$SANDBOX" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# run_bounded <limit-seconds> <out-file> <cmd...>: RB_RC, RB_SECS, RB_TIMEDOUT
run_bounded() {
  local limit="$1" out="$2" pid ticks=0 start
  shift 2
  start="$(date +%s)"
  "$@" >"$out" 2>&1 &
  pid=$!
  RB_TIMEDOUT=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge $((limit * 10)) ]; then RB_TIMEDOUT=1; kill_tree "$pid"; break; fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  RB_RC=0
  wait "$pid" 2>/dev/null || RB_RC=$?
  RB_SECS=$(( $(date +%s) - start ))
}

# ---- fake docker --------------------------------------------------------------
FAKE="$SANDBOX/fake"
mkdir -p "$FAKE" "$SANDBOX/bin" "$SANDBOX/repo" "$SANDBOX/shared"
: >"$FAKE/containers"
: >"$FAKE/volumes"
cat >"$SANDBOX/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$$" >>"$FAKE_DIR/pids"
if [ "${FAKE_DOCKER_MODE:-ok}" = hang ]; then
  # A daemon that never answers, and a CLI that ignores ALRM/TERM like Go's does.
  trap '' ALRM TERM INT
  exec sleep 600
fi
sub="${1:-}"
[ "$#" -gt 0 ] && shift
filter=""
while [ "$#" -gt 0 ]; do
  case "$1" in --filter) filter="${2:-}"; shift 2 ;; *) shift ;; esac
done
f=""
case "$sub" in
  version) echo 29.0.0-fake; exit 0 ;;
  ps) f="$FAKE_DIR/containers" ;;
  volume) f="$FAKE_DIR/volumes" ;;
esac
# rows are "<exact --filter value>\t<name>", e.g. "label=k=v<TAB>name"
[ -n "$f" ] && [ -f "$f" ] && awk -F'\t' -v k="$filter" '$1 == k { print $2 }' "$f"
exit 0
STUB
chmod +x "$SANDBOX/bin/docker"
export FAKE_DIR="$FAKE"
FAKE_PATH="$SANDBOX/bin:/usr/bin:/bin"

RUN_LABEL="com.momo.gate-run=test-run-5606"
OTHER_LABEL="com.momo.gate-run=another-lane"

# ---- H: a hung docker cannot hold the helper ----------------------------------
run_bounded 15 "$SANDBOX/h1.out" env PATH="$FAKE_PATH" FAKE_DOCKER_MODE=hang \
  LEFTOVER_LABELS="$RUN_LABEL" LEFTOVER_DOCKER_TIMEOUT=2 bash "$HELPER" snapshot "$SANDBOX/h.state"
[ "$RB_TIMEDOUT" = 0 ] || fail "H: snapshot was still running after 15s against a hung docker (the deadline does not stop the CLI)"
[ "$RB_RC" = 0 ] || fail "H: snapshot rc $RB_RC (must be 0)"
[ "$RB_SECS" -le 8 ] || fail "H: snapshot took ${RB_SECS}s with a 2s deadline"
grep -q '응답 없음' "$SANDBOX/h1.out" || fail "H: snapshot line does not say the daemon did not answer: $(cat "$SANDBOX/h1.out")"
grep -q '^#docker	0$' "$SANDBOX/h.state" || fail "H: snapshot did not record the docker part as skipped"
# report against a state that saw docker: it must probe, time out, and still answer.
printf '#docker\t1\n' >"$SANDBOX/h2.state"
run_bounded 15 "$SANDBOX/h2.out" env PATH="$FAKE_PATH" FAKE_DOCKER_MODE=hang \
  LEFTOVER_LABELS="$RUN_LABEL" LEFTOVER_DOCKER_TIMEOUT=2 bash "$HELPER" report "$SANDBOX/h2.state"
[ "$RB_TIMEDOUT" = 0 ] || fail "H: report was still running after 15s against a hung docker"
[ "$RB_RC" = 0 ] || fail "H: report rc $RB_RC (must be 0)"
grep -q '건너뜀' "$SANDBOX/h2.out" || fail "H: report line does not say the docker part was skipped: $(cat "$SANDBOX/h2.out")"
alive=0
while IFS= read -r p; do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done <"$FAKE/pids"
[ "$alive" = 0 ] || fail "H: $alive hung docker process(es) outlived the deadline"
: >"$FAKE/pids"
pass "H hung docker (ALRM/TERM ignored): snapshot ${RB_SECS}s-bounded, report bounded, both rc 0 with a skip line, no survivor"

# ---- R: the real CLI against a daemon that accepts and never replies ------------
if command -v docker >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  python3 - "$SANDBOX/port" "${LEFTOVER_TEST_PORT:-0}" <<'PY' &
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[2])))
s.listen(16)
with open(sys.argv[1], "w") as f:
    f.write(str(s.getsockname()[1]))
held = []
while True:
    c, _ = s.accept()
    held.append(c)  # hold the connection, never answer
PY
  SRV_PID=$!
  for _ in $(seq 1 50); do [ -s "$SANDBOX/port" ] && break; sleep 0.1; done
  if [ -s "$SANDBOX/port" ]; then
    port="$(cat "$SANDBOX/port")"
    run_bounded 20 "$SANDBOX/r.out" env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
      DOCKER_HOST="tcp://127.0.0.1:$port" LEFTOVER_LABELS="$RUN_LABEL" LEFTOVER_DOCKER_TIMEOUT=2 \
      bash "$HELPER" snapshot "$SANDBOX/r.state"
    [ "$RB_TIMEDOUT" = 0 ] || fail "R: snapshot hung past 20s on a silent daemon with the real docker CLI"
    [ "$RB_RC" = 0 ] || fail "R: snapshot rc $RB_RC"
    grep -q '응답 없음' "$SANDBOX/r.out" || fail "R: expected a no-answer skip line, got: $(cat "$SANDBOX/r.out")"
    pass "R real docker CLI, silent TCP daemon: bounded (${RB_SECS}s), skip line, rc 0"
  else
    echo "[leftover-check-test] SKIP R: could not start the silent TCP daemon"
  fi
  kill_tree "$SRV_PID"
  wait "$SRV_PID" 2>/dev/null || true
  SRV_PID=""
else
  echo "[leftover-check-test] SKIP R: docker CLI or python3 not on PATH"
fi

# ---- S + D: scope and detection with an answering fake ---------------------------
export LEFTOVER_LABELS="$RUN_LABEL"
export LEFTOVER_TMP_GLOBS="$SANDBOX/repo/.tmp-*"
printf 'label=%s\t%s\n' "$RUN_LABEL" "momo-old-before" >"$FAKE/containers"
PATH="$FAKE_PATH" bash "$HELPER" snapshot "$SANDBOX/sd.state" >"$SANDBOX/sd1.out"
grep -q '^#docker	1$' "$SANDBOX/sd.state" || fail "S: snapshot did not see the answering docker: $(cat "$SANDBOX/sd1.out")"
PATH="$FAKE_PATH" bash "$HELPER" report "$SANDBOX/sd.state" >"$SANDBOX/sd2.out"
grep -q '남은 자원 0' "$SANDBOX/sd2.out" || fail "S: nothing new yet, but report said: $(cat "$SANDBOX/sd2.out")"
# what this run leaves, and what another lane / the shared TMPDIR holds
{
  printf 'label=%s\t%s\n' "$RUN_LABEL" "momo-run-left-pg"
  printf 'label=%s\t%s\n' "$OTHER_LABEL" "oort-other-lane-pg"
  # another lane's momo/oort-named containers: the old name-based scope reported them
  printf 'name=%s\t%s\n' momo "momo-other-lane-db" oort "oort-other-lane-edge"
} >>"$FAKE/containers"
printf 'label=%s\t%s\n' "$RUN_LABEL" "momo-run-left-vol" >"$FAKE/volumes"
mkdir "$SANDBOX/repo/.tmp-leak.abc123" "$SANDBOX/shared/oort-other-lane.xyz"
rc=0
PATH="$FAKE_PATH" bash "$HELPER" report "$SANDBOX/sd.state" >"$SANDBOX/sd3.out" || rc=$?
[ "$rc" = 0 ] || fail "D: report rc $rc"
line="$(cat "$SANDBOX/sd3.out")"
case "$line" in *"WARNING"*"컨테이너 1 · 볼륨 1 · 임시 1"*) ;; *) fail "D: expected 1/1/1 leftover, got: $line" ;; esac
case "$line" in *momo-run-left-pg*momo-run-left-vol*) ;; *) fail "D: leftover names missing: $line" ;; esac
case "$line" in *".tmp-leak.abc123"*) ;; *) fail "D: the .tmp-* sandbox is not named: $line" ;; esac
case "$line" in *other-lane*|*momo-old-before*) fail "S: reported something this run does not own: $line" ;; esac
[ "$(wc -l <"$SANDBOX/sd3.out" | tr -d ' ')" = 1 ] || fail "D: report printed more than one line"
unset LEFTOVER_LABELS LEFTOVER_TMP_GLOBS
pass "S/D scope + detection: this run's container, volume and .tmp-* sandbox named in one line; another lane's label, a pre-existing container and the shared TMPDIR ignored"

# ---- L: the -v lint ----------------------------------------------------------------
bash "$LINT" "$REPO_ROOT" >"$SANDBOX/l0.out" 2>&1 || fail "L: the tree has a removal without -v: $(cat "$SANDBOX/l0.out")"
# Fixture bodies spell the docker word as @DOCKER@ / @BIN@ so this file itself does
# not carry removal lines for the lint to find; lint_root writes the real words.
lint_root() {  # lint_root <name> <script body> [<path under root>] -> lint rc on that tree
  local root="$SANDBOX/lint-$1" rel="${3:-scripts/case.sh}"
  mkdir -p "$root/$(dirname "$rel")"
  printf '#!/usr/bin/env bash\n%s\n' "$2" | sed -e 's/@DOCKER@/docker/g' -e 's/@BIN@/DOCKER_BIN/g' >"$root/$rel"
  bash "$LINT" "$root" >"$root.out" 2>&1
}
{
  lint_root bare '@DOCKER@ rm -f "$c" >/dev/null 2>&1 || true' && fail "L: a plain-docker removal without -v passed"
  lint_root bin 'container) "$@BIN@" rm -f "$ref" >/dev/null 2>&1 || return 1 ;;' && fail 'L: a DOCKER_BIN removal without -v passed'
  lint_root ctr '@DOCKER@ container rm -f "$id"' && fail "L: a container-subcommand removal without -v passed"
  lint_root trapq "trap '@DOCKER@ rm -f \"\$NAME\" >/dev/null 2>&1 || true' EXIT" && fail "L: a bare rm inside a trap string passed"
  lint_root ok '@DOCKER@ rm -f -v "$c"; @DOCKER@ rm -fv "$d"; @DOCKER@ rm --force --volumes "$e"; @DOCKER@ rm -v "$f"' || fail "L: -v forms were refused: $(cat "$SANDBOX/lint-ok.out")"
  lint_root comment '# @DOCKER@ rm -f "$old" (history)' || fail "L: a comment was flagged"
  lint_root tailc '@DOCKER@ rm -f "$x" >/dev/null  # #5606: -v takes the VOLUME' && fail "L: a -v that only appears in a trailing comment passed"
  lint_root other '@DOCKER@ network rm "$n"; @DOCKER@ volume rm "$v"; @DOCKER@ rmi "$i"' || fail "L: non-container rm forms were flagged"
  lint_root allow '@DOCKER@ rm -f $containers >/dev/null' scripts/momo || fail "L: the operator allow-list (scripts/momo) was not honoured"
}
pass "L lint: tree clean; bare docker / \"\$DOCKER_BIN\" / container rm refused; -v, -fv, --volumes, comments, network/volume/rmi and the allow-list pass"

# ---- G: local_gate wiring ------------------------------------------------------------
GATE="${LOCAL_GATE_UNDER_TEST:-$REPO_ROOT/scripts/local_gate.sh}"
grep -q 'bash "$REPO_ROOT/scripts/lib/leftover_check.sh" "$1" "$LEFTOVER_STATE"' "$GATE" || fail "G: the gate no longer calls the helper"
calls="$(grep -cE '^ *(LEFTOVER_LINE="\$\()?run_leftover_check (snapshot|report)' "$GATE" || true)"
[ "$calls" = 2 ] || fail "G: expected one snapshot and one report call, found $calls"
grep -q 'LEFTOVER_NAMES="" LEFTOVER_LABELS="com.momo.gate-runtime-db=$RUN_ID com.momo.gate-run=$RUN_ID"' "$GATE" \
  || fail "G: the gate does not pin its scope (empty names, this run's labels); a caller's LEFTOVER_NAMES would leak in"
grep -q 'LEFTOVER_DOCKER_TIMEOUT=[0-9]' "$GATE" || fail "G: the gate does not bound the docker calls"
snap_line="$(grep -n '^run_leftover_check snapshot' "$GATE" | head -n 1 | cut -d: -f1)"
loop_line="$(grep -n '^  if ! run_cmd "\$idx"; then$' "$GATE" | head -n 1 | cut -d: -f1)"
final_line="$(grep -n 'run_final_cleanup_cmd "\$idx" || true' "$GATE" | head -n 1 | cut -d: -f1)"
report_line="$(grep -n 'run_leftover_check report' "$GATE" | head -n 1 | cut -d: -f1)"
[ -n "$snap_line" ] && [ -n "$loop_line" ] && [ "$snap_line" -lt "$loop_line" ] || fail "G: snapshot is not before the first step"
[ -n "$final_line" ] && [ -n "$report_line" ] && [ "$report_line" -gt "$final_line" ] || fail "G: report is not after the final cleanup"
grep -q 'Leftover check (#5606, warn-only)' "$GATE" || fail "G: the evidence line is gone"
grep -q "'scripts/check_docker_rm_volumes.sh'" "$GATE" || fail "G: the -v lint is not in the static block"
grep -q "'scripts/tests/test_leftover_check.sh'" "$GATE" || fail "G: this regression is not in the static block"
pass "G local_gate: pinned scope, bounded docker, snapshot before step 1, report after final cleanup, evidence line, lint + test in the static block"

echo "[leftover-check-test] ALL PASS"
