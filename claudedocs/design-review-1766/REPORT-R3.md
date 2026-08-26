# Design Review R3 (최종 확인) — 채널 하단 관전 터미널 도크 (PR #1766 / #1758 / TC-1)

- 대상: `feat/1758-tc1-terminal` @ **`a4c4bb88`** (R2 판정은 `a65e69ce`, R1은 `94ee4ba7`)
- 범위: `git diff a65e69ce..HEAD` — 13파일 / +370 −63
- 앞선 판정: `REPORT.md`(R1, FAIL · Blocker 1) · `REPORT-R2.md`(R2, PASS · High 2)
- 증거: `shots-r3/` 17장 · `logs-r3/` 6건. 수치는 전부 이 워크트리를 다시 빌드해 **내가 직접 잰 것**이다.

```
[Blocker] 0
[High]    1     (신규 — R2의 2건은 데스크탑 폭에서 해소, 그중 하나가 폰 폭에 남았다)
[Medium]  1
[Nitpick] 4
Verdict: PASS (blockers: 0)
```

**High 0 기대에는 못 미친다.** R2-H1은 완전히 닫혔고 R2-H2는 **데스크탑 폭에서만** 닫혔다 —
같은 결함이 폰 폭(≤600px)의 짧은 창 띠에 그대로 살아 있고, 원인은 수리가 새로 들여온 상수
하나가 폭에 따라 달라지는 값을 한 번만 재어 베낀 것이다(§5.5①).

---

## 0. 기계 검사 — 전부 독립 재실행

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS — web 12/12 + core 5/5** (`logs-r3/design_preflight_web.txt`) |
| `npm run build` · `npm run capture:design` | rc=0 · **rc=0** |
| `npx tsc -b` | rc=0 |
| `npx vitest run` | **1585 passed** (R2 대비 +1) |
| 게이트 7종(csp·shell·work-panel·my-sessions·typing·composer·session-chips) | **전부 rc=0** (`logs-r3/gates-summary.log`) |

폰(`clients/mobile`)에는 기계 프리플라이트가 없고 이 PR은 폰 파일을 0개 건드렸다.
아래 「폰」 수치는 전부 **웹을 터치 프로파일로 렌더한 것**이지 RN 클라가 아니다.

---

## ① R2-H1(확대가 아무 일도 안 한다) — **해소**

확대 상한이 고정 reserve에서 풀리고(`terminal-dock-lg: flex 1 1 800px`, max 없음),
확대 중에는 `.chat-region:has([data-testid="terminal-dock"][data-expanded]) .timeline-strip`
이 타임라인을 최소 띠에 고정한다. 이득이 없으면 버튼이 `disabled` 가 된다.

실측(`logs-r3/probe-expand.log`, 1줄 = 14px):

| 창 | 접힘 → 확대 | Δ높이 | Δ줄 | `disabled` | `aria-pressed` | `data-expanded` |
|---|---|---|---|---|---|---|
| **1280×720** | 440 → 459 | **+19** | **+1** | no | false → **true** | 없음 → 있음 |
| 1280×800 | 504 → 539 | +35 | +2 | no | false → true | 〃 |
| 1280×844 | 504 → 583 | +79 | +5 | no | false → true | 〃 |
| 1280×1200 | 504 → **934** | +430 | **+30** | no | false → true | 〃 |
| 1280×560 | 280 → 299 | +19 | +1 | no | false → true | 〃 |
| **390×844** (touch) | — | — | — | **yes** | **false** | **없음** |
| 760×480 | — | — | — | yes(short) | false | 없음 |
| 844×390 (touch) | — | — | — | yes(short) | false | 없음 |

- **Δ = 0 인 자리가 하나도 없다.** R2에서 720·480이 0px이던 것이 사라졌다.
- **거짓 `aria-pressed` 0.** 비활성일 때 `aria-pressed="false"` 이고 `data-expanded` 도 안 붙는다.
  390×844는 타임라인이 이미 띠(80)라 벌 것이 진짜로 없고, 그때 화면은 「눌림」이라 말하지 않는다.
