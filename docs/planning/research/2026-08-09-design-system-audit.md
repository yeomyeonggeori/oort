# oort 디자인 시스템 — 업계 조사 + 현황 감사

- 실행: 2026-08-09 · 단발 리서치/감사 워커 · **레포 수정·커밋 0건** (읽기 전용)
- 지시: 성재 2026-08-09 — "보통 RN이나 Tauri 개발하는 팀에서 디자인 시스템 구성하는 방식을 확인해서, 자체적인 디자인 시스템 구축도 진행"
- 기준: 레포 실측은 전부 `origin/track/engine` = `2204c321`. 외부 조사는 1차 소스 링크.
- 산출 성격: **ADR 기안 아님.** 결정·기안·구현은 오케스트레이터와 성재의 자리.
- **읽는 순서: B(현황) → A(업계) → C(결정).** 문서상 A절을 뒤에 둔 이유는 §B 머리에 적었다.
- 방법: 레포는 내가 직접 실측(`git show origin/track/engine:…`, 대비값은 WCAG 상대휘도로 직접 계산). 외부 조사와 리뷰 16건(2,514줄) 전수 분류는 서브에이전트 3기로 병렬 수행하고 핵심 주장을 재검증.

---

## 0. 한 장 요약 (오케스트레이터용)

| | |
|---|---|
| **틀린 전제** | "우리는 디자인 시스템이 없다" — **있다.** 색 정본이 실제로 한 방향으로 흐르고(폰 테스트가 웹 CSS를 파싱해 바이트 대조), 격자 밖 간격은 컴파일조차 안 되고, 위계를 채도로 재는 방식은 **업계 1차 소스에서 선례를 못 찾았다**(우리가 앞서 있다) |
| **진짜 문제** | **명세 부족이 아니라 강제 부족.** 리뷰 170건 중 최다 패턴(25건/11리포트)이 "옳은 답이 바로 옆 줄·같은 파일·형제 컴포넌트에 이미 있었는데 안 쓴 것" |
| **표면 개수 정정** | "웹·RN·Tauri 셋"이 아니라 **디자인 표면 둘**이다 — Tauri는 `clients/web/dist`를 그대로 싣고 조건부 스타일링 0건. 이게 도구 도입 비용 계산을 통째로 바꾼다 |
| **도입하지 않을 것** | Style Dictionary(**RN 출력이 없다**) · DTCG 파이프라인(**안정 스펙에 다크모드가 없다**) · 범용 컴포넌트 층(RNW는 제작자가 "Meta 투자 0" 선언, 10개월 무커밋) · Storybook(비평가들이 수렴한 대체물을 우리가 이미 갖고 있다) · `eslint-plugin-design-tokens`(**존재하지 않는 패키지**) |
| **지우면 안 되는 것** | 우리 손수 만든 대비 시험. **비텍스트 대비(WCAG 1.4.11)는 어떤 벤더도 팔지 않는다** — Deque 자사 공개 데이터로 axe DevTools 커버리지 **0.00%**, 자동·인간보조 모두 0.00%, 100% 수동 |
| **새로 찾은 결함 3** | ① 웹 `Button secondary`의 경계 1.32:1(라이트)/1.43:1(다크), 채움도 1.07:1 — **둘 다 3:1 미달** ② 폰 파괴 버튼이 **테두리 토큰을 채움으로** 써서 다크 1.64:1 vs 승인 8.12:1 ③ **포커스 링이 21파일 25곳에서 페이드한다** — Tailwind v4 `transition-colors`가 `outline-color`를 포함(v3엔 없던 것). 리뷰 16건이 한 번도 못 잡은 것 |
| **가장 싼 수리 3** | ① `clients/web` ESLint를 게이트에 편입(현재 **`web-legacy`만** lint한다 — 한 줄) ② 포커스 링: 프리미티브 3개 수정 → 25곳 동시 해결 ③ 폰 `dangerFill`/`onDangerFill` 토큰 신설 |
| **성재가 골라야 할 것** | 시스템에 **이름을 붙일지**(oort 리브랜딩과 시점이 겹침) · 토큰 대조 범위를 색에서 전 축으로 넓힐지 · macOS 디자인 층(래칫·taste 스킬·design-review 계약)을 지금 재조준할지 |

---

## B. 우리 현황 감사 — 있는 그대로

> A절(업계)보다 B를 먼저 둔다. 업계 방식의 채택 여부는 **우리가 지금 무엇을 갖고 있는지**를 안 뒤에만 판단할 수 있고, 아래 실측은 "우리에게 디자인 시스템이 없다"는 전제가 **틀렸다**는 것을 먼저 말하기 때문이다. 우리는 디자인 시스템을 갖고 있다. 다만 그것이 **한 곳에 있지 않고, 이름이 없고, 절반만 강제된다.**

### B-1. 토큰 정본은 몇 개인가 — 넷이고, 종속 관계는 **색만** 성립한다

| # | 파일 | 무엇을 정의하나 | 누구를 따르나 | 기계적 종속 |
|---|---|---|---|---|
| 1 | `clients/web/src/design/tokens.css` (1,314줄) | 색 20 · 간격 20+ · 반지름 3 · 텍스트 롤 5 · 셸 기하 | **아무도 안 따름 = 사실상 정본** | — |
| 2 | `clients/mobile/src/design/tokens.ts` (448줄) | 색 30(×2스킴) · space 5 · radius 3 · font 5 · line 4 · TOUCH_TARGET | ①의 **색만** | `__tests__/paletteContrast.test.ts`가 ①을 파싱해 대조 |
| 3 | `packages/momo-core/src/features/timeline/divider.ts:178` | `ROW_SPACE = {withinGroup:12, betweenGroups:18}` | 없음 — 이 축의 정본 | 웹: `features/timeline/spacing.ts`+`spacing.test.ts` / 폰: `MessageRow.tsx` 직접 import / 게이트: `gate-time-borders.mjs`가 **정규식으로 파싱** |
| 4 | `clients/macOS/Sources/MomoMac/Theme.swift` | 색 8 · 반지름 3 · 치수 30+ | 아무것도 안 따름 (v0 그대로) | 없음 |

**핵심 사실 1 — 색은 정말로 한 방향으로 흐른다.** `paletteContrast.test.ts:297-380`이 웹 `tokens.css`를 `readFileSync`로 읽어 `light-dark(...)` 두 항을 정규식으로 뽑고, 폰의 두 팔레트와 **바이트 단위로** 대조한다. 짝이 없는 이름을 물으면 조용히 통과하지 않고 `throw`하며(`'--${name} 를 웹 tokens.css 에서 못 찾았다'`), 그 예외 자체가 테스트다(`:374 '짝을 못 찾으면 조용히 통과하지 않는다'`). 이건 잘 만든 물건이다. 업계의 "생성 파이프라인"이 하는 일의 **검증 절반**을 코드 없이 해낸다.

**핵심 사실 2 — 색 말고는 아무 축도 대조되지 않는다.** 그 대조표(`PAIRS`)는 15쌍이고 전부 색이다. 실측 결과 나머지 축은 이미 갈라져 있다:

| 축 | 웹 (`tokens.css`) | 폰 (`tokens.ts`) | 일치? |
|---|---|---|---|
| 간격 | `{0,1px,4,8,12,16,24,32}` + 이름값 12개 | `space {xs4, sm8, md12, lg16, xl24}` | **32 없음** |
| 반지름 | `sm 6 / md 10 / lg 14` | `sm 6 / md 8 / pill 999` | **md 10≠8, lg 없음, pill 웹에 없음** |
| 타입 | `11 / 12 / 14 / 16 / 20` (rem) | `26 / 18 / 16 / 13 / 12` (pt) | **한 값도 안 겹침** |
| 줄높이 | 텍스트 롤에 동봉 | `line {head15, meta17, label18, body22}` | 대응 없음 |
| 터치 타깃 | `--tap-target 44px` / `--touch-target 24px` | `TOUCH_TARGET 44` (24 대응 없음) | **부분** |
| 파괴 채움 | `--danger-fill` + `--on-danger-fill` | **없음** | **없음** |

반지름과 타입 스케일은 "플랫폼이 다르니 달라야 한다"로 방어 가능하다(폰 본문 16pt는 iOS 입력창 줌 문턱이라는 근거가 파일에 적혀 있다). 반지름 md 10 vs 8은 그 방어가 안 된다 — 근거가 어디에도 없고, 그냥 다르다.

**핵심 사실 3 — `--danger-fill` 부재는 우연이 아니라 기록된 구멍이다.** 웹은 MOMO-642 R1 H-2에서 "파괴 보조가 주 액션을 이겼다"를 고치려고 `--danger-fill`을 신설했다. 폰의 동기화 가드는 그 두 토큰을 **명시적으로 제외**한다:

> `paletteContrast.test.ts:337-341` — "웹에만 있고 폰에 짝이 **없는** 토큰은 여기 없다: `--surface-sidebar` … `--danger-fill`/`--on-danger-fill`(폰에는 파괴 액션의 채움 토큰이 아직 없다 — 역할을 새로 만드는 것은 정렬이 아니라 신설이라 #1164 밖이다)."

정직한 주석이지만, 결과적으로 **가드가 자기 구멍을 문서화하고 통과한다.** 그 구멍의 값은 §B-4 ②에서 잰다.

**핵심 사실 4 — Tauri는 디자인 표면이 아니다.** `clients/desktop/src-tauri/tauri.conf.json`의 `frontendDist`는 `../../web/dist`이고, `clients/web/src` 전수에서 `isTauri`/`data-tauri`/`titlebar`/`decorations` 조건부 스타일링은 **0건**이다. 데스크톱 빌드는 웹과 픽셀 단위로 같다. 따라서 성재의 질문에 나오는 "RN·Tauri·웹 셋"은 우리 레포에서 **디자인 표면 둘**(웹=Tauri, 폰)이다. 이 사실이 §C의 비용 계산을 크게 바꾼다.

### B-2. 강제 기제 전수 — 무엇을 재고 무엇을 못 재나

| 기제 | 파일 | 재는 것 | **못 재는 것** |
|---|---|---|---|
| 웹 그렙 프리플라이트 (하드 제로 10분류) | `scripts/design_preflight_web.sh` | 원시 색 리터럴·인라인 style·임의 Tailwind 값(`[13px]`)·그라디언트/인디고·토스트·`outline-none` 무보상·외부 폰트/CDN·과장 어휘·순흑백 | **의미**를 못 잰다: `border-line`이 장식선인지 컨트롤 경계인지 구별 불가(§B-4 ①). 렌더 결과를 안 본다 |
| 웹 문자열 AST | `scripts/design_preflight_web_strings.mjs` + `design_preflight_ast.mjs` | 문자열 리터럴·JSX 텍스트 노드의 em-dash | 코드 밖 자산(이미지 내 글자 등) |
| 코어 문자열 AST | `scripts/design_preflight_core.mjs` | 코어가 두 클라에 그대로 흘리는 문장 | 위와 동 |
| 웹 토큰 대비 시험 | `clients/web/src/design/tokens.contrast.test.ts` (438줄, 17 `it`) | **토큰 쌍**의 AA 4.5 / 비텍스트 3.0 / 스크림 방향 / 채도 위계(danger>warn>muted) / 채움 위계(accent>danger-fill) / hue 대역(인디고 금지) | **어느 컴포넌트가 어느 토큰을 쓰는지**를 안 본다. 표면 목록(`SURFACES` 6개)에 없는 배경 위의 전경은 무측정 |
| 폰 팔레트 시험 | `clients/mobile/__tests__/paletteContrast.test.ts` (488줄) | 위와 같은 규율 + **웹 정본 파싱 대조** | 간격·반지름·타입 축 전부. 파괴 채움 위계(토큰 부재) |
| 폰 hex/em-dash 전수 | `__tests__/conversationHygiene.test.tsx:519-575` | `src/` **전수**에서 hex 리터럴 0 · 사용자 문장 em-dash 0 | 이름이 `conversationHygiene`이라 발견 불가능. 간격은 안 봄 |
| 폰 간격 스케일 | `__tests__/conversationVisual.test.tsx:229-241` | `gap/marginTop/marginBottom` 숫자 리터럴이 `space` 위에 있는지 | **대상 파일이 `Quote.tsx`·`MessageBody.tsx` 두 개뿐.** 나머지 82개 파일 무검사 |
| 폰 44pt | `conversationA11y.test.tsx:330`, `conversationHygiene.test.tsx:148-259` | 실제 렌더 트리에서 `hitSlop`+상자 합산 ≥44 | 대화 표면 밖 |
| 웹 셸/테마/시각 게이트 23종 | `clients/web/gates/*.mjs` (Playwright) | 각 티켓의 기하·상태·회귀. `gate-theme`은 스킴 전환·FOUC·theme-color | 23개 중 **렌더 대비를 계산하는 것은 3개**(`gate-shell-layout`·`gate-theme`·`gate-workstream`)이고 전부 자기 표면 한정 |
| 캡처 레인 (**단정 포함**) | `clients/web/scripts/capture-screens.mjs` (1280×800 + 390×844 두 스킴) / `clients/mobile/measure/*` | 사진 + `assertNoHorizontalOverflow` · `assertTapTargets`(≥44px) · `assertTopBreathing` · `assertComposerVisible` | **타깃 목록이 손으로 유지되는 12개 허용목록**(`MOBILE_TAP_TARGETS`)이라 목록 밖은 무측정. 골든 이미지 비교 없음(시각 회귀 아님) |
| mac 래칫 | `scripts/verify_design_preflight.sh` + `design_preflight_baseline.txt` | `Color(red:)`·`Font.custom`·`.font(.system(size:))`·em-dash 개수 상한 | **죽은 클라를 지킨다**(§B-6) |
| 병합 트리 게이트 | `scripts/verify_merge_tree.sh` | 병합 **결과**에서 코어·웹·폰 typecheck+스위트 7레인 + 카피 스캔 | lint 레인 없음 |
| ESLint (웹) | `clients/web/eslint.config.js` | `no-restricted-syntax`: JSX `style=` 금지 · `#rrggbb` 리터럴 금지 | **어느 게이트도 이걸 실행하지 않는다**(§B-5 ②) |
| ESLint (폰) | `clients/mobile/.eslintrc.js` | 디자인 규칙 **0개** (`@react-native` + `no-void: off`뿐) | 전부 |

