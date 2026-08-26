### Design Review — 웹 (feat/1754-d1-lucide-icons @ a019e1f4, base origin/track/uxui @ 0e202e5e)

PR #1762 · 티켓 #1754 (UX-D1) · ADR-0172
리뷰어: design-review (fresh context) · 2026-08-25
정본: `docs/design-system/README.md` (오르트 구름) · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `.claude/skills/momo-design-taste/references/review-rubric.md`

Screenshots (HEAD, capture:design 2회차):
- `claudedocs/design-review-1762/evidence/head-chat-light.png`
- `claudedocs/design-review-1762/evidence/head-agent-hub-dark.png`
- `claudedocs/design-review-1762/evidence/head-timeline-dense-light.png`
- `claudedocs/design-review-1762/evidence/head-settings-plugins-dark.png`
- 원본 252장: `clients/web/artifacts/design/*.png` (HEAD) · `/tmp/d1-base/clients/web/artifacts/design/*.png` (BASE) · `/tmp/d1-head-run1/*.png` (HEAD 1회차 = 대조군)
- 차분 확대: `evidence/noise-*.png`

---

## 0. 범위와 이 리뷰가 실제로 한 일

이 PR은 **픽셀 무변화**를 주장한다. 그래서 리뷰를 "새 화면이 예쁜가"가 아니라 **주장 세 개의 검증**으로 재조준했다.

| 축 | 방법 | 결과 |
|---|---|---|
| ① 픽셀 무변화 | BASE·HEAD 양쪽에서 `npm run build` + `capture:design` 전량(각 252장) + **HEAD 두 번 캡처한 대조군** | **참** (아래 §1) |
| ② 가드의 실효성 | 가드 스캔 로직을 합성 트리(`/tmp/d1-guardprobe`)에 그대로 돌려 손제작 아이콘 5종 심기 | **부분적** — 목록은 자물쇠, 스캔 표면은 구멍 (§2, M-1) |
| ③ 문서 정합 | §2.8 문장 전부를 `clients/web/src` 실측과 ADR-0172·§5 지도에 대조 | **어긋남 2건** (§3, H-1·H-2) |

---

## 1. 픽셀 무변화 주장 — 검증됨 (그리고 검증 비용이 이 PR의 진짜 발견이다)

**런타임 코드 diff는 0이 아니다.** `src` 변경이 실재한다: `OortMark.tsx`(주석 2줄 + EOF 빈 줄 1개 삭제), `public/favicon.svg`·`public/oort-mark.svg`(기존 `<!-- -->` 블록 안에 존치 사유 2줄). 그래서 "diff가 0이니 픽셀도 0"이라고 넘기지 않고 산출물과 프레임을 실측했다.

**프로덕션 빌드 산출물 — JS·CSS 전 자산이 sha256까지 동일하다.**

```
자산                         BASE sha256(12)   HEAD sha256(12)   raw        gzip -9
core-*.js                    8261a5e51510      8261a5e51510        2,441        997
emojiCatalog-*.js            5ed149a4cb84      5ed149a4cb84      176,393     48,602
event-*.js                   d7198f5948fd      d7198f5948fd        1,436        706
huddleRuntime-*.js           9c41b2d92fe1      9c41b2d92fe1      531,186    137,881
index-*.css                  85e5f7002065      85e5f7002065       42,873      9,364
index-*.js                   7c5f9e74eb3e      7c5f9e74eb3e    1,568,110    452,754
terminalRuntime-*.css        273f23033f34      273f23033f34        5,244      1,934
terminalRuntime-*.js         fe44524d6ef4      fe44524d6ef4      334,226     83,949

dist 전체 재귀 diff에서 다른 파일: favicon.svg · oort-mark.svg (둘 다 XML 주석 추가분뿐)
```

파일명 해시까지 같다 = 번들 입력 바이트가 같다. 주석은 esbuild가 걷는다. **STATUS.md가 적은 "gzip 455.88 kB 전/후 동일"보다 이 표가 더 강하고 재검증 가능한 참말이다**(N-4).

