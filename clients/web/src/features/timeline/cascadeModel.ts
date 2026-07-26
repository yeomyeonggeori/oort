import type { Message } from "@/lib/api";
import type { CascadeFallbackFrame } from "@/lib/realtime";

// =============================================================================
// Provider cascade notices (ADR-0135 D1 / MOMO-627). Pure: no DOM, no fetch, no
// React, so the dedupe rule and the copy are asserted by unit tests.
//
// The ADR's own words are the requirement: "전환은 기록한다 … 조용한 전환 금지 —
// 비용·거버넌스가 다른 경로로 흘렀음을 사용자가 안다." A turn served by the
// second provider costs a different budget and answers to a different account,
// so the row that shows it is not a diagnostic: it is the user-facing half of
// the audit rule.
//
// What this module deliberately does NOT do:
//   - it never claims a turn ran on the FIRST provider. The frame is the only
//     evidence a fallback happened, there is no REST history for it, and a
//     session that was not listening when a run fell over simply has nothing to
//     say. Absence of a notice is absence of evidence, so no card ever prints
//     "1차 프로바이더로 처리됨";
//   - it never prints an attempt-order number, and that is a correction, not a
//     preference. The frame carries wire POSITIONS (`from`/`to`), and a position
//     is NOT an attempt ordinal: a hop's position is its credential's identity,
//     so deleting a middle hop leaves a permanent gap on purpose (settings/
//     chainModel.ts rule 1). Position 2 is then the SECOND provider tried, and
//     `position + 1` would announce a "3차" that the 연결 순서 list does not
//     contain. The mapping that would fix it lives behind operator-only REST
//     (`GET /v1/provider/link/chain`, 403 for an ordinary member), so the
//     subject of the sentence is the endpoint label the worker publishes
//     instead: it needs no mapping to be true, and it is the same string the
//     operator reads in 설정 > AI 연결 and in the audit row.
//
// What it cannot do yet, and where that is disclosed: the frame is live-only.
// A reader who refreshes, or who opens the channel later, sees no row for a turn
// that really did fall over, and "no row" then looks like "no switch", which is
// the silent transition ADR-0135 D1 bans, arriving through the back door.
// Persisting it is ENGINE_HANDOFF X-15 and is not this client's to invent, so
// until it lands the limit is STATED, once, on the surface that governs the
// cascade: the `chain-record-scope` line in settings/AiLinkChain.tsx. Delete
// that line when X-15 makes it false, and not before.
// =============================================================================

/** One recorded transition: the cascade left `from` and was served by `to`. */
export interface CascadeFallback {
  /** Lower-cased run id. Server uuidStrings arrive UPPERCASE. */
  runId: string;
  from: number;
  to: number;
  /** Machine label from the worker, kept raw; `cascadeReasonLabel` translates. */
  reason: string;
  fromEndpointLabel: string;
  toEndpointLabel: string;
}

/** Recorded transitions per run, oldest hop first. */
export type CascadeByRun = ReadonlyMap<string, readonly CascadeFallback[]>;

export const EMPTY_CASCADE: CascadeByRun = new Map();

/**
 * A frame this client is willing to act on, or null.
 *
 * A frame with no run id is dropped rather than bucketed: the worker publishes
 * one when the fallback happened before a run row existed, and a notice with
 * nothing to attach to would either float free or be pinned to the wrong turn.
 */
export function parseCascadeFallback(
  frame: CascadeFallbackFrame
): CascadeFallback | null {
  const payload = frame.payload;
  const rawRunId = payload.run_id;
  if (typeof rawRunId !== "string" || rawRunId === "") return null;
  if (!Number.isInteger(payload.from) || !Number.isInteger(payload.to)) {
    return null;
  }
  // A cascade only ever moves forward. A frame that says otherwise is not a
  // transition this UI can describe, so it is dropped instead of reordered.
  if (payload.to <= payload.from) return null;
  return {
    runId: rawRunId.toLowerCase(),
    from: payload.from,
    to: payload.to,
    reason: payload.reason,
    fromEndpointLabel:
      typeof payload.from_endpoint_label === "string"
        ? payload.from_endpoint_label
        : "",
    toEndpointLabel:
      typeof payload.to_endpoint_label === "string"
        ? payload.to_endpoint_label
        : "",
  };
}

/** Identity of one transition. Matches the server's outbox idempotency key. */
export function cascadeKey(fallback: CascadeFallback): string {
  return `${fallback.runId}:${fallback.from}-${fallback.to}`;
}

/**
 * Fold one transition into the map, replacing rather than appending when the
 * same transition arrives twice.
 *
 * A reconnect replays the whole gap on the recoverable `ch:` namespace, so the
 * same fallback lands again on every resubscribe. Without this the card would
 * grow a second identical row for each reconnect, which reads as a second
 * fall-over that never happened.
 */
export function mergeCascadeFallback(
  current: CascadeByRun,
  fallback: CascadeFallback
): CascadeByRun {
  const existing = current.get(fallback.runId) ?? [];
  const key = cascadeKey(fallback);
  const kept = existing.filter((entry) => cascadeKey(entry) !== key);
  const next = [...kept, fallback].sort((a, b) => a.to - b.to);
  const map = new Map(current);
  map.set(fallback.runId, next);
  return map;
}

/** Transitions recorded for one run in this session, oldest hop first. */
export function cascadeFor(
  map: CascadeByRun,
  runId: string | null
): readonly CascadeFallback[] {
  if (runId === null || runId === "") return [];
  return map.get(runId.toLowerCase()) ?? [];
}

// ---- which row carries the notice -------------------------------------------

