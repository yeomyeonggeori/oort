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
| `MOMO-150` | Hermes/Kim Intern/openclaw agent runtime 분석과 roadmap | docs/spec | MOMO-110 |
| `MOMO-005` | docker-compose.prod 기반 staging/prod skeleton(Caddy 자동TLS + Centrifugo Redis engine) | infra/docs | MOMO-001~004 |

### MOMO-110 수용기준 `[docs/spec]`
- [ ] `research/10-local-ai-protocol-trust/`에 Apple local LLM, Context Broker, Agent Protocol, Google Workspace, Trust, local ops 연구 문서 추가.
- [ ] `ROADMAP.md`, `docs/BACKLOG.md`, `BUILD_TICKETS.md`, `docs/INDEX.md`, `STATUS.md`에 새 에픽/티켓/진행 상태 반영.
- [ ] build-macos-apps 플러그인은 SwiftPM build/test/triage와 SwiftPM GUI app 실행 표준화에 적극 사용하되, store signing/notarization은 M4에서 분리한다는 원칙 기록.

### MOMO-111 수용기준 `[ci/docs]`
- [ ] `scripts/local_gate.sh --profile docs|swift|runtime-db|runtime-relay|runtime-agent|macos-ui|all` 설계/구현.
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

### MOMO-005 수용기준 `[infra/docs]`
- [x] `scripts/goal_claim.sh 5` 시도. 이슈가 `status:ready`가 아니어서 fallback으로 별도 worktree/branch를 수동 생성하고 issue `status:in-progress`를 적용.
- [x] `infra/prod/docker-compose.prod.yml`: Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker 서비스 skeleton.
- [x] `infra/prod/Caddyfile`: api/rt 도메인 라우팅 + 보안 헤더. Centrifugo subscribe proxy는 compose 내부 `api:8080` 유지.
- [x] `infra/prod/centrifugo.prod.json`: dev namespace 계약 유지 + Redis engine 전환.
- [x] `infra/prod/.env.example`: production env 예시만 제공, 실제 시크릿 미커밋.
- [x] `docs/RUN.md`, `docs/DEPLOY.md`, `STATUS.md`, `ROADMAP.md` 갱신.
- [ ] `scripts/local_gate.sh --profile docs` PASS.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 `momo-main` handoff.

### MOMO-150 수용기준 `[docs/spec]`
- [ ] `research/11-agent-runtime/`에 Hermes agent, internkim/Kim Intern, openclaw 분석 문서 추가.
- [ ] memory/cache/protocol gap을 Context Packet, Memory Plane, Capability Cache, A2A lifecycle, approval pause/resume 관점으로 정리.
- [ ] ROADMAP/BACKLOG/INDEX/STATUS에 MOMO-151~153, MOMO-160~163, MOMO-170~172 후속 로드맵 반영.
- [ ] 코드/스키마 구현 없이 문서/스펙만 변경.

## M2 멀티팀 온보딩

| id | 한줄 | 수용기준 등급 | 의존 | 상태 |
|---|---|---|---|---|
| `MOMO-010` | `003_onboarding.sql` invite_code + redemption audit + RLS FORCE | sql/runtime | MOMO-003 | local gate PASS |
| `MOMO-011` | 워크스페이스 스핀업 REST + 초대코드 자동 발급 | swift/runtime | MOMO-010 | 후속 |
| `MOMO-012` | macOS dev app onboarding/invite flow v0 UI (LiveChatBackend stub) | swift/macos-ui | MOMO-010 | local gate PASS |
| `MOMO-013` | platform_admin 전역 추적 뷰/엔드포인트 | sql/swift/runtime | MOMO-010 | 후속 |
| `MOMO-014` | production `/v1/join` 자가가입 플로우 + audit_log | swift/runtime | MOMO-011, MOMO-012 | 후속 제안 |

