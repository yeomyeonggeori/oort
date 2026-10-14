-- =============================================================================
-- 131_agent_avatar_image.sql — ADR-0186 증보 2026-10-13 (v3) V3-2a, #3786 (A0)
--
-- 에이전트 프로필 사진이 **승인된 액션**으로 바뀌게 되면서(ADR-0161 D-M2를 이 증보가
-- 명시적으로 넓힌다), 그 이미지의 보관소가 필요하다. Drive에는 서버가 바이트를 쓰는
-- API가 없고(읽기·삭제·세션 생성뿐), 외부 URL은 금지이므로 **서버가 재인코딩한
-- 결과만** 이 테이블(Postgres)에 둔다. 원본 바이트·메타데이터는 저장하지 않는다.
--
--   1. **staged → applied.** 제안(propose)이 행을 `staged`로 만들고(승인 카드의
--      미리보기·핀의 대상), 승인이 `applied`로 바꾼다. 거절·만료·취소는 행을 지운다.
--   2. **불변.** `bytes`·`mime`·`sha256`·`width`·`height`·`size_bytes`·`member_id`·
--      `source`·`proposed_by` 는 INSERT 이후 바꿀 수 없다(트리거). 승인 payload 의
--      sha256 핀이 가리킨 것과 적용되는 것이 DB 수준에서도 같은 바이트다.
--   3. **자기 행만 가리킨다.** `member.avatar_image_id` 의 복합 FK
--      `(avatar_image_id, id) → agent_avatar_image (id, member_id)` 는 다른 멤버의
--      이미지를 가리키는 포인터를 표현 불가능하게 만든다(111 과 같은 방어).
--   4. 테넌트 격리: RLS FORCE + ws_isolation.
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
-- =============================================================================

CREATE TABLE agent_avatar_image (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 이미지의 주인 = 아바타를 갖게 될 에이전트(제안자가 아니다).
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  proposed_by   uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  source        text NOT NULL,
  mime          text NOT NULL,
  width         integer NOT NULL,
  height        integer NOT NULL,
  size_bytes    integer NOT NULL,
  sha256        bytea NOT NULL,
  bytes         bytea NOT NULL,
  status        text NOT NULL DEFAULT 'staged',
  -- The approval this image was staged for. NULL until the approval exists (the
  -- image is staged first so the card can preview it); then set **once**: the
  -- trigger below allows NULL → value and nothing else, and the UNIQUE makes one
  -- image belong to at most one approval. The decision accepts an image only under
  -- the approval it is bound to.
  approval_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_avatar_approval_uniq UNIQUE (approval_id),
  CONSTRAINT agent_avatar_source_ck CHECK (source IN ('attachment', 'generated')),
  -- 출력은 PNG 또는 JPEG 뿐이다(서버가 새로 인코딩한다). 입력의 WebP/그 밖은 여기 오지 않는다.
  CONSTRAINT agent_avatar_mime_ck CHECK (mime IN ('image/png', 'image/jpeg')),
  CONSTRAINT agent_avatar_dim_ck CHECK (width BETWEEN 1 AND 512 AND height BETWEEN 1 AND 512),
  -- 512 KiB: 24~64px 타일에 그려지는 이미지다.
  CONSTRAINT agent_avatar_size_ck CHECK (size_bytes BETWEEN 1 AND 524288),
  CONSTRAINT agent_avatar_len_ck CHECK (octet_length(bytes) = size_bytes),
  CONSTRAINT agent_avatar_sha_ck CHECK (octet_length(sha256) = 32),
  CONSTRAINT agent_avatar_status_ck CHECK (status IN ('staged', 'applied')),
  CONSTRAINT agent_avatar_id_member_uniq UNIQUE (id, member_id)
);

CREATE INDEX agent_avatar_member_idx ON agent_avatar_image (workspace_id, member_id);
-- 오래된 staged 행을 다음 제안이 같은 트랜잭션에서 정리한다(별도 sweep 없음).
CREATE INDEX agent_avatar_staged_idx ON agent_avatar_image (created_at) WHERE status = 'staged';

