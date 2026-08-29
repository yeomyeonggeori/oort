# 워커 브리프 — BZ-2(#1865) 채널 헤더 재작업: 1줄 헤더 + 우측 라운드 컨트롤 그룹 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (BZ-1 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. 워크트리·참조 경로 밖 접근 금지. MCP 금지.
> 참조: `~/projects/reference/buzz`(Apache-2.0) — 채널 헤더는 `desktop/src/features/channels/useActiveChannelHeader.ts` 주변. 성재 참조 스크린샷 요지: 좌측 `# 광장` 1줄, 우측 라운드 사각 아이콘 버튼 그룹 `[터미널] [👥 10] [헤드폰] [⋮]`.

## 근거 (성재 검수 2026-08-29, #1865)
- 현 헤더가 채널명+설명(topic)으로 **2줄**을 차지 — 설명 상시 노출은 과함.
- 우측 컨트롤·멤버수 표기가 buzz 대비 산만 — 라운드 버튼 그룹으로 정돈 요청.

## 구현 계약 (clients/web/src/features/chat/ChatShell.tsx renderChannelHeader :795~ 일대)
1. **1줄 헤더**: `ChannelTopicControl`(:867)의 상시 노출 제거 — 토픽은 ⋮ 메뉴(ChannelHeaderMenu) 안 항목("주제 보기/편집" — 기존 편집 표면 재사용)으로 이동. 토픽 데이터·편집 기능 자체는 회귀 0.
2. **우측 라운드 컨트롤 그룹**: 기존 기능만 재배치(신설 금지) — `[👥 N] [허들] [⋮]` 순.
   - 각 버튼: 라운드 사각(기존 라디우스 토큰), 보더 1px 라인 토큰, 32~36px 컨트롤(기존 사이즈 토큰), 아이콘 lucide 기존 것 유지.
   - **👥 N** = 인원수(:775 동일 배열 원칙 유지) — 현 멤버 목록 표면이 있으면 그 트리거로, 없으면 표시 전용(기능 신설 금지, 어느 쪽인지 PR 본문에 명시).
   - 허들 컨트롤(HuddleHeaderControl)은 라이브 상태 표기(Live 배지·참가자)를 유지하되 유휴 상태는 그룹의 라운드 버튼 문법으로 정렬.
   - 관전 콘솔 진입 등 다른 기존 헤더 버튼이 있으면 같은 그룹 문법으로 흡수.
3. 헤더 높이·경계선 리듬은 기존 상단 정렬 계약(타이틀바·사이드바 검색 줄과의 하단 경계 정렬 — gate:shell이 잼) 유지.
4. 반응형: 좁은 폭에서 그룹이 겹치지 않게(기존 브레이크포인트 관례), 폰 서랍 무접촉.

## red proof (선행 커밋)
- 헤더 1줄 렌더 + 토픽이 ⋮ 메뉴로 이동(편집 왕복 회귀 그린).
- 컨트롤 그룹 3버튼 렌더·키보드 도달·aria-label, 허들 시작/참가/라이브 상태 회귀.
- 인원수가 목록과 같은 배열에서 유래(기존 테스트 유지).
- capture:design·gate:shell 등 헤더를 지나는 레인 전부 그린(빨간 레인 출하 금지 — #1870 선례).

## 완료 절차
web vitest·tsc·design_preflight_web.sh·capture:design·SHELL_GATE_FOCUS_ONLY gate:shell 그린 실측 → 커밋(#1865) → git push -u origin feat/1865-bz2-channel-header → gh pr create --base track/uxui (본문에 red proof+레인 로그) → 정지. design-review는 오케스트레이터 몫.
