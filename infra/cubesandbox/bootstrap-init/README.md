# `momo-bootstrap-init` — how workd bootstrap material gets into a CubeSandbox microVM

The T3 adapter puts the workd bootstrap material in `envVars` on
`POST /sandboxes`. **CubeSandbox does not put that material in the guest's
process environment.** It delivers it over the network, and the guest has to be
listening. This directory is the guest half of that contract.

> Measured on **momo-cube-host** (CubeSandbox v0.6.0) on 2026-08-16 for #1437.
> Every claim below is a measurement, not a reading of upstream docs. The host's
> addresses live in `docs/runbooks/cubesandbox-host-install.md`, not here.

## The wire contract

Still inside the create call, Cubelet sends the guest exactly this:

```http
POST http://<SANDBOX_IP>:49983/init HTTP/1.1
Host: <SANDBOX_IP>:49983
Content-Type: application/json
User-Agent: Go-http-client/1.1

{"envVars":{"MOMO_WORKD_SERVER_URL":"…","MOMO_WORKD_REGISTRATION_TOKEN":"…", …}}
```

and requires a **2xx**. That is the whole protocol — one JSON POST, no
authentication, no handshake, no envd framing.

Three properties follow, and all three are measured:

| Property | Measurement |
|---|---|
| **Delivery happens before `create` returns.** | The receiver had recorded the POST by the time `POST /sandboxes` answered `201` (0.21–0.25 s end to end). |
| **`create 201` is a receipt.** | A receiver that answers `500` makes the whole create fail — `500 … 130497: create_time_env_vars init failed after bounded retry … envd init request returned HTTP 500` — and **no sandbox is left behind** (`GET /sandboxes?metadata=…` → `[]`). There is no partial provisioning to reconcile. |
| **Resume does not re-deliver.** | `pause` → `connect` on a delivered sandbox produced **no second POST**, and the sandbox keeps its IP. A one-shot listener is therefore safe across the lease's whole life. |

