# momo — 로컬 기동 가이드 (RUN.md)

> **이 환경의 현실 (반드시 먼저 읽기).**
> 로컬 검증 기준으로 **Swift 6.2.3, Docker Desktop, PostgreSQL 18 client(psql)는 있다. hermes 게이트웨이는 없다.**
> 따라서:
> - **모든 Swift 패키지는 `swift build`로 컴파일이 검증된다 (green).**
> - **DB·실시간 런타임은 Docker Desktop으로 검증 가능하다.**
> - **에이전트 hermes SSE 경로만 실제 hermes 또는 OpenAI-compatible mock이 필요하다.**
>
> 즉 **`swift build`가 통과한다고 해서 서버/relay/worker가 "돈다"는 뜻은 아니다.**
> 실제 기동은 **PostgreSQL 18 + Centrifugo v6**(+ 에이전트 데모는 hermes 게이트웨이)가
> 떠 있어야 한다. 이 둘은 `infra/docker-compose.yml`로 한 번에 띄운다.
> docker/psql이 없는 머신에서는 빌드/정적 점검 단계까지만 수행 가능하다.

이 문서는 momo v0를 **로컬에서 처음부터 끝까지 기동**하는 순서를 정리한다.
정본 스펙은 [`research/07-deepdive/04-self-build-l4-spec.md`](../research/07-deepdive/04-self-build-l4-spec.md),
정본 스키마는 [`schema_v0.sql`](../schema_v0.sql), 데모 타깃은
[`research/07-deepdive/05-agent-native-experiences.md`](../research/07-deepdive/05-agent-native-experiences.md) 참고.

---

## 0. 사전 요구

| 요구 | 확인 | 비고 |
|---|---|---|
| **Swift 6.2** | `swift --version` → `6.2.x` | `.swift-version` = `6.2`. 빌드 게이트의 전제. |
| **Docker + Docker Compose v2** | `docker compose version` | `make up`이 사용. MOMO-001/002에서 Docker Desktop 기준 검증됨. |
| **psql (PostgreSQL 18 client)** | `psql --version` | `make migrate`(`scripts/migrate.sh`)가 사용. Homebrew `libpq` 경로도 자동 감지. |
| **hermes 게이트웨이** | (외부) | 에이전트 Live Tool-Call 데모(D)에만 필요. 없어도 D 외 경로는 동작. |

> Postgres / Centrifugo는 별도 설치할 필요 없다 — `make up`이 컨테이너로 띄운다.
> 단 **마이그레이션 러너는 호스트의 `psql`을 호출**하므로 psql 클라이언트는 별도 설치가 필요하다
> (또는 컨테이너 안에서 `psql`을 실행하도록 변형 — 5장 참고).

---

## 1. 기동 순서 (한눈에)

```
(1) cp infra/.env.example .env   →  값 채움                # 환경변수
(2) make up                      →  docker compose up      # PG18 + Centrifugo v6
(3) make migrate                 →  scripts/migrate.sh     # schema + 데모 시드
(4) swift run … MomoServer       →  Hummingbird API :8080  # REST + JWT + publish proxy
(5) swift run … OutboxRelay      →  outbox → Centrifugo    # 쓰기경로 fan-out
    swift run … AgentWorker      →  agent_job → hermes     # 에이전트 턴 (D 데모)
(6) make build  /  swift run MomoMacSmoke                  # macOS 클라(데모 surface)
```

의존성: **DB·Centrifugo(2) → 마이그레이션(3) → 서버(4) → relay/worker(5)**.
relay/worker는 DB와 Centrifugo에만 의존하므로 서버와 **병렬 기동**해도 무방하지만,
스키마(`outbox` 테이블 등)가 먼저 적용돼 있어야 한다.

> **빌드만 검증할 때(docker/psql 없음):** (1)에서 멈추지 말고 바로 `make build`로
> 전 Swift 패키지 컴파일을 확인하고, `python3 -m py_compile adapters/hermes/momo_adapter.py`로
> hermes 어댑터를 정적 점검하면 된다. (2)~(5)의 런타임은 `runtime-unverified`.

### 1.1 MOMO-240 Local Alpha Runner

