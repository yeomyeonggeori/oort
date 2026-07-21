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
그 문서는 local tools/env/gate 순서, `MomoMacDevApp` 실행, seeded 사람/채널과 agent pairing assumptions,
초대/자가가입, diagnostics bundle, bug report template, known limitations를 한 흐름으로 묶은 실행 런북이다.
AWS에서 1주일짜리 팀 테스트 host를 띄우는 경우에는 [`docs/AWS_INTERNAL_ALPHA.md`](AWS_INTERNAL_ALPHA.md)를
같이 본다. 해당 문서는 EC2/Lightsail topology, 비용 추정, 보안그룹, DNS/TLS,
backup/restore, image-based deploy/rollback, `scripts/aws_internal_alpha_preflight.sh`
사용법을 고정한다.

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
    swift run … momo-workd       →  signed REST poll        # 선택: 사용자 실행 호스트
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
foreground app: scripts/momo start, or use SUMMARY for this stack's exact env
evidence summary: /tmp/.../summary.md
logs: /tmp/.../logs
stop: /tmp/.../stop-local-alpha.sh
```

Centrifugo 컨테이너의 subscribe proxy는 local alpha 실행 중 host-run `MomoServer`를 호출해야 하므로
runner가 evidence 디렉터리에 임시 Centrifugo config/compose override를 생성한다. macOS Docker
Desktop 기본값은 `host.docker.internal`이며, 필요하면 `--api-proxy-host <host>`로 바꾼다.
이 임시 config도 `infra/centrifugo.json`과 같은 namespace 계약을 유지해야 한다. 특히
	`ch:ws<workspace>.<channel>`뿐 아니라 Hermes gateway private work stream인
	`agentwork:ws<workspace>.<agentMember>`도 subscribe proxy를 통과해야 한다. local alpha에서
	Hermes adapter 로그에 `permission denied`가 보이면 먼저 runner가 새로 생성한
	`centrifugo.local-alpha.json`의 `agentwork` namespace에 `subscribe_proxy_enabled`와
	workspace-qualified `channel_regex`가 들어 있는지 확인한다.

runner는 기본 검증 경로에서 headless `MomoMacSmoke`를 실행한다. 사용자가 실제 앱 창을 열 때는
기본 고정 포트 flow인 `scripts/momo start`를 쓰거나, runner가 생성한 `summary.md`의
`MOMO_SERVER_BASE_URL`/`MOMO_CENTRIFUGO_WS_URL`/`MOMO_LOGIN_*` 환경변수 예시로
`scripts/macos_dev_run.sh --launch --verify`를 실행한다. 현재 `MomoMacDevApp`은 개발용
SwiftPM-staged `.app`이며, 서명/공증/배포용 패키징은 M4 범위다.

---

## 2. 환경변수 (`.env`)

`infra/.env.example`를 복사해 `.env`로 만들고 값을 채운다. `.env`는 `.gitignore`에 등록돼
있어 커밋되지 않는다. **하나의 `.env`가 docker-compose · 마이그레이션 러너 · 서버 · relay ·
worker를 모두 구동**한다(키 이름이 전 컴포넌트에서 일치).

### 2.0 Production runtime role provisioning

Production compose는 `MOMO_BOOTSTRAP_RUNTIME_ROLES=0`으로 test bootstrap을 끈다. 이 모드에서는
배포용 DB 관리자와 별개로 다음 세 역할을 Terraform/CloudFormation 또는 DB 운영 자동화로
**migration 전에** 만들어야 한다.

- `momo_app`: `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`
- `momo_relay`, `momo_worker`: `LOGIN`, `NOSUPERUSER`, `BYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`

각 비밀번호는 운영 secret manager에서 독립 생성·회전하고 runtime connection URL에 주입한다.
`infra/e2e/bootstrap_roles.sql`의 `momo_*_dev_pw`는 격리된 verifier 전용이며 운영 provision에
복사하거나 재사용하면 안 된다. migrate job은 위 역할의 존재와 RLS 속성을 먼저 검사하고,
누락되거나 잘못된 경우 어떤 migration도 시작하기 전에 종료한다. 역할이 준비된 뒤 migration 009가
locked join 함수의 `momo_app` 전용 USAGE/EXECUTE를 부여하며 relay/worker에는 부여하지 않는다.

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
| `CENT_PROXY_SECRET` | 서버, Centrifugo | **MOMO-300** subscribe proxy 콜백 공유 시크릿. Centrifugo가 `X-Centrifugo-Proxy-Secret` static header로 붙이고(`infra/centrifugo*.json` + compose env override) API가 검증 — 없거나 틀리면 401. staging/prod/internal-host에서는 placeholder면 부팅 fail-fast(`prod_env_preflight.sh` 연계). |
| `JWT_HMAC` | 서버 | App access(15m)/refresh(30d) 토큰 HS256 서명 시크릿(§7.1). |
| `MOMO_LIVEKIT_API_KEY` / `MOMO_LIVEKIT_API_SECRET` | 서버 | ADR-0122 허들 room grant의 `iss`와 HS256 서명 키. App JWT/Centrifugo 키와 분리하며 secret은 응답·audit·로그에 넣지 않는다. |
| `MOMO_LIVEKIT_URL` | 서버 | 클라이언트에 반환할 LiveKit `http(s)`/`ws(s)` endpoint. 세 LiveKit 값 중 하나라도 없거나 URL이 잘못되면 허들 API는 503 `허들 미구성`으로 fail-closed한다. LiveKit 컨테이너 기동은 V-2 범위다. |
| `LIVEKIT_PORT` / `LIVEKIT_RTC_TCP_PORT` | compose `huddle` profile | LiveKit signaling/HTTP(기본 7880)와 TCP RTC fallback(기본 7881)의 호스트 포트. |
| `LIVEKIT_RTC_UDP_START` / `LIVEKIT_RTC_UDP_END` | compose `huddle` profile | 컨테이너의 제한된 UDP media range 50000~50100에 대응하는 같은 크기의 호스트 포트 범위. 기본 50000~50100. |
| `AGENT_PROVIDER_MODE` | 서버, worker | `local-mock` / `internal-host-mock` / `external-hermes`. staging/prod/internal-host는 `external-hermes`만 허용. |
| `AGENT_MODEL` | 서버, worker | 김인턴 provider model label(기본 `hermes-agent`). |
| `AGENT_HANDLE` / `AGENT_DISPLAY_NAME` | 서버, macOS 표시 | status surface 표시용 agent identity(기본 `kim-intern` / `김인턴`). |
| `HERMES_BASE_URL` | 서버, worker | hermes OpenAI 호환 게이트웨이 베이스(`/v1`). 서버는 health/status projection에 redacted label만 노출. |
| `HERMES_API_KEY` | 서버, worker | hermes Bearer 토큰. health/status/log/diagnostics에는 원문 노출 금지. |
| `AGENT_GATEWAY_MODE` | 서버, worker | `worker`(기본) 또는 `gateway`. `gateway`면 `@hermes` mention이 AgentWorker provider call 대신 Hermes native platform adapter로 전달된다. |
| `MOMO_AGENT_TOKEN` | Hermes adapter, AgentWorker work controls | Pairing/credential API에서 1회 발급하는 agent-scoped momo bearer. adapter는 `~/.momo/hermes-gateway.env`, worker는 process-local secret env에만 저장하며 provider OAuth token과 별개다. DB/job payload/log에 원문을 넣지 않는다. |
| `AGENT_GATEWAY_SECRET` | 서버 | ADR-0101 이관 회귀검증에만 쓰는 deprecated callback 공유 시크릿. 기본 거부되며 아래 flag가 1인 경우에만 수용한다. |
| `MOMO_ALLOW_LEGACY_GATEWAY_SECRET` | 서버, local alpha runner | `1`일 때만 `AGENT_GATEWAY_SECRET` 병행 수용. 기본 `0`; MOMO-338 adapter는 이 경로를 사용하지 않는다. |
| `EXTERNAL_AGENT_PROVIDER_ENV_FILE` | `scripts/verify_external_agent_provider.sh` | 선택. 외부 runtime provider credentials만 담은 untracked env 파일. `.env.worktree`의 local stack ports를 유지하면서 provider secret만 override할 때 사용. |

Codex OAuth access/refresh token은 momo 환경변수가 아니다. External runtime
provider가 Codex OAuth를 사용하더라도 token exchange, storage, refresh,
unlink는 provider 내부에서만 처리하고, momo app/API/DB/diagnostics/local gate는
그 토큰을 받지 않는다. 정본 boundary는
[`docs/adr/0004-codex-oauth-hermes-provider-boundary.md`](adr/0004-codex-oauth-hermes-provider-boundary.md)다.

### 2.2 코드가 추가로 읽는 선택적 키 (모두 안전한 기본값 있음 → `.env`에 없어도 부팅)

> 아래는 `.env.example`에는 의도적으로 넣지 않은 **튜닝/오버라이드 키**다. 설정하지 않으면
> 코드의 dev-safe 기본값으로 동작한다(`runtime-unverified` 환경에서도 프로세스가 부팅되도록).

| 키 | 컴포넌트 | 기본값 | 의미 |
|---|---|---|---|
| `HOST` | 서버 | `0.0.0.0` | HTTP 바인드 호스트. |
| `PORT` | 서버 | `8080` | HTTP 바인드 포트. **Centrifugo subscribe proxy가 `api:8080`을 콜백**하므로 변경 시 `centrifugo.json`도 맞춰야 함. |
| `POSTGRES_HOST` | 서버/relay/worker | `localhost` | `DATABASE_URL` 미설정 시 폴백 호스트. |
| `LOG_LEVEL` | 서버 | (info) | 로그 레벨. |
| `MOMO_DRIVE_BACKEND` | 서버 | (미설정) | `stub`은 verifier/local 명시 opt-in 전용이며 staging/prod/internal-host 부팅에서 거부된다. 실백엔드는 `google` 또는 `sa`. |
| `MOMO_ARCHIVE_BACKEND` | 서버 | `drive` | ADR-0127 첨부 저장 선택. `drive`는 기존 Google/검증 stub 경로, `s3`는 S3 호환 presigned PUT/GET 경로다. 알 수 없는 값이나 불완전한 S3 자격은 `UnavailableDriveArchiveClient`로 fail-closed한다. |
| `MOMO_DRIVE_ARCHIVE_BACKEND` | 서버 | (`MOMO_DRIVE_BACKEND` 폴백) | 첨부 archive 백엔드. `google`/`sa`는 `drive.file`로 `channels/<channel_id>/` 폴더와 resumable 세션을 만들며, `stub`은 verifier/local 전용이고 strict 환경에서 부팅 거부된다. |
| `MOMO_DRIVE_ARCHIVE_STUB_BASE_URL` | 서버 | `http://127.0.0.1:$PORT` | stub이 반환할 직접 PUT base URL. verifier 전용이며 Google 모드에서는 사용하지 않는다. |
| `MOMO_S3_ENDPOINT` / `MOMO_S3_REGION` / `MOMO_S3_BUCKET` | 서버 | (미설정) | S3 호환 공개 endpoint, SigV4 region, bucket. `s3` 선택 시 셋 모두 필수다. 실제 클라이언트가 presigned URL에 직접 접근하므로 운영 endpoint는 HTTPS여야 한다. |
| `MOMO_S3_ACCESS_KEY` / `MOMO_S3_SECRET_KEY` | 서버 | (미설정) | S3 SigV4 자격. 응답 URL 서명에만 사용하고 로그·DB·감사 원장에 저장하지 않는다. |
| `MOMO_S3_FORCE_PATH_STYLE` | 서버 | `0` | `1`이면 `<endpoint>/<bucket>/<key>` path-style. compose MinIO에서는 필수이며 AWS/R2/B2는 제공자 endpoint 정책에 맞춘다. |
| `MOMO_DRIVE_SA_KEY_PATH` | 서버 | (미설정) | repo 밖 SA JSON 파일 경로. 키 바이트는 로그·응답·DB에 저장하지 않는다. |
| `MOMO_DRIVE_SHARED_DRIVE_ID` | 서버 | (미설정) | 경로 C가 접근할 공유 드라이브 1개의 ID. 미설정이면 `tools/call`이 fail-closed 오류를 반환한다. |
| `PUBLIC_BASE_URL` | 서버 | (요청 origin) | momo-hosted MCP 상대 endpoint를 descriptor의 절대 URL로 조립할 public HTTPS origin. localhost HTTP만 개발 fallback 허용. |
| `CENT_CONNECTION_TOKEN_TTL_SECONDS` | 서버 | `300` | `/v1/auth/realtime-token` Centrifugo connection JWT TTL. dev 값은 60~1800초로 clamp된다. |
| `RELAY_DATABASE_URL` | relay/worker | (= `DATABASE_URL`) | relay/worker 전용 **BYPASSRLS `momo_relay`** 접속(§2.2/§10.1). 설정 시 우선. |
| `RELAY_POSTGRES_USER` / `RELAY_POSTGRES_PASSWORD` | relay/worker | (= `POSTGRES_*`) | 위와 동일 목적의 분리 자격증명. |
| `RELAY_POLL_INTERVAL_MS` | relay | `300` | outbox 폴링 주기(§8.1 fallback 300ms). |
| `RELAY_CLAIM_BATCH` | relay | `64` | 1회 클레임 행 수. |
| `RELAY_MAX_ATTEMPTS` | relay | `8` | 초과 시 `status='failed'`. |
| `WORKER_POLL_INTERVAL_MS` | worker | `300` | agent_job 폴링 주기. |
| `WORKER_MAX_ATTEMPTS` | worker | `8` | 초과 시 `status='failed'`. |
| `MEMORY_EXTRACTION_ENABLED` | worker | `1` | ADR-0129 채널 워터마크 기반 메모리 추출 루프. `0`이면 신규 추출만 멈추며 기존 원장은 보존한다. 정책-off 삭제는 관리자 REST가 수행한다. |
| `MEMORY_EXTRACTION_POLL_INTERVAL_MS` | worker | `5000` | 추출 가능한 채널을 다시 찾는 주기(최소 100ms). |
| `MEMORY_EXTRACTION_BATCH_SIZE` | worker | `50` | 채널별 한 번에 읽는 메시지 수(1..200). |
| `MEMORY_EMBEDDING_ENABLED` | worker | `1` | `embedding IS NULL`인 활성 memory_item의 비동기 임베딩 생성. `0`이면 FTS 검색은 계속 동작한다. |
| `MEMORY_EMBEDDING_MODEL` | worker/api | `text-embedding-3-small` | external-hermes `/embeddings` 모델. local-mock은 이 값과 무관한 결정적 384차원 벡터를 사용한다. |
| `MEMORY_EMBEDDING_POLL_INTERVAL_MS` | worker | `5000` | 임베딩 대기 항목 재탐색 주기(최소 100ms). |
| `MEMORY_EMBEDDING_BATCH_SIZE` | worker | `50` | 한 poll에서 임베딩할 최대 항목 수(1..200). |
| `MOMO_API_URL` | worker | `http://localhost:8080` | `work_*` tool이 기존 `/v1/workspaces/:ws/work-controls`를 호출할 momo API origin. |
| `MOMO_WORK_HOST_ID` | worker/gateway adapter | (미설정) | ADR-0125 host registry target UUID. worker의 `work_*` 및 gateway의 `work.*`는 이 호스트를 provider 인자 밖에서 주입한다. UUID가 없거나 잘못되면 worker는 호출을 거부하고 gateway adapter는 work tool 4종을 provider에 노출하지 않는다. |
| `MAX_CONSECUTIVE_AUTO` | worker | `3` | 루프가드 G2(연속 자동응답). |
| `MAX_STEPS` | worker | `12` | 루프가드 G3(턴당 tool-call 상한, 스키마 50의 v0 오버라이드). |
| `MAX_DEPTH` | worker | `4` | A2A 홉 깊이 상한(§3.4). |
| `MAX_CONCURRENT_RUNS` | worker | `1` | 에이전트별 세마포어 G1. |
| `RATE_LIMIT_WINDOW_SECONDS` | 서버 | `60` | **MOMO-300** rate limit sliding window 길이. |
| `RATE_LIMIT_PER_MEMBER` | 서버 | `600` | 윈도당 인증 멤버별 요청 상한. `0`=축 비활성. 초과 시 429 + `Retry-After` + `audit_log(rate_limit.exceeded)`(버스트당 1회). |
| `RATE_LIMIT_PER_IP` | 서버 | `1200` | 윈도당 클라이언트 IP별 요청 상한(`X-Forwarded-For` 우선). `0`=축 비활성. **per-IP 축 위반은 인증 여부와 무관하게 audit_log에 기록되지 않는다** — IP 미들웨어가 AuthMiddleware보다 앞의 전역 계층이라 principal(tenant)이 없어 서버 로그로만 남는다. audit_log(`rate_limit.exceeded`)는 member 축 위반만 기록. |

