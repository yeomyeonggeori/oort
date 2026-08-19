# GROK-E2E 수동 스파이크 준비 — 성재 실행 안내문 + 오케스트레이터 검증 (#1361)

> 2026-08-19 Fable(준비 워커). 파도 10 패킷 E조(`handoffs/2026-08-19-wave10-packet.md`) 집행분 — **레포 코드 비변경**.
> 목적: **성재가 Grok 앱만 열면 되는 상태**를 만들고, 각 단계에서 오케스트레이터가 읽을 신호를 미리 확정한다.
> 경계: ADR-0162(+증보 1) · ADR-0004(자격 비유입). 절차 정본은 `handoffs/2026-08-16-grok-e2e-manual-spike-packet.md`, 판정 정본은 이슈 **#1361** 본문 체크리스트.
> **이 문서에는 raw secret이 하나도 없다.** pairing 값·active credential은 자리표시자 + 발급 화면 경로로만 적는다. 실행 중에도 채팅·이슈·로그·스크린샷에 남기지 않는다.
> ⚠ 이번 스파이크는 **프로덕션(app.oor7.com) 비접촉**이다. 전부 이 맥의 로컬 스택에서 돈다.

---

## §0. 지금 상태 (이 문서를 쓴 시점, 2026-08-19T09:3xZ)

로컬 oort 스택이 **이미 떠 있다. 회수하지 마라** — 성재의 수동 E2E가 그대로 이어받는다.

| 서비스 | 컨테이너 | 바인딩 | 쓰임 |
|---|---|---|---|
| 웹 엣지(Caddy) | `oort-web-1` | `127.0.0.1:8088` | **사람이 여는 주소이자 Grok이 부를 주소.** SPA + `/v1` + `/connection` 동일 오리진 |
| API | `oort-api-1` | `127.0.0.1:8080` | 검증 커맨드가 직접 부르는 곳 |
| Centrifugo | `oort-centrifugo-1` | `127.0.0.1:8000` | 전송 전용 |
| Postgres | `oort-postgres-1` | 컨테이너 내부만 | SoT. `docker exec`로만 읽는다 |
| relay / agent-worker / webhook-sender | `oort-relay-1` 외 | — | outbox relay · hosted gateway(`agent_gateway_mode=worker`) |

- compose project `oort` · 작업 디렉터리 `~/projects/momo-tracks/engine/infra/rust` · 파일 `docker-compose.rust.yml` + `docker-compose.rust.build.yml` + `local.override.yml`.
- 워크스페이스 **momo Demo Workspace** `00000000-0000-7000-8000-000000000001`, 채널 `#general` `…-000000000201` · `#agent-lab` `…-000000000202`, 로그인 오너 `owner@oort.local`(비밀번호는 `infra/rust/local.secrets.env`의 `MOMO_INITIAL_OWNER_PASSWORD` — **여기에 옮겨 적지 않는다**).
- **전용 에이전트 `Grok Bot`(@grok)과 그 연결이 이미 만들어져 있다**: connection `01a01951-9f29-7500-8c5b-c7cb4640625e`, agent member `01a01951-9f26-7b9d-836f-7e52cc10ab32`, 상태 `pairing_pending`. 성재는 **1·2단계를 새로 밟지 않고** 위저드를 이어서 열어 연결 값만 다시 발급하면 된다(§2).
- 목록에 `E2E 프리플라이트 프로브`(@e2e-prep-probe, connection `01a01949-…`, 상태 `detected`)가 하나 더 보인다. **준비 워커의 실측용 연결이다.** 승인하지 말고 무시해라. 필요하면 §7의 정리 절차를 이 연결로 먼저 연습해도 된다.

### 스택 기동/정지

```bash
cd ~/projects/momo-tracks/engine
scripts/self_host_env.sh --compose ps                       # 지금 상태
scripts/self_host_env.sh --compose up -d --build --wait     # 기동(이미 떠 있으면 무해)
scripts/self_host_env.sh --compose down                     # 정지 — 데이터 볼륨 보존
scripts/self_host_env.sh --compose down -v                  # 완전 회수 — 워크스페이스·연결 전부 소멸
docker logs -f oort-api-1                                   # 서버 로그
```

