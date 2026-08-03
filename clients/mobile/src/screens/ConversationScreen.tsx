import {uuidEq} from '@momo/core/lib/api';
import {
  dmAutoReplyAgent,
  dmPeer,
  unreadFor,
} from '@momo/core/features/workspace/directory';
import React, {useEffect, useMemo, useRef} from 'react';
import {Screen, ScreenHeader} from '../design/atoms';
import {Composer} from '../features/conversation/Composer';
import {ConversationLayout} from '../features/conversation/ConversationLayout';
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
  onBack,
}: {
  channelId: string;
  title: string;
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
            onStartReached={() => void timeline.loadOlder()}
            onRetry={timeline.reload}
            onResend={message => void timeline.send(message.body ?? '')}
            onResendPending={clientMsgId => void timeline.resend(clientMsgId)}
          />
        }
        composer={
          <Composer
            channelLabel={title}
            directory={directory}
            dmAgent={dmAgent}
            disabled={railStatus === 'disconnected'}
            onSend={body => void timeline.send(body)}
          />
        }
      />
    </Screen>
  );
}
