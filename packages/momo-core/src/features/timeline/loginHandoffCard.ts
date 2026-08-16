import {
  parseApprovalStatus,
  payloadDetail,
  type ApprovalStatus,
  type PayloadDetail,
} from "./agentCardModel";
import type { ApprovalNoteTone } from "./approvalNote";

// =============================================================================
// 로그인 핸드오프 카드 (LIVE-4 / ADR-0004 증보 3 · ADR-0165)
//
// 에이전트가 로그인 화면 앞에서 멈춰 사람을 부르는 카드다. 비밀번호를
// 에이전트에게 주지 않고 사람이 직접 넣는다는 것이 증보 3의 발단이고, 이 카드는
// 그 요청이 채팅에 서는 자리다.
//
// ## 새 카드 체계가 아니다 (패킷 §0 「승인 카드 가족의 신구성원」)
//
// 이 카드는 **승인 카드와 같은 메시지**다: `message.type = 'approval_request'`,
// `props.approval_status`, 같은 결정 REST, 같은 원장. 갈라지는 것은 `props.kind`
// 하나뿐이고, 그 갈래는 이미 있던 것이다 (`resume_offer` 가 같은 자리에서 같은
// 일을 한다, `agentCardModel.approvalCard`). 그래서:
//
//   * `message_type` enum 에 값을 더하지 않는다 (schema_v0 불가침),
//   * 결정 경로를 새로 짓지 않는다 — 재개 = 승인, 중단 = 거부이고 둘 다
//     `awaiting_approval` 을 가드로 하는 기존 문장이라 재생해도 안전하다
//     (`requeue_run_from_approval_in_tx` / `end_parked_run_in_tx`),
//   * 정지도 새로 짓지 않는다 — 카드를 올리는 트랜잭션이
//     `park_run_for_approval_in_tx` 를 부른다. 이것이 「토큰 소진 0」(증보 3 D6)
//     을 약속이 아니라 원장의 성질로 만든다: 세워진 run 은 gateway 의 두 문에서
//     이미 거절된다(`agent_gateway`:345·:567).
//
// ## 상태 두 축, 하나로 접지 않는 이유
//
// 카드가 답해야 하는 질문은 둘이고 주어가 다르다.
//
//   1. **이 요청은 끝났는가** — 주어는 승인 원장(`approval_status`).
//   2. **사람의 개입은 어떻게 끝났는가** — 주어는 control 창 원장
//      (`display_control_window.end_reason`: returned | expired | session_ended).
//
// 둘을 한 낱말로 접으면 거짓이 생긴다. 사람이 창을 열어 로그인을 마치고 반환한
// 것(`returned`)과, 랩톱을 덮어 lease 가 끊긴 것(`expired`)은 원장에서 이미
// 구분돼 있는데(076 CHECK), 카드가 둘 다 「완료」라고 말하면 에이전트가 완료를
// 가정해도 된다는 거짓 신호를 사람에게도 준다. 그래서 `phase` 는 승인 축을,
// `outcome` 은 창 축을 각각 그대로 나른다.
//
// ## 네 번째 상태(`stopped`)를 왜 두는가
//
// 핸드오프 터미널은 셋이다(위의 end_reason 셋, 새 어휘 없음). 그런데 카드의
// **액션**은 재개·중단 둘이고, 중단은 run 을 멈추는 것이지 개입이 끝나는 것이
// 아니다 — 창은 열린 적조차 없을 수 있다. 그 갈래를 셋 중 하나에 욱여넣으면
// 「세션이 끝났다」거나 「완료가 불확실하다」는, 일어나지 않은 일을 말하게 된다.
// 그래서 `stopped` 은 핸드오프의 터미널이 아니라 **run 의 터미널**이고, 낱말도
// 새로 짓지 않는다: `TURN_STATUS_LABEL.cancelled` 가 이미 쓰는 「중단됨」이다.
//
// ## 정직 카피 2분법
//
// 배포 사실과 세션 사실은 다른 문장이고 다른 격이다.
//
//   * **배포 사실** — 이 빌드에는 채팅에서 화면을 여는 동선이 없다
//     ([`LOGIN_HANDOFF_DEPLOYMENT_COPY`]). 사람이 고칠 수 있는 것이 아니므로
//     재시도를 권하지 않고, **어포던스는 부재**로 둔다: 영원히 비활성인 버튼은
//     UI 차용증이다. 이 줄은 컨트롤을 대체하지 않으므로 아래 cascade 밖에 있다.
//   * **세션 사실** — 지금 누가 화면을 잡고 있다, 언제 정지했고 언제 재개했다.
//     이쪽은 변한다.
// =============================================================================

