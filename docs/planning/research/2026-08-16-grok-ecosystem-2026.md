# Grok 생태계 2026-08 현황 — oort 활용 지점 리서치

- 작성: 2026-08-16 (deep-research). **조회일: 본문 전 항목 2026-08-16** (선행 정본 인용분은 각 문서의 조회일을 따름).
- 발제: 성재 — "요즘 그록 기반 생태계가 최고." 보유: **SuperGrok Heavy 구독 · Grok Build CLI 사용 중(리뷰어 C) · Cursor 클라우드 에이전트를 SuperGrok Heavy 계정으로 쓰는 스크린샷 실재.**
- 선행 정본: `2026-08-12-grok-bot-integration-feasibility.md`(제품 실체·인바운드 불가) · `2026-08-12-grok-bot-reverse-teammate-direction.md`(Agent Port 방향) · `2026-08-14-grok46-worker-integration.md`(Grok Build 워커·provider 경로) · ADR-0162(Agent Port) · ADR-0004(provider 경계).
- 표기: **[확실]** = 1차 출처(공식 문서/페이지 직접 fetch) · **[확실-2차]** = 복수 2차 출처 일치 · **[추정]** = 단일 2차/해석.
- **한 줄 요약: 08-14 판정 이후 가장 큰 변화는 구독 지형이다. 성재가 SuperGrok Heavy를 확보하면서 (a) Grok Bot 접근 가능(08-14 "불가" 판정 뒤집힘), (b) Grok 계정 연동만으로 Cursor Ultra가 무료로 열림(스크린샷의 정체) — HAP Wave 0 스파이크의 구독 관문이 해소됐다. 구조 판정(Grok Bot 인바운드 API 부재·웨이크업 주권 xAI 소유)은 유지.**

---

## §1. 제품 지도

### 1.1 제품군 4개 축 (전부 SpaceXAI — 구 xAI, SpaceX 피인수·Cursor와 합병 진행 중)

| 제품 | 실체 | 접근 |
|---|---|---|
| **Grok (어시스턴트)** | grok.com/iOS/Android/X 앱. 커넥터 + Automations(스케줄/트리거) 보유 | Free~SuperGrok Heavy |
| **Grok Bot** | 상시 가동 팀메이트(계정당 클라우드 VM 1대 공유, 브라우저·터미널·`/workspace`). 2026-08-11 베타 | **SuperGrok Heavy $300 / Cursor Ultra $200 / Cursor Teams Premium $120석** 한정 |
| **Grok Build** | 공식 코딩 에이전트 CLI(`grok`), 구독 OAuth 로그인, 헤드리스 공식 문서화 | SuperGrok $30 이상 (주간 공용 풀 차감) |
| **xAI API** | api.x.ai — OpenAI 호환 + 자체 SDK. 서버사이드 Agent Tools + Remote MCP Tools | 선불 종량 (구독과 완전 분리) |

### 1.2 구독 티어 — 무엇이 열리나

- **SuperGrok $30**: 앱 상위 사용량 + Grok Build 포함(Chat/Imagine/Voice/Build 공용 주간 풀). Automations 이메일 트리거. Grok Bot **미포함**. [확실-2차] (선행 08-14 §2.1 + cursor.com/help/grok-bot/plans)
- **SuperGrok Plus $100**: 사용량 증량. Grok Bot **미포함**. [확실] (cursor.com/help/grok-bot/plans — "Cursor Pro/Pro+와 SuperGrok $30/Plus $100은 Grok Bot 미포함")
- **SuperGrok Heavy $300**: ①최상위 사용량·최고 속도 ②Heavy 전용 멀티에이전트 모델 계보(Grok 4 Heavy 4-agent → 4.20 Heavy 16-agent — **4.6 Heavy 존재 여부는 미확인** [추정]) ③전용 지원·얼리액세스 ④**Grok Bot 포함** ⑤**Cursor Ultra 무료 연동**(§1.4). [확실] (x.ai/bot, cursor.com/help/grok-bot/supergrok-heavy)
- **X Premium+ $40**: X 통합 접근 + Grok Build. Grok Bot 미포함. [확실-2차]
- 티어별 **정량 쿼터는 전 티어 비공개**("higher usage" 서술뿐) — 08-14 실측 유지. [확실]

