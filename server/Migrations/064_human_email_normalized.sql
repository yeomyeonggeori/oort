-- =============================================================================
-- 064_human_email_normalized.sql — 이슈 #1234 (PR #1231 적립분)
--
-- 로그인 이메일 대소문자 비대칭을 닫는 두 조각 중 **DB 쪽**. 나머지 한 조각은
-- `verify_password_login` 의 조회 정규화(momo-messaging/src/identity.rs)이고,
-- 둘은 한 몸이다 — 이 파일 없이 조회만 정규화하면 손으로 넣은 대문자 행이
-- 영영 로그인 불가가 되고, 조회 정규화 없이 이 파일만 있으면 아무것도 안 고쳐진다.
--
-- ## 실측이 설계를 정했다 (2026-08-10, pgvector/pg18 실 DB)
--
-- 쓰기 경로는 전수 조사 결과 **전부** lower(btrim()) 로 정규화하고 있었다:
--   create_workspace.sql:37 · bootstrap_owner_if_absent.sql:32 · set_initial_owner.sql:19
--   momo-settings::normalized_join_email(join.rs:112, trim+lowercase)
--   workspace.rs:180 은 기존 행 복사(원본의 정규화를 승계)
--   002_seed.sql 은 리터럴 'demo@momo.local'
--   은퇴 중인 Swift JoinRoutes.normalizedEmail(:724) 도 동일 — 이력상으로도 일관.
--
-- 그런데 그 일관성은 **코드 규율일 뿐 DB 불변식이 아니었다.** human 에 걸린
-- 제약은 UNIQUE (workspace_id, email) 하나뿐이고 그것은 대소문자를 구별한다.
-- 실측으로 확인한 것(EXPLAIN/INSERT 로 직접 재현):
--
--   ① 같은 워크스페이스에 'Twin@Example.com' 과 'twin@example.com' 이
--      **동시에 들어간다** — human_email_uniq 가 막지 않는다.
--   ② 그래서 "양쪽 lower()" 식 조회(lower(h.email) = lower($2))는 그 두 행을
--      **둘 다** 매칭한다(count=2). 조회에 ORDER BY 가 없으므로 어느 계정으로
--      로그인되는지는 계획에 달렸다 — 요청한 A 대신 B 로 조용히 들어가는,
--      이 레포가 resolve_login_workspace 주석에서 이미 이름 붙여 거부한 그 실패.
--   ③ 입력쪽만 정규화(h.email = lower(btrim($2)))하면 상수 폴딩되어
--      human_email_uniq 에 Index Cond 로 붙는다(rows=2). 열쪽을 감싸면
--      Filter 로 떨어져 인덱스 전체를 훑는다(rows=490). 정확성과 성능이 같은 답.
--
-- 결론: 조회는 **입력쪽만** 정규화한다. 그 선택은 "저장된 행은 이미 정규형"을
-- 전제하므로, 그 전제를 규율이 아니라 **제약으로** 만드는 것이 이 파일이다.
--
-- ## 왜 자동 교정이 안전한가 (그리고 어디서 멈추는가)
--
-- 'Foo@x.com' → 'foo@x.com' 재작성은 그 사람의 로그인을 깨지 않는다: 조회도
-- 같이 정규화되므로 예전 철자를 그대로 타이핑해도 매칭되고, password_hash 는
-- 건드리지 않는다. 오히려 늘 의도했을 'foo@x.com' 로도 들어올 수 있게 된다.
--
-- 멈추는 지점은 **충돌**이다. 정규화하면 한 워크스페이스에서 겹치는 두 행은
-- 서로 다른 비밀번호를 가진 서로 다른 계정이고, 하나를 고르는 것은 조용한
-- 데이터 손실이다. 그래서 051 이 세운 집안 방식 그대로 — 위반자를 이름으로
-- 부르고 제약 추가를 거부한다(fail-closed). 운영자가 판단해야 하는 일이다.
-- =============================================================================

-- human 은 RLS FORCE(schema_v0.sql:389-393). 이 파일은 전 테넌트를 훑어야
-- 하므로 002/005/012 와 같은 자리에서 같은 우회를 쓴다. --single-transaction
-- 이므로 SET LOCAL 은 이 파일 끝에서 자동으로 풀린다.
SET LOCAL row_security = off;

DO $$
DECLARE
  v_collisions text;
  v_repaired   integer;
BEGIN
  -- ---- 1) 충돌 먼저. 고칠 수 없는 것을 고친 척하지 않는다 -------------------
  SELECT string_agg(
           'workspace ' || workspace_id::text || ' / ' || normalized || ' (' || row_count || '행)',
           ', ' ORDER BY workspace_id, normalized
         )
    INTO v_collisions
    FROM (
      SELECT workspace_id,
             lower(btrim(email)) AS normalized,
             count(*)            AS row_count
        FROM human
       GROUP BY workspace_id, lower(btrim(email))
      HAVING count(*) > 1
    ) duplicates;

  IF v_collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot normalise human.email; these addresses collide once case is folded: %. '
      'They are distinct accounts with distinct passwords — pick which one keeps the '
      'address (or change one), then re-run the migration. Issue #1234.',
      v_collisions;
  END IF;

  -- ---- 2) 무손실 교정 -------------------------------------------------------
  UPDATE human
     SET email = lower(btrim(email))
   WHERE email <> lower(btrim(email));

  GET DIAGNOSTICS v_repaired = ROW_COUNT;
  IF v_repaired > 0 THEN
    -- 주소는 찍지 않는다(로그는 감사보다 넓게 읽힌다). 건수만.
    RAISE NOTICE 'MOMO_EMAIL_NORMALISE=repaired % human row(s) to lower(btrim(email))', v_repaired;
  ELSE
    RAISE NOTICE 'MOMO_EMAIL_NORMALISE=clean every human.email was already normalised';
  END IF;
END $$;

-- ---- 3) 규율을 제약으로 승격 ------------------------------------------------
-- 026 의 workspace_ban_email_norm_ck 와 같은 형태다(같은 정규형, 같은 이유).
-- ADD CONSTRAINT 에는 IF NOT EXISTS 가 없으므로 pg_constraint 로 감싼다 —
-- schema_migrations 가 재실행을 막지만, 이 레포의 마이그레이션은 그것과
-- 무관하게 재실행 안전한 것이 관례다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'human'::regclass
       AND conname  = 'human_email_normalized_ck'
  ) THEN
    ALTER TABLE human
      ADD CONSTRAINT human_email_normalized_ck
      CHECK (email = lower(btrim(email)));
  END IF;
END $$;

COMMENT ON CONSTRAINT human_email_normalized_ck ON human IS
  '#1234: 저장 이메일은 항상 lower(btrim()) 정규형. verify_password_login 이 입력쪽만 '
  '정규화해 human_email_uniq 인덱스를 쓸 수 있는 근거이며, 대소문자만 다른 쌍둥이 계정이 '
  '생겨 로그인이 어느 계정으로 붙을지 모호해지는 것을 막는다.';
