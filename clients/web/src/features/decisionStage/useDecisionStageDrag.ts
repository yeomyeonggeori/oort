import { useEffect, useRef, type PointerEvent, type MouseEvent, type RefObject } from "react";
import { decisionStageDragAction, type DecisionStageDragAction } from "@momo/core/features/timeline/decisionStage";
import { STAGE_HERO_SPRING, STAGE_HERO_WINDOW_MS } from "@/design/motion";

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const interactive = "button, a, input, textarea, select, summary, details, [contenteditable=true]";

export function useDecisionStageDrag(
  surface: RefObject<HTMLElement | null>,
  enabled: () => boolean,
  onAction: (action: DecisionStageDragAction) => void
) {
  const gesture = useRef<{
    id: number; startX: number; startY: number; x: number; y: number;
    time: number; velocityX: number; velocityY: number;
  } | null>(null);
  const motion = useRef<Animation | null>(null);
  const suppressClick = useRef(false);

  const cancel = () => {
    motion.current?.cancel();
    motion.current = null;
    gesture.current = null;
  };
  useEffect(() => () => motion.current?.cancel(), []);

  function paint(x: number, y: number, restore = false) {
    const node = surface.current;
    motion.current?.cancel();
    if (!node?.animate || (restore && reduced())) return;
    const frames: Keyframe[] = restore
      ? Array.from({ length: 31 }, (_, index) => {
          const { stiffness, damping, mass } = STAGE_HERO_SPRING;
          const decay = damping / (2 * mass);
          const frequency = Math.sqrt(stiffness / mass - decay ** 2);
          const t = index / 30 * STAGE_HERO_WINDOW_MS / 1000;
          const remaining = index === 30 ? 0 : Math.exp(-decay * t) *
            (Math.cos(frequency * t) + decay / frequency * Math.sin(frequency * t));
          return { transform: `translate(${x * remaining}px, ${y * remaining}px)` };
        })
      : [{ transform: `translate(${x}px, ${y}px)` }];
    motion.current = node.animate(frames, {
      duration: restore ? STAGE_HERO_WINDOW_MS : 0,
      fill: "both",
    });
  }

  function release(event: PointerEvent<HTMLElement>, cancelled: boolean) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const x = event.clientX - active.startX;
    const y = event.clientY - active.startY;
    const paused = event.timeStamp - active.time > 80;
    const action = cancelled ? "restore" : decisionStageDragAction({
      x, y, velocityX: paused ? 0 : active.velocityX, velocityY: paused ? 0 : active.velocityY,
    });
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    suppressClick.current = !cancelled && Math.hypot(x, y) > 4;
    if (action === "close") {
      onAction(action); // hero가 끌린 현재 위치를 읽은 다음 transform을 걷어요.
      cancel();
    } else {
      paint(x, y, true);
      if (action !== "restore") onAction(action);
    }
  }

  return {
    cancel,
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    bindings: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (!enabled() || event.button !== 0 || event.isPrimary === false ||
          (event.target as Element).closest(interactive)) return;
        cancel();
        suppressClick.current = false;
        gesture.current = {
          id: event.pointerId, startX: event.clientX, startY: event.clientY,
          x: event.clientX, y: event.clientY, time: event.timeStamp, velocityX: 0, velocityY: 0,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const active = gesture.current;
        if (!active || active.id !== event.pointerId) return;
        const elapsed = Math.max(1, event.timeStamp - active.time);
        active.velocityX = (event.clientX - active.x) / elapsed;
        active.velocityY = (event.clientY - active.y) / elapsed;
        active.x = event.clientX; active.y = event.clientY; active.time = event.timeStamp;
        const x = event.clientX - active.startX;
        const y = event.clientY - active.startY;
        paint(Math.abs(x) > Math.abs(y) ? x : 0, Math.abs(y) > Math.abs(x) ? y : 0);
      },
      onPointerUp(event: PointerEvent<HTMLElement>) { release(event, false); },
      onPointerCancel(event: PointerEvent<HTMLElement>) { release(event, true); },
      onLostPointerCapture() { if (gesture.current) cancel(); },
    },
  };
}
