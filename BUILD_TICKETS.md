# momo — 빌드 티켓 (Phase 0 + v0 데모 D+B+C)

> **목표:** L4 스펙(`research/07-deepdive/04-self-build-l4-spec.md`) 프리미티브 위에서 v0 데모 3종 —
> **D Live Tool-Call** · **B 비용 호흡** · **C 승인 인박스** — 을 굴리기 위한 리포 골격·서버·실시간·에이전트 경로를 세운다.
> 핵심 쓰기경로 = `REST send → (channel_seq bump + message insert + outbox insert) 단일 tx → relay publish`.
>
> **툴체인 현실:** 로컬에 `swift 6.2.3`, Docker Desktop, `psql` 있음(→ Swift 패키지는 `swift build` green 필수, Docker/psql 가능한 런타임은 M1 goal에서 실제 검증). hermes는 별도 실제 게이트웨이 또는 mock OpenAI-compatible gateway가 필요하다.
>
> **표기:** `swift` = Swift 패키지(빌드 검증 대상) · `infra/sql/python` = 파일 존재+정합 검증 · `runtime` = docker/psql 후 검증.

---

## 수용기준 등급 (공통)

각 티켓의 체크박스는 아래 등급 중 하나로 검증한다.

- **[swift]** — `swift build`가 green (경고 허용, 에러 0). 미완성부는 `// TODO` + 컴파일 보장.
- **[infra]** — 파일 존재 + L4 스펙/`schema_v0.sql`과 정합. Docker/psql로 가능한 범위는 M1 runtime goal에서 검증.
- **[sql]** — 파일 존재 + DDL/시드가 `schema_v0.sql`(정본)과 정합. 적용은 `runtime-unverified`.
- **[python]** — `python3 -m py_compile` 통과(문법). 실행은 `runtime-unverified (hermes 게이트웨이 필요)`.
- **[runtime]** — Docker/psql로 가능한 검증은 수행. hermes 등 외부 의존이 필요하면 실제 의존성 또는 mock 준비 후 검증하고, 못 닫는 범위만 `runtime-unverified` 표시.

---

## STEPS — 실행 순서 (의존순 표)

> 표는 **실행 순서(order)** 대로. `의존`은 이 티켓이 깨면 안 되는/필요로 하는 선행 티켓 id.

| order | id | 디렉터리 | swift | 한줄 | 수용기준 등급 | 의존 |
|---|---|---|---|---|---|---|
| 1 | `T01-foundation` | `.` | ✗ | 리포 골격(README/Makefile/디렉터리 placeholder/.swift-version) | infra | — |
| 2 | `T02-infra` | `infra/` | ✗ | docker-compose(PG18+Centrifugo v6) + centrifugo.json(§4.2) + .env.example | infra | T01 |
| 3 | `T03-migrations` | `server/Migrations/` | ✗ | 001_init(정본 복사) + 002_seed(데모 시드) + migrate.sh | sql | T01, (T02 env) |
| 4 | `T04-core` | `clients/Core/` | ✓ | MomoCore SwiftPM 라이브러리(모델 + ChatBackend/AgentTransport 계약) | swift | T01 |
| 5 | `T05-server` | `server/` | ✓ | Hummingbird 2 API(MomoServer): 쓰기경로 단일 tx + 멱등 + 인증 스텁 | swift | T01, T04, (T03 schema) |
| 6 | `T06-relay` | `relay/OutboxRelay/` | ✓ | outbox 폴링 relay(SKIP LOCKED → Centrifugo publish) | swift | T01, (T03 outbox DDL, T05 CentrifugoClient 규약) |
| 7 | `T07-worker` | `workers/AgentWorker/` | ✓ | AgentWorker: agent_job 클레임 → hermes SSE → message PATCH 스트리밍 + 비용/상태 스텁 | swift | T01, T04, (T05 쓰기경로, T06 publish 규약) |
| 8 | `T08-hermes-adapter` | `adapters/hermes/` | ✗ | MomoAdapter(BasePlatformAdapter) + plugin.yaml + requirements + README | python | T01, (T05 REST 계약) |
| 9 | `T09-macos-client` | `clients/macOS/` | ✓ | MomoMac SwiftUI 라이브러리(D/B/C 경험 뷰 placeholder) + smoke 실행 타깃 | swift | T01, T04 |
| 10 | `T10-wiring` | `.` | ✗ | docs/RUN.md(기동 순서) + Makefile/.env.example 정합 점검 | infra | T01~T09 전부 |

**의존 그래프(요약):**
`T01 → {T02, T03, T04}` · `T04 → {T05, T07, T09}` · `T05 → {T06, T07, T08}` · `T06 → T07` · `{T01..T09} → T10`.

---

## 티켓 상세 + 수용기준 (체크박스)

### ☐ T01-foundation — 리포 골격 `[infra]` · 의존: —
- [ ] `README.md` 존재 — 제품 한 줄 정의(§0.1) + 아키텍처 다이어그램 요약(§1.1) + 빌드 안내.
- [ ] `Makefile` 존재 — 타깃 `build` / `migrate` / `up` / `down` / `test` 각 적절 커맨드.
- [ ] 디렉터리 placeholder 생성: `server/` · `relay/` · `workers/` · `clients/Core/` · `clients/macOS/` · `infra/` · `adapters/hermes/`.
- [ ] 최상위 `.swift-version` = `6.2`.
- [ ] `schema_v0.sql`은 **그대로 둠**(이동·수정 금지).
- 수용: 파일 존재 + 디렉터리 구조가 L4 §9.3과 정합. runtime 검증은 해당 없음(파일만).

### ☐ T02-infra — 인프라 정의 `[infra]` · 의존: T01
- [ ] `infra/docker-compose.yml` — `postgres:18`(POSTGRES_* env, healthcheck, named volume), `centrifugo/centrifugo:v6`(config 마운트, `8000` 포트, healthcheck). relay/worker는 추후(주석).
- [ ] `infra/centrifugo.json` — L4 §4.2 namespace config 그대로: `ch`/`dm`/`agent`/`user` namespace, presence/history/recovery, subscribe proxy(`/v1/centrifugo/subscribe`), workspace-qualified `ch:ws<workspaceUUID>.<channelUUID>` regex, client token HMAC + subscription_token, `http_api.key`.
- [ ] `infra/.env.example`(또는 루트 `.env.example`) — DB(POSTGRES_*) / Centrifugo(CENT_TOKEN_HMAC, CENT_API_KEY) / JWT(JWT_HMAC) / hermes(HERMES_BASE_URL, HERMES_API_KEY) 키.
- [ ] 파일 상단 `# runtime-unverified` 주석 명시.
- 수용: `history_meta_ttl > history_ttl` 제약 충족, namespace 4종 모두 명시(상속 없음). Docker/psql 가능한 검증은 M1 runtime goal에서 수행.

### ☐ T03-migrations — 마이그레이션 + 시드 `[sql]` · 의존: T01 (env: T02)
- [ ] `server/Migrations/001_init.sql` = `schema_v0.sql` 내용 복사(정본). 보강 4종 DDL(outbox/비용/APNs §2.2~2.4)이 정본에 이미 있으면 그대로, 없으면 후속 마이그레이션으로 분리 표시.
- [ ] `server/Migrations/002_seed.sql` — 데모 시드: workspace 1, human 1, agent 1(김인턴, model=`hermes-agent`, base_url placeholder), 채널 `#general` + `#agent-lab`, membership, `channel_seq` 0행(채널당), `model_pricing` 글로벌 1행.
- [ ] `scripts/migrate.sh` — psql로 번호순 `.sql` 적용 + `schema_migrations` 추적. psql 없으면 안내 출력 후 종료.
- [ ] 파일/주석에 `runtime-unverified` 명시.
- 수용: DDL/시드가 `schema_v0.sql` 컬럼·타입과 정합(member kind, channel_seq, uuidv7 PK 등). 적용은 `runtime-unverified`.

### ☐ T04-core — MomoCore 공유 라이브러리 `[swift]` · 의존: T01
- [ ] `clients/Core/Package.swift` — SwiftPM 라이브러리 `MomoCore`, swift-tools 6.x.
- [ ] 모델(Codable, §5.3/§6.1): `Message{id,channelId,seq,hlcTs,hlcCount,authorMemberId,type,state,body,props,rootId,clientMsgId}` · `Member{id,kind,displayName,handle,presence}` · `MessageType` enum · `RealtimeEvent` enum · `AgentEvent` enum · `PresenceEntry` · `DraftMessage` 등.
- [ ] `protocol ChatBackend`(§5.3) + `protocol AgentTransport`(§6.1).
- [ ] **`swift build` green (에러 0).** 미완성부 `// TODO`.
- 수용: `cd clients/Core && swift build` 통과.

