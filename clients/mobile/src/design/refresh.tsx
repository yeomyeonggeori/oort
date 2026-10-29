import {serverSaysAbsent} from '@momo/core/features/capabilities/serverSurfaces';
import {
  onlineManager,
  QueryClientContext,
  type QueryClient,
} from '@tanstack/react-query';
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  LayoutAnimation,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type RefreshControlProps,
  type ScrollViewProps,
} from 'react-native';
import {haptics, hapticScope} from '../lib/haptics';
import {useReduceMotionRef} from '../lib/useReduceMotion';
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
import {font, radius, SAFE_GUTTER, space, type Palette} from './tokens';

// =============================================================================
// 당겨서 새로고침 (goal RN-B4b / #1026, 오르트 로더 #3962, 실패 안내의 지속 #3992)
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
// 당기는 동안 위성이 당긴 거리만큼 **궤도를 돌고**(25·50·75·100% 에 90° 씩, 임계에서 한 바퀴 — 눈금은
// `brand/oortLoaderTimeline.ts` 「당김의 자세」, #3992), 임계를 넘어 새로고침이 서면(손가락이 아직 닿아 있어도)
// 그 자세에서 이어 돌며, 끝나면 내용과 함께 올라가 물러난다. 머리는 스크롤뷰의
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
// 성공은 무음이고 실패만 `warning`이다(#4298). 요청을 시작한 화면·대상이 그대로 있고 앱이 앞에 있을 때만
// 결과를 전한다. 화면을 떠났다가 돌아와도 이전 당김의 늦은 결과는 울리지 않는다.
//
// ## 실패는 시각으로도 서고, 시간으로 사라지지 않는다 (#3992)
//
// 햅틱은 유일한 피드백이 아니다(계약 3번). 재조회가 실패하면(던지거나, 결과가 오류 상태이거나, 오프라인이거나,
// 상한 안에 끝나지 않으면) 「새로고침하지 못했어요. 다시 당겨 보세요.」 한 줄이 서고 같은 문장을 낭독한다.
// 오류가 무엇인지는 각 화면이 이미 `ErrorState`/`NoticeBlock` 으로 말하고 있어서 여기서는 「당김이 실패했다」는
// 사실만 말한다. 인박스처럼 캐시된 항목 위에서 실패하면 화면에 다른 흔적이 없기 때문에 이 한 줄이 유일한 시각 신호다.
//
// **안내는 머리(로더가 서는 자리)가 아니라 화면의 레이아웃 안, 목록 바로 위에 선다**(훅이 돌려주는 `notice`).
// 머리의 자리는 `UIRefreshControl` 이 새로고침 중에만 열어 두는데, 그 「새로고침 중」이 곧 다음 당김을 막는다
// (컨트롤은 진행 중에는 `onRefresh` 를 다시 부르지 않는다). 안내가 머리에 머물려면 다음 당김을 막아야 하고, 안내가
// 「다음 당김까지」 남으려면 당김이 열려 있어야 한다 — 머리에서는 둘을 함께 만족할 수 없다. 그래서 실패는 새로고침을
// 끝내고(컨트롤이 닫히고, 다음 당김은 언제든 선다) 안내는 일반 고지처럼 목록 위에 남는다.
//
// 안내는 시간으로 사라지지 않는다. 사라지는 때는 셋이다:
//   1. **다음 당김이 선다**(`onRefresh`) — 새 새로고침이 시작되면 이전 실패를 말할 이유가 없다.
//   2. **성공 재조회** — 실패한 그 쿼리들이 다시 읽히면(소켓 재연결 뒤 재조회·화면의 「다시 시도」·백그라운드
//      재조회 어느 것이든) 안내는 거짓이 된다. 훅은 화면의 데이터를 모르므로 react-query 의 캐시를 본다: 이번 당김이
//      **다시 읽은** 쿼리(`failedQueryHashes`) 중 오류로 끝난 것을 적어 두고, 그것들이 **모두** 성공하면 거둔다.
//      오프라인 안내는 연결이 돌아오면 거둔다(「연결이 없어요」는 연결이 있으면 거짓이다).
//   3. **화면을 떠난다** — 언마운트이거나, 탭·층이 숨겨져 `active` 가 거짓이 된 때(탭 화면은 언마운트되지
//      않고 `display: none` 으로 숨는다). 화면 안에서 다루는 목록이 바뀌면(`resetKey`) 이전 목록의 실패도 거둔다.
//
// 오프라인이면 요청을 세우지 않는다: react-query 쿼리는 연결될 때까지 멈춰 있어서(`networkMode: 'online'`)
// 재조회가 끝나지 않고 로더가 영영 돌며 busy 가 남는다. 읽을 수 없다는 사실을 바로 실패로 전한다(문장은
// 「다시 당겨 보세요」 대신 연결을 말한다: 같은 처방이 같은 결과를 부르므로).
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