> **rate limit v0 경계(문서화):** in-memory sliding window — 단일 노드 전제, 프로세스
> 재시작 시 리셋, 레플리카 간 비공유. `/health`와 subscribe proxy 경로는 제외.
> 비용 서킷브레이커(budget_window)와는 독립 축이다.
> subscribe proxy(`/v1/centrifugo/*`)는 **내부 전용**(centrifugo → api compose 네트워크,
> `CENT_PROXY_SECRET` 인증)이며 prod Caddy 엣지에서 403으로 차단된다(`infra/prod/Caddyfile`).

> **보안:** `.env.example`의 `change-me-*` / 코드의 `dev-insecure-*` 기본값은 **개발용**이다.
> 실배포에선 반드시 교체(`openssl rand -hex 32`). 기본값으로도 부팅은 되지만 안전하지 않다.

### 2.1.1 Kim Intern agent runtime provider mode

김인턴 provider boundary는 `AGENT_PROVIDER_MODE`가 정본이다.

| mode | 사용처 | 허용 provider config | 사용자 표시 |
|---|---|---|---|
| `local-mock` | 개발자 로컬 | `HERMES_BASE_URL=http://localhost:<port>/v1`, placeholder key 허용 | `mock` |
| `internal-host-mock` | `infra/prod/internal-smoke.env.example`, `host-runtime` verifier | `http://mock-hermes:8088/v1`, placeholder key 허용 | `mock` |
| `external-hermes` | staging/prod/internal-host, 또는 명시적 local loopback | 운영은 `https://.../v1` + non-placeholder `HERMES_API_KEY` 필수. 로컬만 `MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 HERMES_BASE_URL=http://127.0.0.1:<port>/v1` 또는 `http://localhost:<port>/v1` 허용 | `available` 또는 `degraded` |

