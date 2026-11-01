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
| **Fly.io** (단일 VM + 볼륨) | T1 | §3.5 · [`infra/fly/README.md`](../infra/fly/README.md) | 사용자 로그인의 `flyctl` → 사용자 토큰의 Fly REST → 브라우저. | `fly auth login`; Fly 결제(볼륨·전용 IPv4); 선택 커스텀 도메인 DNS; `fly apps destroy`(볼륨 삭제). | Fly 계정; 볼륨 달린 VM 1대; 그 위의 T1 도구. | VM 위에서 T1 compose 절차 §3.2(`caddy.override.yml` + `Caddyfile`, TLS 패스스루). env `scripts/self_host_env.sh --platform fly --public-origin https://<host>` 를 볼륨에. Fly 호스트명 또는 커스텀 도메인. | VPS와 같음. |
| **AWS Lightsail / EC2** | T1 | §3.6 · [`infra/aws/README.md`](../infra/aws/README.md) (SH-11c) | 사용자 세션의 `aws` CLI / AWS MCP → REST → 브라우저. | AWS SSO/로그인; `terraform apply`(plan 리소스 수); Budgets 이메일; DNS A; `terraform destroy`(데이터 디스크). | 클라우드 계정; IAM 사용자/SSO 역할(루트 금지); VM + 추가 디스크 + 도메인. | VM 위에서 T1 compose 절차 §3.2; env `--platform aws-lightsail --public-origin https://<host>`. 운영자 도메인. | VPS와 같음. |
| **GCP VM** | T1 | §3.7 · SH-11c 패턴의 프로비저닝 레시피 | 사용자 세션의 `gcloud` → REST → 브라우저. | GCP 가입·결제; OAuth 동의; DNS 레코드. | AWS와 같음. | VM 위에서 T1 compose 절차 §3.2; env `--platform gcp-vm --public-origin https://<host>`. 운영자 도메인. | VPS와 같음. |
| **Railway** | T2 | §3.4 · 에이전트 경로 실측은 SH-11a | 사용자 OAuth 세션의 `railway` CLI(`railway setup agent`) / 원격 MCP `mcp.railway.com` → REST → 브라우저. | Railway 가입·결제; CLI/MCP의 OAuth 로그인; caddy에 공개 도메인 부여. | Railway 계정(볼륨이 되는 플랜); PG18 + pgvector 이미지 서비스; 이 기계에 Docker 불필요(발행 이미지). | 공개 엣지는 Caddy 서비스(`Caddyfile.railway`), api는 내부. env는 `scripts/self_host_env.sh --platform railway --claim`(별칭 `--railway`)이 `RAILWAY_PUBLIC_DOMAIN` + `DATABASE_URL`에서; 손으로 넣는 키(9개 이상, `infra/railway/README.md`). 플랫폼 호스트명. | 배포 오리진에서 doctor PASS(`public.healthz`, `public.websocket`). Day-2: 이미지 one-off `scripts/oort backup --tier t2 --env <env>`, `scripts/oort restore <dump> --tier t2 --yes --env <env>`, `scripts/oort upgrade --tier t2 --yes --env <env>`, `scripts/oort doctor --tier t2 --json`. `--tier t2`는 `MOMO_SELF_HOST_PLATFORM`(railway)과 같아야 한다. dump는 `MIGRATE_DATABASE_URL`만. one-off의 플랫폼 CLI/MCP는 SH-11a. |
| **Cloudflare** (엣지 전용) | T3 | §3.8 · 레시피 SH-11d (`infra/cloudflare/`) — T1/T2 행 앞단의 DNS · Tunnel · TLS | MCP `mcp.cloudflare.com`(OAuth = 승인) 또는 사용자 API 토큰 REST(`Zone:DNS:Edit` + Tunnel) → 호스트의 `cloudflared`. `wrangler`는 쓰지 않는다(Workers/Pages CLI이지 DNS/Tunnel이 아님). | Cloudflare 가입 / MCP OAuth 또는 API 토큰; 레지스트라의 네임서버 위임; 호스트의 터널 토큰; 정리 확인. | 이미 떠 있는 T1/T2 행(doctor PASS). 컴퓨트가 아니다: Containers/Workers는 채택하지 않는다(ADR-0184 D1). 사용자가 「Cloudflare로」라고 하면 먼저 T1/T2를 고른다. | 앞에 세운 행을 감싼다; 오리진은 그 행의 엣지와 `/v1/centrifugo/*` 403 순서를 유지. Cloudflare DNS의 공개 호스트명(모드 A) 또는 루프백 Caddy로의 named tunnel(모드 B). | 감싼 행과 같고, Cloudflare 호스트명 경유로 `public.*` PASS. `public.*` skip은 사용자 오류다(§3.8) — PASS가 아니다. |
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

**claim 모드:** 생성기에 `--claim` 을 붙인다. `--compose` 가 그 env를
기동한다. 두 키가 함께 있을 때만 거절한다(ADR-0166). 첫 `up` 뒤
launcher가 migrate 로그를 가리킨다 (`grep MOMO_CLAIM_PATH`).

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
   오버레이를 올리지 마라. `local.override.yml` 은 집합에 남긴다(첨부 보관소
   볼륨과 doctor 가 요구하는 `web` 서비스). 빠지면 api 가 보관소 없이 다시
   만들어져 기동을 거부한다(#2609, 실측).

```sh
ENV_FILE=infra/rust/local.secrets.env
docker compose --env-file "$ENV_FILE" \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/local.override.yml \
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
  "$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)" \
  --claim
```

§3.3.0 (b) 또는 (c)가 실패했으면 `--published-image` 앞에
`--platform host-network` 를 넣는다. 생성된 env를 손으로 고치지 마라.

`--claim` 은 `MOMO_BOOTSTRAP_CLAIM=1` 을 쓰고
`MOMO_INITIAL_OWNER_PASSWORD` 는 **쓰지 않는다**. ADR-0166: 두 키는
상호 배타다. 비밀번호 env에 `--claim` 을 다시 돌리면 거절한다(조용히
바꾸지 않는다). `--compose` 는 이 env를 기동한다. 두 키가 함께 있을
때만 거절한다.

env를 cat/grep 해서 stdout에 흘리지 않는다.

**「생성기를 다시 돌리지 않는다」의 범위 (#1790).**

- **유효 — 시크릿 재생성.** 파일-없음 재생성 경로는 여전히 이미지
  모드가 필요하다. 같은 볼륨에 두 번째 env를 만들지 마라.
- **무효 — 유지보수와 `--compose`.** 공개 주소가 생긴 뒤
  `--public-origin` (§3.3.9)은 시크릿을 다시 만들지 않는다.
  `MOMO_BOOTSTRAP_CLAIM=1` 이고 비밀번호 키가 없으면 비밀번호 검증을
  면제하고 `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL` 과
  `CENTRIFUGO_ALLOWED_ORIGINS` 를 갱신한다. 비밀번호가 **있는** env는
  12–128자 dotenv-safe를 강제한다. `--claim` 없이 claim env를 다시
  돌리면 claim으로 남는다(비밀번호 키를 넣지 않는다).

```sh
ENV_FILE=infra/rust/local.secrets.env
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

scripts/self_host_env.sh --compose up -d --pull missing --wait
```

`--wait` = 컨테이너 healthy. 제품 게이트는 doctor다. 이 엣지는
`127.0.0.1` 에만 바인딩된다(TLS 없음). 첫 `up` 뒤 launcher가 migrate
로그를 가리키는 한 줄을 찍는다
(`scripts/self_host_env.sh --compose logs migrate | grep MOMO_CLAIM_PATH`).
토큰을 붙여 넣지 마라(ADR-0004). `oort_compose` 는 이후 단계에서
`docker compose` 를 직접 부르는 플레이북 헬퍼로 남는다.

**게이트:** `scripts/oort doctor --json` — 스택이 PASS여야 한다.
doctor는 비밀번호 키 자리에 claim 키를 받는다 (`env.required_keys`).

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
건드리지 않는다. 두 번 실행해도 항목은 하나다. claim env
(`MOMO_BOOTSTRAP_CLAIM=1`, 비밀번호 키 없음)는 이 유지보수 경로에서
허용된다 — 「생성기를 다시 돌리지 않는다」(§3.3.3)는 시크릿 발행에만
적용된다.

```sh
scripts/self_host_env.sh --public-origin https://<public-host>
oort_compose up -d
```

재시작은 `--compose`(또는 `oort_compose`)다. claim env와 비밀번호 env
모두 `--compose` 를 쓴다. 비밀번호가 **있는** 사람 노트북 env는
[`SELF_HOST.md`](SELF_HOST.md)처럼 `--compose` 를 쓴다.

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
**상시 설치 = named tunnel(§3.8 / `infra/cloudflare/`)이지 이 폴백이 아니다.**

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
| Cloudflare named tunnel | **필요** | 예 | 장시간 미실측 | Cloudflare — 상시 절차 §3.8 |
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

#### 3.3.16c 사람이 AI 연결을 부탁하면 — 카드를 제안한다

ADR-0186 증보 G1(GC-6 #2947, GC-8 #2949). 사람이 AI 연결·AI 구독 로그인(Claude,
Codex)·팀 API 키 연결을 부탁하면 **런타임이 직접 하지 않는다.** 할 수도 없다. 구독
로그인은 그 사람 기기에서, 팀 키는 운영자 세션에서 한다(Hermes 자신의 모델 인증 구독은 별개다: §3.4.1). 런타임은 연결 카드를
그 사람 앞에 놓는다.

```text
oort_card_suggest {handle, clientMsgId, commandId: "ai.connect", args, body}
  -> 제안 메시지(props momo.command_suggest, 서버가 만든 다섯 키)
```

- `handle`은 그 요청을 실어 온 작업의 `oort_jobs_claim` 리스 handle이다. 서버가
  그 작업의 채널(`rootId`면 스레드)에 쓰고, 트리거 메시지를 쓴 사람에게 카드를
  보낸다. 채널·대상·제목을 정하는 인자는 없다.
- `args`는 선택이고 닫혀 있다. `harness` ∈ `claude | codex | team_key`,
  `scope` ∈ `mine | team`. 사람이 이름을 댔을 때만 `harness`를 넣는다. 다른 키
  (`apiKey`, `token` 등)는 거절된다.
- `body`는 카드 위에 보이는 한 문장 답이다. 설정 단계를 설명하지 않는다. 카드는
  그 사람의 앱이 자기 설정에서 그린다.
- **채팅에서 키·토큰·비밀번호·로그인 코드를 묻지 않는다.**
- 스코프: 도구 자체는 `messages:write`만 필요하다(G5). handle에는
  `agent:jobs:read`가 필요하다. 새 스코프·승인 카드가 없고 run도 멈추지 않는다.
  평소대로 이어서 작업을 끝낸다.
- 인박스만 읽는 루틴은 handle이 없다. 그때는 `oort_message_post`로 답하고
  입력창에 `/연결`을 치라고 알려 준다. 같은 카드가 그 사람 화면에 열린다.
- 같은 도구가 `commandId: "settings.open"`(ADR-0201 v2 H6-4)도 받는다. 설정 화면
  하나(예: 알림)를 가리키는 카드다. `args`는 정확히 `{"section": <id>}`이고
  `section` ∈ `profile | appearance | notifications | shortcuts | devices |
  workspace | members | memory | usage | code | updates | plugins`(`plugins`는 앱
  화면)다. 경로가 아니라 섹션 id다. 다른 값은 거절되니 글로 답한다.
- 그리고 `commandId: "work.request.open"`(ADR-0201 증보 v3 B8 C1)은 사람이 코드
  일을 자기 맥에 맡겨 달라고 할 때 쓴다. 카드는 그 사람의 「작업 요청」 시트를
  네가 쓴 글로 미리 채워 열고, 읽고 보내는 것은 **그 사람**이다. `args`는 필수
  `prompt`(그 사람 말투의 평문, UTF-8 1~8,000바이트, 줄바꿈·탭 말고는 제어 문자
  없음, 보이지 않는 글자 없음, `/`로 시작하지 않음 — 서명 spawn이 쓰는 규칙
  그대로)와 선택 `harness` ∈ `claude | codex`(그 사람이 댄 이름. `team_key`는
  `ai.connect`의 값이라 여기서는 거절된다)다. 다른 키(`folder`, `channel`,
  `label` 등)는 거절된다. 카드는 아무것도 실행하지 않고 자기 승인 행·감사 행도
  남기지 않는다. spawn은 그 사람이 보낼 때 소유자 기기 키로 서명한다.

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

0) 먼저 oort_ping {state:"idle"} 을 한 번 부른다. 이 런타임이 떠 있다는 것만
   oort 에 알린다(30초에 한 번만 기록되고, 더 불러도 해가 없다). 일을
   가져갔다는 뜻이 아니므로 바로 1)로 간다.

