import { useLayoutEffect, useRef, useState, type AnimationEvent } from "react";
import {
  ENTER_CONVERSATION_ANIMATION_NAME,
  ENTER_CONVERSATION_CLASS,
} from "@/design/motion";

/**
 * ADR-0179 D3 one-shot. Local `playing` drops the class on animationName
 * match. The parent consumes the grant on the first painted frame so a
 * virtuoso remount after that frame cannot pass playEntrance again. A
 * flash-mount that unmounts before the frame (large same-tick append)
 * cancels the consume and keeps the grant (#2050 R5 M-1).
 */
export function useConversationEntrance(
  playEntrance: boolean,
  onConsumed?: () => void
): {
  playing: boolean;
  className: string | undefined;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
} {
  const [playing, setPlaying] = useState(playEntrance);
  const consumedRef = useRef(false);
  const onConsumedRef = useRef(onConsumed);
  onConsumedRef.current = onConsumed;

  useLayoutEffect(() => {
    if (!playEntrance || consumedRef.current) return;
    // Delayed grant (false → true): a held opener row starts after the
    // welcome stage's exit animationend. useState(playEntrance) only
    // captures the first mount.
    setPlaying(true);
    const frame = requestAnimationFrame(() => {
      if (consumedRef.current) return;
      consumedRef.current = true;
      onConsumedRef.current?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [playEntrance]);

  const onAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (event.animationName !== ENTER_CONVERSATION_ANIMATION_NAME) return;
    setPlaying(false);
  };

  return {
    playing,
    className: playing ? ENTER_CONVERSATION_CLASS : undefined,
    onAnimationEnd,
  };
}
