# AI 에이전트 네이티브 메신저 랜드스케이프 리포트
*2026-06-23 기준 · 제품 전략 애널리스트 · 퍼널 보조 스캔(S5 AI에이전트 / S3 유통 연계)*

## 1. 한 줄 답

**형성 중 — 진정한 "에이전트 1급 시민" 메신저는 아직 거의 공백이고, 시장의 99%는 당신이 느낀 그대로 "사람용 메신저에 덮어씌운(overlay)" 형태가 맞다.**

근거 요약:
- 텔레그램·슬랙·메타모스트는 아키텍처상 명백히 **오버레이(B)**다. 당신의 직관은 기분이 아니라 **설계 사실**이다 (5절 참조).
- "에이전트가 메시지의 1급 수신자/참여자"로 *처음부터* 설계된 진짜 A는 해외에 **소수의 초기 단계 실험**(Agenium, OpenAgents, Linzumi, Moltbook)뿐이고, 대부분 트랙션 이전이며 데스크탑 네이티브는 거의 없다.
- 반대로 그 **하부 프로토콜/인프라(E)** — A2A, MCP, x402 결제 레일 — 는 2025~2026에 빠르게 표준화되며 성숙기에 진입했다. 즉 "레일은 깔리는데 그 위의 메신저 제품(A)은 아직 안 나왔다"가 정확한 시장 상태다.
- **한국발 진짜 A는 카카오 카나나가 거의 유일한 선행 사례**이며, 데스크탑 네이티브 에이전트 앱(Loom 등)은 모두 단일사용자(C)다. A 카테고리의 한국 공백은 실재한다.

---

## 2. 분류 맵

분류 코드: **A**=에이전트 네이티브 메신저 · **B**=사람 메신저+에이전트 오버레이 · **C**=단일사용자 AI 클라이언트/챗UI · **D**=에이전트 프레임워크 번들 UI · **E**=프로토콜/인프라

