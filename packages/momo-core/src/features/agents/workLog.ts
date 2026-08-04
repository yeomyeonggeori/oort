import type {
  AgentPartialEvent,
  AgentPhaseWire,
  AgentProgressEvent,
  AgentRunStatusWire,
  AgentStatusEvent,
} from "../../lib/realtimeEvents";
import { eventTimeMs, isRunOver, turnStateOf } from "./agentRail";
import { IDLE_CUTOFF_MS, type AgentTurnState } from "./workingSignal";

// =============================================================================
// workLog — 「작업 패널」의 순수 절반 (goal WEB-WP1, 결정 정본
// docs/planning/2026-08-04-work-panel-design.md D1~D3).
//
// 파이프는 이미 있다. `agent.status`는 phase 전이를, `agent.partial`은
// `text_delta`(부분 텍스트)·`tool_call_*`(도구 단계)·`spent_micro_usd`(비용)를
// 나르는데, 지금까지 그 스트림을 소비하는 표면은 "작업 중" 헤드라인 한 줄
// (agentRail + workingSignal)뿐이었다. 이 모듈은 새 파이프를 뚫지 않고 그 같은
// 프레임을 run 하나짜리 진행 로그로 접는다.
//
// 왜 core에 있나: 웹은 우측 사이드 패널로, 폰은 시트로 같은 것을 그린다(D2).
// 접는 규칙이 두 벌이면 두 화면이 같은 run에 대해 다른 이야기를 하게 된다 —
// turnCopy·workingSignal이 이미 그 이유로 여기 있다. 여기 있는 것은 전부 평범한
// 값에 대한 평범한 함수라서 purity 게이트를 통과하고, 저장소(모듈 전역 맵,
// 구독, 타이머)는 플랫폼이 실제로 있는 클라이언트 쪽에 남는다.
//
// ## 저장하지 않는다 (D1 = 휘발 관전 v0)
//
// 이 로그는 앱 세션 메모리다. 서버에도, 디스크에도 남기지 않는다. 그래서 이
// 모듈이 절대 할 수 없는 말이 둘 있고, 둘 다 문장으로 만들어 두었다:
//
//   1. `truncatedHead` — run의 여는 프레임(`phase=queued`)을 보지 못한 채
//      붙었으면 이 run의 앞부분은 우리에게 없다. Centrifugo agent 네임스페이스는
//      24h·100프레임이고 웹 레일은 replay를 아예 버리므로(realtime.ts
//      subscribeAgent), 중간 진입은 예외가 아니라 기본값이다. "이 지점부터
//      관전"을 적는 근거가 이 플래그다.
//   2. `closed` — 종료 프레임을 실제로 본 run에만 채워진다. 게이트웨이 직송
//      경로에는 성공 종료 프레임이 없을 수 있고(#994 2R, 선존재 갭), 그럴 때
//      "완료"를 지어내는 대신 `workLogLiveness`가 TTL로 `signal_lost`를 답한다.
//      끝난 것을 못 봤다는 사실과 끝나지 않았다는 주장은 다른 것이다.
// =============================================================================

/** 로그가 붙어 있는 run 하나. */
export interface WorkLogTarget {
  runId: string;
  memberId: string;
  channelId: string;
}

/**
 * 한 항목이 로그에 들어간 순서. 스토어가 도착 순서대로 매기고, 그 뒤로는 절대
 * 바뀌지 않는다. 렌더는 이 값으로 정렬하지 `atMs`로 정렬하지 않는다: 서버 `ts`는
 * 같은 밀리초에 두 프레임이 찍히고(측정: 델타 간격이 1ms 아래로 내려간다) 정렬이
 * 안정적이지 않으면 부분 텍스트가 뒤바뀐 채로 읽힌다.
 */
export type WorkEntrySeq = number;

export interface WorkPhaseEntry {
  kind: "phase";
  seq: WorkEntrySeq;
  atMs: number;
  phase: AgentPhaseWire;
  runStatus: AgentRunStatusWire;
  /** 이 프레임이 run을 끝냈는가. */
  terminal: boolean;
}