**요약**: 강제는 4개 층에 흩어져 있다 — 셸 그렙(웹만) · jest/vitest 단정(웹·폰 각자) · Playwright 게이트(웹만, 티켓별) · ESLint(웹만, 미실행). 폰에는 셸 프리플라이트 대응물이 없고, 그 자리를 테스트 파일 두 개가 이름 없이 메우고 있다.

### B-3. 리뷰 170건 빈도 분석 — **디자인 시스템이 막아야 할 목록**

2026-08-05~09 디자인 리뷰 **16건 전수**(2,514줄)에서 개별 라벨 결함 **170건**을 뽑아 분류했다. 심각도 분포: Blocker 6 · High 34 · Medium 63 · Nit/Low 67.

| 순위 | 분류 | n | 리포트 수 | 기계가 잡나 |
|---|---|---|---|---|
| 1 | **카피·용어** (어휘, 동사형, em-dash, 내부 용어 노출, 브랜드, 두 클라 문장 불일치) | 19 | 10 | **혼합** — em-dash/과장어 그렙이 일부만. 의미 판정은 전부 사람 |
| 2 | **상태 누락** (4상태: 오류·비활성·빈·영수증) | 16 | 4(+2) | **사람 전용, 기계 맹점** |
| 3 | **토큰 드리프트·역할 충돌** (원시값, 한 토큰=N개 의미, 두 클라가 한 역할을 다르게) | 15 | 10 | **혼합** — 리터럴은 잡고, **역할 과적재와 클라 간 역할 분기는 완전 무측정** |
| 4 | **레이아웃 기하** (오버플로·클리핑·밀림·폴드 없음·브레이크포인트 띠) | 13 | 6 | **혼합** |
| 5 | **시각 위계 역전** (조용해야 할 게 크고, 커야 할 게 조용함) | 11 | 6 | **사람 전용, 기계 맹점** |
| 5= | **간격·스케일·정렬 위반** (격자 밖, 미컴파일 클래스, 베이스라인) | 11 | 6 | **혼합 — 최고의 기계 성공과 최악의 거짓 초록이 여기 함께 있다** |
| 7 | **한국어 텍스트 처리** (조사 고아, `break-all`, 강조, 링크화, italic 무효) | 9 | 8 | **사람 전용 — 검사가 아예 없다** |
| 7= | **증거·캡처 공백** (사진 없음/낡음/비현실 픽스처) | 9 | 8 | **사람 전용** |
| 9 | **게이트·테스트·픽스처 맹점** (1차) | 8 | 5 | 정의상 사람 — **실제 총계 17건/10리포트** |
| 10 | **클라 간 패리티 분기** (1차) | 7 | 3 | 혼합 — 색 바이트 패리티는 **작동한다**, 비색 축은 무가드. 실제 총계 18건/8리포트 |
| 10= | **한 클라 안의 내부 불일치** (같은 것에 두 처리) | 7 | 6 | **사람 전용** |
| 10= | **포커스·키보드 경로** (포커스가 body로 떨어짐, inert 범위, 키보드 경로 없음) | 7 | 5 | 혼합 — 프리플라이트 `naked_focus`가 유일한 자동 검사이고 **매번 초록이었다** |
| 13 | **스크린리더 시맨틱** (로터 도달성, aria 바인딩, 라이브 리전) | 6 | 5 | **사람 전용** |
| 14 | **상태 수명주기** (로그아웃/라우트/새로고침 생존, 조용한 덮어쓰기, 취소/TTL 없음) | 5 | 5 | **사람 전용** |
| 14= | **자기 집 규칙 위반** (1차) | 5 | 5 | **사람 전용 — 실제 총계 25건/11리포트, 코퍼스 최다** |
| 16 | **화면이 거짓을 말함** | 4 | 4 | 사람 — 셋은 손으로 짠 런타임 프로브가 필요했다 |
| 16= | **터치 타깃 < 44pt / < 24px** | 4 | 3 | **사람 전용 — 두 클라 어디에도 자동 검사 없음**\* |
| 16= | **죽은 컨트롤·미배선 코드** | 4 | 3 | 혼합 |
| 19 | **비텍스트 대비 3:1 / 컨트롤 경계 (WCAG 1.4.11)** | 3 | 3 | 혼합 — 산술 가드는 있고 **자리는 사람이 픽셀 샘플링으로** 찾았다. 실제 총계 7건/6리포트 |
| 19= | **텍스트 대비 AA 4.5:1** | 3 | 3 | **혼합 — `tokens.contrast.test.ts` 27건 전부 초록인 채로 폰 본문이 3.59~4.02:1이었다.** 폰 바닥선이 4.5가 아니라 **≥3:1**로 쓰여 있었기 때문. 실제 총계 6건/5리포트 |
| 21 | 모션·불안정 | 3 | 2 | 사람 |
| 22 | 보안·프라이버시 | 1 | 1(+1) | 사람. 이후 게이트 확장으로 커버 |
| — | **스킴 패리티 (light vs dark)** | 1 | 1 | **기계가 잡는다** — 16건 중 9건이 두 스킴을 따로 재고 같음을 확인. **가드가 실증적으로 작동하는 유일한 축** |

\* 이후 `capture-screens.mjs`에 `assertTapTargets`가 들어왔으나 **손으로 유지되는 12개 허용목록**이다(§B-2).

#### **B-3-0-a. 코퍼스 최다 패턴: "규칙은 이미 이 레포에 적혀 있었고, 변경이 그것을 깼다" — 25건 / 11리포트**

**100% 사람이 찾았고 100% 기계 맹점이다. 그리고 이것이 이 감사에서 가장 실행 가능한 발견이다: 우리 디자인 시스템은 명세가 부족한 게 아니라 강제가 부족하다.**

가장 날카로운 인용들:

> **U4-4 W-1** (`tokens.css:150-161`): "**151행이 하필 `py-1.5`를 「아예 컴파일되지 않는 예」로 이름 대어 적어 두었다**"

> **typing H-3** (`Composer.tsx:630-632`): 메타 3행의 왼쪽 모서리가 8px 어긋난다 — "**그게 틀렸다는 판정이 바로 위 줄에 이미 적혀 있다**"

> **ailink-r4 Medium-N2**: "이 파일 자신이 정반대 규칙을 두 번 적어 두었다(`SettingsFields.tsx:285-291`·`:445-453`) … **새 스왑만 그 규칙 밖에 있다.**"

> **mobile-b3 M-8**: "`tokens.ts:22-23`이 'iOS HIG minimum tappable edge … **Not negotiable per-screen**'이라고 선언한 값이다." — 실제 출하 ≈41pt

> **mobile-b3 H-5**: "**같은 파일 `:309-311`에 이 경우를 위한 컴포넌트가 이미 있다**: `NoticeBlock`"

> **chat-ui-audit H-10**: "올바른 `scrollHeight` 기반 `useAutoGrow.ts:32-58`가 같은 레포에 있고 `ThreadComposer`·`MessageEditor`는 그걸 쓴다 — **컴포저만 안 쓴다.**"

> **chat-ui-audit H-4**: "상대 표기 함수가 **같은 파일에 이미 있다**(`relativeLabel`). 스레드 롤업만 그걸 쓰고 날짜 구분선은 안 쓴다."

#### **B-3-0-b. 두 번째 메타 패턴: 게이트 맹점 — 17건 / 10리포트**

리뷰가 "기계가 잡았어야 했는데 안 잡았다"고 명시한 자리들, 구조적 심각도 순:

1. **U4-4 W-2 [Blocker] — 대표적 거짓 초록**: "`spacing.ts` 머리말은 `spacing.test.ts`가 막는다고 선언한다. 실행 결과 **8/8 passed** — 화면이 0px인 채로. 이유: `TAILWIND_SPACE_PX`가 **Tailwind 기본 스케일**을 열거한다. **가드가 틀린 표를 보고 있으므로 W-1을 고쳐도 다음 goal에서 같은 방식으로 다시 벌어진다.**"
2. **U4-6 B1 [Blocker]** — "**U4-4 W-1과 같은 실패 양식 2번째 발생 — '머지 결과가 검증되지 않는다'.**" (각 PR 게이트는 개별 초록, 병합 트리에서 폰 `tsc TS2353` + jest 8/31 실패, 런타임에서 두 번의 리뷰가 지웠던 오프라인 승인 버튼이 부활)
3. **양성 분기만 태우는 게이트·픽스처 넷**: U4-4 M-1(승인 카드 전부 `startsGroup:true` → **연달아 온 승인 카드가 캡처된 적 없음**) · ade2 B1(**run 카드만 클릭**) · ailink-r4 High-N1(저장 주소가 곧 기본값인 OAuth 링크만 왕복) · U4-4 W-4(액션 있는 행만)
4. **typing H-1** — "`typing.test.ts:313`의 테스트 **이름**이 불변식을 말하는데 본문은 재발행 경로가 비어 있다. **코드가 자기 테스트가 이름 붙인 불변식을 깨고, 테스트는 그걸 못 본다.**"
5. **pin1169 M1 — 커버리지 비대칭**: 같은 불변식이 폰에선 게이트되고(`verify_merge_tree.sh`의 jest) **웹에선 수동 캡처 스크립트뿐**. "웹에서 누가 리터럴을 다시 손으로 적으면 **다음 수동 캡처 전까지 아무것도 붉지 않는다.**"
6. **U4-4 D-2 — 구조적으로 가드 불가**: "**코어는 색을 명시적으로 제외하므로 아무도 잡지 못한다.**"

**유일한 반례(게이트가 실제로 잡은 것)**: U4-4 W-1 — `npm run gate:borders` **exit 1**. 그런데 **그 PR은 자기 게이트가 붉은 채로 리뷰에 올라왔다.**

### B-4. 구멍 목록 — 코드에서 직접 측정한 것

#### ① 컨트롤 경계 3:1: 토큰은 맞고, **사용처는 검사되지 않는다**

`tokens.css:33-34`가 규칙을 선언한다: `--line`은 나누고, `--line-strong`은 컨트롤을 그린다(3:1). `tokens.contrast.test.ts:281`이 그 **토큰 쌍**을 두 스킴에서 잰다. 그런데 컴포넌트가 어느 쪽을 쓰는지는 아무도 안 본다. 실측 사용 빈도: `border-line` 198회 · `border-line-strong` 18회.

실제 위반 하나를 특정했다 — **`clients/web/src/design/ui/button.tsx:13-14`, `secondary` 변형**:

```
secondary: "border border-line bg-surface-raised text-ink hover:bg-surface-hover"
outline:   "border border-line-strong bg-transparent text-ink hover:bg-surface-hover"   // :24-25
```

`secondary`의 경계는 `--line`이다. 내가 계산한 값(WCAG 상대휘도):

| | 라이트 | 다크 |
|---|---|---|
| 경계 `--line` on `--surface` | **1.32:1** | **1.43:1** |
| 채움 `--surface-raised` on `--surface` | **1.07:1** | **1.10:1** |

경계도 채움도 3:1이 아니다. WCAG 1.4.11은 "채움이 컨트롤을 식별시키면 경계는 면제"인데 여기선 채움이 1.07:1이라 아무것도 식별시키지 않는다. `outline`(3.59/3.56:1)과 `secondary`는 **같은 모양의 두 버튼이고 하나만 규칙을 지킨다.** 무엇이 잘못됐는지 고르는 자가 없다.

`card.tsx:11`·`dialog.tsx:92`·`dropdown-menu.tsx:42`도 `border-line`이지만 그것들은 컨테이너라 정당하다. **그래서 이건 grep으로 못 잡는다** — "이 테두리가 컨트롤 경계인가"는 문법 질문이 아니라 의미 질문이다. 지금 이 판정을 하는 유일한 기제가 사람과 design-review 에이전트다.

