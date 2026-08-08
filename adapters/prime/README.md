# oort — prime agent adapter (`PrimeAdapter`)

Relays one containerised `prime-agent --mode rpc` session into one oort channel.
This is ADR-0158 **D6**: the spike adapter (`scripts/spikes/prime-agent/`, which
stays where it is as the measurement record) promoted into a resident surface, in
the shape `adapters/hermes` established.

prime is the third agent provider, and the reason to carry a third one is
concrete: `steer` and `extension_ui_request` are surfaces neither hermes nor
codex has, and both were shown working on a single-write-path closed loop
(#1128 판정). What promotion had to add is everything the spike wrote down as a
gap.

| Spike gap | Closed by |
|---|---|
| one streamed answer = 17 REST writes = 17 channel messages | one growing message: opening `POST` + `PATCH` slices (#1152 / #1173) |
| a stopped answer looked like a finished one | `outcome: "cancelled" \| "failed"` on the closing slice (ADR-0155) |
| retries duplicated (`clientMsgId` minted per write) | one stable key per logical write; a replay lands on the row that exists |
| harness self-modification was invisible | `refine_complete` **and** file observation, both announced (ADR-0158 D1~D4) |
| one container serving two workspaces leaked harness memory | per-workspace `HOME` + `TMPDIR`, fail-closed (#1130 ③) |

## Files

| File | Purpose |
|---|---|
| `adapter.py` | entrypoint: env in, one relayed session out. The only reader of `os.environ`. |
| `prime_adapter.py` | `PrimeAdapter` — the RPC event map, stream ownership, endings. |
| `oort_client.py` | the single write path: `POST .../messages`, `PATCH .../messages/{id}`. Nothing else can reach oort. |
| `stream_relay.py` | delta buffering plus the slice arithmetic for one assistant message. |
| `refine.py` | harness observation and the refinement announcement. |
| `rpc.py` | `prime-agent --mode rpc` JSONL transport. |
| `adapter.yaml` | the env contract, declared. |
| `container/Dockerfile` | the pinned image (prime-agent v0.7.0, SHA-256 verified, kernel prewarmed). |
| `container/entrypoint.sh` | the isolation boundary: per-workspace `HOME` + `TMPDIR`. |
| `run.sh` | host-side launcher: build, session, tenancy proofs. |
| `tests/` | closed-loop smoke, contract tests, red proofs, the loopback mock provider. |

## Write path

```
prime-agent stdout JSONL ─► PrimeAdapter ─► StreamRelay ─► OortClient ─► REST
                                                                          │
                                                            PG commit ─► outbox ─► relay ─► Centrifugo
```

The adapter never publishes to Centrifugo and never touches Postgres. `seq` is
whatever the server returns; the adapter has no opinion about ordering. Measured
on a local stack: every adapter write produced its `outbox` row and the relay
drained all of them (`broadcast` 112/112 `done`). A bypass would have produced
none, which is why the outbox count is the evidence and the message count is not.

## Streaming: one answer, one message

```
POST   {"clientMsgId": …, "body": "답이 자", "stream": {"rev": 0, "streaming": true}}
PATCH  {"body": "답이 자라고",       "stream": {"rev": 1, "final": false}}
PATCH  {"body": "답이 자라고 있습니다", "stream": {"rev": 2, "final": true}}
```

* `rev` is the writer's own counter, strictly increasing, starting at 1 for the
  first slice. A not-newer `rev` is a **no-op** on the server, which is what
  makes a late retry harmless and also what makes a reused `rev` freeze the
  answer silently — so the counter lives in exactly one place.
* `body` is always the whole text so far. A slice replaces; it does not append.
* A slice never stamps `editedAtMs`. An answer arriving is not a person revising
  what they said (#1152).
* **A short answer is one plain `POST`.** Most replies fit inside one buffer and
  never grow, and marking those as a stream only to close them immediately would
  describe a history that did not happen. A short answer that *stopped* still
  opens and closes, because `cancelled`/`failed` is only expressible on a
  closing slice.

Measured against a local Rust stack: 525 `message_update` events became 1 opening
POST + 23 slices, one message, `edited = false`, authored by the agent member and
bound to its run on both the `run_id` column and `props.run_id`. The whole run
used the **agent bearer**, which is what makes it the adapter's real credential
rather than a demonstration.

## Endings

| What happened | How the channel is told |
|---|---|
| the answer finished | final slice, no `outcome` |
| a human pressed stop | `abort` to the harness, then final slice `outcome: "cancelled"` |
| the harness reported `error` / `reason: "aborted"` | same, from the harness's side |
| the harness died mid-answer | final slice `outcome: "failed"` |
| **this adapter** died mid-answer | nothing the adapter can write — this is what `runId` is for |

That last row is the argument for ADR-0158 D5, and it was reproduced by accident
during development: a crash between the opening POST and the first slice left a
row reading `{"rev": 0, "streaming": true}` with nothing that could ever close
it. With a run bound to the opening write, `open_stream_message_for_run_in_tx`
finds exactly that row and marks it. The adapter therefore sends `runId` whenever
one is configured, and surfaces a refusal rather than dropping the binding — a
dropped binding is a stream nothing can close, wearing a finished answer's
clothes.

## Self-modification (ADR-0158 D1~D4)

Two paths reach `harness_state.json` and they have different visibility:

1. `refine_complete` on stdout — real, undocumented, and absent from the shipped
   RPC types. The adapter knows the name by hand, and re-measuring that it still
   exists is part of the version pin.
2. `rlm.harness` inside the kernel — the same file, **zero** protocol output
   (6 runs x 37 events, `refine_complete` = 0). Only the file knows.

Both become one quiet `system` line. The second says `trigger: "observed-drift"`,
which claims only what we saw.

```json
{
  "clientMsgId": "<uuid5(b\"momo.harnessRefi\", refinementId)>",
  "type": "system",
  "body": "김인턴이 자기 작업 방식을 갱신했습니다 (항목 1건)",
  "props": { "harness": "prime-agent" },
  "harnessRefine": {
    "refinementId": "refine_20260808132649962",
    "trigger": "command",
    "scope": "workspace",
    "edits": [{ "action": "create", "kind": "memory", "id": "oort-refine-probe" }],
    "summary": "기억 1건 추가"
  }
}
```

* **A top-level block, not a props key.** v0 props are a flat `string -> string`
  map, while the stored value is a structured object under a `momo.`-namespaced
  key the server must be the sole author of — a key a client could spell by hand
  is one a client could forge a server-vouched claim under. The server writes
  `props["momo.harnessRefine"]` from the validated block.
* **ids and kinds only, never text.** `_wire_edits` drops
  `before`/`after`/`content` at the source, and the server's
  `deny_unknown_fields` refuses them if it ever stopped. Two locks, one door.
* **`scope` is always `workspace`**, and the server writes its own constant
  rather than copying ours. The harness calls a cross-session write "global",
  but this adapter runs one workspace per `HOME`, so its global *is* our
  workspace.
* **`summary` travels, bounded** (500 chars, server-enforced). It is the
  harness's one-line description of what it changed, which is the least-leaky
  useful thing a reader can be given; the entries themselves stay on the host.
* **`rollbackId` travels** (D3): recorded on the row for an operator asking "can
  this be undone", with no channel affordance promised.

### Idempotency, and the one place the ADR's letter had to bend

D4 says `clientMsgId = RefinementResult.id`. The *property* is preserved exactly:
the harness's own stable name for a refinement decides the message, so a restart
that forgot what it announced lands on the row that exists. The literal value
cannot be used — `clientMsgId` is a `Uuid` on the server, and posting
`refine_20260808132649962` answers **422** (`UUID parsing failed`, measured
before the server side landed). Both sides therefore derive
`uuid5(b"momo.harnessRefi", refinementId)`, and the server **refuses** an
announcement carrying any other key rather than rewriting it silently — a
rewritten idempotency key is one the caller cannot retry with. That derivation is
one function implemented twice, once per side, and `harness_refine_client_msg_id`
here must stay byte-identical to `momo_messaging`'s.

An observed drift has no harness-assigned id, so this adapter mints one that is
still a pure function of what it saw: `drift_<sha256 of the state file>`. The
same state names the same announcement.

## Isolation: the container is the boundary

prime-agent is **not a sandbox**. It runs shell commands and a persistent IPython
kernel with the privileges of whoever launched it, so a host install is not an
option and `container/entrypoint.sh` draws the line inside the container:

```
HOME   = /work/homes/<workspace>    agent dir, sessions, auth.json, models.json, dotfiles
TMPDIR = /work/tmp/<workspace>      daemon socket dir
```

`HOME` rather than `PRIME_AGENT_CODING_AGENT_DIR`, because the agent dir is not
the only tenant surface under `$HOME`. `TMPDIR` as well, because the daemon
socket dir is keyed by **uid**, not `HOME` — with `HOME` alone two workspaces
meet in one `/tmp/prime-agent-0` and share a control plane.

The kernel venv and the vendored `bin/` (rg, fd) **are** shared, on purpose: they
are package installs holding no tenant data, and rebuilding them offline costs
80.3s and eight dead bundled skills.

Both directions are proved, against this adapter's own entrypoint:

```sh
adapters/prime/run.sh tenancy-leak   # isolation off  -> ws-b reads ws-a's memory  (MATCH)
adapters/prime/run.sh tenancy        # isolation full -> it does not               (MATCH)
```

Each exits non-zero when reality and expectation disagree, so the red proof fails
loudly the day upstream fixes the leak, and the green one fails loudly the day
our isolation stops working. Reduced isolation refuses to start without
`OORT_PRIME_ALLOW_UNSAFE_ISOLATION=1`.

## Which credential

The adapter needs a bearer that can reach **both** message routes, and it is the
agent's own: an agent is a `member`, and an adapter writing as anyone else would
put a person's name on the agent's answer.

That was not possible until ADR-0158 증보 1 (D7). Measured on a local stack with a
real `agent_bearer` row scoped `messages:write`, before D7:

```
POST  /v1/workspaces/{ws}/channels/{ch}/messages   -> 201   (stream opened)
PATCH /v1/workspaces/{ws}/messages/{id}            -> 403   agent bearer is not allowed for this route
```

`momo_auth::required_agent_scope` listed `POST …/channels/{ch}/messages` and no
`PATCH`, so every slice was refused — and the combination is worse than a plain
refusal, because the stream *opens* and can then never be closed, leaving a
message marked `streaming` forever. D7 adds the slice route to the allow-list,
author-only, which is what makes the agent bearer the whole adapter's credential
rather than half of one.

Either way the adapter surfaces a 403 with its reason instead of swallowing it: a
scope refusal that looks like a network fault is one an operator debugs for an
hour.

## Approval decisions

`extension_ui_request` becomes an `approval_request` message with the dialog's
options in props, exactly as the spike measured. What the adapter does **not**
have is a way to read a human's answer back: an agent credential reaches no read
surface, so v0's `OORT_PRIME_UI_POLICY` defaults to `none` — the card is posted,
the dialog is left for the harness's own timeout, and no decision is invented.
`approve`/`deny`/`cancel` exist for tests and for an operator who has decided in
advance. Wiring a real decision back is a separate contract.

## Run it

```sh
adapters/prime/run.sh build

export OORT_PRIME_API_URL=http://127.0.0.1:8080
export OORT_PRIME_WORKSPACE_ID=… OORT_PRIME_CHANNEL_ID=… OORT_PRIME_AGENT_TOKEN=…
adapters/prime/run.sh session --prompt "안녕"
```

Credential-free variant (loopback mock provider, no provider login at all):

```sh
MOCK_SCENARIO=long adapters/prime/run.sh mock-session --prompt "스트리밍" --refine
```

A real deployment establishes its prime provider login **inside the container**.
No provider credential enters oort's servers, images, or ledger (ADR-0004), and
nothing in this package reads one.

## Tests

```sh
python3 adapters/prime/tests/smoke_prime_adapter.py          # closed loop, no docker
python3 adapters/prime/tests/test_prime_adapter_contract.py  # contract + red proofs
adapters/prime/run.sh tenancy-leak && adapters/prime/run.sh tenancy
```

The first two need only python3 and run in `scripts/local_gate.sh --profile docs`.
The red proofs are labelled in the test names: each one deletes a specific guard
and reproduces a specific, previously-measured failure — a duplicated
announcement, a frozen answer, a truncated body. A guard whose removal changes
nothing was never load bearing.