1) oort_inbox_read 를 호출한다. 이전에 저장한 opaque nextCursor가 있으면
   그대로 넘긴다. 없으면 cursor 없이 읽는다. 응답의 nextCursor는 항상
   있다(빈 페이지 포함). /workspace/oort-inbox.cursor 에 덮어 쓴다
   (권한 600). 다른 wake 가 같은 파일을 동시에 쓸 수 있으니 옆에 임시 파일을
   쓰고 이름 바꾸기로 덮어 쓴다(옛 커서가 남아도 한 페이지를 두 번 읽을 뿐이라
   해가 없다). hasMore 이면 같은 커서로 더 읽는다. 커서가 거부되면
   (Unavailable) 처음부터 다시 읽지 말고 합류를 다시 안내한다.
2) 이벤트는 kind(message / agent_job / agent_run)와 channelId·messageId·
   messageSeq 만 준다. agent_job 이벤트가 하나라도 있으면 다른 것을 읽기 전에
   3)의 추적 경로(oort_job_start)를 먼저 탄다. 일반 message 이벤트의
   본문은 oort_conversation_read 로 그 채널에서 읽는다.
   agent_run 이벤트는 그 채널에 있던 run 의 상태가 바뀌었다는 뜻이다. 사람이
   취소했거나, 네가 제안한 변경을 승인하거나 거절했다. 본문도 run id 도 없으니
   oort_conversation_read 로 그 채널을 읽고 그 run 에 대한 가장 최근 줄(제안의
   결과 줄, 또는 사람이 멈췄다는 줄)을 본다. 호환:
   이 이벤트가 생기기 전에 만든 런타임이나 모르는 kind 는 커서만 그 이벤트 뒤로
   넘기고 무시해도 된다. 결과 줄은 채널에 남아 있어서 잃는 것이 없다.
3) 처리할 일이 있으면 처리하고, 응답은 oort_message_post 로 같은 채널에
   쓴다. clientMsgId 는 보낼 때마다 새 UUID. 같은 clientMsgId 재시도는
   한 메시지로 남는다.
   이벤트 kind 가 agent_job 이면 추적되는 작업(run)이다. oort_message_post
   만 쓰지 말고 아래처럼 한다.
   순서가 중요하다(사람이 시계를 보고 있다). 깨어나면 곧바로 oort_inbox_read,
   그다음 아래 h)의 job 폴더 확인, 그다음 oort_job_start 를 부르고 그 사이에
   다른 호출을 끼우지 않는다.
   그 전에 대화를 읽거나 요청을 계획·고민하지 않는다. 응답의 work.prompt 와
   최근 대화에 요청이 이미 있다. 시작 보고 전의 매 초는 사람 화면에서 「아무
   일도 안 일어나는」 시간이다.
   여러 job 이 동시에 내 것일 수 있고, 이 VM 에서 wake 여러 개가 동시에 돌 수
   있다(도어벨과 스윕, 또는 도어벨 둘). 그래서 job 마다 폴더를 따로 두고 두
   job 이 파일을 함께 쓰지 않는다:
   /workspace/oort-runs/<tag>/ (권한 700). <tag> 는 claim 할 때 새로 만든
   UUID 다. 안에 handle(leaseHandle, 권한 600), beat(그 job 을 보고할 때마다
   touch 하는 빈 파일), workdir(그 job 전용 작업 사본 경로)를 둔다. handle 을
   파일 이름·회신·stage·로그에 넣지 않는다.
   a) oort_job_start {} 를 부른다. 한 번의 호출이 다음 job 을 claim 하고,
      시작 보고(stage "시작: 요청 확인")를 보내고, 최근 대화를 돌려준다.
      응답에는 job(leaseHandle, leaseExpiresAtMs, work(channelId, prompt,
      ...)), started(시작 보고가 들어갔으면 true), resumed,
      conversation.messages(그 채널의 최근 메시지, 최신이 먼저)가 있다.
      conversation 키가 없으면 그 채널을 읽을 권한이 없는 것이니 work.prompt 를
      쓴다. 처리할 job 이 없으면 job 이 null 이다. 받자마자 그 job 의 폴더를
      만들고 handle 과 beat 를 쓴다. 그리고 사이에 아무것도 끼우지 않고
      oort_job_start {} 를 다시 부르며, job 이 null 이 되거나
      /workspace/oort-runs 에 폴더가 4개(어느 wake 것이든)가 될 때까지 계속
      claim 한다. 다섯 번째 job 은 가져오지 않고 다음 wake 에 남긴다.
      이미 가진 job 을 다시 받으려면
      oort_job_start {leaseHandle:<그 폴더의 handle>} 를 부른다(시작 보고는 두
      번 나가지 않는다).
      job 마다 자기 작업 사본(/workspace/work/<tag>, 새 clone 이나 git
      worktree)과 자기 브랜치에서 일한다. 두 job 이 디렉터리나 브랜치를 함께
      쓰지 않는다. 이 VM 이 별도 세션이나 도우미를 동시에 돌릴 수 있으면 job
      마다 하나씩 맡기고, 안 되면 하나씩 차례로 하되 기다리는 job 도 e)·f)로
      살려 둔다.
   b) 첫 단계 이름을 직접 정하려면 oort_job_start 에 stage:"시작: <짧은 단계
      이름>" 을 넘긴다(일반 텍스트, 규칙은 아래 c와 같다). started 가 false 면
      oort_run_event {leaseHandle, status:"running", stage:"시작: <짧은 단계
      이름>", eventId:<새 UUID>} 를 한 번 보낸다. 사람 화면에서 run 을
      「가져감」에서 「시작함」으로 옮기는 호출이 이것이다. oort_jobs_claim 도
      여전히 되고 대화도 싣지만, 그때는 시작 보고를 직접 보내야 한다.
   c) 사람이 진행을 볼 수 있게 보고한다. 시작 보고(oort_job_start)는 깬 뒤 10초
      안에 나가야 한다(하드 한도는 60초). 그 뒤로는 단계가 시작될 때마다, 그리고
      일하는 동안 최소 5분마다 부른다(새 단계가 없으면 status:"running" 만
      보내도 살아 있다는 신호가 된다). stage 는 일반 텍스트 1~80자(앞뒤 공백
      제거, 40자 안팎으로), "/"·"\"·제어 문자 불가, 요청 문구를 그대로 옮기지
      않는다(사람을 인용하지 말고 단계 이름만 쓴다). 바로 앞 stage 와 같으면
      합쳐지지만 단계 수는 1 오른다. 예: "코드 읽는 중", "수정 작성", "테스트
      실행", "PR 열림". 일부를 다른 봇에게 맡기면 맡기기 전에 단계로 알리고
      ("위임: <봇> · <일>"), 결과가 돌아오면 다시 알린다("위임 결과 수신:
      <봇>") — oort 는 그 봇 안을 볼 수 없다. 비밀·파일 경로·커밋 제목·코드를
      stage 에 넣지 마라. run 카드에는 최근 12개만 남고, oort 작업 패널은 더
      오래 보관한다. 사람이 보는 것은 여기서(그리고 textDelta 로) 보고한 것뿐이다.
      oort 는 너의 추론을 볼 수 없으니 보일 거라고 기대하지 마라.
   d) 코드 작업은 이 순서로 끝내고 단계마다 stage 를 하나씩 보낸다: 1. 브랜치를
      커밋하고 올린다(stage "브랜치 올림"). VM 이 멈춰도 작업이 남는다.
      2. 테스트를 돌리고 통과·실패·안 돌림 개수를 센다(stage "테스트 실행").
      3. 저장소가 허락하면 PR 을 연다(stage "PR 열림"). 4. oort_run_complete 로
      보고한다. 갖지 않은 PR·브랜치·테스트 개수를 보고하지 않는다.
      끝나면 oort_run_complete {leaseHandle, status:"succeeded",
      body:"<회신, 8000바이트 이하>", artifacts:{prUrl, branch, added,
      deleted, commits}} 를 부른다. 실제로 가진 값만 넣는다. prUrl 은
      https://github.com/<owner>/<repo>/pull/<n>, branch 는 브랜치 이름,
      added / deleted / commits 는 0 이상 정수.
      결과 칸: wake 마다 한 번 tools/list 를 읽는다. oort_run_complete 스키마의
      artifacts 안에 resultKind 가 있을 때만 resultKind(pr_opened /
      branch_only / vm_only / no_change), tests {passed, failed, notRun}(셋
      다), nextAction(merge_ok / please_test / blocked / none), commitSha(16진수
      7~40자)를 함께 보내고, toolCounts {run, edit, read, search, web, other}
      (개수만)를 보낼 수 있다. 서로 맞아야 한다: tests·nextAction·commitSha 는
      resultKind 가 있을 때만, pr_opened 는 prUrl 필수, branch_only 는 branch
      필수·prUrl 금지, vm_only 는 prUrl·branch 금지, no_change 는 prUrl·
      branch·commitSha 금지·개수는 0 이거나 없음, merge_ok 는 pr_opened 이고
      실패한 테스트가 없을 때만. 그 호출이 HTTP 400 / -32602 로 답하면 오류
      data 가 틀린 칸을 알려 준다. 그 칸만 고쳐 같은 handle 로 최대 2번 더
      보낸다. 그래도 거절되면 artifacts 없이 완료하고 결과는 body 에 쓴다.
      tools/list 에 resultKind 가 없으면 다른 키를 보내지 말고(거절된다) body
      첫 줄을 "결과: <resultKind> · 테스트 통과 <n> 실패 <n> 안 돌림 <n> · 다음:
      <nextAction> · 커밋 <sha 앞 7자>" 로 쓴다.
      body 는
      채널에 에이전트 회신으로 게시되므로 oort_message_post 로 또 보내지
      마라. 실패하면 status:"failed" 와 error:"<사유, 4000바이트 이하>" 로
      부른다. 이 경우에도 artifacts(남긴 브랜치·부분 PR)를 실을 수 있다. oort_run_complete(성공·실패 모두) 직후
      /workspace/oort-runs 의 그 job 폴더를 지워서 다음 wake 가 죽은 handle 을
      쓰지 않게 한다.
   e) 작업이 leaseExpiresAtMs 를 넘길 수 있으면 그 전에 oort_job_renew
      {leaseHandle} 을 부른다(응답에 새 leaseExpiresAtMs). 차례를 기다리는 job
      을 포함해 가진 job 마다 한다. lease 가 만료된 뒤에는
      oort_job_release 를 부르지 않는다.
   f) 추적되는 run 안에서는 위 c)의 oort_run_event {leaseHandle,
      status:"running"} 가 살아 있음을 알리는 방법이다: 가진 job 마다 최소
      5분마다 보내고, 그때마다 그 job 의 beat 파일을 touch 한다. 그 job 의
      폴더가 없어졌으면 다른 wake 가 넘겨받은 것이니 그 job 을 바로 멈추고 그
      handle 로 더 보내지 않는다. oort_ping 은 run 을 살려 두지 못한다(ping 만 하는
      런타임은 「살아 있지만 일은 안 가져감」으로 보이고, lease 가 만료된 뒤
      2시간 동안 이벤트가 없는 run 은 서버가 끝낸다). 바쁘지만 leaseHandle 이
      없는 경우(추적되지 않는 회신)에만 최소 5분마다 oort_ping {state:"working"}
      을 부른다. 어떤 호출이든 Unavailable(HTTP 409 / -32004)·429·5xx·시간 초과가
      오면 이번 wake 를 멈추고 다음 도어벨·스윕이 다시 시작하게 한다. 루프로
      재시도하지 않는다.
   g) 오류는 고정된 답이다. HTTP 400 / -32602: 호출이 잘못됐다(잘못된 stage 나
      artifacts 키는 호출 전체를 거절하고 lease 는 그대로다). 고쳐서
      같은 handle 로 다시 보낸다. error.data 가 artifacts 칸을 짚으면
      (error.data.field, error.data.rule, 정해진 값이 있으면 error.data.allowed)
      그 칸만 고쳐서 oort_run_complete 를 다시 부른다. 고쳐 보내기는 최대 2번.
      그래도 거절되면 artifacts 없이 완료하고 결과는 body 에 쓴다. 같은 호출을
      그대로 다시 보내지 않는다. handle 을 실은 호출의 HTTP 409 / -32005:
      lease 를 잃었거나 run 이 이미 끝났거나 취소됐거나 승인 대기로 멈췄다.
      그 job 을 멈추고 재시도하지 않으며 그 폴더를 지운다(다른 job 은
      계속한다). handle 을 실은 호출의 HTTP 403 / -32003 도 같다: 그 handle 은
      죽은 것이다(옛 연결의 것, 더는 승인되지 않은 채널, 내 것이 아닌 run).
      그 job 의 폴더를 지우고 다음 job 으로 간다. 방금 409 나 403 을 받은
      handle 로 두 번째 호출을 보내지 않고, 같은 handle 로 되풀이하지 않는다.
      oort_job_start {leaseHandle} 은 200 에 job 이 null 이고 closed 키가 있는
      답도 줄 수 있다: "run_settled"(run 이 끝남) 또는 "run_awaiting_approval"
      (run 이 사람 결정을 기다리며 멈춤). 둘 다 running 이벤트를 보내지 말고 그
      job 의 폴더를 지우고 계속하라는 뜻이다.
      HTTP 409 / -32004:
      에이전트가 일시정지·연결 해제됐거나 대상이 보이지 않는다. 멈춘다.
      handle 없는 호출(oort_inbox_read, oort_jobs_claim, oort_job_start {},
      oort_ping)의 HTTP 403 / -32003: scope 나 채널 승인이 없다. 멈추고 연결
      확인을 안내한다.
   g2) 멈춘 job 은 이번 wake 에서 끝난 것이다. oort_action_propose 가 ok 로
      답한 순간 그 run 은 사람을 기다린다. 그 job 의 폴더를
      /workspace/oort-runs 에서 지우고(approvalId 는
      /workspace/oort-approvals.json 에 남긴다), 그 job 으로 oort_run_event 를
      보내지 않고, oort_job_start {leaseHandle} 로 다시 들어가지 않고,
      oort_run_complete 나 oort_job_release 도 부르지 않는다(둘 다 409).
      결과는 oort 가 올리는 한 줄로 돌아오고, 새 부탁은 새 job 이다.
   h) job 폴더 확인(oort_inbox_read 바로 뒤, claim 전). beat 가 최근 15분 안에
      touch 된 폴더는 아직 일하는 wake 의 것이니 건드리지 않는다. beat 가 더
      오래된 폴더는 멈춘 wake 가 남긴 것이다. 폴더 이름을 새 tag 로 바꿔(mv,
      이름 바꾸기가 실패하면 다른 wake 가 먼저 가져간 것이니 둔다) 가져오고,
      beat 를 touch 한 뒤 저장된 handle 로 먼저
      oort_job_start {leaseHandle:<그 handle>} 로 다시 들어간다. 409 나 403 이
      오거나 job 이 null 이고 closed 가 있으면 폴더를 지우고 다음으로 간다.
      job 이 오고 started 가 true 면 그 handle 로 보고하고(oort_run_event 또는
      oort_run_complete) 그 workdir 에서 이어 한다. /workspace/oort-run.handle
      (예전 한 job 루틴이 남긴 파일)이 있으면 새 폴더의 handle 로 옮기고 같은
      식으로 다룬다. 그 보고 전에 oort_jobs_claim 이나 handle 없는
      oort_job_start 를 먼저 부르면 새 handle 을 받고 옛 handle 은 409 가 된다.
   사람이 AI 연결·AI 구독 로그인(Claude, Codex)·팀 API 키 연결을 부탁하면
   직접 하려 하지 말고, 키·토큰·비밀번호·로그인 코드를 묻지 마라. 연결
   카드를 제안한다. oort_jobs_claim 리스 handle이 있으면
   oort_card_suggest {handle, clientMsgId, commandId:"ai.connect", body}
   를 부른다(사람이 이름을 댔을 때만 args.harness 에 claude / codex /
   team_key). handle이 없으면 oort_message_post 로 답하고 입력창에
   /연결 을 치라고 알려 준다.
