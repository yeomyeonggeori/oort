import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ATTACH_COPY} from '@momo/core/features/attachments/model';

import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';

export function AttachmentPickerSheet({
  visible,
  onDismissed,
  onClose,
  onPickPhoto,
  onPickFile,
}: {
  visible: boolean;
  /** Modal이 실제로 사라진 뒤(iOS onDismiss). picker 제시는 이 뒤여야 한다. */
  onDismissed?: () => void;
  onClose: () => void;
  onPickPhoto: () => void;
  onPickFile: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={onDismissed}
      testID="attachment-picker-sheet"
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel={`${ATTACH_COPY.attach} 닫기`}
          onPress={onClose}
          testID="attachment-picker-backdrop"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {paddingBottom: Math.max(insets.bottom, space.md)},
          ]}
        >
          <View style={styles.grabber} />
          <View style={styles.header}>
            <Text style={styles.title}>{ATTACH_COPY.attach}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${ATTACH_COPY.attach} 닫기`}
              onPress={onClose}
              style={({pressed}) => [styles.close, pressed && styles.pressed]}
              testID="attachment-picker-close"
            >
              <Text style={styles.closeLabel}>×</Text>
            </Pressable>
          </View>
          <PickerRow
            label="사진 고르기"
            detail="사진 보관함에서 한 장을 고릅니다"
            onPress={onPickPhoto}
            testID="attachment-pick-photo"
          />
          <PickerRow
            label="파일 고르기"
            detail="파일 앱에서 한 개를 고릅니다"
            onPress={onPickFile}
            testID="attachment-pick-file"
          />
        </View>
      </View>
    </Modal>
  );
}

function PickerRow({
  label,
  detail,
  onPress,
  testID,
}: {
  label: string;
  detail: string;
  onPress: () => void;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${detail}`}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1, justifyContent: 'flex-end'},
    backdrop: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: color.scrim,
    },
    sheet: {
      backgroundColor: color.surface,
      borderTopLeftRadius: radius.md,
      borderTopRightRadius: radius.md,
      overflow: 'hidden',
    },
    grabber: {
      alignSelf: 'center',
      width: TOUCH_TARGET,
      height: space.xs,
      marginTop: space.sm,
      borderRadius: radius.pill,
      backgroundColor: color.border,
    },
    header: {
      minHeight: TOUCH_TARGET,
      paddingLeft: SAFE_GUTTER,
      paddingRight: space.xs,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '700',
      color: color.text,
    },
    close: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    closeLabel: {fontSize: font.title, color: color.textMuted},
    row: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
    },
    rowText: {flex: 1, minWidth: 0},
    rowLabel: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
    },
    rowDetail: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    chevron: {fontSize: font.title, color: color.textMuted},
    pressed: {backgroundColor: color.surfacePressed},
  });
