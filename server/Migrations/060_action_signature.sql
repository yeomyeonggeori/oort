-- =============================================================================
-- 060_action_signature.sql — ADR-0146 (Accepted 2026-07-31) / goal B2.5
--
-- 행위자 행동의 암호학적 provenance 사이드카. buzz(Nostr)의 "모든 행동이 서명된
-- 이벤트" 이점만 additive 하게 취한다 — 서명은 **권한이 아니라 메타데이터**다.
--
-- D2 불변식과의 관계(ADR-0146 교차검증 표 그대로):
--   * 단일 쓰기경로 — 불변. 이 테이블은 서버 우회 publish 권한을 주지 않는다.
--     흐름 = 행위자가 서명 assertion 제출 → 서버가 검증 → **서버가 여전히 유일
--     저자로 도메인 row 를 쓰고** → 그 같은 트랜잭션에서 여기에 사이드카 1행.
--   * gapless message.seq — 불변. 서명은 authenticity 만 다루고 순서와 무관하다.
--     서버 부여 seq/id 는 서명 이후에 붙으므로 2단계다(§2단계 서명 참조).
--   * RLS FORCE — 불변. 사이드카도 동일 테넌트 정책 아래 둔다(아래 DO 블록).
--   * provider 자격증명 비유입(ADR-0004) — 불변. signer_pubkey 는 행위자 신원키의
--     공개 절반일 뿐 provider 자격증명이 아니고, 비밀키는 momo 에 들어오지 않는다.
--
-- ## 2단계 서명 — 이 테이블이 곧 2단계다
--
--   1단계(행위자): 서버가 부여하기 전에 알 수 있는 것만 서명한다(content).
--                  실제 서명 바이트는 표면별로 momo-wire 가 정의한다:
--                    · work_host.heartbeat  → momo.work_host.heartbeat.v1 (기존)
--                    · work_host.terminal_attach_validate
--                                           → momo.work_host.request.v2  (기존)
--                    · message              → momo.provenance.message.v1 (신설)
--   2단계(서버):   서버는 **자기 서명을 만들지 않는다**(서버 키를 신설하면
--                  ADR-0146 이 승인하지 않은 키 관리 표면이 생긴다). 서버가 부여한
--                  식별자와 1단계 서명의 결속은 **이 행 자체**다 —
--                  (entity_type, entity_id) 가 서버 부여 식별자를 이름하고,
--                  append-only + RLS FORCE 가 그 결속을 사후 변조로부터 지킨다.
--
-- signed_payload_digest 는 **서명이 실제로 덮는 1단계 바이트**의 소문자 hex
-- SHA-256 이다(envelope 다이제스트가 아니다). 감사자는 entity 로부터 1단계
-- 페이로드를 재구성 → 해시가 이 컬럼과 같은지 확인 → signer_pubkey 로 signature 를
-- 재검증하는 두 단계로 사후 검증할 수 있어야 하고, envelope 해시를 저장하면 그
-- 재검증이 불가능해진다.
--
-- ## signer_member_id 가 nullable 인 이유 (audit_log.via_token_id 와 같은 규율)
--
-- work-host 서명자는 member 가 **아니다**. 호스트의 owner_member_id 를 여기 쓰면
-- "그 사람이 서명했다"는 거짓 기록이 된다(Swift 서버가 via_token_id 에 host id 를
-- 넣어 500 을 맞고 NULL 로 고친 것과 동일한 함정 — WorkSessionRoutes.swift:1013).
-- 그래서 member 가 서명한 행동만 signer_member_id 를 채우고, 호스트 서명은 NULL 이며
-- 서명자 신원은 signer_pubkey 가 이름한다(work_host.public_key 로 해소된다).
--
-- ## 볼륨 주의 (오케스트레이터 판단 필요 — PR 본문 fast-follow #1)
--
-- workd heartbeat 기본 주기는 30초다(WorkHostDaemon 테스트 픽스처 .seconds(30)).
-- 검증된 heartbeat 마다 1행이면 호스트당 하루 2,880행이 쌓인다. 유니크 인덱스가
-- 같은 서명의 재제출은 흡수하지만 서로 다른 sentAtMs 는 서로 다른 행이다.
-- 그래서 append-only 트리거는 DELETE 를 **무조건** 막지 않는다: 테넌트 삭제
-- 캐스케이드와, 이름 붙은 보존정책 진입점(momo.provenance_retention GUC)만 통과시킨다
-- — 053 이 t3_terminate 에 쓴 것과 같은 패턴. 보존 잡 자체는 이 배치 범위 밖이다.
-- =============================================================================

