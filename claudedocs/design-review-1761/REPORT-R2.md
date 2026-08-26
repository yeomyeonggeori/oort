### Design Review R2 (표적 재검증) — clients/web · PR #1761 / 티켓 #1753
**수리 커밋**: `30471bf1` (head) · base 대비 `QuickSwitcher.tsx` 1줄 · `quickSwitcherSurface.test.ts` · `capture-screens.mjs` 두 레인
**대상**: R1 리포트(`REPORT.md`)의 **H-1 · M-2 · N-1** 세 건 + 회귀 스팟 1건씩. 나머지는 재판정하지 않았다.
**Screenshots**: `claudedocs/design-review-1761/r2-*` · 하네스 원본 `r2-harness-cmdk.html`

---

## 레인 (전량 재실행)

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS · web 12/12 + core 5/5** (`r2-design_preflight_web.txt`) |
| `npm run build && npm run capture:design` | **EXIT=0** · 두 스킴 전량 · 새 프레임 4장 생성 (`r2-capture-design.log`) |
| `npx tsc --noEmit` | **0** |
| `npm test` | **1530/1530 · 109 files** (`r2-web-tests.log`) |
| 폰 | 이 커밋에도 폰 코드는 없다. **폰에는 기계 프리플라이트가 없다**(정본 §5.4) — 빈 칸이 아니라 없는 레인이다 |

워크트리 `git status` 클린 — 리뷰어는 파일을 고치지 않았다.

---

## ① H-1 — **닫힘.** 링이 소스가 아니라 화면에서 사라졌다

수리는 내가 제시한 두 갈래 중 ①(그리지 않는다)을 골랐고, 근거도 정확하다: 팔레트는 모달이고 입력이 유일한 포커스 대상이라 링은 상시 점등, 즉 정보량 0.

**계산된 스타일 실측** (`r2-harness-cmdk.html`, 빌드된 `dist/assets/index-*.css`를 그대로 물림):

| 판 | 입력 outline | 그릇 outline |
|---|---|---|
| A. base (`origin/track/uxui`) | **solid 2px** `rgb(165,76,8)` / dark `rgb(240,168,80)` | none |
| B. R1 (`b5d223fc`) | none | **solid 2px** `rgb(165,76,8)` / dark `rgb(240,168,80)` |
| C. **R2 (`30471bf1`)** | **none** | **none** |

즉 A→B는 상자가 **옮겨 간** 것이었고(R1 판정의 근거), B→C에서 **없어졌다.** 두 스킴 모두 `caret-color`는 `--ink`로 남아 있다 — 텍스트 캐럿이 포커스 표시를 계속 진다.

**실캡처 픽셀 판정** (팔레트 머리 밴드 device x 750~1800 · y 50~170에서 accent 색 화소 수, tol 40):

| | light | dark |
|---|---|---|
| R1 `quick-switcher-people-*.png` | **8,848** | **8,848** |
| R2 `r2-quick-switcher-people-*.png` | **0** | **0** |

증거: `r2-crop-cmdk-{light,dark}.png` · 하네스 3판 나란히 `r2-harness-cmdk-focus-{a,b,c}-{light,dark}.png`
→ 레퍼런스 41의 머리(캐럿 + 아래 헤어라인 하나)에 실제로 도달했다. 목록의 `--accent-soft` 선택 표시가 이제 이 표면에서 accent를 혼자 쓴다(§3 위계 · §2.2 「한 표면 한 accent」).

**M-1도 함께 닫혔다** (동반 폐쇄 보고가 맞다). `r2-crop-cmdk-corner-{light,dark}.png` 4배 확대에서 `rounded-lg` 14px 호가 온전하고, 직각 호박 모서리도 스크림 누수도 없다. R1의 `crop-cmdk-corner-light.png`와 나란히 놓으면 차이가 한눈에 보인다.

시험도 뒤집혔다: `quickSwitcherSurface.test.ts`가 이제 그릇에 `focus-ring`이 **없음**을 단정한다. 다만 이 시험이 지키는 것은 여전히 클래스 문자열이고, 화면을 지키는 것은 위의 캡처다 — 그 갈림은 R1에서 적은 그대로다.

---

## ② M-2 — **닫힘.** 빈 상태가 실물 프레임으로 존재한다

`thread-empty-{light,dark}.png` 두 장이 생성됐고, 하네스가 아니라 **실앱 렌더**다. 경로 설계가 특히 옳다: 이미 연 스레드는 클라 스토어가 답글을 기억하므로 빈 상태로 못 돌아간다는 것을 알아채고, **아직 답글 없는 행에서 툴바 [답글]로 새로 여는 자연 경로**를 택했다. 픽스처를 비트는 대신 사용자가 실제로 그 화면에 닿는 길을 그대로 걸은 것이다.

프레임이 담은 것(`r2-thread-empty-light.png` · `r2-crop-thread-empty-dark.png`):
- 루트 아래 32px 여백, 그 아래 점선 `rounded-md` 상자, 좌측 정렬 한 줄 — 두 스킴 모두 글자 잘림·넘침 없음
- 루트는 마침 긴 URL + 한글/영문 혼합 + 반응 칩까지 달린 행이라, 빈 상태 프레임이 동시에 **한국어+영문 장문 스트레스**도 담는다
- 레인이 `assertNoHorizontalOverflow(login, 'thread empty ...')`를 함께 걸었다 — 두 스킴 **0** (`r2-capture-design.log`)

