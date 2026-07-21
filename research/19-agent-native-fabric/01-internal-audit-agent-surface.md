# 내부 실사 ② — 외부 에이전트 연동 표면 지도: momo-특수 vs 일반화 가능 (2026-07-21, Fable · PLN-20260721-01)

> 목적: opencode/kimi code/grok build/pi 같은 서드파티 코딩 에이전트를 1급 멤버로 붙일 때 필요한 것과 막히는 곳. 기준: main 3cf2d95.

## 핵심 결론 3줄

1. 서버측 계약(신원·런타임·컨텍스트·실행·승인)은 이미 **경로 불가지한 서버-소유 보장 매트릭스**로 설계됐고, gateway REST 계약은 Hermes SDK 없이 구현 가능 — **codex-workbench가 실증**.
2. 그러나 오늘 붙는 방법은 Hermes SDK 상속 또는 momo 자작 어댑터 2종뿐 — "표준 어댑터 SDK"/"에이전트 셀프-온보딩(Agent Card/discovery)" 경로 **없음**(MOMO-313 blocked).
3. 진짜 막히는 곳은 (a) **어댑터 작성**(에이전트가 momo gateway 와이어 계약을 말하게) (b) **work tool의 gateway 경로 미노출**(MOMO-486은 worker 전용) 두 지점.

## (a) 연동 표면 전체 지도 — 5계층

### 계층 1: 수명주기 (신원·자격증명)
- 에이전트 멤버 생성: `server/Sources/MomoServer/Routes/AgentRoutes.swift:24`(`POST /v1/workspaces/:ws/agents`, 사람-관리자 전용 `:29-31`) — member(kind='agent') `:74-86` + agent(model/base_url/system_prompt/config/owner_human_id) `:88-98` + workspace_membership `:100-106` + audit `:108-126`. **채널 멤버십·자격증명은 의도적 별도 결정** `:6-11`.
- config 자격증명 fail-closed 차단 `:13-17,:235-257`(ADR-0004 스키마 강제). base_url 검증 `:171-223`(https 강제·loopback opt-in·OpenAI-compat 라벨).
- per-agent bearer(ADR-0101): `AgentCredentialRoutes.swift:23-30`(발급/목록/revoke), mint `Auth/AgentBearerToken.swift:12`(`momo_agent_v1.<ws>.<32B>`), sha256 digest만 저장 `:79-92`, 원문 1회 노출 `:119-134`, 스코프 6종 하드코딩 `:11-18,:263-278`(`agent:jobs:read, agent:runs:callback, messages:read, messages:write, realtime:subscribe, work:control`), 회전 grace 24h~7d `:60-77`.
- 스키마: `001_init.sql:45,:73,:334`. token kind `delegation`(actor/subject 위임)은 **스키마만 — ADR-0101 Phase 2 예약**.

### 계층 2: 런타임 연결 (ADR-0102 Option C 이중 경로)
- **경로 A — Hermes Gateway(BYOA, 실 트래픽 전부)**: `AgentGatewayRoutes.swift:35-50`(`GET .../gateway/jobs/pending`, lease renew/release, `POST .../agent-runs/:run/gateway/events`, `.../gateway/complete`). claim=FOR UPDATE SKIP LOCKED+30s 리스 `:76-140`, events(status/partial/approval, rate 240/60s) `:235-447`, 승인 기록 `:449-637`, complete(최종 메시지+usage reconcile+idempotent client_msg_id=runID) `:639-899`. dispatch: `AgentRunRoutes.swift:133-165`(outbox `method='gateway'` + `agentwork:` wake).
- **경로 B — AgentWorker SSE(managed, 현재 미사용)**: `WorkerService.swift:54-93` 루프, claim(`method <> 'gateway'`) `:150-174`, Hermes OpenAI-compat SSE `:331-460`. provider 키=전역 `HERMES_API_KEY`.
- realtime 경계: `agentwork:ws<ws>.<agent>`=private wake-up(self-only), `agent:ws<ws>.<ch>.<agent>`=관찰 가능 status/partial. realtime은 wake-up일 뿐, 실행은 bearer 인증 REST 재조회(`momo_adapter.py:803-808`). 인증 해석: `AuthMiddleware.swift:83-105`, 라우트→스코프 매핑 `:142-245`.

