# Design Review R2 (표적 재검증) — 채널 하단 관전 터미널 도크 (PR #1766 / #1758 / TC-1)

- 대상: `feat/1758-tc1-terminal` @ **`a65e69ce`** (수리 1커밋, R1 판정은 `94ee4ba7` 기준)
- 범위: `git diff 94ee4ba7..HEAD` — 14파일 / +273 −57
- R1 리포트: 같은 폴더 `REPORT.md` (Blocker 1 · High 3 · Medium 4 · Nitpick 6 / FAIL)
- 증거: `shots-r2/` 22장 · `logs-r2/` 6건. 수치는 전부 이 워크트리를 다시 빌드해 **내가 직접 잰 것**이다.

```
[Blocker] 0     (R1의 1건 해소)
[High]    2     (모두 신규 — R1의 3건은 전부 해소)
[Medium]  0
[Nitpick] 5
Verdict: PASS (blockers: 0)
```

루브릭 기준으로는 통과(Blocker 0 · High ≤ 2)이나 **ADR-0133 웹 목표(Blocker 0 · High 0)에는
아직 못 미친다.** 두 High는 모두 이번 수리가 도입한 「양보」 규칙의 가장자리에서 나왔고,
둘 다 컴포저·타임라인 보호를 되돌리지 않고 닫을 수 있는 종류다.

---

## 0. 기계 검사 — 전부 독립 재실행

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS — web 12/12 + core 5/5** (`logs-r2/design_preflight_web.txt`) |
| `npm run build` | rc=0 |
| `npm run capture:design` (두 스킴 · 두 프로파일) | **rc=0** (`logs-r2/capture-dock-geometry.log`) |
| `npx tsc -b` | rc=0 |
| `npx vitest run` | **1584 passed** (`logs-r2/vitest-tail.log`) |
| `gate:csp` · `gate:shell` · `gate:work-panel` · `gate:my-sessions` · `gate:typing` · `gate:composer` · `capture-session-chips` | **7종 전부 rc=0** (`logs-r2/gates-summary.log`) |

폰(`clients/mobile`)에는 기계 프리플라이트가 없고 이 PR은 폰 파일을 0개 건드렸다 — 빈 칸이
「깨끗하게 돌았다」로 읽히지 않도록 문장으로 적는다.

---

## ① B-1 재검증 — **해소.** 세 크기 + 확대/접힘 모두 통과

`terminal-dock` / `terminal-dock-lg` 유틸이 `flex: 0 1 <기준선>` + `max-block-size:
calc(var(--app-viewport-height) - 280px)` + `min-block-size: 0` 으로 바뀌었고, 컴포저는
`shrink-0`, 타임라인은 `timeline-strip`(min 80) 바닥을 받는다. `--app-viewport-height` 는
`:root` 에 `100dvh` 로 실재하고 폰에서는 `viewportHeight.ts` 가 visualViewport 로 갱신한다
(확인함).

내 probe 실측 (`logs-r2/probe-geometry.log`, 문서 스크롤은 전 케이스 0):

| 창 | 상태 | 도크 | 타임라인(바닥 80) | 컴포저 | 입력·전송 ⊂ 뷰포트 |
|---|---|---|---|---|---|
| 1280×800 | 접힘 | 504 (190–694) | 110 | 694–800 | ✅ |
| 1280×800 | 확대 | 520 (174–694) | 94 | 694–800 | ✅ |
| **1280×720** | 접힘 | 440 (174–614) | 94 | 614–720 | ✅ |
| **1280×720** | **확대** | 440 (174–614) | 94 | 614–720 | ✅ |
| **390×844** (touch) | 접힘 | 492 (184–676) | 80 | 721–844 | ✅ |
| **390×844** (touch) | **확대** | 507 (169–676) | 80 | 721–844 | ✅ |
| 760×480 | 접힘/확대 | 200 (174–374) | 94 | 374–480 | ✅ |
| 1280×560 | 확대 | 280 (174–454) | 94 | 454–560 | ✅ |

R1에서 컴포저가 821px(창 720)까지 밀려나 입력창과 「보내기」가 통째로 화면 밖이던 세 케이스가
전부 창 안으로 들어왔다. **B-1 해소. H-1(접힘 상태에서 타임라인 0px)도 함께 해소** — 타임라인은
어느 크기에서도 80px 아래로 내려가지 않는다.

