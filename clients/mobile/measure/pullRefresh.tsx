import {onlineManager} from '@tanstack/react-query';
import React, {useEffect, useRef} from 'react';
import {FlatList, StyleSheet, Text, View} from 'react-native';
import {EmptyState, Screen, ScreenHeader, TapRow} from '../src/design/atoms';
import {PULL_TRIGGER} from '../src/design/pullRefresh';
import {PULL_FILL, usePullRefresh} from '../src/design/refresh';
import {useStyles} from '../src/design/theme';
import {font, space, type Palette} from '../src/design/tokens';

// =============================================================================
// 당겨서 새로고침 캡처 표면 (#3962). 실제 훅(`usePullRefresh`)과 실제 원자(`Screen`·`ScreenHeader`·
// `TapRow`)로 목록을 세운다. 손가락 당김은 시뮬레이터 창에 `cliclick` 으로 주입한다(레포에 스크립트는
// 두지 않는다: 창 위치 보정이 사람 손의 일이라서).
//
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure PULL-REFRESH
//   (라이트: LIGHT-PULL-REFRESH)
//
//   pull-refresh          재조회가 2.5초 걸린다: 당김 → 새로고침 중 → 물러남이 한 번에 보인다
//   pull-refresh-hold     재조회가 끝나지 않는다: 「새로고침 중」 자세를 붙잡아 찍는다
//   pull-refresh-fail     재조회가 1.2초 뒤 실패한다(오류 결과): 목록 위에 실패 안내 한 줄이 서고 **시간으로 사라지지
//                         않는다**(#3992). 다음 당김이 서면 사라진다
//   pull-refresh-auto-fail  손가락 없이 실패를 만든다(1.5초 뒤 스스로 한 번, 9초 뒤 한 번 더 `onRefresh` 를 부른다).
//                         실패 안내가 서는 순간·사라지는 순간의 움직임을 영상으로 잴 때 쓴다(손가락의 타이밍 잡음이 없다)
//   pull-refresh-offline  오프라인이다(`onlineManager`): 재조회를 세우지 않고 바로 실패 안내로 끝난다(연결을 말하는 문장)
//   pull-refresh-pin-25|50|75|100  당김을 그 진행도에 **고정**한다(손가락 대신 `scrollToOffset(-임계 × 진행도)`).
//                         위성이 궤도를 도는 각도(25·50·75·100% = 90° 씩)를 같은 자리에서 정확히 찍는다. 100% 는 임계
//                         바로 아래(-146)다: 임계(-147.3)를 넘으면 표준 컨트롤이 새로고침을 세워 돌기 시작한다
//   pull-refresh-empty    빈 상태(`EmptyState`)의 당김: 재조회가 끝나지 않는다
//   pull-refresh-short    두 줄짜리 짧은 목록(`PULL_FILL` 적용): 아래 빈 자리에서도 당겨진다
//   pull-refresh-short-dead  같은 목록에서 `PULL_FILL` 이 없는 대조군: 아래 빈 자리(화면 y 500)를 당기면 아무 일도 없다
// =============================================================================

const ROWS = [
  ['# general', '새 메시지를 불러왔어요'],
  ['# agent-lab', '김인턴이 작업 중이에요'],
  ['# design-2.0', '시안 검토'],
  ['# 릴리스', '이번 주 빌드 점검'],
  ['# 운영-온콜', '야간 알림 인계'],
  ['김인턴', '에이전트'],
  ['김여명', '오전 10:12'],
  ['박세준', '어제'],
  ['# 엔진', '릴레이 점검 끝'],
  ['# 웹', 'PR 두 건 대기'],
  ['# 폰', '새로고침 시안'],
  ['# 문서', '정본 갱신'],
] as const;

