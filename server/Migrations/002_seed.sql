-- =============================================================================
-- 002_seed.sql — momo v0 데모 시드 (L4 §9.2 MVP / 경험 D·B·C 타깃)
-- runtime-unverified (no docker/psql) — 이 환경엔 psql 부재. 정적으로만 작성/점검.
-- 실제 적용은 PG18 + scripts/migrate.sh(psql) 로 001_init.sql 이후 검증 필요.
--
-- 시드 내용 (티켓 T03 수용기준):
--   workspace 1 · human 1 · agent 1(김인턴, model=hermes-agent, base_url placeholder)
--   채널 #general + #agent-lab · membership(전원 양 채널) · channel_seq 0행(채널당)
--   model_pricing 글로벌 1행(workspace_id NULL).
--
-- 정합 메모(schema_v0.sql = 001_init.sql 기준):
--   * PK 기본값은 uuidv7()지만, 시드는 FK 배선/멱등 재실행을 위해 고정 UUID를 명시한다.
--     (uuidv7 시간정렬 이점은 데모 시드 한정으로 포기 — 결정론적 재현 우선.)
--   * member.kind ∈ {human,agent}, human/agent 는 member 와 1:1 공유 PK.
--   * channel.kind='public' → name 필수(channel_name_required_ck). dm_key 불필요.
--   * channel_seq 는 채널당 1행, last_seq=0 에서 시작(첫 메시지 발급 시 1).
--   * 전 테이블 RLS FORCE → 테넌트 행 INSERT 전 app.workspace_id 세팅 필수.
--   * model_pricing 글로벌 행(workspace_id IS NULL)은 policy WITH CHECK 가 NULL 쓰기를
--     금지하므로(테넌트 위장 방지), 이 트랜잭션 한정 row_security=off 로 우회한다.
--     (migrate.sh 는 DB owner/superuser 컨텍스트 → SET LOCAL row_security 가능.)
--
-- 멱등성: 고정 UUID + ON CONFLICT DO NOTHING. 재실행해도 중복/오류 없음.
-- =============================================================================

BEGIN;

-- 데모 워크스페이스 컨텍스트(RLS) — 이 tx 동안 모든 테넌트 INSERT 가 통과하도록.
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';
-- 글로벌 model_pricing(workspace_id NULL) INSERT 를 위해 이 tx 한정 RLS 우회.
SET LOCAL row_security = off;

-- ---- 1) workspace -----------------------------------------------------------
INSERT INTO workspace (id, slug, name)
VALUES ('00000000-0000-7000-8000-000000000001', 'demo', 'momo Demo Workspace')
ON CONFLICT (id) DO NOTHING;

-- ---- 2) members (human + agent, kind 로 구분) --------------------------------
-- 사람 멤버
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('00000000-0000-7000-8000-000000000101',
        '00000000-0000-7000-8000-000000000001',
        'human', 'active', '데모 사용자', 'demo')
ON CONFLICT (id) DO NOTHING;

-- 에이전트 멤버(김인턴) — 사람과 동일한 member 테이블의 1급 멤버.
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('00000000-0000-7000-8000-000000000102',
        '00000000-0000-7000-8000-000000000001',
        'agent', 'active', '김인턴', 'kim-intern')
ON CONFLICT (id) DO NOTHING;

-- ---- 3) human 프로필(1:1 공유 PK) -------------------------------------------
INSERT INTO human (member_id, workspace_id, email, email_verified, tz)
VALUES ('00000000-0000-7000-8000-000000000101',
        '00000000-0000-7000-8000-000000000001',
        'demo@momo.local', true, 'Asia/Seoul')
ON CONFLICT (member_id) DO NOTHING;

