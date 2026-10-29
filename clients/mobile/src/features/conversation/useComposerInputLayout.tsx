import React, {useCallback, useState} from 'react';
import {Text, View, StyleSheet, type LayoutChangeEvent} from 'react-native';
import {font, line} from '../../design/tokens';
import {
  composerInputLayout,
  sameComposerGeometry,
  type ComposerTextMeasurement,
} from './composerInputLayout';

/** Shared by the mirror and both native inputs; scaling and wrapping stay identical. */
export const COMPOSER_INPUT_TYPOGRAPHY = {fontSize: font.body, lineHeight: line.body} as const;

export function useComposerInputLayout({
  text, fontScale, minHeight, maxHeight, chrome, horizontalChrome, testID,
}: {
  text: string;
  fontScale: number;
  minHeight: number;
  maxHeight: number;
  chrome: number;
  horizontalChrome: number;
  testID: string;
}) {
  const [width, setWidth] = useState(0);
  const [measurement, setMeasurement] = useState<ComposerTextMeasurement | null>(null);
  const geometry = {text, width, fontScale, ...COMPOSER_INPUT_TYPOGRAPHY};
  const layout = composerInputLayout(geometry, {minHeight, maxHeight, chrome}, measurement);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.max(0, event.nativeEvent.layout.width - horizontalChrome);
    setWidth(previous => previous === next ? previous : next);
  }, [horizontalChrome]);

  // Fabric 0.86 emits TextInput contentSizeChange only when layoutMetrics change.
  // This unconstrained sibling Text lays out whenever text/width/font change, even
  // while the input is fixed at one/four lines or clipped by the resting animation.
  const mirror = width > 0 ? (
    <View style={styles.host} pointerEvents="none" accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <Text
        testID={testID}
        style={[COMPOSER_INPUT_TYPOGRAPHY, {width}]}
        lineBreakStrategyIOS="hangul-word"
        onTextLayout={event => {
          const lineHeights = event.nativeEvent.lines.map(row => row.height);
          setMeasurement(previous => previous && sameComposerGeometry(previous.geometry, geometry) &&
            previous.lineHeights.length === lineHeights.length &&
            previous.lineHeights.every((height, index) => height === lineHeights[index])
            ? previous : {geometry, lineHeights});
        }}>
        {/* Keep a final empty line measurable without changing the draft/caret. */}
        {text + '\u200b'}
      </Text>
    </View>
  ) : null;
  return {...layout, onLayout, mirror};
}

const styles = StyleSheet.create({host: {position: 'absolute', top: 0, left: 0, opacity: 0}});
