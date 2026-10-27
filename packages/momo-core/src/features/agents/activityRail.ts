import { elapsedSpan, runPhaseLabel } from "./runPhase";
import {
  RUN_STATUS_CLAIMED,
  RUN_STATUS_WORKING,
  type DoorbellFact,
} from "./runStatusLine";
import { isUncollected, type RoutineHint } from "./runWaiting";
import {
  agentLabel,
  turnHubSentence,
  UNKNOWN_AGENT_NAME,
  type AgentNameLookup,
  type AgentNameParts,
} from "./turnCopy";
import type { AgentTurnState, AgentWorkingSignal } from "./workingSignal";

// =============================================================================
// 입력창 레일: 「에이전트가 지금 일하는 중」의 **유일한** 실시간 자리 (#4619, #4577 권장 A).
//
//   grok · 작업 중 · 설계 문서 읽는 중      (한 에이전트)
//   grok +1                                  (둘 이상은 합친다)
//   grok · 승인 대기 +1                      (합친 줄을 이끄는 쪽이 사람을 기다리면 그 낱말을 남긴다)
//
// 레일은 입력창에 붙은 **높이가 예약된 한 줄**이고, 서고 사라지고 바뀌어도 타임라인을 밀지
// 않는다(높이는 표면의 몫, 글자는 이 모델의 몫). 그래서 이 줄의 글자는 **가만히 있어야** 한다:
//
//   - 초 단위 숫자가 없다. 분 단위 경과도 줄에는 없다 — 경과는 팝오버의 `detail`에서만, 1분 단위
//     (`elapsedSpan`)로 말한다. 매초 바뀌는 글자는 줄을 흔들고(폰 #4613) 보조기술을 초당 한 번
//     깨운다.
//   - 낱말은 `runPhase`·`runStatusLine` 어휘를 그대로 쓴다. 새로 정한 것은 두 낱말뿐이다:
//     「받음」(요청이 닿음)과 「깨움」(깨우는 신호가 닿음). 승인 대기·일시 정지는 `runPhaseLabel`의
//     것이다.
//   - 여럿이 일해도 줄은 하나다(Buzz의 `{첫 이름} +N`). 줄을 이끄는 쪽은 **사람을 기다리는**
//     에이전트(승인 대기)이고, 그다음이 일하는 쪽이다(`turnCopy`의 STATE_ORDER와 같은 이유: 일하는
//     에이전트는 읽는 사람에게 바라는 것이 없고, 승인에 선 에이전트는 읽는 사람 없이는 못 움직인다).
//     합친 줄에서도 `needsHuman`이 서므로 표면이 색으로 말할 수 있다.
//
// 「아직 받지 않았어요」 유예를 넘은 run은 레일에서 **빠진다**: 그 run은 `runException`이 타임라인 예외 줄로
// 말하고, 같은 run을 두 자리가 서로 다르게 말하지 않게 한다. 유예는 홈 카드·예외 줄·칩과 같은 함수
// (`runWaiting.isUncollected`)가 정한다. 끝난 run은 열린 턴이 아니므로 입력에
// 없다 — 그래서 끝나면 레일은 null이다.
// =============================================================================

export type RailPhase =
  | "received"
  | "woken"
  | "claimed"
  | "working"
  | "approval"
  | "paused";

/** 요청이 닿았다(아직 아무도 가져가지 않음). */
export const RAIL_WORD_RECEIVED = "받음";
/** 깨우는 신호가 닿았다(아직 아무도 가져가지 않음). */
export const RAIL_WORD_WOKEN = "깨움";

/** `runPhaseLabel`의 낱말을 phase만으로 얻는다: 승인 대기·일시 정지의 정본은 그쪽이다. */
function phaseWord(phase: "awaiting_approval" | "paused"): string {
  return runPhaseLabel({ phase, leaseState: "none", queuedAtMs: 0 });
}

export const RAIL_WORD: Readonly<Record<RailPhase, string>> = {
  received: RAIL_WORD_RECEIVED,
  woken: RAIL_WORD_WOKEN,
  claimed: RUN_STATUS_CLAIMED,
  working: RUN_STATUS_WORKING,
  approval: phaseWord("awaiting_approval"),
  paused: phaseWord("paused"),
};

/** 줄을 이끄는 순서(작을수록 앞): 사람을 기다리는 쪽이 먼저, 그다음 일이 진행된 쪽. */
const LEAD_RANK: Readonly<Record<RailPhase, number>> = {
  approval: 0,
  paused: 1,
  working: 2,
  claimed: 3,
  woken: 4,
  received: 5,
};