export interface WorkTextEntry {
  kind: "text";
  seq: WorkEntrySeq;
  atMs: number;
  /** 도착 순서대로 이어 붙인 `text_delta`. */
  text: string;
  /** 앞부분이 글자 수 상한에 잘렸다. */
  clipped: boolean;
}

export interface WorkToolEntry {
  kind: "tool";
  seq: WorkEntrySeq;
  atMs: number;
  /** `tool_call_id`. 없으면 seq로 대신한다(같은 호출을 두 줄로 만들지 않으려고). */
  callId: string;
  name: string;
  /**
   * `tool_call_args`의 **필드 이름만**. 값은 이 타입에 들어오지 않는다.
   *
   * 설계 문서 §4는 "args는 접힘+명시 펼침(taste 규율)"이라고 적었지만, 실제
   * taste 규율(momo-design-taste-web §9)과 이 레포의 기존 계약
   * (`agentCardModel` 헤더: "tool arguments, execution paths, grants, payload
   * hashes and raw output stay OPAQUE, disclosure or not")은 더 엄격하다. 두
   * 문장이 충돌할 때 값을 내보내는 쪽을 고르면 되돌릴 수 없다: 경로와 프롬프트가
   * 스크린샷 한 장에 실려 나가고 나면 접어 둔 적이 있다는 사실은 아무 소용이
   * 없다. 그래서 v0는 엄격한 쪽을 쓰고, 경계는 성재가 정한다(PR 계획 이탈).
   *
   * 이름은 도구의 **스키마**이고 값은 사람의 데이터다. 이름까지 지우면 "도구를
   * 무엇에 대해 불렀는가"가 통째로 사라져서 이 패널의 목적이 없어지므로, 이름은
   * 남기고 값은 세어서 밝힌다 — `agentCardModel`의 `withheld`와 같은 모양이다.
   */
  argFields: readonly string[];
  /** 값을 표시하지 않은 인자의 개수. 0이면 인자가 없었다는 뜻이다. */
  argWithheld: number;
  /** 서버가 args를 잘라서 보냈다. */
  argsTruncated: boolean;
}

export type WorkEntry = WorkPhaseEntry | WorkTextEntry | WorkToolEntry;

/**
 * run 하나의 진행 로그. 불변 값이고, 접는 함수는 바뀐 게 없으면 같은 인스턴스를
 * 돌려준다(무의미한 리렌더를 부르지 않으려고).
 */
export interface WorkLog {
  runId: string;
  memberId: string;
  channelId: string;
  /** 작업 중인가, 사람의 결정을 기다리며 멈춰 있는가. `agent.status`만 정한다. */
  state: AgentTurnState;
  /** 마지막으로 관측된 phase/run_status. 상태 프레임을 하나도 못 봤으면 없다. */
  phase?: AgentPhaseWire;
  runStatus?: AgentRunStatusWire;
  entries: readonly WorkEntry[];
  /** run의 여는 프레임을 못 본 채 붙었다: 앞부분이 우리에게 없다. */
  truncatedHead: boolean;
  /** 상한에 밀려 앞에서 버린 항목 수. 조용히 자르지 않는다. */
  droppedEntries: number;
  /** 여는 프레임을 실제로 본 run에만 있다. 없으면 시계를 그리지 않는다. */
  startedAtMs?: number;
  /** 우리가 이 run을 보기 시작한 순간. "관전 시작"은 "시작"이 아니다. */
  watchedFromMs: number;
  lastActivityAtMs: number;
  /** 최신 비용 스냅샷. 누적 합이 아니라 서버가 마지막으로 말한 값이다. */
  spentMicroUsd?: number;
  /** 종료 프레임을 실제로 봤을 때만 채워진다. */
  closed?: {
    atMs: number;
    phase: AgentPhaseWire;
    runStatus: AgentRunStatusWire;
  };
  /** 다음 항목에 매길 번호. */
  nextSeq: WorkEntrySeq;
}

/**
 * 항목 수 상한. 긴 run은 도구 단계와 phase 전이가 계속 쌓이고, 델타는 하나의
 * 텍스트 블록으로 합쳐지므로 실제 증가는 단계 수에 비례한다. 상한을 넘으면
 * 앞에서 버리고 `droppedEntries`로 몇 개를 버렸는지 남긴다.
 */