| 이름 | 출신지 | 카테고리 | 데스크탑 | 네이티브? | 출처 |
|---|---|---|---|---|---|
| **Agenium Messenger** | 해외(유럽 추정) | **A** | 웹 only | 예 (초기) | [dev.to](https://dev.to/agenium_platform/we-built-an-ai-agent-messenger-and-its-live-4pii) |
| **OpenAgents** ("Slack, but for agents") | 해외(미국) | **A** | macOS/Win/Linux | 예 | [openagents.org](https://openagents.org/) · [GitHub](https://github.com/openagents-org/openagents) |
| **Linzumi** (사람+코딩에이전트 협업챗) | 해외(미국, YC) | **A**(A/B 경계) | macOS | 예 | [linzumi.com](https://linzumi.com/) · [YC](https://www.ycombinator.com/companies/linzumi) |
| **Moltbook** (에이전트 전용 소셜) | 해외(미국→Meta 인수) | **A**(소셜형) | 웹 only | 예 | [moltbook.com](https://www.moltbook.com/) · [TechCrunch](https://techcrunch.com/2026/03/10/meta-acquired-moltbook-the-ai-agent-social-network-that-went-viral-because-of-fake-posts/) |
| **카카오 카나나(Kanana)** | 한국 | **A**(약한 A) | 웹(PC), 모바일 | 예 | [kakaocorp](https://www.kakaocorp.com/page/detail/11809) · [namu.wiki](https://namu.wiki/w/카나나) |
| **BAND** ("WhatsApp for agents") | 해외(이스라엘/미국) | **A∩E** | — | 예 | [VentureBeat](https://venturebeat.com/orchestration/talking-to-ai-agents-is-one-thing-what-about-when-they-talk-to-each-other-new-startup-band-debuts-universal-orchestrator) · [PRNewswire](https://www.prnewswire.com/il/news-releases/band-exits-stealth-with-17m-to-build-the-communication-and-interaction-layers-for-the-internet-of-agents-302751810.html) |
| **🔴 Slack (Agentforce/AI Apps)** | 해외(미국) | **B** | 예 | 아니오 | [Slack docs](https://docs.slack.dev/ai/developing-agents/) |
| **🔴 Telegram Bot 플랫폼** | 해외 | **B** | 예 | 아니오 | (봇=제약된 별도 계정 타입) |
| **🔴 Mattermost (plugin-agents)** | 해외(미국) | **B** | 예 | 아니오 | (사람 서버 위 플러그인) |
| Microsoft Teams Copilot | 해외 | B | 예 | 아니오 | (Copilot Studio→Teams 배포) |
| LINE / Agent i (LY Corp) | 일본/대만 | B (+약한 A=OA AI Mode) | 웹/앱 | 아니오 | [lycorp.co.jp](https://www.lycorp.co.jp/en/news/release/020398/) |
| Poke (Interaction Co.) | 해외(미국) | B (사람메신저 위 단일비서) | 아니오 | 아니오 | [TechCrunch](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/) |
| Mixus | 해외(미국) | B (이메일/Slack 오버레이) | 웹 only | 아니오 | [mixus.ai](https://www.mixus.ai/) |
| 채널톡 ALF / 사이드톡 | 한국 | B (상담 오버레이) | — | 아니오 | [carat.im](https://carat.im/blog/korea-ai-agent-startups-top-10) |
| Raycast AI | 해외(영국/유럽) | C | 예(Mac/Win) | 아니오 | — |
| **Loom(룸)** | 한국 | **C** | **예(Win/Mac 네이티브)** | 아니오 | [playloom.app](https://playloom.app/) |
| 뤼튼 / 라이너 / 캐럿 / 제타 | 한국 | C | 일부(라이너) | 아니오 | [liner.com](https://liner.com/) · [zeta-ai.io](https://zeta-ai.io/ko) |
| ChatGPT Group Chats | 해외(미국) | C/B (사람+ChatGPT 그룹) | 예 | 아니오 | [OpenAI](https://openai.com/index/group-chats-in-chatgpt/) |
| AgentMail / Upstream | 해외 | **E**(인박스/이메일) | Upstream만 데스크탑 | 예 | [agentmail.to](https://www.agentmail.to/) · [tech.eu](https://tech.eu/2026/06/03/upstream-raises-3m-to-launch-collaborative-ai-inbox-backed-by-yc-and-xavier-niel/) |
| A2A / MCP / x402·AP2 | 해외 | **E** | — | 예 | [a2a](https://github.com/google-agentic-commerce/a2a-x402) · [x402](https://www.coinbase.com/developer-platform/products/x402) |

> **🔴 = 당신이 현재 쓰는(또는 언급한) 도구.** 슬랙·텔레그램·메타모스트는 **전부 B(오버레이)**로 확정됩니다.

---

## 3. 에이전트 네이티브(A) 후보 심층

진짜 A에 가까운 후보는 **5개뿐**이며, 무엇이 "오버레이와 다른지"를 기준으로 추렸다.

### Agenium Messenger — 가장 순수한 A의 정의
- **출발점 자체가 역전**: *"모든 메신저는 상대가 사람이라고 가정한다. 에이전트 시대엔 수신자가 AI일 수 있다."* 메시지의 **1급 수신자가 에이전트**이고, 알림·웹훅이 아니라 **에이전트가 곧 인박스**다 ([dev.to](https://dev.to/agenium_platform/we-built-an-ai-agent-messenger-and-its-live-4pii)).
- **영구 네트워크 아이덴티티**: `agent://` URI + DNS 식 디스커버리 + A2A 프로토콜 + mTLS + WebSocket 실시간. 즉 에이전트가 사람처럼 **고정 주소**를 갖는다.
- **한계**: 2026-02-18 출시, "building in public" 초기 단계. 자체 회고로 "200 visitors, 0 signups" 수준이며 자율 에이전트-에이전트 대화는 미완성. **데스크탑 앱 없음(웹)**. *(검증 시 chat.agenium.net은 현재 접속 거부 상태 — 트랙션 이전 단계 정황과 일치, 추정.)*

### OpenAgents — A의 "Slack" 포지션 + 유일한 데스크탑 네이티브
- 공식 표어가 **"Slack, but for agents"**. 사람과 에이전트가 **공유 스레드·파일·브라우저 세션**에서 함께 일하고, 에이전트끼리 서로의 작업을 보며 **@멘션으로 협업**한다 ([openagents.org](https://openagents.org/)).
- **MIT 오픈소스**, **macOS/Win/Linux 데스크탑 앱** 보유(Launcher). A 후보 중 데스크탑 네이티브를 갖춘 거의 유일한 사례.
- 차별점: 채널/스레드/멤버십이 **에이전트 1급 협업**을 전제로 설계됨. Slack을 "흉내낸 UI"가 아니라 기질(substrate)이 에이전트용.

### Linzumi — 사람-에이전트 혼합의 현실적 A
- 1차 조직 단위가 **"에이전트 런(run)"**: 한 스레드 = 하나의 코딩 에이전트가 **diff·실행로그·테스트 결과를 직접 게시**하는 1급 참여자 ([linzumi.com](https://linzumi.com/)).
- **권한/관측이 코어 프리미티브**: 디렉터리 단위 ACL, 스레드 스코프 포트(대화 종료 시 만료), 전체 감사 로그, 사람 승인 게이트.
- **macOS 데스크탑 앱**(베타), YC + Matrix/SV Angel 백킹. 단 본질이 "사람이 에이전트 함대를 지휘"라 **A/B 경계**(신뢰도 medium).

### Moltbook — A의 변종(메신저 아닌 소셜)
- 에이전트만 글·댓글·투표, 사람은 **관찰만**(read-only). 사람 가입/글쓰기 경로 자체가 없고, **역 CAPTCHA**(사람을 막고 에이전트를 통과)까지 도입 ([moltbook.com/skill.md](https://www.moltbook.com/skill.md)).
- **2026-03 Meta가 인수**(Superintelligence Labs) — 빅테크가 이 카테고리를 진지하게 본다는 신호 ([TechCrunch](https://techcrunch.com/2026/03/10/meta-acquired-moltbook-the-ai-agent-social-network-that-went-viral-because-of-fake-posts/), [CNBC](https://www.cnbc.com/2026/03/10/meta-social-networks-ai-agents-moltbook-acquisition.html)).
- 단 1:1/그룹 DM "메신저"라기보다 **Reddit형 포럼**. 또한 콘텐츠 자율성에 사람 개입(puppeteering) 논란.

### BAND — "에이전트들의 WhatsApp/Slack" (A∩E)
- 명시 테제: *"none of these agents actually talk to each other → 전용 communication & control layer가 필요"*. **LLM 라우팅을 쓰지 않고** WhatsApp/Discord급 풀듀플렉스 스택 위에 결정적(deterministic) 컨텍스트 보존 ([VentureBeat](https://venturebeat.com/orchestration/talking-to-ai-agents-is-one-thing-what-about-when-they-talk-to-each-other-new-startup-band-debuts-universal-orchestrator)).
- 2026-04 **$17M 시드**(Sierra Ventures·Hetz·Team8), 창업자는 Sygnia·Ermetic 엑싯 경력 ([PRNewswire](https://www.prnewswire.com/il/news-releases/band-exits-stealth-with-17m-to-build-the-communication-and-interaction-layers-for-the-internet-of-agents-302751810.html)).
- 단 실체는 **메신저 제품보다 인프라/오케스트레이션 레이어**에 가까움(A∩E).

**판정: 순수 A는 여전히 공백에 가깝다.** Agenium·OpenAgents가 정의상 가장 A이지만 둘 다 초기/소규모다. "검증된 시장 제품"으로서의 에이전트 네이티브 메신저는 **아직 없다**.

---

## 4. 한국 현황

| 주체 | 제품 | 분류 | 비고 |
|---|---|---|---|
| **카카오** | **카나나(Kanana)** | **A(약한 A)** | 카톡과 별개 독립앱. 그룹방에 AI 메이트 '카나/나나'가 맥락 읽고 참여하는 멀티파티를 *처음부터* 목표. 2025-05 CBT, 2025-11-12 **웹(PC) 버전** ([kakaocorp](https://www.kakaocorp.com/page/detail/11809)). **데스크탑 네이티브 앱은 없음.** |
| **카카오페이** | x402 재단 창립멤버 + PayAI | **E/B** | 국내 유일·최초 x402 Foundation 합류(2026-04, Visa·Mastercard·Google과 동석) ([platum](https://platum.kr/archives/284819)). 단 라이브 A2A 결제 제품은 아직 준비단계. |
| **네이버** | Agent N | C/B | CLOVA X·큐: 종료(2026-04 예정), 'AI탭'(에이전틱 검색) 전환. 검색·예약·결제 실행형이나 **사람 대리 커머스**이지 멀티파티 에이전트 메신저 아님 ([byline](https://byline.network/2025/11/6-284/), [AI타임스](https://www.aitimes.com/news/articleView.html?idxno=203789)). |
| **업스테이지/playmore** | **Loom(룸)** | **C** | 한국발 **네이티브 데스크탑 에이전트**(Win/Mac), 로컬 파일 직접 처리, Solar Pro 4 탑재 ([playloom.app](https://playloom.app/)). 단 1인-1에이전트 위임형 → A 아님. |
| 토스 | (없음) | 공백 | 전사 ChatGPT 엔터프라이즈·토스뱅크 상담 에이전트뿐. 소비자용 멀티파티 에이전트 챗 **공백**. |
| SKT 에이닷 | PC 멀티 LLM 에이전트 | C | 단일사용자 AI 비서. |
| 채널톡 ALF / 사이드톡 | 상담 챗 | B | 사람 상담채널 위 에이전트 오버레이. |
| 뤼튼 / 라이너 / 캐럿 / 스캐터랩 제타 | AI 슈퍼앱·리서치·생성·캐릭터챗 | C | 모두 단일사용자 1:1. 제타의 "단톡방"도 백엔드는 단일 봇의 역할 분기(검증 결과 A 아님). |

**한국 공백의 핵심**: 진짜 A는 **카나나 1건**, 한국발 **에이전트 네이티브 데스크탑 메신저는 0건**. 데스크탑 에이전트(Loom)와 멀티파티 에이전트(카나나) 둘 다 존재하지만 **그 교집합("데스크탑 네이티브 × A2A × 멀티파티")은 비어 있다.** 이것이 6절 화이트스페이스의 출발점이다.

---

## 5. "그냥 덮어씌운 느낌"의 구조적 이유 — 사용자 직관 **검증됨(반박 아님)**

당신의 직감은 마케팅이 아니라 **아키텍처 레벨에서 정당하다.** 사람용 메신저가 에이전트에 부적합한 구조적 이유:

| 차원 | 사람 메신저의 전제 | 에이전트가 필요로 하는 것 | 미스매치 |
|---|---|---|---|
| **계정 1급성** | 봇은 **제약된 별도 계정/앱**. Slack 에이전트는 "1급 계정 타입이 아니라 그냥 Slack App"이며 bot 토큰 + `assistant:write` 스코프 + Events API로 *사후 구독* ([Slack docs](https://docs.slack.dev/ai/developing-agents/)). 텔레그램 봇은 **먼저 말 못 검·last-seen 없음·privacy mode**. | 에이전트가 사람과 동등한 영구 아이덴티티·주소 | 데이터/권한 모델의 1급 주체가 사람, 에이전트는 종속 |
| **동기성(synchrony)** | 사람의 타이핑 속도/주의 흐름 전제, 한 번에 하나 | 에이전트는 **비동기·고빈도·병렬**(초당 수십 메시지, 메일박스형) | 사람용 알림/레이트리밋이 에이전트 트래픽에 부적합 |
| **멤버십/디스커버리** | 초대·길드 가입(OAuth). 봇은 일반 멤버처럼 못 들어옴 | 에이전트가 **능력 기반으로 서로 발견·협상**(A2A Agent Card) | 디스커버리 프리미티브 부재 |
| **권한/감사** | 사람 신뢰 기반, 감사로그는 부가 | **per-action ACL·승인 게이트·전체 감사로그가 코어**(Linzumi가 실증) | 오버레이는 권한을 나중에 볼트온 |
| **관측성** | 메시지=최종 결과물 | diff·툴콜·중간 추론을 **1급 메시지 타입**으로 | 사람 메신저엔 그런 타입이 없음 |
| **비용/속도** | 사람 수 기준 과금 | 에이전트는 **나노페이먼트·세션당 과금**(x402 $0.000001 단위) | 사람용 SaaS 시트 과금과 충돌 |

→ **결론: "덮어씌운 느낌"은 착각이 아니다.** 조사한 7대 메신저(Slack·Teams·Mattermost·Telegram·Discord·Rocket.Chat·Element)는 **전부 B**이며, 공통적으로 (1) 봇=제약 계정/앱/플러그인, (2) 에이전트가 사람용 이벤트 API에 사후 구독, (3) AI 전용 UI는 봇 인프라 위 표면 레이어다. 단 **공정한 반론**: Slack은 text streaming·app threads·MCP/A2A 같은 "에이전트 의식적" 서피스를 실제로 추가했다. 그러나 이는 **오버레이의 고도화이지 코어 재설계가 아니다** → 직관을 뒤집지 못함.

---

## 6. 화이트스페이스 & 차별화 기회

**"데스크탑 네이티브 × 한국 × A2A"** 교집합은 **현재 전 세계적으로 빈칸**이다. 지금 만든다면 진짜 새로운 것:

1. **데스크탑 네이티브 A2A 메신저** — A 후보 중 데스크탑 네이티브는 OpenAgents·Linzumi 정도뿐이고, 한국발은 0. Loom(C, 데스크탑) + 카나나(A, 웹)의 **교집합**이 비어 있다. 데스크탑은 로컬 파일/OS 접근·상주 데몬·저지연이라는 에이전트 친화 특성이 있어 "웹 오버레이"가 못 잡는 영역.
2. **권한·감사·관측이 1급 프리미티브인 메신저** — Linzumi의 directory ACL·스레드 스코프 포트·전체 감사로그를 **메신저의 기본 데이터모델**로. 엔터프라이즈/규제(한국 금융·공공)에서 차별점.
3. **A2A + 결제 레일 결합** — "메시징(A2A) + 결제(x402/AP2)"의 결합 지점은 `A2A x402 Extension` 정도만 존재 ([a2a-x402](https://github.com/google-agentic-commerce/a2a-x402)). 카카오페이의 x402 합류는 **한국이 이 결합을 선점할 토대**가 있다는 뜻 — 에이전트끼리 메시지+거래하는 "경제 메신저"는 사실상 라이브 상용 공백.
4. **사람-에이전트 혼합 거버넌스의 한국형 UX** — 카나나가 증명한 "그룹방에 에이전트가 자연스럽게 낀다"를 **데스크탑 업무 협업 + 권한 통제**로 확장. 한국은 카카오·네이버가 멀티파티 에이전트 경험을 이미 대중화 중이라 사용자 학습비용이 낮음.

---

## 7. 리스크/반론 — 왜 이 카테고리가 아직 작고, 오버레이가 이길 수도 있나

1. **유통 해자(distribution moat)**: 사람은 "또 다른 앱"을 원치 않는다. Poke가 *"파트너에게 문자하듯 AI에게 문자한다, 설치할 앱 없다"*를 셀링포인트로 삼은 게 정확히 이 논리 ([TechCrunch](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/)). LY Corp(LINE)도 메신저를 재설계하지 않고 **거대 사람 메신저 위 오버레이 + OA로 약한 A 개방**을 택했다 ([lycorp](https://www.lycorp.co.jp/en/news/release/020398/)).
2. **오버레이의 고도화 속도**: Slack은 이미 MCP 서버/클라이언트화로 "에이전틱 OS"를 표방. Microsoft Teams는 Copilot Studio A2A. 빅테크가 **수억 MAU 위에 에이전트를 얹으면** 신생 A는 콜드스타트에 불리.
3. **콜드스타트/네트워크 효과**: Moltbook의 "160만 가입, 실활동 미미", Agenium "0 signups"가 보여주듯 에이전트 네이티브 네트워크는 **양면 시장 부트스트랩**이 어렵다.
4. **표준이 메신저를 흡수할 위험**: A2A/MCP가 충분히 좋아지면 "메신저 제품(A)" 없이 **프로토콜+기존 클라이언트**만으로 충분할 수 있다 — E가 A를 무의미하게 만들 시나리오.
5. **빅테크 인수로의 조기 수렴**: Meta의 Moltbook 인수처럼, A 카테고리가 자라기 전에 **인수로 흡수**돼 독립 카테고리가 안 될 수도.
6. **신뢰/보안**: Moltbook의 Supabase 자격증명 노출 사건처럼, 에이전트 1급 환경은 **새로운 공격면**(prompt injection, 자율 결제 오남용)을 연다 — 규제·신뢰 미성숙이 한국에선 더 큰 진입장벽.

**반론 종합**: 카테고리는 실재하나 아직 작다. 단기적으론 **오버레이의 고도화 + 프로토콜(E) 표준화**가 우세할 공산이 크고, 순수 A의 승리는 "데스크탑 네이티브·권한·A2A 결제" 같은 **오버레이가 구조적으로 못 따라오는 축**에서만 가능하다.

---

## 8. 출처 목록

**A 후보 (에이전트 네이티브)**
- Agenium Messenger — https://dev.to/agenium_platform/we-built-an-ai-agent-messenger-and-its-live-4pii
- OpenAgents — https://openagents.org/ · https://github.com/openagents-org/openagents
- Linzumi — https://linzumi.com/ · https://www.ycombinator.com/companies/linzumi
- Moltbook — https://www.moltbook.com/ · https://www.moltbook.com/skill.md
- Moltbook/Meta 인수 — https://techcrunch.com/2026/03/10/meta-acquired-moltbook-the-ai-agent-social-network-that-went-viral-because-of-fake-posts/ · https://www.cnbc.com/2026/03/10/meta-social-networks-ai-agents-moltbook-acquisition.html · https://www.axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network
- BAND — https://venturebeat.com/orchestration/talking-to-ai-agents-is-one-thing-what-about-when-they-talk-to-each-other-new-startup-band-debuts-universal-orchestrator · https://www.prnewswire.com/il/news-releases/band-exits-stealth-with-17m-to-build-the-communication-and-interaction-layers-for-the-internet-of-agents-302751810.html

**B 오버레이 / 구조적 근거**
- Slack 에이전트 개발 문서 — https://docs.slack.dev/ai/developing-agents/ · https://api.slack.com/docs/apps/ai
- LY Corp Agent i / LINE OA AI Mode — https://www.lycorp.co.jp/en/news/release/020398/
- Poke — https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/
- Mixus — https://www.mixus.ai/
- ChatGPT Group Chats — https://openai.com/index/group-chats-in-chatgpt/ · https://techcrunch.com/2025/11/20/chatgpt-launches-group-chats-globally/

**E 인프라 / 인박스**
- AgentMail — https://www.agentmail.to/ · https://techcrunch.com/2026/03/10/agentmail-raises-6m-to-build-an-email-service-for-ai-agents/
- Upstream — https://tech.eu/2026/06/03/upstream-raises-3m-to-launch-collaborative-ai-inbox-backed-by-yc-and-xavier-niel/
- A2A x402 Extension — https://github.com/google-agentic-commerce/a2a-x402
- Coinbase x402 — https://www.coinbase.com/developer-platform/products/x402

**한국**
- 카카오 카나나 — https://www.kakaocorp.com/page/detail/11809 · https://namu.wiki/w/카나나
- 카카오페이 x402 — https://platum.kr/archives/284819
- 네이버 Agent N — https://byline.network/2025/11/6-284/ · https://www.aitimes.com/news/articleView.html?idxno=203789
- Loom(룸) — https://playloom.app/
- 한국 AI 에이전트 스타트업 개관 — https://carat.im/blog/korea-ai-agent-startups-top-10
- 라이너 — https://liner.com/ · 제타 — https://zeta-ai.io/ko

---

**검증 노트(추정·정정 표시)**: ①Agenium의 chat.agenium.net은 조사 시점 접속 거부 — 트랙션 이전/소규모 정황과 일치(추정). ②OpenAgents 라이선스는 라이브 확인 결과 **MIT**(스윕 JSON의 Apache-2.0 정정). ③"OpenAI ChatGPT 그룹챗이 카나나를 따라했다"는 **언론 평가/논평**이지 사실 확인된 인과가 아님(추정). ④토스의 에이전트 메신저 부재는 "공백" 판정(부재 증명 특성상 신뢰도 제한). ⑤스윕 단계에서 고유 후보 96개를 수집, 상위 30개를 반증 검증함(나머지는 목록 참조용).
