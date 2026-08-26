### Design Review R3 (표적 검증) — clients/web 컴포저 (feat/1749-uxcb-composer, PR #1751)

- 대상: 수리 커밋 `2aa0efc9` (기준 `c926b8c4` = R2 판정 시점)
- 범위: 팀리드가 지정한 ①~⑥만. R1·R2에서 닫힌 축은 ⑤ 회귀로만 다시 만졌다.
- 정본: `docs/design-system/README.md` · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `.claude/skills/momo-design-taste/references/review-rubric.md`

증거 (전부 이 세션이 `2aa0efc9`에서 새로 만든 것, `claudedocs/design-review-1751/`):
`r3-chat-{light,dark}.png` · `r3-composer-focus-{light,dark}.png` · `r3-composer-mention-light.png` ·
`r3-composer-offline-light.png` · `r3-composer-attachment-pending-light.png` ·
`r3-u4-{composer-emoji,thread-composer-parity}-light.png` · `r3-mobile-{chat,b11-thread}-light.png` ·
`r3-crop-{focus-light,focus-dark,offline-light,thread-empty-light}.png` ·
`r3-capture-design.log` · `r3-preflight-web.txt` · **`r3-gate-typing-PASS.log`** · `r3-gate-composer.log` ·
`r3-gate-shell-layout.log` · `r3-mention-trigger-probe.txt` · **`r3-ring-rule-probe.{mjs,txt}`**
대조군: `r1-gate-typing-PASS.log` · `r2-composer-focus-{light,dark}.png` · `r2-mobile-b11-thread-light.png`

---

## 0. 레인 (전부 이 세션이 직접 실행)

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | PASS — web 12/12 + core 5/5 |
| `npm run build` · `npx tsc -b` · `npm run lint` | PASS · PASS · PASS(0 error) |
| `npm test` (vitest) | PASS — 106 files / **1523** tests |
| `npm run capture:design` | PASS, 두 스킴 완주 |
| `node gates/gate-composer.mjs` | PASS |
| **`node gates/gate-typing.mjs`** | **GATE PASS (rc 0)** — R2의 빨강이 닫혔다 |
| `node gates/gate-shell-layout.mjs` | PASS |
| 폰 기계 프리플라이트 | **존재하지 않는다**(정본 §5.4). 이 PR은 폰 소스를 건드리지 않는다. |

---

## ① B-2 (`gate-typing` 빨강 + 그 뒤 단정 미실행) — **닫힘 ✅**

게이트가 끝까지 돌고 GATE PASS를 출력한다. R2에서 죽던 지점 뒤의 네 단정이 **실제로 실행되고 값을 뱉는다**
(`r3-gate-typing-PASS.log` 전문):

```
[fit]  320폭 · 원한 폭 311px / 있는 폭 82px · lead 넘침 229px · tail 넘침 0px · tail 오른끝 247 (본문 끝 247) · 높이 18px
[cut]  320폭에서 화면이 말하는 것: "김민서 … 작성 중…" (잘림 있음)
[a11y] 보조기술이 읽는 글자: "김민서 프로덕트디자인님, 이도현 플랫폼엔지니어링님이 작성 중"
[slot] 왼쪽 {"left":257,"right":361} · 작성 중 {"left":369,"right":1219} · 보내기 {"left":1227,"right":1259}
```

수리 방식도 옳다: 크기 0인 `aria-hidden` 요소에 `visible`을 묻는 대신 **부착 + `aria-hidden="true"` +
빈 텍스트 + `flex-grow:1` + 폭>0 + 높이=0**을 각각 단정한다(`gate-typing.mjs:820-849`). 「보인다」가 아니라
「새 설계 그대로인가」를 묻는 자로 바뀌었다.

