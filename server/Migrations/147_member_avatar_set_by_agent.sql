-- =============================================================================
-- 147_member_avatar_set_by_agent.sql — ADR-0186 증보 2026-10-25 (v4) `member.avatar.set`, #4385
--
-- 사람이 대화에 첨부한 사진을 「이걸로 내 프로필 사진 바꿔줘」로 에이전트에게 맡기면,
-- 에이전트가 **제안**하고 본인이 승인 카드에서 승인한다. 서버가 Drive 에 바이트를 쓸 길이
-- 없으므로(131 의 이유 그대로) 승인될 이미지는 131 의 `agent_avatar_image`(서버가 재인코딩한
-- PNG/JPEG, staged → applied, 불변)에 둔다. 테이블 이름은 그대로 두고(이름 변경은 범위 밖),
-- 바뀌는 것은 INSERT 가드 하나다.
--
--   131: 이미지의 주인(member_id)은 에이전트여야 한다.
--   147: 주인은 아무 멤버나 될 수 있고, **제안자(proposed_by)가 에이전트**여야 한다.
--        (사람이 자기 사진을 이 테이블에 직접 넣는 길은 계속 없다. 사람 본인의 직접 업로드는
--         111 의 Drive 경로가 그대로 맡는다.)
--
-- 바꾸지 않는 것: 불변 트리거·`approval_id` write-once·복합 FK(자기 몫 이미지만 가리킴)·
-- `member_avatar_exclusive_ck`(업로드 아바타와 이미지 아바타는 동시에 없다)·RLS FORCE.
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
-- =============================================================================

CREATE OR REPLACE FUNCTION agent_avatar_image_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 이미지를 만든(제안한) 쪽은 늘 에이전트다. 대상(member_id)은 에이전트(131 의 프로필
  -- 사진) 또는 그 에이전트를 부른 사람 본인(147). 같은 워크스페이스라는 사실은 복합 FK 가 말한다.
  IF NOT EXISTS (SELECT 1 FROM public.member p
                  WHERE p.id = NEW.proposed_by AND p.workspace_id = NEW.workspace_id
                    AND p.kind = 'agent') THEN
    RAISE EXCEPTION 'agent_avatar_image.proposed_by must be an agent'
      USING ERRCODE = '23000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.member m
                  WHERE m.id = NEW.member_id AND m.workspace_id = NEW.workspace_id
                    AND m.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'agent_avatar_image.member_id must be a member'
      USING ERRCODE = '23000';
  END IF;
  IF NEW.status <> 'staged' OR NEW.approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'agent_avatar_image rows are inserted staged and unbound'
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON TABLE agent_avatar_image IS
  'ADR-0186 증보 V3-2a(131)·v4(147): 에이전트가 제안한 프로필 이미지(서버가 재인코딩한 PNG/JPEG, ≤512x512, ≤512KiB). 주인은 대상 에이전트 또는 요청한 사람 본인. staged(제안·카드 미리보기·핀) → applied(승인). 불변(트리거).';
