# Superapp Engine 실행 로드맵 제안

> Planning lane: `PLN-20260714-02`
> Owner: planning branch only; canonical integration owner는 `momo-main`
> Date: 2026-07-14
> Status: Proposed — owner review required
> Audit: `research/14-superapp-engine/00-pln-20260714-02-gap-audit.md`

## 1. 제안 요약

oort의 슈퍼앱 엔진 v0를 “기능 목록”이 아니라 다음 한 개의 governed execution loop로 정의한다.

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
ADR-0113 credential/capability/action trust
  ├─ SE-02A Capability runtime ──┬─ SE-02C governed action executor
  │                              └─ SE-04A Plugin registry
  │                                    ├─ SE-04B Signed webhook
  │                                    └─ SE-06A GWS Drive read
  │                                           ├─ SE-06B real GWS gate
  │                                           └─ SE-06C citation UX
  └─ MCP auth/scope decision
ADR-0116 context/memory retention
  └─ SE-02B Memory + SourceRef runtime
          ├─ SE-01 Context Broker ── SE-03A auth ──┬─ SE-03B reads
          │                                        └─ SE-03C post/action
          └────────────────────────────── joins SE-06A GWS Drive read

ADR-0114 Codex runtime amendment
  └─ SE-05A app-server bridge ── SE-05B E-WORK-1 real runtime gate
