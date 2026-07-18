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
| `MOMO-196` | Realtime WebSocket live subscribe verifier v0(token→subscribe→REST send→live publication) | runtime/infra | MOMO-115, MOMO-186, MOMO-192, MOMO-193 |
| `MOMO-212` | Agent channel live subscription verifier v0(agent status/partial live boundary) | runtime/infra | MOMO-196, MOMO-200, MOMO-201 |
| `MOMO-215` | Agent mention routing e2e v0(REST @agent mention→agent_job→agent/live+timeline) | runtime-agent/swift | MOMO-004, MOMO-196, MOMO-212 |
| `MOMO-217` | Auth password verification runtime hardening v0 | swift/runtime-db | MOMO-014, MOMO-213 |
| `MOMO-194` | local gate evidence/log 파일명 병렬 실행 충돌 방지 | tooling/docs | MOMO-111, MOMO-112 |
| `MOMO-199` | closed issue/merged PR 연결 stale local worktree read-only audit | tooling/docs | MOMO-112, MOMO-194 |
| `MOMO-209` | stale worktree Docker Compose project/container/network janitor | tooling/docs | MOMO-112, MOMO-194, MOMO-199 |
| `MOMO-224` | internal alpha diagnostics/observability bundle v0 | tooling/docs | MOMO-111, MOMO-220 |
| `MOMO-150` | Hermes/Kim Intern/openclaw agent runtime 분석과 roadmap | docs/spec | MOMO-110 |
| `MOMO-180` | Paca/OpenHands/Linear/Rovo/GitHub agentic work OS 시장 분석 + repo topology ADR | docs/spec | MOMO-150 |
| `MOMO-005` | docker-compose.prod 기반 staging/prod skeleton(Caddy 자동TLS + Centrifugo Redis engine) | infra/docs | MOMO-001~004 |
| `MOMO-006` | SOPS/age secret lifecycle + pgBackRest PITR skeleton | infra/docs | MOMO-005 |
| `MOMO-007` | VPS 시크릿 없는 local/staging smoke gate + RUN/DEPLOY 런북 고정 | infra/docs | MOMO-005, MOMO-006 |
| `MOMO-220` | Internal single-node host-runtime smoke v0(local image prod+internal-smoke boot) | runtime/infra | MOMO-216, MOMO-215 |
| `MOMO-221` | Production secret/bootstrap hardening v0 | infra/docs | MOMO-005, MOMO-006, MOMO-216, MOMO-220 |
| `MOMO-222` | Backup/PITR restore rehearsal gate v0(repo-local dump→separate restore evidence) | runtime/infra | MOMO-006, MOMO-220 |
| `MOMO-229` | Public host preflight + deploy evidence packet v0 | infra/docs | MOMO-221, MOMO-222, MOMO-225, MOMO-228 |
| `MOMO-233` | AWS internal alpha stack v0 | infra/docs | MOMO-221, MOMO-222, MOMO-225, MOMO-228, MOMO-229 |
| `MOMO-237` | Local Docker alpha RC gate v0 | tooling/runtime/docs | MOMO-220, MOMO-224, MOMO-225, MOMO-228, MOMO-233, MOMO-236 |
| `MOMO-239` | Local one-person alpha checklist + AWS promotion threshold | docs/manual | MOMO-225, MOMO-228, MOMO-230, MOMO-231, MOMO-233 |
| `MOMO-240` | Local alpha runner | infra/runtime | MOMO-001~004, MOMO-237, MOMO-238, MOMO-239 |
| `MOMO-241` | Local 3-Day Alpha Test Pack | docs/manual | MOMO-239, MOMO-240 |
| `MOMO-242` | External Agent Runtime Smoke | runtime/docs | MOMO-230, MOMO-234, MOMO-236, MOMO-238, MOMO-241 |
| `MOMO-256` | Local Hermes Agent Bridge v0 | runtime-agent/macos-ui/swift | MOMO-215, MOMO-238, MOMO-242, MOMO-253 |
| `MOMO-257` | Local Hermes/Codex OAuth provider setup | runtime-agent/macos-ui/docs | MOMO-234, MOMO-238, MOMO-242, MOMO-256 |
| `MOMO-325` | Hermes Gateway Native Platform Integration v1 | runtime-agent/docs/swift | MOMO-212, MOMO-215, MOMO-256, MOMO-257 |
| `MOMO-326` | Real Hermes gateway plugin load + credentialed local smoke | runtime-agent/docs/tooling | MOMO-325 |
| `MOMO-243` | In-App Alpha Command Center | swift/macos-ui | MOMO-228, MOMO-232, MOMO-241 |
| `MOMO-244` | Dev Update Channel v0 | swift/docs | MOMO-235, MOMO-241 |
| `MOMO-245` | Local Soak/Resource Monitor | tooling/runtime/docs | MOMO-224, MOMO-237, MOMO-239, MOMO-240, MOMO-241 |
| `MOMO-246` | 72h Local Alpha Dogfood Run | manual/tracking | MOMO-241, MOMO-242, MOMO-243, MOMO-244, MOMO-245 |
| `MOMO-336` (`#305`) | Local Solo Hermes Dogfood Start Gate | docs/manual | MOMO-335, MOMO-260, MOMO-262, MOMO-261 |
| `MOMO-319` | Local gate/verifier hardening for solo alpha | tooling/runtime | LSA-001, MOMO-300, MOMO-301, MOMO-302 |
| `MOMO-320` | Local runtime env drift guard | tooling/runtime | LSA-001, MOMO-319, MOMO-300 |
| `MOMO-324` | AgentWorker verifier cleanup FK rerun hardening | tooling/runtime | MOMO-320 |
| `MOMO-342` (`#314`) | AgentWorker verifier persistent DB fixture hardening | tooling/runtime | MOMO-324, MOMO-338 |
| `MOMO-343` (`#316`) | AgentWorker verifier fresh DB marker bootstrap regression | tooling/runtime | MOMO-342 |
| `MOMO-344` (`#318`) | Agent context verifier isolated DB boundary | tooling/runtime-agent | MOMO-343 |
| `MOMO-345` (`#320`) | Agent live channel verifier isolated DB boundary | tooling/runtime-agent | MOMO-344 |
| `MOMO-346` (`#322`) | Hermes bridge/gateway verifier isolated DB boundary | tooling/runtime-agent | MOMO-345 |
| `MOMO-347` (`#324`) | Pairing popover credential embedding hardening | swift/macos-ui | MOMO-339 |
| `MOMO-348` (`#325`) | macos-ui real backend verifier isolated DB boundary | tooling/macos-ui | MOMO-346 |
| `MOMO-355` (`#342`) | Dogfood agent seed opt-in + pairing-only roster policy | sql/tooling/docs | MOMO-339, MOMO-348, MOMO-352 |
| `MOMO-227` | Kim Intern runtime config + health/status visibility v0 | swift/docs/host-runtime | MOMO-220, MOMO-221, MOMO-215, MOMO-219 |
| `MOMO-230` | External Kim Intern/Hermes provider smoke gate v0 | runtime/docs | MOMO-227, MOMO-220, MOMO-215 |
| `MOMO-234` | Hermes Codex OAuth provider boundary v0 | docs/tooling | MOMO-230, MOMO-227 |
| `MOMO-236` | Hermes internal alpha invite smoke v0 | runtime/docs | MOMO-227, MOMO-230, MOMO-228 |
| `MOMO-238` | Local Hermes GPT provider loopback contract | docs/tooling/swift | MOMO-230, MOMO-234, MOMO-236 |
| `MOMO-242` | External agent runtime smoke contract | runtime/docs/swift | MOMO-230, MOMO-234, MOMO-236, MOMO-238, MOMO-240 |
| `MOMO-256` | Local Hermes Agent Bridge v0 | runtime-agent/macos-ui/swift | MOMO-215, MOMO-238, MOMO-242, MOMO-253 |
| `MOMO-257` | Local Hermes/Codex OAuth provider setup | runtime-agent/macos-ui/docs | MOMO-234, MOMO-238, MOMO-242, MOMO-256 |
| `MOMO-325` | Hermes Gateway Native Platform Integration v1 | runtime-agent/docs/swift | MOMO-212, MOMO-215, MOMO-256, MOMO-257 |
| `MOMO-326` | Real Hermes gateway plugin load + credentialed local smoke | runtime-agent/docs/tooling | MOMO-325 |
| `MOMO-224` | internal alpha diagnostics/observability bundle v0 | tooling/docs | MOMO-111, MOMO-220 |
| `MOMO-225` | Internal alpha combined local gate v0 | tooling/runtime | MOMO-220, MOMO-222, MOMO-224, MOMO-205 |
| `MOMO-228` | internal alpha runbook + feedback/known-limitations packet v0 | docs/manual | MOMO-213, MOMO-219, MOMO-224 |
| `MOMO-231` | internal alpha feedback intake + triage workflow v0 | docs/tooling | MOMO-112, MOMO-225, MOMO-228 |
| `MOMO-232` | macOS internal alpha usability polish v0 | swift/macos-ui | MOMO-226, MOMO-227, MOMO-225, MOMO-228 |
| `MOMO-235` | macOS alpha update channel v0 | swift/docs | MOMO-211, MOMO-228, MOMO-232 |
| `MOMO-244` | Dev Update Channel v0(local/file manifest + operator-assisted install CTA) | swift/macos-ui/docs | MOMO-235 |
| `MOMO-243` | In-App Alpha Command Center | swift/macos-ui/docs | MOMO-232, MOMO-235, MOMO-239 |
| `MOMO-253` | macOS dogfood UX shell polish | swift/macos-ui | MOMO-243, MOMO-244 |
| `MOMO-259` | macOS shell/layout/performance polish | swift/macos-ui | MOMO-253 |
| `MOMO-263` | macOS responsive drawer/profile/downloads UX | swift/macos-ui | MOMO-259, MOMO-244 |
| `MOMO-264` | macOS native profile/settings/downloads UX | swift/macos-ui | MOMO-263 |
| `MOMO-334` | Dogfood Hermes invite roster UX v0 | swift/macos-ui | MOMO-333 |
| `MOMO-335` (`#300`) | Mention autocomplete + Hermes working indicator | swift/macos-ui | MOMO-334 |
| `MOMO-260` (`#263`) | Workspace/member/agent profile settings v0 | swift/macos-ui | MOMO-334 |
| `MOMO-262` (`#265`) | Agent Pairing Wizard v0 | runtime-agent/macos-ui/docs | MOMO-334, MOMO-333 |
| `MOMO-261` (`#264`) | Approval/Command Center/typing activity UX | swift/macos-ui | MOMO-335 |
| `MOMO-337` (`#307`) | Agent bearer 인증 v1 (per-agent 자격증명·스코프·회전) — ADR-0101 Phase 1 | swift/runtime-agent | MOMO-325, MOMO-333 |
| `MOMO-338` (`#308`) | Hermes 어댑터 bearer 단일화 (오퍼레이터 로그인 제거) — ADR-0101 | python/runtime-agent | MOMO-337 |
| `MOMO-339` (`#309`) | 페어링 위저드 자격증명 발급/회전 UI — ADR-0101 | swift/macos-ui | MOMO-337, MOMO-262 |
| `MOMO-349` (`#329`) | gateway 승인 왕복 (approval_request→resume) — ADR-0102 | swift/python/runtime-agent | MOMO-337, MOMO-338 |
| `MOMO-350` (`#330`) | gateway status/partial 브로드캐스트 — ADR-0102 | swift/python/runtime-agent | MOMO-349 |
| `MOMO-341` (`#333`) | gateway pending durable claim/lease + takeover — ADR-0102 합류 | swift/runtime-agent | MOMO-350 |
| `MOMO-352` (`#332`) | 이중 경로 동등성 verifier — ADR-0102 보장 매트릭스 게이트 | tooling/runtime-agent | MOMO-349, MOMO-350, MOMO-341 |
| `MOMO-351` (`#331`) | 이중 경로 스펙/다이어그램/계약 재정렬 + SD-5 소급 — ADR-0102 | docs | 없음 (병렬) |
| `MOMO-353` (`#334`) | 로컬 게이트 drift-guard (config drift 검출 + 잔류 프로세스 정리) | tooling | 없음 (병렬) |
| `MOMO-356` (`#343`) | Hermes gateway 운영 공지의 durable timeline 유출 차단 | python/runtime-agent/docs | MOMO-338 |
| `MOMO-355` (`#342`) | persistent/local-alpha agent seed 제거; demo/e2e opt-in + pairing onboarding | sql/tooling/docs | MOMO-339, MOMO-348, MOMO-352 |
| `MOMO-357` | UI W1: 앱 셸·사이드바 Slack급 정비 (패킷 2026-07-13-ui-wave1) | swift/macos-ui | MOMO-354 |
| `MOMO-358` | UI W1: Cmd+K 퀵 스위처 (357 랜딩 후 스폰) | swift/macos-ui | MOMO-357 |
| `MOMO-359` | UI W1: 메시지 타임라인 밀도·그루핑 | swift/macos-ui | MOMO-354 |
| `MOMO-360` | Phase A: GHCR 이미지 발행 워크플로 + pull&up 배포 계약 | infra/tooling | 없음 (병렬) |
| `MOMO-361` | Phase A: 배포 번들 패커 + 10인 알파 운영 runbook | docs/tooling | 없음 (병렬) |
| `MOMO-362` | Work v0: work run 계약 + 승인 티어 서버 가드 (ADR-0111, 패킷 2026-07-13-agent-work-surface) | swift/runtime-agent | 없음 (선행) |
| `MOMO-363` | Work v0: codex-workbench gateway adapter | python/runtime-agent | MOMO-362 |
| `MOMO-364` | Work v0: Work 표면 UI (컴포저/카드/상세 페인) | swift/macos-ui | MOMO-362 |
| `MOMO-365` | Work v0: capability 배지 + Work 대상 선택 UX | swift/macos-ui | MOMO-362 |
| `MOMO-366` | Wave 2: read-state 서버 계약 (ADR-0109, 패킷 2026-07-13-ui-wave2-unread) | swift/runtime-agent | 없음 (선행) |
| `MOMO-367` | Wave 2: unread 배지 + 키보드 순회 UI | swift/macos-ui | MOMO-366 |

### Local Solo Hermes Dogfood Active Chain

This chain is the current momo-main resumable tracker. The canonical operational
source is `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`.

1. GitHub `#300` / `MOMO-335`: roster-backed `@` autocomplete and Hermes working indicator. Done.
2. GitHub `#263` / `MOMO-260`: workspace/member/agent profile settings v0. Done.
3. GitHub `#265` / `MOMO-262`: Agent Pairing Wizard v0. Done.
4. GitHub `#264` / `MOMO-261`: approval/Command Center/typing activity UX. Done.
5. GitHub `#305` / `MOMO-336`: retarget full 72h soak into a reduced Local
   Solo Hermes Dogfood Start Gate. Done in this PR.

For each item: issue contract -> implementation -> local gate evidence -> code
review -> fix if needed -> merge -> main gate -> roadmap/status update.

### MOMO-233 수용기준 `[infra/docs]`
- [x] GitHub #224를 `scripts/goal_claim.sh 224`로 claim하고 별도 branch/worktree `chore/224-aws-internal-alpha-stack-v0`에서 진행한다.
- [x] `docs/AWS_INTERNAL_ALPHA.md`에 AWS 최소/권장/분리 topology를 정리한다.
- [x] Lightsail vs EC2 v0 추천안과 2026-07-01 기준 월 비용/1주 비용 추정을 문서화한다.
- [x] 보안그룹, DNS/TLS, 볼륨, backup/restore 전략을 정리한다.
- [x] source checkout 없는 image-based deploy와 rollback 방향을 정리한다.
- [x] `infra/prod/aws-internal-alpha.env.example`과 `scripts/aws_internal_alpha_preflight.sh`를 추가해 topology/provider/security/deploy/backup intent를 fail-fast로 검사한다.
- [x] `docs/RUN.md`, `docs/DEPLOY.md`, `docs/INTERNAL_ALPHA.md`, `docs/INDEX.md`, `docs/LOCAL_PR_GATE.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] 실제 AWS host creation, DNS/TLS, registry pull, SOPS decrypt, pgBackRest backup, EBS snapshot, PITR restore rehearsal은 `runtime-unverified(aws-host)`로 남긴다.
- [ ] PR 생성 후 GitHub #224를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-237 수용기준 `[tooling/runtime/docs]`
- [x] 별도 worktree/branch `feat/MOMO-237-local-alpha-rc-gate`에서 `origin/main` 기준으로 진행한다.
- [x] `scripts/local_gate.sh --profile local-alpha`를 추가해 AWS 생성 전 local Docker alpha RC evidence packet을 만든다.
- [x] `local-alpha`는 AWS API/resource 생성을 하지 않고 local Docker, local Swift packages, repo-local mock Hermes, local diagnostics만 사용한다.
- [x] packet은 host-runtime image boot, migration idempotency, `/health`, REST message send, OutboxRelay publish, mock Hermes/Kim Intern roundtrip을 포함한다.
- [x] packet은 backup restore rehearsal, macOS real-backend smoke, diagnostics bundle directory/archive path를 함께 포함한다.
- [x] `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile local-alpha`로 MomoMacDevApp foreground process/window/log evidence를 opt-in할 수 있다.
- [x] `docs/RUN.md`, `docs/INTERNAL_ALPHA.md`, `docs/LOCAL_PR_GATE.md`, `docs/INDEX.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] 실제 AWS host creation, public DNS/TLS, registry pull, SOPS decrypt, production pgBackRest WAL/PITR, real external Hermes credentialed side effect, notarized macOS release app, iOS/APNs는 out of scope로 남긴다.
- [ ] PR 생성 후 goal issue를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-239 수용기준 `[docs/manual]`
- [x] 별도 worktree/branch `docs/MOMO-239-local-alpha-aws-threshold`에서 진행한다.
- [x] `docs/INTERNAL_ALPHA.md`에 local one-person alpha checklist를 추가한다.
- [x] 체크리스트는 로그인, 채널 조회, 메시지 송수신, 초대/가입, 김인턴 멘션, 재시작/reconnect, diagnostics, feedback filing을 모두 포함한다.
- [x] AWS 승격 threshold를 local gate, 1인 soak, credentialed external agent runtime smoke, no P0/P1, diagnostics evidence로 정의한다.
- [x] `docs/AWS_INTERNAL_ALPHA.md`에 `AWS_READY` handoff 전에는 AWS provisioning 금지라는 precondition을 추가한다.
- [x] `docs/LOCAL_PR_GATE.md`에 docs gate PASS와 실제 `AWS_READY` 운영 판정의 경계를 문서화한다.
- [x] `ROADMAP.md`, `STATUS.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 MOMO-239를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-240 수용기준 `[infra/runtime]`
- [x] 별도 worktree/branch `chore/MOMO-240-local-alpha-runner`에서 `main` 기준으로 구현한다.
- [x] `scripts/local_alpha_runner.sh plan`은 Docker/Swift 프로세스를 띄우지 않고 실행 순서, URL, env/evidence 정책을 출력한다.
- [x] `scripts/local_alpha_runner.sh execute --hermes mock`은 AWS 리소스 생성 없이 PG18+Centrifugo compose, migrate, RLS role prep, mock Hermes, MomoServer, OutboxRelay, AgentWorker, macOS smoke를 한 흐름으로 실행한다.
- [x] `--hermes external --secret-env /absolute/path`는 repo 밖 secret env만 허용하고, `HERMES_BASE_URL`/`HERMES_API_KEY` placeholder를 거부한다.
- [x] 실행 결과로 `summary.md`에 MomoServer/Centrifugo/Hermes URL, redacted env, logs/evidence path, stop command, macOS dev launch command를 남긴다.
- [x] `Makefile` 편의 타깃 `local-alpha-plan` / `local-alpha`가 runner와 정합한다.
- [x] `docs/RUN.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] local gate: `sh -n scripts/local_alpha_runner.sh`, `scripts/local_alpha_runner.sh plan`, `scripts/local_alpha_runner.sh execute --hermes mock --stop-after-smoke`, `make build`, `make test`, `python3 -m py_compile adapters/hermes/momo_adapter.py` 통과.
- [ ] PR은 `needs-review` 상태에서 멈춘다.

### MOMO-241 수용기준 `[docs/manual]`
- [x] GitHub #241을 `scripts/goal_claim.sh 241`로 claim하고 별도 branch/worktree `docs/241-local-3-day-alpha-test-pack`에서 진행한다.
- [x] `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`를 추가해 72h local dogfood의 Day 0 / Day 1 / Day 2 / Day 3 체크리스트를 정본화한다.
- [x] `AWS_READY` / `BLOCKED` / `NEEDS_MORE_LOCAL` 판단 기준을 정의한다.
- [x] P0/P1/P2/P3 버그 분류 기준과 `docs/INTERNAL_ALPHA_FEEDBACK.md` 연결을 문서화한다.
- [x] local alpha start / stop / restart / recovery 절차를 정리한다.
- [x] mock agent runtime과 external agent runtime 경로를 구분하고, provider token은 momo 밖에 둔다는 boundary를 유지한다.
- [x] daily diagnostics/evidence 수집 절차와 evidence directory layout을 정리한다.
- [x] Day 0~3 daily report template과 MOMO-246 final report template을 추가한다.
- [x] `docs/INTERNAL_ALPHA.md`, `docs/AWS_INTERNAL_ALPHA.md`, `docs/LOCAL_PR_GATE.md`, `docs/INDEX.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #241을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-245 수용기준 `[tooling/runtime/docs]`
- [x] 기존 GitHub issue #245를 `scripts/goal_claim.sh 245`로 claim하고 별도 branch/worktree `chore/245-local-soak-resource-monitor`에서 진행한다.
- [x] `scripts/local_soak_monitor.sh`를 추가해 72h local dogfood 동안 주기 snapshot evidence를 repo 밖 디렉터리에 저장한다.
- [x] snapshot은 API `/health`, Centrifugo `/health`, DB connectivity, pending outbox count/oldest age를 확인한다.
- [x] snapshot은 OutboxRelay/AgentWorker process 또는 container status를 확인한다.
- [x] snapshot은 Docker container status, `docker stats`, `docker system df`, disk free evidence를 수집한다.
- [x] macOS foreground smoke 또는 launch evidence를 `--macos-evidence`/`--launch-macos-smoke`로 연결할 수 있다.
- [x] `summary.md`에 PASS/WARN/FAIL 판정과 P0/P1 threshold를 출력한다.
- [x] P0/P1 감지 기준과 Docker Desktop CPU/memory/disk 권장값을 `docs/INTERNAL_ALPHA.md`에 문서화한다.
- [x] `scripts/local_gate.sh --profile docs`의 shell syntax 대상에 새 스크립트를 포함한다.
- [x] `docs/INTERNAL_ALPHA.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] 실제 72h dogfood 완료, AWS monitoring, Prometheus/Grafana/Kubernetes, 대규모 부하테스트는 out of scope로 남긴다.
- [ ] PR 생성 후 GitHub #245를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-246 실행 전제 `[manual/tracking]`
- [ ] MOMO-241~245가 main에 merge되어 있다.
- [ ] MOMO-246은 momo-main tracking/run issue로 진행하고 worker implementation goal로 claim하지 않는다.
- [ ] 실제 72h run 중 발견된 결함은 P0/P1/P2/P3 별도 이슈로 분리한다.
- [ ] 최종 판정은 `AWS_READY` / `BLOCKED` / `NEEDS_MORE_LOCAL` 중 하나로만 남긴다.
- [ ] MOMO-336 이후 full 72h soak은 local solo dogfood entry blocker가 아니라 AWS/pre-production promotion evidence로 취급한다.

### MOMO-336 수용기준 `[docs/manual]`
- [x] GitHub #305를 `scripts/goal_claim.sh 305`로 claim하고 별도 branch/worktree `chore/305-local-solo-hermes-dogfood-start-gate`에서 진행한다.
- [x] `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`의 Active Buildable Goal Chain을 MOMO-335/260/262/261 완료와 MOMO-336 retarget으로 정리한다.
- [x] `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`에 reduced start gate를 추가해 local stack, fresh login, Hermes invite, `@hermes` roundtrip PASS, activity visibility, diagnostics, blocker triage를 고정한다.
- [x] MOMO-252 / PR #253은 false PASS evidence risk 때문에 merge하지 않고 close/retarget 처리한다.
- [x] `ROADMAP.md`, `STATUS.md`, `BUILD_TICKETS.md`에 full 72h soak이 AWS/pre-production signal이고 첫 local solo entry blocker가 아님을 반영한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #305를 `status:needs-review`로 전환한다.

### LSA-001 수용기준 `[docs/tooling/runtime]`
- [x] `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`를 추가해 로컬 1인 테스트의 Definition of Done과 buildable goal chain을 고정한다.
- [x] `scripts/local_alpha_runner.sh`가 generated env에 `CENT_PROXY_SECRET`, `AGENT_CONTEXT_MAX_MESSAGES`, `AGENT_CONTEXT_MAX_CHARS`를 명시하고, local dev secrets는 repo 밖 evidence dir에 강한 랜덤값으로 생성한다.
- [x] `scripts/verify_internal_host_runtime.sh` generated internal-smoke env가 `CENT_PROXY_SECRET`를 포함해 MOMO-300 preflight를 통과한다.
- [x] macOS real-backend 기본 demo password와 `scripts/momo` help가 seeded credential `demo@momo.local / dev-password`와 일치한다.
- [x] `docs/INTERNAL_ALPHA.md`와 `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`가 MOMO-300 old-token 재로그인, `CENT_PROXY_SECRET`, migration 007 idempotency, rate-limit override, MOMO-302 agent context expectations를 설명한다.
- [x] `docs/INDEX.md`, `ROADMAP.md`, `BUILD_TICKETS.md`, `STATUS.md`를 갱신한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 남긴다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 남긴다.
- [x] `scripts/local_gate.sh --profile local-alpha` PASS evidence를 남긴다.
- [x] 실제 credentialed Hermes/GPT provider login, 72h dogfood, AWS provisioning, MomoDS UI migration은 out of scope로 남긴다.

### MOMO-319 수용기준 `[tooling/runtime]`
- [x] Runtime verifier host process cleanup은 repo-local verifier/mock/server 계열 process만 대상으로 삼고, Docker Postgres/Centrifugo 같은 non-momo listener나 user-owned provider는 건드리지 않는다.
- [x] `runtime-agent` profile이 worktree env의 base ports를 읽고 AgentWorker/context/live/local-Hermes verifier 사이에서 API/Hermes/bridge 전용 포트를 정리한다.
- [x] Agent context/bridge 보조 포트는 `.conductor` 10-port block 내부(`base+4..6`)만 사용해 다른 worktree의 API/Hermes 포트를 건드리지 않는다.
- [x] 실패 중간에 gate가 멈춰도 runtime-agent final cleanup이 always-run으로 실행된다.
- [x] process guard는 raw command line을 local gate evidence/log에 남기지 않는다.
- [x] `verify_external_agent_provider.sh`/`verify_local_hermes_bridge.sh`는 deterministic verifier fixture/client_msg_id/run id만 cleanup하고 실제 dogfood 중인 pending agent job을 neutralize하지 않는다.
- [x] user-owned Hermes/provider listener는 기본적으로 kill하지 않고 conflict/fail-closed로 남기며, standalone bridge verifier는 명시 opt-in(`LOCAL_HERMES_BRIDGE_REUSE_EXISTING_PROVIDER=1`) 때만 재사용한다.
- [x] `verify_agent_worker.sh` fixture cleanup은 FK 순서상 `agent_run` 삭제/중립화 후 trigger/output message를 삭제한다.
- [x] `scripts/verify_local_hermes_bridge.sh` 단독 PASS evidence와 `scripts/verify_agent_worker.sh` 단독 PASS evidence를 남긴다.
- [x] `LOCAL_GATE_ALLOW_DIRTY=1 ENV_FILE=.env.worktree scripts/local_gate.sh --profile runtime-agent` PASS evidence를 남긴다.
- [x] `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`, `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`, `research/13-redesign/00-execution-tracker.md`를 갱신한다.
- [x] runtime-db partial parallelization과 warm volume opt-in은 후속 performance slice로 남긴다.

### MOMO-320 수용기준 `[tooling/runtime]`
- [x] Runtime profile 시작 전 generated `.env.worktree`가 current runtime contract(`CENT_TOKEN_HMAC`, `CENT_API_KEY`, `CENT_PROXY_SECRET`, `JWT_HMAC`, port/runtime keys)를 만족하는지 검사한다.
- [x] `ENV_FILE`이 비었거나 generated `.env.worktree`를 가리키면 stale/missing key 발견 시 `.conductor/setup.sh`로 재생성한다.
- [x] Custom `ENV_FILE`은 덮어쓰지 않고, 필수 키가 빠져 있으면 secret 값을 출력하지 않는 fail-fast 메시지를 낸다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 남긴다.
- [x] stale generated env를 만든 뒤 `ENV_FILE=.env.worktree scripts/local_gate.sh --profile runtime-agent` PASS evidence를 남긴다.
- [x] `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`, `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`, `research/13-redesign/00-execution-tracker.md`를 갱신한다.

