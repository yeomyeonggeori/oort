> [Fable 검수 2026-08-22] RA-3 서브에이전트 산출을 검수 승격. 채택 판정: ①Anthropic=구독 토큰 서드파티 사용 명시 금지(2026-04 빌링 집행), 유일 예외=미개조 Claude Code 바이너리+사용자 직접 로그인 ②OpenAI=아이덴티티만 공식, 추론 회색지대 ③xAI=유일 공개 권장(단 client 등록 프로그램 미문서화 — 파트너 문의 선행) ④OpenRouter=최청정(PKCE·등록 불요) ⑤aside는 UX 벤치마크로만, 약관 준거 인용 금지. oort v1 게이트는 E3(그록봇 합류=구독 연동) 유지 — 이 문서는 v1.5+ 내장 AI(T-8) ADR 입력. ADR-0004(자격 비유입)와 정합: 구독 자격증명은 클라이언트 로컬에만, 서버 비유입. 모계획: 2026-08-22-aside-onboarding-three-axis-plan.md

# RA-3 — 서드파티 앱의 "사용자 기존 AI 구독" 추론 백엔드 연결: 기술 경로와 약관 리스크

- 작성: 2026-08-22 / 리서치 에이전트 RA-3
- 발주: oort 온보딩 "구독 연결 or BYOK" (aside.com 스타일) 검토
- 경계 준수: 약관·정책은 원문 URL + 조항 인용. 확증 없는 것은 **[추정]** 표기. private API 리버스 없음(공개 문서·공식 발표만).

---

## 0. TL;DR (경영 요약)

1. **"구독 연결"은 provider마다 법적 의미가 완전히 다르다.** 하나의 UX 카피로 묶으면 Anthropic에서 약관 위반이 된다.
2. **Anthropic = 명시적 금지.** 2026-02 문서 명문화 + 2026-04-04 빌링 집행 완료. 서드파티 하네스가 Pro/Max 구독 토큰으로 추론하는 경로는 죽었다. **단, 우회가 아닌 "정식 예외" 경로가 문서에 명시돼 있다 — 미개조 Claude Code 바이너리 호스팅(§1.4). 이게 이번 리서치 최대 수확.**
3. **xAI = 유일하게 provider가 공개적으로 권장.** xAI 공식 뉴스룸이 서드파티 툴(Kilo Code)에서 SuperGrok 구독 OAuth 사용을 직접 홍보. 1차 런칭 타겟이 그록봇 유저인 우리와 정합.
4. **OpenAI = 회색지대.** "Sign in with ChatGPT"는 **아이덴티티 전용(추론 아님)**. Codex 구독 경로는 리더십 공개 지지는 있으나 약관에 허용 문구 없음 → 계약적 보장 0.
5. **OpenRouter = 유일하게 (기술 ○ × 약관 ○ × 마찰 낮음) 3박자 성립.** 클라이언트 등록조차 불필요한 공식 OAuth PKCE.
6. **권고: OpenRouter OAuth를 1순위 "원클릭 연결", BYOK를 상시 폴백, xAI 구독을 2순위(그록봇 타겟), Anthropic은 로컬 Claude Code 브리지로만, OpenAI는 실험 플래그.**

---

## 1. Anthropic / Claude — **명시적 금지 (+ 정식 예외 1건)**

### 1.1 정본 원문

정본: <https://code.claude.com/docs/en/legal-and-compliance>
(구 URL `docs.anthropic.com/en/docs/claude-code/legal-and-compliance` → 301 리다이렉트)

**§ Usage policy > Authentication and credential use** 전문 인용:

> Claude Code authenticates with Anthropic's servers using OAuth tokens or API keys. These authentication methods serve different purposes:
>
> - **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.
> - **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. **Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.**
>
> (…) Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

또한 **§ Acceptable use**:

> Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

보도된 추가 문구(The Register / OpenClaw.report 인용, 문서 개정판 기준):

> "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service."

### 1.2 우리에게 금지되는 것 (명확)