### ☐ T05-server — MomoServer (Hummingbird 2) `[swift]` · 의존: T01, T04 (schema: T03)
- [ ] `server/Package.swift` — 실행 패키지 `MomoServer`. 의존: hummingbird, postgres-nio, jwt-kit, async-http-client (최신 안정 태그 resolve).
- [ ] 엔트리포인트 `@main` + `Config`(env 로드) + `PostgresClient` 연결 풀 + `AppRequestContext`.
- [ ] 라우트: `GET /health` · `POST /v1/auth/login`(스텁 HS256 JWT) · `POST /v1/workspaces/{ws}/channels/{ch}/messages`(**핵심**: §3.1 `channel_seq UPDATE...RETURNING` + message INSERT + outbox INSERT 단일 tx, `client_msg_id` 멱등 ON CONFLICT) · `GET .../messages`(seq cursor 페이지네이션) · `POST /v1/centrifugo/subscribe`(멤버십 인가 콜백 스텁).
- [ ] `CentrifugoClient`(POST `/api/publish`, `X-API-Key`).
- [ ] RLS용 트랜잭션마다 `SET LOCAL app.workspace_id`.
- [ ] **`swift build` green.** DB 런타임은 M1 goal에서 검증, 안 되는 부분 `// TODO` + 컴파일 보장.
- 수용: `cd server && swift build` 통과. 런타임은 해당 M1 goal에서 별도 검증.

### ☐ T06-relay — OutboxRelay `[swift]` · 의존: T01 (outbox DDL: T03, publish 규약: T05)
- [ ] `relay/OutboxRelay/Package.swift` — 실행 패키지. 의존: postgres-nio, async-http-client.
- [ ] outbox 폴링 루프: `SELECT ... WHERE kind='broadcast' AND status='pending' FOR UPDATE SKIP LOCKED` 클레임 → `CentrifugoClient.publish(version=seq, idempotency_key)` → `status='done'`.
- [ ] `LISTEN/NOTIFY` 훅(가능하면) + `300ms` 폴 fallback.
- [ ] **`swift build` green.**
- 수용: `cd relay/OutboxRelay && swift build` 통과. 런타임은 해당 M1 goal에서 별도 검증.

### ☐ T07-worker — AgentWorker `[swift]` · 의존: T01, T04 (쓰기경로: T05, publish: T06)
- [ ] `workers/AgentWorker/Package.swift` — 실행 패키지. 의존: postgres-nio, async-http-client(+ MomoCore).
- [ ] `AgentTransport` HTTP 구현: OpenAI 호환 `POST /v1/chat/completions`(stream=true) SSE 파서(`chat.completion.chunk` + `tool_calls` + non-stream fallback §6.3).
- [ ] 워커 루프: `outbox(kind='agent_job')` SKIP LOCKED 클레임 → `agent_run` 게이트(step cap/consecutive/depth 스텁) → hermes 호출 → SSE 델타를 message PATCH(스트리밍 흉내)로 게시 → reserve/reconcile 비용 기록 스텁 → `agent.status` publish.
- [ ] 루프 안전장치(MAX_CONSECUTIVE_AUTO/max_steps/세마포어 §3.3)는 함수 스텁 + 기본값 상수.
- [ ] **`swift build` green.**
- 수용: `cd workers/AgentWorker && swift build` 통과. hermes 경로는 실제 게이트웨이 또는 mock 준비 전까지 `runtime-unverified`.

### ☐ T08-hermes-adapter — MomoAdapter (Python) `[python]` · 의존: T01 (REST 계약: T05)
- [ ] `adapters/hermes/momo_adapter.py` — `class MomoAdapter(BasePlatformAdapter)`: `connect`(momo REST 인증 → realtime-token → `agent:` 채널 구독), `send`(REST POST messages, `client_msg_id` 멱등), `handle_message`(멘션 수신 → invoke → 스트림 응답).
- [ ] `adapters/hermes/plugin.yaml` — `register_platform`.
- [ ] `adapters/hermes/requirements.txt`.
- [ ] `adapters/hermes/README.md` — 설치/연결.
- [ ] `python3 -m py_compile momo_adapter.py` 통과.
- 수용: py_compile 통과. 실행 `runtime-unverified (hermes 게이트웨이 필요)`.

### ☐ T09-macos-client — MomoMac (SwiftUI) `[swift]` · 의존: T01, T04
- [ ] `clients/macOS/Package.swift` — 패키지 `MomoMac`, MomoCore 의존.
- [ ] SwiftUI 라이브러리 타깃(컴파일되게): `ChannelListView` · `MessageListView`(seq 정렬) · `MessageBubble`(에이전트 메시지=tool_call/diff/approval 1급 렌더 placeholder) · `AgentPartialView`(agent.partial 스트리밍 placeholder) · `CostBreathingRing`(경험 B placeholder) · `ApprovalInboxView`(경험 C placeholder) · `ViewModel`(MomoCore.ChatBackend/AgentTransport 사용).
- [ ] 작은 실행 타깃 smoke(Core import + 모델 print)로 빌드 검증.
- [ ] 풀 `.app` 번들(Info.plist/Xcode)은 **follow-up 티켓**으로 STATUS에 남김.
- [ ] **라이브러리 + smoke `swift build` green.**
- 수용: `cd clients/macOS && swift build` 통과.

### ☐ T10-wiring — 배선 + 문서 `[infra]` · 의존: T01~T09
- [ ] `docs/RUN.md` — 로컬 기동 순서(`docker compose up` → migrate → server run → worker/relay → macOS 빌드), 환경변수 설명, Docker/psql 가능 범위와 hermes 필요 범위를 명확 안내.
- [ ] `Makefile` 타깃이 실제 커맨드와 일치(build = 각 패키지 swift build, migrate = scripts/migrate.sh, up/down = docker compose, test).
- [ ] `.env.example` 최종 점검(T02 키와 server/relay/worker가 읽는 env 정합).
- 수용: 문서 존재 + Makefile/.env 정합. runtime 미검증 범위는 `runtime-unverified`로 표기.

---

## 전체 빌드 검증 (수용 게이트)

- [ ] `swift build` green — `clients/Core` (T04)
- [ ] `swift build` green — `server` (T05)
- [ ] `swift build` green — `relay/OutboxRelay` (T06)
- [ ] `swift build` green — `workers/AgentWorker` (T07)
- [ ] `swift build` green — `clients/macOS` (lib + smoke) (T09)
- [ ] `python3 -m py_compile` 통과 — `adapters/hermes/momo_adapter.py` (T08)
- [ ] 파일 정합 — `infra/*` · `server/Migrations/*` · `scripts/migrate.sh` · `docs/RUN.md` (T02/T03/T10)
- [ ] **런타임** → Docker/psql 가능한 항목은 M1 goal에서 실제 검증하고, hermes 등 외부 의존이 필요한 항목만 `runtime-unverified`로 표기한다.

---

# Local AI · Agent Protocol · Enterprise Trust 확장 티켓

> 이 섹션은 기존 T01~T10 빌드 순서를 바꾸지 않는다. M1 런타임이 MOMO-001~004로 닫힌 뒤, 운영·제품 차별화를 강화하기 위한 Codex goal 후보들이다.

## M1 운영 정본

| id | 한줄 | 수용기준 등급 | 의존 |
|---|---|---|---|
| `MOMO-110` | Local LLM/Agent Protocol/Google Workspace/Trust 리서치와 로드맵 문서화 | docs/spec | M0 |
| `MOMO-154` | GitHub Actions 자동 실행 차단과 local gate 우선순위 격상 | ci/docs | MOMO-110 |
| `MOMO-111` | GitHub Actions 비주요 기간용 local PR gate 스크립트와 evidence flow | ci/docs | MOMO-110, MOMO-154 |
| `MOMO-112` | 5개+ Codex session/worktree 운영 자동화와 status board | infra/docs | MOMO-110, MOMO-111 |
| `MOMO-115` | runtime-relay local gate 자동화(server send→outbox→relay→Centrifugo evidence) | runtime/infra | MOMO-111, MOMO-002, MOMO-003 |
| `MOMO-194` | local gate evidence/log 파일명 병렬 실행 충돌 방지 | tooling/docs | MOMO-111, MOMO-112 |
| `MOMO-150` | Hermes/Kim Intern/openclaw agent runtime 분석과 roadmap | docs/spec | MOMO-110 |
| `MOMO-180` | Paca/OpenHands/Linear/Rovo/GitHub agentic work OS 시장 분석 + repo topology ADR | docs/spec | MOMO-150 |
| `MOMO-005` | docker-compose.prod 기반 staging/prod skeleton(Caddy 자동TLS + Centrifugo Redis engine) | infra/docs | MOMO-001~004 |
| `MOMO-006` | SOPS/age secret lifecycle + pgBackRest PITR skeleton | infra/docs | MOMO-005 |
| `MOMO-007` | VPS 시크릿 없는 local/staging smoke gate + RUN/DEPLOY 런북 고정 | infra/docs | MOMO-005, MOMO-006 |

