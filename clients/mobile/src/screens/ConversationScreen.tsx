import {uuidEq, type Message} from '@momo/core/lib/api';
import {
  dmAutoReplyAgent,
  dmPeer,
  unreadFor,
} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View} from 'react-native';
import {FailureBanner, Screen, ScreenHeader} from '../design/atoms';
import {Composer} from '../features/conversation/Composer';
import {ConversationLayout} from '../features/conversation/ConversationLayout';
import {
  LongPressHint,
  useLongPressHint,
} from '../features/conversation/LongPressHint';
import type {MessageRowActions} from '../features/conversation/MessageRow';
import {ThreadPanel} from '../features/conversation/ThreadPanel';
import {Timeline} from '../features/conversation/Timeline';
import {useTimeline} from '../features/conversation/useTimeline';
import {useMarkRead} from '../features/inbox/useInbox';
import {
  useChannels,
  useDirectory,
  useReadStates,
} from '../features/workspace/queries';
import {useNow} from '../lib/useNow';
import {useRealtime} from '../realtime/RealtimeProvider';
import {useSession} from '../session/useSession';

// =============================================================================
// The conversation: read it, receive it, write into it.
//
// Replaces goal RN-C3's placeholder in full. The seam that file asked the next
// batch to keep — `channelId` plus an already-resolved `title` — is kept
// exactly: the title is still the caller's, resolved through the core's
// directory at the moment the row was tapped, so this header cannot flicker
// from "다이렉트 메시지" to a name when the roster refetches.
//
// ## The unread divider is frozen at open, the cursor is not
//
// `lastReadSeq` and `unreadCount` are captured ONCE, when the channel opens,
// and the divider is drawn from that snapshot for as long as the screen is up.
// The server cursor meanwhile advances as messages arrive, because they are on
// screen and P7 says the client reports a position while the server owns the
// count.
//
// Reading those two from the same live query would erase the divider a moment
// after it appeared — the person would see "새 메시지 12개" flash and vanish,
// which is worse than never drawing it: the one thing they wanted was the line
// showing where they had stopped.
//
// ## Keyboard
//
// `KeyboardAvoidingView` with `behavior="padding"` does the avoiding. What it
// does not know is that a raised keyboard already covers the home indicator, so
// the bottom safe-area inset is applied only while the keyboard is down —
// otherwise a 34-point dead band sits between the input and the keys. Measured
// rather than asserted: `measure/` reports the composer's bottom edge against
// the keyboard's top edge.
// =============================================================================