4) 발화 규약(대화에 무엇을 쓰나): 진행은 대화가 아니다. 단계는 oort_run_event 의
   stage 로 보고하고(위 3 c) 메시지로 쓰지 않는다(「하는 중이에요」「확인해
   볼게요」). 메시지와 oort_run_complete 의 body 에는 결과, 막힌 점(무엇이
   막았고 무엇이 필요한지), 사람이 할 일(승인·선택·보내 줄 것)만 쓴다. 그것부터
   쓴다: 빈 인사, 요청 되풀이, 맺음말은 없다. 새 정보를 더할 때만 쓴다. 사람이
   물었으면 반드시 응답한다. 그 외에는 침묵이 성공이다. 빈 인사
   (bare acknowledgement)는 어떤 말투로도 금지다: 「확인했습니다」「확인했어요」
   「알겠습니다」「알겠어요」「진행할게요」, "got it", "understood", "on it",
   "will do". 초안에 그것뿐이면 아무것도 보내지 않는다.
   답 자리: 최종 답은 oort_run_complete 의 body 이다. oort 가 대신 올리고 자리는
   고르지 않으므로 같은 내용을 oort_message_post 로 또 보내지 않는다. 직접
   oort_message_post 로 올리는 메시지는 물어본 자리에 답한다: 1:1 DM 은
   본류(rootId 없이), 채널 최상위 멘션은 그 메시지 id 를 rootId 로, 스레드
   안은 그 스레드의 root 를 rootId 로 쓴다(oort_job_start·oort_conversation_read
   의 모든 메시지에 rootId 가 있고, 부른 메시지는 work.triggerMessageId 다).
   최상위 메시지가 DM 일 수도 있는데 구분이 안 되면 rootId 를 넣지 않는다.
5) events 가 비었어도 h)를 하고, 폴더가 4개보다 적으면 oort_job_start {} 를
   한 번 부른다(다른 wake 가 같은 페이지를 먼저 읽었을 수 있다). job 이 오면
   3 a)처럼 이어 간다. job 이 null 이고 h)에서 넘겨받은 폴더도 없으면 아무
   것도 쓰지 말고 종료한다. 도어벨에 ACK 메시지를 보내지 마라.

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

##### 3.3.17.4a 추적되는 작업: claim, 단계, 완료 (#3519 AT-6)

범위: **본인** Grok Bot 계정과 VM에서 개인·비상업 용도로만 쓴다. oort는
벤더 VM·계정을 운영하거나 읽거나 풀링하지 않고, 에이전트가 보고한 것만 받는다.
dots도 같은 패턴이고 곧 지원한다. 이 문서는 dots에 대한 개별 약속을 하지
않는다. 에이전트 추가 흐름(위저드·비밀·도어벨) 자체는 바뀌지 않았다. 그
점검 기록은 `claudedocs/agent-tracking-2026-10/at7-add-flow-audit.md`(저장소에
없는 로컬 노트)에 있고, 추가 절차의 정본은 §3.3.1~§3.3.16이다.

§3.3.17.4 루틴은 사람의 작업 요청을 팀이 볼 수 있는 run으로 바꾼다. 순서·한도·
근거(ADR-0162 증보 3 D10~D16, 부록 A)는 다음과 같다.