`scripts/local_alpha_runner.sh`는 위 수동 순서를 내부 알파용 한 흐름으로 묶는다. 기본 evidence는
repo 밖 `${TMPDIR:-/tmp}/momo-local-alpha/<UTC timestamp>/`에 생성되며, 실행 후 `summary.md`에
확인할 URL, redacted env, 로그 파일, stop command가 남는다. **AWS 리소스는 만들지 않는다.**

```sh
# dry-run/plan: 아무 프로세스도 띄우지 않고 실행 계획만 출력
scripts/local_alpha_runner.sh plan
make local-alpha-plan

# execute: PG18+Centrifugo → migrate/RLS prep → mock Hermes → server/relay/worker → macOS smoke
scripts/local_alpha_runner.sh execute --hermes mock
make local-alpha
```

실제 외부 Hermes를 쓰려면 secret env 파일을 **절대경로로, repo 밖에** 둔다. runner는 repo 내부
secret env 경로를 거부한다.

```sh
scripts/local_alpha_runner.sh execute \
  --hermes external \
  --secret-env "$HOME/.momo/local-alpha.env"
```

필수/권장 키는 `infra/.env.example`와 동일하다. 외부 Hermes 모드에서는 최소
`HERMES_BASE_URL`/`HERMES_API_KEY`가 필요하며, placeholder 키(`change-me-*`)는 거부한다.
mock 모드에서 `--secret-env`를 생략하면 runner가 dev-only env를 evidence 디렉터리에 생성한다.

실행 성공 시 대표 출력:

```text
MomoServer: http://127.0.0.1:<PORT>/health
Centrifugo: ws://127.0.0.1:<CENT_PORT>/connection/websocket
mock Hermes: http://127.0.0.1:<HERMES_PORT>/health
macOS dev launch: swift run --package-path clients/macOS MomoMacSmoke
evidence summary: /tmp/.../summary.md
logs: /tmp/.../logs
stop: /tmp/.../stop-local-alpha.sh
```

Centrifugo 컨테이너의 subscribe proxy는 local alpha 실행 중 host-run `MomoServer`를 호출해야 하므로
runner가 evidence 디렉터리에 임시 Centrifugo config/compose override를 생성한다. macOS Docker
Desktop 기본값은 `host.docker.internal`이며, 필요하면 `--api-proxy-host <host>`로 바꾼다.

현재 `main`의 macOS dev surface는 Xcode `.app`이 아니라 SwiftPM `MomoMacSmoke`다. 따라서 runner는
실행 가능한 dev launch command로 `swift run --package-path clients/macOS MomoMacSmoke`를 출력한다.
Xcode `.app` 번들 런치는 M4/C1 이후 같은 runner에 추가한다.

---

## 2. 환경변수 (`.env`)

`infra/.env.example`를 복사해 `.env`로 만들고 값을 채운다. `.env`는 `.gitignore`에 등록돼
있어 커밋되지 않는다. **하나의 `.env`가 docker-compose · 마이그레이션 러너 · 서버 · relay ·
worker를 모두 구동**한다(키 이름이 전 컴포넌트에서 일치).

```sh
cp infra/.env.example .env
# 시크릿은 직접 생성 권장:  openssl rand -hex 32
```

### 2.1 `.env.example`에 정의된 키 (필수/핵심)

| 키 | 쓰는 곳 | 의미 |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | compose, 서버/relay/worker | PG18 컨테이너 부트스트랩 + 폴백 접속 정보. |
| `POSTGRES_PORT` | compose, 서버/relay/worker | 호스트 노출 포트(기본 5432). |
| `DATABASE_URL` | 서버, relay, worker, `migrate.sh` | `postgres://user:pass@host:port/db`. 우선 파싱됨. **컨테이너 내부는 host=`postgres`, 호스트(로컬)에서 직접 실행 시 host=`localhost`.** |
| `CENT_PORT` | compose | Centrifugo WS/HTTP API 포트(기본 8000). |
| `CENT_TOKEN_HMAC` | 서버, Centrifugo | 클라 connection/subscription JWT 서명용 HMAC 시크릿(§7.1). |
| `CENT_API_KEY` | 서버, relay, worker, Centrifugo | 서버측 HTTP API(`POST /api/publish`) 인증 키(`X-API-Key`). relay/worker만 publish(§4.3). |
| `CENT_API_URL` | 서버, relay, worker | publish 대상 Centrifugo API 엔드포인트(컨테이너 내부 `http://centrifugo:8000/api`). |
| `JWT_HMAC` | 서버 | App access(15m)/refresh(30d) 토큰 HS256 서명 시크릿(§7.1). |
| `HERMES_BASE_URL` | worker | hermes OpenAI 호환 게이트웨이 베이스(`/v1`). |
| `HERMES_API_KEY` | worker | hermes Bearer 토큰. |

