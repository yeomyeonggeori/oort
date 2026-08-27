# #1800 브리프 — workspace.settings 읽기·쓰기 REST 표면 (AC-4 선행)

> 방향 기승인(성재 결재 ④ 2026-08-27: #1768=순서 ⑥, 선행=#1800·#1770). 실행플랜 `2026-08-27-post-audit-execution-plan.md` 순서 ③.
> 대상: GitHub Issue #1800. 새 브랜치 `feat/1800-workspace-settings`, base=`origin/track/engine`(**094cdc87**, #1798·#1799 포함). 워크트리 `~/projects/momo-tracks/momo-worktrees/w1800-workspace-settings`.

## 0. 현황 (실측 확정, 094cdc87 기준)

- `workspace.settings jsonb NOT NULL DEFAULT '{}'` 컬럼은 있으나(`schema_v0.sql:32`) **읽고 쓰는 REST가 없다**. `lib.rs:649`는 `/v1/workspaces/{ws}` get 하나뿐. 쓰는 곳은 테스트 SQL 직접 UPDATE뿐(`agent_ops_conformance_pg.rs:304`).
- **정본 성문 2곳이 이미 방향을 정해 놓았다**: `dto.rs:3304`·`routes/agents.rs:583` — settings는 "extensible bag, may later hold keys not every member may read". 즉 **전 멤버 표면에 bag을 통으로 노출하는 설계는 기존 정본 위반**이다.
- 실사용 키: `allowed_agent_models`(agents 게이트·모델 피커가 파생 프로젝션 `AllowedAgentModelsResponse`로 읽음, SRV-B3 fail-closed). 예약 키: `role_labels`(AC-4 #1770이 의미론을 정한다 — 이 티켓에서 구현 금지).

## 1. 설계 계약

1. **읽기**: 신설 `GET /v1/workspaces/{ws}/settings` — **operator(owner/admin) 전용**. 기존 `GET /v1/workspaces/{ws}` 응답은 **비접촉**(전 멤버 표면 — §0 성문 근거). 멤버가 읽어야 할 키는 키별 파생 프로젝션이 정답이며(`allowed_agent_models` 선례) 그건 각 후속 티켓 몫.
2. **쓰기**: 신설 `PATCH /v1/workspaces/{ws}/settings` — **최상위 키 단위 부분 병합**(RFC 7396 동형: 지정 키만 교체, 미지정 키 보존, `null`=키 삭제). 전체 교체 PUT은 만들지 않는다(키가 늘수록 상호 덮어쓰기 위험).
3. **권한·골격**: `unfurl-settings` 라우트 골격을 그대로 승계 — `require_human` → `workspace_scope` → `require_workspace_operator`(`routes/shared.rs:383`, 단일 권위 — 새 검사 발명 금지) → `agent_tenant_tx`(테넌트 트랜잭션=RLS 경계) → audit 엔트리(`workspace_setting.updated` 계열, unfurl의 `with_schema` 관례).
4. **키 allowlist**: 미지 최상위 키는 **400**. 시작 집합은 `allowed_agent_models` 하나(형태 검증: 문자열 배열·원소 수·길이 상한. 의미론은 기존 헬퍼 소관 — 건드리지 않는다). `role_labels`는 OpenAPI에 예약 주석만, 수용은 AC-4에서.
5. **상한**: 요청 본문·배열 원소 수·문자열 길이 상한 명시(레포 기존 body-limit 관례 실측 후 정렬, 무제한 금지). 초과는 400/413 닫힌 오류.
6. **OpenAPI**: 두 라우트 명세 + 권한 규칙 명문화 → `schema.d.ts` 재생성 → STATUS.md 항목 갱신. 오류는 기존 `ErrorResponse` wire 계약.

## 2. red proof (PG 컨포먼스 — 신설 `workspace_settings_conformance_pg`)

각 행이 테스트 1건 이상:

- member/guest의 GET·PATCH → **403** · agent bearer → 403(`require_human`) · owner/admin → 200.
- 타 워크스페이스 settings 접근 거부 + **RLS 자가검증**(기존 컨포먼스 관례).
- 부분 병합: 키 A 존재 상태에서 키 B만 PATCH → **A 보존** · `null` PATCH → 키 삭제 · 설정 없는 워크스페이스 GET → `{}`.
- 미지 키 → 400 · `allowed_agent_models` 형태 위반(비배열·비문자열 원소) → 400 · 과대 페이로드 → 거부.
- PATCH 후 audit 엔트리 실재.
- 기존 `GET /v1/workspaces/{ws}` 응답에 settings **미포함 유지**(계약 불변 회귀 자).
- red 관례: 표면 부재/우회 허용이 드러나는 실패 테스트를 선행 커밋으로 RED 확인 후 구현 커밋으로 GREEN 전환.

## 3. 게이트 (전부 자가 실행, 그린 로그를 커밋/PR 코멘트에 동반)

- `cargo fmt --check` · `cargo clippy` · `cargo test` 워크스페이스 + `cargo test -p momo-server --test workspace_settings_conformance_pg`(PG 게이트 — 15432 게이트 PG 관례).
- `scripts/verify_openapi_contract_rust.sh` + openapi↔schema.d.ts 정합.
- gitleaks 로컬 프리체크(시크릿 비유입).

## 4. 정지 조건 (정지는 실패가 아니라 옳은 행동 — 정지 시 push 없이 상황 보고만)

- 계약과 코드 실측이 모순될 때(예: `require_workspace_operator`가 owner/admin 사다리가 아니거나, 테넌트 트랜잭션에서 settings 쓰기가 RLS로 불가).
- `schema_v0.sql` 수정·이동이 필요해 보일 때(하드 룰 — 무조건 정지).
- §0 성문(비노출 설계)과 이 계약이 충돌하는 제3의 실측이 나올 때.
- 게이트 RED 원인이 이 티켓 범위 밖일 때.

## 5. 금지·완료

- merge/close 금지 · force push 금지 · 시크릿 커밋 금지 · `schema_v0.sql` 비접촉 · `role_labels` 의미론 구현 금지(AC-4 몫).
- 커밋 메시지는 한국어 관례(무엇이 왜).
- 완료 = push + PR 생성(제목에 `#1800`, base=track/engine) 후 정지. 재검수·머지는 오케스트레이터(Fable) 몫.
