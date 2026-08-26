# Design Review R4 (최종 확인) — 채널 하단 관전 터미널 도크 (PR #1766 / #1758 / TC-1)

- 대상: `feat/1758-tc1-terminal` @ **`a84de402`**
- 범위: `git diff a4c4bb88..HEAD` — 7파일 / +54 −20
- 앞선 판정: `REPORT.md`(R1 FAIL·Blocker 1) · `REPORT-R2.md`(R2 PASS·High 2) · `REPORT-R3.md`(R3 PASS·High 1)
- 증거: `shots-r4/` 13장 · `logs-r4/` 5건. 수치는 전부 이 워크트리를 다시 빌드해 **내가 직접 잰 것**이다.

```
[Blocker] 0
[High]    0
[Medium]  1   (R3-M1 이월 — 이 커밋의 범위가 아니었다)
[Nitpick] 4
Verdict: PASS (blockers: 0)
```

**ADR-0133 웹 목표(Blocker 0 · High 0)를 이 회전에서 처음 충족한다.**

---

## 0. 기계 검사 — 전부 독립 재실행

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS — web 12/12 + core 5/5** |
| `npm run build` · `npm run capture:design` | rc=0 · **rc=0** |
| `npx tsc -b` | rc=0 |
| `npx vitest run` | **1585 passed** |
| 게이트 7종(csp·shell·work-panel·my-sessions·typing·composer·session-chips) | **전부 rc=0** (`logs-r4/gates-summary.log`) |

폰(`clients/mobile`)에는 기계 프리플라이트가 없고 이 PR은 폰 파일을 0개 건드렸다. 아래
「폰」 수치는 웹을 터치 프로파일로 렌더한 것이지 RN 클라가 아니다.

---

## ① R3-H1(폰 폭 0줄 터미널) — **해소**

판정이 `collapsedMax < chrome상수(200) + floor` 에서 **터미널 상자 실높이 < `--spacing-terminal-floor`(56)**
로 바뀌었고, 상수 `--spacing-terminal-dock-chrome` 는 삭제됐다(`cn.ts` `NAMED_MEASURES` 도 함께).
R3에서 내가 결함을 잰 지점을 그대로 다시 쟀다(`logs-r4/probe-fold-and-expand.log`):

| 창 | R3 | **R4** | 접힘 문장 | 터미널 상자 | 잘린 글자 |
|---|---|---|---|---|---|
| **390×536** | 0px / 0줄 | **접힘** | ✅ | 비렌더 | 0 |
| **390×560** | 0px / 0줄 (상태줄 10px 절단) | **접힘** | ✅ | 비렌더 | **0** |
| **390×600** | 20px / 1줄 | **접힘** | ✅ | 비렌더 | 0 |
| **320×560** | 0px / 0줄 | **접힘** | ✅ | 비렌더 | 0 |
| 390×640 | 56px / 4줄 | 56px / **4줄** | — | 렌더 | 0 |
| 390×700 | 112px / 8줄 | 112px / 7줄 | — | 렌더 | 0 |
| 390×844 | 244px / 17줄 | 244px / **17줄** | — | 렌더 | 0 |
| 844×390 (가로 폰) | 접힘 | 접힘 | ✅ | 비렌더 | 0 |
| 760×480 | 접힘 | 접힘 | ✅ | 비렌더 | 0 |
| 1280×536 | 74px / 5줄 | 74px / **5줄** | — | 렌더 | 0 |

접힌 화면에서 실제로 확인한 것: `observerPresent:false` · `observerStart:false` (관전 시작·권한
토글·안내문·상태줄이 전부 비렌더), `shortNotice` = 「창이 낮아 터미널을 접었습니다. 창을
높이면 펼쳐집니다.」, 탭 2개와 닫기는 그대로 보이고, **R3에서 반 토막 났던 상태줄 글자는
아예 사라졌다(clippedText 0)**. 도크가 200→88px로 줄어 타임라인이 80→199px로 돌아왔다.
`shots-r4/r4-390x560.png`

경계도 옳다: 390×640에서 상자가 **정확히 56px = 바닥 4줄**이고 접히지 않는다. 폭이 달라도
같은 자로 잰다 — 1280×536은 5줄이라 접히지 않고 390×600은 0줄이라 접힌다. 폭 의존성이
판정에서 빠졌다는 것이 이 수리의 요점이고, 실측이 그것을 보인다.

**새 접근의 위험(접혔다 펼쳐 다시 재는 동안의 깜빡임)도 쟀다.** 밴드 안에서 10번 연속
리사이즈(552→545→540→536→544→552→560→556→548→540)하며 `data-short` 변화와 터미널 상자의
마운트를 MutationObserver로 감시했다:

