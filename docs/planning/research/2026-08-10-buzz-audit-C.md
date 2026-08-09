# buzz급 진단 감사 — 축 C: time-to-hello 실주행

> 워커 C · 2026-08-10 · 패킷: `docs/planning/handoffs/2026-08-10-buzz-diagnosis-audit-packet.md` §C
> **문서 리뷰 아님 — 실제로 밟았다.** 신규 셀프호스터 시나리오를 로컬 Docker에서 완주.
> 레포 체크아웃 무수정. 전 작업은 scratchpad 별도 클론에서 수행.

---

## 0. 결론 요약

| 항목 | 결과 |
|---|---|
| **채팅 화면 메시지 1왕복** | **달성** — 실브라우저 UI에서 `pass: true` (login→send→live-receipt→resume) |
| **총 소요(실측)** | **13분 24초** (T0 클론 00:12:45 → 완주 00:26:09) |
| 그중 기계 시간(빌드·풀·마이그레이션) | 약 2분 30초 |
| 그중 **문서에 없는 문제 진단 시간** | 약 11분 |
| **문서에 없는 임기응변 횟수** | **6회** |
| **문서가 안내한 대표 경로(README 5분 셀프호스트)** | **1단계에서 완전 차단 — 외부인 재현률 0%** |
| 실제로 완주한 경로 | `docs/RUN.md` 로컬 경로 + 소스/OpenAPI 참조 |

**핵심**: 스택 자체는 건강하다. 빌드 76초, 마이그레이션 62개 멱등 통과, 불변식(REST→PG→outbox→relay→Centrifugo) 실측 검증됨. 무너지는 것은 **온보딩 표면**이다 — 기본값대로 따라가면 **로그인이 불가능**하고 **실시간이 조용히 죽는다**.

---

## 1. 실주행 타임라인 (명령·시각·결과)

| 시각 | 단계 | 결과 |
|---|---|---|
| 00:12:45 | `git clone` (로컬 origin) → default branch `main` | OK, 187MB |
| 00:12:45~00:15:30 | README §"Self-host in 5 minutes" 시도 | **BLOCKED** (§2.1) |
| 00:15:32 | `make up` (COMPOSE_PROJECT_NAME=buzzaudit-c) | **PASS** 11초, PG18+Centrifugo healthy |
| 00:15:43 | `make migrate` | **PASS** 62개 적용, 2패스 멱등 `IDEMPOTENCY_OK` |
| 00:17:23 | `swift run --package-path server MomoServer` | **PASS** (최초 풀빌드 별도 76초) |
| 00:17:32 | `GET /health` | **PASS** `{"status":"ok"}` |
| 00:17:5x | `POST /v1/auth/login` (RUN.md 기재 자격) | **FAIL** `invalid credentials` (§2.3) |
| ~00:20:00 | DB 파기 후 `MOMO_AGENT_SEED_MODE=demo`로 재마이그레이션 | 복구 17초 |
| 00:20:1x | 로그인 재시도 | **PASS** accessToken 발급 |
| 00:20:2x | `POST .../messages` (RUN.md 예시대로) | **FAIL** `Coding key clientMsgId not found` (§2.4) |
| 00:20:3x | `clientMsgId` UUID 추가 후 전송 + 조회 | **PASS** seq=1 왕복 |
| 00:21:27 | `swift run OutboxRelay` (RUN.md §5.2 그대로) | **FAIL** publish 무한 재시도 (§2.5) |
| 00:23:54 | `CENT_API_URL` 루프백 오버라이드 후 재기동 | **PASS** `broadcast done` |
| 00:25:xx | 웹 클라 `npm install`(4초) + `npm run dev` + 동봉 e2e smoke | **PASS** `pass: true` |
| 00:26:09 | 완주 | **13분 24초** |

### 최종 왕복 증거 (실브라우저, 동봉 `clients/web/e2e/smoke.mjs`)

