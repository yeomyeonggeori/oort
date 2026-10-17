import {onlineManager} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Animated,
  RefreshControl,
  StyleSheet,
  Text,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type RefreshControlProps,
  type ScrollViewProps,
} from 'react-native';
import {haptics} from '../lib/haptics';
import {BAR_CONTROL_MAX_SCALE} from './atoms';
import {OortLoader} from './brand/OortLoader';
import {
  PULL_HEADER_HEIGHT,
  PULL_LOADER_SIZE,
  pullProgress,
  refreshFailed,
} from './pullRefresh';

// 화면이 `usePullRefresh` 를 가져오는 한 줄에서 같이 가져오게 다시 내보낸다.
export {PULL_FILL} from './pullRefresh';
import {useStyles} from './theme';
import {font, SAFE_GUTTER, space, type Palette} from './tokens';

// =============================================================================
// 당겨서 새로고침 (goal RN-B4b / #1026, 오르트 로더 #3962)
//
// 성재 파이널 체크: 에이전트 탭을 당겼는데 아무 일도 일어나지 않았다.
//
// 목록을 당기는 것은 배운 동작이 아니라 **기대**다. 화면에 보이는 것이 낡았을지도
// 모른다고 의심하는 순간 사람의 손은 이미 아래로 내려가 있고, 그때 아무 일도
// 일어나지 않으면 남는 결론은 「이 목록은 원래 이렇다」다 — 실제로는 15초 뒤에
// 저절로 맞춰질 화면이어도 그렇다.
//
// iOS 전용이다. Android 는 `refreshControl` 을 복제해 스크롤뷰를 감싸므로(`ScrollView.js`) 이 래퍼가
// 맞지 않는다. Android 는 보류 중이다(`clients/mobile/README.md`).
//
// ## 새 fetch 경로를 만들지 않는다
//
// 각 표면은 이미 자기를 다시 읽는 법을 알고 있다(`refetch`/`invalidateQueries`).
// 당김은 **그것을 부르는 새 입구**일 뿐이고, 두 번째 조회 경로가 되어서는 안 된다 —
// 그렇게 되는 순간 「화면이 말하는 것」과 「당기면 나오는 것」이 서로 다른 코드에서
// 오게 되고, 둘이 어긋나는 날 어느 쪽이 진실인지 말할 수 있는 사람이 없다.
//
// ## 표시는 오르트 로더다 (#3962)
//
// 시스템 스피너는 감춘다(`tintColor` 투명). 대신 목록 **위로 넘친 자리**에 로더 머리를 둔다:
// 당기는 동안 위성이 당긴 거리만큼 홈에서 튀어나오고, 임계를 넘어 새로고침이 서면(손가락이 아직
// 닿아 있어도) 그 자세에서 이어 돌며, 끝나면 내용과 함께 올라가 물러난다. 머리는 스크롤뷰의
// 자식이다(iOS 는 `refreshControl` 을 스크롤뷰의 자식으로 그린다). 레이아웃은 내용 맨 위에 두고
// `transform` 으로 올려 넘치지 않으면 보이지 않고 넘친 만큼만 드러나게 한다(`layout.header` 의 이유).
// 이 머리는 `UIRefreshControl` 이 새로고침 중에 열어 두는 자리(약 60pt) 안에 선다.
//
// 위성이 당긴 거리를 따라가려면 스크롤 오프셋이 필요하고 `RefreshControl` 은 그것을 말해 주지 않는다.
// 그래서 훅이 **목록에 펼칠 스크롤 props**(`scrollProps`)도 돌려준다. 빼먹어도 새로고침과 햅틱은 되고
// (머리는 새로고침이 서면 돈다), 당김을 따라가는 위성만 없다.
//
// ## 햅틱 (`lib/haptics.ts` 계약과의 관계)
//
// 임계 통과의 가벼운 햅틱(`light`)은 **표준 컨트롤이 새로고침을 세우는 순간**, 곧 `onRefresh` 가
// 불리는 순간에 낸다. 이 컨트롤은 손가락이 아직 닿아 있는 채로 임계를 넘는 순간 `onRefresh` 를
// 부른다(iOS 26.5 시뮬레이터에서 잰 것, `pullRefresh.ts` `PULL_TRIGGER`). 그래서 스크롤 이벤트로
// 우리가 임계를 따로 세지 않는다: 햅틱이 울리는 때와 새로고침이 서는 때가 **같은 신호 하나**이고,
// 진행 중에는 `busyRef` 가 막아 한 번의 새로고침에 한 번이다. 계약의 「스크롤에서는 부르지 않는다」를
// 그대로 지킨다.
//
// 완료(`success`/`warning`)는 사용자의 당김에 대한 **응답**이 도착해 화면이 바뀌는 순간이다(성공은 표시가
// 물러나기 시작할 때, 실패는 실패 안내가 서는 때). 애니메이션의 끝이 아니라 요청의 결과를 손에 전하는
// 일이라 계약 1·2번의 결과 햅틱 쪽이다(S2 의 전송 확정·실패와 같다). 햅틱이 꺼진 기기·설정은 OS 가 처리한다.
//
// ## 실패는 시각으로도 선다
//
// 햅틱은 유일한 피드백이 아니다(계약 3번). 재조회가 실패하면(던지거나, 결과가 오류 상태이거나, 오프라인이거나,
// 상한 안에 끝나지 않으면) 머리의 로더가 「새로고침하지 못했어요. 다시 당겨 보세요.」 한 줄로 바뀌어 잠깐 열린 채 머문 뒤
// 물러나고, 같은 문장을 낭독한다. 오류가 무엇인지는 각 화면이 이미 `ErrorState`/`NoticeBlock` 으로 말하고
// 있어서 여기서는 「당김이 실패했다」는 사실만 말한다. 인박스처럼 캐시된 항목 위에서 실패하면 화면에
// 다른 흔적이 없기 때문에 이 한 줄이 유일한 시각 신호다.
//
// 오프라인이면 요청을 세우지 않는다: react-query 쿼리는 연결될 때까지 멈춰 있어서(`networkMode: 'online'`)
// 재조회가 끝나지 않고 로더가 영영 돌며 busy 가 남는다. 읽을 수 없다는 사실을 바로 실패로 전한다.
// 연결돼 있는데 응답이 늦는 경우도 `MAX_WAIT_MS` 가 같은 모양으로 끝낸다(요청 자체는 멈추지 않는다).
//
// ## 스피너에 바닥을 깔아 두는 이유
//
// 캐시가 따뜻하면 `invalidateQueries` 는 한 프레임 안에 끝난다. 그 경우 표시는 나타났다는 사실조차
// 눈에 남기지 못하고 사라지고, 사람이 얻는 정보는 「아무 일도 안 일어났다」로 **결함과 같은 모양**이
// 된다. 그래서 최소 표시 창을 둔다. 이것은 가짜 진행률이 아니라 **응답의 확인**이다 — 데이터는 이미
// 새 것이고, 남는 것은 그 사실을 사람이 볼 수 있게 하는 시간뿐이다.
// =============================================================================