export const WORK_LOG_MAX_ENTRIES = 200;

/**
 * 텍스트 블록 하나의 글자 수 상한. 넘으면 **뒤를 남기고 앞을 자른다**: 지금
 * 흐르고 있는 부분이 사람이 보고 있는 부분이다. 자른 블록은 `clipped`로 표시되고
 * 패널이 그 사실을 적는다.
 */
export const WORK_LOG_MAX_TEXT_CHARS = 4_000;

/** 관전을 막 시작한, 아직 아무 프레임도 접지 않은 로그. */
export function openWorkLog(target: WorkLogTarget, nowMs: number): WorkLog {
  return {
    runId: target.runId.toLowerCase(),
    memberId: target.memberId,
    channelId: target.channelId,
    // 상태 프레임을 보기 전의 기본값. `working`인 이유는 이 로그가 열리는 자리가
    // 이미 열린 턴(활동 줄·현재 작업)이기 때문이고, `승인 대기`로 바꾸는 것은
    // `agent.status`뿐이다(applyPartial과 같은 규칙).
    state: "working",
    entries: [],
    // 여는 프레임을 볼 때까지는 앞이 잘려 있다고 본다. 반대 기본값(다 봤다고
    // 가정)은 못 본 것을 봤다고 말하는 것이다.
    truncatedHead: true,
    droppedEntries: 0,
    watchedFromMs: nowMs,
    lastActivityAtMs: nowMs,
    nextSeq: 1,
  };
}

/**
 * run의 여는 프레임인가. agentRail의 같은 판정을 여기서 다시 쓴다: 그 파일은 이
 * 배치에서 소비 전용이라 export를 늘리지 않는다(핸드오프 패킷 §병렬 경계).
 * momowebqa 실측 — 여는 프레임은 `phase=queued, run_status=queued`로 온다.
 */
function isRunOpening(event: AgentStatusEvent): boolean {
  return (
    event.payload.phase === "queued" || event.payload.run_status === "queued"
  );
}

/**
 * 항목 하나를 꼬리에 붙이고, 상한을 넘으면 앞에서 버린다. 버린 개수를 함께
 * 돌려주는 이유는 조용한 절단을 만들지 않기 위해서다: 패널이 "앞의 N개 생략"을
 * 적을 수 있어야 남은 목록이 전부인 것처럼 읽히지 않는다.
 */
function pushEntry(
  base: readonly WorkEntry[],
  entry: WorkEntry
): { entries: WorkEntry[]; dropped: number } {
  const next = [...base, entry];
  if (next.length <= WORK_LOG_MAX_ENTRIES) return { entries: next, dropped: 0 };
  const overflow = next.length - WORK_LOG_MAX_ENTRIES;
  return { entries: next.slice(overflow), dropped: overflow };
}

/**
 * 프레임 하나를 로그에 접는다. 바뀐 게 없으면 같은 인스턴스를 돌려준다.
 *
 * agentRail의 `tooOldToProveLiveness`(도착 시점에 이미 TTL을 넘긴 프레임은
 * 살아있음을 증명하지 못한다)는 여기서 **적용하지 않는다**. 이유가 다르다:
 * 레일은 "지금 작업 중인가"를 판정하고, 이 로그는 "무슨 일이 있었는가"를 적는다.
 * 오래된 프레임도 일어난 일이고, 그것이 지금을 증명하는지는
 * `workLogLiveness`가 `lastActivityAtMs`로 따로 답한다.
 */
export function appendProgress(
  log: WorkLog,
  event: AgentProgressEvent,
  nowMs: number
): WorkLog {
  const runId = (event.payload.run_id ?? "").toLowerCase();
  if (runId === "" || runId !== log.runId) return log;
  return event.type === "agent.status"
    ? appendStatus(log, event, nowMs)
    : appendPartial(log, event, nowMs);
}

