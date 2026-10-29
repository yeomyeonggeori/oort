import {QUICK_REACTIONS, type ReactionChip} from '@momo/core/features/timeline/reactions';
import type {Message, RosterMember} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Pressable,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {PageSheet, usePageSheetScroll} from '../src/design/PageSheet';
import {SheetHeader} from '../src/design/SheetChrome';
import {SheetScroll} from '../src/design/sheetParts';
import {useStyles} from '../src/design/theme';
import {ds2Radius, font, SAFE_GUTTER, space, type Palette} from '../src/design/tokens';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {MessageEditorSheet} from '../src/features/conversation/MessageEditorSheet';
import {workspaceKeys} from '../src/features/workspace/queries';
import {useSession} from '../src/session/useSession';
import {NewMessageSheet} from '../src/shell/NewMessageSheet';

// =============================================================================
// 시트 끌어내려 닫기의 시뮬레이터 계측 표면 (#4612 2단계).
//
//   -momoMeasure SHEETDRAG-<이름> · LIGHT-SHEETDRAG-<이름>
//     [-momoGapSink 127.0.0.1:<포트>]   (선택 — `measure/gap-sink.mjs` 가 받는다. 없으면 숫자를 보내지 않고 화면의 읽음표만 선다)
//
//   action        배송되는 `MessageActionSheet`(내용 맞춤 단 · 행동 목록). 닫히면 「닫힘 N」이 늘고 「시트 다시 열기」 단추가 선다.
//   edit          배송되는 `MessageEditorSheet`(중간 단 · 입력 · 저장 안 한 입력 확인). 닫히면(취소) 「닫힘 N」이 늘고 시트가 다시 선다.
//   list          배송되는 `NewMessageSheet`(큰 단 · 날 `FlatList` · 스크롤이 가능한 서른 명). 같은 방식으로 다시 선다.
//   probe-std     결정 2 계측: 시트 안의 **배송되는 `SheetScroll`**(고무줄 없음 + 끌기를 쥐면 스크롤 얼림).
//   probe-freeze  같은 목록을 **날 `ScrollView`**(고무줄 있음)로 두고 얼림만 건다 — 1단계 완화 하나만 있을 때.
//   probe-none    날 `ScrollView`(고무줄 있음)에 얼림도 없다 — 아무 방어도 없을 때(대조군).
//
// 닫힌 시트는 무대의 「시트 다시 열기」 단추(`sheetdrag-reopen`)를 눌러야 다시 선다 — 한 번 띄운 앱에서 「닫힘 1」「닫힘 2」를 세며
// Maestro 가 머리 끌기 · 본문 끌기 · 튕김을 차례로 친다(`maestro/115-sheet-drag-*.yaml`). 시간에 맡겨 다시 세우면 부하가 큰 기계에서
// Maestro 의 계층 조회(수백 ms)가 그 창을 놓친다 — 사람이 아니라 흐름이 누르는 단추라 결정적이다. 다시 세우는 일은 제품 코드가 아니라
// 이 표면의 일이다.
//
// 모든 이름은 가상이다(이도현, 회사 「달무리 스튜디오」, 목록의 서른 명은 「달무리 팀원 NN」).
// =============================================================================

const WORKSPACE_NOTE = '달무리 스튜디오';
const noop = () => {};

// ---- 송신 -----------------------------------------------------------------

/** `-momoGapSink` 로 한 줄 보낸다. 싱크가 없으면 조용히 건너뛴다. */
function postToSink(record: Record<string, unknown>): void {
  const sink = Settings.get('momoGapSink');
  if (typeof sink !== 'string' || sink === '') return;
  fetch(`http://${sink}/drag`, {method: 'POST', body: JSON.stringify(record)}).catch(() => undefined);
}

// ---- 무대 -----------------------------------------------------------------

function Stage({
  log,
  reopen,
  children,
}: {
  log: string;
  /** 시트가 닫혀 있을 때만 준다 — 무대에 「시트 다시 열기」 단추가 선다. */
  reopen?: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.stage}>
      <View style={[styles.stageBody, {paddingTop: insets.top + space.md}]}>
        <Text style={styles.stageTitle}>{WORKSPACE_NOTE}</Text>
        <Text style={styles.stageLog} testID="sheetdrag-log">
          {log}
        </Text>
        {reopen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="시트 다시 열기"
            onPress={reopen}
            style={styles.reopen}
            testID="sheetdrag-reopen">
            <Text style={styles.reopenText}>시트 다시 열기</Text>
          </Pressable>
        ) : null}
        {['디자인', '배포', '일반', '점심'].map(label => (
          <View key={label} style={styles.stageRow}>
            <Text style={styles.stageRowText}># {label}</Text>
          </View>
        ))}
      </View>
      {children}
    </View>
  );
}

