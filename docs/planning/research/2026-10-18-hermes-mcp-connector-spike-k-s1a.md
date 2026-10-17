# K-S1a 실측: 로컬 Docker Hermes + 모의 MCP 커넥터 동작 (#3942)

작성 2026-10-18 · 근거 ADR-0203 증보 K4·K5·K6 · 계획 ID K-S1a · 코드 변경 0(기록만)
표기: [V] 이번 세션에서 직접 실행해 관찰 · [소스] 이미지 안 소스를 읽어 확인(실행 안 함) · `runtime-unverified` 못 잼

## 0. 요약

| # | 질문 | 결론 |
|---|---|---|
| 1 | 토큰 저장 경로 | [V] `/opt/data/mcp-tokens/<server>.json`(토큰), `<server>.client.json`(DCR 등록), `<server>.meta.json`(AS 메타데이터), `<server>.json.refresh.lock`. 디렉터리 0700, 파일 0600, 소유자 `hermes`(uid 10000). 추정이 맞았어요 |
| 2 | `mcp-*` 자동 포함 | [V] 켜져요. `platform_toolsets`를 건드리지 않은 `api_server`에 설정된 MCP 서버 도구가 자동으로 붙어요. 서버 도구는 `mcp__<server>__<tool>` 이름이고 레지스트리 toolset은 `mcp-<server>`예요. `agent.disabled_toolsets` 24종 잠금은 MCP를 막지 않아요. `GET /v1/toolsets`에는 `mcp-*`가 **나오지 않아요**(내장 목록만) |
| 3 | 붙여넣기·기기 로그인 | [V] 브라우저 흐름은 컨테이너 안에서 인증 URL을 출력하고 stdin에서 리디렉션 URL 한 줄을 받아요. 기기 흐름(RFC 8628)도 동작해요 |
| 4 | 쓰기 승인 | [V] 스트리밍에서만 `approval.request` SSE가 와요. 대기 상한 300초(초과 시 거부로 닫힘). 비스트리밍은 즉시 거부 |
| 5 | 갱신 실패 감지 | [V] **API 신호 없음.** 로그 문장과 도구 결과 문구뿐이에요(아래 §5) |
| 6 | 한도·연결 차단 | [V] 429와 503이 구분되지 않는 같은 오류 문구로 와요. 서버 불통은 15초 뒤 `Connection closed` |

## 1. 구성 [V]

- 이미지: `nousresearch/hermes-agent@sha256:36099926…c2919`(v0.22.2, arm64). 컨테이너 3개 `k3942-hermes`(1 CPU, 2 GB, 포트 127.0.0.1:18643→8642), `k3942-model`(OpenAI 호환 대본 스텁), `k3942-mcp`(모의 MCP, 127.0.0.1:18644). 전용 네트워크 `k3942-net`, 볼륨 `k3942-data`. 실제 API 키·바깥 연결 없음. 끝난 뒤 컨테이너·볼륨·네트워크를 모두 지웠어요(남은 `k3942-` 0개).
- 대본 스텁: 사용자 문장 `CALL:<tool> <json>`을 tool_call로 돌려주고, 도구 결과를 응답 본문에 되돌려요(이전 Hermes 잠금 시험 `claudedocs/resume-2026-09-23/hermes/mock_model.py`를 재사용).
- 모의 MCP: 스트리머블 HTTP(`POST /mcp` JSON 응답), 읽기 도구 `get_note`(`readOnlyHint: true`)와 쓰기 도구 `create_note`(주석 없음). OAuth 2.1 AS를 같은 서버에 둠: RFC 9728 보호 리소스 메타데이터, RFC 8414 AS 메타데이터, RFC 7591 DCR, 인가 코드+PKCE(S256), refresh 회전, 기기 승인(RFC 8628). 제어 면(`/ctl/set`)으로 토큰 TTL·refresh 거부·도구 상태코드를 강제했어요.
- Hermes 설정: ADR-0203 D6 잠금 24종 + `approvals.mode: manual`·`unattended_mode: deny` + `mcp_servers.mock {url, auth: oauth, trust: untrusted}`. `lockgate.py`(부팅 전 게이트)는 쓰지 않았어요. 참고: 기존 게이트는 `mcp_servers`가 비어 있어야 통과하므로 커넥터를 켜는 구현에서는 게이트 규칙을 바꿔야 해요.

