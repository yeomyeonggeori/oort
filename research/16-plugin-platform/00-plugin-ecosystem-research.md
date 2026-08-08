# Plugin Ecosystem Research: Codex, Hermes, MCP, and First-Party Connectors

> Planning ID: `PLN-20260716-01`
> Updated: 2026-07-16
> Status: research input for ADR-0113 and SE-04A; not an implementation contract

## 1. Research question

oort에서 Codex처럼 공식/커스텀 플러그인을 발견하고 설치하되, Slack app directory보다 에이전트 실행에 적합한 권한·승인·감사 모델을 제공하려면 무엇을 채택해야 하는가?

이번 조사는 현재 정본인 Plugin Manifest v0, Capability Cache v0, Context Packet v0, approval ledger를 유지하면서 다음 제품 요구를 구체화한다.

- 워크스페이스 관리자가 공식/커스텀 플러그인을 설치·회수한다.
- 사용자는 자신의 Google Drive·Calendar·Gmail·GitHub·Notion 계정을 별도로 연결한다.
- 채널에서 플러그인을 명시적으로 호출하거나, 에이전트가 허용된 플러그인을 동적으로 발견한다.
- 외부 write는 항상 oort의 approval/audit timeline을 거친다.

## 2. Codex에서 배울 것

OpenAI의 현재 정의에서 plugin은 단일 MCP 서버가 아니라 **반복 업무를 위한 패키지**다. 하나의 plugin은 skills, apps, app templates를 포함할 수 있고, 외부 데이터·액션은 별도 app 권한을 상속한다. Plugin 설치가 소스 시스템 권한을 덮어쓰지 않으며, 관리자는 역할별 설치와 app의 read/write·confirmation·RBAC를 따로 관리한다. [OpenAI, Plugins in Codex](https://help.openai.com/en/articles/20001256-plugins-in-codex/)

로컬 Codex plugin cache의 Google Drive, Google Calendar, GitHub, Notion 패키지도 이 분리를 확인한다.

| Package | Workflow layer | Live integration layer | 관찰 |
|---|---|---|---|
| Google Drive | Drive/Docs/Sheets/Slides skills | app connector | 하나의 Drive 진입점이 여러 문서 유형 workflow를 묶는다. |
| Google Calendar | scheduling/briefing skills | app connector | connection과 workflow가 분리된다. |
| GitHub | issue/PR/CI/publish skills | app connector + CLI workflow | 읽기와 publish 절차가 같은 plugin 안에서 다른 경계를 가진다. |
| Notion | planning/research/meeting/capture skills | app connector + optional MCP config | plugin은 MCP보다 넓은 배포 단위다. |

### 채택

- plugin은 workflow·UI·capability metadata를 묶는 배포 단위로 본다.
- provider OAuth/data/action 연결은 plugin 설치와 분리된 `connection`으로 본다.
- 워크스페이스 설치와 사용자 계정 연결을 별도 상태로 보여준다.

### 채택하지 않음

- plugin 설치를 곧바로 모든 사용자 데이터 접근 허용으로 해석하지 않는다.
- MCP tool list를 그대로 신뢰하거나 전체를 agent context에 노출하지 않는다.

## 3. Hermes에서 배울 것

Hermes는 `plugin.yaml`과 Python registration으로 tool, hook, slash command, skill, CLI command를 추가한다. bundled/user/project/pip 소스에서 발견하며, 임의 코드는 `plugins.enabled` allow-list에 들어가기 전 실행되지 않는다. platform, memory, context engine, model provider 같은 전문 extension point도 분리한다. [Hermes Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins), [Build a Hermes Plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)

공식 내장 plugin 가이드는 third-party API key, 큰 의존성, niche workflow는 bundled가 아니라 user-installable plugin으로 두라고 권한다. [Hermes Built-in Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/built-in-plugins)

### 채택

- 공식/bundled와 custom/private의 trust class를 분리한다.
- 발견(discovered), 설치(installed), 활성화(enabled)를 분리한다.
- runtime adapter는 종류별로 명시한다: hosted connector, remote MCP, local MCP, agent-host plugin.
- inbound signed webhook은 외부 이벤트를 oort에 넣는 trigger transport이며, 외부 write를 수행하는 outbound executor와 같은 runtime kind로 취급하지 않는다.

### 채택하지 않음

- 워크스페이스 서버가 검증되지 않은 Python 코드를 바로 import하는 모델.
- 이름 충돌 시 last-writer-wins로 공식 plugin을 덮어쓰는 모델.

oort의 custom plugin은 v0에서 arbitrary executable이 아니라 signed manifest + 외부 runtime endpoint를 기본으로 한다.

## 4. MCP가 담당하는 범위

MCP는 external tool/resource transport의 한 구현이다. HTTP transport의 표준 authorization은 OAuth 2.1 계열, PKCE, protected resource discovery, resource indicator와 audience binding을 요구하며 token passthrough를 금지한다. [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

MCP tool annotation은 trusted server에서 온 경우가 아니면 신뢰할 수 없다. 따라서 oort의 risk/approval classification은 catalog 검증과 policy owner 결정에서 만들어져야 한다. [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

결론:

- MCP server는 plugin의 `runtime adapter`가 될 수 있다.
- plugin identity, publisher trust, 설치, channel grant, approval policy, audit는 oort가 소유한다.
- remote MCP OAuth token과 upstream provider token은 서로 다른 audience로 묶고 pass-through하지 않는다.

## 5. 후보 connector 조사

### 5.1 Google Workspace

Google Workspace remote MCP는 Drive 등을 agent가 다루게 하지만 현재 Developer Preview다. 파일별 DLP/IRM·eligibility도 적용되므로 웹 UI에서 보이는 파일과 agent가 볼 수 있는 파일이 다를 수 있다. [Google Workspace MCP setup](https://developers.google.com/workspace/guides/configure-mcp-servers), [Drive MCP file eligibility](https://developers.google.com/workspace/drive/api/guides/drive-mcp-server-file-eligibility)

v0 제품 경로는 remote MCP에 종속하지 않고 공식 REST API + per-user OAuth를 사용한다. Drive는 `drive.file` + Google Picker가 가장 좁은 권한과 좋은 consent UX를 제공한다. [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Google Picker](https://developers.google.com/workspace/drive/api/guides/picker)

권장 sub-capability:

| Capability | v0 | 권한/승인 |
|---|---|---|
| Drive selected-file search/read/cite | 포함 | user-selected `drive.file`, read grant |
| Drive upload/create/link | 포함 | target folder 표시, write approval |
| Calendar free/busy | 포함 | `calendar.freebusy`, read grant |
| Calendar event create/update | 후속 | attendee/time/location approval |
| Gmail metadata/thread search | 제한 pilot | Gmail restricted scope 검토 뒤 |
| Gmail draft/send | 후속 | sensitive/restricted scope + 매회 approval |

Gmail `gmail.readonly`, `gmail.compose`, `gmail.modify` 등은 restricted scope이며 서버 저장/전송 시 보안 평가가 필요할 수 있다. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Workspace user data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

### 5.2 GitHub

GitHub의 공식 MCP server는 toolset·개별 tool allow-list, read-only, lockdown을 제공한다. [GitHub MCP Server](https://github.com/github/github-mcp-server), [Server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)

이는 oort의 `tool_grants` 최소화 모델과 잘 맞는다. v0는 repo allow-list + issues/PR/repo read를 먼저 제공하고, issue/comment/PR write는 approval 뒤로 둔다.

### 5.3 Notion

Notion은 hosted MCP를 제공하고 OAuth로 workspace read/write를 지원한다. custom client는 OAuth 2.0 PKCE와 Streamable HTTP를 구현해야 한다. [Notion MCP](https://developers.notion.com/guides/mcp/overview), [Custom MCP client](https://developers.notion.com/guides/mcp/build-mcp-client)

Hosted MCP는 최초 interactive OAuth와 refresh/session lifecycle을 요구하므로 unattended agent의 유일한 경로로 쓰기에는 운영 제약이 있을 것으로 판단한다 `(추정)`. 또한 MCP file upload는 아직 지원하지 않아 파일 업로드는 별도 Notion API를 사용해야 한다. [Notion MCP setup FAQ](https://developers.notion.com/guides/mcp/get-started-with-mcp), [Notion file upload API](https://developers.notion.com/reference/file-upload)

### 5.4 Google Calendar, Gmail을 별도 plugin으로 볼 것인가

카탈로그에서는 `Google Workspace` 하나로 제공하되, 연결 후 Drive/Calendar/Gmail을 독립 capability bundle로 grant한다. 설치·브랜드·OAuth 계정이 하나인데 plugin을 세 개로 나누면 onboarding과 revoke가 불필요하게 복잡해진다.

사용자는 다음을 따로 켤 수 있어야 한다.

- Drive: Picker로 명시적으로 선택한 파일 ID. 폴더는 upload target으로 별도 grant하며, 재귀 탐색은 broad-search 후속 scope다.
- Calendar: availability 또는 event write
- Gmail: metadata, thread body, draft/send

## 6. 추천 카탈로그

| Tier | Plugin | 목적 | 기본 정책 |
|---|---|---|---|
| Reference P0 | Google Workspace | Drive-first source/artifact loop | Drive read+citation, upload/write approval |
| Reference P0 | GitHub | issue/PR/code work loop | repo allow-list, read first, write approval |
| Reference P0 | Notion | docs/search/knowledge capture | OAuth, read first, page write approval |
| P1 | Work Items | Linear/Jira-like task bridge | project allow-list, state write approval |
| P1 | Slack/Teams bridge | migration/notification/legacy channel bridge | no shadow SoT; import/cross-post policy |
| P1 | Local Files/Obsidian | self-host/local knowledge | user-selected roots only |
| P2 | Browser/Computer Use | UI-only systems automation | high risk, explicit session approval |
| P2 | HR/ERM workflow | request/approval/status | private enterprise catalog |
| Platform | Signed Webhook | custom internal system adapter | signed ingress + egress allow-list |
| Platform | Custom MCP | private tool server | admin-reviewed auth/tools/write behavior |

## 7. 핵심 결론

1. oort plugin은 MCP server와 동의어가 아니다.
2. 설치는 data access가 아니다. workspace install, member OAuth, channel enable, capability grant를 분리한다.
3. agent에는 전체 catalog가 아니라 현재 actor/channel에서 허용되고 healthy한 `tool_grants`만 전달한다.
4. OAuth token과 provider secret은 Context Packet, Memory Plane, Capability Cache, timeline, audit payload에 절대 넣지 않는다.
5. 첫 **제품 체감 vertical**로 Google Workspace의 Drive selected-file read/cite/upload loop를 제안한다. 다만 기존 정본은 GitHub가 첫 생태계 증명 플러그인이며 repo split도 GitHub부터 시작하는 전략이므로, 제품 오너 결정과 Accepted ADR이 이를 명시적으로 바꾸기 전까지 Drive-first는 비교 가능한 제안일 뿐이다.
6. Gmail은 유용하지만 검증 비용과 restricted scope 부담 때문에 v0 기본 추천에서 뒤로 둔다.
7. arbitrary code marketplace는 v0 범위가 아니다. custom은 signed manifest + governed remote runtime부터 시작한다.