`staging`/`prod`/`internal-host`에서 `local-mock`/`internal-host-mock`, localhost/mock URL,
placeholder key가 보이면 MomoServer/AgentWorker boot와 `scripts/prod_env_preflight.sh`가 fail-fast한다.
`external-hermes`의 non-loopback `http://...` URL도 항상 fail-fast한다. loopback HTTP는 local-only
opt-in이며, Hermes local process가 GPT/OpenAI credential을 소유하고 momo에는 Hermes-facing bearer만
전달하는 개발 루프에서만 쓴다. provider-neutral smoke 계약은
[`docs/external-agent-provider/README.md`](external-agent-provider/README.md), local loopback 특화 계약은
[`docs/external-agent-provider/local-hermes-gpt.md`](external-agent-provider/local-hermes-gpt.md)다.
`GET /health`와 `GET /v1/agent-runtime/status`는 `agentRuntime` projection을 제공하지만
`endpointLabel`은 user/password/query/fragment를 제거한 값이고 provider token은 절대 포함하지 않는다.
macOS sidebar의 Kim Intern chip은 이 projection으로 `Available` / `Degraded` / `Mock`을 표시하고,
internal alpha 사용자에게 `Local mock` / `Internal host mock` / `External Hermes`, key 준비 여부,
redacted endpoint/diagnostic hint를 구분해 보여준다.

Provider status는 연결 가능성만 뜻한다. 내부 알파에서 "김인턴 초대됨"은 별도 precondition이다.
fresh persistent/local-alpha DB에는 agent member가 없으므로 owner/admin이 아래 생성 API로
`member.kind='agent'`, `member.status='active'` identity를 먼저 만든다. 그 다음 `#agent-lab`
(`00000000-0000-7000-8000-000000000202`) membership과 credential을 각각 명시적으로 추가한다. macOS는
선택 채널 Members 섹션의 `AGENT` badge와 sidebar Kim Intern chip을 함께 보여주고, server/API
path는 `/v1/workspaces/{ws}/members?kind=agent`와
`POST /v1/workspaces/{ws}/channels/{ch}/members`로 기존 agent member를 채널에 추가한다.
이 채널 추가는 human `/v1/join` invite code flow가 아니다.

실제 외부 runtime provider side effect는 기본 local gate에 포함하지 않는다. credentials가 있는
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

# credentialed smoke를 필수로 요구하고 1왕복 실패 시 fail-fast
EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS=1 \
EXTERNAL_AGENT_PROVIDER_ENV_FILE=/secure/momo/external-hermes.env \
scripts/local_gate.sh --profile external-agent-provider

# local alpha runner에서 같은 external runtime smoke로 위임
scripts/local_alpha_runner.sh execute \
  --hermes external \
  --external-smoke \
  --secret-env /secure/momo/external-hermes.env