function appendStatus(
  log: WorkLog,
  event: AgentStatusEvent,
  nowMs: number
): WorkLog {
  const atMs = eventTimeMs(event, nowMs);
  const { phase, run_status: runStatus } = event.payload;
  const terminal = isRunOver(runStatus, phase);

  const opening = isRunOpening(event);
  // 여는 프레임을 첫 프레임으로 받았을 때만 앞이 온전하다. 이미 뭔가 접은 뒤에
  // 오는 queued 프레임은 다른 run의 재시작이거나 늦게 온 중복이고, 둘 다
  // "앞부분을 다 봤다"의 근거가 아니다.
  const headWhole = opening && log.entries.length === 0;

  // 같은 (phase, run_status) 쌍이 반복되는 keepalive는 줄을 늘리지 않는다.
  // 사람이 읽는 것은 전이이지 프레임 수가 아니다.
  const last = lastPhaseEntry(log);
  const changed =
    last === undefined || last.phase !== phase || last.runStatus !== runStatus;

  const spent = event.payload.spent_micro_usd;
  // 비용은 **온 프레임에만** 비교한다. `spent === log.spentMicroUsd`로 한 번에
  // 보면 비용을 실어 보내지 않은 프레임이 `undefined !== 1200`으로 언제나 "바뀐
  // 것"이 되어, 같은 인스턴스를 돌려준다는 계약이 첫 비용 프레임 이후로 죽는다.
  const costChanged = spent !== undefined && spent !== log.spentMicroUsd;

  // 이미 닫힌 run에 같은 종료 프레임이 다시 오면 "완료" 줄이 두 번 생긴다.
  // Centrifugo가 이 경로에서 재전달을 하는지는 실측하지 않았으므로, 값이 싼
  // 방어를 먼저 걸어 둔다.
  const redundantTerminal =
    terminal &&
    log.closed !== undefined &&
    log.closed.runStatus === runStatus &&
    log.closed.phase === phase;

  if ((!changed && !terminal) || redundantTerminal) {
    // 갱신할 것이 시각과 비용뿐이면 항목은 그대로 둔다.
    if (log.lastActivityAtMs >= atMs && !costChanged) return log;
    return {
      ...log,
      lastActivityAtMs: Math.max(log.lastActivityAtMs, atMs),
      ...(spent !== undefined ? { spentMicroUsd: spent } : {}),
    };
  }

  const pushed = pushEntry(log.entries, {
    kind: "phase",
    seq: log.nextSeq,
    atMs,
    phase,
    runStatus,
    terminal,
  });
  const startedAtMs = headWhole ? atMs : log.startedAtMs;

  return {
    ...log,
    // 종료 프레임은 상태를 바꾸지 않는다. 끝난 run에 "작업 중"도 "승인 대기"도
    // 붙일 수 없고, 그 사실은 `closed`가 말한다.
    state: terminal ? log.state : turnStateOf(runStatus),
    phase,
    runStatus,
    entries: pushed.entries,
    droppedEntries: log.droppedEntries + pushed.dropped,
    truncatedHead: headWhole ? false : log.truncatedHead,
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    lastActivityAtMs: Math.max(log.lastActivityAtMs, atMs),
    ...(spent !== undefined ? { spentMicroUsd: spent } : {}),
    ...(terminal ? { closed: { atMs, phase, runStatus } } : {}),
    nextSeq: log.nextSeq + 1,
  };
}

function lastPhaseEntry(log: WorkLog): WorkPhaseEntry | undefined {
  for (let i = log.entries.length - 1; i >= 0; i -= 1) {
    const entry = log.entries[i];
    if (entry.kind === "phase") return entry;
  }
  return undefined;
}

/**
 * 인자 페이로드에서 **이름과 개수만** 뽑는다. 값은 어떤 형태로도 밖으로 나가지
 * 않는다: 반환 타입에 값을 담을 자리가 없다는 것이 이 함수의 요점이다.
 *
 * 이름 목록에도 상한을 둔다. 도구가 수십 개의 키를 보내면 320px 열에 이름만으로
 * 화면이 덮이고, 잘린 사실은 `withheld`가 이미 세고 있으므로 조용한 절단이 아니다.
 */