```
[fold transient] 리사이즈 10회 · 상태 변화 10건 · 관측 시점마다 box=false
                 최종 {"short":true,"box":false,"notice":true} · 콘솔오류 0건
```

재측정용 펼침이 **페인트 전에 끝나 상자가 한 프레임도 서지 않았고**, 최종 상태는 안정적이며
ResizeObserver 루프 경고를 포함해 콘솔 오류가 0이다.

**자도 따라왔다.** `assertDockExpandHonesty` 의 케이스 표에 **390×560** 이 들어갔고(R3-N2 종결),
관전 대상이 없는 장면은 `hasObserver` 로 건너뛴다(빈 도크에는 접을 터미널이 없으므로 옳다).
캡처가 두 스킴에서 그 칸을 인쇄한다:

```
dock expand terminal dock sessions light @760×480: 접힘 문장 · 확대 disabled · 도크 72px
dock expand terminal dock sessions light @390×560: 접힘 문장 · 확대 disabled · 도크 88px
dock expand terminal dock sessions dark  @390×560: 접힘 문장 · 확대 disabled · 도크 88px
```

## ② 데스크탑 접힘·확대·disabled — **무회귀**

| 창 | 접힘 도크/줄 | 확대 도크/줄 | Δ | `aria-pressed` | 컴포저 ⊂ 뷰포트 | 타임라인 |
|---|---|---|---|---|---|---|
| 1280×720 | 440 / 18 | 459 / 19 | **+19px / +1줄** | false→true | ✅ | 94→80 |
| 1280×800 | 504 / **23** | 539 / 25 | +35 / +2 | false→true | ✅ | 110→80 |
| 1280×844 | 504 / **23** | 583 / 28 | +79 / +5 | false→true | ✅ | 154→80 |
| 1280×1200 | 504 / **23** | 934 / **53** | +430 / **+30** | false→true | ✅ | 510→80 |
| 1280×560 | 280 / 7 | 299 / 8 | +19 / +1 | false→true | ✅ | 94→80 |
| 390×844 | 492 / 17 | — | disabled | **false**, `data-expanded` 없음 | ✅ | 80 |

R2/R3에서 잰 값과 **한 픽셀도 다르지 않다.** 22줄 기본(1280×800·844·1200에서 23줄),
양보 순서(터미널 → 타임라인 띠 → 컴포저), 확대 Δ>0 불변식, 이득 0에서의 정직한 `disabled`,
컴포저·입력·전송 ⊂ 뷰포트, `docScroll` 0 — 전부 그대로다.

빈 상태도 확인했다: 760×480 빈 도크는 `short:false`(접을 터미널이 없다) · 도크 200px ·
빈 초대 문구 그대로 · 잘린 글자 0 · 컴포저 뷰포트 안. 접힘 문장을 빈 상태에 내밀지 않는
것이 맞다.

## ③ 회귀 — 계약·XOR·게이트 강도

- **정직 축소**: stdin/`onData`/`Plus` 부재 단정 유지 + 신규 4건(`work-observer-terminal`
  실측 사용 · `spacing-terminal-floor` 참조 · `terminal-dock-chrome` 부재 · `chrome + floor`
  문구 부재). vitest 1585 통과.
- **XOR·컴포저 형제·Esc/포커스 복귀·⌘K 공존**: 이 커밋이 건드리지 않았고 게이트 7종 초록.
- **게이트 강도**: 단정 삭제·완화 0. 자에 폰 폭 칸이 늘었다(순증).
- **§5.5① 준수**: 「실측을 베낀 상수」가 제거되고 그 자리를 실측이 대신했다. 토큰 주석과
  `references/tokens.md` 가 그 이유(「크롬은 폭에 따라 달라지므로 상수로 대조하지 않는다」)를
  함께 적었다. 이 문서가 R3에서 인용한 규율이 그대로 집행된 모양이다.

---

## 남은 판정

### [Medium] R3-M1 (이월) — 비활성 확대 버튼의 «이유»가 아무에게도 닿지 않는다

R4는 이 축을 건드리지 않았고, 재실측도 R3과 같다. 390×640 · 390×700 · 390×844에서
`disabled: true` · `title: "타임라인이 이미 최소입니다"` · `pointer-events: none` ·
`opacity: 0.5`.

- `disabled:pointer-events-none` 이라 hover가 없고 → **툴팁이 절대 뜨지 않는다.**
- `disabled` 라 탭 순서에서 빠져 키보드·스크린리더도 못 닿는다. `aria-describedby` 도 없다.

