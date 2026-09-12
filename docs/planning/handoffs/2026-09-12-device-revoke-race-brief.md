# 연결 기기 refresh/revoke 경합 수리

- status: ready
- planning ID: PLN-20260912-ASTRA-01
- owner/integrator: Astra (이번 배치); 기존 Fable PR 통합은 별도 인계 확인
- base: track/engine @ ed26b020
- supersedes: 없음
- worker: PIPELINE worker 레인, 사용자 지시대로 native Codex Grok 4.6
- GitHub binding: 발급 후 추가

## Goal / 결정
ADR-0180의 연결 기기 즉시 해제 계약을 보존한다. DELETE 성공 뒤 겹친 refresh가 살아 있는 새 토큰을 남기지 않아야 한다. 공개 API, 스키마, 보안 정책의 새 설계가 아니라 기존 계약의 원자성 결함 수리다.

## 파일 맵 / red proof
- `server-rust/bins/momo-server/src/routes/auth_routes.rs`: refresh가 기존 토큰을 소비한 tx를 commit한 뒤 `issue_and_record_device_session`의 별도 tx에서 새 토큰 발급·기기 rebind.
- `server-rust/crates/momo-auth/src/device_link.rs`: `owned_linked_device_pair`가 잠금 없이 이전 pair를 읽음. revoke는 관측한 pair만 폐기하며 rebind는 매칭 실패를 no-op 처리.
- `server-rust/crates/momo-auth/src/token_store.rs`: 토큰 폐기/발급 SQL.
- `server-rust/bins/momo-server/tests/linked_devices_conformance_pg.rs`: 기존 순차 refresh/revoke 시험.
- 마이그레이션 86개를 적용한 PG18, NOBYPASSRLS + tenant RLS에서 planner가 refresh 소비 commit → DELETE → 발급/rebind를 재현: DELETE flipped=1, 이후 live token=2, live pair rebind=true. SQL 증거는 planner 감사 산출물에 있다. 아직 HTTP 경쟁조건 시험은 아니다.

## Acceptance (정본)
1. refresh의 검증·기존 refresh 소비·새 pair 발급·기기 rebind가 하나의 tx에서 성공하거나 전부 rollback한다.
2. refresh와 revoke 모두 같은 안정적인 연결 기기 행을 일관된 순서로 잠그고, 잠금 후 현재 binding을 재확인한다. tx 합치기만으로 stale revoke read가 해결됐다고 판단하지 않는다.
3. 해제되거나 바뀐 binding의 새 토큰 발급을 허용하지 않는다. linked-device rebind 불일치는 no-op 성공 대신 rollback한다. 연결 기기가 아닌 일반 로그인 refresh는 보존한다.
4. 실제 PG + 서버 경로에서 제어 가능한 barrier/DB lock으로 두 경합 순서(refresh 선행, revoke 선행)를 검증한다. DELETE 성공 이후 새 access/refresh 둘 다 사용할 수 없어야 한다. 동시 중복 refresh와 중간 실패 rollback도 검증한다. sleep만으로 순서를 추측하지 않는다.
5. 현재 기기 해제 방지, 다른 사용자/테넌트 404, scope, SAS, RLS, 일반 refresh의 기존 동작을 보존한다. schema_v0.sql 및 공개 API 변경 금지.
6. Rust 전체 fmt/clippy/test와 PG conformance를 실제 실행하고, 결함을 스크래치 사본에 되돌리면 시험이 붉어지는 증거를 남긴다. DB 없는 skip을 runtime PASS라 쓰지 않는다.

## 범위 / 규율
허용: 위 Rust 파일, 직접 관련 auth 호출자/시험, 이 패킷의 metadata, STATUS 상단 1~3줄. 새 SQL migration/스키마 계약이 꼭 필요하면 먼저 설계 이탈을 보고한다. scripts/**, .github/**, schema_v0.sql, 웹/모바일/어댑터는 변경 금지. 로그아웃·비밀번호 변경의 별도 개선과 광범위 리팩터링은 후속으로 분리.

기존 작업을 덮어쓰지 않는다. 구현은 발급된 이슈의 engine worktree에서만. 공유 .env/기존 DB/컨테이너 사용 금지. 필요한 PG18은 별도 이름·포트·임시 자격증명으로 만들고 자신이 만든 리소스만 정리한다. 큰 게이트 실행 전 Astra와 슬롯을 조율한다. 외부 MCP·배포·release 실행 금지. 로컬 파일/셸 도구와 gh 구현 워크플로는 허용.

## 착수 / 완료
AGENTS.md → docs/TRACKS.md(엔진 선언) → 이 패킷 → Issue → STATUS/ROADMAP/BUILD_TICKETS를 읽고 최신 origin/main 포함 여부를 확인한다. base가 이미 main을 포함하면 불필요한 merge는 하지 않는다.

검증: cargo fmt --all --check --manifest-path server-rust/Cargo.toml; cargo clippy --manifest-path server-rust/Cargo.toml --workspace --all-targets -- -D warnings; cargo test --manifest-path server-rust/Cargo.toml --workspace. PG 시험은 기존 conformance 실행 계약을 확인해 별도 DB에서 실행한다. 문서 접촉은 local_gate docs가 필요하며, Railway inherited 실패는 병렬 수리 의존으로 기록한다.

커밋·정렬 preflight·push·track/engine 대상 1 Issue=1 PR·goal_release --review 후 정지. merge/issue close 금지. DONE / COMMITS / GATES / PR / NOTES(계획 이탈)로 보고하며 수정 파일 목록 포함.

## 컨텍스트 델타 / 절차 이탈
2026-09-12 사용자 지시: Astra 기획·검수, Grok 4.6 구현. Railway 기존 docs gate 실패로 패킷 선행 canonical 랜딩이 순환 의존이므로 이 패킷을 전용 브랜치에서 먼저 고정하고 수리 PR과 함께 제출한다. 기존 Fable 소유 PR은 이 작업이 인수하지 않는다.
