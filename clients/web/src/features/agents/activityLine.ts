import type { AgentWorkingSignal } from "./agentWorkingSignal";

// =============================================================================
// The composer activity line (AX-5 / MOMO-613, mac AgentWorkingComposerBar).
// Turning working signals into the lines a reader sees is pure, so the rotation
// order, the "no headline yet" wording and the reduced-motion collapse are all
// pinned by tests instead of being discovered on screen.
// =============================================================================

export interface AgentActivityLine {
  /** Stable identity for React and for the rotation index. */
  key: string;
  memberId: string;
  agentName: string;
  /** Agent-authored line; absent until the agent has streamed something. */
  headline?: string;
  /** Turn clock, absent when no run clock exists (typing fallback). */
  startedAtMs?: number;
}

/**
 * What follows the agent's name on the line. Split out because the name is
 * rendered in the agent token and the rest is not, so the component needs the
 * two halves while the tests need the whole sentence.
 */
export function activitySuffix(line: AgentActivityLine): string {
  return line.headline === undefined ? "이(가) 작업 중" : `: ${line.headline}`;
}

/** "{name}: {headline}", or a plain statement of the turn before one exists. */
export function activityText(line: AgentActivityLine): string {
  return `${line.agentName}${activitySuffix(line)}`;
}

function nameOf(
  signal: AgentWorkingSignal,
  displayNameFor: (memberId: string) => string | null | undefined
): string {
  const name = displayNameFor(signal.memberId);
  return name === null || name === undefined || name.trim() === ""
    ? "에이전트"
    : name;
}

/**
 * Every agent x headline pair, in signal order (oldest turn first). This is what
 * the bar rotates through: an agent that has streamed two distinct lines
 * contributes two, and an agent that has streamed nothing still contributes one
 * so a queued turn is stated rather than hidden.
 */
export function rotatingActivityLines(
  working: readonly AgentWorkingSignal[],
  displayNameFor: (memberId: string) => string | null | undefined
): AgentActivityLine[] {
  const out: AgentActivityLine[] = [];
  for (const signal of working) {
    const agentName = nameOf(signal, displayNameFor);
    const base = {
      memberId: signal.memberId,
      agentName,
      ...(signal.startedAtMs !== undefined
        ? { startedAtMs: signal.startedAtMs }
        : {}),
    };
    if (signal.headlines.length === 0) {
      out.push({ key: `${signal.memberId}|`, ...base });
      continue;
    }
    for (const headline of signal.headlines) {
      out.push({ key: `${signal.memberId}|${headline}`, ...base, headline });
    }
  }
  return out;
}

/**
 * One line per working agent, shown all at once. The reduced-motion form: the
 * content never mutates on its own, so nothing on screen moves without the
 * reader asking for it.
 */
export function staticActivityLines(
  working: readonly AgentWorkingSignal[],
  displayNameFor: (memberId: string) => string | null | undefined
): AgentActivityLine[] {
  return working.map((signal) => ({
    key: signal.memberId,
    memberId: signal.memberId,
    agentName: nameOf(signal, displayNameFor),
    ...(signal.headlines.length > 0 ? { headline: signal.headlines[0] } : {}),
    ...(signal.startedAtMs !== undefined
      ? { startedAtMs: signal.startedAtMs }
      : {}),
  }));
}
