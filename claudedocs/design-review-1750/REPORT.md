### Design Review — clients/web (feat/1743-uxht-hover-toolbar @ 2156cfda, PR #1750)

리뷰어: design-review 에이전트(신규 컨텍스트) · 2026-08-25
정본: `docs/design-system/README.md`(오르트 구름) → 라우터 `.claude/skills/momo-design-taste/SKILL.md` → 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `references/review-rubric.md`
대상 범위: `git diff origin/track/uxui..HEAD` (78eba169 구현 + 2156cfda 문서) — 15파일 / +870 −216
표면: 웹 하나. `clients/mobile` 파일 변경 0건(정본 §1 주1에 따라 `clients/desktop`도 웹과 같은 번들).

Screenshots (전부 `claudedocs/design-review-1750/`):
- 캡처 레인 산출: `b11-message-actions-{light,dark}.png` · `b11-message-actions-focus-{light,dark}.png`
- 계측 프레임: `probe-worst-row-light-1280.png` · `probe-worst-row-light-900.png` · `probe-worst-row-dark-1280.png` · `probe-hover-{light,dark}.png`
- 상호작용: `probe-react-more-click.png`(크래시) · `probe-dev-crash.png` · `probe-chip-plus.png`(크래시) · `probe-menu-picker.png`(정상) · `probe-touch-chip-plus.png`(정상, 터치) · `probe-overflow-menu.png` · `probe-context-menu.png` · `probe-drag-select.png` · `probe-slot-click.png` · `probe-bare-row-focus.png`
- 대조군(베이스 `origin/track/uxui` 빌드): `base-chip-plus.png`

---

## 0. 증거 레인 — 무엇을 실제로 돌렸는가

**① 기계 프리플라이트 (웹). 원문 그대로:**

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

**폰에는 기계 프리플라이트가 없다.** 이 PR은 `clients/mobile`을 건드리지 않았으므로 폰 레인을 돌릴 대상 자체가 없었고, 그 줄을 비워 두면 「깨끗하게 돌았다」로 읽히므로 여기 적는다(라우터 §2 · 정본 §5.4).

**② 단위 스위트:** `npx vitest run` → **106 files / 1,491 tests 전부 통과**(신규 `MessageHoverToolbar.test.tsx` 6 + `hoverToolbarModel.test.ts` 9 포함). STATUS.md의 초록 주장은 사실이다 — 그리고 아래 Blocker 셋 중 어느 것도 이 초록이 볼 수 있는 자리에 있지 않았다(§6 참조).

**③ 캡처 레인 완주:** `npm run build && npm run capture:design` **exit 0**, 두 스킴 × 데스크탑/폰. 툴바 관련 단정 전부 초록:

```
  호버 툴바 desktop chat rest light: 0개
  호버 툴바 hover light: 1개
  호버 툴바 위치 hover light: 1개, 우측 0px · 상단 0px
  탭 스톱 hover light: 10행에 행 컨트롤 13개, 탭 스톱 1개 (행당 최대 1)
  키보드 light: Tab → 행 · 툴바 마운트 · → message-actions-trigger → toolbar-react-👍
  (dark 동일) · 호버 툴바 폰 {light,dark}: 0개
```

**④ 실렌더 계측(복제 하네스):** `scripts/capture-screens.mjs`를 `/tmp`로 **복사**해 목 서버·픽스처만 재사용하고 프로브를 붙였다(레포 파일 수정 0). 1280/900 뷰포트, light/dark, 터치 프로파일.

**⑤ 대조군:** `git archive origin/track/uxui`로 베이스 트리를 `/tmp/base-uxui`에 풀어 빌드하고 같은 프로브를 돌렸다. 아래 「베이스」로 표기한 수치는 전부 그 실측이다. (레포·워크트리 변경 0.)

---

## 판정 요약

| | 건 |
|---|---|
| **[Blocker]** | **3** |
| [High] | 3 |
| [Medium] | 5 |
| [Nitpick] | 3 |

