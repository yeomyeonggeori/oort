import { runBundleSnapshot, requestBundleState, REQUEST_BUNDLE_CHIP_KIND, type RequestBundleSnapshot } from "../timeline/requestBundle";
import type { AgentRunProgress, Message } from "../../lib/api";
import { turnRecordRunId } from "../timeline/cascadeModel";
import { RAIL_WORD } from "./activityRail";
import { UNCLAIMED_END_REASONS } from "./runException";
import { approvalEndState, isOpenRunPhase, REQUEST_WORD, runPhaseLabel, serverFactsOf } from "./runPhase";
import { isUncollected, UNCOLLECTED_WORD, type RoutineHint } from "./runWaiting";
import { agentLabel, turnHubSentence, type AgentNameLookup } from "./turnCopy";

// =============================================================================
// 트리거 메시지의 상태 칩 (#4619, #4577 권장 B).
//
// 에이전트를 부른 사람의 메시지 머리 줄(시각 옆)에 **크기가 고정된** 칩 하나가 선다:
//
//   받음 → 가져감 → 작업 중 → 답함 ✓      아직 받지 않았어요 !      시간 초과 ◷      실패 ✕      승인 대기
//
// 칩은 문장 행(「받았어요 → 깨우는 신호 보냄 → 가져감 → …」)의 자리를 대신한다. 한 낱말이라
// 행 높이가 변하지 않고, 상태가 바뀌어도 칩의 크기는 그대로다(크기는 표면의 몫, 낱말은 이 모델의
// 몫). 이 칩의 글자에도 **초 단위 숫자가 없다**: 경과는 말하지 않는다.
//
// 낱말은 레일(`activityRail`)과 같은 것이다. 레일은 채널 단위로 「지금 누가 일하나」를, 칩은
// 메시지 단위로 「내가 부른 일이 어디까지 갔나」를 말하고, 두 자리가 같은 상태를 다른 낱말로
// 부르지 않는다. 칩이 더 갖는 낱말은 끝난 뒤의 답함·실패·시간 초과와, 유예를 넘은 「아직 받지 않았어요」뿐이다
// (「아직 받지 않았어요」는 홈 카드·작업 패널·예외 줄과 같은 상수 `UNCOLLECTED_WORD`이고, 「시간 초과」·「신호 소실」은
// 같은 행의 예외 줄이 쓰는 `runPhaseLabel`의 낱말 그대로다).
//
// **서버가 일을 끝내지 못한 것(시간 초과·신호 소실)은 오류가 아니다**(ADR-0132: 부재를 오류로 올리지 않는다). 가져간 뒤
// 서버가 `timed_out`으로 끝낸 run은 경고 톤과 시계 표지로 말하고 위험 톤·가위표는 서버가 `failed`로 끝낸 것에만 쓴다. 신호 소실은
// 일을 끝내 놓고 소식만 끊긴 경우일 수 있어 「실패」는 거짓일 수 있고, 같은 행의 줄이 이미 구체 낱말로 말하므로 칩도 같은 말을 한다
// (교차 시험이 둘의 낱말을 함께 붙든다).
//
// 한 메시지가 여러 에이전트를 불렀으면 **가장 사람에게 급한 상태 하나**가 칩이 된다
// (실패 > 시간 초과 > 아직 받지 않았어요 > 승인 대기 > 작업 중 > 가져감 > 받음 > 답함). 하나라도 아직 일하는 중이면
// 「답함」이 아니다. 취소는 사람이 직접 한 일이라 알릴 새 소식이 아니므로 칩에 세지 않는다.
// =============================================================================

export type TriggerChipKind =
  | "received"
  | "claimed"
  | "working"
  | "approval"
  | "answered"
  | "uncollected"
  | "timed_out"
  | "failed"
  | "declined"
  | "expired";

