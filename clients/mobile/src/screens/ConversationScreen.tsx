import {uuidEq, type Message} from '@momo/core/lib/api';
import {
  quoteDraftFor,
  quoteDraftStillValid,
  type QuoteDraft,
} from '@momo/core/features/timeline/quote';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {
  dmAutoReplyAgent,
  dmPeer,
  unreadFor,
} from '@momo/core/features/workspace/directory';
import type {CancelOutcome} from '@momo/core/features/agents/runCancel';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AppState,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
  type TextInput,
} from 'react-native';
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
import {
  parseTurnPlaceholderKey,
  turnPlaceholderKey,
} from '@momo/core/features/agents/workingSignal';
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

/**
 * 만료(90초 TTL) 판정에 쓰는 시계의 격자, ms (goal RN-P2a).
 *
 * 화면의 경과 숫자는 1초마다 바뀌어야 하지만 **어떤 턴이 살아 있는가**는 그렇지
 * 않다. 그 판정에 1Hz 시계를 그대로 먹이면 파생되는 배열이 매초 새 동일성을 얻고,
 * 그 아래의 모든 `useMemo` 가 무효가 된다. 5초는 90초 TTL 대비 5.5% 의 지연이고,
 * 스토어의 zombie sweep 이 15초마다 도는 것보다 여전히 촘촘하다.
 */
const TURN_STALENESS_GRID_MS = 5_000;

/**
 * 읽음 커서를 몰아 보내는 지연, ms (goal RN-P2a).
 *
 * 사람이 알아채지 못할 만큼 짧고(채널을 열고 배지가 사라지기까지), 한 턴 동안
 * 쏟아지는 프레임을 한 번의 PUT + 한 번의 무효화로 접을 만큼은 길다.
 */
const READ_CURSOR_COALESCE_MS = 600;

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

  // ---- the action surface ---------------------------------------------------
  const [thread, setThread] = useState<Message | null>(null);
  const hint = useLongPressHint();

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
  const [jumpMissed, setJumpMissed] = useState<string | null>(null);
  useEffect(() => {
    setJumpTarget(null);
    setJumpMissed(null);
  }, [channelId]);

  const onJumpToQuoted = useCallback((message: Message) => {
    const targetId = message.replyToId;
    if (targetId === undefined) return;
    setJumpMissed(null);
    setJumpTarget(current => ({
      messageId: targetId,
      // 서버가 인용에 원본의 seq 를 실어 준다. 라이브 프레임으로 온 인용에는
      // 없으므로 `null` 이고, 그때는 「모르겠다」라고 말하게 된다.
      seq: message.replyTo?.seq ?? null,
      token: (current?.token ?? 0) + 1,
    }));
  }, []);

  const onJumpMissed = useCallback((reason: 'older' | 'unknown') => {
    setJumpMissed(
      reason === 'older'
        ? '인용한 원본은 이 대화의 더 위쪽에 있어 아직 불러오지 않았습니다. 위로 올려 이어서 불러오세요.'
        : '인용한 원본을 이 화면에서 찾지 못했습니다. 위로 올려 이전 대화를 더 불러오세요.',
    );
  }, []);

  // Bumped the moment a send is issued — before the round trip, because the
  // optimistic echo is already on screen and that is when it has to be visible.
  const [selfSendToken, setSelfSendToken] = useState(0);
  const {send} = timeline;
  const onSend = useCallback(
    (body: string) => {
      setSelfSendToken(token => token + 1);
      // 인용은 **보낸 순간** 떨어진다. 남겨 두면 다음 줄까지 같은 원본을 가리키게
      // 되는데, 그것을 원한 사람은 거의 없고 알아채는 사람은 더 적다. 컴포저가
      // 자기 글을 먼저 비우는 것과 같은 규율이다.
      const replyToId = quote?.targetId;
      setQuote(null);
      void send(body, replyToId);
    },
    [send, quote],
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
  const {toggleReaction, editBody, removeMessage, loadOlder, resend, reload} =
    timeline;
  const openThread = useCallback((message: Message) => setThread(message), []);
  const onStartReached = useCallback(() => void loadOlder(), [loadOlder]);
  const onResend = useCallback(
    (message: Message) => onSend(message.body ?? ''),
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
      onEdit: editBody,
      onDelete: removeMessage,
      onOpenThread: openThread,
      onQuote: onQuoteMessage,
      onJumpToQuoted,
      onLongPressUsed: hint.markUsed,
    }),
    [
      member.id,
      toggleReaction,
      editBody,
      removeMessage,
      openThread,
      onQuoteMessage,
      onJumpToQuoted,
      hint.markUsed,
    ],
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
              <View style={styles.notice}>
                <FailureBanner message={anchorNotice} testID="anchor-missed" />
              </View>
            ) : null}
            {/* 인용 점프가 빈손으로 돌아온 자리. 검색 앵커와 같은 배너를 쓴다 —
                같은 사실("이 화면에 그 줄이 없다")을 두 가지 모양으로 말할
                이유가 없다. */}
            {jumpMissed ? (
              <View style={styles.notice}>
                <FailureBanner message={jumpMissed} testID="quote-jump-missed" />
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
              working={working}
              reactions={timeline.reactions}
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
              quote={quote}
              onCancelQuote={onCancelQuote}
              inputRef={composerInputRef}
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
          onClose={closeThread}
          onReplySent={bumpSelfSend}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  notice: {padding: space.md},
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
