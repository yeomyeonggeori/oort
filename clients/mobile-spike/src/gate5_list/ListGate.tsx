/**
 * 게이트 5 — 타임라인 리스트 3자 실측
 *
 * **판정 항목은 프레임률이 아니다.** 난점은 inverted + 스크롤 위치 보존이다.
 * 그래서 이 화면의 주 계측은 다음 하나다:
 *
 *   화면에 보이는 **앵커 행의 절대 화면 좌표(measureInWindow)** 가
 *   메시지 삽입 전후로 몇 px 움직였는가.
 *
 * 왜 contentOffset 이 아니라 measureInWindow 인가:
 *   리스트가 보정을 안 하면 contentOffset 은 **그대로인 채** 내용만 밀린다.
 *   즉 offset 만 보면 "안 움직였다"는 잘못된 결론이 나온다. 사람이 실제로
 *   겪는 것은 "읽던 줄이 화면에서 튀는 것"이므로 화면 좌표를 재야 한다.
 *   이 값은 세 라이브러리에서 같은 의미를 갖는다(구현 내부와 무관).
 *
 * 프레임률은 FlashList 가 제공하는 `JSFPSMonitor` + `autoScroll` 로 잰다.
 * 손가락 대신 스크립트가 같은 거리를 같은 속도로 밀기 때문에 3자 비교가 가능하다.
 * **단 이것은 JS 스레드 프레임률이다. UI(네이티브) 스레드가 아니다** — 아래 주의 참조.
 */
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {Animated, Text, View} from 'react-native';
import {FlashList, JSFPSMonitor, autoScroll} from '@shopify/flash-list';
import {LegendList} from '@legendapp/list/react-native';

import {Badge, Btn, C, Card, KV, Row, s, type Verdict} from '../ui';
import {makeMessages, makeOlder, newIncoming, type Msg} from './data';

const N = 1000;
/** 앵커: 양 끝에서 충분히 떨어진 행. 삽입 지점과 인접하지 않아야 한다. */
const ANCHOR_INDEX = 40;

type Impl = 'flatlist' | 'flashlist' | 'legend';

const IMPL_LABEL: Record<Impl, string> = {
  flatlist: 'Animated.FlatList',
  flashlist: 'FlashList v2',
  legend: '@legendapp/list',
};

interface Measured {
  fps?: {min: number; max: number; avg: number};
  /** 하단(새 메시지) 삽입 시 앵커가 움직인 px */
  incomingShiftPx?: number;
  /** 상단(과거 프리펜드) 시 앵커가 움직인 px */
  prependShiftPx?: number;
}

function Bubble({m}: {m: Msg}) {
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        alignItems: m.mine ? 'flex-end' : 'flex-start',
      }}
    >
      <View
        style={{
          maxWidth: '86%',
          backgroundColor: m.mine ? '#1f3a5f' : C.card,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: C.line,
          paddingHorizontal: 11,
          paddingVertical: 8,
        }}
      >
        <Text style={{color: C.dim, fontSize: 11, marginBottom: 2}}>
          {m.who} · #{m.seq}
        </Text>
        <Text style={{color: C.text, fontSize: 14, lineHeight: 20}}>{m.body}</Text>
      </View>
    </View>
  );
}

const AnimatedFlatList = Animated.FlatList;

