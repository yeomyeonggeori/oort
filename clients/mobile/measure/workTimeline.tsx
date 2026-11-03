import type {AgentRunProgress, Member, RosterMember} from '@momo/core/lib/api';
import {agentRunLedgerFromWire} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {useQueryClient, type QueryClient} from '@tanstack/react-query';
import React, {useEffect, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {RequestThinkingLine} from '../src/features/agents/RequestThinkingLine';
import {RunLedgerSheet} from '../src/features/agents/RunLedgerSheet';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 작업 타임라인 시트 캡처 표면 (#4658). 배송되는 `RunLedgerSheet`·`RequestThinkingLine` 을 그대로 세운다 — 서버·레일만 없다: 질의
// 캐시에 원장을 씨앗으로 뿌리고, 실시간 연결은 표면이 정한다(`offline` 만 끊긴다).
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure WORK-TIMELINE-<WHICH>
//   (라이트: LIGHT-WORK-TIMELINE-<WHICH>)
//
//   running   지금 일하는 run — 계획 4단계(완료 2·지금 1·대기 1), 읽기·검색 묶음, 끝난 편집, 실패한 명령, 진행 중인 명령(점 하나)
//   quiet     같은 run인데 마지막 보고가 8분 전·단계가 12분째 — 건강 줄(조용해요 · 같은 단계에 12분째 · 실패한 활동 1)
//   ended     끝난 run — 끝 보고 없음, 계획은 마지막으로 알린 것, 합계와 「일부는 합계로만 남았어요」
//   offline   running 인데 실시간 연결이 끊겼다 — 한정 문장, 점·에이전트색 없음, 건강 줄은 개수만
//   old       구 서버(합계·활동 필드가 없다) — 「서버 업데이트 뒤에 보여요」 두 칸
//   chip      끝난 요청의 요약 칩 한 줄(「13분 · 단계 6 · 명령 12 · 읽기 9 · 에이전트 보고」). 2.5초 뒤 작업 기록 시트가 열린다(녹화용)
//   long      80자 한글 라벨과 한영 섞인 라벨 — 칩·시각이 한 줄에 서고 글만 어절 단위로 꺾이는지
//   fold-before  읽기 줄이 아직 개별 줄이다(진행 중인 읽기가 앞뒤 묶음을 끊고 있다)
//   fold-after   그 읽기가 끝나 앞의 읽기와 한 줄 「읽기 3」으로 가라앉았다(뒤의 줄이 한 칸 당겨진다)
//   live-slow    live 와 같은 원장인데 단계 간격이 30초다(계측용: 단계 사이에 줄의 위치를 Maestro `hierarchy` 로 두 번 뜬다)
//   live         열려 있는 동안 원장이 바뀐다(녹화용): 4초 새 줄이 도착 · 8초 진행 중이던 읽기가 끝나 묶음으로 가라앉음 ·
//                12초 편집이 실패로 바뀌고(칩 색 전환) 새 명령 줄이 도착(점이 옮겨 감) · 16초 명령이 끝남(점이 사라짐)
//
// 이름은 가상 인물이다(이도현 · 달무리봇, 달무리 스튜디오). 시계는 찍는 순간에서 거꾸로 잡는다.
// =============================================================================

const WS = 'measure-ws';
const SEC = 1000;
const MIN = 60 * SEC;

const VIEWER_ID = '00000000-0000-7000-8000-0000000f4001';
const BOT_ID = '00000000-0000-7000-8000-0000000f4002';
const CH = '00000000-0000-7000-8000-0000000f4003';
const RUN = '0199aa11-2222-7000-8000-0000000f4a01';
const TRIGGER = '00000000-0000-7000-8000-0000000f4b01';

const VIEWER = {
  id: VIEWER_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
} as Member;

const DIRECTORY = makeDirectory([
  {
    id: BOT_ID,
    workspaceId: WS,
    kind: 'agent',
    status: 'active',
    displayName: '달무리봇',
    handle: 'dalmuri-bot',
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as unknown as RosterMember,
]);

/** 조용한 run의 마지막 보고: 8분 전(서버의 진행 읽기 값과 원장의 가장 새 행이 모두 이만큼 오래다). */
const QUIET_MS = 8 * MIN;

const CONNECTED = {rail: null, status: 'connected' as const, subscriptionsWanted: true};
const DISCONNECTED = {rail: null, status: 'disconnected' as const, subscriptionsWanted: true};

/** 이름이 이 표면의 것인가(`surfaces.tsx` 가 갈라 보낸다). */
export function isWorkTimelineSurface(name: string): boolean {
  return name === 'work-timeline' || name.startsWith('work-timeline-');
}

function which(name: string): string {
  return name.slice('work-timeline'.length).replace(/^-/, '') || 'running';
}

// ---- 재료 ---------------------------------------------------------------------------

/** 에이전트가 스스로 알린 활동 한 줄. 첫 보고 시각이 줄의 자리다. */
function activity(
  ordinal: number,
  id: string,
  agoMs: number,
  over: {kind: string; label?: string; status?: string; n?: number},
) {
  const at = Date.now() - agoMs;
  return {
    ordinal,
    kind: 'activity',
    createdAtMs: at,
    activity: {id, status: 'completed', n: 1, startedAtMs: at, ...over},
  };
}

function plan(statuses: string[], agoMs = 3 * MIN) {
  const texts = ['리포트 초안 읽기', '표 정리하기', '리포트 고치기', '요약 쓰기'];
  return {
    ordinal: 40,
    kind: 'plan',
    createdAtMs: Date.now() - agoMs,
    plan: statuses.map((status, index) => ({text: texts[index] ?? `단계 ${index + 1}`, status})),
  };
}

function lifecycle(startAgoMs: number, stageAgoMs: number, stage: string) {
  const t = Date.now();
  return [
    {ordinal: 1, kind: 'queued', createdAtMs: t - startAgoMs - 20 * SEC},
    {ordinal: 2, kind: 'claimed', createdAtMs: t - startAgoMs - 8 * SEC},
    {ordinal: 3, kind: 'started', createdAtMs: t - startAgoMs},
    {ordinal: 4, kind: 'stage', stage, createdAtMs: t - stageAgoMs},
  ];
}

/** oort가 잰 도구 호출: 진행 알리기 셋(접혀 「3번」)과 실패한 메시지 보내기 하나. */
function oortCalls(shiftMs = 0) {
  const t = Date.now();
  const call = (ordinal: number, agoMs: number, tool: string, code: string) => ({
    ordinal,
    kind: 'tool_call',
    tool,
    code,
    durationMs: 120,
    createdAtMs: t - agoMs - shiftMs,
  });
  return [
    call(50, 9 * MIN, 'oort_run_event', 'ok'),
    call(51, 6 * MIN, 'oort_run_event', 'ok'),
    call(52, 4 * MIN, 'oort_run_event', 'ok'),
    call(53, 90 * SEC, 'oort_message_post', 'unavailable'),
  ];
}

const TALLY = [
  {kind: 'run', completed: 1, failed: 1},
  {kind: 'edit', completed: 1, failed: 0},
  {kind: 'read', completed: 9, failed: 0},
  {kind: 'search', completed: 3, failed: 0},
];
/** 끝난 요청 칩의 합계: 「명령 12 · 읽기 9」가 많은 쪽 둘이다(웹 인계의 예와 같다). */
const CHIP_TALLY = [
  {kind: 'run', completed: 11, failed: 1},
  {kind: 'read', completed: 9, failed: 0},
  {kind: 'search', completed: 3, failed: 0},
];
const TOOL_TALLY = [
  {tool: 'oort_run_event', ok: 3, error: 0},
  {tool: 'oort_message_post', ok: 0, error: 1},
];

/** `shiftMs`: 모든 보고를 이만큼 더 과거로 민다(조용한 run: 마지막 보고가 8분 전이면 원장의 어떤 행도 그보다 새롭지 않다). */
function runningActivities(shiftMs = 0) {
  return [
    activity(10, 'a1', 10 * MIN + shiftMs, {kind: 'read', n: 9}),
    activity(11, 'a2', 9 * MIN + shiftMs, {kind: 'search', n: 3}),
    activity(12, 'a3', 8 * MIN + shiftMs, {kind: 'edit', label: '리포트 고치기'}),
    activity(13, 'a4', 5 * MIN + shiftMs, {kind: 'run', label: '테스트 돌리기', status: 'failed'}),
    activity(14, 'a5', 60 * SEC + shiftMs, {kind: 'run', label: '다시 돌리기', status: 'in_progress'}),
  ];
}

// ---- 라이브 씨앗: 열려 있는 동안 원장이 바뀐다 -------------------------------------------
//
// 시각은 모듈이 뜬 순간(`LIVE_T0`)에서 **한 번** 잡는다: 같은 활동은 단계가 바뀌어도 같은 첫 보고 시각(줄의 자리)을 갖고, 새 활동은
// 그것이 도착하는 때의 시각을 갖는다. 단계마다 `Date.now()`를 다시 읽으면 줄 순서가 흔들려 「제자리 줄」이 거짓이 된다.

const LIVE_T0 = Date.now();
/** 단계 사이의 간격(녹화용 4초 · 계측용 30초). 단계 수는 `LIVE_LAST_STEP`(0 = 처음 열 때). */
const LIVE_STEP_MS = 4 * SEC;
const LIVE_SLOW_STEP_MS = 30 * SEC;
const LIVE_LAST_STEP = 4;

function liveActivity(
  ordinal: number,
  id: string,
  startedOffsetMs: number,
  over: {kind: string; label?: string; status?: string; n?: number},
) {
  const at = LIVE_T0 + startedOffsetMs;
  return {
    ordinal,
    kind: 'activity',
    createdAtMs: at,
    activity: {id, status: 'completed', n: 1, startedAtMs: at, ...over},
  };
}

function liveLedger(step: number) {
  const reads = [
    liveActivity(10, 'r1', -9 * MIN, {kind: 'read', n: 2}),
    liveActivity(11, 'x1', -8 * MIN, {
      kind: 'read',
      label: '문서 읽는 중',
      ...(step < 2 ? {status: 'in_progress'} : {}),
    }),
  ];
  const edit =
    step >= 1
      ? [
          liveActivity(12, 'e1', 4 * SEC, {
            kind: 'edit',
            label: '리포트 고치기',
            ...(step < 3 ? {status: 'in_progress'} : {status: 'failed'}),
          }),
        ]
      : [];
  const run =
    step >= 3
      ? [
          liveActivity(13, 'c1', 12 * SEC, {
            kind: 'run',
            label: '테스트 돌리기',
            ...(step < 4 ? {status: 'in_progress'} : {}),
          }),
        ]
      : [];
  const statuses = [
    ['completed', 'in_progress', 'pending', 'pending'],
    ['completed', 'in_progress', 'pending', 'pending'],
    ['completed', 'completed', 'in_progress', 'pending'],
    ['completed', 'completed', 'in_progress', 'pending'],
    ['completed', 'completed', 'completed', 'in_progress'],
  ][Math.min(step, LIVE_LAST_STEP)] as string[];
  return agentRunLedgerFromWire({
    runId: RUN,
    events: [
      ...lifecycle(12 * MIN, 2 * MIN, '리포트 초안 읽는 중'),
      ...reads,
      ...edit,
      ...run,
      plan(statuses),
    ],
    activityTally: TALLY,
    activityRowsTrimmed: false,
    toolTally: TOOL_TALLY,
  });
}

/** 긴 글(코어가 80자에서 자른다): 한글만 · 한영 섞임 · 짧은 라벨. 진행 중과 실패 칩과 걸린 시간이 한 줄에 서는지 본다. */
function longLedger() {
  return agentRunLedgerFromWire({
    runId: RUN,
    events: [
      ...lifecycle(12 * MIN, 2 * MIN, '리포트 초안 읽는 중'),
      activity(10, 'l1', 9 * MIN, {
        kind: 'edit',
        label:
          '분기 매출 리포트의 둘째 장과 셋째 장 표를 새 기준으로 다시 맞추고 각주의 출처 표기까지 한꺼번에 고치는 중이에요',
      }),
      activity(11, 'l2', 5 * MIN, {
        kind: 'run',
        label: 'npm run test -- --watch=false review-notes-v2 summary-table.spec.ts 결과를 다시 확인하고 정리하는 중',
        status: 'failed',
      }),
      activity(12, 'l3', 60 * SEC, {
        kind: 'web',
        label: '경쟁사 가격표 페이지를 찾아서 숫자만 옮겨 적고 출처 링크를 같이 남기는 중이에요 (진행 중)',
        status: 'in_progress',
      }),
      activity(13, 'l4', 30 * SEC, {kind: 'other', label: '메모'}),
      plan(['completed', 'in_progress']),
    ],
    activityTally: [
      {kind: 'run', completed: 0, failed: 1},
      {kind: 'edit', completed: 1, failed: 0},
    ],
    activityRowsTrimmed: false,
    toolTally: [],
  });
}

function ledgerFor(kind: string) {
  if (kind === 'long') return longLedger();
  if (kind === 'live' || kind === 'live-slow') return liveLedger(0);
  if (kind === 'fold-before') return liveLedger(1);
  if (kind === 'fold-after') return liveLedger(2);
  if (kind === 'old') {
    // 구 서버: 합계·활동 필드가 없다(「모름」은 0이 아니다).
    return agentRunLedgerFromWire({runId: RUN, events: lifecycle(12 * MIN, 2 * MIN, '리포트 초안 읽는 중')});
  }
  if (kind === 'ended' || kind === 'chip') {
    const events =
      kind === 'chip'
        ? [
            ...lifecycle(20 * MIN, 19 * MIN, '단계 1'),
            ...[2, 3, 4, 5, 6].map((n, index) => ({
              ordinal: 20 + n,
              kind: 'stage',
              stage: `단계 ${n}`,
              createdAtMs: Date.now() - (18 - index * 2) * MIN,
            })),
          ]
        : [
            ...lifecycle(20 * MIN, 8 * MIN, '리포트 고치는 중'),
            activity(10, 'a1', 15 * MIN, {kind: 'read', n: 9}),
            activity(11, 'a2', 14 * MIN, {kind: 'search', n: 3}),
            activity(12, 'a3', 12 * MIN, {kind: 'edit', label: '리포트 고치기', status: 'in_progress'}),
            plan(['completed', 'completed', 'in_progress', 'pending']),
            {ordinal: 60, kind: 'succeeded', createdAtMs: Date.now() - 7 * MIN},
          ];
    return agentRunLedgerFromWire({
      runId: RUN,
      events,
      activityTally: kind === 'chip' ? CHIP_TALLY : TALLY.slice(2),
      activityRowsTrimmed: kind === 'ended',
      toolTally: TOOL_TALLY,
    });
  }
  const quiet = kind === 'quiet';
  const shift = quiet ? QUIET_MS : 0;
  return agentRunLedgerFromWire({
    runId: RUN,
    events: [
      ...lifecycle(quiet ? 20 * MIN : 12 * MIN, quiet ? 12 * MIN : 2 * MIN, '리포트 초안 읽는 중'),
      ...runningActivities(shift),
      plan(['completed', 'completed', 'in_progress', 'pending'], 3 * MIN + shift),
      ...oortCalls(shift),
    ],
    activityTally: TALLY,
    activityRowsTrimmed: false,
    toolTally: TOOL_TALLY,
  });
}

/** 질의 캐시에 씨앗을 뿌린다. **렌더 중에 부르지 않는다** — 모듈 몸통(`surfaces.tsx` 맨 아래)이 옳은 자리다. */
export function seedWorkTimeline(client: QueryClient, name: string): void {
  const key = ['agent-run-events', WS, RUN.toLowerCase()];
  // 씨앗이 마운트 전에 버려지지 않게: 이 키는 구독자가 없는 채로 처음 그려질 때까지 산다.
  client.setQueryDefaults(key, {gcTime: Infinity});
  client.setQueryData(key, ledgerFor(which(name)));
}

function runFor(kind: string): AgentRunProgress {
  const t = Date.now();
  const base = {
    id: RUN,
    channelId: CH,
    agentMemberId: BOT_ID,
    triggerMessageId: TRIGGER,
    triggerSummary: '이번 주 리포트 정리해서 요약까지 써 줄래요?',
    ahead: [],
    stepCount: 4,
  };
  if (kind === 'ended' || kind === 'chip') {
    return {
      ...base,
      status: 'succeeded',
      phase: 'succeeded',
      leaseState: 'none',
      createdAtMs: t - 20 * MIN - 20 * SEC,
      claimedAtMs: t - 20 * MIN - 8 * SEC,
      startedAtMs: t - 20 * MIN,
      finishedAtMs: t - 7 * MIN,
      lastEventAtMs: t - 7 * MIN,
      updatedAtMs: t - 7 * MIN,
    } as unknown as AgentRunProgress;
  }
  const quiet = kind === 'quiet';
  const startedAgo = quiet ? 20 * MIN : 12 * MIN;
  return {
    ...base,
    status: 'running',
    phase: 'running',
    leaseState: 'live',
    latestStage: '리포트 초안 읽는 중',
    createdAtMs: t - startedAgo - 20 * SEC,
    claimedAtMs: t - startedAgo - 8 * SEC,
    startedAtMs: t - startedAgo,
    lastEventAtMs: t - (quiet ? 8 * MIN : 20 * SEC),
    updatedAtMs: t - (quiet ? 8 * MIN : 20 * SEC),
  } as unknown as AgentRunProgress;
}

// ---- 표면 ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  fill: {flex: 1},
  floor: {flex: 1, justifyContent: 'flex-end', paddingBottom: 24, paddingHorizontal: 16},
});

function Sheet({kind}: {kind: string}): React.JSX.Element {
  return <RunLedgerSheet progress={runFor(kind)} directory={DIRECTORY} onClose={() => {}} />;
}

/** 끝난 요청의 요약 칩 한 줄 + (2.5초 뒤) 작업 기록 시트. 시트가 열리는 순간을 녹화하려고 스스로 연다. */
function ChipThenSheet(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setOpen(true), 2500);
    return () => clearTimeout(id);
  }, []);
  return (
    <>
      <Screen>
        <View style={styles.floor}>
          <RequestThinkingLine progress={runFor('chip')} directory={DIRECTORY} nowMs={Date.now()} />
        </View>
      </Screen>
      {open ? <Sheet kind="chip" /> : null}
    </>
  );
}

