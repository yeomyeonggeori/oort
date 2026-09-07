# PLN-20260716-01 -> Fable Handoff: Plugin Platform and Google Drive Vertical Candidate

> Owner: `momo-main`
> Recipient: Fable engine planning session
> Status: proposal ready for engine refinement, no runtime implementation authorized
> UX file lock: do not modify `clients/macOS/**`

## 1. Why this exists

성재의 제품 요구는 Codex처럼 공식/커스텀 plugin을 검색·설치하고, Google Drive·Calendar·Gmail·GitHub·Notion을 사용자 승인으로 연결하며, 에이전트가 현재 허용된 plugin을 동적으로 사용하는 경험이다.

이 요구는 새 architecture가 아니라 기존 큐의 제품화다.

```text
ADR-0113 credential/capability/action boundary
  -> SE-02A Capability runtime
  -> SE-04A Plugin registry
  -> Google Drive reference vertical
  -> SE-04B signed webhook/custom runtime
```

## 2. Read first

1. `research/16-plugin-platform/00-plugin-ecosystem-research.md`
2. `research/16-plugin-platform/01-momo-plugin-platform-product-proposal.md`
3. `docs/planning/proposals/2026-07-14-superapp-engine-roadmap.md`
4. `research/12-agentic-work-os/02-plugin-manifest-v0.md`
5. `research/11-agent-runtime/06-capability-cache-v0.md`
6. `research/11-agent-runtime/04-context-packet-v0.md`
7. `research/11-agent-runtime/12-google-workspace-connector-v0.md`
8. `research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md`
9. `docs/adr/0001-agentic-work-os-repo-topology.md`

## 3. Existing invariants and proposed direction

### 3.1 Existing invariants

- Plugin is a workflow/capability package; MCP is one runtime adapter.
- Workspace install, member OAuth connection, channel enablement and capability grant are distinct states.
- Official, verified, custom/private and local-developer trust classes share the same ledger contract.
- Agent sees only currently granted and healthy tools through Context Packet `tool_grants`.
- All user-visible writes use oort REST -> Postgres -> outbox; direct provider result publication is forbidden.
- External write uses `tool_call -> approval_request -> same-run resume -> tool_result -> audit`.
- Google catalog listing is one `Google Workspace` plugin with separately grantable Drive/Calendar/Gmail bundles.
- Arbitrary in-process code installation is out of v0.

### 3.2 Product proposal requiring owner decision and Accepted ADR

- Google Workspace를 하나의 catalog listing으로 보여주고 Drive/Calendar/Gmail을 별도 capability bundle로 grant한다.
- Drive selected-file read/cite/upload/link를 첫 product reference vertical 후보로 둔다.
- 기존 GitHub-first 구현·repo 전략이 현재 정본이다. Drive-first로 구현 순서를 바꾸려면 옵션 비교, 성재 결정, Accepted ADR이 필요하다.

## 4. Security invariants

- No OAuth/provider credential in manifest, Context Packet, Memory Plane, Capability Cache, timeline or audit payload.
- No upstream token passthrough to remote MCP; bind tokens to their intended audience/resource.
- Revoke must invalidate grants/cache before UI reports success.
- Tool annotations from untrusted MCP servers cannot define oort risk/approval policy.
- Provider permissions remain authoritative; oort grants can only narrow them.
- Source permission is checked at retrieval and action execution, not only at install.
- Custom plugin manifest must be signed before installable state; unknown publisher defaults fail-closed.
- Gmail restricted scope is not part of the first reference build.
- Connection owner/provider subject, represented actor, delegator/grantor, and `via_token_id` must be bound and rechecked at projection, approval and execution. Without explicit delegation, actor equals connection subject.
- Remote runtime egress defaults deny private/link-local/metadata destinations and revalidates DNS, connect IP and every redirect. Private self-host access requires an explicit reviewed network policy.

## 5. Requested Fable outputs

### A. ADR-0113 options and recommendation

