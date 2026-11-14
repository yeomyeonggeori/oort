import { failPending, retryPending, type PendingMessage } from "../timeline/model";
import { buildExpressionMessage } from "./message";
import { isCurrentSession, sessionStamp, type SessionStamp } from "../../lib/sessionStamp";
import type { Expression } from "./types";

// =============================================================================
// 이모티콘과 글을 한 번에 보내는 묶음 (#5453, owner 2026-11-07 · 폰 짝 #5452).
//
// 미리 보기 중인 표현(이모티콘·GIF)과 입력창의 글을 보내기 한 번으로 보낸다. **와이어는 메시지 둘이다**: 큰 표현 메시지(본문은 `:name:` 하나,
// ADR-0218 D1 그대로 large) 다음에 글 메시지. 한 말풍선으로 합치는 일은 D1을 바꾸는 일이라 이 이슈 밖이다(후속 결정).
//
// ## 같은 묶음의 `client_msg_id`
//
// 서버의 멱등 열쇠는 (채널, 작성자, client_msg_id)이고 같은 열쇠의 둘째 요청은 첫 메시지를 돌려줄 뿐 새 메시지를 쓰지 않는다. 그래서 메시지마다
// **서로 다른** 새 id를 쓴다(같은 id를 나눠 쓰면 둘이 하나로 접힌다). 「같은 묶음」이란 두 가지다:
//   ① 순서: 둘째 메시지는 첫째의 id를 `after`로 단다. 그 id가 대기 목록에 남아 있는 동안(= 아직 서버가 확정하지 않은 동안) 둘째는 나가지 않는다(`bundleMayPost`).
//   ② 멱등: id는 묶음을 만들 때 한 번 정해지고 행이 들고 다닌다. 다시 보내기(손으로든 연결이 돌아와 저절로든)는 같은 id로 나가서 서버가 이미 받은 것은
//      그대로 돌려준다 — 첫째가 응답만 놓친 채 서버에 닿아 있어도 둘째가 첫째를 앞지르거나 첫째가 두 번 쓰이지 않는다.
//
// ## 첫 메시지가 실패하면
//
// 둘째는 보내지 않는다. 사람은 이미 보내기를 눌러 입력창을 비웠으므로 둘째(글)도 **실패한 행으로 남아** 보인다(없어지면 글을 잃는다). 다시 보내기는
// 둘 중 어느 행에서 눌러도 첫째부터다(`bundleHead`). 첫째가 확정되면 둘째가 이어서 나간다. 사람이 첫째 행을 지우면 둘째는 앞이 없는 행이 되어
// 혼자 나갈 수 있다(「그림은 그만두고 글은 보낸다」).
//
// 순수 모듈이다: 난수(`newId`)와 시계는 호출부가 준다. 대기 행의 모양(`PendingMessage`)은 폰과 나눠 쓰므로 `after` 하나만 더했다.
// =============================================================================

export type SendBundleRole = "expression" | "text";

export interface SendBundleMessage {
  /** 이 메시지의 멱등 열쇠. 묶음 안에서 서로 다르다. */
  clientMsgId: string;
  body: string;
  role: SendBundleRole;
  /** 앞 메시지의 `clientMsgId`. 첫 메시지에는 없다. */
  after?: string;
}

export type SendBundleRefusal =
  /** 표현도 글도 첨부도 없다. */
  | "empty"
  /** 미리 보기 뒤에 숨겨졌거나 지워진 표현이다. 보내지 않고 다시 고르게 한다. */
  | "expression_unavailable";

export type SendBundlePlan =
  | { ok: true; messages: SendBundleMessage[] }
  | { ok: false; reason: SendBundleRefusal };

export interface SendBundleInput {
  /** 미리 보기 중인 표현, 없으면 null(글만 보낸다). */
  expression: Expression | null;
  /** 입력창의 글(호출부가 다듬은 것). */
  text: string;
  /** 보낼 첨부가 있다. 글이 비어도 둘째 메시지(파일만 보내는 메시지)가 선다. */
  hasAttachments?: boolean;
  /** 메시지마다 새 UUID를 준다. 코어는 난수를 모른다. */
  newId: () => string;
}

