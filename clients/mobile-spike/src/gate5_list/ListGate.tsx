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
  /**
   * **[2026-08-02 실기기 1차 측정 후 추가]**
   *
   * 1차는 `inverted: true` 만 쟀고 3자 모두 새 메시지에서 46~91px 튀었다(프리펜드는
   * 3자 모두 0px). 그런데 **momo 웹 타임라인은 인버티드가 아니다** —
   * `clients/web/src/features/timeline/Timeline.tsx` 는 정방향 흐름 + 명시적 앵커
   * 보존(react-virtuoso `firstItemIndex` 를 삽입 개수만큼 감소)으로 돌아간다.
   * 인버티드는 Mattermost 전제를 티켓이 승계한 것이지 우리 설계가 아니었다.
   *
   * 정방향에서는 새 메시지가 아래에 붙으므로 **위쪽 내용이 구조적으로 안 움직인다**.
   * 그래서 같은 세 구현을 정방향으로도 재서, RN 코어 패치가 정말 필요한 결정인지
   * 아니면 전제만 바꾸면 되는 문제인지 가른다.
   *
   * 데이터 조작은 두 모드가 **동일**하다(배열 머리 = 최신). 다른 것은 렌더 방향과
   * 앵커의 렌더 인덱스뿐이다.
   */
  const [invertedMode, setInvertedMode] = useState(true);

  const listRef = useRef<any>(null);
  const anchorRef = useRef<View | null>(null);
  // 비동기 측정 루프는 setState 직후의 `impl` 을 클로저로 못 본다(스테일).
  // 자동 매트릭스 실행이 어느 구현의 값을 기록하는지 확실히 하려고 ref 로 미러링한다.
  const implRef = useRef<Impl>('flatlist');
  implRef.current = impl;

  /** 정방향이면 최신이 끝에 오도록 뒤집어 렌더한다. */
  const renderData = useMemo(
    () => (invertedMode ? data : [...data].reverse()),
    [data, invertedMode],
  );

  /**
   * 앵커는 **렌더 배열 기준 index 40** 이다. 두 모드 모두 초기 창에서 가까워
   * `scrollToIndex` 가 확실히 도달한다.
   *
   * (앞선 판은 앵커를 `data` 기준으로 잡아 정방향에서 index 959 가 됐고, 가상화 창이
   * 못 따라와 앵커가 렌더되지 않아 측정이 통째로 실패했다.)
   *
   * 의미도 두 모드에서 자연스럽다:
   *  - 인버티드: 최신에서 40번째 = 위로 조금 올려 읽는 중. 새 메시지는 **아래**에 꽂힌다.
   *  - 정방향: 오래된 것에서 40번째 = 과거를 읽는 중. 새 메시지는 **훨씬 아래**에 붙고,
   *    과거 프리펜드는 앵커 **위**로 들어온다 — 정확히 재려던 두 상황이다.
   */
  const anchorRenderIndex = ANCHOR_INDEX;
  const anchorId = renderData[ANCHOR_INDEX]?.id;

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

  /**
   * 앵커 행을 화면 중앙에 놓는다. 세 라이브러리 모두 scrollToIndex 를 지원한다.
   *
   * **[정방향 모드에서 실패해서 고쳤다]** 인버티드에서는 앵커가 index 40 이라 초기
   * 창에 가까웠지만, 정방향에서는 index 959(=1000-1-40) 라 한 번의 scrollToIndex 로는
   * 가상화 창이 못 따라와 앵커가 렌더되지 않았다 → `measureInWindow` 가 null →
   * 측정이 조용히 건너뛰어져 `?px` 가 찍혔다. 실패한 것을 실패로 남기지 않고
   * 지나간 것이 진짜 문제라, 이제 **도달할 때까지 재시도하고 그래도 안 되면 기록한다**.
   * 옛 폴백(고정 오프셋 1200)은 인버티드 전용 수치였어서 정방향에선 엉뚱한 곳이었다.
   */
  const centerAnchor = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        listRef.current?.scrollToIndex?.({
          index: anchorRenderIndex,
          animated: false,
          viewPosition: 0.5,
        });
      } catch {
        // 행 높이가 균일하지 않아도 대략은 맞는다. 반복하면서 좁혀 간다.
        scrollToOffset(anchorRenderIndex * 92, false);
      }
      await wait(attempt === 0 ? 900 : 350);
      if ((await measureAnchor()) !== null) {
        return true;
      }
    }
    return false;
  };

  const runShiftTest = async (kind: 'incoming' | 'prepend') => {
    setBusy(kind === 'incoming' ? '새 메시지 삽입 측정 중…' : '과거 프리펜드 측정 중…');
    const reached = await centerAnchor();
    const before = reached ? await measureAnchor() : null;
    if (before === null) {
      // **조용히 건너뛰지 않는다.** 이전 판에서는 여기서 그냥 return 해 결과가
      // `?px` 로 남았고, 그것이 "측정 안 됨"인지 "0px"인지 표에서 구분되지 않았다.
      setMeasured(m => ({
        ...m,
        [implRef.current]: {
          ...m[implRef.current],
          [kind === 'incoming' ? 'incomingShiftPx' : 'prependShiftPx']: -1,
        },
      }));
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
        [implRef.current]: {
          ...m[implRef.current],
          [kind === 'incoming' ? 'incomingShiftPx' : 'prependShiftPx']: -1,
        },
      }));
      return;
    }
    const shift = Math.round(Math.abs(after - before) * 10) / 10;
    setMeasured(m => ({
      ...m,
      [implRef.current]: {
        ...m[implRef.current],
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
      [implRef.current]: {
        ...m[implRef.current],
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

  /**
   * **자동 매트릭스** — 사람이 버튼을 누르지 않아도 세 구현을 한 모드에서 전부 잰다.
   *
   * 왜 필요했나: 모드 전환을 사람 조작에 맡겼더니 **실제로 잘못된 모드의 수치가 표에
   * 남는 일이 생겼다**. 조작을 없애는 것이 결과를 믿을 수 있게 만드는 유일한 길이다.
   * 끝나면 결과를 콘솔로도 흘린다(시뮬레이터에서는 Metro 가 받는다).
   */
  const runMatrix = useCallback(async (inverted: boolean) => {
    setInvertedMode(inverted);
    setData(makeMessages(N));
    setMeasured({flatlist: {}, flashlist: {}, legend: {}});
    await wait(1200);
    for (const k of ['flatlist', 'flashlist', 'legend'] as Impl[]) {
      setImpl(k);
      implRef.current = k;
      await wait(1200);
      await runFps();
      await wait(300);
      await runShiftTest('incoming');
      await wait(300);
      await runShiftTest('prepend');
      await wait(300);
    }
    setBusy(`자동 매트릭스 완료 — ${inverted ? '인버티드' : '정방향'}`);
    setTimeout(() => {
      setMeasured(m => {
        const line = (['flatlist', 'flashlist', 'legend'] as Impl[])
          .map(k => {
            const v = m[k];
            return `${IMPL_LABEL[k]} 새메시지=${v.incomingShiftPx ?? '?'}px 프리펜드=${
              v.prependShiftPx ?? '?'
            }px fps=${v.fps?.avg ?? '?'}`;
          })
          .join(' | ');
        console.log(`[GATE5] ${inverted ? 'INVERTED' : 'FORWARD'} :: ${line}`);
        // 화면에 의존하지 않는 결과 경로. 시뮬레이터의 시스템 알림이 결과 카드를
        // 덮어 스크린샷 판독이 막힌 적이 있어, 오케스트레이터의 로컬 수집기로 직접 쏜다.
        // (수집기가 없으면 조용히 실패할 뿐 측정에는 영향이 없다.)
        fetch(
          `http://127.0.0.1:18099/GATE5?mode=${
            inverted ? 'INVERTED' : 'FORWARD'
          }&r=${encodeURIComponent(line)}`,
        ).catch(() => {});
        return m;
      });
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 앱이 뜨면 **정방향**을 자동으로 잰다 — 이 판정에 남은 유일한 미측정 항목이다. */
  const autoRan = useRef(false);
  React.useEffect(() => {
    if (autoRan.current) {
      return;
    }
    autoRan.current = true;
    void runMatrix(false);
  }, [runMatrix]);

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
    data: renderData,
    renderItem,
    keyExtractor,
    inverted: invertedMode,
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
          // `getItemLayout` 이 없으면 FlatList 의 scrollToIndex 는 렌더되지 않은
          // 인덱스에서 실패한다. RN 문서가 지정한 처방이 이 콜백이다 — 대략 위치로
          // 밀고 다음 프레임에 다시 시도한다. 없으면 앵커를 못 잡아 측정이 통째로
          // 실패했다(실측: 정방향에서 -1px 로 남았다).
          onScrollToIndexFailed={(info: {
            index: number;
            averageItemLength: number;
          }) => {
            scrollToOffset(
              info.index * (info.averageItemLength || 92),
              false,
            );
            setTimeout(() => {
              try {
                listRef.current?.scrollToIndex?.({
                  index: info.index,
                  animated: false,
                  viewPosition: 0.5,
                });
              } catch {
                /* 다음 재시도가 받는다 */
              }
            }, 120);
          }}
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
      <Card
        title={`게이트 5 — ${
          invertedMode ? '인버티드' : '정방향'
        } · ${IMPL_LABEL[impl]}`}
      >
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
          {/* 모드를 바꾸면 측정값을 **비운다**. 한 표에 두 모드가 섞이면 어느 쪽 수치인지
              사라진다 — 게이트 1에서 키보드 전환이 같은 구멍을 냈다. */}
          <Btn
            label={invertedMode ? '● 인버티드 (Mattermost 전제)' : '○ 인버티드'}
            tone={invertedMode ? 'accent' : 'normal'}
            onPress={() => {
              setInvertedMode(true);
              setData(makeMessages(N));
              setMeasured({flatlist: {}, flashlist: {}, legend: {}});
              setBusy('인버티드 모드 — 측정값을 비웠다');
            }}
          />
          <Btn
            label={!invertedMode ? '● 정방향 (momo 웹과 동일)' : '○ 정방향'}
            tone={!invertedMode ? 'accent' : 'normal'}
            onPress={() => {
              setInvertedMode(false);
              setData(makeMessages(N));
              setMeasured({flatlist: {}, flashlist: {}, legend: {}});
              setBusy('정방향 모드 — 측정값을 비웠다');
            }}
          />
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
          결과 · <Text style={{color: C.accent}}>{invertedMode ? '인버티드' : '정방향'}</Text>
          {'  '}({N}행 · 앵커 index {ANCHOR_INDEX} · 판정 기준 앵커 이동 ≤ 2px)
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