### 1.3 Grok Bot 현황 (08-11 베타 이후)

- 8/11 제한 베타(macOS/Windows/iOS, Android "coming soon") → Musk "4.6과 함께 금주 확대" 예고 → **4.6은 8/12 출시됐으나 Bot 베타 확대는 8/16 현재 공표된 날짜 없음**(베타 이슈 수리 게이트). [확실-2차] (aiweekly.co, explainx.ai, basenor)
- 구성 요소(문서 기준 변화 없음, 08-16 재실측): 스킬(재사용 지시문, 봇 간 공유·조건 분기 지원, 시연 녹화 10분) + 루틴(봇당 50개, 런 기록 20개 보존) + 커넥터 + 승인 흐름. 루틴 트리거 = 스케줄(일/요일/시각 단위 예시뿐 — 분 단위 미실증 유지) + 이벤트(Slack 메시지·GitHub 알림 — "플러그인과 별도 연결 필요" 명시, 폐쇄 목록 유지). **웹훅/외부 트리거 여전히 부재.** [확실] (docs.x.ai/grok-bot/skills-routines-and-automations)
- 인바운드 API(봇 열거/호출/위임 OAuth/export) **여전히 전무** — 08-12 판정 유지. [확실] (docs.x.ai 재실측 + release notes에 관련 신규 표면 없음)

### 1.4 Cursor 통합 실체 — 스크린샷의 정체

- **크로스 구독 연동이 공식 기능이다**: SuperGrok Heavy 구독자는 Grok Bot 플랜 화면에서 "Get access with SuperGrok Heavy" → "Link Grok Account" → Heavy 계정 인증 → **Cursor Ultra가 무료로 부여**된다. 결제카드 불요, **Heavy 구독이 갱신 유지되는 한 무기한 지속**(1개월 체험이 아님 — 문서에 만료 서술 없음. 단 2차 소스 일부는 "1개월 무료"로 표기 — 문서 우선하되 갱신 시점 실측 권고 [추정]). 1 Grok 계정 = 1 Cursor 계정 페어링, 팀/관리 계정 제외. [확실] (cursor.com/help/grok-bot/supergrok-heavy)
- 따라서 성재의 "Cursor 클라우드 에이전트를 SuperGrok Heavy 계정으로" 스크린샷 = **Heavy 연동으로 부여된 Cursor Ultra 자격으로 Cloud Agents를 쓰는 것**. Cursor Ultra는 Cloud Agents·Bugbot 접근 + Cursor Models pool(Grok 4.6/4.5/Composer 2.5 — "generous usage") + 서드파티 모델 풀 $400/월 포함. [확실] (cursor.com/docs/models-and-pricing, cursor.com/help/models-and-usage/usage-limits)
- Grok Bot 자체가 Cursor 계정·과금 인프라 위에 서 있고(08-12 실측), MCP 인증도 Cursor와 공유 — **"Grok 생태계"의 절반은 사실상 Cursor 인프라다.** [확실]
- Grok 4.6은 Cursor에 출시일 동시 탑재(Cursor Models pool 소속 — 서드파티 $-차감이 아닌 자사 모델급 풀). [확실] (cursor.com/docs/models/grok-4-6, 08-14 실측 유지)

### 1.5 grok.com 웹/앱의 에이전트 기능