**Verdict: FAIL(blockers: 3)** — 구현자에게 되돌아간다. ADR-0133 패리티 목표(Blocker 0 · High 0)와도 두 축 모두 미달.

---

## [Blocker]

### B-1. 툴바의 React(☺)를 누르면 앱이 무너진다 — 화면 전체가 오류 경계로 바뀐다

- **재현(계측):** 행 hover → `toolbar-react-more`(☺ 「다른 반응 고르기」) 클릭 → 피커가 열리지 않고 채널 전체가 `render-error-boundary`로 교체된다. **`probe-react-more-click.png`**: 타임라인·컴포저가 사라지고 "이 화면을 열지 못했습니다 / 서버에서 받은 내용을 읽지 못했습니다"만 남는다.
- **같은 크래시가 반응 칩의 `+`(`reaction-add`)에서도 난다** — 행을 가리키고 있으면(=툴바가 마운트돼 있으면) 반응 피커로 가는 **모든 행 내부 진입점**이 죽는다. `probe-chip-plus.png`.
- **원인 좌표(dev 빌드 비압축 스택):** `Maximum update depth exceeded ... at EmojiPickerPanel`, 오류 경계가 잡은 컴포넌트는 `<MessageHoverToolbar>`. 범인은 `src/features/emoji/frequencyStore.ts:41·86-88`의 **단일 슬롯 `snapshotCache`**다. 소비자가 둘이 되면(피커 `EmojiPickerPanel.tsx:119` = limit 32, 툴바 `MessageActions.tsx:345` = limit 3) 서로의 캐시를 렌더마다 축출하고, `useSyncExternalStore`의 `getSnapshot`이 매번 새 배열을 돌려주어 무한 렌더가 된다. **이 PR 이전에는 이 store의 동시 소비자가 하나뿐이었다** — 툴바가 그 둘째 소비자를 만든 첫 표면이다.
- **대조군이 이것을 이 PR의 회귀로 확정한다:**
  - 베이스 빌드에서 같은 칩 `+` 클릭 → 피커 정상 오픈, 포커스 `emoji-search`, 크래시 0 (`base-chip-plus.png`).
  - HEAD의 터치 프로파일(툴바 비마운트)에서 같은 칩 `+` → 정상 오픈 (`probe-touch-chip-plus.png`). 즉 **툴바가 떠 있는 동안만** 죽는다.
  - HEAD의 ⋯ 메뉴 → 「다른 반응 고르기」 경로는 **죽지 않는다**(`probe-menu-picker.png`). 캡처 레인이 초록인 이유가 정확히 이것이다: 레인은 ⋯ 메뉴만 열어 보고 툴바의 React 버튼은 한 번도 누르지 않는다.
- **왜 Blocker인가:** 루브릭 Detail SLA(ADR-0112 D6) 첫 줄 — 포인터에 반응하지 않는 보이는 컨트롤. 여기서는 반응하지 않는 정도가 아니라 **표면 전체를 파괴**하고, 복구는 새로고침뿐이다. 티켓의 대표 상호작용(원클릭 반응 옆의 「더 고르기」)이 그 자리다.
- **덤:** 오류 경계 문장이 거짓을 말한다 — 클라이언트 렌더 루프인데 "서버에서 받은 내용을 읽지 못했습니다"라고 서버를 지목한다(정본 §5.3 「화면이 거짓을 말함」). 이 PR이 만든 문장은 아니지만, 이 PR이 그 문장을 처음으로 사람 눈앞에 세웠다.
- **방향:** store의 캐시를 소비자별로 갖게 하거나(키별 Map), 훅이 자기 스냅샷을 자기 안에서 안정화하거나, 툴바가 store를 구독하는 대신 마운트 시점에 한 번 읽는다. 어느 쪽이든 **소비자 둘 이상이 정상**임을 테스트가 못 박아야 한다.

### B-2. 평범한 연속 행에서 키보드가 행 액션에 전혀 닿지 못하고, 아무것도 보이지 않는 탭 정거장이 생겼다

