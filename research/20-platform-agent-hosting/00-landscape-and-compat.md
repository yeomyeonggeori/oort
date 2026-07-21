# 플랫폼 에이전트 호스팅 지형과 momo 호환성 (2026-07-22, Fable — 성재 발제)

> 발단: 성재 — "Vercel eve·Cloudflare 등 최전선 플랫폼의 에이전트 빌드/호스팅 서비스와 hermes 같은 에이전트가 본질적으로 다른가? 요즘 기업/일반인은 에이전트를 어떻게 만들고 호스팅하나? 그 에이전트들이 momo와 호환되는 구조인가? 아니라면 우리가 할 노력은?"
> 방법: 웹 리서치(2026-07 시점 — eve 공식 문서·GitHub 직접 확인) + 기존 정본(research/19-02 프로토콜 지형, ADR-0130) 결합.
> 선행 정본과의 관계: 19-02는 **CLI 코딩 에이전트**(ACP) 축 — 본 문서는 **플랫폼-상주 에이전트** 축을 가산. 둘이 합쳐 외부 에이전트 전 지형.

## §1. 2026-07 플랫폼 지형 — 확인된 사실

### Vercel eve (2026-06-17 런칭, Apache-2.0, beta)
- **에이전트 = 파일 디렉터리**: `agent/instructions.md` + `agent.ts`(defineAgent, 모델 문자열) + `tools/`(파일=도구) + `skills/` + `subagents/` + **`channels/`(HTTP·Slack·Discord — `channels/slack.ts` 예시)** + 스케줄. Vercel Functions에서 실행, Workflows(내구 세션·중단 재개)·Sandbox(코드 격리)·AI Gateway(모델 라우팅·키 불요)·Connect(OAuth 토큰 관리)·Observability를 기본 배선.
- **세션 계약**: `POST /eve/v1/session {message}` → `continuationToken`+`x-eve-session-id`, `GET /eve/v1/session/<id>/stream` → **NDJSON 수명주기 이벤트**. 
- 규모 실증: Vercel 내부 에이전트 100+, 플랫폼 배포의 ~29%가 에이전트 트리거(1년 전 3%). MCP Registry 통합(도구 슬롯). `vercel deploy`로 배포하되 타 플랫폼 지원 예고.
- 부속: Passport(엔터프라이즈 에이전트 신원 — "shadow AI" 대응).

### Cloudflare Agents SDK
- **에이전트 = Durable Object**: 고유 ID당 정확히 1인스턴스(싱글턴), SQLite 내장 상태(크래시·배포·이주 생존), **WebSocket 네이티브**, 스케줄·fiber·관측. 수천만 인스턴스 스케일.
- **채널**: chat(useChat WS 훅)·voice·email·Slack·webhook. **McpAgent로 에이전트를 원격 MCP 서버로 노출** 가능(세션별 상태 유지).
- 포지션 전환: Agents SDK를 "임의 프레임워크가 올라타는 **런타임**"으로(첫 사례 Flue) — eve의 "프레임워크" 포지션과 대조.

### 관리형·노코드 (기업/일반인 실사용 형태)
- **OpenAI AgentKit**(2025-10): OpenAI 모델 전용 빌더·배포, 과금=토큰. **Zapier Agents**: 9,000+ 앱 연동을 설정으로. **n8n**: 오픈소스·agent 노드·셀프호스트(Docker) — 기업 자가 인프라 선호처. **Dify**: RAG·멀티에이전트 비주얼 빌더·셀프호스트. **GPTs/Claude 프로젝트**: 일반인 최속 경로.
- 패턴: Gartner "2026년 신규 엔터프라이즈 앱 75%가 로우/노코드". 기업은 ①컴플라이언스(SOC2·BYOK·VPC) ②셀프호스트(n8n/Dify) ③기존 앱 연동(CRM·Slack·ERP)을 축으로 선택.

## §2. "본질적으로 hermes와 같은가?" — 같다. 다른 것은 '거주지'와 '컨텍스트 소유자'

모든 형태가 동일한 해부학을 공유한다: **지시문 + 도구 + 모델 라우팅 + 상태 + 채널**. hermes(momo gateway 뒤 OpenAI 호환 에이전트)도, eve 에이전트도, Cloudflare DO 에이전트도 이 다섯 조각이다. 차이는 두 축뿐:

| 축 | eve/CF/AgentKit | momo hermes·gateway BYOA | CLI 에이전트(ACP) |
|---|---|---|---|
| **거주지** | 플랫폼-상주 HTTP/WS 서비스 | 자가 호스팅 상주 서비스(위치 자유) | 호스트-로컬 프로세스(stdio) |
| **컨텍스트/승인/감사 소유** | 플랫폼(Workflows·Observability·Passport) | **momo**(Context Packet·승인 원장·audit — 0129/0114) | momo(승인)+로컬(실행) |

결론: **본질 차이 없음 → momo의 "에이전트=member" 모델에 전부 수용 가능**. 외부 에이전트 형태는 3종으로 정리된다 — ①플랫폼-상주 HTTP형(eve/CF/AgentKit) ②호스트-로컬 CLI형(ACP — **ADR-0130이 이미 커버**) ③워크플로 웹훅형(n8n/Zapier). momo의 차별점은 "에이전트를 잘 돌리는 곳"이 아니라 **"팀이 에이전트와 함께 사는 곳"**(원장·승인·관전·메모리 거버넌스) — 플랫폼들과 경쟁이 아니라 **그들의 에이전트가 출근하는 사무실** 포지션.

