import {uuidEq, type Message} from '@momo/core/lib/api';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {ErrorState, Screen, ScreenHeader} from '../../design/atoms';
import {color, font, SAFE_GUTTER, space} from '../../design/tokens';
import {Composer} from './Composer';
import {ConversationLayout} from './ConversationLayout';
import {Timeline} from './Timeline';
import type {MessageRowActions} from './MessageRow';
import type {UseTimelineResult} from './useTimeline';

// =============================================================================
// 스레드 — 한 메시지 아래에 달린 답글들.
//
// ## 이것은 두 번째 타임라인이 아니다
//
// 답글은 `rootId` 가 붙은 **이 채널의 메시지**다. 서버의 채널 히스토리 질의는
// 답글을 걸러내지 않고(`list_channel_page` 에 `root_id IS NULL` 술어가 없다),
// 레일도 같은 채널로 배달한다. 그래서 이 화면은 저장소를 새로 갖지 않고
// `useTimeline` 의 상태를 **거른다**. 얻는 것은 목록 하나가 아니라 일관성이다:
// 반응 맵도, seq 접기도, 에코 정착 규칙도 채널과 스레드가 같은 것을 본다 —
// 한 화면 건너에서 같은 메시지가 다른 이야기를 할 수 없다.
//
// ## 목록은 `Timeline` 그대로다
//
// 새 리스트를 쓰지 않는다. `Timeline` 은 이미 이 제품이 실측으로 얻은 두 가지를
// 지고 있다: **정방향**(뒤집힌 리스트는 실기기에서 46~91px 튀었고 정방향은
// 0px), 그리고 프리펜드 위치 보정(`maintainVisibleContentPosition`). 스레드에
// 새 리스트를 쓰면 그 두 증명을 처음부터 다시 해야 하고, 뒤집힌 리스트를 막는
// 가드도 새 파일에서 다시 지켜야 한다. 루트를 첫 메시지로 얹으면 seq 순서가 그대로
// 맞으므로, 스레드는 「메시지가 다르게 걸러진 Timeline」이 된다.
//
// ## 루트에는 「답글 달기」가 없다 — 답글에도 없다
//
// 이미 스레드 안이므로 루트의 답글 진입점은 자기 자신을 여는 문이고, 답글은
// 애초에 루트가 될 수 없다(코어 `canReplyToMessage`: 서버가 "thread root must be
// a top-level message" 로 거절한다). 그래서 이 화면의 행에는 `onOpenThread` 를
// 주지 않는다 — 코어가 이미 아는 규칙을 화면에서 다시 판정하지 않고, 진입점을
// 뺌으로써 표현한다.
// =============================================================================

export function ThreadPanel({
  root,
  timeline,
  directory,
  myMemberId,
  nowMs,
  onClose,
  onReplySent,
}: {
  root: Message;
  timeline: UseTimelineResult;
  directory: Directory;
  myMemberId: string;
  nowMs: number;
  onClose: () => void;
  /**
   * A reply was just issued. The channel underneath uses it to follow its own
   * tail, so that closing this panel lands on the thing that was just written
   * rather than somewhere above it.
   */
  onReplySent?: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadNonce, setReloadNonce] = useState(0);

  const {loadReplies} = timeline;
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadReplies(root.id)
      .then(() => {
        if (!cancelled) setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [loadReplies, root.id, reloadNonce]);

  // The replies already in the shared state — including any that arrived on the
  // rail while this panel was open, because they land in the same array.
  const replies = useMemo(
    () =>
      timeline.state.messages.filter(
        message =>
          message.rootId !== undefined && uuidEq(message.rootId, root.id),
      ),
    [timeline.state.messages, root.id],
  );

  // The root is re-read from the shared state rather than kept from the tap: it
  // may have been edited or deleted since, and a thread showing a stale root
  // would be the one place in the app where a tombstone did not arrive.
  const liveRoot = useMemo(
    () => timeline.state.messages.find(m => uuidEq(m.id, root.id)) ?? root,
    [timeline.state.messages, root],
  );

  const messages = useMemo(() => [liveRoot, ...replies], [liveRoot, replies]);

  const {toggleReaction, editBody, removeMessage} = timeline;
  const actions = useMemo<MessageRowActions>(
    () => ({
      myMemberId,
      onToggleReaction: toggleReaction,
      onEdit: editBody,
      onDelete: removeMessage,
      // No `onOpenThread`: see the header. Every row here is already in one.
    }),
    [myMemberId, toggleReaction, editBody, removeMessage],
  );

  const pending = timeline.repliesPending(root.id);
  const {sendReply} = timeline;
  // A reply is my own send, and the same rule applies here as in the channel:
  // it comes to me regardless of where I had scrolled to.
  const [selfSendToken, setSelfSendToken] = useState(0);
  const onSend = useCallback(
    (body: string) => {
      setSelfSendToken(token => token + 1);
      // 채널도 같이 따라가게 한다. 답글은 이 채널의 메시지이고, 이 패널을 닫으면
      // 그것이 채널의 마지막 줄이다 — 내가 방금 쓴 것을 보려고 스크롤을 해야
      // 한다면 그것은 "내가 친 채팅이 아래로 떠서 스크롤해야 나온다"와 같은
      // 결함이 한 화면 건너에서 반복되는 것이다.
      onReplySent?.();
      void sendReply(root.id, body);
    },
    [sendReply, root.id, onReplySent],
  );

  if (status === 'error') {
    return (
      <View style={styles.overlay}>
        <Screen>
          <ScreenHeader
            title="스레드"
            onBack={onClose}
            backLabel="스레드 닫기"
            titleTestID="thread-title"
          />
          <ErrorState
            headline="답글을 불러오지 못했습니다."
            detail="연결을 확인한 뒤 다시 시도하세요."
            onRetry={() => setReloadNonce(n => n + 1)}
            testID="thread-error"
          />
        </Screen>
      </View>
    );
  }

  return (
    <View style={styles.overlay}>
      <Screen>
        <ScreenHeader
          title="스레드"
          subtitle={
            replies.length > 0 ? `답글 ${replies.length}개` : undefined
          }
          onBack={onClose}
          backLabel="스레드 닫기"
          titleTestID="thread-title"
        />
        <ConversationLayout
          list={
            <Timeline
              messages={messages}
              directory={directory}
              // The root is always present, so this list is never empty and the
              // "no replies yet" invitation belongs beside the composer instead.
              status="ready"
              pending={pending}
              reactions={timeline.reactions}
              myMemberId={myMemberId}
              // A thread has no older page to fetch: `loadReplies` walks every
              // cursor before it resolves.
              reachedStart
              nowMs={nowMs}
              actions={actions}
              selfSendToken={selfSendToken}
              // 여기서는 루트 하나를 빼면 전부 답글이다. 행마다 「답글」이라고
              // 적는 것은 정보의 모양을 한 소음이다 — 채널에서는 그 표식이
              // 유일한 단서지만, 여기서는 화면 제목이 이미 스레드다.
              markReplies={false}
              onResendPending={clientMsgId => void timeline.resend(clientMsgId)}
            />
          }
          composer={
            <View>
              {status === 'ready' && replies.length === 0 ? (
                <Text style={styles.invite} testID="thread-empty">
                  첫 답글을 남겨 이 대화를 이어가세요.
                </Text>
              ) : null}
              <Composer
                channelLabel="스레드"
                directory={directory}
                placeholder="답글 쓰기"
                sendLabel="답글 보내기"
                onSend={onSend}
              />
            </View>
          }
        />
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.bg,
  },
  invite: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
    fontSize: font.meta,
    color: color.textFaint,
  },
});