- oort가 자체 하네스로 사용자 Claude 구독 OAuth 토큰을 받아 추론 호출 → **금지**
- oort UI에 "Claude 계정으로 로그인" 버튼을 우리가 구현 → **금지** ("offer Claude.ai login into their own applications")
- 사용자 Claude 세션 토큰을 우리 서버가 수집/저장/중계 → **금지** (ADR-0004 provider 자격증명 비유입과도 정확히 충돌하는 행위이므로, 우리 하드룰이 이미 이걸 막고 있었음)
- Agent SDK를 구독 토큰으로 구동 → **명시적으로 금지 대상에 포함됨** (Agent SDK도 API 키 필요)

### 1.3 정책 변화 타임라인 (2025~2026)

| 시점 | 사건 | 근거 |
|---|---|---|
| ~2024-02 | Consumer ToS §3.7에 원론적 문구 존재 (신설 아닌 "명확화"라는 게 Anthropic 입장) | The Register 2026-02-20 |
| 2026-01-09 | Max OAuth의 서드파티 클라이언트 접근 **차단 시작** (기술적 집행) | winbuzzer / alternativeto |
| 2026-02-19~20 | `legal-and-compliance` 문서에 **Authentication and credential use** 절 신설·명문화. 공식 발표 없이 조용한 문서 갱신 | The Register, OpenClaw.report |
| 2026-02-20 | OpenCode가 Claude 지원 제거 — 사유 "anthropic legal requests" | The Register |
| **2026-04-04 12:00 PT** | **빌링 집행 전환.** 서드파티 툴 트래픽이 구독 한도에서 차감되지 않고 extra usage(종량)로 청구. Claude Code 총괄 Boris Cherny가 X로 발표 | The Register 2026-04-06, VentureBeat, TNW |
| 2026-04-17 | 보상 마감: 플랜 1개월분 extra usage 크레딧 / 번들 30% 할인 / 전액 환불 선택 | 상동 |
| 2026-07-14 | 문서 추가 갱신 | 검색 스니펫 |

Anthropic 공식 코멘트(대변인, The Register):
> "Starting April 4, third-party tools will draw from extra usage instead of subscription limits."
> "Using Claude subscriptions with third-party tools isn't permitted under our Terms of Service, and they put an outsized strain on our systems."

Boris Cherny:
> "Our systems are highly optimized for one kind of workload, and to serve as many people as possible with the most intelligent models, we are continuing to optimize that."

> **핵심 시사점:** 집행 방식이 "차단"이 아니라 **"과금 전환"**이었다. 즉 사용자는 계속 쓸 수 있지만 구독 정액이 아니라 종량으로 튄다. 서드파티 앱 입장에서는 *조용한 요금 폭탄*이 사용자에게 터지는 형태 → 제품 신뢰 리스크가 차단보다 오히려 큼.

### 1.4 **정식 예외 — "미개조 Claude Code 호스팅" (중요)**

같은 문서 **§ Can customers offer Claude Code in their products?** 전문 인용:

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
>
> - **The Claude Code binary must not be modified.** Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).
> - **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential (Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry). That usage is billed directly to the end user under their own agreement with Anthropic (…)

그리고 Authentication 절의 세이프하버 문장:

> Nor does it prevent an end user from signing in to the **unmodified Claude Code binary** with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

**해석:** 구독 자격증명을 *우리가 만지면* 금지지만, **미개조 Claude Code를 사용자 환경에서 실행시키고 사용자가 Anthropic 자체 플로우로 직접 로그인하게 하면 명시적으로 허용**된다. oort는 이미 codex-fleet / grok-fleet 스킬로 "CLI를 서브프로세스로 spawn하고 구조화 출력 수거"하는 동형 구조를 보유 → 재사용 가능.

**부수 의무:**
- Commercial ToS 동의 필요
- 상표: "Claude Code가 사전 설치됨/실행됨"이라고 **평문으로만** 표기 가능. 제품·기능·회사명, 로고에 Claude/Anthropic 사용 금지, 파트너십 암시 금지 (Trademark Guidelines)
- 인증 수단을 우리가 제한/은폐하면 안 됨 (사용자가 API 키 로그인도 고를 수 있어야 함)