/** 이 카드를 세우는 `props.kind`. 승인 카드의 `resume_offer` 와 같은 자리다. */
export const LOGIN_HANDOFF_KIND = "login_handoff";

/**
 * 사람의 개입이 어떻게 끝났는가. **`display_control_window.end_reason` 그대로**
 * 이고(076 의 CHECK 어휘), 클라가 새로 짓는 낱말은 하나도 없다.
 */
export type LoginHandoffOutcome = "returned" | "expired" | "session_ended";

const OUTCOMES: ReadonlySet<string> = new Set<LoginHandoffOutcome>([
  "returned",
  "expired",
  "session_ended",
]);

/**
 * 카드가 서 있는 국면.
 *
 * `waiting` 은 에이전트가 세워져 있다는 뜻이다(`awaiting_approval`). `resolved`
 * 는 개입이 끝났고 에이전트가 다시 말할 수 있다는 뜻이며, **무엇이 끝났는가는
 * `outcome` 이 따로 말한다**. `stopped` 은 사람이 run 을 멈춘 것이라 핸드오프
 * 터미널이 아니다(모듈 머리말).
 */
export type LoginHandoffPhase = "waiting" | "resolved" | "stopped";

/**
 * 경계 사실. 증보 3 D3 이 에이전트에게 허락한 것과 정확히 같은 세 가지이고,
 * 그 이상은 이 타입에 담을 칸이 없다 — 프레임도 키 입력도 grantee 도 없다.
 */
export interface LoginHandoffControl {
  /** 정지 시각. 사람이 화면을 잡은 순간. */
  startedAtMs: number;
  /** 재개 시각. 창이 아직 열려 있으면 null. */
  endedAtMs: number | null;
  /** 왜 닫혔는가. 열려 있는 동안은 null. */
  endReason: LoginHandoffOutcome | null;
}

export interface LoginHandoffCard {
  kind: "login_handoff";
  /** 결정할 대상. 없으면 이 카드는 읽을 것일 뿐 누를 것이 아니다. */
  approvalId: string | null;
  /**
   * 이 핸드오프가 붙어 있는 작업 세션.
   *
   * 딥링크 하나를 위해서만 읽고 **문자로는 그리지 않는다** — id 는 사람이 그것을
   * 보고 결정할 수 있는 것이 아니다(`agentCardModel` 의 `run_id`·`channel_id` 와
   * 같은 격). 없을 수 있고, 없으면 딥링크가 서지 않는다.
   */
  sessionId: string | null;
  title: string;
  /** 에이전트가 쓴 요청 사유. 서버가 실어 보낸 것만, 쓰인 그대로. */
  reason?: string;
  phase: LoginHandoffPhase;
  /** 개입이 어떻게 끝났는가. `waiting`·`stopped` 에서는 null. */
  outcome: LoginHandoffOutcome | null;
  /** 경계 사실. 창이 열린 적이 없으면 null. */
  control: LoginHandoffControl | null;
  decidedByMemberId?: string;
  decidedAtMs?: number;
  detail: PayloadDetail;
}

// ---- copy -------------------------------------------------------------------

export const LOGIN_HANDOFF_TITLE = "로그인 핸드오프 요청";

/**
 * 배포 사실. **세션 사실이 아니다** — 다시 시도해서 달라지는 것이 아니고,
 * 읽는 사람이 고칠 수 있는 것도 아니다. 그래서 오류 격이 아니라 안내 격이고,
 * 옆에 버튼을 세우지 않는다(어포던스 부재 원칙).
 *
 * 이 문장이 「연결 안 됨」과 같은 옷을 입으면 사람이 새로고침을 반복한다. 그
 * 구분이 2분법의 전부다.
 */
export const LOGIN_HANDOFF_DEPLOYMENT_COPY =
  "이 배포에서는 아직 화면 전송이 준비되지 않아, 채팅에서 화면을 여는 동선이 없습니다. 세션 화면을 연 뒤 개입을 마쳤다면 여기서 재개를 누르세요.";

/** 지금 누군가 이 세션 화면을 잡고 있을 때. 사고가 아니라 때의 문제다. */
export const LOGIN_HANDOFF_IN_CONTROL_COPY =
  "지금 이 세션 화면을 직접 조작하는 사람이 있습니다. 조작이 끝나면 여기서 재개하거나 중단할 수 있습니다.";

/** 폰처럼 결정 동선이 없는 표면이 말할 문장. */
export const LOGIN_HANDOFF_ELSEWHERE_COPY =
  "직접 조작은 데스크톱이나 웹에서 할 수 있습니다. 이 화면에서는 진행 상황만 보여 줍니다.";