Decide credential custody by runtime class:

1. oort-hosted encrypted connector vault
2. provider-hosted/remote MCP delegated OAuth
3. user-owned agent host/BYOA credential custody
4. hybrid policy by plugin runtime

For each option include threat model, token rotation/revoke/delete, tenant isolation, audit redaction, key owner, backup/restore and self-hosted deployment impact.

### B. SE-04A implementation contract

Specify:

- orthogonal catalog/install/connection/channel/grant/health projections and their transition authorities
- suspended/revoked/expired/update-pending states; capability/scope diff and admin/member re-consent on widened updates
- tables and RLS ownership, without modifying `schema_v0.sql`
- manifest validation, publisher/signature/version rollback
- install/update/revoke idempotency
- Capability Cache projection and invalidation transaction
- admin/member/channel authorization matrix
- connection subject/actor/delegation identity binding and authoritative recheck points
- runtime adapter interface for hosted connector/remote MCP/local MCP/agent-host
- inbound signed webhook trigger vs outbound executor separation and compatibility with existing manifest runtime kinds
- remote endpoint SSRF/redirect/DNS-rebinding/TLS/body/timeout/concurrency negative gates
- audit events and secret-safe diagnostics
- local/runtime gates and fixtures

### C. Google Drive reference vertical

Define the minimal end-to-end build:

- explicit selected-file ID OAuth with `drive.file` + Picker; upload folder is a separate grant and recursive folder search is out unless separately scoped
- search/read/source citation
- artifact upload/create + approval + link result
- provider change/revoke/error reconciliation, including Drive create outcome-unknown handling via preallocated file ID or human confirmation
- self-hosted callback and redirect URI setup
- OAuth verification/manual operator steps

### D. Dynamic discovery

Define how Context Broker selects from Capability Cache without exposing the catalog or credentials. Include tool-list TTL, policy/capability version, health expiry, channel resource scope and deterministic invalidation.

### E. Reconciled buildable queue

Reconcile `SE-04A`, `SE-04B`, `PP-01..07`, `GWS-01..03` with existing MOMO-307/308/310/321/322. Do not reuse completed/conflicting IDs. Produce dependency order, acceptance, test profile, file ownership and merge sequence.

## 6. UX target for engine contracts

Engine design must make these UI states truthful:

- Plugin Center: Installed / Discover / Custom
- plugin detail: publisher trust, requested capabilities, data boundary, read/write/approval policy
- workspace installed but member connection required
- member connected but channel disabled
- agent can use plugin in this channel
- reconnect/revoke/policy blocked/degraded runtime
- approval card with target resource and source refs
- result card with provider link and audit id

Do not design UI files. Return state/event/API requirements to `momo-main`.

## 7. Questions requiring 성재 decision

1. Official hosted connectors의 refresh token을 Dawn-operated oort server가 보관하는 것을 허용할 것인가?
2. Self-hosted 배포에서 token vault key owner는 server admin인가, per-user Keychain인가, 외부 secret manager인가?
3. Google Workspace v0가 selected-file only로 시작해도 되는가, 아니면 broad Drive search가 필수인가?
4. Gmail restricted-scope 검증 비용을 v0에서 감수할 것인가?
5. Custom catalog는 private workspace import부터 시작할 것인가, public marketplace를 동시에 설계할 것인가?
6. Drive-first 제품 vertical과 GitHub-first repo split을 병행할 것인가, first-party 구현 순서 자체도 Drive-first로 변경할 것인가?

## 8. Definition of planning done

- ADR-0113 draft contains explicit options, recommendation and rejection reasons.
- SE-04A contract is builder-ready but no implementation issue is emitted before ADR acceptance.
- selected reference vertical options have concrete API/state/evidence flow; Drive-first is not builder-authorized until the owner/ADR decision.
- all secrets and OAuth ownership boundaries are explicit.
- file ownership avoids `clients/macOS/**` and active UX work.
- deviations from this handoff are listed rather than silently redesigned.
