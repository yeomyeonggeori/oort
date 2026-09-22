import { payloadDetail, type PayloadDetail, type PayloadRow } from "./agentCardModel";

// =============================================================================
// 워크스페이스 행동 결과 카드 (ADR-0186 D5 · 부록 B `momo.action_result.v1`)
//
// 에이전트가 제안하고 사람이 승인한 행동이 **끝난 뒤 남는** 카드다. 승인 카드가
// 「결정해 주세요」라면 이것은 「이렇게 됐습니다」이고, ADR-0182 D3 결정 트리의
// ③(지속 카드) 자리에 선다: 초대를 언제 누구에게 열어 줬는지는 나중에 다시 찾을
// 일이 있으므로 사라지는 확인이 될 수 없다.
//
// ## 이 카드에 **없는** 것이 계약의 절반이다 (D4)
//
// 초대 코드·웹훅 자격 같은 1회 값은 결정 HTTP 응답에만 실린다(부록 C). 이 카드가
// 읽는 props 에는 그 값을 담을 칸이 아예 없고(부록 B: "코드·URL 필드는 없다"),
// 그래서 이 파일에는 그것을 읽는 코드도 없다. 새로고침을 견디게 하려고 값을
// props 에 써 두는 구현이 D4 가 이름으로 금지한 위반이고, 이 모듈이 그 위반을
// 구조적으로 못 하게 한다 — 담을 필드가 없으면 실을 수도 없다.
//
// 대신 `secretShownOnce` 라는 **사실**만 싣는다. 「보여 준 적이 있다」는 값이
// 아니라 이력이고, 그 이력을 아는 것이 「그럼 지금 어떻게 다시 받나」라는 사람의
// 다음 질문에 답할 근거다 — 그 답이 `next` 다.
//
// ## `ref` 는 읽고 그리지 않는다
//
// `run_id`·`channel_id` 와 같은 격이다(`agentCardModel` 의 허용 목록 주석).
// 사람이 그것을 보고 무엇을 결정할 수 있는 id 가 아니고, 갈 수 있는 곳은
// `next` 가 이름 붙은 문으로 이미 가리킨다. 모델에 남겨 두는 이유는 폰 패리티
// (AX-7)와 E2E(AX-6)가 같은 행을 맞춰 봐야 하기 때문이고, 그 소비는 화면 글자가
// 아니다.
//
// ## 총 파싱, 그리고 모르면 카드가 아니다
//
// `v` 가 1 이 아니거나 `status` 가 이 빌드가 모르는 낱말이면 **null** 이다. 그때
// 행은 평범한 도구 결과로 떨어지고 본문이 그대로 보인다(D5 「모르는 kind 는 본문
// 폴백」). 반쯤 아는 결과 카드를 그리는 것 — 상태를 모르면서 행만 그리는 것 —
// 은 사람에게 무슨 일이 일어났는지 모른 채 일어난 일을 보여 주는 것이다.
// =============================================================================

/** 이 카드를 세우는 props 키. 서버가 `tool_result` props 에 붙인다. */
export const ACTION_RESULT_PROP_KEY = "momo.action_result";

/** 이 빌드가 읽는 `momo.action_result` 판. 다른 판은 본문 폴백이다. */
export const ACTION_RESULT_VERSION = 1;

/**
 * 행동이 어떻게 끝났는가. **부록 B 의 네 낱말 그대로**이고, 클라가 새로 짓는
 * 낱말은 하나도 없다.
 *
 *   executed       실행됐다.
 *   rejected       사람이 승인하지 않았다.
 *   expired        기한이 지났다.
 *   role_required  결정자의 역할이 모자라 서버가 실행하지 않았다(§5 의 403).
 */
export type ActionResultStatus =
  | "executed"
  | "rejected"
  | "expired"
  | "role_required";

const STATUSES: ReadonlySet<string> = new Set<ActionResultStatus>([
  "executed",
  "rejected",
  "expired",
  "role_required",
]);

/**
 * 칩에 서는 낱말.
 *
 * `role_required` 를 「실패」라고 부르지 않는다. 아무것도 고장나지 않았고, 사람이
 * 할 수 있는 다음 행동이 분명히 있다 — 권한을 가진 사람이 결정하면 된다. 침묵을
 * 실패로 승격하지 않는다는 이 저장소의 규율(ADR-0132)과 같은 계열이다.
 */
export const ACTION_RESULT_STATUS_LABEL: Readonly<
  Record<ActionResultStatus, string>
> = {
  executed: "실행됨",
  rejected: "거부됨",
  expired: "만료됨",
  role_required: "권한 필요",
};

/**
 * 카드가 상태에 대해 말하는 한 문장.
 *
 * 웹과 폰이 같은 문장을 쓰게 하려고 코어에 둔다(AX-7 이 두 번째 소비자다). 문장
 * 안에 감탄도 사과도 없다 — 무슨 일이 일어났는지와, 사람이 그다음에 무엇을 할 수
 * 있는지만 말한다.
 */
export const ACTION_RESULT_STATUS_NOTE: Readonly<
  Record<ActionResultStatus, string>
> = {
  executed: "실행을 마쳤습니다.",
  rejected: "승인하지 않아 실행하지 않았습니다.",
  expired: "기한이 지나 실행하지 않았습니다.",
  role_required: "관리자가 승인해야 합니다.",
};

