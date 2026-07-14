# Superapp Engine 실행 로드맵 제안

> Planning lane: `PLN-20260714-02`
> Owner: planning branch only; canonical integration owner는 `momo-main`
> Date: 2026-07-14
> Status: Proposed — owner review required
> Audit: `research/14-superapp-engine/00-pln-20260714-02-gap-audit.md`

## 1. 제안 요약

momo의 슈퍼앱 엔진 v0를 “기능 목록”이 아니라 다음 한 개의 governed execution loop로 정의한다.

```text
install/grant
  → capability cache
  → authorized Context Packet + memory/source refs
  → Work/MCP/plugin proposal
  → approval-bound action
  → provider execution
  → source/cost/audit result in channel timeline
```

v0 success는 Google Workspace나 webhook 버튼이 보이는 것이 아니다. 같은 loop가 Work, MCP, plugin, GWS에서 동일한 권한·승인·비용·감사 증거를 남기는 것이다.

## 2. 선행관계와 critical path

### 2.1 권고 순서

```text
ADR-S1 credential/capability trust
  ├─ ADR-S2 Codex native runtime
  └─ ADR-S3 webhook trust
          │
          ▼
SE-01 Context Broker + immutable Context Packet
          │
          ▼
SE-02 Memory Plane + Capability Cache minimum runtime
       ├──────────────┬───────────────────┐
       ▼              ▼                   ▼
SE-03 Inbound MCP  SE-04 Plugin/Webhook  SE-05 Codex Work native bridge
       │              │                   │
       └──────┬───────┘                   │
              ▼                           │
SE-06 Google Workspace read sync + citation
              │                           │
              └──────────┬────────────────┘
                         ▼
                actual approval/resume G-Work
```

**critical path:** ADR-S1 → SE-01 → SE-02 → SE-04 → SE-06 → actual provider approval/resume gate.

SE-03과 SE-05는 SE-02 이후 병렬 가능하다. Google Workspace connector를 `hosted_connector` plugin으로 수렴시키려면 SE-04가 먼저다. 일정상 GWS를 core-internal adapter로 임시 구현해 critical path를 줄이는 우회는 권고하지 않는다. 나중에 credential/audit 경계를 다시 뜯게 된다.

### 2.2 기존 backlog와의 관계

- 이 제안은 기존 candidate `MOMO-307`(Context Broker), `MOMO-308`(Inbound MCP), `MOMO-310`(Memory/RAG), `MOMO-321`(Drive index), `MOMO-322`(wiki)를 폐기하지 않고 재분해한다.
- 현재 정본에는 `MOMO-320`이 “env drift guard”와 “AttachmentStore/Drive archive” 두 의미로 충돌한다. 아래 `SE-*`는 번호가 아니라 planning-local draft ID다.
- `momo-main`이 중복 제거와 Accepted ADR 반영 뒤 새 GitHub issue 번호를 배정해야 한다.

## 3. 필요한 ADR 후보

### ADR-S1 — Connector Credential, Capability Grant, and External Action Boundary

**결정 대상**

- plugin install/grant/revoke의 authority와 데이터 모델
- connector credential 종류별 custody: user OAuth, enterprise DWD/service account, API token, webhook key
- secret reference/encryption/KMS/rotation/delete/audit 경계
- normalized action hash, idempotency, approval expiry와 capability/policy version binding
- Context Packet/Memory/Capability에 secret material이 들어가지 않는 강제 규칙

**hard constraints**

- upstream Codex/OpenAI OAuth token/API key는 momo custody 대상이 아니다.
- Hermes-facing bearer는 connector credential과 분리된 runtime secret이다.
- Google Workspace token storage는 이 ADR이 Accepted되기 전 구현 금지다.

### ADR-S2 — Codex Work Host Runtime and Native Approval Bridge

**결정 대상**

