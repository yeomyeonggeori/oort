# ADR-0130: 외부 코딩 에이전트 멤버십 — ACP 클라이언트로 임의 에이전트를 1급 멤버로

- Status: **Accepted** (2026-07-21, 성재 — "위 내용을 main에 설계 기반으로 아주 상세하게 풀어내고 트랙으로 실행" 지시로 권고안(D1-A·D2-A·D3-A·D4=v0 B/Card 2단계·D5-A) 승인. 실행 정본: `docs/planning/handoffs/2026-07-21-agent-native-fabric-batch.md`)
- 관련: research/19-agent-native-fabric/01(연동 표면 실사)·02(프로토콜 지형), ADR-0101(bearer)·0102(이중 경로)·0111(BYOA)·0114(Work Console, D7 도구-불가지 프로파일)·0125(Host Fabric)·0126(관전 D4 워크스페이스 소유 세션), research/13-redesign(MCP/A2A/AG-UI 삼각 채택 — 본 ADR은 그 공개-표면화 1단계), MOMO-313(A2A Agent Card, blocked — D4가 승계)
- 발단: 성재(CTO 대화, 2026-07-21) — "opencode·codex·grok build·kimi code·pi 같은 코딩 에이전트도 광의의 에이전트다. 호스팅해서 연동하고 사용할 구멍이 있지 않을까. 핵심은 에이전트와 소통하는 방식 — 기존 에이전트들도 더 잘 쓸 수 있는 느슨한 규격."

## Context

1. **연동 표면은 8할 준비**(19-01 실사): gateway REST 계약(pending/events/complete/lease)은 provider-불가지이고 **codex-workbench가 Hermes SDK 없이 순수 momo 계약으로 동작함을 실증**. 서드파티 온보딩의 남은 병목은 ①work tool의 gateway 경로 미노출 ②도구 화이트리스트 하드코딩(`["claude","codex","opencode","shell"]` — 서버·앱·workd 3곳) ③셀프 온보딩 부재(MOMO-313 blocked).
2. **업계는 ACP(Zed Agent Client Protocol)로 수렴 중**(19-02): 코딩 에이전트 40+가 네이티브/공식 어댑터로 ACP를 말한다(Gemini CLI·opencode·Kimi CLI·Goose·Qwen·Cline·OpenHands 네이티브, Claude Code·Codex는 Zed 제작 어댑터, Registry 배포). JSON-RPC over stdio, `session/prompt`→`session/update`(진행/plan)→`session/request_permission`(승인)→`terminal/*` — **momo의 세션=스레드·승인 카드·PTY 세션 매니저와 어휘가 거의 1:1**. 비-에디터 클라이언트 선례 존재(marimo·Toad).
3. 대안 비교: 에이전트별 어댑터 N개(현행 codex-workbench 방식만) — 유지비 선형 증가. A2A — 원격 서비스 호출 규격이지 로컬 CLI 호스팅이 아님. MCP — stateless로 진화 중이라 상주 세션 모델과 반대 방향. Grok Build만 ACP 미확인(별도 어댑터 또는 보류).
4. Slack·업계 비교: Slack은 에이전트 표면을 독점 API로 채우는 중(스트리밍 API·Agent 탭). momo는 열린 표준(ACP) 채택 + 자체 계약 공개로 반대 포지션 — 향후 "Agent Membership Protocol" 스펙 추출(19-02 §4 옵션 B, 제품 질량 확보 후)의 전제.

## Options

### D1. ACP 클라이언트 — momo-acp-host
- **A (권고)** — work host 계층(앱 세션 매니저+workd)에 **ACP 클라이언트 1개**를 구현: ACP `session/*`↔`work_session` 원장, `session/update`→세션 스레드 카드(AG-UI 정렬 envelope 재사용), `session/request_permission`→momo 승인 카드(0114 D5), `terminal/*`→기존 PTY 세션 매니저. ACP Registry의 에이전트를 도구 후보로 노출. 서버 계약(work.control 4-verb·승인·감사)은 무변경 — **ACP는 호스트-로컬 전송 계층**이며 raw는 서버 비경유(0125 D10 유지).
- B — 에이전트별 어댑터 계속 증설: 유지비 선형, 신규 에이전트마다 재작업. **기각(기존 codex-workbench는 유지·병존).**
- C — ACP 없이 자체 규격 먼저 공개: "규격 먼저"는 채택 역학상 전패 패턴(19-02 §3). **기각.**