/**
 * 1회 값이 어디로 갔는지 말하는 줄 (D4).
 *
 * 「없다」가 아니라 「한 번 보여 줬고 그 자리는 결정한 사람의 화면이었다」이다.
 * 없는 것을 없다고만 하면 사람은 화면이 잃어버렸다고 읽는다.
 */
export const ACTION_RESULT_SECRET_ONCE_NOTE =
  "링크는 승인한 사람에게 1회 표시됐습니다. 다시 필요하면 새로 만드세요.";

/** 카드가 그리는 행의 상한. 넘은 것은 개수로 말한다(정직 카운트). */
export const MAX_ACTION_RESULT_ROWS = 12;

/** 이 카드가 가리키는 대상. 화면 글자가 아니라 계보다(머리말 참고). */
export interface ActionResultRef {
  type: string;
  id: string;
}

/** 다음에 갈 수 있는 곳. 이름 붙은 문 하나. */
export interface ActionResultNext {
  label: string;
  href: string;
}

export interface AgentActionResultCard {
  kind: "action_result";
  /**
   * 카드 제목.
   *
   * 부록 B 에는 제목 칸이 없다. 그래서 서버가 그 메시지에 쓴 **본문**이 제목이
   * 되고(승인 카드가 `title` 없을 때 하는 것과 같은 일), 본문마저 없으면 이
   * 빌드의 중립 낱말이 선다. 카드가 본문을 되풀이하지 않는 것은
   * `cardKeepsBody` 가 답한다.
   */
  title: string;
  /** 레지스트리의 행동 id(`invite.create` 등). 화면에는 그리지 않는다. */
  actionId: string;
  status: ActionResultStatus;
  /** 이 결과를 낳은 승인. 없을 수 있다. */
  approvalId: string | null;
  /** 결정한 사람. 이름은 디렉터리가 푼다. */
  decidedByMemberId: string | null;
  ref: ActionResultRef | null;
  rows: PayloadRow[];
  /** 상한에 걸려 그리지 않은 행. 조용히 자르지 않는다. */
  omittedRows: number;
  /** 1회 값이 결정 응답에서 한 번 보였는가 (D4). */
  secretShownOnce: boolean;
  next: ActionResultNext | null;
  detail: PayloadDetail;
}

/** 이 카드의 기본 제목. 본문도 없는 메시지에만 쓰인다. */
export const ACTION_RESULT_FALLBACK_TITLE = "워크스페이스 행동";

type Props = Record<string, unknown> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 행 하나. 라벨과 값이 **둘 다** 글자일 때만 행이다. */
function parseRow(value: unknown): PayloadRow | null {
  if (!isRecord(value)) return null;
  const label = nonEmptyString(value.label);
  const raw = value.value;
  if (label === null || typeof raw !== "string") return null;
  return { label, value: raw };
}

function parseRef(value: unknown): ActionResultRef | null {
  if (!isRecord(value)) return null;
  const type = nonEmptyString(value.type);
  const id = nonEmptyString(value.id);
  return type !== null && id !== null ? { type, id } : null;
}

function parseNext(value: unknown): ActionResultNext | null {
  if (!isRecord(value)) return null;
  const label = nonEmptyString(value.label);
  const href = nonEmptyString(value.href);
  return label !== null && href !== null ? { label, href } : null;
}

export function parseActionResultStatus(
  value: unknown
): ActionResultStatus | null {
  return typeof value === "string" && STATUSES.has(value)
    ? (value as ActionResultStatus)
    : null;
}

/**
 * `tool_result` props 를 결과 카드로 읽는다. 아니면 `null` 이고, 그때 행은
 * 평범한 도구 결과로 떨어진다.
 *
 * `body` 를 함께 받는 이유는 제목 때문이다(위 `title` 주석). 메시지 전체가 아니라
 * 본문 문자열만 받는 것은 이 함수가 메시지 타입 판정을 지지 않기 때문이다 — 그
 * 판정은 `agentCardModel` 한 곳에 있다.
 */
export function actionResultCard(
  props: Props,
  body: string | null | undefined
): AgentActionResultCard | null {
  const raw = props?.[ACTION_RESULT_PROP_KEY];
  if (!isRecord(raw)) return null;
  if (raw.v !== ACTION_RESULT_VERSION) return null;

  const actionId = nonEmptyString(raw.action_id);
  const status = parseActionResultStatus(raw.status);
  if (actionId === null || status === null) return null;

  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  const parsedRows: PayloadRow[] = [];
  let omittedRows = 0;
  for (const candidate of rawRows) {
    const row = parseRow(candidate);
    if (row === null) {
      omittedRows += 1;
      continue;
    }
    if (parsedRows.length >= MAX_ACTION_RESULT_ROWS) {
      omittedRows += 1;
      continue;
    }
    parsedRows.push(row);
  }

  return {
    kind: "action_result",
    title: nonEmptyString(body) ?? ACTION_RESULT_FALLBACK_TITLE,
    actionId,
    status,
    approvalId: nonEmptyString(raw.approval_id),
    decidedByMemberId: nonEmptyString(raw.decided_by),
    ref: parseRef(raw.ref),
    rows: parsedRows,
    omittedRows,
    secretShownOnce: raw.secret_shown_once === true,
    next: parseNext(raw.next),
    detail: payloadDetail(props),
  };
}