function describeArgs(args: unknown): {
  fields: readonly string[];
  withheld: number;
} {
  if (args === undefined || args === null) return { fields: [], withheld: 0 };
  if (typeof args !== "object" || Array.isArray(args)) {
    // 객체가 아니면(문자열 프롬프트, 배열) 이름이랄 것이 없다. 하나로 센다.
    return { fields: [], withheld: 1 };
  }
  const keys = Object.keys(args as Record<string, unknown>);
  return {
    fields: keys.slice(0, WORK_LOG_MAX_ARG_FIELDS),
    withheld: keys.length,
  };
}

/** 이름을 적어 주는 인자 필드 수의 상한. 나머지는 `argWithheld`가 센다. */
export const WORK_LOG_MAX_ARG_FIELDS = 12;

function clipText(text: string): { text: string; clipped: boolean } {
  if (text.length <= WORK_LOG_MAX_TEXT_CHARS) return { text, clipped: false };
  return { text: text.slice(text.length - WORK_LOG_MAX_TEXT_CHARS), clipped: true };
}

function appendPartial(
  log: WorkLog,
  event: AgentPartialEvent,
  nowMs: number
): WorkLog {
  const atMs = eventTimeMs(event, nowMs);
  const payload = event.payload;
  let entries: readonly WorkEntry[] = log.entries;
  let touched = false;
  let dropped = log.droppedEntries;
  let nextSeq = log.nextSeq;

  const toolName = payload.tool_call_name;
  if (typeof toolName === "string" && toolName !== "") {
    const callId =
      typeof payload.tool_call_id === "string" && payload.tool_call_id !== ""
        ? payload.tool_call_id
        : `seq:${nextSeq}`;
    const existing = entries.findIndex(
      (entry) => entry.kind === "tool" && entry.callId === callId
    );
    const args = describeArgs(payload.tool_call_args);
    const tool: WorkToolEntry = {
      kind: "tool",
      // 같은 호출의 후속 프레임(args가 나중에 오는 경우)은 자리를 옮기지 않는다:
      // 순서는 도착 순서이고, 이미 자리를 잡은 단계가 뒤로 뛰면 그 위에 쌓인
      // 텍스트가 다른 단계의 것으로 읽힌다.
      seq: existing >= 0 ? entries[existing].seq : nextSeq,
      atMs,
      callId,
      name: toolName,
      argFields: args.fields,
      argWithheld: args.withheld,
      argsTruncated: payload.tool_call_args_truncated === true,
    };
    if (existing >= 0) {
      const copy = [...entries];
      copy[existing] = tool;
      entries = copy;
    } else {
      const pushed = pushEntry(entries, tool);
      entries = pushed.entries;
      dropped += pushed.dropped;
      nextSeq += 1;
    }
    touched = true;
  }

  const delta = payload.text_delta;
  const full = payload.text;
  // 델타는 **이어 붙고**, `text`는 **대체한다**. `text`는 워커가 보내는 "지금까지의
  // 전문"이라 이어 붙이면 문장이 두 배가 되고, 델타는 새 조각이라 대체하면 앞이
  // 사라진다. 둘 다 오면 델타를 쓴다(전문은 같은 내용을 한 번 더 말한 것뿐이다).
  const streamed =
    typeof delta === "string" && delta !== ""
      ? { text: delta, append: true }
      : typeof full === "string" && full !== ""
        ? { text: full, append: false }
        : undefined;

  if (streamed !== undefined) {
    const tail = entries[entries.length - 1];
    if (tail !== undefined && tail.kind === "text") {
      // 이 한 줄이 이 패널의 전부다: 도착 순서대로 붙이지 않으면 사람이 읽는
      // 문장이 뒤바뀐다(gate:work-panel의 red proof가 겨누는 자리).
      const merged = clipText(
        streamed.append ? tail.text + streamed.text : streamed.text
      );
      entries = [
        ...entries.slice(0, entries.length - 1),
        {
          ...tail,
          text: merged.text,
          clipped: (streamed.append && tail.clipped) || merged.clipped,
          atMs,
        },
      ];
    } else {
      const fresh = clipText(streamed.text);
      const pushed = pushEntry(entries, {
        kind: "text",
        seq: nextSeq,
        atMs,
        text: fresh.text,
        clipped: fresh.clipped,
      });
      entries = pushed.entries;
      dropped += pushed.dropped;
      nextSeq += 1;
    }
    touched = true;
  }

  const spent = payload.spent_micro_usd;
  // appendStatus와 같은 이유로 "온 값만" 비교한다(그렇지 않으면 비용을 싣지 않은
  // 모든 partial이 새 인스턴스를 만들어 패널을 매 프레임 리렌더한다).
  const costChanged = spent !== undefined && spent !== log.spentMicroUsd;
  if (!touched && log.lastActivityAtMs >= atMs && !costChanged) return log;

  return {
    ...log,
    // partial은 상태를 정하지 않는다. `run_status`는 `agent.status`에만 실리고,
    // 늦게 온 `tool_call_*` 하나가 승인 대기 중인 run을 작업 중으로 되돌리는 것이
    // agentRail이 막고 있는 바로 그 거짓말이다. 같은 규칙을 여기서도 지킨다.
    entries,
    droppedEntries: dropped,
    lastActivityAtMs: Math.max(log.lastActivityAtMs, atMs),
    ...(spent !== undefined ? { spentMicroUsd: spent } : {}),
    nextSeq,
  };
}