export default function ListGate() {
  const [impl, setImpl] = useState<Impl>('flatlist');
  const [data, setData] = useState<Msg[]>(() => makeMessages(N));
  const [measured, setMeasured] = useState<Record<Impl, Measured>>({
    flatlist: {},
    flashlist: {},
    legend: {},
  });
  const [busy, setBusy] = useState<string>('');
  /** FlatList 의 maintainVisibleContentPosition 을 켜고 끌 수 있게 — 차이 자체가 데이터다 */
  const [mvcp, setMvcp] = useState(true);

  const listRef = useRef<any>(null);
  const anchorRef = useRef<View | null>(null);

  const anchorId = data[ANCHOR_INDEX]?.id;

  const renderItem = useCallback(
    ({item}: {item: Msg}) =>
      item.id === anchorId ? (
        <View ref={r => {anchorRef.current = r;}} collapsable={false}>
          <Bubble m={item} />
        </View>
      ) : (
        <Bubble m={item} />
      ),
    [anchorId],
  );

  const keyExtractor = useCallback((m: Msg) => m.id, []);

  const measureAnchor = (): Promise<number | null> =>
    new Promise(resolve => {
      const node = anchorRef.current;
      if (!node) {
        resolve(null);
        return;
      }
      node.measureInWindow((_x, y) => resolve(y));
    });

  const wait = (ms: number) => new Promise<void>(r => setTimeout(() => r(), ms));

  const scrollToOffset = (y: number, animated: boolean) => {
    listRef.current?.scrollToOffset?.({offset: y, animated});
  };

  /** 앵커 행을 화면 중앙에 놓는다. 세 라이브러리 모두 scrollToIndex 를 지원한다. */
  const centerAnchor = async () => {
    try {
      listRef.current?.scrollToIndex?.({
        index: ANCHOR_INDEX,
        animated: false,
        viewPosition: 0.5,
      });
    } catch {
      scrollToOffset(1200, false);
    }
    await wait(700);
  };

  const runShiftTest = async (kind: 'incoming' | 'prepend') => {
    setBusy(kind === 'incoming' ? '새 메시지 삽입 측정 중…' : '과거 프리펜드 측정 중…');
    await centerAnchor();
    const before = await measureAnchor();
    if (before === null) {
      setBusy('앵커 행이 화면에 없다 — 측정 실패');
      return;
    }
    if (kind === 'incoming') {
      // inverted 이므로 index 0 = 화면 맨 아래 = "새 메시지 도착"
      setData(d => [newIncoming(), ...d]);
    } else {
      // 배열 끝 = 화면 위쪽 = "과거 메시지 프리펜드(위로 로드)"
      setData(d => [...d, ...makeOlder(20)]);
    }
    await wait(900);
    const after = await measureAnchor();
    if (after === null) {
      setBusy('삽입 후 앵커가 사라졌다 — 위치 보존 실패로 기록');
      setMeasured(m => ({
        ...m,
        [impl]: {
          ...m[impl],
          [kind === 'incoming' ? 'incomingShiftPx' : 'prependShiftPx']: -1,
        },
      }));
      return;
    }
    const shift = Math.round(Math.abs(after - before) * 10) / 10;
    setMeasured(m => ({
      ...m,
      [impl]: {
        ...m[impl],
        [kind === 'incoming' ? 'incomingShiftPx' : 'prependShiftPx']: shift,
      },
    }));
    setBusy(`측정 완료: 앵커가 ${shift}px 움직였다`);
  };

  const runFps = async () => {
    setBusy('자동 스크롤 + JS 프레임률 측정 중…');
    scrollToOffset(0, false);
    await wait(400);
    const monitor = new JSFPSMonitor();
    monitor.startTracking();
    await autoScroll(
      (_x, y, animated) => scrollToOffset(y, animated),
      0,
      0,
      0,
      4000,
      1,
    );
    const r = monitor.stopAndGetData();
    setMeasured(m => ({
      ...m,
      [impl]: {
        ...m[impl],
        fps: {
          min: Math.round(r.minFPS * 10) / 10,
          max: Math.round(r.maxFPS * 10) / 10,
          avg: Math.round(r.averageFPS * 10) / 10,
        },
      },
    }));
    setBusy(`JS 프레임률 평균 ${Math.round(r.averageFPS * 10) / 10}`);
  };

  const reset = () => {
    setData(makeMessages(N));
    setBusy('데이터 초기화');
  };

  /** 현재 구현에 대해 ①②③ 을 순서대로. 기기에서 탭 3번을 1번으로 줄인다. */
  const runAll = async () => {
    await runFps();
    await wait(400);
    await runShiftTest('incoming');
    await wait(400);
    await runShiftTest('prepend');
    setBusy('전체 측정 완료 — 구현을 바꿔 다시 눌러라');
  };

  const common = {
    ref: listRef,
    data,
    renderItem,
    keyExtractor,
    inverted: true,
    style: {flex: 1, backgroundColor: C.bg},
  } as any;

  const list = useMemo(() => {
    if (impl === 'flatlist') {
      return (
        <AnimatedFlatList
          {...common}
          maintainVisibleContentPosition={
            mvcp ? {minIndexForVisible: 0} : undefined
          }
          windowSize={11}
          initialNumToRender={20}
          removeClippedSubviews
        />
      );
    }
    if (impl === 'flashlist') {
      // v2 는 maintainVisibleContentPosition 을 기본 활성화한다(별도 설정 없음).
      return <FlashList {...common} />;
    }
    return <LegendList {...common} recycleItems />;
  }, [impl, common, mvcp]);

  const shiftVerdict = (px?: number): Verdict =>
    px === undefined ? 'PENDING' : px <= 2 ? 'PASS' : 'FAIL';

  return (
    <View style={s.screen}>
      <Card title={`게이트 5 — 타임라인 3자 · ${IMPL_LABEL[impl]}`}>
        <Row>
          {(Object.keys(IMPL_LABEL) as Impl[]).map(k => (
            <Btn
              key={k}
              label={impl === k ? `● ${IMPL_LABEL[k]}` : `○ ${IMPL_LABEL[k]}`}
              onPress={() => setImpl(k)}
              tone={impl === k ? 'accent' : 'normal'}
            />
          ))}
        </Row>
        <Row>
          <Btn label="▶ 전체 자동 측정" onPress={runAll} tone="accent" />
          <Btn label="① 자동 스크롤 + FPS" onPress={runFps} />
          <Btn label="② 새 메시지 도착" onPress={() => runShiftTest('incoming')} />
          <Btn label="③ 과거 20건 위로" onPress={() => runShiftTest('prepend')} />
          <Btn label="초기화" onPress={reset} />
          {impl === 'flatlist' ? (
            <Btn
              label={mvcp ? 'mVCP: 켬' : 'mVCP: 끔'}
              onPress={() => setMvcp(v => !v)}
            />
          ) : null}
        </Row>
        {busy ? <Text style={[s.dim, {marginTop: 6}]}>{busy}</Text> : null}

        <Text style={[s.dim, {marginTop: 10}]}>
          결과 ({N}행 · 앵커 index {ANCHOR_INDEX} · 판정 기준 앵커 이동 ≤ 2px)
        </Text>
        {(Object.keys(IMPL_LABEL) as Impl[]).map(k => {
          const m = measured[k];
          return (
            <View key={k} style={{marginTop: 6}}>
              <Text style={[s.mono, {color: C.text}]}>{IMPL_LABEL[k]}</Text>
              <View style={{flexDirection: 'row', alignItems: 'center', marginTop: 2}}>
                <Badge verdict={shiftVerdict(m.incomingShiftPx)} label="새메시지" />
                <Text style={[s.mono, {marginLeft: 6}]}>
                  {m.incomingShiftPx === undefined ? '미측정' : `${m.incomingShiftPx}px`}
                </Text>
                <View style={{width: 10}} />
                <Badge verdict={shiftVerdict(m.prependShiftPx)} label="프리펜드" />
                <Text style={[s.mono, {marginLeft: 6}]}>
                  {m.prependShiftPx === undefined ? '미측정' : `${m.prependShiftPx}px`}
                </Text>
              </View>
              <Text style={s.mono}>
                JS FPS: {m.fps ? `평균 ${m.fps.avg} / 최소 ${m.fps.min} / 최대 ${m.fps.max}` : '미측정'}
              </Text>
            </View>
          );
        })}
        <Text style={[s.dim, {marginTop: 8}]}>
          주의: FPS 는 **JS 스레드** 값이다. 인버티드 리스트의 끊김은 UI 스레드에서
          생기는 경우가 많으므로, 이 수치만으로 PASS 를 주지 마라. UI 스레드는
          기기에서 개발자 메뉴 → Perf Monitor 로 따로 읽어야 한다.
        </Text>
      </Card>
      <View style={{flex: 1}}>{list}</View>
    </View>
  );
}
