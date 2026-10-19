# Hermes 로그인 중계 실측: provider 로그인(Codex·Claude)과 MCP 앱 로그인을 oort 화면에서 (#4073, #4074)

작성 2026-10-19 · 근거 ADR-0203 증보 「Hermes 로그인 중계」(Proposed, 같은 PR) · ADR-0004 · 선행 `2026-10-18-hermes-mcp-connector-spike-k-s1a.md`, `2026-10-19-hermes-google-connector-spike-k-s1b.md` · 코드 변경 0(기록만)
표기: [V] 이번 세션에서 직접 실행해 관찰 · [소스] 이미지 안 소스를 읽어 확인(실행 안 함) · `runtime-unverified` 못 잼

## 0. 요약

| # | 질문 | 결론 |
|---|---|---|
| 1 | oort가 부르는 8642 포트(`api_server`)에 로그인 API가 있나 | [V][소스] **없어요.** 라우트는 chat·responses·runs·sessions·jobs 등뿐이에요(§2.1). 로그인 관련 관리 API는 전부 **대시보드 프로세스**(`hermes dashboard`, 9119)에 있어요 |
| 2 | Codex 로그인을 원격에서 시작하고 끝낼 수 있나 | [V] **있어요.** 대시보드 `POST /api/providers/oauth/openai-codex/start`가 `verification_url`(`https://auth.openai.com/codex/device`)과 `user_code`를 돌려주고 `poll/{session_id}`로 끝을 알아요. **기기 코드 흐름이라 사용자가 붙여넣을 것이 없어요**(§3) |
| 3 | Claude 로그인은 | [V][소스] 대시보드 API는 **일부러 막혀 있어요**(`flow: external`, `400 anthropic uses an external CLI`). CLI `hermes auth add anthropic --type oauth --no-browser`만 되고, 인가 URL을 출력한 뒤 stdin에서 `code#state` 한 줄을 받아요(§4) |
| 4 | MCP 앱 로그인은 | [V] 대시보드 `POST /api/mcp/servers/{name}/auth`가 인가 URL을 돌려주고 `GET /api/mcp/oauth/callback/{name}?code&state`가 끝내요. CLI `hermes mcp login <name>`은 인가 URL 출력 + stdin 한 줄이에요. **Google은 둘 다 `initialize`·`tools/list`만 보는 경로라 401이 안 와서 시작이 안 돼요**(#4067의 이유 그대로). `mcp_login_probe.py` 방식이 필요해요(§5) |
| 5 | 대시보드를 oort가 직접 부를 수 있나 | [V] **안 돼요.** 루프백에서는 세션 토큰이 인증 없는 `GET /` HTML에 박혀 나오고, 루프백이 아니면 비밀번호/OAuth 로그인 쿠키가 필요해요. 어느 쪽도 「oort가 가진 키 하나」 모양이 아니에요. 게다가 같은 프로세스가 MCP 서버 추가(stdio 명령 포함)·설정 쓰기를 열어요(§6) |
| 6 | 그래서 | 로그인 중계 **사이드카(후보 b)** 가 필요해요. 모양은 「Hermes 컨테이너 안의 작은 프로세스, `hermes` CLI를 자식 프로세스로 구동, stdin/stdout만 중계」예요. CLI 중계를 [V]로 끝까지 돌렸어요(§7) |
| 7 | 토큰이 중계 채널에 보이나 | [V] 자식 프로세스 출력 전체에 토큰·code 값이 **0바이트**였어요(§7) |

## 1. 구성 [V]

- 이미지: `nousresearch/hermes-agent@sha256:36099926…c2919`(v0.22.2, arm64, K-S1a와 같은 digest). 컨테이너 `hermes-4073`(1 CPU, 2 GB, `127.0.0.1:18673→8642`), 전용 네트워크 `hermes-4073-net`, 볼륨 `hermes-4073-data`. 설정은 `HERMES_CONFIG_B64`로 주입(D6 잠금 3종 + `approvals`·`telemetry`·`updates`), 모델·MCP 비밀 없음.
- 대시보드는 컨테이너 안에서 `hermes dashboard --no-open --skip-build --port 9119`로 직접 띄웠어요(루프백). 공식 이미지에서는 s6 서비스 슬롯이 있지만 **`HERMES_DASHBOARD=1`이 아니면 꺼져 있어요** [소스 `/etc/s6-overlay/s6-rc.d/dashboard/run`].
- 모의 MCP: stdlib만 약 60줄(OAuth 2.1 보호 리소스 메타데이터·AS 메타데이터·DCR·`/token`·`/mcp`). `initialize`부터 401을 내고, `/token`이 `MOCK-ACCESS-TOKEN-4073`·`MOCK-REFRESH-TOKEN-4073` 표식 값을 발급해서 「토큰이 어디에 보이는지」를 잴 수 있게 했어요. 레포에 넣지 않았어요(§9).
- **벤더 접속**: Codex 시작 한 번만 실제 `auth.openai.com`에 나갔어요(기기 코드 발급. 로그인하지 않고 바로 취소). Anthropic은 인가 URL을 출력하는 데서 멈췄고 `claude.ai`에 접속하지 않았어요. 실제 로그인·토큰 발급은 0건이에요.

## 2. Hermes의 두 서버 [V + 소스]

### 2.1 게이트웨이 `api_server`(8642) — oort가 지금 부르는 쪽

`gateway/platforms/api_server.py` 라우트 표를 읽었어요 [소스]: `/health`, `/health/detailed`, `/v1/models`, `/v1/capabilities`, `/api/model/options`, `/v1/chat/completions`, `/v1/responses`, `/v1/runs…`(`approval`·`steer`·`stop`), `/v1/skills`, `/v1/toolsets`, `/api/sessions…`, `/api/jobs…`, `/v1/browser-control/*`, `/v1/artifacts/*`, `/api/platforms/{platform}/events`. **로그인·인증·MCP 관리 라우트는 없어요.** `/api/model/options`는 모델 목록 조회이고 로그인을 시작하지 않아요(호출은 하지 않았어요: `runtime-unverified`).

### 2.2 대시보드(9119) — 관리 API가 있는 쪽

| 용도 | 라우트 | 인증 |
|---|---|---|
| provider 목록·상태 | `GET /api/providers/oauth` | 없음(읽기). 응답에 `token_preview`(끝 몇 글자)가 있어요 |
| provider 로그인 시작 | `POST /api/providers/oauth/{id}/start` | `_require_token` |
| provider 로그인 상태 | `GET /api/providers/oauth/{id}/poll/{session_id}` | **없음**(`account_email` 포함) |
| 취소 | `DELETE /api/providers/oauth/sessions/{session_id}` | 토큰 |
| 붙여넣기(코드 제출) | `POST …/{id}/submit` | 토큰. 모든 provider에서 `400 submit not supported`(코드는 비어 있는 자리) |
| MCP 서버 목록·추가·교체·삭제 | `GET/POST/PUT/DELETE /api/mcp/servers…` | 토큰(목록 GET은 인증 없음) |
| MCP 로그인 시작 | `POST /api/mcp/servers/{name}/auth` | 토큰 |
| MCP 로그인 상태·취소 | `GET/DELETE /api/mcp/oauth/flows/{flow_id}` | 토큰 |
| MCP 로그인 콜백 | `GET /api/mcp/oauth/callback/{name}?code&state` | **없음**, 대신 `state`가 맞아야 해요 |

그 밖에 설정·`.env`·파일·세션·cron·채팅 라우터가 같은 프로세스에 있어요 [소스 `web_routers/`].

## 3. Codex: 기기 코드 흐름을 원격에서 [V]

`POST /api/providers/oauth/openai-codex/start`(루프백 토큰 헤더)의 응답(`user_code` 값은 가렸어요):

```
{"session_id":"<22자>","flow":"device_code","user_code":"<가림>","verification_url":"https://auth.openai.com/codex/device","expires_in":900,"poll_interval":5}
```

- `poll/{session_id}` → `{"status":"pending", "expires_at":…, "account_email":null, …}`. 로그인하지 않았으니 `pending`이 끝이에요. 승인 뒤 상태(`approved` 등)는 소스상 확인했고 실행하지 않았어요: `runtime-unverified`.
- `DELETE …/sessions/{id}` → `{"ok":true}`. 취소로 폴링 스레드가 멈추도록 소스에 주석이 있어요.
- CLI도 같아요: `hermes auth add openai-codex --type oauth --no-browser`가 `Open this URL: https://auth.openai.com/codex/device` + `Enter this code: XXXX-XXXX`를 출력하고 「Waiting for sign-in」으로 기다려요. 기본이 기기 코드 흐름이고 `--browser`를 줘야 `localhost:1455` 콜백 흐름이에요.
- **함의**: 사용자는 URL을 열고 **화면에 보이는 코드를 벤더 페이지에 입력**해요. 돌아온 주소를 붙여넣을 일이 없고, oort가 받는 비밀이 없어요(`user_code`는 화면에 표시하는 값이고 토큰 교환에는 쓰이지 않지만, **본 사람이 자기 계정으로 승인하면 Hermes가 그 계정에 묶이는 값**이라 민감하게 다뤄야 해요. 교환용 `device_auth_id`는 Hermes 안에만 있어요). 이번 묶음에서 ADR-0004와 부딪히지 않는 유일한 흐름이에요.
- 로그인 뒤 토큰 위치는 `auth.json`(Hermes 인증 저장소, `/opt/data/auth.json`)과 풀(pool)이에요 [소스 `hermes_cli/auth.py` 머리말]. 로그인 상태의 비밀 아닌 확인은 `hermes auth status openai-codex` → `openai-codex: logged out (No Codex credentials stored. …)` [V].
- 못 잰 것: 승인 뒤 **돌고 있는 게이트웨이가 재시작 없이 새 자격을 쓰는지**, `model.provider: openai-codex`를 누가 설정에 쓰는지(§8 3번).

## 4. Claude: CLI만, 코드 붙여넣기 [V + 소스]

- 대시보드: `POST /api/providers/oauth/anthropic/start` → `400 {"detail":"anthropic uses an external CLI; run `hermes auth add anthropic` manually"}` [V]. 소스 주석 [소스 `web_server_oauth.py`]: 「Deliberately flow == "external": an in-dashboard Connect button would let a scriptable HTTP endpoint mint Claude Pro/Max subscription tokens outside Anthropic's own client, against its OAuth usage policies.」 — **Hermes 쪽이 스스로 HTTP로 노출하지 않기로 한 흐름**이에요. 이 점은 §10에 owner 결정 거리로 올렸어요.
- CLI: `hermes auth add anthropic --type oauth --no-browser`(stdin이 파이프) [V]가 `Authorize Hermes with your Claude Pro/Max subscription.` 뒤에 인가 URL(`https://claude.ai/oauth/authorize?code=true&client_id=<Claude Code의 공개 client>&redirect_uri=https://console.anthropic.com/oauth/code/callback&scope=…&code_challenge=…&state=…`)을 출력하고 `Authorization code:`에서 stdin을 읽어요. 입력이 끝나면(EOF) `Anthropic OAuth login did not return credentials.`로 종료해요.
- 붙여넣는 값은 URL이 아니라 `code#state` 형식이에요 [소스 `agent/anthropic_credentials.py:792-800`]: `#`로 쪼개 뒤쪽을 `received_state`로 보고 `!=`이면 `OAuth state mismatch — possible CSRF, aborting`. 즉 **state 검증은 Hermes 쪽에 있어요**(상수 시간 비교는 아니에요 — 로컬 프로세스 안의 비교라 실질 위험은 없다고 봐요 [추정]).
- 인가 URL의 `redirect_uri`가 벤더 페이지(`console.anthropic.com`)라서 사용자는 거기서 보이는 코드를 복사해 붙여넣어요. 로컬 포트 리디렉션이 없어요.
- 못 잰 것: 실제 승인 뒤 토큰 저장 위치·형식, 만료·갱신.

## 5. MCP 앱 로그인 [V]

모의 서버로 두 경로를 끝까지 돌렸어요.

**대시보드 경로** (`POST /api/mcp/servers/mock/auth` → 인가 URL → 콜백):

| 단계 | 관찰 |
|---|---|
| 시작 | 200, `status: authorization_required`, `authorization_url`에 `state`·`code_challenge`(S256)·`resource`, `redirect_uri=http://localhost:9119/api/mcp/oauth/callback/mock`(요청의 호스트 기준) |
| 잘못된 `state`로 콜백 | 404 `OAuth flow expired`, 흐름은 그대로 `authorization_required` |
| 맞는 `state`로 콜백 | 200 `Authorization received`, 약 4초 뒤 흐름 `approved`. `/token` 요청에 `code_verifier` 있음(PKCE), `mcp-tokens/mock.json`(0600) 생성 |
| 같은 콜백 다시 | 404 (한 번 쓴 흐름은 후보에서 빠져요) |

- 이 경로의 `redirect_uri`는 `oauth.redirect_uri` 설정으로 바꿀 수 있어요 [소스 `web_routers/mcp.py:295`]. 설정을 써서 바꾸는 시험은 하지 못했어요(컨테이너에 PyYAML이 없어 편집이 실패했어요): `runtime-unverified`. Google에 미리 등록한 `http://127.0.0.1:4182x/callback`(K-S1b)을 쓰려면 이 값이 필요하므로 구현 첫 단계에서 확인해야 해요.
- `_run_dashboard_mcp_oauth`는 `_probe_single_server`를 부르고, 이는 `initialize`와 `tools/list`(·prompts·resources)만 해요(`call_tool` 호출 0) [소스]. 토큰이 안 생기면 `The server responded, but no OAuth token was obtained — this provider may require a manually-registered OAuth client.`를 내요. **이것이 K-S1b가 `mcp_login_probe.py`를 만든 이유 그대로**라, Google 세 서버(인증 없이 `initialize`·`tools/list`가 통과)는 대시보드 경로로 시작되지 않을 거라고 봐요 [추정 — 대시보드 경로로 Google을 시도하지 않았어요: `runtime-unverified`].
- 이 경로는 흐름이 성공하면 `_save_mcp_server`로 **`config.yaml`을 다시 써요** [소스]. Railway 시작 명령이 부팅마다 `HERMES_CONFIG_B64`로 덮어쓰고 잠금 게이트(`lockgate.py`)가 `mcp_servers`를 검사하는 구조와 부딪혀요.

**CLI 경로** (`hermes mcp login mock`, 아래 §7의 프로토타입으로 구동): 인가 URL을 출력하고 「paste the redirect URL here (or the ?code=…&state=… portion)」에서 stdin 한 줄을 받아요. 붙인 URL의 `state`를 일부러 틀리게 했더니 `✗ Authentication failed: State parameter mismatch: WRONGSTATE != <진짜 state>`로 끝나고 토큰 파일이 생기지 않았어요 [V]. 맞는 값이면 `✓ Authenticated — 1 tool(s) available`.

## 6. 대시보드를 직접 부르면 안 되는 이유 [V + 소스]

1. **인증이 네트워크 경계가 아니에요.** 루프백 모드의 세션 토큰은 인증 없는 `GET /` 응답 HTML(`__HERMES_SESSION_TOKEN__="…"`)에 들어 있어요 [V]. 루프백이 아닌 바인드는 「반드시 인증 provider(비밀번호 또는 OAuth)가 있어야」 하고 [소스, 비루프백 실행은 하지 않았어요] `HERMES_DASHBOARD_INSECURE`는 무시돼요 [소스 s6 `dashboard/run`]. 둘 다 oort 서버가 키 하나로 부르는 모양이 아니에요(쿠키 세션 로그인).
2. **표면이 커요.** 같은 프로세스가 설정·`.env`·파일·세션·cron·채팅과 `POST /api/mcp/servers`를 열어요. http 서버 추가는 [V]로 실행했고, stdio `command` 포함 = 임의 프로세스 실행은 모델 정의(`MCPServerCreate.command`)를 읽은 [소스]예요(실행하지 않았어요). s6 스크립트 주석이 「unauthenticated public dashboards were the entry point for the MCP-config persistence campaign」이라고 적어요. ADR-0203 D6(도구 잠금)·lockgate와 정면으로 충돌해요.
3. **상태가 메모리에 있어요.** 로그인 흐름이 모듈 전역 dict에 있어(`_oauth_sessions`, `_mcp_oauth_flows`) 프로세스가 재시작되면 사라져요. 흐름 TTL: Codex 900초, MCP 콜백 대기 300초.
4. **무게.** 대시보드 프로세스 RSS 약 320 MB(게이트웨이 약 276 MB와 별개) [V]. 2 GB급 Railway Hermes에서 상시 켜 둘 이유가 없어요.
5. 읽기 라우트 `poll/{session_id}`는 인증이 없고 `account_email`을 돌려줘요. 대시보드를 외부에 열면 세션 id만 알면 이메일이 보여요.

## 7. CLI를 자식 프로세스로 중계하기 [V]

사이드카의 핵심 동작을 컨테이너 안에서 파이썬 40줄로 시험했어요(`relay_proto.py`, 레포 밖): `hermes mcp login mock`을 자식 프로세스(stdin/stdout 파이프)로 띄우고, 출력에서 첫 URL을 정규식으로 찾고, 그 URL의 `state`로 「브라우저 주소창에 남았을 URL」(`http://127.0.0.1:27890/callback?code=FAKECODE&state=…`)을 만들어 stdin에 한 줄 쓰고, 종료를 기다려요.

| 시험 | 결과 |
|---|---|
| 맞는 state | 종료 코드 0, `✓ Authenticated`, `mcp-tokens/{mock.json,mock.client.json,mock.meta.json}` 생성. 모의 `/token`에 `code_verifier` 있음 |
| 틀린 state | `State parameter mismatch`, 토큰 파일 없음(`mock.client.json`만) |
| **중계 채널의 토큰 표식** | 캡처한 자식 출력 전체에 `MOCK-ACCESS-TOKEN`·`MOCK-REFRESH-TOKEN`·`FAKECODE` 포함 여부 **모두 False**(0바이트). 토큰은 `/opt/data/mcp-tokens/`에만 있어요 |

- **완주한 것은 모의 MCP의 `hermes mcp login` 하나뿐이에요.** Codex는 CLI가 URL+코드를 출력하고 기다리는 데까지, Claude는 URL 출력과 EOF 종료까지만 봤어요. 세 로그인이 모두 「URL 출력 → (선택) stdin 한 줄 → 종료 코드」 모양이라 같은 방식으로 다룰 수 있을 것으로 보지만 이것은 **추정**이고, `mcp_login_probe.py`의 출력도 재지 않았어요(`runtime-unverified`). `skip` 입력으로 포기할 수 있고, 프로세스를 죽이면 취소돼요.
- 완료 확인은 비밀 아닌 신호로 해요: 종료 코드 0, `hermes auth status <provider>`(문장), `/opt/data/mcp-tokens/<server>.json` 존재(`mcp_config._oauth_tokens_present`). 토큰 파일 내용은 읽지 않아요.
- 불일치 오류 문구는 진짜 `state` 값을 출력해요(`State parameter mismatch: <붙인 값> != <진짜 state>`). `state`는 비밀이 아니지만 자식 출력은 영구 보관하지 않고 로그에 쓰지 않아야 하는 이유예요. Claude 불일치 때 출력에 `code`가 섞이는지는 재지 않았어요.
- 못 잰 것: Claude CLI의 승인 뒤 동작, 자식 프로세스가 TTY 없이 돌 때의 Codex 대기 시간 상한(출력은 「press Ctrl+C to cancel」까지 확인), 동시에 둘이 시작할 때의 파일 잠금.

## 8. 못 잰 것 (`runtime-unverified`)

1. 실제 벤더 승인 뒤 전부(Codex·Claude 토큰 저장·갱신·만료, Google MCP 토큰). 이번 범위 밖이에요(인가 주소 생성까지만).
2. 대시보드 `oauth.redirect_uri` 설정 효과, 대시보드 경로의 Google 시도, `submit` 라우트(소스상 항상 400).
3. 승인 뒤 **돌고 있는 게이트웨이가 모델 provider 자격을 재시작 없이 집는지**와 `model.provider`/`model.default` 설정의 소유자. `hermes config set model.provider openai-codex`가 있어서 CLI로 쓸 수는 있으나, Railway 부팅이 `config.yaml`을 `HERMES_CONFIG_B64`로 덮어쓰므로 **설정 템플릿이 provider를 정해야** 해요(구현 이슈에서 정해요). MCP는 K-S1a에서 약 300초 자동 재탐색을 봤어요.
4. Railway 환경(내부 DNS, 시작 명령에서 사이드카 동시 기동, 로그), amd64.
5. `/api/model/options` 응답 모양.
6. `hermes auth status`의 로그인된 상태 문구(logged out만 봤어요), 로그인 중계 시 CLI가 `config.yaml`을 쓰는지, Hermes 자체 로그(`/opt/data/logs/`)에 인가 URL·code가 남는지(진단 번들·로그 뷰어가 읽는 범위 포함), `mcp_login_probe.py`의 출력.

## 9. 재현과 정리

- 시작 방식은 K-S1a와 같아요(`claudedocs/resume-2026-09-23/hermes/run_arm.sh`: 시작 명령이 ENTRYPOINT를 대체하고 `HERMES_CONFIG_B64`로 설정 주입). 대시보드는 `docker exec -u hermes … hermes dashboard --no-open --skip-build`. 루프백 토큰은 `curl localhost:9119/`의 HTML에서 읽어 `X-Hermes-Session-Token` 헤더로 보냈어요(값은 출력하지 않았어요).
- 모의 MCP(`mock_mcp.py`)·중계 프로토타입(`relay_proto.py`)은 레포에 넣지 않았어요. 구현 이슈가 테스트 하네스로 새로 만들어요.
- 정리: 컨테이너 `hermes-4073`, 볼륨 `hermes-4073-data`, 네트워크 `hermes-4073-net`을 모두 지웠고 남은 `4073` 이름은 0개예요. 다른 워커의 컨테이너는 건드리지 않았어요.

## 10. 이 실측이 ADR 증보에 넘기는 것

1. Codex는 **붙여넣기 없는 기기 코드 흐름**이라 oort를 지나가는 비밀이 없어요 → ADR-0004 증보 6(#4071)의 「코드를 중개하지 않는다」와 충돌하지 않아요.
2. Claude와 MCP 앱은 **일회용 인가 code가 붙여넣기로 oort를 지나가요.** 이것은 #4071의 「구독 OAuth 토큰(access·refresh·코드)을 중개하지 않는다」 문장의 「코드」와 부딪혀요. 코드는 Hermes 안에만 있는 PKCE `code_verifier` 없이는 교환이 안 되는 값이지만, 문장을 어기는 건 사실이라 ADR에서 **좁은 예외**를 owner가 정하게 했어요(증보 Q1).
3. Claude는 Hermes 자신이 HTTP 노출을 거부한 흐름이에요(§4). 사이드카로 노출하는 것이 그 의도와 어떻게 다른지, 약관 판단은 운영자 몫이라는 #4071 문장이 이를 덮는지는 owner 결정이에요(증보 Q2).
4. 대시보드는 쓰지 않고 사이드카가 CLI를 중계해요. 사이드카는 Railway에서 **같은 컨테이너 안의 프로세스**여야 해요(볼륨이 서비스별 — ADR-0203 D7 [V, Railway README]). compose에서는 같은 볼륨을 공유하는 별도 컨테이너도 가능해요.

## 11. 결정 반영 (2026-10-19)

§10의 Q1(code 통과)은 **허용**, Q2(Claude 중계)는 **중계함**, Q3는 **설치 스크립트가 켬**(#4072가 `HERMES_LOGIN_RELAY_KEY` 자동 생성, 키 없으면 꺼짐)으로 확정됐어요. 근거 문장은 ADR-0203 「증보 2026-10-19 — Hermes 로그인 중계」의 「owner 결정」과 ADR-0004 증보 7이에요.
