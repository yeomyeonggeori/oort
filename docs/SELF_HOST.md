# oort 셀프호스트 — clone에서 로그인까지 (SELF_HOST.md)

> **이 문서 하나로 끝난다.** 끝까지 따르면 당신의 머신에서 돌아가는 oort에
> **브라우저로 로그인해 메시지를 주고받는다.**
> 명령 셋 + 브라우저 한 번. 분기 없음. 중간에 소스를 열어 볼 일 없음.
>
> 시간은 약속하지 않는다 — 첫 기동은 이미지를 처음부터 굽고, 그건 당신의 머신이
> 정하는 값이다. 약속하는 것은 **결과**다: 저 넷을 마치면 화면이 있다.
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

> 공개 시점·이미지 배포는 아직 결정 중이라, 지금 이 URL은 접근 권한이 있는 계정에서만
> 통한다. 그 결정과 무관하게 아래 절차는 체크아웃만 있으면 그대로 성립한다.

## 2. env 만들기

```sh
scripts/self_host_env.sh
```

`infra/rust/local.secrets.env` 를 만든다 — **채워 넣을 자리가 하나도 없는** 파일이다.
시크릿 아홉 개를 `openssl` 로 만들고, 서로 같아야 하는 값들(런타임 롤 비밀번호와
접속 URL 안의 비밀번호)을 같게 쓰고, 포트가 이미 쓰이고 있으면 비어 있는 다음
포트를 골라 알려 준다. 그리고 **첫 로그인 계정**을 함께 만든다.

끝에 이런 것이 찍힌다 — 다음 두 단계가 전부 여기 있다:

```
[self-host] infra/rust/local.secrets.env 를 만들었다 (권한 600).

[self-host] 준비됐다. 다음 한 줄이 스택을 띄운다:

  docker compose --env-file infra/rust/local.secrets.env \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/docker-compose.rust.build.yml \
  -f infra/rust/local.override.yml \
    up -d --build --wait

[self-host] --wait 가 붙어 있으므로 그 명령이 끝나면 준비가 끝난 것이다.
[self-host] 브라우저에서 열고 아래로 로그인한다:

  http://localhost:8088
  email    owner@oort.local
  password 3f9c1b7a2e40d5b8c1a9e6f2
```

비밀번호는 파일 안에도 있다(`infra/rust/local.secrets.env`, 권한 600, 커밋 대상
아님). 이 스크립트는 **파일이 이미 있으면 절대 덮어쓰지 않는다** — 이미 마이그레이션한
DB가 있는데 시크릿을 다시 만들면 그 DB와 어긋나기 때문이다. 다시 실행하면 현재
로그인 정보만 다시 보여 준다.

## 3. 기동

2단계가 찍어 준 명령을 그대로 붙여 넣는다.

```sh
docker compose --env-file infra/rust/local.secrets.env \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/docker-compose.rust.build.yml \
  -f infra/rust/local.override.yml \
  up -d --build --wait
```

`--wait` 가 붙어 있으므로 **이 명령이 끝났다는 것이 준비가 끝났다는 뜻이다.**
그 사이에 순서대로 일어나는 일: 이미지 빌드 → PostgreSQL 기동 → 최소권한 런타임
롤 생성 → 마이그레이션 전량 적용(+2패스 멱등 검사) → 첫 로그인 계정 생성 →
api·relay·agent-worker·웹 엣지 기동.

## 4. 로그인

브라우저에서 **`http://localhost:8088`** 을 열고 2단계가 알려 준 이메일과
비밀번호를 넣는다. 워크스페이스 칸은 비워 둔다.

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
이 한 줄을 붙여 넣는다(변수가 아니라 **함수**인 것은 의도다 — zsh는 변수를
단어로 쪼개 주지 않아서 `$OORT down` 은 macOS 기본 셸에서 통하지 않는다):

```sh
oort() { docker compose --env-file infra/rust/local.secrets.env -f infra/rust/docker-compose.rust.yml -f infra/rust/docker-compose.rust.build.yml -f infra/rust/local.override.yml "$@"; }
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
[`docs/DEPLOY.md`](DEPLOY.md), 배포 호스트 절차는
[`docs/runbooks/ncp-rust-deploy.md`](runbooks/ncp-rust-deploy.md).
