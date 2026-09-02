import {CameraView, useCameraPermissions} from 'expo-camera';
import React, {useEffect, useRef} from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {DEVICE_LINK_QR_LABEL} from '@momo/core/features/auth/deviceLinkModel';

import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

export function QrScannerSheet({
  visible,
  onClose,
  onScan,
  onPermissionDenied,
}: {
  visible: boolean;
  onClose: () => void;
  onScan: (data: string) => void;
  onPermissionDenied: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const asked = useRef(false);

  useEffect(() => {
    if (!visible) {
      scanned.current = false;
      asked.current = false;
      return;
    }
    if (permission?.granted) return;
    if (asked.current) return;
    asked.current = true;
    let cancelled = false;
    void requestPermission().then(next => {
      if (cancelled) return;
      if (!next.granted) onPermissionDenied();
    });
    return () => {
      cancelled = true;
    };
  }, [visible, permission?.granted, requestPermission, onPermissionDenied]);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      testID="qr-scanner-sheet">
      <View style={[styles.root, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
        <View style={styles.header}>
          <Text style={styles.title}>{DEVICE_LINK_QR_LABEL}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="스캐너 닫기"
            onPress={onClose}
            style={({pressed}) => [styles.close, pressed && styles.pressed]}
            testID="qr-scanner-close">
            <Text style={styles.closeLabel}>닫기</Text>
          </Pressable>
        </View>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{barcodeTypes: ['qr']}}
            onBarcodeScanned={({data}) => {
              if (scanned.current) return;
              scanned.current = true;
              onScan(data);
            }}
            testID="qr-camera-view"
          />
        ) : (
          <View style={styles.camera} testID="qr-camera-pending" />
        )}
      </View>
    </Modal>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: color.bg},
    header: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.sm,
    },
    title: {fontSize: font.heading, fontWeight: '600', color: color.text},
    close: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      justifyContent: 'center',
      alignItems: 'flex-end',
      borderRadius: radius.md,
    },
    closeLabel: {color: color.accentText, fontSize: font.label, fontWeight: '600'},
    pressed: {backgroundColor: color.surfacePressed},
    camera: {flex: 1, backgroundColor: color.bg},
  });