## §3. momo 호환 매트릭스 (현재 계약 기준)

| 외부 에이전트 형태 | momo 진입로 | 판정 |
|---|---|---|
| ①플랫폼-상주 HTTP (eve·CF·AgentKit) | **gateway BYOA 계약**(pending/events/complete/lease — provider-불가지, codex-workbench가 SDK 없이 실증) | 🟡 **구조는 정합, 어댑터 부재** — eve의 `channels/` 가 정확한 통합점(slack.ts처럼 **momo.ts** 작성 가능). CF도 WS/HTTP로 동형 |
| ②CLI형 (claude/codex/opencode/kimi/pi 40+) | ACP 클라이언트(momo-acp-host — MOMO-531 진행 중) | ✅ 커버 중 |
| ③웹훅형 (n8n·Zapier·Dify 플로) | 인바운드: 채널 웹훅(Slack 호환, MOMO-412) 기성 | 🟡 **반쪽** — 유입은 되나 "대화 멤버" 아님. 양방향(momo 이벤트 → 에이전트)의 **outbound 이벤트 구독 계약 부재** |
| 셀프 온보딩(모든 형태 공통) | A2A Agent Card `/.well-known/agent-card.json` — 업계가 이 관례로 수렴 중(SAP·AWS 문서 동일 권고) | 🟡 0130 D4로 **정확히 예약돼 있음**(2단계) — 수렴 확인으로 상향 근거 강화 |
| momo를 에이전트의 '도구'로 | 원격 MCP 서버로서의 momo(eve MCP Registry·CF McpAgent가 꽂는 슬롯) | 🔴 inbound MCP 스텁(R5) — 후속 그대로 |

## §4. momo가 해야 할 노력 (권고 — 성재 결정 대기)

1. **[소형·즉시] MOMO-534(후보): "momo 채널 어댑터" 레퍼런스 2종** — ADR-0130 D5(어댑터 템플릿 공개)의 구체화: ①`eve` 커스텀 채널(`agent/channels/momo.ts` — gateway BYOA 리스/이벤트 소비) ②Cloudflare Agents용 동형 클래스. 오픈소스 공개물에 포함하면 "eve로 만든 에이전트가 5분 만에 momo 워크스페이스 멤버" 데모가 성립 — **두 생태계의 에이전트 전부가 잠재 momo 멤버**가 된다. 코어 수정 0(계약 소비만).
2. **[중형] MOMO-535(후보): outbound 이벤트 구독** — 웹훅형(③)의 양방향화: 워크스페이스 이벤트(멘션·승인요청·work 상태)를 외부 URL로 서명 발송하는 구독 원장(기존 웹훅 원장·outbox 문법 확장). n8n/Zapier/Dify 플로가 momo를 트리거로 쓰는 관문.
3. **[예약 상향 근거] 0130 D4(Agent Card+`agents/announce`)** — eve Passport·A2A 카드 수렴으로 "원격 에이전트 셀프 온보딩"의 업계 문법이 확정되는 중. Wave A 완주 후 차기 배치로 상향 권고(기존 "2단계 예약"에서 시기 명시로).
4. **[기존 경로 확인] inbound MCP 완성(R5 후속)** — momo의 검색·메모리·원장을 외부 에이전트의 도구로 노출하는 방향은 MCP 스텁 완성이 답. 0129 랜딩 후(서빙할 자산이 생긴 뒤) 착수가 순서.
5. **[비노력] 자체 호스팅 런타임 경쟁 진입 금지** — eve/CF와 "에이전트 실행 인프라"로 경쟁하는 것은 포지션 오류. momo Cloud(T3)는 CLI 세션 호스팅까지만(기존 결정 유지).

## §5. hermes에 주는 시사점

hermes는 "momo 전용 에이전트"가 아니라 **①형(플랫폼-상주 HTTP)의 셀프호스트 사례**일 뿐이다 — eve로 다시 만들 수도, CF로 옮길 수도 있고, 그래도 momo 쪽 계약(gateway BYOA)은 동일하게 성립한다. 즉 hermes의 실체는 "우리가 운영하는 레퍼런스 구현"이고, §4-1 어댑터가 공개되면 누구의 eve/CF 에이전트든 hermes와 같은 자격으로 들어온다. 이것이 "기존 에이전트들도 이 프로토콜로 더 잘 쓸 수 있게"(성재 원문, 0130 발단)의 플랫폼-상주 판 완성이다.

## 출처
- Vercel eve: vercel.com/docs/eve(직접 확인 — 세션 API·구조) · github.com/vercel/eve(channels: HTTP/Slack/Discord·MCP Registry) · vercel.com/blog/introducing-eve · InfoQ 2026-06 · The Register 2026-06-19(Passport)
- Cloudflare: developers.cloudflare.com/agents(SDK·chat/voice/email/Slack/webhook 채널) · blog.cloudflare.com/build-ai-agents-on-cloudflare · blog.cloudflare.com/agents-platform-flue-sdk(런타임 포지션) · blog.cloudflare.com/remote-model-context-protocol-servers-mcp(McpAgent)
- 노코드/관리형: aimultiple.com/no-code-ai-agent-builders · n8n.io/ai-agents · OpenAI AgentKit(2025-10 발표) 등
- A2A 카드 관례: a2a-protocol.org · SAP Architecture Center · AWS Open Source Blog(agent interoperability 시리즈)