/**
 * 보낼 메시지를 와이어 순서로 정한다. 표현이 있으면 표현 메시지가 먼저이고, 글(또는 첨부)이 있으면 그 뒤다.
 * 표현만 있으면 메시지 하나, 글만 있으면 메시지 하나(묶음이 아니다), 둘 다 있으면 둘이다.
 */
export function planSendBundle(input: SendBundleInput): SendBundlePlan {
  const { expression, text, newId } = input;
  const hasWords = text.trim() !== "" || input.hasAttachments === true;
  if (expression === null && !hasWords) return { ok: false, reason: "empty" };
  if (expression !== null && expression.status !== "active") return { ok: false, reason: "expression_unavailable" };
  const parts: Array<Pick<SendBundleMessage, "body" | "role">> = [];
  if (expression !== null) parts.push({ body: buildExpressionMessage(expression).body, role: "expression" });
  if (hasWords) parts.push({ body: text, role: "text" });
  const messages: SendBundleMessage[] = [];
  for (const part of parts) {
    const clientMsgId = newId();
    // 같은 id가 둘이면 서버가 둘째를 첫째와 같은 메시지로 접는다: 글이 조용히 사라지는 실패라서 만들기 전에 막는다.
    if (messages.some((made) => made.clientMsgId === clientMsgId)) throw new Error("newId must return a new id for every message");
    const previous = messages[messages.length - 1];
    messages.push({ clientMsgId, ...part, ...(previous === undefined ? {} : { after: previous.clientMsgId }) });
  }
  return { ok: true, messages };
}

/**
 * 보내기 옵션(인용·라우팅·첨부·링크 미리보기 끄기·개인 에이전트 호출)을 어느 메시지가 나르는가: **마지막 메시지**다. 이것들은 사람의 글에 붙는
 * 것이고, 표현 메시지는 `:name:` 하나뿐이다. 표현만 보내면 그 하나가 마지막이라 옵션(인용 등)을 나른다.
 */
export function bundleCarriesOptions(messages: readonly SendBundleMessage[], index: number): boolean {
  return index === messages.length - 1;
}

type Linked = Pick<PendingMessage, "clientMsgId" | "after">;

/**
 * 이 행이 지금 나가도 되는가. 앞 메시지(`after`)가 대기 목록에 아직 있으면 아니다 — 보내는 중이든, 실패했든, 서버가 거절했든 같다.
 * 앞이 없거나(첫 메시지) 앞이 목록에서 사라졌으면(확정되었거나 사람이 지웠다) 나간다.
 * 모든 길(처음 보내기·다시 보내기·모두 다시 보내기·저절로 다시 보내기)이 **같은 이 함수**를 지난다.
 */
export function bundleMayPost(row: Pick<PendingMessage, "after">, list: readonly Pick<PendingMessage, "clientMsgId">[]): boolean {
  return row.after === undefined || !list.some((entry) => entry.clientMsgId === row.after);
}

/** 이 행이 속한 묶음에서 아직 확정되지 않은 가장 앞 행(자기 자신일 수 있다). 사슬이 돌아도 멈춘다(저장본이 손으로 고쳐진 경우). */
export function bundleHead<T extends Linked>(list: readonly T[], row: T): T {
  const seen = new Set<string>([row.clientMsgId]);
  let head = row;
  for (;;) {
    const before: T | undefined = head.after === undefined ? undefined : list.find((entry) => entry.clientMsgId === head.after);
    if (before === undefined || seen.has(before.clientMsgId)) return head;
    seen.add(before.clientMsgId);
    head = before;
  }
}