```
{"step":"channel-select","ok":true,"detail":"channelId=...202"}
{"step":"timeline-load","ok":true,"detail":"loaded=0 newestSeq=null"}
{"step":"send","ok":true,"detail":"smoke-mslyfsiv"}
{"step":"live-receipt","ok":true,"detail":"seq=1 newestSeq=1 ascending=true"}
{"step":"optimistic-reconcile","ok":true,"detail":"confirmed=1 pending=0"}
{"step":"session-resume","ok":true,"detail":"resumed"}
"pageErrors": [], "pass": true
```

---

## 2. 실패 지점 전수 (명령·에러 원문)

### 2.1 [1층·BLOCKED] README 대표 경로가 외부인에게 재현률 0%

README.md:24가 시키는 첫 명령부터 외부인에게 불가능하다.

```
git clone https://github.com/Dawn-kim-official/momo.git
```

실측 3종:

| 검사 | 명령 | 결과 |
|---|---|---|
| 레포 공개 여부 | `gh repo view --json visibility` | `{"isPrivate":true,"visibility":"PRIVATE","stargazerCount":0}` |
| 핀할 릴리스/태그 | `gh release list` / `git ls-remote --tags` | **0개 / 0개** |
| 이미지 익명 pull | `docker manifest inspect ghcr.io/dawn-kim-official/momo:latest` | `denied` (토큰 엔드포인트 HTTP 403) |

README.md:29는 `MOMO_IMAGE=ghcr.io/dawn-kim-official/momo:<v0.x-tag>@sha256:<digest>`로 핀하라고 지시하지만 **핀할 태그가 존재하지 않는다**. 이미지·릴리스·레포 셋 다 닫혀 있어 "5분 셀프호스트"는 현재 아무도 시작할 수 없다.

> **성재 결정 대기**: 공개 시점·범위는 판정 대상 아님. 다만 *공개하더라도* 태그 0·릴리스 0이면 README가 지시하는 digest 핀은 여전히 불가 — 이건 레포 사실이다.

### 2.2 [2층·GAP] README 첫 명령이 macOS에서 즉시 깨짐

```
$ install -m 600 infra/prod/secrets.env.example /run/momo-prod.env
install: /run/INS@wXmkXp: No such file or directory
```

README.md:18이 "Ubuntu LTS 호스트 전제"라고 밝히므로 범위 한정 GAP이나, macOS 개발자가 대표 경로를 로컬에서 시연할 방법이 문서에 없다.

**부수 실측(설치기 자체는 건강)**: 템플릿 무수정 상태로 `install.sh --dry-run` → **exit 1, 41개 이슈로 정확히 거부**. `__OPENSSL_RAND_HEX_32__` 류 placeholder, `__BASE_DOMAIN__`, 키 재사용(`OUTBOUND_WEBHOOK_MASTER_KEY`가 `JWT_HMAC`과 동일) 전부 잡아낸다. → **PASS(fail-closed 설계 우수)**.
다만 `secrets.env.example`에 **placeholder 42개(고유 23종)**가 있고 그중 `HERMES_BASE_URL`/`HERMES_API_KEY`는 **외부 에이전트 게이트웨이를 이미 보유**해야 채울 수 있다. README의 "5분"은 이 전제를 고지하지 않는다.

### 2.3 [1층·GAP — 최대 블로커] 문서대로 하면 로그인이 불가능하다

가장 비싼 실패. RUN.md **1730줄 중 1391번째 줄**, 그것도 `MomoMacSmoke` 환경변수 설명 표 안에 자격증명이 묻혀 있다:

> `MOMO_LOGIN_EMAIL`/`MOMO_LOGIN_PASSWORD`(내부 alpha seed는 `demo@momo.local`/`dev-password`; …)

그 자격으로 로그인하면:

```
$ curl -X POST .../v1/auth/login -d '{"email":"demo@momo.local","password":"dev-password"}'
{"error":{"message":"invalid credentials"}}
```

