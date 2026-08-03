import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// The states that are hard to photograph.
//
// A conversation on a live server shows the ready state and nothing else, so
// 빈/오류/로딩 would go uncaptured — and those are exactly the ones a person
// meets on a bad day. Each panel below is the REAL `Timeline` handed the props
// that produce that state, so what is captured is the surface and not a mockup
// of it.
//
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure STATES
// =============================================================================

const ROSTER = makeStressRoster();
const DIRECTORY = makeDirectory(ROSTER);
const PEER = ROSTER.find(m => m.kind === 'agent') ?? null;
// A real roster id, so the pending rows are attributed to a name instead of
// falling back to 「알 수 없는 멤버」 — which would make the capture look like a
// directory bug rather than a send state.
const SELF_ID = (ROSTER.find(m => m.kind === 'human') ?? ROSTER[0]).id;
const NOW = 1_700_000_000_000;

const PENDING: PendingMessage[] = [
  {
    clientMsgId: 'c1',
    channelId: 'ch',
    authorMemberId: SELF_ID,
    body: '안녕하세요, 방금 보낸 메시지입니다.',
    createdAtMs: NOW,
    sinceSeq: null,
    status: 'sending',
  },
  {
    clientMsgId: 'c2',
    channelId: 'ch',
    authorMemberId: SELF_ID,
    body: '이건 실패한 메시지입니다.',
    createdAtMs: NOW + 1000,
    sinceSeq: null,
    status: 'failed',
  },
];

function Panel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.stage}>{children}</View>
    </View>
  );
}

export default function StatesHarness(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      {/* A plain View, not a ScrollView: nesting the Timeline's FlatList inside
          one raises "VirtualizedLists should never be nested…" — harmless here
          but it lands a red warning across the capture, and a screenshot with a
          warning on it invites the question of whether the app has one. */}
      <View style={[styles.root, styles.body]}>
        <Text style={styles.title}>RN-C4 상태 캡처</Text>

        <Panel label="빈 채널 — 다음에 할 일을 말한다">
          <Timeline
            messages={[]}
            directory={DIRECTORY}
            status="ready"
            channelKind="public"
            myMemberId={SELF_ID}
            nowMs={NOW}
          />
        </Panel>

        <Panel label="빈 DM — 참여자를 더할 수 없으므로 다른 말을 한다">
          <Timeline
            messages={[]}
            directory={DIRECTORY}
            status="ready"
            channelKind="dm"
            peer={PEER}
            myMemberId={SELF_ID}
            nowMs={NOW}
          />
        </Panel>

        <Panel label="오류 — 다시 시도가 있다">
          <Timeline
            messages={[]}
            directory={DIRECTORY}
            status="error"
            myMemberId={SELF_ID}
            nowMs={NOW}
            onRetry={() => {}}
          />
        </Panel>

        <Panel label="불러오는 중">
          <Timeline
            messages={[]}
            directory={DIRECTORY}
            status="loading"
            myMemberId={SELF_ID}
            nowMs={NOW}
          />
        </Panel>

        <Panel label="보내는 중 / 전송 실패 — 그 자리에서 다시 보내기">
          <Timeline
            messages={[]}
            directory={DIRECTORY}
            status="ready"
            pending={PENDING}
            myMemberId={SELF_ID}
            nowMs={NOW}
            onResendPending={() => {}}
          />
        </Panel>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1115'},
  body: {padding: 12, paddingTop: 56, gap: 6},
  title: {color: '#f2f3f5', fontSize: 18, fontWeight: '700'},
  panel: {gap: 4},
  label: {color: '#6b7280', fontSize: 11, fontWeight: '600'},
  stage: {
    height: 116,
    borderWidth: 1,
    borderColor: '#2a2f38',
    borderRadius: 8,
    overflow: 'hidden',
  },
});