- **계측:** 픽스처의 `data-seq=1410`·`1411`은 `data-actionable="true"`인 **평범한 한국어 연속 메시지**다(「배포 전 확인할 것은 롤백 경로입니다…」). 이 행들은 정지 상태에서 `[data-row-action]` 구성원이 **0개**라, `rowFocus.ts:154`의 W-4 갈래가 켜져 **행 자신이 탭 정거장**이 된다. 그 행에 포커스를 주면:

  | | 실측 |
  |---|---|
  | `document.activeElement` | **BODY** (한 프레임 안에 떨어진다) |
  | 툴바 | **0개** (마운트되지 않는다) |
  | ArrowRight | 아무 일도 없음 (여전히 BODY) |
  | 실제 Tab 순회 | 정거장 하나가 `BODY`, `:focus-visible` **false** |

- **기제:** 포커스 → `setRowFocused(true)` → 툴바 마운트 → MutationObserver → `normalizeRow` → 구성원이 ≥1이 되었으므로 `rowFocus.ts:159`가 **지금 포커스를 들고 있는 그 행에서 `tabindex`를 떼어낸다** → Chrome이 포커스를 놓는다 → `onBlurCapture`가 `rowFocused=false` → 툴바 언마운트 → 다시 `tabIndex=0`. 조건부 렌더 계약과 「컨트롤 없는 행은 자기가 정거장」 규칙이 서로를 무효화한다.
- **베이스 대조:** 같은 픽스처에서 베이스는 **모든 행이** `message-actions-trigger:0`을 들고 있다(⋯가 DOM에 상주). `tabindex=0`인 행은 하나도 없고, 10행 전부 Tab으로 액션 진입점에 닿는다.
- **결과:** 마우스는 되고 키보드는 안 된다. 반응·답글·고치기·지우기·고정·복사 **전부**가 그 행에서 키보드로 도달 불가다. 게다가 Tab 한 번이 아무 데도 착지하지 않고 소모된다(눈에 보이는 링 없음).
- **왜 Blocker인가:** Detail SLA — 「키보드가 닿을 수 없는 컨트롤」과 「눈이 볼 수 없는 정거장」 두 조항에 동시에 걸린다. UX 원칙 P11(모든 액션에 키보드 경로)의 정면 위반이고, 스킬 §6이 이 PR에서 새로 적은 문장("Pointer rows may mount a hover/focus-within toolbar")이 전제하는 focus-within 경로가 **실제로는 성립하지 않는다**.
- **방향:** 툴바 마운트가 행의 정거장을 빼앗지 않도록 두 규칙의 순서를 정하는 문제다 — 예컨대 행이 정거장을 내주기 전에 새 구성원으로 포커스를 옮기거나, 행이 액션을 가진 동안에는 W-4 갈래를 아예 쓰지 않거나. 어느 쪽이든 **「구성원이 0인 행」이 회귀 테스트의 케이스로 들어와야** 한다(현재 테스트 하네스 `MessageHoverToolbar.test.tsx:162`는 모든 행에 칩을 하나씩 심어 두어 이 갈래를 영원히 지나간다).

### B-3. 툴바가 자기 행의 본문을 덮는다 — B11 R2 Blocker의 회귀, 그리고 그것을 재던 자를 같은 커밋에서 지웠다

- **계측(실렌더, 글자 단위 Range 교차):**

  | 뷰포트 | 가려진 글자 | 가려진 문자열 |
  |---|---|---|
  | 1280 | **20자** | `nnels/00000000-0000-` |
  | 900 | **26자** | `kspaces/00000000-000-8000-` |

  `probe-worst-row-light-1280.png`에서 첫 줄이 `…/000000000001/cha`에서 끊기고 다음 줄이 `7000-8000-…`로 시작한다. 그 사이의 글자는 줄바꿈된 것이 아니라 **불투명한 툴바(`bg-surface-raised`) 아래에 있다.** 다크도 동일(`probe-worst-row-dark-1280.png`).
