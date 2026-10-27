import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import type {AgentLivenessLookup} from '@momo/core/features/agents/turnCopy';
import type {AgentLivenessState} from '@momo/core/lib/api';
import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Settings, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent} from 'react-native';
import {BAR_CONTROL_MAX_SCALE, Screen} from '../src/design/atoms';
import {font, space, TOUCH_TARGET} from '../src/design/tokens';
import {usePalette} from '../src/design/theme';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';

// =============================================================================
// 활동 줄(`AgentActivityBar`)의 **줄 높이 표** (#4613) — 「N초째」가 바뀔 때 줄 수가 뒤집히는 초가 있는가를 시간 흐름 없이 잰다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure ACTIVITY-ROWS \
//        -RCT_jsLocation 127.0.0.1:<metro> -momoGapSink 127.0.0.1:<port>
//
// 같은 한 줄(진짜 `AgentActivityBar` + 대화 화면과 같은 크기의 「중단」 자리)을 **글자만 바꿔** 보이지 않게 여러 개 세우고 `onLayout` 높이를 읽는다:
//   - 시계(`nowMs`)를 run 이 들어온 때 + N초(N=0…59)·+M분(M=1…9)으로 바꿔 가며 — 매초 바뀌는 글자 하나하나가 몇 줄이 되는가.
//   - 폭 W: 이 기기의 화면 폭 하나(실행한 시뮬레이터가 정한다). 다른 폭은 다른 기기(SE)·다른 글자 크기(simctl ui content_size)로 같은 표면을 다시 돌린다.
//   - 문구 변형: 서버 생존 판정(D4) 라벨 유무 × 「에이전트 앞에 m건」 유무 × 에이전트 이름(짧은 · 긴).
// 한 변형의 높이가 N 에 따라 둘 이상이면 그 변형은 **초가 바뀔 때마다 화면이 움직일 수 있다**(도크가 입력창 위에 서 있으므로 목록이 그만큼 밀린다).
// 레이아웃은 JS 가 모른다(`onLayout` 만 안다) — 그래서 가짜 글자가 아니라 진짜 컴포넌트의 진짜 높이를 읽는다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000e0';
const CHANNEL = '00000000-0000-7000-8000-0000000000e3';
const SELF = '00000000-0000-7000-8000-0000000000e1';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

/** 에이전트 이름 변형: 짧은 이름(owner 의 실기 장면 길이)과 긴 이름. 가상 이름이다. */
const NAMES: readonly {key: string; id: string; displayName: string; handle: string}[] = [
  {key: 'short', id: '00000000-0000-7000-8000-0000000000a1', displayName: 'grok', handle: 'grok'},
  {key: 'mid', id: '00000000-0000-7000-8000-0000000000a2', displayName: 'hermes', handle: 'hermes'},
  {key: 'long', id: '00000000-0000-7000-8000-0000000000a3', displayName: '달무리 리서치 도우미', handle: 'research-helper'},
];

/** `ACTIVITY-ROWS-WIDE`: 실기에서 나올 법한 이름을 더 — 줄바꿈 경계는 첫 토막(이름 + 단계 낱말)의 폭에 따라 옮겨 가므로 이름 길이를 넓게 훑는다(가상 이름). */
const WIDE_NAMES: readonly {key: string; id: string; displayName: string; handle: string}[] = [
  NAMES[0],
  NAMES[1],
  {key: 'kim', id: '00000000-0000-7000-8000-0000000000b1', displayName: '김인턴', handle: 'kim-intern'},
  {key: 'ort', id: '00000000-0000-7000-8000-0000000000b2', displayName: '오르트', handle: 'ort'},
  NAMES[2],
];

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  ...[...NAMES, ...WIDE_NAMES].map(name => member({id: name.id, kind: 'agent', displayName: name.displayName, handle: name.handle})),
]);

const T0 = 1_760_000_000_000;
const RUN = 'A2222222-2222-4222-8222-A22222222222';

function turn(memberId: string, aheadTotal: number): AgentWorkingSignal {
  return {
    memberId,
    channelId: CHANNEL,
    state: 'queued',
    source: 'run',
    runId: RUN,
    headlines: [],
    lastActivityAtMs: T0,
    server: {phase: 'queued', leaseState: 'none', queuePosition: 1, aheadTotal, queuedAtMs: T0},
  };
}

/** 글자 변형 하나: 서버 생존 판정(D4) 상태(없으면 null) × 앞에 m건. 기본 표는 라벨 유무(`woken_not_collected`) × 0·2건. */
interface Variant {
  key: string;
  liveness: AgentLivenessState | null;
  ahead: number;
}
const VARIANTS: readonly Variant[] = [
  {key: 'plain', liveness: null, ahead: 0},
  {key: 'label', liveness: 'woken_not_collected', ahead: 0},
  {key: 'ahead2', liveness: null, ahead: 2},
  {key: 'label+ahead2', liveness: 'woken_not_collected', ahead: 2},
];
/** `ACTIVITY-ROWS-WIDE`: 근거 글 맨 앞에 서는 생존 문구 전부(경고 톤 넷 + 연결 꺼짐) × 앞에 0~3건. */
const WIDE_LIVENESS: readonly (AgentLivenessState | null)[] = [null, 'work_waiting', 'woken_not_collected', 'unresponsive', 'error', 'inactive'];
const WIDE_VARIANTS: readonly Variant[] = WIDE_LIVENESS.flatMap(liveness =>
  [0, 1, 2, 3].map(ahead => ({key: `${liveness ?? 'none'}+ahead${ahead}`, liveness, ahead})),
);

