import {
  openDirectMessage,
  uuidEq,
  type Message,
} from '@momo/core/lib/api';
import {
  quoteDraftFor,
  quoteDraftStillValid,
  type QuoteDraft,
} from '@momo/core/features/timeline/quote';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {
  typingLabel,
  typingSegments,
  TYPING_AGGREGATE_THRESHOLD_FALLBACK,
} from '@momo/core/features/chat/typing';
import {
  channelLabel,
  memberFor,
  memberNameParts,
} from '@momo/core/features/workspace/directory';
import {
  dmAutoReplyAgent,
  dmPeer,
  unreadFor,
} from '@momo/core/features/workspace/directory';
import type {CancelOutcome} from '@momo/core/features/agents/runCancel';
import {useMutation} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
  type TextInput,
} from 'react-native';
import {NoticeBlock, Screen, ScreenHeader} from '../design/atoms';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {useStyles} from '../design/theme';
import {AdeControlPanel} from '../features/ade/AdeControlPanel';
import {AdeSummaryLine} from '../features/ade/AdeSummaryLine';
import {StopTurnControl} from '../features/agents/StopTurnControl';
import {MemberProfileSheet} from '../features/directory/MemberProfileSheet';
import {AgentActivityBar} from '../features/agents/turnSurfaces';
import {
  agentTurnsInChannel,
  hasChannelTurn,
  TURN_STALENESS_GRID_MS,
  useAgentWorkingSignals,
  useTickingNow,
} from '../features/agents/workingSignal';
import {
  parseTurnPlaceholderKey,
  turnPlaceholderKey,
} from '@momo/core/features/agents/workingSignal';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {decisionReceiptCopy} from '../features/inbox/ApprovalDecision';
import {useInvalidateApprovals} from '../features/inbox/useInbox';
import type {ApprovalReceipt} from '../features/conversation/approvalGate';
import {useOnline} from '../features/inbox/useOnline';
import {usePendingApprovals} from '../features/conversation/usePendingApprovals';
import {
  jumpMissedNotice,
  type JumpSubject,
} from '../features/conversation/jumpNotice';
import {
  Composer,
  type ComposerSendOptions,
} from '../features/conversation/Composer';
import {channelDraftKey} from '../features/conversation/drafts';
import {TypingBar} from '../features/conversation/TypingBar';
import {
  markTyping,
  resetTyping,
  sweepTyping,
  useTypists,
} from '../features/conversation/typingSignals';
import {useTypingSender} from '../features/conversation/useTypingSender';
import {ConversationLayout} from '../features/conversation/ConversationLayout';
import {
  LongPressHint,
  useLongPressHint,
} from '../features/conversation/LongPressHint';
import type {MessageRowActions} from '../features/conversation/MessageRow';
import {ThreadPanel} from '../features/conversation/ThreadPanel';
import {PinListPanel} from '../features/conversation/PinListPanel';
import {pinListHeaderLabel} from '@momo/core/features/timeline/pins';
import {Timeline} from '../features/conversation/Timeline';
import {useTimeline} from '../features/conversation/useTimeline';
import {useMarkRead} from '../features/inbox/useInbox';
import {
  useChannels,
  useDirectory,
  useReadStates,
  useRoleLabels,
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

/**
 * 읽음 커서를 몰아 보내는 지연, ms (goal RN-P2a).
 *
 * 사람이 알아채지 못할 만큼 짧고(채널을 열고 배지가 사라지기까지), 한 턴 동안
 * 쏟아지는 프레임을 한 번의 PUT + 한 번의 무효화로 접을 만큼은 길다.
 */
const READ_CURSOR_COALESCE_MS = 600;

/**
 * 걸어 둔 발원 앵커의 수명, ms (#1193 리뷰 M2).
 *
 * 「대화로」를 누르고 목적지 방이 뜨기까지 넉넉한 시간이되, 사람이 그 행동을
 * 잊을 만큼 길지는 않다. 이 시한이 지나면 앵커는 조용히 사라지고, 나중에 그
 * 방에 들어가도 아무 일도 일어나지 않는다 — 몇 분 전에 누른 것의 결과가 지금
 * 튀어나오는 것은 사람에게 원인 없는 사건이다.
 */
const PENDING_ANCHOR_TTL_MS = 30_000;

export default function ConversationScreen({
  channelId,
  title,
  anchor,
  onBack,
  onOpenConversation,
  onOpenAgent,
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
  /**
   * 다른 방을 연다 (이슈 1137).
   *
   * 이 화면이 이 프롭을 갖게 된 이유는 하나다: ADE 관제 목록의 카드가 **자기
   * 채널로 확대**되고, 그 목록은 워크스페이스 전역이라 도착지가 지금 열려 있는
   * 방이 아닐 수 있다. 셸의 `openConversation` 은 열려 있던 대화를 대체하므로
   * 뒤로가기는 여전히 한 겹이다(`navReducer`).
   */
  onOpenConversation?: (channelId: string, title: string) => void;
  /** 에이전트 프로필의 기존 상세 표면. 사람은 이 콜백을 쓰지 않는다. */
  onOpenAgent?: (agent: {
    memberId: string;
    displayName: string;
    handle: string;
  }) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {member, workspaceId} = useSession();
  const {rail, status: railStatus} = useRealtime();
  const nowMs = useNow();

  const {directory} = useDirectory(workspaceId);
  const {groups} = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  const roleLabels = useRoleLabels(workspaceId);
  const markRead = useMarkRead();

  const timeline = useTimeline(rail, workspaceId, channelId, member.id);
  const [profileMemberId, setProfileMemberId] = useState<string | null>(null);
  const profileMember = useMemo(
    () => memberFor(directory, profileMemberId ?? undefined),
    [directory, profileMemberId],
  );

  const {
    mutate: openProfileDm,
    reset: resetProfileDm,
    isPending: profileDmPending,
    error: profileDmError,
  } = useMutation({
    mutationFn: (memberId: string) => openDirectMessage(workspaceId, memberId),
    onSuccess: opened => {
      setProfileMemberId(null);
      onOpenConversation?.(
        opened.channel.id,
        channelLabel(opened.channel, directory, member.id),
      );
    },
  });
  const showMemberProfile = useCallback(
    (memberId: string) => {
      resetProfileDm();
      setProfileMemberId(memberId);
    },
    [resetProfileDm],
  );
  const closeMemberProfile = useCallback(() => {
    resetProfileDm();
    setProfileMemberId(null);
  }, [resetProfileDm]);

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
  // 초 단위로 흔들리는 `turnNowMs` 를 그대로 넣으면 이 배열은 매초 새 배열이 되고,
  // `AgentActivityBar` 안의 두 `useMemo`(`[turns, directory]`·`[turns]`)는 영영
  // 적중하지 못한다 — 초당 한 번 줄 문구를 처음부터 다시 만든다는 뜻이다.
  //
  // 그래서 만료 판정에만 필요한 만큼으로 시계를 **양자화**한다. TTL 은 90초이므로
  // 5초 격자면 만료가 최대 5초 늦을 뿐이고(그 사이 스토어의 15초 sweep 이 이미
  // 돌고 있다), 배열 동일성은 5초에 한 번만 바뀐다. 경과 숫자는 이 값을 쓰지
  // 않는다 — 그것은 아래로 그대로 내려가는 `turnNowMs` 의 몫이다.
  // 내림이 아니라 **올림**이다. 내림은 격자만큼 과거의 시각을 먹이므로 만료가
  // 그만큼 늦어지고, 늦은 만료는 「작업 중」을 사실보다 오래 말하는 쪽이다. 올림은
  // 반대로 최대 5초 일찍 거두는데, 그것은 이 제품이 늘 고르는 방향이다 — 모르면
  // 모른다고 말하지, 아는 척 붙들고 있지 않는다.
  const staleBucket = Math.ceil(turnNowMs / TURN_STALENESS_GRID_MS);
  const turns = useMemo(
    () =>
      agentTurnsInChannel(
        signals,
        channelId,
        staleBucket * TURN_STALENESS_GRID_MS,
      ),
    [signals, channelId, staleBucket],
  );

  // ---- 답이 나타날 자리 (#999) ---------------------------------------------
  //
  // 성재는 요청을 보낸 뒤 「작업 중」 UI 를 **한 번도 인지하지 못했다**. 배선이
  // 없어서가 아니라(#994 가 이미 놓았다) 그것이 시선 밖에 있어서다: 짧은 턴은 수
  // 초 만에 끝나고, 그 몇 초 동안 활동 줄은 컴포저 위 한 줄, 배지는 다른 탭에 있다.
  // 멘션을 막 친 사람의 눈은 대화의 맨 아래, 자기가 쓴 줄 다음 칸에 가 있다.
  //
  // 그래서 그 칸에 말한다. 도착하면 그 자리가 답으로 바뀌므로, **자리표시가
  // 사라지는 것 자체가 답이 왔다는 신호**가 된다 — 짧은 턴에서 특히 그렇다.
  //
  // 낙관하지 않는다: 멘션을 보냈다는 사실만으로는 아무 칸도 서지 않는다. 턴은
  // 관측으로만 증명되고(ADR-0126), 여기서 소비하는 것은 레일이 실제로 본 신호다.
  // 레일이 끊겨 있으면 자리표시도 서지 않는다 — 그때 화면에 남아 있어야 할 것은
  // 「곧 답이 온다」가 아니라 활동 줄이 이미 말하고 있는 「갱신이 멈췄습니다」다.
  //
  // 키로 memo 하는 이유는 `Timeline` 의 `working` prop 주석에 있다: 스트리밍
  // 청크마다 새 배열을 만들면 goal RN-P2a(#997)의 수리가 그대로 풀린다.
  const workingKey = railLive ? turnPlaceholderKey(turns) : '';
  const working = useMemo(
    () => parseTurnPlaceholderKey(workingKey),
    [workingKey],
  );

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
  //
  // ## …but not once per message (goal RN-P2a / #997, 후보 ③)
  //
  // 이 효과는 `newestSeq` 가 바뀔 때마다 돈다 — 즉 **메시지가 도착할 때마다**.
  // 그리고 `markRead` 는 PUT 하나로 끝나지 않는다: `read-state` 와 워크스페이스의
  // 모든 `inbox-mentions` 질의를 무효화한다(`useInbox.ts`). 그 무효화는 언제나
  // 마운트돼 있는 사이드바·인박스·탭바까지 닿으므로, 에이전트가 답을 흘리는 동안
  // 프레임마다 요청 한 벌과 목록 재조정 한 벌이 따라붙는다. 화면을 여는 순간에는
  // 그것이 밀어넣기 애니메이션과 정확히 겹친다.
  //
  // 커서는 **위치 보고**이지 사건이 아니므로 몰아서 보내도 뜻이 상하지 않는다:
  // 서버가 클램프하고 뒤로 가지 않으므로 마지막 값 하나면 충분하다.
  //
  // ## 떠날 때는 버리지 않고 **지금 보낸다** (1R M1)
  //
  // 첫 판은 예약을 `clearTimeout` 으로 버렸고, 그것이 P7 위반이었다. 600ms 창
  // 안에 채널을 떠나면(빠른 A→B 전환, 뒤로가기) 그 채널의 커서가 통째로 사라져
  // 안 읽음 배지가 남는다 — 사람은 이미 읽었는데.
  //
  // 방향의 안전성은 위 문단이 이미 증명한다: 서버가 클램프하고 뒤로 가지 않으므로
  // **일찍 보내는 것은 언제나 안전**하다. 위험한 것은 안 보내는 쪽뿐이다.
  //
  // 그런데 "cleanup 에서 무조건 발사"는 코얼레싱을 통째로 되돌린다 — 이 효과는
  // `newestSeq` 가 오를 때마다 다시 도므로, 그 cleanup 도 메시지마다 돈다. 그래서
  // 두 경우를 갈라야 한다:
  //
  //   **밀려남**(같은 채널에서 더 큰 seq 가 왔다) → 버린다. 곧 도착할 더 큰 값이
  //     이 값을 포함하므로 잃는 것이 없다. 코얼레싱은 여기서 산다.
  //   **떠남**(채널이 바뀌었다 / 화면이 사라졌다) → 지금 보낸다. 다음 기회가
  //     없을지도 모르는 유일한 경우다.
  //
  // 그 구분은 **의존성 배열**로 표현된다: 예약 효과는 `newestSeq` 에도 매이고,
  // 비우는 효과는 `channelId` 에만 매인다. React 는 한 커밋에서 모든 cleanup 을
  // 먼저 돌리므로, 채널이 바뀌는 순간 ref 에는 아직 **떠나는 채널**의 값이 있다.
  const cursorRef = useRef<{channelId: string; seq: number} | null>(null);
  const markReadRef = useRef(markRead);
  useEffect(() => {
    markReadRef.current = markRead;
  }, [markRead]);

  const flushReadCursor = useCallback(() => {
    const pending = cursorRef.current;
    if (pending === null) return;
    // 먼저 비운다: 이 값은 한 번만 보내면 되고, 떠나기와 타이머가 같은 값을 두 번
    // 보내는 것은 무효화 폭풍을 그만큼 두 번 부르는 일이다.
    cursorRef.current = null;
    void markReadRef.current(pending.channelId, pending.seq).catch(() => {
      /* the cursor stays put; the next open tries again */
    });
  }, []);

  const newestSeq = timeline.state.newestSeq;
  useEffect(() => {
    if (newestSeq === null) {
      // 채널이 막 바뀌어 타임라인이 아직 비었다. 떠나는 효과가 이미 옛 채널의
      // 값을 보냈으므로, 여기 남은 것이 있다면 그것은 **새 채널 id 에 옛 seq** 를
      // 붙인 한 프레임짜리 유령이다.
      cursorRef.current = null;
      return;
    }
    cursorRef.current = {channelId, seq: newestSeq};
    const timer = setTimeout(flushReadCursor, READ_CURSOR_COALESCE_MS);
    return () => clearTimeout(timer);
  }, [channelId, newestSeq, flushReadCursor]);

  useEffect(() => () => flushReadCursor(), [channelId, flushReadCursor]);

  // ## 세 번째 갈래: **앱이 앞에서 사라진다** (goal RN-B4e / #1011)
  //
  // #997(PR #1003)의 알려진 잔여다. 위의 두 갈래는 **React 가 도는 동안**에만
  // 성립한다 — 밀려남도 떠남도 커밋과 cleanup 이 있어야 일어나는 일이고, 홈 버튼을
  // 누르거나 앱 스위처로 넘어가는 것은 이 트리에 아무 커밋도 일으키지 않는다.
  // 예약된 `setTimeout` 은 iOS 가 앱을 재우는 순간 함께 멈추고, 마지막 600ms 창의
  // 커서는 그대로 남는다. 사람은 읽었는데 배지는 남아 있다.
  //
  // 방향의 안전성은 위 문단이 이미 증명해 두었다: 서버가 클램프하고 뒤로 가지
  // 않으므로 **일찍 보내는 것은 언제나 안전**하고, 위험한 것은 안 보내는 쪽뿐이다.
  //
  // `active` 가 아닌 **모든** 전이에서 보낸다 — `background` 뿐 아니라 `inactive`
  // 도. iOS 는 알림 센터를 내리거나 전화가 오는 것 같은 짧은 방해에서 `inactive`
  // 만 주고 곧 `active` 로 돌아오지만, 앱을 정말 재울 때도 `inactive` 를 먼저
  // 주고 그 다음에야 `background` 를 준다. 둘을 구별하려 들면 「어느 쪽인지 알게
  // 되는 시점」이 이미 늦은 뒤다. 잘못 보낸 쪽의 대가는 왕복 하나이고, 안 보낸
  // 쪽의 대가는 잘못된 배지다.
  //
  // 그리고 대부분의 전이에서는 **아무 일도 일어나지 않는다**: `flushReadCursor` 는
  // 보류 중인 값이 없으면 즉시 돌아오고, 보류는 마지막 메시지로부터 600ms 안에만
  // 존재한다. 이 구독이 요청을 만드는 것은 정확히 그 창 안에서 앱이 사라질 때뿐이다.
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next === 'active') return;
        flushReadCursor();
      },
    );
    return () => subscription.remove();
  }, [flushReadCursor]);

  // ---- 「작성 중」 (ADR-0149) ------------------------------------------------
  //
  // 수신: 기존 레일에 채널 하나를 더 건다. **보이는 채널만** — 사이드바의 모든
  // 방을 구독하면 읽지도 않을 프레임이 방 수 × 타이피스트 수만큼 들어오고, 그것은
  // 폰에서 배터리다. 이 화면이 살아 있는 동안만, 이 채널만.
  //
  // 레일이 끊기거나 채널을 옮기면 **명부를 비운다.** 남은 신호는 6초 뒤에 어차피
  // 만료되지만 그 6초가 거짓말이다 — 끊긴 동안 그 사람이 아직 치고 있는지 우리는
  // 모르고, 다른 방의 「작성 중」은 이 방에 대해 아무 말도 아니다. 이 화면이
  // 명부의 유일한 공급자이므로(구독은 보이는 채널 하나뿐) 통째로 비우는 것이 곧
  // 이 채널을 비우는 것이다.
  useEffect(() => {
    if (!rail || !railLive) {
      resetTyping();
      return undefined;
    }
    const detach = rail.subscribeTyping(workspaceId, channelId, {
      onTyping: markTyping,
    });
    return () => {
      detach();
      resetTyping();
    };
  }, [rail, railLive, workspaceId, channelId]);

  // 만료는 1Hz 시계가 훑는다. 두 번째 인터벌을 세우지 않는 이유는
  // `typingSignals.ts` 머리말에 있다 — 같은 박자를 두 번 사는 일이다.
  useEffect(() => sweepTyping(nowMs), [nowMs]);

  // 에이전트를 화면에서 떨구는 자리. 서버가 403 으로 막지만(`require_human`)
  // 그것은 서버의 방어이고 이것은 화면의 방어다: 어떤 경로로든 에이전트 id 를
  // 실은 신호가 그려지는 순간 「사람은 작성 중, 에이전트는 작업 중」이 깨진다.
  // 명부에 없는 id 도 떨군다 — 이름 없는 「누군가 작성 중」은 나르는 정보가 0이다.
  const isTypistEligible = useCallback(
    (memberId: string) => memberFor(directory, memberId)?.kind === 'human',
    [directory],
  );
  const typists = useTypists({
    channelId,
    nowMs,
    myMemberId: member.id,
    isEligible: isTypistEligible,
  });
  const typistNames = useMemo(
    () => typists.map(id => memberNameParts(directory, id, '').name),
    [typists, directory],
  );
  const typingParts = useMemo(
    () => typingSegments(typistNames, TYPING_AGGREGATE_THRESHOLD_FALLBACK),
    [typistNames],
  );
  const typingA11y = useMemo(
    () => typingLabel(typistNames, TYPING_AGGREGATE_THRESHOLD_FALLBACK),
    [typistNames],
  );

  // 송신: 타이머 없이 키스트로크에 매단다. 자세한 이유는 `useTypingSender` 머리말.
  const onTyping = useTypingSender(workspaceId, channelId, railLive);

  // ---- the action surface ---------------------------------------------------
  const [thread, setThread] = useState<Message | null>(null);
  const hint = useLongPressHint();

  // ---- ADE 관제 (이슈 1137, ADR-0154 D2) ------------------------------------
  //
  // 요약 줄은 헤더 아래에, 목록은 이 화면을 덮는 층에. 자리와 형식의 근거는 각
  // 컴포넌트의 머리말에 있다.
  //
  // 채널이 바뀌면 닫는다. 이 화면은 `channelId` 프롭만 갈아 끼우고 언마운트되지
  // 않으므로(셸이 위치로 렌더한다), 카드를 눌러 다른 방으로 간 다음 목록이 그대로
  // 떠 있으면 사람은 자기가 이동했다는 사실을 못 본다. 이 화면의 다른 per-channel
  // 초기화들(`quote`·`jumpTarget`·`stopOutcome`)과 같은 자리, 같은 이유다.
  const [adeOpen, setAdeOpen] = useState(false);
  useEffect(() => setAdeOpen(false), [channelId]);
  const closeAde = useCallback(() => setAdeOpen(false), []);
  const openAde = useCallback(() => setAdeOpen(true), []);

  // 고정 목록 (이슈 #1112). 작업 목록과 같은 자리, 같은 이유로 채널이 바뀌면
  // 닫힌다 — 이 화면은 `channelId` 만 갈아 끼우므로, 남겨 두면 A 채널의 고정
  // 목록이 B 채널 위에 떠 있게 된다.
  const [pinsOpen, setPinsOpen] = useState(false);
  useEffect(() => setPinsOpen(false), [channelId]);
  const closePins = useCallback(() => setPinsOpen(false), []);
  const openPins = useCallback(() => setPinsOpen(true), []);
  // 헤더의 낱말이 개수를 말한다. 0이면 「고정한 메시지」이고 숫자를 말하지
  // 않는다 — 「고정 0개」는 아무것도 알리지 않으면서 헤더의 폭만 가져간다.
  const pinCount = Object.keys(timeline.pins).length;
  // 그리고 **셀 자격이 있을 때만** 센다 (#1146 M2): 목록을 못 불러온 채로
  // 「고정 3개」라고 적으면, 목록 안에서 고친 거짓말이 헤더로 옮겨 갈 뿐이다.
  const pinLabel = pinListHeaderLabel(pinCount, timeline.pinsStatus);

  // ---- 걸어 둔 인용 (ADR-0148) ----------------------------------------------
  //
  // `thread` 와 같은 자리에 산다: 둘 다 「이 표면이 지금 무엇을 가리키고 있나」이고,
  // 둘 다 채널을 옮기면 뜻을 잃는다. 컴포저 **안**에 두지 않는 이유는 컴포저가
  // 마운트/언마운트되기 때문이다 — 스레드를 열었다 닫는 사이에 걸어 둔 인용이
  // 사라지면 사람은 자기가 무엇을 눌렀는지 의심하게 된다.
  const [quote, setQuote] = useState<QuoteDraft | null>(null);
  useEffect(() => setQuote(null), [channelId]);
  const composerInputRef = useRef<TextInput | null>(null);

  const messages = timeline.state.messages;
  // 걸어 둔 원본이 지워졌다. 서버는 받아 주지만(같은 채널이면 묘비도 유효한
  // 대상이다) 그렇게 보낸 글은 태어날 때부터 「삭제된 메시지」를 가리킨다. 조용히
  // 떼는 것이 맞다 — 걸어 둔 사람은 그 삭제를 이미 화면에서 봤다.
  useEffect(() => {
    if (quote === null) return;
    const lookup = (messageId: string) =>
      messages.find(message => uuidEq(message.id, messageId));
    if (!quoteDraftStillValid(quote, lookup)) setQuote(null);
  }, [quote, messages]);

  const onQuoteMessage = useCallback((message: Message) => {
    setQuote(quoteDraftFor(message));
    // 인용을 건 사람의 다음 동작은 100% 글쓰기다. 캐럿을 옮겨 주지 않으면 줄은
    // 떴는데 손은 아직 타임라인에 있다.
    composerInputRef.current?.focus();
  }, []);
  const onCancelQuote = useCallback(() => setQuote(null), []);

  // ---- 인용이 가리키는 줄로 이동 --------------------------------------------
  //
  // 토큰을 함께 올리는 이유: 같은 인용을 두 번 누르는 것은 **두 번의 요청**이고,
  // id 만 내려보내면 두 번째 누름에는 아무 일도 일어나지 않는다.
  const [jumpTarget, setJumpTarget] = useState<{
    messageId: string;
    seq: number | null;
    token: number;
  } | null>(null);
  // `NoticeBlock` 은 제목과 설명을 나눠 받는다 — 한 덩이 문장보다 이쪽이 낫다:
  // 첫 줄이 **무슨 일인지**, 둘째 줄이 **무엇을 하면 되는지**다.
  const [jumpMissed, setJumpMissed] = useState<{
    headline: string;
    detail: string;
  } | null>(null);
  /**
   * 지금 걸린 점프가 **무엇을 찾고 있는가** (#1193).
   *
   * 고지의 주어를 고른다. 상태가 아니라 ref 인 이유는 이 값이 화면을 그리지
   * 않기 때문이다 — 읽는 것은 `onJumpMissed` 한 곳뿐이고, 상태로 두면 그
   * 콜백의 동일성이 바뀌어 `Timeline` 의 `renderItem` 을 타고 목록 전체가 다시
   * 그려진다(이 화면이 `quoteRef` 에서 이미 고른 모양이다).
   */
  const jumpSubjectRef = useRef<JumpSubject>('quote');

  /**
   * 빈손으로 돌아온 점프가 **무엇을 기다리는가** (#1209 리뷰 High).
   *
   * 첫 판은 이 감시를 검색 진입에만 달았다. 그래서 같은 상자가 넷에게 같은 말을
   * 하는데 — 「위로 올려 이전 대화를 더 불러오세요」 — 그 말이 약속하는 결말은
   * **하나에서만** 일어났다. 고정·인용에서는 사람이 시킨 대로 위로 올려 그 줄이
   * 화면에 도착해도 아무 일이 없었고, 상자는 그 자리에 서서 이미 거짓이 된
   * 문장을 계속 말했다. 그 화면에서 거짓인 문장을 없애려고 시작한 배치가
   * 새 거짓 문장을 셋 만든 셈이다.
   *
   * 그래서 감시는 **주어의 성질이 아니라 점프의 성질**이다. 「무엇을 눌렀는가」가
   * 아니라 「목적지가 지금 목록에 있는가」만 본다 — 네 갈래가 이미 같은 기계를
   * 타고 있었으므로 붙일 자리도 하나다.
   *
   * 무장은 **놓친 순간**에만 일어난다(`onJumpMissed`). 놓쳤다는 것은 `Timeline`
   * 이 `items` 에서 그 줄도, 그것을 대신해 선 접힌 행도 못 찾았다는 뜻이고,
   * `items` 는 `messages` 에서 파생되므로 그 순간 목적지는 `messages` 에도 없다.
   * 즉 무장 시점의 답은 언제나 「없다」이고, 그래서 도착은 **변화**로만 온다.
   */
  const [awaitingJump, setAwaitingJump] = useState<{
    messageId: string;
    seq: number | null;
  } | null>(null);
  /**
   * 한 번의 기다림은 **한 번만** 다시 쏜다.
   *
   * 두 번째 발이 또 빈손이면(위 논증이 닫지 못하는 경로가 언젠가 생긴다면)
   * 무장 → 도착 → 발사 → 무장이 스스로를 물어 렌더 루프가 된다. 새 요청이
   * 들어오면(`requestJump`) 이 기억은 지워지므로, 막는 것은 **같은 기다림 안의**
   * 반복뿐이다.
   */
  const refiredRef = useRef<string | null>(null);

  // 방을 옮기면 앞선 방의 점프도, 그 방에서 기다리던 줄도 이 화면의 사실이 아니다.
  //
  // **아래의 세션 앵커 효과보다 먼저** 선언돼 있는 것이 load-bearing 이다: 같은
  // 커밋에서 둘 다 돌면 순서는 선언 순서이고, 반대로 두면 이 초기화가 방금 건
  // 점프를 지운다(#1193 이 그 자리에 이미 적어 둔 계약).
  useEffect(() => {
    setJumpTarget(null);
    setJumpMissed(null);
    setAwaitingJump(null);
    refiredRef.current = null;
  }, [channelId]);

  /**
   * 점프 한 번을 건다 — **네 갈래가 전부 이 문을 통과한다** (#1209 리뷰 High).
   *
   * 토큰을 올리는 이유: 같은 곳을 두 번 가리키는 것은 **두 번의 요청**이고, id 만
   * 내려보내면 두 번째 누름에 아무 일도 일어나지 않는다(웹이 `?msg=` 에서 만난
   * 그 벽과 같은 것이고, 그쪽도 같은 답을 든다).
   *
   * 새 요청은 앞선 기다림을 **접는다**: 사람이 다른 곳을 가리켰으면 앞의 목적지는
   * 더 이상 그가 원하는 곳이 아니다.
   */
  const requestJump = useCallback(
    (subject: JumpSubject, messageId: string, seq: number | null) => {
      jumpSubjectRef.current = subject;
      setJumpMissed(null);
      setAwaitingJump(null);
      refiredRef.current = null;
      setJumpTarget(current => ({
        messageId,
        seq,
        token: (current?.token ?? 0) + 1,
      }));
    },
    [],
  );

  const onJumpToQuoted = useCallback(
    (message: Message) => {
      const targetId = message.replyToId;
      if (targetId === undefined) return;
      // 서버가 인용에 원본의 seq 를 실어 준다. 라이브 프레임으로 온 인용에는
      // 없으므로 `null` 이고, 그때는 「모르겠다」라고 말하게 된다.
      requestJump('quote', targetId, message.replyTo?.seq ?? null);
    },
    [requestJump],
  );

  // 점프가 **성공하면** 고지는 스스로 물러난다. 남겨 두면 사람이 이미 도착한
  // 자리 위에 「못 찾았습니다」가 계속 붙어 있게 된다 — 다음 점프나 채널 이동까지.
  const clearJumpNotice = useCallback(() => setJumpMissed(null), []);

  /**
   * 사람이 상자를 물렸다 — 그러면 **뒤에 걸린 의도도 함께 접는다** (#1209 리뷰 Medium).
   *
   * 이 커밋이 이 고지에 처음으로 「기다렸다가 데려간다」를 달았고, 그 순간
   * 「닫기」의 뜻이 하나 늘었다. 닫기만 하고 기다림을 남기면, 상자를 물리고 자기
   * 이유로 옛 대화를 읽으러 올라간 사람을 그 줄이 도착하는 순간 읽던 자리에서
   * **끌어간다** — 사람이 방금 물린 바로 그 의도의 결과로.
   *
   * 세션 앵커가 30초 시계를 단 것과 같은 규율이되 **수단이 다르다**. 그쪽의
   * 대기는 화면에 아무 자국도 남기지 않으므로(방이 열릴 때까지 보이지 않는다)
   * 사람이 취소할 길이 없고, 그래서 시계가 필요했다. 이쪽의 대기는 **상자 그
   * 자체**다 — 서 있는 동안 화면에 보이고, 그것을 닫는 것이 곧 취소다. 보이지
   * 않는 의도에는 시계를, 보이는 의도에는 컨트롤을 준다.
   */
  const cancelJump = useCallback(() => {
    setJumpMissed(null);
    setAwaitingJump(null);
  }, []);

  /**
   * 고정 목록에서 원본으로 (이슈 #1112).
   *
   * `onJumpToQuoted` 와 **같은 기계**를 탄다. 고정 목록은 자기 항법을 만들지
   * 않는다 — 못 찾았을 때의 문장도 이미 저 아래(`jump-missed`)에 있고, 두
   * 번째를 그리면 같은 사실을 두 군데서 말하게 된다. 다만 그 문장의 **주어**는
   * 자기 것이다(#1196, 아래).
   *
   * `seq` 는 **항상** 있다: 서버의 고정 목록 항목이 메시지의 seq 를 나른다(인용
   * 라이브 프레임과 달리). 그래서 못 찾았을 때 「더 위에 있다」를 추측이 아니라
   * 사실로 말할 수 있다.
   */
  const onJumpToPinned = useCallback(
    (messageId: string, seq: number) => {
      // 고정을 누른 사람은 인용을 누른 적이 없다 (#1196). #1193 이 주어 갈래를 열고
      // 이 호출만 옛 기본값에 남겨 두어, 고정 목록에서 못 찾은 점프가 「인용한
      // 원본을 이 화면에서 찾지 못했습니다」라고 말했다 — 그 화면에서 거짓인 문장을
      // 없애려고 만든 바로 그 갈래에서.
      requestJump('pin', messageId, seq);
    },
    [requestJump],
  );

  // ---- ADE 카드의 「대화로」 (#1193) -----------------------------------------
  //
  // 세 번째 호출자이고, **같은 기계**를 탄다(위 둘과 같은 규율). 다른 점은 하나
  // 뿐이다: 목적지가 다른 방일 수 있다. 서랍 목록은 워크스페이스 전역이라
  // 「대화로」의 절반은 지금 열려 있지 않은 방으로 간다.
  //
  // 그래서 앵커를 **한 박자 들고 있는다**. 방을 여는 것은 셸의 일이고(이 화면은
  // `channelId` 프롭만 갈아 끼운다), 새 방의 타임라인이 도착하기 전에 점프를
  // 걸면 목록이 비어 있어 그 즉시 「찾지 못했습니다」가 뜬다 — 사실은 아직
  // 오는 중인데.
  //
  // 채널이 바뀔 때 도는 초기화(`setJumpTarget(null)`)보다 **뒤에** 선언돼 있는
  // 것이 load-bearing 이다: 같은 커밋에서 둘 다 돌면 순서는 선언 순서이고,
  // 반대로 두면 초기화가 방금 건 점프를 지운다.
  // **어느 방의 앵커인지 함께 든다** (리뷰 M2). 1차 판은 id 하나만 들고 「타임라인이
  // 준비되면 쏜다」였다. 목적지 방이 끝내 준비되지 않고(오프라인·조회 실패) 사람이
  // 다른 방을 열면 그 방에서 발사돼 「이 작업을 시작한 메시지를 이 화면에서 찾지
  // 못했습니다」를 띄운다 — 그 방이 한 번도 들고 있던 적 없는 메시지에 대해서.
  // 이 배치가 없애려고 나온 바로 그 종류의 거짓 문장이다.
  //
  // 그리고 **늙는다.** 방이 영영 안 열리면 앵커는 조용히 사라져야 한다: 몇 분 뒤
  // 우연히 그 방에 들어갔을 때 튀어나오는 점프는 사람이 방금 한 행동의 결과가 아니다.
  const [pendingAnchor, setPendingAnchor] = useState<{
    channelId: string;
    messageId: string;
  } | null>(null);
  useEffect(() => {
    if (pendingAnchor === null) return undefined;
    const timer = setTimeout(() => setPendingAnchor(null), PENDING_ANCHOR_TTL_MS);
    return () => clearTimeout(timer);
  }, [pendingAnchor]);
  useEffect(() => {
    if (pendingAnchor === null) return;
    // 아직 그 방이 아니다. 다른 방에서는 **절대** 쏘지 않는다.
    if (!uuidEq(pendingAnchor.channelId, channelId)) return;
    if (timeline.status !== 'ready') return;
    setPendingAnchor(null);
    // 세션 원장은 순서값을 나르지 않는다. 없는 seq 를 지어내지 않고, 그 대가로
    // 못 찾았을 때의 문장은 「더 위에 있다」로 정밀해지지 못한다.
    requestJump('session', pendingAnchor.messageId, null);
  }, [pendingAnchor, channelId, timeline.status, requestJump]);

  const onOpenAdeAnchor = useCallback(
    (targetChannelId: string, targetTitle: string, messageId: string) => {
      setPendingAnchor({channelId: targetChannelId, messageId});
      // 이미 그 방이면 방을 다시 열지 않는다. 셸에 같은 대화를 한 번 더 밀어도
      // 화면은 그대로지만, 그 왕복은 「눌렀는데 아무 일도 안 일어난 것 같은」
      // 한 프레임을 만든다.
      if (uuidEq(targetChannelId, channelId)) return;
      onOpenConversation?.(targetChannelId, targetTitle);
    },
    [channelId, onOpenConversation],
  );

  // ===========================================================================
  // 타임라인 승인 (감사 H-1 / goal U4-g)
  //
  // 카드는 메시지의 스냅샷이고 「지금 결정할 수 있는가」는 승인 원장만 안다 —
  // 왜 그런지는 `approvalGate.ts` 머리말에 있다. 여기서 **한 번** 구독해서
  // 목록에 나눠 준다: 행마다 물으면 승인 카드가 셋 있는 화면에서 셋이 같은
  // 목록을 각자 부른다.
  //
  // 영수증도 여기 있다. 결정한 순간 그 승인은 대기 목록에서 빠지므로 컨트롤과
  // 영수증은 **같은 순간에 서로 반대로** 움직인다 — 영수증을 행의 상태로 두면
  // 방금 누른 사람이 영수증 대신 예전 안내 문장을 보게 된다.
  // ===========================================================================
  const {gates: approvalGates, provided: approvalsProvided} =
    usePendingApprovals(channelId);
  // **레일 상태(`railStatus`)가 아니다.** 레일은 웹소켓이고 결정은 REST 로
  // 나간다 — 레일이 재연결 중이어도 그 POST 는 멀쩡히 성공한다. 승인에는
  // 기한이 있으므로, 할 수 있는 결정을 막는 쪽이 더 비싸다.
  //
  // 이름이 `approvalOnline` 이 아닌 이유(goal U4-6M): 소비자가 둘이 됐다.
  // **전송도 REST POST** 이므로 컴포저가 물어야 하는 것도 정확히 같은 질문이고,
  // 컴포저는 그동안 레일을 읽고 있었다. 한 화면이 같은 사실에 두 신호를 들면
  // 그 둘은 반드시 갈라진다 — 이 파일이 「연결 중…」 하나로 두 상태를 덮던 옛
  // 결함(M3)에서 이미 배운 것이다.
  const networkOnline = useOnline();
  const invalidateApprovals = useInvalidateApprovals();
  const [approvalReceipts, setApprovalReceipts] = useState<
    ReadonlyMap<string, ApprovalReceipt>
  >(() => new Map());
  const onApprovalSettled = useCallback(
    (approvalId: string, outcome: DecisionOutcome) => {
      const note = decisionReceiptCopy(outcome);
      // 문장과 **상태**를 함께 든다. 상태가 없으면 칩은 스냅샷을 그대로 둔다 —
      // 원장이 알아볼 수 없는 상태를 답했을 때 우리가 지어내지 않는다.
      setApprovalReceipts(previous =>
        new Map(previous).set(approvalId, {note, status: outcome.status}),
      );
      // 결과도 말해 준다. 무장은 알리고 결과는 알리지 않으면, 화면을 보지 않는
      // 사람에게 되돌릴 수 없는 행동이 소리 없이 끝난 것이 된다(인박스 2R H3).
      AccessibilityInfo.announceForAccessibility(note);
      invalidateApprovals();
    },
    [invalidateApprovals],
  );

  // 문장은 `jumpNotice.ts` 가 든다 — **측정 하네스가 같은 상수를 읽어 사진을
  // 찍기 때문**이다(H-5 는 「코드 확인 / 시각 SKIPPED」로 남아 있었다). 하네스가
  // 베껴 적으면 배송되는 문장이 바뀌어도 사진은 옛말을 계속 한다.
  //
  // 그리고 **무엇을 찾다 놓쳤는지 붙들어 둔다** (#1209 리뷰 High). 상자가 시키는
  // 일을 사람이 해내면 그때 데려가야 하고, 그러려면 목적지를 기억하고 있어야
  // 한다. 목적지는 지금 걸린 점프 그 자체이므로 거울(`jumpTargetRef`)에서 읽는다 —
  // 상태로 받으면 이 콜백의 동일성이 바뀌고, 그것은 `Timeline` 의 `renderItem` 을
  // 타고 「붙어 있는 모든 행을 다시 그려라」가 된다(`jumpSubjectRef` 와 같은 이유).
  const jumpTargetRef = useRef<typeof jumpTarget>(null);
  jumpTargetRef.current = jumpTarget;
  const onJumpMissed = useCallback((reason: 'older' | 'unknown') => {
    setJumpMissed(jumpMissedNotice(reason, jumpSubjectRef.current));
    const target = jumpTargetRef.current;
    if (target === null) return;
    setAwaitingJump({messageId: target.messageId, seq: target.seq});
  }, []);

  // Bumped the moment a send is issued — before the round trip, because the
  // optimistic echo is already on screen and that is when it has to be visible.
  const [selfSendToken, setSelfSendToken] = useState(0);
  const {send} = timeline;
  // 거울. `onSend` 가 `quote` 를 **의존성으로** 들면 인용을 걸고 무를 때마다 이
  // 핸들러의 동일성이 바뀌고, 그것은 `Timeline` 의 `renderItem` 을 타고 내려가
  // 「붙어 있는 모든 행을 다시 그려라」가 된다(goal RN-P2a 가 산 것). 사람의
  // 동작이라 초당 한 번은 아니지만, 값을 읽기만 하면 되는 자리에서 목록 전체를
  // 지불할 이유가 없다 — 이 화면이 `markReadRef` 에서 이미 고른 모양이다.
  const quoteRef = useRef<QuoteDraft | null>(null);
  quoteRef.current = quote;
  const onSend = useCallback(
    (body: string, options?: ComposerSendOptions) => {
      setSelfSendToken(token => token + 1);
      // 인용은 **보낸 순간** 떨어진다. 남겨 두면 다음 줄까지 같은 원본을 가리키게
      // 되는데, 그것을 원한 사람은 거의 없고 알아채는 사람은 더 적다. 컴포저가
      // 자기 글을 먼저 비우는 것과 같은 규율이다.
      const replyToId = quoteRef.current?.targetId;
      setQuote(null);
      void send(body, replyToId, options?.attachments);
    },
    [send],
  );

  // ---- 리스트에 내려가는 핸들러는 전부 고정된 동일성이어야 한다 (goal RN-P2a) --
  //
  // 이 넷은 JSX 안의 인라인 화살표였다. 그 자리에서 그것은 스타일이 아니라 **성능
  // 계약의 파기**다: `Timeline` 의 `renderItem` 이 `onResend`/`onResendPending` 을
  // 의존성으로 들고 있으므로, 인라인 화살표 하나가 이 화면의 모든 렌더를
  // "붙어 있는 모든 메시지 행을 다시 그려라"로 번역한다
  // (`CellRenderer` 는 `PureComponent` 이고, 비교하는 것이 바로 그 함수다).
  //
  // 턴이 열려 있으면 이 화면은 초당 한 번 다시 그려지므로, 그 번역은 초당 한 번
  // 일어나고 있었다.
  const {
    toggleReaction,
    togglePin,
    editBody,
    removeMessage,
    loadOlder,
    resend,
    reload,
  } = timeline;
  const openThread = useCallback((message: Message) => setThread(message), []);
  const onStartReached = useCallback(() => void loadOlder(), [loadOlder]);
  const onResend = useCallback(
    (message: Message) =>
      onSend(
        message.body ?? '',
        message.attachments === undefined
          ? undefined
          : {attachments: message.attachments},
      ),
    [onSend],
  );
  const onResendPending = useCallback(
    (clientMsgId: string) => void resend(clientMsgId),
    [resend],
  );
  const closeThread = useCallback(() => setThread(null), []);
  // 같은 이유로 고정된다. 이 화면은 턴이 열려 있는 동안 초당 한 번 다시 그려지고,
  // 인라인이면 그때마다 `StopTurnControl`(자체 상태 셋을 든 컴포넌트)이 새 엘리먼트가
  // 된다 — 사람이 「중단」을 겨누고 있는 바로 그 컨트롤을.
  const renderStop = useCallback(
    (turn: {
      runId: string;
      memberId: string;
      name: string;
      runCount?: number;
    }) => (
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
    ),
    [],
  );
  const bumpSelfSend = useCallback(
    () => setSelfSendToken(token => token + 1),
    [],
  );
  const actions = useMemo<MessageRowActions>(
    () => ({
      myMemberId: member.id,
      onToggleReaction: toggleReaction,
      onTogglePin: togglePin,
      onEdit: editBody,
      onDelete: removeMessage,
      onOpenThread: openThread,
      onQuote: onQuoteMessage,
      onJumpToQuoted,
      onLongPressUsed: hint.markUsed,
      onOpenProfile: showMemberProfile,
    }),
    [
      member.id,
      toggleReaction,
      togglePin,
      editBody,
      removeMessage,
      openThread,
      onQuoteMessage,
      onJumpToQuoted,
      hint.markUsed,
      showMemberProfile,
    ],
  );

  // ---- 검색 결과로 들어온 자리에 **내려앉는다** (#1196) -----------------------
  //
  // 여태 이 화면은 그 자리를 **말하기만 했다**: 앵커가 로드된 목록에 없으면
  // 「찾지 못했습니다」를 세우고, 있으면 아무것도 하지 않았다 — 있어도 데려가지
  // 않았다는 뜻이다. 검색 결과를 누른 사람은 채널 바닥에 도착해 자기가 방금 읽은
  // 문장을 눈으로 다시 찾아야 했다. 웹은 같은 경로에서 **착지한다**(`?msg=` +
  // `bringIntoView`), 그래서 같은 제품의 두 클라이언트가 같은 동작에 다른 규율을
  // 갖고 있었다 (#1195 가 「하지 않은 것」으로 남긴 그 자리).
  //
  // 새 기계를 만들지 않는다. 착지 문법은 이 화면에 **이미 있고**(`jumpTarget` —
  // 인용·고정·세션 앵커 셋이 함께 타는 그것), #1195 가 웹에 이식할 때 베낀 원본이
  // 정확히 이것이다. 네 번째 호출자가 된다.
  //
  // 한 번만 쏜다. 놓치면 그 다음은 **모든 점프가 함께 쓰는** 기다림이 맡는다
  // (`awaitingJump`) — 이 경로에만 달려 있던 두 번째 발을 점프 자체의 성질로
  // 올린 것이 #1209 리뷰 High 의 수리다.
  const firedEntryAnchorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!anchor || timeline.status !== 'ready') return;
    if (firedEntryAnchorRef.current === anchor.messageId) return;
    firedEntryAnchorRef.current = anchor.messageId;
    // 검색 결과는 `seq` 를 함께 든다(`MessageSearchHit`). 세션 앵커와 갈리는
    // 유일한 자리이고, 그래서 못 찾았을 때 「더 위쪽에 있다」를 추측이 아니라
    // 사실로 말할 수 있다 — `Timeline` 이 로드된 가장 오래된 seq 와 견준다.
    requestJump('search', anchor.messageId, anchor.seq);
  }, [anchor, timeline.status, requestJump]);

  /**
   * 기다리던 줄이 도착했다 → **그때 데려간다** (#1209 리뷰 High).
   *
   * 「위로 올려 이전 대화를 더 불러오세요」를 따른 사람에게 화면이 지키는 약속이
   * 이 효과다. 없으면 그 문장은 따르고 나면 거짓이 되고, 사람은 자기가 지시를
   * 완수했다는 사실조차 화면에서 못 읽는다.
   *
   * 주어는 그대로 둔다(`jumpSubjectRef`) — 두 번째 발은 같은 사람이 누른 같은
   * 요청의 계속이지 새 요청이 아니다. 착지하면 `onJumpLanded` 가 상자를 거두고,
   * 그 사라짐이 곧 「도착했다」의 유일한 신호다.
   */
  const awaitingArrived = useMemo(() => {
    if (awaitingJump === null || timeline.status !== 'ready') return false;
    return timeline.state.messages.some(message =>
      uuidEq(message.id, awaitingJump.messageId),
    );
  }, [awaitingJump, timeline.status, timeline.state.messages]);
  useEffect(() => {
    if (awaitingJump === null || !awaitingArrived) return;
    if (refiredRef.current === awaitingJump.messageId) return;
    refiredRef.current = awaitingJump.messageId;
    setAwaitingJump(null);
    setJumpTarget(current => ({
      messageId: awaitingJump.messageId,
      seq: awaitingJump.seq,
      token: (current?.token ?? 0) + 1,
    }));
  }, [awaitingJump, awaitingArrived]);

  return (
    <Screen>
      <ScreenHeader
        title={title}
        subtitle={railSubtitle(railStatus)}
        onBack={onBack}
        titleTestID="conversation-title"
        // 이슈 #1112 — 고정 목록으로 가는 문. 헤더의 오른쪽 슬롯은 이 화면에서
        // 비어 있었고, 사이드바의 검색 진입 액션(`SearchEntryAction`)이 쓰는 그
        // 자리다. 고정이 하나도 없어도 남는다: 처음 고정하는 사람이 목록이 어디
        // 있는지 배울 자리가 필요하고, 그때 열리는 화면이 빈 상태로 그것을 말한다.
        //
        // 그 액션을 **이름이 아니라 컴포넌트로** 가리킨다 (이슈 #1170 N2): 이 줄은
        // 한 번 이미 낡았다. 「메시지 찾기」라고 적혀 있었고 그 이름은 #1146 N4 에서
        // 사라졌는데, 산문은 아무것도 컴파일하지 않으므로 조용히 남아 있었다.
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pinLabel}
            onPress={openPins}
            style={({pressed}) => [styles.headerAction, pressed && styles.pressed]}
            testID="open-pin-list">
            <Text style={styles.headerActionLabel}>
              {pinLabel}
            </Text>
          </Pressable>
        }
      />
      {/* 워크스페이스 전역 집계 한 줄. 살아 있는 작업이 없으면 **아무것도 그리지
          않는다** — 빈 띠도 남기지 않는 것이 이 줄의 계약이고, 그래서 이 자리는
          컴포저 액세서리 스택이 아니다(`AdeSummaryLine` 머리말의 세 근거). */}
      <AdeSummaryLine onPress={openAde} />
      <ConversationLayout
        list={
          <>
            {/* 점프가 빈손으로 돌아온 자리. **하나뿐이다** (#1196).
                인용·고정·세션 앵커·검색 진입 넷이 같은 배너를 쓴다 — 같은
                사실("이 화면에 그 줄이 없다")을 두 가지 모양으로 말할 이유가 없고,
                이제는 두 벌을 그릴 수도 없다: 검색 진입이 같은 착지 기계를 타므로
                두 고지를 두면 못 찾은 한 번에 같은 문장이 **두 줄** 선다.
                (M1 이 두 배너에 같은 모양을 쓰게 한 판단의 끝이 이것이다.)

                옛 검색 배너는 닫기가 없었다 — 「이 화면은 당신이 찾아온 메시지를
                아직 안 들고 있다」는 **상태**라는 근거였다. 그 근거가 이 커밋에서
                바뀐다: 이제 그 문장은 사람이 누른 결과에 대한 답이고(눌렀고, 갔고,
                거기 없었다), 시킨 대로 위로 올려 그 줄이 도착하면 **스스로 물러난다**
                (두 번째 발이 착지하며 `onJumpLanded`). 닫을 수 있는 영수증의 조건을
                그대로 갖췄다(`NoticeBlock.onDismiss` 독스트링). */}
            {/* ===================================================
                실패가 아니라 **사실 진술**이다 (design-review H-5).

                사람이 인용을 눌렀고, 원본은 존재하며, 아직 안 불러왔을 뿐이다.
                빨간 상자(`FailureBanner` = dangerSurface + dangerBorder)는
                「내가 뭔가 잘못했다」를 말한다. `atoms` 에 이 경우를 위한
                컴포넌트가 이미 있었다 — `NoticeBlock`, 독스트링 그대로
                *"A statement of fact that is not a failure … Deliberately has
                no retry and no danger colour."*

                닫는 길도 준다. `NoticeBlock` 의 `onDismiss` 독스트링이 「영수증인
                알림에만」이라고 못박아 두었는데, 이 줄은 정확히 그것이다: 사람이
                방금 한 동작(인용 탭)에 대한 답이고, 한 번 읽으면 목록 아래에
                영영 붙어 있을 이유가 없다. 서버가 못 하는 일에 대한 고지가
                아니다.

                점프가 성공하면 스스로도 물러난다(`clearJumpNotice`).

                그리고 닫기는 **뒤에 걸린 기다림도 접는다**(`cancelJump`, #1209
                리뷰 Medium). 이 상자는 이제 서 있는 동안 「그 줄이 오면 데려간다」는
                의도를 함께 들고 있으므로, 상자를 물리는 것이 곧 그 의도를 무르는
                것이다 — 물리고 자기 이유로 위로 올라간 사람을 나중에 끌어가지
                않는다.
                =================================================== */}
            {jumpMissed ? (
              <View style={styles.notice}>
                <NoticeBlock
                  headline={jumpMissed.headline}
                  detail={jumpMissed.detail}
                  onDismiss={cancelJump}
                  testID="jump-missed"
                />
              </View>
            ) : null}
            <Timeline
              approvalGates={approvalGates}
              approvalReceipts={approvalReceipts}
              approvalOffline={!networkOnline}
              // 원장 표면이 없는 서버에서는 「다시 연결되면 여기서」가 거짓말이
              // 된다 — 코어가 그 갈래를 오프라인보다 앞에 두는 이유이고, 이
              // 사실은 이 훅만 안다.
              approvalsProvided={approvalsProvided}
              onApprovalSettled={onApprovalSettled}
              messages={timeline.state.messages}
              directory={directory}
              status={timeline.status}
              channelKind={channel?.kind}
              peer={peer}
              lastReadSeq={frozen?.lastReadSeq ?? null}
              unreadCount={frozen?.unreadCount ?? 0}
              recoveryMarkers={timeline.recoveryMarkers}
              pending={timeline.pending}
              working={working}
              reactions={timeline.reactions}
              pins={timeline.pins}
              myMemberId={member.id}
              loadingOlder={timeline.loadingOlder}
              reachedStart={timeline.reachedStart}
              nowMs={nowMs}
              actions={actions}
              selfSendToken={selfSendToken}
              onStartReached={onStartReached}
              onRetry={reload}
              onResend={onResend}
              onResendPending={onResendPending}
              jumpTarget={jumpTarget ?? undefined}
              onJumpMissed={onJumpMissed}
              onJumpLanded={clearJumpNotice}
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
              renderStop={renderStop}
            />
            {/* ===================================================
                「작업 중」 **바로 아래** (design-review M-5).

                둘은 같은 질문에 답하는 두 줄이다 — 「지금 누가 무언가 하고
                있는가」. 그 사이에 중단 영수증과 롱프레스 힌트가 끼면 나란히
                두는 것만으로 얻으려던 대조(작성 중 ↔ 작업 중)가 끊긴다.

                첫 판이 이 줄을 맨 아래 둔 이유는 「사라지는 것이 아래에 있어야
                「중단」 버튼이 손가락 밑에서 안 움직인다」였는데, **H-3 이 자리를
                예약하면서 그 이유가 사라졌다** — 이제 이 줄은 나타나고 사라지며
                아무것도 밀어내지 않는다. 수리 하나가 다른 수리를 가능하게 한 자리다.
                =================================================== */}
            <TypingBar segments={typingParts} label={typingA11y} />
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
              // 조사를 정하는 사실 (#1384): DM 의 title 은 방 이름이 아니라 상대
              // 이름이라 「hermes에」가 아니라 「hermes에게」여야 한다. `peer` 로
              // 묻는 이유는 로스터가 아직 안 온 DM 의 label 이 사람 이름이 아니라
              // "다이렉트 메시지"이고(`channelLabelParts`), 그때는 에가 맞아서다.
              recipient={peer ? 'person' : 'place'}
              directory={directory}
              dmAgent={dmAgent}
              // 승인 컨트롤과 **같은 신호**다. 전송도 REST POST 이므로 레일이
              // 재연결 중이라는 사실은 「보낼 수 있는가」에 답하지 않는다 —
              // 옛 배선(`railStatus === 'disconnected'`)이 답한다고 주장했을
              // 뿐이다. 근거는 `useOnline.ts` 머리말, 판정은 `Composer` 의
              // `offline` prop 주석에 있다.
              offline={!networkOnline}
              draftKey={channelDraftKey(channelId)}
              attachmentTarget={{workspaceId, channelId}}
              quote={quote}
              onCancelQuote={onCancelQuote}
              inputRef={composerInputRef}
              onTyping={onTyping}
              onSend={onSend}
            />
          </>
        }
      />

      {thread ? (
        <ThreadPanel
          root={thread}
          workspaceId={workspaceId}
          channelId={channelId}
          timeline={timeline}
          directory={directory}
          myMemberId={member.id}
          nowMs={nowMs}
          onClose={closeThread}
          onReplySent={bumpSelfSend}
          onOpenProfile={showMemberProfile}
        />
      ) : null}

      {/* 스레드보다 **뒤에** 선다. 둘이 동시에 열릴 수 있는 경로는 없지만(스레드가
          열려 있으면 요약 줄은 그 밑에 있다) DOM 순서가 곧 층이므로, 나중에 어느
          쪽이 위인지 묻게 되는 날 답은 「방금 연 것」이어야 한다.

          `onOpenConversation` 이 없으면 목록을 아예 세우지 않는다. 확대할 곳이
          없는 카드 목록은 훑을 수만 있는 목록이고, 그것은 이 층이 존재하는 이유가
          아니다 — 셸이 아닌 곳에서 이 화면을 쓰는 호출자(측정 하네스)에게 목록만
          떠 있는 상태를 만들어 주지 않는다. */}
      {/* 고정 목록. 스레드보다 뒤, 작업 목록보다 앞 — 층은 JSX 순서다.
          누르면 이 화면은 물러나고 `jumpTarget` 이 그 줄로 데려간다. */}
      {pinsOpen ? (
        <PinListPanel
          pins={timeline.pins}
          status={timeline.pinsStatus}
          directory={directory}
          nowMs={nowMs}
          onJump={onJumpToPinned}
          onClose={closePins}
          onRetry={timeline.reloadPins}
        />
      ) : null}

      {adeOpen && onOpenConversation ? (
        <AdeControlPanel
          onClose={closeAde}
          onOpenChannel={onOpenConversation}
          onOpenAnchor={onOpenAdeAnchor}
        />
      ) : null}

      {profileMember ? (
        <MemberProfileSheet
          member={profileMember}
          directory={directory}
          selfMemberId={member.id}
          online={networkOnline}
          dmPending={profileDmPending}
          dmError={profileDmError}
          onClose={closeMemberProfile}
          onOpenDm={() => openProfileDm(profileMember.id)}
          onOpenAgent={
            profileMember.kind === 'agent' && onOpenAgent
              ? () => {
                  closeMemberProfile();
                  onOpenAgent({
                    memberId: profileMember.id,
                    displayName: profileMember.displayName,
                    handle: profileMember.handle,
                  });
                }
              : undefined
          }
          roleLabels={roleLabels}
        />
      ) : null}
    </Screen>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  notice: {padding: space.md},
  // 사이드바의 검색 진입 액션(`SearchEntryAction`)과 같은 모양이다 (이슈 #1112):
  // 헤더의 오른쪽 액션은 이 앱에서 이미 이렇게 생겼고, 두 번째 모양을 만들 이유가
  // 없다. 그 컨트롤을 보이는 낱말로 부르지 않는 이유는 위 `right=` 주석과 같다.
  headerAction: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    marginRight: -space.sm,
    borderRadius: radius.sm,
  },
  headerActionLabel: {
    fontSize: font.label,
    color: color.accentText,
    fontWeight: '600',
  },
  pressed: {backgroundColor: color.surfacePressed},
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
