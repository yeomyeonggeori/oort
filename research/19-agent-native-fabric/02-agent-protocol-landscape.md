# 외부 리서치 ① — 에이전트↔메신저/워크스페이스 통신 프로토콜 지형 2025–2026 (2026-07-21, Fable · PLN-20260721-01)

> 조사일 2026-07-21. **[확인]**=1차/공식 출처, **[보도/2차]**, **[추측]**=해석. 발단: 성재 — "MCP가 툴 연결의 표준이 됐듯, 에이전트가 메신저의 멤버로 참여하는 방식에 느슨한 공개 규격을 제안할 여지가 있는가".

## §1. 기존 프로토콜 실태

| 프로토콜 | 목적(레이어) | 거버넌스 | 채택도 | 2026-07 상태 |
|---|---|---|---|---|
| **MCP** | 모델↔툴/데이터 | **AAIF**(LF 산하, 2025-12 Anthropic 기증) | 사실상 표준(OpenAI Apps SDK도 MCP 위) | **2026-07-28 final**(stateless modern core·Tasks/Apps 확장); 2025-11-25 이하는 legacy |
| **A2A** | 원격 에이전트↔에이전트 | Linux Foundation(2025-06 Google 기증) | 150+ 조직, MS Foundry | **v1.0.0(2026-03-12)** — 3중 바인딩, IBM ACP 흡수 완료 |
| **AG-UI** | 에이전트 백엔드↔사용자 앱 프론트 | CopilotKit(스타트업, MIT, 재단 미소속) | MS AF·Google ADK·AWS Strands 1st-party 커넥터 | 활발. $27M 유치(2026-05) |
| **ACP (Zed Agent Client Protocol)** | **코딩 에이전트↔클라이언트 호스팅** | Zed 단독 주도(재단 미소속) | **에이전트 40+, JetBrains·Neovim·Emacs·marimo 클라이언트** | 급성장. Registry 가동(2026-01-28). **oort와 가장 근접** |
| **AGENTS.md** | 에이전트용 리포 지침 관례 | AAIF(2025-12 OpenAI 기증) | 6만+ 리포 | 사실상 표준 안착 |
| OpenAI AgentKit/ChatKit/Apps SDK | 자사 플랫폼 | OpenAI 독점 | ChatGPT 한정 | **Agent Builder·Evals 2026-06-03 deprecated**. Apps SDK=MCP 기반 |
| Slack agents & assistants | Slack 내 에이전트 API | Salesforce 독점 | Slack 한정 | 스트리밍 API(2025-10)·Agent messaging 탭(2026-06-30)·RTS+Slack MCP 서버 GA |
| Microsoft (Agent Framework/Teams SDK/NLWeb) | 프레임워크+허브 | MS | AF 1.0 GA(2026-04-02) | MCP·A2A 지지 선회, NLWeb 정체 |
| Matrix/XMPP | 오픈 연합 메신저 | 재단 | 에이전트 **프로토콜 수준 표준화 없음** | 커뮤니티 실험만(MindRoom, OpenClaw 어댑터) |

### 1.1 MCP — 2026-07-28 modern core 공개
- [확인·2026-08-12 재검증] 2026-07-28은 릴리스 후보가 아니라 공개된 **final**이다. modern core는 `initialize`·`notifications/initialized`·`ping`·protocol session·`Mcp-Session-Id`·GET stream을 제거하고, 매 요청 `params._meta`의 protocol version/capabilities와 mandatory `server/discover`를 사용한다. 2025-11-25 이하의 initialize lifecycle은 legacy이며 같은 endpoint에서 제공하려면 modern과 명시적으로 분리해야 한다. **Tasks 코어→공식 확장**(tasks/get 폴링+update+cancel), **MCP Apps 확장**(샌드박스 iframe UI — SEP-1865, Anthropic+OpenAI+MCP-UI 공동), **Multi Round-Trip Requests(SEP-2322)**(서버발 sampling/elicitation 대체). Roots·Sampling·Logging deprecation 진입.
- [확인] 거버넌스: AAIF(Anthropic·OpenAI·Block 공동 창립, 150+ 회원). 창립 프로젝트=MCP·goose·AGENTS.md.
- [추측·oort 관점] MCP의 진화 방향(stateless·요청 단위·서버=수동 툴 제공자)은 "상주 멤버"와 반대 방향 — oort에서는 **툴 레이어로 쓰는 게 맞고 멤버십 레이어 기반으로는 부적합**.

### 1.2 A2A — IBM ACP 흡수, v1.0
- [확인] 2025-08-29 IBM/BeeAI ACP가 A2A에 합류·개발 중단 — **2026년 현재 "ACP"는 Zed의 Agent Client Protocol을 지칭하는 것이 일반적**. v1.0.0(2026-03-12): JSON-RPC/gRPC/REST 3중 바인딩, **Agent Card**(JWS 서명), 비동기 태스크(폴링/스트리밍/웹훅), `input-required` 상태, extension 협상.
- [추측] "원격 서비스로서의 에이전트" 규격이지 "방의 멤버" 규격 아님. Agent Card·태스크 라이프사이클·push notification은 재사용 가치.

