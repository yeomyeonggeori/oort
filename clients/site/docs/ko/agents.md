---
title: 에이전트 연결
description: 에이전트를 oort 멤버로 연결하는 방식, 이 맥의 Claude Code·Codex를 쓰는 방법, 아직 없는 것을 정리했어요.
status: partial
checked: 2026-11-09
sources:
- server-rust/bins/momo-agent-worker/src/provider.rs
- server-rust/bins/momo-agent-worker/src/anthropic.rs
- server-rust/bins/momo-agent-worker/src/partial.rs
- server-rust/crates/momo-provider-probe/src/cohosted.rs
- server-rust/bins/momo-server/src/routes/cohosted_agent.rs
- docs/adr/0203-cohosted-agent-detection.md
- scripts/self_host_env.sh
- infra/hermes/lockgate.py
- server-rust/bins/momo-server/src/routes/agent_credentials.rs
- server-rust/crates/momo-auth/src/agent_bearer.rs
- server-rust/bins/momo-server/src/dto.rs
- server-rust/bins/momo-server/src/routes/agent_gateway.rs
- server-rust/bins/momo-server/src/lib.rs
- server-rust/bins/momo-server/src/routes/agent_port.rs
- server-rust/bins/momo-server/src/routes/agent_port_oauth.rs
- server-rust/bins/momo-server/src/config.rs
- docs/adr/0162-external-agent-reception-agent-port.md
- packages/momo-core/src/features/hostedAgents/presets.ts
- docs/adr/0198-agents-vs-harnesses-work-request-routing.md
- packages/momo-core/src/features/onboarding/aiConnect.ts
- packages/momo-core/src/features/auth/personalAgentCall.ts
- server-rust/crates/momo-agent/src/subscription.rs
- packages/momo-core/src/features/ai/aiHubModel.ts
- server-rust/bins/momo-workd/src/acp.rs
- server-rust/bins/momo-workd/src/policy.rs
- docs/adr/0130-external-coding-agent-membership.md
- docs/adr/0183-codebase-docs-lightening.md
---

어떤 방식으로 연결하든 에이전트는 워크스페이스의 멤버(`member.kind = 'agent'`)가 되고, 채널에 넣어야 그 채널에서 `@핸들`로 부를 수 있어요.

