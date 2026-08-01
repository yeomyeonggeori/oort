import type { Message } from "@/lib/api";

// =============================================================================
// Agent card model (R-1 §4). Pure: no DOM, no fetch, no React, so the status
// lifecycle and the redaction contract are asserted by unit tests instead of by
// a screenshot.
//
// The vocabulary is INHERITED from the ADR-0119 client
// (clients/web-legacy/src/state/approvalModel.ts): ApprovalStatus,
// approvalCardModel, resolveApprovalStatus. The basic-mode contract rides along
// with it (ADR-0112, design-taste-web §9): only fields the server itself names
// as public copy are parsed, and tool arguments, execution paths, grants,
// payload hashes and raw output stay OPAQUE, disclosure or not. Everything this
// module cannot name, it counts and admits to instead of rendering.
//
// Field provenance is measured, not guessed:
//   - approval_request props   AgentGatewayRoutes.approvalRequestProps /
//                              WorkControlRoutes work_control_approval props
//   - decision patch           ApprovalDecisionRoutes.patchApprovalRequestMessage
//                              (approval_status / status / decided_by /
//                               decided_at_ms / decision_reason)
//   - tool_result props        AgentWorker WorkerService.toolResultProps
//   - turn record props        AgentGatewayRoutes.timelineProps
//                              (schema momo.agent_gateway.timeline.v0, `usage`)
//   - run status vocabulary    schema_v0.sql run_status enum
// =============================================================================

// ---- status vocabularies ----------------------------------------------------

/** Approval lifecycle, verbatim from the `approval_status` PG enum. */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

/**
 * Agent turn chip lifecycle (R-1 §4). `stalled` exists so silence is never
 * promoted to failure: a timeout or a pause is an absence of news, not a
 * false story about one (ADR-0132 / design-taste-web §9). `cancelled` is
 * separate for the same reason: a deliberate stop is not an error either, and
 * the run_status enum really does distinguish all three.
 */
export type AgentTurnStatus =
  | "queued"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "done"
  | "error"
  | "stalled"
  | "cancelled";