export interface RailAgent {
  /** React 키. */
  key: string;
  memberId: string;
  name: AgentNameParts;
  state: AgentTurnState;
  phase: RailPhase;
  /** 국면의 한 낱말(받음·깨움·가져감·작업 중·승인 대기·일시 정지). */
  word: string;
  /** 에이전트가 보고한 최근 단계. 작업 중에만 있다. */
  stage?: string;
  /** 지금 정말 일하는 중이다(점이 도는 조건): 작업 중, 또는 가져간 뒤 소식이 끊기지 않은 가져감. */
  active: boolean;
  /** 사람이 할 일이 있다(승인 대기). */
  needsHuman: boolean;
  /** 팝오버에만 쓰는 1분 단위 근거(「12분째」「3분 전에 가져감」). 1분 미만이거나 모르면 없다. */
  detail?: string;
  runId?: string;
  startedAtMs?: number;
  /** 이 에이전트의 서버 사실(보조기술 문장·행동이 읽는다). */
  server?: AgentWorkingSignal["server"];
}

export interface ActivityRail {
  /** 눈에 보이는 한 줄. 초 단위 숫자가 없다. 항상 `leadLabel`로 시작한다(표면이 이름만 따로 칠할 수 있게). */
  text: string;
  /** 이끄는 에이전트의 이름(같은 이름이 둘이면 핸들이 붙는다). */
  leadLabel: string;
  /** 줄을 이끄는 에이전트. */
  lead: RailAgent;
  /** 팝오버의 목록. 이끄는 쪽이 맨 앞이다. */
  agents: readonly RailAgent[];
  /** 합친 줄이면 이끄는 쪽 외의 수(「+N」). 한 에이전트면 0. */
  extra: number;
  /** 지금 정말 일하는 에이전트가 있다. */
  active: boolean;
  /** 사람이 할 일이 있는 에이전트가 있다. */
  needsHuman: boolean;
  /** 보조기술 이름: 모든 에이전트와 상태를 말한다. 숫자가 없다. */
  label: string;
}

export interface ActivityRailOptions {
  /** 「아직 받지 않았어요」 유예. 생략하면 `UNCOLLECTED_AFTER_MS`(5분). */
  graceMs?: number;
  /** 에이전트별 확인 박자(#4621). 모르면 undefined. */
  routineFor?: (memberId: string) => RoutineHint | undefined;
  /** run별 깨우는 신호 사실(원장). 모르면 undefined: 그 run은 「받음」으로 말한다. */
  doorbellFor?: (runId: string) => DoorbellFact | null | undefined;
}

function phaseOf(
  turn: AgentWorkingSignal,
  doorbell: DoorbellFact | null | undefined
): RailPhase {
  if (turn.state === "working") return "working";
  if (turn.state === "awaiting_approval") {
    return turn.server?.phase === "paused" ? "paused" : "approval";
  }
  if (turn.server?.phase === "claimed") return "claimed";
  // 깨우는 신호가 **닿았다**고 원장이 말할 때만 「깨움」이다. 닿지 않았으면 그것은 깨움이 아니다.
  return doorbell !== null && doorbell !== undefined && !doorbell.failed
    ? "woken"
    : "received";
}

/** 팝오버의 1분 단위 근거. 초 단위를 쓰는 낱말(`ongoingSpan`·`runWorkingText`)을 거치지 않는다. */
function detailOf(
  phase: RailPhase,
  turn: AgentWorkingSignal,
  nowMs: number
): string | undefined {
  const server = turn.server;
  switch (phase) {
    case "working": {
      const since = turn.startedAtMs ?? server?.startedAtMs;
      const span = since === undefined ? undefined : elapsedSpan(since, nowMs);
      return span === undefined ? undefined : `${span}째`;
    }
    case "claimed": {
      if (server?.leaseState === "stale") {
        const since = server.lastEventAtMs ?? server.claimedAtMs;
        const span = since === undefined ? undefined : elapsedSpan(since, nowMs);
        return span === undefined
          ? "가져간 뒤 소식이 없어요"
          : `가져간 뒤 ${span}째 소식이 없어요`;
      }
      const span =
        server?.claimedAtMs === undefined
          ? undefined
          : elapsedSpan(server.claimedAtMs, nowMs);
      return span === undefined ? undefined : `${span} 전에 가져감`;
    }
    case "received":
    case "woken": {
      const span =
        server === undefined ? undefined : elapsedSpan(server.queuedAtMs, nowMs);
      return span === undefined ? undefined : `${span}째 기다려요`;
    }
    default:
      return undefined;
  }
}