**원인** — `server/Migrations/012_prod_seed_password_fail_closed.sql`. 기본 `MOMO_AGENT_SEED_MODE=none`에서:

```sql
UPDATE human SET password_hash = NULL
 WHERE momo_password_verify('dev-password', password_hash);
```

즉 005가 심은 해시를 012가 같은 마이그레이션 런 안에서 되돌린다. 신선한 DB의 시드 계정은 **비밀번호가 NULL**이다.

보안 통제로서는 옳다(공개된 비번 fail-closed). 문제는 **출구가 없다는 것**:

- `docs/RUN.md`에 로컬 최초 소유자 생성 경로 언급 **0회** (`set-owner`/`INITIAL_OWNER` grep 0 hits).
- `set_initial_owner.sql`은 `infra/prod/`에만 존재 — prod `install.sh` 전용, 로컬 경로에서 호출되지 않음.
- `MOMO_AGENT_SEED_MODE=demo`는 RUN.md:810~812에 있으나 **"에이전트 픽스처" 맥락**으로만 설명되고, 심지어 *"이 opt-in을 일반 dogfood DB에 사용하지 않는다"* 고 **쓰지 말라고 한다**. 로그인 전제라는 신호가 어디에도 없다.
- **재실행으로 복구 불가**: 이미 `schema_migrations`에 기록되어 012가 다시 돌지 않는다. 실측 —
  `MOMO_AGENT_SEED_MODE=demo make migrate` → `적용 0, 스킵 62` → `password_hash` 여전히 NULL/EMPTY → 로그인 여전히 실패.
  **DB를 `down -v`로 파기**해야만 복구된다.

→ 신규 셀프호스터는 서버가 healthy한 상태에서 **로그인 화면 앞에 갇히고, 문서에는 탈출구가 없다.**

### 2.4 [2층·GAP] 메시지 전송 계약이 런북에 없다

```
$ curl -X POST .../messages -d '{"body":"hello"}'
{"error":{"message":"Coding key `clientMsgId` not found."}}
```

`clientMsgId`(필수 UUID)는 `server/Sources/MomoServer/Routes/DTOs.swift:129`와 `docs/api/openapi.yaml`에 있으나 **`docs/RUN.md`에는 0회** 등장한다(RUN.md:1383이 이 엔드포인트를 안내하면서도 바디 예시를 주지 않음). 셀프호스터는 소스나 OpenAPI를 열어야 첫 메시지를 보낸다.

### 2.5 [1층·GAP] 기본 `.env`대로 하면 실시간이 조용히 죽는다

RUN.md §5.2가 지시하는 그대로 호스트에서 relay를 띄우면:

```
info  OutboxRelay: centAPIURL=http://centrifugo:8000/api ... starting OutboxRelay
warning OutboxRelay: attempts=1 backoffSeconds=2  reason=publish threw: -65554: NoSuchRecord
warning OutboxRelay: attempts=2 backoffSeconds=4  ...
warning OutboxRelay: attempts=4 backoffSeconds=16 ...
```

`infra/.env.example:32`가 `CENT_API_URL=http://centrifugo:8000/api` — **컨테이너 내부 호스트명**을 담고 있는데, RUN.md §5는 relay를 **호스트에서** `swift run`하라고 한다. 호스트는 `centrifugo`를 해석하지 못한다(실측: `socket.gethostbyname('centrifugo')` 실패).

RUN.md §2.1은 `DATABASE_URL`에 대해서는 *"컨테이너 내부는 host=`postgres`, 호스트에서 직접 실행 시 host=`localhost`"* 라고 정확히 경고하고 `.env.example`도 `DATABASE_URL`만 `localhost`로 배포한다. **`CENT_API_URL`에는 같은 처리가 빠졌다.**

