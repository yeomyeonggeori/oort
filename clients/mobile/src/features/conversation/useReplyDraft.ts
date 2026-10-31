import {uuidEq, type Message, type MessageAttachment} from '@momo/core/lib/api';
import {useCallback, useEffect, useRef, useState} from 'react';

import {useExpressionItems} from '../expressions/ExpressionProvider';
import {
  replyTargetFor,
  replyTargetStillValid,
  type ReplyTarget,
} from './replyTarget';

// =============================================================================
// 입력칸에 걸린 「답글 대상」의 한살이 (#4869).
//
// 걸린 인용(`quote`)과 **같은 자리, 같은 규율**이다: 채널을 옮기면 뜻을 잃고, 대상이 지워지면 조용히 떼며, 컴포저 **안**이
// 아니라 화면이 든다(컴포저는 마운트·언마운트되므로 스레드를 열었다 닫는 사이에 대상이 사라지면 사람이 자기가 무엇을
// 눌렀는지 의심하게 된다). 다른 점은 보내는 길이다: 인용은 본류에 `replyToId` 로 나가고, 답글은 **스레드에 `rootId` 로**
// 나간다(`timeline.sendReply`) — 그리고 **화면은 그대로다**. 스레드 화면(`openThread`)을 열지 않는다.
//
// 인용과는 함께 걸 수 없다. 스레드 답글 쓰기 경로(`sendThreadReply`)에 `replyToId` 가 없어서, 둘을 동시에 걸면 인용이
// 말없이 사라진다. 걸리는 쪽이 앞의 것을 대신한다 — 그 대신 쪽 정리는 `onStarted` 가 한다(화면이 인용을 뗀다).
//
// 핸들러는 전부 **고정된 동일성**이다(`goal RN-P2a`): `ConversationScreen` 의 `actions` 에 실려 목록 전체로 내려가므로 이
// 값이 바뀔 때마다 붙어 있는 모든 행이 다시 그려진다. 최신 값은 ref 로 읽는다.
// =============================================================================

export interface UseReplyDraftResult {
  /** 지금 입력칸 머리에 걸린 대상. 없으면 `null`. */
  replyTarget: ReplyTarget | null;
  /**
   * 이 행을 답글 대상으로 건다 — 밀기와 행동 시트의 「답글 달기」가 **같은** 이 길을 지난다(VoiceOver 도 같은 입력칸을 연다).
   * 밀 수 없는 행이면 아무 일도 하지 않는다.
   */
  startReply: (message: Message) => void;
  /** ✕. 대상만 뗀다 — 입력칸의 글은 컴포저가 들고 있으므로 남는다. */
  cancelReply: () => void;
  /**
   * 보내기. 대상이 걸려 있으면 그 스레드(`rootId`)에 달고 **`true`**, 대상을 뗀다(보낸 순간 떨어진다 — 남겨 두면 다음 줄까지
   * 같은 스레드로 간다). 없으면 `false` — 부른 쪽이 평소대로 보낸다.
   */
  sendReply: (body: string, options?: {attachments?: MessageAttachment[]}) => boolean;
}

export function useReplyDraft({
  channelId,
  messages,
  myMemberId,
  sendThreadReply,
  onStarted,
}: {
  channelId: string;
  /** 이 채널에 불러온 메시지 — 대상이 지워졌는지 본다. */
  messages: readonly Message[];
  myMemberId: string;
  /** `timeline.sendReply` — 스레드에 다는 그 쓰기 길 하나. */
  sendThreadReply: (
    rootId: string,
    body: string,
    attachments?: MessageAttachment[],
  ) => Promise<void>;
  /** 대상이 걸린 직후: 화면이 인용을 떼고 입력칸에 초점을 준다(걸어 준 사람의 다음 동작은 100% 글쓰기다). */
  onStarted?: () => void;
}): UseReplyDraftResult {
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const targetRef = useRef<ReplyTarget | null>(null);
  targetRef.current = replyTarget;

  // 채널을 옮기면 이 대상은 다른 방의 것이다.
  useEffect(() => setReplyTarget(null), [channelId]);

  // 걸어 둔 대상(또는 그 스레드의 루트)이 지워졌다. 서버는 지워진 루트에 다는 답글을 400 으로 거절한다 — 조용히 뗀다.
  useEffect(() => {
    if (replyTarget === null) return;
    const lookup = (messageId: string) =>
      messages.find(message => uuidEq(message.id, messageId));
    if (!replyTargetStillValid(replyTarget, lookup)) setReplyTarget(null);
  }, [replyTarget, messages]);

  const expressions = useExpressionItems();
  const expressionsRef = useRef(expressions);
  expressionsRef.current = expressions;
  const myMemberRef = useRef(myMemberId);
  myMemberRef.current = myMemberId;
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;
  const sendRef = useRef(sendThreadReply);
  sendRef.current = sendThreadReply;

  const startReply = useCallback((message: Message) => {
    const next = replyTargetFor(message, {
      myMemberId: myMemberRef.current,
      expressions: expressionsRef.current,
    });
    if (next === null) return;
    setReplyTarget(next);
    onStartedRef.current?.();
  }, []);

  const cancelReply = useCallback(() => setReplyTarget(null), []);

  const sendReply = useCallback(
    (body: string, options?: {attachments?: MessageAttachment[]}) => {
      const target = targetRef.current;
      if (target === null) return false;
      setReplyTarget(null);
      void sendRef.current(target.rootId, body, options?.attachments);
      return true;
    },
    [],
  );

  return {replyTarget, startReply, cancelReply, sendReply};
}