#### ② 파괴 액션 위계: 폰에 채움 토큰이 없어서 **테두리 토큰이 채움으로 쓰인다**

`clients/mobile/src/features/inbox/ApprovalDecision.tsx:390`:

```
buttonCommit: {backgroundColor: color.accent},
buttonReject: {backgroundColor: color.dangerBorder},   // 테두리 토큰을 채움으로
```

같은 패턴이 `features/agents/StopTurnControl.tsx:204`에도 있다. 내가 잰 값:

| | 라이트 | 다크 |
|---|---|---|
| 거부 채움(`dangerBorder`) on `surface` | 1.89:1 | **1.64:1** |
| 승인 채움(`accent`) on `surface` | 5.72:1 | **8.12:1** |
| 조용한 버튼 테두리(`border`) on `surface` | 1.41:1 | 1.30:1 |
| (참고) 3:1을 지키는 토큰 `textFaint` | 3.84:1 | 3.24:1 |

**다크에서 되돌릴 수 없는 거부 버튼이 승인 버튼보다 5배 조용하다.** 웹은 같은 문제를 `--danger-fill` 신설로 닫고 `tokens.contrast.test.ts:365 "ranks the primary action fill above the destructive fill"`로 못박았다. 폰의 대응 단정은 **존재하지 않는다** — 잴 토큰이 없기 때문이다.