**E2E가 끝날 때까지 `down`을 부르지 마라.** `down -v`는 이 문서의 connection id·채널을 전부 무효로 만든다.

---

## §1. 먼저 확정된 사실 — Agent Port dual-era 실측 (#1363)

성재가 Grok을 붙이기 전에, 서버가 두 시대에 무엇을 말하는지 무자격/유자격 왕복으로 전부 찍었다. 엔드포인트는 **웹 엣지 경유** `http://localhost:8088/v1/mcp/agent-port`(Grok이 부를 바로 그 주소).

### 1-1. modern 2026-07-28 — `server/discover`

modern 시대에는 `initialize`가 없다. 요청은 `MCP-Protocol-Version: 2026-07-28` + `Mcp-Method: server/discover` + `params._meta`(3개 키만 허용).

```
HTTP 200
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2026-07-28",
  "capabilities":{"tools":{"listChanged":false}},
  "serverInfo":{"name":"oort-agent-port","title":"oort Agent Port","version":"0.0.0"},
  "resultType":"server/discover",
  "cache":{"ttlSeconds":300,"scope":"private"}}}
```

### 1-2. legacy 2025-11-25 — `initialize` (Grok `0.16.0`이 보낸 모양)

`MCP-Protocol-Version` 헤더 **없이** 보낸 `initialize`도 성립한다(era가 body에서 추론된다). 이것이 #1344에서 관측된 Grok의 모양이다.

```
HTTP 200
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2025-11-25",
  "capabilities":{"tools":{"listChanged":false}},
  "serverInfo":{"name":"oort-agent-port","title":"oort Agent Port","version":"0.0.0"}}}
```

두 시대 모두 **negotiated version = 서버가 고정으로 되돌리는 그 시대의 값**이고, 서버 capability는 `tools.listChanged=false` 하나뿐이다(resources/prompts/logging 없음).

### 1-3. closed tool 카탈로그 — 8개, 그러나 **pairing 값으로는 볼 수 없다**

`tools/list`는 **active credential(§4 이후)에서만** 응답한다. pairing 값은 handshake 1회용이라 `tools/list`를 부르면 `401 invalid_token`이다(1-4). 따라서 카탈로그의 사전 확인은 서버 정본(`server-rust/crates/momo-mcp/src/tools.rs` `TOOL_CATALOG`)으로 한다. **순서까지 정본**이며 `tools/list`가 이 순서로 낸다:

| # | 이름 | 필요한 scope |
|---|---|---|
| 1 | `oort_inbox_read` | `agent:inbox:read` |
| 2 | `oort_conversation_read` | `messages:read` |
| 3 | `oort_message_post` | `messages:write` |
| 4 | `oort_jobs_claim` | `agent:jobs:read` |
| 5 | `oort_job_renew` | `agent:jobs:read` |
| 6 | `oort_job_release` | `agent:jobs:read` |
| 7 | `oort_run_event` | `agent:runs:callback` |
| 8 | `oort_run_complete` | `agent:runs:callback` |

`agent:port:connect`는 **도달성이지 능력이 아니다** — 이 scope만 승인하면 `tools/list`는 **빈 목록**이다. 승인 화면(§3)에서 「접속」만 켜고 넘어가면 Grok은 붙되 아무것도 못 한다.

### 1-4. 잘못된 자격의 실패 응답 (전부 실측)

| 케이스 | HTTP | `WWW-Authenticate` |
|---|---|---|
| Authorization 헤더 없음 | 401 | `Bearer scope="agent:port:connect"` |
| 아무 문자열 bearer | 401 | `Bearer error="invalid_token", scope="agent:port:connect"` |
| 봉투 모양은 맞으나 등록 안 된 pairing 값 | 401 | `Bearer error="invalid_token", scope="agent:port:connect"` |
| **소비된 pairing 값 재사용(replay)** | 401 | `Bearer error="invalid_token", scope="agent:port:connect"` |
| pairing 값으로 `tools/list`·`notifications/initialized` | 401 | 〃 |
| modern 헤더 + legacy `initialize` body(era 교차) | 401 | 〃 |
| 지원하지 않는 버전(`2025-06-18`) | 401 | 〃 |
| `GET /v1/mcp/agent-port` | 405 | — (POST 전용) |

