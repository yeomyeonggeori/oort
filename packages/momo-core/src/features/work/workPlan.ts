import { uuidEq, type WorkSession } from "../../lib/api";
import type { MessageService } from "../../i18n/types";
import type { SurfaceId } from "../capabilities/serverSurfaces";
import {
  sortSessions,
  workSessionStatus,
  type WorkPlanItem,
  type WorkSessionEvent,
} from "./workSessionModel";

// =============================================================================
// 대화 머리의 「계획 독」이 읽는 규칙 (#4578, 계획 이슈 #4577 A1). 화면은 **그리기만** 한다:
// 무엇을 세고 무엇을 강조하는지, 어떤 세션이 대상인지, 문장이 무엇인지는 전부 이 파일이다.
//
// ## 범위 (owner 2026-10-26 정정)
//
// 「진행 중인 작업을 보이는 부분」만이다: 작업 세션(ACP)이 알린 계획 한 가지. 변경·PR 아이콘과 오른쪽 탭
// 패널은 owner가 잘라냈고, 「모두 보기」는 **기존 화면**(작업 세션 패널의 세션 상세, 거기에 계획 칸이 이미
// 있다)으로 간다. 호스팅 에이전트 run에는 계획 종류가 없어(`stage` 이력만 있다) 「1 of 4」를 만들 수 없다:
// 그 자리는 ADR-0200 증보(#4580) 뒤에 같은 모양으로 채운다. 지금 대상은 **세션뿐**이다.
//
// ## 코어 타임라인 행 모델(#4654 `workTimeline`)과의 관계
//
// 독은 **진척 요약**이고 패널이 **타임라인**이다. 이 파일은 새 행 모델을 만들지 않는다: 입력은 세션이 이미
// 알리는 `WorkPlanItem[]`(`foldSessionEvents().plan`)이고 출력은 그 위의 합계다. `WorkTimelineRow`로 옮기지
// 않은 이유는 두 가지다. 행의 상태(`running | done | failed`)에 「대기」가 없어 「2 of 4」의 4를 잃고, 에이전트
// 계획 생산자(`plan` 행)는 #4657의 몫이라서다. #4657이 그 행을 만들면 이 합계는 같은 `WorkPlanItem`에서
// 계속 나온다.
//
// ## 정직하게 세는 것
//
// - **완료 수(`done`)만이 진척이다.** 「2 of 4」의 2는 끝난 단계 수다. 지금 단계 번호가 아니다.
// - **「지금 단계」는 돌고 있는 세션에서만 선다.** 서버가 `running`이라고 말하지 않는 세션(대기·끝남·호스트
//   끊김)의 `in_progress`는 마지막으로 알린 상태일 뿐이라 지금 하고 있다고 강조하지 않는다(`foldSessionEvents`가
//   「서버가 running이라고 하는 세션만 running 행을 갖는다」고 정한 것과 같은 규칙). 그 단계는 「대기」로 센다.
// - 계획이 비면(`[]`) 독은 서지 않는다(`workPlanProgress`가 null). 「0 of 0」은 어디에도 그려지지 않는다.
// - 계획 글은 호스트가 쓴 **믿지 않는 일반 텍스트**다. 공백을 한 칸으로 줄이고 상한에서 자른다. 텍스트 노드로만 그린다.
// =============================================================================

/**
 * 독이 서는 서버 표면. 세션도 계획도 작업 표면이 있는 서버·온라인 호스트가 있는 워크스페이스에만 있다
 * (작업 콘솔·관제와 같은 판정, #2780). 화면이 낱말을 직접 적지 않도록 코어가 이름을 갖는다.
 */
export const WORK_PLAN_SURFACE: SurfaceId = "work";

export type WorkPlanStepState = "done" | "current" | "pending";

export interface WorkPlanStep {
  content: string;
  state: WorkPlanStepState;
  /** 낱말 비교 없이 화면이 고르도록 불리언 짝을 둔다(`state`가 정본이고 둘은 늘 같은 말을 한다). */
  done: boolean;
  current: boolean;
}

export interface WorkPlanProgress {
  steps: readonly WorkPlanStep[];
  total: number;
  /** 끝난 단계 수. 「2 of 4」의 2. */
  done: number;
  /** 끝나지 않은 단계 수(남은 수 배지). */
  remaining: number;
  /** 모든 단계가 끝났다(체크). */
  allDone: boolean;
  /** 지금 단계로 강조할 단계가 있다(돌고 있는 세션의 `in_progress`). */
  hasCurrent: boolean;
  /** 세션이 지금 돌고 있다. 아니면 마지막으로 알린 계획이다. */
  live: boolean;
}

/** 호스트가 쓴 계획 한 줄을 화면에서 한 번 더 자르는 상한(투영은 계획을 50개까지만 싣는다). */
const MAX_STEP_CHARS = 120;

function stepText(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length <= MAX_STEP_CHARS ? text : `${chars.slice(0, MAX_STEP_CHARS).join("")}…`;
}

/** 서버가 지금 돌고 있다고 말하는 세션인가. 계획의 「지금 단계」를 세울 자격이다. */
export function isLivePlanSession(session: Pick<WorkSession, "status">): boolean {
  return session.status === "running";
}

/**
 * 계획 합계. 계획이 비면 null(독이 서지 않는다).
 *
 * `live`가 아니면 `in_progress`는 지금 단계가 아니라 **대기**다: 멈춘 세션의 마지막 상태를 지금 하는 일처럼
 * 강조하지 않는다.
 */
