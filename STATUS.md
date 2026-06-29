# momo — Phase 0 빌드 STATUS

> 생성: 2026-06-24 · 빌드 워크플로우 `momo-phase0-build`(T01~T10) + 로컬 `swift build` 재검증
> 검증 환경: Swift 6.2.3 (arm64-apple-macosx), Docker Desktop 29.4.3, PostgreSQL client 18.4(`/opt/homebrew/opt/libpq/bin/psql`). 실제 hermes는 없지만 MOMO-004에서 OpenAI-compatible SSE mock으로 AgentWorker e2e를 검증함.

## 0. Repo Bootstrap Hardening (2026-06-24)

- Centrifugo/server 계약을 `/v1/centrifugo/subscribe` + `ch:ws<workspaceUUID>.<channelUUID>` / `agent:ws<workspaceUUID>.<agentMemberUUID>`로 정렬하고, legacy GitHub bootstrap은 guard 처리.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build` 및 `make test` 모두 5개 Swift 패키지 green. `adapters/hermes/momo_adapter.py` py_compile, JSON/shell syntax, GitHub bootstrap dry-run 통과.
- MOMO-001 이전에는 런타임 e2e가 미검증이었으나, 현재는 아래 Runtime Gate에서 compose/migrate/server health/seq gapless, relay→Centrifugo publish 왕복, RLS 테넌트 격리, AgentWorker↔OpenAI-compatible SSE + 비용 reserve/reconcile까지 검증됨.

## 0a. MOMO-001 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo_momo_001`, `POSTGRES_PORT=15432`, `CENT_PORT=18001`로 기동하고 Docker health가 둘 다 green.
- `make migrate` pass: `001_init.sql` + `002_seed.sql` 적용 성공, 재실행 시 `적용 0, 스킵 2`로 멱등 통과. `scripts/migrate.sh`는 keg-only Homebrew `libpq`의 `psql`도 자동 감지한다.
- MomoServer runtime pass: `PORT=18080 swift run MomoServer` 후 `GET /health` 200. `POST /v1/.../messages`가 실제 DB에 `message` + `outbox`를 쓰고 `seq=1` 반환.
- seq gapless 검증: 같은 채널에 동시 10건 송신 결과 `seq=2...11`, DB 집계 `message_count=11`, `max_seq=11`, `missing_seq=NULL`, `outbox_count=11`, `version=1...11`.
- 후속 완료: MOMO-002/003/004에서 relay publish, RLS 격리, AgentWorker SSE + 비용 회계까지 검증됨.

## 0b. MOMO-002 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo002`, `POSTGRES_PORT=55432`, `CENT_PORT=58000`으로 기동하고 Docker health가 둘 다 green.
- `make migrate` pass: 재실행 시 `적용 0, 스킵 2`로 멱등 통과. MomoServer는 `GET /health` 200.
- Centrifugo v6 contract fix: compose에서 `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` / `CENTRIFUGO_HTTP_API_KEY` env override를 사용하고, subscribe proxy 설정을 `channel.proxy.subscribe.endpoint` + namespace `subscribe_proxy_enabled`로 정렬.
- OutboxRelay runtime pass: relay 중지 상태에서 메시지 송신 → outbox `id=4`가 `pending`, `version=4`, `idempotency_key=<channel>:4`로 생성됨. relay 재기동 후 SKIP LOCKED claim → Centrifugo `/api/publish` → outbox `status=done`, `attempts=1`, `last_error=NULL`.
- Centrifugo history pass: `/api/history` 최신 publication이 `data.seq=4`, `payload.seq=4`를 반환. relay 로그에도 `channel=ch:ws...`, `version=4`, `idempotencyKey=...:4`가 남음.
- 남은 runtime-unverified: WebSocket live subscribe/presence/recovery 세부 UX.

## 0c. CI Hotfix (2026-06-25)

- `main`의 `ci-build / swift build + test (5 packages)` 실패 원인은 GitHub Actions macOS runner의 Xcode 16.4 / Swift 6.1.2와 `jwt-kit` 최신 해상도 간 MLDSA API 불일치였다.
- `server/Package.swift`에서 `jwt-kit`을 `exact: "5.2.0"`으로 고정해 CI runner가 지원하지 않는 `MLDSA65`/`MLDSA87` 참조를 피하도록 했다.

## 0d. MOMO-003 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo003`, `POSTGRES_PORT=35432`, `CENT_PORT=38003`으로 기동하고 Docker health가 둘 다 green.
- `make migrate` pass: `001_init.sql` + `002_seed.sql` 적용 성공, 재실행 시 `적용 0, 스킵 2`로 멱등 통과.
- RLS runtime pass: `scripts/verify_rls.sh`가 `momo_app`(non-superuser/NOBYPASSRLS), `momo_relay`/`momo_worker`(non-superuser/BYPASSRLS) 역할을 만들고 두 워크스페이스 fixture를 검증했다. `app.workspace_id` 미설정 시 member/channel/membership/message 0건, A/B 교차 조회 0건, relay/worker BYPASSRLS 전 테넌트 조회가 통과했다.
- MomoServer membership gate pass: 서버를 `momo_app` 역할로 실행해 `/health` 200, channel member read 200/write 201, 같은 워크스페이스 nonmember read/write 403, workspace B token의 workspace A path 접근 403, workspace B 정상 member read 200을 확인했다.
- 코드 보강: REST message send/history도 Centrifugo subscribe proxy와 동일하게 active membership을 확인한다. RLS는 테넌트 경계, membership guard는 채널 접근권 경계로 분리된다.
- 남은 runtime-unverified: WebSocket live subscribe/presence/recovery 세부 UX, APNs.

## 0e. MOMO-004 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo004`, `POSTGRES_PORT=45432`, `CENT_PORT=48004`로 기동하고 Docker health가 green.
- `make migrate` pass: `001_init.sql` + `002_seed.sql` 적용 성공, 재실행 시 `적용 0, 스킵 2`로 멱등 통과.
- AgentWorker SSE runtime pass: `scripts/mock_hermes.py`가 OpenAI-compatible `/v1/chat/completions` SSE delta + final usage chunk를 제공하고, `scripts/verify_agent_worker.sh`가 김인턴 멘션 fixture → `outbox(kind='agent_job')` → AgentWorker claim → Centrifugo `agent.partial` history 수신을 확인했다.
- 비용 회계 pass: 성공 run `00000000-0000-7000-8000-000000000904`가 `agent_run.status=succeeded`, `usage_ledger(prompt=11, completion=7, cost_micro_usd=6, was_estimated=false)`, `budget_window(reserved=0, spent=6)`으로 기록됐다.
- G5 circuit breaker pass: low-limit `agent_channel` budget fixture가 hermes 호출 전 `G5 budget trip (agent_channel)`로 실패하고, 해당 run의 `usage_ledger` spend는 0건임을 확인했다.
- 코드 보강: `CostAccounting`이 `model_pricing` numeric 단가를 읽어 integer micro_usd로 reserve/reconcile하고, `budget_window` reserve를 `ON CONFLICT DO UPDATE ... WHERE spent+reserved+estimate<=limit` 원자 경로로 처리한다. `WorkerService`의 `agent_run.error` JSONB 저장도 `to_jsonb(text)`로 정리했다. 실제 hermes 대신 repo-local mock을 사용했으므로 외부 hermes 연동은 staging에서 재확인한다.
- 남은 runtime-unverified: WebSocket live subscribe/presence/recovery 세부 UX, APNs.