**프레임 대조 — 대조군이 필요했다.** BASE vs HEAD는 252장 중 137장이 바이트가 달랐다. 그 자체로는 아무 뜻이 없다:

| 비교 | 다른 프레임 |
|---|---|
| **HEAD 1회차 vs HEAD 2회차 (같은 커밋, 대조군)** | **138 / 252** |
| BASE vs HEAD 2회차 | 139 / 252 |
| BASE vs HEAD 1회차 | 137 / 252 |

즉 이 레인은 같은 코드로 두 번 찍어도 절반 이상이 달라진다. 원인은 프레임에 그대로 보인다 — 벽시계 시각과 스크롤 위치(`evidence/noise-scroll-and-clock-markdown-dark.png`: 13:36~13:40 vs 13:30~13:35, 타임라인 스크롤 위치도 다름), 그리고 좌측 레일의 hover/선택 잔상(`evidence/noise-hover-residue-agenthub.png`).

대조군에서 재현되지 **않은** 프레임은 5장뿐이고, 그 다섯의 채널당 최대 차이는 **1~2/255**다:

```
approvals-confirm-light.png        max Δ [2,1,1]   520px
directory-dark.png                 max Δ [1,1,1]    83px   (evidence/noise-aa-directory-dark.png)
hosted-disconnect-empty-light.png  행 상태 틴트     (evidence/noise-rowstate-hosted-doorbell.png 계열)
hosted-doorbell-error-light.png    max Δ [1,2,2]
hosted-pairing-identity-dark.png   행 상태 틴트
```

합성 반올림 잡음이지 렌더 변화가 아니다. **판정: 픽셀 무변화 주장은 참이다.**

**다만 dist 바이트는 변한다** — `favicon.svg` 1,251→1,425 B, `oort-mark.svg` 1,279→1,461 B. 존치 사유가 소스 주석이 아니라 **출하 바이트**로 브라우저에 나간다. XML 유효성은 확인했다(파서 통과, 주석 내 이중 하이픈 0). 렌더 영향 0이지만 알고는 있어야 한다(N-3).

---

## 2. 가드의 실효성 — 목록은 자물쇠, 스캔 표면은 구멍

**§5.5② 함정은 피했다.** 예외 3파일은 `toEqual` **정확 일치**다. 측정 대상은 `src/**/*.tsx` 전수와 `public/**/*.svg` 전수이고, 목록은 그 전수가 오늘 세어 낸 수다 — 허용목록이 아니라 잔량형 자물쇠다. 새 파일이 목록 밖이면 빨갛고, 예외를 지우는 수리도 표를 고쳐야 초록이다(`chipVessel.test.ts` 선례와 같은 성질). 대조군으로 확인했다: 평범한 `.tsx`에 `<svg>`를 심으면 **빨갛다**.

import 형태 단정(dynamic 0 · namespace 0)도 전수 + 0이라 정본 규율에 맞고, lock 라이선스 단정은 `locked`가 없으면 `undefined !== "ISC"`로 **fail-closed**한다.

**그런데 재는 표면이 §2.8이 선언한 규칙보다 좁다.** 가드 스캔 로직을 그대로 합성 트리에 돌려 손제작 아이콘 다섯을 심었다:

```
LOCAL_SVG_COMPONENTS = ["src/design/brand/OortMark.tsx"]        ← GREEN (통과)
STATIC_SVG_ASSETS    = ["public/favicon.svg","public/oort-mark.svg"]  ← GREEN (통과)

심어 두고도 보이지 않은 것:
  - src/design/ui/handIcon.ts        (.ts 안의 손 SVG — LOCAL은 .tsx만 훑는다)
  - src/assets/spark.svg             (src/ 아래 SVG 자산 — STATIC은 public/만 훑는다)
  - src/design/ui/Createl.tsx        (createElement("svg", …) — `<svg` 리터럴이 없다)
  - src/design/ui/CssShape.tsx       (CSS 도형 캐럿 + 기능 이모지)
```