### MOMO-110 수용기준 `[docs/spec]`
- [ ] `research/10-local-ai-protocol-trust/`에 Apple local LLM, Context Broker, Agent Protocol, Google Workspace, Trust, local ops 연구 문서 추가.
- [ ] `ROADMAP.md`, `docs/BACKLOG.md`, `BUILD_TICKETS.md`, `docs/INDEX.md`, `STATUS.md`에 새 에픽/티켓/진행 상태 반영.
- [ ] build-macos-apps 플러그인은 SwiftPM build/test/triage와 SwiftPM GUI app 실행 표준화에 적극 사용하되, store signing/notarization은 M4에서 분리한다는 원칙 기록.

### MOMO-111 수용기준 `[ci/docs]`
- [ ] `scripts/local_gate.sh --profile docs|swift|staging-smoke|runtime-db|runtime-relay|runtime-agent|macos-ui|all` 설계/구현.
- [ ] PR body에 machine/toolchain/commands/runtime coverage evidence를 붙일 수 있는 출력 제공.
- [ ] GitHub Actions 비주요 기간에는 local evidence + review pass + no unrelated dirty files를 merge gate로 사용한다고 `docs/LOCAL_PR_GATE.md`, `docs/GITHUB_OPS.md`, PR template에 문서화.

### MOMO-154 수용기준 `[ci/docs]`
- [ ] 원격 `ci-build`, `release-ios`, `release-macos` workflow가 `disabled_manually` 상태임을 확인.
- [ ] `.github/workflows/*.yml`의 자동 `push`/`pull_request`/tag 트리거를 제거하고 `workflow_dispatch` 전용으로 둔다.
- [ ] `docs/LOCAL_PR_GATE.md`, `docs/GITHUB_OPS.md`, `ROADMAP.md`, `docs/BACKLOG.md`, `STATUS.md`에 비용 방지와 local gate 우선 정책을 반영한다.

### MOMO-112 수용기준 `[infra/docs]`
- [ ] issue/branch/worktree/PR/local gate 상태를 `scripts/goal_status.sh` status board에서 확인.
- [ ] `scripts/goal_claim.sh`, `scripts/goal_release.sh`, `.conductor/setup.sh`가 status board 운영 흐름과 연결된다.
- [ ] worktree별 `.env.worktree`, `COMPOSE_PROJECT_NAME`, `PORT`, `POSTGRES_PORT`, `CENT_PORT`, `HERMES_PORT` 충돌 방지 확인.
- [ ] `momo-main` orchestration thread와 worker thread handoff prompt 문서화.

### MOMO-115 수용기준 `[runtime/infra]`
- [x] `scripts/verify_relay.sh`가 seeded demo user login + REST send로 outbox `pending`을 만들고, relay 시작 후 SKIP LOCKED claim(`attempts>=1`) + Centrifugo history + outbox `done`을 검증한다.
- [x] `version=message.seq` evidence를 DB message response, outbox payload version, Centrifugo history publication의 동일 message id/seq로 남긴다.
- [x] `scripts/local_gate.sh --profile runtime-relay`가 Docker compose/migrate/server/relay/message send/evidence 검증을 자동 실행한다.
- [x] worktree별 `.env.worktree` 포트/`COMPOSE_PROJECT_NAME` isolation을 사용한다.
- [x] 실패 시 local gate evidence log와 verifier server/relay/history log path를 남긴다.