**자도 같이 고쳐졌다.** `assertDockAboveComposer` 가 「도크 아랫변 ≤ 컴포저 윗변」 한 줄에서
**720·800·844 세 높이에서 `컴포저·입력·전송 rect ⊂ 뷰포트` + `타임라인 ≥ 바닥`** 으로 넓어졌고,
캡처 로그가 그 수를 인쇄한다(발췌, `logs-r2/capture-dock-geometry.log`):

```
dock terminal dock sessions light @720: 도크 440px (174–614) · 타임라인 94px(바닥 80) · 컴포저 614–720 ⊂ 1280×720
dock terminal dock sessions light @800: 도크 520px (174–694) · 타임라인 94px(바닥 80) · 컴포저 694–800 ⊂ 1280×800
dock terminal dock light @720:          도크 362px (190–552) · 타임라인 80px(바닥 80) · 컴포저 597–720 ⊂ 390×720
```

R1이 지적한 「초록이 아무것도 증명하지 않던 자리」가 실제로 결함을 잡는 자로 바뀌었다.
이 자를 R1 코드에 대고 돌렸다면 빨갛다.

---

## ② 접힘·기본 상태 22줄 목표 — **설계 뷰포트에서는 달성, 그 아래에서는 아니다**

`--spacing-terminal-dock: 504` 의 근거(「320(22줄) + 실측 크롬 182」)를 실측으로 검산했다
(`logs-r2/probe-rows.log`, 1줄 = 14px):

| 창 | 접힘 도크 | 크롬 | 터미널 | 줄 | 22줄? |
|---|---|---|---|---|---|
| 1280×800 | 504 | **182** | 322 | **23** | ✅ |
| 1280×1200 | 504 | 182 | 322 | **23** | ✅ |
| 1280×720 | 440 | 182 | 258 | 18 | ✗ |
| 390×844 (touch) | 492 | **248** | 244 | 17 | ✗ |
| 760×480 | 200 | 200 | **0** | **0** | ✗ |

크롬이 정확히 182px로 나와 토큰 주석의 산술이 참임을 확인했다. 22줄은 **뷰포트 높이가
약 784px 이상일 때만** 성립한다(그 아래에서는 `max-block-size` 가 먼저 문다). 우선순위
자체는 옳다 — 컴포저 > 타임라인 띠 > 터미널 줄 수. 다만 그 사실이 토큰 주석에는 없고,
가장 아래 끝에서 나는 일이 아래 R2-H2다.

---

## ③ H-3(포커스 링) · H-4(진입점) 재검증 — **둘 다 해소**

**H-3.** `outline-none focus-visible:focus-ring` 이 붙었다. 키보드로 다시 연 직후 실측:

```
[light] dock ring: {"focusVisible":true,"style":"solid","color":"rgb(165, 76, 8)","width":"2px","offset":"-2px"}
[dark]  dock ring: {"focusVisible":true,"style":"solid","color":"rgb(240, 168, 80)","width":"2px","offset":"-2px"}
```

두 값은 `--accent: light-dark(#a54c08, #f0a850)` 그 자체다. R1의 브라우저 기본 파랑
(`rgb(0,95,204)` / `rgb(153,200,255)`)은 두 스킴 모두에서 사라졌다.
Esc 닫힘 뒤 여는 컨트롤로 포커스 복귀도 두 스킴 모두 `yes`.
`shots-r2/r2-ring-light.png` · `r2-ring-dark.png`

**H-4.** `panelChannelId` 가 `selected?.channelId ?? null` 로 좁혀졌고 링크가 `Button
variant="outline" size="sm" tap-target` 로 바뀌었다. 실측:

- 세션 미선택(콘솔 기본 도착): `open-work-panel` **DOM에 없음** — 거짓 문이 사라졌다.
  `shots-r2/r2-console-noselect.png`
- 세션 선택 후: `이 채널에서 작업 보기`, 129×**28**(데스크탑) / 129×**44**(390 터치),
  테두리 `rgb(132,129,125)` = `--line-strong`(§3.3 컨트롤 경계), 배경 투명.
  `shots-r2/r2-console-selected.png`
- 누르면 `#/c/…201` 로 착지하고 `work-panel` 이 열린다 — **고른 세션의 방이 맞다.**

`TerminalDock.test.ts` 가 `CONSOLE` 소스에 `channels[0]` 가 **없음**을 단정하므로 되돌아오면 빨갛다.
동사 먼저 + 지시대명사가 목적지를 가리키는 카피라 §7도 만족한다.

---

## ④ M-3 단정이 실제로 그 축을 재는가 — **잰다**

