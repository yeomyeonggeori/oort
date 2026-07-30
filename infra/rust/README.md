# Rust 스택 배포 경로 (이미지 + compose)

> ADR-0145 B안 / 배치 **B1.7**. `momo-server`(Rust/Axum) + `momo-relay`를 이미지로 굽고
> prod-형 compose로 띄우는 경로. NCP 런북 `docs/planning/2026-07-30-ncp-rust-smoke-prep.md`
> §1 트리거 3번("Rust 서버 이미지 빌드 → prod compose를 Rust 이미지로 스왑")이 이 디렉터리다.
>
> **범위 = 메신저-부분 smoke.** T3·workd·worker·notifier·web은 아직 Rust로 서지 않았으므로
> 이 스택에 없다(B2+). 여기서 증명하는 것은 `login → send → list` HTTP 왕복과
> `outbox → relay → 실 Centrifugo publish` 왕복까지다.

## 1. 구성 파일

| 파일 | 역할 |
|---|---|
| `server-rust/Dockerfile` | 멀티스테이지 이미지 — 하나의 이미지, 3개 커맨드(`api`/`relay`/`migrate`) |
| `server-rust/docker-entrypoint.sh` | 역할 선택만. prod Swift 이미지와 동일 계약(`command: ["api"]`) |
| `docker-compose.rust.yml` | prod compose 미러(최소셋): postgres · centrifugo · runtime-roles · migrate · api · relay |
| `docker-compose.rust.build.yml` | 로컬 빌드 오버라이드(`build:` 주입). 배포 스택은 항상 이미지 pull |
| `rust-smoke.env.example` | env 템플릿. 복사본은 반드시 `*.secrets.env`(레포 전역 gitignore) |

이미지 안에 들어가는 것: 바이너리 3종, `server/Migrations/*.sql`(그대로 복사),
`infra/e2e/bootstrap_roles.sql`, `infra/prod/bootstrap_runtime_roles.sql`,
`infra/prod/set_initial_owner.sql`, LICENSE/NOTICE. 런타임 베이스는
`debian:bookworm-slim` + **`postgresql-client`** — 마이그레이션 러너가 psql로
shell-out 하기 때문이다(002/006/012가 psql 메타커맨드 `\if`/`\getenv`를 쓴다. B0 교훈).

## 2. 준비

```sh
cp infra/rust/rust-smoke.env.example infra/rust/rust-smoke.secrets.env
# change-me-* 전부 교체:  openssl rand -hex 24
```

주의: `MOMO_APP_POSTGRES_PASSWORD` / `RELAY_POSTGRES_PASSWORD` 값은
`MOMO_APP_DATABASE_URL` / `RELAY_DATABASE_URL` 안의 비밀번호와 **같아야** 한다
(runtime-roles가 전자로 롤 비번을 세팅하고, api/relay가 후자로 접속한다).

편의상 아래 절차는 이 별칭을 쓴다:

```sh
alias momorust='docker compose --env-file infra/rust/rust-smoke.secrets.env \
  -f infra/rust/docker-compose.rust.yml'
alias momorustbuild='docker compose --env-file infra/rust/rust-smoke.secrets.env \
  -f infra/rust/docker-compose.rust.yml -f infra/rust/docker-compose.rust.build.yml'
```

## 3. 로컬 기동

```sh
# (0) 정적 검증 — 데몬 없이 렌더만
momorust config >/dev/null && echo "compose OK"

# (1) 빌드 (컨텍스트 = 레포 루트)
momorustbuild build            # 또는: docker build -f server-rust/Dockerfile -t momo-rust:dev .

# (2) 기동 — depends_on이 순서를 강제한다:
#     postgres(healthy) → runtime-roles(완료) → migrate(완료) → api/relay
momorustbuild up -d

# (3) 마이그레이션 증거
momorust logs migrate
#   + APPLY 001_init.sql … 059_…
#   [migrate] (apply) applied=59 skipped=0 total=59
#   [migrate] IDEMPOTENCY_OK second-pass applied=0 skipped=59
```

`migrate` 서비스는 `MOMO_BOOTSTRAP_RUNTIME_ROLES=0`으로 돌기 때문에 세 런타임 롤이
정확한 least-privilege 자세로 존재하지 않으면 **마이그레이션을 거부한다**(prod와 동일).
즉 `infra/e2e/bootstrap_roles.sql`의 공개 dev 비밀번호는 이 스택에 절대 적용되지 않는다.

## 4. Smoke 곡선

### 4-1. health

```sh
curl -fsS http://127.0.0.1:8080/healthz
# {"status":"ok","service":"momo-server","database":"ok"}
```

### 4-2. 로그인 자격 만들기