/** 안내가 접히는 데 걸리는 시간(ms). 짧아야 다음 당김의 손맛을 가리지 않는다. */
const COLLAPSE_MS = 180;

/**
 * 실패 안내를 세우기 전에 표준 컨트롤이 **다 닫히기를** 기다리는 시간(ms).
 *
 * 안내는 스크롤뷰 **위의 형제**라서 서고 걷힐 때 스크롤뷰의 프레임이 안내 높이(약 57pt)만큼 움직인다. 컨트롤이 열어 둔 자리(약
 * 60pt)가 닫히는 동안(약 270ms)에 안내를 같이 커밋하면 목록이 **한 프레임에 57pt 뛰고** 닫히는 움직임이 그 위에 겹친다
 * (iOS 26.5 시뮬레이터 영상을 120fps 로 디코드해 첫 행의 y 를 쟀다: 192 → 249 → 189, 한 프레임 +57). 닫힌 **뒤에** 세우면
 * 두 움직임이 이어서 일어난다: 닫힘 약 270ms(190 → 132) 다음 안내가 미끄러져 내려온다(133 → 189, 약 260ms).
 *
 * 닫혔는지는 스크롤이 넘침에서 돌아왔는지(`overscrollRef`)로 본다. 첫 확인은 닫힘이 끝날 만큼(`NOTICE_FIRST_MS`) 기다린 뒤이고,
 * 손가락이 아직 목록을 잡고 있으면(컨트롤은 손가락이 떨어져야 닫힌다) `NOTICE_POLL_MS` 마다 다시 본다. 닫힘을 본 뒤에도 한 번
 * 더 `NOTICE_POLL_MS` 를 쉰다: 닫힘의 마지막 레이아웃 커밋 바로 뒤에 세우면 레이아웃 전환이 그 커밋에 먹혀 미끄러지지 않고
 * 한 프레임에 뛰는 일이 있었다(닫힘 34ms 뒤 한 프레임 +57, 80ms 뒤 매끄러움). `NOTICE_MAX_WAIT_MS` 가 지나도 넘친 채면(스크롤
 * 이벤트를 놓친 화면 등) 그냥 세운다: 보이지 않는 실패가 영영 서지 않는 것이 더 나쁘다.
 */
const NOTICE_FIRST_MS = 350;
const NOTICE_POLL_MS = 100;
const NOTICE_MAX_WAIT_MS = 3000;

/** 접근성 낭독. 시스템 스피너를 감췄으므로 VoiceOver 가 듣는 「새로고침 중」은 이 한 번이다. */
const ANNOUNCE_REFRESHING = '새로고침 중';
/** 실패 안내 문장(목록 위에 서고 낭독된다). 오너 확정(2026-10-17): 이 문장 그대로다. */
const FAILED_COPY = '새로고침하지 못했어요. 다시 당겨 보세요.';
/** 오프라인이면 같은 처방(「다시 당겨 보세요」)이 같은 결과를 부르므로 연결을 말한다. 오너 확정: 그대로다. */
const OFFLINE_COPY = '연결이 없어요. 연결되면 다시 당겨 보세요.';