`gate-my-sessions.mjs` 에 들어온 시퀀스는 ①`work-scope-mine` 이 눌린 상태를 먼저 확인 →
②`work-panel-close` 로 닫고 detached 대기 → ③**`window.location.hash` 로 같은 마운트에서
재개방**(리마운트 없음) → ④`work-scope-mine` 의 `aria-pressed` 가 여전히 `true` 인지 단정.
이것이 정확히 R1이 「무보호로 남았다」고 적은 축(`ChatShell` 로 끌어올린 `workScope` 가
닫힘에 살아남는가)이고, `page.goto` 와 달리 트리를 버리지 않는다. `gate:my-sessions` rc=0.

---

## ⑤ 회귀 확인 — 관전 정직 축소 · XOR · 게이트 강도

- **정직 축소 유지.** `TerminalDock.test.ts` 의 stdin/`onData`/`Plus`/`createWorkSession`
  부재 단정 그대로 + 신규 단정 4개(`h-pane` 금지 · `terminal-dock` 사용 · 「터미널 크게 보기」 ·
  `headingLevel={2}`). 캡처는 매 장면 `terminal-dock-new` count 0 을 계속 단정한다. vitest 1584 통과.
- **XOR 유지.** `workOpen && … && !dockOpen`, 헤더가 `setWorkOpen(false)`, `?work-panel=1` 이
  `setDockOpen(false)` — 이 커밋이 건드리지 않았고 게이트 7종 그대로 초록.
- **게이트 강도.** 이번 커밋은 게이트를 **더 조였다**: `gate-my-sessions` +27줄(위 ④),
  `openWorkPanelViaConsole` 이 이제 **행을 먼저 고른 뒤 진짜 버튼을 누른다**(R1에서는 머리의
  링크를 바로 눌렀다), `capture-session-chips` 도 같은 순서로. 단정 삭제·완화 0.
- R1 §1의 결론(셀렉터 수리·눈금 이동이 무디게 한 것이 아님)은 이번 커밋으로 바뀌지 않았다.
- 카피·프리미티브·토큰: `--spacing-terminal-dock*` 4종이 **이름 + 근거 주석**으로 들어왔고
  (§6 절차), `cn.ts` 의 `NAMED_MEASURES` 와 웹 방언 `references/tokens.md` 가 함께 갱신됐다.
  `cn.test.ts` 가 정본 CSS를 읽어 그 목록을 검산하므로 사본이 거짓말하지 않는다(§5.5①). 좋다.

---

## 신규 판정

### [High] R2-H1 — 「터미널 크게 보기」가 이 레포가 실제로 재는 크기에서 아무 일도 하지 않는다

확대 전후 실측(`logs-r2/probe-rows.log`):

| 창 | 접힘 → 확대 | Δ높이 | Δ터미널 줄 |
|---|---|---|---|
| **1280×720** | 440 → 440 | **0px** | **0줄** |
| **760×480** | 200 → 200 | **0px** | 0줄 |
| 1280×800 | 504 → 520 | 16px | **1줄** |
| 390×844 | 492 → 507 | 15px | 1줄 |
| 1280×1200 | 504 → **800** | 296px | **21줄** ✅ |

산술은 단순하다: 확대가 무언가를 하려면 `vh − 280 > 504`, 즉 **vh > 784** 여야 하고,
`terminal-dock-lg` 의 기준선 800에 실제로 닿으려면 **vh ≥ 1080** 이 필요하다. 그래서
노트북 창(720)과 캡처 기본 창(800)에서 이 컨트롤은 0줄 또는 1줄을 준다.

문제는 그동안 **화면이 「커졌다」고 말한다**는 것이다: `aria-pressed="true"` 가 되고
`data-expanded` 가 붙는다. 720에서는 픽셀이 하나도 움직이지 않는데 보조기술은 「눌림」을
읽는다. 죽은 버튼(D6 1항)은 아니다 — 상태는 진짜고 큰 화면에서는 21줄을 준다 — 그러나
§5.3 16위(화면이 거짓을 말함)의 모양이다.

자도 이 축을 못 지킨다: 캡처의 확대 단정(`after <= before → throw`)은 **800에서만** 돌고
16px 차이로 통과한다. 720은 `assertDockAboveComposer` 가 들르지만 확대 델타는 거기서
다시 재지 않는다. 방향만 적는다 — 확대가 뷰포트에 대해 의미 있는 양을 벌지 못하는
높이에서는 그 컨트롤이 상태를 바꾸지 않거나(비활성/숨김), 확대의 정의를 「남은 열」이 아니라
「지금 창에서 가능한 최대」로 바꾸는 쪽. 숫자는 구현자가 잰다.

