# ADR-0179: 표현 축 신설 — 모션·눌림·엘리베이션·밀도

- 상태: **Accepted** (2026-09-02 성재 결재 — "2~5까지는 승인". 기안 Fable 같은 날 방향은 2026-09-02 인터뷰 Q1·Q3 권고 승인으로 기승인)
- 발제: `docs/planning/research/2026-09-02-launch-rediagnosis-two-pillars-brief.md` §2 근원 R1·R2·R6 / 편성 `docs/planning/2026-09-02-launch-program-plan.md` D-1·UX-R0·DS-0
- 관련: ADR-0159(오르트 구름 디자인 시스템 — §2.6 "모션은 전면 토큰 축이 없다") · ADR-0174(외양 커스터마이제이션 — 밀도·폰트는 BZ-5b) · ADR-0172(아이콘) · ADR-0137 D5(폰 v0) · buzz `desktop/src/shared/styles/globals/motion.css`(Apache-2.0)

## 맥락

`clients/web` 71K줄에 duration·easing 토큰이 없다(실측: `--duration-sidebar` 200ms 1호뿐, 그 밖의 값은 160ms 서랍·120ms 업로드 막대·150ms 색 전이가 손으로 적혀 있음). 다이얼로그·팝오버·드로어·스레드 패널·리스트 삽입에 enter/exit가 없고, `hover:` 129곳 대 `active:` 5곳으로 눌림 피드백이 사실상 부재하며, 고도는 Tailwind 기본 `shadow-sm/lg` 2단을 테스트로 잠근 상태다. 폰은 2026-07-28 갭 감사의 `instant 0/fast 120/standard 180/slow 240` 권고가 미채택이라 백지다.

그 결과 8/29~9/1 buzz 패리티 3파도(25건+)가 랜딩됐는데도 체감이 낮다 — 기능이 아니라 **표현 축의 부재**가 원인이다. 시스템이 `--color/--spacing/--radius/--text: initial` + hard-zero 12종으로 "금지"에는 강하고 "표현"에는 어휘가 없어서, 새 모션·밀도를 넣는 가장 쉬운 합법적 방법이 `tokens.css`에 명명 기하를 하나 더 적는 것이었다(2,678줄). buzz는 같은 스택(React·Tailwind v4·shadcn)에서 120/180/240/500ms 사다리 하나로 58파일의 모션을 정합시킨다.

## 결정