**핵심 설계 하나**: pairing 값은 **요청이 유효한 handshake일 때만** 승인된다(`auth.rs`: `pairing.is_some() && !protocol_valid → InvalidToken`). era를 틀리거나 body가 망가지면 **pairing 값이 소비되지 않고** 401만 난다 — 즉 성재가 Grok 설정을 잘못해도 15분 TTL 안에서는 값을 다시 쓸 수 있다. 반대로 **한 번 성공하면 그 값은 그 자리에서 죽는다**(다음 호출부터 401).

### 1-5. 성재의 실행에 직접 영향을 주는 사실 3개

1. **원문 clientInfo는 절대 저장되지 않는다.** `detect_pairing_in_tx`가 `client_name`/`client_version`을 하드코딩으로 `None`으로 눌러 저장한다(ADR-0004 규율 — provider 문자열은 증명 불가능한 비밀 통로). DB의 `detected_client_name`은 **성공적인 감지 뒤에도 비어 있는 것이 정상**이다. 「Grok이 어떤 client name을 보냈는가」의 기록은 **audit의 boolean 존재 여부**뿐이다: `audit_log.detail.client_name_present`. 실측으로 `true`가 찍히는 것을 확인했다.
2. **client capability는 닫힌 어휘로만 투영된다.** `sampling`(bool) · `tools.listChanged` · `resources.subscribe` · `resources.listChanged` · `prompts.listChanged` · `roots.listChanged` 여섯 개만 남고 나머지(`experimental` 등)는 버려진다. 실측: `{"sampling":true,"tools":{"listChanged":true},"roots":{"listChanged":false},"experimental":{...}}` → 저장 `{"sampling":true,"tools":{"listChanged":true},"roots":{"listChanged":false}}`.
3. **이 서버에는 요청 단위 접근 로그가 없다.** api에 `TraceLayer`가 없고 로컬 Caddy에도 `log` 지시자가 없다. 그래서 「Grok이 Authorization 헤더를 **보냈는지**」를 401 로그로 볼 수 없다. 판정은 **상태 전이**로 한다: `pairing_pending → detected`가 일어나면 보낸 것이고, 15분이 지나도 그대로면 안 보냈거나 값이 틀린 것이다(§2-검증). 이 한계는 #1361 acceptance의 「wrong credential failure 기록」을 §1-4의 curl 실측으로 대신 채운다.

### 1-6. 재현 커맨드

`<PAIRING_VALUE>`는 §2-A로 발급받은 1회용 값이다(성공하면 그 자리에서 죽으므로, 두 시대를 다 찍으려면 사이에 재발급한다).

```bash
EP=http://localhost:8088/v1/mcp/agent-port

# modern 2026-07-28 — server/discover
curl -s -X POST "$EP" -H "authorization: Bearer <PAIRING_VALUE>" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "io.modelcontextprotocol/clientInfo":{"name":"probe","version":"0.0.0"}}}}' | jq -c .

# legacy 2025-11-25 — initialize (버전 헤더 없이도 성립 = Grok 0.16.0 모양)
curl -s -X POST "$EP" -H "authorization: Bearer <PAIRING_VALUE>" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25",
        "capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' | jq -c .

# 실패 응답의 challenge 를 보려면 헤더까지
curl -si -X POST "$EP" -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -5
```

연결의 pairing 값 재발급은 API로도 된다(§2-C의 `$TOK`·`$CONN` 전제):

```bash
curl -s -X POST -H "authorization: Bearer $TOK" \
  "http://127.0.0.1:8080/v1/workspaces/$WS/hosted-agent-connections/$CONN/pairing-challenge/regenerate" \
  | jq -c 'del(.pairingCredential)'   # 값 자체는 절대 화면에 찍지 않는다
```

