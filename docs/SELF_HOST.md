# oort 셀프호스트 — clone에서 로그인까지 (SELF_HOST.md)

> **이 문서 하나로 끝난다.** 끝까지 따르면 당신의 머신에서 돌아가는 oort에
> **브라우저로 로그인해 메시지를 주고받는다.**
> 처음에 이미지 공급 방식만 하나 고른다: 현재 checkout을 짓는
> **로컬 빌드**, 또는 공개된 이미지를 불변 digest로 받는 **digest pull**. 둘은
> 같은 Rust 스택을 띄우며 스크립트가 두 경로를 섞지 못하게 막는다.
> 이 quickstart의 PostgreSQL named volume은 **production backup이 아니다**.
> 공개 운영·업그레이드는 별도 pgBackRest/WAL/PITR 절차와 fresh signed evidence를
> 요구한다([운영 런북](runbooks/pgbackrest-pitr.md)).
>
> 시간은 약속하지 않는다. 로컬 모드는 이미지를 처음부터 굽고,
> digest 모드는 레지스트리에서 받는다. 약속하는 것은 **결과**다: 저
> 넷을 마치면 화면이 있다.
>
> 근거: 2026-08-10 재실측(#1229). 깨끗한 클론에서 이 문서를 그대로 밟아
> 브라우저 왕복까지 갔고, **문서에 없는 임기응변은 0회**였다. 그 전 측정(같은 날,
> `docs/planning/research/2026-08-10-buzz-audit-C.md`)은 6회였다.

---

## 전제

| 필요한 것 | 확인 |
|---|---|
| Docker Engine + Compose v2 | `docker compose version` |
| git | `git --version` |

**그 외에는 없다.** Rust도, Node도, `psql`도 설치하지 않는다 — 서버·릴레이·워커·
마이그레이션 러너·웹 화면이 전부 한 이미지 안에 있고, PostgreSQL과 Centrifugo는
compose가 가져온다. 도메인·TLS 인증서·외부 API 키도 이 경로에는 필요 없다
(도메인을 붙이는 것은 [§운영](#운영-도메인과-tls를-붙일-때)이고, 별도 절차다).

---

## 1. 클론

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort
cd oort
```

> 저장소는 현재 public이라 GitHub 로그인이나 개인 access token 없이 clone된다.
> 공개 컨테이너의 첫 발행은 별도 owner 승인 게이트 뒤에 진행한다.

## 2. 이미지 모드 고르고 env 만들기

다음 둘 중 **하나만** 실행한다.

### A. 로컬 빌드

```sh
scripts/self_host_env.sh --local-build
```

현재 checkout의 `server-rust/Dockerfile`로 `oort:local`을 만든다. Rust·Node는
호스트에 설치할 필요가 없고 Docker 빌드 스테이지 안에서만 쓴다.

### B. 공개 digest pull

```sh
IMAGE_REF='ghcr.io/yeomyeonggeori/oort@sha256:REPLACE_WITH_64_LOWERCASE_HEX'
scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

`latest`나 `sha-<commit>` 태그는 받지 않는다. **반드시 `@sha256:`로 pin된
`ghcr.io/yeomyeonggeori/oort`만** 받으며, 형식이 틀리면 env를 만들기 전에
실패한다. #1266은 발행 **경로**를 준비하는 goal이고 실제 첫 digest 발행·
공개는 owner/M7 게이트 후속이다. 릴리스에 정확한 digest가 없으면 A를 쓴다.

공개 발행 형상은 현재 **`linux/amd64` 단일 플랫폼**이다. `linux/arm64` manifest가
없으므로 ARM 서버와 Apple Silicon의 native pull은 지원하지 않는다. 지원하지 않는
플랫폼에서 에뮬레이션 성공을 가정하지 말고, 공개 digest 모드 대신 호스트에서 검증한
로컬 빌드 경로를 사용하거나 후속 arm64 릴리스를 기다린다.

발행 workflow는 `main` ref의 수동 실행만 허용하고, GitHub `release` Environment의
owner 승인 뒤 pushed digest에 SLSA v1 provenance를 OCI referrer로 붙인다. 2026-08-12
attended 설정/readback에서 required reviewer는 `kwakseongjae`(user id `87296259`),
`prevent_self_review=false`, deployment branch policy는 custom `main` branch 하나임을
확인했다. `sha-*`
태그는 커밋을 찾기 위한 이동 가능한 표식일 뿐 불변 신원이 아니다. 실제 첫 발행 뒤에는
다음처럼 **digest 자체**를 검증한다(`gh`가 설치된 운영자용 선택 단계):

```sh
gh attestation verify "oci://$IMAGE_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

첫 workflow dispatch와 위 명령의 공개 GHCR 왕복은 아직 `runtime-unverified`이며
이 문서가 릴리스 권한을 주지는 않는다.

`infra/rust/local.secrets.env` 를 만든다 — **채워 넣을 자리가 하나도 없는** 파일이다.
시크릿 아홉 개를 `openssl` 로 만들고, 서로 같아야 하는 값들(런타임 롤 비밀번호와
접속 URL 안의 비밀번호)을 같게 쓰고, 포트가 이미 쓰이고 있으면 비어 있는 다음
포트를 골라 알려 준다. 그리고 **첫 로그인 계정**과 선택한
`MOMO_SELF_HOST_MODE`를 함께 기록한다.

환경변수에서 파일로 들어가는 모든 값은 한 줄 scalar인지 먼저 검사한다. LF/CR을
포함한 값, 중복 env 키, 1..65535 밖이거나 ASCII 10진수가 아닌 포트는 파일을 쓰거나
셸 산술을 하기 전에 실패한다. 이메일과 비밀번호는 Compose dotenv가 보간·인용·주석으로
재해석하지 않는 literal 형식만 받으며 비밀번호는 12..128자다. 기존 env도 같은 검사를
다시 통과해야 한다. POSIX argv/env 자체가 NUL을 표현할 수 없다는 경계도 스크립트 주석과
계약 테스트에 고정돼 있다. 오류와 stdout에는 비밀번호를 출력하지 않는다.

끝에 이런 것이 찍힌다 — 다음 두 단계가 전부 여기 있다:

```
[self-host] infra/rust/local.secrets.env 를 만들었다 (권한 600).

[self-host] 준비됐다. 모드: 로컬 빌드 — 현재 checkout을 server-rust/Dockerfile로 짓는다.
[self-host] 다음 한 줄이 스택을 띄운다:

  scripts/self_host_env.sh --compose up -d --build --wait

[self-host] --wait 가 붙어 있으므로 그 명령이 끝나면 준비가 끝난 것이다.
[self-host] 주의: 이 quickstart는 로컬 named volume만 사용하며 production 백업/PITR가 아니다.
[self-host] 브라우저에서 열고 아래로 로그인한다:

  http://localhost:8088
  email    owner@oort.local
  password infra/rust/local.secrets.env 의 MOMO_INITIAL_OWNER_PASSWORD 값
```

비밀번호는 stdout에 나오지 않고 파일에만 있다(`infra/rust/local.secrets.env`, 권한 600,
커밋 대상 아님). 이 스크립트는 **파일이 이미 있으면 절대 덮어쓰지 않는다** — 이미 마이그레이션한
DB가 있는데 시크릿을 다시 만들면 그 DB와 어긋나기 때문이다. 다시 실행하면 현재
이메일과 비밀번호가 든 파일 위치만 다시 보여 준다. 기존 파일에 중복 키가 있거나,
기존 env와 다른 모드·digest를 주면 조용히 바꾸지 않고 실패한다.

## 3. 기동

2단계가 찍어 준 명령을 그대로 붙여 넣는다. `--compose` 경유는 필수다. generated
env의 모든 실제 키, canonical Compose 파일의 모든 interpolation 키와 `COMPOSE_FILE`·
`COMPOSE_PROFILES` 같은 제어 키를 process env에서 제거한 뒤 정본 env/file set을
호출한다. caller의 config-source 대체 인자와 Compose global control 인자도
fail-closed로 거절한다. `DOCKER_HOST`·`DOCKER_CONTEXT`는 운영자가 고른 daemon 권위라
보존한다. 이 launcher의 정본 파일은 `infra/rust/docker-compose.rust.yml`,
`infra/rust/docker-compose.rust.build.yml`, `infra/rust/local.override.yml`이다.
로컬 모드는 다음과 같다.

```sh
scripts/self_host_env.sh --compose up -d --build --wait
```

digest 모드는 빌드 오버레이와 `--build`가 없다. 스크립트가 이 명령을
출력한다:

```sh
scripts/self_host_env.sh --compose up -d --pull missing --wait
```

`--wait` 가 붙어 있으므로 **이 명령이 끝났다는 것이 준비가 끝났다는 뜻이다.**
그 사이에 순서대로 일어나는 일: 이미지 빌드 또는 pull → PostgreSQL 기동 → 최소권한 런타임
롤 생성 → 마이그레이션 전량 적용(+2패스 멱등 검사) → 첫 로그인 계정 생성 →
api·relay·agent-worker·웹 엣지 기동.

이 경로는 생성 env에 `MOMO_MIGRATE_ENV=development`와 evidence gate 비활성 상태를
**명시적으로** 기록하고, migrate가 같은 사실을 warning으로 남긴다. API의
`MOMO_ENV=staging` 보안 자세는 그대로다. 운영에서 이 로컬 예외를 복사하지 말 것:
staging/production migrate는 서명된 15분 이내 PITR evidence 또는 실제 빈 DB의
단발 bootstrap probe 중 정확히 하나가 없으면 실패한다.

## 4. 로그인

브라우저에서 **`http://localhost:8088`** 을 열고 2단계가 알려 준 이메일과
`infra/rust/local.secrets.env`의 `MOMO_INITIAL_OWNER_PASSWORD`를 넣는다.
워크스페이스 칸은 비워 둔다.

채널 목록(`#general` · `#agent-lab`)이 있는 화면이 뜬다. 아무 채널이나 골라
메시지를 보내면 그 자리에 나타난다. **You're in.**

---

## 방금 무엇이 떴나

```text
브라우저 ── http://localhost:8088 ──> web (Caddy, 같은 오리진 엣지)
                                        ├── /            SPA (이미지 안의 번들)
                                        ├── /v1/*        ──> api
                                        └── /connection  ──> centrifugo
api ── 트랜잭션 ──> PostgreSQL 18 (진실의 원천: message + seq + outbox)
                                          │
centrifugo (전송 전용) <── publish ── relay ┘
```

쓰기 경로는 하나다: `REST → PostgreSQL 커밋 → 트랜잭션 아웃박스 → relay publish`.
채널 순서를 정하는 것은 전송 오프셋이 아니라 `message.seq` 다. 전체 계약은
[아키텍처 개요](architecture/overview.md).

브라우저가 아는 주소가 **포트 하나뿐**이라는 점이 이 경로의 설계다 — SPA도 REST도
실시간도 같은 오리진에서 나오므로 CORS가 성립할 여지가 없고, 실시간 주소는
로그인 응답이 돌려주는 값을 클라이언트가 그대로 쓴다(ADR-0110).

## 멈추기 · 지우기

3단계의 인자 묶음이 길어서, 아래부터는 함수 하나로 줄여 쓴다. 레포 루트에서
**자신이 고른 모드의 한 줄만** 붙여 넣는다(변수가 아니라 함수인 것은
의도다 — zsh는 변수를 단어로 쪼개 주지 않는다):

```sh
# 두 모드 공통 — env의 MOMO_SELF_HOST_MODE가 canonical file set을 고른다.
oort() { scripts/self_host_env.sh --compose "$@"; }
```

```sh
# 멈춘다 (데이터는 남는다)
oort down

# 다시 켠다
oort up -d --wait

# 무슨 일이 있었는지 본다
oort logs api
oort logs migrate

# 데이터까지 지운다 — 메시지·계정·볼륨이 사라진다. 되돌릴 수 없다.
oort down -v
```

`down -v` 로 지운 뒤 처음부터 다시 하려면 `infra/rust/local.secrets.env` 도 지우고
2단계부터 다시 밟는다(새 DB에는 새 시크릿이 맞다).

## 막히면

| 증상 | 원인과 조치 |
|---|---|
| 3단계가 `port is already allocated` 로 실패 | 2단계 이후에 그 포트를 누가 잡았다. `down` 후 `local.secrets.env` 의 `MOMO_WEB_PORT` 를 바꾸고 다시 `up`. |
| 로그인이 `invalid credentials` | 2단계가 알려 준 값을 쓴다(`grep MOMO_INITIAL_OWNER infra/rust/local.secrets.env`). 비밀번호를 바꾸려면 아래 회전 명령. |
| 화면은 뜨는데 메시지가 실시간으로 안 온다 | outbox가 빠졌는지 먼저 본다(아래 질의). `broadcast \| done` 이면 서버 쪽은 끝난 것이고 브라우저 쪽을 본다(`oort logs api`). `pending`/`failed` 면 relay다(`oort logs relay`). |
| 처음부터 다시 하고 싶다 | `down -v` + `rm infra/rust/local.secrets.env` + 2단계부터. |

메시지가 실제로 레일까지 갔는지 보는 질의(`broadcast | done` 이 정상):

```sh
oort exec postgres psql -U momo -d momo \
  -c "SELECT kind, status, count(*) FROM outbox GROUP BY 1,2;"
```

relay는 성공 publish를 **로그하지 않는다**(정상 경로가 조용하다). 그래서 「relay가
일했나」의 답은 로그가 아니라 위 질의다.

비밀번호 회전(의도적 변경 — 모든 세션이 로그아웃된다):

```sh
MOMO_INITIAL_OWNER_EMAIL=owner@oort.local \
MOMO_INITIAL_OWNER_PASSWORD='<새 비밀번호>' \
  oort run --rm -e MOMO_INITIAL_OWNER_EMAIL -e MOMO_INITIAL_OWNER_PASSWORD migrate set-owner
```

더 깊은 것(마이그레이션 로그 읽는 법, Centrifugo history로 왕복 증명, env 파리티
표, 트러블슈팅)은 [`infra/rust/README.md`](../infra/rust/README.md) 에 있다. 이
문서가 「처음 한 번」이고, 그 문서가 「그다음 전부」다.

## 운영: 도메인과 TLS를 붙일 때

위 경로는 **루프백 전용**이다. 엣지는 `127.0.0.1` 에만 바인딩되고 TLS가 없다.
공개 호스트에 올리는 것은 다른 절차이고, 다른 파일을 쓴다:

| | 로컬(이 문서) | 공개 배포 |
|---|---|---|
| 엣지 | `infra/rust/local.override.yml` + `Caddyfile.local`(`:80`, ACME 없음) | `infra/rust/caddy.override.yml` + `infra/rust/Caddyfile`(자동 HTTPS) |
| 주소 | `http://localhost:<port>` | 실도메인 + `CENTRIFUGO_ALLOWED_ORIGINS` |
| 절차 정본 | 이 문서 | [`docs/runbooks/ncp-rust-deploy.md`](runbooks/ncp-rust-deploy.md) |

> ⚠ **`caddy.override.yml` 을 배포 호스트가 아닌 곳에서 이름 부르지 마라.**
> `infra/rust/Caddyfile` 이 실도메인을 스킴 없이 적고 있어서, 컨테이너가 뜨는
> **순간** Let's Encrypt에 ACME 주문이 나간다 — 요청 하나 없이도, 포트를 바꿔도.
> 2026-08-10에 실제로 운영 도메인 앞으로 실패한 챌린지 4건이 발생했다. 그래서
> 로컬 경로는 저 파일을 아예 쓰지 않고 `local.override.yml` 을 쓴다.
> 구조적 수리(사이트 주소 파라미터화 / `acme_ca`)는 **#1239** 의 결정 사항이다.

보안 강화·백업·업그레이드·다중 워크스페이스 운영은
[`docs/DEPLOY.md`](DEPLOY.md), pgBackRest 폐곡선과 migrate gate는
[`docs/runbooks/pgbackrest-pitr.md`](runbooks/pgbackrest-pitr.md), 배포 호스트 절차는
[`docs/runbooks/ncp-rust-deploy.md`](runbooks/ncp-rust-deploy.md).
