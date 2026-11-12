import type { AgentRunProgress } from "../../lib/api";
import { RAIL_WORD, railPhaseOf, type RailPhase } from "./activityRail";
import {
  elapsedParts,
  isOpenRunPhase,
  signalFromProgress,
  type ElapsedParts,
} from "./runPhase";
import { isUncollected } from "./runWaiting";
import { mergeAgentWorkingSignals, type AgentWorkingSignal } from "./workingSignal";

// =============================================================================
// 채널 멤버 패널의 에이전트 「지금」 한 줄 (#5686, ADR-0220 P4 ① 한 줄 상태 층).
//
//   grok     작업 중 · 설계 문서 읽는 중 [에이전트 보고] · 4분째
//   Hermes   작업 중 · 「배포 준비」 · 2분째            (단계를 못 알리는 에이전트: 요청 한 줄)
//   김인턴   승인 대기 · 「분기 회고 정리」 · 12분째 · +1
//
// 입력은 「지금 실행 중」 읽기(`fetchAllActiveAgentRuns`)의 행이다. 채널 진행 읽기(`…/progress`)는 호스팅
// 에이전트만 주므로 Hermes·관리형이 빠진다 — 이 판정은 **이 채널의 행만** 남기고 나머지는 버린다(다른 채널의
// 일은 제목·채널·수 모두 패널에 나오지 않는다).
//
// 낱말은 입력창 레일의 것을 그대로 쓴다(`railPhaseOf` + `RAIL_WORD`): 같은 run을 레일과 패널이 다른 낱말로
// 말하지 않는다. 레일처럼 「아직 받지 않았어요」 유예를 넘은 run은 빠진다(그 run은 대화 아래 예외 줄이 말한다,
// `runWaiting.isUncollected`).
//
// 한 에이전트에 안 끝난 run이 둘 이상이면 **보이는 국면은 레일의 합치기 규칙**(`mergeAgentWorkingSignals`:
// 작업 중 > 승인 대기 > 대기)이 정하고, 그 국면의 run 가운데 **가장 최근 것**(서버가 받은 시각)이 단계·요청·
// 경과를 준다. 나머지는 수(`extra`)로만 말한다. 「작업 중」인 에이전트가 방금 받은 다른 요청 때문에 「받음」으로
// 보이면 레일과 어긋나기 때문이다.
//
// 출처: 단계(`latestStage`)는 에이전트가 스스로 알린 글이라 표면이 「에이전트 보고」 표지를 단다(#4619,
// ADR-0200 증보 7 ①). 요청 한 줄(`triggerSummary`)은 사람이 쓴 작업 제목이나 부른 글의 앞부분이라 그 표지가
// 없다. 경과는 서버가 기록한 시각(`startedAtMs`, 아직 시작 전이면 `createdAtMs`)에서 **1분 단위로만** 잰다(초
// 숫자 없음, 1분 미만이면 경과 조각이 없다).
// =============================================================================

export interface ChannelAgentNow {
  memberId: string;
  /** 보이는 run. */
  runId: string;
  phase: RailPhase;
  /** 국면의 한 낱말(레일과 같다: 받음·깨움·가져감·작업 중·승인 대기·일시 정지). */
  word: string;
  /** 에이전트가 알린 최근 단계. 작업 중에만 있다. 「에이전트 보고」 표지와 함께 그린다. */
  stage?: string;
  /** 단계가 없을 때의 요청 한 줄(한 줄로 접은 글). 에이전트 보고가 아니다. */
  request?: string;
  /** 서버가 기록한 시각에서 잰 1분 단위 경과. 1분 미만이거나 모르면 없다. */
  elapsed?: ElapsedParts;
  /** 이 채널에서 이 에이전트의 다른 안 끝난 run 수(「+N」). */
  extra: number;
  /** 사람이 할 일이 있다(승인 대기). */
  needsHuman: boolean;
  /** 지금 정말 일하는 중이다(레일의 `active`와 같은 조건). */
  active: boolean;
}

export interface ChannelAgentNowOptions {
  /** 「아직 받지 않았어요」 유예. 생략하면 레일과 같은 기본값(5분). */
  graceMs?: number;
}

interface Entry {
  run: AgentRunProgress;
  signal: AgentWorkingSignal;
}

/** 요청 한 줄: 여러 줄·연속 공백을 한 칸으로. 빈 글은 없음. */
function requestLine(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const line = summary.replace(/\s+/g, " ").trim();
  return line === "" ? undefined : line;
}

/** 같은 국면의 run 가운데 가장 최근 것(서버가 받은 시각, 같으면 id). */
function newest(entries: readonly Entry[]): Entry {
  return entries.reduce((best, entry) =>
    entry.run.createdAtMs > best.run.createdAtMs ||
    (entry.run.createdAtMs === best.run.createdAtMs && entry.run.id > best.run.id)
      ? entry
      : best
  );
}

function lineOf(bucket: readonly Entry[], nowMs: number): ChannelAgentNow {
  const merged = mergeAgentWorkingSignals(bucket.map((entry) => entry.signal));
  const state = merged?.state ?? bucket[0]!.signal.state;
  const shown = newest(bucket.filter((entry) => entry.signal.state === state));
  const phase = railPhaseOf(shown.signal, undefined);
  const headline = shown.signal.headlines[0]?.trim() ?? "";
  const stage = phase === "working" && headline !== "" ? headline : undefined;
  const request = stage === undefined ? requestLine(shown.run.triggerSummary) : undefined;
  const elapsed = elapsedParts(shown.run.startedAtMs ?? shown.run.createdAtMs, nowMs);
  return {
    memberId: shown.run.agentMemberId,
    runId: shown.run.id,
    phase,
    word: RAIL_WORD[phase],
    ...(stage !== undefined ? { stage } : {}),
    ...(request !== undefined ? { request } : {}),
    ...(elapsed !== undefined ? { elapsed } : {}),
    extra: bucket.length - 1,
    needsHuman: phase === "approval",
    active:
      phase === "working" || (phase === "claimed" && shown.run.leaseState !== "stale"),
  };
}

/**
 * 「지금 실행 중」 행 → 이 채널 에이전트들의 한 줄(에이전트 id 소문자 → 줄). 이 채널에 안 끝난 run이 없는
 * 에이전트는 들어 있지 않다.
 */
export function channelAgentNow(
  runs: readonly AgentRunProgress[],
  channelId: string,
  nowMs: number,
  options: ChannelAgentNowOptions = {}
): Map<string, ChannelAgentNow> {
  const channel = channelId.toLowerCase();
  const byAgent = new Map<string, Entry[]>();
  for (const run of runs) {
    if (run.channelId.toLowerCase() !== channel) continue;
    if (!isOpenRunPhase(run.phase)) continue;
    const signal = signalFromProgress(run);
    if (signal === null) continue;
    if (isUncollected(signal.server, nowMs, undefined, options.graceMs)) continue;
    const key = run.agentMemberId.toLowerCase();
    const bucket = byAgent.get(key);
    if (bucket === undefined) byAgent.set(key, [{ run, signal }]);
    else bucket.push({ run, signal });
  }
  const out = new Map<string, ChannelAgentNow>();
  for (const [key, bucket] of byAgent) out.set(key, lineOf(bucket, nowMs));
  return out;
}