### MOMO-231 수용기준 `[docs/tooling]`
- [ ] GitHub #219를 `scripts/goal_claim.sh 219`로 claim하고 별도 branch/worktree에서 진행한다.
- [ ] `.github/ISSUE_TEMPLATE/`에 internal alpha feedback template을 추가하고, raw report는 `type:feedback` + `area:alpha` + `status:needs-triage`로 시작한다.
- [ ] `docs/INTERNAL_ALPHA_FEEDBACK.md`에 severity(P0 data loss/security, P1 core alpha flow blocked, P2 usability friction, P3 polish), evidence requirements, triage 절차를 정의한다.
- [ ] evidence requirements는 local gate profile, diagnostics bundle path, repro steps, workspace/channel/member context, expected/actual을 포함한다.
- [ ] momo-main triage 절차를 feedback -> GitHub issue -> labels/milestone -> buildable goal -> worker prompt -> review/merge로 고정한다.
- [ ] `scripts/goal_status.sh`와 GitHub 운영 문서가 `status:needs-triage` 확인 방법을 보여준다.
- [ ] 새 라벨은 `.github/labels.json`과 `scripts/github/labels.tsv`에 반영한다.
- [ ] `docs/INTERNAL_ALPHA.md`, `docs/LOCAL_PR_GATE.md`, `docs/GITHUB_OPS.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] 검증: `scripts/local_gate.sh --profile docs` PASS.

### MOMO-234 수용기준 `[docs/tooling]`
- [x] GitHub #225를 `scripts/goal_claim.sh 225`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] Codex OAuth/Hermes provider boundary ADR 또는 runbook을 추가한다.
- [x] token owner/storage/rotation/redaction/failure mode/audit 원칙을 정리한다.
- [x] `scripts/verify_external_agent_provider.sh` 또는 관련 docs를 보강한다.
- [x] secret 없이도 `scripts/local_gate.sh --profile external-agent-provider`가 safe skip/pass evidence를 남긴다.
- [x] 실제 credentialed smoke에 필요한 env var를 `AGENT_PROVIDER_MODE=external-hermes`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `AGENT_MODEL`, optional `EXTERNAL_AGENT_PROVIDER_ENV_FILE`로 명확히 한다.
- [x] 알려진 Codex/OpenAI OAuth access/refresh token env var가 momo smoke process에 들어오면 fail-fast한다.
- [ ] `scripts/local_gate.sh --profile external-agent-provider` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] PR 생성 후 GitHub #225를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-238 수용기준 `[docs/tooling/swift]`
- [x] 별도 worktree/branch `feat/MOMO-238-external-hermes-provider`에서 진행한다.
- [x] `docs/external-agent-provider/local-hermes-gpt.md`에 `AGENT_PROVIDER_MODE=external-hermes` local loopback opt-in 계약을 문서화한다.
- [x] `http://127.0.0.1:<port>/v1` 또는 `http://localhost:<port>/v1`은 `MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`일 때만 허용한다.
- [x] non-loopback `http://...` provider URL은 서버/워커 설정과 verifier에서 계속 fail-fast한다.
- [x] Codex/OpenAI OAuth token/API key env가 momo app/API/DB/evidence path로 들어오면 verifier가 fail-fast한다.
- [x] `scripts/verify_external_agent_provider.sh`와 `scripts/local_gate.sh --profile external-agent-provider` coverage note를 local Hermes GPT contract에 맞춰 보강한다.
- [x] credential 없는 환경은 `runtime-unverified(external provider credentials)` explicit skip PASS를 유지한다.
- [ ] 검증: `scripts/local_gate.sh --profile docs` PASS.
- [ ] 검증: `scripts/local_gate.sh --profile external-agent-provider` PASS(no-credential explicit skip).
- [ ] 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [x] `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] PR 생성 후 GitHub issue를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-242 수용기준 `[runtime/docs/swift]`
- [x] 기존 GitHub issue #242를 `scripts/goal_claim.sh 242`로 claim하고 별도 branch/worktree `feat/242-external-agent-runtime-smoke`에서 진행한다.
- [x] `docs/external-agent-provider/README.md`에 external agent runtime secret env 형식, mock/local runtime과 external runtime의 차이, provider token/Codex OAuth/OpenAI key 비저장 boundary를 문서화한다.
- [x] `scripts/verify_external_agent_provider.sh` credentialed path가 `channel message -> agent run -> external runtime call -> durable agent response` 최소 1왕복 smoke를 유지하고, PASS status에서 `degradedReason`이 비어 있음을 확인한다.
- [x] `scripts/local_alpha_runner.sh execute --hermes external --external-smoke --secret-env <outside-repo-env>` 옵션을 추가해 local alpha runner에서 같은 external runtime smoke로 위임할 수 있게 한다.
- [x] `/v1/agent-runtime/status`와 macOS Kim Intern status surface가 redacted `degradedReason`을 표시하되 provider token/API key/OAuth secret은 노출하지 않는다.
- [x] `docs/INTERNAL_ALPHA.md`, `docs/RUN.md`, `docs/LOCAL_PR_GATE.md`, `docs/INDEX.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] 검증: `scripts/local_gate.sh --profile docs` PASS.
- [x] 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [x] Credentialed real provider PASS는 provider secret이 있는 환경에서만 닫고, 없는 환경에서는 `runtime-unverified(external provider credentials)`로 남긴다.
- [ ] PR 생성 후 GitHub #242를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-256 수용기준 `[runtime-agent/macos-ui/swift]`
- [x] GitHub issue #256을 발급하고 별도 branch/worktree `feat/256-local-hermes-agent-bridge-v0`에서 진행한다.
- [x] Hermes를 seeded workspace의 `member.kind='agent'`, display name `Hermes`, handle `hermes`, `#general`/`#agent-lab` active channel member로 추가한다.
- [x] MomoServer/AgentWorker/macOS 기본 agent handle/display를 `@hermes`/`Hermes`로 정렬하고, 기존 Kim Intern fixture는 backward-compatible path로 남긴다.
- [x] local loopback OpenAI-compatible provider endpoint/token env를 지원하고, non-loopback HTTP는 명시 opt-in 없이는 fail-closed 경계를 유지한다.
- [x] `@hermes` mention -> `agent_job` 생성 -> AgentWorker SSE 호출 -> usage ledger/reserve -> same channel durable response message를 repo-local verifier로 검증한다.
- [x] provider 실패 반복 시 사람이 읽을 수 있는 degraded/error message를 같은 timeline에 기록한다.
- [x] `scripts/verify_local_hermes_bridge.sh`가 mock provider fallback과 actual local provider endpoint smoke를 evidence에서 구분한다.
- [ ] `scripts/local_gate.sh --profile runtime-agent` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성/리뷰/머지 후 issue #256을 `status:done`으로 전환한다.

### MOMO-325 수용기준 `[runtime-agent/docs/swift]`
- [x] GitHub issue #280을 `MOMO-325`로 발급하고 branch `feat/280-hermes-gateway-native-platform-integration-v1`에서 진행한다.
- [x] 기존 AgentWorker SSE 경로를 유지하고, `AGENT_GATEWAY_MODE=gateway`에서만 Hermes native platform delivery를 opt-in한다.
- [x] Hermes adapter가 최신 plugin path(`PLUGIN.yaml` + `adapter.py`)에서 load 가능한 구조와 `register(ctx)` hook을 제공한다.
- [x] MomoServer가 `@hermes` mention에서 `agent_run`/context/budget/audit shell을 만들고 `agent.job` realtime broadcast + `agent_job(method=gateway)` ledger row를 생성한다.
- [x] AgentWorker는 `method='gateway'` job을 claim하지 않는다.
- [x] Gateway adapter는 job을 받아 provider runtime을 호출하고 result/usage/status를 momo REST callback endpoint로 보고한다.
- [x] Gateway callback secret이 없거나 틀리면 fail-closed 401이고, momo는 final response를 same-channel durable message로 기록한다.
- [x] usage ledger/audit 최소 기록, self-loop/idempotency/reconnect guard, direct Centrifugo publish 금지 경계를 문서화한다.
- [x] `scripts/momo hermes-gateway-init/status/smoke`와 `scripts/verify_hermes_gateway_adapter.sh` mock gateway harness를 추가한다.
- [x] `docs/external-agent-provider/hermes-gateway-native-platform.md`, `docs/RUN.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [x] `scripts/local_gate.sh --profile runtime-agent` PASS evidence를 PR에 첨부한다.
- [x] 실제 Hermes CLI가 없으면 real gateway e2e는 `runtime-unverified(real hermes gateway missing)`로 남긴다.
- [x] PR 생성, 코드 리뷰 후 필요한 수정, 최종 local gate, merge까지 momo-main 파이프라인으로 진행한다.

### MOMO-326 수용기준 `[runtime-agent/docs/tooling]`
- [x] GitHub issue #282를 `MOMO-326`으로 발급하고 branch `feat/282-real-hermes-gateway-credentialed-smoke`에서 진행한다.
- [x] Hermes gateway runtime 설치/실행 절차와 provider OAuth boundary를 `docs/external-agent-provider/hermes-gateway-native-platform.md`와 `docs/RUN.md`에 문서화한다.
- [x] `adapters/hermes/plugin.yaml`이 실제 Hermes platform plugin manifest(`kind: platform`, `requires_env`, `optional_env`) 형태를 갖는다.
- [x] `momo_adapter.py`가 최신 `gateway.platforms.base.BasePlatformAdapter(config, platform)` path와 legacy registry를 모두 import/register-safe하게 지원한다.
- [x] adapter login operator와 agent member를 분리해 private `agentwork:ws<workspace>.<agentMember>` work stream을 구독한다. (`agent:`는 후속 observable progress surface.)
- [x] `scripts/momo hermes-gateway-install-plugin`과 `scripts/momo hermes-gateway-smoke --real [--trigger]`를 제공한다.
- [x] real smoke verifier가 Hermes CLI/plugin/provider-login/momo-server/roundtrip failure를 단계별 evidence로 분리하고 provider OAuth/Codex/OpenAI credential env가 momo process에 보이면 fail-fast한다.
- [x] `bash -n scripts/momo scripts/verify_hermes_gateway_real_smoke.sh` PASS, `python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS.
- [x] 현재 머신에 Hermes CLI가 없으면 `scripts/momo hermes-gateway-smoke --real`이 `NEEDS_USER_INSTALL` evidence를 남기고, real provider roundtrip은 `runtime-unverified(real hermes gateway missing; user install/login required)`로 표기한다.
- [x] 사용자 설치/OAuth 후 `MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger` PASS evidence를 추가해 local solo alpha readiness를 갱신한다. Evidence: `/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-hermes-gateway-real/20260708T162458Z/summary.md`.
- [x] Centrifugo token expiry/reconnect window에서 `agent.job` realtime event를 놓쳐도 Hermes adapter가 gateway-secret REST pending-job recovery endpoint로 `agent_job(method=gateway)`를 drain하고 final callback을 완료한다.

### MOMO-228 수용기준 `[docs/manual]`
- [ ] `docs/INTERNAL_ALPHA.md`에 internal alpha quickstart, local tools/env/gate sequence, `MomoMacDevApp` launch 절차, seeded account/workspace/channel/agent assumptions를 정리한다.
- [ ] invite creation + `/v1/join`, 김인턴 mock path, diagnostics collection, bug report template, known limitations를 한 문서에서 따라 할 수 있게 한다.
- [ ] `docs/INDEX.md`, `docs/RUN.md`, `docs/LOCAL_PR_GATE.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`에 문서 위치와 gate/상태 영향을 반영한다.
- [ ] 검증: `scripts/local_gate.sh --profile docs` PASS. 가능하면 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.

### MOMO-110 수용기준 `[docs/spec]`
- [ ] `research/10-local-ai-protocol-trust/`에 Apple local LLM, Context Broker, Agent Protocol, Google Workspace, Trust, local ops 연구 문서 추가.
- [ ] `ROADMAP.md`, `docs/BACKLOG.md`, `BUILD_TICKETS.md`, `docs/INDEX.md`, `STATUS.md`에 새 에픽/티켓/진행 상태 반영.
- [ ] build-macos-apps 플러그인은 SwiftPM build/test/triage와 SwiftPM GUI app 실행 표준화에 적극 사용하되, store signing/notarization은 M4에서 분리한다는 원칙 기록.

### MOMO-111 수용기준 `[ci/docs]`
- [ ] `scripts/local_gate.sh --profile docs|swift|diagnostics|staging-smoke|host-runtime|backup|local-alpha|runtime-db|runtime-relay|runtime-live|runtime-agent|macos-ui|m3-dbc|all` 설계/구현.
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

### MOMO-224 수용기준 `[tooling/docs]`
- [x] GitHub #201을 `scripts/goal_claim.sh 201`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/collect_diagnostics.sh`가 diagnostics directory, `summary.md`, optional `.tar.gz` archive를 생성한다.
- [x] server/relay/worker verifier logs, Centrifugo compose logs, macOS unified logs, env shape, git commit/status, local gate evidence를 best-effort로 수집한다.
- [x] secrets/password/token/API key/HMAC/database URL credentials를 bundle write 전에 `[REDACTED]`로 치환한다.
- [x] 실패 상황에서도 가능한 evidence를 남기고 collector 자체는 missing Docker/log/app을 fatal로 취급하지 않는다.
- [x] `scripts/local_gate.sh --profile diagnostics`를 추가해 redaction smoke를 자동화한다.
- [x] `docs/LOCAL_PR_GATE.md`, `docs/RUN.md`, `docs/GITHUB_OPS.md`, `docs/INDEX.md`, `ROADMAP.md`, `STATUS.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] `scripts/local_gate.sh --profile diagnostics` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #201을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-225 수용기준 `[tooling/runtime]`
- [x] GitHub #209를 `scripts/goal_claim.sh 209`로 claim하고 별도 branch/worktree `chore/209-internal-alpha-combined-local-gate-v0`에서 진행한다.
- [x] `scripts/local_gate.sh --profile internal-alpha`를 추가한다.
- [x] `internal-alpha`는 `LOCAL_GATE_LAUNCH_UI=1`을 요구하고, host-runtime, backup restore, macOS real-backend UI, diagnostics bundle을 한 PR-ready evidence packet으로 묶는다.
- [x] host-runtime evidence에는 prod+internal-smoke local image boot, `/health`, migration idempotency, REST message, OutboxRelay publish, mock Hermes/Kim Intern roundtrip을 포함한다.
- [x] macOS evidence에는 `MomoMacDevApp` real backend launch/process/window/log path를 포함한다.
- [x] diagnostics bundle directory/archive path와 backup restore markdown/json evidence path를 local gate artifact packet에 포함한다.
- [x] `docs/RUN.md`, `docs/LOCAL_PR_GATE.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #209를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-115 수용기준 `[runtime/infra]`
- [x] `scripts/verify_relay.sh`가 seeded demo user login + REST send로 outbox `pending`을 만들고, relay 시작 후 SKIP LOCKED claim(`attempts>=1`) + Centrifugo history + outbox `done`을 검증한다.
- [x] `version=message.seq` evidence를 DB message response, outbox payload version, Centrifugo history publication의 동일 message id/seq로 남긴다.
- [x] `scripts/local_gate.sh --profile runtime-relay`가 Docker compose/migrate/server/relay/message send/evidence 검증을 자동 실행한다.
- [x] worktree별 `.env.worktree` 포트/`COMPOSE_PROJECT_NAME` isolation을 사용한다.
- [x] 실패 시 local gate evidence log와 verifier server/relay/history log path를 남긴다.

### MOMO-196 수용기준 `[runtime/infra]`
- [x] `scripts/verify_realtime_live.sh`가 Docker dev compose PG/Centrifugo + host MomoServer/OutboxRelay + compose-network `api:8080` proxy에서 seeded demo login, `/v1/auth/realtime-token`, Centrifugo WebSocket connect/subscribe, REST message send, live `message.new` publication 수신을 검증한다.
- [x] evidence에 REST `message.seq`, `payload.message.seq`, Centrifugo publication offset/version-equivalent, `client_msg_id`, channel을 남긴다.
- [x] invalid Centrifugo connection token reject 경로를 최소 1개 검증한다.
- [x] `scripts/local_gate.sh --profile runtime-live`를 추가하고 docs/RUN.md 및 docs/LOCAL_PR_GATE.md에 사용법과 dev compose/host runtime/proxy boundary를 문서화한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] `scripts/local_gate.sh --profile runtime-live` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 issue `status:needs-review` 및 `momo-main` handoff.

### MOMO-220 수용기준 `[runtime/infra]`
- [x] GitHub #196을 `scripts/goal_claim.sh 196`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] prod compose의 api/relay/worker `build:` 없는 image-based production boundary를 유지한다.
- [x] `infra/prod/docker/`에 local api/relay/worker/migrate/mock-Hermes image build path를 추가한다.
- [x] `infra/prod/docker-compose.internal-smoke.yml`이 source checkout bind mount 없이 local image fallback으로 boot된다.
- [x] `scripts/verify_internal_host_runtime.sh`가 local images build, prod+internal-smoke compose boot, migration one-shot+idempotent rerun, `/health` 200, REST login/message send, relay publish done을 검증한다.
- [x] 같은 verifier가 mock Hermes 기반 `@김인턴` agent mention 1왕복(agent progress + final channel `message.new`)을 검증한다.
- [x] `scripts/local_gate.sh --profile host-runtime`을 추가하고 기존 `staging-smoke` static gate와 역할을 분리한다.
- [x] public TLS/DNS, real registry pull, SOPS prod secret injection, pgBackRest PITR restore는 `runtime-unverified(public host)`로 남긴다.
- [ ] `scripts/local_gate.sh --profile host-runtime` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] PR 생성 후 issue `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-221 수용기준 `[infra/docs]`
- [x] GitHub #202를 `scripts/goal_claim.sh 202`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/prod_env_preflight.sh`가 `staging`/`prod`/`internal-host` env의 placeholder/dev-insecure/default secret, localhost/mock Hermes, local DB password, internal-smoke/latest image tag를 fail-fast로 거부한다.
- [x] `internal-smoke`/`local` mode에서는 `infra/prod/internal-smoke.env.example`과 verifier-generated temp env의 의도된 local placeholder만 허용한다.
- [x] `scripts/verify_staging_smoke.sh`, `scripts/verify_internal_hosting_smoke.sh`, `scripts/verify_internal_host_runtime.sh`가 같은 preflight 경계를 호출한다.
- [x] `docs/RUN.md`, `docs/DEPLOY.md`, `docs/SECRETS_BACKUP_RUNBOOK.md`에 required env, secret generation/import path, SOPS `exec-env` path, operator checklist를 반영한다.
- [x] public DNS/TLS, real registry pull, real SOPS secret injection, pgBackRest PITR restore rehearsal은 `runtime-unverified(public host)`로 남긴다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] 가능하면 `scripts/local_gate.sh --profile staging-smoke` 또는 `scripts/local_gate.sh --profile host-runtime` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 issue `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-227 수용기준 `[swift/docs/host-runtime]`
- [x] GitHub #211을 `scripts/goal_claim.sh 211`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `AGENT_PROVIDER_MODE`를 `local-mock` / `internal-host-mock` / `external-hermes`로 정의하고 local/internal-host/external Hermes env contract를 문서화한다.
- [x] staging/prod/internal-host에서 mock/localhost/placeholder external provider config를 MomoServer, AgentWorker, `scripts/prod_env_preflight.sh`가 fail-fast로 거부한다.
- [x] `GET /health`와 `GET /v1/agent-runtime/status`가 Kim Intern provider mode/availability를 secret-redacted projection으로 반환한다.
- [x] macOS sidebar가 Kim Intern `Available`/`Degraded`/`Mock` compact status chip을 표시하고 REST backend가 status projection을 읽는다.
- [x] logs/status/verifier evidence는 `HERMES_API_KEY`/token 원문을 출력하지 않는다.
- [x] `scripts/verify_internal_host_runtime.sh`가 internal-host mock status projection과 secret non-leakage를 host-runtime gate에서 검증한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] `scripts/local_gate.sh --profile host-runtime` 또는 `runtime-agent` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 issue `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-229 수용기준 `[infra/docs]`
- [x] GitHub #217을 `scripts/goal_claim.sh 217`로 claim하고 별도 branch/worktree에서 진행한다.
- [ ] `scripts/prod_env_preflight.sh` 또는 equivalent preflight가 public/staging mode에서 DNS/TLS env, pinned registry image tags, SOPS/age or host-local secret source, DB/Redis named volumes, pgBackRest stanza/check/full backup/WAL/PITR required env를 검사한다.
- [ ] placeholder/default/dev-insecure/latest/local-only/mock-only 값은 public/staging mode에서 fail-fast한다.
- [ ] internal-host/mock mode와 public/staging mode의 허용값을 명확히 분리한다.
- [ ] preflight가 PR body에 붙일 수 있는 redacted markdown/json evidence를 생성한다.
- [ ] `docs/DEPLOY.md`, `docs/RUN.md`, `docs/SECRETS_BACKUP_RUNBOOK.md`, `docs/LOCAL_PR_GATE.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 첨부한다.
- [ ] 가능하면 `scripts/local_gate.sh --profile staging-smoke` 또는 `host-runtime` PASS evidence를 첨부한다.
- [ ] 실제 DNS/TLS/production host deploy/registry pull/pgBackRest PITR/외부 Hermes 연결은 out of scope로 유지한다.
- [ ] PR 생성 후 issue `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-230 수용기준 `[runtime/docs]`
- [x] GitHub #218을 `scripts/goal_claim.sh 218`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/verify_external_agent_provider.sh`를 추가한다.
- [x] verifier는 `AGENT_PROVIDER_MODE=external-hermes`, `HERMES_BASE_URL=https://.../v1`, `HERMES_API_KEY`, optional `AGENT_MODEL` contract를 검사하고 missing default env는 explicit skip, 명시적 external misconfig는 fail-fast로 구분한다.
- [x] stdout/evidence/log artifact에는 `HERMES_API_KEY`, bearer token, DB password, app token 원문을 남기지 않는다.
- [x] credentials가 있으면 OpenAI-compatible SSE direct preflight와 local MomoServer/AgentWorker/OutboxRelay `@김인턴` 1왕복, `/v1/agent-runtime/status` redacted availability를 검증한다.
- [x] `scripts/local_gate.sh --profile external-agent-provider` opt-in profile을 추가하고 기본 `runtime-agent` mock gate는 deterministic하게 유지한다.
- [x] `docs/RUN.md`, `docs/DEPLOY.md`, `docs/LOCAL_PR_GATE.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`에 사용법과 `runtime-unverified(external provider credentials)` 경계를 기록한다.
- [x] `scripts/local_gate.sh --profile external-agent-provider` no-credential skip evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] credentials가 있으면 external provider PASS evidence를 첨부하고, 없으면 `runtime-unverified(external provider credentials)`로 표기한다.
- [x] PR 생성 후 issue `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-236 수용기준 `[runtime/docs]`
- [x] GitHub #228을 `scripts/goal_claim.sh 228`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] 내부 알파 기준 Kim Intern 초대/활성화 flow를 고정한다: seeded workspace의 active `member.kind='agent'`, display name `김인턴`, handle `kim-intern`, `#agent-lab` active membership, admin channel-membership API path.
- [x] `docs/INTERNAL_ALPHA.md`, `docs/RUN.md`, `docs/LOCAL_PR_GATE.md`가 "초대됨"과 provider "연결 가능/불가"를 분리해 설명한다.
- [x] `scripts/verify_external_agent_provider.sh` credentialed path가 external provider roundtrip 전에 Kim Intern active agent + `#agent-lab` invite precondition evidence를 생성한다.
- [x] no-credential path는 Docker/provider side effect 없이 explicit `runtime-unverified(external provider credentials)` skip PASS를 유지하고, real-provider-required 경계를 기록한다.
- [x] stdout/evidence/log artifact에는 `HERMES_API_KEY`, bearer token, DB password, app token 원문을 남기지 않는다.
- [x] `scripts/local_gate.sh --profile external-agent-provider` PASS 또는 no-credential explicit skip PASS evidence를 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 첨부한다.
- [x] STATUS.md, ROADMAP.md, BUILD_TICKETS.md를 갱신한다.
- [ ] PR 생성 후 issue `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-222 수용기준 `[runtime/infra]`
- [x] GitHub #204를 `scripts/goal_claim.sh 204`로 claim하고 별도 branch/worktree `chore/204-backup-pitr-restore-rehearsal-gate-v0`에서 진행한다.
- [x] `scripts/verify_backup_restore_rehearsal.sh`가 임시 PostgreSQL 18 source container에서 marker write 후 `pg_dump -Fc`를 만들고, 별도 restore container에 `pg_restore`하여 marker count/checksum equality를 검증한다.
- [x] verifier가 restore evidence markdown/json을 생성하고 PR body에 붙일 수 있는 경로를 출력한다.
- [x] `scripts/local_gate.sh --profile backup`을 추가하고 `host-runtime` profile에도 restore rehearsal verifier를 포함한다.
- [x] repo-local로 닫히는 범위와 실제 pgBackRest host rehearsal(`runtime-unverified(public host)`) 범위를 docs/RUN, docs/DEPLOY, docs/SECRETS_BACKUP_RUNBOOK, docs/LOCAL_PR_GATE에 분리 기록한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR #206에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR #206에 첨부한다.
- [x] 가능하면 `scripts/local_gate.sh --profile backup` 또는 `scripts/local_gate.sh --profile host-runtime` PASS evidence를 PR #206에 첨부한다.
- [x] PR 생성 후 issue `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-212 수용기준 `[runtime-agent/swift]`
- [x] GitHub #180을 `scripts/goal_claim.sh 180`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] Centrifugo `agentwork` namespace가 `agentwork:ws<workspaceUUID>.<agentMemberUUID>` private job shape에 대해 subscribe proxy를 타도록 설정한다. Observable `agent:` progress도 별도 proxy 경계를 유지한다.
- [x] `/v1/centrifugo/subscribe`가 `agent:` namespace를 fail-closed로 파싱하고, observer와 target agent가 이벤트가 발생한 정확한 active channel의 멤버일 때만 허용한다.
- [x] 기존 `ch:`/`dm:` channel membership guard와 client direct publish 금지, server/worker publish path를 유지한다.
- [x] `scripts/verify_agent_live_channel.sh`가 Docker dev compose + host API/worker + mock Hermes + Centrifugo subscribe proxy 경로를 검증한다.
- [x] authorized member가 `agent.status` 또는 `agent.partial` live publication을 수신한다.
- [x] invalid connection token, same-workspace different-channel-only member, other-workspace member/token, client direct publish가 차단된다.
- [x] `agent.status`/`agent.partial`은 ephemeral progress projection이며 `message.seq` ordering authority가 아님을 `docs/RUN.md`/STATUS에 기록한다.
- [x] focused server tests를 추가하고 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-agent` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #180을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-194 수용기준 `[tooling/docs]`
- [x] GitHub #144를 `scripts/goal_claim.sh 144`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/local_gate.sh` evidence/log filename에 pid, nanosecond timestamp, random suffix, worktree hash를 포함한다.
- [x] 같은 초에 같은 docs gate를 2개 이상 병렬 실행해도 evidence/log 파일 충돌이 나지 않는다.
- [x] PR body에 붙일 `Evidence markdown` 및 `Evidence log` path가 `## Local Gate` block에 정확히 출력된다.
- [x] `docs/LOCAL_PR_GATE.md`, `STATUS.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #144를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-199 수용기준 `[tooling/docs]`
- [x] GitHub #154를 `scripts/goal_claim.sh 154`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/goal_status.sh`가 local worktree branch를 GitHub issue/PR 상태와 매칭한다.
- [x] closed issue 또는 merged/closed PR에 연결된 worktree를 `done-candidate`/`stale-warning` 섹션으로 분리 표시한다.
- [x] current/dirty/unpushed/upstream-unknown worktree는 cleanup command를 숨기고 warning reason을 표시한다.
- [x] 기본 실행은 read-only이며 `git worktree remove`를 자동 실행하지 않는다.
- [x] clean + pushed/merged candidate에만 copy-paste 가능한 cleanup command를 출력한다.
- [x] `docs/MULTI_SESSION_OPS.md`, `ROADMAP.md`, `STATUS.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] `bash -n scripts/goal_status.sh` 및 `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #154를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-209 수용기준 `[tooling/docs]`
- [x] GitHub #172를 `scripts/goal_claim.sh 172`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/compose_janitor.sh`가 Docker Compose label 기반으로 stale `momo_` worktree project/container/network를 목록화한다.
- [x] 기본 실행은 dry-run이며 container/network 제거는 `--cleanup` 명시 시에만 수행한다.
- [x] root `momo` project, `momo_default`, `supabase`, active git worktree project, non-momo Docker resource를 cleanup 후보에서 보호한다.
- [x] Volumes는 삭제하지 않는다.
- [x] `docs/MULTI_SESSION_OPS.md`, `docs/LOCAL_PR_GATE.md`, `ROADMAP.md`, `STATUS.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] `bash -n scripts/compose_janitor.sh`, `scripts/compose_janitor.sh` dry-run, `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #172를 `status:needs-review`로 전환하고 merge하지 않는다.

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

