import type {
  AgentRunProgress,
  ApprovalDecisionMode,
  Message,
} from "../../lib/api";
import type {
  AgentApprovalCard,
  ApprovalStatus,
  PayloadRow,
} from "./agentCardModel";
import { roleDisplayName } from "../approvals/actionRole";
import { expressionFailureLine } from "../approvals/approvalOutcome";
import { EXPIRY_WARN_MS } from "../approvals/expiry";
import {
  approvalEndState,
  APPROVAL_EXPIRED_SENTENCE,
  REQUEST_WORD,
} from "../agents/runPhase";
import {
  isParticipantConsent,
  participantWaitingLine,
  waitsForParticipant,
} from "./approvalNote";

/** 한 요청의 상태. 전달 지연·시간 초과·신호 소실은 이 상태가 아니에요. */
export type RequestBundleState = keyof typeof REQUEST_WORD;
/** 서버의 한 판정(`decision_mode()`). 정의는 와이어 경계(`lib/api.ts`)에 있고 여기서 다시 쓰지 않아요. */
export type DecisionMode = ApprovalDecisionMode;
export type RequestBundleTone = "working" | "warn" | "ok" | "muted" | "danger";

export const REQUEST_BUNDLE_FACE = {
  thinking: { word: REQUEST_WORD.thinking, icon: "CircleDot", tone: "working" },
  approval: {
    word: REQUEST_WORD.approval,
    icon: "ShieldQuestion",
    tone: "warn",
  },
  executing: {
    word: REQUEST_WORD.executing,
    icon: "CircleDot",
    tone: "working",
  },
  done: { word: REQUEST_WORD.done, icon: "Check", tone: "ok" },
  declined: { word: REQUEST_WORD.declined, icon: "Ban", tone: "muted" },
  expired: { word: REQUEST_WORD.expired, icon: "Clock", tone: "warn" },
  failed: { word: REQUEST_WORD.failed, icon: "CircleX", tone: "danger" },
  cancelled: { word: REQUEST_WORD.cancelled, icon: "Octagon", tone: "muted" },
} as const satisfies Record<
  RequestBundleState,
  { word: string; icon: string; tone: RequestBundleTone }
>;

/** 칩·레일은 상위 낱말, 카드·생각 줄은 하위 낱말이에요. 취소는 칩에 세지 않아요. */
export const REQUEST_BUNDLE_CHIP_KIND = {
  thinking: "working",
  executing: "working",
  approval: "approval",
  done: "answered",
  declined: "declined",
  expired: "expired",
  failed: "failed",
  cancelled: null,
} as const;

export interface BundleValue extends PayloadRow {
  before?: string;
  after?: string;
}

export interface RequestBundleResult {
  status?: string;
  code?: string;
  line?: string;
  rows: BundleValue[];
  omittedRows: number;
  ref?: { type: string; id: string };
  next?: { label: string; href: string };
}