# 로컬 OpenAI-compatible provider loopback smoke (OpenAI/Codex credential은 provider 프로세스 안에만 둔다)
MOMO_ENV=local \
AGENT_PROVIDER_MODE=external-hermes \
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 \
HERMES_BASE_URL=http://127.0.0.1:${HERMES_PORT:-8088}/v1 \
HERMES_API_KEY=local-hermes-bearer \
AGENT_MODEL=gpt-via-local-hermes \
scripts/local_gate.sh --profile external-agent-provider
```

Credentialed smoke에 필요한 momo-side env는 위 네 가지
`AGENT_PROVIDER_MODE`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `AGENT_MODEL`뿐이다. local loopback은
여기에 `MOMO_ENV=local`, `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`이 추가로 필요하다.
credentialed PASS에서는 `/v1/agent-runtime/status`가 `available`이고 `degradedReason`이 비어 있어야
한다. 실패 evidence는 redacted category/reason만 남긴다.
provider가 Codex OAuth를 내부적으로 쓰는 경우에도 `CODEX_OAUTH_TOKEN`,
`CODEX_OAUTH_REFRESH_TOKEN`, `CODEX_ACCESS_TOKEN`, `CODEX_REFRESH_TOKEN`,
`OPENAI_OAUTH_TOKEN`, `OPENAI_OAUTH_REFRESH_TOKEN`, `OPENAI_API_KEY`류 값은 momo verifier에 넘기지
말고 provider host secret으로만 설정한다. verifier는 알려진 Codex/OpenAI OAuth
token/API key env var가 momo smoke process에 있으면 credential-boundary 오류로 fail-fast한다.

`scripts/verify_external_agent_provider.sh`는 먼저 external env contract를 검사한다.
`AGENT_PROVIDER_MODE`가 없거나 `external-hermes`가 아니면 mock 기본 환경으로 보고
`runtime-unverified(external provider credentials)` evidence를 남기고 종료한다. 반대로
`external-hermes`를 명시했는데 URL이 non-loopback `http://`이거나, local opt-in 없는
localhost/mock/placeholder key면 fail-fast한다. credentials가 유효하면 OpenAI-compatible SSE preflight, local
MomoServer/AgentWorker/OutboxRelay boot, `/v1/agent-runtime/status` redaction, verifier-owned
격리 agent + channel fixture, `@hermes` 1왕복까지 시도한다. persistent dogfood roster에는
접근하지 않는다. API key는 stdout/evidence/log redacted artifact에 출력하지 않는다.

#### 2.1.2 Hermes gateway native platform mode

MOMO-325은 AgentWorker SSE 경로와 별개로 Hermes gateway가 momo를 Slack/Telegram 같은
messaging platform으로 인식하는 native adapter path를 추가한다. 이 경로도 모든 사용자 가시
write는 **momo REST -> Postgres -> outbox**로만 들어오며, adapter는 DB/Centrifugo에 직접 쓰지
않는다.

Dogfood 온보딩 순서는 고정이다. 에이전트는 migration/local-alpha 시드로 생기지 않는다.

1. `scripts/momo hermes-gateway-init`으로 secret 없는 pre-pairing env 템플릿을 만든다.
2. momo 앱의 **Members + → 에이전트 초대**에서 Hermes pairing을 완료하고 채널에 초대한다.
3. pairing surface에서 scoped credential을 1회 발급한다.
4. 발급 원문과 paired member/channel ID를 `~/.momo/hermes-gateway.env`에 기록한다.
5. `scripts/momo hermes-gateway-install-plugin` 후 `scripts/momo hermes-gateway-status`로 확인한다.

```sh
scripts/momo hermes-gateway-init
scripts/momo hermes-gateway-install-plugin
scripts/momo hermes-gateway-status
scripts/momo hermes-gateway-smoke
scripts/momo hermes-gateway-smoke --real
```

서버 opt-in:

```sh
AGENT_GATEWAY_MODE=gateway
# token-only 서버 경로는 공유 시크릿이 필요하지 않다.
```

#### Fresh DB 에이전트 pairing 순서

에이전트 생성·채널 초대·credential 발급은 서로 다른 보안 결정을 나타내므로 한 요청으로
합치지 않는다. owner/admin human bearer로 아래 순서를 지킨다.

```text
1. POST /v1/workspaces/{workspace}/agents
   {displayName, handle, model, baseUrl, systemPrompt?, config?, ownerHumanId?}
   -> {agent:{id,handle,displayName}}
2. POST /v1/workspaces/{workspace}/channels/{channel}/members
   {memberId:<agent.id>, role:"member"}
3. POST /v1/workspaces/{workspace}/agents/{agent.id}/credentials
   -> 원문 token 1회 반환
```

1번은 `member(kind='agent')`·`agent`·`agent.created` audit만 같은 tenant transaction으로
커밋하며 **채널을 자동 추가하지 않는다**. 2번은 기존 human/agent 공용 membership 경로를
그대로 재사용한다. 3번의 원문 bearer는 provider OAuth/API key가 아니라 momo-facing agent
credential이며 서버에는 sha256만 저장된다. `baseUrl`/`config`에는 Codex/OpenAI OAuth token,
provider API key, userinfo/query/fragment credential을 넣을 수 없다. non-loopback은 HTTPS만,
loopback HTTP는 `MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`과 명시적 포트가 있을 때만
허용된다(ADR-0004).

MOMO-337부터 human workspace owner/admin은 agent credential을 발급한다. 응답의
`token` 원문은 이 응답에서만 노출되고 서버에는 sha256만 저장된다. 같은 POST를
다시 호출하면 기존 active credential은 기본 24시간 overlap 후 만료된다.

agent handle이 workspace ban 원장에 있으면 신규 agent 생성과 credential pairing 모두 403으로
중단된다. agent suspend/remove는 기존 `token(kind='agent_bearer')`를 즉시 revoke하므로 진행 중
run의 다음 pending/callback/dispatch 인증은 401로 fail-closed한다. reinstate는 폐기된 credential을
자동 복구하지 않는다. 운영자는 멤버 상태를 active로 되돌린 뒤 아래 credential POST로 새 bearer를
명시적으로 발급하고 BYOA gateway env를 교체해야 한다.

```text
POST /v1/workspaces/{workspace}/agents/{agent}/credentials
GET  /v1/workspaces/{workspace}/agents/{agent}/credentials
POST /v1/workspaces/{workspace}/agents/{agent}/credentials/{credential}/revoke
```

기본 scope는 `agent:jobs:read`, `agent:runs:callback`, `messages:read`,
`messages:write`, `realtime:subscribe`, `work:control`이다. agent bearer는 이 scope allowlist에 연결된
서버 surface 외의 human/admin API에
사용할 수 없고, callback/pending 대상 agent가 token actor와 다르면 403이다.
`agentwork:ws<workspace>.<agentMember>` realtime work stream도 connection actor와
target agent가 정확히 같을 때만 subscribe가 허용된다. 같은 채널 membership만으로
다른 에이전트의 Context Packet을 관찰할 수 없다. connection JWT에는 발급 원본
credential id가 server-only `meta`로 포함되고 subscribe proxy는 그 exact token이
active인지 확인한다. Centrifugo subscribe proxy 설정의
`include_connection_meta=true`를 제거하면 모든 신규 subscription이 fail-closed된다.
realtime `agent.job` payload는 wake-up으로만 사용하며, 실제 실행 입력은 같은
agent bearer로 pending REST를 재조회해 Postgres 경계를 통과한 값만 사용한다.
MOMO-338부터 Hermes adapter는 human login과 공유 시크릿을 사용하지 않는다. 서버는
gateway mode만 켜고 legacy secret 병행 수용은 기본적으로 닫는다.

```sh
AGENT_GATEWAY_MODE=gateway \
MOMO_ALLOW_LEGACY_GATEWAY_SECRET=0 \
scripts/momo start
```

adapter/Hermes side env는 `$HOME/.momo/hermes-gateway.env`에 생성된다. provider OAuth/Codex/OpenAI
token은 이 파일에 들어가지 않고 Hermes/provider runtime 내부에만 둔다. mock harness는
`scripts/verify_hermes_gateway_adapter.sh`와 `scripts/local_gate.sh --profile runtime-agent`가
검증한다. MOMO-326은 real Hermes evidence layer를 추가했다. `--real`은 Hermes CLI,
plugin install, provider-login marker, momo server 상태를 분리해서 evidence로 남기며,
사용자가 Hermes 내부에서 provider OAuth/login을 끝낸 뒤에는 다음처럼 실제 1왕복까지 시도한다.

