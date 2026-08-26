### Design Review R2 — clients/web (feat/1743-uxht-hover-toolbar @ b7607edd, PR #1750)

리뷰어: design-review 에이전트(R1과 동일 프로브·동일 하네스) · 2026-08-25
대상: `2156cfda..b7607edd` (수리 5커밋) · 정본 `docs/design-system/README.md` · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `references/review-rubric.md`
표면: 웹 하나(`clients/mobile` 변경 0). **폰에는 기계 프리플라이트가 없다** — 이 PR에 폰 변경이 없어 돌릴 대상도 없다(라우터 §2 · 정본 §5.4). 빈 줄이 「깨끗이 돌았다」로 읽히지 않도록 적는다.

Screenshots (`claudedocs/design-review-1750/`, R2는 `r2-` 접두사):
`r2-hover-light-1280.png` · `r2-hover-dark-1280.png` · `r2-hover-light-900.png` · `r2-hover-row-{light,dark}-1280.png` · `r2-hover-row-light-900.png` · `r2-hover-closeup-{light,dark}.png` · `r2-react-more-picker.png` · `r2-chip-plus-picker.png` · `r2-picker-roundtrip.png` · `r2-keyboard-trail.png` · `r2-bare-row-handoff.png` · `r2-slot-freeze.png` · `r2-context-menu.png` · `r2-overflow-menu.png` · `r2-drag-select.png` · `r2-click-focus-steal.png` · `r2-two-bars.png` · `r2-top-straddle-{light,dark}.png` · `r2-top-edge-clip.png` · `r2-top-edge-keyboard.png`

---

## 판정

| | 건 |
|---|---|
| R1 findings 13건 | **13건 전부 닫힘**(아래 §1, 전부 실측) |
| **새 [Blocker]** | **1** — 수리가 만든 회귀 |
| 새 [High] | 1 |
| 새 [Nitpick] | 4 |

**Verdict: FAIL(blockers: 1)**

수리 자체는 정확했다 — R1의 세 Blocker와 High/Medium/Nitpick 전부가 실측으로 닫혔고, 그중 둘은 **베이스와 같은 수치**까지 돌아왔다. 되돌려 보내는 이유는 하나다: B-2를 닫은 방식(모든 actionable 행을 `tabindex=0` 정거장으로 만들고 포커스 시 ⋯로 핸드오프)이 **마우스로 본문 텍스트를 선택하는 길을 끊었다.** 그것은 이 티켓의 리버트 방지 계약(패킷 §2 「본문 드래그 선택 무간섭」)에 이름이 적혀 있고, R1에서는 통과했던 항목이다.

---

## 0. 기계 증거

**프리플라이트 (원문 꼬리):**

```
OK    web: 12/12 categories clean.
== design pre-flight (core), 이슈 #1141 ==
OK    emdash: 0 / progress_word: 0 / latin_particle: 0 / raw_color: 0 / hype: 0
RESULT: PASS, web 12/12 + core 5/5 categories clean.
```

**단위 스위트:** `npx vitest run` → **106 files / 1,501 tests 통과**(R1 1,491 → +10: `rowFocus.test.ts` 신설 + 툴바/스토어 보강).

**캡처 레인:** `npm run build && npm run capture:design` **exit 0**, 두 스킴 × 데스크탑/900/폰.

```
  호버 툴바 desktop chat rest {light,dark}: 0개
  호버 툴바 hover {light,dark}: 1개
  호버 툴바 위치 hover {light,dark}: 1개, 우측 16px · 상단 -26px
  호버 툴바 본문 hover {light,dark}: 1개, 글자 교차 0 · 상단 -26px
  호버 툴바 본문 hover 900 {light,dark}: 1개, 글자 교차 0 · 상단 -26px
  탭 스톱 hover {light,dark}: 10행에 행 컨트롤 13개, 탭 스톱 0개 (행당 최대 0)
  키보드 {light,dark}: Tab → 행 · 툴바 마운트 · → message-actions-trigger → unfurl-card → message-actions-trigger
  호버 툴바 폰 {light,dark}: 0개 · 길게 누르기 안내 보임
```

**실렌더 계측:** R1과 같은 방식(캡처 스크립트를 `/tmp`로 복사해 목·픽스처만 재사용, 레포 파일 수정 0). 1280/900 × light/dark × 터치 프로파일.

---

## 1. R1 findings 재검증 — 13/13 닫힘

