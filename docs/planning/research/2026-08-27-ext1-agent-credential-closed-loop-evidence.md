# #1797 폐곡선 실측 로그 (토큰 원문 제거)

> 측정: 2026-08-27. 워크트리 `w1797-ext1`, 브랜치 `docs/1797-ext1-agent-credential` @ `bd41f6b6`.
> 스택: compose `momo_docs-1797-ext1-agent-credential` (PG `127.0.0.1:25162`, Centrifugo `25161`) + 로컬 `momo-server` `127.0.0.1:25160`.
> **라이브 리그 `oort-t`(8180) · 외부 VM 비접촉.**
> 모든 bearer/JWT/pairing 원문은 `[REDACTED]` 또는 `momo_agent_v1.<ws>.[REDACTED]`.

- workspace: `00000000-0000-7000-8000-000000000001` (시드 `demo`)
- channel #general: `00000000-0000-7000-8000-000000000201`
- generic agent: `01a042dc-0a44-7e84-93ad-6b90dae5ada8` (`ext1-claude-code`)
- hosted agent: `01a042dc-0afc-7b7b-8209-018c965a2d0c` (`ext1-hosted-probe`)

---

## 0-health

- `GET /health` → **200**

```json
{
  "status": "ok",
  "service": "momo-server",
  "database": "ok"
}
```

## 1-login

- `POST /v1/auth/login` → **200**
- JWT `typ=access`, `scopes=['messages:write','messages:read']`, `exp - iat = 900` (15분)

```json
{
  "accessToken": "[REDACTED]",
  "refreshToken": "[REDACTED]",
  "member": {
    "id": "00000000-0000-7000-8000-000000000101",
    "workspaceId": "00000000-0000-7000-8000-000000000001",
    "kind": "human",
    "displayName": "데모 사용자",
    "handle": "demo"
  },
  "realtimeWebSocketUrl": "ws://127.0.0.1:25161/connection/websocket"
}
```

## 2-list-channels

- `GET /v1/workspaces/{ws}/channels` → **200** (`general`, `agent-lab`)

## 3-create-agent

- `POST /v1/workspaces/{ws}/agents` → **201**

```json
{
  "agent": {
    "id": "01a042dc-0a44-7e84-93ad-6b90dae5ada8",
    "handle": "ext1-claude-code",
    "displayName": "EXT1 Claude Code"
  }
}
```

요청 본문: `displayName`, `handle=ext1-claude-code`, `model=external-tool`, `baseUrl=https://example.invalid/v1`. 자격은 이 응답에 없음.

## 4-add-channel-member (사람 admin)

- `POST /v1/workspaces/{ws}/channels/{general}/members` `{memberId, role: member}` → **200**

```json
{
  "membership": {
    "id": "01a042dc-0a56-7138-bd57-48524801f75c",
    "workspaceId": "00000000-0000-7000-8000-000000000001",
    "channelId": "00000000-0000-7000-8000-000000000201",
    "memberId": "01a042dc-0a44-7e84-93ad-6b90dae5ada8",
    "role": "member"
  }
}
```

## 5-issue-default-credential

- `POST /v1/workspaces/{ws}/agents/{agent}/credentials` `{"label":"ext1 default measurement"}` → **201**
- Cache-Control: `no-store` · Pragma: `no-cache`
- `expiresAtMs` 없음 (장수명) · `rotatedCredentialCount=0`

```json
{
  "credential": {
    "id": "01a042dc-0a66-7fac-bf24-f100fc754fa6",
    "agentMemberId": "01a042dc-0a44-7e84-93ad-6b90dae5ada8",
    "status": "active",
    "scopes": [
      "agent:jobs:read",
      "agent:runs:callback",
      "messages:write",
      "realtime:subscribe",
      "work:control"
    ],
    "label": "ext1 default measurement"
  },
  "token": "[REDACTED]",
  "tokenType": "Bearer",
  "rotatedCredentialCount": 0
}
```

## 6-agent-write-default

- `POST …/channels/{general}/messages` (agent bearer) → **201**, `seq=1`, `authorMemberId` = generic agent

## 7-agent-rest-read-default

- `GET …/channels/{general}/messages` (같은 bearer) → **403**
- `"agent bearer is not allowed for this route"`

## 8-agent-self-join

- `POST …/channels/{agent-lab}/members` (agent bearer) → **403**
- 같은 문장. 채널 합류는 사람 admin 경로.

## 9-issue-read-port-credential (회전)

- 명시 스코프 `messages:write`, `messages:read`, `agent:port:connect`, `agent:inbox:read` → **201**
- `rotatedCredentialCount=1`, `rotationGraceEndsAtMs` 존재 (기본 24h)
- 후속 list에서 predecessor는 `status=active` + `expiresAtMs` = grace 끝

## 10-agent-rest-read-explicit

- `GET …/messages` (`messages:read`를 든 successor) → **403** 동일 문장

## 11-agent-write-rotated

- successor로 POST message → **201**, `seq=2`

## 12–13 MCP (잘못된 Accept)

- `Accept: application/json`만 → **415**
- `"Accept must include application/json and text/event-stream"`

## 14-mcp-default-token-no-port-scope

- 기본 스코프(포트 없음)로 Agent Port → **403**

## 15-create-hosted-connection

- `POST /v1/workspaces/{ws}/hosted-agent-connections` → **201**
- `status=pairing_pending`, `approvedScopes=[]`
- pairing 원문 1회 노출, Cache-Control `no-store`

## 16-generic-cred-on-hosted

- hosted member에 generic `POST …/credentials` → **409**
- `"hosted_connection_managed"`

## 17-generic-revoke-on-hosted

- 같은 member에 `POST …/credentials/{id}/revoke` (존재하지 않는 id) → **409**
- 같은 코드. hosted면 issue/revoke 모두 generic API에서 거절.

## 18-list-generic-credentials

- `GET …/agents/{generic}/credentials` → **200**, metadata only (`token` 필드 없음)
- successor `active` + predecessor `active` with `expiresAtMs`

## 19-human-rest-read-control

- 사람 세션으로 `GET …/messages` → **200**, seq 1·2 본문 확인

---

## 후속 측정 (같은 스택, 수 분 뒤)

사람 재로그인 후 같은 generic agent에 다시 발급.

### 20-issue-A (grace predecessor)

- `scopes: ["messages:write"]` → **201**, `rotatedCredentialCount=2`

### 21-issue-B (MCP 최소 집합)

- `scopes: ["messages:write","messages:read","agent:port:connect","agent:inbox:read"]` → **201**, `rotatedCredentialCount=3`

### 22-grace-A-write

- A 토큰으로 POST message → **201**, `seq=3` (`grace predecessor still writes`)
- 회전 직후 predecessor는 유예 동안 살아 있다.

### 23-mcp-tools-list (올바른 Accept)

- `Accept: application/json, text/event-stream`
- `MCP-Protocol-Version: 2026-07-28` · `Mcp-Method: tools/list`
- generic successor (포트+read 스코프) → **200**

```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "cache": {"scope": "private", "ttlSeconds": 0},
    "resultType": "tools/list",
    "tools": []
  }
}
```

### 24-mcp-conversation-read

- `tools/call` `oort_conversation_read` (camel/snake 인자 둘 다) → **400**
- `"unknown tool"` (JSON-RPC `-32602`)

generic 자격은 Agent Port에 **입장**할 수 있으나, hosted connection이 없어 도구 목록이 비고 읽기 tool은 호출되지 않는다.