| 단계 | 호출 | 인자(UTF-8 바이트 한도) | 응답 |
|---|---|---|---|
| 0. 사람이 요청 | `POST /v1/workspaces/{ws}/channels/{ch}/agent-runs` 의 `type=work` (소유자가 승인한 채널·DM에서 사람이) | 해당 없음 | run `queued` + job 1 + inbox 항목 1(`agent_job`). 연결이 active 가 아니거나 채널이 승인 밖이거나 `owner_only` 이면 닫힌 사유로 409 |
| 1. claim | `oort_jobs_claim` (scope `agent:jobs:read`) | `limit` 1..100 | `{jobs:[{leaseHandle, createdAtMs, leaseExpiresAtMs, work:{channelId, authorMemberId, triggerMessageId, prompt, ...}}]}` |
| 1b. 시작(빠른 길) | `oort_job_start` (scope `agent:jobs:read`; 시작 보고는 `agent:runs:callback`, 대화는 `messages:read`도 필요) | `leaseHandle`(재진입), `stage`(선택) | `{job:{leaseHandle, createdAtMs, leaseExpiresAtMs, work}\|null, started, resumed, closed?:"run_settled"\|"run_awaiting_approval", conversation?:{messages, nextBefore}}`: claim + 시작 보고 + 최근 30개 메시지를 한 번에(ADR-0162 증보 4). 멈췄거나 끝난 run 의 handle 로 다시 들어가면 `job:null` + `closed` 이고 아무것도 보고하지 않는다(증보 6) |
| 2. 진행 | `oort_run_event` (scope `agent:runs:callback`) | `leaseHandle`(512), `stage`(1~80자, 최대 320바이트, `/`·`\`·제어·bidi 문자 불가), `status`(`running` `thinking` `streaming` `cancelled`), `detail`(2048, 감사 전용), `textDelta`(8192), `eventId`(UUID, 재시도가 한 번만 세어짐) | `{status:"accepted"}` |
| 3. 끝남 | `oort_run_complete` (scope `agent:runs:callback`) | `leaseHandle`, `status`(`succeeded` / `failed`), `body`(8000), `error`(4000), `usage`, `artifacts` | `{status, messageId, seq}` |
| 갱신 | `oort_job_renew` | `leaseHandle` | `{status:"renewed", leaseExpiresAtMs}` |

성공인데 `body`가 비었거나 공백뿐인 완료(`status:"succeeded"`)는 타임라인에 메시지를 만들지
않아요. run 종결·청구·rail 종료 프레임은 그대로이고, `oort_run_complete`는
`messageId: null`, `seq: null`로 답해요. 같은 완료를 다시 보내면 `409`가 아니라
같은 모양의 `200`이에요. `messageId`·`seq`는 null일 수 있는 값으로 읽으세요
(#4017, PR #4023).

`artifacts`는 닫힌 객체(`additionalProperties:false`)이고 키는 모두 선택이다.
`prUrl`(300; `https`, 호스트는 `github.com` 또는 운영자가 올린 GitHub
Enterprise 호스트, 경로는 정확히 `/<owner>/<repo>/pull/<n>`, 쿼리·조각은
버림), `branch`(git 브랜치 이름 꼴, 최대 200자(800은 바이트 여유일 뿐); 공백·`~ ^ : ? * [`·역슬래시·제어 문자 불가, 절대 경로·맨 앞 `~`·드라이브 문자 불가),
`added` / `deleted` / `commits`(0~2147483647 정수). 커밋 제목·파일 이름·원격
URL의 키는 없어서 보낼 수 없다.

**코드 작업 결과 칸(ADR-0162 증보 5 C1/C2).** 이것도 모두 선택이고 닫혀 있다.
`resultKind`(`pr_opened` / `branch_only` / `vm_only` / `no_change`), `tests`
(`{passed, failed, notRun}`, 셋 다 필수, 각 0~100000 정수), `nextAction`
(`merge_ok` / `please_test` / `blocked` / `none`), `commitSha`(16진수 7~40자,
소문자로 저장), `toolCounts`(`{run, edit, read, search, web, other}`, 각각 선택,
0~100000 정수). 서로 맞아야 한다: `tests`·`nextAction`·`commitSha`는
`resultKind`가 있어야 받는다. `pr_opened`는 `prUrl`이 필요하다. `branch_only`는
`branch`가 필요하고 `prUrl`은 안 된다. `vm_only`는 `prUrl`·`branch`가 없다.
`no_change`는 `prUrl`·`branch`·`commitSha`가 없고 `added` / `deleted` /
`commits`는 없거나 0이다. `merge_ok`는 `pr_opened`이고 실패한 테스트가 없어야
한다. `toolCounts`는 `resultKind` 없이 혼자 와도 된다. 원래 다섯 키만 보내는
루틴은 그대로 통과한다. 서버는 모양만 보고 사실은 확인하지 않는다(PR·커밋·
테스트 실행을 찾아보지 않는다). run 읽기(`GET /v1/workspaces/{ws}/agent-runs/{run}`)는
이 다섯 칸을 `agentReported` 하나로 모아 돌려준다. 클라이언트는 이것을
「에이전트 보고」 꼬리표 아래 그리고, oort 가 직접 잰 값과 섞지 않는다.

거절된 `artifacts`는 어느 칸인지 알려 준다. JSON-RPC 오류는 그대로 `-32602`이고,
`message`는 `artifacts.resultKind must be one of pr_opened, branch_only,
vm_only, no_change` 같은 영어 한 줄, `error.data`는 `{field, rule, allowed?,
requires?}`이며 `rule`은 `enum`·`required`·`forbidden`·`range`·`format`·
`requires` 중 하나다. 어느 쪽에도 보낸 값은 다시 싣지 않는다. 공개 스키마 뒤에서
걸린 거절(교차 규칙, 잘못된 `prUrl`·`branch`, 16진수가 아닌 `commitSha`)은 감사
행에 `field`·`rule`·`attempt`(그 run 의 몇 번째 거절인지)도 남기고, 이때도 값은
없다. 서버는 횟수로 재시도를 막지 않는다. 막는 것은 루틴이다(고쳐 보내기 최대
2번, g 단계). lease가 살아 있는 동안 잘못된 `artifacts`(또는
잘못된 `stage`)는 호출 전체를 HTTP 400 / `-32602`로 거절하고, 그 값은 저장하지
않으며, 사유 코드만 담은 감사 1행을 남기고, lease는 그대로라서 같은 호출을
잘못된 부분만 빼고 다시 보낼 수 있다. handle이 죽었거나 run이 이미 끝났다면
잘못된 값은 그냥 버려지고 평소 경로가 답한다(죽은 handle은 409, 끝난 run은
첫 답을 그대로 돌려줌). `stage`는 앞뒤 공백을 자르고 최근 12개만 남는다(13번째가
가장 오래된 것을 밀어낸다). 바로 앞과 같은 `stage`는 합쳐지지만 단계 수는 1
오른다. 단계 수는 run의 단계 한도에서 멈추고 한도가 완료를 막지는 않는다.
끝난 run에는 더는 stage가 기록되지 않는다.

**오류**는 다섯 가지 고정 답이다(서버는 「없음」「안 보임」「금지」 중 무엇인지
알려 주지 않는다). HTTP 400 `-32602` 잘못된 인자, 403 `-32003` 권한 없음(scope
또는 채널 승인 없음), 409 `-32004` 지금 닿지 않음(일시정지·연결 해제·안 보임),
409 `-32005` 전이 거절(lease 상실, 이미 끝났거나 취소된 run, 승인 대기로 멈춘
run), 500 `-32603` 서버 오류.

**팀이 보는 것.** run은 팀 보드(`GET /v1/workspaces/{ws}/work-sessions/shared?include=runs`)에
요청 제목·상태(`waiting` / `running` / `done` / `failed` / `stopped`)·단계
이름·PR 링크·브랜치·숫자가 든 카드로 나온다. 단계 이름·브랜치·요청 제목은
**일반 텍스트**다(마크다운·자동 링크·멘션 없음). 링크로 그려지는 것은 검증된
`prUrl` 하나뿐이다. 모두 에이전트가 **보고한** 값이다. oort는 PR이 있는지, 숫자가
맞는지 확인하지 않고 GitHub 토큰도 없다. 팀 보드는 단계마다 실시간 이벤트를 받지 않아 다음 조회 때
보인다. 채널의 작업 패널은 받는다(`runtime-unverified`: 트리거는 적합성 시험으로 증명했고
실제 VM 으로는 아직이다): 원장의 모든 행(대기·수령·시작·각 단계·승인·종료)이
채널에 얇은 `agent.run.event` 힌트 하나를 보내고(단계 문구 없음, 단계 힌트는 2초에 최대
하나), 패널은 그때 서버에서 그 run 의 원장을 읽는다. 패널을 닫아도 기록은 사라지지
않는다. 상태 전환(대기→진행, 끝남)은 이름·숫자 없는
갱신 신호를 보낸다. run이 끝나면 60초 이상 걸렸고 요청자가 작업 완료 알림을
켜 두었을 때 요청자에게 푸시 한 번이 간다. 스레드의 답은 `oort_run_complete`의
`body`다.

**lease와 깨우는 간격(여기가 핵심).** lease 길이는
`MOMO_AGENT_PORT_HOSTED_LEASE_MINUTES`분(기본 30, 5~120으로 보정, 서버 운영자가
설정)이다. claim·renew마다 그 길이로 다시 시작한다. 이를 넘겨 잠들어도
치명적이지 않다.

- 아무도 job을 다시 claim하지 않았다면 같은 `leaseHandle`이 `oort_run_event`·
  `oort_run_complete`·`oort_job_renew`에 계속 통한다(암묵 갱신). 저장한 handle
  로 먼저 보고한다.
- 에이전트가 `oort_jobs_claim`을 먼저 불렀다면 새 handle을 받았고(lease가
  끝나는 즉시 job은 다시 claim 가능) **옛 handle은 영구히 409 `-32005`**다.
  이후엔 새 handle을 쓴다. 옛 handle 재시도로 고치려 하지 않는다.
- 만료된 lease에 `oort_job_release`는 409다. 만료 뒤에는 보고하거나 claim하고
  해제하지 않는다.
- 취소된 run·끊긴 연결·좁혀진 채널 승인은 lease와 무관하게 즉시 막힌다.
  다음 호출이 409/403이고 에이전트는 그렇게 취소를 안다. oort가 VM 프로세스를
  멈추지는 못한다.
- 루틴 주기(도어벨 + 15분 스윕, §3.3.17.5)는 lease 길이보다 짧게 둔다.
  VM이 lease보다 오래 자도 그 사이 다른 wake가 job을 claim하지 않았다면 완료할
  수 있다. 연달아 깨는 두 루틴이 handle을 잃는 흔한 경로라서 (a) 단계가
  `/workspace/oort-run.handle`에 handle을 저장한다.

**살아 있나, 기다리나, 끝났나 (ADR-0200, #3736·#3737).** 연결의 `status: active`는
credential이 한 번 증명됐다는 뜻일 뿐이다. 사람에게 보이는 것은 앱의 추측이 아니라
서버가 가진 사실에서 나온다.

| 표시(`liveness.state`) | 서버가 본 것 |
|---|---|
| `responsive` | 20분 안에 **일** 신호: inbox 읽기, job을 가져간 claim, run 이벤트 |
| `alive_idle` | 20분 안에 `oort_ping`은 있으나 일 신호는 없음: 런타임은 떠 있고 일은 안 가져감 |
| `woken_not_collected` | 도어벨이 2xx로 울렸고 5분이 지났고, 수령 가능한 일이 기다리는데 울린 뒤로 inbox 읽기·claim이 없음 |
| `work_waiting` | 수령 가능한 일이 20분 넘게 기다렸고 큐에 들어간 뒤 claim이 없음(폴링·ping을 해도 마찬가지) |
| `quiet` / `unresponsive` | 60분 안에 어떤 신호가 있음 / 없음(또는 한 번도 없음) |
| `error` | 가장 최근 사실이 연결에 대한 거절(`unavailable`, 토큰·연결·빠진 scope 의 `not_authorized`). 다음에 받아들여진 호출이 있으면 풀림. 거절됐거나 죽은 lease handle(409, 또는 handle 에 대한 403)은 에이전트 자신의 흐름이라 `error` 를 켜지 않는다(#3903) |
| `inactive` | 연결이 `active`가 아님 |

`woken_not_collected`를 본 사람은 다시 울릴 수 있다: `POST
/v1/workspaces/{ws}/hosted-agent-connections/{id}/doorbell/ring`(admin, 연결 생성자,
또는 에이전트 소유자. 연결당 분당 1회·시간당 5회. 도어벨을 다시 무장할 뿐이고 같은
내용 없는 신호가 다음 drain에 나간다).

run도 같은 정직함으로 보인다. 아무도 안 가져간 run은 `queued`(에이전트 큐 안 순번과
함께), 이어서 `claimed`(언제·어느 연결), `running`(최근 단계), `awaiting_approval`,
끝으로 닫힌 사유가 붙은 `succeeded` / `failed` / `timed_out` / `cancelled`. 에이전트가
조용해지면 서버가 직접 run 을 끝낸다: lease가 만료됐고 run이 2시간 동안 이벤트가 없으면
(또는 연결 해제로 전달 job이 정리되고 run이 그만큼 조용하면) `lease_abandoned`, 24시간
아무도 안 가져가면 `unclaimed_expired`. 도어벨은 닿았는데 아무도 job을 가져가지 않으면
더 일찍 `woken_not_collected`로 끝난다. 첫 미수령 발사 30분 뒤에, 그 발사 이후 에이전트가
받은편지함을 읽거나 claim하지 않았고, 다른 job의 살아 있는 lease도 없고, run 이벤트나
`oort_ping` `working`도 없고, oort가 에이전트를 거절한 적도 없을 때다(토큰이 폐기·만료된
것은 보호가 아니다. 에이전트 쪽 사실이다). 사람이 「다시 깨우기」를 하면 그 시계가
뒤로 간다. 요청한 사람에게는 채널에 한 줄이 가고, 서버가 만든 환영 run은 줄 없이
끝난다. 재배정·재시도는 없고 다시 요청하면 새 run이다.
끝난 run에 뒤늦게 보고하면 409다.

운영 설정(모두 선택): api의 `MOMO_AGENT_PORT_LIVENESS_RESPONSIVE_MINUTES`(20, 1~240),
`MOMO_AGENT_PORT_LIVENESS_QUIET_MINUTES`(60, 앞의 값 미만 불가),
`MOMO_AGENT_PORT_LIVENESS_WOKEN_GRACE_MINUTES`(5, 1~60), notifier의
`MOMO_RUN_LEASE_ABANDON_HOURS`(2, 1~168), `MOMO_RUN_UNCLAIMED_EXPIRE_HOURS`(24,
1~720), `MOMO_RUN_WOKEN_EXPIRE_MINUTES`(30, 10~1440, 범위 밖은 경계값), api의
`MOMO_WELCOME_HOSTED_SIGNAL_HOURS`(24, 1~168, api 시작 때 한 번 읽어 바꾸려면 재시작): 호스티드 에이전트는 이 시간 안에
받은편지함을 읽거나 claim·보고했거나, 연결이 이 시간 안에 활성이 된 경우에만 첫 입장
환영을 받는다. run 원장은 run이 끝난 뒤 30일 보관한다.

oort가 보여 줄 수 있는 것은 에이전트가 **보낸** 것뿐이다: 단계, `oort_ping`, 스트리밍한
`textDelta`(저장되지 않음). 에이전트의 속 추론은 단계로 보고하지 않는 한 절대 보이지
않으니, 단계는 동료가 따라가고 싶은 순서대로 쓴다.

각 단계를 서버에서 증명하는 기존 적합성 시험(이 문서를 위해 읽었고 실행하지는
않았다. 격리 PostgreSQL 18이 필요하다).

| 단계 | 시험 |
|---|---|
| 작업 요청이 run + job + inbox 가 되고 claim | `a_hosted_agent_takes_a_work_request_as_run_job_and_inbox_item`, `every_d10_condition_refuses_with_409_and_writes_nothing` (`hosted_work_request_conformance_pg.rs`) |
| claim·event·complete 가 lease·종결 규칙을 공유 | `the_job_and_run_tools_share_the_gateway_lease_and_terminal_rules` (`agent_port_tools_conformance_pg.rs`) |
| 단계: 12개 유지, 나쁜 문자 거절 | `stage_markers_keep_the_latest_twelve_spend_steps_and_refuse_bad_text` |
| artifacts 저장, 나쁜 것은 완료 전체 거절 | `artifacts_are_stored_when_valid_and_a_bad_one_refuses_the_whole_completion` |
| 결과 칸: 틀린 칸을 짚고, 보고는 `agentReported` 로 읽힘 | `the_code_result_contract_names_the_bad_field_and_reads_back_as_agent_reported` |
| 죽은 handle 은 감사 로그를 키우지 못함 | `a_dead_lease_cannot_grow_the_audit_log_with_bad_reports` |
| lease 길이와 renew | `a_hosted_claim_leases_for_the_hosted_ttl_and_renew_extends_to_it` |
| 만료됐지만 재claim 없음: 보고·완료 가능 | `an_expired_unreclaimed_hosted_handle_still_reports_and_completes` |
| 재claim 뒤 옛 handle 은 어디서나 거절 | `a_reclaimed_hosted_job_refuses_the_old_handle_everywhere` |
| 보드 카드는 run 을 보이고 mention run 은 안 보임 | `b9_a_hosted_work_run_is_a_run_item_only_when_asked_and_shows_no_detail`, `b11_mention_managed_linked_and_stale_runs_are_not_listed` (`work_board_conformance_pg.rs`) |
| 요청자에게 끝남 푸시 | `a_hosted_work_run_answer_pushes_its_requester_on_the_sixth_reason` (`push_conformance_pg.rs`) |

**상태: runtime-unverified.** 실제 Grok Bot VM과의 왕복은 아직 하지 않았다.
추적 도구는 v0.1.18에 실리고 아직 팀 인스턴스에는 없다. 아래 체크리스트를
소유자가 실행하기 전에는 「실시간」「자동 보고」라고 쓰지 않는다.

**소유자 체크리스트(v0.1.18 배포 뒤 한 번, 본인 Grok Bot 계정·VM).** handle·
bearer·초대 값을 어디에도 붙여 넣지 않는다.

1. 서버: Agent Port `tools/list` 에서 `oort_run_event` 에 `stage`,
   `oort_run_complete` 에 `artifacts` 가 보인다. 없으면 v0.1.18 보다 오래된
   서버이니 멈춘다.
2. 연결: Grok Bot 연결이 `active`(위저드 5단계 완료)이고 시험 채널이 승인돼
   있다. §3.3.17.1 `oort-doorbell` 과 §3.3.17.5 `oort-inbox-sweep` 둘 다 새
   §3.3.17.4 문구를 갖고 있다.
3. 요청: 승인된 채널에서 에이전트가 닿는 저장소의 작은 실제 변경(문서 한 줄
   수정)을 시킨다. 기대: 보드(run 포함)에 카드가 뜨고 상태가 `waiting`,
   요청은 queued run 이다.
4. 깨우기: 도어벨을 울리거나 루틴을 손으로 돌린다. 기대: 카드가 `running` 으로
   바뀌고 새로 고침하면 단계 이름이 순서대로 보인다. 일반 텍스트다.
5. 끝남: 기대: 상태 `done`, 눌리는 PR 링크·브랜치·숫자, 스레드의 에이전트
   답, (60초 이상 걸렸다면) 본인에게 푸시 한 번.
6. 긴 잠(선택, `MOMO_AGENT_PORT_HOSTED_LEASE_MINUTES=5` 인 시험 서버): run 을
   시작하고 VM 을 5분 넘게 놀린 뒤 깨운다. 기대: 저장한 handle 로 보고가
   된다. 먼저 claim 하면 옛 handle 은 409 `-32005`.
7. 잘못된 입력(선택): `/` 가 든 stage 를 보낸다. 기대: HTTP 400, 카드 그대로.
   GitHub 가 아닌 호스트의 PR URL 로 완료를 보낸다. 기대: HTTP 400, 그 값을
   빼고 다시 보내면 정상 완료.
8. 결과(3~7에서 일어난 일, 시각, 비밀 없음)를 이슈 #3519 에 적는다. 이것이
   없으면 PR 은 `runtime-unverified` 로 남는다.
9. 생존·정직성 (ADR-0200, 실행 전까지 `runtime-unverified`): 루틴에 `oort_ping` 단계를
   넣은 뒤 루틴 주기 하나를 기다리고 연결을 읽는다(`GET
   /v1/workspaces/{ws}/hosted-agent-connections/{id}`). 기대: `liveness.state`가
   `responsive`(읽을 게 없었다면 `alive_idle`). 그다음 요청 하나를 대기시킨 채 VM을
   25분 멈춘다. 기대: `responsive`가 아니라 `work_waiting` 또는 `woken_not_collected`.
   API로 다시 울리고 도어벨의 `lastStatus`를 적는다. 시각을 #3736 / #3737 에 기록한다.

##### 3.3.17.4b 여러 job 동시 처리와 코드 결과 (#3582, 초안)

**상태: 초안, 실기기 미검증.** §3.3.17.4 루틴을 병렬에 안전하게 고친 형태다.
최종 문구는 #3542의 그록 4병렬 실험(성재 결재 「실험용 저장소·Bot 하나 (추천)」,
2026-10-15, ADR-0162 증보 5 X1)에서 예전 handle 하나 방식과 비교한 뒤 정한다.
그 전에는 시험을 거쳤다고 말하지 않는다.

왜 바꿨나. 예전 루틴은 lease handle 하나를 `/workspace/oort-run.handle`에
뒀다. 30초 안에 들어온 요청 네 건은 wake 하나가 모두 가져갈 수도, 여러 wake가
동시에 나눠 가져갈 수도 있다(job wake는 10초 간격으로 도어벨 쿨다운을 건너뛰고,
#3822, 15분 스윕이 도어벨 wake와 겹칠 수 있다). 파일이 하나면 두 번째 claim이
첫 handle을 덮어 써서 첫 job은 보고할 길을 잃는다. 서버는 바꿀 필요가 없었다.
claim은 하나하나 원자적이고, 호스팅 claim에는 에이전트별 한도가 없다(ADR-0200
증보 2026-10-15 R1).

| 규칙 | 루틴이 하는 일 |
|---|---|
| job마다 폴더 하나 | `/workspace/oort-runs/<tag>/`(권한 700)에 `handle`(권한 600)·`beat`·`workdir`. `<tag>`는 새 UUID이고 handle이나 요청 문구가 아니다. |
| 없을 때까지 claim, 최대 4 | 사이에 아무것도 끼우지 않고 `oort_job_start {}`를 거듭 불러 `job`이 null이 되거나 VM에 폴더가 4개가 될 때까지. 다섯 번째는 다음 wake에 남긴다. |
| wake 하나든 넷이든 같다 | 폴더가 job마다 따로라서, wake 하나가 넷을 가져가든 wake 넷이 하나씩 가져가든 상관없다. |
| 남겨진 job | `beat`가 15분보다 오래된 폴더는 이름 바꾸기로 가져오고(한 wake만 이긴다), 새 claim 전에 저장된 handle로 먼저 보고한다(§3.3.17.4 h). 빼앗긴 wake는 폴더가 없어진 걸 보는 즉시 그 job을 멈춘다(§3.3.17.4 f). |
| 자기 작업 사본 | job마다 `/workspace/work/<tag>`와 자기 브랜치에서 일해서 두 job이 같은 디렉터리·브랜치를 건드리지 않는다. |
| 살아 있음·lease는 job마다 | 차례를 기다리는 job까지 가진 job마다 최소 5분마다 `oort_run_event {status:"running"}`, `leaseExpiresAtMs` 전에 `oort_job_renew`. |
| 결과 순서 | 브랜치 올림 → 테스트 → PR → `oort_run_complete`. 단계마다 stage 하나. |
| 결과 칸 | `tools/list`의 `oort_run_complete` 스키마에 `resultKind`가 보일 때만 보낸다(ADR-0162 증보 5 C1·C2, engine 슬라이스 C-S1). 그 전에는 §3.3.17.4a의 다섯 키만 받으므로 결과는 `body` 첫 줄에 쓴다. |
| 결과 거절 | HTTP 400 / `-32602`의 오류 data가 틀린 칸을 알려 준다(C3, C-S1과 함께 나온다). 그 칸만 고쳐 최대 2번 더, 그래도 안 되면 `artifacts` 없이 완료. |

결과 칸은 모두 에이전트가 **보고한** 것이다. oort는 PR을 열어 보거나 커밋을 읽거나
테스트를 다시 돌리지 않고, 화면은 「에이전트 보고」로 표시한다.

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
compose와 같은 GHCR 이미지(`releases/latest.json`), 커맨드 여섯
(`api` · `relay` · `webhook-sender` · `agent-worker` · `notifier` ·
`push-relay`, 모두 `momo-rust-entrypoint <role>`로 시작), 공개 엣지는 Caddy,
Centrifugo는 `CENTRIFUGO_*`(파일 마운트 없음), Postgres는 볼륨 달린
PG18 + pgvector 이미지 서비스.
LiveKit은 이 템플릿에 없다. 이 레포가 싣지 않는 compose 스택을 만들지
마라. 플랫폼 시크릿을 대화에 붙이지 마라.

1. Railway 계정 + 프로젝트. `railway.json`의 서비스(이미지, `startCommand`,
   api `preDeployCommand`, 볼륨, `variables`)를 만든다.
   공개 도메인은 **caddy**에. api는 내부에 둔다.
2. postgres 서비스의 `DATABASE_URL`을 조립하고(README) caddy 호스트명이
   생긴 뒤:

```sh
scripts/self_host_env.sh --platform railway --claim
```

   (`--railway`는 별칭.) 환경에 `RAILWAY_PUBLIC_DOMAIN`과 `DATABASE_URL`이
   필요하다(둘 중 하나라도 없으면 명시 실패 — doctor `public.*` skip이
   아니다). `--claim`은 `railway.json`과 짝이다. 그 api 변수에는 owner
   비밀번호가 아니라 `MOMO_BOOTSTRAP_CLAIM`이 있다. `--claim` 없이 만들면
   pre-deploy에 owner 이메일만 있고 비밀번호가 없어 기동을 거부한다(exit 2).
   비밀번호 방식을 쓰려면 `--claim` 없이 만들고, api에서
   `MOMO_BOOTSTRAP_CLAIM`을 `MOMO_INITIAL_OWNER_PASSWORD` =
   `${{shared.MOMO_INITIAL_OWNER_PASSWORD}}`로 바꾼다(api 시작 셈이 서버
   기동 전에 이미 뺀다). 어떤 변수를 읽고 어떤 키가 손에 남는지는 `platform_profiles`
   행이 말한다. stdout KEY=value를
   Railway 공유 변수로 넣고, 서비스마다 `railway.json`의 `variables`를 준다.
   compose가 이름을 바꾸거나 조립하는 값(9개 이상, Centrifugo v6 이름 넷 포함)은
   README의 수기 매핑 표에 있다. 생성기 stderr는 셋만 댄다.
3. 배포. api preDeploy(런타임 롤 → migrate)가 끝나고 caddy `/healthz`가
   답할 때까지 기다린다.
4. 게이트:

```sh
scripts/oort doctor --json
```

   `public.healthz`와 `public.websocket`이 PASS이고 README의 손 점검
   (`wss://` 실시간 주소, `https://` QR origin)도 통과해야 한다. README의
   클라이언트 IP 관문이 PASS하기 전에는 claim 링크를 공유하거나 누구도
   초대하지 않는다. 남길
   인스턴스가 아니면 프로젝트를 지운다 — 팀 인스턴스(#2205)는 남긴다.

**플랫폼 URL이 생긴 뒤 게이트:** `scripts/oort doctor --json` 에서
`public.healthz` pass.

### 3.4.1 Railway: 같은 프로젝트의 Hermes (ADR-0203)

선택 사항이에요. 운영자가 oort 옆, **같은 Railway 프로젝트**에 Hermes 에이전트를
올리고 설정 › AI 연결에서 한 번 클릭으로 연결하려는 때만 읽어요. oort는 Railway
서비스 목록을 읽지 않고, Railway 토큰을 저장하지 않고, 호스트를 짐작하지도 않아요.
운영자가 `HERMES_BASE_URL`에 적은 호스트만 불러요. 순서대로 하세요 —
**2번을 확인하기 전에는 Hermes를 시작하지 않아요.**

1. **Hermes 자체 설정을 먼저 써요** (서비스를 올리기 전, 볼륨의 `config.yaml`).
   위험한 toolset을 꺼요:

```yaml
agent:
  disabled_toolsets: [terminal, code_execution, browser, memory, session_search]
memory:                        # ADR-0203 R2: Hermes 하나가 모든 워크스페이스를 맡아서
  memory_enabled: false        # 런 사이 기억·세션 검색을 두지 않아요
  user_profile_enabled: false
```

   API 서버 toolset은 터미널·코드 실행·브라우저를 기본으로 켜 두고, API 서버
   자체에는 끄는 스위치가 없어요. `file`·`delegation`·`cronjob`·`process_manage`·
   `computer_use`까지 끌지는 운영자가 정해요(이름은 Hermes toolsets reference).
   `approvals.mode: off`로 두지 말고 `HERMES_YOLO_MODE`도 켜지 마세요.
2. **잠금을 확인한 뒤** 서비스를 시작해요. oort는 Hermes의 도구를 볼 수 없어요.
   이 확인은 운영자의 몫이에요.
3. **Hermes에는 자기 변수만 줘요:** `API_SERVER_ENABLED=true`, `API_SERVER_KEY`
   (길고 무작위, 예 `openssl rand -hex 32`), `API_SERVER_HOST`,
   `API_SERVER_PORT=8642`, 모델 provider 키. `API_SERVER_CORS_ORIGINS`는 비워 둬요.
   oort의 `DATABASE_URL`·`WORKER_DATABASE_URL`·`PROVIDER_LINK_MASTER_KEY`·JWT 키나
   oort 서비스의 shared variable은 **걸지 마세요**.
4. Hermes 서비스에 **공개 도메인을 붙이지 않아요.** `<서비스이름>.railway.internal`
   로만 닿아요. `HERMES_BASE_URL`에는 DNS를 운영자가 직접 통제하는 호스트만
   적으세요. 거기 적은 호스트는 설계상 oort의 주소 검사에서 면제되므로, 남이
   바꿀 수 있는 이름은 선언하면 안전하지 않아요.
5. **바인드 주소(D9):** 2025-10-16 이후 만든 environment는 내부 이름이 IPv4·IPv6
   둘 다 풀려서 `API_SERVER_HOST=0.0.0.0`이면 충분해요. 레거시 environment는
   IPv6만 풀려서 `::`가 필요한데, Hermes가 `::`를 받는지는 **확인하지 못했어요**
   (runtime-unverified). 그래서 레거시는 약속하지 않아요. 먼저 environment 생성일을
   확인하세요.
6. **oort `api`·`agent-worker` 서비스에** 넣어요:
   `HERMES_BASE_URL=http://<서비스이름>.railway.internal:8642/v1`,
   `HERMES_API_KEY=<API_SERVER_KEY와 같은 값>`,
   `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`,
   `AGENT_PROVIDER_LOCAL_HOSTS=<서비스이름>.railway.internal`(정확한 호스트,
   와일드카드 금지). 이 허용 없이는 평문 `http://` 내부 호스트가 거절돼요.
7. **잠금을 선언해요.** `api` 서비스에 `OORT_COHOSTED_AGENT_TOOLS_LOCKED=1`을
   넣어요. 1~4번을 따랐다는 **운영자 본인의 선언**이에요. oort는 그렇게 표시할
   뿐 검증하지 않아요. 거짓으로 선언하면 에이전트 호스트에 터미널이 남아요.
8. 웹·데스크탑에서 인스턴스 운영자(`PLATFORM_ADMIN_EMAILS`)로 설정 › AI 연결을
   열어요. 「같은 서버의 Hermes를 찾았어요, 연결할까요?」 카드는 7번 뒤에만
   보여요. 한 번 클릭하면 에이전트 멤버가 만들어지고 이 env 링크에 고정돼요.
   채널에는 넣지 않고 도구 권한도 주지 않아요. 평소처럼 채널에 초대하세요.

데이터와 삭제: Hermes가 남기는 모든 것(`/opt/data`: 대화 기록·memories·skills·
`state.db`·`.env`)은 **자기 볼륨에 있고 oort DB와 oort 백업 밖**이에요. 백업은
운영자가 직접 해요. Hermes에 건넨 대화는 거기에 남아요. oort에서 에이전트를
제거해도 볼륨은 지워지지 않아요. 지우려면 Railway에서 Hermes 서비스와 볼륨을
삭제하세요. 워크스페이스 하나만 Hermes 하나에 연결하세요(여러 워크스페이스의
대화가 한 볼륨에 섞여요).

볼륨 `.env`에는 허용 목록이 있어요(#4950). Hermes는 게이트가 끝난 뒤 이 파일의 모든 이름을
적용하므로, `lockgate.py`는 파일에 이것만 두게 해요. 운영자가 넣는 모델 키
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), 그리고 Hermes가 새 볼륨의 첫 기동에 써 넣는
템플릿 11줄(나온 그대로)이에요. 연결 모드 Hermes의 Google 클라이언트 쌍
(`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`)은 서비스 변수라서 이 파일에는 두지 않아요.
Hermes는 이 파일을 판독기 둘로 읽고 게이트도 둘의 눈으로 판정해요. 값은 한 줄이어야 하고(값 안의
줄바꿈은 거절해요), 어느 판독기든 읽는 이름은 목록에 있어야 해요. 그 밖의 이름은 값이 비어 있어도
이름만 대고 시작을 거절해요(게이트는 값을 출력하지 않아요). 옆에 `.op.env`가 있거나
`/opt/data/profiles/` 아래에 항목이 하나라도 있어도 거절해요(폴더가 없거나 비어 있는 것은 괜찮아요. 프로필을 만들었다 지웠다면 Hermes가 남기는 `.deleted` 표식도
항목 하나로 세요). 이미 도는
Hermes의 게이트를 바꾸기 전에 그 `.env`의 이름만 읽어서
(`sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p' /opt/data/.env`는
이름만 보여줘요) 목록에 없는 줄을 지우세요.

**제로 베이스 지름길 (#4072).** 1~7번은 이제 템플릿과 생성기가 대신 해요. 잠금을
읽는 일과 모델 키는 여전히 운영자 몫이에요.

- **Railway:** `infra/railway/railway.json`에 `hermes` 서비스(비공개, digest 고정
  공식 이미지, `/opt/data` 볼륨)와 6~7번의 api·agent-worker 변수가 들어 있어요.
  shared variable `HERMES_API_KEY`(`openssl rand -hex 32`)를 만들고,
  `infra/hermes/config.yaml`, `infra/hermes/lockgate.py`, `infra/hermes/plugins/oort-image-guard/`의
  파일 둘을 base64 변수 네 개로 붙여 배포한 뒤, hermes 배포 로그에서 `LOCKGATE {"ok": true, …}` 한 줄을 읽어요.
  시작 명령이 Hermes 엔트리포인트 앞에서 게이트를 돌리므로, 설정이 거절되면 서비스는
  아예 listen하지 않아요. `infra/railway/README.md`(Hermes)를 보세요. 템플릿은
  agent-worker와 hermes에 `OORT_SELF_MEDIA_ORIGIN`(이 엣지의 공개 출처)도 같은 값으로
  둬요. 이 값이 있으면 사진이 붙은 요청에서 에이전트의 그림 도구가 그 사진을 편집할 수
  있도록 5분짜리 1회용 주소를 받아요. agent-worker 쪽 값이 비면 사진 주소는 건네지 않아요.
  hermes 쪽 값만 비면 워커는 주소를 건네지만 그림 가드가 거절하므로 그림 도구는 그 주소를
  내려받지 않고, 편집할 원본이 없어요(#4820).
- **docker compose:** `scripts/self_host_env.sh --local-build --with-agents`(또는
  `--published-image …`)가 `COMPOSE_PROFILES=agents`, 생성된 `HERMES_API_KEY`,
  `HERMES_BASE_URL=http://hermes:8642/v1`, 정확한 호스트 `hermes`의 로컬 허용,
  `OORT_COHOSTED_AGENT_TOOLS_LOCKED=1`을 써요. 이어서
  `scripts/self_host_env.sh --compose up -d --wait`로 나머지와 함께 Hermes가 떠요.
  `hermes` 서비스에는 `ports:`가 없고(호스트에서 닿지 않음), 설정과 게이트를
  읽기 전용으로(그림 가드 플러그인도) 마운트하며, 엔트리포인트 앞에서 `lockgate.py gate`를 돌려요. 기존
  env에서는 생성된 키를 다시 만들지 않고 나머지 키를 번들 값으로 맞추며, 이미 다른
  `HERMES_BASE_URL`을 선언한 env는 거절해요. 요청자가 올린 사진을 에이전트가 편집하게 하려면
  env에 `OORT_SELF_MEDIA_ORIGIN=https://<공개 호스트>`도 둬요(compose가 agent-worker와
  hermes에 그대로 넘겨요. 소문자 호스트와 선택적 `:포트`만, 끝 슬래시는 안 돼요). Hermes가 그
  주소를 직접 내려받으므로 Hermes 쪽에서 공개 주소로 풀려야 해요(Hermes의 사설 주소 필터는
  계속 켜져 있어요). 비워 두면 아무것도 달라지지 않아요.
- **에이전트가 사진으로 팀 표현을 만들게 하기(호스팅 문, #4820).** 서버는 같이 도는
  Hermes가 만든 그림을 Hermes의 답에서 읽어 와요. 그래서 문은 **둘 다 켜야** 열려요.
  Hermes 쪽은 `HERMES_MEDIA_DELIVERY_STRICT=1`이에요(Hermes의 엄격한 미디어 전달이에요.
  꺼져 있으면 답에 적힌 `MEDIA:` 줄이 읽을 수 있는 아무 파일이나 내줘요). 템플릿과 compose가
  알아서 넣고, `lockgate.py`는 이 값이 정확히 `1`이 아니면 그림 도구와 상관없이 어떤
  모드에서도 시작을 거절해요(볼륨 `.env`에 이 이름이 있어도 거절해요). 워커 쪽은 agent-worker의
  `OORT_HOSTED_MEDIA_STRICT=1`이에요. 워커가 연결하는 Hermes가 그 엄격한 Hermes라는
  운영자의 확인이에요. 템플릿과 compose는 이 값을 **비워서** 보내요. 그래서 기본은 문이
  닫혀 있고, 사진 메시지는 오류 카드 없이 평소 대화로 처리돼요. Hermes 서비스가 새
  게이트로 돌고 있을 때만 켜세요. 기존 Railway 프로젝트는 이 순서로 고쳐요. ① hermes에
  `HERMES_MEDIA_DELIVERY_STRICT=1`을 먼저 더해요. ② 그다음 `HERMES_LOCKGATE_B64`와 시작
  명령의 체크섬을 함께 다시 배포해요(새 게이트는 ①이 없으면 Hermes를 띄우지 않으니 ②만
  하면 에이전트가 멈춰요). ③ 배포 로그의 `LOCKGATE` 줄에서
  `"media_strict": true`가 보이면 마지막으로 `OORT_HOSTED_MEDIA_STRICT=1`을 켜요.
  정확히 `1`일 때만 문이 열려요.
- `OORT_COHOSTED_AGENT_TOOLS_LOCKED=1`은 여전히 **운영자 본인의 선언**이에요. 두
  배포 모양 모두 게이트가 뒷받침하지만, 설정·게이트·시작 명령을 고치면 그 뒷받침은
  운영자가 직접 책임져요(게이트는 자기 표에 sha256이 없는 설정을 거절해요, #4935:
  `python3 infra/hermes/render_model_config.py --catalog`).
- **모델 인증은 이 작업 밖이에요**(#4073). 모델 없이도 Hermes는 뜨고 카드도 보여요.
  모델을 정하기 전까지 대화 한 번은 「Hermes가 아직 모델 provider에 연결되지 않았다」
  고 답해요.
- **로그인 중계 사이드카(#4078, ADR-0203 증보 2026-10-19).** `HERMES_LOGIN_RELAY_KEY`가
  있으면(`--with-agents`가 채팅 키와 따로 만들어요) `hermes` 컨테이너가
  `infra/hermes/login_relay.py`도 사설망(`hermes:8643`, `ports:` 없음)에서 돌려요.
  Codex·Claude·설정된 OAuth 앱의 고정 `hermes` 로그인 명령만, `hermes` uid의 별도
  프로세스 그룹으로 실행해요. 키는 사이드카 전용 uid의 `0400` 파일에 있고 게이트웨이가
  뜨기 전에 환경에서 지워져요. 키가 없으면 사이드카 프로세스도 없고 화면은 셸 명령
  (`railway ssh`)을 보여 줘요. 실측: `scripts/tests/test_login_relay_docker.sh`.
  oort api는 `HERMES_LOGIN_RELAY_URL` / `HERMES_LOGIN_RELAY_KEY`(`--with-agents`가 함께 써요,
  api 전용)로 사이드카에 닿고, 인스턴스 운영자 전용 라우트 `…/agents/{agent}/model-login`·
  `…/app-login`(#4079, `docs/api/openapi.operator.yaml`)으로 노출돼요. 붙여넣는 일회용 code와
  Codex 기기 코드는 oort를 한 번 지나갈 뿐 저장·로그·감사·푸시에 남지 않고, 토큰은 oort에
  아예 오지 않아요. 둘 중 하나라도 비어 있으면 라우트는 `409 login_relay_off`로 답하고 화면은
  셸 명령을 보여 줘요.

compose 실측(arm64, 2026-10-19, 고정 이미지): listener는 `0.0.0.0:8642`(uid 10000),
`docker port`는 공개된 포트가 없다고 나오고, 게이트는 `LOCKGATE ok=true
disabled_count=24`, 리포트는 6개 검사가 모두 true였어요. 레거시 Railway environment의
`::`는 여전히 runtime-unverified예요.

**Codex·Claude 구독으로 모델 인증하기 (ADR-0004 증보 6, ADR-0203 증보
2026-10-19).** Hermes는 운영자 본인의 Codex(ChatGPT) 또는 Claude 구독 OAuth로
모델 인증을 할 수 있어요. 토큰은 **Hermes 자기 볼륨에만** 있어요. oort 서버와
금고는 그 토큰을 받지도 저장하지도 중개하지도 기록하지도 않고(oort가 가진 것은
불투명 bearer `HERMES_API_KEY`뿐), 그래서 `docs/SELF_HOST.ko.md`의 킬 스위치
(`MOMO_SUBSCRIPTION_AGENTS_ENABLED`, `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`)는
**이 경로에는 적용되지 않아요.** 사용량은 Hermes에 로그인한 사람의 구독에서
나가요(팀원이 Hermes를 불러도 같아요). 벤더 약관에 맞는지는 운영자가 판단해요.
oort는 판단하거나 보증하지 않아요. 구독 토큰을 oort·채널·oort 서비스의 `.env`에
붙여 넣지 마세요. 로그인 절차는 #4073(Hermes 모델 인증 온보딩)이 들어오기 전까지
자리표시예요: [#4073](https://github.com/yeomyeonggeori/oort/issues/4073).

### 3.4.2 Railway: Hermes 「커넥터 시험」 (ADR-0203 증보, #3948)

선택 사항이에요. §3.4.1을 마치고 Hermes를 연결한 뒤에 읽어요. 1인 워크스페이스의
**한 사람**이 자기 앱(Gmail·캘린더·드라이브)을 Hermes로 읽어 보는 시험이에요
(읽기만). Hermes는 토큰 볼륨이 하나이고 사람별 분리가 없어서, 체크리스트를 서버
규칙으로 올렸어요. 활성 사람 멤버가 정확히 1명이 아니면 켜 주지 않고, **배달
직전마다** 다시 재요. **아래 두 선언은 운영자 본인의 자기 선언이지 oort의
검증이 아니에요.** oort는 Hermes의 도구, `mcp_servers`, 토큰 볼륨을 볼 수 없어요.

1. **oort 쪽 준비.** 워크스페이스의 활성 사람이 정확히 1명(본인)이에요. 앱은
   본인이 직접 설치·허용했어요(설정 › 앱). 그 워크스페이스에서 운영자 env 링크에
   고정된 에이전트는 이 Hermes **하나뿐**이에요. Hermes는 토큰 볼륨이 하나라서
   거기에 닿는 다른 에이전트는 누가 불렀든 앱을 쓸 수 있어요(시험을 켤 때, 그리고
   켜 둔 동안 에이전트를 하나 더 고정할 때 둘 다 `409`로 거절해요). 나중에 어떤
   경로로든 두 번째 사람이 들어오면 다음 메시지부터 멈춰요. **oort가 강제하지
   않는 것:** 같은 인스턴스의 *다른* 워크스페이스에서 이 Hermes에 고정된
   에이전트, 그리고 고정도 팀 링크도 없어서 워커가 `HERMES_BASE_URL`로 보내는
   에이전트예요. 이 Hermes는 전용으로 두고, 인스턴스가 팀의 기본 모델 링크로 쓰고
   있으면 시험을 켜지 마세요.
2. **Hermes `config.yaml`**: 앱마다 항목 하나, `mcp_servers`에 다른 것은 두지 않아요.

```yaml
agent:
  disabled_toolsets: [terminal, code_execution, browser, cronjob, delegation, web, memory, session_search]
memory:                        # ADR-0203 R2, 첫 설정과 같아요
  memory_enabled: false
  user_profile_enabled: false
mcp_servers:
  gmail:                       # com.momo.plugins.gmail -> 키 "gmail"
    url: https://<벤더 MCP 주소>
    auth: oauth
    trust: untrusted           # Hermes는 값이 없으면 "full"로 봐요
    sampling: {enabled: false} # Hermes 기본값은 켜짐이에요
    tools:
      include: [<정확한 도구 이름, 읽기 도구만, 글롭 없음>]
      resources: false         # Hermes 기본값은 켜짐이고 `include` 밖이에요
      prompts: false           # 같아요
```

   키는 앱 id에서 `com.momo.plugins.`를 뗀 뒤 소문자로 하고 `-`·`.`를 `_`로
   바꾼 값이에요(`com.momo.plugins.google-calendar` -> `google_calendar`.
   Hermes는 `-`와 `_`를 같게 봐요). 데이터를 바꾸는 도구는 `tools.include`에
   넣지 않아요.
3. **Hermes 잠금 게이트가 커넥터에 맞게 바뀌어요**
   ([`infra/hermes/lockgate.py`](../infra/hermes/lockgate.py), Railway 시작 명령이
   이미지 엔트리포인트 앞에서 돌리는 스크립트). 전에는 `mcp_servers` 항목이
   하나라도 있으면 부팅이 멈췄어요(exit 3). 이제 `mcp_servers`가 **비어 있으면**
   전과 똑같이 판정하고, **비어 있지 않으면** 아래를 모두 만족할 때만 통과해요.
   하나라도 어기면 exit 3이에요(서버 항목을 쓰는 것 자체가 시험을 켜는 뜻이라
   따로 깜빡할 스위치가 없어요).
   - Hermes 서비스에도 `OORT_COHOSTED_AGENT_CONNECTOR_APPS=<oort와 같은 목록>`이
     있고, 서버 항목이 그 앱과 **1:1**이에요.
   - 모든 서버가 원격 한 줄 `https://` 주소예요(`command`·`args` 없음).
   - `trust`가 정확히 `untrusted`이고 `sampling.enabled`가 명시적으로 `false`예요.
   - `tools.include`가 비지 않은 정확한 이름 목록이고(`*`·`?`·`[` 없음),
     `tools.resources`·`tools.prompts`가 명시적 `false`예요(Hermes는 서버마다
     리소스·프롬프트 읽기 도구를 `include` 밖에 기본으로 켜 둬요).
   - `cronjob`·`delegation`·`web`이 `agent.disabled_toolsets`에 있어요.
   - §3.4.1의 도구 잠금 규칙(허용목록·승인·CORS·키 길이·YOLO 없음·텔레메트리 끔)도
     그대로 지켜져야 해요.
   게이트가 보는 것은 **설정**이에요. MCP 도구는 `GET /v1/toolsets`에 나오지
   않고 `disabled_toolsets`가 막지도 않아서(K-S1a 실측) 게이트의 허용목록도
   기동 뒤 리포트도 벤더 서버가 무엇을 내놓는지 증명하지 못해요. 그 부분은
   운영자의 선언으로 남아요. 규칙은 Docker 없이
   `python3 -m unittest infra/hermes/test_lockgate_connectors.py`로 확인해요.
4. **로그인**은 Hermes 셸에서 `hermes mcp login <server>`로 해요(리디렉션 URL을
   붙여 넣어요. `oauth.redirect_port`로 포트를 고정할 수 있어요). 내 컴퓨터의
   토큰 파일을 복사하지 마세요.
5. **oort `api` 서비스에 선언해요**(라우트를 받는 서비스예요. 다른 서비스는
   필요 없어요): `OORT_COHOSTED_AGENT_CONNECTORS_LOCKED=1`(2~3번을 따랐다는
   선언), `OORT_COHOSTED_AGENT_CONNECTOR_APPS=com.momo.plugins.gmail,com.momo.plugins.google-calendar`
   (Hermes에 켜 둔 앱, 쉼표 구분. 형식이 틀린 id가 하나라도 있으면 목록 전체가
   무효예요). §3.4.1의 `OORT_COHOSTED_AGENT_TOOLS_LOCKED=1`도 있어야 해요.
6. **켜기**는 Hermes를 연결한 인스턴스 운영자가
   `PUT /v1/workspaces/{ws}/agents/{agent}/connector-trial` `{"enabled":true}`로 해요.
   `409 connector_trial_attest`(선언이나 앱 목록 없음),
   `409 connector_trial_members`(활성 사람이 정확히 1명이 아님),
   `409 connector_trial_apps`(목록의 앱 중 내 활성 허용이 없는 것이 있음),
   `409 connector_trial_not_cohosted`(연결한 Hermes 에이전트가 아님),
   `409 connector_trial_shared`(같은 Hermes에 고정된 다른 에이전트가 있음),
   `403`(운영자가 아님). 같은 경로의 `GET`은 켜져 있는지, 지금 배달이 멈춘 이유
   (`attest` | `members` | `apps`)가 있는지 보여 줘요.
7. **켜져 있는 동안** Hermes는 본인만 부를 수 있어요(멘션·DM·작업 요청). 메시지마다
   세 사실을 다시 재요. 하나라도 어긋나면 Hermes 이름으로 한 문장이 오고, 고칠
   때까지 그 메시지는 배달되지 않아요. 이미 쌓인 작업은 워커가 가져갈 때 다시
   보지만 사람 수만 봐요. 환영 인사와 승인 재개 작업은 선언·허용을 다시 보지
   않아요.
8. **회수 순서:** 시험 끄기(`{"enabled":false}`, 배달이 바로 멈춰요) -> 벤더 쪽
   연결 해제 -> `/opt/data/mcp-tokens/<server>.json`과 `mcp_servers` 항목 삭제 ->
   메일 본문이 남았을 수 있으면 `sessions/`도 삭제. 뒤의 세 가지는 oort가 대신하지
   않아요.

### 3.5 Fly

T1. compose 절차는 볼륨 달린 Fly VM 1대 위의 §3.2다. 카탈로그:
[`infra/fly/README.md`](../infra/fly/README.md) ·
[`infra/fly/fly.toml`](../infra/fly/fly.toml). Machine 1대, 볼륨 1개
(`/data`), 그 볼륨의 dockerd `data-root`, 정본
`caddy.override.yml` + `Caddyfile`(443 TLS 패스스루 — 새 Caddyfile 없음).
사용자 로그인의 `flyctl`. 플랫폼 시크릿을 채팅에 붙이지 마라.

1. 사람 승인: `fly auth login`, 계정에 결제 수단이 없으면 결제(볼륨·전용
   IPv4는 유료).
2. `infra/fly/`에서: `fly launch --no-deploy --copy-config`,
   `fly volumes create oort_data --size 10`, `fly ips allocate-v4`,
   `fly deploy`(`Dockerfile.host` 빌드, `--image` 아님).
3. env는 §3.2 파생에 행 이름을 더한 것이다(`IMAGE_REF`는 §2.2에서 읽은 값).
   첫 부팅이 볼륨에 쓴다. env 파일을 Fly 시크릿으로 import 하지 마라.

```sh
scripts/self_host_env.sh --platform fly --published-image "$IMAGE_REF" --public-origin https://<host>
```

4. 게이트:

```sh
scripts/oort doctor --json
```

   `public.healthz`와 `public.websocket`이 PASS여야 한다. day-2는 VM 안의
   T1(`scripts/oort backup`, `upgrade`). 커스텀 도메인 DNS는 사람.
   삭제(`fly apps destroy`)는 데이터 파괴 확인.

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

### 3.8 Cloudflare (T3 엣지, 컴퓨트 아님)

「Cloudflare에 oort를 배포」는 없다. api·Postgres·Centrifugo는
Workers/Pages/Containers에 올리지 않는다(ADR-0184 D1). 이미 doctor PASS인
T1/T2 행 **앞단**의 DNS · Tunnel · TLS다. 레시피:
[`infra/cloudflare/README.md`](../infra/cloudflare/README.md).

사용자가 「Cloudflare로」라고 하면 먼저 컴퓨트 tier를 고른다. 설치 보고
한 줄(D7): **여기엔 컴퓨트를 올릴 수 없다, T1/T2를 고르자.** D7 ②(영속
볼륨) 또는 ③(상시 프로세스·장수 WebSocket)이 아니오인 미지 플랫폼도 같은
T3다.

`wrangler`는 여기서 쓰지 않는다: Workers/Pages CLI다. DNS 쓰기는 MCP
`mcp.cloudflare.com`(OAuth 동의 = 승인) 또는 사용자 API 토큰 REST
(`Zone:DNS:Edit` + Tunnel, env만). named tunnel은 호스트의 `cloudflared`
(systemd, compose 아님).

사람 승인(소유자 계정; 에이전트는 클릭하지 않음): (1) Cloudflare 로그인 /
MCP OAuth 또는 API 토큰, (2) 레지스트라의 네임서버 위임, (3) 호스트의
터널 토큰, (4) 정리 확인.

**모드 A — DNS.** 공개 IP가 있는 T1. 오리진 Caddy(`Caddyfile` +
`caddy.override.yml`)가 ACME를 발급하는 동안 A/AAAA는 그레이 클라우드,
그다음 오렌지 클라우드 + SSL **Full (strict)**. 프록시를 통과하는
HTTP-01과 WebSocket 101을 실측한다.

**모드 B — named tunnel.** 공개 IP·포트 개방 없음(그록봇 VM, NAT VPS).
루프백 Caddy(`Caddyfile.local`). ingress
`http://127.0.0.1:<MOMO_WEB_PORT>` + 마지막 규칙 `http_status:404`
([`infra/cloudflare/cloudflared.config.example.yml`](../infra/cloudflare/cloudflared.config.example.yml)).
§3.3.11 quick-tunnel 폴백을 상시 설치로 쓰지 않는다.

두 모드 모두 Cloudflare 호스트명을 공개 오리진으로:

```sh
scripts/self_host_env.sh --public-origin https://<host>
scripts/oort doctor --json
```

`--public-origin`은 필수다. 빼면 doctor가 `public.*`를 skip한다
(doctor 함수 `oort_doctor_check_public`, 「--public-origin
흔적 없음」). 이 T3 앞단에서 그 skip은 **사용자 오류**이지 PASS가 아니다.
`public.healthz` 200과 `public.websocket` **101**을 기대한다. 이어서
`GET https://<host>/v1/centrifugo/subscribe` → **403**. 루프백 Caddy에
이미 전용 deny가 있다(`infra/rust/Caddyfile.local` `handle
/v1/centrifugo/*` / `respond 403`). 핸들이 없으면 멈추고 planner에 보고 —
여기서 Caddy를 고치지 않는다.

터널 모드: TLS는 Cloudflare에서 끝난다. `Caddyfile.local`은 HSTS를 내지
않고 CSP는 SPA handle에만 붙는다 — 엣지 응답에 그 오리진 헤더가 없으면
SH-11f 목록 상수 후보지, 이 레시피의 Caddy 수정이 아니다. 오리진 vs 엣지
헤더를 diff하고 Cloudflare가 더한 것을 목록으로.

**게이트:** Cloudflare 호스트명 경유 `scripts/oort doctor --json`에서
`public.healthz`와 `public.websocket` PASS. 정적 증명:
`scripts/tests/test_cloudflare_recipe.sh`.

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

claim 모드: `--claim` env에서 `--compose` (§3.3.3). Grok Bot VM은
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
`--platform railway`(별칭 `--railway`)가 heredoc 밖에
`MOMO_SELF_HOST_PLATFORM=railway`를 찍으므로 `--tier t2`가 env와 맞는다. 런북:
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
| `stack.compose_ps` | 서비스 없음/unhealthy | 그 서비스에 `--compose ps` / `logs`. `runtime-roles` 종료코드 1에 `password authentication failed for user "momo"` 는 남은 pgdata vs 새로 만든 env — `down -v`, env 삭제, §2.3 다시 (또는 **원래** env로 `up` 재시도). |
| `stack.healthz` | 200 `database:ok` 아님 | `logs api`. |
| `stack.agent_port` | 401 + Bearer scope 아님 | 잘못된 이미지. `releases/latest.json` 확인. |
| `stack.outbox` | `done`이 아닌 행 | `push_candidate` pending 은 푸시 릴레이가 없으면 **info**(개수)이다 (`PUSH_RELAY_URL` / `docker-compose.push.yml` 의 `push-relay`/`notifier` 없음). `agent_job` pending 은 5분 미만 info, 이상이면 major(kind/status/개수/최고 나이 나열). 다른 kind: pending/failed면 `logs relay`. |
| `stack.scheduler` | 예약 메시지가 시각을 5분 넘게 지났는데 아직 `pending`(major; `MOMO_SCHEDULER_GRACE_SECONDS`(기본 3600)를 넘으면 「유예를 넘긴」이라고 말한다) | api 틱이 안 돌거나 그 행을 닫지 못한다: `logs api`의 `scheduled messages tick` 줄. `MOMO_SCHEDULER_ENABLED=0`이면 멈춘다. **info** = 최근 24시간에 서버가 놓친 예약(조치 없음, 작성자가 정한다). **skip** = 연결 역할이 행 수준 보안을 건너뛰지 못해 개수를 알 수 없다(소유자 URL을 쓴다). |
| `stack.migrate_idempotency` | `IDEMPOTENCY_OK` 없음 | `logs migrate`. |
| `public.healthz` / `public.websocket` | 공개 오리진은 등록됐는데 200/101 없음 | 터널/Caddy와 `CENTRIFUGO_ALLOWED_ORIGINS`. Funnel: §3.3.10 1회 재시작. Cloudflare T3(§3.8): `public.*` skip(「흔적 없음」)은 사용자 오류다 — 먼저 `--public-origin`을 돌려라. skip은 PASS가 아니다. |

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
