import {uuidEq, type Message} from '@momo/core/lib/api';
import {THREAD_COMPOSER_PLACEHOLDER} from '@momo/core/features/chat/composerCopy';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {ErrorState, Screen, ScreenHeader} from '../../design/atoms';
import {font, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {EdgeSwipeBack} from '../../nav/EdgeSwipeBack';
import {Composer} from './Composer';
import {ConversationLayout} from './ConversationLayout';
import {threadDraftKey} from './drafts';
import {useOnline} from '../inbox/useOnline';
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
  const styles = useStyles(buildStyles);
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

  const {toggleReaction, editBody, removeMessage, togglePin} = timeline;
  const actions = useMemo<MessageRowActions>(
    () => ({
      myMemberId,
      onToggleReaction: toggleReaction,
      onEdit: editBody,
      onDelete: removeMessage,
      // 이슈 #1146 M1 — **a reply is pinned from where it is read**, which is
      // the sentence the web thread panel has carried since #1112. The phone
      // did not, and that split had no reason: it was the one action the web
      // offered here that this file forgot to pass on.
      //
      // 그리고 이것은 바로 아래 `onQuote` 의 부재와 **다른 종류의 판단**이다.
      // 인용은 결과가 이 패널 뒤의 채널 컴포저에 떨어져서 화면 밖으로 나가지만,
      // 고정의 결과는 **여기 있다**: 그 행의 액션 낱말이 「고정 해제하기」로
      // 뒤집히고, 꼬리에 「고정됨」이 서고, 거절 문장도 그 행 안에 선다(#1146 M3).
      // 헤더의 목록은 채널로 돌아가면 늘어 있지만, 그것은 이 행동의 영수증이
      // 아니라 그 결과가 모이는 곳이다.
      onTogglePin: togglePin,
      // No `onOpenThread`: see the header. Every row here is already in one.
      //
      // No `onQuote` either, and that absence is a decision rather than an
      // omission. ADR-0148 규칙 1 explicitly allows quoting a reply from inside
      // its thread — but the composer that would receive the quote is the
      // CHANNEL's, and on a phone that composer is behind this panel. Pinning a
      // quote to an input the person cannot see is the shape of thing this
      // product keeps refusing: an action whose result is off screen. The
      // honest version needs this panel's own composer to carry it, which is a
      // decision about where a quoted thread reply lands (본류 or the thread)
      // and belongs to whoever makes that one.
    }),
    [myMemberId, toggleReaction, editBody, removeMessage, togglePin],
  );

  const pending = timeline.repliesPending(root.id);
  // 채널 컴포저와 **같은 신호**다 — 답글도 REST POST 로 나가고, 같은 앱의 두
  // 입력창이 같은 상황에 다른 얼굴을 하면 그것은 어휘 분열이다
  // (`features/inbox/useOnline.ts` 머리말이 승인 컨트롤에 대해 하는 말과 같다).
  const online = useOnline();
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
      <EdgeSwipeBack style={styles.overlay} onBack={onClose}>
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
      </EdgeSwipeBack>
    );
  }

  return (
    // 이 패널은 대화 **안에** 그려지므로 대화의 엣지 스와이프 래퍼와 부모-자식으로
    // 겹친다. 안쪽이 이긴다는 판정은 `EdgeSwipeBack` 이 컨텍스트로 스스로 한다 —
    // 스레드를 열어 둔 채 엣지를 밀면 닫히는 것은 스레드 하나이고, 대화는 그대로
    // 남는다. 뒤로가기가 한 번에 한 겹씩만 벗겨진다는 것은 헤더의 「‹」 버튼이
    // 이미 지키던 규칙이고, 제스처가 그것을 다르게 해석하면 안 된다.
    <EdgeSwipeBack style={styles.overlay} onBack={onClose}>
      <Screen>
        {/* ## 부제에 「답글 N개」를 적지 않는다 (goal RN-U2)
            성재: "답글에서 개수 업데이트는 굳이 왜 해? 목록에 나오면 몇 개의
            reply가 있는지는 자연스러운데, 답글에서 '답글 1개' 이런 식으로 보이는
            건 자연스럽지 않은 거 같아."

            루트 행의 롤업과 **같은 결함이고, 더 눈에 띄는 쪽이다** — 답글을 하나
            달 때마다 화면 맨 위의 숫자가 오른다. 이미 이 스레드 안에 있는 사람에게
            그 숫자는 정보가 0이다. 세는 일이 필요한 곳은 "여기 스레드가 있다"를
            알려야 하는 채널 목록이지 스레드 안이 아니다. */}
        <ScreenHeader
          title="스레드"
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
              // 이슈 #1146 M1 — 채널과 **같은 지도**다. 행마다의 `pinned` 는
              // `Timeline` 이 여기서 유도하므로, 이것 없이 `onTogglePin` 만 주면
              // 이미 고정된 답글이 「고정하기」라고 말한다.
              pins={timeline.pins}
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
              // 그리고 루트 행의 「답글 N개 · 마지막 …」도 그리지 않는다. 롤업은
              // **채널에서 "여기 스레드가 있다"를 알리는 장치**이고, 이미 그 스레드를
              // 열어 둔 사람에게는 자기가 서 있는 곳의 이름을 다시 읽어 주는 것에
              // 불과하다. 핸들러가 없으니 글로 그려지긴 했지만, 문제는 눌리느냐가
              // 아니라 **그 줄이 여기서 할 말이 없다**는 것이었다.
              showRollup={false}
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
                // 채널과 **다른 이름 공간**이다(`drafts.ts`). 스레드에 쓰다 만
                // 답글이 채널 입력창에서 되살아나면 그 글은 잘못된 방으로 간다.
                draftKey={threadDraftKey(root.id)}
                offline={!online}
                // 웹 `timeline/ThreadComposer.tsx` 와 한 벌이다 (#1384).
                placeholder={THREAD_COMPOSER_PLACEHOLDER}
                sendLabel="답글 보내기"
                onSend={onSend}
              />
            </View>
          }
        />
      </Screen>
    </EdgeSwipeBack>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
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
