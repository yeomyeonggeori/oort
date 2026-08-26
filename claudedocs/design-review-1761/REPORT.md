### Design Review — clients/web (스레드 표면 · 호버 툴바 경계 · ⌘K 머리) / PR #1761 · 티켓 #1753
**브랜치**: `feat/1753-d2-thread-fix` @ `4e6638f6` (워크트리 `~/projects/momo-tracks/momo-worktrees/d2-thread-fix`, base `origin/track/uxui`)
**정본**: `docs/design-system/README.md` (오르트 구름) · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `.claude/skills/momo-design-taste/references/review-rubric.md`
**Screenshots**: `claudedocs/design-review-1761/` (아래 각 항목에 경로를 적는다)

---

## 0. 표면과 증거

`git diff --name-only origin/track/uxui..HEAD` 로 바뀐 클라 파일은 **전부 `clients/web`** 이다
(`ThreadPanel.tsx` · `MessageActions.tsx` · `hoverToolbarModel.ts` · `QuickSwitcher.tsx` · 테스트 3 · `capture-screens.mjs`).
`clients/mobile` · `packages/momo-core` 는 이 diff에 **없다**. 데스크톱은 웹과 같은 표면이므로(정본 §1 주1) 별도 레인을 돌리지 않았다.

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS · web 12/12 + core 5/5** (원문 `design_preflight_web.txt`) |
| `npm run build && npm run capture:design` | **EXIT=0**, 두 스킴 전량 (원문 `capture-design.log`) |
| `npx tsc --noEmit` | **0** |
| `npm test` (vitest) | **1530/1530 · 109 files** (원문 `web-tests.log`) |
| 폰 기계 프리플라이트 | **존재하지 않는다.** 폰에는 「디자인 프리플라이트」라는 실행 단위가 없고(정본 §5.4), 이 PR에 폰 코드도 없다. 폰은 이 리뷰에서 **패리티 대조 대상으로만 정적 판독**했다 — 빈 칸이 아니라 없는 레인이다. |

프리플라이트 원문:

```
OK    emdash: 0          OK    raw_color: 0       OK    inline_style: 0
OK    arbitrary_tw: 0    OK    ai_gradient: 0     OK    toast: 0
OK    naked_focus: 0     OK    external_font: 0   OK    hype: 0
OK    pure_bw: 0         OK    progress_word: 0   OK    latin_particle: 0
OK    web: 12/12 categories clean.
RESULT: PASS, 5/5 categories clean.   (core)
RESULT: PASS, web 12/12 + core 5/5 categories clean.
```

캡처 레인이 이번 판정에 직접 쓴 자들(원문 `capture-design.log`):

```
호버 툴바 위치 hover light/dark        : 1개, 우측 16px · 상단 -26px
호버 툴바 본문 hover light/dark        : 글자 교차 0(자기+이웃) · 상단 -26px · straddle top
호버 툴바 본문 hover 900 light/dark    : 글자 교차 0(자기+이웃) · 상단 -26px · straddle top
호버 툴바 스크롤러 top light/dark      : seq 1400 inside · straddle below · 툴바 102 / 스크롤러 45
호버 툴바 본문 top light/dark          : 글자 교차 0 · 상단 57px · straddle below
드래그 선택 hover light/dark           : seq 1416 「502가 계속 납니다. GET」 · fv=false
탭 스톱 hover light/dark               : 10행에 행 컨트롤 22개, 탭 스톱 10개 (행당 정확히 1)
스레드 루트 호버 light/dark            : 패널 안쪽 · 글자 교차 0 · straddle below   ← 이 PR이 신설
```

---

## 1. 계약 3항 판정 요약

| # | 계약 | 판정 |
|---|---|---|
| 1 | 스레드 루트 아래 구분선 제거 → 32px 여백 + 점선 빈 상태 상자 | **달성** (빈 상태는 어느 레인도 찍지 않는다 → M-2) |
| 2 | 루트 호버 툴바 수리 + 툴바 뒤집기를 「가장 가까운 스크롤 경계」로 일반화 | **달성 · 채널 회귀 없음**(실측 대조 아래) |
| 3 | ⌘K 입력 보더 제거 → 그릇 focus-within | **소스에서만 달성. 화면은 그대로다** → H-1 |

---

## 2. 회귀 재측정 — 채널 타임라인 (최대 관심사)

UX-HT R3 수치와 **한 자도 다르지 않다**:

| 자 | R3 기대 | 이번 실측 | 출처 |
|---|---|---|---|
| 일반 행 우측 여백 | 16px | **16px** | `capture-design.log` · 픽셀 재검: 툴바 우측 테두리 바깥 모서리 device 2528 = CSS 1264 = 1280−16 (`b11-message-actions-light.png`) |
| 일반 행 상단 | −26px | **−26px** | 동 |
| 일반 행 뒤집기 | top(straddle) | **top** | 동 |
| 스크롤러 최상단 행 | below | **below · 상단 57px** | 동 |
| 본문 교차 | 0 | **0 (자기+이웃)** | 동 |
| 900px | 동일 | **−26px · straddle top · 교차 0** | 동 |
| 드래그 선택 / 탭 스톱 | 무손상 | **무손상**(행당 탭 스톱 1) | 동 |

코드 쪽 근거도 회귀 위험이 낮다. `closestToolbarScrollContainer`는 ①표식(`data-message-scroll-container` · `data-virtuoso-scroller` · `timeline-virtuoso`)을 **조상마다 먼저** 보고 ②그 조상의 계산된 `overflowY`가 잘라내는 값일 때만 경계로 삼으며, `MessageRow`를 렌더하는 자리는 레포 전체에서 `Timeline.tsx`와 `ThreadPanel.tsx` **둘뿐**이다. 툴바와 Virtuoso 스크롤러 사이에 끼는 조상 중 `overflow`를 가진 것은 없다(`MessageRow.tsx`의 유일한 `overflow-hidden`은 아바타이고 툴바의 조상이 아니다). `app-shell`의 `overflow: clip`은 Virtuoso 스크롤러보다 **바깥**이라 최근접 규칙에서 자동으로 진다. jsdom 단위 시험 2건이 「안쪽 표식이 바깥 타임라인을 이긴다」와 「표식이 없으면 계산된 overflow를 찾는다」를 각각 든다.

**스레드 실측**(`u4-thread-composer-parity-light.png`, 픽셀 계측):
루트 행 하단 = CSS 127 · 툴바 = CSS 121~152.5(높이 32) → 툴바 상단이 행 하단보다 **6px 위**, 즉 `--spacing-row`(6) 그대로다. 채널의 below 케이스와 **같은 산술**이고, 다음 답글 행 상단(159)까지 6.5px 남는다. 우측 여백도 채널과 같은 16px.

증거: `crop-thread-root-hover-light.png` · `crop-thread-root-hover-dark.png` · `crop-channel-hover-light.png` · `b11-message-actions-{light,dark}.png`

---

## 3. 루브릭 페이즈

| 페이즈 | 판정 | 근거 |
|---|---|---|
| 0 Prep | 완료 | 빌드+캡처 두 스킴 전량, EXIT=0 |
| 1 Interaction | 통과 | 루트 hover(두 스킴 실측) · 채널 hover/최상단 hover · 드래그 선택 · 행 탭 스톱 1. ⌘K는 열기·입력·필터링이 실캡처로 확인(`quick-switcher-people-*.png`에 「김」 질의의 3섹션 결과). ↓/Enter는 자동 증거가 없으나 **구조적으로 무손상**: cmdk는 `onKeyDown`을 `cmdk-root`에 걸고(`node_modules/cmdk/dist/index.mjs`, `createElement(D.div,{...,"cmdk-root":"",onKeyDown:...})`), 새로 낀 `<div>`는 전파를 막지 않는다 |
| 2 Viewport | 통과(부분 증거) | 1280 실캡처 · 390(모바일 프로파일) 실캡처 · 가로 오버플로 0(스레드 패널 포함). 900은 채널 타임라인만 재촬영됐다 — 이 PR은 `thread-pane` 기하를 건드리지 않는다 |
| 3 Visual polish | H-1 · M-1 · N-2 | 아래 |
| 4 A11y | 통과 | 포커스 링은 그릇이 든다(컴포저와 같은 관례). 다만 그 링이 팔레트에서 **항상 켜져 있다** → H-1. `naked_focus` 맹점은 N-4 |
| 5 Robustness | M-2 | 빈 상태가 어느 레인에도 안 찍힌다. 로딩·오류 분기는 코드상 보존(스켈레톤·인라인 배너) |
| 6 Code health | 통과 | 임의값 0 · 인라인 스타일 0 · 매직 넘버 0(`pt-8`은 리듬 8단계). tsc 0 · 1530/1530 |
| 7 Copy | 통과 | 새 사용자 문구 없음. em-dash 0 · hype 0 · 조사 0 |

