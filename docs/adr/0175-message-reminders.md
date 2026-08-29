# ADR-0175: 메시지 리마인더 (나중에 알림)

- 상태: **Proposed** (성재 결재 대기)
- 날짜: 2026-08-29
- 발의: Fable (BF-B1 #1888 선행 — buzz 격차 후보 승인 "권장대로")
- 관련: research/2026-08-29-buzz-ui-gap-candidates.md · buzz(Apache-2.0) features/reminders

## 배경
메시지 "나중에 처리" 습관을 담는 그릇이 없다 — 클라 코드가 스스로 기록한 구멍(messageActionModel.ts "remind later — no surface. Accrued"). buzz는 프리셋 5종+커스텀+메모+스누즈+인박스 목록으로 완결.

## 결정 (제안)
1. **스키마**: 신규 `message_reminder` 테이블(마이그레이션 — schema_v0 무접촉): id·workspace_id·member_id(소유자)·channel_id·message_id·due_at·note(선택)·completed_at·created_at. RLS FORCE(소유자 스코프), 만기 조회 인덱스(due_at, completed_at IS NULL).
2. **API**: 소유자 전용 CRUD — POST(생성)·GET 목록(미완/전체)·PATCH(스누즈=due_at 갱신·완료)·DELETE. 단일 쓰기경로·감사. 만기 통지는 v1에서 **클라 폴링**(기존 read-state 30s 캐던스 동형) — outbox 푸시 팬아웃은 후속.
3. **클라**: 메시지 ⋯ 메뉴 「나중에 알림」(프리셋: 30분/1시간/3시간/내일 9시/다음 주 월요일 9시 + 커스텀 + 메모), 인박스 도킹 목록(상대시간·출처·완료·스누즈), 첫 진입 과거 리마인더 폭탄 방지 워터마크(buzz 규칙 승계).
4. **범위 밖**: 타인에게 리마인더 보내기·반복 리마인더.

## 성재 확정점
1. 스키마/CRUD 도입 승인 2. v1 폴링(푸시 후속) 승인
