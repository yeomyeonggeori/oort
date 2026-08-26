### Design Review R2 (표적 재검증) — clients/web 사이드바 (UX-D4 · PR #1765 · `feat/1756-d4-sidebar` @ 52e70702)

R1 정본: `claudedocs/design-review-1765/REPORT.md` (Blocker 1 · High 2 · Medium 6 · Nitpick 5 → FAIL).
수리 커밋: `f4069261` · `cbfa3ca5` · `52e70702` (ef403edc..52e70702, 20 파일 +568/−79).
정본: `docs/design-system/README.md` · 방언 `momo-design-taste-web` · 루브릭 `review-rubric.md`.

Screenshots (R2 캡처 레인, 두 스킴): `claudedocs/design-review-1765/r2/sidebar-*.png` · `r2/mobile-sidebar-*.png`
Screenshots (R2 자체 프로브): `claudedocs/design-review-1765/r2-probe/r2-*.png`

---

## 0. 게이트 (전부 이 리뷰가 직접 재실행)

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS — web 12/12 + core 5/5** |
| `npm run typecheck` | **0** |
| `npm test` | **112 files / 1573 tests 통과** (R1 대비 +1 파일 / +10 테스트) |
| `OUT_DIR=…/r2 npm run capture:design` | **exit 0** — 새 red proof 넷(B-1 키보드 왕복·H-2 복귀·헤더 높이 동일·접힘 언리드)을 **레인 안에서** 통과 |
| 폰 기계 프리플라이트 | **없음** (이 PR은 `clients/mobile` 무접촉) |

---

## 1. R1 지적 14건 표적 재검증 — 리뷰어 실측

캡처 레인이 스스로 초록이라고 말한 것을 그대로 받지 않고, 별도 프로브로 같은 사실을 다시 쟀다.

