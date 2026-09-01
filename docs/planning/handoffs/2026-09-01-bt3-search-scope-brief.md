# 워커 브리프 — BT-3(#1931) 검색 채널 스코프 (engine→uxui, 2PR)

> 워커: Opus 5 · 시작 절차: 각 워크트리에서 `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. MCP 금지. `schema_v0.sql` 무접촉.
> 참조(Apache-2.0): buzz `desktop/src/features/search/ui/SearchScopeControls.tsx`("Search in …"/"Search everything"/DM 분기) — 문법만.

## 배경
`GET /v1/workspaces/{ws}/search/messages?q=&limit=&cursor=`(`routes/search.rs`)는 workspace 스코프뿐 — 서버 계약부터 채널 한정 검색이 불가(감사 §3-S4). 클라는 `features/search/SearchRoute.tsx` + `momo-core searchModel.ts`.

## 구현 계약 — 서버 절반 (base=origin/track/engine, PR → track/engine)
1. 쿼리 파라미터 `channel=<channel_id>` 추가(옵션). 값이 있으면 **요청자가 그 채널의 멤버인지 검증** — 비멤버·비존재는 404(타 워크스페이스 프로브 관용 금지, 기존 404 문법 동형). RLS가 1차 경계지만 명시 검증을 겹친다(심층방어, 검증 순서는 기존 라우트 문법 실사).
2. 커서 페이징·limit clamp·q≥2 규율은 채널 스코프에서도 동일 — 커서에 스코프가 봉인되는지 실사(스코프 바꿔치기 커서 재사용 거부 red proof).
3. 에이전트 자격: 현행 검색 접근 계약 실사 후 동일 유지(확장 금지·축소 금지 — 결정 주석).
4. openapi/계약 문서 갱신(레포 내 계약 정본 실사 후 그 자리).

## 구현 계약 — 클라 절반 (base=origin/track/uxui, PR → track/uxui, 서버 계약 핀 고정 + 모킹 시험)
1. 검색 화면에 스코프 칩 2종: 「이 채널에서」(현재 채널 문맥에서 진입 시 기본) / 「전체」 — buzz 문법 동형, 기존 칩·토글 문법 실사 후 그 그릇으로. DM 문맥이면 라벨 분기.
2. `momo-core searchModel.ts`에 스코프 상태·쿼리 조립 확장(테스트 동반). 스코프 전환 시 커서 리셋.
3. 빈 결과 카피 스코프 분기(「이 채널에는 없음 — 전체에서 검색」 승격 동선).
4. 채널 문맥 진입점: 채널 헤더/⌘K에서 검색 진입 시 채널 스코프 프리셋 — 진입 경로 실사 후 최소 1곳 배선(과대 확장 금지).

## red proof (선행 커밋)
- 서버: 비멤버 404 · 스코프 커서 바꿔치기 거부 · 채널 스코프 결과가 실제로 그 채널만(픽스처 2채널)
- 클라: 스코프 전환 → 쿼리 파라미터·커서 리셋 단정 · 빈 결과 분기

## 완료 절차
- engine: cargo test(해당 crate) + 기존 서버 게이트 실측 → 커밋 → `git push -u origin feat/bt3-search-scope-server` → `gh pr create --base track/engine` → **클라 절반으로 진행**.
- uxui: web vitest·core vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8557 capture:design(스코프 칩 프레임 두 스킴)·SHELL_GATE_PORT=8559 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋 → `git push -u origin feat/bt3-search-scope-client` → `gh pr create --base track/uxui` → 정지. 마지막 출력에 PR URL 2건·변경 요약.
