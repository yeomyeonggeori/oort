import type { Message } from "../../lib/api";
import { parseApprovalStatus, toolNameOf } from "./agentCardModel";
import { shouldFoldBundleLine } from "./requestBundle";

// =============================================================================
// 끝난 도구 호출 카드가 「생각 중」으로 남는 결함 (#4986, 디자인 검수 M9)
//
// 서버는 `tool_call` 행을 한 번 쓰고 다시 고치지 않는다. 행의 props 는 `{name, arguments, call_id}` 가
// 전부이고(`server-rust/crates/momo-agent/src/tools.rs` `ToolCall::message_props`, 「Nothing else goes
// in」), 결과는 **다른 행**인 `tool_result`(`{call_id, output, is_error}`, 같은 파일 `ToolResult::
// message_props`)로 따로 온다. 그래서 호출 행에는 끝났다는 사실이 영영 실리지 않고, 카드 모델
// (`agentCardModel.toolCard`)은 `status` 가 없는 `tool_call` 을 「생각 중」으로 읽는다 — 결과가 이미
// 도착해 있어도 칩은 「생각 중」이고 캐럿이 계속 돈다.
//
// 끝났다는 사실은 클라이언트가 가진 목록 안에 있다: 같은 채널에 같은 `call_id` 의 `tool_result` 가
// 있으면 그 호출은 끝난 것이다. 이 파일은 그 판정을 한 곳에 둔다. 서버를 고치지 않는 까닭: 호출 행을
// 종결 패치하려면 `message.edited` 쓰기가 하나 더 생기는데, 클라이언트가 이미 가진 사실을 다시 쓰는 일이다.
//
// 결과가 아직 없으면(실행 중이거나 결과가 목록 밖) 손대지 않는다 — 그때의 「생각 중」은 맞는 말이다.
//
// #5009 가 같은 자리에 더한 둘:
//
// 1. **거부·만료·취소로 끝난 승인도 호출의 끝이다.** 그 승인은 결과 행을 쓰지 않고 승인 카드(`approval_request`)
//    를 제자리에서 고쳐 끝낸다(`momo-messaging/src/approval_card.rs` `settle_approval_card_in_tx`, 「No new
//    message or channel sequence is made」). 카드 props 에는 호출의 `call_id` 가 처음부터 실려 있으므로
//    (`momo-agent/src/approval.rs` `approval_request_props`) 종결된 카드의 `call_id` 로 같은 호출 카드를 **중단**으로
//    닫는다. 닫는 것은 거부·만료·취소 셋뿐이다: **승인됨** 카드는 닫지 않는다 — 승인 뒤 실행 중일 수 있고 그 끝은
//    결과 행이 말한다. 같은 호출에 결과 행과 종결 카드가 함께 있으면 **결과 행이 이긴다**(실제로 일어난 일이
//    카드의 상태보다 강한 근거다).
// 2. **결과 카드가 호출 행의 이름을 빌린다.** 결과 행 props 에는 도구 이름이 없어 카드 제목이 이름 없는 「도구
//    실행」이었다. 같은 `call_id` 의 호출 행 이름을 결과 행 사본에 `name` 으로 얹는다(`toolCard` 가 이미 읽는 키
//    이고 `PARSED_KEYS` 에 있어 「표시하지 않은 항목」 수는 그대로다). 결과 행이 자기 이름을 싣고 오면 그것이
//    먼저이고, 짝이 되는 호출 행이 목록에 없으면 손대지 않는다.
//
// #5066 (검증 줄 1회차 H2). **승인이 걸린 호출은 호출 카드가 따로 말하지 않는다.**
//
// 도구 승인 하나를 호출 카드와 승인 카드 두 장이 말하면 두 장이 서로 다른 사실을 말하는 순간이 생긴다. 호출 카드는
// 결과를 모르면 「생각 중」이 맞는 말이지만, 승인에 걸린 호출은 사람의 결정에 묶여 **돌지 않는다**(① 결정을
// 기다리는 내내 「생각 중」). 승인 카드는 기한이 지나면 시계로 「만료」를 말하는데 호출 카드에는 시계가 없다(②
// 서버가 정리하기 전까지 「생각 중」). 정리된 뒤에는 위의 1번이 사람이 멈췄다는 낱말 「중단됨」으로 닫아 바로 아래
// 「만료」와 다른 말을 한다(③). 같은 일을 가리키는 두 말이 갈라지는 길은 두 가지였다: 호출 카드가 묶음 상태를
// 계산하는 **같은 함수**(`requestBundleState`)를 시계·영수증·run 까지 같은 입력으로 한 번 더 부르거나, 묶음 카드가
// 말하는 호출은 **접어서** 따로 말하지 않게 하거나.
//
// 접는다. 이유: (a) 승인 카드 props 가 호출 카드가 보이는 전부(도구 이름·`call_id`·인자)를 이미 싣는다
// (`approval.rs` `approval_request_props`) — 접어도 사라지는 정보가 없다. (b) 호출 카드에서 같은 함수를 다시 부르려면
// 승인 카드가 상태를 만드는 입력(영수증 저장소·run 진행·`useExpiryNow` 시계, 폰은 원장 문과 `nowMs`)을 두 번째 그리는
// 자리마다 되풀이해야 하고, 그 입력이 하나라도 어긋나는 순간이 바로 이 결함이다 — 접으면 그 어긋남 자체가 없다. (c) 「한
// 요청은 한 묶음」(`docs/design-system/agent-request-loop.md` §0·§2)이 이미 가리키는 방향이다.
//
// 접는 조건은 **같은 목록·같은 채널에 같은 `call_id` 를 든 승인 카드(승인 id 가 있는 `approval_request`)가 지워지지
// 않고 있을 때**다. 짝 카드가 목록에 없으면(다른 목록에 있거나 아직 안 왔거나 지워졌으면) 지금처럼 결과 행이 말하는 대로
// 그리고, 호출이 승인에 걸렸는지 모르는 채 「생각 중」이라고 하는 것은 그때의 맞는 말이다. 접기는 `settleToolCalls`
// **뒤**에 한다: 접힌 호출 행의 이름을 결과 행이 빌려 가야 하기 때문이다.
// =============================================================================

