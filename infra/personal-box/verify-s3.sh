#!/usr/bin/env bash
# shellcheck disable=SC2016,SC1091
# S3 box verification (ADR-0197 S3 items 1,3,4; #3410). Runs without any real login:
# a fake credential marker stands in for tokens. Exit 0 = all checks pass.
#   verify-s3.sh                        GREEN run (builds the image if missing)
#   verify-s3.sh --sabotage <mode>      must exit non-zero: image | log | runner | writable-root | cap-add | root | no-new-privs | unconfined | swap | leakscan-blind | path | acp-adapter
#   verify-s3.sh --self-test            GREEN, then every sabotage mode must go RED
# Names: everything is momo-s3-verify-* ; cleaned up on exit (image momo-s3-box:local is kept unless --rm-image).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HERE/verify-s3.sh"
SABOTAGE=""
RM_IMAGE=0
case "${1:-}" in
  --self-test)
    shift
    rc=0
    "$SELF" || rc=1
    for m in image log runner writable-root cap-add root no-new-privs unconfined swap leakscan-blind path acp-adapter; do
      if "$SELF" --sabotage "$m" >/dev/null 2>&1; then echo "SELF-TEST FAIL: sabotage '$m' stayed GREEN"; rc=1
      else echo "SELF-TEST ok: sabotage '$m' is RED"; fi
    done
    [[ "${1:-}" == "--rm-image" ]] && docker rmi -f momo-s3-box:local >/dev/null 2>&1
    exit "$rc" ;;
  --sabotage) SABOTAGE="${2:?mode}"; shift 2 ;;
esac
[[ "${1:-}" == "--rm-image" ]] && RM_IMAGE=1

BASE_IMAGE="momo-s3-box:local"
IMAGE="$BASE_IMAGE"
MARKER="MOMO-S3-MARKER-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/momo-s3-verify.XXXXXX")"
export MOMO_S3_STATE_DIR="$WORK/runner-state"
export MOMO_S3_NAME="momo-s3-verify-a"
export MOMO_S3_CRED_VOLUME="momo-s3-verify-cred"
export MOMO_S3_IMAGE="$IMAGE"
OUT="$WORK/verify-output.txt"
exec > >(tee "$OUT") 2>&1

# shellcheck source=momo-s3-box.sh
source "$HERE/momo-s3-box.sh"
set +e

FAILS=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; FAILS=$((FAILS+1)); }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }

