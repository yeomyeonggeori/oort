# 워커 브리프 — BF-B1 서버 절반(#1888) 메시지 리마인더 REST (engine)

> 워커: grok build CLI grok-4.6 · base=origin/track/engine
> 정지 조건: 머지·이슈 close 금지. 라이브 스택 비접촉. schema_v0.sql 무접촉(신규 마이그레이션만).
> 정본: **ADR-0175 Accepted** (docs/adr/0175-message-reminders.md — 성재 승인 2026-08-30). 클라 절반은 별도 티켓.

## 계약 (ADR-0175 그대로)
1. **마이그레이션**: 신규 `message_reminder` 테이블 — id(uuidv7)·workspace_id·member_id(소유자)·channel_id·message_id·due_at(timestamptz)·note(text nullable, ≤500자 체크)·completed_at(nullable)·created_at·updated_at. FK·**RLS FORCE(소유자 스코프 — 본인 행만)**·인덱스(workspace_id, member_id, due_at) WHERE completed_at IS NULL. 기존 마이그레이션 번호 규칙 준수(check_migration_numbers 게이트).
2. **API (전부 사람 본인, require_human)**:
   - `POST /v1/workspaces/{ws}/reminders` — body `{channelId, messageId, dueAtMs, note?}` (camelCase, deny_unknown_fields). 대상 메시지의 채널 멤버십 검증(기존 is_channel_member 관례). 과거 dueAtMs 거부 400.
   - `GET /v1/workspaces/{ws}/reminders?state=pending|all` — 본인 것만, due_at 오름차순, 기존 페이지네이션 관례.
   - `PATCH /v1/workspaces/{ws}/reminders/{id}` — `{dueAtMs?}`(스누즈) 또는 `{completed: true}`(완료). 본인 외 404.
   - `DELETE /v1/workspaces/{ws}/reminders/{id}` — 본인 외 404.
3. 단일 쓰기경로·감사(AuditEntry "reminder.created/updated/completed/deleted"). **outbox 팬아웃 없음**(ADR v1=클라 폴링 결정 — 새 레일 금지).
4. openapi.yaml + web-legacy schema.d.ts 동기(기존 게이트 관례). ENGINE_HANDOFF.md에 ready 항목 등재(A-41 — 클라 절반이 소비할 계약 요약).

## red proof (선행 커밋)
- 실 DB conformance(기존 패턴): ①생성→목록→스누즈→완료 왕복 ②타인 리마인더 GET/PATCH/DELETE 404(교차 멤버) ③비멤버 채널 메시지 대상 403/404 ④과거 due 400 ⑤RLS 자가검증(GUC) ⑥에이전트 자격 403.
- 마이그레이션 게이트·openapi 게이트 그린.

## 완료 절차
cargo test(크레이트+conformance)·마이그레이션/openapi 게이트 자가 실행 → 커밋(#1888 참조) → git push -u origin feat/1888-bfb1-reminders-server → gh pr create --base track/engine (본문에 red proof) → 정지.