type SettledStatus = "done" | "error" | "cancelled";

function callId(message: Message): string | undefined {
  const value = message.props?.["call_id"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const keyOf = (channelId: string, id: string) =>
  `${channelId.toLowerCase()}|${id}`;

/**
 * 결과 행이 말하는 호출의 끝. 거부·만료로 닫힌 호출은 실패가 아니라 중단이다(ADR-0132: 사람이 한 일과
 * 아무도 하지 않은 일은 오류가 아니다). 그 밖에 `is_error` 면 실패, 아니면 완료다.
 */
function settledStatus(result: Message): SettledStatus {
  const status = result.props?.["status"];
  if (status === "rejected" || status === "expired") return "cancelled";
  return result.props?.["is_error"] === true ? "error" : "done";
}

/**
 * 호출이 **돌지 않고** 끝났다고 말하는 승인 카드인가: 거부·만료·취소만이다(허용 목록 — 모르는 상태와 `approved`·
 * `pending` 은 호출을 닫지 않는다). 상태를 읽는 순서는 카드 모델(`approvalCard`)과 같다: `approval_status` →
 * `status`(서버가 둘을 한 패치로 함께 쓴다, `decided_props_patch`).
 */
function endsCallUnrun(card: Message): boolean {
  const status =
    parseApprovalStatus(card.props?.["approval_status"]) ??
    parseApprovalStatus(card.props?.["status"]);
  return status === "rejected" || status === "expired" || status === "cancelled";
}

/**
 * 같은 원본·같은 덧붙임이면 같은 사본을 돌려준다 — 행이 사본 정체성으로 다시 그려지지 않게 한다. 한 행에 얹는
 * 것은 하나다(호출 행은 `status`, 결과 행은 `name`).
 */
const COPIES = new WeakMap<Message, Map<string, Message>>();

function withProp(
  message: Message,
  key: "status" | "name",
  value: string
): Message {
  const slot = `${key}=${value}`;
  let bySlot = COPIES.get(message);
  if (bySlot === undefined) {
    bySlot = new Map();
    COPIES.set(message, bySlot);
  }
  let copy = bySlot.get(slot);
  if (copy === undefined) {
    copy = { ...message, props: { ...message.props, [key]: value } };
    bySlot.set(slot, copy);
  }
  return copy;
}

/**
 * 같은 목록의 짝을 보고 두 가지를 채워 돌려준다.
 *
 * - `tool_call` 행의 `props.status` 를 끝으로: 같은 `call_id` 의 결과 행(완료·실패·중단)이 있으면 그것으로,
 *   결과 행이 없고 종결된 승인 카드(거부·만료·취소)가 있으면 중단으로. 이미 상태를 싣고 온 행(서버가 말한
 *   것)은 덮지 않는다.
 * - 이름이 없는 `tool_result` 행의 `props.name` 을 같은 `call_id` 의 호출 행 이름으로.
 *
 * 바꿀 행이 없으면 **같은 배열**을 돌려줘서 호출자의 메모가 유지된다.
 *
 * 결과 행이 접힌(`shouldFoldBundleLine`) 뒤에는 이 판정을 할 수 없으니, 호출자는 접기 **전** 목록을
 * 넘긴다.
 */
export function settleToolCalls(
  messages: readonly Message[]
): readonly Message[] {
  const results = new Map<string, SettledStatus>();
  const unrun = new Set<string>();
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.state === "deleted") continue;
    const id = callId(message);
    if (id === undefined) continue;
    const key = keyOf(message.channelId, id);
    if (message.type === "tool_result") {
      results.set(key, settledStatus(message));
    } else if (message.type === "approval_request") {
      if (endsCallUnrun(message)) unrun.add(key);
    } else if (message.type === "tool_call") {
      const name = toolNameOf(message.props);
      if (name !== undefined) names.set(key, name);
    }
  }
  if (results.size === 0 && unrun.size === 0 && names.size === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    if (message.state === "deleted") return message;
    const id = callId(message);
    if (id === undefined) return message;
    const key = keyOf(message.channelId, id);
    if (message.type === "tool_call") {
      if (typeof message.props?.["status"] === "string") return message;
      const status = results.get(key) ?? (unrun.has(key) ? "cancelled" : undefined);
      if (status === undefined) return message;
      changed = true;
      return withProp(message, "status", status);
    }
    if (message.type === "tool_result") {
      if (toolNameOf(message.props) !== undefined) return message;
      const name = names.get(key);
      if (name === undefined) return message;
      changed = true;
      return withProp(message, "name", name);
    }
    return message;
  });
  return changed ? next : messages;
}