cleanup() {
  docker rm -f momo-s3-verify-a momo-s3-verify-b momo-s3-verify-c momo-s3-verify-d momo-s3-verify-e >/dev/null 2>&1
  docker volume rm -f "$MOMO_S3_CRED_VOLUME" >/dev/null 2>&1
  [[ -n "$SABOTAGE" ]] && docker rmi -f momo-s3-verify-sab:local >/dev/null 2>&1
  [[ "$RM_IMAGE" == 1 ]] && docker rmi -f "$BASE_IMAGE" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

WANT_HASH="$(src_hash)"
HAVE_HASH="$(docker image inspect "$BASE_IMAGE" --format '{{index .Config.Labels "io.momo.s3.src-hash"}}' 2>/dev/null)"
if [[ "$HAVE_HASH" != "$WANT_HASH" ]]; then
  echo "image missing or stale (label '${HAVE_HASH:-none}' != source '$WANT_HASH'): rebuilding"
  "$HERE/momo-s3-box.sh" build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
fi
check "image src-hash label equals current source hash (never verify a stale image)" test "$(docker image inspect "$BASE_IMAGE" --format '{{index .Config.Labels "io.momo.s3.src-hash"}}')" = "$WANT_HASH"

if [[ "$SABOTAGE" == "image" ]]; then
  # Bake a credential file + marker into a derived image: layer checks must go RED.
  printf 'FROM %s\nUSER root\nRUN mkdir -p /home/box/.claude && echo %s > /home/box/.claude/.credentials.json\nUSER 10001:10001\n' "$BASE_IMAGE" "$MARKER" \
    | docker build -q -t momo-s3-verify-sab:local - >/dev/null
  IMAGE="momo-s3-verify-sab:local"; export MOMO_S3_IMAGE="$IMAGE"
fi

if [[ "$SABOTAGE" == "leakscan-blind" ]]; then
  # A scanner that always says "clean": the shape/secret detection controls must go RED.
  printf 'FROM %s\nUSER root\nRUN printf "#!/bin/sh\\ncat >/dev/null; exit 0\\n" > /usr/local/bin/momo-box-leakscan\nUSER 10001:10001\n' "$BASE_IMAGE" \
    | docker build -q -t momo-s3-verify-sab:local - >/dev/null
  IMAGE="momo-s3-verify-sab:local"; export MOMO_S3_IMAGE="$IMAGE"
fi

if [[ "$SABOTAGE" == "path" ]]; then
  # #3496 regression: no profile.d snippet, so a login shell drops /opt/tools/node_modules/.bin again.
  printf 'FROM %s\nUSER root\nRUN rm -f /etc/profile.d/zz-momo-path.sh\nUSER 10001:10001\n' "$BASE_IMAGE" \
    | docker build -q -t momo-s3-verify-sab:local - >/dev/null
  IMAGE="momo-s3-verify-sab:local"; export MOMO_S3_IMAGE="$IMAGE"
fi

if [[ "$SABOTAGE" == "acp-adapter" ]]; then
  # ADR-0197 D6: a Claude ACP adapter baked into the box image must turn the layer check RED.
  printf 'FROM %s\nUSER root\nRUN mkdir -p /opt/acp/node_modules/@agentclientprotocol/claude-agent-acp && echo {} > /opt/acp/node_modules/@agentclientprotocol/claude-agent-acp/package.json\nUSER 10001:10001\n' "$BASE_IMAGE" \
    | docker build -q -t momo-s3-verify-sab:local - >/dev/null
  IMAGE="momo-s3-verify-sab:local"; export MOMO_S3_IMAGE="$IMAGE"
fi

echo "== image under test: $IMAGE  marker: ${MARKER:0:18}... (sabotage: ${SABOTAGE:-none})"

# ---------------------------------------------------------------- 1. image layers (item 4)
echo "== 1. image layers / history"
SAVE="$WORK/save"; mkdir -p "$SAVE"
check "docker save + extract succeeded" bash -c 'docker save "$0" | tar -x -C "$1"' "$IMAGE" "$SAVE"
NAMES="$WORK/layer-names.txt"; : >"$NAMES"
MARKER_IN_LAYER=0; LAYER_ERR=0; NLAYERS=0
while IFS= read -r layer; do
  NLAYERS=$((NLAYERS+1))
  tar -tf "$SAVE/$layer" >>"$NAMES" 2>"$WORK/tar.err" || { LAYER_ERR=1; echo "      tar list error: $layer: $(head -c 150 "$WORK/tar.err")"; }
  tar -xOf "$SAVE/$layer" 2>"$WORK/tar.err" | grep -aq -- "$MARKER" && MARKER_IN_LAYER=1
  [[ ${PIPESTATUS[0]} -ne 0 ]] && { LAYER_ERR=1; echo "      tar read error: $layer"; }
done < <(python3 -c "import json,sys;[print(l) for m in json.load(open(sys.argv[1])) for l in m['Layers']]" "$SAVE/manifest.json")
check "every image layer listed in manifest.json was read without tar errors ($NLAYERS layers)" test "$LAYER_ERR" = 0 -a "$NLAYERS" -gt 0
check "positive control: layer listing contains usr/local/bin/momo-box-entry" grep -qE '(^|/)usr/local/bin/momo-box-entry$' "$NAMES"
CRED_RE='(^|/)(\.credentials\.json|\.claude\.json|\.netrc|id_rsa|id_ed25519)$|(^|/)\.(claude|codex|ssh)/|(^|/)cred/(claude|codex)/.|(^|/)\.config/(claude|codex)/.'
# auth.json only counts outside installed npm packages (Codex's own file is ~/.codex/auth.json)
CRED_HITS="$(grep -E "$CRED_RE" "$NAMES" | grep -v '/node_modules/' | sort -u)"
check "no credential paths in any image layer" test -z "$CRED_HITS"
[[ -n "$CRED_HITS" ]] && echo "$CRED_HITS" | head -5 | sed 's/^/      hit: /'
AUTH_HITS="$(grep -E '(^|/)auth\.json$' "$NAMES" | grep -v '/node_modules/' | sort -u)"
check "no auth.json outside node_modules in layers" test -z "$AUTH_HITS"
check "marker not present in any layer content" test "$MARKER_IN_LAYER" = 0
HIST="$(docker history --no-trunc "$IMAGE"; docker inspect "$IMAGE" --format '{{json .Config}}')"
check "marker not in image history/config" bash -c '! grep -aq -- "$0" <<<"$1"' "$MARKER" "$HIST"
check "no secret-like ENV names in image config" bash -c '! docker inspect "$0" --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -Eiq "^[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*="' "$IMAGE"
check "image user is non-root (10001)" test "$(docker inspect "$IMAGE" --format '{{.Config.User}}')" = "10001:10001"
check "Claude Code CLI not redistributed in the image (proprietary; installed at first start)" bash -c '! grep -q "node_modules/@anthropic-ai/claude-code" "$0"' "$NAMES"
check "no Claude ACP adapter in the image (ADR-0197 D6: the box never drives Claude over ACP)" bash -c '! grep -Eq "agentclientprotocol|claude-agent-acp" "$0"' "$NAMES"
check "positive control: the same listing does contain the Codex package (the ACP grep reads real names)" grep -q 'node_modules/@openai/codex/' "$NAMES"
rm -rf "$SAVE"

# ---------------------------------------------------------------- 2. runtime hardening (item 1)
echo "== 2. runtime flags (real runner path, default log driver)"
"$HERE/momo-s3-box.sh" up >/dev/null 2>&1 || bad "runner 'up' failed"
A=momo-s3-verify-a
case "$SABOTAGE" in writable-root|cap-add|root|no-new-privs|unconfined|swap)
  # Re-create A with a weakened template to prove the checks bite.
  docker rm -f "$A" >/dev/null 2>&1
  ARGS=(); while IFS= read -r _l; do ARGS+=("$_l"); done < <(box_run_args 0)
  FILTERED=(); skip=0
  for a in "${ARGS[@]}"; do
    if [[ $skip == 1 ]]; then skip=0; continue; fi
    case "$SABOTAGE:$a" in
      writable-root:--read-only) continue ;;
      root:--user) FILTERED+=(--user 0:0); skip=1; continue ;;
      no-new-privs:--security-opt) skip=1; continue ;;
      swap:--memory-swap) skip=1; continue ;;
    esac
    FILTERED+=("$a")
  done
  [[ "$SABOTAGE" == "cap-add" ]] && FILTERED+=(--cap-add NET_RAW)
  [[ "$SABOTAGE" == "unconfined" ]] && FILTERED+=(--security-opt seccomp=unconfined)
  [[ "$SABOTAGE" == "swap" ]] && FILTERED+=(--memory-swap -1)
  docker run -d --name "$A" "${FILTERED[@]}" "$IMAGE" sleep infinity >/dev/null ;;