증상이 나쁜 이유: REST 왕복은 성공하고 DB에도 정상 기록되므로 **겉보기엔 동작한다.** outbox가 8회 재시도 후 `status='failed'`로 죽을 때까지 실시간 fan-out만 사라진다.
`CENT_API_URL=http://127.0.0.1:8000/api`로 오버라이드하자 즉시 `broadcast done attempts=1`.

### 2.6 [2층·GAP] 채팅 UI가 README에서 발견 불가

- `README.md`의 `clients/web` 언급 **0회**. `docs/RUN.md`도 1회뿐이며 그마저 gate profile 맥락(RUN.md:733).
- 웹 클라가 **두 개**: `clients/web`(ADR-0133 정본이나 자체 README가 "spike quality"라 선언) / `clients/web-legacy`(실제 서빙·e2e 타깃).
- `clients/web/README.md`의 dev 기본 프록시 타깃이 `momowebqa`(`http://127.0.0.1:28000`) — **사내 QA 스택 이름이 클라이언트 기본값에 박혀 있다.**
- 동봉 smoke 기본 `MOMO_WEB_BASE=http://127.0.0.1:5173`인데 vite는 **`[::1]`에만 바인드**한다(실측: `127.0.0.1`→000, `localhost`→200). 기본값끼리 어긋난다.

→ 신규 방문자는 채팅 화면에 도달하는 방법을 README만 읽고는 알 수 없다. 유일하게 README가 가리키는 UI는 macOS 전용 `MomoMacDevApp`이다.

### 2.7 [2층·GAP] 런북 신선도

`docs/RUN.md:805`는 *"적용 대상(현재): 001_init, 002_seed, 003_onboarding, 006_local_hermes_agent_seed"* 라고 적었으나 실제 마이그레이션은 **62개**다. RUN.md:817의 "검증됨" 문구도 `적용 0, 스킵 2` 시절 기록이다.

---

## 3. 문서에 없는 임기응변 6회

| # | 임기응변 | 필요 이유 |
|---|---|---|
| W1 | env를 `/run` 밖에 렌더 | macOS에 `/run` 없음 |
| W2 | `MOMO_AGENT_SEED_MODE=demo` 필요함을 발견 | 로그인 전제가 문서에 없음 |
| W3 | DB를 `down -v`로 파기 후 재마이그레이션 | 재실행만으로는 복구 불가 |
| W4 | 전송 바디에 `clientMsgId` UUID 추가 | 런북에 계약 없음 |
| W5 | `CENT_API_URL`을 루프백으로 오버라이드 | `.env.example` 기본값이 호스트 실행과 불일치 |
| W6 | smoke를 `localhost`로(127.0.0.1 아님) 지정 | vite `[::1]` 바인드 vs smoke 기본값 |

W2·W3·W5는 **소스/마이그레이션 SQL을 읽어야만** 풀린다. 문서만 가진 셀프호스터는 여기서 멈춘다.

---

## 4. buzz 기준선 대조 (github.com/block/buzz 실측)

buzz는 Apache-2.0 Rust 프로젝트, **스타 25,483 · 열린 이슈 994 · PR 1,343 · 워크플로 17개 중 9개가 `pull_request` 트리거로 실제 실행 중**.

| 축 | buzz | oort |
|---|---|---|
| quickstart 위치 | README 최상단 `## Quick start` | README는 prod 설치기, 로컬은 **1730줄 RUN.md** |
| 첫 실행까지 명령 수 | **5개** | 3개 서비스를 **각각 별도 터미널**에서 `swift run`(§5 "세 개를 별도 터미널에서") |
| 전제조건 | **3개**(Docker·Hermit·git), **API 키 0·DNS 0·TLS 0** | 로컬은 Docker+Swift+psql, prod는 placeholder 23종+Hermes 게이트웨이 보유 |
| 시간 약속 | **없음**(전 문서 grep 0) — 대신 결과를 약속: *"Relay on ws://localhost:3000. Desktop app pops up. You're in."* | README: **"Self-host in 5 minutes"** |
| 첫 로그인 | 별도 계정 절차 없음 | **기본 경로에서 불가능**(§2.3) |
| 셀프호스트 문서 분리 | `deploy/compose/README.md` 전용 번들, `CHANGE_ME` 잔존 시 `run.sh`가 기동 차단 | `install.sh` preflight가 동등하게 차단 — **여기는 oort가 대등** |

