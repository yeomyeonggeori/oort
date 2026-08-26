# Design Review — clients/web 이모지 피커 (UX-EB / #1742 / PR #1746)

- 대상: `/Users/kwakseongjae/projects/momo-tracks/momo-worktrees/uxeb-emoji-picker`, 브랜치 `feat/1742-uxeb-emoji-picker` @ `f29111fe`
- 리뷰 diff: `git diff 1db0b4e0..HEAD` (마지막 커밋 f29111fe는 `.gitleaksignore` 1건이라 UI 대상 아님)
- 표면: 웹/데스크톱 (Tauri는 `clients/web/dist`를 그대로 실는다 — 오르트 구름 §1 주1)
- 정본: `docs/design-system/README.md` (오르트 구름) · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `.claude/skills/momo-design-taste/references/review-rubric.md`
- Design Read: 컴포저/타임라인의 이모지 선택 표면, web+Tauri 내부 팀 사용자, density 7/10, motion 1/10
- 리뷰어: 신선 컨텍스트 독립 design-review. **리뷰 중 레포 파일은 한 줄도 수정하지 않았다** (캡처 구동은 `/tmp/eb-review/`의 복제 하네스).

---

## ① 최종 판정

**FAIL (Blockers: 1)**

Blocker 0 기준 미달. ADR-0133 웹 패리티 목표(Blocker 0 · High 0)에도 미달(High 5). 구현자에게 반송한다.

집계: **Blocker 1 · High 5 · Medium 5 · Nitpick 8**

수리 우선순위 제안(픽셀 아님): **B-1 + H-1을 한 수리로 묶는 것**이 가장 싸다 — hover/키보드 상태를 가르고 활성 표시를 `MentionAutocomplete`의 어휘로 맞추면 둘이 함께 닫힌다. H-4는 세 진입점이 실제 트리거를 넘기게 하는 한 줄이다.

---

## ② Findings 전량

### [Blocker]

| # | 파일:라인 | 요지 | 실측 근거 |
|---|---|---|---|
| **B-1** | `clients/web/src/features/emoji/EmojiPickerPanel.tsx:389-396` (`onMouseEnter` → `setActiveIndex`) · `:144-147` (Enter가 `visible[activeIndex]` 커밋) · `:402-403` (hover와 active가 같은 `bg-surface-hover`) | 검색 모드에서 **멈춰 있는 포인터가 키보드 선택을 가로챈다.** 화면에 구분 불가능한 선택 표시가 둘 뜨고, Enter가 사용자가 고르지 않은 이모지를 메시지에 넣는다 | 포인터를 🔥 칸에 두고 **마우스를 한 번도 움직이지 않은 채** "smile" 입력 → activeIndex **13**(0 아님, ☺️) → ArrowDown×2 → 15 → **Enter가 `🥲` 삽입**. 포인터를 화면 밖으로 치우면 0→1→2→3 정상(대조군 측정). 캡처 `33-hover-vs-keyboard-light-crop.png`, `33-hover-vs-keyboard-light.png` |

정본 근거: 오르트 구름 §5.3 16위 "화면이 거짓을 말함".
옳은 답이 옆 파일에 있다(코퍼스 최다 메타 패턴): `clients/web/src/features/chat/MentionAutocomplete.tsx:173-190` — 같은 컴포저 안의 같은 combobox+listbox 계약인데 `highlight`를 키보드만 쓰고, 포인터는 `onMouseDown`으로 곧장 확정하며, 활성 옵션은 `bg-accent-soft text-ink`를 입는다.
방향: 포인터 선택과 키보드 커서를 한 상태로 묶지 말 것. 포인터는 확정만 하거나, 최소한 실제 마우스 이동이 있었을 때만 커서를 옮길 것.

### [High]