/**
 * 표시가 눈에 남는 최소 시간(ms).
 *
 * 250ms 는 「깜빡였다」이고 600ms 는 「느리다」다. 그 사이에서, iOS 의 당김 제스처가
 * 손을 떼고 스크롤뷰가 제자리로 돌아오는 데 걸리는 시간과 같은 크기로 잡았다.
 */
const MIN_VISIBLE_MS = 450;

/**
 * 재조회를 기다리는 시간의 상한(ms). 넘으면 실패로 끝낸다.
 *
 * 요청마다 15초 마감(`@momo/core/lib/http.ts`)과 재시도 1회(`query/queryClient.ts`)가 있어 가장 느린
 * 정상 실패도 30초대까지 간다. 그동안 로더가 돌고 새 당김이 막히고 낭독에 busy 가 남는 것은 길다 —
 * 20초면 정상적인 느린 응답은 대부분 끝나고, 그 뒤는 사람이 「안 된다」고 읽을 시간이다. 쿼리는 계속
 * 돌므로 늦게 도착한 데이터는 화면에 그대로 들어온다.
 */
const MAX_WAIT_MS = 20_000;

/** 실패 안내가 열린 채 머무는 시간(ms). 한 줄을 읽기에 충분하고 다음 시도를 막지 않을 만큼이다. */
const FAIL_NOTICE_MS = 1600;

