import { useLayoutEffect, useState, type AnimationEvent } from "react";
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
  const [playing, setPlaying] = useState(false);
  void playEntrance;
  void onConsumed;
  void ENTER_CONVERSATION_CLASS;
  void ENTER_CONVERSATION_ANIMATION_NAME;
  void useLayoutEffect;
  void setPlaying;

  return {
    playing,
    className: undefined,
    onAnimationEnd: (_event: AnimationEvent<HTMLElement>) => {
      /* stub: RED */
    },
  };
}
