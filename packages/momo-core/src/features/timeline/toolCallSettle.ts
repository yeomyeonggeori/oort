import type { Message } from "../../lib/api";
import { actionResultCard } from "./actionResultCard";
import { parseApprovalStatus, toolNameOf } from "./agentCardModel";
import { loginHandoffCard } from "./loginHandoffCard";
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
//
// #5168 (검증 줄 3회차, #5066 의 다음 국면). **승인한 도구 호출은 같은 호출의 결과가 승인 카드를 닫고, 그 결과 행은 따로 서지
// 않는다.**
//
// 승인된 도구 호출은 결정 뒤 워커에서 실행되고, 끝은 같은 `call_id` 의 `tool_result` 행으로 따로 온다(승인 뒤 도구가 도는 길의
// 결과 줄은 모델의 도구 결과라서 서버는 그대로 쓴다, ADR-0186 증보 v6 R-b 4). 승인 카드는 그때 다시 고쳐지지 않는다: 도구
// 승인의 승인은 `result` 없이 `status: "approved"` 만 쓰고 「실행 중 → 끝」은 run 이 말하기로 했다(같은 증보 R-b 2, 디자인
// 시스템 `agent-request-loop.md` §2.2·§2.4). 그런데 카드가 「끝」을 아는 길(run)은 **목록 밖의 상태**에 기댄다:
//
// - 폰은 진행 읽기의 `bundle.approvalId` 로 run 을 카드에 잇는다(서버는 결정 뒤에도 그 run 이 물은 가장 최근 승인을 싣는다,
//   `run_bundle.rs`). 이어진 run 이 끝났으면 `requestBundleState` 가 「끝」을 말한다(폰 시험: 이어진 `succeeded` run 은 「끝」,
//   run 이 없으면 「실행 중」). 그러나 이 읽기는 채널의 최근 run 30개를 프레임과 열린 run 이 있는 동안의 30초 폴링으로 읽어서
//   늦거나(스토어 머리말: 한 묶음의 마지막 행은 프레임 없이 끝날 수 있다) 창 밖이면(오래된 승인) 카드에 닿지 않는다.
// - 웹의 카드도 같은 길로 이어진 run 을 읽는다(#5254: `approvalBundleContext` 가 run 을 문맥에 싣는다). 이 줄을 쓸 때(#5168)는 문맥에
//   `run` 이 없어서 승인 뒤 카드가 어느 경우에도 「실행 중」에 머물렀다. 폰과 같이 run 이 늦거나 창 밖이면 카드에 닿지 않는 틈은 남는다.
//
// 한편 도구의 `tool_result` 행은 run 이 끝나기 전에 `message.new` 로 목록에 이미 와 있다. 그래서 카드는 「실행 중 · 승인됐어요
// · 이어서 하는 중」, 결과 행은 도구 카드로 「완료」를 말하는 — 한 호출에 카드가 둘이고 서로 다른 말을 하는 — 순간이 길게 남았다
// (`requestBundleState` 의 「승인은 실행 허가일 뿐, 결과나 run 종결이 오기 전에는 완료를 추측하지 않는다」는 맞는 말이고,
// 결과가 목록에 와 있는데도 카드가 모르는 것이 틀린 쪽이다).
//
// 목록이 이미 가진 사실로 닫는다. 같은 채널에서 같은 `call_id` 를 든 **지워지지 않은 결과 행이 승인 카드보다 뒤에** 있으면 그
// 호출은 끝났다(실패하면 `is_error`). 카드 사본에 서버가 행동 승인에 쓰는 것과 같은 모양의 `props.result.status`(`executed` ·
// `failed`)를 얹으면 웹·폰이 이미 읽는 코어 판정(`requestBundleState`)이 「끝」·「실패」를 말한다 — 클라이언트가 새 판정을
// 갖지 않는다. 결과 행은 카드가 그 일을 말하므로 접는다(「한 요청은 한 묶음」, 같은 문서 §0). 닫는 조건은 좁다:
//
// - **승인됨 카드만.** 대기·거부·만료·취소 카드는 건드리지 않는다. `terminalState` 는 `result` 를 `status` 보다 앞에 읽어서
//   거부 카드에 `result` 를 얹으면 「거부」가 「취소」로 바뀌고, 낡은 대기 카드를 닫으면 결정 버튼이 사라진다.
// - **결과가 카드보다 뒤에, 같은 호출의 다음 승인 카드보다 앞에 있을 때만.** 도구는 승인 뒤에만 돈다. 같은 `call_id` 를 다시 쓴
//   앞 호출의 결과가 새 승인을 닫으면 안 되고, 결과 하나는 카드 하나만 닫는다(채널 순서 `seq` 로 가른다).
// - **도구 승인만.** 행동 승인(`workspace_action`)은 결정과 같은 트랜잭션에서 끝나 카드가 곧장 「끝」이고, 옛 실행됨 카드는
//   기록이다. 로그인 핸드오프는 제 카드 모델이 말한다. 서버가 이미 `result` 를 쓴 카드는 서버가 말한 것이라 덮지 않는다.
// - **평범한 결과 행만 접는다.** 거부·만료로 닫힌 옛 줄(`status`)과 행동 결과 카드는 승인 카드가 대신 말하는 일이 아니라
//   기록이라 그대로 선다.
//
// 이 결과 행의 한 줄 요약(출력 첫 줄)은 타임라인에 더는 서지 않는다. 카드는 출력 원문을 말하지 않는다(사람 화면용 필드에 영어
// 원문을 두지 않는다, 같은 문서 §2.4). 필요하면 「자세히」에 두는 후속이다.
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

