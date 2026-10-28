import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// 스레드 패널 캡처 표면 (#4690). **배송되는 `ThreadPanel` 그대로** — 머리·목록·입력창 전부 실제 컴포넌트이고, 서버·레일만
// 없다(타임라인 값은 고정 데이터). 모든 이름은 가상 인물이다(이도현·박서연, 회사 「달무리 스튜디오」).
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure THREAD-<WHICH>
//   (라이트: LIGHT-THREAD-<WHICH>)
//
//   empty    답글 0개 — 루트 하나와 입력창(자리 표시 「답글 쓰기」)뿐이다. 입력창 위에 안내 문장이 서지 않는다
//   replies  답글 2개 — 같은 패널에 답글이 달린 모습(답글이 있을 때는 예전에도 안내 문장이 없었다)
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000046d0';
const CHANNEL = '00000000-0000-7000-8000-0000000046d1';
const SELF = '00000000-0000-7000-8000-0000000046d2';
const PEER = '00000000-0000-7000-8000-0000000046d3';
const ROOT_ID = '00000000-0000-7000-8000-0000000046e0';

const NOW = Date.now();

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: PEER, displayName: '박서연', handle: 'seoyeon'}),
]);

function message(seq: number, author: string, body: string, over: Partial<Message> = {}): Message {
  return {
    id: `00000000-0000-7000-8000-0000000046f${seq}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - (10 - seq) * 60_000,
    ...over,
  } as Message;
}

const ROOT = message(1, PEER, '다음 주 릴리스 일정을 공유드려요. 금요일 오후에 배포합니다.', {id: ROOT_ID});
const REPLIES = [
  message(2, SELF, '금요일 좋아요. 그 전에 점검 한 번 돌려 볼게요.', {rootId: ROOT_ID}),
  message(3, PEER, '네, 월요일까지 점검 결과만 남겨 주세요.', {rootId: ROOT_ID}),
];

/** `ThreadPanel` 이 쓰는 만큼의 `useTimeline` — 고정 데이터라 아무것도 보내지 않는다. */
function timelineOf(messages: Message[]): UseTimelineResult {
  return {
    state: {messages, oldestSeq: ROOT.seq, newestSeq: messages[messages.length - 1].seq},
    status: 'ready',
    loadedChannelId: CHANNEL,
    resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
    recoveryMarkers: [],
    pending: [],
    send: async () => {},
    resend: async () => {},
    toggleReaction: async () => {},
    editBody: async () => {},
    removeMessage: async () => {},
    loadReplies: async () => {},
    sendReply: async () => {},
    repliesPending: () => [],
    loadOlder: async () => {},
    reload: () => {},
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
    pins: {},
  } as unknown as UseTimelineResult;
}

export function ThreadPanelSurface({which}: {which: string}): React.JSX.Element {
  const timeline = timelineOf(which === 'replies' ? [ROOT, ...REPLIES] : [ROOT]);
  return (
    <View style={styles.fill}>
      <ThreadPanel
        root={ROOT}
        workspaceId={WS}
        channelId={CHANNEL}
        timeline={timeline}
        directory={DIRECTORY}
        myMemberId={SELF}
        nowMs={NOW}
        onClose={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({fill: {flex: 1}});