/** 시계 표본: 0…59초, 1…9분(분 단위는 60초 단위로 다음 글자), 5분을 넘으면 「아직 받지 않았어요」로 낱말이 바뀐다. */
const CLOCKS: readonly {key: string; ageMs: number}[] = [
  ...Array.from({length: 60}, (_, second) => ({key: `${second}s`, ageMs: second * 1000})),
  ...Array.from({length: 9}, (_, minute) => ({key: `${minute + 1}m`, ageMs: (minute + 1) * 60_000})),
];

/** 상태별 조회 함수는 모듈 상수로 만든다(렌더마다 새 함수면 활동 줄이 문구를 다시 만든다). */
const LIVENESS_LOOKUPS = new Map<AgentLivenessState, AgentLivenessLookup>(
  (['work_waiting', 'woken_not_collected', 'unresponsive', 'error', 'inactive'] as const).map(state => [
    state,
    memberId => ({agentMemberId: memberId, state, lastSignalAtMs: T0 - 3 * 3_600_000}),
  ]),
);

interface Cell {
  name: string;
  variant: string;
  clock: string;
  height: number | null;
}

export function ActivityRowsSurface({wide = false}: {wide?: boolean}): React.JSX.Element {
  const palette = usePalette();
  const {width, fontScale} = useWindowDimensions();
  const [heights, setHeights] = useState<Record<string, number>>({});
  const seen = useRef<Record<string, number>>({});
  const posted = useRef(false);
  const sink = Settings.get('momoGapSink');
  const renderStop = useCallback(
    () => (
      <View style={stopStyle.quiet}>
        {/* 진짜 `StopTurnControl`(미장착)과 같다: 아직 아무도 안 가져간 run 의 낱말 「취소」 · 라벨 글자 배율 상한 `BAR_CONTROL_MAX_SCALE`. */}
        <Text style={[stopStyle.label, {color: palette.accentText}]} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          취소
        </Text>
      </View>
    ),
    [palette],
  );
  const cells = useMemo(
    () =>
      (wide ? WIDE_NAMES : NAMES).flatMap(name =>
        (wide ? WIDE_VARIANTS : VARIANTS).flatMap(variant =>
          CLOCKS.map(clock => ({name: name.key, memberId: name.id, variant, clock})),
        ),
      ),
    [wide],
  );
  const total = cells.length;
  const onLayout = useCallback((key: string, event: LayoutChangeEvent) => {
    seen.current[key] = Math.round(event.nativeEvent.layout.height * 10) / 10;
    if (Object.keys(seen.current).length === total) setHeights({...seen.current});
  }, [total]);
  useEffect(() => {
    if (posted.current || Object.keys(heights).length !== total) return;
    posted.current = true;
    const table: Cell[] = cells.map(cell => ({
      name: cell.name,
      variant: cell.variant.key,
      clock: cell.clock.key,
      height: heights[`${cell.name}|${cell.variant.key}|${cell.clock.key}`] ?? null,
    }));
    const record = {scenario: 'rows', width, fontScale, table, beginMs: Date.now(), events: [], trace: []};
    console.log(`ACTIVITYROWS ${JSON.stringify({width, fontScale, cells: table.length})}`);
    if (typeof sink === 'string' && sink !== '') {
      fetch(`http://${sink}/steady`, {method: 'POST', body: JSON.stringify(record)}).catch(() => {});
    }
  }, [cells, heights, sink, total, width, fontScale]);

  return (
    <Screen style={stopStyle.root}>
      <Text style={stopStyle.note}>
        활동 줄 높이 표 — 폭 {width}pt · 글자 배율 {fontScale} · {Object.keys(heights).length}/{total}
      </Text>
      {/* 보이지 않게 세운다(`opacity` 0 은 `onLayout` 을 막지 않는다). 폭은 화면 폭 그대로 — 대화 화면의 도크와 같다. */}
      <View style={stopStyle.hidden} pointerEvents="none">
        {cells.map(cell => {
          const key = `${cell.name}|${cell.variant.key}|${cell.clock.key}`;
          return (
            <View key={key} onLayout={event => onLayout(key, event)} collapsable={false}>
              <AgentActivityBar
                turns={[turn(cell.memberId, cell.variant.ahead)]}
                directory={DIRECTORY}
                nowMs={T0 + cell.clock.ageMs}
                live
                renderStop={renderStop}
                livenessFor={cell.variant.liveness === null ? undefined : LIVENESS_LOOKUPS.get(cell.variant.liveness)}
              />
            </View>
          );
        })}
      </View>
    </Screen>
  );
}

const stopStyle = StyleSheet.create({
  root: {paddingTop: 80},
  quiet: {minHeight: TOUCH_TARGET, justifyContent: 'center', paddingHorizontal: space.sm},
  label: {fontSize: font.meta, fontWeight: '600'},
  note: {fontSize: 12, color: '#fff', padding: 8},
  hidden: {position: 'absolute', top: 0, left: 0, right: 0, opacity: 0},
});
