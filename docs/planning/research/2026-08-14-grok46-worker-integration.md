# Grok 4.6 워커 편입 + 제품 provider 경로 리서치

- 작성: 2026-08-14 (deep-research, 조회일 전부 2026-08-14)
- 발제: 성재 — "SuperGrok 구독 시작. Grok 4.6(high/fast)을 (A) 개발 파이프라인 워커(현행: Opus 5=Claude Code 구독, GPT 5.6 sol=Codex CLI `codex exec` 구독 OAuth)로, (B) oort 제품 LLM provider로 편입 가능한지."
- 선행 정본: `2026-08-12-grok-bot-integration-feasibility.md`(Grok Bot 인바운드 불가 판정) · `2026-08-14-agent-cloud-credit-billing-models.md`(Grok Bot 과금) · ADR-0004(provider 경계) · ADR-0162(Agent Port)
- 표기: **[확실]** = 공식 문서/페이지 실측, **[확실-2차]** = 복수 2차 출처 일치, **[추정]** = 단일 2차/계산 추정.
- 핵심 갱신: 08-12 리서치의 "공식 표면 전무" 판정은 **Grok Bot(봇 개체)에 한정된 것이었다.** 이번 실측으로 **Grok Build(공식 CLI, 구독 인증, 헤드리스 명문 지원)**가 별도로 존재함이 확정 — `codex exec`의 xAI 등가물이 이미 있다.

---

## §1. Grok 4.6 자체 (축 1)