esac
insp() { docker inspect "$A" --format "$1"; }
check "ReadonlyRootfs=true" test "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = true
check "cap-drop ALL" bash -c 'docker inspect "$0" --format "{{json .HostConfig.CapDrop}}" | grep -q "\"ALL\""' "$A"
check "no cap-add" test "$(insp '{{json .HostConfig.CapAdd}}')" = null
check "no-new-privileges" bash -c 'docker inspect "$0" --format "{{json .HostConfig.SecurityOpt}}" | grep -q "no-new-privileges"' "$A"
check "MemorySwap == Memory (tmpfs credentials cannot be swapped out)" test "$(insp '{{.HostConfig.MemorySwap}}')" = "$(insp '{{.HostConfig.Memory}}')"
check "no seccomp/apparmor unconfined in SecurityOpt" bash -c '! docker inspect "$0" --format "{{json .HostConfig.SecurityOpt}}" | grep -q unconfined' "$A"
check "container Config.User is 10001:10001" test "$(insp '{{.Config.User}}')" = "10001:10001"
check "not privileged" test "$(insp '{{.HostConfig.Privileged}}')" = false
check "no bind mounts / docker.sock" test -z "$(insp '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{end}}{{end}}')"
check "credential dir /cred is tmpfs mount" bash -c 'docker inspect "$0" --format "{{json .HostConfig.Tmpfs}}" | grep -q "\"/cred\""' "$A"
check "docker log driver is none (ADR-0197 D8)" test "$(insp '{{.HostConfig.LogConfig.Type}}')" = none
check "pids/memory limits set" bash -c '[ "$(docker inspect "$0" --format "{{.HostConfig.PidsLimit}}")" -gt 0 ] && [ "$(docker inspect "$0" --format "{{.HostConfig.Memory}}")" -gt 0 ]' "$A"
check "no secret-like env names in container" bash -c '! docker inspect "$0" --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -Eiq "^[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*="' "$A"
INSIDE() { docker exec "$A" sh -c "$1"; }
check "inside: umask 077 in login shell" test "$(docker exec "$A" bash -lc umask)" = 0077
check "inside: /opt/tools/node_modules/.bin is last in PATH" bash -c 'docker exec "$0" sh -c "echo \$PATH" | grep -q "/opt/tools/node_modules/.bin$"' "$A"
check "inside: uid != 0" test "$(INSIDE 'id -u')" != 0
check "inside: CapEff all zero" bash -c 'docker exec "$0" sh -c "grep ^CapEff /proc/self/status" | grep -q "0000000000000000"' "$A"
check "inside: NoNewPrivs=1" bash -c 'docker exec "$0" sh -c "grep ^NoNewPrivs /proc/self/status" | grep -q "1$"' "$A"
check "inside: root fs not writable" bash -c '! docker exec "$0" sh -c "touch /probe" 2>/dev/null' "$A"
check "inside: core dumps off (ulimit -c 0)" test "$(INSIDE 'ulimit -c')" = 0
check "inside: no setuid/setgid files" test -z "$(INSIDE 'find / -xdev -type f \( -perm -4000 -o -perm -2000 \) 2>/dev/null')"
check "inside: no docker.sock" bash -c '! docker exec "$0" test -e /var/run/docker.sock' "$A"
check "inside: /cred is tmpfs" bash -c 'docker exec "$0" sh -c "grep \" /cred \" /proc/mounts" | grep -q "^tmpfs"' "$A"
check "inside: codex CLI runs unmodified" bash -c 'docker exec "$0" codex --version | grep -q "^codex-cli"' "$A"
check "inside: Claude install script present, claude not baked" bash -c 'docker exec "$0" sh -c "test -x /usr/local/bin/momo-box-install-claude && ! test -e /opt/tools/node_modules/.bin/claude"' "$A"

