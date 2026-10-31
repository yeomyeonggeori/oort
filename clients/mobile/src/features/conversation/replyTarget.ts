import {isPhotoAttachment} from '@momo/core/features/attachments/model';
import {
  expressionMessageSize,
  tokenizeExpressions,
} from '@momo/core/features/expressions/message';
import type {Expression} from '@momo/core/features/expressions/types';
import {quoteDraftFor} from '@momo/core/features/timeline/quote';
import {rowPresentation} from '@momo/core/features/timeline/rowModel';
import {uuidEq, type Message} from '@momo/core/lib/api';

// =============================================================================
// 「답글 대상」 — 밀어서 답글(#4869)이 입력칸 머리에 거는 것. **무엇에, 어느 스레드에** 달 것인가.
//
// 이슈 계약: 밀기 = **그 자리에서 스레드 답글**이다(대화 화면에 머문다, 스레드 화면으로 옮겨 가지 않는다).
// 인용(ADR-0148 `reply_to_id`)과는 다른 장치다 — 인용은 본류에 두면서 원본을 가리키고, 이것은 스레드(`root_id`)에
// 단다. 그래서 이 파일은 `quote.ts` 의 `QuoteDraft` 를 재사용하지 않고 같은 층위의 **다른 초안**을 만든다.
//
// 이 파일은 순수하다(React·RN 없음). 두 가지를 정한다:
//   · 어떤 행이 답글 대상이 될 수 있는가 / 대상이 되면 `root_id` 는 무엇인가
//   · 입력칸 머리말이 무엇을 가리키는가 — **낱말이 아니라 서술자**로 돌려준다. 사용자 문구는 i18n 사전의 것이고
//     (`replyCopy.ts`), 이 파일이 한국어를 직접 쓰면 직접 문구 장부(`direct-copy`)가 늘어난다.
// =============================================================================

/** 머리말 둘째 줄(원문)이 말하는 것. 글이 없는 메시지는 종류로 대신 말한다. */
export type ReplyExcerpt =
  /** 본문(또는 코어가 이름 붙인 카드 종류)의 한 줄 발췌. 사용자 값이다 — 사전의 문구가 아니다. */
  | {kind: 'text'; text: string}
  | {kind: 'photo'}
  | {kind: 'file'}
  | {kind: 'expression'}
  /** 글도 첨부도 없는 메시지. */
  | {kind: 'empty'};

export interface ReplyTarget {
  /** 사람이 민(또는 시트에서 고른) 메시지 — 머리말이 가리키는 글이다. */
  messageId: string;
  authorMemberId: string;
  /**
   * 보낼 때 `root_id` 가 되는 메시지. 밀린 메시지가 **이미 스레드 답글이면 그 스레드의 루트**, 아니면 그 메시지
   * 자신이다. 스레드는 한 겹이라(서버가 「thread root must be a top-level message」로 거절한다) 답글에 다는 답글은
   * 같은 스레드에 달린다 — 행 id 로 달면 서버가 400 으로 돌려준다.
   */
  rootId: string;
  /** 보는 사람이 쓴 글인가 → 머리말 첫 줄이 「내 글에 답글」이다. */
  mine: boolean;
  excerpt: ReplyExcerpt;
}

/**
 * 이 메시지가 달릴 스레드의 루트 id.
 *
 * 코어의 `canReplyToMessage` 는 이미 답글인 행을 **거절**한다(「답글에 답글」 버튼이 서면 서버가 항상 거절하는
 * 동작이 된다). 밀기는 다른 약속을 한다 — 답글 행을 밀어도 그 스레드에 달린다 — 그래서 같은 물음에 다른 답을
 * 한다. 두 규칙을 한 함수로 접으면 시트의 낡은 단정(`messageActions.test`)이나 밀기 중 하나가 거짓이 된다.
 */
export function replyRootId(message: Pick<Message, 'id' | 'rootId'>): string {
  return message.rootId ? message.rootId : message.id;
}