- 확대가 벌어 오는 양이 정확히 「그 순간 타임라인의 여유」와 같다 — 규칙이 값이 아니라
  관계로 적혀 있어 창 높이가 바뀌어도 산다(§6 폰 절의 그 규율과 같은 성질).
- **자도 같이 왔다.** 신규 `assertDockExpandHonesty` 가 720·800·844에서 Δ>0을,
  여유 0이면 `disabled` + `data-expanded` 부재를, 480에서 접힘 문장을 단정하고
  캡처가 수를 인쇄한다(`logs-r3/capture-dock-assertions.log`):

```
dock expand terminal dock sessions light @1280×720: 440 → 459 (Δ19)
dock expand terminal dock offline light @1280×720: 여유 0 · 확대 disabled · 도크 390px
dock expand terminal dock sessions light @760×480: 접힘 문장 · 확대 disabled · 도크 72px
```

오프라인 배너가 서면 여유가 0이 되어 같은 판에서 **비활성 갈래도 실제로 밟힌다** — 두 갈래가
모두 레인 안에 있다.

## ② R2-H2(0px 터미널) — **데스크탑 폭에서 해소, 폰 폭에서 미해소**

해소된 쪽부터. 760×480 · 844×390(가로 폰) 실측:

```
{"dataShort":true,"dockH":72,"shortNotice":"창이 낮아 터미널을 접었습니다. 창을 높이면 펼쳐집니다.",
 "observerPresent":false,"observerStart":false,"tabs":2,"closeVisible":true,
 "timeline":{"h":222},"composerInView":true,"docScroll":0}
```

터미널 상자·관전 시작·권한 토글·상태줄이 **렌더되지 않고** 한 문장만 남는다. 탭과 닫기는
살아 있어 무엇이 있었는지와 나가는 길이 보인다. 도크가 200→72로 줄어 타임라인이 94→222로
돌아왔다. 가로 축 `notice === "folded"` 와 같은 문법이고, 정확히 R2가 요청한 모양이다.

미해소는 아래 R3-H1.

## ③ 회귀 — 컴포저·양보 순서·22줄 전부 유지

- **컴포저 ⊂ 뷰포트**: 위 8개 창 × 접힘/확대 전부 `composerInView · inputInView · sendInView`
  모두 true, `docScroll` 0. 720·480·390·1200 어디서도 R1의 결함이 돌아오지 않았다.
- **양보 순서**(터미널 → 타임라인 띠 → 컴포저) 유지. 타임라인은 항상 ≥ 80이고 확대 중에만 정확히 80.
- **22줄 기본**: 1280×800 · 844 · 1200 접힘에서 터미널 322px = **23줄**, 크롬 정확히 182px.
  토큰 주석도 「22줄은 vh ≳ 784에서만」이라고 R2 지적대로 고쳐 적었다.
- **관전 정직 축소·XOR** 그대로: stdin/`onData`/`Plus` 부재 단정 유지, 캡처의
  `terminal-dock-new` count 0 유지, 게이트 7종 초록.
- **게이트 강도는 또 올라갔다**: `gate-csp` 가 `.xterm-viewport` 의 `data-scroll-x` 를
  **실측**하고(R2-N1 종결 — 이제 M-2가 실행 증명을 갖는다), `openWorkPanelViaConsole` 의
  해시 우회가 `allowHashFallback` 옵트인 + `console.warn` 이 됐다(R2-N2 종결).
  단정 삭제·완화 0.
- R2-N3(헤드리스 스크롤바)·N4(`unpinViewportHeight` 가 `removeProperty`)·N5(`timeline-strip`
  주석 정정)도 전부 반영됐다.

---

## 신규 판정

### [High] R3-H1 — 접힘 문턱이 «폭에 따라 달라지는 값»을 한 번만 재어 상수로 들고 있다. 폰 폭에서 0줄 터미널이 그대로 산다

문턱은 `collapsedMax < --spacing-terminal-dock-chrome(200) + --spacing-terminal-floor(56)`,
즉 `vh < 536` 에서만 접는다. 그런데 **크롬 높이는 폭에 따라 다르다** — 실측:

