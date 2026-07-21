# 내부 실사 ① — 컨텍스트/메모리 서빙 계층의 현재 구현 상태 (2026-07-21, Fable · PLN-20260721-01)

> 발단: 성재 발제 — CTO 대화에서 나온 4대 고민(Figma식 cowork·외부 코딩 에이전트 호스팅·에이전트-메신저 프로토콜·컨텍스트/메모리 인프라) 중 "메신저가 에이전트를 위해 컨텍스트를 핸들링한다"의 현재 좌표 확인.
> 기준: main 3cf2d95. CURRENT_STATE.md의 "채널 히스토리 조립 v1은 있으나 Context Broker/Packet 실조립 미완, Memory Plane/Capability Cache는 스펙만 정본화" 서술이 코드와 일치함을 확증. 정본 gap 판정 선례: `research/14-superapp-engine/00-pln-20260714-02-gap-audit.md:34-40`.

## 1. Context Packet

**(a) 정본 스펙**
- `research/11-agent-runtime/04-context-packet-v0.md` (MOMO-151) — v0 규범 스펙. `:4` "No runtime/schema implementation in this ticket". 16개 최상위 필드 shape `:28-49`, 비협상 규칙 `:14-22`, 금지 필드 `:321-332`.
- 참조: `docs/architecture/overview.md:24`, ADR-0102. fixtures: `research/11-agent-runtime/fixtures/context-packet-v0/`.

**(b) 구현**
- 서버 조립: `server/Sources/MomoServer/Routes/MessageRoutes.swift`
  - `contextPacketProjection()` `:2013-2060` → `momo.context_packet.mention_projection.v0`. **부분 projection**: `request`/`scope`/`recent_messages`/`sources`/`tool_grants`의 5필드만. **v0 대비 결손**: `packet_id`/`packet_version`/`created_at`/`expires_at`/`goal`/`participants`/`memory_refs`/`budget`/`redactions`/`runtime_envelope`/`audit` 전부 없음.
  - `loadRecentMessages()` `:1528-1638` — same-channel 히스토리 창(스레드 우선 root+replies → 채널 최신 보충, system/deleted 제외, seq ASC). 기본 30건, 1~200 clamp(`AGENT_CONTEXT_MAX_MESSAGES` `:1517-1521`).
  - `recentMessageBody()` `:1670-1709` — 텍스트 2000자 절단, 구조화 타입은 `[tool_call: name]`식 요약(raw JSON 미유출).
  - `readOnlyToolGrants()` `:2062-2073` — **하드코딩 mock grant**(`github.search_issues`, `mock-github@0.1.0`). 실 Capability Cache projection 아님.
- 워커 소비: `workers/AgentWorker/Sources/AgentWorker/ContextAssembler.swift`(MOMO-302) — recent_messages → OpenAI chat 배열 매핑, 문자예산 초과 시 최오래 non-trigger drop·trigger 항상 유지. `WorkerService.swift:310-330`, `AgentJobPayload.swift:24,124-144`.

**권한 필터링 실체**
- 에이전트 채널 멤버십 게이트(fail-closed): `MessageRoutes.swift:1437` `agent_not_channel_member` skip, EXISTS 서브쿼리 `:1478-1484`.
- RLS: `withTenantTransaction`(SET LOCAL app.workspace_id) 안에서 실행 — 워크스페이스 격리 + channel_id 명시 필터. packet의 `permission_basis` `:2047-2051`는 라벨이며 실강제는 에이전트 멤버십+워크스페이스 RLS+channel 필터.

**(c) 갭**: 히스토리 창 조립·요약·예산은 실동작하나 packet은 5필드 partial projection — memory_refs·budget·redaction·불변 저장/버전/만료·실 tool_grants 부재로 v0 "immutable Context Packet 계약"의 1/3 수준.

## 2. Memory Plane

