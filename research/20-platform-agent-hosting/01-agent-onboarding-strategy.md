# momo 에이전트 온보딩 전략 — "원하는 에이전트를 원클릭으로" 다각 분석 (2026-07-22, Fable — 성재 발제 2차)

> 발단: 성재 — "eve가 제안한 구조처럼 우리도 사용자가 쓰고 싶은 에이전트를 ①호스팅 레벨 ②간편 생성 레벨에서 제공할 수 있나? 리소스는? (이미 잘 쓰는 걸 담기·연동 포함) 원클릭 연동(생성까지?)의 방향성을 profound하게."
> 방법: 병렬 웹 리서치 3갈래(eve 이식성 / 원클릭 UX 업계 지형 / 호스팅 리소스 모델) + 20-00·ADR-0130 결합. 출처는 각 절 말미.

## §0. 결론 먼저 (3문장)

**momo는 eve처럼 "말" 필요가 없다 — 업계가 수렴 중인 지점(에이전트 명부 + 멘션 가능한 준-멤버 + 거버넌스)을 momo는 이미 하드 불변식("에이전트=member")으로 갖고 있고, 빠진 것은 "문(門)" 두 짝뿐이다.** ①담아오기 문: URL/매니페스트 붙여넣기(+eve/CF 어댑터), ②만들기 문: momo 안 자연어 간편 생성(정의=원장, 실행=기존 이벤트 구동 경로 재사용 — 신규 상주 프로세스 0). 호스팅 레벨 풀 진입은 비노력 유지가 맞되, **"셀프호스트 번들에 eve 런타임 1컨테이너 동봉"이라는 최소형**은 리소스적으로 공짜에 가깝고 전략 가치가 크다.

## §1. 리서치 3갈래 핵심 판정

### 1-A. eve 이식성 = 상(上) — "말아서 제공"의 재료가 이미 열려 있다
- eve는 **공식 셀프호스팅 지원**: `eve build`가 표준 Nitro Node 서버를 산출, 컨테이너 어디서든 구동. Vercel 3대 의존은 전부 소프트 커플링 — Workflows→**Postgres world**(교체 가능, 단 `experimental.` 키), Sandbox→Docker 백엔드, AI Gateway→직접 프로바이더 객체. **vercel-labs/steve** = DigitalOcean droplet에 Ansible 원커맨드 배포 공식 PoC.
- **커스텀 채널이 1급 API**(`defineChannel` — HTTP/WS 라우트+`send()`+continuationToken+자체 인증): "momo 채널" 작성이 문서 수준에서 지원됨. Postgres world 채택 시 momo의 PG=SoT 문법과 궤 일치.
- 리스크: beta(주간 4~5 릴리스), world 교체 키가 experimental — **API 안정성 리스크 실재**. 정의 파일만 뽑아 eve 없이 실행하는 경로는 없음(이식 단위=런타임 포함 디렉터리).

### 1-B. 원클릭 UX 업계 수렴점 = "양문형 + 공통 매니페스트 + 에이전트 명부"
- **담아오기 표준 프리미티브 = URL/매니페스트 + 동의 화면**: MCP 서버 URL(Claude 커넥터·Notion), **A2A agent-card URL(Copilot Studio "URL 입력→카드 자동 판독", Gemini Enterprise Agent Registry)**, declarative manifest(M365), `.mcpb`/딥링크(로컬). Slack Agent Kit(TDX 2026)은 "어디서 만들었든 Add to Slack 몇 클릭"으로 이 방향의 메신저판 완성형.
- **만들기 표준 = 자연어 구성 + 조직 공유 + 거버넌스**: GPT빌더→**Workspace Agents**(2026-04, 이름·도구·메모리·스케줄 가진 공유 에이전트), Copilot Agent Builder→관리자 승인. **OpenAI가 비주얼 캔버스(Agent Builder)를 11개월 만에 deprecate**(2026-11 종료) — 만들기 UX는 "자연어(가벼움) vs 코드 SDK(무거움)" 양극단으로 정리, 노코드 플로차트 중간층은 죽었다.
- **두 문이 만나는 곳 = 워크스페이스 에이전트 명부**(Slack Tools>Agents, ChatGPT Agents 사이드바, Copilot Store, Gemini Gallery): 설치 경로 불문 "명부에 오른, @멘션 가능한, 거버넌스 대상 준-멤버". **momo의 '에이전트=member' 불변식이 정확히 이 종착지** — 업계가 이제야 이동 중인 지점을 우리는 0일차부터 갖고 있다.
- 컨슈머 제품에서 최종 사용자가 A2A URL로 에이전트를 채널에 합류시키는 사례는 아직 부재(빌더/관리자 도구 층위에만) — **선점 여지**.