기본 시드 모드는 `none`이고, 마이그레이션 012가 시드 오너의 공개 비밀번호를 잠근다
(fail-closed). 그래서 로그인 자격은 명시적으로 만든다 — prod의 `set-owner`와 같은 경로:

```sh
MOMO_INITIAL_OWNER_EMAIL=owner@example.com \
MOMO_INITIAL_OWNER_PASSWORD='<generated>' \
  momorust run --rm -e MOMO_INITIAL_OWNER_EMAIL -e MOMO_INITIAL_OWNER_PASSWORD \
  migrate set-owner
# [migrate] bootstrap owner credentials updated (no value printed)
```

(로컬 전용 대안: `MOMO_AGENT_SEED_MODE=e2e`로 fresh 볼륨에서 기동하면 시드 오너
`demo@momo.local` / `dev-password`가 살아 있다. **공개 비밀번호이므로 NCP 금지.**)

### 4-3. login → send → list

```sh
API=http://127.0.0.1:8080
WS=00000000-0000-7000-8000-000000000001      # 시드 워크스페이스
CH=00000000-0000-7000-8000-000000000201      # 시드 #general

# login
TOKEN=$(curl -fsS -X POST "$API/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"<generated>"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')

# send  → 응답의 seq 가 갭리스 발급 결과(불변식 #4)
curl -fsS -X POST "$API/v1/workspaces/$WS/channels/$CH/messages" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"clientMsgId\":\"$(uuidgen | tr 'A-Z' 'a-z')\",\"type\":\"text\",\"body\":\"b1.7 smoke\"}"

# list  → 방금 보낸 메시지가 messages[]에 있어야 한다
curl -fsS "$API/v1/workspaces/$WS/channels/$CH/messages?limit=10" \
  -H "authorization: Bearer $TOKEN"
```

### 4-4. relay → 실 Centrifugo publish