| 에이전트 | 연결 방식 | 부를 수 있는 사람 | 상태 |
|---|---|---|---|
| OpenAI 호환 API 키나 Anthropic API 키로 쓰는 에이전트 | [모델 백엔드](#모델-백엔드) | 팀 | {done} |
| 같은 서버의 Hermes | [Hermes](#hermes) | 팀 | {done} |
| HTTP로 메시지를 쓰는 직접 만든 프로그램 | [REST 에이전트 멤버](#rest-에이전트-멤버) | 팀 | {done} |
| 원격 MCP 서버를 등록할 수 있는 외부 에이전트(그록봇 등) | [Agent Port](#agent-port) | 팀 | {partial} |
| 이 맥의 Claude Code·Codex | [내 도구와 개인 에이전트](#내-도구와-개인-에이전트) | 나만 | {partial} |

## 모델 백엔드 {done}

oort의 에이전트 워커가 모델 API를 직접 호출해요. 키는 서버 운영자가 AI › 팀 AI 키에 넣고, 서버에는 암호문으로만 저장돼요.

| 키 종류 | 요청 주소 | 답을 받는 방식 |
|---|---|---|
| OpenAI 호환 키(Bearer) | `POST {주소}/chat/completions` | 다 만든 답을 한 번에 받아요(`"stream": false`) |
| Anthropic 키 | `POST {주소}/messages` | 나눠서 받아요(스트리밍) |

- OpenAI 호환 방식은 스트리밍을 쓰지 않아요. 답이 다 만들어진 뒤 채널에 한 번에 올라와요.
- Anthropic 방식은 `x-api-key`와 `anthropic-version: 2023-06-01` 헤더를 보내고, 답이 오는 대로 채널 메시지에 이어서 보여요.
- 어느 방식으로 호출할지는 주소가 아니라 저장된 키의 종류로 정해요.

## Hermes {done}

Hermes는 에이전트 런타임이에요. 서버 운영자가 같은 서버에 Hermes를 띄우고 주소를 `HERMES_BASE_URL`에 적으면, oort가 그 주소에 요청 두 개를 보내 확인해요.

| 단계 | 요청 | 확인하는 것 |
|---|---|---|
| 1 | `GET /health` | 그 주소에서 응답이 오는지 |
| 2 | `GET /v1/models` | OpenAI 호환 서버인지, 키가 맞는지 |

둘 다 통과하면 운영자 화면에 Hermes를 연결할지 묻는 카드가 나와요. 연결하면 Hermes가 에이전트 멤버로 만들어지고, 에이전트 워커가 Hermes의 `/v1/chat/completions`를 스트리밍 없이(`"stream": false`) 호출해요.

- 이 확인은 운영자가 화면을 열거나 다시 확인할 때만 해요. 내부망을 스캔하거나 주소를 추측하지 않아요.
- Hermes의 터미널, 코드 실행, 브라우저 도구를 꺼야 연결할 수 있어요. oort 서버는 이것을 네트워크로 확인할 수 없어서 서버 설정값 `OORT_COHOSTED_AGENT_TOOLS_LOCKED`로 표시해요. 셀프호스트 설정 생성기가 이 값을 넣고, Hermes는 도구 잠금 검사를 통과해야 시작돼요.
- 연결해도 채널이나 도구 권한이 자동으로 생기지 않아요. 채널에는 따로 넣어요.

## REST 에이전트 멤버 {done}

직접 만든 프로그램을 에이전트 멤버로 연결하는 가장 단순한 방식이에요. 워크스페이스 소유자나 관리자가 에이전트마다 토큰을 발급하고, 프로그램은 그 토큰으로 사람과 같은 REST API를 호출해요.

1. 에이전트 멤버를 만들고 채널에 넣어요.
2. 그 에이전트의 토큰을 발급해요. 토큰은 `momo_agent_v1.`으로 시작하고, 발급할 때 한 번만 보여요. 서버에는 해시만 남아요.
3. 프로그램은 `Authorization: Bearer` 헤더에 토큰을 넣어 API를 호출해요.

```http
POST /v1/workspaces/<워크스페이스 id>/channels/<채널 id>/messages
Authorization: Bearer <에이전트 토큰>
Content-Type: application/json

{"clientMsgId": "<새 UUID>", "body": "배포를 마쳤어요."}
```

- 같은 메시지를 다시 보낼 때는 `clientMsgId`를 바꾸지 않아요. 그래야 한 번만 저장돼요.
- 모르는 필드가 있으면 400으로 거절해요.
- 토큰은 언제든 폐기할 수 있어요.

멘션을 받아 작업하는 런타임은 서버가 만든 작업을 가져가고(`…/gateway/jobs/pending`), 결과를 `…/gateway/complete`로 보내요. 이 방식은 서버를 `AGENT_GATEWAY_MODE=gateway`로 실행했을 때만 열려요.

## Agent Port {partial}

Agent Port는 oort가 여는 원격 MCP 서버예요. 주소는 `/v1/mcp/agent-port`이고 MCP Streamable HTTP로 동작해요. 외부 에이전트가 자기 MCP 커넥터 설정에 이 주소를 원격 서버로 등록하면, 그 에이전트가 MCP 클라이언트로 oort에 연결돼요. 그록봇이 이 방식을 써요.

- 주소와 연결 값은 AI › 외부 연결의 「외부 에이전트 연결」에서 발급해요. 연결 값은 인증 헤더의 bearer 값으로 넣어요.
- OAuth 2.1(PKCE S256)도 만들어 두었지만 기본으로 꺼져 있어요. 운영자가 `MOMO_AGENT_PORT_OAUTH_ENABLED`를 켜기 전에는 OAuth 주소가 모두 404로 응답해요.
- 요청마다 따로 인증하고, 세션 상태를 남기지 않아요.

「부분」인 이유: 그록봇이 oort 팀 서버에서 이 주소로 작업을 가져가고 진행을 보고한 기록은 있어요. 하지만 앱의 그록봇 안내에는 그록봇이 인증 헤더를 실제로 보내는지 아직 확인되지 않았다고 적혀 있고, OAuth 2.1은 꺼져 있어요.

## 내 도구와 개인 에이전트 {partial}

이 맥에서 공식 CLI로 로그인한 Claude Code·Codex는 멤버가 아니라 「내 도구」예요. 내 구독은 나만 쓰고, 팀원에게 쓰게 하지 않아요.

원하면 「내 도구」를 개인 에이전트로 켤 수 있어요. 켜면 별칭(핸들)이 있는 에이전트 멤버가 생기지만, 부를 수 있는 사람은 소유자 한 명뿐이에요. 팀원이 부르면 「○○의 개인 에이전트예요」라는 안내만 남고 작업은 시작되지 않아요.

- 작업은 내 맥의 작업 호스트(`momo-workd`)가 ACP(Agent Client Protocol)로 CLI를 띄워 실행해요. 표준 입출력으로 한 줄에 JSON-RPC 메시지 하나씩 주고받아요.
- 내 맥이 켜져 있을 때만 답해요. 꺼져 있으면 「내 맥이 꺼져 있어요」가 보이고, 요청이 대기 상태로 남지 않아요.
- 데스크탑·폰 앱에서 부르면 기기 키로 서명한 작업 요청이 함께 가요. 서명 키가 없는 브라우저에서는 메시지만 남고 「데스크탑·폰에서 불러 주세요」가 보여요.
- 작업 호스트는 설정의 허용 목록에 있는 프로그램만 실행해요. Codex는 승인을 묻는 읽기 전용 모드로 시작해요. 작업이 끝나면 에이전트가 띄운 프로세스까지 모두 정리해요.

「부분」인 이유: 지금 연결되는 CLI는 Claude Code와 Codex 두 가지뿐이에요.

## 아직 없는 것 {planned}

- A2A Agent Card로 에이전트를 등록하는 방법은 없어요. 예전 등록 경로(`agents/from-card`)는 없앴어요.
- 에이전트용 SDK는 아직 없어요. 지금은 위의 REST API나 MCP를 직접 써요.
