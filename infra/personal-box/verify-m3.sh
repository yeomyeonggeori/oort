#!/usr/bin/env bash
# shellcheck disable=SC2016,SC1091,SC2001
# ADR-0197 M3 verification (#3501): momo-box-agent under the real box hardening, on Linux.
# Everything is named momo-m3-* and removed on exit. The S3 image (momo-s3-box:local) is the
# base; it is built if missing or stale and kept, like verify-s3.sh does.
#   verify-m3.sh                         GREEN run
#   verify-m3.sh --sabotage <mode>       must exit non-zero: same-uid | pty-as-agent | cred-readable
#   verify-m3.sh --self-test             GREEN, then every sabotage mode must go RED
# Env: MOMO_M3_BIN_DIR=<dir with momo-box-agent, momo-box-probe> skips the Rust build (self-test uses it).
#
# What runs where:
#   Rust build      rust:1-bookworm container (glibc 2.36, the box image's glibc: a build on a newer glibc
#                   does not start in the box), source mounted read-only, target and registry on tmpfs
#   box             S3 hardening (read-only rootfs, cap-drop ALL, no-new-privileges, tmpfs homes, pids/mem
#                   limits) with exactly two differences, both asserted below: the container starts as
#                   root and keeps CAP_SETUID + CAP_SETGID (the agent needs them to start the person's PTY
#                   as another uid; M2's runner template takes the same shape).
#   key volume      a tmpfs mounted nosuid,nodev stands in for the box volume; the seal key sits on a
#                   second tmpfs (the persistence gate's "other device"). Faked, and said so here.
#   hidepid=2       docker run cannot set it: runtime-unverified, an M2 runner item.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HERE/verify-m3.sh"
SABOTAGE=""
case "${1:-}" in
  --self-test)
    rc=0
    if [[ -z "${MOMO_M3_BIN_DIR:-}" ]]; then
      PRE="$(mktemp -d "${TMPDIR:-/tmp}/momo-m3-bin.XXXXXX")"
      export MOMO_M3_BIN_DIR="$PRE"
      "$SELF" --build-only "$PRE" || { rm -rf "$PRE"; exit 1; }
      trap 'rm -rf "$PRE"' EXIT
    fi
    "$SELF" || rc=1
    for m in same-uid pty-as-agent cred-readable; do
      if "$SELF" --sabotage "$m" >/dev/null 2>&1; then echo "SELF-TEST FAIL: sabotage '$m' stayed GREEN"; rc=1
      else echo "SELF-TEST ok: sabotage '$m' is RED"; fi
    done
    exit "$rc" ;;
  --sabotage) SABOTAGE="${2:?mode}"; shift 2 ;;
  --build-only) BUILD_ONLY="${2:?dir}"; shift 2 ;;
esac

ROOT="$(cd "$HERE/../.." && pwd)"
BASE_IMAGE="momo-s3-box:local"
IMAGE="momo-m3-box:local"
NAME="momo-m3-agent"
RUST_IMAGE="${MOMO_M3_RUST_IMAGE:-rust:1-bookworm}"
BOX_ID="0b0b0b0b-1111-4222-8333-444444444444"
AGENT_UID=10002
PERSON_UID=10001
ENV_USER_UID=$PERSON_UID
WORK="$(mktemp -d "${TMPDIR:-/tmp}/momo-m3-verify.XXXXXX")"
FAILS=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; FAILS=$((FAILS+1)); }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }

cleanup() {
  [[ -n "${MOMO_M3_KEEP:-}" ]] && { echo "MOMO_M3_KEEP set: leaving $NAME and $IMAGE for inspection"; return; }
  docker rm -f "$NAME" momo-m3-build >/dev/null 2>&1
  docker rmi -f "$IMAGE" >/dev/null 2>&1
  rm -rf "$WORK"
}
# A plain run removes everything it made; --self-test shares one build through MOMO_M3_BIN_DIR.
trap cleanup EXIT

# shellcheck source=momo-s3-box.sh
MOMO_S3_STATE_DIR="$WORK/runner-state" source "$HERE/momo-s3-box.sh"
set +e