---

## 2. OpenAI / ChatGPT — **회색지대 (아이덴티티는 공식, 추론은 아님)**

### 2.1 "Sign in with ChatGPT"의 실체 = 아이덴티티 전용

정본: <https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt>

> Sign in with ChatGPT is an identity-provider sign-in option that lets you use identity information from your ChatGPT account to create, link, or access an account with a supported external application.
> When you use Sign in with ChatGPT, the external application receives **only your name, email address, and profile picture**, if you have one.

- 2026-08-02 라이브 베타 출시. 초기 파트너 6곳: Airtable, GitLab, HubSpot, Notion, Supabase, Vercel
- Free / Plus / Pro 대상. **Enterprise / Edu / Team 제외**
- 로그인 시 플랜에 따라 API 크레딧 $5(Plus) / $50(Pro) 지급 → **이건 구독 추론이 아니라 별도 API 크레딧 부여**
- 개발자 관심 등록 폼 존재(1,000 미만 ~ 1억 WAU 규모 앱 모두 신청 가능)

> **결론: "Sign in with ChatGPT"로는 사용자의 ChatGPT 구독 추론을 못 쓴다.** 이름/이메일/프로필 사진뿐이다. aside식 "구독 연결"과는 다른 물건. 착각하기 쉬운 지점이라 명시해 둔다.

### 2.2 Codex CLI의 ChatGPT 로그인 = 별개 물건, 서드파티 개방은 비공식

- Codex CLI는 ChatGPT 플랜으로 모델 사용 가능 (<https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>)
- 인증 문서: <https://learn.chatgpt.com/docs/auth> (구 `developers.openai.com/codex/auth` → 308)
- **그러나 서드파티 앱이 이 플로우를 쓰도록 하는 공식 등록 프로그램은 문서상 확인되지 않음.** 공식 문서는 "Codex 자체에 로그인"만 다룸.
- 기술 실태(보도 기준): 서드파티 하네스는 Codex OAuth 토큰을 받아 **localhost 프록시로 Codex CLI 요청 형태로 변환**해 인증을 통과시킴 → 사용자 구독으로 과금

### 2.3 약관 상태 — 허용도 금지도 없음

Manifest 분석(<https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/>):
> "Nothing in OpenAI's terms of use explicitly permits or prohibits using your ChatGPT subscription inside a non-OpenAI tool."