| # | 파일:라인 | 요지 | 실측 근거 |
|---|---|---|---|
| **H-1** | `EmojiPickerPanel.tsx:403` · `:386` (`tabIndex={searching ? -1 : …}`) | 검색 모드 활성 표시가 다크 **1.078:1**, `outline: none`. 검색 중에는 DOM 포커스가 입력창에 남아 포커스 링이 구조적으로 켜질 수 없고, 이 옅은 중립 채움이 유일한 표시다 | 계산 스타일 실측: active `rgb(38,37,44)` / panel `rgb(32,31,36)` → **1.078:1**(라이트 1.269:1), `outlineStyle=none`. OKLab 거리 0.0262 vs 대안 `bg-accent-soft` **0.0517**. WCAG 1.4.11(3:1) 미달이고 §5.3이 "살 수 있는 도구가 없다"고 적은 축. 캡처 `12-search-active-option-dark-crop.png`, `12-search-active-option-light-crop.png` |
| **H-2** | `clients/web/src/features/emoji/` 전수(`content-visibility`·lazy render·가상화 **0건**) · `search.ts:5,18-24` · `EmojiPickerPanel.tsx:280` | 카테고리·검색 결과를 **전량 DOM 렌더**. 패킷 AC "전량 DOM 금지" 미충족. 게다가 `:` 한 글자(= Slack 사용자의 첫 타건)에 카테고리 탭 9개가 사라지며 34화면이 쏟아진다 | `:` → **1914 아이템 / 패널 DOM 3841 노드 / 630ms / scrollHeight 10856 vs client 320 = 34화면**. 첫 글자 `s` → 1335 아이템. `people` 탭 → 559 / 1179. `grep -rn "content-visibility\|Virtuoso\|virtual" src/features/emoji/` → PopoverAnchor `virtualRef` 1건뿐. 캡처 `13-search-single-colon-{light,dark}.png`, `22-mobile-colon-{light,dark}.png` |
| **H-3** | `EmojiPickerPanel.tsx:190-195`(죽은 Esc 핸들러) · `:225-226`(반대로 적힌 주석) | Esc 층 분리가 동작하지 않는다. React `stopPropagation`은 Radix DismissableLayer의 document 리스너를 막지 못해, 스킨 목록을 연 채 Esc 한 번에 **피커 전체가 닫힌다** | 런타임 프로브: `skin opened: true / picker: true` → `after Esc #1 -> skin: false / picker: false`. 주석이 화면과 다른 말을 하고 있다 |
| **H-4** | `clients/web/src/features/timeline/MessageRow.tsx:938`(`anchor={pickerOpener}`) · `:509-514`(폴백 `rowRef.current`) · 호출부 `:534, :916, :931` | ⋯ 메뉴·액션바·롱프레스에서 연 반응 피커가 **트리거가 아니라 메시지 행 전체**에 앵커된다. 패킷 "포인터=anchored popover(트리거 기준)" 위반 | ⋯ 트리거 x=1236 vs 팝오버 x=240 → **996px 이탈**, 대상 아닌 위쪽 메시지를 덮는다. 대조: 컴포저는 트리거 x=292 / 팝오버 x=292로 정확히 붙음. `ReactionChips.tsx:81`의 `+`만 실제 트리거를 넘긴다(정답이 같은 기능 안에 있다). 캡처 `19-reaction-picker-from-menu-{light,dark}.png` vs `u4-composer-emoji-light.png` |
| **H-5** | `EmojiPickerPanel.tsx:109-111`(무조건 autofocus) · `EmojiPickerDialog.tsx:137`(`fixed bottom-0`) · `tokens.css:1751-1755` | 터치 바텀시트가 검색창에 자동 포커스 → iOS 가상 키보드가 `fixed` 시트를 덮는다. `--app-viewport-height`는 `html/body/#root`에만 걸려 `position: fixed`를 따라오지 않는다 | 390×844 실측: 시트 y=425 h=419, **`document.activeElement` = `emoji-search`**. `MessageActions.tsx:508`의 기존 시트는 같은 클래스지만 입력창이 없어 이 창이 열리지 않았다 — 이것이 **입력을 자동 포커스하는 첫 바텀시트**다. 캡처 `21-mobile-sheet-{light,dark}.png`. **한계 고지: Playwright가 소프트 키보드를 렌더하지 못해 이 항목만 실렌더 증거 없음(코드 + 레포가 이미 문서화한 플랫폼 동작에서 추론)** |

### [Medium]

