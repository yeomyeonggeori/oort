# Design Review R2 (재리뷰) — clients/web 이모지 피커 (UX-EB / #1742 / PR #1746)

- 대상: `feat/1742-uxeb-emoji-picker` @ **cfc23943** (수리 4커밋: `dfb612d3` → `27d9862c` → `14131965` → `cfc23943`)
- 1차 정본: 같은 디렉터리 `REPORT.md` (findings 19건)
- 방법: **1차와 같은 방법으로 재측정** — 런타임 프로브(Playwright, 복제 하네스 `/tmp/eb-review/`), 계산 스타일 실측, 두 스킴 재캡처. 캡처는 `r2-` 접두사.
- 리뷰 중 레포 파일은 한 줄도 수정하지 않았다.

---

## ① 최종 판정

**FAIL (Blockers: 2)**

1차 19건 중 **18건 CLOSED · 1건 STILL-OPEN(등급 상승)**. 수리의 질은 높다 — 1차 Blocker와 High 5건 중 원 결함은 전부 실측으로 닫혔다. 그러나 **수리 두 건이 새 결함을 만들었고 둘 다 Blocker급**이다.

| 등급 | 1차 잔존 | 신규 | 계 |
|---|---|---|---|
| Blocker | 0 | 2 | **2** |
| High | 0 | 0 | 0 |
| Medium | 0 | 1 | 1 |
| Nitpick | 1(승격되어 Blocker로 이동) | 3 | 3 |

핵심 한 줄: **`npm run capture:design`이 exit 1로 죽는다.** 팀 리드가 보고한 게이트 3종(tsc·vitest·프리플라이트)에는 캡처 레인이 없었고, 패킷 AC는 `capture:design 갱신(light/dark)`을 명시한다. 지금 `artifacts/design`의 폰 프레임은 **수리 이전(R1) 것 그대로**다.

---

## ② 1차 findings 19건 재측정 — CLOSED / STILL-OPEN

### 1차 Blocker

| # | 판정 | 재측정 (1차와 같은 방법) |
|---|---|---|
| **B-1** 포인터가 키보드 커서를 가로챔 · 선택 표시 2개 · Enter 오삽입 | **CLOSED** | 포인터를 🔥 칸에 두고 **한 번도 움직이지 않은 채** "smile" 입력 → active = **"grinning face"(index 0)** ✅ (1차: index 13). ArrowDown×2 → **"grinning face with smiling eyes"** ✅. **Enter 삽입 결과 `😄`** ✅ (1차: `🥲`). 채움을 가진 칸 수 = **1** ✅ (1차: 2). 수리: `onMouseEnter` → `onPointerMove` + 좌표 가드(`EmojiPickerPanel.tsx:236-244`), `hover:bg-surface-hover` 제거. 회귀 가드 신설 `EmojiPickerPanel.test.tsx:137,158`. 캡처 `r2-02-search-active-option-{light,dark}.png` |

### 1차 High

| # | 판정 | 재측정 |
|---|---|---|
| **H-1** 활성 표시 다크 1.078:1 · 링 없음 | **CLOSED (지정한 방향대로)** | active 채움이 `--accent-soft`로 바뀜. 다크 `rgb(51,38,26)` on `rgb(32,31,36)` → 대비 **1.117**, OKLab **0.0262 → 0.0517(2배)**. 라이트 `rgb(244,231,214)` on `rgb(255,254,251)` → 1.207. `text-ink` 동반. 1차가 이름 댄 형제 패턴(`MentionAutocomplete`)과 같은 어휘. 잔여는 시스템 차원 항목으로 분리 → **R2-N1** |
| **H-2** 전량 DOM (AC 「전량 DOM 금지」) | **CLOSED** | `:` 한 글자 → **마운트 32 / 패널 DOM 125 / 카테고리 탭 유지** ✅ (1차: 1914 / 3841 / 탭 소실). `s` → **96** ✅ (1차: 1335). people → **96 / 311**, scrollHeight 3164 보존 ✅ (1차: 559 / 1179). 폰도 동일(`:` → 32). 수리: `gridWindow.ts` 96칸 창 + `emoji-grid-row-pad`(`content-visibility: auto`, `100cqw` 산술), `isEmojiSearchQuery`. 잔여 아티팩트 → **R2-M1**. 캡처 `r2-03-colon-*.png`, `r2-04-category-people-*.png` |
| **H-3** Esc 층 분리가 죽은 코드 | **CLOSED** | Esc#1 → skin=false **picker=true** ✅ (1차: 둘 다 닫힘). Esc#2 → picker=false ✅. 수리: 핸들러를 셸의 `onEscapeKeyDown`으로 올림(`EmojiPickerDialog.tsx:128-132,157,181`), 패널의 `stopPropagation` 제거, 주석도 사실로 정정. 가드 `EmojiPickerPanel.test.tsx:202` |
| **H-4** 반응 피커가 행 전체에 앵커 | **CLOSED** | ⋯ 트리거 x=1236 / 팝오버 x=888 w=384 → 팝오버가 트리거 열을 **감싼다**. **dx = -348**(1차: -996, 트리거에서 996px 이탈). 수리: `MessageRow.tsx:507,536,918-920,934`가 `actionTriggerRef`를 세 진입점 전부에 넘김. **회귀 확인**: Esc 뒤 포커스 = `message-actions-trigger`(살아 있는 실제 컨트롤) ✅. 캡처 `r2-09-reaction-anchor-{light,dark}.png` |
| **H-5** 터치 시트 검색창 자동 포커스 | **원 결함 CLOSED · 수리가 새 Blocker 생성** | `autoFocusSearch={!isTouch}` + 시트 `onOpenAutoFocus` preventDefault로 **자동 포커스는 사라졌다** ✅. 그러나 그 결과 모달 시트가 **포커스를 모달 밖에 남긴다** → **R2-B2** |

