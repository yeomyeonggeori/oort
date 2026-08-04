import {uuidEq, type Message} from '@momo/core/lib/api';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {
  dmAutoReplyAgent,
  dmPeer,
  unreadFor,
} from '@momo/core/features/workspace/directory';
import type {CancelOutcome} from '@momo/core/features/agents/runCancel';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {FailureBanner, Screen, ScreenHeader} from '../design/atoms';
import {color, font, SAFE_GUTTER, space} from '../design/tokens';
import {StopTurnControl} from '../features/agents/StopTurnControl';
import {AgentActivityBar} from '../features/agents/turnSurfaces';
import {
  agentTurnsInChannel,
  hasChannelTurn,
  useAgentWorkingSignals,
  useTickingNow,
} from '../features/agents/workingSignal';
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
// `ConversationLayout` does the avoiding, and it is a named component precisely
// so that `measure/` can render the tree that ships. `KeyboardAvoidingView` was
// tried first and measured wrong; the reasons, and why the movement is a
// native-driven transform rather than an animated padding, are recorded there
// and in `src/lib/useKeyboard.ts`. Measured rather than asserted: `measure/`
// reports the composer's bottom edge against the keyboard's top edge, and the
// travel between the two.
// =============================================================================

/**
 * 헤더 부제 — 소켓이 무슨 상태인지 (2R M3).
 *
 * 「연결 중…」 하나로 두 상태를 덮고 있었다. `RealtimeProvider`는 이미 "한 번
 * 연결된 뒤의 connecting은 disconnected다"라고 판정해서 내려보내는데(웹에서
 * 실측한 40초 단절이 아무 오프라인 표시도 못 냈던 그 결함의 수리) 이 부제만
 * 그 판정을 버리고 둘을 같은 낙관으로 말했다. 그러면 같은 화면 안에서 헤더는
 * 「연결 중…」이라 하고 바로 아래 활동 줄은 「연결이 끊겨 갱신이 멈췄습니다」라고
 * 하는, 서로 모순되는 두 문장이 동시에 서 있게 된다.
 *
 * 연결됐을 때는 아무 말도 하지 않는다 — 정상은 문장을 쓰지 않는다.
 */