| R1 | 항목 | R2 실측 | 판정 |
|---|---|---|---|
| **B-1** | 피커 진입점이 앱을 무너뜨림 | 툴바 React(☺) 클릭 → 피커 오픈(dialog 1, 포커스 `emoji-search`), **툴바 1개 유지**, React 오류 0. 칩 `+` 동일. ⋯ 메뉴 경로 동일. **왕복까지 확인**: 피커에서 🎉 선택 → 크래시 0, `localStorage` `{"🎉":1}`, 포커스가 opener(`toolbar-react-more`)로 복귀. Esc는 칩 `+` opener로 복귀(`reaction-add`, fv=true) | **닫힘** |
| **B-2** | 구성원 0 행에서 키보드 도달 불가 | 구성원 0 actionable 행(1410)에 포커스 → **`message-actions-trigger`로 핸드오프**, `:focus-visible` **true**, 툴바 1, 행 정거장 **1**, BODY 추락 **0**. ArrowRight → 👍, Tab → 행 안 `message-link` | **닫힘** |
| **B-3** | 툴바가 본문을 덮음 | 글자 단위 Range 교차: **자기 행 0 / 바로 위 행 0 / 화면 안 모든 행 0** (1280 light·dark, 900 light 전부). 우측 거터 16px, 상단 −26px straddle. `r2-hover-row-light-1280.png`에서 URL이 `…/000000000001/channels/00000000-0000-`까지 온전히 읽힌다 | **닫힘** |
| **H-1** | 탭 예산 증가·착지점이 아바타 | 순회 실측(1407→컴포저): **16 정거장** = 베이스 16과 동일(R1은 19). 행별 정거장 **전부 1**(10행, `tabindex=0` 행 자신 + 구성원 0). 착지점은 아바타가 아니라 ⋯ | **닫힘** |
| **H-2** | 슬롯이 커서 밑에서 재배열 | 3번 슬롯(🙏) 클릭 → 같은 마운트 동안 순서 **불변**(👍✅🙏), 커서 아래 글리프 그대로. 진짜 언마운트(컴포저 클릭, 툴바 0) 후 재호버 → **🙏👍✅**로 갱신. 얼렸지만 죽지 않았다 | **닫힘** |
| **H-3** | 다크에서 툴바가 행과 분리 안 됨 | 테두리가 `--line-strong`로 바뀌어 계산색 실측 대비 **다크 3.00:1 · 라이트 3.03:1**(hover된 행 바탕 대비). §3.1 규칙 4의 컨트롤 경계 3:1을 채운다(채움 분리 1.08은 그대로지만 이제 경계가 진다) | **닫힘** |
| **M-1** | 이름 충돌 | 툴바 `aria-label="메시지 액션"` · ⋯ `aria-label="더 많은 액션"` | **닫힘** |
| **M-2** | ←/→ 링 분열 | 칩에서 시작해 ArrowRight: `reaction-chip → reaction-add → toolbar-👍 → toolbar-✅`, ArrowLeft로 `👍 → reaction-add → reaction-chip`. **한 링으로 드나든다** | **닫힘** |
| **M-3** | 오른쪽 끝에 붙음 | `right-4` — 실측 행 우변과의 간격 **16px**, 본문 상자 우변(1264)과 정확히 정렬 | **닫힘** |
| **M-4** | 포커스 링 페이드 패턴 | 툴바 항목 계산 스타일 `transition-property: all / duration 0s` — `transition-colors` 제거됨 | **닫힘** |
| **M-5** | 죽은 `pointer-only` 유틸리티 | `tokens.css`에서 유틸리티 삭제, 주석 셋이 그 사실을 적는다 | **닫힘** |
| **N-1** | 슬롯에 `title` 없음 | `title="👍 반응 취소"` 실측 | **닫힘** |
| **N-2** | 레인이 React 버튼을 안 누름 | `assertHoverToolbarClearsBodyText` + React 버튼 실클릭 레인 추가(9a308bad), 캡처 로그에 본문 교차 0이 찍힌다 | **닫힘** |
| (N-3) | 폰 패리티 = 선언된 결정 | 변동 없음(시트 불변, 터치 툴바 0) | 유지 |

**회귀 스팟체크(R1에서 PASS였던 것):** 우클릭 메뉴 **13항목 동일**(👍 ✅ 🙏 🎉 👀 😄 · 다른 반응 고르기 · 답글 달기 · 인용해서 답하기 · 복사 · 고정하기 · 고치기 · 지우기) · 오버플로 메뉴 동일 13항목 · **메뉴 열린 채 포인터가 행을 떠나도 툴바 고정**(toolbar 1 / menu 1) · Esc가 포커스를 ⋯로 반환(fv=true) · 터치 프로파일 툴바 **0** + 길게 누르기 안내 1 · 가로 오버플로 0. **드래그 선택만 아래 B-4로 깨졌다.**

---

## 2. 새 [Blocker]

### B-4. 메시지 본문을 마우스로 선택할 수 없다 — 그리고 본문을 클릭하면 ⋯에 키보드 포커스 링이 그려진다

**실측(같은 빌드 안의 대조):**

