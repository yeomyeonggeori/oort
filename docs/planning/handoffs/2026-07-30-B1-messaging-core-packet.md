# goal B1 — 메신저 코어 write-path 척추 (`momo-messaging`, ADR-0145 B안)

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 유일한 지시서. 계약 `AGENTS.md`.
**base = `track/engine`**(B0 랜딩 `d1e51ddf` 이후 — `server-rust/` 공유 5 crate 존재). 워크트리: `~/projects/momo-tracks/momo-worktrees/B1-messaging`(브랜치 `feat/B1-messaging`, 생성됨).
근거 정본(작업 전 정독): `docs/architecture/server-rust.md`(D1) · `docs/architecture/invariants-in-rust.md`(D2, 이 배치의 수용 계약) · `docs/planning/2026-07-30-rewrite-batch-breakdown.md`(§B1).

## 0. 착수 전 필수
1. `git status` clean. 2. **`.env`류·자격증명 열람 금지**(이름조차 출력 금지). 3. **PR 후 STOP**, push된 커밋 amend/force-push 금지(새 커밋). 4. **docker 검증은 오케스트레이터 몫** — 너는 `cargo check/test/clippy/fmt`(DB 불요 단위)까지. 실 PG conformance는 오케스트레이터가 돌린다(테스트는 네가 작성, `#[ignore]`). 5. 참조 Swift 심볼·경로는 열기 전 grep 실재 확인. 6. **기존 파일 수정·이동 금지**: `server/**`·`schema_v0.sql`·B0 공유 crate 내부(=API로만 소비). 새 마이그레이션 금지.

## 1. 전제 (B0에서 랜딩됨 — 재사용, 재발명 금지)
- 공유 crate 존재: `momo-db`(**`with_tenant_tx` = RLS GUC 유일 배선**, 마이그레이션 러너=**psql 경유 정본**, `sqlx::raw_sql` 금지) · `momo-outbox`(**`emit_outbox` = outbox INSERT 유일 소유**) · `momo-wire` · `momo-auth` · `momo-provider`. 이들의 공개 API만 쓴다.
- **provenance 서명은 이 배치 아님**(ADR-0146 Accept 대기 — ⓑ 결정). `record_provenance` 호출·`action_signature` 테이블 만들지 마라.
- 런타임 `sqlx::query`(컴파일타임 `query!` 금지 — live DB 없이 빌드).

## 2. 할 일 — `momo-messaging` 도메인 crate (write-path 척추)
`server-rust/crates/momo-messaging/` 신설. **이 배치 범위 = 메시지 쓰기경로의 척추 + 그것이 요구하는 최소 identity/channel + DB conformance.** 화려함보다 불변식.

### 2-1. identity (최소)
- member(사람+에이전트 동일 테이블, `kind` 분기) 조회, workspace, channel_member 멤버십 확인. 참조 스키마 `server/Migrations/001_init.sql`(member·workspace·channel_member), Swift `RosterRoutes`/`MemberLifecycleRoutes`는 형태 참고만.

### 2-2. channel (최소)
- 채널 생성·조회 + channel_member. thread는 message가 참조하는 정도(rollup 최소).

### 2-3. message 쓰기경로 (핵심)
- `send_message` — **`with_tenant_tx` 안에서**: `channel_seq` **row-lock** `UPDATE...RETURNING`로 seq 부여 → `message` insert(seq 포함) → `emit_outbox(Broadcast, ..., partition_key=channel_id)` **같은 tx** → 멱등 `ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING` 후 기존 row 재조회. 참조: Swift `MessageRoutes.swift:123-282`(척추 SQL은 survey에 인용됨). **파리티**: seq·멱등·outbox payload 형태를 Swift와 맞춘다.
- `list_messages` — 채널별 `seq` 오름차순.

### 2-4. DB conformance 테스트 (D2 수용 계약 — `#[ignore]`, DATABASE_URL)
B0의 `momo-db/tests/conformance_pg.rs` 패턴을 따라 `momo-messaging/tests/conformance_pg.rs` 작성. 마이그레이션 러너(psql)로 스키마 + `infra/e2e/bootstrap_roles.sql`로 롤 세팅 후, **되돌리면 실패하는 이름 있는 단정**으로:
- **#4 gapless seq**: 한 채널에 동시 N 전송 → seq 1..N 연속, gap·중복 0(`message_seq_uniq` 백스톱). row-lock을 비직렬 방식으로 바꾸면 red.
- **#3 단일 쓰기경로 원자성**: 전송 tx를 message insert 후·commit 전 강제 실패 → message·outbox row **둘 다 부재**(롤백). outbox를 별 tx로 빼면 red.
- **#1 PG=SoT**: 전송 후 message가 PG에 + outbox broadcast row 존재.
- **#5 에이전트=member**: `kind='agent'` member가 동일 경로로 전송 → 동일 seq/outbox 경로.
- **#6 RLS 격리**: **momo_app 롤로**(NOBYPASSRLS) 워크스페이스 2개 시드 → A 세션에서 B의 message SELECT → **0행**. GUC 안 세팅하거나 시드 누출 시 red.
- (#2·#7은 이 배치 밖 — relay·provider. 언급만.)

## 3. 하지 말 것
- **provenance 서명**(ADR-0146) — 표면·호출·테이블 전부. ⓑ 결정으로 B1 제외.
- **HTTP/Axum route·`momo-server` 바이너리** — 이 배치는 도메인 crate + conformance. route 표면·server 조립은 별도(B1.2/assembly). (단 crate API는 route가 얹기 쉽게 설계.)
- **huddle·search/memory·DM·read-state 전체·mention 전체 의미** — 척추 후속(B1.2). 이 배치는 채널 메시지 쓰기/읽기 척추만.
- 새 마이그레이션·스키마 변경. B0 공유 crate 내부 수정(API로만).

## 4. 검증
- worker: `cd server-rust && cargo check --workspace --all-targets` + `cargo test --workspace`(DB 불요 단위) + `cargo fmt --check` + `cargo clippy --workspace --all-targets -- -D warnings`.
- **오케스트레이터 실행 목록(PR 본문)**: conformance_pg의 D2 red #1/#3/#4/#5/#6 — pgvector/pg18 fresh DB + bootstrap_roles + momo_app 롤로 cross-tenant. (psql·docker 필요.)
- 구조 단정: outbox INSERT는 여전히 `momo-outbox`에만(grep 0건 밖), Centrifugo publish 호출은 `momo-messaging`에 0건(=#2 전송전용, relay 몫).

## 5. PR
`feat/B1-messaging` → `track/engine`. 본문: crate 구조, write-path 척추 설계(seq·emit_outbox·멱등 파리티), conformance red 절차(각 단정이 되돌리면 어떻게 빨개지는지), 구조 grep 증거, 범위 밖 명시(provenance·HTTP·huddle/search), 계획 이탈. **PR 후 STOP.**