/**
 * 칩 글자 곁의 표지. 모양이 뜻을 말한다(색에만 기대지 않는다): 점(작업 중)·체크(답함)·느낌표(아직 받지
 * 않았어요)·시계(시간 초과·신호 소실)·가위표(실패). 주의(아직 받지 않았어요·시간 초과)와 오류(실패)는 한때 같은
 * 느낌표였고 색만 달랐다 — 색을 못 보는 사람에게 같은 말이 되므로 실패에 자기 모양(가위표)을, 가져간 뒤 끝난
 * 것에 자기 모양(시계)을 줬다(아이콘만 남는 좁은 줄에서 「아직 받지 않았어요」와 「시간 초과」가 같은 글리프가 되지 않게).
 */
export type TriggerChipMark = "none" | "dot" | "check" | "alert" | "clock" | "cross" | "ban";

/** 칩 그릇의 톤. 표면이 토큰 클래스에 매긴다. */
export type TriggerChipTone = "muted" | "working" | "ok" | "warn" | "danger";

export const CHIP_WORD_ANSWERED = "답함";
/** 예외 줄·홈 카드·작업 패널과 **같은 낱말**이다(`runWaiting.UNCOLLECTED_WORD`). 교차 시험이 함께 붙든다. */
export const CHIP_WORD_UNCOLLECTED = UNCOLLECTED_WORD;
export const CHIP_WORD_FAILED = runPhaseLabel({
  phase: "failed",
  leaseState: "none",
  queuedAtMs: 0,
});
/** 가져간 뒤 서버가 시간 초과로 끝냈다. 예외 줄의 머리말과 **같은 함수의 같은 낱말**이다. */
export const CHIP_WORD_TIMED_OUT = runPhaseLabel({
  phase: "timed_out",
  leaseState: "none",
  queuedAtMs: 0,
});
/** 가져간 에이전트의 소식이 오래 끊겨 서버가 끝냈다(`lease_abandoned`). */
export const CHIP_WORD_SIGNAL_LOST = runPhaseLabel({
  phase: "timed_out",
  leaseState: "none",
  queuedAtMs: 0,
  endReason: "lease_abandoned",
});

/** 급한 순서(클수록 앞). */
const PRIORITY: Readonly<Record<TriggerChipKind, number>> = {
  failed: 9,
  expired: 8,
  declined: 7,
  timed_out: 6,
  uncollected: 5,
  approval: 4,
  working: 3,
  claimed: 2,
  received: 1,
  answered: 0,
};

const MARK: Readonly<Record<TriggerChipKind, TriggerChipMark>> = {
  received: "none",
  claimed: "none",
  working: "dot",
  approval: "none",
  answered: "check",
  uncollected: "alert",
  timed_out: "clock",
  failed: "cross",
  expired: "clock",
  declined: "ban",
};

/**
 * 칩이 입을 수 있는 (낱말, 표지) 조합 전부. 표면이 칩의 폭을 **가장 넓은 낱말에 맞춰 고정**할 때
 * 쓴다(낱말이 바뀌어도 칩의 크기가 변하지 않게). 승인 대기는 일시 정지 낱말도 입는다.
 */
export const TRIGGER_CHIP_FACES: readonly { word: string; mark: TriggerChipMark }[] = [
  { word: RAIL_WORD.received, mark: MARK.received },
  { word: RAIL_WORD.claimed, mark: MARK.claimed },
  { word: RAIL_WORD.working, mark: MARK.working },
  { word: RAIL_WORD.approval, mark: MARK.approval },
  { word: RAIL_WORD.paused, mark: MARK.approval },
  { word: CHIP_WORD_ANSWERED, mark: MARK.answered },
  { word: REQUEST_WORD.done, mark: MARK.answered },
  { word: REQUEST_WORD.expired, mark: MARK.expired },
  { word: REQUEST_WORD.declined, mark: MARK.declined },
  { word: CHIP_WORD_UNCOLLECTED, mark: MARK.uncollected },
  { word: CHIP_WORD_TIMED_OUT, mark: MARK.timed_out },
  { word: CHIP_WORD_SIGNAL_LOST, mark: MARK.timed_out },
  { word: CHIP_WORD_FAILED, mark: MARK.failed },
];