export default function ConversationScreen({
  channelId,
  title,
  anchor,
  onBack,
}: {
  channelId: string;
  title: string;
  /**
   * A message this conversation was opened to show (a search result).
   *
   * Both halves travel, and the second one is why this is not just an id: if the
   * row is not on screen, `seq` is what turns "we could not find it" into a fact
   * rather than a guess. Below the oldest seq we hold, it is *older than what we
   * loaded* and we can say so; otherwise we only know we did not find it. Web
   * shipped this surface without it and a search result silently dropped people
   * at the bottom of a channel (B12 R2 High-3) — 모르면 모른다고 말한다.
   */
  anchor?: {messageId: string; seq: number};
  onBack: () => void;
}): React.JSX.Element {
  const {member, workspaceId} = useSession();
  const {rail, status: railStatus} = useRealtime();
  const nowMs = useNow();

  const {directory} = useDirectory(workspaceId);
  const {groups} = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  const markRead = useMarkRead();

  const timeline = useTimeline(rail, workspaceId, channelId, member.id);

  const channel = useMemo(
    () =>
      [...groups.channels, ...groups.dms].find(candidate =>
        uuidEq(candidate.id, channelId),
      ) ?? null,
    [groups, channelId],
  );

  const peer = useMemo(
    () => (channel ? dmPeer(channel, directory, member.id) : null),
    [channel, directory, member.id],
  );

  const dmAgent = useMemo(
    () => (channel ? dmAutoReplyAgent(channel, directory, member.id) : null),
    [channel, directory, member.id],
  );

  // ---- the frozen unread snapshot ------------------------------------------
  // Captured on the first render that has a read state for this channel, and
  // never updated. `null` until then, which renders no divider rather than a
  // divider at seq 0 — a line claiming "you stopped here" at the top of the
  // channel is a lie that costs the reader a scroll.
  const frozenRef = useRef<{
    channelId: string;
    lastReadSeq: number;
    unreadCount: number;
  } | null>(null);
  const readState = unreadFor(readStates.byChannel, channelId);
  if (
    readState &&
    (frozenRef.current === null || frozenRef.current.channelId !== channelId)
  ) {
    frozenRef.current = {
      channelId,
      lastReadSeq: readState.lastReadSeq,
      unreadCount: readState.unreadCount,
    };
  }
  const frozen =
    frozenRef.current?.channelId === channelId ? frozenRef.current : null;

  // ---- advance the server cursor -------------------------------------------
  // Fire and forget: the badge is the server's projection, and a failed PUT
  // means it stays where it was — which is the safe direction. The server
  // clamps and never regresses, so a stale request landing late cannot pull
  // the cursor backwards.
  const newestSeq = timeline.state.newestSeq;
  useEffect(() => {
    if (newestSeq === null) return;
    void markRead(channelId, newestSeq).catch(() => {
      /* the cursor stays put; the next open tries again */
    });
  }, [channelId, newestSeq, markRead]);

  // ---- the action surface ---------------------------------------------------
  const [thread, setThread] = useState<Message | null>(null);
  const hint = useLongPressHint();

  // Bumped the moment a send is issued — before the round trip, because the
  // optimistic echo is already on screen and that is when it has to be visible.
  const [selfSendToken, setSelfSendToken] = useState(0);
  const {send} = timeline;
  const onSend = useCallback(
    (body: string) => {
      setSelfSendToken(token => token + 1);
      void send(body);
    },
    [send],
  );

  const {toggleReaction, editBody, removeMessage} = timeline;
  const openThread = useCallback((message: Message) => setThread(message), []);
  const actions = useMemo<MessageRowActions>(
    () => ({
      myMemberId: member.id,
      onToggleReaction: toggleReaction,
      onEdit: editBody,
      onDelete: removeMessage,
      onOpenThread: openThread,
      onLongPressUsed: hint.markUsed,
    }),
    [member.id, toggleReaction, editBody, removeMessage, openThread, hint.markUsed],
  );

  // ---- a search result that we cannot show says so --------------------------
  // Only once the first page has settled: before that, "not found" would be a
  // statement about a list that has not loaded yet.
  const oldestSeq = timeline.state.oldestSeq;
  const anchorNotice = useMemo(() => {
    if (!anchor || timeline.status !== 'ready') return null;
    const found = timeline.state.messages.some(message =>
      uuidEq(message.id, anchor.messageId),
    );
    if (found) return null;
    if (oldestSeq !== null && anchor.seq < oldestSeq) {
      return '찾던 메시지는 이 대화의 더 위쪽에 있어 아직 불러오지 않았습니다. 위로 올려 이어서 불러오세요.';
    }
    return '찾던 메시지를 이 화면에서 찾지 못했습니다. 위로 올려 이전 대화를 더 불러오세요.';
  }, [anchor, timeline.status, timeline.state.messages, oldestSeq]);

  return (
    <Screen>
      <ScreenHeader
        title={title}
        subtitle={railStatus === 'connected' ? undefined : '연결 중…'}
        onBack={onBack}
        titleTestID="conversation-title"
      />
      <ConversationLayout
        list={
          <>
            {anchorNotice ? (
              <View style={{padding: 12}}>
                <FailureBanner message={anchorNotice} testID="anchor-missed" />
              </View>
            ) : null}
            <Timeline
              messages={timeline.state.messages}
              directory={directory}
              status={timeline.status}
              channelKind={channel?.kind}
              peer={peer}
              lastReadSeq={frozen?.lastReadSeq ?? null}
              unreadCount={frozen?.unreadCount ?? 0}
              recoveryMarkers={timeline.recoveryMarkers}
              pending={timeline.pending}
              reactions={timeline.reactions}
              myMemberId={member.id}
              loadingOlder={timeline.loadingOlder}
              reachedStart={timeline.reachedStart}
              nowMs={nowMs}
              actions={actions}
              selfSendToken={selfSendToken}
              onStartReached={() => void timeline.loadOlder()}
              onRetry={timeline.reload}
              onResend={message => onSend(message.body ?? '')}
              onResendPending={clientMsgId => void timeline.resend(clientMsgId)}
            />
          </>
        }
        composer={
          <>
            <LongPressHint visible={hint.visible} onDismiss={hint.dismiss} />
            <Composer
              channelLabel={title}
              directory={directory}
              dmAgent={dmAgent}
              disabled={railStatus === 'disconnected'}
              onSend={onSend}
            />
          </>
        }
      />

      {thread ? (
        <ThreadPanel
          root={thread}
          timeline={timeline}
          directory={directory}
          myMemberId={member.id}
          nowMs={nowMs}
          onClose={() => setThread(null)}
        />
      ) : null}
    </Screen>
  );
}
