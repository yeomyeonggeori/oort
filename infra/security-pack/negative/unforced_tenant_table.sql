-- SEC-03 음성 대조 픽스처 (#4241): 테넌트 테이블(workspace_id 보유)을 만들면서
-- RLS ENABLE 은 하되 FORCE 는 빼 먹은 마이그레이션. Security pack 의 tenant_catalog_pg 가
-- 이 DB 에서 반드시 빨강이어야 하고, 위반 줄에 아래 테이블 이름이 있어야 한다.
-- 일회용 DB 에만 적용한다(scripts/security_pack.sh negative). 정본 server/Migrations 가 아니다.
CREATE TABLE public.sec03_negative_unforced (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  note         text NOT NULL DEFAULT ''
);
ALTER TABLE public.sec03_negative_unforced ENABLE ROW LEVEL SECURITY;
CREATE POLICY sec03_negative_unforced_tenant ON public.sec03_negative_unforced
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
-- 의도적으로 FORCE ROW LEVEL SECURITY 없음.
