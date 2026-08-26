### Design Review — clients/web 사이드바 (UX-D4 · PR #1765 · `feat/1756-d4-sidebar` @ ef403edc)

정본: `docs/design-system/README.md` (오르트 구름) · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` ·
루브릭 `.claude/skills/momo-design-taste/references/review-rubric.md`.
표면 라우팅: `clients/web/**` → 웹 방언 (라우터 §0). 폰 방언은 이 변경에 해당 없음.

Screenshots (캡처 레인, 두 스킴):
- `clients/web/artifacts/design/sidebar-profile-card-{light,dark}.png`
- `clients/web/artifacts/design/sidebar-section-hover-{light,dark}.png`
- `clients/web/artifacts/design/sidebar-section-collapsed-{light,dark}.png`
- `clients/web/artifacts/design/sidebar-collapsed-{light,dark}.png`
- `clients/web/artifacts/design/mobile-sidebar-{drawer,profile-card}-{light,dark}.png`

Screenshots (리뷰어 자체 런타임 프로브, `claudedocs/design-review-1765/evidence/`):
`identity-hover.png` · `section-hover-{light,dark}.png` · `collapsed-{light,dark}.png` ·
`touch-drawer.png` · `touch-card.png` · `b-pointer-collapse.png` · `c-after-dialog.png` ·
`e-add-workspace.png` · `f-tab-walk.png` · `g-{collapsed,expanded}.png` · `h-900.png` ·
`profile-longname-{light,dark}.png`

---

## 0. Prep — 증거 획득 경로

| 레인 | 명령 | 결과 |
|---|---|---|
| 빌드 | `clients/web && npm run build` | exit 0 |
| 캡처 | `clients/web && npm run capture:design` | **exit 0**, 두 스킴 × 데스크톱/폰, D4 프레임 12장 신규 |
| 타입 | `npm run typecheck` | exit 0 |
| 단위 | `npm test` | **111 files / 1563 tests 전부 통과** |
| 셸 프리플라이트 | `scripts/design_preflight_web.sh` | **PASS** (원문 아래) |
| 런타임 프로브 | 리뷰어가 캡처 스크립트의 모의 `/v1`·`signIn`을 재사용해 별도 작성(레포 파일 무수정, `/tmp/d4probe`) | 1280/900/560/390 네 폭 × 두 스킴 |

> **폰(`clients/mobile`)에는 기계 프리플라이트가 없다.** 이 PR은 폰 트리를 건드리지 않았으므로
> 해당 없음이지만, 빈 칸이 「깨끗한 실행」으로 읽히지 않게 여기 적는다(라우터 §2·§4).

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
EXIT=0
```

---

## 계약 4항 판정 (요약)

| # | 계약 | 판정 |
|---|---|---|
| 1 | 하단 프로필 카드 = 실존 기능만 | **충족.** 발명 0건 — 카드 항목은 선언 상태 라디오 3, 레일이 이미 쓰는 `useOpenAddWorkspace`, 실존 `/settings` 라우트뿐. buzz 36의 `Send feedback`·워크스페이스 전환(ADR-0161 4b-3 미랜딩)은 들어오지 않았고 `presenceIndicators.test.ts`가 그 부재를 전수로 잰다 |
| 2 | ADR-0160 의미 준수 | **충족, 그리고 buzz보다 정본이 옳았다.** ADR-0160 D2/가드 4는 선언 enum을 `{auto, away, dnd}`로 봉인하고 D3은 유효값을 **계산**이라고 못박는다. buzz 37의 `Offline` 라디오는 「내구 의도」가 아니라 렌더값이므로 픽커에 두면 D1(가용성=휘발)과 D3(비정규화 금지)을 동시에 깬다. 구현은 `PRESENCE_OPTIONS` 3개만 렌더하고 `effectivePresence(declared, connStatus==='connected')`를 렌더 경계에서 계산한다 ✔. PUT은 실왕복(`PUT /v1/workspaces/{ws}/presence`)이고, 캡처가 **요청 본문(`status:"away"`)과 재렌더된 배지(`data-effective="away"`)를 둘 다** 단정한다 — §5.5의 「응답만 보고 배지를 안 보는」 함정을 실제로 닫았다 |
| 3 | 패널 접기 상단 이동 + 접힘 UI | **기능 충족, 배치에 이견.** 접기/펼치기 왕복·포커스 인계는 정확히 살아 있다(프로브 G: 접기→`sidebar-expand` 포커스, 펼치기→`sidebar-collapse` 포커스). 다만 M-4 |
| 4 | 섹션 상시 + 제거 → 조건부 마운트, chevron 상시 탭 스톱 | **술어는 옳고 배선이 한 칸 비었다.** rest에서 DOM 0 ✔, `opacity` 트릭 0 ✔, 포인터 클릭에 fv 링 없음 ✔, 키보드 Tab이 hover 없이 접기→+ 순으로 닿음 ✔ — 그런데 `overlayOpen`이 상수 `false`라 **B-1** |

---

## [Blocker]

### B-1. 섹션 액션이 자기가 연 다이얼로그가 떠 있는 동안 언마운트된다 — 닫으면 포커스가 `<body>`로 떨어지고 Tab이 문서 처음으로 되돌아간다

**무엇이 깨지나 (순수 키보드 경로, 포인터 0회 — `evidence/f-tab-walk.png`, 프로브 4):**

```
nav-search → Tab → section-collapse-channels(fv) → Tab → new-channel(fv:true)
Enter → create-channel-dialog 열림 ┃ 이 시점 new-channel 마운트 수 = 0
Esc  → 다이얼로그 닫힘            ┃ document.activeElement = BODY
Tab  → add-workspace (레일)
```

캐럿이 채널 섹션에서 **레일 맨 위로 튄다.** 인박스·활동·멤버·에이전트·작업 콘솔·메시지 검색·
채널 섹션 전부를 다시 지나야 원래 자리로 돌아온다. 포인터 경로도 같다(`evidence/c-after-dialog.png`:
`{"dialogOpen":false,"active":"BODY"}`).

**왜 그런가.** 다이얼로그로 포커스가 들어가는 순간 헤더의 `onBlurCapture`가 `headerKeyboardFocused`를
지우고, 포인터도 헤더를 떠나 있으므로 `showActions`가 false가 되어 `+`가 DOM에서 사라진다.
Radix가 닫힘에서 복원하려는 「이전 포커스 요소」가 그때는 존재하지 않는다.

**답은 바로 옆 줄에 있었다** — 정본 §「이 문서가 존재하는 이유」의 코퍼스 최다 패턴(25건/11리포트)
그 자체다:

- `sidebarSectionModel.ts`의 `shouldShowSectionActions`는 **`overlayOpen`을 인자로 받는다.**
  `SidebarRow.tsx`는 그 자리에 리터럴 `false`를 넣었다.
- 이 파일이 자기 머리 주석에서 베꼈다고 밝힌 형제 구현 `hoverToolbarModel.ts`는
  `MessageRow.tsx:565`에서 `overlayOpen: pickerOpen || actionMenuOpen || contextMenuOpen`으로
  **실제로 배선돼 있다.**
- 그리고 이 사이드바가 이미 import 하는 `useCreateChannel.ts` 안에 `useCreateChannelOpen()`이
  **두 export 아래에** 있고(`QuickSwitcher.tsx:120`·`InboxHotkeys.tsx:25`가 이미 소비 중),
  그 독스트링은 「여는 함수와 열림 상태를 다른 컨텍스트로 나눈 이유」까지 적어 두었다.

**회귀임을 증명하는 대조군이 같은 빌드 안에 있다.** 터치 프로파일(390px, `hover: none`)에서는
액션이 상시 마운트라 같은 왕복의 끝이 `active: "new-channel"`이다(프로브 2). 즉 복원 자체는
동작하고, 사라진 노드만이 원인이다.

**게이트가 못 잡은 이유는 §5.3이 이미 적어 둔 것이다** — 「렌더된 화면에서의 포커스 수명」을 재는
기계가 이 레포에 없다. 캡처는 `+`를 실제로 누르지만(좋다) 닫은 뒤의 `activeElement`를 보지 않고,
오히려 `revealNewChannel()`이 매번 헤더를 다시 hover 해서 이 결함을 **우회한다.**

방향(픽셀 아님): 열림 상태를 술어에 실제로 먹이거나, 액션이 오버레이를 들고 있는 동안은
마운트를 유지할 것. 둘 다 이 레포에 선례가 있다.

---

## [High]

### H-1. 폰 서랍에서 프로필 카드의 행이 32px다 — 그리고 `설정`이 44×44에서 그 32px로 내려앉았다

`dropdown-menu.tsx`의 `menuRowClass`는 자기 독스트링에 전제를 명시한다:

> `h-control` (32px) is the pointer measure: **this menu is opened by a mouse or a Tab, never by a
> thumb** (the phone opens the sheet in `MessageActions.tsx`, whose rows are 44px).

이 PR이 그 전제를 거짓으로 만든다. 프로필 카드는 폰 서랍의 1급 진입점이고
(`MOBILE_TAP_TARGETS`에 `profile-card` 44×44로 등록, 캡처가 390px 서랍에서 실제로 탭하고
`mobile-sidebar-profile-card-*.png`로 찍는다), 그 카드가 여는 것이 바로 이 `DropdownMenu`다.
실측(390×844, `hasTouch`, `evidence/touch-card.png`): 다섯 행 전부 **32px**
(`presence-option-auto/away/dnd`, `profile-add-workspace`, `nav-settings`).

- 이전 `설정`은 사이드바 하단의 `tap-target size-control-sm` Link였고 `@utility tap-target`
  (`tokens.css:846`, `width < 600px`)에 의해 **폰에서 44×44**였다. 지금은 32px 메뉴 행이다.
  정본 §2.7의 44는 WCAG 2.5.5/Apple HIG의 값이고, 24는 「본문에 섞여 사는 링크용」이지
  메뉴 행용이 아니다.
- **기계가 초록인 이유가 정확히 §5.5②다.** 이 PR이 캡처에 추가한
  `assertTapTargets(page, 'drawer profile ...')`는 **그 프레임에서** 돌지만
  `MOBILE_TAP_TARGETS`는 정본이 이름 대어 「허용목록 ❌」이라고 적어 둔 그 목록이라,
  목록 밖인 메뉴 행 다섯은 **측정되지 않는다.** 잰 것은 트리거 하나뿐이다.

방향: 폰에서 열리는 카드라면 폰용 시트 문법(이미 `MessageActions.tsx`가 44px로 갖고 있다)을
쓰거나, 메뉴 행 측정을 입력 장치 축으로 갈라 둘 것. 어느 쪽이든 프리미티브의 독스트링이
지금 하는 주장과 화면이 같은 말을 해야 한다 — 정본 §2.2의 「토큰 계약과 화면이 다른 말을 하면
이기는 쪽은 언제나 화면이다」와 같은 자리다.

### H-2. 프로필 카드의 `워크스페이스 추가`도 취소하면 포커스가 `<body>`로 떨어진다

`evidence/e-add-workspace.png` / 프로브 1:

```
profile-card 클릭 → profile-add-workspace 클릭
  → add-workspace-dialog 열림, active = add-workspace-name  ✔ (여기까지 좋다)
Esc → dialogs 0, active = BODY                              ✘
```

B-1과 뿌리는 같다(사라진 노드로의 복원). 다만 기제가 다르다: 메뉴가 닫히면서 항목이
언마운트되는 것은 Radix 메뉴의 본성이므로 술어 배선으로는 못 고친다. 레일의 `[+]`는 상시
노드라 같은 사고가 나지 않으므로, **이 PR이 새로 만든 두 번째 진입점만** 이 결함을 갖는다.
방향: 카드가 여는 다이얼로그의 닫힘 포커스를 트리거(프로필 카드)로 명시할 것.

---

## [Medium]

### M-1. 섹션 헤더가 hover에서 26→28px로 자라, 채널 목록과 DM 섹션 전체가 커서 밑에서 2px 내려간다

실측(1280, 프로브 1·4):

| | 헤더 높이 | 첫 채널 행 top | DM 섹션 헤더 top |
|---|---|---|---|
| rest | 26 | 279 | 415 |
| hover | **28** | **281** | **417** |

제목 버튼은 `py-1 + text-meta(18px 줄상자) = 26px`인데 마운트되는 `+`는 `size-control-sm = 28px`다.
DM 헤더도 같다(26→28).

이 PR이 지운 주석이 지키던 것이 정확히 이 축이었다("헤더가 18px로 줄었다가 … 채널 목록이 한 번
내려앉는다"). 새 주석은 「rest 헤더 높이는 흔들리지 않는다」라고 적는데 그것은 참이고,
**흔들리는 자리가 rest에서 hover로 옮겨 갔을 뿐이다.** 사용자가 목록을 향해 마우스를 내리면
헤더를 가로지르는 순간 목표 행이 2px 움직인다.

방향: 헤더 제목이 컨트롤 높이 축(`h-control-sm`)에 서면 마운트 여부와 무관하게 한 값이 된다 —
정본 §2.3의 「격자 밖 측정값은 이름으로 들어온다」와 같은 결.

### M-2. 섹션을 접으면 그 안의 미읽음이 흔적 없이 사라진다 — 그런데 ⌥↓는 여전히 거기로 간다

실측(프로브 1 B): 채널 섹션을 접은 뒤 그 `<section>`의 전체 텍스트가 문자열 **`"채널"`** 하나다.
픽스처의 `엔진 2`(미읽음 2)가 배지째 사라진다(`evidence/sidebar-section-collapsed-light-crop.png`,
접기 전 `evidence/sections-light.png`와 대조).

동시에 `Sidebar.tsx`의 `unreadChannels`는 `ordered`(= channels + dms)에서 계산되므로 **⌥↓는 접힌
섹션 안의 채널로 계속 이동한다.** 화면에서는 없는 것이, 키보드에는 있다. 정본 §5.3의
「한 클라 안의 내부 불일치」(10위) 축이고, 기계는 이 축에 아무것도 갖고 있지 않다.

Slack이 접힌 섹션에서 미읽음 행만 남기는 것은 취향이 아니라 이 정확한 손실을 막기 위해서다.
방향: 접힘은 「읽은 것을 치우는 것」이지 「알림을 끄는 것」이 아니어야 한다.

### M-3. 이 PR이 새로 만든 「섹션 접힘」 선호가 새로고침마다 초기화된다

실측(프로브 3): 라우트 이동에는 살아남고(`data-collapsed=""` 유지) **reload에서는 사라진다**(`null`).
`collapsedSections`가 `Sidebar`의 `useState`에 산다. 채널이 많아 목록을 다스리려고 접은 사람은
앱을 다시 열 때마다 같은 일을 다시 한다. 정본 §5.3 14위(상태 수명주기 — 새로고침 생존)는
**사람만 잡는** 축으로 이름 붙어 있다.

(패널 접힘 `channelPaneCollapsed`도 reload에서 풀리지만 그것은 이 PR 이전부터의 성질이고
이 변경이 건드리지 않았다 — 회귀가 아니라 기존 상태로 기록한다.)

### M-4. 접힌 레일에서 「돌아가는 길」이 가장 흐리고, 패널 컨트롤이 워크스페이스 묶음을 가른다

`WorkspaceRail.tsx`에서 `[+]`가 `열기` **아래로** 내려가고 `열기`의 `mt-auto`가 빠졌다.
실측 순서(프로브 2, `evidence/collapsed-{light,dark}.png`):

```
nav[aria-label="워크스페이스"]
  ├ workspace-current  t=8   44px  bg-accent-soft + 액센트 바   (채운 표면)
  ├ sidebar-expand     t=60  44px  테두리 없음, 아이콘+「열기」  (가장 흐림)
  └ add-workspace      t=112 44px  border-line-strong (3:1)     (가장 진한 윤곽)
```

두 가지가 걸린다.

1. **위계.** 정본 §3은 나란히 선 컨트롤의 순서를 값이 아니라 **관계**로 잰다. 지금 이 세로줄에서
   가장 강한 윤곽(`--line-strong`)을 입은 것은 드물게 쓰는 `워크스페이스 추가`이고, 방금 한 일을
   되돌리는 `열기`는 그릇이 아예 없다. dark1155 M1이 남긴 교훈("각 값이 개별적으로 옳으면서
   전체가 틀릴 수 있다")과 같은 모양이다.
2. **어휘 혼입.** 패널 컨트롤이 `nav[aria-label="워크스페이스"]` 안에서 **현재 워크스페이스 타일과
   워크스페이스 추가 사이에** 끼었다. 스크린리더는 이 랜드마크를 「워크스페이스: 현재 m, 탐색 패널
   열기, 워크스페이스 추가」로 읽는다. 이전 판은 `열기`가 `mt-auto`로 바닥에 떨어져 있어 같은 nav
   안이어도 시각적으로는 다른 묶음이었다.

덧붙여 **주석의 주장이 렌더와 다르다.** `Sidebar.tsx`는 "collapse and expand share one vertical
seat"라고 적지만 실측은 접기 `28×28 @ cy=22`(패널 헤더), 펼치기 `44×44 @ cy=82`(레일)로
같은 자리가 아니다(가로로도 cx 78 → 28). 왕복이 제자리에서 뒤집히지 않는다.

### M-5. `설정`의 키 힌트 `(⌘,)`가 사라졌고, 코어의 카피 정본이 없는 줄을 가리킨다

`packages/momo-core/src/features/chat/composerCopy.ts:508-512`는 툴팁 어법(`<동작> (<키>)`)의
**예시 셋을 이름 대어** 적고 「이 셋을 힌트 줄 문법으로 바꾸지 마라」라고 후임에게 남긴다.
그 셋 중 하나가 `sidebar/Sidebar.tsx:690  title="설정 (⌘,)"`인데, 이 PR이 그 줄을 지우고
카드 안의 `설정` 행에는 아무 힌트도 두지 않았다. 남은 둘(`새 다이렉트 메시지 (⌘⇧K)` ·
`메시지 보내기 (Enter)`)은 그대로다.

결과는 둘이다: (a) 코어 정본이 존재하지 않는 좌표를 가리킨다, (b) `설정`으로 가는 **유일하게
보이는 문**에서 ⌘, 의 존재가 사라졌다(⌘/ 도움말 다이얼로그에만 남는다). buzz 36도 자기 카드에서
`Settings ⌘,`를 적는다. ⌘, 자체는 여전히 동작한다(`QuickSwitcher.tsx:206`).

### M-6. 트리거의 접근명이 코어를 떠났고, `title`과 `aria-label`이 서로 다른 말을 한다

`ProfileCard.tsx`:

```
aria-label={`${selfName}, ${effectivePresenceLabel(effective)}. 프로필 열기`}
title={`${selfName}, ${effectivePresenceLabel(effective)}`}
```

- 코어의 `presenceTriggerLabel()`은 이제 **두 클라 어디에서도 안 쓰인다**(자기 테스트만 호출).
  그 자리를 `.tsx` 안에서 조립한 한국어 문장이 대신한다 — `presence/model.ts`가 `PRESENCE_OPTIONS`
  독스트링에서 스스로 경고한 「한 낱말에 두 출처」다. 폰이 프레즌스를 랜딩할 때 이 문장을 다시
  짜거나 갈라진다.
- 툴팁이 **동사를 잃었다.** SR은 "…프로필 열기"를 듣고 포인터는 "곽성재, 오프라인"만 본다 —
  컨트롤의 이름이 아니라 상태 문장이다. 코어가 적어 둔 툴팁 어법은 `<동작> (<키>)`다.

---

## [Nitpick]

- **N-1. 자기를 증거라고 부르는 죽은 함수.** `sidebarSectionModel.ts:32`의
  `countSectionActionTabStops()`는 독스트링에 "Red proof: 0 at rest"라고 적고 **아무 데서도 호출되지
  않는다**(레포 전수 grep 1건 = 정의 자신). 베껴 온 형제 `countToolbarTabStops`는
  `MessageHoverToolbar.test.tsx:340·353`이 실제로 돌린다. 겸사, `sidebarSectionModel.test.ts`의
  「열린 오버레이가 있으면 유지한다」는 **제품이 절대 들어가지 않는 분기**를 초록으로 단정한다(B-1).
- **N-2. 접힘 중 `aria-controls`가 허공을 가리킨다.** `<ul id="sidebar-section-…-list">`가 통째로
  언마운트되므로 접힌 동안 참조 대상이 없다. `aria-expanded`가 상태를 지고 있어 치명적이지는
  않지만 참조는 무효다.
- **N-3. 제목의 이름을 동사가 덮어쓴다.** `<h2><button aria-label="채널 섹션 접기">채널</button></h2>` —
  h2의 접근명이 버튼의 `aria-label`이 되어, 제목 순회(H)로 도는 사용자는 "채널"이 아니라
  "채널 섹션 접기"를 듣는다. 그리고 그 동사는 `aria-expanded`가 이미 말하는 것을 한 번 더 말한다
  ("채널 섹션 펼치기, 축소됨"). 보이는 글자가 이미 이름이므로 라벨이 필요한 자리가 아니다.
- **N-4. 낡은 주석 둘.** `Sidebar.tsx:548` "사이드바의 아이콘 버튼 셋(+, 새 DM, **설정**)이 같은
  규격이다" — 설정은 이 PR에서 사이드바를 떠났다. `ProfileCard.tsx` "The whole row is the trigger" —
  실측 트리거는 167×45 행 안의 **111×24**이고 연결 바와 `?`는 그 밖에 있다(`evidence/identity-hover.png`).
- **N-5. `role="menu"` 면제에 단위 증거가 없다.** `escapeLayer.test.ts`는 `it` 이름만 바뀌었고
  `runTopEscapeLayer(true)`로 불리언을 주입하므로, 새로 추가된
  `document.querySelector('[role="menu"][data-state="open"]')` 셀렉터 자체는 단위 층에서 한 번도
  실행되지 않는다. 실증은 캡처의 폰 Esc 시퀀스뿐이고 — 그쪽은 초록임을 리뷰어가 재확인했다(아래).

---

## 통과를 기록해 두는 것 (재발 검사 축, 전부 실측)

| 축 | 결과 |
|---|---|
| 포인터 클릭에 fv 링 없음 | ✔ 섹션 접기 클릭 후 `:focus-visible`=false, `outline-style: none` (`evidence/b-pointer-collapse.png`) |
| 키보드가 hover 없이 접기·추가에 닿는가 | ✔ `nav-search → 접기(fv) → +(fv) → 채널 4행 → DM 접기 → 새 DM` (`evidence/f-tab-walk.png`) |
| rest 탭 예산 | ✔ 포인터 rest에서 `[data-section-action]` 0개, `new-channel` DOM 0개. 캡처도 별도로 단정 |
| `opacity`/`visibility` 트릭 | ✔ 0건(조건부 마운트만) |
| Esc 층 순서 (카드 → 서랍) | ✔ 390px 서랍: 1차 Esc → 메뉴만 닫히고 포커스 `profile-card` 복귀, 2차 Esc → 서랍 닫히고 포커스 `open-sidebar-drawer` 복귀 |
| 상태 PUT 실왕복 + 재렌더 | ✔ 요청 본문 `{"status":"away"}` **그리고** 배지 `data-effective="away"` 둘 다 단정. 되돌리기(auto)까지 왕복 |
| 프레즌스 어휘 분리 (ADR-0160 가드 6) | ✔ 선언 배지(원형)와 연결 바(12×4 막대)가 여전히 다른 모양, 같은 행 |
| 패널 접기/펼치기 포커스 인계 | ✔ 접기 → `sidebar-expand`, 펼치기 → `sidebar-collapse` |
| 무선언 가로 스크롤 | ✔ 1280 접힘 0 / 900 0 (`evidence/h-900.png`) |
| 헤더 폭 회귀 | ✔ 접기 아이콘이 36px를 가져갔지만 `검색과 이동 ⌘K`는 131px 상자에 129px로 들어간다(넘침 없음) |
| 긴 한국어 이름 | ✔ 이름 27자 주입 시 `truncate` 동작(scrollW 277 / clientW 71). 이름 칸은 오히려 **넓어졌다** — 톱니 28px + gap 8px이 행을 떠나 지금 71px (이전 판 기하로 역산하면 ~43px) |
| 두 스킴 | ✔ light/dark 전 프레임 대조, 다크에서 새 표면 없음 |
| 터치 프로파일 | ✔ 390px 서랍에서 액션 상시 마운트, `profile-card` 44×44, 채널 행 44px |
| 웹 AI-Tell (§8) | ✔ 토스트·그라디언트·시머·이모지 아이콘·업로케이스 눈썹 0건. lucide 한 벌 |
| 드래그 간섭 | 해당 없음 — 사이드바에 드래그 표면이 없다(리사이즈 핸들·재정렬 없음). 새 `onMouseEnter/Leave`는 상태만 바꾼다 |

---

## Verdict

```
Blocker 1 · High 2 · Medium 6 · Nitpick 5
Verdict: FAIL (blockers: 1)
```

ADR-0133 웹 패리티 목표는 **Blocker 0 · High 0**이다. B-1은 이 PR이 새로 만든 상호작용(조건부
마운트)의 유일한 액션에서 키보드 복귀 경로를 끊고, 수리는 같은 파일의 형제와 이미 import 한
모듈 안에 있다. H-1·H-2도 같은 왕복에서 이 PR이 새로 만든 자리다.

기계 층(프리플라이트 12/12 + 코어 5/5, 단위 1563, 타입체크, 캡처 exit 0)은 전부 초록이고,
그 초록이 이 결함들을 못 본 이유는 정본 §5.3이 이미 이름 붙여 둔 무검사 축들이다 —
렌더된 포커스 수명, 허용목록형 탭 타깃 계측(§5.5②), hover 프레임의 기하, 상태 수명주기.
이 PR은 캡처를 **계약만큼 넓히려는** 정직한 시도를 했고(카드 열기·PUT 본문·배지 재렌더·
섹션/패널 접기를 실제로 누른다) 그 점은 이 리뷰가 확인했다. 남은 공백은 「누른 뒤 캐럿이
어디에 있는가」 한 칸이다.

---

*리뷰 방법 주기: 캡처 레인은 원본 그대로 실행했고, 상호작용 증거는 캡처 스크립트의 모의 `/v1`과
`signIn`을 재사용하는 별도 프로브(`/tmp/d4probe`, 레포 파일 무수정)로 1280/900/560/390 네 폭 ×
두 스킴에서 획득했다. 레포 파일은 하나도 수정하지 않았다.*
