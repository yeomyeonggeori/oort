# momo Plugin Platform Product Proposal

> Planning ID: `PLN-20260716-01`
> Updated: 2026-07-16
> Status: product proposal; ADR-0113 acceptance and SE-04A implementation required
> Existing contracts: Plugin Manifest v0, Context Packet v0, Memory Plane v0, Capability Cache v0, ADR-0001

## 1. Product promise

> 필요한 도구를 워크스페이스에 설치하고, 각 사용자가 자기 계정을 연결하면, 사람과 에이전트가 같은 채널에서 출처·권한·승인 기록을 남기며 함께 일한다.

momo의 차별점은 plugin 개수가 아니라 plugin으로 수행한 일이 channel execution ledger에 남는다는 점이다.

## 2. Product model

### 2.1 Trust class

| Class | Publisher | Install rule | Runtime rule |
|---|---|---|---|
| Official | Dawn/momo | signed catalog, curated | hosted connector or reviewed adapter |
| Verified | reviewed partner | signature + security review | remote MCP/connector with allow-list |
| Custom/private | workspace admin | private catalog, explicit warning | signed manifest; no in-process arbitrary code |
| Local developer | user-owned host | developer mode only | loopback/stdio, machine-bound consent |

### 2.2 Six orthogonal projections

플러그인을 단순히 Installed/Not installed로 표현하지 않는다. 아래 여섯 항목은 하나의 선형 state machine이 아니라 서로 다른 소유자와 lifecycle을 가진 독립 projection이다.

1. catalog projection: `listed`, `withdrawn`
2. workspace installation projection: `installed`, `update_pending`, `suspended`, `revoked`
3. member connection projection: `connected`, `expired`, `revoked`, `reconnect_required`
4. channel enablement projection: `enabled`, `disabled`, `policy_blocked`
5. actor grant projection: `granted`, `suspended`, `revoked`
6. runtime health projection: `healthy`, `degraded`, `unavailable`, `unknown`

이 projection을 분리해야 “설치했는데 왜 파일이 안 보이나”, “연결했는데 왜 agent가 쓰기를 못 하나”를 UI가 설명할 수 있다. 업데이트가 capability/schema/provider scope를 넓히면 자동 승격하지 않고 `update_pending`으로 멈추며 관리자 검토와 사용자 재동의를 요구한다.

## 3. Primary UX

### 3.1 Workspace Plugin Center

서버/workspace 메뉴에 `플러그인`을 추가한다.

- Tabs: `설치됨`, `둘러보기`, `커스텀`
- Search + categories: Productivity, Engineering, Knowledge, Communication, Automation
- Trust badge: Official, Verified, Private, Local
- Capability badge: Read, Propose, Write, Admin
- Connection badge: N명 연결, 연결 필요, 정책 차단
- Runtime badge: Healthy, Setup required, Degraded, Revoked

Codex의 icon strip과 featured catalog는 참고하되, momo는 각 plugin card에 **누가 어떤 데이터와 action을 허용하는지**를 먼저 보여준다.

### 3.2 Install flow

`설치` 버튼 하나로 provider 데이터 권한까지 얻지 않는다.

1. plugin detail: publisher, signature, version, data boundary, requested capabilities 확인
2. workspace admin install
3. default channel/role policy 선택
4. 사용자별 `계정 연결` OAuth
5. low-risk test: read/search 또는 selected file
6. channel enable

Write capability는 read 연결 뒤 별도 step-up으로 요청한다.

### 3.3 Onboarding recommended plugins

첫 workspace onboarding에서 추천 preset을 제공한다.

- `문서와 일정`: Google Workspace, Notion
- `개발팀`: GitHub, Google Workspace
- `운영팀`: Google Workspace, Work Items, Notion
- `직접 선택`: 아무것도 자동 설치하지 않음

추천은 체크박스 opt-in이다. OAuth와 write grant는 onboarding에서 강제하지 않는다. 관리자는 나중에 skip한 plugin을 Plugin Center에서 설치할 수 있다.

### 3.4 Channel and composer surfaces