- `codex exec` batch/fallback와 local `codex app-server` interactive transport의 역할
- stdio sidecar lifecycle, version pin/compatibility, reconnect/resume
- Codex thread/turn/item ID와 momo run/approval/message mapping
- command/file/permission approval translation, sandbox/approval-policy separation
- local auth directory와 process/environment isolation
- provider usage/cost accounting strategy

**권고안**

- user-owned host의 app-server stdio를 interactive Work v0.2 경로로 쓴다.
- remote WebSocket listener와 momo-managed Codex credential은 out of scope다.
- `codex exec`는 read-only batch/fallback로 유지한다.

### ADR-S3 — Signed Webhook Ingress and Rotation

**결정 대상**

- shared HMAC secret 발급/보관과 asymmetric publisher key 중 v0 방식
- key ID, canonical signature input, timestamp/nonce/replay window
- one-time reveal 또는 public-key enrollment, overlap rotation, revoke
- delivery ID idempotency, rate limit, max body, channel binding, error disclosure
- verified event가 message/send single transaction을 호출하는 방식

### ADR-S4 — Context/Memory Persistence and Retention

**결정 대상**

- immutable Context Packet의 저장 기간과 message/audit 참조
- Memory item/source ref의 permission snapshot과 retrieval-time revalidation
- source tombstone, user delete, workspace retention, legal hold/export
- raw provider body와 derived excerpt/index의 분리

ADR-S4는 ADR-S1과 병렬 초안 가능하지만 SE-01/02 migration merge 전에 Accepted여야 한다.

## 4. Buildable issue drafts

각 초안은 1 issue = 1 PR을 가정한다. 번호는 `momo-main`이 배정한다.

### SE-01 — Context Broker + immutable Context Packet runtime

#### Goal

mention, Work, inbound MCP가 공통으로 호출하는 server-owned Context Broker를 만들고, 권한 검증 결과와 projection hash를 가진 immutable Context Packet을 저장·조회한다.

#### Context

현재 `MessageRoutes`의 mention projection과 `AgentWorker.ContextAssembler`가 분산되어 있고, mock GitHub grant가 hard-code되어 있다. 정본은 Context Packet v0이며 schema/retention 변경은 Accepted ADR-S4가 선행한다.

#### Acceptance

- 신규 migration은 `workspace_id`, FORCE RLS, uuidv7, created/expires/version/hash를 포함하고 `schema_v0.sql`은 수정하지 않는다.
- Context Broker가 request, scope, recent messages, typed sources, memory refs, tool grants, budget, redactions, policy/capability versions를 deterministic하게 조립한다.
- mention/Work/MCP가 같은 assembler를 사용하고 hard-coded `mock-github@0.1.0` grant를 제거한다.
- packet에는 raw secret/token이 들어가지 않으며 cross-channel/cross-workspace source가 fixture에서 0건이다.
- packet hash와 policy evidence가 run/job/audit에 연결된다.
- 200-message fixture p95 250ms 이하와 deterministic replay를 local gate에 기록한다.

#### Out of scope

- provider OAuth, semantic/vector retrieval, plugin execution, UI redesign, long-term Memory ranking.

### SE-02 — Memory Plane + Capability Cache minimum runtime

#### Goal

Context Broker가 사용할 최소 typed memory/source-ref store와 capability cache를 구현하고 grant/revoke/revalidation을 fail-closed로 연결한다.

#### Context

두 plane은 fixture/spec만 있고 runtime이 없다. 이 issue는 full RAG가 아니라 authoritative storage, permission check, cache invalidation의 최소 vertical foundation만 만든다.

#### Acceptance