**허용 방향 신호(계약 아님, 발언·프로그램):**
- Sam Altman 공개 지지 발언(X)
- OpenAI 임원 Tibo Sottiaux: 서드파티 툴(Pi, OpenCode)이 **Codex 트래픽의 약 10%** 차지, 용인 취지
- **Codex for Open Source** (2026-03-07, <https://openai.com/form/codex-for-oss/>): "developers should code in the tools they prefer, whether that's Codex, OpenCode, Cline, pi, OpenClaw, or something else — and this program supports that work" → OSS 메인테이너에게 ChatGPT Pro 6개월 무료 + API 크레딧, **서드파티 툴 사용자도 대상 포함**

**금지 방향 신호:**
- 소비자 ToS(<https://openai.com/policies/row-terms-of-use/>, 2026-01-01 발효 / 2026-03-10 개정): 계정 자격증명 공유 금지, 계정을 타인이 쓰게 하는 것 금지, 계정 하 모든 활동 책임. 경쟁 AI 시스템 구축 금지, 레이트리밋·제한 우회 금지
  - ※ 원문 페이지는 WebFetch 403(봇 차단). 조항은 2차 출처(ConductAtlas 미러 + OpenAI 헬프센터 요약) 기준 — **[원문 직접 인용 미확보]**
- "구독 자격증명을 서드파티가 중계"가 "credential sharing"에 해당하는지는 **[해석 미확정]**

> **평가:** OpenAI는 현재 관용적이지만 **계약적 보장이 0**이다. Anthropic이 정확히 같은 자리(문서상 회색 → 리더십 관용 → 갑작스런 명문화 → 과금 전환)를 1월~4월에 걸쳐 뒤집은 전례가 있다. 제품의 핵심 의존점으로 삼으면 안 된다.

---

## 3. xAI / Grok — **유일하게 provider가 공개 권장**

### 3.1 xAI 공식 발표

정본: <https://x.ai/news/grok-kilocode> + xAI 공식 계정 <https://x.com/xai/status/2059666227115819149>

> "With your X Premium+ or SuperGrok subscription, connect your Grok account to use the latest Grok models — including Grok Build for agentic coding — inside Kilo Code with no separate API key."

> **이건 provider 자신의 뉴스룸이 서드파티 툴에서의 구독 사용을 홍보한 것.** 3사 중 유일. Anthropic이 금지한 바로 그 행위를 xAI는 마케팅한다.

추가 채택 사례:
- **OpenCode**: `/connect` → xAI 선택 → SuperGrok/X Premium 구독으로 Grok Build 사용
- **Kilo Code**: <https://kilo.ai/inference/subscriptions/supergrok> — "Usage counts against your subscription, not a pay-per-token API account"
- **Hermes Agent (Nous Research)**: <https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth> — device-code 플로우
- Pi (`pi-xai-oauth`), OpenClaw, OmniRoute 등 커뮤니티 다수

### 3.2 기술 스펙 (xAI 자체 레포 문서 기준)

<https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md>

- 인증 서버: **`auth.x.ai`** (SpaceXAI OAuth2) — 기본 경로
- 그랜트: **Authorization Code + PKCE**, "No client secret. PKCE replaces it."
- 리다이렉트 URI: `http://127.0.0.1/callback` (loopback, RFC 8252에 따라 포트 무관)
- **Device code 플로우**: `grok login --device-auth` — 헤드리스(SSH/Docker/원격 VM)용. 브라우저에서 코드 승인 후 폴링
- 토큰 자동 갱신. 자격증명은 사용자 머신에 상주
- X Premium+ 계정으로 로그인 시 구독 상태가 xAI 세션에 자동 연동

### 3.3 리스크·실측 이슈

- **공개 client 등록 프로그램(개발자 포털에서 임의 서드파티가 OAuth 앱 등록)의 문서화된 존재를 확인하지 못함.** 확인된 건 파트너 발표(Kilo Code)와, loopback + PKCE(시크릿 없음) 구조뿐. **[추정]** 현재는 (a) 파트너십 기반이거나 (b) loopback client_id를 공유하는 사실상 개방 구조. → **xAI에 파트너 문의 선행 권고.**
- **티어 게이팅 불일치**: 표준 SuperGrok($30/월) 구독자가 `xai-oauth`에서 **HTTP 403** 반환, API 접근이 SuperGrok **Heavy 전용**으로 게이팅되고 있다는 버그 리포트 — 공식 발표·문서와 모순 (hermes-agent issue #26847, <https://github.com/NousResearch/hermes-agent/issues/26847>)
- **refresh token 회전**: 동시 프로세스 실행 시 간헐적 재인증 필요 (Kilo 문서 명시) → oort처럼 에이전트 여러 기가 도는 구조에서 실제 문제가 됨
- Kilo 사례상 **클라우드/게이트웨이 경로에서는 OAuth 불가**, BYOK API 키만 지원 → 서버사이드 중계는 막힌 것으로 보임 **[추정: oort가 서버에서 대신 호출하는 구조면 동일 제약 예상]**
- xAI 소비자 ToS(<https://x.ai/legal/terms-of-service>, 2026-05-05 갱신): 로그인 자격증명 공유 금지 / 경쟁 AI 모델·서비스 구축 금지 / 서비스 개조·리버스엔지니어링·기술적 우회 금지
  - ※ 원문 WebFetch 403. 조항은 ConductAtlas 미러 기준 — **[원문 직접 인용 미확보]**
  - 소비자 ToS ↔ Enterprise ToS(API·PromptIDE) 이원 구조. 구독 OAuth 추론이 어느 쪽 지배인지 **[미확정]**

---

## 4. OpenRouter — **가장 깨끗한 경로**

### 4.1 공식 OAuth PKCE 스펙

정본: <https://openrouter.ai/docs/guides/overview/auth/oauth>
API: <https://openrouter.ai/docs/api/api-reference/o-auth/exchange-auth-code-for-api-key>

**Step 1 — 인가**: `https://openrouter.ai/auth`
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `callback_url` | 선택 | 리다이렉트 대상. **localhost는 임의 포트 허용** |
| `code_challenge` | 권장 | code_verifier의 SHA-256 → base64 |
| `code_challenge_method` | 선택 | `S256`(권장) 또는 `plain` |
| `key_label` | 헤드리스 시 필수 | callback_url 없을 때 앱 이름 |

**Step 2 — 교환**: `POST https://openrouter.ai/api/v1/auth/keys`
- body: `{ code, code_verifier, code_challenge_method }`
- 응답: `{ key: "<user-controlled API key>" }`

**헤드리스 모드**: `callback_url` 생략 → 코드가 화면 표시, **10분 만료**. SSH/컨테이너용.

### 4.2 클라이언트 등록 불필요 — 이게 결정적

공식 라이브러리 <https://github.com/OpenRouterTeam/sign-in-with-openrouter> (OpenRouter 팀 소유, MIT):
> "No client registration, no backend, no secrets."

- 프레임워크 무관(React/Vue/Svelte/vanilla), 브라우저에서 완결
- 승인 절차·대기열·파트너십 없음 → **오늘 바로 구현 가능**
- 발급되는 키는 **사용자 자기 OpenRouter 계정 소유** → 과금은 사용자에게. 우리는 자격증명 소유자가 아님 (ADR-0004 정합)

### 4.3 수수료 구조 (2026-08 기준)

| 항목 | 요율 | 비고 |
|---|---|---|
| 크레딧 카드 충전 | **5.5% + 최소 $0.80** | 사용자가 OpenRouter 크레딧 살 때 |
| BYOK (사용자가 자기 provider 키를 OpenRouter에 연결) | **PAYG: 월 $25,000 list-price 무료, 초과분 5%** / Enterprise: 월 $200,000 무료 | 2026-07 변경 — 이전엔 요청 수 기준(PAYG 1M req/월, Ent 5M) |
| 앱 개발자 수수료 | **없음(확인된 바 없음)** | 우리가 내는 돈 없음 |

- OpenRouter는 5% BYOK 수수료를 **향후 고정 월 구독으로 대체 예정**이라고 시사 — **[추정: 요율 변동 가능]**
- 앱 귀속: `HTTP-Referer` 헤더로 앱 랭킹 페이지 생성. 수익 배분 프로그램은 **[확인 안 됨]**

### 4.4 약관 체크 (2026-07-29 발효, <https://openrouter.ai/terms>)

| 조항 | 내용 | oort 영향 |
|---|---|---|
| §3.2 | "You are responsible for maintaining the confidentiality and security of all API keys, tokens, passwords, and other credentials… responsible for all activity and charges under its account or API Credentials" | 우리가 사용자 키를 보관하면 보안 책임 승계. **암호화 저장 + 사용자 폐기 경로 필수** |
| §5.2 | "You will require that all of your Authorized Users and customers access and use the Service… only in accordance with this Agreement… and the applicable Model Terms" | 우리 ToS에 flow-down 조항 필요 |
| §7.4 | "access the Site or Service for purposes of **reselling API access to Models or otherwise developing a competing service**" 금지 | **사용자 자기 키로 사용자가 쓰는 구조는 리셀 아님 → 안전.** 우리가 마진 붙여 재판매하면 위반 |
| §7.13 | 접근권한 판매·양도 금지 | 상동 |
| §10.3 | Non-OpenRouter Services는 해당 서드파티 약관 지배 | 모델 provider 약관은 별도 적용 |

> **판정: 사용자 소유 키를 사용자 본인이 쓰도록 중개하는 구조는 §7.4 리셀에 해당하지 않는다.** OpenRouter가 이 플로우용 공식 라이브러리를 직접 배포한다는 사실 자체가 최고의 안전 증거.

---

## 5. aside.com — 실제 방식에 대한 공개 정보

### 5.1 확인된 사실

- Y Combinator 스타트업 **Aside Computer Inc.** macOS 전용 AI 브라우저. 로그인된 웹사이트에서 사람처럼 페이지를 조작 (통합 없이)
- 공식 사이트(<https://aside.com/>) 문구 — 원문:
  > "Bring your own subscription — Use your ChatGPT or Claude subscriptions, or bring your own API key."
- 3-way 과금 구조 (eesel 리뷰): ① 기존 ChatGPT/Claude 구독 ② OpenAI/Anthropic API 키(종량) ③ Aside 클라우드 크레딧(Stripe, 구독/크레딧/자동 리로드)
- 가격 페이지 없음. 개인정보처리방침에서 Stripe·구독·크레딧 언급만
- 로컬 우선 설계: 작업·메모리 온디바이스, 비밀번호 관리자가 모델에 자격증명 노출 없이 에이전트를 로그인시킴
- 자체 보고 벤치마크 Online-Mind2Web 99.0% — **자체 레포·자체 채점, 독립 감사 아님**

### 5.2 기술 구현 — **공개 문서 없음**

사이트·문서·리뷰(eesel ×3, Tabbit, BitsAndBucks, AgentLocker) 전부 **"구독 연결"이 OAuth인지 / 로컬 CLI spawn인지 / 세션 토큰 재사용인지 기술하지 않는다.** 개발자 문서가 공개돼 있지 않다.

**[추정] 가능한 구현 3가지:**
1. **로컬 CLI 브리지** — 사용자 머신의 Claude Code / Codex CLI를 서브프로세스로 구동. macOS 전용 + 로컬 우선 아키텍처와 정합. **Anthropic §1.4 예외에 부합하는 유일한 합법 경로.**
2. **구독 OAuth 토큰 직접 사용** — Anthropic 기준 명백한 약관 위반. 2026-04-04 이후 사용자에게 종량 과금이 튐.
3. 위 둘의 provider별 혼합 (OpenAI는 2번, Anthropic은 1번)

> **주의: aside를 UX 벤치마크로는 참고하되, 약관 준거 레퍼런스로 인용하면 안 된다.** 그들의 Claude 경로가 합법인지 우리는 검증할 수 없고, 4월 집행 이후에도 "Claude 구독 연결" 카피를 유지 중이라는 점은 오히려 리스크 신호로 읽힌다.

---

## 6. 결론 매트릭스

### 6.1 provider별 3축 평가

| Provider | 경로 | 기술 가능성 | 약관 안전성 | UX 마찰 | 종합 |
|---|---|---|---|---|---|
| **OpenRouter** | 공식 OAuth PKCE (등록 불필요) | ◎ 즉시 구현 | ◎ 공식 라이브러리 배포 | ◎ 원클릭, 브라우저 완결 | **★ 1순위** |
| **xAI** | 구독 OAuth (auth.x.ai, PKCE+device code) | ○ 검증된 선례 다수 | ○ provider가 공개 홍보 | △ 티어 403·토큰 회전 이슈 | **★ 2순위 (그록봇 타겟)** |
| **Anthropic** | 미개조 Claude Code 로컬 spawn | △ 로컬 런타임 필요 | ○ 문서 명시 예외 | ✕ CLI 설치·별도 로그인 | **조건부 (별도 경로로 분리)** |
| **Anthropic** | 구독 OAuth 직접 | ✕ 4/4 이후 무의미 | **✕✕ 명시적 위반** | — | **금지** |
| **OpenAI** | Codex 구독 OAuth 중계 | ○ 동작함 | △ 무허가·무금지, 보장 0 | ○ | **실험 플래그만** |
| **OpenAI** | Sign in with ChatGPT | — | ◎ | ◎ | **추론 불가 — 아이덴티티 전용** |
| **전 provider** | BYOK (직접 API 키) | ◎ | ◎ | ✕ 키 발급·복붙 | **상시 폴백** |

### 6.2 리스크 등급

| 리스크 | 확률 | 영향 | 완화 |
|---|---|---|---|
| Anthropic 구독 경로 채택 시 사용자 종량 과금 폭탄 + 계정 제재 | **확정** | 치명 | 채택 안 함 |
| OpenAI가 Anthropic처럼 선회 | 중 | 대 | 핵심 의존 금지, 어댑터로 격리 |
| xAI 티어 게이팅(403)으로 표준 구독자 실패 | 중~고 | 중 | 온보딩에서 사전 프로브 + BYOK 즉시 폴백 |
| OpenRouter 수수료 구조 변경(5%→월 구독) | 중 | 소 | 사용자 과금이라 우리 P&L 무영향 |
| 사용자 키 유출 (§3.2 책임) | 저 | 대 | 암호화 저장·폐기 경로·서버 미전송 |

---

## 7. oort 제품 방침 권고

### 7.1 "구독 연동 1순위 · BYOK 폴백"에 대한 판정 — **수정 채택**

원안의 문제: **"구독 연동"을 provider 무관 단일 개념으로 다루면 Anthropic에서 약관 위반이 된다.** aside식 단일 카피("Connect your ChatGPT or Claude subscription")를 그대로 복제하면 안 된다.

**수정안 — 3계층 온보딩:**

```
① 원클릭 연결   → OpenRouter OAuth PKCE        (기본값·권장)
② 구독 연결     → xAI SuperGrok OAuth          (그록봇 타겟 1차 런칭)
                  └ Anthropic은 여기 없음
③ 직접 연결     → BYOK (API 키)                (상시 폴백)
④ 로컬 브리지   → 미개조 Claude Code / Codex CLI spawn  (고급, 별도 섹션)
```

### 7.2 실행 권고

1. **P0 — OpenRouter OAuth PKCE를 기본 연결 경로로 구현.** 클라이언트 등록·승인 대기 없음, 공식 라이브러리 존재, 사용자 과금, 약관 클린. 오늘 착수 가능한 유일한 경로.
2. **P0 — BYOK를 1급 시민으로 유지.** 어떤 구독 경로도 provider 정책 변경에 취약하다. BYOK만이 우리가 통제하는 경로.
3. **P1 — xAI 구독 OAuth.** 1차 런칭 타겟이 그록봇 유저인 현 방침과 정합. **단 착수 전 xAI에 서드파티 OAuth 클라이언트 등록 절차 문의 필수** (공개 등록 프로그램 미확인). 표준 SuperGrok 403 이슈를 온보딩에서 사전 프로브로 감지해 BYOK로 자동 폴백.
4. **P1 — Anthropic은 "로컬 Claude Code 브리지"로만.** 별도 고급 옵션으로 분리하고, 우리가 토큰을 만지지 않음을 UI에서 명시. Commercial ToS 동의 필요. 카피는 "Claude Code가 설치돼 있으면 연결할 수 있습니다" 수준의 평문만 — 제품/기능명에 Claude·Anthropic 사용 금지, 로고 사용 금지.
5. **P2 — OpenAI Codex 구독 경로는 기능 플래그 뒤에.** 리더십 관용은 계약이 아니다. 기본 활성화 금지.
6. **아키텍처 — 추론 백엔드를 provider 어댑터로 추상화.** Anthropic 전례(1월 차단 → 2월 명문화 → 4월 과금 전환)가 증명하듯 구독 경로는 언제든 뒤집힌다. 어느 provider도 단일 실패점이 되면 안 됨.
7. **ADR-0004(provider 자격증명 비유입) 정합성 확인:** OpenRouter 키는 사용자 소유, 로컬 CLI 브리지는 토큰이 우리 서버에 오지 않음. **권고안 전체가 ADR-0004를 유지한다.** 반대로 Anthropic/OpenAI 구독 토큰 중계는 ADR-0004를 정면 위반 — 우리 하드룰이 이미 올바른 답을 갖고 있었다.
8. **UX 정직성:** provider별로 "구독 연결"의 의미가 다르다는 걸 숨기지 말 것. 특히 Anthropic 사용자에게 "구독을 연결하면 종량 과금될 수 있다"는 오해를 만들지 않도록, 애초에 그 선택지를 제시하지 않는 게 낫다.

### 7.3 후속 필요 작업

- [ ] xAI 파트너/개발자 문의 — 서드파티 OAuth 클라이언트 등록 공식 절차 존재 여부
- [ ] OpenAI ToS 원문 직접 확보 (봇 차단 우회 아닌 정상 열람) — credential sharing 조항 원문 확인
- [ ] xAI 소비자 ToS 원문 직접 확보 — 소비자/Enterprise ToS 중 구독 OAuth 추론의 지배 약관 확정
- [ ] OpenRouter OAuth 스파이크 (PKCE + 헤드리스 모드, oort 데스크톱/웹 양쪽)
- [ ] Anthropic Commercial ToS 검토 — 로컬 Claude Code 브리지 채택 시 동의 주체·범위
- [ ] ADR 기안: "추론 백엔드 연결 경로" (경계 변경 — 보안/방향 해당, Accepted ADR 없이 머지 금지)

---

## 8. 출처

**Anthropic**
- 정본 legal-and-compliance: <https://code.claude.com/docs/en/legal-and-compliance>
- Consumer Terms: <https://www.anthropic.com/legal/consumer-terms> / Commercial Terms: <https://www.anthropic.com/legal/commercial-terms> / AUP: <https://www.anthropic.com/legal/aup>
- The Register 2026-02-20 (명문화): <https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546>
- The Register 2026-04-06 (4/4 집행): <https://www.theregister.com/2026/04/06/anthropic_closes_door_on_subscription/>
- VentureBeat: <https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and>
- TNW: <https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost>
- OpenClaw.report: <https://openclaw.report/ecosystem/anthropic-bans-oauth-tokens-third-party-tools>
- winbuzzer 2026-02-19: <https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/>

**OpenAI**
- Sign in with ChatGPT (헬프센터): <https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt>
- Codex CLI + Sign in with ChatGPT: <https://help.openai.com/en/articles/11381614-codex-cli-and-sign-in-with-chatgpt>
- Codex with ChatGPT plan: <https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>
- Codex 인증 문서: <https://learn.chatgpt.com/docs/auth>
- Codex for Open Source: <https://openai.com/form/codex-for-oss/> · <https://developers.openai.com/community/codex-for-oss>
- Terms of Use: <https://openai.com/policies/row-terms-of-use/> (원문 403, 미러: <https://conductatlas.com/platform/openai/openai-terms-of-use/>)
- 서드파티 하네스 분석: <https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/>

**xAI**
- 공식 발표 (Kilo Code): <https://x.ai/news/grok-kilocode> · <https://x.com/xai/status/2059666227115819149>
- xAI 자체 레포 인증 문서: <https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md>
- Kilo Code SuperGrok: <https://kilo.ai/inference/subscriptions/supergrok>
- Hermes Agent OAuth 가이드: <https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth>
- 403 티어 게이팅 이슈: <https://github.com/NousResearch/hermes-agent/issues/26847>
- Consumer ToS: <https://x.ai/legal/terms-of-service> (원문 403, 미러: <https://conductatlas.com/platform/xai/xai-terms-of-service/>)

**OpenRouter**
- OAuth PKCE 가이드: <https://openrouter.ai/docs/guides/overview/auth/oauth>
- 키 교환 API: <https://openrouter.ai/docs/api/api-reference/o-auth/exchange-auth-code-for-api-key>
- 공식 라이브러리: <https://github.com/OpenRouterTeam/sign-in-with-openrouter>
- App Attribution: <https://openrouter.ai/docs/app-attribution>
- Terms (2026-07-29): <https://openrouter.ai/terms>
- BYOK 수수료 변경: <https://openrouter.ai/blog/announcements/1-million-free-byok-requests-per-month/>

**aside.com**
- 공식: <https://aside.com/>
- eesel 리뷰: <https://www.eesel.ai/blog/aside-ai-browser-review> · 가격: <https://www.eesel.ai/blog/aside-ai-browser-pricing>
- Tabbit: <https://go.tabbit.ai/aside-browser-review> · BitsAndBucks: <https://bitsandbucks.de/blog/en/aside-ai-browser.html>