/**
 * A settled turn record, written once per run.
 *
 * There are TWO of them because there are two executors, and they mark
 * themselves differently:
 *
 *   gateway  `AgentGatewayRoutes.timelineProps` writes `schema` (plus
 *            `source: "hermes_gateway"`, `status`, `usage`).
 *   worker   `WorkerService.finalMessageProps` writes NO `schema` key at all:
 *            `{run_id, source, trigger_message_id, trigger_message_seq,
 *            author_member_id, source_attribution}`.
 *
 * Anchoring on the schema alone was the D1/F3 blocker of the 2026-07-26 merge
 * review, and it was not a near miss: `provider.cascade.fallback` is published
 * by the WORKER only, and the worker's claim excludes gateway jobs
 * (`AND method <> 'gateway'`, WorkerService.swift). A turn that fell over is
 * therefore, by construction, a turn that can never carry the gateway schema,
 * so the notice was structurally unrenderable on every row it exists for.
 */
const TURN_RECORD_SCHEMA = "momo.agent_gateway.timeline.v0";
const WORKER_TURN_RECORD_SOURCE = "agent_worker.final_text.v0";

/**
 * The run a message is the SETTLED RECORD of, or null.
 *
 * Deliberately narrower than "any message carrying run_id". One run writes an
 * approval request, tool rows and a turn record, and every one of them carries
 * the same `run_id`; keying the notice off that would print the same line three
 * times in one turn.
 *
 * The two accepted marks keep that property, and the evidence is the emitter,
 * not the ADR. The worker has exactly four `INSERT INTO message` sites and only
 * the final-text one writes `source: "agent_worker.final_text.v0"`:
 *
 *   approval request  `approvalRequestProps` — `approval_id` + `call_id`, and
 *                     no `source` key at all;
 *   tool result       `toolResultProps` — `call_id` + `approval_id` + an
 *                     `executor` key, again no `source`;
 *   loop-guard trip   `guardTripProps` — a `source`, but a DIFFERENT literal
 *                     (`agent_worker.loop_guard.v0`). Hence the exact
 *                     comparison below: a `startsWith("agent_worker.")` would
 *                     swallow the guard row and print the notice twice for a
 *                     run that tripped.
 *
 * One per run is also enforced below the client: the worker looks for an
 * existing `(run_id, author_member_id, type='text')` row and returns early if
 * it finds one, so the settled final-text row cannot be written twice.
 */
export function turnRecordRunId(message: Message): string | null {
  const props = message.props;
  if (!props) return null;
  const settled =
    props["schema"] === TURN_RECORD_SCHEMA ||
    props["source"] === WORKER_TURN_RECORD_SOURCE;
  if (!settled) return null;
  const runId = props["run_id"];
  return typeof runId === "string" && runId !== "" ? runId.toLowerCase() : null;
}

// ---- copy -------------------------------------------------------------------

/**
 * Who served the turn, as a noun phrase.
 *
 * The endpoint label, because it is the only identifier in the frame that is
 * true without a lookup (see the header). `to_endpoint_label` is
 * `AgentProviderValidation.redactedEndpointLabel`: host and port, never the
 * path, the query or the key. A frame that carries none is hedged rather than
 * numbered: "예비" says a fallback served the turn, which is exactly what is
 * known, where "2차" would be a guess about a list this surface cannot read.
 */
export function cascadeServedSubject(fallback: CascadeFallback): string {
  return fallback.toEndpointLabel === ""
    ? "예비 프로바이더"
    : `${fallback.toEndpointLabel} 프로바이더`;
}

/**
 * The worker's machine reason in plain Korean.
 *
 * `provider_status_<code>` is generated (`ProviderCascadeClassifier.decide`), so
 * it is matched by shape rather than enumerated. Anything unmapped is named as
 * the server's own report instead of being printed bare, which is the same rule
 * `providerTestMessage` already follows in settings.
 */
export function cascadeReasonLabel(reason: string): string {
  if (reason === "provider_unreachable") return "응답 없음";
  if (reason === "provider_rate_limited") return "요청 한도 초과";
  const status = /^provider_status_(\d{3})$/.exec(reason);
  if (status) return `서버 오류 ${status[1]}`;
  return `서버가 보고한 사유: ${reason}`;
}

/**
 * The one line the card carries.
 *
 * Single hop: "gateway.dawn.internal:8443 프로바이더로 처리됨 (응답 없음)". More
 * than one: the subject is still the provider that actually served the turn,
 * and the count says how many were tried and failed before it, because naming
 * only the survivor hides that two budgets were touched on the way.
 */
export function cascadeNoticeText(
  fallbacks: readonly CascadeFallback[]
): string | null {
  const last = fallbacks[fallbacks.length - 1];
  if (last === undefined) return null;
  const served = cascadeServedSubject(last);
  const reason = cascadeReasonLabel(last.reason);
  if (fallbacks.length === 1) {
    return `${served}로 처리됨 (${reason})`;
  }
  return `${served}로 처리됨 (전환 ${fallbacks.length}번, 마지막 사유: ${reason})`;
}

/**
 * Where the cascade started, for the muted half of the line.
 *
 * The headline already names where it ended, so this says the one thing it does
 * not: which provider the turn was supposed to run on. Labels only, which is
 * all the server sends: host and port, never the path, query or key. No space
 * before 에서, matching usageModel/Composer rather than the two older strings
 * that put one there.
 */
export function cascadeRouteText(
  fallbacks: readonly CascadeFallback[]
): string | null {
  const first = fallbacks[0];
  if (first === undefined || first.fromEndpointLabel === "") return null;
  return `${first.fromEndpointLabel}에서 넘어왔습니다`;
}
