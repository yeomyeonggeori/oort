import {CameraView} from 'expo-camera';
import React, {useRef} from 'react';
import {Modal, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {DEVICE_LINK_QR_LABEL} from '@momo/core/features/auth/deviceLinkModel';

import {ScreenHeader} from '../../design/atoms';
import {type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

export function QrScannerSheet({
  onClose,
  onScan,
}: {
  onClose: () => void;
  onScan: (data: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const scanned = useRef(false);

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
          title={DEVICE_LINK_QR_LABEL}
          onBack={onClose}
          backLabel="스캐너 닫기"
        />
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
      </View>
    </Modal>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: color.bg},
    camera: {flex: 1},
  });