### 계층 3: 컨텍스트 계약
- agent_job 페이로드: `AgentJobPayload.swift:13-102` — run_id/agent_member_id/channel_id/model/prompt/system_prompt/**recent_messages**/tools(OpenAI defs)/**tool_grants**/max_output_tokens/gate seeds/resume_from_approval_id. tool_grant 메타 `:160-292`(provider·risk_level·approval_policy·allowed/denied_operations·capability_version — 승인 티어 판정 입력).
- gateway측 live grant 투영: `momo_adapter.py:520-667`(`GET .../plugins?delegatedMemberId&channelId` → packet-스코프 tool policy, fail-closed).
- A2A 정합 문서: `research/11-agent-runtime/07-agent-run-lifecycle-v0.md:79-95`(agent_run↔A2A Task, contextId↔ws+ch+thread+packet).

### 계층 4: Work 실행 — "대화 멤버" vs "터미널 세션"
- (4-1) 대화 멤버: mention→agent_run→채널 응답(계층 2 그대로).
- (4-2) 터미널 세션(ADR-0114+0125): `WorkControlRoutes.swift` — Kind enum `:58`, create(agent bearer 전용 `:92`, run binding `:867-912`, host 검증 `:914-960`, lineage `:982-1019`), spawn 승인+auto-approve `:136-148,:613-766,:396-443`, dispatch outbox `work.control.dispatched` `:768-824`, ack `:219-328`. host 레지스트리 `021_work_host.sql:10`, host 인증 `AuthMiddleware.swift:43-62`.
- **CLI가 실제 스폰되는 3형태(전부 서버 밖)**: ①mac 앱 내장 — `MomoLocalTerminalSession.swift:157-169` **진짜 PTY**(SwiftTerm), 도구 resolve `:72-115`, 샌드박스 fail-closed `:59-61` ②workd — `WorkDaemon.swift:48-140`→`ProcessManager.swift:32-66` **PTY 아님**(Process+Pipe, stdout 로그파일) ③codex-workbench — `codex_workbench.py:462-609` **헤드리스**(`codex exec --json`), 2티어 sandbox `:77-95`, workspace-write 승인 왕복 `:758-830`.

### 계층 5: 승인·감사
- approval `001_init.sql:307`, worker pause/resume `WorkerService.swift:1276-1428,:876-944`(frozen payload 검증 `:979-1006`), gateway 왕복 `AgentGatewayRoutes.swift:449-637`, spawn 승인 `WorkControlRoutes.swift:613-766`, 결정→resume `ApprovalDecisionRoutes.swift`, 전 경로 `via_token_id` provenance. sandbox 티어→승인 매핑(ADR-0111 D3): read-only=자동, workspace-write=승인, network/danger=fail-closed.

## (b) 계층별 판정: momo-특수 vs 일반화 가능

| 계층 | momo-특수 | 일반화 가능 | 판정 |
|---|---|---|---|
| 수명주기 | 스키마·owner_human_id 위임·토큰 형식 | bearer 발급/회전/스코프(Slack `xoxb-` 동형), 생성 REST | **일반화 완료** — 서드파티는 REST 호출만 |
| 런타임 연결 | Centrifugo 채널명·outbox·lease 세부 | **gateway REST 와이어 계약(pending/events/complete/lease)** | **일반화 실증됨**(codex-workbench가 SDK 없이 구현). 계약=일반, 전송=momo-특수 |
| 컨텍스트 | packet/grant 투영 로직 | tool_grants의 OpenAI tool-def+risk 투영 형태, A2A contextId 정합 | 에이전트는 읽기만 — **일반화 가능** |
| Work 실행 | 4-verb 원장·Ed25519 host·세션=스레드 | `work.spawn/input/read/kill` tool 계약 자체 | 도구 화이트리스트 `["claude","codex","opencode","shell"]` 하드코딩(`WorkControlRoutes.swift:507`) — **실제 확장 편집 지점** |
| 승인·감사 | 스키마·resume outbox | 승인 티어(read_only/workspace_write/network_write) | 서버 기계장치로 경로 무관 강제 — **일반화 완료** |

## Hermes adapter vs codex-workbench — 일반화 경계의 살아있는 증거

