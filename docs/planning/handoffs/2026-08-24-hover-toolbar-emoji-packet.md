# 호버 퀵액션 툴바·이모지 피커 고도화 패킷 — UX-EB · UX-HT

> Status: `ready` (성재 직접 발제 2026-08-24 — 스크린샷 3장 + "반영해줘") · Planning ID: `PLN-20260822-01` 연장 · Planner owner: Fable · Integrator: momo-main
> 발급: 2026-08-24 · 기준: origin/track/uxui (main sync-18 이후) · 근거 리서치: `research/2026-08-24-hover-toolbar-emoji-picker-reference.md`(3사 행동 계약·데이터 소싱 실측·a11y 패턴 — **필독**)
> ADR: not required(UI 범위 — 단 아래 "결정 supersede" 2건은 코드 주석·디자인 정본을 같은 PR에서 개정)
> GitHub binding: UX-EB=#1742 · UX-HT=#1743 (2026-08-24 발급) · 워커: grok 병렬 1 순차(UX-EB → UX-HT) · design-review Blocker 0 각각 필수

## 0. 결정 supersede (같은 PR 문서 갱신 의무)

1. **#1688 "고정 32종·중앙 Dialog"** → 어휘·모달 supersede(성재 지시 2026-08-24). **무라이브러리 결정은 유지**(자작). `EmojiPickerDialog.tsx` 헤더 주석 개정.
2. **B11/디자인 스킬 §6 "행 액션은 메뉴로"** → 가시 호버 툴바 재도입(성재 지시). R1 실패 원인 2건의 해소를 계약으로: ①비호버 행 **조건부 렌더**(opacity 트릭 금지 — 탭스톱 상시 0) ②**WAI-ARIA toolbar/roving tabindex**(툴바 전체=탭스톱 1). `MessageActions.tsx` B11 주석 + 디자인 시스템 §6 해당 절 같은 PR 개정.

## 1. UX-EB — 이모지 피커 고도화 (선행)

**사실**: `clients/web/src/features/emoji/EmojiPickerDialog.tsx`(92L, 고정 32종 그리드·중앙 Dialog) · 소비처 = 컴포저(`useComposerEmoji.ts`)·리액션(`MessageActions`·`ReactionChips`)·스레드. 디자인 프리미티브: `@/design/ui/dialog`·dropdown — popover 프리미티브 유무는 워커가 확인 후 없으면 디자인 시스템 관례로 신설.
**작업**:
- 데이터: `emojibase-data` compact(en) + **iamcal(Slack) shortcode preset**을 빌드타임 추출해 same-origin 번들(예산 ≤120kB gz — 실측치를 PR에 기재). 네이티브 글리프만, 외부 fetch 0(CSP).
- 표면: 포인터=**anchored popover**(트리거 기준, 화면 경계 flip) / 터치=바텀시트. 폭 340–440px급.
- 기능(P0): 검색(이름+shortcode+keyword, 초기 포커스) · 카테고리 탭(frequent→people→nature→foods→activity→places→objects→symbols→flags) · **Frequently used**(사용 추적 store 신설 — frequency 기반, recency 금지, v1=클라 로컬 지속) · 프리뷰 푸터(글리프+이름+`:shortcode:`).
- 기능(P1, 같은 티켓): 스킨톤 셀렉터(전역 persist — 지원 이모지에 적용).
- a11y(리서치 §4 패턴 그대로): 카테고리=Tabs(manual) · 그리드=`role=menu`/`menuitem` · 검색 시 combobox+listbox 전환(`aria-activedescendant`, ↑/↓) · `aria-label`=사람이 읽는 이름 · 닫힘/선택 시 트리거 포커스 복귀 · reduced-motion.
- 성능: 카테고리 lazy render 또는 `content-visibility: auto` — 전량 DOM 금지.
- 소비처 3곳 무파손 이행(기존 testId·onPick 계약 유지 가능하면 유지).
**AC**: 4상태 · 유닛(검색 매칭·빈도 승격·스킨톤 persist·포커스 복귀) · `capture:design` 갱신(light/dark) · tsc/lint/unit green · 번들 증가 실측 기재 · #1688 주석 개정 포함.
**적립(구현 금지·PR 본문 명시)**: 빈도 store 서버 per-user 동기화(엔진) · `:shortcode:` 컴포저 autocomplete · custom emoji · i18n keyword.

## 2. UX-HT — 메시지 호버 퀵액션 툴바 (UX-EB 후행)

**사실**: `MessageActions.tsx`(621L) — hover ⋯ 단일 트리거·우클릭 메뉴·터치 long-press 시트, `(hover: none)` 축 분기. 액션 인벤토리는 `messageActionModel.ts` 순수 술어가 정본.
**작업**:
- 행 hover **또는 focus-within** 시 우상단 플로팅 툴바: **[빈도 리액션 슬롯 3] | [React(피커 열기)] [답글/스레드] [⋯(기존 메뉴)]**. 슬롯 시드=큐레이션 3종(👍 ✅ 🙏 — PICKER_EMOJI 어휘 내), 사용 누적 시 UX-EB 빈도 store의 per-user frequency로 승격(단일 store 공유).
- 슬롯 클릭=1클릭 리액션 토글(기존 리액션 뮤테이션 재사용). React=UX-EB popover를 툴바 앵커로. 답글=기존 스레드 액션. ⋯=기존 메뉴 그대로(Edit/Delete는 계속 메뉴에만).
- **탭스톱 계약(리버트 방지 핵심)**: 비호버·비포커스 행은 툴바 DOM 자체를 렌더하지 않는다(opacity/visibility 트릭 금지). 툴바=WAI-ARIA toolbar, 내부 roving tabindex — 행당 추가 탭스톱 ≤1. 가상화 타임라인에서 탭스톱 수 불변 red proof(테스트로 고정).
- 유지: 열린 popover/메뉴 있으면 툴바 고정 · 본문 드래그 선택 무간섭 · 우클릭 메뉴 불변 · 터치(`hover: none`)에선 툴바 비렌더(long-press 시트 불변 — 시트 상단 빈도 리액션 행 추가는 보너스 아님, 하지 말 것).
- B11 주석 + 디자인 시스템 §6 개정 같은 PR(§0).
**AC**: 탭스톱 red proof · 툴바 키보드 순회(←/→) · 4상태 · `capture:design`(hover 상태 캡처 포함) · tsc/lint/unit green.
**적립**: 메시지 포커스+단일 키(R/E/T — U-5 숏컷 체계 연동) · 슬롯 사용자 커스터마이즈 설정.

## 3. 검수·순서

UX-EB 랜딩(디자인 리뷰 포함) → UX-HT 착수. 각 PR: Fable diff 재판정 → **design-review 에이전트(신선 컨텍스트) Blocker 0** → track/uxui 머지. 성재 실물 검수는 트랙 워크트리 빌드로.
