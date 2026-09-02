# 워커 브리프 — UX-R4a Agent Hub `enabledTools` 편집 UI (uxui · ADR 불요)

> 워커: grok 4.6 · base=origin/track/uxui · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉(계약은 이미 있다). MCP 금지.
> 근거: 차별화 감사 §3 순위 1(`docs/planning/research/2026-09-01-differentiator-audit.md`) — "차별화 서사 전체에서 가장 값싼 한 칸". 실사: `clients/web/src/features/agentHub/AgentHubRoute.tsx:1094-1101`이 `enabledTools`를 **표시 전용**으로 렌더, `useAgentProfile.ts:163` read-through. 서버 `PUT /v1/workspaces/{ws}/agents/{agent}/profile`(`server-rust/bins/momo-server/src/routes/agents.rs:30`)이 `enabledTools`를 이미 수용. 카탈로그 = `server-rust/crates/momo-agent/src/tools.rs:165-190`(`CATALOG` 실행 가능 3종 + `DECLARED_NOT_EXECUTABLE` 목록). 승인 문법 = `requires_approval` G6 fail-closed(모르는 도구명은 승인 필요).

## 구현 계약
1. **도구 섹션**(Agent Hub 프로필 탭 안, 기존 표시 자리 대체): 카탈로그 전 항목을 행으로 — 이름·한 줄 설명·**실행 가능/선언만** 표지·승인 기본값 표지(`requires_approval`). 실행 불가 항목은 토글 비활성 + 사유 문장(낭독 포함). 카탈로그는 서버에서 읽는다(클라 하드코딩 금지 — 라우트가 없으면 **정지·보고**: 감사는 "표시 전용"만 확인했고 카탈로그 GET 존재는 미확인).
2. **편집 = 저장 버튼 확정**(낙관 갱신 아님 — 프로필 편집은 비낙관 규율 승계). 실패는 InlineBanner(문제 자리·다음 행동), 성공은 ADR-0182 대기 중이므로 **버튼 in-place 라벨 교체**(`저장` → `저장됨` ≤1.6s, 기존 `SettingsFields` copy-confirm 동형).
3. **권한**: 편집 가능 조건은 서버 403을 진실로(소유 인간·admin — 서버 판정). 403이면 토글은 읽기 전용 + 사유.
4. **키보드**: 토글 행 로빙, Space 토글, 저장 ⌘↵. 터치 타깃 규율.

## red proof (선행 커밋)
- 토글 → PUT 본문에 `enabledTools` 정확히 반영(추가·제거 각 1) · 실행 불가 항목 토글 시도 무동작+낭독 · 403 → 읽기 전용 전환 · 저장 실패 → 배너, 토글 상태 유지(롤백 없음 — 비낙관) · 알 수 없는 도구명이 서버에서 오면 렌더는 하되 "승인 필요" 표지(G6 반영).

## 완료 절차
`clients/web` vitest·tsc·`scripts/design_preflight_web.sh`·`CAPTURE_PORT=8599 npm run capture:design`(도구 섹션 두 스킴)·`gate:agent-hub`(포트 분리) 그린 실측 → 커밋 → `git push -u origin feat/uxr4a-enabled-tools` → `gh pr create --base track/uxui` → 정지.

## 규율
토큰만. 긴 도구명·설명 픽스처. 승인 문법의 문장은 UX 바이블 P3(제품 인격) — 과장·감탄 금지.
