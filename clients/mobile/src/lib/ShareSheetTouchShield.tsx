import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useShareSheetHeld} from './shareSheet';

// =============================================================================
// 공유 시트가 떠 있는 동안 뒤 화면으로 새는 터치를 삼키는 판 (#5207). 왜 필요한지는 `shareSheet.ts` 머리말이 말한다.
//
// 셸(`AppShell`)의 맨 위에 **한 번** 선다 — 화면·시트·탭바 모두의 위다. 평소(시트가 없을 때)는 아무것도 그리지 않는다. 서 있는 동안은 화면 전체를 덮는 뷰가 터치를
// 받아서 아래의 어떤 눌림·스크롤·길게 누르기에도 터치가 닿지 않는다. 시트를 닫는 UIKit 의 길은 그대로다(막이는 RN 쪽으로 새는 터치만 막는다).
//
// 무엇이 일을 하는가(시뮬레이터 실측, `maestro/5207-share-sheet.yaml` 의 사보타주): **이 뷰가 터치를 받는 것**이 전부다. `pointerEvents="none"` 으로 바꾸면 막이가 서 있어도
// 탭이 샌다(RED). 반대로 `collapsable={false}`·`onStartShouldSetResponder` 를 빼도 결과는 같았다 — 히트 테스트가 이미 이 뷰를 고르고, `testID` 가 있는 뷰는 평탄화되지도 않는다.
// 둘은 「터치를 받는 네이티브 뷰」라는 의도를 코드에 남기는 선언이라 둔다(효과를 주장하지 않는다).
//
// **형제 오버레이**다 — 화면을 감싸 `pointerEvents` 를 바꾸는 래퍼가 아니다. 래퍼 모양은 시트가 열릴 때 트리의 모양이 바뀌어 아래 화면 전체(대화 목록 포함)를 다시 세울 수 있다: 같은 자리의 요소
// 종류가 바뀌면 React 는 그 아래를 통째로 내렸다 세운다 — #4949 가 잰 것과 같은 부류다(래퍼는 만들어 보지 않았다, 이것은 추론이다). 형제는 자기만 서고 걷힌다. 형제가 서고 걷혀도 목록이 다시
// 서지 않는다는 것은 `timelineShareSheet.test.tsx` 가 잰다.
//
// RN `Modal` 은 자기 네이티브 창이라 이 판이 덮지 못한다 — `Modal` 안에서 시트가 열릴 수 있는 표면은 자기 안에 이 판을 한 번 더 세운다.
// =============================================================================

const swallow = (): boolean => true;

/** 화면 전체를 덮는 `absoluteFill` 에 얹어 다른 모든 것 위에 세운다. 색이 없어 팔레트와 무관하다 — `useStyles` 없이 상수로 둔다(`themeSwitch.test.tsx` 가 `src/` 의 즉시 `StyleSheet.create` 를 막는다). */
const SHIELD_STYLE = {zIndex: 1000} as const;

export function ShareSheetTouchShield(): React.JSX.Element | null {
  const held = useShareSheetHeld();
  if (!held) return null;
  return (
    <View
      collapsable={false}
      onStartShouldSetResponder={swallow}
      style={[StyleSheet.absoluteFill, SHIELD_STYLE]}
      testID="share-sheet-touch-shield"
    />
  );
}