- **무엇이 바뀌었나:** 옛 `MessageActionColumn`은 **예약된 32px 열**이었고, 그 자리의 주석이 이유를 적어 두고 있었다 — *"Any offset is a bet about line heights. A column is not a bet: text stops where the gutter starts."* 새 툴바는 `MessageActions.tsx:375`에서 `absolute right-0 top-0 z-20`으로 본문 위에 뜬다. 열은 사라졌고 본문은 오른쪽 끝까지 흐른다(실측 본문 상자 우변 1264, 툴바 좌변 1099 — **165px 겹침 구간**).
- **그리고 그 회귀를 잡던 기계가 같은 커밋에서 지워졌다:** `assertActionGutterClearsBody`(본문 상자와 진입점의 간격을 px로 재고 음수면 실패)가 삭제되고, 자리를 대신한 `assertHoverToolbarPlacement`(`capture-screens.mjs:2271`)는 **"어느 행의 우상단인가"만** 잰다. 그 함수의 주석이 근거로 적은 문장은 `겹침은 계약이다(3사 플로팅 바)`(:2268)인데, **그 계약은 어느 정본에도 없다**:
  - 이 PR이 함께 고친 `docs/design-system/README.md` §6 「행 액션 표면」은 조건 넷(조건부 렌더 · 한 탭스톱 · 메뉴 전용 · 터치)만 적고 **겹침도, 예약 열의 폐기도 말하지 않는다.**
  - 스킬 §6 개정문도 마찬가지다.
  - 즉 R2에서 Blocker로 판정돼 열로 수리된 실패가, 승인 흔적 없이 스크립트 주석 한 줄로 되돌아왔다.
- **왜 Blocker인가:** 루브릭 Detail SLA — 「기본 크기에서 잘리거나 겹치거나 truncate된 사용자 텍스트」. 한국어 문단의 첫 줄은 거의 언제나 오른쪽 끝까지 가고(R2가 이미 실측한 사실), 가려지는 순간은 **읽으려고 그 행을 가리킨 바로 그 순간**이다. 좁은 창일수록 더 가린다(900에서 26자).
- **방향:** ①툴바에 다시 자기 자리를 주거나(예약 거터), ②본문 띠 밖으로 띄우거나(행 위쪽 여백/행간으로 올려 straddle), ③정말 겹치는 것이 결정이라면 **§6에 R2 Blocker를 이름 대어 적고** 무엇이 그 대가를 감당하는지(불투명도·오프셋·폭 상한)를 함께 적어야 한다. 그리고 어느 선택이든 **px로 재는 자**가 다시 서야 한다 — 지금은 그 축에 기계가 하나도 없다.

---

## [High]

### H-1. 행의 탭 예산이 늘었고, Tab의 착지점이 액션 진입점에서 아바타(프로필 열기)로 바뀌었다

- **실측 순회(같은 픽스처, 첫 행 → 컴포저):** 베이스 **17 정거장** → HEAD **19 정거장**. 행별로:

  | 행 | 베이스 | HEAD |
  |---|---|---|
  | 1407 (에이전트 카드 포함) | agent-card → ⋯ (2) | avatar → agent-card → ⋯ (**3**) |
  | 1414 (카드+디스클로저 2) | agent-card → SUMMARY×2 → ⋯ (4) | avatar → agent-card → SUMMARY×2 → ⋯ (**5**) |
  | 1408·1409·1411·1412 | ⋯ (1) | avatar (1) — **⋯에는 Tab으로 못 간다** |