| # | 파일:라인 | 요지 | 실측 근거 |
|---|---|---|---|
| **M-1** | `EmojiPickerPanel.tsx:206`(placeholder "이름, 단축 코드로 찾기") · `:337`(빈 상태) · `features/emoji/emojiCatalog.json` | 한국어로 검색하면 0건인데 화면이 이유를 말하지 않는다. UI 전체가 한국어라 카피가 없는 능력을 약속한다. (i18n keyword 데이터 자체는 패킷이 **적립**했으므로 요구하지 않는다 — 요구하는 것은 카피와 빈 상태가 사실을 말하는 것) | 카탈로그 1914개 전수 **한글 문자열 0개**. "웃음"·"기쁨"·"하트"·"불" **4/4 → 0건**. 옵션 `aria-label`도 영어 CLDR 이름이라 스크린리더 경로도 동일. 캡처 `14-search-korean-zero-{light,dark}.png` |
| **M-2** | `EmojiPickerPanel.tsx:424`(`min-w-0 truncate`) vs `:426`(`shrink-0`) | 프리뷰 푸터가 **사람이 읽는 이름을 자르고 기계용 shortcode를 지킨다**. §3의 정신대로 값이 아니라 둘 사이 순서가 뒤집혔다 | 이름 `woman and man holding hands` scrollWidth **200** / clientWidth **112 (44% 절단)**, 같은 줄 `:man_and_woman_holding_hands:`는 **209.5px 전량 표시**(360px 안쪽 폭의 58%). 어순도 달라 잘린 "woman and ma…"는 shortcode로 복원되지 않는다. 캡처 `44-preview-name-clipped-crop.png` |
| **M-3** | `EmojiPickerPanel.tsx:248-276`(바깥 클릭 닫기 없음) · `:232`(`aria-haspopup="listbox"`인데 `aria-controls`·포커스 이동 없음) | 스킨톤 목록이 카테고리 탭 클릭 후에도 열린 채 **탭 5/9개(활동·장소·물건·기호·깃발)를 덮는다.** 탈출은 ✋ 재클릭뿐이고 Esc는 H-3 때문에 피커째 닫는다 | 프로브: `after category click while skin open -> skin still open: true`. 캡처 `31-skinlist-stays-open-light-crop.png` |
| **M-4** | `clients/web/src/features/chat/Composer.tsx:807-816`(`disabled={offline}` 주석 없이 삭제) vs `:806` `AttachButton`(유지) · `vite.config.ts` sw는 `entry.imports`(정적)만 프리캐시 | 오프라인이 네 상태 중 하나로 설계되지 않았다. 카탈로그가 동적 import 청크라 오프라인 첫 열기는 반드시 실패하고, 일반 에러 + 성공할 수 없는 「다시 시도」로 표시된다. 형제 둘이 다른 답(코퍼스 10위 패턴) | 청크 요청 abort → `catalog fetch aborted -> error banner: true`. 에러 상태 자체는 잘 만들어져 있다(인라인·토스트 없음·행동 하나). 빠진 것은 **오프라인을 오프라인이라 부르는 문장**(오르트 구름 §4). 캡처 `32-catalog-load-error-light-crop.png` |
| **M-5** | `clients/mobile/src/features/conversation/MessageActionSheet.tsx:53-61` | 폰이 전체 피커를 안 싣는 근거로 적어 둔 "웹은 …32개짜리 격자를 연다" 문장이 이 PR로 거짓이 됐다. 새 능력(1914 glyph·빈도 store·스킨톤)은 전부 웹 로컬 — 코퍼스 2위 패턴(패리티 분기 18건/8리포트)이 이렇게 시작한다. 후속 티켓 수용 가능하되 **누가 언제**를 적어야 한다 | 해당 주석 원문 확인 · `packages/momo-core`에 새 상수 0건 |

### [Nitpick]

| # | 파일:라인 | 요지 | 근거 |
|---|---|---|---|
| **N-1** | `EmojiPickerPanel.tsx:206` vs `:210` | placeholder만 "찾기"이고 "단축 코드"는 레포 첫 등장 용어. 자기 `aria-label`조차 "이모지 검색"이다 | grep: `SearchRoute.tsx:199`·`DirectoryRoute.tsx:205`·`PluginSection.tsx:317`·`AgentHubRoute.tsx:1213`·`AddChannelMemberDialog.tsx:394` 전부 "…검색" |
| **N-2** | `EmojiPickerPanel.tsx:26-31` | 스킨톤 라벨 접미사 혼용("기본 피부**색**" vs "밝은 **피부**" ×5) | 소스 |
| **N-3** | `EmojiPickerPanel.tsx:352-367` · `frequencyStore.ts:72` | `emoji-frequent-empty`("자주 쓰는 이모지가 여기 모입니다")는 도달 불가 — 항상 32종 시드로 폴백한다 | `catalog.test.ts`가 시드 전량 해석을 단정 |
| **N-4** | `EmojiPickerPanel.tsx:330-332` | 에러 문장이 버튼 라벨을 반복한다("…다시 시도하세요." + [다시 시도]) | `32-catalog-load-error-light-crop.png` |
| **N-5** | `EmojiPickerPanel.tsx:417`(`aria-live="polite"`) + `:388`(`aria-label`) | 화살표 이동마다 이중 낭독 | 소스 |
| **N-6** | `EmojiPickerDialog.tsx:84` | 렌더 도중 ref에 대입한다 | 소스 |
| **N-7** | `EmojiPickerPanel.tsx:286`(`flex flex-wrap gap-1`) | 390에서 카테고리 탭이 7+2로 접혀 둘째 줄에 고아 둘이 남는다. 가로 오버플로는 0 | `21-mobile-sheet-{light,dark}.png` |
| **N-8** | `EmojiPickerPanel.tsx:399-402` | 폰 이모지 칸 42×42로 `--tap-target` 44 미만(2.5.8의 24 바닥선은 통과, 근거 주석 있음). `MOBILE_TAP_TARGETS`는 **허용목록**이라 이 칸을 애초에 보지 않는다(§5.5②) — 초록이 이를 증명하지 않았다는 사실만 기록 | 실측 셀 42.0×42.0 · `clients/web/scripts/capture-screens.mjs:121-131` |

