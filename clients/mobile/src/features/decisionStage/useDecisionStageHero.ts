import {useCallback, useEffect, useRef, useState} from 'react';
import {Animated, useWindowDimensions, View} from 'react-native';
import {
  initialStage,
  stageTransition,
  stageExitRect,
  visibleStageRect,
  validStageRect,
  type StageRect,
} from '@momo/core/lib/stageTransition';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {VIEWER_SNAP_SPRING} from '../../design/motion';
import type {DecisionStageSource} from './openDecisionStage';

/** S1 lifecycle and native hero; a missing/clipped origin uses the shared downward exit. */
export function useDecisionStageHero(
  source: DecisionStageSource | undefined,
  onClose: () => void,
) {
  const viewport = useWindowDimensions();
  const reduceMotion = useReduceMotion(false);
  const [stage, setStage] = useState(() => initialStage(reduceMotion));
  const [hero, setHero] = useState<{
    from: StageRect;
    to: StageRect;
    closing: boolean;
  } | null>(null);
  const content = useRef<View | null>(null);
  const rect = useRef<StageRect | null>(null);
  const drag = useRef(new Animated.ValueXY()).current;
  const offset = useRef({x: 0, y: 0});
  const alive = useRef(true);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      drag.stopAnimation();
    };
  }, [drag]);
  useEffect(() => {
    if (reduceMotion) {
      setHero(null);
      setStage(previous => stageTransition(previous, {type: 'reduce'}));
    }
  }, [reduceMotion]);
  useEffect(() => {
    if (stage.phase === 'closed') closeRef.current();
  }, [stage.phase]);

  const measure = useCallback(
    (node: View | null | undefined): Promise<StageRect | null> =>
      new Promise(resolve => {
        if (!node) {
          resolve(null);
          return;
        }
        // A recycled/unmounted native view may never call back.
        const timer = setTimeout(() => resolve(null), 100);
        node.measureInWindow((x, y, width, height) => {
          clearTimeout(timer);
          resolve(
            validStageRect({x, y, width, height})
              ? {x, y, width, height}
              : null,
          );
        });
      }),
    [],
  );
  const enter = useCallback(async () => {
    if (stageRef.current.phase !== 'opening') return;
    const ticket = stageRef.current.ticket;
    const [from, to] = await Promise.all([
      measure(source?.current),
      measure(content.current),
    ]);
    if (
      !alive.current ||
      stageRef.current.phase !== 'opening' ||
      stageRef.current.ticket !== ticket
    )
      return;
    if (!visibleStageRect(from, viewport) || !to)
      setStage(previous =>
        stageTransition(previous, {type: 'arrived', ticket}),
      );
    else setHero({from, to, closing: false});
  }, [measure, source, viewport]);
  const close = useCallback(async () => {
    const next = stageTransition(stageRef.current, {
      type: 'close',
      zoomed: false,
      reduceMotion,
    });
    if (next === stageRef.current) return;
    stageRef.current = next;
    setStage(next);
    if (next.phase === 'closed') return;
    const [target, measured] = await Promise.all([
      measure(source?.current),
      measure(content.current),
    ]);
    if (!alive.current || stageRef.current.ticket !== next.ticket) return;
    const fitted =
      hero?.closing === false ? rect.current ?? measured : measured;
    if (!fitted) {
      setStage(previous =>
        stageTransition(previous, {type: 'arrived', ticket: next.ticket}),
      );
      return;
    }
    // measureInWindow already includes the native drag transform. Adding the JS offset
    // again would jump by a second drag distance at the first exit frame.
    const from = fitted;
    setHero({
      from,
      to: stageExitRect(target, fitted, viewport),
      closing: true,
    });
  }, [measure, reduceMotion, source, viewport, hero]);
  const restore = useCallback(() => {
    offset.current = {x: 0, y: 0};
    if (reduceMotion) drag.setValue(offset.current);
    else
      Animated.spring(drag, {
        toValue: offset.current,
        ...VIEWER_SNAP_SPRING,
        overshootClamping: true,
        useNativeDriver: false,
      }).start();
  }, [drag, reduceMotion]);
  const arrived = () => {
    setHero(null);
    setStage(previous =>
      stageTransition(previous, {type: 'arrived', ticket: stage.ticket}),
    );
  };
  return {
    stage,
    hero,
    content,
    rect,
    drag,
    offset,
    enter,
    close,
    restore,
    arrived,
  };
}
