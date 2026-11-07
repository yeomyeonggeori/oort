import { matchesExpressionContract } from "./contracts";
import type { ExpressionChanged, ExpressionChangedDetail, ExpressionVersion } from "./types";

/**
 * ADR-0218 §15 (#5491): what a client does with one change notice. Pure — the web store and the phone store
 * both call it, so the two screens take pictures down for the same reasons.
 *
 * Two notices travel the `expressions:ws…` rail for one change, the detail first and the plain
 * `expression.changed` (v1) right behind it. Neither one is trusted to arrive, or to arrive in order
 * (`history_size: 0`, a transient publish failure puts the first row back for a retry while the second goes out,
 * a second relay can interleave): every verdict below is safe under any order and under a lost notice.
 *
 *   · `revoke-all` — nothing says which picture changed (a v1 with no detail before it, a detail this client cannot
 *     read): take every picture down, as ADR-0218 D3 always said. This is the fail-safe and it is today's behaviour.
 *   · `revoke-ids` — the detail names the pictures that are no longer shown (`hidden`, `deleted`): take down exactly
 *     those, now. Every other picture stays on screen.
 *   · `keep-all` — a registration, an edit or a policy change took nothing down: leave every picture and read the list.
 *   · `already-handled` — the other notice of this same version already did the work.
 */
export type ExpressionNoticeVerdict =
  | { kind: "revoke-all" }
  | { kind: "revoke-ids"; ids: readonly string[] }
  | { kind: "keep-all" }
  | { kind: "already-handled" };

/** The versions this rail has already acted on (newest last), so the second notice of a version is skipped. */
export interface ExpressionNoticeState {
  handled: readonly ExpressionVersion[];
}
export const EXPRESSION_NOTICE_MEMORY = 64;
export const emptyExpressionNoticeState: ExpressionNoticeState = { handled: [] };

export interface ExpressionNoticeDecision {
  verdict: ExpressionNoticeVerdict;
  state: ExpressionNoticeState;
}

const remember = (state: ExpressionNoticeState, version: ExpressionVersion): ExpressionNoticeState => ({
  handled: [...state.handled, version].slice(-EXPRESSION_NOTICE_MEMORY),
});

/**
 * The detail frame of this workspace, or null. A frame that does not match the contract (an unknown action, a
 * `hidden` with no id, a version that is not a decimal string) is not a detail: the v1 behind it then acts alone.
 * The contract is open to fields it does not know — a later addition must never make this client drop the notice,
 * which is the mistake the v1 `Changed` (closed) forced this design to work around.
 */
export function readExpressionChangeDetail(workspaceId: string, data: unknown): ExpressionChangedDetail | null {
  if (!matchesExpressionContract("ChangedDetail", data)) return null;
  const detail = data as ExpressionChangedDetail;
  return detail.workspaceId.toLowerCase() === workspaceId.toLowerCase() ? detail : null;
}

/**
 * The `version` of a plain `expression.changed` frame that matches the contract exactly, or null. The phone reads that frame loosely
 * (`type` and `workspaceId` only, as it always has) and passes null when this says nothing: it is then acted on and not remembered.
 */
export function readExpressionChangedVersion(data: unknown): ExpressionVersion | null {
  return matchesExpressionContract("Changed", data) ? (data as ExpressionChanged).version : null;
}

/** A detail notice (`readExpressionChangeDetail` already checked it). */
export function decideExpressionDetail(state: ExpressionNoticeState, detail: ExpressionChangedDetail): ExpressionNoticeDecision {
  if (state.handled.includes(detail.version)) return { verdict: { kind: "already-handled" }, state };
  const next = remember(state, detail.version);
  if (detail.action === "hidden" || detail.action === "deleted") {
    // A hide or delete that names no picture cannot be narrowed: fall back to taking everything down.
    return { verdict: detail.expressionIds.length === 0 ? { kind: "revoke-all" } : { kind: "revoke-ids", ids: [...detail.expressionIds] }, state: next };
  }
  // `edited` never changes a picture's bytes (the image row is immutable, ADR-0218 D2) and a policy change touches none;
  // `applyExpressionList.evictImageIds` stays the last word on a picture whose `media` did change.
  return { verdict: { kind: "keep-all" }, state: next };
}

/**
 * A plain `expression.changed` (v1). `version` is null when the frame did not carry a readable one (the phone reads
 * only `type` and `workspaceId`, as it always has): it is acted on and not remembered.
 */
export function decideExpressionChanged(state: ExpressionNoticeState, version: ExpressionVersion | null): ExpressionNoticeDecision {
  if (version === null) return { verdict: { kind: "revoke-all" }, state };
  if (state.handled.includes(version)) return { verdict: { kind: "already-handled" }, state };
  return { verdict: { kind: "revoke-all" }, state: remember(state, version) };
}

/** The decisions above with their memory held. One per rail subscription; `reset()` on every (re)subscribe. */
export interface ExpressionNoticeGate {
  detail(detail: ExpressionChangedDetail): ExpressionNoticeVerdict;
  changed(version: ExpressionVersion | null): ExpressionNoticeVerdict;
  /** A fresh subscription or a full re-read starts over: a version seen before the gap says nothing about after it. */
  reset(): void;
}

export function createExpressionNoticeGate(): ExpressionNoticeGate {
  let state = emptyExpressionNoticeState;
  return {
    detail(detail) {
      const decision = decideExpressionDetail(state, detail);
      state = decision.state;
      return decision.verdict;
    },
    changed(version) {
      const decision = decideExpressionChanged(state, version);
      state = decision.state;
      return decision.verdict;
    },
    reset() {
      state = emptyExpressionNoticeState;
    },
  };
}