§2.8은 "로컬 `<svg>`·**CSS 도형·아이콘 폰트·기능 이모지**를 새로 만들지 않는다"라고 적고, 절 말미에 "새 raw SVG 또는 정적 SVG는 목록 밖이면 실패하고"라고 적는다. **문장이 가드보다 넓다.** 경쟁 아이콘 패키지(heroicons·tabler 등) 유입도 재지 않는다(오늘 web deps에 0건인 것은 확인).

가장 아픈 지점은 답이 **같은 디렉터리 형제 파일에** 있었다는 것이다. `designSystem.test.ts:47`이 워커를 하나 더 두면서 그 이유를 이름 대어 적어 뒀다:

> `/** `.ts` 까지 — 프리플라이트가 `.tsx` 만 훑는 자리를 이 파일이 받는다. */`

`iconSystem.test.ts`의 raw SVG 스윕은 `.tsx`만 훑는다. 감사 코퍼스 **1위 메타 패턴**("옳은 답이 바로 옆 줄·같은 파일·형제 컴포넌트에 이미 있었는데 안 썼다", 25건/11리포트)이다.

---

## 3. 문서 정합 — §2.8이 §5 지도에 등록되지 않았고, 문장 둘이 실측과 어긋난다

ADR-0172와의 정합은 좋다. ADR의 "정정본"(165곳·0.454.0·손제작 SVG 0건)을 §2.8이 **숫자로 베끼지 않고** 규칙과 예외 표로만 적은 것은 옳은 선택이다(숫자는 STATUS.md와 테스트가 진다). 실측도 맞다:

```
lucide-react 임포트 파일 58 · 글리프 76 · JSX 배치 165 · 버전 0.454.0 · lock license ISC
clients/web 전체 .svg 파일 = public/favicon.svg, public/oort-mark.svg (2개)
.tsx 안 raw <svg> = OortMark.tsx (1개)
strokeWidth 재지정 = OortMark(브랜드 마크) 1곳뿐, lucide 아이콘 0곳
컴포넌트 안 stroke/fill 색 하드코딩 = 0
```

루트 `DESIGN.md`(비권위 mirror)는 이미 "기능 아이콘은 한 스타일의 lucide를 쓰고 emoji를 기능 아이콘으로 쓰지 않는다"를 들고 있었고 정본에는 그 규칙이 없었다. 이 PR은 그 drift를 **정본 쪽으로** 닫는다 — `docs/design-system/OMD.md`의 방향("서로 어긋나면 mirror를 정본에 맞춰 고치며, 정본을 mirror에 맞춰 조용히 바꾸지 않는다")과 맞다.

어긋나는 것은 아래 [High] 둘이다.

---

## 판정

```
[Blocker]  없음

[High]     H-1  새 축을 정본화하면서 §5 강제 기제 지도에 아이콘 행을 넣지 않았다
[High]     H-2  §2.8의 규칙 문장 둘이 오늘의 트리에 대해 거짓이고, 잔량도 기계도 없다

[Medium]   M-1  가드의 스캔 표면이 §2.8이 선언한 규칙보다 좁다 (실증 4종 통과)
[Medium]   M-2  `codeOnly`·디렉터리 워커가 형제 테스트의 바이트 사본이다 (§5.5①)
[Medium]   M-3  capture 레인이 프레임 단위로 비결정적이다 — 같은 커밋 252장 중 138장이 다르다
                (이 PR 귀책 아님. 이 PR의 중심 주장을 검증하는 비용이 그 때문에 3배가 됐다)

[Nitpick]  N-1  §2.8이 ADR-0172를 링크 없이 평문으로 부른다
[Nitpick]  N-2  lock 버전 단정이 routine `npm update`에서 디자인 가드를 빨갛게 만든다
[Nitpick]  N-3  존치 사유가 dist SVG 출하 바이트로 나간다 (favicon +174 B)
[Nitpick]  N-4  STATUS.md의 gzip 숫자보다 "전 자산 sha256 동일"이 더 강하고 재검증 가능하다

Verdict: PASS (blockers: 0)
```