- 채널 설정: `사용 가능한 플러그인`과 channel-specific resource allow-list
- Composer `+`: `플러그인으로 작업`
- Explicit mention: `@hermes Google Drive를 사용해서 ...`
- Plugin chip: `Google Drive로 검색`, `GitHub 이슈 만들기`
- Message context action: `Drive에 저장`, `Notion 페이지로 만들기`, `GitHub 이슈로 전환`

에이전트 응답에는 사용한 plugin/source badge를 붙인다. External write는 inline approval card로 표시하고 승인 후 같은 run을 재개한다.

## 4. Dynamic discovery contract

에이전트가 catalog 전체를 보거나 임의 plugin을 설치하지 않는다.

```text
catalog manifest
  -> workspace installation
  -> member connection
  -> channel policy
  -> Capability Cache snapshot
  -> Context Packet tool_grants
  -> agent tool selection
  -> approval / result / audit
```

Context Packet에는 다음만 들어간다.

- stable tool id and schema hash
- plugin id/version/capability version
- grant: read/propose/write
- resource scope: selected Drive file IDs, separately granted upload folder, GitHub repo, Notion space
- risk and approval policy
- connection reference id, not credential
- connection owner/provider subject, represented actor, grantor/delegator, and `via_token_id` reference

Connection projection과 grant projection은 `workspace_id`, connection owner/provider subject, represented actor, delegator/grantor를 명시적으로 묶는다. 위임이 없으면 actor와 connection subject가 같아야 한다. 위임이 있으면 승인된 delegation과 `via_token_id`를 남기고 projection, approval, executor 세 지점에서 authoritative membership·grant·revoke epoch와 함께 다시 검사한다.

Cache invalidation trigger:

- install/update/uninstall
- OAuth revoke or provider scope change
- channel enable/disable
- role or membership change
- policy version/signature/capability version change
- runtime health expiry

## 5. Google Workspace reference journey

### 5.1 Install and connect

1. Workspace owner installs `Google Workspace` official plugin.
2. Member chooses `Google 계정 연결`.
3. v0 requests selected-file access using `drive.file` and Google Picker.
4. Member selects one or more file IDs. 업로드가 필요하면 별도의 target folder를 선택한다. 선택 폴더의 재귀 검색은 `drive.file`의 암묵적 권한으로 간주하지 않는다.
5. momo creates connection metadata and source allow-list; token custody follows accepted ADR-0113.
6. Channel owner enables `Drive search/read/cite` and optionally `upload/create`.

### 5.2 Ask and produce

Example:

> `@hermes Google Drive의 Q3 계획을 확인해서 실행 체크리스트를 만들고 결과를 같은 폴더에 올려줘.`

Expected execution:

1. agent receives only granted Drive tools and selected resource scope.
2. Drive documents become bounded source refs with citations.
3. artifact is generated in momo Work runtime.
4. upload tool call pauses for approval with target folder, filename and mime type.
5. approval resumes same agent run.
6. Drive upload result returns a source URL and file id.
7. timeline records source, approval, result and link.

### 5.3 Failure UX

- `연결 만료`: reconnect CTA; agent run becomes input-required, not silent failure.
- `권한 없음`: request selected file/folder or scope expansion.
- `관리자 정책 차단`: identify policy owner and requested capability.
- `provider unavailable`: read는 bounded retry, write는 provider 결과가 명확히 실패한 경우에만 retry한다.
- `upload outcome unknown`: Drive `files.create`에는 일반적인 idempotency key 계약이 없으므로 자동 재시도하지 않는다. 가능하면 `files.generateIds`로 file ID를 사전 할당하고 그 ID로 조회·reconcile한 뒤 재개하며, 그렇지 않으면 사람에게 결과 확인을 요청한다.
- `upload succeeded, callback failed`: preallocated/provider file id로 reconcile한 뒤에만 완료 또는 retry를 결정한다. [Drive files.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create), [Drive generateIds](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds)

## 6. Credential and privacy boundary

- Plugin manifest, Context Packet, Memory Plane, Capability Cache, audit log에는 raw token이 없다.
- OAuth connection id and encrypted secret record are separate.
- Hosted connector token storage requires Accepted ADR-0113 and key rotation/delete/export runbook.
- Remote MCP uses its own OAuth audience and cannot receive momo access token by passthrough.
- BYOA/Hermes may own provider credentials, but momo still owns channel grant, approval, result and audit.
- disconnect/revoke/delete must invalidate capability cache before UI reports completion.

