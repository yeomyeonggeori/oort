# 에이전트 클라우드 크레딧 과금 모델 — 업계 실측과 oort 매핑

- 작성: 2026-08-14 (deep-research, 조회일 전부 2026-08-14)
- 발제: 성재 — "Cursor처럼: 클라우드 에이전트 실행에 별도 인프라/VM 요금 없음, 사용은 플랜 포함 토큰 또는 선택 모델의 API 단가로 차감, 유료 티어 필수, 번들 먼저 소진." oort 관리형 클라우드(크레딧 기반)의 과금 단위를 설계하기 위한 업계 실측.
- 관련 정본: ADR-0004(자격증명 비유입) · ADR-0156(T3=CubeSandbox, NCP 전용 호스트) · ADR-0163(관리형 에이전트 카탈로그, Proposed) · ADR-0162(다이얼인형 Agent Port) · `2026-08-12-grok-bot-reverse-teammate-direction.md`
- 표기: **[확실]** = 공식 페이지/문서 실측, **[추정]** = 2차 출처 또는 계산 추정.

---

## §1. 요약 — 지배 패턴 하나

2026년 8월 현재 에이전트 제품의 클라우드 과금은 사실상 한 가지 패턴으로 수렴했다:

> **구독 티어(유료 게이트) + 번들 사용량(달러/크레딧) 선차감 → 초과분은 모델 API 단가 종량 → 샌드박스/VM 인프라는 별도 청구 항목 없이 가격에 흡수.**

- Cursor: "Cloud Agents are charged at **API pricing for the selected model**" — 인프라 요금 항목 자체가 없음. [확실]
- OpenAI Codex: "There is **no separate infrastructure fee for cloud tasks** — they consume from your standard plan allowance." 로컬 CLI와 클라우드 실행의 과금 구분도 없음. [확실]
- Grok Bot: "own cloud computer" per member가 구독에 포함, VM 요금 항목 없음. [확실-2차]
- Anthropic(Managed Agents): 세션의 소비를 단일 USD 원장(list cost)으로 접되, **세션 러닝타임을 $0.08/시간 정액**으로 모델 토큰 정가와 같은 원장에 합산 — "이중 원가를 한 통화로 접는" 가장 깔끔한 참조 구현. [확실]

단위 설계의 계보는 3개였고, 업계는 (c)→(a)로 이동 중:
- (a) **달러 표시 토큰 패스스루**: Cursor(플랜에 "$20 포함"), v0(2026-02 고정 크레딧→토큰 기반 전환), Devin(신형 — 초과분 "API pricing" 소진)
- (b) **추상 크레딧**: Manus(4,000/8,000/40,000), Lovable(100/월), Codex 크레딧(모델·토큰종류별 환산표 공개)
- (c) **작업/노력 단위**: Devin ACU(구형, ≈15분 작업), Replit effort-based(체크포인트당 가변) — Replit은 사후 고지·예측불가로 반발을 받았고, Devin은 ACU 전면 노출에서 후퇴

---

## §2. 제품별 실측