### 1-C. 리소스 = 비용 병목 아님, 병목은 격리·운영
- **지배 비용은 LLM 토큰**(3개월 실측: 총비용의 64%, 인프라 13%). 이벤트 구동 설계면 에이전트 1개 인프라비 월 $0~1(Vercel Fluid)·$0.08(CF DO 하이버네이션)·$2~5(Fly Machine 상주) — 반올림 오차.
- 셀프호스트 VPS(8GB, 월 $24): 유휴 Node 에이전트 프로세스 ~100-300MB → **10~20개 상주 현실적**. eve 런타임 1컨테이너 추가는 이 범위 안.
- **격리는 직접 만들지 말 것**: 적대적 코드 실행은 임대(E2B 종량·CF), 자체 상한은 gVisor, 신뢰 도구는 컨테이너+이그레스 통제. momo는 이미 이 결론과 일치(E2B=T3 기질 확정, ADR-0004 이그레스 원칙).

## §2. momo의 3층 제공 모델 — 층별 판정

### T-A. "담아오기" (이미 잘 쓰는 에이전트 연동) — ★ 최우선, 재료 다 있음
| 형태 | 경로 | 상태 |
|---|---|---|
| 플랫폼-상주(eve/CF/Workspace Agents) | gateway BYOA 계약 소비 어댑터 | 계약 실증 완료(codex-workbench·530). **어댑터 2종만 쓰면 됨**(eve `channels/momo.ts`+CF 클래스) — 0130 D5의 구체화 |
| CLI형(claude/codex/opencode 40+) | ACP(momo-acp-host, 531 랜딩) | ✅ 완료 |
| 원격 셀프 온보딩(URL 붙여넣기) | **A2A agent-card 판독 + 에이전트 명부 등록** | 0130 D4(2단계 예약) — **업계 수렴 확인으로 상향 근거 완성**. Copilot Studio UX(URL→카드 자동 판독→동의→명부) 그대로 momo 관리자 UI에 |
| 웹훅형(n8n/Zapier/Dify) | 인바운드 기성 + outbound 구독 부재 | outbound 이벤트 구독 신설 필요(MOMO-535 후보 유지) |

### T-B. "momo 안 간편 생성" — ★ 성립한다, 상주 프로세스 0으로
핵심 통찰: **momo는 이미 에이전트 생성 API(X-7)와 실행 런타임(AgentWorker+Context Packet)을 갖고 있다.** 빠진 것은 "에이전트마다 다른 인격/도구"의 정의 원장뿐:
- `agent_profile` 원장(가칭): instructions(시스템 프롬프트)·모델 선호·활성 도구(plugin capability 참조)·트리거(멘션/스케줄). **정의=PG 행, 실행=기존 단일 쓰기경로의 agent_run** — eve의 "에이전트=디렉터리"의 momo판은 "에이전트=원장 행+Context Packet".
- 리소스: 신규 상주 프로세스 0(AgentWorker가 packet에 profile 주입해 실행 — 1-C의 이벤트 구동 최적형). 워크스페이스당 에이전트 수십 개도 비용 무의미. Workspace Agents(OpenAI)·Notion Custom Agents와 동일 형태, 단 **우리는 원장·승인·관전·메모리(0129)가 이미 밑에 있다**.
- UX: "만들기" 문 = 대화식 생성(에이전트에게 에이전트 만들게 하기) 또는 폼 1장. 업계 교훈(1-B)대로 비주얼 캔버스는 만들지 않는다.

### T-C. "호스팅 레벨" — 풀 진입은 비노력 유지, 단 최소형 1개는 취한다
- eve/CF와 실행 인프라 경쟁은 기존 결정대로 비노력(포지션 오류). momo Cloud(T3)는 CLI 세션 호스팅까지.
- **예외 — "동봉 eve" 최소형**: momo 셀프호스트 compose에 eve 런타임 컨테이너 1개(+`channels/momo.ts` 프리셋, Postgres world는 momo PG 별도 DB)를 **옵션 프로파일**로 동봉. 효과: "momo 설치 = 커스텀 에이전트 빌드 환경까지 포함" — 설치자가 자기 에이전트를 코드로 만들면 그대로 momo 멤버. 리소스: 컨테이너 1개(수백 MB), 유휴 CPU≈0 (1-C 실측 범위). 리스크: eve beta API 변동 → **버전 고정+어댑터만 우리가 소유**하면 표면적 최소.

