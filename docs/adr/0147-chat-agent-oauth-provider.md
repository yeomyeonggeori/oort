# ADR-0147: 채팅 에이전트 provider에 구독 OAuth 수용 — GPT OAuth 우선

- Status: **Accepted** (2026-08-02 성재 — "앤트로픽 키 안 쓰고 gpt oauth 사용" 지시 + 제안 승인 "ㄱㄱ". 기안 Fable)
- 관련: ADR-0004(+증보 1 — provider_link 봉인 계약이 이 결정의 그릇), ADR-0144(코딩 에이전트=sandbox-internal login — **무변경 유지**), ADR-0113(커넥터 경계 — 참조), ADR-0146(provenance), B5.1(agent-worker)·B4.2(provider link REST)
- 증보: 2026-09-26 온보딩 2.0(ADR-0193 Q2) — 구독 OAuth 서버 금고를 확장하지 않는다. 팀 에이전트는 API 키가 기본이다. 파일 끝 「증보 2026-09-26 — 온보딩 2.0」 절
- 증보: 2026-09-27 Anthropic Messages wire(#2872) — 세 번째 wire와 봉인 박스 `anthropic-key` kind, `format` 필드, 오류의 키 제거 규칙. 파일 끝 「증보 2026-09-27 — Anthropic Messages wire」 절
- 증보: 2026-09-27 AI 계정(#2876) — 설정 화면에서도 `auth.json` 붙여넣기로 새 링크를 만들 수 없다. 「증보 2026-09-26」 절 끝 한 줄
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
