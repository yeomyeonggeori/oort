# Design Review — clients/web 채널 하단 관전 터미널 도크 (PR #1766 / 티켓 #1758 / TC-1)

- 대상: `/Users/kwakseongjae/projects/momo-tracks/momo-worktrees/tc1-terminal`, `feat/1758-tc1-terminal`
  @ `94ee4ba7` (2커밋: `1f357e90` 도크, `94ee4ba7` 게이트 재배선)
- 범위: `git diff origin/track/uxui..HEAD` — 27파일 / +1736 −71
- 표면: **웹 하나**. `clients/mobile` 변경 0파일. `clients/desktop`은 표면이 아니다
  (`docs/design-system/README.md` §1 주1 — Tauri `frontendDist`가 `../../web/dist`).
- 정본: `docs/design-system/README.md` (오르트 구름) · 방언
  `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭
  `.claude/skills/momo-design-taste/references/review-rubric.md`
- 증거: 이 폴더 `shots/` 18장 · `logs/` 5건. 모든 수치는 **내가 이 워크트리를 빌드해서
  직접 잰 것**이고, 인용한 캡처 경로는 실제 파일이다.

---

## 0. 증거 · 기계 검사 (Phase 0 · 6)

전부 이 리뷰에서 다시 돌렸다. 커밋된 `gates/evidence/1758/`을 신뢰해서 옮겨 적은 줄은 없다.

| 레인 | 결과 | 로그 |
|---|---|---|
| `scripts/design_preflight_web.sh` | **PASS — web 12/12 + core 5/5** | `logs/design_preflight_web.txt` |
| `npm run build` | rc=0 | — |
| `npm run capture:design` (light+dark, 두 프로파일) | rc=0, `terminal-dock-*` 12장 신규 | `logs/capture-dock-lines.log` |
| `npx tsc -b` | rc=0 | `logs/typecheck-tests.log` |
| `npx vitest run` | 114 files / **1584 tests** 통과 | 동 |
| `gate:csp` | rc=0 | `logs/gates-summary.log` |
| `gate:shell` | rc=0 | 동 |
| `gate:work-panel` | rc=0 | 동 |
| `gate:my-sessions` | rc=0 | 동 |
| `gate:typing` | rc=0 | 동 |
| `gate:composer` | rc=0 | 동 |
| `node gates/capture-session-chips.mjs` | rc=0 | 동 |

프리플라이트 원문 (`scripts/design_preflight_web.sh`):

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

**폰(`clients/mobile`)에는 기계 프리플라이트가 없다.** 이 PR은 폰 파일을 하나도
건드리지 않았으므로 그 레인은 해당 없음이고, 표를 비워 두면 「깨끗하게 돌았다」로
읽히므로 여기 문장으로 적는다. 이 리포트의 「폰」 수치는 전부 **웹을 390×844
터치 프로파일로 렌더한 것**이지 RN 클라가 아니다.

---

## 1. 게이트 5종 재배선 — 보호 단정이 약해졌는가 (핵심 검증축)

결론부터: **단정이 삭제되거나 완화된 자리는 없다.** 그리고 그 판단을 문서가 아니라
측정으로 닫았다.

### 1.1 `gate-shell-layout` — 셀렉터 교체는 **이미 빨간 게이트의 수리**였다

diff는 `[aria-label="워크스페이스"]` → `[data-testid="workspace-rail"]`이고 숫자
(`railWidth === 56`)는 그대로다. 「잴 대상을 자기에게 유리하게 옮긴 것 아닌가」가
당연한 의심이라 직접 쟀다 — HEAD 빌드에서 두 셀렉터를 동시에 측정:

```
[rail widths at HEAD] {"navAriaLabel":44,"wrapperTestid":56,"sidebar":240}
```

`WorkspaceRail.tsx`의 두 요소는 이 PR에서 **testid 한 개만** 늘었고 클래스는 그대로다
(diff 확인). 따라서 base(`origin/track/uxui`)에서도 `[aria-label="워크스페이스"]`는
44px이었고, `before.railWidth === 56` 단정은 **참일 수 없었다.** 원인은 이 PR이
아니라 바로 앞 커밋 계열이다:

```
git show b63de43f~1:.../WorkspaceRail.tsx →  <nav aria-label="워크스페이스" className="… w-rail …">
git show origin/track/uxui:.../WorkspaceRail.tsx → <div className="… w-rail …"><nav aria-label="워크스페이스" className="flex flex-col …">
```

#1756(UX-D4 사이드바 개편)이 레일을 래퍼 div + 안쪽 nav로 쪼개면서 그 단정을
조용히 깼다. TC-1은 **숫자를 바꾸지 않고 잴 자리를 실체에 맞췄다.** 자를 무디게 한
것이 아니라 남이 두고 간 빨간 자를 고친 것이다. (부수 소득: 이 리뷰가 #1756이
빨간 게이트로 랜딩했다는 사실을 기록으로 남긴다.)

### 1.2 `gate-work-panel` — 눈금 이동은 전부 **어려워지는 방향**이다

세 자리가 움직였다.

| 자리 | 전 | 후 | 방향 |
|---|---|---|---|
| `exerciseWorkPaneCoOpen(900)` | 짧은 방 이름 | `longChannelName: true` | 더 김 = 절 생략이 실제로 일한다 |
| `exerciseHeadClauseBand(900)` | `LONG_CHANNEL_NAME`(머리 절 246px) | `HEAD_CLAUSE_CHANNEL_NAME`(머리 절 354px) | 더 김 = 「절 생략이 할 일이 없는 띠」에 실제로 든다 |
| `exerciseProbeRuler` | 1280→980 | 1280→**928** | 더 좁음 = 글 상자 318px < 문장 339px |

게이트 실행 로그가 그 수를 스스로 인쇄한다:

```
[head-clause] 900px 창 … 컴포저 342px (글 318px) · 머리 절 354px
[probe-ruler] 1280 -> 928px 창, 글자 14px -> 17.5px · 글 318px · 머리 절 250px · 문장 전체 339px
```

「TC-1이 기하를 바꿔서 옛 눈금이 깨졌고 그래서 눈금을 옮긴 것 아닌가」도 diff로
닫힌다: 이 PR의 소스 변경 중 채팅 열 기하에 닿을 수 있는 파일은 `WorkspaceRail`
(testid만)과 `ChatShell`뿐이고, ChatShell이 더한 것은 `dockOpen`일 때만 렌더되는
도크다. `gate-work-panel`의 어느 시나리오도 도크를 열지 않는다. 즉 옛 눈금은
**TC-1 이전에 이미 허공을 재고 있었다**(#1418의 900px 양보 이후). 단정문 자체는
한 줄도 지워지지 않았고, 픽스처만 더 가혹해졌다.

### 1.3 `gate-my-sessions` — 순증(+2), 그러나 한 동작이 무보호로 남았다

더해진 것: `assertChannelDock`(도크 탭이 원장 4건을 id 단위로 전부 들고 있는가) ·
`assertWorkConsoleList`(전역 목록 4행). 채널 스코프 세션이 도크로 옮겨 갔으니
**같은 강도로 다시 잰다**는 계약을 지켰다.

빠진 것 하나 → **M-3**. 아래.

### 1.4 `gate-csp` / `gate-huddle`

- `gate-csp`: 진입만 `panel → row → detail`에서 `openTerminalDock`으로 바뀌었고,
  단정(“tauri.conf.json CSP가 preview까지 그대로 도달하고 xterm이 붙는다”)은 그대로다.
  내가 다시 돌려 rc=0. 도크 경로로도 lazy xterm 청크가 실제로 붙는다는 뜻이라
  이 티켓에서는 오히려 더 짧고 정직한 경로다.
- `gate-huddle`: testid 이름과 실패 문구만 교체. 760×480에서 토글이 뷰포트 안이라는
  단정은 동일. (그 뷰포트가 뒤의 B-1/H-1과 얽힌다.)

---

## 2. 계약 확인 — 「관찰 전용 정직 축소」 (Phase 1 · 5)

여기는 **통과다.** 이 티켓의 심장이고, 잘 지켰으므로 먼저 적는다.

- **입력창 0.** `TerminalDock.tsx`에 stdin/resize/kill 인코더가 없고, xterm은
  `disableStdin: true`. `TerminalDock.test.ts`가 `send_stdin|sendInput|onData`와
  `Plus`(새 세션 버튼) 부재를 소스 전수로 단정한다.
- **새 세션 버튼 미표시.** 캡처 레인이 매 장면마다
  `terminal-dock-new` count === 0을 단정한다(웹에 create 경로가 없다는 사실의 실행 증명).
- **화면이 그 사실을 말한다.** 「읽기 전용이라 입력은 보낼 수 없고, 출력은 서버를
  거치지 않고 호스트에서 직접 옵니다」 — 가짜 어포던스 0.
  (`shots/16-capture-sessions-light.png`)
- **빈 상태가 정직하다.** 「웹에서 세션을 새로 만들 수는 없습니다.」 — §4의
  "조용한 게 정상입니다" 문법이고 사과하지 않는다. (`shots/11-capture-empty-light.png`)
- **역할 XOR.** `workOpen && … && !dockOpen`, 헤더는 `setWorkOpen(false)`, `?work-panel=1`은
  `setDockOpen(false)`. 같은 세션의 `ObserverTerminal` 이중 마운트 경로를 못 찾았다.
- **5상태 전부 실렌더 캡처**(빈/로딩/오류/오프라인/세션) × 2스킴 ×
  한국어+영어 픽스처. §4 요구를 넘긴다.
- **키보드**: 로빙 tabindex + ←/→ 실동작 확인
  (`[kbd] ArrowRight: {"testid":"terminal-dock-tab","text":"김인턴 야간 회귀 스위트 재실행 (engine track)","selected":"true"}`),
  Esc 닫힘 + 여는 컨트롤로 포커스 복귀 **두 스킴 모두 확인**
  (`[light]/[dark] focus restored after Escape: yes`).
- **오버레이 수명 누수 없음**: 도크가 열린 채 ⌘K를 눌러도 팔레트가 정상으로 열리고
  도크는 그대로, 헤더 토글 `aria-pressed`는 계속 `true`
  (`[kbd] cmd+k with dock open: {"palette":true,"dock":true,"pressed":"true"}`).
  도크는 오버레이가 아니므로 `overlayHeld`를 잡지 않는 것이 맞다.
- **WorkPanel 표면 소실 아님**: 작업 콘솔 경유(`?work-panel=1`)로 실제로 열리고,
  `gate-work-panel`·`gate-shell-layout`·`gate-my-sessions`가 그 경로로 자기 단정을
  전부 통과했다. 다만 그 문의 **모양**이 문제다 → H-4.
- **패리티**: `clients/mobile`에는 관전 터미널 표면이 애초에 없다
  (`features/work/`에 `WorkSessionParts.tsx`만). 이 PR이 만든 분기가 아니라
  이전부터의 상태이므로 패리티 결함으로 세지 않는다. TC-2가 볼 자리다.

---

## 3. 판정

```
[Blocker] 1
[High]    3
[Medium]  4
[Nitpick] 6
Verdict: FAIL (blockers: 1)
```

ADR-0133 웹 목표는 Blocker 0 · High 0이다.

---

### [Blocker] B-1 — 「확대」가 컴포저를 뷰포트 밖으로 밀어낸다. 타임라인은 0px가 된다

`h-pane-lg`(640px) + `shrink-0`이라 도크가 양보하지 않고, 채팅 열에는 세로 바닥이
없다. 내가 잰 값(HEAD 빌드, `logs/probe-geometry.log`):

| 창 | 도크 | 컴포저 | 뷰포트 | 문서 스크롤 |
|---|---|---|---|---|
| 1280×800 | 75–715 (640) | 715–**821** | 800 | 없음(`scrollHeight 800`) |
| 1280×720 | 75–715 (640) | 715–**821** | 720 | 없음 |
| 390×844 (터치) | 145–785 (640) | 830–**953**, `#composer-input` top **844** | 844 | 없음 |