### [High] R2-H2 — 짧은 창에서 터미널 상자가 0줄이 되는데 표면은 계속 터미널이라고 말한다

760×480: 도크 200px, 크롬 200px → **터미널 상자 0px / 0줄** (접힘·확대 동일).
1280×560은 98px/7줄, 1280×720은 258px/18줄, 390×844는 244px/17줄.

양보 순서(터미널 → 타임라인 띠 → 컴포저)는 옳은 우선순위다. 문제는 **희생이 조용하다**는 것이다.
480px 창에서 도크는 「터미널 관전」 제목 · `읽기 전용` 칩 · `관전 권한 1` · `팀원 관전 허용`
토글 · `관전 시작` 버튼 · 「연결 없음 · 받은 출력 0줄」 상태줄을 전부 그리고, 그 사이에 있어야 할
터미널만 높이 0으로 사라진다. 관전하러 연 사람에게 이 화면은 「지금은 볼 수 없다」가 아니라
「곧 여기 나온다」로 읽힌다. `shots-r2/r2-rows-760x480-terminal-zero.png`

이 레포는 같은 종류의 정직을 **가로 축에서 이미 하고 있다** — 「이 폭에서는 N칼럼만 보입니다 …
창을 넓히면 접히지 않습니다」(`ObserverTerminal` 의 `notice === "folded"`). 세로 축에는 그
문장이 없다. 답이 같은 파일 안에 있는 §5.5 최다 패턴의 모양이다.

Blocker로 올리지 않은 이유: 컴포저·타임라인은 지켜지고, 닫기(44px)와 채널은 그대로 살아 있어
사용자가 빠져나올 수 있다. 그러나 「터미널을 열었는데 터미널이 없다」는 제품 문장으로는
R1 H-2의 마지막 잔여다.

덧: `--spacing-terminal-dock` 주석은 504를 「22줄 + 크롬」으로 소개하면서 **그 22줄이
vh 784 아래에서는 회수된다는 사실**을 적지 않는다. 다음 사람이 22줄을 보장으로 읽는다.

### [Nitpick] R2-N1 — M-2 수리는 자리를 바로잡았지만 여전히 아무 레인도 밟지 않는다

`data-scroll-x` 가 `overflow-hidden` 마운트에서 빠지고(`mountHasAttr:false` 실측)
`terminal.open()` 직후 `.xterm-viewport` 에 붙는다 — 하네스가 실제로 보는 상자가 맞다.
다만 **실행 증명이 없다**: 캡처 목에서는 관전 attach가 응답하지 않아 xterm이 마운트되지
않고(`xterm attached: NO` — 내가 시도해 확인), xterm을 실제로 붙이는 `gate-csp` 는
`assertNoHorizontalOverflow` 를 돌리지 않는다. 선언은 옳아졌고 검증은 아직 없다.

### [Nitpick] R2-N2 — `openWorkPanelViaConsole` 의 조용한 우회

콘솔에 행이 없으면 해시로 직접 이동하는 갈래가 생겼다. `gate-work-panel` 은
`workSessions: []` 를 답하므로 그 레인(과 `gate-shell-layout`)은 이제 **진짜 버튼을 누르지
않는다**. 문 자체는 `gate-my-sessions` 와 `capture-session-chips` 가 누르므로 커버리지는
남지만, 헬퍼가 조용히 다른 경로로 내려가는 모양은 「컨트롤이 깨져도 두 레인은 계속 초록」의
씨앗이다. 주석에 그 사실이 적혀 있는 것은 좋다.

### [Nitpick] R2-N3 — 새 탭 스트립 어포던스는 이 레포의 스크린샷에 영원히 안 나온다

`scrollbar-visible` 이 붙어 M-4가 닫혔는지 확인하려다 헤드리스에서 막대가 0px으로 나왔다.
대조 실험으로 원인을 갈랐다(같은 페이지에 합성 상자 두 개):

```
headless=true  {"withUtility":{"bar":0},"plain":{"bar":0},"ruleFound":true}
headless=false {"withUtility":{"bar":8},"plain":{"bar":0},"ruleFound":true}
```