### 1차 Medium

| # | 판정 | 재측정 |
|---|---|---|
| **M-1** 한국어 0건에 설명 없음 | **CLOSED** | placeholder = `"영문 이름, :code:로 검색"` ✅. 빈 상태 = `"찾는 이모지가 없습니다 | 영문 이름이나 :code:로 검색하세요. 한글 검색은 아직 없습니다. | 검색 지우기"` ✅. 캡처 `r2-06-korean-zero-{light,dark}.png` |
| **M-2** 이름을 자르고 shortcode를 지킴 | **CLOSED** | `woman and man holding hands` sw=200 **cw=200 (절단 0)** ✅ (1차: cw=112, 44% 절단). shortcode가 `min-w-0 truncate`로 자리를 양보하고 푸터는 `flex-wrap`으로 두 줄이 된다. 캡처 `r2-07-preview-longname-crop.png` |
| **M-3** 스킨 목록 바깥 클릭 닫기 없음 | **CLOSED** | 카테고리 탭 클릭 → skin **닫힘** ✅ (1차: 열린 채 탭 5개를 덮음). 바깥 pointerdown → 닫힘 ✅. `aria-controls` 추가 ✅ |
| **M-4** 오프라인이 네 상태에 없음 | **CLOSED** | 온라인 로드 실패 = `"이모지 목록을 불러오지 못했습니다. | 다시 시도"`, 오프라인 = `"지금 오프라인입니다. 연결되면 다시 여세요. | 다시 시도"` — 두 문장이 갈렸다 ✅. 캡처 `r2-30-load-error-light.png`, `r2-31-offline-light.png` |
| **M-5** 폰 패리티 주석이 거짓 | **CLOSED** | `clients/mobile/.../MessageActionSheet.tsx:55-61` 갱신 + 후속 티켓 **#1748** 인용 ✅ |

### 1차 Nitpick

| # | 판정 | 재측정 |
|---|---|---|
| **N-1** "찾기"/"단축 코드" 용어 이탈 | **CLOSED** | placeholder가 `"…로 검색"`으로 형제 5개 표면과 정렬, "단축 코드" → `:code:` |
| **N-2** 스킨톤 라벨 접미사 혼용 | **CLOSED** | `기본 피부색` → `기본 피부` (`EmojiPickerPanel.tsx:34`) |
| **N-3** 도달 불가 빈 상태 | **CLOSED (삭제로)** | 분기 제거(`visible.length === 0 ? null`). 잔여 → **R2-N2** |
| **N-4** 에러 문장이 버튼을 반복 | **CLOSED** | `"이모지 목록을 불러오지 못했습니다."` (뒷문장 제거) |
| **N-5** 프리뷰 이중 낭독 | **CLOSED** | 실측 `aria-hidden="true"` ✅ |
| **N-6** 렌더 도중 ref 대입 | **CLOSED** | `useMemo` (`EmojiPickerDialog.tsx:85-91`) |
| **N-7** 폰 탭 7+2 고아 | **STILL-OPEN — 등급 상승 → R2-B1** | `flex-wrap` → `flex-nowrap overflow-x-auto`로 바꾼 수리가 **선언 없는 가로 스크롤 상자**를 만들었다 |
| **N-8** 폰 칸 42<44 | **CLOSED (수용·명시)** | 실측 42.0×42.0 그대로이나 코드가 허용목록 사각지대(오르트 구름 §5.5②)를 주석으로 자백(`EmojiPickerPanel.tsx:472-473`) |