- **Agent Computer**: 에이전트에게 클라우드 가상 컴퓨터+브라우저 세션+연결 도구를 부여 — 실체는 Grok Bot의 VM 표면(별도 제품 아님). [확실-2차] (datacamp, mindstudio)
- **커넥터**: **전 티어·전 플랫폼(웹/iOS/Android) 사용 가능.** 내장 7종 = Gmail·Google Calendar / Google Drive / OneDrive / Outlook Mail·Calendar / Microsoft Teams / SharePoint / Salesforce (OAuth 1회 연결 → 계정 내 전 에이전트 공유). Business/Enterprise는 admin이 클라우드 콘솔에서 선-프로비저닝. 2차 소스는 Slack·GitHub·Notion·Linear·Airtable 등도 언급 — 문서 7종과 불일치, 플랜/롤아웃 차이로 추정. [확실(7종)/추정(확장 목록)] (docs.x.ai/grok/connectors)
- **커스텀 MCP 커넥터**: grok.com/connectors → Custom → **MCP 서버 URL 입력** → 인증 완료. **공인 인터넷 도달 필수**(로컬은 터널링). 4대 어시스턴트 중 커스텀 MCP 클라이언트 표면 보유 유지. [확실] (docs.x.ai/grok/connectors)
- **Automations** (2026-07-16 출시): 일반 Grok 사용자용 스케줄/트리거 태스크 — 1회/매일/평일/매주/매월/매년 + 시각 지정, 결과는 이메일/앱 알림/런 기록. **스케줄은 전 사용자 무료, 이메일 트리거는 SuperGrok 이상.** 커넥터·스킬과 결합. [확실] (x.ai/news/grok-automations) — Grok Bot 루틴의 경량판이 무료 티어까지 내려온 형태.

## §2. 개발자 표면

### 2.1 API 기본 (08-14 실측 유지, 08-16 재확인)

- `grok-4.6`: 500K 컨텍스트, $2/$0.50/$6 per 1M(<200K 프롬프트), $4/$1/$12(≥200K), reasoning effort low/medium/high/xhigh. 레이트리밋 150 rps · 50M TPM. fast variant 2배 가격(모델 id 미확인 유지). [확실] (docs.x.ai/developers/release-notes, docs.x.ai/developers/models/grok-4.6)
- OpenAI 호환(`https://api.x.ai/v1` chat completions SSE) + 자체 xai_sdk + Responses API. ADR-0004 무수정 드롭인 판정 유지. [확실]
- 구독과 API는 **완전 별도 과금**(SuperGrok/Heavy에 API 크레딧 없음) 유지. [확실-2차]

### 2.2 서버사이드 Agent Tools — "API가 에이전틱하다"

- **Agent Tools API**: `web_search()` · `x_search()`(실시간 X 데이터 — **xAI 독점 축**) · `code_execution()`(원격 코드 실행)을 서버사이드로 제공, 클라이언트사이드 커스텀 도구와 하이브리드 조합 가능. xAI SDK/OpenAI SDK 양쪽 지원. [확실] (docs.x.ai/developers/tools/overview, /web-search, /advanced-usage)
- **Remote MCP Tools**: **API가 서버사이드 MCP 클라이언트로 동작** — 요청 tools 배열에 `mcp(server_url=…, server_label=…, allowed_tools=[…], authorization=<bearer>, headers={…})` 지정 → 모델이 원격 MCP 서버 도구를 직접 호출(호출 과정 실시간 관전 가능). 전송=Streaming HTTP/SSE. `require_approval`·`connector_id` 미지원(승인 게이트 없음 — 도구 필터링은 `allowed_tools`로만). grok-4.6 + native SDK/Responses API/Speech-to-Speech에서 동작. [확실] (docs.x.ai/developers/tools/remote-mcp)
- 부속: Batch API·Files API·Structured Outputs·Context Compaction·Cost Tracking·Docs MCP(문서 자체의 MCP 서버) 기보유. [확실] (release notes)

### 2.3 MCP 지위 정리 (호스트/클라이언트 양방향)