### 2.2 코드가 추가로 읽는 선택적 키 (모두 안전한 기본값 있음 → `.env`에 없어도 부팅)

> 아래는 `.env.example`에는 의도적으로 넣지 않은 **튜닝/오버라이드 키**다. 설정하지 않으면
> 코드의 dev-safe 기본값으로 동작한다(`runtime-unverified` 환경에서도 프로세스가 부팅되도록).

| 키 | 컴포넌트 | 기본값 | 의미 |
|---|---|---|---|
| `HOST` | 서버 | `0.0.0.0` | HTTP 바인드 호스트. |
| `PORT` | 서버 | `8080` | HTTP 바인드 포트. **Centrifugo subscribe proxy가 `api:8080`을 콜백**하므로 변경 시 `centrifugo.json`도 맞춰야 함. |
| `POSTGRES_HOST` | 서버/relay/worker | `localhost` | `DATABASE_URL` 미설정 시 폴백 호스트. |
| `LOG_LEVEL` | 서버 | (info) | 로그 레벨. |
| `RELAY_DATABASE_URL` | relay/worker | (= `DATABASE_URL`) | relay/worker 전용 **BYPASSRLS `momo_relay`** 접속(§2.2/§10.1). 설정 시 우선. |
| `RELAY_POSTGRES_USER` / `RELAY_POSTGRES_PASSWORD` | relay/worker | (= `POSTGRES_*`) | 위와 동일 목적의 분리 자격증명. |
| `RELAY_POLL_INTERVAL_MS` | relay | `300` | outbox 폴링 주기(§8.1 fallback 300ms). |
| `RELAY_CLAIM_BATCH` | relay | `64` | 1회 클레임 행 수. |
| `RELAY_MAX_ATTEMPTS` | relay | `8` | 초과 시 `status='failed'`. |
| `WORKER_POLL_INTERVAL_MS` | worker | `300` | agent_job 폴링 주기. |
| `WORKER_MAX_ATTEMPTS` | worker | `8` | 초과 시 `status='failed'`. |
| `MAX_CONSECUTIVE_AUTO` | worker | `3` | 루프가드 G2(연속 자동응답). |
| `MAX_STEPS` | worker | `12` | 루프가드 G3(턴당 tool-call 상한, 스키마 50의 v0 오버라이드). |
| `MAX_DEPTH` | worker | `4` | A2A 홉 깊이 상한(§3.4). |
| `MAX_CONCURRENT_RUNS` | worker | `1` | 에이전트별 세마포어 G1. |

> **보안:** `.env.example`의 `change-me-*` / 코드의 `dev-insecure-*` 기본값은 **개발용**이다.
> 실배포에선 반드시 교체(`openssl rand -hex 32`). 기본값으로도 부팅은 되지만 안전하지 않다.

---

## 3. 인프라 기동 — `make up` (PostgreSQL 18 + Centrifugo v6)

```sh
make up            # = docker compose -f infra/docker-compose.yml up -d
```

- `postgres` (image `postgres:18`): SoT. native `uuidv7()`. healthcheck = `pg_isready`.
- `centrifugo` (image `centrifugo/centrifugo:v6`): transport only(메모리 엔진). `infra/centrifugo.json` 마운트.
  subscribe proxy 콜백 = `http://api:8080/v1/centrifugo/subscribe`, 채널 = `ch:ws<workspaceUUID>.<channelUUID>`.

상태 확인:

