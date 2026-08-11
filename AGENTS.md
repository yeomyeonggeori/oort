# AGENTS.md — oort (Codex 자율작업 운영 계약)

> 이 파일은 코딩 에이전트(특히 **OpenAI Codex**)가 이 리포에서 자율 실행할 때 따르는 **단일 운영 계약**이다.
> 제품 이름은 **oort**, 레포 이름은 아직 **momo**다(작업명 유래 — README 각주). 두 이름이 섞여 있으면 오타가 아니라 이 사정이다.
> Codex는 세션 시작 시 git root → 현재 디렉터리까지 `AGENTS.md`를 root→leaf 순으로 머지한다(leaf override). 이 파일이 root 계약이다.
> **핵심 내용은 `CODEX.md`와 동일**(CODEX.md = 사람·도구가 직접 읽는 풀 가이드). 둘이 어긋나면 이 `AGENTS.md`가 우선.
> 사람용 장문 배경은 `STATUS.md`/`ROADMAP.md`/`BUILD_TICKETS.md`/`research/07-deepdive/04·05`에. 여기엔 **에이전트가 추론으로 못 얻는 것만** 적는다.
>
> **실행 주체:** 기획은 성재(최종 승인)+Fable/GPT 5.6(병렬 planner), 공용 정본 통합은 `momo-main`(계약: `docs/planning/README.md`), **실제 구현은 Codex가 goal(=GitHub Issue)로 자율 실행**. **지금 세션이 기획/오케스트레이션이면 `scripts/planning_context.sh` → `docs/planning/CURRENT_STATE.md`부터 읽어라.** 동시 구현은 최대 **5 goal**(`docs/MULTI_SESSION_OPS.md`).
> **현재 위치(2026-08):** 서버는 **Rust/Axum**(`server-rust/`, ADR-0145)으로 재작성돼 `app.oor7.com`에서 돌고 있고(런북 `docs/runbooks/ncp-rust-deploy.md`), 제품 표면은 **웹 + Tauri 데스크톱 + React Native 모바일**이다. **Swift 트리는 은퇴 중**(§0 아래 상자) — 그쪽에 새 기능을 얹지 마라. 최신 상태는 항상 `STATUS.md` 최상단이 정본이고, 이 문단은 방향만 가리킨다.
> **표기:** `(검증됨)`=교차확인 · `(추정)`=설계/일정 판단 · `runtime-unverified`=해당 goal에서 아직 e2e를 못 닫은 것. **법무 텍스트는 법률 자문 아님.**

## -1. 트랙 파이프라인 (2026-07-18 성재 지시 — 최우선 규칙)

