-- =============================================================================
-- 112_avatar_drive_reclaim.sql — ADR-0161 D5 + 증보 2: 아바타 Drive 회수 잡 (#3284)
--
-- 교체·제거·실패·TTL 지난 pending 업로드의 Drive 객체를 지우는 잡(momo-notifier
-- 의 avatar reclaim sweep)이 「이미 지웠다」를 기록할 자리다. 행은 지우지 않는다:
--   * `member.avatar_media_id` 의 FK 는 ON DELETE SET NULL 이라, 현재 아바타 행을
--     (경합으로) 잘못 지우면 아바타가 조용히 사라진다 — 행 삭제 대신 표식만 쓴다.
--   * `reserve_member_avatar_upload_in_tx` 는 최근 1시간의 모든 상태 행을 세어
--     업로드 상한을 건다. 행을 지우면 그 상한이 약해진다.
--
-- `drive_reclaimed_at` 이 NULL 이 아니면 그 행은 **해소**됐다: Drive 객체를 지웠거나
-- (또는 처음부터 없었다 = Drive 404), Drive 가 **영구 거절**했다(그 객체는 이 아카이브의
-- 공유 드라이브 소속이 아니라 우리가 지울 것이 아니다 — 감사 행의 `refused` 로 남는다).
-- 영구 거절 행을 매 틱 재시도하면 새 후보를 굶기므로 표식을 쓴다. 잡은 `drive_file_id IS NOT NULL AND
-- drive_reclaimed_at IS NULL` 인 행만 후보로 삼으므로 재실행은 안전하다(멱등).
-- 번호는 연속이어야 한다(momo-db `migrate::tests`).
-- =============================================================================

ALTER TABLE member_avatar_media    ADD COLUMN drive_reclaimed_at timestamptz;
ALTER TABLE workspace_avatar_media ADD COLUMN drive_reclaimed_at timestamptz;

-- 회수 후보 스캔(교차 테넌트 읽기) 전용 부분 인덱스. 회수된 행과 Drive 파일이
-- 없는 예약 행은 들어가지 않는다.
CREATE INDEX member_avatar_reclaim_idx
  ON member_avatar_media (created_at)
  WHERE drive_file_id IS NOT NULL AND drive_reclaimed_at IS NULL;
CREATE INDEX workspace_avatar_reclaim_idx
  ON workspace_avatar_media (created_at)
  WHERE drive_file_id IS NOT NULL AND drive_reclaimed_at IS NULL;

-- 「이 행이 현재 아바타인가」 검사(소유 행의 avatar_media_id 역조회). 067/111 은 FK 컬럼에
-- 인덱스를 두지 않았다.
CREATE INDEX member_avatar_media_pointer_idx
  ON member (avatar_media_id) WHERE avatar_media_id IS NOT NULL;
CREATE INDEX workspace_avatar_media_pointer_idx
  ON workspace (avatar_media_id) WHERE avatar_media_id IS NOT NULL;

COMMENT ON COLUMN member_avatar_media.drive_reclaimed_at IS
  'ADR-0161 증보 2 (#3284): Drive 객체를 해소한 시각(삭제함·이미 없음·영구 거절). NULL 이면 아직(또는 현재 아바타). '
  '현재 아바타(member.avatar_media_id)인 행에는 잡이 절대 쓰지 않는다.';
COMMENT ON COLUMN workspace_avatar_media.drive_reclaimed_at IS
  'ADR-0161 D5 + 증보 2 (#3284): Drive 객체를 해소한 시각(삭제함·이미 없음·영구 거절). NULL 이면 아직(또는 현재 아바타). '
  '현재 아바타(workspace.avatar_media_id)인 행에는 잡이 절대 쓰지 않는다.';