**소계: 18 CLOSED / 1 STILL-OPEN(승격).**

---

## ③ 신규 findings (수리가 만든 것)

### [Blocker] R2-B1 — 폰 카테고리 탭 행이 **선언 없는 가로 스크롤 상자**가 됐다. 캡처 레인이 죽고 탭 2개가 화면 밖으로 나갔다

`EmojiPickerPanel.tsx:356`: `flex flex-wrap gap-1` → `flex flex-nowrap gap-1 overflow-x-auto` (+ 탭에 `shrink-0`).

**증거 1 — 게이트가 빨갛고 런이 중단된다.** `npm run capture:design` 재현 **exit 1**:

```
Error: 가로 오버플로 emoji picker light: 세로 스크롤 상자 1개가 가로로도 끌린다
    div.flex.flex-nowrap.gap-1: 428px 내용 / 364px 상자 (+64)
      밀어낸 것: [data-testid=emoji-cat-flags] (+64px)
    at assertNoHorizontalOverflow (scripts/capture-screens.mjs:1825)
    at async captureMobile (scripts/capture-screens.mjs:2886)
```

이 하네스의 규칙은 그 자리에 적혀 있다: **면제는 게이트가 아니라 컴포넌트가 `data-scroll-x`로 선언한다.** 실측 `dataScrollX: false`. 그리고 런이 여기서 죽으므로 **폰 light 이후 프레임과 폰 dark 전량이 생성되지 않는다** — `artifacts/design/mobile-composer-emoji-{light,dark}.png` 타임스탬프가 수리 이전(00:33/00:34)에 멈춰 있다. 패킷 AC `capture:design 갱신(light/dark)` 미충족.

**증거 2 — 사람이 보는 결과.** 390에서 tablist `scrollWidth 428 / clientWidth 364`, 밴드 밖으로 나간 탭: `emoji-cat-symbols`(기호, +16px) · `emoji-cat-flags`(깃발, **+64px, 완전 비가시**). 스크롤 어포던스는 `#`가 반쯤 잘려 보이는 것뿐이고, iOS에는 상시 스크롤바가 없다. 1차 N-7(둘째 줄에 고아 둘)을 고치려다 **9개 중 2개를 화면에서 지웠다.** 캡처 `r2-42-mobile-tabs-cut-crop.png`, `r2-20-mobile-sheet-{light,dark}.png`.

가로 스크롤 탭 행 자체는 정당한 폰 패턴이다. Blocker인 이유는 ①명시된 증거 레인이 빨갛고 런이 중단된다 ②그 면제를 컴포넌트가 선언하지 않았다 ③어포던스 없이 탭 하나가 완전히 사라졌다 — 셋이 함께다.

### [Blocker] R2-B2 — 터치 시트가 **모달 밖에 포커스를 남기고**, 첫 Tab이 시트 뒤 컨트롤에 닿는다

H-5 수리(`autoFocusSearch={!isTouch}` + `onOpenAutoFocus` preventDefault, `EmojiPickerDialog.tsx:157-160`)가 자동 포커스를 없앴지만 **아무 데도 포커스를 옮기지 않는다.**

실측(390, 시트 열림 y=473 h=371):

| 시점 | activeElement | 시트 안인가 | `aria-hidden` 조상 |
|---|---|---|---|
| 열린 직후 | `composer-emoji-trigger` | **false** | **true** |
| Tab ×1 | `composer-input` | **false** | **true** |
| Tab ×2 | `emoji-search` | true | false |
| Tab ×3 | `emoji-skin-toggle` | true | false |

즉 모달이 열려 있는 동안 **키보드가 시트 뒤(스크림 아래, 시트가 덮은 영역)의 컨트롤 둘에 닿고**, 그 둘은 Radix가 `aria-hidden="true"`로 감춘 서브트리 안에 있다. 루브릭의 ADR-0112 D6 상시-Blocker 목록 그대로다: *"a control that the keyboard can reach while the eye cannot see it."* Radix FocusScope의 트랩은 포커스가 한 번도 스코프 안에 들어간 적이 없어서 작동하지 않는다.

Esc는 여전히 시트를 닫는다(실측 true)므로 갇히지는 않는다. 방향: 검색창을 포커스하지 않는 것과 **모달 안으로 포커스를 옮기지 않는 것**은 다른 결정이다 — 시트 컨테이너나 `DialogTitle`로 옮기면 키보드 경로를 지키면서 키보드도 안 올라온다. 캡처 `r2-20-mobile-sheet-{light,dark}.png`.

