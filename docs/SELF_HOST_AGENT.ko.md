# oort 에이전트 셀프호스트 플레이북 (SELF_HOST_AGENT.ko.md)

> **정본은 영문 [`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) 이다.** 이 파일은 같은 절 번호의 번역이다.
>
> **이 문서가 제품이다.** **사용자 본인 기계**에서, **사용자 본인 지시**로 일하는
> 에이전트가 이 파일만 읽고 터미널에 사람 없이 oort를 켠다. 사람은 브라우저를 연다.
>
> 이 플레이북의 독자는 특정 제품이 아니라 오퍼레이터다. 하네스 예
> (목록일 뿐, 문장이 이 이름에 기대지 않는다): Claude Code, Codex, Grok Bot,
> OpenAI 호환 오퍼레이터. 그 이름 없이는 성립하지 않는 문장은 §3.3 밖에 두지 않는다.
>
> 사람이 노트북에서 직접 따라가는 정본은 [`SELF_HOST.md`](SELF_HOST.md).
> 로그인 다음 하루(워크스페이스·초대·AI 연결·첫 멘션)는
> [`SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md). 덤프·복원:
> [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

이 문서는 법률 자문이 아니다. 비밀번호·pairing/claim 원문·`DATABASE_URL`·
도어벨 sender key를 대화·이슈·스크린샷에 다시 적지 않는다(ADR-0004).
claim URL은 사용자에게 **한 번만** 회신한다.

---

## 0. 계약

이 작업은 **사용자의 기계와 계정에서만** 한다. 팀 공용·데모 호스트를 쓰지 않는다.
에이전트는 그 기계의 셸에서 이 플레이북을 집행하는 오퍼레이터다.

**하지 말 것:**

- 사용자의 기계·계정을 떠난다
- 시크릿을 대화에 붙인다 (비밀번호, pairing/active 자격, claim 토큰,
  도어벨 키, 세션 토큰, `DATABASE_URL`)
- 벤더 채팅 앱(그록봇 등)을 자동화로 조종한다 (셀렉터, 원격 디버깅,
  스크립트 UI)
- 플랫폼 콘솔을 사용자 대신 클릭한다. 플랫폼 콘솔(Railway, Fly, AWS, GCP,
  Cloudflare, …)은 **공식 CLI/MCP → REST API + 사용자 제공 토큰 → 브라우저
  자동화** 순으로 닿는다. 브라우저 자동화는 회원가입·결제·DNS 위임·OAuth
  동의처럼 API가 없는 단계의 **사람 승인 지점**에서만 쓴다. 그 지점에서
  에이전트는 **멈추고 화면을 사용자에게 넘긴다** — 대신 클릭하지 않는다
  (ADR-0184 D2). 플랫폼 CLI/MCP는 사용자 본인의 로그인 세션을 재사용하고,
  플랫폼 토큰은 대화·이슈·트리에 남기지 않는다(ADR-0004)
- 이 기계가 소유하지 않은 호스트에 ACME / Let's Encrypt를 돌린다
- 루프백 설치에서 `caddy.override.yml` 이나 운영 `Caddyfile` 을 이름 부른다
  (그 오버레이는 인증서를 주문한다)
- 전역 `DOCKER_DEFAULT_PLATFORM=linux/amd64` (V-1: 로컬 Centrifugo index가 거절)
- 아직 필요한 데이터가 있는 볼륨에 `down -v`
- claim 실패를 `MOMO_INITIAL_OWNER_PASSWORD` 로 우회 (ADR-0004, ADR-0166)
- 터널 URL의 웹 브라우저를 v1 상시 클라이언트로 안내한다 (v1은 데스크탑.
  로컬 루프백 브라우저는 §3.1 예외)
- `MOMO_DOORBELL_ENABLED` 나 `MOMO_HOSTED_DELIVERY_ENABLED` 를 `True` /
  `1` / `yes` / `on` 으로 연다 (소문자 `true`만)

**항상:** 이미지는 [`releases/latest.json`](../releases/latest.json) 을
명령으로 읽어서 pin 한다. 이 파일이나 대화에 digest·버전 숫자를 붙이지 않는다.
`latest` 와 `sha-*` 태그는 신원이 아니다.

Doctor가 설치 판정이다. 종료코드: **0** pass, **1** major만, **2** blocker 있음.
`--strict` 는 major를 2로 올린다. JSON:

```sh
scripts/oort doctor --json
```

기계 보고는 `{ "summary": { "pass", "fail", "skip", "verdict" },
"checks": [ { "id", "severity", "status", "detail", "fix" } ] }` 이다.
**PASS** 는 `summary.verdict` 가 `PASS` (blocker fail 없음, major fail 없음).
`skip` 은 판정을 실패시키지 않는다. 시크릿은 인쇄하지 않는다.

사람용 플레이북(같은 스택, 더 긴 산문): [`SELF_HOST.md`](SELF_HOST.md).

---

## 1. 환경 고르기

**한 행만** 고른다. 그다음 §2(공통 코어). 그다음 맞는 §3 분기.
엣지를 섞지 않는다 (루프백 `Caddyfile.local` vs 공개 `Caddyfile`).

tier는 ADR-0184 D1이다. **T1**은 compose 정본을 그대로 돌린다(doctor
`stack.*`·day-2 명령 전부 유효). **T2**는 관리형 컨테이너 + PG 플러그인:
이미지·엣지·env는 정본에서 파생하고, day-2 v2(SH-11e)는 `MIGRATE_DATABASE_URL`과
공개 오리진으로 돈다(`scripts/oort backup --tier t2`, `restore`, `upgrade`,
`doctor --tier t2 --json`). **T3**은 엣지 전용 — 컴퓨트가 아니다. 「조작
수단」은 §0의 순서다: 사용자 본인 세션의 공식 CLI/MCP → 사용자 토큰의 REST →
브라우저는 사람 승인 지점에서만. 모든 행의 env 파생은
`scripts/self_host_env.sh --platform <name>`이 표 하나(`platform_profiles`)를
읽는다: `railway`(T2, 별칭 `--railway`) · `fly` · `aws-lightsail` ·
`gcp-vm` · `host-network`(T1; `fly` / `aws-lightsail` / `gcp-vm` 은
`--public-origin` 파생과 같고 heredoc 밖에
`MOMO_SELF_HOST_PLATFORM=<name>`만 추가; `host-network` 는 Docker
bridge/iptables가 막힌 VM의 루프백 내부 URL + compose `network_mode: host`,
§3.3.0; 정본 41키 집합은 늘지 않는다). 로컬·VPS는 행이 없다 — compose
정본 그 자체다. Grok Bot VM은 compose 정본이고, §3.3.0 (b)/(c)가
실패하면 `--platform host-network` 를 붙인다.

| 플랫폼 | Tier | 분기 · 레시피 | 조작 수단 | 사람 승인 지점 | 전제 | 엣지 · URL 모델 | 완료 |
|---|---|---|---|---|---|---|---|
| **로컬 머신** | T1 | §3.1 | 이 기계의 셸(compose). | 없음. | Docker Engine + Compose v2, git, jq, openssl, curl. 여유 ≥ 1 GiB (2 GiB 권장). | `local.override.yml` + `Caddyfile.local` (`:80`, ACME 없음). `http://127.0.0.1:<MOMO_WEB_PORT>` (생성기 기본 8088, 비어 있으면). | Doctor `summary.verdict=PASS`(`public.*` skip 은 OK) 그리고 `owner@oort.local` 브라우저(또는 로그인 API) 세션. |
| **자기 도메인 VPS** (Hetzner, DO, …) | T1 | §3.2 | SSH + compose. 프로바이더 CLI는 사용자가 이미 로그인해 둔 것만. | 프로바이더 가입·결제; 그 호스트의 DNS 레코드. | 로컬과 같음 + 이 기계가 소유한 호스트의 DNS. | `caddy.override.yml` + `Caddyfile` (`{$OORT_SITE_ADDRESS}`). `OORT_SITE_ADDRESS` 와 `OORT_CSP_CONNECT_SRC` 는 `scripts/self_host_env.sh --public-origin` 이 파생한다 — 손으로 적지 마라. 운영자가 선언한 `https://<host>`. | `public.healthz`·`public.websocket` 포함 doctor PASS, HTTPS 로그인. |
| **Fly.io** (단일 VM + 볼륨) | T1 | §3.5 · 프로비저닝 레시피 SH-11b (`fly.toml` + 볼륨) | 사용자 로그인의 `flyctl` → 사용자 토큰의 Fly REST → 브라우저. | Fly 가입·결제; 커스텀 도메인 DNS. | Fly 계정; 볼륨 달린 VM 1대; 그 위의 T1 도구. | VM 위에서 T1 compose 절차 §3.2; env `scripts/self_host_env.sh --platform fly --public-origin https://<host>`. Fly 호스트명 또는 커스텀 도메인. | VPS와 같음. |
| **AWS Lightsail / EC2** | T1 | §3.6 · [`infra/aws/README.md`](../infra/aws/README.md) (SH-11c) | 사용자 세션의 `aws` CLI / AWS MCP → REST → 브라우저. | AWS SSO/로그인; `terraform apply`(plan 리소스 수); Budgets 이메일; DNS A; `terraform destroy`(데이터 디스크). | 클라우드 계정; IAM 사용자/SSO 역할(루트 금지); VM + 추가 디스크 + 도메인. | VM 위에서 T1 compose 절차 §3.2; env `--platform aws-lightsail --public-origin https://<host>`. 운영자 도메인. | VPS와 같음. |
| **GCP VM** | T1 | §3.7 · SH-11c 패턴의 프로비저닝 레시피 | 사용자 세션의 `gcloud` → REST → 브라우저. | GCP 가입·결제; OAuth 동의; DNS 레코드. | AWS와 같음. | VM 위에서 T1 compose 절차 §3.2; env `--platform gcp-vm --public-origin https://<host>`. 운영자 도메인. | VPS와 같음. |
| **Railway** | T2 | §3.4 · 에이전트 경로 실측은 SH-11a | 사용자 OAuth 세션의 `railway` CLI(`railway setup agent`) / 원격 MCP `mcp.railway.com` → REST → 브라우저. | Railway 가입·결제; CLI/MCP의 OAuth 로그인; caddy에 공개 도메인 부여. | Railway 계정; Postgres 플러그인; 이 기계에 Docker 불필요(발행 이미지). | 공개 엣지는 Caddy 서비스(`Caddyfile.railway`), api는 내부. env는 `scripts/self_host_env.sh --platform railway`(별칭 `--railway`)가 `RAILWAY_PUBLIC_DOMAIN` + `DATABASE_URL`에서; 손으로 넣는 키 셋(`infra/railway/README.md`). 플랫폼 호스트명. | 배포 오리진에서 doctor PASS(`public.healthz`, `public.websocket`). Day-2: 이미지 one-off `scripts/oort backup --tier t2 --env <env>`, `scripts/oort restore <dump> --tier t2 --yes --env <env>`, `scripts/oort upgrade --tier t2 --yes --env <env>`, `scripts/oort doctor --tier t2 --json`. `--tier t2`는 `MOMO_SELF_HOST_PLATFORM`(railway)과 같아야 한다. dump는 `MIGRATE_DATABASE_URL`만. one-off의 플랫폼 CLI/MCP는 SH-11a. |
| **Cloudflare** (엣지 전용) | T3 | 레시피 SH-11d — T1/T2 행 앞단의 DNS · Tunnel · TLS | 사용자 세션의 `wrangler` / MCP `mcp.cloudflare.com` → API 토큰의 REST → 브라우저. | Cloudflare 가입; 레지스트라의 네임서버 위임; Tunnel 토큰 생성. | 이미 떠 있는 T1/T2 행. 컴퓨트가 아니다: Containers/Workers는 채택하지 않는다(ADR-0184 D1). | 앞에 세운 행을 감싼다; 오리진은 그 행의 엣지와 `/v1/centrifugo/*` 403 순서를 유지. Cloudflare DNS의 공개 호스트명. | 감싼 행과 같고, Cloudflare 호스트명 경유로 `public.*` PASS. |
| **Grok Bot VM** (Tailscale Funnel) | T1 | §3.3 | VM 안의 셸(compose) + `tailscale` CLI. | Tailscale 로그인·Funnel 켜기(4~5 클릭); 1회용 claim URL 열기. 계정 0개 + 고정 URL은 이 플레이북이 **달성하지 못한다**(RA-7). | curl, tar, Docker Engine + Compose v2, openssl, jq. git 불필요. durable 디렉터리 `/workspace`. Tailscale 계정 1개. | 루프백 Caddy + 웹 포트로 Tailscale Funnel. 여기서 `caddy.override.yml` 을 **켜지 마라** (ACME). `--public-origin` 은 Funnel URL을 Centrifugo에 등록한다. `/workspace` 아래 Funnel state가 살아 있는 동안 `https://<machine>.<tailnet>.ts.net`. | Funnel 오리진 기준 공개 검사 포함 doctor PASS, 1회용 claim URL을 사용자에게 회신, `/workspace` 첫날 덤프. |

데스크탑 Tauri Origin(`tauri://localhost`, `http://tauri.localhost`)은
셀프호스트 허용 목록에 있다. **공개** URL을 브라우저·RN이 열려면 그 오리진이
Centrifugo에 있어야 한다(§3.2 / §3.3.9). 로그인 응답의
`realtimeWebSocketUrl` 은 `MOMO_CENTRIFUGO_WS_URL=same-origin`(ADR-0167)이
요청 `Host` / `X-Forwarded-Proto` 에서 파생한다.

---

## 2. 코어 설치

각 단계 끝에 게이트가 있다. 게이트가 실패하면 **멈춘다.** 비밀번호를 만들어
대화로 보내지 않는다.

비밀번호 로그인(§2.6)이 기본이다. claim 부트스트랩은 Grok Bot VM 분기
(§3.3.3) **뿐**이다 — `MOMO_INITIAL_OWNER_PASSWORD` 와 상호 배타다
(ADR-0166).

### 2.1 트리를 받는다

이 파일이 이미 작업 디렉터리의 레포 루트에 있으면 그 디렉터리를 쓴다. 아니면:

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort
cd oort
```

Docker가 파일을 bind-mount할 수 있는 곳에 clone한다. Docker Desktop(macOS)에서는
거의 항상 사용자 홈 아래 경로다 — `/tmp`가 아니다. `/tmp` checkout은 나중에
compose가 `infra/rust/Caddyfile.local` 을 bind-mount할 때 실패한다.

이 플레이북은 승격될 때까지 `track/engine` 에 랜딩한다. 기본 clone에
`scripts/oort` 가 아직 없으면 `track/engine` 을 checkout한다.

**게이트:** `test -x scripts/oort && test -f releases/latest.json`.

```sh
scripts/oort doctor --json
```

env가 생기기 전에는 `env.exists` 가 skip이다(preflight). `tool.docker`,
`tool.compose`, `tool.jq`, `tool.openssl` 은 **pass** 여야 한다. 디스크 1 GiB
미만은 blocker다. doctor 종료코드 2로 계속하지 않는다.

### 2.2 이미지 모드를 고른다

정확히 하나. 둘 다 같은 Rust 스택을 소비하고, 생성기는 섞는 것을 거절한다.

**공개 digest (붙여넣기 에이전트의 기본).** 정본은
[`releases/latest.json`](../releases/latest.json)이다 (GitHub Releases가
출처). `latest` 나 `sha-*` 를 받지 않는다. 불변
`ghcr.io/yeomyeonggeori/oort` digest만 pin한다 (`sha256:` 접두 + 64 hex) —
형식이 틀리면 생성기가 env를 쓰기 전에 거절한다. list digest는 명령으로
읽고, hex를 산문에 복사하지 않는다.

```sh
jq -r '
  "app\t\(.images.app.ref)@\(.images.app.digest_list)",
  "PostgreSQL 18 + pgBackRest\t\(.images.postgres.ref)@\(.images.postgres.digest_list)"
' releases/latest.json
```

postgres 행은 Release 표와 운영/PITR용이다. **이 플레이북 compose의 postgres
서비스는 소비하지 않는다.** 앱만 pin한다.

공개 이미지는 `linux/amd64`+`linux/arm64` **manifest list**다.
`digest_list` 가 그 list digest다. Apple Silicon과 amd64는 native pull한다.
전역 `DOCKER_DEFAULT_PLATFORM` 은 켜지 않는다.

```sh
IMAGE_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
docker pull "$IMAGE_REF"
```

**게이트:** `docker image inspect "$IMAGE_REF"` 가 성공한다.

checkout이 아직 없으면 같은 JSON이 기본 브랜치에 있다:

```sh
IMAGE_REF="$(curl -fsSL https://raw.githubusercontent.com/yeomyeonggeori/oort/main/releases/latest.json | jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"')"
```

선택(운영자에 `gh` 가 있을 때):

```sh
gh attestation verify "oci://$IMAGE_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

정확한 `verify_cmd` 문자열은 `releases/latest.json` 의
`attestation.verify_cmd` 에도 있다. Doctor는 `env.attestation` 을
present로 기록하고, 실행하지는 않는다.

**로컬 빌드** — 이 checkout이 띄울 이미지일 때만:

```sh
scripts/self_host_env.sh --local-build
```

`server-rust/Dockerfile` 에서 `oort:local` 을 굽는다. Rust와 Node는
Docker 빌드 안에 남고, 호스트 패키지가 아니다.

### 2.3 env 생성

공개 이미지 경로(§2.2 pull 뒤):

```sh
scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

로컬 빌드 경로는 §2.2 의 `--local-build` 한 줄이다 (env도 같이 쓴다).
**둘 다 돌리지 마라.**

생성기는 `infra/rust/local.secrets.env` 를 쓴다 (mode 600). 채워 넣을
자리는 없다. 시크릿 아홉 개는 `openssl` 에서 온다. 롤 비밀번호와
`DATABASE_URL` 값 안의 비밀번호는 같게 쓴다. 기본 포트가 쓰이면 다음
빈 포트를 골라 인쇄한다. 첫 로그인 계정과 `MOMO_SELF_HOST_MODE` 를
기록한다.

이 기계에 이미 `oort` 라는 live compose 프로젝트가 있으면, pgdata와
drive 볼륨이 공유되지 않도록 다른 프로젝트 이름으로 생성한다(#1613).
생성기는 `COMPOSE_PROJECT_NAME` 에서 `DB_VOLUME_NAME` 과
`DRIVE_VOLUME_NAME` 을 파생한다:

```sh
COMPOSE_PROJECT_NAME=oort-local \
  scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

파일이 이미 있으면 **시크릿을 다시 만들지 마라** — 마이그레이션된 DB는
새 비밀번호와 맞지 않는다. 두 번째 실행은 파일 위치만 다시 인쇄한다.

env 파일을 절대 `cat` 이나 `grep` 으로 stdout에 흘리지 않는다. 로그인에
필요할 때 셸에서 키 하나만 읽고, 값은 변수에 둔다.

**게이트:**

```sh
scripts/oort doctor --json
```

`env.exists`, `env.mode` (0600), `env.required_keys`, `env.role_passwords`,
`env.platform_admin_emails`, `env.provider_link_master_key` 는 pass여야 한다.
스택 검사는 §2.4까지 skip. 종료코드 2 → 멈춘다.

### 2.4 기동

생성기가 인쇄한 줄을 쓴다. 비밀번호 경로에서는 `--compose` 가 필수다.
전형적인 공개 이미지:

```sh
scripts/self_host_env.sh --compose up -d --pull missing --wait
```

로컬 빌드:

```sh
scripts/self_host_env.sh --compose up -d --build --wait
```

`--wait` 가 돌아오는 것은 "컨테이너 healthy"이지 제품 게이트가 아니다.
제품 게이트는 §2.5다.

이 엣지는 `127.0.0.1` 에 바인딩된다(TLS 없음). 상자의 공인 IP가 이
스택을 열어 주지 않는다. VPS와 Grok Bot 분기가 §3에서 엣지를 더한다.

postgres가 볼륨을 초기화한 **뒤에** `up` 이 실패하면, **이 env를 유지**하고
`--compose up -d --wait` 를 재시도한다. 같은 `COMPOSE_PROJECT_NAME` /
`DB_VOLUME_NAME` 에 두 번째 env를 만들지 마라. 남은 pgdata에 새 시크릿을
얹으면 `password authentication failed for user "momo"` 와
`runtime-roles` 종료코드 1이다. 처음부터 다시: `--compose down -v`,
`infra/rust/local.secrets.env` 삭제, 그다음 §2.3.

**claim 모드 예외:** `--compose` 는 `MOMO_BOOTSTRAP_CLAIM=1` 이고
비밀번호 키가 없는 env를 거절한다. 그 형상은 §3.3만 쓰고,
`docker compose` 를 직접 호출한다.

### 2.5 게이트: doctor PASS

```sh
scripts/oort doctor --json
```

**게이트:** `summary.verdict` 가 `PASS` 이고 프로세스 종료코드가 0이다.
`stack.healthz` 는 HTTP 200 에 `database:ok`. `stack.agent_port` 는 POST
`/v1/mcp/agent-port` → 401 에 `WWW-Authenticate: Bearer scope="agent:port:connect"`.
`stack.migrate_idempotency` 는 `IDEMPOTENCY_OK` 를 본다. `stack.outbox` 에
`done` 이 아닌 행이 없다.

healthz가 200이 아니면 `scripts/self_host_env.sh --compose logs api` 하고
멈춘다. agent-port가 그 401이 아니면 이 이미지에 합류 표면이 없다 —
비밀번호를 만들지 마라.

### 2.6 로그인

생성기가 인쇄한 URL을 연다 — 기본 **`http://localhost:<MOMO_WEB_PORT>`**.

| 로그인 화면 칸 | 넣을 값 |
|---|---|
| **서버 주소** (선택) | **비운다.** 이 페이지는 이미 이 서버에서 왔다. |
| **이메일** (필수) | 생성기가 인쇄한 주소 (기본 `owner@oort.local`) |
| **비밀번호** (필수) | `infra/rust/local.secrets.env` 의 `MOMO_INITIAL_OWNER_PASSWORD`. 파일을 읽고, 값을 대화에 인쇄하지 않는다. |

**다른 워크스페이스로 로그인** 을 펼치기 전에는 워크스페이스 칸이 없다.
셀프호스트 첫 실행에서는 건너뛴다.

**헤드리스 오퍼레이터 게이트** (토큰·비밀번호를 인쇄하지 않는다):

```sh
ENV_FILE=infra/rust/local.secrets.env
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
OWNER_PASSWORD=$(awk -F= '$1=="MOMO_INITIAL_OWNER_PASSWORD"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
code=$(curl -sS -o /tmp/oort-login.body -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"owner@oort.local\",\"password\":\"${OWNER_PASSWORD}\"}" \
  "http://127.0.0.1:${WEB_PORT}/v1/auth/login")
unset OWNER_PASSWORD
test "$code" = 200
```

**게이트:** HTTP 200 이고 본문에 `accessToken` 이 있다. 본문은 버린다.
브라우저 로그인 뒤 채널 목록: `agent-lab` 과 `general`.

claim 로그인 (`/claim/<token>`) 은 §3.3.5이지 이 절이 아니다.

### 2.7 웹훅으로 보내기

**설정 → 웹훅**에서 설치를 만든다 (`native` 또는 `slack_compatible`). 네이티브는 `POST /v1/webhooks/{workspace}/{installation}` 에 일회 시크릿으로 HMAC 헤더를 붙인다 (ADR-0115). Slack 호환은 `POST /hooks/{token}` 에 `{"text":"…"}` (`blocks` 는 400). 폐기·미지 자격은 두 경로 모두 **404** 같은 문장, HMAC 실패는 **401**. 본문 상한 262144바이트(413), 설치별 레이트리밋은 429. Slack 호환 공개 URL은 `https://<origin>/hooks/<token>` 이다 (정본 ADR-0115 D2).

---

## 3. 환경별 분기

분기가 달리 말하지 않으면 §2를 먼저 한다 (Grok Bot 스냅샷 + claim 예외).

### 3.1 로컬 머신

D-4 기본이다 (사용자 노트북의 에이전트에 붙여넣기).

1. §2.1 clone (또는 이 트리) → doctor preflight. Docker Desktop에서는
   clone이 엔진이 bind-mount할 수 있는 경로여야 한다 (보통 사용자 홈
   아래). macOS의 `/tmp` 는 VM과 **공유되지 않는** 경우가 많다 —
   그때 compose가 `infra/rust/Caddyfile.local` 마운트에 실패한다
   ("not a directory"). `~/oort` (또는 다른 홈 경로)에 clone한다.
2. §2.2 공개 digest (이 checkout이 이미지이면 `--local-build`).
3. §2.3 env. 나중에 `--compose up` 이 다른 checkout이 `oort` 를
   소유해서 거절하면, env 파일이 **아직 없을 때만** §2.3처럼
   `COMPOSE_PROJECT_NAME` 을 넣고 다시 생성한다. 파일이 이미 있으면
   시크릿을 다시 만들지 말고 `COMPOSE_PROJECT_NAME`,
   `DB_VOLUME_NAME`, `DRIVE_VOLUME_NAME` 을 같이 맞춘다
   ([SELF_HOST.md](SELF_HOST.md) 「두 체크아웃을 같이 쓸 때」).
4. §2.4 기동.
5. **게이트:** `scripts/oort doctor --json` → `summary.verdict=PASS`.
6. §2.6 브라우저 로그인. 여기서는 루프백 HTTP가 상시 클라이언트다.

`caddy.override.yml` 을 켜지 마라. 루프백을 떠날 생각이 아니면
`--public-origin` 을 돌리지 마라 (그때는 여기가 아니라 §3.2다).

**완료:** doctor PASS + 로그인.

### 3.2 자기 도메인이 있는 VPS

자기 도메인이 있으면 URL 문제가 없다. 에이전트가 터널을 고르지 않는다.

1. 이 VM에서 §2 (공개 digest). **게이트:** 루프백에서 doctor PASS.
2. DNS A/AAAA를 **이** 기계로 가리킨다. 통제하지 않는 이름에 인증서를
   주문하지 마라.
3. **시크릿을 다시 만들지 말고** 오리진을 등록한다. 같은 호출이
   `OORT_SITE_ADDRESS` 와 `OORT_CSP_CONNECT_SRC` 를 파생한다 (SH-2).
   그 키를 손으로 적지 마라. 와일드카드 (`https://*.example.test`) 는
   거절된다 (#1792). `--public-origin` 은
   `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin` 을 다시 쓰지 않는다 —
   그 센티널이 이미 요청 Host에서 공개 호스트를 덮는다 (#1788).

```sh
scripts/self_host_env.sh --public-origin https://<host>
```

4. `--compose` 는 canonical 파일 집합을 바꿀 수 없다. **공개** 오버레이는
   그 DNS를 소유한 기계에서만 켠다. 빈 `OORT_SITE_ADDRESS` 는 compose /
   `caddy validate` 를 실패시킨다 — ACME 오발 브레이크다. 노트북에서 이
   오버레이를 올리지 마라.

```sh
ENV_FILE=infra/rust/local.secrets.env
docker compose --env-file "$ENV_FILE" \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/caddy.override.yml up -d
```

5. **게이트:** `scripts/oort doctor --json` — `public.healthz` 200 과
   `public.websocket` 101. 로그인 `realtimeWebSocketUrl` 은
   `wss://<host>/connection/websocket` 이어야 한다. `ws://localhost` 이면
   기존 env에 `MOMO_CENTRIFUGO_WS_URL=same-origin` 한 줄을 넣고
   재시작한다. **시크릿을 다시 만들지 마라.**

**완료:** 공개 검사 포함 doctor PASS.

### 3.3 Grok Bot VM (Tailscale Funnel)

**이 사용자** 벤더 VM에서의 개인 체험용이다. 팀 서버가 아니다. 업무·상시
사용은 덤프(§3.3.18)를 가져가 VPS로 간다.

영속성은 **durable-but-resettable** (RA-4): `/workspace` 파일은 남고,
Docker 이미지와 패키지는 Update 때 사라질 수 있다. Reset은 스냅샷
롤백이다. 그래서 Postgres는 첫 `up` 전에 `/workspace` 아래 bind-mount한다.

v1 도달성 = **Tailscale Funnel** (사용자 자기 tailnet, RA-7 M1).
공개 주소 `https://<machine>.<tailnet>.ts.net`. `/workspace` 아래 state가
살아 있으면 재프로비저닝에도 URL이 남는다. 불변식은 "URL은 바뀌지
않는다"(인터뷰). 에이전트가 단계를 집행하고, 사람은 브라우저만 쓴다.

**M1만 쓴다.** 노드는 사용자 자기 tailnet에 들어간다. oort tailnet에
고객 노드를 수용하는 모델(RA-7 M2/M3)은 Tailscale ToS §2.1 / §2.3 위반
소지이고 셀프호스트 독립을 무너뜨린다. 채택하지 않는다.

성공 기준(인터뷰 → RA-7): **사람 터미널 명령 0회**, 콜드 15분, 복구 5분.
**계정 0개는 달성하지 못한다.** Funnel은 tailnet이 필요하다. 사람은
브라우저에서 4–5회 클릭한다 (가입 / 로그인 / 노드와 Funnel 승인.
Disable key expiry는 권고 추가). claim 비밀번호 + 앱 로그인은 §3.3.14
예산이다.

공인 IP는 정보 단계다. 이 스택의 웹 엣지는 루프백이라, IP가 있다고
Funnel을 생략하지 않는다.

```sh
curl -fsS --max-time 5 https://1.1.1.1/cdn-cgi/trace || true
```

`ip=` 가 RFC1918/링크로컬이 아니어도 §3.3.6으로 간다. 실측 VM은
공인 inbound가 없다.

> 하네스(기획/운영자 전용): `scripts/dev/grokbot_cdp/README.md`.

#### 3.3.0 VM Docker 점검·대안

이 벤더 VM에서 실측됨(E2E-A, 2026-09-09): overlayfs가 불가할 수 있다
(스토리지 드라이버가 `vfs`로 떨어진다), Docker bridge와 iptables가
막힐 수 있다(허용된 우회는 `network_mode: host`), env DB 호스트를
손으로 고치는 것은 이탈이며 허용된 우회가 아니다.

Engine / Compose 설치(§3.3.1) **전에** 점검 명령 3개:

```sh
docker info --format '{{.Driver}}'
docker network create --driver bridge oort-preflight-bridge
iptables -L
```

`docker network create` 가 성공하면 프로브 네트워크를 즉시 지운다:

```sh
docker network rm oort-preflight-bridge
```

실패당 허용된 우회는 하나뿐이다:

1. **스토리지 드라이버** (`docker info` Driver가 `overlay2` / `overlay`
   가 아니거나, overlayfs에서 엔진이 뜨지 않음): 허용된 우회는 `vfs`
   스토리지 드라이버다. `/etc/docker/daemon.json` 에
   `{"storage-driver":"vfs"}` 를 쓰고 Docker를 재시작한다. 세 번째
   드라이버를 고르지 마라.
2. **Bridge** (`docker network create --driver bridge` 실패): env 생성에
   `--platform host-network` 를 붙인다(§3.3.3 명령에 그 플래그를 넣는다).
   생성기가 내부 URL을 `127.0.0.1:<port>` 로 쓰고
   `infra/rust/docker-compose.host-network.yml` (`network_mode: host`) 을
   렌더한다. `--compose` 와 아래 `oort_compose` 가 스탬프를 보고 그
   오버레이를 붙인다. env를 손으로 고치지 마라.
3. **iptables** (`iptables -L` 이 permission-denied이거나 쓸 수 없음):
   bridge와 같은 생성기 옵션 — `--platform host-network`. 이 VM에서
   iptables를 풀려고 하지 마라.

**env 손수정은 우회가 아니다.** `infra/rust/local.secrets.env` 의
`DATABASE_URL` / `MOMO_APP_DATABASE_URL` / `RELAY_DATABASE_URL` /
`MIGRATE_DATABASE_URL` 호스트를 다시 쓰지 마라. 변경은 생성기 옵션으로만
표현한다 (`scripts/self_host_env.sh` 의 `--published-image`,
`--platform host-network`, `--public-origin` 등). §3.3.0 우회로도
스택이 안 뜨면 **env를 고치지 마라** — 우회를 §3.3.14 핸드오프 메시지에
남기고 멈춘다: 화면을 사람에게 넘긴다(ADR-0184 D2).

#### 3.3.1 스냅샷 (git 없음)

git clone은 하지 않는다. **curl + tar + Docker Engine + Compose v2 +
openssl + jq**. 공개 스냅샷 tarball 안에 `scripts/self_host_env.sh` 가
들어 있고, 시크릿 정합에 필요하다 — 12개 값 중 넷은 URL과 비밀번호가
서로 같아야 하고, 어긋나면 스택은 healthy인데 로그인이 영원히 안 된다.

```sh
docker compose version
openssl version
curl --version
jq --version
```

이 파일이 이미 레포 루트에 있으면 그 디렉터리를 쓴다. 아니면:

```sh
curl -fsSL -o oort.tar.gz \
  https://github.com/yeomyeonggeori/oort/archive/refs/heads/track/engine.tar.gz
tar -xzf oort.tar.gz
cd oort-track-engine
```

`track/engine` 은 랜딩 브랜치다. 승격 뒤에는 `refs/heads/main` /
디렉터리 `oort-main`.

**게이트:** `scripts/oort doctor --json` — tools pass (env skip은 OK).

그다음 §2.2 공개 digest (pull + inspect). 이 VM에서 `--local-build` 를
쓰지 마라.

#### 3.3.2 Postgres를 `/workspace`에 둔다

RA-4 §8.3 보수 기본. Docker named volume만 쓰면 Update 때
`/var/lib/docker` 와 함께 사라질 수 있다. bind는 첫 `up` **전에** 만든다.

```sh
mkdir -p /workspace/oort-pgdata /workspace/oort-backups
if docker volume inspect oort-pgdata >/dev/null 2>&1; then
  docker volume inspect oort-pgdata
else
  docker volume create \
    --driver local \
    --opt type=none \
    --opt o=bind \
    --opt device=/workspace/oort-pgdata \
    oort-pgdata
fi
```

이미 있는 볼륨이 `/workspace/oort-pgdata` bind가 **아니면** **여기서
멈춘다.** 남의 볼륨을 지우지 마라. 복원은 §4 / §3.3.18.

**게이트:** `docker volume inspect oort-pgdata` Options에
`device=/workspace/oort-pgdata` 가 보인다.

#### 3.3.3 claim 모드 env

```sh
scripts/self_host_env.sh --published-image \
  "$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
```

§3.3.0 (b) 또는 (c)가 실패했으면 `--published-image` 앞에
`--platform host-network` 를 넣는다. 생성된 env를 손으로 고치지 마라.

생성기는 항상 `MOMO_INITIAL_OWNER_PASSWORD` 를 쓴다. ADR-0166 claim
모드는 **상호 배타**다 (`MOMO_BOOTSTRAP_CLAIM=1` + 이메일만).
`--compose` 는 비밀번호 키를 요구하므로, claim 부팅은 같은 canonical
파일로 `docker compose` 를 직접 호출한다.

```sh
ENV_FILE=infra/rust/local.secrets.env
umask 077
tmp="${ENV_FILE}.claim"
awk '
  index($0, "MOMO_INITIAL_OWNER_PASSWORD=") == 1 { next }
  index($0, "MOMO_BOOTSTRAP_CLAIM=") == 1 { next }
  { print }
  END { print "MOMO_BOOTSTRAP_CLAIM=1" }
' "$ENV_FILE" >"$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
```

env를 cat/grep 해서 stdout에 흘리지 않는다. 이미 claim 수술된 파일이면
같은 awk가 멱등이다.

**「생성기를 다시 돌리지 않는다」의 범위 (#1790).**

- **유효 — 시크릿 재생성·`--compose` 기동.** 비밀번호 키가 없으면
  `--compose`와 파일-없음 재생성 경로는 거절한다(ADR-0166). 기동은
  아래 `oort_compose`다.
- **무효 — 이미 있는 env의 유지보수.** 공개 주소가 생긴 뒤
  `--public-origin` (§3.3.9)은 시크릿을 다시 만들지 않는다.
  `MOMO_BOOTSTRAP_CLAIM=1` 이고 비밀번호 키가 없으면 그 경로만
  비밀번호 검증을 면제하고 `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL` 과
  `CENTRIFUGO_ALLOWED_ORIGINS` 를 갱신한다. 비밀번호가 **있는** env는
  12–128자 dotenv-safe를 강제한다.

```sh
oort_compose() {
  extra=()
  if grep -q '^MOMO_SELF_HOST_PLATFORM=host-network$' "$ENV_FILE"; then
    extra+=(-f infra/rust/docker-compose.host-network.yml)
  fi
  docker compose --env-file "$ENV_FILE" \
    -f infra/rust/docker-compose.rust.yml \
    -f infra/rust/local.override.yml \
    "${extra[@]}" \
    "$@"
}

oort_compose up -d --pull missing --wait
```

`--wait` = 컨테이너 healthy. 제품 게이트는 doctor다. 이 엣지는
`127.0.0.1` 에만 바인딩된다(TLS 없음).

**게이트:** `scripts/oort doctor --json` — 스택이 PASS여야 한다.
doctor의 fix 문구가 `--compose` 이고 이 env가 claim 모드면
`oort_compose` 를 쓴다.

#### 3.3.4 헬스와 합류 표면 (루프백)

Doctor가 이미 잰다 (`stack.healthz`, `stack.agent_port`). 손으로 curl해야
하면:

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
code=$(curl -sS -o /tmp/oort-healthz.body -w '%{http_code}' \
  "http://127.0.0.1:${WEB_PORT}/healthz")
test "$code" = 200
```

본문은 `{"status":"ok",...}` 이고 시크릿이 없다. 200이 없으면
`oort_compose logs api` 하고 멈춘다.

```sh
curl -sS -D - -o /dev/null -X POST \
  "http://127.0.0.1:${WEB_PORT}/v1/mcp/agent-port"
```

**게이트:** `401` 과 `WWW-Authenticate: Bearer scope="agent:port:connect"`.
아니면 이 이미지에 합류 표면이 없다 — 비밀번호를 만들지 마라.

#### 3.3.5 claim 경로

migrate가 원문을 stdout에 **한 번만** 낸다. 재기동은
`MOMO_BOOTSTRAP_CLAIM=skipped` 를 인쇄한다. 첫 `up` 직후 바로 담는다.

```sh
umask 077
oort_compose logs migrate | sed -n 's/.*\(MOMO_CLAIM_PATH=\/claim\/[A-Za-z0-9_-]\{43\}\).*/\1/p' \
  | tail -n 1 > /workspace/oort-claim.env
chmod 600 /workspace/oort-claim.env
```

**게이트:** `/workspace/oort-claim.env` 가 비어 있지 않고
`MOMO_CLAIM_PATH=/claim/` 로 시작한다. 비어 있으면 **멈춘다.** 현재
`releases/latest.json` pin이 이 경로를 인쇄해야 하는 이미지다. 빈
파일은 다른 이미지이거나 migrate가 인쇄하지 않은 것이다. 비밀번호
키를 되살리는 것은 ADR-0004 위반이다.

토큰을 다시 인쇄하지 마라. §3.3.14에서 터널 URL과 이어 붙일 때만
읽는다.

#### 3.3.6 Funnel 불변식 — state

**권장이 아니다.** Tailscale에서 노드 정체성은 계정도 hostname도 아니고
state 안의 노드 키다. ServeConfig(funnel)와 TLS 인증서가 같은 state
dir에 함께 있으므로, 한 묶음으로 복원되고 Let's Encrypt 재발급은
**0회**다 (RA-7 RQ-1).

state를 잃으면 URL이 바뀌고, **되돌릴 수 없다** — 이름 자동회수 없음,
삭제된 이름 재사용 불가(#1200), 같은 이름을 다른 노드가 이어받으면
기존 방문자 브라우저가 CT 오류로 깨진다(#15702, closed as not planned).

정본 경로: **`/workspace/oort/ts-state`**. Docker named volume이나
`/var/lib/tailscale` 은 Update 때 패키지·이미지와 함께 사라질 수 있다
(RA-4). `/workspace` bind가 보수 기본이다.

```sh
mkdir -p /workspace/oort/ts-state
```

**게이트:** 이 디렉터리가 있고 쓰기 가능하다. 재프로비저닝마다
(벤더 Settings → Updates → Update, 또는 Reset) **다른 명령을 치기
전에** 이 경로를 확인한다. 비어 있거나 없으면 멈추고 사용자에게
URL 상실을 알린다. 같은 이름으로 새 노드를 다시 만들지 마라.

#### 3.3.7 Funnel 설치 · 로그인 · 서빙

패키지는 Update 때 증발한다(RA-4 replaceable). 정체성은 state에만
산다. 재설치는 같은 블록을 다시 밟되, **state를 지우지 않는다.**

```sh
curl -fsSL https://tailscale.com/install.sh | sh
```

설치기가 기본 `--state=/var/lib/tailscale/tailscaled.state` 로 데몬을
띄운다. 그 위치는 durable이 아니다. userspace networking은
`/dev/net/tun` / `NET_ADMIN` 이 없음을 전제한다(RA-7).

```sh
# systemd drop-in when systemd exists. Otherwise start tailscaled with the
# same arguments.
mkdir -p /etc/systemd/system/tailscaled.service.d
printf '%s\n' '[Service]' 'ExecStart=' \
  'ExecStart=/usr/sbin/tailscaled --statedir=/workspace/oort/ts-state --socket=/run/tailscale/tailscaled.sock --tun=userspace-networking' \
  > /etc/systemd/system/tailscaled.service.d/oort.conf
systemctl daemon-reload
systemctl restart tailscaled
```

`systemctl` 이 없으면 설치기가 연 데몬을 멈추고:

```sh
# do not run this block when systemctl exists
tailscaled --statedir=/workspace/oort/ts-state \
  --tun=userspace-networking \
  --socket=/run/tailscale/tailscaled.sock
```

백그라운드로 유지한다. `--statedir` 과 기본 `--state=파일` 을 같이
주지 않는다.

로그인(M1). `--hostname` 을 고정한다. 미지정 시 OS hostname 드리프트가
URL을 바꾼다(RA-7 P3). 콘솔의 "Auto-generate from OS hostname" 은
끈다.

```sh
# Interactive: send the printed login URL to the user. There is no secret
# in that URL's path that belongs in logs.
tailscale up --hostname=oort-server
```

사용자가 가입 / 로그인 / 노드 승인을 끝낼 때까지 기다린다.
`tailscale status` 에 이 노드가 보여야 §3.3.10으로 간다.

사용자가 auth key를 한 번만 붙여 넣으면 `--auth-key` 가 브라우저 URL을
대체한다. 키를 echo하지 마라.

```sh
# When TS_AUTHKEY is an OAuth client secret (tskey-client-…),
# ?ephemeral=false is mandatory. Missing it, the node is ephemeral by
# default and the URL evaporates in 30–60 minutes (RA-7 §2.1, kb/1111).
# If a query string already exists, append &ephemeral=false.
# Console reusable auth keys (tskey-auth-…) turn ephemeral off on the
# create screen.
tailscale up --hostname=oort-server --auth-key="$TS_AUTHKEY"
```

Funnel. `--bg` 는 ServeConfig를 state에 써서 재시작 후 자동 재개한다.
`--yes` 는 프롬프트를 건너뛴다. **종료코드로 성공을 판정하지 않는다.**
tailnet에 HTTPS+funnel nodeAttr이 없으면 CLI는 사람 브라우저 URL을
인쇄하거나, 비대화형에서 **조용히 종료코드 0으로 끝난다**(RA-7 §1.9).

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
tailscale funnel --bg --yes "${WEB_PORT}"
```

인쇄된 관리 콘솔 URL이 있으면 사용자에게 보낸다(Funnel 최초 활성 1클릭).
로컬 `tailscale funnel status` / `serve status` 가 active여도 외부 도달의
증거가 **아니다**(RA-7 P8 — control plane 미동기화 시 TLS에서 조용히
드롭, Open #19508).

공개 주소 = `https://` + `tailscale status` Self DNSName (끝의 `.` 제거).
`-1` 접미사는 이미 충돌이다 — 멈추고 새 이름으로 밀어붙이지 마라.

등가 형상(공식 컨테이너): `TS_STATE_DIR` 을 `/workspace/oort/ts-state` 에
bind, `TS_HOSTNAME=oort-server`, `TS_AUTH_ONCE=true`,
`TS_USERSPACE=true`, 호스트 루프백에 닿으려면 `--network host`. CLI는
`docker exec` 로 같다. 그 이미지 digest는 우리 발행물이 아니라
**핀하지 않는다.**

무인 서버는 노드 키 만료(기본 180일)를 끈다. 태그 없는 M1: 콘솔에서
해당 노드 **Disable key expiry**(권고 1클릭). 안 끄면 만료 날 URL이
죽는다(RA-7 P6). Tailnet Lock은 켜지 않는다(v1, RA-7 C7).

**게이트:** `tailscale status` 에 이 노드가 있다. DNSName에 `-1` 이
없다. `/workspace/oort/ts-state` 가 비어 있지 않다. 이 게이트는 외부
도달이 아니다 — §3.3.10이 그것이다.

#### 3.3.8 Update / Reset 뒤

1. `/workspace/oort/ts-state` 가 남아 있는지 확인한다. 없으면 중단.
2. tailscale 패키지/이미지가 없으면 §3.3.7 설치만 다시 한다. state를
   포맷하거나 `tailscale logout` 하지 않는다.
3. 같은 `--statedir` / `TS_STATE_DIR` 로 데몬을 살린다. `--bg` 설정이
   있으면 funnel은 자동 재개한다. 명령을 다시 쳐도 무해한 편이지만
   "Background configuration already exists" 면 그대로 둔다.
4. §3.3.10을 다시 통과한다. URL이 baseline과 **글자 단위로 다르면**
   사용자에게 상실을 알리고 새 주소를 회신한다(희귀 폴백). 같은
   이름을 다른 노드에 붙이지 않는다.

Update 뒤 멱등 이미지 복원(이미지는 사라지고, env는 다시 만들지 않는다):

```sh
APP_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
docker pull "$APP_REF"
# if the bind volume is missing, walk §3.3.2 again (do not rm an existing volume)
# if Funnel state (/workspace/oort/ts-state) is missing, walk §3.3.6 — the URL changes
oort_compose up -d --pull missing --wait
```

그다음 doctor(§2.5)를 다시 한다. claim 파일은 이미 소비됐을 수 있다 —
재발급하지 않는다.

#### 3.3.9 공개 오리진 등록

공개 주소가 생긴 뒤에 **시크릿을 다시 만들지 마라.** 한 줄.
브라우저 Origin(`https://…`)과 RN 소켓 Origin(`wss://…`)을 같이 넣는다.
신규 설치는 `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin` 이라 요청
Host가 출처다(ADR-0169 증보 1). `--public-origin` 은 그 센티널을
건드리지 않는다. 두 번 실행해도 항목은 하나다. claim 수술 env
(`MOMO_BOOTSTRAP_CLAIM=1`, 비밀번호 키 없음)는 이 유지보수 경로에서
허용된다 — 「생성기를 다시 돌리지 않는다」(§3.3.3)는 시크릿 발행과
`--compose` 에만 적용된다.

```sh
scripts/self_host_env.sh --public-origin https://<public-host>
oort_compose up -d
```

재시작은 `oort_compose`다. claim 모드에서
`scripts/self_host_env.sh --compose` 는 거절한다(비밀번호 키 필요).
비밀번호가 **있는** 사람 노트북 env는 [`SELF_HOST.md`](SELF_HOST.md)처럼
`--compose` 를 쓴다.

**레거시 env 한 줄 (#1790 복원).** 생성기가
`MOMO_CENTRIFUGO_WS_URL points at loopback` 을 경고하면 — 경고만 하고
고치지 않는다 — 이미 있는 env의 그 한 줄을
`MOMO_CENTRIFUGO_WS_URL=same-origin` 으로 고친 뒤 재시작한다(ADR-0167).
원격 클라가 자기 localhost로 WS를 여는 것을 막는다. **시크릿 재생성
없음.**

**확인:** 로그인 응답(claim 직후 포함)의 `realtimeWebSocketUrl` 이
`wss://<public-host>/connection/websocket` 과 같다.
`ws://localhost` 이면 same-origin과 api 재시작을 다시 본다.

`--public-origin` 은 `OORT_SITE_ADDRESS` 와 `OORT_CSP_CONNECT_SRC` 도
파생한다. 이 분기는 여전히 `caddy.override.yml` 을 **켜지 않는다.**

**게이트:** `scripts/oort doctor --json` — Funnel이 살아 있으면
`public.*` 가 fail이면 안 된다.

#### 3.3.10 외부 도달성

**성공 판정은 `tailscale funnel` 종료코드도, 로컬 `funnel status` 도
아니다.** 외부에서의 HTTP 200 + WebSocket 101만 본다 (RA-7 C5 · §1.9 ·
P8). 둘 다 나오기 전에 핸드오프를 보내지 않는다.

`TUNNEL_URL` 은 `https://<machine>.<tailnet>.ts.net` (자리표시 — 실값을
문서에 쓰지 않는다). VM 안에서 같은 이름을 MagicDNS(100.x)로 풀면
Serve이지 Funnel ingress가 아니다. 거기서 200/101이 나와도 외부
방문자는 TLS에서 실패할 수 있다. 공인 DNS를 우선하고, 아니면 사용자
브라우저 1회가 외부 실측이다.

Doctor의 `public.healthz` / `public.websocket` 은
`CENTRIFUGO_ALLOWED_ORIGINS` 에 Funnel 오리진이 있으면 같은 두
프로브다. 우선:

```sh
scripts/oort doctor --json
```

수동 등가:

```sh
# TUNNEL_URL = https://<machine>.<tailnet>.ts.net
code=$(curl -sS --max-time 20 -o /tmp/oort-tunnel-healthz.body -w '%{http_code}' \
  "${TUNNEL_URL}/healthz")
test "$code" = 200

ws_key=$(openssl rand -base64 16)
curl -sS --max-time 20 -D /tmp/oort-tunnel-ws.hdr -o /dev/null \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: ${ws_key}" \
  "${TUNNEL_URL}/connection/websocket"
ws_code=$(awk 'NR==1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9][0-9][0-9]$/) { print $i; exit } }' \
  /tmp/oort-tunnel-ws.hdr)
test "$ws_code" = 101
```

WS는 Origin을 보내지 않는다(R-2: 무 Origin → 101). 403 → §3.3.9를
다시 본다. 로그인 토큰은 이 게이트의 입력이 아니다.

**게이트:**

| 호출 | 기대 |
|---|---|
| `GET ${TUNNEL_URL}/healthz` | 200 |
| `GET ${TUNNEL_URL}/connection/websocket` (Upgrade) | 101 |

하나라도 아니면: tailscaled를 **한 번만** 재시작하고 같은 두 프로브를
다시 한다(P8 워크어라운드). 재시작으로 고쳐지면 이 환경의 부트스트랩에
"프로비저닝 후 1회 재시작 + 외부 검증"이 필요하다. 그래도 실패하면
핸드오프를 보내지 않는다. CLI가 Funnel 승인 URL을 인쇄했으면 사용자에게
그 클릭을 요청한 뒤 재측정한다.

루프백 `POST /v1/mcp/agent-port` 401은 §3.3.4 / doctor다. 터널 성공
판정에 넣지 않는다.

공개 URL은 **사실상 공개 주소**다. 주소를 아는 사람은 로그인 화면까지
도달한다. 소유권은 claim 토큰이다(ADR-0166). 초기 비밀번호는 없다.

#### 3.3.11 폴백 — cloudflared quick tunnel

Funnel을 켤 수 없을 때만. **임시·개발용.** URL은 프로세스마다 휘발한다.
이 VM의 egress는 Cloudflare 대역을 공유하므로 quick tunnel 1015 rate
limit에 **구조적으로 노출**된다(RA-5). Cloudflare 자신도 production을
금하고 SLA가 없다. **이 경로로 핸드오프한 주소는 production이 아니다.**
사용자에게 휘발과 1015를 같이 고지한다. 고정 URL → Funnel 또는 §3.2.

```sh
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${WEB_PORT}"
```

로그의 `https://<id>.trycloudflare.com` 이 주소다. 재기동하면 바뀐다.
§3.3.9와 §3.3.10 (200+101)은 같다. 1015/429 → 멈추고, 재시도로 한도를
연장하지 마라.

#### 3.3.12 숙련자 매트릭스

사용자에게 이미 도메인이 있으면 터널을 건너뛴다. 이 표는 기본 경로가
아니다.

| 경로 | 도메인 | 고정 URL | WS | 계정 |
|---|---|---|---|---|
| Tailscale Funnel | 불요 | 예 (state 영속) | 예 — #18827 미실측 | Tailscale |
| Cloudflare named tunnel | **필요** | 예 | 장시간 미실측 | Cloudflare |
| 자기 리버스 프록시 | **필요** | 예 | 자기 인프라 | 자기 인프라 |
| quick tunnel | 불요 | 아니오 | 예 (R-2 실측) | 없음 |

**CF named tunnel의 CF-origin 판정은 미확증**이다(RA-6 §2.3). 이 문서는
벤더-VM egress(Cloudflare 대역)가 자기 zone named tunnel에서 1015를
피한다고 쓰지 않는다. Funnel 앞 커스텀 도메인 CNAME은 공식 미지원 ·
#16478 closed as not planned (RA-6 §1.10) — 「숙련자」 경로로 CNAME만
얹지 않는다.

#### 3.3.13 알려진 위험

- **Funnel WebSocket `1001 Going Away` 드롭** (GH #18827, Open, 2026-02-27~,
  스태프 무응답). Serve에서 10–40초 주기. Funnel도 같은 reverse-proxy
  경로를 탄다(RA-6 — 추정). Centrifugo 실시간 레일 **직격 가능**. 우리
  1h+ soak는 **미실측**. 증상: 데스크탑 실시간이 반복해서 끊긴다. 확인:
  (1) `127.0.0.1:${WEB_PORT}/connection/websocket` 루프백은 유지되는가
  (2) 공개 URL만 1001인가 (3) Centrifugo/클라 disconnect code. 루프백은
  살아 있고 Funnel만 떨어지면 #18827 후보 — 조용히 quick tunnel로
  바꾸지 말고 사용자에게 보고한다. 재현이 확정되면 Funnel 기본 경로는
  이 인스턴스에서 성립하지 않는다.
- Funnel은 2022-11 알파 이후 **3년 9개월째 beta**(RA-6). 대역폭 한도
  비공개, SLA 없음. 용량 계획의 근거로 쓰지 않는다.
- Let's Encrypt 중복 인증서 한도(5 / 7일, 리필 ≈ 34h)는 state를 잃었을
  **때만** 의미 있다. 살아 있는 state → 재발급 호출 0회.

#### 3.3.14 사용자 핸드오프

§3.3.10 게이트를 통과한 뒤에만 회신한다. 비밀번호를 보내지 않는다.
claim 토큰은 URL 안에만 있고, 이 한 번뿐이다. TTL 24h, 단회 소비.
§3.3.0 우회를 썼으면 (`vfs` 그리고/또는 `--platform host-network`) 이
메시지에 적는다.

아래 괄호를 실값으로 바꾼다. `<token>` 원문을 이 파일에 다시 적지 말고,
`/workspace/oort-claim.env` 의 `MOMO_CLAIM_PATH` 를 터널 주소 뒤에 붙인다.

```text
oort를 이 컴퓨터(당신의 그록봇 VM)에 켜 두었습니다. 팀 공용 서버가 아닙니다.
이 VM 위 구동은 개인 체험용입니다. 업무·상시 사용은 덤프를 가져가 자기
서버(VPS 등)에서 하세요.

1) 데스크탑 앱
   https://github.com/yeomyeonggeori/oort/releases/latest
   macOS dmg는 공개 릴리스가 준비되는 대로 이 페이지에 올라갑니다
   (T-3). 지금 dmg가 없으면, 아래 claim 링크로 비밀번호만 만든 뒤
   dmg가 올라온 다음 접속하세요. 웹 브라우저로 터널 주소를 상시
   쓰는 경로는 v1이 아닙니다.

2) 서버 주소 (데스크탑의 「서버 주소」칸)
   <TUNNEL_URL>

3) 첫 소유자 등록 (이 링크는 한 번만, 24시간)
   <TUNNEL_URL><MOMO_CLAIM_PATH>
   이메일 칸은 owner@oort.local 입니다. 비밀번호는 당신이 정합니다.
   저에게 비밀번호를 보내지 마세요.

4) 첫날 사용
   워크스페이스 · 사람 초대 · AI 연결 · 첫 멘션:
   https://raw.githubusercontent.com/yeomyeonggeori/oort/track/engine/docs/SELF_HOST_FIRST_DAY.md

5) 데이터가 사는 곳
   이 VM은 durable-but-resettable 입니다. 앱 Update 때 Docker 이미지는
   사라지고, /workspace 파일은 남는 쪽입니다. 공개 주소는
   /workspace/oort/ts-state 가 살아 있으면 바뀌지 않습니다. 그 경로를
   잃으면 주소는 되돌릴 수 없고, 그때만 제가 새 주소를 보냅니다.

6) 오늘 백업 (중요)
   그록 트라이얼이 잠기면 VM 자체에 못 들어갑니다(B7). 구독을 해지해도
   같습니다. 첫 메시지를 보내기 전에 /workspace/oort-backups 에 덤프를
   만들어 두었습니다. 첨부 파일은 Postgres 밖 보관소 볼륨(기본 oort-drive)에
   있습니다. 덤프와 그 볼륨을 같이 내려받으세요. 복원 절차:
   https://raw.githubusercontent.com/yeomyeonggeori/oort/track/engine/docs/runbooks/selfhost-pg-dump-restore.md

7) 저를 팀에 넣으려면
   데스크탑에서 로그인한 뒤 에이전트 → 호스티드 에이전트 연결에서
   저를 만들고, 화면에 한 번만 보이는 「연결 값」을 이 대화에 붙여
   주세요. 제가 VM 안에서 합류합니다. Grok 앱 커넥터에 주소를 넣을
   필요가 없습니다.
```

#### 3.3.15 첫날 백업

회신 전에:

```sh
scripts/self_host_pg_dump.sh --output-dir /workspace/oort-backups
```

**게이트:** `/workspace/oort-backups` 아래 `.dump` 파일이 있고, 스크립트
stdout에 비밀번호가 없다. 사용자에게 그 폴더를 워크스페이스에서
내려받으라고 한다(§3.3.14-6). 덤프 바이트를 채팅에 붙이지 않는다. 첨부
바이트는 `DRIVE_VOLUME_NAME`(기본 `oort-drive`)에 있으므로 덤프만으로
복원되지 않는다 — 런북의 보관소 동반 한 줄을 같이 따른다.

#### 3.3.16 에이전트 합류 (루프백 curl, static bearer)

합류에는 벤더 앱 커넥터·플러그인·routine을 **쓰지 않는다.** #1361
커넥터 헤더 미지수는 이 경로의 전제가 아니다. ADR-0162 static bearer를
VM 루프백에서 소모한다. 합류 뒤 실시간 wake는 §3.3.17.

순서는 사용자가 claim을 먼저 소비하는 것이다. 에이전트는 사용자
비밀번호를 모른다. 연결 생성·승인은 데스크탑 위저드가 한다.

1. 사용자가 §3.3.14-3 claim URL에서 비밀번호를 만들고 데스크탑으로
   `<TUNNEL_URL>` 에 로그인한다.
2. **설정 › 연결 › 에이전트 자격**(또는 **에이전트** → **호스티드 에이전트 연결**)
   → 표시 이름/핸들로 만든다.
3. 위저드의 1회용 **연결 값**을 이 대화에 붙여 넣는다(15분 TTL).
4. 환경 변수로만 받는다. echo/로그/회신에 되풀이하지 않는다.
5. **VM 안에서** 루프백으로 handshake(터널 URL이 아님):

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
EP="http://127.0.0.1:${WEB_PORT}/v1/mcp/agent-port"
curl -sS -X POST "$EP" \
  -H "authorization: Bearer ${PAIRING_VALUE}" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"oort-operator","version":"0.0.0"}}}}'
```

**게이트:** handshake가 성공하면 위저드가 감지 상태로 넘어간다. 실패
(401): 같은 값을 다시 묻지 말고 **연결 값 다시 발급**을 안내한다.
잘못된 era/body는 값을 소비하지 않는다.

6. 사용자가 채널·권한을 확인한다. 한 번만 보이는 **active credential**을
   붙여 넣는다. pairing과 다른 비밀이다.
7. 같은 `EP` 로 active credential handshake를 한 번 더 한다. 5단계와
   같은 `server/discover` curl이다. `active` / unpause를 증명하는 것은
   foundation 요청(`server/discover` 또는 `tools/list`)뿐이다.
   pairing bearer나 아직 증명 안 된 `detected` 자격으로 `tools/call`
   (§3.3.17.4 `oort_inbox_read` 원문 포함)을 보내면 HTTP 401, 본문
   없음. 저장·재인쇄하지 않는다.

**게이트:** 무인증 POST는 계속 401. 멘션에 에이전트 뱃지가 보이면 합류
완료. 첫 멘션 왕복은 T-6, 감지 원클릭은 T-5 — 이 플레이북은 curl
왕복까지다.

Update/Reset 뒤 재합류: 위저드 **연결 값 다시 발급**
(`POST …/pairing-challenge/regenerate`)은 `pairing_pending` ·
`detected` · `expired` 에서만 된다 — `pairing_pending` 으로 되돌리고
같은 pairing curl. `active` 에서는 regenerate가 409. active credential
을 잃었으면 사람이 disconnect 한 뒤 새 연결을 만든다.

라우트 대조표 (2026-09-08 #2230, Rust 핸들러 실측. 문서 줄은 이 절):

| 단계 | 문서 | 라우트 | 인증 | 상태 |
|---|---|---|---|---|
| 1 생성 | `:944` 2단계 | `hosted_agent_connections.rs:127` `lib.rs:1045` | 사람 workspace-admin JWT | → `pairing_pending` (에이전트 paused) |
| 2 pairing handshake | `:947` 5단계 curl | `agent_port.rs:33` `lib.rs:1225` | pairing bearer (`momo_pair_v1`, 15분 TTL) | `pairing_pending` → `detected` |
| 3 confirm | `:965` 6단계 | `hosted_agent_connections.rs:714` `lib.rs:1057` | 사람 workspace-admin JWT | `detected` 유지; active credential 발급 |
| 4 active 재핸드셰이크 | `:967` 7단계 `server/discover` | `agent_port.rs:33` + `prove_hosted_binding_in_tx` | hosted-active bearer | `detected` → `active` (unpause) |
| 5 regenerate | `:978` 재합류 | `hosted_agent_connections.rs:653` `lib.rs:1053` | 사람 workspace-admin JWT | `pairing_pending`/`detected`/`expired` → `pairing_pending`; `active` → 409 |

벤더 채팅 앱을 CDP·스크립트·셀렉터로 제어하지 않는다. 사람은 말하고,
에이전트는 VM 셸에서 이 파일을 집행한다.

#### 3.3.17 도어벨 (실시간 wake)

합류(§3.3.16) 뒤의 가속기다. 정본 전달은 여전히 durable inbox다
(ADR-0171 D5). oort가 내용 없는 wake를 벤더 루틴 webhook에 POST하고,
에이전트는 인증된 Agent Port로 일감을 가져간다. 도어벨 body는 상수
`{"kind":"oort.doorbell.v1"}`. 메시지 내용·id·워크스페이스 식별자는
실리지 않고, **어떤 필드도 신뢰 입력이 아니다**(ADR-0171 D2).

drain은 `hosted_agent_inbox_counter` 를 본다. 합류가 `active` 가 아니거나
채널이 승인되지 않으면 벨은 울리지 않고, 스윕이 회수할 일도 없다.

**이 인스턴스는 이 사용자 벤더 계정/VM 전용이다.** 남의 루틴 URL/key를
넣지 말고, 팀 VM을 공용 도어벨 대행으로 쓰지 마라.

Agent Hub UI 등록은 WD-2(#1735). 랜딩 전까지 WD-1 REST가 정본이다.

이 절은 ADR-0171(#1734)이 실린 이미지를 전제한다. §2.2 pin이 그 이전
발행이면 webhook-sender 로그에 `doorbell drain` 문자열이 없고, 등록 PUT
은 빈 404다. 그때는 이 절을 수행하지 않는다.

##### 3.3.17.1 벤더 쪽 — webhook 루틴

사용자가 벤더 채팅에 붙여 넣는 표준 문안이다. 이 플레이북을 수행하는
에이전트가 자기 루틴을 만들 때도 이 문안을 그대로 쓴다. 트리거 종류를
다른 말로 바꾸지 않는다(실측된 webhook 문안).

```text
루틴을 하나 만들어줘. 이름 oort-doorbell / 트리거: webhook(외부 시스템이 HTTP POST로 시작) / 내용: (아래 §3.3.17.4 프로덕션 지시문을 그대로) / enabled 로 켜 둬. 만든 뒤에는 enabled 여부만 알려줘. 거기서 멈춰.
```

**사람 승인 지점 (ADR-0184 D2).** webhook URL과 sender key는 벤더 앱
**Info pane** 에만 있다. 에이전트는 그 pane을 읽을 수 없고, 읽겠다고
말해서도 안 된다. 루틴이 생기면 에이전트는 **멈추고 화면을 사람에게
넘긴 뒤** 기다린다. 사람이 Info pane을 열어 https webhook URL과 sender
key를 이 대화에 한 번 붙여 넣는다. 그 값이 오기 전에 에이전트는
§3.3.17.3으로 넘어가지 않는다.

**게이트:** 루틴이 enabled 이고, 사람이 https webhook URL과 sender key를
붙여 넣었다. URL·key 원문을 이 파일에 다시 적지 않는다. §3.3.17.3에
쓸 때만 환경 변수로 받고, 이후 회신·로그에 되풀이하지 않는다.

##### 3.3.17.2 oort 쪽 — 게이트를 연다

등록 REST와 sender drain은 `MOMO_DOORBELL_ENABLED` 가 소문자 **`true`**
일 때만 열린다(ADR-0171 D6). **선행** 게이트는
`MOMO_HOSTED_DELIVERY_ENABLED` — 같은 철자. `scripts/self_host_env.sh` 가
만든 신규 env 는 소문자 `true` 를 쓴다. 기존 env 는 이 블록을 돌리기
전까지 off. 그 값이 없거나
`true`가 아닌 채 도어벨만 켜면 멘션이 hosted inbox로 가지 않아
(`hosted_delivery_not_enabled` skip) 울릴 대상이 없다. 켠 것처럼
보이는데 아무 일도 안 일어난다. `True` / `TRUE` / `1` / `yes` / `on`
은 둘 다 닫힘. 시크릿을 다시 만들지 말고 그 두 줄만 넣는다. api **와**
webhook-sender 둘 다 두 변수를 읽는다 — 한쪽만 재시작하면 등록은
되는데 발화가 없거나, 그 반대가 된다.

```sh
ENV_FILE=infra/rust/local.secrets.env
umask 077
tmp="${ENV_FILE}.doorbell"
awk '
  index($0, "MOMO_DOORBELL_ENABLED=") == 1 { next }
  index($0, "MOMO_HOSTED_DELIVERY_ENABLED=") == 1 { next }
  { print }
  END {
    print "MOMO_HOSTED_DELIVERY_ENABLED=true"
    print "MOMO_DOORBELL_ENABLED=true"
  }
' "$ENV_FILE" >"$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
oort_compose up -d
```

**게이트:** `oort_compose exec api env` 와
`oort_compose exec webhook-sender env` 에 두 줄이 `=true` 로 보인다
(compose가 값을 전달하지 않으면 호스트에만 있다).
`oort_compose logs --tail 30 webhook-sender` 에 `doorbell drain starting`
이 보인다. `doorbell drain idle (MOMO_DOORBELL_ENABLED!=true)` 이면
철자가 틀린 것이다 — 멈춘다. 사람 관리자 세션 PUT이 **빈 404**를
반환해도 같다(게이트 닫힘과 미지 경로는 같은 빈 404).

Doctor: `env.bool.doorbell` 과 `env.bool.hosted_delivery` 는 값이
unset/닫힘 **또는** 소문자 `true` 일 때 pass. 잘못된 truthy 문자열은
**fail**(조용히 닫힘).

##### 3.3.17.3 oort 쪽 — REST 등록

경로(OpenAPI `registerHostedAgentDoorbell` /
`unregisterHostedAgentDoorbell`):

```
PUT    /v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/doorbell
DELETE /v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/doorbell
GET    /v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}
```

전용 GET 도어벨 라우트는 없다. 마스킹 확인은 PUT 응답과 커넥션 GET이다.

요청 JSON (`RegisterHostedDoorbellRequest`, additionalProperties 거부):
`url` (https, 1..2048) + `secret` (write-only, 1..4096). 응답
(`HostedDoorbellResponse`): `connectionId`, `url`, `secretMasked`,
`registeredAtMs`. 발화 뒤에는 `lastFiredAtMs` · `lastStatus` 가 붙을 수
있다. 시크릿 원문은 응답·로그·DB에 없다. PUT/DELETE 응답 헤더에
`Cache-Control: no-store` 와 `Pragma: no-cache` 가 붙는다.

커넥션 GET 투영 이름: `doorbellUrl` / `doorbellSecretMasked` /
`doorbellLastFiredAtMs` / `doorbellLastStatus`. 미등록이거나 게이트가
닫히면 **필드 자체가 생략**된다(flag-off GET은 도어벨 이전과 byte-동일).

URL은 https만(셀프호스트 `MOMO_ENV=staging` 은 HTTP 개발 예외가 닫혀
있다). OutboundHTTPPolicy가 사설망/루프백/링크로컬/userinfo/fragment를
거절한다(400). 발신 쪽은 redirect를 따르지 않는다. 커넥션이 `active` 가
아니면 409 (`doorbell requires an active hosted connection`). 사람
워크스페이스 관리자가 아니면 403. 시크릿이 비거나 4096바이트를 넘으면
400 (`doorbell secret must not be empty` / `doorbell secret exceeds the
sealed-box bound`). 커넥션이 없으면 404 (`hosted connection not found`).

`ACCESS_TOKEN` 은 사람 워크스페이스 관리자 세션이다. 사용자가 로그인
응답 `accessToken`(TTL 15분)과 `member.workspaceId` 를 한 번만 붙여
넣는다. 에이전트는 로그인 curl을 실행하지 않는다 — 비밀번호를 모른다.
에이전트 pairing/active 자격은 이 경로가 아니다. 토큰을 회신에
되풀이하지 않는다.

`CONN` 은 합류가 끝난 hosted 커넥션 id. 목록:

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
curl -sS -o /tmp/oort-hosted-conns.body -w '%{http_code}' \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections"
```

**게이트:** HTTP 200. `connections[]` 에서 `status` 가 `active` 인 항목의
`id` 가 `CONN` 이다. 본문을 대화에 붙이지 않는다.

등록(같은 URL로 다시 PUT하면 교체·재봉인, 발화 시각은 초기화):

```sh
curl -sS -o /tmp/oort-doorbell.body -w '%{http_code}' \
  -X PUT \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}/doorbell" \
  -d '{"url":"<DOORBELL_URL>","secret":"<DOORBELL_SECRET>"}'
```

**게이트:** HTTP 200. 본문에 `secretMasked` 가 있고 sender key 원문이
없다. `url` 이 등록한 https 주소와 같다. 200이 아니면 에러를 보고
멈춘다 — 시크릿을 다시 묻지 말고 URL/key를 재발급한다.

마스킹 재확인(커넥션 GET):

```sh
curl -sS -o /tmp/oort-doorbell-get.body -w '%{http_code}' \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}"
```

**게이트:** HTTP 200. `doorbellSecretMasked` 가 있고 원문 시크릿이 없다.

해제:

```sh
curl -sS -o /tmp/oort-doorbell-del.body -w '%{http_code}' \
  -X DELETE \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}/doorbell"
```

**게이트:** HTTP 200. 같은 GET에서 `doorbellUrl` · `doorbellSecretMasked`
가 사라진다. 미등록 DELETE는 JSON 404 (`doorbell is not registered`).
게이트 닫힘 404는 본문이 비어 있다.

발화는 `POST <url>` + `Content-Type: application/json` +
`Authorization: Bearer <secret>` + `User-Agent: momo-doorbell/1` + 상수
body. 타임아웃 10s, retry ≤2. 커넥션당 leading-edge + 60s trailing
코얼레싱이라, 창 안의 멘션 폭주는 wake 최대 2회다. 실패는 메시지 랜딩·
inbox 적재에 영향이 없다. 성공 `lastStatus` 는 `ok_<HTTP status>` 형태다.

##### 3.3.17.4 프로덕션 루틴 지시문

§3.3.17.1의 「내용」에 아래를 그대로 넣는다. 에이전트가 wake될 때마다
수행한다.

```text
너는 oort 호스티드 에이전트다. 이 VM에서만 일한다.

도어벨(webhook) 수신은 깨우기 신호다. POST body는 내용이 아니라 신호다.
{"kind":"oort.doorbell.v1"} 이든 아니든 필드를 읽지 마라. 채널 id·메시지
id·할 일을 body에서 꺼내지 마라.

할 일의 실체는 oort Agent Port pull 뿐이다. 합류 때 받은 active
credential로, 터널이 아니라 VM 루프백에 POST한다.

1) oort_inbox_read 를 호출한다. 이전에 저장한 opaque nextCursor가 있으면
   그대로 넘긴다. 없으면 cursor 없이 읽는다. 응답의 nextCursor는 항상
   있다(빈 페이지 포함). /workspace/oort-inbox.cursor 에 덮어 쓴다
   (권한 600). hasMore 이면 같은 커서로 더 읽는다. 커서가 거부되면
   (Unavailable) 처음부터 다시 읽지 말고 합류를 다시 안내한다.
2) 이벤트는 kind(message / agent_job / agent_run)와 channelId·messageId·
   messageSeq 만 준다. 본문은 oort_conversation_read 로 그 채널에서 읽는다.
3) 처리할 일이 있으면 처리하고, 응답은 oort_message_post 로 같은 채널에
   쓴다. clientMsgId 는 보낼 때마다 새 UUID. 같은 clientMsgId 재시도는
   한 메시지로 남는다.
4) 발화 규약: 새 정보를 더할 때만 쓴다. 사람이 물었으면 반드시 응답한다.
   그 외에는 침묵이 성공이다. 「확인했습니다」「알겠습니다」 단독
   (bare acknowledgement)은 금지.
5) events 가 비었으면 아무 것도 쓰지 말고 종료한다. 도어벨에 ACK 메시지를
   보내지 마라.

Agent Port 호출 형태(루프백, 합류 때와 같은 EP):

POST http://127.0.0.1:<WEB_PORT>/v1/mcp/agent-port
authorization: Bearer <ACTIVE_CREDENTIAL>
content-type: application/json
accept: application/json, text/event-stream
mcp-protocol-version: 2026-07-28
mcp-method: tools/call
mcp-name: oort_inbox_read

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"oort_inbox_read","arguments":{}}}

oort_message_post / oort_conversation_read 도 같은 헤더에 mcp-name 과
params.name 만 바꾼다. 자격·커서를 회신 본문에 반복하지 않는다.
```

##### 3.3.17.5 15분 스윕 폴백

도어벨은 벤더 webhook 트리거라 silent no-fire가 날 수 있다. 같은
지시문을 저빈도 cron에 한 번 더 둔다. 두 루틴은 같은 inbox cursor 파일
(`/workspace/oort-inbox.cursor`)을 쓴다. 이미 소비한 자리 뒤는 빈
페이지라 중복 wake는 무해하다.

도어벨(§3.3.17.1)이 **1차 wake** 이고, 스윕은 **보조**다. 자발 발화를
약속하지 않는다. `@every 15m` 스케줄 루틴의 첫 실행은
지연 가능(수십 분)이다 — 실측 E2E-A 첫 발화는 ~28분. 카피는
manual-run 수준으로 한정한다(#1361 기준 3).

```text
루틴을 하나 만들어줘. 이름 oort-inbox-sweep / 트리거: 15분마다 반복(cron). webhook이 아님. / 내용: (oort-doorbell과 같은 프로덕션 지시문 §3.3.17.4를 그대로) / 만든 뒤 enabled 여부를 알려줘.
```

**게이트:** 루틴이 enabled 이고 주기가 15분. 1분 폴링으로 낮추지 않는다.
첫 실행 지연을 설치 실패로 보지 마라.

##### 3.3.17.6 고지

- 도어벨 1회 = 벤더 루틴 run 1회 = 구독 usage 소모. 그래서 서버가 60s
  창으로 합친다. 스윕도 run이다. 고빈도 cron으로 도어벨을 대체하지 마라.
- webhook 트리거는 벤더 베타 표면이다. 문서 없이 바뀔 수 있다. 15분
  스윕이 그 안전망이다.
- 이 사용자 벤더 계정/VM 전용. 공용 대행 없음.
- sender key, doorbell secret, active credential, 세션 토큰을 커밋하지
  마라. `.env`, 이슈, PR, 스크린샷에 원문을 붙이지 마라. 도어벨
  시크릿은 모델 provider 자격이 아니지만 취급은 같다(ADR-0171).

실기동 E2E(멘션 → 도어벨 → 응답, 목표 p50 ≤ 90s)는 이 문서의 게이트가
아니다. 그 수용 런은 자연어 지시 릴레이로 따로 한다.

#### 3.3.18 데이터 가져가기

정본: [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

```sh
scripts/self_host_pg_dump.sh --output-dir /workspace/oort-backups
```

벤더 이탈·구독 해지·B7 트라이얼 잠김 전에 사용자가 이 폴더를 VM 밖으로
복사해야 한다. 앱 UI export 버튼은 후속 티켓(본 파도 미발급).

복원:

```sh
scripts/self_host_pg_restore.sh --dump /workspace/oort-backups/oort-pg.dump
```

`--dump` 경로가 없으면 스크립트가 거절한다. 복원 뒤: `oort_compose up
-d --wait` 와 doctor(§2.5).

Postgres가 비어 보이거나 로그인이 안 되면 데이터가 소실된 것이다.
덤프가 있으면 `/workspace/oort-backups` 에서 복원한다. 없으면
사용자에게 알리고, 비밀번호를 만들지 마라.

##### 3.3.18.1 연결 해제 (HAP-E6)

호스티드 연결을 끊는 것은 위의 덤프와 별개 단계다. 히스토리는 남는다.
이 경로는 live bearer를 회수하고 provider 정리를 기다린다.
`ACCESS_TOKEN` / `WS` / `CONN` / `WEB_PORT` 는 §3.3.17.3 것을 재사용한다.

1. 사람 관리자 세션이 disconnect를 시작한다. **게이트:** HTTP 200,
   `connection.status` 가 `cleanup_pending`, kind별 매니페스트가
   시드된다(kind 행 + 명명 항목). live active 자격은 이미 회수됐다
   (Agent Port discover → 401).

```sh
curl -sS -o /tmp/oort-disconnect.body -w '%{http_code}' \
  -X POST \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}/disconnect" \
  -d '{"artifacts":[{"kind":"routine","externalRef":"oort-doorbell"},{"kind":"routine","externalRef":"oort-inbox-sweep"},{"kind":"secret","externalRef":"active-credential"},{"kind":"bot","externalRef":"grokbot"}]}'
```

2. 에이전트에게 지시 1회 → 정리 매니페스트 **1회**. 두 번 묻지 마라.
   어떤 줄의 `residual` 이 `none` 이 아니면 그 항목만 지목한 후속 지시
   1회 → 매니페스트 1회 더(최대 2라운드; 실측: 잔여 파일 4, 후속 1회).
   필수 줄 형식(실측):

```text
kind · name · status(deleted/absent/preserved) · residual
```

예시:

```text
routine · oort-doorbell · deleted · residual none
routine · oort-inbox-sweep · deleted · residual none
secret · oort-active-credential · deleted · residual none
plugin · (none) · absent · residual none
bot · grokbot · preserved · residual none
```

3. 서버 매니페스트 각 행을(사람 관리자 세션만 — 라우트가 `require_human`)
   `{currentStatus, disposition, evidence}` 로 acknowledge 한다. 행 id는
   disconnect 응답에서 읽는다:
   `jq -r '.cleanupArtifacts[]|[.id,.kind,(.externalRef//"-")]|@tsv' /tmp/oort-disconnect.body`
   — 그 값으로 `ARTIFACT_ID` 를 돌린다. **`disposition` 을 주면 `evidence`(1..2000B)가
   필수다.** 빼먹으면 HTTP 400
   `a manual acknowledgement requires 1..=2000 bytes of evidence`.
   `evidence` 에는 봇 매니페스트 한 줄을 붙여 넣는다. 실측 짝:
   `bot` = preserve / `present`; `secret` = revoke / `absent`; 나머지는
   delete / `absent`.

```sh
curl -sS -o /tmp/oort-ack.body -w '%{http_code}' \
  -X POST \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}/cleanup-artifacts/${ARTIFACT_ID}/acknowledge" \
  -d '{"currentStatus":"absent","disposition":"delete","evidence":"routine · oort-doorbell · deleted · residual none"}'
```

4. required 행이 모두 해결되면 disconnect를 완료한다. **게이트:** HTTP
   200, `connection.status` `disconnected`, `remainingRequired` 0.

```sh
curl -sS -o /tmp/oort-disconnect-complete.body -w '%{http_code}' \
  -X POST \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}/disconnect/complete"
```

#### 3.3.19 하지 말 것

- 팀 VM을 공용 호스트로 쓰기
- 벤더 채팅 앱 CDP / 자동화
- 이 문서의 금지는 사용자·공개 표면 기준이며, 개발자 로컬 검증 하네스는
  `scripts/dev/grokbot_cdp/README.md`를 따른다
- 비밀번호 · pairing/active 원문을 회신에 반복
- claim 실패를 `MOMO_INITIAL_OWNER_PASSWORD` 로 우회
- 웹 브라우저를 터널 URL의 상시 클라이언트로 안내한다 (v1은 데스크탑)
- 이 VM에서 `caddy.override.yml` / 운영 Caddyfile 을 이름 부르기 (ACME)
- 전역 `DOCKER_DEFAULT_PLATFORM=linux/amd64`
- 아직 데이터가 있는 볼륨에 `down -v`
- 도어벨 sender key · doorbell secret을 회신·이슈·커밋에 반복
- `MOMO_DOORBELL_ENABLED` 나 `MOMO_HOSTED_DELIVERY_ENABLED` 를
  `True` / `1` / `yes` 로 연다 (소문자 `true`만). 도어벨만 켜고
  hosted-delivery가 없으면 멘션이 inbox로 가지 않는다.

실기동 E2E(D7)는 이 문서의 게이트가 아니다. 여기의 게이트는 에이전트가
다음 층으로 넘어가도 되는지를 가른다.

### 3.4 Railway

카탈로그: [`infra/railway/README.md`](../../infra/railway/README.md) ·
[`infra/railway/railway.json`](../../infra/railway/railway.json).
compose와 같은 GHCR 이미지(`releases/latest.json`), 커맨드 넷
(`api` · `relay` · `webhook-sender` · `agent-worker`), 공개 엣지는 Caddy,
Centrifugo는 `CENTRIFUGO_*`(파일 마운트 없음), Postgres는 플러그인.
LiveKit은 이 템플릿에 없다. 이 레포가 싣지 않는 compose 스택을 만들지
마라. 플랫폼 시크릿을 대화에 붙이지 마라.

1. Railway 계정 + 프로젝트. Postgres 플러그인을 붙인다. `railway.json`의
   서비스 여섯(이미지, `startCommand`, api `preDeployCommand`)을 만든다.
   공개 도메인은 **caddy**에. api는 내부에 둔다.
2. 플러그인 URL과 caddy 호스트명이 생긴 뒤:

```sh
scripts/self_host_env.sh --platform railway
```

   (`--railway`는 별칭.) 환경에 `RAILWAY_PUBLIC_DOMAIN`과 `DATABASE_URL`이
   필요하다(둘 중 하나라도 없으면 명시 실패 — doctor `public.*` skip이
   아니다). 어떤 변수를 읽고 어떤 키가 손에 남는지는 `platform_profiles`
   행이 말한다. stdout KEY=value를
   Railway 변수로 넣는다. 생성기 파일에 없는 compose 보간 키 셋
   (`CENT_API_URL`, `WORKER_DATABASE_URL`, Centrifugo proxy 헤더)은 README.
3. 배포. api preDeploy(런타임 롤 → migrate)가 끝나고 caddy `/healthz`가
   답할 때까지 기다린다.
4. 게이트:

```sh
scripts/oort doctor --json
```

   `public.healthz`와 `public.websocket`이 PASS여야 한다. 남길 인스턴스가
   아니면 프로젝트를 지운다.

**플랫폼 URL이 생긴 뒤 게이트:** `scripts/oort doctor --json` 에서
`public.healthz` pass.

### 3.5 Fly

T1. compose 절차는 볼륨 달린 Fly VM 1대 위의 §3.2다. 플랫폼 프로비저닝
레시피(`fly.toml` + 볼륨, 사용자 로그인의 `flyctl`)는 SH-11b. env는 §3.2(`IMAGE_REF`는 §2.2에서 읽은 값)
파생에 행 이름을 더한 것이다:

```sh
scripts/self_host_env.sh --platform fly --published-image "$IMAGE_REF" --public-origin https://<host>
```

사람 승인 지점: Fly 가입·결제, 커스텀 도메인 DNS.
**게이트:** 공개 오리진 등록 뒤 `scripts/oort doctor --json`.

### 3.6 AWS

T1. compose 절차는 소유한 Lightsail/EC2 VM 위의 §3.2다. 프로비저닝은
[`infra/aws/README.md`](../infra/aws/README.md)(최소 Terraform, 사용자
세션의 `aws` CLI). Lightsail이 기본이고 EC2는 같은 모듈의
`compute = "ec2"`. 액세스 키를 붙이지 마라.
`aws sts get-caller-identity --query Arn --output text`가 사용자 본인
신원인지 확인하고, 계정 ID는 출력하지 않는다. 루트 사용자는 쓰지 않는다.

사람 승인 지점(본인 계정·본인 비용 — 에이전트는 멈추고 화면을 넘긴다):

1. 브라우저에서 AWS SSO / 로그인.
2. plan 리소스 수(Lightsail 7 / EC2 6)를 보여 준 뒤 `terraform apply`.
   요금이 여기서 발생한다.
3. Budgets 알림 이메일.
4. 운영자 호스트의 DNS A 레코드 → 출력 IP.
5. `terraform destroy`와 데이터 디스크 삭제(`prevent_destroy`라 두 단계).

SSH 사용자는 `ubuntu`. env(`IMAGE_REF`는 §2.2, 또는 VM의
`/data/oort-image-ref`):

```sh
scripts/self_host_env.sh --platform aws-lightsail --published-image "$IMAGE_REF" --public-origin https://<host>
```

이어서 `scripts/oort up`과 §3.2의 공개 오버레이. ACME는 이 VM의 DNS가
소유한 호스트명에만. 포트 5432는 열지 않는다. Docker `data-root`는 추가
디스크의 `/data/docker`이지 루트 디스크가 아니다.

**게이트:** 공개 검사 포함 `scripts/oort doctor --json`. day-2는 VPS와 같이
SSH.

### 3.7 GCP

T1, `gcloud`와 `--platform gcp-vm`으로 §3.6과 같은 계약. 사람 승인 지점:
GCP 가입·결제, OAuth 동의, DNS 레코드.
**게이트:** 공개 검사 포함 `scripts/oort doctor --json`.

---

## 4. Day-2

정본:

```sh
scripts/oort status
scripts/oort logs
scripts/oort upgrade
scripts/oort backup
scripts/oort restore <dump>
scripts/oort member invite
scripts/oort member credential --agent <handle>
```

**업그레이드 (이미지는 사라지고, env는 유지해야 한다):**
`scripts/oort upgrade`. 그것이 명령이다. 아래 산문은 설명이지 두 번째
절차가 아니다.

실행 중/env digest 를 `releases/latest.json` 과 비교하고 (`digest_list`,
정규식 `sha256:` + 소문자 hex 64; list ≠ arch), 먼저
`scripts/oort backup` (`--no-backup` 으로만 생략), env 와 이름 붙은
볼륨/`Caddyfile.local` bind 가 있는지 다시 보고 (볼륨을 만들거나 지우지
않음), `compose pull` + `up -d`, migrate `IDEMPOTENCY_OK` 대기,
`/healthz` 대기, `scripts/oort doctor` PASS. 실패하면 롤백 명령을
**인쇄**만 하고 (`scripts/oort upgrade --to <이전> --no-backup --yes`)
실행하지 않는다.

```sh
APP_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
scripts/oort upgrade --to "$APP_REF" --yes
```

claim 모드: `--compose` 대신 `oort_compose` (§3.3.3). Grok Bot VM은
`/workspace` bind와 Funnel state도 다시 본다(§3.3.8).

**백업 / 복원** (PITR 아님; 정본
[`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md)):
`scripts/oort backup` 과 `scripts/oort restore <dump>`. 복원은 메시지가
이미 있는 스택을 거부한다. dest 에 런타임 롤(`momo_app`/`momo_relay`/
`momo_worker`)이 없으면 `pg_restore` 앞에 compose 서비스 `runtime-roles`
(`MOMO_RUNTIME_ROLE_PROVISION=1`)를 돌린다 — GRANT SQL 을 손으로 쓰지
않는다. 래퍼는 아래 두 스크립트를 호출만 한다 (`pg_dump`/`pg_restore`
호출부 신설 없음):

```sh
scripts/oort backup --out ./oort-backups
scripts/oort restore ./oort-backups/oort-pg.dump --yes
```

첨부는 `DRIVE_VOLUME_NAME`(기본 `oort-drive`)에 산다. 덤프와 그 볼륨을
같이 가져간다. `down -v` 는 이 env가 이름 붙인 볼륨을 지운다.

**T2 (관리형 PG):** 같은 네 명령에 `--tier t2`, 경로는
`MIGRATE_DATABASE_URL`. 이미지 경로 `/opt/momo/scripts/oort`. 플랫폼
one-off(Railway CLI/MCP)는 SH-11a이지 이 CLI가 아니다. upgrade는
토큰 없는 digest 교체 명령을 인쇄하고, 볼륨 inspect·compose 재작성은
하지 않는다. 완료 조건은 `scripts/oort doctor --tier t2 --json` PASS.
생성기가 T2 스탬프를 찍기 전까지(#2328)는 `--tier t2`를 넘기거나
서비스 변수 `MOMO_SELF_HOST_PLATFORM=railway`를 설정한다. 런북:
[`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md)
§ T2.

```sh
scripts/oort backup --tier t2 --env <env> --out <dir>
scripts/oort restore <dump> --tier t2 --yes --env <env>
scripts/oort upgrade --tier t2 --yes --env <env>
scripts/oort doctor --tier t2 --json
```

**로그:** `scripts/oort logs api` (시크릿 값은 `***`). claim 모드의
직접 compose 는 그대로 유효하다:

```sh
scripts/self_host_env.sh --compose logs api
scripts/self_host_env.sh --compose logs migrate
scripts/self_host_env.sh --compose logs relay
```

---

## 5. 막히면

먼저 `scripts/oort doctor --json` 을 돌린다. `checks[].id` 를 fix
문자열에 대응시킨다(doctor가 fail에 이미 `fix` 를 인쇄한다). id 요약:

| id | 흔한 실패 | 고침 |
|---|---|---|
| `tool.docker` / `tool.compose` | Engine 또는 Compose v2 없음 | Docker Engine + Compose v2 플러그인 설치 (하이픈 `docker-compose` v1이 아님). |
| `tool.jq` / `tool.openssl` | 바이너리 없음 | jq / openssl 설치. |
| `tool.disk` | < 1 GiB (blocker) 또는 < 2 GiB (major) | pull + 볼륨용 공간 확보. |
| `env.exists` | `infra/rust/local.secrets.env` 없음 | `scripts/self_host_env.sh --published-image` 또는 `--local-build`. |
| `env.mode` | 0600 아님 | `chmod 600 infra/rust/local.secrets.env` |
| `env.duplicate_keys` | 키 중복 | 한 줄만 남긴다. |
| `env.scalars` | 값에 CR | Docker env는 한 줄 scalar. |
| `env.required_keys` | 생성기 키 누락 | 생성기가 만든 env를 쓴다. |
| `env.bool.doorbell` / `env.bool.hosted_delivery` | 켜려는데 소문자 `true`가 아님 | `true`만 연다. `True`/`1`/`yes`는 조용히 닫힌다. |
| `env.bool.unfurl` | 켜려는데 문자 `1`이 아님 | Unfurl은 `1`만 연다. |
| `env.platform_admin_emails` | 없거나 빈 값 → AI 연결 403 | 기존 파일에 생성기를 다시 돌려 그 줄만 붙이고, api 재시작. |
| `env.provider_link_master_key` | 없거나 빈 값 → AI 연결 503 | 생성기 키. 손으로 채워야 하면 `openssl rand -hex 24`. api와 agent-worker 재시작. |
| `env.drive_archive_backend` | 없거나 빈 값 → 첨부 503; staging에서 `stub` 거절 | `MOMO_DRIVE_ARCHIVE_BACKEND=local`. |
| `env.centrifugo_ws_url` | 없거나, 터널 뒤에서 루프백 | `MOMO_CENTRIFUGO_WS_URL=same-origin`, api 재시작. |
| `env.role_passwords` | 롤 비밀번호 ≠ URL 비밀번호 | 새 env를 만들지 마라. URL 비밀번호를 `*_POSTGRES_PASSWORD` 에 맞추거나, `down -v` 와 함께만 재생성. |
| `env.digest` | 공개 이미지가 list-digest pin이 아니거나 `releases/latest.json` 과 다름 | 매니페스트에서 pin. 업그레이드하려고 시크릿을 다시 만들지 마라. |
| `port.web` / `port.api` / `port.centrifugo` | 스택이 꺼져 있는데 포트 점유 | 점유 프로세스를 멈추거나 env 포트를 바꾼 뒤 up. |
| `stack.compose_ps` | 서비스 없음/unhealthy | 그 서비스에 `--compose ps` / `logs`. claim 모드: `oort_compose`. `runtime-roles` 종료코드 1에 `password authentication failed for user "momo"` 는 남은 pgdata vs 새로 만든 env — `down -v`, env 삭제, §2.3 다시 (또는 **원래** env로 `up` 재시도). |
| `stack.healthz` | 200 `database:ok` 아님 | `logs api`. |
| `stack.agent_port` | 401 + Bearer scope 아님 | 잘못된 이미지. `releases/latest.json` 확인. |
| `stack.outbox` | `done`이 아닌 행 | `push_candidate` pending 은 푸시 릴레이가 없으면 **info**(개수)이다 (`PUSH_RELAY_URL` / `docker-compose.push.yml` 의 `push-relay`/`notifier` 없음). `agent_job` pending 은 5분 미만 info, 이상이면 major(kind/status/개수/최고 나이 나열). 다른 kind: pending/failed면 `logs relay`. |
| `stack.migrate_idempotency` | `IDEMPOTENCY_OK` 없음 | `logs migrate`. |
| `public.healthz` / `public.websocket` | 공개 오리진은 등록됐는데 200/101 없음 | 터널/Caddy와 `CENTRIFUGO_ALLOWED_ORIGINS`. Funnel: §3.3.10 1회 재시작. |

Doctor 종료코드 **2**(blocker) → 핸드오프하지 않는다. 종료코드 **1**(major만)
→ Local/VPS/Grok Bot 설치에서 핸드오프하지 말고 고친 뒤 다시 돈다.
첫 `up` 전 스택 preflight `skip` 은 예상된 것이다.

로그인 `invalid credentials`: 생성기 이메일과 env 파일의 비밀번호 키를
쓴다. 셸에서 읽고, 대화에 붙이지 마라. 비밀번호 회전(모든 세션이
로그아웃)은 [`SELF_HOST.md`](SELF_HOST.md) — 대화에서 새 비밀번호를
만들지 마라.

루프백 설치에서 ACME 주문이 보이면: 공개 오버레이를 이름 불렀거나
`OORT_SITE_ADDRESS` 가 다른 호스트다. Local과 Grok Bot VM은
`caddy.override.yml` 을 켜지 않는다.
)
