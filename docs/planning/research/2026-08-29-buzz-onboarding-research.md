# buzz 온보딩 실물 분석 (#1869 선행 리서치)

> 2026-08-29 Fable. 소스: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/features/onboarding/` 전체 정독. 성재 질문: "무슨 에셋을 어떻게 쓰고 온보딩시켰나 — 화면·경험 중심".

## 1. 스텝 구조 (실코드 기준)

**A. 머신 온보딩(첫 실행, MachineOnboardingFlow — 4단계 카운터)**
| 페이지 | 경험 | 비고 |
|---|---|---|
| `identity` (랜딩) | **마스코트(벌) 스캐터 필드 위**에서 "새 정체성 만들기 / 기존 키 가져오기" 선택. 진행바 없음, 중앙 정렬 | 간판 화면. LandingBees |
| `key-import` | nsec 붙여넣기 또는 **폰 복구(QR 페어링)** | 복귀 사용자 경로 |
| `backup` (2/4) | 키 다운로드 + 암호화 백업 생성(비밀번호 타임라인 UI), "절대 공유 금지" 카피 | 보안 스텝을 온보딩 안에 |
| `setup` (3/4) | **에이전트 런타임 선택**(ACP — claude 등 하네스 로고) | 유일한 비트맵 에셋 사용처 |
| `config` (4/4) | 기본 에이전트 구성 | |

**B. 릴레이/커뮤니티 합류(CommunityOnboardingFlow)** — 초대 코드 입력(InviteRedeemForm)·승인 대기 게이트(PendingInviteGate)·거부 화면(MembershipDenied).

**C. 프로필(OnboardingFlow)** — `profile`(이름) → `avatar`(아바타 업로드) → 완료. "지금은 건너뛰기" 상시 제공, 저장 실패 시에도 전진 가능한 복구 설계(ProfileStepSaveRecovery).

**D. 웰컴 킥오프(진입 직후, welcomeKickoff.ts 869줄 — 이 설계의 정수)**
- 정적 투어 카드가 **아니다**. 웰컴 채널에 **스타터 에이전트 팀 3인(Fizz 리드·Honey·Pollen)을 자동 구성**하고, 에이전트가 **실제 메시지로 말을 건다**: "What can we help you build? Bring us something you're working on…"
- AI provider 미연결이면 그 안내조차 에이전트가 채널에서 말한다("Settings에서 연결하고 돌아오면 팀을 소개할게").
- 멱등 마커(opener/closer/provider-required v1)로 중복 게시 방지. 제품의 핵심 가치(에이전트=팀원)를 **첫 5분의 실사용으로 증명**하는 구조.

## 2. 에셋 실태 — "화려함"의 재료

**비트맵 에셋 총량: 1파일(claude.png 하네스 로고, 12KB).** 나머지 전부 코드:
1. **배경**: 플랫 브랜드 컬러 필드(chartreuse `#d7d72e`) + **24px 도트 격자**(radial-gradient 1px 점) — 랜딩. 이후 스텝은 chartreuse→연하늘 그라데이션 + 같은 도트.
2. **마스코트 스캐터 필드(LandingBees)**: 코드 SVG 벌 ~40마리 고정 산포(크기 22–36px, 회전 ±24°, 흰/노랑 2색 currentColor) → rAF 루프에서 ①마리별 비정합 사인파 배회(위상=인덱스) ②**마우스 반발**(반경 180px·강도 110, easing 0.12) ③날개 플랩은 CSS 키프레임을 HTML 레이어에 걸어 **컴포지터 스레드에서 구동**(부팅 잼에도 안 멈춤 — 주석에 WebKit 메인스레드 회피 설계까지 명문). reduced-motion이면 정지 실루엣.
3. **스텝 전환(OnboardingSlideTransition)**: effect 5종(`fade`/`line-slide`/`mask-reveal-down·up`/`none`) × direction(forward/backward). line-slide 650ms `cubic-bezier(0.22,1,0.36,1)`, mask-reveal 760ms. fill-mode `backwards`(잔류 transform이 fixed 푸터를 가두는 함정 회피 주석).
4. 영상·3D·Lottie: **0**. 유료 에셋 서비스: 0.

## 3. 이식 판정 (oort 관점)

- **에셋 전략 확증**: "코드 모션 우선, 영상/3D 불요" 판정이 buzz 실물로 강확증. grok imagine·meshy **불요**(브랜드 필드+코드 마스코트+전환 연출로 동급 화려함 달성). 지출 0.
- **oort 등가물**: 벌 스캐터 → **오르트 라인아트 문법의 별·혜성·구름 산포**(v2-main 마스코트는 중앙 1점, 산포는 파생 도형 — 정본 "변주는 성재와 함께" 저촉 없게 마스코트 본체 변형 없이 주변 요소로). chartreuse 필드 → Dawn 팔레트의 브랜드 면. 도트 격자·전환 문법(듀레이션/이징 포함)은 그대로 이식.
- **구조 차이**: buzz의 identity/key/backup 스텝은 nostr 산물 — 우리는 서버 계정이라 **서버 선택→로그인/가입**이 그 자리를 대체(더 짧아짐 = 장점).
- **최대 이식 가치 = D(웰컴 킥오프)**: "에이전트가 먼저 말 거는 첫 5분"은 우리 3-트랙 방향(agent-native, 봇 래핑 금지)의 정수와 일치. 우리 버전: 웰컴 채널에서 김인턴(hermes)이 오프너 게시, provider/자격 미구성이면 그 안내를 김인턴이 말함. 기존 인프라(에이전트 멘션·ACP)로 구현 가능.
- buzz 4단계 카운터·"지금은 건너뛰기" 상시·저장 실패에도 전진(복구 설계)·랜딩만 진행바 없음 — 전부 채택 가치.