-- ---- 4) agent 프로필(1:1 공유 PK) — OpenAI 호환 엔드포인트 설정 ---------------
-- model=hermes-agent, base_url 은 placeholder(.env HERMES_BASE_URL 와 정합).
-- bearer 시크릿은 여기 저장 안 함 → token(kind='agent_bearer') 에 보관(스펙 §2 주석).
-- v0 루프 안전: max_concurrent_runs=1, max_run_steps 는 §3.3 G3 권고(12)로 오버라이드.
INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('00000000-0000-7000-8000-000000000102',
        '00000000-0000-7000-8000-000000000001',
        'hermes-agent',
        'http://localhost:8088/v1',                 -- placeholder (HERMES_BASE_URL)
        '당신은 momo 워크스페이스의 1급 멤버 김인턴입니다. 도구를 사용해 일하고, 부수효과 액션은 사람 승인을 요청하세요.',
        '00000000-0000-7000-8000-000000000101',     -- owner = 데모 사용자
        1, 12)
ON CONFLICT (member_id) DO NOTHING;

-- ---- 5) channels (#general, #agent-lab — 둘 다 public) -----------------------
INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
VALUES ('00000000-0000-7000-8000-000000000201',
        '00000000-0000-7000-8000-000000000001',
        'public', 'general', '팀 일반 채널',
        '00000000-0000-7000-8000-000000000101')
ON CONFLICT (id) DO NOTHING;

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
VALUES ('00000000-0000-7000-8000-000000000202',
        '00000000-0000-7000-8000-000000000001',
        'public', 'agent-lab', '에이전트 실험실 — 김인턴 데모(D/B/C)',
        '00000000-0000-7000-8000-000000000101')
ON CONFLICT (id) DO NOTHING;

-- ---- 6) channel_seq 0행 (채널당 1행, last_seq=0) -----------------------------
-- 첫 메시지 발급 시 UPDATE channel_seq SET last_seq=last_seq+1 → seq=1 (갭리스).
INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('00000000-0000-7000-8000-000000000201',
        '00000000-0000-7000-8000-000000000001', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('00000000-0000-7000-8000-000000000202',
        '00000000-0000-7000-8000-000000000001', 0)
ON CONFLICT (channel_id) DO NOTHING;

-- ---- 7) membership (사람 + 김인턴 모두 양 채널 가입) --------------------------
-- #general: 사람=owner, 김인턴=member
INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('00000000-0000-7000-8000-000000000301',
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000201',
        '00000000-0000-7000-8000-000000000101', 'owner')
ON CONFLICT (channel_id, member_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('00000000-0000-7000-8000-000000000302',
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000201',
        '00000000-0000-7000-8000-000000000102', 'member')
ON CONFLICT (channel_id, member_id) DO NOTHING;

-- #agent-lab: 사람=owner, 김인턴=member (데모 D/B/C 무대)
INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('00000000-0000-7000-8000-000000000303',
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000202',
        '00000000-0000-7000-8000-000000000101', 'owner')
ON CONFLICT (channel_id, member_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('00000000-0000-7000-8000-000000000304',
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000202',
        '00000000-0000-7000-8000-000000000102', 'member')
ON CONFLICT (channel_id, member_id) DO NOTHING;

-- ---- 8) model_pricing 글로벌 1행 (workspace_id NULL = 전 테넌트 기본가) --------
-- 경험 B(비용 호흡)의 reserve→reconcile micro_usd 계산 근거. 단가는 데모용 예시값.
-- numeric(20,6) micro_usd/token (float 드리프트 회피, 정수 누계). reasoning NULL → output 단가 사용.
-- model='hermes-agent' 로 agent.model 과 정합.
INSERT INTO model_pricing
  (id, workspace_id, model, currency,
   input_micro_usd_per_token, output_micro_usd_per_token,
   cache_write_micro_usd_per_token, cache_read_micro_usd_per_token,
   reasoning_micro_usd_per_token)
VALUES
  ('00000000-0000-7000-8000-000000000401',
   NULL, 'hermes-agent', 'USD',
   0.150000,    -- input  : $0.15 / 1M tok  (= 0.15 micro_usd/tok)
   0.600000,    -- output : $0.60 / 1M tok
   0.187500,    -- cache write
   0.015000,    -- cache read
   NULL)        -- reasoning → output 단가로 폴백
ON CONFLICT (workspace_id, model, currency, effective_from) DO NOTHING;

COMMIT;

-- 끝. 적용 검증은 runtime-unverified (no docker/psql).