### MOMO-010 수용기준 `[sql/runtime]`
- [x] `server/Migrations/003_onboarding.sql` 신규 추가(`schema_v0.sql` 미수정).
- [x] raw invite code는 저장하지 않고 `momo_generate_invite_code()` + `momo_invite_code_hash(raw_code)` 패턴으로 high-entropy bearer secret을 해시 저장한다.
- [x] `invite_code`에 `workspace_id`, `role`, `max_uses`, `used_count`, `expires_at`, `revoked_at`, `revoked_by`, `created_by`, `last_used_at`을 두고 same-workspace member FK와 active lookup index를 둔다.
- [x] `invite_code_redemption`으로 성공 redemption audit trail을 남긴다.
- [x] `invite_code`/`invite_code_redemption`을 신규 RLS DO-block에 등록하고 `FORCE ROW LEVEL SECURITY` + `SET LOCAL app.workspace_id` 원칙을 유지한다.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.

### MOMO-012 수용기준 `[swift/macos-ui]`
- [x] `MomoMacDevApp`에서 invite code 입력 UI와 idle/validating/success/failure 상태를 볼 수 있다.
- [x] `LiveChatBackend` stub이 `MOMO-012`/`MOMO-DEV` 성공, `EXPIRED`/`USED-UP`/기타 실패 상태를 결정적으로 반환한다.
- [x] 기존 channel/message/approval/cost UI와 `MomoMacRootView` API를 유지한다.
- [x] `swift test --package-path clients/macOS` PASS(10 tests).
- [x] `scripts/local_gate.sh --profile macos-ui` PASS.
- [x] `scripts/local_gate.sh --profile swift` PASS.
- out of scope: production server `/v1/join` 구현과 DB-backed invite redemption e2e. 새 후속 이슈(`MOMO-014` 제안)로 분리한다.

## M2 Context / Memory / Google Workspace

| id | 한줄 | 수용기준 등급 | 의존 |
|---|---|---|---|
| `MOMO-120` | Context Packet v0 spec and fixtures | spec/swift | MOMO-003, MOMO-110 |
| `MOMO-121` | Memory Plane v0 spec and permission model | spec | MOMO-120 |
| `MOMO-122` | Google Workspace connector v0: per-user OAuth read-mostly sync | runtime/spec | MOMO-120, MOMO-121 |
| `MOMO-123` | Domain-wide delegation/admin install design | spec/manual | MOMO-122 |
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

### MOMO-161 수용기준 `[spec/swift/runtime]`
- [x] `research/11-agent-runtime/08-approval-pause-resume-runtime.md`에 approval pause/resume 정본을 추가한다.
- [x] `tool_call → approval_request → approval_decision → resume/deny → tool_result/audit` 흐름과 same-run resume 모델을 정의한다.
- [x] DB/Swift/server/worker 변경 범위를 정리하고, `schema_v0.sql`은 수정하지 않는다.
- [x] AgentWorker가 approval-required `tool_call`에서 `approval(status='pending')`, `message.type='approval_request'`, `agent_run.status='awaiting_approval'`, `audit_log`를 기록하는 최소 pause slice를 컴파일 가능한 코드로 추가한다.
- [x] `research/11-agent-runtime/fixtures/approval-pause-resume-v0/` fixture와 AgentWorker smoke test를 추가한다.
- [ ] Server approval decision endpoint와 AgentWorker resume-job execution은 후속 runtime 구현으로 남긴다(`runtime-unverified`).

핵심 원칙:

- Context Packet은 `{goal,constraints,decisions,sources,permissions,budget,redactions}`를 고정 필드로 시작한다.
- 장기 메모리는 raw chat exhaust가 아니라 `decision/preference/artifact/task_state/external_source_ref`로 제한한다.
- Google Workspace v0는 per-user OAuth + read-mostly sync다. write는 approval card 뒤로 둔다.

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
| `MOMO-162` | Hermes adapter contract verification | runtime/python/swift | MOMO-150, MOMO-004 |
| `MOMO-163` | inbound MCP server v0 spec and fixtures | spec/swift | MOMO-151, MOMO-153 |
| `MOMO-172` | inbound MCP server v0 skeleton/spec-to-code bridge | swift/docs | MOMO-163 |
| `MOMO-165` | Capability Cache approval metadata gate | swift | MOMO-151, MOMO-153, MOMO-161, MOMO-164 |
| `MOMO-170` | macOS agent protocol cards | spec/swift | MOMO-132, MOMO-161 |
| `MOMO-171` | agent memory inspector | swift/spec | MOMO-152, MOMO-170 |
| `MOMO-174` | local LLM context compaction | swift/spec | MOMO-130, MOMO-151 |

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