### MOMO-216 수용기준 `[infra/docs]`
- [x] GitHub #188 claim: `scripts/goal_claim.sh 188`로 별도 worktree/branch `chore/188-internal-single-node-hosting-smoke-gate-v0` 생성, issue assign + `status:in-progress`.
- [x] `infra/prod/docker-compose.internal-smoke.yml` — prod compose 위에서 internal single-node smoke override를 제공하고 api/relay/worker는 image-based 계약을 유지한다.
- [x] `infra/prod/internal-smoke.env.example` — local-only domain/port, local image fallback tag, placeholder secret template을 제공한다.
- [x] `scripts/verify_internal_hosting_smoke.sh` — compose config, env template guard, Caddy/TLS static wiring, Centrifugo Redis engine, API health route, explicit migration path, relay/worker enablement, backup/restore placeholder boundary를 검증한다.
- [x] `scripts/local_gate.sh --profile staging-smoke`에 internal hosting smoke evidence를 포함한다.
- [x] 실제 public DNS/TLS, registry image pull/run, SOPS production secret injection, pgBackRest backup/PITR restore rehearsal은 `runtime-unverified(public TLS/DNS)`/host-runtime으로 좁게 표기한다.
- [x] `scripts/local_gate.sh --profile staging-smoke` PASS.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.
- [ ] PR 생성 후 issue `status:needs-review` 및 merge 금지.

### MOMO-150 수용기준 `[docs/spec]`
- [ ] `research/11-agent-runtime/`에 Hermes agent, internkim/Kim Intern, openclaw 분석 문서 추가.
- [ ] memory/cache/protocol gap을 Context Packet, Memory Plane, Capability Cache, A2A lifecycle, approval pause/resume 관점으로 정리.
- [ ] ROADMAP/BACKLOG/INDEX/STATUS에 MOMO-151~153, MOMO-160~163, MOMO-170~172 후속 로드맵 반영.
- [ ] 코드/스키마 구현 없이 문서/스펙만 변경.

## M1.5 Agentic Work OS / Plugin Ecosystem Strategy

| id | 한줄 | 수용기준 등급 | 의존 | 상태 |
|---|---|---|---|---|
| `MOMO-180` | Paca/OpenHands/Linear/Rovo/GitHub 흐름 기반 제품 포지션 + repo topology + deploy layering ADR | docs/spec | MOMO-150 | PR/local gate 대상 |
| `MOMO-181` | Plugin manifest v0 + catalog split criteria + approval metadata gate linkage | docs/spec | MOMO-153, MOMO-180 | PR/local gate 대상 |
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
- [x] GitHub issue #178 field vocabulary 정의: `plugin_id`, `tools`, `scopes`, `audit_surface`, `ui_surfaces`, `runtime_boundary`, `license`, `provenance`.
- [x] plugin catalog repo(`momo-plugins`) split 기준, artifact metadata, signed artifact policy, compatibility matrix를 문서화.
- [x] catalog class 기준 정의: core bundled plugin, first-party repo plugin, third-party/custom plugin, private enterprise plugin.
- [x] first-party plugin repo와 SDK repo 분리 기준을 문서화.
- [x] Context Packet `tool_grants`, Capability Cache `plugin_tool_schema`, Memory Plane `permissions.retrieval_policy_version`/plugin policy version, approval metadata gate 연결을 명시.
- [x] Paca식 plugin catalog/SDK 구조는 repo topology 참고로만 두고, momo의 channel timeline execution ledger / approval / audit / capability cache 차별점을 명확화.
- [x] JSON fixture 3종: GitHub Issues plugin manifest, Google Workspace read-mostly source plugin manifest, high-risk write action approval policy example.
- [x] `scripts/local_gate.sh --profile docs` PASS.
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
| `MOMO-197` | Server channel list endpoint + macOS dynamic channel loading v0 | swift/runtime | MOMO-176, MOMO-177 |
| `MOMO-214` | Channel create + member/invite management runtime v0 | swift/runtime-db | MOMO-176, MOMO-197 |
| `MOMO-179` | Realtime client subscription contract v0 | spec/swift | MOMO-177, MOMO-115 |
| `MOMO-192` | Server realtime-token endpoint v0 | swift/docs | MOMO-179, MOMO-115 |
| `MOMO-193` | SwiftCentrifuge RealtimeSubscriptionDriver v0 | swift | MOMO-179, MOMO-177 |
| `MOMO-198` | M3 D/B/C real-data readiness spec and blocker cleanup | docs/spec | MOMO-170, MOMO-171, MOMO-174, MOMO-177, MOMO-179, MOMO-192, MOMO-193 |
| `MOMO-205` | macOS real-backend dev app smoke gate | runtime/macos-ui | MOMO-134, MOMO-177, MOMO-197, MOMO-167 |
| `MOMO-200` | macOS SwiftCentrifuge live adapter | swift/macos-ui/runtime-relay | MOMO-192, MOMO-193 |
| `MOMO-207` | macOS realtime reconnect/status UX | swift/macos-ui | MOMO-200, MOMO-205 |
| `MOMO-201` | D Live Tool-Call fixture/local gate | runtime-agent/macos-ui | MOMO-200, MOMO-178 |
| `MOMO-202` | B Cost projection + CostSnapshot binding | swift/runtime-agent/macos-ui | MOMO-004, MOMO-170 |
| `MOMO-203` | C Approval pending projection + inbox real-data gate | swift/runtime-db/macos-ui | MOMO-167, MOMO-171 |
| `MOMO-212` | Agent channel live subscription verifier v0 | runtime-agent/swift | MOMO-200, MOMO-201 |
| `MOMO-215` | Agent mention routing e2e v0 | runtime-agent/swift | MOMO-004, MOMO-196, MOMO-212 |
| `MOMO-219` | macOS agent mention UX v0 | swift/macos-ui/runtime-agent | MOMO-177, MOMO-205, MOMO-212, MOMO-215 |
| `MOMO-204` | M3 D/B/C combined local gate profile | docs/swift/runtime-agent/macos-ui | MOMO-200, MOMO-201, MOMO-202, MOMO-203, MOMO-207 |
| `MOMO-213` | macOS real-server session/onboarding UI v0 | swift/macos-ui | MOMO-205, MOMO-211 |
| `MOMO-218` | macOS channel management UI v0 | swift/macos-ui | MOMO-213, MOMO-214 |
| `MOMO-223` | macOS session/account/server switch + logout polish v0 | swift/macos-ui | MOMO-213, MOMO-207, MOMO-218 |
| `MOMO-226` | macOS invite/admin onboarding real-backend polish v0 | swift/macos-ui | MOMO-011, MOMO-014, MOMO-213, MOMO-217, MOMO-218, MOMO-223 |
| `MOMO-232` | macOS internal alpha usability polish v0 | swift/macos-ui | MOMO-226, MOMO-227, MOMO-225, MOMO-228 |
| `MOMO-235` | macOS alpha update channel v0 | swift/docs | MOMO-211, MOMO-228, MOMO-232 |
| `MOMO-244` | Dev Update Channel v0(local/file manifest + operator-assisted install CTA) | swift/macos-ui/docs | MOMO-235 |
| `MOMO-243` | In-App Alpha Command Center | swift/macos-ui/docs | MOMO-232, MOMO-235, MOMO-239 |

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

### MOMO-197 수용기준 `[swift/runtime]`
- [x] GitHub #152를 `scripts/goal_claim.sh 152`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] MomoServer에 일반 tenant token용 `GET /v1/workspaces/{ws}/channels` endpoint를 추가한다.
- [x] endpoint는 path workspace와 JWT workspace 일치, active workspace membership, active channel membership을 확인한다.
- [x] tenant read path는 `Database.withTenantConnection`의 `SET LOCAL app.workspace_id` RLS 경로만 사용하고 BYPASSRLS를 쓰지 않는다.
- [x] response shape는 macOS REST backend decode 모델을 통해 `MomoCore.Channel`로 변환된다.
- [x] inactive channel membership(`left_at`)은 제외하고, archived channel은 기본 제외/명시 query에서만 포함한다.
- [x] nonmember와 workspace-cross access는 403으로 닫는다.
- [x] `MomoCore.ChatBackend.channels(workspace:)`와 `MomoServerRESTChatBackend.channels(workspace:)`를 추가한다.
- [x] `MomoMac` REST mode bootstrap은 server channel list를 읽어 `ChatViewModel.channels`를 채우고, 실패 시 `connectionError`를 남긴다.
- [x] `LiveChatBackend.seedDemo()` fallback은 `MOMO_SERVER_BASE_URL` 미설정 경로로 유지한다.
- [x] focused server/macOS tests를 추가한다.
- [x] `scripts/verify_channel_list.sh`를 추가하고 `runtime-db` local gate에 연결한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] 관련 runtime/docs local gate PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #152를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-214 수용기준 `[swift/runtime-db]`
- [x] GitHub #186을 `scripts/goal_claim.sh 186`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `POST /v1/workspaces/{ws}/channels`로 public/private channel을 생성한다.
- [x] 생성자는 해당 channel membership을 얻고 `channel_seq` 초기 행이 생성된다.
- [x] owner/admin만 channel create 및 member add/remove를 수행하고 일반 member는 403으로 차단된다.
- [x] human member와 agent member 모두 channel membership에 추가 가능하다.
- [x] 두 workspace fixture에서 tenant A token이 tenant B channel/member를 조작하지 못한다.
- [x] 정상 membership read/write는 통과하고 tenant write path는 BYPASSRLS 없이 `momo_app` + RLS로 검증한다.
- [x] `scripts/verify_channel_management.sh`가 channel create + membership + message send를 검증한다.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] PR 생성 후 GitHub #186을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-179 수용기준 `[spec/swift]`
- [x] GitHub #124를 `scripts/goal_claim.sh 124`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md`에 REST auth → realtime token, channel naming, subscribe authorization, event envelope, `message.seq` replay/idempotency/gap-fill, reconnect/resubscribe, macOS apply boundary를 고정한다.
- [x] `research/11-agent-runtime/fixtures/realtime-client-subscription-contract-v0/*.json`에 `message.new`, `approval.requested`, `approval.decided`, `agent.partial`, `agent.status`, gap/backfill scenario fixtures를 추가한다.
- [x] Server/worker publish payloads를 MomoCore realtime decode keys와 정렬한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #124를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-192 수용기준 `[swift/docs]`
- [x] GitHub #141을 `status:in-progress`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `POST /v1/auth/realtime-token`을 protected auth group에 추가한다.
- [x] App access token 검증 후 active member/workspace를 tenant RLS read path로 재확인한다.
- [x] `sub=member_id`, `ws=workspace_id`, JSON `info`, 짧은 TTL을 담은 Centrifugo connection JWT를 발급한다.
- [x] 일반 `ch:`/`dm:` 구독 권한은 `/v1/centrifugo/subscribe` membership guard에 남기고, client direct publish 금지를 유지한다.
- [x] TTL clamp, token claims, expired app token, response shape focused server tests를 추가한다.
- [x] `docs/RUN.md`, `research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] Docker 기반 login → realtime-token smoke evidence를 첨부한다.
- [ ] PR 생성 후 GitHub #141을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-193 수용기준 `[swift]`
- [x] GitHub #142를 `scripts/goal_claim.sh 142` 상당의 기존 claim/worktree에서 진행한다. 사용자 입력의 #143은 MOMO-186으로 확인되어 ready로 복구했다.
- [x] `MomoCore`에 `RealtimeSubscriptionDriver`/`RealtimeEnvelopeSubscriptionTransport`/`RealtimeReplayController` abstraction을 추가한다.
- [x] `MomoServerRESTChatBackend.subscribe(channel:)`가 optional realtime driver로 live stream을 연결할 수 있고, driver 미주입 시 fallback/demo empty stream을 유지한다.
- [x] `message.seq` duplicate replay, seq gap, REST backfill trigger, buffered replay drain 테스트를 추가한다.
- [x] `agent.partial`/`agent.status`는 seq ordering authority가 아닌 non-durable progress projection으로 controller가 별도 통과 처리한다.
- [x] SwiftCentrifuge dependency는 이번 slice에서 추가하지 않았다. NOTICE/THIRD_PARTY 변경 없음; 실제 adapter/token endpoint/full runtime e2e는 `runtime-unverified` 후속이다.
- [x] `swift test --package-path clients/Core` PASS.
- [x] `swift test --package-path clients/macOS` PASS.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #142를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-198 수용기준 `[docs/spec]`
- [x] GitHub #153을 `scripts/goal_claim.sh 153`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `research/11-agent-runtime/15-m3-dbc-real-data-readiness.md`에 M3 D/B/C real-data readiness 정본을 추가한다.
- [x] MOMO-170/171/174/177/179/192/193 완료 surface와 남은 gap을 표로 정리한다.
- [x] 기존 MOMO-020/021/022 각각의 unblock 조건, required endpoints/events, local gate profile, fixture/runtime evidence를 재정의한다.
- [x] GitHub issue #12/#13/#14 본문 또는 라벨 업데이트 제안 문구를 문서에 포함한다.
- [x] 다음 라운드 follow-up 후보 MOMO-200~204를 ROADMAP/BUILD_TICKETS에 반영한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [x] 코드 변경 없음이므로 Swift local gate는 생략하고 docs gate 중심 근거를 PR에 명시한다.
- [ ] PR 생성 후 GitHub #153을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-200 수용기준 `[swift/macos-ui/runtime-relay]`
- [x] macOS SwiftCentrifuge adapter를 추가하기 전 라이선스(MIT/permissive) 확인과 NOTICE/THIRD_PARTY 반영 여부를 결정한다.
- [x] adapter가 `POST /v1/auth/realtime-token`으로 connection JWT를 가져오고 SwiftCentrifuge token getter/refresh path에 연결한다.
- [x] `ch:ws<workspace>.<channel>` 구독을 지원하고 `/v1/centrifugo/subscribe` membership guard를 통과한다. `agent:ws<workspace>.<channel>.<agentMember>` live boundary는 MOMO-212/MOMO-338 verifier로 닫는다.
- [x] SwiftCentrifuge publication data를 `RealtimeEnvelope`로 decode하는 `RealtimeEnvelopeSubscriptionTransport` 구현을 추가한다.
- [x] `MomoServerRESTChatBackend` dev config에서 live driver를 주입할 수 있고, driver 미주입 fallback은 유지한다.
- [x] duplicate/gap/backfill은 기존 `RealtimeReplayController` 테스트를 깨지 않는다.
- [x] `scripts/local_gate.sh --profile swift` 또는 focused package tests PASS evidence를 첨부한다.
- [x] Docker/Centrifugo live subscribe smoke를 수행하거나, 수행 불가 범위를 좁게 `runtime-unverified`로 표시한다.

### MOMO-207 수용기준 `[swift/macos-ui]`
- [x] GitHub #170을 `scripts/goal_claim.sh 170`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] connection/subscription/reconnect/error/fallback state model을 `MomoCore`에 추가한다.
- [x] SwiftCentrifuge channel live adapter lifecycle delegate state를 status stream으로 노출한다.
- [x] `ChatViewModel`이 selected channel realtime status를 구독하고 manual retry action을 제공한다.
- [x] macOS timeline UI에 Live/Connecting/Reconnecting/REST fallback/Error 상태와 retry affordance를 표시한다.
- [x] live driver 미주입/REST fallback 흐름을 유지한다.
- [x] transient reconnect/fallback focused macOS tests를 추가한다.
- [x] `swift test --package-path clients/macOS` PASS.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 첨부한다.
- [ ] PR 생성 후 GitHub #170을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-201 수용기준 `[runtime-agent/macos-ui]`
- [x] repo-local mock SSE/runtime fixture가 `agent.partial` tool-call progress(`tool_call_name`, bounded `tool_call_args`)와 final `tool_result`/`message.new`를 생성한다.
- [x] MomoMac `ChatViewModel`이 live or fixture event stream에서 progress card를 coalesce하고 final message by `message.seq`로 reconcile한다.
- [x] MOMO-020 issue update proposal을 실제 티켓 본문/label 업데이트로 적용할지 PR 본문에 handoff한다.
- [x] `scripts/local_gate.sh --profile runtime-agent` PASS 또는 D-specific gate PASS evidence를 첨부한다.
- [x] `scripts/local_gate.sh --profile macos-ui` PASS evidence를 첨부한다.
- [x] 실제 Hermes/provider side effect가 없으면 해당 범위만 `runtime-unverified`로 남긴다.

### MOMO-202 수용기준 `[swift/runtime-agent/macos-ui]`
- [x] server-owned cost projection contract를 정의한다: `reserved_micro_usd`, `spent_micro_usd`, reconciled/estimated flag, soft/hard limit state.
- [x] macOS는 ledger 계산을 하지 않고 `agent.status`/`agent.partial` 또는 REST projection을 `CostSnapshot`으로만 소비한다.
- [x] `CostBreathingRing`이 reserve -> running -> reconciled -> limit warning states를 fixture/runtime data로 표시한다.
- [x] AgentWorker reserve/reconcile evidence(`usage_ledger`, `budget_window`)와 client-visible projection evidence를 같은 PR에 첨부한다.
- [x] `scripts/local_gate.sh --profile runtime-agent` PASS evidence를 첨부한다.
- [x] `scripts/local_gate.sh --profile macos-ui` PASS evidence를 첨부한다.

### MOMO-203 수용기준 `[swift/runtime-db/macos-ui]`
- [x] pending approval read/projection path를 추가한다(`GET /v1/workspaces/{ws}/approvals?status=pending` 또는 equivalent channel-history projection).
- [x] `ApprovalInboxView` initial load가 seed-only가 아니라 server-owned pending approval data를 표시할 수 있다.
- [x] approve/reject는 기존 `POST /v1/workspaces/{ws}/approvals/{approval}/decision`과 `client_decision_id` idempotency를 사용한다.
- [x] receipt와 `approval.decided` realtime event가 inbox row/card status를 reconcile한다.
- [x] approved deterministic resume path는 `tool_result`/audit/job-done evidence를 남기고 real external provider writes는 out of scope로 유지한다.
- [x] `scripts/local_gate.sh --profile runtime-db` PASS evidence를 첨부한다.
- [x] `scripts/local_gate.sh --profile macos-ui` PASS evidence를 첨부한다.

### MOMO-204 수용기준 `[docs/swift/runtime-agent/macos-ui]`
- [x] `scripts/local_gate.sh`에 M3 D/B/C profile 또는 documented composite command를 추가한다.
- [x] Gate evidence가 REST login/history, realtime or mock event stream, D tool-call progress/final result, B cost reserve/reconcile projection, C pending approval decision roundtrip을 한 markdown block에 기록한다.
- [x] External Hermes/provider side effects are explicitly skipped or marked `runtime-unverified`; repo-local mock path remains deterministic.
- [x] `docs/LOCAL_PR_GATE.md`, `docs/RUN.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 새 gate 기준으로 갱신한다.
- [x] #12(MOMO-020)는 `m3-dbc` profile PASS evidence가 PR에 첨부되고 merge된 뒤 `momo-main`이 close 가능하다고 판정한다(worker는 직접 close하지 않음).
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 첨부한다.
- [x] `scripts/local_gate.sh --profile swift` PASS evidence를 첨부한다.
- [x] `scripts/local_gate.sh --profile m3-dbc` PASS evidence를 첨부한다.

### MOMO-215 수용기준 `[runtime-agent/swift]`
- [x] GitHub #187을 `scripts/goal_claim.sh 187`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] 채널 `POST /messages`의 `@김인턴`/agent mention이 same-channel active agent membership을 확인한 뒤 같은 transaction에서 `agent_run` + `outbox(kind='agent_job')`로 이어진다.
- [x] `agent_job.payload`는 trigger message/source attribution/context projection/tool grants를 포함해 D/B/C timeline card와 audit/source badge가 소비할 수 있다.
- [x] 동일 `client_msg_id` 재전송은 기존 message/seq를 반환하고 duplicate `agent_job`을 만들지 않는다.
- [x] 채널 멤버가 아닌 agent mention은 job 없이 `agent.mention.skipped` audit로 남긴다. 다른 workspace agent는 tenant RLS 범위에서 resolve하지 않아 cross-workspace job을 만들지 않는다.
- [x] AgentWorker/mock SSE 응답은 `agent.partial`/tool-call progress를 `agent:` live channel에 남기고, final text는 durable channel `message.new`로 reconcile한다.
- [x] `scripts/verify_agent_worker.sh`가 REST send → agent_job → AgentWorker/mock SSE → agent live progress → OutboxRelay channel final `message.new` evidence를 검증한다.
- [x] `swift test --package-path server`, `swift test --package-path workers/AgentWorker`, `scripts/local_gate.sh --profile runtime-agent` PASS evidence를 PR에 첨부한다.
- [x] 가능하면 `scripts/local_gate.sh --profile m3-dbc` PASS evidence를 PR에 첨부한다.

### MOMO-219 수용기준 `[swift/macos-ui/runtime-agent]`
- [x] GitHub #195를 `scripts/goal_claim.sh 195`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] macOS member/agent roster에서 agent row click 또는 context action으로 composer에 `@김인턴` 또는 `@kim-intern` mention을 삽입할 수 있다.
- [x] 선택된 channel이 없거나 agent가 active가 아니면 mention action은 disabled 또는 clear notice를 표시한다. Channel membership final guard는 server same-channel mention routing이 유지한다.
- [x] message send는 optimistic local echo를 먼저 표시하고, realtime/progress status와 final durable agent message를 `message.seq` timeline으로 reconcile한다.
- [x] REST fallback 모드에서도 mention send 후 delayed history refresh로 final durable message를 다시 읽어 결과를 보여준다.
- [x] LiveChatBackend demo fallback은 `@김인턴`/`@kim-intern` 모두 deterministic Kim Intern progress/final response를 제공한다.
- [x] macOS unit test가 roster mention insert, alias mention response, REST fallback final refresh를 검증한다.
- [x] `scripts/verify_macos_real_backend_ui.sh`가 real-backend agent mention source send/read + agent_job 생성 smoke를 포함한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-agent` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #195를 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-205 수용기준 `[runtime/macos-ui]`
- [x] GitHub #162를 `scripts/goal_claim.sh 162`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `scripts/verify_macos_real_backend_ui.sh`가 local Docker compose + migrate + host MomoServer를 준비한다.
- [x] verifier가 REST login, channel list, history, send path를 실제 MomoServer와 PostgreSQL seed/fixture 대상으로 검증하고 markdown evidence를 남긴다.
- [x] approval/cost surface용 `approval_request` + `agent_run` + `usage_ledger` fixture를 tenant data로 준비하고, REST history response에서 structured `props`/`runId` evidence를 확인한다.
- [x] MomoServer message DTO는 REST history/send에 `props`, `runId`, `clientMsgId`를 포함해 macOS structured cards가 real backend data를 소비할 수 있다.
- [x] MomoMac REST bootstrap은 `MOMO_CHANNEL_ID` dev env를 dynamic channel list 후 선택하고, REST history의 approval/cost props로 `ApprovalInboxView`/cost sidecar state를 hydrate한다.
- [x] `scripts/local_gate.sh --profile macos-ui`는 기본적으로 GUI launch를 skip하고 REST/backend smoke를 PASS한다.
- [x] `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui`는 direct executable launch로 `MOMO_SERVER_BASE_URL` 등 env를 전달하고 process/window/log evidence를 요구한다.
- [x] `scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #162를 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: SwiftCentrifuge live adapter, notarization/signing/DMG, full M3 combined D/B/C exit gate.

### MOMO-213 수용기준 `[swift/macos-ui]`
- [x] GitHub #185를 `scripts/goal_claim.sh 185`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `MomoMacDevApp` 및 Xcode host의 첫-run/session surface에서 server base URL, email, password, optional invite code를 입력할 수 있다.
- [x] real-server mode는 `/v1/auth/login` 또는 invite code가 있는 `/v1/join` 성공 응답의 token/workspace/member로 `MomoServerRESTChatBackend`를 bootstrap한다.
- [x] 로그인 성공 후 서버 channel list/history/send/approval/cost UI로 기존 `MomoMacRootView`에 진입한다.
- [x] 인증 실패, 서버 연결 실패, empty channel list가 UI에 명확히 표시된다.
- [x] demo/stub backend fallback은 `Open Demo`로 명시 분리된다.
- [x] UserDefaults에는 server URL/email/invite code만 저장하고, password는 optional Keychain 저장으로 제한한다.
- [x] focused macOS tests로 login, join, auth failure, non-secret persistence를 고정한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] 가능하면 `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #185를 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: SSO/OAuth, App Store/Developer ID signing. Production password hash verification은 MOMO-217에서 runtime hardening으로 분리 완료했고, session/account/server switching은 MOMO-223에서 닫는다.

### MOMO-217 수용기준 `[swift/runtime-db]`
- [x] `POST /v1/auth/login`은 `human.password_hash`가 있는 계정에서 올바른 password만 허용한다.
- [x] wrong password, empty password, unknown email은 401을 반환한다.
- [x] demo seed user는 deterministic dev password(`dev-password`)로 로그인 가능하고 잘못된 password는 거부된다.
- [x] `/v1/join`으로 생성된 human은 `momo_password_hash(password)`를 저장하고 이후 login 가능하다.
- [x] platform admin scope는 일반 password 검증 후 allowlisted email + 별도 `platformAdminSecret` 조건에서만 부여된다.
- [x] password hash/raw password는 API 응답, logs, audit payload, STATUS에 노출하지 않는다.
- [ ] `scripts/local_gate.sh --profile runtime-db` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #193을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-218 수용기준 `[swift/macos-ui]`
- [x] GitHub #194를 `scripts/goal_claim.sh 194`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `MomoCore.ChatBackend`와 macOS REST backend에 channel create/member add/remove 계약을 최소 추가한다.
- [x] macOS sidebar에서 public/private channel 생성 UI를 제공한다.
- [x] roster에서 human/agent를 selected channel에 add/remove할 수 있고, agent badge/member state가 반영된다.
- [x] 권한 실패/중복/없는 멤버/서버 오류는 `BackendError.problem`/sidebar error banner로 표시하고 앱이 죽지 않는다.
- [x] 생성된 channel은 sidebar에 반영되고 즉시 선택된다.
- [x] `LiveChatBackend` demo fallback은 deterministic create/add/remove/error behavior를 제공한다.
- [x] focused macOS unit tests를 추가한다.
- [x] `scripts/verify_macos_real_backend_ui.sh` / `macos-ui` profile에 channel create + agent add/remove REST smoke를 추가한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] 가능하면 `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] PR 생성 후 GitHub #194를 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: full channel settings/preferences, archive/search, enterprise fine-grained RBAC, directory sync, mobile/iOS UI.