## 2. 토큰 경로 [V]

`hermes mcp login mock` 뒤 `/opt/data/mcp-tokens/`:

| 파일 | 내용 |
|---|---|
| `mock.json` | `access_token`, `refresh_token`, `expires_in`, `expires_at`, `scope`, `token_type`, `hermes_issuer` |
| `mock.client.json` | DCR 결과(`client_id`, `redirect_uris`, `token_endpoint_auth_method`) |
| `mock.meta.json` | AS 메타데이터 사본 |
| `mock.json.refresh.lock` | 갱신 중복 방지 잠금 |

`/opt/data` 볼륨 하나에 같이 있으므로 D7(볼륨 = 비밀 저장소) 설명이 그대로 맞아요. 소스상 `mcp-tokens/`는 대시보드 파일 API가 통째로 거부하는 목록에 들어 있어요 [소스].

## 3. toolset 기본값 [V + 소스]

- 로그인 전에는 `OAuthNonInteractiveError`로 서버가 「parked」되어 도구가 안 붙어요(게이트웨이 로그, 아래 §5). 로그인 후 게이트웨이를 재시작하거나 자동 재탐색(§5)을 기다리면 붙어요.
- 붙은 뒤 모델에게 보이는 도구: `memory`, `tool_search`, `tool_describe`, `tool_call`. MCP 도구는 **지연(deferred) 카탈로그**에 있고 `tool_search`가 카탈로그를 설명문에 싣고 `tool_call`로 호출해요. 읽기 호출 `tool_call{name: mcp__mock__get_note}`는 모의 서버에서 실행되어 결과가 돌아왔어요.
- 소스(`hermes_cli/tools_config.py` `_merge_mcp_servers`): 사용 설정된 모든 MCP 서버를 기본으로 합치고, `platform_toolsets`의 `no_mcp`가 있으면 전부 끄며, 서버 이름을 명시하면 그 서버만 써요. 이름은 **서버 이름**(`mock`)이에요 [소스]. 서버별 도구 허용 목록 키는 실행해 보지 않았어요: `runtime-unverified`.
- 결과: ADR-0203 증보 「`mcp-*`가 자동으로 드는지」는 **든다**가 답이에요. 읽기 전용만 열려면 서버 `trust`와 도구 `readOnlyHint`(§4)에 기대거나 도구 허용 목록을 따로 써야 해요.

## 4. 쓰기 승인 (H-S2) [V]

조건: `trust: untrusted` 서버의 `readOnlyHint` 없는 도구 호출.

| 경로 | 결과 |
|---|---|
| `POST /v1/chat/completions` 비스트리밍 | 즉시(0.0초) 거부. 로그 `Elicitation requested in gateway session … but no notify_cb is registered — failing closed`. 도구는 서버에서 실행되지 않음 |
| 같은 요청 `stream: true` | SSE 이벤트가 옴(아래). 응답 전까지 서버가 10초마다 `: keepalive` 주석을 보냄 |

스트림 이벤트 순서:

1. `data:` 첫 델타(`role: assistant`)
2. `event: hermes.tool.progress` `{tool, toolCallId, status: "running"}`
3. `event: approval.request` — 필드: `command`(사람이 읽는 문장), `description`, `pattern_key: "mcp_elicitation"`, `pattern_keys`, `request_id`, `event`, `run_id`(= chat completion `id`), `timestamp`, `session_id`, `choices: ["once","session","always","deny"]`
4. 응답 후 `hermes.tool.progress {status: "completed"}` → 최종 델타 → `[DONE]`

응답: `POST /v1/runs/{run_id}/approval` 본문 `{"choice": "once"|"deny"|…, "request_id": "<위 값>"}` → `200 {"object":"hermes.run.approval_response","resolved":1}`. 같은 Bearer 키를 써요. 응답 가능한 클라이언트 판정은 별도 규칙이 없고 **스트리밍으로 연결되어 있느냐**(알림 콜백 등록)가 전부예요.