---

## 4. 판정

### [Blocker] 없음 (0건)

ADR-0112 D6 상시 Blocker 목록(죽은 컨트롤 · 뷰포트 이탈 · 잘리거나 겹치는 글자) 어디에도 해당이 없다. 오히려 이 PR은 그 목록의 **셋째 항을 하나 지웠다**: 레퍼런스 29에서 툴바가 패널 밖으로 잘려 있던 것이 두 스킴 모두 안쪽·교차 0으로 실측된다.

---

### [High] H-1 — ⌘K 입력의 보더는 **옮겨졌을 뿐 사라지지 않았다.** 화면은 이전과 같은 픽셀이다

**증거**: `quick-switcher-people-light.png` · `quick-switcher-people-dark.png` · `crop-cmdk-light.png` · `crop-cmdk-dark.png` · A/B 하네스 `harness-cmdk-before-focused-light.png`(A=이전, focus) vs `harness-cmdk-after-focused-light.png`(B=이번, focus) · 다크 짝 2장 · 하네스 원본 `harness-cmdk.html`(빌드된 `dist/assets/index-*.css`를 그대로 물린 실컴파일 렌더)

무슨 일이 일어났나:

- cmdk 팔레트는 **열려 있는 동안 입력이 포커스를 놓지 않는다.** Radix Dialog가 열리면서 첫 포커서블(=입력)에 포커스를 주고, `Command.Item`은 포커서블이 아니다(선택은 `aria-activedescendant` 계열이다). 그래서 `focus-within`은 **팔레트의 수명 내내 참**이다.
- `focus-within:focus-ring` = `outline: 2px solid var(--accent); outline-offset: -2px`. 그릇은 폭 100%·머리 밴드 전체이므로, 이전에 입력이 그리던 상자와 **같은 자리에 같은 2px 상자**가 그려진다.
- A/B 하네스가 그것을 나란히 세운다: A(이전, focus)와 B(이번, focus)는 **구분되지 않는다**. 유일한 차이는 `border-b` 헤어라인이 링 안쪽이었다가 바깥으로 1px 옮겨간 것뿐이다.

왜 문제인가 (정본 근거):