const APPROVAL_STATUSES = new Set<ApprovalStatus>([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

/** Server status string -> chip. Unknown strings stay unknown (null). */
const TURN_STATUS_BY_SERVER: Readonly<Record<string, AgentTurnStatus>> = {
  queued: "queued",
  running: "thinking",
  thinking: "thinking",
  streaming: "streaming",
  awaiting_approval: "awaiting-approval",
  "awaiting-approval": "awaiting-approval",
  paused: "stalled",
  timed_out: "stalled",
  stalled: "stalled",
  succeeded: "done",
  success: "done",
  done: "done",
  failed: "error",
  error: "error",
  cancelled: "cancelled",
  rejected: "cancelled",
};

export const TURN_STATUS_LABEL: Readonly<Record<AgentTurnStatus, string>> = {
  queued: "대기열",
  thinking: "생각 중",
  streaming: "응답 중",
  "awaiting-approval": "승인 대기",
  done: "완료",
  error: "실패",
  stalled: "응답 없음",
  cancelled: "중단됨",
};

export const APPROVAL_STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  pending: "승인 대기",
  approved: "승인됨",
  rejected: "거부됨",
  expired: "만료됨",
  cancelled: "취소됨",
};

export function parseApprovalStatus(value: unknown): ApprovalStatus | null {
  return typeof value === "string" &&
    APPROVAL_STATUSES.has(value as ApprovalStatus)
    ? (value as ApprovalStatus)
    : null;
}

/** Map a server run/completion status onto the chip lifecycle. */
export function turnStatusFor(value: unknown): AgentTurnStatus | null {
  if (typeof value !== "string") return null;
  return TURN_STATUS_BY_SERVER[value.toLowerCase()] ?? null;
}

/**
 * A settled snapshot always wins over a stale `pending` projection: the local
 * receipt is server truth from a moment the message row has not caught up to.
 * Ported verbatim in intent from web-legacy resolveApprovalStatus.
 */
export function resolveApprovalStatus(
  localStatus: string | null,
  messageStatus: ApprovalStatus
): ApprovalStatus {
  const parsedLocal = parseApprovalStatus(localStatus);
  if (parsedLocal !== null && parsedLocal !== "pending") return parsedLocal;
  if (messageStatus !== "pending") return messageStatus;
  return parsedLocal ?? messageStatus;
}

// ---- props readers (typed, total, never throwing) ---------------------------

type Props = Record<string, unknown> | undefined;

function readString(props: Props, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(props: Props, key: string): number | undefined {
  const value = props?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function readBoolean(props: Props, key: string): boolean | undefined {
  const value = props?.[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// ---- the public allowlist ---------------------------------------------------

/**
 * Every prop key this module is willing to read. A key that is not here is
 * never rendered anywhere, and is counted into `withheld` so the card can say
 * out loud that the server sent more than it shows.
 *
 * Deliberately absent, and it must stay that way: `arguments`, `tool_grant`,
 * `payload`, `payload_sha256`, `call_id`, `output`, `target_host_id`,
 * `control_id`, `executor`.
 */
const PARSED_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "schema",
  "source",
  "approval_id",
  "title",
  "summary",
  "status",
  "approval_status",
  "decided_by",
  "decided_at_ms",
  "decision_reason",
  "action_type",
  "tool_name",
  "tool",
  "label",
  "tier",
  "is_reversible",
  "estimated_micro_usd",
  "is_error",
  "usage",
  "error",
  // goal B8 H2. The worker stopped putting the provider's raw reason in
  // `error` and now sends a stable machine code instead, which is the thing a
  // client can branch on without matching prose. The code is READ, never
  // rendered: it reaches the card as Korean copy (failureGuidance) and nothing
  // else.
  "error_code",
  // Ids the model reads for provenance but never renders as copy: run and
  // channel identifiers are internal vocabulary (design-taste-web §7).
  "run_id",
  "channel_id",
  "agent_member_id",
]);

export interface PayloadRow {
  label: string;
  value: string;
}

/**
 * The disclosure body. `rows` are the public fields not already on the face of
 * the card; `withheld` is how many keys the server sent that this client
 * refuses to interpret.
 */
export interface PayloadDetail {
  rows: PayloadRow[];
  withheld: number;
}

/** AgentGatewayApprovalTier raw values, in plain language. */
const TIER_LABEL: Readonly<Record<string, string>> = {
  read_only: "읽기 전용",
  workspace_write: "워크스페이스 쓰기",
  network_write: "네트워크 쓰기",
};

const DETAIL_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
  format?: (props: Props, key: string) => string | undefined;
}> = [
  { key: "action_type", label: "동작" },
  { key: "tool_name", label: "도구" },
  { key: "tool", label: "도구" },
  { key: "label", label: "대상" },
  {
    key: "tier",
    label: "권한",
    // AgentGatewayApprovalTier raw values are wire vocabulary, so they are
    // translated rather than printed: a human deciding an approval should read
    // what the agent is allowed to touch, not an enum case.
    format: (props, key) => {
      const raw = readString(props, key);
      if (raw === undefined) return undefined;
      return TIER_LABEL[raw] ?? raw;
    },
  },
  {
    key: "is_reversible",
    label: "되돌리기",
    format: (props, key) => {
      const value = readBoolean(props, key);
      if (value === undefined) return undefined;
      return value ? "가능" : "불가";
    },
  },
  { key: "decision_reason", label: "결정 사유" },
];

/** Public rows plus the count of everything left opaque. */
export function payloadDetail(props: Props): PayloadDetail {
  const rows: PayloadRow[] = [];
  const usedLabels = new Set<string>();
  for (const field of DETAIL_FIELDS) {
    const value = field.format
      ? field.format(props, field.key)
      : readString(props, field.key);
    if (value === undefined || usedLabels.has(field.label)) continue;
    usedLabels.add(field.label);
    rows.push({ label: field.label, value });
  }
  let withheld = 0;
  for (const key of Object.keys(props ?? {})) {
    if (!PARSED_KEYS.has(key)) withheld += 1;
  }
  return { rows, withheld };
}

// ---- cost -------------------------------------------------------------------

/**
 * Settled turn cost, read from the server's own `usage` object. Nothing here is
 * derived or extrapolated on the client: an absent field renders as absent, so
 * a card never invents a number it was not given.
 */
export interface AgentCost {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  costMicroUsd?: number;
  /** The server flagged the cost as an estimate rather than a billed figure. */
  estimated: boolean;
}

export function agentCost(props: Props): AgentCost | null {
  const raw = props?.["usage"];
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const cost: AgentCost = {
    estimated: readBoolean(usage, "was_estimated") === true,
  };
  const model = readString(usage, "model");
  if (model !== undefined) cost.model = model;
  const promptTokens = readNumber(usage, "prompt_tokens");
  if (promptTokens !== undefined) cost.promptTokens = promptTokens;
  const completionTokens = readNumber(usage, "completion_tokens");
  if (completionTokens !== undefined) cost.completionTokens = completionTokens;
  const costMicroUsd = readNumber(usage, "cost_micro_usd");
  if (costMicroUsd !== undefined) cost.costMicroUsd = costMicroUsd;
  const hasAny =
    cost.model !== undefined ||
    cost.promptTokens !== undefined ||
    cost.completionTokens !== undefined ||
    cost.costMicroUsd !== undefined;
  return hasAny ? cost : null;
}

/** Thousands separators without Intl, so the output is locale independent. */
export function formatCount(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(Math.round(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Micro USD to a printable amount. A nonzero cost never rounds down to $0.000:
 * saying a real charge was free is the exact kind of quiet lie the numbers
 * discipline exists to prevent (design-taste-web §3).
 */
export function formatMicroUsd(microUsd: number): string {
  if (microUsd === 0) return "$0";
  if (microUsd > 0 && microUsd < 1_000) return "$0.001 미만";
  const usd = microUsd / 1_000_000;
  const decimals = Math.abs(usd) < 1 ? 3 : 2;
  const fixed = Math.abs(usd).toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${usd < 0 ? "-" : ""}$${grouped}.${fraction}`;
}

// ---- the "did X to Y, arriving at Z" frame -----------------------------------

/**
 * Agent activity reads as an action, not as a payload dump (R-1 §4, buzz §7-2):
 * what it did, what it did it to, where it landed. Any leg the server did not
 * supply stays null rather than being filled with a plausible guess.
 */
export interface ActionFrame {
  verb: string;
  object: string | null;
  outcome: string | null;
}

/** One-line rendering of a frame, used for the accessible label. */
export function frameSentence(frame: ActionFrame): string {
  const head = frame.object ? `${frame.verb}, ${frame.object}` : frame.verb;
  return frame.outcome ? `${head} → ${frame.outcome}` : head;
}

// ---- card models ------------------------------------------------------------

export interface AgentApprovalCard {
  kind: "approval";
  approvalId: string | null;
  title: string;
  summary?: string;
  status: ApprovalStatus;
  isResumeOffer: boolean;
  /** Public risk hint hoisted by the server into ApprovalProjection. */
  isReversible?: boolean;
  /** Public estimate hoisted by the server into ApprovalProjection. */
  estimatedMicroUsd?: number;
  decidedByMemberId?: string;
  decidedAtMs?: number;
  detail: PayloadDetail;
}

export interface AgentToolCard {
  kind: "tool";
  title: string;
  status: AgentTurnStatus;
  frame: ActionFrame;
  /** Server-sanitised failure text, same `error` prop the turn record uses. */
  errorNote?: string;
  detail: PayloadDetail;
}

export interface AgentTurnCard {
  kind: "turn";
  title: string;
  status: AgentTurnStatus;
  cost: AgentCost | null;
  /** Server-sanitised failure text. Says what happened, never apologises. */
  errorNote?: string;
  /** Our own copy for a typed failure code (goal B8 H2). */
  failure?: FailureGuidance;
  detail: PayloadDetail;
}

/**
 * What a failed turn says on the card, per `props.error_code`.
 *
 * The message body already carries one Korean sentence for the reader who is
 * only scrolling past. This is the second layer, folded away behind 자세히: what
 * kind of failure it was, what repairs it, and where the provider's own words
 * went. Naming that last part matters, because "우리가 숨겼다" and "그건 실행
 * 기록에 있다" are different promises and only one of them is true.
 */
export interface FailureGuidance {
  /** Short label for the 상태 row. Never a code, never English. */
  label: string;
  /** The 자세히 body. What to do, then where the original text is. */
  detail: string;
}

// Names ONLY what the server actually keeps. The Rust worker writes the
// redacted provider text to `agent_run.error.reason` (the run record) and to
// `outbox.last_error`; it writes no audit_log row on this path, so the copy
// must not promise one. A sentence that over-claims where evidence lives is
// worse than no sentence: somebody goes looking and finds nothing.
const WHERE_THE_ORIGINAL_IS = "AI 제공자가 보낸 원문은 이 실행 기록에만 남습니다.";

// A Map, not an object literal: the key comes off the wire, and an object
// lookup answers for `constructor` and `__proto__` too. That would have handed
// back Object.prototype's member instead of falling through to the unknown-code
// copy, and the card would render a label of `undefined`.
const FAILURE_GUIDANCE: ReadonlyMap<string, FailureGuidance> = new Map([
  [
    "provider_failed",
    {
      // "AI 제공자", the term the rest of the product uses on purpose
      // (settings/quotaModel.ts). A bare 제공자 on a timeline has no antecedent.
      label: "AI 제공자가 응답하지 못했습니다.",
      // Does NOT repeat the body's "잠시 뒤에 다시 멘션해 주세요." The reader who
      // opened this fold already read that sentence 40px above; what they came
      // here for is the step after it.
      detail: `같은 실패가 이어지면 설정의 AI 연결에서 연결 상태를 확인하세요. ${WHERE_THE_ORIGINAL_IS}`,
    },
  ],
  [
    "provider_auth_failed",
    {
      label: "연결된 계정 인증이 만료되었습니다.",
      detail: `설정의 AI 연결에서 계정을 다시 등록하면 이어서 실행할 수 있습니다. ${WHERE_THE_ORIGINAL_IS}`,
    },
  ],
]);

/**
 * Copy for a failure code, or null when the server sent none.
 *
 * An UNKNOWN code still produces copy rather than falling through to silence: a
 * future worker code this build has never seen must not turn a failed turn into
 * a card that says nothing at all.
 */
export function failureGuidance(code: unknown): FailureGuidance | null {
  if (typeof code !== "string" || code === "") return null;
  return (
    FAILURE_GUIDANCE.get(code) ?? {
      label: "실행을 끝내지 못했습니다.",
      // No next step, on purpose. This branch is for codes this build has never
      // seen (a work host, a policy, a tool), and sending all of them to the AI
      // 연결 panel would be a confident wrong instruction. Where the evidence is
      // remains true whatever the code turns out to mean.
      detail: WHERE_THE_ORIGINAL_IS,
    }
  );
}

export type AgentCardModel =
  | AgentApprovalCard
  | AgentToolCard
  | AgentTurnCard;

function approvalCard(
  message: Message,
  props: Props
): AgentApprovalCard | null {
  if (!props) return null;
  const isResumeOffer = props["kind"] === "resume_offer";
  const rawApprovalId = props["approval_id"];
  const approvalId =
    typeof rawApprovalId === "string" && rawApprovalId !== ""
      ? rawApprovalId
      : null;
  // Same guard as web-legacy: a request with neither an id nor a resume offer
  // is not actionable, so it is not a card.
  if (!isResumeOffer && approvalId === null) return null;

  const status =
    parseApprovalStatus(props["approval_status"]) ??
    parseApprovalStatus(props["status"]) ??
    "pending";

  const card: AgentApprovalCard = {
    kind: "approval",
    approvalId,
    // ADR-0139 D3: a dead-host lineage resume must never borrow the same
    // "이어서" wording as a live-host PTY reattach.
    title: isResumeOffer
      ? "새 호스트에서 재개"
      : readString(props, "title") ?? message.body ?? "승인 요청",
    status,
    isResumeOffer,
    detail: payloadDetail(props),
  };
  const summary = readString(props, "summary");
  if (summary !== undefined) card.summary = summary;
  const isReversible = readBoolean(props, "is_reversible");
  if (isReversible !== undefined) card.isReversible = isReversible;
  const estimated = readNumber(props, "estimated_micro_usd");
  if (estimated !== undefined) card.estimatedMicroUsd = estimated;
  const decidedBy = readString(props, "decided_by");
  if (decidedBy !== undefined) card.decidedByMemberId = decidedBy;
  const decidedAtMs = readNumber(props, "decided_at_ms");
  if (decidedAtMs !== undefined) card.decidedAtMs = decidedAtMs;
  return card;
}

function toolCard(message: Message, props: Props): AgentToolCard {
  const toolName = readString(props, "tool_name") ?? readString(props, "tool");
  const isError = readBoolean(props, "is_error") === true;
  const status =
    turnStatusFor(props?.["status"]) ??
    (isError ? "error" : message.type === "tool_call" ? "thinking" : "done");
  const frame: ActionFrame = {
    verb: toolName ? `${toolName} 실행` : "도구 실행",
    object: readString(props, "label") ?? null,
    outcome: message.body ?? null,
  };
  // Read the same `error` prop the turn record reads. A failed tool run whose
  // body is the artifact it was trying to write (a patch) has nowhere else to
  // put the reason, and losing it is how a failure reads as a success.
  const errorNote = readString(props, "error");
  return {
    kind: "tool",
    title: frame.verb,
    status,
    frame,
    ...(errorNote !== undefined ? { errorNote } : {}),
    detail: payloadDetail(props),
  };
}

function turnCard(props: Props): AgentTurnCard | null {
  if (!props) return null;
  const cost = agentCost(props);
  const errorNote = readString(props, "error");
  // goal B8 H2: the worker's failure notice now carries a code instead of the
  // provider's raw reason. Without this read that notice would have arrived as
  // an ordinary sentence with no card, no status chip and no 자세히, which is a
  // failed turn that does not look like one.
  const failure = failureGuidance(props["error_code"]);
  const status = turnStatusFor(props["status"]);
  // A plain agent sentence is a plain message: only a turn that carries a
  // settled cost, a failure, or a non-terminal status earns a card.
  if (cost === null && errorNote === undefined && failure === null) {
    if (status === null || status === "done") return null;
  }
  const card: AgentTurnCard = {
    kind: "turn",
    title: "에이전트 실행 결과",
    status:
      status ?? (errorNote !== undefined || failure !== null ? "error" : "done"),
    cost,
    detail: payloadDetail(props),
  };
  if (errorNote !== undefined) card.errorNote = errorNote;
  if (failure !== null) card.failure = failure;
  return card;
}

/**
 * The structured body of an agent event, or null when the message is ordinary
 * prose. Deleted rows never produce a card: the tombstone is the whole story.
 */
export function agentCardModel(message: Message): AgentCardModel | null {
  if (message.state === "deleted") return null;
  const props = message.props;
  if (message.type === "approval_request") return approvalCard(message, props);
  if (message.type === "tool_call" || message.type === "tool_result") {
    return toolCard(message, props);
  }
  return turnCard(props);
}

/**
 * True when the row still renders the plain message body above the card. A turn
 * record annotates the agent's own sentence, so the sentence stays; an approval
 * or a tool card already carries the server copy in its title and rows, so
 * repeating the body underneath would just be the same line twice.
 */
export function cardKeepsBody(card: AgentCardModel): boolean {
  return card.kind === "turn";
}