| 방향 | 표면 | 상태 |
|---|---|---|
| **Grok이 MCP 클라이언트** (우리 서버를 소비) | ①grok.com/앱 커스텀 커넥터 ②Grok Bot 커넥터(Cursor MCP 체계 공유) ③**xAI API Remote MCP Tools** ④Grok Build CLI MCP(`enable/disable` CLI 제어) | 전부 실재 [확실] |
| Grok이 MCP 서버 (우리가 Grok을 소비) | Docs MCP(문서 검색용)뿐 — **모델/봇 기능을 MCP 서버로 노출하는 표면 없음** | 부재 [확실] |
| 웹훅/외부 트리거 (우리가 Grok을 깨움) | 전무 — Automations/루틴 트리거는 폐쇄 목록(시계·이메일·Slack·GitHub), 외부 임의 웹훅 등록 불가 | 부재 [확실] |

### 2.4 커스텀 커넥터 등록 절차 (실무 요약)

1. oort 쪽: 원격 MCP 서버를 **공인 HTTPS**로 노출(Streamable HTTP/SSE). 2. 사용자: grok.com/connectors → Custom → URL 입력 → 인증(bearer/헤더). 3. 등록 후 계정 내 전 에이전트(웹 Grok·Grok Bot)가 공유. Grok Bot 쪽 호출은 Cursor 백엔드 프록시 경유(08-12 실측 유지). [확실]

### 2.5 서드파티 통합 사례 (08-16 시점)

- **Cursor**: 최심부 통합(합병 당사자) — 모델 동시 출시·Models pool 편입·Grok Bot 인프라·구독 크로스링크. [확실]
- **GitHub Copilot**: 2026-08-14 Grok 4.6 모델 피커 추가. [확실-2차] (releasebot, aipricing)
- **구독 OAuth 하네스**: Kilo Code·Warp·Hermes Agent(first-party 디바이스코드 OAuth, allowlist 게이팅·403 전례 유지). [확실]
- **애그리게이터**: OpenRouter·Vercel AI Gateway·Cloudflare. [확실-2차]
- 오픈소스: superagent-ai/grok-cli(비공식 API CLI), awesome-grok-connectors(커넥터 카탈로그). [확실-2차]

## §3. oort 접점

### ① HAP 축(oort Agent Port MCP) 대비 — 무엇이 바뀌었나

**가능해진 것 (08-12 이후 신규/확정):**
- **구독 관문 해소**: Wave 0 스파이크(커스텀 MCP 커넥터 개인 계정 실증·루틴 최소 간격·Slack 트리거 폐곡선)의 전제였던 "$200~300/월 구독 계정"이 **성재 Heavy 보유로 이미 충족**. 지금 바로 실측 가능. — 08-12 리서치 §6 Wave 0의 결정 대기 사유 소멸.
- 커스텀 MCP 커넥터 등록 절차가 **문서로 공식화**(grok.com/connectors → Custom) — 08-12의 [추정] 항목이 [확실]로 승격. Agent Port를 물릴 표면 확정.
- **Automations가 무료 티어까지 확장**(7/16) — "Grok 사용자 일반"이 스케줄 기반으로 oort Agent Port를 폴링하는 구조가 Heavy 전유물이 아니게 됨(단 커넥터 호출을 Automations가 지원하는 범위는 실측 필요 [추정]).
- **xAI API Remote MCP Tools** — 역방향 신규 카드: oort의 managed 경로(ADR-0163 카탈로그)에서 xAI provider를 쓸 때, **모델이 서버사이드로 우리 Agent Port(또는 Drive MCP)를 직접 소비**하게 할 수 있다. "oort산 Grok 에이전트"가 도구 루프를 xAI 서버 안에서 돌린다 — hermes 클라이언트사이드 루프 대비 왕복 절감. `allowed_tools`+bearer로 스코프 통제(승인 게이트가 없으므로 위험 도구는 목록에서 제외해야 함).

