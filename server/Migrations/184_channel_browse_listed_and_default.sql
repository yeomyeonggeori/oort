-- =============================================================================
-- 184_channel_browse_listed_and_default.sql — #5837 (ADR-0224 D2·D6·D10, 2026-11-14 저녁 증보)
--
-- channel 에 표시 열 둘을 더하고, 이미 있는 워크스페이스의 기본 채널을 채운다.
--
--   1) channel.browse_listed   「둘러보기에 보이기」. 정식 멤버가 찾아보고 스스로 들어오는 문(D2).
--   2) channel.is_default      「기본 채널」. 새로 합류하는 사람이 자동으로 들어가는 곳(D6·D7).
--   3) CHECK 둘                켜진 채널은 공개 채널이다 · 기본 채널은 공개 채널이다.
--   4) 채우기                  워크스페이스마다 기본 채널 하나를 고르고, 그 행의 browse_listed 도 켠다.
--
-- 두 표시는 따로다(D6). 기본 채널이라도 browse_listed 가 꺼져 있으면 둘러보기에 안 나오고, 둘러보기에
-- 보이는 채널이라도 is_default 가 꺼져 있으면 새로 온 사람이 자동으로 들어가지 않는다.
--
-- 이미 있는 공개 채널은 열을 더할 때 꺼짐이다(DEFAULT false). 예외는 4) 가 기본 채널로 고른 행 하나뿐이고,
-- 그 행은 둘러보기에 켜진 채 시작한다(2026-11-14 저녁 owner 결정, D2·D10). 멤버십은 아무도 넣지도 빼지도
-- 않는다(D10).
--
-- CHECK 는 「공개」만 말한다. 보관 여부는 CHECK 에 넣지 않았다: ADR 이 보관된 채널에 대해 정한 것은
-- 「둘러보기·참여·자동 참여에서 빠진다」(D3·D4·D7, 쿼리 술어)와 「채널 보관이 들어오면 기본 채널은
-- 보관할 수 없다」(D6, 그 기능의 몫)뿐이라, 표 제약으로는 가장 좁은 주장만 둔다. 보관된 채널의 표시는
-- 읽는 쪽 술어(archived_at IS NULL)가 무시한다.
--
-- 새 표가 아니라 새 RLS 정책 대상이 없다(channel 은 이미 ENABLE + FORCE, ws_isolation).
-- 인덱스를 더하지 않는다: 두 표시를 읽는 문장은 모두 workspace_id 로 한 워크스페이스를 먼저 좁히고
-- (channel_name_uniq · channel_workspace_id_uniq), 한 워크스페이스의 채널 수는 작다. 실행 계획은 PR 본문.
-- schema_v0.sql 은 불변 — 이 파일이 유일한 DDL.
--
-- 다시 돌려도 안전하다(멱등): 열·제약은 있으면 건너뛰고, 채우기는 기본 채널이 아직 하나도 없는
-- 워크스페이스만 건드린다(관리자가 나중에 고른 기본 채널·둘러보기 표시를 되돌리지 않는다).
-- =============================================================================

-- ---- 1) 2) 열 ------------------------------------------------------------------
-- 상수 DEFAULT 라 표를 다시 쓰지 않는다(메타데이터만 바뀐다).
ALTER TABLE channel ADD COLUMN IF NOT EXISTS browse_listed boolean NOT NULL DEFAULT false;
ALTER TABLE channel ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN channel.browse_listed IS
  'ADR-0224 D2 (#5837): listed in channel browse — full members may find and self-join it. Public channels only (channel_browse_listed_public_ck). Existing public channels start off except the default channel 184 picked; new public channels are created on. Independent of is_default.';
COMMENT ON COLUMN channel.is_default IS
  'ADR-0224 D6 (#5837): a person joining the workspace by invite is put into every live default channel (D7). Public channels only (channel_is_default_public_ck). Independent of browse_listed.';

-- ---- 3) CHECK 둘 -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'channel'::regclass AND conname = 'channel_browse_listed_public_ck'
  ) THEN
    ALTER TABLE channel
      ADD CONSTRAINT channel_browse_listed_public_ck CHECK (NOT browse_listed OR kind = 'public');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'channel'::regclass AND conname = 'channel_is_default_public_ck'
  ) THEN
    ALTER TABLE channel
      ADD CONSTRAINT channel_is_default_public_ck CHECK (NOT is_default OR kind = 'public');
  END IF;
END $$;

-- ---- 4) 기본 채널 채우기 (D6) ---------------------------------------------------------
-- 워크스페이스마다 하나: 보관 안 된 공개 `general` 가운데 가장 오래된 것, 없으면 보관 안 된 공개 채널
-- 가운데 가장 오래된 것. 고른 행은 browse_listed 도 켠다(D2·D10 저녁 증보). 공개 채널이 하나도 없는
-- 워크스페이스는 기본 채널 0 이다. 보관된 채널은 고르지 않는다 — 가입이 보관된 채널을 건너뛰므로(D7)
-- 보관된 기본 채널은 아무도 넣지 못한다.
--
-- channel 은 FORCE RLS 이고 migration 에는 app.workspace_id 가 없다. 전 테넌트를 훑어야 하므로 146 과
-- 같은 자리에서 같은 줄을 건다. migration 은 정책을 우회하는 역할로 돌아서 이 줄은 우회 스위치가 아니라
-- 안전망이다. 그런 권한이 없는 역할이면 정책에 걸려 조용히 0행이 되는 대신 아래 단정이 멈춘다.
--
-- 단정은 UPDATE 가 갱신한 행 수(GET DIAGNOSTICS)를, 고르는 식과 따로 센 「기본 채널이 아직 없고 보관 안 된
-- 공개 채널이 있는 워크스페이스 수」와 맞춘다. 고르는 쪽이 한 워크스페이스에서 둘을 고르거나 빠뜨리면
-- 어긋나서 migration 전체가 되돌아간다. 빈 DB(새 설치)는 0 = 0 이라 통과한다.
SET LOCAL row_security = off;

DO $$
DECLARE
  updated  bigint;
  expected bigint;
BEGIN
  SELECT count(DISTINCT live.workspace_id) INTO expected
    FROM channel live
   WHERE live.kind = 'public'
     AND live.archived_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM channel already
        WHERE already.workspace_id = live.workspace_id
          AND already.is_default
     );

  UPDATE channel c
     SET is_default = true,
         browse_listed = true
    FROM (
      SELECT DISTINCT ON (candidate.workspace_id) candidate.id
        FROM channel candidate
       WHERE candidate.kind = 'public'
         AND candidate.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM channel already
            WHERE already.workspace_id = candidate.workspace_id
              AND already.is_default
         )
       ORDER BY candidate.workspace_id,
                (lower(candidate.name) = 'general') DESC,
                candidate.created_at ASC,
                candidate.id ASC
    ) pick
   WHERE c.id = pick.id;
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated <> expected THEN
    RAISE EXCEPTION '184 default-channel fill: updated % channel rows but % workspaces have a live public channel and no default channel', updated, expected;
  END IF;
END $$;

SET LOCAL row_security = on;
