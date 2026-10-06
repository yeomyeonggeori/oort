import {Easing} from 'react-native';

// =============================================================================
// 움직임 값 — 한 곳에서 이름으로 (#3580, emil `animate-expo` §5).
//
// 근사값을 쓰지 않는다: 곡선과 시간은 이 표에서만 온다. 코어 `Animated` +
// `useNativeDriver` 로 transform·opacity 만 움직이므로 JS 스레드가 바빠도 돈다
// (Reanimated 는 들이지 않았다 — PR 본문 「왜 Reanimated 가 아닌가」).
// =============================================================================

/** UI 진입·퇴장의 강한 ease-out. `ease-in` 은 쓰지 않는다 — 보는 순간을 늦춘다. */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** 탭 콘텐츠가 드러나는 시간. 하루 수백 번 보는 전환이라 150ms 를 넘기지 않는다. */
export const TAB_FADE_MS = 150;