부수 관찰(신규 [Nitpick] N-5, 아래): 이 프레임의 **왼쪽 채널 열**에 호버 툴바가 하나 떠 있다. `mouse.move(8,8)` 뒤에도 남는 이유는 hover가 아니라 **포커스**다 — 직전에 `toolbar-reply`를 클릭했으므로 그 행이 `focus-within`으로 툴바를 계속 띄운다. 사진의 주제(오른쪽 패널)를 가리지 않으므로 판정에 영향은 없다.

---

## ③ N-1 — **닫힘.** 잔상 0, 이름과 내용이 일치한다

스레드 패널 상단 띠(device x 1920~2560 · y 60~400)에서 `--line-strong`(툴바 테두리) 화소 수:

| 프레임 | line-strong px | 뜻 |
|---|---|---|
| R1 `u4-thread-composer-parity-light.png` | **1,728** | 패리티 사진에 툴바 잔상 |
| R2 `r2-u4-thread-composer-parity-light.png` | **315** | 툴바 없음(잔여분은 패널 크롬) |
| R2 `r2-thread-root-hover-light.png` | **1,721** | 호버 프레임이 자기 이름으로 |

레인이 스크린샷 뒤 `mouse.move(8,8)` + **툴바 `detached` 대기**까지 건다 — 타이밍에 기대지 않고 조건을 기다린다는 점이 좋다.
덤으로 R1에서 「1280에 스레드 rest 프레임이 0장」이라고 적었던 공백이 함께 메워졌다: `r2-crop-thread-parity-rest-light.png`가 **툴바 없이 32px 여백만** 보여 주는 첫 데스크톱 프레임이다. 구분선 제거의 결과를 사람이 판단할 사진이 이제 존재한다.

---

## ④ 회귀 스팟 (수치 대조, R1 → R2)

| 자 | R1 | R2 | 판정 |
|---|---|---|---|
| 스레드 루트 호버 (light/dark) | 패널 안쪽 · 글자 교차 0 · straddle below | **동일** | 무회귀 |
| 채널 일반 행 (light/dark) | 우측 16px · 상단 −26px · straddle top · 교차 0 | **동일** | 무회귀 |
| 채널 900px | 우측 16px · 상단 −26px · straddle top · 교차 0 | **동일** | 무회귀 |
| 채널 최상단 행 | straddle below · 상단 57px · 교차 0 | **동일** | 무회귀 |
| 가로 오버플로(스레드 패널·빈 상태) | 0 | **0** | 무회귀 |

원문 `r2-capture-design.log`. ⌘K 팔레트의 기능(열기·입력·필터링)도 실캡처에서 그대로다 — 「김」 질의가 에이전트 설정/채널/사람 3섹션을 반환한다. ↓/Enter는 여전히 자동 증거가 없으나 구조상 무관하다(cmdk는 `onKeyDown`을 `cmdk-root`에 걸고, 이번 수리는 클래스 한 개만 지웠다).

---

## 신규 [Nitpick]

**N-5 — 새 빈 상태 프레임의 왼쪽 열에 포커스 잔류 툴바가 있다.** 위 ②에 적은 그대로다. 주제를 가리지 않고 상태 자체는 정직하지만(방금 [답글]을 누른 행이다), 그 프레임이 나중에 타임라인 판정에 재사용되면 호버 잔상으로 오독될 수 있다. 닫으려면 캡처 직전에 포커스를 컴포저로 한 번 옮기면 된다 — 같은 레인이 이미 그 수를 쓰고 있다.

**N-6 — ⌘K 입력은 이제 링이 어디에도 없고, 그 정당성은 「입력이 유일한 포커스 대상」이라는 *마크업 불변식*이다.** 오늘 참이고(팔레트 안의 포커서블은 입력 하나뿐, `Command.Item`은 포커서블이 아니며 DM 실패 배너도 액션 버튼을 갖지 않는다), 그래서 판정은 통과다. 다만 그 불변식은 아무도 강제하지 않는다 — 레퍼런스 41의 `ESC` 칩 같은 컨트롤이 머리에 하나 붙는 날, 그 컨트롤은 링을 갖고 입력은 못 갖는 상태가 되며 프리플라이트 `naked_focus`는 그때도 초록이다(R1의 N-4와 같은 맹점). 주석 한 줄이 이유를 이미 적고 있으니, 그 줄에 「포커서블이 둘이 되면 이 결정은 다시 열린다」를 덧붙이는 정도가 값싼 보험이다.

R1의 **M-3(폰 스레드 빈 상태의 격 차이)**는 적립 보고를 확인했다. 이 리뷰는 재판정하지 않는다.

---

## Verdict

```
표적 3건:  H-1 닫힘 (M-1 동반 폐쇄) · M-2 닫힘 · N-1 닫힘
회귀:      0 (5개 자 전부 R1과 동일 수치)
신규:      [Nitpick] N-5 · N-6

[Blocker] 0
[High]    0
[Medium]  1  (M-3 — 폰 패리티, 적립 합의됨)
[Nitpick] 6  (R1의 N-2·N-3·N-4 잔존 + N-5·N-6)

Verdict: PASS (blockers: 0)
```

**웹 표면의 ADR-0133 목표(Blocker 0 · High 0)를 이제 충족한다.** R1이 남긴 High 1은 화면에서 실측으로 닫혔고(accent 화소 8,848 → 0), 그 수리가 M-1까지 함께 지웠다. 남은 것은 전부 Nitpick과 적립된 M-3이므로, 이 PR은 사람 심사로 올려도 좋다.

세 수리 모두 **주장이 아니라 자를 함께 놓았다는 점**을 기록해 둔다: H-1은 시험을 뒤집었고, M-2·N-1은 캡처 레인에 프레임과 대기 조건을 새로 걸었다. R1이 지적한 「소스는 초록인데 화면은 그대로」의 반대 방향이다.
