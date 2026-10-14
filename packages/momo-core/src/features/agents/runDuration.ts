import type { ServerRunFacts } from "./workingSignal";

// =============================================================================
// runDuration: 한 run이 얼마나 걸렸는가를 사람의 말로 (#3824).
//
// 웹 작업 패널·컴포저 활동 줄·메시지 아래 상태 줄·폰 시트가 모두 이 모듈 하나로
// 시간을 말한다. 같은 run을 표면마다 다르게 재면 사람은 둘 중 하나를 거짓으로 읽는다.
//
// 구간은 셋이고, 모두 서버 시계의 사실로만 잰다.
//   대기  요청이 들어온 때(`queuedAtMs`) → 에이전트가 가져간 때(`claimedAtMs`)
//   작업  작업이 시작된 때(`startedAtMs`) → 끝난 때(`finishedAtMs`), 열려 있으면 지금
//   총    요청이 들어온 때 → 끝난 때
//
// 이 모듈이 절대 하지 않는 일: 없는 시각을 다른 시각으로 메우는 것. 시작 시각이 없는
// run의 작업 시간을 「가져간 때부터」로 세거나, 끝난 시각이 없는 run의 총 시간을
// 「지금까지」로 세지 않는다. 모르면 「모름」이라고 쓴다.
// =============================================================================