덤으로 **R2 N-8도 닫혔다**: 느슨해졌던 `height <= 0`이 이름 붙은 상수
`ACTION_META_SLOT_HEIGHT_PX = 18`로 되돌아왔고(`:112`), 세 판(`기본 18px -> 작성 중 18px -> 18px`)이
그 값과 정확히 대조된다. 「0보다 크기만 하면 된다는 단정은 높이 축을 사실상 지워 버린다」는 주석까지
코드에 남겼다 — 리뷰가 지적한 축을 코드가 기억하게 만든 형태다.

## ② B-3 (스레드 비활성 전송이 원색) — **닫힘 ✅**

폰 390 스레드 빈 답글창의 전송 버튼 채움 최빈값 실측:

| | 채움 | 읽힘 |
|---|---|---|
| R1 (`0309db90`) | rgb(209,164,128) | 비활성 |
| R2 (`c926b8c4`, 결함) | **rgb(165,76,8)** | 활성으로 잘못 읽힘 |
| **R3 (`2aa0efc9`)** | **rgb(209,164,128)** | **비활성 ✅** |
| R3 채널 컴포저(빈 상태) | rgb(209,164,128) | 동형 ✅ |

사진: `r3-crop-thread-empty-light.png` vs `r2-crop-thread-empty-light.png`.
두 상태를 나눈 방식이 정확하다 — `sending ? "disabled:opacity-100" : "disabled:opacity-50"`
(`ThreadComposer.tsx:340-345`): 전송 중에는 그릇의 `opacity-50`이 상태를 지고(이중 감쇠 25% 방지),
「보낼 것이 없다」는 판에서는 버튼 자신이 채널과 같은 50%로 내려간다.

**`sending` 상태는 사진이 없다** — 어떤 캡처 레인도 스레드 전송 중 프레임을 찍지 않는다. 구성 규칙은
코드 판독으로 확인했고 `composerParity.test.ts:143-146`가 두 문자열(`sending && "opacity-50"`,
`sending ? … : …`)을 소스에서 못 박는다. 픽셀 주장은 하지 않는다.

## ③ H-1R (그릇 안 UA 포커스 링) — **닫힘 ✅**

`outline-none focus-visible:outline-none`이 두 컴포저의 textarea에 들어갔고(`Composer.tsx:910`,
`ThreadComposer.tsx:291`), 링은 그릇 하나가 진다.

컴포저 띠(하단 200 device px) 전수 픽셀 스캔 — 팔레트 밖 색 계수:

| 상태 × 스킴 | UA 파랑 `rgb(0,95,204)` / `rgb(153,200,255)` | 순백 `#ffffff` |
|---|---|---|
| R3 focus light · dark | **0** | **0** |
| R3 mention(포인터 클릭) light | **0** | **0** |
| R3 offline light | **0** | **0** |
| R3 첨부 pending light | **0** | **0** |
| R2 focus light (대조군) | 8,121 | 8,362 |
| R2 focus dark (대조군) | 8,121 | — |

세로 스택 실측: R2에서 파란 규칙이 있던 자리(device y 1490~1500)가 이제 `--surface-raised` 한 색으로
끊김 없이 이어지고, 그릇 위변은 라이트 `rgb(165,76,8)`·다크 `rgb(240,168,80)` 2 CSS px 하나뿐이며
바깥의 순백 헤일로도 없다.

사진 판정: `r3-crop-focus-light.png` · `r3-crop-focus-dark.png` — **상자가 하나로 보인다.**
두 스킴 모두 호박 링 하나가 textarea와 액션 행을 함께 감싸고, 그릇을 가르는 가로줄이 없다.

## ④ M-4 (링 단정이 UA 링에 눈멀었음) — **닫힘 ✅, 판별력까지 확인**

단정 축이 폭에서 **스타일**로 바뀌었다(`capture-screens.mjs:2166`·`:2242`).
그 규칙이 실제로 세 모양을 가르는지 같은 Chromium에서 직접 재현했다(`r3-ring-rule-probe.txt`):