const TONE: Readonly<Record<TriggerChipKind, TriggerChipTone>> = {
  received: "muted",
  claimed: "muted",
  working: "working",
  approval: "warn",
  answered: "ok",
  uncollected: "warn",
  timed_out: "warn",
  failed: "danger",
  expired: "warn",
  declined: "muted",
};

/** 답 메시지 한 건: 이동에는 id와 seq가 함께 필요하다(`onJumpToMessage`). */
export interface AnswerRef {
  id: string;
  seq: number;
}

export interface TriggerChip {
  kind: TriggerChipKind;
  /** 칩의 한 낱말. */
  word: string;
  mark: TriggerChipMark;
  tone: TriggerChipTone;
  /** 보조기술 문장. 숫자가 없다. */
  label: string;
  /** 「답함」일 때, 누르면 가야 할 답 메시지. 모르면 없다(그러면 칩은 누르는 것이 아니다). */
  answer?: AnswerRef;
  /** 묶음 카드로 가는 닻. 말로 답한 메시지와 구분해요. */
  bundleTarget?: AnswerRef;
  /** 칩이 말하는 run들. */
  runIds: readonly string[];
}

export interface TriggerChipContext {
  /** 서버 읽기 확장이 아직 없는 표면도 카드의 공개 묶음을 건넬 수 있어요. */
  bundleFor?: (run: AgentRunProgress) => RequestBundleSnapshot | undefined;
  graceMs?: number;
  routineFor?: (memberId: string) => RoutineHint | undefined;
  /** 이 run의 답 메시지. 모르면 undefined. */
  answerFor?: (run: AgentRunProgress) => AnswerRef | undefined;
  bundleTargetFor?: (run: AgentRunProgress) => AnswerRef | undefined;
}

/** #4763의 DTO가 보존할 가산 bundle. API 트리 변경 없이도 읽는 자리예요. */
export type TriggerRunProgress = AgentRunProgress & { bundle?: unknown };
function bundleOf(run: TriggerRunProgress, context: TriggerChipContext): RequestBundleSnapshot | undefined {
  return context.bundleFor?.(run) ?? runBundleSnapshot(run);
}

function kindOf(
  run: AgentRunProgress,
  nowMs: number,
  context: TriggerChipContext
): TriggerChipKind | null {
  const bundle = bundleOf(run, context);
  if (bundle !== undefined) {
    const state = requestBundleState({ ...bundle, run, nowMs });
    // 전달·생존은 묶음 상태로 승격하지 않아요. 승인 종결만 그 낱말을 대체해요.
    if (!(run.phase === "timed_out" && !["declined", "expired", "cancelled"].includes(state)) &&
        !(["queued", "claimed"].includes(run.phase) && state === "thinking")) {
      return REQUEST_BUNDLE_CHIP_KIND[state];
    }
  }
  const approvalEnd = !isOpenRunPhase(run.phase) ? approvalEndState(run.endReason) : null;
  if (approvalEnd !== null) return approvalEnd;
  switch (run.phase) {
    case "queued":
      return isUncollected(
        serverFactsOf(run),
        nowMs,
        context.routineFor?.(run.agentMemberId),
        context.graceMs
      )
        ? "uncollected"
        : "received";
    case "claimed":
      return "claimed";
    case "running":
      return "working";
    case "awaiting_approval":
    case "paused":
      return "approval";
    case "succeeded":
      return "answered";
    case "failed":
      return "failed";
    case "timed_out":
      // 아무도 가져가지 않아 끝난 것은 열린 「아직 받지 않았어요」와 같은 낱말이고, 가져간 뒤의 것은 시간 초과·신호 소실이다.
      return run.endReason !== undefined && UNCLAIMED_END_REASONS.has(run.endReason)
        ? "uncollected"
        : "timed_out";
    case "cancelled":
      return null;
  }
}