- **기제:** 정지 상태에 툴바가 없으므로 `preferredIndex`(`rowFocus.ts:67`)가 고를 `primary`가 없다 → 행의 정거장이 **아바타(프로필 열기)** 가 된다. 그리고 포커스가 행 안의 비구성원(링크·카드·디스클로저)에 있는 동안 `normalizeRow`가 다시 돌면 `primary`(⋯)를 0으로 승격시켜 **정거장이 하나 더 생긴다.**
- **계약과의 관계:** 「행당 추가 탭스톱 ≤1」은 문자 그대로는 지켜진다(툴바가 더하는 것은 1). 그러나 `rowFocus.ts` 머리말이 선언한 규칙 — *「한 행 = 탭 스톱 하나」, 「⋯는 DOM 순서로는 마지막이지만 사람이 이 행에서 가장 먼저 찾는 것」* — 은 이제 그 파일이 설명하는 대상에서 거짓이다. 이 PR은 그 파일을 만졌지만 `pointer-only` 문구만 고쳤다.
- **캡처 레인이 초록인 이유:** `assertRowTabStops`는 **한 프레임의 정적 스냅샷**을 센다. 위 +1은 순회 도중 `normalizeRow`가 다시 돌 때 생기므로 그 자에 안 잡힌다.

### H-2. 빈도 슬롯이 클릭 직후 커서 밑에서 재배열된다

- **실측:** 클릭 전 `[👍 ✅ 🙏]` → 두 번째 슬롯 ✅ 클릭 → 클릭 직후 `[✅ 👍 🙏]`. 손가락(커서)은 그대로인데 **그 자리의 이모지가 바뀐다.** 같은 지점을 두 번 누르면 서로 다른 반응이 나간다.
- `recordEmojiUse` → store emit → `useFrequentEmojis`가 즉시 새 순위를 돌려주기 때문이다(`MessageActions.tsx:392·345`).
- 원클릭 반응의 값은 **근육 기억**이다. 누를 때마다 순서가 바뀌면 그 값이 사라지고, 되돌리기(같은 자리 재클릭 = 취소)까지 어긋난다.
- **방향:** 순위 갱신을 툴바가 살아 있는 동안(또는 세션 동안) 얼리고, 다음 마운트에서 반영. `aria-pressed`가 붙어 있는 토글이므로 위치 안정성은 접근성 축이기도 하다.
- (참고: 목 픽스처가 반응 왕복을 반영하지 않아 칩 수 변화는 이 레인에서 확인할 수 없었다 — 칩 자체를 눌러도 변하지 않는다. 반응 적용 여부는 `runtime-unverified`로 남긴다.)

### H-3. 다크에서 떠 있는 툴바가 자기가 덮는 행과 시각적으로 분리되지 않는다

- **실측 계산 색:** 툴바 채움 `rgb(32,31,36)` vs hover된 행 `rgb(38,37,44)` = **1.08:1** · 테두리 `rgb(52,50,59)` = **1.20:1**. 라이트는 채움 1.27:1.
- 유일한 고도 신호인 `shadow-lg`가 `rgba(0,0,0,0.1)`이라 **거의 검은 바탕 위에서 보이지 않는다**(계산 스타일 실측). 정본 §2.6이 웹 고도를 두 단으로 잠근 어휘 자체는 지켜졌지만, 다크에서 그 두 단이 하는 일이 없다.
- B-3와 곱해지면 결과가 나쁘다: 가려진 글자가 **가려진 것으로 보이지 않고 문장이 거기서 끝난 것으로** 읽힌다(`b11-message-actions-focus-dark.png`).
- 정본에서 가장 가까운 자는 §2.2의 그릇 산술(대비 ≥1.05 **그리고** OKLab ≥0.02)이고, §5.3은 「칩의 테두리 = 이 알약이 컨트롤로 읽히는가」 축에 **기계가 아무것도 없다**고 적는다. 즉 이 축은 설계상 사람이 잡는 자리다.

---

## [Medium]