### [Medium] R2-M1 — 창 렌더의 아래쪽 경계가 **스크롤이 멈춘 상태에서도 빈 띠로 보인다**

H-2 수리의 96칸 창은 `scrollAnchor`를 중심으로 잡는데(`gridWindow.ts:23-33`), 창의 절반(6행)이 위로 가므로 아래쪽 여유가 보이는 7행보다 얕다. 스크롤 후 **600ms 정착시킨 뒤** 실측한 밴드 내 빈 패드 비율:

| 스크롤 위치 | 밴드 320px 중 빈 패드 | 실제 이모지 행 |
|---|---|---|
| 25% | 25px (**8%**) | 7행 |
| 50% | 43px (**13%**) | 6행 |
| 90% | 41px (**13%**) | 7행 |

내용이 사라지는 것은 아니고(더 스크롤하면 채워진다) 가로 오버플로도 없지만, 카테고리 브라우징이라는 주 경로에서 매번 아래쪽에 빈 줄 하나가 남는다. 캡처 `r2-40-scroll-mid-crop.png`, `r2-40-scroll-{0_25,0_5,0_9}-light.png`.

### [Nitpick]

| # | 파일:라인 | 요지 | 근거 |
|---|---|---|---|
| **R2-N1** | `EmojiPickerPanel.tsx:496` | 활성 표시가 `--accent-soft`로 옳게 바뀌었지만 **luminance 대비는 여전히 1.117(다크)·1.207(라이트)**로 WCAG 1.4.11의 3:1 미달이다. 이 팔레트의 어떤 soft 채움도 그 자를 넘지 못한다(오르트 구름 §2.2가 그 산술을 적어 둔다). **이 PR의 부채가 아니라 시스템 차원 미결**로 옮겨 적는다 — §5.3 "비텍스트 대비를 살 수 있는 곳: 없다" | 계산 스타일 실측 |
| **R2-N2** | `EmojiPickerPanel.tsx:429` | N-3을 분기 삭제로 닫으면서, 빈 목록이 **문장 하나 없는 빈 상자**로 렌더된다. 오늘은 도달 불가(시드 32종 폴백)지만 §4의 "모든 표면이 빈 상태를 갖고 출하한다"는 이제 코드에 없다 | 소스 |
| **R2-N3** | `EmojiPickerDialog.tsx:20` | import 뒤 이중 빈 줄 | 소스 |

---

## ④ "되돌리지 말 것" 절 재확인 — 전부 보존

| 항목 | R1 | R2 재측정 | 판정 |
|---|---|---|---|
| **키보드 4스톱 닫힌 순환** | 검색→스킨→카테고리→그리드→검색 | light·dark 동일: `emoji-skin-toggle → emoji-cat-frequent → picker-insert-😄 → emoji-search → (반복)` | **보존** ✅ |
| **전 정거장 포커스 링** | 2px 앰버 | 라이트 `solid/2px/rgb(165,76,8)` · 다크 `solid/2px/rgb(240,168,80)` (light-dark() 정상) | **보존** ✅ |
| **900px 안전** | x=292..676 | **x=292 w=384** (292..676) | **보존** ✅ |
| **900px 사이드바 접힘** | x=108..492 | **x=108 w=384** (108..492) | **보존** ✅ |
| 패널 기하 | 384×324 | 384×324 (light·dark 동일) | **보존** ✅ |
| 컴포저 앵커 정확도 | 트리거 x=292 / 팝오버 x=292 | 동일 | **보존** ✅ |
| 빈도 정렬(count desc) | `["🚀","🐛",…seed]` | 2×🚀 1×🐛 후 **`["🚀","🐛","👍️","👎️","✅️","❌️"]`** | **보존** ✅ |
| 스킨톤 persist | 👍🏿 | tone 5 적용 후 `picker-insert-👍️` 렌더 글리프 = **`👍🏿`** | **보존** ✅ |
| 토큰 규율 | 프리플라이트 12/12+5/5 | **12/12 + 5/5, EXIT=0** | **보존** ✅ |
| 카탈로그 청크 분리 | gzip 48.53 kB | 빌드 성공, 동일 | **보존** ✅ |

**새로 깨진 것은 위 표 밖의 두 자리(R2-B1 폰 탭 행 · R2-B2 터치 포커스)뿐이고, 둘 다 수리 커밋 `27d9862c`가 만든 것이다.**

---