/** 승인 카드와 run 진행 bundle이 공유하는 가산 필드. 원본 payload는 읽지 않아요. */
export interface RequestBundleSnapshot {
  approvalId?: string;
  canDecide?: boolean;
  status?: string;
  code?: string;
  intent?: string;
  actionType?: string;
  toolName?: string;
  decisionMode?: DecisionMode;
  result?: RequestBundleResult;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/** 요청 고리 문구 프리플라이트. 이름·도구의 영문 값은 허용하고 옛 영어 문장만 잡아요. */
export function requestLoopCopyViolations(value: string): string[] {
  const hits: string[] = [];
  if (
    /Tool call (?:expired|rejected)|Approval (?:required:|expired before)|^Approve\s|^Review the proposed tool call/i.test(
      value
    )
  )
    hits.push("english-source");
  if (/[가-힣]니다(?:[.!?\s]|$)|십시오/.test(value)) hits.push("formal");
  if (/거절/.test(value)) hits.push("declined-copy");
  if (/승인 대기/.test(value)) hits.push("approval-wait-copy");
  return hits;
}
function publicCopy(value: unknown): string | undefined {
  const copy = text(value);
  return copy !== undefined && requestLoopCopyViolations(copy).length === 0
    ? copy
    : undefined;
}

function values(value: unknown): { rows: BundleValue[]; omittedRows: number } {
  const rows: BundleValue[] = [];
  let omittedRows = 0;
  for (const candidate of Array.isArray(value) ? value : []) {
    const row = record(candidate);
    const label = text(row?.label);
    const after = text(row?.after);
    const value = text(row?.value) ?? after;
    if (label === undefined || value === undefined || rows.length >= 12) {
      omittedRows += 1;
      continue;
    }
    const before = text(row?.before);
    rows.push({
      label,
      value,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  return { rows, omittedRows };
}

export function parseRequestBundleSnapshot(
  value: unknown
): RequestBundleSnapshot {
  const raw = record(value);
  if (raw === undefined) return {};
  const result = record(raw.result);
  const ref = record(result?.ref);
  const next = record(result?.next);
  const refType = text(ref?.type);
  const refId = text(ref?.id);
  const nextLabel = publicCopy(next?.label);
  const nextHref = text(next?.href);
  const mode = raw.decision_mode ?? raw.decisionMode;
  // href의 실행 가능 스킴은 링크로 내보내지 않아요. 앱 내부 경로만 읽어요.
  const safeNext =
    nextHref?.startsWith("/") &&
    !nextHref.startsWith("//") &&
    !/[\\\s]/.test(nextHref);
  return {
    approvalId: text(raw.approval_id) ?? text(raw.approvalId),
    ...(typeof (raw.can_decide ?? raw.canDecide) === "boolean"
      ? { canDecide: (raw.can_decide ?? raw.canDecide) as boolean }
      : {}),
    status: text(raw.approval_status) ?? text(raw.status),
    code: text(raw.code),
    intent: publicCopy(raw.intent),
    actionType: text(raw.action_type) ?? text(raw.actionType),
    toolName: text(raw.tool_name) ?? text(raw.toolName) ?? text(raw.tool),
    ...(mode !== undefined
      ? {
          decisionMode:
            mode === "inline" ? ("inline" as const) : ("open" as const),
        }
      : {}),
    ...(result !== undefined
      ? {
          result: {
            status: text(result.status),
            code: text(result.code),
            line: publicCopy(result.line),
            ...values(result.rows),
            ...(refType !== undefined && refId !== undefined
              ? { ref: { type: refType, id: refId } }
              : {}),
            ...(nextLabel !== undefined && nextHref !== undefined && safeNext
              ? { next: { label: nextLabel, href: nextHref } }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * run 진행에 **같은 승인의 카드 묶음을 덧댄** 모양. 카드는 서버가 종결 때 패치한 끝 상태(`result`·
 * `code`)를 알고 run 진행의 `bundle`은 모르는 때가 있어서, 폰의 생각 줄은 카드의 스냅샷을 먼저
 * 읽어요. 와이어의 `bundle`과 다른 칸이라 서로 덮어쓰지 않아요.
 */
export type RunWithBundleSnapshot = AgentRunProgress & {
  bundleSnapshot?: RequestBundleSnapshot;
};

/**
 * run 진행의 `bundle`(서버가 보는 사람 기준으로 읽은 승인 하나)을 묶음 모델의 말로 옮겨요.
 * 값은 이미 와이어 경계(`agentRunProgressFromWire`)가 좁혀 놓았고 여기서는 다시 판정하지 않아요:
 * `decisionMode`·`canDecide`는 서버 값 그대로예요. `bundle`이 없는 run(옛 서버·승인 없는 run)은
 * `undefined`라서 칩·요약 줄이 예전처럼 `phase`로 읽어요. 덧댄 카드 스냅샷에 상태가 있으면
 * 그것이 먼저예요.
 */
export function runBundleSnapshot(
  run: Pick<AgentRunProgress, "bundle"> & {
    bundleSnapshot?: RequestBundleSnapshot;
  }
): RequestBundleSnapshot | undefined {
  const overlay = run.bundleSnapshot;
  if (
    overlay !== undefined &&
    (overlay.status !== undefined ||
      overlay.code !== undefined ||
      overlay.result !== undefined)
  )
    return overlay;
  const bundle = run.bundle;
  if (bundle === undefined) return undefined;
  const intent = publicCopy(bundle.intent);
  return {
    approvalId: bundle.approvalId,
    status: bundle.status,
    canDecide: bundle.canDecide,
    decisionMode: bundle.decisionMode,
    actionType: bundle.actionType,
    ...(intent !== undefined ? { intent } : {}),
  };
}

/**
 * 서버가 이 승인에 대해 **보는 사람**에게 해 준 결정 자격(`bundle.canDecide`).
 * 그 run의 bundle이 가리키는 승인이 아니면 모르는 것이라 `undefined`예요(예전 승인의 카드를
 * 새 승인의 자격으로 막지 않아요). 호출자는 `=== false`일 때만 단추를 거두고, `true`를 근거로
 * 단추를 더 세우지 않아요: 오프라인·영수증·대기 목록 같은 현장의 문은 그대로 남아요.
 */
export function runBundleCanDecide(
  run: Pick<AgentRunProgress, "bundle"> | undefined,
  approvalId: string | null | undefined
): boolean | undefined {
  const bundle = run?.bundle;
  if (bundle === undefined || approvalId === null || approvalId === undefined) return undefined;
  return bundle.approvalId.toLowerCase() === approvalId.toLowerCase()
    ? bundle.canDecide
    : undefined;
}

export interface RequestBundleStateInput {
  status?: ApprovalStatus | string;
  actionType?: string;
  code?: string;
  result?: Pick<RequestBundleResult, "status" | "code">;
  run?: Pick<AgentRunProgress, "phase" | "endReason">;
  expiresAtMs?: number;
  nowMs?: number;
}
function terminalState(status: string | undefined): RequestBundleState | null {
  switch (status) {
    case "rejected":
    case "approval_rejected":
      return "declined";
    case "expired":
    case "approval_expired":
      return "expired";
    case "cancelled":
    case "human_cancelled":
      return "cancelled";
    case "failed":
    case "error":
    case "agent_error":
      return "failed";
    case "executed":
    case "succeeded":
    case "success":
    case "done":
      return "done";
    default:
      return null;
  }
}

/** 마지막 카드 코드·결과가 정본. 패치 전 카드는 기존 props와 run으로 읽어요. */
export function requestBundleState(
  input: RequestBundleStateInput
): RequestBundleState {
  const result = terminalState(input.result?.status);
  const code = terminalState(input.code) ?? terminalState(input.result?.code);
  if (code !== null) return code;
  if (result !== null) return result;
  const status = terminalState(input.status);
  if (status !== null) return status;
  // 행동 승인은 결정과 실행이 같은 tx에서 끝나요. 재개한 run의 후속
  // 실패·거부·취소가 이미 완료된 행동의 결과를 덮지 않아요.
  if (input.status === "approved" && input.actionType === "workspace_action")
    return "done";
  const explicitPhase = input.result?.status ?? input.status;
  if (explicitPhase === "thinking") return "thinking";
  if (explicitPhase === "running" || explicitPhase === "executing")
    return input.actionType === "workspace_action" ? "thinking" : "executing";
  const run = input.run;
  const phase = run?.phase;
  if (
    phase !== undefined &&
    ["succeeded", "failed", "timed_out", "cancelled"].includes(phase)
  ) {
    const approvalEnd = approvalEndState(run?.endReason);
    if (approvalEnd !== null) return approvalEnd;
    if (phase !== "timed_out") return terminalState(phase)!;
    // 시간 초과·신호 소실만으로 실패라 단정하지 않고 승인 상태를 유지해요.
  }
  if (
    input.status === "pending" &&
    input.expiresAtMs !== undefined &&
    input.nowMs !== undefined &&
    input.expiresAtMs <= input.nowMs
  )
    return "expired";
  if (input.status === "approved") {
    // 승인은 실행 허가예요. 도구의 성공 결과나 run 종결이 오기 전에는
    // run 정보가 없어도 완료를 추측하지 않아요.
    return input.actionType === "tool_call" ? "executing" : "done";
  }
  if (input.status === "pending" || phase === "awaiting_approval")
    return "approval";
  return "thinking";
}

const LEGACY_INLINE_ACTIONS = new Set([
  "channel.create",
  "channel.member.add",
  "agent.rename",
  "hosted.channels.grant",
  "workspace.settings.update",
  "agent.profile.update",
  "workspace.unfurl.update",
  "workspace.memory.update",
  "workspace.work_tier.update",
  "plugin.install",
]);

/** 서버 값이 없을 때만 현행 opens_in_app의 공개 사실로 폴백해요. */
export function requestBundleDecisionMode(
  card: AgentApprovalCard
): DecisionMode {
  if (card.bundle?.decisionMode !== undefined) return card.bundle.decisionMode;
  if (card.execution !== null) return "open";
  if (card.action !== null) {
    if (
      card.agentInitiated ||
      card.action.preview !== undefined ||
      !LEGACY_INLINE_ACTIONS.has(card.action.id)
    )
      return "open";
    return "inline";
  }
  const tool = card.bundle?.toolName;
  return card.bundle?.actionType === "tool_call" &&
    tool !== undefined &&
    tool.trim().toLowerCase().replace(/-/g, "_") !==
      "work.session.login_handoff"
    ? "inline"
    : "open";
}

export interface RequestBundleContext {
  nowMs: number;
  run?: Pick<AgentRunProgress, "phase" | "endReason">;
  /** 현재 명부에서 결정자의 이름을 읽어요. */
  nameFor?: (memberId: string) => string | undefined;
  viewerMemberId?: string;
  viewerKind?: "human" | "agent";
  canDecide?: boolean;
  approverMemberIds?: readonly string[];
  isWorkspaceAdmin?: boolean;
}
export interface RequestValueChip extends BundleValue {
  labelText: string;
}
export interface RequestBundleModel {
  approvalId: string | null;
  state: RequestBundleState;
  word: string;
  icon: string;
  tone: RequestBundleTone;
  headline: string;
  sentence: string;
  valueChips: RequestValueChip[];
  moreValues: number;
  quietLine: string;
  /**
   * 남은 시간만의 한 줄(결정을 기다릴 때만 키가 있어요). `quietLine` 은 끝의 「자세히」가 누르는 자리(타임라인
   * 카드의 펼침)를 가리켜요. 누를 수 없는 표면(결정 무대)이 그 글자를 그대로 그리면 눌리는 것처럼 읽혀서,
   * 그런 표면은 이 줄만 그려요 (#4986).
   */
  remainingLine?: string;
  decisionMode: DecisionMode;
  canDecide: boolean;
  waitingFor?: string;
  details: {
    label: string;
    rows: PayloadRow[];
    withheld: number;
    approvalId?: string;
  };
  next?: RequestBundleResult["next"];
  ref?: RequestBundleResult["ref"];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 조용한 줄의 남은 시간 (#4986). 두 가지를 지켜요.
 *
 * - 단위는 남은 크기로 골라요: 한 시간이 안 되면 분, 하루가 안 되면 시간, 그 위는 일.
 *   예전에는 10분을 넘으면 곧장 시간으로 올려서 15분 남은 허락이 「1시간 남음」이라고 말했어요.
 *   결정할 사람이 한 시간을 믿고 미루면 돌아왔을 때 이미 만료예요.
 * - 단위 안에서는 내려요(61분은 「1시간」, 25시간은 「1일」). 만료는 마감이라 실제보다 길게 말하는 쪽이
 *   틀린 쪽이에요. 올림 판정은 「N분 안에 만료돼요」(`minutesLeft`)의 몫이에요: 그 말은 「안에」라서 올려야 맞아요.
 *
 * 초는 말하지 않고, 10분 이하는 숫자 없이 「10분 안에 만료돼요」예요(`expiryPhase` 의 soon 과 같은 경계).
 */
export function remainingTime(
  expiresAtMs: number | undefined,
  nowMs: number
): string | undefined {
  if (expiresAtMs === undefined || expiresAtMs <= nowMs) return undefined;
  const remaining = expiresAtMs - nowMs;
  if (remaining <= EXPIRY_WARN_MS) return "10분 안에 만료돼요";
  if (remaining < HOUR_MS) return `${Math.floor(remaining / MINUTE_MS)}분 남음`;
  if (remaining < DAY_MS) return `${Math.floor(remaining / HOUR_MS)}시간 남음`;
  return `${Math.floor(remaining / DAY_MS)}일 남음`;
}

export function requestBundleModel(
  card: AgentApprovalCard,
  context: RequestBundleContext
): RequestBundleModel {
  const bundle = card.bundle;
  const state = requestBundleState({
    ...bundle,
    status: bundle?.status ?? card.status,
    actionType:
      bundle?.actionType ??
      (card.action !== null ? "workspace_action" : "tool_call"),
    run: context.run,
    expiresAtMs: card.expiresAtMs,
    nowMs: context.nowMs,
  });
  const face = REQUEST_BUNDLE_FACE[state];
  const proposer =
    card.requestedByMemberId === undefined
      ? undefined
      : context.nameFor?.(card.requestedByMemberId);
  const intent =
    bundle?.intent ??
    (card.title === "도구 실행 · 실패" ? undefined : publicCopy(card.title)) ??
    (bundle?.toolName ? `도구 「${bundle.toolName}」 실행` : "승인 요청");
  // 값 뒤에 조사를 붙이지 않는 기본 틀. 영문·숫자·기호 끝도 같은 문법이에요.
  const headline = proposer ? `${proposer} · ${intent}` : intent;
  const decider =
    card.decidedByMemberId === undefined
      ? undefined
      : context.nameFor?.(card.decidedByMemberId);
  const sentences: Record<RequestBundleState, string> = {
    thinking: "요청을 살펴보고 있어요",
    approval: headline,
    executing: "승인됐어요 · 이어서 하는 중",
    done: "실행을 마쳤어요",
    declined: decider ? `${decider} 님이 거부했어요` : "거부됐어요",
    expired: APPROVAL_EXPIRED_SENTENCE,
    failed: "실행을 끝내지 못했어요 · 다시 요청해 보세요",
    cancelled: "요청이 취소됐어요",
  };
  // ADR-0217: 참여자 동의 카드는 카드에 고정된 사람 하나만 결정해요. 그 밖의 사람은 요청자든 다른
  // 참여자든 관리자든 기다리는 쪽이에요. 다른 승인 카드는 이 판정에 걸리지 않아요.
  const waitsForPerson = waitsForParticipant(
    card.action,
    context.viewerMemberId
  );
  const canDecide =
    state === "approval" &&
    card.approvalId !== null &&
    !card.isResumeOffer &&
    context.canDecide !== false &&
    (bundle?.canDecide ?? context.canDecide) === true &&
    context.viewerKind === "human" &&
    context.viewerMemberId !== undefined &&
    context.viewerMemberId.toLowerCase() !==
      card.requestedByMemberId?.toLowerCase() &&
    !waitsForPerson;
  const approvers = context.approverMemberIds ?? [];
  const approver =
    approvers.length === 1 ? context.nameFor?.(approvers[0]!) : undefined;
  const target = card.action?.targetMemberId;
  // 참여자 동의 카드의 대기 줄은 결정자의 이름이에요. 결정자 본인에게는 기다릴 사람이 없어서 줄이
  // 없고, 「관리자」는 이 카드의 결정자가 아니라서 어느 경우에도 세우지 않아요.
  const waitingFor =
    state === "approval" && !canDecide
      ? isParticipantConsent(card.action)
        ? waitsForPerson
          ? participantWaitingLine(
              target === undefined ? undefined : context.nameFor?.(target)
            )
          : undefined
        : approver
        ? `${approver} 님의 승인을 기다려요`
        : "관리자의 승인을 기다려요"
      : undefined;
  const result = bundle?.result;
  const rows =
    state === "done" && result !== undefined && result.rows.length > 0
      ? result.rows
      : card.action?.rows ?? [];
  const omittedRows =
    state === "done" && result !== undefined && result.rows.length > 0
      ? result.omittedRows
      : card.action?.omittedRows ?? 0;
  const valueChips = rows.slice(0, 2).map((row) => ({
    ...row,
    labelText:
      row.after === undefined
        ? `${row.label}: ${row.value}`
        : row.before === undefined
        ? `${row.label}: 이후 값 ${row.after}`
        : `${row.label}: 이전 값 ${row.before}, 이후 값 ${row.after}`,
  }));
  const quiet =
    state === "approval"
      ? remainingTime(card.expiresAtMs, context.nowMs)
      : undefined;
  // ADR-0218 G3.8: 코드가 정본이에요. 거부·만료·실패·취소로 닫힌 카드가 생성·조립 실패 코드를
  // 싣고 있으면 그 코드의 골든 줄이 일반 상태 문장보다 앞서요(서버가 같은 줄을 body에 써요).
  // 결정을 묻는 중인 같은 카드는 이 줄을 말하지 않아요. 표현 실패 코드가 아니면 null이라
  // 다른 승인 카드의 문장은 그대로예요.
  const resultLine =
    state === "done" || state === "failed" ? result?.line : undefined;
  const codeLine =
    state === "declined" ||
    state === "expired" ||
    state === "failed" ||
    state === "cancelled"
      ? expressionFailureLine(bundle?.code)
      : null;
  return {
    approvalId: card.approvalId,
    state,
    ...face,
    headline,
    sentence: resultLine ?? codeLine ?? sentences[state],
    valueChips,
    moreValues: Math.max(0, rows.length - 2) + omittedRows,
    quietLine: quiet ? `${quiet} · 자세히` : "자세히",
    ...(quiet ? { remainingLine: quiet } : {}),
    decisionMode: requestBundleDecisionMode(card),
    canDecide,
    ...(waitingFor !== undefined ? { waitingFor } : {}),
    details: {
      label: "자세히",
      rows: [
        ...(card.action?.rows ?? []),
        ...(card.action?.rationale
          ? [{ label: "사유", value: card.action.rationale }]
          : []),
        ...(card.action?.requiredRole
          ? [
              {
                label: "결정 권한",
                value: roleDisplayName(card.action.requiredRole),
              },
            ]
          : []),
        ...(state === "done" ? result?.rows ?? [] : []),
        ...card.detail.rows,
      ],
      withheld: card.detail.withheld,
      ...(context.isWorkspaceAdmin && card.approvalId !== null
        ? { approvalId: card.approvalId }
        : {}),
    },
    ...(state === "done" && result?.ref !== undefined
      ? { ref: result.ref }
      : {}),
    ...(state === "done" && result?.next !== undefined
      ? { next: result.next }
      : {}),
  };
}

/** 같은 목록의 끝난 카드가 설명하는 옛 줄만 접어요. 창 밖의 정보는 보존해요. */
export function shouldFoldBundleLine(
  line: Message,
  messages: readonly Message[]
): boolean {
  const bundleOf = text(line.props?.bundle_of);
  if (bundleOf === undefined || line.type === "approval_request") return false;
  return messages.some((message) => {
    if (
      message.type !== "approval_request" ||
      message.state === "deleted" ||
      message.channelId !== line.channelId ||
      message.props?.approval_id !== bundleOf
    )
      return false;
    const bundle = parseRequestBundleSnapshot(message.props);
    const state = requestBundleState(bundle);
    if (["declined", "expired", "failed", "cancelled"].includes(state))
      return true;
    if (state !== "done") return false;
    // 승인만 됐거나 모르는 결과 블록만 온 도구의 실제 결과 줄은 접지 않아요.
    return (
      terminalState(bundle.result?.status) === "done" ||
      terminalState(bundle.code) === "done" ||
      terminalState(bundle.result?.code) === "done" ||
      terminalState(bundle.status) === "done" ||
      (bundle.status === "approved" &&
        (bundle.actionType === "workspace_action" ||
          text(record(message.props?.action)?.id) !== undefined))
    );
  });
}