### MOMO-223 수용기준 `[swift/macos-ui]`
- [x] GitHub #203을 `scripts/goal_claim.sh 203`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] macOS UI에서 현재 server/workspace/member/session mode와 selected channel realtime/fallback 상태를 확인할 수 있다.
- [x] `Log Out`은 access token, workspace/channel/message/realtime cache, in-memory password, saved-password preference/Keychain entry를 지우고 chooser/demo fallback 화면으로 돌아간다.
- [x] `Switch`는 이전 token/realtime/session cache를 지운 뒤 server URL/account를 다시 입력해 재로그인할 수 있는 chooser로 돌아간다.
- [x] realtime disconnected/retry/fallback 상태는 timeline banner와 session bar/details에서 사용자가 이해할 수 있게 표시된다.
- [x] password/token/refresh token은 UserDefaults, STATUS, UI details, logs에 평문 저장/표시하지 않는다. Password는 optional Keychain 저장으로만 허용하고 logout에서 삭제한다.
- [x] focused macOS tests가 REST backend session clear, `ChatViewModel` state reset, controller logout form/state reset을 검증한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] 가능하면 `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 첨부한다.
- [ ] PR 생성 후 GitHub #203을 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: Keychain production storage finalization, signed `.app` packaging, enterprise multi-workspace admin UX, iOS session UX.

### MOMO-226 수용기준 `[swift/macos-ui]`
- [x] GitHub #210을 `scripts/goal_claim.sh 210`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] macOS server-configured/real-server mode에서 owner/admin invite create/list/revoke가 실제 MomoServer REST path를 사용한다.
- [x] session bar의 compact invite management surface에서 role, usage, expiry를 지정해 invite를 만들고 active/revoked/used 상태를 확인할 수 있다.
- [x] revoke action은 서버 응답의 `revokedAtMs`/reason을 UI state와 tests에 반영한다.
- [x] second user는 fresh invite code로 `/v1/join` 후 token/workspace/member session을 받고, `macos-ui` smoke가 joined token으로 channels/members state를 로드한다.
- [x] focused macOS tests가 invite create request mapping, list/revoke state, join token/workspace/member session을 검증한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] PR 생성 후 GitHub #210을 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: SSO/OAuth, email delivery for invite links, billing/team plans, App Store packaging/signing/notarization.

### MOMO-232 수용기준 `[swift/macos-ui]`
- [x] GitHub #220을 `scripts/goal_claim.sh 220`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] invite create/list/revoke UI에서 중복 submit 방지, 진행 상태, 실패/재시도 상태가 명확하다.
- [x] raw invite code를 생성 직후 `Copy Code`로 복사할 수 있고, raw code가 사라진 뒤 복구 불가임을 UI/문서에서 안내한다.
- [x] session/server switch/logout 후 stale channel/member/invite/realtime state가 남지 않도록 `ChatViewModel` session-sensitive state reset을 검증한다.
- [x] Kim Intern provider chip이 `Local mock` / `Internal host mock` / `External Hermes`, key/endpoint/degraded diagnostics를 내부 알파 사용자가 구분 가능하게 표시한다.
- [x] login/join/channel load/message send 실패가 recoverable error로 표시되고 retry/dismiss 경로가 있다.
- [x] 기존 D/B/C approval/cost/tool-call UI를 깨지 않는다.
- [x] focused macOS tests가 invite admin create/copy/retry, state clear, Kim Intern provider summary를 검증한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [ ] 가능하면 `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile internal-alpha` PASS evidence를 첨부한다.
- [ ] PR 생성 후 GitHub #220을 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: Developer ID signing/notary/DMG/Sparkle, iOS UI, SSO/OAuth/email invite delivery, public host deploy, real external Hermes quality evaluation.

### MOMO-235 수용기준 `[swift/docs]`
- [x] GitHub #226을 `scripts/goal_claim.sh 226`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] `docs/adr/0005-macos-alpha-update-channel-v0.md`에 Sparkle 2 우선 + manual fallback alpha channel 결정을 기록한다.
- [x] `docs/MACOS_ALPHA_UPDATE_CHANNEL.md`에 appcast/signing key/Developer ID/notarization/DMG secret boundary와 operator runbook을 정리한다.
- [x] SwiftPM dev app/Xcode host 공용 session bar에 `Updates` placeholder surface를 추가한다.
- [x] placeholder surface는 `MOMO_UPDATE_*` non-secret hints만 읽고 Sparkle private key/Apple signing material을 금지 경계로 둔다.
- [x] focused macOS tests가 feed/public-key/signing/notary/DMG readiness와 private-key-looking config diagnostics를 검증한다.
- [x] `swift test --package-path clients/macOS` 또는 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #226을 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: real Sparkle framework installation, appcast generation script, Developer ID signing, notarization, DMG build/upload, old-version-to-new-version update proof.

### MOMO-244 수용기준 `[swift/macos-ui/docs]`
- [x] GitHub #244를 `scripts/goal_claim.sh 244`로 claim하고 별도 branch/worktree `feat/244-dev-update-channel-v0`에서 진행한다.
- [x] `Updates` surface가 current version / available version / channel 상태를 표시한다.
- [x] `MOMO_UPDATE_MANIFEST_PATH` 또는 `file://` `MOMO_UPDATE_MANIFEST_URL` 기반 update metadata를 읽는다.
- [x] 새 버전이 있으면 `Open Download` CTA와 operator-assisted install/relaunch 안내를 표시한다.
- [x] 최신 상태 / 업데이트 가능 / 실패 상태를 구분한다.
- [x] update manifest 예시 fixture `clients/macOS/Fixtures/update-manifest-alpha-v0.json`를 추가한다.
- [x] `docs/MACOS_ALPHA_UPDATE_CHANNEL.md`, `docs/INTERNAL_ALPHA.md`, `docs/INDEX.md`, `docs/adr/0005-macos-alpha-update-channel-v0.md`를 local/file manifest v0 기준으로 갱신한다.
- [x] `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #244를 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: Sparkle 정식 연동, Developer ID signing, notarization, DMG/App Store 배포, 완전 무인 self-replace updater.

### MOMO-243 수용기준 `[swift/macos-ui/docs]`
- [x] GitHub #243을 `scripts/goal_claim.sh 243`으로 claim하고 별도 branch/worktree에서 진행한다.
- [x] macOS 앱 안에 `Alpha Command Center` detail pane을 추가한다.
- [x] Server / Realtime / Agent Runtime / Invites / Diagnostics / Updates 상태를 기존 `MomoMacRootView` / `ChatViewModel` / `LiveChatBackend` / REST backend projection으로 재사용해 표시한다.
- [x] 오늘 테스트할 것 체크리스트와 현재 가능한 기능/아직 안 되는 기능/known limitations를 앱 내에서 보여준다.
- [x] failed/degraded 상태에 사용자가 이해할 수 있는 detail/recovery hint를 표시한다.
- [x] empty/loading/error/retry state는 기존 recoverable error, realtime fallback, invite failure, update diagnostics 상태를 통해 구분된다.
- [x] focused macOS tests가 Command Center snapshot의 필수 surface와 degraded 상태 설명을 검증한다.
- [x] `docs/INTERNAL_ALPHA.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 갱신한다.
- [ ] `scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [ ] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #243을 `status:needs-review`로 전환하고 merge하지 않는다.
- Out of scope: 실제 자동 업데이트 설치, Sparkle 정식 연동, AWS 배포, iOS 앱 구현, 대규모 브랜드/디자인 리뉴얼.

### MOMO-263 수용기준 `[swift/macos-ui]`
- [x] GitHub #267을 `scripts/goal_claim.sh 267`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] 작은 창에서 Command Center/Approvals를 열어도 좌측 sidebar가 밀리거나 잘리지 않도록 root layout을 안정화한다.
- [x] 우측 detail surface는 좁은 창에서는 overlay drawer, 넓은 창에서는 attached inspector로 동작한다.
- [x] detail surface에는 명확한 닫기 버튼과 현재 surface 설명을 둔다.
- [x] 언어/appearance/downloads/update/session/logout 같은 운영 기능은 top toolbar가 아니라 profile footer surface로 이동한다.
- [x] profile footer menu/popover open/close가 버벅이지 않도록 sidebar-local lightweight panel로 정리한다.
- [x] 서버 설정의 입력 의미를 `서버 이름`/`서버 아이콘`으로 명확히 하고, dogfood v0 local image 선택/제거를 지원한다.
- [x] 다운로드 surface에서 update channel 상태와 Finder Downloads 열기 action을 제공한다.
- [x] dogfood 기본 roster에서 legacy Kim Intern fixture를 숨기고, Hermes/`@hermes` 초대 이후 first-class agent member가 보이는 방향을 유지한다.
- [x] `swift build --package-path clients/macOS --product MomoMacDevApp` PASS.
- [x] `swift test --package-path clients/macOS` PASS.
- [x] `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- [x] real-backend UI smoke는 direct executable launch 대신 LaunchServices `.app` launch + temporary `launchctl setenv` injection을 사용해 System Events window count flake를 피한다.
- [x] Visual smoke screenshot evidence를 남긴다.
- Out of scope: backend-persisted workspace icon/profile upload API, real Hermes credentialed provider login, Sparkle self-update install, iOS shell.

### MOMO-264 수용기준 `[swift/macos-ui]`
- [x] GitHub #269를 `scripts/goal_claim.sh 269`로 claim하고 별도 branch/worktree에서 진행한다.
- [x] profile footer click은 기술 세부 popover 대신 Profile/Settings/Downloads/Updates launcher로 동작한다.
- [x] Profile surface는 표시 이름과 프로필 이미지만 편집하며 세션 기술 정보는 보조 상태로만 표시한다.
- [x] Settings surface는 언어, 시스템/라이트/다크 appearance, workspace/server 표시 이름, workspace icon 이미지, 초대 정책을 한 페이지에서 관리한다.
- [x] 서버 아이콘은 텍스트 입력 없이 이미지 선택/제거와 기본 로고 복귀를 제공한다.
- [x] Downloads surface는 다운로드 폴더 열기/변경, update manifest 기반 이력, 성공/실패/사용불가 상태를 표시한다.
- [x] Updates surface는 최신/업데이트 가능/설정 필요/실패 상태와 current/available/manifest/download 정보를 다국어 문구로 표시한다.
- [x] sidebar/profile/settings 기본 텍스트 크기와 row 높이를 dogfood 가독성 기준으로 키운다.
- [x] `swift build --package-path clients/macOS --product MomoMacDevApp` PASS.
- [x] `swift test --package-path clients/macOS` PASS.
- [ ] `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS evidence를 PR에 첨부한다.
- Out of scope: backend-persisted profile/workspace image upload API, automatic self-update install, real Hermes pairing wizard runtime, iOS shell.

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
- [x] 당시 product default를 AgentWorker OpenAI-compatible SSE로 결정하고, 판단 기준을 momo-owned Context Packet / approval / cost / audit로 고정한다. 경로 우열은 ADR-0102 Option C가 gateway=BYOA / worker=managed 두 공식 경로로 supersede했으며 서버 소유 판단 기준은 유지한다.
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

## M4 macOS 패키징 정본

| id | 한줄 | 수용기준 등급 | 의존 |
|---|---|---|---|
| `MOMO-208` | M4 macOS packaging architecture ADR: SwiftPM dev app과 Xcode release app 경계, build-macos-apps 사용 기준, signing/notary/DMG/Sparkle 순서와 #15/#16/#17 split | docs/spec | M4 구현 전 |
| `MOMO-211` | MomoMac Xcode thin host app v0: SwiftPM dev app과 별개로 `MomoMac.xcodeproj`가 `MomoMac`/`MomoCore` local package를 import해 무서명 build되는 첫 release host slice | xcode/swift/docs | MOMO-208 |
| `MOMO-235` | macOS alpha update channel v0: Sparkle 2 alpha-channel ADR/runbook + SwiftPM dev app placeholder surface + signing/appcast secret boundary | swift/docs | MOMO-211, MOMO-228, MOMO-232 |

### MOMO-208 수용기준 `[docs/spec]`
- [x] `docs/adr/0003-macos-packaging-architecture.md` — SwiftPM `MomoMacDevApp`은 개발/로컬 게이트용, Xcode `MomoMac.app`은 릴리스 번들/서명/공증용으로 분리한다.
- [x] build-macos-apps plugin은 SwiftPM GUI 실행/진단, Xcode 설정 점검, signing/Gatekeeper/notary 실패 분류에 사용하고 Apple account/secret material은 사람/운영자 boundary로 분리한다.
- [x] #15(MOMO-030 Xcode host) → #16(MOMO-031 codesign/notary/DMG) → #17(MOMO-032 Sparkle) 후속 issue split을 문서화한다.
- [ ] `scripts/local_gate.sh --profile docs` PASS evidence를 PR에 첨부한다.
- [ ] PR 생성 후 GitHub #171을 `status:needs-review`로 전환하고 merge하지 않는다.

### MOMO-211 수용기준 `[xcode/swift/docs]`
- [x] `clients/macOS/MomoMac.xcodeproj`와 shared scheme `MomoMac`을 추가한다.
- [x] Bundle ID는 `com.dawnkim.momo`를 유지한다.
- [x] Xcode host app은 `MomoMac`/`MomoCore`를 local SwiftPM package dependency로 사용한다.
- [x] SwiftUI entrypoint는 기존 `MomoMacRootView` + `MomoMacDemo` bootstrap을 재사용한다.
- [x] Debug/Release build settings에 hardened runtime 및 entitlements file이 반영되어 있고, Developer ID signing/notary/DMG/Sparkle은 후속 M4 TODO로 남긴다.
- [x] `xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` PASS evidence를 PR에 첨부한다.
- [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS evidence를 PR에 첨부한다.
- [x] 가능한 범위에서 app launch/window smoke evidence를 첨부한다.
- [ ] PR 생성 후 GitHub #179를 `status:needs-review`로 전환하고 merge하지 않는다.

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

## ADR-0101 에이전트 신원 티켓 (Accepted 2026-07-10 → Codex 구현 대상)

### ☑ MOMO-337 수용기준 — Agent bearer 인증 v1 (서버) `[swift/runtime-agent]` · 의존: MOMO-325, MOMO-333
> 정본: `docs/adr/0101-agent-identity-credentials.md` (Option A Phase 1). 스키마 변경 불필요 — `token`(`kind='agent_bearer'`, `scopes`, `token_hash`, `revoked_at`)과 `audit_log.via_token_id`는 `001_init.sql`에 이미 존재.
- [x] [swift] 발급: human admin 인증으로 `POST /v1/workspaces/:ws/agents/:agent/credentials` → agent_bearer 토큰 mint. sha256 해시만 `token` 테이블 저장, 원문은 응답에서 1회 반환. scopes 기본값 `agent:jobs:read agent:runs:callback messages:write realtime:subscribe`, 만료 옵션.
- [x] [swift] 검증: AuthMiddleware가 Bearer가 agent_bearer면 agent principal(member.kind='agent')로 해석 + scope 검사. 폐기/만료 토큰 401 fail-closed.
- [x] [swift] 이관: agent realtime-token·`/gateway/jobs/pending`·`/gateway/events`·`/gateway/complete`가 agent_bearer를 수용하고 **토큰 actor와 대상 agent member 일치**를 검증. `AGENT_GATEWAY_SECRET`는 `MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1`일 때만 병행 수용(deprecation 로그).
- [x] [swift] 에이전트 메시지 전송: agent_bearer로 `POST .../messages` 시 author=agent member (오퍼레이터 계정 불필요).
- [x] [swift] 회전/폐기: revoke 엔드포인트 + 재발급 시 구토큰 유예기간(기본 24h) 이중 유효. 모든 agent_bearer 사용이 `audit_log.via_token_id`에 기록.
- [x] [swift] 테스트: 발급/스코프 거부/폐기 후 401/타 에이전트 토큰으로 콜백 시도 거부.
- [x] [runtime] `verify_hermes_gateway_adapter.sh`가 bearer 경로로 PASS (legacy secret 경로는 flag 하에 별도 케이스).

### ☑ MOMO-338 수용기준 — Hermes 어댑터 bearer 단일화 `[python]` · 의존: MOMO-337
- [x] [python] 오퍼레이터 email/password 로그인 경로 제거. `MOMO_AGENT_TOKEN` bearer 하나로 REST 전송·realtime-token·pending recovery·gateway 콜백 전부 인증.
- [x] [python] 시크릿 소스는 `~/.momo/hermes-gateway.env`(`chmod 600`) — Codex/OpenAI OAuth env fail-fast 경계(ADR-0004)는 그대로 유지.
- [x] [python] 401 수신 시 "토큰 폐기/만료 — 페어링에서 재발급" readable error를 남기고 지수 백오프 재시도(자격증명 자동 재발급 시도 금지).
- [x] [python] contract 테스트 갱신: 로그인 없는 플로우, bearer 헤더 형태, 미사용 refreshToken 코드 제거 확인.
- [x] [security/runtime] exact-channel observable `agent:` status/partial과 private self-only `agentwork:` job을 분리하고 dev/local-alpha/prod Centrifugo proxy 계약 및 실제 WebSocket e2e를 일치시킨다.
- [x] [python/performance] cancellation·partial reconnect listener cleanup, bounded recovery retry, completion backlog backpressure를 regression test로 고정한다.

### ☑ MOMO-339 수용기준 — 페어링 위저드 자격증명 발급/회전 UI `[swift/macos-ui]` · 의존: MOMO-337, MOMO-262
- [x] [swift] 에이전트 초대 완료 시 MOMO-337 발급 API 호출 → 토큰 원문 1회 표시 + `~/.momo/hermes-gateway.env` 기록 안내(복사 버튼). 매니페스트/export에는 계속 시크릿 비포함(MOMO-262 계약 유지).
- [x] [swift] 멤버 프로필/페어링 패널에 자격증명 상태 칩(configured/revoked)과 회전·폐기 액션.
- [x] [swift] 테스트: 매니페스트 시크릿 배제 회귀 + mock 백엔드 발급/회전 플로우.
- [x] [manual] design-review 에이전트 리포트 Blocker 0 (AGENTS.md §5 macOS UI 규칙) — fresh-context 재판정 PASS (High 2·Medium 4 → MOMO-347 `#324`).
- [x] [macos-ui] worktree clean gate full PASS: `local-gate-macos-ui-20260711T133015Z-…-r5dda86359a9b.md` (스냅샷 참조 6종은 정본 게이트 머신 재기록, 84 tests green). root post-merge macos-ui는 선재 `verify_macos_real_backend_ui.sh` dogfood 결합(→ MOMO-348 `#325`)으로 별도 추적. PR #323 merge (`881518b`).

### ☑ MOMO-349 수용기준 — Gateway 승인 왕복 `[swift/python/runtime-agent]` · 의존: MOMO-337, MOMO-338 (`#329`, ADR-0102)
- [x] gateway 콜백에 `approval_request` 이벤트: `approval` 생성 + run `awaiting_approval` 전이 (기존 상태머신 재사용, 스키마 변경 금지).
- [x] 사람 결정 시 기존 `resume_approval` outbox가 gateway에도 resume `agent.job`을 publish, 어댑터가 재개/중단 처리.
- [x] actor/run binding fail-closed, 단일 쓰기경로 불변, 승인 대기 run이 macOS 승인 인박스에 실데이터 노출.
- [x] 어댑터 tests + `verify_hermes_gateway_adapter.sh` 승인/거부 왕복 시나리오(격리 DB 패턴) + 정본 3종 갱신.
- [x] diff-scoped 보안/correctness 리뷰: approval-held/terminal late completion 409, reject cancellation ack 상태 결속, callback 크기 상한, UUID case 정규화 확인(Blocker 0).
- [x] worktree clean `runtime-agent` gate + root post-merge gate.
  - 오케스트레이터 재검증: 보안 리뷰(actor↔run binding `requireRunActorBinding` 상속 확인) + 어댑터 46 tests 재실행 OK. main 위 rebase(1c7e766) 후 worktree clean gate full PASS(`local-gate-runtime-agent-20260712T060222Z-…-rc85f176c30ed.md`), PR #337 merge(`b5b39df`), root post-merge full gate PASS(`local-gate-runtime-agent-20260712T061006Z-…-r00cd892de0ef.md`, digest 3중 보존). **승인 왕복이 gateway(BYOA) 실트래픽 경로에 랜딩.**

### ☑ MOMO-350 수용기준 — Gateway status/partial 브로드캐스트 `[swift/python/runtime-agent]` · 의존: MOMO-349 (`#330`, ADR-0102)
- [x] `/gateway/events`가 `thinking`/`streaming` 델타를 수용해 `agent.status`/`agent.partial`로 `agent:` namespace 브로드캐스트 — **outbox broadcast 경유** (단일 쓰기경로 유지).
- [x] actor/run binding(진입점 결속 상속) + 서버측 상한: 8 KiB delta / 2 KiB detail / run당 240 events/min(429). 어댑터는 512B/250ms 샘플링 전달.
- [x] macOS exact `agent:` 구독 → 기존 `AgentPartialView` 렌더(비스냅샷 78 tests) + gateway verifier status/partial·위조·크기·namespace 시나리오.
  - 오케스트레이터 검수: outbox 발행·상한·채널 케이스 확인, worktree clean gate full PASS(`…20260712T065703Z-…-re580a53c4cc4.md`), PR #338 merge(`f079279`), root post-merge gate PASS(`…20260712T070419Z-…-r52b8ed1d9f21.md`).

### ☑ MOMO-352 수용기준 — 이중 경로 동등성 verifier `[tooling/runtime-agent]` · 의존: MOMO-349, MOMO-350, MOMO-341 (`#332`, ADR-0102)
- [x] 신규 `verify_agent_path_equivalence.sh` — 격리 DB 패턴(per-run 채널 UUID, CENT_CHANNEL 대문자, digest, exit 96) 준수.
- [x] 동일 시나리오(트리거→승인→resume→최종)를 worker/gateway 2회 실행, run 전이·approval·usage/audit·durable message 동등성 비교 (허용 차이는 allowlist).
- [x] `runtime-agent` profile 배선 + clean/root gate + 정본 3종.
  - 오케스트레이터 검수: 동등성 verifier 단독 실행 PASS(`run_states=queued,running,awaiting_approval,queued,running,succeeded` 완전 일치), clean gate full PASS(`…20260712T090633Z-…-r1362178cb8be.md`), PR #340 merge(`bb76152`), **root post-merge full gate PASS(`…20260712T091339Z-…-r1ec97b3c1d2b.md`) — ADR-0102 legacy secret 호환 창 종료 조건 충족 (물리 제거는 별도 보안 정리 티켓, M7 전)**.
  - worker 구현: 양 정본 verifier를 fresh marker/OID-owned DB로 실행하고 source digest EXIT trap, worker/gateway pre-marker exit 96 exact-OID rollback, per-run 대문자 channel identity를 한 종결 verifier에서 강제한다.
  - 비교 계약: `queued→running→awaiting_approval→queued→running→succeeded`, approval 생성/승인/resume, usage/audit 존재, durable message/realtime publication을 완전 일치 비교한다. allowlist는 timing/provider metadata/lease/path-channel identity뿐이다.
  - 정적 evidence: 신규/수정 shell `bash -n`, `git diff --check` PASS. Docker/DB/verifier/local gate는 worker 금지 범위로 미실행(`runtime-unverified`); clean/root `runtime-agent`와 이 체크박스 확정은 오케스트레이터 대기.

### ☑ MOMO-351 수용기준 — 이중 경로 문서 재정렬 `[docs]` · 의존 없음 (`#331`, ADR-0102)
- [x] adapter-contract-v0 "기본 경로 아님" 문구 → 이중 경로 계약으로 교체. L4 §6·README·overview 다이어그램 재작성 (미구현 행은 normative target으로 정직 마킹).
- [x] SD-5 API 표면 소급 승인 명시 + legacy gateway 시크릿 폐기 일정(동등성 게이트 결속) 문서화. 오케스트레이터 clean `docs` gate PASS, PR #335 merge (`ebb3a52`).
> Worker #331 handoff: 계약/다이어그램/ADR-0101 연동/SD-5 소급 승인 문구를 반영했다. acceptance와 gate 체크박스는 오케스트레이터의 merge 전 `docs` evidence까지 미체크로 유지한다.

### ☑ MOMO-353 수용기준 — 로컬 게이트 drift-guard `[tooling]` · 의존 없음 (`#334`)
- [x] `ensure_runtime_env.sh`가 실행 중 Centrifugo 컨테이너의 config fingerprint(생성 시 고정 SHA-256)를 repo config와 대조 — 불일치 시 fail-closed 안내 / `MOMO_CENTRIFUGO_AUTO_RECREATE=1` opt-in 재생성.
- [x] 게이트 pre-clean이 gate-run ownership marker(uid/repo/run_id/상속 env)를 증명한 프로세스만 정리 — 합성 dogfood(28180)/사용자 프로세스 비접촉 격리 테스트를 오케스트레이터가 재실행 PASS.
- [x] 실패 경로 포함 EXIT reaping 보강. worktree clean gate PASS(`…20260712T054632Z-…-rcce46bc6339b.md`), PR #336 merge(`8337ae2`), root post-merge gate PASS(`…20260712T055710Z-…-r4f5c23a240f1.md`) — momo_main 컨테이너 fingerprint 이관은 opt-in 재생성으로 1회 수행. drift guard가 배치 내 worktree 2곳의 구세대 컨테이너를 실전 감지·이관하며 자가 실증.
  - worker 구현: compose 생성 시 repo config SHA-256 fingerprint를 고정하고 pre/post-start guard가 실행 컨테이너 fingerprint를 비교한다. drift는 fail-closed하며 `MOMO_CENTRIFUGO_AUTO_RECREATE=1`만 Centrifugo를 강제 재생성한다.
  - worker 구현: gate marker 디렉터리(uid/repo/run/pid-start 검증)+상속 env+repo command를 모두 만족한 프로세스만 stale pre-clean/EXIT/final cleanup 대상으로 삼는다. active 다른 gate와 unmarked dogfood/user process는 남기고 충돌로 처리한다.
  - worker 정적 evidence: 수정·신규 shell `bash -n`, `shellcheck`, `git diff --check`, `make -n up`, `scripts/tests/test_local_gate_drift_guard.sh` PASS(fake Docker + 합성 PID/command/env/listener; 실제 Docker/DB 미접속). clean/root runtime gate 체크는 오케스트레이터 evidence 전까지 미체크 유지.

### ☑ MOMO-356 수용기준 — Gateway 운영 공지 durable 유출 차단 `[python/runtime-agent/docs]` · 의존: MOMO-338 (`#343`)

- [x] [python] Hermes 범용 `send()`는 명시적 momo `run_id`가 있는 실제 에이전트 최종 응답만 REST message로 쓰고, session lifecycle/home channel/slash-command/model-provider 등 run-unbound 운영 공지는 성공 처리+본문 비포함 로컬 로그로 제한한다. native gateway final은 기존 `/gateway/complete`가 commit한다.
- [x] [python/docs] `MOMO_HOME_CHANNEL`/`MOMO_HOME_CHANNEL_NAME`을 plugin optional env와 adapter enablement에 연결하고, `scripts/momo hermes-gateway-init`이 신규 env 및 기존 default-channel env를 gateway 기동 전에 보강한다. `/tmp` 신규·legacy env 양쪽 mode 600/정식 키 생성 PASS.
- [x] [python] adapter contract가 `notify=true`인 reset·home·`/resume`·`/sethome` 공지도 REST 호출 0건임과 run-bound 응답만 durable send임을 고정한다. 전체 54 tests + smoke + py_compile PASS.
- [x] [tooling] `verify_hermes_gateway_adapter.sh`가 기존 marker/OID-owned DB, per-run channel UUID, 대문자 `CENT_CHANNEL`, source digest EXIT trap, exit 96 rollback 경계를 유지하며 실제 adapter 호출 전후 agent message count 불변을 검사한다. 수정 shell `bash -n`/`chmod +x` PASS.
- [x] [runtime-agent] worktree clean gate + root post-merge gate PASS.
  - 오케스트레이터 검수: 신규 adapter 경계 assertion이 system python3(3.9)로 떨어져 `dataclass(slots=True)` TypeError — `PYTHON_BIN` ≥3.10 해석 체인(PSQL_BIN 패턴 승계)을 오케스트레이터가 직접 수정 후 clean gate PASS. PR #344 merge(`0a4bf37`), Phase 0 종결 시 root `runtime-agent` full gate PASS(`local-gate-runtime-agent-20260712T170955Z-…-rfc58973d57b9.md`).
- [x] [scope] `schema_v0.sql` 무변경, UI·스냅샷 변경 없음. reference PNG 재기록 대상 없음.

### ☑ MOMO-341 수용기준 — Gateway pending durable claim/lease `[swift/runtime-agent]` · 의존: MOMO-350 (ADR-0102 배치 합류, `#333`)
> MOMO-338 성능 리뷰 후속. 현재 pending endpoint는 actor-bound read지만 lease/claim이 없어 동일 agent의 gateway 인스턴스가 겹치면 provider turn과 비용이 중복될 수 있다.
- [x] [swift/sql] `008_gateway_job_lease.sql` — outbox에 owner/acquired/expiry 멱등 추가 + shape 제약 + claim partial index. `schema_v0.sql` 무변경.
- [x] [swift] `FOR UPDATE SKIP LOCKED` 원자 claim, non-owner callback/renew/release fail-closed(트랜잭션 밖 명시적 409, actor mismatch 403).
- [x] [runtime] 동시 consumer 단일 provider execution + crash 후 expiry/takeover — verifier 시나리오 + 시나리오별 서버 단위 테스트(61 tests)로 이중 고정.
- [x] [security] bearer actor binding·Postgres SoT·REST-only callback·ADR-0004 경계 유지.
  - 오케스트레이터 검수: 게이트가 회귀 2건(approval-held 409가 lease preflight에 가려 500 / 트랜잭션 내 lease 거부가 500으로 래핑)을 검출 → resume 반려 2회로 수정·단위 테스트 고정. 3차 clean gate full PASS(`…20260712T080649Z-…-r42cd141c4758.md`), PR #339 merge(`6fcb870`), root post-merge gate PASS(`…20260712T081127Z-…-reb7c3a4b3e61.md`).
  - worker 구현: `008_gateway_job_lease.sql`이 기존 outbox에 owner/acquired/expiry를 멱등 추가하고, actor-bound pending GET이 tenant transaction의 `FOR UPDATE SKIP LOCKED` CTE로 단일 row capability를 발급한다. `schema_v0.sql` 변경 없음.
  - worker 구현: event/complete/renew/release는 exact outbox id+lease UUID+run+agent를 결속하며 lease 부재·non-owner·expired·takeover 뒤 stale owner를 transaction 밖의 명시적 409로 닫는다. Hermes adapter는 realtime을 wake-up으로만 쓰고 serial claim(limit=1) 후 provider 실행과 lease renew를 함께 감독하며 renew 상실 시 provider task를 취소한다.
  - worker 정적 evidence: server build, server 61 tests(approval-held pre-lease 409 + 동시 consumer 단일 claim + crash expiry/takeover + stale owner event/complete/renew/release 409 + expiry reclaim 포함), adapter contract 52 tests, py_compile, verifier `bash -n`/실행권한 PASS. 격리 DB 동시 claim·expiry takeover verifier와 clean/root `runtime-agent` 재검증 전이라 체크박스를 미체크 유지(`runtime-unverified`).

### ☑ MOMO-342 수용기준 — AgentWorker verifier persistent DB fixture hardening `[tooling/runtime]` · 의존: MOMO-324, MOMO-338
- [x] positive mention route는 user-owned `@hermes`를 복구/수정하지 않고 deterministic verifier-only agent/member/membership을 idempotent upsert한다.
- [x] verifier 고정 ID/handle이 기존 행과 충돌하면 기존 데이터를 덮지 않고 소유권 오류로 fail-closed한다.
- [x] verifier runtime은 소유 marker가 있는 별도 migration DB, marker-bound 전용 app/relay/worker role, DB generation 기반 UUID namespace와 전용 workspace/human/channel/budget에서 실행되어 source/dogfood DB의 queue, budget window, 비용 원장을 물리적으로 claim하거나 변경하지 않는다.
- [x] source/system/unmarked DB 지정과 verifier role identity collision은 migration/fixture write 전에 fail-closed한다.
- [x] 실제 local dogfood message/pending agent job/무관한 membership은 cleanup하지 않는다.
- [x] 비어 있는 run id를 UUID SQL에 전달하지 않고 fixture/mention 실패를 readable evidence로 구분한다.
- [x] `runtime-agent` local gate가 같은 persistent verifier DB에서 verifier를 연속 2회 실행하고 보존 sentinel, source DB 비변경, Centrifugo generation namespace 재실행 경계를 확인한다.