/** 이 기기가 지금 결정을 보낼 수 없을 때. `approvalNote` 의 문장과 같은 꼴이다. */
export const LOGIN_HANDOFF_OFFLINE_COPY =
  "연결이 끊겨 지금은 결정할 수 없습니다. 다시 연결되면 여기서 재개하거나 중단할 수 있습니다.";

/** 개입이 끝난 방식의 이름. 칩 한 낱말. */
export const LOGIN_HANDOFF_OUTCOME_LABEL: Readonly<
  Record<LoginHandoffOutcome, string>
> = {
  returned: "개입 완료",
  expired: "완료 불확실",
  session_ended: "세션 종료",
};

/**
 * 그 방식이 **에이전트에게 무엇을 뜻하는가**. 세 문장이 다른 이유가 이 카드가
 * 존재하는 이유다: `expired` 를 「완료」로 읽으면 에이전트가 로그인되지 않은
 * 화면 위에서 다음 단계를 밟는다.
 */
export const LOGIN_HANDOFF_OUTCOME_DETAIL: Readonly<
  Record<LoginHandoffOutcome, string>
> = {
  returned:
    "사람이 개입을 마치고 화면을 돌려주었습니다. 에이전트는 로그인이 끝났다고 보고 이어서 진행합니다.",
  expired:
    "개입이 끝났다는 신호 없이 연결이 끊겼습니다. 에이전트는 완료를 가정하지 않고, 자기 화면에서 상태를 확인한 뒤 진행합니다.",
  session_ended: "작업 세션이 끝나면서 조작 창도 닫혔습니다.",
};

/** 카드 국면의 이름. `stopped` 은 run 의 낱말을 그대로 쓴다. */
export const LOGIN_HANDOFF_PHASE_LABEL: Readonly<
  Record<LoginHandoffPhase, string>
> = {
  waiting: "개입 대기",
  resolved: "개입 완료",
  stopped: "중단됨",
};

/** 대기 중인 카드가 사람에게 무엇을 부탁하는지. */
export const LOGIN_HANDOFF_WAITING_COPY =
  "에이전트가 멈춰서 사람을 기다립니다. 비밀번호는 에이전트에게 전달되지 않고, 사람이 세션 화면에 직접 넣습니다.";

/**
 * 이 카드의 두 결정이 부르는 이름.
 *
 * 낱말만 다르고 **기계는 승인 카드의 것 그대로**다: 같은 결정 REST, 같은 멱등
 * 키, 같은 2단 무장, 같은 409 문장. 그래서 여기 있는 것은 문장뿐이고 판정은
 * 하나도 없다.
 *
 * `stop` 의 확정 문장이 「대기 중인」을 달고 있는 이유는 거부 문장이 그것을 달고
 * 있는 이유와 같다: 취소 UPDATE 가 `WHERE status='awaiting_approval'` 로 가드돼
 * 있어, hold 를 이미 떠난 run 은 취소 대상이 아니다. 한정어 없는 문장은 그 경우에
 * 거짓이 된다.
 *
 * 코어에 두는 이유는 두 클라가 같은 낱말을 봐야 하기 때문만이 아니다. 폰은 이
 * 낱말을 **그리지 않는 것이 계약**이고(안내 동선), 그 부재는 낱말이 한 곳에
 * 있어야 시험으로 지킬 수 있다.
 */
export const LOGIN_HANDOFF_DECISION = {
  /** 에이전트를 이어서 진행시킨다. 승인과 같은 REST. */
  resume: "재개",
  /** run 을 멈춘다. 거부와 같은 REST. */
  stop: "중단",
  resumeCommit: "재개 확정",
  stopCommit: "중단 확정",
  resumeConfirm:
    "개입이 끝난 것으로 기록하고 에이전트를 이어서 진행시킵니다.",
  stopConfirm: "중단하면 대기 중인 실행이 취소됩니다.",
  lead: "에이전트가 사람의 개입을 기다립니다.",
} as const;

/**
 * 칩에 서는 한 낱말.
 *
 * 결과가 있으면 **결과의 낱말이 이긴다**. 국면(`resolved`)은 「끝났다」만 말하고,
 * 사람이 알아야 하는 것은 어떻게 끝났느냐다 — 「개입 완료」와 「완료 불확실」이
 * 같은 칩을 쓰면 이 카드가 구분하려고 만들어진 두 사실이 화면에서 다시 합쳐진다.
 *
 * 두 클라가 같은 자리에서 같은 낱말을 쓰게 하려고 코어가 답한다.
 */
