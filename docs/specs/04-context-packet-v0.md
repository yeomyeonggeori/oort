# Context Packet v0 runtime contract

Status: normative runtime contract (MOMO-528, ADR-0129 D4)

The normative JSON vocabulary remains `research/11-agent-runtime/04-context-packet-v0.md`.
This document fixes the runtime/storage rules added by MOMO-528.

## Issuance and immutability

- The server issues `momo.context_packet.v0` only after the requesting member and
  target agent both pass current channel-membership checks.
- Each issue creates a new `context_packet` row. `content` is never updated.
- `packet_id`, `created_at`, and `expires_at` are frozen in `content` and match the
  row metadata. Expiry or a policy/visibility change requires a new packet; old
  packets remain inspectable as historical evidence.
- Worker and gateway jobs receive the same `context_packet`, `context_packet_id`,
  `memory_refs`, and `tool_grants`. Legacy payload fields remain additive aliases.

## Memory serving

`memory_refs` is bounded by the packet prompt budget. Profile memories are
considered first and are always injected when visible. Fact and episode memories
are assembled at query time from `memory_search_hybrid` top-k results.

Visibility is the union of:

1. the default workspace/requesting-member/target-agent scope, with every source
   channel still readable by the requesting member; and
2. an active `memory_visibility_grant` for either that member or target agent.

A revoked grant contributes no visibility. A valid explicit grant may expose an
item whose source channel is not otherwise readable; the packet records
`active_visibility_grant` as its permission snapshot.

## Capability serving

`tool_grants` is projected from active `plugin_capability_projection` rows joined
to an active delegated grant and enabled workspace install. No projection means
an empty array. Provider credentials and mock grants are forbidden.

## Inspection

`GET /v1/workspaces/{workspaceId}/context-packets/{packetId}` returns the frozen
row only when the caller is still an active member of the packet run's channel.
It reports expiry but does not mutate or refresh the historical packet.
