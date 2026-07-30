# goal B0 — Rust/Axum 워크스페이스 골격 + 공유 5 crate (ADR-0145 B안 이행 착수)

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**. 워크트리: `~/projects/momo-tracks/momo-worktrees/B0-rust-skeleton` (브랜치 `feat/B0-rust-skeleton`, 이미 생성됨).
근거 정본(작업 전 정독): `docs/adr/0145-server-stack-buzz-fork-rust.md`(Accepted) · `docs/architecture/server-rust.md`(D1 crate 레이아웃) · `docs/architecture/invariants-in-rust.md`(D2 불변식) · `docs/planning/2026-07-30-rewrite-batch-breakdown.md`(D6 §B0).

## 0. 착수 전 필수

1. `git status` clean 확인(워크트리는 이미 준비됨). 2. **자격증명·`.env` 열람 금지**(시크릿 이름조차 출력 금지). 3. **PR 생성 후 STOP** — merge/close 금지, push된 커밋 amend/force-push 금지(새 커밋으로). 4. **docker 검증은 오케스트레이터 몫** — 너는 `cargo check`/`cargo test`(DB 불요 단위)까지만. 실 PG·migration 적용·RLS 단정은 오케스트레이터가 돌린다. 5. 참조하는 Swift 심볼·파일 경로는 열기 전 실재 확인. 6. **기존 파일 수정·이동 금지**: `server/Migrations/**`·`schema_v0.sql`은 읽기만(그대로 재사용, 복사·편집 금지).

## 1. 목표 (D6 §B0)

Cargo 워크스페이스 + **공유 인프라 5 crate 스켈레톤**을 세운다. 도메인 crate(messaging·t3·integrations)·바이너리 실구현은 **이 배치 아님**(B1+). B0는 "컴파일되는 골격 + 불변식 강제 지점의 자리"까지다.

**디렉터리**: 새 워크스페이스 루트 `server-rust/`.
```
server-rust/
  Cargo.toml            # [workspace] members = ["crates/*"]
  crates/
    momo-db/  momo-outbox/  momo-wire/  momo-auth/  momo-provider/
```
- 엔진 트랙 소유 영역(server 계열)이라 트랙 규칙 준수. 루트 `~/projects/momo` 무접촉(너는 워크트리에서만).

## 2. 할 일 (crate별)

### 2-1. `momo-db` — DB 파운데이션 (불변식 #6 RLS·마이그레이션 재사용)
- sqlx `PgPool` 셋업(런타임 쿼리 `sqlx::query` 사용 — B0는 live DB 없이 컴파일돼야 하므로 컴파일타임 `query!` 매크로 금지).
- **`with_tenant_tx(pool, workspace_id, f)`** — tx BEGIN → `SELECT set_config('app.workspace_id', $1, true)`(= `SET LOCAL`, tx 스코프) → 클로저 실행 → COMMIT. **이것이 RLS GUC 배선 유일 지점**(미들웨어 아님). 참조: 현 Swift `server/Sources/MomoServer/DB/Database.swift:85-105`(`withTenantTransaction`) 및 `:92`(set_config).
- 변형 tx 스텁: `with_provider_link_admin_tx`·`with_provider_quota_ingest_tx`(각 `app.provider_link_admin`/`app.provider_quota_admin` GUC 추가). 참조 `Database.swift:181-236`.
- **마이그레이션 러너**: 기존 `server/Migrations/NNN_*.sql`(001~059)을 **제자리에서 순서대로 적용**(복사·편집 없이 경로 참조). sqlx migrator 또는 파일 정렬 후 실행 — 어느 쪽이든 파일 내용 불변. `schema_v0.sql`은 001과 중복 스냅샷이니 러너 대상 아님(참고만).
- `audit_log` write 헬퍼 스텁(시그니처만).
- **하지 마라**: 실제 도메인 쿼리 작성(B1+). 새 마이그레이션 추가(없음).

### 2-2. `momo-outbox` — 단일 쓰기경로 chokepoint (불변식 #3)
- **`emit_outbox(tx, kind, method, payload, partition_key)`** — `outbox` 테이블에 INSERT하는 **유일한 함수**. 이 crate만 `outbox` SQL 문자열을 소유한다(다른 crate에서 raw `INSERT INTO outbox` 금지 = 구조적 강제). 참조: 현 Swift는 이게 18개 파일에 산재(`MessageRoutes.swift:257` 등) — 우리는 여기 하나로 모은다.
- relay 소비자 스켈레톤: `claim_batch`(‌`SELECT ... FOR UPDATE SKIP LOCKED`로 pending→processing) 시그니처 + 골격. 참조 `relay/OutboxRelay/Sources/OutboxRelay/RelayService.swift`.
- `pg_notify('outbox', kind)`는 DB 트리거(`001_init.sql:432`)가 하므로 앱 코드 불요 — 주석으로만 명시.