/**
 * 열려 있는 동안 원장을 `stepMs`마다 한 단계씩 바꾸고, 끝나면 처음으로 돌아가 되풀이한다(녹화용). 시트는 질의 캐시만 읽으므로 서버·레일
 * 없이 같은 길로 다시 그린다. 되풀이하는 까닭: 녹화는 시트를 한 번 스크롤해 「에이전트 보고」 줄이 보이게 한 **뒤에** 켜므로, 단계의 시각이
 * 앱을 띄운 순간에 묶여 있으면 녹화가 그 장면을 놓친다. 한 바퀴는 `(LIVE_LAST_STEP + 1) * stepMs`다.
 */
function LiveSheet({stepMs}: {stepMs: number}): React.JSX.Element {
  const client = useQueryClient();
  useEffect(() => {
    const key = ['agent-run-events', WS, RUN.toLowerCase()];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const lap = () => {
      for (let step = 1; step <= LIVE_LAST_STEP; step += 1) {
        timers.push(setTimeout(() => client.setQueryData(key, liveLedger(step)), step * stepMs));
      }
      timers.push(
        setTimeout(() => {
          client.setQueryData(key, liveLedger(0));
          lap();
        }, (LIVE_LAST_STEP + 1) * stepMs),
      );
    };
    lap();
    return () => timers.forEach(clearTimeout);
  }, [client, stepMs]);
  return <Sheet kind="live" />;
}

export function WorkTimelineSurface({name}: {name: string}): React.JSX.Element {
  const kind = which(name);
  return (
    <RealtimeContext.Provider value={kind === 'offline' ? DISCONNECTED : CONNECTED}>
      <SessionProvider member={VIEWER}>
        <View style={styles.fill}>
          {kind === 'chip' ? (
            <ChipThenSheet />
          ) : kind === 'live' || kind === 'live-slow' ? (
            <LiveSheet stepMs={kind === 'live' ? LIVE_STEP_MS : LIVE_SLOW_STEP_MS} />
          ) : (
            <Sheet kind={kind === 'offline' ? 'running' : kind} />
          )}
        </View>
      </SessionProvider>
    </RealtimeContext.Provider>
  );
}