### MOMO-194 수용기준 `[tooling/docs]`
- [x] GitHub #144를 `scripts/goal_claim.sh 144`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/local_gate.sh` evidence/log filename에 pid, nanosecond timestamp, random suffix, worktree hash를 포함한다.
- [x] 같은 초에 같은 docs gate를 2개 이상 병렬 실행해도 evidence/log 파일 충돌이 나지 않는다.
- [x] PR body에 붙일 `Evidence markdown` 및 `Evidence log` path가 `## Local Gate` block에 정확히 출력된다.
- [x] `docs/LOCAL_PR_GATE.md`, `STATUS.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #144를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-005 수용기준 `[infra/docs]`
- [x] `scripts/goal_claim.sh 5` 시도. 이슈가 `status:ready`가 아니어서 fallback으로 별도 worktree/branch를 수동 생성하고 issue `status:in-progress`를 적용.
- [x] `infra/prod/docker-compose.prod.yml`: Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker 서비스 skeleton.
- [x] `infra/prod/Caddyfile`: api/rt 도메인 라우팅 + 보안 헤더. Centrifugo subscribe proxy는 compose 내부 `api:8080` 유지.
- [x] `infra/prod/centrifugo.prod.json`: dev namespace 계약 유지 + Redis engine 전환.
- [x] `infra/prod/.env.example`: production env 예시만 제공, 실제 시크릿 미커밋.
- [x] `docs/RUN.md`, `docs/DEPLOY.md`, `STATUS.md`, `ROADMAP.md` 갱신.
- [x] `scripts/local_gate.sh --profile docs` PASS.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 `momo-main` handoff.

### MOMO-006 수용기준 `[infra/docs]`
- [x] `.sops.yaml.example` — SOPS creation rule template. 실제 public recipient/age private key는 미포함.
- [x] `infra/prod/secrets.env.example` — staging/prod secret shape. 실제 production secret은 미커밋.
- [x] `infra/prod/pgbackrest.conf.example`, `postgresql.pgbackrest.conf.example`, `pgbackrest-cron.example` — PITR skeleton.
- [x] `docs/SECRETS_BACKUP_RUNBOOK.md` — SOPS/age setup, encryption/decryption, pgBackRest stanza/check/full backup/PITR rehearsal 절차.
- [x] 실제 staging host, age private key, object-store credential, pgBackRest stanza/check/full backup/PITR restore rehearsal은 `runtime-unverified`로 남김.

### MOMO-007 수용기준 `[infra/docs]`
- [x] GitHub #7 claim: `scripts/goal_claim.sh --force 7`로 별도 worktree/branch `docs/7-staging-run` 생성, issue assign + `status:in-progress`.
- [x] `scripts/verify_staging_smoke.sh` — prod compose config validation, Caddyfile structural validation, Centrifugo prod config validation, secret placeholder/real-secret guard, SOPS/pgBackRest checklist validation.
- [x] `scripts/local_gate.sh --profile staging-smoke` — PR-ready local gate profile 추가.
- [x] `docs/RUN.md`, `docs/DEPLOY.md`, `docs/SECRETS_BACKUP_RUNBOOK.md`, `docs/LOCAL_PR_GATE.md`에 local gate와 host-runtime 경계를 기록.
- [x] pgBackRest stanza/check/full backup/PITR restore rehearsal은 실제 host/secrets 없이는 `runtime-unverified`로 유지.
- [x] `scripts/local_gate.sh --profile staging-smoke` PASS.
- [x] `scripts/local_gate.sh --profile docs` PASS.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [x] PR 생성 후 issue `status:needs-review` 및 merge 금지.

### MOMO-150 수용기준 `[docs/spec]`
- [ ] `research/11-agent-runtime/`에 Hermes agent, internkim/Kim Intern, openclaw 분석 문서 추가.
- [ ] memory/cache/protocol gap을 Context Packet, Memory Plane, Capability Cache, A2A lifecycle, approval pause/resume 관점으로 정리.
- [ ] ROADMAP/BACKLOG/INDEX/STATUS에 MOMO-151~153, MOMO-160~163, MOMO-170~172 후속 로드맵 반영.
- [ ] 코드/스키마 구현 없이 문서/스펙만 변경.

## M1.5 Agentic Work OS / Plugin Ecosystem Strategy

| id | 한줄 | 수용기준 등급 | 의존 | 상태 |
|---|---|---|---|---|
| `MOMO-180` | Paca/OpenHands/Linear/Rovo/GitHub 흐름 기반 제품 포지션 + repo topology + deploy layering ADR | docs/spec | MOMO-150 | PR/local gate 대상 |
| `MOMO-181` | Plugin manifest v0 + catalog split criteria | docs/spec | MOMO-153, MOMO-180 | PR/local gate 대상 |
| `MOMO-182` | Docker compose layer ADR: dev/e2e/prod/install/backup | infra/docs | MOMO-005, MOMO-007, MOMO-180 | 완료 |
| `MOMO-186` | Deterministic e2e compose stack for local gates | infra/docs | MOMO-182, MOMO-115 | local gate 대상 |
| `MOMO-183` | First-party plugin repo strategy: GitHub, Google Workspace, Jira-like, Docs | docs/spec | MOMO-122, MOMO-180, MOMO-181 | 완료 |
| `MOMO-184` | Agent host positioning/product messaging: channel timeline execution ledger | docs/product | MOMO-180 | 완료 |

### MOMO-180 수용기준 `[docs/spec]`
- [x] `research/12-agentic-work-os/01-agentic-work-os-market-analysis.md`에 Paca/OpenHands/Linear/Rovo/GitHub/Slack/MCP/A2A 흐름과 momo 차별점을 정리한다.
- [x] `docs/adr/0001-agentic-work-os-repo-topology.md`에 core monorepo 유지와 향후 `momo-plugins`, first-party plugin repos, plugin SDK repos, `momo-mcp`, `momo-landing`, private `momo-signing` split 기준을 정의한다.
- [x] Docker/deploy layering을 dev/e2e/prod/install/upgrade/backup으로 분리하는 방향을 ADR에 기록한다.
- [x] ROADMAP/BUILD_TICKETS/STATUS/docs/INDEX 갱신.
- [x] `scripts/local_gate.sh --profile docs` PASS.
- [ ] PR 생성 후 리뷰, 필요 수정, merge, main docs local gate PASS.

### MOMO-181 수용기준 `[docs/spec]`
- [x] Plugin Manifest v0 정본: `research/12-agentic-work-os/02-plugin-manifest-v0.md`.
- [x] 최소 manifest fields 정의: `id`, `name`, `version`, `publisher`, `runtime`, `surfaces`, `capabilities`, `tool_schema_refs`, `approval_policy`, `risk`, `source_policy`, `audit_policy`, `compatibility`, `signature`.
- [x] plugin catalog repo(`momo-plugins`) split 기준, artifact metadata, signed artifact policy, compatibility matrix를 문서화.
- [x] first-party plugin repo와 SDK repo 분리 기준을 문서화.
- [x] Context Packet `tool_grants`, Capability Cache `plugin_tool_schema`, Memory Plane `permissions.retrieval_policy_version`/plugin policy version 연결을 명시.
- [x] JSON fixture 3종: GitHub Issues plugin manifest, Google Workspace read-mostly source plugin manifest, high-risk write action approval policy example.
- [ ] `scripts/local_gate.sh --profile docs` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 merge 금지.
- out of scope: 실제 plugin runtime, repo split 생성, WASM runtime, marketplace UI, external OAuth implementation.

### MOMO-182 수용기준 `[infra/docs]`
- [x] `docs/adr/0002-docker-compose-layering.md`에 `infra/docker-compose.yml`의 현재 dev 역할과 future `docker-compose.dev.yml`/`docker-compose.e2e.yml`/`infra/prod/docker-compose.prod.yml` 경계를 ADR로 고정.
- [x] source checkout 없는 image-based prod deploy, install/upgrade script, backup/PITR, optional external DB/TLS/agent runtime 선택지를 정의.
- [x] 실제 prod deploy, image publish pipeline, pgBackRest restore rehearsal, GitHub Actions 재활성화, staging/prod secret 입력은 out of scope로 명시.
- [ ] `scripts/local_gate.sh --profile docs` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 merge 금지.

### MOMO-186 수용기준 `[infra/docs]`
- [x] `infra/docker-compose.e2e.yml` 추가: Postgres, Centrifugo, migrate, e2e role bootstrap, API, OutboxRelay, AgentWorker, mock-Hermes service boundary를 한 compose project 안에 둔다.
- [x] dev compose(`infra/docker-compose.yml`)는 PG18+Centrifugo local iteration, e2e compose는 deterministic local gate, prod compose(`infra/prod/docker-compose.prod.yml`)는 source checkout 없는 image-based deploy로 책임을 분리했다.
- [x] `.env.worktree`/`COMPOSE_PROJECT_NAME`/host port env를 사용해 worktree별 project-name과 host ports가 분리된다.
- [x] `docker compose --env-file .env.worktree -f infra/docker-compose.e2e.yml config` PASS.
- [x] `scripts/local_gate.sh --profile docs`에 e2e compose config validation 연결.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 merge 금지.
- out of scope: 실제 prod deploy, image publish, GitHub Actions 재활성화, real staging VPS/TLS/PITR, full e2e stack runtime verifier.

### MOMO-183 수용기준 `[docs/spec]`
- [x] first-party plugin 우선순위를 GitHub/GitHub Issues, Google Workspace, Jira-like work item, Docs connector로 정의.
- [x] 각 plugin이 제공할 slash command, message context action, approval card, source provider, audit event를 표로 고정.
- [x] repo split 순서와 private/public visibility 기준을 정의.
- [x] Plugin Manifest v0, Context Packet `tool_grants`, Capability Cache `plugin_tool_schema`, Memory Plane permission model과 연결.
- [x] ROADMAP/BUILD_TICKETS/STATUS/docs/INDEX 갱신.
- [ ] `scripts/local_gate.sh --profile docs` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 merge 금지.
- out of scope: 실제 plugin runtime, repo split 생성, external OAuth/provider API execution, WASM runtime, marketplace UI.

### MOMO-184 후보 수용기준 `[docs/product]`
- [x] momo 제품 문장을 "channel timeline execution ledger" 중심으로 정리.
- [x] Slack/Discord/Mattermost/Paca/OpenHands와의 차이를 대표/팀원 설명용으로 1페이지로 정리.
- [x] website/README/세일즈 deck에 재사용 가능한 copy block을 작성.
- [x] agent host / protocol surface / self-hosted trust boundary / local LLM future 방향 반영.
- [x] `research/12-agentic-work-os/03-agent-host-positioning.md`, `README.md`, `ROADMAP.md`, `BUILD_TICKETS.md`, `STATUS.md`, `docs/INDEX.md` 갱신.
- [x] `scripts/local_gate.sh --profile docs` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 merge 금지.

## M2 멀티팀 온보딩

| id | 한줄 | 수용기준 등급 | 의존 | 상태 |
|---|---|---|---|---|
| `MOMO-010` | `003_onboarding.sql` invite_code + redemption audit + RLS FORCE | sql/runtime | MOMO-003 | local gate PASS |
| `MOMO-011` | 초대코드 발급/조회/폐기 REST + redeem 최소 slice | swift/runtime | MOMO-010 | local gate PASS |
| `MOMO-012` | macOS dev app onboarding/invite flow v0 UI (LiveChatBackend stub) | swift/macos-ui | MOMO-010, MOMO-011 | local gate PASS |
| `MOMO-013` | platform_admin 전역 추적 뷰/엔드포인트 | sql/swift/runtime | MOMO-010 | local gate PASS |
| `MOMO-014` | production `/v1/join` 자가가입 플로우 + audit_log | swift/runtime | MOMO-011, MOMO-012 | local gate 대상 |
| `MOMO-176` | workspace roster REST endpoints v0 | swift/runtime | MOMO-014 | local gate 대상 |

### MOMO-010 수용기준 `[sql/runtime]`
- [x] `server/Migrations/003_onboarding.sql` 신규 추가(`schema_v0.sql` 미수정).
- [x] raw invite code는 저장하지 않고 `momo_generate_invite_code()` + `momo_invite_code_hash(raw_code)` 패턴으로 high-entropy bearer secret을 해시 저장한다.
- [x] `invite_code`에 `workspace_id`, `role`, `max_uses`, `used_count`, `expires_at`, `revoked_at`, `revoked_by`, `created_by`, `last_used_at`을 두고 same-workspace member FK와 active lookup index를 둔다.
- [x] `invite_code_redemption`으로 성공 redemption audit trail을 남긴다.
- [x] `invite_code`/`invite_code_redemption`을 신규 RLS DO-block에 등록하고 `FORCE ROW LEVEL SECURITY` + `SET LOCAL app.workspace_id` 원칙을 유지한다.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.

### MOMO-011 수용기준 `[swift/runtime]`
- [x] `InviteRoutes` 추가: `POST /v1/workspaces/{ws}/invites` create, `GET /v1/workspaces/{ws}/invites` list, `POST /v1/workspaces/{ws}/invites/{invite}/revoke` revoke.
- [x] `POST /v1/workspaces/{ws}/invites/redeem`은 authenticated member가 자기 member_id로 invite를 최소 redemption 처리한다. self-signup의 member/human/membership 생성은 MOMO-014 범위로 남긴다.
- [x] create/list/revoke는 path workspace와 JWT workspace 일치 + owner/admin active membership을 요구하고, redeem은 active workspace member를 요구한다.
- [x] raw invite code는 create 응답에서만 반환하고, DB에는 MOMO-010의 `momo_invite_code_hash(raw_code)`만 저장한다.
- [x] 모든 invite DB 접근은 `SET LOCAL app.workspace_id`가 적용되는 tenant transaction에서 실행해 RLS FORCE와 same-workspace FK를 유지한다.
- [x] 로컬 HTTP smoke PASS: login 200 → invite create 201 → list 200 → redeem 200 → revoke 200.
- [x] `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-db` PASS(전체 swift build/test 포함).
- [x] Swift local gate PASS는 `runtime-db` profile의 `make build` + `make test` 단계로 함께 검증.

### MOMO-012 수용기준 `[swift/macos-ui]`
- [x] `MomoMacDevApp`에서 invite code 입력 UI와 idle/validating/success/failure 상태를 볼 수 있다.
- [x] `LiveChatBackend` stub이 `MOMO-012`/`MOMO-DEV` 성공, `EXPIRED`/`USED-UP`/기타 실패 상태를 결정적으로 반환한다.
- [x] 기존 channel/message/approval/cost UI와 `MomoMacRootView` API를 유지한다.
- [x] `swift test --package-path clients/macOS` PASS(10 tests).
- [x] `scripts/local_gate.sh --profile macos-ui` PASS.
- [x] `scripts/local_gate.sh --profile swift` PASS.
- out of scope였던 production server `/v1/join` 구현과 DB-backed invite redemption e2e는 MOMO-014에서 서버 runtime slice로 진행한다.

### MOMO-013 수용기준 `[sql/swift/runtime]`
- [x] v0 platform admin token/scope gate: `PLATFORM_ADMIN_EMAILS` allowlist와 `PLATFORM_ADMIN_LOGIN_SECRET`이 모두 맞는 login에만 `platform:read` scope를 부여한다.
- [x] `GET /v1/platform/workspaces`, `/v1/platform/members`, `/v1/platform/invites` read-only endpoint 추가.
- [x] 일반 tenant token은 platform endpoint 접근 403.
- [x] platform read path는 `PLATFORM_ADMIN_DATABASE_URL` 별도 BYPASSRLS + SELECT-only role과 read-only transaction으로 전 tenant 조회.
- [x] tenant write/read path는 기존 `DATABASE_URL` + `withTenantTransaction`/`SET LOCAL app.workspace_id` 경로를 유지하고 BYPASSRLS를 쓰지 않는다.
- [x] `scripts/verify_platform_admin.sh` 추가: 두 개 이상 workspace fixture에서 workspace/member/invite usage 전역 조회, agent metadata, invite raw/hash secret 미노출 검증.
- [x] `scripts/local_gate.sh --profile runtime-db`에 platform verifier 연결.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS.

### MOMO-014 수용기준 `[swift/runtime]`
- [x] Public `POST /v1/join` route를 authenticated workspace-member middleware 밖에 추가.
- [x] invite code + email/display name/handle request로 human/member를 생성 또는 재사용하고, workspace public channel membership, invite redemption, `audit_log(action='invite.join')`, access/refresh token receipt를 생성.
- [x] invite lookup은 workspace별 `SET LOCAL app.workspace_id` tenant read로 수행하고, 실제 write path는 `withTenantTransaction` 아래에서 처리한다. `schema_v0.sql` 변경 없음.
- [x] expired/revoked/exhausted/invalid/duplicate/role-escalation 실패를 결정적 HTTP status로 처리한다. owner/platform admin 생성은 public join에서 금지.
- [x] `scripts/verify_join.sh` 추가: invite create → public join → joined human login/bootstrap/read, 실패 모드 6종 검증.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS(`scripts/verify_rls.sh` + `scripts/verify_join.sh`).

### MOMO-176 수용기준 `[swift/runtime]`
- [x] `GET /v1/workspaces/{ws}/roster`와 호환 alias `GET /v1/workspaces/{ws}/members`를 authenticated tenant route로 추가한다.
- [x] 일반 tenant token은 path workspace와 JWT workspace가 일치하고, `SET LOCAL app.workspace_id` 아래 active workspace membership guard를 통과해야 roster를 조회할 수 있다.
- [x] roster 응답은 active, non-deleted `member` 중 active membership이 있는 항목을 반환하고 `kind='human'|'agent'`와 human/agent count를 명시한다. agent row는 model/owner/run-limit metadata만 노출하고 base_url/system_prompt/tool_schema/config/secret은 노출하지 않는다.
- [x] BYPASSRLS 사용 금지: normal tenant `Database.withTenantConnection` 경로만 사용한다.
- [x] focused server tests 추가: kind filter/limit validation, human/agent DTO shape decode.
- [x] `scripts/verify_roster.sh` 추가: demo human+agent roster, `kind=agent` filter, invalid kind 400, same-workspace nonmember 403, workspace A/B 교차 접근 403.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS(`scripts/verify_roster.sh` 포함).


## M2 Context / Memory / Google Workspace

| id | 한줄 | 수용기준 등급 | 의존 |
|---|---|---|---|
| `MOMO-120` | Context Packet v0 spec and fixtures | spec/swift | MOMO-003, MOMO-110 |
| `MOMO-121` | Memory Plane v0 spec and permission model | spec | MOMO-120 |
| `MOMO-122` | Google Workspace connector v0: per-user OAuth read-mostly sync | runtime/spec | MOMO-120, MOMO-121 |
| `MOMO-123` | Google Workspace enterprise admin install + DWD option design | spec/manual | MOMO-122 |
| `MOMO-151` | Context Packet v0 deep spec and fixtures | spec | MOMO-150 |
| `MOMO-152` | Memory Plane v0 deep spec and permission model | spec | MOMO-151 |
| `MOMO-153` | Capability Cache v0 spec and invalidation model | spec | MOMO-151, MOMO-152 |

### MOMO-151 수용기준 `[spec]`
- [ ] `research/11-agent-runtime/04-context-packet-v0.md`에 Context Packet v0 top-level shape, 필수 필드, 금지 필드, runtime envelope를 정의.
- [ ] `research/11-agent-runtime/fixtures/context-packet-v0/`에 mention, slash command, message context action JSON fixture 3종 추가.
- [ ] Hermes/Kim Intern/OpenAI-compatible SSE 경로는 같은 runtime envelope를 쓰고, openclaw식 approval availability/presentation/transport/interactions/observe 분리는 momo 소유 경계로 반영.
- [ ] 코드/스키마 구현 없이 문서/fixture만 변경하며, `jq`와 기존 build/test gate를 통과.

### MOMO-152 수용기준 `[spec]`
- [ ] `research/11-agent-runtime/05-memory-plane-v0.md`에 Memory Plane v0의 memory item shape, type, source attribution, visibility, permission, expiry/delete/revocation 모델을 정의.
- [ ] `decision/preference/artifact_ref/task_state/external_source_ref/agent_skill_note` 6개 memory type을 고정하고, raw chat exhaust/credential/unbounded summary류는 v0 금지 타입으로 명시.
- [ ] `research/11-agent-runtime/fixtures/memory-plane-v0/`에 typed memory item, retrieval 허용 projection, retrieval 거부 permission examples를 추가.
- [ ] Context Packet v0의 `memory_refs`가 Memory Plane item에서 projection되는 방식과 retrieval-time permission check를 연결.
- [ ] 코드/스키마 구현 없이 문서/fixture만 변경하며, `jq`와 기존 build/test gate를 통과.

### MOMO-153 수용기준 `[spec]`
- [ ] `research/11-agent-runtime/06-capability-cache-v0.md`에 Capability Cache v0의 cache entry shape, cache kind, source, tool schema, visibility, TTL, invalidation, audit 모델을 정의.
- [ ] `agent_capability`, `plugin_tool_schema`, `mcp_tool_list`, `model_pricing` 4개 cache kind를 고정하고, context summary/source body 저장은 v0 Capability Cache 밖으로 분리한다.
- [ ] `research/11-agent-runtime/fixtures/capability-cache-v0/`에 capability list snapshot, plugin tool schema projection, invalidation/audit examples를 추가한다.
- [ ] Context Packet v0의 `tool_grants.input_schema_ref`가 Capability Cache entry에서 projection되는 방식과 approval/risk policy check를 연결한다.
- [ ] Memory Plane v0의 `retrieval_policy_version`과 provider grant revoke/source revalidation 관계를 연결한다.
- [ ] 코드/스키마 구현 없이 문서/fixture만 변경하며, `jq`와 기존 build/test gate를 통과.

### MOMO-122 수용기준 `[spec]`
- [x] `research/11-agent-runtime/12-google-workspace-connector-v0.md`에 Google Workspace connector v0의 per-user OAuth, scope policy, token boundary, revocation/delete model을 정의한다.
- [x] Drive changes/selected file excerpt, Gmail thread/search, Calendar availability/events read path를 read-mostly sync로 고정한다.
- [x] Google refs가 Context Packet `sources`/`source_refs`, Memory Plane `external_source_ref`, Capability Cache `tool_grants`로 projection되는 방식을 연결한다.
- [x] `research/11-agent-runtime/fixtures/google-workspace-connector-v0/`에 Drive, Gmail, Calendar JSON fixture 3종을 추가한다.
- [x] Gmail send, Calendar create/update, Drive share/upload/permission change 등 external write는 approval-gated 또는 v0 out of scope로 명시한다.
- [x] 코드/스키마 구현 없이 문서/fixture만 변경하며, `scripts/local_gate.sh --profile docs`를 통과한다.

### MOMO-123 수용기준 `[spec/manual]`
- [x] GitHub issue #114 claim: `docs/114-google-workspace-enterprise-admin-install-v0-spec-and-fixtures` 별도 worktree/branch + issue assign + `status:in-progress`.
- [x] `research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md`에 enterprise admin install / domain-wide delegation v0 정본을 추가한다.
- [x] Domain-wide delegation을 MOMO-122 per-user OAuth 기본값과 분리하고, enterprise-only admin option으로 고정한다.
- [x] admin consent, service account boundary, scope inventory, user delegation, audit export, revoke/delete flow를 정의한다.
- [x] Context Packet, Memory Plane, Capability Cache projection/revalidation/invalidation과 연결한다.
- [x] `research/11-agent-runtime/fixtures/google-workspace-enterprise-admin-v0/`에 JSON fixture 3종을 추가한다.
- [ ] 실제 Google Workspace admin 승인, API Controls 설정, OAuth verification, service account credential setup은 사람 `[manual]` 범위로 남긴다.
- [ ] `scripts/local_gate.sh --profile docs` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 merge 금지.

### MOMO-161 수용기준 `[spec/swift/runtime]`
- [x] `research/11-agent-runtime/08-approval-pause-resume-runtime.md`에 approval pause/resume 정본을 추가한다.
- [x] `tool_call → approval_request → approval_decision → resume/deny → tool_result/audit` 흐름과 same-run resume 모델을 정의한다.
- [x] DB/Swift/server/worker 변경 범위를 정리하고, `schema_v0.sql`은 수정하지 않는다.
- [x] AgentWorker가 approval-required `tool_call`에서 `approval(status='pending')`, `message.type='approval_request'`, `agent_run.status='awaiting_approval'`, `audit_log`를 기록하는 최소 pause slice를 컴파일 가능한 코드로 추가한다.
- [x] `research/11-agent-runtime/fixtures/approval-pause-resume-v0/` fixture와 AgentWorker smoke test를 추가한다.
- [x] Server approval decision endpoint는 MOMO-167, AgentWorker deterministic resume-job execution은 MOMO-178에서 후속 runtime slice로 닫는다. Expiry sweeper와 real provider side-effect execution은 별도 후속 `runtime-unverified`.

핵심 원칙:

- Context Packet은 `{goal,constraints,decisions,sources,permissions,budget,redactions}`를 고정 필드로 시작한다.
- 장기 메모리는 raw chat exhaust가 아니라 `decision/preference/artifact/task_state/external_source_ref`로 제한한다.
- Google Workspace v0는 per-user OAuth + read-mostly sync다. Domain-wide delegation은 enterprise-only option이며, write는 approval card 뒤로 둔다.

## M3 Local LLM UX / Agent Protocol / macOS Dev Loop

| id | 한줄 | 수용기준 등급 | 의존 |
|---|---|---|---|
| `MOMO-130` | macOS Foundation Models capability probe | swift | MOMO-110 |
| `MOMO-131` | Local Context Copilot | swift/manual | MOMO-120, MOMO-130 |
| `MOMO-132` | Agent Protocol v0 DB/wire/Swift/card alignment | spec/swift/runtime | MOMO-120, MOMO-121, MOMO-004 |
| `MOMO-133` | Google Workspace "ask my work" UX | swift/runtime | MOMO-122, MOMO-132 |
| `MOMO-134` | build-macos-apps based SwiftPM GUI run loop | swift/xcode/manual | MOMO-110 |
| `MOMO-160` | A2A-style agent_run lifecycle alignment | spec/sql/swift | MOMO-151, MOMO-004 |
| `MOMO-161` | approval pause/resume runtime | spec/swift/runtime | MOMO-160 |
| `MOMO-166` | approval decision server contract v0 | spec/docs | MOMO-161, MOMO-171 |
| `MOMO-167` | approval decision endpoint runtime | swift/sql/runtime | MOMO-161, MOMO-166, MOMO-171 |
| `MOMO-178` | AgentWorker approved tool resume executor v0 | swift/runtime | MOMO-161, MOMO-165, MOMO-166, MOMO-167 |
| `MOMO-185` | AgentWorker all-profile local gate isolation hotfix | runtime/tooling | MOMO-167, MOMO-178 |
| `MOMO-162` | Hermes adapter contract verification | spec/python | MOMO-150, MOMO-004 |
| `MOMO-168` | Hermes adapter repo-local smoke harness | python/docs | MOMO-162 |
| `MOMO-163` | inbound MCP server v0 spec and fixtures | spec/swift | MOMO-151, MOMO-153 |
| `MOMO-172` | inbound MCP server v0 skeleton/spec-to-code bridge | swift/docs | MOMO-163 |
| `MOMO-165` | Capability Cache approval metadata gate | swift | MOMO-151, MOMO-153, MOMO-161, MOMO-164 |
| `MOMO-170` | macOS agent protocol cards | spec/swift | MOMO-132, MOMO-161 |
| `MOMO-171` | macOS approval_request card decisions | swift/spec | MOMO-170 |
| `MOMO-174` | local LLM context compaction | swift/spec | MOMO-130, MOMO-151 |
| `MOMO-177` | macOS MomoServer REST ChatBackend v0 | swift/macos-ui | MOMO-105, MOMO-134, MOMO-170, MOMO-171 |
| `MOMO-179` | Realtime client subscription contract v0 | spec/swift | MOMO-177, MOMO-115 |

### MOMO-130 수용기준 `[swift]`
- [x] GitHub #98을 `status:in-progress`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `clients/macOS` target에만 `#if canImport(FoundationModels)` import와 `#available(macOS 26.0, *)` guard를 둔다. `MomoCore`는 Foundation-only 유지한다.
- [x] `SystemLanguageModel.default.availability`를 momo 내부 `available`/`fallback` state로 매핑한다.
- [x] 미지원 OS/toolchain, device ineligible, Apple Intelligence off, model-not-ready fallback mapping 테스트를 추가한다.
- [x] `MomoMacDevApp` sidebar에 작고 명확한 Local LLM capability state surface를 추가한다.
- [x] `swift run --package-path clients/macOS MomoMacDevApp` launch 후 window 1개를 확인한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #98을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-131 수용기준 `[swift/macos-ui]`
- [x] GitHub #105를 `scripts/goal_claim.sh 105`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `clients/macOS`에 Local Context Copilot service/model을 추가한다.
- [x] Foundation Models capability available/fallback state를 copilot route로 매핑한다.
- [x] unsupported OS/toolchain/device/model-not-ready 계열에서는 deterministic fallback preview가 동일 UI에서 동작한다.
- [x] visible channel context에서 summary, classification, compact context preview를 제공한다.
- [x] source/citation hint(`S1` 등)와 `momo://channels/.../messages/...` URI를 preview에 보존한다.
- [x] PII/secret redaction preview hint를 fallback-safe하게 표시한다.
- [x] focused tests로 route, deterministic fallback, citation preservation, ViewModel refresh를 고정한다.
- [ ] `scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [ ] `scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #105를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-134 수용기준 `[swift/macos-ui]`
- [x] GitHub #112를 `scripts/goal_claim.sh 112`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] build-macos-apps SwiftPM GUI workflow를 참고하되 Xcode `.app` 패키징/공증/DMG/Sparkle은 out of scope로 유지한다.
- [x] `scripts/macos_dev_run.sh`가 `clients/macOS` SwiftPM `MomoMacDevApp`을 빌드하고 `dist/MomoMacDevApp.app` dev bundle로 staging한다.
- [x] launch, process smoke, System Events window smoke, unified log capture, telemetry capture, debug, terminate 옵션을 제공한다.
- [x] `.codex/environments/environment.toml` Run action이 `./scripts/macos_dev_run.sh`를 호출한다.
- [x] `scripts/local_gate.sh --profile macos-ui` 기본값은 `MomoMacSmoke`만 실행하고 GUI launch는 opt-in으로 유지한다.
- [x] `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] `scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] PR 생성 후 GitHub #112를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-177 수용기준 `[swift/macos-ui]`
- [x] GitHub #122를 `scripts/goal_claim.sh 122`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `clients/macOS`에 REST-backed `ChatBackend` v0를 추가한다.
- [x] base URL/token/workspace/channel 설정은 `MOMO_SERVER_BASE_URL`, `MOMO_ACCESS_TOKEN`, `MOMO_WORKSPACE_ID`, `MOMO_CHANNEL_ID` 등 dev-safe environment로 주입한다.
- [x] message history fetch는 MomoServer `GET /v1/workspaces/{ws}/channels/{ch}/messages` 응답을 `MomoCore.Message`로 변환한다.
- [x] message send는 REST `POST /v1/workspaces/{ws}/channels/{ch}/messages`와 `clientMsgId` idempotency key를 사용한다.
- [x] unauthorized/offline/decoding 실패는 `ChatViewModel.connectionError`와 timeline banner로 표시한다.
- [x] `LiveChatBackend.seedDemo()`는 dev fallback으로 유지한다.
- [x] focused macOS tests를 추가한다.
- [x] local MomoServer smoke 절차를 `docs/RUN.md`에 문서화한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #122를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-179 수용기준 `[spec/swift]`
- [x] GitHub #124를 `scripts/goal_claim.sh 124`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md`에 REST auth → realtime token, channel naming, subscribe authorization, event envelope, `message.seq` replay/idempotency/gap-fill, reconnect/resubscribe, macOS apply boundary를 고정한다.
- [x] `research/11-agent-runtime/fixtures/realtime-client-subscription-contract-v0/*.json`에 `message.new`, `approval.requested`, `approval.decided`, `agent.partial`, `agent.status`, gap/backfill scenario fixtures를 추가한다.
- [x] Server/worker publish payloads를 MomoCore realtime decode keys와 정렬한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #124를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-174 수용기준 `[swift/macos-ui]`
- [x] GitHub #113 (`MOMO-174`)을 `scripts/goal_claim.sh 113`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] 기존 `LocalContextCopilotService`를 Context Packet 스타일 compact output v1으로 확장한다.
- [x] summary/classification/redaction/source hints가 `momo.context_packet.compaction.v1` packet에서 안정적으로 파생된다.
- [x] source id/URI/citation이 compaction 후에도 `sourceReferences`와 compact output에 보존된다.
- [x] Foundation Models 실제 호출은 `canImport`/availability-safe wrapper 뒤에 두고, 미지원/오류 환경은 deterministic fallback으로 green 유지한다.
- [x] macOS sidebar compact context preview는 짧은 `sidebarPreview`와 bounded source row로 표시해 과도한 넘침을 피한다.
- [x] focused macOS tests로 deterministic fallback, Context Packet output, source/citation preservation, ViewModel refresh를 고정한다.
- [x] `scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] `scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] PR 생성 후 GitHub #113을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-163 수용기준 `[spec/swift]`
- [ ] `research/11-agent-runtime/09-inbound-mcp-server-v0.md`에 inbound MCP server v0 정본을 추가한다.
- [ ] 최소 MCP tool surface를 `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call`로 고정한다.
- [ ] MCP resources/prompts 후보를 정의하고, Context Packet `request.surface = "api"`와 연결한다.
- [ ] RLS/workspace/member/token 권한, audit event, approval-safe write 원칙을 명시한다.
- [ ] Memory Plane retrieval과 Capability Cache projection이 inbound MCP read/propose 경로를 어떻게 제한하는지 연결한다.
- [ ] `research/11-agent-runtime/fixtures/inbound-mcp-server-v0/`에 discovery snapshot과 approval-safe tool-call JSON fixture를 추가한다.
- [ ] 코드/스키마 구현 없이 문서/fixture만 변경하며, `jq`, docs local gate, swift local gate를 통과한다.