거절이라는 결정은 옳다(그래서 High가 아니다). 없는 것은 그 결정을 사람에게 전달하는 경로이고,
답은 바로 옆 갈래에 있다 — `short` 일 때는 같은 종류의 문장을 `terminal-dock-short` 로
**본문에 인라인으로** 렌더한다.

### [Nitpick] R4-N1 — 접힘 재측정이 «기하 변화»에만 걸린다 (코드 판독, 렌더 관찰 아님)
`probedGeoRef` 가 `"vh×vw"` 로 키잉되므로, 접힌 채로 **기하는 그대로인데 크롬 높이만 줄어드는**
변화(예: 오프라인 배너가 사라짐, 안내문이 짧아짐)가 오면 다시 펼쳐 재지 않는다. 실패 방향이
보수적(더 적게 보여 준다)이고 다음 리사이즈에 회복되므로 무해하다.

### [Nitpick] R4-N2 — 가로 폰에서 「창을 높이면 펼쳐집니다」는 할 수 없는 일이다
844×390에서 `data-short` 가 참인 것을 다시 확인했다. 그 화면의 손잡이는 높이가 아니라 회전이다.
가로 축 형제 문장(`notice === "folded"`)도 같은 표현을 쓰므로 집안 관례와는 일치한다.

### [Nitpick] R4-N3 — `short ? … : <>…</>` 블록 들여쓰기가 원래 깊이 그대로다
기능·프리플라이트 영향 없음. 다음 diff가 넓어 보인다.

### [Nitpick] R4-N4 — `expandedRef.current = expanded` 가 렌더 중에 실행된다
멱등이라 무해하지만, 이 레포가 다른 자리에서 쓰는 문법은 effect다.

---

## 루브릭 페이즈 (R4)

| # | 페이즈 | 결과 |
|---|---|---|
| 0 | Prep | ✅ 빌드 + capture 두 스킴 rc=0, 폰 폭 접힘 칸 신규 |
| 1 | Interaction | ✅ 확대 Δ>0 / 정직한 disabled / 접힘 전환 무깜빡임 (이유 전달만 R3-M1) |
| 2 | Viewport | ✅ 390·320·760·844·1280 × 390~1200 높이 전부 컴포저 ⊂ 뷰포트 · 타임라인 ≥ 80 · 잘린 글자 0 |
| 3 | Visual polish | ✅ 세로 토큰 4종이 이름·근거를 갖고, 베낀 상수는 제거됨 |
| 4 | Accessibility | ⚠️ 링·44px·h2·roving tabindex 유지. **비활성 이유 미도달(R3-M1)** |
| 5 | Robustness | ✅ 5상태 · 두 스킴 · 짧은 창 · 가로 폰 · 리사이즈 스윕 · 콘솔 오류 0 |
| 6 | Code health | ✅ 상수 대신 실측, 게이트 순증, 단정 삭제 0 |
| 7 | Copy | ✅ 「창이 낮아 터미널을 접었습니다. 창을 높이면 펼쳐집니다.」 — 무슨 일이 있었고 다음에 무엇을 할지 |

---

## 결론

R1의 Blocker 1건과 R1~R3에서 나온 High 6건이 네 회전에 걸쳐 전부 닫혔고, 그 과정에서
**자가 결함보다 먼저 자라났다** — `assertDockAboveComposer`(컴포저 ⊂ 뷰포트 + 타임라인 띠,
세 높이) · `assertDockExpandHonesty`(확대 Δ·정직한 disabled·폰 폭 접힘) · `gate-csp` 의
`data-scroll-x` 실측 · `gate-my-sessions` 의 같은 마운트 재개방. 이 PR이 남기는 것은 도크
하나가 아니라 그 도크를 지키는 자 넷이다.

남은 [Medium] 하나는 후속 티켓으로 충분하다. 머지 관점에서 **Blocker 0 · High 0**.

## 재현

```sh
cd /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/tc1-terminal
bash scripts/design_preflight_web.sh
cd clients/web && npm run build && npm run capture:design
for g in gate:csp gate:shell gate:work-panel gate:my-sessions gate:typing gate:composer; do npm run $g; done
node gates/capture-session-chips.mjs && npx tsc -b && npx vitest run
```

접힘 문턱·확대 델타·깜빡임 관측은 `scripts/capture-screens.mjs` 의 목 하네스를 /tmp에 복사해
뷰포트만 바꿔 돌린 스크래치 프로브로 얻었다. 레포 파일은 하나도 수정하지 않았다.