### ☑ MOMO-343 수용기준 — AgentWorker verifier fresh DB marker bootstrap regression `[tooling/runtime]` · 의존: MOMO-342
- [x] fresh verifier DB의 canonical UUIDv4 ownership marker를 psql stdin SQL에서 literal-safe하게 기록한다.
- [x] marker/migration/role bootstrap 실패 시 이번 실행이 새로 만든 exact verifier DB만 정리하며, 의도적 post-marker failure regression으로 DB 부재를 검증한다.
- [x] 기존 unmarked/source/system DB는 migration·fixture write 전에 fail-closed한다.
- [x] fresh bootstrap 1회와 같은 persistent verifier DB 재실행 1회가 모두 PASS한다.
- [x] root main `runtime-agent` post-merge gate 회귀를 재현하고 복구한다.

### ☑ MOMO-344 수용기준 — Agent context verifier isolated DB boundary `[tooling/runtime-agent]` · 의존: MOMO-343
- [x] context verifier의 MomoServer/AgentWorker/fixture를 source dogfood DB가 아닌 marker/OID-owned migrated DB로 격리한다.
- [x] verifier app role은 NOBYPASSRLS, worker role만 BYPASSRLS이며 exact marker cleanup 전 NOLOGIN 처리한다.
- [x] source DB의 agent_job/agent_run/approval/message digest가 전후 동일함을 검증한다.
- [x] unrelated pending `resume_approval`이 source DB에 있어도 context assembly history/role/cross-channel/char-budget assertions가 PASS한다.
- [x] clean `runtime-agent` gate와 root main post-merge gate evidence를 남긴다.
  - worktree clean gate PASS: `local-gate-runtime-agent-20260711T101151Z-…-rb7797b74d2f5.md`
  - root post-merge: MOMO-344 범위 verifier(bootstrap rollback + context + source digest 보존) 전부 PASS. full gate는 선재하던 `verify_agent_live_channel.sh` 격리 결함(→ MOMO-345 `#320`)과 momo_main Centrifugo 낡은 running-config(재시작으로 해소)로 별도 추적.

### ☑ MOMO-345 수용기준 — Agent live channel verifier isolated DB boundary `[tooling/runtime-agent]` · 의존: MOMO-344
- [x] live channel verifier의 MomoServer/AgentWorker/OutboxRelay/fixture를 MOMO-344 패턴의 marker/OID-owned migrated DB로 격리한다.
- [x] authorized/unauthorized/other-workspace/revoked-credential/agentwork exact-actor assertion이 fresh 격리 DB에서 PASS한다.
- [x] source DB digest가 성공/실패 경로 모두에서 전후 동일하고 cleanup은 fail-closed다.
- [x] root main persistent dogfood DB의 fixture drift(예: agent 멤버십 left_at)와 무관하게 verifier PASS.
- [x] clean `runtime-agent` gate와 root main post-merge gate evidence를 남긴다.
  - 구현: marker/OID-owned fresh migrated DB, marker-bound app/worker/relay role, deterministic live fixtures, source digest, pre-marker rollback helper.
  - worktree clean gate full PASS: `local-gate-runtime-agent-20260711T112751Z-…-red25beecd13d.md`
  - root post-merge: live channel verifier PASS + source digest 보존 (drift 있는 dogfood DB 위에서 실증). full gate는 선재하던 hermes bridge/gateway verifier의 dogfood 결합(→ MOMO-346 `#322`)으로 별도 추적.

### ☑ MOMO-346 수용기준 — Hermes bridge/gateway verifier isolated DB boundary `[tooling/runtime-agent]` · 의존: MOMO-345
- [x] `verify_local_hermes_bridge.sh`/`verify_external_agent_provider.sh`/`verify_hermes_gateway_adapter.sh`가 MOMO-344/345 패턴의 격리 DB와 marker-bound role을 사용하고 Hermes/#agent-lab fixture를 자체 seed한다.
- [x] invite precondition·external-hermes roundtrip·gateway bearer assertion이 fresh 격리 DB에서 PASS한다 (dogfood 채널에 메시지 비작성).
- [x] source DB digest가 성공/실패 경로 모두에서 전후 동일하고 cleanup은 fail-closed다.
- [x] root main persistent dogfood DB의 drift와 무관하게 `runtime-agent` full gate가 root main에서 PASS한다 — **verifier 격리 캐스케이드 종결 (2026-07-12)**.
- [x] clean `runtime-agent` gate와 root main post-merge gate evidence를 남긴다.
  - worktree clean full gate PASS: `local-gate-runtime-agent-20260711T154717Z-…-r1feb7be05908.md`
  - root post-merge full gate PASS: `local-gate-runtime-agent-20260711T155410Z-…-re2f9b4903131.md` (context/live/bridge/gateway 4-verifier source digest 보존 확인)
  - 검수 이탈 2건 수정: ① relay `version=message.seq` 기반 stale skip — 격리 DB seq 리셋 + 고정 채널명 조합이 공유 Centrifugo에서 조용히 drop됨 → per-run 채널 UUID(worker resume 수정, `1706590`) ② 채널명 대소문자 불일치 — 서버(Swift UUID)는 대문자, verifier(python)는 소문자 → CENT_CHANNEL 대문자 정규화(오케스트레이터 직접 수정, `0bb685e`)
  - gate 잔류 프로세스 누수 관찰(MOMO-319 유형): 실패한 게이트 런의 MomoServer 2개가 포트를 점유해 pre-clean fail-fast — 수동 정리 후 재실행.

### ☑ MOMO-347 수용기준 — Pairing popover credential embedding hardening `[swift/macos-ui]` · 의존: MOMO-339
- [x] ~290pt 유효 폭 스냅샷 또는 popover 실임베딩 캡처 evidence (High 1) — 290×620pt, 3 credentials + 긴 한·영 혼합 label fixture.
- [x] popover 수직 성장 스크롤 전략 결정·구현 (High 2) — 340pt 폭/최대 640pt 높이 `ScrollView`, 24pt inset으로 bottom action까지 스크롤 접근.
- [x] Medium 4건(명목상 large-type 스냅샷, 폐기 notice 귀속, 3중 중첩 카드, refresh 경합) 각각 수정 또는 명시적 won't-fix 근거 — constrained-window로 정직화, row-scoped notice, flat popover section, mutation-after-in-flight refresh + 회귀 테스트.
- [x] design-review 재판정 Blocker 0/High 0 + `macos-ui` gate PASS — 오케스트레이터 fresh-context 재판정 **PASS (Blocker 0/High 0/Medium 2/Nitpick 3)**, 스냅샷 3종 정본 머신 재기록, worktree clean `macos-ui` gate full PASS(`local-gate-macos-ui-20260711T160222Z-…-r7fc05a1bc084.md`), PR #327 merge (`51db851`). root post-merge macos-ui는 선재 MOMO-348 지점에서만 중단(신규 회귀 없음 확인).
  - 잔여(후속 후보, 티켓 미발급): [Medium] 리스트 레벨 error가 행 귀속 notice와 동일 해부구조로 렌더돼 스코프 오독 소지(`MomoAgentCredentialViews.swift:169`) · 행별 ViewThatFits로 상태 칩 세로 스캔 붕괴(`:227`). [Nitpick] large-Dynamic-Type 실증 부재(장기), 자식 소유 Divider, human 모드 카드 elevation 불일치.

### ☑ MOMO-348 수용기준 — macos-ui real backend verifier isolated DB boundary `[tooling/macos-ui]` · 의존: MOMO-346
- [x] `verify_macos_real_backend_ui.sh`가 MOMO-344/345 패턴의 격리 DB와 marker-bound role을 사용하고 demo/hermes fixture를 자체 seed한다 — per-run uuid5 channel + CENT_CHANNEL 대문자 정규화(MOMO-346 교훈)까지 첫 커밋부터 반영.
- [x] login/invite/join/member/send/mention→agent_job/history assertion이 fresh 격리 DB에서 PASS하고 dogfood DB에 mutation을 남기지 않는다 (digest 전후 동일).
- [x] root main persistent dogfood DB drift와 무관하게 `macos-ui` full gate가 root main에서 PASS한다.
- [x] clean gate + root post-merge gate evidence, 정본 3종 갱신.
  - worktree: bootstrap 회귀 + 단독 verifier + clean full gate PASS (`local-gate-macos-ui-20260711T185500Z-…-rff8c71d8f960.md`)
  - root post-merge full gate PASS (`local-gate-macos-ui-20260711T190121Z-…-r0e6956276818.md`, source digest 보존) — **verifier 격리 캐스케이드(MOMO-342→348) 전 프로파일 종결 (2026-07-12)**. PR #328 merge (`444ee59`).
  - 검수 노트: 1차 worker 실행이 API 무응답으로 행(CPU 0, 2.5h) → kill 후 재스폰으로 10분 완주. 1차 root gate는 이전 실패 게이트 런의 잔류 MomoServer(26560) 점유로 fail-fast → 정리 후 PASS. 잔류 프로세스 자동 정리는 drift-guard 티켓 제안에 병합 예정.

### ☑ MOMO-355 수용기준 — Dogfood agent seed opt-in + pairing-only roster `[sql/tooling/docs]` · 의존: MOMO-339, MOMO-348, MOMO-352 (`#342`)
- [x] persistent dogfood/local-alpha의 기본 migration은 demo human + 기본 채널만 만들고 agent는 0이다. `002_seed.sql`/`006_local_hermes_agent_seed.sql` agent 행은 demo/e2e 명시 opt-in에서만 적용된다.
- [x] `scripts/momo hermes-gateway-init` 안내가 env template → pairing invite → scoped credential 발급 → env 기록 순서를 강제한다.
- [x] 기존 dogfood의 고정 김인턴/Hermes seed는 DB owner + exact identity guard + `--yes`가 필요한 사용자 opt-in 명령으로만 soft-retire한다. 자동/destructive migration은 추가하지 않는다.
- [x] runtime-agent와 macos-ui verifier가 `MOMO_AGENT_SEED_MODE=none`, marker/OID-owned DB, 자체 agent/channel fixture, per-run channel·대문자 `CENT_CHANNEL`, exit 96/source 보존 경계를 유지함을 DB 비접속 contract test로 고정한다.
  - 리뷰 보강: context verifier도 human(…101)/Hermes(…103)와 두 채널·membership을 자체 시드하며, 고정 seed ID 참조 전수 점검 및 contract 회귀 검사를 추가했다.
  - 오케스트레이터 검수: 1차 clean gate에서 context verifier가 seed mode=none 하에 member 103 부재 FK violation — 344 빈티지 verifier만 자체 시드 미적용이던 회귀를 resume 반려로 수정(`1726344`) 후 clean gate PASS.
- [x] `schema_v0.sql` 무변경. 수정/new shell `bash -n`, Python contract test, Swift build/test PASS.
- [x] clean/root `runtime-agent` + `macos-ui` PASS — PR #345 merge(`ac00ef3`), Phase 0 종결 시 root full gate PASS(`local-gate-runtime-agent-20260712T170955Z-…-rfc58973d57b9.md`, `local-gate-macos-ui-20260712T171443Z-…-r88f66c1ce253.md`).
  - 라이브 dogfood 노트: `cleanup-seeded-agents --yes`는 102(김인턴)·103(Hermes)을 함께 은퇴시키는데, 앱 pairing 표면(`inviteDogfoodAgent`)은 기존 hermes 멤버 재사용+credential 발급이라 103 은퇴 후 재생성 product 경로가 아직 없다. 라이브 반영은 REST 채널 멤버십 제거(product 경로, 가역)로 김인턴만 invite-gated 처리하고, full retire는 agent 신규 pairing 표면(후속 티켓) 이후로 보류.
### ☑ MOMO-354 수용기준 — real-server roster SoT + invite-gated visibility `[swift/macos-ui]` · Issue #341
- [x] real-server 연결은 `/v1/workspaces/:ws/roster`의 active member/channel membership를 사용하고 REST backend에서 demo fixture로 fallback하지 않는다.
- [x] 선택 채널의 active human/agent만 사이드바에 표시하며 agent는 `AGENT` 배지를 유지한다. 이름 기반 dogfood 숨김 예외는 없다.
- [x] 멘션 후보와 agent realtime 구독은 선택 채널 active membership로 동일하게 제한하고, 메시지 작성자 표시도 roster member identity를 사용한다.
- [x] login/join의 `realtimeWebSocketUrl`을 앱이 우선 사용하고 앱 env는 이전 서버 fallback으로만 남긴다 (ADR-0110).
- [x] server/macOS 단위 테스트 + light/dark roster snapshot 정본 재기록 + design-review Blocker 0 + clean/root `macos-ui` gate evidence.
  - worker evidence: server 63 tests, macOS 비스냅샷 79 tests, 신규 snapshot 2종 compile+reference-wait skip, Python no-DB contract, 수정 shell `bash -n`/실행권한 PASS, design-review PASS(Blocker 0/High 0/Medium 1).
  - 오케스트레이터 fresh design-review(초판): PASS(Blocker 0)이나 High 2건 — server-SoT 프로필 편집기 무음 유실(P2), `ImageRenderer`+`ScrollView{LazyVStack}` 한계로 roster 스냅샷이 빈 이미지 — 를 이 PR 내 수정으로 반려.
  - review fix evidence: server-SoT 로컬 프로필 편집 UI/상태 이중 차단(`cc1fcf1`), `NSHostingView` 2x roster 캡처 + light/dark `AGENT` accent pixel assertion PASS. fresh design-review 재판정 PASS(Blocker 0/High 0/Medium 0/Low 0).
  - 오케스트레이터 종결: 정본 PNG 2종 재기록(`6f00f05`, `MOMO_RECORD_SNAPSHOTS=1`) 후 멤버 행+`AGENT` 배지 픽셀 포함 육안 확인, 91 tests 0 fail/0 skip, worktree clean `macos-ui` gate PASS, PR #346 squash merge(`9ca9c93`), root post-merge full gate PASS(위 355 evidence와 동일 런) — **Phase 0 (354/355/356) 배치 종결 (2026-07-13)**.
  - design-review Medium 이월 기록(후속 후보, 성재 판단 대기): ① real-server presence 점이 `.online` 하드코딩 장식(ADR-0104 전까지 숨김/중립 권고) ② 비활성 멤버의 과거 메시지 author "unknown" 렌더(비활성 포함 조회 또는 payload 표시명 fallback) ③ `subscribe`/`presence`가 roster 로드 순서에 무음 의존(`cachedMembers ?? []`) ④ 신규 에러 카피에 다음 행동 부재 ⑤ 데모 시드 Hermes 노출 vs 페어링 카드 서사 불일치.

### ☑ MOMO-357 수용기준 — UI W1 앱 셸·사이드바 Slack급 정비 `[swift/macos-ui]` · 의존: MOMO-354 (패킷 `2026-07-13-ui-wave1.md`)
- [x] 사이드바 섹션 계층 재정비: 워크스페이스 헤더 / 채널 / DM 자리 / 멤버, "개발 도구"·"에이전트 승인함"은 하단 유틸리티/메뉴로 강등. 데이터는 전부 기존 roster SoT 술어 — 새 REST/스키마 없음.
- [x] 행 문법 통일: 높이·패딩·타이포 Theme 토큰화, 액션은 hover 시에만 노출, 선택 상태 대비 강화, 사이드바 접기/최소 폭 정책.
- [x] real-server 세션 presence 점 하드코딩 `.online` 장식 제거(숨김 또는 중립) — MOMO-354 design-review Medium ① 해소, ADR-0104 전까지.
- [x] light/dark 스냅샷(NSHostingView 패턴) + 비스냅샷 테스트 green. 신규/변경 PNG는 오케스트레이터 정본 재기록 대기 명시.
- [x] momo-design-taste pre-flight 0 hit(토큰 밖 색/폰트/장식 status/카피 규칙), fresh design-review Blocker 0. `MessageListView`/`MessageBubble`은 수정하지 않는다(MOMO-359 경계).

  - 오케스트레이터 종결: fresh design-review PASS(Blocker 0/High 1/Medium 3) → High(멤버 mutation 비마우스 경로)+gear hit-test+고아 PNG 2장 반려 수정, 정본 스냅샷 재기록 후 육안 확인(헤더/채널/DM/멤버/AGENT 배지/유틸리티 강등), 104 tests 0 fail, clean `macos-ui` gate PASS(스택 fingerprint recreate + verifier api 포트 점유 해소 후), PR #355 squash merge(`94e9244`). Theme.swift는 354의 adaptive `onAccent`/`subtleBorder`와 union 해소. root post-merge full gate PASS(`local-gate-runtime-agent-20260713T041003Z-…-r65024c71dbcb.md`, `local-gate-macos-ui-20260713T041531Z-…-r4794a4a53bee.md`)
  - 이월 기록(후속 후보): profilePresenceBadge '나' 추정 휴리스틱, `subtlePanelBorder` 비적응형 white(라이트 모드 비가시), radius 스케일 전역 통합, min-width/대비/타입 변형 스냅샷.

### ☑ MOMO-358 수용기준 — UI W1 Cmd+K 퀵 스위처 `[swift/macos-ui]` · 의존: MOMO-357 (랜딩 후 스폰)
- [x] `Cmd+K` 오버레이: 채널/멤버 fuzzy 검색, ↑↓/Enter/Esc, 최근 채널 우선. 첫 프레임 지연 체감 0(P11, Raycast 문법).
- [x] `Cmd+1..9` 채널 바로가기, `Cmd+[`/`Cmd+]` 히스토리 이동, `Cmd+/` 단축키 도움말 표면.
- [x] 후보는 roster SoT 술어(멘션 후보와 동일)만 — 미초대 멤버 비노출.
- [x] light/dark 스냅샷 + 키보드 이벤트 단위 테스트 green, design-review Blocker 0.
  - 오케스트레이터 종결: fresh design-review PASS(Blocker 0/High 1/Medium 2) → High(⌘1..9 서수 술어가 사이드바 표시 술어와 분리)+Cmd+K 토글 부재 반려 수정(`b261aea`, 공용 ordered source 공유), 스위처 정본 스냅샷 4종 재기록·육안 확인(검색 필드/⌘서수 힌트/AGENT 배지/단축키 푸터), 113 tests 0 fail, clean `macos-ui` gate PASS, PR #356 squash merge(`5ac5fa9`) — **UI Wave 1 종결 (2026-07-13)**.
  - 이월 기록(후속 후보): AGENT 배지 공용 컴포넌트 추출(4중복), 패널 radius 14 분화, SF Symbol 렌더링 혼용, 에러 원문 덤프 노출, 스위처 viewport 높이.

### ☑ MOMO-359 수용기준 — UI W1 메시지 타임라인 밀도·그루핑 `[swift/macos-ui]` · 의존: MOMO-354 (패킷 `2026-07-13-ui-wave1.md`)
- [x] 연속 작성자 그루핑(간격 임계 이내 compact 행, 아바타/이름 1회) — `message.seq` 순서 권위 불변, 그루핑은 표시 계층에서만.
- [x] day divider + 스크롤 정책(하단 고정 vs 위치 유지) 명시 구현.
- [x] hover 액션 바는 실기능만(복사 등) — 자리만 있는 버튼 금지. 타임스탬프는 그룹 첫 행 상시+compact 행 hover.
- [x] 에이전트 메시지 문법(AGENT 배지, MOMO-350 status/partial 카드)과 그루핑 비충돌 스냅샷 고정.
- [x] light/dark 스냅샷 + 비스냅샷 테스트 green, design-review Blocker 0. `ChannelListView`는 수정하지 않는다(MOMO-357 경계).
  - 오케스트레이터 종결: fresh design-review FAIL(Blocker 1 — 복사 material 칩이 `.opacity` 밖이라 rest 상태 상시 노출) → 반려 수정(`ef21b52`) 후 timeline+bubble 정본 재기록·육안 확인(blob 소멸, day divider·그루핑·AGENT 카드 정상), 100 tests 0 fail, clean `macos-ui` gate PASS, PR #354 squash merge(`6b75260`). root post-merge full gate PASS(`local-gate-runtime-agent-20260713T041003Z-…-r65024c71dbcb.md`, `local-gate-macos-ui-20260713T041531Z-…-r4794a4a53bee.md`)
  - 이월 기록(후속 후보): own-send 하단 추적 예외(Wave 2에서 결정), agent+cost ring hover 겹침 라이브 확인, 로딩 clock→ProgressView, divider 연도 표기.

### ☑ MOMO-360 수용기준 — Phase A GHCR 이미지 발행 워크플로 `[infra/tooling]` (패킷 `2026-07-13-phase-a-aws.md`)
- [x] `.github/workflows/publish-images.yml` — workflow_dispatch 전용(자동 트리거 금지), api/relay/worker/migrate 4종을 linux/arm64 buildx로 `ghcr.io/dawn-kim-official/momo-*:sha-<gitsha>` 불변 태그 push.
- [x] `docker-compose.prod.yml` 이미지 태그 env 주입 계약(`MOMO_IMAGE_TAG`류) 확인/보강 + 롤백=이전 digest 재실행 문서화, env example에 태그 키 추가.
- [x] 정적 검증만: workflow YAML 검증, `docker compose config` dry-run PASS. 이미지 실빌드/push/로컬 Docker 실행 금지.
- [x] `aws_internal_alpha_preflight.sh` evidence 계약 비파괴.
  - 오케스트레이터 종결: 정적 계약(test_publish_images_contract.py)+preflight 2종(aws recommended PASS, internal-smoke PASS, secrets 템플릿은 main과 동일한 의도적 placeholder FAIL)+actionlint 직접 재검증, clean `runtime-agent` gate PASS, PR #352 squash merge(`6980e64`). 계획 이탈 승인: migrate는 기존 전용 Dockerfile 재사용. root post-merge full gate PASS(`local-gate-runtime-agent-20260713T041003Z-…-r65024c71dbcb.md`, `local-gate-macos-ui-20260713T041531Z-…-r4794a4a53bee.md`)

### ☑ MOMO-361 수용기준 — Phase A 배포 번들 패커 + 운영 runbook `[docs/tooling]` (패킷 `2026-07-13-phase-a-aws.md`)
- [x] `scripts/make_deploy_bundle.sh` — compose/Caddy/centrifugo/env template/runbook만 패키징, 소스 체크아웃·secrets 실값 포함 시 fail-closed. `bash -n`+shellcheck+합성 fixture 테스트 PASS.
- [x] `docs/runbooks/aws-internal-alpha-deploy.md` — provision→preflight 2종→bundle 반입→pull&up→verify→롤백을 커맨드 단위로, `AWS_READY` 게이트 표 확인 단계 포함.
- [x] `docs/runbooks/internal-alpha-onboarding.md` — 채널 2+ 생성, invite 코드 발급(기존 REST), 앱 안내, Hermes 사용 규칙(승인 왕복) 1페이지.
- [x] non-goal 명시: 무중단 배포/split 토폴로지/iOS. AWS API 호출 없음.
  - 오케스트레이터 종결: 합성 fixture 테스트+실 repo 번들 생성(allowlist 7파일 일치) 직접 재검증, clean `runtime-agent` gate PASS(콜드 빌드 타임아웃 1회 후 재실행), PR #353 squash merge(`1c044e6`). root post-merge full gate PASS(`local-gate-runtime-agent-20260713T041003Z-…-r65024c71dbcb.md`, `local-gate-macos-ui-20260713T041531Z-…-r4794a4a53bee.md`)

### ☑ MOMO-362 수용기준 — Work v0 work run 계약 + 승인 티어 서버 가드 `[swift/runtime-agent]` (ADR-0111 D1·D3, 패킷 `2026-07-13-agent-work-surface.md`)
- [x] `agent_run.input`의 `{type:"work", title, brief, repo?, branch?}` shape를 run 생성/트리거 경로에서 검증 — 위반은 트랜잭션 밖 4xx, 비-work run 무영향. `schema_v0.sql`·신규 migration 없음.
- [x] gateway 승인 요청에 `tier`(read_only|workspace_write|network_write) 수용·approval metadata 전달, `danger` 상당은 400 fail-closed.
- [x] work run 목록/상세 REST(기존 run 조회 확장, actor binding 유지) + 서버 단위 테스트(shape·tier·403/400 경계).
- [x] 349/350/341 경로 회귀 없음 — 동등성 verifier 계약 비파괴. clean/root `runtime-agent` PASS는 오케스트레이터.
  - 오케스트레이터 종결: 검수(트랜잭션 밖 4xx·tier fail-closed·invite-gating 술어·actor 스코프) 후 clean `runtime-agent` gate PASS, PR #363 merge(`2d5b2ad`). root post-merge full gate PASS(`local-gate-runtime-agent-20260713T075706Z-…-ra6804669e978.md`, `local-gate-macos-ui-20260713T080432Z-…-r6738c50ddf08.md`)

### ☑ MOMO-363 수용기준 — Work v0 codex-workbench gateway adapter `[python/runtime-agent]` · 의존: MOMO-362
- [x] `adapters/codex-workbench/` — hermes adapter 패턴 승계, work run claim→`codex exec` headless(세션 id 보존, 후속 지시 `resume`), ADR-0004(자격증명 어댑터 호스트에만).
- [x] sandbox→승인 티어 매핑: read-only 즉시, workspace-write는 실행 전 승인 왕복, danger 경로 부재.
- [x] transcript=status/partial 스트림, 최종=구조화 결과 카드(diff 요약/exit/링크), 운영 공지 durable 유출 금지(MOMO-356 계약).
- [x] mock codex 기반 DB 비접속 계약 테스트 + `bash -n`/py_compile PASS. 실 codex 왕복은 오케스트레이터 라이브 검증.
  - 오케스트레이터 종결: 검수(danger 경로 부재·plan→승인→resume 2단계·ADR-0004 경계·356 공지 계약) + mock 계약 테스트 직접 재검증, clean `runtime-agent` gate PASS, PR #365 merge(`44f8d35`). 실 codex 왕복 라이브 검증은 운영 단계(성재 seed 후). root post-merge full gate PASS(`local-gate-runtime-agent-20260713T075706Z-…-ra6804669e978.md`, `local-gate-macos-ui-20260713T080432Z-…-r6738c50ddf08.md`)

### ☑ MOMO-364 수용기준 — Work v0 Work 표면 UI `[swift/macos-ui]` · 의존: MOMO-362 (365와 병렬)
- [x] `/work` 커맨드+컴포저 버튼(대상 에이전트 선택·title/brief), 타임라인 work 카드(상태 칩/접힌 로그 테일/인라인 승인/결과 요약), 상세 페인.
- [x] partial 스트림·승인 카드 기존 컴포넌트 재사용, 359 그루핑과 비충돌, P8(노이즈 억제) 준수.
- [x] light/dark 스냅샷(상태 칩·로그 테일·승인·결과 픽셀) + design-review Blocker 0. 정본 PNG는 오케스트레이터 재기록.
  - 오케스트레이터 종결: fresh design-review PASS(High 1 — 재로드 후 종결 run이 ephemeral 상태에 가려 '승인 대기' 표시)+Medium 4 반려 수정, 365와 rebase union(Theme·Core 테스트 brace 유실 2건 오케스트레이터 직접 수리 — 교훈: union 후 전 패키지 빌드 검증), work surface+도움말 정본 재기록·육안 확인(승인 카드/결과 카드 픽셀), clean `macos-ui` gate PASS, PR #367 merge(`adf159f`). root post-merge full gate PASS(`local-gate-runtime-agent-20260713T075706Z-…-ra6804669e978.md`, `local-gate-macos-ui-20260713T080432Z-…-r6738c50ddf08.md`)

### ☑ MOMO-365 수용기준 — Work v0 capability 배지·대상 선택 `[swift/macos-ui]` · 의존: MOMO-362 (364와 병렬)
- [x] `agent.config.capabilities` roster/상세 표면화(read-through, 새 스키마 없음), 사이드바·Cmd+K·멘션 후보에 배지.
- [x] Work 대상 후보 = 선택 채널 초대된 active 에이전트 중 capability 보유자만(354 술어 재사용), 자동 라우팅 없음.
- [x] 후보 필터 단위 테스트 + 스냅샷 + design-review Blocker 0.
  - 오케스트레이터 종결: fresh design-review PASS(Blocker 0/High 0/Medium 3 — 멘션 행 이중 신호·+N 발견성·SQL 중복 이월), 정본 4종 재기록·육안 확인(code/+N 칩), clean `macos-ui` gate PASS, PR #366 merge(`f5aba9f`). 358 이월이던 AGENT 배지 공용 컴포넌트화 이행됨.