2026-07-12 이전 dogfood DB에서 deterministic 김인턴/Hermes가 이미 시드됐다면 자동 삭제하지
않는다. Hermes/AgentWorker를 먼저 중지하고 DB owner URL을 명시한 뒤 아래 opt-in 명령으로 두
역사적 고정 ID만 retire하고 새로 pairing한다. 이 명령은 `--yes` 없이는 DB에 연결하지 않고,
신원 불일치 시 transaction을 중단한다.

```sh
DATABASE_URL='postgres://<owner>@<host>/<dogfood-db>' \
  scripts/momo cleanup-seeded-agents --yes
```

```sh
AGENT_GATEWAY_MODE=gateway \
MOMO_ALLOW_LEGACY_GATEWAY_SECRET=0 \
scripts/momo start

# Pairing에서 발급한 원문 토큰을 ~/.momo/hermes-gateway.env의
# MOMO_AGENT_TOKEN에 한 번 붙여넣고, 다른 터미널에서 Hermes를 실행한다.
# provider OAuth/login은 Hermes 내부에서 사용자가 준비한다.
MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger
```

macOS dogfood 앱에서는 초대 전 Hermes member 자체가 존재하지 않으며 roster에도 보이지 않는다.
멤버 섹션의 `+` 버튼에서 **에이전트 초대**를 선택하고 `@hermes` alias, 표시 이름, endpoint
label, model label, permission scope, avatar를 확인한다. 앱은 pairing manifest와 invite code를
생성하고 copy/export affordance를 제공한다. manifest에는 momo-facing connection metadata와
`$HOME/.momo/hermes-gateway.env:MOMO_AGENT_TOKEN` 설정 위치만 들어가며, 토큰 원문이나
Codex/OpenAI OAuth token, refresh token, provider API key 값은 절대 포함하지 않는다.
non-loopback `http://...` endpoint는 사용자가 명시적으로 opt-in하지 않으면 초대 완료가 막힌다.
초대 완료를 누르면 그때 `member.kind='agent'` roster row가 나타난다.
초대 후 composer에서 `@`를 입력하면 현재 채널의 초대된 멤버/에이전트 후보가 나타나고,
`@hermes` 전송 뒤에는 Hermes 응답 또는 실패가 도착할 때까지 timeline과 member row에 작업 중
상태가 표시된다.
composer에 사람이 입력 중이면 하단에 typing indicator가 표시된다. 현재 dogfood v0 typing은
local/demo fallback과 backend hook 중심이며, production typing fanout은 후속 범위다. sidebar의
`에이전트 승인함`은 일반 알림함이 아니라 에이전트가 외부 작업을 수행하기 전에 사람이 확인해야
하는 approval queue다. Command Center는 실사용 중 필요한 경우에만 여는 진단 surface이며, 일반
대화는 `#general`, 에이전트 연결/실험은 `#agent-lab`에서 시작한다.
이 UX는 provider OAuth/token을 momo에 넘기는 절차가 아니다. provider login은 Hermes runtime
안에서 사용자가 직접 수행하고, momo 앱은 초대/표시/mention entrypoint만 관리한다.

현재 Hermes runtime이 없으면 real CLI/plugin/provider call은
`runtime-unverified(real hermes gateway missing)`로 남긴다. 정본 문서는
[`docs/external-agent-provider/hermes-gateway-native-platform.md`](external-agent-provider/hermes-gateway-native-platform.md)다.

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
`MOMO_WORKER_IMAGE`, `MOMO_MIGRATE_IMAGE`, `MOMO_WEB_IMAGE`, `MOMO_LINKSHORT_IMAGE`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`DATABASE_URL`, `RELAY_DATABASE_URL`, `REDIS_PASSWORD`, `CENTRIFUGO_REDIS_ADDRESS`,
`CENT_TOKEN_HMAC`, `CENT_API_KEY`, `CENT_PROXY_SECRET`, `JWT_HMAC`, `AGENT_PROVIDER_MODE`, `AGENT_MODEL`,
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

AWS internal alpha topology는 secret env와 별개로 먼저 정적 preflight를 통과해야 한다.

```sh
scripts/aws_internal_alpha_preflight.sh \
  --env-file infra/prod/aws-internal-alpha.env.example \
  --mode recommended \
  --evidence-dir /tmp/momo-aws-alpha-preflight
```

실제 AWS host에서는 fixture를 `/run/momo/aws-alpha.env` 같은 untracked 파일로 복사한 뒤
도메인, tester CIDR, IAM instance profile, S3 bucket, immutable image tag/digest를 바꾸고
동일 preflight를 다시 실행한다. 이 preflight는 AWS API를 호출하지 않으며 실제 host runtime은
`runtime-unverified(aws-host)`로 남는다.

```sh
# 내부 테스트 호스팅 전 최소 backup gate
scripts/local_gate.sh --profile backup

# host-runtime smoke에는 같은 복원 리허설이 포함된다.
scripts/local_gate.sh --profile host-runtime

# AWS로 가기 전 1인 local Docker alpha RC gate.
# host-runtime, backup restore, macOS real-backend smoke, diagnostics bundle을 함께 남긴다.
scripts/local_gate.sh --profile local-alpha

# foreground 앱 launch까지 evidence에 포함해야 하면 opt-in.
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile local-alpha

# 내부 알파 reviewer handoff용 stricter combined evidence packet.
# host-runtime, backup restore, macOS real-backend process/window, diagnostics bundle을 함께 남긴다.
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha
```

---

## 3. 인프라 기동 — `make up` (PostgreSQL 18 + Centrifugo v6)

```sh
make up            # = docker compose -f infra/docker-compose.yml up -d
```

- `postgres` (image `pgvector/pgvector:0.8.5-pg18`, digest pinned): SoT. native `uuidv7()` + pgvector. healthcheck = `pg_isready`.
- `centrifugo` (image `centrifugo/centrifugo:v6`): transport only(메모리 엔진). `infra/centrifugo.json` 마운트.
  subscribe proxy 콜백 = `http://api:8080/v1/centrifugo/subscribe`, 채널 = `ch:ws<workspaceUUID>.<channelUUID>`.

상태 확인:

```sh
docker compose -f infra/docker-compose.yml ps        # 두 서비스 모두 healthy 대기
docker compose -f infra/docker-compose.yml logs -f
```

MOMO-527 이전 구성에서 업그레이드할 때는 새 이미지를 pull한 뒤 `postgres` 컨테이너를 재생성하고 `make migrate`를 실행한다. named volume 데이터는 유지되지만, 기존 컨테이너를 재시작만 하면 변경된 이미지가 적용되지 않는다.

중지: `make down`. 데이터까지 지우려면 `docker compose -f infra/docker-compose.yml down -v`
(볼륨 `momo-pgdata` 삭제).

> **검증됨:** MOMO-001/002에서 Docker Desktop 기준 PG18+Centrifugo v6 health, migrate 멱등,
> server health, 메시지 송신, OutboxRelay→Centrifugo publish/history를 확인했다.
> MOMO-115부터 같은 relay path는 `scripts/local_gate.sh --profile runtime-relay`로 반복 검증한다.

> **compose layer 분리:** `infra/docker-compose.yml`은 dev/local runtime iteration용 PG18+Centrifugo layer다. `infra/docker-compose.e2e.yml`은 MOMO-186 local gate 전용으로 API/relay/worker/mock-Hermes까지 같은 compose project에 넣는다. `infra/prod/docker-compose.prod.yml`은 source checkout 없는 image-based staging/prod skeleton이다.

### 3.1 음성 허들용 LiveKit 옵트인