# ---------------------------------------------------------------- 2b. login-shell PATH (#3496)
echo "== 2b. login shell keeps /opt/tools/node_modules/.bin (the first-start Claude install must resolve)"
E=momo-s3-verify-e
EARGS=(); while IFS= read -r _l; do EARGS+=("$_l"); done < <(box_run_args 0)
docker run -d --name "$E" "${EARGS[@]}" "$IMAGE" sleep infinity >/dev/null
# Stand-in for the installed CLI (no network needed): an executable where momo-box-install-claude puts it.
docker exec "$E" sh -c 'mkdir -p /opt/tools/node_modules/.bin && printf "#!/bin/sh\necho stand-in-claude\n" > /opt/tools/node_modules/.bin/claude && chmod 0755 /opt/tools/node_modules/.bin/claude'
check "bash -lc 'command -v claude' resolves to the tools dir (login shell, stand-in CLI)" test "$(docker exec "$E" bash -lc 'command -v claude')" = /opt/tools/node_modules/.bin/claude
check "bash -lc 'claude' runs" test "$(docker exec "$E" bash -lc 'claude')" = stand-in-claude
check "the tools dir is the LAST PATH entry of a login shell (distro and /usr/local/bin win)" bash -c 'docker exec "$0" bash -lc "echo \$PATH" | grep -Eq "^/usr/local/bin:.*:/opt/tools/node_modules/.bin$"' "$E"
check "a login shell does not duplicate the entry when PATH already has it" test "$(docker exec "$E" bash -lc 'echo "$PATH" | tr : "\n" | grep -c "^/opt/tools/node_modules/.bin$"')" = 1
check "nested login shell keeps exactly one entry" test "$(docker exec "$E" bash -lc 'bash -lc "echo \$PATH" | tr : "\n" | grep -c "^/opt/tools/node_modules/.bin$"')" = 1
check "a tools-dir binary cannot shadow system commands (appended last: 'ls' stays /usr/bin or /bin)" bash -c 'docker exec "$0" sh -c "printf \"#!/bin/sh\necho shadow\n\" > /opt/tools/node_modules/.bin/ls && chmod 0755 /opt/tools/node_modules/.bin/ls"; p="$(docker exec "$0" bash -lc "command -v ls")"; [ "$p" != /opt/tools/node_modules/.bin/ls ]' "$E"
# The real first-start install, when the registry is reachable (otherwise runtime-unverified, not a failure).
docker exec "$E" sh -c 'rm -rf /opt/tools/node_modules /opt/tools/package.json /opt/tools/package-lock.json'
if docker exec "$E" momo-box-install-claude >"$WORK/claude-install.log" 2>&1; then
  check "after the real first-start install: bash -lc 'command -v claude' resolves (#3496)" test "$(docker exec "$E" bash -lc 'command -v claude')" = /opt/tools/node_modules/.bin/claude
  check "after the real first-start install: bash -lc 'claude --version' runs" bash -c 'docker exec "$0" bash -lc "claude --version" | grep -Eq "[0-9]+\.[0-9]+"' "$E"