/** 목록에 펼치는 스크롤 props. 위성이 당긴 거리를 따라가도록 오프셋을 읽는 길이다. */
export type PullScrollProps = Pick<ScrollViewProps, 'onScroll' | 'scrollEventThrottle'>;

export interface PullRefreshOptions {
  /**
   * 이 화면이 지금 보이는가. 기본 true.
   *
   * 거짓이 되면 서 있던 실패 안내를 거둔다(「화면을 떠날 때까지」). 탭 화면과 층은 언마운트되지 않고 숨기만 해서
   * 언마운트로는 떠남을 알 수 없다 — `AppShell` 이 이미 `active` 를 아는 화면은 그 값을, 아니면 셸이 넘긴 값을 건다.
   */
  active?: boolean;
  /**
   * 이 화면이 다루는 목록이 바뀌는 열쇠(인박스의 탭, 작업의 필터…). 값이 바뀌면 서 있던 실패 안내를 거둔다:
   * 안내는 **이전 목록**의 당김이 실패했다는 말이라 다른 목록 위에서는 거짓이다.
   */
  resetKey?: unknown;
}

export interface PullRefresh {
  /** 목록의 `refreshControl` prop 에 그대로 넣는다. */
  refreshControl: React.ReactElement<RefreshControlProps>;
  /** 같은 목록에 펼친다: `{...scrollProps}`. 목록에 이미 `onScroll` 이 있으면 `withPullScroll` 로 합친다. */
  scrollProps: PullScrollProps;
  /**
   * 실패 안내 한 줄. **목록 바로 위, 레이아웃 안에 둔다**(`{notice}`): 목록 안이나 로더 머리가 아니라 화면의 고지
   * 자리다(위 「실패는 시각으로도 서고, 시간으로 사라지지 않는다」). 실패가 없으면 `null`.
   */
  notice: React.JSX.Element | null;
}

/** 서 있는 실패 안내와, 그것이 거짓이 되는 조건. */
interface Failure {
  copy: string;
  /** 이번 당김이 다시 읽은 쿼리 중 실패한 것들(`queryHash`). 모두 다시 읽히면 안내는 거짓이다. */
  queries: readonly string[];
  /** 연결이 없어서 요청을 세우지 않은 실패다. 연결이 돌아오면 거짓이다. */
  offline: boolean;
}

/** 실패가 어디서 왔는가. 상한에 걸린 것은 아직 도는 쿼리까지 「실패에 걸린 쿼리」로 본다. */
type FailureCause = 'result' | 'cap' | 'offline';

/**
 * 이번 당김이 **다시 읽은** 쿼리(`touched`) 중 실패한 것의 해시.
 *
 * 전체 캐시에서 「이번 당김 동안 오류가 난 쿼리」를 찾지 않는다: 같은 때에 다른 화면의 쿼리(설정·폴링 따위)가 오류가 나 있으면
 * 그것들을 기다리게 되고, 그 쿼리가 다시 읽히는 때는 이 화면과 무관해서 안내가 오래 남는다. 당김 동안 **읽기를 시작한** 쿼리만
 * 본다(`handleRefresh` 가 캐시 이벤트로 모은다): `refetch()`·`invalidateQueries()` 모두 쿼리의 읽기를 시작한다.
 *
 * 서버가 그 경로를 모른다고 답한 오류(`serverSaysAbsent`)는 다시 읽어도 낫지 않는 알려진 상태라(화면이 미제공으로 접는다) 기다릴
 * 대상이 아니다. 상한(20초)에 걸려 끝낸 당김은 쿼리가 아직 도는 중이라 오류가 없다 — 그때는 도는 쿼리를 대신 기다려 늦게 도착한
 * 성공이 안내를 거둔다.
 */