LiveKit은 기본 `make up`에 포함되지 않는다. 음성 허들을 사용할 때만 `huddle` profile을
명시하고, `.env`의 `MOMO_LIVEKIT_API_KEY`/`MOMO_LIVEKIT_API_SECRET`가 MomoServer와
LiveKit 양쪽에 동일하게 주입되는지 확인한다.

```sh
docker compose -f infra/docker-compose.yml --profile huddle up -d livekit
docker compose -f infra/docker-compose.yml --profile huddle ps livekit

# 종료(기본 postgres/centrifugo를 함께 내리지 않으려면 서비스만 지정)
docker compose -f infra/docker-compose.yml --profile huddle stop livekit
```

V-1이 발급한 실제 join JWT의 LiveKit 수락 검증은 독립 verifier다. 이 스크립트는 격리된
V-1 API stack과 `huddle` profile을 기동하고 `/rtc/validate`의 유효 토큰 200 및 무효 토큰
401/403을 확인한 뒤 trap으로 teardown한다. LiveKit이 무거운 옵트인 서비스라
`local_gate --profile runtime-db`에는 편입하지 않았으며, V-3에서 재평가한다.

```sh
scripts/verify_huddle_livekit.sh
```

`runtime-unverified(worker)`: MOMO-470 worker는 Docker를 실행하지 않는다. 위 verifier의
PASS evidence는 momo-main 오케스트레이터가 실제 실행한 뒤에만 기록한다.

### 3.2 E2E compose static validation

MOMO-186 e2e layer는 local gate가 전체 service boundary를 재현하기 위한 초안이다. dev compose를 대체하지 않고, prod compose의 image-based/source-checkout-free 원칙도 건드리지 않는다.

```sh
# worktree라면 .conductor/setup.sh가 .env.worktree를 만든다.
docker compose --env-file .env.worktree -f infra/docker-compose.e2e.yml config

# 같은 검증은 docs local gate에도 포함된다.
scripts/local_gate.sh --profile docs
```

서비스 경계: `postgres` → `migrate` → `db-roles` → `api`; `relay`와 `worker`는 BYPASSRLS test roles로 Postgres를 poll하고, `worker`는 repo-local `mock-hermes` (`scripts/mock_hermes.py`)에만 연결한다. 실제 stack boot/full runtime verifier는 후속 runtime goal에서 닫는다.

웹 서빙만 검증할 때는 아래 infra profile을 사용한다. 실제 `clients/web` build를 `web-init`이 named volume에 복사하고 LinkShort와 prod Caddyfile을 HTTP로 구동하며, 호스트 curl로 `/join` SPA 폴백과 `/i/*` 프록시를 포함한 8개 단정을 수행한다. 포트는 28070~28074만 사용한다. 로컬 내부 CA를 만들지 않기 위해 HTTPS는 의도적으로 제외하며 공인 DNS·ACME·production TLS와 초대→가입→메시지 실왕복은 별도 orchestrator gate다.

```sh
scripts/local_gate.sh --profile web-serving
# 또는 verifier 단독 실행
scripts/verify_web_serving.sh
```

### 3.3 Internal alpha diagnostics bundle

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

AWS 리소스를 만들기 전에 1인 local Docker alpha RC를 먼저 닫아야 할 때는 `local-alpha`
profile을 사용한다.

```sh
scripts/local_gate.sh --profile local-alpha
```

이 profile은 AWS API를 호출하지 않고, local Docker와 repo-local mock Hermes만 사용한다. PASS 시
top-level local gate evidence가 run-specific
`local-alpha-<run-id>/{host-runtime,backup-restore,macos-real-backend,diagnostics}/`
artifact directory를 함께 출력한다. 여기에는 prod+internal-smoke image boot, `/health`,
migration idempotency, REST message, OutboxRelay publish, mock Hermes 기반 김인턴 roundtrip,
repo-local `pg_dump`→separate restore evidence, macOS real-backend smoke, redacted diagnostics
directory/archive path가 포함된다.

기본값은 foreground GUI launch를 요구하지 않는다. 실제 `MomoMacDevApp` process/window/log
evidence까지 필요하면 아래처럼 opt-in한다.

```sh
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile local-alpha
```

내부 알파 PR handoff처럼 "돌아가는 로컬 호스트 런타임 + 실제 macOS dev app + 복원 리허설 +
진단 번들"을 reviewer에게 stricter packet으로 넘겨야 할 때는 combined local gate를 사용한다.

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

스키마 + bootstrap 시드를 **번호순**으로 적용한다(`server/Migrations/*.sql`).

```sh
export DATABASE_URL=postgres://momo:<pw>@localhost:5432/momo   # .env와 동일 값
make migrate                                                   # = sh scripts/migrate.sh
```

- 적용 대상(현재): `001_init.sql`(정본 스키마 + 보강 — outbox/cost/APNs), `002_seed.sql`(workspace/human/basic channels; agent는 opt-in), `003_onboarding.sql`(M2 invite_code + redemption audit, schema_v0.sql 미수정), `006_local_hermes_agent_seed.sql`(agent demo/e2e opt-in).
- `scripts/migrate.sh`는 `schema_migrations` 테이블로 적용 이력을 추적 → **멱등 재실행 안전**
  (이미 적용된 버전은 SKIP). 각 파일은 `--single-transaction`으로 원자 적용.
- 연결: `DATABASE_URL` 우선, 없으면 표준 `PG*` 환경변수(`PGHOST`/`PGUSER`/…) 폴백.
- 기본 `MOMO_AGENT_SEED_MODE=none`: persistent dogfood/local-alpha에는 사람과 기본 채널만
  생기며 agent는 0이다. deterministic demo/e2e 전용 러너만
  `MOMO_AGENT_SEED_MODE=demo|e2e`를 명시한다. 이 opt-in을 일반 dogfood DB에 사용하지 않는다.

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
- Agent progress subscriptions use `agent:ws<workspace>.<channel>.<agentMember>`. The
  subscribe proxy checks that the observer and target agent are active members
  in the same workspace and share at least one active channel membership. This
  boundary is for live `agent.status`/`agent.partial` progress only; durable
  final output still reconciles through channel `message.new` and `message.seq`.
- Private gateway jobs use `agentwork:ws<workspace>.<agentMember>`. Only a
  connection authenticated as that exact active agent may subscribe, so Context
  Packets and work payloads are never exposed through the observer progress stream.
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
- `work_*`를 쓰는 worker process에는 해당 agent의 `MOMO_AGENT_TOKEN`, momo API의
  `MOMO_API_URL`, host-owned 실행기의 opaque `MOMO_WORK_HOST_ID`가 필요하다. token은
  credential 발급 응답에서 한 번만 얻으며 저장소·DB·로그에 남기지 않는다.
- gateway/BYOA adapter도 같은 `MOMO_WORK_HOST_ID`를 사용한다. 설정되면 provider에는
  `work.spawn|input|read|kill`의 닫힌 인자 스키마만 보이고, host UUID는 adapter가
  인증된 `gateway/events` callback에 별도로 붙인다. 서버는 callback bearer에
  `agent:runs:callback`과 `work:control`이 모두 있는지, run/lease/host/lineage를 다시
  확인한다. 미설정 시 work tool은 fail-closed로 미노출된다.

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

MOMO-486의 chat-to-session 경계는 별도 격리 verifier로 확인한다. mock Hermes가 실제
OpenAI-compatible tool-call delta를 내고 AgentWorker가 기존 work-control REST를 호출한다.
spawn 승인 뒤에는 run을 재개하지 않고 host가 session 생성/ack를 수행하며, 이어지는 session
thread input은 같은 requester 계보만 통과한다.