| # | R1 | 판정 | 리뷰어 실측 |
|---|---|---|---|
| ① | **B-1** 다이얼로그 중 언마운트 → 포커스 `<body>` | **REPAIRED** | 순수 키보드(포인터 0회): `nav-search → Tab 접기(fv) → Tab +(fv) → Enter`. **다이얼로그 떠 있는 동안 `+` DOM 1** (R1: 0). `Esc` 후 `active="new-channel"` · `:focus-visible=true` · `outline: solid 2px` · 다음 Tab이 `channel-item`(제자리 계속). BODY 0. `r2-b1-after-esc.png` |
| ② | **H-2** 워크스페이스 추가 취소 → `<body>` | **REPAIRED** | 카드 → `profile-add-workspace` → 다이얼로그 포커스 `add-workspace-name` → `Esc` → **`active="profile-card"`**, 링 있음, 열린 다이얼로그 0. `r2-h2-after-esc.png` |
| ③ | **H-1** 폰 카드 메뉴 32px | **REPAIRED** | 390×844 `hasTouch` 실측: `presence-option-auto/away/dnd` · `profile-add-workspace` · `nav-settings` **전부 182×44**. 카드가 뷰포트 안에 온전히 선다(t=492 · b=792 · l=64 · r=256). `r2-h1-phone-card.png`. 캡처의 `MOBILE_TAP_TARGETS`도 다섯 행을 **목록에 등재**해 이제 그 프레임이 실제로 잰다(§5.5②의 허용목록을 넓히면서 기하도 고친 올바른 모양) |
| ④a | **M-1** hover 시 목록 2px 이동 | **REPAIRED** | 헤더 높이 rest **28 == hover 28**, 첫 채널 행 top **281 == 281**, DM 헤더 top **417 == 417** (소수점까지 동일). `r2-m1-hover.png`. rest 높이가 26→28로 **영구히** 올라간 것이 대가이고, 그것이 맞는 방향이다 |
| ④b | **M-2** 접힘이 언리드를 지움 | **REPAIRED** | 접힌 「채널」 헤더가 `2`를 말한다(행의 미읽음과 같은 수). 배지 클래스가 `SidebarRow.tsx`의 행 배지와 **바이트로 같다**(mention=`bg-accent text-on-accent`, unread=`text-timestamp text-ink-muted`, 둘 다 `data-numeric`) — 새 어휘가 아니라 있던 어휘의 재사용. `r2/sidebar-section-collapsed-{light,dark}.png` |
| ④c | **M-3** 접힘이 새로고침에 소멸 | **REPAIRED** | `momo.web.sidebar-sections-collapsed.v1` = `{"channels":true,"dms":false}`, reload 뒤 `data-collapsed` 유지 + 배지 유지. 파싱 실패·저장 거부는 「둘 다 열림」으로 닫혀 있고 그 분기에 테스트가 있다 |
| — | **M-4** 레일 위계·어휘 혼입 | **REPAIRED** | `nav[aria-label="워크스페이스"]`의 자식이 이제 `["workspace-current","add-workspace"]` **둘뿐**이고 `sidebar-expand`는 그 밖(`nav.contains(expand)=false`). 열기는 `mt-auto`로 바닥(cy 770), 추가는 상단(cy 82), **두 컨트롤의 윤곽이 같은 값**(`1px rgb(132,129,125)` = `--line-strong`)이라 R1이 지적한 「되돌아가는 길만 그릇이 없다」가 사라졌다. 주석도 "share one vertical seat"에서 **"a focus handoff rather than one seat"**로 고쳐졌다 — 화면과 문장이 같은 말을 한다. `r2/sidebar-collapsed-{light,dark}.png` |
| — | **M-5** `설정 (⌘,)` 소실 | **REPAIRED** | 카드의 설정 행이 `title="설정 (⌘,)"`를 되찾았고, 코어 카피 정본의 좌표가 `sidebar/Sidebar.tsx:690` → `sidebar/ProfileCard.tsx:106`으로 갱신됐다. 툴팁 어법 예시 셋이 다시 셋이다 |
| — | **M-6** 접근명이 코어를 떠남 | **REPAIRED** | `presenceTriggerLabel()`이 다시 소비된다. 실측 라이브 값: `aria-label = title = "곽성재. 내 상태: 방해 금지 (변경하려면 누르세요)"` — 툴팁과 SR이 같은 문장이고 동사를 되찾았다 |
| — | **N-1** 죽은 `countSectionActionTabStops` | **약하게 닫힘** (아래 잔여) | 이제 호출되지만 **합성 `ParentNode`**에서만이다. 형제 `countToolbarTabStops`는 렌더된 행에서 불린다 |
| — | **N-2** 접힘 중 `aria-controls` 무효 | **REPAIRED** | `aria-controls={collapsed ? undefined : listId}` |
| — | **N-3** 제목 이름을 동사가 덮어씀 | **REPAIRED** | `aria-label` 제거. 접근명은 보이는 글자(`채널`), 상태는 `aria-expanded`, 동사는 `title`에만 |
| — | **N-4** 낡은 주석 둘 | **REPAIRED** | `셋(+, 새 DM, 설정)` → `셋(+ · 새 DM) … 설정은 프로필 카드 행으로 이사했다`; `ProfileCard` 머리 주석도 「행 전체가 트리거」에서 「identity cluster + `tap-target`이 600px 미만에서 행으로 키운다」로 정정 |
| — | **N-5** `role="menu"` 셀렉터 무증명 | **REPAIRED** | `escapeLayer.test.ts`가 `document`를 스텁해 **셀렉터가 실제로 조회됐는지**를 단정한다. 실행되는 증거가 실행되지 않는 주석을 대체했다 |

**14/14 REPAIRED (N-1은 닫혔으나 증명이 형제보다 약하다).** 대체로 수리가 정본의 방식대로다: 새 기제를 발명하지 않고
`dialog.tsx`가 #838 때 이미 갖고 있던 `opener`/`restoreDialogOpenerFocus`, `MessageRow`의 `overlayOpen`,
행 배지 클래스, `momo.web.*` 저장 관례를 **집어 와서 썼다.** `requestAnimationFrame(openCreateChannel)`이
새 시그니처에서 rAF 타임스탬프를 opener로 넘기게 되는 함정도 같은 커밋이 막았다(`() => openCreateChannel()`).