## 0f. MOMO-110 Local LLM · Agent Protocol · Trust Roadmap (2026-06-25)

- Apple Foundation Models는 서버 에이전트 대체가 아니라 intent/summarization/context compaction/PII redaction/offline draft 같은 온디바이스 context work에 우선 적용하기로 정리했다. 구현은 `#if canImport(FoundationModels)` + OS availability + server fallback 원칙.
- 새 연구 정본: `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`, `02-agent-protocol-google-workspace.md`, `03-enterprise-trust-local-ops.md`.
- 새 운영 정본: `docs/LOCAL_PR_GATE.md`(GitHub Actions 비주요 기간 로컬 PR gate), `docs/MULTI_SESSION_OPS.md`(5개+ Codex 세션/worktree 운영).
- build-macos-apps 플러그인은 SwiftPM build/test/triage와 macOS dev app 실행 표준화에 적극 사용하되, SwiftUI GUI는 raw `swift run`만 의존하지 않고 후속 `MOMO-134`에서 `.app` bundle staging + Codex Run action으로 보강하기로 했다.
- 런타임 코드 변경 없음. 이번 PR은 docs/spec 변경이며, M1 runtime-unverified 잔여 범위(WebSocket live subscribe/presence/recovery, APNs)는 그대로 유지된다.

## 0g. MOMO-150 Agent Runtime Research + Roadmap (2026-06-25)

- Hermes agent / internkim(Kim Intern) / openclaw를 기준으로 momo가 agent runtime의 단순 채널 어댑터가 아니라 context, memory, cache, approval, audit, cost를 소유하는 agent host가 되어야 한다는 결정을 문서화했다.
- 새 연구 정본: `research/11-agent-runtime/01-three-agent-runtime-analysis.md`, `02-memory-cache-protocol-gaps.md`, `03-roadmap-and-methodology.md`.
- 새 후속 로드맵: MOMO-151 Context Packet v0 deep spec, MOMO-152 Memory Plane v0, MOMO-153 Capability Cache v0, MOMO-160~163 backend protocol, MOMO-170~172 macOS/LLM UX.
- 런타임 코드 변경 없음. 이번 PR은 docs/spec 변경이며, M1 runtime-unverified 잔여 범위(WebSocket live subscribe/presence/recovery, APNs)는 그대로 유지된다.

## 0h. MOMO-151 Context Packet v0 Spec + Fixtures (2026-06-25)

