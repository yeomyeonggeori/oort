# CODEX.md — oort (Codex 자율실행 가이드)

> **이 파일 하나만 읽으면 Codex가 이 리포에서 바로 착수할 수 있다.** (`AGENTS.md`와 핵심 내용 동일 — `AGENTS.md`는 Codex 런타임이 자동 머지하는 정식 진입점, 이 `CODEX.md`는 사람·도구가 직접 읽는 풀 가이드. 둘이 어긋나면 `AGENTS.md`가 우선.)
> **⚠️ 사본이 둘이라는 사실 자체가 드리프트원이다.** 스택·명령·계약을 고칠 때는 **두 파일을 같은 PR에서** 고쳐라. 한쪽만 고치면 다음 사람은 낡은 쪽을 읽는다(#1226이 정리한 상태가 정확히 그것이었다).
>
> **실행 주체:** 기획은 성재(최종 승인)+Fable/GPT 5.6(병렬 planner), 공용 정본 통합은 `momo-main`이 맡고, **실제 구현은 Codex가 goal(= GitHub Issue)로 자율 실행**한다. 기획 세션은 `scripts/planning_context.sh` → `docs/planning/CURRENT_STATE.md`부터 읽는다.
> **현재 위치(2026-08):** 서버는 **Rust/Axum**(`server-rust/`, ADR-0145)으로 재작성돼 `app.oor7.com`에서 돌고 있고, 제품 표면은 **웹 + Tauri 데스크톱 + React Native 모바일**이다. **Swift 트리는 은퇴 중**(§0 상자). 최신 상태는 `STATUS.md` 최상단이 정본.
> **사실 표기 규칙:** `(검증됨)` = 공식문서/리포 교차확인 · `(추정)` = 설계/일정 판단 · `runtime-unverified` = 해당 goal에서 아직 e2e를 못 닫은 것. **법무 관련 텍스트는 법률 자문이 아님.**

---

## 0. 제품 1줄

oort = AI 에이전트가 사람과 **동등한 1급 멤버**(`member.kind='agent'`)로 참여하는 자체구축 슬랙형 메신저. 서버는 **Rust/Axum**(`server-rust/`, ADR-0145) + **Centrifugo v6** + **PostgreSQL 18**, 제품 표면은 **웹(React/Vite `clients/web`) · 데스크톱(Tauri 2 `clients/desktop` — 같은 웹 번들) · 모바일(React Native `clients/mobile`)**이고 공유 도메인 코어는 TypeScript `packages/momo-core`다(ADR-0119/0133/0137). 에이전트 게이트웨이 = 김인턴/hermes(OpenAI 호환 `/v1/chat/completions` + SSE). 전 의존성 **permissive** 타깃.

> ### ⚠️ Swift 트리는 은퇴 중 — 여기에 새로 짓지 마라
> `clients/macOS`·`clients/iOS`·`clients/Core`는 **삭제됐다**(W-S1 / #1215 — 이식 원본은 git 이력에 있다). `server/Sources`(Hummingbird 2), `relay/OutboxRelay`, `workers/*`, `services/*`는 **아직 레포에 있지만 삭제 대기**다. 그 경로는 **실패하지 않고 잘못된 것을 성공적으로 짓는다** — 그래서 더 나쁘다.
> **은퇴 아님:** ① `server/Migrations/*.sql`(Rust 이미지가 싣는 정본 DDL) ② `relay/PushRelay`(라이브 푸시 경로가 지금도 빌드·배포) ③ `clients/web-legacy`(알파가 실제로 서빙하는 산출물, ADR-0133 parity 게이트 전까지).

**핵심 쓰기경로(절대 깨지 말 것):**
`REST send → (channel_seq bump + message INSERT + outbox INSERT) 단일 트랜잭션 → momo-relay가 Centrifugo /api/publish`.
클라는 **절대 Centrifugo로 직접 publish하지 않는다.** Postgres = Source of Truth, Centrifugo = 전송계층(DB 아님). 순서 SoT = `message.seq`.

---

## 0.1 표준 작업 루프

1. 모든 작업은 **Issue + Milestone + Project** 기준으로 시작한다. 필요하면 작업 전 이슈/마일스톤/프로젝트 상태를 정리한다.
2. 이슈를 claim한 뒤 가능하면 worktree에서 진행한다. 시작 전 `scripts/goal_status.sh`로 충돌을 확인하고, `scripts/goal_claim.sh <issue>`로 branch/worktree/assignee/status lock을 잡는다. 스크립트가 없는 checkout에서는 수동 branch/worktree로 같은 계약을 지킨다.
3. 작업 전 `STATUS.md` → `ROADMAP.md` → `BUILD_TICKETS.md` → 이슈 본문 순으로 계획을 확인한다. 계획이 미흡하면 추가 리서치를 하고, 계획이 충분하면 현재 사실을 검증한다.
4. 구현은 이슈 범위에 맞춘다. 범위가 커지면 새 이슈로 제안한다.
5. 구현 후 해당 검증 등급의 테스트를 실행한다. `pr-ci`는 세 canonical branch PR의 보조 게이트이고, runtime 범위는 `scripts/local_gate.sh --profile ...`가 정본이다. 서버 변경은 `cargo fmt --all --check`/`clippy -D warnings`/`cargo test --workspace`, 웹·폰·코어 변경은 해당 트리 게이트 + `scripts/verify_merge_tree.sh`를 하드 게이트로 본다.
6. worker는 커밋하고 push한 뒤 PR을 연다. PR은 해당 이슈 하나만 닫고, PR 본문에 local gate evidence를 붙인다.
7. worker는 `scripts/goal_release.sh <issue> --review --pr <PR URL>`로 이슈를 `status:needs-review`로 전환하고 `momo-main`에 handoff한 뒤 멈춘다.
8. **merge/close/main gate/로드맵 조정은 `momo-main`만 수행한다.** worker는 PR 생성 후 임의 merge, 이슈 close, main 재검증, 로드맵/백로그 재배열을 하지 않는다.
9. `momo-main`은 코드리뷰 에이전트 또는 리뷰 스킬로 보안·코드 품질·회귀 위험을 점검하고, 필요한 수정만 worker 또는 같은 이슈 worktree에 위임한다.
10. `momo-main`은 리뷰 반영 후 최종 local gate를 다시 실행하고 현재 PR head의 `PR CI gate`와 `Policy integrity gate`를 모두 확인한다(ADR-0153 D5). 머지 직전에는 **현재 PR의 exact canonical base branch/HEAD에서 wrapper bytes가 그 base와 일치하는 checkout**으로 `scripts/verify_policy_integrity_from_base.sh --repo yeomyeonggeori/oort --pr <PR>`를 실행해 exact base commit에서 추출한 verifier로 status/run provenance와 현재 정책 증거를 재검증한다. worktree/candidate verifier bytes는 무시하고 실행하지 않으며, 같은 Actions App/context만 믿지 않는다. local evidence가 DB·Docker·외부 provider runtime의 primary merge evidence다. release/유료 macOS workflow는 owner/M7 정책을 그대로 지킨다.
11. 최종 보고에는 이번 작업 결과, 검증, 로드맵 영향, 새로 알게 된 리스크/자료, 다음 goal 추천을 포함한다.

---

## 1. 리포 맵 + 책임

**현행 스택 — 여기서 짓는다:**
```
server-rust/             Rust/Axum 워크스페이스(ADR-0145). `cargo` 진입점은 server-rust/Cargo.toml.
  bins/momo-server/      HTTP API(Axum). 핵심 쓰기경로가 여기로 들어온다.
  bins/momo-relay/       outbox SKIP LOCKED 폴링 → Centrifugo publish.
  bins/momo-agent-worker/ agent_job 클레임 → provider SSE → message 스트리밍 PATCH.
  bins/momo-notifier/    푸시 알림 발신(ADR-0120 경계).
  bins/momo-migrate/     마이그레이션 러너(psql로 shell-out — 002/006/012가 메타커맨드를 쓴다).
  crates/momo-messaging/ 쓰기경로 척추(seq bump + message INSERT + outbox INSERT 단일 tx).
  crates/momo-{outbox,auth,db,agent,provider,push,drive,settings,t3,wire,ephemeral}/
server/Migrations/       **정본 DDL**(00N_*.sql). Rust 이미지가 그대로 싣는다 — 은퇴 아님.
schema_v0.sql            정본 스키마(PostgreSQL 18, uuidv7() PK, RLS FORCE) — 읽기 전용. 이동/수정 금지.

packages/momo-core/      @momo/core — 웹·폰이 공유하는 TS 도메인 코어. **모델 단일 진실원천**(사본 금지).
clients/web/             React/Vite SPA — 제품 웹 표면이자 데스크톱이 감싸는 번들.
clients/desktop/         Tauri 2 셸: 딥링크·mDNS·알림·키체인·업데이터. UI를 포크하지 않는다.
clients/mobile/          React Native 앱(현재 iOS). `lane:phone`이 실기 레인.
clients/web-legacy/      ADR-0119 v0 웹. **알파가 실제로 서빙하는 산출물**(parity 게이트 전까지) —
                         생성 타입 src/api/schema.d.ts가 docs/api/openapi.yaml과 동기화돼야 한다.

adapters/hermes/         momo_adapter.py(BasePlatformAdapter) + plugin.yaml. py3 only.
adapters/prime/          prime-agent 어댑터(스트림 릴레이 · 하네스 refine · RPC).
infra/rust/              **라이브 배포 경로**: Rust 이미지 compose + Caddyfile(정본) + 푸시/폰 오버레이.
infra/                   dev docker-compose.yml(PG18 + Centrifugo v6) · e2e compose · centrifugo.json · .env.example.
scripts/                 local_gate.sh · verify_*.sh · verify_merge_tree.sh · goal_claim/status/release.sh · migrate.sh.
docs/                    INDEX.md(문서 지도) · adr/(결정 정본) · architecture/overview.md · api/openapi.yaml · runbooks/.
legal/                   privacy-policy.md · agent-disclosure.md · THIRD_PARTY_NOTICES.md (법률 자문 아님).
.github/                 ISSUE_TEMPLATE/ · workflows/(pr-ci + track-alignment 자동, release는 owner/M7 게이트).
STATUS.md / ROADMAP.md   현재 상태(항상 먼저) / 릴리스 계획. AGENTS.md = 이 파일과 같은 핵심의 정식 진입점.
```

**은퇴 중 — 삭제 대기. 읽어서 이해하는 용도이지 확장 대상이 아니다:**
```
server/Sources/          MomoServer(Hummingbird 2) — Rust 재작성으로 대체됨.
relay/OutboxRelay/       Swift outbox relay — Rust momo-relay로 대체됨.
relay/PushRelay/         ※ 예외: 라이브 푸시 경로가 지금도 빌드·배포한다(은퇴 아님).
workers/·services/       AgentWorker·WorkHostDaemon·NotifierWorker·LinkShort 등 Swift 실행체.
infra/prod/              Swift prod compose 계열(infra/prod/Dockerfile.web은 예외 — web-legacy 서빙).
(삭제됨 — W-S1/#1215) clients/{Core,macOS,iOS}/ · fastlane/ · .github/workflows/{ci-build,release-ios,release-macos}.yml
```

**역할별 BYPASSRLS:** relay·agent-worker(`momo-relay`·`momo-agent-worker`)만 전 테넌트 폴링을 위해 BYPASSRLS. **쓰기 경로엔 BYPASSRLS 금지**(읽기 추적 전용). 그 외 모든 경로는 `SET LOCAL app.workspace_id` + RLS FORCE.

---

## 2. 빌드 / 검증 명령 (copy-paste 그대로 실행)

> 로컬 툴체인: **cargo(rustup) · Node 20+ · Docker Desktop + psql 있음**, hermes 없음. PG18+Centrifugo 런타임은 검증 가능하고, hermes 필요 경로는 실제 hermes 또는 mock OpenAI-compatible gateway를 준비한다.
> **Rust 툴체인 — 레포에 `rust-toolchain.toml`은 없다**(#1442 판정: 신설하지 않음). 고정이 없으니 환경 기본 툴체인이 그대로 쓰이고, MSRV보다 낮으면 컴파일 이전 resolve 단계에서 거절된다. 카고 워크스페이스는 **둘**이고 MSRV가 다르다(#1442 실측): `server-rust` = **1.88.0**, `clients/desktop/src-tauri` = **1.89.0**. 둘 다 만지면 **stable ≥ 1.89.0**. edition은 양쪽 다 `2021`(마이그레이션 계획 없음).
> npm 트리는 lockfile이 셋이다 — 루트(`packages/*`), `clients/web`, `clients/mobile`.
> **이 블록 자체가 게이트를 받는다(#1525).** 여기·`AGENTS.md`·`docs/RUN.md`·`docs/runbooks/*.md`의
> 명령은 `scripts/check_docs_commands.py`가 매 프로파일에서 트리에 대고 해소한다 — 실행체 존재/구문,
> `make` 타깃, `--profile` 이름, npm 스크립트, 우리 스크립트에 넘기는 long flag, compose·`--package-path`
> 경로, 그리고 위의 `cargo fmt --all` 규칙. **명령을 고칠 때 문서도 같은 커밋에서 고쳐라** — 안 고치면
> docs 게이트가 빨개진다. 폐지된 명령을 "폐지됐다"고 말하려고 이름을 불러야 하면 그 줄 끝에
> `<!-- docs-cmd-ignore: 이유 -->`를 붙인다(이유 없는 마커는 마커가 아니다).

```bash
# --- 서버 (Rust/Axum). 이 셋이 서버 변경의 하드 게이트 ---
# `--all` 생략 금지. 두 매니페스트 다 virtual workspace라 `--all` 없는 cargo fmt는
# "Failed to find targets"로 exit 1이고 아무것도 검사하지 않는다 — 이 문서가 그 형태를
# 실어 온 것이 워커들이 "자기 파일만 fmt" 우회를 하게 된 이유다(#1472).
cargo fmt --all --check --manifest-path server-rust/Cargo.toml
cargo clippy --manifest-path server-rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test   --manifest-path server-rust/Cargo.toml --workspace
make rust-build                                   # = cargo build --workspace

# --- 웹 / 모바일 / 공유 코어 (TypeScript) ---
npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci
make ts-check                                     # momo-core + web + mobile typecheck
make ts-test                                      # 동일 트리 테스트
make build                                        # = rust-build + ts-check (현행 스택 전부)
make test                                         # = rust-test  + ts-test

# --- 병합 결과 검증(#1108). 브랜치가 아니라 "머지된 트리"를 잰다 ---
scripts/verify_merge_tree.sh                      # 기본 base=origin/track/engine

# --- 게이트 (PR CI는 보조, runtime local evidence가 정본) ---
scripts/local_gate.sh --profile docs              # 문서/정적 — 문서만 건드려도 이건 돌린다
scripts/local_gate.sh --profile web               # 웹 클라(설치·lint·vitest·tsc·빌드·라이선스·브라우저 스모크)
scripts/local_gate.sh --profile runtime-db
scripts/local_gate.sh --profile runtime-agent

# --- 어댑터(py) / 워크플로 정적 검증 ---
python3 -m py_compile adapters/hermes/momo_adapter.py adapters/prime/adapter.py
actionlint .github/workflows/*.yml                # YAML/액션 lint

# --- 런타임 (Docker Desktop/psql 가용) ---
cp infra/.env.example .env
make up                                           # postgres(pgvector/pg18) + centrifugo:v6
make migrate                                      # 번호순 적용 (멱등 — IDEMPOTENCY_OK 확인)
# Rust 이미지 스택(라이브와 같은 형상)의 기동 절차 정본: infra/rust/README.md
#   ※ 그 문서 §2 준비 절차는 무수정 템플릿만으로 통과하지 못한다 — 수리 중(#1227).

# --- [은퇴 중] Swift 트리를 굳이 돌려야 할 때만. 새 작업의 게이트가 아니다 ---
make swift-build ; make swift-test
```

**검증 등급(각 이슈/티켓에 명시):**
- `[rust]` = `cargo fmt --all --check` + `cargo clippy … -D warnings` + `cargo test --workspace` 전부 green. fmt는 **워크스페이스 전체**가 기준이지 자기 파일이 아니다 — 선재 drift를 물려받았으면 그것도 이 PR에서 정리한다(그 우회가 #1377을 #1472로 되돌린 경로). `scripts/local_gate.sh`가 모든 프로파일에서 두 카고 워크스페이스에 이 검사를 돌린다.
- `[web]` / `[mobile]` = 해당 트리 `typecheck` + `test` green **+ 병합 트리**(`scripts/verify_merge_tree.sh`) green. 브랜치 초록만으로는 부족하다 — 그게 U4-6 B1에서 실제로 깨진 자리다.
- `[infra]` / `[sql]` = 파일 존재 + `schema_v0.sql`(정본)과 정합. Docker/psql로 적용 가능한 범위는 runtime 검증한다.
- `[python]` = `python3 -m py_compile` 통과.
- `[ci]` = 워크플로우 syntax/lint(actionlint) 통과 + (게이트 전) dry-run.
- `[runtime]` = Docker/psql로 가능한 검증은 수행한다. hermes 등 외부 의존이 필요하면 실제 의존성 또는 mock을 먼저 준비하고, 그래도 못 닫는 범위만 좁게 `runtime-unverified` 표기 + 절차 문서화.
- `[manual]` = 사람 1회(발급/계약/심사). Codex는 런북/파일만 준비하고 위임 표시.
- `[swift]`(은퇴 중) = 삭제 대기 트리를 불가피하게 건드릴 때만. 새 goal의 수용기준으로 쓰지 마라.

---

## 3. 컨벤션 (브랜치 / 커밋 / PR)

**브랜치 (GitHub org `yeomyeonggeori`, repo `oort`):**
- `feat/<issue#>-<slug>` · `fix/<issue#>-<slug>` · `chore/<issue#>-<slug>` · `docs/<issue#>-<slug>`.
- 티켓 id 형태가 `MOMO-NNN`이면 `feat/MOMO-NNN-<slug>`도 허용(SPINE 티켓 id 규약). **main 직접 push 금지**(브랜치 보호 가정).

**커밋:** Conventional Commits — 예) `feat(server): channel_seq 발급 트랜잭션 (#NN)`. 타입/스코프는 영문, 본문 한국어 OK.

**PR:** 1 PR = 1 이슈. 여러 이슈를 한 PR에 섞지 않는다. 머지 전 §2의 해당 등급 게이트 green 필수. PR 본문은 아래 템플릿 그대로.

```
Closes #<issue>

## 한 일
- (변경 요약 bullet)

## 검증 (등급: [rust]/[web]/[mobile]/[infra]/[sql]/[python]/[ci]/[runtime]/[manual])
- [ ] 해당 등급 게이트 green: <명령 + 결과>
- [ ] 인접 트리 안 깨짐 (웹·폰·코어 동시 변경이면 verify_merge_tree.sh green)
- [ ] schema_v0.sql 정합 (DDL/모델 컬럼·타입 일치)
- [ ] runtime 미검증 부분 표기

## STATUS 영향
- (STATUS.md에 반영한 줄)

## 남은 것 / 후속 이슈 제안
- (스코프 밖이라 새 이슈로 뺀 것)

## Worker handoff
- [ ] worker는 PR 생성 후 `status:needs-review`로 넘기고 merge하지 않음
- [ ] merge/close/main gate/로드맵 조정은 `momo-main`만 수행
```

**절대 하지 말 것:**
- 시크릿 커밋(`.env`, `.env.worktree`), `schema_v0.sql` 수정/이동, `.build/`·`*.resolved`·`DerivedData/`·`.swiftpm/` 커밋(`.gitignore` 참조).
- 무관한 리팩터 끼워넣기, 의존성 메이저 임의 변경, 다른 패키지 깨기.
- **게이트(M7) PASS 기록 전 `release-*.yml` 트리거**(§7 참조).

**Swift 네이밍/구조(잔존 트리 한정):** 타입 `PascalCase`, 함수/프로퍼티/let `camelCase`, enum case `camelCase`. SwiftPM 의존은 최신 안정 태그로 resolve, `*.resolved` 비커밋. 서버 쓰기경로는 단일 트랜잭션, async/await(블로킹 금지). (`MomoCore`·`ChatBackend`/`AgentTransport` 클라 계약은 클라 3트리와 함께 삭제됐다 — 현행 공유 코어는 TS `packages/momo-core`다.)

---

## 4. Definition of Done (모든 이슈 공통 — 못 채우면 닫지 마라)

1. **해당 등급 검증 통과**(§2). 서버 이슈는 `cargo test --workspace` + `clippy -D warnings` green이 **하드 게이트**, 웹·폰·코어 이슈는 자기 트리 게이트 **+ 병합 트리** green이 하드 게이트.
2. **선행 티켓을 깨지 않음**: 인접 crate/워크스페이스가 여전히 green이고, 웹·폰·코어를 함께 건드렸다면 `scripts/verify_merge_tree.sh`가 green.
3. **정본 정합**: DDL/모델은 `schema_v0.sql`과 컬럼·타입 일치(`member.kind`, `channel_seq` 행카운터, `uuidv7()` PK, `hlc_ts`/`hlc_count`, `client_msg_id` 멱등 등). 정본은 **이동/수정 금지** — 스키마 확장은 `server/Migrations/00N_*.sql` 신규 파일 + RLS DO-block ARRAY에 신규 테이블 등록.
4. **runtime 미검증은 정직 표기**: 파일/주석/STATUS에 `runtime-unverified`. 검증 못 한 걸 "검증됨"이라 쓰지 마라.
5. **STATUS.md 갱신**: 무엇을 추가/변경했고 무엇이 여전히 미검증인지 1~3줄.
6. **PR 본문**이 §3 템플릿.
7. **미완성 스텁**은 `// TODO(#이슈번호): 설명` 형태로만(컴파일은 항상 보장).
8. **게이트/배포 불변식 준수**: 사용성 검수 게이트(M7) PASS 기록 없이 스토어/공증 배포(M8)·external TestFlight 진행 금지(§7).

---

## 5. 다음 티켓 선택법 (자율 picker)

사람이 이슈를 지정하지 않았다면 아래 순서로 고른다. 진실 원천: **`ROADMAP.md`(마일스톤 순서·의존) → `BUILD_TICKETS.md`(빌드 STEPS) → SPINE 티켓 deps**.

1. **마일스톤 우선순위 순(M0 → M8)**: 가장 낮은 번호의 **열린/미완** 마일스톤부터. 현재 활성 = **M1**(M0 Foundation은 달성됨).
2. 그 마일스톤 안에서 **`deps`(blocked-by)가 전부 done**인 티켓만(의존 충족). 의존 미충족이면 건너뛰고 다음.
3. 그 중 **의존 깊이가 가장 얕은** 것 → 동률이면 **`priority:p0 > p1 > p2`** → 그다음 티켓 id/이슈 번호 오름차순.
4. `legal`/`manual` 티켓은 Codex가 **파일/런북만** 준비하고 실제 발급·계약·심사는 사람에게 위임(런북에 명시).
5. `[runtime]` 전용 티켓은 Docker/psql로 가능한 검증을 우선 수행하고, hermes 등 외부 의존은 설치 또는 mock 준비를 먼저 검토한다.
6. 고른 이슈를 자신에게 할당하고 `status:in-progress`로 바꾼 뒤 시작한다. 가능하면 worktree를 사용한다. 막히면(의존 미충족/정보 부족) 임의 추측 금지, 이슈에 블로커 코멘트 남기고 다음 티켓으로.

> **주의 — 위 1번의 "마일스톤 순"은 은퇴한 전제 위에 있다.** `ROADMAP.md` 머리말이 이미 인정한다: "기존 M0~M8은 'Swift 5패키지 → macOS 공증 → iOS 스토어'를 전제로 짜였는데, 서버 재작성(ADR-0145)이 그 전제를 관통했다." **현행 v0의 단위는 마일스톤 번호가 아니라 축**이다(2026-08-03 성재 승인 — 관전·승인·대화가 폰에서 한 번씩 도는 것). 아래 표는 **역사 기록**으로 읽고, 실제 우선순위는 `ROADMAP.md` 상단 축 절과 `STATUS.md` 최상단에서 확인하라.

**마일스톤 한눈 backbone(정본 = ROADMAP.md, 은퇴 전제):**

| M | 이름 | 핵심 | 게이트 |
|---|---|---|---|
| M0 | Foundation | 5 Swift 패키지 컴파일 + 정본 스키마/인프라/마이그레이션 정합 | **달성됨** |
| M1 | Backend 런타임 + staging 배포 | docker e2e(seq/outbox/relay/RLS/SSE/비용) + Caddy TLS/SOPS/pgBackRest/모니터링 | G-0 런타임 e2e |
| M2 | 멀티팀 온보딩 | `003_onboarding.sql`(invite_code + platform_admin) + 자가가입 + 관리자 추적 | 3+팀 격리 e2e |
| M3 | 데스크탑 v0 UX | D Live Tool-Call · B 비용 호흡 링 · C 승인 인박스 실데이터 바인딩 | staging 실접속 동작 |
| M4 | 데스크탑 패키징 | MomoMac.xcodeproj + Developer ID 서명 + notarytool 공증 + DMG + Sparkle 2 | spctl/Gatekeeper |
| M5 | iOS 앱 | MomoiOS.xcodeproj(iOS 26 SDK) + Push/APNs + 계정삭제 + UGC 4종 + PrivacyInfo | 실기기 시나리오 |
| M6 | CI/CD | fastlane(match/pilot/deliver/notarytool) + ASC API Key + Actions. PR CI는 자동, release 잡은 owner/M7 게이트 전 미트리거 | local gate + `PR CI gate` + actionlint green |
| **M7** | **QA·사용성 검수 게이트 🔒** | G-0~G-G 전부 PASS + 증거 | **스토어 제출 차단 불변식** |
| M8 | 스토어 제출 | iOS App Store 업로드/심사/배포 + macOS 공증 DMG 공개 + Sparkle 라이브 | M7 PASS 후에만 |

> **임계 경로:** 모바일 `M0→M1→M2→M5→M7→M8`, 데스크탑 `M0→M1→M3→M4→M7→M8`. M3 이후 M4(🖥)·M5(📱)·M6(CI/CD)는 공유 코어 위에서 병렬.
> **후속(스토어 출시 후):** v1 프리미티브 P1 `branch_id` · P2 `reversibility_tier` · P3 belief · P4 `autonomy_level` · P5 `decision_ledger` · P6 scheduled trigger (EP-PRIMITIVES, v0 데모엔 불필요).

---

## 6. 설계 맥락 요약 + 읽을 곳

oort는 5개 설계축 + 3개 보강(outbox / 비용회계 / APNs)을 단일 정합 설계로 통합한 L4 스펙 위에 서 있다. 착수 전 **goal(이슈)과 관련된 곳만** 골라 읽는다.

**불변식(day-1 강제 — 코드로 절대 깨지 말 것):**
1. Postgres = SoT, Centrifugo = 전송계층(DB 아님).
2. 쓰기 경로 단일화: 클라는 Centrifugo로 직접 publish 금지. 모든 상태변경 = REST → PG commit → outbox → relay publish.
3. 순서 SoT = `message.seq`(Centrifugo offset 아님). 클라는 seq로 정렬·갭검출·복구.
4. 에이전트 = 사람과 동일 `member`(`kind='agent'`). 동일 REST/채널/멱등.
5. commit↔publish 사이 크래시 무손실 = transactional outbox.
6. seq 발급 = `channel_seq` 행카운터 `UPDATE...RETURNING`(시퀀스 금지 — 롤백 갭). `client_msg_id` 멱등 `ON CONFLICT`.
7. 멀티테넌시: `workspace → channel → membership(member)` 3계층, 모든 테넌트 행에 `workspace_id`, RLS FORCE, 트랜잭션마다 `SET LOCAL app.workspace_id`.

**읽을 곳(우선순위):**
- `STATUS.md` — **항상 먼저.** 지금 무엇이 컴파일/런타임 검증됐는지.
- `ROADMAP.md` — 마일스톤/의존/게이트/비용(정본 backbone).
- `schema_v0.sql` — 정본 DDL(24 테이블, RLS FORCE). DDL/모델 작업 전 필수.
- `research/07-deepdive/04-self-build-l4-spec.md` — L4 정본 스펙(아키텍처·스키마·쓰기경로·outbox·비용회계·APNs).
- `research/07-deepdive/05-agent-native-experiences.md` — D/B/C 등 에이전트 네이티브 경험 설계(macOS UX 작업 시).
- `BUILD_TICKETS.md` — Phase 0 + v0 데모 빌드 STEPS·수용기준 등급.
- `docs/cicd/05-qa-release-gate.md` — **게이트(M7) 객관 통과기준 정본**(G-0~G-G).
- `docs/cicd/03-store-readiness-gate.md` — 게이트 PASS 블록 기록 위치.
- `docs/cicd/00~04` — Apple CI/CD 파이프라인·setup 런북·시크릿 인벤토리·Codex 티켓.
- **`infra/rust/README.md` — 현행 스택 기동(이미지 + compose).** §2 준비 절차는 수리 중(#1227). 라이브 배포 정본은 `docs/runbooks/ncp-rust-deploy.md`.
- `docs/RUN.md` — **은퇴 중**(Swift 기준 로컬 기동). 상단 배너를 먼저 읽어라. `legal/*`·`docs/legal/*` — 법무 선결(법률 자문 아님).

---

## 7. 런타임 미검증 · 게이트 · 라이선스 규칙

**런타임 미검증:**
- Docker/psql로 가능한 PG18+Centrifugo 검증은 각 M1 goal에서 실제 수행한다.
- hermes, APNs, Apple 배포 등 외부 의존이 남으면 실제 의존성 또는 mock 준비를 먼저 검토하고, 그래도 못 닫는 범위만 좁게 `runtime-unverified` 표기 + `docs/RUN.md`에 절차를 남긴다.

**🔒 게이트 불변식(스토어/공증 배포 차단):**
- 스토어/공증 배포(M8) 및 **external TestFlight**는 **사용성 검수 게이트(M7)가 PASS 된 후에만** 진행한다.
- 통과 조건: `docs/cicd/05-qa-release-gate.md`의 **G-0~G-G 전부 PASS + 증거 첨부** → `docs/cicd/03-store-readiness-gate.md` 상단에 **PASS 블록(날짜 + 커밋 해시 + 빌드# + 증거 링크)** 기록 → `STATUS.md` 게이트 상태 OPEN→PASS 갱신.
- **기록 없는 release = 규칙 위반.** 게이트 PASS 전에는 `release-desktop.yml`을 트리거하지 않는다(`release-ios.yml`·`release-macos.yml`은 W-S1/#1215에서 삭제). 자동 `pr-ci`·`track-alignment`는 이 release 권한을 넓히지 않으며, release/유료 macOS workflow는 owner approval 전 미트리거다.

**permissive 라이선스 규칙:**
- 전 의존성을 **permissive(Apache-2.0 / MIT / BSD / PostgreSQL License)** 로 유지. 확정 스택: Rust(tokio·axum·sqlx — MIT/Apache-2.0), Centrifugo v6(Apache-2.0), PostgreSQL 18(PostgreSQL License), React/Vite/Tauri(MIT/Apache-2.0). **비-permissive(GPL/AGPL/상용 제약) 의존 추가 금지.** 라이선스 게이트의 커버리지·정책 정본은 `CONTRIBUTING.md`이며 Rust/npm 정본 트리로의 이설은 #1225에서 다룬다.
- 새 의존 추가 시 라이선스 확인 + `legal/THIRD_PARTY_NOTICES.md`(및 `NOTICE`)에 귀속 반영.
- 외부 배포/상용 전 법무 검토 1회 필수. 법무·스토어 정책 텍스트는 **법률 자문이 아님** — 사실은 1차 출처(Apple/GitHub 공식 문서)로 표기, 추정은 `(추정)`.