```sh
# runtime-db profile에도 포함됨. 기본 포트: API 27930, Centrifugo 27931,
# PostgreSQL 27932, mock Hermes 27933.
scripts/verify_work_agent_e2e.sh
```

이 verifier는 per-agent bearer 원문을 evidence에 출력하지 않으며, 계보 밖 agent의 input이
정확한 HTTP 403 문구로 thread에 회신되고 성공 control을 만들지 않았는지까지 검사한다.

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

`agent:ws<workspace>.<channel>.<agentMember>` namespace의 live subscribe 경계는 아래
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
authorized demo member의 `agent:ws<workspace>.<channel>.<agentMember>` subscribe →
`agent.status` 또는 `agent.partial` live publication 수신이다. 같은 run에서
invalid Centrifugo connection token, same-workspace member without shared channel,
other-workspace member/token, client direct publish deny를 함께 확인한다.

MOMO-215부터 `runtime-agent` profile은 `scripts/verify_agent_worker.sh`를 통해
채널 REST send의 자연어 agent mention routing도 함께 닫는다. 최종 assistant text는
Postgres timeline의 `message.seq` authority를 따르는 channel `message.new`이고,
`agent:` namespace는 ephemeral progress/status surface로 유지한다. 실제 external
Hermes/provider side effect는 여전히 repo-local mock 범위 밖이며, MOMO-230의
`external-agent-provider` opt-in profile에서 credentials가 있을 때만 닫는다. MOMO-236부터
credentialed profile은 send 전에 Kim Intern이 active agent member로 `#agent-lab`에 초대되어
있는지도 evidence로 남긴다. credentials가 없으면
`runtime-unverified(external provider credentials)`로 남긴다.

`agent.status`/`agent.partial`은 non-durable progress projection이다. 이 이벤트는
`message.seq`를 갖는 channel timeline의 순서 권위가 아니며, 최종 durable 결과는
기존 `message.new`/`message.seq` 경로로 reconcile한다.

수동으로 mock만 띄우려면:

```sh
python3 scripts/mock_hermes.py --host 127.0.0.1 --port "${HERMES_PORT:-8088}"
```

### 5.4 Work Host Daemon — `momo-workd` (ADR-0125 D2)

`momo-workd`는 인바운드 포트를 열지 않고 MomoServer로만 outbound 연결한다. 최초 등록에만
human access token이 필요하고, 등록 뒤 heartbeat/poll/session/control action은 로컬 Ed25519
키로 서명한다. raw stdout/stderr, command path, environment, provider credential은 서버로
보내지 않고 기본 `~/.momo/workd-output/` 아래 mode `0600` 파일로 보관한다.

```sh
swift build --package-path workers/WorkHostDaemon

mkdir -p "$HOME/.momo"
chmod 700 "$HOME/.momo"
printf '%s\n' "$ONE_TIME_HUMAN_ACCESS_TOKEN" >"$HOME/.momo/workd-registration.token"
chmod 600 "$HOME/.momo/workd-registration.token"

MOMO_WORKD_SERVER_URL=https://momo.example.com \
MOMO_WORKD_WORKSPACE_ID=00000000-0000-7000-8000-000000000001 \
MOMO_WORKD_REGISTRATION_TOKEN_FILE="$HOME/.momo/workd-registration.token" \
swift run --package-path workers/WorkHostDaemon momo-workd
```

등록이 성공하고 host ID가 로컬에 저장되면 token 파일은 삭제된다. 원격 HTTP는 거부하며,
`MOMO_WORKD_ALLOW_INSECURE_HTTP=1`은 loopback verifier/local 개발에서만 허용한다. command
profile은 `MOMO_WORKD_PROFILE_{CLAUDE|CODEX|OPENCODE|SHELL}_EXECUTABLE` 절대경로와
`..._ARGUMENTS_JSON` 문자열 배열로 로컬에서만 설정한다. 서버 payload가 실행 경로나 인자를
선택하지 않는다.

동일 OS/architecture용 binary가 준비된 경우 SSH 사용자 서비스 초안을 사용할 수 있다.

```sh
chmod 600 /path/to/registration.token
scripts/momo host add ssh://user@host \
  --binary /path/to/target/momo-workd \
  --server-url https://momo.example.com \
  --workspace 00000000-0000-7000-8000-000000000001 \
  --token-file /path/to/registration.token
```

Linux는 systemd user service, macOS는 LaunchAgent로 설치한다. Linux에서 SSH logout 뒤에도
계속 실행하려면 운영자가 필요에 따라 `loginctl enable-linger <user>`를 승인해야 한다.
target binary 배포/서명, cross-compile, 자동 update, 원격 도구 로그인 bridge, 완전 PTY는 후속이다.

```sh
# runtime-db profile에도 포함됨. 기본 포트: API 27950, Centrifugo 27951,
# PostgreSQL 27952, Hermes 예약 27953.
scripts/verify_workd.sh
```

verifier는 workd 등록과 signed heartbeat/poll, auto-approved mock echo spawn, control ack,
`work_session` started→ended, 위조 poll 401, FORCE RLS, raw marker의 서버 원장 부재를 단정한다.
격리 Docker 실런은 momo-main 오케스트레이터 merge gate에서 수행한다.

### 5.5 Remote terminal attach capability (ADR-0125 D10)

원격 host/workd/provisioner는 도구를 PTY로 실행하고, signed `POST .../work-sessions` 요청에
`ptyId`와 credential-free HTTPS/WSS `attachEndpoint`를 함께 보낸다. MomoServer는 remote
PTY를 생성하거나 터미널 byte stream을 중계하지 않는다. owner human은
`POST /v1/workspaces/:ws/work-sessions/:id/terminal-attach`에서 60초 capability를 받고,
클라이언트가 반환 endpoint에 직접 연결한다. host는 연결을 수락하기 전에
`POST /v1/workspaces/:ws/work-hosts/:host/terminal-attach/validate`를 `MomoHost` 서명으로
호출해 capability·`pty_id`·session lifecycle·host revoke를 검증한다.

서버 DB에는 raw capability가 아닌 SHA-256 digest만 있고 audit에는 owner와 issued/expires만
남는다. terminal stdout/stderr/stdin/resize는 MomoServer, OutboxRelay, Centrifugo를 통과하지
않는다. 실제 workd/provisioner PTY adapter와 SwiftTerm direct attach는 후속 goal이다.

```sh
# runtime-db profile에도 포함됨. 기본 전용 포트: API 27970,
# Centrifugo 27971, PostgreSQL 27972, Hermes 예약 27973.
scripts/verify_terminal_attach.sh
```

verifier는 네 포트가 비어 있는지 먼저 검사한 뒤 owner 발급, agent·비소유자 403, 만료 후
401, revoke 즉시 무효, exact response, digest-only 원장, audit, FORCE RLS와 raw/token의
서버·relay 원장/로그 부재를 단정한다. Ed25519 서명에는 `find_openssl` 방식으로 실제 지원
binary를 고른다. 이 격리 Docker 실런은 momo-main 오케스트레이터 merge gate에서 수행하며,
그 전까지 terminal attach runtime은 `runtime-unverified`다.

---

## 6. macOS 클라이언트 (데모 surface: D / B / C)

macOS 패키지(`clients/macOS`)는 v0에서 **SwiftUI 라이브러리 + 빌드검증 smoke 실행파일 +
SwiftPM 개발용 window 앱 + 릴리스용 Xcode thin host app**으로 구성된다. 데모 경험
**D(Live Tool-Call) / B(비용 호흡) / C(승인 인박스)**는 `MomoMacDevApp`과 Xcode host
`MomoMac.app` 모두에서 같은 `MomoMacRootView`로 확인할 수 있다.

