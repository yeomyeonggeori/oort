# 핸드오프 패킷 RN-B2 — 관전 축 폰 마감: 턴 신호 + 중단·paused 소비 (2-goal 체인)

- status: **ready** · 배치 2 「관전의 마감」 · owner/integrator: Fable(momo-main)
- worker: Opus 5 (모바일 전담) · 기준: **`origin/track/engine` 최신**(`a604eb2f` 이후) · 새 워크트리
- 순서: goal 1(턴 신호)은 즉시. **goal 2(중단 컨트롤·roster paused 소비)는 SRV-B2의 서버 두 PR이 track/engine에 머지된 뒤** 착수(오케스트레이터가 신호를 준다).
- 병렬 경계: SRV-B2 워커가 `server-rust/**`를 전담한다 — **서버 수정 금지.** momo-core는 순수 규칙 추가만(React/RN 참조 금지 — `gate:purity`).

## Goal 1 — 폰 「작업 중」: 실시간 턴 신호 배선

**왜**: #980의 폰 에이전트 탭은 "세션 실행 중"까지만 말한다(웹의 "작업 중"=열린 턴과 의도적으로 갈라 둔 상태 — `AgentsScreen.tsx`의 주석이 그 경계다). 규칙은 이미 core에 있고(`@momo/core/features/agents/workingSignal` — RN-A1이 웹에서 꺼냄), 웹 스토어 주석이 명시한다: *"React Native will subscribe to its own realtime rail when it has one."* 폰에는 이미 레일이 있다 — 이제 구독한다.

**있는 것 (전부 실측)**:
| 무엇 | 위치 |
|---|---|
| 모바일 realtime 레일 | `clients/mobile/src/realtime/` — `centrifugeTransport.ts` · `channelRail.ts` · `RealtimeProvider.tsx` · `backgroundPolicy.ts` (centrifuge 5.7, ConversationScreen이 소비 중) |
| 신호 규칙 (그대로 소비 — 재구현 금지) | `packages/momo-core/src/features/agents/workingSignal.ts` — 타입 3종·90s TTL·`isStaleSignal`·`mergeAgentWorkingSignals`·`headlineFrom`·**`awaiting_approval`은 절대 「작업 중」으로 렌더 금지** 규칙 포함 |
| 웹 참조 구현 (스토어 모양) | `clients/web/src/features/agents/agentWorkingSignal.ts` — 스토어+`ZOMBIE_CLEAR_MS`(120s)는 클라 로컬 상태라 core에 없음. 폰은 자기 스토어를 만들되 상수·의미는 웹과 동일하게 |
| 와이어 | `agent:ws<WS>.<CHANNEL>.<AGENT>` 네임스페이스 — Rust subscribe 프록시 지원 확인(`realtime.rs:168-172` `ParsedChannel::Agent` = 관전자·에이전트 모두 그 채널의 활성 멤버), 이벤트 생산은 outbox/gateway(`momo-outbox/src/emit.rs`·`gateway.rs`). **이벤트 이름·payload는 웹 소비부에서 실측**해 폰이 같은 것을 읽게 하라 — 두 클라가 다른 파서를 가지면 그게 다음 결함이다 |

**표면**: 에이전트 탭 목록 행 + 대화 화면(해당 에이전트 참여 채널)의 「작업 중」 표기. 어휘는 웹과 동일(작업 중=열린 턴 · 세션 실행 중=별개 — #980이 세운 경계 유지). `backgroundPolicy.ts`의 기존 정책(백그라운드 구독 해제/복원)에 새 구독을 태워라 — 라디오는 폰에서 비용이다.

**검증**: mobile 전체 + typecheck + 신규 신호 스토어 테스트(TTL 만료·zombie 정리·awaiting_approval 비표기·**목 타이밍 편차** — 같은 tick 응답 금지 #839) + red proof(awaiting_approval 렌더 금지를 부수면 이름 있는 실패).

## Goal 2 — 중단 컨트롤 + roster paused 소비 (서버 랜딩 후 착수)

1. **중단 컨트롤**: SRV-B2 goal 1의 `POST …/agent-runs/{run}/cancel` 소비. 권한은 서버 그대로(채널 멤버 누구나 — ADR-0132 휴먼 정지권). 확인 단계 1겹(승인만큼 무겁게 하지 않는다 — 중단은 비가역이지만 "다시 시키면 되는" 종류다. 문구가 그 차이를 말해야 한다: "중단하면 이 실행이 여기서 끝납니다. 다시 시킬 수 있습니다."). conflict(이미 터미널) 응답은 오류가 아니라 "이미 끝났습니다"로.
2. **문구 상향**: #980의 "이미 실행 중인 작업은 그대로 끝까지 갑니다"(`sessionSurvival` 계열)는 cancel 랜딩으로 거짓이 된다 — "실행을 중단할 수 있습니다"로 갱신하고, **그 문구를 잠근 기존 테스트를 지우지 말고 고쳐라**(#980 선례).
3. **roster paused 소비**: 에이전트 탭 목록의 per-agent profile GET(N+1·일반 멤버 403)을 roster의 paused로 대체. profile GET은 편집 진입 시에만.

**검증**: mobile 전체 + 결정/중단 상호작용 테스트(성공·이미 터미널·오프라인) + red proof(확인 없이 cancel POST가 나가면 실패).

## 공통 계약

- 수정 허용: `clients/mobile/**` + `packages/momo-core`(순수 규칙만). 서버·웹 소스 금지(웹 테스트 단정이 core 변경으로 깨지면 그것만 고치고 이탈 보고).
- PR 본문 `## 계획 이탈` 필수. goal별 PR·STOP·머지 금지.
