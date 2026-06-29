# Agentic Work OS Market Analysis

> MOMO-180. 작성일: 2026-06-29.
> 목적: Paca/OpenHands/Linear/Rovo/GitHub Copilot/Slack/MCP/A2A 흐름을 기준으로 momo의 제품 포지션과 생태계 방향을 고정한다.

## 결론

momo는 Slack/Discord/Mattermost의 "대체 채팅앱"으로 포지셔닝하면 불리하다. 이미 성숙한 채팅 UX, 엔터프라이즈 세일즈, 앱 생태계, 모바일 polish를 정면으로 이기기 어렵다. momo의 차별점은 **채널 타임라인이 agent execution ledger가 되는 것**이다.

권장 포지션:

> momo is an enterprise agent host where humans, AI agents, and plugins work in the same channel timeline, while every context packet, tool call, approval, result, cost, and audit record remains governed by the workspace.

한국어 제품 문장:

> momo는 사람, AI 에이전트, 플러그인이 같은 채널에서 일하고, 모든 실행이 승인/비용/감사 가능한 업무 메신저 OS다.

## 시장 움직임

### Paca: task/board 중심 agentic work OS

[Paca-AI/paca](https://github.com/Paca-AI/paca)는 AI-native Jira/Trello/ClickUp/Monday 대체를 지향한다. 2026-06-29 기준 GitHub description은 사람이든 AI agent든 같은 sprint, board, goal에서 협업한다는 메시지를 전면에 둔다. 제품 중심축은 chat이 아니라 Scrum/Scrumban, task, BDD, SDD, activity diff/revert다.

핵심 아키텍처는 [architecture overview](https://github.com/Paca-AI/paca/blob/master/docs/architecture/overview.md)에 잘 드러난다.

- `apps/web`: product UI.
- `apps/mcp`: MCP server.
- `apps/e2e`: Playwright full-stack verifier.
- `services/api`: transactional SoT.
- `services/realtime`: Socket.IO delivery edge.
- `services/ai-agent`: OpenHands SDK 기반 agent orchestration.
- PostgreSQL은 product data, Valkey는 cache/coordination/event stream.

Paca가 momo에 주는 가장 큰 교훈은 기능이 아니라 **org/repo topology와 ecosystem sequencing**이다. core monorepo와 별도로 [paca-plugins](https://github.com/Paca-AI/paca-plugins), first-party plugin repos, [plugin-sdk-go](https://github.com/Paca-AI/plugin-sdk-go), [plugin-sdk-react](https://github.com/Paca-AI/plugin-sdk-react), [plugin-sdk-mcp](https://github.com/Paca-AI/plugin-sdk-mcp)을 분리해 plugin ecosystem을 제품 구조의 일부로 만든다.

### Paca plugin model: catalog + SDK + WASM + MCP

Paca의 [plugin overview](https://github.com/Paca-AI/paca/blob/master/docs/plugins/overview.md)는 plugin을 UI slot, backend route/event handler, MCP tools까지 확장하는 versioned bundle로 정의한다. Backend plugin은 [wazero WASM runtime](https://github.com/Paca-AI/paca/blob/master/docs/plugins/backend-plugin-system.md)에서 실행되고, manifest permission과 typed host function bridge로 DB/event access를 제한한다. MCP plugin은 [MCP plugin system](https://github.com/Paca-AI/paca/blob/master/docs/plugins/mcp-plugin-system.md)을 통해 Paca MCP server의 tool list에 노출된다.

momo가 가져올 원칙:

- plugin은 단순 webhook이 아니라 manifest, capability, UI surface, server action, MCP exposure, audit policy를 함께 가진다.
- first-party plugin이 SDK와 catalog의 proof-of-concept가 되어야 한다.
- plugin install은 admin action이고, plugin write는 approval/cost/audit ledger에 남아야 한다.

momo가 그대로 가져오면 안 되는 부분:

- Paca는 project/task product이므로 board/task extension point가 중심이다.
- momo의 extension point는 channel timeline, message context action, approval card, slash command, member/agent presence, context source badge여야 한다.
- Paca의 MCP plugin v1은 trusted same-process module model을 포함한다. momo는 enterprise trust를 위해 plugin-side MCP exposure도 capability cache, policy version, signed artifact, audit event를 전제로 해야 한다.

### OpenHands: agent control center and backend separation

[OpenHands](https://github.com/OpenHands/OpenHands)는 "self-hosted developer control center for coding agents and automations"로 이동하고 있다. Agent Canvas는 OpenHands, Claude Code, Codex, Gemini, ACP-compatible agent를 local/remote/cloud backend에서 실행할 수 있는 control center를 지향한다.

momo에 중요한 포인트:

- agent runtime은 제품 core와 분리되어도 된다.
- local laptop, Docker sandbox, VM, cloud backend를 모두 backend option으로 둔다.
- Slack/GitHub/Linear/Notion 같은 external trigger와 automation이 agent execution entrypoint가 된다.

momo의 차별점은 OpenHands의 agent canvas와도 다르다. OpenHands는 coding agent control plane이고, momo는 일반 업무 채널에서 agent execution을 governed message ledger로 남기는 communication host다.

### Linear, GitHub Copilot, Rovo: existing work tools become agent hosts

[Linear MCP](https://linear.app/docs/mcp)는 existing project management data를 LLM host가 다루는 tool surface로 열어준다. [GitHub Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent)는 GitHub issue/PR workflow에 coding agent를 끼워 넣는다. [Atlassian Rovo agents](https://support.atlassian.com/rovo/docs/agents/)는 Atlassian workspace 안에서 agents, tools, actions, governance를 제공한다.

방향은 같다.

- 기존 업무 데이터가 MCP/tool surface가 된다.
- agent는 issue/PR/page/ticket 안에서 action을 수행한다.
- enterprise vendor는 permission, audit, governance를 제품의 방어선으로 삼는다.

momo는 이들을 대체하기보다 연결해야 한다. Jira/Linear/Paca/GitHub/Google Workspace는 task/document/source-of-work이고, momo는 그 작업을 사람이 승인하고 agent가 실행하는 communication ledger가 된다.

### Slack, MCP, A2A: context and protocol standardization

[Slack AI](https://docs.slack.dev/ai/)와 [developing agents](https://docs.slack.dev/ai/developing-agents/)는 agent가 channel context와 governance 안에서 작동하는 방향을 보여준다. [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)은 host가 tool/resource/prompt access와 user consent를 책임지는 model을 제공한다. [A2A protocol](https://a2a-protocol.org/latest/specification/)은 agent discovery, task, message, artifact, status lifecycle를 표준화한다.

momo의 기존 Context Packet, Memory Plane, Capability Cache, approval pause/resume, Agent Run Lifecycle은 이 흐름과 잘 맞다. 다음 단계는 이 스펙들을 "문서상 좋은 생각"에서 server/macOS/runtime contract로 좁혀가는 것이다.

## momo의 차별점

| 비교 대상 | 중심 객체 | 강점 | momo가 이길 지점 |
|---|---|---|---|
| Slack/Discord | conversation/channel | distribution, UX maturity, ecosystem | agent execution ledger, self-hosted policy, local memory/context governance |
| Mattermost | self-hosted messaging | deploy/control, plugin depth | agent-first member model, approval/cost/audit native timeline |
| Paca/Jira/Linear | task/board/issue | work tracking, planning, backlog | task 이전과 이후의 conversation, context packet, approval checkpoint |
| OpenHands/Copilot | coding agent task | code execution, sandbox, PR automation | non-code enterprise work, human approval, cross-tool channel surface |
| Rovo/Atlassian | suite-native agent | Atlassian data gravity | vendor-neutral self-hosted agent protocol host |

momo의 핵심 제품 불변식:

1. Channel timeline is the ledger.
2. Agent is a first-class member, not a bot bolt-on.
3. Plugin write is never invisible: `tool_call -> approval_request -> tool_result -> audit_log`.
4. Context belongs to momo, not to the external agent runtime.
5. Memory is typed and permissioned, not raw chat exhaust.
6. Cost and policy are visible in the conversation surface.
7. Self-hosted deployment and optional local LLM reduce enterprise adoption risk.

## 제품 전략

### Do

- Keep core messenger and execution ledger in one coherent product until M3/M4.
- Make GitHub/Google Workspace/Jira-like plugins first-party references.
- Treat MCP as inbound surface and plugin/capability discovery path.
- Treat A2A mapping as internal lifecycle compatibility, not mandatory public API yet.
- Use local LLM for context work: intent, summary, redaction, compaction, routing.
- Use server agents for long reasoning, external writes, and expensive tool execution.

### Do not

- Do not clone Paca's board-first product.
- Do not split repos before protocol boundaries stabilize.
- Do not make plugin runtime a general arbitrary code execution surface before signed artifacts, policy, and audit exist.
- Do not let external agent memory bypass momo RLS/context policy.
- Do not claim "secure like Telegram" as a blanket statement. Prefer "self-hosted, audited, least-privilege agent execution ledger."

## Roadmap impact

MOMO-180 does not change the current M1/M2/M3 implementation order. It adds an ecosystem overlay that should guide upcoming work.

Immediate worker flow remains:

- Runtime/backend worker: workspace roster, approval resume, or realtime contract.
- macOS worker: REST-backed ChatBackend and protocol card behavior.
- Docs/spec worker: plugin manifest/catalog or first-party plugin strategy.
- Infra/devtooling worker: compose layer/e2e/prod plan.
- momo-main: review, merge, roadmap, issue picking, research.

New follow-up candidates:

- MOMO-181: Plugin manifest and catalog split criteria.
- MOMO-182: Docker compose layer ADR for dev/e2e/prod/install/backup.
- MOMO-183: First-party plugin repo strategy.
- MOMO-184: Agent host positioning/product messaging.

## Source index

- [Paca repo](https://github.com/Paca-AI/paca)
- [Paca organization repos](https://github.com/orgs/Paca-AI/repositories)
- [Paca architecture overview](https://github.com/Paca-AI/paca/blob/master/docs/architecture/overview.md)
- [Paca plugin overview](https://github.com/Paca-AI/paca/blob/master/docs/plugins/overview.md)
- [Paca backend plugin system](https://github.com/Paca-AI/paca/blob/master/docs/plugins/backend-plugin-system.md)
- [Paca MCP plugin system](https://github.com/Paca-AI/paca/blob/master/docs/plugins/mcp-plugin-system.md)
- [Paca deploy](https://github.com/Paca-AI/paca/blob/master/deploy/README.md)
- [OpenHands](https://github.com/OpenHands/OpenHands)
- [GitHub Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent)
- [Linear MCP](https://linear.app/docs/mcp)
- [Atlassian Rovo agents](https://support.atlassian.com/rovo/docs/agents/)
- [Slack AI](https://docs.slack.dev/ai/)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [A2A protocol](https://a2a-protocol.org/latest/specification/)
