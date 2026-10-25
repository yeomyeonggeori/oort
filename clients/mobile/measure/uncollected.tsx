import type {AgentLiveness, Channel, Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import type {AgentLivenessLookup} from '@momo/core/features/agents/turnCopy';
import type {QueryClient} from '@tanstack/react-query';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {StopTurnControl} from '../src/features/agents/StopTurnControl';
import {markAgentWorking, resetAgentWorking} from '../src/features/agents/workingSignal';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import SidebarScreen from '../src/screens/SidebarScreen';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 「아무도 가져가지 않은 요청」 캡처 표면 (#4285). 홈 「작업 중」 카드와 대화 아래 활동 줄을 배송되는
// 컴포넌트 그대로 세운다(`SidebarScreen`·`AgentActivityBar`·`StopTurnControl`). 서버·레일만 없다:
// 질의 캐시에 씨앗을 뿌리고, `fetch`는 취소 POST만 답한다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure UNCOLLECTED-<WHICH>
//   (라이트: LIGHT-UNCOLLECTED-<WHICH>)
//
//   home            5~17시간 가져가지 않은 요청 — 낱말 · 경고 문구 · 이유 · 「취소」. 확인·영수증은 Maestro 의 실제 탭
//   home-fail       같은 카드, 취소 POST 가 500 으로 답한다 — 「취소하지 못했어요」
//   home-young      2분 된 요청 — 「대기 1번째」 그대로, 이유·취소 없음
//   home-offline    같은 카드, 실시간 연결이 끊겼다 — 취소를 권하지 않는다
//   home-system     부른 사람 없는 환영 작업뿐 — 카드가 없다
//   home-claimed    가져간 run — 「받지 않았어요」도 취소도 아니다
//   dm              대화 아래 활동 줄(경고 문구 · 경과 · 이유) + 「취소」
//
// 이름은 가상 인물이다(이도현 · 박서연 · 달무리봇, 달무리 스튜디오). 시계는 찍는 순간에서 거꾸로 잡는다.
// =============================================================================

const WS = 'measure-ws';
const HOUR = 3_600_000;
const MIN = 60_000;

const VIEWER_ID = '00000000-0000-7000-8000-0000000e4001';
const BOT_ID = '00000000-0000-7000-8000-0000000e4002';
const SEOYEON_ID = '00000000-0000-7000-8000-0000000e4003';
const RUN = '0199aa11-2222-7000-8000-0000000e4a01';
const WELCOME_RUN = '0199aa11-2222-7000-8000-0000000e4a02';

const VIEWER = {
  id: VIEWER_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
} as Member;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 2,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const ROSTER: RosterMember[] = [
  member({id: VIEWER_ID, displayName: '이도현', handle: 'dohyun', role: 'owner'}),
  member({id: SEOYEON_ID, displayName: '박서연', handle: 'seoyeon'}),
  member({id: BOT_ID, kind: 'agent', displayName: '달무리봇', handle: 'dalmuri-bot', ownerHumanId: VIEWER_ID}),
];
const DIRECTORY = makeDirectory(ROSTER);

const CHANNELS: Channel[] = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: 'ch-studio', workspaceId: WS, kind: 'public', name: '스튜디오', muted: false},
  {id: 'dm-bot', workspaceId: WS, kind: 'dm', muted: false, memberIds: [VIEWER_ID, BOT_ID]},
  {id: 'dm-seoyeon', workspaceId: WS, kind: 'dm', muted: false, memberIds: [VIEWER_ID, SEOYEON_ID]},
] as Channel[];

function readState(channelId: string) {
  return {
    channelId,
    lastReadSeq: 5,
    latestSeq: 5,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    latestReadableSeq: 5,
    closedAtSeq: null,
  };
}

/** 서버가 「아무도 가져가지 않았다」고 답한 run. 시계는 찍는 순간에서 거꾸로 잡는다. */
function queuedTurn(waitedMs: number, over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  const now = Date.now();
  return {
    memberId: BOT_ID,
    channelId: 'ch-general',
    state: 'queued',
    source: 'run',
    runId: RUN,
    headlines: [],
    lastActivityAtMs: now,
    server: {
      phase: 'queued',
      leaseState: 'none',
      queuePosition: 1,
      aheadTotal: 0,
      queuedAtMs: now - waitedMs,
    },
    ...over,
  };
}

function liveness(state: AgentLiveness['state']): AgentLiveness {
  return {agentMemberId: BOT_ID, state, lastSignalAtMs: Date.now() - 3 * HOUR};
}

/** 취소 POST 의 답. 그 밖의 요청은 끝나지 않는 약속이다(하네스는 데이터를 받지 않는다). */
function installFetch(cancelStatus: number): void {
  void globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    if (/\/agent-runs\/[^/]+\/cancel$/.test(String(url))) {
      return Promise.resolve(
        cancelStatus === 200
          ? new Response(
              JSON.stringify({
                runId: RUN,
                status: 'cancelled',
                linkedWorkSessionIds: [],
                workSessionsTerminated: false,
              }),
              {status: 200, headers: {'content-type': 'application/json'}},
            )
          : new Response(JSON.stringify({error: {message: 'boom'}}), {
              status: cancelStatus,
              headers: {'content-type': 'application/json'},
            }),
      );
    }
    return new Promise<Response>(() => {});
  }) as typeof fetch;
}

const styles = StyleSheet.create({
  fill: {flex: 1},
  dmFloor: {flex: 1, justifyContent: 'flex-end', paddingBottom: 24},
});