- **출시**: 2026-08-12, Grok 4.5(07-08) 후 35일 만의 포스트트레이닝 업그레이드. "long-running agents and more ambitious interactive and visual work" 초점. [확실] (x.ai/news/grok-4-6)
- **스펙**: 컨텍스트 **500K 토큰**, text+image 입력 → text 출력, 출력 길이 제한 없음, function calling/structured output/reasoning 지원. [확실] (docs.x.ai/developers/models/grok-4.6)
- **variants — "high/fast"의 정체**:
  - **reasoning effort 파라미터**: `low / medium / high(기본) / xhigh` — 4.5의 3단에 xhigh 신설. 앱에서 보이는 "high"는 이 축. [확실] (docs.x.ai/developers/release-notes)
  - **fast variant**: 동일 모델의 고속 서빙 티어, **가격 2배**($4/$1/$12). 앱의 "fast"는 이 축. [확실] (x.ai/news/grok-4-6 "A fast variant is available at twice the price") — API 모델 id가 `grok-4.6-fast`인지는 미확인(실측 큐 #4). [추정]
- **API**: 모델 id `grok-4.6`, **$2 input / $0.50 cached / $6 output per 1M** (프롬프트 200K 미만), **$4/$1/$12** (200K 이상 — 도달 시 전체 토큰이 상위 단가). 레이트리밋 150 req/s · 50M tokens/min. 리전 us-east-1/us-west-2. [확실] (docs.x.ai/developers/models/grok-4.6)
- **벤치마크** (공식 발표치): AA Intelligence Index **61**(4.5=56, **GPT-5.6 Sol과 동률**) · GDPVal-AA v2 1753 · CursorBench v3.2 69.9% · DeepSWE v1.1 65.9% · FrontierCode v1.1 61.3% · Terminal-Bench v3.0 26%(4.5=15.7% — 크게 올랐으나 절대치는 낮음). [확실] (x.ai/news/grok-4-6) SWE-bench(Vals) **95.6%** — Opus 5 97.0%에 근접 2위권. [확실-2차] (vals.ai/benchmarks/swebench, codersera)
- **가용 표면**: grok.com/X/iOS 앱(SuperGrok 티어) · **Grok Build**(출시일 동시) · **Cursor**(출시일 동시, SpaceXAI 공동 발표) · xAI API(console.x.ai) · OpenRouter/Vercel/Cloudflare. 출시 첫 주 Cursor·Grok Build **2x 사용량** + API 50% 할인. [확실] (x.ai/news/grok-4-6, cursor.com/blog/grok-4-6)
- 파라미터 1.5T 설. [추정] (kie.ai, tbreak — 공식 미확인)

## §2. SuperGrok 구독의 programmatic 접근 (축 2) — **공식 CLI가 존재한다**

### 2.1 Grok Build = 공식 xAI 코딩 에이전트 CLI
- 설치 `curl -fsSL https://x.ai/cli/install.sh | bash`, 실행 `grok`. **`grok login` 1회 브라우저 OAuth → 토큰이 `~/.grok/auth.json`에 캐시** — Claude Code/Codex CLI와 동형의 구독 로그인. [확실-2차] (buildfastwithai, codersera — 공식 install 스크립트 URL 일치)
- **자격**: SuperGrok $30 / X Premium+ $40 / SuperGrok Heavy $300 (프로모 "SuperHeavy" $99×6개월 [추정]). **SuperGrok $30에 Grok Build 포함** — 사용량은 Chat/Imagine/Voice/Build **공용 주간 풀**에서 차감(2026-06부터 2시간 캡 폐지). 티어별 정량 쿼터는 **비공개**("higher rate limits" 서술뿐). [확실-2차] (felloai.com/grok-pricing, shareallai guide)
- **헤드리스가 공식 문서화됨** — docs.x.ai/build/cli/headless-scripting [확실]:
  - `grok -p "<prompt>"` 단발 실행 · `-m <model>` 모델 선택 · `--output-format plain|json|streaming-json` · `--always-approve`(도구 자동 승인) · `--cwd <path>` · `-s/-r` 세션 생성/재개 · `--no-auto-update`(CI 권장) · `grok agent stdio`(ACP)
  - 헤드리스 인증 = **`XAI_API_KEY` 또는 `grok login`의 cached_token** — 즉 **구독 토큰의 헤드리스 사용이 공식 지원**.
- 기능: 8 병렬 서브에이전트, plan-first, Arena Mode, **CLAUDE.md/.claude(skills·agents·MCP·hooks)/AGENTS.md 자동 인식**(zero config) — 우리 레포 규약을 그대로 읽는다. [확실-2차] (buildfastwithai)
- 별도 저가 코딩 모델 `grok-build-0.1`(API $1/$0.20/$2 + tool call $5/1k)도 존재, 4.6과 `/model`로 전환. [확실-2차] (shareallai, hermes-agent 모델 목록)

### 2.2 SuperGrok ↔ API 분리 (확정)
- **SuperGrok에 API 크레딧 없음.** 구독(grok.com/앱/Build)과 api.x.ai(console.x.ai, 선불 $25~ 자동충전)는 **완전 별도 과금 표면**. [확실-2차] (felloai, kilo.ai/docs/ai-providers/xai)

### 2.3 서드파티 하네스의 구독 OAuth (공식 vs 커뮤니티)
- xAI는 **2026-05 first-party 구독 OAuth**를 출시(디바이스코드 플로우, accounts.x.ai) — Hermes Agent(구 OpenClaw 계열)가 canonical reference. 이후 **Kilo Code·Warp**가 공식 문서로 SuperGrok/X Premium+ 구독 로그인을 지원(헤드리스=디바이스코드). [확실] (kilo.ai/inference/subscriptions/supergrok, docs.warp.dev/agent-platform/inference/grok-subscription, openclawai.io 블로그)
- 단 **xAI 백엔드가 OAuth API 표면에 자체 allowlist를 강제** — "표준 SuperGrok 구독자를 HTTP 403으로 거절한 사례"가 보고됨(로그인은 성공, 추론에서 403). 즉 서드파티 하네스 경로는 **계정/클라이언트별 게이팅이 있는 조건부**. [확실] (hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth) 동시 프로세스에서 **refresh 토큰 로테이션으로 재인증 요구** 가능. [확실] (Kilo 문서)
- 커뮤니티 도구: pi-grok/oh-my-pi(OAuth 계열 — first-party 플로우 재사용) vs 계정 쿠키 스크레이핑 계열(grok-bypass류) — 후자는 AUP 정면 저촉·계정 정지 리스크(§6). [확실-2차]

## §3. OAuth 현황 재실측 (축 3)

- **"Sign in with xAI" 일반 공개는 여전히 없음** — 존재하는 것은 (a) Grok Build 자체 로그인, (b) allowlist된 하네스 대상 first-party 디바이스코드 OAuth(모델 추론 용도) 둘뿐. 임의 서드파티 앱에 봇/계정 접근을 위임하는 OAuth는 부재 — 08-12 판정 유지. [확실]
- **MCP 클라이언트**: Grok 앱/Grok Bot의 **Bring Your Own MCP(커스텀 원격 커넥터)** 유지 — 4대 어시스턴트(Claude/ChatGPT/Gemini/Grok) 중 4번째로 커스텀 MCP 클라이언트 표면 보유. 커넥터 30종+내장 스킬 5종. [확실-2차] (awesome-grok-connectors, techtimes) → 우리 Agent Port `/v1/mcp/agent-port`를 물릴 수 있는 표면은 계속 유효.
- 4.6 롤아웃으로 바뀐 것: 모델·CLI 가용성뿐, **인증 표면 변화 없음**. [확실] (docs.x.ai/developers/release-notes)

## §4. Grok Bot as worker (축 4)

- **접근 티어가 벽**: 베타 접근 = **SuperGrok Heavy $300 / Cursor Ultra $200 / Cursor Teams Premium $120/석** 한정. **SuperGrok $30·Plus $100은 미포함.** 성재 현 구독으로는 진입 불가. [확실-2차] (venturebeat, digitalapplied, moclaw)
- 능력 면: 클라우드 컴퓨터에 "browser, **command line**, files, connected tools" — 터미널이 있으므로 git clone/편집은 **개연성 높음**(문서 미명기, [추정]). `/workspace` 영속, 브라우저 세션 영속, 계정당 1 VM 공유(봇별 스크린 분리). 세션/리소스 정량 한도 미공개. [확실] (docs.x.ai/grok-bot/computer-and-apps)
- worker로서의 구조적 한계(08-12 판정 유지): 외부 트리거 불가(이벤트=Cursor 통합 폐쇄 목록 — 루틴 스케줄/사용자 지시뿐), 출력 회수는 MCP 커넥터(우리 Agent Port) 경유로 우회 가능하나 **spawn-검수 루프의 결정권을 우리가 쥘 수 없음**, spend cap 부재. 리뷰체인 편입에는 부적합 — "제3의 상주 팀메이트" 데모로는 흥미롭지만 dev-worker 규율(발사·회수·게이트)이 성립하지 않는다.

## §5. Cursor 경유 경로 (축 5)

- **Grok 4.6은 Cursor에 출시일 동시 탑재** — Cursor·SpaceXAI 공동 릴리스("Today we are releasing Grok 4.6 together with SpaceXAI" — 두 회사는 합병 진행 중). desktop/web/iOS/**CLI**/SDK 전 표면. [확실] (cursor.com/blog/grok-4-6, cursor.com/grok)
- **Cursor 요금 취급**: Grok 4.6은 "**Cursor Models pool** on individual and team plans"(Grok 4.5·Composer 2.5와 동렬) — 서드파티 모델의 $-allowance 차감과 다른, 자사 모델급 포함 풀로 보임(합병 효과). [확실 인용/해석은 추정] on-demand 초과분은 API 단가($2/$6, fast 2x). effort 4단 + 속도 티어(Fast가 Pro+에서 기본). 첫 주 50% 할인. [확실] (cursor.com/docs/models/grok-4-6)
- **CLI**: `cursor-agent -p "<prompt>" --model <m> --output-format json|text` + `--force/--yolo`(파일 수정 허용) — 헤드리스 공식 문서화. 모델 목록은 `cursor-agent --list-models`로 동적 갱신(grok 계열 포함). Cloud Agents는 SDK `Agent.create({cloud})`로 스폰 가능, 유료 플랜 필수·선택 모델 API 단가 차감(선행 리서치 §2.1). [확실] (cursor.com/docs/cli/{overview,using,headless}, cursor.com/cloud)
- 의미: **xAI 인증을 전혀 건드리지 않고** "Cursor CLI + grok-4.6"으로 sanctioned worker가 성립한다. 비용은 Cursor 플랜 토큰/온디맨드 차감 — Grok Build(구독 정액 풀)보다 경제성 열위일 수 있으나, Cursor Models pool 포함이면 역전 가능(실측 필요).

## §6. ToS/AUP — 경로별 리스크 (축 6)

- 기준 문서: xAI AUP(2026-06-26 발효)·소비자 ToS — 08-12 Wayback 실측 유지(automated access 금지·자격증명 공유 금지·베타=개인 비상업). 이번 조회에서 x.ai/legal 라이브 fetch는 403 — 조항 변경 여부는 미재확인. [확실(08-12 스냅샷)/미갱신]
- 해석 갱신: AUP의 "automated/non-human access" 금지는 **비공식 우회(스크레이핑·쿠키·리버스)를 겨냥한 것**이고, **공식 도구의 헤드리스 사용은 xAI 자신이 문서화**(docs.x.ai/build/cli/headless-scripting의 CI 가이드)했으므로 sanctioned. first-party OAuth를 받은 하네스(Kilo/Warp/Hermes)도 sanctioned-조건부(allowlist). [확실]
- 경로별 계정 리스크:
  - Grok Build 헤드리스(구독 캐시 토큰): **낮음** — 공식 문서 경로 그대로. 남는 회색지대는 "베타 기능=개인 비상업" 조항이 Build에 적용되는지(Build는 5월 출시로 베타 딱지 여부 불명 [추정]) + 주간 풀 fair-use.
  - 서드파티 하네스 OAuth: **중간** — first-party 플로우라도 allowlist 403 전례·토큰 로테이션 이슈. xAI가 클라이언트 단위로 잠글 수 있음.
  - 쿠키/리버스 커뮤니티 CLI: **높음(채택 금지)** — AUP 3중 저촉, 08-12 판정 유지.
  - Cursor 경유: **최저** — xAI 약관 비적용(Cursor 약관만), 합병 당사자의 공식 제품.
  - Grok Bot 자동화 재노출: 08-12 판정 유지(불가).
  - 계정 공유: 성재 개인 계정 토큰을 오케스트레이터 머신 1대에서 쓰는 것은 Claude Code/Codex와 동일 형태 — 멀티 머신 동시 사용은 자격증명 공유 조항 리스크. [추정]

## §7. 제품 provider 경로 B (축 7)

- **api.x.ai는 OpenAI 호환**: base URL `https://api.x.ai/v1`, OpenAI SDK로 `chat.completions.create(stream=True)` — **SSE 청크가 OpenAI Chat Completions 스펙 그대로**. (xAI는 Responses API 이행 가이드도 제공 — chat completions는 legacy 분류이나 동작.) [확실] (docs.x.ai/developers/model-capabilities/text/streaming, legacy/chat-completions)
- 따라서 **ADR-0004 경계에 무수정 드롭인**: `HERMES_BASE_URL=https://api.x.ai/v1` + opaque bearer(`XAI_API_KEY`) 형태로 기존 OpenAI-호환 SSE 경계에 그대로 붙는다. 운영자 bundled 키로 쓰면 증보 2 규율(서버 시크릿·ledger 계량) 적용 대상.
- 과금: SuperGrok과 **완전 분리**(구독에 API 크레딧 없음). 선불 $25~ 자동충전. grok-4.6 $2/$0.5/$6(<200K)·$4/$1/$12(≥200K), fast 2x. 레이트리밋 150 rps/50M TPM은 provider로 충분. 엔터프라이즈 ToS가 API 경유 번들 재노출("Bundled Services")을 명시 허용 — 08-12 실측 유지. [확실]
- 비용 포지션: Opus 5 $5/$25 대비 입력 2.5x·출력 4x 저렴, GPT-5.6 계열과 동급 지능(AA 61 동률) — **카탈로그(ADR-0163) 저가-고지능 슬롯 후보**.

---

## §판정

| 경로 | 판정 | 리스크 | 비용 | 근거 요약 |
|---|---|---|---|---|
| **1. Grok Build 헤드리스 worker** (공식 CLI) | **성립 — 최유력** | 낮음(공식 헤드리스 문서화) | SuperGrok $30 기존 구독 내 주간 풀(쿼터 비공개) | `grok login` 구독 OAuth + `grok -p -m grok-4.6 --output-format streaming-json --always-approve` — `codex exec` 완전 동형. CLAUDE.md/AGENTS.md 자동 인식 |
| 2. 서드파티 하네스 OAuth (Kilo/Warp/Hermes) | 조건부 | 중간(allowlist 403 전례·토큰 로테이션) | 구독 풀 | first-party 디바이스코드 OAuth 존재하나 계정별 게이팅. Grok Build가 있는 이상 채택 이유 없음 |
| 3. 쿠키/리버스 커뮤니티 CLI | **불가(채택 금지)** | 높음(AUP 3중 저촉·계정 정지) | — | 08-12 판정 유지 |
| 4. Grok Bot + MCP worker | 불가(현 구독) / 조건부(업그레이드 후에도 비권고) | 중간 + spend cap 부재 | Heavy $300 또는 Cursor Ultra $200/Teams Premium $120 필요 | SuperGrok $30 미포함. 접근해도 외부 트리거 불가·회수 루프 불성립 — worker 규율 안 섬. Agent Port 다이얼인 데모 소재로만 |
| 5. Cursor CLI vehicle (`cursor-agent --model grok-4.6`) | **성립 — 보조** | 최저(xAI 약관 무관) | Cursor 플랜 차감(Cursor Models pool 포함 여부 실측 필요, 온디맨드=API 단가) | 출시일 동시 탑재·CLI/Cloud Agents 공식. Grok Build 장애/쿼터 소진 시 대체로 |
| 6. api.x.ai 제품 provider (B) | **성립 — as-is** | 낮음(엔터프라이즈 ToS 명시 허용) | 종량 $2/$6(<200K), 선불 계정 별도 | OpenAI-호환 SSE + bearer → ADR-0004 무수정 드롭인. SuperGrok과 과금 완전 분리 확인 |

## §편입 설계안 — grok-fleet (codex-fleet 미러)

**역할 분담 권고** (측정된 강점 기반):
- **1순위 — 리뷰어 C (제3 독립 렌즈)**: 현행 체인 Opus 5(구현) → sol(freeze 리뷰)에 **3사 모델 계열(Anthropic/OpenAI/xAI) 삼각 리뷰**를 추가. 리뷰는 blast radius가 작아 품질 미검증 상태로 즉시 투입 가능, AA 61=sol 동률이라 렌즈 가치 있음.
- **2순위 — 500K 롱컨텍스트 스윕 전담**: 레포 전체/대량 로그/장문 문서 일괄 분석 — Opus(200K)·sol 대비 유일 우위 축. 리서치 보조 겸직.
- **보류 — speed-tier 구현**: SWE-bench 95.6%로 수치는 근접하나 Terminal-Bench 26%(터미널 조작 절대치 낮음) — 게이트 통과율 실측 전 구현 티켓 투입은 비권고. fast variant는 실측 후 경량 티켓용으로 재검토.

**spawn 규율** (codex-fleet §과 동형):
```bash
# 1회 셋업 (성재 대행: 브라우저 로그인)
curl -fsSL https://x.ai/cli/install.sh | bash && grok login   # → ~/.grok/auth.json

# worker 발사 (백그라운드, goal 단위 — worker-launch-requires-go 규율 그대로)
grok --no-auto-update \
  -p "$(cat handoff-packet.md)" \
  -m grok-4.6 \
  -s goal-NNN \
  --cwd ~/projects/momo-tracks/<worktree> \
  --always-approve \
  --output-format streaming-json > /tmp/grok-goal-NNN.jsonl 2>&1 &
```
- **출력 회수**: streaming-json을 jsonl로 캡처 → 오케스트레이터가 파싱해 diff 리뷰→게이트→PR 체인에 투입. 세션 재개는 `-r goal-NNN`.
- **가드레일**: `--always-approve`는 트랙 워크트리 안에서만 · 시크릿 env 비주입 · worker는 merge/close 금지(기존 하드 룰 승계) · 병렬은 **1~2부터**(xAI refresh 토큰 로테이션이 동시 프로세스 재인증을 유발한 전례 — Kilo 문서) · 주간 공용 풀이라 Chat/Imagine 사용과 쿼터 경합함을 성재에게 고지.
- **리뷰어 C 모드**: 구현 대신 read-only 프롬프트(diff+패킷 → 판정서)로 시작 — `--always-approve` 불요, 리스크 최소.

## §실측 큐 (순서대로 — ★=성재 대행 필요)

| # | 명령/행동 | 결정되는 것 |
|---|---|---|
| 1 | `curl -fsSL https://x.ai/cli/install.sh \| bash && grok --version` | CLI 실재·버전 |
| 2★ | `grok login` (브라우저 승인) — SuperGrok $30 계정으로 | **$30 티어에서 Build 인증 성립 여부**(전 경로의 전제) |
| 3 | 스크래치 레포에서 `grok --no-auto-update -p "이 레포 구조 요약" -m grok-4.6 --output-format streaming-json` | 캐시 토큰 헤드리스 동작 + 모델 지정 = **worker 성립** |
| 4 | `grok` TUI에서 `/model` 목록 (+ `grok -m grok-4.6-fast -p ...` 시도) | fast/effort 노출·모델 id 확정 |
| 5 | 동일 프롬프트 2프로세스 병렬 | refresh 로테이션 충돌 재현 → 병렬 상한 결정 |
| 6 | `cursor-agent --list-models \| grep -i grok` | Cursor 경로 모델 라벨 실재 |
| 7 | `cursor-agent -p "..." --model grok-4.6 --output-format json` + 대시보드 사용량 확인 | Cursor vehicle 성립 + **Cursor Models pool 차감인지 온디맨드인지** |
| 8★ | console.x.ai 가입·키 발급 → `curl https://api.x.ai/v1/models -H "Authorization: Bearer $XAI_API_KEY"` + SSE chat 1회 | 경로 B 드롭인(기존 `verify_external_agent_provider.sh` 재사용 가능) |
| 9★ | grok.com 앱에서 4.6 high/fast 셀렉터 스크린샷 | 앱 variant 표기 실측 |
| 10 | (보류) Grok Bot — 티어 업그레이드 결정 시에만 | Agent Port 다이얼인 데모 가치 |
| 11 | 리뷰어 C 파일럿: 최근 머지된 PR 1건의 diff를 3자(sol/grok) 동시 리뷰시켜 판정 비교 | 렌즈 가치 정량화 → 역할 확정 |

## §성재 결정 포인트

1. **grok-fleet 도입 여부와 첫 역할** — 권고: 리뷰어 C(read-only)로 시작, 게이트 통과율 실측 후 구현/스윕 확대. (실측 2·3 통과가 전제)
2. **주력 vehicle** — Grok Build(구독 정액, 권고) vs Cursor CLI(플랜 차감, 백업). 성재 Cursor 플랜 등급 확인 필요(Cloud Agents·Grok Bot 게이팅과 결부).
3. **Grok Bot 티어 업그레이드($120~300)** — 권고: 보류. worker 규율 불성립이라 데모 가치뿐. Agent Port 상호운용 데모가 필요해지는 시점에 재검토.
4. **제품 provider(B)** — xAI를 카탈로그(ADR-0163) bundled provider 후보에 편입할지. ADR-0004 무수정 드롭인 확인됨 — 편입 시 증보 2 ledger 규율 적용. 별도 결정으로 분리.
5. **계정 리스크 수용선** — 공식 CLI·Cursor 경로만 사용(권고), 서드파티 OAuth 하네스·쿠키 CLI 불채택 확인.
6. **주간 풀 경합 고지** — Build 워커 사용량이 성재의 Chat/Imagine 사용과 같은 주간 풀을 소모 — 소진 시 업그레이드(Plus $100)인지 API-key 모드(`XAI_API_KEY`로 Build 구동 = 종량)인지 사전 선택.

## 출처 (전 항목 2026-08-14 조회)

- 공식: x.ai/news/grok-4-6 · docs.x.ai/developers/models/grok-4.6 · docs.x.ai/developers/release-notes · **docs.x.ai/build/cli/headless-scripting** · docs.x.ai/grok-bot/computer-and-apps · docs.x.ai/developers/model-capabilities/text/{streaming,reasoning} · legacy/chat-completions · cursor.com/blog/grok-4-6 · cursor.com/docs/models/grok-4-6 · cursor.com/docs/cli/{overview,using,headless} · cursor.com/grok · cursor.com/cloud
- 하네스/OAuth: kilo.ai/inference/subscriptions/supergrok · kilo.ai/docs/ai-providers/xai · docs.warp.dev/agent-platform/inference/grok-subscription · hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth (allowlist 403, issue #26847) · openclawai.io/blog/xai-device-code-oauth-headless-ai-agents · pi.dev/packages/pi-xai-oauth · github.com/stnly/pi-grok · github.com/can1357/oh-my-pi/issues/1126
- 2차: venturebeat.com(4.6 debut·Grok Bot $120) · marktechpost.com · testingcatalog.com · felloai.com/grok-pricing · pricepertoken.com/subscriptions/grok · buildfastwithai.com(Grok Build 리뷰) · codersera.com(설치 가이드) · shareallai.github.io(Build 가이드) · mer.vin(2026-05 헤드리스 CI) · digitalapplied.com(Grok Bot Cursor 티어 게이팅) · moclaw.ai · vals.ai/benchmarks/swebench · techtimes.com · github.com/rdmgator12/awesome-grok-connectors
- 약관: x.ai/legal ToS·AUP는 라이브 403 — 08-12 Wayback 실측(`2026-08-12-grok-bot-integration-feasibility.md` §3)을 기준 유지 · x.ai/legal/terms-of-service-enterprise · conductatlas.com/platform/xai