function wordOf(kind: TriggerChipKind, run: AgentRunProgress, context: TriggerChipContext): string {
  switch (kind) {
    case "received":
      return RAIL_WORD.received;
    case "claimed":
      return RAIL_WORD.claimed;
    case "working":
      return RAIL_WORD.working;
    // 승인 대기와 일시 정지는 서버의 phase가 낱말을 정한다(`runPhaseLabel`).
    case "approval":
      return bundleOf(run, context) !== undefined ? REQUEST_WORD.approval : runPhaseLabel(serverFactsOf(run));
    case "answered":
      return bundleOf(run, context) !== undefined ? REQUEST_WORD.done : CHIP_WORD_ANSWERED;
    case "declined":
      return REQUEST_WORD.declined;
    case "expired":
      return REQUEST_WORD.expired;
    case "uncollected":
      return CHIP_WORD_UNCOLLECTED;
    case "timed_out":
      // 줄의 머리말(`runException`)과 같은 함수: 소식이 끊겨 끝난 것만 「신호 소실」이다.
      return runPhaseLabel(serverFactsOf(run));
    case "failed":
      return CHIP_WORD_FAILED;
  }
}

/** 칩 하나의 보조기술 문장. 이름들은 한 에이전트면 그 이름, 여럿이면 「이름 외 N명」이다. */
function labelOf(
  kind: TriggerChipKind,
  group: readonly AgentRunProgress[],
  nameFor: AgentNameLookup,
  context: TriggerChipContext
): string {
  const names: string[] = [];
  for (const run of group) {
    const label = agentLabel(nameFor(run.agentMemberId));
    if (!names.includes(label)) names.push(label);
  }
  const who =
    names.length > 1 ? `${names[0]} 외 ${names.length - 1}명` : (names[0] ?? "");
  const facts = serverFactsOf(group[0]!);
  switch (kind) {
    case "received":
      return turnHubSentence(who, "queued", { ...facts, phase: "queued" });
    case "claimed":
      return turnHubSentence(who, "queued", { ...facts, phase: "claimed" });
    case "working":
      return turnHubSentence(who, "working", facts);
    case "approval":
      return turnHubSentence(who, "awaiting_approval", facts);
    case "answered":
      return bundleOf(group[0]!, context) !== undefined ? `${who} 에이전트의 요청이 끝났어요.` : `${who} 에이전트가 답했어요.`;
    case "declined":
      return `${who} 에이전트의 요청이 거부됐어요.`;
    case "expired":
      return `${who} 에이전트의 요청이 만료됐어요.`;
    case "uncollected":
      return `${who} 에이전트가 요청을 가져가지 않았어요.`;
    case "timed_out":
      return `${who} 에이전트의 실행이 ${runPhaseLabel(facts)}로 끝났어요.`;
    case "failed":
      return `${who} 에이전트의 실행이 실패했어요.`;
  }
}

/**
 * 한 메시지가 일으킨 run들 → 칩 하나. 칩에 올릴 run이 없으면(run이 없거나 전부 취소) null이다.
 * `runs`는 먼저 생긴 것이 앞이다(`runsByTriggerMessage`).
 */
export function triggerChip(
  runs: readonly TriggerRunProgress[],
  nameFor: AgentNameLookup,
  nowMs: number,
  context: TriggerChipContext = {}
): TriggerChip | null {
  const classified: { run: AgentRunProgress; kind: TriggerChipKind }[] = [];
  for (const run of runs) {
    const kind = kindOf(run, nowMs, context);
    if (kind !== null) classified.push({ run, kind });
  }
  if (classified.length === 0) return null;
  let top = classified[0]!.kind;
  for (const entry of classified) {
    if (PRIORITY[entry.kind] > PRIORITY[top]) top = entry.kind;
  }
  const group = classified.filter((entry) => entry.kind === top).map((e) => e.run);
  const answer =
    top === "answered"
      ? group.map((run) => bundleOf(run, context) !== undefined ? context.bundleTargetFor?.(run) : context.answerFor?.(run)).find((ref) => ref !== undefined)
      : undefined;
  const bundleTarget = bundleOf(group[0]!, context) !== undefined ? context.bundleTargetFor?.(group[0]!) : undefined;
  return {
    kind: top,
    word: wordOf(top, group[0]!, context),
    mark: MARK[top],
    tone: TONE[top],
    label: labelOf(top, group, nameFor, context),
    ...(answer !== undefined ? { answer } : {}),
    ...(bundleTarget !== undefined ? { bundleTarget } : {}),
    runIds: group.map((run) => run.id),
  };
}