function failedQueryHashes(
  client: QueryClient | undefined,
  touched: ReadonlySet<string>,
  cause: FailureCause,
): string[] {
  if (client === undefined || cause === 'offline') return [];
  const cache = client.getQueryCache();
  return [...touched].filter(hash => {
    const query = cache.get(hash);
    if (query === undefined) return false;
    const state = query.state;
    const errored = state.status === 'error' && !serverSaysAbsent(state.error);
    return errored || (cause === 'cap' && state.fetchStatus === 'fetching');
  });
}

/**
 * 당겨서 새로고침 하나. 목록(또는 빈 상태)에 `refreshControl` 과 `scrollProps` 를 걸고, 목록 바로 위에 `notice` 를 둔다.
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
  options: PullRefreshOptions = {},
): PullRefresh {
  const {active = true, resetKey} = options;
  const queryClient = useContext(QueryClientContext);
  const reduceMotion = useReduceMotionRef();
  const [refreshing, setRefreshing] = useState(false);
  /** 손가락이 목록을 위로 넘겼다(또는 새로고침 중이다): 로더 머리를 그린다. */
  const [shown, setShown] = useState(false);
  /** 서 있는 실패 안내. 위 세 가지 중 하나가 일어날 때까지 남는다(시간으로는 사라지지 않는다). */
  const [failure, setFailure] = useState<Failure | null>(null);
  const failureRef = useRef<Failure | null>(null);
  /**
   * 화면에 그려지는 안내 문장. `failure` 가 사라져도 접히는 동안(`COLLAPSE_MS`)은 문장이 남는다: 접히는 틀 안에서 글자가 비지
   * 않게. 접힘이 끝나면 비운다.
   */
  const [shownCopy, setShownCopy] = useState<string | null>(null);
  const shownRef = useRef<string | null>(null);
  /** 안내가 접히는 중이다: 접히기 시작한 높이(pt). 아니면 null. 문장은 접히는 동안에도 그려진다. */
  const [collapsingFrom, setCollapsingFrom] = useState<number | null>(null);
  /** 마지막으로 잰 안내의 높이(pt). 접히는 움직임이 이 높이에서 시작한다. */
  const measuredRef = useRef<number | null>(null);
  /** 진행 중인 당김. 손가락이 두 번 당겨도 요청은 하나다. */
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const hapticVisit = useRef({active, resetKey, version: 0});
  if (hapticVisit.current.active !== active || !Object.is(hapticVisit.current.resetKey, resetKey)) {
    hapticVisit.current = {active, resetKey, version: hapticVisit.current.version + 1};
  }
  /** 최소 표시 창을 재는 타이머. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 재조회를 기다리는 시간의 상한 타이머. */
  const capRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 컨트롤이 닫히기를 기다렸다가 안내를 세우는 타이머(`NOTICE_FIRST_MS`). */
  const settleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 진행 중인 당김이 다시 읽는 쿼리를 모으는 캐시 구독의 해제 함수(`failedQueryHashes`). */
  const stopWatchingRef = useRef<(() => void) | undefined>(undefined);
  /** 당김 진행도 0~1. 오프셋이 음수일 때만 갱신한다(평소 스크롤은 건드리지 않는다). */
  const pull = useRef(new Animated.Value(0)).current;
  const overscrollRef = useRef(false);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      if (capRef.current !== undefined) clearTimeout(capRef.current);
      if (settleRef.current !== undefined) clearTimeout(settleRef.current);
      stopWatchingRef.current?.();
      stopWatchingRef.current = undefined;
    },
    [],
  );

  /**
   * 안내를 세우거나 거둔다.
   *
   * - 세울 때: 네이티브 레이아웃 전환(`LayoutAnimation`)을 한 번 얹는다(동작 줄이기에서는 바로). 컨트롤이 닫힌 뒤 한 번의 커밋이라
   *   목록이 안내 높이만큼 미끄러져 내려온다.
   * - 거둘 때: 틀을 바로 지우면 목록이 한 프레임에 57pt 뛴다. 다음 당김이 서는 순간은 손가락이 목록을 끌고 있는 때라 그 튐이
   *   손 아래에서 그대로 보인다(영상을 120fps 로 디코드해 쟀다: 한 프레임 −54). 그래서 **높이를 0 으로 접는다**
   *   (`CollapsingNotice`, `COLLAPSE_MS`). 이때는 `LayoutAnimation` 을 쓰지 않는다: 같은 접힘에 걸어 보았지만 손가락이 당기는
   *   동안에는 한 프레임에 뛰었다(−54, 전환이 먹지 않았다). 원인은 가르지 못했고, 높이를 JS 로 줄이는 쪽이 같은 영상에서 목록을
   *   미끄러뜨렸다(한 프레임 최대 −14). 동작 줄이기에서는 바로 지운다.
   */
  const setNotice = useCallback(
    (next: Failure | null) => {
      // 아직 서지 않은 안내(컨트롤이 닫히기를 기다리는 중)도 거둔다.
      if (next === null && settleRef.current !== undefined) {
        clearTimeout(settleRef.current);
        settleRef.current = undefined;
      }
      failureRef.current = next;
      setFailure(next);
      if (next !== null) {
        if (shownRef.current === null && !reduceMotion.current) {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        }
        shownRef.current = next.copy;
        setShownCopy(next.copy);
        setCollapsingFrom(null);
      } else if (shownRef.current !== null) {
        const from = measuredRef.current;
        if (reduceMotion.current || from === null || from <= 0) {
          shownRef.current = null;
          setShownCopy(null);
          setCollapsingFrom(null);
        } else {
          setCollapsingFrom(from);
        }
      }
    },
    [reduceMotion],
  );

  /** 접힘이 끝났다: 틀을 치운다(그 사이 새 안내가 섰으면 건드리지 않는다). */
  const onCollapsed = useCallback(() => {
    if (failureRef.current !== null) return;
    shownRef.current = null;
    setShownCopy(null);
    setCollapsingFrom(null);
  }, []);

  const handleRefresh = useCallback(() => {
    if (busyRef.current || !activeRef.current || !mountedRef.current) return;
    busyRef.current = true;
    // 임계 통과: 표준 컨트롤이 새로고침을 세우는 이 순간이 곧 햅틱이 울릴 때다(위 「햅틱」).
    haptics.event('refreshThreshold');
    const visit = hapticVisit.current.version;
    const resultHaptic = hapticScope(() => mountedRef.current && activeRef.current && hapticVisit.current.version === visit);
    // 다음 당김이 섰다: 이전 실패는 더 말하지 않는다(위 「안내는 시간으로 사라지지 않는다」 1).
    setNotice(null);
    setShown(true);
    setRefreshing(true);
    AccessibilityInfo.announceForAccessibility?.(ANNOUNCE_REFRESHING);
    /**
     * 이 당김이 다시 읽는 쿼리들(해시). 실패 안내가 기다릴 쿼리를 정한다. 읽기를 **시작한** 쿼리(캐시 이벤트)에 더해, 당김이 선 순간
     * 이미 **읽는 중이던** 쿼리도 넣는다: 데이터가 아직 없는 쿼리의 첫 읽기가 도는 중이면 `refetch()` 는 새 읽기를 시작하지 않고
     * 도는 읽기에 붙기 때문이다(react-query `fetch`).
     */
    const touched = new Set<string>();
    queryClient?.getQueryCache().getAll().forEach(query => {
      if (query.state.fetchStatus === 'fetching') touched.add(query.queryHash);
    });
    stopWatchingRef.current?.();
    stopWatchingRef.current = queryClient?.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && event.action.type === 'fetch') touched.add(event.query.queryHash);
    });
    const startedAt = Date.now();
    let finished = false;
    const finish = (
      isFailed: boolean,
      copy: string = FAILED_COPY,
      cause: FailureCause = 'result',
    ) => {
      if (finished) return; // 상한이 먼저 끝냈으면 늦게 온 답은 무시한다
      finished = true;
      stopWatchingRef.current?.();
      stopWatchingRef.current = undefined;
      if (capRef.current !== undefined) {
        clearTimeout(capRef.current);
        capRef.current = undefined;
      }
      // 쿼리가 막 오류로 끝난 이 시점의 캐시를 읽는다(최소 표시 창을 기다리는 사이에 바뀔 수 있다).
      const queries = isFailed ? failedQueryHashes(queryClient, touched, cause) : [];
      const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt));
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        if (!mountedRef.current) return;
        // 새로고침은 여기서 끝난다: 컨트롤이 닫혀야 다음 당김이 선다. 실패 안내는 머리가 아니라 목록 위에 남는다.
        busyRef.current = false;
        setRefreshing(false);
        if (!isFailed) return;
        // A result from a departed screen/app stays silent, including after returning.
        resultHaptic('refreshFailed');
        // 응답이 오기 전에 화면을 떠났으면(탭을 옮겼으면) 안내를 세우지 않는다: 돌아왔을 때 옛 실패가 서 있게 된다.
        if (!activeRef.current) return;
        // 안내는 컨트롤이 다 닫힌 뒤에 선다(위 `NOTICE_FIRST_MS`).
        const next: Failure = {copy, queries, offline: cause === 'offline'};
        const since = Date.now();
        /** 닫혔음을 한 번 봤다: 한 번 더 쉬고 세운다(위 `NOTICE_POLL_MS` 의 두 번째 이유). */
        let sawClosed = false;
        const tick = () => {
          settleRef.current = undefined;
          if (!mountedRef.current || !activeRef.current) return;
          const waiting = Date.now() - since < NOTICE_MAX_WAIT_MS;
          if (waiting && overscrollRef.current) {
            sawClosed = false;
            settleRef.current = setTimeout(tick, NOTICE_POLL_MS);
            return;
          }
          if (waiting && !sawClosed) {
            sawClosed = true;
            settleRef.current = setTimeout(tick, NOTICE_POLL_MS);
            return;
          }
          // 낭독은 안내가 서는 커밋과 같이 나간다(문장을 먼저 듣고 화면의 안내를 한참 뒤에 만나지 않게).
          AccessibilityInfo.announceForAccessibility?.(copy);
          setNotice(next);
        };
        settleRef.current = setTimeout(tick, NOTICE_FIRST_MS);
      }, wait);
    };
    // 오프라인이면 요청을 세우지 않는다(위 「실패는 시각으로도 서고」).
    if (!onlineManager.isOnline()) {
      finish(true, OFFLINE_COPY, 'offline');
      return;
    }
    capRef.current = setTimeout(() => finish(true, FAILED_COPY, 'cap'), MAX_WAIT_MS);
    // 동기로 던지는 재조회도 약속의 거부로 받는다.
    new Promise<unknown>(resolve => resolve(onRefresh())).then(
      result => finish(refreshFailed(result)),
      () => finish(true),
    );
  }, [onRefresh, queryClient, setNotice]);

  // 화면을 떠났다(탭·층이 숨었다): 서 있던 실패는 이 화면 사람에게 더 말하지 않는다.
  useEffect(() => {
    if (!active) setNotice(null);
  }, [active, setNotice]);

  // 다루는 목록이 바뀌었다: 이전 목록의 실패는 이 목록 위에서 거짓이다.
  const resetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (Object.is(resetKeyRef.current, resetKey)) return;
    resetKeyRef.current = resetKey;
    setNotice(null);
  }, [resetKey, setNotice]);

  // 성공 재조회: 안내가 말하는 실패가 풀리면 거둔다(위 「안내는 시간으로 사라지지 않는다」 2).
  useEffect(() => {
    if (failure === null) return undefined;
    const stops: Array<() => void> = [];
    if (failure.offline) {
      // 「연결이 없어요」는 연결이 있으면 거짓이다. 안내가 서기 전에 이미 돌아왔어도 같다.
      if (onlineManager.isOnline()) {
        setNotice(null);
        return undefined;
      }
      stops.push(
        onlineManager.subscribe(online => {
          if (online) setNotice(null);
        }),
      );
    }
    if (queryClient !== undefined && failure.queries.length > 0) {
      const cache = queryClient.getQueryCache();
      const waiting = new Set(failure.queries);
      // 안내가 서기 전에 이미 다시 읽힌(또는 캐시에서 사라진) 쿼리는 기다리지 않는다. 「읽힘」은 성공 상태이면서 **읽는 중이
      // 아닌** 것이다: 캐시된 데이터가 있는 쿼리는 재조회 중에도 `status` 가 `success` 라서, 상한(20초)에 걸려 아직 도는 쿼리를
      // 상태만 보고 빼면 안내가 서자마자 지워진다(검수 H1).
      for (const hash of [...waiting]) {
        const query = cache.get(hash);
        if (query === undefined || (query.state.status === 'success' && query.state.fetchStatus === 'idle')) {
          waiting.delete(hash);
        }
      }
      if (waiting.size === 0) {
        setNotice(null);
        return () => stops.forEach(stop => stop());
      }
      stops.push(
        cache.subscribe(event => {
          if (event.type === 'removed') {
            waiting.delete(event.query.queryHash);
          } else if (event.type === 'updated' && event.action.type === 'success') {
            waiting.delete(event.query.queryHash);
          } else {
            return;
          }
          if (waiting.size === 0) setNotice(null);
        }),
      );
    }
    return () => stops.forEach(stop => stop());
  }, [failure, queryClient, setNotice]);

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
          if (!busyRef.current) setShown(false);
        }
      },
    }),
    [pull],
  );

  // 새로고침이 끝나고 내용이 제자리로 돌아오면(오프셋이 0 이상) 머리를 걷는다.
  useEffect(() => {
    if (!refreshing && !overscrollRef.current) setShown(false);
  }, [refreshing]);

  const refreshControl = (
    <PullRefreshControl
      refreshing={refreshing}
      onRefresh={handleRefresh}
      shown={shown}
      pull={pull}
      testID={testID}
    />
  );
  const onMeasured = useCallback((height: number) => {
    measuredRef.current = height;
  }, []);
  const notice = useMemo(() => {
    if (shownCopy === null) return null;
    if (collapsingFrom !== null) {
      return <CollapsingNotice copy={shownCopy} from={collapsingFrom} onDone={onCollapsed} />;
    }
    return <PullNotice copy={shownCopy} onMeasured={onMeasured} />;
  }, [shownCopy, collapsingFrom, onCollapsed, onMeasured]);
  return {refreshControl, scrollProps, notice};
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
  pull,
  testID,
}: RefreshControlProps & {
  shown: boolean;
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
      {shown ? <PullHeader pull={pull} refreshing={refreshing} /> : null}
    </>
  );
}

