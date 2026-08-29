# 워커 브리프 — BZ-1(#1864) 사이드바 접기: 토글 위치·아이콘 buzz형 + 접힘 UI + 애니메이션 (uxui)

> 워커: cursor-agent grok-4.6-high-fast · 병렬 1 · base=origin/track/uxui
> 정지 조건: 머지·이슈 close 금지.
> 참조 코드: `~/projects/reference/buzz`(Block, **Apache-2.0** — 참조 가능. 파일 단위 복사 시 출처 주석 1줄). desktop 클라: `desktop/src/features/sidebar/`, `desktop/src/shared/layout/sidebarLayout.ts`, `desktop/src/shared/ui/sidebar.tsx`.

## 근거 (성재 검수 2026-08-29, #1864 스크린샷 2종)
- 현재 토글은 사이드바 내부(PanelLeftClose, Sidebar.tsx:432) — 접으면 토글 자체가 사라지는 위치 문제.
- buzz: **타이틀바 줄 좌측**(트래픽라이트 옆)에 패널 아이콘(사각+좌측 반 채움) 고정 — 접힘/펼침 무관하게 항상 같은 자리. 접힘 상태는 사이드바 완전 숨김·콘텐츠 풀폭, 부드러운 트랜지션.

## 구현 계약
1. **토글 위치·아이콘**: 앱 상단 줄(타이틀바 영역) 좌측, 트래픽라이트 인셋 우측에 lucide `PanelLeft`(채움 변형 불가 시 PanelLeft 유지) 아이콘 버튼. Tauri 셸이면 tauri.conf `titleBarStyle` overlay 전환 + 해당 줄에 `data-tauri-drag-region`(버튼 자체는 드래그 제외). 웹(브라우저)에서는 같은 줄이 일반 상단 바로 동작(IS_TAURI 분기 최소화 — 렌더는 동일, 드래그 속성만 조건부).
2. **접힘 UI**: 사이드바 폭 0(완전 숨김), 콘텐츠 풀폭. 토글은 그대로 그 자리(스크린샷 2 동형). 기존 사이드바 내부 PanelLeftClose 버튼은 제거(중복 입구 금지).
3. **애니메이션**: width(또는 transform) 트랜지션 — duration/이징은 기존 앱 모션 토큰 있으면 재사용, 없으면 200ms ease-out 계열로 통일 상수 신설. `prefers-reduced-motion`에서 즉시 전환.
4. **상태·단축키**: sidebarPaneCollapsed(AppShell.tsx:63) 재사용. 기존 접기 단축키 있으면 유지, 없으면 ⌘\\ 관례는 이번 범위 밖(신설 금지). 접힘 상태 세션 유지(localStorage) 여부는 기존 동작 유지(변경 금지).
5. 접힘 시 포커스·키보드 순회가 숨은 사이드바로 들어가지 않게(inert 또는 unmount — 기존 구현 방식 따름).

## red proof (선행 커밋)
- 토글이 상단 줄에 렌더·클릭/키보드로 접힘↔펼침, aria-expanded/label 정확.
- 접힘 시 사이드바 트리 포커스 불가·콘텐츠 풀폭.
- reduced-motion 즉시 전환.
- 기존 사이드바 기능(검색·행·ProfileCard) 회귀 그린.

## 완료 절차
웹 vitest + tsc + design_preflight_web.sh 자가 실행 → 커밋(#1864 참조) → push → PR(base=track/uxui) → 정지. design-review는 오케스트레이터 몫. Tauri overlay 전환이 데스크탑 빌드에 미치는 영향은 PR 본문에 관찰 보고(웹 회귀 없음 증명 필수).
