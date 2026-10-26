-- =============================================================================
-- attachment_reclaim_check.sql — #4443 / ADR-0151 증보 2: 「지워도 되는 첨부」 읽기 전용 점검
--
-- 무엇을 하나
--   청소기(notifier 스윕, api 프로세스의 로컬 볼륨 스윕)가 켜지기 전에, 그리고 켠 뒤에 사람이 같은 숫자를 다른
--   길로 확인하는 SQL이다. 아무것도 쓰지 않는다(읽기 전용 · REPEATABLE READ 트랜잭션, 마지막에 ROLLBACK). 문장이
--   하나이고 트랜잭션이 스냅샷 하나를 쥐므로, 6절의 동적 문장까지 모든 숫자가 같은 스냅샷에서 나온다. 출력은 전부 같은 모양 `section | key | n | bytes` 이라 psql -A -t -F '|' 로 그대로 읽힌다.
--
-- 어떻게 돌리나
--   슈퍼유저(또는 BYPASSRLS) 접속으로:
--     psql "$DATABASE_URL" -X -f infra/rust/sql/attachment_reclaim_check.sql
--   momo_app 으로 돌리면 RLS 때문에 모든 숫자가 0이다(워크스페이스를 하나도 못 본다) — 정상이고 점검이 아니다.
--   6절은 json/jsonb 열 전부를 한 번씩 훑는다. 큰 인스턴스에서는 한가한 때 돌린다(읽기만 하지만 느릴 수 있다).
--   **배포·마이그레이션 중에는 돌리지 않는다**: 읽기 전용이어도 6절이 json/jsonb 표 전부에 ACCESS SHARE 락을 트랜잭션 끝까지
--   쥐어서, 그동안 들어오는 DDL이 기다리고 그 뒤의 쿼리가 줄을 선다.
--   6절은 json/jsonb 열만 본다(uuid[]·text 열은 보지 않는다). 표본은 가장 오래된 후보 500개다.
--
-- 로그와 어떻게 대조하나 (배포 뒤, 켜기 전에)
--   청소기는 꺼진 채로 틱마다 이런 한 줄을 남긴다:
--     attachment reclaim dry-run: delete_enabled=false scope=<all|touched> looked_at=N workspaces=W candidates=C bytes=B …
--   그 줄의 candidates·bytes 는 「그 틱이 본 워크스페이스」 안에서 삭제가 지울 파일의 전부(한 배치가 아니라)이고,
--   삭제와 같은 술어로 센 값이다. 아래 1절은 같은 술어를 **모든** 워크스페이스에 건다. 그러므로:
--     · 로그의 candidates ≤ 1절의 n, bytes ≤ 1절의 bytes 이면 정상이다.
--       - scope=all(notifier, Google Drive): looked_at 이 100(한 틱에 읽는 워크스페이스 상한)에 닿지 않았다면 같아야 한다.
--       - scope=touched(api 프로세스, 로컬 볼륨): 이 프로세스가 **재시작한 뒤 업로드를 받은** 워크스페이스만 본다. 재시작 뒤
--         업로드가 없던 워크스페이스는 보지 않으므로 로그가 더 작은 것이 정상이다. 3절이 워크스페이스별 목록이라
--         로그의 workspaces·candidates 를 거기에 맞춰 볼 수 있다.
--     · 로그의 candidates 가 1절보다 **크면** 이상이다(청소기가 이 SQL이 모르는 파일을 센다) — 켜지 말고 멈춘다.
--     · 4절에 `UNKNOWN`이 있으면 첨부를 가리키는 새 FK가 생긴 것이다 — 켜지 말고 ADR-0151 증보 2의 「지워도 되는 첨부의
--       정의」를 다시 읽는다. 5절은 전부 0이어야 하고, 6절에 후보 id를 담은 행이 있으면 그 열이 참조인지 확인한다,
--       7절은 0이어야 한다.
--     · 켠 뒤에는 같은 SQL을 다시 돌려 1절이 줄었는지, 8절의 `still naming a file`이 0인지 본다(지운 행마다 감사
--       attachment.expired 가 남는다).
--
-- 후보의 정의 (cand CTE의 술어는 청소기 소스의 것과 글자까지 같다; 단위 시험이 같은지 잰다)
--   status = 'complete', message_id IS NULL, NOT reserved, GREATEST(created_at, unreserved_at) 이 30일(2592000초)보다
--   오래됨, 그리고 아래 어떤 참조도 없음: huddle 전사 3열(FK), 같은 Drive 객체를 가진 아바타 미디어 행.
--   이 표의 근거와 「참조 아님」으로 판정한 자리(message.props·approval.payload·agent_run·outbox·agent memory·클라이언트 초안)는
--   ADR-0151 증보 2의 「지워도 되는 첨부의 정의」에 파일:줄로 있다.
--
-- 절
--   1 candidates   삭제가 지울 파일의 수·바이트(모든 워크스페이스)
--   2 reason       모든 첨부 행을 첫 번째로 맞는 이유로 나눈 분포(CANDIDATE 행 = 1절)
--   3 workspace    후보가 많은 워크스페이스 50곳(로그의 workspaces·candidates 와 맞춰 본다)
--   4 incoming_fk  attachment 를 가리키는 FK 전부와, 이 점검이 아는 것인지(새 참조 종류 감지)
--   5 …            후보 중 참조가 있는 행(0이어야 함)과, 점유 표시(reserved)가 실제 점유 행과 어긋난 수(0이어야 함)
--   6 soft_reference  json/jsonb 열 전부에서 후보 id(오래된 500개 표본)를 글자로 담은 행의 수
--   7 …            후보의 Drive 객체를 다른 행도 가리키는 수(0이어야 함)
--   8 audit        감사 attachment.upload_started 행 중 아직 파일 이름이 남은 수(마이그레이션 151 뒤 0), 청소 기록 수
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ;