- `once` → 모의 서버에서 `create_note` 실행됨(서버 로그 `tool_exec`).
- `deny` → 실행되지 않음. 도구 결과: `The user did not approve running write-capable MCP tool 'create_note' on untrusted server 'mock'. The command was NOT run. Do not retry without explicit user direction.`
- **대기 상한 300.0초**(응답 없이 둔 스트림이 정확히 300.0초에 거부 결과로 끝남, 연결은 정상 종료). 기본값 `approvals.timeout`=300 [소스]. 설정 키 변경은 실행하지 않았어요: `runtime-unverified`.
- `approvals.unattended_mode: deny`는 이 경로를 막지 않아요. 그 키는 위험 명령 게이트용이고 MCP 쓰기 동의는 위처럼 스트리밍 여부로 갈려요 [V, 소스].
- 읽기 도구(`readOnlyHint: true`)는 승인 없이 실행돼요.
- oort 함의(C-S4): worker는 비스트리밍으로는 쓰기를 못 하고, **SSE + `approval.request` → 카드 → `POST /v1/runs/{run_id}/approval`** 이 필요해요. 300초 안에 사람이 못 답하면 거부로 닫히므로 카드의 만료를 300초 이하로 잡고, 만료 뒤 답은 `409 approval_not_pending`로 올 걸로 보세요(이 코드는 소스에서 확인, 만료 뒤 호출은 실행하지 않음: `runtime-unverified`). D5(chat/completions SSE 호출)는 바꿀 필요 없어요. `/v1/runs` 이전은 불필요해요. 승인 이벤트는 chat completions 스트림에도 나와요.

## 5. 로그인과 갱신 실패

### 5.1 로그인 형식 (질문 3) [V]

`docker exec -i -u hermes … hermes mcp login mock`(TTY 없음; root로 실행하면 토큰이 root 소유가 되므로 `-u hermes`):

- 브라우저 흐름: 헤드리스로 감지되어 `Open this URL in your browser:`에 인가 URL을 출력하고 **stdin에서 한 줄**을 기다려요. 붙여넣는 값은 리디렉션 전체 URL, 또는 `?code=…&state=…` 부분이면 돼요(`skip`이면 포기).
- 인가 URL의 `redirect_uri`는 **`http://127.0.0.1:<임의 포트>/callback`**(관찰: `:27890`)이고 DCR에도 이 값이 등록돼요. 리디렉션 뒤 브라우저는 연결 오류를 보이는데, 주소창 URL을 복사해 붙이면 끝나요. `oauth.redirect_port`로 포트를 고정할 수 있어요 [소스]. 사전 등록 클라이언트(`client_id`/`client_secret`)를 쓰면 DCR을 건너뛰어요 [소스].
- K-S1b 입력: 오너의 GCP 클라이언트에 등록할 리디렉션 URI는 `http://127.0.0.1:<고정 포트>/callback` 형식이에요(데스크톱/루프백 유형이면 포트 무관). 값은 `redirect_port`로 정해요.
- 기기 흐름(`--flow device` 또는 `oauth.flow: device`): AS 메타데이터에 `device_authorization_endpoint`가 있어야 해요. 출력 `open <verification_uri> on any device. Code: <user_code>` 후 `interval`마다 `/token`을 폴링(`authorization_pending` 4회 뒤 승인), 끝나면 `Authenticated — 2 tool(s)`. DCR 요청에 `grant_types: [device_code, refresh_token]`, 자리표시 `redirect_uris: 127.0.0.1:8420`이 담겨요. Google이 이 흐름을 어떤 범위에서 허용하는지는 K-S1b 몫이에요.
- 두 흐름 모두 로그인 프로세스는 별도 프로세스라 **실행 중인 게이트웨이는 바로 알지 못해요.** 게이트웨이를 재시작하면 즉시 붙고, 재시작 없이도 서버가 parked 상태에서 약 300초 주기로 자동 재탐색해서 붙었어요(재로그인 뒤 4분 30초 만에 `revived`) [V].

### 5.2 갱신 (질문 5) [V]

| 상황 | 동작 |
|---|---|
| 로컬 만료 시각이 지났고 refresh 정상 | 도구 호출 때 `/token` refresh 한 번 후 호출 성공. 모델·사용자에게 보이지 않음 |
| refresh 거부(`invalid_grant`) | `Token refresh failed: 400` → 재탐색 → 서버가 「parked」. 호출은 약 15초 뒤 `MCP call failed: MCPError: Connection closed`. 이후 도구가 카탈로그에서 사라져 `'mcp__mock__get_note' is not a known tool name`으로 바뀜 |
| 서버가 토큰을 먼저 무효화(로컬 만료 전) | refresh를 시도하지 않고 곧바로 인가 흐름으로 가서 위와 같은 parked 결말 [V] |

