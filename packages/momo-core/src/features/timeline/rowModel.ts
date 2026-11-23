import type { LocaleService } from "../../i18n/context";
import type { PlainMessageKey } from "../../i18n/keys";
import type { Message } from "../../lib/api";
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
import type { AuthorKind } from "./serverResultAuthor";

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

// ---- the sentence under the chip --------------------------------------------

/** Tone of the status note. Only a confirmed failure earns danger. */
export type ArtifactNoteTone = "muted" | "danger";

export interface ArtifactNote {
  text: string;
  tone: ArtifactNoteTone;
  /** A stream is still open, so the sentence carries the live caret. */
  live: boolean;
}

interface NoteCopy {
  sentence: PlainMessageKey;
  /**
   * How the server's note is introduced, or null when the note REPLACES the
   * sentence: on a failure the server's own reason is better copy than ours.
   */
  lead: PlainMessageKey | null;
  tone?: "danger";
  live?: true;
}

const IN_FLIGHT = "timeline.artifactNote.inFlight" satisfies PlainMessageKey;

/**
 * Copy per status, as a TOTAL map rather than an if/else chain.
 *
 * The chain is what shipped in R1 and it got the settled cases wrong: only
 * error/stalled/cancelled/awaiting-approval had a branch, so `done` and
 * `queued` fell into the in-flight else and a finished turn said "아직 받는
 * 중입니다" one line under its own green 완료 chip. The card contradicted
 * itself, and the accessible label contradicted the card again, because
 * `isProvisional("done")` is false so the counters read as final while the
 * sentence said they were still moving.
 *
 * A `Record<AgentTurnStatus, …>` cannot have that hole: adding a ninth status
 * to the vocabulary fails the type check here instead of silently inheriting
 * somebody else's sentence.
 *
 * Two rules the copy itself must keep, and rowModel.test.ts asserts both:
 *   - only a PROVISIONAL status may say the body is still arriving,
 *   - only `error` may carry the danger tone; silence is not failure
 *     (ADR-0132).
 */
const NOTE_COPY: Readonly<Record<AgentTurnStatus, NoteCopy>> = {
  queued: {
    sentence: "timeline.artifactNote.queued",
    lead: "timeline.artifactNote.leadNote",
  },
  thinking: { sentence: IN_FLIGHT, lead: "timeline.artifactNote.leadSignal", live: true },
  streaming: { sentence: IN_FLIGHT, lead: "timeline.artifactNote.leadSignal", live: true },
  "awaiting-approval": {
    sentence: "timeline.artifactNote.awaitingApproval",
    lead: "timeline.artifactNote.leadSignal",
  },
  done: {
    sentence: "timeline.artifactNote.done",
    lead: "timeline.artifactNote.leadNote",
  },
  error: {
    sentence: "timeline.artifactNote.error",
    lead: null,
    tone: "danger",
  },
  stalled: {
    sentence: "timeline.artifactNote.stalled",
    lead: "timeline.artifactNote.leadSignal",
  },
  cancelled: {
    sentence: "timeline.artifactNote.cancelled",
    lead: "timeline.artifactNote.leadSignal",
  },
};

/** What the artifact card says under the chip, for one turn state. */
export function artifactNote(
  formatMessage: LocaleService["formatMessage"],
  state: ArtifactState
): ArtifactNote {
  const copy = NOTE_COPY[state.status];
  let text = formatMessage(copy.sentence);
  if (state.note !== undefined) {
    text =
      copy.lead === null
        ? state.note
        : formatMessage("timeline.artifactNote.withNote", {
            sentence: text,
            lead: formatMessage(copy.lead),
            note: state.note,
          });
  }
  return { text, tone: copy.tone ?? "muted", live: copy.live === true };
}

function stateFor(card: AgentCardModel | null): ArtifactState | null {
  // 승인 카드와 로그인 핸드오프 카드에는 턴 상태가 없다. 둘 다 사람의 결정을
  // 기다리는 카드이고, 그 기다림은 `AgentTurnStatus` 의 축이 아니다. 완료 리포트도
  // 여기 든다: 끝난 일의 기록이라 자기 결과 어휘(`CompletionOutcome`)를 갖지,
  // `AgentTurnStatus` 로 아티팩트 칩을 물들이지 않는다.
  // 행동 결과 카드(ADR-0186 부록 B)도 여기 든다. 완료 리포트와 같은 이유다:
  // 끝난 일의 기록이라 자기 결과 어휘(`ActionResultStatus`)를 갖지,
  // `AgentTurnStatus` 로 아티팩트 칩을 물들이지 않는다.
  if (
    card === null ||
    card.kind === "approval" ||
    card.kind === "login_handoff" ||
    card.kind === "completion_report" ||
    card.kind === "action_result"
  ) {
    return null;
  }
  const note = card.errorNote;
  // A finished run with nothing to report needs no chip: silence is the calm
  // default, and a chip that is always there stops being information.
  if (card.status === "done" && note === undefined) return null;
  return note === undefined ? { status: card.status } : { status: card.status, note };
}

/**
 * Everything one row renders, decided once.
 *
 * `authorKind` is the author's member kind from the directory (`agentCardModel`): without
 * `"agent"` a turn record is plain prose and a diff carries no run-state chip (#5577).
 */
export function rowPresentation(
  message: Message,
  authorKind?: AuthorKind | null
): RowPresentation {
  const card = agentCardModel(message, authorKind);

  // 사람의 결정을 기다리는 카드는 아티팩트보다 앞선다. 로그인 핸드오프가 승인과
  // 같은 자리에 서는 이유도 같다: 이 행이 요구하는 것은 읽기가 아니라 결정이고,
  // 그 결정을 diff 뷰어가 덮으면 요구가 사라진다.
  if (card?.kind === "approval" || card?.kind === "login_handoff") {
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