export function loginHandoffStatusLabel(
  card: Pick<LoginHandoffCard, "phase" | "outcome">
): string {
  return card.outcome !== null
    ? LOGIN_HANDOFF_OUTCOME_LABEL[card.outcome]
    : LOGIN_HANDOFF_PHASE_LABEL[card.phase];
}

// ---- the note that stands where a control would --------------------------

/**
 * 줄이 선 이유. 톤은 `approvalNote` 의 것을 그대로 쓴다 — 같은 카드 가족이
 * 같은 격 체계를 쓰지 않으면 한 타임라인에서 같은 성질의 문장이 두 옷을 입는다.
 */
export type LoginHandoffNoteKind =
  | "receipt"
  | "in-control"
  | "offline"
  | "elsewhere"
  | "unsupported";

export interface LoginHandoffNote {
  kind: LoginHandoffNoteKind;
  tone: ApprovalNoteTone;
  text: string;
}

export interface LoginHandoffNoteInput {
  /** 원장이 방금 답해 준 영수증 문장. 있으면 이 사람은 이미 결정했다. */
  receiptNote?: string | null;
  /** 이 카드에 결정할 대상이 있는가. */
  hasTarget: boolean;
  /** 이 요청이 이미 끝났는가. */
  settled: boolean;
  /** 지금 이 세션 화면을 누군가 잡고 있는가(창이 열려 있는가). */
  underControl: boolean;
  /** 이 표면에서 결정할 수 있는가. 폰은 거짓이다. */
  decidableHere: boolean;
  /** 이 기기가 지금 결정을 보낼 수 있는가. */
  offline: boolean;
  /** 이 서버에 승인 원장 표면이 있는가. */
  approvalsProvided?: boolean;
  /** 표면 부재를 설명하는 문장. 화면이 들고 있다. */
  unsupportedText?: string | null;
}

/**
 * 컨트롤 대신 설 줄, 또는 `null`(컨트롤이 선다).
 *
 * 순서가 곧 계약이고 `approvalNote` 의 순서를 이유까지 그대로 승계한다. 이
 * 카드만의 항목은 **`in-control`** 하나이고, 그것이 두 번째인 이유:
 *
 *   1. **영수증이 먼저.** 결정한 순간 대기 목록에서 빠지므로, 뒤에 두면 방금
 *      누른 사람이 자기 영수증 대신 다른 안내를 읽는다.
 *   2. **창이 열려 있으면 컨트롤을 세우지 않는다.** 사람이 비밀번호를 넣고 있는
 *      중에 재개를 누르면 서버는 그 run 을 다시 세우기만 한다(비관측 게이트가
 *      409 로 거절한다) — 즉 눌러도 아무 일이 일어나지 않는 버튼이다. 「때」의
 *      문제이므로 `blocked` 이지 오류가 아니다.
 *   3. **끝난 카드는 여기서 할 말이 없다.** 결과 줄이 이미 말한다.
 *   4. **원장 없는 서버**가 다른 안내보다 앞이다: 그 서버에서는 다른 자리로
 *      가도, 다시 연결돼도 아무 일도 일어나지 않는다.
 *   5. **이 표면에서는 결정할 수 없다** → 자리의 문제.
 *   6. **지금 보낼 수 없다** → 때의 문제.
 */
export function loginHandoffNote(
  input: LoginHandoffNoteInput
): LoginHandoffNote | null {
  const receipt = input.receiptNote?.trim();
  if (receipt) {
    return { kind: "receipt", tone: "receipt", text: receipt };
  }
  if (!input.settled && input.underControl) {
    return {
      kind: "in-control",
      tone: "blocked",
      text: LOGIN_HANDOFF_IN_CONTROL_COPY,
    };
  }
  if (input.settled || !input.hasTarget) return null;
  if (input.approvalsProvided === false) {
    const text = input.unsupportedText?.trim();
    return {
      kind: "unsupported",
      tone: "guidance",
      text: text ? text : LOGIN_HANDOFF_ELSEWHERE_COPY,
    };
  }
  if (!input.decidableHere) {
    return {
      kind: "elsewhere",
      tone: "guidance",
      text: LOGIN_HANDOFF_ELSEWHERE_COPY,
    };
  }
  if (input.offline) {
    return {
      kind: "offline",
      tone: "blocked",
      text: LOGIN_HANDOFF_OFFLINE_COPY,
    };
  }
  return null;
}

// ---- parsing ----------------------------------------------------------------

