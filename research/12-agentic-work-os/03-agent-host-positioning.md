# Agent Host Positioning

> MOMO-184. 작성일: 2026-06-29.
> 목적: oort를 Slack/Discord/Mattermost/Paca/OpenHands와 비교할 때 반복해서 쓸 수 있는 제품 문장과 copy block을 고정한다.

## Product Sentence

**oort is a self-hosted agent host where the channel timeline becomes the execution ledger.**

oort는 사람, AI 에이전트, 플러그인이 같은 채널에서 일하고, 모든 context packet, tool call, approval, result, cost, audit record가 한 타임라인에 남는 self-hosted 업무 메신저 OS다.

짧게 말하면:

> Slack은 대화를 남긴다. Paca는 작업판을 남긴다. OpenHands는 코딩 에이전트 실행을 남긴다. oort는 팀 채널 자체를 사람이 승인하고 에이전트가 실행한 업무의 ledger로 만든다.

## One-Page Positioning

oort는 "또 하나의 Slack"이 아니다. 성숙한 채팅 UX, 커뮤니티 distribution, 범용 앱 생태계는 Slack/Discord/Mattermost가 이미 강하다. oort가 차별화되는 지점은 채널 타임라인을 단순 conversation log가 아니라 **agent execution ledger**로 취급하는 것이다.

Slack/Discord/Mattermost에서 에이전트는 보통 봇, 앱, slash command, webhook으로 붙는다. 실행은 외부 서비스나 별도 dashboard에 흩어지고, 누가 어떤 context를 넘겼는지, 어떤 tool을 호출했는지, 어떤 승인을 받았는지, 비용과 audit trail이 어디에 남았는지 추적하기 어렵다. oort에서는 에이전트가 `member.kind = 'agent'`인 1급 멤버이며, 실행 과정은 `context_packet -> tool_call -> approval_request -> tool_result -> usage_ledger -> audit_log`로 채널 안에 드러난다.

Paca/Jira/Linear류는 task, sprint, board, issue가 중심 객체다. 이들은 작업을 계획하고 추적하는 데 강하다. oort는 board를 복제하지 않는다. oort의 중심 객체는 **channel timeline**이다. task가 생기기 전의 대화, task를 실행하는 동안의 context/approval/cost, 실행 후의 결과와 감사 기록을 한 흐름에 남긴다. 따라서 Paca/Linear/GitHub/Google Workspace는 source-of-work가 되고, oort는 그 작업을 승인하고 실행하고 검증하는 communication ledger가 된다.

OpenHands/Copilot류는 coding agent control plane에 강하다. oort는 코딩 작업만이 아니라 일반 팀 업무, 문서, 고객 응대, 운영 runbook, Google Workspace, internal tools를 같은 protocol surface로 다룬다. agent runtime은 hermes, OpenAI-compatible worker, local model, remote sandbox로 바뀔 수 있지만, workspace policy와 ledger는 oort가 소유한다.

엔터프라이즈 관점에서 메시지는 명확하다. oort는 self-hosted trust boundary 안에서 context, memory, capability, approval, cost policy를 관리한다. 외부 LLM이나 plugin이 업무 context를 가져가더라도 raw chat exhaust가 아니라 권한이 붙은 Context Packet으로 전달되고, plugin write는 approval과 audit 뒤에 놓인다. 앞으로 local LLM은 summarization, redaction, context compaction, routing처럼 privacy-sensitive한 전처리를 담당하고, server agents는 긴 추론과 외부 tool execution을 맡는다.

## Comparison

| Product | Primary object | Agent model | oort difference |
|---|---|---|---|
| Slack | Channel conversation | App/bot/Workflow | Timeline-native execution ledger with visible approvals, cost, and audit. |
| Discord | Community/chat server | Bot/integration | Enterprise workspace policy, RLS-backed tenancy, governed agent execution. |
| Mattermost | Self-hosted messaging | Plugin/bot | Agent-first member model plus protocolized context/tool/approval/result records. |
| Paca | Task/board/agentic work item | Agent in project workflow | Channel timeline before/during/after work, connected to external task systems instead of replacing them. |
| OpenHands | Coding agent session/control center | Coding agent backend | Non-code enterprise work surface where executions are approved and audited in team channels. |

## Reusable Copy Blocks

### Website Hero

**oort turns team channels into agent execution ledgers.**

Self-host a workspace where humans, AI agents, and plugins work in the same timeline. Every context packet, tool call, approval, result, cost, and audit record stays visible, permissioned, and owned by your team.

### README Short Block

oort is a self-hosted Slack-like workspace for agentic work. The key difference is that the channel timeline is the execution ledger: agents are first-class members, tool calls and approvals are visible messages, costs are accountable, and workspace context stays governed by oort instead of disappearing into an external bot runtime.

### Sales Deck Slide

**Positioning:** self-hosted agent host for enterprise teams.

**Wedge:** channel timeline execution ledger.

**Why now:** teams are adding agents to Slack, GitHub, Google Workspace, Paca, and OpenHands, but execution context, approval, cost, memory, and audit are scattered across tools.

**oort answer:** keep the team conversation, agent protocol surface, plugin writes, local/private context work, and compliance evidence in one governed channel timeline.

### Product Boilerplate

oort is an agent-native team workspace. Humans, AI agents, and plugins share one channel timeline, and every execution step is recorded as a governed ledger entry: context, tool calls, approvals, results, costs, and audits. It is self-hosted by default, protocol-oriented by design, and ready for a future where local LLMs handle private context work before server agents perform long-running external actions.

## Messaging Rules

- Say **agent host**, not just chatbot or bot platform.
- Say **channel timeline execution ledger**, not generic AI workspace.
- Say **protocol surface** when describing Context Packet, Memory Plane, Capability Cache, MCP/A2A compatibility, and approval cards.
- Say **self-hosted trust boundary** for enterprise positioning; avoid blanket security claims.
- Say **local LLM future** as privacy-sensitive context work first: redaction, summarization, compaction, routing, source-preserving previews.
- Do not claim oort replaces Slack/Discord/Paca/OpenHands. Say oort hosts the governed execution layer that those work sources can connect to.
