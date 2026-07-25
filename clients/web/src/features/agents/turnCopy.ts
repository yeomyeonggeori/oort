import { particleFor } from "@/lib/koreanParticle";
import type { AgentTurnState, AgentWorkingSignal } from "./agentWorkingSignal";

// =============================================================================
// Every user-visible string the two agent-turn surfaces say (AX-5 / MOMO-613):
// the sidebar channel pill and the composer activity list. One module, because
// two copies of "what do we call this state" is exactly how a sidebar ends up
// claiming 작업 중 while the composer says 승인 대기 about the same turn.
//
// It is pure, so the wording is pinned by tests instead of discovered on
// screen: the Korean subject particle, the @handle a duplicate display name
// needs, and the refusal to print a clock for a turn whose start nobody saw.
// =============================================================================

/** How a member is named in a sentence. */
export interface AgentNameParts {
  name: string;
  /**
   * "@handle", present only when this roster holds more than one member under
   * `name`. The demo workspace really has two 김인턴 (the agent @kim-intern and
   * the human @intern-kim), so a line that drops this names nobody.
   */
  handle?: string;
}

export type AgentNameLookup = (memberId: string) => AgentNameParts;

/** The roster has not loaded yet: say so, do not invent a name. */
export const UNKNOWN_AGENT_NAME = "에이전트";

/** Composer lines shown at once before the rest become a count. */
export const MAX_ACTIVITY_LINES = 3;

export interface AgentActivityLine {
  /** Stable identity for React. */
  key: string;
  memberId: string;
  name: AgentNameParts;
  state: AgentTurnState;
  /** Agent-authored line; absent until the agent has streamed something. */
  headline?: string;
  /** Turn clock, absent when the run's opening frame was never observed. */
  startedAtMs?: number;
}

export interface AgentActivityList {
  lines: AgentActivityLine[];
  /** Agents past the cap: stated as a count, never silently dropped. */
  overflowCount: number;
  /** One sentence for the whole list, used as its accessible name. */
  summary: string;
}

/** "김인턴(@kim-intern)" where the handle decides, "Hermes" where it does not. */
export function agentLabel(parts: AgentNameParts): string {
  return parts.handle ? `${parts.name}(${parts.handle})` : parts.name;
}

/**
 * The label plus its subject particle. The particle is decided by the NAME, not
 * by the qualifier that follows it: "김인턴(@kim-intern)" ends in an ASCII "n"
 * that no Korean reader pronounces.
 */
export function agentLabelAsSubject(parts: AgentNameParts): string {
  return `${agentLabel(parts)}${particleFor(parts.name)}`;
}

/**
 * What follows the name on a composer line. Split out because the name is drawn
 * in the agent token and the rest is not, while the tests need the sentence.
 */
export function activitySuffix(line: AgentActivityLine): string {
  if (line.state === "awaiting_approval") {
    return `${particleFor(line.name.name)} 승인을 기다립니다`;
  }
  return line.headline === undefined
    ? `${particleFor(line.name.name)} 작업 중`
    : `: ${line.headline}`;
}

/** The whole line as one string (titles, tests, accessible names). */
export function activityText(line: AgentActivityLine): string {
  return `${agentLabel(line.name)}${activitySuffix(line)}`;
}

function lineFor(
  signal: AgentWorkingSignal,
  nameFor: AgentNameLookup
): AgentActivityLine {
  const name = nameFor(signal.memberId);
  return {
    key: signal.memberId,
    memberId: signal.memberId,
    name: name.name.trim() === "" ? { name: UNKNOWN_AGENT_NAME } : name,
    state: signal.state,
    // A turn parked on an approval carries no headline (the resolver already
    // strips it): the answer it is waiting on is a message in the timeline, and
    // repeating it as a status line stacks the composer on top of itself.
    ...(signal.state === "working" && signal.headlines.length > 0
      ? { headline: signal.headlines[0] }
      : {}),
    ...(signal.startedAtMs !== undefined
      ? { startedAtMs: signal.startedAtMs }
      : {}),
  };
}

/**
 * One line per open turn, oldest first, all shown at once.
 *
 * Deliberately NOT a rotation. Content that swaps itself every couple of
 * seconds is a perpetual loop (SKILL §4), it needs a pause control to satisfy
 * WCAG 2.2.2, and a "1/3" pager turns a work surface into a slideshow. Two or
 * three flat meta lines are denser, quieter, and readable at whatever speed the
 * reader has.
 */
export function activityLines(
  turns: readonly AgentWorkingSignal[],
  nameFor: AgentNameLookup,
  limit: number = MAX_ACTIVITY_LINES
): AgentActivityList {
  const lines = turns.slice(0, limit).map((signal) => lineFor(signal, nameFor));
  return {
    lines,
    overflowCount: Math.max(0, turns.length - lines.length),
    summary: turnSummary(turns, nameFor),
  };
}

/** Working turns lead: an agent that is running is what the reader waits on. */
function primary(turns: readonly AgentWorkingSignal[]): {
  state: AgentTurnState;
  shown: AgentWorkingSignal[];
} {
  const working = turns.filter((t) => t.state === "working");
  return working.length > 0
    ? { state: "working", shown: working }
    : { state: "awaiting_approval", shown: [...turns] };
}

/**
 * One sentence naming what is open in a channel, digits excluded on purpose:
 * this is an accessible name, and a name that changes once a second is re-read
 * once a second by some assistive tech.
 */
export function turnSummary(
  turns: readonly AgentWorkingSignal[],
  nameFor: AgentNameLookup
): string {
  if (turns.length === 0) return "";
  const { state, shown } = primary(turns);
  const verb = state === "working" ? "작업 중입니다" : "승인을 기다립니다";
  const head =
    shown.length === 1
      ? agentLabelAsSubject(nameFor(shown[0].memberId))
      : `에이전트 ${shown.length}명이`;
  const waiting = state === "working" ? turns.length - shown.length : 0;
  const tail =
    waiting > 0 ? ` 에이전트 ${waiting}명이 승인을 기다립니다.` : "";
  return `${head} ${verb}.${tail}`;
}

export interface AgentTurnBadgeCopy {
  /** Compact visible text: the state, in words, and nothing else. */
  text: string;
  /** The sentence assistive tech gets: who, how many, and what they are doing. */
  label: string;
}

/**
 * Sidebar channel-row pill (mac AgentWorkingChannelBadge): WHICH channels have
 * an open turn and WHAT state it is in. No digits at all.
 *
 * That is a measurement, not a preference. The sidebar is 240px with a 32px
 * workspace rail, so a channel row has ~74px for its name once a pill and an
 * unread badge are on it. "작업 중 46s" and "2명 작업 중" both measure ~73px and
 * leave 54px, which renders `general` as `gene…`: the row stops naming its own
 * channel to print a number that has no unit next to an unread count that also
 * has none. The word alone is ~53px and the name fits.
 *
 * The count and the per-turn clocks are not lost, they move to where there is
 * room for them: the composer activity list, which is the surface you are
 * looking at when the answer matters, plus this pill's accessible name.
 */
export function agentTurnBadgeCopy(
  turns: readonly AgentWorkingSignal[],
  nameFor: AgentNameLookup
): AgentTurnBadgeCopy | null {
  if (turns.length === 0) return null;
  const { state } = primary(turns);
  return {
    text: state === "working" ? "작업 중" : "승인 대기",
    label: turnSummary(turns, nameFor),
  };
}