**해석**: buzz는 시간을 약속하지 않는다(정직한 floor: 28-crate Rust 풀빌드 또는 시크릿 8개 수기 생성). oort는 **"5분"을 명시적으로 약속하고 그 경로가 현재 0% 재현 가능**하다. 격차의 본질은 엔지니어링 성숙도가 아니라 **약속과 실제의 간극**이다.

buzz 쪽 참고 결함(공정성): 루트 `.env.example`에 이미 없어진 Typesense 서비스가 남아 있고, `just dev` 설명이 README 안에서 두 가지·`dev-setup.sh`에서 세 번째로 갈린다. 즉 **문서 드리프트는 buzz에도 있다** — 차이는 buzz의 드리프트가 "첫 왕복"을 막지 않는다는 점이다.

---

## 5. 판정 체크리스트

### 1층 (go/no-go 재료)

| 항목 | 판정 | 근거 |
|---|---|---|
| 외부인이 문서대로 셀프호스트 가능 | **BLOCKED** | 레포 private·태그 0·릴리스 0·GHCR denied (§2.1) |
| 문서 경로만으로 첫 로그인 가능 | **GAP(치명)** | 012가 시드 비번 NULL화, 로컬 소유자 생성 경로 문서 0회 (§2.3) |
| 문서 기본값으로 실시간 동작 | **GAP(치명)** | `CENT_API_URL` 컨테이너 호스트명, 조용히 실패 (§2.5) |
| 채팅 화면 1왕복 자체 | **PASS** | 실브라우저 smoke `pass:true`, seq=1 (§1) |
| 핵심 불변식(REST→PG→outbox→relay→Centrifugo) | **PASS** | outbox `broadcast done`, seq 오름차순 확인 |
| 스택 빌드·마이그레이션 건전성 | **PASS** | 서버 풀빌드 76초, 62개 멱등, error 0 |
| prod 설치기 fail-closed | **PASS** | 무수정 템플릿 41개 이슈로 거부, exit 1 |

### 2층 (격차 베이스라인)

| 항목 | 판정 | 격차 |
|---|---|---|
| quickstart 발견성 | **GAP** | 로컬 경로가 1730줄 문서에 분산, 자격증명이 1391행에 매장 |
| API 첫 호출 계약 | **GAP** | `clientMsgId`가 런북에 부재 |
| 채팅 UI 발견성 | **GAP** | README에서 웹 클라 언급 0, 클라 2개 병존 |
| 런북 신선도 | **GAP** | RUN.md:805가 62개 중 4개만 기재 |
| 내부 식별자 노출 | **GAP** | 클라 기본 프록시 타깃 `momowebqa` (E축 인계 권고) |
| macOS 개발자 온보딩 | **GAP** | 대표 경로가 Ubuntu 전용, 로컬 대안 미연결 |
| Rust 경로 안내 | **GAP** | RUN.md의 `server-rust`/`infra/rust` 언급 **0회**, DEPLOY.md 1회. 라이브가 Rust인데 셀프호스터용 Rust 런북 없음. `infra/rust/docker-compose.rust.yml`은 스스로 caddy·redis·worker·web 제외를 선언 |
| 프로세스 관리 | **GAP** | 서비스 3개를 사람이 3개 터미널로 관리, supervisor·`make run` 없음. 각 패키지가 별도 SwiftPM 의존 그래프라 relay 최초 빌드에 31.6초 추가 |

---

## 6. 자원 위생 결과 (하드 룰 준수 보고)

compose 프로젝트명 **`buzzaudit-c`** 접두 사용. 종료 시 `docker compose down -v` 실행 후 회수 검증:

```
buzzaudit- 컨테이너 잔존: 0
buzzaudit- 볼륨 잔존:     0
buzzaudit- 네트워크 잔존: 0
잔류 호스트 프로세스(MomoServer/OutboxRelay/vite): 0
```

**호스트 상태 baseline 대조** (내 작업 전 00:12 → 정리 후):

| | baseline | 정리 후 | 판정 |
|---|---|---|---|
| Images | 80 / 72.39GB | 80 / 73.49GB | 총 **이미지 수 78개로 동일 — 내가 만든 이미지 0개** (pgvector·centrifugo 모두 캐시 히트) |
| Containers | 23 | **23** | 원복 |
| Local Volumes | 115 | **115** | 원복 |
| Build Cache | 493 / 28.46GB | 493 / 28.46GB | 불변(도커 빌드 미수행) |

이미지/컨테이너 SIZE 증가분은 내 작업물이 아니라 **동시 실행 중인 기존 스택(`momowebqa-*`)의 성장**이다. 내 스택은 이미지를 빌드하지 않았다(전부 캐시 히트).

추가 회수: scratchpad 클론의 `server/.build`(1.3GB)·`relay/OutboxRelay/.build`(1.2GB)·`clients/web/node_modules`(263MB) 삭제 → 3.0GB → 187MB.

**포트**: 문서 기본값 5432·8000·8080·5173 전부 비어 있어 그대로 존중했다. 기존 스택들은 비표준 포트(28001·28002·26561·26562)를 쓰고 있어 **충돌 없음**.

**레포 체크아웃 무수정 확인**: `git status --porcelain` 2줄 — `docs/brand/hero-banner.png`(00:26 생성)과 `docs/planning/handoffs/2026-08-09-security-headers-packet.md`(전일 20:31). **둘 다 내 산출물이 아니다**(나는 scratchpad 밖에 쓴 적 없음). 전자는 동시 실행 세션의 것으로 보이며 건드리지 않았다.

---

## 7. 상위 발견 3개

1. **README가 약속한 "5분 셀프호스트"는 현재 재현률 0%다.** 레포 private + 태그 0 + 릴리스 0 + GHCR 익명 pull 거부. 게다가 README:29는 존재하지 않는 `<v0.x-tag>@sha256:` 핀을 지시한다. buzz는 시간을 아예 약속하지 않는 대신 결과를 약속하고 지킨다 — oort는 반대다.

2. **문서를 그대로 따르면 로그인할 수 없고, 문서에 탈출구가 없다.** 마이그레이션 012가 시드 비번을 fail-closed로 NULL화하는데(보안적으로 옳다) 로컬 최초 소유자 생성 경로가 RUN.md에 0회 등장한다. 유일한 스위치 `MOMO_AGENT_SEED_MODE=demo`는 "쓰지 말라"고 적혀 있고, 재실행으로는 복구 불가라 **DB 파기가 강제**된다. time-to-hello를 가장 크게 늘린 단일 원인.

3. **기본 `.env`로는 실시간이 조용히 죽는다.** `infra/.env.example:32`의 `CENT_API_URL`이 컨테이너 호스트명이라 RUN.md §5.2가 지시하는 호스트 실행 relay가 publish에 전부 실패한다. `DATABASE_URL`에는 있는 "호스트 실행 시 localhost" 경고가 이 키에만 빠졌다. REST는 성공하므로 **겉보기엔 정상**이고, outbox가 8회 재시도 끝에 `failed`로 죽을 때까지 아무도 모른다.

**단서(중요)**: 위 3개는 전부 **온보딩 표면**의 결함이며, 엔진 자체는 실측상 건강하다 — 서버 풀빌드 76초·error 0, 마이그레이션 62개 멱등 통과, 불변식 왕복 검증, 설치기 preflight가 무수정 템플릿을 41개 이슈로 정확히 거부. **고칠 대상은 코드가 아니라 첫 30분이다.**