/** 접근성 낭독. 시스템 스피너를 감췄으므로 VoiceOver 가 듣는 「새로고침 중」은 이 한 번이다. */
const ANNOUNCE_REFRESHING = '새로고침 중';
/** 실패 안내 문장(머리에 쓰이고 낭독된다). */
const FAILED_COPY = '새로고침하지 못했어요. 다시 당겨 보세요.';

/** 목록에 펼치는 스크롤 props. 위성이 당긴 거리를 따라가도록 오프셋을 읽는 길이다. */
export type PullScrollProps = Pick<ScrollViewProps, 'onScroll' | 'scrollEventThrottle'>;

export interface PullRefresh {
  /** 목록의 `refreshControl` prop 에 그대로 넣는다. */
  refreshControl: React.ReactElement<RefreshControlProps>;
  /** 같은 목록에 펼친다: `{...scrollProps}`. 목록에 이미 `onScroll` 이 있으면 `withPullScroll` 로 합친다. */
  scrollProps: PullScrollProps;
}

/**
 * 당겨서 새로고침 하나. 목록(또는 빈 상태)에 `refreshControl` 과 `scrollProps` 를 건다.
 *
 * @param onRefresh 이미 있는 재조회. 프로미스를 돌려주면 그것이 끝날 때까지 표시가 선다.
 *   **결과를 돌려주어야 실패가 보인다**: 결과가 오류 상태(`isError`/`status === 'error'`, 배열이면 하나라도)
 *   이거나 던지면 실패다. `invalidateQueries()` 는 쿼리가 실패해도 `undefined` 로 끝나므로 그 모양에는
 *   `invalidateAndReport`(`query/invalidateReport.ts`)를 쓴다. 결과를 모르는(`void`) 재조회는 실패라고
 *   단정하지 않아 성공으로 끝난다 — 그때 표시는 최소 표시 창만큼만 서고, 그 이상을 아는 척하지 않는다.
 */
export function usePullRefresh(
  onRefresh: () => Promise<unknown> | void,
  testID?: string,
): PullRefresh {
  const [refreshing, setRefreshing] = useState(false);
  /** 손가락이 목록을 위로 넘겼다(또는 새로고침 중이다): 로더 머리를 그린다. */
  const [shown, setShown] = useState(false);
  /** 실패 안내를 머리에 세운다(머리가 걷힐 때까지 남는다: 물러나는 내내 로더로 되돌아가지 않게). */
  const [failed, setFailed] = useState(false);
  /** 진행 중인 당김. 손가락이 두 번 당겨도 요청은 하나다. */
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  /** 최소 표시 창과 실패 안내 시간을 재는 타이머(둘은 이어서 하나씩만 선다). */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 재조회를 기다리는 시간의 상한 타이머. */
  const capRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 당김 진행도 0~1. 오프셋이 음수일 때만 갱신한다(평소 스크롤은 건드리지 않는다). */
  const pull = useRef(new Animated.Value(0)).current;
  const overscrollRef = useRef(false);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      if (capRef.current !== undefined) clearTimeout(capRef.current);
    },
    [],
  );

  const handleRefresh = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    // 임계 통과: 표준 컨트롤이 새로고침을 세우는 이 순간이 곧 햅틱이 울릴 때다(위 「햅틱」).
    haptics.light();
    setFailed(false);
    setShown(true);
    setRefreshing(true);
    AccessibilityInfo.announceForAccessibility?.(ANNOUNCE_REFRESHING);
    const startedAt = Date.now();
    let finished = false;
    const finish = (isFailed: boolean) => {
      if (finished) return; // 상한이 먼저 끝냈으면 늦게 온 답은 무시한다
      finished = true;
      if (capRef.current !== undefined) {
        clearTimeout(capRef.current);
        capRef.current = undefined;
      }
      const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt));
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        if (!mountedRef.current) return;
        if (!isFailed) {
          busyRef.current = false;
          setRefreshing(false);
          // 표시가 물러나는 순간이 곧 응답이 손에 닿는 순간이다.
          haptics.success();
          return;
        }
        // 실패: 안내가 서는 순간이 곧 응답이 손에 닿는 순간이다. 안내는 열린 채 잠깐 머문다.
        haptics.warning();
        AccessibilityInfo.announceForAccessibility?.(FAILED_COPY);
        setFailed(true);
        timerRef.current = setTimeout(() => {
          timerRef.current = undefined;
          busyRef.current = false;
          if (mountedRef.current) setRefreshing(false);
        }, FAIL_NOTICE_MS);
      }, wait);
    };
    // 오프라인이면 요청을 세우지 않는다(위 「실패는 시각으로도 선다」).
    if (!onlineManager.isOnline()) {
      finish(true);
      return;
    }
    capRef.current = setTimeout(() => finish(true), MAX_WAIT_MS);
    // 동기로 던지는 재조회도 약속의 거부로 받는다.
    new Promise<unknown>(resolve => resolve(onRefresh())).then(
      result => finish(refreshFailed(result)),
      () => finish(true),
    );
  }, [onRefresh]);

  const scrollProps = useMemo<PullScrollProps>(
    () => ({
      // 위성이 당김을 따라가려면 이벤트가 프레임마다 와야 한다. RN 0.86.2 Fabric 은 16 이하의 값을 제한 없음으로
      // 읽는다(`ScrollView.js`: 「Values <= 16 will disable throttling, regardless of the refresh rate」,
      // `RCTScrollViewComponentView.mm` `updateProps`: 1/60초 이하는 0) — 목록의 기본값(0.0001)과 같은 뜻이라
      // 이벤트가 버려지지 않는다. 이 값은 그 기본이 바뀌어도 프레임마다 오게 하는 명시다.
      scrollEventThrottle: 16,
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const y = event.nativeEvent.contentOffset.y;
        if (y < 0) {
          if (!overscrollRef.current) {
            overscrollRef.current = true;
            setShown(true);
          }
          pull.setValue(pullProgress(y));
        } else if (overscrollRef.current) {
          overscrollRef.current = false;
          pull.setValue(0);
          if (!busyRef.current) {
            setShown(false);
            setFailed(false);
          }
        }
      },
    }),
    [pull],
  );

  // 새로고침이 끝나고 내용이 제자리로 돌아오면(오프셋이 0 이상) 머리를 걷는다.
  useEffect(() => {
    if (!refreshing && !overscrollRef.current) {
      setShown(false);
      setFailed(false);
    }
  }, [refreshing]);

  const refreshControl = (
    <PullRefreshControl
      refreshing={refreshing}
      onRefresh={handleRefresh}
      shown={shown}
      failed={failed}
      pull={pull}
      testID={testID}
    />
  );
  return {refreshControl, scrollProps};
}

