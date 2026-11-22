import {CameraView} from 'expo-camera';
import React, {useRef, useState} from 'react';
import {Modal, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {
  DEVICE_LINK_ADDRESS_FALLBACK_KEY,
  DEVICE_LINK_CAMERA_ERROR_KEY,
  DEVICE_LINK_CAMERA_OPENING_KEY,
  DEVICE_LINK_QR_INSTRUCTION_KEY,
  DEVICE_LINK_QR_KEY,
} from '@momo/core/features/auth/deviceLinkModel';

import {useFormatMessage} from '../../i18n/useFormatMessage';
import {OutlineButton, ScreenHeader, Sentence} from '../../design/atoms';
import {font, line, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

export function QrScannerSheet({
  onClose,
  onScan,
}: {
  onClose: () => void;
  onScan: (data: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const insets = useSafeAreaInsets();
  const scanned = useRef(false);
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState(false);

  return (
    <Modal
      visible
      animationType="fade"
      onRequestClose={onClose}
      testID="qr-scanner-sheet">
      <View
        style={[
          styles.root,
          {paddingTop: insets.top, paddingBottom: insets.bottom},
        ]}>
        <ScreenHeader
          title={formatMessage(DEVICE_LINK_QR_KEY)}
          onBack={onClose}
          backLabel="스캐너 닫기"
        />
        <Sentence style={styles.instruction}>{formatMessage(DEVICE_LINK_QR_INSTRUCTION_KEY)}</Sentence>
        {mountError ? (
          <View style={styles.errorBlock}>
            <Sentence style={styles.errorCopy} testID="qr-camera-error">
              {formatMessage(DEVICE_LINK_CAMERA_ERROR_KEY)}
            </Sentence>
            <OutlineButton
              label={formatMessage(DEVICE_LINK_ADDRESS_FALLBACK_KEY)}
              onPress={onClose}
              testID="qr-camera-address-fallback"
            />
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            {!ready ? (
              <Sentence style={styles.opening} testID="qr-camera-opening">
                {formatMessage(DEVICE_LINK_CAMERA_OPENING_KEY)}
              </Sentence>
            ) : null}
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{barcodeTypes: ['qr']}}
              onCameraReady={() => setReady(true)}
              onMountError={() => setMountError(true)}
              onBarcodeScanned={({data}) => {
                if (scanned.current) return;
                scanned.current = true;
                onScan(data);
              }}
              testID="qr-camera-view"
            />
          </View>
        )}
      </View>
    </Modal>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: color.bg},
    instruction: {
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.md,
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: line.label,
    },
    cameraWrap: {flex: 1},
    camera: {flex: 1},
    opening: {
      paddingHorizontal: SAFE_GUTTER,
      paddingBottom: space.sm,
      fontSize: font.label,
      color: color.textMuted,
    },
    errorBlock: {
      paddingHorizontal: SAFE_GUTTER,
      gap: space.md,
    },
    errorCopy: {fontSize: font.label, color: color.text, lineHeight: line.label},
  });
