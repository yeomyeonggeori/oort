# ADR-0132: 에이전트 상호작용 안전 계약 — 휴먼 정지권·루프 방어·발화 의무·실패 고지

- 상태: **Accepted** (성재 승인 2026-07-22 — D1~D5 전부, H2 발급 승인)
- 날짜: 2026-07-22
- 발단: buzz 경쟁 분석(2026-07-22-buzz-competitive-analysis.md §6)에서 발굴한 실증 실패 4종 — ①킬스위치가 모든 실제 제품 표면에서 도달 불가능(유닛 테스트는 제품이 만들 수 없는 입력 형태로 통과) ②"반드시 답하라"+"완료 시 멘션하라" 규칙 합성이 만든 에이전트 상호 멘션 무한루프(런타임 하나의 재량 위반이 루프를 막은 유일한 요인) ③리드 에이전트가 죽으면 실패 고지 채널도 함께 죽는 침묵 경로 ④타이머가 사실을 이겨 거짓 스토리를 영구 기록. momo 실태 감사(같은 날): 루프 방어는 이중(depth/round CHECK + G1~G3·G5)으로 상위권이나, **휴먼이 진행 중 run을 멈추는 REST가 없고 macOS `cancelRun`은 TODO 스텁**, depth 전파 미구현(enqueue 시 항상 0), G4 SimHash 스텁.

## 결정 (Proposed)

### D1. 휴먼 정지권 = 1급 REST
`POST /v1/workspaces/{ws}/agent-runs/{id}/cancel` (권한: run 소유 채널의 활성 **human principal** — 에이전트 소유자 한정이 아님, 채널의 어느 사람이든 폭주를 멈출 수 있다. **agent bearer 호출은 거부** — 에이전트 상호 취소라는 새 A2A 간섭 표면을 열지 않는다). 서버 집행: run→`cancelled` 전이 + 해당 run의 pending agent_job outbox 무효화 + 진행 중 워커에 취소 신호(다음 스텝 경계에서 중단, 승인 대기 중이면 즉시). 취소는 원장 이벤트(누가/언제/어느 run)로 기록되고 채널에는 **시스템 라인**(에이전트 발화 아님)으로 표시된다.
구현 지렛대(신설 아님·재사용): `cancelled` 전이와 서버발 취소의 gateway ack 프로토콜, pending outbox 무효화 선례가 이미 있다 — 승인 거부 경로(`ApprovalDecisionRoutes.swift:823-833`, `AgentGatewayRoutes.swift:341,455-475`). D1은 이 기계장치를 휴먼 트리거로 노출하는 것이다.

### D2. 취소 의미론 3단 선명화 (buzz 교훈: "1턴 취소는 루프 브레이커가 아니다")
- **run 취소**(D1): 이 실행 1건만. 다음 멘션에 정상 재개. **경계 확정(성재 확인 2026-07-23)**: run 취소는 그 run이 spawn한 work_session을 자동 종료하지 않는다 — 취소 원장·응답에 연결 세션 ID를 기록하고(`linked_work_session_ids`, `work_sessions_terminated=false`), 폭주 주체가 work_session이면 별도 kill(work.control)로 다룬다.
- **에이전트 일시정지**: `agent_profile.paused` (해당 워크스페이스에서 신규 run enqueue 거부, 멘션은 "일시정지됨" 시스템 라인로 응답). 폭주 루프를 멈추는 실제 수단.
- **채널 격리**: 채널 멤버십 제거(기존 경로) = 그 채널에서만 배제.
클라 표면: run 카드에 Stop(D1), 에이전트 프로필/멤버 인스펙터에 Pause(2단). **수용기준에 "실클라이언트 표면에서 발동하는 E2E"를 명시** — 유닛 테스트 단독 검증 금지.

### D3. 루프 방어 완결 (기존 G1~G5 위에 2건)
- depth 전파 실구현: mention enqueue 시 유발 run의 depth+1 계승(현재 항상 0 삽입) — depth≤4 CHECK가 실제로 물리게 한다.
- A2A 연속 턴 예산의 관측: G2 차단 발동 시 원장 이벤트+채널 시스템 라인("자동 응답 한도 도달 — 사람이 개입해야 계속합니다") — buzz 교훈 "구조적 서킷브레이커는 백로그로 미루면 프롬프트 prose-compliance만 남는다"의 역이행. G4 SimHash(MOMO-313)는 이 ADR 범위 밖 유지(선행조건만 기록).

### D4. 발화 의무 계약 (하네스/어댑터 base prompt 규약)
"모든 턴은 반드시 발화" 금지. 규약: **새 정보를 더할 때만 publish / 사람이 물었으면 반드시 응답 / 그 외 침묵=명시적 성공 / bare acknowledgement("확인했습니다", "알겠습니다" 단독) 금지(위반 문구 열거)**. per-turn 로컬 테스트로 기술한다("이 메시지가 스레드에 새 정보를 더하는가") — "루프에 빠지지 마라" 같은 전역 규칙은 에이전트가 따를 수 없으므로 쓰지 않는다. 적용 지점: hermes 어댑터·AgentWorker 프리앰블(ADR-0131 서버 관제 프리앰블에 편입 — profile이 덮을 수 없음).
경계: **외부 런타임(MOMO-536 A2A 카드 에이전트 등)은 momo가 프롬프트를 통제하지 못하므로 D4가 닿지 않는다** — 그들에 대한 방어는 D3의 구조 가드(depth·G2)가 유일하다(buzz 교훈 "한 런타임의 좋은 행동은 운"의 momo 대응이 정확히 이 지점).

### D5. 실패 고지 독립성
에이전트 실패/지연의 고지는 **실패할 수 있는 컴포넌트(에이전트 발화)를 경유하지 않는다**. 서버가 아는 사실(run failed/timeout/워커 미클레임)은 시스템 라인+클라 상태 UI로, retryable(일시 장애)과 actionable(설정 필요)을 구분해 표시한다. 타이머성 표시는 "기대치"가 아니라 give-up 백스톱으로만 명명·사용한다(facts decide, timers are backstop).

## 불변식 준수
- 단일 쓰기경로: cancel도 REST→PG(원장)→outbox→relay. 워커 취소 신호는 원장 상태를 SoT로 폴링/구독.
- 에이전트=member: pause는 member 지위 박탈이 아니라 profile 플래그(ADR-0131 원장 가산).
- RLS FORCE·승인 정지점(0114)·비용 회로차단기(G5) 불변.

## 기각
- 멘션 rate limit만으로 대체(정당한 고빈도 협업까지 차단, buzz 실증: 낮은 캡은 협업을 자름 — 예산은 높게+관측 우선).
- "루프 감지 후 자동 전체 정지"(오탐 시 정당 작업 살상 — 사람 개입 유도가 기본).
- 워커 프로세스 kill을 취소로 간주(원장 상태 전이 없는 정지는 유령 run을 남긴다).

## 후속 (티켓 후보 — Accepted 후 발급)
- H2-1: cancel REST+outbox 무효화+워커 중단 경계+원장/시스템 라인 (서버)
- H2-2: macOS/iOS Stop·Pause 표면 + 실표면 E2E (cancelRun TODO 해소)
- H2-3: depth 전파 + G2 발동 관측 + D4 프리앰블 반영 (서버+워커+어댑터)
