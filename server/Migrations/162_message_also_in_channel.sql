-- =============================================================================
-- 162_message_also_in_channel.sql — #4887 (ADR-0148 증보 2026-10-31)
--
-- 왜
--   답글의 집은 스레드다. 그중 보내는 사람이 고른 답글만 본류(채널 타임라인)에도 보이게 하는
--   「대화에도 보내기」를 서버가 알아야 한다. 같은 메시지가 두 자리에 보이는 것이지 복사본이 아니라서
--   (같은 id·같은 seq, 답글 수에도 한 번만 센다) 새 표가 아니라 `message` 열 하나다.
--
-- 무엇
--   message.also_in_channel boolean NOT NULL DEFAULT false
--   message_also_in_channel_reply_ck  CHECK (NOT also_in_channel OR root_id IS NOT NULL)
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 답글(`root_id` 있음)에서만 켤 수 있다. 최상위 글에 켠 행은 INSERT 가 거절된다. 보내기 API 는
--     트랜잭션을 열기 전에 먼저 400 으로 거절하고(모양 검사), 이 CHECK 는 그 검사가 빠진 경로(직접
--     INSERT·다른 생산자)를 막는 두 번째 겹이다.
--   * 값은 보낼 때 한 번 정해진다. 서버의 어떤 UPDATE 도 이 열을 이름 대지 않는다(편집은 body·state·
--     edited_at 만 바꾼다). 보낸 뒤에 켜기는 후속이다.
--
-- 기존 행: 모두 false 다. 기존 답글은 지금까지처럼 스레드에만 있는 답글로 읽힌다. backfill 없음.
-- message 의 AFTER INSERT 트리거들(011·033·079·126·146)은 열 목록을 고정하거나 행 전체를 직렬화하지
-- 않아 영향이 없다(152 의 `sent_via` 가 같은 확인을 했고 그 뒤 message 트리거는 늘지 않았다).
--
-- RLS·권한
--   새 표·새 정책·새 권한 없음. `message` 는 이미 ENABLE + FORCE 이고 정책은 행 단위라 새 열에도 그대로
--   걸린다. 런타임 역할은 표 단위 권한(bootstrap_runtime_roles.sql 의 `momo_notifier` 는 SELECT·INSERT·
--   UPDATE ON TABLE message)이라 새 열에도 닿는다. schema_v0.sql 무접촉.
--
-- 운영 메모(락): `ALTER TABLE message` 는 ACCESS EXCLUSIVE 를 커밋까지 잡는다. 상수 기본값을 가진
-- 열 추가는 메타데이터만 바꾼다(PG 11+). CHECK 는 `NOT VALID` 로 더해 기존 행을 훑지 않는다 — 이 열은
-- 방금 생겨 기존 행이 모두 false 라 어길 수 없고, 새로 쓰는 행(INSERT·UPDATE)은 NOT VALID 여도 검사된다.
-- 그래서 큰 message 에서도 잠금이 메타데이터 변경 길이로 끝난다(planner, S4 착륙 검토).
-- =============================================================================

ALTER TABLE message
  ADD COLUMN also_in_channel boolean NOT NULL DEFAULT false;
ALTER TABLE message
  ADD CONSTRAINT message_also_in_channel_reply_ck
  CHECK (NOT also_in_channel OR root_id IS NOT NULL) NOT VALID;

COMMENT ON COLUMN message.also_in_channel IS
  'ADR-0148 증보 2026-10-31: true = 이 스레드 답글을 보낸 사람이 「대화에도 보내기」를 골랐다(본류에도 보인다). 답글에서만 켤 수 있다(CHECK). 보낼 때 한 번 정해지고 바뀌지 않는다.';