build_binaries() { # $1 = output dir (copied out with docker cp: the VM only shares $HOME, not $TMPDIR)
  echo "== building momo-box-agent + momo-box-probe for linux in $RUST_IMAGE (target + registry on tmpfs, no disk volume)"
  docker rm -f momo-m3-build >/dev/null 2>&1
  docker run --name momo-m3-build \
    -v "$ROOT/server-rust":/src:ro \
    --tmpfs /target:rw,exec,size=3g --tmpfs /usr/local/cargo/registry:rw,exec,size=1g \
    -e CARGO_TARGET_DIR=/target -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_INCREMENTAL=0 -e CARGO_TERM_COLOR=never -w /src \
    "$RUST_IMAGE" sh -c 'cargo build --locked -p momo-box-agent --bins 2>&1 | tail -3 && mkdir -p /out && cp /target/debug/momo-box-agent /target/debug/momo-box-probe /out/' || return 1
  docker cp momo-m3-build:/out/. "$1/" || return 1
  docker rm -f momo-m3-build >/dev/null 2>&1
}

if [[ -n "${BUILD_ONLY:-}" ]]; then
  build_binaries "$BUILD_ONLY"; rc=$?
  # the cache volumes are removed by cleanup(): the binaries are what self-test keeps
  exit "$rc"
fi

# ---------------------------------------------------------------- base image + binaries
WANT_HASH="$(src_hash)"
HAVE_HASH="$(docker image inspect "$BASE_IMAGE" --format '{{index .Config.Labels "io.momo.s3.src-hash"}}' 2>/dev/null)"
if [[ "$HAVE_HASH" != "$WANT_HASH" ]]; then
  echo "base image missing or stale (label '${HAVE_HASH:-none}' != '$WANT_HASH'): rebuilding"
  "$HERE/momo-s3-box.sh" build >/dev/null 2>&1 || { echo "base image build failed"; exit 1; }
fi
BIN="${MOMO_M3_BIN_DIR:-$WORK/bin}"
if [[ -z "${MOMO_M3_BIN_DIR:-}" ]]; then
  mkdir -p "$BIN"
  build_binaries "$BIN" || { echo "linux build failed"; exit 1; }
fi
check "linux binaries exist (ELF)" bash -c 'head -c 4 "$0/momo-box-agent" | grep -q ELF && head -c 4 "$0/momo-box-probe" | grep -q ELF' "$BIN"
CTX="$WORK/ctx"; mkdir -p "$CTX"
cp "$BIN/momo-box-agent" "$BIN/momo-box-probe" "$HERE/m3/momo-m3-entry" "$HERE/m3/Dockerfile.m3" "$CTX/"
docker build -q -f "$CTX/Dockerfile.m3" -t "$IMAGE" "$CTX" >/dev/null || { echo "m3 image build failed"; exit 1; }

# ---------------------------------------------------------------- run the box
if [[ "$SABOTAGE" == "same-uid" ]]; then
  # The agent runs as the person's uid. The preflight is told the person is some other uid, so it does
  # not refuse: this is exactly the failure only the probe below can see.
  AGENT_UID=$PERSON_UID; ENV_USER_UID=10099
fi
ARGS=(); skip=0
while IFS= read -r l; do
  if [[ $skip == 1 ]]; then skip=0; continue; fi
  [[ "$l" == "--user" ]] && { skip=1; continue; }   # S3 template minus its uid; M3 starts as root
  ARGS+=("$l")
done < <(MOMO_S3_LOG_DRIVER=json-file box_run_args 0)
KEYMNT="rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=$AGENT_UID,gid=$AGENT_UID"
docker run -d --name "$NAME" "${ARGS[@]}" \
  --user 0:0 --cap-add SETUID --cap-add SETGID \
  --tmpfs "/var/lib/oort-box/key:$KEYMNT" \
  --tmpfs "/var/lib/oort-box/state:$KEYMNT" \
  --tmpfs "/run/oort-box-seal:$KEYMNT" \
  -e OORT_BOX_ID="$BOX_ID" -e OORT_BOX_KEY_DIR=/var/lib/oort-box/key \
  -e OORT_BOX_SEAL_KEY_FILE=/run/oort-box-seal/seal.key -e OORT_BOX_USER_UID="$ENV_USER_UID" \
  -e MOMO_M3_AGENT_UID="$AGENT_UID" \
  --entrypoint /usr/local/bin/momo-m3-entry "$IMAGE" >/dev/null || { echo "docker run failed"; exit 1; }