### ☑ MOMO-366 수용기준 — Wave 2 read-state 서버 계약 `[swift/runtime-agent]` (ADR-0109 D2·D3, 패킷 `2026-07-13-ui-wave2-unread.md`)
- [x] 벌크 `GET /v1/workspaces/:ws/read-state`(자기 것만, 본문 비포함, 행 부재=0) + `PUT .../channels/:ch/read-state`(GREATEST 단조·idempotent·타인 403·트랜잭션 밖 4xx).
- [x] outbox `read_state` 이벤트 → 같은 멤버 개인 채널로만 relay. Centrifugo 전송전용 불변.
- [x] ADR-0109 검증 계약 1~5항 서버 단위 테스트 전부 green. `schema_v0.sql` 불변(필요 시 신규 numbered migration).
- [x] clean/root `runtime-agent` PASS는 오케스트레이터.
  - 오케스트레이터 종결: 검수(단조 가드+head 상한·개인 채널 한정 발행·mention 저장 시점 파싱) 후 clean `runtime-agent` gate PASS, PR #364 merge(`69facce`). Centrifugo user 네임스페이스 `allow_user_limited_channels` 변경 — root·dogfood 라이브 모두 recreate/패치 완료. root post-merge full gate PASS(`local-gate-runtime-agent-20260713T075706Z-…-ra6804669e978.md`, `local-gate-macos-ui-20260713T080432Z-…-r6738c50ddf08.md`)

### ☑ MOMO-367 수용기준 — Wave 2 unread 배지 + 키보드 순회 `[swift/macos-ui]` · 의존: MOMO-366
- [x] 부팅 1-call 점등, 사이드바 unread 굵기+mention 숫자 배지(357 행 문법 내), realtime `read_state` 이벤트 동기화.
- [x] 뷰포트 기준 mark-read(debounce ≈1s), own-send 하단 추적 예외 확정 구현(359 이월), 서버 커서=진실.
- [x] `⌥⇧↑↓` unread 순회(스펙 변경 2026-07-13: ⇧⌘↑↓는 macOS 텍스트 선택 표준을 가로채 composer draft를 뺏음 — design-review High → Slack 문법 ⌥⇧↑↓로 결정. 358 단축키·시스템 편집과 비충돌, `Cmd+/` 도움말 갱신).
- [x] light/dark 스냅샷(배지 픽셀) + design-review Blocker 0. 정본 PNG는 오케스트레이터 재기록.
  - 오케스트레이터 종결: fresh design-review PASS(High 1=스펙 원인 — ⇧⌘↑↓가 macOS 텍스트 선택 충돌 → planner 결정으로 ⌥⇧↑↓ 전환, 정본 3곳 갱신 `d9f4e68`)+Medium 5 반려 수정(백오프 5회 상한·에러 행 문법 수렴 등), 364와의 7파일 실충돌 rebase는 worker 위임(전 패키지 검증), unread 배지+도움말 정본 재기록·육안 확인(⇧⌘W와 ⌥⇧↑↓ 공존), clean `macos-ui` gate PASS, PR #368 merge(`fd8eabe`) — **Work v0+Wave 2 배치 종결 (2026-07-13)**. root post-merge full gate PASS(`local-gate-runtime-agent-20260713T075706Z-…-ra6804669e978.md`, `local-gate-macos-ui-20260713T080432Z-…-r6738c50ddf08.md`)
  - 이월 기록: 메시지 폭주 시 벌크 refresh 부하, VO 복수형, mention 캡슐 대비, 신규 채널 레이스.

### ☑ MOMO-368 수용기준 — 온보딩/로그인 화면 Raycast급 재구성 `[swift/macos-ui]` (성재 발제 2026-07-13, 대형 화면 스크린샷 피드백)
> 현재 문제(대형 창 기준): hero 텍스트와 로그인 카드가 중심 우측으로 쏠려 좌측 거대 공백, 1/2/3 단계 인디케이터가 디버그 노트처럼 노출, CTA 3개(로컬 알파 시작/초대로 참여(disabled)/로그인)가 위계 없이 경쟁, 필드 밀도·포커스 문법 미정비, 배경 그라데이션이 탁함.
- [x] 대형 창(≥1600pt)에서 **중앙 정렬 max-width 구성**: 압축된 hero(로고+가치 한 줄+capability 칩)와 로그인 카드가 하나의 수직 리듬으로 중앙 배치, 좌우 공백 균형. 좁은 창에서도 성립(반응형 단일 컬럼).
- [x] 로그인 카드 정비: 필드 높이/간격 토큰화, 포커스 ring 상태, **primary CTA 1개**(입력 상태 기반 — 자격 미입력 시 "데모 열기" primary, 입력 시 "로그인" primary) + 나머지 secondary/tertiary, disabled 사유 노출(초대 코드), Keychain 토글은 보조 밀도로.
- [x] 1/2/3 단계 인디케이터 제거 또는 카드 내부 subtle 진행 표시로 격하. 에러/로딩/오프라인 상태 카피는 다음 행동 포함.
- [x] 배경: Theme 토큰 기반 정제된 다크 그라데이션(양 스킴 대응), 장식 모션은 reduceMotion 가드 하 ≤0.16s.
- [x] Enter 제출·Tab 순서·Esc 키보드 문법(P11), light/dark 스냅샷(대형/기본 폭 2변형 권장) + design-review Blocker 0. 표면: `MomoServerSession.swift`/`OnboardingInviteView.swift` 계열, 랜딩된 357..367과 회귀 없음.
  - 오케스트레이터 종결: fresh design-review PASS(High 1 — 비활성 창 primary CTA `onAccent` 강제 판독 불가 / Medium 3 — md5 동일 가짜 접근성 변형·Enter 미실효·fake translucency) 반려 수정 후, 정본 4종(980/1600pt×양 스킴) 재기록·육안 확인(중앙 수직 리듬·primary 1개·인디케이터 소멸), 156 tests 0 fail, clean `macos-ui` gate PASS, PR #371 squash merge(`9d539b4`). root post-merge full gate PASS(`local-gate-runtime-agent-20260713T121827Z-…-r889716974054.md`, `local-gate-macos-ui-20260713T122901Z-…-ra21dc96dd0cd.md`)
  - 이월 기록: 비밀번호 placeholder 중복, isPreviewFocused prop, hero 칩 영어, OnboardingInviteView 영어 단일, sessionNotice 영어.

### ☑ MOMO-369 수용기준 — 앱 셸 시각 폴리시 W3: 표면 위계·타이포 리듬·상태 배너 문법 `[swift/macos-ui]` (성재 발제 2026-07-13, "Raycast급 세련미" 스크린샷 피드백)
> 진단: W1/W2는 구조·밀도·기능이었고 폴리시 레이어 부재로 "평평한 다크 앱" 인상. 401 토큰 만료가 빨간 에러 2개+Swift 에러 덤프로 노출되어 화면을 지배, 스트리밍 커서 아티팩트("▍" 잔류), day divider가 한국어 UI에서 영어 날짜.
- [x] **표면 위계 3층 토큰**(배경/패널/카드 elevation — 색·보더·그림자 세트, 양 스킴)을 Theme에 정의하고 사이드바·타임라인·work/승인 카드·팝오버에 일괄 적용. 평면 인상 제거가 목표.
- [x] **타이포 리듬 정비**: 섹션 헤더/행/보조 텍스트의 크기·무게·색 대비 스케일 통일(semantic 스타일 유지), 행간·여백 정율.
- [x] **상태 배너 문법 통일**: 401/세션 만료는 "다시 로그인" primary 액션이 있는 단일 배너로(에러 원문·`String(describing:)` 덤프 사용자 노출 금지 — 기존 Medium 이월 해소), 실시간 REST 폴백은 subtle 상태 칩으로 격하. 카피는 다음 행동 포함.
- [x] 스트리밍 partial 말미 커서 아티팩트 정리, day divider 날짜 로케일(ko 환경 한국어 표기), 멘션 행 이중 신호(365 이월 Medium ①)·+N 툴팁 전체 목록(이월 ②) 해소.
- [x] 모션: reduceMotion 가드 하에 카드 등장/hover 전이 ≤0.16s, 과장 금지.
- [x] light/dark 스냅샷(사이드바+타임라인+카드 표면 위계가 픽셀로 확인 가능해야) + design-review Blocker 0. 랜딩된 354..368과 회귀 없음. 온보딩(MOMO-368 in-flight) 파일 무접촉.
- 후속 기록(이 티켓 밖): adapter 실패 body 구조화(CLI usage 원문의 durable 유출 — python 몫), 세션 자동 refresh 토큰(서버 계약 필요).
  - 오케스트레이터 종결: fresh design-review FAIL(Blocker=정본 미재기록[오케스트레이터 몫]/High 2 — momoSurface safe-area bleed 소실로 타이틀바 seam 위험·send/멘션 실패가 load 배너로 뭉개짐) → High 2건 반려 수정(`9b49edd` bleed 복원+send/load 문법 분리), 정본 4개 스위트 12종 재기록(사이드바 스위트는 정본 삭제 후 재기록 — record가 기존 파일 비덮어씀)·육안 확인(3층 위계 픽셀 실재), 162 tests 0 fail, clean `macos-ui` gate PASS, PR #372 squash merge(`84db101`) — **온보딩+W3 UI 트랙 종결 (2026-07-13)**. root post-merge full gate PASS(`local-gate-runtime-agent-20260713T121827Z-…-r889716974054.md`, `local-gate-macos-ui-20260713T122901Z-…-ra21dc96dd0cd.md`)
  - 이월 기록: increased-contrast 팔레트 적응, 승인 인박스 행-카드 그림자 누적, 진단 팝오버 이중 크롬, sessionChrome nil 재로그인 no-op, DateFormatter 캐시, panel 토큰 의미 분화, adapter 실패 body 구조화(python).

### ☑ MOMO-370 수용기준 — ADR-0112 Wave A: 개발자 모드 토글 + 메시지 이중 밀도 `[swift/macos-ui]`
> ADR-0112 D1. 성재 진단: tool_call JSON·프로토콜 칩·비용 링이 대화를 침범, 비개발자는 지레 겁먹음(데모 fixture 포함).
- [x] 설정에 **개발자 모드 토글**(기본 off, Discord 문법). off: 에이전트 메시지=요약 1줄+접힌 카드(펼치면 사람 언어 요약 수준), 프로토콜 칩(CONTEXT/GITHUB/DECISION/ARTIFACT_REF 등)·tool JSON·Context Copilot·개발 도구 팝오버·로컬 알파 채우기·로그아웃 상세 공지 전부 숨김. on: 현재 밀도.
- [x] **비용 표시 별도 토글**(dev 모드 내): off 시 비용 링/금액 비노출. 헤더 누적 비용도 동일 게이트.
- [x] 승인 카드 기본 모드: "누가 무엇을 하려는지 한 문장 + 승인/거부"만(티어·tool 상세는 dev에서).
- [x] 데모 모드 콘텐츠 재큐레이션: 기본 모드 문법에 맞는 사람 언어 대화(P5) — 프로토콜 쇼케이스는 dev 토글 켠 상태에서만 의미 있게.
- [x] 두 밀도 각각 light/dark 스냅샷, 기존 canonical 재기록 대상 명시, design-review(D6 강화 rubric) Blocker 0.
  - 오케스트레이터 종결: fresh design-review FAIL(Blocker: dev 밀도 미보존[brief 유실·중복]+미신고 canonical 회귀 / High: 표준 모드 Alpha Command Center 비용 누출·조사 비문 '빌드봇가') → 반려 수정 후 dual-density 정본 4종 재기록·육안(기본 모드=요약 1줄+한 문장 승인, 조사 정상), 175 tests 0 fail, clean `macos-ui` PASS, PR #378 merge(`6f4090c`). root post-merge full gate PASS(`local-gate-runtime-agent-20260714T062029Z-…-rb83aa503ed69.md`, `local-gate-macos-ui-20260714T062619Z-…-rd69953d1cd91.md`)

### ☑ MOMO-371 수용기준 — ADR-0112 Wave A: 채널 헤더 재구성 + 창 크롬·디테일 결함 `[swift/macos-ui]`
> ADR-0112 D2·D6. 성재 진단: 헤더에 멤버 수/설정 없음, momo 로고가 macOS 타이틀바·트래픽라이트와 겹침, 상세 패널 닫기 버튼 무반응, 텍스트 스케일이 묘하게 작음.
- [x] 채널 헤더: 채널명/주제 + **멤버 수(클릭=멤버 목록)** + 채널 설정 진입점(이름/주제/멤버 관리 시트) + "연동" 자리(웹훅 URL 발급 placeholder 탭 — 서버 확장은 후속 명시).
- [x] **타이틀바 겹침 해소**: 사이드바 워크스페이스 헤더/로고가 트래픽라이트와 충돌하지 않게 툴바 통합 또는 상단 인셋 — 표준 창 크기·풀스크린 모두.
- [x] **상세 패널 닫기 버튼 동작 수정**(현재 무반응) + 패널 열림/닫힘 상태 일관성.
- [x] 텍스트 스케일 상향 조정: 본문/헤더/보조의 실측 크기를 Slack 데스크톱 급으로(현재 "묘하게 작음" 해소), Dynamic Type 존중.
- [x] light/dark 스냅샷 + 실창 검증 노트(D6: 닫기 버튼 hit-test 확인 방법 명시) + design-review Blocker 0. MOMO-370과 파일 경계: 메시지 카드/설정 토글은 370 몫.
  - 오케스트레이터 종결: fresh design-review PASS(High 4 — 죽은 닫기 버튼의 실증 원인은 타이틀바 밴드[A/B 런타임 프로브], STATUS 원인 오기, 멤버 수 훅 미배선, 본문 13pt 유지, rename 표면 불일치) → 반려 수정(본문 15pt·STATUS 정정·훅 플러밍·rename 공용 해석), 370 위 rebase는 worker 위임, Typography drift canonical 5개 스위트 재기록·육안(신규 크롬: 헤더 멤버 수/설정/연동 탭·닫기 버튼 타이틀바 밖), 183 tests 0 fail, clean `macos-ui` PASS, PR #376 merge(`c9ed890`). root post-merge full gate PASS(`local-gate-runtime-agent-20260714T062029Z-…-rb83aa503ed69.md`, `local-gate-macos-ui-20260714T062619Z-…-rd69953d1cd91.md`)

### ☑ MOMO-372 수용기준 — ADR-0112 Wave A: 멤버 디렉터리 + DM `[swift/server/macos-ui]`
> ADR-0112 D2. 성재 진단: 전체 멤버를 한곳에서 볼 수 없고, 멤버에서 DM을 시작할 수 없음.
- [x] 서버: **DM 채널 생성/조회 REST** — 기존 `dm` 채널 kind 사용, 같은 두 멤버 조합 idempotent(중복 생성 방지), 멤버십 자동 부여, RLS·단일 쓰기 경로 불변. `schema_v0.sql` 무변경(필요 시 신규 numbered migration).
- [x] 앱: **멤버 디렉터리 표면**(사이드바 멤버 + 또는 헤더 멤버 수에서 진입) — 전체 멤버 검색/사람·에이전트 구분/프로필 카드, 여기서 "DM 보내기".
- [x] 사이드바 DM 섹션에 실 DM 목록(unread 배지 연동 — 기존 read-state 재사용), 멤버 행 context menu에 "DM 보내기".
- [x] 서버 단위 테스트(idempotent 생성·권한·RLS) + 앱 스냅샷/필터 테스트 + design-review Blocker 0. 370/371과 파일 경계 준수.
  - 오케스트레이터 종결: fresh design-review FAIL(Blocker: 디렉터리 스냅샷 빈 캡처 / High 3: Cmd+K DM 리터럴 표기·정렬 tiebreak 부재·DM 행 픽셀 증거 0) → 반려 수정(리스트/디테일 분리 캡처·상대 이름 해석 공용화·결정적 정렬·DM unread 카운트 배지), 371 위 최종 rebase+**채널 헤더 멤버 수→디렉터리 훅 연결**(두 PR 통합 항목) worker 위임, 정본(디렉터리 4종+DM unread 2종+roster 6종) 재기록·육안(검색/세그먼트/AGENT 배지/DM 행 '7' 배지 실픽셀), 199 tests 0 fail, clean `runtime-agent`+`macos-ui` PASS, PR #377 merge(`e254cc6`) — **ADR-0112 Wave A 종결 (2026-07-14)**. root post-merge full gate PASS(`local-gate-runtime-agent-20260714T062029Z-…-rb83aa503ed69.md`, `local-gate-macos-ui-20260714T062619Z-…-rd69953d1cd91.md`)
  - 이월 기록: 디렉터리 .task 스테일, 키보드 진입 경로, directMessageError raw 잠재, 채널 설정 키보드 경로, AppStorage 키 상수화.

### ☑ MOMO-379 수용기준 — 창 크롬 정합 핫픽스 2차 `[swift/macos-ui]` (성재 스크린샷 2026-07-14, MOMO-371 잔존 D6)
> 진단(스크린샷): ① 툴바 워크스페이스 칩("momo 상준") 옆에 창 타이틀 "momo"가 중복 노출 ② 오버레이 상세 패널(승인)이 열릴 때 상단이 툴바/채널 헤더 뒤로 파고들어 내용이 가려짐(ignoresSafeArea 계열) ③ 좌상단에 빨간 배지가 트래픽라이트와 겹쳐 보임.
- [x] 창 타이틀 중복 제거 — unified 툴바에서 시스템 창 타이틀 비노출(navigationTitle 빈 값 또는 titleVisibility) — 워크스페이스 칩이 유일한 정체성 표기.
- [x] 오버레이 상세 패널이 툴바 safe area를 침범하지 않게 — 패널 상단이 항상 채널 헤더 아래에서 시작(overlay scrim 포함), attached 모드도 동일 확인.
- [x] 트래픽라이트와 겹치는 배지/요소 제거 — 좌상단 안전 영역 침범 요소 특정·수정.
- [x] 실창 검증 노트(표준 크기·좁은 창·풀스크린 3케이스) + light/dark 스냅샷 영향분 재기록 명시 + design-review(D6) Blocker 0.
  - 오케스트레이터 종결: 1차 수정(safeAreaInsets 기반)이 리뷰 실창 AX 실측으로 **런타임 no-op 반증**(NavigationSplitView 칼럼 safe area=0) → `NSWindow.contentLayoutRect` 기반 재수정 + harness 프로덕션 창 구성(fullSizeContentView+unified toolbar) 교체 → 2차 실측 리뷰 PASS(3케이스 AX 좌표: 사이드바 y72/헤더 y64 가시·AXPress 동작/패널 y136/타이틀 중복 0/dead control 0). canonical 3종 기록(프로덕션 기하 육안 확인), 206 tests 0 fail, clean+root `macos-ui` PASS(`local-gate-macos-ui-20260714T092306Z-pid99890-ns1784020986266307000-wt9a510db2fbf3-r569e0bf3e9f3.md`), PR #380 merge(`cef7430`).
  - 이월(별도 티켓 후보): 사이드바 멤버 행 이름 절단("H…" — 기존 결함, layoutPriority), harness 빈 툴바 밴드 높이 미세 불일치.

### ☑ MOMO-383 (`#387`) 수용기준 — Workspace-first navigation `[server/swift/runtime-db/macos-ui]` · 의존: MOMO-382
- [x] toolbar의 떠 있는 workspace capsule을 제거하고 sidebar 최상단에 icon/name/current-user context를 channel/DM보다 상위 컨텍스트로 표시.
- [x] workspace primary menu에서 설정/rename 진입, workspace ID 복사, 멤버 초대 제공.
- [x] ADR-0118의 active-member read + owner/admin workspace name update REST와 macOS binding을 추가해 재로그인·다른 client에서도 이름 유지. 일반 member write 거부, RLS/tenant 격리, audit metadata 검증.
- [x] workspace icon/invite policy는 이 goal에서 local draft를 서버 영속 설정으로 과장하지 않고 후속 API 범위로 남김.
- [x] 표준/좁은 창에서 traffic light, sidebar, channel header가 겹치지 않고 기존 MOMO-379 AX 기하 유지. 전체화면은 최종 macos-ui review evidence에서 닫는다.
- [x] fake multi-workspace rail과 `Add workspace` affordance는 ADR-0117 전 금지.
- [x] stale GET/rename/session race를 generation+`updatedAtMs` guard로 차단하고 bootstrap의 모든 await/subscription과 409 reload 뒤 session/workspace generation을 재검증. 401/403/404 exact persistent cache 삭제, unknown error fallback default-deny, cancellation 보존, demo cache 비영속, apostrophe verifier 복원을 회귀 테스트로 고정.
- [x] migration 009로 workspace root `ENABLE/FORCE RLS` + exact tenant policy를 추가. join discovery는 locked `momo_join_private` schema의 fixed-search-path UUID-only 함수로 최소화하고 PUBLIC/worker/relay/platform 거부 및 broad public function grant 뒤 비재확장을 검증.
- [x] private schema/function은 exact create로 pre-existing drift를 fail-closed하고 owner+app exact ACL을 검증. internal smoke의 roles absent→migrate→test bootstrap과 production의 secure external role preprovision→migrate를 isolated PG18에서 실행하며, production 역할 누락/속성 drift는 migration 전에 거부.
- [x] no-cache sidebar error에도 localized retry, `⇧⌘R`, VoiceOver label/hint를 제공. settings spacing scale 준수와 trimmed name counter/validation/save 일치, increased-contrast/large-text raster 2종 PASS.
- [x] connect/session generation과 delayed members/channels cache write 폐기, subscription exact-task cleanup, identity+channels parallel bootstrap, bounded one-query workspace read, narrow settings projection 회귀 포함. design-review Blocker 0, final clean commit에서 full `runtime-db`와 launch 포함 `macos-ui` local gate를 재실행. 전체 Swift Core 24·Server 80·Relay 2·Worker 29·macOS 234 = 369 tests 0 failure.
- [x] PR #389는 momo-main이 main `9c1fc7a`로 merge.

### ☐ MOMO-384 (`#390`) 수용기준 — Native channel creation sheet + tooltip presenter `[swift/macos-ui]` · 의존: MOMO-383
- [x] channel `+`가 sidebar inline form이 아니라 native sheet를 열고 public/private, name, topic, server-aligned normalize/validation, loading, readable local error/retry를 제공. 기존 REST create 경로를 재사용하고 성공 시 새 channel 선택.
- [x] quick tooltip을 row-local overlay가 아닌 root named coordinate/window-level presenter로 바꿔 sibling pane/attached inspector clipping 제거. short intrinsic width, 280pt 3-line cap, 0.12s delay, hover/focus source 복원, visible copy update/dismiss, hit-testing off.
- [x] visual tooltip은 accessibility hidden, icon-only source는 실제 action accessibility label을 소유. keyboard focus/Tab/Space, submit/Esc, narrow·standard·fullscreen, light/dark, tooltip cross-pane screenshot+AX frame은 **local manual/AX evidence**이며 commit된 자동 test가 아님. native sheet는 별도 modal surface라 부모 tooltip을 강제 노출하지 않음.
- [x] PR #394 correctness 반려를 반영해 view-model create operation/session/workspace readiness+generation, REST connection/workspace/token guard-before-decode, sheet Task/input revision cancellation, 401/not-connected 전역 로그인 복구, raw create diagnostic 제거를 추가. pending clear/same-workspace rebootstrap POST 차단, delayed success/error/409, 새 session in-flight, stale malformed/HTTP error, REST cache, tooltip transition을 focused 27 tests로 고정하고 macOS 전체 265 tests PASS.
- [x] fresh security/correctness/performance review Blocker 0/High 0/Medium 0, fresh design review Blocker 0/High 0/Medium 0. final clean `swift`/actual-launch `macos-ui`/docs gate evidence는 PR #394 worker handoff에 기록하며, MOMO-384는 merge 전 `status:needs-review`로만 둔다.

### ☐ MOMO-385 (`#391`) 수용기준 — Member inspector + one-click DM `[swift/runtime-db/macos-ui]` · 의존: MOMO-383
- [ ] active non-self person/agent member row primary click이 기존 idempotent DM REST를 호출하고 해당 DM으로 이동.
- [ ] DM 생성 즉시 sidebar DM section에 나타나며 첫 메시지 이후에도 같은 channel identity/read-state를 유지.
- [ ] member directory를 대화 컨텍스트를 보존하는 right inspector 중심으로 정리하고 search/filter/profile/DM action 유지.
- [ ] self/inactive/error 상태를 명확히 처리하고 two members + one agent fixture에서 idempotency/RLS 검증.
- [ ] design-review Blocker 0 + `runtime-db`/`swift`/`macos-ui` local gate PASS.
- 진행: PR #406 review fixes와 worker gates PASS, `status:needs-review`. 완료 체크와 merge 판정은 momo-main 담당.

### ☐ MOMO-386 (`#392`) 수용기준 — Workspace search v0 `[server/swift/runtime-db/macos-ui]` · 의존: MOMO-384, MOMO-385
- [ ] workspace-scoped RLS server search endpoint 구현. tenant token만 허용하고 BYPASSRLS 금지.
- [ ] `pg_trgm` 기반 message/member/mention 검색과 `from:`/`in:`/`@handle` modifier 지원; 결과에 identity/channel/timestamp/excerpt/source message ID 포함.
- [ ] macOS global search surface에서 결과를 선택하면 원문 message context로 jump.
- [ ] 현재 channel별 recent 200 client scan을 제품 경로에서 제거.
- [ ] 두 workspace 격리, 첫 페이지 밖 오래된 message, modifier parsing, DM/channel 결과를 runtime 검증.
- [ ] design-review Blocker 0 + `runtime-db`/`swift`/`macos-ui` local gate PASS.

### ☐ MOMO-392 (`#398`) 수용기준 — macOS channel chrome + contextual navigation polish `[swift/macos-ui]`
- [x] 채널 헤더를 48pt 한 줄 이름 중심으로 압축하고 topic/description은 tooltip·VoiceOver 보조 설명으로 제공. 헤더 상시 gear 제거.
- [x] `unifiedCompact` titlebar + 실제 `contentLayoutRect` inset으로 traffic light/sidebar/header/right inspector가 standard 1180x760, narrow 980x620, wide 1800x900에서 겹치지 않음. narrow inspector는 측정된 channel header 아래에 고정.
- [x] 헤더 우측 Downloads가 기존 app update/local download folder surface를 열고, 한국어/영어 copy와 VoiceOver hint가 chat attachment download 미지원을 명시.
- [x] MOMO-386 backend가 없는 현재 workspace search는 localized unavailable/roadmap state와 `⌘K` 대안만 제공하고 fake result를 만들지 않음.
- [x] channel row selected/hover invite/settings quick action, context menu의 invite/settings/notification-planned/copy-ID, `⇧⌘I`/`⇧⌘,` 및 VoiceOver custom action 동등 경로 제공.
- [x] channel creation sheet, unread, DM, member inspector/roster 보존. bilingual copy, Reduce Motion 기존 root animation policy, light/dark real-window evidence 포함.
- [ ] focused/full Swift tests, design preflight, `swift`/`macos-ui` local gate, fresh design-review Blocker 0를 PR evidence에 기록. worker는 PR 생성 뒤 `status:needs-review`까지만 전환하고 merge/close하지 않음.

### ☑ MOMO-402 (`#417`) 수용기준 — macOS top chrome, member roster, Dock badge, downloads polish `[swift/macos-ui]`
- [x] sidebar top gap·right rounding·shadow와 center double separator를 제거하고 left/center/right pane header를 unified toolbar 아래 독립 surface로 정렬.
- [x] member inspector는 검색을 유지하면서 관리자·에이전트·온라인·자리 비움·오프라인 그룹으로 표시하고 기존 profile/DM 경로를 보존.
- [x] channel unread 합계를 Dock badge `1...99+`로 표시하고 0/logout에서 clear.
- [x] Downloads를 채널 선택과 무관한 app toolbar 우측 icon popover로 이동하고 security-scoped folder open/change, 영속 history, item-level open/Finder/delete를 제공. Updates는 profile menu에 유지.
- [x] profile menu의 rise/move animation을 제거하고 footer button 위 약 16pt 간격으로 즉시 표시.
- [x] build와 macOS 전체 296 tests 0 failure, 실행 앱과 standard/narrow/light/dark artifact에서 sidebar/header/roster/downloads/profile menu 상호작용 확인. 다운로드 삭제는 resolved folder boundary를 벗어나는 symlink/sibling path를 거부하고 실제 삭제 성공 후에만 history를 제거.
- [ ] clean `macos-ui` gate와 fresh design-review Blocker 0를 PR evidence에 기록하고 momo-main review/merge 후 main gate 재검증.
- [ ] 실제 채팅 첨부파일 download record 공급은 MOMO-394에서 구현. 이번 surface의 영속 store와 item action은 준비하되 가짜 history를 생성하지 않음.

