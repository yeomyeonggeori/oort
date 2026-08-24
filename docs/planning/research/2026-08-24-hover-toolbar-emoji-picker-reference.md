# 호버 퀵액션 툴바·이모지 피커 레퍼런스 — Slack/Discord/Mattermost 행동 계약 (2026-08-24)

- 작성: Fable · 발제(성재): 스크린샷 3장(Discord 호버 바·피커) — "호버만 해도 우상단에 행동 표시 + 이모지 모달 반영, Slack/Mattermost 레퍼런스 탐색 추가"
- 방법: 웹 리서치 1기(공식 help/docs 1차 소스 우선) + 현행 코드 정찰. 상세 출처는 원 리포트(세션 산출) — 여기엔 결정 재료만 정제.

## 1. 호버 툴바 — 3사 수렴 계약

| 항목 | 수렴값 |
|---|---|
| one-click 리액션 슬롯 | **3개** (Slack 고정 3·Discord 빈도 top-3·MM ~3) — 4개 이상은 본문 가림 반발(Discord) |
| 슬롯 내용 | **순수 recency는 실패 실증**(MM #19258 — 일회성이 상용 이모지를 밀어냄), 순수 auto-빈도는 통제불가 반발(Discord). 정답 = **큐레이션 시드 + 사용 누적 후 per-user frequency 승격 + 사용자 제어** |
| 구성·순서 | [슬롯3] → React(피커) → 답글(스레드) → (Slack: Forward·Save) → ⋯ overflow. Edit/Delete는 overflow에만 |
| 등장·소멸 | hover 표시 / 이탈 소멸 / **열린 popover 있으면 고정** / 본문 드래그 선택 무간섭(우상단 겹침 배치) |
| 키보드 | Slack·Discord 공통: **메시지 포커스 + 단일 키**(R=리액션, E, T/→=스레드 등) — 툴바 hover 의존 아님 |
| 터치 | hover 부재 → long-press 시트(3사 공통), 시트 상단에 빈도 리액션 행 |

## 2. 피커 해부 — 표준 기능 세트

- 검색(이름+shortcode+keyword) · 카테고리 탭(**frequent→people→nature→foods→activity→places→objects→symbols→flags** — emoji-mart 성문화 순서) · Frequently used 첫 섹션 · 스킨톤 **전역 persist** · 하단 프리뷰 푸터(글리프+이름+`:shortcode:`) · 초기 포커스=검색 · **anchored popover**(3사 공통 — 중앙 모달 아님, 화면 경계 flip) · 모바일=바텀시트.
- **shortcode 표준 = iamcal/Slack 계보**(`:+1:`=`:thumbsup:`). Mattermost도 iamcal 기반이라 Slack 호환. Discord만 JoyPixels 계보로 일부 상이. CLDR 이름은 표시용. emojibase가 iamcal preset을 데이터로 제공.

## 3. CSP-locked 오프라인 데이터 소싱 (실측 크기)

| 선택지 | 크기(gz) | 판정 |
|---|---|---|
| **자작 피커 + `emojibase-data` compact(en) + iamcal preset** | ~83kB + α (총 ~90–120kB) | **권장** — 디자인 시스템 완전 통제, #1688 무라이브러리 결정 유지, native 글리프 |
| emoji-mart + `@emoji-mart/data` | 67kB | 기능 최다이나 스타일 오버라이드로 토큰 정합 싸움 |
| emoji-picker-element (+ 전용 data 72kB) | 런타임 12.5kB | a11y 검증 최고이나 web component — React/토큰 통합 이질 |
| emoji-datasource 원본 직번들 | 1.3MB raw | 스프라이트 좌표 과잉 — 기각. shortcode는 빌드타임 추출용으로만 |
| frimousse 기본 설정 | — | jsDelivr CDN fetch — CSP 위반, 기각(self-host 재설정 시만 가능) |

- ~1,900개 그리드 전량 DOM 렌더는 프레임 드랍 — 카테고리 lazy render 또는 `content-visibility: auto` 필수.

## 4. a11y — Nolan Lawson(emoji-picker-element) 패턴

카테고리=**Tabs**(manual activation, ←/→) · 브라우즈 그리드=`role=menu`+`menuitem`(grid 롤은 virtualization과 충돌해 회피) · 검색=**combobox-with-listbox 전환**(`aria-activedescendant`, ↑/↓만 — ←/→는 입력 커서 충돌) · emoji `aria-label`=사람이 읽는 이름 · 스킨톤=collapsible listbox · 닫힘/선택 시 **트리거로 포커스 복귀** · reduced-motion 대응.

## 5. oort 현행과의 충돌 지점 (코드 정찰)

- **B11 결정**: R1이 6버튼 가시 바를 실었다가 2번 리버트 — ①`opacity-0`은 Tab에 안 숨어 가상화 타임라인 탭스톱 ~150개 ②디자인 스킬 §6("행 액션은 메뉴로"). 현행 = hover ⋯ 단일 트리거 + 우클릭 메뉴 + 터치 long-press 시트(`(hover: none)` 축).
  → 재도입 조건: **호버/focus-within 행에만 조건부 렌더**(opacity 트릭 금지 — 비호버 행 탭스톱 0) + **WAI-ARIA toolbar/roving tabindex**(툴바 전체 = 탭스톱 1). Slack/Discord의 실제 해법과 동일. §6 정본은 같은 PR에서 개정(성재 지시 2026-08-24).
- **#1688 결정**: 고정 32종·무라이브러리·중앙 Dialog. 무라이브러리는 유지(자작), **32종 어휘·중앙 모달은 supersede** — 주석 갱신 같은 PR.
- 기존 자산: `MessageActions.tsx`(621L — hover ⋯·컨텍스트 메뉴·시트), `EmojiPickerDialog.tsx`(92L), `ReactionChips.tsx`, `useComposerEmoji.ts`.

## 6. oort 결정 (티켓 반영)

1. 슬롯 3 + React + 답글 + ⋯. 시드 = 큐레이션 3종, 사용 누적 시 per-user **frequency** 승격(recency 금지).
2. 빈도 저장 v1 = 클라 로컬(피커 Frequently used와 단일 store 공유). 서버 per-user 동기화(멀티 디바이스)는 **적립**(엔진 티켓 후보 — 3사 권고는 서버).
3. 피커 = 자작 + emojibase compact(en) same-origin 번들 + iamcal shortcode. 포인터=anchored popover, 터치=시트. 기능 P0/P1은 §2 순서.
4. 단일 키 숏컷(R/E/T)은 메시지 포커스 모델 선행이라 **적립**(U-5 숏컷 체계 연동).