**여전히 불가한 것 (구조 판정 유지):**
- 봇 인바운드(열거/호출/위임 OAuth/export) 전무 — oort가 Grok Bot을 부를 수 없다.
- 웨이크업 주권 xAI/Cursor 소유 — 트리거는 폐쇄 목록, 임의 웹훅 등록 불가. Agent Port는 계속 **pull 기반 다이얼인** 설계여야 한다(ADR-0162 방향 그대로).
- 분 단위 스케줄 미실증·주간 사용량 경제성 제약 — "배치형 팀메이트" 상한 유지.
- Grok을 MCP 서버로 소비하는 길 없음 — 대칭 통합은 불가.

### ② Grok Build CLI 확장 여지 (현행: 리뷰어 C)

- **버전 흐름**: v0.2.113(7/28, MCP 서버 CLI 제어) → v0.2.116(7/30, **헤드리스 스트리밍에 tool calls·results·usage 포함** — 워커 출력 회수 품질 직결) → v1.0.1~1.0.3(8/10~12, 4.6 기본 모델화·서브에이전트 스폰 상한/가속·세션 rename·worktree 안전화·`grok du`). [확실-2차] (releasebot+codersera 일치; x.ai/build/changelog는 403으로 직접 미확인)
- **워커화**: 08-14 설계안(`grok -p … -m grok-4.6 --always-approve --output-format streaming-json`) 유효 + v0.2.116으로 스트리밍 회수가 codex exec 동등 수준. 대형 레포 worktree 처리 안전화(1.0.2)는 트랙 워크트리 운용과 정합.
- **병렬화**: 서브에이전트 8기 + 1.0.1에서 스폰 bounded(자원 고갈 방지) — CLI 내부 병렬은 성숙 중. 단 **프로세스 수준 병렬은 여전히 refresh 토큰 로테이션 리스크**(Kilo 문서 전례) — 병렬 1~2 상한 권고 유지.
- **신기능 중 주목**: `grok agent stdio`(ACP) — ADR-0130 ACP 체인 재랜딩 시 Grok Build를 ACP 하네스로 직결할 수 있는 표면. CLAUDE.md/AGENTS.md/.claude 자동 인식 유지(우리 레포 규약 그대로 읽음).
- 리스크: 사용량이 Chat/Imagine/Voice/Build **공용 주간 풀** — 성재가 Heavy로 승격돼 풀 자체는 최상위이나 정량 비공개 유지. 소진 시 `XAI_API_KEY` 종량 모드 전환이 공식 탈출구.

### ③ Cursor Cloud Agents 편입 여지 (백그라운드 워커 소스)

- **자격**: Heavy 연동 Ultra로 Cloud Agents 접근 이미 확보(추가 비용 0). [확실]
- **API 표면**: Cursor Dashboard에서 API 키 발급 → `POST /v1/agents`(생성) · `GET /v1/agents`(목록) · `POST /v1/agents/{id}/runs`(팔로업, SSE 스트림 옵션) · archive/delete. 모델 지정 가능(`model.id` — Grok 4.6 포함, reasoning effort 파라미터). 토큰 사용량 추적·아티팩트 보존·중복 런 취소. [확실] (cursor.com/docs/cloud-agent/api/endpoints)
- **제약**: ①**GitHub 레포 URL 필수**(에이전트당 최대 20) — oort는 GitHub 레포라 성립하나, **비공개 레포를 Cursor 클라우드에 노출**하는 결정이 선행돼야 함(코드 이그레스 — ADR-0150 계열 판단 필요) ②웹훅은 legacy v0만(v1 미지원) — 회수는 폴링/SSE ③사용량은 Ultra 풀 차감(Grok 4.6이면 Cursor Models pool — 정량 비공개) ④`/v1/repositories` 1req/min 등 엄격한 부속 리밋. [확실]
- **판정**: 로컬 codex/grok-fleet과 달리 **머신 무점유 클라우드 워커**라는 고유 가치 + spawn·팔로업·중지 결정권이 API로 우리에게 있음(Grok Bot과 결정적 차이 — worker 규율 성립). 단 코드 이그레스 결정·웹훅 부재·쿼터 불투명이 3대 허들. **파일럿 감**: 비민감 공개 레포(또는 전용 미러)에서 1티켓 실측 후 판단 권고.