relay는 워크스페이스에서 유일한 Centrifugo writer다(불변식 #2). 구독 클라이언트 없이
**Centrifugo 자신의 history**로 왕복을 증명한다 — `ch` 네임스페이스는 history_size=300:

```sh
curl -fsS -X POST http://127.0.0.1:8000/api/history \
  -H "X-API-Key: $CENT_API_KEY" -H 'content-type: application/json' \
  -d "{\"channel\":\"ch:ws$WS.$CH\",\"limit\":10}"
```

`result.publications[]`에 방금 보낸 메시지가 있고 `version`이 4-3의 `seq`와 같아야 한다
(relay가 `version=seq`, `idempotency_key="<channel>:<seq>"`로 publish한다).
채널 문자열 형식은 `ch:ws<workspace-uuid>.<channel-uuid>`이며 Centrifugo `ch` 네임스페이스
정규식과 일치해야 한다.

`momorust logs relay`에는 `published` 로그가 남고, DB에서는 해당 outbox 행이 `done`이다:

```sh
momorust exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT kind, status, count(*) FROM outbox GROUP BY 1,2;"
```

### 4-5. 로그 시크릿 0

```sh
momorust logs | grep -Ei 'jwt_hmac|cent_api_key|password|postgres://' && echo "LEAK" || echo "clean"
```

`api`/`relay`는 부팅 시 **모양만** 로깅한다(호스트·포트·DB 이름·Centrifugo API URL).
`migrate`는 롤 비번과 오너 비번을 `\getenv`로만 넘기므로 argv·stdout 어디에도 값이 없다.

## 5. 정지 / 청소

```sh
momorust down            # 컨테이너만
momorust down -v         # 볼륨(momo-rust-pgdata)까지 — fresh 마이그레이션 재현용
```

volume 기본 이름은 `momo-rust-pgdata`로 prod(`momo-pgdata`)와 분리돼 있다. 모든 서비스에
janitor 라벨이 붙어 있어 프로젝트 라벨로 회수된다.

## 6. NCP 런북과의 연결

`docs/planning/2026-07-30-ncp-rust-smoke-prep.md` §3 절차 대응:

| 런북 단계 | 이 디렉터리에서 |
|---|---|
| 3-1 이미지 퍼블리시 확인 | `server-rust/Dockerfile`로 빌드 → 레지스트리 push는 **오케스트레이터/CI 몫(후속)**. 그 전에는 서버에서 직접 빌드하거나 `docker save/load` |
| 3-3 Docker 설치 | 그대로 |
| 3-4 스택 기동 | `docker-compose.rust.yml`(caddy·redis·worker 제외판). `MOMO_RUST_IMAGE`만 퍼블리시된 ref로 바꾸면 build 오버레이 없이 pull 경로 |
| 3-5 마이그레이션 001~059 | `migrate` 서비스(psql 러너). seed 모드는 NCP에서 `none` |
| 3-6 BYOC/T3 smoke | **아직 불가** — T3(B2)·workd(B5)가 Rust로 서야 한다. 이 배치는 메신저 부분까지 |

api·centrifugo 포트는 compose가 loopback에만 바인딩한다. NCP에서는 SSH 터널로 접근하고,
공개 노출이 필요해지면 prod의 Caddy 경로를 붙인다(이 배치 범위 밖).

## 7. env 파리티 (정본 = `infra/prod/docker-compose.prod.yml`)

Rust 바이너리는 prod compose가 쓰는 **이름 그대로** 읽는다.

| prod api env | Rust momo-server | 비고 |
|---|---|---|
| `MOMO_ENV` | ✅ `environment` | 로그 컨텍스트 |
| `HOST` / `PORT` | ✅ | 기본 `0.0.0.0:8080` |
| `DATABASE_URL` | ✅ (momo_app 풀) | `POSTGRES_*` 조각은 폴백 |
| `JWT_HMAC` | ✅ **정본 이름** | `MOMO_JWT_SECRET`은 하위호환 폴백(둘 다 있으면 `JWT_HMAC` 승) |
| `MOMO_CENTRIFUGO_WS_URL` | ✅ `realtime_ws_url` | ADR-0110 유일 권위 |
| `LOG_LEVEL` | ✅ (`RUST_LOG` 우선) | B1.7 전에는 무시되던 값 |
| `CENT_API_URL`/`CENT_API_KEY`/`CENT_TOKEN_HMAC`/`CENT_PROXY_SECRET` | ❌ 미소비 | momo-server에는 HTTP 클라이언트가 없다(불변식 #2). 그래서 이 compose는 **주입조차 하지 않는다** |
| `OUTBOUND_WEBHOOK_MASTER_KEY`·`PROVIDER_LINK_MASTER_KEY`·`AGENT_*`·`HERMES_*`·`MEMORY_*`·`MOMO_ARCHIVE_BACKEND`·`MOMO_S3_*`·`MOMO_CORS_ALLOWED_ORIGINS`·`MOMO_METRICS_*` | ❌ 미소비 | 해당 기능 배치에서 복귀. **부팅을 막지 않는다** |

| prod relay env | Rust momo-relay |
|---|---|
| `RELAY_DATABASE_URL` | ✅ (없으면 `DATABASE_URL` 폴백) |
| `CENT_API_URL` / `CENT_API_KEY` | ✅ |
| `RELAY_POLL_INTERVAL_MS` / `RELAY_CLAIM_BATCH` / `RELAY_MAX_ATTEMPTS` | ✅ (300/64/8) |
| `LOG_LEVEL` | ✅ |
| `MOMO_ENV`·`OUTBOUND_WEBHOOK_MASTER_KEY`·`MOMO_METRICS_*` | ❌ 미소비, 비차단 |

migrate/runtime-roles는 prod의 스위치를 그대로 읽는다: `DATABASE_URL`,
`MOMO_RUNTIME_ROLE_PROVISION`(0|1), `MOMO_BOOTSTRAP_RUNTIME_ROLES`(0|1),
`MOMO_AGENT_SEED_MODE`(none|demo|e2e), `MOMO_APP/RELAY/WORKER_POSTGRES_PASSWORD`,
`MOMO_INITIAL_OWNER_EMAIL`/`_PASSWORD`. 추가로 이미지 경로 오버라이드
`MOMO_MIGRATIONS_DIR`, `MOMO_BOOTSTRAP_ROLES_SQL`, `MOMO_RUNTIME_ROLES_SQL`,
`MOMO_SET_OWNER_SQL`(Dockerfile이 `/opt/momo/...`로 세팅)과 `MIGRATE_IDEMPOTENCY_CHECK`.

## 8. 트러블슈팅

* `psql: warning: server 18, client 15` — bookworm의 postgresql-client는 15다. 마이그레이션은
  서버측 SQL이고 psql은 메타커맨드만 해석하므로 동작에 영향이 없다(prod Swift 이미지는
  ubuntu 24.04의 16). 경고가 거슬리면 `--build-arg RUNTIME_IMAGE=...`로 베이스를 올린다.
* `required externally provisioned runtime roles are absent or unsafe` — `runtime-roles`가
  실패했거나 건너뛰어졌다. `momorust logs runtime-roles` 확인.
* `set JWT_HMAC ...` 로 api가 즉시 종료 — 의도된 fail-fast다. env 파일 경로(`--env-file`)를 확인.
* 마이그레이션이 `psql client not found`로 실패 — 이미지가 아닌 곳(호스트)에서 러너를 돌린 경우다.
  로컬 실행에는 PostgreSQL 클라이언트가 필요하다.