---

## 2. 회귀 스팟 — R1 「통과 기록」 절의 축

| 축 | R2 실측 |
|---|---|
| 포인터 rest DOM 0 | ✔ **새 세션에서는** `new-channel` 0 · `[data-section-action]` 탭스톱 0 — 단, 아래 **R2-1** |
| 상태 PUT 실왕복 + 재렌더 | ✔ 본문 `{"status":"dnd"}` · 배지 `data-effective="dnd"` · 접근명이 `방해 금지`로 갱신 · 카드 닫히고 포커스 트리거 복귀. `auto` 되돌리기도 왕복 |
| 패널 접기/펼치기 포커스 인계 | ✔ 접기 → `sidebar-expand`, 펼치기 → `sidebar-collapse` |
| Esc 층 (카드 → 서랍) | ✔ 폰 서랍: 1차 Esc = 메뉴만 닫히고 포커스 `profile-card`, 2차 Esc = 서랍 닫히고 `open-sidebar-drawer` |
| 무선언 가로 스크롤 | ✔ 접힘 1280에서 0 |
| 키보드 도달 | ✔ hover 없이 `접기 → +` 두 정거장, 둘 다 `:focus-visible` |
| 두 스킴 | ✔ 새 표면(접힘 언리드 배지·열기 윤곽) 라이트/다크 대조 |
| 프리미티브 전역 변경(`menuRowClass`에 `tap-target`) 부수효과 | ✔ 데스크톱(≥600px)에서는 무효 유틸이라 32px 유지. 폰에서 모든 드롭다운 행이 44로 자라는 것이 의도이고, 캡처 두 프로파일 완주로 시각 회귀 없음 |

---

## 3. 새로 발견 (이번 수리가 만든 것)

### [High] R2-1. `overlayHeld`가 헤더 blur 없이는 절대 풀리지 않는다 — ⌘K로 채널을 만들면 섹션 액션이 세션 내내 rest에 남는다

`SidebarRow.tsx`는 `overlayOpen`을 배선하면서 「닫힘 커밋에서 열림 플래그가 먼저 꺼지는」 경합을 막으려
`overlayHeld`를 두고, 그 해제를 **`onHeaderBlur` 안에서만** 한다. blur는 포커스가 헤더 안에 있었어야 난다.
그래서 헤더를 한 번도 거치지 않는 진입점으로 다이얼로그를 열면 hold가 영원히 남는다.

실측(1280, 포인터는 컴포저에 주차, `r2-new1-overlayheld-leak.png`):

```
A0 rest                                  {plus:0, dm:0}   ← 계약대로
   ⌘K → 「채널 만들기」 → Esc
A1 rest +1.5s                            {plus:1, dm:1}   ← 샜다
A2 /inbox 로 라우트 이동                  {plus:1, dm:1}
A3 채널로 복귀                            {plus:1, dm:1}
A4 채널 헤더에 포커스 넣었다 빼기          {plus:0, dm:1}   ← 그 섹션만 치유
A5 새로고침                               {plus:0, dm:0}
rest 탭 스톱: ["new-channel","new-dm"]                      ← 상시 2개
```

무엇이 깨지나:

- **이 티켓의 계약 4항이 그 세션 동안 꺼진다.** 「상시 + 제거」가 목적이었는데 ⌘K 한 번이 그것을 되돌린다.
  그리고 `overlayOpen`은 전역(`useCreateChannelOpen`)이라 **DM 섹션까지** 함께 고정된다 — DM 섹션은
  채널 만들기와 아무 관계가 없다.
- **이 PR 자신의 red proof가 이 상태를 오류라고 부른다.** `capture-screens.mjs`의
  `throw new Error('채널 + 가 포인터 rest 에 떠 있다')`가 바로 그 단정인데, 그것은 `captureSidebarD4`의
  **첫 줄**에서만 돌고 다이얼로그를 연 뒤에는 다시 돌지 않는다. R1이 §5.5로 지적한 「캡처가 계약보다 좁다」가
  수리 커밋에서 한 칸 새로 열린 자리다.