> **【출처 정정 — 오케스트레이터 발제 대비】** 이 패킷은 이 결함을 "#1164 ③"으로 지목했으나, 리뷰 전수 확인 결과 **`docs/planning/research/2026-08-07-dark1155-design-review.md`의 [Medium] M1**(PR #1163)이다. #1164 리뷰(`2026-08-08-dark1164-…`)에는 없다. 원문 그대로:
>
> > "confirm 상태는 이 PR 이 관계를 뒤집었다: **이전엔 danger 테두리(1.70:1)가 기본(1.41:1)보다 진했고, 지금은 취소(3.91:1)가 파괴적 확인 로그아웃(1.70:1 다크·1.76:1 라이트)보다 진하다. 나란한 두 버튼 중 파괴적인 쪽의 유일한 윤곽선이 화면에서 가장 흐린 선이 됐다.** 코드 주석의 면제 논거(danger 굵은 글자가 어포던스를 진다)는 그럴듯하고 danger/bg 는 AA 를 넘지만, **픽셀로 확인된 적이 없다.**"
>
> **이 사례의 진짜 교훈은 인용문보다 크다.** 같은 리뷰의 검증표는 그 PR이 **의도한** 절반을 기록한다: "로그아웃 테두리: border 1.406/1.315 (3:1 미달) → textFaint 3.909/3.587 | 재계산 정확히 일치 | 성립". 즉 **비파괴 컨트롤 하나의 경계를 3:1로 올리는 수리가, 그 옆의 파괴 형제를 화면에서 가장 흐린 선으로 만들었다.** 대비 수리가 위계 역전을 **생산**했고, 팔레트 산술 가드는 그 내내 전부 초록이었다. 위계를 **관계로** 성문화하지 않으면 각 값이 개별적으로 옳으면서 전체가 틀릴 수 있다는 것 — 이것이 §C-4의 근거다.

그리고 조용한 버튼(`buttonQuiet`)의 테두리는 `color.border`(1.41/1.30:1)다 — ①의 웹 `secondary`와 정확히 같은 실수의 폰 판본. 폰에는 3:1을 지키는 `textFaint`(3.84/3.24:1)가 이미 있고 그 독스트링이 *"웹이 컨트롤 테두리에 요구하는 **3:1**을 지킨다(`--line-strong`과 같은 자리)"*라고 적어 두었는데, 정작 컨트롤 테두리는 그것을 안 쓴다.

#### ③ 터치 타깃 28px: 규칙이 아니라 **작성자 기억**에 맡겨져 있다

`button.tsx:26-40` 주석이 이 거래를 명시적으로 적는다: `size: sm`(=`h-control-sm` 28px)과 `icon`(`size-control` 32px)은 폰에서 44px로 자라지 **않고**, "폰에서 44px가 필요한 자리는 이미 각자 `tap-target`을 자기 className에 달고 있다"에 의존한다. 즉 강제가 아니라 관례다. `--touch-target 24px`(WCAG 2.5.8 AA 바닥선)라는 별도 토큰이 있지만 이것을 전수로 재는 게이트는 없다 — `gate-composer.mjs:51-56`이 자기 표면 하나에서만 읽는다.

폰은 반대로 `slopTo()` 도출 함수 + 렌더 트리 실측 단정으로 이 축을 제대로 강제한다(`conversationHygiene.test.tsx:148-259`, 답글 표식 29pt·롤업 29pt·오류 닫기 33pt를 실제로 잡아냈다). **같은 규칙을 두 클라가 다른 강도로 지킨다.**

> **【정정】** 이 패킷은 "28px vs 44pt"를 지목했으나 **리뷰 16건 전수에 `28px`이라는 숫자는 없다.** 28은 `--spacing-control-sm`의 값(내가 코드에서 읽은 것)이다. 리뷰가 실제로 잰 44pt 미달 인벤토리는 이렇다:
>
> | 리포트 | 클라 | 자리 | 실측 |
> |---|---|---|---|
> | mobile-b3 M-8 | 폰 | 인용 블록 (묘비) | **≈41pt** (≈39pt) |
> | mobile-b3 M-9 | 폰 | 코드 복사 | **≈40pt** |
> | **u45 M-1** | **웹** | **터치 웹의 접기 토글** | **~18px** — "같은 배치가 폰 44pt를 도출식 강제하면서 터치 웹은 **WCAG 2.5.8(24px) 미달**" |
> | chat-ui-audit M-14 | 폰 | 답글 표식/롤업/오류 닫기 | ~29 / ~29 / ~33pt |
> | anchor1195 H2 · anchor1209 ③ | 폰 | ADE 앵커 칸 | 56.33 / 56.7pt ✅ |
>
> **가장 중요한 것은 웹의 18px이다.** `--touch-target 24px` 토큰이 그 리뷰의 산물인데, 그 토큰을 전수로 재는 게이트는 여전히 없다.

#### ④ 스케일 밖 값이 "컴파일되지 않는다"는 방어가 한 번 뚫렸다 — 그리고 그 전례가 중요하다

웹은 `--spacing: initial`로 Tailwind 동적 배수를 꺼서 `py-1.5` 같은 격자 밖 클래스가 **아예 컴파일되지 않게** 했다. 강력한 설계다. 그런데 U4-4가 정확히 `py-1.5`를 적었고, 화면의 묶음 안 간격이 **0px**이 됐으며, **그것을 막기로 한 가드는 초록이었다.** 이유가 기록돼 있다 (`clients/web/src/features/timeline/spacing.ts:28-38`):

> "그 일을 막기로 한 가드는 초록이었다. 아래 표가 **Tailwind 기본 스케일**을 열거하고 있었기 때문이다 — 이 레포가 쓰는 표가 아니라 Tailwind가 기본으로 주는 표. 거기에는 `1.5`가 있으므로 검산은 통과했고, 브라우저에는 그 클래스가 없었다."

수리 방식이 이 레포의 정답 패턴이다: 가드가 스케일을 **베껴 적지 않고** `tokens.css`를 파싱해서 답한다(`spacing.test.ts:39-66`). **디자인 시스템 설계의 1번 교훈**: 사본을 두면 사본이 거짓말한다. 정본을 읽어라.

#### ⑤ 포커스 링이 전역으로 **페이드한다** — 원인을 특정했다

`design/ui/button.tsx:8`·`input.tsx:22`·`select.tsx:37`을 비롯해 **21개 파일 25개 클래스 리스트**가 `transition-colors`와 `focus-visible:outline-accent`를 같이 든다. Tailwind v4.3.3(설치본 실측)의 `transition-colors` 속성 목록은:

```
color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-*
```

**`outline-color`가 들어 있다.** Tailwind v3에는 없던 것이다. 결과: 탭으로 포커스가 들어오면 `outline-width`는 즉시 2px로 서지만 `outline-color`는 `currentcolor`(= `--ink`, 본문 잉크)에서 `--accent`로 기본 150ms 동안 **번진다.** 키보드가 1급 문법인 제품(ux-bible P11)에서 포커스 표시가 처음 한 프레임 동안 잉크색으로 나타났다가 호박색이 되는 것이고, 이건 컴포넌트 하나의 실수가 아니라 **프리미티브에서 나온 전역 성질**이다.

*고칠 자리*: `transition-[color,background-color,border-color]`로 좁히거나 `transition-colors` 위에 `transition-[outline-color]:none`을 얹는다 — 어느 쪽이든 **프리미티브 3개**만 고치면 25곳이 함께 낫는다. 이것이 "우리에게 디자인 시스템이 필요한 이유"의 가장 깨끗한 사례다: 시스템이 있으면 한 줄, 없으면 25곳.

**이것은 리뷰가 아직 한 번도 잡지 못한 결함이다.** 리뷰 16건 전수에서 포커스 링의 페이드/트랜지션/애니메이션을 다룬 항목은 **0건**이다. `tokens.css`의 두 `:focus-visible` 블록(≈:399·:727)은 트랜지션이 없어 깨끗하고, 프리플라이트 `naked_focus`는 매번 `OK 0`이었다 — **문제는 토큰이 아니라 프리미티브의 유틸리티 조합에 있고, 지금 그 조합을 보는 눈이 없다.**

*보강 증거*: `gate-shell-layout.mjs:760-764`가 정확히 같은 현상 때문에 400ms를 기다린다 — "getComputedStyle은 전이 중이면 **보간된 현재 프레임**을 돌려준다 … 실측: 해제 직후 rgb(240 168 80) = --accent. **기본 전이는 150ms**이므로 그 두 배 넘게 기다린다."

*미확인*: 실제 렌더에서 이 페이드가 사람 눈에 얼마나 보이는지는 재지 않았다(브라우저 실행 없이 코드·패키지 실측만). 판정 전 캡처 1장이 필요하다.

#### ⑥ ux-bible과 코드는 서로를 모른다

`docs/ux-bible/README.md`의 P1~P15는 Slack 레퍼런스에서 뽑은 **제품·UX 원칙**이다(알림 예산, unread가 곧 제품, 부팅 예산, 키보드 우선…). 시각 규칙은 사실상 P11(키보드 우선) 하나뿐이고, 색·간격·위계·상태에 대한 조항이 없다. 실제 시각 규칙은 전부 `.claude/skills/momo-design-taste{,-web}/`에 있다. 즉 **UX 정본과 디자인 시스템 정본이 다른 문서고, 서로 참조하지 않는다.**

#### ⑦ "고정 스케일"은 6단계가 아니라 **6단계 + 이름 15개**이고, 그 15개가 자란다

`tokens.css`의 리듬 스케일은 `{0, px, 4, 8, 12, 16, 24, 32}`다. 그런데 `--spacing-*` 선언은 실제로 16개다:

```
marker(2) row(6) control-sm(28) control(32) control-lg(40)
action(144) action-sm(96) pane-sm(192) pane(320) pane-md(512) pane-lg(640)
diff-body(400) terminal-body(320) preview-frame(180) tray-max(240) px(1)
```

**이 설계 자체는 옳다.** 격자 밖 측정값이 `w-[320px]` 같은 익명 숫자가 아니라 **이름**으로 들어오게 강제하고, 각 이름은 자기가 왜 격자 밖인지를 주석으로 진다(그 주석들은 이 레포에서 가장 잘 쓰인 문서다). 하지만 관찰:

- 최근 한 달에 최소 5개가 새로 생겼다 — `row`(U4-4R) · `action-sm`(MOMO-676) · `preview-frame`·`tray-max`(#1202).
- `preview-frame` 주석이 그 신설 이유를 적는다: 앞 판이 `--spacing-action`(버튼 최소 **폭**)을 **높이**로 빌려 썼다. 즉 이름 축은 **축이 섞이는 사고**를 이미 한 번 냈다.
- `taste-web` SKILL §3은 이 이름 축을 `h-control-*`과 `app-shell`만 언급한다. **문서가 15개 중 4개만 안다.**
- 자라는 속도를 재는 것이 없다. 상한도, 분류(폭/높이/컨트롤/측정값)도 강제되지 않는다.

#### ⑧ 모션에는 토큰 축이 아예 없다

웹의 지속시간 실측: `400ms`×2 · `160ms`×2 · `120ms`×2 · `500ms` · `30ms` — 5개 값이 손으로 적혀 있다. `tokens.css`에 모션 토큰은 없다. `prefers-reduced-motion` 처리는 5개 파일에만 있다. 2026-07-28 갭 감사가 이미 `instant=0 / fast=120 / standard=180 / slow=240` 토큰을 권고했고(`docs/planning/research/2026-07-28-tauri-rn-agent-platform-gap-audit.md:253-263`) 채택되지 않았다. 폰은 지속시간 리터럴 자체가 아직 거의 없다(선점 기회).

#### ⑨ 폰에는 taste 스킬 방언이 없다 (자백된 상태)

`clients/mobile/src/design/tokens.ts:5-9`:

> "Nothing here is a guess about what the product should look like — that conversation belongs with 성재 and the design-taste skills, **neither of which has an RN dialect yet.**"

`.claude/agents/design-review.md`의 `description`도 macOS 전용이다("Reviews momo macOS SwiftUI UI changes … clients/macOS or clients/Core views"). `AGENTS.md:145`도 macOS/Core UI에만 design-review 에이전트를 요구한다. 그런데 지난 2주 리뷰 14건은 대부분 웹·폰이다. **계약 문서가 죽은 표면을 가리키고, 실무는 계약 밖에서 돈다.**

### B-5. 실행 경로의 구멍 — 만들어 둔 가드가 안 돌 수 있다

① **GitHub Actions는 디자인 게이트를 하나도 돌리지 않는다.** `.github/workflows/ci-build.yml`은 Swift 5패키지 빌드/테스트뿐이고 그마저 `workflow_dispatch` 전용이다(`"기본 merge gate는 docs/LOCAL_PR_GATE.md의 local evidence"`). 모든 디자인 강제는 오케스트레이터가 로컬에서 손으로 돌린다. 즉 **강제 층의 실행 보장이 사람**이다.

② **`clients/web`의 ESLint는 어느 게이트에도 안 걸려 있다.** `local_gate.sh`의 `web` 프로파일은 `(cd clients/web-legacy && npm run lint)`을 돈다 — **동결된 레거시 클라**다(:867-877 전 줄이 `web-legacy`). `verify_merge_tree.sh`의 7레인에도 lint가 없다. 정본 UI `clients/web`의 `no-restricted-syntax`(hex 금지·인라인 style 금지)는 사람이 `npm run lint`를 손으로 칠 때만 돈다. *완화 요인*: 두 규칙 다 `design_preflight_web.sh`의 `raw_color`/`inline_style` 분류가 그렙으로 중복 커버한다. 그래서 지금 손실은 없지만, **중복이 유일한 안전망**이다.

③ **폰 게이트가 얇다.** `clients/mobile/package.json`의 게이트는 `gate:project-shape`·`gate:session`(시뮬레이터 세션 생존)뿐. 디자인 축은 `npm test`(jest) 안에 섞여 있고, 그건 `verify_merge_tree.sh`의 `phone suite` 레인으로 돈다 — 즉 **돌긴 돈다.** 다만 "디자인 프리플라이트"라는 이름의 실행 단위가 없어서 무엇이 커버되는지 아무도 한눈에 못 본다.

### B-6. macOS: 죽은 표면을 지키는 살아 있는 게이트

- `docs/planning/research/2026-08-09-swift-removal-audit.md` 판정: **"지금 Swift 트리를 통째로 삭제하면 제품이 깨진다. 부분 삭제만 가능하다."** `clients/macOS`는 327파일/165 swift, "검수 표면 아님"으로 분류돼 있으나 삭제 조건(보류 11패밀리 판정)이 미충족.
- `Theme.swift:15`: `agentAccent = Color(red: 0.45, green: 0.36, blue: 0.92)` — **네온 보라**. Dawn 팔레트가 명시적으로 금지한 바로 그 색이다(`tokens.css`: *"never neon AI purple"*). 폰이 #1164에서 같은 색(#b58bd6)을 걷어낸 그 색.
- `.claude/skills/momo-design-taste/references/tokens.md` 머리: *"Until `clients/Core/Sources/.../MomoDSTokens.swift` lands, this file IS the token spec."* — **그 파일은 끝내 랜딩하지 않았다.** mac 토큰 층은 문서로만 존재한다. 다만 그 문서의 스케일(간격 `{4,8,12,16,24,32}`, 반지름 `6/10/14`)이 지금 **웹이 쓰는 값과 정확히 같다** — 웹이 이 명세를 물려받았다는 증거이고, 새 시스템의 스케일 정본을 고를 때 참고할 계보다.
- 그런데 `local_gate.sh --profile swift`는 여전히 `verify_design_preflight.sh` 래칫을 돌린다. **폐기 예정 클라를 위해 유지비를 내고 있다.**

---

## A. 업계 방식 조사 (외부 1차 소스, 2026-08-09 실측)

> 조사 원칙: 공식 문서·공개 레포·해당 팀이 직접 쓴 글만. 버전·날짜·라이선스는 GitHub API와 npm 레지스트리에서 당일 조회. 확인 못 한 것은 §A-5에 정직하게 남긴다.

### A-1. 토큰 층 — 단일 원본 생성 vs 손 동기화

#### A-1-1. Style Dictionary는 **React Native 출력이 없다** (가장 중요한 정정)

| 사실 | 값 | 출처 |
|---|---|---|
| 최신 | **5.5.1** (2026-08-07) | [npm](https://registry.npmjs.org/style-dictionary/latest) |
| 라이선스 | **Apache-2.0** | 동 |
| 조직 | `amzn/`에서 **이관됨** — `amzn/style-dictionary` → `style-dictionary/style-dictionary` 리다이렉트 | [repo](https://github.com/style-dictionary/style-dictionary) |
| v5 요구 | **Node ≥ 22.0.0** | [v5 마이그레이션](https://styledictionary.com/versions/v5/migration/) |

CSS 커스텀 프로퍼티는 1급이다(`css/variables` → `:root { --x: … }`). `css` 트랜스폼 그룹은 14개 트랜스폼(색·크기·그림자·타이포·보더·트랜지션 shorthand 포함).

**그런데 RN은 다르다.** [predefined formats](https://styledictionary.com/reference/hooks/formats/predefined/)에 **`react-native/*` 포맷이 없고 `StyleSheet`를 내는 것도 없다.** `react-native` **트랜스폼 그룹**은 존재하나 [내용이 셋뿐](https://styledictionary.com/reference/hooks/transform-groups/predefined/)이다:

```
name/camel, size/object, color/css
```

**그림자 트랜스폼 없음 · 타이포 없음 · 보더 없음 · 트랜지션 없음.** 모든 합성 토큰 shorthand 트랜스폼은 `/css/` 접미사다. `react-native` 그룹만 `attribute/cti`를 빠뜨리는 버그는 2024-10부터 [#1363](https://github.com/style-dictionary/style-dictionary/issues/1363)으로 열려 있고 유지자 답이 없다.

공식 RN 예제([config.json](https://github.com/style-dictionary/style-dictionary/blob/main/examples/advanced/create-react-native-app/config.json))가 내는 것은 `javascript/es6` — **평평한 상수 모듈**이다. 그리고 `size/object`는 숫자가 아니라 `{original, number, decimal, scale}` 객체를 낸다. 소비 코드([App.js](https://github.com/style-dictionary/style-dictionary/blob/main/examples/advanced/create-react-native-app/src/App.js))가 그 대가를 보여준다:

```js
fontSize: PixelRatio.getFontScale() * variables.sizeFontMd.scale,
color: variables.colorBrand02,
```

한 줄은 `.scale`, 다음 줄은 `.number`, 폰트 배율은 손으로 곱한다. **이것이 Style Dictionary의 레퍼런스 RN 통합이다.**

#### A-1-2. DTCG 표준: 안정판이 나왔으나 **우리에게 필요한 부분이 그 안에 없다**

| 문서 | 버전 | 상태 |
|---|---|---|
| Design Tokens **Format** Module | **2025.10** | **Stable** (2025-10-28) — [designtokens.org/tr/2025.10/format/](https://www.designtokens.org/tr/2025.10/format/) |
| Design Tokens **Resolver** Module | 2025.10 draft | *"⚠️ preview draft … **Do not attempt to implement this version**"* — [drafts/resolver](https://www.designtokens.org/tr/drafts/resolver/) |

W3C **Community Group** 리포트이며 *"not a W3C Standard nor on the Standards Track"*임을 명시한다. 우리에게 직격하는 두 가지:

1. **`dimension`은 `px`와 `rem`만 허용한다.** 단위 없는 값도, dp/pt도 없다. RN의 숫자는 밀도독립 포인트다. **px→RN 변환은 표준이 정해 주는 게 아니라 우리가 발명하는 관례다.**
2. **테마(light/dark)가 안정 스펙에 없다.** Resolver Module에 있고 그것은 "구현하지 말라"는 배너를 달고 있다. 우리 `light-dark()` 한 줄이 하는 일을 DTCG는 아직 표준화하지 못했다.

Style Dictionary 자신도 [DTCG 페이지](https://styledictionary.com/info/dtcg/)에서 2025.10 완전 준수는 진행 중이라 밝힌다. 그리고 DTCG가 관리하는 [지원 도구 목록](https://github.com/design-tokens/community-group/discussions/312) **어디에도 React Native 출력을 말하는 도구가 없다.**

#### A-1-3. 실제로 이걸 하는 팀 — 공개 사례가 **둘뿐**이고 둘 다 교훈이 있다

| 팀 | 생성기 | CSS 변수 | RN | 생성물 git 커밋 | 라이선스 |
|---|---|---|---|---|---|
| **IBM Carbon** | SD ^5.5.0 + DTCG JSON | ✅ | ✅ ([carbon-react-native](https://github.com/carbon-design-system/carbon-react-native)) | **gitignore** | Apache-2.0 |
| **Skyscanner Backpack** | Theo(**아카이브됨**) | SCSS 변수(커스텀 프로퍼티 아님) | ✅ → **RN 패키지 아카이브(2024-12-02)** | **커밋 + CI pristine 검사** | Apache-2.0 |
| Pinterest Gestalt · GitHub Primer · Shopify Polaris · Adobe Spectrum · MS fluentui-react-native | SD 또는 자체 | ✅ | **❌ (전부)** | gitignore | — |

**Carbon의 실패가 우리 질문에 직접 답한다.** `carbon-react-native/src/styles/colors.ts`가 웹 토큰 패키지의 **내부 `src/` 경로**를 import한다:
```ts
import * as g10 from '@carbon/themes/src/g10.js';
```
그 경로를 확인한 결과: `packages/themes/src/g10.js` → **HTTP 404** · `packages/themes/src/dtcg/g10.json` → HTTP 200. **웹 팀의 DTCG+SD v5 이주가 RN 클라가 import하던 파일을 지웠다.** 파이프라인이 **있어도** 두 플랫폼은 조용히 갈라진다.

**Skyscanner의 그림자가 이 질문의 하드 바운더리다.** 한 소스에서 생성된 결과물:
```js
// lib/bpk-styles/src/shadows.android.js — 안드로이드 그림자 구현 전체
export default {
  base: () => ({ shadowColor: undefined, shadowOffset: {height: undefined, width: undefined},
                 shadowOpacity: undefined, shadowRadius: undefined }),
  large: () => ({ /* 동일, 전부 undefined */ }),
};
```
```js
// shadows.ios.js — 런타임에 PixelRatio로 나눠야 한다
height: shadowSmOffsetHeight / PixelRatio.get(),
```
같은 개념의 웹 토큰은 문자열 `"0px 1px 3px 0px rgba(37,32,31,.3)"` 하나다. **한 개념, 세 개의 화해 불가능한 표현.** 그리고 RN 패키지는 결국 아카이브됐다.

**도구 자신의 구조적 한계**, 제작자 Danny Banks의 답변([#455](https://github.com/style-dictionary/style-dictionary/issues/455)):
> "**So you can't have a token within a token**, because that would mess with transforming them."

elevation 토큰이 필요로 하는 모양(`shadow*` **와** `elevation`을 한 이름 아래)이 바로 그것이다. 2024-12-10 "답변됨"으로 닫혔다.

⚠️ **라이선스 지뢰 — Shopify Polaris**: MIT 텍스트 + **사용 분야 제한**이 붙어 있다. [LICENSE.md](https://github.com/Shopify/polaris/blob/main/LICENSE.md): *"The rights granted above may only be exercised to develop and distribute applications that integrate or interoperate with Shopify software or services…"* — **자유 라이선스가 아니다. 벤더링 금지.** (조사한 어느 레포에도 AGPL은 없었다.)

#### A-1-4. 빌드 단계가 실제로 내는 비용

- **생성물을 git에 넣는가**: SD의 공식 배포 예제 `.gitignore`는 `build/` + `node_modules/`다. Carbon·Primer·Gestalt 모두 gitignore. Skyscanner만 커밋 + CI `check-pristine-state`.
- **리뷰 소음은 실재하고 이름이 있다**: [SD #768 "Update generated date only when changed"](https://github.com/style-dictionary/style-dictionary/issues/768) — 2022-01 개설, **여전히 열림**. 값이 안 바뀌어도 생성 날짜가 바뀐다. 유지자 답: 타임스탬프 없는 fileHeader를 쓰라. GitLab도 같은 벽에 부딪혀 [직접 타임스탬프를 벗겼다](https://gitlab.com/gitlab-org/gitlab-ui/commit/4e9253008e12e7deaa8e8faa29e5c3fe0d618418).
- **"누가 빌드를 돌리나"는 사라지지 않고 규모에서 악화된다** — [Kubernetes 개발 블로그](https://www.kubernetes.dev/blog/2022/03/15/k8s-triage-bot-helper-ci-job/): *"Many contributors do not have access to powerful environments in which to run `make update` or `make verify`."* 게이트가 기여자 차단 문제가 됐고, 임시 처방이 CI 재생성 + 아티팩트 다운로드, 장기 처방이 봇 커밋이다.
- **손으로 고쳐진 생성물 드리프트**는 Go가 `// Code generated by <tool>. DO NOT EDIT.` 헤더를 표준화한 이유다([golang/go#13560](https://github.com/golang/go/issues/13560)).
- **빌드 지연은 문제라는 증거가 없다** (SD #768의 부수 언급: *"currently it is quick enough to not notice"*). DX 마찰을 논하려면 **느림이 아니라 "돌리는 걸 잊음"**을 논해야 한다.

#### A-1-5. 우리 방식(손 동기화 + CI 가드)의 정당성 — **정직한 답**

**우리가 요청한 반론("소규모에선 CI 강제 손 동기화가 충분하거나 낫다")을 공개 1차 소스에서 뒷받침하는 글은 0건이다.** 8갈래로 검색한 결과이며, 검색이 부족한 게 아니라 **문헌의 공백**이다.

> ⚠️ 그 질문을 검색하면 대부분 **AI 생성 SEO 콘텐츠**(uxpin·contentful·penpot·door3 등)가 나오고, 감사가 인용하고 싶어질 문장을 정확히 뱉는다(*"Style Dictionary 풀 파이프라인은 오버킬"*, *"문턱은 컴포넌트 5~10개, 엔지니어 2인 이상"*). **출처 없음 — 인용 금지.** 이 질문이 답해진 것처럼 *보이는* 이유가 그것이다.

**대신 신뢰할 수 있는 인접 증거는 있다:**
- **Salesforce가 방향을 되돌렸다** — "design token"이라는 용어를 만든 곳이다. [LWC 공식 문서](https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-design-tokens.html): *"**SLDS 2 replaces design tokens with a system of CSS custom variables called global styling hooks.**"* SLDS 2로 안 가더라도 토큰에서 이주하라고 권한다.
- **Donnie D'Amato**(DTCG 참여자, designtokens.fyi 저자), [Avoiding tokens](https://blog.damato.design/posts/avoiding-tokens/) — Salesforce 논리를 전한다: *"여러 프레임워크에 걸쳐 쓰려고 토큰을 만드는 것이 추가 단계였는데, **Salesforce의 99%는 단일 플랫폼(웹)이다.**"*
- **Robin Cannon**(IBM Carbon 프로그램 디렉터, J.P.Morgan 디자인 언어 총괄), [The design token cargo cult](https://www.robin-cannon.com/p/the-design-token-cargo-cult): *"오버헤드는 실재한다: 툴링 의존·Figma 동기화·거버넌스. **그런데 변수 이름이 어차피 써야 할 CSS 속성과 1:1로 대응한다면 추가 레버리지가 없다.**"*
- **Nate Baldwin**(Adobe Spectrum), [Component-level design tokens: are they worth it?](https://medium.com/@NateBaldwin/component-level-design-tokens-are-they-worth-it-d1ae4c6b19d4) — Spectrum이 **18MB JSON에 토큰 210,180개**에 도달해 *"기여 능력에 부정적 영향"*을 줬다고 보고. 전제 조건(프레임워크 구현 4개 이상, 전담 툴링 팀 등)을 나열하고 *"대부분의 디자인 팀은 해당되지 않는다"*로 맺는다.

**반대로 없는 것도 정직히**: **Style Dictionary 포스트모템은 0건이다.** 도입 후 제거를 공개한 팀이 없다. 이주는 전부 Theo→SD 방향이다. "SD 도입을 후회한다"는 주장은 **근거 없음**.

#### A-1-6. 우리 가드가 서 있는 자리 — 그리고 **잡히는 지점**

"재생성해서 diff"는 완전히 주류다:
- Kubernetes [`hack/verify-codegen.sh`](https://github.com/kubernetes/sample-controller/blob/master/hack/verify-codegen.sh) — 커밋된 출력을 옆에 복사, 재생성, `diff -Naupr`, 다르면 exit 1 + *"Please run hack/update-codegen.sh"*
- **GitLab은 이것을 디자인 토큰에 그대로 적용한다** — [`bin/check_tokens_build.sh`](https://gitlab.com/gitlab-org/gitlab-ui/-/raw/main/bin/check_tokens_build.sh):
  ```bash
  yarn build-tokens
  git diff --exit-code ./src/tokens/build
  ```

> **그런데 잡히는 지점이 여기다.** 이 문헌 전부가 승인하는 것은 **생성물을 그 생성기와 대조하는 것**이다. **손으로 유지되는 두 소스를 서로 대조하는 것**을 승인하는 문헌은 없다. 우리 가드는 `tokens.css`를 파싱해 `tokens.ts`가 맞는지 본다 — **생성기가 없으므로 되돌아가 재생성할 "진실의 원본"도 없다.** CSS 파일이 원본 노릇을 하는 것은 **관례일 뿐**이다. Go/Kubernetes/GitLab 선례는 이 형태를 덮지 않는다.

> **그리고 GitLab이 증명하는 두 번째 사실**: **빌드 단계를 도입해도 가드 스크립트는 사라지지 않는다.** 바뀌는 것은 가드가 *무엇을* 검사하느냐다. 그래서 이 결정의 정직한 대립항은 "가드 스크립트 vs 파이프라인"이 아니라 **"손으로 쓴 두 파일을 서로 대조" vs "생성된 한 파일을 그 생성기와 대조"**다. 후자는 20년 선례가 있고 전자는 없다 — **그리고 그것이 규모와 무관한, 바꿀 가장 강한 이유다.**

#### A-1-7. CSS ↔ RN: 무엇이 1:1이고 무엇이 원리적으로 안 되나

RN 최신 안정판 **0.86.2**(2026-07-27, MIT). `boxShadow`/`filter`는 **0.76**에서 New Architecture 전용으로 들어왔고 0.76부터 NA가 기본이라 0.86에선 사실상 사용 가능. RN [Style 문서](https://reactnative.dev/docs/style) 자신의 표현: *"In some cases React Native does not match how CSS works on the web."* **RN에는 캐스케이드도, 상속도, CSS 커스텀 프로퍼티도 없다** — `:root {}` 블록에 대응물이 없다는 것이 모든 파이프라인이 RN에 JS 객체를 내는 이유다.

**깨끗하게 1:1**: 색(hex/rgba 문자열 동일) · 간격/반지름(rem 기준 고정 + 단위 제거 시) · `fontSize` · `fontWeight`(동일 enum) · `opacity`/`borderWidth` · Flexbox(단 `flexDirection` 기본값이 `column`)

**손실 있는 변환**:
| 축 | 문제 |
|---|---|
| `lineHeight` | 웹 관용은 **무단위 비율**(1.5). RN은 **절대 포인트 수**. 한 토큰이 둘을 못 섬긴다 — 그리고 RN 값은 특정 `fontSize`에서만 옳다. (**우리 폰 `line {head15, meta17, label18, body22}`가 정확히 이 문제의 산물이다**) |
| `letterSpacing` | 웹은 `em`(폰트 상대), RN은 절대 수 |
| `rem` 자체 | DTCG는 px/rem만 허용, RN엔 rem이 없다 |
| 폰트 배율 | 웹은 브라우저 줌 자동, RN은 `PixelRatio.getFontScale()` 수동 곱 |

**원리적으로 변환 불가 — 그림자/고도**: RN [Shadow Props](https://reactnative.dev/docs/shadow-props)는 **세 개의 별개 API**를 갖는다: `boxShadow`(NA 전용, Android 9+/10+) · `shadowOffset/Opacity/Radius`(**iOS 전용**) · `elevation`(**Android 전용**, z-order까지 바꾼다) · `filter: dropShadow`(**Android 전용**, spread 없음). 게다가 **DTCG `shadow` 타입에는 `inset`이 없다.** 그리고 SD는 토큰 안에 토큰을 못 넣는다. 4개 층 전부에서 막힌다.

**그 밖의 불가**: 타이포 합성(RN엔 `font` shorthand 자체가 없다) · 텍스트 그림자(spread 없음) · 보더 shorthand(RN 없음, 대신 iOS 전용 `borderCurve`) · 트랜지션/이징(RN엔 CSS 트랜지션이 없다 — Animated/Reanimated는 다른 모델) · **`outline*` 전부 NA 전용**(포커스 링 토큰이 동일하게 동작하지 않는다) · `mixBlendMode`(NA + Android 10+) · 플랫폼 전용 텍스트 props(`includeFontPadding`·`textAlignVertical` = Android / `textDecorationColor`·`writingDirection` = iOS)

#### A-1-8. Tauri 고유 사항

Tauri는 Apache-2.0, `@tauri-apps/api` 2.11.1(Apache-2.0 OR MIT).

**가장 큰 것: 같은 브라우저가 아니다.** [Webview Versions](https://v2.tauri.app/reference/webview-versions/): Windows=WebView2(에버그린) · **macOS/iOS=WKWebView(OS 버전에 묶임)** · Linux=webkit2gtk(*"배포판별 정확한 정보 취합이 매우 어렵다"*). → **우리 `tokens.css`의 브라우저 하한선은 Chrome이 아니라 "사용자 macOS 버전의 Safari"다.** `oklch()`·`color-mix()`·`light-dark()`·`@property`를 쓴다면 Tauri macOS 빌드가 바닥선이다. (**우리는 `light-dark()`를 팔레트 전체의 기반으로 쓴다 — 이 하한선 확인이 미결이다.**) DevTools도 플랫폼별로 다르다(macOS에선 Safari 인스펙터).

**다크 모드 버그 — 실재했고 최근 고쳐졌다**: [tauri#9427](https://github.com/tauri-apps/tauri/issues/9427) *"Tauri does not detect system theme preference on Linux"* — 2024-04 개설, **2026-03-23 완료**. 수정은 [tao#1141](https://github.com/tauri-apps/tao/pull/1141)(2026-03-22 머지), **Tauri v2.11부터**. → **v2.11 미만에 핀하면 Linux에서 `prefers-color-scheme` 기반 스킴 선택이 불안정하다.** 우리 API는 2.11.1이라 통과. *(우리 `tauri.conf.json` 확인 결과 `decorations` 커스텀·`titleBarStyle` 사용 없음 — 기본 창이라 아래 함정 대부분 비해당.)*

**토큰으로 표현할 수 없는 데스크톱 전용 축** (공식 [config schema](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-schema-generator/schemas/config.schema.json) 원문):
- `titleBarStyle: Overlay` 경고: *"**The height of the title bar is different on different OS versions**…"* → **타이틀바 높이는 상수로 토큰화할 수 없다.**
- `transparent`: *"**WARNING: Using private APIs on macOS prevents your application from being accepted to the App Store.**"*
- `windowEffects`(macOS vibrancy 19종 + Windows mica/acrylic, **Linux 미지원**)는 Rust/JSON에서 설정한다 — **"표면 배경" 토큰의 네 번째 표현이고 우리 토큰 파일이 표현할 수 없다.**
- `data-tauri-drag-region`은 **드래그 영역 기제이지 플랫폼 감지 훅이 아니다**. 그리고 *"직접 적용한 요소에만 작동하며 자식마다 따로 붙여야 한다."* 플랫폼 조건부 스타일링은 [OS 플러그인](https://v2.tauri.app/plugin/os-info/)의 `platform()`을 런타임에 읽어 직접 클래스를 찍어야 한다.
- 세이프 에어리어: [tauri#11475](https://github.com/tauri-apps/tauri/issues/11475) **열림**. 데스크톱 전용 셸에는 비해당.

**"브라우저 빌드와 Tauri 빌드의 시각 패리티 유지" 공식 가이드는 존재하지 않는다.** 검색 실패가 아니라 **문서 공백**으로 기록한다.

### A-2. 컴포넌트 층 — 공유하는가? **업계 답: 우리 방식(계약만 공유)이 맞다**

이 절이 이 보고서에서 가장 확실한 결론이다. 우리는 "웹과 RN 구현을 따로 쓴다"를 소극적 선택으로 여겨 왔는데, **1차 소스는 그것이 대형 디자인 시스템의 표준 선택임을 말한다.**

| 프로젝트 | 라이선스 | 최신 릴리스 | 마지막 푸시 | 판정 |
|---|---|---|---|---|
| [react-native-web](https://github.com/necolas/react-native-web) | MIT | 0.21.2 — 2025-10-16 | **2025-10-16** | **사실상 휴면 (~10개월 무커밋)** |
| [react-strict-dom](https://github.com/facebook/react-strict-dom) | MIT | 0.0.55 — 2026-01-09 | 2026-06-23 | Meta 후계자이나 **2년째 0.0.x** |
| [Tamagui](https://github.com/tamagui/tamagui) | MIT | v2.7.4 — 2026-08-09 | 2026-08-09 | 살아 있으나 **12일에 10릴리스** |
| [NativeWind](https://github.com/nativewind/nativewind) | MIT | 4.2.6 — 2026-06-22 | 2026-07-17 | 안정판은 **Tailwind v3 전용**, v5는 2026-05부터 preview 정체 |
| [gluestack-ui](https://github.com/gluestack/gluestack-ui) | **루트 LICENSE 파일 없음** | v5.0.0 — 2026-06-25 | 2026-08-06 | 라이선스 거버넌스 적신호(§A-4) |

**결정적 증거 — RNW 제작자 본인의 말.** Nicolas Gallagher, [discussion #2646](https://github.com/necolas/react-native-web/discussions/2646) (2024-04-01):

> "**There is no investment at Meta in RNfWeb by either the Web or RN teams**, whereas both have been working on RSD." … "I will continue to review PRs and merge fixes. But I don't expect to put significant time into major development initiatives."

2025-12-06에 Software Mansion/Expo에 유지보수 이관을 제안([#2816](https://github.com/necolas/react-native-web/discussions/2816))했고, 2026-03-24 후속 질문에 답이 없다. 커밋은 2025-10 이후 0. **긴장점**: [Expo 공식 웹 문서](https://docs.expo.dev/workflow/web/)는 여전히 RNW를 권한다 — 공식 권고와 제작자 진술이 반대 방향을 가리킨다.

**"계약을 공유하되 구현은 나눈다"의 가장 좋은 문장** — Discord 엔지니어, [HN 2018-07-27](https://news.ycombinator.com/item?id=17623225):

> "**The economics of RN allows us to share the last 4** [stores, data fetching, action creators, utilities]. **However, sharing the first** [view/UI] **is actually more or less impossible**… Certainly you can argue that sharing this much business logic would necessitate that the UI layer looks all the same, but **I fundamentally disagree. That is like saying that because all your clients use the same API, they all must look the same.**"

**보강 증거 넷:**
- **Shopify**(RN 찬성 진영)조차 [Five years of React Native](https://shopify.engineering/five-years-of-react-native-at-shopify) (2025-01-13)에서 **"100% React Native should be an anti-goal"**. 그들의 공유 서사는 iOS↔Android이고 **웹은 들어 있지 않다.**
- **Airbnb**, [Sunsetting React Native](https://medium.com/airbnb-engineering/sunsetting-react-native-1868ba28e30a) (2018): "**wound up supporting code on three platforms instead of two.**" — 범용 층은 표면을 줄이는 게 아니라 **하나 더 만든다.**
- **Microsoft**는 [fluentui](https://github.com/microsoft/fluentui)(웹)와 [fluentui-react-native](https://github.com/microsoft/fluentui-react-native)(MIT, 네이티브)를 **별도 레포·별도 구현**으로 내고, 명세로만 묶는다. **Adobe** react-spectrum(Apache-2.0)도 웹 전용에 토큰만 분리 패키지.
- Tamagui→Tailwind [이탈 기록](https://seedteamtalks.hyper.media/updates/migrating-ui-components-from-tamagui-to-tailwind) (2025-07-22): "monorepo에서 셋업이 어려웠고, 성능 문제가 빠르게 생겼고, 스타일이 Tamagui 레이아웃 로직에 결합돼 점진 이주가 막혔다."

**싸게 공유되는 것 / 비싸게 갈라지는 것** (위 증거들의 종합):
- **싸다(공유하라)**: 디자인 토큰 · 검증 스키마 · 카피/i18n · API 클라이언트 · 상태 저장소 · 순수 로직 훅 · 타입 · **컴포넌트 계약**(이름·prop·variant 어휘·동작 명세)
- **비싸다(나눠라)**: 레이아웃(RN엔 CSS grid도 cascade도 sticky도 없다) · 제스처/스크롤 물리 · **포커스 관리와 탭 순서**(네이티브엔 DOM 포커스 모델이 없다) · a11y 시맨틱(ARIA vs `accessibilityRole`) · 모달/포털/z-index · 텍스트 렌더링/줄높이 · 키보드 · 내비게이션

**우리에게 주는 함의**: 우리가 이미 공유하는 것(`packages/momo-core` — 모델·문장·타임라인 판정)은 정확히 "싸다" 목록이다. 우리가 나눈 것(`clients/web/src/design/ui` vs `clients/mobile/src/design/atoms`)은 정확히 "비싸다" 목록이다. **바꿀 이유가 없다.** 그리고 Tauri는 웹 구현을 그대로 물려받으므로 네 번째 구현이 아니다(§B-1 핵심사실 4).

### A-3. 강제 층 — 이 보고서에서 가장 중요한 발견

#### A-3-1. WCAG 1.4.11(비텍스트 대비)은 **아무 도구도 팔지 않는다**

우리 팀이 직접 짠 대비 시험을 "바퀴 재발명"으로 볼 수도 있었다. **아니다. 시장에 그 물건이 없다.** 두 갈래로 증명됐다:

**증명 1 — axe-core 규칙표 전수.** [axe-core 4.13.0 `rule-descriptions.md`](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md) (MPL-2.0, 2026-08-05) 105개 규칙을 파싱한 결과: `wcag1411` 태그 **0건** · 문자열 `1.4.11` **0건** · `focus-visible` 규칙 **없음**. 대비 규칙은 `color-contrast`(wcag143)와 `color-contrast-enhanced`(wcag146) 둘뿐이고 **전부 텍스트 전용**이다.

**증명 2 — Deque 자사 공개 데이터.** [Semi-Automated Accessibility Testing Coverage Report](https://accessibility.deque.com/hubfs/Semi-Automated-Accessibility-Testing-Coverage-Report.pdf):

| SC | axe DevTools 커버리지 | 자동 발견 | 인간보조(IGT) 발견 | **수동 전문가에게 남는 몫** |
|---|---|---|---|---|
| **1.4.11 비텍스트 대비** | **0.00%** | 0.00% | 0.00% | **100.00%** |
| 1.4.3 텍스트 대비 | 83.11% | 대부분 | — | 소량 |
| 2.4.7 Focus Visible | 100% | **0%** | 100% | — |

Deque **유료 제품**의 데이터이고 자사 상업적 이익에 반하는 방향이라 신뢰도가 높다. 참고로 1.4.3(텍스트 대비)은 **전체 접근성 이슈의 30.08%로 단일 최다 항목**이다.

**우리 결정에 주는 정확한 함의 둘:**
1. 우리 토큰 대비 시험(`tokens.contrast.test.ts`·`paletteContrast.test.ts`)은 **시장에 없는 것을 덮는다.** axe를 들여와도 **지우면 안 된다.**
2. 반대로, 우리에게 **진짜 빈 자리**가 있다: axe는 **실제 렌더된·상속된 계산 배경 위의 텍스트 대비**를 잰다. 토큰 쌍 단위 테스트는 "이 컴포넌트가 실제로 어떤 배경 위에 앉았는가"를 **알 수 없다**(§B-2의 "표면 목록 6개 밖은 무측정"이 정확히 이것이다). 그리고 그게 최다 이슈 유형이다.
3. axe `color-contrast`의 알려진 한계: 그라디언트·배경 이미지·1:1 비율에서는 pass/fail이 아니라 **"incomplete"**를 낸다([#4628](https://github.com/dequelabs/axe-core/issues/4628), [#3390](https://github.com/dequelabs/axe-core/issues/3390)).
4. **라이선스 주의**: `@axe-core/playwright`(v4.12.1, 2026-06-23)와 axe-core는 **MPL-2.0**이다. MIT가 아니다. 파일 단위 약한 카피레프트라 dev/CI 의존성으로는 문제없지만, permissive-only 정책 문서에 명시해야 한다.

#### A-3-2. 시각 위계를 기계로 강제하는 도구는 **존재하지 않는다**

"파괴 확인이 취소보다 무거워야 한다"를 단정하는 프로덕션 도구는 없다. 있는 것은 전부 학술 프로토타입이고 CI로 패키징된 것이 없다: [UIS-Hunter](https://xin-xia.github.io/publication/icse217.pdf) (ICSE'21, precision 0.81/recall 0.90) · [UISGPT](https://www.mdpi.com/2079-9292/13/16/3127) (F1 0.729) · [Seenomaly](https://dl.acm.org/doi/10.1109/ICSE43902.2021.00075). 업계 표준 답은 여전히 **squint/blur 테스트 + 사람 리뷰**다.

**즉 `momo-design-taste` 스킬 + design-review 에이전트 조합은 2026년 기준 이 축의 최신 기술 수준이다.** 대체할 자동화가 없다. 다만 우리가 *토큰으로* 위계를 성문화한 것(`--danger-fill` 채도 순서 단정)은 **업계 어디에도 선례를 못 찾았고 우리 쪽이 앞선다.**

#### A-3-3. 토큰 이탈 린트 — 황무지, 쓸 만한 것 둘

- **`eslint-plugin-design-tokens`는 존재하지 않는다.** v1.0.0이 2024-03-14 게시되고 **8.5시간 뒤 unpublish**됐다. 같은 이름의 GitHub 레포 셋은 전부 1인·0~1스타·최근 5개월 내 생성. 쓰지 말 것.
- 쓸 만한 것 ①: [**eslint-plugin-better-tailwindcss**](https://github.com/schoero/eslint-plugin-better-tailwindcss) — MIT, v4.7.0 (2026-07-19), 821★, **Tailwind v4 지원**. [`no-restricted-classes`](https://github.com/schoero/eslint-plugin-better-tailwindcss/blob/main/docs/rules/no-restricted-classes.md)에 임의값 전면 금지 정규식이 공식 예제로 있다: `{"restrict": ["\\[([^\\[\\]]*?)\\](?!:)"]}` — `text-[#ff0000]`과 `p-[13px]`을 한 번에 잡는다.
- 쓸 만한 것 ②: [**ESLint 코어 `no-magic-numbers`**](https://eslint.org/docs/latest/rules/no-magic-numbers) + `detectObjects: true` — 새 의존성 0. `detectObjects`는 객체 리터럴 안 숫자를 본다. `StyleSheet.create({container: {marginTop: 10}})`의 모양 그 자체 → **폰 간격 강제의 정답 후보**(§B-2 폰 간격 커버리지 2파일 문제).
- 피할 것: `eslint-plugin-tailwindcss`(francoismassart)는 살아 있으나 **Tailwind v4를 17개월간 못 다뤘다**(2025-01→2026-06). `prettier-plugin-tailwindcss`는 정렬만 하고 아무것도 금지하지 않는다. **stylelint**(`color-no-hex` 등)는 규칙 자체는 멀쩡하나 **우리 코드베이스에 구조적으로 눈이 멀었다** — CSS 선언을 파싱하므로 `className="text-[#f00]"`을 영원히 못 본다. [eslint-plugin-react-native](https://github.com/Intellicode/eslint-plugin-react-native)는 MIT지만 **~20개월 무커밋**이고 README가 그렇게 자백한다 + **숫자/px 규칙이 아예 없다**.
- Tailwind 자체에는 임의값 금지 1st-party 규칙이 **없다** — 공식 문서가 `top-[117px]`·`bg-[#bada55]`를 의도된 탈출구로 권장한다.
- **정직한 결론**: 우리 팔레트를 아는 기성 플러그인은 없다. 최저 총비용은 **우리 토큰 집합을 아는 작은 자체 규칙**이고, **그건 우리 preflight 스크립트가 이미 하고 있는 일이다.**

#### A-3-4. 시각 회귀 — 비용은 실재, 죽은 프로젝트 둘

| 도구 | 라이선스 | 최신 | 상태 |
|---|---|---|---|
| [Playwright `toHaveScreenshot`](https://playwright.dev/docs/test-snapshots) | Apache-2.0 | v1.62.1 (2026-07-30) | 건강. **새 벤더 0** |
| [Chromatic](https://github.com/chromaui/chromatic-cli) | CLI MIT / **SaaS 독점** | v18.1.0 | 사용량 과금 |
| [Argos](https://github.com/argos-ci/argos) | MIT (LICENSE 확인) | 2026-08-08 | 활발 |
| [jest-image-snapshot](https://github.com/americanexpress/jest-image-snapshot) | **Apache-2.0**(MIT 아님) | v6.5.2 | Dependabot만 |
| [Loki](https://github.com/oblador/loki) | MIT | v0.35.1 (2024-08-27) | **휴면 ~22개월** |
| Lost Pixel | — | v3.22.0 (2024-11) | **사망 — 아카이브, [팀이 Figma 합류](https://www.lost-pixel.com/blog/lost-pixel-team-is-joining-figma)** |

**흔들림은 구조적이고 Playwright가 스스로 문서화한다**: *"Browser rendering can vary based on the host OS, version, settings, hardware, **power source (battery vs. power adapter)**, headless mode…"* — 그래서 스냅샷 파일명에 플랫폼 접미사(`chromium-darwin.png`)를 붙이고 [Docker 실행을 권고](https://playwright.dev/docs/ci#docker)한다. 실사례: [#18240](https://github.com/microsoft/playwright/issues/18240)(mac vs Ubuntu 폰트), [#20097](https://github.com/microsoft/playwright/issues/20097)(**동일 사양 두 머신** 폰트 차이).

**비용 폭발 1차 기록**: [ComplyAdvantage](https://technology.complyadvantage.com/how-we-cut-our-chromatic-costs-by-60-a-visual-testing-optimisation-story/) (2026-04-29) — 4개월 만에 Chromatic 스냅샷 **월 133,000 → 365,000건**("개발자 수 × 느린 CI × 리베이스 = 지수적 증가"), 수동 트리거로 전환해 60% 절감. Chromatic 과금: 35,000건 $179/월, 초과 건당 $0.008.

**권고**: 시각 회귀를 넣는다면 **Playwright 내장 `toHaveScreenshot` + 고정 Docker 이미지.** 우리는 이미 Playwright 캡처 레인이 있으므로 새 벤더도, 건당 과금도, 새 라이선스도 없다.

### A-4. 문서 층 — Storybook은 **유예**가 답이다

**사실**: Storybook MIT, 현행 **10.5.7 (2026-08-06)**, 90.8k★, **열린 이슈 1,780개**. [SB9](https://storybook.js.org/blog/storybook-9/)가 "48% Leaner", [SB10](https://storybook.js.org/blog/storybook-10/)이 CommonJS 제거로 설치 크기 29% 추가 감소를 주장한다. **8→10 직행 경로가 없다**(8→9→10). 8→9는 `addon-essentials`와 애드온 ~7개를 제거하고 import 경로를 `storybook/*`로 재작성한다. 구체 회귀: [#30870](https://github.com/storybookjs/storybook/issues/30870) — 정적 빌드가 1분 30초 → **17분 48초**로 CI 타임아웃.

**제거·거부한 팀들의 1차 진술** (전부 HN·블로그 실명 계정):
- Shoelace 저자 `claviska`: *"슬프고 무거워졌고 프로젝트가 방향을 잃은 것 같다… 몇 년 전에 떠났고 그립지 않다."* → Docsify로 대체.
- `reidjs` — **소규모 팀 실패 양식 그 자체**: *"몇 달 뒤 롤아웃을 맡은 사람들이 흥미를 잃었다. 그래도 계속 쓴다, 이미 쏟아부은 시간 때문에 경영진이 싫어해서. Storybook은 유지·교육이 악몽이다."*
- `koboll`: *"그냥 자체 컴포넌트 쇼케이스를 만들어라. 하루면 된다."*
- `JusticeJuice` — 격리 주장을 정면으로 반박: *"Storybook은 프로젝트의 webpack이 아니라 자기 webpack을 돌린다. 그래서 내 컴포넌트가 prod와 Storybook에서 다르게 렌더됐다."*
- Atomic Object, Zachary Johnson(3년 경력 내부 옹호자였던 사람)의 [재고](https://spin.atomicobject.com/using-storybook-reconsider/): *"디자이너와 고객이 스토리를 정기적으로 보지도 않는다면 유지비 대비 가치가 거의 없다."* 그의 대체안: **"임시 라우트를 만들고 컴포넌트를 떨어뜨린다."**
- **반대 신호도 정직하게**: `crubier` — *"전임 개발자 3인 이상인 진지한 React 앱에는 필수, ROI 10배."* 옹호자들은 **일관되게 전담 디자인 시스템 소유자가 있는 큰 팀**을 전제한다. 우리는 아니다.

**RN용 Storybook**: [storybookjs/react-native](https://github.com/storybookjs/react-native) MIT, v10.5.4 (2026-07-27)로 코어와 보조를 맞춰 살아 있다. 그러나 **다른 물건이다** — 스토리가 **앱 번들 안에서 기기/시뮬레이터에 렌더**되고, 별도 `.rnstorybook/` 트리 + 생성 파일 + 번들러 진입점 스왑이 필요하며 웹 애드온 ~500개가 안 통한다. `@storybook/react-native-web-vite`는 있지만 **Storybook 공식 문서가 "react-native-web을 쓰므로 한계가 있다"고 자인**한다 — 그리고 **우리는 RNW를 안 쓰므로 존재하지 않는 렌더 경로를 검증하게 된다.**

**대안**: [react-cosmos](https://github.com/react-cosmos/react-cosmos) (MIT, v7.3.0, 열린 이슈 **5개** — 지표가 가장 건강) · [Ladle](https://github.com/tajo/ladle) (MIT `@ladle/react` v5.1.1, 2025-11 이후 둔화) · Histoire(수년째 beta).
> **라이선스 함정**: 스코프 없는 npm 패키지 **`ladle`은 2015년 스쿼터이고 LGPL-3.0**이다. 진짜는 `@ladle/react`(MIT). permissive-only 정책에서 `npm i ladle`은 카피레프트를 끌어온다.

**우리 판정**: 비평가들이 독립적으로 수렴한 대체물("임시 라우트 + 실제 컴포넌트 + 캡처")을 **우리는 이미 갖고 있다** — `clients/mobile/measure/states.tsx`(실제 `Timeline`에 상태별 props를 먹여 사진), `clients/web/scripts/capture-screens.mjs`(두 스킴 + 폰 프로파일 + 단정). **유예.** 재검토 트리거는 셋뿐: 전담 디자인 시스템 소유자 · 공유 표면이 필요한 외부 디자이너 · 시각 회귀가 명시적 우선순위가 될 때.

### A-5. gluestack-ui 라이선스 적신호 (permissive-only 정책상 기록)

GitHub 라이선스 탐지가 **404**를 낸다 — 루트에 LICENSE 파일이 없고 루트 `package.json`에 `license` 필드가 없다. 트리 전체에서 라이선스 텍스트는 `packages/gluestack-ui/LICENSE` 하나뿐이고 `Copyright (c) 2023 mayank-96`(회사가 아니라 개인 핸들)이다. npm 패키지는 MIT를 선언한다. 차단 사유는 아니지만, 라이선스 정책이 있는 팀에는 **수동 법무 확인이 필요한 거버넌스 적신호**이고, 블로그들이 퍼뜨리는 "MIT, © 2026 GeekyAnts"와 배치된다. — 어차피 §A-2 결론상 도입 대상이 아니다.

### A-6. 확인하지 못한 것 (정직 기록)

- **"범용 컴포넌트 층을 도입했다가 되돌렸다"는 실명 회사의 공개 포스트모템은 못 찾았다.** 증거는 HN 실무자 진술 + Tamagui→Tailwind 이주 기록으로, 실재하되 Airbnb 급 규모는 아니다.
- **"시각 회귀 테스트를 통째로 걷어냈다"는 1차 기록도 못 찾았다.** 증거는 범위 축소·도구 교체를 지지하지, 폐지를 지지하지 않는다.
- **hex 리터럴 금지 `no-restricted-syntax` 셀렉터의 공개 선례**를 못 찾았다(우리 `eslint.config.js`가 쓰는 그 패턴). 문법상 도출 가능하지만 인용할 수 있는 팀이 없다 — **우리가 선례일 수 있다.**
- **necolas → Software Mansion/Expo 유지보수 이관이 실제로 일어났는지** 미확인. RNW가 향후 결정에 걸리면 이것부터 재확인할 것.
- Percy 초과 과금 정확 요율은 검색 스니펫 기반이라 미확정.

---

## C. 결정 지점 — 옵션과 "지금 아픈 것 중 무엇을 고치나"

> ADR 기안이 아니다. 각 항목은 **성재/오케스트레이터가 골라야 하는 것**이고, 내 권고는 붙이되 결정은 하지 않았다. 각 결정에 §B의 어느 구멍을 닫는지를 명시했다.

### C-0. 먼저 정할 것 — 이 시스템의 이름과 범위

지금 우리 디자인 시스템은 **이름이 없다.** "Dawn(여명) 팔레트"는 색에만 붙은 이름이고, 간격·타입·모션·위계·상태 규칙에는 상위 이름이 없다. mac 시절엔 `MomoDS`라는 이름이 있었으나(`taste/references/tokens.md`) 그 토큰 레이어(`MomoDSTokens.swift`)는 **끝내 랜딩하지 않았다.**

- **옵션 A**: 이름을 세운다 (예: `oort DS`), 정본 문서 한 장(`docs/design-system/README.md`)을 만들고 토큰 파일·taste 스킬·ux-bible·design-review 계약이 전부 그것을 가리키게 한다.
- **옵션 B**: 이름 없이 간다 — `taste-web` SKILL을 사실상 정본으로 승격하고 폰 방언을 추가한다.
- **아픈 곳**: §B-4 ⑥(ux-bible과 코드가 서로 모름) · §B-4 ⑨(폰에 방언 없음) · §B-6(design-review 에이전트가 죽은 클라를 가리킴). **리브랜딩(ADR-0152)과 시점이 겹치므로 이름을 지금 정하면 두 번 안 바꾼다.**

### C-1. 토큰 단일 원본을 만들 것인가

**업계 조사가 준 가장 중요한 정정 셋** (§A-1):
1. Style Dictionary에는 **RN 포맷이 없다.** RN 트랜스폼 그룹은 3개뿐이고 그림자·타이포·보더·트랜지션 트랜스폼이 전무하다. 공식 RN 예제 출력은 평평한 ES6 상수 모듈이다.
2. DTCG 안정 스펙에 **테마(light/dark)가 없다** — Resolver Module은 "구현하지 말라" 상태. 우리 `light-dark()` 한 줄이 하는 일을 표준이 아직 못 한다.
3. **빌드 단계를 도입해도 가드 스크립트는 없어지지 않는다.** GitLab은 Style Dictionary를 돌리고 **그 다음** `git diff --exit-code`를 돌린다.

**그러나 우리 방식에 잡히는 지점이 하나 있고 그건 규모와 무관하다**: 재생성-diff 선례(Go·Kubernetes·GitLab)는 전부 **생성물을 생성기와** 대조한다. 우리 가드는 **손으로 쓴 두 파일을 서로** 대조한다. 되돌아갈 원본이 없다 — `tokens.css`가 원본인 것은 **관례일 뿐**이다.

| 옵션 | 내용 | 고치는 것 | 비용 |
|---|---|---|---|
| **C-1-0 (유지+확장)** | 지금 구조 유지, **대조표를 색 15쌍에서 전 축으로 확장** — 간격·반지름·타입·줄높이·터치타깃, 그리고 "짝 없음"을 사유와 함께 명시적으로 선언하게 강제 | §B-1 핵심사실 2(비색 축 전부 무대조) · §B-1 핵심사실 3(`danger-fill` 부재) | **가장 쌈**. `paletteContrast.test.ts`에 스위트 하나 추가. 새 의존성 0 |
| **C-1-1 (TS 정본 → CSS 생성)** | `packages/momo-core/design/tokens.ts`를 정본으로, 웹 `tokens.css`를 빌드로 생성, 폰은 직접 import | 위 전부 + "원본이 관례일 뿐"인 문제 | 중. **웹 `tokens.css`의 1,314줄 주석(이 레포 최고의 문서)을 생성물로 옮기는 비용이 진짜 비용이다** |
| **C-1-2 (DTCG JSON + Style Dictionary)** | 중립 JSON 정본 → SD로 CSS + RN 생성 | 위 전부 | **높고 이득이 불확실.** RN 포맷 없음 · 테마 표준 없음 · Node 22 요구 · 그림자/타이포/보더 트랜스폼을 우리가 다 써야 함. **Carbon 사례(웹 이주가 RN import 경로를 404로 만듦)가 이 방식도 드리프트를 못 막음을 보여준다** |
| **C-1-3 (NativeWind 등)** | Tailwind config를 공유 토큰 원본으로 | 축 전부 | bare-RN StyleSheet 코드베이스에 대한 대공사. **§A-2 결론(구현 공유 금지)과 정면 충돌.** 권고 안 함 |

> **내 권고: C-1-0을 지금, C-1-1을 조건부로.** 이유 — (a) 우리 표면은 **둘**이지 셋이 아니다(§B-1 핵심사실 4). Style Dictionary가 값을 하는 조건(플랫폼 4개 이상)에 한참 못 미친다. (b) Nate Baldwin(Adobe)의 전제 조건 목록에 우리는 하나도 해당하지 않는다. (c) 그림자·모션·타이포는 **어차피 플랫폼별 수기 탈출구가 필요하다**(Skyscanner가 파이프라인을 제대로 만들고도 안드로이드 그림자가 전부 `undefined`였다). C-1-1은 "비색 축 대조를 확장했더니 손 동기화 비용이 실제로 아프다"가 **측정된 뒤에** 연다.

**결정해야 할 세부 하나**: 반지름 `md`가 웹 10 / 폰 8인 것(§B-1)은 **근거 없는 분기**다. 하나로 맞출지, "플랫폼별로 다름 + 사유"를 정식 개념으로 둘지.

### C-2. 컴포넌트 공유 범위

**§A-2 결론: 바꾸지 마라.** RNW는 제작자가 "Meta 투자 0"이라 썼고 10개월 무커밋, RSD는 2년째 0.0.x, Tamagui는 12일에 10릴리스, Microsoft/Adobe는 별도 구현. Airbnb: "결국 두 플랫폼이 아니라 세 플랫폼을 지원하게 됐다."

| 옵션 | 내용 |
|---|---|
| **C-2-0 (유지)** | 지금처럼 토큰·코어 로직·문장만 공유, 컴포넌트는 각자 구현 |
| **C-2-1 (계약 공유 추가)** | **컴포넌트 계약**(variant 이름·필수 상태 목록·prop 어휘)을 코어에 선언하고, 두 구현이 그 계약을 만족하는지 각자 테스트한다. 구현은 여전히 별개 |

- **아픈 곳(C-2-1이 고치는 것)**: 리뷰 3위 **토큰 드리프트·역할 충돌 15건**(한 토큰=N개 의미, 두 클라가 한 역할을 다르게) · 10위 **클라 간 패리티 분기 18건** · §B-4 ②(폰에 파괴 채움 variant 자체가 없음 — `atoms.tsx`에는 `PrimaryButton` 하나뿐이고 나머지는 화면마다 손으로 만든다)
- **비용**: 낮다. 새 의존성 0. 코어에 타입/상수 선언 한 파일 + 양쪽 테스트.
- **결정 지점**: 계약을 **타입으로** 둘 것인가(컴파일러가 진다), **테스트로** 둘 것인가(스위트가 진다), 아니면 **문서로**만 둘 것인가.

### C-3. 강제 기제 — 신설/통합 후보 (아픈 순)

| # | 후보 | 무엇을 고치나 (§B / 리뷰 순위) | 비용 | 선례 |
|---|---|---|---|---|
| **a** | **간격 가드가 사본이 아니라 `tokens.css`를 읽게 한다** — 이미 웹 `spacing.test.ts`는 고쳐졌다. **폰에 대응물이 없다**(현재 2파일만 검사) | 리뷰 5위 간격 위반 11건 · U4-4 W-2 거짓 초록의 재발 방지 | 낮음 | `spacing.test.ts:39-66`가 이미 그 패턴. 폰은 `no-magic-numbers` + `detectObjects: true`가 정답 후보(§A-3-3) |
| **b** | **렌더된 컨트롤 경계 대비 스윕** — `button/[role=button]/input/select/textarea`를 전수 열거해 계산 스타일의 경계·채움 대비를 재고 3:1 아니면 실패 | **§B-4 ①(웹 `secondary` 1.32:1) · §B-4 ②(폰 거부 채움 1.64:1)** · 리뷰 19위 1.4.11 7건 · 리뷰가 픽셀 샘플링으로 찾던 일 | 중 | **기법이 이미 레포에 있다** — `gate-shell-layout.mjs:766-792`가 계산 스타일 파싱+휘도 계산을 한다. 허용목록이 아니라 **스윕**인 것이 핵심(§B-2 `MOBILE_TAP_TARGETS` 12개 교훈) |
| **c** | **터치 타깃 스윕** — 같은 원리로 모든 인터랙티브 요소의 히트 박스를 잰다 | **웹 터치의 18px**(u45 M-1) · 리뷰 16위 4건 · §B-4 ③(28px가 관례에 맡겨짐) | 중 | 동일 |
| **d** | **`@axe-core/playwright`로 렌더 텍스트 대비(1.4.3)** | 리뷰 19위= AA 6건 — **`tokens.contrast.test.ts` 27건 전부 초록인 채로 폰 본문이 3.59~4.02:1이었다** · §B-2 "표면 6개 밖 무측정" | 중 | 업계 최다 이슈 유형(30.08%). ⚠️ **MPL-2.0** — permissive-only 정책에 명시 필요. **1.4.11은 커버 안 되므로 우리 시험 유지 필수** |
| **e** | **폰 프리플라이트를 실행 단위로 승격** — 지금 `conversationHygiene.test.tsx` 안에 이름 없이 사는 전수 검사(hex 0·em-dash 0)를 `npm run preflight:phone`으로 꺼낸다 | §B-2(발견 불가능성) · §B-5 ③ | 낮음 | 웹 `design_preflight_web.sh`가 형태를 제공 |
| **f** | **`clients/web` ESLint를 게이트에 넣는다** — 현재 `web` 프로파일은 **`clients/web-legacy`만** lint한다 | §B-5 ② | 아주 낮음 | 한 줄 |
| **g** | **포커스 링 페이드 수리 + 재발 방지 그렙** — `transition-colors` + `focus-visible:outline-*` 동시 출현 금지를 프리플라이트 11번째 분류로 | **§B-4 ⑤ (21파일 25곳, 리뷰가 못 잡은 것)** | 아주 낮음 | 기존 `naked_focus` 분류와 같은 형태 |
| **h** | **한국어 텍스트 검사** — 조사 고아·`break-all`·의존형태소 절단 | **리뷰 7위 9건 / 8리포트 — 검사가 아예 없고 100% 사람 발견.** `fontStyle: italic`이 한글에서 **0픽셀**이라는 발견은 이 축에서만 나온다 | 높음(연구 필요) | 선례 없음. **우리가 선례가 될 자리** |
| **i** | **위계 규칙 성문화** → C-4로 분리 | | | |
| **j** | 시각 회귀(골든 이미지) | 리뷰 4위 레이아웃 13건의 일부 | 중~높 | **넣는다면 Playwright 내장 `toHaveScreenshot` + 고정 Docker.** 새 벤더·과금·라이선스 0. Chromatic은 4개월에 스냅샷 2.7배 증가 사례(§A-3-4) |

> **넣지 말 것으로 판단한 것**: Storybook(§A-4 — 우리는 비평가들이 수렴한 대체물을 이미 갖고 있다) · 범용 컴포넌트 층(§A-2) · Style Dictionary(§C-1) · `eslint-plugin-design-tokens`(존재하지 않음) · stylelint(우리 코드베이스에 구조적으로 눈이 멀었다).

### C-4. 위계 규칙(파괴 > 주 > 보조)을 어떤 형태로 성문화할 것인가

이건 별도 결정이다. 업계에 **자동화가 존재하지 않고**(§A-3-2 — 있는 건 학술 프로토타입뿐), 우리는 이미 **토큰으로 위계를 재는** 방식을 웹에 갖고 있다(채도 순서 `danger > warn > muted`, 채움 순서 `accent > danger-fill`). **그 방식 자체가 업계 선례를 못 찾은 우리 고유 자산이다.**

문제는 그 자가 **어디까지 다스리느냐**다. dark1155 M1이 보여준 것: **비파괴 컨트롤 하나의 경계를 3:1로 올린 수리가 그 옆의 파괴 형제를 화면에서 가장 흐린 선으로 만들었다.** 각 값은 개별적으로 옳았고 팔레트 산술 가드는 전부 초록이었다.

| 옵션 | 내용 |
|---|---|
| **C-4-1 (토큰 확장)** | 폰에 `dangerFill`/`onDangerFill`을 신설하고, 웹의 채움 순서 단정을 폰에 이식 |
| **C-4-2 (관계 단정)** | 위계를 **값이 아니라 관계**로 선언한다 — "한 푸터/한 행에 함께 서는 컨트롤 집합"을 이름으로 정의하고, 그 집합 안에서 순서(파괴 채움 ≥ 취소 경계 등)를 단정 |
| **C-4-3 (렌더 판정)** | C-3-b 스윕에 위계 축을 얹는다 — 한 부모 안 형제 컨트롤들의 시각 무게를 재고 파괴 액션이 최하위면 실패 |
| **C-4-4 (사람에게 맡김)** | 성문화하지 않고 design-review 에이전트 루브릭에만 둔다 |

- **아픈 곳**: 리뷰 5위 **위계 역전 11건 / 6리포트, 100% 사람 발견 100% 기계 맹점** · §B-4 ② · dark1155 M1
- **권고**: C-4-1은 무조건(토큰 부재가 원인이므로). C-4-2를 그 위에 — **값 단위 단정만으로는 이 계열의 결함을 못 잡는다는 것이 dark1155 M1의 증명이다.** C-4-3은 C-3-b가 서고 난 뒤 검토.

### C-5. macOS 폐기와의 관계

- `2026-08-09-swift-removal-audit.md` 판정: **통째 삭제 불가, 부분 삭제만.** 삭제 조건(보류 11패밀리 판정)이 미충족이고 그건 성재의 자리다.
- 그런데 **디자인 층은 코드 삭제와 분리해서 지금 정리할 수 있다**:

| 옵션 | 내용 |
|---|---|
| **C-5-1** | `verify_design_preflight.sh`(mac 래칫)를 `swift` 프로파일에서 **뺀다.** `clients/macOS`는 이미 "검수 표면 아님"이고, 그 게이트가 지키는 유일한 것은 v0 데모의 위반 개수 상한이다 |
| **C-5-2** | `.claude/agents/design-review.md`의 `description`과 `AGENTS.md:145`를 **웹·폰으로 재조준**한다. 지금 계약은 macOS/Core만 요구하는데 실제 리뷰 16건은 대부분 웹·폰이다 |
| **C-5-3** | `momo-design-taste`(mac) 스킬을 **동결 표시**하고, 그 `references/tokens.md`의 살아 있는 부분(간격 `{4,8,12,16,24,32}`·반지름 `6/10/14`·밀도 축·표면별 필수 상태표)을 새 정본으로 **승계**한다 — 웹이 쓰는 스케일이 정확히 그 명세에서 왔다 |
| **C-5-4** | 아무것도 안 한다 (Swift 삭제가 끝날 때까지) |

- **아픈 곳**: §B-6. 그리고 `Theme.swift:15`의 `agentAccent = Color(red:0.45, green:0.36, blue:0.92)`(네온 보라)는 **우리 팔레트가 명시적으로 금지한 색**이 레포에 살아 있는 것이다.
- **권고**: C-5-2와 C-5-3은 지금. C-5-1은 성재 판단(비용이 작아 남겨 둬도 무방).

### C-6. 부수 결정

- **모션 토큰 신설 여부** (§B-4 ⑧): 2026-07-28 갭 감사가 `instant=0/fast=120/standard=180/slow=240`을 이미 권고했고 채택되지 않았다. 웹에 손으로 적힌 값 5개, 폰은 거의 백지 — **선점 비용이 지금 가장 싸다.**
- **이름 축(`--spacing-*` 15개)의 거버넌스** (§B-4 ⑦): 상한을 둘 것인가, 분류(폭/높이/컨트롤/측정값)를 강제할 것인가, 아니면 지금처럼 주석 근거만으로 자유롭게 둘 것인가. `preview-frame`이 `action`(폭)을 높이로 빌려 쓴 사고가 이미 한 번 있었다.
- **`light-dark()` 브라우저 하한선 확인** (§A-1-8): 우리 팔레트 전체가 `light-dark()` 위에 서 있는데, Tauri macOS 빌드의 실제 하한선은 **사용자 OS 버전의 WKWebView**다. **미확인 — 검증 필요.**
- **트랙 경계**: 이 작업은 UXUI(`clients/web`·`clients/mobile` 토큰/컴포넌트)와 엔진(`scripts/**`·`clients/web/gates/**`·`packages/momo-core`) **양쪽을 건넌다**(`docs/TRACKS.md` §1). 배치 설계 시 트랙 분할이 필요하다.

---

## 성재 한 줄 요약

**무엇이 좋아지나** — 우리는 이미 업계 상위권 디자인 시스템을 갖고 있습니다(색 정본이 실제로 한 방향으로 흐르고, 격자 밖 값은 컴파일조차 안 되고, 위계를 채도로 재는 방식은 업계 선례를 못 찾았습니다). 문제는 **명세 부족이 아니라 강제 부족**입니다 — 리뷰 170건 중 최다 패턴(25건)이 "옳은 답이 바로 옆 줄에 이미 적혀 있었는데 안 쓴 것"이었습니다. 그래서 제안은 **새 도구 도입이 아니라, 이미 쓰여 있는 규칙을 기계가 읽게 만드는 것**입니다: ①렌더된 컨트롤의 경계 대비·터치 크기를 **허용목록이 아니라 전수로** 재고 ②폰에 없는 「파괴 액션 채움」 토큰을 만들어 승인 버튼이 거부 버튼보다 5배 눈에 띄는 상태를 닫고 ③웹 전체 25곳의 포커스 링이 잉크색에서 호박색으로 번지는 버그를 프리미티브 3개 고쳐서 한 번에 잡습니다.

**비용은** — 유료 도구·새 벤더·Storybook·Style Dictionary **전부 안 씁니다.** 조사 결과 Style Dictionary에는 React Native 출력이 아예 없고, 표준(DTCG)에는 다크모드가 아직 없으며, 비텍스트 대비(3:1)는 **어떤 회사도 팔지 않습니다**(Deque 자사 데이터: 자동 커버리지 0.00%) — 우리 손수 만든 시험이 시장에 없는 것을 덮고 있습니다. 새로 드는 건 게이트 스크립트 몇 개와 토큰 두어 개뿐이고, 유일한 새 의존성 후보는 렌더 텍스트 대비용 `@axe-core/playwright`(MPL-2.0, dev 전용)입니다. **다만 결정 하나는 성재 몫입니다**: 이 시스템에 이름을 붙일지 여부 — oort 리브랜딩과 시점이 겹쳐서, 지금 정하면 두 번 안 바꿉니다.