```sh
docker compose -f infra/docker-compose.yml ps        # 두 서비스 모두 healthy 대기
docker compose -f infra/docker-compose.yml logs -f
```

중지: `make down`. 데이터까지 지우려면 `docker compose -f infra/docker-compose.yml down -v`
(볼륨 `momo-pgdata` 삭제).

> **검증됨:** MOMO-001/002에서 Docker Desktop 기준 PG18+Centrifugo v6 health, migrate 멱등,
> server health, 메시지 송신, OutboxRelay→Centrifugo publish/history를 확인했다.

---

## 4. 마이그레이션 — `make migrate`

스키마 + 데모 시드를 **번호순**으로 적용한다(`server/Migrations/*.sql`).

```sh
export DATABASE_URL=postgres://momo:<pw>@localhost:5432/momo   # .env와 동일 값
make migrate                                                   # = sh scripts/migrate.sh
```

- 적용 대상(현재): `001_init.sql`(정본 스키마 + 보강 — outbox/cost/APNs), `002_seed.sql`(데모 시드).
- `scripts/migrate.sh`는 `schema_migrations` 테이블로 적용 이력을 추적 → **멱등 재실행 안전**
  (이미 적용된 버전은 SKIP). 각 파일은 `--single-transaction`으로 원자 적용.
- 연결: `DATABASE_URL` 우선, 없으면 표준 `PG*` 환경변수(`PGHOST`/`PGUSER`/…) 폴백.

`psql`이 없으면 스크립트는 **실패하지 않고** 안내(적용 대상 목록)만 출력하고 0으로 종료한다
(CI/로컬 친화). 즉 `make migrate` 자체는 psql 부재 환경에서도 깨지지 않는다.

> **검증됨:** MOMO-001/002에서 `make migrate` 재실행 시 `적용 0, 스킵 2`로 멱등 통과.

### 4.1 psql 없이 컨테이너 안에서 적용 (대안)

호스트에 psql을 깔기 싫다면 컨테이너의 psql을 쓸 수 있다:

```sh
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U momo -d momo -v ON_ERROR_STOP=1 < server/Migrations/001_init.sql
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U momo -d momo -v ON_ERROR_STOP=1 < server/Migrations/002_seed.sql
```

(이 경로는 `schema_migrations` 추적을 우회하므로 1회성 부트스트랩 용도. 평상시엔 `make migrate` 권장.)

---

## 5. 서비스 기동 (Swift 실행 바이너리)

Makefile에는 `build`/`test`/`up`/`down`/`migrate`만 있고 **서비스 실행 타깃은 없다** —
서비스는 각 패키지에서 `swift run`으로 직접 띄운다(데모 중 코드 수정·재기동이 잦으므로 의도적).
세 개를 **별도 터미널**에서 띄운다. 모두 **`.env`의 값이 환경에 export**돼 있어야 한다.

```sh
# 공통: .env 로드 (zsh/bash)
set -a; . ./.env; set +a
```

### 5.1 API 서버 — `MomoServer` (Hummingbird 2, :8080)

```sh
swift run --package-path server MomoServer
```

- REST(`/v1/auth/login`, 메시지 송수신) + JWT 발급 + Centrifugo publish/subscribe-proxy.
- **핵심 쓰기경로(§1.2 / v0):** `REST send → (channel_seq bump + message insert + outbox insert) 단일 tx`.
  실제 fan-out은 relay가 담당(아래).
- 기본 바인드 `0.0.0.0:8080`. **`PORT` 변경 시 `infra/centrifugo.json`의 subscribe proxy URL(`api:8080`)도 함께 변경.**

### 5.2 Outbox Relay — `OutboxRelay`

```sh
swift run --package-path relay/OutboxRelay OutboxRelay
```

- `outbox`(kind=`broadcast`) 행을 `SELECT … FOR UPDATE SKIP LOCKED`로 클레임 →
  Centrifugo `POST /api/publish`(version=seq, idempotency_key) → `status='done'`.
- **BYPASSRLS `momo_relay` 역할**로 전 테넌트 폴링(§2.2/§10.1) → `RELAY_DATABASE_URL` 또는
  `RELAY_POSTGRES_USER/PASSWORD`로 분리 자격증명 권장.
