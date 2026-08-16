#!/bin/sh
# Template entrypoint. CubeSandbox `create-from-image` runs the image CMD as PID1
# (there is no envd and no systemd in this rootfs), so the unit file's ordering
# — X first, producer second — is expressed here instead.
set -e

# #1438 fix — routable ICE base. A CubeSandbox microVM's guest eth0 carries ONLY
# link-local addresses (IPv4 169.254.68.6/30, IPv6 fe80::). libnice (webrtcbin's
# ICE stack) refuses to run STUN/TURN candidate discovery from a link-local base
# — measured: it registers the TURN yet reports "Candidate gathering FINISHED, no
# scheduled items", so the producer emits ZERO candidates and cannot allocate a
# relay even though the TURN works and the microVM can reach it. Adding any
# routable RFC1918 address gives ICE a non-link-local base; the CubeNet gateway
# MASQUERADEs it out the host's public IP and returns the reply (measured #1438:
# coturn then logs the microVM's ALLOCATE as success and a `typ relay` candidate
# is offered). The address is never used for its own sake.
MOMO_ICE_BASE="${MOMO_ICE_BASE:-10.99.0.2/24}"
if command -v ip >/dev/null 2>&1; then
    ip addr add "$MOMO_ICE_BASE" dev eth0 2>/dev/null \
        && echo "[entrypoint] ICE base $MOMO_ICE_BASE added to eth0 (#1438)" \
        || echo "[entrypoint] ICE base add skipped (already present or no perm)"
else
    echo "[entrypoint] WARNING: iproute2 absent — cannot add ICE base; relay will fail"
fi

X11="${MOMO_DISPLAY_X11:-:0}"
GEOM="${MOMO_DISPLAY_GEOMETRY:-1280x720x24}"

Xvfb "$X11" -screen 0 "$GEOM" -nolisten tcp -noreset >/var/log/xvfb.log 2>&1 &
XPID=$!

# Wait for the X socket rather than sleeping blind.
i=0
while [ $i -lt 50 ]; do
    if DISPLAY="$X11" xdpyinfo >/dev/null 2>&1; then break; fi
    i=$((i + 1))
    sleep 0.1
done
if ! DISPLAY="$X11" xdpyinfo >/dev/null 2>&1; then
    echo "[entrypoint] FATAL: X server did not come up on $X11" >&2
    exit 1
fi
echo "[entrypoint] X up on $X11 ($GEOM), pid=$XPID"

# Something for the screen to actually contain, so a captured frame is evidence
# of capture rather than evidence of a black rectangle.
if [ "${MOMO_DISPLAY_TESTPATTERN:-1}" = "1" ] && command -v xclock >/dev/null 2>&1; then
    DISPLAY="$X11" xsetroot -solid "#1d3a5f" 2>/dev/null || true
    DISPLAY="$X11" xclock -digital -update 1 -geometry 400x100+40+40 >/dev/null 2>&1 &
    echo "[entrypoint] test pattern up (xclock)"
fi

exec /usr/local/bin/momo-display-producer