**(a) 정본 스펙**: `research/11-agent-runtime/05-memory-plane-v0.md` (MOMO-152). 6개 memory type `:94-115`, write/retrieval 이중 게이트 `:224-254`, 후보 DB shape §15 `:345-364`(`memory_item`/`memory_source_ref`/`memory_visibility_grant`/`memory_lifecycle_event`/`memory_candidate` — 전부 RLS FORCE), BYPASSRLS 금지 `:28,364`. fixtures 있음.

**(b) 구현: 서버에 없음.** 마이그레이션 001~026 전체에 memory 테이블 0개. packet에 `memory_refs` 필드 자체가 없음. 유일한 메모리성 코드 `clients/macOS/Sources/MomoMac/LocalContextCopilot.swift`는 Apple FoundationModels **온디바이스 compaction**(`momo.context_packet.compaction.v1` `:96`)으로 서버 Memory Plane과 무관한 로컬 기능.

**(c) 갭**: 타입/출처/권한 재검증/만료/삭제/감사 스펙·fixture 완비, 서버 테이블·API·retrieval 게이트·무효화 전무 — 순수 spec-only.

## 3. Capability Cache

**(a) 정본 스펙**: `research/11-agent-runtime/06-capability-cache-v0.md` (MOMO-153) — 4개 cache kind `:66-77`, TTL/staleness `:220-238`, 무효화 `:240-268`, DB shape §15 `:310-329`. ADR-0113 `:25,43`, `docs/architecture/overview.md:47`.

**(b) 구현: 부분(스펙과 다른 좁은 형태).**
- `server/Migrations/013_plugin_registry.sql:75` `plugin_capability_projection`(SE-04A) — plugin_id/scope/tool_name/capability_version/schema_digest/risk/approval_tier/grant_id. RLS FORCE `:106-120`, credential 부재 명시 `:6-8,:27`.
- 그러나 v0의 `capability_cache_entry`(4-kind·validity·invalidation·refresh_policy·schema_ref·audit stream)는 아님. 런타임 미연결: mention 경로 tool_grants는 mock(`MessageRoutes.swift:2062`), projection→packet 실주입 경로 없음.
- 어댑터 조립 지점: `adapters/hermes/momo_adapter.py:520` `_payload_with_plugin_tool_policy` — live grant 기반 tool policy 조립(실 grant 소비).

**(c) 갭**: 정적 projection 테이블은 랜딩, v0 cache 의미론(TTL·무효화·4-kind)과 런타임 소비는 없음 — spec-only + 얇은 정적 projection.

## 4. 에이전트가 컨텍스트를 받는 전체 경로

- **트리거→enqueue**: `MessageRoutes.swift` `routeAgentMentions()` `:1413` → 멤버십 게이트 `:1437` → `enqueueMentionJob()` `:1725`: `loadRecentMessages` `:1753` → `INSERT agent_run` `:1763`(idempotency) → payload(recent_messages+packet projection) `:1778` → `INSERT outbox kind='agent_job'` `:1793` → gateway 활성 시 `agentwork:` broadcast `:1817` → `audit_log 'agent.mention.queued'` `:1838`.
- **이중 delivery(ADR-0102 Option C)**: ①worker 경로 — `WorkerService.swift` outbox claim(partition_key=agent_member_id 직렬화) → `ContextAssembler.assemble` `:310` → `HermesTransport.invoke` SSE `:331`. ②gateway 경로 — `adapters/hermes/momo_adapter.py` `agentwork:` 구독 → packet projection 추출 `:556` → plugin tool policy 보강 `:520` → 에이전트 호출.
- **Inbound MCP skeleton**: `server/Sources/MomoServer/Routes/InboundMCPRoutes.swift` `:14-17`(`GET /v1/mcp`, `/v1/mcp/tools`, `POST /v1/mcp/tools/call`) — scope·workspace·`preflightVisibility` 보안 preflight는 실수행, 실행은 항상 `isError:true` stub `:71-91`. `InboundMCPToolRegistry.swift` 4 tool + `requiresContextPacketOrAPIPacketBuild`/`requiresCapabilityCacheProjection` 정책 플래그 `:44-170`, `runtimeStatus: runtime-unverified` `:288`.