### ☑ MOMO-405 (`#423`) 수용기준 — Signal Architecture 반응형 온보딩 `[swift/macos-ui]`
- [x] 첫 화면은 초대 참여·기존 로그인·로컬 체험·설치된 self-hosted 서버 연결의 네 실제 경로를 먼저 제시하고, 선택 뒤에만 자격정보 form을 연다.
- [x] `<760pt` compact, `760..<1120pt` stacked, `>=1120pt` bounded split 레이아웃을 제공하며 앱 시작 창은 680pt까지 줄일 수 있다. 고정 bitmap 대신 SwiftUI `Canvas`로 신호 배경을 그려 Retina/resize에서 선명도를 유지한다.
- [x] 로그인·초대·demo·Keychain 기존 경로를 보존한다. focused test는 반응형 경계·경로 상태·순수 local demo를 확인하고, 전체 macOS suite와 real-backend UI gate가 로그인·초대·credential 저장 경로를 회귀 검증한다. 실패한 수동·환경 자동접속 ViewModel은 실시간 구독과 세션 민감 상태를 정리한다.
- [x] 일반 모드의 `local alpha` 표식을 숨기고 self-host 경로는 이미 설치된 서버 연결 범위만 설명한다. 한국어/영어, Light/Dark, 키보드 focus ring과 VoiceOver label/hint를 제공한다.
- [x] compact/default/large Light/Dark 정본 snapshot, focused onboarding 19/19, full macOS 301/301, `macos-ui` gate, fresh design-review Blocker/Major 0와 correctness review Blocker/High/Medium 0를 PR evidence로 기록한다.

### ☑ MOMO-396 (`#402`) 수용기준 — macOS composer + mention overlay polish `[swift/macos-ui]`
- [x] composer를 최소 56pt의 단일 surface로 구성하고 중첩 native rounded-border ring과 별도 outer focus ring을 제거. 시작 작업과 전송 action은 같은 surface 안에서 keyboard/VoiceOver 경로를 유지.
- [x] 현재 채널 active membership인 사람/에이전트만 `@` 후보로 표시. 최대 6행 overlay는 콘텐츠 실측 기반으로 composer 위 8pt 간격에 떠서 timeline/composer 높이를 바꾸지 않음.
- [x] 위/아래 순환, Tab/Return 선택, Escape 닫기, mouse 선택·hover를 지원하고 후보 선택 시 현재 mention token을 `@handle `로 치환. selected trait와 순서/전체 개수를 VoiceOver에 제공.
- [x] focused mention selection test와 전체 macOS suite는 동작 회귀를, Light/Dark 실제 macOS window artifact와 fresh design review는 overlay 위치·긴 이름·timeline 비이동을 각각 검증.
- [ ] final clean `macos-ui` gate와 fresh design/correctness/security/performance review를 PR evidence에 기록하고 momo-main review/merge 후 main gate 재검증.
- [ ] 파일 DnD/첨부 전송은 MOMO-394 storage·credential ADR 선행 후 구현. 이번 변경은 가짜 첨부 상태나 다운로드 이력을 만들지 않음.

### ☑ MOMO-388 수용기준 — Auth-hardening verifier realtime credential binding drift `[tooling/runtime-db/docs]` · Issue #388
- [x] 로그인 access/refresh token-row lookup은 raw bearer를 SQL·psql argv·log에 넣지 않고 로컬 SHA-256 digest만 DB와 대조해 각 `token.id`를 확정. `POST /v1/auth/realtime-token`의 server-minted JWT `meta.token_id`가 exact access row ID와 같은지 UUID canonical 비교.
- [x] active exact access-row binding만 허용. active refresh-row ID·`meta` 누락·임의 token ID·다른 멤버 binding·logout/revoke 이후 binding은 모두 `result == null && error.code == 403` 검증.
- [x] synthetic JWT claim은 `sub`, optional `ws`, `exp`/optional `nbf`/`iat` sanity를 검사. 이 fixture는 server-minted callback binding 검증이며 Centrifugo websocket signature acceptance를 독립 증명하지 않음을 명시.
- [x] raw access/refresh/connection JWT/shared secret을 stdout evidence에 출력하지 않고 auth/refresh 실패 body 비노출. `umask 077` 후 `mktemp -d`, exact-dir cleanup 적용.
- [x] human realtime liveness를 `session` + `label='access'`로 강화해 refresh row 차단. RLS·`schema_v0.sql` 무변경. focused verifier PASS; review 반영 final clean `runtime-db`·`docs` evidence는 PR #393 기록.

### ☑ MOMO-389 (`#395`) 수용기준 — ADR-0119 W-1: OpenAPI 계약 정본 v0 + drift 게이트 `[python/docs]` · 의존: 없음
- [x] `docs/api/openapi.yaml` 신설 — 웹 v0 표면 17개 오퍼레이션: login/refresh/logout/join/realtime-token/roster/channels(list·create)/messages(send·history)/read-state(bulk GET·cursor PUT)/dms(list·open)/approvals(list·decision). 서버 DTO와 필드 단위 일치 — 독립 리뷰가 10개 스키마 그룹 전수 대조로 확인.
- [x] drift 게이트 신설: `scripts/verify_openapi_contract.sh`(격리 e2e compose `momo389gate` 자체 기동·정리) + `scripts/openapi_shape_check.py`(필수 키·타입·enum·UUID·closed-world). 20/20 표본 PASS, 합성 drift 음성 대조 전부 검출. `LOCAL_PR_GATE.md` 등록.
- [x] 서버 소스 무변경. 스펙을 서버에 맞춘 판정 5건(workspace demo 폴백·snake/camel 혼재·UUID 대소문자·옵셔널=키 생략·decision receipt 실패 스키마)을 PR #404 이탈 섹션에 기록.
- [x] `docs` 게이트 + drift 게이트 PASS — evidence는 PR #404 + 독립 리뷰 재현. main merge `6fe746f`.

### ☑ MOMO-390 (`#396`) 수용기준 — ADR-0119 W-3: Caddy APP_DOMAIN site + 웹 정적 서빙 `[infra/docs]` · 의존: 없음 (MOMO-389와 병렬)
- [x] `infra/prod/Caddyfile`에 `{$APP_DOMAIN}` site 추가: SPA 정적 자산 file_server + `try_files` index.html 폴백 + `/v1/*` → `api:8080` reverse_proxy(같은 오리진 — ADR-0119 D1-A) + `/v1/centrifugo/*` 엣지 403 + security_headers import + SPA CSP(자체 오리진 한정, `connect-src 'self' wss://{$REALTIME_DOMAIN}`, inline script 금지) — 전부 `scripts/web_serving_smoke.sh` 런타임 검증.
- [x] `APP_DOMAIN` 미설정 하위 호환: site 주소가 예약 sentinel `momo-app-domain-unset.localhost`로 폴백(내부 CA만, ACME 무발생)하고 sentinel host 요청은 `/`·deep link·`/v1/*` 전부 404 fail-closed. 빈 문자열은 Caddy 파싱 불가라 compose가 `${APP_DOMAIN:-sentinel}`로 흡수(smoke가 set/unset/empty 파싱 매트릭스 검증). 기존 2-site 동작 무변화.
- [x] prod compose: caddy `/srv/momo-web`에 named volume(기본, 빈 볼륨=404) 또는 `MOMO_WEB_DIST_DIR` host 경로 마운트 — api 컨테이너는 웹 서빙 안 함. e2e compose: `web` 프로파일 `web-edge` 서비스(prod Caddyfile + placeholder index.html)로 서빙 smoke; 기본(프로파일 미지정) e2e 렌더는 변경 전과 byte-identical.
- [x] `docs/DEPLOY.md` §4.4에 APP_DOMAIN 델타(신규 env·DNS·미설정 동작·자산 배치) 기록. `prod_env_preflight.sh` strict 모드에 optional APP_DOMAIN 검사(placeholder/reserved 거부, API/REALTIME 중복 거부, unset 허용) 추가. 기존 게이트 무회귀(staging-smoke의 centrifugo namespace FAIL은 main 기저 선재 — PR evidence 기록).