- Memory item은 type, provenance/source ref, visibility, retention/expiry, retrieval policy version을 저장한다.
- Capability entry는 네 cache kind, source/install/grant, schema hash, resource scope, risk, approval policy, TTL/version을 저장한다.
- retrieval 시 현재 membership/provider grant/source visibility를 재검증한다.
- grant revoke는 cache와 pending Context Packet/action을 invalidate하고 audit event를 남긴다.
- source body는 Capability Cache에, credential은 어느 plane에도 저장하지 않는다.
- 10k workspace fixture에서 forbidden retrieval 0건, memory top-k p95 500ms 이하, warm capability lookup p95 25ms 이하, invalidation 5초 이내를 증명한다.

#### Out of scope

- pgvector/RRF 품질 튜닝, provider sync, plugin marketplace, client search UI, automated memory write policy.

### SE-03 — Inbound MCP JSON-RPC runtime + scoped meta-tools

#### Goal

현재 stub을 실제 inbound MCP JSON-RPC runtime으로 바꾸고 `search`, `fetch`, `post_message`, `create_tool_call`을 Context/Capability/Approval 계약에 연결한다.

#### Context

discovery와 auth preflight는 있지만 tool call은 항상 stub error다. 기존 `MOMO-308` candidate를 이 foundation 위에서 재정의한다.

#### Acceptance

- OAuth/JWT scope issuance가 `mcp:read`, `mcp:post`, `mcp:tool:create`를 최소 권한으로 발급·revoke한다.
- JSON-RPC parse/batch/error/request size를 제한하고 workspace/channel/member preflight 후에만 dispatch한다.
- `search`/`fetch`는 authorized SourceRef와 bounded excerpt/citation을 반환한다.
- `post_message`는 기존 REST send single-transaction 경로를 재사용하고 Centrifugo 직접 publish를 금지한다.
- `create_tool_call`은 실행하지 않고 approval-bound proposal만 생성한다. 승인 후 공통 executor가 동일 input hash를 확인한다.
- 모든 call/result/failure에 actor, scope, packet, capability/policy version, cost, audit IDs가 남는다.
- 100 concurrent calls, duplicate request, revoke race, cross-tenant, oversized/prompt-injection fixture를 runtime gate로 통과한다.

#### Out of scope

- provider별 수백 개 tool mirror, public MCP package/repo split, remote arbitrary code execution, marketplace UI.

### SE-04 — Plugin registry/runtime + signed webhook vertical slice

#### Goal

Manifest v0를 실제 install/grant/runtime registry로 만들고, `external_webhook`을 첫 reference runtime으로 발급·서명 검증·rotation·수신까지 닫는다.

#### Context

plugin은 spec/fixture뿐이고 webhook은 Settings placeholder다. webhook을 별도 ad-hoc route로 만들지 않고 plugin capability, approval, source, audit 계약을 검증하는 첫 vertical slice로 사용한다. ADR-S1/S3가 선행한다.

#### Acceptance

- manifest validator가 protocol compatibility, SPDX/license, publisher/provenance, digest/signature, tools/scopes/risk/approval policy를 검증한다.
- workspace install/grant/revoke record와 Capability Cache projection이 RLS/audit에 연결된다.
- webhook create가 secret/key material을 일반 DB/log/message에 노출하지 않고 key ID/secret ref만 보존한다.
- receiver가 canonical body signature, timestamp, nonce/delivery ID, body size, channel binding, rate limit을 검증한다.
- rotation overlap, revoke, duplicate delivery, retry가 exactly-once message effect를 만족한다.
- verified event는 REST send single transaction을 재사용하며 provider가 Centrifugo에 직접 publish할 수 없다.
- Settings는 실제 configured/status/last delivery/rotate/revoke API만 표시한다.
- runtime gate가 forged signature, replay, stale key, cross-workspace, rotation race, secret redaction을 포함한다.

#### Out of scope

- WASM, third-party marketplace, arbitrary executable install, outbound webhook fan-out, billing, public repo split.

### SE-05 — Codex Work native approval bridge + real runtime closure

#### Goal

user-owned execution host의 실제 Codex runtime과 momo Work를 연결해 native command/file/permission approval, resume, result를 1:1 ledger로 검증한다.