**갭**: enqueue→outbox→이중 delivery·감사 골격은 실동작. inbound MCP는 preflight-only stub이며 tool 실행이 실 packet/cache 검증을 소비하지 않음.

## 5. pgvector / 임베딩 / 검색

- **pgvector·임베딩·시맨틱 검색: 전무**(확장/컬럼/연산자/인덱스 0건).
- **FTS(tsvector) 없음.** 검색은 `SearchRoutes.swift` — 순수 ILIKE `:74,:113`, 메타문자 이스케이프 `:141-147`, membership JOIN RLS 강제 `:61-70`, keyset cursor `:75-79`, rate-limit 30/60s. 랭킹은 recency뿐.

**갭**: 검색은 RLS-안전 ILIKE v1(MOMO-386)만 — 신규 메모리/시맨틱 설계는 완전 그린필드.

## 6. 사용자 가시성

- 부분 가시: `usage_ledger`/`budget` + `CostProjectionRoutes.swift:19`(cost-snapshots), `audit_log` 적재(사용자 대면 열람 라우트는 제한적), macOS `AgentProtocolCardMetadata.swift:30`(카드가 context_packet 파싱 렌더), `AlphaCommandCenterView.swift:185-190,:223`.
- `LocalContextCopilotView`는 로컬 생성물 미리보기 — 서버 서빙 packet 아님.
- **"이 run에 무엇이 서빙됐나" 감사 인스펙터 표면: 부재**(MOMO-171 미구현).

## 신규 메모리/컨텍스트 인프라 설계 시 지켜야 할 기존 불변식 (코드 근거)

1. **PG=SoT, Centrifugo=transport only** — `CURRENT_STATE.md:102`, `docs/architecture/overview.md:24`.
2. **단일 쓰기경로 REST→PG tx→outbox→relay** — `MessageRoutes.swift:1793-1824`.
3. **RLS FORCE + 테넌트 격리** — 선례 `013_plugin_registry.sql:106-120`, `009_workspace_tenant_rls.sql`; 스펙 `05-memory-plane-v0.md:357-364`.
4. **BYPASSRLS 금지**(사용자 대면 retrieval/projection) — `05-memory-plane-v0.md:28,364`, `06-capability-cache-v0.md:27,329`.
5. **자격증명 비유입** — `CURRENT_STATE.md:105-106`, `013_plugin_registry.sql:6-8,:27`, `04-context-packet-v0.md:296-302,321-332`.
6. **non-user-input fact는 source ref 필수** — `04-context-packet-v0.md:18,163-192`, `05-memory-plane-v0.md:21-27`.
7. **불변 packet + 재검증**(정책/가시성 변화 시 재발급) — `04-context-packet-v0.md:22,233`, `06-capability-cache-v0.md:26`.
8. **위험 쓰기 = 승인 정지점**(`tool_call→approval_request→tool_result→audit_log`) — `InboundMCPToolRegistry.swift:153-169`.
9. **에이전트=`member.kind='agent'` 1급 멤버, 채널 멤버십 fail-closed** — `MessageRoutes.swift:1437,1478-1484`, `InboundMCPRoutes.swift:95-118`.
10. **채널 경계 불혼합**(same-channel only, 구조화 payload는 요약만) — `ContextAssembler.swift:5-9`, `MessageRoutes.swift:1670-1709`.
11. **경계 변경은 Accepted ADR 선행**(Memory/Capability 런타임 착수는 보안 ADR 승인 선결) — `CURRENT_STATE.md:107,115`, gap-audit `:24`.

## 결론

실동작: ①same-channel 히스토리 창 조립(worker+server 2경로) ②RLS-안전 ILIKE 검색 ③plugin grant 정적 projection ④비용/승인 표면. 나머지(불변 packet·Memory Plane·Capability Cache 런타임·inbound MCP 실행·시맨틱 계층·서빙 감사 인스펙터)는 스펙만 정본화된 미구현 — **성재의 "메신저 레벨 컨텍스트 핸들링" 비전 대비, 뼈대 스펙은 2026-06에 이미 서 있고 런타임이 통째로 비어 있는 상태.**
