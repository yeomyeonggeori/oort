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

팀원이 내부 alpha를 바로 따라 할 때는 [`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md)를 먼저 본다.
그 문서는 local tools/env/gate 순서, `MomoMacDevApp` 실행, seeded 계정/채널/김인턴 assumptions,
초대/자가가입, diagnostics bundle, bug report template, known limitations를 한 흐름으로 묶은 실행 런북이다.

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
(6) make build  /  swift run MomoMacDevApp                 # macOS 클라(개발용 window)
```

의존성: **DB·Centrifugo(2) → 마이그레이션(3) → 서버(4) → relay/worker(5)**.
relay/worker는 DB와 Centrifugo에만 의존하므로 서버와 **병렬 기동**해도 무방하지만,
스키마(`outbox` 테이블 등)가 먼저 적용돼 있어야 한다.

> **빌드만 검증할 때(docker/psql 없음):** (1)에서 멈추지 말고 바로 `make build`로
> 전 Swift 패키지 컴파일을 확인하고, `python3 -m py_compile adapters/hermes/momo_adapter.py`로
> hermes 어댑터를 정적 점검하면 된다. (2)~(5)의 런타임은 `runtime-unverified`.

내부 alpha smoke의 권장 순서는 `make up` -> `make migrate` -> `MomoServer`/`OutboxRelay`
-> mock Hermes + `AgentWorker` -> `MomoMacDevApp` real-server mode다. 세부 명령은
[`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md) §2~§6을 따른다.

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
| `AGENT_PROVIDER_MODE` | 서버, worker | `local-mock` / `internal-host-mock` / `external-hermes`. staging/prod/internal-host는 `external-hermes`만 허용. |
| `AGENT_MODEL` | 서버, worker | 김인턴 provider model label(기본 `hermes-agent`). |
| `AGENT_HANDLE` / `AGENT_DISPLAY_NAME` | 서버, macOS 표시 | status surface 표시용 agent identity(기본 `kim-intern` / `김인턴`). |
| `HERMES_BASE_URL` | 서버, worker | hermes OpenAI 호환 게이트웨이 베이스(`/v1`). 서버는 health/status projection에 redacted label만 노출. |
| `HERMES_API_KEY` | 서버, worker | hermes Bearer 토큰. health/status/log/diagnostics에는 원문 노출 금지. |
| `EXTERNAL_AGENT_PROVIDER_ENV_FILE` | `scripts/verify_external_agent_provider.sh` | 선택. 외부 Hermes/Kim Intern credentials만 담은 untracked env 파일. `.env.worktree`의 local stack ports를 유지하면서 provider secret만 override할 때 사용. |

### 2.2 코드가 추가로 읽는 선택적 키 (모두 안전한 기본값 있음 → `.env`에 없어도 부팅)

> 아래는 `.env.example`에는 의도적으로 넣지 않은 **튜닝/오버라이드 키**다. 설정하지 않으면
> 코드의 dev-safe 기본값으로 동작한다(`runtime-unverified` 환경에서도 프로세스가 부팅되도록).

| 키 | 컴포넌트 | 기본값 | 의미 |
|---|---|---|---|
| `HOST` | 서버 | `0.0.0.0` | HTTP 바인드 호스트. |
| `PORT` | 서버 | `8080` | HTTP 바인드 포트. **Centrifugo subscribe proxy가 `api:8080`을 콜백**하므로 변경 시 `centrifugo.json`도 맞춰야 함. |
| `POSTGRES_HOST` | 서버/relay/worker | `localhost` | `DATABASE_URL` 미설정 시 폴백 호스트. |
| `LOG_LEVEL` | 서버 | (info) | 로그 레벨. |
| `CENT_CONNECTION_TOKEN_TTL_SECONDS` | 서버 | `300` | `/v1/auth/realtime-token` Centrifugo connection JWT TTL. dev 값은 60~1800초로 clamp된다. |
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

### 2.1.1 Kim Intern/Hermes provider mode

김인턴 provider boundary는 `AGENT_PROVIDER_MODE`가 정본이다.

| mode | 사용처 | 허용 provider config | 사용자 표시 |
|---|---|---|---|
| `local-mock` | 개발자 로컬 | `HERMES_BASE_URL=http://localhost:<port>/v1`, placeholder key 허용 | `mock` |
| `internal-host-mock` | `infra/prod/internal-smoke.env.example`, `host-runtime` verifier | `http://mock-hermes:8088/v1`, placeholder key 허용 | `mock` |
| `external-hermes` | staging/prod/internal-host | `https://.../v1` + non-placeholder `HERMES_API_KEY` 필수 | `available` 또는 `degraded` |

`staging`/`prod`/`internal-host`에서 `local-mock`/`internal-host-mock`, localhost/mock URL,
placeholder key가 보이면 MomoServer/AgentWorker boot와 `scripts/prod_env_preflight.sh`가 fail-fast한다.
`GET /health`와 `GET /v1/agent-runtime/status`는 `agentRuntime` projection을 제공하지만
`endpointLabel`은 user/password/query/fragment를 제거한 값이고 provider token은 절대 포함하지 않는다.
macOS sidebar의 Kim Intern chip은 이 projection으로 `Available` / `Degraded` / `Mock`을 표시하고,
internal alpha 사용자에게 `Local mock` / `Internal host mock` / `External Hermes`, key 준비 여부,
redacted endpoint/diagnostic hint를 구분해 보여준다.

실제 외부 Hermes/Kim Intern side effect는 기본 local gate에 포함하지 않는다. credentials가 있는
환경에서만 아래 opt-in smoke를 실행한다.

```sh
# stack ports/DB/Centrifugo는 .env.worktree를 사용하고 provider secret은 shell로 주입
AGENT_PROVIDER_MODE=external-hermes \
HERMES_BASE_URL=https://hermes.example.com/v1 \
HERMES_API_KEY=... \
scripts/local_gate.sh --profile external-agent-provider

# 또는 provider secret만 별도 untracked 파일로 분리
EXTERNAL_AGENT_PROVIDER_ENV_FILE=/secure/momo/external-hermes.env \
scripts/local_gate.sh --profile external-agent-provider
```

`scripts/verify_external_agent_provider.sh`는 먼저 external env contract를 검사한다.
`AGENT_PROVIDER_MODE`가 없거나 `external-hermes`가 아니면 mock 기본 환경으로 보고
`runtime-unverified(external provider credentials)` evidence를 남기고 종료한다. 반대로
`external-hermes`를 명시했는데 URL이 `https://`가 아니거나 localhost/mock/placeholder key면
fail-fast한다. credentials가 유효하면 OpenAI-compatible SSE preflight, local
MomoServer/AgentWorker/OutboxRelay boot, `/v1/agent-runtime/status` redaction, `@김인턴`
1왕복까지 시도한다. API key는 stdout/evidence/log redacted artifact에 출력하지 않는다.

### 2.3 staging/prod 시크릿과 백업 skeleton

로컬 `.env`는 개발 편의용이다. staging/prod는 평문 `.env`를 커밋하거나 호스트에 남기지 않고
SOPS+age로 암호화한 `infra/prod/secrets.sops.env`를 사용한다.

```sh
# 운영자는 실제 age public recipient를 넣어 .sops.yaml을 만든 뒤:
cp infra/prod/secrets.env.example infra/prod/secrets.env
$EDITOR infra/prod/secrets.env
sops --encrypt --input-type dotenv --output-type dotenv \
  infra/prod/secrets.env > infra/prod/secrets.sops.env
rm -f infra/prod/secrets.env

# 배포/마이그레이션은 복호화 값을 프로세스 환경으로만 주입:
sops exec-env infra/prod/secrets.sops.env \
  'docker compose -f infra/prod/docker-compose.prod.yml up -d'
sops exec-env infra/prod/secrets.sops.env 'make migrate'
```

### 2.4 staging/prod bootstrap preflight

운영/내부호스트 부트 전에 env를 먼저 fail-fast로 검사한다. `staging`/`prod`/`internal-host`
모드에서는 `change-me-*`, `dev-insecure-*`, `example.com`, `localhost`, `.test`/`.invalid`/
`.local`/`.internal` 같은 reserved/local public-routing domain, `mock-hermes`,
`momo_*_dev_pw`, `:internal-smoke`, `:latest` 이미지 태그를 거부한다.

```sh
# SOPS 복호화 값을 프로세스 환경으로만 주입해 검사한다.
sops exec-env infra/prod/secrets.sops.env \
  'scripts/prod_env_preflight.sh --from-env --mode staging --evidence-dir /tmp/momo-public-preflight'

# 평문 임시 env 파일을 tmpfs에 렌더링한 운영자도 배포 전에 같은 검사를 실행한다.
scripts/prod_env_preflight.sh --env-file /run/momo/prod.env --mode prod --evidence-dir /tmp/momo-public-preflight
```

필수 env: `COMPOSE_PROJECT_NAME`, `MOMO_ENV`, `PUBLIC_BASE_URL`,
`API_DOMAIN`, `REALTIME_DOMAIN`, `CADDY_EMAIL`, `ACME_EMAIL`, `HTTP_PORT`, `HTTPS_PORT`, `MOMO_API_IMAGE`, `MOMO_RELAY_IMAGE`,
`MOMO_WORKER_IMAGE`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`DATABASE_URL`, `RELAY_DATABASE_URL`, `REDIS_PASSWORD`, `CENTRIFUGO_REDIS_ADDRESS`,
`CENT_TOKEN_HMAC`, `CENT_API_KEY`, `JWT_HMAC`, `AGENT_PROVIDER_MODE`, `AGENT_MODEL`,
`HERMES_BASE_URL`, `HERMES_API_KEY`, `SECRET_SOURCE`, `DB_VOLUME_NAME`,
`REDIS_VOLUME_NAME`, `PGBACKREST_STANZA`, `PGBACKREST_REPO1_PATH`,
`PGBACKREST_REPO1_CIPHER_PASS`, `PGBACKREST_WAL_ARCHIVE_REQUIRED`,
`PGBACKREST_STANZA_CHECK_REQUIRED`, `PGBACKREST_FULL_BACKUP_REQUIRED`,
`PGBACKREST_PITR_REHEARSAL_REQUIRED`.

`--evidence-dir`는 secret 값을 redacted 처리한 `prod-env-preflight-<mode>.md`
와 `.json`을 만든다. 이 packet은 PR body나 host handoff에 붙이는 public host
preflight evidence이며, 실제 DNS 변경/TLS 인증서 발급/registry pull/SOPS 복호화/
pgBackRest backup/PITR 실행은 여전히 실제 host에서만 닫히는
`runtime-unverified(public host)` 범위다.

`internal-smoke`/`local` 모드는 예외다. 이 모드는 `infra/prod/internal-smoke.env.example`
또는 verifier가 생성한 run-specific env에서만 사용하며, `localhost` 도메인, `mock-hermes`,
`momo-*:internal-smoke*` 이미지, `change-me-*`와 `momo_*_dev_pw` placeholder를
의도된 로컬 경계로 허용한다. 이 모드의 `AGENT_PROVIDER_MODE`는 `internal-host-mock`이다.
이 env는 운영 호스트 배포 입력으로 쓰지 않는다.

pgBackRest PITR skeleton은 `infra/prod/pgbackrest.conf.example`,
`infra/prod/postgresql.pgbackrest.conf.example`, `infra/prod/pgbackrest-cron.example`에 있다.
운영 계약은 **복원 리허설 증거 없는 백업을 검증된 백업으로 보지 않는다**는 것이다. Repo-local로는
`scripts/local_gate.sh --profile backup`이 임시 PostgreSQL 18 source DB에서 `pg_dump`를 만들고 별도
restore DB에 `pg_restore`한 뒤 marker checksum과 markdown/json evidence를 남긴다. 실제 pgBackRest
stanza 생성, WAL archive check, full backup, time-target PITR restore rehearsal은 staging/prod 호스트에서만
가능하므로 계속 `runtime-unverified(public host)`다. 상세 절차는
[`docs/SECRETS_BACKUP_RUNBOOK.md`](SECRETS_BACKUP_RUNBOOK.md)를 본다.

```sh
# 내부 테스트 호스팅 전 최소 backup gate
scripts/local_gate.sh --profile backup

# host-runtime smoke에는 같은 복원 리허설이 포함된다.
scripts/local_gate.sh --profile host-runtime

# 내부 알파 reviewer handoff용 combined evidence packet.
# host-runtime, backup restore, macOS real-backend process/window, diagnostics bundle을 함께 남긴다.
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha
```

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
> MOMO-115부터 같은 relay path는 `scripts/local_gate.sh --profile runtime-relay`로 반복 검증한다.

> **compose layer 분리:** `infra/docker-compose.yml`은 dev/local runtime iteration용 PG18+Centrifugo layer다. `infra/docker-compose.e2e.yml`은 MOMO-186 local gate 전용으로 API/relay/worker/mock-Hermes까지 같은 compose project에 넣는다. `infra/prod/docker-compose.prod.yml`은 source checkout 없는 image-based staging/prod skeleton이다.

### 3.1 E2E compose static validation

MOMO-186 e2e layer는 local gate가 전체 service boundary를 재현하기 위한 초안이다. dev compose를 대체하지 않고, prod compose의 image-based/source-checkout-free 원칙도 건드리지 않는다.

```sh
# worktree라면 .conductor/setup.sh가 .env.worktree를 만든다.
docker compose --env-file .env.worktree -f infra/docker-compose.e2e.yml config

# 같은 검증은 docs local gate에도 포함된다.
scripts/local_gate.sh --profile docs
```

서비스 경계: `postgres` → `migrate` → `db-roles` → `api`; `relay`와 `worker`는 BYPASSRLS test roles로 Postgres를 poll하고, `worker`는 repo-local `mock-hermes` (`scripts/mock_hermes.py`)에만 연결한다. 실제 stack boot/full runtime verifier는 후속 runtime goal에서 닫는다.

### 3.2 Internal alpha diagnostics bundle

내부 테스트 중 장애 상황을 공유할 때는 raw 로그를 직접 붙이지 말고 redacted bundle을 만든다.

```sh
scripts/collect_diagnostics.sh --output-dir /tmp/momo-diagnostics --since 15m
scripts/local_gate.sh --profile diagnostics
```

collector는 best-effort로 server/relay/worker verifier logs, Centrifugo Docker logs,
macOS unified logs, env shape, git commit/status, local gate evidence를 모아
`summary.md`가 있는 directory와 `.tar.gz`를 만든다. Docker가 꺼져 있거나 macOS app
로그가 없어도 가능한 evidence를 남긴다.

보안 경계: secrets/password/token/API key/HMAC/database URL credentials는 bundle에 쓰기 전에
`[REDACTED]`로 치환한다. 그래도 외부 공유 전에는 내부자가 summary와 파일 목록을 한 번 확인한다.

내부 알파 PR handoff처럼 "돌아가는 로컬 호스트 런타임 + 실제 macOS dev app + 복원 리허설 +
진단 번들"을 한 번에 묶어야 할 때는 combined local gate를 사용한다.

```sh
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha
```

이 profile은 `LOCAL_GATE_LAUNCH_UI=1`을 필수로 요구한다. PASS 시 top-level local gate evidence가
run-specific `internal-alpha-<run-id>/{host-runtime,backup-restore,macos-real-backend,diagnostics}/`
artifact directory를 함께 출력한다. 여기에는 prod+internal-smoke image boot, `/health`, migration
idempotency, REST message, OutboxRelay publish, mock Hermes 기반 김인턴 roundtrip, repo-local
`pg_dump`→separate restore evidence, `MomoMacDevApp` real-backend process/window log, redacted
diagnostics directory/archive path가 포함된다.

---

## 4. 마이그레이션 — `make migrate`

스키마 + 데모 시드를 **번호순**으로 적용한다(`server/Migrations/*.sql`).

```sh
export DATABASE_URL=postgres://momo:<pw>@localhost:5432/momo   # .env와 동일 값
make migrate                                                   # = sh scripts/migrate.sh
```

- 적용 대상(현재): `001_init.sql`(정본 스키마 + 보강 — outbox/cost/APNs), `002_seed.sql`(데모 시드), `003_onboarding.sql`(M2 invite_code + redemption audit, schema_v0.sql 미수정).
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
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U momo -d momo -v ON_ERROR_STOP=1 < server/Migrations/003_onboarding.sql
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

- REST(`/v1/auth/login`, `/v1/join`, 메시지 송수신) + JWT 발급 + Centrifugo publish/subscribe-proxy.
- **핵심 쓰기경로(§1.2 / v0):** `REST send → (channel_seq bump + message insert + outbox insert) 단일 tx`.
  실제 fan-out은 relay가 담당(아래).
- 기본 바인드 `0.0.0.0:8080`. **`PORT` 변경 시 `infra/centrifugo.json`의 subscribe proxy URL(`api:8080`)도 함께 변경.**

#### 5.1.1 Public invite join — `POST /v1/join`

MOMO-014 adds the production self-signup path for a user who only has an invite
code. Request body accepts `code`, `email`, `displayName`/`display_name`,
optional `handle`, and optional `timeZone`/`tz`. Password auth remains the v0
stub until the real auth ticket lands.

- Preflight does not install a cross-tenant SECURITY DEFINER helper. It enumerates
  workspace ids and checks `invite_code` inside `SET LOCAL app.workspace_id` tenant
  reads until the bearer code matches.
- The write path then uses one tenant transaction to create/reuse `human` +
  `member`, create public-channel `membership` rows for the invite role,
  increment `invite_code.used_count`, insert `invite_code_redemption`, and record
  `audit_log(action='invite.join')`.
- `owner`/platform-admin creation is forbidden. Existing members cannot use a
  public join invite to escalate their role.

Runtime verifier:

```sh
make up
make migrate
scripts/verify_join.sh
```

`scripts/local_gate.sh --profile runtime-db` runs this verifier after the RLS
runtime verifier.

#### 5.1.2 Realtime connection token — `POST /v1/auth/realtime-token`

MOMO-192 adds the server-side token source required by live Centrifugo clients.
Call it with an app access token from `/v1/auth/login`:

```sh
curl -X POST http://127.0.0.1:8080/v1/auth/realtime-token \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Response:

```json
{
  "token": "<centrifugo-connection-jwt>",
  "tokenType": "centrifugo.connection.jwt",
  "expiresAtMs": 1782463260000,
  "ttlSeconds": 300,
  "workspaceId": "00000000-0000-7000-8000-000000000001",
  "memberId": "00000000-0000-7000-8000-000000000101"
}
```

Boundary:

- The endpoint is mounted behind `AuthMiddleware`; refresh tokens, expired access
  tokens, and malformed JWTs fail before token issue.
- The server re-checks `member.status='active'` inside `SET LOCAL app.workspace_id`
  tenant RLS before signing the Centrifugo connection token.
- The connection JWT carries `sub=member_id`, top-level `ws=workspace_id`, and
  JSON `info` with the same member/workspace ids. It does not grant channel
  access by itself.
- Normal `ch:`/`dm:` subscriptions still go through Centrifugo subscribe proxy
  `POST /v1/centrifugo/subscribe`, which parses `ch:ws<workspace>.<channel>` and
  checks active channel `membership` under tenant RLS.
- Agent progress subscriptions use `agent:ws<workspace>.<agentMember>`. The
  subscribe proxy checks that the observer and target agent are active members
  in the same workspace and share at least one active channel membership. This
  boundary is for live `agent.status`/`agent.partial` progress only; durable
  final output still reconciles through channel `message.new` and `message.seq`.
- Clients never publish to Centrifugo. All durable writes remain REST → Postgres
  transaction → outbox → OutboxRelay/AgentWorker server-side publish.
- TTL defaults to 300 seconds and is configurable with
  `CENT_CONNECTION_TOKEN_TTL_SECONDS`, clamped to 60~1800 seconds.

Focused tests live in `server/Tests/MomoServerTests` and cover TTL clamp,
Centrifugo JWT member/workspace claims, expired app access token rejection,
response JSON shape, and channel/agent namespace parsing. Docker WebSocket live
evidence is covered by `runtime-live` for `ch:` and `runtime-agent` for `agent:`.

#### 5.1.3 Inbound MCP v0 skeleton

MOMO-172 adds a compile-safe inbound MCP skeleton to the same `MomoServer` process:

```sh
# requires a bearer token whose scopes include mcp.read / mcp.post / mcp.tool.propose
curl -H "Authorization: Bearer $ACCESS_TOKEN" http://127.0.0.1:8080/v1/mcp
curl -H "Authorization: Bearer $ACCESS_TOKEN" http://127.0.0.1:8080/v1/mcp/tools
```

- Endpoints: `GET /v1/mcp`, `GET /v1/mcp/tools`, `POST /v1/mcp/tools/call`.
- Tools: `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call`.
- Security preflight: app JWT, exact `mcp.*` scope, workspace claim match, `SET LOCAL app.workspace_id`, active member, channel membership.
- Current status: `POST /v1/mcp/tools/call` returns a stub tool-result envelope (`runtime-unverified`) rather than executing MCP JSON-RPC/tool logic.

Operational details are in [`docs/INBOUND_MCP.md`](INBOUND_MCP.md); the normative spec remains
[`research/11-agent-runtime/09-inbound-mcp-server-v0.md`](../research/11-agent-runtime/09-inbound-mcp-server-v0.md).

### 5.2 Outbox Relay — `OutboxRelay`

```sh
swift run --package-path relay/OutboxRelay OutboxRelay
```

- `outbox`(kind=`broadcast`) 행을 `SELECT … FOR UPDATE SKIP LOCKED`로 클레임 →
  Centrifugo `POST /api/publish`(version=seq, idempotency_key) → `status='done'`.
- **BYPASSRLS `momo_relay` 역할**로 전 테넌트 폴링(§2.2/§10.1) → `RELAY_DATABASE_URL` 또는
  `RELAY_POSTGRES_USER/PASSWORD`로 분리 자격증명 권장.
- 이 프로세스가 떠 있어야 메시지가 클라로 **실시간 전달**된다(commit↔publish 무손실 보장계층).

#### 5.2.1 MOMO-115 Relay 런타임 게이트

`make up && make migrate` 이후 직접 실행하거나, PR gate에서는 아래 profile을 사용한다.

```sh
scripts/verify_relay.sh
scripts/local_gate.sh --profile runtime-relay
```

검증 범위는 seeded demo user login → REST message send → outbox `pending`
→ OutboxRelay claim → Centrifugo history → outbox `done` → `version=message.seq`
evidence다. worktree에서는 `.env.worktree`의 `COMPOSE_PROJECT_NAME`, `PORT`,
`POSTGRES_PORT`, `CENT_PORT`를 사용해 포트를 분리한다.

#### 5.2.2 MOMO-196 Realtime WebSocket live 게이트

`runtime-relay`는 Centrifugo history를 확인하고, 아래 profile은 실제 WebSocket
subscriber가 live publication을 받는지 확인한다.

```sh
scripts/verify_realtime_live.sh
scripts/local_gate.sh --profile runtime-live
```

검증 범위는 Docker dev compose PG/Centrifugo bootstrap → host MomoServer/OutboxRelay
기동 → compose network의 `api:8080` proxy 연결 → demo login →
`POST /v1/auth/realtime-token` → `ch:ws<workspace>.<channel>` subscribe →
REST message send → live `message.new` publication 수신이다. evidence에는
`payload.message.seq`, REST `message.seq`, Centrifugo publication offset, invalid
connection token reject 경로가 남는다. proxy는 dev Centrifugo config의
subscribe callback(`http://api:8080/v1/centrifugo/subscribe`)을 host MomoServer로
전달하기 위한 local gate 전용 컨테이너다.

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
REST `POST /messages`의 `@김인턴` mention → same-channel `agent_run`/`agent_job`,
duplicate `client_msg_id` job dedupe, non-channel agent mention no-op/audit,
mock SSE 수신, Centrifugo history의 `agent.partial`/tool-call progress,
OutboxRelay final channel `message.new`, `usage_ledger`, `budget_window`,
low-limit G5 circuit breaker를 한 번에 확인한다.

```sh
make up
make migrate
scripts/verify_agent_worker.sh
```

MOMO-202부터 같은 verifier가 MomoServer도 잠깐 띄워
`GET /v1/workspaces/{ws}/channels/{ch}/cost-snapshots`를 호출한다. 이 endpoint는
`agent_run`의 현재 reservation projection, `usage_ledger`의 reconciled spend,
`budget_window`의 soft/hard limit state를 `CostSnapshot` 계약으로 반환하며,
macOS B 비용 호흡 링은 이 projection을 소비한다.

#### 5.3.2 MOMO-204 M3 D/B/C combined local gate

M3 D/B/C exit evidence는 개별 runtime profile을 따로 붙이지 않고 아래 profile 한 번으로
수집한다.

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc
```

검증 범위:

- D Live Tool-Call: `scripts/mock_hermes.py` OpenAI-compatible SSE가 `tool_call`
  delta/progress를 내보내고, AgentWorker가 final `tool_result`/`message.new`를
  `version=message.seq`로 reconcile한다.
- B Cost Projection: `usage_ledger`/`budget_window` reserve→reconcile DB evidence와
  MomoServer `/cost-snapshots` 응답, macOS `CostSnapshot` binding test를 함께 확인한다.
- C Approval Inbox/Decision: pending projection, approve/reject, `client_decision_id`
  idempotency/conflict, expired click, membership guard, `audit_log`, resume `agent_job`
  evidence를 확인한다.
- macOS REST/UI data path: Docker+migrate+host MomoServer로 REST login/channel
  list/history/send와 approval/cost structured props를 검증한다.

`LOCAL_GATE_LAUNCH_UI=1`을 붙이면 `MomoMacDevApp` foreground process/window/log smoke까지
요구한다. 기본값은 headless Codex 환경을 위해 GUI launch를 opt-in으로 유지한다.
실제 external Hermes/staging provider side effect, M4 packaging/signing/notary, iOS/APNs는
MOMO-204 범위 밖이다.

#### 5.3.3 MOMO-212 Agent live-channel 게이트

`agent:ws<workspace>.<agentMember>` namespace의 live subscribe 경계는 아래
verifier가 닫는다. 메시지 채널 `ch:` live gate는 MOMO-196의
`scripts/verify_realtime_live.sh`가 담당하고, 이 gate는 agent status/partial
progress가 agent channel boundary에서만 전달되는지 확인한다.

```sh
make up
make migrate
scripts/verify_agent_live_channel.sh
scripts/local_gate.sh --profile runtime-agent
```

검증 범위는 Docker dev compose PG/Centrifugo bootstrap → host MomoServer →
mock Hermes → host AgentWorker → compose network의 `api:8080` proxy 연결 →
authorized demo member의 `agent:ws<workspace>.<agentMember>` subscribe →
`agent.status` 또는 `agent.partial` live publication 수신이다. 같은 run에서
invalid Centrifugo connection token, same-workspace member without shared channel,
other-workspace member/token, client direct publish deny를 함께 확인한다.

MOMO-215부터 `runtime-agent` profile은 `scripts/verify_agent_worker.sh`를 통해
채널 REST send의 자연어 agent mention routing도 함께 닫는다. 최종 assistant text는
Postgres timeline의 `message.seq` authority를 따르는 channel `message.new`이고,
`agent:` namespace는 ephemeral progress/status surface로 유지한다. 실제 external
Hermes/provider side effect는 여전히 repo-local mock 범위 밖이며, MOMO-230의
`external-agent-provider` opt-in profile에서 credentials가 있을 때만 닫는다. credentials가
없으면 `runtime-unverified(external provider credentials)`로 남긴다.

`agent.status`/`agent.partial`은 non-durable progress projection이다. 이 이벤트는
`message.seq`를 갖는 channel timeline의 순서 권위가 아니며, 최종 durable 결과는
기존 `message.new`/`message.seq` 경로로 reconcile한다.

수동으로 mock만 띄우려면:

```sh
python3 scripts/mock_hermes.py --host 127.0.0.1 --port "${HERMES_PORT:-8088}"
```

---

## 6. macOS 클라이언트 (데모 surface: D / B / C)

macOS 패키지(`clients/macOS`)는 v0에서 **SwiftUI 라이브러리 + 빌드검증 smoke 실행파일 +
SwiftPM 개발용 window 앱 + 릴리스용 Xcode thin host app**으로 구성된다. 데모 경험
**D(Live Tool-Call) / B(비용 호흡) / C(승인 인박스)**는 `MomoMacDevApp`과 Xcode host
`MomoMac.app` 모두에서 같은 `MomoMacRootView`로 확인할 수 있다.

```sh
# 라이브러리 + smoke 컴파일 검증
swift build --package-path clients/macOS

# 헤드리스 smoke 실행(모델/인메모리 백엔드 라운드트립 — DB/Centrifugo/hermes 불필요)
swift run --package-path clients/macOS MomoMacSmoke

# SwiftUI 개발용 macOS window 실행(인메모리 demo seed — DB/Centrifugo/hermes 불필요)
scripts/macos_dev_run.sh

# SwiftUI 개발용 macOS window 실행(MomoServer REST history/send 사용)
make up
make migrate
swift run --package-path server MomoServer
MOMO_SERVER_BASE_URL=http://127.0.0.1:8080 scripts/macos_dev_run.sh
MOMO_SERVER_BASE_URL=http://127.0.0.1:8080 \
MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:8000/connection/websocket \
scripts/macos_dev_run.sh

# PR evidence용 GUI opt-in: launch → process/window smoke → logs → terminate
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui

# M3 D/B/C combined exit evidence: D tool-call + B cost + C approval + REST/UI data path
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc

# M4 릴리스용 Xcode thin host app 무서명 build
( cd clients/macOS && \
  xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO )
```

- `MomoMac`(library): `MomoCore`의 `ChatBackend`/`AgentTransport` 계약 위에 SwiftUI 뷰 + `LiveChatBackend` 스텁 + `MomoServerRESTChatBackend` 개발용 REST transport.
- `MomoMacSmoke`(exe): `MomoCore` + `MomoMac` import → 도메인 모델·인메모리 백엔드 구동을 출력해 **링크/컴파일을 증명**.
- `MomoMacDevApp`(exe): `MomoMacRootView`를 실제 macOS SwiftUI window에 호스트한다. 첫 화면은
  in-memory demo seed로 channel list, message list, cost UI, Approval Inbox를 표시한다.
- session bar의 `Updates` popover는 internal alpha update-channel placeholder다. `MOMO_UPDATE_CHANNEL`,
  `MOMO_UPDATE_FEED_URL`, `MOMO_UPDATE_PUBLIC_ED_KEY`, `MOMO_UPDATE_AUTOMATIC_CHECKS`,
  `MOMO_UPDATE_SIGNING_READY`, `MOMO_UPDATE_NOTARIZATION_READY`, `MOMO_UPDATE_DMG_READY` 같은
  non-secret hints만 읽고, Sparkle private key/Apple signing material은 절대 앱 환경이나 git에 넣지 않는다.
  운영 절차는 [`docs/MACOS_ALPHA_UPDATE_CHANNEL.md`](MACOS_ALPHA_UPDATE_CHANNEL.md)를 따른다.
- 기본 smoke/dev app은 인메모리만 쓰므로 DB/Centrifugo/hermes **런타임 의존이 없다**.
  `MOMO_SERVER_BASE_URL`이 있으면 `MomoMacDevApp`은 MomoServer REST 모드로 전환해
  `/v1/auth/login`, `GET/POST /v1/workspaces/{ws}/channels/{ch}/messages`를 사용한다.
  기본값은 `server/Migrations/002_seed.sql`의 demo workspace/channel/member fixture다.
- REST dev mode 환경변수:
  `MOMO_SERVER_BASE_URL`(필수), `MOMO_ACCESS_TOKEN`(선택, 없으면 `/v1/auth/login`),
  `MOMO_LOGIN_EMAIL`/`MOMO_LOGIN_PASSWORD`(내부 alpha seed는 `demo@momo.local`/`dev-password`;
  미설정 시 legacy transport default는 `demo@momo.local`/`demo`라 real-server mode에서는 명시 권장),
  `MOMO_WORKSPACE_ID`(기본 demo workspace), `MOMO_CHANNEL_ID`(기본 `#general`),
  `MOMO_CENTRIFUGO_WS_URL`(선택, 설정 시 `/v1/auth/realtime-token`으로 Centrifugo
  connection JWT를 받아 `ch:ws<workspace>.<channel>` live subscription을 연결).
- REST dev mode 검증 범위: message history fetch와 send는 실제 MomoServer REST/DB 경로를 탄다.
  `MOMO_CENTRIFUGO_WS_URL`을 설정하면 WebSocket/Centrifugo live subscription도 실제
  SwiftCentrifuge adapter를 탄다. full auth/session UI와 production reconnect UX polish는
  후속 범위다.
- `scripts/macos_dev_run.sh`: build-macos-apps SwiftPM GUI workflow에 맞춘 dev-only run loop다.
  `swift build --package-path clients/macOS --product MomoMacDevApp` 후 `dist/MomoMacDevApp.app`을
  생성하고 `/usr/bin/open -n`으로 띄운다. `--verify`는 process/window smoke, `--logs`는 unified
  log capture, `--telemetry`는 bundle subsystem log capture, `--terminate`는 evidence 수집 후 종료,
  `--terminate-only`는 실행 중인 dev app 정리에 사용한다. 이 bundle은 개발용 staging 산출물이며
  Xcode release host와 별개다.
- `MOMO_*` 환경변수를 앱 프로세스에 확실히 전달하려면
  `MACOS_DEV_RUN_DIRECT_EXEC=1 scripts/macos_dev_run.sh --verify --logs`를 사용한다. 내부 alpha의
  real-server launch 예시는 [`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md) §5에 있다.
- `clients/macOS/MomoMac.xcodeproj`: M4 릴리스 패키징 진입용 thin host app이다. shared scheme
  `MomoMac`은 `MomoMac.app`을 만들며 Bundle ID는 `com.dawnkim.momo`다. 이 target은 local SwiftPM
  package products `MomoMac`/`MomoCore`를 링크하고, 기존 `MomoMacRootView` + `MomoMacDemo` bootstrap을
  사용한다. Debug/Release에는 hardened runtime build setting과 `XcodeHost/MomoMac.entitlements`
  file이 반영되어 있다. `CODE_SIGNING_ALLOWED=NO` local build에서는 Xcode가 hardened runtime signing
  step을 수행하지 않으므로, Developer ID signing, notarytool/stapler, DMG, Sparkle real update install은 후속 M4 범위다.
- Codex app Run action은 `.codex/environments/environment.toml`에서 `./scripts/macos_dev_run.sh`로
  연결된다.

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

## 8. staging/prod 운영 skeleton (MOMO-005)

`infra/prod/`는 단일 VPS에서 staging/prod 스택을 올리기 위한 **운영 skeleton**이다. 현재 goal은
파일과 런북 준비까지만 수행하며, 실제 도메인 DNS 변경, TLS 발급, 이미지 배포, prod 기동은 하지 않는다.

| 파일 | 역할 |
|---|---|
| `infra/prod/docker-compose.prod.yml` | Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker 서비스 정의. |
| `infra/prod/Caddyfile` | `API_DOMAIN` → `api:8080`, `REALTIME_DOMAIN` → `centrifugo:8000` reverse proxy + 보안 헤더. |
| `infra/prod/centrifugo.prod.json` | dev namespace 계약(ch/dm/agent/user)을 유지하면서 engine만 Redis로 전환. subscribe proxy는 compose 내부 `api:8080`. |
| `infra/prod/.env.example` | staging/prod env 예시. 실제 시크릿은 커밋하지 않고 host-local env 또는 MOMO-006 SOPS/age로 주입. |
| `infra/prod/docker-compose.internal-smoke.yml` | MOMO-216 내부 테스트용 single-node smoke override. prod compose에 겹쳐서 local image tag, one-shot migration, mock Hermes boundary를 검증한다. |
| `infra/prod/internal-smoke.env.example` | MOMO-216 repo-local smoke env template. local-only port/domain과 placeholder secret만 담는다. |
| `infra/prod/docker/` | MOMO-220 internal host-runtime 전용 local image build path. prod compose에는 `build:`를 넣지 않고 verifier가 local tags를 만든다. |

### 8.1 local/staging smoke gate (배포 없음, MOMO-007)

```sh
scripts/verify_staging_smoke.sh
scripts/verify_internal_hosting_smoke.sh
scripts/local_gate.sh --profile staging-smoke
```

이 gate는 실제 VPS 시크릿 없이 다음을 자동 검증한다.

- `docker compose --env-file infra/prod/.env.example -f infra/prod/docker-compose.prod.yml config --quiet`
- Caddyfile의 `API_DOMAIN`/`REALTIME_DOMAIN` 라우팅, `api:8080`/`centrifugo:8000` reverse proxy, 보안 헤더 구조
- `infra/prod/centrifugo.prod.json` JSON 파싱, Redis engine, namespace 4종, subscribe proxy, `history_meta_ttl > history_ttl`
- prod plaintext secret 파일이 tracked되지 않는지, `.env.example`/`secrets.env.example`가 명시 placeholder만 담는지
- `.sops.yaml.example`, pgBackRest config/cron, PITR rehearsal evidence template 존재
- `infra/prod/docker-compose.internal-smoke.yml` + `internal-smoke.env.example`가 prod compose 위에서 config를 렌더링하고, API health route, relay/worker enablement, image-based migration path, mock Hermes boundary를 static smoke로 검증

`MOMO_API_IMAGE`/`MOMO_RELAY_IMAGE`/`MOMO_WORKER_IMAGE`는 placeholder 태그다. MOMO-220의
`host-runtime` verifier는 같은 env shape에 run-specific local tags를 주입해 이미지를 빌드하고 실제 boot를 검증한다.
Production host는 source checkout에서 build하지 않고 pinned registry image를 pull한다.
`caddy` binary가 로컬에 있으면 parser validation까지 실행하고, 없으면 structural check만 PASS로 남기며 parser validation은 host-runtime으로 둔다.

`runtime-unverified(public TLS/DNS)`: 실제 public DNS, ACME TLS issuance/renewal, VPS firewall, registry image
pull/run, SOPS 복호화, pgBackRest stanza/check/full backup/PITR restore rehearsal, 외부 hermes staging 연결은 실제 host+시크릿이 있어야 닫는다.

### 8.1.1 internal single-node hosting smoke (MOMO-216/MOMO-220)

이 profile은 “내 맥 dev server”가 아니라 단일 Docker/VPS-like host의 운영 경계를 미리 확인하기 위한
repo-local gate다. `staging-smoke`는 config/static 검증이고, `host-runtime`은 local images를 빌드해 실제 stack을 부팅한다.

```sh
docker compose --env-file infra/prod/internal-smoke.env.example \
  -f infra/prod/docker-compose.prod.yml \
  -f infra/prod/docker-compose.internal-smoke.yml config

scripts/verify_internal_hosting_smoke.sh
scripts/local_gate.sh --profile staging-smoke

scripts/verify_internal_host_runtime.sh
scripts/local_gate.sh --profile host-runtime
```

책임 경계:

- `docker-compose.prod.yml`: source checkout 없는 image-based staging/prod 정본. api/relay/worker는 `image:`만 사용한다.
- `docker-compose.internal-smoke.yml`: local smoke override. local image tag fallback, image-based `migrate` one-shot job, image-based `mock-hermes` boundary를 추가한다.
- `internal-smoke.env.example`: `localhost`/`rt.localhost`, `18080/18443`, app/relay/worker runtime role URLs, `change-me-*` placeholder만 담는 tracked template.
- `scripts/verify_internal_host_runtime.sh`: run-specific local api/relay/worker/migrate/mock-Hermes images를 빌드하고, prod+internal-smoke stack boot, migration one-shot+idempotent re-run, `/health`, `/v1/agent-runtime/status` redaction, REST login/message send, OutboxRelay publish, mock Hermes `@김인턴` 왕복을 검증한다. evidence/log path를 출력한다.
- `scripts/verify_external_agent_provider.sh`: opt-in external Hermes/Kim Intern gate. credentials가 없으면 `runtime-unverified(external provider credentials)` evidence로 skip하고, credentials가 있으면 OpenAI-compatible SSE preflight + local MomoServer/AgentWorker/OutboxRelay `@김인턴` 1왕복 + `/v1/agent-runtime/status` redaction을 검증한다.
- DB migration은 app boot side effect가 아니라 `scripts/migrate.sh` 또는 smoke `migrate` job으로 명시 실행한다.
- Backup/restore는 pgBackRest skeleton과 evidence template까지만 repo-local로 검증한다. 실제 backup/PITR restore rehearsal은 `runtime-unverified(public host)`다.

### 8.2 staging 최초 기동 절차 (host-runtime)

```sh
# 1) DNS: API_DOMAIN / REALTIME_DOMAIN A/AAAA 레코드를 VPS IP로 지정
# 2) host-local env 또는 SOPS/age로 실제 값을 주입 (.env.example의 change-me 금지)
# 3) runtime image tag를 staging tag로 교체
docker compose --env-file /secure/momo/staging.env -f infra/prod/docker-compose.prod.yml pull
docker compose --env-file /secure/momo/staging.env -f infra/prod/docker-compose.prod.yml up -d

# 4) 검증
curl -fsS "https://${API_DOMAIN}/health"
docker compose --env-file /secure/momo/staging.env -f infra/prod/docker-compose.prod.yml ps
```

운영 DB 마이그레이션, BYPASSRLS role bootstrap, SOPS/age, pgBackRest 백업/복원, 경량 모니터링은
public host-runtime 검증이다. staging URL health green, TLS 정상, pgBackRest PITR 복원 리허설 확인 전에는
M1 staging 완료로 표시하지 않는다.

> **보안/불변식:** Caddy만 80/443(ACME/HTTPS)을 노출한다. Postgres, Redis, Centrifugo, api,
> relay, worker는 compose 네트워크 내부에 둔다. 클라이언트 직접 publish 금지와
> `REST → message/outbox tx → relay publish` 경로는 prod에서도 동일하다.

---

## 9. Makefile 타깃 ↔ 실제 커맨드 정합

| 타깃 | 실제 커맨드 | 검증 가능성 |
|---|---|---|
| `make build` | `SWIFT_PKGS` 중 `Package.swift` 있는 패키지 각각 `swift build` (Core/server/relay/worker/macOS) | **build-verifiable** (Swift 6.2 있음) |
| `make test` | 동일 패키지 각각 `swift test` | build-verifiable |
| `make migrate` | `sh scripts/migrate.sh` → `psql`로 `server/Migrations/*.sql` 번호순 적용 | runtime-verifiable; MOMO-001/002에서 pass |
| `make up` | `docker compose -f infra/docker-compose.yml up -d` | runtime-verifiable; MOMO-001/002에서 pass |
| `make down` | `docker compose -f infra/docker-compose.yml down` | runtime-verifiable |

- 서비스 실행(`MomoServer`/`OutboxRelay`/`AgentWorker`)은 Makefile 타깃이 아니라
  **5장의 `swift run … <Executable>`로 직접** 띄운다. macOS GUI 개발 앱은 6장의
  `scripts/macos_dev_run.sh`를 사용해 dev-only `.app` bundle로 띄운다.
- `make build`/`make test`는 **`Package.swift`가 실제로 존재하는 패키지만** 순회하므로,
  일부 패키지가 없어도 안전하게 동작한다.

---

## 10. 트러블슈팅

| 증상 | 원인/조치 |
|---|---|
| `make up` 실패: `docker: command not found` | Docker Desktop 설치/기동 필요. docker/psql 없는 머신에서는 해당 runtime goal을 닫지 말고 `runtime-unverified`로 남긴다. |
| `make migrate`가 "psql 을 찾을 수 없습니다" 출력 후 종료 | psql 미설치. 적용 대상만 나열하고 비-실패 종료. psql 설치 후 재실행하거나 §4.1 컨테이너 경로 사용. |
| 메시지가 클라에 실시간 전달 안 됨 | `OutboxRelay` 미기동. 서버는 commit만 하고 fan-out은 relay 담당. relay 로그 확인. |
| 에이전트가 응답 안 함(D 데모) | `AgentWorker` 미기동 또는 hermes 게이트웨이 미연결. `HERMES_BASE_URL`/`HERMES_API_KEY` 확인. |
| Centrifugo HTTP API 401 | compose가 `CENTRIFUGO_HTTP_API_KEY=${CENT_API_KEY}`로 주입되는지 확인. Centrifugo v6는 일반 JSON `"${CENT_API_KEY}"`를 치환하지 않는다. |
| Centrifugo subscribe 거부 | `centrifugo.json`의 `channel.proxy.subscribe.endpoint`(`api:8080`)과 서버 `PORT` 불일치, 또는 `CENT_TOKEN_HMAC` 불일치. |
| `agent:` subscribe 거부 | target agent가 같은 workspace active member인지, observer와 target agent가 하나 이상의 active channel membership을 공유하는지 확인. 공유 채널이 없거나 다른 workspace token이면 정상적으로 deny된다. |
| prod compose가 시크릿을 요구하며 실패 | `infra/prod/.env.example`은 예시다. 실제 staging/prod는 host-local env 또는 SOPS/age로 `change-me-*`를 모두 교체한다. |
| RLS로 행이 안 보임 | 서버는 트랜잭션마다 `SET LOCAL app.workspace_id` 필요. relay/worker는 BYPASSRLS 역할(`momo_relay`)인지 확인. |

---

## 11. 빠른 참조

```sh
# --- 빌드/정적 점검만 (docker/psql 없는 환경에서 가능한 전부) ---
make build
swift build --package-path clients/macOS && swift run --package-path clients/macOS MomoMacSmoke
python3 -m py_compile adapters/hermes/momo_adapter.py
jq empty infra/prod/centrifugo.prod.json

# --- 선택적 수동 UI 확인: macOS window를 열고, 창을 닫으면 종료 ---
scripts/macos_dev_run.sh --verify --logs
scripts/macos_dev_run.sh --terminate-only

# --- 전체 런타임 기동 (PG18 + Centrifugo v6 환경) ---
cp infra/.env.example .env       # 값 채움 (openssl rand -hex 32)
set -a; . ./.env; set +a
make up                          # PG18 + Centrifugo v6
make migrate                     # 스키마 + 데모 시드
swift run --package-path server MomoServer                 # 터미널 1
swift run --package-path relay/OutboxRelay OutboxRelay     # 터미널 2
swift run --package-path workers/AgentWorker AgentWorker   # 터미널 3 (D 데모, hermes 필요)
scripts/local_gate.sh --profile runtime-relay              # relay path 반복 검증

# --- 운영 skeleton 정적 점검 (배포 없음) ---
docker compose --env-file infra/prod/.env.example -f infra/prod/docker-compose.prod.yml config >/tmp/momo-prod-compose.yml
```