### 1.3 AG-UI — 상호작용 레이어 선점자
- [확인] ~16종 표준 이벤트, 전송 불문, MIT. "MCP=툴, A2A=에이전트 간, AG-UI=에이전트→사용자 앱" 3-레이어 포지셔닝. 1st-party 통합 다수.
- [추측] "한 사용자 앱↔한 에이전트" 모델 — 멀티파티 채팅방 의미론 없음. 그러나 **스타트업이 "빈 레이어"를 이름 붙여 선점한 최고 성공 사례**(§3 교훈).

### 1.4 ACP(Zed) — oort와 가장 유사한 문제
- [확인] JSON-RPC 2.0 over stdio, 에이전트=클라이언트의 서브프로세스. 흐름: `initialize`(capability 협상)→`authenticate`→`session/new|load`→`session/prompt`→**`session/update` 스트림**(진행·툴콜·plan)→**`session/request_permission`**(승인)→stop reason. 클라이언트가 역방향 capability 제공: `fs/read|write_text_file`, `terminal/create|output|wait_for_exit|kill|release`, `session/set_mode`. `_meta`+언더스코어 메서드 확장. MCP와 상보(세션 안에서 MCP 서버 사용).
- [확인] 생태계: 네이티브 — Gemini CLI(런치 파트너)·**opencode**·Goose·**Kimi CLI**·Qwen Code·OpenHands·Cline·Cursor·Copilot CLI·Junie·Kiro·Mistral Vibe·Factory Droid·Poolside 등 40+. 어댑터 — **Claude Code**(`zed-industries/claude-agent-acp`, Agent SDK 래핑, Apache)·**Codex CLI**(Zed 어댑터)·Pi(`pi-acp`). 클라이언트: Zed·**JetBrains 전 IDE**·Neovim·Emacs·**marimo 노트북(비-에디터 선례)**·Toad 터미널. **ACP Registry**(2026-01-28): 1회 등록→모든 클라이언트에서 설치.
- [추측] oort와 동형의 문제("임의 에이전트를 임의 호스트가 UI로 품는다")를 이미 풀었고 필요 어휘의 70% 보유. 결정적 차이 = **단일 사용자·단일 세션·에디터 중심 가정** — "방·멤버십·멀티파티" 의미론 부재.

### 1.5 AGENTS.md / OpenAI / Slack / Microsoft
- AGENTS.md: "마크다운 파일 하나"라는 극단적 단순함이 성공 요인 → 채택 비용 0 → 6만 리포 → AAIF 기증으로 중립화.
- OpenAI: Agent Builder 발표 8개월 만에 deprecated — 대기업도 표면을 잘못 고르면 접는다. **Apps SDK가 MCP 확장(SEP-1865)에 합류한 것이 중요 신호**.
- Slack: "에이전트가 워크스페이스 멤버처럼 행동하는 API"를 **독점 API로** 빠르게 완성 중(스플릿 뷰·앱 스레드·`chat.startStream`·Agent messaging 탭·RTS·Slack MCP 서버). 공개 규격 아님.
- [확인·중요 방증] **OpenClaw**: 자가 호스팅 개인 에이전트 게이트웨이(20+ 메신저 브리지). 2025-11 출시→2026-02 GitHub 214k 스타, 제작자 OpenAI 영입. 동시에 2.1만 인스턴스 공인터넷 노출 보안 참사. → [추측] "에이전트가 내 메신저에 산다" 수요의 실증 + 승인·권한·감사 의미론 부재가 사고로 이어진 반면교사 — **oort의 1급 멤버+서버 불변식 설계의 차별화 논거**.

## §2. 코딩 에이전트 헤드리스/임베딩 인터페이스

| 에이전트 | 1차 프로그래매틱 인터페이스 | 형태 | ACP 지원 |
|---|---|---|---|
| **Claude Code** | **Claude Agent SDK**(TS/Python) + CLI `-p --output-format stream-json` | 서브프로세스+NDJSON / SDK | 어댑터(Zed 제작, Apache) |
| **Codex CLI** | `codex exec` + **`codex app-server`(JSON-RPC 2.0)** + 공식 SDK | 서브프로세스 JSON-RPC 서버 | 어댑터(Zed 제작), 레지스트리 등재 |
| **opencode** | **`opencode serve`** — 헤드리스 HTTP 서버(OpenAPI 3.1)+`@opencode-ai/sdk` | **HTTP REST+SSE**(유일 HTTP-first) | **네이티브**, 레지스트리 등재 |
| **Gemini CLI** | 헤드리스 `-p`+`--output-format` / **`--acp` 모드** | 서브프로세스 | 네이티브(런치 파트너) |
| **Kimi CLI**(Moonshot) | **`--wire` 모드**(JSON-RPC 2.0 over stdio v1.10) | 서브프로세스 | **네이티브** |
| **Grok Build**(xAI) | 헤드리스 `-p` (2026-05-14 베타, 8 에이전트 병렬) | 서브프로세스 | 미확인 — 규격 참여 신호 없음 |
| **Pi**(badlogic/pi-mono) | **RPC 모드**(stdin/stdout JSONL, id 상관) | 서브프로세스 JSONL | 어댑터(`pi-acp`) |

