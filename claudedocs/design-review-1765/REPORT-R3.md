### Design Review R3 (최종 확인) — clients/web 사이드바 (UX-D4 · PR #1765 · `feat/1756-d4-sidebar` @ 5319bd3e)

선행: `REPORT.md` (R1 — Blocker 1 · High 2 · Medium 6 · Nitpick 5) → `REPORT-R2.md` (R2 — 14/14 REPAIRED, 새 High 1 · Nitpick 2).
이번 수리: `5319bd3e` 한 커밋 (52e70702..HEAD, 6 파일 +247/−17).
정본: `docs/design-system/README.md` · 방언 `momo-design-taste-web` · 루브릭 `review-rubric.md`.

Screenshots: `claudedocs/design-review-1765/r3/` (캡처 레인, 두 스킴 264장) · `r3-probe/` (자체 프로브)

---

## 0. 게이트 — 전부 이 리뷰가 직접 재실행

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **exit 0 — web 12/12 + core 5/5** |
| `npm run typecheck` | **0** |
| `npm test` | **113 files / 1577 tests** (R2 112/1573 → +1 파일 +4) |
| `OUT_DIR=…/r3 npm run capture:design` | **exit 0**, 264장, 두 스킴 완주 |
| 폰 기계 프리플라이트 | **없음** (`clients/mobile` 무접촉) |
| 워크트리 | `git status --porcelain` **0줄** (리뷰가 파일을 만지지 않았다) |

`min-h-control-sm`이 **실제로 컴파일되는지**를 빌드된 CSS에서 따로 확인했다 — 정본 §2.3이
「격자 밖 단계는 조용히 틀린 크기가 아니라 규칙 0개가 된다」고 적은 그 함정이라:
`.min-h-control-sm{min-height:var(--spacing-control-sm)}` **존재.**

---

## 1. ① A0~A5 재실행 — R2-1(`overlayHeld` 누수) 판정: **REPAIRED**

R2에서 샜던 시퀀스를 그대로, 그리고 반복까지 더해 다시 걸었다. 포인터는 매 측정 전 컴포저에 주차하고
rAF 두 프레임을 기다린 뒤 셌다.

| 지점 | R2 (누수) | **R3 (실측)** |
|---|---|---|
| A0 신규 세션 rest | `{0,0}` | **`{plus:0, dm:0, tabStops:0}`** |
| ⌘K 「채널 만들기」 다이얼로그 중 | `{1,1}` | **`{plus:1, dm:0, tabStops:1}`** ← **DM 섹션이 더 이상 함께 고정되지 않는다** |
| A1 ⌘K 왕복 후 rest (+1.5s) | **`{1,1}`** | **`{0,0,0}`** |
| A2 `/inbox` 라우트 이동 후 | `{1,1}` | **`{0,0,0}`** |
| A3 채널 복귀 | `{1,1}` | **`{0,0,0}`** |
| A4 헤더 focus+blur 후 | `{0,1}` (부분 치유) | **`{0,0,0}`** |
| A5 새로고침 후 | `{0,0}` | **`{0,0,0}`** |
| **A6 ⌘K 왕복 3회 반복** | (미측정) | **`{0,0,0}`** — hold가 누적되지 않는다 |

수리의 모양이 옳다. 두 축을 동시에 고쳤다:

1. **해제를 옳은 사건에 묶었다.** hold는 이제 `overlayOpen`이 false로 전이한 뒤 **rAF 한 프레임**에
   풀린다. 그 한 프레임이 필요한 이유가 코드 주석에 적혀 있고 실제로 참이다 — 다이얼로그 provider의
   포커스 복원이 `queueMicrotask`라 마이크로태스크가 먼저 돌고 그 다음 프레임에 hold가 풀린다.
   그래서 「복원 대상이 살아 있어야 한다」와 「rest는 0이어야 한다」가 충돌하지 않는다.
   `onHeaderBlur`의 해제는 backstop으로 남았다.
2. **스코프를 섹션으로 좁혔다.** `useCreateChannelOpen()`이 `SidebarRow`에서 빠지고
   `overlayOpen`이 **props**가 됐다. `Sidebar.tsx`는 그것을 채널 섹션에만 넘기고 DM 섹션에는
   넘기지 않는다 — DM의 액션은 다이얼로그가 아니라 `<Link to="/directory">`라 고정될 이유가 없다.
   R2가 지적한 「무관한 DM 섹션까지 얼어붙는다」가 원인에서 사라졌다.

**그리고 이 사실이 캡처 레인에 red proof로 박혔다.** `assertSectionActionsAtRest()`가
①첫 줄 ②헤더 경유 왕복 후 ③**⌘K 왕복 후** 세 번 돌고, plus·dm·tabStops **셋 다** 0을 요구한다.
R2가 지적한 「단정이 프레임의 첫 순간만 본다」는 좁음이 닫혔다. 다이얼로그가 떠 있는 동안
반대 섹션이 0인지도 두 경로 각각에서 단정한다.

---

## 2. ② B-1 키보드 왕복 무회귀 — **유지**

포인터 0회, 순수 키보드:

```
nav-search → Tab  section-collapse-channels  (fv: true)
           → Tab  new-channel                (fv: true)
           → Enter                            다이얼로그 중 {plus:1, dm:0}
           → Esc   active="new-channel" · :focus-visible · outline: solid 2px
           → Tab   channel-item              (제자리에서 계속)
그 뒤 rest {plus:0, dm:0, tabStops:0}
```