**단, ADR-0133 웹 패리티 목표(Blocker 0 · High 0)에는 미달이다.** High 둘은 전부 이 PR이 이미 건드린 파일(`docs/design-system/README.md`) 안의 문서 편집이라 in-PR 수리가 싸다. 루브릭 기준으로는 사람 리뷰로 넘어갈 수 있으나, 이 PR의 상품이 **정본 문서 그 자체**이므로 두 High를 닫고 나가기를 권한다.

---

## 상세

### [High] H-1 — 새 축을 정본화하면서 §5 강제 기제 지도를 갱신하지 않았다

**무엇이 깨졌나.** §2.8이 새 축(아이콘)을 열었는데 §5.1(층 다섯)·§5.2(축 × 기제)·§5.3(무검사)·§0(30초 경로) 어디에도 아이콘 행이 없다. 리뷰어가 정본이 정해 준 길("이거 기계가 잡나?" → §5)로 걸어가면 아이콘에 대해 **아무것도 못 찾는다**.

**왜 중요한가.** 이 문서의 §5 머리말이 스스로 적는다 — "「기계가 잡았어야 했는데 안 잡았다」가 감사의 두 번째 메타 패턴(17건/10리포트)이었고, 그 대부분은 **무엇이 안 재지는지를 아무도 몰랐기** 때문이다." §3.3 머리말은 그 반대 방향도 이름 대어 적는다 — "닫힌 자리를 열려 있다고 말하는 표는 이 문서가 막으려는 바로 그 결함이다." 여기서 일어난 것은 그 거울상이다: **열린 자리가 지도에 없어서 닫힌 것처럼 읽힌다.**

§2.8 말미의 한 문장("기계 정본은 `iconSystem.test.ts`다")은 그 자리를 대신하지 못한다. 그 문장은 무엇이 **재지는지**만 말하고 무엇이 **안 재지는지**는 말하지 않는데, 이 문서가 존재하는 이유는 정확히 후자다(문서 §"이 문서가 존재하는 이유": "각 규칙 옆에 「이걸 무엇이 재는가」와 「무엇이 안 재는가」를 적는 것").

**방향(픽셀 처방 아님).** §5.2에 아이콘 행 하나 — 웹 칸에 `iconSystem.test.ts`가 실제로 재는 둘(예외 목록 전수 · import 형태), 폰 칸에 ❌(ADR-0172가 명시적으로 범위 밖). §5.3에 이 PR이 규칙으로 적었지만 아무도 재지 않는 것들 — 16/20px 크기, `strokeWidth` 재지정, `currentColor` 상속, `aria-hidden`, CSS 도형/아이콘 폰트/기능 이모지, `src/**` 아래 SVG 자산. §0 표에는 "아이콘을 고른다 → §2.8" 한 줄.

---

### [High] H-2 — §2.8의 규칙 문장 둘이 오늘의 트리에 대해 거짓이고, 잔량도 기계도 없다

정본 서문: *"이 문서에 새로 발명된 규칙은 없다. 모든 항목에 출처가 붙어 있고, 출처가 없으면 그것은 규칙이 아니라 관례다."*

**(a) `size-5`(20px)는 레포에 0건이다.** §2.8: "독립된 상위 액션의 기본은 20px(`size-5`)다." 실측:

```
size-4  110   size-6  15   size-3  11   size-8  3   size-2  3   size-1  1   size-5  0
lucide 배치 165곳 기준:  size-4 102 · (부모 계약 위임) 55 · size-3 7 · size-6 1 · size-5 0
`h-5 w-5` 0건 · `size={20}` 0건
```