| | `adapters/hermes/momo_adapter.py`(2438줄) | `adapters/codex-workbench/codex_workbench.py`(1279줄) |
|---|---|---|
| Hermes SDK | **의존**(`BasePlatformAdapter` 상속 `:124-135`, hermes_runtime 주입 `:426`) | **무의존** — 순수 stdlib, gateway REST 직접 `:347-451` |
| momo 프로토콜 부분 | agentwork: 구독 `:738-757`, pending claim `:1077-1138`, redaction `:65-91` | 동일 계약 독립 구현 `:351-404` |
| 실행 엔진 | Hermes 소유 provider(OpenAI-compat SSE) | 호스트 codex CLI(`CodexRunner` `:462-609`) |

→ **서드파티 온보딩의 출발점은 momo_adapter.py가 아니라 codex_workbench.py 복제.**

## inbound MCP skeleton 실체

- `InboundMCPRoutes.swift:14-18` HTTP 골격(JSON-RPC 아님), preflight 실수행·실행은 `momo.mcp.runtime_stub` 에러 `:71-91`. 툴 4종+resource/prompt 정의 `InboundMCPToolRegistry.swift:18-259`, protocolVersion "2025-06-18" `:11`, runtime-unverified `:288`. `mcp.*` 스코프 발급 경로 없음(`research/13-redesign/01:35`).
- 1급 멤버 온보딩에는 필수 아님(그건 gateway 경로) — momo를 "컨텍스트 소스 MCP"로 소비하는 시나리오에서만 필수.

## 프로토콜 표준화 논의 — 이미 있었고, blocked

- `research/13-redesign/01-agent-native-redesign-2026-07.md:13` "이미 설계된 에이전트 프리미티브를 표준 프로토콜(MCP/A2A/AG-UI) 위에 올리는 것", `:69` "MCP+A2A+AG-UI 삼각 채택, ACP 무시. AG-UI 이벤트 어휘를 agent.partial/status envelope 정렬 기준으로", `:60` openagents 레퍼런스("단일 포트 `/a2a`+`/mcp`, `/.well-known/agent.json` Agent Card").
- **`MOMO-313 | A2A Agent Card + agents/announce 초대 | blocked(308)`** (`research/13-redesign/00-execution-tracker.md:65`) — 셀프-온보딩 티켓이 이미 발급됐으나 막혀 있음.
- `research/11/07:17,79-95` agent_run↔A2A Task 내부 정렬. `research/12/01:109` "A2A mapping은 내부 호환으로만, 아직 공개 API 아님" 명시적 유보. ADR-0111 `:63` "후속 결정 예약: A2A/Agent Card 정렬".

## (c) 서드파티 코딩 에이전트 1개(예: opencode) 붙이기 — 오늘 기준

**바로 되는 것**: ①생성 REST ②bearer 발급 ③채널 초대 ④gateway 어댑터(codex-workbench 템플릿 — 인증·리스·redaction·idempotency 복붙 가능) ⑤승인·비용·감사(서버 자동).

**작성 필요(어댑터 레벨, 코어 무수정)**: ⑥출력→momo 이벤트 번역(`_render_codex_event` `:1064-1089`·`_structured_completion` `:953-979`·`_gateway_usage` `:1092-1107` 상당) ⑦권한 모델→승인 티어 매핑.

**코어 수정 필요(막힘)**:
- **[막힘 A] work tool의 gateway 경로 미노출** — work tool-call 배선은 worker 전용(`WorkerService.swift:358-410`, WorkToolDispatcher). gateway BYOA 노출은 명시적 후속(`QA_FOLLOWUP.md:39`). → gateway로 붙인 서드파티는 "대화"는 되지만 "CLI 스폰"은 안 됨.
- **[막힘 B] 도구 화이트리스트 하드코딩** — 서버 `WorkControlRoutes.swift:507` + mac 앱 launch spec + workd 템플릿 **3곳**. opencode는 우연히 포함, kimi/grok/pi는 3곳 수정 필요. ADR-0114 D7 "임의 셸" 설계는 있으나 코드는 고정 목록.
- **[막힘 C] worker 경로 provider 키 전역 고정**(`HERMES_API_KEY`, per-agent BYOK 없음 — `research/13-redesign/01:42` P5). gateway(BYOA)는 무관 — **서드파티는 gateway 권장**.
- **[선택] 셀프 온보딩** — Agent Card/discovery(MOMO-313) blocked, 사람이 수동 등록.

**우선순위 판단**: 최속 경로=gateway BYOA "대화 멤버"(코어 수정 0+어댑터 1개). "터미널 세션까지"는 막힘 A+B 해소 선행(X-7 계열 엔진 티켓). A2A Agent Card는 별도 트랙.