**감지 신호 결론: 구조화된 신호는 없어요.** `GET /health/detailed`와 `/v1/capabilities`에는 MCP 항목이 없고(health는 `ok` 유지, 응답에 `mcp` 문자열 없음), `/v1/toolsets`도 변하지 않으며, 도구 결과는 일반 `MCPError` 문구예요. 남는 신호:

1. 로그 문장(컨테이너 stdout과 `/opt/data/logs/agent.log`, WARNING 이상은 `errors.log`에도). `gateway.log`에는 **안 남아요**(ADR 증보의 「gateway.log에만」은 이 버전에서 부정확):
   - `WARNING tools.mcp_oauth_manager: Token refresh failed: 400`
   - `WARNING tools.mcp_tool: MCP server '<name>' hit a permanent error, parking without retries; will self-probe every 300s (state: connected → parked): OAuthNonInteractiveError: MCP OAuth requires browser authorization …`
   - 회복: `MCP server '<name>': revived — session healthy again after parking`
2. 도구 결과 문자열 `MCP call failed: MCPError: Connection closed`(≈15초 지연)와 이후 `is not a known tool name`.
3. 능동 프로브: `tool_search` 카탈로그나 읽기 도구 한 번 호출. 토큰이 죽으면 위 둘 중 하나로 보임.
4. CLI `hermes mcp test <name>`은 `✗ Connection failed … The server rejected the sign-in. Run: hermes mcp login <name>`을 내지만 종료 코드가 0이라 코드로 못 믿어요(컨테이너 exec 필요).

oort 쪽 문장 결정: 「벤더 로그인 만료」는 위 3(읽기 도구 능동 프로브)이나 2의 두 문구를 근거로 **추정**해서 띄우는 상태예요. 확정 신호가 아니므로 문구를 「로그인이 만료됐을 수 있어요, 다시 연결해 주세요」처럼 단정하지 않는 형태로 두고, 사용자의 재연결(`hermes mcp login`)로만 해소돼요. 정확한 감지는 Hermes 쪽 변경이나 로그 수집(Railway 로그)에 기대야 해요. 이 결론이 K-S1b의 7일 만료 시험(Testing 앱)에도 그대로 적용돼요.

## 6. 한도·불통 (질문 6) [V]

| 주입 | 도구 결과 |
|---|---|
| MCP POST가 429(`Retry-After` 포함) | `MCP call failed: MCPError: Server returned an error response`(0.00초, 재시도 없음) |
| 503 | 같은 문구(429와 구별 불가) |
| 서버 정지 | 15초 대기 후 `MCP call failed: MCPError: Connection closed`(세션 만료 재연결 1회 시도 뒤) |

HTTP 상태코드·`Retry-After`가 oort까지 전달되지 않아요. 한도와 불통을 구분할 수 없고, 사용자 문구는 「지금 연결에 문제가 있어요」 하나로 충분해요. 벤더 방화벽이 바깥 연결을 막는 경우는 서버 정지와 같은 모양이 되어요(별도 실행하지 않음: `runtime-unverified`). 참고: 서버를 다시 띄우면 모의 서버의 토큰 메모리가 사라져 같은 인증 실패 경로로 들어갔어요(실서버에는 해당 없음).

## 7. 못 잰 것 (`runtime-unverified`)

- 실제 Google·GitHub·Slack MCP와의 로그인·범위(K-S1b).
- `approvals.timeout` 변경 효과, 만료 뒤 응답 시 응답 코드, `platform_toolsets: no_mcp`와 서버별 도구 허용 목록 키(소스만 확인).
- 비스트리밍 `/v1/responses`·`/v1/runs` 경로의 승인.
- Railway 환경(네트워크·로그 수집·볼륨 권한); arm64 로컬에서만 실행(Railway는 amd64).
- 벤더가 바깥 연결을 차단할 때의 오류 모양(불통 시험으로 대체 관찰).

## 8. 재현

모의 서버와 하네스는 레포에 넣지 않았어요(코드 변경 0). 구성은 §1이 전부이고, 모의 MCP는 stdlib만으로 약 200줄이에요. 컨테이너 기동 방식은 `claudedocs/resume-2026-09-23/hermes/run_arm.sh`와 같아요(시작 명령이 ENTRYPOINT를 바꾸고 `HERMES_CONFIG_B64`로 설정 주입).
