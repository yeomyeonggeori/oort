-- =============================================================================
-- 170_notification_diagnostics_test_push.sql — #4341 (ADR-0206 D11·D15, Accepted)
--
-- 「왜 알림이 안 와요」 진단과 시험 알림이 쓰는 DB 조각 셋. 한 파일, 한 트랜잭션.
-- ADR-0206 「DB 계약」 M-a(outbox kind) + M-b1(시험 알림 컬럼) + M-h(최근 기록 색인)를
-- 한 번호(170)에 묶었다. 어느 것도 새 테이블이 아니라서 새 RLS 정책도, 새 GRANT도 없다.
--
-- 1) outbox_kind 라벨 'push_system' (M-a)
--    메시지 행이 없는 푸시를 notifier 의 둘째 드레인이 소비하는 새 kind. 지금의 생산자는
--    시험 알림 라우트 하나다(예약 실패는 ADR-0206 N13 이 같은 kind 에 더한다). push_candidate 의
--    hot path 와 실패 영역이 갈리도록 kind 를 따로 둔다.
--    PG12+ 는 ALTER TYPE ... ADD VALUE 를 트랜잭션 블록 안에서 허용하되, 새 값을 같은 트랜잭션의
--    DML 이 쓰지 못하게 막는다(011_push_notifier.sql 과 같은 방식). 이 파일에는 새 값을 쓰는
--    문장이 없다 — 라벨을 리터럴로 쓰는 INSERT 는 Rust 의 emit_outbox 가 커밋 뒤에 낸다.
--
-- 2) notification_rule 컬럼 넷 (M-b1) — 시험 알림의 분당 한도와 마지막 시험
--      test_push_window_start timestamptz   한도 창(고정 60초)의 시작
--      test_push_count        smallint      그 창에서 이미 보낸 횟수
--      last_test_id           uuid          마지막 시험 알림의 id (collapse id 't:<id>' 의 근거)
--      last_test_at           timestamptz   그 시험을 만든 시각
--    서버에 멤버별 속도 제한 장치가 없어서(ADR-0208 D10) 시험 라우트가 직접 센다. outbox 를 훑지
--    않는다 — 끝난 행은 인덱스에 안 잡혀 표를 훑게 되기 때문이다. 대신 이 멤버의 notification_rule
--    행(없으면 만든다)을 FOR UPDATE 로 잠근 채 위 컬럼을 갱신한다. 한 행 잠금이라 직렬화되고
--    색인이 필요 없다. 같은 잠금 안에서 last_test_* 도 쓴다.
--
--    모두 NULL 허용이고 DEFAULT 가 없다: 행 부재·NULL = 오늘의 동작(시험 없음). 기존 쓰기
--    (PUT/PATCH notification-rules, presence 묶음)는 INSERT/UPDATE 에 컬럼을 이름으로 적어서 이
--    컬럼을 건드리지 않는다 → 구 서버로 롤백해도 이 컬럼은 그대로 남는다(ADR-0206 I5).
--    CHECK 를 걸지 않는 이유는 090 과 같다: 롤백한 서버의 쓰기가 새 컬럼 때문에 막히면 안 된다.
--    값의 범위는 쓰는 문장(momo-push diagnostics)이 지킨다.
--
-- 3) push_dispatch_log (member_id, created_at DESC) 색인 (M-h)
--    진단은 멤버별 최근 발송 기록(정산 전 2분 이상 · 가장 최근 정산 · 시험 알림의 collapse id)을
--    읽는다. 기존 색인은 message_id(001)와 (member, token, collapse)(011) 뿐이라 멤버 기준
--    최근순 읽기가 표를 훑는다.
--
-- 새 테이블이 없으므로 RLS·GRANT 는 이미 있는 것을 그대로 상속한다: notification_rule 은 066 의
-- ws_isolation FORCE 아래 있고(momo_app DML, momo_notifier SELECT), push_dispatch_log 는 011/001 의
-- 정책 아래 있다. momo_notifier 는 outbox 의 SELECT·INSERT·UPDATE, push_dispatch_log 의
-- SELECT·INSERT·UPDATE, push_token·device·member 의 SELECT 를 이미 가진다(bootstrap_runtime_roles.sql).
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'push_system';

ALTER TABLE notification_rule
  ADD COLUMN IF NOT EXISTS test_push_window_start timestamptz NULL,
  ADD COLUMN IF NOT EXISTS test_push_count        smallint    NULL,
  ADD COLUMN IF NOT EXISTS last_test_id           uuid        NULL,
  ADD COLUMN IF NOT EXISTS last_test_at           timestamptz NULL;

COMMENT ON COLUMN notification_rule.test_push_window_start IS
  '#4341 / ADR-0206 D11: 시험 알림 분당 한도 창(고정 60초)의 시작. NULL = 시험을 한 적 없음. 행 잠금(FOR UPDATE) 안에서만 쓴다.';
COMMENT ON COLUMN notification_rule.test_push_count IS
  '#4341 / ADR-0206 D11: 그 창에서 이미 보낸 시험 알림 수(멤버당 분당 3회). NULL = 0.';
COMMENT ON COLUMN notification_rule.last_test_id IS
  '#4341 / ADR-0206 D11: 마지막 시험 알림의 id. push_dispatch_log 를 collapse id ''t:<id>'' 로 정확 조회해 결과를 읽는다.';
COMMENT ON COLUMN notification_rule.last_test_at IS
  '#4341 / ADR-0206 D11: 마지막 시험 알림을 만든 시각(queued/stalled 30초 경계의 기준).';

CREATE INDEX IF NOT EXISTS push_dispatch_log_member_recent
  ON push_dispatch_log (member_id, created_at DESC);
