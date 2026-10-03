# ADR-0147: 채팅 에이전트 provider에 구독 OAuth 수용 — GPT OAuth 우선

- Status: **Accepted** (2026-08-02 성재 — "앤트로픽 키 안 쓰고 gpt oauth 사용" 지시 + 제안 승인 "ㄱㄱ". 기안 Fable)
- 관련: ADR-0004(+증보 1 — provider_link 봉인 계약이 이 결정의 그릇), ADR-0144(코딩 에이전트=sandbox-internal login — **무변경 유지**), ADR-0113(커넥터 경계 — 참조), ADR-0146(provenance), B5.1(agent-worker)·B4.2(provider link REST)
- 증보: 2026-09-26 온보딩 2.0(ADR-0193 Q2) — 구독 OAuth 서버 금고를 확장하지 않는다. 팀 에이전트는 API 키가 기본이다. 파일 끝 「증보 2026-09-26 — 온보딩 2.0」 절
- 증보: 2026-09-27 Anthropic Messages wire(#2872) — 세 번째 wire와 봉인 박스 `anthropic-key` kind, `format` 필드, 오류의 키 제거 규칙. 파일 끝 「증보 2026-09-27 — Anthropic Messages wire」 절
- 증보: 2026-09-27 AI 계정(#2876) — 설정 화면에서도 `auth.json` 붙여넣기로 새 링크를 만들 수 없다. 「증보 2026-09-26」 절 끝 한 줄
- 증보: 2026-09-27 연결 확인(#2960) — `POST /v1/provider/link/test`가 봉인 크레이트를 거쳐 provider에 읽기 전용 GET 한 번을 보낸다. 결정 4의 「momo-server HTTP 0」을 좁힌다. 파일 끝 「증보 2026-09-27 — 연결 확인」 절
- 증보: 2026-09-28 기본 AI 운영자 행(#3009) — `GET/PUT /v1/provider/default-ai`와 새 테이블 `provider_default_ai`(migration 093), 그리고 연결 확인 응답의 `modelIds`. 연결 확인 증보의 「provider 문자열은 크레이트 밖으로 나가지 않는다」를 모델 id 한 가지만큼 좁힌다. 파일 끝 「증보 2026-09-28 — 기본 AI 운영자 행」 절
- 증보: 2026-09-28 키는 origin에 묶인다(#3040) — `PUT /v1/provider/link/chain`이 키 없이 hop의 origin을 바꾸면 409 `key_required_for_new_origin`. 파일 끝 「증보 2026-09-28 — 체인 키는 origin에 묶인다」 절
- 증보: 2026-09-29 에이전트 모델 출처(#3147) — `agent.model_source`(migration 098)와 payload `model_source`가 #3146의 「모델 이름 비교」 휴리스틱을 대체한다. 파일 끝 「증보 2026-09-29 — 에이전트 모델 출처」 절
- 증보: 2026-10-03 개인 API 키(#3396) — 조직이 한 사람에게 발급하는 소유자 있는 BYOK. 새 테이블 `personal_provider_link`와 `agent.uses_owner_key`(migration 117), 그 사람의 본인 전용 에이전트만 해석한다. 파일 끝 「증보 2026-10-03 — 개인 API 키」 절
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
- **워커 연결(#3041, 2026-09-29).** agent-worker가 매 턴 이 행을 읽는다.
  - 우선순위는 **에이전트 자신의 모델 > 팀 행 `modelId` > `AGENT_MODEL`**이다. `agent.model`은 `NOT NULL`이라 payload는 늘 모델을 싣는다. 그래서 「에이전트 자체 모델이 없다」는 payload 모델이 비었거나 인스턴스 기본(`AGENT_MODEL`)과 같은 경우다(씨앗 에이전트, 자리표시자로 만든 에이전트). 그 밖의 모델은 에이전트의 것이라 행을 읽지도 않는다. 인스턴스 기본과 같은 모델을 일부러 고른 에이전트는 구분할 수 없어 행을 따른다(이탈로 기록).
  - 역할은 첫 인사(웰컴 opener) 잡이면 `summary`, 그 밖의 대답이면 `teamAgent`다. 채널 요약을 만드는 워커 경로는 아직 없다. 생기면 `summary` 행을 읽는다.
  - 행의 링크 위치가 **지금도 저장 당시 label을 보일 때만** 쓴다. 위치 0은 이 턴이 푼 머리 링크, 1 이상은 `provider_link_chain` hop이다(hop은 그 hop의 URL·키로 부른다). `modelId`가 `null`이면 턴의 모델을 그대로 둔다.
  - label이 다르거나 위치가 없거나 hop이 꺼졌거나 키가 열리지 않으면 **모델을 부르지 않는다.** 다른 링크·다른 모델로 넘어가지 않는다. 실행은 `failed`(`error.code: default_ai_unresolved`)로 닫고, 채널에는 #2871 시스템 줄(`props.reason: default_ai_unresolved`, 문 「AI 연결 열기」)을 남기고, 운영자용 audit `provider_default_ai.unresolved`에 역할·위치·저장 label·현재 label(모두 가린 값)만 싣는다.
  - 행을 읽지 못하면(DB 오류) 추측하지 않고 재시도한다.
- **범위 밖(후속).**
  - 웹 표 AA-8이 이 API로 저장하는 것과 「저장됐지만 아직 적용 전」 문구 제거는 uxui 후속이다.
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

## 증보 2026-09-29 — 에이전트 모델 출처

- Status: **Accepted**. 결재 인용: planner 편성 #3147(#3146 후속, 「서버 payload에 모델 출처를 실어 휴리스틱 대체」).
- 기안·구현: Sonnet 5.5 worker(#3147, 엔진).
- **문제.** `agent.model`은 `NOT NULL`이라 「고른 모델」과 「고르지 않아 채운 자리표시자」를 이름만으로 구분할 수 없다. #3146은 payload 모델이 비었거나 `AGENT_MODEL`과 같으면 팀 행을 적용했다. 인스턴스 기본과 같은 이름을 일부러 고른 에이전트가 행을 따랐고, 자리표시자를 다른 이름으로 저장한 에이전트는 행에 닿지 못했다.
- **D1. 출처는 사실로 저장한다.** `agent.model_source text NOT NULL DEFAULT 'agent' CHECK IN ('agent','instance_default')`(migration 098). `agent`: `model`이 에이전트의 선택이다. 팀 행은 적용하지 않는다. `instance_default`: 인스턴스 기본을 따른다. 팀 행을 적용하고, `model`은 행이 모델을 지정하지 않을 때 쓰는 대체값이다. `model`은 계속 `NOT NULL`이다(이름을 읽는 모든 경로가 그대로다).
- **D2. 백필(1회).** 자리표시자 `hermes-agent`(002/006 씨앗, worker `AGENT_MODEL` 기본값)를 저장한 행은 `instance_default`, 나머지는 `agent`다. #3146 휴리스틱을 기본 설정의 인스턴스에서 그대로 옮긴 결과다. `AGENT_MODEL`을 바꿔 운영하는 인스턴스는 프로필 PUT의 `modelSource`로 다시 표시한다. 백필은 컬럼을 추가하는 실행에서만 돈다(재실행이 운영자의 선택을 덮지 않는다).
- **D3. API.** 생성 `POST …/agents`의 `modelSource`(생략=`agent`), 수정 `PUT …/agents/{agent}/profile`의 `modelSource`(생략=변경 없음). 어휘 밖은 400. 프로필 응답에 `modelSource`. audit `agent.created`·`agent.profile.*`에 값을 싣는다.
- **D4. payload는 해석된 출처를 싣는다.** 모든 `agent_job` payload(멘션·웰컴·승인 재개·work run)에 `model_source`. 요청의 `routing.model`이나 적용된 `modelPref`는 에이전트가 `instance_default`여도 `agent`다(호출자가 고른 모델을 팀 행이 덮지 않는다). 아무것도 고르지 않은 채 기본 모델이 도는 경우만 컬럼 값을 그대로 싣는다.
- **D5. worker 판정.** `model_source == "instance_default"`일 때만 행을 읽는다. 키가 없으면(이 증보 이전에 넣은 잡) `agent`로 본다. 이름 비교 휴리스틱은 남기지 않는다. 링크 label 대조·정직한 실패(#3041)는 그대로다.
- **범위 밖.** 채널 요약을 만드는 워커 경로(`summary` 행)는 기억 기능 계획과 함께 결정한다. 웹 설정 UI(에이전트 모델 선택에 「인스턴스 기본 따르기」, 「아직 적용 전」 문구 제거)는 uxui 후속이다.
- **검증.** 격리 PG: `default_ai_conformance_pg::the_model_source_decides_not_the_models_name`(같은 이름이어도 출처로 구분), `mention_routing_conformance_pg::m3147_1`(생성·수정·payload), `m3147_2`(098 백필). 사보타주 기록은 PR 본문.

## 증보 2026-10-03 — 개인 API 키

- Status: **Accepted**. 결재 인용: 성재 2026-10-03 AskUserQuestion ③ 「조직이 개인에게 주는 『개인 API 키』(소유자 있는 BYOK) 신설」. 원문: 「조직 레벨에서는 에이전트를 통한 소통이나 BYOK로 조직의 오케스트레이터… 내 개인적인 호출·작업 요청·터미널 개발 요청은 내 개인 OAuth나 조직에서 받은 BYOK로 내 개인 에이전트…」. 약관 근거는 로컬 조사 `claudedocs/diag-ai-connect-2026-10-03/policy-architecture.md` §2 B·§4.1(Anthropic 상업 약관의 「customer's own authorized users」, 키 소유·과금 주체는 조직, 키 1개를 여러 사람이 돌려 쓰지 않기).
- 기안·구현: Sonnet 5.5 worker(#3396, 엔진).
- **무엇이 새로운가.** 팀 키(`provider_link`·`provider_link_chain`)는 인스턴스 전역이고 팀이 함께 부르는 에이전트가 쓴다. 이 증보는 둘째 층이다. 워크스페이스 안의 한 사람에게 발급된 API 키이고, 그 사람의 `owner_only` 에이전트만 쓴다. 구독 OAuth를 서버가 쥐지 않는다는 위 증보 2026-09-26의 결정은 그대로다. 개인 키는 API 키다.
- **D1. 그릇.** `personal_provider_link`(migration 117): `workspace_id`, `owner_member_id`(같은 워크스페이스의 사람만, 트리거), `format`(`openai`|`anthropic`), `base_url`, 봉인된 키(`bearer_ciphertext`, 팀 키와 같은 AES-GCM·`PROVIDER_LINK_MASTER_KEY`), `key_fingerprint`, `label`, 발급자, 회수 시각·회수자. RLS FORCE + `ws_isolation`이다. `app.provider_link_admin` GUC는 일반 멤버 tx에 켜지 않는다. 키 평문 컬럼은 없다. 소유자·키·origin은 갱신할 수 없고(트리거), 회수는 되돌릴 수 없다.
- **D2. 발급 정책: 운영자 발급만.** 워크스페이스 owner/admin이 `POST /v1/workspaces/{ws}/personal-keys`로 한 사람에게 준다. 멤버가 자기 키를 직접 넣는 경로는 **없다**. 「정책이 허용하면 멤버도 추가」는 별도 결정(별도 설정 스위치)이고 이 증보가 열지 않는다. 회수는 관리자 또는 키의 소유자다. 목록은 관리자 전체, 멤버는 `GET …/personal-keys/mine`(본인 것만; 소유자 필터가 호출자 id라 매개변수가 아니다).
- **D3. 해석 규칙: 에이전트를 통해서만.** 워커는 에이전트 행에서 시작한다: `invocation_scope = 'owner_only'`이고 `uses_owner_key`이며, 키는 그 에이전트의 `owner_human_id`가 소유한 활성(회수 안 됨) 행이고 소유자는 아직 활성 사람이다(`read_owner_key_for_agent`). 질문한 사람으로 키를 찾지 않는다. 별도 문(`AgentWorker::resolve_owner_key_transport`)이고 팀의 `resolve_transport`는 이 표를 모른다(구조 시험이 그 함수 안의 단어를 막는다). 캐시가 없어 회수는 다음 턴에 효력이 있다.
- **D4. 폴백 없음.** 키가 없거나(발급 전·소유자 퇴장) 회수됐거나 열 수 없거나 API 키가 아니면(구독 OAuth 봉투 포함) 그 턴은 답하지 않는다. 팀 env 키, 팀 `provider_link`, 체인 hop, 「기본 AI」 행 중 아무것도 대신 쓰지 않는다(ADR-0135 D1, #2897·PR #2940과 같은 규칙). 사용자에게는 에이전트 이름의 한 줄(`personal_key_unavailable`), 감사 `agent.personal_key.unavailable`(고정 사유 라벨만). 그 턴은 팀의 「기본 AI」 행도 계산하지 않는다(과금 혼동).
- **D5. 키 1개 = 한 사람.** 키 지문은 마스터 키로 도메인 분리한 SHA-256이다(봉투는 nonce가 달라 비교할 수 없다). **활성 행끼리 인스턴스 전역으로 UNIQUE**라 같은 키를 두 번(같은 사람·다른 사람·다른 워크스페이스) 발급하면 `409 personal_key_already_attached`다. 사람당 활성 키는 하나(`409 personal_key_owner_has_active_key`). 교체는 회수 뒤 재발급이고, 회수된 행의 지문은 재발급을 막지 않는다. 한계: 지문은 DB 안에서만 비교되고 응답·감사에 나오지 않는다. 같은 키의 다른 표기(공백 외)는 같은 키로 보지 못한다.
- **D6. 도달 불가의 경계.**
  - 팀 에이전트와 다른 사람의 에이전트는 구조적으로 닿지 못한다: 키는 에이전트의 `owner_human_id`로만 열리고, 그 컬럼과 `uses_owner_key`는 `owner_only` 행에서 한 방향이다(트리거 확장). 호출 문은 기존 `owner_only_gate` 그대로라 소유자 아닌 사람은 호출하지 못한다(운영자도 아니다).
  - 개인 키 에이전트의 답이 팀 에이전트를 부르지 않는다(A2A 출발 차단). 팀 에이전트가 개인 키 에이전트를 부르지도 못한다(기존 ADR-0193 D4·#2897). 환영(welcome)은 하지 않는다.
  - 운영자의 구독 킬 스위치(`subscription_agents_enabled`)와 hosted 전달 게이트는 개인 키 에이전트에 적용하지 않는다. 그 스위치는 구독 CLI에 대한 것이고 개인 키는 구독이 아니다.
  - 에이전트는 자기 모델을 따른다(`model_source = agent`). 생성 경로가 그렇게 만들고 워커는 개인 턴에 팀 행을 적용하지 않는다.
- **D7. 엔드포인트와 SSRF.** `baseUrl`은 팀 링크 PUT과 같은 `validated_base_url`을 지난다(HTTPS, userinfo·query·fragment 금지, 사설·메타데이터 리터럴과 loopback은 운영자 옵트인). 호출 시점의 연결 가드(`momo-egress`)는 모든 provider 호출에 같다. 수정 경로가 없어서 저장된 키가 편집된 URL을 따라 다른 origin으로 가지 못한다(증보 2026-09-28과 같은 이유). origin을 바꾸려면 회수와 재발급이다.
- **D8. API·감사.** `POST/GET /v1/workspaces/{ws}/personal-keys`, `GET …/mine`, `POST …/{key}/revoke`, `POST …/{key}/agent`(소유자 또는 관리자가 그 사람의 개인 에이전트를 만든다). 키는 쓰기 전용(`apiKey`)이고 어떤 응답·감사·로그에도 나오지 않는다. 응답은 id·소유자·형식·가린 endpoint label·label·상태·시각이다. 감사 `provider.personal_link.issued`·`provider.personal_link.revoked`는 id·형식·label만 싣는다(재회수는 감사 행을 늘리지 않는다). OpenAPI에 올렸다.
- **정직한 한계.**
  - 비용 귀속: `usage_ledger`는 에이전트 기준이라 개인 키 에이전트의 사용량도 워크스페이스 집계에 들어간다. 키 출처 컬럼은 없다. 청구 주체는 provider 쪽 키 소유자(조직)다.
  - 환영·hosted 인박스 같은 일부 입구는 `owner_only`를 구독으로 읽는다. 개인 키 에이전트는 그 입구에서 호출되지 않거나(환영) 워커 큐로만 간다. 이 증보가 보장하는 호출 입구는 멘션·1:1 DM·스레드 답글(멘션)·작업 요청이다.
  - AIH-2(#3392)의 에이전트 읽기 계약 `brain`은 `owner_only`를 항상 `subscription`으로 파생한다. 개인 키 에이전트의 `brain` 값(`personal_key`)은 두 PR이 합쳐진 뒤 후속에서 더한다. 그 전까지 읽기 계약의 라벨이 부정확할 수 있고, 호출·키 해석 동작에는 영향이 없다.
  - UI(발급·회수·내 키 화면)는 AIH-6이다. 멤버 직접 추가 정책 스위치는 열지 않았다.
- **검증.** 격리 PG: `momo-agent-worker/tests/personal_key_conformance_pg.rs`(개인 턴은 소유자 키만, 팀 턴은 개인 키를 못 봄, 다른 사람의 에이전트, 회수는 다음 턴, 읽을 수 없는 키와 OAuth 봉투, 위임·환영 없음, 어떤 행에도 키 없음)와 `momo-server/tests/personal_key_conformance_pg.rs`(발급·목록·회수·인가, 한 키 한 사람, 입력 거부, 개인 에이전트 전달, RLS). 사보타주 기록은 PR 본문.