/**
 * 승인 카드가 대신 말하는 호출의 키들 (#5066). 승인 카드 = 승인 id 와 `call_id` 를 든, 지워지지 않은 `approval_request`.
 * 로그인 핸드오프 카드도 승인 카드 가족이라 같은 승인 id 를 들고 같이 센다. 재개 제안은 승인 id 도 `call_id` 도 없어
 * 저절로 빠진다. 키는 `settleToolCalls` 와 같은 `keyOf`(채널 + `call_id`)다.
 */
function approvalCallKeys(messages: readonly Message[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    if (message.type !== "approval_request" || message.state === "deleted") continue;
    const approvalId = message.props?.["approval_id"];
    if (typeof approvalId !== "string" || approvalId === "") continue;
    const id = callId(message);
    if (id !== undefined) keys.add(keyOf(message.channelId, id));
  }
  return keys;
}

/** 이 행은 승인 카드가 대신 말하는 호출 행인가: 지워지지 않은 `tool_call` 이고 짝 승인 카드가 같은 목록에 있다. */
function speaksThroughApproval(
  message: Message,
  approvalCalls: ReadonlySet<string>
): boolean {
  if (message.type !== "tool_call" || message.state === "deleted") return false;
  const id = callId(message);
  return id !== undefined && approvalCalls.has(keyOf(message.channelId, id));
}

/**
 * 타임라인·스레드가 행으로 그릴 메시지 (#4986). 끝난 도구 호출을 닫고(`settleToolCalls`), 종결 카드가
 * 설명하는 옛 줄을 접고(`shouldFoldBundleLine`), 승인이 걸린 호출은 짝 승인 카드 한 장이 말하게 접는다(#5066).
 * 세 판정이 같은 원본 목록을 보아야 서로의 근거를 잃지 않는다: 접힐 줄 가운데 도구 결과가 있을 수 있고 접힐 호출
 * 행의 이름을 결과 행이 빌려 가야 해서, 접은 **뒤** 목록으로 짝짓기를 하면 그 호출이 영영 「생각 중」으로 남거나
 * 결과 카드 제목이 이름을 잃는다. 웹의 본류(`Timeline`)와 스레드(`ThreadPanel`), 폰의 `Timeline` 이 이 한 함수를
 * 부른다.
 */
export function presentableRows(messages: readonly Message[]): Message[] {
  const approvalCalls = approvalCallKeys(messages);
  return settleToolCalls(messages).filter(
    (message) =>
      !shouldFoldBundleLine(message, messages) &&
      !speaksThroughApproval(message, approvalCalls)
  );
}