const CONNECTED = {rail: null, status: 'connected' as const, subscriptionsWanted: true};
const DISCONNECTED = {rail: null, status: 'disconnected' as const, subscriptionsWanted: true};

/** 이름이 이 표면의 것인가(`surfaces.tsx` 가 갈라 보낸다). */
export function isUncollectedSurface(name: string): boolean {
  return name === 'uncollected' || name.startsWith('uncollected-');
}

function which(name: string): string {
  return name.slice('uncollected'.length).replace(/^-/, '') || 'home';
}

/**
 * 질의 캐시와 진행 스토어에 씨앗을 뿌린다. **렌더 중에 부르지 않는다**(`markAgentWorking` 은 구독자를
 * 동기적으로 깨운다) — 모듈 몸통이 옳은 자리다.
 */
export function seedUncollected(client: QueryClient, name: string): void {
  const kind = which(name);
  installFetch(kind === 'home-fail' ? 500 : 200);
  resetAgentWorking();
  // 씨앗이 마운트 전에 버려지지 않게: 이 키들은 구독자가 없는 채로 처음 그려질 때까지 산다.
  for (const key of ['roster', 'channels', 'read-state', 'settings', 'agent-liveness']) {
    client.setQueryDefaults([key, ...(key === 'settings' ? ['workspace'] : []), WS], {
      gcTime: Infinity,
    });
  }
  client.setQueryData(['settings', 'workspace', WS], {
    id: WS,
    slug: 'dalmuri',
    name: '달무리 스튜디오',
    updatedAtMs: 0,
  });
  client.setQueryData(['roster', WS], ROSTER);
  client.setQueryData(['channels', WS], CHANNELS);
  client.setQueryData(['read-state', WS], CHANNELS.map(channel => readState(channel.id)));
  client.setQueryData(['agent-liveness', WS, BOT_ID.toLowerCase()], liveness('woken_not_collected'));
  if (kind === 'home-young') {
    markAgentWorking(queuedTurn(2 * MIN));
  } else if (kind === 'home-system') {
    // 서버가 5시간 기다렸다고 말해도 부른 사람이 없는 일이다 — 와이어에서 읽은 표지가 카드를 거른다.
    markAgentWorking(queuedTurn(5 * HOUR, {runId: WELCOME_RUN, server: {phase: 'queued', leaseState: 'none', queuePosition: 1, aheadTotal: 0, queuedAtMs: Date.now() - 5 * HOUR, system: true}}));
  } else if (kind === 'home-claimed') {
    const now = Date.now();
    markAgentWorking({
      ...queuedTurn(0),
      state: 'working',
      startedAtMs: now - 3 * MIN,
      server: {phase: 'claimed', leaseState: 'live', queuedAtMs: now - 4 * MIN, claimedAtMs: now - 3 * MIN},
    });
  } else if (kind === 'dm') {
    // 대화 표면은 신호를 스토어가 아니라 props 로 받는다.
  } else {
    markAgentWorking(queuedTurn(17 * HOUR));
  }
}

function UncollectedHome({kind}: {kind: string}): React.JSX.Element {
  return (
    <RealtimeContext.Provider value={kind === 'home-offline' ? DISCONNECTED : CONNECTED}>
      <SessionProvider member={VIEWER}>
        <View style={styles.fill}>
          <SidebarScreen
            openChannelId={null}
            onOpenConversation={() => {}}
            onOpenSearch={() => {}}
          />
        </View>
      </SessionProvider>
    </RealtimeContext.Provider>
  );
}

function mine(body: string, minutesAgo: number): Message {
  return {
    id: '00000000-0000-7000-8000-0000000e4b01',
    channelId: 'dm-bot',
    seq: 6,
    hlcTs: 6,
    hlcCount: 0,
    authorMemberId: VIEWER_ID,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: Date.now() - minutesAgo * MIN,
  } as Message;
}

function UncollectedDm(): React.JSX.Element {
  const now = Date.now();
  const lookup: AgentLivenessLookup = id =>
    id.toLowerCase() === BOT_ID.toLowerCase() ? liveness('woken_not_collected') : undefined;
  return (
    <RealtimeContext.Provider value={CONNECTED}>
      <SessionProvider member={VIEWER}>
        <Screen>
          <View style={styles.dmFloor}>
            <MessageRow
              message={mine('이번 주 일정 정리해 줄래요', 17 * 60 + 5)}
              startsGroup
              directory={DIRECTORY}
              chips={[]}
              nowMs={now}
            />
            <AgentActivityBar
              // 17시간 + 30초: `now` 를 먼저 잡고 신호를 나중에 만들면 경과가 17시간에 1ms 모자라 「16시간째」로 찍힌다.
              turns={[queuedTurn(17 * HOUR + 30_000, {channelId: 'dm-bot'})]}
              directory={DIRECTORY}
              nowMs={now}
              live
              livenessFor={lookup}
              renderStop={turn => (
                <StopTurnControl
                  runId={turn.runId}
                  agentName={turn.name}
                  runCount={turn.runCount}
                  wording={turn.wording}
                  onOutcome={() => {}}
                />
              )}
            />
          </View>
        </Screen>
      </SessionProvider>
    </RealtimeContext.Provider>
  );
}

export function UncollectedSurface({name}: {name: string}): React.JSX.Element {
  const kind = which(name);
  return kind === 'dm' ? <UncollectedDm /> : <UncollectedHome kind={kind} />;
}
