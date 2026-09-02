# 워커 브리프 — #1858 계정/상태 메뉴에 로그아웃 추가 (uxui)

> 워커: cursor-agent grok-4.6-high-fast · 병렬 1 · base=origin/track/uxui
> 정지 조건: 머지·이슈 close 금지.

## 근거 (#1858 — 2026-08-28 성재 검수 실측)
- 사이드바 `ProfileCard`(clients/web/src/features/sidebar/ProfileCard.tsx) 드롭다운은 내 상태 · 워크스페이스 추가 · 설정뿐 — **로그아웃이 없다**. 현재 로그아웃은 설정 → 계정 섹션(`AccountSection`, data-testid="logout") 2뎁스에만 있고, 서버 전환(연결 화면)의 유일한 입구가 로그아웃이라 도달성이 중요하다. Slack 계열 관례는 프로필 메뉴 하단 Sign out.

## 구현 계약
1. `ProfileCard` 메뉴 맨 아래에 `DropdownMenuSeparator` + `DropdownMenuItem` 추가(설정 항목 뒤):
   - `data-testid="profile-logout"`, lucide `LogOut` 아이콘(사이즈·aria-hidden 기존 항목 동형), 라벨 「로그아웃」.
   - `onSelect` → `useSession().logout` 직접 호출 — 확인 다이얼로그 없음(기존 설정 내 로그아웃 버튼과 동일 의미론, U4-f 이 기기 흔적 삭제). 로그아웃 의미론·세션 코드 무변경.
2. 설정 → 계정 섹션의 기존 로그아웃 버튼 유지(제거 금지).
3. 카피는 「로그아웃」 한 단어(기존 AccountSection과 동일 표기). 톤 변형·destructive 색 부여 금지 — 기존 메뉴 행과 동형.

## red proof (선행 커밋)
- ProfileCard 테스트(기존 테스트 파일 관례 따라): 메뉴 열면 profile-logout 렌더(설정 항목 뒤 순서), 선택 시 logout 1회 호출, 키보드(Arrow/Enter)로 도달·발동.
- 기존 항목(상태 3종·워크스페이스 추가·설정) 회귀 그린.

## 완료 절차
웹 vitest + tsc + scripts/design_preflight_web.sh 자가 실행 → 커밋(#1858 참조) → push → PR(base=track/uxui, 본문에 red proof) → 정지. 마지막 출력에 PR URL과 변경 요약. design-review(Blocker 0)는 오케스트레이터 몫.