---

## §2. 1단계 — Grok 앱에 커넥터 추가 (성재)

### 2-A. oort 웹에서 연결 값 발급

1. 브라우저로 **http://localhost:8088** — `owner@oort.local`로 로그인.
2. 왼쪽 **에이전트** → 오른쪽 위 **「호스티드 에이전트 연결」**.
3. **「진행 중인 연결」**에 `Grok Bot`이 있다 → 그것을 고른다(새로 만들지 마라).
4. 3단계 **「다이얼인 기다리기」** 화면 → **「연결 값 다시 발급」**.
5. 화면이 주는 값 세 가지를 그대로 쓴다. **연결 값은 이 화면에서 딱 한 번만 보인다. 15분 뒤 만료된다.** 만료되면 4번을 다시 누르면 된다.

### 2-B. Grok 앱에 넣을 설정값

| 칸 | 넣을 값 |
|---|---|
| 원격 MCP 서버 주소 (mcp.json) | `http://localhost:8088/v1/mcp/agent-port` ← **실값. 그대로.** |
| 인증 헤더 | `Authorization: Bearer <PAIRING_VALUE>` |
| `<PAIRING_VALUE>` | **2-A 5번 화면의 「연결 값」.** `momo_pair_v1.` 로 시작하고 1회 표시·15분 TTL. 이 문서·채팅·이슈에 옮겨 적지 않는다 |
| routine 이름 | `Oort Inbox: momo Demo Workspace / Grok Bot` ← **결정적 이름. 정리(§7)가 이 이름을 찾는다** |
| routine 지시 | `oort inbox를 확인하고, 할 일이 있으면 claim한 뒤 결과를 원래 thread에 게시한다.` |

순서(위저드 Grok preset이 화면에 그대로 띄운다): Create Plugin → 비공개 플러그인 → mcp.json에 위 주소 → 인증 헤더에 연결 값 → 커넥터 설치 → 위 이름/문장으로 routine 생성 → **수동 Test run 1회**.

> 위저드가 Grok 줄에 「확인되지 않음」을 달고 있는 이유가 이 단계다. **Grok이 static Authorization 헤더를 실제로 보내는가가 이 스파이크의 존재 이유**이고, 감지가 안 되면 값이 아니라 방식이 원인일 수 있다.
> 이 방식은 **로컬에 플러그인 소스를 남긴다.** §7에서 커넥터 제거와 별개로 지워야 한다.

### 2-C. 오케스트레이터 검증

```bash
# 준비 (한 세션에 한 번). local.secrets.env 를 통째로 source 하지 마라 —
# CENTRIFUGO_ALLOWED_ORIGINS 가 따옴표 없는 공백 목록이라 셸이 뒷값을 실행하려 든다.
cd ~/projects/momo-tracks/engine
WS=00000000-0000-7000-8000-000000000001
CONN=01a01951-9f29-7500-8c5b-c7cb4640625e
EMAIL=$(sed -n 's/^MOMO_INITIAL_OWNER_EMAIL=//p' infra/rust/local.secrets.env)
PASS=$(sed -n 's/^MOMO_INITIAL_OWNER_PASSWORD=//p' infra/rust/local.secrets.env)
TOK=$(curl -s -X POST http://127.0.0.1:8080/v1/auth/login -H 'content-type: application/json' \
  -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASS" '{email:$e,password:$p}')" | jq -r .accessToken)
unset PASS   # 비밀번호는 셸 환경에 남기지 않는다

# ① 상태 전이 = "Grok이 헤더를 보냈는가"의 정본 신호
curl -s -H "authorization: Bearer $TOK" \
  "http://127.0.0.1:8080/v1/workspaces/$WS/hosted-agent-connections/$CONN" | jq -c '.connection'
#   pairing_pending → detected  이면 GREEN(§3으로)
#   그대로면 RED — 연결 값 만료(15분)인지 먼저 확인하고, 재발급 후에도 그대로면 "Grok이 static 헤더 미전송"

# ② 감지의 provenance (원문 client name은 저장되지 않는다 — presence만)
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select action, detail, created_at from audit_log where action='hosted_agent.connection.detected' order by created_at desc limit 3"

# ③ Grok이 선언한 capability의 닫힌 투영
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select status, detected_client_name, detected_capabilities from hosted_agent_connection where id='$CONN'"
#   detected_client_name 이 비어 있는 것이 정상(§1-5-1)
```

