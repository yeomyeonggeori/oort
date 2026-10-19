# K-S1b 실측: Railway Hermes + Google 공식 원격 MCP 읽기 시험 준비 (#3952)

작성 2026-10-19 · 근거 ADR-0203 증보 K3·K5·K7 · 앞선 기록 `2026-10-18-hermes-mcp-connector-spike-k-s1a.md`
표기: [V] 이번 세션에서 직접 실행해 관찰 · [문서] 벤더 문서로 확인(실행 안 함) · `runtime-unverified` 못 잼
**상태: 서비스·설정 배포 완료, 브라우저 동의(성재 1회)는 아직이에요.** 그 뒤에 닫히는 항목은 §6에 따로 모았어요.

## 0. 요약

| # | 질문 | 결론 |
|---|---|---|
| 1 | 서비스 | [V] oort-team(production)에 `hermes-kwak` 새 서비스. 공식 이미지 v0.22.2 digest 고정, 볼륨 `/opt/data`(`mcp-tokens/` 유지), 공개 도메인 0, 1 replica, 1 vCPU/2 GB, oort 비밀 참조 0. 부팅 게이트 `LOCKGATE ok`, `LOCKREPORT ok` |
| 2 | 기기 흐름(device) | [문서] **못 써요.** Google 기기 흐름 허용 스코프는 openid·email·profile·`drive.appdata`·`drive.file`·YouTube뿐이고 클라이언트 유형도 「TV 및 입력 제한 기기」만이에요. `gmail.readonly`·`drive.readonly`·`calendar.*`는 허용 목록에 없어요. (AS 메타데이터에는 `device_authorization_endpoint`가 있지만 스코프가 막혀요.) 붙여넣기(redirect URL) 로그인만 남아요 |
| 3 | `hermes mcp login`이 그대로 되나 | [V] **안 돼요.** Google MCP는 `initialize`·`tools/list`를 인증 없이 받고 `tools/call`에서만 401을 줘요. Hermes `mcp login`은 401이 와야 OAuth를 시작하므로 「no OAuth token was obtained」만 내고 끝나요. 그래서 `infra/hermes/mcp_login_probe.py`를 썼어요(§3) |
| 4 | 붙여넣기 로그인 모양 | [V] 인가 URL을 출력하고 stdin에서 한 줄을 받아요. `redirect_uri=http://127.0.0.1:<고정 포트>/callback`(서버마다 41821·41822·41823), 사전 등록 client라 DCR·CIMD를 건너뛰어요 |
| 5 | 실제 도구 이름 | [V] 세 서버 모두 인증 없이 `tools/list`가 돼서 로그인 전에 확정했어요(§4) |
| 6 | 갱신 토큰 수명(Internal) | `runtime-unverified` — 로그인 뒤 재야 해요(§6) |

## 1. 만든 것 [V]

- 서비스 `hermes-kwak`(oort-team/production). 이미지 `nousresearch/hermes-agent@sha256:36099926…c2919`. 볼륨 `/opt/data`. 재시작 ON_FAILURE 3회, sleep 끔, healthcheck 없음. 공유 변수·참조 변수 0, 공개·사용자 정의 도메인 0.
- 변수 이름(값은 기록하지 않아요): `API_SERVER_ENABLED/HOST/PORT/KEY`, `HERMES_CONFIG_B64`, `HERMES_LOCKGATE_B64`, `HERMES_LOGIN_PROBE_B64`, `OORT_COHOSTED_AGENT_CONNECTOR_APPS`(게이트 규칙 1), `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`. 모델 키(`ANTHROPIC_API_KEY`)는 **아직 없어요**(성재 몫). 키 없이도 게이트·로그인은 돼요(로컬 시험).
- client 값은 설정 파일에 없고 서비스 변수에서 `${GOOGLE_OAUTH_CLIENT_ID}` 보간으로 읽어요(Hermes `mcp_tool_config._interpolate_env_vars`). 설정 파일 base64는 비밀이 아니에요.
- 설정: `infra/hermes/google-connectors.config.yaml`(기준 사본). 24종 잠금 + `mcp_servers.{gmail,google_calendar,google_drive}` 모두 `trust: untrusted`, `sampling.enabled: false`, `tools.resources/prompts: false`, 읽기 도구만 `tools.include`, `oauth.scope`는 읽기 스코프만.
- 앱 id(oort와 1:1 목록): `com.momo.plugins.gmail`, `com.momo.plugins.google-calendar`, `com.momo.plugins.google-drive`(ADR-0113 표의 Google Drive 신규 id. 기존 `com.momo.plugins.drive`와 다른 앱이에요).

## 2. 게이트 시험 [V]

로컬(같은 이미지)에서 `lockgate.py gate`: 이 설정 → exit 0. `tools.resources`를 `true`로 바꾸면 세 서버 모두 exit 3(「must be explicitly false」). Railway 배포에서도 `LOCKGATE ok=true`, `disabled_count=24`, `LOCKREPORT` 6개 검사 모두 true. 단위 시험 `python3 -m unittest infra/hermes/test_google_connector_config.py`가 쓰기 도구·쓰기 스코프·client 리터럴을 각각 막는지 하나씩 깨 봤어요(3건 모두 FAIL로 잡힘).

## 3. 로그인이 안 되던 세 가지와 우회 [V]

로컬 Hermes에 이 설정을 넣고 실제 Google 엔드포인트(더미 client)로 재현했어요.

