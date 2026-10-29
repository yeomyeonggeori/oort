-- =============================================================================
-- 152_dev_token.sql — #4660 / ADR-0216 D2·D3·D4·D7·D8 (사람 개발자 토큰)
--
-- 무엇
--   사람 멤버가 자기 이름으로 만드는 「개발자 토큰」을 새 자격 종류로 둔다. 새 표를 만들지 않고 기존
--   `token` 표에 `kind = 'dev'` 행으로 둔다(ADR-0216 「기각한 대안」: 별도 표는 RLS·멤버 전체 폐기·#3109
--   잠금 순서를 처음부터 다시 맞춰야 한다). 형태는 셋이다.
--     card     설정 카드에서 만든 토큰 하나. `session_id` 없음.
--     access   로그인 세션(`oort login`)의 짧은 쪽. 계보(`session_id`)를 refresh 와 공유한다.
--     refresh  로그인 세션의 갱신 쪽. 회전마다 새 쌍이 같은 계보를 물려받는다.
--   봉투(`momo_dev_v1.…`·`momo_devr_v1.…`) 전체의 SHA-256 만 `token_hash` 에 저장한다(원문 저장 없음).
--
-- `ALTER TYPE … ADD VALUE` 와 같은 트랜잭션 (중요)
--   마이그레이션은 `psql --single-transaction` 이라 이 파일 전체가 한 트랜잭션이다. 같은 트랜잭션에서
--   새 enum 값 `'dev'` 를 리터럴로 쓰면 「unsafe use of new value」로 실패한다. 그래서 이 파일의 모든
--   CHECK·트리거는 `kind::text` 로 비교하고, 새 값 리터럴을 쓰는 인덱스는 만들지 않는다(`::text` 캐스트는
--   인덱스 술어에 쓸 수 없다 — 아래 부분 인덱스는 `dev_form` 으로 거른다). 런타임 SQL(momo-auth
--   `dev_token.rs`)은 커밋 뒤에 돌므로 `kind = 'dev'` 를 그대로 쓴다.
--
-- 90일 상한은 「일」이 아니라 「시간」으로 잰다
--   `timestamptz + interval '90 days'` 는 세션 TimeZone 의 달력으로 더해서, 서머타임 경계를 지나면
--   절대 시간이 ±1시간 달라진다. CHECK 는 행을 UPDATE(폐기·마지막 사용) 할 때마다 다시 평가되므로,
--   UTC 세션에서 만든 90일짜리 행이 다른 TimeZone 세션의 폐기에서 CHECK 위반으로 막힐 수 있다.
--   그래서 상한은 `interval '2160 hours'`(= 90 × 24시간, 시간대와 무관)이고, 발급 SQL 도 초 단위로 더한다.
--
-- 두 겹의 「사람 멤버만」(ADR-0216 D2, R21 d)
--   1차는 발급 함수(`issue_dev_*_in_tx`)가 `member.kind = 'human'` 을 요구하는 것이고, 2차가 아래 BEFORE
--   트리거다(직접 INSERT 방어). 두 겹을 따로 시험한다.
--
-- message.sent_via (ADR-0216 D8)
--   개발자 토큰으로 보낸 메시지의 「명령줄에서」 표식. 값은 서버가 인증된 자격의 종류에서만 쓰고, 지금은
--   `'dev'` 하나뿐이다. nullable 열 하나와 CHECK 하나 — 기존 행은 모두 NULL 이다. message 의 AFTER INSERT
--   트리거들(011·033·079·126·146)은 열 목록을 고정하거나 행 전체를 직렬화하지 않아(확인함) 영향이 없다.
--
-- 새 표·새 정책·새 권한 없음. 런타임 역할은 표 단위 권한(bootstrap_roles.sql 의 ALL TABLES)이라 새 열에도
-- 그대로 닿는다. schema_v0.sql 무접촉.
-- 운영 메모(락): `ALTER TABLE token`·`ALTER TABLE message` 는 ACCESS EXCLUSIVE 를 커밋까지 잡는다. 열 추가는
-- 메타데이터만 바꾸지만 CHECK 추가는 기존 행을 한 번 훑는다(message 가 큰 DB 는 점검 창에서 적용).
-- =============================================================================

-- ---- 1) token_kind -----------------------------------------------------------
ALTER TYPE token_kind ADD VALUE IF NOT EXISTS 'dev';

-- ---- 2) token: dev 전용 열 ----------------------------------------------------
ALTER TABLE token
  ADD COLUMN dev_form text,
  ADD COLUMN dev_tool text,
  ADD COLUMN dev_channel_ids uuid[],
  ADD COLUMN dev_client text,
  ADD COLUMN dev_device_name text,
  ADD COLUMN dev_lineage_expires_at timestamptz;

