-- =============================================================================
-- 067_workspace_avatar.sql — ADR-0161 D5 (워크스페이스 아바타 미디어)
--
-- 번호: 처음엔 066 이었다(그때 origin 최신이 065). 병렬 배치 W-B2-3(알림 규칙)의
-- 066_notification_rule 이 먼저 랜딩해 리베이스에서 067 로 재부여했다 — 패킷이
-- 예고한 「충돌 시 리베이스로 재부여」 그대로다. 마이그레이션 집합은 연속이어야
-- 하므로(momo-db `migrate::tests`) 번호를 비워 두고 건너뛰지 않는다.
--
-- 레일이 워크스페이스마다 이니셜 한 글자만 그리는 이유는 스키마에 아바타를 담을
-- 자리가 없어서였다(ADR-0161 Context 1: `workspace` 에 아바타/로고 컬럼 0).
-- `member.avatar_url` 은 있으나 그것은 사람의 바 문자열이고 업로드 경로가 없다.
--
-- 이 파일은 아바타 미디어를 **첨부(017)의 모양 그대로** 놓는다 — 같은 pending →
-- complete → failed 수명주기, 같은 Drive `drive_file_id` 바인딩, 같은 테넌트
-- 격리(RLS FORCE). 다른 것은 셋뿐이고, 각각이 ADR-0161 D5 의 결정이다:
--
--   1. **바인딩이 채널이 아니라 워크스페이스다.** 첨부는 채널·메시지에 묶이지만
--      아바타는 워크스페이스 하나에 묶인다. 그래서 `channel_id`·`message_id` 가
--      없고, 대신 `workspace.avatar_media_id` 가 완료된 미디어 한 행을 가리킨다.
--   2. **읽기 스코프가 더 넓다.** 첨부 content 는 채널 멤버십 인가지만(0151 D3),
--      아바타는 워크스페이스 멤버 누구나 레일에서 상시 렌더한다 — 인가는 라우트가
--      `active_workspace_role` 로 판정하고, 이 테이블은 테넌트 경계만 진다.
--   3. **가변·교체다.** 첨부는 메시지에 묶여 immutable 이지만 아바타는 워크스페이스당
--      한 장, 교체 가능. 교체는 새 완료 미디어 행을 만들고 `avatar_media_id` 를
--      그리로 옮긴다(이전 행의 Drive 정리는 후속 잡, ADR-0161 D5 "교체 회수").
--
-- 크기 상한이 첨부(100MB)보다 작다: 아바타는 레일의 24~44px 타일에 그려지는
-- 작은 이미지라 5MB 로 충분하고, 그보다 큰 것을 아바타로 받을 이유가 없다.
-- mime 은 image/* 로 못박는다 — 아바타 자리에 임의 파일이 서면 content 프록시가
-- 이미지가 아닌 바이트를 레일 <img> 에 흘린다.
-- =============================================================================

CREATE TABLE workspace_avatar_media (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  uploader_member_id  uuid NOT NULL REFERENCES member(id),
  drive_file_id       text,
  name                text NOT NULL,
  mime                text NOT NULL,
  size_bytes          bigint NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_avatar_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT workspace_avatar_mime_ck CHECK (mime LIKE 'image/%' AND length(mime) BETWEEN 1 AND 255),
  -- 5 MiB. 아바타는 작은 타일에 그려진다 — 첨부의 100MB 는 여기 이유가 없다.
  CONSTRAINT workspace_avatar_size_ck CHECK (size_bytes BETWEEN 0 AND 5242880),
  CONSTRAINT workspace_avatar_status_ck CHECK (status IN ('pending', 'complete', 'failed')),
  -- 실패한 업로드만 Drive 파일 없이 설 수 있다(첨부 017 과 같은 규칙).
  CONSTRAINT workspace_avatar_drive_file_ck CHECK (
    (status = 'failed') OR drive_file_id IS NOT NULL
  )
);

-- 테넌트별 유일성 (첨부 044 가 전역에서 테넌트로 좁힌 것과 같은 규칙, MOMO-638).
-- 한 워크스페이스 안에서 같은 Drive 파일이 두 미디어 행을 갖지 않는다.
CREATE UNIQUE INDEX workspace_avatar_drive_file_uniq
  ON workspace_avatar_media (workspace_id, drive_file_id)
  WHERE drive_file_id IS NOT NULL;

-- 잡이 버려진 pending 업로드를 완료된 행을 건드리지 않고 훑는다(첨부 017 과 동형).
CREATE INDEX workspace_avatar_pending_cleanup_idx
  ON workspace_avatar_media (created_at)
  WHERE status = 'pending';

ALTER TABLE workspace_avatar_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_avatar_media FORCE ROW LEVEL SECURITY;
-- 이 정책 하나가 아바타 스코프 격리의 전부다: 워크스페이스 A 의 세션은
-- app.workspace_id=A 로만 열리므로 B 의 아바타 미디어(그 drive_file_id 포함)를
-- 한 행도 못 본다. red proof(avatar-scope-isolation)가 이 줄을 증명한다.
CREATE POLICY ws_isolation ON workspace_avatar_media
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- 워크스페이스가 가리키는 현재 아바타. 완료된 미디어 한 행이거나 NULL(이니셜
-- 폴백, 현행 유지). 교체 시 이 포인터가 새 완료 행으로 옮겨간다.
ALTER TABLE workspace
  ADD COLUMN avatar_media_id uuid REFERENCES workspace_avatar_media(id);

COMMENT ON COLUMN workspace.avatar_media_id IS
  'ADR-0161 D5: 현재 워크스페이스 아바타(완료된 workspace_avatar_media 행) 또는 '
  'NULL. NULL 이면 레일이 이름 이니셜로 폴백한다. 교체는 새 완료 행으로 이 '
  '포인터를 옮기고, 이전 미디어의 Drive 회수는 후속 잡이 한다.';