else
  echo "SKIP  real first-start Claude install (registry unreachable?): runtime-unverified; last log lines:"; tail -3 "$WORK/claude-install.log" | sed 's/^/        /'
fi

# ---------------------------------------------------------------- 3. tmpfs vs persistent login (item 3/4 + D8)
echo "== 3. fake credentials on tmpfs; gone after restart; opt-in volume persists"
B=momo-s3-verify-b
BARGS=(); while IFS= read -r _l; do BARGS+=("$_l"); done < <(MOMO_S3_LOG_DRIVER=json-file box_run_args 0)
PID1='echo box-ready; sleep infinity'
[[ "$SABOTAGE" == "log" ]] && PID1="echo box-ready; echo $MARKER; sleep infinity"
docker run -d --name "$B" "${BARGS[@]}" "$IMAGE" sh -c "$PID1" >/dev/null
plant() { # container: write fake credentials via stdin (marker never in argv)
  printf '{"accessToken":"%s","refreshToken":"%s-refresh"}\n' "$MARKER" "$MARKER" \
    | docker exec -i "$1" sh -c 'cat > /cred/claude/.credentials.json && cp /cred/claude/.credentials.json /cred/codex/auth.json'
}
sleep 1
plant "$B"
check "fake credentials written to /cred (tmpfs)" bash -c 'docker exec "$0" test -s /cred/claude/.credentials.json' "$B"
# live host-visible leak surfaces while the marker exists in the box
{ docker logs "$B" 2>&1; } >"$WORK/b.log"
check "container logs captured output (positive control: 'box-ready' present)" grep -q box-ready "$WORK/b.log"
check "marker absent from container logs (host grep)" bash -c '! grep -aq -- "$0" "$1"' "$MARKER" "$WORK/b.log"
check "marker absent from container logs (in-box leakscan, secrets never leave box)" bash -c 'docker logs "$0" 2>&1 | docker exec -i "$0" momo-box-leakscan b-logs' "$B"
if [[ "$SABOTAGE" == "runner" ]]; then echo "debug: $MARKER" >>"$MOMO_S3_STATE_DIR/runner.log"; fi
plant "$A"
check "marker absent from runner log/state dir" bash -c '! grep -raq -- "$0" "$1"' "$MARKER" "$MOMO_S3_STATE_DIR"
check "runner audit (leakscan: logs, runner log, VM container dir) is clean" "$HERE/momo-s3-box.sh" audit
check "marker absent from this verifier's own output so far" bash -c '! grep -aq -- "$0" "$1"' "$MARKER" "$OUT"
# Colima VM disk surfaces: container metadata dirs, writable layers (containerd snapshots / overlay2), our volumes
VM=0
if command -v colima >/dev/null 2>&1 && colima status >/dev/null 2>&1; then VM=1; fi
VMSCAN='m="$1"; shift
for id in "$@"; do echo "#dir /var/lib/docker/containers/$id"; grep -rIl --binary-files=text -- "$m" "/var/lib/docker/containers/$id"; done
for v in /var/lib/docker/volumes/momo-s3-*; do [ -d "$v" ] && { echo "#dir $v"; grep -rIl --binary-files=text -- "$m" "$v"; }; done
for root in /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots /var/lib/docker/overlay2; do
  [ -d "$root" ] || continue
  echo "#root $root"
  for d in $(find "$root" -maxdepth 1 -mindepth 1 -mmin -30); do grep -rIl --binary-files=text -- "$m" "$d"; done