// ---- 지금 무엇이 참인가 -------------------------------------------------------

/**
 * 이 로그가 지금 무엇을 주장할 수 있는가.
 *
 *   - `closed`      종료 프레임을 **봤다**. 성공/실패/취소를 말해도 된다.
 *   - `signal_lost` 종료를 못 본 채 TTL(90s)을 넘겨 조용하다. "완료"가 아니라
 *                   "종료를 보지 못했다"가 참인 문장이다. 게이트웨이 직송 경로에
 *                   성공 종료 프레임이 없을 수 있다는 선존재 갭(#994 2R)이 이
 *                   분기를 상시 경로로 만든다.
 *   - `live`        최근에 프레임이 왔다.
 */
export type WorkLogLiveness = "live" | "signal_lost" | "closed";

export function workLogLiveness(
  log: WorkLog,
  nowMs: number,
  idleCutoffMs: number = IDLE_CUTOFF_MS
): WorkLogLiveness {
  if (log.closed !== undefined) return "closed";
  return nowMs - log.lastActivityAtMs > idleCutoffMs ? "signal_lost" : "live";
}

/**
 * 도구 단계가 지금 어떤 상태인가. 와이어에는 **도구 결과 프레임이 없다**(v0
 * 실측): 호출이 성공했는지 실패했는지 우리는 모른다. 그래서 말할 수 있는 것은 셋
 * 뿐이다.
 *
 *   - `running`  이게 마지막 항목이고 run이 아직 살아 있다.
 *   - `passed`   뒤에 다른 항목이 왔다. 다음 단계로 넘어갔다는 사실만 참이고,
 *                결과는 관측되지 않았다.
 *   - `unknown`  이게 마지막 항목인데 run이 끝났거나 신호가 끊겼다. 뒤에 아무것도
 *                오지 않았으므로 "다음 단계로 넘어갔다"는 **거짓**이고, 결과도
 *                모른다. 이 세 번째 상태가 없던 동안 신호가 끊긴 순간 실행 중이던
 *                호출이 "다음 단계로"로 표시됐다 — 이 모듈 머리말이 막겠다고 한
 *                거짓말("끝난 것을 못 봤다"와 "끝났다"를 섞는 것)이 한 층 아래에서
 *                재현된 것이다.
 */
export function toolEntryState(
  log: WorkLog,
  entry: WorkToolEntry,
  liveness: WorkLogLiveness
): "running" | "passed" | "unknown" {
  const isLast = log.entries[log.entries.length - 1]?.seq === entry.seq;
  if (!isLast) return "passed";
  return liveness === "live" ? "running" : "unknown";
}

// ---- 문장 (두 클라가 같은 말을 하도록 여기에 둔다) ------------------------------

