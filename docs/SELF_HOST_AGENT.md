# oort 그록봇 셀프호스트 플레이북 (SELF_HOST_AGENT.md)

> **이 문서가 제품이다.** 그록봇(Grok Bot)이 이것만 읽고, 사람 개입 없이
> 자기 VM에 oort를 켜고, 사용자에게 접속 주소·앱 링크·1회용 claim URL을
> 회신하고, 자신은 에이전트 멤버로 합류한다.
>
> 사람이 노트북에서 clone 해 로그인하는 정본은 [`SELF_HOST.md`](SELF_HOST.md)다.
> 로그인 다음 하루(워크스페이스·초대·AI 연결·첫 멘션)는
> [`SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md).
> 데이터 덤프·복원 정본은 [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

이 문서는 법률 자문이 아니다. 비밀번호·pairing/claim 원문·`DATABASE_URL`을
대화 로그·이슈·스크린샷에 다시 적지 않는다(ADR-0004). claim URL은 사용자에게
**한 번만** 회신한다.

---

## 0. 전제 — 누구의 기계인가

**체험자 본인 그록봇 계정/VM에서만 구동한다.** 성재/팀 계정의 VM을 남에게
여는 공용 데모 호스트로 쓰지 않는다. 이 플레이북의 실행 주체는 **그록봇
자신**이다. 그록봇 앱을 CDP·스크립트·셀렉터로 제어하지 않는다. 사람이
자연어로 지시하면, 그록봇이 자기 VM 셸에서 아래를 수행한다.

그록봇 VM 위 구동은 **개인 체험용**이다. 업무·상시 사용은 §4로 덤프를
가져가 자기 서버(VPS 등)에서 한다.

영속성 공식은 **durable-but-resettable**(RA-4): `/workspace` 파일은 durable
층이고, Docker 이미지·수동 설치물은 Update 때 증발할 수 있다. Reset은
스냅샷 롤백이다. Postgres 데이터는 그래서 `/workspace` 아래 bind mount가
보수 기본이다.

### 의존을 먼저 밝힌다

git clone은 하지 않는다. **curl + tar + Docker Engine + Compose v2 + openssl**
이면 된다. 공개 스냅샷 tarball 안에 있는 `scripts/self_host_env.sh` 는
**시크릿 정합 때문에 의존한다** — 12개 값 중 넷은 URL과 비밀번호가 서로
같아야 하고, 어긋나면 스택은 healthy인데 로그인이 영원히 안 된다. 그
스크립트가 만든 env로 compose를 띄운다. 사람이 쓰는 `--compose` 런처는
claim 모드와 같이 쓰지 않는다(§1.4).

확인:

```sh
docker compose version
openssl version
curl --version
```

Rust·Node·`psql`·Cloudflare 계정은 필요 없다.

---

## 1. 코어 설치

각 단계 끝에 **검증 게이트**가 있다. 게이트가 실패하면 다음 층으로 가지
말고 멈춘다. 비밀번호를 만들어서 대화창으로 보내지 않는다.

### 1.1 스냅샷을 받는다

이 파일이 이미 레포 루트에 있으면 그 디렉터리를 쓴다. 아니면 공개
tarball:

```sh
curl -fsSL -o oort.tar.gz \
  https://github.com/yeomyeonggeori/oort/archive/refs/heads/track/engine.tar.gz
tar -xzf oort.tar.gz
cd oort-track-engine
```

`track/engine` 은 이 플레이북의 랜딩 브랜치다. main 승격 뒤에는
`refs/heads/main` / 디렉터리 `oort-main` 을 쓴다.

### 1.2 GHCR 고정 digest

정본은 [`SELF_HOST.md`](SELF_HOST.md) §2-B / GitHub Releases다. 아래는 그
표의 **실값**이다(`latest`·`sha-*` 태그는 받지 않는다).

| 대상 | 불변 이미지 |
|---|---|
| 앱 (`--published-image`가 소비) | `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757` |

postgres 행은 Release 표·운영/PITR용이다. **이 플레이북 compose의 postgres
서비스는 소비하지 않는다**(§2-B 주석·V-1 #1650과 동일). 앱만 pin한다.

공개 발행은 **`linux/amd64`**. 그록봇 VM 실측은 amd64라 native pull이다.
Apple Silicon 호스트는 native pull이 불가했다(2026-08-21). 전역
`DOCKER_DEFAULT_PLATFORM` 은 켜지 않는다(V-1: centrifugo 로컬 index가
거절된다). 앱만 `--platform linux/amd64` 로 받는다.

```sh
APP_REF='ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb'
docker pull --platform linux/amd64 "$APP_REF"
```

**게이트:** `docker image inspect "$APP_REF"` 가 실패하지 않는다.

### 1.3 Postgres를 `/workspace`에 둔다

RA-4 §8.3 보수 기본. Docker named volume만 쓰면 Update 때 `/var/lib/docker`
층과 함께 사라질 수 있다. bind는 **첫 `up` 전에** 만든다.

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

이미 있는 볼륨이 `/workspace/oort-pgdata` bind가 아니면 **여기서 멈춘다.**
다른 드라이버의 볼륨을 지우고 새로 만들지 않는다(데이터 위치 불명). 소실
복원은 §1.7.

**게이트:** `docker volume inspect oort-pgdata` 의 Options에
`device=/workspace/oort-pgdata` 가 보인다.

### 1.4 env 생성 + claim 모드

```sh
scripts/self_host_env.sh --published-image \
  ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb
```

생성기는 항상 `MOMO_INITIAL_OWNER_PASSWORD` 를 쓴다. ADR-0166 claim 모드는
그 비밀번호와 **상호 배타**다(`MOMO_BOOTSTRAP_CLAIM=1` + 이메일만). 생성기
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

env 파일을 cat/grep 해서 stdout에 흘리지 않는다. 이미 claim 수술된
파일이면 같은 awk가 멱등이다. **생성기를 다시 돌리지 않는다** — 비밀번호
키가 없으면 `--compose`/재생성 경로가 거절한다.

```sh
oort_compose() {
  docker compose --env-file "$ENV_FILE" \
    -f infra/rust/docker-compose.rust.yml \
    -f infra/rust/local.override.yml \
    "$@"
}

oort_compose up -d --pull missing --wait
```

`--wait` 종료 = 컨테이너 healthy. 그 다음이 제품 게이트다.

이 엣지는 `127.0.0.1` 에만 바인딩된다(TLS 없음). 공인 IP가 있어도 그
주소로 직접 열리지 않는다.

### 1.5 헬스체크 게이트

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
code=$(curl -sS -o /tmp/oort-healthz.body -w '%{http_code}' \
  "http://127.0.0.1:${WEB_PORT}/healthz")
test "$code" = 200
```

**게이트:** HTTP 200. 본문은 `{"status":"ok",...}` 이고 시크릿이 없다
(V-1 실측과 동형). 200이 아니면 로그(`oort_compose logs api`)를 보고 멈춘다.

로컬 agent-port 표면(터널 전):

```sh
curl -sS -D - -o /dev/null -X POST \
  "http://127.0.0.1:${WEB_PORT}/v1/mcp/agent-port"
```

**게이트:** `401` 과 `WWW-Authenticate: Bearer scope="agent:port:connect"`
(V-1 #1650, 발행 digest 실측). 없으면 이 이미지는 합류 표면이 없는
것이다 — 비밀번호를 만들지 말고 멈춘다.

### 1.6 claim 경로 게이트

migrate가 원문을 **stdout에 한 번만** 낸다. 재기동은 재인쇄하지 않는다
(`MOMO_BOOTSTRAP_CLAIM=skipped`). 첫 `up` 직후 바로 담는다.

```sh
umask 077
oort_compose logs migrate | sed -n 's/.*\(MOMO_CLAIM_PATH=\/claim\/[A-Za-z0-9_-]\{43\}\).*/\1/p' \
  | tail -n 1 > /workspace/oort-claim.env
chmod 600 /workspace/oort-claim.env
```

**게이트:** `/workspace/oort-claim.env` 가 비어 있지 않고
`MOMO_CLAIM_PATH=/claim/` 로 시작한다. 비어 있으면 **여기서 멈춘다.**
현행 §2-B digest(v0.1.0)는 #1651 claim 바이너리보다 앞선 발행일 수 있다.
비밀번호 env를 되살리는 우회는 ADR-0004 위반이다. 재발행은 이 플레이북
밖이다.

토큰을 대화·로그에 다시 찍지 않는다. 사용자 회신(§3)에서 터널 주소와
이어 붙일 때만 읽는다.

### 1.7 멱등 재기동 (Update 시 이미지 증발 전제)

그록봇 **Settings → Updates → Update** 는 새 인스턴스로 옮긴다. 공식
의미론: `/workspace` 파일은 유지, **Docker 이미지는 소실(재설치)**.
볼륨 층은 마커 실측 전이라 위험 쪽으로 본다. 그래서 pgdata는 §1.3 bind다.

이미지가 사라진 뒤, **같은 env를 다시 만들지 말고**:

```sh
APP_REF='ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb'
docker pull --platform linux/amd64 "$APP_REF"
# bind 볼륨이 없으면 §1.3을 다시 밟는다 (기존 볼륨을 함부로 rm 하지 않는다)
oort_compose up -d --pull missing --wait
```

그다음 §1.5 헬스체크를 다시 통과한다. claim 파일은 이미 소비됐을 수
있다 — 재발급하지 않는다.

Postgres가 비어 보이거나 로그인이 안 되면 데이터가 소실된 것이다.
`/workspace/oort-backups` 덤프가 있으면
[`selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md) 로
복원한다. 덤프도 없으면 사용자에게 소실을 알리고, 비밀번호를 지어내지
않는다.

```sh
scripts/self_host_pg_restore.sh --dump /workspace/oort-backups/oort-pg.dump
```

`--dump` 경로가 없으면 스크립트가 거절한다. 복원 뒤 `oort_compose up -d --wait`
와 §1.5.

---

## 2. 환경 분기

v1 외부 도달 = **cloudflared quick tunnel**(R-2 전면 GREEN: HTTP 200,
agent-port 401, WS 프레임 왕복, 지연 중앙값 13ms). Cloudflare 계정 불요.
URL은 기동마다 바뀐다.

데스크탑 Tauri Origin(`tauri://localhost`, `http://tauri.localhost`)은
셀프호스트 env 기본 허용 목록에 있다 — **터널 URL로 데스크탑 접속은
무설정 통과**. 웹 브라우저로 터널 URL을 열면 Centrifugo가 터널 Origin을
403 한다. v1은 데스크탑 전용. 웹-경유-터널 Origin 주입은 이 플레이북
밖이다.

### 2.1 공인 IP 판단

정보 단계다. 이 스택의 웹 엣지는 루프백 전용이라, 공인 IP가 있어도
터널을 생략하지 않는다. named tunnel·도메인은 out of scope.

```sh
curl -fsS --max-time 5 https://1.1.1.1/cdn-cgi/trace || true
```

`ip=` 가 RFC1918/링크로컬이 아닌 공인 주소여도 §2.2로 간다. 그록봇 VM
실측은 공인 inbound 없음.

### 2.2 quick tunnel

cloudflared가 없으면 공식 linux/amd64 바이너리를 받는다(계정 불요):

```sh
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
```

터널은 엣지 포트로:

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${WEB_PORT}"
```

로그의 `https://<id>.trycloudflare.com` 이 터널 주소다. 이 프로세스를
VM이 살아있는 동안 유지한다. URL을 재기동하면 바뀐다 — 사용자에게
새 주소를 다시 회신한다.

### 2.3 외부 도달성 자가검증

VM **안에서** 터널 URL로 나갔다 들어온다(V-1이 로컬에서 증명한 같은
표면).

```sh
# TUNNEL_URL = https://<id>.trycloudflare.com  (자리표시. 실값을 문서에 쓰지 않는다)
curl -sS -o /tmp/oort-tunnel-healthz.body -w '%{http_code}\n' \
  "${TUNNEL_URL}/healthz"
curl -sS -D - -o /dev/null -X POST \
  "${TUNNEL_URL}/v1/mcp/agent-port"
```

**게이트:**

| 호출 | 기대 |
|---|---|
| `GET ${TUNNEL_URL}/healthz` | 200 |
| `POST ${TUNNEL_URL}/v1/mcp/agent-port` | 401 + `WWW-Authenticate: Bearer scope="agent:port:connect"` |

둘 중 하나라도 아니면 핸드오프 회신을 보내지 않는다. 터널 URL은
**사실상 공개 주소**다. 주소를 아는 사람은 로그인 화면까지 도달한다.
소유권은 claim 토큰이 가른다(ADR-0166). 초기 비밀번호는 없다.

---

## 3. 사용자 핸드오프

§2.3 게이트를 통과한 뒤에만 회신한다. 비밀번호를 회신하지 않는다.
claim 토큰은 URL 안에만 있고, 이 한 번뿐이다. TTL 24h, 단회 소비.

### 3.1 회신 템플릿

아래 괄호를 실값으로 바꾼다. `<토큰>` 원문을 이 문서처럼 다시 적지 말고,
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
   사라지고, /workspace 파일은 남는 쪽입니다. 터널 주소는 재기동마다
   바뀔 수 있습니다. 바뀌면 제가 새 주소를 다시 보냅니다.

6) 오늘 백업 (중요)
   그록 트라이얼이 잠기면 VM 자체에 못 들어갑니다(B7). 구독을 해지해도
   같습니다. 첫 메시지를 보내기 전에 /workspace/oort-backups 에 덤프를
   만들어 두었습니다. Grok Bot 워크스페이스에서 그 폴더를 당신 기기로
   복사해 두세요. 복원 절차:
   https://raw.githubusercontent.com/yeomyeonggeori/oort/track/engine/docs/runbooks/selfhost-pg-dump-restore.md

7) 저를 팀에 넣으려면
   데스크탑에서 로그인한 뒤 에이전트 → 호스티드 에이전트 연결에서
   저를 만들고, 화면에 한 번만 보이는 「연결 값」을 이 대화에 붙여
   주세요. 제가 VM 안에서 합류합니다. Grok 앱 커넥터에 주소를 넣을
   필요가 없습니다.
```

### 3.2 첫날 백업을 실제로 만든다

회신 전에:

```sh
scripts/self_host_pg_dump.sh --output-dir /workspace/oort-backups
```

**게이트:** `/workspace/oort-backups` 아래 `.dump` 파일이 생기고, 스크립트
stdout에 비밀번호가 없다. 사용자에게 그 폴더를 워크스페이스에서 내려받으라고
§3.1-6에 적는다. 덤프 바이트를 채팅에 붙이지 않는다.

### 3.3 에이전트 합류 (VM 내부 curl, static bearer)

Grok 앱 커넥터·플러그인·routine 설치는 **하지 않는다.** #1361 커넥터
헤더 미지수는 이 경로의 전제가 아니다. ADR-0162 static bearer를 VM
루프백에서 직접 소모한다.

순서는 사용자가 claim을 소비한 다음이다. 그록봇은 사용자 비밀번호를
모른다. 연결 생성·승인은 데스크탑 위저드가 한다.

1. 사용자가 §3.1-3 claim URL에서 비밀번호를 만들고 데스크탑으로 `<TUNNEL_URL>` 에 로그인한다.
2. **에이전트** → **호스티드 에이전트 연결** → 표시 이름/핸들(예: Grok Bot / grok)로 연결을 만든다.
3. 위저드가 한 번만 보여주는 **「연결 값」**을 이 대화에 붙여 넣는다(15분 TTL).
4. 그록봇은 값을 환경 변수로만 받고, echo/로그/회신에 되풀이하지 않는다.
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

**게이트:** handshake가 성공하면 위저드가 감지 상태로 넘어간다. 실패(401)면
값을 다시 묻지 말고 「연결 값 다시 발급」을 안내한다. 잘못된 era/body는
값을 소비하지 않는다.

6. 사용자가 채널·권한을 확인하고 승인한다. 화면에 한 번만 나오는
   **active credential**을 붙여 넣는다. pairing 값과 다른 비밀이다.
7. 같은 `EP` 로 active credential handshake를 한 번 더 한다(첫 유효
   Agent Port 호출이 `active` 증명·unpause). 값을 저장·재인쇄하지 않는다.

**게이트:** 이후 무인증 POST는 계속 401. 멘션에 에이전트 뱃지가 보이면
합류 완료. 첫 멘션 왕복의 제품 표면은 T-6, 감지 원클릭은 T-5 — 이
플레이북은 curl 왕복까지다.

Update/Reset 뒤 재합류는 위저드의 「연결 값 다시 발급」+ 위 curl과 같다.

---

## 4. 데이터 가져가기

정본: [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

```sh
scripts/self_host_pg_dump.sh --output-dir /workspace/oort-backups
```

그록 이탈·구독 해지·B7 트라이얼 잠김 전에 사용자가 이 폴더를 자기
기기로 복사해야 한다. 앱 UI export 버튼은 후속 티켓(본 파도 미발급).

---

## 5. 하지 말 것

- 성재/팀 VM을 공용 호스트로 쓰기
- 그록봇 앱 CDP/자동화
- 비밀번호·pairing/active 원문을 회신 본문에 반복
- claim 실패 시 `MOMO_INITIAL_OWNER_PASSWORD` 경로로 우회
- 웹 브라우저를 터널 URL의 상시 클라이언트로 안내 (v1은 데스크탑)
- `caddy.override.yml` / 운영 Caddyfile 을 이 VM에서 이름 부르기 (ACME 주문)
- `DOCKER_DEFAULT_PLATFORM=linux/amd64` 전역 pin
- `down -v` 를 데이터가 있는 볼륨에 실행

실기동 E2E(D7)는 이 문서의 게이트가 아니다. 그 수용 런은 자연어 지시
릴레이로 따로 한다. 여기의 게이트는 그록봇이 다음 층으로 넘어가도
되는지를 가른다.
