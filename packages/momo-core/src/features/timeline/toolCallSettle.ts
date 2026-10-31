import type { Message } from "../../lib/api";
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

/** 같은 원본·같은 끝이면 같은 사본을 돌려준다 — 행이 사본 정체성으로 다시 그려지지 않게 한다. */
const COPIES = new WeakMap<Message, Map<SettledStatus, Message>>();

function settledCopy(message: Message, status: SettledStatus): Message {
  let byStatus = COPIES.get(message);
  if (byStatus === undefined) {
    byStatus = new Map();
    COPIES.set(message, byStatus);
  }
  let copy = byStatus.get(status);
  if (copy === undefined) {
    copy = { ...message, props: { ...message.props, status } };
    byStatus.set(status, copy);
  }
  return copy;
}

/**
 * 같은 목록에 결과가 있는 `tool_call` 행의 `props.status` 를 끝으로 채워 돌려준다. 이미 상태를 싣고 온
 * 행(서버가 말한 것)은 덮지 않는다. 바꿀 행이 없으면 **같은 배열**을 돌려줘서 호출자의 메모가 유지된다.
 *
 * 결과 행이 접힌(`shouldFoldBundleLine`) 뒤에는 이 판정을 할 수 없으니, 호출자는 접기 **전** 목록을
 * 넘긴다.
 */
export function settleToolCalls(
  messages: readonly Message[]
): readonly Message[] {
  const results = new Map<string, SettledStatus>();
  for (const message of messages) {
    if (message.type !== "tool_result" || message.state === "deleted") continue;
    const id = callId(message);
    if (id !== undefined) {
      results.set(keyOf(message.channelId, id), settledStatus(message));
    }
  }
  if (results.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message.type !== "tool_call" || message.state === "deleted") {
      return message;
    }
    if (typeof message.props?.["status"] === "string") return message;
    const id = callId(message);
    const status =
      id === undefined ? undefined : results.get(keyOf(message.channelId, id));
    if (status === undefined) return message;
    changed = true;
    return settledCopy(message, status);
  });
  return changed ? next : messages;
}

/**
 * 타임라인·스레드가 행으로 그릴 메시지 (#4986). 끝난 도구 호출을 닫고(`settleToolCalls`), 종결 카드가
 * 설명하는 옛 줄을 접는다(`shouldFoldBundleLine`). 두 판정이 같은 원본 목록을 보아야 서로의 근거를 잃지
 * 않는다: 접힐 줄 가운데 도구 결과가 있을 수 있어서, 접은 **뒤** 목록으로 짝짓기를 하면 그 호출이 영영
 * 「생각 중」으로 남는다. 웹의 본류(`Timeline`)와 스레드(`ThreadPanel`)가 이 한 함수를 부른다.
 */
export function presentableRows(messages: readonly Message[]): Message[] {
  return settleToolCalls(messages).filter(
    (message) => !shouldFoldBundleLine(message, messages)
  );
}
