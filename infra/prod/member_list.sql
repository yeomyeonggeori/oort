-- MOMO-560 operator member listing. The workspace selector arrives only
-- through the environment; no database credential or secret is accepted here.
\getenv workspace_id MOMO_OPS_WORKSPACE_ID

BEGIN;
SET LOCAL app.workspace_id = :'workspace_id';

\pset pager off
\pset null '(none)'
\pset border 1
SELECT m.id,
       m.handle,
       m.display_name,
       m.kind::text AS kind,
       m.status::text AS status,
       COALESCE(wm.role::text, '(none)') AS workspace_role
  FROM member m
  LEFT JOIN workspace_membership wm
    ON wm.workspace_id = m.workspace_id
   AND wm.member_id = m.id
 WHERE m.workspace_id = :'workspace_id'::uuid
   AND m.deleted_at IS NULL
 ORDER BY CASE COALESCE(wm.role::text, '')
            WHEN 'owner' THEN 0
            WHEN 'admin' THEN 1
            WHEN 'member' THEN 2
            WHEN 'guest' THEN 3
            ELSE 4
          END,
          lower(m.handle),
          m.id;

COMMIT;