- **D1 duration 사다리(웹·폰 공통, 이름·값 동일).** `--motion-instant: 120ms`(피드백 — 눌림·색·툴팁) · `--motion-fast: 180ms`(작은 표면 — 팝오버·드롭다운·칩) · `--motion-standard: 240ms`(상태 변화 — 패널·드로어·리스트 삽입·사이드바 접기) · `--motion-arrival: 500ms`(합성 도착 — 새 메시지·첫 진입). 온보딩(650/760ms)은 ADR-0159 단일-룩 예외로 남는 **유일한 사다리 밖 값**이다. *정오표(2026-09-02, UX-R0 랜딩 실측 — design-review R2 M-3)*: 온보딩 예외 블록에는 `onboarding-fade-in` 300ms×3(wordmark·tagline·fade)도 있으며, 모달 200/150은 D4가 예외 2호로 둔다 — 사다리 밖 값의 정본 목록은 디자인시스템 README §2.6 예외표이고 D1의 '유일한'은 '온보딩 블록과 모달 상수 두 곳 밖에는 없다'로 읽는다. 결정 본문 무변경. 2026-07-28 폰 권고(0/120/180/240)는 이 결정이 대체한다 — `instant 0`은 값이 아니라 reduced-motion 상태다.
- **D2 easing 2종.** `--motion-ease-standard: cubic-bezier(0.25,1,0.5,1)` · `--motion-ease-arrival: cubic-bezier(0.16,1,0.3,1)`. 기존 `ease-out` 손기입은 전부 전자로 흡수.
- **D3 도착 모션 규격.** `--motion-distance-arrival: 0.75rem` · `--motion-blur-arrival: 2px`. 새 메시지 행은 `blur→0 · opacity 0→1 · translateY(distance)→0`을 arrival 사다리로 **1회만** 재생한다(one-shot — `animationName` 일치로 종료 감지, 재마운트·백필·리플레이 무재생). 스켈레톤→콘텐츠 전이는 같은 blur 값으로 크로스페이드한다(팝 금지). *정오표(2026-09-04, 성재 결정 — UX-R1d R4 검수 N-2, #2050)*: 라이브 행마다 재생을 예약하되 **바닥에서 같은 틱에 도착한 행은 최대 3행까지만 재생**하고 초과분은 즉시 정착한다(스크롤업 백로그 상한 1의 짝). stagger는 사다리 밖 duration을 만들므로 기각. 결정 본문 무변경, 상한은 `Timeline` 하네스에서 숫자로 잰다.
- **D4 비대칭 원칙.** 사라짐은 나타남보다 짧다 — 모달·팝오버·드롭다운·컨텍스트 메뉴는 열림 `standard`(240)·닫힘 `fast`(180)… 단 모달만 열림 200·닫힘 150(buzz 실측값, 사다리 밖 예외 2호 — 정본 상수 `modalMotion` 한 곳). 공용 클래스 한 곳(`src/design/motion.ts`)에서만 조립하고 각 표면이 숫자를 적지 않는다.
- **D5 눌림 상태 정본.** 모든 상호작용 표면(버튼·아이콘 버튼·행·칩·메뉴 항목)은 `active:` 상태를 갖는다 — `transform: scale(0.98)` + 잉크/그릇 전환, `--motion-instant`. `button.tsx` variant에 단일점으로 박고, 행·칩은 DS-1 프리미티브가 상속한다. `hover:`만 있고 `active:`가 없는 표면은 preflight 위반이다(신규 코드 한정, 기존은 shrinking ledger).
- **D6 엘리베이션.** 2단(`shadow-sm` 카드 · `shadow-lg` 떠 있는 표면)을 유지하되 **이름을 준다**: `--elevation-rest`·`--elevation-float`. 떠 있는 표면(팝오버·팔레트·드로어)은 `float` + `backdrop-blur` 5px 스크림을 함께 쓴다. 3단 이상은 도입하지 않는다(ADR-0159 D5 정합).
- **D7 밀도·타이포 축(ADR-0174 D2 소비).** `data-density="compact|comfy|spacious"` 루트 속성이 대화 행 패딩·아바타·메시지 간격 토큰 4종을 바꾼다. 폰트 크기 3단은 **가상 rem** `--type-rem: calc(1rem * var(--type-scale))`로 텍스트 역할 5종만 스케일링하고 레이아웃 rem은 건드리지 않는다(브라우저 줌과 직교). 구현은 BZ-5b(UX-R6a).
- **D8 라이브러리 = 하이브리드.** CSS 토큰·키프레임·`data-state` 유틸이 정본. `motion/react`는 **AnimatePresence·layoutId가 필요한 표면**(⌘K 팔레트·패널 enter/exit·리스트 삽입·킥오프 스테이지)에 한정 도입하고 `transition={{ duration: reduceMotion ? 0 : … }}` 규율을 강제한다. 다른 모션 라이브러리는 도입하지 않는다.
- **D9 reduced-motion 이중 처리.** CSS: 모든 사다리 소비자는 `@media (prefers-reduced-motion: reduce)`에서 duration 0 또는 `animation: none`. JS: `useReducedMotion()`으로 duration 0 — **모션을 끄는 것이 아니라 0으로 만든다**(상태는 여전히 착지). 온보딩 rAF 필드는 현행대로 시작하지 않는다.
- **D10 강제 기제.** ①`src/design/motion.test.ts` — 토큰 존재·값·reduced-motion 블록·모달 상수 단정 ②`design_preflight_web.sh`에 `raw_motion` 카테고리 신설: `*.tsx`/`tokens.css` 신규 줄에서 사다리 밖 `\d+ms` 손기입 hard-zero(온보딩·모달 상수 파일 allowlist) ③캡처 규율 `waitForAnimations(page)`: 애니메이션 진행 중 프레임 촬영 금지(design-review 회전 낭비의 실측 원인) ④rest/hover/active 3짝 캡처 레인(DS-3) ⑤폰 `tokens.ts`는 웹 tokens.css의 모션·밀도 값을 파생·바이트 대조(paletteContrast 동형, DS-5).

## 기각 대안

- **CSS 전용(라이브러리 0 유지)**: 팔레트·패널의 exit 애니메이션과 리스트 삽입 layout 전이를 CSS만으로 하면 언마운트 지연 훅을 손으로 짜게 된다 — buzz가 58파일에서 `motion/react`로 푼 자리. 기각(단 도입 범위는 D8로 봉인).
- **framer-motion 전면 도입(전 표면 JS 모션)**: 번들·리렌더 비용, reduced-motion 이중 처리의 누락 표면 증가. 정본이 둘이 된다. 기각.
- **폰 사다리 별도 값(0/120/180/240)**: 웹·폰 이름은 같고 값이 다르면 DS-5 파생이 성립하지 않는다. 기각 — `instant 0`은 reduced-motion으로 흡수.
- **엘리베이션 3단+**: ADR-0159 D5 미도입 목록과 충돌, 폰 그림자 3 API 비대칭. 기각.

## 영향·게이트

- 신규: `src/design/motion.css`(토큰)·`motion.ts`(공용 클래스 상수)·`motion.test.ts`·preflight `raw_motion`·캡처 `waitForAnimations`·3짝 캡처 레인. `tokens.css`의 손기입 ms는 사다리로 이관(온보딩 예외).
- 소비자 이관 순서 = UX-R1a~e. 기존 게이트(`transitionColors.test`·`focusRing.test`·`designSystem.test`)는 그대로, `designSystem.test`의 그림자 2단 잠금은 D6 이름으로 재표현.
- 디자인시스템 README §2.6 재작성("축이 없는 두 자리" → 두 축의 정의), 리뷰 루브릭에 모션·눌림·밀도 항목 추가(DS-4).
- 폰: D1·D7 값 파생 + 폰 preflight 신설은 M1a. 그 전까지 폰은 현행 유지(회귀 없음).