즉 20px 아이콘은 이 제품에 **존재하지 않는다**(`evidence/head-chat-light.png`의 헤더 상위 액션 — 허들·핀·터미널 — 도 전부 16px). 사실상 표준을 성문화하는 것이 이 PR의 명분인데(ADR-0172 배경의 "실측 정정"), 그 절이 실측에 없는 기본값을 하나 발명했다.

**(b) `aria-hidden` 문장은 서술문인데 서술이 틀렸다.** §2.8: "옆에 읽는 레이블이 있는 아이콘은 `aria-hidden`이다."

```
lucide 배치 165곳 중 aria-hidden 없음: 57곳
그중 12줄 안에 aria-label/title/sr-only도 없음: 36곳
예: QuickSwitcher.tsx (Search·Inbox·Activity·Users·Settings·Plus·Bot·Lock·Hash·MessageSquare·User 12곳)
    ChatShell.tsx:747·749·751 · CreateChannelDialog.tsx:57·71 · AgentHubRoute.tsx:247
    AdeSummaryLine.tsx:123·125 · WorkConsoleRoute.tsx:70~73 (T1/T2/T3 위치 아이콘 4개)
```

`lucide-react@0.454.0`의 `Icon.js`는 기본 props에 `aria-hidden`을 **넣지 않는다**(확인함: `color/size/strokeWidth/absoluteStrokeWidth/className`뿐). 그래서 이 36곳은 이름 없는 그래픽으로 접근성 트리에 남는다.

**(c) 부수 — "예외는 컴포넌트가 이유를 진다"도 오늘 지켜지지 않는다.** §2.8: "12px/24px처럼 기존의 측정된 기하를 보존해야 하는 예외는 해당 컴포넌트가 이유를 진다." `size-3` 7곳(`WorkConsoleRoute.tsx:69` · `AgentWorkPanel.tsx:492·494` · `ObserverTerminal.tsx:1254` · `MentionRoutingBar.tsx:180·182`) 중 **12px인 이유를 적은 곳은 0곳**이다.

**왜 중요한가.** 정본이 거짓을 말하면 다음 리뷰어는 그것을 근거로 인용한다. 그리고 이 세 문장 어느 것도 기계가 재지 않으므로, 오늘의 이탈은 **세어지지도 않는다** — §5.5②가 이름 대어 적은 실패 양식(허용목록/잔량 혼동)의 사촌이다. 정본은 같은 문제를 §2.7(손으로 적은 슬롭 "다섯이 여섯이 되지 않는 것")과 §2.2(잔량 33 + 7)에서 이미 **세는 방식으로** 풀었다.

**방향.** 세 문장 각각에 대해 셋 중 하나를 고르면 된다 — ①오늘의 이탈 수를 잔량으로 적는다(`aria-hidden` 미부여 36 · 사유 없는 `size-3` 7), ②"이 축은 아무도 재지 않는다"고 §5.3에 등재한다, ③`size-5`처럼 근거가 0건인 문장은 지운다(또는 "20px 자리는 아직 없다"고 사실대로 적는다). 셋 다 이 PR 안에서 문서 편집만으로 닫힌다.

---

### [Medium] M-1 — 가드의 스캔 표면이 규칙보다 좁다

§2절에 실증 포함. 요점만: 예외 **목록**은 자물쇠가 맞다(§5.5② 통과). 구멍은 목록이 아니라 **"로컬 SVG"의 정의**다 — 가드는 그것을 「`src/**/*.tsx` 안의 `<svg` 리터럴 + `public/**/*.svg`」로 좁혀 놓았고, §2.8의 문장은 그보다 넓다.