### MOMO-172 수용기준 `[swift/docs]`
- [x] GitHub #80을 `status:in-progress`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `server` package에 inbound MCP registry/model/route skeleton을 추가한다.
- [x] 최소 tool descriptor를 `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call`로 코드화한다.
- [x] 외부 MCP JSON-RPC transport/tool execution은 compile-safe stub으로 두고 `TODO(#80)`를 남긴다.
- [x] `docs/INBOUND_MCP.md`와 `docs/RUN.md`에 endpoint/security/permission model을 기록한다.
- [x] server smoke tests로 descriptor/scope/RLS/audit policy를 고정한다.
- [ ] `scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #80을 `status:needs-review`로 전환하고 momo-main에 handoff한다.

### MOMO-166 수용기준 `[spec/docs]`
- [x] GitHub #91을 `status:in-progress`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `research/11-agent-runtime/10-approval-decision-server-contract-v0.md`에 approve/reject/expire/resume server contract를 정본화한다.
- [x] `research/11-agent-runtime/fixtures/approval-decision-server-contract-v0/`에 request/response/effect JSON fixtures를 추가한다.
- [x] AgentWorker pause/resume, server decision endpoint, macOS `ChatBackend.decideApproval` 흐름을 한 sequence diagram으로 연결한다.
- [x] 실제 endpoint/idempotency migration/expiry sweeper/resume runtime e2e는 후속 runtime ticket으로 분리한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #91을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-167 수용기준 `[swift/sql/runtime]`
- [x] GitHub #111을 `status:in-progress`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `approval_decision` migration을 추가해 `client_decision_id` idempotency ledger와 FORCE RLS policy를 둔다. `schema_v0.sql` 정본은 수정하지 않는다.
- [x] `POST /v1/workspaces/{ws}/approvals/{approval}/decision`과 호환 `POST /v1/agent-runs/{run}/approval-decisions`를 추가한다.
- [x] app-role tenant transaction에서 active human + channel membership + workspace scope를 검증한다.
- [x] approve/reject/expired/idempotent retry/idempotency conflict를 durable approval/audit/outbox/message effects와 함께 처리한다.
- [x] approve는 same-run resume `outbox(kind='agent_job', method='resume_approval')` payload contract를 AgentWorker decoder와 연결한다.
- [x] server/worker focused tests와 `scripts/verify_approval_decision.sh` runtime verifier를 추가한다.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #111을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-178 수용기준 `[swift/runtime]`
- [x] GitHub #123을 `scripts/goal_claim.sh 123`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] AgentWorker가 `outbox.method='resume_approval'` 또는 `payload.resume_from_approval_id` resume job을 decode/dispatch한다.
- [x] `approval.status='approved'`, same-run/channel/agent, frozen `approved_tool_call`, approval-required `policy_evidence`, approved decision payload를 fail-closed로 검증한다.
- [x] v0 executor는 deterministic mock tool(`mock.echo`/`momo.mock.echo`/`deterministic.echo`)만 실행하고 arbitrary external tool/provider write는 실패 처리한다.
- [x] 성공 시 같은 `agent_run.id`에 `message(type='tool_result')`, `audit_log(action='approval.resume'/'tool.executed')`, broadcast outbox를 기록하고 resume job을 `done`으로 닫는다. 실패 시 failed outbox `last_error`와 failure audit을 남긴다.
- [x] reject/cancelled/expired/non-approved approval은 실행하지 않는다.
- [x] focused AgentWorker tests와 `scripts/verify_agent_worker.sh` approved resume runtime smoke를 추가한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] 가능하면 `scripts/local_gate.sh --profile runtime-agent` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #123을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-185 수용기준 `[runtime/tooling]`
- [x] GitHub #132를 hotfix issue로 발급하고 별도 branch/worktree에서 진행한다.
- [x] all-profile에서 `verify_approval_decision.sh`가 남긴 pending `resume_approval` job이 `verify_agent_worker.sh` 검증을 오염시키는 원인을 기록한다.
- [x] `scripts/verify_agent_worker.sh` 시작 시 demo workspace의 pending/processing `agent_job` queue를 정리해 자기 fixture만 검증한다.
- [x] all-profile에서 직전 OutboxRelay가 tool_result broadcast를 `done`으로 소비해도 verifier가 non-failed broadcast row를 인정한다.
- [x] MOMO-178의 unsupported external tool fail-closed 동작은 유지한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-agent` PASS.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile all` PASS.
- [ ] PR 생성/리뷰/머지 후 issue #132를 `status:done`으로 전환한다.

### MOMO-162 수용기준 `[spec/python]`
- [x] GitHub #99를 `scripts/goal_claim.sh 99`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `research/11-agent-runtime/11-hermes-adapter-contract-v0.md`에 두 Hermes integration mode를 정본화한다.
- [x] product default를 AgentWorker OpenAI-compatible SSE로 결정하고, 판단 기준을 momo-owned Context Packet / approval / cost / audit로 고정한다.
- [x] `research/11-agent-runtime/fixtures/hermes-adapter-contract-v0/`에 OpenAI-compatible SSE input fixture와 platform adapter event mapping fixture를 추가한다.
- [x] `adapters/hermes/tests/test_momo_adapter_contract.py`로 Hermes SDK 없이 payload/mapping contract를 검증한다.
- [x] 외부 구현 코드는 복사하지 않고 wire shape/decision만 문서화한다.
- [x] `python3 -m py_compile adapters/hermes/momo_adapter.py` PASS.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #99를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-168 수용기준 `[python/docs]`
- [x] GitHub #106을 `scripts/goal_claim.sh 106`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `adapters/hermes/tests/smoke_momo_adapter.py` repo-local smoke harness를 추가한다.
- [x] smoke harness가 `platform_adapter_event_mapping.json` Centrifugo fixture를 adapter event로 unwrap하고 REST invoke/final-message call capture를 검증한다.
- [x] smoke harness는 Hermes SDK, aiohttp/websockets, Docker, Postgres, 네트워크 없이 실행된다.
- [x] `scripts/local_gate.sh --profile docs`가 smoke harness를 실행한다.
- [x] live Hermes gateway plugin load/e2e는 `runtime-unverified` 후속으로 명시한다.
- [x] `python3 -m py_compile adapters/hermes/momo_adapter.py` PASS.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #106을 `status:needs-review`로 전환하고 merge하지 않는다.

호환성 원칙:

- `FoundationModels` import는 platform target에만 둔다. `MomoCore`는 Foundation-only 유지.
- `#if canImport(FoundationModels)`와 OS availability fallback으로 현재 SwiftPM/local gate를 깨지 않는다.
- build-macos-apps 플러그인은 `swift build`, `swift test`, test triage, SwiftPM GUI `.app` staging, Codex Run action에 사용한다.