/**
 * 같은 목록이 이미 쓰는 `onScroll` 과 당김의 것을 합친다. 목록의 것이 먼저, 당김의 것이 뒤다.
 * (펼치기 `{...scrollProps}` 가 목록 자신의 `onScroll` 을 덮어쓰지 못하게 하는 자리.)
 */
export function withPullScroll(
  ownOnScroll: ScrollViewProps['onScroll'],
  pull: PullScrollProps | undefined,
): Pick<ScrollViewProps, 'onScroll' | 'scrollEventThrottle'> {
  if (pull === undefined) return {onScroll: ownOnScroll};
  return {
    scrollEventThrottle: pull.scrollEventThrottle,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      ownOnScroll?.(event);
      pull.onScroll?.(event);
    },
  };
}

/**
 * 목록의 `refreshControl` 로 서는 요소. 표준 `RefreshControl`(당김의 역학과 새로고침 중의 자리 확보는
 * 시스템이 한다, 스피너는 투명) + 목록 위로 넘친 자리의 오르트 로더 머리.
 *
 * `onRefresh`·`refreshing` 이 이 요소의 props 로 보이는 것은 시험이 이 요소의 `onRefresh` 를 직접
 * 부른다(`pullToRefresh.test.tsx`).
 */
function PullRefreshControl({
  refreshing,
  onRefresh,
  shown,
  failed,
  pull,
  testID,
}: RefreshControlProps & {
  shown: boolean;
  failed: boolean;
  pull: Animated.Value;
}): React.JSX.Element {
  return (
    <>
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        // 시스템 스피너는 투명이다: 그 자리를 로더 머리가 쓴다. iOS 는 `tintColor` 만 읽는다.
        tintColor="transparent"
        testID={testID}
      />
      {shown ? <PullHeader pull={pull} refreshing={refreshing} failed={failed} /> : null}
    </>
  );
}

