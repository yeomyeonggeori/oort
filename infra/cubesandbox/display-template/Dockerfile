# oort live display template v3 — LIVE-1 / ADR-0165 + #1437 receiver + #1438 fix.
# Proven end to end on 2026-08-16 (#1438): an external browser rendered this
# producer's H264 screen over a TURN-relayed WebRTC stream.
#  * PID 1 is momo-bootstrap-init (the #1437 envVars receiver): lands the
#    create-time delivery, then execs entrypoint.sh (Xvfb -> producer). Without
#    it, any envVars create fails the whole create with 500 (130497) — the exact
#    state the real T3 adapter provisions in.
#  * iproute2 is installed because entrypoint.sh must add a routable ICE base to
#    the link-local-only guest eth0 (see entrypoint.sh / template.spec.json
#    network.iceBase) or webrtcbin cannot allocate a TURN relay.
#  * The producer (momo-display-producer) forces ice-transport-policy=relay and
#    wires the oort TURN from MOMO_DISPLAY_TURN_URI (delivered via envVars).
#
# LIVE-5c adds the input half, and three packages with it. Two are DEBIAN
# packages rather than pip installs, because the producer stays stdlib-plus-
# distro so that a gate never needs `pip install`:
#   * python3-xlib          XTEST injection. A frame becomes a real X event on
#                           the SAME server the capture pipeline reads, so the
#                           picture the person is watching is what confirms the
#                           delivery — there is no second input path that could
#                           succeed while the screen disagreed.
#   * python3-cryptography  Ed25519, to sign `display-attach/validate` as this
#                           work host. That route is mounted outside the bearer
#                           middleware on purpose: a bearer that reached the
#                           sandbox would be a bearer the sandbox could spend.
#   * xterm                 somewhere for a typed key to LAND. Without a focused
#                           text surface an input E2E proves only that an event
#                           was injected, not that it arrived; the evidence for
#                           LIVE-5c is a character on a screen.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        iproute2 \
        xvfb \
        x11-utils \
        x11-xserver-utils \
        x11-apps \
        python3 \
        python3-gi \
        python3-xlib \
        python3-cryptography \
        xterm \
        gir1.2-glib-2.0 \
        gir1.2-gstreamer-1.0 \
        gir1.2-gst-plugins-base-1.0 \
        gir1.2-gst-plugins-bad-1.0 \
        gstreamer1.0-tools \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly \
        gstreamer1.0-nice \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY momo-bootstrap-init /usr/local/bin/momo-bootstrap-init
COPY momo-display-producer /usr/local/bin/momo-display-producer
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/momo-bootstrap-init \
             /usr/local/bin/momo-display-producer \
             /usr/local/bin/entrypoint.sh

# The ports the producer binds INSIDE the microVM (template.spec.json network).
EXPOSE 8452
EXPOSE 50000-50100/udp

ENV MOMO_DISPLAY_X11=:0 \
    MOMO_DISPLAY_SIGNAL_PORT=8452 \
    MOMO_DISPLAY_MEDIA_UDP_RANGE=50000-50100 \
    MOMO_DISPLAY_CODEC=H264 \
    MOMO_DISPLAY_AUDIO=0 \
    MOMO_DISPLAY_INPUT=0 \
    MOMO_DISPLAY_SUBPROTOCOL=momo.display.v1 \
    MOMO_DISPLAY_REVALIDATE_SECONDS=30

# PID 1 = the #1437 receiver. It binds :49983, waits for the one create-time
# delivery, lands it (env -> the workload's environ; token -> a 0600 file), closes
# the listener, and execs the display entrypoint. Built WITHOUT --probe: the
# producer legitimately does not listen on :8452 until after the delivery arrives,
# and no delivery happens during a template build.
CMD ["/usr/local/bin/momo-bootstrap-init", "--", "/usr/local/bin/entrypoint.sh"]
