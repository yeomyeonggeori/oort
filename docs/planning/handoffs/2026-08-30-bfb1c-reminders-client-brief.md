# 워커 브리프 — BF-B1 클라 절반(#1888) 메시지 리마인더 UI (uxui, A-41 소비)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (A8 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. server-rust 무접촉.
> 시작 절차: `git merge origin/main --no-edit`로 정렬부터.
> 정본: ADR-0175 (docs/adr/0175-message-reminders.md) + ENGINE_HANDOFF A-41. **서버 절반(#1905)은 track/engine에만 있다** — 이 레인에서 실서버 conformance 불가. REST 소비층은 아래 고정 계약대로 작성하고 시험은 모킹으로. 통합 정합은 main 승격 시.

## 고정 와이어 계약 (A-41 — 임의 변경 금지)
- `POST/GET/PATCH/DELETE /v1/workspaces/{ws}/reminders` · GET 쿼리 `state=pending`(기본) | `all`.
- 본인 CRUD만(타인 행 404·에이전트 403은 서버 몫 — 클라는 표면 미노출로 충분).
- **outbox 푸시 없음** — 만기 도달은 클라 폴링(read-state 30s와 동형 리듬).

## 구현 계약
1. **사전 조사**: 메시지 ⋯ 메뉴(MessageActions)·인박스/도킹 표면·read-state 30s 폴링 구현을 실코드로 확인하고 같은 문법에 동승(새 폴링 루프 신설 금지 — 기존 리듬에 합류 가능하면 합류, 불가하면 동형 구현+사유).
2. **설정 진입**: 메시지 ⋯ 메뉴에 「나중에 알림」 — 프리셋 30분/1시간/3시간/내일 9시/다음 주 월요일 9시 + 커스텀(날짜+시간) + 선택 메모(≤200자 UI 상한). 프리셋 계산은 로컬 타임존.
3. **목록 표면**: 인박스 도킹 목록(사전 조사로 자리 판정 — 기존 인박스/알림 표면 있으면 그 안 섹션, 없으면 사이드바 진입 경량 패널, A5 초안 패널 문법 승계 가능). 행: 원문 미리보기·출처 채널·만기 상대시간·완료·스누즈(같은 프리셋 재사용). 원문 클릭 → 해당 메시지로 항법(기존 점프 경로).
4. **만기 도달**: 폴링이 만기 발견 시 A4 알림 세분화 표면과 정합하는 로컬 알림 + 목록 강조. **첫 진입 과거 폭탄 방지 워터마크**(A-41 명시): 마지막 확인 시각 이전에 이미 만기인 것들은 일괄 도착 알림 대신 목록 배지로만.
5. 4상태(빈/로딩/오류/오프라인) — §4. 빈 상태는 행동 초대 카피. 다크/라이트 토큰만, 모션 신설 금지.
6. localStorage 키는 momo.web.* 관례(워터마크 저장 등). gitleaks 오탐 시 .gitleaksignore fingerprint+사유.

## red proof (선행 커밋)
- 프리셋 5종 시각 계산(고정 now 주입 — 내일 9시·다음 주 월요일 9시 경계 포함).
- CRUD 왕복 모킹(생성→목록→완료→스누즈→삭제).
- 워터마크: 과거 만기 일괄 도착 시 알림 0·배지 반영.
- 만기 폴링 감지 → 알림 경로(모킹).
- 목록 행 → 메시지 점프.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8507 capture:design·SHELL_GATE_PORT=8509 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1888) → git push -u origin feat/1888-bfb1-reminders-client → gh pr create --base track/uxui → 정지. 마지막 출력에 PR URL과 변경 요약.