/** 닫힌 횟수를 센다. `reopen` 을 부르면 시트가 새 인스턴스(`nonce` 가 `key`)로 다시 선다 — 새 인스턴스 = 새 상태(dirty 도 없다). */
function useReopen(): {open: boolean; nonce: number; closes: number; onClosed: () => void; reopen: () => void} {
  const [closes, setCloses] = useState(0);
  const [open, setOpen] = useState(true);
  const [nonce, setNonce] = useState(0);
  const onClosed = useCallback(() => {
    setOpen(false);
    setCloses(count => count + 1);
  }, []);
  const reopen = useCallback(() => {
    setNonce(value => value + 1);
    setOpen(true);
  }, []);
  return {open, nonce, closes, onClosed, reopen};
}

// ---- 배송되는 시트 --------------------------------------------------------

const ACTION_MESSAGE = {
  id: '00000000-0000-7000-8000-0000000046a1',
  channelId: '00000000-0000-7000-8000-0000000046c1',
  seq: 42,
  hlcTs: 42,
  hlcCount: 0,
  authorMemberId: '00000000-0000-7000-8000-0000000046b1',
  type: 'text',
  body: '금요일 배포는 오전 10시에 시작해요. 롤백 절차는 문서에 적어 뒀어요.',
  state: 'sent',
  createdAtMs: Date.UTC(2026, 9, 25, 1, 30),
} as unknown as Message;
const ACTION_CHIPS = [{emoji: QUICK_REACTIONS[0], count: 2, mine: true}] as unknown as ReactionChip[];
const ACTION_AVAILABILITY = {reply: true, quote: true, react: true, pin: true, edit: true, delete: true} as never;

function ActionSurface(): React.JSX.Element {
  const {open, nonce, closes, onClosed, reopen} = useReopen();
  return (
    <Stage log={`닫힘 ${closes}`} reopen={open ? undefined : reopen}>
      {open ? (
        <MessageActionSheet
          key={nonce}
          message={ACTION_MESSAGE}
          chips={ACTION_CHIPS}
          availability={ACTION_AVAILABILITY}
          authorLabel="이도현"
          onClose={onClosed}
          onToggleReaction={noop}
          onReply={noop}
          onQuote={noop}
          onCopy={noop}
          onPin={noop}
          onEdit={noop}
          onDelete={noop}
        />
      ) : null}
    </Stage>
  );
}

function EditSurface(): React.JSX.Element {
  const {open, nonce, closes, onClosed, reopen} = useReopen();
  return (
    <Stage log={`닫힘 ${closes}`} reopen={open ? undefined : reopen}>
      {open ? (
        <MessageEditorSheet
          key={nonce}
          initialBody="금요일 배포는 오전 10시에 시작해요. 롤백 절차는 문서에 적어 뒀어요."
          onCancel={onClosed}
          onSave={noop}
        />
      ) : null}
    </Stage>
  );
}