- Context Packet v0 정본을 `research/11-agent-runtime/04-context-packet-v0.md`에 추가하고, request/scope/goal/source/memory/tool/budget/redaction/runtime envelope와 금지 필드를 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/context-packet-v0/`에 추가했다: mention thread summary, slash command ticket create, message context action ERM risk.
- 런타임 코드/스키마 변경 없음. `context_packet_id`의 DB 연결, Memory Plane, Capability Cache, approval pause/resume 구현은 후속 MOMO-152/153/160/161 범위다.

## 0i. MOMO-154 GitHub Actions Disabled + Local Gate Priority (2026-06-26)

- 조직 과금/결제 이슈로 `ci-build`, `release-ios`, `release-macos` 원격 workflow를 `disabled_manually` 상태로 전환했다. GitHub Actions green은 당분간 merge gate가 아니다.
- `.github/workflows/*.yml`의 자동 `push`/`pull_request`/tag 트리거를 제거하고 `workflow_dispatch` 전용으로 바꿨다. owner approval 전에는 workflow 재활성/수동 실행을 하지 않는다.
- PR 품질 기준은 `docs/LOCAL_PR_GATE.md`의 local evidence + review pass + no unrelated dirty files로 유지한다. 후속 `MOMO-111`은 이 흐름을 `scripts/local_gate.sh`로 자동화한다.

## 0j. MOMO-111 Local Gate Script + Evidence Flow (2026-06-26)

- `scripts/local_gate.sh`를 추가해 GitHub Actions disabled/manual-only 기간의 PR gate를 `docs`, `swift`, `runtime-db`, `runtime-relay`, `runtime-agent`, `macos-ui`, `all` profile로 실행하고 PR-ready `## Local Gate` evidence를 출력한다.
- `docs/LOCAL_PR_GATE.md`, `docs/GITHUB_OPS.md`, PR template, AGENTS/CODEX, ROADMAP/BUILD_TICKETS/INDEX가 모두 local gate script 우선 운영으로 정렬됐다.
- MOMO-115에서 `runtime-relay` 자동 검증 스크립트가 추가되어, 이제 relay/realtime PR은 `scripts/local_gate.sh --profile runtime-relay`로 Docker compose/migrate/server send/outbox/relay/Centrifugo history evidence를 남긴다.

## 0j-1. MOMO-115 Runtime Relay Local Gate Automation (2026-06-26)

- `scripts/verify_relay.sh`를 추가했다. seeded demo user로 MomoServer에 로그인해 REST message send를 수행하고, relay 시작 전 outbox `pending` + `payload.version=message.seq`를 확인한 뒤 OutboxRelay를 실행한다.
- 검증 범위: worktree별 `.env.worktree` 포트/compose project, `make up`, `make migrate` 멱등, server send, outbox pending, OutboxRelay SKIP LOCKED claim(`attempts>=1`), Centrifugo `/api/history` publication, outbox `done`, `version=message.seq` evidence.
- `scripts/local_gate.sh --profile runtime-relay`가 `scripts/verify_relay.sh`를 필수 shell syntax 및 runtime command로 포함한다. 남은 runtime-unverified 범위(WebSocket live subscribe/presence/recovery, APNs, Inbound MCP runtime)는 그대로다.

## 0k. MOMO-112 Multi-session Worktree Orchestration (2026-06-26)

- `scripts/goal_status.sh` status board를 추가해 ready/in-progress/needs-review/blocked issue와 branch/PR/local worktree/local gate evidence 상태를 한눈에 확인한다.
- `scripts/goal_claim.sh`, `scripts/goal_release.sh`, `.conductor/setup.sh`를 정본 운영 흐름으로 추가하고 `docs/MULTI_SESSION_OPS.md`를 5세션(`momo-main` + runtime/macOS/docs/infra workers) 운영 계약으로 확장했다.
- 런타임 e2e 범위는 변경하지 않았다. 이번 티켓은 운영/문서/스크립트 정본화이며, 신규 server/relay/agent runtime 검증은 후속 goal 범위다.

## 0l. MOMO-105 macOS SwiftPM Dev App (2026-06-26)

- `clients/macOS`에 `MomoMacDevApp` SwiftPM executable target과 SwiftUI `@main` App entrypoint를 추가했다. `swift run --package-path clients/macOS MomoMacDevApp`로 `MomoMacRootView`를 실제 macOS window에 호스트한다.
- `LiveChatBackend.seedDemo()`가 첫 채널에 `approval_request` 메시지, `agent.status`, `agent.partial`, pending approval 이벤트를 seed한다. 개발 앱 첫 화면에서 channel list, message list, Approval Inbox, cost UI가 함께 표시되는 경로다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build` pass, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test` pass, `swift run --package-path clients/macOS MomoMacDevApp` launch 후 WindowServer에서 `MomoMacDevApp` layer 0 window `window_count=1` 확인.
- Out of scope 유지: Developer ID signing, notarytool, DMG, Sparkle, App Store 배포.

## 0m. MOMO-152 Memory Plane v0 Spec + Permission Model (2026-06-26)

- Memory Plane v0 정본을 `research/11-agent-runtime/05-memory-plane-v0.md`에 추가하고, 장기 메모리를 `decision/preference/artifact_ref/task_state/external_source_ref/agent_skill_note` 6개 typed memory로 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/memory-plane-v0/`에 추가했다: typed memory catalog, retrieval 허용 Context Packet projection, retrieval 거부 permission examples.
- 검증: `jq empty research/11-agent-runtime/fixtures/memory-plane-v0/*.json`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` pass.
- 런타임 코드/스키마 변경 없음. memory DB migration, retrieval runtime, memory inspector, local LLM compaction 구현은 후속 MOMO-160/161/171/172 및 별도 migration 범위다.

## 0n. MOMO-153 Capability Cache v0 Spec + Fixtures (2026-06-26)

- Capability Cache v0 정본을 `research/11-agent-runtime/06-capability-cache-v0.md`에 추가하고, agent/plugin/MCP capability discovery를 `agent_capability/plugin_tool_schema/mcp_tool_list/model_pricing` 4개 cache kind로 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/capability-cache-v0/`에 추가했다: capability list snapshot, plugin tool schema projection, invalidation/audit examples.
- 검증: `jq empty research/11-agent-runtime/fixtures/capability-cache-v0/*.json` pass, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile docs` pass, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` pass.
- 런타임 코드/스키마 변경 없음. capability DB migration, MCP tool discovery runtime, plugin registry, macOS tool-call card 렌더는 후속 MOMO-160/161/163/170 범위다.

## 0o. MOMO-160 Agent Run Lifecycle v0 (2026-06-26)

- Agent Run Lifecycle v0 정본을 `research/11-agent-runtime/07-agent-run-lifecycle-v0.md`에 추가하고, A2A-style Task/Message/Artifact/status mapping과 `queued/running/input-required/awaiting-approval/succeeded/failed/cancelled` 7상태 의미를 고정했다.
- `input-required`는 추가 입력 요청, `awaiting-approval`은 `approval(status='pending')` 기반 side-effect gate로 분리했다. `clients/Core`에는 current DB `RunStatus`를 public lifecycle로 투영하는 `AgentRunLifecycleStatus`를 추가했다.
- 런타임 코드/스키마 변경은 하지 않았다. DB enum `input_required`, active index, AgentWorker `{phase, run_status}` event payload, approval pause/resume은 후속 migration/runtime goal에서 `runtime-unverified`로 닫아야 한다.

## 0p. MOMO-170 macOS Agent Protocol Cards UX (2026-06-26)

- macOS timeline card 정본을 `research/11-agent-runtime/07-macos-agent-protocol-cards-v0.md`에 추가했다. `tool_call`, `approval_request`, `tool_result`, `artifact`, cost, memory citation, source badge가 Context Packet/Memory Plane/Capability Cache projection으로 표시되는 계약이다.
- `clients/macOS`의 `MessageBubble`에 shared protocol metadata strip을 추가하고, `LiveChatBackend.seedDemo()`가 agent protocol card 4종과 context/source/memory/capability/cost props를 seed하도록 확장했다. `MomoMacRootView` API 변경은 없다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` pass. 런타임 DB/wire alignment, approval pause/resume executor, memory inspector는 후속 MOMO-132/MOMO-161/MOMO-171 범위이며 이번 티켓의 신규 runtime-unverified 항목은 없다(런타임 변경 없음).

## 0q. MOMO-161 Approval Pause/Resume Runtime (2026-06-26)

- Approval Pause/Resume Runtime v0 정본을 `research/11-agent-runtime/08-approval-pause-resume-runtime.md`에 추가하고, fixture를 `research/11-agent-runtime/fixtures/approval-pause-resume-v0/`에 추가했다. 핵심 흐름은 `tool_call → approval_request → approval_decision → resume/deny → tool_result/audit`이며, resume은 새 run이 아니라 같은 `agent_run.id`를 참조하는 새 `outbox(kind='agent_job')`로 정의했다.
- AgentWorker 최소 pause slice를 추가했다. approval-required `tool_call`은 단일 DB tx로 `approval(status='pending')`, `message(type='approval_request')`, `agent_run.status='awaiting_approval'`, `outbox(broadcast)`, `audit_log(action='approval.requested')`를 기록하고 현재 job을 종료해 `succeeded`로 흘러가지 않는다.
- 검증: AgentWorker smoke test가 approval pause plan과 approve/reject/expire outcome을 고정한다. Server approval decision endpoint, resume job execution, expiry sweeper runtime은 후속 구현이며 `runtime-unverified`.

## 0r. MOMO-163 Inbound MCP Server v0 Spec + Fixtures (2026-06-26)

- Inbound MCP Server v0 정본을 `research/11-agent-runtime/09-inbound-mcp-server-v0.md`에 추가하고, 외부 Claude/Codex/Cursor류 host가 momo를 쓰는 최소 surface를 `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call`로 고정했다.
- JSON fixture 2종을 `research/11-agent-runtime/fixtures/inbound-mcp-server-v0/`에 추가했다: tools/resources/prompts discovery snapshot, approval-safe tool-call proposal.
- 런타임 코드/스키마 변경 없음. MCP server runtime, RLS/idempotency integration test, approval executor 연결은 후속 구현 범위다.

## 0r2. MOMO-172 Inbound MCP Server v0 Skeleton (2026-06-26)

- `server` package에 inbound MCP registry/model/route skeleton을 추가했다. `/v1/mcp`, `/v1/mcp/tools`, `/v1/mcp/tools/call`은 app JWT + `mcp.*` scope + workspace match + RLS `SET LOCAL` + member/channel membership preflight를 공유한다.
- `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call` descriptor와 policy를 Swift 코드로 고정하고, docs/INBOUND_MCP.md 및 RUN.md에 endpoint/security/permission model을 기록했다. `search_messages`는 v0에서 1-10개 `channel_ids`를 필수로 받고, 모든 채널 멤버십을 DB 실행 전 검증한다.
- 실제 MCP JSON-RPC transport, canonical `post_message` 실행, approval-safe `create_tool_call` transaction, RLS/idempotency runtime e2e는 `runtime-unverified` 후속 구현이다. 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test` in `server` pass.

## 0s. MOMO-164 Approval Gate Tool Policy Hotfix (2026-06-26)

- MOMO-161 사후 리뷰에서 발견한 approval gate stub 정책을 보강했다. `github.create_issue` 같은 write-like tool name은 approval-required로 처리하고, `github.search_issues`/`docs.search` 같은 read-only name만 v0 stub에서 직접 통과한다.
- unknown tool name은 Capability Cache risk metadata가 AgentWorker job payload에 연결되기 전까지 approval-required로 fail-closed 처리한다.
- AgentWorker가 생성하는 `approval_request` props에 `action_type`, `title`, `summary`를 추가해 macOS protocol card 렌더와 맞췄다.

## 0t. MOMO-165 Capability Cache Approval Metadata Gate (2026-06-26)

- AgentWorker `agent_job.payload`가 Context Packet / Capability Cache projection의 `tool_grants` metadata를 받을 수 있게 하고, G6 approval gate가 `approval_policy`/`risk`/`risk_level`을 tool-name heuristic보다 우선 사용하도록 연결했다.
- `approval_policy=require_approval`/`always`는 approval pause, `approval_policy=never/none/read_only`는 검증된 read-only grant(`grant=read`, `risk=read`)일 때만 직접 진행, metadata 없음/불일치/중복/unknown policy/source/risk alias 충돌은 approval-required로 fail-closed 처리한다.
- approval pause payload/props에 sanitized `tool_grant` evidence를 포함한다. 기존 MOMO-164 name heuristic은 legacy fallback으로만 남겼다. 검증: `swift test` — `workers/AgentWorker` pass. 실제 Hermes runtime e2e와 DB migration은 out of scope.

## 0t. MOMO-171 macOS approval_request Card Decisions (2026-06-26)

- `MomoCore.ChatBackend`에 `ApprovalDecisionRequest`/`ApprovalDecisionReceipt` 기반 approval decision 계약을 추가했다. `AgentTransport.decideApproval`은 호환 shim으로 남기고, macOS `ChatViewModel`의 승인/거절 intent는 `ChatBackend`를 통해 전달한다.
- macOS timeline `approval_request` 카드에 Approve / Reject 액션과 처리중 중복 클릭 방지를 추가했다. `LiveChatBackend.seedDemo()`는 card props와 approval inbox event가 같은 `approval_id`를 공유하며, decision receipt 후 `approval_status`/decision metadata를 message timeline에 반영한다.
- 검증: `swift test --package-path clients/macOS` pass(8 tests), `swift run --package-path clients/macOS MomoMacDevApp` build+launch 후 `MomoMacDevApp` process 및 window 1개 확인. 실제 server approval decision endpoint wiring은 out of scope이며 runtime-unverified.

## 0t2. MOMO-166 Approval Decision Server Contract v0 (2026-06-26)

- Approval Decision Server Contract v0 정본을 `research/11-agent-runtime/10-approval-decision-server-contract-v0.md`에 추가했다. MOMO-161 AgentWorker pause checkpoint, server approval decision endpoint, MOMO-171 macOS `ChatBackend.decideApproval` 흐름을 하나의 API/DB/event 계약으로 연결한다.
- JSON fixture를 `research/11-agent-runtime/fixtures/approval-decision-server-contract-v0/`에 추가했다: approve/reject request/response, expiry sweeper result, same-run resume `agent_job` payload, `approval.decided` realtime envelope.
- 검증: `jq empty research/11-agent-runtime/fixtures/approval-decision-server-contract-v0/*.json`, `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` pass. 런타임 코드/스키마 변경 없음. 실제 decision endpoint, idempotency migration, expiry sweeper, resume execution e2e는 후속 runtime ticket으로 분리하며 `runtime-unverified`.

## 0t3. MOMO-167 Approval Decision Endpoint Runtime (2026-06-29)

- `POST /v1/workspaces/{ws}/approvals/{approval}/decision`과 호환 경로 `POST /v1/agent-runs/{run}/approval-decisions`를 추가했다. app-role tenant transaction + active human/channel membership guard를 통과한 approve/reject만 `approval_decision` ledger, `audit_log`, `approval.decided` outbox를 남긴다.
- approve는 같은 `agent_run.id`를 `queued`로 돌리고 `outbox(kind='agent_job', method='resume_approval')`에 `resume_from_approval_id`/`approved_tool_call`/`policy_evidence`/`approval_decision` payload를 넣는다. reject는 run을 `cancelled`로 닫고 `tool_result` message를 남긴다. expired click은 409 receipt와 durable expired decision/audit을 남긴다.
- 검증: `swift test --package-path server`, `swift test --package-path workers/AgentWorker`, `scripts/verify_approval_decision.sh`, `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-db` pass. 실제 approved tool execution/provider side-effect 재개는 후속 AgentWorker runtime에서 계속 검증한다.

## 0u. MOMO-173 Worker PR Handoff Boundary (2026-06-26)

- worker 종료점을 PR 생성 + `status:needs-review` + `momo-main` handoff로 고정했다. worker는 merge/close/post-merge main gate/로드맵 조정을 하지 않고, 해당 권한은 `momo-main` 전용이다.
- AGENTS/CODEX, multi-session ops, local PR gate, PR template, goal release/status 스크립트가 같은 handoff 계약을 표시한다. `scripts/verify_relay.sh`는 여전히 runtime-relay 전용 미구현 verifier로 남기되 docs gate shell syntax에서만 optional 처리했다. 런타임 코드 변경은 없으며 검증 범위는 docs/script/Swift local gate다.

## 0v. MOMO-005 staging/prod compose skeleton (2026-06-26)

- `infra/prod/docker-compose.prod.yml`, `Caddyfile`, `centrifugo.prod.json`, `.env.example`를 추가해 단일 VPS용 staging/prod skeleton을 준비했다. 구성은 Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker 서비스다.
- 실제 시크릿은 커밋하지 않고 `.env.example` placeholder와 `.gitignore` prod env ignore 규칙만 제공한다. 운영 시크릿 암호화(SOPS/age), pgBackRest, staging 실기동은 MOMO-006/007 후속 범위다.
- 검증: `jq empty infra/prod/centrifugo.prod.json`, `docker compose --env-file infra/prod/.env.example -f infra/prod/docker-compose.prod.yml config`, `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상. 실제 VPS 배포/TLS 발급은 수행하지 않아 `runtime-unverified`.

## 0w. MOMO-010 Onboarding Invite Code Migration (2026-06-26)

- `server/Migrations/003_onboarding.sql`을 추가해 `schema_v0.sql` 정본 변경 없이 `invite_code` + `invite_code_redemption` 테이블, high-entropy code generator/hash helper, expiry/revoke/usage constraints, same-workspace member FKs, active lookup indexes, RLS FORCE 정책을 준비했다.
- `scripts/verify_rls.sh`의 runtime fixture가 `invite_code` FORCE RLS 및 A/B workspace 교차 미노출을 함께 검증하도록 확장됐다.
- 검증: `scripts/local_gate.sh --profile runtime-db` PASS(001/002/003 적용 + 재실행 skip 3 + invite_code RLS), `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. `platform_admin`, onboarding REST, self-signup e2e는 후속 MOMO-011~013 범위다.

## 0x. MOMO-006 SOPS/age + pgBackRest Skeleton (2026-06-26)

- SOPS+age secret lifecycle과 pgBackRest PITR 운영 skeleton을 추가했다: `.sops.yaml.example`, `infra/prod/secrets.env.example`, `infra/prod/pgbackrest*.example`, `docs/SECRETS_BACKUP_RUNBOOK.md`.
- 실제 production secret, age private key, object-store credential은 추가하지 않았다. MOMO-005 prod compose skeleton은 존재하지만 실제 staging host/stanza/check/full backup/PITR restore rehearsal은 `runtime-unverified`로 남는다.

## 0y. MOMO-080 Legal L0/L1 Registration Readiness (2026-06-26)

- `docs/legal/01-entity-apple-runbook.md`를 L0/L1 등록 준비 런북으로 확장했다. 등록주체(개인/조직), D-U-N-S, Apple Developer Program 등록, 필요한 정보/증빙, 사람 handoff와 Codex repo 산출물 경계를 분리했다.
- `docs/legal/00-prelaunch-admin-legal-checklist.md`, `docs/cicd/01-setup-runbook.md`, `docs/INDEX.md`, `ROADMAP.md`가 이 런북을 법무/CI 선행 경로로 참조한다.
- 실제 D-U-N-S 조회/신청, Apple 계약 동의, $99/년 결제, Team ID/API Key/인증서 확보는 사람 `[manual]` 절차로 남아 있다. 이번 티켓은 런타임/코드 변경 없음.

## 0z. MOMO-007 Local/Staging Smoke Gate (2026-06-26)

- `scripts/verify_staging_smoke.sh`를 추가해 실제 VPS 시크릿 없이 prod compose config, Caddyfile 구조, Centrifugo Redis prod config, prod secret template/real-secret guard, SOPS/pgBackRest checklist를 검증한다.
- `scripts/local_gate.sh --profile staging-smoke`를 추가하고 `docs/LOCAL_PR_GATE.md`, `docs/RUN.md`, `docs/DEPLOY.md`, `docs/SECRETS_BACKUP_RUNBOOK.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 local gate + host-runtime 경계로 정렬했다.
- 검증: `scripts/verify_staging_smoke.sh`, `scripts/local_gate.sh --profile staging-smoke`, `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. PR evidence는 clean worktree에서 재확인한다.
- `runtime-unverified`: 실제 staging URL/TLS, Caddy parser/healthcheck(로컬 caddy binary 부재 시), SOPS 복호화, pgBackRest stanza/check/full backup/PITR restore rehearsal, 외부 hermes staging 연결.

## 0aa. MOMO-011 Invite Code REST API Slice (2026-06-26)

- `InviteRoutes`를 추가해 `POST/GET /v1/workspaces/{ws}/invites`, `POST /v1/workspaces/{ws}/invites/{invite}/revoke`, `POST /v1/workspaces/{ws}/invites/redeem` 최소 slice를 구현했다. raw invite code는 create 응답에서만 반환하고 DB에는 MOMO-010의 `momo_invite_code_hash()` 결과만 저장한다.
- 권한 guard는 path workspace와 JWT workspace 일치 확인 + owner/admin active membership(create/list/revoke) + active member redeem으로 닫았다. 모든 invite DB 접근은 `withTenantTransaction`의 `SET LOCAL app.workspace_id` 아래에서 수행해 RLS와 same-workspace FK를 유지한다.
- 검증: `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-db` PASS(전체 swift build/test + Docker compose + migrate 2회 + RLS tenant isolation). 로컬 HTTP smoke도 login 200 → invite create 201 → list 200 → redeem 200 → revoke 200으로 PASS. self-signup의 member/human/membership 생성과 audit_log 기록은 MOMO-014 후속 범위다.

## 0ab. MOMO-012 macOS Onboarding Invite UI (2026-06-26)

- `MomoMacDevApp` sidebar에 invite code 입력/상태 UI를 추가하고, `ChatViewModel`이 `OnboardingInviteBackend`를 통해 join 상태를 게시하도록 했다.
- 실제 서버 `/v1/join`이 완성되기 전까지 `LiveChatBackend`가 `MOMO-012`/`MOMO-DEV` 성공, `EXPIRED`/`USED-UP`/기타 실패를 결정적으로 시뮬레이션한다. 기존 channel/message/approval/cost UI와 `MomoMacRootView` API는 유지했다.
- 검증: `swift test --package-path clients/macOS` pass(10 tests), `scripts/local_gate.sh --profile macos-ui` PASS, `scripts/local_gate.sh --profile swift` PASS. Production invite REST/e2e는 후속 MOMO-014 범위다.

## 0ac. MOMO-130 macOS Foundation Models Capability Probe (2026-06-26)

- `clients/macOS`에 Foundation Models capability probe를 추가했다. Apple framework 접근은 `MomoMac` target 안의 `#if canImport(FoundationModels)` + `#available(macOS 26.0, *)` guard에만 있으며, `MomoCore`는 Foundation-only를 유지한다.
- `SystemLanguageModel.default.availability`를 `available` 또는 server fallback state로 매핑하고, `MomoMacDevApp` sidebar에 Local LLM capability state surface를 추가했다. 미지원 OS/toolchain, device ineligible, Apple Intelligence off, model-not-ready는 모두 fallback으로 표시된다.
- 검증: `swift test --package-path clients/macOS` pass(12 tests), `swift run --package-path clients/macOS MomoMacDevApp` launch 후 System Events window count 1 확인, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. Local summarization/classification runtime은 후속 MOMO-131/174 범위다.


## 0ad. MOMO-162 Hermes Adapter Contract Verification (2026-06-26)

- Hermes integration mode를 두 경로로 고정했다: product default는 momo AgentWorker가 Context Packet / approval / cost / audit를 소유하고 Hermes/Kim Intern을 OpenAI-compatible SSE로 호출하는 경로이며, `adapters/hermes/momo_adapter.py` platform adapter는 optional ingress/interop 경로다.
- 새 정본: `research/11-agent-runtime/11-hermes-adapter-contract-v0.md`. JSON fixture 2종: `agentworker_openai_sse_input.json`, `platform_adapter_event_mapping.json`. Hermes SDK 없이 도는 `adapters/hermes/tests/test_momo_adapter_contract.py` lightweight contract test를 추가했다.
- Swift-facing contract는 변경하지 않았다. 실제 Hermes gateway plugin load/live adapter e2e는 여전히 `runtime-unverified`; MOMO-004의 repo-local OpenAI-compatible mock 기반 AgentWorker SSE 검증은 유지된다.

## 0ae. MOMO-014 Public Invite Join Runtime (2026-06-26)

- Public `POST /v1/join`을 추가했다. invite code + email/display name/handle로 human/member를 생성 또는 재사용하고, workspace의 public channel membership, invite redemption, `audit_log(action='invite.join')`, access/refresh token receipt를 한 tenant transaction 경로로 만든다.
- invite lookup은 별도 RLS 우회 helper 없이 workspace id를 열거한 뒤 각 workspace에서 `SET LOCAL app.workspace_id` tenant read로 code hash를 확인한다. 실제 write path는 계속 `withTenantTransaction` + FORCE RLS 아래에서 수행한다.
- `scripts/verify_join.sh`와 `runtime-db` local gate coverage를 추가했다. 검증 대상: invite create → public join → login/bootstrap/channel read, invalid/expired/revoked/exhausted/duplicate/role-escalation 실패. `schema_v0.sql` 변경 없음.

## 0af. MOMO-013 Platform Admin Read-Only Inspection (2026-06-27)

- `GET /v1/platform/workspaces`, `/v1/platform/members`, `/v1/platform/invites`를 추가했다. `platform:read` scope가 있는 v0 platform admin token만 접근 가능하고, 일반 tenant token은 403이다. v0 login stub의 위험을 줄이기 위해 `PLATFORM_ADMIN_EMAILS` allowlist와 `PLATFORM_ADMIN_LOGIN_SECRET`이 모두 맞을 때만 `platform:read`을 발급한다.
- platform read path는 `PLATFORM_ADMIN_DATABASE_URL`의 별도 BYPASSRLS + SELECT-only role로만 실행되며 `SET TRANSACTION READ ONLY`를 적용한다. 일반 tenant write/read path는 계속 `DATABASE_URL` + `withTenantTransaction`/`SET LOCAL app.workspace_id` 경로를 사용한다.
- `scripts/verify_platform_admin.sh`를 `runtime-db` local gate에 연결했다. 두 개 이상 workspace fixture에서 일반 token 거부, platform 전역 workspace/member/invite usage 조회, invite raw/hash secret 미노출을 검증한다. `schema_v0.sql` 변경 없음.

## 0ag. MOMO-168 Hermes Adapter Repo-Local Smoke Harness (2026-06-27)

- `adapters/hermes/tests/smoke_momo_adapter.py`를 추가해 Hermes SDK/네트워크 없이 `platform_adapter_event_mapping.json` Centrifugo fixture → adapter event unwrap → REST invoke/final-message capture를 검증한다.
- `scripts/local_gate.sh --profile docs`가 adapter `py_compile`, contract unittest, repo-local smoke를 모두 실행하도록 연결했다. adapter docs/contract/ROADMAP/BUILD_TICKETS도 live Hermes boundary를 갱신했다.
- 실제 Hermes gateway plugin load 및 live momo+Centrifugo+Postgres platform-adapter e2e는 여전히 `runtime-unverified` 후속 범위다.


## 0ah. MOMO-122 Google Workspace Connector v0 Spec + Fixtures (2026-06-27)

- Google Workspace Connector v0 정본을 `research/11-agent-runtime/12-google-workspace-connector-v0.md`에 추가했다. v0 기본 경로는 per-user OAuth + Drive/Gmail/Calendar read-mostly sync이며, token boundary, scopes, revocation/delete, Context Packet `sources`, Memory Plane `external_source_ref`, Capability Cache `tool_grants` projection을 고정한다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/google-workspace-connector-v0/`에 추가했다: Drive selected-file source ref/context projection, Gmail thread/search source ref, Calendar availability/events projection.
- Gmail send, Calendar create/update, Drive share/upload/permission change 같은 external write는 approval-gated 또는 v0 out of scope로 명시했다. 런타임 코드/스키마 변경 없음. 실제 Google OAuth/API sync runtime은 후속 구현 범위이며 `runtime-unverified`.

## 0ah2. MOMO-123 Google Workspace Enterprise Admin v0 (2026-06-29)

- Google Workspace Enterprise Admin v0 정본을 `research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md`에 추가했다. MOMO-122 per-user OAuth 기본값과 분리해 enterprise admin install / domain-wide delegation을 enterprise-only option으로 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/google-workspace-enterprise-admin-v0/`에 추가했다: admin install scope inventory, DWD delegated Context Packet/Memory Plane/Capability Cache projection, audit export + revoke/delete flow.
- admin consent, service account boundary, user delegation, scope inventory, audit export, revoke/delete, Context Packet/Memory/Capability invalidation을 문서화했다. 실제 Google Workspace admin 승인/API Controls/OAuth verification/service account credential setup은 사람 `[manual]` 범위이며 runtime/schema 구현은 없다.

## 0ai. MOMO-131 macOS Local Context Copilot v0 (2026-06-27)

- `clients/macOS`에 `LocalContextCopilotService`/preview model과 sidebar `Context Copilot` surface를 추가했다. visible channel messages에서 summary, intent/risk classification, compact context packet preview, PII/secret redaction hint, `S1`-style source/citation hints를 생성한다.
- Foundation Models capability가 available이면 local route로 표시하고, unsupported OS/toolchain/device/model-not-ready 계열은 deterministic fallback route로 같은 preview UI를 유지한다. 실제 Foundation Models generation/session call은 MOMO-174 follow-up 범위이며 v0 shell은 fallback-safe deterministic preview로 검증한다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` pass(16 tests). `scripts/local_gate.sh --profile macos-ui`와 `scripts/local_gate.sh --profile swift` evidence는 PR 전 재확인한다.

## 0aj. MOMO-174 Source-Preserving Local Context Compaction v1 (2026-06-29)

- `LocalContextCopilotService`를 Context Packet 스타일 compact output v1으로 확장했다. summary/classification/redaction/source hints가 `momo.context_packet.compaction.v1` packet에서 파생되고, source id/URI/citation은 compaction 후에도 `sourceReferences`에 보존된다.
- Foundation Models 실제 generation route는 `#if canImport(FoundationModels)` + `#available(macOS 26.0, *)` wrapper 뒤에 두었다. 호출 실패나 미지원 환경은 deterministic fallback packet으로 같은 테스트가 통과한다.
- macOS sidebar는 전체 URI가 들어간 compact packet 대신 짧은 `sidebarPreview`와 2줄 source row를 표시해 preview가 과하게 넘치지 않도록 했다. 검증: `swift test --package-path clients/macOS` pass(16 tests), `scripts/local_gate.sh --profile macos-ui` PASS, `scripts/local_gate.sh --profile swift` PASS.

## 0ak. MOMO-134 macOS SwiftPM Dev Run Loop (2026-06-29)

- `scripts/macos_dev_run.sh`를 추가해 build-macos-apps SwiftPM GUI workflow에 맞춘 dev-only run loop를 고정했다. `MomoMacDevApp`을 빌드하고 `dist/MomoMacDevApp.app`으로 staging한 뒤 `/usr/bin/open -n`으로 실행한다.
- 옵션: `--verify` process/window smoke, `--logs` unified log capture, `--telemetry` subsystem log capture, `--debug` lldb, `--terminate`/`--terminate-only` cleanup. Xcode `.app` 패키징, Developer ID signing, 공증, DMG/Sparkle은 M4 범위로 유지한다.
- `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui`는 새 dev run script로 launch→verify→logs→terminate evidence를 만들고, 기본 `macos-ui` profile은 계속 GUI launch opt-in으로 유지한다. 검증: `scripts/local_gate.sh --profile macos-ui` PASS, `scripts/local_gate.sh --profile swift` PASS.

## 0al. MOMO-175 AgentWorker Local Gate Isolation Hotfix (2026-06-29)

- post-merge `scripts/local_gate.sh --profile all`에서 MOMO-167 approval decision 검증이 생성한 same-run resume `agent_job`가 MOMO-004 AgentWorker verifier 전에 정상 처리되면서 같은 workspace budget window를 함께 소비하는 조합을 확인했다.
- 실제 product/runtime 회귀는 아니었다. DB상 approval resume run과 AgentWorker success fixture run은 모두 `succeeded`, 각 `usage_ledger`는 prompt=11/completion=7/cost=6으로 정확했지만, 공유 `budget_window.spent_micro_usd`가 단독 실행 기대값 `6`이 아니라 `12`가 되어 gate assertion만 실패했다.
- `scripts/verify_agent_worker.sh`는 target run의 `agent_run`/`outbox`/`usage_ledger`/Centrifugo partial 검증은 그대로 엄격하게 유지하고, 공유 workspace budget window는 reservation release와 최소 target spend(`spent_micro_usd>=6`)를 확인하도록 정리했다.

## 0am. MOMO-180 Agentic Work OS Market + Repo Topology ADR (2026-06-29)

- Paca/OpenHands/Linear/Rovo/GitHub Copilot/Slack/MCP/A2A 흐름을 기준으로 momo의 포지션을 "agent execution ledger가 있는 messenger / enterprise agent host / protocol surface"로 문서화했다. 정본: `research/12-agentic-work-os/01-agentic-work-os-market-analysis.md`.
- repo split 판단을 ADR로 고정했다. M3/M4까지 `momo` core monorepo를 유지하고, 안정화 후 `momo-plugins`, first-party plugin repos, plugin SDK repos, `momo-mcp`, `momo-landing`, private `momo-signing` 경계부터 분리한다. 정본: `docs/adr/0001-agentic-work-os-repo-topology.md`.
- Docker/deploy layering은 dev/e2e/prod/install/upgrade/backup으로 나누되, 실제 repo split, plugin runtime, prod installer 구현은 MOMO-181~184 후속으로 남겼다. 코드/스키마/런타임 변경 없음.

## 1. 패키지별 빌드 상태 (로컬 `swift build` 실측)

| 패키지 | 경로 | 빌드 | 비고 |
|---|---|---|---|
| **MomoCore** | `clients/Core` | ✅ **pass** | 공유 모델 + `ChatBackend`/`AgentTransport` 프로토콜. 외부 의존 0(순수 Foundation). |
| **MomoServer** | `server` | ✅ **pass** | Hummingbird 2 + PostgresNIO + JWTKit + AsyncHTTPClient + public `/v1/join` + platform admin read-only inspection + workspace roster read. |
| **OutboxRelay** | `relay/OutboxRelay` | ✅ **pass** | SKIP LOCKED 폴링 → Centrifugo publish. |
| **AgentWorker** | `workers/AgentWorker` | ✅ **pass** | OpenAI 호환 `/v1/chat/completions` SSE + 루프가드 + 비용 reserve/reconcile. |
| **MomoMac** | `clients/macOS` | ✅ **pass** | SwiftUI 라이브러리(뷰+VM) + `MomoMacSmoke` 실행 스모크 + `MomoMacDevApp` window + invite onboarding stub UI + Foundation Models capability fallback surface. |

> ⚠️ SourceKit(IDE) 진단이 `MomoCore`의 일부 파일에 "Cannot find type …"을 표시했으나, 이는 모듈 그래프 없이 파일 단위로 분석한 **stale 경고**다. 실제 `swift build`는 5개 패키지 모두 **clean(exit 0)**.

## 2. 비-Swift 산출물 (정적 + M1 런타임 점검)

| 산출물 | 점검 | 상태 |
|---|---|---|
| `adapters/hermes/momo_adapter.py` | `python3 -m py_compile` | ✅ OK |
| `adapters/hermes/tests/smoke_momo_adapter.py` | fixture 기반 REST invoke/final-message capture smoke(no network) | ✅ OK |
| `infra/centrifugo.json` | JSON 파싱 + `history_meta_ttl > history_ttl`(4 ns) | ✅ OK |
| `infra/docker-compose.yml` | YAML 파싱(postgres:18 + centrifugo:v6 + healthcheck/volume) | ✅ OK |
| `server/Migrations/001_init.sql` | 괄호 290/290 균형, schema_v0.sql 정본 복사 | ✅ OK |
| `server/Migrations/002_seed.sql` | INSERT 구조 정상(괄호 불균형은 `--`주석 내 한글 괄호 → 무해) | ✅ OK |
| `scripts/migrate.sh` | `sh -n` | ✅ OK |
| `scripts/verify_rls.sh` | `sh -n` + Docker PG18 RLS runtime | ✅ OK |
| `scripts/verify_roster.sh` | `bash -n` + Docker PG18 workspace roster runtime | ✅ OK |
| `scripts/verify_join.sh` | `bash -n` + Docker PG18 public join runtime | ✅ OK |
| `scripts/verify_platform_admin.sh` | `bash -n` + Docker PG18 platform admin read-only runtime | ✅ OK |
| `scripts/verify_relay.sh` | `bash -n` + Docker PG18/Centrifugo/MomoServer/OutboxRelay runtime | ✅ OK |
| `scripts/mock_hermes.py` | `python3 -m py_compile` + MOMO-004 SSE runtime | ✅ OK |
| `scripts/verify_agent_worker.sh` | `bash -n` + Docker PG18/Centrifugo/AgentWorker runtime | ✅ OK |
| `infra/prod/*` + `scripts/verify_staging_smoke.sh` | prod compose/Caddy/Centrifugo/secrets/pgBackRest local smoke | ✅ OK (runtime-unverified: staging deploy/TLS/PITR host rehearsal 미실행) |

> **MOMO-001에서 검증됨:** PG18+Centrifugo compose health, SQL 001/002 적용 및 멱등 재실행, MomoServer `/health`, 메시지 송신의 `channel_seq` gapless 발급과 `message`/`outbox` 기록.
> **MOMO-002에서 검증됨:** OutboxRelay SKIP LOCKED claim, Centrifugo `/api/publish`, outbox `pending→done`, Centrifugo history의 `seq=message.seq`.
> **MOMO-003에서 검증됨:** non-superuser app role 기준 RLS FORCE + `SET LOCAL app.workspace_id` 테넌트 격리, relay/worker BYPASSRLS 역할 분리, REST message send/history active membership guard.
> **MOMO-004에서 검증됨:** OpenAI-compatible SSE mock 기반 AgentWorker one roundtrip, Centrifugo `agent.partial`, `usage_ledger` reconcile, `budget_window` reserve/release, G5 budget trip.
> **MOMO-168에서 검증됨:** Hermes optional platform-adapter path의 Centrifugo fixture unwrap과 REST invoke/final-message mapping을 repo-local smoke로 검증(no Hermes/network).
> **MOMO-013에서 검증됨:** 일반 tenant token의 platform endpoint 403, platform read token의 2개+ workspace/member/invite usage 전역 조회, platform BYPASSRLS role의 SELECT-only/read-only transaction, invite raw/hash secret 미노출.
> **MOMO-176에서 검증됨:** `GET /v1/workspaces/{ws}/roster`/`members`는 일반 tenant token + `SET LOCAL app.workspace_id` + active membership guard로 human/agent roster를 반환한다. `scripts/verify_roster.sh`가 demo human+agent, active-membership 없는 member 제외, nonmember 403, workspace A/B 교차 403을 runtime-db profile에서 검증했다.
> **남은 runtime-unverified:** WebSocket live subscribe/presence/recovery, APNs, Inbound MCP JSON-RPC transport/tool execution/canonical write path/RLS-idempotency e2e.

## 3. 생성 파일 트리 (핵심)

```
momo/
├─ schema_v0.sql                 # 정본 스키마(24 테이블, RLS FORCE)
├─ BUILD_TICKETS.md              # 의존순 빌드 백로그 (Phase0 + v1 P1~P6)
├─ Makefile / README.md / docs/RUN.md
├─ infra/  docker-compose.yml · centrifugo.json · .env.example
├─ server/ (MomoServer, Hummingbird 2)
│   ├─ Migrations/{001_init,002_seed}.sql
│   └─ Sources/MomoServer/{Main,App,Config,AppRequestContext}.swift
│       ├─ DB/Database.swift              # PostgresClient 풀
│       ├─ Auth/{JWT,AuthMiddleware}.swift
│       ├─ Realtime/CentrifugoClient.swift
│       └─ Routes/{Message,Auth,Join,Invite,Roster,PlatformAdmin,Centrifugo,DTOs}.swift
│                                                    # 핵심 쓰기경로: seq+outbox tx + public join + roster read
├─ relay/OutboxRelay/   (SKIP LOCKED → publish)
├─ workers/AgentWorker/ (HermesTransport SSE · LoopGuards · CostAccounting · WorkerService)
├─ clients/Core/        (MomoCore: 모델 + ChatBackend/AgentTransport)
├─ clients/macOS/       (MomoMac: ChannelList/MessageList/MessageBubble/AgentPartial/
│                         CostBreathingRing/ApprovalInbox + ChatViewModel/LiveChatBackend)
├─ adapters/hermes/     (momo_adapter.py: BasePlatformAdapter · plugin.yaml)
└─ scripts/{migrate,verify_rls,verify_roster,verify_join,verify_platform_admin,verify_relay,verify_agent_worker,mock_hermes}.*
```

## 4. 컴파일 검증됨 vs 런타임 미검증

- ✅ **컴파일 검증됨**: 5개 Swift 패키지 전부 `swift build` 통과 → 타입·API 계약·시그니처 정합.
- ⛔ **남은 런타임 미검증**:
  - WebSocket live subscribe/presence/recovery, APNs.
  - Inbound MCP JSON-RPC transport/tool execution, canonical `post_message` write path, approval-safe `create_tool_call` transaction/audit, RLS/idempotency e2e.

## 5. 남은 작업

**M1 런타임 후속:**
1. ✅ MOMO-001: docker 환경에서 `make up` → `make migrate`(001→002) → `swift run`(server) 로 헬스체크 + 메시지 송신(seq 발급) 통합 테스트 완료.
2. ✅ MOMO-002: OutboxRelay 기동 + outbox→Centrifugo publish 왕복 e2e 완료.
3. ✅ MOMO-003: RLS 테넌트 격리 + REST message membership guard 런타임 검증 완료.
4. ✅ MOMO-004: AgentWorker↔OpenAI-compatible SSE mock 연결로 김인턴 멘션→`agent.partial` 1회 + 비용 reserve/reconcile + G5 trip 검증 완료.
5. ✅ MOMO-005/006/007: prod compose skeleton, SOPS/age+pgBackRest skeleton, local/staging smoke gate 준비 완료.
6. 남은 M1 host-runtime 배포 축: 실제 staging URL/TLS, SOPS 복호화, pgBackRest stanza/check/full backup/PITR restore rehearsal, 외부 hermes staging 연결.
7. ✅ MOMO-111/112/115: local gate script, 5세션 worktree 운영 자동화, runtime-relay local gate 자동화 완료.

**v0 데모(D/B/C) UI 완성:**
4. `clients/macOS`의 SwiftPM dev app을 기반으로 **Xcode `.app` 번들**로 확장(Developer ID signing/notarytool/DMG/Sparkle은 M4 범위). Live Tool-Call 카드 / Cost Breathing 링 / Approval Inbox 실데이터 바인딩 고도화.

**v1 경험 — 신규 프리미티브(05 경험 문서):**
7. P1 `branch_id`(분기 타임라인, 최대 작업) · P2 reversibility_tier · P3 belief 타입 · P4 autonomy_level · P5 TIE-BREAK decision_ledger · P6 scheduled trigger.

## 5b. QA/릴리스 게이트 (스토어 제출 선행 — 문서/티켓 추가됨, 실행 미진행)

> 추가: 2026-06-24 · "사용 가능 완전 판명" 객관 통과기준 + 베타/크래시계측/e2e·접근성·성능 게이트를 문서·시드이슈로 정의. **측정/판정은 미진행(게이트 OPEN).**

- `docs/cicd/05-qa-release-gate.md` — 게이트 정본. G-A 크래시-free(세션≥99.5/유저≥99.0%) · G-B 핵심플로우 e2e 8/8 · G-C 접근성 치명0 · G-D 성능(런치 p90<2s, hang≈0) · G-E 베타 · G-F 피드백 P0/P1 잔여0 · G-G 릴리스준비 · G-H Enterprise Trust · PASS 기록양식.
- `docs/cicd/06-beta-testflight-plan.md` — TestFlight 내부(≤100)/외부(≤10,000, 첫빌드 Beta App Review) + macOS 공증 .dmg 비공개 베타 + ASC API 피드백 수집.
- `docs/cicd/07-crash-analytics-spec.md` — Sentry Cocoa(1순위, self-host) + MetricKit(보조, 0의존). Crashlytics는 선택지.
- `docs/cicd/08-e2e-accessibility-performance.md` — XCUITest + performAccessibilityAudit(Xcode15+) + XCTMetric.
- `docs/cicd/09-qa-codex-tickets.md` — Q0~Q7 의존순 실행 티켓.
- `docs/cicd/03-store-readiness-gate.md` — G-5 객관기준 + PASS 판정을 05로 링크.
- `scripts/github/issues.tsv` — M3에 QA 시드이슈 7건 추가(gate:qa). 라벨/마일스톤 정합 검증 통과.
- ⛔ 미진행(게이트 OPEN): Sentry/MetricKit 계측 코드, XCUITest/접근성/성능 테스트, qa-gate.yml, 베타 배포·실측·PASS 기록. 선결 = M0 런타임 + C1/C2 Xcode 프로젝트.

## 6. 다음 실행 명령

```bash
# 컴파일 검증(로컬, 지금 가능)
make build                  # 또는 각 패키지에서 swift build

# 런타임(MOMO-001 검증 완료; .env.worktree 또는 .env 사용)
cp infra/.env.example .env
make up                     # postgres:18 + centrifugo:v6
make migrate                # 001_init → 002_seed
(cd server && swift run)    # MomoServer
(cd relay/OutboxRelay && swift run)
(cd workers/AgentWorker && swift run)

# MOMO-004 AgentWorker 런타임 재검증(실제 hermes 없을 때 mock 사용)
scripts/verify_agent_worker.sh
```

> 라이선스: 전 의존성 permissive(Apache/MIT) 타깃. 외부 배포/상용 전 법무 검토 1회 필수(L4 §10).
