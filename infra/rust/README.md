# Rust 스택 배포 경로 (이미지 + compose)

> **처음 한 번이라면 여기가 아니라 [`docs/SELF_HOST.md`](../../docs/SELF_HOST.md) 다** (#1229).
> 그 문서는 clone에서 브라우저 로그인까지를 명령 셋·분기 0으로 끝낸다. 이 문서는
> **그다음 전부**다 — 마이그레이션 로그 읽는 법, 오너 부트스트랩 계약, Centrifugo
> history로 왕복 증명하기, env 파리티 표, 오버레이 전량, 트러블슈팅.

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
| `rust-smoke.env.example` | env 템플릿. 복사본은 반드시 `*.secrets.env`(레포 전역 gitignore). 셀프호스트 경로는 이 템플릿 대신 `scripts/self_host_env.sh` 가 `local.secrets.env` 를 **생성**한다(#1229) |
| `local.override.yml` + `Caddyfile.local` | **로컬 셀프호스트 엣지**(#1229) — `web-init` + `web`(Caddy `:80`, 루프백 바인딩, ACME 없음). SPA·`/v1`·`/connection` 을 같은 오리진에서 낸다. 정본 절차는 `docs/SELF_HOST.md` |
| `docker-compose.lane-phone.yml` | **기본 비활성** MAESTRO 폰 레인 오버레이(#1022) — `mock-hermes` + `agent-worker`의 프로바이더 배선. `clients/mobile/scripts/lane-phone.sh` 전용 |
| `docker-compose.push.yml` | **기본 비활성** ADR-0120 푸시 경로 오버레이 — `push-relay` + `notifier`. `-f`로 명시할 때만 존재한다 |
| `docker-compose.push.build.yml` | 위 오버레이의 로컬 빌드(`relay/PushRelay/Dockerfile`) |
| `push-relay.env.example` | 푸시 경로 env 템플릿. `rust-smoke.secrets.env` **위에** 겹쳐 쓴다 |

푸시 오버레이는 `docker-compose.rust.yml`을 **한 줄도 바꾸지 않는다** — 평소의
`momorust up -d`는 relay를 띄우지도, 새 변수에서 깨지지도 않는다. 절차는
`docs/cicd/12-push-relay-deploy-runbook.md`.

폰 레인 오버레이도 같은 규율이다. 베이스가 **배포 compose의 미러**라는 사실이 그
스택으로 검수하는 유일한 이유이므로, 목 프로바이더(python 픽스처)는 베이스에 들어가지
않고 오버레이에만 산다. 레인이 이 디렉터리를 쓰는 이유와 함정은
`clients/mobile/scripts/lane-phone.sh` 머리말에 있다.

이미지 안에 들어가는 것: 바이너리 3종, `server/Migrations/*.sql`(그대로 복사),
`infra/e2e/bootstrap_roles.sql`, `infra/prod/bootstrap_runtime_roles.sql`,
`infra/prod/set_initial_owner.sql`, `infra/prod/bootstrap_owner_if_absent.sql`(#1227),
LICENSE/NOTICE. 런타임 베이스는
`debian:bookworm-slim` + **`postgresql-client`** — 마이그레이션 러너가 psql로
shell-out 하기 때문이다(002/006/012가 psql 메타커맨드 `\if`/`\getenv`를 쓴다. B0 교훈).

## 2. 준비

```sh
cp infra/rust/rust-smoke.env.example infra/rust/rust-smoke.secrets.env
# change-me-* 전부 교체:      openssl rand -hex 24
# 첫 로그인 2줄도 채운다:      MOMO_INITIAL_OWNER_EMAIL / MOMO_INITIAL_OWNER_PASSWORD
```

**첫 로그인 2줄은 선택이 아니다**(#1227). 마이그레이션 012가 시드 오너의 공개
비밀번호를 잠그므로(fail-closed이고, 옳다) 그 둘을 비운 채 마이그레이션한 DB에는
**쓸 수 있는 자격증명이 하나도 없다** — API는 healthy한데 모든 로그인이
`invalid credentials`이고, 재마이그레이션으로는 복구되지 않는다(`applied=0 skipped=N`,
2026-08-10 실측). 채워 두면 `up -d`의 `migrate` 서비스가 첫 부팅에 로그인을 만든다.
계약은 §4-2.

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
#   NOTICE:  MOMO_BOOTSTRAP_OWNER=created bootstrap owner password set from the environment
#   [migrate] bootstrap owner reconciled (see MOMO_BOOTSTRAP_OWNER notice above)
```

마지막 두 줄이 §2에서 채운 첫 로그인이다. 2회차부터는 `MOMO_BOOTSTRAP_OWNER=skipped`로
바뀌고, 둘을 비워 뒀다면 `[migrate] no bootstrap owner requested …`가 대신 나온다 —
그 경우 스택은 healthy하지만 아무도 로그인할 수 없다(§4-2).

`migrate` 서비스는 `MOMO_BOOTSTRAP_RUNTIME_ROLES=0`으로 돌기 때문에 세 런타임 롤이
정확한 least-privilege 자세로 존재하지 않으면 **마이그레이션을 거부한다**(prod와 동일).
즉 `infra/e2e/bootstrap_roles.sql`의 공개 dev 비밀번호는 이 스택에 절대 적용되지 않는다.

## 4. Smoke 곡선

### 4-1. health

```sh
curl -fsS http://127.0.0.1:8080/healthz
# {"status":"ok","service":"momo-server","database":"ok"}
```

### 4-2. 로그인 자격 (#1227)

기본 시드 모드는 `none`이고, 마이그레이션 012가 시드 오너의 공개 비밀번호를 잠근다
(fail-closed). **정본 경로는 §2에서 env 2줄을 채우는 것이고, 그러면 `up -d`가 끝나는
순간 로그인이 존재한다** — 별도 명령이 없다.

| env 상태 | `migrate`가 하는 일 | 로그 |
|---|---|---|
| 둘 다 채움, DB에 쓸 수 있는 비번 없음 | 오너 비번을 **1회** 기록 | `MOMO_BOOTSTRAP_OWNER=created` |
| 둘 다 채움, 이미 비번 있음 | **아무것도 안 함**(멱등) | `MOMO_BOOTSTRAP_OWNER=skipped` |
| 둘 다 빔 | 아무것도 안 함 — 012의 잠금 유지 | `no bootstrap owner requested …` |
| 하나만 채움 | **exit 2**, 스택 기동 중단 | `must be set together` |
| 대문자·공백 섞인 이메일 | **exit 2**, 스택 기동 중단 | `must already be trimmed and lowercase` |

마지막 행은 2026-08-10 실측으로 추가됐다: 자격증명은 `lower(btrim(...))`로 저장되는데
로그인 조회는 `WHERE h.email = $2`로 **그대로 비교**한다(`momo-messaging::identity`).
그래서 `Owner@Example.com`을 넣으면 오너 행은 생기는데 그 주소로는 영영 로그인되지
않는다 — #1227이 없애려는 바로 그 실패다. 조용히 소문자로 바꿔 쓰는 대신 부팅에서
거부하고, 통하는 철자를 에러 메시지에 보여준다. (로그인 조회 쪽 비대칭 자체는 이
티켓 범위 밖 — 적립 보고.)

두 번째 행이 계약의 핵심이다. `migrate`는 `up -d`마다 다시 돌기 때문에, 재부팅이
**바꿔 놓은 비밀번호를 되돌리거나 세션을 로그아웃시키면 안 된다.** 그래서 boot 경로는
쓸 수 있는 비번이 없을 때만 쓰는 전용 파일(`infra/prod/bootstrap_owner_if_absent.sql`)을
쓰고, 네 번째 행은 조용한 "off"가 아니라 exit 2다 — 반만 채운 env를 off로 읽으면
초록색 부팅 로그 뒤에서 잠기게 된다.

**의도적 회전(rotation)은 별개 명령이다.** 이쪽은 항상 덮어쓰고 **활성 세션을 전부
무효화**한다(prod와 같은 경로, MOMO-561):

```sh
MOMO_INITIAL_OWNER_EMAIL=owner@example.com \
MOMO_INITIAL_OWNER_PASSWORD='<generated>' \
  momorust run --rm -e MOMO_INITIAL_OWNER_EMAIL -e MOMO_INITIAL_OWNER_PASSWORD \
  migrate set-owner
# [migrate] bootstrap owner credentials updated (no value printed)
```

어느 경로든 값은 `\getenv`로만 psql에 들어가므로 argv·stdout·SQL 소스 어디에도
비밀번호가 남지 않는다(ADR-0004).

(로컬 전용 대안: `MOMO_AGENT_SEED_MODE=e2e`로 fresh 볼륨에서 기동하면 시드 오너
`demo@momo.local` / `dev-password`가 살아 있다. **공개 비밀번호이므로 NCP 금지.**)

재현 검증기: `scripts/verify_owner_bootstrap_rust.sh`(깨끗한 DB → 문서 경로 부팅 →
실제 로그인 → 재실행 멱등 → env 없이 기동 시 fail-closed까지 한 번에 증명한다).

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

volume 기본 이름은 **프로젝트 스코프**다: `${COMPOSE_PROJECT_NAME:-momo-rust}-pgdata`.
이 런북의 기본 프로젝트명이 `momo-rust`이므로 기본 이름은 `momo-rust-pgdata`이고
prod(`momo-pgdata`)와 분리돼 있다. 다른 프로젝트명으로 띄우면 볼륨도 함께 갈라지므로
(#1238) 워크트리·게이트의 `down -v`가 남의 DB를 지우지 않는다 — 격리하려면 `-p` 또는
`COMPOSE_PROJECT_NAME`을 주면 되고, 명시 이름이 필요하면 `DB_VOLUME_NAME`이 이긴다.
모든 서비스에 janitor 라벨이 붙어 있어 프로젝트 라벨로 회수된다.

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
| `CENT_TOKEN_HMAC` / `CENT_PROXY_SECRET` | ✅ `realtime` (B4) | 브로커의 **인가** 절반: 연결 토큰 서명 + subscribe 프록시 인증. 둘 다 publish 권한은 없다 |
| `CENT_API_URL` / `CENT_API_KEY` | ✅ `ephemeral` (SRV-T2 / ADR-0149) | 브로커의 **발행** 절반. 이 줄은 "momo-server에는 HTTP 클라이언트가 없다(불변식 #2)"라서 오래 미소비였고, **ADR-0149가 그 문장을 바꾼 결정**이다 — 「작성 중」은 outbox를 못 탄다(타이퍼 1명 5분이면 절대 안 읽힐 100행). 대신 이미지 안에서 Centrifugo에 닿을 수 있는 코드는 `momo-ephemeral` 하나뿐이고 그 crate의 전 API는 봉인된 `EphemeralSignal`만 받는다. **미설정이 지원되는 기본값**: 휘발 라우트 2개만 503, 나머지는 무변경 |
| `MOMO_EPHEMERAL_PER_CHANNEL`·`MOMO_EPHEMERAL_PER_MEMBER`·`MOMO_EPHEMERAL_GRANT_LIMIT`·`MOMO_EPHEMERAL_WINDOW_SECONDS` | ✅ `ephemeral` (선택) | ADR-0149 가드 5. 기본 30·120·10 / 60s. 0=해당 축 비활성 |
| `OUTBOUND_WEBHOOK_MASTER_KEY` | ✅ `webhook` (#1222) | 이벤트구독 **발신** secret 파생 전용. **미설정 = `JWT_HMAC` 폴백**(Swift `Config.swift:100` 동형)이고 그것이 안전한 기본값이다 — 발신 secret 은 이 키에서 매번 파생되므로, 키를 바꾸면 이미 설치된 구독자 전원의 서명 검증이 아무 기록 없이 깨진다. 인바운드(ADR-0115 native) secret 은 `JWT_HMAC` 에서 파생한다 |
| `MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP` | ✅ `webhook` (#1222, 선택) | `MOMO_ENV=local` **이면서** 이 값이 `1` 일 때만 `http://` 목적지를 받는다. 두 조건을 다 요구하므로 staging/prod 에서는 이 플래그가 효력을 가질 수 없다 |
| `PROVIDER_LINK_MASTER_KEY`·`AGENT_*`·`HERMES_*`·`MEMORY_*`·`MOMO_ARCHIVE_BACKEND`·`MOMO_S3_*`·`MOMO_METRICS_*` | ❌ 미소비 | 해당 기능 배치에서 복귀. **부팅을 막지 않는다** |
| `MOMO_CORS_ALLOWED_ORIGINS` | ✅ `cors` (DESK-1) | MOMO-605 계약 그대로 포팅. 빈값·미설정=미들웨어 미장착=완전 무변경. 이 줄이 "미소비"였던 동안 패키징된 데스크톱은 로그인이 아예 안 됐다 |

| prod relay env | Rust momo-relay |
|---|---|
| `RELAY_DATABASE_URL` | ✅ (없으면 `DATABASE_URL` 폴백) |
| `CENT_API_URL` / `CENT_API_KEY` | ✅ |
| `RELAY_POLL_INTERVAL_MS` / `RELAY_CLAIM_BATCH` / `RELAY_MAX_ATTEMPTS` | ✅ (300/64/8) |
| `LOG_LEVEL` | ✅ |
| `MOMO_ENV`·`OUTBOUND_WEBHOOK_MASTER_KEY`·`MOMO_METRICS_*` | ❌ 미소비, 비차단 — **발신은 relay 가 아니라 `webhook-sender` 몫이다**(#1222, 아래) |

| `webhook-sender` env | Rust momo-webhook-sender (#1222) |
|---|---|
| `WEBHOOK_SENDER_DATABASE_URL` | ✅ (없으면 `RELAY_DATABASE_URL` → `DATABASE_URL` 폴백). BYPASSRLS 역할 — drain 은 전 테넌트를 가로지른다 |
| `OUTBOUND_WEBHOOK_MASTER_KEY` | ✅ (없으면 `JWT_HMAC`). 이 프로세스가 api 와 달리 쥐는 유일한 자격이고, **Centrifugo 키는 쥐지 않는다** — 발신자는 durable rail 에 발행할 수 없고 relay 는 구독자에게 POST 할 수 없다 |
| `WEBHOOK_SENDER_POLL_INTERVAL_MS` / `_CLAIM_BATCH` / `_MAX_ATTEMPTS` / `_TIMEOUT_MS` | ✅ (300 / 16 / 8 / 5000) |
| `WEBHOOK_DISABLE_AFTER_5XX` | ✅ (기본 5, 최소 1). 연속 목적지 5xx 가 이 수에 닿으면 구독을 자동 비활성하고 `event_subscription.auto_disabled` 감사행을 남긴다 |
| `MOMO_ENV` / `MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP` / `LOG_LEVEL` | ✅ (api 와 같은 규칙) |

migrate/runtime-roles는 prod의 스위치를 그대로 읽는다: `DATABASE_URL`,
`MOMO_RUNTIME_ROLE_PROVISION`(0|1), `MOMO_BOOTSTRAP_RUNTIME_ROLES`(0|1),
`MOMO_AGENT_SEED_MODE`(none|demo|e2e), `MOMO_APP/RELAY/WORKER_POSTGRES_PASSWORD`,
`MOMO_INITIAL_OWNER_EMAIL`/`_PASSWORD`. 추가로 이미지 경로 오버라이드
`MOMO_MIGRATIONS_DIR`, `MOMO_BOOTSTRAP_ROLES_SQL`, `MOMO_RUNTIME_ROLES_SQL`,
`MOMO_SET_OWNER_SQL`, `MOMO_BOOTSTRAP_OWNER_SQL`(Dockerfile이 `/opt/momo/...`로 세팅)과
`MIGRATE_IDEMPOTENCY_CHECK`.

`MOMO_INITIAL_OWNER_*`는 **두 커맨드가 공유하되 뜻이 다르다**(#1227): `migrate`는
「없으면 만든다」(멱등, 세션 무손상), `migrate set-owner`는 「무조건 회전한다」(세션 무효화).
compose는 두 서비스 모두에 이미 이 이름을 넘기고 있었으므로 compose 변경은 없다.

`PROVIDER_LINK_MASTER_KEY`는 `agent-worker`가 `${VAR:?}`로 **요구**한다 — 템플릿에서
빠져 있던 동안 §2→§3 (0)의 `momorust config`가 무수정 복사본에서 exit 1이었다
(2026-08-10 buzz-audit-B §3). 지금은 템플릿에 placeholder로 있다.

## 8. 트러블슈팅

* `psql: warning: server 18, client 15` — bookworm의 postgresql-client는 15다. 마이그레이션은
  서버측 SQL이고 psql은 메타커맨드만 해석하므로 동작에 영향이 없다(prod Swift 이미지는
  ubuntu 24.04의 16). 경고가 거슬리면 `--build-arg RUNTIME_IMAGE=...`로 베이스를 올린다.
* `required externally provisioned runtime roles are absent or unsafe` — `runtime-roles`가
  실패했거나 건너뛰어졌다. `momorust logs runtime-roles` 확인.
* `set JWT_HMAC ...` 로 api가 즉시 종료 — 의도된 fail-fast다. env 파일 경로(`--env-file`)를 확인.
* 마이그레이션이 `psql client not found`로 실패 — 이미지가 아닌 곳(호스트)에서 러너를 돌린 경우다.
  로컬 실행에는 PostgreSQL 클라이언트가 필요하다.
