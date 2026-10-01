-- =============================================================================
-- 111_member_avatar.sql — ADR-0161 증보 (2026-10-01): 멤버 아바타 미디어 (#3277)
--
-- 성재 2026-10-01: 「프로필 사진 변경도 가능해야하는데, 그 부분도 가능하게 하고」.
--
-- 067(워크스페이스 아바타)의 모양을 멤버에게 그대로 다시 쓴다 — 같은 pending →
-- complete → failed 수명주기, 같은 Drive `drive_file_id` 바인딩, 같은 테넌트 격리
-- (RLS FORCE). `member.avatar_url`(001, 바 문자열·업로드 경로 0)은 건드리지 않는다:
-- 새 포인터 `member.avatar_media_id` 가 설정돼 있으면 서버가 그것을 해석한 URL 을
-- 내려주고, 없으면 레거시 `avatar_url` 로 물러난다(ADR 증보 D-M4).
--
-- 067 과 다른 것:
--   1. **바인딩이 멤버다.** 미디어 행은 `member_id`(올린 사람 = 주인)를 갖고,
--      포인터는 `member.avatar_media_id`. 자기 것만 쓸 수 있다는 규칙(self-only)이
--      라우트 가드 하나에만 걸려 있지 않도록 **DB 가 같은 말을 한다**: 포인터의
--      복합 FK `(avatar_media_id, id) → member_avatar_media (id, member_id)` 는
--      다른 멤버의 미디어를 가리키는 포인터를 표현 불가능하게 만든다.
--   2. **mime 이 허용 목록이다.** 067 은 `image/%` 였지만 거기엔 `image/svg+xml`
--      (스크립트를 품을 수 있는 문서)이 들어간다. 멤버 아바타는 PNG/JPEG/WebP/GIF
--      네 가지만 — 이 서버 오리진에서 인라인으로 서빙되는 바이트이기 때문이다.
-- =============================================================================

CREATE TABLE member_avatar_media (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  drive_file_id  text,
  name           text NOT NULL,
  mime           text NOT NULL,
  size_bytes     bigint NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_avatar_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT member_avatar_mime_ck CHECK (
    mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  ),
  -- 5 MiB (워크스페이스 아바타와 같다). 24~64px 타일에 그려지는 이미지다.
  CONSTRAINT member_avatar_size_ck CHECK (size_bytes BETWEEN 0 AND 5242880),
  CONSTRAINT member_avatar_status_ck CHECK (status IN ('pending', 'complete', 'failed')),
  CONSTRAINT member_avatar_drive_file_ck CHECK (
    (status = 'failed') OR drive_file_id IS NOT NULL
  ),
  -- 복합 FK 의 참조 대상(아래 member.avatar_media_id). id 가 PK 라 항상 유일하지만
  -- 복합 FK 는 참조 컬럼 조합에 UNIQUE 제약을 요구한다.
  CONSTRAINT member_avatar_id_member_uniq UNIQUE (id, member_id)
);

CREATE UNIQUE INDEX member_avatar_drive_file_uniq
  ON member_avatar_media (workspace_id, drive_file_id)
  WHERE drive_file_id IS NOT NULL;

CREATE INDEX member_avatar_member_idx ON member_avatar_media (member_id);

CREATE INDEX member_avatar_pending_cleanup_idx
  ON member_avatar_media (created_at)
  WHERE status = 'pending';

ALTER TABLE member_avatar_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_avatar_media FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON member_avatar_media
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- 멤버가 가리키는 현재 아바타(완료된 member_avatar_media 행) 또는 NULL.
-- 복합 FK: 포인터는 **자기 id 의 멤버가 올린** 미디어만 가리킬 수 있다.
-- MATCH SIMPLE 이므로 avatar_media_id 가 NULL 이면 검사하지 않는다.
-- ON DELETE SET NULL (avatar_media_id): 컬럼 목록 형태(PG15+)라 id(PK)는 건드리지 않는다.
ALTER TABLE member
  ADD COLUMN avatar_media_id uuid,
  ADD CONSTRAINT member_avatar_media_self_fk
    FOREIGN KEY (avatar_media_id, id)
    REFERENCES member_avatar_media (id, member_id)
    ON DELETE SET NULL (avatar_media_id);

COMMENT ON COLUMN member.avatar_media_id IS
  'ADR-0161 증보(2026-10-01, #3277): 현재 멤버 아바타(완료된 member_avatar_media 행, '
  '반드시 이 멤버가 올린 것 — 복합 FK) 또는 NULL. 설정돼 있으면 해석된 URL 이 '
  'avatar_url 을 이기고, NULL 이면 레거시 avatar_url, 그것도 없으면 이니셜. '
  '교체·제거 시 이전 미디어의 Drive 회수는 후속 잡.';
