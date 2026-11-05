import type { Message } from "../../lib/api";
import { isPhotoAttachment } from "../attachments/model";
import { expressionMessageSize, tokenizeExpressions } from "../expressions/message";
import type { Expression } from "../expressions/types";
import { quoteDraftFor } from "./quote";

// =============================================================================
// 답글의 집은 스레드 — 채널 본류에는 `root_id` 가 없는 메시지만 선다 (ADR-0148 증보 2026-10-31 · 2026-11-05, 이슈 #4888 → #5324).
//
// 이 파일은 **웹·데스크탑·폰이 같은 판정을 쓰게 하는 한 곳**이다. 규칙은 한 문장이다:
//
//     채널의 본류에는 `root_id` 가 없는 메시지가 보인다. 스레드 화면에는 그 root 의 모든 답글이 보인다.
//
// 「대화에도 보내기」는 2026-11-05 owner 결정으로 화면에서 빠졌다(서버 필드 `also_in_channel` 은 호환을 위해 그대로 오고, 이 클라이언트는 더는
// 보내지 않는다). 그 전에 켜고 보낸 답글도 **스레드에만** 보인다 — 본류의 행도, 본류의 한 줄 요약도 없다. 그래서 이 판정은 `alsoInChannel` 을
// 읽지 않는다: 읽는 순간 같은 대화가 새 기기와 옛 기기에서 다르게 읽힌다.
//
// 서버는 기록 읽기에서 채널의 모든 행을 주고 값만 싣는다(본류용·스레드용 목록을 따로 만들지 않는다). 걸러 내는 것은 클라이언트의 몫이다. 그래서 이
// 판정이 화면마다 달라지면 같은 대화가 두 기기에서 다르게 읽힌다 — 폰이 답글을 전부 보여 주고 웹이 전부 빼던 때의 갈림이 정확히 그것이다.
//
// ## 두 판정은 일부러 나눈다
//
//   (a) `isMainFlowRow` / `mainFlowMessages` — 평문 규칙. **웹·데스크탑은 이것만 쓴다.** 옛 서버에서도 웹이 오늘 그리는 화면과 같다(답글은 전부 스레드로만).
//   (b) `phoneMainFlowMessages` — 폰 전용. 폰은 스레드 요약이 서기 전에 답글을 **전부** 본류에 그렸다. 옛 서버에서 (a)를 그대로 쓰면 읽던 사람의
//       눈앞에서 답글이 사라진다. 그래서 서버가 스레드 요약을 아는지(`serverSpeaksThreadHome`)를 먼저 보고, 모르면 그 동작을 지킨다.
//
// (b)를 (a)에 옵션으로 접어 넣지 않는다: 그렇게 하면 웹이 한 줄 실수로 옛 서버에서 답글을 전부 그리게 되고, 그것이 회귀다.
//
// ## 「서버가 아는가」의 증거 — 값이 **없다**는 신호가 와이어에 없다
//
// 가르는 것은 migration 162(`17b030e35`)가 함께 들여온 값이다:
//
//   · `thread.participant_count`·`participant_ids` — 스레드 요약(`thread_rollup()` 한 함수)이 새 서버에서는 **항상** 싣는다.
//   · `alsoInChannel === true` 인 행 하나 — 옛 서버는 이 키를 영영 안 보낸다. 이 클라이언트가 켜지 못하게 된 뒤에도 서버에 남은 옛 행은 그 증거다.
//
// 둘 중 하나라도 불러온 목록에 있으면 이 서버는 새 서버이고 (a)를 그대로 쓴다. 하나도 없으면 **모르는 것이고, 모를 때는 답글을 숨기지 않는다**
// (「답글이 사라져 보이면 안 돼요」가 이 판정의 계약이다).
//
// 알려진 틈: 스레드가 하나도 없던 창에서 첫 답글이 실시간으로 오면(루트는 아직 요약이 없고, 프레임에는 키가 없다) 새 서버여도 그 답글은 요약이 든
// 쪽을 다시 읽을 때까지 본류에 보인다. TS 클라이언트는 `thread.updated` 를 소비하지 않아서(`Message.thread` 주석) 요약은 쪽 읽기에서만 바뀐다. 반대
// 방향의 오류(옛 서버에서 숨김)보다 이쪽을 택한 것이다.
// =============================================================================

/** 이 행이 채널 본류에 서는가 — `root_id` 가 없는 메시지만이다(ADR-0148 증보 2026-11-05). */
export function isMainFlowRow(message: Pick<Message, "rootId">): boolean {
  return !message.rootId;
}

/** 평문 규칙으로 본류에 그릴 행만. 웹·데스크탑이 쓴다. 순서·동일성은 그대로(새 배열). */
export function mainFlowMessages<T extends Pick<Message, "rootId">>(messages: readonly T[]): T[] {
  return messages.filter(isMainFlowRow);
}