- **M-1. 같은 이름 둘.** `role="toolbar" aria-label="메시지 액션"`(`MessageActions.tsx:371`) 안에 `aria-label="메시지 액션"` 버튼(:449)이 있다. 스크린리더는 "메시지 액션 도구 모음 … 메시지 액션 단추"를 읽는다 — 컨테이너와 그 안의 한 컨트롤이 같은 이름을 가지면 로터에서 둘을 못 가른다. ⋯는 「더 보기」류의 자기 이름을 가져야 하고, 그때 툴바 이름이 「메시지 액션」으로 남는다.
- **M-2. ←/→ 링이 둘로 갈라진다.** 툴바 밖(칩·아바타)에서는 행 그룹이 툴바 항목까지 포함해 순회하는데, 툴바 안으로 들어가면 툴바 자체 핸들러(:353-367)가 `stopPropagation`하고 `[data-toolbar-item]`만 돈다 — **돌아 나올 수 없다.** 한 행이 한 로빙 그룹이라는 `rowFocus.ts`의 전제가 표면에서 둘로 쪼개졌다.
- **M-3. 툴바가 타임라인 오른쪽 끝에 딱 붙는다.** 실측 툴바 우변 1280 = 스크롤러 우변, 그런데 같은 행의 본문은 1264에서 멈춘다(`px-4`). 행이 지키는 16px 거터를 툴바만 무시해서 채널의 오른쪽 끝이 툴바에서만 튀어나온다(옛 열 주석이 "keeps the right edge of the channel straight"라고 적었던 그 축). 오버레이 스크롤바가 아닌 플랫폼에서는 ⋯가 스크롤바 밑에 깔린다.
- **M-4. 포커스 링 페이드 패턴을 여섯 자리 더 늘렸다.** `toolbarItemClass`(:308)가 `transition-colors`와 `focus-visible:focus-ring`을 한 클래스 리스트에 든다 — 정본 §5.3이 이름 대어 적은 **아무 기계도 안 재는** 그 패턴이고(Tailwind v4에서 `outline-color`가 전이 대상에 포함된다), 수리는 #1210에 걸려 있다. 새 컴포넌트가 그 잔량을 6개 늘렸다.
- **M-5. `pointer-only`가 죽은 유틸리티가 됐다.** `src/` 전수에서 이 클래스를 쓰는 컴포넌트가 0이다(주석 참조만 남음). `tokens.css:789`의 개정 주석은 "이 유틸리티는 같은 축의 다른 포인터 전용 크롬용이다"라고 적는데, 그 크롬은 지금 존재하지 않는다 — 정본 §6의 "이름을 못 짓겠으면 그 값에 이유가 없다"의 반대편 사례(이름은 있는데 쓰는 자리가 없다).

---

## [Nitpick]

- **N-1.** 슬롯 버튼에는 `aria-label`만 있고 `title`이 없다(React/답글/⋯에는 둘 다). 포인터 전용 표면에서 툴팁 유무가 형제 컨트롤끼리 갈린다.
- **N-2.** STATUS.md의 「`capture:design` exit 0 (rest/hover/focus/touch 4상태)」는 사실이지만, 그 레인은 **툴바의 React 버튼을 한 번도 누르지 않는다** — B-1이 사는 자리가 정확히 거기다. 이것은 §5.3의 「기계가 못 잡는 축」이 아니라 **잡을 수 있는데 안 잡은 자리**다(레인은 이미 같은 프레임에서 ⋯ 메뉴를 열고 Enter/Arrow/Esc까지 돈다).
- **N-3.** 폰 패리티: 시트는 계약대로 불변이고 빈도 행도 안 생겼다(패킷이 out of scope로 선언). 결과적으로 「원클릭 반응」은 포인터 전용 기능이 됐다 — 드리프트가 아니라 선언된 결정이지만, 나중에 패리티 결함으로 재발견되지 않도록 여기 적어 둔다.

---

## 루브릭 페이즈 결과

