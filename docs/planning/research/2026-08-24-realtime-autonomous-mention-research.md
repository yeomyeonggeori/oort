# 완전 자율 실시간 멘션 응답 — 업계·프로토콜·Grok 표면 3축 디깅 (2026-08-24)

- 작성: Fable · 발제(성재): "완전 자율 실시간 방식 더 디깅 + 플러그인/커넥터/Slack/커뮤니티는 어떻게 하는지 전반 방향"
- 선행 정본: `2026-08-24-grokbot-push-vs-cdp.md`(Q-DIR/Q-MCP/Q-EGRESS 결정 큐) · `2026-08-24-grokbot-push-inbound-and-cdp-policy.md` · ADR-0102(worker/gateway 이중 경로) · ADR-0162(Agent Port) · ADR-0163(managed provider) · ADR-0004(provider 경계) · ADR-0132(에이전트 발화 규약)
- 방법: 병렬 리서치 3기 — ①플랫폼(Slack/Discord/Telegram/GitHub/셀프호스트 4종) ②Grok 호출 표면 전수 ③프로토콜(MCP/A2A)·커뮤니티 하네스. 웹 1차 출처 기반, 2026-08-24 실측.

## 0. TL;DR

1. **업계 전체의 공통 구조는 정확히 세 조각이다: push 이벤트 전달 + warm 상주 런타임 + 그 런타임에 상주하는 모델 자격증명.** 예외가 없다. 사람 세션을 경유하는 순간 자율성이 깨진다 — 그록봇 제품이 실시간 엔진이 될 수 없는 이유가 업계 구조론으로도 재확인됨.
2. **oort는 세 조각 중 첫 조각(push 전달)을 이미 Slack보다 강하게 보유** — 멘션 POST 한 트랜잭션(message+agent_run+agent_job outbox) → relay → private `agentwork:` wake-up push → BYOA claim. durable outbox라 at-least-once 회수까지 보장. **빠진 것은 "Grok 완성을 생성하는 런타임+자격증명" 한 조각뿐.**
3. **셀프호스트 메신저 비교군(Mattermost·Rocket.Chat)은 "서버 내장 에이전트 런타임 + 운영자 보관 provider key + 봇=일반 멤버 + streaming"으로 수렴** — oort의 managed worker(ADR-0102) + provider 드롭인(ADR-0163) 방향과 동형. 업계가 우리 설계를 사후 검증해 준 셈.
4. **프로토콜 지형: MCP의 server-initiated wake 문은 공식적으로 닫혔다.** 2026-07-28 스펙이 stateless core로 확정되고 sampling은 deprecated(12개월 유예). ADR-0162 Agent Port의 sessionless POST 설계는 이 방향과 정합. 유일하게 push를 표준화한 것은 A2A v1.0(task lifecycle + webhook 통지).
5. **Grok의 sanctioned 실시간 경로는 사실상 xAI API(api.x.ai) 하나** — Enterprise ToS가 integration 구축을 명시 허용, 수 초 latency·streaming·Agent Tools, grok-4.6 $2/$6·grok-4.3 $1.25/$2.5 per 1M. 선행 노트의 Q-DIR (b) 권고를 강하게 재확증.
6. **각주(운영 리스크)**: Grok CLI의 구독 인증(cached OAuth) **상시 데몬** 구동은 fair-use "automated bulk usage" 금지 조항의 gray-zone. 사람이 발사하는 현행 grok-fleet 워커 세션과 상시 봇은 리스크 등급이 다름 — 봇 상시 운용이라면 `XAI_API_KEY` 경로(공식 headless 문서 경로)가 안전.

## 1. 업계 지형: 4가지 런타임 소유 모델

| 모델 | 사례 | 이벤트 전달 | 자격증명 위치 | 지연 클래스 |
|---|---|---|---|---|
| ① 운영자 상주 데몬 | Slack 자체봇(Events API 3초 ack / Socket Mode outbound WS), Discord Gateway WS, Telegram webhook/long-poll, Matrix /sync, Zulip outgoing webhook | push 또는 push-동등 | 데몬 프로세스 (platform token + LLM key) | real-time |
| ② 벤더 호스팅 | Claude Tag(Anthropic ephemeral sandbox, 2026-06), ChatGPT Workspace Agents, Agentforce | 플랫폼→벤더 배선 | 벤더 (고객은 구독+OAuth 설치만) | real~near-real-time |
| ③ 메신저 서버 내장 | **Mattermost Agents plugin**(in-process hook, System Console에 provider key, 봇=일반 user account, streaming post), Rocket.Chat Apps-Engine | in-process (전달 지연 0) | 서버 config | real-time |
| ④ 이벤트당 ephemeral spawn | GitHub @claude(claude-code-action)·@copilot — mention → Actions runner → headless CLI → 코멘트/PR | webhook→CI | repo secret 또는 OIDC exchange | **분 단위** (채팅 부적합, 작업 위임용) |