1. **401이 안 와요**: 위 표 3번. `mcp_login_probe.py`는 같은 Hermes OAuth provider(같은 client·`redirect_port`·`/opt/data/mcp-tokens`)로 읽기 호출 하나(`list_labels`/`list_calendars`/`list_recent_files`)를 해서 401을 일으켜요.
2. **issuer 불일치**: Google 보호 리소스 메타데이터는 `authorization_servers: ["https://accounts.google.com/"]`(끝 슬래시), AS 메타데이터 issuer는 `https://accounts.google.com`이라 MCP SDK의 엄격 비교가 `Authorization server metadata issuer mismatch`로 끝나요. 스크립트가 이 실행에서만 끝 슬래시를 무시해요.
3. **스코프가 넓어져요**: SDK가 `oauth.scope`를 서버가 광고한 스코프로 덮어써요(Gmail은 `mail.google.com/`·`gmail.modify` 포함). 스크립트가 config의 읽기 스코프로 고정해요. 확인한 인가 URL의 스코프: Gmail `gmail.readonly`, Calendar `calendar.calendarlist.readonly`·`calendar.events.freebusy`·`calendar.events.readonly`, Drive `drive.readonly`.

Railway에서 같은 방식으로 인가 URL 출력까지 확인했고(`skip` 입력), 그 URL을 GET하면 Google이 로그인 화면으로 302해요(`invalid_client` 같은 즉시 오류 없음). 동의 이후는 `runtime-unverified`예요.

주의: 게이트웨이가 돌 때 토큰이 만료돼 다시 인가가 필요해지면 같은 issuer 불일치로 재탐색이 실패해 서버가 parked 될 수 있어요(런타임 경로에는 우회가 없어요). 갱신(refresh)은 저장된 토큰 엔드포인트로 가서 이 비교를 거치지 않을 걸로 보지만 `runtime-unverified`예요.

## 4. 도구 이름 [V] (2026-10-19, 인증 없는 `tools/list`)

| 서버 | 읽기(`readOnlyHint: true`) = `tools.include` | 쓰기(넣지 않음) |
|---|---|---|
| gmail | `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `list_labels` | `create_draft`, `label_*`/`unlabel_*`, `apply_sensitive_*_label`, `trash_*`/`untrash_*`, `mark_*_spam`/`unmark_*_spam`, `update_message_labels`, `create_label` |
| google_calendar | `list_events`, `get_event`, `list_calendars`, `suggest_time`, `search_events` | `create_event`, `update_event`, `delete_event`, `respond_to_event` |
| google_drive | `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `read_file_content`, `search_files` | `copy_file`, `create_file` |

벤더 문서의 Gmail 읽기 목록에 `get_draft`가 빠져 있었고 실제 응답에는 있어서 넣었어요. `readOnlyHint`는 서버의 자기 보고이므로 1차 방어는 허용목록이에요(ADR-0203 K4).

## 5. oort 쪽 준비(실행 안 함)

oort `api` 서비스 env에 선언 세 개가 필요해요(현재 `api`·`agent-worker`에 `HERMES_*`·`OORT_COHOSTED_*`·`AGENT_PROVIDER_*` 변수 이름이 하나도 없어요 [V, 이름만 읽음]):
`OORT_COHOSTED_AGENT_TOOLS_LOCKED=1`, `OORT_COHOSTED_AGENT_CONNECTORS_LOCKED=1`, `OORT_COHOSTED_AGENT_CONNECTOR_APPS=<§1의 세 앱 id>`. 켜기 409 순서(`connector_trial_not_cohosted` → `attest` → `shared` → `members` → `apps`) 때문에 이것만으로는 켜지지 않아요: ① 팀 인스턴스에서 Hermes를 `hermes-kwak`에 연결(`HERMES_BASE_URL` 등 oort 쪽 env + 연결), ② 세 앱이 플러그인 registry 행이고 성재의 활성 grant가 있어야 해요. **레포 `server/Fixtures/plugin-manifests/`에는 `drive`·`github`·`linear`·`notion`만 있고 gmail·google-calendar·google-drive 매니페스트가 없어요** — 이 시험의 「커넥터 시험 켜기」는 그 매니페스트가 등록되기 전에는 `409 connector_trial_apps`로 막혀요(planner 몫).

## 6. 남은 것 (`runtime-unverified`)

- 동의 후 토큰 저장·`tools/call` 성공, Desktop 유형 client가 Google MCP에서 통하는지(문서는 「Web application + AI-powered agent 체크」를 요구해요. Desktop은 문서 밖이라 `access_blocked`/`invalid_client`가 날 수 있어요 — 나면 Web client를 만들고 redirect URI 3개를 `http://127.0.0.1:4182x/callback`으로 등록해요).
- Gmail 문서는 스코프로 `gmail.readonly`+`gmail.compose`를 말해요. 읽기 도구가 `readonly`만으로 되는지 확인 전이에요.
- Internal 앱 갱신 토큰 수명: 로그인한 날을 적고 8일 뒤 재확인해요(7일에 죽으면 External·Testing이라는 뜻).
- Workspace 관리자의 restricted 스코프 허용 필요 여부(동의 화면에서 `admin_policy_enforced`가 나오는지).
- 회수 순서 실연(oort 끄기 → 타사 앱 액세스 해제 → `mcp-tokens/` 삭제)은 로그인이 있어야 가능해요.
- ADR-0203 증보 red proof 7(oort 응답·로그·감사에 벤더 secret·토큰 0): oort를 켠 뒤.
- 리전: 서비스는 `asia-southeast1-eqsg3a`로 지정했는데 볼륨 인스턴스 조회가 `us-west2`로 나와요. 배포는 성공했고 볼륨은 마운트됐어요. 지연 영향은 이 시험에서 의미 없어요.
