import React from 'react';
import {StyleSheet, View} from 'react-native';

import {usePalette} from '../src/design/theme';
import {SettingsPage} from '../src/features/profile/SettingsPage';

/**
 * 설정 표면이 쓰는 **가상 인물**. 이 표면들의 캡처는 PR 증거로 레포에 남고 레포는 공개라서, 하네스의 기존 `SELF`
 * 페르소나(실명)를 그대로 싣지 않는다(2026-10-23 규칙: 시험 fixture·계측 표면·캡처에 실명 금지). 명부의 내 행과
 * `member` 둘 다 이 인물로 바꿔야 얼굴·이름이 같은 사람으로 선다.
 */
export const SETTINGS_PERSONA = {displayName: '이도현', handle: 'dohyun'} as const;

/** 명부에서 내 행의 이름·핸들만 가상 인물로 바꾼다 — 나머지 행과 모양은 그대로다. */
export function settingsPersona<T extends {id: string; displayName?: string; handle?: string}>(
  roster: readonly T[],
  selfId: string,
): T[] {
  return roster.map(row => (row.id === selfId ? {...row, ...SETTINGS_PERSONA} : row));
}

/**
 * #4457: 옛 `ProfileSheet` 의 자리. 「설정」은 셸의 층(`nav.settings`)이라 하네스는 셸 위에 전체 화면을
 * 불투명하게 덮어 세운다(층의 `overlay` 와 같은 모양). 앱의 층은 `EdgeSwipeBack` 이 이 자리를 맡는다.
 *
 * 첫 장은 바깥 층(`EdgeSwipeBack`)을 거치지 않으니 올라오는 움직임이 없다. **안쪽 장**(`initialPage`)은 `SettingsPage`
 * 안의 `EdgeSwipeBack` 이라 마운트 때 오른쪽에서 밀려 들어온다 — 캡처는 늘 충분히(7초 이상) 기다린 뒤 다 선 모양을 찍는다.
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