for _ in $(seq 1 40); do
  docker logs "$NAME" 2>&1 | grep -q 'phase=pending' && break
  [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" == true ]] || break
  sleep 0.5
done
LOGS="$(docker logs "$NAME" 2>&1)"
echo "== agent log (public data only):"; sed 's/^/      /' <<<"$LOGS" | head -8
if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]]; then
  # Never go on: every "refused" check below would pass against a dead container.
  echo "FAIL  the box is not running; nothing below would mean anything"; exit 1
fi
check "agent reached phase=pending (registered nothing, confirmed nothing, serves nothing)" grep -q 'phase=pending' <<<"$LOGS"
PID="$(docker exec "$NAME" pgrep -x momo-box-agent | head -1)"
check "agent process found" test -n "$PID"
KEY=/var/lib/oort-box/key/host.key
SELF_ST() { docker exec "$NAME" cat "/proc/$PID/status"; }
STATUS="$(SELF_ST)"
field() { grep -m1 "^$1:" <<<"$STATUS" | cut -f2-; }

# ---------------------------------------------------------------- the container profile
echo "== container profile (S3 hardening, two documented differences)"
insp() { docker inspect "$NAME" --format "$1"; }
check "read-only rootfs" test "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = true
check "cap-drop ALL" bash -c 'docker inspect "$0" --format "{{json .HostConfig.CapDrop}}" | grep -q "\"ALL\""' "$NAME"
check "the only added capabilities are SETUID and SETGID" test "$(docker inspect "$NAME" --format '{{json .HostConfig.CapAdd}}')" = '["CAP_SETGID","CAP_SETUID"]'
check "no-new-privileges" bash -c 'docker inspect "$0" --format "{{json .HostConfig.SecurityOpt}}" | grep -q "no-new-privileges"' "$NAME"
check "not privileged, no bind mounts, no docker.sock" test "$(insp '{{.HostConfig.Privileged}}{{range .Mounts}}{{if eq .Type "bind"}}B{{end}}{{end}}')" = false
check "no seccomp/apparmor unconfined" bash -c '! docker inspect "$0" --format "{{json .HostConfig.SecurityOpt}}" | grep -q unconfined' "$NAME"
check "key mount is nosuid,nodev (ADR-0197 D1) and a tmpfs stand-in" bash -c 'docker exec "$0" sh -c "grep \" /var/lib/oort-box/key \" /proc/mounts" | grep -q "nosuid,nodev"' "$NAME"
check "the seal key is on a different tmpfs than the key directory" bash -c 'a=$(docker exec "$0" stat -c %d /run/oort-box-seal); b=$(docker exec "$0" stat -c %d /var/lib/oort-box/key); [ "$a" != "$b" ]' "$NAME"

# ---------------------------------------------------------------- the agent process
echo "== the agent: own uid, no capability, opaque to others"
check "agent runs as uid $AGENT_UID (real/effective/saved/fs)" test "$(field Uid)" = "$(printf '%s\t%s\t%s\t%s' $AGENT_UID $AGENT_UID $AGENT_UID $AGENT_UID)"
check "agent has no supplementary groups" test -z "$(field Groups | tr -d ' \t')"
for c in CapPrm CapEff CapInh CapAmb; do
  check "agent $c is empty: it started the spawn helper, then dropped every capability (M1)" test "$(field $c)" = 0000000000000000
