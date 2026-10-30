# ADR-0203: 같은 프로젝트(동일 호스트) 에이전트 감지 — 운영자가 한 번 클릭으로 Hermes를 연결

- Status: **Accepted** (2026-10-16. 방향 결재 세 건과 질문 1~7 위임 결재는 「owner 결정」에 원문 인용)
- Date: 2026-10-16
- Deciders: 성재
- 기안: Opus 5.5 worker (#3874)
- 관계: ADR-0004(+증보 5: egress 가드 — Hermes provider 경계), ADR-0147(+증보 2026-10-16 「에이전트별 키 고정」 = #3873, **아직 머지 전**), ADR-0101(에이전트 = 1급 멤버), ADR-0162(Agent Port), ADR-0198(구독 정책), ADR-0201(팀 AI 빠른 길), ADR-0100
- 증보: **2026-10-16 1인 워크스페이스의 커넥터 호스트로서의 Hermes** (성재 결재 「각자 + 1인 워크스페이스에서 Hermes 시험 (추천)」) — 파일 끝. D6 도구 잠금 목록을 커넥터 시험에 한해 넓히고, D7 볼륨 목록에 `mcp-tokens/`를 더하고, 「단일 워크스페이스」를 안내에서 서버 강제로 올린다. D1~D5·D8·D9는 바뀌지 않는다. 구현은 본문과 같이 #3873 뒤다(로컬 실측 K-S1a 제외). 같은 날 저녁 결재 「개인 Gmail 외부 앱」은 2026-10-17 결재 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」가 대체했고, K3·K5·K7에 반영했다. Google 시험은 dawn.kim의 Developer Preview 가입·OAuth client 준비(ADR-0113 증보 2 G-S0) 뒤에 시작한다. 2단계(쓰기 중계)는 Proposed다.
- 증보(**Accepted** 2026-10-19, 통합자): **2026-10-19 설치 한 번에 Hermes까지** (#4072, 성재 2026-10-19 「제로 베이스 온보딩 개선 묶음도 진행」) — 파일 끝. D8을 구현 이름으로 확정하고, 생성기의 `HERMES_*`·로컬 opt-in·`OORT_COHOSTED_AGENT_TOOLS_LOCKED` 자동 주입과 Railway 카탈로그의 `hermes` 서비스를 더한다. D6-5 attest의 의미가 번들 배포 모양에 한해 바뀐다. D1~D5·D7·K1~K7은 바뀌지 않는다.
- 증보: **2026-10-19 Hermes의 모델 인증에 구독 OAuth 허용**(#4071, owner 결정) — Hermes가 자기 볼륨에 Codex·Claude 구독 OAuth를 보관해 모델 인증에 쓴다. 파일 끝. D1~D9는 바뀌지 않는다.
- 증보(**Accepted** 2026-10-20, owner 승인 인용): **2026-10-20 같은 서버 Hermes의 모델 고르기** (#4143) — 파일 끝. 핀에 Hermes 제공자(`provider`)와 모델을 한 쌍으로 저장하고, 서버가 Hermes `/api/model/options`의 「로그인된 제공자」 목록 안으로 선택을 제한하며, 워커가 `/v1/chat/completions`에 둘을 함께 보낸다. D2의 고정 요청 목록에 읽기 GET 하나가 늘고, migration 144가 핀 표에 열 두 개를 더한다. D1·D3~D9·K1~K7은 바뀌지 않는다.
- 증보(**Accepted** 2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」): **2026-10-25 환경 사실 읽기(platform·loginRelay)와 호스팅 제안 문구** (#4336, 온보딩 r2 R2-00) — 파일 끝. 운영자 전용 상태 읽기(`GET …/cohosted-agent`)에 닫힌 열거형 `environment{platform, loginRelay}`를 더하고, 「선언 없음」에서 운영자에게 계획 표시 카드를 여는 것까지 정한다. D1의 마지막 문장(「아무것도 보이지 않는다」)만 좁혀지고, 나머지 D·K·A·L·M과 D2의 요청 목록은 바뀌지 않는다. 구현은 #4337·#4338·#4339·#4340과 새 이슈(제안 카드 등)다.
- 증보(**Accepted** 2026-10-26, owner 결정 「권장으로 승인」 — 시크릿 출력 범위가 옵트인 한정으로 넓어진다): **2026-10-25 Railway 생성기의 Hermes 공유 변수 출력(옵트인), A4′** (#4461, 온보딩 r2 R2-11) — 파일 끝. 옵트인 플래그(`--platform railway --with-agents`)가 있을 때만 T2 stdout에 정본 키 집합 밖의 공유 변수 둘(`HERMES_API_KEY`·`HERMES_LOGIN_RELAY_KEY`)을 새로 만들어 더한다. A4의 「정본 키 집합에 넣지 않고 T2 stdout 불변」 중 「운영자가 손으로 만든다」와 `self_host_env.sh:277-278`(T2와 `--with-agents` 동시 금지)만 이 옵트인 경로에 한해 바뀌고, 기본 출력은 바이트 단위로 같다. 카탈로그의 서비스·변수·compose·서버는 바뀌지 않는다. D·K·A1·A2·A5·L·M·F(F3 마지막 항·F6 railway 계획 문구 제외)는 바뀌지 않고, A3의 「출력에 값을 내지 않는다」는 이 증보가 Accepted된 뒤 T1(compose 파일 경로) 한정으로 읽는다.
- 역방향: 2026-10-25 D6(Hermes 도구 잠금)은 [ADR-0210](0210-host-ops-team-box-shell-curated-install.md)(#4347)이 바꾸지 않는다. 팀 박스는 Hermes와 별개의 컴퓨터이고 Hermes 컨테이너(`/opt/data`)에는 셸을 붙이지 않으며 Hermes `terminal` 백엔드를 박스로 향하게 하지 않는다. 본문 결정은 바꾸지 않았다.
- 역방향: 2026-10-25 A4′(Accepted 2026-10-26)는 [ADR-0184](0184-platform-neutral-agent-driven-selfhost.md) D3의 「정본 키에서만」을 옵트인 경로에 한해 좁힌다. Accepted 전에는 0184 본문을 고치지 않고, Accepted 뒤 구현 이슈가 D3에 한 줄 역참조를 더한다. 10-25 증보(#4336)의 「바뀌지 않는 것」이 적은 A4 불변은 그 증보 시점의 서술이고, A4′가 Accepted되면 A4의 해당 문장은 이 절이 대체한다.
- 표기: [V] 직접 확인(저장소 코드·문서 또는 이 세션에서 받은 공식 문서 원문) · **[추정]** 해석·계산 · [확인 필요] 구현 전 확인 · `runtime-unverified` 실행 안 함. 이 문서는 설계이고 코드·인프라를 바꾸지 않았다.

## 맥락

### 풀려는 문제
성재 목표는 「간단한 요청은 1분 안에, 에이전트에게 직접 시키듯」이다(ADR-0201). Railway 팀 인스턴스에서 운영자가 Hermes를 **같은 Railway 프로젝트 안**에 서비스로 올리면, oort가 그 Hermes를 스스로 알아보고 「연결할까요?」를 한 번 물을 수 있다. 지금은 운영자가 `HERMES_BASE_URL`·`HERMES_API_KEY` 같은 env를 손으로 맞추고 설정 화면에서 링크를 만들어야 한다.

### 지금 있는 것 [V]
- ADR-0004 본문: oort는 Codex/OpenAI OAuth 토큰·원본 API 키를 받지도 저장하지도 않는다. oort가 Hermes에 건네는 것은 **불투명 bearer(`HERMES_API_KEY`)** 뿐이고, 호출은 OpenAI 호환 `/v1/chat/completions` SSE다. 비루프백 평문 `http://`는 기본 거부이고, 운영자 opt-in은 `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` + `AGENT_PROVIDER_LOCAL_HOSTS`(정확 일치, 와일드카드·suffix 금지)다(ADR-0004 증보 2026-09-08 D2·D3).
- ADR-0147 증보: 연결 가드(`momo-egress`)는 **운영자가 쓴 호스트(`HERMES_BASE_URL`의 호스트)** 와 로컬 옵트인 호스트만 주소 검사에서 면제한다(`EgressPolicy::host_exempt`). 워크스페이스 관리자가 개인 키로 그 호스트를 겨냥하는 것은 거절된다.
- `PLATFORM_ADMIN_EMAILS`: 서버 `config.rs`가 쉼표 분리·소문자화로 읽는 인스턴스 운영자 목록이다.
- compose에 `profiles:`는 현재 `huddle`(livekit·huddle-notifier)뿐이다 [V, `infra/rust/docker-compose.rust.yml`]. **`agents` 프로파일은 아직 없다** — 이 ADR이 제안하는 새 것이다. `agent-worker` 서비스는 `host.docker.internal:host-gateway`로 호스트의 provider를 부른다(SELF_HOST 「호스트 provider」 절).
- Railway 가이드(`infra/railway/README.md`)는 서비스 간 통신을 `<service>.railway.internal`로 하고, 볼륨은 서비스별이라고 적는다 [V].
- 형제 작업 #3873(**미머지, 이 ADR은 머지됐다고 주장하지 않는다**): 새 테이블 `agent_provider_pin` + `PUT/GET /v1/workspaces/{ws}/agents/{agent}/provider-pin`(운영자 전용). kind `operator_env` = `HERMES_BASE_URL` env 링크로 고정하며 팀의 DB Anthropic 키와 독립이다. 이 ADR의 「연결」 클릭이 그 PUT을 부른다. 계약이 바뀌면 이 ADR의 D4를 맞춘다. [확인 필요: #3873 머지 뒤 경로·필드명]

### 공식 Hermes Agent 문서에서 확인한 사실 [V, 2026-10-16 받음]
출처는 모두 `https://hermes-agent.nousresearch.com/docs/…` 페이지 원문이다.
1. **API 서버 env**(`/docs/user-guide/features/api-server`): `API_SERVER_ENABLED`(기본 `false`), `API_SERVER_HOST`(기본 `127.0.0.1`, 「localhost only by default」), `API_SERVER_PORT`(기본 `8642`), `API_SERVER_KEY`(필수), `API_SERVER_CORS_ORIGINS`(기본 없음), `API_SERVER_MODEL_NAME`. 같은 설정은 `config.yaml`의 `gateway.api_server:`(`enabled`·`port`·`host`·`key`·`cors_origins`·`model_name`·`max_concurrent_runs`)에도 있고 **env가 config.yaml보다 우선**한다.
2. **인증**: 모든 요청은 `Authorization: Bearer <API_SERVER_KEY>`. 문서는 「`API_SERVER_KEY`는 루프백 기본 바인드를 포함해 모든 배포에서 필요하다」고 적는다.
3. **엔드포인트**: `GET /health`(그리고 `GET /v1/health`), `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`. `GET /health/detailed`도 있다. [확인 필요: `/health`가 bearer 없이 열리는지 — 「The public /health」 문구가 있으나 문맥을 끝까지 읽지 못했다. 프로브는 bearer를 붙여 보내므로 어느 쪽이든 동작한다.]
4. **도구 노출 경고**(같은 페이지 Security 절 원문): 「The API server gives full access to hermes-agent's toolset, including terminal commands.」 **API 서버 자체에는 도구를 줄이는 스위치가 없다.** 문서가 말하는 방법은 플랫폼별 도구 구성이다.
5. **플랫폼 toolset**(`/docs/reference/toolsets-reference`): API 서버가 쓰는 toolset 이름은 `hermes-api-server`이고, 「Drops clarify, text_to_speech, computer_use, and the kanban tools. Keeps everything else」, 즉 **터미널·코드 실행·브라우저가 그대로 남는다**. 개별 toolset 이름: 터미널 = `terminal`(도구 `terminal`, `process_manage`), 코드 실행 = `code_execution`(도구 `execute_code`), 브라우저 = `browser`(`browser_*` 도구 묶음). 참고로 `hermes-webhook`은 「only `web_search`, `web_extract`, `vision_analyze`, and `clarify`」인 제한 집합이다.
6. **전역 끄기 키**(`/docs/user-guide/configuration`, 「Global Toolset Disable」): `agent.disabled_toolsets:` 아래에 이름을 나열한다. 원문 「This applies after per-platform tool config (`platform_toolsets` written by `hermes tools`), so a toolset listed here is always removed — even if a platform's saved config still lists it.」 예시는 `memory`·`web`. toolsets-reference는 `disabled_toolsets: [browser]`를 언급한다. 따라서 끄는 키는 **`agent.disabled_toolsets: [terminal, code_execution, browser]`** 이다. [확인 필요: `file`·`delegation`·`cronjob`·`computer_use`·`process_manage`까지 막아야 하는지 — 아래 D6 목록은 보수적 제안이며, 정확한 이름은 같은 toolsets-reference 표에서 구현 때 한 번 더 대조한다.]
7. **승인 모드**(`/docs/user-guide/security`): `approvals.mode: smart | manual | off`, `approvals.unattended_mode: deny | approve`(webhook/API 세션이 위험 명령에 부딪혔을 때 기본 `deny`). `HERMES_YOLO_MODE=1`은 모든 승인을 끈다. 승인 모드는 **도구를 끄는 것의 대체물이 아니다** — 도구가 켜져 있으면 승인 판정에 기대게 된다.
8. **Docker**(`/docs/user-guide/docker`): 모든 상태는 `/opt/data` 한 디렉터리(호스트 `~/.hermes`)에 있다. 내용: `.env`(API 키·시크릿), `config.yaml`, `SOUL.md`, `sessions/`(대화 기록), `memories/`, `skills/`, `home/`, `cron/`, 그리고 세션 SQLite `state.db`. 컨테이너 안에서 API 서버를 열려면 `API_SERVER_ENABLED=true`, **`API_SERVER_HOST=0.0.0.0`**, `API_SERVER_KEY`를 설정한다(문서 예시). 포트는 8642.
9. 문서에 **이름이 없어서 만들지 않은 것**: API 서버 전용으로 도구를 끄는 단일 env 변수, `API_SERVER_HOST`에 `::`(IPv6) 값을 쓸 수 있다는 명시, Railway 배포용 공식 가이드, 「/opt/data 전체 삭제」 외의 데이터 삭제 절차. 이 셋은 [확인 필요]다.

### Railway 사실 [V, `https://docs.railway.com/networking/private-networking/how-it-works` 받음]
- 내부 DNS 이름은 `<service-name>.railway.internal` 형태다. 각 environment는 격리된 자기 네트워크를 가진다.
- 「New environments (created after October 16, 2025): DNS names resolve to both internal IPv4 and IPv6 addresses」, 「Legacy environments: DNS names resolve to IPv6 addresses only」.
- 같은 문서의 라이브러리 설정 절은 듀얼스택/IPv6 전용 환경에서 라이브러리 설정이 필요할 수 있다고 하며, 예로 mongod를 `--bind_ip ::,0.0.0.0`로 띄운다.
- 따라서 **바인딩 선택은 environment 생성 시점에 달렸다**: 레거시(IPv6 전용)면 서버가 `::`에 바인드해야 내부 이름으로 닿고, 신규 환경이면 `0.0.0.0`도 된다. 가장 안전한 쪽은 **`::`(듀얼스택이 켜진 리눅스에서 IPv4도 받음)** 이다 [추정 — 커널 `bindv6only` 설정과 Hermes(Python 서버)가 `::` 문자열을 받아 주는지는 [확인 필요]; 위 9번처럼 Hermes 문서가 `::`를 명시하지 않는다]. 구현 첫 단계에서 실제 Railway 환경 하나로 `0.0.0.0`과 `::` 둘을 시험해 한 값을 확정한다(`runtime-unverified`).

## 결정 (초안)

### D1. 감지는 「운영자가 선언한 한 호스트」만 본다
- 감지 입력은 **서버 env 한 줄**이다. 운영자가 co-hosted 에이전트의 주소를 선언해야 oort가 본다. 이름 후보: `OORT_COHOSTED_AGENT_URL`(예 `http://hermes.railway.internal:8642/v1`). **`HERMES_BASE_URL` 재사용 여부는 owner 질문 Q1** — 추천은 **재사용**(이미 `host_exempt`·ADR-0004 증보 5가 이 변수의 호스트에 묶여 있어 새 면제 경로를 만들지 않는다). 새 변수를 만들면 `host_exempt` 대상에 두 번째 입력이 생겨 ADR-0147 egress 규율이 넓어진다.
- 내부망을 **훑지 않는다**. 후보 이름을 추측하지 않는다(`hermes.railway.internal`을 기본값으로 찍어 보지 않는다). Railway API 토큰을 oort에 저장하지 않으며 Railway API를 부르지 않는다. 운영자가 선언한 호스트가 없으면 이 기능 전체가 꺼진 상태이고 아무것도 보이지 않는다.
- 선언된 호스트가 공개 주소면 기존 규칙대로 HTTPS여야 한다. `*.railway.internal`·사설 주소의 평문 `http://`는 ADR-0004 증보 2026-09-08의 운영자 opt-in(`AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` + `AGENT_PROVIDER_LOCAL_HOSTS`에 **정확한 호스트 이름**)을 그대로 요구한다. 새 와일드카드(`*.railway.internal`)는 만들지 않는다.

### D2. 프로브는 한 번, 한정된 두 요청
- 운영자가 감지 화면을 열 때(또는 「다시 찾기」 클릭) 서버가 **`GET /health`와 `GET /v1/models` 두 요청만** 보낸다. 백그라운드 폴링·부팅 시 자동 프로브는 없다.
- 호출은 기존 봉인 크레이트 `momo-provider-probe` 경로를 쓴다(ADR-0147 D: 같은 `EgressPolicy`, 연결 시점 resolver, redirect 없음, 프록시 없음, hop당 시간 상한 10초). `Authorization: Bearer`로 `HERMES_API_KEY`를 붙이되 응답 본문·헤더 문자열은 크레이트 밖으로 내지 않고, 분류 결과(`ok`·`rejected`·`unreachable`·`unknown`)와 모델 개수만 UI에 낸다.
- **프로브가 증명하는 것**: 그 주소에 OpenAI 호환 서버가 살아 있고 키가 맞다. **증명하지 못하는 것**: 그 Hermes가 도구를 껐는지(D6), 누가 소유하는지, 공개 주소가 있는지. `/v1/models`의 응답에는 toolset 정보가 없다. (`GET /v1/toolsets`가 있다고 문서가 적지만 [V, api-server 페이지] 그것은 서버가 응답하는 자기 보고일 뿐이라 증거로 삼지 않고, 쓸지는 Q4.)

### D3. 화면과 권한 — 인스턴스 운영자 한 번 클릭
- 온보딩 또는 설정 › AI 연결에서, 프로브가 `ok`일 때만 「같은 서버의 Hermes를 찾았어요, 연결할까요?」 카드를 보인다. `unreachable`이면 아무 카드도 보이지 않거나 「주소를 확인해 주세요」 한 줄(소음 최소).
- 카드는 **인스턴스 운영자(`PLATFORM_ADMIN_EMAILS`)** 에게만 보이고 그만 누를 수 있다. 워크스페이스 관리자는 보지 못한다(운영자 네트워크로의 SSRF·권한 확대 방지, ADR-0147 증보와 같은 이유). 누구나 눌 수 있게 넓히는 것은 Q3.
- 카드에는 **도구 잠금 확인 상태**(D6)를 함께 보인다. 잠금 확인이 없으면 버튼은 비활성이다.

### D4. 「연결」 클릭이 하는 일
1. `member.kind='agent'` 1급 멤버로 Hermes 에이전트를 만든다(ADR-0101). 이름 기본값 「Hermes」, 운영자가 바꿀 수 있다.
2. #3873의 `PUT /v1/workspaces/{ws}/agents/{agent}/provider-pin`을 kind `operator_env`로 호출해 그 에이전트를 `HERMES_BASE_URL` env 링크에 고정한다. 팀의 DB Anthropic 키와는 **독립**이다. [확인 필요: #3873 머지 전이므로 요청·응답 필드는 그쪽 계약이 정본]
3. **자동 권한 부여는 없다.** 채널 참여·hosted 채널 grant·도구 grant는 하지 않는다. 운영자가 평소처럼 에이전트를 채널에 초대하고, 쓰기 같은 액션은 ADR-0186 승인 카드 경로로만 간다.
4. 클릭은 감사 행을 남긴다(누가·어느 호스트(자격 제거한 레이블)로·언제). 시크릿은 쓰지 않는다.
5. 연결 해제 = 에이전트 제거 + pin 삭제. Hermes 서비스와 볼륨은 oort가 건드리지 않는다(D7).

### D5. 이 연결이 고르는 경로와 맞지 않는 것
- oort가 Hermes를 부르는 길은 ADR-0004의 **agent-worker SSE**(OpenAI 호환)다. Hermes 게이트웨이 네이티브 플랫폼 경로(`docs/external-agent-provider/hermes-gateway-native-platform.md`)는 이 ADR 범위 밖이다.
- Railway 프로젝트를 넘어서는 호스트(다른 프로젝트의 Hermes)는 「같은 프로젝트」가 아니므로 감지 대상이 아니다. 운영자가 `HERMES_BASE_URL`을 수동으로 쓰는 기존 길은 그대로다.

### D6. Hermes 도구 잠금 요건 (연결 전 필수) — 성재 결정 「같은 프로젝트·도구 끔」
같은 프로젝트에 올리되 아래를 **모두** 만족해야 한다.
1. **터미널·코드 실행·브라우저 도구 끔.** Hermes `config.yaml`에 `agent.disabled_toolsets`로 최소 `terminal`, `code_execution`, `browser`를 넣는다 [V: 키 이름 출처 위 6번]. API 서버가 쓰는 `hermes-api-server` toolset이 이 셋을 기본으로 포함하므로 [V, 위 5번] 아무 설정도 하지 않으면 켜져 있다. `file`·`delegation`·`cronjob`·`process_manage`·`computer_use`를 함께 끌지는 Q4에서 정한다 [확인 필요].
2. **oort 비밀값을 Hermes에 주지 않는다.** Hermes 서비스의 env에는 `API_SERVER_KEY`와 모델 provider 키만 둔다. `DATABASE_URL`·`WORKER_DATABASE_URL`·`PROVIDER_LINK_MASTER_KEY`·oort JWT 키 등은 **Railway shared variable 참조로 걸지 않는다**. Railway 변수는 서비스별이라 명시적으로 넣지 않으면 가지 않는다 [추정].
3. **공개 도메인을 열지 않는다.** Hermes 서비스에 Railway generated/custom domain을 붙이지 않고 `.railway.internal`로만 닿게 한다.
4. `API_SERVER_KEY`는 길고 무작위여야 하고(문서 예시는 `openssl rand -hex 32`), `API_SERVER_CORS_ORIGINS`는 비운다. 승인 설정은 `approvals.mode`를 `off`로 하지 않고 `HERMES_YOLO_MODE`를 켜지 않는다 [V, 위 7번].
5. **잠금 확인 방식**: 프로브는 도구 끔을 증명할 수 없다(D2). 그래서 **운영자 attest**를 쓴다 — oort 서버 env에 `OORT_COHOSTED_AGENT_TOOLS_LOCKED=1`(이름 후보)을 운영자가 넣고, 문서화된 체크리스트(SELF_HOST/Railway 절)를 따랐음을 선언해야 연결 버튼이 켜진다. 이것은 **운영자의 자기 선언이지 oort의 검증이 아니다**. UI·문서에서 그렇게 표기한다. 선택적 보조로 `GET /v1/toolsets` 응답에 `terminal`·`code_execution`·`browser`가 없음을 경고 신호로 쓸 수 있으나 증명으로 취급하지 않는다(Q4).
6. 도구 끄기를 확인하기 전에는 Hermes 서비스를 올리지 않는다(성재 결정). 따라서 배포 문서의 순서는 「config.yaml 작성 → 도구 끔 확인 → 서비스 시작」이다.

### D7. Hermes 볼륨의 데이터 수명
- **내용** [V, 위 8번]: `.env`(키), `config.yaml`, `SOUL.md`, `sessions/`(대화 기록), `memories/`, `skills/`, `home/`, `cron/`, `state.db`. 즉 **채널에서 Hermes에 건넨 대화 내용이 oort 밖 별도 저장소(Hermes 볼륨)에 남는다.** oort DB의 RLS·워크스페이스 분리가 이 볼륨에는 적용되지 않는다. 커넥터 시험이면 `mcp-tokens/`도 — 증보 2026-10-16 K3.
- **경계 규칙**: 같은 인스턴스의 여러 워크스페이스가 한 Hermes를 공유하면 대화 기록이 한 볼륨에 섞인다. v1은 **단일 워크스페이스(운영자의 팀)** 연결만 안내하고, 다중 워크스페이스 공유는 하지 않는다(owner 질문 Q5).
- **백업**: 볼륨은 서비스별이고 oort의 DB 백업에 포함되지 않는다 [V, Railway README]. 운영자 책임으로 문서화한다. 백업 자동화는 이 ADR에서 만들지 않는다.
- **삭제**: 에이전트 제거(D4-5)는 Hermes 볼륨을 지우지 않는다. 지우려면 운영자가 Railway에서 서비스·볼륨을 직접 삭제한다. Hermes 문서에 부분 삭제 절차는 없다 [확인 필요]. 개인정보 안내문에 「Hermes 볼륨에 대화 기록이 남아요, 지우려면 서비스를 삭제하세요」를 넣는다.
- **보존 기간**: 기본값은 무기한(Hermes 기본 동작). 기간 제한은 Q5.

### D8. docker compose `agents` 프로파일 (셀프호스트 동등물)
- 목표: Railway와 같은 모양을 `docker compose --profile agents up`으로. 현재 `agents` 프로파일은 **없다** [V]. 제안 서비스 `hermes`(프로파일 `["agents"]`, `private` 네트워크, **`ports:` 없음 = 공개 노출 없음**, 이미지는 Hermes 공식 Docker 이미지로 digest 고정 [확인 필요: 공식 이미지 이름·태그]).
- env: `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`(compose 브리지 네트워크는 IPv4), `API_SERVER_KEY=${HERMES_API_KEY:?}`. 이름 있는 볼륨 `hermesdata:/opt/data`(+ `config.yaml`에 D6의 `agent.disabled_toolsets`를 담은 읽기 전용 마운트). oort `agent-worker`·`api`에는 `HERMES_BASE_URL=http://hermes:8642/v1` + `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` + `AGENT_PROVIDER_LOCAL_HOSTS=hermes`(정확 일치)를 넣는다. `AGENT_PROVIDER_LOCAL_HOSTS`는 기존에 `host.docker.internal`을 기본으로 쓴다 [V].
- 프로파일 없이는 기본 스택이 달라지지 않는다(huddle과 같은 방식). 지금 내보낼지는 Q6.

### D9. 바인딩 선택 (Railway)
- 신규 environment(2025-10-16 이후 생성)에서는 내부 이름이 IPv4·IPv6 둘 다 풀리므로 `API_SERVER_HOST=0.0.0.0`으로 충분하다. 레거시 environment는 IPv6만 풀리므로 `::`가 필요하다 [V, Railway 문서]. **추천: 배포 문서에 environment 생성일을 확인하는 한 줄을 넣고, 신규면 `0.0.0.0`, 레거시면 `::`**. `::`가 Hermes에서 동작하는지는 [확인 필요]이며 시험 전에는 레거시 환경 지원을 약속하지 않는다.
- oort `api`/`agent-worker`는 `http://hermes.railway.internal:8642/v1`로 부른다. 이 호스트는 egress 가드가 사설 주소로 보고 막으므로 D1의 운영자 opt-in(`host_exempt`)이 필요하다. 공개 주소가 아닌 `https`도 같은 opt-in이 필요하다(ADR-0004 증보 5). 즉 **내부 이름을 쓰는 한 평문 + 정확 일치 opt-in이 정상 경로**다.

## 기각한 대안
- **Railway API로 서비스 목록을 읽어 자동 발견**: Railway API 토큰을 oort에 보관해야 하고 계정 전체 접근 권한이 따라온다. 거부(성재 방향: 토큰 저장 금지).
- **내부망 스캔·이름 추측**: SSRF 표면과 오탐. 거부.
- **감지되면 자동 연결**: 도구 잠금을 증명할 수 없는데 에이전트 멤버가 생기고 pin이 걸린다. 거부 — 사람 한 번 클릭.
- **워크스페이스 관리자도 연결 가능**: 운영자 네트워크로의 SSRF 경로가 된다(ADR-0147 증보와 같은 이유).
- **별도 Railway 프로젝트에 Hermes**: 이번 결재는 「같은 프로젝트·도구 끔」. 분리 프로젝트는 더 안전하나 구성이 무겁다(성재가 추천안 대비 택하지 않음).

## 귀결
- (+) 운영자가 env 손질 없이 클릭 한 번으로 Hermes를 붙이되, 새 시크릿 저장·새 egress 면제 경로는 없다.
- (+) #3873 pin과 같은 계약을 쓰므로 새 DB 표면이 없다.
- (−) 도구 잠금은 oort가 검증할 수 없고 운영자 attest에 기댄다. 운영자가 거짓 선언하면 에이전트 호스트에 터미널이 있는 채로 연결된다 — 이 위험은 문서·UI 표기로만 낮춘다.
- (−) Hermes 볼륨에 대화가 oort 밖에 남는다(D7).

## 불변식 대조
- oort는 Codex/OpenAI OAuth·원본 provider 키를 저장하지 않는다(ADR-0004) — 유지. 저장하는 것은 없다(env의 불투명 bearer만).
- 모든 모델·에이전트 호출은 기존 egress 가드 경유 — 유지. 면제는 운영자가 선언한 호스트 하나.
- 클라이언트 직접 publish 금지·REST→outbox→relay 경로 — 변경 없음. Hermes는 oort DB에 쓰지 않는다.
- 에이전트는 1급 멤버, 권한 자동 부여 없음 — 유지.
- 구독 OAuth 중개 금지(ADR-0198) — 영향 없음. **[정정됨 2026-10-19: 「중개 금지」는 oort가 토큰을 받는 경로 한정이다. Hermes가 자기 볼륨의 구독 OAuth로 모델 인증하는 경로는 파일 끝 증보가 허용한다.]**

## 구현 슬라이스 (Accepted 후, 별도 이슈)
1. 프로브 API(운영자 전용, `momo-provider-probe` 재사용) + `/health`·`/v1/models` 한정 시험.
2. 설정 화면 카드(UX 변경이므로 design-review 필요) + 잠금 attest env.
3. 연결 클릭 = 에이전트 생성 + #3873 pin 호출(#3873 머지 후).
4. 배포 문서: Railway Hermes 서비스 체크리스트(D6·D9), compose `agents` 프로파일(Q6 승인 시).
5. 실제 Railway에서 `0.0.0.0` vs `::` 시험 기록.

## 수용 기준 (구현이 인용할 red proof)
- 선언된 호스트가 없으면 프로브 요청이 0건이다(서버가 네트워크로 나가지 않음을 계수로).
- 프로브는 정확히 2건(`/health`, `/v1/models`)만 보내고 선언 호스트 외로 가지 않는다. 사설 주소·redirect·다른 호스트는 거절.
- 인스턴스 운영자가 아닌 사용자는 카드를 못 보고 연결 PUT이 403이다.
- attest env가 없으면 연결 버튼은 비활성이고 서버도 연결을 거절한다.
- 연결은 채널 참여·grant를 하나도 만들지 않는다(행 수 비교).
- 응답·로그·감사 행에 `HERMES_API_KEY`·응답 본문이 나오지 않는다.

## owner 결정 (2026-10-16 확정분, 원문 인용)
AskUserQuestion 결재(방향):
1. 「Max (크레딧 쓰기)」
2. 「키+팀 AI 먼저 (추천)」 — 선택지 설명: 크레딧 API 키를 넣고 팀 AI(oort 도우미)를 켜서 「간단한 요청 1분 안」을 바로 재요. Hermes는 에이전트별 키 고정 기능을 만든 뒤 나란히 붙여요.
3. 「같은 프로젝트·도구 끔 (추천)」 — 선택지 설명: Hermes를 같은 Railway 프로젝트에 두되 터미널·브라우저 도구를 끄고, oort 비밀값은 주지 않고, 공개 주소도 열지 않아요. 도구 끄기를 확인하기 전에는 올리지 않아요.

2번에 따라 이 ADR의 구현은 #3873(에이전트별 키 고정) 머지 뒤에 한다.

## owner 결정 질문 1~7 — 위임 결재 (2026-10-16)
성재(2026-10-16): 「남은 작업 알아서 진행해줘. 어차피 테스트니까 니가 알아서 해봐.」 — 오케스트레이터가 아래 각 질문의 **추천안**을 채택했고 성재에게 그대로 보고했다(이의 시 증보로 바꾼다): 1 (a) `HERMES_BASE_URL` 재사용, 2 (b) attest 뒤에만 카드, 3 (a) 인스턴스 운영자만, 4 (b) attest + `GET /v1/toolsets` 경고 신호, 5 (a)+(b), 6 (b) Railway 검증 뒤로, 7 (c) environment 생성일 분기.

### 질문 원문
1. **환경 변수 이름**: (a) 기존 `HERMES_BASE_URL` 재사용 (b) 새 `OORT_COHOSTED_AGENT_URL` 추가. **추천 (a)** — `host_exempt`·egress 면제가 이미 이 변수에 묶여 있어 새 면제 경로가 없다. (b)는 co-hosted와 외부 Hermes를 구분하기 쉬우나 면제 입력이 둘이 된다.
2. **카드를 언제 보이나**: (a) 프로브 `ok`면 즉시 제안 (b) 잠금 attest 뒤에만 제안 (c) 항상 숨기고 설정에서만. **추천 (b)** — 도구 잠금을 증명할 수 없으니 attest 전에는 「연결 가능」을 암시하지 않는다. attest 전에는 체크리스트 링크만 보인다.
3. **누가 누를 수 있나**: (a) `PLATFORM_ADMIN_EMAILS` 인스턴스 운영자만 (b) 워크스페이스 관리자도. **추천 (a)** — 운영자 네트워크로 향하는 호스트이기 때문이다.
4. **도구 끔을 어떻게 확인하나**: (a) 운영자 attest env + 체크리스트만 (b) attest + `GET /v1/toolsets` 경고 신호 (c) Hermes 쪽에서 `agent.disabled_toolsets`가 보이는지 요구(문서에 그런 읽기 경로 없음). **추천 (b)** — 프로브가 증명할 수 없다는 한계를 UI에 그대로 쓰고, 보조 신호는 경고 전용이다. 함께 끌 toolset 범위(`file`·`delegation`·`cronjob` 등)도 여기서 정하며, 이름은 구현 때 toolsets-reference로 한 번 더 대조한다.
5. **Hermes 볼륨 보존 정책**: (a) 무기한, 삭제는 운영자가 서비스 삭제로 (b) 에이전트 제거 시 oort가 운영자에게 「볼륨이 남았어요」 안내 (c) 보존 기간 제한 설정을 Hermes에 요구. **추천 (a)+(b)** — oort가 볼륨을 지울 권한은 가지지 않는다. 다중 워크스페이스 공유는 v1에서 막고 단일 워크스페이스 연결만 안내한다.
6. **compose `agents` 프로파일을 지금 내보낼까**: (a) 이 ADR 구현 슬라이스 4에 포함 (b) Railway 경로가 검증된 뒤로 미룸 (c) 안 만듦. **추천 (b)** — 이번 결재는 Railway 프로젝트 기준이고, compose 쪽은 공식 이미지 이름·태그 확인이 선행돼야 한다.
7. **바인딩**: 배포 문서 기본값 (a) `0.0.0.0` (b) `::` (c) environment 생성일에 따라 분기. **추천 (c)** — Railway 문서상 2025-10-16 이후 environment는 둘 다 풀리고 레거시는 IPv6만이다. `::`는 Hermes 문서에 명시가 없으니 시험 전 레거시 지원은 약속하지 않는다.

## 증보 2026-10-16 — 1인 워크스페이스의 커넥터 호스트로서의 Hermes

- Status: **1단계(읽기 시험) Accepted · 2단계(쓰기 승인 중계) Proposed.**
  - 결재 원문(2026-10-16, AskUserQuestion): 실행 장소 「각자 + 1인 워크스페이스에서 Hermes 시험 (추천)」 — 결재 맥락(planner 요약, 원문 아님): 각자 자기 에이전트가 앱을 실행하고(D1-A), 성재의 1인 워크스페이스에서는 같은 Railway 프로젝트의 Hermes가 성재 본인 토큰으로 속도 시험을 한다. 입구·범위와 쓰기: 「코덱스 앱이나 다른 그록봇류 앱처럼 구글쪽이랑 깃헙, 지라, 슬랙 등 메이저쪽 플러그인 지원 작업까지. 구글 캘린더나 구글 메일 드라이브등은 무조건 되어야함」.
  - 결재 원문 추가(2026-10-16 저녁, AskUserQuestion, **다음 줄이 대체함**): 질문 「Google 앱(캘린더·메일·드라이브) 연결을 어느 Google 계정과 OAuth 앱으로 만들까요?」 → 답 「개인 Gmail 외부 앱」. 이 답 뒤에 Preview 신청이 Workspace 계정을 요구한다는 사실이 드러나 owner 재확인을 구했다(ADR-0113 증보 2 E2 [V]).
  - 결재 원문 추가(2026-10-17, 성재): 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」 — 앞선 「개인 Gmail 외부 앱」을 대체한다. Google 세 앱의 Preview 가입과 OAuth 앱은 dawn.kim Workspace 계정으로 먼저 하고, 계정·OAuth 앱은 설정값이라 나중에 바꿀 수 있다(ADR-0113 증보 2 E2·E6). 반영은 K3·K5·K7과 구현 슬라이스에 있다. 이 결재가 owner 질문 1과 owner 재확인을 닫는다. Google 시험(K-S1b)은 G-S0(dawn.kim의 Preview 가입·OAuth client 준비, owner 행동) 뒤에 시작한다.
  - 1단계는 결재가 직접 다룬다. 2단계는 결재의 「쓰기 포함」을 이 경로에서 이루는 **방법**이 D5(chat/completions SSE 경로)와 ADR-0004 계약을 바꾸므로, planner가 방향을 적고 구현 전 확인을 받는다(이 ADR 「위임 결재」와 같은 방식 — 추천안 채택·보고·이의 시 증보).
- 관계: ADR-0113 증보 2(E1 실행 장소 표·E3 배달 규칙·E4 등급·E5 `tool_grants`), ADR-0186(새 `connector_tool` 종류), ADR-0004(worker ↔ Hermes 계약), ADR-0193 D4(`owner_only_gate`).
- 출처: hermes-agent.nousresearch.com `/docs/user-guide/features/mcp`, `/docs/reference/mcp-config-reference`, `/docs/reference/toolsets-reference`, `/docs/user-guide/features/api-server`, `/docs/user-guide/security`(모두 2026-10-16 받음).

### 확인한 사실 [V]

1. **Hermes는 원격 MCP 클라이언트다.** `config.yaml` `mcp_servers.<name>`에 `url`·`headers`·`auth: oauth`. discovery → CIMD → DCR 순으로 등록하고 PKCE·갱신·step-up을 처리한다. DCR 없는 서버는 `oauth.client_id`·`oauth.client_secret`로 미리 등록한 client를 쓴다(문서 예시가 Google Drive다). 헤드리스 로그인은 `hermes mcp login <server>`의 redirect URL 붙여 넣기, 또는 `oauth.flow: device`.
2. **토큰 위치**: 「tokens are cached at ~/.hermes/mcp-tokens/<server>.json with 0o600 perms」. Docker는 모든 상태가 `/opt/data`(이 ADR 사실 8)라 `/opt/data/mcp-tokens/`가 된다 [추정 — K-S1a에서 컨테이너 안 경로를 확인]. **토큰은 서버별·기계별이고 사람별이 아니다.** 갱신이 실패하면 「the server parks with a warning in gateway.log」 — 푸시 알림은 없다.
3. **도구 이름**: MCP 서버마다 런타임 toolset `mcp-<server>`, 도구 이름 `mcp_<server>_<tool>`. 그래서 D6의 `agent.disabled_toolsets: [terminal, code_execution, browser]`와 이름이 겹치지 않는다 — 두 설정은 함께 둘 수 있다. 서버별 `tools.include`·`tools.exclude` glob이 있다.
4. **승인**: `trust: untrusted`인 서버는 「every write-capable tool call (any tool without a readOnlyHint: true annotation) requires user approval」. `/v1/runs`는 `approval.request` 이벤트를 내고 `waiting_for_approval`에서 멈추며 `POST /v1/runs/{run_id}/approval`로 푼다. 응답할 수 없는 세션은 `approvals.unattended_mode: deny`(기본)로 즉시 막힌다. 문서 원문: 「a lying server can at most skip approval for tools it claims are read-only」.
5. **sampling**: 서버별 sampling이 기본 켜짐이다 — MCP 서버가 Hermes의 모델 키(소유자 크레딧)로 LLM을 부를 수 있다. elicitation은 form 모드면 승인 화면, URL 모드는 거절.
6. oort worker는 Hermes를 OpenAI 호환 `/v1/chat/completions` SSE로 부르고(D5, ADR-0004), oort `tools`만 넘긴다(`momo-agent-worker/src/provider.rs:507-515`). 작업 payload의 `tool_grants`를 Hermes는 읽지 않는다.

### K1. 범위 — 소유자 1인 워크스페이스, 소유자 본인 토큰

- 이 시험은 ADR-0113 증보 2 E1 표의 둘째 줄이다. **팀 공용 실행기가 아니다.** 사람별 토큰 격리가 없으므로(사실 2) 「운영자 = 토큰 주인 = 유일한 요청자」일 때만 D1-A·D2와 맞는다.
- 사람 2명 이상 워크스페이스로 넓히는 것은 열지 않는다. 다음 단계 후보는 Hermes profiles(`hermes profile create`, `/p/<profile>/v1/…`, 프로필마다 `API_SERVER_KEY`·config·memory 분리)이고, 새 증보로 정한다.

### K2. 서버 강제 — 「단일 워크스페이스」를 안내에서 강제로 올린다

D7은 「v1은 단일 워크스페이스만 안내」였다. 커넥터 시험은 안내로는 부족하다(남이 부르면 소유자 메일함이 남의 요청에 쓰인다). 서버가 아래 셋을 강제한다.

1. **켜기**: 인스턴스 운영자(`PLATFORM_ADMIN_EMAILS`)가 그 Hermes 에이전트의 「커넥터 시험」을 켠다. 서버는 (a) 운영자가 그 워크스페이스의 활성 사람 멤버이고, (b) **활성 사람 멤버가 정확히 1명**이며, (c) D6 잠금 attest와 아래 K4 커넥터 attest가 모두 있을 때만 받는다. 켜면 `agent.connector_owner_human_id = 운영자`(ADR-0113 증보 2 E3)를 기록하고 감사 한 줄을 남긴다.
2. **배달**: 이 에이전트로 가는 작업은 트리거 작성자가 `connector_owner_human_id`일 때만 배달한다(E3 `owner_only_gate` 새 갈래). 다른 사람 → 배달 0 + 안내, A2A·웹훅·시스템 → 배달 0.
3. **멤버가 늘면 닫힌다**: 배달 직전마다 활성 사람 멤버 수를 다시 센다. 2명 이상이면 배달 0, 소유자에게 한 번 「워크스페이스에 사람이 늘어서 Hermes 앱 시험을 멈췄어요. Hermes의 앱 연결을 지우거나, 사람별 분리가 생길 때까지 기다려 주세요.」 초대 수락 시점이 아니라 배달 시점에 재므로, 멤버 추가 경로를 빠뜨려도 새지 않는다. 운영자가 Hermes 쪽 토큰을 지우는 것(K5)은 oort가 대신하지 못한다.

### K3. 토큰과 볼륨 — D7 목록에 `mcp-tokens/`

- D7 내용 목록에 **`mcp-tokens/`(벤더 OAuth 갱신 토큰, 고가치)** 를 더한다. oort DB의 RLS·백업 밖이고, 대화 기록(`sessions/`, 메일 본문이 들어갈 수 있다)과 같은 볼륨이다. 개인정보 안내문에 「Hermes 볼륨에 앱 로그인 토큰과 앱에서 읽은 내용이 남아요」를 더한다.
- DCR 없는 서버(Google·GitHub·Slack)의 미리 등록한 client secret은 Hermes `config.yaml`(볼륨) 또는 Hermes 서비스 env에만 둔다. **oort 서버·DB에는 두지 않는다**(ADR-0113 증보 2 E6). D6-2 「oort 비밀값을 Hermes에 주지 않는다」의 반대 방향도 같다 — Hermes의 벤더 secret을 oort에 주지 않는다.
- **Google 계정·앱 — 결재 2026-10-17: dawn.kim 우선**(앞선 「개인 Gmail 외부 앱」을 대체, ADR-0113 증보 2 E2). OAuth 앱은 dawn.kim 조직 프로젝트의 Internal 동의 화면이 기본이다. **그 결과 dawn.kim 조직 계정만 연결할 수 있다** — 소유자의 개인 Gmail은 이 client로 연결할 수 없고(`org_internal` 오류), 시험은 소유자의 dawn.kim 계정의 메일·일정·드라이브를 읽는다. 갱신 토큰 7일 만료는 문서상 「external user type + Testing」인 프로젝트에 걸리는 조건이라(developers.google.com/identity/protocols/oauth2) Internal은 그 밖이다 — 문서가 Internal을 이름으로 말하지는 않으므로 K-S1b가 실제 수명을 잰다 [확인 필요]. 조직 밖 계정이 필요해 External(Testing)로 바꾸면 갱신 토큰이 **7일마다** 죽고, 그때 이 시험은 7일마다 `hermes mcp login`을 다시 하는 시험이 된다. 갱신 실패는 `gateway.log`에만 남으므로(사실 2) 감지 신호는 K-S1a가 잰다.
- **계정·OAuth 앱은 바꿀 수 있다**(결재 2026-10-17 「나중에 바꿀 수도 있는거지 ?」). client 값은 Hermes `config.yaml`(또는 서비스 env)에만 있고 oort 서버·DB·매니페스트에는 없다(ADR-0113 증보 2 E6). 바꿀 때는 새 client 값을 넣고 소유자가 `hermes mcp login`을 한 번 다시 하며, 옛 연결은 K5 회수 순서로 지운다. oort 쪽 변경은 없다. 순서 전체는 ADR-0113 증보 2 E6 「교체」.
- **[V, 2026-10-16·17] Preview 가입이 먼저다.** 공식 Google MCP 세 줄은 Developer Preview 가입이 전제이고, 신청 안내가 Workspace 계정과 Cloud 프로젝트 정보를 요구한다(developers.google.com/workspace/preview, ADR-0113 증보 2 E2). 신청자는 dawn.kim Workspace 계정으로 정해졌고(결재 2026-10-17), 가입 확인(G-S0)이 되기 전에는 **K-S1b(Google 읽기 시험)를 시작하지 않는다.** K-S1a(모의 서버 실측)는 영향이 없다.

### K4. 도구 잠금 — D6을 커넥터 시험에 한해 넓힌다

D6의 다섯 조건은 그대로이고, 커넥터 시험이면 아래를 **모두** 더한다. 운영자 attest는 D6-5와 같은 방식이다 — oort 서버 env `OORT_COHOSTED_AGENT_CONNECTORS_LOCKED=1`(이름 후보)과, 켜 둔 앱 id 목록 `OORT_COHOSTED_AGENT_CONNECTOR_APPS`(예 `com.momo.plugins.gmail,com.momo.plugins.google-calendar`). **자기 선언이지 oort의 검증이 아니다** — UI·문서에 그렇게 쓴다.

1. `agent.disabled_toolsets`에 D6의 셋 + **`cronjob`·`delegation`·`web`** 를 넣는다. `cronjob`은 사람 없는 예약 실행, `delegation`은 하위 에이전트로 잠금 우회, `web`은 메일 본문 프롬프트 인젝션의 유출 경로다. `file`·`skills`(skill_manage 쓰기)·`memory`는 시험 중 끄기를 권장하되 필수는 아니다. toolset 정확한 이름은 toolsets-reference 표와 K-S1a에서 한 번 더 대조한다 [확인 필요].
2. MCP 서버마다: `trust: untrusted`, `sampling` 끔, `tools.include` 허용목록 필수(glob 금지, 도구 이름 전부 나열).
3. `tools.include`는 **oort 매니페스트의 R 등급 도구만**(1단계). 쓰기 도구를 include하지 않는다 — `trust: untrusted` + `unattended_mode: deny`가 안전판이지만, `readOnlyHint`는 서버 자기 보고라(사실 4) 1차 방어는 허용목록이다.
4. 켜 둔 MCP 서버는 `OORT_COHOSTED_AGENT_CONNECTOR_APPS`의 앱과 1:1이고, 서버는 배달 직전 「그 앱들 ⊆ 소유자의 활성 grant(ADR-0113 D2)」를 확인한다. 소유자가 oort에서 grant를 회수했는데 Hermes에 앱이 남아 있으면 배달 0 + 안내(ADR-0113 증보 2 E5).
5. 보조 신호: 프로브(D2)가 `GET /v1/toolsets` 응답에서 `terminal`·`code_execution`·`browser`·`cronjob`·`delegation`·`web`이 보이면 경고하고, `mcp-*` toolset 이름이 attest한 앱 수와 다르면 경고한다. 증명이 아니다(D2·Q4 그대로). `hermes-api-server` 플랫폼 기본값에 `mcp-*`가 자동으로 드는지 [확인 필요: K-S1a] — 들지 않으면 플랫폼 toolset을 명시하는 줄을 체크리스트에 넣는다.

### K5. 운영자 체크리스트(SELF_HOST·Railway 절에 추가)와 회수

- 순서: GCP·벤더 쪽 client 준비 → `config.yaml`에 `mcp_servers`(K4-2·3) → `disabled_toolsets`(K4-1) → `hermes mcp login <server>`(Railway shell에서 붙여 넣기 방식) 또는 `oauth.flow: device` → oort env attest 두 개 → 「커넥터 시험」 켜기.
- OAuth 앱이 External(Testing)이면 7일마다 `hermes mcp login <server>`를 다시 한다(K3). dawn.kim Internal 기본값에서는 이 조건에 들지 않는다 [확인 필요: K-S1b가 실제 갱신 토큰 수명을 잰다].
- 첫 OAuth는 컨테이너에 브라우저가 없다. 붙여 넣기·기기 코드 중 벤더가 받는 쪽을 쓴다 [확인 필요: Google·GitHub·Slack 각각 — Hermes 쪽 형식은 K-S1a, Google 쪽 허용은 K-S1b]. 로컬에서 만든 토큰 파일을 볼륨에 복사하는 방법은 쓰지 않는다(토큰이 운영자 맥에 사본으로 남는다).
- **회수 순서**: (1) oort에서 「커넥터 시험」 끄기(배달 즉시 0), (2) 벤더 쪽 연결 해제 — Google은 계정 「타사 앱 액세스」, GitHub은 Authorized OAuth Apps, Slack은 앱 설치 해제, (3) Hermes 볼륨의 `mcp-tokens/<server>.json` 삭제와 `config.yaml`의 서버 항목 삭제, (4) 필요하면 `sessions/`도 삭제(부분 삭제 절차는 Hermes 문서에 없다 — D7). oort는 (2)·(3)을 대신하지 못한다.

### K6. 쓰기 — 2단계 (Proposed)

- 모양: worker가 Hermes 승인 이벤트를 받아 **oort `connector_tool` 승인 카드**(ADR-0113 증보 2 E4)로 중계하고, 소유자 결정을 Hermes `POST /v1/runs/{run_id}/approval`로 돌려보낸다. 서버는 실행하지 않는다. 결정자는 `connector_owner_human_id`뿐이다.
- 이것이 바꾸는 계약: D5(worker는 chat/completions SSE로 부른다)와 ADR-0004(Hermes 호출 모양). 스트리밍 chat completions에서 승인 이벤트가 어떤 이름·모양으로 오는지, Hermes가 「응답할 수 있는 클라이언트」를 어떻게 판정하는지 [확인 필요: H-S2 — K-S1a가 함께 잰다]. 판정 결과에 따라 worker가 `/v1/runs`로 옮겨야 할 수 있다 — 그러면 ADR-0004 증보가 함께 필요하다.
- 승인 TTL(oort 기본 1시간)과 Hermes 대기 상한을 맞춘다. 카드가 만료되면 worker가 Hermes에 거절을 보낸다(남은 대기 0).
- 2단계를 열 때 `tools.include`에 A·B 등급 쓰기 도구를 더한다. C 등급은 매니페스트에 없으므로 include할 수 없다(서버 attest 대조에서 거절).
- 확인 전에는 쓰기 도구를 include하지 않는다. include했는데 중계가 없으면 `unattended_mode: deny`로 조용히 막힌다 — 이것은 안전한 실패지만, 화면에는 「이 쓰기는 아직 Hermes 시험에서 승인할 길이 없어요」로 보인다.

### K7. Google을 먼저 한다

- 1단계 첫 앱은 결재 「구글 … 무조건」에 맞춰 Google Calendar·Gmail·Drive(내 드라이브) 읽기다. 공식 Google MCP(Developer Preview)를 쓴다. 성재는 dawn.kim 조직 프로젝트의 주인이자 유일한 사용자이고, Internal 동의 화면이면 연결할 수 있는 계정도 dawn.kim 조직으로 한정돼서 Preview 약관의 「도메인·회사 밖 최종 사용자」 금지 안이다(ADR-0113 증보 2 E2 「미리보기」 규칙). 단 dawn.kim의 Preview 가입이 먼저다(K3, G-S0). 첫 실측 단계(K-S1a)는 Google 없이 모의 서버로 한다.
- 비교군으로 `workspace-mcp`(taylorwilsdon/google_workspace_mcp, MIT, v2.1.0 2026-10-09)를 같은 시험에서 돌려 볼 수 있다. 단 stdio이고 Python(uv) 런타임이 Hermes 이미지에 있어야 한다 [확인 필요]. 비교 결과는 기록만 하고, oort 공식 매니페스트(원격 HTTP만)는 바꾸지 않는다. Railway에 `workspace-mcp`를 멀티유저 HTTP 서버로 따로 띄우는 것은 금지다 — 모든 멤버 토큰이 서버 하나에 모이는 D1-B 모양이다.

### 구현 슬라이스 (K-S1a는 #3873을 기다리지 않는다. K-S1b·K-S2·K-S3는 #3873과 이 ADR 본 슬라이스 1~3 뒤)

- **K-S1a (engine 스파이크, 로컬 Docker, #3942)**: 전용 포트·볼륨의 Hermes 공식 이미지 + 대본 LLM 스텁 + 모의 MCP(OAuth·DCR)로 토큰 경로·`mcp-*` 기본 포함 여부·toolset 이름·붙여 넣기 redirect 형식·device 흐름·`trust: untrusted`의 승인 이벤트 모양과 대기 상한(H-S2)·갱신 실패 감지 신호를 실측해 기록한다. Google 없이 한다.
- **K-S1b (runtime/manual, #3952)**: Railway에서 K4 설정으로 Hermes 기동, 성재 1인 Hermes로 Google Calendar·Gmail·내 드라이브 읽기 시험, 헤드리스 로그인(K5), 회수 순서 실연. 체크리스트(K5) 문서화. **owner 재확인은 끝났다(2026-10-17). dawn.kim의 Preview 가입·OAuth client 준비(ADR-0113 증보 2 G-S0, owner 행동 2) 뒤에 시작한다(K3).** 원래 하나였던 K-S1을 둘로 나눈 것이다 — 순서를 바꾼 게 아니라 owner 입력 없이 할 수 있는 부분을 먼저 떼어 낸 것이다.
- **K-S2 (engine, #3948)**: 「커넥터 시험」 켜기 라우트(운영자 전용, 사람 1명·attest 판정), `connector_owner_human_id` 기록(ADR-0113 증보 2 C-S2 위), 배달 직전 사람 수·grant 대조.
- **K-S3 (uxui, #3953)**: 설정 › AI 연결의 Hermes 카드에 「앱 시험」 줄(켬·끔, 자기 선언 표기, 멈춤 안내). 캡처·design-review.
- **H-S2 → C-S4 (engine, #3956)**: 2단계 쓰기 중계. H-S2의 실측(승인 이벤트 모양·응답 가능 클라이언트 판정·대기 상한)은 K-S1a가 하고, 그 결과로 K6을 Accepted로 올리거나 다시 쓴 뒤에 시작한다.

### red proof (해당 분기를 지우면 실패해야 한다)

1. 활성 사람 멤버 2명인 워크스페이스에서 「커넥터 시험」 켜기 → 409, `connector_owner_human_id` 기록 0.
2. 켠 뒤 두 번째 사람이 합류 → 다음 소유자 멘션의 배달 0 + 안내 1(초대 경로를 거치지 않는 멤버 추가로도 같은 결과).
3. 소유자가 아닌 사람·A2A 에이전트 멘션 → 배달 0.
4. attest 둘 중 하나라도 없으면 켜기 거절, 켜진 뒤 attest가 사라지면 배달 0.
5. 소유자 grant가 회수된 앱이 `OORT_COHOSTED_AGENT_CONNECTOR_APPS`에 남아 있으면 배달 0.
6. 비운영자 사용자 → 켜기 403.
7. oort 응답·로그·감사에 Hermes의 벤더 secret·토큰 바이트 0(마커).
8. (2단계) `connector_tool` 카드 결정자 ≠ 소유자 → 403, 만료 → worker가 Hermes에 거절 1회.

### 바뀌지 않는 것

- D6-1~5(터미널·코드 실행·브라우저 끔, oort 비밀값 미전달, 공개 도메인 없음, 키·승인 설정, 운영자 attest), D7의 보존·백업·삭제 규칙(목록만 늘었다), D2 프로브 두 요청, D3 인스턴스 운영자만.
- 도우미(oort 팀 AI)는 이 시험과 무관하다. Hermes 시험 멤버는 도우미가 아니고, 도우미는 앱 도구를 부르지 않는다(ADR-0201 H4·H7·H9-I1).

### K-S1a 실측 결과 (2026-10-18, #3942) — 증보 [확인 필요] 닫기

상세와 근거는 `docs/planning/research/2026-10-18-hermes-mcp-connector-spike-k-s1a.md`. 로컬 Docker(v0.22.2) + 모의 MCP, 실제 키 없음.

- **토큰 경로 [V]**: `/opt/data/mcp-tokens/<server>.json`(+ `.client.json`·`.meta.json`·`.refresh.lock`), 0700/0600, uid 10000.
- **`mcp-*` 기본 포함 [V]**: 든다. `platform_toolsets` 미설정이면 설정된 MCP 서버가 `api_server`에 붙고, 모델에는 지연 카탈로그(`tool_search`·`tool_describe`·`tool_call`)로 보인다. 도구 이름 `mcp__<server>__<tool>`, 레지스트리 toolset `mcp-<server>`. `agent.disabled_toolsets` 24종은 MCP를 막지 않고 `/v1/toolsets`에는 나오지 않는다. 체크리스트에 `no_mcp` 또는 서버 이름을 명시하는 줄이 필요하다(소스 확인).
- **로그인 [V]**: 헤드리스 브라우저 흐름은 인가 URL 출력 후 stdin에서 리디렉션 URL을 받는다. `redirect_uri`는 `http://127.0.0.1:<임의 포트>/callback`(`oauth.redirect_port`로 고정). `oauth.flow: device`는 AS에 `device_authorization_endpoint`가 있으면 동작한다.
- **쓰기 승인 H-S2 [V]**: 스트리밍에서만 `event: approval.request`(`request_id`, `run_id`=completion id, `choices`)가 오고 `POST /v1/runs/{run_id}/approval`로 답한다. 비스트리밍은 즉시 거부. 대기 상한 300초 후 거부로 닫힌다. `unattended_mode: deny`는 이 경로를 막지 않는다. D5는 바꿀 필요가 없고 ADR-0004 증보는 이 이유로는 필요 없다.
- **갱신 실패 신호 [V]**: 구조화 신호 없음(health·capabilities·toolsets 불변). `agent.log`·`errors.log`(gateway.log 아님)의 `hit a permanent error, parking …`와 도구 결과 `MCP call failed: MCPError: Connection closed`뿐이다. oort의 「벤더 로그인 만료」는 능동 프로브에서 추정하는 상태이며 단정하지 않는다.
- **한도·불통 [V]**: 429·503이 구분되지 않는 같은 문구, 서버 불통은 15초 뒤 `Connection closed`.
- 남은 `runtime-unverified`: 실제 벤더(K-S1b), `approvals.timeout` 변경, `no_mcp`·서버별 도구 허용 키, `/v1/runs` 승인, Railway.


### K-S2 구현 결과 (2026-10-18, #3948) — K2·K4를 서버 규칙으로, 그리고 잠금 게이트 규칙 변경

결재·방향은 바꾸지 않았다. 이름 후보를 확정하고, 이 슬라이스가 정한 것을 적는다.

- **이름 확정**: `OORT_COHOSTED_AGENT_CONNECTORS_LOCKED`(K4 커넥터 attest), `OORT_COHOSTED_AGENT_CONNECTOR_APPS`(켜 둔 앱 id, 쉼표 구분. 형식이 틀린 id 하나가 목록 전체를 무효로 한다), 기존 `OORT_COHOSTED_AGENT_TOOLS_LOCKED`(D6). 서버는 이 셋을 **`api` 서비스 env에서만** 읽는다.
- **켜기·끄기·보기**: `PUT /v1/workspaces/{ws}/agents/{agent}/connector-trial {"enabled":bool}`, `GET` 같은 경로. 둘 다 인스턴스 운영자 전용(D3)이고, 에이전트는 운영자 본인이 연결한 Hermes(`agent.owner_human_id` = 운영자, `agent_provider_pin.kind='operator_env'`)여야 한다. 저장하는 값은 #3938의 `agent.connector_owner_human_id` 하나이고 쓰는 길도 `set_connector_owner_in_tx` 하나다(마이그레이션 없음). 켤 때 순서대로 `409 connector_trial_not_cohosted`(운영자 env에 고정된 Hermes가 아님) → `409 connector_trial_attest` → `409 connector_trial_shared`(같은 Hermes에 고정된 다른 에이전트) → `409 connector_trial_members`(활성 사람 멤버 `member.kind='human' AND status='active' AND deleted_at IS NULL` ≠ 1) → `409 connector_trial_apps`(켜 둔 앱 ⊄ 소유자의 활성 grant) 중 하나로 거절하고, 거절은 아무것도 기록하지 않는다. 변경마다 감사 한 행(`agent.connector_trial.updated`, 앱 id만).
- **「활성 grant」의 정의**: `plugin_grant.status='active'`이고 `revoked_at IS NULL`이며, 같은 앱의 `workspace_plugin_install`이 `enabled`이고 `revoked_at IS NULL`. 설치가 꺼지면 grant 행이 남아도 활성이 아니다. 팀 AI 도구(`team_ai_tools.rs`)의 「connected」와 같은 grant 술어에 설치 조건을 더한 것이다.
- **배달 직전 재확인 = 「시험 에이전트」에만**: 시험 에이전트는 표시(`connector_owner_human_id`)가 있고 **운영자 env 링크에 고정된** 에이전트다. 같은 표시를 쓰는 다른 에이전트(workd 등 사람별 토큰)는 사람 수·attest로 판정하지 않는다. 판정은 DB 사실(사람 수, 소유자의 활성 grant 앱 목록)을 후보 조회에 실어 오고 서버 env attest와 **순수 함수 한 개**(`connector_trial_stop`)로 비교한다 — 순서는 attest → 사람 수 → grant. 같은 함수가 멘션·DM·스레드 깨우기(`delivery_gate`), 1:1 DM 상태(`agent-dm-delivery` → `connector_trial_stopped`), 작업 요청(`409 connector_trial_*`)에 걸린다. 멈추면 job 0·inbox 0이고 소유자에게 문장 하나(자기 쓰로틀 버킷)를 에이전트 이름으로 남긴다: 사람이 늘면 K2-3의 문장 그대로, grant 회수는 「실행 중에 허용이 회수돼서 Hermes 앱 시험을 멈췄어요. 허용을 되돌리거나, Hermes에서 그 앱 연결을 지워 주세요.」, attest 부재는 「서버에 앱 시험 선언이 없어서 Hermes 앱 시험을 멈췄어요. 운영자가 체크리스트를 다시 확인하고 선언을 넣어 주세요.」 소유자가 아닌 사람·에이전트는 이 판정 앞의 #3938 갈래에서 이미 거절된다.
- **워커**: 이미 쌓인 job은 워커가 가져갈 때 **사람 수만** 다시 센다. 2명 이상이면 모델을 부르지 않고 run `cancelled`(`connector_trial_members`)·job `done`·감사 한 행으로 닫는다. 워커는 attest·grant를 읽지 않는다(아래 남은 것). 게이트웨이 claim도 같은 규칙을 가진다(아래 한계 2).
- **일반 표시 라우트는 Hermes를 켜지 못한다**: `PUT …/connector-owner`로 운영자 env에 고정된 에이전트를 **켜면** `409 connector_trial_route_required`. 끄기는 소유자에게 계속 열려 있다. 켜기의 문턱(사람 1명·attest·grant·전용 Hermes)을 건너뛴 켜기를 만들지 않는다. 반대 순서(표시를 먼저 켜고 나중에 고정)는 켜기 검사와 감사를 거치지 않지만, 배달 판정은 표시+고정이면 똑같이 적용되므로 새는 길은 아니다.
- **자기 선언 표기**: 응답 `note`와 `attested.selfDeclared=true`가 「운영자의 자기 선언이고 oort의 검증이 아니다」를 말한다. 서버는 응답·감사 어디에도 앱 id 외의 attest 내용을 쓰지 않는다.
- **같은 Hermes를 타는 다른 에이전트(독립 검수 H1)**: Hermes는 토큰 볼륨이 하나라서 거기에 닿는 **모든** 에이전트가 앱을 쓸 수 있다 — 표시된 에이전트 하나만 판정해서는 부족하다. 그래서 (a) 켜기는 같은 워크스페이스에 운영자 env 링크에 고정된 다른 에이전트가 있으면 `409 connector_trial_shared`, (b) 표시된 시험 에이전트가 있는 동안 `PUT …/provider-pin`으로 다른 에이전트를 `operator_env`에 고정하면 `409 connector_trial_on`. 연결(`cohosted-agent/connect`)은 워크스페이스당 하나만 만들므로 이미 막혀 있다. **서버가 강제하지 못하는 것**: 같은 인스턴스의 *다른 워크스페이스*에서 이 Hermes에 고정된 에이전트(API는 다른 테넌트 행을 읽지 못한다 — BYPASSRLS 금지), 그리고 고정도 팀 링크도 없어서 워커가 `HERMES_BASE_URL`로 보내는 에이전트(env 폴백). 이 둘은 「이 Hermes는 시험 전용으로 둔다」는 운영자 선언에 남고 체크리스트에 적었다. 결정이 필요하면 후속(소유자 질문).
- **알려진 한계(남은 것)**: (1) `OORT_COHOSTED_AGENT_*` attest는 `api`만 읽는다 — job이 쓰인 뒤 attest나 grant가 바뀌면 이미 쓰인 job은 워커가 그대로 실행한다(새 job은 쓰이지 않는다. 사람 수만 워커가 다시 센다). 환영 인사(welcome)와 승인 재개(`resume_approval`) job은 **쓰는 시점에도** attest·grant를 보지 않는다(소유자 본인의 1회성 호출이고 워커가 사람 수는 다시 센다). 워커 env에도 같은 attest를 요구하는 것은 운영 부담이 늘어서 하지 않았고 필요하면 후속이다. (2) 게이트웨이·호스티드 claim(`oort_jobs_claim`, `method='gateway'`)도 **사람 수는** 다시 센다 — `momo-outbox/src/gateway.rs`의 `trial_members_stop_sql!`이 claim 술어와 닫기 UPDATE(`close_connector_foreign_jobs_in_tx`)에 같은 정의로 들어 있고, 표시된 시험 에이전트의 소유자 job도 워크스페이스가 한 명이 아니면 `connector_trial_members`로 닫는다(이미 임대된 job은 건드리지 않는다). attest·grant는 claim 시점에 보지 않는다(쓰는 시점에만). 호스티드 inbox 읽기에는 걸지 않았다. 근거: Hermes를 부르는 길은 워커의 provider 클라이언트 하나이고 고정(pin)은 그 워커가 어느 링크를 쓸지만 바꾼다 — 호스티드·gateway 런타임은 oort를 거쳐 Hermes를 부르지 않는다. 그래도 같은 에이전트가 두 길에 모두 있을 수 있어(고정과 호스티드 연결을 함께 막는 코드는 없다) claim 쪽도 닫았다. (3) 워커가 job을 닫을 때는 소유자에게 문장 없이 감사 한 행만 남긴다(안내는 쓰는 시점의 멘션에서만 간다). (4) 서버는 실제 Hermes의 `mcp_servers`·도구·토큰을 볼 수 없다(attest만). (5) 실제 벤더 왕복은 `runtime-unverified`(K-S1b).

#### 잠금 게이트(`lockgate.py`) 규칙 변경 — 커넥터 시험을 켤 때

기존 게이트(ADR-0203 D6, Railway 시작 명령이 이미지 엔트리포인트 앞에서 실행)는 `mcp_servers`가 **비어 있어야** 통과했다(K-S1a: 「커넥터를 켜는 구현에서는 게이트 규칙을 바꿔야 한다」). 바뀐 규칙: **`mcp_servers`가 비어 있으면 전과 같고, 비어 있지 않으면 시험 규칙 전부를 만족할 때만 통과한다.** 별도 스위치는 없다 — 서버 항목을 쓰는 것이 곧 시험을 켜는 뜻이라, 깜빡해서 느슨한 채 통과하는 길이 없다. 시험 규칙(하나라도 어기면 exit 3, 나머지 D6 규칙은 그대로 함께 적용):

1. Hermes 서비스에도 `OORT_COHOSTED_AGENT_CONNECTOR_APPS`가 있고(oort와 같은 값), `mcp_servers` 키 집합이 그 앱 집합과 **1:1**이다. 키는 앱 id에서 `com.momo.plugins.`를 떼고 소문자로 한 뒤 `-`·`.`를 `_`로 바꾼 값(Hermes가 `-`/`_`를 같게 본다).
2. 서버마다 원격 한 줄 `https://` url(공백·개행 없음, `command`·`args` 금지 — 로컬 프로세스 실행).
3. `trust`가 정확히 `untrusted`(Hermes는 값이 없으면 `full`로 본다 — K-S1a 소스 확인), `sampling.enabled`가 명시적 `false`(기본값이 켜짐).
4. `tools.include`가 비지 않은 **정확한 이름** 목록(`*`·`?`·`[`가 있으면 Hermes가 fnmatch 글롭으로 읽는다), 그리고 `tools.resources`·`tools.prompts`가 명시적 `false` — Hermes는 서버마다 리소스·프롬프트 읽기 도구(`list/read_resource`, `list/get_prompt`)를 **`include` 밖에서** 기본 켜짐으로 등록하므로 `include`만으로는 읽기 도구 목록이 닫히지 않는다(#3948 독립 검수로 발견, Hermes v0.22.2 소스 `mcp_tool_registration.py`).
5. `agent.disabled_toolsets`에 `cronjob`·`delegation`·`web`(K4-1).

게이트는 **설정**을 본다. K-S1a 실측대로 MCP 도구는 `/v1/toolsets`에 나오지 않고 `disabled_toolsets`가 막지도 않으므로, 허용목록 검사도 기동 뒤 리포트도 벤더 서버가 실제로 내놓는 도구를 증명하지 못한다 — 그것은 K4의 운영자 attest다. 스크립트는 레포 `infra/hermes/lockgate.py`에 있고 규칙은 Docker 없이 `infra/hermes/test_lockgate_connectors.py`로, 실제 Hermes 이미지(v0.22.2 digest 고정)로는 게이트 매트릭스 행으로 확인했다(#3948 PR 본문).


## 증보 2026-10-19 — 설치 한 번에 Hermes까지 (#4072) — Accepted

상태: **Accepted** (2026-10-19, 통합자 Opus 5.5 — 성재 「제로 베이스 온보딩 개선 묶음도 진행 ㄱㄱ」 범위, 번들 배포에 한정된 attest 의미 변경과 남은 위험 M1·M2·L5·L6 명시를 확인). 공개 API는 바뀌지 않지만 보안 경계 하나가 바뀐다(아래 A3: 잠금 선언의 자동 기록). 통합자가 Accept한다. 모델 인증(키·OAuth)은 #4073의 몫이고 여기서 하지 않는다.

### 배경 [V]
제로 베이스 사용자는 §3.4.1의 수동 8단계를 따라야 카드가 보였고, compose에는 `agents` 프로파일이 없었다(D8은 「제안」이었다). 성재 목표는 「설치 한 번으로 Hermes까지 뜨고 설정 › AI 연결에 같은 서버의 Hermes 카드가 바로 보이는 것」이다.

### A1. D8을 구현 이름으로 확정 (compose)
- 프로파일 `agents`, 서비스 `hermes`(`infra/rust/docker-compose.rust.yml`). 이미지는 공식 `nousresearch/hermes-agent` v0.22.2의 **index digest 고정**(`sha256:36099926…c2919`, #3952 `hermes-kwak`와 같은 값). `ports:` 없음, `private` 네트워크만, 볼륨 `hermesdata:/opt/data`(이름은 pgdata와 같은 프로젝트 스코프 규칙), `mem_limit 2g`·`cpus 1`.
- 시작 명령이 이미지 ENTRYPOINT를 **대체**한다(`/bin/sh -c`, `set -eu`): `infra/hermes/config.yaml`을 읽기 전용 마운트에서 `/opt/data/config.yaml`로 복사 → `lockgate.py gate`(exit 0이 아니면 여기서 종료, 리스너가 생기기 전) → `lockgate.py report &` → `exec` Hermes dispatcher. 이미지 자체의 부팅이 CMD보다 먼저 게이트웨이를 띄우므로 거절을 걸 수 있는 자리는 엔트리포인트 앞뿐이다(Phase 1 실측, K-S1b와 같음). 설정은 매 시작마다 마운트에서 다시 복사되므로 볼륨의 `config.yaml`을 고쳐도 효과가 없다.
- 설정 `infra/hermes/config.yaml`: D6의 24개 toolset 끔, `approvals.mode: manual`·`unattended_mode: deny`, 텔레메트리·업데이트 확인 끔, **`model:`과 `mcp_servers` 없음**(모델은 #4073, 커넥터는 K 증보의 별도 옵트인).
- 환경: Hermes는 `API_SERVER_*` 4개만 받는다. oort 비밀(DB·마스터 키·JWT)은 전달하지 않는다(D6-2). 모든 값은 `:-`(프로파일이 꺼져도 일반 compose 명령이 요구하지 않는다). `API_SERVER_KEY`가 비면 게이트가 32자 미만으로 거절하므로 시작되지 않는다.
- 헬스체크: 이미지에 없으므로 이미지의 python으로 `127.0.0.1:8642/health`(무인증)를 본다. `start_period 120s`.

### A2. 프로파일 활성화 — 생성기가 env에 쓴다
`--compose`는 `--profile`을 막고 ambient `COMPOSE_PROFILES`를 지운다(정본 env만 권위). 따라서 활성화는 **env 파일의 `COMPOSE_PROFILES=agents`** 한 줄이다(compose가 `--env-file`의 이 키를 읽는 것을 실측). 기본 스택(플래그 없음)은 달라지지 않는다: 키도 서비스도 없다.

### A3. 자동 주입과 D6-5 attest의 의미 변화 (보안 경계)
`scripts/self_host_env.sh --with-agents`가 아래를 한 단위로 쓴다(`oort_cohosted_agent_env_keys` + 기존 `oort_local_provider_env_keys` 이름):
- `COMPOSE_PROFILES=agents`
- `HERMES_API_KEY`: 생성(hex 48자), **이미 있으면 다시 만들지 않는다**. 응답·로그·출력에 값을 내지 않는다.
- `HERMES_BASE_URL=http://hermes:8642/v1`
- `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`, `AGENT_PROVIDER_LOCAL_HOSTS`에 **정확한 호스트 `hermes`**(와일드카드 없음, 이미 있는 목록에 합친다)
- `OORT_COHOSTED_AGENT_TOOLS_LOCKED=1`

**D6-5의 변화.** 지금까지 attest는 「운영자가 체크리스트를 따랐다」는 자기 선언이었다. 번들 배포 모양(compose `agents` 프로파일, Railway 카탈로그)에서는 같은 선언을 생성기·카탈로그가 기록한다. 근거는 **그 서비스가 `lockgate.py gate` exit 0 없이는 listen하지 않는다**는 것이다: api의 프로브가 `ok`이면 게이트를 통과한 Hermes가 응답한 것이다(번들을 고치지 않은 한). 그래도 이것은 oort의 검증이 아니다. oort는 Hermes의 도구를 보지 못하고(D2), 응답·화면은 계속 「운영자의 자기 선언」으로 표기한다(`toolsLockAttested`는 선언을 비출 뿐 증명이 아니다). 선언이 거짓이 되는 길과 막는 방법:
- 운영자가 설정·게이트·시작 명령을 고침 → 문서가 「그 뒷받침을 운영자가 되가져간다」고 명시한다.
- 같은 env가 나중에 외부 Hermes로 향함 → 생성기는 이미 **다른 `HERMES_BASE_URL`이 선언된 env를 거절**하고, 그때 선언을 쓰지 않는다. 사람이 손으로 URL을 바꾸는 것은 막지 못한다(남는 위험).
- 자동 연결은 하지 않는다: 연결은 계속 인스턴스 운영자의 한 번 클릭이다(D3·D4 불변).

**독립 보안 검수(fresh)에서 나와 이 증보에 반영한 것과 남긴 것.**
- 반영: Railway 시작 명령이 `config.yaml`·`lockgate.py`를 디코드한 뒤 **레포 파일의 sha256과 대조**한다(빈·낡은·바꿔치기한 base64 변수가 게이트를 통째로 우회하는 길을 막는다. 검증기가 해시를 다시 계산하므로 두 파일을 고치면 카탈로그도 같은 변경에서 고쳐야 한다). 게이트가 재사용 볼륨의 `/opt/data/.env`도 읽어 `HERMES_YOLO_MODE`·`HERMES_DASHBOARD`·`API_SERVER_CORS_ORIGINS`·짧은 `API_SERVER_KEY`를 거절한다(게이트는 원래 임시 HERMES_HOME만 보았다). 카탈로그 검증기는 hermes의 `public`을 정확한 `false`로, 키 집합을 허용목록으로 고정한다.
- **남김 1 (M1, 서버 변경 필요):** `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`은 정확한 호스트 목록의 전제 스위치이면서 물리 loopback(`localhost`·`127.0.0.1`·`::1`)도 함께 연다(`EgressPolicy::host_exempt`). 이는 ADR-0004 증보 2026-09-08의 기존 의미이고 §3.4.1 수동 경로도 같은 값을 쓰지만, 번들이 자동으로 켜게 되므로 사실을 적어 둔다. 면제는 운영자가 설정하는 URL에만 걸린다. `hermes`만 허용하는 별도 opt-in은 Rust 변경이라 이 증보 밖의 후속이다.
- **남김 2 (M2):** 게이트는 설정과 볼륨 `.env`를 본다. 재사용 볼륨의 `profiles/`·`plugins/`·`skills/`·`mcp-tokens/`와 게이트웨이가 api_server 밖에 올릴 수 있는 플랫폼의 toolset은 판정하지 않는다(미검증). 이 번들이 만든 새 볼륨에서만 잠금을 약속한다. `report`는 live 도구 위반에만 종료하고 인증·CORS·대시보드 검사 실패는 기록만 한다.
- **남김 3 (L5):** hermes는 postgres·centrifugo와 같은 `private` 네트워크에 있다(DB 자격 증명은 주지 않으므로 접속은 안 되지만 격리는 약하다). 전용 네트워크는 host-network 오버레이와의 상호작용 때문에 이 증보에서 하지 않았다. 컨테이너 하드닝(`cap_drop`·`no-new-privileges`)도 측정하지 않았다.
- 문서 정정: 「설정은 매 시작마다 마운트에서 다시 복사된다」는 재시작 사이에만 맞다. 시작 직후 `/opt/data/config.yaml`은 hermes uid 소유가 된다(`-rw-r----- hermes`) — 파일 도구가 꺼져 있고 Hermes가 자기 설정 쓰기를 거부한다는 실측(Phase 1)에 기대는 보장이다.

기각한 대안: (a) oort가 Hermes의 `lockgate report` 결과나 `/v1/toolsets`를 읽어 attest를 대신함 — 새 요청 경로이고 D2(정확히 두 요청)를 바꾼다. (b) attest를 계속 수동으로 — 제로 베이스 목표와 정면충돌. (c) 감지되면 자동 연결 — 기각(D 본문과 같음).

### A4. Railway 카탈로그
`infra/railway/railway.json`에 `hermes` 서비스(비공개, 같은 digest, `/opt/data` 볼륨, 시작 명령 = 같은 모양: 설정·게이트를 base64 변수에서 디코드 → gate → report → exec)를 더하고, api/agent-worker에 같은 배선 변수(api만 attest `1`)를 더한다. `HERMES_API_KEY`는 생성기 정본 키 집합(45)에 넣지 않고(T2 stdout 불변) **프로젝트 shared variable로 운영자가 한 번 만든다**. 카탈로그 검증기(`check_railway_catalog.py`)가 다음을 고정한다: 이미지 digest가 compose와 같다·공개 아님·시작 명령이 게이트-먼저의 정본 명령 목록·oort 비밀 0(compose 쌍둥이 변수 집합)·정확한 호스트·worker에는 attest 없음. 규칙마다 사보타주 14건이 RED다(게이트 제거·`|| true`·sha 대조 제거·낡은 해시·공개·다른 키·oort 비밀·열린 CORS·고정 키·와일드카드 호스트·attest 제거).

### A5. 실측과 남은 것
- compose(arm64, 2026-10-19, 격리 프로젝트): 빈 상태에서 `up -d --wait` → hermes healthy, `LOCKGATE ok=true disabled_count=24`, `LOCKREPORT` 6검사 true, 리스너 `0.0.0.0:8642`(uid 10000), `docker port` 공개 0. 운영자 로그인 후 `GET cohosted-agent` = `declaration: ready, toolsLockAttested: true, connectable: true`, `POST …/probe` = `state: ok, requestsSent: 2, modelCount: 1`, `POST …/connect` = 201(`pinKind: operator_env`). 사보타주: 설정에서 `terminal` 제거 → 게이트 exit 3, 컨테이너 재시작 반복, 프로브 `unreachable`; attest 제거 → `connectable: false`; 호스트 opt-in 제거 → `url_refused`, 요청 0건.
- **D9**: compose는 `0.0.0.0` 실측. Railway는 production environment 생성일 2026-09-23(신규)이고 `hermes-kwak`(#3952)가 `0.0.0.0`으로 동작한 기록을 인용한다. `::`는 여전히 `runtime-unverified`(레거시 environment 미약속).
- **모델 미인증 상태**: Hermes는 모델 없이 뜨고 `/v1/models`는 `hermes-agent` 1개를 200으로 돌려주며, `/v1/chat/completions`는 200 + 본문에 「Provider authentication failed: Hermes is not connected to any AI provider yet」 문구를 낸다. D2의 두 요청으로는 「모델 인증 필요」를 구분할 수 없다(`modelCount`가 1이어도 마찬가지). 카드의 그 상태를 어떻게 낼지는 #4073이 정한다 — 세 번째 요청이나 응답 분류는 D2 변경이므로 이 증보가 하지 않는다.
- 미실측: amd64 런타임(Railway 인용만), 실제 Railway에 이 템플릿의 `hermes` 새 배포, 레거시 environment, 모델 키를 넣은 대화 왕복.

### 바뀌지 않는 것
D1~D5, D7(볼륨 내용·삭제), K1~K7, 프로브의 두 요청, 연결 클릭의 효과(채널·grant 0), 서버 코드(Rust 변경 없음).

### red proof (해당 분기를 지우면 실패해야 한다)
- 렌더된 compose의 시작 명령에서 게이트 호출·`set -eu`를 지우거나 `|| true`를 붙이면 `scripts/tests/test_self_host_env_modes.sh`의 `agents_check`가 실패한다.
- `ports:` 추가·oort 비밀 변수 추가·설정 마운트 쓰기 가능·이미지 digest 제거·와일드카드 호스트·attest 제거 각각이 같은 검사를 실패시킨다.
- Railway 카탈로그에서 같은 항목을 깨면 `check_railway_catalog.py --prove-mutations`가 해당 규칙 이름으로 RED다.
- `infra/hermes/config.yaml`에서 `terminal`을 지우면 `test_default_config.py`가 실패하고, 실제 게이트는 exit 3이다(위 실측).
- `--with-agents` 없이 만든 env에는 `HERMES_*`·`COMPOSE_PROFILES`·attest가 없고 `hermes` 서비스가 렌더되지 않는다.

## 증보 2026-10-19 — 같은 프로젝트 Hermes의 모델 인증에 구독 OAuth 허용

- Status: **Accepted** (2026-10-19, owner 결정 인용). 인용(이슈 #4071, 성재 2026-10-19): 「우리 메신저 대신 hermes oauth로 할때 왜 그게 ADR이 금지한 길이야. 이건 업계에서도 허용된 부분인데. 그냥 해당 ADR금지 부분을 제거해. 당장에 필요하다면 codex oauth로 하고, claude oauth까지 처리할거야. 제로 베이스 온보딩 개선 묶음도 진행 ㄱㄱ 하자.」
- 기안: Sonnet 5.5 worker(#4071)

- **허용한다.** 운영자가 호스팅하는 Hermes(셀프호스트·클라우드 포함)가 **자기 볼륨에** 보관하는 Codex(ChatGPT 구독)·Claude(구독) OAuth 토큰으로 모델 인증을 하는 경로. 로그인과 갱신은 Hermes 자체 흐름이 하고, 절차는 #4073(Hermes 모델 인증 온보딩)이 정한다.
- **oort 쪽 경계는 그대로다(ADR-0004).** oort 서버·api·agent-worker·provider_link 금고·DB·로그·감사·매니페스트는 구독 OAuth 토큰(access·refresh)을 받지도, 저장하지도, 중개하지도, 기록하지도 않는다. 일회용 인가 code·기기 코드는 로그인 중계(ADR-0203 증보 「Hermes 로그인 중계」, ADR-0004 증보 7)에서 저장·로그 없이 1회 중계만 한다. 금고에 구독 OAuth kind를 더하지 않는다. oort가 Hermes 접속에 쓰는 자격은 불투명 bearer(`HERMES_API_KEY`) 하나뿐이고 모델 인증 자격이 아니다(대화 내용은 Hermes로 가지만 구독 토큰은 oort를 지나가지 않는다).
- **사용량과 약관.** 구독 사용량은 그 Hermes **소유자의 구독**에서 나간다(팀원이 Hermes를 불러도 같다). 벤더 약관의 적합성 판단과 책임은 **운영자 몫**이고, oort는 판단하거나 보증하지 않는다. 이 증보 이전의 약관 판단(제3자가 claude.ai 로그인을 제공하거나 토큰을 수집·저장·중개할 수 없다)은 **oort가 하는 일**에 대한 것으로 그대로 남고, Hermes가 자기 볼륨의 구독으로 인증하는 경로의 적합성은 운영자가 판단한다.
- **적용되지 않는 것(별개 경로).** oort 서버가 구독 CLI를 대신 구동하는 경로를 막는 ADR-0193 D6·D17·D18과 공용(워크스페이스·클라우드) work host 차단(`MOMO_SUBSCRIPTION_AGENTS_ENABLED`, `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`, `claude_subscription_agent_paused`)은 **Hermes 경로에는 적용되지 않는다.** 이 증보는 그 코드 동작을 바꾸지 않는다. 서버 내장 구독 에이전트 차단을 풀지는 별도 확인이 필요하다(owner 미결정).
- **볼륨 목록.** D7 볼륨 목록에 **구독 OAuth 토큰(Codex·Claude, 고가치)** 을 더한다. 대화 기록·`mcp-tokens/`와 같은 볼륨이며 oort DB의 RLS·백업 밖이다. 개인정보 안내문에 「Hermes 볼륨에 AI 구독 로그인 토큰이 남아요」를 더한다. 회수는 벤더 쪽 로그아웃·연결 해제와 Hermes 볼륨의 해당 파일 삭제다(oort에는 지울 사본이 없다).
- **공동 호스팅 판정은 그대로다.** 이 증보는 감지·연결(D1~D5)·도구 잠금(D6)을 바꾸지 않는다. oort는 Hermes가 어떤 방식으로 모델 인증을 하는지 알 수 없고 알 필요도 없다.
## 증보 2026-10-19 — Hermes 로그인 중계: oort 화면에서 모델 인증(Codex·Claude)과 앱 로그인

- Status: **Accepted** (2026-10-19, owner 결정 Q1~Q3 — 아래 「owner 결정」에 인용). 이슈 #4073 설계·스파이크 산출물이고 이 증보는 코드를 바꾸지 않았다. 구현은 이슈 L-S1~L-S5로 나눈다.
- 기안: Sonnet 5.5 worker (#4073)
- 계기: 성재 2026-10-19(#4073·#4074 원문): 「우리 메신저 대신 hermes oauth로 할때 왜 그게 ADR이 금지한 길이야 … 당장에 필요하다면 codex oauth로 하고, claude oauth까지 처리할거야」. 허용 자체는 #4071(ADR-0004 증보 6, 위 「증보 2026-10-19 — … 구독 OAuth 허용」, **머지 전일 수 있다**)이 정했고, 이 증보는 그 허용을 **화면에서 어떻게 실행하는가**를 정한다.
- 근거 실측: `docs/planning/research/2026-10-19-hermes-login-relay-spike.md`(Hermes v0.22.2 공식 이미지 digest `36099926…c2919`, 로컬 Docker, 실제 벤더 로그인 0건). 표기: [V] 직접 확인 · [소스] 이미지 소스 · `runtime-unverified`.
- 이 증보는 D1~D9·K1~K7을 바꾸지 않는다. ADR-0004 증보 6의 oort 쪽 경계를 **한 곳만** 좁게 연다: 일회용 인가 code·기기 코드의 1회 중계(Q1, ADR-0004 증보 7).

### L0. 실측이 정한 사실

1. oort가 부르는 게이트웨이 API(8642)에는 로그인 라우트가 **없다** [V]. 로그인 관리 API는 별도 프로세스 `hermes dashboard`(9119)에만 있다.
2. 대시보드의 Codex API는 **기기 코드 흐름**(`verification_url` + `user_code` + 폴링)이다 [V]. 사용자가 붙여넣을 것이 없다.
3. 대시보드의 Claude API는 Hermes가 **일부러 막았다**(`400 anthropic uses an external CLI`, 「scriptable HTTP endpoint mint Claude Pro/Max subscription tokens … against its OAuth usage policies」) [V][소스]. CLI `hermes auth add anthropic --type oauth --no-browser`만 되고 인가 URL 출력 → stdin에서 `code#state` 한 줄이다.
4. MCP 앱 로그인은 CLI(`hermes mcp login`)와 대시보드 둘 다 인가 URL 출력 후 `code`+`state`를 받는다 [V]. 둘 다 `initialize`·`tools/list`만 보므로 **Google 세 서버는 시작되지 않는다**(K-S1b, #4067) — `infra/hermes/mcp_login_probe.py` 방식이 필요하다 [소스, 대시보드 경로의 Google 시도는 `runtime-unverified`].
5. 대시보드를 oort가 부르는 것은 **안 된다**: 루프백 인증 토큰이 인증 없는 `GET /` HTML에 들어 있다 [V]. 비루프백은 쿠키 로그인(비밀번호/OAuth)을 요구한다 [소스 s6 `dashboard/run`]. 같은 프로세스가 MCP 서버 추가(stdio `command` = 임의 실행)·설정 쓰기를 연다 [소스, 서버 추가 API는 실행하지 않았고 `POST /api/mcp/servers`의 http 서버 추가만 [V]]. D6 도구 잠금과 충돌한다.
6. 세 로그인 모두 「URL(또는 기기 코드) 출력 → (선택) stdin 한 줄 → 종료 코드」 모양이다. **끝까지 돌려 본 것은 모의 MCP의 `hermes mcp login` 하나뿐이다** [V]: 자식 프로세스 중계가 완주했고 출력에 토큰·code 값이 0바이트였다. Codex는 시작·폴링·취소와 CLI의 URL+코드 출력까지 [V], Claude는 CLI의 URL 출력과 EOF 종료까지 [V]이고, 두 provider의 승인 뒤 동작과 `mcp_login_probe.py`의 출력은 **`runtime-unverified`**다(같은 모양이라는 것은 추정이다).
7. Railway 볼륨은 서비스별이다(D7). 「같은 볼륨의 사이드카」는 Railway에서는 **Hermes 컨테이너 안의 프로세스**여야 한다. docker compose에서는 같은 볼륨을 공유하는 별도 컨테이너도 된다.

### L1. 후보 비교와 결정

| | (a) Hermes 기존 API | (b) 사이드카 | (c) 운영자 셸 명령 표시 |
|---|---|---|---|
| Codex | 대시보드 API로 됨, 그러나 oort가 인증하며 부를 길이 없음(L0-5) | 됨(CLI 또는 대시보드를 루프백으로 내부 사용) | 됨 |
| Claude | 불가(Hermes가 막음) | 됨(CLI 중계) | 됨 |
| MCP 앱 | Google 시작 안 됨(L0-4) | 됨(`mcp_login_probe.py` 포함) | 됨(지금 방식, `railway ssh`) |
| 붙여넣은 code가 oort를 지나가나 | 예 | 예(Claude·MCP). Codex는 아니오 | 아니오 |
| 새 공격 표면 | 대시보드 전체 | 좁은 중계 하나(키 1개) | 없음 |
| 운영 부담 | 대시보드 인증 설정 | 시작 명령에 프로세스 하나 | 운영자가 셸 필요(제로 베이스 온보딩의 목표와 반대) |

**결정(제안)**: **(b)를 기본**으로 하고 **(c)를 항상 있는 대체 경로**로 둔다. (a)는 쓰지 않는다. 사이드카가 켜져 있지 않으면(env 없음) 화면은 (c)의 명령을 보여 준다 — 사이드카는 선택이고 없어도 Hermes 연결은 그대로 동작한다.

### L2. 사이드카 규격 (`oort-login-relay`, 이름 후보)

- **위치**: Hermes 컨테이너 안의 별도 프로세스(Python, Hermes venv의 stdlib만 — 신규 의존 없음). 시작 명령이 `lockgate.py` 통과 뒤 게이트웨이 앞에서 백그라운드로 띄운다(Railway 시작 명령은 이미 이미지 ENTRYPOINT를 대체한다, K-S1a §1). compose에서는 같은 이미지·같은 볼륨의 별도 서비스도 허용한다. `hermes` 사용자로 실행한다(root면 토큰이 root 소유가 된다, K-S1a §5.1). 대시보드는 **띄우지 않는다**(`HERMES_DASHBOARD` 미설정, 320 MB 절약).
- **바인딩**: 내부 네트워크 인터페이스만(Railway `::`/`0.0.0.0` 선택은 D9와 같은 규칙), compose `ports:` 없음. 공개 도메인을 붙이지 않는다.
- **키**: 별도 비밀 `HERMES_LOGIN_RELAY_KEY`(이름 후보, 256비트 이상 무작위)를 Hermes 서비스에 둔다. **`API_SERVER_KEY`/`HERMES_API_KEY`와 다른 값**이다(채팅 키가 샜을 때 로그인 권한이 같이 넘어가지 않게). oort는 같은 값을 `api` 서비스 env `HERMES_LOGIN_RELAY_KEY`/`HERMES_LOGIN_RELAY_URL`로 받는다. 요청마다 `Authorization: Bearer`를 상수 시간 비교한다. 키가 없으면 프로세스를 띄우지 않는다. oort→사이드카 주소는 내부 호스트라 egress 가드의 정확 일치 opt-in이 필요하다(D9, ADR-0004 증보 5와 같은 방식).
  - **키가 새면 무엇이 되나(보안 검수 H1)**: 키가 있으면 공격자가 `POST /v1/login`으로 URL을 받아 **자기 계정으로 승인**하고 Hermes를 자기 계정에 묶을 수 있다(토큰을 읽는 것은 아니다 — 토큰은 어느 요청에도 나오지 않는다). `operator`는 호출자가 채우는 라벨이라 키가 샌 경우에 막아 주지 못한다. 그래서 키를 **에이전트가 읽지 못하게** 둔다: 시작 명령(root)이 키를 `0400` 파일(소유자 = 사이드카 전용 uid, `hermes` 사용자가 못 읽는다)로 받아 쓰고 env에서 지우며, 사이드카는 자식 `hermes` CLI만 `hermes` uid로 낮춰 띄우고 **자식 env에는 키가 없다**(정제한 env만 넘긴다). 같은 uid·같은 env였다면 Hermes가 `file`·`terminal` 도구로 `/proc/<pid>/environ`을 읽는 프롬프트 주입 경로가 열린다 — D6은 `terminal`·`code_execution`·`browser`를 끄지만 `file` 도구는 끄지 않으므로(K4는 권고만) **uid 분리가 키 보호의 근거**이고 구현 이슈가 실제 Railway 시작 명령에서 이 분리가 가능한지 확인한다(`runtime-unverified`). 회전: 새 값을 Hermes와 oort 양쪽에 넣고 둘 다 재시작한다(무중단 보장 안 함).
- **구동하는 명령은 고정 목록이다.** 요청이 명령·인자를 정하지 못한다. 요청의 `kind`·`target`은 열거형 검증을 통과해야 한다:
  - `provider/openai-codex` → `hermes auth add openai-codex --type oauth --no-browser`
  - `provider/anthropic` → `hermes auth add anthropic --type oauth --no-browser`
  - `mcp/<server>` → 서버 이름은 `^[a-z0-9][a-z0-9_-]{0,63}$`를 통과하고 **`config.yaml`의 `mcp_servers` 키와 정확히 일치하며 `auth: oauth`**인 것만(보안 검수 M4: `-`로 시작하는 이름이 인자 주입이 되지 않게). 읽기 호출이 필요한 Google 세 서버는 `mcp_login_probe.py <server>`, 그 밖은 `hermes mcp login -- <server>`.
  - 모든 자식은 `shell=False`, `hermes` 절대 경로, 정제한 env(`HOME=/opt/data`, `PATH`만), 새 프로세스 그룹(`start_new_session`)으로 띄운다.
- **API** (JSON, 응답에 토큰·code 값 없음):
  - `POST /v1/login` `{kind, target, operator}` → `{login_id, mode, url, user_code?, expires_at}`. `mode`는 `device`(Codex: URL+코드를 보여 주고 폴링) 또는 `paste`(Claude·MCP: URL을 열고 돌아온 값을 붙여넣음). 자식 프로세스를 띄우고 출력에서 URL(과 기기 코드)을 찾을 때까지 기다린다(상한 30초). `login_id`는 예측 불가능한 값(≥128비트). **화면에 내보내는 URL은 검증을 통과한 것만이다**(보안 검수 M2 — 서버·AS 메타데이터나 오류 문구가 만든 URL을 그대로 「열기」에 달면 피싱·`javascript:`·오픈 리다이렉트가 된다): ① `https` 한정(구현 시험 하네스의 루프백 모의만 `http://127.0.0.1` 허용, 플래그로), userinfo 없음 ② provider는 호스트 허용목록(`auth.openai.com`, `claude.ai` — 실측 URL의 호스트, 벤더가 바꾸면 갱신) ③ MCP는 설정된 서버 origin 또는 그 서버의 AS 메타데이터가 선언한 `authorization_endpoint` 호스트와 같아야 한다 ④ 「Open this URL」 같은 **정해진 안내 줄 바로 다음 URL**만 파싱하고 임의 줄의 첫 URL을 쓰지 않는다. 화면은 URL의 **호스트를 강조 표시**하고 링크에 `rel="noopener noreferrer"`를 둔다.
  - `POST /v1/login/{login_id}/complete` `{pasted}`(헤더 `X-Operator`) → `{status}`. `paste` 모드만. 아래 L3의 파싱·검증을 거쳐 자식 stdin에 한 줄을 쓴다.
  - `GET /v1/login/{login_id}`(헤더 `X-Operator`) → `{status: pending|done|failed|expired|cancelled, reason?}`. `reason`은 고정 열거형(`state_mismatch`·`timeout`·`vendor_denied`·`exit_nonzero`·…)이고 자식 출력 원문을 담지 않는다.
  - `DELETE /v1/login/{login_id}`(헤더 `X-Operator`, 시작한 운영자만) → 자식 프로세스 **그룹**을 끝낸다(취소). `operator`는 URL 쿼리에 두지 않는다(접근 로그에 남는다).
  - `GET /v1/status` → 대상별 `{connected, kind}`(`/v1/login/{id}`와 경로가 겹치지 않게 분리). 비밀 아닌 신호만: `hermes auth status <provider>`의 판정(**문구가 아니라 종료 코드나 구조화 필드로 판정** — 「logged out」 문구만 실측했고 「logged in」 문구는 못 봤다), `mcp-tokens/<server>.json` 존재(내용은 읽지 않는다). 만료 임박 판정은 K-S1a §5.2처럼 **추정**이고 단정하지 않는다.
- **상태기계와 TTL**: 동시에 하나의 로그인만 `(kind, target)`당 허용(`409 login_in_progress`). 시작 요청은 운영자·분당 횟수를 제한한다(Codex 시작은 실제 벤더를 부른다). 자식 프로세스는 TTL이 끝나면 죽인다 — Codex 900초(벤더 `expires_in`), `paste` 모드 300초(Hermes MCP 콜백 대기와 같다). 완료·실패·만료 뒤 세션 객체는 60초 안에 지운다. 상태는 메모리에만 둔다(재시작하면 사라져도 괜찮다 — 처음부터 다시 누르면 된다). TTL 종료는 자식 **프로세스 그룹**을 죽여 손자 프로세스(`hermes`가 띄우는 것)까지 남지 않게 한다.
- **로그 규칙**: 자식 stdout/stderr는 **메모리 버퍼에서 URL과 기기 코드를 찾는 데만 쓰고** 사이드카 로그에 쓰지 않는다. 사이드카 로그에는 `login_id` 앞 8자, kind/target, 상태 전이, 종료 코드, 경과 시간만 남긴다. 붙여넣은 값·인가 URL·기기 코드는 로그·오류 응답·예외 메시지·`/proc` 인자에 넣지 않는다(stdin 파이프로만 전달하고 argv에 두지 않는다).

### L3. 붙여넣기 처리와 state 확인

- 입력은 두 모양을 받는다: 브라우저 주소창 URL(`…?code=…&state=…`, MCP), `code#state`(Claude, [소스 `agent/anthropic_credentials.py:792-800`]). **붙여넣은 URL을 어디에도 요청하지 않는다**(fetch 금지 — SSRF 방지). 문자열 파싱만 한다.
- 검증은 **사이드카가 한다**. oort는 길이·줄바꿈 같은 모양 검사만 앞에서 하고 `state`·`redirect_uri`는 알지도 저장하지도 않는다(보안 검수 M5: oort가 검증하려면 `start`와 `complete` 사이에 `state`를 들고 있어야 해서 「저장 금지」와 모순이고, `api` 레플리카가 여럿이면 어디에 둘지도 정해야 한다 — 사이드카 한 곳에만 둔다).
  1. 길이 상한(2 KiB), 줄바꿈·NUL 없음(stdin에 한 줄만 쓴다), **`skip` 같은 명령어 값 거부**.
  2. URL 모양이면 **표준 URL 파서로** 스킴·호스트·포트·경로가 이 로그인에서 기대한 `redirect_uri`와 같을 때만 받는다(`http://127.0.0.1:<고정 포트>/callback` 등; userinfo가 있는 `http://127.0.0.1@evil/…` 같은 모양은 파서가 호스트를 `evil`로 보므로 거부된다). 다르면 `400 redirect_mismatch`.
  2b. **정규 재구성**: 붙여넣은 문자열을 그대로 쓰지 않는다. 파서로 `code`와 `state`만 뽑고 다른 쿼리 파라미터(`error`·`iss` 등)가 있으면 `400`, 그다음 `<기대한 redirect_uri>?code=<code>&state=<state>`(MCP) 또는 `<code>#<state>`(Claude)로 **우리가 다시 만들어** stdin에 쓴다. `code`·`state`는 문자 집합 정규식(`[A-Za-z0-9._~-]`)으로 제한한다.
  3. `state`가 **인가 URL에서 사이드카가 파싱해 둔 값과 상수 시간으로 같을 때만** 자식 stdin에 쓴다. 틀리면 stdin에 쓰지 않고 `400 state_mismatch`(로그인은 계속 `pending`, 같은 `login_id`로 다시 붙일 수 있다 — 단 시도 3회 후 취소).
  4. **한 번만**: 한 로그인에 `complete` 성공 처리는 1회. 두 번째는 `409 already_submitted`.
- 이 검증은 Hermes/SDK 안의 비교를 대체하지 않고 앞에 더한 것이다: MCP는 SDK가 `State parameter mismatch`로 거부 [V], Claude는 `received_state != oauth_state` [소스, 비상수 시간], Codex는 붙여넣기 자체가 없다.

### L4. oort API와 보안 경계

- **라우트(후보)**: `POST/GET/DELETE /v1/workspaces/{ws}/agents/{agent}/model-login[/{login_id}]`(provider)와 `…/app-login`(MCP 앱, #4074). K-S2의 `connector-trial` 라우트와 같은 계열이다 — **인스턴스 운영자 전용**(D3, `PLATFORM_ADMIN_EMAILS`), 에이전트는 운영자 본인이 연결한 Hermes(`agent_provider_pin.kind='operator_env'`), 사이드카 env가 없으면 `409 login_relay_off`(화면은 (c)를 보인다).
- **oort가 저장하는 것**: 새 테이블 **없음**. 감사 한 줄(기존 감사 경로): 행위자, `kind/target`, 시작·완료·실패 여부, 사이드카 `reason` 열거형. `login_id`는 응답 중계에만 쓰고 저장하지 않는다. **저장·로그·감사·메트릭·에러 리포트에 쓰지 않는 것**: 인가 URL 전체, 기기 코드, 붙여넣은 값, 그 값에서 파싱한 `code`/`state`. **기기 코드(`user_code`)는 계정 결합에 쓰이는 값**이다 — 본 사람은 누구든 자기 계정으로 승인해 Hermes를 자기 계정에 묶을 수 있다(보안 검수 M7). 시작 요청의 응답으로만 전달하고(폴링·Centrifugo·푸시·알림·감사·DB에 넣지 않는다) `Cache-Control: no-store`를 붙인다.
- **oort가 통과시키는 것**: 응답 `{url, user_code}`(화면 표시용), 요청 `{pasted}`(사이드카로 그대로). `pasted`는 요청 본문 구조체의 필드로만 존재하고 **`Debug`/`Serialize`로 찍히지 않는 타입**(마스킹 래퍼)에 담긴다. 요청 본문 로깅·트레이싱 계층은 이 라우트에서 본문을 기록하지 않는다. `url`에는 `state`·`code_challenge`가 있어 비밀은 아니지만 로그에는 쓰지 않는다.
- **CSRF**: oort API는 `Authorization` 헤더 토큰이라 브라우저가 자동으로 붙이는 쿠키 CSRF 표면이 없다(ADR-0119 v0). **이 주장은 시한부다** — ADR-0119는 「공개 알파 전 refresh 쿠키 승격」을 예약했으므로, 쿠키 인증이 도입되면 이 라우트에 `Origin` 검증과 사용자 정의 헤더 요구를 더해야 한다(구현 이슈의 후속 조건으로 적는다). 이 흐름에 실제로 필요한 방어는 **로그인 고정(login CSRF)** — 공격자가 자기 계정의 code를 운영자가 붙이게 만들어 Hermes를 공격자 계정에 묶는 것 — 이다. 층이 셋이다: ① 벤더/SDK의 `state`·PKCE(Hermes 안, 비밀이 아닌 `state`와 `code_verifier`는 Hermes 프로세스에만), ② 사이드카의 `login_id`·`operator`·`state` 상수 시간 비교와 일회성(L3), ③ oort의 운영자 인증 + 「이 운영자가 시작한 `login_id`」만 `complete` 가능(사이드카가 `operator`를 대조). 각 흐름의 실제 방어선: Codex는 벤더 페이지에서 사용자가 코드를 입력하는 기기 흐름이라 login CSRF 표면이 작고(코드는 사용자 화면에서만), Claude·MCP는 ①②가 방어선이다.
- **운영자 전용 + 에이전트 소유**: 비운영자 `403`. 같은 Hermes가 `operator_env`로 여러 워크스페이스에 고정돼 있으면 한 곳의 로그인이 전부에 영향을 준다(구독·앱 토큰이 볼륨 하나) — K-S2의 핀 대조를 그대로 적용하고 화면 문구에 쓴다. 워크스페이스에 사람 멤버가 2명 이상이면 K2·K-S2와 같은 이유로 앱 로그인은 `409 connector_trial_*` 계열을 따른다(토큰이 사람별이 아니므로). 모델 로그인(provider)은 팀 전체가 쓰는 Hermes의 구독이라는 점을 화면 문구에 쓴다(#4071: 사용량은 소유자 구독에서 나간다).
- **데이터 흐름의 비밀 목록**: ① `user_code`(기기 코드, 화면 표시용, 900초) ② 인가 URL의 `state`(비밀 아님, 300초) ③ **붙여넣은 `code`(일회용, PKCE 없이는 교환 불가, 최대 300초)** ④ 토큰(access·refresh)은 oort를 **지나가지도 않는다** — Hermes 프로세스가 벤더와 직접 교환하고 `/opt/data`(`auth.json`, `mcp-tokens/`)에만 쓴다.
- **표시 방식**: 인가 URL·기기 코드는 화면에 표시하되 클립보드 복사 버튼과 「열기」 버튼만 둔다. 화면을 닫으면(또는 TTL 뒤) 즉시 지운다(상태 객체 폐기, 입력란 비움). 폰에서는 외부 브라우저를 연다(앱 내 웹뷰로 열지 않는다 — 벤더 로그인을 앱이 들여다보지 않는다).

### L5. 모델 provider 설정

로그인만 되고 `model.provider`/`model.default`가 그 provider를 가리키지 않으면 쓰이지 않는다. Railway 부팅은 `config.yaml`을 `HERMES_CONFIG_B64`로 덮어쓰므로 **운영자 설정 템플릿이 provider를 정하고**, 중계는 자격만 만든다. 화면은 로그인 직후 「모델 설정이 이 provider인지」를 `GET /api/model/options`(`runtime-unverified`) 또는 능동 채팅 1회 시험으로 확인하는 별도 단계를 둔다. 승인 뒤 **돌고 있는 게이트웨이가 재시작 없이 새 자격을 집는지는 `runtime-unverified`** — 구현 첫 단계에서 모의 provider로 확인하고, 안 되면 완료 후 게이트웨이 재시작 안내를 화면에 낸다. 사이드카는 설정 파일을 쓰지 않는다.

### L6. 기각한 대안

- **대시보드를 oort 내부 서비스로 노출(a)**: L0-5. 인증 모양이 안 맞고 MCP 설정 쓰기가 D6을 무력화한다. 공식 이미지의 s6 주석 자체가 「unauthenticated public dashboards were the entry point for the MCP-config persistence campaign」이라고 적는다.
- **별도 Railway 서비스 사이드카**: 볼륨이 서비스별이라 토큰을 쓸 곳을 공유하지 못한다.
- **붙여넣기 없이 브라우저가 Hermes 콜백으로 직접 돌아오게**: Hermes를 공개 도메인에 열어야 하고(D1·D9의 「공개 노출 없음」 위반), 로그인 콜백만 열어도 같은 프로세스·같은 경계에 공개 입구가 생긴다.
- **oort가 PKCE를 직접 하고 토큰을 Hermes 파일에 주입**: oort가 토큰을 받는다. ADR-0004 위반.
- **Claude를 위한 앱 내 웹뷰/Claude Code 설치 토큰**: 범위 밖.

### owner 결정 (2026-10-19 확정)

성재 2026-10-19, 이슈 #4073 owner 결정(코디네이터 전달). 아래 셋은 위 제안(Q1~Q3)에 대한 답이다.

- **Q1 허용.** 일회용 인가 code(Claude·MCP 붙여넣기)와 기기 코드(Codex)가 oort를 **1회 중계**로 지나가는 것을 허용한다. 조건은 제안 그대로다: (1) 운영자 요청 본문 필드로만 받고 응답 필드로만 내보내며 (2) 한 요청 안에서 사이드카로 그대로 넘기고 (3) 저장·로그·감사·메트릭·응답 에러·푸시·Centrifugo에 쓰지 않는다. code는 PKCE `code_verifier`(Hermes 프로세스에만 있음) 없이는 교환할 수 없고 일회용·≤300초다. **토큰(access·refresh)은 어떤 경우에도 oort를 지나가지 않고 Hermes가 소유한다.** ADR-0004 표 행·규칙 2·감사 항목은 **ADR-0004 증보 7**이 개정한다.
- **Q2 중계한다.** Claude 구독 로그인도 oort 화면에서 시작해 Hermes CLI(`hermes auth add anthropic --type oauth --no-browser`)를 경유해 중계한다. 약관 적합성 판단과 책임은 #4071(ADR-0004 증보 6)대로 운영자 몫이고, 화면에는 「이 로그인은 운영자 본인 구독이며 약관 책임은 운영자에게 있어요」 한 줄을 시작 전에 보인다. Hermes 자체가 대시보드 HTTP 노출을 거부한 흐름(L0-3)을 oort가 사이드카로 노출하는 것이므로, 사이드카 키가 없으면 이 경로는 꺼진 상태다.
- **Q3 설치 스크립트로 켠다.** 사이드카는 설치 스크립트가 켠다: #4072가 `HERMES_LOGIN_RELAY_KEY`를 자동 생성해 Hermes 서비스와 oort `api`에 같은 값을 넣는다. **키가 없으면 꺼진 상태**(사이드카 프로세스 없음, oort `409 login_relay_off`, 화면은 (c) 셸 명령 표시)이고, 수동 설치는 기존 동작 그대로다. L2의 키 보호(0400 파일·uid 분리·자식 env 제거)는 자동 생성 경로에도 그대로 적용한다.

### 구현 슬라이스 (Accept 후, 별도 이슈)

1. **L-S1 사이드카**: 프로세스(고정 명령 목록·자식 구동·URL/기기 코드 파싱·상태기계·TTL·로그 규칙), 시작 명령 통합(Railway)·compose `agents` 프로파일 서비스, 키 env. 모의 AS/MCP로 시험(실제 벤더 없이), 승인 뒤 게이트웨이가 자격을 집는지와 `redirect_uri` 설정 효과 확인 포함.
2. **L-S2 oort API**: 운영자 전용 라우트·`login_relay_off` 분기·마스킹 래퍼·감사, 토큰 0바이트 경계 시험(아래 red proof), `lockgate`의 영향 확인.
3. **L-S3 웹·폰 화면(#4073)**: 설정 › AI 연결과 웰컴의 API 키/Codex/Claude 선택, URL·기기 코드 표시, 붙여넣기 입력, (c) 대체 문구, 캡처·design-review.
4. **L-S4 앱 로그인 화면(#4074)**: 앱별 연결 상태·만료 추정, Google `mcp_login_probe.py` 경로, 만료(External Testing 7일, #4069) 표시.
5. **L-S5 설정 템플릿**: `model.provider` 기본값, 로그인 후 확인 단계(L5).

### red proof (구현이 인용할 것 — 해당 분기를 지우면 실패해야 한다)

1. **토큰·code 0바이트**(Codex·Claude·MCP·`mcp_login_probe.py` 경로 **각각**에서 — 이번 실측은 모의 MCP의 `hermes mcp login` 하나만 잼): 모의 AS가 `MOCK-ACCESS-TOKEN-…`·`MOCK-REFRESH-TOKEN-…`을 발급하고 시험이 붙여넣는 code에 표식(`MARKER-CODE-…`)을 넣는다. 끝난 뒤 oort `api` 로그 전체, DB 덤프, 모든 HTTP 응답 본문, 감사 행, 사이드카 로그에서 표식 3종이 **0건**이어야 한다. 표식이 `/opt/data`에는 있어야 한다(시험이 실제로 완주했음을 증명하는 양성 대조).
2. 요청 본문 로깅을 켠 채로도 위가 0건(마스킹 래퍼를 일부러 `String`으로 바꾸면 실패).
3. state 불일치는 stdin에 아무것도 쓰지 않는다(자식 stdin 스파이로 확인), redirect 호스트 불일치 `400`, 같은 `login_id` 두 번째 `complete` `409`.
4. 비운영자 `403`, 키 없음 `409 login_relay_off`, 다른 운영자의 `login_id`로 `complete` 거부.
5. TTL 뒤 자식 프로세스가 남아 있지 않다(PID 생존 확인).
6. 고정 명령 목록 밖의 `target`(`../`, 셸 메타문자, `-`로 시작하는 이름, 설정에 없는 서버)은 프로세스를 띄우기 전에 거부된다.
7. 화면에 내보내는 URL: `http://`·`javascript:`·userinfo·허용목록 밖 호스트·안내 줄 밖의 URL은 거부(출력을 스텁으로 주입해 확인).
8. 붙여넣기 재구성: 추가 파라미터(`error=`·`iss=`)·`skip`·`http://127.0.0.1@evil/…`는 `400`, 자식 stdin에 아무것도 쓰이지 않는다.
9. 키 분리: 자식 프로세스의 env·`/proc/<pid>/environ`에 `HERMES_LOGIN_RELAY_KEY`가 없고, `hermes` uid로 키 파일을 못 읽는다.
10. 로그인 전후 `config.yaml` 해시 불변(CLI 경로가 설정을 쓰는지는 이번에 재지 않았다 — 쓰면 `lockgate`의 `mcp_servers` 검사와 부딪힌다).
11. TTL 뒤 프로세스 **그룹**에 생존 PID 0.

### 바뀌지 않는 것

D1~D9, K1~K7, 게이트웨이 `/v1/chat/completions` SSE 경로(D5), `HERMES_API_KEY` 의미, oort가 토큰을 소유·저장하지 않는다는 불변식, `lockgate.py` 규칙(사이드카 기동은 시작 명령의 추가 한 줄이고 게이트 통과 뒤에 온다).

## 증보 2026-10-20 — 같은 서버 Hermes의 모델 고르기

- Status: **Accepted** (2026-10-20, owner 승인). 인용(코디네이터 전달, 성재 2026-10-20 AskUserQuestion): 「승인 (Recommended)」 — 이 설계로 구현하는 것을 승인, 「추린 목록 (Recommended)」 — 서버는 제공자별 전체 목록을 주되 모델마다 `featured`를 붙이고, UI는 featured만 기본으로 보여 주며 「전체 보기」로 나머지를 연다.
- 기안: Sonnet 5.5 worker (#4143). 구현은 같은 PR(서버·워커). 화면은 별도 이슈(UXUI)다.
- 계기: 연결한 Hermes가 어느 제공자의 어느 모델로 답하는지 oort에서 보이지도 고를 수도 없었다. connect가 핀의 모델에 적던 값은 Hermes의 **가상 별칭** `hermes-agent` 하나뿐이라 실제 모델 정보가 아니었다.
- 표기: [V] 직접 확인(이슈 #4143 1단계 실측 코멘트, 이 PR의 시험) · [소스] Hermes 소스 읽기 · `runtime-unverified`.

### 확인한 사실

- [V] `GET {origin}/api/model/options`(게이트웨이 8642, `HERMES_API_KEY` bearer)가 200으로 `{"model": "...", "provider": "...", "providers": [{"slug", "is_current", "authenticated", "models": [...]}, ...]}`를 준다. `authenticated: false`인 제공자(로그인 안 된 것)는 `models`가 비어 있거나 빈 골격 행이다. 형태는 Hermes 소스 `hermes_cli/inventory.py`의 `build_models_payload`와 `web_server.py`의 라우트에서 확인했다 [소스].
- [V] `POST /v1/chat/completions`에서 `model`만 바꾸면 Hermes는 **조용히 무시하고 기본 모델로 답한다**(토큰 수 4799 그대로). 응답의 `model` 필드는 요청 값을 그대로 되돌려 주므로(존재하지 않는 `claude-opus-4-1`도 200) 그 필드로 실제 모델을 판단할 수 없다. 요청 본문에 `provider`를 **함께** 보내면 적용된다(토큰 수 3513, 다른 제공자가 처리). 소스상 bare `model`은 `direct_model_requests`(기본 false)일 때만, 명시 `provider`가 있으면 항상 적용된다 [소스].
- [V] Hermes 쪽 전역 기본값을 바꾸는 API는 없다(`admin_config_rw: false`). 그래서 이 증보는 Hermes 설정을 바꾸지 않고 **요청별 지정**만 쓴다.

### M1. 핀에 `provider`와 `model`을 한 쌍으로 저장한다 (migration 144)

- `agent_provider_pin`에 `model_provider text NULL`, `model_id text NULL`을 더한다(ADR-0147 증보 2026-10-16의 표 확장). 핀은 JSON 칸이 없는 평평한 표라 **마이그레이션이 필요**하다. 모든 문장이 가드되어 재적용해도 무해하고, 기존 행은 둘 다 NULL이다.
- CHECK 세 개: (a) 한 쌍이어야 한다(둘 다 NULL이거나 둘 다 값), (b) 값은 `kind = 'operator_env'` 핀에만, (c) 형식(`provider` = `[a-z0-9][a-z0-9._-]{0,63}`, `model` = 영숫자로 시작하고 `._:/@+-`만 쓰는 최대 128자 — DB CHECK는 백스톱이고, 서버가 실제로 받는 상한은 `sanitized_model_id`의 **64바이트**다. 64 ≤ 128이라 코드를 통과한 쌍은 항상 저장되며, 시험이 마이그레이션의 128과 코드 상한의 관계를 고정한다 — #4159 L3). `upsert_agent_pin`은 충돌 갱신 때 둘을 NULL로 되돌린다 — 다른 핀으로 바꾸면 이전 제공자가 따라붙을 수 없다. 쌍은 `set_agent_pin_model`만 쓴다.
- **하위 호환(핵심 불변식).** 둘 다 NULL = 오늘과 같다. 워커는 `agent.model`을 그대로 보내고 `provider`를 싣지 않는다. 실제 모델 id를 `agent.model`에 적으면서 핀에 제공자가 없으면 Hermes가 그 모델을 무시하고 기본 모델로 답하므로 **그 조합은 만들지 않는다**: 한 트랜잭션에서 핀의 쌍과 `agent.model`(카드·사용량 표시용 거울)을 함께 쓴다. 반쪽 쌍이 읽혀도 워커는 쌍으로 취급하지 않는다.

### M2. 서버가 Hermes `/api/model/options`를 읽어 「로그인된 제공자의 모델」만 선택지로 노출한다

- **D2의 고정 요청 목록이 하나 늘어난다.** 호출은 같은 `momo-provider-probe` 경로(같은 `EgressPolicy`, 연결 시점 resolver, redirect 없음, 프록시 없음, 같은 선언 호스트, 같은 bearer)이고 `GET {origin}/api/model/options` **읽기 하나**다. 경로는 상수이며 `/v1` 아래가 아니라 origin 아래다. 선언 URL의 경로는 계속 비거나 `/v1`만 허용한다. `/health`·`/v1/models`·`/v1/toolsets`는 그대로다.
- 응답 본문은 크레이트 밖으로 나가지 않는다. 나가는 것은 **정제된 제공자 슬러그**(위 형식)와 **정제된 모델 id**(`sanitized_model_id`, 64바이트, 목록당 최대 100개, 중복 제거, bearer의 8바이트 조각을 담은 id 제외)뿐이다. Hermes가 준 표시 이름·설명·가격은 쓰지 않는다. 표시명은 oort 쪽 표(UXUI)가 슬러그로 매핑한다.
- **`authenticated`가 불리언 `true`인 제공자만** 남긴다(문자열 `"true"`·누락·`false`는 탈락). 로그인되지 않은 제공자가 모델 목록을 들고 있어도 노출하지 않는다.
- 새 읽기 요청은 `probe`가 아니라 모델 라우트(M3)와 connect만 보낸다. `probe`는 여전히 두 요청(+ 요청 시 toolsets)이다.

### M3. API (운영자 전용, D3의 게이트 그대로)

| 라우트 | 하는 일 |
|---|---|
| `GET /v1/workspaces/{ws}/cohosted-agent/models` | 지금 모델(`current`)·핀 여부(`pinned`)·Hermes의 현재 모델(`hermesCurrent`)과, 로그인된 제공자별 전체 모델 목록(모델마다 `featured`·`current`). |
| `PUT /v1/workspaces/{ws}/cohosted-agent/model` | `{provider, model}`. 목록 밖이면 `422 cohosted_model_not_offered`, 성공하면 핀과 `agent.model`을 갱신하고 감사를 남긴다. |
| `POST …/cohosted-agent/connect` (변경) | 핀에 별칭 대신 **Hermes의 현재 provider와 model**을 적는다. |

- 두 새 라우트도 `require_instance_operator_write`가 **첫 줄**이다(비운영자 `403`, 아무것도 보내지 않고 쓰지 않는다). 선언이 준비되지 않았으면 `409 cohosted_agent_not_ready`, 연결된 에이전트가 없으면 `409 cohosted_agent_not_connected`, Hermes 목록을 못 읽으면 `502 cohosted_models_unavailable`(본문·원인 문자열 없음). 호출량은 운영자별 별도 버킷(분당 20회)이다.
- **선택 제한은 서버가 한다.** PUT은 **매번 Hermes를 새로 읽는다.** 클라이언트가 준 목록·이전 응답을 믿지 않는다. `(provider, model)`이 로그인된 제공자의 목록에 정확히 있어야 하고, 아니면 `422`이며 아무것도 쓰지 않는다(철자가 이상한 슬러그·id는 소켓 없이 같은 `422`). 본문은 닫혀 있다(`deny_unknown_fields`; URL·키·경로를 받지 않는다). 읽기와 쓰기 사이에 연결이 사라지면 쓰기 트랜잭션 안에서 다시 확인해 `409`.
- **connect는 읽기 실패로 거부하지 않는다.** 옵션 읽기가 실패하거나 모양이 다르면 쌍 없이(오늘과 같은 별칭 `hermes-agent`) 연결된다. 이 경우 `GET …/models`는 `502`로 사실대로 말하고 목록을 지어내지 않는다.
- 감사: `agent.cohosted.model_changed`(스키마 `momo.cohosted_agent.model.audit.v0`)에 새·이전 `provider`·`model` 슬러그. 키·URL·본문은 없다. connect의 `agent.provider_pin.updated` 감사에도 쌍이 들어간다.

### M4. 워커는 `provider`와 `model`을 함께 보낸다

- `operator_env` 핀이 쌍을 가지면, 워커는 그 턴의 모델을 핀의 `model`로 하고 `/v1/chat/completions` 본문에 `"provider": "<slug>"`를 함께 싣는다. 쌍은 턴마다 **핀 행(`agent_provider_pin`)에서** 읽으므로(#3873) 잡을 큐에 넣은 뒤 고른 모델도 그 턴에 적용된다. 한 턴은 요청 하나이므로 한 실행 안에서 모델이 바뀌지 않는다.
- `provider`는 **chat/completions 선만** 쓴다. Responses·Anthropic Messages 선은 이 필드를 만들지 않는다(시험으로 고정). 공백 슬러그는 보내지 않는다(Hermes가 빈 provider를 「없음」으로 읽어 model을 무시하므로).
- `team_link` 핀·핀 없는 에이전트·소유자 키 턴은 영향이 없다.

### M5. 기본값과 `featured` 규칙

- **기본값은 Hermes의 현재 모델이다.** connect가 그 값을 핀에 적고, 핀에 쌍이 없으면 `current`는 Hermes의 현재 값이다. oort가 기본 모델을 따로 정하거나 하드코딩하지 않는다.
- `featured`(성재 「추린 목록」): 제공자마다 **Hermes가 준 순서의 앞 3개** + **지금 쓰는 모델은 항상**. 모델 이름을 코드에 넣지 않는다 — Hermes는 제공자별로 최신 세대의 대표 등급부터 나열하므로 「앞 몇 개」가 곧 대표 모델이고, 새 모델이 나와도 배포 없이 따라온다. 개수(`FEATURED_PER_PROVIDER = 3`)는 코드 상수다. UI는 featured를 기본으로 보이고 「전체 보기」로 나머지를 연다. 서버 응답은 항상 전체 목록이다(선택 제한은 전체 목록 기준).
- **결정(owner, 2026-10-21): 모델 차단 목록을 두지 않는다.** 성재 원문 「fable은 당연히 보여야지. 우리만 쓰는것도 아니고 모두가 쓸 것을 가정하는데」. `claude-fable-5.1`처럼 어느 모델이든 Hermes가 로그인된 제공자에 대해 주는 것은 모두 노출한다(`featured` 규칙은 그대로). 서버는 차단 목록·모델 이름 하드코딩을 만들지 않는다(#4159).
- **연결 시 현재 모델 거르기(#4159 L1).** connect가 핀에 적는 Hermes의 현재 `(provider, model)`은 `providers[]`의 로그인된(`authenticated: true`) 제공자 안에 있을 때만 쓴다. 로그인되지 않은 제공자가 현재값이면 핀의 쌍은 비워 두고 오늘과 같은 `agent.model` 동작을 한다(`GET …/models`의 `hermesCurrent`도 같은 규칙).
- **PUT 409 원인 구분(#4159 L2).** 쓰는 순간 에이전트의 핀이 `team_link`로 바뀌어 있으면 `cohosted_agent_pin_replaced`, 에이전트가 없거나 연결이 끊겼으면 `cohosted_agent_not_connected`다.
- **throttle은 DB 조회 앞(#4159 L5).** `GET …/models`·`PUT …/model`은 연결 여부를 DB에서 읽기 전에 분당 호출 예산(운영자당 20회)을 쓴다.

### 보안 경계와 egress 가드(ADR-0004 증보 5) 영향

- **가드는 목적지를 본다.** 증보 5의 두 지점(저장 시 `validated_base_url`, 연결 시 `GuardedResolver`)은 호스트·주소만 판정한다. 요청 본문의 `provider`는 목적지를 바꾸지 못한다: 같은 `HERMES_BASE_URL`의 같은 호스트로 간다. `provider`는 비밀이 아닌 **라우팅 슬러그**이며 자격이 아니다. 새 URL·호스트·키를 받는 입력이 없다.
- 시험으로 고정한다: (a) 운영자 opt-in으로 허용된 Hermes에 `provider`가 든 본문이 통과해 도달하고, (b) 같은 본문이 사설 주소에서는 증보 5대로 `EgressDenied`이며 본문이 도달하지 않고(슬러그가 목적지를 열어 주지 않는다), (c) 새 옵션 읽기 GET도 같은 가드 클라이언트를 쓰며 opt-in 없는 사설 주소에서는 요청 0건.
- **선택 우회 없음.** 운영자라도 목록 밖 `(provider, model)`을 쓸 수 없다(`422`). 임의 문자열이 Hermes로 가는 길은 철자 검사 → 새 목록 → 정확 일치 → DB CHECK의 네 겹이다.
- **비밀 경계 불변.** 구독 OAuth 토큰·bearer는 oort를 지나가지 않는다(ADR-0004 증보 6·7). 새 응답·감사·로그에는 정제된 슬러그와 모델 id뿐이고 `HERMES_API_KEY`·Hermes 본문·표시 이름은 없다.
- **과금·약관.** 제공자를 바꾸면 다른 구독·키에서 사용량이 나간다(토큰 수 차이로 다른 제공자 처리까지는 확인했고 어느 계정이 과금되는지는 보지 않았다 — `runtime-unverified`). 약관 적합성은 이전 증보대로 운영자 몫이다.

### 구현 슬라이스

1. **이 PR(서버·워커):** migration 144, `momo-settings`(핀 쌍), `momo-provider-probe`(옵션 읽기·정제), 서버 라우트 둘과 connect 변경, 워커 어댑터(`ChatRequest.provider`), OpenAPI(operator 명세), 시험.
2. **별도 이슈(UXUI):** 설정 › AI 연결의 모델 고르기 화면(featured 기본·전체 보기·표시명 표). 이 PR은 화면을 만들지 않는다.

### red proof (해당 분기를 지우면 실패해야 한다)

1. 목록 밖 `(provider, model)`은 `422`이고 핀·`agent.model`·감사가 그대로다 — 멤버십 검사를 지우면 실패. 로그인 안 된 제공자(모델을 든 것 포함)는 노출·선택 모두 불가.
2. 비운영자(워크스페이스 admin·타 테넌트) `403`이고 Hermes에 요청이 0건 — 게이트 줄을 지우면 실패.
3. 핀의 쌍이 있으면 요청 본문에 `provider`와 `model`이 함께 실린다 — 본문 삽입을 지우면 실패. 쌍이 없으면 `provider` 키가 없고 모델은 오늘과 같다. Responses·Anthropic 선에는 `provider`가 없다.
4. PUT은 매번 새로 읽는다 — 읽은 뒤 Hermes가 로그아웃되면 같은 PUT이 `422`, 읽을 수 없으면 `502`. 캐시를 쓰면 실패.
5. 옵션 읽기 실패(500·잘못된 모양)에도 connect는 `201`이고 핀의 쌍은 NULL, `agent.model`은 `hermes-agent`.
6. 표 CHECK: 반쪽 쌍·`team_link`의 쌍·잘못된 슬러그/id는 저장되지 않고, 재핀은 쌍을 지운다.
7. 가드: 위 「보안 경계」 (a)(b)(c).

### 바뀌지 않는 것

D1·D3~D9, K1~K7, `HERMES_API_KEY` 의미, 게이트웨이 SSE 경로(D5), oort가 토큰을 소유·저장하지 않는다는 불변식, `lockgate`(도구 잠금) 규칙, `probe`가 보내는 요청(두 개 + 요청 시 toolsets), Hermes 설정(`hermes-kwak` 포함)과 `garam-api`.

## 증보 2026-10-25 — 환경 사실 읽기(platform·loginRelay)와 호스팅 제안 문구 (#4336)

- Status: **Accepted** (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」)
- 독립 설계 검토: r1 FAIL(High 2·Medium 16·Low 16) → r2 FAIL(High 1·Medium 3·Low 14) → r3 **PASS**(Blocker 0·High 0·Medium 4·Low 8). r3의 Medium 4와 Low 7은 Accepted 전에 이 절에 반영했다. 남긴 것은 Low 1(상태 읽기 전후 감사 행 수가 같다는 증명이 수용 기준에 없다 — 현행 상태 읽기 핸들러가 감사 행을 쓰지 않고(`routes/cohosted_agent.rs:244-267`) 이 증보가 그것을 바꾸지 않아 위험이 작다). 검토 보고서는 로컬 자료(레포 밖)이고 요약은 PR 본문에 있다.
- 기안: Sonnet 5.5 엔진 워커 (#4336, 온보딩 r2 R2-00). 근거: 리서치 r2 온보딩 보고서 §2·§3.5·§5.0·§5 P0(로컬 자료, 레포 밖). 이슈 #4336이 이 증보를 ADR로 지정한다: 운영자 전용 읽기 필드 추가는 공개 API 변경이라 이 증보의 Accepted가 #4337의 머지 조건이고(ADR-0100), 경계는 바뀌지 않으므로 새 ADR은 두지 않는다.
- owner 결정(원문 인용):
  - 성재 2026-10-21: 「VM에 헤르메스가 없다면 헤르메스를 호스팅할지 물어보고, 헤르메스를 호스팅하고 연동한 경우엔 GUI로 온보딩 레벨에서 헤르메스의 구독계정을 연동하고 기본 모델을 선택하고 그런 UXUI를 포함하고 싶어.」 · 「온보딩에서는 기본으로 OpenAI」
  - 같은 날 AskUserQuestion: 대상 환경 「둘 다 한 틀로」(Railway와 일반 VM(Docker Compose)을 한 틀로, 실측은 Railway부터) · 호스트 셸 권한 「박스 안만」(oort 본체는 타입 있는 동작만). 호스트 실행 기반은 ADR-0210(#4347, 작성 전)이 정하고 이 증보는 정하지 않는다.
  - 위임 2026-10-22: 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 — 아래 **[권장]** 표시는 모두 이 위임에 따른 planner 결정이고 owner에게 보고된다.
- 표기: [V] 이 세션에서 직접 확인(코드·문서는 `track/engine` `5bdecd348` 기준 파일:줄, 외부 문서는 2026-10-25 받음) · [추정] 해석 · [권장] 위임 결정 · `runtime-unverified` 실행 안 함. 이 증보는 설계이고 이 PR은 문서만 바꾼다.

### 비교 참조 (ADR-0100)

- [리서치 r2 §2.1, 2026-10-21 확인] Pickle·Muse·Grok Bot·dots는 가입하면 벤더 클라우드 컴퓨터가 생겨 첫 실행에 호스팅 질문이 없다. oort는 운영자가 직접 호스팅하므로 질문이 남는다 — 그래서 「계획을 보여 주되 실행은 사람이 한다」로 부담을 줄인다(F6).
- [리서치 r2 §2.3] Railway·Render·Coolify·Umbrel은 템플릿·한 줄 설치로 시크릿을 자동 생성하고 완료를 헬스체크 같은 **실제 응답**으로 알린다. 이 증보도 「설치했어요」를 단정하지 않고 이후 상태 읽기가 선언을 돌려줄 때만 전환한다(F6).
- Railway는 시스템 변수를 모든 배포에 주입한다(사실 6). 환경 사실을 API 호출 없이 알 수 있는 근거다.

### 확인한 사실 [V]

1. 상태 읽기는 네트워크를 쓰지 않는다. `routes/cohosted_agent.rs:1-9`(모듈 머리말), `:244-267` `status()`는 `workspace_scope` → `require_instance_operator_write`(`:251`) → `declaration()` 순이고, 선언됐을 때만 핀 조회가 하나 더 든다(`:253-257`). 응답 `StatusResponse`(`:226-242`)의 키는 `schema`·`declaration`·`endpointLabel?`·`toolsLockAttested`·`connectable`·`connectedAgentId?`다. 스키마 문자열은 `momo.cohosted_agent.status.v0`(`:80`), `declaration`은 `not_declared|key_missing|url_refused|ready` 넷(`:134-153`). `endpointLabel`은 선언 주소에서 userinfo·query·fragment를 뺀 라벨이다(호스트와 경로는 남는다, `:232-234`·`server-rust/crates/momo-settings/src/provider.rs:467-478`).
2. 선언과 중계 설정은 부팅 때 한 번 읽는다: `Config::from_env`가 `CohostedAgentConfig::from_env()`(`server-rust/bins/momo-server/src/config.rs:2431`)와 `LoginRelayConfig::from_env()`(`:2432`)를 부르고, 프로세스당 한 번 불린다(`main.rs:25`). 두 파서는 조회 함수를 주입받아(`from_lookup`, `config.rs:1790`·`:1854`) 프로세스 env를 건드리지 않고 시험할 수 있다. `env()`는 빈 값·공백만인 값을 없는 것으로 걸러내고 나머지는 원문 그대로(trim 없이) 돌려준다(`:2361-2366`).
3. 로그인 중계의 「켜짐」은 두 단계다. `LoginRelayConfig::configured()`(`config.rs:1889`)는 URL과 키(32~256자, 문자 집합 제한)가 있는지만 보고, `target(&settings)`(`:1896`)는 거기에 쓰기 게이트(`validated_base_url`, 호출마다 프로세스 env `AGENT_PROVIDER_LOCAL_HOSTS`를 읽는다 — `server-rust/crates/momo-settings/src/provider.rs:284-286`)와 「경로 없음」을 더한다. 열 개 중계 라우트 메서드(모델 5·앱 5)는 다섯 공유 본문을 거쳐 모두 `authorize`(운영자 게이트) 뒤 `prepare()`를 지나고, `409 login_relay_off`는 거기서 `target(...)`이 `None`일 때만 난다(`routes/login_relay.rs:398-410`, 핸들러 `:587-760`). 본문이 있는 둘(`start_of`·`complete_of`)은 본문 파싱이 `prepare()`보다 앞이라 형식이 틀린 본문은 중계가 꺼져 있어도 `400`이 먼저 난다(`:632-640`·`:689-695`). 같은 파일 머리말의 규칙 1: 「so a stranger learns nothing — not even whether the relay is configured」(`:19-20`).
4. 화면 쪽 현재 모양. 클라이언트는 중계가 꺼진 것을 그 409로 알아낸다(`packages/momo-core/src/features/settings/loginRelay.ts:149`). 문구는 Railway로 고정이다: `MODEL_SHELL_COMMANDS`(`loginRelay.ts:262-266`), `appShellCommand`(`:279-283`), `MODEL_LOGIN_COPY.shellLead`·`APP_LOGIN_COPY.shellLead`(`:332`·`:352`), `COHOSTED_COPY.volumeNote`(`cohostedAgent.ts:209`). 상태 파서는 `schema`가 `.v0`가 아니면 응답 전체를 버리고(`cohostedAgent.ts:90`), 읽기 결과는 `not_declared`를 `hidden`, 연결 오류(비-`ApiError`)를 `hidden`, 5xx를 `unknown`으로 접는다(`:142-156`). 이 읽기(`fetchCohostedStatus`, 같은 질문 키 `["cohosted-agent", ws]`)를 네 곳이 나눈다: `CohostedAgentCard.tsx:52-57`, `ModelLoginPanel.tsx:405-420`, `AgentProviderPinSection.tsx:71-75`(`:111`의 `envLinkAvailable: kind === "ready"`는 `ready`를 「선언됨」으로 읽는다), `PluginAppLogin.tsx:38-45`.
5. 플랫폼 도장. 생성기 표 `platform_profiles()`는 `railway`(T2)와 `fly`·`aws-lightsail`·`gcp-vm`·`host-network`(T1) 다섯 행이다(`scripts/self_host_env.sh:219-226`). 셸 `oort_env_tier`는 도장이 없으면 T1이고, 이름은 trim 없이 정확 일치로 찾으며, 모르는 이름은 실패다(`scripts/lib/oort_common.sh:46-73`). **이 도장은 `api` 프로세스 env에 배선되지 않는다.** compose `api` 서비스의 `environment`(`infra/rust/docker-compose.rust.yml:252-468`, `env_file` 없음)에도 Railway 카탈로그 `api` 변수(`infra/railway/railway.json`)에도 `MOMO_SELF_HOST_PLATFORM`이 없고, Railway 공유 변수는 서비스에 참조 변수를 만들어야 닿는다(「Adding a shared variables to a service creates a Reference Variable」, `https://docs.railway.com/variables`, 2026-10-25 받음. `infra/railway/README.md:168-169`는 도장이 공유 변수로 남고 doctor가 env 파일에서 읽는다고 적는다). 서버 Rust 코드는 도장도 이 표도 읽지 않는다(탐색 결과 0건). 지금 배선에서 서버가 도장을 보게 되는 경우는 운영자가 `api` env에 직접 넣었을 때뿐이다.
6. Railway 시스템 변수: 「Railway provides the following additional system environment variables to all builds and deployments.」 — 표의 `RAILWAY_ENVIRONMENT_ID | The environment id of the service instance.`(`https://docs.railway.com/reference/variables`, 2026-10-25 받음). 레포에는 이 변수를 읽은 곳이 없다(셸 doctor가 보는 `RAILWAY_ENVIRONMENT`는 다른 이름이다 — `scripts/lib/oort_doctor.sh:1628`). 실제 Railway `api` 프로세스에서 보이는지는 `runtime-unverified`.
7. 운영자 스펙 `docs/api/openapi.operator.yaml`에는 `/cohosted-agent/models`·`/model`만 있고(`:589`·`:619`) 상태·probe·connect 라우트는 없다. 이 파일과 응답 모양을 대조하는 검사도 없다(스크립트·시험 중 파일명을 읽는 곳 0건. 머리말이 이유를 적는다: 게이트 스택이 운영자 범위를 제공하지 않는다, `:6-10`).
8. Hermes 번들(compose): `hermes`는 `mem_limit ${MOMO_HERMES_MEM_LIMIT:-2g}`·`cpus: 1`(`docker-compose.rust.yml:610-611`). `--with-agents`는 이미 있는 비밀(`HERMES_API_KEY`, 형식이 맞는 `HERMES_LOGIN_RELAY_KEY`)을 보존하고, 선언 키(`HERMES_BASE_URL`·`HERMES_LOGIN_RELAY_URL`·`AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`·`OORT_COHOSTED_AGENT_TOOLS_LOCKED`)는 번들 값으로 다시 쓰고, 두 목록(`AGENT_PROVIDER_LOCAL_HOSTS`·`COMPOSE_PROFILES`)에는 항목을 합치며, 다른 `HERMES_BASE_URL`이 이미 있으면 거절한다(`self_host_env.sh:1418-1478`). 문서의 절차는 두 명령이다: 플래그로 env를 쓰고 `--compose up -d --wait`로 올리며, 이미 떠 있는 스택은 api·agent-worker를 다시 만들어야 반영된다(`docs/SELF_HOST.md:436-470`). `--platform railway`와 함께 쓸 수 없다(`self_host_env.sh:277-278` — Railway는 카탈로그의 `hermes` 서비스를 쓴다, `docs/SELF_HOST_AGENT.md` §3.4.1). `docker-compose.host-network.yml`에는 `hermes` 항목이 없고 최상위 `networks: !reset {}`로 `private` 망을 없앤다(`:1-30`) — `host-network`에서 `--with-agents`가 뜨는지는 `runtime-unverified`.
9. 「선언」의 모양. `declared`는 `HERMES_BASE_URL`이 있고 공백만이 아닐 때다(`config.rs:1793`). compose 기본 스택은 이 변수를 `${HERMES_BASE_URL:-}`(빈 값)로 배선하므로(`docker-compose.rust.yml:385`) Hermes 없는 기본 스택은 늘 `not_declared`다. **Railway 카탈로그는 `api`에 `HERMES_BASE_URL=http://hermes.railway.internal:8642/v1`과 `HERMES_LOGIN_RELAY_URL`을 고정 변수로 넣고 `hermes` 서비스를 함께 싣는다**(`infra/railway/railway.json` api 변수, `infra/railway/README.md:143-148`·`:188-190`·`:494-495`). 카탈로그로 올린 인스턴스는 `not_declared`가 아니라 `key_missing`/`ready`로 시작하고, `not_declared`+`railway`는 카탈로그 이전이거나 수기로 구성한 인스턴스에서만 나온다.

### 바뀌는 기존 결정

- **D1의 마지막 문장**(「운영자가 선언한 호스트가 없으면 이 기능 전체가 꺼진 상태이고 아무것도 보이지 않는다」)을 좁힌다. 꺼진 것(프로브·연결·네트워크 요청 0)은 그대로이고, 인스턴스 운영자 한 사람에게는 「선언 없음」과 계획을 보이는 카드가 열린다(F6). 근거: 성재 「VM에 헤르메스가 없다면 헤르메스를 호스팅할지 물어보고」. 클라이언트의 같은 규칙(`cohostedAgent.ts` 머리말 규칙 1, `:9-11`)의 **문구**와 서버 설정의 주석(`config.rs:1764-1765`의 「shows nothing」)은 구현이 고친다(슬라이스). `fetchCohostedStatus`의 매핑(`:146`의 `not_declared` → `hidden`)은 바꾸지 않는다(F6).
- **Q2 (b)**(위임 결재 「attest 뒤에만 카드」, 원문 「attest 전에는 체크리스트 링크만 보인다」)는 `declaration ≠ not_declared`인 단계의 규칙으로 그대로다. `not_declared`의 제안 카드는 준비됨을 암시하지 않는 범위에서 D1 좁힘의 일부다(F6).
- 그 밖의 결정은 바뀌지 않는다(아래 「바뀌지 않는 것」).

### F1. 환경 사실은 프로세스 env만 읽는다 — env는 부팅 때 한 번, 판정은 파싱된 설정과 쓰기 게이트에서 (D1 불변)

- 서버가 운영자에게 알려 주는 환경 사실은 셋이다: 선언 단계(기존 `declaration` — 이 증보가 바꾸지 않는다), `platform`, `loginRelay`. 뒤의 둘을 새 필드 `environment`에 담는다.
- D1의 금지는 그대로다. 원문: 「내부망을 훑지 않는다. 후보 이름을 추측하지 않는다(`hermes.railway.internal`을 기본값으로 찍어 보지 않는다). Railway API 토큰을 oort에 저장하지 않으며 Railway API를 부르지 않는다.」 이 증보는 여기에 파일시스템·cgroup·`/proc`·DNS로 환경을 추정하지 않는다는 것을 더한다. 새 입력 둘(`RAILWAY_ENVIRONMENT_ID`·`MOMO_SELF_HOST_PLATFORM`)은 D1의 에이전트 감지 입력(선언 호스트 `HERMES_BASE_URL` 한 줄)이 아니라 안내 문구용 환경 사실이고, 호스트를 찾거나 호출하는 데 쓰이지 않는다. 읽는 곳은 `api` 프로세스가 이미 가진 env와 이미 파싱된 설정뿐이다.
- **시점**: env는 부팅 때 한 번 읽는다(사실 2). `platform`은 파싱 시점에 열거형으로 분류해 **열거형만 보관한다** — 원문 문자열을 `Config`와 그 안의 설정 구조체에 두지 않는다(`Config`(`config.rs:54-55`)와 `CohostedAgentConfig`(`:1769`)는 `derive(Debug)`라 `{:?}`가 원문을 찍을 수 있다) [권장]. `loginRelay`는 요청마다 `state.login_relay.config.target(&state.settings).is_some()`을 부른다. 라우트도 요청마다 같은 호출을 하므로 같은 값이다(F4). 이 호출은 파싱된 설정에 더해 쓰기 게이트가 호출마다 읽는 프로세스 env `AGENT_PROVIDER_LOCAL_HOSTS`에 기댄다(`server-rust/crates/momo-settings/src/provider.rs:284-286`·`:381-391`) — 실행 중 프로세스의 env는 바뀌지 않으므로 상태와 라우트가 어긋나지 않는다 [추정]. env가 바뀌는 사건은 **`api` 재시작**이다: 운영자가 env를 바꾸거나 Hermes를 올려도 `api`가 새 env로 다시 뜨기 전에는 화면이 이전 값을 말한다 [추정: 두 플랫폼 모두 프로세스 env는 기동 때 고정된다].
- `status()`는 계속 네트워크 0이고(사실 1), D2의 요청 목록은 늘지 않는다. D2의 「백그라운드 폴링·부팅 시 자동 프로브 없음」은 **프로브**(Hermes로 나가는 요청)의 말이고, 이 증보의 상태 읽기(F6의 폴링)는 Hermes로 나가는 요청이 0이라 그 규칙에 걸리지 않는다. 새 표·열·감사 행·시크릿·egress 면제 입력이 없다.

### F2. `environment`는 닫힌 열거형 둘이다 — 문자열을 되돌리지 않는다

- `GET /v1/workspaces/{ws}/cohosted-agent`에 `environment: { platform, loginRelay }`를 더한다. `platform ∈ {railway, compose, unknown}`, `loginRelay ∈ {on, off}`. 키 집합은 정확히 이 둘이고 둘 다 항상 있다(생략·`null` 없음). `environment`는 **`declaration` 값과 무관하게 항상 있다** — 가장 필요한 때가 `not_declared`이기 때문이다 [권장]. probe·connect 응답에는 싣지 않는다(상태 읽기 한 곳).
- 값은 서버 코드의 열거형 변종에서만 나온다. 이 증보가 **새로** 내보내는 env 문자열은 0이다: 도장 문자열·Railway 환경 id·중계 URL·키는 응답·로그·감사·오류 어디에도 나가지 않고, 열거형 밖의 값은 `unknown`으로 접힌다. (기존 `endpointLabel`은 선언 주소에서 userinfo·query·fragment를 뺀 라벨로 지금도 나가고 바뀌지 않는다.)
- 인스턴스 운영자 전용(D3 불변)이다. `require_instance_operator_write`가 첫 게이트라 비운영자는 403이고 본문에 `environment`가 없다 — 중계 라우트의 규칙 1(사실 3)과 같은 선이다.
- `environment`는 권한·egress·연결 가능 판정에 쓰이지 않는다. `declaration`·`connectable`·`connectedAgentId`는 `environment`와 무관하게 같은 값이다 [권장]. 값을 속여도 바뀌는 것은 안내 문구뿐이게 못박는다.
- **스키마 문자열은 `momo.cohosted_agent.status.v0`로 두고 필드만 더한다** [권장]. 이유 [V]: 클라이언트 파서가 `.v0`만 읽고 다른 값이면 상태 전체를 버리며 소비자가 넷이다(사실 4). 서버는 운영자가, 클라이언트는 앱 업데이트가 따로 올리므로 [추정] 올리면 옛 클라이언트가 상태를 통째로 잃는다.
- **클라이언트 호환 규칙** [권장]: `environment`가 없거나 객체가 아니면(옛 서버·깨진 답) 없는 것으로 읽는다. 필드 단위로 접는다: 없거나 허용 목록 밖인 필드만 `platform`은 `unknown`, `loginRelay`는 「모름」(지금처럼 로그인을 시작해 409로 안다)이 되고, 상태 읽기 전체를 버리지 않는다.

### F3. `platform` 판정 규칙

입력은 `api` 프로세스 env의 두 변수뿐이다. 위에서부터 처음 맞는 줄이 이긴다. 「비어 있다」는 `env()`의 규칙이다(길이 0이거나 공백만, 사실 2).

| 순서 | 조건 | `platform` |
|---|---|---|
| 1 | `RAILWAY_ENVIRONMENT_ID`가 비어 있지 않다 | `railway` (도장 값과 무관) |
| 2 | `MOMO_SELF_HOST_PLATFORM`이 비어 있다(없음 포함) | `compose` |
| 3 | 도장이 `railway` | `railway` |
| 4 | 도장이 `fly`·`aws-lightsail`·`gcp-vm`·`host-network` (생성기 표의 T1 행) | `compose` |
| 5 | 그 밖의 모든 값 | `unknown` |

- 도장은 **trim하지 않고 정확 일치·대소문자 구분으로** 비교한다 [권장]: `" railway"`(앞뒤 공백)는 5(`unknown`)다. 셸도 trim하지 않고 같은 값을 모르는 이름으로 거절한다(사실 5; 생성기는 `^[a-z0-9-]+$`만 쓴다, `self_host_env.sh:247`). 단 공백만인 도장은 셸이 모르는 이름으로 거절하지만 서버는 `env()`가 없는 것으로 걸러 `compose`로 읽는다(생성기는 그 값을 쓰지 않는다). 2는 `oort_env_tier`의 「도장 없음 = T1」과 같은 규칙이고, 5는 그 함수가 모르는 이름을 오류로 내는 자리의 부드러운 짝이다(서버는 죽지 않고 `unknown`).
- 시스템 변수가 도장을 이긴다 [권장]. 시스템 변수는 플랫폼이 주입하는 값이고 도장은 운영자가 쓴 값이라, 다른 곳에서 옮겨 온 env의 도장(T1 이름)이 실제 Railway 위치를 가리지 못하게 한다. 반대 방향은 막지 못한다: 도장 `railway`가 Railway 밖에서 `api` env에 직접 들어오면(운영자가 넣거나 옮겨 온 env) 3으로 `railway`가 된다 — 운영자의 선언이고 바뀌는 것은 안내 문구뿐이라 막지 않는다.
- **현행 배선에서 닿는 줄**: 도장이 `api` env에 배선되지 않는다 [V](사실 5). 그래서 표준 배포에서 Railway는 1로, compose는 2로 판정될 것이다 [추정 — 1은 `runtime-unverified`]. 3~5는 운영자가 도장을 `api` env에 직접 넣었을 때만 닿는다. 이 증보는 **배선을 더하지 않는다**(#4337 ④ 「추가 배선 0」, 기각 대안 F). 운영자가 직접 넣는 길은 오판의 복구 수단이다: Railway `api`에서 1이 닿지 않으면 `MOMO_SELF_HOST_PLATFORM=railway`를 `api` 서비스 변수로 넣고 재배포하면 3으로 같은 결과가 난다.
- **한계 [추정]**: `compose`는 「Railway 신호가 없고 도장이 없거나 T1 행」이지 「docker compose가 도는 것을 확인했다」가 아니다. ADR-0184 D1이 T2로 둔 다른 관리형 플랫폼(AWS ECS/Fargate·Cloud Run)은 도장 행이 없어 `compose`로 읽힌다 — 셸 규칙과 같은 한계다. 그래서 `compose` 문구는 조건형으로 쓴다(F7). `host-network`도 `compose`로 읽히지만 그 오버레이에서 `--with-agents` 계획이 성립하는지는 `runtime-unverified`다(사실 8). 환경을 더 정확히 알아내는 길(기각 대안 B)은 D1의 「추측 금지」라 열지 않는다.
- T1 이름 목록은 서버 코드에 복제된다. 서버 이미지가 `self_host_env.sh`를 싣고 있지만(`server-rust/Dockerfile:361`) 서버 경로에 셸 표 파서를 들이지 않는다(기각 대안 N). 표와 코드가 어긋나지 않게 **드리프트 시험**이 지킨다(수용 기준 8).
- **`RAILWAY_ENVIRONMENT_ID`가 실제 Railway `api`에서 보이는지는 `runtime-unverified`다**(문서는 「all builds and deployments」, 사실 6). 안 보이면 Railway가 `compose`로 읽혀 `platform`으로 고르는 문구 전부가 틀려진다 — 대체 명령·삭제 안내·호스팅 제안 카드의 계획(Railway에서 `--with-agents`를 안내하면 그 플래그는 거절된다, 사실 8)이다. 그래서 확인 항목이다 [권장]: 머지 전에 Railway에 접근할 수 있는 PR 작성자가 owner 승인 뒤 임시 서비스로 실측할 수 있으면 그쪽을 우선하고 PR 본문에 적는다(값이 아니라 판정만). 못 하면 이 변경이 실린 릴리스의 첫 운영 확인에서, Railway에 올라 있는 인스턴스의 운영자가 자기 토큰으로 `GET …/cohosted-agent`를 읽어 `environment.platform`이 `railway`인지 본다(읽기 전용). 아니면 위 복구 수단으로 즉시 고치고, 도장 배선을 더하는 후속 증보를 낸다. 복구는 설정만으로 되고 퇴행은 문구에 한정된다.

### F4. `loginRelay` 판정 — 라우트와 같은 술어

- `on` ⇔ 중계 라우트가 쓰는 판정과 같다: `LoginRelayConfig::target(&settings)`가 `Some`일 때(사실 3). 아니면 `off`. **같은 함수를 부르고 복제하지 않는다.** [권장 — `configured()`가 아니라 `target()`] 이유 [V]: `configured()`는 URL이 쓰기 게이트를 넘지 못하거나 경로를 달고 있어도 참이다. 그 값을 쓰면 화면은 「켜짐」인데 열 개 라우트가 모두 `409 login_relay_off`를 내는 어긋남이 생긴다.
- 선언 상태와 무관한 설정 사실이다(Hermes가 선언되지 않아도 값이 있다). 이 필드가 필요한 이유: 중계 라우트는 연결된 에이전트 id가 있어야 부를 수 있어(`…/agents/{agent}/model-login`, L4) 연결 전에는 화면이 켜짐 여부를 알 길이 없다.
- **한계**: `on`은 「설정이 있고 주소가 게이트를 통과한다」이지 「사이드카가 살아 있다」가 아니다. 상태 읽기는 네트워크 0이라 중계에 묻지 않는다(F1). 사이드카가 죽었거나 키가 맞지 않으면 로그인 시작이 기존 오류 분기로 실패한다. 화면은 `on`을 「지금 로그인할 수 있다」로 단정하지 않는다.
- `off`일 때 화면은 L1 (c)의 셸 명령 대체 경로를 보인다(불변). 명령의 문구는 F7이 정한다.

### F5. 서버는 화면 단계를 내려주지 않는다 [권장]

「선언 단계」는 기존 `declaration`·`toolsLockAttested`·`connectable`·`connectedAgentId`다. 온보딩에서 보이는 단계(없음 → 찾음 → 연결됨 → 모델 인증 → 모델 고르기)는 클라이언트가 이 필드와 `environment`, 모델 라우트(M3)·로그인 라우트(L4)의 응답으로 **파생**한다. 서버에 `stage` 같은 필드를 두면 화면이 개편될 때마다 공개 API가 바뀐다.

### F6. 호스팅 제안은 「계획 표시」까지다

- **보이는 조건**: 상태 읽기가 200이고 `declaration = not_declared`일 때, 인스턴스 운영자에게만(비운영자는 403이라 카드가 없다). 준비됨을 암시하는 말(「찾았어요」·「연결할 수 있어요」)은 쓰지 않는다(Q2 (b)): 「이 서버에는 Hermes가 선언돼 있지 않아요. 같이 설치할까요?」 수준의 질문과 계획만 말한다 — `not_declared`는 「선언이 없다」이지 「Hermes가 없다」가 아니다(선언하지 않은 곳에 있을 수 있고, D1이 스캔·추측을 금지해 oort는 알 길이 없다). 선언이 일부인 상태(`key_missing`·`url_refused`·잠금 선언 없음)는 기존 문구의 몫이고 이 카드가 아니다. 어디에 놓는지(온보딩 AI 단계·AI 허브)는 새 이슈가 정한다. [권장]
- **닿는 배포 [V]**(사실 9): 카드는 Hermes 없는 compose 기본 스택에서 늘 뜬다. Railway 카탈로그로 올린 인스턴스는 `HERMES_BASE_URL`이 고정돼 있어 `not_declared`가 아니므로 이 카드를 보지 못한다. 그 인스턴스에서 `hermes` 서비스가 없거나 죽은 상태는 `declaration`이 `ready`/`key_missing`이고 프로브가 `unreachable`로 말한다(D3 그대로: 「주소를 확인해 주세요」 한 줄). 이 증보는 그 화면을 바꾸지 않는다: `unreachable`은 「서비스가 없다」의 증명이 아니라서(잠금 게이트가 거절해 리스너가 없는 경우도 같다, A5) 「호스팅 제안」 문구를 붙일 수 없다. 그 상태를 위한 안내는 새 이슈 후보다.
- **카드가 하는 일** [권장]: `environment.platform`으로 고르는 **정적** 계획을 보인다.
  - `compose`: ① `scripts/self_host_env.sh --with-agents`(+ 설치 모드 플래그)로 env에 선언 키를 쓴다 — 이미 있는 비밀은 그대로 두고 선언 키는 번들 값으로 쓰며, 다른 `HERMES_BASE_URL`이 이미 있으면 거절한다(사실 8). ② `scripts/self_host_env.sh --compose up -d --wait`로 hermes를 올리고 `api`·`agent-worker`를 다시 만든다 — 다시 뜬 뒤에야 선언이 보인다(F1).
  - `railway`: 단계 목록과 문서 링크(`docs/SELF_HOST_AGENT.md` §3.4.1 — Railway는 `--with-agents`를 쓰지 못한다, 사실 8).
  - `unknown`: 명령 없는 일반 문장.
  - 그리고 운영자가 **자기 설치 에이전트에 붙여 넣는 복사 프롬프트** 한 덩어리 — 실행 경로의 1번이다(리서치 r2 §6 Q1 권장 (A): 실행은 사용자의 설치 에이전트가 하고 oort는 계획과 승인 화면만 맡는다).
  - 계획에는 결정에 필요한 사실을 같이 적는다 [권장]: 자원 요구(compose `hermes` `mem_limit 2g`·`cpus 1`, 사실 8), 대화 기록이 Hermes 볼륨에 남는다는 것(D7), 도구가 잠겨 채팅 모델 게이트웨이로 쓴다는 것(D6). compose 계획은 「기본 compose 스택 기준」이라고 쓴다 — `host-network` 오버레이도 서버에는 `compose`로 읽히고(F3) 그 오버레이에서 `--with-agents`가 뜨는지는 `runtime-unverified`다(사실 8). 카드는 host-network를 판별하지 못한다.
- **카드가 하지 않는 일(불변)**:
  1. 서버로 가는 쓰기 요청 0건(읽기 GET만). [권장 — D1·D3의 연장]
  2. 서버가 호스트에서 아무것도 실행하지 않는다 — 셸·Docker·Railway API·토큰 없음. [권장 — D1의 연장]
  3. 성공을 단정하지 않는다. 「찾았어요」로 바뀌는 것은 이후 상태 읽기가 `declaration ≠ not_declared`를 돌려줄 때뿐이다. [권장]
  4. 복사 프롬프트의 가변 부분은 `platform` 열거형의 고정 라벨뿐이고(고정 표에서 조립) URL·키·환경 id·이메일을 싣지 않는다. 문장은 `SELF_HOST_AGENT.md` §0 규율(승인 지점에서 멈춰 화면을 사람에게 넘긴다, 비밀값을 채팅에 붙이지 않는다)을 담는다. [권장]
  5. **oort가 승인받아 대신 설치하는 단추를 두지 않는다.** 그 경로는 성재 결재 「박스 안만」과 ADR-0210(#4347, 작성 전)이 정한다. 그 ADR이 Accepted되기 전에는 이 카드에 서버가 실행하는 동작이 없다. [owner 결재 + #4347]
- **클라이언트 상태** [권장]: 기존 읽기 종류의 뜻은 바꾸지 않는다 — `ready` = 선언됨, `hidden` = 숨김(사실 4). 카드는 `not_declared`를 위한 **새 읽기 종류**(예: `undeclared`, `environment` 포함)로 받는다. `not_declared`를 `ready`로 올리면 `AgentProviderPinSection`의 `envLinkAvailable`(`:111`)이 선언 없는 서버에서 env 링크 선택지를 연다. 기존 `fetchCohostedStatus`의 매핑과 질문 키(`["cohosted-agent", ws]`)는 바꾸지 않는다. 카드는 전송 오류·502/503/504를 구분하는 별도 읽기(별도 질문 키)를 쓰고 기존 `ready` 소비자와 캐시를 공유하지 않는다 — 그래야 기존 소비자의 오프라인 동작(연결 끊김 = `hidden`, 5xx = `unknown`)이 그대로다.
- **소음과 기억** [권장]: 카드는 모달이 아니다. 「나중에」는 어느 상태에서도 누를 수 있고 어디서 이어 가는지를 문구가 말한다. 거절의 기억은 브라우저에만 둔다(`cohostedPrompt.ts` 머리말과 같은 이유) — 서버에 저장하지 않는다(새 표·열 없음). 다른 기기에서 한 번 더 묻는 것은 허용한다.
- **감지 폴링** [권장]: 카드가 열려 있는 동안 상태 읽기를 되풀이해 선언이 생기면 「찾았어요」로 넘길 수 있다. 읽기는 Hermes로 나가는 요청이 0이지만 운영자 게이트가 요청마다 DB 트랜잭션 하나를 쓰므로(`shared.rs:407-437`, 선언됐을 때는 핀 조회가 하나 더, 사실 1) 간격은 기존 `DETECT_*`를 재사용해 묶는다: 2초에서 시작해 두 배씩 늘려 최대 30초, 5분에서 멈춘다(`clients/web/src/features/welcome/firstAgent.ts:31-33`). **선언은 기동 때 읽히므로(F1) 설치 뒤 `api`가 새 env로 다시 뜨기 전에는 바뀌지 않는다.** 재시작 중의 전송 오류와 502/503/504는 실패가 아니라 기다림이다: 이전 상태를 유지한다(기존 읽기는 전송 오류를 `hidden`, 5xx를 `unknown`으로 접으므로 그대로 쓰면 카드가 사라지거나 오류가 보인다, 사실 4).

### F7. 문구는 클라이언트의 정적 표다 — 서버가 문장을 내려주지 않는다 [권장]

- 플랫폼별 대체 명령·삭제 안내·계획 문장은 `environment.platform`으로 고르는 클라이언트(공유 core)의 표다. 서버가 문장을 내려주면 문구가 서버 배포에 묶이고 F2의 「문자열을 되돌리지 않는다」와 어긋난다.
- 규칙(#4339 수용 기준을 문구 전체로 넓힌다): `compose`일 때 사용자에게 보이는 **모든** 문구 — 대체 명령·`shellLead`(「Railway 터미널에서」)·삭제 안내·계획 문장 — 에 `railway`(대소문자 무시)가 0 · `railway`는 현행 문구 유지 · `unknown`(과 `environment` 없음)은 명령 없이 일반 문장.
- `compose` 문구는 조건형으로 쓴다(「docker compose로 돌리는 서버라면」). F3의 한계 때문이다.
- compose의 대체 명령은 구현 이슈가 실제 compose 스택에서 한 번 실행해 확인한다(`runtime-unverified` 해소): 서비스 이름(`hermes`)·실행 사용자(토큰 파일이 root 소유가 되면 안 된다, L2)·프로파일·env 파일 인자.
- 삭제 안내는 데이터를 지우는 동작이므로 oort가 대신하지 않는다고 말하고(D7) 실행 단추를 두지 않는다.

### F8. 보안 경계 대조

- 새로 나가는 정보는 닫힌 열거형 둘이고 인스턴스 운영자에게만 간다. 새 자격·저장·네트워크·egress 면제 입력·감사 행이 없다(ADR-0004 불변).
- env는 운영자가 쓰는 값이라 값을 속여도 바뀌는 것은 안내 문구뿐이다(F2: 권한·egress·연결 판정에 쓰이지 않는다).
- 비운영자 403은 운영자 게이트가 첫 줄이라 본문에 `environment`가 없다(사실 1). 게이트를 지우면 비운영자가 200과 `environment`를 받는다 — 수용 기준 4가 그 회귀를 잡는다.
- 이 증보가 **새로** 되돌리는 env 문자열은 0이다(F2). 중계 URL·키는 `on`/`off` 한 낱말로만 나간다.

### F9. 배포 순서 — 서버를 먼저 올린다 [권장]

서버(#4337)와 클라이언트(#4338·#4339·새 이슈)는 따로 배포될 수 있고 클라이언트는 `environment` 없음을 견딘다(F2). 다만 옛 서버 + 새 클라이언트에서는 Railway 운영자도 일반 문장을 본다 — 지금 보던 `railway ssh …` 명령과 「Railway에서 삭제」 안내가 사라지는 정보 후퇴다(틀린 문구는 아니다). 앱은 자동 업데이트되고 서버는 운영자가 올리므로 창이 생길 수 있어, 서버 변경을 같은 릴리스나 먼저 싣는다. 이 후퇴는 수용한 비용이다(기각 대안 O).

### 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| A. 서버가 Railway API·플랫폼 메타데이터를 불러 알아낸다 | D1: 토큰 저장 금지·새 외부 호출. 환경 사실은 이미 가진 env로 충분하다. |
| B. 파일시스템·cgroup·`/proc`·컨테이너 라벨로 compose 여부를 추정한다 | D1 「추측 금지」. Railway도 컨테이너라 오탐하고 새 읽기 경로가 생긴다. |
| C. 클라이언트가 공개 도메인(`*.up.railway.app` 등)으로 추측한다 | 커스텀 도메인에서 깨지고 서버 사실이 아니다. |
| D. `platform`을 도장 원문 문자열로 내려준다 | 문자열을 되돌린다. 임의 값이 화면·로그로 흐른다. 닫힌 열거형만. |
| E. 새 환경 변수(예: `OORT_PLATFORM`)를 만든다 | 같은 사실을 말하는 이름이 둘이면 어긋난다. 도장과 Railway 시스템 변수가 이미 있다. |
| F. 도장을 compose·Railway 카탈로그의 `api` env에 배선한다 | #4337 ④(추가 배선 0). 풀리지 않은 공유 변수 참조가 `${{…}}` 문자열로 남는 실패 모드가 있고(중계 키 검사가 같은 실패를 막아야 했다, `config.rs:1812`) 카탈로그 검증기의 키 집합이 같이 바뀐다. 필요하면 후속 증보. |
| G. 도장이 없으면 `unknown`으로 한다 | 이슈 R2-00의 결정은 `oort_env_tier`의 「도장 없음 = T1」과 같은 규칙이다. compose가 기본 배포 모양이다. 한계는 F3에 적었다. |
| H. 서버가 명령·문장을 내려준다 | F7. 문구가 서버 배포에 묶이고 「문자열을 되돌리지 않는다」에 어긋난다. |
| I. 서버가 `stage`(없음/찾음/연결됨…)를 계산해 내려준다 | F5. 서버가 화면 상태기계를 갖게 된다. |
| J. 제안 카드에서 oort가 승인받아 대신 설치한다 | 「박스 안만」과 ADR-0210 전에는 새 보안 경계다. F6의 5. |
| K. `schema`를 `.v1`로 올린다 | 옛 클라이언트가 상태 전체를 읽지 못한다(`cohostedAgent.ts:90`). |
| L. `environment`를 probe·connect 응답에도 싣는다 | 상태 읽기 한 곳이면 충분하다. 두 곳이면 어긋난다. |
| M. 선언 없음에서 계속 숨긴다(현행) | 성재가 「호스팅할지 물어보고」를 요구했다. 숨기면 운영자는 Hermes를 올릴 수 있다는 것조차 알 길이 없다. |
| N. 서버가 런타임에 이미지 안의 `self_host_env.sh`의 `platform_profiles()`를 파싱해 T1/T2를 판정한다 | 서버 경로에 셸 표 파서를 들이게 되고, 파일이 바뀌면 판정이 조용히 바뀐다. 코드의 닫힌 목록 + 드리프트 시험(수용 기준 8)이 더 단순하다. |
| O. `environment`가 없으면 현행 Railway 문구를 그대로 둔다 | 옛 서버의 compose 운영자는 지금처럼 틀린 Railway 명령을 계속 본다. 알 수 없는 것을 단정하지 않는 쪽(F2·F7)을 택했고, 후퇴 창은 서버 먼저 배포로 줄인다(F9). |
| P. Rust 시험이 운영자 스펙·셸 표 파일을 직접 읽는다 | pr-ci의 rust 필터(`.github/workflows/pr-ci.yml:190-191`)와 `scripts/tests/test_pr_ci_guardrails.sh`가 그 경로를 요구해 정책 파일 변경이 따라온다. 정책 PR 절차(ADR-0100·GITHUB_OPS)로 택할 수는 있으나, 이 증보는 그 변경을 요구하지 않는 설계(골든 + local gate 시험, 수용 기준 6·8)를 권장한다. |

### 구현 슬라이스

- **#4337 (engine, R2-01)** — F1~F4·F8: `environment` 필드, 분류 함수(열거형만 보관), 상태 본문 조립을 DB 없이 시험하도록 핸들러가 부르는 순수 함수로 분리, 시험(수용 기준 1~11), 골든 `docs/api/cohosted-agent-status.golden.json`과 그 고정 시험, 운영자 스펙에 상태 라우트·`environment` 문서화(사실 7), 클라이언트 wire 파서(`packages/momo-core/src/features/settings/cohostedAgent.ts`의 `statusFromWire`가 `environment`를 필드 단위로 읽는다, F2·수용 기준 11 — `docs/TRACKS.md`의 「최소 diff + 상대 트랙에 로그」 규율), 도장 표 드리프트 가드(수용 기준 8). 함께 바꿀 것: 낡아지는 서버 쪽 문장 — `config.rs:1764-1765`(「shows nothing」), 운영자 스펙의 `info.description`(provider link만 말한다). 이슈 본문 ⑤의 「드리프트 시험」은 골든 고정(수용 기준 6)과 shell 가드(수용 기준 8)로 대체하고 스펙 ↔ 골든 기계 대조는 후속(새 이슈 3)이다 — 이슈 본문·규모(S~M) 조정은 planner 몫이다. `packages/momo-core`를 건드리므로 해당 트리 typecheck/test와 `scripts/verify_merge_tree.sh`(AGENTS 검증표)도 함께 돌린다. 의존: 이 증보 Accepted(ADR-0100).
- **#4339 (uxui·core, R2-03)** — F7 문구 표(수용 기준 12). 파서는 #4337이 더하므로 이 이슈는 파서가 머지된 뒤 `environment`를 읽는다. 의존: #4337.
- **#4338 (uxui, R2-02)** — 온보딩 AI 단계의 `declaration ≠ not_declared` 갈래(찾음 → 연결 → 모델 인증 → 모델 고르기). `environment`는 플랫폼별 문구에만 쓴다. **`not_declared`에서는 새 이슈(제안 카드)가 들어오기 전까지 기존대로 `hidden`(아무것도 그리지 않음)이다**: 이슈 본문 수용 기준 2의 「선언 없음」은 그 `hidden` 시험이고, 카드가 들어오면 새 이슈가 그 시험을 바꾼다(이슈 문구 조정은 planner).
- **#4340 (engine·docs, R2-04)** — 설치가 Hermes를 한 번 묻는 갈래. 이 증보와의 접점은 F6 카드의 compose 계획이 가리키는 두 명령(사실 8)뿐이다. 기본 스택은 달라지지 않는다(A2).
- **새 이슈(번호 미정)**
  1. 호스팅 제안 카드(UXUI): F6, 수용 기준 13. 로드맵 #4349에 항목으로 올린다(그 본문의 `## 항목`이 지금 비어 있다. 리서치 r2의 번호 R2-10은 레포 밖 보고서의 것이다). 의존: #4337·#4339. 함께 바꿀 것: 클라이언트 머리말 규칙 1(「선언 없음 = 숨김」, `cohostedAgent.ts:9-11`)의 **문구**를 카드가 그리는 범위로 고친다. `fetchCohostedStatus`의 매핑(`:146`)은 그대로다(F6) — 카드는 별도 읽기를 쓴다. `AgentProviderPinSection` 회귀 시험도 함께.
  2. (선택) Railway 생성기가 Hermes 변수를 출력(리서치 r2의 R2-11): A4(「`HERMES_API_KEY`는 생성기 정본 키 집합(45)에 넣지 않고(T2 stdout 불변)」)와 `self_host_env.sh:277-278`(Railway와 `--with-agents` 동시 금지)을 바꾸므로 **별도 증보가 먼저**다. 이 증보는 A4를 바꾸지 않는다.
  3. 운영자 스펙 ↔ 골든 기계 검사(수용 기준 7의 후속): 신규 검사의 gate 편입은 `scripts/local_gate.sh`(정책 파일) 변경이라 정책 PR 절차를 따른다.
  4. 선언은 있으나 Hermes가 응답하지 않을 때(프로브 `unreachable`)의 안내 — Railway 카탈로그 인스턴스의 기본 경로다(F6의 「닿는 배포」).

### 수용 기준 (red proof — 해당 분기를 지우면 실패해야 한다)

레인 표기: **[rust]** PR CI `rust` 레인의 `cargo test --workspace`(`#[ignore]` 아님, `server-rust/` 변경으로 선택된다) · **[pack]** Security pack(`infra/security-pack/selection.txt`의 `#[ignore]` PG 타깃 — `login_relay_conformance_pg`가 들어 있다) · **[nightly]** 그 밖의 `#[ignore]` PG 시험(`security-nightly.yml`; `cohosted_agent_conformance_pg`는 selection에 없다) · **[local gate]** `scripts/local_gate.sh --profile docs`(PR CI가 아니다 — ADR-0214 D6과 같은 한계) · **[node]** PR CI `node` 레인 · **[release]** 릴리스 확인. Rust 시험이 `server-rust/` 밖 파일을 읽으면 pr-ci의 `rust=true` 필터(`.github/workflows/pr-ci.yml:190-191`)와 `scripts/tests/test_pr_ci_guardrails.sh`가 그 경로를 요구한다(둘 다 정책 파일, `scripts/verify_policy_integrity.sh:225-262`). 아래 시험은 그 변경을 요구하지 않게 짠다: Rust 시험은 `server-rust/` 안 입력과 이미 필터가 덮는 `docs/api/*.golden.json`만 읽는다. 파일을 읽는 모든 가드는 파일·상수를 못 찾으면 건너뛰지 않고 실패한다. 수용 기준 2·5·6의 [rust] 시험은 핸들러가 실제로 부르는 순수 조립 함수(`declared`·`label`·`attested`·`connected`·`environment` → 응답 본문)를 대상으로 한다 — `StatusResponse` 필드가 private이라 같은 모듈의 시험이고, 핸들러가 그 함수를 쓰지 않으면 시험이 죽은 코드를 지키는 가드가 되므로 4([nightly])가 200 본문 전체를 같은 입력의 조립 함수 출력·구성별 기대값과 대조해 그 연결을 값으로 묶는다 [권장]. PG 시험(2의 [nightly] 절반·4)은 PR 시점 증거로 로컬 `--ignored` 실행 원문을 PR 본문에 남기고, 팩에 더할지는 #4337이 팩 시간을 재서 정한다(`infra/security-pack/`는 정책 경로가 아니다).

**#4337**

1. **[rust]** (판정표) 조회 함수를 주입해 행마다 한 입력만 다르게 한다: `RAILWAY_ENVIRONMENT_ID` 있음 → `railway` · 도장 `railway` → `railway` · 둘 다 없음 → `compose` · 도장 `fly`·`aws-lightsail`·`gcp-vm`·`host-network` 각각 → `compose` · 도장 `bogus` → `unknown` · 충돌(시스템 변수 있음 + 도장 `fly`) → `railway` · **시스템 변수 있음 + 도장 `bogus` → `railway`** · 공백만인 시스템 변수 → 없는 것 · **공백만인 도장 → `compose`** · **`" railway"`(앞뒤 공백) → `unknown`** · `Railway`(대문자) → `unknown`. 사보타주: 우선순위를 뒤집으면 충돌 행 둘이, 2번 줄의 「비어 있음」 처리를 지우면 공백만인 도장 행이, trim을 넣으면 `" railway"` 행이, T1 이름 하나를 지우면 그 행이, 5번 분기를 `compose`로 바꾸면 `bogus` 행이 빨개진다.
2. **[rust]** (문자열을 되돌리지 않는다) env에 표식 `MARKER-PLATFORM-…`(도장)·`MARKER-RWENV-…`(Railway id)·`marker-relayurl-…`(공개 https 호스트라 쓰기 게이트를 통과해 `on`이 되는 중계 URL — **소문자·숫자·`-`만** 쓴다: 호스트는 `split_url`이 소문자로 정규화하므로 `provider.rs:539-540` 대문자 표식은 정규화된 값에서 찾을 수 없다. 표식 검색은 대소문자를 무시한다)·`MARKER-RELAYKEY-…`(32자 이상·허용 문자의 중계 키)를 넣는다. **`from_lookup` 호출과 상태 본문 직렬화를 같은 `tracing` 캡처 구독 아래에서 돌린다.** 구성은 플랫폼 표식으로 셋으로 나눈다 — (a) Railway id 표식만, (b) 도장 표식만(모르는 값이라 5번 줄 `unknown`), (c) 둘 다(1번 줄에서 끝난다). URL·키 표식은 셋 모두에 넣는다. 한 구성에 도장과 Railway id를 함께 넣으면 분류가 1번 줄에서 끝나 도장을 다루는 줄에 닿지 않으므로, 도장 값을 로그에 남기는 구현은 (b)에서만 빨개진다. 직렬화한 본문과 캡처한 로그에 그 구성의 표식이 0건이고, `environment`의 키 집합은 정확히 `{platform, loginRelay}`이며 값은 열거형 안이다. 범위는 새 필드와 비밀 표식이다(기존 `endpointLabel`은 바뀌지 않는다). **[nightly]** 같은 구성의 200 본문과 403 본문에서도 0건. **[rust]** 도장·Railway id 표식을 넣어 파싱한 설정에 `format!("{:?}")`를 해도 그 두 표식은 0건이다(원문 비보관, DB 필요 없음). 중계 URL은 이 단정의 대상이 아니다: `LoginRelayConfig`의 기존 `Debug`는 URL을 가린 라벨(호스트 포함)로 찍는 것이 현행 의도다(`config.rs:1825-1838`). **[nightly]** probe·connect 응답에 `environment` 키가 없다(별도 시험). 사보타주: `loginRelay`에 정규화된 URL(`target().base_url`)이나 라벨을 싣거나, 파서가 값을 `warn!`으로 찍거나(도장 값이면 (b)가 잡는다), 원문을 그대로 직렬화하거나, `Debug` 출력에 도장·Railway id 원문을 넣으면 빨개진다.
3. (`loginRelay`는 라우트와 같은 술어) **[rust]** 판정 함수 하나(`target(&settings).is_some()` 호출)를 표로 시험한다: URL 없음·키 없음·키 형식 불량(31자·257자·문자 집합 밖·`${{shared.X}}` 잔존)·URL이 쓰기 게이트에 거절됨·URL에 경로·정상(env에 기대지 않는 공개 https). 내부 호스트(`http://hermes:8643` 등)는 `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`과 `AGENT_PROVIDER_LOCAL_HOSTS`가 있을 때만 `on`이 되므로 프로세스 env를 심어야 한다 — 병렬 시험의 전역 상태를 피하려고 그 행은 env를 직렬화해 넣는 시험(또는 [pack]의 한 구성)으로 따로 둔다. **[pack]** `login_relay_conformance_pg`에 같은 구성별로, 열 개 라우트·메서드 각각(본문이 필요한 넷 — 모델·앱 각 시작·완료 — 은 올바른 본문으로)에서 `409 login_relay_off`가 나는 것과 상태의 `loginRelay: off`가 일치함을 더한다(`on`일 때는 `409 login_relay_off`가 아님만 단정한다 — 그 뒤 404 등은 허용). 사보타주: 상태가 `configured()`를 쓰면 게이트 거절·경로 행이 빨개지고, 라우트 하나가 `prepare()`를 우회하면 그 라우트 행이 빨개진다.
4. **[nightly]** (네트워크 0·권한·핸들러 연결) `cohosted_agent_conformance_pg`: 선언 없음 + 운영자 → 200이고, 본문 전체가 같은 입력으로 조립 함수를 직접 부른 결과와 같으며 `environment`는 그 구성에서 기대하는 값(`platform`·`loginRelay`)이다 — 핸들러를 조립 함수에 값으로 묶는 대조다(시험한 구성에 한해서다. 구성은 둘 이상으로 한다). 모의 에이전트와 모의 중계(계수 클라이언트를 `with_login_relay`로 꽂는다)의 요청이 0건이다(기존 `undeclared_means_zero_requests_even_with_a_live_agent_at_the_env_url` 확장). 비운영자(워크스페이스 admin·타 테넌트) → 403이고 본문에 `environment`가 없다. 사보타주: `require_instance_operator_write` 줄을 지우면 비운영자가 200과 `environment`를 받아 빨개지고, 조립 함수가 `environment`를 비우거나 바꾸면 본문 대조가 빨개진다.
5. **[rust]** (판정에 안 쓰임) 두 기준 상태 — `ready`+attest+미연결(`connectable=true`)과 연결됨(`connectedAgentId` 있음) — 각각에서 `platform`×`loginRelay` 전 조합의 `declaration`·`connectable`·`connectedAgentId`가 같다. 사보타주: `connectable`에 `platform`을 섞으면 빨개진다.
6. **[rust]** (호환·모양 고정) 상태 응답을 직렬화한 본문이 골든 `docs/api/cohosted-agent-status.golden.json`과 같다(기존 키 그대로 + `environment`만 더해짐, `schema`는 `momo.cohosted_agent.status.v0`). 열거형 값 전체(`railway|compose|unknown`, `on|off`)는 변종마다 직렬화해 고정한다. 골든은 이미 필터가 덮는 경로다(`docs/api/[^/]+\.golden\.json$`). 사보타주: 키 이름이나 열거형 값을 바꾸면 빨개진다.
7. (운영자 스펙) 스펙에 상태 라우트와 `environment`(열거형 값 고정)를 문서화한다. `loginRelay`의 `on`·`off`는 따옴표로 인용한다 — 따옴표 없는 `on`/`off`는 YAML 1.1 파서(Ruby Psych 등)가 불리언으로 읽는다. **스펙 본문 ↔ 골든의 기계 대조는 이 증보가 요구하지 않는다** — 운영자 스펙에는 검사 기반이 없고(사실 7) 새 검사의 gate 편입은 정책 파일 변경이다(기각 대안 P). 한계로 적고 검수가 대조한다. 후속은 새 이슈 3.
8. **[local gate]**+**[rust]** (도장 표 드리프트) `scripts/tests/test_self_host_env_modes.sh`(docs 프로파일의 기존 단계, 이미 `platform_profiles`를 다룬다)에 단정을 더한다: `platform_profiles()`의 T2 이름 집합이 `{railway}`이고 T1 이름 집합이 서버 소스의 이름 고정 상수(위치·이름은 #4337이 정하고 시험이 그 이름으로 찾는다)와 같다. 이름은 한 줄에 하나씩 앵커 주석이 붙은 상수로 두고(`cargo fmt`가 펴도 한 줄에 하나), shell은 추출한 개수 = T1 이름 개수와 이름 집합 일치를 단정한다 — 같은 파일의 시험 리터럴과 구분하려고 앵커 주석을 쓴다. Rust 쪽은 같은 상수를 리터럴로 고정하는 단위 시험을 둔다. 새 행(예: `render`)이나 이름 변경은 shell 시험이 잡는다. **한계**: PR CI는 shell 쪽 대조를 돌리지 않는다 — `self_host_env.sh`나 Rust 상수만 바꾸는 PR은 local gate에서만 막힌다.
9. **[rust]** (`Default`) 시험이 `..Default::default()`로 만드는 설정의 `platform` 판정이 빈 조회(`from_lookup(|_| None)`)와 같다.
10. **[release]** 실제 Railway `api`에서 `platform: railway`가 나오는지 확인해 기록한다(방법과 실패 시 복구는 F3).
11. **[node]** (클라이언트 파서) 옛 서버(`environment` 없음)·깨진 답(객체 아님)·미래 서버(허용 목록 밖 값)·한쪽만 있는 경우 fixture로, 없거나 밖의 필드만 `unknown`/「모름」으로 접히고 상태 읽기 전체는 유지된다. 사보타주: 밖의 값에서 `null`을 돌려주면(응답 전체 버림) 빨개진다.

**#4339 (클라이언트 문구)**

12. **[node]** `compose`: 사용자에게 보이는 모든 문구(대체 명령·`shellLead`·삭제 안내·계획 문장, 사실 4의 일곱 위치를 포함한 문구 표 전체)에 `railway`(대소문자 무시) 0건(표 전체를 훑는 시험) · `railway`: 현행 문구와 바이트까지 같음(회귀) · `unknown`·`environment` 없음: `railway ssh`·`docker compose` 명령 문자열 0이고 일반 문장 · 문구 스냅샷. 사보타주: `compose` 표에 `railway ssh`나 「Railway 터미널에서」를 되돌려 넣으면 훑는 시험이 빨개진다.

**새 이슈 (제안 카드, F6)**

13. **[node]** 카드가 부르는 요청은 상태 읽기 GET 하나이고 쓰기 요청이 0건이다(계수; 사보타주: 카드가 `connectCohosted`/`probeCohosted`를 한 번 부르면 빨개진다) · `not_declared` + 운영자에서만 카드, 비운영자는 카드 없음(사보타주: 게이트 분기를 지우면 비운영자 fixture에서 빨개진다) · 복사 프롬프트에 URL·키·환경 id·이메일 표식 0건이고 §0 규율 문장 포함(사보타주: 프롬프트에 표식을 끼우면 빨개진다) · 폴링: 간격·5분 상한, 전송 오류와 502/503/504에서 이전 상태 유지(사보타주: 오류를 `hidden`으로 접으면 빨개진다) · `AgentProviderPinSection` 회귀: `not_declared`에서 `envLinkAvailable`이 거짓(사보타주: `not_declared`를 `ready`로 올리면 빨개진다) · 기존 소비자의 오프라인·5xx 동작이 그대로(`cohostedAgent.test.ts`의 TypeError → `hidden` 유지) · compose 계획 문장에 「기본 compose 스택 기준」 문구가 있음 · 서버가 실행하는 동작이 없음은 소스 grep이 아니라 카드 모듈이 쓰는 요청 함수 집합을 GET 상태 읽기 하나로 단정하는 import 그래프 시험과 위의 쓰기 계수 시험으로 증명한다 · design-review Blocker 0·High 0.

### 바뀌지 않는 것

D1(마지막 문장만 F6으로 좁혀진다)·D2(고정 두 요청 + 요청 시 toolsets + M2의 옵션 읽기 하나)·D3 인스턴스 운영자만·D4·D5·D6·D7·D8·D9, owner 결정 질문 1~7(위임 결재 2026-10-16, Q2 (b) 포함), K1~K7, A1~A5(특히 A4: 「`HERMES_API_KEY`는 생성기 정본 키 집합(45)에 넣지 않고(T2 stdout 불변)」), L0~L6과 L절의 owner 결정 Q1~Q3(중계 허용·Claude 중계·설치 스크립트로 켠다), M1~M5, `HERMES_API_KEY`의 의미, oort가 구독 OAuth 토큰·원본 키를 받지도 저장하지도 않는다는 불변식, 온보딩의 구독 로그인 순서(#4338의 몫), DB·마이그레이션·서버 코드(이 PR은 문서만).

## 증보 2026-10-25 — Railway 생성기의 Hermes 공유 변수 출력(옵트인), A4′ (#4461)

- Status: **Accepted** (2026-10-26, owner 결정 「권장으로 승인」 — G6 질문 (a) 승인, 부가 질문은 권장대로 「아니오」). 옵트인 플래그가 있을 때 생성기가 낼 수 있는 비밀의 집합이 둘 늘어나는 경계 확대라 owner가 직접 정했다(이슈 #4461 기준). 구현은 이 증보의 구현 슬라이스 이슈가 맡는다.
- 독립 설계 검토: r1 FAIL(High 2·Medium 12·Low 9) → r2 **PASS**(Blocker 0·High 0·Medium 4·Low 15). r2의 Medium 4와 Low 15는 이 절에 반영했다. 남긴 것은 한계로 적었다: 11자 미만의 접두 누출을 시험이 단정하지 않는 것(수용 기준 3), 픽스처 디렉터리 밖에 쓰는 변형(수용 기준 2). 반영한 변경분은 3회차 검토 없이 작성자가 코드와 실행으로 대조했다. 검토 보고서는 로컬 자료(레포 밖)이고 요약은 PR 본문에 있다.
- 기안: Sonnet 5.5 엔진 워커 (#4461, 온보딩 r2 R2-11). 근거: 리서치 r2 온보딩 보고서 §5 R2-11(로컬 자료, 레포 밖), 이 문서의 A4와 10-25 증보의 「새 이슈 2」. 이 PR은 문서 한 파일만 바꾼다. 결정 번호 G1~G9의 G는 생성기(generator)다.
- owner 결정(원문 인용):
  - 성재 2026-10-21(로드맵 #4349 본문): 「…사용자의 사용 부담이나 설정 부담을 확 낮추고 싶어.」
  - 위임 2026-10-22: 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 — 아래 **[권장]**은 이 위임에 따른 planner 결정이고 owner에게 보고된다. 시크릿 출력 범위를 넓히는 부분(G1·G2)은 이슈 #4461이 위임 밖의 owner 결정으로 남겼다(G6).
  - 성재 2026-10-19(이 문서 「Hermes 로그인 중계」의 Q3 「설치 스크립트로 켠다」): 설치 스크립트가 `HERMES_LOGIN_RELAY_KEY`를 자동 생성해 Hermes 서비스와 `api`에 같은 값을 넣는다. 「수동 설치는 기존 동작 그대로」이고, compose 경로에서 이미 승인된 일이며, 이 증보는 같은 생성을 Railway 생성기의 선택 경로로 넓힌다.
- 표기: [V] 이 세션에서 직접 확인(코드·문서는 `track/engine` `2a2300a63` 기준 파일:줄, 실행은 더미 환경) · [추정] 해석 · [권장] 위임 결정 · `runtime-unverified` 실행 안 함. 이 증보는 설계이고 이 PR은 문서만 바꾼다.

### 비교 참조 (ADR-0100)

- [리서치 r2 §2.3, 2026-10-21 확인] Railway·Render·Coolify·Umbrel은 템플릿·한 줄 설치가 시크릿을 **자동 생성**한다(10-25 증보의 「비교 참조」와 같은 출처). 가장 강한 모양은 Railway 템플릿의 `${{secret(length, alphabet)}}`이고, Railway가 배포 시 만들어서 값이 운영자 기계를 지나지 않는다. 이 레포의 카탈로그는 템플릿이 아니라 손으로 타이핑하는 서비스 목록이고(`infra/railway/railway.json`의 `notes.variables`) `secret(` 표현이 0건이라 [V] 그 모양은 지금 쓸 수 없다(기각 대안 E). 이 증보는 한 단계 아래의 모양을 고른다: 생성기가 만든 값을 운영자가 한 번 붙인다 — 이미 다른 비밀 17개가 가는 길이다(사실 2).

### 확인한 사실 [V]

1. **기본 출력.** `emit_managed_platform_env`(`scripts/self_host_env.sh:1673-1777`)는 정본 키(`oort_emit_canonical_keys`, `:1755-1762`)를 `KEY=value`로, 그다음 도장 한 줄(`:1764-1765`)을 stdout에 쓰고 파일은 쓰지 않는다. 정본 키는 생성기 heredoc의 키와 공개 엣지 키의 합집합이다(`:412-414`). 이 세션이 `--platform railway --claim`을 더미 환경(`RAILWAY_PUBLIC_DOMAIN`·`DATABASE_URL`·이미지 digest)으로 실행해 보니 stdout은 **47줄이고 전부 `KEY=value`이며 주석·빈 줄이 0**이다(정본 46 + 도장 1). 그래서 Raw Editor에 그대로 붙는다(`infra/railway/README.md:106`).
   - 숫자는 시험이 같은 값을 단정한다: 정본 46(`scripts/tests/test_self_host_env_modes.sh:1098-1103`; `scripts/tests/test_self_host_build_sha.sh:201`·`:240`도 단정하지만 `.github/`·`local_gate.sh`에 이름이 0건이라 어느 게이트에도 연결돼 있지 않다), stdout 47과 stderr 문구 「키 47개를 stdout에 썼다」(`test_self_host_env_modes.sh:1473`·`:1508-1512`), `scripts/tests/test_railway_template.sh:204-205`. **A4의 「45」는 작성 시점(10-19)의 값**이고 #3947(`GITHUB_APP_MASTER_KEY`, 시험 주석 `test_self_host_env_modes.sh:1109`)이 46으로 올렸다. 낡은 표기가 남아 있다: `infra/railway/README.md:85`·`:102`와 `infra/railway/railway.json`의 `notes.platformStamp`(45), `scripts/self_host_env.sh:216-217`·`:408`·`:411`·`:764`·`:1671`·`:2328`(43·44), `docs/SELF_HOST_AGENT.md:98`·`docs/SELF_HOST.md:559`·`:1024`·`:1027`·`docs/SELF_HOST.ko.md:512`·`:890`·`:892`(43~45), `scripts/tests/test_railway_template.sh:116`의 주석(45). 이 증보는 46/47로 쓴다.
2. **같은 stdout에 이미 있는 비밀.** 그 47줄 중 이름에 `PASSWORD`·`SECRET`·`_KEY`·`HMAC`·`DATABASE_URL`이 든 것이 **17개**다(claim 변형 기준, 이름 패턴으로 센 것이고 값은 읽지 않았다. 비밀번호 변형은 `MOMO_INITIAL_OWNER_PASSWORD`가 더해져 18). `JWT_HMAC`(토큰 위조)·`PROVIDER_LINK_MASTER_KEY`·`MIGRATE_DATABASE_URL`(슈퍼유저 DSN, `infra/railway/README.md:74-77`)이 들어 있다. 이 집합은 두 번 넓어진 이력이 있고 둘 다 기본 경로에 들어갔다: 웹훅 마스터 키 둘(#2066, ADR-0004 증보 4)과 `GITHUB_APP_MASTER_KEY`(#3947, ADR-0205 D1). 기본 스택이 그 키를 쓰기 때문이다. Hermes는 선택 기능이라 A4가 기본 경로에서 뺐고, 원문이 밝힌 이유는 「T2 stdout 불변」이다.
3. **Hermes 비밀 둘의 현재 경로.** 카탈로그는 이미 두 공유 변수를 **참조**한다. `HERMES_API_KEY`: api(`infra/railway/railway.json:111`)·agent-worker(`:153`)·hermes의 `API_SERVER_KEY`(`:171`). `HERMES_LOGIN_RELAY_KEY`: api(`:116`)·hermes(`:174`)이고 agent-worker는 갖지 않는다. 생성기는 이 둘을 내지 않으므로 운영자가 손으로 만든다(`infra/railway/README.md:195-198`의 `openssl rand -hex 32`, 릴레이 키는 `:159`). 검증기는 이 둘을 「생성기가 내지 않는 공유 변수」로 허용목록에 둔다(`scripts/tests/check_railway_catalog.py:92-95`의 `OPERATOR_SHARED`, 적용 `:1006`; 같은 파일 머리말 `:16`의 규칙 「`${{shared.KEY}}` must name a key the generator writes」의 예외). 그 밖에 `hermes` 서비스 전용의 `<operator: …>` 값 네 개(`HERMES_CONFIG_B64`·`HERMES_LOCKGATE_B64`·`HERMES_LOGIN_RELAY_B64`·`HERMES_LOGIN_PROBE_B64`, `railway.json:172-176`)와 서비스별 리터럴 배선(`HERMES_BASE_URL` 등)이 손으로 들어간다. 카탈로그의 공유 참조 39개 중 claim 변형 기본 출력에 없는 것은 정확히 이 두 이름이다(이 세션이 계산).
4. **T2와 `--with-agents`의 동시 금지.** `validate_platform_request`의 T2 갈래(`scripts/self_host_env.sh:265-280`)가 이미지 모드(`:271-272`)·`--public-origin`(`:273-274`)·로컬 provider(`:275-276`)와 나란히 `--with-agents`를 거절한다(`:277-278`, 메시지 「Railway는 infra/railway/railway.json 의 hermes 서비스를 쓴다」). `--compose`는 T2 갈래 앞에서 거절된다(`:263-264`). 사용법도 같은 말이다(`:567` 「Local-install only — not for a T2 platform」). T2는 `emit_managed_platform_env`에서 끝나므로(`:2081-2084`) compose 경로의 `ensure_cohosted_agent_env`(`:1418-1483`)에 닿지 않는다. 시험은 이 거절이 일어남을 단정하고(`test_self_host_env_modes.sh:2106-2111`) T2 조합 거절 목록(`:1561-1582`)에는 `--with-agents`가 없다.
5. **compose 경로의 Hermes 키 규칙(참고).** `ensure_cohosted_agent_env`는 두 키를 각자 `gen`으로 뽑고(`:1440`·`:1455`; `gen`은 `openssl rand -hex 24` = 48자, `:159`), 이미 있는 API 키는 비어 있을 때만 바꾸며(`:1437-1441`), 릴레이 키는 `^[A-Za-z0-9._~+/=-]{32,256}$`가 아니면 새로 만든다(`:1453-1456`). 값은 stdout·stderr에 쓰지 않고(시험 `:1945-1966`), 독립은 정적으로 단정한다(`:1953-1962`) — 시험의 fake openssl이 모든 호출에 같은 문자열 「a…a」를 돌려주기 때문이다(`:136-148`). compose는 0600 env 파일이 상태이고 T2는 파일이 없다.
6. **키의 요건.** API 키는 Hermes 잠금 게이트가 32자 미만이면 거절한다(`infra/hermes/lockgate.py:198-199`, 볼륨 `.env`는 `:175-176`). 릴레이 키는 서버가 32~256자·`[A-Za-z0-9._~+/=-]`만 받고 어긋나면 중계를 **조용히 끈다**(`server-rust/bins/momo-server/src/config.rs:1858-1874` — 어긋난 키는 `LoginRelayConfig::default()`가 되어 `409 login_relay_off`; 미해결 `${{shared.X}}` 잔존도 같은 규칙으로 거절된다고 `:1812`가 적는다). 사이드카도 같은 정규식을 쓴다(`infra/hermes/login_relay.py:66`·`:1040`, 키가 없거나 짧으면 꺼짐 `:25`). 릴레이 키는 채팅 키와 별개의 비밀이어야 하고 「256비트 이상 무작위」다(이 문서 L2).
7. **T2 재렌더의 값 규칙.** 생성기는 주변 env에 값이 있으면 그대로 다시 내고 없을 때만 `gen`으로 만든다(`platform_secret`, `:1564-1572`; 비밀번호 넷은 `${VAR:-$(gen)}`, `:1716-1719`). README는 이 때문에 「이미 도는 프로젝트 위에서 생성기를 다시 돌려 붙이지 마라 — export하지 않은 비밀이 전부 새로 만들어져 돌고 있는 인스턴스의 비밀이 회전한다. 생성기는 새 프로젝트용이다」(`infra/railway/README.md:583-588`, 원문 「Do not re-render the generator over live variables … The generator is for a new project.」)라고 적는다. `docs/SELF_HOST.md:1158-1181`(「플랫폼(T2: Railway 등)에는 env 파일이 없다」)은 이 재렌더를 **지원되는 절차**로 적고 「이미 회전해 둔 키를 export해 두면 그 값이 그대로 유지된다」(`:1174`)고 한다.
8. **비밀 취급 문서.** README는 stdout을 `umask 077` 아래 `~/.momo-secrets/railway-oort.env`로 리다이렉트하게 하고(`:90-94`) Raw Editor에 붙인다(`:106`). `docs/SELF_HOST_AGENT.md`의 §3.4 스니펫은 리다이렉트를 보이지 않는다(`:2261`, 한국어판 `:1895`, `docs/SELF_HOST.md:1078`·`docs/SELF_HOST.ko.md:940`도 같다). 그 문서의 §0은 비밀을 채팅에 붙이지 못하게 한다(`:31-34`). 설치 에이전트가 스니펫대로 돌리면 stdout이 에이전트 기록에 남을 수 있으므로, stderr는 이름·개수만 담아야 한다(현행 `:1766-1769`가 그렇다).
9. **어디서 시험이 도는가.** 생성기 시험은 `local_gate.sh`의 `add_static_commands`(`:627`, 시험 줄 `:692`) 안에 있어 docs·staging-smoke·all 등 이 함수를 부르는 프로파일에서 돈다(`secrets`·`web` 등은 부르지 않는다, `:1008-1093`). Railway 시험은 docs 프로파일이다(`:1016`). `--auto`는 `scripts/self_host_env.sh` 변경을 staging-smoke로 고른다(`:173-174`)이므로 구현 PR은 프로파일을 명시한다. `.github/` 아래에는 두 시험의 이름이 0건이다 — **PR CI는 이 시험들을 돌리지 않고** local gate에서만 막힌다.
10. **doctor.** 필수 키 판정은 생성기 heredoc의 키가 env 파일에 다 있는지만 보고(`scripts/lib/oort_doctor.sh:38-47`·`:325-353`) 초과 키를 거르지 않는다. 저장한 T2 파일에 줄이 더 있어도 판정은 같다 [V, 코드 읽기, 실행하지 않음].
11. **Railway 공유 변수의 도달.** 공유 변수는 서비스가 참조 변수를 만들어야 닿는다(10-25 증보 사실 5가 인용한 `https://docs.railway.com/variables`). 카탈로그가 서비스별로 정확히 이 참조만 둔다(사실 3).
12. **기준선.** 변경 전 HEAD에서 `check_railway_catalog.py … --prove-mutations`를 위 47키 목록으로 실행하니 exit 0, RED 77건이고 committed 카탈로그가 복원돼 통과한다(`scripts/tests/test_railway_template.sh:249-251`의 호출과 같은 모양). A4가 적은 「14건」은 낡았다.
13. **릴레이 키는 base64 둘과 묶여 있다.** hermes 시작 명령은 `set -eu` 아래에서 `[ -z "${HERMES_LOGIN_RELAY_KEY:-}" ] || { : "${HERMES_LOGIN_RELAY_B64:?}" "${HERMES_LOGIN_PROBE_B64:?}"; … }`를 실행한다(`infra/railway/railway.json:161`, 모양은 `check_railway_catalog.py:286-287`이 고정). 키가 비어 있지 않은데 base64 둘이 없으면 hermes가 기동하지 않는다(fail-closed). README도 두 base64를 「needed only with the relay key」라고 적는다(`:160-161`).
14. **기본 출력은 결정적이다 — 환경을 비운 실행에서.** 이 세션이 기본 출력(비밀번호·claim 변형)을 `env -i`로 허용목록 환경(`HOME`·`PATH`와 시험의 fake openssl — `rand -hex N` → `a`×2N —, `RAILWAY_PUBLIC_DOMAIN`·`DATABASE_URL`·`MOMO_RUST_IMAGE`)에서 두 번씩 실행해 stdout·stderr가 바이트 동일함을 `cmp`로 확인했다. 그러나 **주변 환경 변수에는 의존한다**: 같은 실행에 `COMPOSE_PROJECT_NAME`·`MOMO_INITIAL_OWNER_EMAIL`·`MOMO_APP_POSTGRES_PASSWORD`를 더하면 stdout이, `JWT_HMAC`을 더하면 stdout·stderr가 달라지고 `HERMES_*`는 달라지지 않는다(이 세션이 확인; 생성기가 그 이름들을 읽는다 — `infra/railway/README.md:92`의 `MOMO_INITIAL_OWNER_EMAIL` export가 그 예다). 그래서 해시·골든 고정은 허용목록 환경에서만 안정적이다(G7). 기본 stderr의 가장 긴 `[A-Za-z0-9]` 연속은 10자(`CENTRIFUGO`)다.
15. **같은 이름을 쓰는 도구가 이 레포에 있다.** 시험 도우미 `run_platform_stdout`은 환경을 비우지 않고 변수 셋을 더할 뿐이고(`test_self_host_env_modes.sh:1442-1453`), `run_generator`(`:154-165`)는 stdout·stderr를 한 파일로 합치며 `RAILWAY_*`를 주지 않는다. `HERMES_API_KEY`를 쓰는 곳: `infra/.env.example:217`(env 파일 예시, `change-me-hermes-bearer`), `scripts/local_alpha_runner.sh:228`·`:242`(자기 프로세스에서 export), `scripts/gate_runtime_db.sh:134`(env 파일 생성), `docs/external-agent-provider/README.md:59`·`:72`(예시 문서).

### 바뀌는 기존 결정

아래는 이 증보가 Accepted될 때 바뀌는 것이다. Accepted 전에는 기존 본문이 그대로 정본이다.

- **A4(이 문서 「A4. Railway 카탈로그」)의 한 문장.** 「`HERMES_API_KEY`는 생성기 정본 키 집합(45)에 넣지 않고(T2 stdout 불변) 프로젝트 shared variable로 운영자가 한 번 만든다」에서 **「정본 집합에 넣지 않는다」와 「기본 T2 stdout 불변」은 그대로**이고, 「운영자가 만든다」만 옵트인 경로에 한해 「생성기가 만들어 stdout에 더한다」로 바뀐다(손으로 만드는 길도 그대로 유효하다). 숫자는 45가 아니라 46이다(사실 1).
- **A3의 「응답·로그·출력에 값을 내지 않는다」와 「이미 있으면 다시 만들지 않는다」**(HERMES_API_KEY 줄)는 **T1(compose 파일 경로) 한정**으로 읽는다. T2 stdout은 다른 모든 T2 비밀처럼 의도적으로 값을 내고(사실 2), T2에는 「이미 있는」 파일이 없다. 로그·stderr·응답에 값을 내지 않는다는 쪽은 T2에도 그대로다(G5).
- **`self_host_env.sh:277-278`** — T2 갈래의 `--with-agents` 거절을 지우고 사용법 `:567`·`:552-570`을 고친다. 다른 T2 거절(이미지 모드·`--public-origin`·로컬 provider·`--compose`)은 그대로다.
- **ADR-0184 D3의 「정본 키 `oort_canonical_env_keys`에서만」**(`docs/adr/0184-platform-neutral-agent-driven-selfhost.md:27`)은 기본 경로의 규칙으로 남는다. 옵트인 경로만 정본 밖의 두 키를 도장과 같은 방식(heredoc 밖)으로 더한다. 도장은 비밀이 아니고 이 둘은 비밀이라는 점이 다르다 — G6이 그 때문에 있다.
- **10-25 증보의 사실 8(「`--platform railway`와 함께 쓸 수 없다」)·F3의 마지막 항(「Railway에서 `--with-agents`를 안내하면 그 플래그는 거절된다」)·F6의 railway 계획 문구(「Railway는 `--with-agents`를 쓰지 못한다」)** 는 이 증보가 Accepted되고 구현되면 낡는다. 그 증보의 본문은 역사로 두고 이 절이 정본이다. 그때까지 제안 카드(#4460)는 Railway 계획에 `--with-agents`를 쓰지 않고, 구현 뒤 문구 갱신은 카드 쪽 이슈의 몫이다(구현 슬라이스).
- D6-2(oort 비밀을 Hermes에 주지 않는다)·D6-5(attest의 의미)·A1·A2·A5·K·L·M은 바뀌지 않는다. F도 바뀌지 않는다 — 위의 F3 마지막 항·F6 railway 문구만 예외다.

### G1. 옵트인 플래그는 `--with-agents`를 T2에서도 받는 것이다 [권장]

- T2 갈래의 `[ "$WITH_AGENTS" -eq 0 ] || fail`(`:277-278`)을 지운다. 뜻은 tier를 따른다: T1은 기존 그대로(프로파일·배선 키를 env 파일에 쓴다), T2는 **stdout에 공유 변수 둘을 더한다**(G2). 다른 T2 거절은 그대로라서 `--platform railway --with-agents --local-build`·`--public-origin`·`--allow-local-provider`·`--compose`는 여전히 거절된다.
- 플래그가 없으면 stdout·stderr·종료 코드가 모두 바이트 단위로 같다(G7). `--claim`과 서로 독립으로 조합된다(팀 인스턴스가 `--claim`을 쓴다, `infra/railway/README.md:90-94`).
- 이유: 하나의 개념(「Hermes까지 설치」)에 하나의 플래그다. 문서의 두 자리(README Hermes 절, `SELF_HOST_AGENT.md` §3.4.1 「Zero-base shortcut」)가 compose 줄과 Railway 줄을 나란히 두므로 같은 플래그면 두 줄이 같은 문장이 된다. T2가 파일 쓰기 플래그를 거절하는 이유는 「stdout만 쓴다」는 계약이고(`:272`) 이 플래그는 파일을 쓰지 않아 그 계약과 부딪히지 않는다.
- 반대 견해와 완화: 뜻이 tier마다 달라 「Hermes 서비스를 만든다」로 읽힐 수 있다(기각 대안 A). 사용법 문구와 stderr 한 줄이 「공유 변수 두 줄만 더한다, 서비스는 카탈로그가 만든다」고 말한다.

### G2. 더하는 변수는 정확히 둘이다 [권장]

- **`HERMES_API_KEY`와 `HERMES_LOGIN_RELAY_KEY`**. 카탈로그가 이미 참조하는 공유 변수 전부이고(사실 3) 검증기가 이미 이름으로 고정한 집합이다(`OPERATOR_SHARED`). 새 이름이 없고 `railway.json`의 서비스·변수를 바꾸지 않는다.
- **더하지 않는 것**과 이유:
  1. 서비스별 리터럴 배선(`HERMES_BASE_URL`·`AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`·`AGENT_PROVIDER_LOCAL_HOSTS`·`HERMES_LOGIN_RELAY_URL`·`API_SERVER_*`) — 카탈로그에서 서비스마다 리터럴로 들어가고 공유 변수가 아니다. 공유로 내보내면 아무도 참조하지 않는 변수가 생긴다.
  2. **`OORT_COHOSTED_AGENT_TOOLS_LOCKED`** — api 전용 리터럴이고 검증기가 agent-worker에 없음을 고정한다(`api-hermes-attest-dropped`·`worker-hermes-attest`). Railway에서 선언을 기록하는 쪽은 카탈로그이고, 생성기가 공유 변수로 선언을 대신 쓰면 attest의 기록 주체가 둘이 된다(A3).
  3. **`HERMES_*_B64` 네 개** — hermes 서비스 전용 `<operator: …>` 값이다. stdout에 섞으면 붙여넣을 대상이 둘(공유 변수·hermes 서비스)이 되고, 공유 변수로 올리려면 카탈로그가 `${{shared.…_B64}}`를 참조하도록 바뀌어야 한다 — 카탈로그 배선은 이슈 #4461의 범위 밖이고 해시 고정 검증기(`check_railway_catalog.py`)의 계약도 바꾼다. **리서치 R2-11의 목표(키 2 + base64 4)에서 base64를 뺀 것이다. 조용히 좁히지 않고 PR 본문의 「권장으로 정한 것」에 적는다.** 후속 후보는 구현 슬라이스의 새 이슈 2다.
  4. `COMPOSE_PROFILES` — compose 전용이다.
- **릴레이 키를 내면 base64 둘이 필수가 된다(사실 13).** 플래그 출력은 릴레이 키를 항상 내므로, 플래그를 쓰는 운영자는 hermes에 `HERMES_LOGIN_RELAY_B64`·`HERMES_LOGIN_PROBE_B64`까지 넣어야 hermes가 기동한다 — 합치면 base64 손 단계는 4개다. 이것은 로그인 중계 사이드카를 켜는 것과 같고(hermes 시작 명령이 키가 있을 때만 사이드카를 띄운다, `infra/railway/README.md:209-215`) 위 Q3(「설치 스크립트로 켠다」)와 같은 선택이다. 수동 경로(플래그 없음)는 기존 동작 그대로 키 없이 시작한다(Q3).
- **끄는 길**: 그 줄을 붙여넣지 않고 api·hermes 서비스에도 `HERMES_LOGIN_RELAY_KEY`를 만들지 않는다(README `:159`: 공유 변수를 만들지 않으면 사이드카가 뜨지 않는다 — 키 없음 = 꺼짐, 서비스 쪽 참조 줄까지 함께 없어야 한다). 공유 변수만 지우고 서비스의 참조를 남기면 참조가 리터럴 `${{shared.…}}` 문자열(비어 있지 않음)로 남는다고 서버 주석(`config.rs:1812`)이 적고 [추정 — Railway 실측 없음], 그러면 시작 명령의 `-z` 검사가 키가 있다고 보고 base64가 없을 때 `${…:?}`에서 종료한다(사실 13, 셸 의미는 sh·dash·bash에서 재현됨). base64가 있으면 사이드카의 형식 검사가 거절해 꺼진다(사실 6). 그 길을 안내하지 않는다.

### G3. 출력 위치와 모양 [권장]

- Hermes 줄은 **도장 줄 뒤**에 `HERMES_API_KEY=…`, `HERMES_LOGIN_RELAY_KEY=…` 순으로 쓴다. 정본 키(정렬된 heredoc·공개 엣지 키)와 도장은 그대로 앞에 있다. 모든 줄이 `KEY=value`이고 주석·빈 줄이 없다(사실 1의 순수 dotenv 계약). 값은 정본 키와 같은 `quote_env_file_value`를 지난다(허용 문자에 따옴표가 없어 그대로 나간다, G4).
- 그래서 결정적인 시험 차선(fake openssl)에서 플래그 출력의 앞 47줄이 플래그 없는 출력과 **바이트 동일**하고 뒤 두 줄이 Hermes 줄이다(`head -n 47`·`tail -n 2`로 시험한다, 수용 기준 2; 실제 openssl에서는 비밀이 실행마다 달라 값까지 같을 수 없다). 정본 키 중 `HERMES_`로 시작하는 것은 없다.
- 두 키는 heredoc **밖**에서 쓴다(도장과 같다). heredoc에 넣으면 heredoc을 읽는 여섯 파일 — 생성기의 정본 집합(`:396-414`), `oort doctor`의 필수 키(`scripts/lib/oort_doctor.sh:38-47`), 시험 네 개(`test_self_host_env_modes.sh:174`·`:1621`, `test_railway_template.sh:92`, `test_self_host_build_sha.sh:155`, `scripts/tests/test_oort_upgrade_localbuild.sh:320`) — 이 모두 정본 46을 48로 읽어 기본 출력과 doctor 판정이 바뀐다.

### G4. 두 값은 항상 새로 만든다 — 환경의 같은 이름 변수는 읽지 않는다 [권장]

1. 각 값은 **자기 `openssl rand -hex 32` 호출**로 만든다(64자 hex, 256비트). `gen`(`-hex 24`)이 아니다: 릴레이 키는 L2가 「256비트 이상」으로 정했고 README의 수동 명령도 `-hex 32`다(사실 3). compose 경로가 `gen`(192비트)을 쓰는 것은 기존 편차이고 이 증보는 고치지 않는다. 두 호출은 서로 다른 변수에 담는다. 릴레이 키는 채팅 키·`JWT_HMAC`·다른 어떤 값에서도 파생하지 않는다(L2). 웹훅 키의 「이행 복사」 갈래(`:1596-1615`)에는 들어가지 않는다.
2. 값은 첫 stdout 바이트 앞에서, 기존 비밀을 만드는 블록(`:1716-1744`)과 같은 자리에서 만든다. 생성이 실패하면 stdout은 0바이트다(정본 47줄만 남는 부분 출력이 없다).
3. 64자 hex는 세 소비자의 요건을 구조로 만족한다: 잠금 게이트의 32자 하한, 서버·사이드카의 `[A-Za-z0-9._~+/=-]{32,256}`(사실 6). 그래서 형식 검사 코드는 필요 없고, 시험이 정규식 일치와 길이로 단정한다.
4. **주변 env의 `HERMES_API_KEY`·`HERMES_LOGIN_RELAY_KEY`는 읽지 않는다**(`platform_secret`의 재사용 의미를 쓰지 않는다, 기각 대안 L). 이름이 환경에 있으면 stderr에 이름만 말한다(G5). 이유: 이 플래그는 새 프로젝트용이라(G9) 지킬 기존 값이 없고, 재사용이 하는 일은 **다른 곳의 값이 들어오는 길**을 여는 것뿐이다. 이 레포의 다른 도구가 같은 이름을 쓰고(사실 15) 형식 검증은 값이 이 인스턴스의 것인지 알지 못한다 — 재사용을 막으면 그 오염 경로와, 검증·동치 거절·출처 표시라는 결정 셋이 함께 사라진다.
5. 새로 만든 비밀이 나가는 곳은 stdout 한 곳뿐이다. 파일을 쓰지 않는다(T2 계약, `:272`).
6. **구현 주의.** `test_self_host_env_modes.sh:1959`의 정적 가드는 주석이 아닌 줄에서 `HERMES_LOGIN_RELAY_KEY` 뒤에 `HERMES_API_KEY`·`API_SERVER_KEY`가 한 줄에 오면 빨개진다. 코드·메시지 어디서든 한 줄에서 API 키 이름을 먼저 쓰거나 줄을 나눈다. 그 가드는 고치지 않는다.

### G5. 값은 stderr·로그에 나가지 않는다 [권장]

- stderr의 새 줄은 이름·개수만 담는다. 첫 줄의 개수는 플래그가 있을 때 **49**(정본 46 + 도장 + 둘)로 말하고, 플래그가 없을 때의 문구는 한 글자도 바뀌지 않는다(「키 47개를 stdout에 썼다」, 시험이 grep한다 `:1473`·`:1512`).
- 플래그 경로의 새 줄(시험이 grep하는 고정 문구): ① 「새로 만들어 stdout 끝에 더했다」가 든 한 줄 — 두 이름, 「값은 쓰지 않는다」, 「서비스는 카탈로그가 만든다」 ② 환경에 두 이름 중 비어 있지 않은 것이 있으면 그 이름마다 「읽지 않았다」가 든 한 줄 ③ 서비스 변수(`HERMES_*_B64`·배선 리터럴)는 내지 않고 릴레이 키를 붙였다면 `HERMES_LOGIN_RELAY_B64`·`HERMES_LOGIN_PROBE_B64`가 필요하다는 안내와 가리킬 문서(`infra/railway/README.md` Hermes 절)를 든 한 줄. 값(전체)은 어느 줄에도 없고, 값에서 나온 11자 이상의 연속도 없다(수용 기준 3의 임계 — 그보다 짧은 접두·지문은 단정하지 않는다, 한계). 이 고정 문구들도 11자 이상의 영숫자 연속을 담지 않는다(그래야 수용 기준 3의 단정이 문구와 값을 구분한다).
- 이유: 설치 에이전트가 이 명령을 돌릴 때 stdout을 파일로 보내도 stderr는 에이전트가 읽는다. 값이 stderr에 한 번이라도 나가면 §0(비밀을 채팅에 붙이지 않는다)이 깨진다. 이 규칙은 이슈 #4461의 「비밀값은 생성만 하고 로그에 남기지 않아요」를 시험 가능한 말로 옮긴 것이다(수용 기준 3).

### G6. 경계 판정 — 시크릿 출력 범위는 옵트인 한정으로 넓어진다 → owner 결정

판별 기준을 둘로 나눠 적는다. 둘 다 본문에 남겨서, owner가 어느 기준을 택하든 Status 한 줄만 바꾸면 되게 한다.

| 비밀 | 받는 서비스(카탈로그, 불변) | 기본 stdout | 플래그 stdout | 운영자 캡처 파일 |
|---|---|---|---|---|
| `HERMES_API_KEY` | api · agent-worker · hermes(`API_SERVER_KEY`) | 없음 | 있음 | 플래그 때만 있음 |
| `HERMES_LOGIN_RELAY_KEY` | api · hermes | 없음 | 있음 | 플래그 때만 있음 |

- **보유자 기준(「어느 서비스가 어떤 비밀을 들고 있나」): 바뀌지 않는다.** `railway.json`의 서비스·변수가 그대로이고 검증기가 행렬을 이미 고정한다(G8). **새 서비스 수신자는 없다**: Railway 쪽 끝 상태는 수동 경로와 같다 — 운영자가 `openssl rand`로 만든 같은 두 값이 같은 공유 변수에 같은 서비스 참조로 들어간다(`README.md:195-198`).
- **생성기 쪽 경로는 이 두 값에 새로 생긴다.** 수동 경로는 값을 운영자 셸에서 만들어 곧바로 붙이는 것이 일반적이고(파일 저장을 요구하는 것은 `GITHUB_APP_MASTER_KEY` 절뿐이다, `README.md:590-596`) [추정], 플래그 경로는 값이 생성기 프로세스·stdout·운영자 캡처 파일(`README.md:90-94`)·터미널·설치 에이전트 기록에 존재한다. 그 파일은 이미 비밀 17개를 담고 `JWT_HMAC`처럼 이 둘보다 센 권한을 가진 값도 담는다(사실 2) — 파일이 털릴 때의 폭발 반경은 한계적으로만 는다. 다만 이것은 비밀의 강도만 비교한 말이다: 릴레이 키는 이 문서 L2의 보안 검수 H1이 에이전트조차 못 읽게 uid 분리까지 한 종류의 키라, 캡처 파일·설치 에이전트 기록에 놓이는 것은 종류가 다른 노출이다(owner 질문의 (b)가 이 점을 고른다). 기본 출력은 바뀌지 않는다.
- **출력 범위 기준(「생성기가 낼 수 있는 비밀의 집합」): 옵트인 때 +2로 넓어진다.** 이슈 #4461은 판단 기준을 「시크릿 출력 범위」로 적었으므로 이 기준이 적용된다 → **Proposed, owner 결정 필요.**
- **[권장]은 승인이다.** 이유: ① 보유자 행렬 불변·`railway.json` 서비스·변수 무변경 ② compose 경로에서는 생성기가 두 값을 이미 만든다(A3, Q3) ③ 기본 출력 불변·옵트인 ④ 운영자 기계 밖의 새 위치 0 ⑤ 값이 stderr에 나가지 않음을 생성 분기에서 시험이 증명한다(수용 기준 3) ⑥ 새 프로젝트에만 쓴다(G9). **남는 한계**: 설치 에이전트가 stdout을 리다이렉트하지 않으면 값이 기록에 남는다 — 기본 경로의 17개 비밀과 같은 위험이고 코드 가드는 기각했다(기각 대안 F·K). [추정] 수동 경로에서도 설치 에이전트가 `openssl rand`를 돌리면 값이 기록에 남을 수 있어 증가분은 이 문장이 쓰는 것보다 작다.

**owner 결정 필요 — 질문 하나.** Railway 생성기가 옵트인 플래그(`--platform railway --with-agents`)로 `HERMES_API_KEY`·`HERMES_LOGIN_RELAY_KEY` 두 비밀을 stdout에 더해도 되는가?
- (a) **승인 — G1~G9대로 [권장].** 이득: 공유 변수 손 단계 2 → 0. 대가: 릴레이 키가 항상 나오므로 hermes에 base64 둘(`HERMES_LOGIN_RELAY_B64`·`HERMES_LOGIN_PROBE_B64`)이 필수이고 없으면 hermes가 기동하지 않는다(사실 13, fail-closed). 사이드카를 켜는 선택이다(Q3).
- (b) 승인하되 릴레이 키는 뺀다(`HERMES_API_KEY` 하나만). 릴레이는 지금처럼 운영자가 손으로 켠다(사이드카 기본 꺼짐, base64 둘 불필요). 로그인 결합 권한을 가진 키가 캡처 파일에 있는 것을 피하는 쪽이다. (b)면 이 증보를 개정해 다시 검토한다 — G2·G3·G4·G5(49→48)·G6 표·G7·G8(드리프트 가드의 집합)·G9(손 단계 계수·base64 문장)·수용 기준 2~6·8·사실 13·남는 위험이 함께 바뀐다.
- (c) 거절 — 지금처럼 운영자가 두 개를 `openssl rand`로 만든다. 이 증보는 Rejected로 닫고 코드는 바뀌지 않는다.
- 부가(선택, 기본 아니오): 플래그 경로에서만 stdout이 정규 파일이 아니면 거절할까요? [권장] 아니오 — 같은 위험이 기본 경로의 47줄에도 있어 T2 전체의 별도 결정이 맞다(기각 대안 K, 후속 후보 새 이슈 4).

owner의 답이 오면 Status 줄만 `Accepted (날짜, owner 결정 인용)`로 바꾼다.

### G7. 기본 경로는 바이트 단위로 같고, 시험이 그것을 증명한다 [권장]

- 플래그가 없으면 stdout·stderr·종료 코드가 변경 전과 같다. 환경에 `HERMES_*`가 있어도 같다(사실 15). 증명은 저장소 시험 다섯 겹과 PR 증거 하나다: (a) 키 집합 == 정본 + 도장(기존 diff) (b) 줄 수 47 (c) `HERMES_` 이름 0건 (d) 기본 stdout·stderr의 **고정** — **허용목록 환경**(`env -i`로 `HOME`·`PATH`·`RAILWAY_PUBLIC_DOMAIN`·`DATABASE_URL`·`MOMO_RUST_IMAGE`만 둔다)에서 fake openssl 아래 결정적이므로(사실 14) password·claim 두 변형의 sha256을 시험에 상수로 두거나 골든 파일을 `cmp`한다(골든 파일은 `KEY=aaaa…` 줄이 많아 gitleaks 비밀 검사 — `add_secrets_commands`, `add_static_commands` 안(`local_gate.sh:630-634`) — 에 걸릴 수 있으니 먼저 확인하고, 걸리면 sha256 상수를 쓴다). 주변 환경을 비우지 않으면 올바른 구현도 개발자 셸에 따라 빨개진다(사실 14). 정본 키나 문구가 바뀌면 이 값도 의도적으로 고쳐야 하므로 「T2 stdout 불변」이 기계로 지켜진다 (e) 환경 세 구성(더하지 않음·표식 둘·자리 표시자와 공백 값)은 그 허용목록 환경에 `HERMES_*`만 더해 만들고 결과가 같다. PR 증거: 변경 전 커밋의 생성기와 변경 후 생성기의 기본 출력(stdout·stderr)을 같은 허용목록 환경에서 `cmp`한 원문과 고정값 계산 원문(수용 기준 1·10).
- 기존 시험이 바뀌는 곳은 하나다: `--platform railway --with-agents`가 실패해야 한다는 단정(`test_self_host_env_modes.sh:2106-2111`)이 「성공하고 정확히 두 줄이 더해진다」로 바뀐다. T2 조합 거절 목록(`:1561-1582`)은 그대로 모두 실패한다.

### G8. 카탈로그·검증기·doctor의 규칙은 바뀌지 않는다 [권장]

- `railway.json`의 서비스·변수·시작 명령은 바뀌지 않는다(`notes`의 문장 — `platformStamp`의 낡은 수치와 `hermes`(`:25`)의 「운영자가 손으로 만든다·생성기가 내지 않는다」 — 만 고친다). 서비스별 보유 행렬은 검증기가 이미 고정한다: agent-worker가 릴레이 키를 가지면 RED(`worker-relay-key`), 릴레이 키가 채팅 키 참조면 RED(`api-relay-key-chat-key`·`hermes-relay-key-chat-key`), hermes가 oort 비밀을 가지면 RED(`hermes-oort-secret`), hermes의 키 집합 허용목록(`hermes-extra-key`) — 이름은 사실 12의 기준선 실행 출력이다.
- `OPERATOR_SHARED`(`check_railway_catalog.py:95`)는 **유지한다**. 「`${{shared.X}}`가 정본 출력에 없어도 유효하다」는 예외는 기본 경로(플래그 없음)의 사실이다. 바뀌는 것은 검증기의 주석(`:92-93`)과 README `:156`·`:159`·`:195-198`의 「생성기가 내지 않는다/손으로 만든다」가 「기본 경로는 내지 않고 `--with-agents`(T2)가 낸다」로 고쳐지는 것뿐이다(검증기의 규칙·mutation은 불변).
- **드리프트 가드**(수용 기준 8): 입력은 `--claim` 변형(카탈로그가 claim 모양이다)의 기본 출력 키·플래그 출력 키·카탈로그 **서비스 `variables`**의 `${{shared.X}}` 참조 집합(`notes.variables` 같은 설명 문자열까지 잡는 파일 전체 grep은 40개가 되어 거짓 RED)이고, `OPERATOR_SHARED`는 `python3`로 검증기 모듈을 경로로 import해 읽는다(검증기 파일을 고치지 않는다). 세 집합의 차이 — 플래그 출력 − 기본 출력 == 카탈로그 참조 − 기본 출력 == `OPERATOR_SHARED` — 가 어긋나면 RED다. 비밀번호 변형은 카탈로그가 참조하는 `MOMO_BOOTSTRAP_CLAIM`이 더해져 같지 않으므로 입력으로 쓰지 않는다(이 세션이 두 변형을 비교해 확인).
- doctor는 영향이 없다(사실 10).

### G9. 문서와 사용 범위 — 새 프로젝트용이다 [권장]

- 고칠 곳(구현이 `grep -rnE '\b(43|44|45)\b'`로 목록을 다시 만든다, 아래는 알려진 곳): `infra/railway/README.md`의 Hermes 절(`:195-198`)·릴레이 키 행(`:159`)·공유 변수 행(`:156`)·낡은 수치(`:85`·`:102`)·재렌더 경고(`:583-588`, 「Hermes 두 값은 export해도 새로 만들어진다」 한 문장), `infra/railway/railway.json`의 `notes`(사실 3·G8), `docs/SELF_HOST_AGENT.md` §3.4 2단계 스니펫(`:2261`)·§3.4.1 「Zero-base shortcut」의 Railway 줄(`:2364-2366`)과 한국어판(`:1895`·`:1985`), `docs/SELF_HOST.md`의 Hermes 절(`:436-471`, 플래그의 T2 의미 한 줄)·Railway 스니펫(`:1078`)·T2 재렌더 절차(`:1158-1181`, 같은 문장; `:1167`의 `> railway.env`는 `umask 077`·`~/.momo-secrets/` 형태로 통일)와 한국어판(`:399`·`:940`), 생성기 사용법(`:536-542`·`:552-570`)과 낡은 주석(사실 1). `SELF_HOST_AGENT(.ko).md`·`SELF_HOST(.ko).md`는 명령 블록을 영문과 같게 둔다.
- 문서가 보이는 명령은 모두 리다이렉트 형태다:
  ```sh
  umask 077; scripts/self_host_env.sh --platform railway --claim --with-agents > ~/.momo-secrets/railway-oort.env
  ```
  지금 `SELF_HOST_AGENT.md:2261`의 스니펫은 리다이렉트가 없다(사실 8). 이 증보가 만든 위험은 아니지만 stdout에 두 줄이 더 얹히므로 구현 PR이 함께 고치고 기계로 지킨다(수용 기준 9).
- **릴레이 키를 붙였다면 hermes에 base64 둘도 넣는다**는 문장을 README Hermes 절에 둔다(사실 13). 이 문장이 없으면 플래그 사용자가 「붙여넣고 서비스를 만들었는데 hermes가 안 뜬다」를 만난다.
- **사용 범위**: README `:583-588`의 「생성기는 새 프로젝트용」이 그대로 적용된다. 이미 도는 프로젝트에 Hermes를 더하려면 지금처럼 두 공유 변수를 손으로 만든다 — 재렌더한 전체를 다시 붙이면 export하지 않은 비밀이 전부 회전한다(사실 7). **이 플래그는 재렌더 절차(`SELF_HOST.md:1158-1181`)에 붙이지 않는다: Hermes 두 값은 export해도 보존되지 않고 새로 만들어지므로(G4-4) 그 절차의 「export하면 값이 유지된다」는 정본 키에만 해당한다.** 이 플래그는 그 길을 열지 않는다(기각 대안 G).
- **손 단계 계수**(리서치 R2-11 수용 기준 ③): 릴레이를 쓰는 최대 구성은 공유 변수(손) 2 → 0, base64(손) 4 → 4다. 릴레이를 안 쓰던 최소 구성(공유 변수 1 + base64 2)은 합 3 → 4로 는다 — 플래그가 릴레이 키를 항상 내서 릴레이용 base64 둘이 필수가 되기 때문이다(사실 13). README 갱신과 구현 PR 본문에 이 숫자를 기록한다.

### 기각한 대안

표의 알파벳은 이 절 안에서만 쓴다(10-25 증보의 기각 대안 A~P와 별개이고, 본문의 「기각 대안 X」는 이 절의 표를 가리킨다).

| 대안 | 기각 이유 |
|---|---|
| A. 새 플래그(예: `--hermes-vars`) | 뜻이 정확하다는 장점이 있으나 같은 개념에 플래그가 둘이 되고 문서의 compose 줄과 Railway 줄이 다른 문장이 된다. G1의 완화(사용법·stderr)로 충분하다고 본다. |
| B. 정본 키 집합에 넣는다(기본 stdout에 Hermes 두 줄) | Hermes 없는 배포도 비밀 둘을 받는다. #2066·#3947은 기본 스택이 그 키를 쓰므로 기본 경로에 들어갔지만 Hermes는 선택 기능이다. A4의 「T2 stdout 불변」을 깬다. |
| C. `HERMES_*_B64` 네 개도 출력한다 | 붙여넣을 대상이 둘이 되고, 공유 변수로 올리려면 카탈로그 배선과 해시 고정 검증기 계약이 바뀐다(#4461 범위 밖). 후속 이슈 2. |
| D. 배선 리터럴과 `OORT_COHOSTED_AGENT_TOOLS_LOCKED`도 출력한다 | 서비스별 리터럴을 공유 변수로 내보내면 참조하는 쪽이 없고, attest의 기록 주체가 카탈로그와 생성기 둘이 된다(A3). |
| E. 생성기가 `${{secret(length, alphabet)}}`를 출력해 Railway가 값을 만든다 | 비밀이 운영자 기계를 지나지 않아 가장 안전하다. 그러나 프로젝트 공유 변수(Raw Editor)에서 이 함수가 풀리는지 확인하지 못했다 [확인 필요 — 리서치는 템플릿 기능으로만 적는다]. 풀리지 않으면 리터럴 문자열이 키로 남는다. 릴레이 키는 서버·사이드카의 형식 검사가 거절하지만(사실 6, `config.rs:1812`가 같은 실패 모드를 적는다) **API 키는 길이(>32)만 보는 잠금 게이트를 통과한다** — 알려진 상수가 비밀이 되는 fail-open이다. 실측이 되면 별도 증보(후속 이슈 3). |
| F. stdout이 TTY면 비밀 출력을 거절한다 | 설치 에이전트의 도구는 stdout을 TTY가 아닌 **파이프**로 받아 에이전트 기록을 막지 못한다. 모든 키의 기본 경로 동작도 바꾼다. |
| G. Hermes 두 줄만 내는 모드(`--hermes-only`) | 이미 도는 프로젝트에 더하는 길을 연다. README는 그 경우를 손으로 하라고 적는다(사실 7). 필요가 생기면 별도 결정. |
| H. 값을 0600 파일로 쓴다 | T2는 파일을 쓰지 않는 계약이다(`:272`). |
| I. stderr에 값의 지문(해시 앞 몇 자)을 보여 줘 붙여넣은 값과 대조하게 한다 | 지문도 값에서 나온 정보이고 이슈가 「로그에 남기지 않는다」고 했다. 수용 기준 3은 값 전체와 값에서 나온 11자 이상의 연속을 막는다 — 그보다 짧은 접두·지문은 단정하지 않는다(한계). 붙여넣은 값의 확인은 Railway 화면에서 한다. |
| J. 릴레이 키를 하위 플래그로 따로 켠다 | Q3(「설치 스크립트로 켠다」)와 반대이고 플래그가 늘어난다. 끄는 길은 G2에 있고, owner 질문의 (b)가 같은 효과를 낸다. |
| K. 옵트인 경로에서만 stdout이 정규 파일이 아니면 거절한다 | 에이전트 기록을 코드로 막는 유일한 길이고 옵트인 경로는 새 경로라 깨질 흐름이 없다. 그러나 (1) 같은 위험이 기본 경로의 47줄에도 있어 「Hermes를 켜야 더 안전해지는」 비대칭이 생긴다 (2) 플랫폼 CLI로 stdout을 넘기는 흐름을 막는다(`SELF_HOST_AGENT.md` §3.4 2단계가 stdout을 공유 변수로 적용하라고 한다) (3) 이슈 범위 밖이다. T2 전체에 적용할지는 별도 결정(후속 후보 새 이슈 4). |
| L. 환경 값을 재사용한다(`platform_secret` 의미, 검증·동치 거절·출처 표시 포함) | 새 프로젝트용(G9)에는 지킬 값이 없고, 이 레포의 다른 도구가 같은 이름을 쓰므로(사실 15) 재사용은 다른 곳의 값이 새 프로젝트의 비밀로 들어오는 길만 연다. 검증은 값이 이 인스턴스의 것인지 알지 못한다. 재사용을 빼면 검증·동치 거절·출처 표시가 함께 사라져 결정과 시험이 줄어든다. 재렌더로 값을 지키려는 운영자는 기존 정본 키의 export 규칙(`README.md:583-588`)이 있고, 그것은 이 두 값의 몫이 아니다. |

### 구현 슬라이스 (Accepted 후, 별도 이슈)

- **새 이슈 1 — [engine][selfhost] R2-11 구현: Railway 생성기 `--with-agents`(T2)가 Hermes 공유 변수 두 줄을 더한다.** **Accepted 뒤에 발행한다**(ADR-0100). 범위: G1~G9, 수용 기준 1~10(11은 `runtime-unverified` 기록), 문서(G9)와 낡은 수치 정정(사실 1). 함께 바꿀 것: `scripts/self_host_env.sh`(T2 갈래 `:277-278`·`emit_managed_platform_env`·사용법·주석), `scripts/tests/test_self_host_env_modes.sh`(`:2106-2111` 뒤집기·신규 단정), `scripts/tests/test_railway_template.sh`(드리프트 가드·실제 openssl 시험·문서 명령 모양), `scripts/tests/check_railway_catalog.py` 주석, `infra/railway/railway.json`의 `notes` 문장(서비스·변수는 그대로), 문서(G9). 구현 뒤 ADR-0184 D3에 한 줄 역참조를 더한다. 검증: `scripts/local_gate.sh --profile docs`(+`--auto`가 고르는 staging-smoke), 사보타주 원문, 기본 출력 `cmp`·해시 원문. 규모 S~M. 트랙 engine.
- **새 이슈 2 (후속, 선택) — [docs][engine] 「base64 4종·hermes 서비스 변수」일괄 붙여넣기**: 카탈로그가 `${{shared.…_B64}}`를 참조하도록 바꾸는 배선 변경과 해시 고정 검증기 계약 변경이라 별도 증보가 먼저다(기각 대안 C).
- **새 이슈 3 (후속, 선택) — [engine][spike] Railway `${{secret(…)}}`가 Raw Editor·CLI의 프로젝트 변수에서 풀리는지 실측**(임시 환경, owner 승인 필요): 풀리면 비밀이 운영자 기계를 지나지 않는 길을 별도 증보로 연다(기각 대안 E).
- **새 이슈 4 (후속, 선택) — [engine][docs] T2 stdout이 정규 파일이 아닐 때의 처리**: 기본 경로의 동작 변경이라 별도 결정이다(기각 대안 F·K).
- 기존 이슈: 로드맵 #4349의 `## 항목`에 R2-11 줄을 올린다(그 본문의 목록은 지금 비어 있다. planner). #4460(R2-10 제안 카드)은 이 증보와 독립이고, 카드의 Railway 계획 문구는 이 증보가 구현되기 전에는 `--with-agents`를 말하지 않는다(10-25 증보 F6 그대로). 구현 뒤 그 문구를 고치는 것은 카드 쪽 이슈의 몫이다. owner 결정 대기는 `scripts/planning_context.sh`가 줄 맨 앞의 `Status: Proposed`만 읽어(`:136-139`) 이 증보처럼 불릿 안의 Proposed를 드러내지 못하므로, 로드맵 #4349에 「owner 결정 대기: ADR-0203 증보 A4′」 줄을 올린다(planner).

### 수용 기준 (red proof — 해당 분기를 지우면 실패해야 한다)

레인: **[local gate]** `scripts/tests/test_self_host_env_modes.sh`(`add_static_commands`) · **[docs gate]** `scripts/tests/test_railway_template.sh`(docs 프로파일, 실제 openssl) — **PR CI는 둘 다 돌리지 않는다**(사실 9). 새 시험은 모두 **허용목록 환경**(`env -i HOME=… PATH=… RAILWAY_PUBLIC_DOMAIN=… DATABASE_URL=… MOMO_RUST_IMAGE=…`, 필요한 시험만 `HERMES_*`를 더한다)으로 돌린다 — 생성기는 주변 env의 `COMPOSE_PROJECT_NAME`·`MOMO_INITIAL_OWNER_*`·`JWT_HMAC` 등을 읽어 출력이 달라지고(사실 14) `run_platform_stdout`은 환경을 비우지 않는다(사실 15). 번호 1~10이 시험·증거이고 11은 `runtime-unverified` 기록이다.

1. **[local gate]** (기본 경로 불변) 플래그 없는 `--platform railway`·`--platform railway --claim`을 허용목록 환경에 `HERMES_*`만 달리 더한 세 구성에서 돌린다: ⓐ 더하지 않음 ⓑ 40자 이상의 `[A-Za-z0-9]` 표식 값 둘 ⓒ 자리 표시자(`change-me-hermes-bearer`)와 공백이 든 값. 세 구성 모두 종료 코드 0, stdout·stderr가 서로 같고 고정값(sha256 또는 골든, G7)과 같으며, 키 집합 == 정본 + 도장, 줄 수 47, stderr에 「키 47개를 stdout에 썼다」, stdout·stderr에 `HERMES_` 이름과 표식 0건. 사보타주: Hermes 줄을 플래그와 무관하게 내면 고정값·집합·47이, 환경 값을 플래그 밖에서 읽으면 ⓑ가, 플래그 밖에서 `HERMES_*` 환경을 검증해 실패시키면 ⓒ가 빨개진다. Hermes 키를 heredoc에 넣으면 정본 46 단정(`test_self_host_env_modes.sh:1098`·`test_railway_template.sh:204-205`)이 빨개진다.
2. **[local gate]** (플래그 = 기본 + 두 줄) `--platform railway --with-agents [--claim]`: 키 집합 == 기본 ∪ {두 키}, **줄 수 49**(중복 줄 방지), `head -n 47`이 플래그 없는 출력과 바이트 동일, `tail -n 2`가 정확히 `HERMES_API_KEY`·`HERMES_LOGIN_RELAY_KEY` 줄 순서, 모든 줄이 `KEY=value`(주석·빈 줄 0), 정본 키 중 `HERMES_`로 시작하는 것 0, 실행 뒤 fixture에 새 파일이 없다(픽스처 디렉터리 밖에 쓰는 변형은 못 잡는다 — 한계). stderr: 첫 줄 「키 49개를 stdout에 썼다」, G5의 ①·③ 고정 문구(① 「새로 만들어 stdout 끝에 더했다」·「값은 쓰지 않는다」·「서비스는 카탈로그가 만든다」, ③ `HERMES_LOGIN_RELAY_B64`·`HERMES_LOGIN_PROBE_B64`). 사보타주: 키 하나를 빼면 집합·줄 수가, Hermes 줄을 도장 앞이나 정본 사이로 옮기면 `head -n 47` 비교가, 순서를 바꾸면 `tail -n 2`가, 주석 줄을 더하면 모양 단정이, 값을 파일로 쓰면 새 파일 단정이, 개수를 47로 두거나 ①·③을 지우면 stderr 단정이 빨개진다.
3. **[local gate]+[docs gate]** (값 비노출, 생성 분기) 환경에 `HERMES_*`를 두지 않고 플래그를 켠 실행: stdout에서 뽑은 두 값이 stderr에 0건이고 stderr에 길이 **11 이상**의 `[A-Za-z0-9]` 연속이 0건이다(기본 stderr의 최장 연속은 10자 `CENTRIFUGO`, 사실 14; fake lane의 모든 비밀이 `a` 연속이라 어떤 비밀이 새도 걸린다). docs gate는 실제 openssl로 같은 단정을 한 번 더 한다(값이 무작위라 우연 일치가 불가능하다). 사보타주: 생성 분기에서만 stderr 요약에 값을 찍거나(예: 「새로 만들었다: <값>」) 값 앞 12자를 찍으면 빨개진다. 11자 미만의 접두는 단정하지 않는다(한계).
4. **[local gate]+[docs gate]** (환경 무시) 환경에 표식 `HERMES_API_KEY`·`HERMES_LOGIN_RELAY_KEY`를 두고 플래그를 켠 실행(둘 다·API만·릴레이만·빈 값 네 구성): stdout의 두 값은 표식과 다르고 표식은 stdout·stderr에 0건이며, stderr의 「읽지 않았다」 줄은 비어 있지 않은 이름마다 정확히 하나다(빈 값·없는 이름은 0). 사보타주: 두 값을 `platform_secret`로 만들면 표식이 stdout에 나와 빨개진다. 「읽지 않았다」 줄을 지우거나 빈 값에도 내면 빨개진다.
5. **[local gate]+[docs gate]** (독립·형식) 정적: 두 값이 서로 다른 변수·서로 다른 `openssl rand -hex 32` 호출에서 나온다 — 웹훅 두 키와 같은 방식이다(`test_self_host_env_modes.sh:1188-1203`, fake openssl가 모든 호출에 같은 문자열을 돌려줘 동적으로는 못 잰다). 동적(docs gate, 실제 openssl, `JWT_HMAC`을 환경에 둔 실행 포함): 두 값이 서로 다르고 `JWT_HMAC`·다른 생성값과도 다르며 각각 64자 hex(= `^[A-Za-z0-9._~+/=-]{32,256}$`와 일치, 32자 이상). 사보타주: 릴레이 키를 API 키 변수나 `JWT_HMAC`에서 복사하면 둘 다 빨개진다. 구현 주의(G4-6): 한 줄에 릴레이 이름 뒤 API 이름을 쓰지 않는다.
6. **[local gate]** (부분 출력 방지) `rand -hex 32`만 실패하는 fake openssl(`-hex 12`·`-hex 24`는 정상 — 비밀번호 변형이 `-hex 12`를 쓴다, `:1712`)로 password·claim 두 변형에서 플래그를 켠 실행: 종료 코드가 0이 아니고 **stdout이 0바이트**다. 사보타주: Hermes 값을 출력 루프 뒤에 만들면 정본 47줄이 남아 빨개진다.
7. **[local gate]** (거절 목록) `--platform railway --with-agents`와 별칭 `--railway --with-agents`가 성공하고 정확히 두 줄이 더해진다. 기존 `:2106-2111`은 `run_generator`(stdout·stderr를 한 파일로 합치고 `RAILWAY_*`를 주지 않는다, `:154-165`)를 쓰므로 뒤집을 때 `run_platform_stdout` 계열로 바꾼다 — 바꾸지 않으면 `RAILWAY_PUBLIC_DOMAIN` 부재로 계속 실패해 옛 「실패해야 한다」 단정이 엉뚱한 이유로 통과한다. 같은 플래그에 이미지 모드·`--public-origin`·`--allow-local-provider`·`--compose` 중 하나를 더한 조합은 모두 실패하고 stdout이 0바이트다(`:1561-1582` 루프가 거절별로 이미 덮으므로 거기에 `--with-agents`를 더한 줄을 넣는다). 사보타주: T2 갈래의 다른 거절 하나를 지우면 그 조합이 빨개진다.
8. **[docs gate]** (카탈로그 일치·드리프트 가드) `--claim` 변형에서 `OPERATOR_SHARED`(검증기 모듈을 경로로 import) == 플래그 출력 키 − 기본 출력 키 == 카탈로그 서비스 `variables`의 `${{shared.X}}` 참조 − 기본 출력 키. `check_railway_catalog.py … --prove-mutations`와 그 mutation 이름 루프(`test_railway_template.sh:249-278`)는 그대로 통과한다. 사보타주: 플래그 아래에서만 세 번째 `HERMES_*` 키를 내면, 또는 `OPERATOR_SHARED`에서 한 이름을 지우면, 또는 카탈로그에 공유 Hermes 참조를 하나 더하면 이 대조가 빨개진다.
9. **[docs gate]** (문서 명령 모양) README·`SELF_HOST_AGENT(.ko).md`·`SELF_HOST(.ko).md`의 sh·bash 블록에서 `self_host_env.sh`와 `--platform railway`(또는 `--railway`)가 든 줄은 모두 `umask 077;`과 `> ~/.momo-secrets/…` 리다이렉트를 포함하고, 문서마다 맞는 줄이 1개 이상 있어야 통과한다(없으면 공허). 사보타주: 한 줄에서 `>`나 `umask 077`을 지우면 빨개진다. (`scripts/check_docs_commands.py`는 명령이 트리에서 풀리는지만 보고 리다이렉트도 영문·한국어 동일성도 보지 않는다 — `GATED_DOCS`의 「명령 블록은 …와 같다」는 사유 문자열이다. 두 언어판의 일치는 수동 대조다.)
10. **[PR 증거]** 변경 전 커밋의 생성기와 변경 후 생성기의 기본 출력(stdout·stderr)을 같은 fake openssl 환경에서 `cmp`한 원문과 sha256 계산 원문(저장소 시험이 아니라 일회 증거). 손 단계 계수(G9) 기록.
11. **[runtime-unverified]** 플래그 출력으로 만든 공유 변수로 실제 Railway에서 hermes가 `LOCKGATE ok`까지 가고 api가 `409 login_relay_off`를 내지 않는 것. 수동 경로의 같은 모양은 `hermes-kwak`(#3952)가 실측했고(A5), 이 템플릿의 `hermes` 새 배포는 A5가 이미 미실측으로 남겼다. 구현 PR은 못 하면 `runtime-unverified`로 적고, 하게 되면 owner 승인 뒤 임시 환경에서 한다.

### 남는 위험

- 이미 도는 프로젝트 위에서 이 플래그로 전체를 다시 붙이면 비밀이 회전한다(사실 7). 문서가 「새 프로젝트용」이라고 쓰는 것으로만 막는다.
- 설치 에이전트가 stdout을 리다이렉트하지 않으면 49개 줄(그중 이름으로 센 비밀 19개)이 에이전트 기록에 남는다. 이 증보 이전부터 있던 위험(47개)이고, 문서를 고치고(G9, 수용 기준 9) 코드 가드는 후속 결정으로 둔다(기각 대안 F·K).
- 재렌더 문서(`SELF_HOST.md:1158-1181`·README `:583-588`)가 「export하면 값이 유지된다」고 쓴다. Hermes 두 값은 예외라는 문장을 G9가 더하지만, 그 문장을 읽지 않고 재렌더한 출력을 붙이면 두 값이 회전한다(세 서비스가 같은 공유 변수를 참조하므로 재배포 뒤 일관은 유지된다).
- 붙여넣는 목록에 oort 비밀과 Hermes 비밀이 섞여 있어서, 운영자가 서비스에 「공유 변수 전부」를 참조시키는 UI 실수를 할 수 있다(D6-2 위반). 카탈로그는 검증기가 지키지만 Railway 화면의 실수는 막지 못한다. 문서 문구(`SELF_HOST_AGENT.md` §3.4.1 3단계의 「oort 서비스의 어떤 공유 변수도 참조하지 않는다」)로 낮춘다. 이 위험은 지금의 47줄에도 있다(사실 2).
- 릴레이 키를 붙이고 base64 둘을 빠뜨리면 hermes가 기동하지 않는다(사실 13). fail-closed이고 문서 문장(G9)으로 낮춘다.
- 두 값은 실행마다 달라진다(G4-4, 재현되지 않는다): 붙이기 전에 출력을 잃으면 새 프로젝트 전제에서 다시 실행하면 되고(그 시점에 어디에도 쓰이지 않았다), 붙인 뒤에는 Railway 공유 변수가 값을 가진다.
- `runtime-unverified`: 수용 기준 11, 그리고 Raw Editor가 두 줄을 공유 변수로 만드는 것은 기존 47줄과 같은 동작이라 새 가정은 없다 [추정].

### 바뀌지 않는 것

D1~D9·K1~K7·A1·A2·A5·L0~L6(Q1~Q3 포함)·M1~M5·F1~F9(F3 마지막 항·F6 railway 계획 문구 제외), 기본(플래그 없음) T2 stdout·stderr·종료 코드와 정본 키 집합 46, compose의 `--with-agents` 동작, `infra/railway/railway.json`의 서비스·변수·시작 명령과 `check_railway_catalog.py`의 규칙·mutation, `infra/hermes/`의 게이트·사이드카, `--claim`, T2의 다른 거절들, `OORT_COHOSTED_AGENT_TOOLS_LOCKED`가 api 전용 리터럴이라는 것, 서버 코드, oort가 구독 OAuth 토큰·원본 provider 키를 받지도 저장하지도 않는다는 불변식.

## 증보 2026-10-30 — Codex 구독 웹 검색만 허용 (#4794)

- Status: **Accepted (2026-10-30, owner 결정)**. 근거: [#4794의 10-30 결정 댓글](https://github.com/yeomyeonggeori/oort/issues/4794#issuecomment-6510851984). Codex 구독 검색만 켜고 `web_extract`는 계속 막으며, 커넥터를 켠 동안은 `web` 전부 끈다.
- 범위: 공동 호스팅 Hermes의 저장소 기본 설정·잠금 게이트·시험·공개 보안 설명. 서비스 배포·환경변수·로그인·개인 Hermes 인스턴스 변경은 별도 미션이다.

### W1. 먼저 확인한 잠긴 버전의 능력 [소스]

고정 이미지는 `infra/rust/docker-compose.rust.yml`과 `infra/railway/railway.json`의 공식 v0.22.2 index digest `sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919`다. 아래는 최신 main이 아니라 [v0.22.2 태그](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.2)의 commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`에서 확인했다.

1. **검색만 선택할 수 있다.** [`toolsets.py:76–77`](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/toolsets.py#L76-L77)의 `web`은 `web_search`·`web_extract`, `search`는 `web_search` 하나다. [`hermes_cli/tools_config.py:561–637`](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/hermes_cli/tools_config.py#L561-L637)는 `platform_toolsets.api_server`의 명시 목록과 `search` 같은 사용자 선택을 해석한다. `agent.disabled_toolsets`는 마지막에 도구 단위로 빼므로([`model_tools.py:316–338`](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/model_tools.py#L316-L338)), 기본 설정에서는 `web` 금지를 빼고 API 목록을 `memory`·`todo`·`session_search`·`search`로 좁힌다. `web`을 금지한 채 `search`만 더하면 검색도 사라진다.
2. **Codex 구독 검색에 별도 공급자 키는 필요 없다.** [`plugins/web/openai_native/provider.py:1–14`](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/web/openai_native/provider.py#L1-L14)와 [같은 버전 문서:383–399](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/user-guide/features/web-search.md#L383-L399)는 `web.search_backend: openai-native`와 기존 `openai-codex` OAuth를 사용한다. [`agent/transports/codex.py:238–244`](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/agent/transports/codex.py#L238-L244)는 이미 허용된 클라이언트 `web_search`를 Codex Responses의 서버 측 검색 도구로 1:1 교체한다. 검색이 원래 없는 세션에는 추가하지 않는다. Hermes가 Firecrawl 등으로 직접 검색하는 방식과 다르다.
3. **다른 모델 경로로 검색 권한을 넓히지 않는다.** 네이티브 검색은 Codex Responses 전용이다. OAuth가 없거나 다른 모델·호환 엔드포인트를 쓰면 지원하지 않는 검색으로 실패한다([`provider.py:72–79`](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/web/openai_native/provider.py#L72-L79)). 기존 모델 선택·fallback은 유지한다. Claude/API 키 모델로 대화가 전환되어도 별도 검색 공급자를 자동으로 골라 성공시키지 않는다.

### W2. 허용 표면과 검색어 유출 위협

- `lockgate.ALLOWED_TOOLS`는 `memory`·`todo_list`·`session_search`·`web_search`다. `web_extract`·터미널·파일·브라우저 등 나머지는 계속 거절한다. `web` 전체를 켜서 추출 도구가 선택되면 자격증명 유무와 무관하게 기동 전 검사에서 실패한다.
- 검색이 선택되면 게이트는 `web.search_backend`가 정확히 `openai-native`, `web.keyless_fallback`이 명시적인 `false`인지 확인한다. 임의 공급자·자동 선택·익명 검색 fallback은 기본 계약에 없다. 구독 토큰은 기존 Hermes 볼륨 경계를 따른다(D7, ADR-0004).
- **검색어는 외부로 나간다.** 모델이 대화의 일부를 검색어에 넣을 수 있고 그 검색어가 OpenAI의 검색 처리에 전달된다. 검색 결과도 신뢰할 수 없는 외부 입력이다. 검색 단독 허용은 데이터 유출·프롬프트 인젝션을 없애는 보장이 아니다. 쿼리 정화·개인정보 차단·공급자 내부 검색/페이지 처리 통제·무보관을 증명하거나 약속하지 않는다. 여기서 페이지 열기 금지는 Hermes의 `web_extract`를 허용하지 않는다는 뜻이다.

### W3. 커넥터와 검색은 배타적이다 — K4-1 유지

`mcp_servers`가 비어 있지 않으면 기존 K4 규칙이 모두 적용되고 `agent.disabled_toolsets`에 `web`이 있어야 한다. 기존 커넥터 참조 설정은 바꾸지 않는다. 이에 더해 `tool_problems`는 **선택된 도구**에 `web_search`나 `web_extract`가 있으면 커넥터 설정을 거절한다. 기동 전에는 가용성 필터 전 목록을 검사한다. 기동 후 1회 보고는 API가 보고한 도구와 그때 읽은 설정에서 재해석한 도구의 합집합에 같은 규칙을 적용한다. 위반은 PID 1 종료를 요청하며 설정을 읽을 수 없으면 검증 성공으로 기록하지 않는다.

이로써 메일·드라이브를 읽는 Hermes에 검색 경로를 함께 더하지 않는다. 서버 측 검색도 기존 `web_search`가 있어야만 주입되는 W1-2의 조건을 따른다. **관측 한계:** [v0.22.2 API 구현:2944–2971](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server.py#L2944-L2971)은 설정 UI의 범주만 열거하므로 `search`를 보여주지 않는다. 보고의 `live_tools`와 `selected_tools`를 구분하고 `unreported_selected_tools`로 이 차이를 드러낸다. 설정 재해석은 프로세스 내부 도구 목록의 관측이 아니다. 이 검사는 운영자 설정·Hermes가 보고하는 표면에 대한 것이며, 벤더 MCP의 자기 보고를 검증하는 보장이나 지속 감시가 아니다(K4의 한계 유지).

### W4. 되돌리기와 검증 경계

- 되돌릴 때 기본 API 목록에서 `search`를 빼고 `agent.disabled_toolsets`에 `web`을 복원하며, 게이트 허용 목록에서 `web_search`를 뺀다. 검색 설정도 제거할 수 있다. `memory`·`todo_list`·`session_search`만 남는 기존 대화 경로가 양쪽 게이트 시험의 양성 대조다. 커넥터를 켤 때는 검색 설정을 재사용하는 대신 기존 K4 설정을 적용한다.
- 오프라인 회귀·음성 대조는 [`test_default_config.py`](../../infra/hermes/test_default_config.py)의 `WebToolPolicy`·`EnforcedWebToolPolicy`, [`test_lockgate_connectors.py`](../../infra/hermes/test_lockgate_connectors.py)의 `test_selected_web_tools_are_refused_even_with_the_connector_deny_list`에 있다. 부트 게이트·실행 후 보고의 실제 진입점을 시험하고 Hermes 모듈·HTTP·PID 1만 모의로 둔다. 실제 OAuth·검색 공급자 호출은 하지 않는다.
- `runtime-unverified`: 고정 Docker 이미지의 실제 기동·`/v1/toolsets`·Codex 구독 검색 성공·커넥터 배타의 컨테이너 검증은 planner의 S3 스택 검증에 남긴다. 저장소 변경이 Railway의 실행 중 설정을 갱신하거나 배포를 승인하지 않는다.