COMMENT ON COLUMN token.dev_form IS
  'ADR-0216 D2: card | access | refresh. NOT NULL exactly when kind = dev. Authentication filters on it (door = card/access, rotation = refresh) in addition to the hash.';
COMMENT ON COLUMN token.dev_tool IS
  'ADR-0216 D6: claude_code | codex | cli | other — chosen by the person who made it, never a verified fact.';
COMMENT ON COLUMN token.dev_channel_ids IS
  'ADR-0216 D4: optional channel restriction (1-50 ids). NULL = no restriction. Re-intersected with current membership on every request; never trusted alone.';
COMMENT ON COLUMN token.dev_client IS
  'ADR-0216 D6: the client of a login-session lineage (access/refresh). NULL for a card.';
COMMENT ON COLUMN token.dev_device_name IS
  'ADR-0216 D6: device name chosen by the connecting side (<= 80 chars, no control characters).';
COMMENT ON COLUMN token.dev_lineage_expires_at IS
  'ADR-0216 D2: absolute end of a login-session lineage (approval + 90 days). Rotation never mints past it.';

-- ---- 3) token: CHECK — 술어마다 따로 둔다(하나씩 깨서 시험할 수 있게) ---------------

-- 형태는 dev 행에만, dev 행에는 반드시.
ALTER TABLE token
  ADD CONSTRAINT token_dev_form_ck
    CHECK ((kind::text = 'dev') = (dev_form IS NOT NULL));
ALTER TABLE token
  ADD CONSTRAINT token_dev_form_values_ck
    CHECK (dev_form IS NULL OR dev_form IN ('card', 'access', 'refresh'));

-- 비dev 행에는 dev_* 값이 없다.
ALTER TABLE token
  ADD CONSTRAINT token_dev_columns_ck
    CHECK (
      kind::text = 'dev'
      OR (dev_tool IS NULL
          AND dev_channel_ids IS NULL
          AND dev_client IS NULL
          AND dev_device_name IS NULL
          AND dev_lineage_expires_at IS NULL)
    );

-- dev 행의 도구는 네 값 중 하나(만든 사람이 고른 값).
ALTER TABLE token
  ADD CONSTRAINT token_dev_tool_ck
    CHECK (
      kind::text <> 'dev'
      OR (dev_tool IS NOT NULL AND dev_tool IN ('claude_code', 'codex', 'cli', 'other'))
    );

-- R5(a): dev 행은 반드시 만료가 있고, 만든 때부터 90일(2160시간)을 넘지 않는다.
ALTER TABLE token
  ADD CONSTRAINT token_dev_lifetime_ck
    CHECK (
      kind::text <> 'dev'
      OR (expires_at IS NOT NULL AND expires_at <= created_at + interval '2160 hours')
    );

-- R4: dev 행의 범위는 dev: 어휘 안이고 dev:identity 를 늘 가진다. dev:search 는 이름만 예약이라 없다.
ALTER TABLE token
  ADD CONSTRAINT token_dev_scopes_ck
    CHECK (
      kind::text <> 'dev'
      OR (scopes <@ ARRAY['dev:identity', 'dev:channels:read', 'dev:messages:read',
                          'dev:messages:write', 'dev:inbox:read']::text[]
          AND 'dev:identity' = ANY(scopes))
    );

-- R4: 비dev 행에는 dev: 로 시작하는 범위가 없다(CHECK 에는 서브쿼리를 못 쓰므로 한 줄씩 이어 본다).
ALTER TABLE token
  ADD CONSTRAINT token_non_dev_scopes_ck
    CHECK (kind::text = 'dev' OR array_to_string(scopes, E'\n') !~ '(^|\n)dev:');

-- 개발자 토큰은 이름 붙은 자기 위임이다(D1): 다른 사람을 대신하지 않는다.
ALTER TABLE token
  ADD CONSTRAINT token_dev_self_ck
    CHECK (kind::text <> 'dev' OR subject_member_id IS NULL);

-- 채널 제한은 없거나(NULL) 1~50개, 빈 원소 없음.
ALTER TABLE token
  ADD CONSTRAINT token_dev_channel_ids_ck
    CHECK (
      dev_channel_ids IS NULL
      OR (cardinality(dev_channel_ids) BETWEEN 1 AND 50
          AND array_position(dev_channel_ids, NULL) IS NULL)
    );

-- 이름(label)은 dev 행에서 1~80자, 제어 문자 불가.
ALTER TABLE token
  ADD CONSTRAINT token_dev_label_ck
    CHECK (
      kind::text <> 'dev'
      OR (label IS NOT NULL
          AND char_length(label) BETWEEN 1 AND 80
          AND label !~ '[[:cntrl:]]')
    );

ALTER TABLE token
  ADD CONSTRAINT token_dev_device_name_ck
    CHECK (
      dev_device_name IS NULL
      OR (char_length(dev_device_name) BETWEEN 1 AND 80
          AND dev_device_name !~ '[[:cntrl:]]')
    );