done
check "agent NoNewPrivs=1" test "$(field NoNewPrivs)" = 1
check "agent is not dumpable: its /proc files belong to root, not to its own uid (PR_SET_DUMPABLE 0)" test "$(docker exec "$NAME" stat -c %u "/proc/$PID/environ")" = 0
check "agent core file limit is 0" bash -c 'docker exec "$0" grep "Max core file size" "/proc/$1/limits" | grep -Eq "[[:space:]]0[[:space:]]+0[[:space:]]"' "$NAME" "$PID"
# root in this box has no CAP_DAC_OVERRIDE: the key is read as the agent uid, the only one that can.
check "host key exists, sealed, owned by the agent uid, mode 0600" bash -c 'o=$(docker exec --user "$2" "$0" stat -c "%u %a" "$1"); [ "$o" = "$2 600" ] && docker exec --user "$2" "$0" head -c 22 "$1" | grep -q oort-hostkey-sealed-v1' "$NAME" "$KEY" "$AGENT_UID"
check "the key file is a sealed envelope, larger than a bare base64 seed (44 bytes)" bash -c '[ "$(docker exec --user "$2" "$0" stat -c %s "$1")" -gt 80 ]' "$NAME" "$KEY" "$AGENT_UID"
check "dev key files are refused: unknown flag is a usage error" bash -c 'docker exec --user 0:0 "$0" timeout 5 momo-box-agent run --dev-key-file /tmp/x 2>&1 | grep -q usage' "$NAME"
check "agent refuses to start at the person's uid" bash -c 'out=$(docker exec --user $0:$0 "$1" timeout 5 momo-box-agent run 2>&1); rc=$?; [ $rc = 2 ] && grep -q "same uid" <<<"$out"' "$PERSON_UID" "$NAME"
check "agent refuses to start as root" bash -c 'out=$(docker exec --user 0:0 "$0" timeout 5 momo-box-agent run 2>&1); rc=$?; [ $rc = 2 ] && grep -q "never runs as root" <<<"$out"' "$NAME"

# ---------------------------------------------------------------- the spawn helper
echo "== the spawn helper: the only capability holder, no host key, no environment"
HPID="$(docker exec "$NAME" pgrep -f 'momo-box-agent spawn-helper' | head -1)"
check "spawn helper process found" test -n "$HPID"
HSTATUS="$(docker exec "$NAME" cat "/proc/$HPID/status")"
hfield() { grep -m1 "^$1:" <<<"$HSTATUS" | cut -f2-; }
check "helper runs under its own third uid 10003 (not the agent's, not the person's)" test "$(hfield Uid)" = "$(printf '10003\t10003\t10003\t10003')"
check "helper holds exactly SETGID|SETUID (0xc0)" test "$(hfield CapEff)" = 00000000000000c0
check "helper NoNewPrivs=1" test "$(hfield NoNewPrivs)" = 1
check "helper is the agent's child" test "$(hfield PPid)" = "$PID"
check "helper is not dumpable (its /proc files belong to root)" test "$(docker exec "$NAME" stat -c %u "/proc/$HPID/environ")" = 0
check "helper cannot read the host key (uid 10003, EACCES): the capability holder never sees it" bash -c 'docker exec --user 10003:10003 "$0" momo-box-probe report --read "$1" | grep -qF "read[$1]=EACCES"' "$NAME" "$KEY"
check "helper command line carries no OORT_*/token (it is given the allowlisted shell environment only)" bash -c '! docker exec "$0" cat "/proc/$1/cmdline" | tr "\0" " " | grep -Eiq "OORT_|ANTHROPIC|OPENAI|TOKEN|SEAL"' "$NAME" "$HPID"
check "marker file /etc/oort-box exists, root-owned, not writable by others (H1: workd keys its box profile on it, not on the environment)" bash -c 'o=$(docker exec "$0" stat -c "%u %a" /etc/oort-box); [ "$o" = "0 644" ]' "$NAME"
check "the person cannot create or change the marker (read-only root and root ownership)" bash -c '! docker exec --user 10001:10001 "$0" sh -c "echo x > /etc/oort-box" 2>/dev/null' "$NAME"