Answer nothing at all and create fails the same way, with
`… envd init request failed: Post "http://…:49983/init": connect: connection refused`.
That is the failure INFRA-A hit (#1434) and the reason this file exists.

## Why not any of the other channels

Each was measured on the host and each is closed:

- **`metadata` → guest.** Nothing on the create body's `metadata` reaches the
  guest. A probe template dumped PID 1's `environ`, `/proc/cmdline`,
  `/sys/class/dmi/id/*`, `/proc/mounts`, `/dev`, `/run`, `/mnt`, `/media` and
  `/etc` and found **no metadata surface of any kind** — no config drive, no
  virtio port, no `169.254.169.254` (connection refused). The guest cannot even
  learn its own sandbox ID: `hostname` is the *template* id prefix
  (`tpl-1c22`) and every sandbox gets the same link-local `169.254.68.6/30`.
  The same measurement is the good news for ADR-0157: a sandbox cannot read
  **anybody's** metadata, its own included.
- **Template-baked `--env`.** Reaches PID 1 (confirmed), but a template is built
  once and a registration token is per provision. Useful for static configuration
  only.
- **Upstream envd.** The daemon that would normally answer `/init` is **not
  shipped** with CubeSandbox v0.6.0 (no binary anywhere on the host;
  `cubemastercli tpl create-from-image` has no flag to request it; the
  `cube.master.components.envd.version` annotation is Cubelet-internal). Adopting
  e2b's envd would import an exec + filesystem-write plane into the sandbox,
  which is the plane ADR-0157 exists to keep shut.
- **Volumes.** `volumeMounts` is a real create-body field, but the volume driver
  on this host is COS-backed and there is no API that writes *content* into a
  volume, so a control plane cannot stage a credential in one.
- **Post-create push over CubeProxy.** `/sandbox/<id>/<port>/` does work, but it
  needs a second endpoint, it is unauthenticated, and it would leave a window in
  which a running sandbox has no credentials. The substrate's own synchronous
  delivery has none of those properties.

## What `momo-bootstrap-init` does

It is PID 1 in a momo template. It binds `:49983`, waits for the one delivery,
lands it, closes the listener, and `exec`s the real workload:

```dockerfile
COPY momo-bootstrap-init /usr/local/bin/momo-bootstrap-init
CMD ["/usr/local/bin/momo-bootstrap-init","--","/usr/local/bin/momo-workd-run"]
```

- **One shot.** After the first accepted delivery the socket is closed and never
  reopened. Measured: a second `POST /init` gets `connection refused`, before and
  after a pause/resume cycle. `do_POST` refuses a second delivery `409` as well,
  which is normally unreachable — every answer is `Connection: close` — and
  exists so the invariant does not *depend* on that: a keep-alive answer, or a
  client that pipelines two requests into one segment, would otherwise re-run
  `land()` and rewrite the token file with material the substrate's receipt never
  covered.
- **The wait is bounded, connected or not.** `--timeout` is enforced both between
  connections and *during* one: an accepted socket gets a read deadline, clamped
  to whatever is left of the program's own. Without it a peer that opens a
  connection and never finishes its request line parks PID 1 in `readline()`
  forever, since `HTTPServer.timeout` only bounds the wait for the next
  `accept()`. The receiver has to fail closed on time for the same reason it
  answers `500` on a write failure: a template that hangs is a template whose
  create never resolves.
- **The token never enters a process environment.**
  `MOMO_WORKD_REGISTRATION_TOKEN` is written to `/etc/momo/registration.token`
  (mode 0600) and replaced by `MOMO_WORKD_REGISTRATION_TOKEN_FILE` in both
  `/etc/momo/workd.env` (mode 0600) and the workload's environment — the form
  `infra/workd/bootstrap.sh` already prefers, for the reason ADR-0144 gives:
  `/proc/<pid>/environ` is readable by anything else in the sandbox and a 0600
  file consumed once is not. Verified in the guest: the workload's environ
  carries the `_FILE` name and not the token. The *inherited* copy is popped too:
  template-baked `--env` does reach PID 1, so a template built with
  `MOMO_WORKD_REGISTRATION_TOKEN` in it would otherwise smuggle a stale token
  into the workload that the delivery never touched. Measured on momo-cube-host
  both ways — a template baked with that name, booted with a delivery
  carrying a different token gave the workload
  `MOMO_WORKD_REGISTRATION_TOKEN=<the baked one>` before the pop and nothing but
  `…_TOKEN_FILE` after it, with `/proc/1/environ` agreeing in both runs.
- **Names are re-validated.** CubeAPI screens env names upstream; this screens
  them again (shell-identifier shape, length bounds, no control characters, and a
  refusal list covering `LD_PRELOAD`, `PYTHONPATH`, `PATH` and friends). A check
  performed only on the far side of a trust boundary is worth nothing.
- **A write failure is answered `500`, not `200`.** Telling the substrate the
  material landed when it did not would turn `create 201` from a receipt into a
  lie.

## How these claims stay true

`test_bootstrap_init.py` (stdlib only, `scripts/local_gate.sh` static lane) runs
the receiver as a real process, speaks HTTP to it over a loopback socket, and
reads the files and the exec'd environment it leaves behind. Every bullet above
has a case: the 0600 landing and the `_FILE` swap, four malformed bodies refused
`400` with the one shot unspent, a write failure answered `500`, the port gone at
TCP after the delivery, a held-open connection failing closed at `--timeout`, a
pipelined second POST that never re-runs `land()`, and a template-baked token
that does not survive into the workload.

`--prove-red` re-runs four of them against deliberately broken copies (a blocking
accepted socket, a keep-alive answer, a keep-alive answer with the one-delivery
guard removed, an inherited token left in place) and requires each to fail. Each
mutation asserts its anchor text was found, so a refactor that moves the code
breaks the proof loudly rather than passing on nothing.

The host half of the same contract is
`server-rust/crates/momo-t3/tests/cubesandbox_conformance.rs`. It models this
program's conversion (token → file, `…_TOKEN_FILE` in its place) so a name added
to the adapter's delivery shows up there as a guest variable nobody taught this
program to land — but it *models* it; the measuring is done here.

## Template build rules that follow

- **Do not pass `--probe`** to `cubemastercli tpl create-from-image` for a
  template that carries this receiver. The workload legitimately does not listen
  until the substrate delivers, and no delivery happens during a template build,
  so a readiness probe fails the build. Measured both ways: the probe-less build
  of this template succeeded in 20 s; an earlier probe-carrying build of a
  template whose port came up late failed with
  `template creation failed: Get "http://…:9000/health": connection refused`.
- **Always create with `envVars`.** A momo sandbox created without them gets no
  delivery, and this receiver exits non-zero at its timeout rather than running a
  workload with no identity. The adapter always sends them
  ([`workd_env_vars`](../../../server-rust/crates/momo-t3/src/provider/cubesandbox.rs)),
  so this is a statement about hand-run sandboxes.
- `--with-cube-ca=false` still applies (ADR-0157 증보 1).

## Reproducing the reference template

`momo-bootstrapd2` (`tpl-dcbf0c5ccaaf4515afc3e3bd`) on momo-cube-host is the
minimal template this receiver was proven against, and the one the live half of
`server-rust/crates/momo-t3/tests/cubesandbox_conformance.rs` expects in
`MOMO_T3_CUBESANDBOX_LIVE_TEMPLATE`.

> **A template is a snapshot of this file, not a link to it.** `momo-bootstrapd`
> — the alias without the `2` — still carries the pre-repair receiver, so it
> proves the delivery contract and *not* the invariants added since. Change this
> file and the live arm means nothing until the template is rebuilt; that is why
> the alias moved rather than the image being quietly replaced underneath it.

It is not a shipping template — it exists so
the contract can be exercised without a real workd:

```dockerfile
FROM python:3.12-alpine
COPY momo-bootstrap-init /usr/local/bin/momo-bootstrap-init
RUN chmod 0755 /usr/local/bin/momo-bootstrap-init
EXPOSE 9000
CMD ["/usr/local/bin/momo-bootstrap-init","--","<the workload>"]
```

```sh
docker build -t 127.0.0.1:5000/momo-bootstrapd:v2 . && docker push 127.0.0.1:5000/momo-bootstrapd:v2
cubemastercli tpl create-from-image \
  --image 127.0.0.1:5000/momo-bootstrapd:v2 --alias momo-bootstrapd2 \
  --writable-layer-size 2Gi --expose-port 9000 --memory 1024 --cpu 1000 \
  --with-cube-ca=false          # and deliberately no --probe
```

The receiver-less counterpart the same test uses for
`MOMO_T3_CUBESANDBOX_LIVE_TEMPLATE_WITHOUT_INIT` is just `momo-smoke` — any
template built without this file will do, which is the point.

## Boundary note (ADR-0157)

Port 49983 is a **new listening port inside the guest**, so it needs a boundary
statement rather than a shrug. Measured from inside a peer sandbox, all of these
are `errno=111 connection refused`: the peer's `49983`, the peer's exposed port,
the host's CubeAPI (`:3000` on its private address), and the host's CubeProxy
(`:80` and `:443`). The host's public IP answers `timeout` on 80/443 (firewalld) and
`CONNECTED` only on 8443, which is our own display proxy and does not route to
49983.

One thing does reach it: **CubeProxy routes `/sandbox/<sandboxID>/49983/`
unauthenticated** (`request_host.lua` exempts the envd port by name), and it
listens on `0.0.0.0:80` and `0.0.0.0:443`. So *the host's 80/443 staying closed to
the internet is a security control, not housekeeping* — the F1 firewalld ruleset
in `docs/runbooks/cubesandbox-host-install.md` is what stands between the
internet and every sandbox's control port. The one-shot listener is the second
layer: by the time any sandbox ID is knowable outside the substrate, the create
call has already returned and the port is shut.
