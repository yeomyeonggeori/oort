# 워커 브리프 — BT-1(#1929) 사이드바 행 우클릭 컨텍스트 메뉴 (uxui)

> 워커: Opus 5 · base=origin/track/uxui · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉. MCP 금지.
> 참조(문법 원본, Apache-2.0): `~/projects/reference/buzz` `desktop/src/features/sidebar/ui/ChannelContextMenu.tsx` — 구조만 참조, 코드 복붙 금지.

## 배경
oort의 채널 액션은 헤더 메뉴(`features/chat/ChannelHeaderMenu.tsx`)에만 있다 — "채널을 열지 않고 조작"하는 문법 자체가 없다(감사 §3-S2). 사이드바 행은 `features/sidebar/SidebarRow.tsx`(SidebarSection 동거), 행 모델은 `sidebarSectionModel.ts`.

## 구현 계약
1. **트리거**: 사이드바 채널·DM 행에서 우클릭(contextmenu) + 키보드(메뉴 키/Shift+F10) + 터치 롱프레스는 hover:none 분기 실사 후 기존 문법(`useHoverNone` 등)에 맞춰 판단. 로빙 tabindex·⌥↑↓ 순회 회귀 금지.
2. **항목(v1)**: 읽음 처리(기존 read-state 광고 로직 재사용 — 새 서버 표면 금지) · 음소거 토글 · 채널 나가기 · 링크 복사(`/c/{id}` 딥링크 — `features/inbox/anchor.ts` 문법) · 이름 복사. 전부 **기존 로직 재사용** — `ChannelHeaderMenu.tsx`의 실행부를 공유 모델로 추출(`channelActionModel` 류, 테스트 동반)해 헤더·컨텍스트 메뉴가 한 정본을 소비한다. 중복 구현 금지.
3. **자리 예약**: 별표·섹션 이동은 ADR-0177 결재 후 BT-4/5 몫 — 이번엔 넣지 말고, 모델이 항목 배열 합성이 되도록만(확장점) 설계.
4. **메뉴 그릇**: 기존 메뉴 문법 실사(⋯ 메뉴·헤더 메뉴의 포커스 트랩·Esc·aria) 후 동형. 새 라이브러리 도입 금지.
5. **DM 행 분기**: 나가기 대신 DM에 맞는 항목 집합(실사 후 결정 주석).

## red proof (선행 커밋)
- 우클릭 → 메뉴 열림·항목 실행(음소거 토글 왕복) 시험
- 키보드 열기 + Esc 닫기 + 포커스 반환(증명 있는 시험 — keydown만 쏘고 초록 만들지 마라)
- 헤더 메뉴와 컨텍스트 메뉴가 같은 모델을 소비하는 단정(정본 이중화 grep 게이트)

## 완료 절차
web vitest·tsc·`scripts/design_preflight_web.sh`·CAPTURE_PORT=8537 capture:design(메뉴 열림 프레임 2스킴)·SHELL_GATE_PORT=8539 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1929 참조) → `git push -u origin feat/bt1-sidebar-context-menu` → `gh pr create --base track/uxui` → 정지. 마지막 출력에 PR URL·변경 요약.
