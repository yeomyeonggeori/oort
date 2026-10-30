import { REQUEST_WORD } from "./runPhase";
import type { AgentLiveness } from "../../lib/api";
import { particleFor } from "../../lib/koreanParticle";
import { runPhaseDetail, runPhaseLabel } from "./runPhase";
import { isUncollected, queuedWaitCopy, UNCOLLECTED_WORD } from "./runWaiting";
import type {
  AgentTurnState,
  AgentWorkingSignal,
  ServerRunFacts,
} from "./workingSignal";

// =============================================================================
// Every user-visible string the agent-turn surfaces say (AX-5 / MOMO-613): the
// sidebar channel pill and the composer activity list on web, the 에이전트 tab
// row and the conversation activity line on the phone. One module, because two
// copies of "what do we call this state" is exactly how a sidebar ends up
// claiming 작업 중 while the composer says 승인 대기 about the same turn.
//
// It is pure, so the wording is pinned by tests instead of discovered on
// screen: the Korean subject particle, the @handle a duplicate display name
// needs, and the refusal to print a clock for a turn whose start nobody saw.
//
// ## Why it lives here (goal RN-T2)
//
// It was `clients/web/src/features/agents/turnCopy.ts` until the phone grew the
// same two surfaces. Every line of it is a plain function over plain values, so
// the RN-A1 move applies unchanged: the rules come to the core and the web file
// re-exports these names verbatim, so no caller had to move. The alternative
// was a second copy of the exact strings 작업 중 and 승인 대기 on the phone —
// the same defect this module was written to prevent, one client wider.
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

/**
 * What every turn surface says while the realtime rail is down.
 *
 * One constant across both clients and all five surfaces that use it — the web
 * badge's accessible name, the web composer's warn line, the phone's badge, the
 * phone's activity bar, and the phone's 에이전트 tab. It was a literal in three
 * of those until goal RN-T2 2R, which is the shape of drift this module exists
 * to prevent: a reader who HEARS one wording and SEES another has been told
 * about two different situations, and only one of them is real.
 *
 * It states both halves on purpose. "갱신이 멈췄습니다" is why the number stopped
 * moving; "마지막으로 확인된 상태입니다" is why what is still on screen is worth
 * reading rather than wrong.
 */