/**
 * 앞부분이 없다는 고지. 설계 문서 §4의 "잘린 지점부터"의 실제 문장이다.
 *
 * "보관하지 않습니다"라고 쓰지 않는다: 서버는 24h·100프레임을 들고 있고(설계
 * 문서 §1) 클라이언트가 replay를 버리는 것뿐이라, 그 문장은 이 화면이 증명할 수
 * 없는 제품 전체에 대한 주장이 된다. 이 화면에 없다는 것만 참이다.
 */
export const WORK_LOG_TRUNCATED_HEAD_SENTENCE =
  "이 지점부터 관전합니다. 앞부분은 이 화면에 없습니다.";

/** 종료를 못 본 run. "완료"라고 쓰지 않는 자리다. */
export const WORK_LOG_SIGNAL_LOST_SENTENCE =
  "신호가 끊겼습니다. 종료를 보지 못했습니다.";

/** 패널을 닫으면 기록이 사라진다는 사실(D1). 숨기지 않고 적는다. */
export const WORK_LOG_VOLATILE_SENTENCE =
  "패널을 닫으면 이 기록은 사라집니다. 다시 열면 그 시점부터 다시 쌓입니다.";

/** 도구 인자는 접혀 있다는 사실. */
export const WORK_LOG_ARGS_FOLDED_LABEL = "호출 인자 보기";

/**
 * 값을 왜 안 보여 주는가. `AgentCard`의 같은 자리와 같은 말을 쓴다(design-taste
 * §9, ADR-0112 basic mode): 두 표면이 같은 정책에 대해 다른 문장을 쓰면 정책이
 * 두 개인 것처럼 읽힌다.
 */
export const WORK_LOG_ARGS_OPAQUE_SENTENCE =
  "도구 인자 값, 실행 경로, 자격증명은 표시하지 않습니다.";

/** 서버가 인자를 잘라 보냈다. */
export const WORK_LOG_ARGS_TRUNCATED_SENTENCE = "서버가 인자를 잘라 보냈습니다.";

/** 아직 아무 프레임도 못 받은 패널. `run`은 사람에게 쓰는 말이 아니다(§7). */
export const WORK_LOG_EMPTY_HEADLINE = "아직 도착한 진행이 없습니다.";
export const WORK_LOG_EMPTY_DETAIL =
  "이 턴에서 새 프레임이 오면 여기에 도착한 순서대로 쌓입니다.";

/**
 * 헤더에 적는 한 문장. 상태 어휘는 기존 경계를 그대로 쓴다(작업 중 = 열린 턴,
 * 승인 대기 ≠ 작업 중). 종료를 본 run만 종료 어휘를 받는다.
 */
export function workLogStateLabel(
  log: WorkLog,
  liveness: WorkLogLiveness
): string {
  if (liveness === "closed") {
    switch (log.closed?.runStatus) {
      case "succeeded":
        return "완료";
      case "failed":
        return "실패";
      case "cancelled":
        return "취소됨";
      case "timed_out":
        return "시간 초과";
      default:
        // phase가 done/error로 끝났지만 run_status가 아직 running인 경우.
        return log.closed?.phase === "error" ? "실패" : "종료";
    }
  }
  if (liveness === "signal_lost") return "신호 소실";
  return log.state === "awaiting_approval" ? "승인 대기" : "작업 중";
}

/** phase 전이 한 줄. 내부 어휘(`streaming`)를 그대로 내보내지 않는다. */
export function workPhaseLabel(entry: WorkPhaseEntry): string {
  if (entry.terminal) {
    switch (entry.runStatus) {
      case "succeeded":
        return "완료";
      case "failed":
        return "실패";
      case "cancelled":
        return "취소됨";
      case "timed_out":
        return "시간 초과";
      default:
        return entry.phase === "error" ? "실패" : "종료";
    }
  }
  if (entry.runStatus === "awaiting_approval") return "승인 대기";
  if (entry.runStatus === "paused") return "멈춤";
  switch (entry.phase) {
    case "queued":
      return "대기 중";
    case "thinking":
      return "생각 중";
    case "streaming":
      return "답을 쓰는 중";
    default:
      return "진행 중";
  }
}
