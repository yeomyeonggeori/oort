import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type MutableRefObject,
} from 'react';
import {AccessibilityInfo} from 'react-native';

// =============================================================================
// iOS 「동작 줄이기」 — 앱 수준 저장소 (#4293, design-review r2 M-1).
//
// 시스템의 답을 **앱이 한 번 읽어 간직하고**, 설정이 바뀌면 그 값을 고친다. 아래 훅은 그 값을
// 보기만 한다. 훅마다 마운트 때 새로 묻던 앞 판에서는 「한 번 서고 마는 화면」이 모르는 채로
// 시작했다: 사진 뷰어 Modal 은 첫 렌더의 `animationType` 으로 이미 떠 버리므로(시스템의 답은 한 틱
// 뒤에 온다), 동작 줄이기를 켠 사람이 사진을 열 때마다 시스템 페이드를 보았다.
//
// 저장소는 **붙드는 쪽이 있는 동안만** 산다(참조 수).
//   · 앱은 시작 때 하나를 붙든다(`App.tsx`) — 앱이 사는 동안 값이 남고, 새로 마운트되는 화면이
//     이미 아는 상태로 시작한다.
//   · 훅도 마운트되어 있는 동안 하나씩 붙든다 — 앱 트리 밖에서(시험·캡처 표면) 쓰여도 새지 않고,
//     마지막 소비자가 내려가면 구독을 풀고 값을 버린다(다음 소비자가 새로 읽는다).
// =============================================================================

/** 아는 값. `null` 은 아직 모른다(첫 답이 오기 전·읽기 실패). */
let known: boolean | null = null;
let holders = 0;
/** 시작·정지마다 올린다 — 정지 뒤 늦게 도착한 답이 새 저장소의 값을 덮지 않게 한다. */
let epoch = 0;
let stopListening: (() => void) | null = null;
const watchers = new Set<() => void>();

function publish(value: boolean): void {
  if (known === value) return;
  known = value;
  for (const watcher of [...watchers]) watcher();
}

function start(): void {
  const mine = ++epoch;
  let heard = false;
  AccessibilityInfo.isReduceMotionEnabled().then(
    value => {
      // 변경 알림이 먼저 도착했다면 그쪽이 더 새 값이다.
      if (mine === epoch && !heard) publish(value);
    },
    () => {
      /* 모름은 모름으로 남는다 */
    },
  );
  const subscription = AccessibilityInfo.addEventListener(
    'reduceMotionChanged',
    value => {
      if (mine !== epoch) return;
      heard = true;
      publish(value);
    },
  );
  stopListening = () => subscription.remove();
}

function stop(): void {
  epoch += 1;
  stopListening?.();
  stopListening = null;
  known = null;
}

/**
 * 저장소를 붙든다. 하나라도 붙든 동안 시스템의 답을 한 번 읽어 간직하고 변경을 구독한다. 돌려주는
 * 함수로 놓는다(여러 번 불러도 한 번만 놓인다). 앱의 뿌리가 시작 때 붙든다.
 */
export function retainReduceMotion(): () => void {
  if (holders++ === 0) start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0) stop();
  };
}

/**
 * 앱의 뿌리가 쓴다: 마운트되어 있는 동안 저장소를 붙든다(위 머리말). 앱이 시작할 때 한 번 읽고
 * 앱이 사는 동안 값을 간직하므로, 새로 마운트되는 화면이 모르는 채로 시작하지 않는다.
 */
export function useRetainReduceMotion(): void {
  useEffect(() => retainReduceMotion(), []);
}

/** 붙들고 값이 바뀔 때 알린다. `useSyncExternalStore` 의 구독 자리. */
function watch(onChange: () => void): () => void {
  const release = retainReduceMotion();
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
    release();
  };
}

const peek = (): boolean | null => known;

/**
 * iOS 「동작 줄이기」가 켜져 있는가 (#1892), **읽을 때의 값**으로.
 *
 * 웹 타임라인은 점프 스크롤을 `prefers-reduced-motion` 에 따라 즉시/부드럽게
 * 가른다(`timelineScrollBehavior`). 폰의 같은 자리는 이 값을 본다. 설정은 앱이
 * 떠 있는 동안에도 바뀌므로 구독한다.
 *
 * 상태가 아니라 ref 인 이유 (design-review 2594 R1 N-1): 이 값을 읽는 곳은 점프를
 * **누르는 순간**뿐이고, 값이 바뀌어도 다시 그릴 것이 없다. 첫 판은 상태였고, 첫
 * 답이 비동기로 도착할 때마다 목록 전체를 한 번 다시 그렸다 — 테스트에서는 그것이
 * act 밖의 갱신 경고로 드러났고, 그 소음이 진짜 act 경고를 가렸다.
 *
 * 처음 답이 오기 전에는 `false` 다 — 모르는 동안 움직임을 빼는 것보다, 한 번의
 * 점프가 부드럽게 도는 쪽이 덜 놀랍다. 답은 한 틱 안에 온다. 앱이 이미 아는 값이 있으면(위 저장소)
 * 처음부터 그 값이다.
 */
export function useReduceMotionRef(): MutableRefObject<boolean> {
  const reduce = useRef(known ?? false);
  useEffect(() => {
    const follow = () => {
      if (known !== null) reduce.current = known;
    };
    const stopWatching = watch(follow);
    follow(); // 앱이 이미 아는 값이 있으면 지금 따른다
    return stopWatching;
  }, []);
  return reduce;
}

/**
 * 「동작 줄이기」를 **상태로** (DS2-3 #2715). 계속 도는 움직임(홈 카드의 「작업 중」
 * 맥박)은 설정이 바뀌는 순간 멈추거나 다시 돌아야 하므로 ref 가 아니라 다시 그리는
 * 값이어야 한다 — `useReduceTransparency` 와 같은 이유다.
 *
 * 첫 답이 오기 전에는 `true` 다. 위의 ref 판과 반대인 이유: 저것은 한 번의 점프이고,
 * 이것은 끝없이 반복되는 움직임이다. 모르는 한 틱 동안 멈춰 있는 것은 아무도 해치지
 * 않지만, 동작을 줄여 달라고 한 사람에게 한 틱이라도 맥박을 보이는 것은 해친다.
 *
 * `whileUnknown` 은 그 **모르는 동안의 값**이다(#4293). 맥박처럼 끝없이 도는 움직임은 기본값
 * `true` 가 맞지만, 한 번 서는 화면의 시작 모양을 정하는 자리(사진 뷰어 Modal 의
 * `animationType`)에서는 `true` 가 모두의 첫 모습을 바꾼다 — 답은 한 틱 뒤에 오는데
 * Modal 은 첫 렌더의 값으로 이미 떠 버린다. 그런 자리는 `false` 를 넘긴다.
 */
export function useReduceMotion(whileUnknown: boolean = true): boolean {
  // 앱이 이미 아는 값이 있으면 첫 렌더부터 그 값이다 — `whileUnknown` 은 정말 모를 때만 쓴다.
  return useSyncExternalStore(watch, peek) ?? whileUnknown;
}