export const TURN_STALE_SENTENCE =
  "연결이 끊겨 갱신이 멈췄어요. 마지막으로 확인된 상태예요.";

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
  /** The server's own answer for this run (ADR-0200), when it gave one. */
  server?: ServerRunFacts;
  /**
   * The server's liveness answer for this agent (ADR-0200 D4), when the surface read
   * it: `undefined` = not read (yet), `null` = not a hosted agent. It only matters
   * for a run nobody has taken (`runWaiting`, #4285); every other line ignores it.
   */
  liveness?: AgentLiveness | null;
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
 * 에이전트가 요청을 가져가 답을 쓰는 중인 줄인가 (#4020). 대화 화면 컴포저 위의 줄이
 * 「답하는 중」이라고 말하는 조건이고, 점 애니메이션이 도는 조건이기도 하다.
 *
 * - 진행 보고가 있는 턴(`working`)이다.
 * - 또는 서버가 「가져감」이라 답한 run이고, 가져간 뒤 소식이 끊기지 않았다
 *   (`leaseState !== "stale"`). 소식이 끊긴 가져감에 점을 돌리면 아무도 일하지 않는 줄이
 *   일하는 것처럼 보인다.
 *
 * 대기 중(`queued`, 아직 아무도 가져가지 않음)과 승인 대기는 포함하지 않는다. 그 둘은
 * 「답하는 중」이 아니다: 에이전트가 쓰고 있지 않다.
 */
export function isRespondingLine(line: AgentActivityLine): boolean {
  if (line.state === "working") return true;
  return (
    line.state === "queued" &&
    line.server?.phase === "claimed" &&
    line.server.leaseState !== "stale"
  );
}

/**
 * What follows the name on a composer line. Split out because the name is drawn
 * in the agent token and the rest is not, while the tests need the sentence.
 *
 * 「답하는 중」은 대화 화면의 이 줄에만 쓰는 낱말이다(#4020, 성재 결재). 사이드바
 * 알약·작업 패널은 계속 「작업 중」이다. 줄임표는 이 문장에 없다: 화면이 점으로
 * 그리고(움직이거나, 동작 줄이기에서는 멈춘 채로), 보조기술은 문장만 읽는다.
 */
export function activitySuffix(line: AgentActivityLine, nowMs?: number): string {
  if (line.state === "awaiting_approval") {
    return `${particleFor(line.name.name)} 승인을 기다립니다`;
  }
  if (isRespondingLine(line)) {
    return `${particleFor(line.name.name)} 답하는 중`; // design-preflight-allow: 성재가 #4020에서 정한 문장(「grok이 답하는 중…」). 「명사 + 중」 규칙은 진행 라벨 자리용이고 이것은 주어가 있는 문장 조각이다.
  }
  // 사람이 부른 요청을 아무도 가져가지 않은 채 N분이 넘었다(`runWaiting`, #4285). 「대기 n번째」는
  // 곧 가져간다는 말로 읽힌다. 시계가 없는 호출(접근성 이름 등)은 기존 말 그대로다.
  if (nowMs !== undefined && line.state === "queued" && isUncollected(line.server, nowMs)) {
    return `: ${UNCOLLECTED_WORD}`;
  }
  // 아직 시작하지 않은 run에는 「작업 중」이라는 낱말을 쓰지 않는다(ADR-0200).
  // 서버가 말해 준 단계(대기 n번째·가져감)가 있으면 그대로, 없으면 대기 중이다.
  return line.server === undefined
    ? `${particleFor(line.name.name)} 대기 중`
    : `: ${runPhaseLabel(line.server)}`;
}

/**
 * 활동 줄 옆에 붙는 근거 한 줄(「11분째 기다려요 · 에이전트 앞에 2건」). 시간이 흐르면
 * 숫자가 바뀌므로 접근성 이름이 아니라 보이는 보조 글에만 쓴다. 에이전트가 보고한
 * 진행 단계(headline)는 이 줄 맨 앞에 선다: 「답하는 중」이라는 문장을 지키고, 단계는
 * 그 곁의 보조 글이다.
 */
export function activityDetail(
  line: AgentActivityLine,
  nowMs: number
): string | undefined {
  if (line.state === "awaiting_approval") return undefined;
  // 아직 아무도 가져가지 않은 사람 요청: 에이전트의 서버 생존 경고(D4)가 있으면 맨 앞에 서고,
  // 경과 시간이 그 뒤를 따른다. N을 넘었고 근거가 있으면 이유 한 문장이 끝에 붙는다(#4285).
  if (line.state === "queued") {
    const wait = queuedWaitCopy({
      facts: line.server,
      nowMs,
      liveness: line.liveness,
    });
    if (wait !== null) {
      const text = [wait.detail, wait.reason]
        .filter((piece): piece is string => piece !== undefined && piece !== "")
        .join(" · ");
      return text === "" ? undefined : text;
    }
  }
  const parts: string[] = [];
  if (line.headline !== undefined && line.headline !== "") parts.push(line.headline);
  const server =
    line.server === undefined ? undefined : runPhaseDetail(line.server, nowMs);
  if (server !== undefined) parts.push(server);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** The whole line as one string (titles, tests, accessible names). */
export function activityText(line: AgentActivityLine, nowMs?: number): string {
  return `${agentLabel(line.name)}${activitySuffix(line, nowMs)}`;
}

/** 에이전트의 서버 생존 판정을 찾는 함수. 읽지 않았으면 undefined, 호스티드가 아니면 null. */
export type AgentLivenessLookup = (
  memberId: string
) => AgentLiveness | null | undefined;

function lineFor(
  signal: AgentWorkingSignal,
  nameFor: AgentNameLookup,
  livenessFor?: AgentLivenessLookup
): AgentActivityLine {
  const name = nameFor(signal.memberId);
  const liveness = livenessFor?.(signal.memberId);
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
    ...(signal.server !== undefined ? { server: signal.server } : {}),
    ...(liveness !== undefined ? { liveness } : {}),
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
  limit: number = MAX_ACTIVITY_LINES,
  livenessFor?: AgentLivenessLookup
): AgentActivityList {
  const lines = turns
    .slice(0, limit)
    .map((signal) => lineFor(signal, nameFor, livenessFor));
  return {
    lines,
    overflowCount: Math.max(0, turns.length - lines.length),
    summary: turnSummary(turns, nameFor),
  };
}

/**
 * Which state leads: the one that is waiting on the READER.
 *
 * An agent that is running needs nothing from you; an agent parked on an
 * approval cannot move until you decide. So when a channel holds both, the lead
 * is the approval. This is the sidebar's whole job (a pill is how you learn
 * something happened in a channel you are not looking at), and letting 작업 중
 * win the single word would file the only actionable fact on the row under
 * "nothing to do here". The other state is not dropped, it becomes the second
 * sentence of the accessible name and the second line of the composer list.
 */
const STATE_ORDER: readonly AgentTurnState[] = [
  "awaiting_approval",
  "working",
  "queued",
];

function primary(turns: readonly AgentWorkingSignal[]): {
  state: AgentTurnState;
  shown: AgentWorkingSignal[];
} {
  for (const state of STATE_ORDER) {
    const shown = turns.filter((t) => t.state === state);
    if (shown.length > 0) return { state, shown };
  }
  return { state: "working", shown: [...turns] };
}

/** Third person plain, so it reads the same in a pill title and a sentence. */
function verbFor(state: AgentTurnState): string {
  switch (state) {
    case "working":
      return "작업 중입니다";
    case "queued":
      return "대기 중입니다";
    case "awaiting_approval":
      return "승인을 기다립니다";
  }
}

/**
 * One sentence naming what is open in a channel, digits excluded on purpose:
 * this is an accessible name, and a name that changes once a second is re-read
 * once a second by some assistive tech.
 *
 * Every state present is always stated. The lead sentence is whichever one the
 * pill is showing, so the word on screen and the first thing announced are the
 * same fact, and the remainder follows rather than disappearing.
 */
export function turnSummary(
  turns: readonly AgentWorkingSignal[],
  nameFor: AgentNameLookup
): string {
  if (turns.length === 0) return "";
  const { state, shown } = primary(turns);
  const head =
    shown.length === 1
      ? agentLabelAsSubject(nameFor(shown[0].memberId))
      : `에이전트 ${shown.length}명이`;
  const tails: string[] = [];
  for (const other of STATE_ORDER) {
    if (other === state) continue;
    const count = turns.filter((t) => t.state === other).length;
    if (count > 0) tails.push(`에이전트 ${count}명이 ${verbFor(other)}.`);
  }
  return [`${head} ${verbFor(state)}.`, ...tails].join(" ");
}

export interface AgentTurnBadgeCopy {
  /** Compact visible text: the state, in words, and nothing else. */
  text: string;
  /** The sentence assistive tech gets: who, how many, and what they are doing. */
  label: string;
  /**
   * Which state the word names, so the pill can carry the matching status color.
   * 승인 대기 is the one state on this row that a person has to act on, and a
   * word alone is a weak differentiator at 240px (SKILL §9: lifecycle chips use
   * the status tokens, text-first).
   */
  state: AgentTurnState;
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
  const { state, shown } = primary(turns);
  return {
    text: badgeWord(state, shown),
    label: turnSummary(turns, nameFor),
    state,
  };
}

/**
 * The pill's one word. A queued turn takes the server's own stage word when
 * exactly one run leads (「대기 2번째」·「가져감」); several runs, or a server that
 * did not say, read 「대기 중」.
 */
function badgeWord(
  state: AgentTurnState,
  shown: readonly AgentWorkingSignal[]
): string {
  switch (state) {
    case "working":
      return "작업 중";
    case "awaiting_approval":
      return REQUEST_WORD.approval;
    case "queued":
      return shown.length === 1 && shown[0].server !== undefined
        ? runPhaseLabel(shown[0].server)
        : "대기 중";
  }
}

/**
 * 한 턴의 한 낱말(허브 칩·사이드바 카드). 열린 턴 하나에 대해 알약과 같은 말을
 * 한다: 서버가 대기 순번이나 「가져감」을 알렸으면 그 낱말을 쓴다.
 */
export function turnWord(
  state: AgentTurnState,
  server?: ServerRunFacts
): string {
  if (state === "queued") {
    return server === undefined ? "대기 중" : runPhaseLabel(server);
  }
  return state === "working" ? "작업 중" : REQUEST_WORD.approval;
}

/** 허브 칩의 접근성 이름: 「<이름> 에이전트가 …요.」 */
export function turnHubSentence(
  agentName: string,
  state: AgentTurnState,
  server?: ServerRunFacts
): string {
  switch (state) {
    case "working":
      return `${agentName} 에이전트가 작업 중이에요.`;
    case "awaiting_approval":
      return `${agentName} 에이전트가 승인을 기다려요.`;
    case "queued":
      return server?.phase === "claimed"
        ? `${agentName} 에이전트가 일을 가져갔어요. 아직 보고는 없어요.`
        : `${agentName} 에이전트가 일을 아직 가져가지 않았어요.`;
  }
}
