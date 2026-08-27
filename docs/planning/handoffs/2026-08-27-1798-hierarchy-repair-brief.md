# #1798 수리 브리프 — 패스워드 리셋 권한 위계 (ADR-0128 D2)

> 성재 결재 2026-08-27: 수정 계약 승인("owner만 owner/admin 대상 reset 발급"). 검수 정본 `research/2026-08-27-fable-audit-of-opus-session.md` §4.2 처방 승계.
> 대상: PR #1798 (`feat/1767-password-reset`, base=track/engine). 워크트리 `~/projects/momo-tracks/momo-worktrees/w1767-password-reset`.

## 0. 결함 (실측 확정)

`server-rust/bins/momo-server/src/routes/password.rs`의 `issue_password_reset`이 행위자 role만 본다(`require_admin` → `role.is_admin()`). `issue_password_reset_in_tx`의 오류 집합(NotFound·NotHuman·NotActive)에 **대상 role 축이 없다**. 자기 자신 차단도 없다.

결과: Admin이 Owner 대상 reset 토큰을 201로 받아 → 공개 `POST /v1/claim`으로 Owner 비번 설정 → `password_reset` kind가 대상의 다른 세션 전량 revoke → **Admin의 Owner 계정 완전 탈취**. ADR-0128 D2("자기보다 높거나 같은 역할 조작 불가") 정면 위반.

## 1. 수리 계약

1. **base sync 먼저**: `origin/track/engine`(89298a2f, #1799 초대 3경로 랜딩 포함)을 `feat/1767-password-reset`에 머지, 충돌 해소(STATUS.md·openapi.yaml·schema.d.ts·lib.rs 라우트 등록부·verify 스크립트 예상). force push 금지 — 기존 PR 브랜치에 append.
2. **위계 판정은 도메인 층, 같은 트랜잭션 안**: `issue_password_reset_in_tx`(momo-auth)가 actor_id를 받아 **행위자·대상 role을 그 트랜잭션에서 조회**하고 판정한다. 라우트 층 `require_admin`은 남겨도 되나 단독 권위 금지(우회 경로 방지 — 도메인이 정본).
3. **자기 자신 403**: actor==target은 무조건 거부. 본인 변경은 `PATCH …/members/me/password`가 유일 경로.
4. 403 응답은 기존 `ErrorResponse` wire 계약, 문구는 닫힌 집합으로(원문 role 노출 불필요).
5. OpenAPI `issuePasswordReset` description에 위계 규칙 명문화 + `schema.d.ts` 재생성 + STATUS.md 항목 갱신.

## 2. 권한 매트릭스 (red proof 필수 — 각 칸이 conformance 테스트 1건)

| 행위자 ↓ \ 대상 → | owner(타인) | admin | member | guest | 자기 자신 |
|---|---|---|---|---|---|
| **owner** | ✅ 201 (다중 owner 잠금 해제 유일 경로) | ✅ 201 | ✅ 201 | ✅ 201 | ❌ 403 |
| **admin** | ❌ 403 | ❌ 403 | ✅ 201 | ✅ 201 | ❌ 403 |
| **member/guest** | ❌ 403 (기존 `require_admin` 유지) | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |

- red proof 관례: 수리 전 admin→owner가 **201로 통과하는 RED를 먼저 커밋 로그로 남기고**(또는 테스트 선행 커밋으로 실패 확인) 수리 커밋으로 GREEN 전환.
- 테스트는 `password_reset_conformance_pg`에 추가. PG 게이트 절차는 원 구현 동봉분(`scripts/verify_owner_claim.sh`·테스트 파일 헤더의 bootstrap_roles.sql 관례) 그대로.

## 3. 게이트 (전부 자가 실행, 그린 로그를 커밋/PR 코멘트에 동반)

- `cargo test` 워크스페이스 + `cargo test -p momo-server --test password_reset_conformance_pg`(PG 게이트, 매트릭스 신규 케이스 포함).
- `scripts/verify_openapi_contract_rust.sh` + openapi↔schema.d.ts 정합.
- gitleaks 로컬 프리체크(시크릿 비유입).

## 4. 정지 조건 (정지는 실패가 아니라 옳은 행동 — 정지 시 push 없이 상황 보고만)

- 계약과 코드 실측이 모순될 때(예: role 조회가 해당 트랜잭션 스코프에서 RLS로 불가).
- `schema_v0.sql` 수정·이동이 필요해 보일 때(하드 룰 위반 — 무조건 정지).
- 위계 판정을 도메인 층에 넣을 수 없는 구조적 이유를 발견했을 때.
- 게이트 RED가 수리 범위 밖 원인일 때.
- base sync 충돌이 기계적 해소 범위를 넘을 때(의미 충돌).

## 5. 금지·완료

- merge/close 금지 · force push 금지 · 시크릿 커밋 금지 · `schema_v0.sql` 비접촉.
- 커밋 메시지는 한국어 관례(무엇이 왜).
- 완료 = push 후 정지. 재검수·머지는 오케스트레이터(Fable) 몫.