**방향.** ①워커를 `.tsx?`로 넓힌다(형제 파일 `designSystem.test.ts:47`이 이미 그 이유를 적어 놓았다). ②`src/**` 아래 `.svg` 자산도 전수에 넣는다(오늘 0건 = 지금이 가장 싼 시점이다). ③문장을 가드에 맞춰 좁히거나, CSS 도형·이모지·경쟁 패키지는 §5.3에 "안 잼"으로 등재한다. **문장과 가드 중 하나는 움직여야 한다** — 지금은 둘이 서로 다른 말을 하고, 그럴 때 사람이 믿는 쪽은 문장이다.

---

### [Medium] M-2 — 형제 테스트의 바이트 사본

`iconSystem.test.ts:31-35`의 `codeOnly`는 `designSystem.test.ts:32-36`과 **한 글자도 다르지 않고**, `filesUnder`도 같은 파일의 `tsxFiles`/`sourceFiles`와 같은 물건이다. §5.5①이 값에 대해 적은 규율("사본을 두면 사본이 거짓말한다")은 **판정 로직**에도 그대로 적용된다 — 한쪽이 주석 처리 규칙을 고치면 다른 쪽은 조용히 옛 규칙으로 남는다.

부수로 알아 둘 것: 이 `codeOnly`는 정규식 기반이라 문자열 안의 `/*`·`//`에 취약하다(레포는 같은 이유로 카피 검사를 AST로 옮겼다 — §5.2 `design_preflight_ast.mjs`). 오늘은 `<svg`를 가진 파일이 하나뿐이라 무해하다.

**방향.** 두 테스트가 한 헬퍼를 나눠 쓰게 한다(`src/design/__helpers__` 같은 자리). 새 파일을 만들지 말고 이미 있는 쪽에서 export하는 편이 §5.5①에 맞다.

---

### [Medium] M-3 — capture 레인이 픽셀 회귀의 기준선이 될 수 없다 (이 PR 귀책 아님)

같은 커밋으로 두 번 캡처하면 252장 중 **138장**이 바이트가 다르다(§1 표). 원인 셋이 프레임에 보인다: 벽시계 시각/스크롤 위치(`evidence/noise-scroll-and-clock-markdown-dark.png`), 좌측 레일 hover·행 상태 잔상(`evidence/noise-hover-residue-agenthub.png` · `noise-rowstate-hosted-doorbell.png`), 합성 AA 반올림 1~2/255(`noise-aa-directory-dark.png`).

정본 §5.1은 캡처 레인을 강제 층 다섯 중 하나로 세고, §5.3은 "증거·캡처 공백"을 7위 결함군(9건)으로 적는다. 오늘의 레인은 **사진을 주지만 비교를 주지 못한다**. 그래서 "픽셀 무변화"류 주장은 매번 대조군 실행(같은 커밋 2회)을 요구하고, 그건 이 리뷰에서 실제로 캡처 3회 = 약 3배 비용이었다.

**방향(별도 티켓 감).** 결정적 클록 주입, 캡처 전 포인터 원점 이동(§5.3이 `gate-workstream.mjs:875`에서 이미 쓰는 기법), 스크롤 앵커 고정. 셋 중 앞의 둘만 닫아도 138장이 한 자릿수로 내려갈 것으로 보인다. 이게 닫히면 "픽셀 무변화" 주장이 **주장이 아니라 레인 산출물**이 된다.

---

### [Nitpick] N-1~N-4