핵심 트레이드오프: ephemeral spawn(④)은 자격증명 관리가 가장 깔끔하지만 real-time을 포기한다. **채팅형 실시간을 원하면 warm 런타임(①②③)이 필수.** Mattermost·Rocket.Chat 모두 "외부 bot host" 세대를 deprecated시키고 ③으로 수렴했다.

## 2. 프로토콜·호스티드 트리거 지형 (2026-08)

- **MCP 2026-07-28**: stateless core 확정(`Mcp-Session-Id`·handshake 제거), **sampling·roots·logging deprecated**, async는 polling 기반 Tasks extension(SEP-2663)으로 분리, webhook 표준화 실패(논의만 존재). → MCP 위에 wake를 설계하는 것은 표준 트랙이 아님. Agent Port의 매 POST 재인증·무세션 설계가 오히려 스펙 진화 방향과 일치.
- **A2A v1.0**(Linux Foundation, ACP 흡수 합병): task 8-state lifecycle + `PushNotificationConfig`(서버→클라이언트 webhook POST) 표준화. 단 "임의 이벤트→에이전트 기상"의 앞단은 여전히 DIY.
- **호스티드 트리거 개화**: Claude Code Routines(routine별 HTTP endpoint+bearer, cron 최소 1h), **Cursor Automations**(automation별 private webhook endpoint + Slack/Linear/Sentry 트리거 + 2026-08 standing subscription — 스레드 구독형 re-wake), Devin API(programmatic session + 완료 webhook), Codex cloud(@codex 태깅, 범용 inbound webhook은 미출시). → "daemon 없는 봇"은 벤더 커넥터 커버리지에 종속되고, 자체 메신저는 결국 "얇은 forwarder"가 필요.
- **커뮤니티 정본 패턴**: 상주 Gateway 데몬(이벤트 소스 WS/webhook 소유) + 이벤트당 headless CLI spawn + (channel|thread)→session 매핑 테이블 + 원 스레드 회신. 사례: OpenClaw/ClaudeClaw(launchd Gateway + `claude -p` spawn), mpociot/claude-code-slack-bot(Socket Mode), claude-code-action(bot actor 기본 거부 + tracking comment anchor).

## 3. Grok 표면 판정 (전수, 2026-08-24)

| 순위 | 표면 | 실시간 자율 | 약관 | 비고 |
|---|---|---|---|---|
| 1 | **xAI API (api.x.ai)** | ✅ 수 초·streaming | **sanctioned** (Enterprise ToS가 integration 명시 허용) | grok-4.6 $2/$6 · grok-4.3 $1.25/$2.5 (1M ctx) · grok-build-0.1 $1/$2 · Agent Tools/Remote MCP · tier제 rate limit($50→T1) |
| 2 | Azure AI Foundry Grok | ✅ | sanctioned | 1의 enterprise 래퍼 — 우리엔 부가가치 없음 |
| 3 | Grok CLI headless + `XAI_API_KEY` | ✅ (spawn 오버헤드) | sanctioned (공식 headless 문서) | 코딩 워커용. 채팅 reply 엔진으론 과체중 |
| 3′ | Grok CLI + 구독 OAuth 상시 데몬 | 기술상 가능 | **gray-zone** — fair-use automated bulk usage 금지·weekly pool 비공개 | 사람 발사 워커(현행 grok-fleet)와 상시 봇은 리스크 등급 상이 |
| 4 | Cursor Cloud Agents API / Automations | ✅ (분 단위) | sanctioned | repo 작업형·PR 산출 — 채팅 형태 불일치. 코드 이그레스 선결(Q-EGRESS) |
| 5 | Grok Bot 제품 | ❌ | 소비자 AUP gray-zone | 인바운드 API·웹훅 전무(8/24 재확인) — 실시간 엔진 승격 불가 |
| 6 | Grok Automations | ❌ (schedule+email만) | 소비자 ToS | inbound webhook 없음 |