| # | 페이즈 | 결과 |
|---|---|---|
| 0 | Prep | **PASS** — 빌드·캡처 레인 완주(exit 0), 두 스킴, 폰 프로파일 포함. 추가로 복제 하네스 계측 + 베이스 대조군 빌드. |
| 1 | Interaction | **FAIL** — B-1(피커 진입점 전멸) · B-2(키보드 도달 불가). 정상 확인된 것: 우클릭 메뉴 불변(13항목 동일, `probe-context-menu.png`) · ⋯ 메뉴 열린 동안 포인터가 행을 떠나도 툴바 고정 · Esc가 포커스를 ⋯로 반환 · 본문 드래그 선택 무간섭(드래그 중 툴바 언마운트, 선택 문자열 온전 `probe-drag-select.png`) · 터치 비렌더(레인 단정 0개). |
| 2 | Viewport | **FAIL** — 1280/900 둘 다 가로 오버플로 0이지만, 본문 가림이 900에서 더 나빠진다(20자 → 26자). |
| 3 | Visual polish | **FAIL** — 토큰 준수 자체는 깨끗하다(간격 `gap-px`·`p-px`·`h-4`, 반경 `rounded-md/sm`, `size-control-sm` 28px, 그림자 어휘 2단 유지, 임의값 0). 깨진 것은 B-3(겹침)·H-3(다크 분리)·M-3(오른쪽 끝). |
| 4 | Accessibility | **FAIL** — B-2가 키보드 완주를 막는다. 더해 M-1(이름 충돌)·M-2(로빙 분열)·M-4(링 페이드). 긍정: 아이콘 전용 컨트롤 전부 `aria-label` 보유, 슬롯에 `aria-pressed`, 포인터 전용 크롬이라 28px는 WCAG 2.5.8(24) 충족. |
| 5 | Robustness | **부분** — 삭제된 메시지·에이전트 카드·언퍼얼·긴 무공백 토큰 행 모두 툴바와 공존한다. 다만 B-1의 오류 경계 문장이 원인을 서버로 돌린다(§4 오류 상태 규칙: 「무슨 일이 일어났고 다음에 무엇을」). |
| 6 | Code health | **부분** — 프리플라이트 12/12 + core 5/5, vitest 1,491 초록, 인라인 스타일·hex 0, 프리미티브 재사용(DropdownMenu 유지, 커스텀 툴바에는 "Radix Toolbar 미벤더" 사유 주석 있음 — §1 규칙 충족). 그러나 새 테스트가 **피커와 툴바를 함께 마운트하지 않고**(B-1), **구성원 0인 행을 만들지 않는다**(B-2). 두 Blocker 모두 「기계가 못 재는 축」이 아니라 **하네스가 지나간 자리**다. |
| 7 | Copy | **PASS** — 동사 우선(「답글 달기」·「다른 반응 고르기」·「반응 남기기/취소」), em-dash 0, hype 0, 내부 어휘 노출 0, 한/영 혼용 문자열이 툴바 폭에 영향을 주지 않는다(고정 폭 아이콘 6). |

---

## 문서 개정 의무(같은 PR) 점검

셋 다 실제로 개정됐다: `MessageActions.tsx` 머리말 B11 주석 · 스킬 §6 · `docs/design-system/README.md` §6 「행 액션 표면」. 다만 **정본 §6이 자기 사정거리를 과하게 말한다**:

> 「기계 자는 `capture-screens.mjs`의 호버/포커스/터치 4상태와 행당 탭스톱 단정이다.」

실측으로는 그 자가 (a) 본문 겹침을 아예 안 재고(그 자를 이 커밋이 지웠다), (b) 탭스톱은 정적 스냅샷만 재어 순회 중 +1을 놓치며, (c) 새 진입점(React 버튼)을 누르지 않아 B-1을 못 본다. 이 문서가 가장 자랑스러워하는 성질이 **「무엇이 안 재지는지를 함께 적는 것」**(§5.3)이므로, 재도입 계약 옆에는 **닫힌 자와 열린 자를 같이** 적어야 한다.

---

## 되돌려 보내는 이유 한 줄

직전 사이클(#1746 R1~R3)에서 반복해 잡힌 결함군 — hover/키보드 커서 간섭, 포커스 소유, 앵커 없는 팝오버 — 이 이번에는 **더 큰 판**으로 돌아왔다: 피커 진입점이 앱을 무너뜨리고(B-1), 키보드가 행 액션에서 끊기고(B-2), R2가 Blocker로 판정해 열로 수리했던 본문 가림이 그 자를 지우면서 되돌아왔다(B-3). 셋 다 실행 가능한 기계 자의 사정거리 **안**에 있던 결함이다.