/**
 * 이 행을 밀어 답글을 달 수 있는가.
 *
 * 밀 수 없는 행:
 *   · 삭제된 메시지 · 보내지 못한 메시지(서버 행이 없다 — 루트가 될 수 없다)
 *   · 시스템 줄 — 사람이 한 말이 아니라 방의 기록이다
 *   · 승인 카드(`approval_request`·`approval`·`login_handoff`) — 이 행이 요구하는 것은 대화가 아니라 **결정**이고,
 *     결정 컨트롤이 있는 행 위에서 가로 쓸기가 답글을 열면 둘이 한 손가락을 두고 다툰다
 * 카드(도구 결과·산출물 등)는 밀 수 있다 — 시트의 「답글 달기」가 이미 그 행에 서 있다.
 *
 * 이 판정은 **보내기의 `canReplyToMessage` 와 다르다**: 이미 스레드 답글인 행도 민다(루트로 달린다).
 */
export function canReplyBySwipe(message: Message): boolean {
  if (message.state === 'deleted' || message.state === 'failed') return false;
  if (message.type === 'system' || message.type === 'approval_request') return false;
  const card = rowPresentation(message).card;
  return card?.kind !== 'approval' && card?.kind !== 'login_handoff';
}

function excerptOf(
  message: Message,
  expressions: readonly Expression[],
): ReplyExcerpt {
  const body = typeof message.body === 'string' ? message.body : '';
  // 이모티콘만 보낸 메시지의 본문은 `:이름:` 토큰이다 — 토큰 글자를 발췌로 내놓으면 그림이 아니라 암호가 보인다.
  // 판정은 행이 그림으로 그리는 것과 같은 코어 함수다(`expressionMessageSize`: 글 없이 표현 1~6개).
  if (
    message.type === 'text' &&
    body !== '' &&
    expressionMessageSize(tokenizeExpressions(body, expressions)) !== 'inline'
  ) {
    return {kind: 'expression'};
  }
  // 발췌는 **인용과 같은 규칙**(코어 `quoteExcerpt`·종류 라벨)이다 — 같은 글을 가리키는 두 장치가 다르게 자르지 않는다.
  const draft = quoteDraftFor(message);
  const lines = draft?.block.kind === 'ready' ? draft.block.lines : [];
  if (lines.length > 0) return {kind: 'text', text: lines.join(' ')};
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    return {kind: attachments.some(isPhotoAttachment) ? 'photo' : 'file'};
  }
  return {kind: 'empty'};
}

/** 이 행을 입력칸 머리에 걸 답글 대상으로. 밀 수 없는 행이면 `null`. */
export function replyTargetFor(
  message: Message,
  context: {myMemberId: string | undefined; expressions: readonly Expression[]},
): ReplyTarget | null {
  if (!canReplyBySwipe(message)) return null;
  return {
    messageId: message.id,
    authorMemberId: message.authorMemberId,
    rootId: replyRootId(message),
    mine: uuidEq(message.authorMemberId, context.myMemberId),
    excerpt: excerptOf(message, context.expressions),
  };
}

/**
 * 걸어 둔 대상이 아직 유효한가 — 아니면 조용히 뗀다(인용의 `quoteDraftStillValid` 와 같은 규율).
 *
 * 무효가 되는 길은 둘이다: 대상 메시지가 지워졌다, 또는 **루트가 지워졌다**(서버가 지워진 루트에 다는 답글을
 * 400 으로 거절한다). 화면에 아직 불러오지 않은 것은 사라진 것이 아니다 — 서버는 여전히 그 행을 안다.
 */
export function replyTargetStillValid(
  target: ReplyTarget,
  lookup: (messageId: string) => Message | undefined,
): boolean {
  if (lookup(target.messageId)?.state === 'deleted') return false;
  if (lookup(target.rootId)?.state === 'deleted') return false;
  return true;
}
