-- =============================================================================
-- 146_dm_closure.sql — #4227 (ADR-0177 증보 2026-10-24, #4226: D6·D9)
--
-- DM 닫기를 서버에 두고(D6), 「읽을 메시지의 마지막 seq」를 서버가 알게 한다(D9).
--
--   1) channel_seq.last_readable_seq   기계 메시지(도구 호출·결과·시스템 줄·작업 세션 카드)를
--                                      뺀 마지막 seq. 단조 증가.
--   2) 트리거 message_last_readable_seq_trg   그 열을 메시지 INSERT 와 같은 tx 에서 올린다.
--   3) 백필                            이미 있는 채널의 값을 채운다. 트리거가 먼저, 백필이 나중이다.
--   4) dm_closure                      멤버 소유 「이 DM 을 내 목록에서 치웠다」 사실.
--
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
--
-- 순서가 중요한 이유 (D9 「순서」)
--   트리거를 만들기 전에 백필하면, 그 사이에 들어온 메시지는 어느 쪽도 세지 않는다.
--   트리거를 먼저 만들고 백필하면 같은 메시지를 두 번 세도 GREATEST 라 결과가 같다(틈 없음).
--   `psql --single-transaction` 이라 CREATE TRIGGER 의 잠금이 커밋까지 가지만, 순서를 잠금에
--   기대지 않는다.
--
-- 읽을 메시지의 정의는 한 문장이다 (트리거와 백필이 같은 식을 쓴다)
--     type NOT IN ('tool_call','tool_result','system')
--     AND (props->>'kind') IS DISTINCT FROM 'work_session'
--   `<>` 를 쓰지 않는다. kind 가 없는 보통 메시지는 `props->>'kind'` 가 NULL 이라 `<>` 는 NULL(거짓)이
--   되어 아무것도 올리지 못한다. 코어 `isAmbientMessage`(ambientMessage.ts) 와 같은 뜻이어야 하고,
--   그 일치를 docs/api/dm-readable-message.golden.json 이 양쪽에서 잰다. 삭제된 메시지는
--   INSERT 시점에 볼 수 없다(트리거). 백필도 삭제 여부를 보지 않는다 — 라이브 트리거와 같은 뜻으로,
--   나중에 삭제된 메시지도 센다. 값은 내려가지 않는다(틀려도 「보임」 쪽이라 받아들인다).
--
-- RLS: dm_closure 는 ENABLE + FORCE, 표준 ws_isolation(084·141 과 같은 문법). 멤버 경계는
-- 정책이 아니라 쿼리 술어(`member_id = 요청자`)가 지킨다 — RLS 는 워크스페이스만 가른다.
-- 이벤트 없음(D10): outbox 트리거도 relay 팬아웃도 만들지 않는다. 다른 기기는 다음 읽음 투영
-- 조회에서 맞춰진다.
-- =============================================================================

-- ---- 1) channel_seq.last_readable_seq ---------------------------------------
ALTER TABLE channel_seq
  ADD COLUMN last_readable_seq bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN channel_seq.last_readable_seq IS
  'ADR-0177 D9 (#4227): newest message.seq that is worth reading (not tool_call/tool_result/system, props.kind <> work_session — NULL kind counts as readable). Raised by message_last_readable_seq_trg in the inserting transaction; monotonic, never lowered when a message is later deleted. 0 = nothing readable yet.';

-- ---- 2) 트리거 (백필보다 먼저) -------------------------------------------------
-- SECURITY INVOKER: 소유자도 FORCE RLS 대상이라 DEFINER 는 의미가 없다. message INSERT 가 RLS 를
-- 통과한 같은 tx·같은 app.workspace_id 라서 channel_seq UPDATE 도 같은 정책으로 통과한다
-- (011 push_candidate_enqueue_trg 와 같은 구조). BYPASSRLS 역할 경로도 그대로 돈다.
CREATE FUNCTION channel_seq_track_last_readable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.type NOT IN ('tool_call', 'tool_result', 'system')
     AND (NEW.props->>'kind') IS DISTINCT FROM 'work_session' THEN
    UPDATE channel_seq
       SET last_readable_seq = GREATEST(last_readable_seq, NEW.seq)
     WHERE channel_id = NEW.channel_id
       AND workspace_id = NEW.workspace_id;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION channel_seq_track_last_readable() IS
  'ADR-0177 D9 (#4227): AFTER INSERT ON message — raises channel_seq.last_readable_seq for a readable message. SECURITY INVOKER; IS DISTINCT FROM (not <>) so a message without props.kind counts.';

CREATE TRIGGER message_last_readable_seq_trg
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION channel_seq_track_last_readable();

-- ---- 3) 백필 (트리거 다음) ----------------------------------------------------
-- channel_seq 는 FORCE RLS 이고 마이그레이션에는 app.workspace_id 가 없다. 전 테넌트를 훑어야 하므로
-- 002/005/012/055/064/088 과 같은 자리에서 같은 줄을 건다. migration 은 정책을 우회하는 역할로
-- 돌아서 이 줄은 우회 스위치가 아니라 안전망이다. FORCE RLS 표는 DB owner 만으로는 정책을 우회하지
-- 못한다 — 우회는 슈퍼유저·BYPASSRLS 역할이 한다(002_seed.sql 「DB owner/superuser 컨텍스트」, 088
-- 「우회 권한(슈퍼유저·BYPASSRLS)」). 그런 권한이 없는 역할이면 정책에 걸려 조용히 0행이 되는 대신
-- 오류로 멈춘다(088 실측).
--
-- 아래 DO 블록의 단정은 UPDATE 가 갱신한 행 수(GET DIAGNOSTICS)를, 같은 술어를 EXISTS 모양으로 다시
-- 센 「읽을 메시지가 있는 채널 수」와 맞춘다. LATERAL 조인이 어느 채널을 빠뜨리거나(조인 키 실수)
-- UPDATE 쪽 술어만 바뀌면 어긋나서 migration 이 실패한다. 두 술어를 함께 바꾸는 실수는 이 단정이
-- 못 잡는다 — 그것은 격리 PG 시험(dm_closure_backfill_pg)이 시드에서 독립적으로 계산한 채널별 기대값으로
-- 잰다. 빈 DB(새 설치)는 0 = 0 이라 통과한다.
SET LOCAL row_security = off;

