import type { Message } from "../../lib/api";
import {
  parseExecutionPlan,
  type SpawnExecutionPlan,
} from "../../lib/executionPlan";
import { loginHandoffCard, type LoginHandoffCard } from "./loginHandoffCard";
import {
  completionReportCard,
  type CompletionReportCard,
} from "./completionReportCard";

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
 *
 * `execution` joined the list with #1114 and is the one entry that is an OBJECT
 * rather than a scalar. It is here because the card genuinely reads it — the
 * host picker is drawn from it — and because leaving it out would have counted
 * a rendered field as `withheld`, which is the card telling the reader it is
 * hiding something it is in fact showing. `target_host_id` stays absent right
 * above it and the pair is not a contradiction: that prop is a raw id with no
 * name attached, and an id is not something a person can decide with.
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
  // ADR-0125 D6-A의 호스트 후보(#1114). 카드가 실제로 그리는 것이라 withheld가
  // 아니다 — 위 주석 참고.
  "execution",
  // LIVE-4 로그인 핸드오프 카드가 읽는 키 (`loginHandoffCard.ts`).
  //
  // `session_id` 는 **딥링크 하나를 위해서만** 읽고 문자로는 그리지 않는다 —
  // `run_id`·`channel_id` 와 같은 격이다. 바로 위 `target_host_id` 가 부재로
  // 남아 있는 것과 모순이 아니다: 그쪽은 사람이 그것을 보고 고르라고 실리는
  // 값인데 이름이 없어 고를 수 없는 id 였고, 이쪽은 이미 이름 붙은 화면(작업
  // 세션 상세)으로 가는 주소다.
  //
  // 나머지 셋은 카드가 **그리는** 경계 사실이므로 여기 없으면 카드가 「보여
  // 주고 있는 것을 숨겼다」고 스스로 말하게 된다(withheld 의 뜻).
  "session_id",
  "control_started_at_ms",
  "control_ended_at_ms",
  "control_end_reason",
  // 작업 완료 리포트(UXC-A)가 카드 표면에 직접 그리는 것들 (`completionReportCard.ts`).
  // `completionReportCard` 가 이 셋을 읽어 요약·불릿·표로 세우므로, 여기 없으면
  // 정직 카운트가 자기가 그린 필드를 「숨김」으로 세는 모순이 난다(위 핸드오프
  // 경계 사실과 같은 이유).
  "actions",
  "gates",
  "elapsed_ms",
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
  /**
   * 이 승인이 「어디서 실행할지」까지 묻는가 (ADR-0125 D6-A, #1114).
   *
   * `null`이 압도적 다수다 — 스폰 승인에만 실린다. 카드 스냅샷에서 읽는 것이
   * 맞는 이유: 서버가 후보를 **props에도** 싣는 것은 클라이언트가 브로드캐스트된
   * 메시지 하나만으로 라디오를 그릴 수 있게 하기 위해서다(그러지 않으면 카드가
   * 첫 라디오를 그리기 전에 승인 프로젝션을 한 번 더 읽어야 한다).
   *
   * 그래서 이 값은 **카드가 그려진 시점의 사실**이다. 그때 온라인이던 맥이 지금
   * 꺼져 있을 수 있고, 그 경우 사람이 고른 호스트를 서버가 결정 시점에 다시
   * 판정해 거절한다 — 그것이 서버가 두 겹으로 검증하는 이유이자, 화면이 그
   * 거절을 「결정됨」이 아니라 오류로 그려야 하는 이유다.
   */
  execution: SpawnExecutionPlan | null;
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
      // No next step AND no source, on purpose. This branch is for codes this
      // build has never seen (a work host, a policy, a tool). Sending all of
      // them to the AI 연결 panel would be a confident wrong instruction, and
      // naming the AI 제공자 as the author of the evidence is a confident wrong
      // attribution: a reader who goes looking for provider output after a
      // work-host failure finds nothing. Only the location survives, because
      // only the location is true whatever the code turns out to mean.
      detail: "원문은 이 실행 기록에만 남습니다.",
    }
  );
}

export type AgentCardModel =
  | AgentApprovalCard
  | AgentToolCard
  | AgentTurnCard
  | LoginHandoffCard
  | CompletionReportCard;

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
    execution: parseExecutionPlan(props),
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
  if (message.type === "approval_request") {
    // 로그인 핸드오프는 승인 카드 가족의 신구성원이지, 새 메시지 타입이 아니다
    // (LIVE-4 / `loginHandoffCard.ts` 머리말). `props.kind` 로 갈라지는 것은
    // `resume_offer` 가 approvalCard 안에서 하는 것과 같은 일이고, 여기서
    // 갈라 두는 이유는 이 카드가 승인 카드와 **다른 행들**을 그리기 때문이다.
    const handoff = loginHandoffCard(props);
    if (handoff !== null) return handoff;
    return approvalCard(message, props);
  }
  if (message.type === "tool_call" || message.type === "tool_result") {
    return toolCard(message, props);
  }
  // 작업 완료 리포트(UXC-A)는 평범한 턴 메시지 안에서 `props.kind` 로 갈라진다 —
  // 로그인 핸드오프가 승인 메시지 안에서 갈라지는 것과 같은 재사용이다. 새 메시지
  // 타입도 마이그레이션도 없다. `turnCard` 보다 **먼저** 물어보는 이유는, 내용이
  // 있는 리포트라면 그것이 그 턴이 남긴 진짜 산출이기 때문이다. `kind` 만 실렸고
  // 내용이 비면 `completionReportCard` 가 `null` 을 내고 평범한 턴으로 떨어진다.
  const completion = completionReportCard(props);
  if (completion !== null) return completion;
  return turnCard(props);
}

/**
 * True when the row still renders the plain message body above the card. A turn
 * record annotates the agent's own sentence, so the sentence stays; an approval
 * or a tool card already carries the server copy in its title and rows, so
 * repeating the body underneath would just be the same line twice.
 *
 * The login handoff card is in the second group for a sharper reason: its body
 * is the server's English one-liner (`approval_request_body`), and the sentence
 * a reader needs is the agent's Korean 사유, which the card draws from `summary`.
 *
 * The completion report (UXC-A) is the ONE conditional case. When it carries a
 * summary, its 한 문단 요약 IS the sentence, so the plain body above would be that
 * same paragraph a second time — body suppressed, like an approval. But a report
 * with gates and NO summary has no sentence of its own on the card, and folding
 * the body there makes the agent's one line ("환경 셋업을 마쳤습니다") vanish from
 * web and phone alike (M2). So a summary-less report keeps its body: the body is
 * the missing summary.
 */
export function cardKeepsBody(card: AgentCardModel): boolean {
  if (card.kind === "turn") return true;
  if (card.kind === "completion_report") return card.summary === undefined;
  return false;
}
