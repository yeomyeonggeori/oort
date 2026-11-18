-- =============================================================================
-- 186_channel_default_fill_safety_net.sql — #5909 (ADR-0224 D6·D10, 184 의 안전망)
--
-- 184 의 기본 채널 채우기를 한 번 더 돌리되, 어떤 방식으로 적용해도 조용히 0행이 되지 않게 한다.
--
-- 왜
--   184 는 「SET LOCAL row_security = off」 한 줄을 안전망으로 믿었다. 그 줄은 한 트랜잭션 안에서만 선다:
--   저장소의 두 러너(momo-db 의 migrate.rs · scripts/migrate.sh)는 파일마다 --single-transaction 이라 괜찮지만,
--   손으로 `psql -f` 를 트랜잭션 없이 돌리면 그 줄은 경고만 남기고 아무 일도 하지 않는다. 그때 행 보안을
--   우회하지 못하는 역할(NOBYPASSRLS 인 표 소유자)로 돌리면 FORCE RLS 가 채널을 한 줄도 보여 주지 않아서,
--   단정의 두 숫자(기대 · 갱신)가 같은 눈으로 센 값이라 0 = 0 으로 지나가고, 열만 생긴 채 기본 채널이 없는
--   워크스페이스가 남는다. 뒤 칸(마지막 기본 채널 409, 환영 글)은 「워크스페이스마다 기본 채널이 있다」를
--   전제로 삼으므로 조용한 0 은 값이 비싸다.
--
-- 무엇
--   「보관 안 된 공개 채널이 있는데 기본 채널이 하나도 없는 워크스페이스」를 184 와 같은 차례로 다시 채운다
--   (보관 안 된 공개 `general` 가운데 가장 오래된 것, 없으면 가장 오래된 공개 채널; 고른 행의 browse_listed 도 켠다).
--
-- 어떻게(트랜잭션 방식과 상관없이 서도록)
--   - 우회 스위치를 DO 블록 안에서 set_config(.., is_local => true) 로 건다. 블록 하나가 한 트랜잭션이라
--     러너(--single-transaction)와 자동 커밋(`psql -f`) 모두에서 같은 모양으로 선다.
--   - 행 보안을 우회하지 못하는 역할이면 첫 SELECT 에서 「query would be affected by row-level security
--     policy」 로 크게 멈춘다(조용히 0 이 되는 길이 없다). superuser · BYPASSRLS 역할은 그대로 통과한다.
--   - 184 와 같은 행 수 단정을 그대로 둔다(갱신한 행 수 = 「기본 채널 없고 살아 있는 공개 채널이 있는 워크스페이스
--     수」. 고르는 식이 한 워크스페이스에서 둘을 고르거나 빠뜨리면 전체가 되돌아간다).
--   - 끝에서 스위치를 원래 값으로 돌려 놓는다(같은 트랜잭션에 이어지는 문장에 우회가 새지 않게).
--
-- 다시 돌려도 안전하다(멱등): 기본 채널이 아직 하나도 없는 워크스페이스만 건드린다. 184 가 이미 다 채웠으면
-- 0 = 0 으로 아무것도 안 바꾼다. 관리자가 뒤에 고른 기본 채널·둘러보기 표시는 되돌리지 않는다.
--
-- 되돌리는 길: DDL 이 없다. 184 의 열·CHECK 는 그대로 두고, 이 파일이 채운 행만 되돌리려면 그 채널의
-- is_default · browse_listed 를 false 로 UPDATE 하면 된다(권장하지 않는다 — 가입이 가장 오래된 공개 채널로
-- 물러서는 길은 어차피 남는다).
--
-- 새 표가 아니라 새 RLS 정책 대상이 없다. schema_v0.sql 은 불변 — 이 파일은 데이터만 만진다.
-- =============================================================================

DO $$
DECLARE
  prior     text := current_setting('row_security');
  expected  bigint;
  updated   bigint;
BEGIN
  -- 우회 스위치: 이 블록(= 한 트랜잭션) 안에서만. 우회 권한이 없는 역할은 아래 첫 SELECT 에서 멈춘다.
  PERFORM set_config('row_security', 'off', true);

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
    RAISE EXCEPTION '186 default-channel fill: updated % channel rows but % workspaces have a live public channel and no default channel', updated, expected;
  END IF;


  PERFORM set_config('row_security', prior, true);
END $$;
