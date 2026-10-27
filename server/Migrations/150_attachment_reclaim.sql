-- =============================================================================
-- 150_attachment_reclaim.sql — #4443 / ADR-0151 증보 2: 묶이지 않은 완료 첨부 청소기의 전제
--
-- 왜
--   청소기(notifier 스윕, ADR-0151 증보 2 D4)는 「어떤 메시지에도 예약에도 묶이지 않은 오래된 완료
--   첨부」를 지운다. 예약이 쥔 첨부(ADR-0208 D11)는 지우면 안 된다 — 지우면 점유 행이 CASCADE 로
--   사라져 예약이 나갈 때 파일 없이 나간다. 그런데 점유 표 scheduled_message_attachment 는 작성자
--   범위 RLS 이고(145: workspace_id AND member_id) BYPASSRLS 역할에는 봉인돼 있다(ADR-0208 D3).
--   청소기가 점유를 직접 보려면 남의 app.member_id 를 묶어야 하는데, 그것은 ADR-0208 D14-4 가
--   이름 있는 세 함수로 고정한 예외다. 새 예외도 새 SECURITY DEFINER 도 만들지 않으려고, 점유라는
--   사실만 attachment 행에 비춘다.
--
-- 무엇
--   attachment.reserved       점유 행이 있으면 true. 청소기는 이 열만 본다.
--   attachment.unreserved_at  마지막으로 점유가 풀린 때. 취소·정리로 풀린 파일은 「초안과 같은 상태」로
--                             남는다고 ADR-0208 D11 이 적었으므로, 청소기의 시계는
--                             GREATEST(created_at, unreserved_at) 다 — 100일 묵은 예약을 취소하는 순간
--                             파일이 사라지지 않는다.
--   트리거 scheduled_message_attachment_reserve_trg
--                             점유 행 INSERT 는 reserved=true, DELETE 는 reserved=false + 시각.
--                             예약 생성·취소·발송·정리·CASCADE 가 어느 경로로 점유를 만들고 지우든 한 곳에서
--                             맞춘다(호출 자리마다 고치면 하나를 빠뜨리는 순간 청소기가 점유된 파일을 지운다).
--   partial index             청소기 후보 읽기용. 「묶이지 않은 완료 첨부」만 담는 작은 집합이다.
--   notifier 컬럼 GRANT       교차 테넌트 읽기용 SELECT 컬럼 여섯 개(#3377 전례의 컬럼 단위). 그 읽기는
--                             **워크스페이스 id만** 답한다. 첨부 id·drive_file_id·name·mime·size_bytes·
--                             uploader 는 주지 않는다 — 후보 목록·참조 재판정·바이트 집계·삭제는 전부 워크스페이스별
--                             momo_app(RLS-bound) tx 가 한다.
--
-- 순서가 중요한 이유 (146 과 같다)
--   트리거를 먼저 만들고 백필한다. 백필을 먼저 하면 그 사이에 만들어진 점유를 아무도 세지 않는다.
--   트리거 다음에 백필하면 같은 점유를 두 번 세도 true 라서 결과가 같다(틈 없음).
--
-- RLS
--   attachment 는 그대로 ws_isolation(017). 트리거 함수는 SECURITY INVOKER 다: 점유 행 INSERT/DELETE 가
--   RLS 를 통과한 같은 tx·같은 app.workspace_id 라서 attachment UPDATE 도 같은 정책으로 통과한다
--   (146 의 channel_seq 트리거, 011 의 push_candidate_enqueue_trg 와 같은 구조). 함수는 public 에 둔다:
--   145 의 scheduled-message-lockdown 블록은 momo_schedule_private 스키마와 점유·예약 표를 봉인하는 것이고,
--   이 함수는 봉인할 표를 새로 만들지 않는다. 새 테넌트 표도 없다.
--
-- 운영 메모(락): ALTER TABLE ADD COLUMN 은 상수 기본값이라 표를 다시 쓰지 않지만, 마이그레이션 한 트랜잭션 안에서
--   ACCESS EXCLUSIVE 를 커밋까지 쥔다. 그래서 뒤의 백필과 CREATE INDEX(표 전체를 한 번 훑는다)가 도는 동안 attachment 를
--   읽는 요청(history 조인·content·보내기 echo)도 쓰는 요청도 기다린다. attachment 행 수는 업로드 수라 팀 규모에서는
--   짧다. partial index 는 「조회 때 작은 집합만 훑는다」는 뜻이지 빌드가 작다는 뜻이 아니다.
-- =============================================================================

-- ---- 1) 컬럼 ---------------------------------------------------------------
ALTER TABLE attachment
  ADD COLUMN reserved boolean NOT NULL DEFAULT false,
  ADD COLUMN unreserved_at timestamptz;

COMMENT ON COLUMN attachment.reserved IS
  'ADR-0151 증보 2 (#4443): true while a scheduled_message_attachment row holds this file (ADR-0208 D11). Maintained by scheduled_message_attachment_reserve_trg; the reclaim sweep reads only this, because the reservation table is owner-scoped and sealed from BYPASSRLS roles.';