### 2.1 Cursor — 성재 앵커의 원본
- 플랜: Pro $20/월(타사 모델 사용분 **$20 포함**) · Pro+ $60($70 포함) · Ultra $200($400 포함) · Teams $40/유저. [확실] (https://cursor.com/docs/models-and-pricing, 2026-08-14)
- Cloud Agents: **유료 플랜 필수**, "charged at API pricing for the selected model" — 별도 인프라/VM 요금 없음. 첫 사용 시 **지출 한도(spending limit) 설정 강제**. 병렬 실행 수 제한 명시 없음("as many as you want"). [확실] (https://cursor.com/docs/cloud-agents, 2026-08-14)
- 초과분: "Add on-demand usage: Continue at the same API rates with pay-as-you-go billing … Requests are never downgraded in quality or speed." — 번들 먼저, 그 다음 동일 단가 종량. [확실]
- Teams 타사 모델 요청에 "Cursor Token Rate" $0.25/M tokens 부과. [추정] (https://www.cloudzero.com/blog/cursor-ai-pricing/, 2026-08-14)

### 2.2 Devin — 작업 단위(ACU)에서 API-단가로 후퇴한 사례
- 현행 플랜: Free $0 · Pro $20 · Max $200 / Teams $80 base + $40/시트 / Enterprise. **사용 허용량이 일·주 단위로 자동 리필**, 초과분은 "purchase extra usage which is **consumed at API pricing**". 동시 세션: 개인 플랜 최대 10, Teams/Enterprise 무제한. [확실] (https://devin.ai/pricing, 2026-08-14 — ACU 정의는 현행 페이지에서 사라짐)
- 구형 ACU(Agent Compute Unit): **≈15분의 활성 작업 = VM 시간 + 모델 추론 + 네트워크 대역폭의 정규화 단위**, Core $2.25/ACU · Team 250 ACU 포함 $2.00/ACU. [추정] (https://pricepertoken.com/coding-assistants/devin ; https://aitoolpick.org/blog/devin-pricing-2026/, 2026-08-14)
- 시사점: 이중 원가(VM+추론)를 "작업 시간 단위"로 접은 유일한 대형 사례였으나, 2026 개편에서 저가 진입($20)+API-단가 초과분 구조로 회귀 — 추상 단위의 환율 불신을 이기지 못했다.

### 2.3 OpenAI Codex — 클라우드 태스크의 "인프라 무료" 명문화
- 플랜: ChatGPT Go $8 · Plus $20 · Pro 5x $100 · Pro 20x $200 · Business $20~25/유저. Codex는 웹/CLI/IDE/iOS **모든 표면이 같은 플랜 사용량을 공유**. [확실] (https://learn.chatgpt.com/docs/pricing, 2026-08-14)
- 인용: "**There is no separate infrastructure fee for cloud tasks — they consume from your standard plan allowance.**" / API키 사용자는 "no billing distinction between local and cloud execution." [확실] (같은 페이지)
- 단위: 2026년에 메시지-기반 → **토큰-기반 크레딧**으로 전환. 모델·토큰종류별 크레딧 환산표 공개(예: GPT-5.6 Sol 입력 125 / 캐시입력 12.5 / 출력 750 크레딧). "GPT-5.6 usage averages 5-40 credits per message." [확실]
- 한도: 5시간 롤링 윈도우(Plus 기준 클라우드 태스크 10~60개/윈도우 [추정] — https://www.eesel.ai/blog/codex-pricing, 2026-08-14). 한도 도달 시 업그레이드 또는 크레딧 구매; **진행 중 턴은 완료 허용**("the agent will be able to continue working on that turn, subject to fair use limits"). [확실]

### 2.4 Claude Code / Anthropic — 승수 티어 + list-cost 원장
- 플랜: Pro $20(1x) · Max $100(5x) · Max $200(20x). 5시간 세션 한도 + **주간 한도 이중화**(전 모델 공용 1개 + 고가 모델 전용 1개 — 주간 예산을 최고가 모델에 몰빵 못 하게). 정확한 토큰 쿼터는 비공개(승수만 공개). 초과분: "usage credits"를 켜면 **표준 API 단가**로 계속, 상환 한도 $2,000/일. [추정-2차 다수 일치] (https://www.morphllm.com/claude-code-usage-limits ; https://ccforeveryone.com/guides/claude-code-limits-and-pricing, 2026-08-14)
- API 정가(캘리브레이션 기준): Opus 5 $5/$25 · Sonnet 5 $3/$15(2026-08-31까지 인트로 $2/$10) · Haiku 4.5 $1/$5 · Fable 5 $10/$50 (per MTok in/out). [확실] (Anthropic 공식 — claude-api 정본 스킬, cached 2026-06-24)
- **Managed Agents 세션 예산(list cost)** — oort에 가장 중요한 참조: 세션이 소비하는 모든 것을 **공개 정가 기준 단일 USD 원장**으로 계속 환산 — ①모델 토큰=각 모델 정가 ②웹서치 $10/1,000건 ③**세션 러닝타임 $0.08/시간**. 예산 도달 시 종료가 아니라 **pause**(idle, `budget_reached`) — 예산 상향/제거로 재개. 집행은 모델 요청 전 게이트(1요청 초과 허용). [확실] (platform.claude.com Managed Agents 문서 — claude-api 스킬 §Session budgets, 2026-08-14)
- 코드 실행 샌드박스: 조직당 월 1,550시간 무료 후 $0.05/시간. [확실] (같은 출처)

### 2.5 Grok Bot — 상시 구동 봇, 번들 전용 진입
- 단독 구독 없음. 진입로 3개: **Cursor Premium Teams $120/시트 · Cursor Ultra $200 · SuperGrok Heavy ~$300**. Cursor Teams Standard($40)는 트라이얼/온디맨드만. [확실-2차] (https://www.eesel.ai/blog/grok-bot-pricing, last edited 2026-08-12, 조회 2026-08-14 — 로컬 정본 `2026-08-12-grok-bot-reverse-teammate-direction.md`의 "$120~300/월" 실측과 일치)
- 주간 사용량 포함(구체 한도 비공개). 초과분: "billed from model and token cost" — Grok 4.6 기준 $2.00/M 입력 · $6.00/M 출력. **"no Grok Bot-specific spend cap yet"** — 상한 없는 종량이 비판점. 모델 선택 불가(저가 모델로 비용 통제 불가). [확실-2차] (같은 출처)
- "각 멤버의 own cloud computer"가 구독에 포함 — **별도 VM 요금 없음**. 상시 구동(always-on) 에이전트라 토큰 소모 변동성이 큼(감시 없는 시간의 소모가 쟁점). [확실-2차]

### 2.6 Replit Agent — 작업 단위의 반면교사
- 2025-06-18 발표(2025-07-02 갱신) effort-based pricing: 고정 $0.25/체크포인트 → **"time and computation"으로 측정한 effort에 비례한 가변 체크포인트 가격**(단순 작업 <$0.25, 복잡 작업 >$0.25, 요청당 체크포인트 1개로 통합). 사용자 통제 레버: "High power model", "Extended thinking". [확실] (https://replit.com/blog/effort-based-pricing, 2026-08-14)
- 반발: 비용을 **작업이 끝난 뒤에야 알게 되는** 구조("the Agent decides how much a task costs and you find out only after it finishes")가 2026년 롤아웃에서 백래시. [추정] (https://www.usecarly.com/blog/replit-agent-pricing-explained/, 2026-08-14)
- Core $20~25/월에 월 크레딧 포함(액수 출처마다 상이). [추정]

### 2.7 Manus / Lovable / v0 — 추상 크레딧 계열
- **Manus**: Free 300 크레딧/일 · $20=4,000 · $40=8,000 · $200=40,000/월(+ 유료는 300/일 리필), 최대 20 동시 태스크. 딥리서치 태스크 1건이 900~1,000+ 크레딧 소모 가능, **실행 전 비용 미고지**가 불만점. [추정] (https://www.lindy.ai/blog/manus-ai-pricing ; https://felloai.com/manus-ai-pricing/, 2026-08-14)
- **Lovable**: Free 5/일(월 30 상한) · Pro $25=100 크레딧/월 · Business $50 · Enterprise. 크레딧 1개월 롤오버, 티어 안 올리고 크레딧 양만 올리는 셀렉터 제공(2026 하반기). [추정] (https://www.eesel.ai/blog/lovable-pricing ; https://www.nocode.mba/articles/lovable-pricing, 2026-08-14)
- **v0 (Vercel)**: Free $5/월 · Premium $20=$20 · Team $30/유저 · Business $100/유저 — 크레딧이 **달러 표시**. 2026-02에 고정 크레딧 수 → 토큰-기반 과금으로 전환(생성 복잡도에 비례). [추정] (https://uibakery.io/blog/vercel-v0-pricing-explained-what-you-get-and-how-it-compares ; https://costbench.com/software/ai-coding-assistants/v0-vercel/, 2026-08-14)

---

## §3. 인프라 원가 캘리브레이션 — 우리가 흡수해야 할 것의 크기

| 공급자 | 단가 | 비고 |
|---|---|---|
| E2B [확실] | vCPU $0.0504/h · RAM $0.0162/GiB/h, 초 단위 과금. **idle도 동일 과금**(살아있으면 지불) | 기본 2vCPU+1GiB ≈ **$0.117/h**. Hobby 무료+1회성 $100 크레딧·동시 20 / Pro $150/월·동시 100(구매로 1,100) (https://e2b.dev/pricing, 2026-08-14) |
| Modal [추정] | CPU ~$0.047/core-h · RAM ~$0.008/GiB-h. **Sandboxes는 non-preemptible 단가**: ~$0.142/core-h + $0.024/GiB-h | idle 미과금(활성 컴퓨트만). 월 $30 무료 크레딧 (https://www.beam.cloud/blog/modal-pricing-explained ; https://costbench.com/software/ai-gpu-cloud/modal/, 2026-08-14) |
| Anthropic 세션 러닝타임 [확실] | **$0.08/h** (list cost 원장 편입 단가) | "관리형 샌드박스 시간의 소매가"에 대한 시장 준거점 |
| NCP (우리 T3 호스트) [추정] | 4vCPU/16GB ≈ 12.4만~12.7만원/월(2026-02 기준) → ADR-0156 발주 사양(8~16vCPU/32GB+데이터디스크 200GB) **월 25만~35만원대 추정** | (https://www.speedykorea.com/blog/representative-cloud-price-comparison ; https://picory.com/entry/가격비교-주요-가상서버-호스팅-업체-4vCPU16GB-월-요금-비교, 2026-08-14. 정확 견적은 ncloud 계산기 필요) |

**우리 unit economics 추정** [추정 — 검산용]: 호스트 월 30만원(≈$215) ≈ $0.29/h. ADR-0156 실측(세션당 워킹셋 ~834MB, 32GB=동시 ~14세션) 기준 **만석 시 세션-시간당 인프라 원가 ≈ $0.021/h**. 가동률 25%로 보수 잡아도 ≈ $0.08/h — **Anthropic의 $0.08/h 소매가·E2B의 $0.117/h와 같은 자릿수**. 즉 "세션-시간을 시간당 정액으로 크레딧 원장에 접는" 설계는 우리 원가 구조에서 성립한다(마진은 가동률 관리 문제).

---

## §4. 패턴 정리

1. **번들 선차감 → 동일 단가 종량**: Cursor(on-demand at same API rates) · Codex(크레딧 구매) · Claude(usage credits at API rates) · Grok(on-demand model cost) · Devin(extra at API pricing). 번들이 소진되기 전에는 종량이 시작되지 않고, 종량 단가는 번들 환산 단가와 동일(품질 다운그레이드 없음)이 표준.
2. **클라우드 에이전트 = 유료 티어 게이트**: Cursor "You need to be on a paid Cursor plan" · Grok Bot $120+ 전용 · Devin 동시성 티어 차등 · Codex는 Plus부터 실사용 가능. 무료 티어는 셀프/로컬 표면 또는 소량 체험만.
3. **"별도 VM 요금 없음" 메시징**: 사용자 멘탈 모델을 "나는 모델 사용량(또는 크레딧)만 산다"로 고정. 인프라는 (a) 구독 마진에 흡수(Cursor/Codex/Grok)하거나 (b) 시간당 정액으로 같은 원장에 합산(Anthropic $0.08/h — 항목은 보이되 별도 청구서는 아님).
4. **공정사용 장치의 표준 셋**: 5시간 롤링 윈도우(Codex/Claude) · 주간 한도(Claude 이중, Grok) · 동시성 상한(Devin 10, Manus 20, E2B 20/100) · **지출 한도 설정 강제**(Cursor 클라우드 에이전트 첫 사용 시) · 일일 상환 상한(Claude $2,000/일) · 진행 중 턴 완료 보장(Codex). 반례: Grok Bot의 "no spend cap"은 즉시 비판 대상.
5. **단위의 진화 방향**: 불투명 고정 단위(ACU, 고정 체크포인트, 고정 크레딧 수) → **비용 반영형 토큰/달러 단위**(Devin·v0·Codex 전환, Cursor는 처음부터). 실행 전 비용 미고지(Manus)·사후 고지(Replit effort)는 반발 포인트. 추상 크레딧을 쓰더라도 **환산표 공개**(Codex)가 방어선.
6. **팀/엔터프라이즈**: 시트당 구독 + 조직 풀링(Codex Business "usage scales with organizational credits", Cursor Teams admin 지출 관리, Devin Teams 무제한 동시성). v0/Lovable은 데이터 옵트아웃을 상위 티어 차별점으로.
7. **예산 도달 시의 상태 설계**: Anthropic은 종료가 아니라 **pause + 재개 가능**(`budget_reached`) — 크레딧 소진이 작업 파괴가 되지 않게. 이는 oort의 ADR-0140 수명주기(pause/resume)와 정확히 동형.

---

## §5. oort 매핑

### 5.1 우리 지형의 특수성
- 셀프호스트는 무료 OSS(#1227~) — 업계의 "무료 티어" 역할을 셀프호스트가 담당하므로, **클라우드에 무료 티어를 둘 압력이 낮다**(Grok Bot 동형).
- 과금 대상 원가는 이중: **NCP 호스트 시간(T3 CubeSandbox, ADR-0156)** + **모델 토큰(bundled provider)**. 단, ADR-0141/0156 D6의 idle sweep·TTL 안전망 덕에 "좀비 세션 과금 폭주"의 기술적 방어선은 이미 있다(E2B처럼 idle을 사용자에게 물릴지는 별개 결정).
- 에이전트 유형별로 원가 구조가 다르다: **관리형**(카탈로그/bundled, ADR-0163 — 우리 컴퓨트+우리 provider 계약) / **연동형**(BYOA·BYOC — 컴퓨트·키 모두 사용자) / **다이얼인형**(ADR-0162 — 컴퓨트가 상대방(xAI 등)에 있음).

### 5.2 원가 이중성을 하나의 크레딧으로 접는 3안 (결정 큐 ③의 본문)

| 안 | 설계 | 장점 | 단점 | 업계 준거 |
|---|---|---|---|---|
| **3-A. list-cost 원장** (권고) | 크레딧=원화/달러 표시. 차감 = 모델 토큰×정가 + 세션 러닝타임×시간당 정액(예: $0.08/h 상당) (+후속: 웹서치 등 건당) | 이중 원가가 하나의 통화로 정직하게 접힘 · 마진을 단가에 내장 가능 · Anthropic 검증 구현 존재 · 예산 게이트=pause(ADR-0140 동형) | 사용자에게 두 개 항목이 보임(단, "별도 청구"가 아니라 "같은 지갑의 두 소모처") · 러닝타임 미터링 구현 필요(workd 하트비트 기반 — 이미 있음) | Anthropic Managed Agents [확실] |
| **3-B. 토큰 단독 차감 + 인프라 흡수** | 크레딧은 모델 토큰만 차감. NCP 시간은 구독가 마진에 흡수, idle sweep·동시성 상한·세션 TTL로 방어 | 성재 앵커(Cursor 감각)와 가장 근접 · 멘탈 모델 최단순("모델만 산다") | 토큰을 적게 쓰며 오래 켜두는 워크로드(대기형 팀메이트!)에 역마진 — **oort의 상시 멤버형 에이전트 특성과 충돌 위험** · 방어를 전부 fair-use 정책에 의존 | Cursor·Codex·Grok [확실] |
| **3-C. 작업/시간 정규화 단위** (비권고) | "1크레딧=활성 N분" 식 ACU형 단위로 토큰+시간을 은닉 | 단위 하나로 단순 · 마진 자유도 최대 | 환율 불신·예측불가 반발 전례(Devin 후퇴, Replit 백래시) · 모델 단가 변동 시 환율 재조정 부담 | Devin 구형·Replit [확실/추정] |

판단 메모: oort 에이전트는 IDE 태스크(짧은 버스트)가 아니라 **워크스페이스 상주 멤버**(긴 유휴+간헐 버스트)라서, 시간 축을 과금에서 완전히 지우는 3-B는 abuse 표면이 크다. 3-A로 접되 **idle(paused) 시간은 무과금·running 시간만 과금**(pause/resume가 이미 1급 수명주기이므로 가능 — E2B와 달리 "살아만 있어도 과금"을 피할 수 있는 것이 우리 구조적 강점)으로 하면 Cursor식 멘탈 모델("인프라 요금 따로 없음")과 원가 회수를 동시에 잡는다.

### 5.3 ADR-0004과 bundled 모델의 정합 (결정 큐 ④의 본문)
- ADR-0004의 불변식은 정확히는 "**사용자/제3자 provider 자격증명이 oort 서버에 유입되지 않는다**"이다(Codex OAuth·OpenAI 키의 비소유·비저장·비로깅). bundled에서는 **oort(운영자)가 provider 계약 주체**가 되어 자기 명의의 키를 쓰므로, 이 키는 "유입되는 사용자 자격증명"이 아니라 **운영자 소유 서버 시크릿**이다 — 웹훅 마스터키·`HERMES_API_KEY`와 같은 부류. 증보 1(D2)이 이미 "opaque bearer의 암호화 DB 보관"을 열어놨으므로 구조적 선례도 있다.
- 재서술 제안(증보 2 후보): ①불변(그대로) — 사용자의 provider OAuth 토큰·API 키는 비유입, GUI에 그 입력 필드를 만들지 않는다. ②신설 — **운영자-소유 bundled provider 키**는 서버 시크릿 규율(별도 마스터키 암호화·로그/evidence/Context Packet 비유입·마스킹 조회·교체=재입력)로 보유 가능하며, 사용량은 워크스페이스별 크레딧 원장에 귀속 계량한다. ③경계 — 사용자 BYO-key(자기 키 입력으로 크레딧 차감 회피) 경로는 본 재서술로 열리지 않음 — 도입하려면 별도 ADR(자격증명 저장 표면 + 과금 우회 정책 동시 결정 필요).
- 과금 함의: bundled에서 토큰 원가는 우리 청구서로 오므로 크레딧 차감이 필수(3-A/B의 전제). BYO-key를 허용하면 토큰 차감분이 0이 되고 인프라만 남아 — 3-B(토큰 단독)와 조합 시 **과금이 통째로 사라지는** 모순이 생긴다. BYO-key를 열려면 최소한 인프라 축 과금(3-A의 러닝타임 항목)이 함께 있어야 한다.

### 5.4 HAP 유형별 과금 경계 (결정 큐 ⑤의 본문)

| 유형 | 컴퓨트 | 모델 키 | oort 크레딧 차감 | 과금 근거 |
|---|---|---|---|---|
| 관리형 (카탈로그/bundled, ADR-0163+0156) | 우리 NCP T3 | 우리(운영자) 계약 | **차감** (토큰+러닝타임, 3-A 기준) | 유일한 크레딧 소모처 — 관리형 클라우드의 본체 |
| 연동형 (BYOA/BYOC, ADR-0142) | 사용자 | 사용자 (비유입, ADR-0004 그대로) | **비차감** | relay/전송 원가는 미미 — 메신저 구독(좌석)에 흡수. Grok Bot이 Cursor에게 그렇듯, 외부 호스팅 에이전트의 접속 자체는 과금하지 않는 것이 표면 선점에 유리 |
| 다이얼인형 (Agent Port, ADR-0162) | 상대방(xAI 등) | 상대방 | **비차감** | 위와 동일 — Agent Port는 무료 표면으로 유지해 "호스팅 에이전트가 다이얼인해 일하는 첫 메신저" 실익을 극대화 |

즉 크레딧 시스템은 관리형 전용으로 설계하면 되고, 연동/다이얼인은 메신저 자체의 티어(좌석·워크스페이스)로 흡수 — 두 축(메신저 구독 vs 에이전트 크레딧)의 분리가 유지된다.

---

## §비교표

| 제품 | 진입가(클라우드 에이전트) | 번들 | 과금 단위 | 초과분 | 인프라 별도 과금 | 공정사용 장치 | 신뢰도 |
|---|---|---|---|---|---|---|---|
| Cursor | Pro $20~ (유료 필수) | $20/$70/$400 상당 사용량 | 달러 표시 토큰(모델 API 단가) | 동일 단가 on-demand | **없음** | 지출 한도 설정 강제 | 확실 |
| Devin | Pro $20 / Max $200 | 일·주 리필 허용량 | (구)ACU≈15분 → (현)API 단가 | API pricing | 없음(ACU 시절 VM 포함) | 동시 10(개인) | 확실+추정 |
| OpenAI Codex | Plus $20~ | 플랜 크레딧(5h 윈도우) | 토큰-기반 크레딧(환산표 공개) | 크레딧 구매/업그레이드 | **없음(명문)** | 5h 롤링·턴 완료 보장 | 확실 |
| Claude Code | Pro $20 / Max $100·$200 | 승수(1x/5x/20x) | 비공개 쿼터(승수만) | API 단가, $2,000/일 상한 | 없음 | 5h 세션+주간 이중 한도 | 확실+추정 |
| Grok Bot | $120(시트)/$200/$300 | 주간 허용량(비공개) | 토큰(Grok 4.6 $2/$6 per M) | 모델 단가, **상한 없음** | 없음("own cloud computer" 포함) | 주간 한도만 | 확실-2차 |
| Replit Agent | Core $20~25 | 월 크레딧 | effort-기반 체크포인트(가변) | 크레딧 추가 | 없음 | — (사후 고지가 반발점) | 확실+추정 |
| Manus | $20/$40/$200 | 4k/8k/40k 크레딧+300/일 | 추상 크레딧 | 크레딧 추가 | 없음 | 동시 20 | 추정 |
| Lovable | Pro $25 | 100 크레딧/월 | 추상 크레딧(1개월 롤오버) | 크레딧 셀렉터 | 없음 | 일일 상한(무료) | 추정 |
| v0 | Premium $20 | $20 상당 | 달러 크레딧(토큰 기반) | 크레딧 구매 | 없음 | — | 추정 |
| (준거) Anthropic MA | — | — | **USD list cost = 토큰 정가 + 러닝타임 $0.08/h** | 예산 도달=pause | 원장 내 항목화 | 예산 게이트·pause/재개 | 확실 |
| (원가) E2B | Pro $150 | 1회성 $100 | vCPU·GiB 초 단위 | 종량 | (자체가 인프라) | 동시 20/100, idle도 과금 | 확실 |
| (원가) Modal | $0 | $30/월 | core·GiB 초 단위(샌드박스는 3x) | 종량 | (자체가 인프라) | idle 무과금 | 추정 |

---

## §성재 결정 큐

1. **과금 단위** — (A) 달러/원화 표시 크레딧 + list-cost 원장(토큰 정가 + 러닝타임 정액; Anthropic 동형) ← 권고 / (B) 토큰 단독 차감·인프라 흡수(Cursor 동형 — 상주형 에이전트 abuse 표면 큼) / (C) ACU형 작업 단위(업계 이탈 방향 — 비권고). **A로 가되 "running만 과금·paused 무과금"으로 Cursor식 '인프라 요금 없음' 감각을 보존하는 절충을 제안.**
2. **티어 구조** — 셀프호스트=무료 OSS(불변) 위에서: (i) 클라우드 단일 유료 티어 + 크레딧 팩 추가 구매(단순, Lovable 셀렉터형) vs (ii) 2~3 티어 승수형(Claude/Codex형 — 5x/20x). v0(관리형 클라우드 초기)에는 (i) 권고 — 티어 분화는 사용 분포 실측 후. 무료 체험은 "1회성 크레딧"(E2B의 one-time $100형)으로 한정해 상시 무료 클라우드를 만들지 않는다.
3. **원가 이중성 접기** — §5.2의 3안 중 택1. 러닝타임 단가 책정 시 준거: 우리 원가 만석 ≈$0.02/세션-h·보수 ≈$0.08/세션-h [추정], 시장 소매가 $0.08(Anthropic)~$0.12(E2B)/h. idle을 과금할지(E2B형) 말지(권고: 무과금 — pause 수명주기가 우리 강점)도 이 항목에서 함께.
4. **ADR-0004 증보 2 승인 여부** — "사용자 자격증명 비유입(불변) + 운영자-소유 bundled provider 키=서버 시크릿 규율로 보유·계량"의 재서술(§5.3). BYO-key 경로는 이번에 열지 않음(열려면 별도 ADR — 과금 우회 정책 동시 결정).
5. **HAP 유형별 경계 확정** — 크레딧 차감=관리형 전용, 연동형·다이얼인형=비차감(메신저 구독에 흡수)의 §5.4 표. 특히 Agent Port 무료 유지가 표면 선점 전략과 결부됨을 명시적으로 승인받을 것.
6. **공정사용·한도 장치의 v0 셋** — 업계 표준에서: 워크스페이스 지출 한도(설정 강제 — Cursor형) · 크레딧 소진 시 pause+재개(Anthropic형, ADR-0140 동형) · 동시 세션 상한=capability 주입(ADR-0156 D6① 그대로) · 진행 중 턴 완료 보장(Codex형). Grok의 "no spend cap"을 반면교사로, **지출 상한은 v0부터**.
7. **크레딧 수명 정책** — 롤오버(Lovable 1개월) vs 소멸 vs 일일 리필(Manus). 원화 결제·전자상거래법상 소멸 정책의 법무 확인 필요(미조사 — 후속 리서치 항목).

## 미해결/후속
- NCP 정확 견적(ncloud 계산기 — 발주 사양 기준) 미실측.
- Cursor Teams "Token Rate $0.25/M"의 공식 문서 확인 미완(2차 출처만).
- 한국 결제·크레딧 소멸 관련 규제(전자금융·전상법) 미조사.
- Devin 현행 플랜의 일·주 리필 허용량 구체 수치 비공개 — 실계정 실측 필요 시 별도.