## §3. 선제 구현 제안 (성재 결정 요청)

**Wave B (Bridge) — 담아오기 완성, 3장:**
1. **MOMO-534 eve/CF 어댑터 레퍼런스 2종** [소형] — `channels/momo.ts`(gateway BYOA 리스/이벤트 소비, eve defineChannel 공식 API) + Cloudflare Agents 동형 클래스. 산출물은 오픈소스 공개물 포함. *의존: 없음(계약 소비만). 지금 바로 가능.*
2. **MOMO-536 에이전트 명부+URL 온보딩** [중형] — 0130 D4 상향 집행: `/.well-known/agent-card.json` 판독→관리자 동의 화면(scope 표시)→agent member 생성+명부 등재. 관리자 UI "에이전트 추가: URL 붙여넣기" 문. *의존: 없음(서버+UXUI 1장씩).*
3. **MOMO-535 outbound 이벤트 구독** [중형] — 웹훅형 양방향화(기존 제안 유지).

**Wave C (Create) — 만들기 문, 2장:**
4. **MOMO-537 agent_profile 원장+간편 생성** [중형] — instructions/모델/도구/트리거 원장 + Context Packet 주입 + 생성 폼(자연어 보조는 후속). *의존: 528 랜딩(완료).*
5. **MOMO-538 동봉 eve 옵션 프로파일** [소형~중형] — compose `--profile eve` + 버전 고정 + momo 채널 프리셋. *의존: 534.*

권고 우선순위: **534 → 536 → 537 → 535 → 538** (담아오기 먼저 — 사용자 기존 자산 존중이 성재 원문 취지, 생성은 그 다음). Wave U(529/532) 랜딩과 병렬 가능(엔진 슬롯 여유).

## §4. 로드맵 수정 기안
- ROADMAP에 "에이전트 온보딩(양문형)" 트랙 신설: Wave B/C를 PLN-20260721-01 후속(PLN-20260722-01 후보)으로 편성.
- ADR 필요 여부: 534·535·538은 Accepted 0130 범위 내(D4/D5 집행). **537(agent_profile)은 신규 경계(스키마+에이전트 인격 모델) → ADR-0131 기안 필요**. 536은 0130 D4의 "2단계" 조항 집행이므로 ADR 개정 아닌 집행 결정으로 충분.
- 오픈소스 게이트와의 결합: 534의 어댑터 2종은 공개 리포지토리의 "5분 데모" 자산 — 법무 패키지 완료 후 공개 시점에 README 1급 배치 권고.

## 출처
- eve 이식성: github.com/vercel/eve(docs/guides/deployment/self-hosting.md·channels/custom·Discussion #83) · vercel-labs/steve · eve.dev/docs/channels/custom · mastra.ai/blog/apache-license · LangGraph 라이선스 분석(rvernica.github.io) · AgentKit 마이그레이션 가이드(developers.openai.com)
- 원클릭 UX: docs.slack.dev(OAuth·optional scopes) · slack.com/blog/news/slack-is-where-agents-work(Agent Kit) · openai.com/index/introducing-workspace-agents-in-chatgpt · developers.openai.com/api/docs/deprecations(Agent Builder 종료) · learn.microsoft.com(declarative agents·add-agent-agent-to-agent) · docs.cloud.google.com/gemini/enterprise(Agent Registry) · blog.modelcontextprotocol.io(Registry preview) · cursor.com/docs/mcp/install-links · claude.com/docs/connectors · blog.cloudflare.com/temporary-accounts · railway.com/deploy
- 리소스: developers.cloudflare.com(workers·durable-objects pricing) · vercel.com/blog/introducing-active-cpu-pricing · fly.io/docs/about/pricing · e2b.dev/pricing · northflank.com/blog/ai-sandbox-pricing·firecracker-vs-gvisor · dev.to 3개월 실측기 · cherryservers.com/blog/n8n-self-hosting-requirements · docs.dify.ai