**사실상 표준 존재 여부**: [확인] 수렴 패턴 2개 — ①각사 고유 JSON-over-stdio(전부 비호환) ②그 위 횡단 표준 **ACP**(대부분 네이티브/공식 어댑터 + Registry 배포 표준화). [추측] **"ACP가 사실상 표준이 되어가는 중(어휘는 에디터 중심)"** — oort가 N개 SDK 통합보다 ACP 클라이언트 1개 구현이 유지비 압도적 우위. marimo·Toad가 비-에디터 클라이언트 선례.

## §3. 채택 역학 교훈

**MCP 승리 요인**: ①AI-네이티브 최소 규격화 ②락인 의심 없는 대형 후원자 ③LSP 차용 ④철저한 도그푸딩(공식 클라이언트+19 레퍼런스 서버+SDK 동시 출하) ⑤최소 표면+가시적 로드맵 ⑥정식 스펙 ⑦타이밍.

**실패/정체 패턴**: IBM ACP=순서의 패배("두 번째 유사 프로토콜"은 생존 불가, 1년 만에 흡수) · ANP/AITP/agents.json/Agora/LMOS=제품 없는 프로토콜-우선 · OpenAI Agent Builder=8개월 만에 폐기 · Zed도 배포 메커니즘(Agent Extensions→Registry)은 1회 갈아엎음 — 초기 결정은 가볍게.

**작은 주체의 성공 선례**: AG-UI(빈 레이어 명명 선점+이벤트 16종의 극소 스펙+커넥터 파트너십), ACP(자기 제품=첫 클라이언트+**경쟁사 에이전트 어댑터를 제안자가 직접 출하**+JetBrains 2호 대형 클라이언트+레지스트리), AGENTS.md(채택 비용 0).

**[추측] 종합 공식**: *실제 제품에서 추출한 최소 스펙 + 시장 1·2위 에이전트용 어댑터 직접 출하 + 상세 문서 + 락인 의심 제거(permissive·재단 기증 경로) + 두 번째 대형 채택자 1곳.* 이 5개 없이 성공한 프로토콜은 2025–26에 없다.

## §4. 갭 분석 — "팀 채팅 멤버로서의 에이전트"

| 요구 | 가장 가까운 기존 장치 | 갭 |
|---|---|---|
| **방 멤버십·정체성·프레즌스** | A2A Agent Card(서비스 디스커버리), Slack 독점 API | **완전 공백** — 어떤 오픈 규격도 "대화 공간의 멤버" 개념 없음 |
| **컨텍스트 수신**(히스토리·스레드·권한 스코프) | ACP session/prompt(1:1), Slack RTS(독점) | **공백** — "에이전트가 볼 수 있는 범위"의 권한 모델은 어디에도 없음(oort RLS가 정확히 이 문제) |
| **승인 요청** | ACP request_permission, MCP MRTR, A2A input-required, AG-UI HITL | 원시 장치는 4개 다 보유하나 전부 **요청자=단일 사용자 가정**. 멀티파티 승인 권한자·감사 기록·타임아웃 정책은 공백 |
| **장기 실행 보고** | MCP Tasks, A2A task+push | "방에 스레드로 게시" 매핑 미정의. seq 순서 보장과 태스크 이벤트 결합 없음 |
| **산출물 공유** | A2A artifacts, MCP Apps(iframe) | MCP Apps가 유망하나 단일 사용자 챗 가정. **"방의 영속 산출물"(권한 상속·버전) 공백** |

**결론 [추측]**: 런타임 쪽(툴=MCP·호스팅=ACP·원격=A2A·프론트=AG-UI)은 포화, **"멀티파티 영속 대화 공간의 멤버십 레이어"는 실제 공백**. 지금 이 공백을 채우는 것은 Slack(독점 API)과 OpenClaw(프로토콜 없는 제품)뿐.

### oort가 제안할 수 있는 규격의 위치