## ⑤ 기계 레인 재실행 결과

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS** — web 12/12 + core 5/5, EXIT=0 |
| `npx tsc -b` | **rc=0** |
| `npx vitest run` (전량) | **1475/1475 PASS**, 104 files. 신설 가드 `EmojiPickerPanel.test.tsx`(7) · `gridWindow.test.ts`(4) · `search.test.ts` 4→6 · `composerParity.test.ts` 강화 확인 |
| `npm run build` | 성공, `emojiCatalog` gzip 48.53 kB |
| **`npm run capture:design`** | **FAIL — exit 1** (2회 재현). `assertNoHorizontalOverflow`가 폰 light 이모지 피커에서 던지고 런이 중단된다 → **R2-B1** |
| **폰(`clients/mobile`)** | **기계 프리플라이트가 존재하지 않는다.** 이번 diff는 `MessageActionSheet.tsx` 주석 1건만 건드렸다 — 빈 칸으로 두지 않고 명시한다 (오르트 구름 §5.4) |

> 참고(결함 아님): 백그라운드 `capture:design`과 동시에 돌린 첫 `vitest run`에서 2건이 빨갰다. 둘은 `preview-guard.contract.test.mjs`·`gate-shell-layout.contract.test.mjs`로 **vite preview 포트를 점유하는 계약 테스트**이고, 캡처 종료 뒤 단독 재실행에서 1475/1475 초록이었다. 리뷰어 측 포트 경합이며 PR의 결함이 아니다.

---

## ⑥ R2 캡처 목록 (`claudedocs/design-review-1746/`, `r2-` 접두사 34장)

| 상태 | 파일 |
|---|---|
| 기본 오픈(빈도 32종) | `r2-01-open-{light,dark}.png` |
| 검색 활성 옵션 — 단일 마커 · accent-soft | `r2-02-search-active-option-{light,dark}.png` |
| `:` 한 글자 — 탭 유지 · 32칸 | `r2-03-colon-{light,dark}.png` |
| 카테고리 people — 96칸 창 | `r2-04-category-people-{light,dark}.png` |
| people 중간 스크롤 | `r2-05-people-midscroll-{light,dark}.png` · `r2-40-scroll-{0_25,0_5,0_9}-light.png` · `r2-40-scroll-mid-crop.png` |
| 한국어 0건 + 새 안내 문장 | `r2-06-korean-zero-{light,dark}.png` |
| 긴 이름 프리뷰(절단 0, 두 줄) | `r2-07-preview-longname-{light,dark}.png` · `r2-07-preview-longname-crop.png` |
| 스킨톤 열림 | `r2-08-skin-open-{light,dark}.png` |
| ⋯ 진입 반응 피커 앵커 | `r2-09-reaction-anchor-{light,dark}.png` |
| 900px / 사이드바 접힘 | `r2-10-900w-light.png` · `r2-11-900w-collapsed-light.png` |
| 폰 시트 | `r2-20-mobile-sheet-{light,dark}.png` |
| 폰 `:` | `r2-21-mobile-colon-{light,dark}.png` |
| 로드 실패 / 오프라인 | `r2-30-load-error-light.png` · `r2-31-offline-light.png` |
| 빈도·스킨 회귀 | `r2-41-frequency-skin-light.png` |
| **폰 탭 2개 화면 밖** | `r2-42-mobile-tabs-cut-light.png` · `r2-42-mobile-tabs-cut-crop.png` |

미검증(추측하지 않은 것): **소프트 키보드가 올라온 폰 프레임** — Playwright가 가상 키보드를 렌더하지 못한다. R2-B2는 그 대신 포커스 소유권을 직접 측정했다(위 표).

---

## ⑦ 다음 걸음 (픽셀 아님)

1. **R2-B1** — 탭 행이 가로로 끌리는 것이 의도라면 컴포넌트가 `data-scroll-x`로 그렇게 선언해야 하고(하네스가 요구하는 형식), 어포던스 없이 사라진 「깃발」을 사람이 찾을 수 있어야 한다. 선언이든 되돌림이든, **판정 기준은 `capture:design`이 초록으로 완주하는 것**이다.
2. **R2-B2** — "검색창을 포커스하지 않는다"와 "모달 안으로 포커스를 옮기지 않는다"를 분리할 것.
3. **R2-M1** — 창의 중심을 스크롤 앵커가 아니라 보이는 밴드의 위쪽에 맞추면 아래 여유가 깊어진다.
4. R2-N1은 이 PR이 아니라 시스템 미결로 옮겨 적기를 권한다(§5.3 표에 이미 자리가 있다).

**재리뷰 판정: FAIL (blockers: 2).** 1차 19건 중 18건은 실측으로 닫혔고, 남은 것은 수리가 새로 연 두 자리다.
