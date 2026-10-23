import type { Message } from "../../lib/api";

// =============================================================================
// 「사람이 읽을 메시지」와 「기계 메시지」의 구별 (#4142 에서 웹 `dmRevival.ts` 에 있던 것을 코어로 옮겼다, #4252).
//
// 에이전트 DM 에는 작업 상태·영수증 같은 기계 메시지가 쌓인다(`type: "system"` / `props.kind: "work_session"`,
// 푸시도 같은 모양을 `Work` 범주로 가른다 - `momo-push/src/dispatch.rs category_for`). 읽음 투영의 안 읽은 수와
// `latestSeq` 는 그 전부를 센다. 서버 계약을 바꾸지 않고 「사람이 읽을 것」을 알려면 메시지를 읽어 이 함수로 가르는
// 길뿐이다. 두 소비자가 같은 구별을 읽는다: 닫은 DM 이 되살아나는 조건(웹 `dmRevival.ts`)과 나간 멤버 DM 이 안 읽음
// 때문에 접히지 못하는 조건(`goneDm.ts`, 웹·폰).
// =============================================================================

/**
 * 안 읽은 쪽을 읽는 한 번의 크기. 이만큼이 다 차면 뒤에 더 있는지 몰라 「사람이 읽을 것이 있다」고 본다
 * (모르면 보이는 쪽: 닫은 DM 은 되살리고, 나간 멤버 DM 은 접지 않는다).
 */
export const HUMAN_MESSAGE_PAGE_LIMIT = 50;

/** 사람이 읽을 것이 아닌 메시지: 도구 호출·결과, 시스템 줄, 작업 세션 상태 카드, 지워진 메시지. */
export function isAmbientMessage(
  message: Pick<Message, "type" | "props" | "state">
): boolean {
  if (message.state === "deleted") return true;
  if (
    message.type === "tool_call" ||
    message.type === "tool_result" ||
    message.type === "system"
  ) {
    return true;
  }
  return message.props?.kind === "work_session";
}

/** 한 쪽에 사람이 읽을 메시지가 있는가. 쪽이 가득 찼으면 모르므로 있다고 본다. */
export function pageHasHumanMessage(
  messages: readonly Pick<Message, "type" | "props" | "state">[]
): boolean {
  if (messages.length >= HUMAN_MESSAGE_PAGE_LIMIT) return true;
  return messages.some((message) => !isAmbientMessage(message));
}