/** 목록 위로 넘친 자리의 로더. 당김에 따라 나타나고(위성이 궤도를 돈다), 새로고침이 서면 그 자세에서 돈다. */
function PullHeader({
  pull,
  refreshing,
}: {
  pull: Animated.Value;
  refreshing: boolean;
}): React.JSX.Element {
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
      // 시스템 스피너를 감췄으므로 이 띠가 「지금 새로고침 중」이라는 말을 진다. 로더 자신은 장식이다.
      // (실패는 이 띠가 아니라 목록 위의 안내 `PullNotice` 가 진다.)
      accessible={refreshing}
      accessibilityRole="progressbar"
      accessibilityLabel={ANNOUNCE_REFRESHING}
      accessibilityState={{busy: refreshing}}
      style={headerStyle}
      testID="pull-refresh-header">
      <OortLoader
        size={PULL_LOADER_SIZE}
        progress={pull}
        spinning={refreshing || spun.current}
        testID="pull-refresh-loader"
      />
    </Animated.View>
  );
}

/**
 * 실패 안내 한 줄. 목록 위의 고지 자리에 서는 상자다.
 *
 * 모양은 화면이 이미 쓰는 지속 실패 배너(`FailureBanner`: 작업·팀 보드의 「새로 불러오지 못했어요」)와 같은 어휘다 —
 * `dangerSurface` 바탕, `dangerBorder` 테두리, `dangerText` 글자 — 같은 일에 서로 다른 모양이 둘 생기지 않게.
 * 다만 줄 높이를 고정하지 않는다(`FailureBanner` 는 20 으로 고정): 글자가 Dynamic Type 으로 자라도 줄이
 * 겹치지 않고 글자 크기를 따른다. 낱말 가운데서 끊지 않는다(`NoticeBlock` 과 같은 이유: 한글 어절 우선 줄바꿈).
 *
 * 이름은 문장 그대로이고 역할은 alert 다. 서는 순간의 낭독은 훅이 따로 한다.
 */