### MOMO-165 수용기준 `[swift]`
- [x] AgentWorker `agent_job.payload`가 Context Packet / Capability Cache projection의 `tool_grants` metadata를 받을 수 있다.
- [x] G6 approval gate가 `approval_policy=require_approval`/`always`를 approval pause로 처리한다.
- [x] `approval_policy=never/none/read_only`는 검증된 read-only grant(`grant=read`, `risk=read`)일 때만 approval 없이 진행한다.
- [x] metadata 없음/불일치/중복/unknown policy/source/risk alias 충돌은 approval-required로 fail-closed 처리한다.
- [x] 기존 MOMO-164 tool-name heuristic은 legacy fallback으로 격리하고, AgentWorker runtime path는 tool grant metadata 우선으로 판단한다.
- [x] AgentWorker unit test를 추가하고 `scripts/local_gate.sh --profile swift`로 검증한다.
- [ ] 실제 Hermes runtime e2e, DB migration, macOS 승인/거절 버튼 구현은 out of scope로 남긴다.

### MOMO-160 수용기준 `[spec/sql/swift]`
- [ ] `research/11-agent-runtime/07-agent-run-lifecycle-v0.md`에 `agent_run` lifecycle 정본을 추가한다.
- [ ] A2A Task/Message/Artifact/status를 momo `agent_run`/`message`/`artifact_ref`/`agent.status`에 매핑한다.
- [ ] `queued`/`running`/`input-required`/`awaiting-approval`/`succeeded`/`failed`/`cancelled`의 의미와 전이를 확정한다.
- [ ] `input-required`는 추가 입력 요청, `awaiting-approval`은 `approval(status='pending')` 기반 side-effect gate로 분리한다.
- [ ] Swift model, DB migration, AgentWorker/Hermes runtime 영향 범위를 표로 기록하고, 이번 goal에서 runtime behavior를 바꾸지 않는 부분은 `runtime-unverified`로 남긴다.
- [ ] `scripts/local_gate.sh --profile docs` 및 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift`를 통과한다.

### MOMO-170 수용기준 `[spec/swift]`
- [ ] `research/11-agent-runtime/07-macos-agent-protocol-cards-v0.md`에 macOS timeline card taxonomy와 shared metadata contract를 정의한다.
- [ ] `tool_call`, `approval_request`, `tool_result`, `artifact`가 Context Packet, Memory Plane, Capability Cache, source badge, cost 표시 정보를 어떻게 받는지 `message.props` shape로 고정한다.
- [ ] `MomoMacRootView` API는 유지하고, 영향 범위를 `MessageBubble` + `LiveChatBackend.seedDemo()` fixture + tests로 제한한다.
- [ ] SwiftUI card skeleton은 shared metadata strip으로 구현하고, offline fixture가 card type 4종을 모두 seed한다.
- [ ] local gate는 GitHub Actions disabled/manual-only 정책에 따라 `scripts/local_gate.sh --profile macos-ui`로 검증한다.
- [ ] 런타임 DB/wire alignment, approval pause/resume executor, memory inspector는 MOMO-132/MOMO-161/MOMO-171 범위로 남긴다.

## M7 Enterprise Trust

| id | 한줄 | 수용기준 등급 | 의존 |
|---|---|---|---|
| `MOMO-140` | Enterprise Trust Gate evidence package | docs/ci/manual | MOMO-111, MOMO-112, MOMO-132 |

핵심 증거물:

- threat model, data flow, deployment hardening, security whitepaper draft.
- SBOM, dependency license scan, secret scanning, local gate evidence.
- external pentest/VDP/SOC2 Type I/II/ISO27001/CSA STAR/ISMS-P roadmap.

---

# 후속 백로그 (v1 / v2 + 신규 프리미티브 P1~P6)

> 출처: 경험 설계 문서(`research/07-deepdive/05-agent-native-experiences.md`) §3·§6·§7.
> v0 데모(D+B+C)는 **추가 프리미티브 0**으로 스펙 §9.2 위에서 성립(§7). 아래는 그 다음 단계.

## v1 경험 (위 STEPS 완료 후)

| 경험 | 한줄 | 신규 프리미티브 | 핵심 프리미티브(기존) | platform |
|---|---|---|---|---|
| **A 유리 어항** | A2A 협업을 관전·난입 가능한 1급 스레드로 | 없음(0) | A2A depth/라운드배리어(§3.4), agent_run, agent.partial, 1급 메시지(tool_call/diff), seq, audit_log | both |
| **E 신원의 가면** | "X가 Y로서" 합성신원 + audit 리본 | 없음(Delegation Inbox UI만) | actor/subject 델리게이션 + audit_log(§7.3), 승인게이트, agent_run | both |
| **F 끼어들 존재감** | presence를 실시간 steer(미니 조종석) | 없음 | member(presence/lifecycle), agent_run, agent.partial, cancelRun(§6.1) | both |
| **I 공개 토론 + 캐스팅보트** | 동시 블라인드 입찰 + TIE-BREAK + minority report | **P5** | A2A 라운드배리어(R=4), approval 확장, agent_run, 델리게이션+audit, reserve | both |
| **H 되돌리기 동료** | 가역성 배지 + 인라인 UNDO + 보상 | **P2** | tool_call/tool_result 1급 메시지, audit_log, reserve/reconcile, 승인게이트, actor/subject | both |
| **J 길들이기** | 팀이 함께 에이전트 믿음 교정·합의 | **P3** | 1급 메시지(diff 재사용), 델리게이션+audit, 승인게이트, member 속성, seq | both |
| M/N 스탠드업·야간조 | 안무된 멀티에이전트 보고 / 자는 동안 일하고 아침 보고 | **P6** | A2A 라운드배리어, agent_run(히스토리 재생), reserve/reconcile, seq | desktop/both |
| O 먼저 두드리기 | 비용예산 가진 근거 있는 주도적 노크 | **P6** | 승인게이트, reserve/reconcile, member, approval_request, 메일박스 | both |

## v2 경험

| 경험 | 한줄 | 신규 프리미티브 | 핵심 프리미티브(기존) | platform |
|---|---|---|---|---|
| **G 분기 타임라인** | 채널을 평행우주로 갈래내고 인간이 정본 승격 | **P1** (가장 무거움) | channel_seq(분기좌표), agent_run(갈래별), reserve/reconcile(갈래별 원장), A2A 격리 | both(데스크탑 N열 우선) |
| **L 수습→정직원** | 신뢰 축적으로 승인게이트 점진 소멸을 팀이 관전 | **P4** | member.status, 승인게이트, audit_log, reserve, agent_run | both |
| H 체크포인트 분기 / G Branch Tournament / 리플레이+분기 / 역할 캐스팅 보드 | 데스크탑 고밀도 확장 | P1/P2 확장 | 위 프리미티브 조합 | desktop |

## 신규 프리미티브 P1~P6 (경험 설계 §6)

> v0 데모(D+B+C)에는 **불필요**. v1/v2 경험을 열기 위한 스펙 외 추가 작업.

### ☐ P1 — `branch_id` 좌표축 `(v2 · G 분기 타임라인 · 가장 큰 신규 작업)`
- [ ] `message`에 `branch_id` 컬럼 추가 + 분기당 `channel_seq` 별도 카운터(또는 갈래=경량 서브채널).
- [ ] 정본 병합 시 `branch → main` seq 재매핑 로직.
- [ ] 갈래별 reserve/reconcile 원장 격리, 폐기 갈래 자동 환불.
- 근거: 현 seq는 채널당 단일 모노토닉(§3.1)이라 "한 채널 다중 평행 갈래" 직접 표현 불가. **(추정)**

### ☐ P2 — `reversibility_tier` + 보상 레지스트리 `(v1 · H 되돌리기 동료)`
- [ ] tool_call `props`에 `reversibility: green/amber/red`.
- [ ] 보상 핸들러 매핑 테이블(compensation registry).
- [ ] audit_log를 역연산 소스로 재사용.

### ☐ P3 — `corrected_belief` 메시지 타입(또는 diff 확장) `(v1 · J 길들이기)`
- [ ] 1급 메시지 타입 enum에 `belief` 추가 또는 diff 타입 재사용.
- [ ] belief 원장 테이블(member 속성 + 교정 이력). co-sign/dispute는 reaction 재사용.

### ☐ P4 — `autonomy_level` + 승급/강등 사건 `(v2 · L 수습→정직원)`
- [ ] `agent` 테이블에 `autonomy_level`.
- [ ] 승급/강등 audit_log 사건 + 게이트 정책 바인딩(G6 scope별 점진 소멸/자동 강등).

### ☐ P5 — TIE-BREAK 결정표 + `decision_ledger` `(v1 · I 공개 토론)`
- [ ] approval 확장(2지선다 → 다지선다 캐스팅보트).
- [ ] 불변 `decision_ledger` 테이블 + minority report 첨부/recall.

### ☐ P6 — scheduled trigger `(v1 · M/N 스탠드업, Sentinel, O 노크)`
- [ ] cron/트리거 테이블(outbox `agent_job` 재사용 가능, kind 확장으로 흡수).
- [ ] 예약/모니터링 트리거 디스패치.

---

> **정합 원칙:** 이전 티켓이 만든 파일/패키지를 깨지 말 것. 스펙·`schema_v0.sql`과 정합.
> SwiftPM 의존성은 최신 안정 태그로 resolve. 스텁은 `// TODO` 명시.