#### Context

현재 adapter는 mock 검증되었지만 approval을 합성한다. ADR-S2 뒤 local app-server stdio sidecar를 interactive 경로로 추가하고 exec fallback을 유지한다.

#### Acceptance

- app-server version/capability handshake와 thread/turn/item event adapter가 존재한다.
- native approval request가 momo approval row/message에 immutable mapping되고 approve/reject/timeout이 정확한 Codex request로 응답된다.
- sidecar restart/reconnect 시 `thread/resume`로 이어지고 duplicate approval/result가 생기지 않는다.
- sandbox와 approval policy가 별도 evidence로 보존되며 danger-full-access/network escalation은 v0에서 fail closed다.
- upstream Codex/OpenAI OAuth token/API key가 momo env/argv/DB/log/state에 0건임을 negative test로 검증한다.
- `MOMO_AGENT_TOKEN`만 momo API에 쓰고 Codex child/app-server auth와 분리한다.
- usage event를 server-owned pricing/reserve/reconcile에 연결하거나, 지원 불가 시 run 시작 전 명시적 unpriced policy로 차단한다. 성공 비용을 0으로 위장하지 않는다.
- 실제 authenticated Codex + local momo runtime의 승인/resume G-Work evidence bundle을 생성한다.

#### Out of scope

- momo-managed Codex auth, remote public app-server, ChatGPT Work UI 복제, Windows/Linux host packaging, automatic PR merge.

### SE-06 — Google Workspace read sync + authoritative source citation

#### Goal

승인된 connector credential 경계 위에서 Google Drive selected-file/changes read sync를 구현하고, authorized SourceRef와 clickable citation을 Work/MCP/timeline에 제공한다.

#### Context

GWS는 현재 research spec과 fixture뿐이다. 전체 Drive/Gmail/Calendar를 한 번에 구현하지 않고 Drive read vertical slice로 시작한다. Gmail/Calendar와 external write는 후속 issue다.

#### Acceptance

- ADR-S1의 승인된 token custody/revoke/delete 방식만 구현한다. refresh/access token은 Context/Memory/Capability/message/audit에 나타나지 않는다.
- v0 scope는 least-privilege selected Drive read로 제한하고 enterprise DWD는 별도 manual/ADR gate 뒤에서만 켠다.
- cursor/checkpoint, 429/5xx backoff, retry, duplicate, tombstone/revoke가 idempotent하다.
- SourceRef가 provider object ID, version/modified time, bounded excerpt, excerpt hash, mime/type, visibility snapshot, connector/grant ID를 보존한다.
- source 열기/인용 시 현재 provider grant와 workspace membership을 재검증하고 revoked/deleted source는 본문을 노출하지 않는다.
- Work result와 inbound MCP fetch가 같은 citation contract를 쓰며 macOS timeline/detail에서 source badge와 “권한 만료/삭제됨” 상태를 구분한다.
- provider mock gate와 별개로 internal OAuth test tenant에서 read-only sync/resume/revoke evidence를 남긴다.

#### Out of scope

- Gmail/Calendar sync, Google write, DWD default enablement, public OAuth verification 완료, shared-drive archive/RAG 전체, automatic wiki write.

## 5. Approval-gated external write 후속 계약

SE-03/04는 write를 직접 실행하기보다 공통 action envelope를 사용해야 한다.

필수 필드:

- actor/workspace/channel/run/plugin/tool/provider/resource scope
- canonical normalized input + hash
- capability/schema/policy/connector-grant version
- risk class, reason, preview, estimated cost
- approval ID, approver, decision, expiry
- provider idempotency key와 retry policy

승인 후 executor는 membership, connector grant, capability/policy version, input hash, expiry를 모두 다시 확인한다. 하나라도 달라지면 새 approval이 필요하다. Google Workspace write는 SE-06에 포함하지 않고 이 계약이 실제 webhook/plugin reference에서 증명된 뒤 별도 issue로 연다.

