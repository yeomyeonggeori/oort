# 워커 브리프 — BF-B2 서버 절반(#1889) 커스텀 상태 필드 (engine)

> 워커: grok build CLI grok-4.6 · base=origin/track/engine (B1 서버 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. 라이브 스택 비접촉. schema_v0.sql 무접촉.
> 정본: **ADR-0176 Accepted** (docs/adr/0176-custom-member-status.md). 클라 절반은 별도.

## 계약 (ADR-0176 그대로)
1. **사전 조사**: 현 선언 프레즌스(setPresenceStatus PUT)의 저장 위치·브로드캐스트 레일을 실코드로 확인하고, 커스텀 상태를 **그 표면에 동승**시켜라(새 레일 금지).
2. **마이그레이션**: 저장 위치(조사 결과의 테이블)에 nullable 3필드 — `status_emoji`(단일 이모지 — 서버는 길이/코드포인트 상한 검증, 엄밀 이모지 판별은 과설계 금지)·`status_text`(≤80자, trim)·`status_expires_at`(timestamptz nullable). 기존 RLS 스코프 승계.
3. **API**: 기존 자기 상태 쓰기 경로 확장(같은 PUT 바디에 optional 필드) 또는 형제 엔드포인트 — 기존 계약과의 정합이 기준(조사 후 채택, PR 본문에 사유). 본인만 쓰기, 셋 다 null로 지우기 가능. 읽기: roster projection에 3필드 노출, **만료 도달 시 읽기에서 무시**(지연 삭제 — 별도 잡 금지).
4. 변경 브로드캐스트는 기존 프레즌스 레일 동승. 감사(개인 상태라 과감사 금지 — 기존 프레즌스 감사 관례를 따르되 없으면 무감사, 사유 명기).
5. openapi + web-legacy 타입 동기. ENGINE_HANDOFF **A-42** ready 등재(프리셋 칩 5종 카피 포함: 회의 중/이동 중/병가/휴가/재택 — 클라 절반 소비용).

## red proof (선행 커밋)
- 실 DB conformance: ①설정→roster 반영→지우기 왕복 ②80자 초과 400 ③만료 지난 상태는 roster에서 null ④타인 쓰기 불가(경로 구조) ⑤에이전트 자격 403 ⑥기존 프레즌스 3종 회귀.

## 완료 절차
cargo test·openapi 게이트 자가 실행 → 커밋(#1889 참조) → git push -u origin feat/1889-bfb2-status-server → gh pr create --base track/engine → 정지.