CREATE TABLE action_signature (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- 서명이 귀속되는 행동/엔티티의 종류. 세 표면이 여러 테이블에 걸치므로
  -- 폴리모픽이고, 따라서 FK 가 아니다 — 대신 record_provenance 가 도메인 write 와
  -- 같은 트랜잭션에서만 호출된다는 chokepoint 규율이 참조 무결성을 대신한다.
  entity_type           text NOT NULL,
  entity_id             uuid NOT NULL,
  -- member 가 서명한 행동만 채운다. 호스트 서명 = NULL (위 규율 참조).
  -- FK 는 아래 복합 제약 하나뿐이다(MATCH SIMPLE 이라 NULL 은 그대로 통과).
  signer_member_id      uuid,
  signer_pubkey         text NOT NULL,
  signature             text NOT NULL,
  signed_payload_digest text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- 021:26-27 work_host_public_key_ck 와 같은 문법: 32바이트 Ed25519 raw key 의 base64.
  CONSTRAINT action_signature_pubkey_ck
    CHECK (signer_pubkey ~ '^[A-Za-z0-9+/]{43}=$'),
  -- 64바이트 Ed25519 서명의 base64 = 86 데이터문자 + '=='.
  CONSTRAINT action_signature_signature_ck
    CHECK (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  -- momo-wire sha256_hex 와 같은 표기(소문자 hex).
  CONSTRAINT action_signature_digest_ck
    CHECK (signed_payload_digest ~ '^[0-9a-f]{64}$'),
  -- 열린 어휘지만 규율은 있다: 표면이 늘어도 마이그레이션이 필요 없고,
  -- 대소문자/공백 섞인 라벨이 사일런트로 들어오지는 못한다.
  CONSTRAINT action_signature_entity_type_ck
    CHECK (entity_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
           AND length(entity_type) <= 64),
  -- signer_member_id 가 있다면 같은 테넌트의 member 여야 한다(027 의
  -- member_workspace_id_uniq 를 참조하는 032 와 같은 복합 FK 형태).
  CONSTRAINT action_signature_signer_workspace_fk
    FOREIGN KEY (workspace_id, signer_member_id) REFERENCES member (workspace_id, id)
);

-- 감사 조회 = "이 엔티티에 붙은 서명들". created_at DESC 는 최신 우선 열람.
CREATE INDEX action_signature_entity_idx
  ON action_signature (workspace_id, entity_type, entity_id, created_at DESC);

-- 서명자별 조회(감사 API): "이 키가 서명한 행동들".
CREATE INDEX action_signature_signer_idx
  ON action_signature (workspace_id, signer_pubkey, created_at DESC);

-- 같은 서명 바이트는 테넌트당 한 번만 기록된다. 재시도된 heartbeat/validate 가
-- 두 번째 행을 만들지 않게 하는 멱등 장치이자, record_provenance 를 재호출해도
-- 안전하게 만드는 근거다. 서명은 페이로드에 엔티티를 결속하므로 두 엔티티가 한
-- 서명을 정당하게 공유할 수 없다.
CREATE UNIQUE INDEX action_signature_signature_uniq
  ON action_signature (workspace_id, signature);

COMMENT ON TABLE action_signature IS
  'ADR-0146 append-only 행동 provenance 사이드카. 서명은 권한이 아니라 검증 가능한 메타데이터다.';
COMMENT ON COLUMN action_signature.signer_member_id IS
  'member 가 서명한 행동만. work-host 서명은 NULL이고 신원은 signer_pubkey 가 이름한다.';
COMMENT ON COLUMN action_signature.signed_payload_digest IS
  '서명이 덮는 1단계 바이트의 소문자 hex SHA-256. envelope 해시가 아니라 재검증 입력이다.';
COMMENT ON COLUMN action_signature.entity_type IS
  'work_host.heartbeat | work_host.terminal_attach_validate | message (momo-wire 가 정본).';

-- ---------------------------------------------------------------------------
-- append-only
-- ---------------------------------------------------------------------------

CREATE FUNCTION reject_action_signature_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'action_signature is append-only'
    USING ERRCODE = '23514';
END $$;

CREATE TRIGGER action_signature_no_update
BEFORE UPDATE ON action_signature
FOR EACH ROW EXECUTE FUNCTION reject_action_signature_update();

-- DELETE 는 두 경우만 통과한다:
--   (1) 테넌트가 사라지는 중 — workspace ON DELETE CASCADE. RI 캐스케이드는 부모
--       행이 이미 지워진 스냅샷에서 실행되므로 아래 EXISTS 가 false 다. 이 예외가
--       없으면 workspace 삭제 자체가 불가능해진다.
--   (2) 이름 붙은 보존정책 진입점 — momo.provenance_retention = 'on' 인 세션.
--       053 의 momo.t3_settlement 패턴. 이 배치의 Rust 코드는 이 GUC 를 설정하지
--       않는다(보존 잡은 fast-follow). 애플리케이션의 임의 삭제는 계속 막힌다.
--
-- (1)의 EXISTS 가 우회로가 되지 않는 이유: workspace 도 같은 GUC 로 RLS 격리된다
-- (009:14-16). momo_app 이 action_signature 행을 보려면 GUC 가 그 테넌트여야 하고,
-- 그러면 workspace 행도 보이므로 EXISTS 는 true 다. BYPASSRLS 롤과 슈퍼유저는 항상
-- 둘 다 보므로 역시 true. EXISTS 가 false 인 경우는 workspace 가 실제로 사라진
-- 경우뿐이다.
CREATE FUNCTION reject_action_signature_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('momo.provenance_retention', true) IS DISTINCT FROM 'on'
     AND EXISTS (SELECT 1 FROM workspace WHERE id = OLD.workspace_id)
  THEN
    RAISE EXCEPTION 'action_signature is append-only'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER action_signature_no_delete
BEFORE DELETE ON action_signature
FOR EACH ROW EXECUTE FUNCTION reject_action_signature_delete();

-- ---------------------------------------------------------------------------
-- 테넌트 격리 (048 과 같은 형태)
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['action_signature'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;
