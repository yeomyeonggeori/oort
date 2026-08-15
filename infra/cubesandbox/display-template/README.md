# CubeSandbox display template — LIVE-1 / ADR-0165

The sandbox half of 관전 라이브 화면: what a CubeSandbox template must contain so
that a teammate can **watch** an agent work, and cannot type into it.

> **Status: `runtime-unverified(cubesandbox webrtc producer)`.**
> Nothing in this repository can build or boot a CubeSandbox template. Everything
> here is a *declared* contract, proved at the contract level by
> `scripts/display_signaling_probe.py` (two local peers, real WebSocket, with a
> red proof) and by `server-rust/bins/momo-server/tests/display_attach_conformance_pg.rs`
> (real Axum router, real PostgreSQL 18, real Ed25519 signatures). No claim on
> this page has been measured on a microVM. The three unmeasured items are named
> in `template.spec.json` under `unverified`, and the third of them is a live
> risk to the topology — see [Open: can a browser reach the sandbox at all?](#open-can-a-browser-reach-the-sandbox-at-all).

## The three files

| file | what it is |
|---|---|
| `template.spec.json` | the machine-readable contract. `scripts/verify_display_attach.sh` cross-reads it against the server's own constants, so a template that drifts from the server it registers with fails a gate instead of failing a person watching a black rectangle. |
| `momo-display-producer.service` | the unit the template bakes, beside `momo-workd`. |
| this file | why each of those says what it says. |

## The shape

```text
browser ──── wss (signalling, momo.display.v1) ────► sandbox producer
   │                                                       │
   │◄────────── WebRTC media, sendonly video ──────────────┘
   │
   └─ POST …/work-sessions/{s}/display-attach ──► oort   (capability, 60s)
                                                   ▲
      sandbox workd ── POST …/display-binding ──────┘     (host-signed)
      producer      ── POST …/display-attach/validate ────┘ (host-signed, every 30s)
```

oort appears three times and carries nothing in any of them. It mints a bearer,
it records which screen a host serves, and it answers "is this bearer still
good". The signalling WebSocket is the sandbox's; the media never touches a momo
process at all (ADR-0165 D2, D5).

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

This is a **structural** argument, not a measurement, and it is a declared
deviation from the packet's stated first preference. Swapping back is a one-field
change in `template.spec.json` plus the unit file: nothing in `server-rust` names
a producer, and nothing in the wire contract depends on which one runs.

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
   `{"type":"error","reason":"view_only"}` and the stream keeps running.

Layer 3 is the one that actually matters at runtime — layers 1 and 2 decide who
may watch, layer 3 decides what watching *is* — and it is the only one this
repository cannot execute. `scripts/display_signaling_probe.py` proves the
contract with two local peers, and `--prove-red` demonstrates that it catches a
producer which negotiates a datachannel anyway. That is a proof about the
*contract*, and it is not a proof about Selkies, `webrtcbin`, or any binary that
has actually encoded a frame.

## Open: can a browser reach the sandbox at all?

**Unmeasured, and the largest open risk in this axis.** ADR-0165 D2 puts the
browser in direct contact with the microVM, which requires an inbound path to a
process inside it. Two measured facts sit against that:

- **The adapter expresses no port exposure.** `create_body`
  (`server-rust/crates/momo-t3/src/provider/cubesandbox.rs`) sends `templateID`,
  `timeout`, `lifecycle`, `metadata` and `envVars`. There is no port map, no
  published address, and nothing in the `CloudInstanceRef` a provision returns
  that names a reachable host:port for the sandbox itself.
- **These VMs ship closed.** ADR-0157 증보 1 measured Cubelet's built-in eBPF
  `deny_out` refusing the sandbox's egress to every private range by default, and
  D1/D2 of that ADR are that the sandbox's only door is the public REST API.
  Nothing there contemplates an inbound door.

So the `display_endpoint` a workd would publish today has no defined way to
resolve to something a browser can dial. That is a **provisioning** question, not
a capability-plane one — the server axis this goal built is complete and correct
either way, because it hands out an endpoint the host chose — but LIVE-2 cannot
render anything until it is answered.

Three shapes it could take, none of them chosen here:

1. the dedicated host reverse-proxies `wss://<host>/display/<sandbox>/signal`
   into the microVM and media still goes peer-to-peer over ICE;
2. the same, but media is relayed too — which is an oort-operated TURN and
   therefore an ADR-0165 D3 증보;
3. per-sandbox public port exposure, which is a CubeSandbox capability this
   repository has not established exists.

Per ADR-0165 D3 and the LIVE-1 packet's freeze rule, this goal **stops here and
reports** rather than picking one.

## Template build notes

- `--with-cube-ca=false`. ADR-0157 증보 1 measured that the template build bakes
  the CubeEgress MITM root CA into the rootfs by default; a trust anchor for a
  component we do not use has no business in a sandbox.
- The X server, the desktop the agent's tools draw into, and the producer unit
  are the display-specific additions. Everything else is the ordinary workd
  template.
- `/etc/momo/workd.env` is already written by the provisioner (`workd_env_vars`
  in the adapter) and the producer reads the same file — the server origin and
  the host identity are the only two things it needs, and neither is a
  credential of the provider's (ADR-0004).