function railAgentOf(
  turn: AgentWorkingSignal,
  nameFor: AgentNameLookup,
  nowMs: number,
  options: ActivityRailOptions
): RailAgent {
  const raw = nameFor(turn.memberId);
  const name = raw.name.trim() === "" ? { name: UNKNOWN_AGENT_NAME } : raw;
  const doorbell =
    turn.runId === undefined ? undefined : options.doorbellFor?.(turn.runId);
  const phase = phaseOf(turn, doorbell);
  const headline = turn.headlines[0]?.trim() ?? "";
  const detail = detailOf(phase, turn, nowMs);
  const stale = turn.server?.leaseState === "stale";
  return {
    key: turn.memberId.toLowerCase(),
    memberId: turn.memberId,
    name,
    state: turn.state,
    phase,
    word: RAIL_WORD[phase],
    ...(phase === "working" && headline !== "" ? { stage: headline } : {}),
    active: phase === "working" || (phase === "claimed" && !stale),
    needsHuman: phase === "approval",
    ...(detail !== undefined ? { detail } : {}),
    ...(turn.runId !== undefined ? { runId: turn.runId } : {}),
    ...(turn.startedAtMs !== undefined ? { startedAtMs: turn.startedAtMs } : {}),
    ...(turn.server !== undefined ? { server: turn.server } : {}),
  };
}

/**
 * 한 채널의 열린 턴들 → 레일 한 줄. 줄에 올릴 에이전트가 없으면 null(레일은 비어 있는 채로 높이만
 * 지킨다).
 *
 * `turns`는 이미 채널로 걸러지고 에이전트마다 하나로 합쳐진 열린 턴이다(`agentTurnsInChannel` +
 * `applyApprovalWaits`). 폰도 같은 입력을 만든다.
 */
export function activityRail(
  turns: readonly AgentWorkingSignal[],
  nameFor: AgentNameLookup,
  nowMs: number,
  options: ActivityRailOptions = {}
): ActivityRail | null {
  const entries: { agent: RailAgent; order: number }[] = [];
  for (const turn of turns) {
    // 「아직 받지 않았어요」 유예를 넘은 run은 예외 줄이 말한다. 레일은 「일이 진행 중」만 말한다.
    if (
      isUncollected(
        turn.server,
        nowMs,
        options.routineFor?.(turn.memberId),
        options.graceMs
      )
    ) {
      continue;
    }
    entries.push({
      agent: railAgentOf(turn, nameFor, nowMs, options),
      order: turn.startedAtMs ?? Number.POSITIVE_INFINITY,
    });
  }
  if (entries.length === 0) return null;
  entries.sort(
    (a, b) =>
      LEAD_RANK[a.agent.phase] - LEAD_RANK[b.agent.phase] ||
      a.order - b.order ||
      a.agent.key.localeCompare(b.agent.key)
  );
  const agents = entries.map((entry) => entry.agent);
  const lead = agents[0]!;
  const extra = agents.length - 1;
  const leadName = agentLabel(lead.name);
  // 합친 줄은 이름과 수뿐이지만, 이끄는 쪽이 **사람을 기다리면**(승인 대기) 그 낱말을 남긴다: 레일이 사람 몫 상태를 올리려고 있는
  // 자리인데 합치면 그 신호가 색 하나로 줄어든다(design-review r1 M5, WCAG 1.4.1). 이끄는 순서가 승인 대기를 맨 앞에 두므로
  // 합친 줄의 낱말은 언제나 사람을 기다리는 쪽의 말이다.
  const text =
    extra > 0
      ? lead.needsHuman
        ? `${leadName} · ${lead.word} +${extra}`
        : `${leadName} +${extra}`
      : lead.stage !== undefined
        ? `${leadName} · ${lead.word} · ${lead.stage}`
        : `${leadName} · ${lead.word}`;
  return {
    text,
    leadLabel: leadName,
    lead,
    agents,
    extra,
    active: agents.some((agent) => agent.active),
    needsHuman: agents.some((agent) => agent.needsHuman),
    label: agents
      .map((agent) =>
        turnHubSentence(agentLabel(agent.name), agent.state, agent.server)
      )
      .join(" "),
  };
}
