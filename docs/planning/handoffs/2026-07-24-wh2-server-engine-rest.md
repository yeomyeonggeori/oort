# 핸드오프 패킷 — MOMO-582: work host engine 선택 REST (WH-2 서버 선행)

> ADR-0114 증보1 B · WH-1(main 랜딩)이 남긴 쓰기경로. base=**track/engine** · worktree=`../momo-worktrees/710-momo-582-work-host-engine-rest-get-put-wh-2-adr-0114-1-b` · 마이그레이션 신설 없음(040 재사용) · verifier 포트=28280대.

## 목표
WH-2 GUI(#706)가 워크스페이스의 코드 실행 엔진(opencode|goose|codex-local)을 읽고 바꿀 수 있는 서버 REST. 테이블은 이미 존재(마이그레이션 040 `work_host_engine`, RLS FORCE, per-workspace).

## 재사용 (정본 모델)
- `server/Sources/MomoServer/Routes/ProviderLinkRoutes.swift` — **이 파일의 패턴을 그대로 따를 것**: `register`, `requireOperator`(platform:read OR 워크스페이스 owner/admin, 비관리자 403), RLS 세션 GUC(`app.workspace_id`) 경유 쿼리, `ResponseEncodable` 응답 구조체.
- 마이그레이션 040 `work_host_engine(workspace_id PK, engine, updated_by, updated_at, created_at)`, CHECK engine IN ('opencode','goose','codex-local').

## REST 계약 (WH-2 GUI가 이 계약을 소비 — 정확히 지킬 것)
- `GET /v1/provider/work-host-engine` → `{ "engine": "opencode|goose|codex-local", "source": "database|default", "updatedBy": uuid?, "updatedAtMs": int64?, "schema": "momo.work_host_engine.v0" }`. 미설정 시 `engine:"opencode", source:"default"`(행 없음 = 기본, 쓰기 없이).
- `PUT /v1/provider/work-host-engine` body `{ "engine": "opencode|goose|codex-local" }` → 저장 후 GET과 동일 형태(`source:"database"`). upsert(ON CONFLICT workspace_id).
- 권한: requireOperator. 비관리자 403. 잘못된 engine 값 400.

## 수용기준
- [ ] 위 GET/PUT 라우트, requireOperator, per-workspace RLS 경유, upsert.
- [ ] ADR-0004: engine 라벨만 저장(자격증명·경로 무접촉). schema_v0 불변, 새 마이그레이션 없음.
- [ ] server 단위테스트(권한 200/403, 기본 opencode, PUT 왕복, 잘못된 값 400).
- [ ] `scripts/verify_workhost_engines.sh`에 실 REST 왕복 관문 추가(28280대) 또는 provider verifier 확장 — Docker는 오케스트레이터가 실행하니 스크립트만.

## 하드 룰
- PR base=track/engine. PR 후 STOP. merge/close/gate 금지. schema_v0 불변. 시크릿 금지. swift build+단위테스트 커밋 전 통과. Linux 함정 준수(@preconcurrency import Crypto 등).
