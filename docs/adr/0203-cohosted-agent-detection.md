# ADR-0203: 같은 프로젝트(동일 호스트) 에이전트 감지 — 운영자가 한 번 클릭으로 Hermes를 연결

- Status: **Accepted** (2026-10-16. 방향 결재 세 건과 질문 1~7 위임 결재는 「owner 결정」에 원문 인용)
- Date: 2026-10-16
- Deciders: 성재
- 기안: Opus 5.5 worker (#3874)
- 관계: ADR-0004(+증보 5: egress 가드 — Hermes provider 경계), ADR-0147(+증보 2026-10-16 「에이전트별 키 고정」 = #3873, **아직 머지 전**), ADR-0101(에이전트 = 1급 멤버), ADR-0162(Agent Port), ADR-0198(구독 정책), ADR-0201(팀 AI 빠른 길), ADR-0100
- 증보: **2026-10-16 1인 워크스페이스의 커넥터 호스트로서의 Hermes** (성재 결재 「각자 + 1인 워크스페이스에서 Hermes 시험 (추천)」) — 파일 끝. D6 도구 잠금 목록을 커넥터 시험에 한해 넓히고, D7 볼륨 목록에 `mcp-tokens/`를 더하고, 「단일 워크스페이스」를 안내에서 서버 강제로 올린다. D1~D5·D8·D9는 바뀌지 않는다. 구현은 본문과 같이 #3873 뒤다(로컬 실측 K-S1a 제외). 같은 날 저녁 결재 「개인 Gmail 외부 앱」은 2026-10-17 결재 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」가 대체했고, K3·K5·K7에 반영했다. Google 시험은 dawn.kim의 Developer Preview 가입·OAuth client 준비(ADR-0113 증보 2 G-S0) 뒤에 시작한다. 2단계(쓰기 중계)는 Proposed다.
- 증보: **2026-10-19 Hermes의 모델 인증에 구독 OAuth 허용**(#4071, owner 결정) — Hermes가 자기 볼륨에 Codex·Claude 구독 OAuth를 보관해 모델 인증에 쓴다. 파일 끝. D1~D9는 바뀌지 않는다.
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

## 증보 2026-10-19 — 같은 프로젝트 Hermes의 모델 인증에 구독 OAuth 허용

- Status: **Accepted** (2026-10-19, owner 결정 인용). 인용(이슈 #4071, 성재 2026-10-19): 「우리 메신저 대신 hermes oauth로 할때 왜 그게 ADR이 금지한 길이야. 이건 업계에서도 허용된 부분인데. 그냥 해당 ADR금지 부분을 제거해. 당장에 필요하다면 codex oauth로 하고, claude oauth까지 처리할거야. 제로 베이스 온보딩 개선 묶음도 진행 ㄱㄱ 하자.」
- 기안: Sonnet 5.5 worker(#4071)

- **허용한다.** 운영자가 호스팅하는 Hermes(셀프호스트·클라우드 포함)가 **자기 볼륨에** 보관하는 Codex(ChatGPT 구독)·Claude(구독) OAuth 토큰으로 모델 인증을 하는 경로. 로그인과 갱신은 Hermes 자체 흐름이 하고, 절차는 #4073(Hermes 모델 인증 온보딩)이 정한다.
- **oort 쪽 경계는 그대로다(ADR-0004).** oort 서버·api·agent-worker·provider_link 금고·DB·로그·감사·매니페스트는 구독 OAuth 토큰(access·refresh·코드)을 받지도, 저장하지도, 중개하지도, 기록하지도 않는다. 금고에 구독 OAuth kind를 더하지 않는다. oort가 Hermes 접속에 쓰는 자격은 불투명 bearer(`HERMES_API_KEY`) 하나뿐이고 모델 인증 자격이 아니다(대화 내용은 Hermes로 가지만 구독 토큰은 oort를 지나가지 않는다).
- **사용량과 약관.** 구독 사용량은 그 Hermes **소유자의 구독**에서 나간다(팀원이 Hermes를 불러도 같다). 벤더 약관의 적합성 판단과 책임은 **운영자 몫**이고, oort는 판단하거나 보증하지 않는다. 이 증보 이전의 약관 판단(제3자가 claude.ai 로그인을 제공하거나 토큰을 수집·저장·중개할 수 없다)은 **oort가 하는 일**에 대한 것으로 그대로 남고, Hermes가 자기 볼륨의 구독으로 인증하는 경로의 적합성은 운영자가 판단한다.
- **적용되지 않는 것(별개 경로).** oort 서버가 구독 CLI를 대신 구동하는 경로를 막는 ADR-0193 D6·D17·D18과 공용(워크스페이스·클라우드) work host 차단(`MOMO_SUBSCRIPTION_AGENTS_ENABLED`, `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`, `claude_subscription_agent_paused`)은 **Hermes 경로에는 적용되지 않는다.** 이 증보는 그 코드 동작을 바꾸지 않는다. 서버 내장 구독 에이전트 차단을 풀지는 별도 확인이 필요하다(owner 미결정).
- **볼륨 목록.** D7 볼륨 목록에 **구독 OAuth 토큰(Codex·Claude, 고가치)** 을 더한다. 대화 기록·`mcp-tokens/`와 같은 볼륨이며 oort DB의 RLS·백업 밖이다. 개인정보 안내문에 「Hermes 볼륨에 AI 구독 로그인 토큰이 남아요」를 더한다. 회수는 벤더 쪽 로그아웃·연결 해제와 Hermes 볼륨의 해당 파일 삭제다(oort에는 지울 사본이 없다).
- **공동 호스팅 판정은 그대로다.** 이 증보는 감지·연결(D1~D5)·도구 잠금(D6)을 바꾸지 않는다. oort는 Hermes가 어떤 방식으로 모델 인증을 하는지 알 수 없고 알 필요도 없다.