| 행 | `data-actionable` | 행 `tabindex` | mousedown 직후 `activeElement` | 드래그 후 선택 문자열 |
|---|---|---|---|---|
| 1413 (일반 메시지) | true | `0` | **`message-actions-trigger`** | **`""`** |
| 1414 (에이전트 메시지) | true | `0` | **`message-actions-trigger`** | **`""`** |
| 1415 (삭제된 메시지, 액션 없음) | — | 없음 | `timeline-virtuoso` | `"4:05"` ✅ |

같은 페이지·같은 하네스에서 **actionable 행만** 선택이 죽는다. 더블클릭 낱말 선택도 `collapsed: true`로 죽는다. 채널 제목 같은 다른 텍스트는 정상 선택된다(하네스가 선택을 못 만드는 것이 아님을 같은 런에서 확인).

**R1에서는 통과했다.** R1 리포트의 드래그 프로브는 같은 행에서 `sel: "02가 계속 납니다. GET https://gateway.dawn.internal:8443/v1/workspaces/00000000-0000-7"`을 잡았고, 드래그 중 툴바가 언마운트되는 것까지 확인했다. 회귀는 `c11e4d79`가 도입했다.

**기제(코드 좌표):** `rowFocus.ts`의 `restStationOnRow`가 **모든 actionable 행**에 `tabindex=0`을 상시로 건다 → 본문 위 mousedown이 그 행을 포커스한다 → `useHoverToolbarFocusHandoff`의 `useLayoutEffect`(같은 파일)가 `handoffRowFocusToPreferred`를 돌려 `target.focus({ focusVisible: true })`로 ⋯에 포커스를 옮긴다 → Chrome이 막 시작된 선택을 접고, 이후 드래그는 아무것도 확장하지 않는다.

**두 번째 증상:** 포인터 클릭인데 `:focus-visible`이 **true**로 켜진다(`focusVisible: true` 옵션 때문). `r2-click-focus-steal.png`에서 본문을 클릭했을 뿐인데 ⋯ 둘레에 호박색 키보드 포커스 링이 그려져 있다. 스킬 §6의 포커스 링 계약은 「키보드로 닿았을 때 보이는 링」이고, 마우스 클릭이 그리는 링은 그 계약의 반대편이다.

**왜 Blocker인가:**
- 패킷 §2의 리버트 방지 계약에 「본문 드래그 선택 무간섭」이 **이름 대어** 적혀 있다.
- 메시지의 일부를 복사하는 것은 메신저의 기본 읽기 경로다. 남은 길은 ⋯ → 「복사」(메시지 전체)뿐이다.
- 루브릭 Detail SLA: 포인터 상호작용이 응답하지 않는 부류이며, 리뷰어는 상호작용을 실제로 시도해야 한다는 조항이 이 결함을 위해 있다.
- 어느 기계 자도 이것을 재지 않는다(캡처 레인·유닛 모두 선택을 만들지 않는다) — 그래서 게이트 전부 초록인 채로 여기까지 왔다.

**방향(처방 아님):** 핸드오프가 **키보드로 들어온 포커스에만** 일어나야 한다 — 행이 `:focus-visible`일 때만, 또는 keydown(Tab) 경로에서 세운 플래그가 있을 때만. 아니면 행을 mousedown의 포커스 대상에서 빼는 방법(정거장은 키보드 전용으로 두기)도 같은 축이다. 어느 쪽이든 **드래그 선택과 클릭 링이 회귀 자로 서야** 한다: 지금 이 축에는 기계가 하나도 없다(정본 §5.3의 「무검사」에 새로 들어갈 줄이다).

---

## 3. 새 [High]

### H-4. 스크롤러 맨 위에 붙은 행의 툴바가 채널 헤더 뒤로 잘린다

- **실측:** 행 상단이 스크롤러 상단과 같아지는 위치(`rowTop − scrollerTop = −1`)에서 hover하면 툴바 상단 **18px** vs 스크롤러 상단 **45px** → **28px가 뷰포트 밖**. 툴바 좌상단 hit-test는 `channel-member-count`(헤더)로 떨어진다. `r2-top-edge-clip.png`에 헤더 밑으로 삐져나온 흰 조각만 보인다.
- straddle이 `translate: 0 calc(-100% + var(--spacing-row))`로 **항상 위로만** 뜨기 때문이다. 위에 자리가 없을 때 아래로 뒤집는 충돌 회피가 없다.
- **키보드는 무사하다**(실측): 그 행에 포커스를 주면 브라우저가 대상을 스크롤해 들이고, ⋯는 스크롤러 안(top 45)에 선다. 그래서 「키보드가 닿는데 눈이 못 보는」 Blocker 조항에는 걸리지 않는다.
- **영향:** 인박스/검색에서 점프하면 대상 행이 뷰포트 상단에 정렬되므로, **점프한 바로 그 메시지**의 퀵액션이 헤더 뒤에 숨는다. 마우스 휠로 1px만 굴리면 복구되고 우클릭 경로도 살아 있어 Blocker는 아니지만, 새로 생긴 기하가 만든 새 결함이다.
- **방향:** 위쪽에 여유가 없으면 행 안쪽(아래)으로 뒤집기 — 단, 뒤집으면 B-3의 본문 겹침이 돌아오므로 그때의 교차 0을 함께 재야 한다. Radix Popover가 같은 문제를 `collisionBoundary`로 푸는 그 축이다.