**RED 분기**: 감지가 끝내 안 오면 #1361 acceptance대로 **static 미지원 관측으로 종결**하고 OAuth 파도(#1368·#1369 + 프로덕션 OAuth AS 4 env)를 별도 편성한다. static으로 억지 downgrade 금지.

---

## §3. 2단계 — pairing 승인 (성재만 누른다)

감지되면 위저드가 4단계 **「사람이 채널과 권한 확인」**으로 넘어간다. 준비 워커가 이 화면 직전 상태까지 캡처해 두고 **승인은 누르지 않았다**(`claudedocs/e2e-prep-20260819/ux1-04-approval-step-before-approve.png`).

이 화면에서 고를 것:

- **닿을 채널**: `#agent-lab` 를 켠다(왕복 테스트 채널). `#general`은 꺼 둔다 — 고르지 않은 채널은 열리지 않는다는 것 자체가 이 스파이크의 관측 항목이다.
- **열어 줄 권한**: 「접속」은 항상 포함(끌 수 없다). **§1-3의 8툴 왕복을 하려면 최소한 inbox 읽기 · 대화 읽기 · 메시지 쓰기 · 작업(jobs) · 실행 보고(runs callback)까지 켜야 한다.** 「접속」만 켜면 `tools/list`가 빈 목록이라 routine이 할 일이 없다.
- **「이 범위로 승인」** → 5단계에서 **active credential이 한 번만 노출**된다.

그다음 **Grok 커넥터의 bearer를 pairing 값 → active credential로 교체**한다(2값 setup, ADR-0162 D6). active credential은 `momo_agent_v1.` 봉투다. **이 문서에 적지 않는다.**

> **승인만으로는 아직 `active`가 아니다.** 서버 정본(`hosted_connection.rs`)은 confirm 시점에 채널·scope·active token만 심고 상태는 `detected`로 둔다. **새 credential로 들어온 첫 유효 Agent Port 호출**이 결합을 증명해야 비로소 `status='active'`, `proved_at=now()`, `agent_profile.paused=false`가 한 트랜잭션에서 일어난다. 즉 **bearer를 교체하고 routine을 한 번 돌려야 에이전트가 깨어난다.** 교체 전에 멘션이 안 먹는 건 정상이다.

### 검증 (교체 전 → 교체 후 두 번 본다)

```bash
curl -s -H "authorization: Bearer $TOK" \
  "http://127.0.0.1:8080/v1/workspaces/$WS/hosted-agent-connections/$CONN" | jq -c '.connection'
#   교체 전: status=detected + approvedChannelIds 에 agent-lab + approvedScopes 가 고른 그대로
#   교체 후 첫 호출 뒤: status=active

docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select kind, credential_class, audience, scopes, revoked_at is null as live
     from token where hosted_connection_id='$CONN' order by created_at desc limit 5"
#   audience='/v1/mcp/agent-port' · pairing 쪽 행은 revoked · credential_class='hosted_active' 1행만 live

# proof 와 unpause 는 한 몸이다
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select hc.status, hc.proved_at is not null as proved, ap.paused
     from hosted_agent_connection hc
     join agent_profile ap on ap.agent_member_id = hc.agent_member_id
    where hc.id='$CONN'"
#   교체 전: detected | f | t      교체 후: active | t | f
```

Grok 쪽에서 `tools/list`가 **승인 scope의 부분집합**만 내는지도 이 시점에 확인한다(§1-3 표와 대조 — 8개 전부 나오면 전 scope 승인, 일부만 나오면 그 scope만 승인).

---

## §4. 3단계 — 멘션 왕복 (durable mention → hosted gateway → reply)