## §4. 판정 — "그록 생태계가 최고" 가설의 실체

**실체 있는 강점:**
1. **구독 하나로 3표면**(앱+Build CLI+Grok Bot)이 열리고, Heavy는 **Cursor Ultra까지 무료 연동** — $300에 Cursor $200 상당이 얹히는 구독 경제성은 현시점 업계 유일. [확실]
2. **공식 헤드리스 CLI**(codex exec 동형)와 **API의 서버사이드 에이전틱 도구**(web/x/code exec + Remote MCP) — 개발자 표면의 에이전트 지향 완성도가 높다. x_search(실시간 X 데이터)는 타사가 못 주는 독점 축. [확실]
3. 4.6의 가성비(AA 61 = GPT-5.6 Sol 동률, $2/$6, 500K 컨텍스트)와 배포면(Cursor·Copilot·애그리게이터 동시). [확실]
4. MCP 수용이 소비자 표면(커넥터)과 API(Remote MCP) 양쪽에 있음 — **oort Agent Port가 물릴 자리가 두 군데**. [확실]

**약점:**
1. **쿼터 전면 비공개 + 공용 주간 풀** — 워커 파이프라인의 예산 계획이 불가능. spend cap 부재(Grok Bot).
2. **Grok Bot은 폐쇄 SaaS** — 인바운드 API·export·웹훅 전무, 웨이크업 주권 벤더 소유. "팀메이트" 서사는 oort와 동일 좌표지만 상호운용성은 0에 가깝다.
3. 터미널 실조작 절대치 낮음(Terminal-Bench 26%) — 구현 워커 투입은 여전히 실측 게이트 전 비권고(08-14 판정 유지).
4. 베타 유동성 — Bot 확대 일정 미공표, 트리거 카탈로그 "where supported" 헤지, 약관 라이브 403 지속.

**락인 리스크 (냉정하게):**
1. **기업군 수렴**: SpaceX(모기업)+Cursor(합병 진행) — 모델·IDE·클라우드 에이전트·봇·구독이 단일 의사결정권자로 수렴 중. 크로스 구독 무료 연동은 편익인 동시에 **이중 락인 장치**다(Heavy 해지 = Cursor Ultra 동반 상실).
2. **allowlist 관행**: first-party OAuth조차 계정/클라이언트별 403 게이팅 전례 — 서드파티에 열린 것처럼 보이는 표면이 임의 회수될 수 있다(X 2023 서드파티 차단 전례 동일 계보).
3. 가격 유동: 출시 첫 주 50% 할인 종료 후 실효 단가·풀 정책 재조정 가능성.
4. **완화책 = 기존 설계 원칙 그대로**: Agent Port는 벤더 중립(Grok은 여러 클라이언트 중 하나), provider는 ADR-0004 opaque 경계 뒤 드롭인(이탈 비용 = env 1줄), 워커는 3사 체제(Opus/sol/grok) 유지 — **생태계를 쓰되 어느 축도 단일 의존으로 만들지 않는 현행 구조가 정답이며, 이미 그렇게 돼 있다.**

**종합**: "최고"는 과장이 아니라 **"구독 경제성과 에이전트 지향 표면 밀도에서 현시점 최상위"**로 정정하면 실체와 일치한다. 단 그 밀도는 폐쇄 수렴(단일 기업군)의 산물이라, oort가 취할 것은 편입이 아니라 **수용 표면(HAP)과 드롭인 소비(provider·워커)** — 방향은 기존 ADR 체인과 정합.

## §5. 성재 결정 포인트 + 실측 큐 갱신

