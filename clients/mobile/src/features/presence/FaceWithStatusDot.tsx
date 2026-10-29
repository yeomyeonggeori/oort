import React from 'react';
import {View, type ViewStyle} from 'react-native';
import type {StatusDot as StatusDotModel} from '@momo/core/features/presence/statusDot';
import {StatusDot} from './StatusDot';

// =============================================================================
// 얼굴 모서리에 앉는 상태 점 (#4692). 홈 DM 줄이 이미 하는 일(`SidebarScreen` 의 `face` + `statusAnchor`)을 다른
// 사람 표면(새 DM 시트, 프로필 시트)이 같은 모양으로 하도록 공용으로 둔 것이다. 점이 없으면(모르면) 얼굴을 그대로
// 돌려주므로 점 없는 줄의 구조는 바뀌지 않는다. 점이 있어도 상자가 얼굴 크기라 얼굴의 자리는 움직이지 않는다.
//
// 보조기술에는 나가지 않는다(`StatusDot` 이 숨는다): 줄/시트의 접근 가능한 이름이 낱말(`dot.label`)을 이어 말한다.
// =============================================================================

export function FaceWithStatusDot({
  face,
  size,
  dot,
  testID = 'face-status-dot',
}: {
  face: React.ReactNode;
  /** 얼굴의 한 변(pt). 점은 이 상자의 오른쪽 아래 모서리에 걸친다. */
  size: number;
  dot: StatusDotModel | null;
  testID?: string;
}): React.JSX.Element {
  if (dot === null) return <>{face}</>;
  return (
    <View style={{width: size, height: size}}>
      {face}
      <View style={ANCHOR}>
        <StatusDot tone={dot.tone} testID={testID} />
      </View>
    </View>
  );
}

// 점의 바깥 지름의 절반쯤 얼굴 밖으로 나가 모서리에 걸친다(홈 줄의 `statusAnchor` 와 같은 자리). 색이 없는 배치
// 값이라 모듈 수준 스타일 시트를 만들지 않는다: 그런 상수는 import 시점에 굳어 테마가 바뀌어도 한 벌로 남는다는
// 이유로 `themeSwitch.test.tsx` 가 막는다(색이 있는 스타일은 `useStyles` 로 팔레트를 받는다).
const ANCHOR: ViewStyle = {position: 'absolute', right: -2, bottom: -2};

