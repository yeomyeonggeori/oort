import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, type LayoutChangeEvent} from 'react-native';

// =============================================================================
// 영수증을 닫으면 그 자리에 다른 단추가 올라온다 (ADR-0177 증보 2026-11-14 D21, #5826 design-review r1 M5).
//
// 홈 목록 위의 영수증(알림 탭 영수증 · 「대화에서 나갔어요.」)은 X 로 닫고, 닫히면 그 아래 목록이 영수증 높이만큼 **올라온다** - 방금 X 가 있던 자리에
// 홈의 「업데이트」 단추(또는 목록의 첫 줄)가 온다. X 를 두 번 누르는 손가락의 둘째 탭이 그 단추를 누른다.
//
// 자리를 겹치지 않게 하는 길(영수증을 목록 밖에 띄움)은 홈의 위계를 바꾸므로, **닫은 직후 잠깐 그 자리의 눌림을 받지 않는** 쪽을 골랐다:
// 닫는 순간 영수증이 있던 칸(홈 화면 좌표)을 투명한 막이 `NOTICE_DISMISS_GUARD_MS` 동안 덮는다. 레이아웃은 그대로 접히고(움직임 변화 없음),
// 사람이 일부러 다시 누르는 데는 0.45초면 넘는다. 두 고지가 한 막을 쓴다.
// =============================================================================

/** 영수증을 닫은 뒤 그 자리가 눌림을 받지 않는 시간(ms). 두 번 누름의 간격(대개 300ms 안)보다 길고 일부러 다시 누르는 데보다 짧다. */
export const NOTICE_DISMISS_GUARD_MS = 450;

// 막은 목록보다 먼저 그려지는 형제라, 겹침 순서를 올리지 않으면 목록 머리의 단추가 눌림을 먼저 받는다(design-review r2).
const COVER = {position: 'absolute', left: 0, right: 0, zIndex: 1} as const;

interface Rect {
  y: number;
  height: number;
}

export function useNoticeDismissGuard(): {
  /** 고지들을 감싼 칸(홈의 `noticeWrap`)에 건다 - 그 칸의 홈 화면 y 를 안다. */
  wrapProps: {onLayout: (event: LayoutChangeEvent) => void};
  /** 닫을 수 있는 고지를 감싸 그 칸의 자리를 잰다. 감싸는 칸은 레이아웃에 영향이 없다(자식 하나). */
  measured: (key: string, node: React.ReactNode) => React.JSX.Element;
  /** 닫기 콜백에 막을 세운다. `dismiss` 가 없으면 없다. */
  dismissing: (key: string, dismiss: (() => void) | undefined) => (() => void) | undefined;
  /** 막. 홈 화면의 직접 자식으로 그린다(없으면 `null`). */
  guard: React.JSX.Element | null;
} {
  const wrapY = useRef(0);
  const rects = useRef(new Map<string, Rect>());
  const [cover, setCover] = useState<{top: number; height: number} | null>(null);
  useEffect(() => {
    if (cover === null) return undefined;
    const timer = setTimeout(() => setCover(null), NOTICE_DISMISS_GUARD_MS);
    return () => clearTimeout(timer);
  }, [cover]);
  const measured = useCallback(
    (key: string, node: React.ReactNode) => (
      <View
        onLayout={event => {
          const {y, height} = event.nativeEvent.layout;
          rects.current.set(key, {y, height});
        }}
        testID={`${key}-slot`}>
        {node}
      </View>
    ),
    [],
  );
  const dismissing = useCallback(
    (key: string, dismiss: (() => void) | undefined) =>
      dismiss === undefined
        ? undefined
        : () => {
            const rect = rects.current.get(key);
            if (rect !== undefined) setCover({top: wrapY.current + rect.y, height: rect.height});
            dismiss();
          },
    [],
  );
  return {
    wrapProps: {
      onLayout: event => {
        wrapY.current = event.nativeEvent.layout.y;
      },
    },
    measured,
    dismissing,
    guard:
      cover === null ? null : (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          pointerEvents="auto"
          style={[COVER, {top: cover.top, height: cover.height}]}
          testID="notice-dismiss-guard"
        />
      ),
  };
}
