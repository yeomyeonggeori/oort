# oort 셀프호스트 — clone에서 로그인까지 (SELF_HOST.md)

> **이 문서 하나로 끝난다.** 끝까지 따르면 당신의 머신에서 돌아가는 oort에
> **브라우저로 로그인해 메시지를 주고받는다.**
> 처음에 이미지 공급 방식만 하나 고른다: 현재 checkout을 짓는
> **로컬 빌드**, 또는 공개된 이미지를 불변 digest로 받는 **digest pull**. 둘은
> 같은 Rust 스택을 띄우며 스크립트가 두 경로를 섞지 못하게 막는다.
> 이 quickstart의 PostgreSQL named volume은 **production backup이 아니다**.
> 공개 운영·업그레이드는 별도 pgBackRest/WAL/PITR 절차와 fresh signed evidence를
> 요구한다([운영 런북](runbooks/pgbackrest-pitr.md)).
> 그록봇 VM이나 개인 인스턴스에서 **데이터를 파일로 가져가려면**
> [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md)
> (`scripts/self_host_pg_dump.sh`) — PITR의 대체재가 아니다.
> 첨부 바이트는 Postgres 밖에 있다. 덤프와 **보관소 볼륨**(`DRIVE_VOLUME_NAME`,
> 기본 `oort-drive`)을 같이 가져가라(아래 [첨부 보관소](#첨부-보관소)).
>
> 시간은 약속하지 않는다. 로컬 모드는 이미지를 처음부터 굽고,
> digest 모드는 레지스트리에서 받는다. 약속하는 것은 **결과**다: 1~4를
> 마치면 화면이 있고, [5](#5-에이전트가-대답하게-하기-ai-연결)를 마치면
> 에이전트가 대답한다. Claude Code·CI 같은 외부 도구는 사람 로그인 토큰이
> 아니라 [6](#6-외부-도구-연동-claude-code--ci)의 에이전트 자격을 쓴다.
>
> 근거: 2026-08-10 재실측(#1229). 깨끗한 클론에서 이 문서를 그대로 밟아
> 브라우저 왕복까지 갔고, **문서에 없는 임기응변은 0회**였다. 그 전 측정(같은 날,
> `docs/planning/research/2026-08-10-buzz-audit-C.md`)은 6회였다.
>
> 로그인 다음 — 워크스페이스 만들기, 웹 GUI 초대, 둘째 사용자 합류(웹 +
> `oort://join`), AI 연결 GUI, 첫 멘션 — 은
> [`SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md) (#1608). 이 문서는
> clone→로그인(+키 둘) 정본이다. 그록봇이 사용자 본인 VM에 설치하는
> 경로(본인 계정 전용)는 [`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md)다.

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

최신 불변 digest는 **GitHub Releases**가 정본이다
([Releases](https://github.com/yeomyeonggeori/oort/releases)). `latest`나
`sha-<commit>` 태그는 받지 않는다. **반드시 `@sha256:`로 pin된
`ghcr.io/yeomyeonggeori/oort`만** 받으며, 형식이 틀리면 env를 만들기 전에
실패한다. 릴리스에 digest 표가 없으면 A를 쓴다.

아래는 v0.1.1 공개 발행의 **앱** list digest(빌드 커밋 `main=1b79bc65`,
오케스트레이터 검증 2026-08-23). 이 값이 항상 최신은 아니다 — Releases를
본다.

```sh
IMAGE_REF='ghcr.io/yeomyeonggeori/oort@sha256:43babdbc06ba7f4a1e0b9b140b826d026531b54487a918c26e0ddd2c90c4de6d'
scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

같은 발행의 두 list digest (v0.1.1, 빌드 커밋 `main=1b79bc65`).
`--published-image`에는 앱 행만 넣는다. postgres 행은 Release 표와
운영/PITR 경로용이며, 이 문서 compose의 postgres 서비스가 소비하는 값이
아니다.

| 대상 | 불변 이미지 |
|---|---|
| 앱 | `ghcr.io/yeomyeonggeori/oort@sha256:43babdbc06ba7f4a1e0b9b140b826d026531b54487a918c26e0ddd2c90c4de6d` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:b09eb970e636afde1b31a6c50d27840a1e299f2b7a7beacaa9fa0dd282361626` |

공개 발행은 `linux/amd64`+`linux/arm64` **manifest list**다. 표의 v0.1.1
digest는 그 list digest이며, 한 pin으로 두 아키텍처를 받는다. Apple
Silicon과 ARM 서버는 이 pin을 native pull한다. 첫 공개 발행
v0.1.0(`main=45a154d2`)은 amd64 단일였고, 그 digest의 Apple Silicon
native pull은 불가했다(실측 2026-08-21). 운영자 pin은 list digest다.

발행 workflow는 `main` ref의 수동 실행만 허용하고, GitHub `release` Environment의
owner 승인 뒤 **아키별 digest와 manifest list digest**에 SLSA v1 provenance를 OCI
referrer로 붙인다. 2026-08-12
attended 설정/readback에서 required reviewer는 `kwakseongjae`(user id `87296259`),
`prevent_self_review=false`, deployment branch policy는 custom `main` branch 하나임을
확인했다. `sha-*`
태그는 커밋을 찾기 위한 이동 가능한 표식일 뿐 불변 신원이 아니다. 운영자
pin은 list digest다. digest 자체는
다음처럼 검증한다(`gh`가 설치된 운영자용 선택 단계):

```sh
gh attestation verify "oci://$IMAGE_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

첫 multi-arch 발행과 공개 GHCR 왕복(발행 · 익명 inspect · attestation
2본)은 **v0.1.1 list digest**에 대해 실측 완료다. 좌표: Release
[v0.1.1](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.1),
빌드 커밋 `main=1b79bc65`, 익명 inspect PASS, amd64+arm64 포함,
attestation 2본 PASS(오케스트레이터 2026-08-23). (구 `SELF_HOST.md:88`
`runtime-unverified` 문면.) 절차 정본은 [`RELEASING.md`](RELEASING.md).
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

브라우저에서 2단계가 인쇄한 주소 — 기본 **`http://localhost:8088`** — 를 연다.
로그인 화면에 보이는 칸은 셋이고, 그중 둘만 채운다.

| 화면의 칸 | 넣을 것 |
|---|---|
| **서버 주소**(선택) | **비운다.** 이 페이지를 내준 주소가 곧 이 서버다 — 칸 아래에 그렇게 적혀 있다: 「비워 두면 이 페이지를 제공한 주소로 연결합니다」 |
| **이메일**(필수) | 2단계가 알려 준 주소 (기본 `owner@oort.local`) |
| **비밀번호**(필수) | `infra/rust/local.secrets.env` 의 `MOMO_INITIAL_OWNER_PASSWORD` — 스크립트는 이 값만은 화면에 찍지 않으므로 파일에서 직접 읽는다 |

**워크스페이스 칸은 찾지 않아도 된다.** 화면에 열려 있지 않다 — `다른
워크스페이스로 로그인` 이라는 접힌 줄 뒤에 있고, 셀프호스트 첫 실행에서 그것을
펼칠 이유는 없다(펼쳐서 비워 두는 것과 결과가 같다). 펼쳤을 때의 라벨은
`워크스페이스 ID`이고, 받는 값은 **UUID 하나뿐**이다. 한 서버에 워크스페이스를
여럿 두게 된 다음에나 쓰는 칸이며, 그때 넣을 UUID는 로그인한 뒤 **설정 › 계정**에
적혀 있다.

`로그인`을 누르면 채널 목록(`agent-lab` · `general` — 목록에는 `#` 없이 이름만
선다)이 있는 화면이 뜬다. 아무 채널이나 골라 메시지를 보내면 그 자리에
나타난다. **You're in.**

## 5. 에이전트가 대답하게 하기 (AI 연결)

4단계까지는 **사람들끼리의 메신저**다. 에이전트를 만들어 멘션해도 대답이 없다면
그건 고장이 아니라 **아직 키를 주지 않아서**다. 이 절이 그 한 걸음이다.

### 당신이 이 인스턴스의 운영자다

2단계가 만든 env에는 이 줄이 들어 있다:

```
PLATFORM_ADMIN_EMAILS=owner@oort.local     # = MOMO_INITIAL_OWNER_EMAIL
```

「이 인스턴스의 첫 owner는 이 인스턴스의 운영자다」라는 선언이고, **설정 › AI 연결**과
워크스페이스 생성이 열리는 근거다. 인가 규칙 자체는 그대로다(MOMO-583: 인스턴스-전역
표면은 `platform:read` 토큰 **또는** 여기 등재된 검증 이메일의 owner/admin에게만).
셀프호스트 스택은 `platform:read` 토큰을 발급할 방법이 없으므로, 이 줄이 없으면 그
표면은 **아무에게도** 열리지 않는다 — 설치한 본인에게도. 그때 화면에 보이는 것은
403 하나뿐이고, 에이전트는 조용히 대답하지 않는다.

운영자를 더 두려면 쉼표로 잇는다(`a@example.com,b@example.com`). 그 주소는 이 인스턴스에
실재하는 owner/admin이어야 하고 이메일이 **검증**돼 있어야 한다.

### 키 넣기

브라우저에서 **설정 › AI 연결**을 열고 OpenAI 호환 엔드포인트 주소와 키를 넣는다.
같은 일을 REST로도 할 수 있다(`<port>`는 2단계가 알려 준 값):

```sh
TOKEN=$(curl -sS -X POST http://localhost:8088/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@oort.local","password":"<MOMO_INITIAL_OWNER_PASSWORD>"}' \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

curl -sS -X PUT http://localhost:8088/v1/provider/link \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"baseUrl":"https://api.example.com/v1","bearer":"<키>"}'
```

키는 이 서버의 DB에 **암호화되어** 저장되고(`PROVIDER_LINK_MASTER_KEY`), 응답과 화면에는
끝 네 자리만 돌아온다. 엔드포인트는 오늘 **외부 `https://`** 주소여야 한다 — 노트북에
띄운 로컬 모델(`http://127.0.0.1:...`)을 붙이는 경로는 아직 열려 있지 않다.

그다음 에이전트를 만들고(에이전트 명부 → 새 에이전트) 채널에 초대한 뒤 `@핸들`로
부른다. 대답이 오면 거기까지가 이 문서가 약속한 전부다.

### 무엇이 즉시 반영되고 무엇이 재시작을 요구하나

한 줄로 갈린다. **키는 행이고 허용목록은 프로세스 env다.**

| 바꾼 것 | 반영 | 왜 |
|---|---|---|
| provider 키(위 PUT / GUI) | **즉시** — 다음 작업부터, 늦어도 2초 | DB 행이고 worker가 2초 캐시로 다시 읽는다. **재시작하면 안 되는 게 아니라 필요가 없다** |
| `PLATFORM_ADMIN_EMAILS` | **api 재시작**(`oort up -d`) | 부팅 때 프로세스 env에서 읽는다 |

2단계 이전에 만든 env에는 그 줄이 없다. 그런 파일에는 `scripts/self_host_env.sh`가
다음 실행 때 **그 줄만 덧붙인다** — 시크릿은 하나도 다시 만들지 않는다(다시 만들면
이미 마이그레이션된 DB와 어긋난다). 덧붙인 뒤 `oort up -d`로 api를 재시작한다.

## 6. 외부 도구 연동 (Claude Code · CI)

사람 로그인 토큰을 Claude Code나 CI에 넣지 마라. 그 토큰은 **15분** 만에
죽고, 리프레시는 한 번 쓰면 버려진다 — 브라우저 세션용이다. 외부 도구는
**에이전트 멤버**로 넣고, 장수명 자격을 한 번 발급해 도구가 보관하게 한다
(ADR-0101). 추천은 이 절의 generic 자격이고, hosted pairing(Grok Bot)이
아니다.

전제: [4](#4-로그인)까지 끝나 워크스페이스 owner로 들어가 있다. 에이전트를
아직 안 만들었으면 명부에서 하나 만든다(표시 이름·핸들·모델·게이트웨이
주소). 폼에 API 키 칸은 없다 — 그건 맞다(ADR-0004). 채널에 그 에이전트를
초대해 두라. 멘션 없이 **도구가 글을 쓰게만** 하려면 초대한 것으로 충분하다.

아래 `<port>` 는 2단계가 알려 준 값(기본 웹 `8088`). 비밀번호·토큰은 화면에
붙이지 말고 셸 변수에만 둔다.

```sh
OORT=http://localhost:<port>
WS='<설정 › 계정에 있는 워크스페이스 UUID>'
AGENT='<에이전트 멤버 UUID>'
CHANNEL='<글을 올릴 채널 UUID>'

HUMAN=$(curl -sS -X POST "$OORT/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"owner@oort.local\",\"password\":\"<MOMO_INITIAL_OWNER_PASSWORD>\",\"workspace\":\"$WS\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

# 원문은 이 응답에만 있다. 목록 API는 메타만 돌려준다.
curl -sS -X POST "$OORT/v1/workspaces/$WS/agents/$AGENT/credentials" \
  -H "Authorization: Bearer $HUMAN" -H 'Content-Type: application/json' \
  -d '{"label":"claude-code","scopes":["messages:write"]}'
```

응답의 `token` 한 줄을 도구 env에 넣고, 사람 `HUMAN` 변수는 버린다. 그 자격으로
메시지를 쓰는 예:

```sh
curl -sS -X POST "$OORT/v1/workspaces/$WS/channels/$CHANNEL/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"clientMsgId\":\"$(uuidgen | tr '[:upper:]' '[:lower:]')\",\"type\":\"text\",\"body\":\"hello from an external tool\"}"
```

201이 오면 그 채널에 에이전트 이름으로 글이 남는다. 자격은 만료를 적지 않으면
장수명이고, 다시 발급하면 이전 값은 하루(기본) 유예 뒤 죽는다. 회수는
`POST …/credentials/{id}/revoke`.

**오늘 안 되는 것.** 이 자격으로 채널 히스토리를 `GET` 할 수는 없다. 읽기
스코프를 넣어도 REST는 403이고, Agent Port 읽기 도구는 hosted 연결 전용이다.
도구가 과거 글을 읽어야 하면 아직 사람 세션을 빌려야 하고, 그건 이 절이
추천하지 않는 우회다. hosted 연결 전용 멤버에 generic 발급을 치면
`409 hosted_connection_managed` — 그 멤버는 pairing 화면에서만 자격을 만든다.

근거와 판정: [EXT-1 자격 조사](planning/research/2026-08-27-ext1-agent-credential-external-tools.md) (#1797).

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

## 두 체크아웃을 같이 쓸 때

기본 compose 프로젝트 이름은 `oort` 이고, PostgreSQL named volume 은
`oort-pgdata` 다. 그 이름은 **체크아웃 경로가 아니라 프로젝트 이름에 묶인다.**
클론 A로 스택을 띄운 뒤 클론 B에서 같은 기본값으로 `--compose up` 하면, 예전에는
B가 A의 컨테이너를 무경고로 다시 만들었고, 프로젝트 이름만 `oort-b` 로 바꿔도
볼륨 문자열이 같으면 PostgreSQL이 **같은 데이터 디렉토리로 두 번** 기동됐다
(#1613).

지금은 기동 전에 산 컨테이너의 `com.docker.compose.project.working_dir` 라벨을
이 체크아웃 경로와 대조한다. 다른 디렉터리의 스택이 같은 프로젝트 또는 같은
`DB_VOLUME_NAME` 을 쓰고 있으면 `--compose up` / `down` 은 거절되고, 원인과
해법을 출력한다. **같은 체크아웃에서 다시 `up` 하는 것**(내 스택 재개)은
경고 없이 동작한다.

분리하려면 env 의 **두 줄을 함께** 바꾼다. 프로젝트명만 바꾸면 볼륨을 계속
공유한다:

```sh
# infra/rust/local.secrets.env — 예시. 이미 파일이 있으면 시크릿을 다시 만들지 말고
# 이 두 줄만 고친 뒤, 다른 체크아웃의 스택이 내려간 것을 확인하고 up 한다.
COMPOSE_PROJECT_NAME=oort-lab
DB_VOLUME_NAME=oort-lab-pgdata
```

기존 `oort-pgdata` 데이터를 이 클론이 이어받으려면 기본 이름(`oort` /
`oort-pgdata`)을 유지한 채 **먼저 다른 체크아웃에서 `down`**(볼륨은 남김)한다.
업그레이드가 볼륨을 지우거나 새 빈 볼륨으로 바꿔 끼우지 않는다. `down -v` 의
의미는 그대로다: **이 env 가 가리키는 볼륨**을 지운다. 첨부 보관소 볼륨
(`DRIVE_VOLUME_NAME`, 기본 `oort-drive`)도 같은 규율이다 — 프로젝트명을
바꿀 때 같이 바꾼다.

## 첨부 보관소

셀프호스트 생성 env 는 `MOMO_DRIVE_ARCHIVE_BACKEND=local` 과
`MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive` 를 기본으로 쓴다(ADR-0169).
첨부 바이트는 Postgres 가 아니라 그 디렉터리(compose 명명 볼륨
`DRIVE_VOLUME_NAME`, 기본 `oort-drive`)에 산다. 파일명은 메타만 되고,
디스크 경로는 서버가 만든 불투명 id 뿐이다. Google Workspace SA 는
이 경로에 필요 없다. `stub` 은 `MOMO_ENV=staging` 에서 부팅이 거부된다.

기존 env 에 이 키가 없으면 `scripts/self_host_env.sh` 가 **그 줄만
덧붙인다** — 시크릿은 다시 만들지 않는다. 반영에는 api 재시작이 필요하다
(`scripts/self_host_env.sh --compose up -d`). 값을 비워 두면 첨부는 예전처럼
503 `Drive archive is not configured` 이다. 신선한 명명 볼륨은 root
소유로 생긴다. `local.override.yml` 의 `drive-init` 이 첫 기동에서
마운트 포인트를 uid 10001 로 chown 한다 — 쓰기 실패를 무시하지 않고,
권한을 고친 뒤에야 api 가 뜬다.

**백업 대상.** `pg_dump` 는 메시지·멤버만 가져온다. 첨부 파일을 살리려면
같은 시점에 보관소 볼륨을 복사한다. 절차 한 줄은
[`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

## 링크 미리보기 (언퍼얼)

메시지에 붙은 http(s) 링크의 제목·설명·이미지를 서버가 가져와 카드로
광고한다(ADR-0170). **기본은 꺼져 있다.** 셀프호스트 egress 를 보수적으로
두려면 그대로 둔다.

켜려면 env 에 한 줄을 넣고 `webhook-sender` 를 재시작한다:

```sh
MOMO_UNFURL_ENABLED=1
```

워크스페이스 관리자는 `PUT /v1/workspaces/{id}/unfurl-settings` 로
테넌트 단위에서 fetch 자체를 끌 수 있다(렌더만 끄는 게 아니다).
발신자는 자기 메시지의 카드를 `DELETE …/messages/{id}/unfurls` 로 지운다 —
지운 카드는 다시 만들어지지 않는다.

**P9 경계.** 서버는 링크 *대상*만 읽는다. 메시지 본문을 알림 판정이나
에이전트 컨텍스트로 읽는 경로가 아니다. URL 문자열을 집어 OG/Twitter 태그를
가져오는 것이고, 사람 발신과 에이전트 발신은 같은 경로다. 사설망·링크로컬·
루프백은 기존 OutboundHTTPPolicy 가 매 홉 거절한다. 미리보기 이미지는
서버 프록시만 통과한다 — 브라우저가 임의 호스트에 직접 붙지 않는다.

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
2단계부터 다시 밟는다(새 DB에는 새 시크릿이 맞다). 다른 체크아웃의 스택을 이
트리의 `--compose down -v` 로 지우려고 하지 마라 — 같은 프로젝트/볼륨을 쓰는
산 타 체크아웃이면 거절된다([두 체크아웃](#두-체크아웃을-같이-쓸-때)).

## 막히면

| 증상 | 원인과 조치 |
|---|---|
| 3단계가 `port is already allocated` 로 실패 | 2단계 이후에 그 포트를 누가 잡았다. `down` 후 `local.secrets.env` 의 `MOMO_WEB_PORT` 를 바꾸고 다시 `up`. |
| 로그인이 `invalid credentials` | 2단계가 알려 준 값을 쓴다(`grep MOMO_INITIAL_OWNER infra/rust/local.secrets.env`). 비밀번호를 바꾸려면 아래 회전 명령. |
| 화면은 뜨는데 메시지가 실시간으로 안 온다 | outbox가 빠졌는지 먼저 본다(아래 질의). `broadcast \| done` 이면 서버 쪽은 끝난 것이고 브라우저 쪽을 본다(`oort logs api`). `pending`/`failed` 면 relay다(`oort logs relay`). |
| 설정 › AI 연결이 **403** | 이 인스턴스에 등재된 운영자가 없다. `grep PLATFORM_ADMIN_EMAILS infra/rust/local.secrets.env` — 줄이 없으면 `scripts/self_host_env.sh --local-build`(또는 자신이 고른 모드)를 다시 실행하면 그 줄만 덧붙는다. 그 뒤 `oort up -d`로 api 재시작. [§5](#5-에이전트가-대답하게-하기-ai-연결). |
| 설정 › AI 연결이 **503** | api가 `PROVIDER_LINK_MASTER_KEY` 없이 떴다. 2단계가 만든 env에는 있다 — 손으로 만든 env를 쓰고 있다면 그 줄을 채우고 `oort up -d`. |
| 에이전트를 만들었는데 대답이 없다 | 키를 아직 안 넣었거나(§5), 넣은 엔드포인트가 응답하지 않는 것이다. 채널에 「응답하지 못했습니다」류 메시지가 뜨면 후자다(`oort logs agent-worker`). |
| `--compose up` 이 다른 체크아웃이 같은 프로젝트/볼륨을 쓴다고 거절 | 그 체크아웃에서 `down`(볼륨은 남김) 하거나, 이 클론의 `COMPOSE_PROJECT_NAME` 과 `DB_VOLUME_NAME` 을 **함께** 바꾼다. [두 체크아웃](#두-체크아웃을-같이-쓸-때). |
| 업그레이드 후 로그인이 안 되고 DB가 비어 보인다 | 새 env 가 `oort-pgdata` 가 아닌 볼륨을 가리키고 있을 수 있다. 데이터가 삭제된 것이 아니다 — `docker volume ls` 로 `oort-pgdata` 를 확인하고, `DB_VOLUME_NAME=oort-pgdata` 로 채택하거나 기본 프로젝트명 `oort` 로 env 를 다시 만든다. |
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

## 터널·외부 노출

이 문서의 엣지는 루프백이다. Tailscale·cloudflared 같은 터널로 원격
클라가 붙을 때 로그인 REST는 되는데 실시간만 죽는 증상은, 생성기가
예전 기본값 `ws://localhost:<port>/connection/websocket` 을 광고했기
때문이다(ADR-0167). 새 env 는 `MOMO_CENTRIFUGO_WS_URL=same-origin` 이라
로그인 응답이 요청 `Host` 에서 `wss://<공개호스트>/connection/websocket`
을 파생한다.

공개 오리진을 Centrifugo 허용목록에 멱등 추가한 뒤 스택을 재시작한다.
기본 localhost / 127.0.0.1 / tauri Origin 은 그대로 둔다.

```sh
scripts/self_host_env.sh --public-origin https://<공개호스트>
scripts/self_host_env.sh --compose up -d
```

검증: 로그인 응답 `realtimeWebSocketUrl` == `wss://<공개호스트>/connection/websocket`.
이미 만든 env 가 루프백 URL을 들고 있으면 그 한 줄만 `same-origin` 으로
고친다. 시크릿 파일 재생성은 금지.

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