export function workPlanProgress(
  plan: readonly WorkPlanItem[],
  live: boolean
): WorkPlanProgress | null {
  if (plan.length === 0) return null;
  const steps: WorkPlanStep[] = plan.map((item) => {
    const state: WorkPlanStepState =
      item.status === "completed"
        ? "done"
        : item.status === "in_progress" && live
          ? "current"
          : "pending";
    return {
      content: stepText(item.content),
      state,
      done: state === "done",
      current: state === "current",
    };
  });
  const done = steps.filter((step) => step.done).length;
  return {
    steps,
    total: steps.length,
    done,
    remaining: steps.length - done,
    allDone: done === steps.length,
    hasCurrent: steps.some((step) => step.current),
    live,
  };
}

/**
 * 실시간 이벤트가 계획을 싣는가. 독은 **계획을 나르는 프레임만** 쌓는다: 글 조각(`agent.partial`)과 도구 줄은 한
 * 글자도 쓰지 않으므로, 머리에 상주하는 표면이 그것들을 받아 적지 않는다(`useAdeControl` 머리 주석과 같은 이유).
 */
export function carriesPlan(event: Pick<WorkSessionEvent, "type" | "payload">): boolean {
  return (
    event.type === "agent.status" &&
    Array.isArray(event.payload.plan) &&
    event.payload.plan.length > 0
  );
}

// ---- 대상: 이 대화에서 지금 돌거나 마지막으로 돈 세션 ----------------------------------

/**
 * 이 채널의 세션을 고르는 순서로: 돌고 있는 것이 먼저, 그다음 새것부터(`sortSessions`). 첫 번째가 독의
 * 기본 대상이다. 다른 채널의 세션은 이 독의 일이 아니다.
 */
export function planSessionsOf(
  sessions: readonly WorkSession[],
  channelId: string
): WorkSession[] {
  return sortSessions(sessions.filter((session) => uuidEq(session.channelId, channelId)));
}

/**
 * 사람이 고른 세션이 아직 목록에 있으면 그것, 아니면(고른 적 없음·사라짐) 첫 번째. 목록이 비면 null.
 * 고른 세션이 사라졌다고 빈 독을 세우지 않고 기본 대상으로 돌아간다.
 */
export function pickPlanSession(
  candidates: readonly WorkSession[],
  pickedId: string | null
): WorkSession | null {
  if (candidates.length === 0) return null;
  if (pickedId !== null) {
    const picked = candidates.find((session) => uuidEq(session.id, pickedId));
    if (picked !== undefined) return picked;
  }
  return candidates[0] ?? null;
}

/** 고르는 목록의 한 줄: 「이름 · 상태」. 상태 낱말은 작업 세션 패널과 같은 것(`workSessionStatus`)을 쓴다. */
export function workPlanSessionLabel(
  session: Pick<WorkSession, "label" | "tool" | "exitCode"> & { status: string }
): string {
  const name = session.label.trim() !== "" ? session.label.trim() : session.tool;
  return `${name} · ${workSessionStatus(session).label}`;
}

// ---- 문장: 모든 사용자 문구는 사전을 거친다 ------------------------------------------

type Format = MessageService["formatMessage"];

export interface WorkPlanCopy {
  /** 머리 단추의 접근성 이름이자 툴팁(둘이 같은 글이다). */
  button: string;
  /** 팝오버 머리: 「계획 · 4단계 중 2단계」. 다 끝나면 「계획 · 모두 마쳤어요」. */
  title: string;
  /** 단계 목록 밑의 정직한 한정 문장(0~2개). */
  notes: readonly string[];
  sessionLabel: string;
  openAll: string;
}

/**
 * @param maybeStale 세션 기록이 읽기 상한보다 길어 가장 새 계획을 못 읽었을 수 있다(이 화면이 아직 새 계획을
 *   실시간으로 받지 못한 경우). 그 사실을 한 줄로 말한다 — 낡은 합계를 확정처럼 두지 않는다.
 */
export function workPlanCopy(
  progress: WorkPlanProgress,
  options: { maybeStale: boolean },
  formatMessage: Format
): WorkPlanCopy {
  const counts = { total: progress.total, done: progress.done };
  const notes: string[] = [];
  if (!progress.live && !progress.allDone) notes.push(formatMessage("timeline.workPlan.notLive"));
  if (options.maybeStale) notes.push(formatMessage("timeline.workPlan.maybeStale"));
  return {
    button: progress.allDone
      ? formatMessage("timeline.workPlan.buttonDone", { total: progress.total })
      : formatMessage("timeline.workPlan.button", counts),
    title: progress.allDone
      ? formatMessage("timeline.workPlan.titleDone")
      : formatMessage("timeline.workPlan.title", counts),
    notes,
    sessionLabel: formatMessage("timeline.workPlan.sessionLabel"),
    openAll: formatMessage("timeline.workPlan.openAll"),
  };
}

/** 단계 하나를 보조기술이 읽는 낱말: 완료 · 지금 단계 · 대기. 색과 아이콘에만 기대지 않는다. */
export function workPlanStepWord(step: WorkPlanStep, formatMessage: Format): string {
  if (step.done) return formatMessage("timeline.workPlan.stepDone");
  if (step.current) return formatMessage("timeline.workPlan.stepCurrent");
  return formatMessage("timeline.workPlan.stepPending");
}