### 6.1 Remote runtime egress boundary

Remote MCP와 hosted connector는 관리자 입력 URL을 곧바로 호출하지 않는다.

- 허용 scheme/port, TLS hostname 검증, explicit proxy policy를 manifest/install policy에서 고정한다.
- DNS 조회 결과와 실제 연결 IP를 모두 검사하고 redirect마다 다시 검증한다.
- loopback, private, link-local, multicast, cloud metadata IP는 기본 차단한다. self-host private network는 별도 trust class와 명시적 CIDR allow-list/관리자 경고가 있어야 한다.
- DNS rebinding을 막기 위해 resolution-to-connect binding을 유지하고 redirect target을 재평가한다.
- request/response body, timeout, redirect count, concurrency, decompression과 retry를 bounded하게 제한한다.
- runtime endpoint, resolved IP class, policy decision은 secret 없이 감사 가능해야 한다.

## 7. Product release slices

> 순서 정합: 기존 `research/12-agentic-work-os/03-first-party-plugin-repo-strategy.md`의 GitHub-first 구현·분리 전략이 현재 정본이다. 이번 문서는 Drive-first를 첫 제품 vertical 후보로 **제안**하며, 제품 오너 결정과 Accepted ADR이 기존 순서를 명시적으로 대체하기 전에는 builder queue를 재정렬하지 않는다.

### Slice A: Catalog shell and registry foundation

- catalog listing and manifest validation
- workspace install/update/revoke
- role/channel policy draft
- capability snapshot/audit
- no provider execution

### Slice B candidate: Google Drive product reference plugin

- per-user connection flow
- selected-file Picker/`drive.file`
- search/read/source citation
- upload/create approval and link result

### Slice C: GitHub and Notion

- GitHub official MCP or API adapter behind same capability contract
- Notion hosted MCP OAuth for interactive use; file upload API separately
- same source/approval/audit rendering

### Slice D: Custom and partner plugins

- private catalog
- signed manifest import
- remote/local MCP 또는 hosted connector outbound runtime
- signed webhook ingress trigger는 outbound executor와 분리
- admin review and trust warnings

## 8. Buildable issue candidates

These IDs are candidates. `momo-main` must reconcile them with existing MOMO-307/308/310/321/322 and assign actual GitHub numbers only after ADR acceptance.

| ID | Goal | Dependency | Surface |
|---|---|---|---|
| `SE-04A` | Plugin registry runtime + manifest validation + install/grant/revoke | ADR-0113, SE-02A | server/schema/runtime |
| `PP-01` | Plugin Center information architecture and static catalog fixtures | SE-04A contract | macOS/Core |
| `PP-02` | Workspace plugin install/update/revoke admin UX | SE-04A | macOS/server |
| `PP-03` | Member connection and channel enablement model | ADR-0113, SE-04A | server/Core |
| `GWS-01` | Google Drive selected-file OAuth/Picker connection | PP-03 | web/macOS/server |
| `GWS-02` | Drive source search/read/citation vertical | GWS-01, Context Broker | connector/server/client |
| `GWS-03` | Drive artifact upload + approval + link result | GWS-02, approval resume | connector/server/client |
| `PP-04` | Agent dynamic plugin discovery from Capability Cache | SE-02A, SE-04A | Context Broker/worker |
| `PP-05` | GitHub reference plugin | PP-04 | connector/runtime |
| `PP-06` | Notion reference plugin | PP-04 | connector/runtime |
| `PP-07` | Custom/private signed manifest import | SE-04A, ADR-0115 | admin/runtime |

## 9. Deferred decisions

- Hosted connector refresh-token custody and encryption key owner
- Official remote MCP proxy vs direct client OAuth
- plugin publisher signing and revocation authority
- catalog moderation/update rollback policy
- public/partner marketplace commercial terms
- arbitrary executable sandbox/WASM
- Gmail restricted-scope verification timing

이 항목은 Fable이 ADR-0113/SE-04A 상세 설계에서 option과 threat model로 확정한다.