COMMENT ON COLUMN attachment.unreserved_at IS
  'ADR-0151 증보 2 (#4443): when the last reservation of this file was released (cancel, purge, send). The reclaim sweep measures its TTL from GREATEST(created_at, unreserved_at), so a released file stays a draft for a full TTL.';

-- ---- 2) 트리거 (백필보다 먼저) -----------------------------------------------
CREATE FUNCTION attachment_reservation_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE attachment
       SET reserved = true
     WHERE id = NEW.attachment_id
       AND workspace_id = NEW.workspace_id;
    RETURN NEW;
  END IF;
  UPDATE attachment
     SET reserved = false,
         unreserved_at = now()
   WHERE id = OLD.attachment_id
     AND workspace_id = OLD.workspace_id;
  RETURN OLD;
END $$;

COMMENT ON FUNCTION attachment_reservation_sync() IS
  'ADR-0151 증보 2 (#4443): AFTER INSERT OR DELETE ON scheduled_message_attachment — mirrors the reservation onto attachment.reserved / unreserved_at. SECURITY INVOKER (same tx, same app.workspace_id as the reservation write).';

CREATE TRIGGER scheduled_message_attachment_reserve_trg
  AFTER INSERT OR DELETE ON scheduled_message_attachment
  FOR EACH ROW EXECUTE FUNCTION attachment_reservation_sync();

-- ---- 3) 백필 (트리거 다음) ----------------------------------------------------
-- scheduled_message_attachment 는 작성자 범위 FORCE RLS 이고 마이그레이션에는 app.workspace_id 도
-- app.member_id 도 없다. 전 테넌트를 훑어야 하므로 002/005/012/055/064/088/146 과 같은 자리에서 같은 줄을
-- 건다. migration 은 정책을 우회하는 역할(슈퍼유저·BYPASSRLS)로 돌아서 이 줄은 우회 스위치가 아니라
-- 안전망이다: 그런 권한이 없는 역할이면 정책에 걸려 조용히 0행이 되는 대신 오류로 멈춘다(088 실측).
--
-- 아래 단정은 UPDATE 가 true 로 올린 행 수를, 점유 행 수를 따로 센 값과 맞춘다. attachment_id 가
-- UNIQUE 라서 점유 행 하나는 첨부 하나다. **두 수를 한 문장에서 센다**: 배포 중에는 이전 버전의 api 가 아직
-- 예약을 만들고 있을 수 있어서, 문장을 둘로 가르면 그 사이에 들어온 점유 행이 「어긋남」으로 읽혀 마이그레이션이
-- 거짓으로 멈춘다(READ COMMITTED 는 문장마다 스냅샷을 새로 잡는다. 그 점유 행은 트리거가 스스로 올린다).
-- 빈 DB(새 설치)는 0 = 0 이라 통과한다. 값이 맞는지(true 로 올렸는지)는 이 단정이 아니라
-- prod_role_conformance_pg 의 업그레이드 시험이 실제 점유 행으로 잰다.
SET LOCAL row_security = off;

DO $$
DECLARE
  flagged  bigint;
  expected bigint;
BEGIN
  WITH touched AS (
    UPDATE attachment a
       SET reserved = true
     WHERE EXISTS (SELECT 1
                     FROM scheduled_message_attachment s
                    WHERE s.attachment_id = a.id)
    RETURNING a.id
  )
  SELECT (SELECT count(*) FROM touched),
         (SELECT count(*) FROM scheduled_message_attachment)
    INTO flagged, expected;

  IF flagged <> expected THEN
    RAISE EXCEPTION
      '150 backfill: % attachments flagged reserved but % reservation rows exist', flagged, expected;
  END IF;
END $$;

-- ---- 4) 청소기 후보 인덱스 -----------------------------------------------------
-- 「묶이지 않은 완료 첨부」만 담는다. 교차 테넌트 읽기(워크스페이스 id)도, 워크스페이스별 목록도 이 집합을
-- created_at 순으로 읽고, 시계의 나머지 항(unreserved_at)은 행 필터로 건다. 이 집합은 초안과 쓰레기뿐이라 작다.
CREATE INDEX attachment_unbound_reclaim_idx
  ON attachment (created_at, id)
  WHERE status = 'complete' AND message_id IS NULL AND NOT reserved;

-- ---- 5) notifier 교차 테넌트 읽기 GRANT ---------------------------------------
-- 컬럼 단위: workspace_id (어느 테넌트인지), status·message_id·reserved·unreserved_at·created_at (후보 술어의
-- 핵심 항). 청소기의 교차 테넌트 읽기는 `SELECT workspace_id … GROUP BY workspace_id` 하나이고 첨부 id조차
-- 읽지 않는다. 같은 줄이 infra/rust/sql/bootstrap_runtime_roles.sql 에도 있다(운영 부트스트랩은 마이그레이션 뒤에
-- 한 번 더 돈다). 개발 부트스트랩은 기본 권한으로 이미 읽는다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT (workspace_id, status, message_id, reserved, unreserved_at, created_at)
      ON attachment TO momo_notifier;
  END IF;
END $$;