function readString(
  props: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = props?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readMs(
  props: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = props?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

export function parseLoginHandoffOutcome(
  value: unknown
): LoginHandoffOutcome | null {
  return typeof value === "string" && OUTCOMES.has(value)
    ? (value as LoginHandoffOutcome)
    : null;
}

/**
 * 창 원장 투영을 카드 props 에서 읽는다.
 *
 * 정지 시각이 없으면 창이 없는 것이다: 끝난 시각만 실려 온 봉투는 반쪽이므로
 * 아예 읽지 않는다 — 「언제 재개됐는지는 아는데 언제 정지했는지는 모른다」는
 * 화면은 사람에게 답보다 질문을 남긴다.
 */
export function parseLoginHandoffControl(
  props: Record<string, unknown> | undefined
): LoginHandoffControl | null {
  const startedAtMs = readMs(props, "control_started_at_ms");
  if (startedAtMs === undefined) return null;
  const endedAtMs = readMs(props, "control_ended_at_ms");
  const endReason = parseLoginHandoffOutcome(props?.["control_end_reason"]);
  return {
    startedAtMs,
    endedAtMs: endedAtMs ?? null,
    // 닫힌 시각 없이 사유만 온 봉투도 반쪽이다. 창은 아직 열려 있는 것으로 읽는다.
    endReason: endedAtMs === undefined ? null : endReason,
  };
}

/**
 * 승인 축과 창 축에서 카드의 국면·결과를 정한다.
 *
 * 우선순위가 계약이다:
 *
 *   1. **거부·취소는 `stopped`.** 사람이 run 을 멈춘 것이고, 그 뒤에 창이 어떻게
 *      닫혔든 에이전트는 다시 말하지 않는다.
 *   2. **창 원장이 말한 사유가 있으면 그것.** 원장이 자기 낱말을 갖고 있는데
 *      승인 축에서 되짚는 것은 한 다리 건넌 추측이다.
 *   3. **승인이 만료됐으면 `expired`.** 아무도 답하지 않은 채 hold 가 끝난 것은
 *      정확히 「중단·완료 불확실」이다.
 *   4. **승인됐는데 창 기록이 없으면 `returned`.** 사람이 재개를 눌렀다는 것은
 *      「개입을 마쳤다」는 명시 신호다(설계 정본 §1-2: 명시 버튼이 주동선,
 *      lapse 는 안전망).
 */
export function loginHandoffStateFor(
  status: ApprovalStatus,
  control: LoginHandoffControl | null
): { phase: LoginHandoffPhase; outcome: LoginHandoffOutcome | null } {
  if (status === "rejected" || status === "cancelled") {
    return { phase: "stopped", outcome: null };
  }
  if (status === "pending") return { phase: "waiting", outcome: null };
  if (control?.endReason) {
    return { phase: "resolved", outcome: control.endReason };
  }
  if (status === "expired") return { phase: "resolved", outcome: "expired" };
  return { phase: "resolved", outcome: "returned" };
}

/**
 * 이 메시지가 로그인 핸드오프 카드인가, 그렇다면 무엇을 그리는가.
 *
 * `agentCardModel` 이 `approval_request` 갈래 안에서 이 함수를 먼저 부른다.
 * 결정할 대상도 사유도 없는 봉투는 카드가 아니라 그냥 문장이므로 `null` 이다.
 */
export function loginHandoffCard(
  props: Record<string, unknown> | undefined
): LoginHandoffCard | null {
  if (!props || props["kind"] !== LOGIN_HANDOFF_KIND) return null;
  const approvalId = readString(props, "approval_id") ?? null;
  const status =
    parseApprovalStatus(props["approval_status"]) ??
    parseApprovalStatus(props["status"]) ??
    "pending";
  const control = parseLoginHandoffControl(props);
  const { phase, outcome } = loginHandoffStateFor(status, control);

  const card: LoginHandoffCard = {
    kind: "login_handoff",
    approvalId,
    sessionId: readString(props, "session_id") ?? null,
    title: readString(props, "title") ?? LOGIN_HANDOFF_TITLE,
    phase,
    outcome,
    control,
    detail: payloadDetail(props),
  };
  // 본문(`message.body`)이 아니라 `summary` 를 읽는다. 본문은 서버가 쓴 영어 한
  // 줄이고(`approval_request_body`), 사유는 에이전트가 쓴 한국어 문장이다.
  const reason = readString(props, "summary");
  if (reason !== undefined) card.reason = reason;
  const decidedBy = readString(props, "decided_by");
  if (decidedBy !== undefined) card.decidedByMemberId = decidedBy;
  const decidedAtMs = readMs(props, "decided_at_ms");
  if (decidedAtMs !== undefined) card.decidedAtMs = decidedAtMs;
  return card;
}