/** 목록 위로 넘친 자리의 로더. 당김에 따라 나타나고, 새로고침이 서면 그 자세에서 돈다. 실패하면 한 줄로 바뀐다. */
function PullHeader({
  pull,
  refreshing,
  failed,
}: {
  pull: Animated.Value;
  refreshing: boolean;
  failed: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 조금 당기면 곧 보이고(25%), 더 당겨도 그대로다. 안 당긴 채로는 보이지 않는다.
  const opacity = useMemo(
    () =>
      pull.interpolate({
        inputRange: [0, 0.25, 1],
        outputRange: [0, 1, 1],
        extrapolate: 'clamp',
      }),
    [pull],
  );
  // 한 번 돌기 시작했으면 머리가 걷힐 때까지 돈다. 새로고침이 끝난 순간 위성이 당김 자세로
  // 튀어 돌아가면(돌던 자세 → 홈 쪽) 물러나는 내내 거슬린다. 머리가 걷히면 이 요소가 사라져 걸쇠도 풀린다.
  const spun = useRef(false);
  if (refreshing) spun.current = true;
  // 새로고침 중에는 당김과 무관하게 온전히 보인다(스프링백으로 오프셋이 줄어도 사라지지 않는다).
  const headerStyle = [layout.header, {opacity: refreshing ? 1 : opacity}];
  return (
    <Animated.View
      pointerEvents="none"
      // 시스템 스피너를 감췄으므로 이 띠가 「지금 새로고침 중」(실패하면 그 사실)이라는 말을 진다.
      // 로더 자신은 장식이다.
      accessible={refreshing}
      accessibilityRole={failed ? 'alert' : 'progressbar'}
      accessibilityLabel={failed ? FAILED_COPY : ANNOUNCE_REFRESHING}
      accessibilityState={{busy: refreshing && !failed}}
      style={headerStyle}
      testID="pull-refresh-header">
      {failed ? (
        <Text
          style={styles.notice}
          numberOfLines={2}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          testID="pull-refresh-failed">
          {FAILED_COPY}
        </Text>
      ) : (
        <OortLoader
          size={PULL_LOADER_SIZE}
          progress={pull}
          spinning={refreshing || spun.current}
          testID="pull-refresh-loader"
        />
      )}
    </Animated.View>
  );
}

const layout = StyleSheet.create({
  // 목록 위로 넘친 자리: 스크롤뷰가 위로 넘칠 때만 드러난다.
  //
  // **레이아웃은 내용 맨 위(`top: 0`)에 두고 `transform` 으로 올린다.** 음수 `top` 으로 두면 안 된다:
  // 스크롤 내용의 경계 상자 원점이 음수가 되어 내용 전체가 그만큼 위로 밀린다(맨 위 행이 위로 가려지고,
  // 손을 뗀 뒤 목록이 열린 자리에서도 내용과 머리의 위치가 어긋난다). iOS 26.5 시뮬레이터에서 같은
  // 당김·같은 손놓기로 쟀다(`measure/pullHold.tsx`): `top: -64`(64pt 짜리도 1pt 짜리도)는 당기기 전부터
  // 첫 행이 가려지고, `top: 0` + `translateY: -64` 는 당기기 전에 첫 행이 제자리이고 손을 뗀 뒤 약 60pt 가
  // 열린다. `transform` 은 레이아웃 프레임에 들어가지 않는다.
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: PULL_HEADER_HEIGHT,
    transform: [{translateY: -PULL_HEADER_HEIGHT}],
    alignItems: 'center',
    // 열린 자리(약 60pt)에서 로더가 첫 행 쪽으로 붙는다: 행 자신의 위 여백이 있어서 위로 치우쳐 보이지 않게
    // (실측 캡처에서 링 윗변~머리선 17pt, 링 아랫변~첫 행 글자 44pt 였다).
    justifyContent: 'flex-end',
    paddingBottom: space.xs,
  },
});

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 오류 어휘는 다른 화면과 같다(`ErrorState` 의 제목이 `color.danger`). 두 줄까지 접히되 머리(64pt) 안에 선다:
    // 크롬의 상한(`BAR_CONTROL_MAX_SCALE`)까지 자라고, 줄 높이는 글자 크기를 따른다(고정하지 않는다).
    notice: {
      fontSize: font.label,
      color: color.danger,
      fontWeight: '500',
      textAlign: 'center',
      paddingHorizontal: SAFE_GUTTER,
    },
  });