| 폭 | 실측 크롬 |
|---|---|
| 1280 | **182px** |
| 390 | **248px** (관전 안내문이 3줄로 접히고 제목이 2줄이 된다) |

토큰 주석은 `760×480 실측 크롬 200` 한 줄을 근거로 200을 적는다. 그래서 폭이 좁아지면
문턱이 실제 필요치를 48px 과소평가하고, 그 차이가 그대로 화면에 남는다
(`logs-r3/probe-floor.log`):

| 창 | `data-short` | 터미널 | 줄 |
|---|---|---|---|
| **390×536** | **false** | **0px** | **0** |
| **390×560** | **false** | **0px** | **0** |
| **320×560** | **false** | **0px** | **0** |
| **390×600** | false | 20px | **1** |
| 390×640 | false | 56px | 4 (바닥) ✅ |
| 1280×536 | false | 74px | 5 ✅ |

즉 **폰 폭에서는 vh 640 아래가 통째로 R2-H2 그대로다**: 「터미널 관전」 제목, `읽기 전용` ·
`관전 권한 1` 칩, `팀원 관전 허용` 토글, 세 줄짜리 안내문, `관전 시작` 버튼이 전부 렌더되고
그 아래 터미널 상자만 높이 0으로 그려진다. `shots-r3/r3-floor-390x560.png`

그리고 그 자리에서 **글자가 잘린다.** 390×560 실측: 상태줄
「연결 없음 · 받은 출력 0줄, 0바이트」의 숫자 노드가 `top 388 / bottom 402`, 도크 본문
아랫변은 392 — **10px 이 잘려 글자가 가로로 반 토막 난다.** 390×536 · 320×560 에서는 그
줄이 아예 통째로 잘려 사라진다.

**Blocker로 올리지 않은 이유를 적는다.** 루브릭 D6의 「지원 크기에서 잘린 사용자 글자」에
걸릴 만한 모양이지만, ①R1·R2가 세운 세 보호(컴포저 ⊂ 뷰포트 · 타임라인 띠 · 44px 닫기)는
이 창에서도 전부 살아 있고 ②이 레포가 선언한 폰 기본 프로파일은 390×844(그 높이에서는
17줄로 정상)이며 ③상태가 창 높이에 따라 즉시 회복된다. 다만 **375×667 기기의 Safari
가시 뷰포트는 약 375×553** 이라 실제 기기 한 종류가 이 띠에 통째로 들어간다 — 성재가
이것을 Blocker로 부르기로 하면 나는 반대하지 않는다.

수리의 방향은 이 커밋이 이미 절반 갖고 있다. 컴포넌트가 `ResizeObserver` 를 이미 달고 있으므로
크롬 높이는 **상수로 베낄 것이 아니라 그 자리에서 재면 된다**(도크 높이 − 터미널 상자 높이,
내가 이 리포트에서 쓴 그 계산이다). §5.5① 「모든 새 가드는 정본을 읽는다. 기대값을 베껴
적지 않는다」가 토큰에도 같은 무게로 적용된다.

부수: 새 자 `assertDockExpandHonesty` 도 이 띠를 못 본다 — 네 케이스가
`1280×{720,800,844}` 와 `760×480` 이고, **`captureMobile` 에서 불릴 때조차 뷰포트를
1280/760 으로 덮어쓴다.** 폰 폭 × 짧은 높이 칸이 자에 없다.

### [Medium] R3-M1 — 비활성 확대 버튼의 «이유»가 아무에게도 닿지 않는다

390×844 실측: `disabled`, `title="타임라인이 이미 최소입니다"`, `pointer-events: none`,
`opacity: 0.5`.

- `disabled:pointer-events-none` 이므로 **hover 가 발생하지 않고 → title 툴팁이 절대 안 뜬다.**
- `disabled` 라 탭 순서에서도 빠져 키보드·스크린리더도 그 문장에 못 닿는다.
- `aria-describedby` 도 없다.

그래서 폰 기본 화면에서 이 컨트롤은 「44×44 짜리, 반쯤 흐린, 눌러도 아무 일 없고, 왜인지
말하지 않는 아이콘」이다. 정직한 거절이라는 결정 자체는 옳다 — 없는 것은 그 결정을 사람에게
전달하는 경로다. 답은 바로 옆 갈래에 있다: `short` 일 때는 같은 종류의 문장을
`terminal-dock-short` 로 **본문에 인라인으로** 렌더한다.

