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
