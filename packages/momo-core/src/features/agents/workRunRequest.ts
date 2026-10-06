import { NetworkError } from "../../lib/http";

// =============================================================================
// 「작업 맡기기」 — 호스티드 에이전트에게 type=work 요청을 만드는 호출의 순수 부분
// (이슈 #3587 N7, ADR-0198 D4 「에이전트(대체)」 경로, ADR-0162 증보 3 D10).
//
// `lib/api.ts`의 `createAgentWorkRun`이 요청을 보내고, 이 파일은 (1) 서버가
// 받아 줄 모양으로 입력을 다듬는 일과 (2) 거절을 사람 말로 바꾸는 일만 한다.
// 폰·웹이 같은 문장을 쓰도록 한 곳에 둔다. 상태 코드는 화면에 나가지 않는다.
//
// 서버 한도는 문자 수가 아니라 **UTF-8 바이트 수**다
// (`routes/agent_runs.rs` `required_string`의 `raw.len() > limit`). 한글은 한 글자가
// 3바이트라서 제목 200은 한글 약 66자다. 글자 수로 재면 서버만 400을 낸다.
// =============================================================================

export const WORK_TITLE_MAX_BYTES = 200;
export const WORK_BRIEF_MAX_BYTES = 16_384;
export const WORK_REPO_MAX_BYTES = 2_048;
export const WORK_BRANCH_MAX_BYTES = 512;

/** 사용자가 채우는 값. `clientRunId`는 한 번의 「맡기기」 의도마다 하나다. */
export interface WorkRunDraft {
  agentMemberId: string;
  clientRunId: string;
  title: string;
  brief: string;
  repo?: string | undefined;
  branch?: string | undefined;
}

/** 서버로 나가는 `input`. 닫힌 키 집합이라 모르는 키를 싣지 않는다. */
export interface WorkRunInput {
  type: "work";
  title: string;
  brief: string;
  repo?: string;
  branch?: string;
}

export type WorkRunField = "title" | "brief" | "repo" | "branch";

/** 보내기 전에 막은 입력. 서버는 호출되지 않았다. */
export class WorkRunDraftError extends Error {
  readonly field: WorkRunField;
  readonly sentence: string;
  constructor(field: WorkRunField, sentence: string) {
    super(sentence);
    this.name = "WorkRunDraftError";
    this.field = field;
    this.sentence = sentence;
  }
}

const FIELD_LABEL: Record<WorkRunField, string> = {
  title: "제목",
  brief: "설명",
  repo: "저장소",
  branch: "브랜치",
};

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function trimmed(
  field: WorkRunField,
  raw: string | undefined,
  limit: number,
  required: boolean
): string | undefined {
  const value = (raw ?? "").trim();
  if (value === "") {
    if (required) {
      throw new WorkRunDraftError(field, `${FIELD_LABEL[field]}을 적어 주세요.`);
    }
    return undefined;
  }
  if (utf8ByteLength(value) > limit) {
    throw new WorkRunDraftError(
      field,
      `${FIELD_LABEL[field]}이 너무 길어요. 조금 줄여 주세요.`
    );
  }
  return value;
}

/**
 * 서버가 하는 정규화(공백 다듬기, 빈 선택값 생략)를 보내기 전에 똑같이 한다.
 * 재시도마다 같은 입력이 나가야 서버의 멱등 비교(`run.input != input`)가
 * 409로 되지 않는다.
 */
export function normalizeWorkRunInput(draft: WorkRunDraft): WorkRunInput {
  const title = trimmed("title", draft.title, WORK_TITLE_MAX_BYTES, true) as string;
  const brief = trimmed("brief", draft.brief, WORK_BRIEF_MAX_BYTES, true) as string;
  const repo = trimmed("repo", draft.repo, WORK_REPO_MAX_BYTES, false);
  const branch = trimmed("branch", draft.branch, WORK_BRANCH_MAX_BYTES, false);
  return {
    type: "work",
    title,
    brief,
    ...(repo === undefined ? {} : { repo }),
    ...(branch === undefined ? {} : { branch }),
  };
}

/** 한 번의 「맡기기」 의도를 가리키는 새 id. 재시도에는 같은 값을 다시 쓴다. */
export function newWorkRunClientId(): string {
  return crypto.randomUUID();
}

// ---- 거절을 사람 말로 -------------------------------------------------------

/** 서버가 이름 붙인 409 코드(`error.code`). 문구는 바뀌어도 코드는 바뀌지 않는다. */
export const WORK_RUN_REFUSAL_CODES = {
  hostedConnectionNotActive: "hosted_connection_not_active",
  hostedChannelNotApproved: "hosted_channel_not_approved",
  agentPaused: "agent_paused",
  claudeSubscriptionAgentPaused: "claude_subscription_agent_paused",
} as const;