### ☑ MOMO-391 (`#397`) 수용기준 — ADR-0119 W-2: clients/web 스캐폴드 + 로그인/타임라인 v0 `[web(신설)/docs]` · 의존: MOMO-389, MOMO-390
- [x] `clients/web` 신설: Vite + React + TypeScript, 의존성 전부 permissive(MIT/Apache/ISC/BSD — 라이선스 목록을 PR에 첨부, GPL/AGPL 금지), 타입은 MOMO-389 스펙에서 openapi-typescript 생성.
- [x] 로그인(email/password/workspace) → 채널 목록 → 타임라인 읽기(seq 기반 history + `?after=<seq>` backfill) → centrifuge-js 실시간 구독. websocket 주소는 login/join 응답의 `realtimeWebSocketUrl`만 사용(ADR-0110 — API URL에서 추론 금지), 연결 토큰은 `POST /v1/auth/realtime-token`. recovery 실패(`recovered:false`) 시 REST backfill 폴백.
- [x] 토큰 정책 ADR-0119 D3-A 준수: access 메모리 보관, refresh localStorage(회전 사용), 로그아웃 시 서버 revoke + 로컬 삭제. 공개 배포 전 httpOnly 승격 게이트를 코드 주석이 아닌 `clients/web/README.md`에 명문화.
- [x] `web` 게이트 프로파일 신설(`scripts/local_gate.sh --profile web`: install → lint → typecheck → build → e2e compose 대상 로그인→타임라인 smoke) + `LOCAL_PR_GATE.md` 갱신.
- [x] `web` 프로파일에 `scripts/web_serving_smoke.sh` 실행 포함 — APP_DOMAIN sentinel fail-closed(가드가 proxy보다 먼저 평가) 자동 회귀 방어(PR #403 리뷰 Medium-1). centrifuge-js가 HTTP 폴백 transport를 쓰게 되면 CSP `connect-src`를 Caddyfile에서 명시 확장하고 smoke 기대값을 함께 갱신.
- [x] `clients/macOS`·`server` 소스 무변경. ADR-0112 기본 모드 문법만(개발자 밀도·Work 상세·비용 표시 없음). 파일 업로드/웹훅 UI/presence 표시/멀티 워크스페이스 rail 비구현(각 ADR 게이트).
- [x] 종결 evidence: PR #407(+리뷰 반영 b499d32) merge `63e7d51`, 독립 리뷰 Blocker/High 0(Medium 1 반영 — 만료 access 로그아웃 revoke 재시도), merge 후 main `web` 프로파일 전체 게이트 PASS. relay 채널명 대소문자 일치는 리뷰어가 서버 코드 대조로 실증.

### ☑ MOMO-398 (`#408`) 수용기준 — prod Centrifugo `allowed_origins`: 웹 realtime 개통 `[infra/docs]` · 의존: 없음 (W-4/W-5 선행 필수)
- [x] prod Centrifugo 설정에 브라우저 Origin 허용을 추가한다: `APP_DOMAIN` 설정 시 `https://{APP_DOMAIN}`만 allowed_origins로 주입(compose env 또는 config 템플릿 — 방식 재량), 미설정 배포는 기존 동작 완전 무변화.
- [x] 네이티브(비브라우저) 클라이언트 무회귀 — Origin 미전송 경로는 계속 허용됨을 근거로 명시.
- [x] `prod_env_preflight.sh`/`docs/DEPLOY.md`에 델타 반영. prod compose config 렌더 검증(set/unset 매트릭스).
- [x] 배경: PR #407 계획 이탈 §1 — allowed_origins 공백 시 브라우저 wss 403(현재 prod는 fail-closed 상태라 무해, 웹 W-4/W-5 전 개통 필요).
- [x] 종결: PR #413 merge, main `staging-smoke`+`web_serving_smoke` PASS. 실이미지 매트릭스(빈 env≡unset·네이티브 Origin-미전송 무회귀·set 시 단일 오리진만 101) evidence는 PR 본문.

### ☑ MOMO-399 (`#409`) 수용기준 — staging/internal smoke의 Centrifugo namespace drift 수정 `[tooling/docs]` · 의존: 없음
- [x] `verify_staging_smoke.sh`·`verify_internal_hosting_smoke.sh`의 namespace 기대를 현행 `centrifugo.prod.json` 5개(`ch/dm/agent/agentwork/user`)와 일치시켜 main 기저 FAIL을 해소한다(MOMO-338이 `agentwork` 추가 시 미갱신 — DEVIATION_LOG 2026-07-15).
- [x] 가능하면 하드코딩 목록 대신 config 파싱 대조로 구조 개선(재량 — 과하면 목록 갱신 + drift 주석).
- [x] `staging-smoke` 프로파일 PASS evidence.
- [x] 종결: PR #412 merge `5e034fa`, main `staging-smoke` 프로파일 PASS(rc=0). 통합자 직접 diff 검수(소형 tooling) + 음성 대조 3종 evidence.

### ☑ MOMO-400 (`#410`) 수용기준 — ADR-0119 W-4: 웹 작성·read-state·승인 카드 + realtime 왕복 `[web/docs]` · 의존: 웹 첫 배치 종결
- [x] composer: `POST messages`(`clientMsgId` 멱등 — 재전송 중복 없음 smoke 실증), 표시는 서버 echo(브로드캐스트/backfill) 기준, seq 권위 준수. 오류/재시도 카피 제공.
- [x] read-state: bulk GET 초기화 + 열람 시 단조 cursor PUT + 사이드바 unread 배지 + `user:read-state#<member-id>` 실시간 구독(채널명 표기는 서버 outbox 코드 대조 — 첫 배치 리뷰 방식 승계).
- [x] 승인 카드: approvals 목록/타임라인 approval_request에 승인·거부(decision POST). 403/404/409 **receipt 스키마**(openapi 정본)를 카드 상태 전이로 처리(409=타 기기 선결정은 오류가 아님). ADR-0112 기본 모드 문법만.
- [x] DM: dms 목록 사이드바 노출 + 열기(open) 최소 경로.
- [x] `docs/api/openapi.yaml` 무변경(스펙 밖 라우트 소비 금지). 서버·clients/macOS 무변경.
- [x] smoke 확장(작성 멱등·read-state 반영·승인 왕복·409 receipt) 포함 `--profile web` 전체 PASS.
- [x] 종결: PR #414(+리뷰 반영 2) merge `4a06ec5`. 독립 리뷰 Blocker/High 0·Medium 1(스모크 커버리지) 반영 — gateway형 픽스처+양 표면 무누출 단정, DOM 레벨 음성 대조 실증(심은 누출을 단정이 검출). 최종 스모크 25 PASS/0 FAIL.

### ☑ MOMO-401 (`#411`) 수용기준 — ADR-0119 W-5: 초대 링크 웹 합류 `/join/<code>` `[web/docs]` · 의존: MOMO-400 (같은 파일군)
- [x] SPA `/join/<code>` 라우트: 공개 `POST /v1/join` 호출(openapi 정본 스키마), 성공 시 가입 완료 → join 응답이 로그인 토큰 미포함이면 로그인 폼 프리필 연결(스펙을 앞지르는 자동 로그인 금지).
- [x] 초대 오류 UX: 만료/사용 소진/revoked를 서버 오류 envelope 기반 사용자 카피로 구분 표시.
- [x] ADR-0121 D2-B 형태(서버 자체 도메인 링크)가 이 티켓의 산출물 — Dawn 단축 링크(S-4)는 범위 밖.
- [x] smoke: 시드 admin으로 초대 발급 → `/join/<code>` → 가입 → 로그인 → 타임라인 진입 + 만료/소진 오류 케이스. `--profile web` 전체 PASS.
- [x] 서버·clients/macOS·스펙 무변경.
- [x] 종결: PR #419(+리뷰 M1/L1 반영 3f88888) merge `9616c67`. 독립 리뷰 Blocker/High 0 — join 토큰 판정(JoinResponse required 토큰=스펙 준수)·오류 카피의 서버 문자열 7지점 대조·코드 비유출 전부 확인. 스모크 32 PASS(신규 7)·web 게이트 전체 PASS. **ADR-0119 웹 v0 스코프(389~391·398~401) 완주.**

### ☑ MOMO-403 (`#420`) 수용기준 — ADR-0120 P-1: device/push_token 등록·해지 REST `[server/runtime-db]` · 의존: 없음
- [x] 신규 `DeviceRoutes.swift`: 인증 멤버가 자기 device(platform ios/macos)+push_token(apns_token/env/topic)을 등록(멱등 upsert — 재등록=갱신)·조회·해지. actor binding(타인 device 403), RLS FORCE, 같은 트랜잭션 audit_log. `App.swift` 배선은 최소 블록(UX 트랙 공유 핫파일 — 주변 리팩토링 금지).
- [x] 수명주기 계약: 해지 시 `invalidated_at` 기록(물리 삭제 아님 — dispatch_log FK 보존), 410/400 무효화 컬럼 계약(DEPLOY.md 운영 상수)과 정합. schema_v0 불변, 필요 확장은 신규 migration만.
- [x] `docs/api/openapi.yaml` 무변경(웹 v0 표면 아님). id-only 원칙과 무관한 라우트지만 응답에 raw apns_token 전문을 되돌려주지 않는다(등록 확인은 ref/suffix만).
- [x] 신규 registration verifier: 등록→멱등 재등록→조회→해지→cross-tenant/타인 거부→audit 행. `runtime-db` 게이트 PASS + `LOCAL_PR_GATE.md` 등록.
- [x] 종결: PR #422(+리뷰 M1/L1/L3/L4 반영 ae919a3) merge `36c0d70`. 독립 리뷰 Blocker/High 0 — actor binding 이중 방벽·suffix-only·SQL 바인딩·rate limit 상속·migration 010 partial unique(DB 강제) 전부 확인함. 반영본 verifier 재실행 PASS.

### ☑ MOMO-404 (`#421`) 수용기준 — ADR-0120 P-2: notifier worker + 판정 v0 + mock relay `[server/runtime-db]` · 의존: MOMO-403
- [x] 신규 `workers/NotifierWorker`(OutboxRelay 패턴: ServiceLifecycle·SKIP LOCKED·graceful shutdown). 판정은 이 worker 한 곳(P9): v0 = DM 전건 + 멘션(MessageRoutes의 서버 재계산 mention projection 재사용 — 재파싱 금지) + 승인 요청. 채널 알림 설정/DND/mute는 범위 밖(UX MOMO-395가 설정 표면 소유 — 소비자 자리만 주석).
- [x] 후보 생성→소비: 같은 tenant 트랜잭션 내구 기록 + at-least-once 소비 + 멱등 dispatch(형태 재량 — 근거 PR 기록). relay `broadcast`·`agent_job` 소비와 경합 없음을 검증. notifier DB role 결정(신설 시 bootstrap/검증 정합, 재사용 시 최소성 근거).
- [x] 발송은 mock relay(e2e mock-hermes 패턴)까지 — **id-only 하드 계약**: mock 수신 페이로드에 메시지 본문·표시명 부재를 verifier가 단정. `push_dispatch_log`에 상태 기록(스키마 계약 준수).
- [x] e2e compose에 notifier+mock relay 추가하되 기본 프로파일 렌더 불변. `clients/**`·`infra/prod/**` 무변경.
- [x] 신규 notifier verifier: DM/멘션/승인 각 1건 왕복(dispatch_log+mock 수신+id-only 단정+재시작 멱등) + relay/agent_job 무회귀. `runtime-db` 게이트 PASS + `LOCAL_PR_GATE.md` 등록. api/relay 콜드빌드는 staggered boot 패턴 승계.
- [x] 종결: PR #424(+리뷰 H1/M1/L1 반영 5ed2914) merge `a8a1089`. 트리거 채택은 리뷰 판정 "재량 행사·불변식 정합"(일회용 PG 독립 재현 포함) — overview.md 동PR 정본화. 반영본 verifier 재PASS(DM 1/멘션 1/승인 2/agent 0, id-only 전건, 재시작 중복 0).

### ☑ MOMO-406 (`#425`) 수용기준 — ADR-0121 S-1: install/upgrade 스크립트 + "5분 설치" 문서 `[infra/staging-smoke/docs]` · 의존: 없음
- [x] `infra/prod/install.sh`: ADR-0002 계약 승계 — pinned image digest 입력 검증 → env/시크릿 preflight(`prod_env_preflight.sh` 재사용) → compose pull/up 순서(migrate one-shot 포함) → 헬스 확인 → 실패 시 명확한 진단 출력. 비대화형(플래그/env 입력) + 멱등(재실행 안전).
- [x] `infra/prod/upgrade.sh`: 현재 태그 기록 → 새 digest pull → migrate → 순차 재기동 → 헬스 확인 → **실패 시 이전 태그 롤백 경로**(문서화된 수동 개입 지점 포함). DB migration은 전방 전용(롤백은 앱 레이어만)임을 명시.
- [x] `docs/DEPLOY.md`에 "5분 설치" 절: 전제(도메인/DNS/docker) → install.sh 한 줄 → 첫 워크스페이스/초대까지. **단일 노드 상한을 숫자로 명시**(동시 수백 명 보수 표기 — ADR-0121 D1). relay 등록 스텝(ADR-0120 P-3)은 자리만(주석) — 실패해도 설치 성공(오프그리드 1급).
- [x] 두 스크립트 모두 `bash -n`+shellcheck clean, `docker compose config` 렌더 기반 정적 검증 포함(실 VPS 불요). 시크릿 값 echo 금지.
- [x] `staging-smoke` 프로파일 확장 또는 신규 verifier로 install/upgrade의 정적 계약(인자 검증·롤백 경로 존재·preflight 배선) 검증. `LOCAL_PR_GATE.md` 등록.
- [x] `clients/**`·`server/**` 무변경. compose/Caddyfile 기존 계약(APP_DOMAIN sentinel, allowed_origins 파생) 무회귀.
- [x] 종결: PR #429(+리뷰 H1/M1/L 반영 1865bbf) merge `bb3efc6`. worker=gpt-5.6-sol medium(codex-fleet 복귀 1호). H1=시드 dev-password 공개 창 경고·인수 필수 스텝 승격(+prod fail-closed 시드 후속 티켓 후보). main staging-smoke PASS.

### ☑ MOMO-407 (`#426`) 수용기준 — ADR-0121 S-2: 초대 보안 계약 구현 `[server/runtime-db]` · 의존: 없음 (MOMO-406과 병렬 — 파일군 분리)
- [x] 만료 기본값 명문화·구현: 초대 생성 시 `expiresAt` 미지정이면 서버 기본 적용 — 링크 초대 7일(ADR-0121 D3). 기존 명시 지정 경로 무회귀.
- [x] 역할 바인딩 검증: 초대에 실린 role대로만 가입되고(admin이 만든 링크도 명시 role로만), owner role 초대 생성은 거부(fail-closed). 생성자 권한(owner/admin) 검증 기존 유지.
- [x] regenerate: 기존 초대를 revoke하고 새 코드를 발급하는 명시 경로(신규 REST 또는 기존 revoke+create 조합의 원자 트랜잭션 — 설계 재량, 근거 PR 기록). audit_log 기록.
- [x] `docs/api/openapi.yaml` 무변경(웹 v0 표면의 join/invites 응답 shape 불변 — 기본 만료는 응답 필드 값으로만 드러남). shape 변경이 필요해지면 멈추고 이탈 보고.
- [x] 기존 invite 스키마(`003_onboarding.sql` — max_uses/expires_at/revoked_at/role) 내에서 구현 — 신규 migration은 필요 시에만(근거 기록). schema_v0 불변.
- [x] `verify_join.sh` 확장 또는 신규 verifier: 기본 만료 적용·역할 바인딩(owner 거부)·regenerate 왕복(구 코드 즉시 무효)·audit. `runtime-db` 게이트 PASS.
- [x] 종결: PR #428(+M1 명문화·verifier casing 수정) merge `4a8b288`. 독립 리뷰 확인: owner fail-closed 3중 방어(화이트리스트+DB CHECK+join rank), regenerate 단일 CTE 트랜잭션(구 코드 유효 창 없음). runtime-db 게이트 PASS.

### ☑ MOMO-408 (`#430`) 수용기준 — prod 시드 fail-closed: dev-password 백필 차단 `[server/runtime-db]` · 의존: 없음 (PR #429 리뷰 H1 파생 — 공개 배포 전 필수)
- [x] prod 모드에서 시드 owner(`demo@momo.local`)가 **결정론적 `dev-password`로 로그인 가능한 창을 제거**한다: `005_auth_password_hash.sql`의 무조건 백필을 신규 migration으로 교정 — dev/e2e/demo 모드에서만 백필 유지, production은 `password_hash IS NULL` 유지(로그인 fail-closed) 또는 시드 시 랜덤·비복원 해시. 방식 재량(모드 판별은 기존 seed-mode 컨벤션 — `002_seed.sql`/`006` 의 게이팅 방식 대조), 근거 PR 기록.
- [x] `momo_password_verify`가 NULL hash에 대해 항상 false(오류 아님)임을 확인·유지 — 인수 전 로그인 시도는 401.
- [x] 기존 배포 소급: 신규 migration이 **이미 백필된 dev-password 행**을 prod 모드에서 잠근다(해당 워크스페이스 owner가 dev-password 그대로면 무효화). dev/e2e 로컬 스택 무회귀(기존 verifier들의 dev-password 로그인 의존 지점 대조 필수 — verify_join/verify_rls 등).
- [x] `docs/DEPLOY.md` H1 경고 절 갱신: "후속 서버 티켓" 문구를 이 티켓 반영 상태로 교체(인수 절차는 여전히 필수 — 이제 인수 전 로그인이 아예 불가함을 명시).
- [x] schema_v0 불변. verifier: prod-모드 ephemeral PG에서 migrate → dev-password 로그인 401 → 인수 UPDATE → 로그인 200 (201은 원 수용기준 오기 — 로그인 API 계약은 200, worker 이탈 보고로 정정), dev 모드에서 기존 경로 무회귀. `runtime-db` 게이트 PASS(오케스트레이터 실행).
- [x] 종결: PR #431(+리뷰 H1/H2/M1 반영 ee40e40) merge `8193734`. H1=잠금을 dev-password 전 human으로 확장(잔존 노출 봉합), H2=로컬 러너 명시 부트스트랩(도그푸드 무회귀·prod fail-closed 유지), 오잠금 벡터 없음(리뷰 확정+매트릭스 verifier). 후속 후보: INTERNAL_ALPHA/RUN 문서 dev-password 안내 정비(M2).

### ☑ MOMO-410 (`#434`) 수용기준 — ADR-0113 SE-04A: plugin manifest registry + install/grant 런타임 `[server/runtime-db]` · 의존: 없음
- [x] manifest 계약(ADR-0113 D6): 업계 3층(plugin.json 계열 메타 + MCP 서버 참조(원격 URL 우선, `server.json` 스키마 필드 차용) + 선택 SKILL.md 참조) + momo 확장 필드(`approvalTier` 도구→티어 매핑, `risk`, `egressDomains`, `recommendedFor`, `serverPolicy`). validator가 protocol 호환·SPDX 라이선스(GPL/AGPL 거부)·publisher/provenance·digest·tools/scopes/risk/approval policy를 검증하고 unknown 값은 fail-closed.
- [x] 신규 migration: plugin registry(카탈로그 항목)·workspace install record·**grant 4-튜플(workspace, member, plugin, scope)**(ADR-0113 D2)·Capability Cache projection. RLS FORCE + audit_log 같은 트랜잭션. schema_v0 불변.
- [x] REST: 카탈로그 목록/상세(active member), install/revoke(owner/admin — serverPolicy 게이트), grant/revoke-grant(본인 grant만 — 위임 주체=사용자). **raw credential/토큰을 어떤 테이블·로그·응답에도 저장·노출하지 않는다**(커스터디 A: 토큰은 에이전트 호스트 소유). revoked install/grant는 Capability Cache에서 즉시 제외(fail-closed).
- [x] 오피셜 시드 카탈로그: GitHub(remote `api.githubcopilot.com/mcp/`)·Notion(`mcp.notion.com/mcp`)·Linear(`mcp.linear.app/mcp`) 3항목을 manifest 픽스처로 등재(16-03 검증분 — Drive 경로C·Slack-호환 webhook은 후속 SE).
- [x] `docs/api/openapi.yaml` 무변경(웹 v0 표면 아님). `clients/**`·`infra/prod/**` 무변경.
- [x] 신규 verifier: manifest 검증 fail-closed 매트릭스(GPL 거부·unknown risk·malformed)·install/grant/revoke 왕복·cross-workspace 403·grant 없는 플러그인의 Capability projection 부재·audit 행. `runtime-db` 게이트 PASS(오케스트레이터 실행) + `LOCAL_PR_GATE.md` 등록.
- [x] 종결: PR #435(+리뷰 H1/M1/M2 반영 fb5cebd) merge `1809551`. 커스터디 A 무저장·validator 화이트리스트 fail-closed·grant 4-튜플 DB CHECK — 독립 리뷰 "확인함". plugin verifier 전체 PASS(M2 강화판) + runtime-db PASS(rebase 후). 후속 기록: registry revoke의 projection 무효화(후속 SE), 시드 schemaDigest 실해시(Context Broker 소비 전), read-path 500 패턴 2회째(3회 시 공용 헬퍼 승격).

### ☑ MOMO-411 (`#436`) 수용기준 — local_gate 리소스 가드: --down + 부하 체크 `[tooling]` · 의존: 없음
- [x] `scripts/local_gate.sh`에 ① `--down`(또는 기본 trap): runtime-* 프로파일이 올린 compose project를 게이트 종료 시(성공/실패 모두) down — 명시 opt-out(`--keep-stack`)만 예외 ② 시작 전 부하 체크: load(1min)>12면 경고+확인 요구(env `LOCAL_GATE_FORCE=1`로 우회), `MULTI_SESSION_OPS.md` §9 임계값과 일치.
- [x] `compose_janitor.sh`의 매칭 사각지대 보완: `momo240_*` 프로젝트도 stale 후보에 포함(볼륨은 계속 불변).
- [x] 기존 게이트 evidence 포맷·PASS 의미 무변경. 전 프로파일 무회귀(docs 게이트로 스크립트 정적 검증 + runtime-db 1회 실증).
- [x] `docs/LOCAL_PR_GATE.md`·`MULTI_SESSION_OPS.md` §9 상호 참조 갱신.
- [x] 종결: PR #439(+리뷰 H1/M1/M2/M3/L1/L5 반영) merge `710a069`. teardown 잔재 0 두 런 실증(dirty-fail·clean), --down + 부하 체크(load>12 차단) + momo240 PID 보호 + pre-existing 스택(momo_main) 무접촉. macOS 스냅샷 FAIL은 origin/main 선재(UX 트랙 — 격리 확정).

### ☑ MOMO-412 (`#438`) 수용기준 — ADR-0115 SE-04B: signed webhook ingress + Slack-호환 모드 `[server/runtime-db]` · 의존: MOMO-410(랜딩됨)
- [x] 발급/회전/revoke REST(owner/admin, 채널 바인딩 고정): native 모드는 per-install HMAC-SHA256 — secret은 **one-time reveal**(저장은 key ID/secret ref만, 어떤 테이블·로그·응답에도 raw 미저장), overlap rotation + revoke. webhook install은 MOMO-410 registry의 `external_webhook` plugin install로 기록(audit 같은 트랜잭션).
- [x] native 수신: signature base = version+method+canonical endpoint/install ID+timestamp+delivery ID+raw-body SHA-256, constant-time 비교, replay window, strict body/parser limits, rate limit. `(workspace_id, installation_id, delivery_id)` unique receipt + deterministic `client_msg_id` + channel seq/message/outbox **한 tenant 트랜잭션**.
- [x] **Slack-호환 모드(D2-A)**: `POST /hooks/{token}`(URL-시크릿, 서명 없음 — 고엔트로피 토큰), 변환기는 `text`+legacy `attachments`(MM 검증 필드 화이트리스트)+`<url|text>`/멘션/`<!channel>` 번역. **`blocks`는 400+명시 오류**. 멱등은 `(install, body hash, 시간창)` 근사. 미지원 목록 문서화(MM 동일).
- [x] 발신 author 표기: 사람/에이전트 사칭 불가 하드 계약 — 구체 모델(전용 표기 vs 설치자 위임)은 재량+근거 기록. provider의 Centrifugo 직접 publish 불가.
- [x] `docs/api/openapi.yaml`·`clients/**`·`infra/prod/**` 무변경(발급 UI는 UX 트랙 후속). schema_v0 불변 — 신규 migration(014)만.
- [x] 신규 verifier: 위조 서명/재전송(replay)/stale timestamp/cross-workspace/회전 경합(신구 키 창)/revoke 후 거부/시크릿 redaction + **Slack 페이로드 픽스처 왕복**(text·attachments 번역 결과 메시지 확인, blocks 400) + receipt 멱등(동일 delivery 재수신 1회 기록). `runtime-db` 게이트 PASS(오케스트레이터 — **§9 부하 체크 후 실행, 종료 시 down**) + `LOCAL_PR_GATE.md` 등록.
- [x] 종결: PR #443(+리뷰 H1 반영·verifier 단정 수정) merge `5ff5161`. webhook verifier 전체 PASS(native HMAC 위조/replay/cross-workspace·키 회전·secret custody+redaction·**Slack 변환 왕복 201+미지원 무시+author 사칭 차단**·1-tx). 리뷰: 암호학·secret·단일 쓰기 경로 "흠 없음". M1/M2(rate limit·master key 분리)는 DEVIATION_LOG pending.

### ☑ MOMO-448 (`#449`) 수용기준 — MOMO-447 사후 리뷰 수정 `[macos-ui]` · 의존: 없음 (사후 품질)
- [x] **P0** 검색→메시지 점프 silent 실패 봉합(load-around-target 또는 실패 피드백 + `isPinnedToTimelineBottom=false` 선세팅) — 코드리뷰 M2=디자인 M3, dogfood 체감 버그.
- [x] **P0** 검색 포커스 하이라이트를 author-type accent 행 전체 tint에서 중립 system tint 단일 색으로 — momo-design-taste §4 위반(정체성 tint 금지·1 accent).
- [x] **P1** hover→scrollTo 피드백 루프(키보드 이동에서만 scrollTo) 3서피스 일괄 + 죽은 토큰 소비/selection 배경 단일 토큰화 + dead copy(approveAllReversible) 제거 + DM 피커 닫기 카피.
- [x] **P2** stale light 캐노니컬 재기록 + ApprovalInbox close-crop 스냅샷 + 신규 3서피스(검색/DM/launcher) 스냅샷 light+dark.
- [x] `macos-ui` 게이트 PASS(오케스트레이터 §9 부하 체크 후) + pre-flight 유지. 상세: issue #449 본문(패킷 겸용).
- 랜딩: PR #450 squash `df0bc00`(2026-07-17). 게이트 3차 PASS(테스트 327/0). 오케스트레이터 후속 커밋: 캐노니컬 21장 게이트 환경 재기록(worker 셸 폰트 렌더 편차 — RECORD는 오케스트레이터 몫으로 환류) + selection 토큰 파급분(ChannelRoster 6·QuickSwitcher 4). 발견: macos-ui 프로파일에 `make up` 부재(선재 게이트 공백, 소형 티켓 후속).

### ☑ MOMO-449 (`#451`) 수용기준 — SE-04C GitHub grant→tool policy 왕복 `[runtime-agent]` · 의존: MOMO-410
- [x] adapter가 packet 조립 시 유효 grant 있는 플러그인만 MCP 접속 기술자(url/transport/egressDomains/tools risk·approvalTier)를 tool policy에 포함 — fail-closed(D5), 자격증명 필드 자체 부재(ADR-0004/0113).
- [x] revoke→다음 조립 즉시 탈락(장기 캐시 금지). malformed manifest는 해당 플러그인만 skip.
- [x] hermes 계약 테스트(mock REST) + `scripts/verify_plugin_grant_roundtrip.sh`(github.json 등재→install→grant→포함→revoke→탈락, 실 GitHub 호출 없음).
- [x] 호스트 커스터디 전제 문서화(D6 항목). 상세: issue #451 본문(패킷 겸용).
- 랜딩: PR #455 squash `9b20692`(2026-07-17). 오케스트레이터 실런: verify_plugin_grant_roundtrip PASS + verify_plugin_registry 회귀 PASS + runtime-agent 게이트 PASS. D2 구체화(agent는 위임 사용자 grant를 job channel binding으로 조회)는 계획 이탈란에 기록됨.

### ☑ MOMO-450 (`#452`) 수용기준 — macos-ui 게이트 스택 자급 `[swift]` · 의존: 없음 (선재 공백)
- [x] macos-ui 프로파일 조립에 `add_runtime_bootstrap_commands` 추가 + teardown 기본 동작이 회수 확인 + §9 load 게이트 적용 확인.
- [x] drift guard 테스트 통과 + evidence 체크리스트에 compose up 단계 표기. 상세: issue #452 본문(패킷 겸용).
- 랜딩: PR #453 squash `b835e76`. 실런 3박자 검증: 자급 기동(compose-up 단계 표기) + §9 거부 실증(load 12.63) + 종료 후 스택 0.

### ☑ MOMO-452 (`#458`) 수용기준 — dev 세션 키체인 우회 `[swift]` · 의존: 없음 (성재 결정 2026-07-17)
- [x] dev 번들(app.momo.dev.MomoMacDevApp) 한정 평문 UserDefaults 저장으로 이관 — SecItem* 경로 dev에서 제거, 재빌드 후 키체인 프롬프트 0. prod 경로(MomoKeychainPasswordStore) 보존.
- [x] password 미저장 시 `dev-password` 자동 채움 + "비밀번호 저장" 카피 정리(ko/en) + storageNote 갱신.
- [x] 세션 store 단위 테스트 2건 신설(기본 자격/저장·삭제 왕복) — 22/22 PASS, pre-flight 0.
- 랜딩: PR #459 squash `65a55ba`(2026-07-17). 즉시 완화로 기존 키체인 항목은 오케스트레이터가 선삭제.

### ☑ MOMO-456 (`#461`) 수용기준 — macOS center-pane plugin marketplace UX `[swift]` · 의존: MOMO-410
- [x] sidebar, workspace menu, composer `+`의 세 진입점이 동일한 center-pane catalog로 연결된다.
- [x] 검색, workspace/personal scope, category, installed-only filter와 Drive/Calendar/Gmail/GitHub/Notion 설치/제거 shell을 제공한다.
- [x] 선택 상태는 server credential 없이 local-only로 저장하고 실제 registry grant/OAuth 연결 전임을 화면에 명시한다.
- [x] provider/Codex 브랜드 에셋을 복제하지 않고 공식 브랜드 에셋 적용 전까지 semantic SF Symbol을 사용한다.
- [x] 보안·correctness·성능·접근성 리뷰 Blocker 0 / High 0, macOS 330 tests PASS.

### ☑ MOMO-457 (`#463`) 수용기준 — SE-04D Drive 경로 C MCP 포장 v0 `[runtime-db]` · 의존: MOMO-449
- [x] `POST /v1/mcp/drive` stateless MCP 부분집합(initialize/tools.list/tools.call) — agent bearer+위임 binding, tools/call마다 grant 재검증 fail-closed + audit 같은 트랜잭션.
- [x] read-only 3종(search_files/get_file_metadata/export_text, 공유 드라이브 한정) + DriveBackend 분리(SA env 커스터디, stub 옵트인·prod 거부).
- [x] drive.json manifest(momo-hosted 표기, descriptor 절대화) + `verify_drive_mcp.sh`(stub, 실 Google 무호출) PASS.
- [x] 쓰기/업로드/폴러/경로 A 전부 out of scope(GWS-ARCHIVE 트랙). 상세: issue #463 본문(패킷 겸용).
- 랜딩: PR #465 squash `367442c`(2026-07-17). 오케스트레이터 후속 2커밋: verifier rg→grep(호스트 ripgrep 부재) + registry verifier 시드 4→5. 실런: verify_drive_mcp PASS + runtime-db 게이트 PASS. 관찰: 백엔드 호출이 tx 내 실행(SA 타임아웃 15s 유계) — 후속 개선 후보.

### ☑ MOMO-458 (`#466`) 수용기준 — 오피셜 라인업 마감(Notion/Linear 왕복 + 추천 세트) `[runtime-db]` · 의존: MOMO-457
- [x] grant 왕복 verifier에 Notion/Linear 추가 — 다중 플러그인 정확 집합 단정 + 개별 revoke 탈락, 실 네트워크 무호출.
- [x] 카탈로그 항목 `recommended: Bool`(서버 상수 {github, drive, external_webhook} — ADR-0113 D6 예시 세트) + registry verifier 단정.
- [x] python 다중 플러그인 계약 1건. 상세: issue #466 본문(패킷 겸용).
- 랜딩: PR #467 squash `f9085dd`(2026-07-17). 오케스트레이터 후속 2커밋: roundtrip verifier runtime-db 게이트 편입(449 이후 공백) + python>=3.10 명시 탐색(게이트 PATH의 Xcode python3 3.9 회피). 실런 runtime-db 게이트 PASS(플러그인 4 verifier 전체).

### ☑ MOMO-459 (`#468`) 수용기준 — openapi 플러그인 표면 문서화 `[runtime-db]` · 의존: MOMO-458
- [x] plugins CRUD+toolPolicy/webhook 발급·수신/Drive MCP JSON-RPC paths를 실제 DTO 대조로 명세(추측 금지, 코드가 정본).
- [x] verify_openapi_contract 라이브 대조 + shape check 소화 + ruby YAML 파싱 PASS.
- [x] 기타 미기재 표면은 추가 않고 목록만(스코프 고정). 상세: issue #468 본문(패킷 겸용).
- 랜딩: PR #469 squash `c109043`(2026-07-17). 신규 13 operation 라이브 대조 41/41 PASS. 오케스트레이터 후속 1커밋: expires_at_ms 오배치(DriveMCP 응답→ApprovalProjection) 교정 — 선재 approvals 스펙 drift 동시 마감. 잔여 미기재 표면 목록은 PR #469 본문(후속 문서 티켓 후보).

### ☑ MOMO-460 (`#470`) 수용기준 — S-4 v0 초대 단축 링크 리다이렉터 `[swift]` · 의존: 없음 (도메인 미정 대응)
- [x] `services/LinkShort`(Hummingbird 2): `/i/{code}`→302 `{TARGET}/join/{code}`(검증 없음·매핑만), `/healthz`, env 미설정 부팅 거부.
- [x] Makefile SWIFT_PKGS + 게이트 편입 + 단위 테스트 + `verify_linkshort.sh`(호스트 프로세스, docker 불필요).
- [x] 도메인 확정 후 multi-tenant 매핑은 후속. 상세: issue #470 본문(패킷 겸용).
- 랜딩: PR #472 squash `69ace59`(2026-07-17). 오케스트레이터 실런: LinkShort 테스트 4/4 + verify_linkshort PASS(healthz 200/redirect 302/invalid 400/포트 회수) + drift guard PASS. 도메인 확정 시 DNS만 — multi-tenant 매핑은 그때 후속.

### ☑ MOMO-461 (`#471`) 수용기준 — ADR-0120 P-3 PushRelay v0 `[swift]` · 의존: P-1/P-2 (기랜딩)
- [x] `relay/PushRelay`: /v1/push(momo.push.dispatch.v1) — env 레지스트리(server_id→Ed25519 공개키) 서명 검증 403/rate limit 429, APNSSender 프로토콜(실 ES256 HTTP/2 + Stub), APNs status passthrough(410/400 invalidate 정합), id-only 유지.
- [x] NotifierWorker 서명 첨부(env 옵트인, mock 호환 유지) + keygen + verify_push_relay.sh(Stub·호스트 프로세스) + PUSH_RELAY_RUNBOOK.
- [x] 실 .p8 smoke는 오케스트레이터(자격증명 실검증 2026-07-17 완료: 샌드박스 400 BadDeviceToken 판정). 상세: issue #471 본문(패킷 겸용).
- 랜딩: PR #473 squash `94b62bc`(2026-07-17). 실런: PushRelay 4/4+Notifier 3/3 테스트, verify_push_relay PASS(서명/403/429/id-only), **실 .p8 end-to-end smoke PASS**(서명 dispatch→ES256→APNs 샌드박스 apns_id 발급+400 BadDeviceToken passthrough). 후속 노트: push-type alert+무alert 조합은 P-4(iOS 확장) 시점 조정, prod에서 stub sender 거부 하드닝 후보.

### ☑ MOMO-462 (`#474`) 수용기준 — IOS-1 iOS 앱 골격 `[ios]` · 의존: ADR-0123 Accepted (MOMO-040 승계)
- [x] `clients/iOS/MomoiOS.xcodeproj`(iOS 26 SDK, bundle app.momo.ios, Push+Background Modes entitlements, CODE_SIGNING_ALLOWED=NO 시뮬레이터 빌드) + `MomoiOSKit`(SwiftPM, MomoCore path 의존) — 셸은 엔트리만, 로직은 킷.
- [x] 로그인(맥 폼 필드 계약 동일·HIG·Dynamic Type)→부트스트랩→자리표시 홈. 세션은 UserDefaults(키체인 금지, MOMO-452 결정). MomoMac REST 클라이언트는 필요 최소 복제(Core 이동 금지 — D1 복제 후 수렴).
- [x] `verify_ios_build.sh`(시뮬레이터 동적 탐색) + local_gate `ios` 프로파일 + drift guard 케이스 + taste `references/ios-rubric.md`.
- [x] 시뮬레이터 게이트 실런은 오케스트레이터. 상세: issue #474 본문(패킷 겸용).
- 랜딩: PR #475 squash `cb2f753`(2026-07-17). 오케스트레이터 실런: verify_ios_build PASS(실 시뮬레이터 build-for-testing+test) + 신설 ios 프로파일 게이트 첫 실행 PASS. worker 샌드박스는 CoreSimulatorService 접근 불가 — 시뮬레이터 검증은 오케스트레이터 몫으로 확정(파이프라인 전례).

### ☑ MOMO-463 (`#476`) 수용기준 — IOS-2 목록+타임라인 열람 `[ios]` · 의존: MOMO-462
- [x] 채널/DM 목록+unread(ADR-0109 계약)+pull-to-refresh, 타임라인 히스토리+Centrifugo 실시간 append(`message.seq` 순서·중복 가드), 승인 카드 열람 전용.
- [x] 상태 4종(빈/로딩/오류/오프라인) + Dynamic Type/혼합 3줄 오버플로 + 킷 단위 테스트 + ios 게이트 유지. 상세: issue #476 본문(패킷 겸용).
- 랜딩: PR #477 squash `daff55e`(2026-07-17). 오케스트레이터 실런: 시뮬레이터 게이트 PASS. IOSTimelineReducer가 id/clientMsgId/seq 3중 가드로 중복·수정 처리, 실시간 끊김 시 REST fallback 배너.

### ☑ MOMO-464 (`#478`) 수용기준 — IOS-3 컴포저+승인 결정 `[ios]` · 의존: MOMO-463
- [x] 컴포저 전송(REST 단일 쓰기경로+client_msg_id 멱등, 낙관→reducer 수렴, 실패 재시도) + 인용 답장(스레드 작성 스코프 외).
- [x] 승인/거부 결정(client_decision_id 멱등, 비가역 티어 확인 1단계, 상태 전이) + 킷 단위 테스트 + ios 게이트 유지. 상세: issue #478 본문(패킷 겸용).
- 랜딩: PR #479 squash `9aad292`(2026-07-17). 오케스트레이터 실런: 시뮬레이터 게이트 PASS. 전송 clientMsgId 낙관→reducer 수렴, 결정은 pending 저장으로 재시도에도 같은 clientDecisionId(멱등), 비가역 확인 다이얼로그 destructive role.

### ☑ MOMO-465 (`#480`) 수용기준 — IOS-4 푸시 수신 (P-4) `[ios]` · 의존: MOMO-464
- [x] 권한→토큰→`POST /v1/workspaces/:ws/devices` 등록(로그아웃 DELETE) + App Group 세션 공유 + NSE id-only fetch(실패 fail-open) + deep link(cold start 포함).
- [x] relay placeholder alert(정적, 내용 비포함) + verify_push_relay 단정 갱신 + .apns 픽스처. simctl push smoke는 오케스트레이터. 상세: issue #480 본문(패킷 겸용).
- 랜딩: PR #481 squash `a0e3d0c`(2026-07-17). 1차 worker 모델 capacity 사망→동일 worktree 이어받기 재스폰 성공(빈번 커밋 계약 유효). 오케스트레이터 수정 3건: Swift 6 sending 캡처(NSE unchecked Sendable 관용구·delegate nonisolated 환원·PushKit import — worker 샌드박스 xcodebuild 불가로 미검출). 실런: 킷 18/18(swift-testing) + relay 4/4+verifier + 시뮬레이터 게이트 + simctl push 전달. 배너 표시 evidence는 권한 흐름상 IOS-5 실기기 몫(정직 기록).

### ☑ MOMO-466 (`#482`) 수용기준 — IOS-5 TestFlight 런북+배포 준비 `[ios]` · 의존: MOMO-465
- [x] 절제된 dev 아이콘(생성 스크립트+1024 PNG) + Release 시뮬레이터 빌드 sanity + dev 전용 코드 교체 항목 명시.
- [x] IOS_TESTFLIGHT_RUNBOOK([manual]: App ID/App Group 등록→서명→archive 업로드→internal 테스터→실기기 E2E 체크리스트, 서버 연결 옵션). 서명/업로드 실행은 성재. 상세: issue #482 본문(패킷 겸용).
- 랜딩: PR #483 squash `3d321c6`(2026-07-17). 오케스트레이터: Release 시뮬레이터 빌드 SUCCEEDED. 잔여는 런북 [manual] 48단계(성재) — 실기기 E2E가 iOS v0 배치의 최종 evidence.

### ☑ MOMO-467 (`#484`) 수용기준 — IOS-4 후속: 등록 env 자동판별 + 실패 관측 `[ios]` · 의존: MOMO-465 (실기기 검증서 발견)
- [x] 디바이스 등록 env를 aps-environment(development/production)로 자동 판별(sandbox 하드코딩 제거) + 매핑 단위 테스트.
- [x] 등록 실패 `try?` 삼킴 제거 → os_log(토큰 suffix만) + 1회+foreground 재시도. 실기기 재검증은 [manual]. 상세: issue #484 본문(패킷 겸용).
- 랜딩: PR #485 squash `37480d2`(2026-07-18). APS_ENVIRONMENT→Info.plist→런타임 매핑(테스트 20/20), os_log 전 지점 + foreground 재시도. 시뮬레이터 게이트 PASS. 실기기 재검증(케이블 Run)은 성재 [manual] 대기.

### ☑ MOMO-468 (`#486`) 수용기준 — V-1 huddle 스키마+수명주기+LiveKit JWT `[runtime-db]` · 의존: ADR-0122 Accepted
- [x] 016_huddle(huddle+participant, RLS FORCE, 활성 partial index) + 시작(멱등)/join(JWT)/leave(마지막 퇴장=종료)/active REST — 같은 tx + outbox 3종 이벤트 + audit.
- [x] LiveKit HS256 JWT(video grant, ttl 10분), env 미설정 시 503 fail-closed. verify_huddle_lifecycle(격리 compose, LiveKit 불요) + runtime-db 편입 + openapi 명세.
- [x] 상세: issue #486 본문(패킷 겸용). V-2(infra)→V-3(macOS, UX 조율)→V-3b(iOS) 순차.
- 랜딩: PR #488 squash `df18a6b`(2026-07-18). 실런: verify_huddle_lifecycle PASS + runtime-db 게이트 PASS(3차 — 1차 §9 부하 거부 정상동작, 2차에서 461 선재 컨테이너 Sendable 결함 발견→PR #490 1줄 수정 선랜딩). openapi 동시 명세.

### ☑ MOMO-469 (`#487`) 수용기준 — 푸시 탭 deep link 관통 `[ios]` · 의존: MOMO-467 (실기기 E2E 발견)
- [x] 라우터 관측 가능화 + signedIn에서 pending 소비→채널 타임라인 진입(1회성 클리어), cold/warm/미로그인 보류 3경로.
- [x] 단위 테스트 + 시뮬레이터 게이트, 실기기 재확인 [manual]. 상세: issue #487 본문(패킷 겸용).
- 랜딩: PR #489 squash(2026-07-18). worker capacity 중단→커밋 보존 인수, 오케스트레이터 보완 1건(import MomoCore). 킷 22/22+시뮬레이터 게이트 PASS. 실기기 재확인 [manual] 대기.

### ☑ MOMO-470 (`#491`) 수용기준 — V-2 compose LiveKit + 실 JWT 수락 `[infra]` · 의존: MOMO-468
- [x] compose `huddle` profile로 livekit 옵트인(버전 핀·포트·healthcheck·UDP 제한), env.example/RUN/DEPLOY 델타(TURN은 도메인 확보 시 노트).
- [x] `verify_huddle_livekit.sh`: V-1 join JWT를 실 LiveKit `/rtc/validate` 200 수락 + 무효 거부, teardown. e2e compose 무접촉. 상세: issue #491 본문(패킷 겸용).
- 랜딩: PR #492 squash `5bab0d2`(2026-07-18). 오케스트레이터: 핀 v1.9.0→v1.13.3 교정 + 실기동 검증 PASS(실 LiveKit이 V-1 JWT 200 수락/무효 401 거부, 스택 회수 확인). 앞선 타임아웃 2회는 Docker Desktop pull 전역 불능(재시작으로 해소, momo 무관).

### ☑ MOMO-471 (`#493`) 수용기준 — V-3 macOS 허들 UI `[swift/macos-ui]` · 의존: MOMO-470 (UX 병행 — 파일 스코프 계약)
- [x] 헤더 최소 삽입+정적 live 배지, MomoHuddle* 신규 파일군(livekit swift SDK 핀, 오디오만), 수명주기 leave/disconnect 보장, 503 미구성 상태 포함 4종.
- [x] MessageListView/ChannelListView/MomoMacDevApp* 무접촉(UX 활성 영역). 스냅샷 RECORD 금지. 실오디오 왕복은 오케스트레이터. 상세: issue #493 본문(패킷 겸용).
- 랜딩: PR #494 squash `ad983ee`(2026-07-18). 블로커 정당(전방호환 결함 발견)→스코프 A 확장 재개. macos-ui 게이트 336테스트 중 huddle/Core 34 PASS, 유일 실패=workspaceSearch 선재 flake(V-3 무관, MOMO-472 분리). 실오디오 2클라 왕복은 성재 협업 검증 대기.

### ☐ MOMO-472 (`#495`) 수용기준 — workspaceSearch 스냅샷 full-suite 비결정성 안정화 `[macos-ui]` · 의존: 없음 (선재 flake)
- [ ] full `make test` 3회 연속 통과(결정적 렌더 조건 이관 또는 perceptual 미세조정, 근거 기록). 캐노니컬 재기록은 오케스트레이터. 상세: issue #495.

### ☑ MOMO-473 (`#496`) 수용기준 — V-3b iOS 허들 참가 `[ios]` · 의존: MOMO-471 · **PR base=track/engine**
- [x] 진행 중 허들 배너(active+Core 이벤트 실시간, 정적 표기) + 참가 시트(청취/발화/음소거/나가기, LiveKit 2.15.2 핀) + 수명주기 leave/disconnect 보장.
- [x] 마이크 권한 문구/거부 상태, 503 미구성 처리, 뷰모델 mock 테스트. 시뮬레이터 게이트는 오케스트레이터. 상세: issue #496 본문(패킷 겸용).
- 랜딩: PR #498 squash `0176508` → **track/engine**(2026-07-18, 새 파이프라인 첫 트랙 머지 — main 미반영, 성재 게이트 대기). 킷 27/27+시뮬레이터 게이트 PASS, LiveKit 2.15.2 핀·마이크 권한·수명주기 정리 확인.

### ☑ MOMO-474 (`#497`) 수용기준 — 첨부 업로드 v0 (Drive archive) `[runtime-db]` · 의존: SA 실검증 완료 · **PR base=track/engine**
- [x] 017_attachment(RLS) + 세션 발급(resumable, 클라 직송)/complete 검증/content 프록시/전송 DTO attachmentIds 가산.
- [x] DriveArchiveClient(실+stub, drive.file) + verify_attachment_upload(stub) + runtime-db 편입 + openapi. 실 Google smoke는 오케스트레이터. 상세: issue #497 본문(패킷 겸용). ENGINE_HANDOFF B-1→in-progress, 랜딩 시 A-6 해제.
- 랜딩: PR #499 squash `6d4dd97` → **track/engine**(2026-07-18, main 대기). 검증: 첨부 verifier(stub)+서버 107/107+openapi 48/48+**실 Google 왕복 smoke PASS**(resumable→클라 직송 PUT→files.get→alt=media, 정리 완료). 게이트 유일 실패=english-large-text full-suite flake(server 전용 PR·macOS 무관 = 선재, MOMO-472로 확장).

### ☐ MOMO-475 (`#500`) 수용기준 — 검색 서버 FTS v0 (메시지) `[runtime-db]` · 의존: 없음 · **PR base=track/engine**
- [x] GET search/messages — 멤버십 하드 필터(비멤버 0)/deleted 제외/ILIKE+trgm/최신순/seq 키셋 커서/snippet 절단+matchOffset/q≥2/멤버 rate limit.
- [x] openapi + verify_workspace_search(멤버십·DM·삭제·한영·커서 안정·429·RLS·EXPLAIN trgm) + runtime-db 편입. 상세: issue #500 본문(패킷 겸용). B-2 done→A-7 ready.

### ☐ ADR-gated 후속 — Multi-workspace + Interactive Work Console
- [ ] ADR-0117이 account/session/token/server identity persistence와 switch semantics를 Accepted로 결정하기 전 multi-workspace rail 구현 금지.
- [ ] MOMO-375는 `Control+backtick` transcript/activity drawer까지만 계획. command input·PTY/process·cwd/worktree·Codex/Claude/OpenCode session은 ADR-0114 Accepted 후 새 numeric builder로 발급.
- [ ] momo 서버는 user-owned execution host의 process/provider credential을 보관하거나 proxy하지 않음.

---

> **정합 원칙:** 이전 티켓이 만든 파일/패키지를 깨지 말 것. 스펙·`schema_v0.sql`과 정합.
> SwiftPM 의존성은 최신 안정 태그로 resolve. 스텁은 `// TODO` 명시.
# MOMO-447 macOS dogfood interaction shells completion

- [x] local attachment picker/DnD/chip UX (durable upload adapter pending)
- [x] demo/local profile draft editing + real-server read-only profile surface
- [x] approval inspector hierarchy/action strip
- [x] `⌘F` workspace search over loaded channel/member/message/file metadata
- [x] searchable DM member picker using the existing DM mutation path
- [x] persistent local plugin selection preview for Drive/Calendar/Gmail/GitHub/Notion
- [ ] engine handoff: attachment storage, persistent profile API, server FTS, plugin registry/grant/OAuth