# ---------------------------------------------------------------- the person's uid, probing
probe_asserts() { # file, label
  local f="$1" l="$2" k
  check "$l: host key read refused (EACCES)" test "$(grep -m1 '^read_key=' "$f" | cut -d= -f2)" = EACCES
  for k in list_key_dir overwrite_key create_in_key_dir rename_key unlink_key; do
    check "$l: $k refused (EACCES)" test "$(grep -m1 "^$k=" "$f" | cut -d= -f2)" = EACCES
  done
  for k in environ mem maps; do
    check "$l: /proc/<agent>/$k unreadable (EACCES)" test "$(grep -m1 "^proc_$k=" "$f" | cut -d= -f2)" = EACCES
  done
  check "$l: /proc/<agent>/fd unreadable (EACCES)" test "$(grep -m1 '^proc_fd=' "$f" | cut -d= -f2)" = EACCES
  check "$l: ptrace(PTRACE_ATTACH, agent) refused (EPERM)" test "$(grep -m1 '^ptrace_agent=' "$f" | cut -d= -f2)" = EPERM
  check "$l: positive control: the probe CAN ptrace its own child (so the EPERM above is the box's doing)" test "$(grep -m1 '^ptrace_own_child=' "$f" | cut -d= -f2)" = OK
  check "$l: kill(agent) refused (EPERM): the person cannot signal the agent" test "$(grep -m1 '^kill_agent=' "$f" | cut -d= -f2)" = EPERM
  check "$l: /proc/<agent>/cmdline shows only the subcommand (no secret on the command line)" test "$(grep -m1 '^agent_cmdline=' "$f" | cut -d= -f2-)" = "momo-box-agent run"
  check "$l: open descriptors are exactly 0,1,2 (nothing leaked from the agent or the helper)" test "$(grep -m1 '^open_fds=' "$f" | cut -d= -f2)" = 0,1,2
  check "$l: report completed" grep -q '^report=done' "$f"
}
echo "== docker exec as the person (uid $PERSON_UID)"
docker exec --user "$PERSON_UID:$PERSON_UID" "$NAME" momo-box-probe report --key-file "$KEY" --agent-pid "$PID" >"$WORK/person.txt" 2>&1
check "probe ran as uid $PERSON_UID" grep -q "^uid=$PERSON_UID$" "$WORK/person.txt"
probe_asserts "$WORK/person.txt" "person"

echo "== the PTY child the agent library really starts (spawn-report: setpriv-ed agent uid -> pty::spawn -> drop)"
SPAWN_EXTRA=()
[[ "$SABOTAGE" == "pty-as-agent" ]] && SPAWN_EXTRA=(--user-uid "$AGENT_UID" --user-gid "$AGENT_UID")
docker exec --user 0:0 \
  -e ANTHROPIC_API_KEY=sk-ant-MOMO-M3-MARKER -e CLAUDE_CODE_OAUTH_TOKEN=MOMO-M3-MARKER -e OPENAI_API_KEY=sk-MOMO-M3-MARKER \
  "$NAME" setpriv --reuid "$AGENT_UID" --regid "$AGENT_UID" --clear-groups --inh-caps +setuid,+setgid --ambient-caps +setuid,+setgid -- \
  momo-box-probe spawn-report --agent-exe /usr/local/bin/momo-box-agent --key-file "$KEY" --agent-pid "$PID" ${SPAWN_EXTRA[@]+"${SPAWN_EXTRA[@]}"} >"$WORK/pty.txt" 2>&1
sed -n '/^\(uid\|euid\|gid\|groups\|Cap\|NoNew\|agent_\|ppid\|kill\|open_fds\)/p' "$WORK/pty.txt" | sed 's/^/      /'
check "PTY child runs as the person: uid=euid=gid=$PERSON_UID" bash -c 'grep -qx "uid=$0" "$1" && grep -qx "euid=$0" "$1" && grep -qx "gid=$0" "$1"' "$PERSON_UID" "$WORK/pty.txt"
check "PTY child has no supplementary groups" grep -qx 'groups=' "$WORK/pty.txt"
for c in CapInh CapPrm CapEff CapAmb; do
  check "PTY child $c is empty" grep -qx "$c=0000000000000000" "$WORK/pty.txt"