- ⌘K의 「만들기 → 채널 만들기」는 팔레트가 스스로 광고하는 1급 경로다. 드문 길이 아니다.

*(등급 판단: 컨트롤이 죽거나 잘리거나 포커스를 잃지 않고, 새는 것은 **보이는** 컨트롤 둘이라
「눈에 안 보이는데 Tab이 찾는」 함정은 아니다. 그래서 Blocker가 아니라 High다. 다만 ADR-0133 패리티는
High 0이므로 어느 쪽이든 구현자에게 돌아간다.)*

방향: hold는 **오버레이가 닫힌 사실**로 풀려야지 헤더 포커스라는 무관한 사건으로 풀리면 안 된다.
형제 `MessageRow`는 hold 없이 `overlayOpen`만으로 성립하는데, 그 차이가 왜 필요했는지가 먼저 답할 질문이다.

### [Nitpick] R2-2. M-1 수리가 헤더에 **고정** 높이를 줬다 — 폰에서 44px 액션이 28px 상자를 넘친다

`h-control-sm`은 min이 아니라 고정 높이다. 폰(<600px)에서 `+`/`✎`는 `tap-target`으로 44px가 되므로
28px 헤더를 위아래 8px씩 넘친다. 실측(390 서랍): 헤더 `h=28`, `+` `h=44`, **첫 채널 행과 4px 겹침**
(DM 섹션도 동일 4px).

다만 **탭을 빼앗지는 않는다** — 실제 탭 테스트에서 첫 채널 행 상단 2px의 히트 대상은 `channel-item`이고
탭 결과도 채널 이동이었다(채널 만들기 안 열림). 잘리는 글자도 없다(`r2-new2-phone-header-overlap.png`).
남는 것은 「상자가 자기 내용을 담지 않는다」는 사실과, `+`의 44px 히트영역 중 아래 4px이 행에 덮인다는 점이다.
데스크톱은 28 == 28이라 무해하다. 방향: 바닥선(min)으로 두면 폰에서 행이 44로 자라 두 축이 저절로 맞는다.

### [Nitpick] R2-3. `countSectionActionTabStops`의 증명이 형제보다 약하다

이제 호출되지만 인자는 `querySelectorAll`을 흉내 낸 객체 둘이다. 즉 재는 것은 필터 로직이지
「사이드바 rest에서 0」이 아니다. 그 사실은 여전히 캡처의 `restPlus` 한 줄만 지고 있고,
R2-1이 보인 대로 그 한 줄은 프레임의 첫 순간만 본다. 형제 `countToolbarTabStops`는 렌더된 행을 받는다.

---

## Verdict

```
Blocker 0 · High 1 · Medium 0 · Nitpick 2      (R1 지적 14/14 REPAIRED)
Verdict: PASS (blockers: 0)
```

- **루브릭 기준**: Blocker 0 · High ≤2 → 자동 되돌림 없이 **사람 리뷰로 진행 가능**.
- **ADR-0133 웹 패리티 기준(Blocker 0 · High 0)**: **미달** — R2-1 하나.

R1의 Blocker와 High 둘은 실물 런타임에서 닫혔음을 리뷰어가 독립적으로 확인했고, 수리 방식도 정본의
방식이었다(발명 대신 이미 있던 기제 사용, 그리고 그것을 캡처 레인의 red proof로 고정). 남은 R2-1은
그 수리가 넣은 경합 방지 장치의 해제 조건이 잘못된 사건에 묶여 있는 한 곳이고, 고치는 자리는
`SidebarRow.tsx` 한 파일이다.

---

*리뷰 방법: 캡처 레인은 `OUT_DIR`만 바꿔 원본 그대로 실행했고, 상호작용 판정은 캡처 스크립트의 모의 `/v1`·
`signIn`을 재사용하는 별도 프로브(`/tmp/d4probe`)로 1280·390 두 프로파일에서 독립 실측했다.
레인 자신의 단정은 근거로 인용하되 판정 근거로 삼지 않았다. 레포 파일은 하나도 수정하지 않았다.*
