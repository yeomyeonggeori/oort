# CubeSandbox display template — LIVE-1 / ADR-0165

The sandbox half of 관전 라이브 화면: what a CubeSandbox template must contain so
that a teammate can **watch** an agent work, and cannot type into it.

> **Status: `runtime-verified(cubesandbox webrtc producer)` — media reachability
> proven end to end on 2026-08-16 (#1438).** A real microVM producer's H264 screen
> reached an external browser (a Mac on the public internet) over a WebRTC media
> stream relayed through the oort TURN (`momo-turn`), relay↔relay, at 1280x720.
> `template.spec.json` records the measurement under `runtimeVerified`, and
> `scripts/verify_display_attach.sh` cross-reads the contract against the server's
> own constants. What is **still** unverified is *input delivery* (LIVE-3 control
> reaching a screen) — named in `template.spec.json` under `unverified`. The
> earlier open risk, "can a browser reach the sandbox at all", is **resolved** —
> see [How a browser reaches the sandbox](#how-a-browser-reaches-the-sandbox).

## The files

The template is built by `cubemastercli tpl create-from-image` from an OCI image
(there is no systemd and no envd in this rootfs), so the pieces are a Dockerfile
and the two programs it bakes, not a systemd unit.

| file | what it is |
|---|---|
| `template.spec.json` | the machine-readable contract (specVersion 3 — what was MEASURED on the dedicated host, not merely declared). `scripts/verify_display_attach.sh` cross-reads it against the server's own constants, so a template that drifts from the server it registers with fails a gate instead of failing a person watching a black rectangle. |
| `Dockerfile` | the OCI image `create-from-image` builds the template from. PID 1 is `momo-bootstrap-init` (the #1437 envVars receiver, from [`../bootstrap-init/`](../bootstrap-init/README.md)); it lands the create-time delivery and execs the entrypoint. `iproute2` is in the rootfs so the entrypoint can add the routable ICE base. |
| `entrypoint.sh` | the ordering a systemd unit would have expressed: add the ICE base to `eth0`, start Xvfb, wait on the X socket, then exec the producer. |
| `momo-display-producer` | the GStreamer `webrtcbin` producer. Captures X11, encodes H264, forces `ice-transport-policy=relay`, wires the oort TURN from `MOMO_DISPLAY_TURN_URI`, and never logs the credential. |
| this file | why each of those says what it says. |

## The shape

```text
browser ── wss (signalling, momo.display.v1) ──► host proxy ──► sandbox producer
   │                                                                  │
   │◄──── WebRTC media, sendonly video, relayed via oort TURN ────────┘
   │
   └─ POST …/work-sessions/{s}/display-attach ──► oort   (capability, 60s)
                                                   ▲
      sandbox workd ── POST …/display-binding ──────┘     (host-signed)
      producer      ── POST …/display-attach/validate ────┘ (host-signed, every 30s)
```

oort appears three times and carries nothing in any of them. It mints a bearer,
it records which screen a host serves, and it answers "is this bearer still
good". The signalling WebSocket is the sandbox's (reached through the host's
reverse proxy); the media never touches a momo process at all (ADR-0165 D2, D5) —
it is relayed through the **oort-operated** TURN, never a third party (ADR-0165
D3 / 증보 1 / 증보 2).

## Why the producer is `webrtcbin` and not Selkies

ADR-0165 D1 names Selkies-GStreamer first, with `webrtcbin` as the alternative.
This template declares the alternative, and the argument is **D4, not
performance**:

- D4 requires view-only to be the **absence** of an input datachannel, not a
  flag beside one. Selkies exists to deliver a *controllable* desktop; its input
  datachannel is the product. View-only there means configuring a component
  built to provide exactly the thing we are refusing, and a configuration is
  something a later change can flip back without anyone noticing. `webrtcbin`
  has no input path unless one is written, so the guarantee is the default.
- Selkies ships as a container image bundling an X session, a desktop
  environment and a Python signalling server aimed at container/Kubernetes
  deployment. A CubeSandbox template is built from a rootfs. ADR-0165's own
  Consequences already record that "Selkies는 컨테이너 중심" is the thin-precedent
  risk of this goal.

This was a **structural** argument, and #1438 has now also **measured** the
producerSelection question it flagged: `webrtcbin` encodes H264 acceptably inside
a GPU-less microVM and an external browser decoded 56 frames at 1280x720.
Swapping back is still a one-field change in `template.spec.json` plus the
Dockerfile: nothing in `server-rust` names a producer, and nothing in the wire
contract depends on which one runs.

## View-only, three times over

The guarantee is stated in three independent places so that losing one does not
lose the property:

1. **The schema.** `075_display_attach.sql`'s
   `terminal_attach_display_observer_ck` makes a `kind='display'` capability with
   `mode='controller'` unrepresentable. The conformance suite proves it by trying
   the INSERT as superuser and requiring the failure.
2. **The server.** `POST …/display-attach` answers a `controller` request with
   403 by name, and `momo_t3::AttachKind::permits_mode` refuses it again inside
   the validation path.
3. **The producer.** Its SDP offer contains no `m=application` section, so there
   is no datachannel to negotiate. A viewer that sends `open_input` gets
   `{"type":"error","reason":"view_only"}` and the stream keeps running. #1438
   measured this on the wire: the real producer's OFFER carried `m=video
   a=sendonly` and **no** `m=application`.

Layers 1 and 2 decide who may watch, layer 3 decides what watching *is*.
`scripts/display_signaling_probe.py` proves the contract with two local peers,
and `--prove-red` demonstrates that it catches a producer which negotiates a
datachannel anyway.

## How a browser reaches the sandbox

**Measured (#1438), no longer open.** ADR-0165 증보 1 established (SPIKE #1411)
that a CubeSandbox microVM sits behind a symmetric NAT with no host/srflx path,
so **relay is the only ICE path**, the TURN must be a **separate dedicated
public host** (`momo-turn`, never co-located with the sandbox host), and the
browser reaches the signalling WebSocket through the **host's reverse proxy**
(형상 A — client-IP preserving). #1438 then drove that path end to end and found
one more requirement that TURN alone did not satisfy:

- **A routable ICE base is mandatory.** The guest `eth0` carries **only**
  link-local addresses (IPv4 `169.254.68.6/30`, IPv6 `fe80::`). libnice
  (webrtcbin's ICE stack) *registers* the TURN but schedules **no** STUN/TURN
  candidate discovery from a link-local base — measured `Candidate gathering
  FINISHED, no scheduled items` — so the producer emits **zero** candidates and
  cannot allocate a relay, even though the TURN works and the microVM can reach
  it. The fix, measured to work: `entrypoint.sh` adds a routable RFC1918 address
  (`10.99.0.2/24`, `MOMO_ICE_BASE`) to `eth0` **before** the producer starts.
  libnice then uses it as a base, allocates the relay, and the CubeNet gateway
  MASQUERADEs the flow out the host's public IP. This is the reason `iproute2`
  is in the rootfs and the reason `network.iceBase` is a `required` field. It is
  specific to the microVM's link-local-only posture — the identical producer
  needed no such fix in a container that already had an RFC1918 address.

The evidence: coturn logged `ALLOCATE` + `CHANNEL_BIND` success from **both** the
producer (via host egress `101.79.18.230`) and the browser (`39.115.69.188`),
over TURN transport `udp` **and** `tcp`; the negotiated media candidate pair was
relay↔relay. This is an **ADR-0165 증보 2** matter (`ice.requiresAdrAmendment`) —
TURN moved from "introduce only if measured necessary" to REQUIRED, and the
routable ICE base is a new template obligation. That 증보 is **Proposed —
성재 결재 대기**.

## Template build notes

- **PID 1 is the #1437 receiver, and the build carries no `--probe`.** The
  adapter's `workd_env_vars` (server origin, host identity, and the TURN URI) are
  *delivered* by Cubelet to `:49983/init` inside the create call, not injected as
  process env; `momo-bootstrap-init` ([`../bootstrap-init/`](../bootstrap-init/README.md))
  is what lands them and then execs `entrypoint.sh`. A display template without
  the receiver — or built **with** `--probe` — fails *every* `envVars` create with
  `500 … 130497`, because the producer legitimately does not listen on `:8452`
  until the delivery arrives and no delivery happens during a template build
  (ADR-0156 증보 4).
- `--with-cube-ca=false`. ADR-0157 증보 1 measured that the template build bakes
  the CubeEgress MITM root CA into the rootfs by default; a trust anchor for a
  component we do not use has no business in a sandbox.
- The X server, the desktop the agent's tools draw into, `iproute2` (for the ICE
  base), and the producer are the display-specific additions. Everything else is
  the ordinary workd template.
- The producer reads the server origin and the host identity from its delivered
  environment — neither is a credential of the provider's (ADR-0004). The TURN
  credential arrives the same way (`MOMO_DISPLAY_TURN_URI`) and is a static
  long-term cred for the E2E; LIVE-5 replaces it with per-session ephemeral
  creds. `turn://` URIs carry a credential, so the producer never logs them.