R1의 Blocker(`active=BODY`, 다음 Tab이 레일로 튐)는 닫힌 채이고, R2-1 수리가 그것을 되돌리지 않았다.
**복원과 rest 0이 같은 왕복 안에서 둘 다 참이다** — 이 두 요구가 서로를 잡아먹지 않는 것이 이번
커밋의 요점이고, 실측으로 확인했다.

---

## 3. ③ 남은 Nitpick 2건 판정 — 둘 다 **REPAIRED** (적립 없음)

### R2-2 (폰 헤더가 44px 액션을 넘침) → **REPAIRED**

`h-control-sm`(고정) → `min-h-control-sm`(바닥선). 390 서랍 실측:

| | R2 | **R3** |
|---|---|---|
| 채널 헤더 높이 | 28 | **44** |
| `+` 상/하단 | 헤더를 8px씩 넘침 | **헤더와 정확히 일치** (t 349 / b 393, 헤더도 349/393) |
| 첫 채널 행 침범 | 4px | **0** |
| DM 헤더 | 동일 결함 | **44 / 침범 0** |

데스크톱은 28 == 28 그대로다(min이 실제로 바닥선으로만 작동). 폰 카드 메뉴 5행도 **44px 유지**.
`r3/mobile-sidebar-drawer-{light,dark}.png`

### R2-3 (`countSectionActionTabStops` 증명이 형제보다 약함) → **REPAIRED**

새 `SidebarSection.test.tsx`(138줄)가 **진짜 `SidebarSection`을 jsdom에 렌더**하고 그 트리를
`countSectionActionTabStops`에 넘긴다 — 형제 `countToolbarTabStops`가 렌더된 행을 받는 것과 같은 모양이다.
재는 것 셋: rest에서 탭 스톱 0 · hover한 섹션**만** 마운트하고 그때 1 · 오버레이 닫힘 다음 프레임에 0.
합성 객체로 필터 로직만 재던 자리가 「사이드바 rest에서 0」이라는 원래 주장으로 바뀌었다.

---

## 4. 회귀 스팟 — 누적 축 재확인

| 축 | R3 실측 |
|---|---|
| M-1 hover 무이동 | ✔ 헤더 28 == 28, 첫 행 top 281 == 281, DM 헤더 417 == 417 |
| M-2 접힘 언리드 | ✔ 접힌 「채널」이 `2` |
| M-3 새로고침 생존 | ✔ reload 뒤 `data-collapsed` + 배지 `2` 유지 |
| M-4 레일 | ✔ `nav[워크스페이스]` 자식이 `["workspace-current","add-workspace"]` 둘뿐, `sidebar-expand`는 밖 |
| 상태 PUT | ✔ 본문 `{"status":"away"}` · 배지 `data-effective="away"` · 카드 닫히고 포커스 트리거 복귀 |
| 패널 접기 왕복 | ✔ 접기 → `sidebar-expand`, 펼치기 → `sidebar-collapse` |
| Esc 층 (카드 → 서랍) | ✔ 1차 = 메뉴만 + 포커스 `profile-card`, 2차 = 서랍 + `open-sidebar-drawer` |
| 폰 카드 메뉴 44px | ✔ 5행 전부 44 |
| 무선언 가로 스크롤 | ✔ 접힘 1280에서 0 |
| 두 스킴 | ✔ 264장 완주 |

**프로브 단정 21/21 PASS, FAIL 0.**

---

## 5. 새 발견 — 없음

이번 수리에서 새로 연 자리는 찾지 못했다. 확인하고 결함으로 세지 않은 것 둘을 기록해 둔다:

- **rAF 해제와 백그라운드 탭.** 탭이 뒤에 있으면 rAF가 멎으므로 hold가 그동안 남는다. 그 사이에는
  아무것도 그려지지 않고, 돌아온 첫 프레임에 풀린다. 화면에 나타나는 상태가 아니다.
- **렌더 중 `setOverlayHeld`.** `if (overlayOpen && !overlayHeld) setOverlayHeld(true)`는 같은
  컴포넌트의 파생 상태 갱신이라 React가 허용하는 형태이고, 무한 루프 조건(`!overlayHeld` 가드)이 있다.

---

## Verdict

```
Blocker 0 · High 0 · Medium 0 · Nitpick 0
Verdict: PASS (blockers: 0)
```

**ADR-0133 웹 패리티 목표(Blocker 0 · High 0) 충족.**

누적: R1 14건 + R2 3건 = **17건 전부 닫혔고**, 닫힘이 문서가 아니라 실행되는 자리에 남았다 —
캡처 레인의 red proof 여덟 개(키보드 왕복 · 다이얼로그 중 트리거 생존 · 반대 섹션 비고정 ×2 ·
rest 0 ×3 · 헤더 높이 동일 · H-2 복귀 · 접힘 언리드 · 폰 탭 타깃 다섯 행)와 렌더 단위 테스트가
그 사실들을 다음 사람에게 물려준다. 정본 §5.3이 「사람만 잡는다」고 적어 둔 축 중 넷
(렌더된 포커스 수명 · 조건부 마운트의 rest 예산 · hover 프레임 기하 · 상태 수명주기)이
이 티켓에서 기계로 내려왔다.

---

*리뷰 방법: 캡처 레인은 `OUT_DIR`만 바꿔 원본 그대로 실행했고, 판정 근거는 캡처 스크립트의 모의
`/v1`·`signIn`을 재사용하는 별도 프로브(`/tmp/d4probe`, 1280·390 두 프로파일)로 독립 실측했다.
레인 자신의 단정은 인용하되 판정 근거로 삼지 않았다. 레포 파일은 하나도 수정하지 않았다.*