## 6. Security, performance, runtime test gates

| Gate | Merge 조건 |
|---|---|
| S-0 Credential custody | forbidden upstream Codex/OpenAI token field/env/log/DB scan 0건; Hermes runtime secret과 connector secret 분리; GWS는 Accepted ADR 확인. |
| S-1 Tenant isolation | 신규 table FORCE RLS, `SET LOCAL app.workspace_id`, cross-workspace fixtures 0 leak, BYPASSRLS 사용 근거 명시. |
| S-2 Approval integrity | proposed input hash/version/expiry/idempotency 재검증, approve/reject/revoke/race/duplicate fail-closed. |
| S-3 Source safety | retrieval/open 시 현재 권한 재검증, untrusted source 표시, bounded body, prompt injection fixture. |
| S-4 Secret hygiene | manifest/packet/message/audit/error에 raw secret 0건; rotation/revoke evidence. |
| P-0 Context | assembly p95 ≤250ms / 200 messages, deterministic replay. |
| P-1 Retrieval/cache | memory p95 ≤500ms / 10k fixture, capability warm p95 ≤25ms, invalidation ≤5s. |
| P-2 Ingress | MCP local read p95 ≤750ms; webhook verify+enqueue p95 ≤200ms; bounded concurrency/backpressure. |
| R-0 Mock | deterministic provider/Codex/webhook/GWS mocks, retry/failure/revoke/race coverage. |
| R-1 Real Codex | authenticated host, native approval→momo decision→resume→diff/result, restart/reconnect evidence. |
| R-2 Real GWS | internal test tenant read sync, cursor resume, revoke/delete, citation open evidence. |
| R-3 Local gate | affected Swift packages build/test + runtime-db/runtime-agent 또는 신규 profiles; `runtime-unverified`를 provider 단위로 좁게 표기. |

## 7. UX/UI 트랙 겹침과 merge 순서

### 7.1 겹치는 파일

| Surface | 예상 겹침 파일 | 엔진 PR에서 허용할 변경 |
|---|---|---|
| Work cards/detail | `AgentWorkRunViews.swift`, `AgentWorkPresentation.swift`, `AgentWorkCopy.swift` | 새로운 protocol field를 기존 component에 최소 projection. layout 재설계 금지. |
| Approval | `ApprovalDecisionControls.swift`, `ApprovalInboxView.swift`, `LiveChatBackend.swift` | native/provider approval ID와 status mapping. visual redesign 금지. |
| Agent capability | `MomoAgentCapabilityBadges.swift`, `MomoWorkAgentCandidateFilter.swift`, `AgentWorkComposerView.swift` | real Capability Cache projection으로 mock/config convention 교체. |
| Sources/citations | `LiveChatBackend.swift`, message/timeline presentation files, `LocalContextCopilot*.swift` | authoritative SourceRef 상태와 citation action. local preview와 server source를 혼동하지 않는다. |
| Integrations settings | `MomoAccountSettingsViews.swift` | webhook/GWS actual status API binding. placeholder visual redesign은 UX lane에서 수행. |

### 7.2 권고 merge 순서

1. Accepted ADR과 server/Core protocol model을 먼저 merge한다.
2. migrations + repository/runtime foundation(SE-01/02)을 merge한다.
3. plugin/MCP/Codex/GWS server adapter를 각 issue에서 merge한다.
4. Core `ChatBackend`/DTO compatibility bridge를 merge한다.
5. UX/UI lane이 components/layout/copy를 merge한다.
6. 마지막에 runtime evidence PR 또는 같은 issue final commit으로 real provider gate를 닫는다.

엔진 PR이 UX-owned Swift 파일을 건드려야 하면 DTO/status mapping까지만 변경하고, UX branch는 그 commit 이후 rebase한다. 특히 `LiveChatBackend.swift`와 `MomoAccountSettingsViews.swift`는 동시 수정 금지 대상으로 lock을 잡는 것이 안전하다.