1. **계약 미달.** 티켓 3항은 레퍼런스 41(buzz)의 조용한 머리 — 아이콘 + 캐럿 + 아래 헤어라인 하나 — 를 가리킨다. 실제 화면은 팔레트에서 **가장 큰 호박색 상자**를 머리에 계속 달고 있다.
2. **켜졌다 꺼지지 않는 상태 토큰은 상태를 말하지 않는다.** 정본 §2.2의 「상태 토큰과 그릇 토큰은 갈라져 있다」가 반대 방향으로 재현됐다: 상태를 그리는 자(포커스 링)가 **정적인 그릇**의 자리에 앉았다. 항상 켜진 포커스 표시는 정보가 아니라 크롬이다.
3. **위계 역전(§3 / 루브릭 페이즈 3).** 이 표면에서 키보드가 실제로 움직이는 것은 **목록의 선택 행**이다. 그런데 한 표면 하나뿐인 accent를 정적인 입력 그릇이 가장 크게 쓰고 있어서, `--accent-soft` 선택 행이 그 옆에서 눌린다(`quick-switcher-people-light.png`에서 첫 항목의 선택 표시를 찾아보라 — 머리의 호박 상자가 먼저 읽힌다).
4. **소스는 초록인데 화면은 그대로다.** 새 `quickSwitcherSurface.test.ts`는 클래스 **문자열**을 단정한다(입력에 `border` 없음 · 그릇에 `focus-within:focus-ring` 있음). 그 둘은 참이고, 그래서 초록이며, 그 초록은 렌더에 대해 아무 말도 하지 않는다. STATUS.md의 「입력 자체의 보더·포커스링을 없애고 … 그릇이 맡는다」도 소스의 참·화면의 거짓이다. 정본 §2.2(#1516)가 이름 붙인 그 문장이 그대로 적용된다 — **토큰 계약과 화면이 다른 말을 할 때 이기는 쪽은 언제나 화면이다.**

방향(픽셀 지시 아님): 두 갈래 중 하나를 **결정으로** 골라야 한다. ①팔레트의 포커스는 굳이 그릴 것이 아니다(열린 다이얼로그와 캐럿이 이미 「여기 친다」를 말한다 — 레퍼런스가 고른 답) → 그릇에서 링을 걷고 헤어라인만 남긴다. ②그리기로 한다면 accent 2px 상자가 아닌 다른 자로 말해야 한다 — accent는 목록의 선택이 쓰게 두고. 어느 쪽이든 판정 근거는 **렌더 캡처 한 장**이어야 하고, 지금 팔레트에는 그 자를 든 게이트가 없다.

---

### [Medium] M-1 — 그 링이 다이얼로그의 `rounded-lg` 모서리를 네모로 깎고 스크림 위로 새어 나간다

**증거**: `crop-cmdk-corner-light.png` · `crop-cmdk-corner-dark.png` (4배 확대)

그릇은 `rounded-lg`(14px) 카드의 첫 자식이고 카드에는 클리핑이 없다. `outline-offset: -2px`짜리 아웃라인은 **직사각형**이라, 카드 바깥 모서리에서 2px 안쪽 지점(호가 시작되기 한참 전)에 각진 모서리를 찍는다. 결과: 카드의 둥근 위 모서리 두 곳이 호박색 직각으로 덮이고, 그 바깥에 카드 모서리 조각이 회색 쐐기로 남는다. 두 스킴 모두, 팔레트를 열 때마다.

**이전 판에서도 같은 기하였다**(하네스 A가 같은 쐐기를 보여 준다). 그래서 이 PR이 만든 결함은 아니다. 다만 지금 그 상자를 **소유하는 엘리먼트를 이 PR이 새로 만들었고**, H-1을 고치러 가는 손이 정확히 같은 줄에 닿는다. 따로 티켓을 파느니 함께 닫는 편이 싸다.

---

### [Medium] M-2 — 계약 1항이 만든 **새 상태를 어느 레인도 찍지 않는다**

**증거**: `capture-screens.mjs`의 `makeThreadReplies()`는 언제나 답글을 돌려주므로 `thread-empty` 분기가 캡처 전량 어디에도 렌더되지 않는다. 확인하려고 리뷰어가 하네스를 세워야 했다: `harness-thread-empty-light.png` · `harness-thread-empty-dark.png` (`harness-thread.html`, 빌드된 CSS·같은 클래스 목록)

같은 PR이 **hover** 케이스에는 캡처 자를 새로 놓았다(`assertThreadRootHoverToolbar`). 비대칭이 요점이다: 티켓 1항이 **말하는 대상**이 바로 이 빈 상태인데, 그것만 사진이 없다. 정본 §4는 상태 축에서 「가장 가까운 대체물은 캡처 레인」이라고 적고, §5.3은 증거·캡처 공백을 코퍼스 7위(9건)로 센다. `captureEmptyConversationScenes`라는 자리가 이미 있으므로 새 장치가 필요한 일도 아니다.

(하네스로 본 한에서 렌더 자체는 정상이다: 점선 상자 `mx-4` · `rounded-md` · `py-6`, 두 스킴 모두 글자 잘림 없음, 좌측 정렬 유지 — 레퍼런스 28의 **가운데 정렬**을 따라가지 않은 것은 옳은 판단이다(방언 §8 「Centered empty state」 금지).)

---

### [Medium] M-3 — 같은 문장이 웹과 폰에서 **두 벌의 옷**을 입게 됐다

- 웹(이번): 답글 영역 안, 점선 `rounded-md` 상자, `text-body font-medium text-ink` (`ThreadPanel.tsx:162-166`)
- 폰: 컴포저 **바로 위**, 상자 없음, `font.meta` + `color.textFaint` (`clients/mobile/src/features/conversation/ThreadPanel.tsx:256`, `styles.invite`)

문장은 글자 하나까지 같다(「첫 답글을 남겨 이 대화를 이어가세요.」). 자리 차이는 이 PR 이전부터 있었고 폰 쪽에 「루트는 항상 있으니 이 목록은 비지 않는다」는 근거 주석도 달려 있다 — 그 부분은 정당하다. 이번에 벌어진 것은 **격**이다: 한쪽은 조용한 묘비 글씨, 다른 쪽은 테두리를 두른 영역 선언이 됐다. 클라 간 패리티 분기는 코퍼스 2위(18건/8리포트)이고, 이 축에는 기계가 없다(§5.3). 폰 정렬은 §6 절차를 지나야 하는 별도 결정이므로 **후속 티켓**으로 충분하지만, 결정이 내려지기 전까지 「웹이 정본」이라는 기본값이 조용히 적용된 것은 기록해 둔다.

---

### [Nitpick] N-1 — 데스크톱 스레드 패널의 **rest 프레임이 이제 어디에도 없다**

`assertThreadRootHoverToolbar`가 루트에 포인터를 올려 둔 **바로 다음 줄**에서 `u4-thread-composer-parity-{scheme}.png`를 찍는다. 그래서 컴포저 패리티를 위해 존재하던 그 사진이 이제 호버 툴바를 달고 있고(이번 리뷰에는 편했다), 1280에서 스레드 패널의 평상 상태를 찍은 프레임은 **0장**이 됐다(390 프로파일에는 남아 있다: `mobile-b11-thread-{light,dark}.png`). 정본 §5.3 마지막 줄이 적듯 이 레포의 게이트는 hover 잔상이 계측을 흔들어서 마우스를 일부러 치워 둔다 — 여기서는 그 잔상이 **다른 목적의 사진** 안에 앉았다. 방향: 단정 뒤 포인터를 물리거나, 호버 프레임을 자기 이름으로 한 장 더 찍는 것(그 편이 M-2의 형제 공백도 함께 닫는다).

### [Nitpick] N-2 — `border-dashed`는 이 레포의 **첫 등장**이고, 그 축에는 아무 자도 없다

`clients/web/src` 전수에서 `border-dashed`는 이 한 줄뿐이다. 색은 정당하다(`--line`은 나누는 선이고 컨테이너 프리미티브가 쓰는 그 토큰이다 — 실측 대비 라이트 1.32 · 다크 1.43, 두 스킴이 사실상 같다). 문제는 **선의 꼴**이 새 어휘라는 것이다: 정본 §2.6이 그림자에 대해 「토큰이 없고 어휘가 코드에만 있었으므로 `designSystem.test.ts`가 두 단으로 잠갔다」고 적은 그 상황과 같은 모양이다. 지금은 한 자리뿐이라 무해하지만, 두 번째 저자가 세 번째 빈 상태 테두리를 발명하는 것을 막는 것은 아무것도 없다. §6의 답은 대개 「더하지 말고 **이름을 지어라**」다.

### [Nitpick] N-3 — 32px 여백이 두 가지 일을 지는데, 그것을 붙드는 것은 **문자열 단정**이다

코드 주석이 정직하게 적는다: 이 여백은 분리이면서 동시에 「루트 툴바가 아래로 뒤집힐 때 쓰는 26px 띠」다(실측 26 + 6 여유 = 32). 그런데 `threadSurface.test.ts`가 지키는 것은 `expect(panelSource).toContain('className="pt-8"')` — 값이 아니라 **글자**다. 기하 단정(교차 0)은 답글이 **있는** 픽스처에서만 돈다. 여백을 줄이는 사람은 빨간 문자열 시험을 보게 되지만, 그 시험은 왜 32여야 하는지 말하지 않는다. (정본 §5.5①의 「사본이 거짓말한다」와 같은 계열은 아니다 — 이 시험은 정본 파일을 읽는다 — 다만 재는 축이 다르다.)

### [Nitpick] N-4 — `outline-none focus-visible:outline-none`은 `naked_focus`를 **문자열로** 통과한다 (이 PR의 빚이 아님)

프리플라이트 `naked_focus`는 「`outline-none`이 있는 클래스 목록에 `focus-visible:`이 있는가」만 본다. 링을 **없애는** 선언도 그 조건을 만족시킨다. 다만 이것은 이 PR이 발명한 것이 아니라 그릇-포커스 입력의 **집안 관례**이고(`Composer.tsx:910` · `ThreadComposer.tsx:291`, `composerParity.test.ts:139-142`가 그 형태를 단정한다), 실제 링은 그릇이 든다. 기록해 두는 이유는 §5.3이 그런 맹점을 적는 자리이기 때문이다: 언젠가 그릇의 링이 사라져도 이 그렙은 초록으로 남는다.

---

## 5. 잘 된 것 (기록)

- **일반화의 모양이 옳다.** 「스레드 전용 선택자를 하나 더 추가」가 아니라 「가장 가까운 세로 경계」로 규칙을 다시 적었고, 표식은 안정적 빠른 경로로 남겼다. 정본 §5.5②가 말하는 허용목록/잔량의 갈림에서 **허용목록을 늘리지 않는 쪽**을 골랐다.
- **수리에 자를 함께 놓았다.** `assertThreadRootHoverToolbar`는 사진이 아니라 **계측**이다 — 글자 상자를 `Range`로 훑어 교차 문자 수를 세고, 표본까지 오류 메시지에 싣는다. 정본 §5.3의 「hover 상태의 사진이 하나도 없었다」는 공백에 칸을 하나 더 메웠다.
- **레퍼런스를 베끼지 않고 골랐다.** buzz의 빈 상태는 가운데 정렬 2줄인데, 이 구현은 점선 상자만 가져오고 좌측 정렬·한 줄을 지켰다(방언 §8).
- **웹이 폰 쪽으로 한 걸음 갔다.** 루트 아래 구분선은 폰 `Timeline`에 없던 것이다. 웹이 그것을 지우면서 두 클라의 스레드 본문 구조가 가까워졌다(빈 상태의 격 차이는 M-3으로 남는다).

---

## Verdict

```
[Blocker] 0
[High]    1   H-1  ⌘K 입력 보더가 화면에서는 그대로다 (계약 3항 미달)
[Medium]  3   M-1  포커스 링이 다이얼로그 둥근 모서리를 깎는다 (선재, 같은 줄에서 함께 닫힘)
              M-2  새 빈 상태를 찍는 레인이 없다
              M-3  같은 문장의 웹/폰 격 분기
[Nitpick] 4   N-1~N-4

Verdict: PASS (blockers: 0)
```

Blocker 0이므로 CLAUDE.md 하드 룰의 게이트는 통과한다. 다만 **웹 표면의 ADR-0133 패리티 목표는 Blocker 0 · High 0**이고 이 리뷰는 High 1을 남긴다 — 루브릭 규정대로 「zero Blockers + High ≤2」라 사람 심사로 올라갈 수는 있으나, 웹 목표를 그대로 적용하면 H-1은 **이 PR에서 닫거나, 닫지 않는다는 결정을 명시**해야 한다.

권고: 계약 1·2항(실제 버그)은 실측으로 깨끗하다. H-1은 코드 되돌리기가 아니라 **결정 하나**(팔레트 머리의 포커스를 그릴 것인가)이므로, 그 결정을 받아 같은 PR에서 M-1과 함께 닫는 것이 가장 싸다. M-2·M-3은 후속 티켓으로 충분하다.

---

## 부록 — 이 리뷰가 만든 증거

| 파일 | 무엇 |
|---|---|
| `design_preflight_web.txt` | 기계 프리플라이트 원문 (web 12/12 · core 5/5) |
| `capture-design.log` | `npm run build && npm run capture:design` 전량 로그 (EXIT=0) |
| `web-tests.log` | tsc 0 · vitest 1530/1530 |
| `u4-thread-composer-parity-{light,dark}.png` | 스레드 패널 + 루트 hover (실캡처) |
| `crop-thread-root-hover-{light,dark}.png` | 위의 패널 확대 |
| `b11-message-actions-{light,dark}.png` · `crop-channel-hover-light.png` | 채널 타임라인 hover 회귀 대조 |
| `mobile-b11-thread-{light,dark}.png` | 390px 스레드 패널 rest (32px 여백을 툴바 없이 읽는 프레임) |
| `quick-switcher-people-{light,dark}.png` · `crop-cmdk-{light,dark}.png` | ⌘K 실캡처 |
| `crop-cmdk-corner-{light,dark}.png` | 링이 둥근 모서리를 깎는 자리 (4배) |
| `harness-cmdk-before-focused-{light,dark}.png` / `harness-cmdk-after-focused-{light,dark}.png` | 이전/이번 클래스 목록을 **빌드된 CSS**로 나란히 렌더한 A/B |
| `harness-thread-empty-{light,dark}.png` | 어느 레인도 찍지 않는 점선 빈 상태 |
| `harness-cmdk.html` · `harness-thread.html` · `harness-shot-*.mjs` | 위 하네스 원본 (레포 밖에서 실행, 레포 파일은 하나도 고치지 않았다) |

리뷰어는 파일을 수정하지 않았다. 수리는 구현자의 몫이다.
