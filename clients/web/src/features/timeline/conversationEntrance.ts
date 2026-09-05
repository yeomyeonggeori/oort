import { useLayoutEffect, useRef, useState, type AnimationEvent } from "react";
import {
  ENTER_CONVERSATION_ANIMATION_NAME,
  ENTER_CONVERSATION_CLASS,
} from "@/design/motion";

/**
 * ADR-0179 D3 one-shot. Local `playing` drops the class on animationName
 * match. The parent consumes the grant on first mount so virtuoso remount
 * cannot pass playEntrance again.
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

  useLayoutEffect(() => {
    if (!playEntrance || consumedRef.current) return;
    consumedRef.current = true;
    // Delayed grant (false → true): a held opener row starts after the
    // welcome stage's exit animationend. useState(playEntrance) only
    // captures the first mount.
    setPlaying(true);
    onConsumed?.();
  }, [playEntrance, onConsumed]);

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
