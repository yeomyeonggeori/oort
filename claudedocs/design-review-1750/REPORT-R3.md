### Design Review R3 — clients/web (feat/1743-uxht-hover-toolbar @ b6efe4c3, PR #1750)

리뷰어: design-review 에이전트(R1·R2와 같은 하네스·같은 프로브) · 2026-08-25
대상: `b7607edd..b6efe4c3` (수리 4커밋) · 표적 검증(B-4 · 키보드 비파손 · H-4 · N-1 · 회귀 스팟체크)
정본: `docs/design-system/README.md` · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `references/review-rubric.md`
표면: 웹 하나(`clients/mobile` 변경 0). **폰에는 기계 프리플라이트가 없다** — 이 PR에 폰 변경이 없어 돌릴 대상도 없다(라우터 §2 · 정본 §5.4).

Screenshots (`claudedocs/design-review-1750/`, R3는 `r3-` 접두사):
`r3-drag-select.png` · `r3-keyboard-trail.png` · `r3-top-flip-{light,dark}.png` · `r3-top-flip-closeup-{light,dark}.png` · `r3-context-menu.png` · `r3-hybrid-click-then-key.png`

---

## 판정

| | |
|---|---|
| R2 [Blocker] B-4 | **닫힘** (실측) |
| R2 [High] H-4 | **닫힘** (실측) |
| R2 [Nitpick] N-1·N-4 | **닫힘** (레인이 실제로 잰다 / 문서 현행화) |
| 회귀 스팟체크 | **통과** (아래 §5) |
| 새 [Blocker] | **0** |
| 새 [High] | **0** |
| 새 [Nitpick] | 3 (전부 후속 가능) |

**Verdict: PASS** — Blocker 0 · High 0. ADR-0133 패리티 목표를 만족한다. 사람 리뷰로 보낼 수 있다.

---

## 0. 기계 증거

**프리플라이트:** `RESULT: PASS, web 12/12 + core 5/5 categories clean.`
**단위 스위트:** `npx vitest run` → **1,506 tests 통과**(R2 1,501 → +5).
**캡처 레인:** `npm run build && npm run capture:design` **exit 0**. 새 자 셋이 로그에 찍힌다:

```
  호버 툴바 본문 hover {light,dark}: 1개, 글자 교차 0(자기+이웃) · 상단 -26px · straddle top
  탭 스톱 hover {light,dark}: 10행에 행 컨트롤 22개, 탭 스톱 10개 (행당 정확히 1)
  드래그 선택 hover {light,dark}: seq 1416 「502가 계속 납니다. GET」 · active=timeline-virtuoso · fv=false
  호버 툴바 스크롤러 top {light,dark}: seq 1400 inside · straddle below · 툴바 102 / 스크롤러 45
  호버 툴바 본문 top {light,dark}: 1개, 글자 교차 0(자기+이웃) · 상단 57px · straddle below
  호버 툴바 폰 {light,dark}: 0개 · 길게 누르기 안내 보임
```

**실렌더 계측:** 캡처 스크립트를 `/tmp`로 복사해 목·픽스처만 재사용(레포 파일 수정 0). 1280 × light/dark, 390 터치.

---

## 1. ① B-4 — 본문 드래그 선택 (닫힘)

행별 실측(같은 페이지, 같은 하네스):

| 행 | actionable | 행 `tabindex` | mousedown `activeElement` | mousedown `:focus-visible` | 드래그 선택 | 클릭 후 포커스 / 링 | 더블클릭 낱말 |
|---|---|---|---|---|---|---|---|
| 1413 | true | `0` | `timeline-message`(행 자신) | **false** | **`hermes 어제 실패한 배`** | `timeline-message` / **링 없음** | **`hermes`** |
| 1414 | true | `0` | `timeline-message` | **false** | **`hermes\n· 곽성재 님이 관`** | `timeline-message` / **링 없음** | **`hermes`** |
| 1415 (삭제, 액션 없음) | — | 없음 | `timeline-virtuoso` | false | `제된 메시지` | — / 링 없음 | — |

- **⋯를 탈취하지 않는다**: R2에서 `message-actions-trigger`였던 mousedown 착지점이 이제 행 자신이다.
- **클릭이 링을 그리지 않는다**: `focusVisible: true` 강제가 사라져 `:focus-visible`이 false다(R2 스크린샷의 호박색 링이 사라졌다).
- 캡처 레인도 같은 것을 잰다(`assertActionableRowDragSelect` → 「502가 계속 납니다. GET」 · fv=false). **R2의 「이 축에 기계가 하나도 없다」가 닫혔다.**

## 2. ② 키보드 경로 비파손 (통과)

- 실제 Tab 순회에서 **모든 행이** `message-actions-trigger`에 착지하고 `:focus-visible` **true**다(핸드오프가 평범한 `focus()`로 바뀌었지만 키보드 모달리티가 승계된다 — 실측으로 확인).
- 1407 → 컴포저 **16 정거장**: R2·베이스와 동일. 본문 링크·에이전트 카드·디스클로저 같은 정당한 콘텐츠 정거장만 추가로 선다.
- 행별 정거장 **10행 전부 정확히 1**(행 요소 정거장 + 구성원 정거장 합산).
- 프로그램 포커스(`.focus()`)는 핸드오프하지 않는다 — 새 규칙(`:focus-visible`만) 그대로다.

## 3. ③ H-4 — 스크롤러 상단 뒤집기 (닫힘)

행 상단이 스크롤러 상단과 같아지는 위치(`rowTop − scrollerTop = −1`)에서 hover:

| | light | dark |
|---|---|---|
| `data-straddle` | **below** | **below** |
| 툴바 상자 | 145 ~ 177 | 145 ~ 177 |
| 스크롤러 | 45 ~ 708 | 45 ~ 708 |
| 전부 스크롤러 안인가 | **예** | **예** |
| 우측 거터 | 16px | 16px |
| 글자 교차(화면 안 **모든** 행) | **0** | **0** |
| 좌상단·우하단 hit-test | 둘 다 툴바 자신 | 둘 다 툴바 자신 |

R2에서 헤더 뒤로 잘려 흰 조각만 보이던 자리가 `r3-top-flip-closeup-{light,dark}.png`에서 온전한 툴바로 서 있고, 자기 행·아래 행 어느 글자도 덮지 않는다. 뒤집힌 상태의 기하는 위 straddle의 정확한 거울(26px 띠)이다.

## 4. ④ N-1 — 탭스톱 자가 실제로 재는가 (닫힘)

레인 로그가 `10행에 행 컨트롤 22개, 탭 스톱 10개 (행당 정확히 1)`로 바뀌었다 — 행 요소 정거장이 계수에 들어왔고, 「0개(최대 0)」로 통과하던 무측정 상태가 사라졌다. 내 독립 계측(행별 stops)도 10행 전부 1로 일치한다.

## 5. ⑤ 회귀 스팟체크 (통과)

- **B-1(피커)**: 툴바 React → 피커 오픈(dialog 1), 툴바 유지(1), 크래시 0, React 오류 0. Esc → 포커스가 opener(`toolbar-react-more`)로 복귀(fv=true).
- **B-3(본문 겹침)**: straddle top 상태에서 글자 교차 **0**(자기+이웃, 1280·900·양 스킴).
- **M-3(우측 거터)**: 16px, 본문 상자 우변과 정렬.
- **계약 3(메뉴 전용 액션)**: 우클릭 인벤토리를 행마다 실측 — 내 메시지 **13항목**(고치기·지우기 포함, seq 1408·1412·1413), 남의 메시지 **11항목**(고치기·지우기 없음), 삭제된 메시지 **0**(메뉴 비활성). 툴바에는 여전히 없다.
- **터치**: 툴바 **0**, 길게 누르기 안내 1.

---

## 6. 새 [Nitpick] (전부 후속 가능, 이번 회전 차단 아님)

- **N-5. 뒤집기는 마운트 시점 1회·단방향이다.** `MessageActions.tsx`의 layout effect가 `if (straddleBelow) return;`으로 되돌아가지 않는다. 툴바가 뜬 동안 행이 움직이면(새 메시지 도착, 스크롤) 위쪽 여유가 생겨도 아래에 남고, 반대로 위 straddle로 마운트된 뒤 상단으로 밀려가면 다시 재지 않는다. 마운트 수명이 짧아 실사용 영향은 작지만, 정본 §6의 「닫힌 자: 스크롤러 상단 뒤집기」에는 *마운트 시점*이라는 한정이 없다.
- **N-6. 마우스→키보드 하이브리드.** 본문을 클릭하면 행이 포커스를 들되 링은 없다(정상). 그 상태에서 첫 ←/→는 **행 전체에 링만 그리고** 아무것도 옮기지 않으며(행은 로빙 구성원이 아니다), Tab은 ⋯를 건너뛴다(툴바가 DOM에서 본문보다 앞이라 순방향에서 지나간 자리다). 키보드만 쓰는 사람은 이 상태에 들어오지 않는다.
- **N-7. 뒤집힌 툴바는 다음 행 옆에 앉는다.** 소유자를 말해 주는 것은 hover 틴트 하나뿐이고, 다크의 그 틴트는 채움 분리 1.08:1이다. 실측 프레임에서는 읽히지만, 틴트가 더 옅어지는 날 이 배치가 먼저 모호해진다.

---

## 7. 루브릭 페이즈

| # | 페이즈 | 결과 |
|---|---|---|
| 0 | Prep | **PASS** — 빌드·캡처 완주(exit 0), 두 스킴 + 900 + 터치 + 상단 프레임 |
| 1 | Interaction | **PASS** — 드래그/더블클릭 선택, 피커 3경로, 우클릭 인벤토리(권한별 13/11/0), 메뉴 고정·Esc 반환, 터치 비렌더 |
| 2 | Viewport | **PASS** — 1280·900 교차 0, 스크롤러 상단에서 뒤집혀 전부 안쪽 |
| 3 | Visual polish | **PASS** — 거터 16px, straddle ±26px 대칭, 경계 3:1, 임의값 0 |
| 4 | Accessibility | **PASS** — 키보드 완주(행→⋯, fv=true), 행당 정거장 1, 로빙 한 링, 포인터 클릭에 링 없음 |
| 5 | Robustness | **PASS** — 삭제/에이전트/언퍼얼/긴 토큰 행 공존, 크래시 0 |
| 6 | Code health | **PASS** — 프리플라이트 12/12+5/5, vitest 1,506, 새 자 3종(드래그 선택·뒤집기·탭스톱)이 레인에 배선됨 |
| 7 | Copy | **PASS** — 변경 없음, em-dash 0 · hype 0 |

---

## 8. 한 줄

R1의 세 Blocker, R2의 Blocker 하나와 High 하나가 전부 실측으로 닫혔고, **그 넷 중 셋은 이제 기계가 다시 잰다**(본문 교차·드래그 선택·상단 뒤집기·행당 탭스톱). 남은 것은 후속으로 보내도 되는 Nitpick 셋뿐이다. **PASS.**