- **N-1** §2.8이 ADR-0172를 링크 없이 평문으로 부른다. 문서 관례는 상대경로 링크다(§0 머리말의 ADR-0159, §2.2 등). 참고로 `docs/adr/0172-*.md`는 이 브랜치에 **없다**(정본 라인 `main`에만) — README 머리말이 그 상황을 이미 다루므로 결함은 아니다.
- **N-2** `iconSystem.test.ts:100`이 `dependencies["lucide-react"] === "^" + lockedVersion`을 단정한다. 락만 오르는 routine `npm update`에서 **아이콘 디자인 가드**가 빨개진다 — 디자인이 아닌 이유로 디자인 레인이 우는 것은 신호를 무디게 한다. 방향: 문자열 동일성 대신 "락 버전이 매니페스트 범위를 만족" + "license === ISC".
- **N-3** 존치 사유가 `public/*.svg` 본문 XML 주석이라 dist에 그대로 나간다(favicon 1,251→1,425 B · oort-mark 1,279→1,461 B). XML 유효성 확인함(파서 통과, 주석 내 `--` 0). 렌더 영향 0.
- **N-4** STATUS.md의 "메인 JS gzip 455.88 kB 전/후 동일"은 방향은 맞지만(내 실측 `gzip -9` 452,754 B) 더 강한 참말이 있다: **프로덕션 빌드 전 자산의 sha256이 파일명 해시까지 동일하다.** 숫자는 gzip 레벨에 따라 흔들리고 해시는 안 흔들린다.

---

## 루브릭 페이즈

| # | 페이즈 | 판정 | 근거 |
|---|---|---|---|
| 0 | Prep | ✅ | `npm run build` + `capture:design` 양쪽 브랜치 전량 252장 × 2스킴, HEAD는 2회(대조군) |
| 1 | Interaction | **해당 없음** | 상호작용 코드 diff 0. 산출 JS/CSS sha256이 base와 동일하므로 포인터·키보드 경로가 바뀔 수 있는 바이트가 없다 |
| 2 | Viewport | ✅ 회귀 없음 | 900px 프레임 포함 전량이 §1 기준으로 base와 동치(`b8-narrow-900-*`, `hosted-disconnect-*-900-*`) |
| 3 | Visual polish | ✅ | 아이콘 16px 일관·`currentColor` 상속·획 2 유지 확인(`evidence/head-chat-light.png`, `head-agent-hub-dark.png`). 컴포넌트 내 stroke/fill 하드코딩 0. 단 §2.8이 적은 20px 단은 실재하지 않음(H-2a) |
| 4 | Accessibility | ⚠️ | 이 PR이 만든 회귀는 없다. 그러나 §2.8이 규칙으로 적은 `aria-hidden`이 36곳에서 지켜지지 않는다(H-2b) — 문서가 그것을 사실처럼 적은 것이 이 PR의 몫이다 |
| 5 | Robustness | ✅ 회귀 없음 | 빈·로딩·오류·오프라인 프레임 전량이 base와 동치. 새 상태 표면 없음 |
| 6 | Code health | ⚠️ | 프리플라이트 web 12/12 + core 5/5 · Vitest 1,535/1,535 (아래 원문). 사본 헬퍼(M-2)와 스캔 표면(M-1) |
| 7 | Copy | ✅ | 사용자 노출 문자열 변경 0건. 한글+영문 혼합 레이아웃 영향 없음(문자열이 안 바뀌었다) |

**폰(`clients/mobile`)은 이 PR의 표면이 아니다.** ADR-0172가 명시적으로 범위 밖으로 두었고 diff에도 없다. 패리티 축으로 적을 것 하나: 폰에는 lucide가 없고 아이콘 정본도 없다 — 웹만 정본을 얻었다는 사실이 §5.2 폰 칸에 ❌로 남아야 한다(H-1 방향에 포함).

**폰에는 기계 프리플라이트가 없다.** 이 리뷰에서 폰 프리플라이트를 돌리지 않은 이유는 도구가 실패해서가 아니라 **존재하지 않기 때문**이다(정본 §5.4). 이 PR은 폰을 건드리지 않으므로 해당 없음.

---

## 기계 레인 원문

### `scripts/design_preflight_web.sh` (feat/1754-d1-lucide-icons @ a019e1f4)