- 1280×720: 컴포저 윗변이 715, 창이 720 — **입력창과 「보내기」가 통째로 화면 밖**이고
  문서는 스크롤하지 않는다. 동시에 타임라인 높이는 0이라 **읽을 수도 쓸 수도 없는 채널**이
  된다. `shots/03-dock-expanded-1280x720-composer-offscreen.png`
- 390×844: 같은 일이 폰 폭에서 일어나고, 여기서는 창을 넓히는 도피구조차 없다.
  `shots/05-phone-390x844-expanded-composer-offscreen.png`
- 1280×800에서도 이미 21px이 잘린다. `shots/02-dock-expanded-1280x800.png`

루브릭 Detail SLA(ADR-0112 D6)의 「지원되는 크기에서 컨트롤이 뷰포트를 떠난다」에
정면으로 걸린다.

이 결함이 초록을 통과한 이유가 중요하다. 이 PR이 새로 넣은
`assertDockAboveComposer`는 **도크 아랫변 vs 컴포저 윗변**만 본다:

```
dock terminal dock sessions light: 아랫변 715px <= 컴포저 715px
composer terminal dock sessions light: 입력창 768px · 전송 800px <= 보이는 800px
```

두 줄 다 참이고, 그 사이에서 컴포저는 창 밖으로 나가 있다. 800px 창에서 「전송
800px <= 보이는 800px」이 통과하는 것은 버튼 아랫변이 **정확히 마지막 픽셀 줄**에
닿아 있다는 뜻이지 여유가 있다는 뜻이 아니다. §5.5②가 이름 붙인 「아무것도 증명하지
않는 초록」이다.

