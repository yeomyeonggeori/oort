# ADR-0181: 웰컴 킥오프 — 에이전트가 먼저 말을 거는 첫 5분 (오프너 주체 = agent-worker)

- 상태: **Proposed** (2026-09-02 기안 Fable — 성재 결재 대기. 인터뷰 Q11 권고 승인 = agent-worker 트리거)
- 발제: `docs/planning/research/2026-08-29-bz6-onboarding-design.md` v2.1 S4 / `2026-08-29-buzz-onboarding-research.md` §1-D("이 설계의 정수") / 패리티 감사 §3-S13(리서치 간 인계 누락) / 편성 UX-R2b·R2s
- 관련: ADR-0101(에이전트=멤버, 봇 래핑 금지) · ADR-0131(네이티브 에이전트 프로필) · ADR-0158(턴 스트리밍) · UX 바이블 P5("첫 실행 = 에이전트와의 첫 대화") · `usage_ledger`(비용 원장) · buzz `welcomeKickoff.ts`(869줄, 멱등 마커 opener/closer/provider-required v1)

## 맥락

온보딩 S0~S2(BZ-6a)는 랜딩됐지만 절정이 없다 — 사용자는 딥스페이스 랜딩을 지나 **빈 채팅**에 떨어진다. 유일한 에이전트 온보딩은 첫 `@멘션` 뒤의 사후 힌트(`FirstMentionOnboarding.tsx`)다. buzz는 투어 카드 대신 스타터 에이전트 팀이 웰컴 채널에서 **실제 메시지로** 말을 걸고, provider 미연결이면 그 안내조차 에이전트가 말한다. 우리 3-트랙 방향(agent-native, 봇 래핑 금지)에서 이것은 시연이 아니라 정체성이다.

현행 자산: `RunTrigger::{Mention, Work}`(`momo-agent/src/run.rs:139`) — 사람 발화가 run을 만든다. 워크스페이스 생성이 `#general`을 기본 채널로 시드(`workspaces.rs:174`). 가입은 `POST /v1/join`(초대) 또는 claim 경로. provider 부재는 `momo-provider` `"provider not configured"` 오류로 run이 실패한다. 오프너 게시 주체가 미결이라 BZ-6c가 engine 판정 대기로 남아 있었다.

## 결정

- **D1 오프너는 실제 에이전트 run이다.** 서버가 시스템 라인을 꽂지 않는다. 신규 `RunTrigger::Welcome { member_id, agent_member_id, channel_id }`를 **agent-worker가 소비**해 웰컴 채널에 오프너 턴을 스트리밍한다(ADR-0158 문법 그대로 — "자라는 메시지 하나"). 오프너의 작성자는 `member.kind='agent'`이고 원장에 기록된다(D6).
- **D2 트리거 = 사람 멤버의 첫 합류.** `POST /v1/join`·claim 완주·초대 redeem이 **사람 멤버를 새로 만든 트랜잭션**에서 `agent_gateway` 잡을 넣는다(멘션 경로가 같은 tx에서 run을 만드는 것과 동형). 재가입(`createdMember:false`)은 트리거하지 않는다.
- **D3 대상 채널·에이전트.** 채널 = 워크스페이스 **기본 채널**(`#general`, 신규 채널 생성 없음 — v1). 에이전트 = 워크스페이스의 **웰컴 에이전트**: 운영자가 workspace settings(`#1800` 표면)에 `welcome_agent_member_id`로 지정, 미지정이면 첫 활성 네이티브 에이전트(김인턴/hermes), 그것도 없으면 오프너 없음(조용히 — 시스템 라인 대체 금지).
- **D4 멱등 마커.** `agent_run.idempotency_key = welcome:{workspace}:{member}:opener:v1`(UNIQUE 제약이 중복 게시를 구조적으로 막는다). 마커 종류 3: `opener`·`provider-required`·`closer`(첫 사람 응답 뒤 1회, 선택). 마커 버전은 카피 개정 시 올린다.
- **D5 provider 미구성 분기.** run 시작 시 provider가 없으면 worker는 실패 대신 **`provider-required` 오프너**를 게시한다 — 단 이것도 에이전트 명의여야 하므로, provider 없이 게시 가능한 **정적 카피 경로**(모델 호출 0, 원장 0)를 worker에 둔다: "설정 › AI 연결에서 연결하고 돌아오면 시작해요". 연결이 생기면 다음 진입 시 `opener` 마커가 없으므로 정상 오프너가 1회 게시된다(`provider-required` 마커는 opener를 막지 않는다).
- **D6 비용·경계.** 오프너 run은 `usage_ledger`에 정상 귀속(무료 아님 — 원장 정직성). A2A 게이트·step cap 적용. 오프너는 채널 멘션 없이 시작하므로 `a2a_depth=0`·사람 트리거 취급(G2 연속 자동응답 streak 카운트 제외).
- **D7 클라 연출(UX-R2b).** 진입 직후 킥오프 스테이지(캐릭터 stagger 120ms, ADR-0179 사다리) → 첫 에이전트 발화 도착 시 스테이지 exit → 오프너 행 `arrival` 모션 1회. 스레드 자동 열기 금지(buzz 실측: 첫 실행 로딩 캐스케이드). **백스톱 120s**: 오프너 미도착이면 "어디서 확인하면 되는지"형 안내(실패 문구 금지).
- **D8 카피 정본.** 오프너 지시문은 에이전트 프로필의 지시문이 아니라 **워크스페이스 설정의 웰컴 프롬프트**(기본값 = 정본 카피, 운영자 편집 가능). 톤은 UX 바이블 P3(제품 인격) — "무엇을 만들고 계세요? 하나 가져오시면 같이 시작해요".

## 기각 대안

- **서버 시드(마이그레이션/시스템 라인으로 오프너 삽입)**: 에이전트 명의를 흉내 내는 봇 래핑 — ADR-0101 위반, 원장에 없고 스트리밍도 아니다. 기각.
- **정적 투어 카드**: buzz 실코드가 폐기한 방식, P5 위반. 기각.
- **전용 `#welcome` 채널 신설**: 채널 수 증가·빈 채널 인트로(A8)와 중복. v1은 기본 채널, 필요 시 v2.
- **클라이언트가 오프너 트리거(POST)**: 클라 재설치·다중 기기에서 중복 트리거 — 서버 tx 트리거 + UNIQUE 키가 정답.

## 영향·게이트

- 서버: `RunTrigger::Welcome` + 가입 3경로의 tx 내 잡 삽입 + worker의 `provider-required` 정적 경로 + workspace settings 키 2(`welcome_agent_member_id`, `welcome_prompt`). 스키마 변경 없음(idempotency_key·settings JSONB 재사용). `schema_v0.sql` 무접촉.
- red proof: ①같은 멤버 2회 진입 → 오프너 1회 ②provider 없음 → `provider-required` 1회, 연결 후 opener 1회 ③재가입 무트리거 ④웰컴 에이전트 없음 → 게시 0·오류 0 ⑤원장 행 존재 ⑥오프너가 G2 streak에 미계수.
- 클라: 킥오프 스테이지 캡처(두 스킴·reduced-motion) + 120s 백스톱 시험. 티켓: UX-R2s(engine) → UX-R2b(uxui).