## 4. oort 결합 설계 — 빠진 한 조각의 두 가지 자리

이미 있는 것(재확인): `POST messages("@grok …")` → 한 tx(message+seq+agent_run(queued)+agent_job outbox) → relay `agent.job` → private `agentwork:` push → bearer claim → events/complete → agent 명의 message+usage+audit 원자 커밋. **Slack Events API 대비 우위**: durable outbox(at-least-once), 3초 ack 같은 어색한 계약 없음, 응답·비용·감사 원자 기록.

- **자리 A — managed worker (ADR-0102 worker + ADR-0163 provider 드롭인)**: AgentWorker가 xAI API를 OpenAI-compatible SSE provider로 소비. Mattermost 수렴형(③)과 동형 — "서버 소유 런타임 + 운영자 key". 셀프호스트 배포자에게 "key 하나 넣으면 @grok이 산다"는 최소 마찰 경로. 선행 노트 권고 1순위(Remote MCP Tools로 모델이 Agent Port를 서버사이드 소비)와 같은 축이며, tool 화이트리스트(`allowed_tools`) ADR 증보가 선결.
- **자리 B — BYOA gateway (ADR-0102 gateway)**: 사용자 소유 호스트의 어댑터 데몬이 `agentwork:` wake 구독 → api.x.ai 호출(또는 CLI headless spawn) → gateway callback. 커뮤니티 정본 패턴(Gateway 데몬)과 동형이고 ADR-0004 커스터디가 가장 보수적. 이미 Hermes가 이 자리 — "hermes-grok" provider 어댑터 추가 형태.

두 자리 모두 **아키텍처 신설이 필요 없다** — 기존 이중 경로의 provider 슬롯에 xAI를 꽂는 문제로 축소된다.

## 5. 함정 체크리스트 (커뮤니티 실측 → oort 대입)

- **Loop prevention**: 업계 모범 = actor identity 기본 거부(claude-code-action의 bot actor default deny). oort는 wake 후보가 쓰기 tx에서 생성되므로 **"agent member가 쓴 메시지는 agent_job을 만들지 않는다"를 인입 계층에서 강제**하는 위치가 자연스러움 — 현행 구현이 이를 보장하는지 1티켓 검증 감. 발화 측은 ADR-0132가 이미 커버(봇↔봇 핑퐁의 발화 절반).
- **Idempotency**: Slack 3회 재전송류 중복이 oort엔 구조적으로 없음(outbox 소비가 곧 dedupe). `client_msg_id` 멱등성 기존 보유.
- **Credential custody**: 자리 A는 서버 config key(ADR-0163 경계 내 opaque 드롭인), 자리 B는 호스트 상주 — 어느 쪽도 ADR-0004 위반 없음. 구독 OAuth를 상시 봇에 쓰는 것만 회피(§3′).
- **Rate limit/비용**: 멘션 1회 응답 ~5–20K tokens → grok-4.3 기준 회당 $0.01 미만. 스트리밍 진행표시의 편집 rate limit(Slack의 고질)은 Centrifugo partial progress가 이미 흡수.

## 6. 결정 큐 (선행 노트 Q-DIR에 얹음)

- **Q-DIR 재확증**: 실시간 자율의 실체는 (b) "Grok 모델이 응답" — 업계 구조론·프로토콜 지형·Grok 표면 전수 모두 같은 답. 그록봇 제품(VM 페르소나)은 자연어 릴레이 비동기 협업자로 병존, 실시간 @grok 멤버는 xAI API로 — 두 정체성의 병존이 자연스러운 종착.
- **Q-SLOT(신규)**: xAI provider를 자리 A(managed)와 자리 B(BYOA) 중 어디부터 여는가? 셀프호스트 배포 스토리(오픈소스 이미지 + key 하나)는 A가, 커스터디 보수성은 B가 우세. 권고: **A 선행**(Mattermost 수렴형이 배포자 경험의 업계 표준이 됐음) + B는 기존 Hermes 계열 후속.
- **Q-LOOP(신규, 소형)**: agent-authored message의 wake 배제를 현행 코드가 보장하는지 검증 티켓 1건.