### D2. work tool의 gateway 경로 노출 (막힘 A)
- **A (권고)** — worker 전용인 work tool-call 배선(WorkToolDispatcher)을 gateway 이벤트 계약에도 노출 — gateway BYOA 에이전트가 `work.spawn/input/read/kill`을 tool_call로 낼 수 있게. 승인·감사·host 라우팅은 기존 서버 기계장치 그대로(경로 불가지 보장 매트릭스 유지). QA_FOLLOWUP의 기존 후속(X-7 계열) 성문화.

### D3. work_tool 프로파일 원장 (막힘 B — ADR-0114 D7 정합 회복)
- **A (권고)** — 하드코딩 배열 3곳을 서버 원장 `work_tool_profile`(workspace_id, tool_key, display_name, launch_template, tier_defaults, enabled, 감사)로 승격. 앱/workd는 원장 투영을 소비(fail-closed: 미등재 도구 spawn 거부). 기본 시드=현행 4종. kimi/grok/pi/임의 CLI는 관리자 등록으로 확장 — 코드 수정 불요.
- B — 하드코딩 유지+PR로 도구 추가: 설계(D7 "임의 셸")와 계속 불일치. **기각.**

### D4. 셀프 온보딩 — A2A Agent Card (MOMO-313 승계)
- **A (권고)** — `/.well-known/agent.json` Agent Card(A2A v1.0 정합·JWS 서명) 게시 + 관리자 승인형 `agents/announce`(에이전트가 자기 capability를 제출하면 승인 카드로 수락 — 자동 join 아님, 승인 원장 경유). 원격 에이전트의 A2A 태스크 바인딩은 후속(스펙 추출 시).
- B — 수동 등록 유지: v0로는 충분하나 "기존 에이전트들도 잘 쓸 수 있는" 개방성 목표에 미달. **v0=B 유지, D4는 2단계 예약**(우선순위는 D1~D3 뒤).

### D5. 어댑터 템플릿 공개
- **A (권고)** — codex-workbench를 일반화한 "momo gateway 어댑터 템플릿"(인증·리스·이벤트·redaction 골격) + "momo에 에이전트 붙이기" 문서를 오픈소스 공개분에 포함. 향후 Agent Membership Protocol 스펙 초안(제품 질량 확보 후 — 19-02 §4 옵션 B)의 씨앗.

## Decision (Proposed 권고안)

D1-A(momo-acp-host) · D2-A(gateway work tool) · D3-A(프로파일 원장) · D4-B→A 2단계(v0 수동, Card는 예약) · D5-A(템플릿 공개) — 성재 승인 대기.

## Consequences

- (+) ACP Registry의 40+ 코딩 에이전트가 즉시 momo 세션 도구 후보 — "임의 코딩 에이전트를 팀이 관전·승인·논의하는 메신저" 포지션 확보.
- (+) R3(화이트리스트)·R4(workd 비-PTY) 정합 이슈가 D1·D3에서 자연 해소. 0126 D4(워크스페이스 소유 세션)와 결합 시 "팀 공유 코딩 에이전트" 완성.
- (+) "메신저형 ACP 클라이언트" 첫 선례 — 향후 스펙 제안(옵션 B)의 실탄이자 도그푸딩.
- (−) ACP 거버넌스는 Zed 단독(재단 미소속) — chat-profile 확장이 업스트림에 거부되면 `_meta` 확장으로 유지(포크 아님).
- (−) 에이전트별 이벤트 품질 편차(plan/진행 보고 밀도)는 카드 렌더의 최소 공통분모 설계 필요.
- 파생(Accepted 시 발급 예약): **MOMO-530**(엔진 — gateway work tool 노출+경로 불가지 verifier) · **MOMO-531**(엔진+호스트 — momo-acp-host v0: ACP 세션↔work_session·승인·터미널 브리지, workd PTY 정합 포함) · **MOMO-532**(UXUI — 도구 프로파일 관리+에이전트 세션 카드 ACP 이벤트 렌더) · **MOMO-533**(엔진 — work_tool_profile 원장+3곳 하드코딩 제거, fail-closed 투영).
