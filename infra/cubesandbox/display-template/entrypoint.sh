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

# LIVE-5c — the certificate the producer verifies momo-server's proxy against.
#
# Delivered as base64 because the envVars validator refuses control characters
# and a PEM is mostly newlines. It is a PUBLIC certificate, not a secret, so it
# travels as a value rather than through the 0600 file path the signing key
# takes; what matters is only that the producer verifies against SOMETHING it
# was told, instead of turning verification off (runbook §9 item 2 is a real
# certificate, and this is what stands in until then).
if [ -n "${MOMO_DISPLAY_SERVER_CA_PEM_B64:-}" ]; then
    mkdir -p /etc/momo
    if printf '%s' "$MOMO_DISPLAY_SERVER_CA_PEM_B64" | base64 -d > /etc/momo/server-ca.pem 2>/dev/null; then
        MOMO_DISPLAY_SERVER_CA_BUNDLE=/etc/momo/server-ca.pem
        export MOMO_DISPLAY_SERVER_CA_BUNDLE
        echo "[entrypoint] server CA bundle written (validate will verify TLS)"
    else
        echo "[entrypoint] WARNING: server CA is not valid base64 — validate over TLS will fail closed"
    fi
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

# LIVE-5c — somewhere for a typed key to land, and something that SHOWS it.
#
# The clock above proves the pipeline captures; it cannot prove an input arrived,
# because nothing about it changes when a key is pressed. A shell echoing typed
# characters is the difference between "an X event was injected" and "the person
# typed and saw it", which is the whole claim LIVE-5c has to make.
#
# There is no window manager in this rootfs, so X focus stays at its default
# PointerRoot — the window under the POINTER receives keys. Two things follow and
# both are handled here rather than discovered on a black screen: the terminal is
# sized to the whole screen so any pointer position is over it, and the focus is
# then set explicitly so a session that never moves the pointer still types
# somewhere.
if [ "${MOMO_DISPLAY_INPUT_SURFACE:-1}" = "1" ] && command -v xterm >/dev/null 2>&1; then
    DISPLAY="$X11" xterm -geometry 150x40+0+120 -fa Monospace -fs 12 \
        -bg "#0b1b2b" -fg "#e6edf3" -title momo-input-surface >/dev/null 2>&1 &
    # Wait for the window to exist before focusing it — a focus call against a
    # window that has not mapped yet silently does nothing.
    i=0
    while [ $i -lt 50 ]; do
        if DISPLAY="$X11" python3 - <<'PYFOCUS' 2>/dev/null
import sys
from Xlib import display as xd, X
d = xd.Display()
root = d.screen().root
kids = root.query_tree().children
for w in kids:
    try:
        name = w.get_wm_name()
    except Exception:
        name = None
    if name and "momo-input-surface" in name:
        w.set_input_focus(X.RevertToParent, X.CurrentTime)
        d.sync()
        sys.exit(0)
sys.exit(1)
PYFOCUS
        then
            echo "[entrypoint] input surface up (xterm) and focused"
            break
        fi
        i=$((i + 1))
        sleep 0.1
    done
    if [ $i -ge 50 ]; then
        echo "[entrypoint] WARNING: input surface did not focus; keys follow the pointer"
    fi
fi

exec /usr/local/bin/momo-display-producer
