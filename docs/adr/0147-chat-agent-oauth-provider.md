# ADR-0147: 채팅 에이전트 provider에 구독 OAuth 수용 — GPT OAuth 우선

- Status: **Accepted** (2026-08-02 성재 — "앤트로픽 키 안 쓰고 gpt oauth 사용" 지시 + 제안 승인 "ㄱㄱ". 기안 Fable)
- 관련: ADR-0004(+증보 1 — provider_link 봉인 계약이 이 결정의 그릇), ADR-0144(코딩 에이전트=sandbox-internal login — **무변경 유지**), ADR-0113(커넥터 경계 — 참조), ADR-0146(provenance), B5.1(agent-worker)·B4.2(provider link REST)
- 증보: 2026-09-26 온보딩 2.0(ADR-0193 Q2) — 구독 OAuth 서버 금고를 확장하지 않는다. 팀 에이전트는 API 키가 기본이다. 파일 끝 「증보 2026-09-26 — 온보딩 2.0」 절
- 증보: 2026-10-19 Hermes가 보관하는 구독 OAuth 허용(#4071, owner 결정) — 2026-09-26 증보의 「구독 OAuth 서버 금고를 넓히지 않는다」는 **oort 금고 한정**으로 좁혀진다. 파일 끝 「증보 2026-10-19 — Hermes가 보관하는 구독 OAuth」 절
- 증보: 2026-09-27 Anthropic Messages wire(#2872) — 세 번째 wire와 봉인 박스 `anthropic-key` kind, `format` 필드, 오류의 키 제거 규칙. 파일 끝 「증보 2026-09-27 — Anthropic Messages wire」 절
- 증보: 2026-09-27 AI 계정(#2876) — 설정 화면에서도 `auth.json` 붙여넣기로 새 링크를 만들 수 없다. 「증보 2026-09-26」 절 끝 한 줄
- 증보: 2026-09-27 연결 확인(#2960) — `POST /v1/provider/link/test`가 봉인 크레이트를 거쳐 provider에 읽기 전용 GET 한 번을 보낸다. 결정 4의 「momo-server HTTP 0」을 좁힌다. 파일 끝 「증보 2026-09-27 — 연결 확인」 절
- 증보: 2026-09-28 기본 AI 운영자 행(#3009) — `GET/PUT /v1/provider/default-ai`와 새 테이블 `provider_default_ai`(migration 093), 그리고 연결 확인 응답의 `modelIds`. 연결 확인 증보의 「provider 문자열은 크레이트 밖으로 나가지 않는다」를 모델 id 한 가지만큼 좁힌다. 파일 끝 「증보 2026-09-28 — 기본 AI 운영자 행」 절
- 증보: 2026-09-28 키는 origin에 묶인다(#3040) — `PUT /v1/provider/link/chain`이 키 없이 hop의 origin을 바꾸면 409 `key_required_for_new_origin`. 파일 끝 「증보 2026-09-28 — 체인 키는 origin에 묶인다」 절
- 증보: 2026-09-29 에이전트 모델 출처(#3147) — `agent.model_source`(migration 098)와 payload `model_source`가 #3146의 「모델 이름 비교」 휴리스틱을 대체한다. 파일 끝 「증보 2026-09-29 — 에이전트 모델 출처」 절
- 증보: 2026-10-03 개인 API 키(#3396) — 조직이 한 사람에게 발급하는 소유자 있는 BYOK. 새 테이블 `personal_provider_link`와 `agent.uses_owner_key`(migration 117), 그 사람의 본인 전용 에이전트만 해석한다. 파일 끝 「증보 2026-10-03 — 개인 API 키」 절
- 증보: 2026-10-16 에이전트별 키 고정(#3873) — 에이전트 한 명을 체인 위치 또는 운영자 env 링크(Hermes)에 고정한다. 새 테이블 `agent_provider_pin`(migration 136). 팀 기본 AI와 같은 서버 Hermes가 한 인스턴스에서 함께 산다. 파일 끝 「증보 2026-10-16 — 에이전트별 키 고정」 절
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

- **확장하지 않는다.** provider_link 금고에 구독 OAuth kind를 새로 더하지 않는다. Claude(Pro·Max) 구독 토큰은 어떤 경로로도 금고에 넣지 않는다. **[정정됨 2026-10-19: 이 금지는 oort 금고 한정이다. Hermes가 자기 볼륨에 보관하는 경로는 막지 않는다 — 파일 끝 증보]** Anthropic 법무 문서가 제3자의 claude.ai 자격·세션 토큰 수집·저장·중개를 금지한다(https://code.claude.com/docs/en/legal-and-compliance). ChatGPT 구독도 셀프호스트 서버가 여러 사람 대신 호출하면 OpenAI의 계정 공유 금지와 부딪힌다. ADR-0191 옵션 B 기각과 같은 이유다.
- **기존 `oauth-openai` 경로는 그대로 「내부 도그푸딩 한정」이다.** 라벨을 유지하고, 온보딩 「AI 연결」 화면에 노출하지 않는다. 새 워크스페이스에 권하지 않는다.
- **팀이 함께 부르는 에이전트는 API 키(BYOK)가 기본이다.** 이 ADR 본문의 「제품 기본은 API 키」를 온보딩까지 넓힌다. 온보딩 「AI 연결」 목록의 「API 키로 팀 에이전트」 줄은 설정 › AI 연결 폼(provider_link, API 키 kind)으로 간다.
- **[정정됨 2026-10-19: 아래 「개인 경로로만」은 oort 서버가 구동·중개하는 경로에 대한 말이다. Hermes가 자기 구독으로 인증하는 경로는 파일 끝 증보가 허용한다.]**
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
- 이 kind는 API 키다. 이 ADR 증보 2026-09-26의 「구독 OAuth kind를 새로 더하지 않는다」와 충돌하지 않는다. Claude 구독 토큰은 여전히 어떤 kind로도 넣지 않는다(oort 금고 기준, 2026-10-19 증보로 Hermes 볼륨 보관은 별개).

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
- **D5. 키 1개 = 한 사람.** 키 지문은 마스터 키로 만든 HMAC-SHA256이다(봉투는 nonce가 달라 비교할 수 없고, 마스터 키 없이는 지문으로 키를 대입해 볼 수 없다). **활성 행끼리 인스턴스 전역으로 UNIQUE**라 같은 키를 두 번(같은 사람·다른 사람·다른 워크스페이스) 발급하면 `409 personal_key_already_attached`다. 사람당 활성 키는 하나(`409 personal_key_owner_has_active_key`). 교체는 회수 뒤 재발급이고, 회수된 행의 지문은 재발급을 막지 않는다. 한계: 지문은 DB 안에서만 비교되고 응답·감사에 나오지 않는다. 키는 출력 가능한 ASCII만 받아 같은 키의 다른 표기(제로폭 문자 등)를 막는다. UNIQUE가 인스턴스 전역이라 다른 워크스페이스의 운영자가 후보 키를 제출하면 409로 「어딘가에서 쓰이는 키」임을 알 수 있다(키를 알아야 하므로 노출은 작다). 마스터 키를 회전하면 지문이 모두 바뀌므로 회전 절차에서 활성 행을 다시 봉인할 때 다시 지문을 찍는다.
- **D6. 도달 불가의 경계.**
  - 팀 에이전트와 다른 사람의 에이전트는 구조적으로 닿지 못한다: 키는 에이전트의 `owner_human_id`로만 열리고, 그 컬럼과 `uses_owner_key`는 `owner_only` 행에서 한 방향이다(트리거 확장). 호출 문은 기존 `owner_only_gate` 그대로라 소유자 아닌 사람은 호출하지 못한다(운영자도 아니다).
  - 개인 키 에이전트의 답이 팀 에이전트를 부르지 않는다(A2A 출발 차단). 팀 에이전트가 개인 키 에이전트를 부르지도 못한다(기존 ADR-0193 D4·#2897). 환영(welcome)은 하지 않는다.
  - 운영자의 구독 킬 스위치(`subscription_agents_enabled`)와 hosted 전달 게이트는 개인 키 에이전트에 적용하지 않는다. 그 스위치는 구독 CLI에 대한 것이고 개인 키는 구독이 아니다.
  - 에이전트는 자기 모델을 따른다(`model_source = agent`). 생성 경로가 그렇게 만들고 워커는 개인 턴에 팀 행을 적용하지 않는다.
  - 워커는 호출자(작성자, 재개 턴이면 승인자)가 키의 소유자인지 한 번 더 본다. 입구들이 이미 소유자만 통과시키지만, 앞으로 생길 입구가 게이트를 빠뜨려도 키가 쓰이지 않게 하는 이중 방어다.
  - 한 사람에 개인 키 에이전트는 하나다(`agent_owner_key_holder_uk`). 키를 회수·재발급해도 같은 에이전트가 새 키로 이어 쓴다. 새 키가 다른 origin이면 발급 감사에 `origin_changed_from`(가린 이전 endpoint label)이 남고, 소유자는 `mine`에서 현재 endpoint label을 본다. 에이전트를 만드는 사람은 키의 소유자 또는 관리자이고, 소유자가 게스트면 만들 수 없다.
- **D7. 엔드포인트와 SSRF.** `baseUrl`은 팀 링크 PUT과 같은 `validated_base_url`을 지난다(HTTPS, userinfo·query·fragment 금지, 사설·메타데이터 리터럴과 loopback은 운영자 옵트인). 호출 시점의 연결 가드(`momo-egress`)는 모든 provider 호출에 같다. 단, 연결 가드는 **운영자가 쓴** 호스트(`HERMES_BASE_URL`의 호스트)와 로컬 옵트인(`AGENT_PROVIDER_LOCAL_HOSTS`·loopback)을 주소 검사에서 면제한다. 워크스페이스 관리자가 개인 키로 그 호스트를 겨냥하면 운영자 네트워크로의 SSRF가 되므로, 그 호스트는 개인 키에 쓸 수 없다: 발급은 400이고 워커도 같은 판정으로 그 턴을 거절한다(둘 다 `EgressPolicy::host_exempt`). 수정 경로가 없어서 저장된 키가 편집된 URL을 따라 다른 origin으로 가지 못한다(증보 2026-09-28과 같은 이유). origin을 바꾸려면 회수와 재발급이다.
- **D8. API·감사.** `POST/GET /v1/workspaces/{ws}/personal-keys`, `GET …/mine`, `POST …/{key}/revoke`, `POST …/{key}/agent`(소유자 또는 관리자가 그 사람의 개인 에이전트를 만든다). 키는 쓰기 전용(`apiKey`)이고 어떤 응답·감사·로그에도 나오지 않는다. 응답은 id·소유자·형식·가린 endpoint label·label·상태·시각이다. 감사 `provider.personal_link.issued`·`provider.personal_link.revoked`는 id·형식·label만 싣는다(재회수는 감사 행을 늘리지 않는다). OpenAPI에 올렸다.
- **D9. 읽기 계약(AIH-2, ADR-0193 증보 D14).** `brain`에 값 `personal_key`를 더한다: `owner_only`이고 `uses_owner_key`인 에이전트(`derive_brain`이 `owner_only` 안에서 저장된 두뇌 종류로 가른다). `callableBy`는 `owner_only`, `owner`는 `subscription`과 `personal_key` 에이전트에 나온다. `hostOnline`은 나오지 않는다(서버 워커가 돌려서 기다릴 호스트가 없다). `brainUnavailableReason`은 없다. 값이 하나 늘었다. 이 값을 아직 모르는 클라이언트는 `brain`을 닫힌 어휘에서 찾지 못해 `invocationScope = owner_only`에서 추론하므로(`aiHubModel.ts`) 개인 키 에이전트를 구독으로 표시한다. `momo-core`의 `BRAINS`에 `personal_key`를 더하는 일은 UXUI 후속(AIH-6)이고, 서버의 호출·키 해석 동작과는 무관하다.
- **정직한 한계.**
  - 이미 키를 읽은 진행 중 턴은 그 턴이 끝날 때까지 그 키로 돈다. 회수는 다음 턴부터 효력이 있다.
  - 비용 귀속: `usage_ledger`는 에이전트 기준이라 개인 키 에이전트의 사용량도 워크스페이스 집계에 들어간다. 키 출처 컬럼은 없다. 청구 주체는 provider 쪽 키 소유자(조직)다.
  - 환영·hosted 인박스 같은 일부 입구는 `owner_only`를 구독으로 읽는다. 개인 키 에이전트는 그 입구에서 호출되지 않거나(환영) 워커 큐로만 간다. 이 증보가 보장하는 호출 입구는 멘션·1:1 DM·스레드 답글(멘션)·작업 요청이다.
  - UI(발급·회수·내 키 화면)는 AIH-6이다. 멤버 직접 추가 정책 스위치는 열지 않았다.
- **검증.** 격리 PG: `momo-agent-worker/tests/personal_key_conformance_pg.rs`(개인 턴은 소유자 키만, 팀 턴은 개인 키를 못 봄, 다른 사람의 에이전트, 회수는 다음 턴, 읽을 수 없는 키와 OAuth 봉투, 위임·환영 없음, 어떤 행에도 키 없음)와 `momo-server/tests/personal_key_conformance_pg.rs`(발급·목록·회수·인가, 한 키 한 사람, 입력 거부, 개인 에이전트 전달, RLS). 사보타주 기록은 PR 본문.

---

## 증보 2026-10-16 — 에이전트별 키 고정

- Status: **Accepted**. 결재 인용: 성재 2026-10-16 AskUserQuestion — 「Max (크레딧 쓰기)」, 「키+팀 AI 먼저 (추천)」(선택지 문구: 크레딧 API 키를 넣고 팀 AI(oort 도우미)를 켜서 「간단한 요청 1분 안」을 바로 재요. Hermes는 에이전트별 키 고정 기능을 만든 뒤 나란히 붙여요), 「같은 프로젝트·도구 끔 (추천)」(선택지 문구: Hermes를 같은 Railway 프로젝트에 두되 터미널·브라우저 도구를 끄고, oort 비밀값은 주지 않고, 공개 주소도 열지 않아요. 도구 끄기를 확인하기 전에는 올리지 않아요). 관련: ADR-0201(팀 AI는 기본 AI `teamAgent` 행을 따른다), ADR-0004 증보 1(provider_link 봉인)·증보 5(egress 가드), ADR-0135 D1(폴백 없음).
- 기안·구현: Opus 5.5 worker(#3873, 엔진). 짝 UI 이슈: #3875(UXUI).
- **문제.** 에이전트 모델 링크 해석에는 「머리 자리」가 하나다. 저장된 `provider_link`가 env `HERMES_BASE_URL`을 이긴다(`resolve_link`, ADR-0004 증보 1). 그래서 팀 Anthropic 키(팀 AI가 쓴다)와 같은 서버의 Hermes가 한 인스턴스에 함께 살 수 없었다. 체인 hop(위치 1 이상)은 DB 행뿐이라 env 링크를 이름할 수 없다. 팀 기본을 바꾸지 않고 에이전트 하나만 다른 링크로 보내는 방법이 없었다.
- **D1. 그릇: `agent_provider_pin`(migration 136).** 에이전트당 최대 한 행(`agent_member_id` PK, 에이전트 삭제 시 cascade). 행이 없으면 지금과 같다(팀 기본을 따른다). 한 행은 **링크 참조뿐**이다: 키·봉투·URL·경로·토큰 칸이 없다. 종류는 둘이다.
  - `operator_env`: 운영자 env 링크(`HERMES_BASE_URL`·`HERMES_API_KEY`). 위치·라벨이 없다. 「운영자가 정한 그 링크」가 뜻이다.
  - `team_link`: 캐스케이드 위치 + 고를 때의 가린 endpoint label. **위치 0은 저장된 `provider_link` 자체**이고 env 폴백이 아니다. 기본 AI 행의 위치 0은 「머리」(DB가 없으면 env)지만, 핀은 그 모호함을 물려받지 않는다. 저장된 링크가 사라지면 머리가 env로 떨어지고, 위치 0 핀은 거기로 따라가지 않고 거절된다. env는 `operator_env`로만 이름한다. 위치 1 이상은 `provider_link_chain` hop이다. `PUT …/chain`이 hop을 지우고 다시 넣으므로 위치는 안정된 id가 아니다. 라벨 스냅샷이 「그 위치가 다른 provider를 가리킨다」를 알아채게 한다(ADR-0147 증보 2026-09-28과 같은 이유).
  - RLS ENABLE+FORCE. 읽기는 워크스페이스 정책(프로필 화면이 핀을 보인다), **INSERT·UPDATE·DELETE는 워크스페이스 일치 AND `app.provider_link_admin = 'on'`**이다. 그 GUC는 라우트가 인스턴스 운영자 게이트를 통과한 뒤에만 `with_provider_link_admin_tx`로 켠다. 그래서 라우트 게이트가 빠져도 일반 테넌트 트랜잭션은 이 표에 쓰지 못한다. 전 테넌트 worker(BYPASSRLS)가 읽는 것은 `provider_link`·`personal_provider_link`와 같은 기존 예외이고, 새 BYPASSRLS 경로는 없다. schema_v0.sql은 건드리지 않는다.
  - 트리거: 핀은 에이전트와 같은 워크스페이스여야 하고, `owner_only` 에이전트(구독 또는 소유자의 개인 키; ADR-0193 D4, 위 증보 2026-10-03)에는 걸 수 없다. 에이전트 `config`·payload에 핀을 두지 않은 이유는 쓰기 권한을 DB가 지키게 하기 위해서다(`agent`의 일반 UPDATE 경로는 운영자 GUC 정책 밖이다).
- **D2. 쓰기: 인스턴스 운영자 전용.** `PUT /v1/workspaces/{ws}/agents/{agent}/provider-pin`은 `require_instance_operator_write`(워크스페이스 owner/admin이면서 검증된 이메일이 `PLATFORM_ADMIN_EMAILS`에 있는 사람; `platform:read` 스코프는 읽기 스코프라 부족하다), `GET`은 `require_instance_operator`다. 핀은 **인스턴스 전역 자격** 중 하나를 고르는 일이라 워크스페이스 관리자나 에이전트 소유자의 권한이 아니다. 위치 목록은 운영자만 본다(`GET /v1/provider/default-ai`와 같다). 본문은 닫혀 있다(`deny_unknown_fields`): `{ "kind": "default" | "operator_env" | "team_link", "linkPosition"? }`. `default`는 핀을 지운다(`owner_only` 에이전트에서도 허용: 돌아오는 길). 게이트가 본문 검증보다 먼저다. 에이전트 bearer는 이 경로에 닿지 못한다(에이전트 라우트 허용 목록 밖).
  - 400: 설정되지 않은 위치(위치 0은 저장된 링크가 없으면 400), 서버에 env 링크가 없는데 `operator_env`, 모양이 틀린 본문.
  - 409 `owner_only_agent_cannot_be_pinned`: `owner_only` 에이전트. 409 `agent_own_model_required`: `team_link`는 에이전트가 자기 모델을 가질 때(`modelSource = agent`)만. D4에서 핀이 걸린 에이전트에는 팀의 「기본 AI」 행을 적용하지 않으므로, `instance_default` 에이전트가 자리표시자 모델 이름(`hermes-agent`)으로 팀 provider를 부르는 일을 막는다. `operator_env`에는 이 조건이 없다(Hermes의 모델 이름이 그 자리표시자다).
  - 감사 `agent.provider_pin.updated`: 종류·위치·가린 label·이전 값만. 키·URL은 없다.
  - `GET` 응답은 `pin: null | { kind, linkPosition?, endpointLabel, linkResolved, pinnedBy, updatedAtMs }`. `linkResolved: false`는 「고른 링크가 사라졌거나 바뀌었다」이고 worker가 그 에이전트의 턴을 거절한다. 기본 AI 응답의 `linkResolved`와 같은 말이다.
- **D3. 에이전트 하나만 바뀐다.** 팀 기본 AI(ADR-0201의 `teamAgent` 행, 요약 행, 팀 AI 에이전트)는 건드리지 않는다. 팀 AI 에이전트 멤버를 핀으로 옮기지 않는 한 팀 키를 계속 쓴다.
- **D4. worker는 매 턴 핀을 에이전트 행에서 읽는다.** payload가 아니다. 그래서 큐에 들어간 뒤에 건 핀도 그 턴에 적용되고, payload 위조·구버전 잡의 영향을 받지 않는다. 순서: 개인 키 문(owner-key)이 먼저이고 그 턴은 핀을 읽지 않는다. 다음 **핀**, 그다음 `provider_is_configured`(핀이 없을 때만), 그다음 「기본 AI」 행(핀이 없을 때만).
  - 핀이 있으면 **팀 해석을 대체**한다. 겹쳐 쓰지 않는다. 머리 링크도, 다른 hop도, env도(`operator_env` 외에는), 「기본 AI」 행도 이 턴에 쓰이지 않는다. 모델은 `agent.model` 그대로다(「기본 AI」 행의 모델 id는 팀 링크의 것이다).
  - `operator_env`: env 링크에 base URL이 있고 키가 진짜일 때(`key_configured`: 비어 있지 않고 개발용 자리표시자가 아님)만. 저장된 DB 링크가 있어도 보지 않는다. 그게 핀의 목적이다.
  - `team_link` 0: `provider_link` 자체. 머리가 env로 떨어졌으면 거절. 라벨이 다르면 거절. 키가 쓸 수 없으면 거절.
  - `team_link` 1 이상: 그 hop. 위치가 없거나, 라벨이 다르거나, 꺼졌거나, 키가 열리지 않으면 거절.
  - 읽을 수 없는 종류의 행(미래 버전의 값)은 「핀 없음」이 아니라 거절이다.
  - DB 오류로 핀을 읽지 못하면 추측하지 않고 재시도한다.
  - **웰컴.** 첫 인사는 팀의 목소리(요약 행, 팀 링크)다. 핀이 걸린 에이전트는 환영하지 않고(`pinned_no_welcome`) 팀 링크를 쓰지 않는다. 개인 키 에이전트의 규칙과 같다.
- **D5. egress 규칙은 그대로다.** 관리자는 URL을 쓰지 않는다. 핀은 이미 `validated_base_url`을 지난 hop을 이름하거나 운영자 자신의 env 호스트를 이름할 뿐이다. 운영자 env 호스트가 연결 가드의 주소 검사에서 면제되는 유일한 사설 호스트(`EgressPolicy::host_exempt`)라는 사실, 개인 키가 그 호스트를 겨냥할 수 없다는 규칙(위 증보 2026-10-03 D7)은 바뀌지 않는다. 핀은 면제를 넓히지 않고, 면제된 호스트로 가는 길을 「운영자가 인정한 인스턴스 운영자 한 명이 고른 에이전트」로 좁혀 둔다. 호출 경로는 기존 worker의 가드된 클라이언트다.
- **D6. 정직한 실패.** 핀이 풀리지 않으면 모델을 부르지 않는다: 다른 링크·다른 모델·환경 폴백 없음(ADR-0135 D1, #3041·#3396과 같은 규칙). 실행은 `failed`(`error.code: pinned_link_unresolved`), 채널에는 #2871 시스템 줄(`props.reason: pinned_link_unresolved`, 문 「AI 연결 열기」, 문장은 「…에 고정해 둔 AI 연결을 쓸 수 없어서 답하지 못했어요. 다른 연결로 대신 답하지 않았어요. 운영자가 AI 화면에서 이 에이전트의 연결을 다시 고를 수 있어요.」), 운영자 audit `agent.provider_pin.unresolved`(종류·위치·저장 label·현재 label·고정 사유 라벨만; URL·키 없음). 사유 라벨: `operator_env_not_configured`·`team_link_missing`·`team_link_changed`·`team_link_disabled`·`team_link_unusable`·`pin_malformed`·`unknown_pin_kind`.
- **배포 메모.** `HERMES_BASE_URL`·`HERMES_API_KEY`는 API와 worker가 같은 값을 가져야 한다. API는 「env 링크가 있는가」와 라벨을, worker는 호출을 맡는다. 같은 서버 Hermes의 감지·연결 흐름은 별도 ADR(초안 #3874)이다. Hermes 도구 끄기를 확인하기 전에는 올리지 않는다는 결재는 이 증보가 바꾸지 않는다.
- **정직한 한계.**
  - 위치는 안정된 id가 아니다. `PUT …/chain`으로 hop이 바뀌면 핀은 거절 상태가 되고 운영자가 다시 골라야 한다(조용히 따라가는 것보다 낫다고 결정했다).
  - 핀이 걸린 에이전트는 팀의 「기본 AI」 모델 선택을 따르지 못한다. 자기 모델을 가져야 한다.
  - `team_link`는 라벨(스킴·호스트·포트·경로)로만 같은 링크인지 판단한다. 같은 라벨 아래 키만 교체되거나, 같은 호스트의 두 hop 순서를 바꾸면 핀이 조용히 다른 키로 따라간다. 라벨은 키 지문이 아니다. 키 지문을 함께 두는 것은 후속으로 남긴다(독립 검수 M1, 위험 = 비용·키 귀속뿐, 권한 확대는 아니다).
  - `GET`의 `linkResolved`는 라벨 일치와 hop의 켜짐까지만 본다. 키가 열리는지·자리표시자인지는 worker만 안다(그 경우 worker는 `team_link_unusable`로 거절한다).
  - 채널 요약·기억 통합 루프는 핀과 무관하게 팀 머리 링크와 요약 행을 쓴다. Hermes에 고정한 에이전트의 채널 내용도 요약 단계에서는 팀 키로 간다(독립 검수 L4). Hermes 대화를 팀 키 밖에 두려면 요약 제외가 따로 필요하다.
  - 풀리지 않는 핀에 계속 메시지를 보내면 거절된 턴마다 audit 행이 하나씩 쌓인다(채널 줄은 throttle이 있다). 기본 AI 행의 `provider_default_ai.unresolved`와 같은 기존 패턴이다.
  - 웰컴은 핀이 걸린 에이전트에게 생략된다. 첫 인사가 필요한 에이전트를 핀으로 옮기려면 별도 결정이 필요하다.
  - 사용량 원장은 에이전트 기준이다. 핀이 가리킨 링크의 비용 귀속(Hermes vs 팀 키)은 원장에 컬럼으로 남지 않는다.
- **범위 밖.** 에이전트 설정의 연결 선택기 UI와 거절 줄의 클라이언트 처리(#3875, UXUI). 같은 서버 Hermes 감지(#3874). Hermes 컨테이너 배포와 도구 끄기 확인.
- **검증.** 격리 PG(`pgvector/pgvector:pg18`): `momo-agent-worker/tests/agent_pin_conformance_pg.rs`(팀 키가 저장된 채 핀 에이전트는 Hermes·팀원은 팀 키, 위치 0·1 핀, 풀리지 않는 여섯 경우 모두 호출 0과 폴백 없음, 웰컴 생략, 해석기가 개인 자격을 이름하지 않음)와 `momo-server/tests/agent_provider_pin_conformance_pg.rs`(양 동사 운영자 전용, 쓰기·해제·감사, 닫힌 본문, `owner_only` 거절, 테이블 쓰기는 운영자 트랜잭션에서만, 테넌트 격리). 사보타주 기록은 PR 본문.

## 증보 2026-10-16 — 키 확인 결과와 「한도·남은 크레딧」

성재 결재(2026-10-16): 「API 키 발급받았어. API 키 연동하는 부분과 키 확인 및 verification으로 유효한 키인지 확인하는 절차. 그리고 해당 키 기준으로 한도 및 현재 크레딧이 얼마 남았는지 등을 보여주는 인터페이스까지 작업해줘.」 성재는 Claude Max 구독자가 받는 월간 API 크레딧(2026-10-07~, Max 5x $100/월, 이월 없음)을 Console 조직의 일반 API 키로 쓴다. OpenAI·OpenRouter 키도 같은 방식이다. 이슈 #3886(엔진)·#3887(UXUI). 구현은 새 병행 경로가 아니라 위 증보 2026-09-27 「연결 확인」(#2960)의 확장이다.

- **D1. 확인 결과는 닫힌 어휘에 한 칸이 는다: `provider_no_credit`.** 기존 `ok`/`rejected`/`unreachable`/`rate_limited`/`unknown`에 `no_credit`을 더한다. 402, 또는 400·401·403·429 응답 본문이 결제 문제를 말할 때(Anthropic 문서의 `billing_error`와 문장 「credit balance is too low」, OpenAI의 `insufficient_quota`·`credit_balance_exhausted`)다. 본문은 **분류에만 쓰고 버린다**: 응답·로그·감사 어디에도 공급사 글자가 나가지 않는다(기존 규칙 그대로, 키를 되풀이하는 공급사로 시험). cascade 판정은 바꾸지 않는다 — `provider_no_credit`은 `propagate`이며 fall-over 사유가 아니다(알 수 없는 사유는 다음 공급사로 넘기지 않는다는 `classify_probe_reason`의 기존 원칙). 정직한 한계: `GET /models`는 크레딧이 없어도 200일 수 있다(문서에 없음, runtime-unverified). 「키가 유효하다」는 「돈이 남아 있다」가 아니다. 화면이 이를 말한다.
- **D2. OpenRouter는 `GET /credits`를 한 번 더 읽는다.** `/key` 성공 뒤에 같은 가드된 클라이언트·같은 자격·같은 호스트로 `GET {base}/credits`. 이 엔드포인트는 **관리 키**만 읽는다(공식 문서: 일반 키는 403). 일반 키가 401/403을 받으면 `accountCreditNeedsManagementKey: true`만 싣고 잔액은 싣지 않는다. 다른 실패는 잔액 모름이며 키의 판정을 바꾸지 않는다. 키 응답에는 `usageMonthly`·`isFreeTier`도 더한다(`/key`가 일반 키에게 주는 값).
- **D3. Anthropic·OpenAI의 남은 크레딧은 일반 키로 읽을 수 없다 — 읽는 척하지 않는다.** Anthropic은 크레딧 잔액·Max 프로모션 크레딧을 Console(Billing)에서만 보여 주고, 사용·비용 보고서(`/v1/organizations/usage_report/messages`·`cost_report`)는 관리자 자격이 필요하며 그 보고서도 **지출만** 보이고 잔액은 없다. OpenAI도 공개 잔액 엔드포인트가 없고 비용 API는 관리자 키다. 그래서 화면은 읽을 수 있는 것만 보인다: ① 확인 호출이 받은 한도 헤더(`anthropic-ratelimit-*`·`x-ratelimit-*`; 두 공급사 모두 `GET /models`가 이 헤더를 주는지 문서에 없다 — 없으면 「이 확인 호출은 한도 숫자를 주지 않았어요」로 정직하게 비운다), ② **oort 추정**: 운영자가 적은 월 크레딧(D4)과 이번 달 oort 지출 추정의 비교, ③ Console 결제 링크.
- **D4. 운영자가 적는 「월 크레딧」: `provider_key_budget`(migration 137).** 회사(`anthropic`|`openai`|`xai`|`openrouter`)당 한 줄, 인스턴스 전역, 숫자 하나(micro-USD, 0~$1,000,000). 키·봉투·URL 칸이 없다. RLS ENABLE+FORCE, **읽기·쓰기 모두 `app.provider_link_admin = 'on'`**(라우트가 인스턴스 운영자 게이트 뒤에서만 켠다). 새 라우트 `GET /v1/provider/limits`(운영자 게이트), `PUT /v1/provider/limits/budget`(같은 게이트, 닫힌 본문, 감사 `provider_key_budget.updated` — 회사와 금액만). 지출은 `usage_ledger` 토큰 × `model_pricing`을 **읽을 때** 계산한다: 팀 AI worker는 `cost_micro_usd = 0`·`was_estimated = true`로 기록하고(쓰기 경로는 이번에 바꾸지 않는다), 가격 일치는 `vendor/` 접두 제거·점→대시 뒤 가장 긴 접두 행, 워크스페이스 행이 전역 행을 이긴다. 회사 분류는 모델 id 모양이다(원장에 공급사 칸이 없다): `vendor/model`=OpenRouter, `claude-*`=Anthropic, `gpt-*`·`o<숫자>*`=OpenAI, `grok*`=xAI. 단가가 없는 모델의 실행은 횟수에만 세고 **달러에 넣지 않으며** 모델 이름을 응답에 싣는다(최대 8개). 응답 필드 이름이 `spendEstimate`이고, 화면은 이를 「oort 추정」이라 부르며 공급사 잔액이라 부르지 않는다.
- **D5. `model_pricing` 시드.** 전역 행(workspace_id NULL, `effective_from` = 2026-01-01 — 이번 달 초의 실행에도 단가가 적용되도록)으로 현행 Anthropic 모델(`claude-fable-5-1`·`-fable-5`·`-opus-5-5`·`-opus-5`·`-opus-4-8/4-7/4-6`·`-sonnet-5-5`·`-sonnet-5`·`-sonnet-4-6`·`-haiku-4-5`). 출처는 Anthropic 가격표(claude-api 스킬의 2026-09-25 캐시본)이며 캐시 쓰기는 입력의 1.25배, 캐시 읽기는 공개된 값(Opus 5.5·Sonnet 5.5 $0.20, Fable 5.1 $0.25), 그 밖은 입력의 0.1배다. OpenAI·xAI·OpenRouter 모델은 가격을 확인하지 못해 시드하지 않았다 — 화면이 「단가 없음」으로 말한다.
- **D6. Admin 키 저장은 이번에 하지 않는다.** 성재의 요청은 키 확인과 한도·크레딧 표시이고, Anthropic Admin 키(`sk-ant-admin…`)는 조직 구성원·키 관리까지 닿는 상위 자격이다. 그 키로도 읽을 수 있는 것은 **지출**이지 남은 크레딧이 아니다(위 D3). 얻는 것이 작고 새 신뢰 경계가 크므로, 성재의 별도 결재 없이는 저장·사용하지 않는다(질문으로 보고).
- **D7. 보안.** 모든 새 경로가 키를 읽거나 되돌리지 않는다: 응답은 공급사가 밝힌 숫자와 oort의 계산 숫자뿐이다. `provider_key_budget`은 자격 물질이 없다. 신규 egress는 `/credits` 한 호출뿐이고 기존 `EgressGuard` 위에 있다(리다이렉트 없음·프록시 없음·주소 검사).
- **정직한 한계.** ① 회사 분류가 모델 id 모양이라 같은 회사의 두 키(체인)는 같은 지출 숫자를 공유한다. ② 지출은 이 워크스페이스의 원장이다 — 같은 키를 다른 워크스페이스·Claude Code 직접 사용이 쓴 몫은 보이지 않는다(그래서 「Console 값이 정본」이라고 화면이 말한다). ③ 캐시 쓰기 토큰은 원장에 따로 없어 입력 단가로 센다(약간 낮게 추정). ④ Max 월간 크레딧은 조직 단위로 공유되고 이월되지 않는다 — 월 경계는 UTC 달력월이고 구독 결제 주기와 어긋날 수 있다. ⑤ 월 크레딧은 인스턴스 전역 한 숫자인데 지출은 운영자가 속한 워크스페이스의 원장이라, 워크스페이스가 여럿인 인스턴스에서는 견주는 값이 일부만 센 것이다(화면이 「이 워크스페이스에서」라고 말한다). ⑥ 예산 쓰기는 `require_instance_operator_write`(읽기 스코프로는 불가), 읽기는 `require_instance_operator`다. ⑦ migration 번호 137은 병렬 PR과 겹치면 병합 때 재번호가 필요하다.

---

## 증보 2026-10-19 — Hermes가 보관하는 구독 OAuth

- Status: **Accepted** (2026-10-19, owner 결정 인용). 인용(이슈 #4071, 성재 2026-10-19): 「우리 메신저 대신 hermes oauth로 할때 왜 그게 ADR이 금지한 길이야. 이건 업계에서도 허용된 부분인데. 그냥 해당 ADR금지 부분을 제거해. 당장에 필요하다면 codex oauth로 하고, claude oauth까지 처리할거야. 제로 베이스 온보딩 개선 묶음도 진행 ㄱㄱ 하자.」
- 기안: Sonnet 5.5 worker(#4071)

- **허용한다.** 운영자가 호스팅하는 Hermes(셀프호스트·클라우드 포함)가 **자기 볼륨에** 보관하는 Codex(ChatGPT 구독)·Claude(구독) OAuth 토큰으로 모델 인증을 하는 경로. 로그인과 갱신은 Hermes 자체 흐름이 하고, 절차는 #4073(Hermes 모델 인증 온보딩)이 정한다.
- **oort 쪽 경계는 그대로다(ADR-0004).** oort 서버·api·agent-worker·provider_link 금고·DB·로그·감사·매니페스트는 구독 OAuth 토큰(access·refresh)을 받지도, 저장하지도, 중개하지도, 기록하지도 않는다. 일회용 인가 code·기기 코드는 로그인 중계(ADR-0203 증보 「Hermes 로그인 중계」, ADR-0004 증보 7)에서 저장·로그 없이 1회 중계만 한다. 금고에 구독 OAuth kind를 더하지 않는다. oort가 Hermes 접속에 쓰는 자격은 불투명 bearer(`HERMES_API_KEY`) 하나뿐이고 모델 인증 자격이 아니다(대화 내용은 Hermes로 가지만 구독 토큰은 oort를 지나가지 않는다).
- **사용량과 약관.** 구독 사용량은 그 Hermes **소유자의 구독**에서 나간다(팀원이 Hermes를 불러도 같다). 벤더 약관의 적합성 판단과 책임은 **운영자 몫**이고, oort는 판단하거나 보증하지 않는다. 이 증보 이전의 약관 판단(제3자가 claude.ai 로그인을 제공하거나 토큰을 수집·저장·중개할 수 없다)은 **oort가 하는 일**에 대한 것으로 그대로 남고, Hermes가 자기 볼륨의 구독으로 인증하는 경로의 적합성은 운영자가 판단한다.
- **적용되지 않는 것(별개 경로).** oort 서버가 구독 CLI를 대신 구동하는 경로를 막는 ADR-0193 D6·D17·D18과 공용(워크스페이스·클라우드) work host 차단(`MOMO_SUBSCRIPTION_AGENTS_ENABLED`, `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`, `claude_subscription_agent_paused`)은 **Hermes 경로에는 적용되지 않는다.** 이 증보는 그 코드 동작을 바꾸지 않는다. 서버 내장 구독 에이전트 차단을 풀지는 별도 확인이 필요하다(owner 미결정).
- **정정되는 곳.** 증보 2026-09-26의 「Claude(Pro·Max) 구독 토큰은 어떤 경로로도 금고에 넣지 않는다」와 「구독은 개인 경로로만 쓴다」는 원문 그대로 두고, 적용 범위를 oort 금고·oort 서버가 구동하는 경로로 좁힌다. 「금고에 구독 OAuth kind를 새로 더하지 않는다」「`oauth-openai` 새 링크 생성 불가」는 **유지**한다.


---

## 증보 2026-10-30 — 에이전트 비용과 개인 보임 경계 (#4781)

- Status: **Accepted**. 읽기는 멤버 전원이며 관리자 전용 라우트를 만들지 않는다는 owner 결정(2026-10-30)을 따른다. 보임 모델 A는 리서치 초안에서 **Proposed**였으나 [이슈의 후속 owner 승인](https://github.com/yeomyeonggeori/oort/issues/4781#issuecomment-6510851651)으로 확정됐다. 이 승인 이전의 패킷에 남은 「owner 답 대기」를 대체한다.
- 구현 경계: S2 서버·DB·OpenAPI, S3 코어 표시 모델·웹·데스크탑·폰. 정본 공개 JSON은 [OpenAPI](../api/openapi.yaml)의 `AgentUsageResponse`다.

### D1. 누구나 읽되 모델 A로 거른다

`GET /v1/workspaces/{ws}/usage/agents?from&to`는 활성 워크스페이스 멤버가 읽는다. 공동은 명부의 `AgentReadFacts.callable_by=everyone`, 개인은 `owner_only`다. 관리하는 사람이 채워졌다는 이유로 공동을 개인으로 분류하지 않는다. 일반 멤버는 공동 전부와 자기 개인 에이전트만 읽고, 남의 개인 에이전트는 행·모델·토큰·금액 없이 `hiddenPersonalAgents` 개수만 받는다. 게스트는 명부의 공유 채널 필터를 먼저 적용하며, 숨긴 개수에도 그 명부 밖 에이전트를 넣지 않는다. owner/admin은 전부 읽는다.

응답은 에이전트마다 `agentMemberId`와 `runs`, `reportedRuns`, `promptTokens`, `completionTokens`, `cachedTokens`, `costMicroUsd`, `unpricedRuns`, `unpricedModels`(최대 8개), `estimatedRuns`, `source`, 선택적인 `subscriptionFee`다. 이름·소유자·brain은 응답에 복제하지 않고 명부에서 결합한다. 관리자 소유자별 묶음도 같은 명부의 owner를 쓴다. 채널별·run별·일별 계열·글 내용은 이 응답에 없다. `totals`는 `mine`과 `shared`이며 **owner/admin만** `workspace`를 추가로 받는다. 일반 멤버에게 전체 합계를 주면 차집합으로 개인 비용이 새므로 주지 않는다. RLS는 워크스페이스 격리, 보는 사람별 필터는 라우트의 공통 순수 판정이 맡는다.

### D2. 기존 usage/summary에도 같은 필터를 적용한다

`usage/summary`의 비관리자 응답은 `byAgent`만 줄이는 것이 아니라 `totals`, `buckets`, `byModel`까지 **보이는 에이전트의 행으로 다시 계산**한다. 전체 예산의 spent/reserved도 숨긴 비용을 드러내므로 `budget` 필드는 빼고 `scope: "visible"`을 추가한다. 관리자는 기존 응답 모양(이름 포함, `budget: null` 포함)과 원장에 기록된 달러 집계 의미를 유지한다. 새 `usage/agents`가 목록 단가로 계산한 금액과 기존 summary의 기록 금액은 서로 다른 의미다. S3는 비용 열에 새 계약을 쓰고, 기존 사용량에 「내가 볼 수 있는 범위 기준」을 표시한다.

### D3. 정확·추정·자기 보고·구독 표지

표지는 출처와 완전성 두 축이다. `source=measured`이며 `estimatedRuns=0`, `unpricedRuns=0`이면 토큰은 공급사에서 직접 받은 숫자다. `estimatedRuns>0` 또는 `unpricedRuns>0`이면 추정·부분이며 달러는 「이상」으로 표시한다. `source=self_reported`이면 에이전트가 알려 준 숫자로 oort가 검증하지 못했다. 혼합 행의 source는 자기 보고가 이기며 표시 우선순위는 자기 보고 > 추정 > 정확이다. `subscriptionFee`는 별도 월 정액이며 API 상당액에 더하지 않는다. 원장 행이 없는 에이전트는 `runs=0`, `source=null`이라 「측정한 0원」과 구별된다. `runs`는 해당 기간에 원장이 생긴 완료 실행 수, `reportedRuns`는 토큰 수를 알린 실행 수(직접 측정한 명시적 0 포함)다.

### D4. 원장 출처와 읽을 때 계산하는 단가

migration **157**은 `usage_ledger.source`에 nullable text와 `measured`/`self_reported` CHECK를 더한다. 새 워커 행은 measured, Agent Port와 REST 완료 콜백은 self_reported다. 외부 본문으로 출처를 지정하지 못한다. REST의 음수 토큰·음수 비용 보고는 원장 쓰기 전에 400으로 거절한다. 옛 NULL 행은 현재 명부 brain으로 추론한다(외부·구독=self_reported, 팀 키·개인 키·기본 AI=measured). 과거 출처를 확정하는 backfill은 하지 않는다. `oort_run_complete`의 usage 설명은 토큰 수만 보내고 재지 못한 수는 비우며, oort가 단가를 곱해 자기 보고로 표시한다고 안내한다.

새 에이전트 비용은 원장의 비용 주장 대신 **토큰 × 해당 시점의 model_pricing USD 단가**로 읽을 때 계산한다. 단가 없는 행은 작업·토큰에 세되 달러에 넣지 않고 `unpricedRuns`와 모델 목록에 남긴다. 워크스페이스 단가가 전역 단가보다 우선하고 모델의 vendor 접두 제거·점→대시 정규화 뒤 가장 긴 접두 단가를 고른다. 캐시 읽기는 캐시 단가, 나머지 입력과 출력은 각 단가다. migration 157은 `source_url`·`verified_on` 열과 확인한 OpenAI·xAI 시드를 더한다. 출처는 [OpenAI 공식 가격표](https://developers.openai.com/api/docs/pricing), [xAI 공식 가격표](https://docs.x.ai/developers/pricing), [Grok 4.1 Fast](https://x.ai/news/grok-4-1-fast), [Grok 4 Fast](https://x.ai/news/grok-4-fast)다. 확인일 2026-10-30, 시드 적용 시작은 이번 UTC 월초이며 과거 가격 이력이라고 주장하지 않는다.

### D5. 공유 에이전트의 월 정액 설정

`agent_subscription_fee`는 `agent_member_id` PK, `workspace_id`, `monthly_micro_usd`, `label`, `updated_by/at`를 가진다. RLS ENABLE+FORCE이며 같은 워크스페이스만 읽고, 별도 transaction-local 쓰기 게이트 뒤에서만 쓴다. `PUT /v1/workspaces/{ws}/agents/{agent}/subscription-fee`는 **사람인 워크스페이스 owner/admin**만 허용한다. platform 읽기 스코프로 우회하지 못하고 에이전트 bearer는 403, `owner_only`는 409다. 금액은 0~1,000,000 USD/월, label 최대 120자, 닫힌 본문이다. `monthlyMicroUsd=null` 또는 생략은 해제다. 감사 `agent.subscription_fee.updated`의 detail은 금액만 남기며 label은 남기지 않는다. 읽는 비용과 총합에 정액을 더하지 않는다.

### D6. 메신저 활동 통계와 요청자별 비용은 범위 밖

#4346의 관리자 전용 개인 활동 통계 결정은 메신저 통계에 한정된다. 비용 읽기에 빌려 오지 않는다. 원장에는 요청자 열이 없으므로 이 계약의 소유자별 비용은 개인 에이전트를 owner로 묶은 값이다. 「누가 팀 AI를 많이 불렀나」를 계산하거나 그렇게 표시하지 않는다.

### D7. 정직한 한계와 검증

달러는 공급사의 청구서·잔액이 아니라 공개 단가로 구한 상당액이며 공급사 콘솔이 정본이다. 새 읽기의 기본 창은 **UTC 달력월의 월초~지금**, 명시한 from/to는 기존 summary와 같은 양끝 포함·최대 93일이다. 기존 summary의 기본 최근 30일은 호환을 위해 유지한다. 개인 구독(내 맥)은 원장 행이 없어 토큰을 재지 못한다. 캐시 쓰기는 원장에 별도 수가 없어 일반 입력 단가로 계산한다. 구독 정액은 현재 설정이며 월별 이력이 아니다. 옛 NULL source는 현재 brain에 따른 추론이고, 토큰이 모두 0인 옛 행은 무보고와 명시적 0을 항상 구별하지 못한다. 지역·서비스 등급·서버 도구 요금·할인 등 청구 조정은 원장에 없으므로 포함하지 않는다. xAI 장문 구간(현행 시드 200k, Grok 4 Fast 128k 이상)에 닿는 원장은 여러 요청의 합일 수 있어 요청별 배수를 복원할 수 없다. 기본 단가 상당액만 계산하고 `estimatedRuns`로 추정·하한임을 표시하며, 합계 토큰에 장문 배수를 곱하지 않는다. 잘못된 옛 REST 토큰 차원은 음수를 0으로, 캐시를 입력 이하로 제한해 계산하고 추정으로 표시한다.

실 PG 수용 시험은 `agent_usage_conformance_pg.rs`의 9건(멤버·관리자 보임, 합계 누출, 게스트, 워크스페이스, 단가 없음, 정액 분리, 쓰기 권한, source/옛 행, 관리자 summary 호환)이다. 워커·Agent Port·REST 완료의 기존 실 PG 시험에서 각각 원장 source를 검증한다. 보임/집계/게스트/워크스페이스 조건/단가 없음/정액 합산/쓰기 권한/source를 변조해 회귀 시험이 실패하는지 별도로 확인한다. 실제 공급사 청구 대조와 S3 화면은 스택 검증 범위다.
