# ADR-0147: 채팅 에이전트 provider에 구독 OAuth 수용 — GPT OAuth 우선

- Status: **Accepted** (2026-08-02 성재 — "앤트로픽 키 안 쓰고 gpt oauth 사용" 지시 + 제안 승인 "ㄱㄱ". 기안 Fable)
- 관련: ADR-0004(+증보 1 — provider_link 봉인 계약이 이 결정의 그릇), ADR-0144(코딩 에이전트=sandbox-internal login — **무변경 유지**), ADR-0113(커넥터 경계 — 참조), ADR-0146(provenance), B5.1(agent-worker)·B4.2(provider link REST)
- 증보: 2026-09-26 온보딩 2.0(ADR-0193 Q2) — 구독 OAuth 서버 금고를 확장하지 않는다. 팀 에이전트는 API 키가 기본이다. 파일 끝 「증보 2026-09-26 — 온보딩 2.0」 절
- 증보: 2026-09-27 Anthropic Messages wire(#2872) — 세 번째 wire와 봉인 박스 `anthropic-key` kind, `format` 필드, 오류의 키 제거 규칙. 파일 끝 「증보 2026-09-27 — Anthropic Messages wire」 절
- 증보: 2026-09-27 AI 계정(#2876) — 설정 화면에서도 `auth.json` 붙여넣기로 새 링크를 만들 수 없다. 「증보 2026-09-26」 절 끝 한 줄
- 증보: 2026-09-27 연결 확인(#2960) — `POST /v1/provider/link/test`가 봉인 크레이트를 거쳐 provider에 읽기 전용 GET 한 번을 보낸다. 결정 4의 「momo-server HTTP 0」을 좁힌다. 파일 끝 「증보 2026-09-27 — 연결 확인」 절
- 증보: 2026-09-28 기본 AI 운영자 행(#3009) — `GET/PUT /v1/provider/default-ai`와 새 테이블 `provider_default_ai`(migration 093), 그리고 연결 확인 응답의 `modelIds`. 연결 확인 증보의 「provider 문자열은 크레이트 밖으로 나가지 않는다」를 모델 id 한 가지만큼 좁힌다. 파일 끝 「증보 2026-09-28 — 기본 AI 운영자 행」 절
- 증보: 2026-09-28 키는 origin에 묶인다(#3040) — `PUT /v1/provider/link/chain`이 키 없이 hop의 origin을 바꾸면 409 `key_required_for_new_origin`. 파일 끝 「증보 2026-09-28 — 체인 키는 origin에 묶인다」 절
- 발단: 티키타카 smoke의 provider 선택에서 성재가 API 키 대신 ChatGPT 구독 OAuth(Codex CLI 방식)를 지정.

## 결정
1. **provider_link 금고가 OAuth 토큰을 수용한다.** 기존 봉인 계약 그대로(`PROVIDER_LINK_MASTER_KEY` 암호화, api는 봉인만·worker가 job 시점 복호화, 평문 로그 0) — 들어가는 내용물이 "API 키"에서 "OAuth refresh token(+메타)"로 확장될 뿐. 신원은 **개인 구독 귀속**임을 링크 메타에 명시(누구의 계정인지).
2. **agent-worker에 OpenAI OAuth provider 구현** — Bearer access token 호출 + 만료 시 refresh 갱신(갱신된 토큰은 금고에 재봉인). 갱신 실패 = run 실패 + 사용자 가시 오류(재로그인 안내).
3. **토큰 획득은 운영자 로컬 OAuth**(Codex CLI `codex login` 산출물을 설정 화면의 provider link 폼으로 등록). oort가 OAuth 브라우저 플로우를 자체 중계하지 않는다(OpenAI가 3자 서버용 client를 제공하지 않음 — 플로우 소유는 사용자 로컬).
4. **경계 유지**: 코딩 에이전트(T3/workd)는 ADR-0144 경로(샌드박스 내 로그인) 불변. momo-server는 여전히 HTTP 0(불변식 #2) — OAuth 호출·갱신은 전부 agent-worker.

## 제약·정직한 한계 (성재 인지)
- **구독 OAuth는 개인 대화형 사용 전제** — 서버측 워크스페이스 봇 구동은 OpenAI 정책과 긴장, rate limit=개인 구독 한도. **내부 도그푸딩 한정 경로**로 명시하고, 제품 기본은 API 키(멀티테넌트·과금 명확). UI/문서에 "개인 계정 귀속·내부용" 라벨.
- 토큰 탈취 면적: 금고 봉인+worker 복호화 시점 최소화+로그 0(기존 계약). refresh token 회전 시 이전 토큰 무효화는 provider 동작을 따름.

## Consequences
- (+) API 크레딧 없이 구독으로 티키타카 도그푸딩 즉시 가능. 봉인 계약 재사용이라 신규 보안 표면 최소.
- (−) 개인 귀속·정책 긴장(내부 한정으로 완화)·refresh 회전 관리 복잡성.

## 이행
- **B5.4 랜딩(PR #948)**: 봉인 envelope(oauth-openai)·refresh→재봉인·mock conformance. **실측 각주: ChatGPT OAuth 토큰은 `/chat/completions`가 아니라 Responses API(`chatgpt.com/backend-api/codex/responses`)를 요구** — 어댑터는 B5.4b로 이행(결정 2의 필수 수단, 별도 방향 변경 아님). Swift AgentWorker는 이 envelope 미인지 — 이행기 혼용 금지.
- B5.4: provider_link kind 확장(oauth-openai)·agent-worker OpenAI provider(+refresh 재봉인)·설정 폼 필드(있는 표면 최소 확장)·conformance(mock OAuth 서버로 만료→갱신→재봉인 red).

---

## 증보 2026-09-26 — 온보딩 2.0: 구독 OAuth 서버 금고를 넓히지 않는다

- Status: **Accepted** (2026-09-26 성재 결재). 온보딩 2.0 제안서 Q2의 권장안이다. 결재 인용과 전체 결정은 ADR-0193에 있다.
- 기안: Opus 5.5 worker(#2805)

- **확장하지 않는다.** provider_link 금고에 구독 OAuth kind를 새로 더하지 않는다. Claude(Pro·Max) 구독 토큰은 어떤 경로로도 금고에 넣지 않는다. Anthropic 법무 문서가 제3자의 claude.ai 자격·세션 토큰 수집·저장·중개를 금지한다(https://code.claude.com/docs/en/legal-and-compliance). ChatGPT 구독도 셀프호스트 서버가 여러 사람 대신 호출하면 OpenAI의 계정 공유 금지와 부딪힌다. ADR-0191 옵션 B 기각과 같은 이유다.
- **기존 `oauth-openai` 경로는 그대로 「내부 도그푸딩 한정」이다.** 라벨을 유지하고, 온보딩 「AI 연결」 화면에 노출하지 않는다. 새 워크스페이스에 권하지 않는다.
- **팀이 함께 부르는 에이전트는 API 키(BYOK)가 기본이다.** 이 ADR 본문의 「제품 기본은 API 키」를 온보딩까지 넓힌다. 온보딩 「AI 연결」 목록의 「API 키로 팀 에이전트」 줄은 설정 › AI 연결 폼(provider_link, API 키 kind)으로 간다.
- **구독은 개인 경로로만 쓴다.** 소유자 한 사람이 자기 맥의 공식 CLI에 로그인하고, 그 에이전트는 소유자만 부른다(ADR-0193 D2·D4). 서버는 구독 토큰을 보지 않는다.
- **(2026-09-27 증보, #2876, 성재 「전부 권장대로」 AI 계정 Q3)** 온보딩뿐 아니라 **설정 › AI 연결에서도 `auth.json` 붙여넣기(`oauth-openai`)로 새 링크를 만들 수 없다.** 기존 링크는 읽기 전용 줄 「내부용 연결 · 새로 만들 수 없음」으로 남고 끊기만 할 수 있다.

---

## 증보 2026-09-27 — Anthropic Messages wire와 `anthropic-key` kind

- Status: **Accepted** — 성재 결재 2026-09-27 「전부 권장대로」(RCA 후속 1·2 진행: Anthropic 키 지원·SSRF 수리 포함, 이슈 #2872·#2852).
- 기안: Opus 5.5 worker(#2895). 구현: PR #2888(#2872). 프리셋 목록과 egress 가드는 ADR-0004 증보 5다.
- 근거: 이 ADR의 증보 2026-09-26(팀 에이전트는 BYOK가 기본)과 ADR-0193 (c). Claude를 팀 에이전트로 쓰려면 구독이 아니라 Claude 콘솔 API 키로 Messages API를 불러야 한다.

### D1. 봉투 kind가 wire를 고른다 — 세 번째 wire
지금까지 봉투 kind는 두 wire를 골랐다(API 키 bearer → chat/completions, `oauth-openai` → Responses). 여기에 세 번째를 더한다.

| 봉투 kind | wire | 요청 |
|---|---|---|
| (레거시 bearer) | chat/completions | `POST {base}/chat/completions`, `Authorization: Bearer` |
| `oauth-openai` | Responses | 본문 이행 절 그대로 |
| `anthropic-key` | Anthropic Messages | `POST {base}/messages` 스트리밍, `x-api-key` + `anthropic-version: 2023-06-01`, Authorization 없음 |

- wire 선택은 worker가 복호화한 봉투의 kind로만 한다. base URL이나 호스트 이름으로 추측하지 않는다.
- Messages 변환(system을 최상위로, 연속 역할 병합, 첫 turn user, `max_tokens` 기본값, 도구 정의·`tool_use` 변환, usage 매핑, 재시도 분류)은 구현 세부이며 이 ADR이 고정하지 않는다.

### D2. `anthropic-key` 봉투 — migration 없음
- 키는 기존 AES-GCM 봉인 박스(`PROVIDER_LINK_MASTER_KEY`) 안에 `{"kind":"anthropic-key","api_key":…}` 봉투로 저장한다. 테이블·컬럼 변경은 없다. 레거시 bearer 행은 바이트 그대로 둔다.
- 봉인 계약은 본문 결정 1 그대로다: api는 봉인만, worker가 job 시점에 복호화, 평문은 로그·audit·응답에 없다. 조회 응답은 `credentialKind: "anthropic-key"`만 드러낸다.
- 이 kind는 API 키다. 이 ADR 증보 2026-09-26의 「구독 OAuth kind를 새로 더하지 않는다」와 충돌하지 않는다. Claude 구독 토큰은 여전히 어떤 kind로도 넣지 않는다.

### D3. `format` 필드
- `PUT /v1/provider/link` 본문의 `format`은 `"openai" | "anthropic"`이다. 생략하면 `openai`이고 기존 요청과 바이트가 같다. 모르는 값은 400, `anthropic`과 `oauth`를 함께 보내면 400이다.
- 응답은 `format`과 `presets`(ADR-0004 증보 5 D5)를 싣는다.
- `PUT …/chain`의 hop은 지금 bearer만 받는다. 체인에 Anthropic을 여는 것은 후속이며, 연다면 같은 `format` 규칙을 따른다.

### D4. 오류에서 키를 지운다
- provider가 오류 본문에 받은 키를 되돌려 보내도 키가 새지 않아야 한다. router는 **모든 wire**의 `complete`·`complete_streaming` 오류 문자열에서 그 endpoint의 키를 `<redacted>`로 바꾼 뒤 돌려준다. 기존 `redact_secrets`와 함께 두 겹이다.
- `LinkCredential`과 `ProviderEndpoint`의 `Debug` 출력은 키를 싣지 않는다.
- 새 wire나 새 kind를 더할 때 이 두 규칙이 수용기준이다. 증명은 「provider가 키를 되돌려 보내는 mock에서 message·outbox·agent_run·usage_ledger·audit_log·평문 컬럼·TRACE 로그에 키 0회」 형태로 한다(PR #2888 `anth_3`).

### Consequences
- (+) Claude를 팀 에이전트로 BYOK 연결할 수 있다. 봉인 계약과 egress 가드를 그대로 재사용하므로 새 보안 표면이 작다.
- (+) 오류 경로의 키 제거가 wire 공통 규칙이 된다.
- (−) wire가 셋이 되어 변환 유지 부담이 는다. 실제 api.anthropic.com 왕복과 구조화 `tool_result` 짝짓기는 runtime-unverified다(PR #2888 「알려진 한계」).

---

## 증보 2026-09-27 — 연결 확인: api가 provider에 확인 호출 한 번을 보낸다

- Status: **Accepted** — 성재 결재 2026-09-27 「전부 권장대로」(AI 계정 Q5: 사용량은 공식 출처만, BYOK는 확인 호출 헤더, admin 키 금지). 이슈 #2960.
- 기안·구현: Opus 5.5 worker(#2960).
- **결정.** 운영자가 「연결 확인」을 누를 때만, `momo-server`가 켜져 있고 외부이고 쓸 수 있는 hop마다 **읽기 전용 GET 한 번**을 보낸다. 봉투 kind로 헤더를 고른다: bearer는 `GET {base}/models` + `Authorization: Bearer`, `anthropic-key`는 `GET {base}/models` + `x-api-key`·`anthropic-version`. `openrouter.ai`는 `/models`가 인증 없이 열려 있어 틀린 키도 성공으로 보이므로 `GET {base}/key`를 부른다(Q5가 이름 붙인 잔액 출처). completion은 보내지 않는다. 링크에 모델 id가 없어 「1토큰」 호출은 모델을 지어내야 하기 때문이다. 레거시 `oauth-openai` 머리 hop은 부르지 않고 `probe_not_run`으로 남긴다(토큰 갱신은 worker 몫이고 새로 만들 수 없는 kind다).
- **결정 4를 좁힌다.** `momo-server`는 여전히 `reqwest`를 링크하지 않는다. 호출은 봉인 크레이트 `momo-provider-probe`만 한다. API는 `ProviderProbe::probe(&ProbeTarget)` 하나다(ADR-0149 `momo-ephemeral`, ADR-0170 `momo-unfurl`과 같은 모양). 모든 호출은 ADR-0004 증보 5의 egress 가드를 거친다: 같은 `EgressPolicy`, 연결 시점 resolver, redirect 없음, 프록시 없음. 정책 입력은 worker·쓰기 게이트와 같다. strict 환경(`MOMO_ENV=staging` 등)에서도 ADR-0004 증보(2026-09-08)대로 운영자 opt-in이 유효하다. 사전 DNS 조회도 hop당 시간 상한(10초) 안에 있고, 넘으면 `unreachable`이다.
- **ADR-0135 D2-B와 충돌하지 않는다.** D2-B가 기각한 것은 새 자격이 서버로 들어오는 조회다. 이 호출은 이미 서버 봉인 금고에 있는 키(ADR-0004 증보 1)를 쓰고, 새 자격을 받지 않는다. 구독 잔여량은 계속 D2 경로(숫자 ingest)다. 이 확인 호출은 그 호출 자체의 응답 헤더에 있는 숫자만 보여 준다.
- **결과.** hop마다 다섯 분류(`ok`·`rejected`(401·403)·`unreachable`(DNS·연결·시간 초과·egress 거부)·`rate_limited`(429)·`unknown`(그 밖의 상태, 문서와 다른 2xx 본문))와 기존 reason 어휘(`provider_auth_failed`·`provider_unreachable`·`provider_rate_limited`·`provider_status_NNN`, 새로 `provider_egress_denied`·`provider_invalid_response`)를 낸다. 숫자는 provider가 밝힌 것만 싣는다: 모델 목록 길이(페이지가 나뉘면 싣지 않음), `x-ratelimit-*`·`anthropic-ratelimit-*`·`retry-after` 헤더, OpenRouter `/key`의 `limit`·`limit_remaining`·`usage`. 응답 본문·헤더 문자열·전송 오류 문자열은 크레이트 밖으로 나가지 않는다. 그래서 provider가 오류에 키를 되돌려 보내도 응답·로그·audit에 실리지 않는다.
- **빈도 제한.** 운영자 멤버십(member, 워크스페이스별)마다 1분에 6회(넘으면 429 + `Retry-After`). 링크(위치·base URL·키 digest)마다 20초 안의 재확인은 직전 결과를 `cached: true`로 돌려주고 다시 부르지 않는다. 키나 URL을 바꾸면 새 링크다. 웹 패널은 버튼을 누를 때만 부른다(`AiLinkSection.tsx` `check.mutate()`).
- **검증 한계.** OpenAI·Anthropic·xAI·OpenRouter 모양 mock으로만 시험했다. 실제 provider 왕복은 runtime-unverified다.

## 증보 2026-09-28 — 기본 AI 운영자 행과 연결 확인의 모델 id

- Status: **Accepted**. 결재 인용: AI 계정 Q1~Q7 「전부 권장대로」(성재 2026-09-27)와 planner 편성 #3009. 제안서 §4.2는 「기본 AI」 표의 팀 행을 운영자만 바꾸는 서버 설정으로 두었다. §4.5 불변식 2는 팀 에이전트의 자격 해석이 provider_link 체인만 본다고 정했다. §4.2는 모델 선택지로 그 자격이 실제로 부를 수 있는 모델만 보이라고 했다. 이 증보는 그 세 문장을 서버 계약으로 적는다.
- 기안·구현: Opus 5.5 worker(#3009). PR #3007(#2881 AA-8)의 이탈표 「팀 줄의 서버 저장」「자격별 모델 목록」을 닫는다.
- **D1. `GET/PUT /v1/provider/default-ai`.**
  - 게이트는 `/v1/provider/link`와 같은 MOMO-583 운영자 게이트다(두 동사 모두). 운영자가 아니면 403이고 값을 받지 못한다. 웹 표의 운영자 판정과 같은 답이다.
  - 행은 `teamAgent`(팀 에이전트 대답)와 `summary`(채널 요약·첫 인사) 둘이다. 한 행은 **링크 참조와 모델 id뿐**이다.
    - 링크 참조는 cascade 위치다. 0은 `provider_link` 또는 env, 1 이상은 체인 hop이다. 여기에 그 위치가 고를 때 가졌던 가린 endpoint label을 함께 둔다.
    - 모델 id는 `null`이면 링크의 기본값이다.
  - 키·봉투·경로·토큰 칸은 없다. 그래서 이 표면은 master key를 쓰지 않는다.
  - `PUT …/chain`은 hop을 지우고 다시 넣는다. 그래서 위치는 안정된 id가 아니다. 읽을 때 지금 label과 다르면 `linkResolved: false`로 알리고, 조용히 따라가지 않는다.
- **D2. 팀 행은 개인 구독을 이름할 수 없다.**
  - `source`는 `team_link`만 받는다. 라우트가 400으로 거부하고, 테이블 CHECK(`credential_source = 'team_link'`)가 다시 거부한다.
  - body는 닫혀 있다(`deny_unknown_fields`). 그래서 프로필 경로나 토큰 필드가 끼어들 수 없다.
  - 가드레일 행은 `off`만 받는다. 판정기 ADR이 Accepted되기 전까지다(Q6).
- **D3. 쓰기는 행 단위 patch다.**
  - 생략한 행은 유지하고, `null`은 지우고, 객체는 교체한다.
  - 행이 바뀔 때마다 `provider_default_ai.updated` audit를 남긴다. 페이로드는 위치·label·모델 id뿐이다.
  - 모델 id는 서버 정화기(`sanitized_model_id`: 1~64바이트, `[A-Za-z0-9._:/@+-]`, 영숫자 시작)를 통과해야 한다. live 확인 목록과 대조하지는 않는다. 확인 호출은 빈도 제한과 캐시가 걸린 경로라서, 목록으로 거르는 일은 클라이언트가 확인 응답의 `modelIds`로 한다.
- **D4. 저장소.**
  - migration `093_provider_default_ai`. `provider_link`처럼 instance-global이다(`workspace_id` 없음). RLS ENABLE+FORCE이고 `app.provider_link_admin` GUC 정책을 쓴다. 테넌트 트랜잭션은 0행을 본다.
  - BYPASSRLS worker 역할은 설계상 읽을 수 있다(039와 같다).
  - schema_v0.sql은 건드리지 않는다. 모든 문장이 가드되어 있어 다시 적용해도 무해하다.
- **D5. 연결 확인의 `modelIds`.** 연결 확인 증보의 「본문 문자열은 나가지 않는다」의 유일한 예외다. `/models` 2xx 본문의 `data[].id`만 싣는다.
  - 문자열 id만 받고, D3의 정화기를 거친다. 중복은 하나로 합치고, 최대 100개다.
  - **제시한 키의 8바이트 조각을 담은 id는 버린다.** 목록에 키가 통째로 또는 큰 조각으로 실수로 섞여 되돌아오는 경우를 막는 심층 방어다. 보장은 아니다. 그 endpoint는 이미 요청 헤더로 키를 받았다. 일부러 대소문자를 바꾸거나 8바이트보다 작게 쪼개면 통과한다.
  - 클라이언트는 모델 id를 텍스트로만 그린다. `href`나 URL에 넣지 않는다(허용 문자에 `:`와 `/`가 있다).
  - 페이지가 나뉜 목록(`has_more`)이나 상한을 넘은 목록은 `modelIdsTruncated: true`다.
  - OpenRouter `/key` 확인은 키별 목록이 없어서 `modelIds`를 싣지 않는다. 공개 `/models`는 여전히 부르지 않는다.
- **범위 밖(후속).**
  - agent-worker는 아직 이 행을 읽지 않는다. 읽을 때의 우선순위는 **에이전트 자신의 `model` > `teamAgent.modelId` > `AGENT_MODEL`**이다. 팀 행은 기본값이지 에이전트 모델을 덮어쓰지 않는다(§4.2 「에이전트별 모델(F10 유지)」).
  - 요약·첫 인사 경로가 `summary` 행을 읽는 것도 후속이다.
  - 웹 표 AA-8이 이 API로 저장하는 것은 uxui 후속이다.
- **검증.**
  - 격리 PG 시험(`provider_probe_conformance_pg.rs`): 비운영자 403, 개인 source의 라우트 400과 CHECK 거부, 행 patch, 체인 이동 감지, audit에 키 없음, 테넌트 트랜잭션 0행·쓰기 거부, 키를 조각내 되돌리는 mock에서 `modelIds`에 조각 없음.
  - 사보타주로 가드마다 빨강을 확인했다. 실제 provider 왕복은 runtime-unverified다.

## 증보 2026-09-28 — 체인 키는 origin에 묶인다

- Status: **Accepted**. 결재 인용: 보안 결함 수리 — planner 편성 #3040, PR #3039 보안 검수 발견(diff 밖 기존 High).
- 기안·구현: Opus 5.5 worker(#3040).
- **결함.** `PUT /v1/provider/link/chain`은 bearer를 생략한 hop에 같은 위치의 저장 키를 그대로 붙였다. base URL은 무엇이든 받았다. 그래서 운영자 B가 운영자 A의 hop을 자기 host로 돌리고 「연결 확인」을 누르면 A의 키가 B의 host로 갔다. egress 가드는 공개 host를 막지 않는다. 두 hop의 URL을 서로 바꾸는 재배치도 같은 결과였다.
- **D1. 저장 키는 origin에 묶인다.** origin은 `scheme://host:port`다. 기본 포트는 적어서 비교한다(`https` 443, `http` 80). 그래서 `https://a.example`과 `https://a.example:443`은 같은 origin이다. scheme·host는 쓰기 게이트가 이미 소문자로 정규화한다. 해석되지 않는 URL은 다른 origin으로 본다. 구현은 `momo_settings::url_origin`·`same_origin`이다.
- **D2. 키 없이 origin을 바꾸면 409다.** 요청 hop에 bearer가 없고, 그 위치의 저장 hop이 다른 origin이면 `409` + `error.code: key_required_for_new_origin`(ADR-0188 R0)이다. 트랜잭션은 첫 쓰기 전에 끝나므로 아무것도 바뀌지 않는다. 메시지에는 위치와 가린 endpoint label만 싣는다. 키는 싣지 않는다.
  - **폐기 대신 409를 고른 근거.** migration 042의 `bearer_ciphertext`는 `NOT NULL`이고 길이 0을 CHECK로 막는다. 「키 없는 hop」은 새 migration 없이 표현할 수 없다. 조용히 폐기하면 hop 행이 사라지거나 cascade가 짧아진다. 운영자는 저장 성공으로 읽는다. 409는 스키마를 바꾸지 않고 의도를 되묻는다.
  - 새 위치에 bearer가 없으면 예전 그대로 `400 bearer is required for new chain position N`이다(웹 초안 모델이 이 문장을 안다).
- **D3. 같은 origin 안의 변경은 키를 유지한다.** 경로 변경(`/v1` → `/v2`), `mode`, `enabled`는 저장 키를 유지한다. provider 키가 발급되는 신뢰 경계가 서버(origin)이기 때문이다. 정직한 한계: 한 origin 아래 경로로 테넌트를 나누는 게이트웨이라면 경로 변경이 다른 테넌트로 갈 수 있다. 그런 hop은 경로를 바꿀 때 키를 다시 넣는다(운영 안내). 서버는 막지 않는다.
- **D4. 머리 hop과 `format`.** 위치 0(`PUT /v1/provider/link`)은 이미 매번 새 키를 요구한다(`bearer must not be empty`). 그래서 base URL이나 `format`을 바꿀 때 저장 키가 따라가는 경로가 없다. 체인 hop에는 `format` 필드가 없다. 체인 hop은 한 종류(bearer)뿐이다. 수용기준의 「format이 바뀌면」은 이 두 사실로 닫힌다.
- **D5. audit.** 성공한 체인 PUT의 `provider_link_chain.updated`에 `origin_changed: [{position, from, to}]`를 싣는다. `from`·`to`는 가린 endpoint label이다. origin이 바뀐 hop만 담는다. 그런 hop은 새 키를 받은 hop뿐이다. 거부된 PUT(409·400)은 아무것도 쓰지 않으므로 audit 행도 없다.
- **worker 대답 경로.** 지금 agent-worker는 `provider_link`(위치 0)만 읽는다(`resolve_transport` → `read_link`). 체인 hop은 읽지 않는다. 그래서 오늘 이 결함은 「연결 확인」으로만 드러났다. 기본 AI 행(#3009 D1)이 위치 1 이상을 가리킬 수 있어서, worker가 체인을 읽게 되면 같은 유출이 대답 경로로 옮겨 간다. 수리는 쓰기 시점에 있으므로 그 경로도 함께 막는다. 머리 행의 다른 쓰기는 worker의 `reseal_link_credential` 하나다. 이 함수는 봉투만 바꾸고 `base_url`은 바꾸지 않는다.
- **검증.** 격리 PG 시험 `provider_probe_conformance_pg.rs::a_kept_chain_key_is_never_sent_to_a_new_origin`. 운영자 A·B 두 명, 두 origin의 기록 mock을 쓴다. 바꿔치기와 재배치 뒤 연결 확인에서 B의 mock이 A의 키를 0회 받는다. 수리 전 이 시험은 빨갛다. 같은 origin 경로 변경은 키를 유지하고, 새 키와 함께 origin을 바꾸면 audit에 label만 남는다. 사보타주 기록은 PR 본문에 있다.
- **범위 밖(후속).** 웹 설정의 체인 초안은 저장 hop의 URL을 바꿔도 키를 요구하지 않고, 409를 일반 오류 문장으로 보인다. uxui 후속 이슈로 다룬다.