DO $$
DECLARE
  updated  bigint;
  expected bigint;
BEGIN
  UPDATE channel_seq cs
     SET last_readable_seq = GREATEST(cs.last_readable_seq, newest.seq)
    FROM (
      SELECT c.channel_id, r.seq
        FROM channel_seq c
        CROSS JOIN LATERAL (
          SELECT m.seq
            FROM message m
           WHERE m.channel_id = c.channel_id
             AND m.type NOT IN ('tool_call', 'tool_result', 'system')
             AND (m.props->>'kind') IS DISTINCT FROM 'work_session'
           ORDER BY m.seq DESC
           LIMIT 1
        ) r
    ) newest
   WHERE cs.channel_id = newest.channel_id;
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT count(*) INTO expected
    FROM channel_seq c
   WHERE EXISTS (
     SELECT 1
       FROM message m
      WHERE m.channel_id = c.channel_id
        AND m.type NOT IN ('tool_call', 'tool_result', 'system')
        AND (m.props->>'kind') IS DISTINCT FROM 'work_session'
   );

  IF updated <> expected THEN
    RAISE EXCEPTION '146 backfill: updated % channel_seq rows but % channels have a readable message', updated, expected;
  END IF;
END $$;

SET LOCAL row_security = on;

-- ---- 4) dm_closure (D6) -------------------------------------------------------
-- (member_id, channel_id) 당 한 행. closed_at_seq 는 「이 seq 까지 보고 닫았다」는 워터마크다: 서버가
-- 닫는 순간의 last_seq 가 아니라 클라이언트가 본 seq(seenSeq)에서 온다. 저장 식은 라우트가 쥔다
-- (GREATEST(기존, LEAST(seenSeq, channel_seq.last_seq))).
--
-- DM 만 받는다는 규칙(channel.kind = 'dm'·보관되지 않음·요청자가 참여자)은 라우트가 확인한다.
-- 테넌트 일치는 라우트와 DB 가 이중으로 지킨다: RLS WITH CHECK 가 workspace_id 를 현재 테넌트로 고정하고,
-- 아래 두 **복합 외래 키**가 (workspace_id, member_id)·(workspace_id, channel_id) 가 같은 워크스페이스의
-- 행을 가리키는지 DB 가 확인한다(member_workspace_id_uniq 003, channel_workspace_id_uniq 027 이 이미 있는
-- 유일 인덱스를 쓰므로 새 인덱스도 핵심 표 변경도 없다). 그래서 다른 워크스페이스의 멤버·채널을 이 표에
-- 끼워 넣는 쓰기는 라우트가 틀려도 외래 키 위반으로 거절된다(독립 검토 r1 Low). 084 는 이 방어를 두지
-- 않았다.
CREATE TABLE dm_closure (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL,
  channel_id    uuid NOT NULL,
  closed_at_seq bigint NOT NULL,
  closed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, channel_id),
  CONSTRAINT dm_closure_member_workspace_fk
    FOREIGN KEY (workspace_id, member_id) REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT dm_closure_channel_workspace_fk
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channel (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT dm_closure_closed_at_seq_nonneg_ck CHECK (closed_at_seq >= 0)
);

-- 채널·워크스페이스 삭제의 캐스케이드가 이 표를 훑지 않게 한다(PK 는 member_id 가 앞이라 channel_id 로는
-- 쓸 수 없다). 표는 작지만 채널 삭제마다 순차 스캔이 한 번 도는 것은 값싸게 피할 수 있다.
CREATE INDEX dm_closure_channel_idx ON dm_closure (channel_id);

COMMENT ON TABLE dm_closure IS
  'ADR-0177 D6 (#4227): member-owned "I closed this DM" fact. One row per (member, channel). No outbox fan-out (D10): other devices converge on the next read-state projection.';
COMMENT ON COLUMN dm_closure.member_id IS
  'Owning human member. RLS only separates workspaces — every read and write carries member_id = requester as a query predicate (084: member boundary by the route, tenant boundary by the policy).';
COMMENT ON COLUMN dm_closure.closed_at_seq IS
  'Watermark: the client closed the DM having seen up to this seq (D7). Stored as GREATEST(existing, LEAST(seenSeq, channel_seq.last_seq)) so it never moves back and never passes the channel head.';
COMMENT ON COLUMN dm_closure.closed_at IS
  'When closed_at_seq last moved forward.';

ALTER TABLE dm_closure ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_closure FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON dm_closure
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- 141 과 같은 방어: 런타임 역할이 이미 있으면(운영·격리 DB) 새 표 권한을 명시한다. 없으면(역할 이전의
-- 새 DB) bootstrap_*.sql 의 ALL TABLES 부여가 뒤따른다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE dm_closure TO momo_app;
  END IF;
END $$;