function railSubtitle(status: RealtimeStatus): string | undefined {
  if (status === 'connected') return undefined;
  return status === 'connecting' ? '연결 중…' : '연결이 끊겼습니다';
}

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

  // ---- 이 채널에서 지금 열려 있는 턴 (goal RN-T2) ---------------------------
  // The 1Hz clock is mounted for THIS channel's turns, not the workspace's.
  // `hasChannelTurn` is clock-free precisely so that decision can be made before
  // there is a clock; gating on the store's size alone would re-render this
  // screen once a second because an agent is busy in a channel nobody here is
  // looking at, which on a phone is battery bought with nothing on screen.
  //
  // `useTickingNow` returns the RENDER's own clock whatever the argument says.
  // The argument only buys the 1Hz re-render, and that is what makes the same
  // `nowMs` safe to hand to the staleness filter below: a frozen now can never
  // find a signal stale, and a dead rail is exactly when one most needs to
  // expire.
  const signals = useAgentWorkingSignals();
  const railLive = railStatus === 'connected';
  const turnNowMs = useTickingNow(hasChannelTurn(signals, channelId) && railLive);
  const turns = agentTurnsInChannel(signals, channelId, turnNowMs);

  // ---- 중단의 결과 한 문장 (goal RN-C1, 2R M2) -----------------------------
  // 영수증은 **어느 실행에 대한 말인지**를 들고 다닌다. 문장 자체도 에이전트를
  // 부르지만(`cancelReceipt`), 물러나는 조건도 그 실행에 묶여 있어야 한다.
  //
  // 처음 판은 `turns.length === 0`에서만 물러났다. 두 에이전트가 동시에 일하는
  // 대화에서 그것은 A에 대한 영수증이 B의 살아 있는 줄 아래 계속 앉아 있는다는
  // 뜻이고, 붙어 있는 곳이 곧 무엇에 대한 말인지가 된다.
  const [stopOutcome, setStopOutcome] = useState<{
    runId: string;
    memberId: string;
    outcome: CancelOutcome;
  } | null>(null);
  useEffect(() => setStopOutcome(null), [channelId]);

  // 물러나는 조건: **그 에이전트에게 다른 실행의 턴이 열렸을 때**.
  //
  // "그 run의 턴이 사라지면"이 아니다 — 성공한 중단에서는 그 소멸이 바로 성공의
  // 증거이고, 서버가 종료 프레임을 즉시 밀어 주므로 영수증은 읽히기도 전에
  // 깜빡이고 사라진다. 사람이 방금 요청한 확인을 지우는 것은 이 줄이 존재하는
  // 이유를 지우는 것이다.
  //
  // 오독의 원인은 소멸이 아니라 **다른 턴에 붙어 보이는 것**이므로, 그것을 정확히
  // 겨냥한다: 같은 에이전트에게 다른 실행이 열리면 이 문장은 그 새 실행에 대한
  // 말로 읽히기 시작하고, 그때 물러난다.
  const supersededByNewRun =
    stopOutcome !== null &&
    turns.some(
      turn =>
        uuidEq(turn.memberId, stopOutcome.memberId) &&
        turn.runId !== undefined &&
        !uuidEq(turn.runId, stopOutcome.runId),
    );
  useEffect(() => {
    if (supersededByNewRun) setStopOutcome(null);
  }, [supersededByNewRun]);

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
        subtitle={railSubtitle(railStatus)}
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
            {/* Directly above the input, which is where the answer matters: this
                is the line that tells you whether to wait or to type. It sits
                over the composer rather than in the header for the same reason
                the web bar does — the header is where the channel's identity
                lives, and a turn is not an identity. */}
            <AgentActivityBar
              turns={turns}
              directory={directory}
              nowMs={turnNowMs}
              live={railLive}
              renderStop={turn => (
                <StopTurnControl
                  runId={turn.runId}
                  agentName={turn.name}
                  runCount={turn.runCount}
                  onOutcome={outcome =>
                    setStopOutcome({
                      runId: turn.runId,
                      memberId: turn.memberId,
                      outcome,
                    })
                  }
                  testIDPrefix={`turn-stop-${turn.memberId}`}
                />
              )}
            />
            {/* 결과는 컨트롤 밖에서, 줄보다 넓은 자리에 말한다. 「이미 끝났습니다」는
                실패가 아니라 답이므로 배너가 아니라 영수증과 같은 자리에 선다 —
                빨간 글씨와 재시도는 이미 이긴 경주를 다시 뛰라는 뜻이 된다. */}
            {stopOutcome ? (
              <Text
                style={[
                  styles.stopOutcome,
                  stopOutcome.outcome.kind === 'error' && styles.stopOutcomeError,
                ]}
                testID={`turn-stop-outcome-${stopOutcome.outcome.kind}`}>
                {stopOutcome.outcome.sentence}
              </Text>
            ) : null}
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
          onReplySent={() => setSelfSendToken(token => token + 1)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  /**
   * 중단의 결과 한 줄. 활동 줄과 입력창 사이, 방금 누른 버튼 바로 아래다 —
   * 토스트가 아니라 제자리 문장인 이유는 그것이 판단의 근거 옆이기 때문이다.
   */
  stopOutcome: {
    paddingHorizontal: SAFE_GUTTER,
    paddingBottom: space.xs,
    fontSize: font.meta,
    color: color.textMuted,
    lineHeight: 18,
  },
  // 「이미 끝났습니다」는 이 색을 쓰지 않는다. 실패가 아니라 답이다.
  stopOutcomeError: {color: color.danger},
});