```
#ua     focus-visible=true outlineStyle=auto   width=1px  color=rgb(0, 95, 204)  → 새 단정이 FAIL 시킨다(잡는다)
#inner  focus-visible=true outlineStyle=solid  width=2px  color=rgb(165, 76, 8)  → 새 단정이 FAIL 시킨다(잡는다)
#fixed  focus-visible=true outlineStyle=none   width=3px  color=rgb(0, 0, 0)     → 새 단정이 통과시킨다
```

R2에서 빠져나갔던 UA 링(`auto`)도, R1의 자체 2px 링(`solid`)도 잡고, 수리된 모양만 통과한다.
`#fixed`의 `outlineWidth`가 **3px으로 보고된다는 사실**이 옛 폭 기반 단정이 왜 틀린 축이었는지를
그대로 보여 준다 — 폭은 링의 유무를 말하지 않는다.

## ⑤ 회귀

| 항목 | 판정 | 근거 |
|---|---|---|
| B-1 `[@]` 문맥 5종 + 초안 복원·연타·선택 보존 | ✅ | HEAD 번들 재실행 **10/10 열림, 후보 5** (`r3-mention-trigger-probe.txt`) |
| H-2 그릇 클릭 → 캐럿 | ✅ | 채널·스레드 × light/dark **4판 전부** `액션 행 빈 폭 → 입력 캐럿 2` |
| N-5 죽은 띠 | ✅ | 그릇 위변 **707.0 CSS 불변**, 루트 구분선 **578.0 CSS**(R1 552.0) → 타임라인 +26 CSS px 유지 |
| 레이아웃 시프트 | ✅ | `[shift] 입력창 y 808 -> 808 · 전송 y 847 -> 847` |
| 이모지 앵커 | ✅ | 채널 xΔ **0px**/gap 4px · 스레드 xΔ −162px(충돌 회피 + 포함 단정) |
| 탭 순서 | ✅ | 5정거장, 두 스킴 |
| 오프라인 disabled 의미 | ✅ | 입력·[@]·이모지 열림 / 첨부·전송 잠김 (`r3-crop-offline-light.png`) |
| 그릇 테두리·인셋 | ✅ | `--line-strong` 계산색 대조 · `--spacing-3` 정본 인셋 |
| N-7 슬롯 정렬 | ✅ | `TypingLine`에 `justify-end` — 힌트와 작성 중이 같은 끝에 선다(문장이 양 끝을 오가지 않는다) |
| 한국어 잘림 규칙 | ✅ | `[fit] tail 넘침 0px · tail 오른끝 247 = 본문 끝 247` · `[cut]` 말줄임이 `lead` 조각에만 걸린다 |

---

## 발견 (R3)

### [Medium] M-5R. 「작성 중」의 폭 손실이 이제 **측정됐다** — 320폭에서 두 사람이 한 사람으로 읽힌다

R2에서 「미측정」으로 남겼던 축이 B-2 수리 덕에 숫자로 나왔다. 같은 게이트, 같은 320폭 픽스처:

| | 있는 폭 | lead 넘침 | 화면이 말하는 문장 |
|---|---|---|---|
| R1 (`0309db90`, 전폭 26px 행) | **272px** | 39px | `"김민서 프로덕트디자인님, 이도현 플랫폼엔지니… 작성 중…"` |
| **R3 (`2aa0efc9`, 액션 슬롯)** | **82px (−70%)** | **229px** | **`"김민서 … 작성 중…"`** |

- 무엇이 달라지나: 320폭에서 **두 번째 사람이 화면에서 통째로 사라진다.** 두 명이 치는 판과 한 명이
  치는 판이 같은 문장으로 보이므로, 이 줄이 나르던 「몇 명인가」가 좁은 폭에서 없어진다.