### 되돌리지 말 것 (잘 된 것)

- **키보드 순회가 정확하다.** 실측 탭 스톱 4개의 닫힌 순환: 검색 → 스킨톤 → 카테고리(roving 1스톱) → 그리드(roving 1스톱) → 검색. **모든 정거장에 2px 앰버 포커스 링**(`outline: solid 2px rgb(165,76,8)`) 실측 확인.
- 토큰 규율 완벽: hex 0 · 임의값 0 · 인라인 스타일 0 · 그림자 어휘 2단. `--spacing-pane-picker: 384px`가 **이름 + 산술 근거 주석**을 달고 §6 절차대로 들어왔고 `cn.ts`·`tokens.md`·`designSystem.test.ts`·`controlBorders.test.ts`가 같은 PR에서 갱신됐다.
- 프리미티브 선택이 옳고 그 이유가 `popover.tsx:11-17`에 한 줄로 적혀 있다(DropdownMenu가 아닌 이유, 애니메이션·화살표 없음 — 집안 규율 유지).
- 빈도 정렬 count desc + glyph tie-break 실측 확인(2×🚀 1×🐛 → `["🚀","🐛",…seed]`), recency 없음(MM #19258 근거 유지).
- 스킨톤이 컴포저·반응 두 표면에 걸쳐 persist(`19-reaction-picker-from-menu-light.png`에 👍🏿).
- 900px·사이드바 접힘에서 팝오버가 뷰포트를 벗어나지 않는다(실측 x=292..676 / 108..492).
- 카탈로그가 별도 청크(gzip 48.53 kB)라 초기 번들에 얹히지 않는다.

---

## ③ 기계 프리플라이트 표

`scripts/design_preflight_web.sh` → **EXIT=0, PASS**

| 레인 | 결과 |
|---|---|
| web 12분류 | emdash 0 · raw_color 0 · inline_style 0 · arbitrary_tw 0 · ai_gradient 0 · toast 0 · naked_focus 0 · external_font 0 · hype 0 · pure_bw 0 · progress_word 0 · latin_particle 0 → **12/12 clean** |
| core 5분류 (AST) | emdash 0 · progress_word 0 · latin_particle 0 · raw_color 0 · hype 0 → **5/5 clean** |
| `npx tsc -b` | rc=0 |
| `npx vitest run src/design src/features/emoji src/features/chat/composerParity.test.ts` | 16 files / **144 tests 전부 통과** (`designSystem`·`cn`·`controlBorders`·`chipVessel`·`focusRing`·`transitionColors`·`tokens.contrast`·`popover`·`catalog`·`search`·`frequencyStore`·`skinToneStore` 포함) |
| `npm run build` | 성공. `emojiCatalog-CX6tsjFf.js` 176.39 kB / **gzip 48.53 kB** (예산 120 kB의 40%) |
| `npm run capture:design` | 완주, 두 스킴 + 폰 프로파일. 미대응 `/v1` 2건(이 티켓과 무관: hosted-agent-connections, notification-rules) |
| **폰 (`clients/mobile`)** | **기계 프리플라이트가 존재하지 않는다.** 이 PR은 폰 파일을 변경하지 않아 해당 레인 없음 — 빈 칸으로 두지 않고 명시한다 (오르트 구름 §5.4) |

프리플라이트 원문:

```
== design pre-flight (web), SKILL momo-design-taste-web §10 ==
   scanned: clients/web/src, clients/web/index.html
   excluded: src/design/tokens.css, src/design/tokens.contrast.test.ts
   emdash·progress_word·latin_particle: AST (문자열 리터럴·JSX 텍스트만, *.test.ts(x)·*.d.ts 제외) — #1141·#1511

OK    emdash: 0          OK    raw_color: 0       OK    inline_style: 0
OK    arbitrary_tw: 0    OK    ai_gradient: 0     OK    toast: 0
OK    naked_focus: 0     OK    external_font: 0   OK    hype: 0
OK    pure_bw: 0         OK    progress_word: 0   OK    latin_particle: 0
OK    web: 12/12 categories clean.

== design pre-flight (core), 이슈 #1141 ==
OK    emdash: 0   OK    progress_word: 0   OK    latin_particle: 0   OK    raw_color: 0   OK    hype: 0
RESULT: PASS, 5/5 categories clean.

RESULT: PASS, web 12/12 + core 5/5 categories clean.
EXIT=0
```

> **그렙 층은 완전히 깨끗하다. 위 findings는 전부 §5.3의 "아무것도 재지 않는 축"에서 나왔으므로, 이 건에 "게이트가 잡았어야 했다"는 문장은 성립하지 않는다.**

---

## ④ 캡처 검증 상태 목록

저장 위치: `claudedocs/design-review-1746/` (총 42장). 별도 표기 없으면 **light + dark 양쪽**, 데스크톱은 1280×800 @2x, 폰은 390×844 @3x.

| # | 상태 | 파일 |
|---|---|---|
| 1 | 기본 오픈 — 컴포저 popover, 빈도 탭 32종 (1280) | `u4-composer-emoji-{light,dark}.png` |
| 2 | 기본 오픈 — 반응 피커 (정규 캡처 레인) | `b11-reaction-picker-{light,dark}.png` |
| 3 | 검색 히트 — 단축 코드 `tada` → 1건 | `11-search-tada-{light,dark}.png` |
| 4 | 검색 활성 옵션 — combobox 모드 26건 | `12-search-active-option-{light,dark}.png` + `-crop` 2장 |
| 5 | 검색 `:` 한 글자 → 1914건 · 카테고리 탭 소실 | `13-search-single-colon-{light,dark}.png` |
| 6 | **검색 0건 — 한국어 쿼리** | `14-search-korean-zero-{light,dark}.png` |
| 7 | **스킨톤 셀렉터 열림** | `15-skintone-open-{light,dark}.png` |
| 8 | **스킨톤 적용 (tone 5)** | `16-skintone-applied-{light,dark}.png` |
| 9 | 카테고리 브라우징 — people 559건 | `17-category-people-{light,dark}.png` |
| 10 | **빈도 섹션 채워진 상태** (2×🚀 1×🐛 후) | `18-frequent-filled-{light,dark}.png` |
| 11 | ⋯ 메뉴 진입 반응 피커 (앵커 이탈) | `19-reaction-picker-from-menu-{light,dark}.png` |
| 12 | 폰 390 바텀시트 (탭 wrap · 검색 자동 포커스) | `21-mobile-sheet-{light,dark}.png` · 정규 레인 `mobile-composer-emoji-{light,dark}.png` |
| 13 | 폰 390 `:` 전량 렌더 | `22-mobile-colon-{light,dark}.png` |
| 14 | 스킨 목록 잔류 — 카테고리 탭 5개 가림 | `31-skinlist-stays-open-light.png` + `-crop` |
| 15 | **에러 상태** — 카탈로그 로드 실패 + 재시도 | `32-catalog-load-error-light.png` + `-crop` |
| 16 | hover ↔ 키보드 충돌 — 선택 표시 2개 동시 | `33-hover-vs-keyboard-light.png` + `-crop` |
| 17 | 900px 뷰포트 | `41-popover-900w-light.png` |
| 18 | 900px 프리뷰 절단 맥락 | `42-preview-truncation-900w-light.png` + `-crop` |
| 19 | 900px **사이드바 접힘** | `43-popover-sidebar-collapsed-900w-light.png` |
| 20 | 프리뷰 이름 절단 실물 | `44-preview-name-clipped-light.png` + `-crop` |

**미검증 고지 (추측하지 않은 것):**

- **로딩 스켈레톤** — 카탈로그 promise가 모듈 캐시라 첫 오픈 순간에만 존재해 안정적으로 촬영하지 못했다. 코드 검토로만 확인: `SkeletonRows rows={6}`, 시머 없음, 높이 보존 계열(`h-6 rounded-sm bg-surface-hover`) — §4 규칙 부합.
- **소프트 키보드가 올라온 폰 프레임** (H-5) — Playwright가 가상 키보드를 렌더하지 못한다. 해당 항목만 코드 + 문서화된 플랫폼 동작에서 추론했고 본문에 그렇게 표기했다.