WITH cand AS (
  SELECT a.*
    FROM attachment a
   WHERE a.status = 'complete'
     AND a.message_id IS NULL
     AND NOT a.reserved
     AND GREATEST(a.created_at, COALESCE(a.unreserved_at, a.created_at))
         < now() - make_interval(secs => 2592000)
     AND NOT EXISTS (SELECT 1 FROM huddle_transcription_job j
                      WHERE j.workspace_id = a.workspace_id
                        AND j.merged_transcript_attachment_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM huddle_transcription_track t
                      WHERE t.workspace_id = a.workspace_id
                        AND (t.source_attachment_id = a.id OR t.transcript_attachment_id = a.id))
     AND NOT EXISTS (SELECT 1 FROM member_avatar_media m
                      WHERE m.workspace_id = a.workspace_id AND m.drive_file_id = a.drive_file_id)
     AND NOT EXISTS (SELECT 1 FROM workspace_avatar_media w
                      WHERE w.workspace_id = a.workspace_id AND w.drive_file_id = a.drive_file_id)
),
sample AS (
  SELECT id FROM cand ORDER BY created_at, id LIMIT 500
),
pat AS (
  SELECT string_agg(id::text, '|') AS re, count(*)::bigint AS n FROM sample
),
reasons AS (
  SELECT CASE
           WHEN a.status = 'pending' THEN 'pending (this sweep never touches it)'
           WHEN a.status = 'failed' THEN 'failed (this sweep never touches it)'
           WHEN a.message_id IS NOT NULL AND (msg.state = 'deleted' OR msg.deleted_at IS NOT NULL)
             THEN 'bound to a deleted message (kept: message_id is set)'
           WHEN a.message_id IS NOT NULL THEN 'bound to a live message'
           WHEN a.reserved THEN 'held by a scheduled message'
           WHEN GREATEST(a.created_at, COALESCE(a.unreserved_at, a.created_at))
                >= now() - make_interval(secs => 2592000)
             THEN 'unbound, younger than 30 days (or released less than 30 days ago)'
           WHEN EXISTS (SELECT 1 FROM huddle_transcription_job hj
                         WHERE hj.workspace_id = a.workspace_id
                           AND hj.merged_transcript_attachment_id = a.id)
             OR EXISTS (SELECT 1 FROM huddle_transcription_track ht
                         WHERE ht.workspace_id = a.workspace_id
                           AND (ht.source_attachment_id = a.id OR ht.transcript_attachment_id = a.id))
             THEN 'held by a huddle transcription row'
           WHEN EXISTS (SELECT 1 FROM member_avatar_media mam
                         WHERE mam.workspace_id = a.workspace_id AND mam.drive_file_id = a.drive_file_id)
             OR EXISTS (SELECT 1 FROM workspace_avatar_media wam
                         WHERE wam.workspace_id = a.workspace_id AND wam.drive_file_id = a.drive_file_id)
             THEN 'same Drive object as an avatar media row'
           ELSE 'CANDIDATE'
         END AS reason,
         a.size_bytes
    FROM attachment a
    LEFT JOIN message msg ON msg.id = a.message_id AND msg.workspace_id = a.workspace_id
),
json_columns AS (
  SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     AND tb.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.data_type IN ('json', 'jsonb')
)
SELECT section, key, n, bytes
  FROM (
    -- 1. what the delete would take, everywhere
    SELECT 1 AS ord, 'candidates' AS section, 'all_workspaces' AS key,
           count(*)::bigint AS n, COALESCE(sum(size_bytes), 0)::bigint AS bytes
      FROM cand
    UNION ALL
    -- 2. every attachment row, by the first reason that applies
    SELECT 2, 'reason', reason, count(*)::bigint, COALESCE(sum(size_bytes), 0)::bigint
      FROM reasons GROUP BY reason
    UNION ALL
    -- 3. the workspaces with the most candidates
    SELECT 3, 'workspace', w.workspace_id::text, w.n, w.bytes
      FROM (SELECT workspace_id, count(*)::bigint AS n, COALESCE(sum(size_bytes), 0)::bigint AS bytes
              FROM cand GROUP BY workspace_id ORDER BY count(*) DESC, workspace_id LIMIT 50) w
    UNION ALL
    -- 4. every foreign key that points at attachment, and whether this check knows it
    SELECT 4, 'incoming_fk',
           f.conrelid::regclass::text || ' ' || f.conname
             || CASE WHEN f.conname IN (
                    'huddle_transcription_job_workspace_id_merged_transcript_at_fkey',
                    'huddle_transcription_track_workspace_id_source_attachment__fkey',
                    'huddle_transcription_track_workspace_id_transcript_attachm_fkey',
                    'scheduled_message_attachment_attachment_id_fkey')
                  THEN ' (known)'
                  ELSE ' (UNKNOWN: a new reference kind, read the ADR-0151 증보 2 reference table before turning the delete on)'
                END,
           1::bigint, 0::bigint
      FROM pg_constraint f
     WHERE f.confrelid = 'public.attachment'::regclass AND f.contype = 'f'
    UNION ALL
    -- 5. a candidate that something still points at (must be 0), and a reservation the flag lost (must be 0)
    SELECT 5, 'candidate_with_a_reference', 'message_id_set', count(*)::bigint, 0::bigint
      FROM cand WHERE message_id IS NOT NULL
    UNION ALL
    SELECT 5, 'candidate_with_a_reference', 'reservation_row_exists', count(*)::bigint, 0::bigint
      FROM cand c WHERE EXISTS (SELECT 1 FROM scheduled_message_attachment s WHERE s.attachment_id = c.id)
    UNION ALL
    SELECT 5, 'candidate_with_a_reference', 'huddle_transcription_row', count(*)::bigint, 0::bigint
      FROM cand c
     WHERE EXISTS (SELECT 1 FROM huddle_transcription_job j
                    WHERE j.workspace_id = c.workspace_id AND j.merged_transcript_attachment_id = c.id)
        OR EXISTS (SELECT 1 FROM huddle_transcription_track t
                    WHERE t.workspace_id = c.workspace_id
                      AND (t.source_attachment_id = c.id OR t.transcript_attachment_id = c.id))
    UNION ALL
    SELECT 5, 'flag_drift_all_attachments', 'reservation_row_without_reserved_flag', count(*)::bigint, 0::bigint
      FROM attachment a
     WHERE NOT a.reserved
       AND EXISTS (SELECT 1 FROM scheduled_message_attachment s WHERE s.attachment_id = a.id)
    UNION ALL
    SELECT 5, 'flag_drift_all_attachments', 'reserved_flag_without_reservation_row (harmless: never reclaimed)',
           count(*)::bigint, 0::bigint
      FROM attachment a
     WHERE a.reserved
       AND NOT EXISTS (SELECT 1 FROM scheduled_message_attachment s WHERE s.attachment_id = a.id)
    UNION ALL
    -- 6. a candidate's id written as text inside any json/jsonb column (a sample of the 500 oldest)
    SELECT 6, 'soft_reference_sample', 'candidates sampled', pat.n, 0::bigint FROM pat
    UNION ALL
    SELECT 6, 'soft_reference', jc.table_name || '.' || jc.column_name,
           COALESCE((xpath('/row/c/text()',
                           query_to_xml(format('SELECT count(*) AS c FROM %I.%I WHERE %I::text ~ %L',
                                               jc.table_schema, jc.table_name, jc.column_name, pat.re),
                                        false, true, '')))[1]::text::bigint, 0),
           0::bigint
      FROM json_columns jc, pat
     WHERE pat.re IS NOT NULL
    UNION ALL
    -- 7. a candidate whose Drive object another row also names (must be 0)
    SELECT 7, 'drive_object_shared_with', 'another attachment row', count(*)::bigint, 0::bigint
      FROM cand c
     WHERE EXISTS (SELECT 1 FROM attachment o WHERE o.drive_file_id = c.drive_file_id AND o.id <> c.id)
    UNION ALL
    SELECT 7, 'drive_object_shared_with', 'a member avatar media row', count(*)::bigint, 0::bigint
      FROM cand c WHERE EXISTS (SELECT 1 FROM member_avatar_media m WHERE m.drive_file_id = c.drive_file_id)
    UNION ALL
    SELECT 7, 'drive_object_shared_with', 'a workspace avatar media row', count(*)::bigint, 0::bigint
      FROM cand c WHERE EXISTS (SELECT 1 FROM workspace_avatar_media w WHERE w.drive_file_id = c.drive_file_id)
    UNION ALL
    -- 8. the audit trail: names left in old rows, and what the sweep has already written
    SELECT 8, 'audit', 'attachment.upload_started rows still naming a file (0 after migration 151)',
           count(*)::bigint, 0::bigint
      FROM audit_log WHERE action = 'attachment.upload_started' AND detail ? 'name'
    UNION ALL
    SELECT 8, 'audit', 'attachment.upload_started rows', count(*)::bigint, 0::bigint
      FROM audit_log WHERE action = 'attachment.upload_started'
    UNION ALL
    SELECT 8, 'audit', 'attachment.expired rows (one per file the sweep deleted)', count(*)::bigint, 0::bigint
      FROM audit_log WHERE action = 'attachment.expired'
  ) s
 ORDER BY ord, key;

ROLLBACK;