### [Nitpick] R3-N1 — 가로 폰에서 「창을 높이면 펼쳐집니다」는 할 수 없는 일이다
844×390(가로 폰)에서 `data-short` 가 참이 되는 것을 실측했다. 그 화면에서 창 높이는
사용자가 가진 손잡이가 아니다(회전이다). 가로 축의 형제 문장도 같은 표현을 쓰므로
집안 관례와는 일치한다.

### [Nitpick] R3-N2 — 폰 레인이 폰 폭으로 재지 않는다
위 R3-H1 부수. `captureMobile` 안에서 불린 `assertDockExpandHonesty` 가 뷰포트를
1280/760으로 바꾼 뒤 되돌린다. 그 프레임들은 폰 컨텍스트지만 폰 폭이 아니다.

### [Nitpick] R3-N3 — 새 `short ? … : <>…</>` 블록의 들여쓰기가 원래 깊이 그대로다
기능·프리플라이트에는 영향 없다. 다음 diff가 넓어 보인다.

### [Nitpick] R3-N4 — `expandedRef.current = expanded` 가 렌더 중에 실행된다
멱등이라 지금은 무해하지만, 이 레포가 다른 자리에서 쓰는 문법은 effect다.

---

## 루브릭 페이즈 (R3)

| # | 페이즈 | 결과 |
|---|---|---|
| 0 | Prep | ✅ 빌드 + capture 두 스킴 rc=0, 확대·접힘 단정 로그 신규 |
| 1 | Interaction | ✅ 확대가 모든 활성 자리에서 실줄을 벌고, 벌 것 없으면 정직하게 거절 (이유 전달만 R3-M1) |
| 2 | Viewport | ⚠️ 컴포저·타임라인은 8개 창 전부 통과. **폰 폭 짧은 창에서 0줄 터미널 + 글자 잘림(R3-H1)** |
| 3 | Visual polish | ✅ 세로 토큰 5종이 이름과 근거를 갖고, `cn.test.ts` 가 정본을 읽어 검산 |
| 4 | Accessibility | ⚠️ 링·44px·h2·roving tabindex 유지. **비활성 이유 미도달(R3-M1)** |
| 5 | Robustness | ⚠️ 5상태·두 스킴·짧은 창·가로 폰 확인. R3-H1 띠만 남음 |
| 6 | Code health | ✅ 상수 대신 관계로 적힌 확대 규칙, 게이트 두 곳 강화, 단정 삭제 0 |
| 7 | Copy | ✅ 「창이 낮아 터미널을 접었습니다. 창을 높이면 펼쳐집니다.」 — 무슨 일이 있었고 다음에 무엇을 할지, 사과 없음 |

---

## 남은 두 가지 (방향만)

1. **R3-H1**: 크롬 높이를 상수로 들지 말 것. 도크는 이미 `ResizeObserver` 를 갖고 있고,
   「도크 높이 − 터미널 상자 높이」가 그 자리의 실제 크롬이다. 그리고 자의 케이스 표에
   폰 폭 × 짧은 높이 칸을 하나 넣으면 이 띠가 다시 열려도 빨갛다.
2. **R3-M1**: 거절의 이유를 `title` 이 아니라 사람이 닿는 자리에 둘 것. `short` 갈래가
   이미 그 문법을 갖고 있다.

## 재현

```sh
cd /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/tc1-terminal
bash scripts/design_preflight_web.sh
cd clients/web && npm run build && npm run capture:design
for g in gate:csp gate:shell gate:work-panel gate:my-sessions gate:typing gate:composer; do npm run $g; done
node gates/capture-session-chips.mjs && npx tsc -b && npx vitest run
```

확대 델타·줄 수·크롬 높이·글자 잘림은 `scripts/capture-screens.mjs` 의 목 하네스를 /tmp에
복사해 뷰포트만 바꿔 돌린 스크래치 프로브로 얻었다. 레포 파일은 하나도 수정하지 않았다.