done
true'
vm_scan() { # ids... -> hits on stdout (lines not starting with #), scanned roots on #-lines, errors shown
  VMERR="$WORK/vm.err"
  VMRAW="$(colima ssh -- sudo sh -c "$VMSCAN" sh "$MARKER" "$@" 2>"$VMERR")"; VMRC=$?
  [[ -s "$VMERR" ]] && { echo "      vm-scan stderr (first lines):"; head -3 "$VMERR" | sed 's/^/        /'; }
  VMHITS="$(grep -v '^#' <<<"$VMRAW")"
}
IDA="$(docker inspect -f '{{.Id}}' "$A")"; IDB="$(docker inspect -f '{{.Id}}' "$B")"
if [[ $VM == 1 ]]; then
  vm_scan "$IDA" "$IDB"
  check "VM scan ran (rc 0) and covered a writable-layer root" bash -c '[ "$0" = 0 ] && grep -q "^#root " <<<"$1"' "$VMRC" "$VMRAW"
  check "marker not on VM disk after tmpfs-mode run (container dirs A/B, writable layers, momo-s3 volumes)" test -z "$VMHITS"
  echo "      VM host swap/core state (informational, ADR D8 machine-checked items):"
  colima ssh -- sh -c 'echo "swaps: $(tail -n +2 /proc/swaps | wc -l) entries; core_pattern=$(cat /proc/sys/kernel/core_pattern); swappiness=$(cat /proc/sys/vm/swappiness)"; command -v kdump >/dev/null 2>&1 && echo kdump-present || echo kdump-absent' 2>&1 | sed 's/^/        /'
  check "no credential volume exists in tmpfs mode" test -z "$(docker volume ls -q --filter "name=$MOMO_S3_CRED_VOLUME")"
else
  echo "SKIP  Colima VM disk scan (colima not running); runtime-unverified for VM-disk surface"
fi
docker restart "$B" >/dev/null; sleep 1
check "tmpfs mode: credentials gone after container restart" bash -c '! docker exec "$0" sh -c "test -e /cred/claude/.credentials.json || test -e /cred/codex/auth.json"' "$B"
C=momo-s3-verify-c
CARGS=(); while IFS= read -r _l; do CARGS+=("$_l"); done < <(box_run_args 1)
docker run -d --name "$C" "${CARGS[@]}" "$IMAGE" sleep infinity >/dev/null; sleep 1
plant "$C"; docker restart "$C" >/dev/null; sleep 1
check "persist mode (--persist-login volume): credentials survive restart" bash -c 'docker exec "$0" test -s /cred/claude/.credentials.json' "$C"
check "persist mode: volume is the only persistent holder" test "$(docker volume ls -q --filter "name=$MOMO_S3_CRED_VOLUME" | wc -l | tr -d ' ')" = 1
D=momo-s3-verify-d
docker run -d --name "$D" -e "MOMO_S3_CONTROL=$MARKER" "$IMAGE" sh -c 'echo "$MOMO_S3_CONTROL" > /var/tmp/control; sleep infinity' >/dev/null; sleep 1
IDC="$(docker inspect -f '{{.Id}}' "$C")"; IDD="$(docker inspect -f '{{.Id}}' "$D")"
if [[ $VM == 1 ]]; then
  vm_scan "$IDA" "$IDB" "$IDC" "$IDD"
  check "VM positive control: persist-mode volume holds the marker" grep -q "^/var/lib/docker/volumes/momo-s3-verify-cred/" <<<"$VMHITS"
  check "VM positive control: container metadata dir of control container D holds the marker" grep -q "^/var/lib/docker/containers/$IDD/" <<<"$VMHITS"
  check "VM positive control: a writable-layer (snapshot/overlay2) path holds the marker" grep -Eq '/(snapshots|overlay2)/' <<<"$VMHITS"
  check "no VM hit in containers A/B/C metadata (only volume, control D, D's layer)" bash -c '! grep -E "/containers/($0|$1|$2)/" <<<"$3" | grep -q .' "$IDA" "$IDB" "$IDC" "$VMHITS"
