-- =============================================================================
-- 062_message_pin.sql — 이슈 #1112 (채팅 pin v0)
--
-- 채널 고정(pin). reaction 경로와 **동형**으로 설계했다: message 를 건드리지 않는
-- 사이드카 테이블 1장 + 같은 트랜잭션 outbox 브로드캐스트 + RLS FORCE.
--
-- D2 불변식과의 관계
--   * 단일 쓰기경로 — 불변. pin/unpin 은 REST→PG→outbox→relay 를 그대로 탄다.
--   * gapless message.seq — 불변. 고정은 `message` 를 **한 컬럼도** 수정하지 않고
--     channel_seq 를 건드리지 않는다. 브로드캐스트는 대상 메시지 자신의 seq 를
--     재사용한다(reaction 과 같은 이유 — 고정이 새 seq 를 소모하면 모든 커서에게
--     "읽지 않은 메시지 1건"으로 보인다).
--   * 에이전트=member — 불변. pinned_by 는 member.id 하나뿐이고 member_kind 분기가
--     이 파일에도, 도메인 코드에도 없다.
--   * RLS FORCE — 불변(아래 DO 블록, 048/060 과 같은 형태).
--
-- ## reaction 과 다른 단 한 가지: 고정은 **개인이 아니라 채널의 사실**이다
--
-- reaction 은 (message, member, emoji) 유니크다 — 같은 메시지에 여러 사람이 각자
-- 반응한다. pin 은 (message) 유니크다. 두 사람이 같은 메시지를 고정해도 채널
-- 상단에 두 줄이 생기지 않는다. 그래서 pinned_by 는 소유권이 아니라 **출처 기록**
-- 이고, 해제 권한은 채널 멤버 전원에게 있다(고정한 사람이 워크스페이스를 떠나면
-- 아무도 못 푸는 고정이 남는 설계를 피한다).
--
-- ## 채널당 상한 = 100
--
-- reaction 의 상한(메시지당 200행)이 스냅샷 투영 비용의 경계인 것과 달리, pin 의
-- 상한은 **읽기 표면**의 경계다: 고정 목록은 채널 헤더에 상주하고 채널을 열 때마다
-- message JOIN 으로 투영된다. 스캔 가능한 길이를 넘으면 기능 자체가 죽는다.
-- 100 은 Slack 의 채널당 고정 한도와 같은 값이고, 헤더 목록이 감당하는 상한이다.
--
-- 상한은 **여기(트리거)가 정본**이고 도메인 코드의 사전 count 는 사용자에게 409 를
-- 돌려주기 위한 앞단일 뿐이다. 애플리케이션 count 만으로는 서로 다른 메시지를
-- 고정하는 두 동시 트랜잭션이 같은 99 를 읽고 둘 다 통과한다(reaction 은 대상
-- 메시지 행을 FOR UPDATE 로 잡아 같은 메시지끼리 직렬화되지만, 채널 상한은 그 락이
-- 덮지 못한다). 도메인은 채널 advisory 락으로 그 경합을 직렬화하고, 이 트리거는
-- advisory 를 잊은 미래의 경로까지 막는 스키마 사실이다.
-- =============================================================================

CREATE TABLE message_pin (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 비정규화가 아니라 상한의 축이다. 고정 목록도 상한 카운트도 채널 단위이고,
  -- 매번 message JOIN 으로 채널을 알아내면 두 쿼리 모두 대상 채널 전체를 훑는다.
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  -- 출처 기록. 해제 권한의 근거가 아니다(위 규율 참조).
  pinned_by     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  pinned_at     timestamptz NOT NULL DEFAULT now(),
  -- 채널의 사실이므로 메시지당 한 행. 두 번째 PUT 은 ON CONFLICT DO NOTHING 으로
  -- 흡수되어 멱등이 된다(reaction_uniq 가 중복 이모지에 하는 일과 같다).
  CONSTRAINT message_pin_message_uniq UNIQUE (message_id)
);

-- 목록 조회 = "이 채널의 고정들, 최근 고정 우선". 상한 카운트도 이 인덱스를 탄다.
CREATE INDEX message_pin_channel_idx ON message_pin (channel_id, pinned_at DESC);

COMMENT ON TABLE message_pin IS
  '이슈 #1112 채널 고정. reaction 과 동형인 사이드카 — message 를 수정하지 않고 seq 를 소모하지 않는다.';
COMMENT ON COLUMN message_pin.pinned_by IS
  '고정한 member. 소유권이 아니라 출처 기록이며 해제 권한은 채널 멤버 전원에게 있다.';
COMMENT ON COLUMN message_pin.channel_id IS
  '채널당 상한과 헤더 목록의 축. message 조인 없이 두 경로가 모두 성립하도록 함께 쓴다.';

-- ---------------------------------------------------------------------------
-- 채널당 상한 (정본)
-- ---------------------------------------------------------------------------

CREATE FUNCTION enforce_message_pin_channel_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pinned integer;
BEGIN
  SELECT count(*) INTO pinned FROM message_pin WHERE channel_id = NEW.channel_id;
  IF pinned >= 100 THEN
    -- 도메인이 먼저 409 로 돌려주므로 여기까지 오는 것은 advisory 를 우회한
    -- 경로뿐이다. ERRCODE 는 CHECK 위반과 같은 23514 — 상한은 제약이지 사고가
    -- 아니다.
    RAISE EXCEPTION 'channel % already has the maximum 100 pinned messages',
      NEW.channel_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER message_pin_channel_limit
BEFORE INSERT ON message_pin
FOR EACH ROW EXECUTE FUNCTION enforce_message_pin_channel_limit();

-- ---------------------------------------------------------------------------
-- 테넌트 격리 (048/060 과 같은 형태)
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_pin'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;
