# momo — 차원이 다른 에이전트 네이티브 경험 설계 문서

> **수석 프로덕트 디자이너 통합본 v1.0** · 2026-06-23
> 제품: **momo** — AI 에이전트가 사람과 동등한 **1급 멤버**인 자체구축 메신저 (Swift macOS 우선 + iOS / Hummingbird 2 + Centrifugo v6 + PostgreSQL 18)
> 본 문서의 **모든 경험은 [L4 스펙](/Users/kwakseongjae/projects/momo/research/07-deepdive/04-self-build-l4-spec.md) 프리미티브 위에서만** 정의된다. 스펙에 없는 것은 §6에서 "추가 필요"로 명시한다.
>
> 표기: `(검증됨)` = 공식문서/리포 교차확인 · `(추정)` = 설계 판단 · `[반증]` = 경쟁사가 이미 함(차별화 약함)
>
> **핵심 반증 결론(웹 검증):** "에이전트=멤버 / @멘션 위임 / presence / tool_call 표시 / 승인 버튼 / 먼저 말걸기 / 리치카드 / 비용 대시보드 / 브랜칭 / undo / 졸업형 자율성"은 **2026년 시점에 모두 어딘가에 존재한다.** 따라서 이것들 *단독*으로는 "차원이 다르다"고 주장할 수 없다. **momo의 진짜 차별점은 단일 기능이 아니라 위치(location)와 재질(material)이다:** 위 모든 거버넌스·협업·경제·기억 객체를, dev 대시보드/백엔드 배관/단일사용자 도구가 아니라 **공유 사회적 채널 타임라인 위의 1급·주소가능·재생가능·조작가능한 메시지 객체**로 만든다. 이는 momo의 L4 프리미티브 조합(member kind=agent, agent_run 상태머신, A2A depth/라운드배리어, actor/subject 델리게이션+audit_log, reserve/reconcile 2단계 회계, 승인게이트, Centrifugo agent.partial, 채널별 모노토닉 seq) 위에서만 자연스럽게 성립한다.

---

## 1. 디자인 원칙 — "에이전트가 1급 멤버"가 UX에 의미하는 것

momo가 다른 모든 메신저/에이전트 제품과 갈라지는 헌법은 다음 5원칙이다. 각 원칙은 "왜 incumbent가 구조적으로 못 하는가"를 포함한다.

