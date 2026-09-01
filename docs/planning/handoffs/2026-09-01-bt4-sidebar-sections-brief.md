# 워커 브리프 — BT-4(#1932) 사이드바 섹션 골격 (engine→uxui, 2PR)

> 워커: Opus 5 · 시작 절차: 각 워크트리에서 `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. MCP 금지. `schema_v0.sql` 무접촉(확장은 신규 마이그레이션 파일).
> 정본: **ADR-0177 Accepted** (docs/adr/0177-sidebar-sections-member-owned.md) — D1~D5 전부 구속. 이 티켓은 D5의 **골격 절반만**: 별표 UI·정렬·DnD는 BT-5 몫(별표 **스키마 수용**은 이번에).
> 참조(Apache-2.0): buzz `desktop/src/features/sidebar/{lib/channelSections*,ui/CustomChannelSection.tsx,ui/ChannelSectionDialogs.tsx}` — 문법만, 복붙 금지.

## 서버 절반 (base=origin/track/engine, PR → track/engine)
1. 마이그레이션 신규 1본: `member_sidebar_prefs`(workspace_id, member_id 유니크 쌍, payload JSONB, updated_at) + RLS `ws_isolation` 동일 적용(기존 마이그레이션의 RLS 문법 실사·동형).
2. `GET/PUT /v1/workspaces/{ws}/members/me/sidebar-prefs` — `require_human`(에이전트 403 시험). PUT 검증: ADR D3 상한(섹션 ≤50·이름 ≤80자·채널 참조 ≤500, version=1 필수), 채널 membership 비검증(관용 계약 — 결정 주석). GET은 없으면 빈 기본값.
3. 이벤트 없음(D2): outbox 생산 금지 — 주석으로 명기.
4. red proof: 상한 초과 400 · 에이전트 403 · 타 멤버 프리프 접근 불가(RLS) · PUT→GET 왕복.

## 클라 절반 (base=origin/track/uxui, PR → track/uxui — 서버 계약 핀 고정 + 모킹 시험)
1. **momo-core 단일점**: `packages/momo-core`에 섹션 배치 파생 함수(payload + 채널 목록 → 렌더용 섹션 배열: 기본 「채널」·「DM」 섹션 + 커스텀 섹션, 미배치 채널은 기본 채널 섹션 귀속, 죽은 채널 id 필터) — 테스트 동반. 웹은 이것만 소비.
2. **섹션 CRUD UI**: 생성(사이드바 + 메뉴 「새 섹션」)·이름변경·삭제(채널은 기본 섹션으로 복귀) — 기존 다이얼로그·메뉴 문법 실사 동형. 채널 배치는 BT-1(#1929)이 만든 행 컨텍스트 메뉴의 확장점에 「섹션으로 이동 ▸」 서브메뉴로 접합(BT-1 랜딩 후 base에 있음 — 없으면 정지·보고).
3. **기존 기계 통합**: BZ-1 접기·`sectionUnreadTotals` unread 집계·hover 액션·⌥↑↓ 순회가 커스텀 섹션에서도 동작 — `sidebarSectionModel.ts`의 `SidebarSectionId` 하드코딩을 데이터 주도로 해제하되 기존 시험 전부 그린(회귀 0).
4. 저장: 변경 시 PUT(디바운스 — buzz 2s 문법 참고), 부트스트랩 GET. 실패 시 롤백+배너(기존 오류 문법).
5. 접기 상태는 현행 localStorage 유지(ADR D4) — 서버 payload에 넣지 마라.

## red proof (선행 커밋, 클라)
- 섹션 생성→채널 이동→새로고침(목 GET) 후 구조 생존
- 커스텀 섹션 접기+unread 집계 시험(기존 자와 같은 자)
- 죽은 채널 id 필터 시험

## 완료 절차
- engine: cargo test·기존 서버 게이트 → 커밋(#1932) → `git push -u origin feat/bt4-sidebar-sections-server` → `gh pr create --base track/engine` → 클라 절반으로.
- uxui: web vitest·core vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8567 capture:design(커스텀 섹션 프레임 두 스킴)·SHELL_GATE_PORT=8569 SHELL_GATE_FOCUS_ONLY=1 gate:shell → 커밋(#1932) → `git push -u origin feat/bt4-sidebar-sections-client` → `gh pr create --base track/uxui` → 정지. 마지막 출력에 PR URL 2건·변경 요약.