function withProps(
  message: Message,
  slot: string,
  patch: Record<string, unknown>
): Message {
  let bySlot = COPIES.get(message);
  if (bySlot === undefined) {
    bySlot = new Map();
    COPIES.set(message, bySlot);
  }
  let copy = bySlot.get(slot);
  if (copy === undefined) {
    copy = { ...message, props: { ...message.props, ...patch } };
    bySlot.set(slot, copy);
  }
  return copy;
}

function withProp(
  message: Message,
  key: "status" | "name",
  value: string
): Message {
  return withProps(message, `${key}=${value}`, { [key]: value });
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

/** 승인 카드를 닫는 도구 결과: 카드 사본에 얹을 `result.status` 와, 카드가 대신 말하게 된 결과 행의 id. */
type ApprovalToolEnd = "executed" | "failed";

interface ApprovalToolEnds {
  /** 승인 카드 메시지 id → 그 호출의 끝. */
  readonly byCard: ReadonlyMap<string, ApprovalToolEnd>;
  /** 승인 카드가 대신 말해서 따로 서지 않는 결과 행의 id. */
  readonly folded: ReadonlySet<string>;
}

const NO_ENDS: ApprovalToolEnds = { byCard: new Map(), folded: new Set() };

/**
 * 승인 카드가 대신 말할 수 있는 **평범한** 도구 결과인가: 지워지지 않았고 `call_id` 가 있고, 거부·만료로 닫힌 옛 줄(`status`)
 * 도 행동 결과 카드(`momo.action_result.v1`)도 아니다. 워커가 승인 뒤 도구를 실행해 쓰는 결과는 `{call_id, output,
 * is_error}` 가 전부다(`tools.rs` `ToolResult::message_props`).
 */
function isToolOutput(message: Message): boolean {
  return (
    message.type === "tool_result" &&
    message.state !== "deleted" &&
    callId(message) !== undefined &&
    typeof message.props?.["status"] !== "string" &&
    actionResultCard(message.props, message.body) === null
  );
}

/**
 * 결정을 받고 **실행 중일 수 있는** 도구 승인 카드인가: 승인 id 와 `call_id` 가 있고, 도구 승인(`action_type: "tool_call"`)이고,
 * 상태가 승인됨이며(카드 모델과 같은 순서 `approval_status` → `status`), 로그인 핸드오프·재개 제안이 아니고, 서버가 아직
 * `result` 를 쓰지 않았다.
 */
function isRunningToolApproval(message: Message): boolean {
  if (message.type !== "approval_request" || message.state === "deleted") {
    return false;
  }
  const props = message.props;
  const approvalId = props?.["approval_id"];
  if (typeof approvalId !== "string" || approvalId === "") return false;
  if (callId(message) === undefined) return false;
  if (props?.["action_type"] !== "tool_call") return false;
  if (props?.["kind"] === "resume_offer" || loginHandoffCard(props) !== null) {
    return false;
  }
  const result = props?.["result"];
  if (result !== null && typeof result === "object") return false;
  const status =
    parseApprovalStatus(props?.["approval_status"]) ??
    parseApprovalStatus(props?.["status"]);
  return status === "approved";
}

/**
 * 승인된 도구 호출마다 그 카드 **뒤에** 온 같은 채널·같은 `call_id` 의 첫 평범한 결과를 짝지어 호출의 끝을 알아낸다(#5168).
 * 짝이 되는 결과는 **이 카드와 같은 `call_id` 의 다음 승인 카드 사이**에 있는 것만이다: 같은 `call_id` 를 다시 쓴 두 번째 승인은
 * 앞 호출의 결과로 닫히지 않고 자기 뒤에 온 결과로만 닫히며, 결과 하나는 카드 하나만 닫는다(창이 겹치지 않는다). 순서는 채널
 * 순서 `seq` 다.
 */
function approvalToolEnds(messages: readonly Message[]): ApprovalToolEnds {
  const running: Message[] = [];
  const cardSeqs = new Map<string, number[]>();
  const outputs = new Map<string, Message[]>();
  for (const message of messages) {
    const id = callId(message);
    if (id === undefined) continue;
    const key = keyOf(message.channelId, id);
    if (
      message.type === "approval_request" &&
      message.state !== "deleted" &&
      typeof message.props?.["approval_id"] === "string" &&
      message.props["approval_id"] !== ""
    ) {
      const seqs = cardSeqs.get(key);
      if (seqs === undefined) cardSeqs.set(key, [message.seq]);
      else seqs.push(message.seq);
    }
    if (isRunningToolApproval(message)) {
      running.push(message);
    } else if (isToolOutput(message)) {
      const list = outputs.get(key);
      if (list === undefined) outputs.set(key, [message]);
      else list.push(message);
    }
  }
  if (running.length === 0 || outputs.size === 0) return NO_ENDS;
  const byCard = new Map<string, ApprovalToolEnd>();
  const folded = new Set<string>();
  for (const card of running) {
    const key = keyOf(card.channelId, callId(card)!);
    // 같은 호출의 다음 승인 카드가 시작되면 그 앞까지가 이 카드의 창이다(없으면 끝까지).
    const until = Math.min(
      ...(cardSeqs.get(key) ?? []).filter((seq) => seq > card.seq),
      Number.POSITIVE_INFINITY
    );
    const output = outputs
      .get(key)
      ?.filter((candidate) => candidate.seq > card.seq && candidate.seq < until)
      .sort((a, b) => a.seq - b.seq)[0];
    if (output === undefined) continue;
    folded.add(output.id);
    byCard.set(
      card.id,
      output.props?.["is_error"] === true ? "failed" : "executed"
    );
  }
  return byCard.size === 0 ? NO_ENDS : { byCard, folded };
}

/** 끝이 알려진 승인 카드의 사본에 `result.status` 를 얹는다. 바꿀 카드가 없으면 같은 배열을 돌려준다. */
function closeApprovalCards(
  messages: readonly Message[],
  ends: ApprovalToolEnds
): readonly Message[] {
  if (ends.byCard.size === 0) return messages;
  return messages.map((message) => {
    const end = ends.byCard.get(message.id);
    return end === undefined
      ? message
      : withProps(message, `result=${end}`, { result: { status: end } });
  });
}

/**
 * 타임라인·스레드가 행으로 그릴 메시지 (#4986). 끝난 도구 호출을 닫고(`settleToolCalls`), 종결 카드가
 * 설명하는 옛 줄을 접고(`shouldFoldBundleLine`), 승인이 걸린 호출은 짝 승인 카드 한 장이 말하게 접고(#5066), 승인한 호출의
 * 결과는 그 승인 카드를 닫고 접는다(#5168). 판정들이 같은 원본 목록을 보아야 서로의 근거를 잃지 않는다: 접힐 줄 가운데 도구
 * 결과가 있을 수 있고 접힐 호출 행의 이름을 결과 행이 빌려 가야 해서, 접은 **뒤** 목록으로 짝짓기를 하면 그 호출이 영영
 * 「생각 중」으로 남거나 결과 카드 제목이 이름을 잃는다. 웹의 본류(`Timeline`)와 스레드(`ThreadPanel`), 폰의 `Timeline` 이 이
 * 한 함수를 부른다.
 */
export function presentableRows(messages: readonly Message[]): Message[] {
  const approvalCalls = approvalCallKeys(messages);
  const ends = approvalToolEnds(messages);
  return closeApprovalCards(settleToolCalls(messages), ends).filter(
    (message) =>
      !shouldFoldBundleLine(message, messages) &&
      !speaksThroughApproval(message, approvalCalls) &&
      !ends.folded.has(message.id)
  );
}