function PullNotice({
  copy,
  onMeasured,
}: {
  copy: string;
  onMeasured: (height: number) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={copy}
      onLayout={event => onMeasured(event.nativeEvent.layout.height)}
      style={styles.noticeWrap}
      testID="pull-refresh-notice">
      <NoticeBox copy={copy} />
    </View>
  );
}

function NoticeBox({copy}: {copy: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.notice}>
      <Text
        style={styles.noticeText}
        lineBreakStrategyIOS="hangul-word"
        testID="pull-refresh-failed">
        {copy}
      </Text>
    </View>
  );
}

/**
 * 접히는 안내. 같은 모양으로 높이만 `from` 에서 0 으로 줄인다(`COLLAPSE_MS`, JS 가 프레임마다 민다).
 * 높이가 바뀌는 동안 스크롤뷰의 프레임이 프레임마다 위로 올라와서 목록이 미끄러져 올라간다: 한 번에 지우면 목록이 손 아래에서 뛴다.
 * 접히는 동안은 보조기술에서 숨는다(곧 사라질 문장을 읽지 않는다).
 */
function CollapsingNotice({
  copy,
  from,
  onDone,
}: {
  copy: string;
  from: number;
  onDone: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 첫 그림이 이미 `from` 이다: 이 요소는 접히기 시작하는 때에 선다(`PullNotice` 와 모양이 같아 눈에는 이어진다).
  const height = useRef(new Animated.Value(from)).current;
  useEffect(() => {
    const animation = Animated.timing(height, {
      toValue: 0,
      duration: COLLAPSE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({finished}) => {
      if (finished) onDone();
    });
    return () => animation.stop();
  }, [height, onDone]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.noticeClip, {height}]}
      testID="pull-refresh-notice-collapsing">
      <View style={styles.noticeWrap}>
        <NoticeBox copy={copy} />
      </View>
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
    // 바깥 여백은 `FailureBanner` 를 두는 화면의 `bannerWrap`(좌우 거터, 위아래 `space.sm`)과 같다.
    noticeWrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
    // 접히는 안내의 틀: 줄어드는 높이 밖은 가린다.
    noticeClip: {overflow: 'hidden'},
    notice: {
      borderRadius: radius.md,
      padding: space.md,
      backgroundColor: color.dangerSurface,
      borderWidth: 1,
      borderColor: color.dangerBorder,
    },
    noticeText: {fontSize: font.label, color: color.dangerText, fontWeight: '500'},
  });