/** `headId` 행과 그 뒤를 이어 달린 행들(목록 차례). 한 번 훑어 닿지 못하는 순서로 저장돼 있어도 닿을 때까지 센다. */
export function bundleTail<T extends Linked>(list: readonly T[], headId: string): T[] {
  const ids = new Set<string>([headId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of list) {
      if (entry.after !== undefined && ids.has(entry.after) && !ids.has(entry.clientMsgId)) {
        ids.add(entry.clientMsgId);
        grew = true;
      }
    }
  }
  return list.filter((entry) => ids.has(entry.clientMsgId));
}

/** 다시 보내기: 머리 행과 그 뒤의 행들을 함께 「보내는 중」으로 돌린다(뒤 행이 혼자 실패 모양으로 남아 단추를 내밀지 않게). */
export function retryBundleTail(list: PendingMessage[], headId: string): PendingMessage[] {
  return bundleTail(list, headId).reduce((next, row) => retryPending(next, row.clientMsgId), list);
}

/** 머리 행이 실패했다: 머리 행과 그 뒤의 행들을 모두 실패로 둔다(뒤 행은 보내지 않았다). */
export function failBundleTail(list: PendingMessage[], headId: string): PendingMessage[] {
  return bundleTail(list, headId).reduce((next, row) => failPending(next, row.clientMsgId), list);
}

export interface BundlePoster {
  /** 지금의 대기 목록(최신). 앞 행이 확정되어 빠진 뒤에는 그 사실이 여기 보여야 한다. */
  list(): readonly PendingMessage[];
  /** 한 행을 서버로 보낸다. 서버가 확정했으면 true(그 행은 목록에서 빠져 있다), 아니면 false(행은 실패로 남는다). */
  post(row: PendingMessage): Promise<boolean>;
  /** 머리 행이 나가지 못해 보내지 않은 뒤 행들. 호출부가 실패 모양으로 맞추고 이유 한 줄을 머리 행과 같게 둔다. */
  held(rows: PendingMessage[], because: PendingMessage): void;
}

/**
 * 머리 행을 보내고, 확정되면 뒤 행을 차례로 보낸다. 웹과 폰의 모든 보내기 길(처음·다시·모두 다시·저절로 다시)이 이 함수 하나로 묶음의 순서를 지킨다.
 *
 *   · 머리 행의 앞이 아직 목록에 있으면(`bundleMayPost`) 아무것도 하지 않고 false다: 뒤 행을 직접 다시 보내려 해도 앞지르지 못한다.
 *   · 머리 행이 실패하면 뒤 행은 **보내지 않고** `held`로 알린다. 머리 행이 확정되면 뒤 행이 이어서 나간다(같은 열쇠로, 서버가 이미 받은 것은 그대로 돌려준다).
 *   · 돌려주는 값은 **머리 행이 확정되었는가**다. 뒤 행이 실패해도 머리 행은 확정된 것이고, 그 실패는 뒤 행 자신의 `post`가 알린다.
 *   · 뒤 행은 묶음을 시작한 세션으로만 나간다(#5816). 머리 행의 답을 기다리는 사이 그 세션이 끝났으면 뒤 행은 보내지 않는다.
 */
export async function postBundleInOrder(
  head: PendingMessage,
  poster: BundlePoster,
  sentAs: SessionStamp = sessionStamp()
): Promise<boolean> {
  if (!isCurrentSession(sentAs)) return false;
  if (!bundleMayPost(head, poster.list())) return false;
  const sent = await poster.post(head);
  const followers = bundleTail(poster.list(), head.clientMsgId).filter((row) => row.clientMsgId !== head.clientMsgId);
  if (!sent) {
    if (followers.length > 0) poster.held(followers, head);
    return false;
  }
  for (const follower of followers) {
    // 머리 행이 확정되어 빠졌으므로 첫 뒤 행은 나갈 수 있다. 뒤 행이 실패하면 그 뒤 행들은 위의 같은 규칙으로 멈춘다.
    if (!(await postBundleInOrder(follower, poster, sentAs))) break;
  }
  return true;
}