- 이 프로세스가 떠 있어야 메시지가 클라로 **실시간 전달**된다(commit↔publish 무손실 보장계층).

### 5.3 Agent Worker — `AgentWorker` (데모 D: Live Tool-Call)

```sh
swift run --package-path workers/AgentWorker AgentWorker
```

- `outbox`(kind=`agent_job`)를 SKIP LOCKED로 클레임(partition_key = agent_member_id, 에이전트별 직렬화).
- hermes `POST /v1/chat/completions`(`stream=true`) SSE 중계 → `agent.partial`/`agent.status` publish.
  비스트리밍 폴백 포함(§6.3). 루프가드 G1~G3 + A2A depth(§3.3/§3.4).
- **hermes 게이트웨이가 떠 있어야** 에이전트 턴이 실제로 동작(D 데모). `HERMES_BASE_URL`/`HERMES_API_KEY`.

> **검증됨/미검증 구분:** MomoServer + OutboxRelay는 MOMO-001/002에서 DB·Centrifugo 실연결 검증됨.
> AgentWorker↔OpenAI-compatible SSE + 비용 reserve/reconcile은 MOMO-004에서
> `scripts/mock_hermes.py`와 `scripts/verify_agent_worker.sh`로 검증한다.

#### 5.3.1 MOMO-004 AgentWorker 런타임 게이트

실제 hermes가 없을 때는 repo-local mock gateway를 사용한다. 이 스크립트는
`make up && make migrate` 이후 실행하며, `momo_worker` BYPASSRLS role 준비,
멘션 fixture → `agent_job` outbox 생성, mock SSE 수신, Centrifugo history의
`agent.partial`, `usage_ledger`, `budget_window`, low-limit G5 circuit breaker를
한 번에 확인한다.

```sh
make up
make migrate
scripts/verify_agent_worker.sh
```

수동으로 mock만 띄우려면:

```sh
python3 scripts/mock_hermes.py --host 127.0.0.1 --port "${HERMES_PORT:-8088}"
```

---

## 6. macOS 클라이언트 (데모 surface: D / B / C)

macOS 패키지(`clients/macOS`)는 v0에서 **SwiftUI 라이브러리 + 빌드검증 smoke 실행파일**로
구성된다(전체 `.app` 번들 + SwiftCentrifuge/AsyncHTTPClient 트랜스포트는 후속 작업).
데모 경험 **D(Live Tool-Call) / B(비용 호흡) / C(승인 인박스)**는 이 라이브러리의 뷰가 surface다.

```sh
# 라이브러리 + smoke 컴파일 검증
swift build --package-path clients/macOS

# 헤드리스 smoke 실행(모델/인메모리 백엔드 라운드트립 — DB/Centrifugo/hermes 불필요)
swift run --package-path clients/macOS MomoMacSmoke
```

- `MomoMac`(library): `MomoCore`의 `ChatBackend`/`AgentTransport` 계약 위에 SwiftUI 뷰 + `LiveChatBackend` 스텁.
- `MomoMacSmoke`(exe): `MomoCore` + `MomoMac` import → 도메인 모델·인메모리 백엔드 구동을 출력해 **링크/컴파일을 증명**.
- smoke는 인메모리만 쓰므로 **런타임 의존이 없다**(여기 단계는 `runtime-verified` 가능).
  실제 서버에 붙는 라이브 트랜스포트는 후속 티켓에서 `.app`과 함께 추가.

---

## 7. hermes 어댑터(에이전트 1급 멤버화) — 선택

`adapters/hermes/`는 hermes 게이트웨이 플러그인(`MomoAdapter`)으로, 에이전트를 webhook 봇이
아닌 momo `member`(kind=`agent`)로 만든다(§6.3). **게이트웨이 안에서만** 동작한다.

```sh
# 정적 점검(이 환경에서 가능한 전부)
python3 -m py_compile adapters/hermes/momo_adapter.py

# 게이트웨이 환경에 의존성 설치
pip install -r adapters/hermes/requirements.txt
```

env(`MOMO_API_URL`, `MOMO_CENTRIFUGO_WS_URL`, `MOMO_AGENT_EMAIL/PASSWORD` 등)는
`adapters/hermes/README.md` 및 `plugin.yaml`의 `spec.env` 참고.