fi

# ---------------------------------------------------------------- leakscan shape controls (each shape must be detected)
echo "== 4. leakscan detection controls (inside the box, creds present so the comparison is not vacuous)"
ESC=$(printf '\033')
declare -a SHAPE_NAMES=(claude_oauth_url openai_device_url device_code anthropic_key jwt ansi_wrapped_url wrapped_line_url secret_value)
SHAPE_SAMPLES=(
 "visit https://claude.ai/oauth/authorize?code=true&client_id=x"
 "open https://auth.openai.com/codex/device now"
 "Enter device code: ABCD-12345"
 "key sk-""ant-api03-abcdefghijklmnop"
 "tok eyJ""hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"
 "${ESC}[4mhttps://claude.ai/oauth/${ESC}[0m${ESC}[4mauthorize?x=1${ESC}[0m"
 "https://claude.ai/oauth/auth
orize?x=1"
 "leaked $MARKER here"
)
for n in "${!SHAPE_NAMES[@]}"; do
  docker exec -i "$A" momo-box-leakscan "ctl-${SHAPE_NAMES[$n]}" <<<"${SHAPE_SAMPLES[$n]}" >/dev/null; rc=$?
  check "leakscan detects ${SHAPE_NAMES[$n]} (exit 1)" test "$rc" = 1
done
printf 'plain benign text\n' | docker exec -i "$A" momo-box-leakscan ctl-clean >/dev/null; check "leakscan clean input exits 0" test "$?" = 0
printf '' | docker exec -i "$A" momo-box-leakscan ctl-empty >/dev/null; check "leakscan empty input is UNREAD (exit 2)" test "$?" = 2
docker exec "$A" sh -c 'find /cred -type f -delete'
printf 'benign\n' | docker exec -i "$A" momo-box-leakscan ctl-vacuous >/dev/null; check "leakscan with no secrets under /cred is VACUOUS (exit 2) unless --allow-empty" test "$?" = 2
printf 'benign\n' | docker exec -i "$A" momo-box-leakscan ctl-pre --allow-empty >/dev/null; check "leakscan --allow-empty (pre-login) passes benign input" test "$?" = 0
check "runner audit fails when there are no secrets to compare (post-login expectation)" bash -c '! "$0" audit >/dev/null 2>&1' "$HERE/momo-s3-box.sh"
check "runner audit --pre-login tolerates that" "$HERE/momo-s3-box.sh" audit --pre-login
rm -f "$MOMO_S3_STATE_DIR/runner.log"
check "runner audit reports UNREAD (fails) when runner.log is missing" bash -c '! "$0" audit --pre-login >/dev/null 2>&1' "$HERE/momo-s3-box.sh"

# ---------------------------------------------------------------- result
echo "== final: marker absent from verifier output (sabotage 'log' prints it into container logs, not here)"
check "marker absent from verifier output" bash -c '! grep -aq -- "$0" "$1"' "$MARKER" "$OUT"
echo "== result: $FAILS failing check(s)"
[[ "$FAILS" == 0 ]]
