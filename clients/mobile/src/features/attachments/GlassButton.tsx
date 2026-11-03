import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { GlassSurface } from '../../design/glass';
import { useStyles } from '../../design/theme';
import { radius, type Palette } from '../../design/tokens';
import { LAYOUT } from './videoDesign';
import { VIEWER, VIEWER_GLASS_TONE, VIEWER_STAGE } from './viewerDesign';

/**
 * 둥근 유리 단추. 누르는 면(`Pressable`)이 지름 44 를 다 채우고, 유리·가는 테두리는 그 뒤·위에 그려진다. 유리의 톤은 테마와
 * 무관하게 어둡다(`VIEWER_GLASS_TONE`) — 밝은 사진 위에서도 흰 글리프가 선다.
 *
 * `AttachmentViewer.tsx` 에서 옮겨 왔다(#5208): 영상 재생 조작(`VideoControls.tsx`)이 같은 단추를 쓰는데, 뷰어 파일이 그 조작을
 * 부르므로 단추가 뷰어 안에 있으면 두 파일이 서로를 부르는 순환이 된다. 본문은 그대로다.
 */
export function GlassButton({
  label,
  hint,
  onPress,
  disabled,
  testID,
  children,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const glassTestID = `${testID}-glass`;
  return (
    <GlassSurface
      radius={VIEWER.control / 2}
      tone={VIEWER_GLASS_TONE}
      style={styles.glassCircle}
      testID={glassTestID}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={disabled ? { disabled: true } : undefined}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.glassHit,
          pressed && styles.glassPressed,
        ]}
        testID={testID}
      >
        {children}
      </Pressable>
      {/* 가는 테두리 — 유리 위·누르는 면 위에 그려 눌림 채움이 테두리를 덮지 않는다. 닿지 않는다. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.glassRing]}
      />
    </GlassSurface>
  );
}

const buildStyles = (_color: Palette) =>
  StyleSheet.create({
    glassCircle: { width: VIEWER.control, height: VIEWER.control },
    glassHit: {
      width: VIEWER.control,
      height: VIEWER.control,
      minWidth: VIEWER.control,
      minHeight: VIEWER.control,
      ...LAYOUT.centered,
      borderRadius: radius.pill,
    },
    glassPressed: { backgroundColor: VIEWER_STAGE.pressedFill },
    glassRing: {
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: VIEWER_STAGE.glassBorder,
    },
  });