> **`runtime-unverified (hermes 게이트웨이 필요)`** — 게이트웨이/실행 momo 스택 없이는
> end-to-end 미검증. `py_compile` 정적 점검만 수행됨.

---

## 8. Makefile 타깃 ↔ 실제 커맨드 정합

| 타깃 | 실제 커맨드 | 검증 가능성 |
|---|---|---|
| `make build` | `SWIFT_PKGS` 중 `Package.swift` 있는 패키지 각각 `swift build` (Core/server/relay/worker/macOS) | **build-verifiable** (Swift 6.2 있음) |
| `make test` | 동일 패키지 각각 `swift test` | build-verifiable |
| `make migrate` | `sh scripts/migrate.sh` → `psql`로 `server/Migrations/*.sql` 번호순 적용 | runtime-verifiable; MOMO-001/002에서 pass |
| `make up` | `docker compose -f infra/docker-compose.yml up -d` | runtime-verifiable; MOMO-001/002에서 pass |
| `make down` | `docker compose -f infra/docker-compose.yml down` | runtime-verifiable |

- 서비스 실행(`MomoServer`/`OutboxRelay`/`AgentWorker`/`MomoMacSmoke`)은 Makefile 타깃이 아니라
  **5·6장의 `swift run … <Executable>`로 직접** 띄운다.
- `make build`/`make test`는 **`Package.swift`가 실제로 존재하는 패키지만** 순회하므로,
  일부 패키지가 없어도 안전하게 동작한다.

---

## 9. 트러블슈팅

| 증상 | 원인/조치 |
|---|---|
| `make up` 실패: `docker: command not found` | Docker Desktop 설치/기동 필요. docker/psql 없는 머신에서는 해당 runtime goal을 닫지 말고 `runtime-unverified`로 남긴다. |
| `make migrate`가 "psql 을 찾을 수 없습니다" 출력 후 종료 | psql 미설치. 적용 대상만 나열하고 비-실패 종료. psql 설치 후 재실행하거나 §4.1 컨테이너 경로 사용. |
| 메시지가 클라에 실시간 전달 안 됨 | `OutboxRelay` 미기동. 서버는 commit만 하고 fan-out은 relay 담당. relay 로그 확인. |
| 에이전트가 응답 안 함(D 데모) | `AgentWorker` 미기동 또는 hermes 게이트웨이 미연결. `HERMES_BASE_URL`/`HERMES_API_KEY` 확인. |
| Centrifugo HTTP API 401 | compose가 `CENTRIFUGO_HTTP_API_KEY=${CENT_API_KEY}`로 주입되는지 확인. Centrifugo v6는 일반 JSON `"${CENT_API_KEY}"`를 치환하지 않는다. |
| Centrifugo subscribe 거부 | `centrifugo.json`의 `channel.proxy.subscribe.endpoint`(`api:8080`)과 서버 `PORT` 불일치, 또는 `CENT_TOKEN_HMAC` 불일치. |
| RLS로 행이 안 보임 | 서버는 트랜잭션마다 `SET LOCAL app.workspace_id` 필요. relay/worker는 BYPASSRLS 역할(`momo_relay`)인지 확인. |

---

## 10. 빠른 참조

```sh
# --- 빌드/정적 점검만 (docker/psql 없는 환경에서 가능한 전부) ---
make build
swift build --package-path clients/macOS && swift run --package-path clients/macOS MomoMacSmoke
python3 -m py_compile adapters/hermes/momo_adapter.py

# --- 전체 런타임 기동 (PG18 + Centrifugo v6 환경) ---
cp infra/.env.example .env       # 값 채움 (openssl rand -hex 32)
set -a; . ./.env; set +a
make up                          # PG18 + Centrifugo v6
make migrate                     # 스키마 + 데모 시드
swift run --package-path server MomoServer                 # 터미널 1
swift run --package-path relay/OutboxRelay OutboxRelay     # 터미널 2
swift run --package-path workers/AgentWorker AgentWorker   # 터미널 3 (D 데모, hermes 필요)
```