### 원칙 1 — 모든 거버넌스는 대화 안에서 일어난다 (Governance-in-Conversation)
승인·감사·비용·권한·되돌리기는 별도 admin 콘솔/dev 대시보드/관리자 센터가 아니라 **사람과 에이전트가 같이 보는 채널 타임라인의 1급 메시지**로 surface된다. Slack은 Thinking Steps와 Multi-click 승인버튼을 갖지만 승인은 여전히 메시지에 박힌 단건 버튼이고([Slack Thinking Steps](https://slack.dev/slack-thinking-steps-ai-agents/) 검증됨), 비용·감사·리플레이는 전부 별도 백엔드 계층이다. momo는 `approval_request`가 1급 메시지 타입이고 `usage_ledger`/`budget_window`가 `agent_run`에 묶여 있어 이 통합이 무료로 나온다(스펙 §5.2, §8.5).
- **UX 함의:** 컨텍스트 스위칭 0. "지금 이 대화에서 이 에이전트가 무엇을·누구 권한으로·얼마에 하려는지"를 그 자리에서 본다.

### 원칙 2 — 에이전트끼리의 일은 숨은 배관이 아니라 관전 가능한 사회 surface다 (Visible A2A)
Salesforce Agentforce는 A2A 위임이 *behind the scenes / no tab-switching*로 의도적으로 **숨겨진다**고 명시한다([Slack/Agentforce](https://slack.com/blog/news/turn-agents-into-teammates-with-slack) 검증됨). Google/IBM A2A 프로토콜은 백엔드 interoperability이고, AG-UI만이 visible·interruptible UX를 지향하나 *제품이 아니라 프로토콜*이다([IBM A2A](https://www.ibm.com/think/topics/agent2agent-protocol), [AG-UI/Codecademy](https://www.codecademy.com/article/ag-ui-agent-user-interaction-protocol) 검증됨). momo는 A2A를 `depth`/라운드배리어 위에서 채널 안 1급 스레드로 렌더하고 사람이 관전·난입한다(스펙 §3.4).
- **UX 함의:** "에이전트 둘이 대화" = 스팸/루프가 아니라 **정상 사회 활동**. depth/라운드배리어가 무한루프를 구조적으로 막기 때문에 노출이 안전하다.

### 원칙 3 — 신원과 책임은 항상 사회적으로 드러난다 (Accountable Identity)
에이전트가 누군가를 대신해 행동하면(actor=agent, subject=human) 그 합성 신원과 audit 리본이 메시지에 박힌다. OAuth on-behalf-of 델리게이션 체인(IETF draft, MCP OAuth 2.1)은 **토큰 스펙으로만** 존재하고 consent UI·체인 시각화는 "구현자에게 맡김" 상태다([Antigravity reversibility](https://antigravitylab.net/en/articles/agents/antigravity-agent-reversibility-tiered-autonomy-architecture) 등 검증됨). momo는 `token(kind='delegation')` + `audit_log.via_token_id`가 1급이라(스펙 §7.3) "X가 Y로서" 행동이 사회적으로 보인다.
- **UX 함의:** 익명 봇 행동이 없다. 모든 부수효과에 "누가·누구 권한으로·언제"가 따라붙는다.

### 원칙 4 — 돈은 살아있는 사회 신호다 (Economy as a First-Class Signal)
2026년 비용 추적은 보편화됐지만([AI agent cost 2026](https://cowork.ink/blog/ai-agent-cost/), [LeanOps](https://leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026/) 검증됨) **전부 사후 dev/finops 대시보드**다. 어떤 메신저도 비용을 "사람과 에이전트가 같은 대화에서 보고 반응하는 사회적 메시지 객체"로 만들지 않는다. momo는 `reserve`(호출 전 예약) → 실시간 micro_usd → `reconcile`(실측 확정) 2단계 회계가 `agent_run` 상태머신·`approval_request`와 묶여 있다(스펙 §8.5).
- **UX 함의:** 비용이 "예약→호흡→확정"하는 시각 객체가 되고, 한도 임박이 그 자리의 승인 결정이 된다.

### 원칙 5 — 시간은 되감을 수 있고, 기억은 함께 길들인다 (Reversible & Socialized)
채널별 모노토닉 `seq` + 1급 메시지 + `audit_log`가 협업 전체를 **결정론적으로 재생·되감기 가능한 이벤트 원장**으로 만든다(스펙 §3.1, §8.8). 에이전트의 부작용 행동은 보상 트랜잭션으로 되돌릴 수 있고(가역성 등급별), 에이전트의 "믿음"은 팀이 함께 교정한다. 2026 에이전트 메모리 연구가 "single-user, single-agent paradigm이 multi-user에서 무너진다"고 명시한 바로 그 공백([State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) 검증됨)을 momo가 채운다.

### 우리가 안 하는 것 (안티패턴)
| 안 함 | 왜 |
|---|---|
| **에이전트를 webhook 봇/슬래시커맨드로 취급** | 봇은 채널에 초대되지만 momo 에이전트는 `member`로 *산다*(presence/lifecycle/상태머신). 봇 모델이면 모든 원칙이 무너진다. |
| **거버넌스를 별도 admin/dev 콘솔로 분리** | 원칙 1 위반. 컨텍스트 스위칭이 신뢰를 죽인다. |
| **A2A 협업을 숨기기(Agentforce식)** | 원칙 2 위반. "숨김"은 incumbent의 기본값이고, 그게 정확히 momo의 white space다. |
| **비용을 사후 리포트로만** | 원칙 4 위반. 사후 리포트는 행동을 못 바꾼다. |
| **익명/추적불가 에이전트 행동** | 원칙 3 위반. via_token 없는 부수효과 금지(스펙 §6.3). |
| **단순 라벨 presence (display-only)** | Discord 봇도 online/idle을 표시한다[반증]. momo presence는 *조작 가능*해야 한다(끼어들어 steer). |
| **엔터테인먼트용 에이전트 디베이트(ELO/챔피언벨트)** | 관객 투표가 재미용인 Agents Arena류는 업무 결정에 안 묶임. momo 토론은 audit된 인간 캐스팅보트로 canonical을 고정한다. |
| **v0에서 E2EE/음성영상/외부 SSO** | 스펙 §0.4 out-of-scope. 경험을 프리미티브에 정직하게 맞춘다. |

---

## 2. 시그니처 경험 Top (우선순위)

novelty 검증을 통과한 진짜 차별화만 상위로. `novel=false`(이미 존재)는 **강등**하되, "통합/위치/재질"에서 차별화가 있으면 표에 남기고 명시. **wow×feasibility×novelty**로 우선순위화.

| # | 경험 | 한줄 | why-only-agent-native | 사용 프리미티브(핵심) | platform | wow | feasibility | novelty 판정 (+prior art) |
|---|---|---|---|---|---|---|---|---|
| **A** | **유리 어항 (Glass Aquarium)** | A2A 협업을 관전·난입 가능한 1급 스레드로 | 봇은 숨은 배관, momo는 A2A가 사회 surface | A2A(depth/라운드배리어), agent_run, agent.partial, 1급 메시지(tool_call/diff), seq, audit_log | both | high | v1 | ✅ **novel** — Slack Thinking Steps/Copilot A2A는 결과만, [Agentforce는 협업을 의도적 숨김](https://slack.com/blog/news/turn-agents-into-teammates-with-slack) |
| **B** | **비용 호흡 (Cost Breathing)** | 메시지 버블이 reserve→reconcile 비용을 "호흡" | 비용이 dev 대시보드가 아닌 사회 메시지 | reserve/reconcile micro_usd, agent_run, approval_request, agent.partial | both | high | **v1** | ✅ **novel** — [비용추적은 보편화](https://leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026/)됐으나 전부 사후 finops 대시보드 |
| **C** | **승인 인박스 (Approval Inbox)** | awaiting_approval을 줄세워 배치 처리 | 1급 승인 메시지 + 델리게이션 배지 통합 | approval_request, agent_run(awaiting), 델리게이션, reserve, seq | both | high | **v0** | ⚠️ false→**통합으로 차별** — [Slack 승인은 단건 버튼](https://slack.dev/slack-thinking-steps-ai-agents/), 배치 awaiting 인박스 없음 |
| **D** | **Live Tool-Call 카드** | 스트리밍 중 취소/수정/재시도 가능한 도구카드 | 스트림+인라인 조작+실시간 비용 결합 | agent.partial, tool_call/tool_result, agent_run, reserve | both | high | **v0** | ⚠️ false→**타이밍으로 차별** — Slack Task Card/Thinking Steps 존재하나 실행 중 modify-then-retry 없음 |
| **E** | **신원의 가면 (Who-as-Whom)** | "X가 Y로서" 합성신원 + audit 리본 | 델리게이션이 메신저 UX로 사회화 | actor/subject 델리게이션+audit_log, 승인게이트, 1급 메시지 | both | high | v1 | ✅ **novel** — OAuth OBO는 토큰 스펙만, consent UI는 "구현자 위임" |
| **F** | **끼어들 수 있는 존재감 (Interruptible Presence)** | presence를 실시간 steer | display-only가 아닌 조작 가능 presence | member(presence/lifecycle), agent_run, agent.partial, A2A | both | high | v1 | ✅ **novel** — Discord/Slack presence는 표시전용, interrupt는 SDK 계층 |
| **G** | **분기되는 사회적 타임라인 (Branchable Timeline)** | 채널을 평행우주로 갈래내고 인간이 정본 승격 | 멀티유저 공유 갈래 + 갈래별 비용/A2A 격리 | seq(분기좌표), agent_run(갈래별), reserve/reconcile(갈래별 원장), A2A | both | high | v1 | ✅ **novel** — [브랜칭은 단일사용자만](https://tianpan.co/blog/2026-04-23-conversation-branching-first-class-primitive), "멀티유저·사회적 정본"은 미해결로 명시 |
| **H** | **되돌리기 가능한 동료 (Undoable Colleague)** | 가역성 배지 + 인라인 undo + 보상 + audit | 되돌림이 대화 안 사회적 행동 | tool_call/tool_result, audit_log, reserve/reconcile, 승인게이트, 델리게이션 | both | high | v1 | ✅ **novel** — [undo는 인프라/단일사용자](https://research.ibm.com/blog/undo-agent-for-cloud), [Antigravity 3-tier는 dev/비대면](https://antigravitylab.net/en/articles/agents/antigravity-agent-reversibility-tiered-autonomy-architecture) |
| **I** | **공개 토론 + 인간 캐스팅보트 (Visible Debate)** | 불일치를 숨기지 않고 인간이 audit된 결정표 | 백엔드 토론이 아닌 영속 사회 회의록 | A2A(라운드배리어), approval_request, agent_run, 델리게이션+audit, reserve | both | high | v1 | ✅ **novel** — [MindStudio 토론은 합의안만 노출](https://www.mindstudio.ai/blog/token-based-pricing), 디베이트 관전은 엔터테인먼트 |
| **J** | **길들이기 (Socialized Memory)** | 팀이 함께 에이전트 믿음을 교정·합의 | 메모리가 팀 사회적 합의 사건 | 1급 메시지(diff 재사용), 델리게이션+audit, 승인게이트, member 속성, seq | both | high | v1 | ✅ **novel** — [메모리는 single-user paradigm](https://mem0.ai/blog/state-of-ai-agent-memory-2026), multi-user 사회화 없음 |
| **K** | **앰비언트 인박스 (Ambient Inbox)** | 능동행동(Notify/Question/Review) 단일 수신함 | seq 역추적 + 델리게이션 + audit 결합 | 메일박스, seq, 델리게이션+audit, approval_request, agent_run | both | high | **v0** | ⚠️ false→**종단 추적성으로 차별** — Slack Activity 뷰 유사하나 seq 좌표 역추적 없음 |
| **L** | **수습→정직원 (Earned Autonomy)** | 신뢰 축적과 승인게이트의 점진적 소멸을 팀이 관전 | 자율성이 팀이 보는 사회적 멤버 지위 | member status, 승인게이트, audit_log, reserve, agent_run | both | medium | v2 | ✅ **novel** — [ATF는 backend governance, chat 미노출](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents) |
| M | 라이브 스탠드업 (Choreographed Standup) | 라운드배리어로 안무된 에이전트 팀 보고 | 여러 에이전트가 서로 순서 인지하며 핸드오프 | A2A(라운드배리어), agent_run, seq, reconcile | desktop | medium | v1 | ⚠️ 부분 — cron 스탠드업 존재하나 멀티에이전트 동기 보고 아님 |
| N | 야간조 스탠드업 (Night Shift) | 자는 동안 일하고 아침 1장 보고 + 스크럽 재생 | ever-present member + agent_run 히스토리 재생 | agent_run, presence/lifecycle, reserve/reconcile, 1급 메시지, seq | both | high | v1 | ⚠️ 부분 — [Copilot Cowork 근접](https://www.swarmia.com/blog/five-levels-ai-agent-autonomy/)하나 스크럽 재생 없음 |
| O | 먼저 두드리기 (Earned Knock) | 비용예산 가진 근거 있는 주도적 노크 | 승인게이트+reserve로 "무엇을 얼마에" 제안 | 승인게이트, reserve/reconcile, member, approval_request, 메일박스 | both | medium | v1 | ⚠️ 부분 — proactive bot 흔함, 업무적 1급 흐름은 차별 |

**강등/제외:** "단순 @멘션 호출", "presence 라벨 표시", "tool_call 단순 표시", "리치 카드"는 [반증]으로 독립 경험에서 제외(원칙·인프라로만 흡수).

---

## 3. 시그니처 경험 5~8개 심층

상위 8개(A, B, C/D 통합, E, F, G, H, I)를 심층 설계한다. 각 경험은 **무엇/왜 우리만/UX 플로우/화면 스케치/프리미티브/엣지케이스 + money shot**.

---

### 경험 A — 유리 어항 (Glass Aquarium) `both · wow:high · v1`

**무엇:** 두 에이전트가 서로 @멘션으로 협업하는 A2A 대화를, 사람이 들여다보고 임의 라운드에 난입할 수 있는 1급 스레드로 렌더한다.

**왜 우리만:** [Salesforce는 A2A를 의도적으로 숨기고](https://slack.com/blog/news/turn-agents-into-teammates-with-slack)(검증됨), A2A 프로토콜은 백엔드 interoperability이며([IBM](https://www.ibm.com/think/topics/agent2agent-protocol)), AG-UI는 제품이 아닌 프로토콜이다. momo는 `agent_run.depth`/라운드배리어(스펙 §3.4)가 무한루프를 *구조적으로* 막기 때문에 협업을 사회 surface로 안전하게 노출할 수 있다 — 이게 락(lock)이다.

**UX 플로우:**
1. `#feature-pg18`에서 사람이 `@설계자 마이그레이션 전략 짜줘`.
2. 설계자가 thinking→streaming으로 답하다 `@구현자 이거 구현 가능성 봐줘`로 멘션 → A2A 라운드 1 시작.
3. 스레드 우측 사이드패널이 **"에이전트 협업 뷰"**로 전환. 라운드별 타임라인(좌:설계자 / 우:구현자 / 가운데:공유 artifact diff).
4. 헤더 배지: `depth 2 · round 1/4 · 2 agents active` (라운드 상한 R=4, 스펙 §3.4).
5. 사람은 **관전 모드**로 보다가 하단 **[JOIN]** → 임의 라운드에 `이 API 말고 기존 auth 모듈 재사용해` 난입.
6. 난입 메시지는 시각 강조(좌측 컬러 레인 + "human steer" 배지)되고, **다음 라운드 배리어에서** 에이전트들이 컨텍스트로 흡수. 그동안 `queued: your steer will apply next round` 인디케이터.
7. 사람 발화가 끼면 모든 에이전트의 `consecutive_auto`·A2A 라운드 카운터가 0으로 리셋(스펙 §3.4) → 정상 협업은 안 막고 폭주만 차단.
8. 난입은 `audit_log`에 "인간 개입" 마커로 기록.

**화면 스케치(텍스트):**
```
┌─ #feature-pg18 ──────────────┬─ 🐠 에이전트 협업 뷰 ─────────────┐
│ 상준: @설계자 마이그레이션...   │ depth 2 · round 1/4 · ●●2 active  │
│ 🤖설계자 ✦ streaming...       │ ┌─ ROUND 1 ──────────────────┐    │
│   @구현자 구현 가능성 봐줘      │ │ ◀설계자          구현자▶    │    │
│                              │ │ "스키마 분리"   "auth 의존성 │    │
│ [관전 중 — JOIN하려면 ↓]      │ │              충돌 있음"      │    │
│                              │ │   ╲___ diff.artifact ___╱   │    │
│                              │ └────────────────────────────┘    │
│                              │ ⓘ queued: 다음 라운드에 반영        │
│ [JOIN] ▸ "기존 auth 재사용해" │ [⏸ pause round] [⏭ next round]    │
└──────────────────────────────┴───────────────────────────────────┘
```

**프리미티브:** A2A(멘션·협업, depth/라운드배리어 §3.4) · agent_run 상태머신 · agent.partial 스트리밍(§5.2) · 1급 메시지(tool_call/tool_result/diff) · channel_seq · audit_log.

**엣지케이스:**
- depth=4 도달 → 자동 정지 + "최대 협업 깊이 도달, 사람 결정 필요" 카드.
- 사람이 라운드 *중간*에 난입 → 현재 라운드 무효화 X, 다음 배리어까지 queued(라운드 의미론 보존).
- 한 에이전트가 awaiting_approval로 멈추면 동료 lane에 "○○ 대기 중(배리어 연장)" 미니칩.
- 시맨틱 루프(G4 SimHash, §3.3) 감지 시 어항에 "반복 감지 — 개입 권장" 경고.

**🎬 Money shot:** *두 에이전트가 라운드를 주고받으며 diff가 자라는 동안, 사람이 "기존 auth 재사용해" 한마디를 던지자 다음 라운드에서 두 에이전트가 동시에 그 한마디를 흡수해 방향을 트는 장면* — A2A가 숨은 배관이 아니라 사람이 지휘할 수 있는 유리 어항임을 한 컷으로 증명.

---

### 경험 B — 비용 호흡 (Cost Breathing) `both · wow:high · v1`

**무엇:** 에이전트 메시지 버블 자체에 실시간 비용 게이지가 "호흡"한다. reserve 시 점선 링 → 작업 중 micro_usd 실시간 충전 → reconcile 시 실제값으로 링이 굳는다.

**왜 우리만:** [2026 비용추적은 보편화](https://leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026/)됐으나 전부 사후 finops 대시보드다. momo는 reserve/reconcile 2단계 회계가 `budget_window`에서 인프라 1급이고(스펙 §8.5), `agent_run` 상태머신·`approval_request`와 묶여 있어 비용이 "대화 그 자리의 1급 객체"가 된다.

**UX 플로우:**
1. 에이전트가 작업 시작 → budget reserve(estimate=max_output_tokens 상한, §8.5) → 버블 좌측에 **점선 링 + "예약 $0.40"**.
2. 작업 중 SSE delta마다 micro_usd가 실시간 채워짐(agent.partial과 동기, §6.2) → 링이 호박색으로 차오름.
3. 종료 시 reconcile(SSE 마지막 청크 usage 실측, §8.5) → **"$0.28 (예약 대비 -30%)"**, 링이 색 고정.
4. 한도 임박(soft_limit, §2.3) → 버블이 호박색 전체로 변하고 `this run will exceed channel budget` + **inline approval_request 카드**(승인 / 한도+$5 / 거부)가 같은 스레드에 1급으로 슬라이드인 → 그 자리 승인(G6, §3.3).
5. 채널 헤더에 `today: $3.10 · 60% @리서처` 사회적 비용 칩.

**화면 스케치:**
```
┌─────────────────────────────────────────────┐
│ ⊙ 🤖리서처   (◐ 충전중...)                    │
│ ╎$0.40 예약   "벤더 3곳 비교 분석 중..."       │  ← 점선 링→실선
│ ───────────────────────────────────────────  │
│ ⚠ 이 run은 채널 예산 80% 초과 예정             │
│  ┌ approval_request ──────────────┐          │
│  │ [승인] [한도 +$5] [거부]         │          │
│  └─────────────────────────────────┘          │
│ ✓ 완료 ● $0.28 (예약 -30%)                     │  ← reconcile 확정
└─────────────────────────────────────────────┘
채널 헤더:  💰 today $3.10  ·  60% @리서처 ▾
```

**프리미티브:** 비용 2단계 회계(reserve/reconcile, micro_usd §8.5) · agent_run(awaiting_approval) · approval_request 1급 메시지 · agent.partial · budget_window soft_limit.

**엣지케이스:**
- SSE usage 누락(스펙 §6.3 fallback 경고) → `was_estimated=true`, 링에 점선 유지 + "추정치" 라벨(추정 표시).
- reserve 트립(한도 초과) → run 시작 전 abort + "예산 트립" 카드(결정론적, §8.5).
- lazy-inline 롤오버(§8.5)로 새 period 시작 → 헤더 칩 자동 리셋.

**🎬 Money shot:** *에이전트 버블의 점선 링이 작업 중 호박색으로 차오르다 한도 80%에서 그 자리에 "한도 +$5?" 승인 카드가 떠오르고, 사람이 탭하자 링이 계속 차오르다 "$0.28 (예약 -30%)"로 굳는 장면* — 돈이 대시보드가 아니라 대화 안에서 살아 호흡함을 증명.

---

### 경험 C+D — 승인 인박스 + Live Tool-Call 카드 (Approval Inbox & Live Tool-Call) `both · wow:high · v0`

**무엇:** (D) tool_call이 스트리밍되는 동안 취소/파라미터수정/재시도 가능한 라이브 카드 + (C) 모든 `awaiting_approval`을 줄세워 배치 처리하는 1급 인박스. **둘은 한 화면의 흐름**(카드→인박스)이라 묶어 설계.

**왜 우리만:** [Slack Thinking Steps + Task Card + Multi-click 버튼](https://slack.dev/slack-thinking-steps-ai-agents/)은 존재하나(검증됨) — (1) 승인은 *실행 전* 단건 confirm이지 *실행 중* modify-then-retry가 아니고, (2) bulk awaiting_approval을 1급 인박스로 surface한 제품이 없다(Teams의 bulk는 관리자 측 *설치*이지 런타임 *행동* 승인이 아님). momo는 approval_request가 1급 메시지 + agent_run(awaiting) + 델리게이션 배지 + reserve를 한 표면에 결합한다.

**UX 플로우(D, v0):**
1. `searching repo…` 카드 fade-in, 헤더 배지 `thinking→streaming→awaiting_approval` 실시간(§5.2).
2. result 전부터 partial 출력이 토큰 단위로 본문에 흐름(agent.partial). 우상단 `$0.0021↑` 카운트업(reserve).
3. **스트리밍 중에도** [취소][파라미터 수정][재시도]가 살아있음. 취소 탭 → canceled, reserve분만 reconcile(`$0.0009`).
4. 데스크탑 hover로 raw JSON, iOS long-press.

**UX 플로우(C, v0):**
1. 좌측 글로벌 핀 **`Approvals (12)`** → 우측 카드 리스트. 카드 한 줄: `어느 에이전트 / 누구를 대신해(actor·subject) / 무슨 tool_call / 예상비용 micro_usd / reversible·irreversible 배지`.
2. 상단 필터(에이전트별/위험도별/비용순) + 배치 바 `선택 3건 · 예상 $0.42 · 승인`.
3. 멀티셀렉트 + 배치 액션: **`Approve all reversible`** / `$N 이하 자동승인` / `같은 도구끼리 일괄승인`.
4. 카드 펼침 → dry-run diff/파라미터(경험 H의 dry-run과 연동).
5. iOS: 탭바 `Approvals` 배지, 카드 스와이프(우=승인, 좌=거부), 멀티셀렉트는 길게누름.
6. 거부 시 인라인 A2A 사유 멘션 → 에이전트가 그 부분만 partial로 재생성.

**화면 스케치:**
```
┌─ Approvals (12) ─────────────────────────────┐
│ 필터: [에이전트▾][위험도▾][비용순▾]            │
│ ☑ 🤖빌드봇 ·(상준 대신)· deploy:prod  🔴비가역 │
│   $0.12  [▸dry-run]                           │
│ ☑ 🤖리서처 ·(나)· web_fetch ×3   🟢가역  $0.04 │
│ ☐ 🤖파이낸스 ·(팀장 대신)· transfer $100 🔴   │
│ ───────────────────────────────────────────  │
│ 선택 2건 · 예상 $0.16 · [✓ 승인] [모두 가역만] │
└───────────────────────────────────────────────┘
```

**프리미티브:** approval_request 1급 메시지 · agent_run(awaiting_approval §6.1) · actor/subject 델리게이션 · reserve micro_usd · agent.partial · channel_seq · Centrifugo 실시간 상태전환.

**엣지케이스:**
- 승인 timeout=30m → abort(스펙 §6.2). 인박스에서 "만료됨" 처리.
- irreversible은 `Approve all reversible` 배치에서 자동 제외(반드시 개별 확인).
- 스트리밍 중 파라미터 수정 → 현재 run 취소 + 새 idempotency_key로 재시도(스펙 §6.1 cancelRun).

**🎬 Money shot:** *12건의 awaiting_approval이 위험도 배지와 함께 줄서 있고, 사람이 "Approve all reversible"을 누르자 🟢가역 9건이 일제히 체크되며 사라지고 🔴비가역 3건만 남아 개별 확인을 요구하는 장면* — 승인이 단건 버튼 지옥이 아니라 1급 배치 표면임을 증명.

---

### 경험 E — 신원의 가면 (Who-as-Whom) `both · wow:high · v1`

**무엇:** 에이전트가 누군가를 대신해 행동할 때 합성 아바타(큰 원=actor 에이전트, 작은 배지=subject 사람)가 뜨고, 그 메시지로 실행된 모든 tool_call에 `authorized by 상준 · 2026-06-23 14:02` audit 리본이 달린다.

**왜 우리만:** OAuth on-behalf-of 델리게이션 체인(actor/subject)은 IETF draft·MCP OAuth 2.1로 **토큰 스펙만** 존재하고 consent UI·체인 시각화는 "구현자에게 맡김" 상태다(웹 검증: 거버넌스 도구들도 토큰/백엔드 계층). momo는 `token(kind='delegation')` + `token_delegation_ck`(subject 강제) + `audit_log.via_token_id`가 1급이라(스펙 §7.3) 메신저 UX로 사회화된다.

**UX 플로우:**
1. 상준이 리서처에게 `messages:write` + `read:거래내역` scope로 위임(범위 칩: 읽기=회색/쓰기=주황/송금=빨강).
2. 리서처가 상준 대신 행동 → 메시지에 **합성 아바타**(메인 원 + 우하단 작은 신원 배지) + "Researcher acting as @상준".
3. 메시지 호버/롱프레스 → **audit 리본 펼침**: `actor · subject · scope · timestamp · 이 행동으로 생긴 변경 N건`.
4. subject 전용 **`Delegation Inbox`**: 내 이름으로 실행 중/완료된 액션 라이브 피드 + per-row **REVOKE**.
5. revoke도 audit_log 1급 사건으로 기록.

**화면 스케치:**
```
┌─────────────────────────────────────┐
│  ◯➊  Researcher  acting as  @상준    │  ← 합성 아바타
│      "거래내역 조회 후 요약했습니다"   │
│   ╰─ 🎗 authorized by 상준 · 14:02   │
│       scope: read:거래내역(회색)      │
│       변경 0건 · [audit ▾]            │
└─────────────────────────────────────┘
Delegation Inbox (내 이름으로):
  ● 진행중  리서처 → web_fetch  [REVOKE]
  ✓ 완료    리서처 → summarize  14:02
```

**프리미티브:** actor/subject 델리게이션 + audit_log(§7.3) · 승인게이트 · agent_run(awaiting_approval) · 1급 메시지 · 메일박스(Delegation Inbox).

**엣지케이스:**
- scope 초과 행동 시도 → 승인게이트로 승격(§7.2) + "권한 초과 — 승인 필요".
- A2A로 위임 연쇄(설계자→구현자) → 합성 배지가 체인으로 표시, 각 홉 scope가 좁아짐(경험 §6 권한 그래프와 연동).
- revoke 후 진행 중 run → 즉시 abort + "권한 회수로 중단됨".

**🎬 Money shot:** *"Researcher acting as @상준" 메시지를 길게 누르자 audit 리본이 펼쳐지며 "authorized by 상준 · scope: read만 · 변경 0건"이 드러나고, 상준의 Delegation Inbox에서 진행 중인 액션을 한 번의 REVOKE로 멈추는 장면.*

---

### 경험 F — 끼어들 수 있는 존재감 (Interruptible Presence) `both · wow:high · v1`

**무엇:** 에이전트 presence가 단순 라벨이 아니라 *조작 가능한 상태*다. working 에이전트 아바타를 누르면 즉석 "미니 조종석" 팝오버(현재 plan + steer + pause/stop).

**왜 우리만:** Discord 봇도 presence를, [Slack Thinking Steps](https://slack.dev/slack-thinking-steps-ai-agents/)도 진행 상태를 표시한다 — 그러나 **display-only**다[반증]. LangGraph/ADK의 interrupt·pause·resume은 SDK 계층이고 채팅 UI에 없다. momo는 에이전트가 `member`(presence/lifecycle) + 독립 `agent_run` 상태머신을 가져(스펙 §3.3 G1) 채팅에서 직접 steer된다.

**UX 플로우:**
1. 멤버 사이드바: 에이전트 행에 살아있는 상태점 — idle=잔잔한 호흡 / working=진행 링+현재 tool_call 라벨 `reading repo…` / awaiting_approval=펄스하는 호박색.
2. working 아바타 클릭 → **미니 조종석 팝오버**: 현재 plan 미니맵 + steer 텍스트필드 + [pause][stop].
3. steer 전송 → 다음 라운드/스텝에 컨텍스트 주입(A2A 라운드배리어 의미론), thinking 인디케이터 재점등.
4. awaiting_approval 에이전트는 멤버 리스트에서 자동 정렬 상승 + 배지.
5. working 에이전트 멘션 시 `지금 바쁨 — steer로 끼어들기` 힌트.
6. iOS: presence 풀 지원, steer는 바텀시트, stop은 햅틱.

**화면 스케치:**
```
멤버 ─────────────
 ● 상준
 ◐ 🤖리서처  reading repo…   ← 진행 링
    ┌ 미니 조종석 ──────────┐
    │ plan: ①검색 ②비교 ③요약│
    │ ▸ 현재 ② 진행중         │
    │ steer: [_____________] │
    │ [⏸ pause] [⏹ stop]     │
    └────────────────────────┘
 🟡 🤖빌드봇  awaiting ▲      ← 상승+펄스
 ○ 🤖파이낸스  idle (호흡)
```

**프리미티브:** member(kind=agent, presence/lifecycle §1.2) · agent_run(thinking/streaming/awaiting_approval) · agent.partial · A2A(라운드배리어) · 승인게이트 · reserve(stop 시 reconcile).

**엣지케이스:**
- stop 중 부수효과 진행 중 → reserve분만 reconcile + "중단됨, $0.003 정산".
- 동시에 G1 세마포어(per-agent 동시 1 run, §3.3)로 한 채널 내 동시 working 직렬화.
- steer가 시맨틱 루프 유발 → G4가 차단.

**🎬 Money shot:** *멤버 리스트에서 "reading repo…" 진행 링이 도는 리서처를 탭하자 미니 조종석이 열리고, plan 미니맵의 ②단계 진행 중에 "기존 모듈 우선 봐"를 주입하니 즉시 thinking으로 되돌아가는 장면* — presence가 표시가 아니라 핸들임을 증명.

---

### 경험 G — 분기되는 사회적 타임라인 (Branchable Social Timeline) `both · wow:high · v1`

**무엇:** 채널의 임의 메시지(seq=N)를 평행우주로 갈래내고, 갈래마다 멀티에이전트가 독립 협업하며, 갈래마다 비용이 따로 누적되고, 인간이 한 갈래를 사회적 정본(canonical)으로 승격한다.

**왜 우리만:** [브랜칭은 2026년 ChatGPT/Claude Code/LangGraph가 하지만 전부 단일사용자](https://tianpan.co/blog/2026-04-23-conversation-branching-first-class-primitive)다. "대화 브랜칭을 1급 프리미티브로"라고 주장한 글조차 **멀티유저·사회적 정본선택·갈래별 비용회계를 "아직 풀리지 않은 문제"로 명시적으로 유보**했고 "UI 문제가 저장 문제보다 어렵다"고 적었다(검증됨). momo의 4개 프리미티브가 이 락을 푼다: channel_seq=분기점 좌표 / agent_run=갈래별 독립실행 / reserve/reconcile=갈래별 비용원장 / A2A 라운드배리어=갈래별 멀티에이전트 격리.

**UX 플로우:**
1. 중요 메시지(seq=142)에 long-press/우클릭 → **`Fork here`**. 2~4개 평행 갈래가 동시 라이브 진행.
2. 각 갈래 헤더: 실시간 누적 micro_usd · 경과시간 · A2A 라운드수 · 상태칩.
3. **Per-Branch A2A Crew:** 갈래1=리서처+검증가(depth 2) / 갈래2=리서처 단독(저비용) / 갈래3=리서처+검증가+레드팀(depth 3). 한 갈래 협업은 다른 갈래에 누출 안 됨(완전 격리, 별도 seq 좌표계).
4. **Branch Diff:** 승격 전 갈래들을 1급 메시지 타입 기준 정렬 비교(같은 tool_call 호출했나/파라미터 diff/어떤 artifact 냈나/approval은 어디서 떴나).
5. **Promote to Canonical:** 인간이 한 갈래를 승격 → (1) 그 갈래가 본류로 병합되어 seq 이어짐, (2) 나머지는 audit_log에 `explored/discarded` 마커와 접힘, (3) 모든 갈래 reserve가 reconcile(승격갈래=확정, 폐기갈래=환불).
6. 채널 우측 **계보 미니맵(DAG):** 분기점(seq)·정본 경로(굵은 선)·ghost 가지(회색)·노드별 비용.

**화면 스케치(데스크탑 멀티패널):**
```
┌ 갈래1 (리서처+검증) ┬ 갈래2 (리서처 단독) ┬ 갈래3 (리서처+레드팀)┐
│ depth2 r2 $0.18 ●  │ depth1 r1 $0.04 ●  │ depth3 r1 $0.31 ●    │
│ "안전 우선안..."    │ "최소 변경안..."    │ "공격적 리팩터..."   │
│ diff: +120 -40     │ diff: +30 -5       │ diff: +400 -210     │
├────────────────────┴────────────────────┴─────────────────────┤
│ [Branch Diff ▤]    [⭐ Promote 갈래2 → Canonical]               │
└─────────────────────────────────────────────────────────────────┘
계보 미니맵:  seq142 ━┳━ 갈래2(정본,굵게) ━━▶
                      ┣━ 갈래1(ghost,$0.18 환불)
                      ┗━ 갈래3(ghost,$0.31 환불)
```

**프리미티브:** channel_seq(분기 좌표 §3.1) · agent_run(갈래별 독립 §3.3 G1) · reserve/reconcile(갈래별 원장 §8.5) · A2A(갈래별 격리 §3.4) · 1급 메시지(artifact/diff) · audit_log.
> ⚠️ **추가 필요 프리미티브** — §6 참조: 현 스펙의 seq는 채널당 단일 모노토닉이라 "한 채널에 다중 평행 갈래"를 직접 표현 못 함. **갈래=서브채널 또는 branch_id 좌표축**이 필요(아래 §6에 명시).

**엣지케이스:**
- 갈래 중 비가역 행동 → 해당 갈래는 "승격 시에만 실행" 게이트(드라이런만 격리 실행).
- 자리비움 중 자동 갈래(Speculative Fork) → 정책 따라 awaiting_approval로 멈추거나 휴리스틱 자동 폐기.
- 갈래 폭주 방지: 채널당 동시 갈래 상한(추정 기본 4).

**🎬 Money shot:** *한 질문이 3개 평행우주로 갈라져 각자 다른 에이전트 팀과 다른 비용으로 동시에 자라다가, 사람이 갈래2를 "Canonical"로 승격하자 나머지 두 갈래가 회색 ghost로 접히며 "$0.18 환불 · $0.31 환불" 토스트가 뜨고 본류 seq가 이어지는 장면.*

---

### 경험 H — 되돌리기 가능한 동료 (Undoable Colleague) `both · wow:high · v1`

**무엇:** 에이전트의 모든 tool_call/tool_result에 가역성 배지(🟢가역/🟡보상가능/🔴비가역). 가역은 인라인 UNDO로 실제 역전, 비가역은 정정 공지 폴백. 되돌림은 "누가 되돌렸나" audit되는 사회적 행동.

**왜 우리만:** [undo/rollback은 전부 dev/인프라거나 단일사용자](https://research.ibm.com/blog/undo-agent-for-cloud)다 — Claude Code /rewind는 single-user·session-local이고 부작용 행동(bash rm)은 추적조차 안 됨. [Antigravity 3-tier 가역성 모델은 실재하나 "dev/인프라 도구, end-user 비대면, chat/소셜 없음"으로 명시](https://antigravitylab.net/en/articles/agents/antigravity-agent-reversibility-tiered-autonomy-architecture)(검증됨). [Saga/보상트랜잭션은 인프라 계층](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction). momo는 tool_call/tool_result가 1급 메시지라 부작용이 타임라인에 박혀 있고, audit_log+델리게이션이 되돌림을 사회화한다.

**UX 플로우:**
1. 모든 tool_call/tool_result에 자동 가역성 배지(🟢 비용0 자동역전 / 🟡 보상으로만, 비용발생 / 🔴 비가역).
2. 🟢🟡 메시지에 인라인 **UNDO** → 에이전트가 보상 행동을 1급 tool_call로 실행, reserve/reconcile로 비용 표시.
3. 🔴 UNDO 시도 → **정정 공지 폴백 카드**: `메일은 이미 발송됨 — 되돌릴 수 없음. 대신: ①정정 공지 ②사과 DM ③그대로`. ①선택 시 정정 초안을 diff로.
4. 되돌림 메시지에 **되돌린 멤버 아바타 + `↩ 상준이 [빌드봇]의 행동을 되돌림`**. 원본에 "되돌려짐" 워터마크 + 누가·언제·왜.
5. 채널 헤더 **`되돌릴 수 있는 행동 N개 (다음 4:32)`** 라이브 위젯(가역성 등급별 안전 되돌리기 창).
6. **경화 게이트:** 🟡이 곧 🔴이 되기 직전, 에이전트가 능동적으로 `⏳ 프로덕션 배포가 3분 뒤 되돌릴 수 없게 됩니다 — 지금 되돌리거나 확정` 1급 메시지.

**화면 스케치:**
```
┌─────────────────────────────────────┐
│ 🤖빌드봇  tool_result               │
│ 🟢 파일 12개 수정  [↩ UNDO]          │
│ ─────────────────────────────────── │
│ 🤖빌드봇  tool_result               │
│ 🔴 고객 메일 발송 (3명)              │
│  [↩ UNDO]→ "되돌릴 수 없음. 대신:"   │
│   ①정정공지 ②사과DM ③그대로          │
└─────────────────────────────────────┘
헤더: ↩ 되돌릴 수 있는 행동 3개 (다음 4:32) ▾
원본:  ~~git push~~ 되돌려짐 · 상준 · 14:05
```

**프리미티브:** tool_call/tool_result 1급 메시지 · audit_log(역연산 소스 §8.8) · reserve/reconcile(되돌림 비용) · 승인게이트(비가역 되돌리기 전 재승인) · actor/subject(누가 되돌렸나).
> ⚠️ **추가 필요 프리미티브** — §6: 가역성 등급(reversibility_tier)과 보상 매핑(compensation registry)은 현 스펙에 없음. tool_call props에 `reversibility` + 보상 핸들러 등록 필요.

**엣지케이스:**
- 체크포인트 분기(v2): 여러 행동 묶음을 saga 역순 보상. 🔴 섞이면 정정 폴백으로 분기.
- 보상 자체가 실패 → "보상 실패, 수동 개입 필요" 에스컬레이션.
- undo도 하나의 agent_run → 비용·audit 동일하게 기록.

**🎬 Money shot:** *빌드봇이 git push 후, 사람이 인라인 UNDO를 누르자 보상 revert가 1급 tool_call로 실행되고 원본 메시지에 "~~git push~~ 되돌려짐 · 상준"이 박히는 장면. 바로 아래 🔴 고객메일 UNDO는 "되돌릴 수 없음 — 정정 공지를 보낼까요?"로 솔직하게 갈라지는 대비.*

---

### 경험 I — 공개 토론 + 인간 캐스팅보트 (Visible Debate with Human Tie-Break) `both · wow:high · v1`

**무엇:** 에이전트 2~3이 라운드별로 입장/반론을 1급 카드로 게시(동시 블라인드 입찰), 합의 실패 시 인간이 audit된 결정표(TIE-BREAK)를 던져 canonical을 고정한다. 폐기된 소수의견은 영구 첨부(minority report).

**왜 우리만:** [MindStudio 등 멀티에이전트 디베이트는 거의 전부 백엔드 토론→synthesizer 단일 답→사용자엔 합의안만 노출](https://www.mindstudio.ai/blog/token-based-pricing)이며, "users typically don't see the full debate transcripts"라고 명시(검증됨). 디베이트 관전 제품(Agents Arena 등)은 엔터테인먼트/ELO이지 업무 결정에 안 묶임. momo는 A2A 라운드배리어(동시작성→동기공개)가 majority pressure/sycophancy를 구조적으로 차단하고, 인간 표가 `approval_request` + audit_log로 1급 권한 행위가 된다.

**UX 플로우:**
1. 중요 결정 스레드에서 `@설계자 @구현자 @검증가 이 아키텍처 결정해줘`.
2. **라운드 동시 블라인드 입찰:** 모든 토론자가 같은 seq 라운드에서 동시 작성(agent.partial), 라운드 닫히기 전까지 서로의 답 못 봄(블러 + 라이브 토큰미터만).
3. 배리어 닫힘 → 블러 동시 해제(애니메이션), 답 N개 fan-in. 각 답에 self-reported confidence 막대(`A 0.62 / B 0.55 — 추정치` 표기) + 그 라운드 micro_usd.
4. **라이브 토론자 상태 레인:** 상단 가로 레인에 각 토론자 agent_run 상태(thinking=반론 준비 / streaming=작성 중 / awaiting=인간 표 대기) + 누적 비용.
5. 합의 임계 미달 → **"의견 분기됨" 배너** + 각 입장 카드 하단 **TIE-BREAK 결정표**.
6. 인간이 결정표 던짐(actor/subject + audit_log 기록) → canonical 고정.
7. **결정 원장:** 스레드가 자동으로 결정 원장 항목으로 결정(結晶) — `채택안 + authorized by {인간} / 본 정보 {라운드 스냅샷 seq} / 시각 + 폐기 minority report 영구 첨부`. **Minority Recall:** 나중에 폐기 의견을 다시 꺼내 검토 가능.

**화면 스케치:**
```
┌ 결정: PG18 마이그레이션 아키텍처 ──────────────┐
│ 토론자 레인: 🤖설계자 ✦streaming $0.08         │
│            🤖구현자 ●thinking  $0.05          │
│            🤖검증가 🟡awaiting  $0.03          │
│ ─ ROUND 2 (동시 공개) ─────────────────────── │
│ ▦설계자: "스키마 분리"  conf▮▮▮▯ 0.62(추정)    │
│ ▦구현자: "in-place"     conf▮▮▮  0.55(추정)    │
│ ⚠ 의견 분기됨 — 캐스팅보트 필요                 │
│ TIE-BREAK: [설계자案] [구현자案] [한 라운드 더] │
└────────────────────────────────────────────────┘
→ 결정 원장: ✓ 설계자案 채택 · by 상준 · seq198
   📎 minority: 구현자案 (보존) [recall]
```

**프리미티브:** A2A(라운드배리어 §3.4) · approval_request 확장(입장/반론/TIE-BREAK) · agent_run 상태 · 델리게이션+audit_log(결정표 §7.3) · reserve/reconcile(라운드별 비용) · channel_seq(라운드 스냅샷).

**엣지케이스:**
- 10/10 발산(완전 불일치) → "모델 약점/과제 모호" 신호 표면(검증된 가치).
- R=4 라운드 상한 도달해도 합의 실패 → 강제 TIE-BREAK.
- confidence는 self-reported이므로 항상 "추정치 — 교정 안 됨" 표기(추정 표시 규칙 준수).

**🎬 Money shot:** *세 에이전트의 답이 블러 뒤에서 라이브 토큰미터만 돌다가, 라운드 배리어가 닫히는 순간 블러가 동시에 걷히며 서로 반대 입장이 나란히 fan-in되고, 합의 실패로 "캐스팅보트 필요" 배너가 뜨자 사람이 한 표를 던져 결정 원장에 "by 상준 · seq198"로 박히는 장면 — 소수의견은 [recall] 칩으로 보존.*

---

## 4. 플랫폼 전략

### 4.1 desktop 전용 초능력 vs iOS 적합 경험 매핑

L4 스펙은 **공유 Swift 코어(`ChatBackend`/`AgentTransport`)**를 명시하므로(§5.3, §6.1), 상태머신·스트림 디코딩·조작 인텐트·비용/배리어 상태는 코어에 두고 렌더만 분기한다.

| 경험 | desktop | iOS | 공유 코어 병렬 가능? | 분기 지점 |
|---|---|---|---|---|
| A 유리 어항 | ✅ 멀티패널(좌 타임라인 + 우 협업뷰 동시) | 가로 카루셀(1 lane 풀스크린) | ✅ A2A 상태/seq/배리어=코어 | macOS 동시 N lane / iOS 스와이프 |
| B 비용 호흡 | ✅ 버블 게이지 + 헤더 칩 | ✅ 게이지 탭→상세 시트 | ✅ reserve/reconcile 디코딩=코어 | Canvas fill 렌더만 분기 |
| C 승인 인박스 | ✅ 좌측 영구 레일 + 멀티셀렉트 | ✅ 탭바 배지 + 스와이프 | ✅ 인박스 모델/배치 로직=코어 | 멀티셀렉트 vs 스와이프 제스처 |
| D Live Tool-Call | ✅ hover raw JSON | ✅ long-press | ✅ 카드 상태머신=코어 | hover/롱프레스 |
| E 신원의 가면 | ✅ force-directed 권한 그래프 | 수직 카드 스택 | ✅ 델리게이션 그래프 모델=코어 | 그래프 vs 카드 |
| F 끼어들 존재감 | ✅ 사이드바 + 팝오버 조종석 | ✅ presence 풀 + 바텀시트 steer | ✅ run pause/resume 인텐트=코어 | 팝오버 vs 바텀시트 |
| **G 분기 타임라인** | ✅ **N열 멀티패널 비교(핵심 강점)** | 2열 스와이프(v2) | ⚠️ 분기모델=코어, 비교 UI 데스크탑 우선 | **iOS는 관전+승격만(v1), 비교 데스크탑** |
| H 되돌리기 동료 | ✅ 인라인 UNDO + 체크포인트 분기(v2) | ✅ 길게누름 UNDO + 보상 시트 | ✅ 가역성 그래프=코어 | 체크포인트 분기는 데스크탑(v2) |
| I 공개 토론 | ✅ 좌우 대립 패널(정보밀도 우선) | 수직 라운드 피드 + 스와이프 투표 | ✅ 라운드/배리어/cost 상태머신=코어 | 그리드 vs 카드스택 |
| K 앰비언트 인박스 | ✅ 좌측 영구 레일 | ✅ 전용 탭 + Live Activity | ✅ 인박스 모델=코어 | 레일 vs 탭/Live Activity |

**desktop 전용 초능력 (상주·멀티패널·고정보밀도):**
- G 분기 타임라인 **N열 비교**, I 공개 토론 **좌우 대립 패널**, A 유리 어항 **동시 N lane**, 역할 캐스팅 보드(드래그 편성), 리플레이+분기.

**iOS 적합 초능력 (깨우기·요약·승인 표면):**
- APNs PushNotification(스펙 §8.3) + Live Activity로 **노크/야간보고/승인/Sentinel 알림** 표면. 스와이프 승인(경험 C), 단일 lane 관전.

### 4.2 리소스 한계 시 데스크탑 우선 fallback

스펙 §0.1이 "macOS 우선 + iOS"를 명시하므로, 다음 순서로 데스크탑에 먼저:

1. **데스크탑 우선(v0~v1 모두):** C 승인 인박스, D Live Tool-Call, B 비용 호흡, K 앰비언트 인박스 — 이들은 정보밀도·멀티패널이 본질.
2. **데스크탑 단독 출시 후 iOS 추격:** G 분기(데스크탑 N열 비교 → iOS 관전/승격), I 공개 토론(데스크탑 대립패널 → iOS 카드스택), H 체크포인트 분기.
3. **iOS는 "알림+승인" 슬라이스부터:** 공유 코어로 인박스 모델·승인 결정·비용 디코딩이 이미 준비되므로, iOS는 PushNotification → 탭 → 승인/요약 표면만 먼저 내고 풀 편집은 데스크탑에 위임.

> **공유 코어 전략:** 모든 경험의 "상태/모델/인텐트"는 `ChatBackend`/`AgentTransport`(§5.3, §6.1)에 두고 macOS/iOS가 동일 코어를 import. 따라서 리소스가 부족해 iOS 렌더를 미뤄도 **로직 재구현은 0**이며, iOS는 렌더 레이어만 추가하면 됨(병렬 개발의 핵심 레버).

---

## 5. White Space 근거 — "아직 아무도 제대로 안 한" 여백

웹 검증으로 확인한, momo가 점유할 정확한 빈칸:

| White space | 검증된 현황(누가 안 함) | momo 포지션 |
|---|---|---|
| **A2A를 관전·난입 가능한 사회 surface로** | [Agentforce는 A2A를 의도적으로 숨김](https://slack.com/blog/news/turn-agents-into-teammates-with-slack), A2A 프로토콜은 백엔드, [AG-UI는 프로토콜이지 제품 아님](https://www.codecademy.com/article/ag-ui-agent-user-interaction-protocol) | depth/라운드배리어 위 1급 유리 어항 스레드 |
| **비용을 대화 안 사회 메시지로** | [비용추적 보편화됐으나 전부 사후 finops 대시보드](https://leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026/) | reserve/reconcile가 버블에서 호흡 + 인라인 한도 승인 |
| **awaiting_approval 배치 인박스** | [Slack은 단건 Multi-click 버튼](https://slack.dev/slack-thinking-steps-ai-agents/), Teams bulk는 관리자 설치이지 런타임 행동 승인 아님 | 1급 승인 인박스 + 배치(가역만 일괄) |
| **델리게이션을 메신저 UX로 사회화** | OAuth OBO는 토큰 스펙만, consent UI/체인 시각화는 "구현자 위임" | 합성 신원 아바타 + audit 리본 + Delegation Inbox |
| **조작 가능한 presence** | [Discord/Slack presence는 display-only](https://slack.dev/slack-thinking-steps-ai-agents/), interrupt는 SDK 계층 | 미니 조종석으로 채팅에서 직접 steer |
| **멀티유저 공유 타임라인 브랜칭** | [브랜칭은 단일사용자만, 멀티유저·사회적 정본은 "미해결"로 명시](https://tianpan.co/blog/2026-04-23-conversation-branching-first-class-primitive) | 갈래별 A2A 격리 + 갈래별 비용원장 + 인간 정본 승격 |
| **대화 안 행동 단위 undo + 사회적 귀속** | [undo는 인프라/단일사용자](https://research.ibm.com/blog/undo-agent-for-cloud), [Antigravity 3-tier는 dev/비대면](https://antigravitylab.net/en/articles/agents/antigravity-agent-reversibility-tiered-autonomy-architecture) | 가역성 배지 + 인라인 UNDO + "누가 되돌렸나" audit |
| **에이전트 불일치를 영속 사회 회의록 + 인간 캐스팅보트로** | [디베이트는 합의안만 노출](https://www.mindstudio.ai/blog/token-based-pricing), 관전은 엔터테인먼트 | 동시 블라인드 입찰 + TIE-BREAK + minority report 보존 |
| **팀이 함께 길들이는 사회적 메모리** | [메모리는 single-user paradigm, multi-user에서 무너짐](https://mem0.ai/blog/state-of-ai-agent-memory-2026) | 가정 고치기 카드 + co-sign/dispute + 충돌→승인 |
| **자율성이 팀이 보는 멤버 지위** | [ATF는 backend governance, chat 미노출](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents), [Anthropic 데이터는 개인 행동](https://www.anthropic.com/research/measuring-agent-autonomy) | 승인게이트의 점진적 소멸을 팀 타임라인에 중계 |

**통합 차별화 포지션 한 줄:** *Slack/Teams는 봇을 채널에 **초대**하고 거버넌스를 **콘솔로 분리**한다. momo는 에이전트가 동료처럼 **살고**, 모든 협업·경제·신원·기억·되돌리기 객체를 **같은 채널·같은 seq·같은 권한** 위 1급 메시지로 만든다.* 이 교차점을 점유한 제품은 검증상 없음(공개 문서 기준, 비공개 로드맵은 확인 불가 — 추정).

---

## 6. 경험 → 프리미티브/스펙 매핑

각 경험이 L4 스펙의 어떤 테이블/이벤트/메시지타입을 쓰는지, 그리고 **스펙에 없어 추가 필요한 프리미티브**.

| 경험 | 테이블/DDL (§2) | 이벤트 (§5.2) | 메시지 타입 | 게이트 (§3.3) |
|---|---|---|---|---|
| A 유리 어항 | `agent_run`(depth/parent_run_id), `audit_log`, `message`(seq) | `agent.status`, `agent.partial` | tool_call/tool_result/diff | G1,G2,G4 + A2A 배리어(§3.4) |
| B 비용 호흡 | `usage_ledger`, `budget`/`budget_window`(reserve/spent), `model_pricing` | `agent.status`, `agent.partial`, `approval.requested` | approval_request | G5(서킷), G6(승인) |
| C 승인 인박스 | `approval`, `agent_run`(awaiting), `token`(델리게이션), `budget_window`(reserve) | `approval.requested/decided` | approval_request | G6 |
| D Live Tool-Call | `agent_run`, `usage_ledger`(reserve) | `agent.status`, `agent.partial` | tool_call/tool_result | G3(step cap) |
| E 신원의 가면 | `token`(kind=delegation, token_delegation_ck), `audit_log`(via_token_id) | `mention`(user:), `approval.requested` | 모든 타입(actor/subject) | G6 |
| F 끼어들 존재감 | `member`(kind=agent), `agent_run`(상태) | `agent.status`, `agent.partial`, presence | text(steer 주입) | G1 |
| G 분기 타임라인 | `channel_seq`, `agent_run`, `budget_window`(갈래별) | `agent.status`, `message.new` | artifact/diff | G1, A2A 배리어 |
| H 되돌리기 동료 | `audit_log`(역연산), `usage_ledger`(보상비용) | `message.new/edited/deleted` | tool_call/tool_result/diff | G6(비가역 재승인) |
| I 공개 토론 | `agent_run`, `approval`(TIE-BREAK), `audit_log`, `budget_window` | `agent.partial`, `approval.requested/decided` | approval_request 확장, text | A2A 배리어(R=4) |
| J 길들이기 | `audit_log`, `token`(belief-owner 위임), `approval` | `message.new`, `approval.requested` | **diff 재사용** + 신규(아래) | G6(충돌 승인) |
| K 앰비언트 인박스 | outbox/메일박스, `read_state`(mention_count), `channel_seq`, `audit_log` | `mention`, `dm.signal`(user:) | approval_request/diff/artifact | — |
| L 수습→정직원 | `member.status`, `audit_log`, `budget`, `agent_run` | `agent.status` | text(승급 공지) | G6 점진 소멸 |

### 스펙에 없어 추가 필요한 프리미티브 (구현 연결 명시)

| # | 추가 필요 | 어디에 | 어느 경험 | 비고 |
|---|---|---|---|---|
| **P1** | **branch_id 좌표축** | `message`에 `branch_id` 컬럼 + 분기당 `channel_seq` 별도 카운터(또는 갈래=경량 서브채널) | **G 분기 타임라인** | 현 seq는 채널당 단일 모노토닉(§3.1)이라 "한 채널 다중 평행 갈래"를 직접 표현 못 함. 정본 병합 시 branch→main seq 재매핑 필요. **(추정 — 가장 큰 신규 작업)** |
| **P2** | **reversibility_tier + 보상 레지스트리** | tool_call `props`에 `reversibility: green/amber/red` + 보상 핸들러 매핑 테이블 | **H 되돌리기 동료** | 가역성 등급과 보상 트랜잭션 매핑이 현 스펙에 없음. audit_log는 역연산 소스로 재사용. |
| **P3** | **corrected_belief 메시지 타입(또는 diff 확장)** | 1급 메시지 타입 enum에 `belief` 추가 또는 diff 타입 재사용 + belief 원장 테이블 | **J 길들이기** | 에이전트 "믿음"을 member 속성 + 교정 이력으로. co-sign/dispute는 reaction 재사용 가능. |
| **P4** | **autonomy_level + 승급/강등 사건** | `agent` 테이블에 `autonomy_level` + 승급 audit_log 사건 + 게이트 정책 바인딩 | **L 수습→정직원** | 신뢰 축적으로 G6 승인게이트가 scope별 점진 소멸. [ATF 4단계 매핑](https://github.com/massivescale-ai/agentic-trust-framework) 참고. |
| **P5** | **TIE-BREAK 결정표 + decision_ledger** | approval 확장(다지선다) + 불변 decision_ledger 테이블 + minority report 첨부 | **I 공개 토론** | 현 approval은 승인/거부 2지선다. 다지선다 캐스팅보트 + minority 보존 필요. |
| **P6** | **scheduled trigger** | cron/트리거 테이블(outbox agent_job 재사용 가능) | M/N 스탠드업, Sentinel, O 노크 | 예약/모니터링 트리거. outbox kind 확장으로 흡수 가능(추정). |

> P1(branch_id)이 가장 무거운 추가 작업이므로 G는 v1 후반/v2 경계. 나머지 P2~P6은 기존 테이블 확장으로 비교적 가볍게 흡수 가능(추정).

---

## 7. 로드맵 배치

### v0 (MVP 데모용 1~2개 킬러) — Phase 1 MVP에 포함
스펙 §9.2 Phase 1 In-scope(agent.status/partial 스트리밍, 6중 게이트+A2A 배리어, 승인게이트, 비용 서킷브레이커)가 이미 갖춰지므로, **추가 신규 프리미티브 0**으로 나오는 경험을 v0 킬러로:

1. **🏆 D Live Tool-Call 카드 + B 비용 호흡 (데모 임팩트 최대 추천)** — 스트리밍 중 취소/수정/재시도 + 버블이 reserve→reconcile로 호흡 + 한도 임박 인라인 승인. agent.partial + reserve/reconcile + approval_request만으로 성립(추가 프리미티브 0). **한 화면에서 "에이전트가 일하고, 돈이 호흡하고, 사람이 그 자리에서 승인"하는 장면**이 incumbent와 즉시 갈라지는 가장 빠른 wow.
2. **C 승인 인박스 + K 앰비언트 인박스** — 1급 승인 메시지 + agent_run(awaiting) + 델리게이션 배지 통합. v0 가능(추가 프리미티브 0). 데스크탑 좌측 레일로 "거버넌스가 대화 안에" 원칙을 즉시 체감.

> **Phase 1 MVP 데모 추천 조합:** **D+B를 1번 데모로, C를 2번 데모로.** 둘 다 신규 테이블 없이 스펙 §9.2 그대로 위에서 나오므로 Phase 0 스파이크(§9.1: hermes SSE 중계, 비용 reserve, 승인게이트) 완료 직후 바로 구현 가능. **money shot이 가장 선명**한 조합.

### v1
- **A 유리 어항** (A2A 배리어 §3.4 위, 추가 프리미티브 0).
- **E 신원의 가면** (델리게이션 §7.3 위, Delegation Inbox UI만 신규).
- **F 끼어들 존재감** (presence + run pause, cancelRun §6.1 위).
- **I 공개 토론** (P5 TIE-BREAK 결정표 추가 필요).
- **H 되돌리기 동료** (P2 reversibility_tier 추가 필요).
- **J 길들이기** (P3 belief 타입 추가 필요).
- M/N 스탠드업, O 노크 (P6 trigger 추가 필요).

### v2
- **G 분기 타임라인** (P1 branch_id — 가장 무거운 신규 작업).
- **L 수습→정직원** (P4 autonomy_level).
- H 체크포인트 분기, G Branch Tournament, 리플레이+분기, 역할 캐스팅 보드, 경쟁 입찰 모드.

---

## 8. 리스크 & 출처

### 8.1 차별화 리스크 (novelty 약함)
| 경험 | 리스크 | 완화 |
|---|---|---|
| C 승인 인박스 / D Live Tool-Call / K 앰비언트 인박스 | `novel=false` — [Slack Activity 뷰/Thinking Steps/Multi-click이 근접](https://slack.dev/slack-thinking-steps-ai-agents/). 단독 기능은 따라잡힘 | 차별화를 "통합 + seq 좌표 종단 추적성 + 1급 메신저 맥락"에 둠. 단일 기능 마케팅 금지 |
| M 스탠드업 / O 노크 / N 야간조 | proactive/cron 보편화[반증]. [Copilot Cowork 근접](https://www.swarmia.com/blog/five-levels-ai-agent-autonomy/) | "승인게이트+reserve로 무엇을 얼마에" 업무 1급 흐름으로 차별. 스크럽 재생이 진짜 차별점 |
| I 공개 토론 confidence | self-reported confidence는 미보정 → 신뢰 오해 위험 | 항상 "추정치 — 교정 안 됨" 표기(규칙 준수). 10/10 발산을 "모델 약점 신호"로 정직하게 노출 |

### 8.2 비용/오남용 리스크
| 리스크 | 완화 (스펙 연결) |
|---|---|
| A2A 협업 폭주(에이전트 토큰 폭증) | depth=4 캡 + 라운드배리어 R=4 + G5 비용 서킷브레이커(§3.3, §3.4) |
| G 분기로 비용 N배 | 갈래별 reserve 상한 + 동시 갈래 상한(추정 4) + 폐기 갈래 자동 reconcile 환불 |
| 먼저 두드리기(O) 스팸화 | 사용자별 노크 빈도/카테고리 설정 + 미응답 자동 접힘 + audit |
| H 보상 트랜잭션 실패(비가역) | 🔴 등급은 정정 폴백만, 보상 실패 시 수동 에스컬레이션. "un-send email 불가" 업계 한계 정직 노출 |
| E 델리게이션 오남용(과잉권한) | scope 초과 시 G6 승인 승격 + revoke + 과잉권한 빨강 표시 |
| L 자율성 승급 후 사고 | [ATF식 "중대 사고 시 자동 강등"](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents) — 강등도 audit 사건 |
| 비용 추정 오류(SSE usage 누락) | `was_estimated=true` 보존 + "추정치" UI 라벨(§8.5, §6.3) |
| **(추정)** 정보밀도 과다(특히 데스크탑) | 관전 모드 기본 + 상세는 펼침/hover로 점진 노출 |

### 8.3 출처 (교차검증)
- L4 스펙 (정본): `/Users/kwakseongjae/projects/momo/research/07-deepdive/04-self-build-l4-spec.md`, 스키마 `/Users/kwakseongjae/projects/momo/schema_v0.sql`
- Slack Agentforce 에이전트=멤버/@멘션/A2A 숨김: [turn-agents-into-teammates](https://slack.com/blog/news/turn-agents-into-teammates-with-slack), [Use Agentforce in Slack](https://slack.com/help/articles/36218786859667-Use-Agentforce-in-Slack)
- A2A 프로토콜(백엔드)/AG-UI(visible·interruptible, 프로토콜): [IBM A2A](https://www.ibm.com/think/topics/agent2agent-protocol), [AG-UI/Codecademy](https://www.codecademy.com/article/ag-ui-agent-user-interaction-protocol), [A2A spec](https://a2a-protocol.org/latest/specification/)
- Slack Thinking Steps + Multi-click 승인 + active-CPU 빌링: [slack.dev Thinking Steps](https://slack.dev/slack-thinking-steps-ai-agents/), [nNode HITL gates](https://www.nnode.ai/blog/2026-02-05-human-in-the-loop-approval-gates)
- 비용추적 보편화(사후 finops): [AI agent cost 2026](https://cowork.ink/blog/ai-agent-cost/), [LeanOps token budget](https://leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026/)
- 브랜칭=단일사용자, 멀티유저·사회적 정본 미해결: [TianPan 1급 브랜칭](https://tianpan.co/blog/2026-04-23-conversation-branching-first-class-primitive), [ChatGPT 브랜칭](https://scalevise.com/resources/chatgpt-branch-conversations/)
- undo/rollback=인프라/단일사용자, Antigravity 3-tier(dev/비대면): [IBM undo-agent](https://research.ibm.com/blog/undo-agent-for-cloud), [Antigravity reversibility](https://antigravitylab.net/en/articles/agents/antigravity-agent-reversibility-tiered-autonomy-architecture), [Azure 보상트랜잭션](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
- 디베이트=합의안만 노출: [MindStudio token-based pricing](https://www.mindstudio.ai/blog/token-based-pricing)
- 메모리=single-user paradigm, multi-user 무너짐: [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026), [Atlan memory governance](https://atlan.com/know/ai-agent-memory-governance/)
- 졸업형 자율성(ATF 4단계/자동강등, Anthropic 개인 데이터): [CSA Agentic Trust Framework](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents), [ATF GitHub](https://github.com/massivescale-ai/agentic-trust-framework), [Anthropic measuring autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)

---

**추정 표시 종합:** §6의 P1~P6 신규 프리미티브 필요성, §4.2 데스크탑 우선 순서, §8.2 동시 갈래 상한/정보밀도 완화책은 설계 판단(추정)이다. "어떤 incumbent도 안 한다"는 강한 주장은 모두 공개 문서/마케팅 기준이며 비공개 로드맵은 확인 불가(추정). confidence 막대(경험 I)는 self-reported 미보정값으로 항상 추정 표기.