## 8. 실제 Codex Work 승인/resume 검증 계획

Gate 이름을 임시로 `G-Work`라 둔다.

### 8.1 준비

- 별도 user-owned macOS host/worktree에 supported Codex CLI version을 pin한다.
- 사용자가 Codex에 직접 로그인한다. momo server/DB에는 login token/key를 입력하지 않는다.
- adapter는 local app-server stdio child만 spawn하고 네트워크 listener를 열지 않는다.
- momo용 per-agent bearer는 mode-0600 runtime env에서만 주입한다.
- DB/log/process argv/state snapshot에서 forbidden credential pattern이 0건인지 preflight한다.

### 8.2 필수 시나리오

1. Read-only Work: source inspection → streamed progress → no write → final result.
2. File write: Codex native file-change approval → momo card → approve → same item resume → diff/result.
3. Command/network permission: native permission request → reject → no side effect and terminal rejected status.
4. Approval timeout: expiry 뒤 decision 거부, Codex turn cancellation/terminal state 정합.
5. Duplicate decision: same approval replay가 한 번만 effect.
6. Sidecar crash: approval 전/후 각각 restart, thread resume, no duplicate result.
7. momo server restart: queued decision/resume replay and outbox delivery.
8. Sandbox denial: out-of-scope path/danger escalation fail closed.
9. Cost ceiling: reserve 초과 시 실행 중단, partial usage reconcile.
10. Credential negative test: process env/argv, adapter state, DB, audit, message props, exported evidence에 upstream credential 0건.

### 8.3 evidence bundle

- pinned Codex/momo commit/version과 sanitized config
- momo run/approval/message/audit IDs ↔ Codex thread/turn/item IDs mapping
- ordered event transcript(credential redacted), approval decision timestamps
- before/after git diff 및 filesystem side-effect proof
- usage/cost reserve/reconcile ledger
- retry/restart/duplicate assertions
- forbidden credential scan 결과

`G-Work PASS`는 실제 authenticated runtime에서 위 시나리오가 통과했을 때만 기록한다. repo-local mock만으로 PASS 처리하지 않는다.

## 9. 미확정 질문

1. plugin v0 catalog를 core DB registry로 먼저 둘지, 처음부터 `momo-plugins` signed index를 읽을지?
2. webhook publisher 호환성을 우선해 HMAC을 택할지, server secret custody를 줄이기 위해 asymmetric signature를 우선할지?
3. Context Packet 원문 보존 기간과 audit/legal hold의 관계는 무엇인지?
4. Memory Plane v0는 keyword/metadata retrieval만 먼저 할지, pgvector/RRF와 동시에 열지?
5. Codex app-server version pin 범위와 fallback `codex exec` support window를 어떻게 정할지?
6. Codex usage가 정확한 price 정보를 제공하지 않을 때 실행을 차단할지, 명시적인 unpriced budget class를 허용할지?
7. GWS 첫 slice를 per-user `drive.file`로 제한할지, workspace archive service account 경로를 먼저 할지? 보안상 기본값은 전자를 권고한다.
8. webhook은 inbound event만 v0로 할지, outbound delivery도 같은 ADR에서 결정하되 별도 issue로 둘지?

## 10. 계획 이탈

- 구현하지 않았다.
- GitHub issue를 만들지 않았다.
- `ROADMAP.md`, `BUILD_TICKETS.md`, `STATUS.md`, `docs/planning/CURRENT_STATE.md`를 수정하지 않았다.
- 기존 backlog ID 충돌 때문에 issue 초안에 planning-local `SE-*`를 사용했다.
- Google Workspace write는 buildable first slice에서 제외했다. 공통 approval-bound executor와 read source citation을 먼저 닫고 후속 issue로 제안한다.
