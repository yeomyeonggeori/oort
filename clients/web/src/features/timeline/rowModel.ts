import type { Message } from "@/lib/api";
import {
  agentCardModel,
  cardKeepsBody,
  type AgentCardModel,
  type AgentTurnStatus,
} from "./agentCardModel";
import {
  artifactKeepsBody,
  resolveArtifact,
  type ArtifactPresentation,
} from "./artifacts";

// =============================================================================
// What one timeline row renders (MOMO-620 R1). Pure: no DOM, no React, so the
// precedence chain is asserted by unit tests instead of by reading MessageRow
// and hoping.
//
// It exists because the chain used to live inline in the row and got the most
// important case backwards. An artifact outranked the tool/turn card
// unconditionally, so a message that was FAILING or still STREAMING rendered as
// a finished diff: the status chip, the server's error note and the message
// body all disappeared, and what was left was a clean card with confident
// `+N −N` counters. That is a false story about an agent turn, which is the one
// thing ADR-0132 and design-taste-web §9 rule out.
//
// The chain now has three rules, in order:
//
//   1. An approval outranks everything. It carries the 승인/거부 action, and a
//      patch-shaped body must never demote it to a read-only diff.
//   2. An artifact outranks the tool/turn CARD, because a diff should read as a
//      diff and not as a tool result whose body happens to be a patch.
//   3. But the card's STATE never yields. Whatever the card knew about how the
//      turn is going rides along to the artifact card as `artifactState`, and
//      the artifact renders it as a chip plus a note. A settled success carries
//      no state, so the common case stays a calm diff card with no chrome.
// =============================================================================

/**
 * The turn state hoisted onto an artifact card. Present only when there is
 * something to say: a settled, successful, note-free card produces null, so an
 * ordinary diff does not grow a "완료" chip that means nothing.
 */
export interface ArtifactState {
  status: AgentTurnStatus;
  /** Server-sanitised failure or last-signal text, verbatim. */
  note?: string;
}

export interface RowPresentation {
  /** The agent card to render, or null when the artifact took the slot. */
  card: AgentCardModel | null;
  /** The artifact card to render, or null. */
  artifact: ArtifactPresentation | null;
  /** Turn state to show ON the artifact card. Null when there is none. */
  artifactState: ArtifactState | null;
  /** True when the plain message body still renders above the card. */
  keepsBody: boolean;
}

/**
 * Status values that mean the patch on screen is not the whole patch: the turn
 * had not finished producing it (queued/thinking/streaming/awaiting-approval)
 * or stopped producing it (stalled/cancelled). `error` is deliberately NOT in
 * this set: a failed run still sent a complete patch text, and the counts over
 * that text are exact even though applying it failed.
 */
const PROVISIONAL_STATUS: ReadonlySet<AgentTurnStatus> = new Set([
  "queued",
  "thinking",
  "streaming",
  "awaiting-approval",
  "stalled",
  "cancelled",
]);

/** True when the artifact body may still be incomplete. */
export function isProvisional(state: ArtifactState | null): boolean {
  return state !== null && PROVISIONAL_STATUS.has(state.status);
}

function stateFor(card: AgentCardModel | null): ArtifactState | null {
  if (card === null || card.kind === "approval") return null;
  const note = card.errorNote;
  // A finished run with nothing to report needs no chip: silence is the calm
  // default, and a chip that is always there stops being information.
  if (card.status === "done" && note === undefined) return null;
  return note === undefined ? { status: card.status } : { status: card.status, note };
}

/** Everything one row renders, decided once. */
export function rowPresentation(message: Message): RowPresentation {
  const card = agentCardModel(message);

  if (card?.kind === "approval") {
    return {
      card,
      artifact: null,
      artifactState: null,
      keepsBody: cardKeepsBody(card),
    };
  }

  const artifact = resolveArtifact(message);
  if (artifact === null) {
    return {
      card,
      artifact: null,
      artifactState: null,
      keepsBody: card === null || cardKeepsBody(card),
    };
  }

  return {
    card: null,
    artifact,
    artifactState: stateFor(card),
    keepsBody: artifactKeepsBody(message, artifact),
  };
}