export type WorkRunFailureReason =
  | "hosted_connection_not_active"
  | "hosted_channel_not_approved"
  | "agent_paused"
  | "claude_subscription_agent_paused"
  | "hosted_delivery_off"
  | "gateway_off"
  | "subscription_agents_off"
  | "idempotency_conflict"
  | "concurrent_limit"
  | "owner_only"
  | "guest_not_allowed"
  | "not_a_member"
  | "agent_not_found"
  | "invalid_input"
  | "rate_limited"
  | "unauthorized"
  | "server_error"
  | "network"
  | "unknown";

/**
 * 다음에 무엇을 할 수 있는지.
 * - `retry_same`: 같은 `clientRunId`로 다시 보내도 안전해요(요청이 갔는지 모를 때).
 * - `new_request`: 이 요청은 끝났어요. 다시 하려면 새 `clientRunId`가 필요해요.
 * - `edit`: 입력을 고쳐서 보내야 해요(고친 뒤에는 새 `clientRunId`).
 * - `fix_elsewhere`: 이 화면에서 못 고쳐요(연결·승인·소유자 문제).
 */
export type WorkRunFailureNext =
  | "retry_same"
  | "new_request"
  | "edit"
  | "fix_elsewhere";

export interface WorkRunFailure {
  reason: WorkRunFailureReason;
  /** 그대로 화면에 써도 되는 해요체 한 단락. 상태 코드·영문 원문이 없다. */
  sentence: string;
  next: WorkRunFailureNext;
  /** `WorkRunDraftError`일 때 어느 칸이 문제인지. */
  field?: WorkRunField;
}

interface Refusal {
  status: number;
  code: string | undefined;
  message: string;
}

function asRefusal(error: unknown): Refusal | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
  if (e.name !== "ApiError" || typeof e.status !== "number") return null;
  return {
    status: e.status,
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message.toLowerCase() : "",
  };
}

const MESSAGE_HINTS = {
  hostedDeliveryOff: "hosted agent delivery is not enabled",
  gatewayOff: "enabled byoa agent gateway",
  subscriptionOff: "subscription agents are disabled",
  idempotency: "idempotency conflict",
  concurrent: "concurrent run limit",
  paused: "agent is paused",
  ownerOnly: "owner only",
  guest: "guests cannot request work",
  notMember: "not an active human channel member",
} as const;

function fail(
  reason: WorkRunFailureReason,
  sentence: string,
  next: WorkRunFailureNext
): WorkRunFailure {
  return { reason, sentence, next };
}

/**
 * 거절 하나를 한 문장으로.
 *
 * 409는 코드를 먼저 읽고, 코드가 없는 옛 문구 409만 문구 일부로 한 번 더
 * 읽는다. 어느 쪽도 못 알아보면 짐작하지 않고 「잠시 뒤에 다시」로 떨어진다.
 * 이 호출은 거절될 때 run·job을 하나도 만들지 않으므로(서버가 쓰기 전에 거절)
 * 「요청이 접수되지 않았어요」라고 말해도 사실이다. 네트워크 실패만은 갔는지
 * 모르므로 그렇게 말하지 않고, 같은 `clientRunId`로 다시 보내라고 한다.
 */