1. **HAP Wave 0 스파이크 즉시 착수 여부** — 구독 관문이 해소된 지금이 적기. 항목(08-12 §6 그대로): ①Heavy 개인 계정에서 커스텀 MCP 커넥터 등록 ②Grok Bot 세션·루틴에서 도구 호출 ③루틴 최소 간격 ④소스 IP/헤더. + 신규 ⑤Automations(무료 표면)가 커스텀 커넥터를 호출 가능한지.
2. **Cursor Cloud Agents 파일럿** — 코드 이그레스 판단 선행(비공개 레포를 Cursor 클라우드에 노출할지, ADR-0150 계열). 승인 시 비민감 레포 1티켓 실측.
3. **Cursor Ultra 연동 실사용 확인** — 스크린샷 상태가 "Heavy 연동 Ultra"가 맞는지, 갱신 시점에 유지되는지(문서상 무기한 vs 2차 소스 "1개월" 불일치) 대시보드 실측.
4. **Grok Build 역할 확대** — 리뷰어 C 유지 + 500K 스윕 추가 여부(08-14 권고 유지). 구현 워커 승격은 게이트 통과율 실측 후.
5. **Remote MCP Tools 활용** — managed provider(ADR-0163) 경로에서 서버사이드 도구 루프 채택 여부. 승인 게이트 부재이므로 `allowed_tools` 화이트리스트 설계 필수 — 채택 시 ADR 증보감.

## 출처 (전 항목 2026-08-16 조회)

- **공식 1차 (직접 fetch)**: cursor.com/help/grok-bot/supergrok-heavy · cursor.com/help/grok-bot/plans · docs.x.ai/developers/release-notes · docs.x.ai/developers/tools/remote-mcp · docs.x.ai/grok/connectors · docs.x.ai/grok-bot/skills-routines-and-automations · cursor.com/docs/cloud-agent/api/endpoints
- **공식 (검색 결과 경유)**: x.ai/bot · x.ai/news/introducing-grok-bot · x.ai/news/grok-automations · x.ai/news/grok-4-1-fast(Agent Tools API) · docs.x.ai/developers/tools/{overview,web-search,advanced-usage} · docs.x.ai/developers/docs-mcp · docs.x.ai/grok-bot/computer-and-apps · cursor.com/docs/models-and-pricing · cursor.com/docs/models/grok-4-6 · cursor.com/grok · cursor.com/help/models-and-usage/usage-limits · cursor.com/help/grok-bot/getting-started · x.ai/build/changelog(403 — 미확인)
- **2차**: releasebot.io/updates/xai{,/grok-build} · codersera.com(xAI dev stack·설치) · explainx.ai(베타 리포트) · aiweekly.co · digitalapplied.com(티어 게이팅) · venturebeat.com · moclaw.ai · aipricing.guru · datacamp.com(Grok Bot 해설) · mindstudio.ai · aitoolsreview.co.uk · basenor.com · el-balad.com · technobezz.com · netalith.com · kie.ai · grokipedia.com(SuperGrok Heavy·Grok Tasks) · aitoolranked.com(Grok 4 Heavy 멀티에이전트) · thecreatorsai.com · blockchain.news(Automations) · news.aibase.com · aitoolhunt.co · onecooltip.com · learncursor.dev · volanea.com · flexprice.io · omidsaffari.com · resourify.com · X(XFreeze 스레드 — 크로스 구독 실사용 증언) · hermes-agent.nousresearch.com(OAuth allowlist — 08-14 실측 유지) · github.com/superagent-ai/grok-cli · cobusgreyling.medium.com(서버사이드 툴콜) · strandsagents.com
- **선행 정본(레포 내)**: `docs/planning/research/2026-08-12-grok-bot-integration-feasibility.md` · `2026-08-12-grok-bot-reverse-teammate-direction.md` · `2026-08-14-grok46-worker-integration.md`