```sh
# 로컬 dogfood 한 줄 실행: 서버가 없으면 mock Hermes 스택을 올리고 앱까지 연다.
scripts/momo start

# 상태 확인 / 종료
scripts/momo status
scripts/momo stop

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
- `scripts/momo`: 내부 dogfood용 friendly launcher다. `start`는 `http://127.0.0.1:28180/health`가
  이미 살아 있으면 앱만 열고, 없으면 `scripts/local_alpha_runner.sh execute --hermes mock`으로
  local alpha stack을 올린 뒤 `MomoMacDevApp`을 연다. `stop`은 앱을 종료하고, runner가 남긴
  stop script 또는 `28180`을 publish하는 momo Docker compose project를 찾아 local stack을 내린다.
- session bar의 `Updates` popover는 internal alpha Dev Update Channel v0다.
  `MOMO_UPDATE_MANIFEST_PATH` 또는 `file://` `MOMO_UPDATE_MANIFEST_URL`로 local manifest를 읽고
  current/available version, latest/update/failure 상태, `Open Download` + relaunch 안내를 표시한다.
  `MOMO_CURRENT_VERSION`/`MOMO_CURRENT_BUILD`는 dev build의 현재 버전 override로만 사용한다.
  Sparkle private key/Apple signing material은 절대 앱 환경이나 git에 넣지 않는다.
  운영 절차와 fixture는 [`docs/MACOS_ALPHA_UPDATE_CHANNEL.md`](MACOS_ALPHA_UPDATE_CHANNEL.md)를 따른다.
- 기본 smoke/dev app은 인메모리만 쓰므로 DB/Centrifugo/hermes **런타임 의존이 없다**.
  `MOMO_SERVER_BASE_URL`이 있으면 `MomoMacDevApp`은 MomoServer REST 모드로 전환해
  `/v1/auth/login`, `GET/POST /v1/workspaces/{ws}/channels/{ch}/messages`를 사용한다.
  기본값은 `server/Migrations/002_seed.sql`의 demo workspace/human/channel fixture다. agent는
  pairing invite 전에는 존재하지 않는다.
  `/v1/auth/login`, `GET /v1/workspaces/{ws}/roster`,
  `GET/POST /v1/workspaces/{ws}/channels/{ch}/messages`를 사용한다. real-server의 멤버
  신원과 채널 초대 범위는 roster가 SoT이며 demo member fixture로 fallback하지 않는다.
- REST dev mode 환경변수:
  `MOMO_SERVER_BASE_URL`(필수), `MOMO_ACCESS_TOKEN`(선택, 없으면 `/v1/auth/login`),
  `MOMO_LOGIN_EMAIL`/`MOMO_LOGIN_PASSWORD`(내부 alpha seed는 `demo@momo.local`/`dev-password`;
  미설정 시 transport default도 같은 seed credential을 사용),
  `MOMO_WORKSPACE_ID`(기본 demo workspace), `MOMO_CHANNEL_ID`(기본 `#general`),
  `MOMO_CENTRIFUGO_WS_URL`(서버가 login/join의 `realtimeWebSocketUrl`로 광고하며 앱은
  서버 값을 우선 사용; 이전 서버에서는 앱 env가 fallback. 설정 시 `/v1/auth/realtime-token`으로
  Centrifugo connection JWT를 받아 `ch:ws<workspace>.<channel>` live subscription을 연결).
- REST dev mode 검증 범위: message history fetch와 send는 실제 MomoServer REST/DB 경로를 탄다.
  서버가 `realtimeWebSocketUrl`을 광고하면 별도 앱 env 없이 WebSocket/Centrifugo live
  subscription도 실제 SwiftCentrifuge adapter를 탄다. production reconnect UX polish는 후속 범위다.
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

env(`MOMO_API_URL`, `MOMO_CENTRIFUGO_WS_URL`, `MOMO_WORKSPACE_ID`,
`MOMO_AGENT_MEMBER_ID`, `MOMO_AGENT_TOKEN`, `MOMO_HOME_CHANNEL` 등)는
`adapters/hermes/README.md` 및 `plugin.yaml`의 `spec.env` 참고.
`scripts/momo hermes-gateway-init`은 홈 채널 UUID/이름도 기동 전에 기록한다.
세션 reset, 홈 설정, `/resume`·`/sethome` 힌트, model/provider 진단은
어댑터 로컬 로그로만 처리하며 momo timeline의 durable message로 쓰지 않는다.

> **`runtime-unverified (hermes 게이트웨이 필요)`** — 게이트웨이/실행 momo 스택 없이는
> end-to-end 미검증. `py_compile` 정적 점검만 수행됨.

---

## 8. staging/prod 운영 skeleton (MOMO-005)

`infra/prod/`는 단일 VPS에서 staging/prod 스택을 올리기 위한 **운영 skeleton**이다. 현재 goal은
파일과 런북 준비까지만 수행하며, 실제 도메인 DNS 변경, TLS 발급, 이미지 배포, prod 기동은 하지 않는다.

| 파일 | 역할 |
|---|---|
| `infra/prod/docker-compose.prod.yml` | Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker 서비스 정의. |
| `infra/prod/Caddyfile` | `API_DOMAIN` → `api:8080`, `REALTIME_DOMAIN` → `centrifugo:8000` reverse proxy + 보안 헤더. **MOMO-300:** subscribe proxy(`/v1/centrifugo/*`)는 내부 전용이라 엣지에서 403으로 차단한다. |
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
- `scripts/verify_external_agent_provider.sh`: opt-in credentialed external agent runtime gate. credentials가 없으면 `runtime-unverified(external provider credentials)` evidence로 skip하고, credentials가 있으면 OpenAI-compatible SSE preflight + local MomoServer/AgentWorker/OutboxRelay `@김인턴` 1왕복 + `/v1/agent-runtime/status` redaction을 검증한다.
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
| subscribe proxy 401 (`invalid or missing proxy secret`) | **MOMO-300**: Centrifugo static header(`X-Centrifugo-Proxy-Secret`)와 API `CENT_PROXY_SECRET` 불일치. compose env override(`CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS`)와 서버 env가 같은 값을 쓰는지 확인. |
| 로그인은 되는데 모든 API가 401 (`unknown token`) | **MOMO-300**: access token이 `token` 테이블에 기록되지 않았거나 revoke됨(로그아웃/rotation). 재로그인으로 새 세션 발급. 서버 배포 전 발급 토큰은 fail-closed로 전부 무효. |
| REST가 429를 반환 | **MOMO-300** rate limit. `Retry-After` 헤더만큼 대기 후 재시도, 또는 `RATE_LIMIT_PER_MEMBER`/`RATE_LIMIT_PER_IP` 조정(0=비활성). |
| `agent:` subscribe 거부 | channel 이름이 `agent:ws<workspace>.<channel>.<agentMember>`인지, observer와 target agent가 그 정확한 active channel의 멤버인지 확인한다. 다른 채널만 공유하거나 다른 workspace token이면 deny가 정상이다. |
| `agentwork:` subscribe 거부 또는 gateway job pending | channel 이름이 `agentwork:ws<workspace>.<agentMember>`인지, connection token subject가 그 exact active agent인지 확인한다. local alpha runner의 generated config에도 `agentwork` subscribe proxy가 있어야 하며, stale config면 Hermes가 `agent.job`을 받지 못한다. |
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