// ---- 「답함 ✓」 → 답 메시지 ----------------------------------------------------
//
// 답 메시지를 run과 잇는 길은 둘이다. 하나는 **정산된 턴 기록**(`props.run_id`,
// `turnRecordRunId`): 그 run이 쓴 최종 글 행이고 run id가 정확히 맞는다. 다른 하나는 **인용**
// (`replyToId`, ADR-0148 규칙 6): 에이전트의 최종 답은 자기를 부른 메시지를 가리킨다. 승인 만료·
// 멈춤 알림은 `props.answers_message_id`로 가리키지만 그것은 답이 아니라 알림이므로(서버가 인용을
// 달지 않는 이유가 그것이다) 여기서 찾지 않는다.
//
// 연결을 못 찾으면 undefined다: 칩은 「답함 ✓」을 말하되 누르는 것이 되지 않는다. 가짜 목적지를
// 지어내지 않는다.

export interface AnswerIndex {
  /** run id(소문자) → 정산된 턴 기록 행. */
  readonly byRun: ReadonlyMap<string, AnswerRef>;
  /** 「트리거 id|에이전트 id」(소문자) → 그 에이전트가 트리거를 인용해 쓴 첫 글. */
  readonly byQuote: ReadonlyMap<string, AnswerRef>;
}

/** 로드된 메시지(오래된 것이 앞)에서 답 후보를 한 번 색인한다. 먼저 쓰인 글이 이긴다. */
export function indexAnswers(messages: readonly Message[]): AnswerIndex {
  const byRun = new Map<string, AnswerRef>();
  const byQuote = new Map<string, AnswerRef>();
  for (const message of messages) {
    if (message.state === "deleted") continue;
    const ref = { id: message.id, seq: message.seq };
    const runId = turnRecordRunId(message);
    if (runId !== null && !byRun.has(runId)) byRun.set(runId, ref);
    if (message.type === "text" && message.replyToId !== undefined) {
      const key = `${message.replyToId.toLowerCase()}|${message.authorMemberId.toLowerCase()}`;
      if (!byQuote.has(key)) byQuote.set(key, ref);
    }
  }
  return { byRun, byQuote };
}

/** 이 run의 답 메시지. 모르면 undefined. */
export function answerMessageFor(
  index: AnswerIndex,
  run: Pick<AgentRunProgress, "id" | "agentMemberId" | "triggerMessageId">
): AnswerRef | undefined {
  const exact = index.byRun.get(run.id.toLowerCase());
  if (exact !== undefined) return exact;
  if (run.triggerMessageId === undefined) return undefined;
  return index.byQuote.get(
    `${run.triggerMessageId.toLowerCase()}|${run.agentMemberId.toLowerCase()}`
  );
}

/**
 * 목록이 한 번 계산해 행에 넘기는 지도: **끝난 run마다** 그 답 메시지(run id 소문자 → 답). 끝나지 않았거나 답을
 * 이을 길이 없는 run은 지도에 없다(칩은 「답함」을 말하되 눌리지 않는다).
 */
export function runAnswerMap(
  runs: readonly Pick<
    AgentRunProgress,
    "id" | "phase" | "agentMemberId" | "triggerMessageId"
  >[],
  messages: readonly Message[]
): ReadonlyMap<string, AnswerRef> {
  const index = indexAnswers(messages);
  const out = new Map<string, AnswerRef>();
  for (const run of runs) {
    if (run.phase !== "succeeded") continue;
    const answer = answerMessageFor(index, run);
    if (answer !== undefined) out.set(run.id.toLowerCase(), answer);
  }
  return out;
}