export function workRunFailure(error: unknown): WorkRunFailure {
  if (error instanceof WorkRunDraftError) {
    return { reason: "invalid_input", sentence: error.sentence, next: "edit", field: error.field };
  }
  if (error instanceof NetworkError) {
    return fail(
      "network",
      "서버에 닿지 못했어요. 요청이 접수됐는지 알 수 없어서, 같은 내용으로 다시 보내면 한 번만 접수돼요.",
      "retry_same"
    );
  }
  const refusal = asRefusal(error);
  if (refusal === null) {
    return fail("unknown", "작업을 맡기지 못했어요. 잠시 뒤에 다시 시도해 주세요.", "retry_same");
  }
  const { status, code, message } = refusal;

  if (status === 409) {
    switch (code) {
      case WORK_RUN_REFUSAL_CODES.hostedConnectionNotActive:
        return fail(
          "hosted_connection_not_active",
          "이 에이전트는 지금 oort와 연결되어 있지 않아요. 연결이 다시 살아나면 맡길 수 있어요. 연결은 데스크탑에서 확인해요.",
          "fix_elsewhere"
        );
      case WORK_RUN_REFUSAL_CODES.hostedChannelNotApproved:
        return fail(
          "hosted_channel_not_approved",
          "이 채널은 아직 이 에이전트에게 승인되지 않았어요. 승인된 채널에서 맡겨 주세요.",
          "fix_elsewhere"
        );
      case WORK_RUN_REFUSAL_CODES.claudeSubscriptionAgentPaused:
        return fail(
          "claude_subscription_agent_paused",
          "이 서버에서는 Claude 구독 에이전트를 쉬게 해 두었어요. 지금은 이 에이전트에게 맡길 수 없어요.",
          "fix_elsewhere"
        );
      case WORK_RUN_REFUSAL_CODES.agentPaused:
        return fail(
          "agent_paused",
          "이 에이전트가 잠시 멈춰 있어요. 다시 켜진 뒤에 맡겨 주세요.",
          "new_request"
        );
      default:
        break;
    }
    if (message.includes(MESSAGE_HINTS.idempotency)) {
      return fail(
        "idempotency_conflict",
        "같은 요청 번호로 다른 내용이 이미 접수돼 있어요. 새 요청으로 다시 맡겨 주세요.",
        "new_request"
      );
    }
    if (message.includes(MESSAGE_HINTS.concurrent)) {
      return fail(
        "concurrent_limit",
        "이 에이전트가 이미 맡은 일이 많아요. 하나가 끝난 뒤에 다시 맡겨 주세요.",
        "new_request"
      );
    }
    if (message.includes(MESSAGE_HINTS.paused)) {
      return fail(
        "agent_paused",
        "이 에이전트가 잠시 멈춰 있어요. 다시 켜진 뒤에 맡겨 주세요.",
        "new_request"
      );
    }
    if (message.includes(MESSAGE_HINTS.subscriptionOff)) {
      return fail(
        "subscription_agents_off",
        "이 서버에서는 구독 에이전트를 쓰지 않도록 꺼 두었어요. 운영자가 켜면 맡길 수 있어요.",
        "fix_elsewhere"
      );
    }
    if (message.includes(MESSAGE_HINTS.hostedDeliveryOff)) {
      return fail(
        "hosted_delivery_off",
        "이 서버에서는 외부 에이전트에게 일을 전달하는 기능이 꺼져 있어요. 운영자가 켜면 맡길 수 있어요.",
        "fix_elsewhere"
      );
    }
    if (message.includes(MESSAGE_HINTS.gatewayOff)) {
      return fail(
        "gateway_off",
        "이 서버는 아직 에이전트에게 일을 맡길 준비가 되어 있지 않아요.",
        "fix_elsewhere"
      );
    }
    return fail("unknown", "지금은 이 에이전트에게 맡길 수 없어요. 잠시 뒤에 다시 시도해 주세요.", "new_request");
  }

  if (status === 403) {
    if (message.includes(MESSAGE_HINTS.guest)) {
      return fail(
        "guest_not_allowed",
        "게스트는 외부 에이전트에게 작업을 맡길 수 없어요. 멤버로 초대받은 뒤에 맡겨 주세요.",
        "fix_elsewhere"
      );
    }
    if (message.includes(MESSAGE_HINTS.ownerOnly)) {
      return fail(
        "owner_only",
        "이 에이전트는 만든 사람만 쓸 수 있어요. 작업은 그 사람이 맡겨야 해요.",
        "fix_elsewhere"
      );
    }
    return fail(
      "not_a_member",
      "이 채널의 멤버만 작업을 맡길 수 있어요. 채널에 참여한 뒤에 맡겨 주세요.",
      "fix_elsewhere"
    );
  }

  if (status === 404) {
    return fail(
      "agent_not_found",
      "이 채널에서 그 에이전트를 찾지 못했어요. 목록을 새로 불러온 뒤에 다시 골라 주세요.",
      "new_request"
    );
  }
  if (status === 400 || status === 422) {
    return fail(
      "invalid_input",
      "입력을 서버가 받지 못했어요. 제목과 설명을 확인한 뒤에 다시 맡겨 주세요.",
      "edit"
    );
  }
  if (status === 401) {
    return fail("unauthorized", "로그인이 끝났어요. 다시 로그인한 뒤에 맡겨 주세요.", "retry_same");
  }
  if (status === 429) {
    return fail("rate_limited", "요청이 너무 잦아요. 잠시 뒤에 다시 시도해 주세요.", "retry_same");
  }
  if (status >= 500) {
    return fail(
      "server_error",
      "서버에 문제가 생겼어요. 요청이 접수됐는지 알 수 없어서, 같은 내용으로 다시 보내면 한 번만 접수돼요.",
      "retry_same"
    );
  }
  return fail("unknown", "작업을 맡기지 못했어요. 잠시 뒤에 다시 시도해 주세요.", "retry_same");
}