ALTER TABLE token
  ADD CONSTRAINT token_dev_client_ck
    CHECK (
      dev_client IS NULL
      OR (char_length(dev_client) BETWEEN 1 AND 200
          AND dev_client !~ '[[:cntrl:]]')
    );

-- 카드는 계보가 없다.
ALTER TABLE token
  ADD CONSTRAINT token_dev_card_shape_ck
    CHECK (
      dev_form IS DISTINCT FROM 'card'
      OR (session_id IS NULL AND dev_client IS NULL AND dev_lineage_expires_at IS NULL)
    );

-- 로그인 세션의 두 반쪽은 계보·클라이언트·절대 상한을 가진다.
ALTER TABLE token
  ADD CONSTRAINT token_dev_lineage_shape_ck
    CHECK (
      dev_form IS NULL
      OR dev_form = 'card'
      OR (session_id IS NOT NULL
          AND dev_client IS NOT NULL
          AND dev_lineage_expires_at IS NOT NULL)
    );

-- R5(c): 어느 반쪽도 계보 상한을 넘지 않고, 계보 상한 자체도 승인(=계보 첫 행) +90일을 넘지 않는다.
-- 회전으로 생긴 행은 상한을 부모에서 그대로 받고 created_at 이 더 늦으므로 두 번째 줄을 늘 지킨다.
ALTER TABLE token
  ADD CONSTRAINT token_dev_lineage_cap_ck
    CHECK (
      dev_form IS NULL
      OR dev_form = 'card'
      OR (expires_at <= dev_lineage_expires_at
          AND dev_lineage_expires_at <= created_at + interval '2160 hours')
    );

-- ---- 4) 사람 멤버만 — 2차 방벽(트리거) ----------------------------------------
-- 두 열이 두 표에 있어 CHECK 로는 못 쓴다(074 token_hosted_class_matches_auth_mode 와 같은 이유).
-- SECURITY INVOKER: INSERT 가 RLS 를 통과한 같은 tx·같은 app.workspace_id 에서 member 를 읽는다. 행이 안
-- 보이면(다른 워크스페이스·없는 멤버) kind 가 NULL 이라 거절한다(fail-closed).
CREATE FUNCTION token_dev_actor_is_human()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE actor_kind text;
BEGIN
  IF NEW.kind::text <> 'dev' THEN
    RETURN NEW;
  END IF;
  SELECT m.kind::text INTO actor_kind
    FROM public.member m
   WHERE m.workspace_id = NEW.workspace_id
     AND m.id = NEW.actor_member_id;
  IF actor_kind IS DISTINCT FROM 'human' THEN
    RAISE EXCEPTION 'dev token actor must be a human member of the same workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER token_dev_actor_human_guard
BEFORE INSERT OR UPDATE OF kind, actor_member_id, workspace_id ON token
FOR EACH ROW EXECUTE FUNCTION token_dev_actor_is_human();

COMMENT ON FUNCTION token_dev_actor_is_human() IS
  'ADR-0216 D2 / R21(d) second layer: a kind = dev token row must belong to a human member of its own workspace. The issuance functions check first; this refuses a direct INSERT.';

-- ---- 5) 인덱스 — 새 enum 리터럴 없이 dev_form 으로 거른다 -----------------------
-- 회전은 계보의 살아 있는 쌍을 먼저 폐기하고 새 쌍을 넣는다. 계보당 살아 있는 refresh·access 가 하나씩이라는
-- 것을 DB 가 막아서, 회전이 「더하기」가 되지 못하게 한다(074 token_one_live_hosted_oauth_refresh 와 같은 결).
CREATE UNIQUE INDEX token_dev_one_live_refresh_per_lineage
  ON token (workspace_id, session_id)
  WHERE dev_form = 'refresh' AND revoked_at IS NULL;
CREATE UNIQUE INDEX token_dev_one_live_access_per_lineage
  ON token (workspace_id, session_id)
  WHERE dev_form = 'access' AND revoked_at IS NULL;

-- 멤버별 개수 상한·목록(본인·워크스페이스 전체)의 길.
CREATE INDEX token_dev_live_member_idx
  ON token (workspace_id, actor_member_id)
  WHERE dev_form IS NOT NULL AND revoked_at IS NULL;

-- ---- 6) message.sent_via -------------------------------------------------------
ALTER TABLE message
  ADD COLUMN sent_via text;
ALTER TABLE message
  ADD CONSTRAINT message_sent_via_ck CHECK (sent_via IS NULL OR sent_via = 'dev');

COMMENT ON COLUMN message.sent_via IS
  'ADR-0216 D8: dev = sent with a developer token (shown as 「명령줄에서」). Derived by the server from the authenticated credential kind only, never from the request; an author edit keeps it.';