1. 웹에서 `#agent-lab` 채널을 열고 `@grok` 를 멘션한 메시지를 하나 보낸다(예: 「@grok 지금 몇 시야?」).
2. Grok routine을 **수동 Test run** 한 번.
3. 기대 경로: 멘션 → `hosted_agent_inbox_event` → Grok이 `oort_inbox_read` → `oort_jobs_claim` → (`oort_job_renew`) → `oort_run_event` → `oort_message_post`/`oort_run_complete` → PG → outbox → Centrifugo → 웹 화면에 답이 뜬다.

### 검증

```bash
# 멘션이 durable inbox 로 들어갔는가
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select inbox_seq, event_kind, source_channel_id, source_message_seq, created_at
     from hosted_agent_inbox_event where connection_id='$CONN' order by inbox_seq desc limit 5"

# run 수명주기 (claim/renew/complete 의 서버측 그림자)
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select id, status, step_count, started_at, finished_at
     from agent_run where agent_member_id='01a01951-9f26-7b9d-836f-7e52cc10ab32' order by created_at desc limit 5"

# 답장이 정본 쓰기경로로 들어왔는가 — seq 는 채널 단조
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select seq, author_member_id, run_id, left(coalesce(body,''), 40) as head, created_at
     from message where channel_id='00000000-0000-7000-8000-000000000202' order by seq desc limit 5"

# outbox→relay 팬아웃
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select id, kind, created_at from outbox order by id desc limit 5"
```

기록할 것: **DB `seq`/`run.id` ↔ 사용자에게 보인 reply의 redact correlation**(원문 대신 앞 40자·seq·run id로 짝짓는다). 승인하지 않은 `#general`에 `oort_message_post`를 시도하면 거절되는지도 한 번 찍어 둔다(닫힘 증명).

---

## §5. 4단계 — Routine 예약 발화 (사람이 Test run을 누르지 않은 wake)

#1361에서 **GREEN/제한을 가르는 항목**이다.

1. routine을 **Active**로 두고, 그 cadence를 기록한다(Grok UI가 보여주는 값 그대로).
2. **Test run을 누르지 않고** 기다린다. 그동안 `#agent-lab`에 `@grok` 멘션을 하나 더 남겨 둔다.
3. 예약 wake가 실제로 발화해 §4의 폐곡선을 최소 1회 완주하는지 본다.

기록: **관측된 wake latency**(멘션 시각 → inbox_seq 소비 시각) · **설정된 cadence** · **retry/failure provenance**.

```bash
# 예약 wake 감시 — 사람이 아무것도 누르지 않는 동안 새 행이 생기는지
watch -n 30 "docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  \"select inbox_seq, event_kind, created_at from hosted_agent_inbox_event \
     where connection_id='$CONN' order by inbox_seq desc limit 3\""
```