/** 모르는 구간의 낱말. 숫자를 지어내지 않는다. */
export const DURATION_UNKNOWN = "모름";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 끝난 구간의 길이(초까지 정확하게). 10분 아래는 초를 붙이고(「3분 12초」), 그
 * 위는 초를 버린다: 40분짜리 일의 「12초」는 읽는 사람이 쓸 데가 없는 숫자다.
 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  if (total < 1) return "1초 미만";
  if (total < 60) return `${total}초`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 10) return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`;
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}시간` : `${hours}시간 ${restMinutes}분`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}일` : `${days}일 ${restHours}시간`;
}

/**
 * 지금도 늘어나는 구간의 길이(한 단위만). 「12분째」「마지막 보고 1분 전」처럼 매초
 * 바뀌면 안 되는 자리에 쓴다. 1분 아래는 초로 말한다(「40초」).
 */
export function spanText(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < MINUTE) return durationText(clamped);
  if (clamped < HOUR) return `${Math.floor(clamped / MINUTE)}분`;
  if (clamped < DAY) return `${Math.floor(clamped / HOUR)}시간`;
  return `${Math.floor(clamped / DAY)}일`;
}

type DurationFacts = Pick<
  ServerRunFacts,
  "phase" | "queuedAtMs" | "claimedAtMs" | "startedAtMs" | "finishedAtMs"
>;

function isOpen(phase: ServerRunFacts["phase"]): boolean {
  return (
    phase === "queued" ||
    phase === "claimed" ||
    phase === "running" ||
    phase === "awaiting_approval" ||
    phase === "paused"
  );
}

export interface RunDurations {
  /** 대기 구간(ms). 모르면 undefined. 아직 대기 중이면 지금까지. */
  waitMs?: number;
  /** 작업 구간(ms). 모르면 undefined. 열려 있으면 지금까지. */
  workMs?: number;
  /** 요청부터 끝까지(ms). 끝난 run에만, 끝난 시각을 알 때만. */
  totalMs?: number;
  /** 아직 열려 있다: 대기·작업 구간이 지금도 늘어난다. */
  open: boolean;
}

/** 세 구간을 숫자로. 없는 시각은 다른 시각으로 메우지 않는다. */
export function runDurations(facts: DurationFacts, nowMs: number): RunDurations {
  const open = isOpen(facts.phase);
  const end = open ? nowMs : facts.finishedAtMs;
  let waitMs: number | undefined;
  if (facts.claimedAtMs !== undefined) {
    waitMs = facts.claimedAtMs - facts.queuedAtMs;
  } else if (facts.phase === "queued") {
    waitMs = nowMs - facts.queuedAtMs;
  } else if (!open && facts.startedAtMs === undefined && end !== undefined) {
    // 아무도 가져가지 않고 끝난 run(만료·취소): 끝날 때까지가 모두 대기였다.
    waitMs = end - facts.queuedAtMs;
  }
  const workMs =
    facts.startedAtMs !== undefined && end !== undefined
      ? end - facts.startedAtMs
      : undefined;
  const totalMs =
    !open && facts.finishedAtMs !== undefined
      ? facts.finishedAtMs - facts.queuedAtMs
      : undefined;
  return {
    ...(waitMs !== undefined ? { waitMs: Math.max(0, waitMs) } : {}),
    ...(workMs !== undefined ? { workMs: Math.max(0, workMs) } : {}),
    ...(totalMs !== undefined ? { totalMs: Math.max(0, totalMs) } : {}),
    open,
  };
}

export interface RunDurationSegment {
  key: "wait" | "work" | "total";
  label: "대기" | "작업" | "총";
  /** 「12초」「3분째」 또는 「모름」. */
  text: string;
}

/**
 * 「대기 12초 → 작업 3분 → 총 3분 12초」의 조각들. 아직 오지 않은 구간은 빠진다
 * (대기 중인 run에 「작업 모름」이라고 쓰면 무언가 잘못된 것처럼 읽힌다). 지나간
 * 구간인데 시각이 없으면 「모름」이다.
 */
export function runDurationSegments(
  facts: DurationFacts,
  nowMs: number
): RunDurationSegment[] {
  const d = runDurations(facts, nowMs);
  const segments: RunDurationSegment[] = [];
  const stillWaiting = facts.phase === "queued";
  const waitText =
    d.waitMs === undefined
      ? DURATION_UNKNOWN
      : stillWaiting
        ? `${spanText(d.waitMs)}째`
        : durationText(d.waitMs);
  segments.push({ key: "wait", label: "대기", text: waitText });
  if (stillWaiting) return segments;
  // 가져갔지만 아직 시작 전인 run에는 작업 구간이 아직 없다. 아무도 가져가지 않고
  // 끝난 run은 일한 적이 없다(「작업 모름」은 있지도 않은 일을 의심하게 만든다).
  const notStartedYet = facts.phase === "claimed" && facts.startedAtMs === undefined;
  const neverClaimed =
    !d.open && facts.claimedAtMs === undefined && facts.startedAtMs === undefined;
  if (!notStartedYet && !neverClaimed) {
    const workText =
      d.workMs === undefined
        ? DURATION_UNKNOWN
        : d.open
          ? `${spanText(d.workMs)}째`
          : durationText(d.workMs);
    segments.push({ key: "work", label: "작업", text: workText });
  }
  if (!d.open) {
    segments.push({
      key: "total",
      label: "총",
      text: d.totalMs === undefined ? DURATION_UNKNOWN : durationText(d.totalMs),
    });
  }
  return segments;
}

/** 조각들을 한 줄로: 「대기 12초 → 작업 3분 → 총 3분 12초」. */
export function runDurationBreakdown(facts: DurationFacts, nowMs: number): string {
  return runDurationSegments(facts, nowMs)
    .map((segment) => `${segment.label} ${segment.text}`)
    .join(" → ");
}

/**
 * 끝난 run 한 낱말: 「3분 12초 걸림」. 요청부터 결과까지(총)이다 — 사람이 기다린
 * 시간이 그것이다. 끝난 시각을 모르면 「걸린 시간 모름」.
 */
export function runTookText(facts: DurationFacts): string {
  if (facts.finishedAtMs === undefined) return `걸린 시간 ${DURATION_UNKNOWN}`;
  return `${durationText(facts.finishedAtMs - facts.queuedAtMs)} 걸림`;
}

/**
 * 작업 중인 run 한 줄: 「12분째 · 마지막 보고 1분 전」. 시작 시각을 모르면
 * 「작업 시간 모름」, 마지막 보고 시각을 모르면 「마지막 보고 모름」.
 */
export function runWorkingText(
  facts: Pick<ServerRunFacts, "startedAtMs" | "lastEventAtMs">,
  nowMs: number
): string {
  const working =
    facts.startedAtMs === undefined
      ? `작업 시간 ${DURATION_UNKNOWN}`
      : `${spanText(nowMs - facts.startedAtMs)}째`;
  const report =
    facts.lastEventAtMs === undefined
      ? `마지막 보고 ${DURATION_UNKNOWN}`
      : `마지막 보고 ${spanText(nowMs - facts.lastEventAtMs)} 전`;
  return `${working} · ${report}`;
}
