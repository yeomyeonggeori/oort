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

### ☐ MOMO-341 수용기준 — Gateway pending durable claim/lease `[swift/runtime-agent]` · 의존: MOMO-337, MOMO-338
> MOMO-338 성능 리뷰 후속. 현재 pending endpoint는 actor-bound read지만 lease/claim이 없어 동일 agent의 gateway 인스턴스가 겹치면 provider turn과 비용이 중복될 수 있다.
- [ ] [swift/sql] pending job에 단일 owner lease와 만료/takeover 계약을 추가한다. `schema_v0.sql`은 수정하지 않고 신규 migration을 사용한다.
- [ ] [swift] claim은 `FOR UPDATE SKIP LOCKED` 또는 동등한 원자 경로이며, lease owner가 아닌 callback/renew/release는 fail-closed한다.
- [ ] [runtime] 두 gateway consumer가 같은 agent를 동시에 claim해도 provider execution은 한 번만 시작된다.
- [ ] [runtime] consumer crash 후 lease expiry/takeover로 job이 영구 pending에 남지 않는다.
- [ ] [security] bearer actor binding, Postgres SoT, REST-only callback, provider credential boundary를 유지한다.

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

### ☐ MOMO-348 수용기준 — macos-ui real backend verifier isolated DB boundary `[tooling/macos-ui]` · 의존: MOMO-346
- [ ] `verify_macos_real_backend_ui.sh`가 MOMO-344/345 패턴의 격리 DB와 marker-bound role을 사용하고 demo/hermes fixture를 자체 seed한다.
- [ ] login/invite/join/member/send/mention→agent_job/history assertion이 fresh 격리 DB에서 PASS하고 dogfood DB에 mutation을 남기지 않는다 (digest 전후 동일).
- [ ] root main persistent dogfood DB drift와 무관하게 `macos-ui` full gate가 root main에서 PASS한다.
- [ ] clean gate + root post-merge gate evidence, 정본 3종 갱신.

---

> **정합 원칙:** 이전 티켓이 만든 파일/패키지를 깨지 말 것. 스펙·`schema_v0.sql`과 정합.
> SwiftPM 의존성은 최신 안정 태그로 resolve. 스텁은 `// TODO` 명시.