function longRoster(workspaceId: string, selfId: string): RosterMember[] {
  const base = {
    workspaceId,
    status: 'active' as const,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  const people: RosterMember[] = [
    {...base, id: selfId, kind: 'human', displayName: '이도현', handle: 'dohyun', role: 'owner'},
  ];
  for (let i = 1; i <= 30; i += 1) {
    const n = String(i).padStart(2, '0');
    people.push({
      ...base,
      id: `00000000-0000-7000-8000-00000000${4612 + 100 + i}`.slice(0, 36),
      kind: 'human',
      displayName: `달무리 팀원 ${n}`,
      handle: `member${n}`,
      role: 'member',
    });
  }
  return people;
}

function ListSurface(): React.JSX.Element {
  const {workspaceId, member} = useSession();
  const {open, nonce, closes, onClosed, reopen} = useReopen();
  const client = useMemo(() => {
    const seeded = new QueryClient({
      defaultOptions: {queries: {staleTime: Infinity, gcTime: Infinity, retry: false}},
    });
    seeded.setQueryData(workspaceKeys.roster(workspaceId), longRoster(workspaceId, member.id));
    return seeded;
  }, [workspaceId, member.id]);
  return (
    <QueryClientProvider client={client}>
      <Stage log={`닫힘 ${closes}`} reopen={open ? undefined : reopen}>
        {open ? <NewMessageSheet key={nonce} onOpenConversation={noop} onClose={onClosed} /> : null}
      </Stage>
    </QueryClientProvider>
  );
}

// ---- 결정 2 계측: 끄는 동안 본문 contentOffset 이 움직이는가 ------------------

type ProbeVariant = 'std' | 'freeze' | 'none';

interface GestureSummary {
  variant: ProbeVariant;
  /** 이 끌기 동안 받은 onScroll 표본 수. */
  n: number;
  minY: number;
  maxY: number;
  /** |y| > 0.5 인 표본 수 — 맨 위(0)에서 시작한 끌기라면 이 값이 0 이어야 본문이 가만히 있었다는 뜻이다. */
  nonZero: number;
  /** 끌기 동안 시트 본문의 창 좌표 y 가 처음 값에서 가장 멀리 간 거리(pt) — 시트가 움직였는가. */
  sheetMaxDisp: number;
  spanMs: number;
}

const PROBE_ROWS = Array.from({length: 40}, (_, i) => i + 1);

/** 끌기 하나(터치 시작 → 터치 끝 + 600ms)를 쟤서 한 줄로 낸다. */
function ProbeBody({
  variant,
  onGesture,
}: {
  variant: ProbeVariant;
  onGesture: (summary: GestureSummary, samples: Array<{t: number; y: number}>) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const samples = useRef<Array<{t: number; y: number}>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const box = useRef<View>(null);
  const y0 = useRef<number | null>(null);
  const maxDisp = useRef(0);

  const stopPoll = () => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  };
  useEffect(
    () => () => {
      stopPoll();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** 지금까지 쌓은 끌기 하나를 한 줄로 내고 비운다. */
  const flush = () => {
    stopPoll();
    const list = samples.current;
    samples.current = [];
    const ys = list.map(s => s.y);
    onGesture(
      {
        variant,
        n: list.length,
        minY: ys.length ? Math.min(...ys) : 0,
        maxY: ys.length ? Math.max(...ys) : 0,
        nonZero: ys.filter(y => Math.abs(y) > 0.5).length,
        sheetMaxDisp: Math.round(maxDisp.current * 10) / 10,
        spanMs: list.length ? list[list.length - 1].t - list[0].t : 0,
      },
      list.slice(0, 160),
    );
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const pending = useRef(false);

  const begin = () => {
    // 앞 끌기의 기록이 아직 안 나갔으면(터치 끝 + 600ms 전에 다음 터치가 왔다) 버리지 않고 먼저 낸다.
    if (timer.current) clearTimeout(timer.current);
    if (pending.current) flushRef.current();
    pending.current = false;
    stopPoll();
    samples.current = [];
    y0.current = null;
    maxDisp.current = 0;
    poll.current = setInterval(() => {
      box.current?.measureInWindow((_x, y) => {
        if (y0.current === null) y0.current = y;
        else maxDisp.current = Math.max(maxDisp.current, Math.abs(y - y0.current));
      });
    }, 33);
  };
  const end = () => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = true;
    // 관성이 끝나고 시트가 자리를 잡을 때까지(+600ms) 더 본 뒤 낸다.
    timer.current = setTimeout(() => {
      pending.current = false;
      flushRef.current();
    }, 600);
  };

  const sample = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    samples.current.push({t: Date.now(), y: event.nativeEvent.contentOffset.y});
  }, []);

  return (
    <View
      ref={box}
      collapsable={false}
      style={styles.probe}
      onTouchStart={begin}
      onTouchEnd={end}
      onTouchCancel={end}
      testID="sheetdrag-probe-body">
      {variant === 'std' ? <StdList sample={sample} /> : <RawList variant={variant} sample={sample} />}
    </View>
  );
}

function ProbeRows(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <>
      {PROBE_ROWS.map(n =>
        // 짝수 줄은 누르는 줄(Pressable — 목록 행·카드처럼 후손이 먼저 응답자가 된다: 시트는 이동에서 가로챈다), 홀수 줄은 눌리지 않는 줄(글자 카드처럼
        // 응답자가 없다: 넘치는 스크롤에서 시트가 시작 응답자를 잡으면 그 위에서 시작한 스크롤이 죽는다 — 118 의 P0 이 지킨다).
        n % 2 === 0 ? (
          <Pressable accessibilityRole="button" key={n} onPress={noop} style={styles.probeRow} testID={`probe-row-${n}`}>
            <Text style={styles.probeRowText}>{`항목 ${n}`}</Text>
          </Pressable>
        ) : (
          <View key={n} style={styles.probeRow} testID={`probe-row-${n}`}>
            <Text style={styles.probeRowText}>{`항목 ${n}`}</Text>
          </View>
        ),
      )}
    </>
  );
}