**작업 시작 전 반드시 `docs/TRACKS.md`를 읽고 자기 트랙(UXUI | 엔진)을 선언하라.** 요약:
1. 작업은 UXUI 트랙(제품 표면 — `clients/web`·`clients/desktop`·`clients/mobile`)과 엔진 트랙(`server-rust`·`server/Migrations`·`infra`·`scripts`·어댑터)으로 이원화. **소유 파일군 표의 정본은 `docs/TRACKS.md`**이며 두 트랙이 함께 만지는 트리(`clients/web`·`packages/momo-core`)의 규율도 거기 있다.
2. 구현은 항상 워크트리에서(트랙 워크트리: `~/projects/momo-tracks/{uxui,engine}` — 메인테이너 로컬 관례이며 경로는 각자 환경에 맞춘다. 브랜치는 `track/uxui`·`track/engine`). 루트(main 체크아웃)에서 구현 금지.
3. 성재에게 보여주는 빌드는 **자기 트랙 워크트리에서** 만든다 — "빌드 원본: <경로> <브랜치>@<sha>" 고지. main 빌드로 보여주기 금지.
4. PR/머지 대상은 main이 아니라 **자기 트랙 브랜치**. **track/* → main 머지는 성재의 명시 승인이 있을 때만**(묻고 승인받거나, 성재가 먼저 지시할 때).
5. 엔진 랜딩 후에는 `docs/planning/ENGINE_HANDOFF.md`에 ready 항목 추가. UXUI는 세션 시작 시 그 파일을 읽고 성재에게 "이거 구현할까요?" 제안.

## 0. 제품 1줄
oort = AI 에이전트가 사람과 **동등한 1급 멤버**(`member.kind='agent'`)로 참여하는 자체구축 슬랙형 메신저. 서버는 **Rust/Axum**(`server-rust/`, ADR-0145) + **Centrifugo v6** + **PostgreSQL 18**, 제품 표면은 **웹(React/Vite `clients/web`) · 데스크톱(Tauri 2 `clients/desktop` — 같은 웹 번들을 감싼다) · 모바일(React Native `clients/mobile`)**이고 공유 도메인 코어는 TypeScript `packages/momo-core`다(ADR-0119/0133/0137). 에이전트 게이트웨이 = 김인턴/hermes(OpenAI 호환 `/v1/chat/completions` + SSE). 전 의존성 permissive 타깃.

> ### ⚠️ Swift 트리는 은퇴 중 — 여기에 새로 짓지 마라
> `clients/macOS`·`clients/iOS`·`clients/Core`는 **삭제됐다**(W-S1 / #1215 — 이식 원본은 git 이력에 있다). `server/Sources`(Hummingbird 2), `relay/OutboxRelay`, `workers/*`, `services/*`는 **아직 레포에 있지만 삭제 대기**다. 문서가 `swift build`를 시키더라도 그것은 현행 제품을 짓는 명령이 아니다 — 그 경로는 **실패하지 않고 잘못된 것을 성공적으로 짓는다**.
> **은퇴 아님(계속 살아 있는 것):** ① `server/Migrations/*.sql` — Rust 이미지가 그대로 싣는 **정본 DDL**. ② `relay/PushRelay` — 라이브 푸시 경로가 지금도 빌드·배포하는 Swift 컴포넌트(`infra/rust/docker-compose.push.build.yml`). ③ `clients/web-legacy` — UI 개발은 `clients/web`로 옮겨 갔지만 **알파가 실제로 서빙하는 산출물**은 아직 이쪽이다(`infra/prod/Dockerfile.web`, ADR-0133 parity 게이트 전까지).

**핵심 쓰기경로(절대 깨지 말 것):** `REST send → (channel_seq bump + message INSERT + outbox INSERT) 단일 tx → momo-relay가 Centrifugo /api/publish`. 클라는 절대 Centrifugo로 직접 publish 안 함. Postgres=SoT, Centrifugo=전송계층. 순서 SoT=`message.seq`.

## 1. 작업을 받는 법 (goal = 이슈)
- **하나의 GitHub Issue = 하나의 goal.** 이슈 본문이 작업 프롬프트. `## Goal / ## Context / ## Acceptance / ## Out of scope`가 있으면 그것이 계약.
- **이슈 Context에 핸드오프 패킷(`docs/planning/handoffs/*.md`)이 링크돼 있으면 반드시 먼저 읽는다** — 파일 맵, 지켜야 할 계약, 함정, 머지 순서가 거기 있다. 패킷과 실제 코드가 다르면 코드가 진실이되, **계약 수준이 다르면 멈추고 이탈 보고**.
- 다음에 집을 티켓 선택법은 §6. 임의로 스코프를 늘리지 말 것 — 이슈에 없는 것은 새 이슈로 제안.
- 1 이슈 = 1 PR. 여러 이슈를 한 PR에 섞지 않는다.

### 1.1 표준 작업 루프
1. 모든 작업은 **Issue + Milestone + Project** 기준으로 시작한다. 필요하면 이슈/마일스톤/프로젝트 상태를 먼저 정리한다.
2. 이슈를 claim한 뒤 가능하면 worktree에서 진행한다. 시작 전 `scripts/goal_status.sh`로 충돌을 확인하고, `scripts/goal_claim.sh <issue>`로 branch/worktree/assignee/status lock을 잡는다. 스크립트가 없는 checkout에서는 수동으로 별도 branch/worktree를 만든다.
3. 작업 전 `STATUS.md` → `ROADMAP.md` → `BUILD_TICKETS.md` → 이슈 본문 순으로 계획을 확인한다. 계획이 미흡하면 추가 리서치를 하고, 계획이 충분하면 현재 사실을 한 번 더 검증한다.
4. 구현은 이슈 범위에 맞춘다. 범위가 커지면 새 이슈로 제안한다.
5. 구현 후 해당 검증 등급의 테스트를 실행한다. `pr-ci`는 세 canonical branch PR의 보조 게이트이고, runtime 범위는 `scripts/local_gate.sh --profile ...`가 정본이다. 서버 변경은 `cargo fmt --check`/`clippy -D warnings`/`cargo test --workspace`, 웹·폰·코어 변경은 해당 트리 게이트 + `scripts/verify_merge_tree.sh`를 하드 게이트로 본다.
6. worker는 커밋하고 push한 뒤 PR을 연다. PR은 해당 이슈 하나만 닫고, PR 본문에 local gate evidence를 붙인다.
7. worker는 `scripts/goal_release.sh <issue> --review --pr <PR URL>`로 이슈를 `status:needs-review`로 전환하고 `momo-main`에 handoff한 뒤 멈춘다.
8. **merge/close/main gate/로드맵 조정은 `momo-main`만 수행한다.** worker는 PR 생성 후 임의 merge, 이슈 close, main 재검증, 로드맵/백로그 재배열을 하지 않는다.
9. `momo-main`은 코드리뷰 에이전트 또는 리뷰 스킬로 보안·코드 품질·회귀 위험을 점검하고, 필요한 수정만 worker 또는 같은 이슈 worktree에 위임한다.
10. `momo-main`은 리뷰 반영 후 최종 local gate를 다시 실행하고 현재 PR head의 `PR CI gate`와 `Policy integrity gate`를 모두 확인한다(ADR-0153 D5). 머지 직전에는 **현재 PR의 exact canonical base branch/HEAD에서 wrapper bytes가 그 base와 일치하는 checkout**으로 `scripts/verify_policy_integrity_from_base.sh --repo yeomyeonggeori/oort --pr <PR>`를 실행해 exact base commit에서 추출한 verifier로 status/run provenance와 현재 정책 증거를 재검증한다. worktree/candidate verifier bytes는 무시하고 실행하지 않으며, 같은 Actions App/context만 믿지 않는다. local evidence가 DB·Docker·외부 provider runtime의 primary merge evidence다. release/유료 macOS workflow는 owner/M7 정책을 그대로 지킨다.
11. 최종 보고에는 이번 작업 결과, 검증, 로드맵 영향, 새로 알게 된 리스크/자료, 다음 goal 추천을 포함한다.

## 2. 리포 맵 (디렉터리 → 책임)

**현행 스택 — 여기서 짓는다:**
```
server-rust/             Rust/Axum 워크스페이스(ADR-0145). bins/{momo-server,momo-relay,
                         momo-agent-worker,momo-notifier,momo-migrate} + crates/momo-*
                         (messaging=쓰기경로 척추 · outbox · auth · db · agent · provider · push · t3 · wire …)
server/Migrations/       **정본 DDL**(00N_*.sql). Rust 이미지가 그대로 싣는다 — 은퇴 아님
schema_v0.sql            정본 스키마(PostgreSQL 18, uuidv7() PK, RLS FORCE) — 읽기 전용, 이동/수정 금지
packages/momo-core/      @momo/core — 웹·모바일이 공유하는 TS 도메인 코어(레포 루트 npm 워크스페이스)
clients/web/             React/Vite SPA — 제품 웹 표면이자 데스크톱이 감싸는 번들
clients/desktop/         Tauri 2 셸(딥링크·mDNS·알림·키체인·업데이터). UI를 포크하지 않는다
clients/mobile/          React Native 앱(현재 iOS)
clients/web-legacy/      ADR-0119 v0 웹 — **알파가 실제로 서빙하는 산출물**(parity 게이트 전까지)
adapters/hermes/         momo_adapter.py(BasePlatformAdapter) + plugin.yaml (py3)
adapters/prime/          prime-agent 어댑터(하네스 refine·스트림 릴레이)
infra/rust/              **라이브 배포 경로** — Rust 이미지 compose + Caddyfile(정본) + 푸시/폰 오버레이
infra/                   dev docker-compose(PG18+Centrifugo v6) · e2e compose · centrifugo.json · .env.example
scripts/                 local_gate.sh · verify_*.sh · verify_merge_tree.sh · goal_claim/status/release.sh · migrate.sh
docs/                    INDEX.md(문서 지도) · adr/(결정 정본) · architecture/overview.md · api/openapi.yaml · runbooks/
legal/                   privacy-policy · agent-disclosure · THIRD_PARTY_NOTICES (법률 자문 아님)
.github/                 ISSUE_TEMPLATE/ · workflows/(pr-ci + track-alignment 자동, release는 owner/M7 게이트)
```

**은퇴 중 — 삭제 대기(§0 상자). 읽어서 이해하는 용도이지 확장 대상이 아니다:**
```
server/Sources/          MomoServer(Hummingbird 2) — Rust 재작성으로 대체됨
relay/OutboxRelay/       outbox SKIP LOCKED 폴링 → Centrifugo publish (BYPASSRLS)
relay/PushRelay/         ※ 예외: 라이브 푸시 경로가 지금도 빌드·배포한다(은퇴 아님)
workers/·services/       AgentWorker·WorkHostDaemon·NotifierWorker·LinkShort 등 Swift 실행체
infra/prod/              Swift prod compose 계열
(삭제됨 — W-S1/#1215) clients/{Core,macOS,iOS}/ · fastlane/ · .github/workflows/{ci-build,release-ios,release-macos}.yml
```
**BYPASSRLS:** relay·agent-worker(`momo-relay`·`momo-agent-worker`)만(전 테넌트 폴링). **쓰기 경로엔 BYPASSRLS 금지**. 그 외 모든 경로는 `SET LOCAL app.workspace_id` + RLS FORCE.

## 3. 빌드 / 검증 명령 (copy-paste, 그대로 실행)
> 로컬 툴체인: **cargo(rustup) · Node 20+ · Docker Desktop + psql 있음**, hermes 없음. PG18+Centrifugo 런타임은 검증 가능하고, hermes 필요 경로는 실제 hermes 또는 mock OpenAI-compatible gateway를 준비한다.
> npm 트리는 lockfile이 셋이다 — 루트(`packages/*`), `clients/web`, `clients/mobile`. 셋 다 설치돼야 `make ts-check`가 돈다.

```bash
# 서버 (Rust/Axum) — 이 셋이 서버 변경의 하드 게이트
cargo fmt --check --manifest-path server-rust/Cargo.toml
cargo clippy --manifest-path server-rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test  --manifest-path server-rust/Cargo.toml --workspace
make rust-build                      # = cargo build --workspace

# 웹 / 모바일 / 공유 코어 (TypeScript)
npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci
make ts-check                        # momo-core + web + mobile typecheck
make ts-test                         # 동일 트리 테스트
make build                           # = rust-build + ts-check (현행 스택 전부)
make test                            # = rust-test  + ts-test

# 병합 결과 검증 — 브랜치가 아니라 "머지된 트리"를 잰다(#1108). 웹·폰·코어 크로스
scripts/verify_merge_tree.sh                       # 기본 base=origin/track/engine

# 게이트 (PR CI는 보조, runtime local evidence가 정본)
scripts/local_gate.sh --profile docs               # 문서/정적 — 문서만 건드려도 이건 돌린다
scripts/local_gate.sh --profile web                # 웹 클라 게이트(설치·lint·vitest·tsc·빌드·라이선스)
scripts/local_gate.sh --profile runtime-db
scripts/local_gate.sh --profile runtime-agent

# 어댑터(py) / 워크플로 정적 검증
python3 -m py_compile adapters/hermes/momo_adapter.py adapters/prime/adapter.py
actionlint .github/workflows/*.yml

# 런타임 — Rust 이미지 스택(라이브와 같은 형상). 절차 정본: infra/rust/README.md
cp infra/.env.example .env && make up && make migrate

# [은퇴 중] Swift 트리를 굳이 돌려야 할 때만. 새 작업의 게이트가 아니다.
make swift-build ; make swift-test
```

**검증 등급(이슈마다 명시):**
- `[rust]` = `cargo fmt --check` + `cargo clippy … -D warnings` + `cargo test --workspace` 전부 green.
- `[web]`/`[mobile]` = 해당 트리 `typecheck` + `test` green, 그리고 **병합 트리**(`verify_merge_tree.sh`)가 green. 브랜치 초록만으로는 부족하다 — 그게 U4-6 B1에서 실제로 깨진 자리다.
- `[infra]`/`[sql]` = 파일 존재 + `schema_v0.sql`(정본) 정합. Docker/psql로 적용 가능한 범위는 runtime 검증한다.
- `[python]` = `python3 -m py_compile` 통과. `[ci]` = actionlint 통과 + (게이트 전) dry-run.
- `[runtime]` = Docker/psql로 가능한 검증은 수행한다. hermes 등 외부 의존이 필요하면 실제 의존성 또는 mock을 먼저 준비하고, 그래도 못 닫는 범위만 좁게 `runtime-unverified` 표기 + 절차 문서화.
- `[manual]` = 사람 1회(발급/계약/심사). Codex는 런북/파일만 준비하고 위임 표시.
- `[swift]`(은퇴 중) = 삭제 대기 트리를 불가피하게 건드릴 때만. 새 goal의 수용기준으로 쓰지 마라.

## 4. Definition of Done (모든 이슈 공통 — 못 채우면 닫지 마라)
1. **해당 등급 검증 통과**(§3). 서버 이슈는 `cargo test --workspace` + `clippy -D warnings` green이 **하드 게이트**, 웹·폰·코어 이슈는 자기 트리 게이트 **+ 병합 트리** green이 하드 게이트.
2. **선행 티켓을 깨지 않음**: 인접 crate/워크스페이스가 여전히 green이고, 웹·폰·코어를 함께 건드렸다면 `scripts/verify_merge_tree.sh`가 green.
3. **정본 정합**: DDL/모델은 `schema_v0.sql`과 컬럼·타입 일치(`member.kind`, `channel_seq`, `uuidv7()` PK, `hlc_ts`/`hlc_count`, `client_msg_id` 멱등). 정본 **이동/수정 금지** — 확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY에 신규 테이블 등록.
4. **runtime 미검증은 정직 표기**: 파일/주석/STATUS에 `runtime-unverified`. 검증 못 한 걸 "검증됨"이라 쓰지 마라.
5. **STATUS.md 갱신**: 무엇을 추가/변경, 무엇이 여전히 미검증인지 1~3줄. 재설계 티켓(MOMO-300~323)은 `research/13-redesign/00-execution-tracker.md` 상태도 함께 갱신.
6. **PR 본문**이 §5 형식.
7. 미완성 스텁은 `// TODO(#이슈번호): 설명` 형태로만(컴파일 항상 보장).
8. **게이트/배포 불변식 준수**: 사용성 검수 게이트(M7) PASS 기록 없이 스토어/공증 배포(M8)·external TestFlight 진행 금지(§7).
9. **결정 거버넌스(ADR-0100)**: 공개 API 표면·보안 경계(시크릿/토큰/스코프/RLS)·DB 스키마 계약·제품 방향·기술스택을 바꾸는 변경은 **Accepted 상태의 ADR**(`docs/adr/`) 참조 없이 머지 금지. 결정은 ADR, 증거는 STATUS, 계획은 ROADMAP — STATUS.md에 결정 서술을 새로 쓰지 마라. 핫픽스로 경계를 건드렸으면 24h 내 소급 ADR 기안.
10. **계획 이탈 보고**: 구현이 수용기준·ADR·핸드오프 패킷과 달라진 모든 지점(스코프 축소, 우회, 발견된 설계 결함 포함)을 PR `## 계획 이탈` 섹션에 정직하게 기록한다(없으면 "없음"). 설계 판단이 필요하면 임의 재설계 대신 `scripts/goal_release.sh <issue> --blocked`로 멈춘다. 이 보고는 `docs/planning/DEVIATION_LOG.md` 환류 파이프라인의 입력이다.

## 5. 컨벤션 (브랜치 / 커밋 / PR)
- **브랜치(org `yeomyeonggeori`/repo `oort`):** `feat/<issue#>-<slug>` · `fix/…` · `chore/…` · `docs/…`. SPINE 티켓 id면 `feat/MOMO-NNN-<slug>`도 허용. **main 직접 push 금지**(브랜치 보호 가정).
- **커밋:** Conventional Commits — `feat(server): channel_seq 발급 트랜잭션 (#NN)`. 타입/스코프는 영문, 본문 한국어 OK.
- **PR:** 1 PR = 1 이슈. 머지 전 §3의 해당 등급 게이트 green 필수. PR 본문 템플릿:
```
Closes #<issue>

## 한 일
- (변경 요약 bullet)

## 검증 (등급: [rust]/[web]/[mobile]/[infra]/[sql]/[python]/[ci]/[runtime]/[manual])
- [ ] 해당 등급 게이트 green: <명령 + 결과>
- [ ] 인접 트리 안 깨짐 (웹·폰·코어 동시 변경이면 verify_merge_tree.sh green)
- [ ] schema_v0.sql 정합
- [ ] runtime 미검증 부분 표기

## STATUS 영향
- (STATUS.md에 반영한 줄)

## 남은 것 / 후속 이슈 제안
- (스코프 밖이라 새 이슈로 뺀 것)

## Worker handoff
- [ ] worker는 PR 생성 후 `status:needs-review`로 넘기고 merge하지 않음
- [ ] merge/close/main gate/로드맵 조정은 `momo-main`만 수행
```
- **절대 하지 말 것:** 시크릿 커밋(`.env`, `.env.worktree`), `schema_v0.sql` 수정/이동, `.build/`·`*.resolved`·`DerivedData/`·`.swiftpm/` 커밋, 무관한 리팩터, 의존성 메이저 임의 변경, 다른 패키지 깨기, **게이트(M7) PASS 기록 전 `release-*.yml` 트리거**(§7).
- **Rust:** `rustfmt` 기본값(`cargo fmt`), clippy 경고 0(`-D warnings`). 도메인은 crate 경계로 가른다 — 쓰기경로는 `momo-messaging`, 발행은 `momo-outbox`. 쓰기 경로는 **단일 트랜잭션**, `sqlx` 런타임 쿼리 API(컴파일타임 `query!` 매크로 금지 — 라이브 DB 없이 빌드돼야 한다).
- **TypeScript:** 도메인 모델은 `@momo/core`에만 두고 웹·폰이 import(사본 금지 — 사본이 갈라진 자리가 U4-6 B1이다). 생성 타입(`clients/web-legacy/src/api/schema.d.ts` — 서빙 산출물 쪽)은 손으로 고치지 말고 `docs/api/openapi.yaml`에서 재생성(`scripts/verify_web_generated_types.sh`가 드리프트를 잡는다).
- **UI 작업:** `.claude/skills/momo-design-taste/SKILL.md`가 표면 라우터다 — 웹·데스크톱(`clients/desktop`은 `clients/web/dist`를 그대로 낸다)은 `momo-design-taste-web`, 폰(`clients/mobile`)은 전용 dialect가 **없고** 정본 `docs/design-system/README.md` + `clients/mobile/src/design/tokens.ts`가 규칙이다. 하드 룰(토큰 색/텍스트 롤/스페이싱 스케일/AI-Tells 금지)과 mechanical pre-flight(`scripts/design_preflight_web.sh` — 폰에는 없으니 리포트에 그렇게 적는다)를 준수하고, 사람 리뷰 요청 전 design-review 리포트(Blocker 0)를 PR evidence에 포함한다.

## 6. 다음 티켓 선택법 (자율 picker)
진실 원천: **ROADMAP.md(마일스톤 순서·의존) → BUILD_TICKETS.md(STEPS) → 티켓 deps**.
1. **마일스톤 순(M0→M8)**: 가장 낮은 번호의 열린/미완 마일스톤부터. 현재 활성 = **M1**(M0 달성됨).
2. 그 안에서 **`deps`(blocked-by)가 전부 done**인 티켓만(의존 충족). 미충족이면 건너뛴다.
3. **의존 깊이 얕은 것** → 동률이면 **`priority:p0>p1>p2`** → 그다음 티켓 id/이슈번호 오름차순.
4. `legal`/`manual` 티켓은 파일/런북만 준비, 발급·계약·심사는 사람 위임(런북 명시).
5. `[runtime]` 전용은 Docker/psql로 가능한 검증을 우선 수행하고, hermes 등 외부 의존은 설치 또는 mock 준비를 먼저 검토한다.
6. 고른 이슈는 자신에게 할당하고 `status:in-progress`로 바꾼 뒤 시작한다. 가능하면 worktree를 사용한다. 막히면 추측 금지, 블로커 코멘트 남기고 다음 티켓.

> **주의 — 위 1번의 "마일스톤 순"은 은퇴한 전제 위에 있다.** `ROADMAP.md` 머리말이 이미 인정한다: "기존 M0~M8은 'Swift 5패키지 → macOS 공증 → iOS 스토어'를 전제로 짜였는데, 서버 재작성(ADR-0145)이 그 전제를 관통했다." **현행 v0의 단위는 마일스톤 번호가 아니라 축**이다(2026-08-03 성재 승인 — 관전·승인·대화가 폰에서 한 번씩 도는 것). 아래 backbone은 **역사 기록**으로 읽고, 실제 우선순위는 `ROADMAP.md` 상단 축 절과 `STATUS.md` 최상단에서 확인하라. 재조준은 성재 승인 사항이라 이 파일이 임의로 다시 쓰지 않는다.

**마일스톤 backbone(정본=ROADMAP.md, 은퇴 전제):** M0 Foundation(**달성**) → M1 백엔드 런타임+staging(G-0 런타임 e2e) → M2 멀티팀 온보딩(`003_onboarding.sql` invite_code+platform_admin, 자가가입, 관리자 추적) → M3 데스크탑 v0 UX(D/B/C 실데이터) → M4 데스크탑 패키징(Xcode/Developer ID/notarytool/DMG/Sparkle) → M5 iOS(iOS 26 SDK/Push/계정삭제/UGC 4종/PrivacyInfo) → M6 CI/CD(fastlane/ASC Key, release 잡 dry-run) → **M7 QA·검수 게이트 🔒**(G-0~G-G PASS) → M8 스토어 제출(M7 PASS 후에만). 임계경로: 모바일 M0→M1→M2→M5→M7→M8, 데스크탑 M0→M1→M3→M4→M7→M8. M3 이후 M4/M5/M6 병렬. 후속(출시 후): v1 프리미티브 P1 branch_id·P2 reversibility_tier·P3 belief·P4 autonomy_level·P5 decision_ledger·P6 scheduled trigger.

## 7. 설계 맥락 + 런타임 미검증 + 게이트 + 라이선스
**불변식(day-1 강제):** ①Postgres=SoT, Centrifugo=전송계층 ②쓰기경로 단일화(클라 직접 publish 금지) ③순서 SoT=`message.seq` ④에이전트=`member`(kind='agent'), 동일 REST/멱등 ⑤commit↔publish 무손실=transactional outbox ⑥seq=`channel_seq` 행카운터 `UPDATE...RETURNING`(시퀀스 금지), `client_msg_id` 멱등 ⑦멀티테넌시 `workspace→channel→membership`, 모든 행 `workspace_id`, RLS FORCE, tx마다 `SET LOCAL app.workspace_id`.

**읽을 곳:** `STATUS.md`(항상 먼저) · `docs/adr/`(**결정 정본** — 특히 0100 거버넌스, 0101 에이전트 신원) · `docs/architecture/overview.md`(아키텍처 정본 — 어긋나는 변경은 같은 PR에서 갱신) · `docs/ux-bible/README.md`(UX 원칙 P1~P15 — UI 티켓 수용기준이 인용) · `ROADMAP.md`(마일스톤/게이트/비용) · `schema_v0.sql`(정본 DDL) · `research/07-deepdive/04`(L4 스펙) · `…/05`(D/B/C 경험) · `BUILD_TICKETS.md`(빌드 STEPS) · `docs/cicd/05-qa-release-gate.md`(게이트 객관기준 정본) · `docs/cicd/03-store-readiness-gate.md`(PASS 블록 기록 위치) · `docs/cicd/00~04`(Apple CI/CD·setup·시크릿·티켓 — 은퇴 전제) · **`infra/rust/README.md`(현행 스택 기동 — 이미지+compose. §2 준비 절차는 수리 중, #1227)** · `docs/runbooks/ncp-rust-deploy.md`(라이브 배포 정본) · `docs/RUN.md`(은퇴 중 — Swift 기준 로컬 기동, 상단 배너 참조) · `legal/*`·`docs/legal/*`(법무).

**런타임 미검증:** Docker/psql로 가능한 PG18+Centrifugo 검증은 각 goal에서 실제 수행한다. hermes, APNs 등 외부 의존이 남으면 실제 의존성 또는 mock 준비를 먼저 검토하고, 그래도 못 닫는 범위만 좁게 `runtime-unverified` 표기 + 절차를 문서에 남긴다(현행 스택 절차는 `infra/rust/README.md`).

**🔒 게이트 불변식:** 스토어/공증 배포(M8)·external TestFlight는 **사용성 검수 게이트(M7) PASS 후에만**. 조건: `docs/cicd/05-qa-release-gate.md` G-0~G-G 전부 PASS + 증거 → `docs/cicd/03-store-readiness-gate.md` 상단 PASS 블록(날짜+커밋해시+빌드#+증거) 기록 → STATUS.md 게이트 OPEN→PASS. **기록 없는 release = 규칙 위반.** PASS 전 `release-*.yml` 미트리거. 자동 `pr-ci`·`track-alignment`는 이 release 권한을 넓히지 않으며, release/유료 macOS workflow는 owner approval 전 미트리거다.

**permissive 라이선스:** 전 의존성 permissive(Apache-2.0/MIT/BSD/PostgreSQL License) 유지 — Rust(tokio·axum·sqlx MIT/Apache-2.0)·Centrifugo v6(Apache-2.0)·PostgreSQL 18(PostgreSQL License)·React/Vite/Tauri(MIT/Apache-2.0). **비-permissive(GPL/AGPL/상용 제약) 의존 추가 금지.** 라이선스 게이트의 커버리지·정책 정본은 `CONTRIBUTING.md`이며 Rust/npm 정본 트리로의 이설은 #1225에서 다룬다. 새 의존 추가 시 라이선스 확인 + `legal/THIRD_PARTY_NOTICES.md`/`NOTICE` 귀속 반영. 외부 배포/상용 전 법무 검토 1회 필수 — 법무·스토어 정책 텍스트는 **법률 자문이 아님**(사실은 Apple/GitHub 1차 출처, 추정은 `(추정)`).

## 8. 안전 / 한계
- hermes 등 외부 의존이 남으면 설치/Mock 준비를 먼저 하고, 검증 못 한 범위만 좁게 `runtime-unverified`로 남긴다.
- 막히면(의존 미충족·정보 부족) 임의 추측 금지 — 이슈에 블로커 코멘트 + 다음 티켓.