/**
 * 이 서버가 스레드 요약(`participant_*`)·`also_in_channel` 을 아는 서버라는 증거가 목록에 있는가.
 * 위 머리말의 두 증거 중 하나. 없다는 것은 「옛 서버」가 아니라 「모른다」다.
 */
export function serverSpeaksThreadHome(messages: readonly Message[]): boolean {
  for (const message of messages) {
    if (message.alsoInChannel === true) return true;
    const thread = message.thread;
    if (
      thread !== undefined &&
      thread !== null &&
      (typeof thread.participant_count === "number" || Array.isArray(thread.participant_ids))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 폰이 본류에 그릴 행. 서버가 아는 서버면 평문 규칙, 모르면 **오늘 폰의 동작**(답글 전부)이다.
 * 모를 때는 같은 배열을 그대로 돌려준다(동일성이 목록의 메모 기준이다).
 */
export function phoneMainFlowMessages(messages: Message[]): Message[] {
  return serverSpeaksThreadHome(messages) ? mainFlowMessages(messages) : messages;
}

// ---- 본류 답글 줄: 「↳ ○○님 스레드에 답글」 + 원문 한 줄 -------------------------------------------------------------

/** 줄의 둘째 칸이 말하는 것. 글이 없는 메시지는 종류로 대신 말한다(코어 `quoteExcerpt` 규칙). */
export type MessageExcerpt =
  /** 본문(또는 코어가 이름 붙인 카드 종류)의 발췌. 사용자 값이다 — 사전의 문구가 아니다. */
  | { kind: "text"; text: string }
  | { kind: "photo" }
  | { kind: "file" }
  | { kind: "expression" }
  /** 글도 첨부도 없는 메시지. */
  | { kind: "empty" };

/**
 * 한 메시지의 한 줄 발췌 — 폰 답글 머리말(`replyTarget`)과 본류 답글 줄이 **같은 함수**를 쓴다.
 * 발췌는 인용과 같은 규칙(`quoteExcerpt`·종류 라벨)이라, 같은 글을 가리키는 장치들이 다르게 자르지 않는다.
 *
 * `expressions` 는 이모티콘만 보낸 메시지(본문이 `:이름:` 토큰)를 알아보려는 명부다. 주지 않으면 그 판정은 하지 않는다.
 */
export function messageExcerpt(
  message: Message,
  expressions: readonly Expression[] = []
): MessageExcerpt {
  const body = typeof message.body === "string" ? message.body : "";
  // 이모티콘만 보낸 메시지의 본문은 토큰이다 — 토큰 글자를 발췌로 내놓으면 그림이 아니라 암호가 보인다.
  if (
    message.type === "text" &&
    body !== "" &&
    expressionMessageSize(tokenizeExpressions(body, expressions)) !== "inline"
  ) {
    return { kind: "expression" };
  }
  const draft = quoteDraftFor(message);
  const lines = draft?.block.kind === "ready" ? draft.block.lines : [];
  if (lines.length > 0) return { kind: "text", text: lines.join(" ") };
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    return { kind: attachments.some(isPhotoAttachment) ? "photo" : "file" };
  }
  return { kind: "empty" };
}

/**
 * 본류에 선 답글이 말하는 「어느 스레드의 답글인가」. 세 갈래는 서로 배타다 — 「지워졌다」와 「아직 못 불러왔다」를 한 상태로
 * 뭉치면 화면이 지워지지 않은 글을 지워졌다고 말한다(`QuoteBlock` 과 같은 규율).
 */
export type ReplyHomeLine =
  | {
      kind: "ready";
      rootId: string;
      rootAuthorMemberId: string;
      excerpt: MessageExcerpt;
    }
  | {
      /** 루트가 지워졌다. 스레드는 열린다(답글은 남아 있다) — 원문만 없다. */
      kind: "deleted";
      rootId: string;
      rootAuthorMemberId: string;
    }
  | {
      /** 루트가 불러온 범위 위에 있다. 「스레드의 답글」은 참이고 「누구 글인지」는 모른다 — 모르면 모른다고 말한다. */
      kind: "unloaded";
      rootId: string;
    };

/**
 * 루트(또는 「못 불러옴」 = `undefined`)에서 바로 만드는 답글 줄. 폰 행은 이미 루트 객체를 들고 있어(`replyParent`) 조회 없이 이 함수를
 * 쓴다. **여기서 요청은 일어나지 않는다.**
 */
export function replyHomeLineOf(
  rootId: string,
  root: Message | undefined,
  expressions: readonly Expression[] = []
): ReplyHomeLine {
  if (root === undefined) return { kind: "unloaded", rootId };
  if (root.state === "deleted") {
    return { kind: "deleted", rootId: root.id, rootAuthorMemberId: root.authorMemberId };
  }
  return {
    kind: "ready",
    rootId: root.id,
    rootAuthorMemberId: root.authorMemberId,
    excerpt: messageExcerpt(root, expressions),
  };
}