**예약 wake가 provider에서 불가능하면**: full automatic integration을 GREEN으로 두지 않고 **제품 카피를 manual-run 수준으로 제한**한다(#1361 acceptance 문장 그대로). 이건 코드 변경 goal로 따로 끊는다.

### 4-b. 재접속 / replay 실패

restart 또는 커넥터 재설치 뒤 **새 credential은 동작하고, 예전 pairing 값·stale credential은 실패**하는지 확인한다. 실패 응답은 §1-4 표와 같은 `401 invalid_token`이어야 한다.

---

## §6. 5단계 — disconnect

웹에서 해당 연결의 **「연결 해제 시작」**. 이 버튼이 하는 일과 안 하는 일이 화면에 적혀 있다 — **oort 쪽 권한을 즉시 끊을 뿐, provider에 남은 커넥터·플러그인·routine·봇은 그대로 남는다.**

### 검증 (해제 직후, 순서대로)

```bash
# 1) 서버 상태 + cleanup manifest 가 seed 됐는가
curl -s -H "authorization: Bearer $TOK" \
  "http://127.0.0.1:8080/v1/workspaces/$WS/hosted-agent-connections/$CONN" | jq -c '.'

# 2) old credential 이 죽었는가 — 어떤 툴도, 어떤 era 로도
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8088/v1/mcp/agent-port \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -H "authorization: Bearer <OLD_ACTIVE_CREDENTIAL>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
#   401 이어야 한다

# 3) 토큰 원장 — live 한 행이 0
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select count(*) from token where hosted_connection_id='$CONN' and revoked_at is null"

# 4) in-flight lease 는 갱신 실패해야 한다 (해제 시점에 잡힌 job 이 있었다면)
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select id, status, finished_at from agent_run where agent_member_id='01a01951-9f26-7b9d-836f-7e52cc10ab32' order by created_at desc limit 3"

# 5) managed fallback 0 — 해제된 에이전트에게 멘션해도 관리형 경로로 새지 않는다
docker exec oort-postgres-1 psql -U momo -d momo -tAc \
  "select count(*) from agent_run where agent_member_id='01a01951-9f26-7b9d-836f-7e52cc10ab32' and created_at > now() - interval '5 minutes'"
```

---

## §7. 6단계 — 정리 (cleanup manifest 6종)

`Active off` 하나나 UI uninstall 하나를 **전체 cleanup으로 세지 않는다**(#1344 계약). manifest가 요구하는 종류는 여섯이고, 각각 따로 증명한다:

| 종류 | 해야 할 일 | 어디서 |
|---|---|---|
| `secret` | 폐기(revoke) | oort — 해제로 자동, §6-3으로 증명 |
| `routine` | 제거 | Grok — 이름 `Oort Inbox: momo Demo Workspace / Grok Bot` |
| `connector` | 제거 | Grok — Uninstall |
| `plugin` | 제거 | Grok — 비공개 플러그인 자체 |
| `local_plugin_files` | 제거 | **이 맥의 로컬 디스크.** 커넥터 Uninstall로 안 지워진다(#1344 실측) |
| `bot` | **결정**(`deleted` 또는 `preserved_intentionally`) | Grok — 보존한 Bot/chat은 감사된 이력이지 active residual이 아니다 |

각 줄은 웹의 해제 화면에서 **본 것(status)**과 **정한 것(disposition)**을 따로 눌러 닫는다. 전부 닫힌 뒤:

```bash
curl -s -H "authorization: Bearer $TOK" \
  "http://127.0.0.1:8080/v1/workspaces/$WS/hosted-agent-connections/$CONN" | jq -c '.connection.status, .cleanupArtifacts'
#   status='disconnected' · 모든 artifact 가 acknowledged
```

Bot을 **삭제** 쪽으로 정하면 공식 문서가 말하는 *Bot 삭제 → 그 Bot 소유 routine cascade*를 live로 확인하되, **커넥터/로컬 파일은 별도로 검사**한다(cascade가 거기까지 간다는 문서가 없다).

---

## §8. 규율 (그대로 유지)

- 유료 구독 미구매 · billing 변경 없음 · 실계정/비프로덕션 워크스페이스만.
- provider secret/identifier 비유입 — pairing 값·active credential·Grok 계정 식별자는 **어떤 산출물에도** 남기지 않는다.
- Grok private API 리버스·roster scraping 금지.
- **#1361은 이 문서로 close하지 않는다.** 본편은 성재+오케스트레이터 세션이고, 관측 결과는 `research/2026-08-16-grok-e2e-observation.md`(패킷이 지정한 자리)로 따로 적는다.
- 관측이 서버 결함이나 카피 제한을 요구하면 **별도 goal**로 끊는다 — 이 스파이크 안에서 고치지 않는다.

## §9. 준비 산출물 위치

- 화면 캡처 7장: `claudedocs/e2e-prep-20260819/` — 에이전트 허브 · 연결 탭(감지됨) · 위저드 재개 picker · **승인 직전 4단계** · Grok preset 1단계 · pairing 2단계(값 가림) · 3단계 재발급 버튼. 레포에 커밋하지 않는다(로컬 증거).
- dual-era 실측 원문: 이 문서 §1이 정본. 재현 커맨드는 §2-C·§6의 curl 그대로.