done
check "PTY child NoNewPrivs=1" grep -qx 'NoNewPrivs=1' "$WORK/pty.txt"
check "an agent that started the helper then dropped its capabilities: drop verified" grep -qx 'agent_drop_capabilities=OK' "$WORK/pty.txt"
check "that agent's CapEff is 0 afterwards" grep -qx 'agent_CapEff_after_drop=0000000000000000' "$WORK/pty.txt"
check "that agent can no longer setuid to the person (a compromised agent cannot read /cred)" grep -qx 'agent_can_setuid_after_drop=false' "$WORK/pty.txt"
check "the PTY child's parent is the helper (uid 10003), not the agent" grep -qx 'ppid_uid=10003' "$WORK/pty.txt"
check "the PTY child cannot signal its parent, the helper (EPERM)" grep -qx 'kill_parent=EPERM' "$WORK/pty.txt"
check "PTY child environment is the allowlist (no OORT_*, MOMO_*, ANTHROPIC*, OPENAI*, CLAUDE_CODE*, no *KEY/*TOKEN)" bash -c '! grep "^envname=" "$0" | grep -Eiq "OORT_|MOMO_|ANTHROPIC|OPENAI|CLAUDE_CODE|KEY|TOKEN|SECRET"' "$WORK/pty.txt"
check "positive control: the child does see HOME USER SHELL TERM PATH CLAUDE_CONFIG_DIR CODEX_HOME" bash -c 'for n in HOME USER SHELL TERM PATH CLAUDE_CONFIG_DIR CODEX_HOME; do grep -qx "envname=$n" "$0" || exit 1; done' "$WORK/pty.txt"
check "no injected marker value printed anywhere in the PTY output" bash -c '! grep -q "MOMO-M3-MARKER" "$0"' "$WORK/pty.txt"
probe_asserts "$WORK/pty.txt" "pty-child"

# ---------------------------------------------------------------- credential paths (the kernel wall; the gate is unit-tested)
echo "== credential paths: the person's login is not readable from the agent's uid"
docker exec --user "$PERSON_UID:$PERSON_UID" "$NAME" sh -c 'mkdir -p /cred/claude /cred/codex && umask 077 && echo MOMO-M3-MARKER-cred > /cred/claude/.credentials.json && echo MOMO-M3-MARKER-cred > /cred/codex/auth.json && echo MOMO-M3-MARKER-cred > /home/box/.claude.json'
if [[ "$SABOTAGE" == "cred-readable" ]]; then
  docker exec --user "$PERSON_UID:$PERSON_UID" "$NAME" sh -c 'chmod 0755 /cred /cred/claude /cred/codex && chmod 0644 /cred/claude/.credentials.json /cred/codex/auth.json'
fi
docker exec --user 0:0 "$NAME" setpriv --reuid "$AGENT_UID" --regid "$AGENT_UID" --clear-groups --inh-caps +setuid,+setgid --ambient-caps +setuid,+setgid -- \
  momo-box-probe report --read /cred/claude/.credentials.json --read /cred/codex/auth.json --read /home/box/.claude.json >"$WORK/cred.txt" 2>&1
for p in /cred/claude/.credentials.json /cred/codex/auth.json /home/box/.claude.json; do
  check "agent uid cannot open $p (EACCES)" test "$(grep -F -m1 "read[$p]=" "$WORK/cred.txt" | cut -d= -f2)" = EACCES
done
check "positive control: the person itself can read its own login file" bash -c 'docker exec --user $0:$0 "$1" cat /cred/claude/.credentials.json | grep -q MOMO-M3-MARKER-cred' "$PERSON_UID" "$NAME"
check "marker not in container logs" bash -c '! docker logs "$0" 2>&1 | grep -q MOMO-M3-MARKER' "$NAME"

# ---------------------------------------------------------------- no ACP
echo "== no Claude ACP adapter"
check "box-agent binary carries no ACP adapter or session verbs" bash -c '! docker exec "$0" grep -a -q -E "agentclientprotocol|claude-agent-acp|session/new" /usr/local/bin/momo-box-agent' "$NAME"
check "no ACP adapter package anywhere in the box filesystem" bash -c '[ -z "$(docker exec "$0" find / -xdev \( -path /proc -o -path /sys \) -prune -o \( -name "*agentclientprotocol*" -o -name "claude-agent-acp*" \) -print 2>/dev/null)" ]' "$NAME"

echo "== recorded, not asserted"
echo "INFO  Yama kernel.yama.ptrace_scope in the VM: $(colima ssh -- cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo n/a) (the EPERM above does not rest on it: the uid and dumpable walls are what the agent set)"
echo "INFO  hidepid=2 on /proc: docker run cannot set it; runtime-unverified, an M2 runner template item"
echo "INFO  bounding set of the PTY child (best effort, needs CAP_SETPCAP which the box withholds): $(grep -m1 '^CapBnd=' "$WORK/pty.txt")"

echo "== result: $FAILS failing check(s) (sabotage: ${SABOTAGE:-none})"
[[ "$FAILS" == 0 ]]