type SampleFn = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

/** 배송되는 `SheetScroll` — 시트에는 스스로 알리고(`usePageSheetScrollProps`), 호출자의 onScroll 은 계측만 한다. */
function StdList({sample}: {sample: SampleFn}): React.JSX.Element {
  return (
    <SheetScroll testID="sheetdrag-probe-scroll" onScroll={sample}>
      <ProbeRows />
    </SheetScroll>
  );
}

/**
 * 날 `ScrollView`: 고무줄이 있고(iOS 기본), 시트에는 오프셋만 알린다. `freeze` 만 시트가 끌기를 쥘 때 스크롤을 얼린다(1단계의 완화
 * 하나). `none` 은 얼림도 없다. 배송되는 어느 시트도 이렇게 만들어지지 않았다 — 방어가 하나씩 없을 때 어떻게 되는지의 대조군이다.
 */
function RawList({variant, sample}: {variant: ProbeVariant; sample: SampleFn}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const sheet = usePageSheetScroll();
  return (
    <ScrollView
      testID="sheetdrag-probe-scroll"
      bounces
      scrollEventThrottle={16}
      scrollEnabled={variant === 'freeze' ? !sheet?.frozen : true}
      onScroll={event => {
        sheet?.report(event.nativeEvent.contentOffset.y);
        sample(event);
      }}
      onScrollEndDrag={event => sheet?.report(event.nativeEvent.contentOffset.y)}
      onMomentumScrollEnd={event => sheet?.report(event.nativeEvent.contentOffset.y)}
      contentContainerStyle={styles.probeContent}>
      <ProbeRows />
    </ScrollView>
  );
}

function ProbeSurface({variant}: {variant: ProbeVariant}): React.JSX.Element {
  const {open, nonce, closes, onClosed, reopen} = useReopen();
  const [readout, setReadout] = useState('끌기 전');
  const onGesture = useCallback(
    (summary: GestureSummary, samples: Array<{t: number; y: number}>) => {
      setReadout(
        `표본 ${summary.n} · y ${summary.minY.toFixed(1)}…${summary.maxY.toFixed(1)} · 비영점 ${summary.nonZero} · 시트 ±${summary.sheetMaxDisp}`,
      );
      postToSink({kind: 'drag-probe', ...summary, samples});
    },
    [],
  );
  return (
    <Stage log={`닫힘 ${closes} · ${variant} · ${readout}`} reopen={open ? undefined : reopen}>
      {open ? (
        <PageSheet
          key={nonce}
          onClose={onClosed}
          accessibilityLabel="끌기 계측"
          scrimLabel="끌기 계측 닫기"
          testID="sheetdrag-probe-sheet">
          <SheetHeader title="끌기 계측" closeLabel="끌기 계측 닫기" closeTestID="sheetdrag-probe-close" />
          <ProbeBody variant={variant} onGesture={onGesture} />
        </PageSheet>
      ) : null}
    </Stage>
  );
}

export function SheetDragSurface({which}: {which: string}): React.JSX.Element {
  switch (which) {
    case 'action':
      return <ActionSurface />;
    case 'edit':
      return <EditSurface />;
    case 'probe-freeze':
      return <ProbeSurface variant="freeze" />;
    case 'probe-none':
      return <ProbeSurface variant="none" />;
    case 'probe-std':
      return <ProbeSurface variant="std" />;
    case 'list':
    default:
      return <ListSurface />;
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    stage: {flex: 1, backgroundColor: color.bg},
    stageBody: {paddingHorizontal: SAFE_GUTTER, gap: space.md},
    stageTitle: {fontSize: font.title, fontWeight: '700', color: color.text},
    stageLog: {fontSize: font.body, color: color.textMuted},
    reopen: {
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.card,
      backgroundColor: color.surfaceMuted,
    },
    reopenText: {fontSize: font.body, fontWeight: '600', color: color.text},
    stageRow: {
      paddingVertical: space.md,
      borderRadius: ds2Radius.card,
      paddingHorizontal: space.lg,
      backgroundColor: color.surface,
    },
    stageRowText: {fontSize: font.body, color: color.text},
    probe: {flex: 1},
    probeContent: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.md, paddingBottom: space.xl, gap: space.sm},
    probeRow: {
      height: 56,
      borderRadius: ds2Radius.card,
      paddingHorizontal: space.lg,
      justifyContent: 'center',
      backgroundColor: color.surface,
    },
    probeRowText: {fontSize: font.body, color: color.text},
  });