```
== design pre-flight (web), SKILL momo-design-taste-web §10 ==
   scanned: clients/web/src, clients/web/index.html
   excluded: src/design/tokens.css, src/design/tokens.contrast.test.ts
   emdash·progress_word·latin_particle: AST (문자열 리터럴·JSX 텍스트만, *.test.ts(x)·*.d.ts 제외) — #1141·#1511

OK    emdash: 0
OK    raw_color: 0
OK    inline_style: 0
OK    arbitrary_tw: 0
OK    ai_gradient: 0
OK    toast: 0
OK    naked_focus: 0
OK    external_font: 0
OK    hype: 0
OK    pure_bw: 0
OK    progress_word: 0
OK    latin_particle: 0

OK    web: 12/12 categories clean.

== design pre-flight (core), 이슈 #1141 ==
   scanned: packages/momo-core/src (문자열 리터럴 노드만, *.test.ts 제외)
   excluded: 주석·독스트링(AST가 보지 않는다), *.test.ts, design-preflight-allow 줄

OK    emdash: 0
OK    progress_word: 0
OK    latin_particle: 0
OK    raw_color: 0
OK    hype: 0

RESULT: PASS, 5/5 categories clean.

RESULT: PASS, web 12/12 + core 5/5 categories clean.
  Still manual (SKILL §10 checklist): light AND dark reviewed, four states
  present, keyboard path exists, long Korean strings do not overflow.
```

### Vitest (clients/web 전체)

```
 Test Files  110 passed (110)
      Tests  1535 passed (1535)
   Duration  3.21s

 ✓ src/design/iconSystem.test.ts (5 tests) 6ms
```

### 가드 실효성 프로브 (`/tmp/d1-guardprobe`, 레포 미변경)

```
대조군 — 평범한 .tsx 에 <svg> 심기
  LOCAL_SVG_COMPONENTS = ["src/design/brand/OortMark.tsx","src/design/ui/NewHandIcon.tsx"]
  verdict: RED (caught)  ← 가드가 의도대로 작동한다

구멍 — 손제작 아이콘 4종을 심고도
  LOCAL_SVG_COMPONENTS = ["src/design/brand/OortMark.tsx"]              GREEN (miss)
  STATIC_SVG_ASSETS    = ["public/favicon.svg","public/oort-mark.svg"]  GREEN (miss)
  보이지 않은 것: src/design/ui/handIcon.ts (.ts)
                  src/assets/spark.svg (src/ 아래 자산)
                  src/design/ui/Createl.tsx (createElement("svg"))
                  src/design/ui/CssShape.tsx (CSS 도형 + 기능 이모지)
```

### 실측 대조 (STATUS.md 주장 ↔ 리뷰 측정)

| STATUS.md | 리뷰 측정 | |
|---|---|---|
| 58개 파일 | 58 | ✅ |
| 76개 글리프 | 76 | ✅ |
| 정적 배치 165곳 | 165 | ✅ |
| `lucide-react@0.454.0` ISC | package.json `^0.454.0` · lock 0.454.0 · license ISC | ✅ |
| 기능 표면 raw `<svg>` 0건 | `.tsx` 안 `<svg>` = OortMark 1개(브랜드) | ✅ |
| Vitest 1,535/1,535 | 1,535 / 110 files | ✅ |
| 프리플라이트 web 12/12 + core 5/5 | 동일 | ✅ |
| 메인 JS gzip 전/후 455.88 kB 동일 | gzip -9 452,754 B 동일 — 그리고 **전 자산 sha256 동일** | ✅ (N-4) |
| 예외 3파일 | 3 (`OortMark.tsx` · `oort-mark.svg` · `favicon.svg`), 각 파일에 마커 존재 | ✅ |

---

## 한 줄

**픽셀은 정말로 안 움직였고 가드는 자물쇠 모양을 제대로 갖췄다. 남은 것은 문서 쪽이다** — 이 PR의 상품이 정본 문서인데, 그 문서가 재지 않는 것을 재는 것처럼 적었고(§5 지도 미등재), 실재하지 않는 20px 기본값과 36곳에서 깨지는 `aria-hidden`을 사실처럼 적었다. 셋 다 `docs/design-system/README.md` 안에서 닫힌다.
