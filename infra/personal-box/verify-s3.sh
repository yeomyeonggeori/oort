#!/usr/bin/env bash
# shellcheck disable=SC2016,SC1091
# S3 box verification (ADR-0197 S3 items 1,3,4; #3410). Runs without any real login:
# a fake credential marker stands in for tokens. Exit 0 = all checks pass.
#   verify-s3.sh                        GREEN run (builds the image if missing)
#   verify-s3.sh --sabotage <mode>      must exit non-zero: image | log | runner | writable-root | cap-add
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
    for m in image log runner writable-root cap-add; do
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
  docker rm -f momo-s3-verify-a momo-s3-verify-b momo-s3-verify-c >/dev/null 2>&1
  docker volume rm -f "$MOMO_S3_CRED_VOLUME" >/dev/null 2>&1
  [[ -n "$SABOTAGE" ]] && docker rmi -f momo-s3-verify-sab:local >/dev/null 2>&1
  [[ "$RM_IMAGE" == 1 ]] && docker rmi -f "$BASE_IMAGE" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || "$HERE/momo-s3-box.sh" build >/dev/null 2>&1 || { echo "build failed"; exit 1; }

if [[ "$SABOTAGE" == "image" ]]; then
  # Bake a credential file + marker into a derived image: layer checks must go RED.
  printf 'FROM %s\nUSER root\nRUN mkdir -p /home/box/.claude && echo %s > /home/box/.claude/.credentials.json\nUSER 10001:10001\n' "$BASE_IMAGE" "$MARKER" \
    | docker build -q -t momo-s3-verify-sab:local - >/dev/null
  IMAGE="momo-s3-verify-sab:local"; export MOMO_S3_IMAGE="$IMAGE"
fi

echo "== image under test: $IMAGE  marker: ${MARKER:0:18}... (sabotage: ${SABOTAGE:-none})"

# ---------------------------------------------------------------- 1. image layers (item 4)
echo "== 1. image layers / history"
SAVE="$WORK/save"; mkdir -p "$SAVE"
docker save "$IMAGE" | tar -x -C "$SAVE" 2>/dev/null
NAMES="$WORK/layer-names.txt"; : >"$NAMES"
MARKER_IN_LAYER=0
while IFS= read -r blob; do
  tar -tf "$blob" >>"$NAMES" 2>/dev/null || continue
  if tar -xOf "$blob" 2>/dev/null | grep -aq -- "$MARKER"; then MARKER_IN_LAYER=1; fi
done < <(find "$SAVE/blobs" -type f 2>/dev/null)
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
rm -rf "$SAVE"

# ---------------------------------------------------------------- 2. runtime hardening (item 1)
echo "== 2. runtime flags (real runner path, default log driver)"
"$HERE/momo-s3-box.sh" up >/dev/null 2>&1 || bad "runner 'up' failed"
A=momo-s3-verify-a
if [[ "$SABOTAGE" == "writable-root" || "$SABOTAGE" == "cap-add" ]]; then
  # Re-create A with a weakened template to prove the checks bite.
  docker rm -f "$A" >/dev/null 2>&1
  ARGS=(); while IFS= read -r _l; do ARGS+=("$_l"); done < <(box_run_args 0)
  FILTERED=()
  for a in "${ARGS[@]}"; do
    [[ "$SABOTAGE" == "writable-root" && "$a" == "--read-only" ]] && continue
    FILTERED+=("$a")
  done
  [[ "$SABOTAGE" == "cap-add" ]] && FILTERED+=(--cap-add NET_RAW)
  docker run -d --name "$A" "${FILTERED[@]}" "$IMAGE" sleep infinity >/dev/null
fi
insp() { docker inspect "$A" --format "$1"; }
check "ReadonlyRootfs=true" test "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = true
check "cap-drop ALL" bash -c 'docker inspect "$0" --format "{{json .HostConfig.CapDrop}}" | grep -q "\"ALL\""' "$A"
check "no cap-add" test "$(insp '{{json .HostConfig.CapAdd}}')" = null
check "no-new-privileges" bash -c 'docker inspect "$0" --format "{{json .HostConfig.SecurityOpt}}" | grep -q "no-new-privileges"' "$A"
check "not privileged" test "$(insp '{{.HostConfig.Privileged}}')" = false
check "no bind mounts / docker.sock" test -z "$(insp '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{end}}{{end}}')"
check "credential dir /cred is tmpfs mount" bash -c 'docker inspect "$0" --format "{{json .HostConfig.Tmpfs}}" | grep -q "\"/cred\""' "$A"
check "docker log driver is none (ADR-0197 D8)" test "$(insp '{{.HostConfig.LogConfig.Type}}')" = none
check "pids/memory limits set" bash -c '[ "$(docker inspect "$0" --format "{{.HostConfig.PidsLimit}}")" -gt 0 ] && [ "$(docker inspect "$0" --format "{{.HostConfig.Memory}}")" -gt 0 ]' "$A"
check "no secret-like env names in container" bash -c '! docker inspect "$0" --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -Eiq "^[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*="' "$A"
INSIDE() { docker exec "$A" sh -c "$1"; }
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
# Colima VM disk surfaces: container metadata dirs, writable layers, volumes
if command -v colima >/dev/null 2>&1 && colima status >/dev/null 2>&1; then
  IDA="$(docker inspect -f '{{.Id}}' "$A")"; IDB="$(docker inspect -f '{{.Id}}' "$B")"
  # container metadata + logs, recent containerd writable snapshots (containerd image store), our own volumes only
  VMSCAN='grep -rIl --binary-files=text -- "$1" /var/lib/docker/containers/$2 /var/lib/docker/containers/$3 /var/lib/docker/volumes/momo-s3-* 2>/dev/null; for d in $(find /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots -maxdepth 1 -mindepth 1 -mmin -30 2>/dev/null); do grep -rIl --binary-files=text -- "$1" "$d/fs" 2>/dev/null; done'
  VMHITS="$(colima ssh -- sudo sh -c "$VMSCAN" sh "$MARKER" "$IDA" "$IDB" 2>/dev/null)"
  check "marker not on VM disk (container dirs, writable layers, momo-s3 volumes)" test -z "$VMHITS"
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
if [[ -n "${VMSCAN:-}" ]]; then
  VMPOS="$(colima ssh -- sudo sh -c "$VMSCAN" sh "$MARKER" "$IDA" "$IDB" 2>/dev/null)"
  check "VM scan positive control: persist-mode volume (and only it) holds the marker on disk" bash -c 'test -n "$0" && ! grep -v "^/var/lib/docker/volumes/momo-s3-verify-cred/" <<<"$0" | grep -q .' "$VMPOS"
fi

# ---------------------------------------------------------------- result
echo "== final: marker absent from verifier output (sabotage 'log' prints it into container logs, not here)"
check "marker absent from verifier output" bash -c '! grep -aq -- "$0" "$1"' "$MARKER" "$OUT"
echo "== result: $FAILS failing check(s)"
[[ "$FAILS" == 0 ]]
