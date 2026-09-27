-- =============================================================================
-- 091_hosted_dm_approval.sql — #2915 (ADR-0162 증보 2 B1~B5)
--
-- hosted 에이전트의 1:1 DM을 연다.
--
--   hosted_agent_connection.approved_dm_channel_ids
--       에이전트 소유자가 DM 단위로 연 「다른 멤버 ↔ 에이전트」 1:1 DM.
--       approved_channel_ids(관리자의 confirm)와 권한 주체가 달라 따로 둔다.
--       수명은 같다: 재-pairing reset이 비우고, 새 connection은 빈 목록이다.
--
--   hosted_connection_channel_ids(workspace, connection) → uuid[]
--       「이 connection이 덮는 방」의 유일한 정의(B5).
--         approved_channel_ids
--         ∪ 소유자 ↔ 에이전트 1:1 DM(자동, 저장 안 함 — B2)
--         ∪ approved_dm_channel_ids 중 지금도 1:1인 방(owner_only 제외 — B3·B4)
--       selector·inbox·gateway claim·Agent Port identity가 모두 이것을 쓴다.
--       SECURITY INVOKER(기본값)라 호출자의 RLS가 그대로 적용된다. 전 테넌트
--       폴링 역할(relay·agent-worker)은 기존 예외 그대로다.
--
-- DM을 덮는 조건(증보 2 B6, 검수 H1): 그 connection의 confirmed_by(static
-- confirm 또는 OAuth consent를 한 사람)가 에이전트 소유자이고, 소유자가 지금도
-- 활성 사람일 때만. 비소유자가 confirm·consent하면 그 connection의 타인 DM
-- 승인은 같은 tx에서 비워진다(momo-auth confirm·consent).
--
-- 1:1의 뜻: kind='dm', archived_at IS NULL, 활성 멤버(left_at IS NULL)가 정확히
-- 둘이고 그 하나가 이 에이전트. 멤버 수는 판정 때마다 다시 센다.
--
-- RLS: hosted_agent_connection은 069에서 FORCE RLS + ws_isolation 대상이다.
-- 컬럼 추가는 그 정책을 물려받는다. 새 테이블·정책·권한 없음. schema_v0 무접촉.
-- =============================================================================

ALTER TABLE hosted_agent_connection
  ADD COLUMN approved_dm_channel_ids uuid[] NOT NULL DEFAULT '{}';

CREATE FUNCTION hosted_connection_channel_ids(p_workspace_id uuid, p_connection_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(DISTINCT covered.channel_id), '{}'::uuid[])
    FROM (
      SELECT unnest(hc.approved_channel_ids) AS channel_id
        FROM hosted_agent_connection hc
       WHERE hc.workspace_id = p_workspace_id AND hc.id = p_connection_id
      UNION
      SELECT c.id
        FROM hosted_agent_connection hc
        JOIN agent a
          ON a.workspace_id = hc.workspace_id AND a.member_id = hc.agent_member_id
        -- 소유자는 지금도 활성 사람이다(검수 M1).
        JOIN member o
          ON o.workspace_id = hc.workspace_id AND o.id = a.owner_human_id
         AND o.kind = 'human' AND o.status = 'active' AND o.deleted_at IS NULL
        JOIN membership am
          ON am.workspace_id = hc.workspace_id AND am.member_id = hc.agent_member_id
         AND am.left_at IS NULL
        JOIN channel c
          ON c.workspace_id = hc.workspace_id AND c.id = am.channel_id
         AND c.kind = 'dm' AND c.archived_at IS NULL
        JOIN membership pm
          ON pm.workspace_id = hc.workspace_id AND pm.channel_id = c.id
         AND pm.member_id <> hc.agent_member_id AND pm.left_at IS NULL
        -- 상대는 활성 사람이다(검수 M2, 목록·안내와 같은 모양).
        JOIN member p
          ON p.workspace_id = hc.workspace_id AND p.id = pm.member_id
         AND p.kind = 'human' AND p.status = 'active' AND p.deleted_at IS NULL
       WHERE hc.workspace_id = p_workspace_id AND hc.id = p_connection_id
         -- 증보 2 B6(검수 H1): DM은 그 connection을 confirm(static) 또는
         -- consent(OAuth)한 사람이 소유자일 때만 덮는다. 비소유자 관리자가
         -- 재-pairing·confirm으로 자기 런타임에 소유자 DM 이력을 가져가지 못한다.
         AND hc.confirmed_by = a.owner_human_id
         AND (SELECT count(*) FROM membership x
               WHERE x.workspace_id = hc.workspace_id AND x.channel_id = c.id
                 AND x.left_at IS NULL) = 2
         AND (
               pm.member_id = a.owner_human_id
            OR (a.invocation_scope <> 'owner_only'
                AND c.id = ANY(hc.approved_dm_channel_ids))
         )
    ) covered
$$;