export function PullRefreshSurface({which}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const listRef = useRef<FlatList<(typeof ROWS)[number]>>(null);
  // `pin-25` → 0.25. 진행도를 고정하는 판이다(손가락 없이 스크롤 오프셋을 직접 둔다).
  const pin = which.startsWith('pin-') ? Number(which.slice('pin-'.length)) / 100 : null;
  useEffect(() => {
    if (pin === null) return undefined;
    // 100% 는 임계(-147.3)를 넘지 않게 1pt 아래에 둔다.
    const offset = pin >= 1 ? -(PULL_TRIGGER - 1) : -PULL_TRIGGER * pin;
    const timer = setTimeout(() => listRef.current?.scrollToOffset({offset, animated: false}), 700);
    return () => clearTimeout(timer);
  }, [pin]);
  const onRefresh = React.useCallback((): Promise<unknown> => {
    if (which === 'hold' || which === 'empty' || which.startsWith('short') || which.startsWith('pin-')) {
      return new Promise(() => undefined);
    }
    if (which === 'fail' || which === 'auto-fail') {
      return new Promise(resolve => setTimeout(() => resolve([{status: 'error', isError: true}]), 1200));
    }
    return new Promise(resolve => setTimeout(() => resolve([{status: 'success'}]), 2500));
  }, [which]);
  const {refreshControl, scrollProps, notice} = usePullRefresh(onRefresh, 'pull-surface-refresh');
  useEffect(() => {
    if (which !== 'offline') return undefined;
    onlineManager.setOnline(false);
    return () => onlineManager.setOnline(true);
  }, [which]);
  // 손가락 없이 두 번 당김을 흉내 낸다(표준 컨트롤이 부르는 것과 같은 입구 `onRefresh`).
  const trigger = refreshControl.props.onRefresh;
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  useEffect(() => {
    if (which !== 'auto-fail') return undefined;
    const timers = [1_500, 9_000].map(ms => setTimeout(() => triggerRef.current?.(), ms));
    return () => timers.forEach(clearTimeout);
  }, [which]);
  if (which === 'short' || which === 'short-dead') {
    return (
      <Screen>
        <ScreenHeader title="채널" subtitle={which === 'short' ? '짧은 목록' : '짧은 목록 (PULL_FILL 없음)'} />
        {notice}
        <FlatList
          data={ROWS.slice(0, 2)}
          keyExtractor={row => row[0]}
          renderItem={({item}) => (
            <TapRow accessibilityLabel={item[0]} onPress={() => undefined}>
              <View style={styles.row}>
                <Text style={styles.title}>{item[0]}</Text>
                <Text style={styles.meta}>{item[1]}</Text>
              </View>
            </TapRow>
          )}
          contentContainerStyle={which === 'short' ? PULL_FILL : undefined}
          refreshControl={refreshControl}
          {...scrollProps}
          testID="pull-surface-short"
        />
      </Screen>
    );
  }
  if (which === 'empty') {
    return (
      <Screen>
        <ScreenHeader title="채널" subtitle="당겨서 새로고침" />
        {notice}
        <EmptyState
          headline="아직 참여한 채널이 없습니다."
          detail="아래로 당기면 새로 읽어 와요."
          refreshControl={refreshControl}
          scrollProps={scrollProps}
          testID="pull-surface-empty"
        />
      </Screen>
    );
  }
  return (
    <Screen>
      <ScreenHeader title="채널" subtitle="당겨서 새로고침" />
      {notice}
      <FlatList
        ref={listRef}
        data={ROWS}
        keyExtractor={row => row[0]}
        renderItem={({item}) => (
          <TapRow accessibilityLabel={item[0]} onPress={() => undefined}>
            <View style={styles.row}>
              <Text style={styles.title}>{item[0]}</Text>
              <Text style={styles.meta}>{item[1]}</Text>
            </View>
          </TapRow>
        )}
        refreshControl={refreshControl}
        {...scrollProps}
        testID="pull-surface-list"
      />
    </Screen>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {flex: 1, gap: space.xs, paddingVertical: space.sm},
    title: {fontSize: font.body, color: color.text, fontWeight: '600'},
    meta: {fontSize: font.label, color: color.textMuted},
  });