---

## 4. 새 [Nitpick]

- **N-1. 캡처 레인의 탭스톱 단정이 이제 아무것도 세지 않는다.** 정거장이 행 요소로 옮겨졌는데 `assertRowTabStops`의 `OWNED` 목록(`capture-screens.mjs:2393`)에는 행 자신이 없다 → 로그가 `탭 스톱 0개 (행당 최대 0)`로 찍힌다. 통과하지만 재는 것이 없다. 불변식(행당 정확히 1)은 지금 유닛(`rowFocus.test.ts`)만 지킨다 — 정본 §6의 「닫힌 자」 목록이 「행당 탭스톱(정적 스냅샷)」을 여전히 닫힌 축으로 세는 것은 반 칸 과장이다.
- **N-2. 본문 교차 자는 자기 행만 본다.** 실측으로는 오늘 **화면 안 모든 행**과의 교차가 0이지만(위 §1), straddle이 걸치는 26px 띠는 정의상 **위 행의 아랫단**이다. 위 행 마지막 줄이 오른쪽 끝까지 오는 픽스처가 들어오면 자는 침묵한다.
- **N-3. 툴바 두 개가 동시에 뜰 수 있다.** 정상 상태에서는 1개(실측 `count: 1`, 행별 정거장 전부 1)지만, 피커를 닫는 순간처럼 「포커스를 든 행 + 포인터 아래 행」이 갈릴 때 순간적으로 2개가 잡혔다. 계약(hover **또는** focus **또는** overlay)과 모순은 아니나 레인은 `=== 1`을 단정한다.
- **N-4. 슬롯 동결의 수명이 「마운트 동안」이라 실제로는 더 길 수 있다.** 슬롯을 클릭하면 포커스가 그 버튼에 남아 툴바가 계속 마운트 상태이므로, 다른 행을 hover해도 순서는 그대로다(실측). 포커스가 떠난 뒤 재호버에서 갱신된다(🙏👍✅ 실측). 의도한 설계로 읽히지만 문서에는 「다음 마운트」로만 적혀 있다.

---

## 5. 루브릭 페이즈

| # | 페이즈 | 결과 |
|---|---|---|
| 0 | Prep | **PASS** — 빌드·캡처 완주(exit 0), 두 스킴 + 900 + 터치, 실렌더 계측 11종 |
| 1 | Interaction | **FAIL** — B-4(드래그 선택 사망·클릭 포커스 링). 나머지는 전부 통과: 피커 3경로 · 메뉴 고정 · Esc 반환 · 우클릭 13항목 · 터치 비렌더 |
| 2 | Viewport | **부분** — 1280/900 본문 교차 0·가로 오버플로 0. 스크롤러 상단 밴드에서 H-4 |
| 3 | Visual polish | **PASS** — 우측 16px 정렬, straddle −26px, 경계 3.00/3.03:1, 임의값 0, 그림자 어휘 2단 유지 |
| 4 | Accessibility | **부분** — 키보드 완주 복구(행→⋯ 핸드오프, fv=true, 행당 1정거장), 이름 충돌 해소, 로빙 한 링. 다만 B-4의 포인터 클릭 → `:focus-visible` 링은 이 축의 결함이기도 하다 |
| 5 | Robustness | **PASS** — 삭제/에이전트/언퍼얼/긴 토큰 행 모두 공존, 크래시 0, 오류 경계 미발생 |
| 6 | Code health | **PASS** — 프리플라이트 12/12+5/5, vitest 1,501, store가 소비자별 memo로 갈렸고(`frequencyStore.ts`) 툴바 자체 로빙 삭제로 규칙이 한 곳에 모였다 |
| 7 | Copy | **PASS** — 「더 많은 액션」 추가분 포함 동사 우선·em-dash 0·hype 0 |

---

## 6. 다음 회전에서 볼 것 (한 줄)

B-4 하나다. 핸드오프를 키보드 경로에만 걸고, **드래그 선택과 클릭 시 링 없음**을 재는 자를 같이 세우면 이 PR은 닫힌다 — 나머지 13건은 이미 실측으로 닫혔고, H-4·N-1~N-4는 같은 회전에 얹거나 후속으로 보내도 된다.