### 2-3. `momo-wire` — 공유 계약 (서명·페이로드)
- **workd 서명 포맷 문자열 빌더**를 Swift와 **바이트 동일**하게 이식:
  - heartbeat `"momo.work_host.heartbeat.v1\n{ws}\n{host}\n{sentAtMs}"`, request `"momo.work_host.request.v2\n{METHOD}\n{path}\n{ws}\n{host}\n{sentAtMs}\n{bodyDigest(sha256hex)}\n{requestID}"`. 참조 `workers/WorkHostDaemon/Sources/WorkHostDaemon/Signing.swift:26-64` ↔ 서버 검증 `server/Sources/MomoServer/Auth/WorkHostAuthenticator.swift:138-149`. **두 소스가 동일 포맷** — 우리는 그걸 이 crate 하나로 통합(복제 제거).
- Ed25519 `sign(payload)`/`verify(pubkey, payload, sig)` 헬퍼(ed25519-dalek 등).
- outbox payload·agent_job payload를 Rust 타입(struct)으로. 참조 `workers/AgentWorker/.../AgentJobPayload.swift`.
- **provenance API 스켈레톤(ADR-0146)**: `record_provenance(tx, entity_ref, signer_pubkey, signature)` **시그니처만** + 서명 페이로드 포맷 placeholder. **DB 테이블(`action_signature`)·마이그레이션은 만들지 마라** — ADR-0146이 아직 Proposed(성재 Accept 전)라 스키마 변경 금지. 함수 본문은 `todo!()`/`unimplemented!()`로 자리만.

### 2-4. `momo-auth` — 인증 파운데이션
- JWT(HS256) 검증 스켈레톤 + `Principal` 구조체(memberID/tokenID/workspaceID). 참조 `server/Sources/MomoServer/Auth/`(AuthMiddleware·JWT·TokenStore).
- WorkHost 서명 검증 함수 — `momo-wire`의 포맷·verify 사용.

### 2-5. `momo-provider` — 어댑터 계약 (이미 검증된 공유 경계)
- `CloudProviderAdapter` trait: `create(spec, idempotency_key)`·`pause(ref, key)`·`resume(ref, key)`·`destroy(ref, key)`(멱등)·`probe(ref)`(존재/부재/불명 구분). 참조 `services/CloudProviderKit/`(Swift 계약 이식).
- capability 선언 타입(`supports_pause`·`resume_semantics{Memory|ColdBoot}`·`continuous_runtime_limit`). **정책 코드가 provider 상수를 직접 알면 안 됨 — capability 경유**(현 계약 원칙 보존).
- 실제 provider·mock 구현은 B2 — B0는 trait+타입만.

## 3. 하지 말 것
- 도메인 crate(messaging·t3·integrations)·바이너리(server·relay·notifier·workd·agent-worker) 실구현 — B1+.
- 새 DB 마이그레이션·`action_signature` 테이블(ADR-0146 Accept 전) — 스키마 변경 금지.
- `server/Migrations/**`·`schema_v0.sql`·기존 Swift 코드 수정. (B0는 순수 신규 `server-rust/`만.)
- 컴파일타임 `query!` 매크로(live DB 의존) — 런타임 `query` 사용.

## 4. 검증 (worker 몫)
- `cd server-rust && cargo check --workspace` green + `cargo test --workspace`(DB 불요 단위) green + `cargo fmt --check`·`cargo clippy`(경고 정리).
- **구조 단정**: `grep -rn "INSERT INTO outbox" server-rust/crates` 결과가 `momo-outbox` 밖에서 0건임을 PR 본문에 첨부(불변식 #3 구조적 강제 증거).
- workd 서명 포맷 문자열이 Swift와 바이트 동일함을 단위 테스트로(고정 입력 → 기대 문자열).
- **오케스트레이터 실행 목록(PR 본문에 명시)**: ①마이그레이션 러너가 fresh PG에 001~059 순서 적용 → Swift 부트스트랩 스키마와 일치 ②`with_tenant_tx`가 `app.workspace_id` GUC 세팅 후 cross-tenant SELECT→0행(D2 #6 red).

## 5. PR
`feat/B0-rust-skeleton` → `track/engine`. 본문: 워크스페이스 구조, crate별 요약, outbox chokepoint grep 증거, 서명 포맷 바이트동일 테스트, provenance는 API 스켈레톤(테이블 없음·ADR-0146 Accept 대기) 명시, 오케스트레이터 검증 목록, 계획 이탈(있으면 근거와 함께). **PR 후 STOP.**