```

**superapp data critical path:** ADR-0113 → SE-02A → SE-04A와 ADR-0116 → SE-02B가 SE-06A에서 합류한다. SE-04A 자체는 SE-02B에 의존하지 않는다. Context/MCP 경로는 SE-02A/02B → SE-01 → SE-03A → SE-03B/03C이며, SE-03C는 SE-02C도 선행한다.

**Work runtime critical path:** ADR-0114 → SE-05A → SE-05B. 이 경로는 GWS/webhook/Memory와 독립적으로 닫는다. Google Workspace connector를 `hosted_connector` plugin으로 수렴시키려면 SE-04A가 먼저다. 일정상 GWS를 core-internal adapter로 임시 구현해 critical path를 줄이는 우회는 권고하지 않는다. 나중에 credential/audit 경계를 다시 뜯게 된다.

### 2.1 PLN-20260716-01 plugin productization overlay

Codex/Hermes/MCP와 Google·GitHub·Notion 공식 표면을 다시 대조한 결과, 이 critical path는 유지한다. 다만 SE-04A 위에 다음 제품 계약을 명시한다.

- plugin은 workflow/capability package이고 MCP는 가능한 runtime adapter 중 하나다.
- lifecycle은 catalog / workspace install / member connection / channel enablement / actor grant / runtime health의 독립 projection으로 분리한다.
- 에이전트는 catalog 전체가 아니라 Capability Cache에서 현재 grant·resource scope·health를 통과한 tool만 Context Packet `tool_grants`로 받는다.
- 첫 제품 체감 vertical 후보로 Google Drive selected-file read/cite/upload/link를 제안한다. 기존 정본은 GitHub가 첫 생태계 증명 플러그인이며 first-party repo split도 GitHub부터 시작하는 GitHub-first 전략이다. ADR-0113과 제품 오너 승인 전에는 제품 vertical, 구현, repo split 어느 순서도 바꾸지 않는다.
- 근거와 UX/API 요구는 `research/16-plugin-platform/00-plugin-ecosystem-research.md`, `research/16-plugin-platform/01-momo-plugin-platform-product-proposal.md`, Fable 정교화 계약은 `docs/planning/handoffs/2026-07-16-plugin-platform-fable.md`를 따른다.

### 2.2 기존 backlog와의 관계

- `SE-01`은 기존 `MOMO-307`의 계약을 보강해 재사용한다. 기존 `MOMO-308`은 Inbound MCP umbrella로만 남기고 claim을 금지하며, `SE-03A/03B/03C`는 각각 새 숫자 ID를 받는다.
- 기존 `MOMO-310`은 pgvector/RRF 품질 확장으로 보류하고, minimum typed Memory runtime(`SE-02B`)을 별도 새 ID로 분리한다. Capability runtime(`SE-02A`)도 별도 새 ID를 쓴다.
- 기존 `MOMO-321`의 shared-drive poll/index 가정은 ADR-0113 결정 전 동결한다. `SE-06A/06B/06C`는 per-user selected-file read/citation vertical로 새 ID를 사용하고, `MOMO-322` wiki는 그 이후 후속으로 유지한다.
- `MOMO-320`의 정본 의미는 이미 완료된 “local runtime env drift guard” 하나로 고정한다. 과거 `AttachmentStore/Drive archive` 초안에는 이 번호를 다시 쓰지 않는다.
- 아래 `SE-*`는 planning-local draft ID다. `momo-main`은 Accepted ADR 뒤 새 항목에만 숫자 ID를 배정하고, 기존 ID 재사용 항목은 계약을 정본에서 명시적으로 교체한다.

| 기존 ID | 처분 |
|---|---|
| `MOMO-120/121/122/123/151/152/153` | 완료된 spec/manual ID로 유지하며 runtime 구현에 재사용하지 않는다. |
| `MOMO-307` | SE-01 Context Broker integration으로 유지하되 ADR-0113/0116 + SE-02A/02B 의존을 추가한다. |
| `MOMO-308` | non-claimable Inbound MCP umbrella로 전환하고 `ready`를 취소한다. SE-03A/03B/03C는 새 ID를 받아 `03A → 03B/03C`, `SE-02C → 03C` 순서를 따른다. |
| `MOMO-310` | advanced pgvector/RRF/embedding으로만 유지한다. minimum Memory runtime은 새 ID다. |
| `MOMO-320` | 완료된 env drift guard 전용이다. Drive/Attachment 의미를 제거한다. |
| `MOMO-321` | shared-drive archive/index 후보로 동결한다. per-user Drive read vertical은 새 ID다. |
| `MOMO-322` | 후속 wiki/write slice로 유지하고 SE-02C action executor를 추가 의존으로 둔다. |

## 3. 필요한 ADR 후보

### ADR-0113 (ADR-S1) — Connector Credential, Capability Grant, and External Action Boundary

**결정 대상**

- plugin install/grant/revoke의 authority와 데이터 모델
- connector credential 종류별 custody: user OAuth, enterprise DWD/service account, API token, webhook key
- secret reference/encryption/KMS/rotation/delete/audit 경계
- normalized action hash, idempotency, approval expiry와 capability/policy version binding
- Context Packet/Memory/Capability에 secret material이 들어가지 않는 강제 규칙
- actor, represented subject/delegator, grantor, `via_token_id`와 resource scope를 묶는 ADR-0101 delegation proof
- 실행 직전 authoritative grant/revoke epoch 재검증과 short-lived action-bound delegation token
- per-user OAuth는 PKCE, state/nonce, exact redirect URI, one-time code, initiating member/workspace/grant binding을 강제하고 callback에서 모두 재검증한다.

**hard constraints**

- upstream Codex/OpenAI OAuth token/API key는 oort custody 대상이 아니다.
- Hermes-facing bearer는 connector credential과 분리된 runtime secret이다.
- Google Workspace token storage는 이 ADR이 Accepted되기 전 구현 금지다.
- Capability Cache에는 schema/reference/version/policy metadata만 저장하고 source body/excerpt/context summary/credential은 저장하지 않는다.
- connector/MCP/plugin/webhook/GWS write에 BYPASSRLS를 추가하지 않는다.

### ADR-0114 (ADR-S2) — Codex Work Host Runtime and Native Approval Bridge

**결정 대상**

- `codex exec` batch/fallback와 local `codex app-server` interactive transport의 역할
- stdio sidecar lifecycle, version pin/compatibility, reconnect/resume
- Codex thread/turn/item ID와 oort run/approval/message mapping
- command/file/permission approval translation, sandbox/approval-policy separation
- local auth directory와 process/environment isolation
- provider usage/cost accounting strategy
- app-server default-deny RPC/event allowlist와 frame-level redaction
- ADR-0102 BYOA transport 및 ADR-0111 `codex exec` reference runtime의 amendment matrix

**권고안**

- user-owned host의 app-server stdio를 interactive Work v0.2 경로로 쓴다.
- remote WebSocket listener와 momo-managed Codex credential은 out of scope다.
- `codex exec`는 read-only batch/fallback로 유지한다.
- auth/login/token-refresh, config mutation, raw shell RPC, persistent/session-wide permission grant는 v0에서 relay하지 않는다.
- native approval은 host instance + protocol version + JSON-RPC request ID + thread/turn/item/approval ID + normalized payload hash + allowed decision set + expiry에 바인딩한다.

### ADR-0115 (ADR-S3) — Signed Webhook Ingress and Rotation

**결정 대상**

- shared HMAC secret 발급/보관과 asymmetric publisher key 중 v0 방식
- key ID, canonical signature input, timestamp/nonce/replay window
- one-time reveal 또는 public-key enrollment, overlap rotation, revoke
- delivery ID idempotency, rate limit, max body, channel binding, error disclosure
- verified event가 message/send single transaction을 호출하는 방식
- v0 권고는 per-install HMAC-SHA256이다. signature base는 version, HTTP method, canonical endpoint/install ID, timestamp, delivery ID, raw-body SHA-256을 포함하고 constant-time 비교한다.
- `(workspace_id, installation_id, delivery_id)` receipt와 deterministic `client_msg_id`, channel seq/message/outbox는 같은 tenant transaction에서 원자적으로 기록한다.

### ADR-0116 (ADR-S4) — Context/Memory Persistence and Retention

**결정 대상**

- immutable Context Packet의 저장 기간과 message/audit 참조
- Memory item/source ref의 permission snapshot과 retrieval-time revalidation
- source tombstone, user delete, workspace retention, legal hold/export
- raw provider body와 derived excerpt/index의 분리
- raw provider body는 bounded-retention encrypted source store에만 둘 수 있고 Context Packet/Memory/Capability에는 reference, bounded excerpt, hash, policy evidence만 둔다.

ADR-0116은 ADR-0113과 병렬 초안 가능하지만 SE-01/02A/02B migration merge 전에 Accepted여야 한다. ADR-0113~0116의 draft owner는 engine planner, canonical integration/상태 전환 owner는 `momo-main`, 최종 승인자는 성재로 둔다.

## 4. Buildable issue drafts

각 초안은 1 issue = 1 PR을 가정한다. 번호는 `momo-main`이 배정한다.

### SE-01 — Context Broker + immutable Context Packet runtime

#### Goal

mention, Work, inbound MCP가 공통으로 호출하는 server-owned Context Broker를 만들고, SE-02A/02B의 권한 검증 결과와 projection hash를 가진 immutable Context Packet을 저장·조회한다.

#### Context

현재 `MessageRoutes`의 mention projection과 `AgentWorker.ContextAssembler`가 분산되어 있고, mock GitHub grant가 hard-code되어 있다. 정본은 Context Packet v0이며 ADR-0113/0116과 SE-02A/02B가 선행한다.

#### Acceptance

- 신규 migration은 `workspace_id`, FORCE RLS, uuidv7, created/expires/version/hash를 포함하고 `schema_v0.sql`은 수정하지 않는다.
- Context Broker가 request, scope, recent messages, typed sources, memory refs, tool grants, budget, redactions, policy/capability versions를 deterministic하게 조립한다.
- mention/Work/MCP가 같은 assembler를 사용하고 hard-coded `mock-github@0.1.0` grant를 제거한다.
- packet에는 raw secret/token이 들어가지 않으며 cross-channel/cross-workspace source가 fixture에서 0건이다.
- packet hash와 policy evidence가 run/job/audit에 연결된다.
- 200-message fixture에서 deterministic replay를 증명하고 p95를 측정·보고한다. 절대 latency는 PERF-HARNESS 뒤 hard gate로 승격한다.

#### Out of scope

- provider OAuth, semantic/vector retrieval, plugin execution, UI redesign, long-term Memory ranking.

### SE-02A — Capability Registry + Cache minimum runtime

#### Goal

Context Broker와 실행 proposal이 사용할 capability registry/cache를 구현하고 install/grant/revoke/revalidation을 fail-closed로 연결한다.

#### Context

Capability Cache는 fixture/spec만 있고 authoritative runtime이 없다. plugin/MCP/Codex/GWS가 같은 grant와 policy version을 소비하기 위한 최소 foundation만 만든다.

#### Acceptance

- Capability entry는 네 cache kind, source/install/grant, schema hash, resource scope, risk, approval policy, TTL/version을 저장한다.
- lookup 시 현재 membership/install/provider grant/resource scope를 재검증한다.
- grant revoke는 cache와 pending Context Packet/action을 invalidate하고 audit event를 남긴다.
- tool schema와 provenance는 저장할 수 있지만 source body와 credential은 Capability Cache에 저장하지 않는다.
- 10k capability fixture에서 forbidden grant 0건을 증명하고 warm lookup p95/invalidation latency를 측정·보고한다. 절대 latency는 PERF-HARNESS 뒤 hard gate로 승격한다.

#### Out of scope

- provider sync, plugin marketplace, client search UI, Memory retrieval/ranking.

### SE-02B — Typed Memory + SourceRef minimum runtime

#### Goal

Context Broker가 사용할 typed Memory/SourceRef store를 구현하고 provenance, visibility, retention, delete, retrieval-time permission revalidation을 강제한다.

#### Context

Memory Plane은 fixture/spec만 있고 runtime이 없다. full RAG와 embedding 품질 튜닝을 섞지 않고 keyword/metadata retrieval로 권한·수명주기 계약부터 증명한다.

#### Acceptance

- Memory item은 type, provenance/source ref, visibility, retention/expiry, delete/tombstone, retrieval policy version을 저장한다.
- SourceRef는 bounded excerpt/hash와 현재 권한 재검증에 필요한 provider/resource/grant reference를 저장하되 raw credential을 저장하지 않는다.
- retrieval 시 현재 membership/provider grant/source visibility를 재검증하고 revoked/deleted source body를 반환하지 않는다.
- user delete, workspace retention, source tombstone이 Context Packet과 pending action을 invalidate하고 audit event를 남긴다.
- 10k memory fixture에서 forbidden retrieval 0건을 증명하고 keyword/metadata top-k p95를 측정·보고한다. 절대 latency는 PERF-HARNESS 뒤 hard gate로 승격한다.

#### Out of scope

- pgvector/HNSW/RRF, embedding worker, automated memory write/ranking, Google provider sync, client search UI.

### SE-02C — Governed external action envelope + executor

#### Goal

MCP/plugin/GWS write가 공유하는 immutable action envelope와 approval-bound executor를 구현해 승인 이후 권한·입력·버전·멱등성을 authoritative source에서 다시 검증한다.

#### Acceptance

- envelope가 actor, represented subject/delegator, grantor, `via_token_id`, workspace/channel/resource scope, capability/schema/policy/grant version, normalized input hash, risk/cost/expiry를 보존한다.
- 실행 직전 membership와 grant authoritative row를 cache bypass로 다시 읽고 revoke epoch, approval, input hash, expiry가 하나라도 다르면 fail closed한다.
- provider가 idempotency key를 보장할 때 approve/reject/timeout/revoke/duplicate/race가 한 번의 effect로 수렴한다. 원격 성공과 local commit 사이 결과를 확인할 수 없는 provider는 `outcome=unknown`으로 멈추고 자동 retry하지 않으며 operator reconciliation을 요구한다.
- short-lived action-bound delegation token은 hash만 저장하며 connector credential은 executor payload/log/message에 나타나지 않는다.
- tenant write는 `SET LOCAL app.workspace_id` + FORCE RLS를 사용하고 BYPASSRLS를 사용하지 않는다.

#### Out of scope

- 특정 provider write 구현, marketplace UI, arbitrary code execution.

### SE-03A — Inbound MCP auth/session issuance

#### Goal

ADR-0113의 MCP auth/scope 결정에 따라 external client session issuance, rotate/revoke와 bounded JSON-RPC transport preflight를 구현한다.

#### Context

discovery와 auth preflight는 있지만 scope issuance/revoke lifecycle이 없다. 기존 `MOMO-308`은 이 auth foundation과 후속 dispatch slices를 순서대로 통합한 뒤에만 done이다.

#### Acceptance

- OAuth/JWT scope issuance가 `mcp:read`, `mcp:post`, `mcp:tool:create`를 최소 권한으로 발급·revoke한다.
- JSON-RPC parse/batch/error/request size를 제한하고 workspace/channel/member preflight 후에만 dispatch한다.
- 모든 call/result/failure에 actor, scope, packet, capability/policy version, cost, audit IDs가 남는다.
- duplicate request, revoke race, cross-tenant, oversized batch를 runtime gate로 통과한다.

#### Out of scope

- tool dispatch, provider mirror, public MCP package/repo split, remote arbitrary code execution.

### SE-03B — Inbound MCP read tools

#### Goal

`search_messages`와 `fetch_thread/source`를 Context Broker/SourceRef 권한 계약에 연결한다.

#### Acceptance

- read tool은 authorized bounded message/thread/SourceRef excerpt와 citation만 반환한다.
- current membership/source grant를 재검증하고 cross-channel/workspace/revoked source를 0건 반환한다.
- 100 concurrent read calls와 prompt-injection/untrusted-source fixture를 bounded concurrency로 통과한다.

#### Out of scope

- post/write proposal, provider-specific tool mirror, client UI.

### SE-03C — Inbound MCP post + action proposal tools

#### Goal

`post_message`와 `create_tool_call`을 기존 write path와 SE-02C action executor에 연결한다.

#### Acceptance

- `post_message`는 기존 REST send single-transaction 경로를 재사용하고 Centrifugo 직접 publish를 금지한다.
- `create_tool_call`은 실행하지 않고 approval-bound proposal만 만들며 승인 후 SE-02C가 동일 input hash와 authoritative grant를 재검증한다.
- duplicate/revoke/approval race가 silent write나 duplicate effect를 만들지 않는다.

#### Out of scope

- provider-specific executor, marketplace UI, arbitrary code execution.

### SE-PERF — Engine benchmark harness

#### Goal

Context/Memory/Capability/MCP/webhook latency를 재현 가능하게 측정하는 benchmark host와 evidence contract를 정본화한다.

#### Acceptance

- fixed fixture seed/hash, baseline/10x datasets, host/toolchain label, warm-up, 최소 100 samples, percentile 계산, concurrency, variance allowance를 고정한다.
- machine-readable evidence와 regression comparison을 출력한다.
- 이 issue 전에는 absolute latency를 merge blocker로 사용하지 않는다.

#### Out of scope

- production SLO, provider network latency, load generator infrastructure.

### SE-04A — Plugin manifest registry + install/grant runtime

#### Goal

Manifest v0를 실제 install/grant/runtime registry로 만들고 Capability Cache와 audit에 연결한다.

#### Context

plugin은 spec/fixture뿐이다. core DB registry first를 v0 권고로 두고, external signed catalog/index는 후속으로 분리한다. ADR-0113과 SE-02A가 선행한다.

PLN-20260716-01은 이 runtime 위에 Plugin Center/온보딩/연결 UX가 요구하는 catalog/install/connection/channel/grant/health 독립 projection과 Drive-first product vertical 후보를 추가 제안한다. 기존 GitHub-first 구현·분리 전략이 정본이며, 성재 결정과 Accepted ADR 전에는 순서를 바꾸거나 구현을 승인하지 않는다.

#### Acceptance

- manifest validator가 protocol compatibility, SPDX/license, publisher/provenance, digest/signature, tools/scopes/risk/approval policy를 검증한다.
- workspace install/grant/revoke record와 Capability Cache projection이 RLS/audit에 연결된다.
- install/grant/revoke API는 workspace membership과 admin policy를 검증하고 raw credential/secret을 manifest/cache/message/audit에 저장하지 않는다.
- connection owner/provider subject, represented actor, delegator/grantor와 token reference를 묶고 projection/approval/execution에서 authoritative grant/revoke 상태를 재검증한다.
- capability/schema/provider scope가 넓어지는 update는 `update_pending`으로 멈추고 관리자 검토와 사용자 재동의 전 활성화하지 않는다.
- unknown protocol/tool schema/risk/approval policy와 revoked install은 fail closed한다.
- runtime adapter kind는 hosted connector/remote MCP/local MCP/agent-host에 매핑하고 signed webhook ingress를 outbound executor와 분리한다.
- runtime gate가 cross-workspace install/grant/revoke, stale capability version, malformed manifest, license/provenance 거부, actor/subject mismatch, revoked delegation, widened-update no-consent, remote endpoint SSRF/redirect/DNS-rebinding을 포함한다.

#### Out of scope

- provider execution, webhook, WASM, third-party marketplace, arbitrary executable install, billing, public repo split.

### SE-04B — Signed inbound webhook reference plugin

#### Goal

ADR-0115 계약에 따라 signed inbound webhook trigger를 첫 reference ingress surface로 발급·회전·서명 검증·수신까지 닫는다. 이 ingress는 Manifest v0의 outbound `runtime.kind=external_webhook`과 다른 방향이며, 기존 runtime kind를 재사용하지 않는다. 새 manifest surface/kind는 ADR-0115가 명시적으로 versioning한다.

#### Acceptance

- webhook create가 secret/key material을 일반 DB/log/message에 노출하지 않고 key ID/secret ref만 보존한다.
- receiver가 algorithm/key ID, version, HTTP method, canonical endpoint/install ID, timestamp, delivery ID, raw-body SHA-256를 검증하고 constant-time compare를 사용한다.
- strict body/parser limits, replay window, channel binding, rate limit, rotation overlap, revoke를 강제한다.
- unique `(workspace_id, installation_id, delivery_id)` receipt, deterministic `client_msg_id`, channel seq/message/outbox가 같은 tenant transaction에서 한 번만 commit된다.
- provider가 Centrifugo로 직접 publish할 수 없고 forged/replay/stale/cross-workspace/rotation-race/secret-redaction runtime gate를 통과한다.

#### Out of scope

- outbound webhook, asymmetric publisher enrollment, Settings visual UI, marketplace.

### SE-05A — Codex app-server typed approval bridge

#### Goal

user-owned execution host의 Codex app-server protocol을 oort Work에 연결하는 typed, default-deny adapter를 구현한다.

#### Context

현재 adapter는 mock 검증되었지만 approval을 합성한다. ADR-0114 뒤 local app-server stdio sidecar를 ADR-0102 BYOA transport로 추가하고 `codex exec` read-only fallback을 유지한다. 로컬 실측 기준 Codex CLI 0.144.1은 `codex app-server --stdio`와 protocol schema 생성 명령을 제공하지만 experimental 표면이므로 capability handshake와 exact version pin이 필수다.

#### Acceptance

- app-server version/capability handshake와 thread/turn/item event adapter가 존재한다.
- auth/login/token-refresh, config mutation, raw shell, dynamic tool, session-wide grant RPC/event는 default deny하고 허용 method/frame만 typed decode한다.
- native approval request가 host instance, protocol version, JSON-RPC request ID, thread/turn/item/approval ID, normalized payload hash, allowed decision set, expiry와 oort approval ID에 immutable mapping된다.
- v0 decision은 one-request accept/decline/cancel과 요청된 turn-scoped subset만 허용하고 session approval/policy amendment/persistent permission을 거부한다.
- sidecar restart/reconnect 시 `thread/resume`로 이어지고 duplicate approval/result가 생기지 않는다.
- sandbox와 approval policy가 별도 evidence로 보존된다. ADR-0114가 허용하지 않은 danger/network/session-wide escalation은 fail closed하며, network policy는 ADR-0111을 어떻게 amend할지 ADR-0114에서 확정한다.
- upstream Codex/OpenAI OAuth token/API key가 oort env/argv/DB/log/state에 0건임을 negative test로 검증한다.
- user-owned Codex auth는 OS keyring/runtime home에만 두고 sanitized child env/file descriptor를 사용한다. `MOMO_AGENT_TOKEN`은 Codex child에 상속하지 않고 별도 adapter→oort control-plane call에만 쓴다.
- local alpha의 same-user host adapter는 명시적인 trusted local execution boundary다. adapter가 auth 파일을 읽지 않도록 method/env/log 경계를 두되 OS 수준 비가독성을 주장하지 않는다. production qualification은 dedicated OS user/sandbox 또는 keyring-backed isolation을 요구한다.
- usage event를 server-owned pricing/reserve/reconcile에 연결하거나, 지원 불가 시 run 시작 전 명시적 unpriced policy로 차단한다. 성공 비용을 0으로 위장하지 않는다.

#### Out of scope

- momo-managed Codex auth, remote public app-server, ChatGPT Work UI 복제, Windows/Linux host packaging, automatic PR merge.

### SE-05B — E-WORK-1 credentialed real runtime qualification

#### Goal

SE-05A를 실제 authenticated Codex와 local oort runtime에서 실행해 native approval/resume/reconnect evidence를 남긴다.

#### Acceptance

- §8 필수 시나리오와 sanitized evidence bundle이 user-owned host에서 통과한다.
- credential 동작은 성재, 실행 자동화는 engine runtime worker, evidence 검수/merge는 `momo-main`이 맡는다.
- repo-local mock만으로 PASS 처리하지 않고 실패 단계와 `runtime-unverified` 범위를 명확히 기록한다.

#### Out of scope

- adapter 설계 변경, remote hosting, provider credential 자동화.

### SE-06A — Google Workspace Drive read sync + SourceRef runtime

#### Goal

승인된 connector credential 경계 위에서 Google Drive selected-file/changes read sync를 구현하고 authorized SourceRef를 Work/MCP에 제공한다.

#### Context

GWS는 현재 research spec과 fixture뿐이다. 전체 Drive/Gmail/Calendar를 한 번에 구현하지 않고 Drive read vertical slice로 시작한다. Gmail/Calendar와 external write는 후속 issue다.

#### Acceptance

- ADR-0113의 승인된 token custody/revoke/delete 방식만 구현한다. refresh/access token은 Context/Memory/Capability/message/audit에 나타나지 않는다.
- OAuth 시작/콜백은 PKCE, state/nonce, exact redirect URI, one-time code와 initiating member/workspace/connector grant를 원자적으로 바인딩하고 mismatch/replay를 거부한다.
- v0 scope는 least-privilege selected Drive read로 제한하고 enterprise DWD는 별도 manual/ADR gate 뒤에서만 켠다.
- provider change/object-version key와 checkpoint advance를 atomic하게 묶고, 429/5xx backoff, retry, duplicate, tombstone/revoke가 idempotent하다.
- SourceRef가 provider object ID, version/modified time, bounded excerpt, excerpt hash, mime/type, visibility snapshot, connector/grant ID를 보존한다.
- source 열기/인용 시 현재 provider grant와 workspace membership을 재검증하고 revoked/deleted source는 본문을 노출하지 않는다.
- Work와 inbound MCP가 소비할 수 있는 공용 Core/server citation DTO를 제공한다. 실제 MCP binding은 SE-03B, macOS source badge와 “권한 만료/삭제됨” 표시는 SE-06C로 넘기며 이 engine PR에서 layout을 수정하지 않는다.
- connector plaintext column, trace/HTTP log, backup/crash report, process env, evidence bundle에 token이 0건임을 negative test로 검증한다.
- provider mock gate에서 read-only sync/resume/revoke/delete와 cursor-ahead data-loss 방지를 검증한다.

#### Out of scope

- Gmail/Calendar sync, Google write, DWD default enablement, public OAuth verification 완료, shared-drive archive/RAG 전체, automatic wiki write.

### SE-06B — Google Workspace credentialed read qualification

#### Goal

internal OAuth test tenant에서 SE-06A의 selected-file read sync, cursor resume, revoke/delete를 실검증한다.

#### Acceptance

- 사용자 OAuth/consent는 성재가 직접 수행하고 Codex는 credential을 읽거나 evidence에 남기지 않는다.
- read-only sync/resume/revoke/delete와 current-permission revalidation evidence가 PASS다.
- 실패 시 provider auth/scope/sync/storage/citation 단계로 원인을 분리한다.

#### Out of scope

- Gmail/Calendar, write, DWD, public OAuth verification.

### SE-06C — macOS authoritative citation UX

#### Goal

SE-06A의 Core/server citation DTO를 UX-owned issue에서 source badge, open action, expired/deleted state로 표시한다.

#### Acceptance

- Work/timeline/MCP source가 동일한 citation identity와 권한 상태를 표시한다.
- expired/deleted/revoked source는 본문을 노출하지 않고 복구 가능한 설명을 제공한다.
- ADR-0112 UX lane의 design review와 macos-ui gate를 통과한다.

#### Out of scope

- sync engine, credential custody, connector settings redesign.

## 5. Approval-gated external write 후속 계약

SE-03/04A와 후속 GWS write는 SE-02C의 공통 action envelope/executor를 사용해야 한다.

필수 필드:

- actor/represented subject/delegator/grantor/`via_token_id` + workspace/channel/run/plugin/tool/provider/resource scope
- canonical normalized input + hash
- capability/schema/policy/connector-grant version
- risk class, reason, preview, estimated cost
- approval ID, approver, decision, expiry
- provider idempotency key와 retry policy

승인 후 executor는 cache를 우회해 authoritative membership, connector grant, revoke epoch, capability/policy version, input hash, expiry를 모두 다시 확인한다. 하나라도 달라지면 새 approval이 필요하다. Google Workspace write는 SE-06A에 포함하지 않고 이 계약이 reference executor에서 증명된 뒤 별도 issue로 연다.

## 6. Security, performance, runtime test gates

| Gate | Merge 조건 |
|---|---|
| S-0 Credential custody | forbidden upstream Codex/OpenAI token field/env/log/DB scan 0건; Hermes runtime secret과 connector secret 분리; GWS는 Accepted ADR 확인. |
| S-1 Tenant isolation | 신규 table FORCE RLS, `SET LOCAL app.workspace_id`, cross-workspace fixtures 0 leak. connector/MCP/plugin/webhook/GWS write에서 BYPASSRLS 0건; 기존 OutboxRelay/AgentWorker allowlist 확대는 별도 Accepted ADR 없이는 금지. |
| S-2 Approval integrity | proposed input hash/version/expiry/idempotency 재검증, approve/reject/revoke/race/duplicate fail-closed. |
| S-3 Source safety | retrieval/open 시 현재 권한 재검증, untrusted source 표시, bounded body, prompt injection fixture. |
| S-4 Secret hygiene | manifest/packet/message/audit/error에 raw secret 0건; rotation/revoke evidence. |
| P-0 Context | assembly p95 ≤250ms / 200 messages, deterministic replay. PERF-HARNESS 정본 전에는 관찰값이며 correctness merge blocker만 hard다. |
| P-1 Retrieval/cache | memory p95 ≤500ms / 10k fixture, capability warm p95 ≤25ms, invalidation ≤5s. PERF-HARNESS 정본 전에는 관찰값이다. |
| P-2 Ingress | MCP local read p95 ≤750ms; webhook verify+enqueue p95 ≤200ms; bounded concurrency/backpressure. PERF-HARNESS 정본 전에는 관찰값이다. |
| R-0 Mock | deterministic provider/Codex/webhook/GWS mocks, retry/failure/revoke/race coverage. |
| R-1 / E-WORK-1 Real Codex | authenticated host, native approval→oort decision→resume→diff/result, restart/reconnect evidence. M7 `G-*` release namespace와 구분한다. |
| R-2A Real GWS runtime | internal test tenant read sync, cursor resume, revoke/delete, SourceRef permission evidence. |
| R-2B GWS citation UX | SE-06C 이후 citation open/expired/deleted macOS evidence. |
| R-3 Local gate | affected Swift packages build/test + runtime-db/runtime-agent 또는 신규 profiles; `runtime-unverified`를 provider 단위로 좁게 표기. |

절대 latency를 hard gate로 승격하기 전 별도 PERF-HARNESS issue가 fixed seed/hash, 기준 host label, warm-up, 최소 100 samples, percentile 계산, concurrency, variance allowance, machine-readable evidence를 정본화한다.

## 7. UX/UI 트랙 겹침과 merge 순서

### 7.1 겹치는 파일

| Surface | 예상 겹침 파일 | 엔진 PR에서 허용할 변경 |
|---|---|---|
| Work cards/detail | `AgentWorkRunViews.swift`, `AgentWorkPresentation.swift`, `AgentWorkCopy.swift` | 새로운 protocol field를 기존 component에 최소 projection. layout 재설계 금지. |
| Approval | `ApprovalDecisionControls.swift`, `ApprovalInboxView.swift`, `LiveChatBackend.swift` | native/provider approval ID와 status mapping. visual redesign 금지. |
| Agent capability | `MomoAgentCapabilityBadges.swift`, `MomoWorkAgentCandidateFilter.swift`, `AgentWorkComposerView.swift` | real Capability Cache projection으로 mock/config convention 교체. |
| Sources/citations | `LiveChatBackend.swift`, `MessageBubble.swift`, `MessageListView.swift`, `MessageTimelineLayout.swift`, `ChatViewModel.swift`, `LocalContextCopilot.swift`, `LocalContextCopilotView.swift` | authoritative SourceRef 상태와 citation action. local preview와 server source를 혼동하지 않는다. |
| Integrations settings | `MomoAccountSettingsViews.swift` | webhook/GWS actual status API binding. placeholder visual redesign은 UX lane에서 수행. |

### 7.2 권고 merge 순서

1. Accepted ADR과 server/Core protocol model을 먼저 merge한다.
2. migrations + repository/runtime foundation(SE-02A/02B/02C → SE-01)을 merge한다.
3. plugin/MCP/Codex/GWS server adapter를 각 issue에서 merge한다.
4. Core `ChatBackend`/DTO compatibility bridge를 merge한다.
5. UX/UI lane이 components/layout/copy를 merge한다.
6. 마지막에 runtime evidence PR 또는 같은 issue final commit으로 real provider gate를 닫는다.

엔진 PR은 기본적으로 `clients/macOS`를 수정하지 않는다. 꼭 필요한 DTO/status mapping은 `clients/Core`에서 먼저 merge하고 별도 UX issue가 소비한다. UX lane 소유 잠금은 `LiveChatBackend.swift`, `MomoAccountSettingsViews.swift`, `ApprovalDecisionControls.swift`, `ApprovalInboxView.swift`, `AgentWorkPresentation.swift`, `AgentWorkCopy.swift`, `AgentWorkComposerView.swift`, `AgentWorkRunViews.swift`, `MomoAgentCapabilityBadges.swift`, `MomoWorkAgentCandidateFilter.swift`, `LocalContextCopilot.swift`, `LocalContextCopilotView.swift`, `MessageBubble.swift`, `MessageListView.swift`, `MessageTimelineLayout.swift`, `ChatViewModel.swift`다. engine/UX 동시 수정은 금지하며, 위 표의 “허용 변경”도 `momo-main`이 prerequisite commit, owner, release condition, rebase order를 handoff에 명시한 예외에서만 허용한다.

## 8. 실제 Codex Work 승인/resume 검증 계획

Gate 이름은 `E-WORK-1`로 둔다. 이는 엔진 qualification gate이며 M7 `G-*` release namespace를 암묵적으로 확장하지 않는다.

### 8.1 준비

- E-WORK-1 host는 성재가 로그인한 user-owned macOS 로컬 host로 고정하고, 실행 owner는 engine runtime worker, credential 동작은 성재, evidence 검수/merge owner는 `momo-main`으로 분리한다.
- 해당 host/worktree에 검증된 Codex CLI exact version을 pin하고 app-server capability handshake 실패 시 interactive 경로를 fail closed한다.
- 사용자가 Codex에 직접 로그인한다. oort server/DB에는 login token/key를 입력하지 않는다.
- adapter는 local app-server stdio child만 spawn하고 네트워크 listener를 열지 않는다.
- oort용 per-agent bearer는 mode-0600 runtime env에서만 주입한다.
- DB/log/process argv/state snapshot에서 forbidden credential pattern이 0건인지 preflight한다. oort bearer는 adapter→oort request에만 주입하고 Codex child environment/file descriptor에는 전달하지 않는다.

### 8.2 필수 시나리오

1. Read-only Work: source inspection → streamed progress → no write → final result.
2. File write: Codex native file-change approval → oort card → approve → same item resume → diff/result.
3. Command/network permission: native permission request → reject → no side effect and terminal rejected status.
4. Approval timeout: expiry 뒤 decision 거부, Codex turn cancellation/terminal state 정합.
5. Duplicate decision: same approval replay가 한 번만 effect.
6. Sidecar crash: approval 전/후 각각 restart, thread resume, no duplicate result.
7. oort server restart: queued decision/resume replay and outbox delivery.
8. Sandbox denial: out-of-scope path/danger escalation fail closed.
9. Cost ceiling: reserve 초과 시 실행 중단, partial usage reconcile.
10. Credential negative test: process env/argv, adapter state, DB, audit, message props, exported evidence에 upstream credential 0건.

### 8.3 evidence bundle

- pinned Codex/momo commit/version과 sanitized config
- oort run/approval/message/audit IDs ↔ Codex thread/turn/item IDs mapping
- ordered event transcript(credential redacted), approval decision timestamps
- before/after git diff 및 filesystem side-effect proof
- usage/cost reserve/reconcile ledger
- retry/restart/duplicate assertions
- forbidden credential scan 결과

`E-WORK-1 PASS`는 실제 authenticated runtime에서 위 시나리오가 통과했을 때만 기록한다. repo-local mock만으로 PASS 처리하지 않는다.

## 9. 미확정 질문

1. plugin v0 catalog를 core DB registry로 먼저 둘지, 처음부터 `momo-plugins` signed index를 읽을지? 권고 기본값은 core DB registry first이며 external signed index는 후속이다.
2. webhook publisher 호환성을 우선해 HMAC을 택할지, server secret custody를 줄이기 위해 asymmetric signature를 우선할지? 권고 기본값은 reference HMAC + secret reference/rotation이며 asymmetric publisher key는 후속 호환 모드다.
3. Context Packet 원문 보존 기간과 audit/legal hold의 관계는 무엇인지?
4. Memory Plane v0는 keyword/metadata retrieval만 먼저 할지, pgvector/RRF와 동시에 열지? 권고 기본값은 권한·retention을 먼저 증명하는 keyword/metadata first다.
5. Codex app-server version pin 범위와 fallback `codex exec` support window를 어떻게 정할지?
6. Codex usage가 정확한 price 정보를 제공하지 않을 때 실행을 차단할지, 명시적인 unpriced budget class를 허용할지?
7. GWS 첫 slice를 per-user `drive.file`로 제한할지, workspace archive service account 경로를 먼저 할지? 보안상 기본값은 전자를 권고한다.
8. webhook은 inbound event만 v0로 할지, outbound delivery도 같은 ADR에서 결정하되 별도 issue로 둘지?

## 10. 계획 이탈

- 구현하지 않았다. 실제 Codex/GWS runtime도 실행하지 않았다.
- momo-main 통합 단계에서 GitHub Issue MOMO-381(`#383`)을 만들고 `ROADMAP.md`, `docs/BACKLOG.md`, `STATUS.md`, redesign tracker, `CURRENT_STATE.md`, `JOURNAL.md`를 함께 정리했다. `BUILD_TICKETS.md`의 새 구현 계약은 owner가 ADR 권고를 승인한 뒤 반영한다.
- 기존 backlog ID 충돌 때문에 새 implementation issue에는 아직 숫자 ID를 배정하지 않고 planning-local `SE-*`를 유지했다.
- Google Workspace write는 buildable first slice에서 제외했다. 공통 approval-bound executor와 read source citation을 먼저 닫고 후속 issue로 제안한다.
