-- =============================================================================
-- 065_human_email_case_insensitive_uniq.sql — 이슈 #1252 (PR #1251 적립분)
--
-- 064 는 `human_email_normalized_ck` 로 "저장 이메일은 lower(btrim()) 정규형"을
-- 강제했다. 그 CHECK 이 있는 한 케이스 쌍둥이(`Twin@x.com` + `twin@x.com`)는
-- 못 들어온다 — 앞의 철자가 애초에 저장 불가라서. **막히는 이유가 유일성 제약이
-- 아니라 정규화 제약이라는 뜻이다.**
--
-- human 의 유일성은 여전히 `UNIQUE (workspace_id, email)`, 즉 **대소문자를
-- 구별하는** 제약이다. 문장만 읽으면 이 테이블은 케이스 쌍둥이를 허용한다고
-- 말하고 있고, 그것이 실제로 허용되지 않는 것은 옆에 있는 다른 제약 덕이다.
-- 064 가 여러 이유로 언젠가 완화되면 유일성도 함께 조용히 완화된다 — 아무도
-- 유일성을 건드리지 않았는데.
--
-- 그래서 이 파일은 유일성을 **자기 문장으로** 말하게 만든다:
--   UNIQUE (workspace_id, lower(btrim(email)))
-- 이 표현이 서면 064 의 CHECK 은 유일성의 전제가 아니라 (조회가 입력쪽만
-- 정규화해도 되는) 성능/일관성 근거로 역할이 좁아진다. 둘 다 남지만, 각자가
-- 자기 것만 지탱한다.
--
-- ## 왜 lower(email) 이 아니라 lower(btrim(email)) 인가
--
-- 이슈 본문은 "lower(email) 함수 인덱스"라고 적었다. 그런데 이 레포에는 정규형이
-- 딱 하나 있다 — `lower(btrim(...))` (026 workspace_ban_email_norm_ck ·
-- 064 human_email_normalized_ck · create_workspace.sql · bootstrap_owner_if_absent.sql
-- · set_initial_owner.sql · #1247/#1251 의 조회 5곳). 여기서만 btrim 을 빼면
-- 한 스키마 안에 "정규형"이 두 뜻이 되고, 그 갈라짐이 #1248 이 없애려던 바로 그
-- 표류다. 이슈가 요구한 것은 *모양*(함수 인덱스)이지 특정 함수 조합이 아니므로
-- 강한 쪽, 그리고 나머지 전부와 같은 쪽을 쓴다.
--
-- ## 조회 계획은 바뀌면 안 된다 (실측)
--
-- #1247 이 측정한 대로 조회 5곳은 전부 **파라미터쪽**을 접는다
-- (`WHERE h.email = lower(btrim($2))`). 그 형태는 상수 폴딩되어 (workspace_id,
-- email) b-tree 를 Index Cond 로 쓴다. 함수 인덱스는 그 술어에 쓰이지 **않는다**
-- — 플래너는 CHECK 에서 email = lower(btrim(email)) 를 추론하지 못한다.
--
-- 그래서 UNIQUE 를 걷어내면서 같은 열쌍의 **비유일** b-tree 를 남긴다. 501행
-- (pgvector/pg18, ANALYZE 후) 실측:
--
--   065 이전            Index Scan using human_email_uniq   Index Cond (workspace_id, email)
--   065, 대체 인덱스 없음  Seq Scan on human                  Filter                     ← 회귀
--   065, human_email_idx  Index Scan using human_email_idx    Index Cond (workspace_id, email)
--
-- 즉 인덱스 두 개는 중복이 아니라 역할 분담이다: 하나는 유일성을 말하고, 다른
-- 하나는 조회를 태운다.
-- =============================================================================

-- human 은 RLS FORCE(schema_v0.sql:389-393). 아래 충돌 스캔은 전 테넌트를
-- 훑어야 하므로 002/005/012/064 와 같은 자리에서 같은 우회를 쓴다.
-- --single-transaction 이므로 SET LOCAL 은 이 파일 끝에서 자동으로 풀린다.
SET LOCAL row_security = off;

-- ---- 1) 충돌 먼저 (051/064 집안 방식) ---------------------------------------
-- 064 를 통과한 DB 라면 여기 걸릴 행은 없다: 모든 email 이 이미 정규형이고
-- UNIQUE (workspace_id, email) 가 그 정규형들의 유일성을 이미 보장한다. 그래도
-- 검사한다 — 064 이후 운영자가 CHECK 을 떼고 손으로 넣었을 수 있고, 그 경우
-- CREATE UNIQUE INDEX 의 날것 23505 는 "어느 주소가 문제인지"를 말해주지 않는다.
DO $$
DECLARE
  v_collisions text;
BEGIN
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
      'cannot make human.email uniqueness case-insensitive; these addresses collide '
      'once case and padding are folded: %. They are distinct accounts with distinct '
      'passwords — pick which one keeps the address (or change one), then re-run the '
      'migration. Issue #1252.',
      v_collisions;
  END IF;
END $$;

-- ---- 2) 유일성을 정직한 문장으로 -------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS human_email_norm_uniq
  ON human (workspace_id, lower(btrim(email)));

-- ---- 3) 조회가 타던 인덱스를 유일성과 분리해 남긴다 -------------------------
-- (2) 는 이 술어에 쓰이지 못한다(위 실측). 이것이 없으면 로그인/가입 사전점검
-- 다섯 곳이 전부 Seq Scan 으로 떨어진다.
CREATE INDEX IF NOT EXISTS human_email_idx
  ON human (workspace_id, email);

-- ---- 4) 대체된 제약을 걷어낸다 ----------------------------------------------
-- (2)/(3) 이 먼저 서 있으므로 유일성이 비는 순간은 없다. UNIQUE (workspace_id,
-- email) 는 (2) 에 논리적으로 포함된다: 정규형이 같으면 원문이 같은 두 행도 같은
-- 키를 갖는다.
ALTER TABLE human DROP CONSTRAINT IF EXISTS human_email_uniq;

COMMENT ON INDEX human_email_norm_uniq IS
  '#1252: 한 워크스페이스 안에서 이메일은 대소문자·양끝 공백을 접어 유일하다. '
  '064 의 human_email_normalized_ck 가 없어도 케이스 쌍둥이를 막는 것은 이 인덱스다 '
  '— 064 는 저장 정규형을, 이 인덱스는 유일성을 지탱한다.';

COMMENT ON INDEX human_email_idx IS
  '#1252: 조회 전용. #1247/#1251 의 다섯 조회는 파라미터쪽만 접으므로 '
  '(h.email = lower(btrim($n))) human_email_norm_uniq 를 쓸 수 없고, 이 b-tree 를 '
  'Index Cond 로 탄다. human_email_uniq 를 걷어내면서 그 계획을 대신 떠받친다.';

-- 064 의 주석은 human_email_uniq 를 이름으로 부른다 — 그 객체가 방금 사라졌다.
-- 남겨두면 다음에 읽는 사람에게 없는 인덱스를 가리키게 되므로 여기서 고쳐 쓴다.
COMMENT ON CONSTRAINT human_email_normalized_ck ON human IS
  '#1234: 저장 이메일은 항상 lower(btrim()) 정규형. verify_password_login 이 입력쪽만 '
  '정규화해 human_email_idx 를 Index Cond 로 쓸 수 있는 근거다. 케이스 쌍둥이 자체를 '
  '막는 것은 #1252 의 human_email_norm_uniq 이고, 이 CHECK 은 그것에 의존하지 않는다.';