- 완화 요인 셋: ⓐ 보조기술은 온전한 문장을 그대로 받는다(`[a11y]` 실측). ⓑ 잘림의 **대상 선택**은
  설계대로다 — 동사·꼬리는 살고 이름만 줄며(`tail 넘침 0px`), 조사 고아도 없다. ⓒ 이 줄은 이 파일이
  스스로 「주변시로 흘려보내는 신호이고 사람을 식별하는 자리가 아니다」라고 적어 둔 축이다.
- 그래서 결함이 아니라 **거래**다: 26px 세로 띠를 없애 타임라인을 26px 얻은 대가로, 320폭에서 이 문장이
  190px을 잃었다. 성재가 지적한 것은 전자였고 이 PR은 그것을 이행했다. 다만 **거래가 이루어졌다는 사실이
  지금까지 어디에도 숫자로 적혀 있지 않다** — 후속에서 슬롯에 폭을 더 줄지(예: 좁은 폭에서 아이콘 군을
  접는다) 이대로 받을지는 제품 결정이고, 이 리포트의 표가 그 결정의 입력이다.
- 게이트가 초록인 것은 맞다: `[fit]`·`[cut]`은 **무엇이 잘리는가**를 재지 **얼마가 남는가**를 재지 않는다.
  정본 §5.3의 「한국어 텍스트 처리」가 사람 축으로 남아 있는 이유가 이것이다.

### [Nitpick] N-9. `naked_focus`가 이제 「억제 + 억제」 쌍으로 만족된다

`outline-none focus-visible:outline-none`은 프리플라이트 규칙(「`outline-none`에 `focus-visible:` 대체가
없으면 실패」)의 문자를 만족시키지만, 그 클래스 목록은 링을 **선언하지 않는다**. 즉 이 그렙은 이제
「링이 부모에 있다」와 「어디에도 링이 없다」를 구분하지 못한다.

실제로 뚫린 곳은 없다 — `composerParity.test.ts:137-142`이 두 입력에서 `focus-visible:focus-ring`의
**부재**와 억제 쌍의 **존재**를 함께 못 박고, 캡처 자가 같은 프레임에서 `frameOutlineWidth === "2px"`를
단정한다. 기제의 성질을 기록만 해 둔다(정본 §5.3 「포커스 링의 성질」 행에 붙는 각주).

---

Verdict: **PASS**

- Blocker **0** · High **0** · Medium 1 · Nitpick 1.
- R1~R3 누적 판정: Blocker 3건(B-1·B-2·B-3) 전부 닫힘 · High 2건(H-1/H-1R·H-2) 전부 닫힘 ·
  Medium 5건 중 4건 닫힘(M-1·M-2·M-3·M-4), M-5는 M-5R로 **측정된 채** 남음 ·
  Nitpick 8건 중 7건 닫힘(N-1·N-2·N-3·N-4·N-5·N-7·N-8), N-9 신규 기록.
- 루브릭 기준(Blocker 0, High ≤2)과 ADR-0133 웹 목표(Blocker 0, High 0) 모두 충족 — 사람 리뷰로 넘어갈 수 있다.
- 남은 M-5R은 이 PR을 막지 않는다. 이것은 코드 결함이 아니라 성재가 요청한 거래의 반대편이고, 판단할
  사람은 성재다. 후속 티켓이 필요하면 폰 TypingBar 동형(#1752)과 같은 자리에서 다루는 것이 자연스럽다.

이번 회전의 성격 하나만 기록해 둔다. R2의 세 결함은 「값을 옮기면서 그 값이 지던 두 번째 일을 안 옮겼다」였는데,
R3의 수리는 셋 다 **그 두 번째 일에 이름을 붙이는 방식**으로 닫혔다 — 빈 슬롯의 정체를 여섯 항목으로 적었고,
비활성의 두 원인을 두 분기로 갈랐고, 링의 유무를 폭이 아니라 스타일로 물었다. 잔량 상수(`18px`)까지
되돌려 놓은 것을 포함해, 이 커밋은 리뷰가 지적한 축을 코드가 기억하게 만들었다.