- **옵션 A — ACP 확장 경로 (권장 1순위)**: oort 서버를 **비-에디터 ACP 클라이언트**로 구현(marimo·Toad 선례) → 레지스트리 40+ 에이전트가 즉시 멤버 후보. 그 위에 "**chat-client profile**" 확장 제안(`_meta`/언더스코어: 방 컨텍스트 주입, request_permission→채널 승인 카드, session/update→스레드 진행 게시). 리스크: Zed 단독 거버넌스, 에디터 어휘와 방 모델 마찰, 업스트림 거부 시 사실상 포크.
- **옵션 B — 신규 느슨한 규격 "Agent Membership Protocol"(가칭) (권장 병행)**: 기존 레이어와 경쟁하지 않는 **조합 정의의 얇은 규격** — 방/멤버/컨텍스트 스코프/승인/진행 이벤트/산출물 최소 어휘 + "로컬=ACP 세션, 원격=A2A 태스크로 바인딩" 매핑 장. §3 공식 대입: 레퍼런스 클라이언트=oort(도그푸딩), Claude Code·Codex·opencode 어댑터 직접 출하, permissive, AAIF 기증 경로 명시. OpenClaw 참사가 만든 "승인·감사·격리 기본값 있는 규격" 수요가 차별화 논거. 리스크: **규격은 제품 성공의 결과이지 원인이 아니었다** — oort 제품 질량 선결. Slack 독점 API·MCP Apps+Tasks의 2027년 확장 가능성. **창은 실재하나 좁다(추정 12–18개월). "규격 먼저"가 아니라 "oort에서 동작하는 구현 → 추출된 스펙 초안" 순서.**
- **옵션 C — A2A/MCP 확장 의존 (비권장)**: A2A는 철학 불일치, MCP는 stateless 반대 방향, 둘 다 oort가 통제 불가한 대형 거버넌스.

**한 줄 평가**: "에이전트가 팀 채팅의 1급 멤버"를 다루는 공개 규격은 2026-07 현재 존재하지 않는다. **ACP 클라이언트 채택으로 즉시 호환성 확보 + oort 구현에서 추출한 멤버십/승인/보고 얇은 스펙 제안의 이중 전략**이 성공 확률 최고.

## §출처 (기본 2026-07-21 확인, MCP 2026-07-28 final 계약은 2026-08-12 재검증)

**MCP**: modelcontextprotocol.io/specification/2026-07-28/{changelog,basic/versioning,basic/transports/streamable-http,server/discover} · blog.modelcontextprotocol.io/posts/2026-07-28 · 2026-mcp-roadmap · 2025-12-09-mcp-joins-agentic-ai-foundation · 2025-11-21-mcp-apps · tasks.extensions.modelcontextprotocol.io · linuxfoundation.org(AAIF 보도자료)
**A2A**: a2a-protocol.org/latest/specification · whats-new-v1 · lfaidata.foundation(2025-08-29 ACP 합류) · github.com/orgs/i-am-bee/discussions/5 · github.com/aaif/project-proposals/issues/37
**AG-UI**: github.com/ag-ui-protocol/ag-ui · copilotkit.ai/ag-ui · techcrunch.com(2026-05-05 $27M) · marktechpost.com(2026-05-21)
**ACP(Zed)**: agentclientprotocol.com(overview·agents) · zed.dev/blog/acp-registry(2026-01-28) · acp-progress-report(2025-10-02) · agent-extensions(2025-11-06) · github.com/zed-industries/claude-agent-acp · blog.jetbrains.com(2025-10 파트너십) · morphllm.com/agent-client-protocol
**AGENTS.md/OpenAI**: openai.com/index/agentic-ai-foundation · agents.md · openai.com/index/introducing-agentkit · community.openai.com(Agent Builder deprecation) · developers.openai.com(ChatKit) · winbuzzer.com(MCP Apps 협업)
**Slack**: docs.slack.dev/ai · changelog 2025/10/7(chat-streaming) · 2026/06/30(agent-messages-tab) · salesforce.com/news(context-aware AI apps)
**Microsoft**: devblogs.microsoft.com(agent-framework 1.0 · BUILD 2026 · Teams SDK) · venturebeat.com(NLWeb)
**Matrix/OpenClaw**: nijho.lt/post/mindroom · team400.ai(OpenClaw Matrix) · github.com/openclaw/openclaw · en.wikipedia.org/wiki/OpenClaw · mindstudio.ai(노출 인스턴스)
**코딩 에이전트**: code.claude.com/docs/en/agent-sdk/overview · github.com/anthropics/claude-agent-sdk-python · codex.danielvaughan.com(app-server) · opencode.ai/docs/server·sdk · google-gemini.github.io(headless·acp-mode) · moonshotai.github.io/kimi-cli(wire-mode) · x.ai/news/grok-build-cli · github.com/badlogic/pi-mono(rpc.md)
**채택 역학**: latent.space/p/why-mcp-won · agent-network-protocol.com(프로토콜 비교) · zuplo.com/blog(agent-protocol-stack 2026)