즉 **유틸리티는 정상**이고 헤드리스 크로미움이 스크롤바를 숨긴다. 실제 브라우저에서 다시 재니
탭 스트립은 `offsetHeight 44 / clientHeight 36 / bar 8`, 탭은 28px 그대로 잘리지 않고 도크는
504 유지 — **M-4 해소 확정**(`shots-r2/r2-headed-tabstrip.png`). 6개 탭 전부 `title` 도 붙었다.
남는 사실 하나: 캡처 레인 전체가 헤드리스라 이 막대는 `artifacts/design/*.png` 에 절대 나타나지
않는다. 이 PR의 결함이 아니라 레인의 성질이므로, 그 부재를 결함으로 읽지 않도록 적어 둔다(§5.3 7위).

### [Nitpick] R2-N4 — `assertDockAboveComposer` 가 `--app-viewport-height` 를 인라인으로 남긴다

`finally` 가 원래 높이를 **px 문자열로 고정**해 놓는다. 값은 맞지만, 그 프레임의 나머지 단정은
그때부터 살아 있는 변수가 아니라 얼어붙은 값을 읽는다. 지금은 무해하다.

### [Nitpick] R2-N5 — `timeline-strip` 80px의 근거 문장과 화면이 조금 다르다

주석은 「메시지 한 행이 읽히는 최소 띠(아바타 32 + 패딩 12 + 본문 22 ≈ 66 → 80)」라고 적는데,
타임라인은 바닥에 붙어 있으므로 실제로 그 띠에 들어오는 것은 마지막 항목의 **아랫동강**이다 —
새 캡처의 94px 띠에는 언퍼얼 카드 꼬리와 잘린 반응 행이 들어 있다
(`shots-r2/r2-capture-sessions-light.png`). 공간은 보장되고 「한 행이 읽힌다」는 보장되지 않는다.

---

## 루브릭 페이즈 (R2)

| # | 페이즈 | 결과 |
|---|---|---|
| 0 | Prep | ✅ 빌드 + capture 두 스킴 rc=0, 신규 기하 로그 36줄 |
| 1 | Interaction | ⚠️ 열기·탭·닫기·Esc·포커스 복귀 정상. **확대가 R2-H1** |
| 2 | Viewport | ✅ 720·800·844 × 1280·390 + 760×480 + 1280×560 전부 컴포저 ⊂ 뷰포트, 타임라인 ≥ 80 |
| 3 | Visual polish | ✅ 세로 축 토큰이 이름과 근거를 갖고 들어옴, 프리플라이트 12/12 |
| 4 | Accessibility | ✅ 집의 포커스 링 두 스킴 · 닫기/확대 44 · h2 · roving tabindex. (R2-H1의 `aria-pressed` 문제만) |
| 5 | Robustness | ⚠️ 5상태·두 스킴·6세션·짧은 창 전부 확인. **480px에서 터미널 0줄(R2-H2)** |
| 6 | Code health | ✅ 토큰 4종 + 유틸 3종이 정본 파일에 근거와 함께, `cn.test.ts` 가 정본을 읽어 검산 |
| 7 | Copy | ✅ 「이 채널에서 작업 보기」 동사 먼저 · 「불러온」 수정 · 이름 하나로 통일 |

---

## 구현자에게 (방향만)

1. **R2-H1**: 확대가 벌 수 있는 양이 0인 높이에서 컨트롤이 「눌림」이라고 말하지 않게 하는 것.
   그리고 캡처의 확대 단정을 델타가 실제로 의미 있는 높이에서(또는 720에서도) 다시 재는 것.
2. **R2-H2**: 터미널 상자가 줄 수를 잃을 때 화면이 그것을 말하게 하는 것. 가로 축의
   `notice === "folded"` 가 이미 그 문법을 갖고 있다. 겸해서 `--spacing-terminal-dock`
   주석에 「22줄은 vh 784 이상에서만」을 한 줄 더하면 다음 사람이 오해하지 않는다.
3. 나머지 다섯은 후속 티켓으로 충분하다.

## 재현

```sh
cd /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/tc1-terminal
bash scripts/design_preflight_web.sh
cd clients/web && npm run build && npm run capture:design
for g in gate:csp gate:shell gate:work-panel gate:my-sessions gate:typing gate:composer; do npm run $g; done
node gates/capture-session-chips.mjs && npx tsc -b && npx vitest run
```

기하·줄 수·포커스·스크롤바 실측은 `scripts/capture-screens.mjs` 의 목 하네스를 /tmp에 복사해
뷰포트·헤드리스만 바꿔 돌린 스크래치 프로브로 얻었다. 레포 파일은 하나도 수정하지 않았다.
