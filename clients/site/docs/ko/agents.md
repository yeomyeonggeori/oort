---
title: 에이전트 연결
description: 에이전트를 oort 멤버로 붙이는 다섯 가지 방식과, 아직 만들지 않은 것을 정리했어요.
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
- server-rust/bins/momo-workd/src/acp.rs
- server-rust/bins/momo-workd/src/policy.rs
- docs/adr/0130-external-coding-agent-membership.md
- docs/adr/0183-codebase-docs-lightening.md
---

에이전트가 어떻게 생겼느냐에 따라 붙는 길이 달라요. 어느 길로 붙든 에이전트는 워크스페이스의 멤버(`member.kind = 'agent'`)가 되고, 채널에 넣어야 그 채널에서 부를 수 있어요.

| 이런 에이전트라면 | 붙는 길 | 상태 |
|---|---|---|
| OpenAI 호환 API나 Anthropic API 키가 있어요 | [모델 백엔드](#모델-백엔드) | {done} |
| 같은 서버에 Hermes가 떠 있어요 | [Hermes](#hermes) | {done} |
| 내 프로그램이 HTTP로 직접 메시지를 써요 | [REST 에이전트 멤버](#rest-에이전트-멤버) | {done} |
| 원격 MCP 서버를 붙일 수 있는 호스팅 에이전트예요 | [Agent Port](#agent-port) | {partial} |
| 내 컴퓨터의 Claude Code나 Codex예요 | [작업 호스트](#작업-호스트) | {partial} |

## 모델 백엔드 {done}

oort의 에이전트 워커가 모델 API를 직접 불러요. 키는 서버 운영자가 AI › 팀 AI 키에서 넣고, 서버에는 암호문으로만 저장돼요.

| 키 종류 | 부르는 곳 | 답을 받는 방식 |
|---|---|---|
| OpenAI 호환 키(Bearer) | `POST {주소}/chat/completions` | 다 만든 답을 한 번에 받아요(`"stream": false`) |
| Anthropic 키 | `POST {주소}/messages` | 나눠서 받아요(스트리밍) |

- OpenAI 호환 길은 스트리밍을 쓰지 않아요. 답이 다 만들어진 뒤 한 번에 채널에 올라와요.
- Anthropic 길은 `x-api-key`와 `anthropic-version: 2023-06-01` 헤더로 부르고, 답이 오는 대로 채널의 메시지가 자라요.
- 어느 길로 부를지는 주소가 아니라 저장된 키의 종류로 정해요.

## Hermes {done}

Hermes는 에이전트 런타임이에요. 서버 운영자가 같은 서버에 Hermes를 띄우고 주소를 `HERMES_BASE_URL`로 알려 주면, oort가 그 주소에 두 가지를 물어봐요.

| 차례 | 요청 | 확인하는 것 |
|---|---|---|
| 1 | `GET /health` | 그 주소에서 무언가 답하는지 |
| 2 | `GET /v1/models` | OpenAI 호환 서버인지, 키가 맞는지 |

둘 다 통과하면 운영자 화면에 Hermes를 연결할지 묻는 카드가 떠요. 연결하면 Hermes가 에이전트 멤버로 만들어지고, 에이전트 워커가 Hermes의 `/v1/chat/completions`를 스트리밍 없이(`"stream": false`) 불러요.

- 이 확인은 운영자가 화면을 열거나 다시 찾을 때만 해요. 내부망을 훑거나 주소를 짐작하지 않아요.
- Hermes에서 터미널, 코드 실행, 브라우저 도구를 꺼야 연결할 수 있어요. oort 서버는 이것을 네트워크로 확인하지 못해서, 서버 설정값 `OORT_COHOSTED_AGENT_TOOLS_LOCKED`로 알려요. 셀프호스트 설정 생성기가 이 값을 넣고, Hermes는 잠금 검사를 통과해야 떠요.
- 연결해도 채널이나 도구 권한을 저절로 주지 않아요. 채널에는 따로 넣어요.

## REST 에이전트 멤버 {done}

내 프로그램을 에이전트 멤버로 붙이는 가장 단순한 길이에요. 워크스페이스 소유자나 관리자가 에이전트마다 토큰을 발급하고, 프로그램은 그 토큰으로 사람과 같은 REST API를 불러요.

1. 에이전트 멤버를 만들고 채널에 넣어요.
2. 그 에이전트의 토큰을 발급해요. 토큰은 `momo_agent_v1.`으로 시작하고, 발급할 때 한 번만 보여요. 서버에는 해시만 남아요.
3. 프로그램은 `Authorization: Bearer` 헤더에 토큰을 넣어 API를 불러요.

```http
POST /v1/workspaces/<워크스페이스 id>/channels/<채널 id>/messages
Authorization: Bearer <에이전트 토큰>
Content-Type: application/json

{"clientMsgId": "<새 UUID>", "body": "배포를 마쳤어요."}
```

- 같은 메시지를 다시 보낼 때는 `clientMsgId`를 바꾸지 않아요. 그래야 한 번만 저장돼요.
- 모르는 필드가 있으면 400으로 거절해요.
- 토큰은 언제든 폐기할 수 있어요.

멘션을 받아 일하는 런타임은 서버가 만든 작업을 가져가고(`…/gateway/jobs/pending`), 결과를 `…/gateway/complete`로 돌려줘요. 이 길은 서버가 `AGENT_GATEWAY_MODE=gateway`로 떠 있을 때만 열려요.

## Agent Port {partial}

Agent Port는 호스팅된 에이전트가 원격 MCP 서버로 oort에 붙는 문이에요. 주소는 `/v1/mcp/agent-port`이고, MCP Streamable HTTP 방식이에요. Claude Code, Codex, 그록봇을 이 길로 붙여요.

- 연결 값은 AI › 외부 연결에서 발급해요.
- OAuth 2.1(PKCE S256)도 만들어져 있지만 기본으로 꺼져 있어요. 운영자가 `MOMO_AGENT_PORT_OAUTH_ENABLED`를 켜기 전에는 OAuth 주소가 모두 404로 답해요.
- 요청마다 따로 인증하고, 세션 상태를 남기지 않아요.

「부분」인 이유: 서버 쪽 문과 시험은 있지만, 실제 클라이언트(Claude Code, Codex, 그록봇)와 끝까지 이어 본 확인이 아직 없어요.

## 작업 호스트 {partial}

내 컴퓨터에서 도는 Claude Code나 Codex를 붙이는 길이에요. 작업 호스트(`momo-workd`)가 에이전트를 ACP(Agent Client Protocol)로 띄우고, 표준 입출력으로 한 줄에 JSON-RPC 메시지 하나씩 주고받아요.

- 띄울 수 있는 프로그램은 호스트 설정의 허용 목록에 있는 것뿐이에요.
- Codex는 승인을 묻는 읽기 전용 모드로 시작해요.
- 작업이 끝나면 에이전트가 띄운 프로세스까지 모두 정리해요.

「부분」인 이유: 지금 붙는 에이전트는 Claude Code와 Codex 두 가지뿐이에요.

## 아직 없는 것 {planned}

- A2A Agent Card로 에이전트를 등록하는 길은 없어요. 예전 등록 경로(`agents/from-card`)는 걷어 냈어요.
- 에이전트용 SDK는 아직 없어요. 지금은 위의 REST API나 MCP를 바로 써요.
