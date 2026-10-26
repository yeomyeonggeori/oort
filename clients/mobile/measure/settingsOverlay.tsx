import React from 'react';
import {StyleSheet, View} from 'react-native';

import {usePalette} from '../src/design/theme';
import {SettingsPage} from '../src/features/profile/SettingsPage';

/**
 * #4457: 옛 `ProfileSheet` 의 자리. 「설정」은 셸의 층(`nav.settings`)이라 하네스는 셸 위에 전체 화면을
 * 불투명하게 덮어 세운다(층의 `overlay` 와 같은 모양). 앱의 층은 `EdgeSwipeBack` 이 이 자리를 맡는다.
 *
 * **진입 모션은 없다** — 하네스는 `EdgeSwipeBack` 을 거치지 않으니 캡처는 늘 다 선 모양이다(움직이는 도중을 찍지 않는다).
 */
export function SettingsOverlay(
  props: React.ComponentProps<typeof SettingsPage>,
): React.JSX.Element {
  const palette = usePalette();
  return (
    <View style={[StyleSheet.absoluteFill, {backgroundColor: palette.bg}]}>
      <SettingsPage {...props} />
    </View>
  );
}
