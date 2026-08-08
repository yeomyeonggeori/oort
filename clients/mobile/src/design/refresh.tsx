import React, {useCallback, useEffect, useRef, useState} from 'react';
import {RefreshControl, type RefreshControlProps} from 'react-native';
import {usePalette} from './theme';

// =============================================================================
// 당겨서 새로고침 (goal RN-B4b / #1026)
//
// 성재 파이널 체크: 에이전트 탭을 당겼는데 아무 일도 일어나지 않았다.
//
// 목록을 당기는 것은 배운 동작이 아니라 **기대**다. 화면에 보이는 것이 낡았을지도
// 모른다고 의심하는 순간 사람의 손은 이미 아래로 내려가 있고, 그때 아무 일도
// 일어나지 않으면 남는 결론은 「이 목록은 원래 이렇다」다 — 실제로는 15초 뒤에
// 저절로 맞춰질 화면이어도 그렇다.
//
// ## 새 fetch 경로를 만들지 않는다
//
// 각 표면은 이미 자기를 다시 읽는 법을 알고 있다(`refetch`/`invalidateQueries`).
// 당김은 **그것을 부르는 새 입구**일 뿐이고, 두 번째 조회 경로가 되어서는 안 된다 —
// 그렇게 되는 순간 「화면이 말하는 것」과 「당기면 나오는 것」이 서로 다른 코드에서
// 오게 되고, 둘이 어긋나는 날 어느 쪽이 진실인지 말할 수 있는 사람이 없다.
//
// ## 스피너에 바닥을 깔아 두는 이유
//
// 캐시가 따뜻하면 `invalidateQueries` 는 한 프레임 안에 끝난다. 그 경우 스피너는
// 나타났다는 사실조차 눈에 남기지 못하고 사라지고, 사람이 얻는 정보는 「아무 일도
// 안 일어났다」로 **결함과 같은 모양**이 된다. 그래서 최소 표시 창을 둔다. 이것은
// 가짜 진행률이 아니라 **응답의 확인**이다 — 데이터는 이미 새 것이고, 남는 것은
// 그 사실을 사람이 볼 수 있게 하는 시간뿐이다.
// =============================================================================

/**
 * 스피너가 눈에 남는 최소 시간(ms).
 *
 * 250ms 는 「깜빡였다」이고 600ms 는 「느리다」다. 그 사이에서, iOS 의 당김 제스처가
 * 손을 떼고 스크롤뷰가 제자리로 돌아오는 데 걸리는 시간과 같은 크기로 잡았다.
 */
const MIN_VISIBLE_MS = 450;

/**
 * 표준 `RefreshControl` 하나. 목록의 `refreshControl` prop 에 그대로 넣는다.
 *
 * 훅이 엘리먼트를 돌려주는 것은 `RefreshControl` 이 자식이 아니라 **prop 으로만**
 * 받아들여지기 때문이다. 상태(`refreshing`)와 그 상태를 내리는 규칙이 이 파일 하나에
 * 있어야 세 표면이 같은 속도로 같은 것을 말한다.
 *
 * @param onRefresh 이미 있는 재조회. 프로미스를 돌려주면 그것이 끝날 때까지 스피너가
 *   돈다. `void` 를 돌려주는 재조회(=fire-and-forget invalidate)도 받는다 — 그때
 *   스피너는 최소 표시 창만큼만 돌고, 그 이상을 아는 척하지 않는다.
 */
export function useRefreshControl(
  onRefresh: () => Promise<unknown> | void,
  testID?: string,
): React.ReactElement<RefreshControlProps> {
  const [refreshing, setRefreshing] = useState(false);
  /** 진행 중인 당김. 손가락이 두 번 당겨도 요청은 하나다. */
  const busyRef = useRef(false);
  const palette = usePalette();
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleRefresh = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRefreshing(true);
    const startedAt = Date.now();
    const settle = () => {
      const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt));
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        busyRef.current = false;
        if (mountedRef.current) setRefreshing(false);
      }, wait);
    };
    // 실패해도 스피너는 내려온다. 당김은 결과를 말하는 자리가 아니다 — 무엇이
    // 잘못됐는지는 화면이 이미 `ErrorState`/`NoticeBlock` 으로 말하고 있고, 여기서
    // 두 번째 목소리를 내면 그 둘이 서로를 덮는다.
    Promise.resolve(onRefresh()).then(settle, settle);
  }, [onRefresh]);

  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={handleRefresh}
      // 시스템 표준 스피너에 토큰 색 하나. iOS 는 `tintColor` 만 읽는다.
      tintColor={palette.textFaint}
      testID={testID}
    />
  );
}
