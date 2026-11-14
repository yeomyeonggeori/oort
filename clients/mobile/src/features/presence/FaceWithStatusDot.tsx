import React from 'react';
import {View} from 'react-native';
import type {StatusDot as StatusDotModel} from '@momo/core/features/presence/statusDot';
import {FaceStatusDot} from './StatusDot';

// =============================================================================
// 얼굴 모서리에 앉는 상태 점 (#4692). 홈 DM 줄이 이미 하는 일(`SidebarScreen` 의 `face` + `FaceStatusDot`)을 다른
// 사람 표면(새 DM 시트, 프로필 시트)이 같은 모양으로 하도록 공용으로 둔 것이다. 점이 없으면(모르면) 얼굴을 그대로
// 돌려주므로 점 없는 줄의 구조는 바뀌지 않는다. 점이 있어도 상자가 얼굴 크기라 얼굴의 자리는 움직이지 않는다.
//
// 보조기술에는 나가지 않는다(`FaceStatusDot` 이 숨는다): 줄/시트의 접근 가능한 이름이 낱말(`dot.label`)을 이어 말한다.
// =============================================================================

export function FaceWithStatusDot({
  face,
  size,
  dot,
  testID = 'face-status-dot',
}: {
  face: React.ReactNode;
  /** 얼굴의 한 변(pt). 점의 크기가 여기서 정해지고, 점은 이 상자의 오른쪽 아래 모서리에 앉는다. */
  size: number;
  dot: StatusDotModel | null;
  testID?: string;
}): React.JSX.Element {
  if (dot === null) return <>{face}</>;
  return (
    <View style={{width: size, height: size}}>
      {face}
      {/* 점의 크기·자리는 얼굴 크기에서 정해진다(`FaceStatusDot`, #5786): 색 점의 바깥 끝이 얼굴 상자의 오른쪽 아래에
          닿고, 면색 고리(틈)만 상자 밖으로 나간다. 홈 줄·대화 머리도 같은 부품이다. */}
      <FaceStatusDot face={size} tone={dot.tone} testID={testID} />
    </View>
  );
}