ALTER TABLE agent_avatar_image ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_avatar_image FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON agent_avatar_image
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- 불변: 바이트·해시·치수·주인·출처는 INSERT 이후 바꿀 수 없다. 바꿀 수 있는 것은 상태
-- (`staged → applied`) 하나다.
CREATE FUNCTION agent_avatar_image_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.width IS DISTINCT FROM OLD.width
     OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_avatar_image is immutable except for status' USING ERRCODE = '23000';
  END IF;
  -- The approval binding is write-once.
  IF OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id THEN
    RAISE EXCEPTION 'agent_avatar_image.approval_id is write-once' USING ERRCODE = '23000';
  END IF;
  IF OLD.status = 'applied' AND NEW.status = 'staged' THEN
    RAISE EXCEPTION 'agent_avatar_image cannot go back to staged' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_avatar_image_immutable_trg
  BEFORE UPDATE ON agent_avatar_image
  FOR EACH ROW EXECUTE FUNCTION agent_avatar_image_immutable();

-- 워크스페이스 일치: FK 검사는 RLS 를 우회하므로 `member_id`·`proposed_by` 가 **같은
-- 워크스페이스의 멤버**라는 사실은 이 트리거가 INSERT 때 직접 확인한다(주인은 에이전트).
CREATE FUNCTION agent_avatar_image_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM member m
                  WHERE m.id = NEW.member_id AND m.workspace_id = NEW.workspace_id
                    AND m.kind = 'agent') THEN
    RAISE EXCEPTION 'agent_avatar_image.member_id must be an agent of the same workspace'
      USING ERRCODE = '23000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM member m
                  WHERE m.id = NEW.proposed_by AND m.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'agent_avatar_image.proposed_by must be a member of the same workspace'
      USING ERRCODE = '23000';
  END IF;
  IF NEW.status <> 'staged' OR NEW.approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'agent_avatar_image rows are inserted staged and unbound'
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_avatar_image_guard_insert_trg
  BEFORE INSERT ON agent_avatar_image
  FOR EACH ROW EXECUTE FUNCTION agent_avatar_image_guard_insert();

-- 에이전트가 가리키는 현재 이미지(`applied` 행) 또는 NULL. 복합 FK: 포인터는 **자기
-- id 의 멤버 몫**의 이미지만 가리킬 수 있다(MATCH SIMPLE: NULL 이면 검사 없음).
-- ON DELETE SET NULL (avatar_image_id): 컬럼 목록 형태(PG15+)라 id(PK)는 건드리지 않는다.
ALTER TABLE member
  ADD COLUMN avatar_image_id uuid,
  ADD CONSTRAINT member_avatar_image_self_fk
    FOREIGN KEY (avatar_image_id, id)
    REFERENCES agent_avatar_image (id, member_id)
    ON DELETE SET NULL (avatar_image_id);

-- 한 멤버는 업로드 아바타(111)와 승인된 이미지 아바타를 동시에 갖지 않는다 — 로스터와
-- 서빙 프록시가 어느 쪽이 이기는지에 대해 어긋날 수 없게 DB 가 말한다.
ALTER TABLE member
  ADD CONSTRAINT member_avatar_exclusive_ck
    CHECK (avatar_media_id IS NULL OR avatar_image_id IS NULL);
-- 이미지 행 삭제 때 포인터 FK 검사가 member 를 훑지 않게.
CREATE INDEX member_avatar_image_idx ON member (avatar_image_id)
  WHERE avatar_image_id IS NOT NULL;

COMMENT ON TABLE agent_avatar_image IS
  'ADR-0186 증보 2026-10-13 V3-2a: 에이전트 프로필 이미지(서버가 재인코딩한 PNG/JPEG, ≤512x512, ≤512KiB). staged(제안·카드 미리보기·핀) → applied(승인). 불변(트리거).';
COMMENT ON COLUMN member.avatar_image_id IS
  'ADR-0186 증보 2026-10-13: 에이전트의 현재 승인된 이미지 아바타(agent_avatar_image.applied, 복합 FK 로 자기 몫만) 또는 NULL. 설정돼 있으면 해석된 아바타 URL 이 avatar_url 을 이긴다.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_avatar_image TO momo_app;
  END IF;
END $$;
