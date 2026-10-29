import React, {useEffect, useMemo, useRef} from 'react';
import {Animated, Image, StyleSheet} from 'react-native';
import type {StageRect} from '@momo/core/lib/stageTransition';
import {VIEWER_SNAP_SPRING} from '../../design/motion';
import {radius, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

/** Shared native stage shell: crop changes with the frame, content keeps its aspect ratio.
 * Mounted separately from the pager so no message or zoom layout participates in the spring. */
export function StageHero({uri, from, to, closing, running = true, onArrive, rectRef, children}: {
  uri?: string | null;
  children?: React.ReactNode;
  from: StageRect;
  to: StageRect;
  closing: boolean;
  running?: boolean;
  rectRef: React.MutableRefObject<StageRect | null>;
  onArrive: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const progress = useRef(new Animated.Value(0)).current;
  const arrived = useRef(onArrive);
  arrived.current = onArrive;
  useEffect(() => {
    const subscription = progress.addListener(({value}) => {
      const mix = (a: number, b: number) => a + (b - a) * value;
      rectRef.current = {x: mix(from.x, to.x), y: mix(from.y, to.y), width: mix(from.width, to.width), height: mix(from.height, to.height)};
    });
    return () => progress.removeListener(subscription);
  }, [progress, from, to, rectRef]);
  useEffect(() => {
    if (!running) return;
    const animation = Animated.spring(progress, {
      toValue: 1, ...VIEWER_SNAP_SPRING, overshootClamping: true,
      // A changing crop needs width/height, not non-uniform scaling of the photograph.
      useNativeDriver: false,
    });
    animation.start(({finished}) => { if (finished) arrived.current(); });
    return () => animation.stop();
  }, [progress, running]);
  const frame = useMemo(() => {
    const tween = (a: number, b: number) => progress.interpolate({inputRange: [0, 1], outputRange: [a, b]});
    return {
      left: tween(from.x, to.x), top: tween(from.y, to.y),
      width: tween(from.width, to.width), height: tween(from.height, to.height),
      borderRadius: tween(closing ? 0 : radius.md, closing ? radius.md : 0),
    };
  }, [from, to, closing, progress]);
  return <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.frame, frame]} testID="attachment-viewer-hero">
    {children ?? (uri ? <Image source={{uri}} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null)}
  </Animated.View>;
}
const buildStyles = (_color: Palette) => StyleSheet.create({frame: {position: 'absolute', overflow: 'hidden'}});