그리고 **답은 이 레포에 이미 적혀 있다.** 가로축에서 똑같은 사고가 두 번 났고
(#1413·#1418), 그래서 `tokens.css`에 `--spacing-chat-min: 368px`와
`route-region`·`chat-region` 바닥이 있다. `AppShell.tsx:275` 주석이 그 규칙을
한 문장으로 적는다 — 「작업 패널이 컴포저를 바닥 아래로 밀지 못한다」. 세로축에는
그 문장이 없고, 도크가 정확히 그 일을 한다. (방향만 제안한다: 도크 높이를 남은
공간에 대한 비율/상한으로 두고 타임라인·컴포저에 세로 바닥을 주는 쪽. 픽셀은
구현자가 잰다.)

STATUS.md의 「도크는 컴포저 형제(덮지 않음)」는 flexbox 문장으로는 참이지만
화면 문장으로는 거짓이다. §2.2의 그 규칙 — 토큰 계약과 화면이 다른 말을 하면
이기는 쪽은 언제나 화면이다.

---

### [High] H-1 — 접힌 도크도 양보하지 않는다: 480px 높이에서 대화가 사라진다

같은 뿌리, 기본 상태. `h-pane`(320px) + `shrink-0`.

| 창 | 헤더 아랫변 | 도크 윗변 | 타임라인 | 컴포저 |
|---|---|---|---|---|
| 1280×800 | 80 | 374 | 294px | 694–800 ✅ |
| 1280×640 | 80 | 214 | 134px | 534–640 ✅ |
| 1280×560 | 80 | 134 | **54px** | 454–560 ✅ |
| 760×480 | 75 | 75 | **0px** | 395–**501** (21px 잘림) |

760×480은 이 레포가 스스로 「지원한다」고 선언한 크기다 — `gate-huddle`이 바로 그
뷰포트에서 **이 토글이 화면 안에 있는지**를 잰다. 그 토글을 누르면 채널이 사라진다.
`shots/04-dock-collapsed-760x480-timeline-zero.png`

Blocker로 올리지 않은 이유는 컴포저의 실제 컨트롤(입력·전송)이 아직 눌리는 자리에
남아 있기 때문이다. 그러나 「관전 터미널을 열면 관전하려던 대화가 없어진다」는
제품 문장으로는 B-1과 같은 결함이다.

---

### [High] H-2 — 도크의 기본 높이는 터미널 9줄이다. 이 레포가 적어 둔 바닥은 22줄이다

실측(HEAD 빌드, 1280×800):

```
[terminal box collapsed] {"dockH":320,"terminalH":138,"rows":9}
[terminal box expanded]  {"dockH":640,"terminalH":458,"rows":32}
```

`tokens.css:421`의 `--spacing-terminal-body: 320px` 주석이 이 축의 정본이다:

> A read-only terminal is measured in ROWS, not in rhythm steps: at the 12px
> monospace role a row measures 14px, so 320px draws 22 rows, **the smallest
> window in which a command and the output it produced are visible together.**
> **A height, so it is not a pane**

도크는 그 토큰 대신 `h-pane`(320)·`h-pane-lg`(640)를 든다. `--spacing-pane` 계열은
같은 파일이 「Panes are a third dimension: a secondary **column** is wider than any
rhythm step」이라고 정의한 **가로** 축이고, 각 값의 뜻도 폭이다(`pane` = thread
panel·command list, `pane-lg` = agent card measure). 정본 §6-3이 그 빌려 쓰기를
금지하고, 바로 아래 `--spacing-preview-frame` 주석은 **그 금지가 생긴 사고**를
이름 대어 적어 둔다 — 앞 판이 `--spacing-action`(버튼 최소 **폭**)을 높이로 빌려 썼다.

숫자 320이 우연히 같으니 결과가 같아 보이지만 같지 않다: 도크의 320에는 탭 바(36) +
관전 헤더·안내문·권한 토글·상태줄(~146)이 먼저 들어가고 터미널에는 138px, 즉 9줄만
남는다. 그래서 이 표면의 두 상태는 **「읽기에 너무 짧은 터미널」과 「채널을 못 쓰게
만드는 확대」**뿐이다(B-1). 축을 바로잡으면 두 결함이 같은 자리에서 함께 풀린다 —
도크의 높이는 「터미널 몇 줄 + 크롬」에서 나와야 하고, 그 계산의 정본은 이미 있다.

---

### [High] H-3 — 도크가 브라우저 기본 파란 포커스 링을 그린다 (두 스킴 모두)

`<section tabIndex={-1}>`이 마운트에서 자기를 포커스한다. 직전 입력이 키보드였으면
Chrome이 `:focus-visible`을 맞추고 UA 링을 칠한다. 실측:

```
[light] dock ring after keyboard reopen: {"focusVisible":true,"style":"auto","color":"rgb(0, 95, 204)","width":"1px","offset":"0px"}
[dark]  dock ring after keyboard reopen: {"focusVisible":true,"style":"auto","color":"rgb(153, 200, 255)","width":"1px","offset":"0px"}
```

집의 링은 `focus-visible:focus-ring` = `outline: 2px solid var(--accent)` +
`outline-offset: -2px`이고, **같은 도크 안의 버튼들에서 실제로 그렇게 잰다**
(`rgb(165, 76, 8)`, 2px). 즉 한 상자 안에서 포커스 표시가 두 문법으로 갈린다.

이건 추론이 아니라 **이 PR이 스스로 찍은 사진에 들어 있다**:
`clients/web/artifacts/design/terminal-dock-empty-light.png`의 도크 테두리 픽셀이
`rgb(0, 95, 204)`다(캡처 레인이 Esc를 눌렀다 다시 열기 때문에 키보드 분기로 들어간다).
`shots/07-ua-focus-ring-light.png` · `shots/08-ua-focus-ring-dark.png` · `shots/11-capture-empty-light.png`

여명 팔레트에 파랑은 없다. 다크에서 나오는 `rgb(153,200,255)`는 이 시스템이 표면에서
금지한 바로 그 색 가족이다.

**공정하게 적는다.** ①`AdeDrawer`·`AgentWorkPanel`도 같은 방식으로 자기를 포커스하고
링 억제를 안 하므로 이 패턴은 TC-1이 만든 것이 아니다. ②정본 §5.3이 「포커스 링의
**성질**」을 무검사 축으로 이름 대어 적어 두었다 — 프리플라이트 `naked_focus`는 링이
**있는지**만 본다. 그러니 「게이트가 잡았어야 했는데 안 잡았다」는 여기서 틀린 문장이다.
그럼에도 High인 이유는 이 PR이 그 링을 앱에서 가장 넓은 새 표면에, 기본 진입
동선에 올려놨기 때문이다.

---

### [High] H-4 — WorkPanel의 유일한 제품 진입점이 66×18px 흐린 글자이고, 가리키는 곳이 이름과 다르다

`WorkConsoleRoute` 머리에 새로 선 `채널에서 보기` 링크. 실측(세 폭 모두 동일):

```
[console link 1280x800] {"href":"#/c/00000000-…-201?work-panel=1","text":"채널에서 보기","w":66,"h":18}
[console link  900x800] { … 동일 … }
[console link  390x844] { … 동일, top 113 … }
```

세 가지가 겹친다.

1. **목적지가 이름과 다를 수 있다.** `panelChannelId = selected?.channelId ?? channels[0]?.id`이고,
   `selected`는 주소에 `?session=`이 있을 때만 채워진다(`WorkConsoleRoute.tsx:222`).
   즉 **콘솔에 그냥 들어온 기본 상태에서 이 링크는 명부의 첫 채널**(채널+DM 합친 배열의 0번)로
   간다. 같은 화면 오른쪽은 그때 「확인할 세션을 선택하세요」라고 말하고 있다 —
   아무것도 안 골랐다고 말하면서 「그 채널에서 보기」를 내미는 화면이다.
   §5.3 16위(화면이 거짓을 말함). `shots/09-work-console-entry-link.png`
2. **어포던스가 옆의 숫자보다 약하다.** `text-meta text-ink-muted`로, 비대화형 카운터
   「2개」와 같은 크기·같은 색·같은 기준선에 서 있다. 표면 하나로 가는 유일한 문이
   목록의 어느 행보다도 눌러 보이지 않는다.
3. **터치 타깃 18px.** `--touch-target`(24, 본문 링크용)에도 못 미치고
   `--tap-target`(44)은 한참 아래다. 390 폭에서도 18px 그대로다.

그리고 동선 자체가 한 칸 늘었다: **채널 안에서 그 채널의 WorkPanel로 가는 길이 없다.**
`/work`로 나갔다가 돌아와야 하고, 세션을 고르지 않았으면 돌아오는 곳이 다른 채널이다.
게이트가 이 함정을 못 보는 이유도 적어 둔다 — `gate-work-panel` 픽스처의 채널은 1개라
`openWorkPanelViaConsole`가 «틀린 채널» 갈래를 영원히 안 밟는다.

---

### [Medium] M-1 — 도크 안에서 터치 정책이 둘로 갈린다 (닫기 28px, 탭 44px)

390×844 터치 프로파일 실측:

| 컨트롤 | 크기 | 근거 |
|---|---|---|
| `terminal-dock-tab` | 192×**44** | `tokens.css:1837` 전역 규칙 `[role="tablist"] [role="tab"]` |
| `terminal-dock-expand` | 28×28 | 아무 규칙에도 안 걸림 |
| `terminal-dock-close` | 28×28 | 동 |

한 머리줄 안에서 왼쪽은 44, 오른쪽 둘은 28이다. 그리고 **닫기는 이 표면에서
빠져나오는 유일한 손가락 경로**인데(B-1/H-1의 상태에서는 유일한 탈출구다) 가장 작다.
답은 옆에 있다: `ThreadPanel.tsx:116`의 닫기 버튼이 `tap-target`(600px 미만에서 44)을
달고 있고, 전역 규칙에는 `[data-mobile-tap="primary"]` 문도 열려 있다.

부수로 하나 더 — 이 PR이 폰 프레임에서 `assertTapTargets`를 부르지만, 그 헬퍼는
**허용목록**(`MOBILE_TAP_TARGETS`)이고 거기에 도크 컨트롤이 하나도 없다. 그 호출은
도크에 대해 아무것도 재지 않았다(§5.5② 허용목록 ≠ 잔량).

---

### [Medium] M-2 — `data-scroll-x` 선언이 아무것도 면제하지 않는다

`ObserverTerminal.tsx`가 xterm 마운트 상자에 `data-scroll-x`를 달고 주석이
「xterm's viewport is a declared horizontal scroller … The harness skips boxes that
say so」라고 적는다. 하네스는 그렇게 동작하지 않는다
(`capture-screens.mjs:2074`): **자기 `overflow-x`가 `auto|scroll`인 상자만** 후보에
넣고, 그중 속성을 가진 것을 건너뛴다. 이 상자의 클래스는 `overflow-hidden`이라
애초에 후보가 아니고, 실제로 스크롤할 수 있는 것은 xterm 내부 `.xterm-viewport`인데
거기엔 속성이 없다.

지금은 캡처가 관전 스트림을 시작하지 않아 xterm이 마운트조차 되지 않으므로 아무 일도
일어나지 않는다. 남는 것은 ①리뷰가 「측정된 면제」로 읽는 거짓 선언과 ②나중에 이
상자에 `overflow-x:auto`가 붙는 날 조용히 면제된다는 구멍이다. §5.5②가 면제를
게이트가 아니라 컴포넌트에 선언하게 만든 이유가 바로 그 선언이 **리뷰에 보이기**
위해서인데, 보이는 문장이 참이 아니면 그 장치가 반대로 돈다.

(탭 스트립의 `data-scroll-x`는 정확하다 — 그 상자는 진짜 `overflow-x:auto`이고
캡처가 「스크롤 상자 누수 0」을 인쇄한다.)

---

### [Medium] M-3 — `gate-my-sessions`가 유일한 «같은 마운트에서 닫았다 다시 열기»를 잃었다

```diff
-  await page.getByTestId("open-work-panel").click();
+  await page.goto(`${origin}/#/c/${channelId}?work-panel=1`, { waitUntil: "domcontentloaded" });
```

뒤따르는 단정(범위 칩 줄임 우선순위 · 호스트 진실 도착 전 행 0)은 살아 있다.
`hostDelayMs: 1200`은 요청마다 걸리고 세션 응답은 즉시라, 새로고침 뒤에도 그 축은
여전히 잰다 — 그래서 **완화가 아니다.**

없어진 것은 「리마운트 없이 다시 여는 동작」 자체다. 그 동작은 `ChatShell.tsx:245~250`
주석이 이유를 적어 둔 상태 끌어올리기의 대상이다 — *"held locally, the chosen range
and the session being read were thrown away on every close"*. 게이트 이름이
**continuity**인데, 그 continuity를 재던 유일한 시퀀스가 전체 새로고침으로 바뀌었고
같은 축을 재는 다른 레인을 못 찾았다. 파일 전체로는 +2 단정이므로 순증이지만,
교환해서 내준 반쪽은 지금 아무도 안 잰다.

---

### [Medium] M-4 — 탭 스트립이 세션을 감추면서 감췄다는 신호를 안 준다

실측(세션 6개):

| 폭 | scrollWidth / clientWidth | 보이는 탭 |
|---|---|---|
| 1280 | 1149 / 960 | **4 / 6** |
| 900 | 1149 / 580 | **2 / 6** |

가로 스크롤은 선언돼 있어 하네스 관점에선 정당하다. 문제는 사람 쪽이다: 개수 표시도,
셰브론도, `scrollbar-visible`(이 레포에 이미 있는 유틸, `ArtifactCard`가 쓴다)도 없고
macOS 오버레이 스크롤바는 정지 상태에서 보이지 않는다. 키보드는 ←/→로 전부 닿지만
포인터 사용자에게는 **나머지 세션이 존재한다는 신호가 화면에 하나도 없다.**
`shots/10-tabstrip-6-sessions-1280.png`

---

### [Nitpick] N-1 — 확대 버튼이 `aria-pressed`와 «바뀌는 이름»을 동시에 든다
`aria-label`이 「패널 크게 보기」↔「패널 작게 보기」로 바뀌면서 `aria-pressed`도 뒤집힌다.
스크린리더는 「패널 작게 보기, 눌림」을 읽는다. 상태를 이름으로 말하거나 `aria-pressed`로
말하거나 둘 중 하나다.

### [Nitpick] N-2 — 한 상자에 이름이 셋이다
헤더 토글·도크 라벨은 「터미널」, 그 안의 두 컨트롤은 「**패널** 크게/작게 보기」
(WorkPanel의 「패널 넓게 보기」에서 빌려 온 낱말), 안쪽 제목은 「터미널 관전」.
도크는 패널이 아니라고 코드 주석이 애써 구분해 둔 그 낱말이다.

### [Nitpick] N-3 — 제목 층위가 h1 → h3으로 건너뛴다
채널 `h1` 아래 도크는 제목 없는 `section`이고 `ObserverTerminal`이 `headingLevel={3}`으로
`h3`을 낸다. 사이 `h2`가 없다.

### [Nitpick] N-4 — 「이미 불러 온 세션」 → 「불러온」
오프라인 배너 문장의 띄어쓰기.

### [Nitpick] N-5 — 탭 라벨이 192px에서 잘리는데 전체를 볼 길이 없다
`max-w-pane-sm` + `truncate`, `title` 없음. 접두사가 같은 한국어 라벨 여럿이면 화면상
구분이 사라진다(예: 「relay outbox_drain 재시…」 둘). WorkPanel도 `title`을 안 달지만
그쪽 행은 320px이라 잘리는 지점이 다르다.

### [Nitpick] N-6 — 죽은 항
`wide`를 이미 `true`로 넘기므로 `paneAtFullWidth`의 `|| variant === "dock"`는 항상 잉여다.
(대신 확인한 것: 그 결과로 「패널 넓게 보기」 버튼이 도크에서 렌더되지 않으므로
`onWideChange` 빈 함수는 **죽은 컨트롤이 아니다.** 이 축은 통과.)

---

## 4. 루브릭 페이즈별 결과

| # | 페이즈 | 결과 |
|---|---|---|
| 0 | Prep | ✅ 빌드 + `capture:design` 두 스킴 완주, 5상태 신규 12장 + 폰 2장 |
| 1 | Interaction | ⚠️ 열기·탭 전환·확대·닫기·Esc·포커스 복귀·⌘K 공존 모두 실동작 확인. **확대가 B-1** |
| 2 | Viewport | ❌ **B-1 / H-1** — 1280×720·390×844·760×480에서 무너진다 |
| 3 | Visual polish | ⚠️ 색·간격·반경·타이포 토큰 위반 0(프리플라이트 12/12), 그러나 **H-2 축 빌려 쓰기**와 **H-3 비토큰 파란 링** |
| 4 | Accessibility | ⚠️ 키보드 경로·roving tabindex·aria 바인딩 양호. **H-3(링) · M-1(28px) · N-1/N-3** |
| 5 | Robustness | ✅ 5상태 + 한국어/영어 혼합 픽스처 + 6세션 밀집 + 오프라인 전환 확인 |
| 6 | Code health | ✅ 매직 넘버 0, 프리미티브 재사용(`EmptyInvite`/`InlineBanner`/`SkeletonRows`/`Button`), 프리플라이트 PASS. 폰 프리플라이트는 **존재하지 않음**(위 §0) |
| 7 | Copy | ✅ em-dash 0 · 과장어 0 · 동사 먼저 · 내부 어휘 노출 0. **N-2/N-4**만 |

---

## 5. 구현자에게 (방향만)

1. **B-1/H-1/H-2는 한 뿌리다.** 도크 높이가 가로 축 토큰에서 오는 한 세로에 바닥이
   설 자리가 없다. 세로 축의 정본(`--spacing-terminal-body`, 「22줄」)에서 높이를
   세우고, `route-region`/`chat-region`이 가로에서 한 일을 세로에도 해 주는 쪽으로
   가면 셋이 함께 닫힌다. 숫자는 구현자가 잰다.
2. **캡처 단정 한 줄을 고쳐야 다음에 같은 일이 안 난다.** `assertDockAboveComposer`가
   「도크 아랫변 ≤ 컴포저 윗변」만이 아니라 **컴포저 아랫변 ≤ 뷰포트**와
   **타임라인 높이 > 0**을 함께 재야 이 회전의 결함이 게이트로 내려온다. 800px 한
   높이만 찍는 것도 이 축에서는 부족하다(720이 무너진다).
3. **H-4는 코드 두 줄이 아니라 결정이다.** 채널 안에서 그 채널의 WorkPanel로 가는
   길을 남길 것인지, 아니면 「작업 콘솔에서만」으로 확정하고 그 문을 컨트롤답게
   그릴 것인지. 후자라면 최소한 세션 미선택 상태에서 링크가 임의 채널을 가리키지
   않아야 한다.
4. 게이트 재배선 자체는 잘 됐다. **1.1의 발견(#1756이 `gate-shell-layout`을 빨간
   채로 랜딩시켰다)은 이 PR의 공이므로 PR 본문에 남기면 좋겠다** — 다음 사람이
   「TC-1이 셀렉터를 자기 편의로 바꿨다」로 읽지 않게.

---

## 6. 재현 방법

```sh
cd /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/tc1-terminal
bash scripts/design_preflight_web.sh
cd clients/web && npm run build && npm run capture:design
for g in gate:csp gate:shell gate:work-panel gate:my-sessions gate:typing gate:composer; do npm run $g; done
node gates/capture-session-chips.mjs
npx tsc -b && npx vitest run
```

기하·포커스 실측은 `scripts/capture-screens.mjs`의 목 하네스를 /tmp에 복사해
뷰포트만 바꿔 돌린 스크래치 프로브로 얻었다(레포 파일은 하나도 수정하지 않았다).
원시 출력은 `logs/probe-geometry.log`.
