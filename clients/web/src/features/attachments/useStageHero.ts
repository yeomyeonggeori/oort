import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  initialStage, stageTransition, stageExitRect, validStageRect,
  type StageRect, type StageTransition, type StageEvent,
} from "@momo/core/lib/stageTransition";
import { STAGE_HERO_SPRING, STAGE_HERO_WINDOW_MS } from "@/design/motion";

export type StageSource = (id: string) => HTMLElement | null;
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const rectOf = (node: Element): StageRect => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
};
/** Existing native spring, sampled for WAAPI; only a floating crop gets geometry animation. */
function springFrames(from: StageRect, to: StageRect): Keyframe[] {
  const { stiffness, damping, mass } = STAGE_HERO_SPRING;
  const decay = damping / (2 * mass);
  const frequency = Math.sqrt(stiffness / mass - decay ** 2);
  return Array.from({ length: 61 }, (_, i) => {
    const t = (i / 60) * STAGE_HERO_WINDOW_MS / 1000;
    const p = i === 60 ? 1 : Math.min(1, 1 - Math.exp(-decay * t) *
      (Math.cos(frequency * t) + decay / frequency * Math.sin(frequency * t)));
    const mix = (a: number, b: number) => `${a + (b - a) * p}px`;
    return { offset: i / 60, left: mix(from.x, to.x), top: mix(from.y, to.y),
      width: mix(from.width, to.width), height: mix(from.height, to.height) };
  });
}

/** Reusable photo/decision stage lifecycle. Closing releases the Dialog immediately; a silent snapshot exits.
 * No scroll, focus or layout writes to the source. Source IDs are resolved again on every close. */
export function useStageHero({ open, selectedId, source, onClose }: {
  open: boolean;
  selectedId: string | null;
  source?: StageSource;
  onClose: () => void;
}) {
  const [state, setState] = useState<StageTransition>({ phase: "closed", ticket: 0 });
  const machine = useRef(state);
  const panel = useRef<HTMLElement | null>(null);
  const scrim = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLElement | null>(null);
  const exitLayer = useRef<HTMLElement | null>(null);
  const clone = useRef<HTMLElement | null>(null);
  const animations = useRef<Animation[]>([]);
  const origin = useRef<StageRect | null>(null);
  const wasOpen = useRef(false);
  const callbacks = useRef({ selectedId, source, onClose });
  callbacks.current = { selectedId, source, onClose };

  const send = useCallback((event: StageEvent) => {
    const next = stageTransition(machine.current, event);
    machine.current = next;
    setState(next);
    return next;
  }, []);
  const cleanup = useCallback(() => {
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    clone.current?.remove();
    clone.current = null;
    exitLayer.current?.remove();
    exitLayer.current = null;
    content.current?.classList.remove("invisible");
  }, []);
  const animate = useCallback((closing: boolean, ticket: number) => {
    const node = content.current;
    const host = panel.current;
    const done = () => {
      if (machine.current.ticket !== ticket) return;
      send({ type: "arrived", ticket });
      cleanup();
    };
    if (!node || !host || reduced() || !node.animate) { done(); return; }
    const fitted = rectOf(node);
    if (!validStageRect(fitted)) { done(); return; }
    const id = callbacks.current.selectedId;
    const thumbnail = id ? callbacks.current.source?.(id) : null;
    const destination = thumbnail?.isConnected ? rectOf(thumbnail) : null;
    // An interrupted opening continues at its painted rectangle.
    const from = closing ? (clone.current ? rectOf(clone.current) : fitted) : origin.current ?? fitted;
    const to = closing ? stageExitRect(destination, fitted, { width: innerWidth, height: innerHeight }) : fitted;
    cleanup();
    const floating = node.cloneNode(true) as HTMLElement;
    floating.removeAttribute("id");
    floating.removeAttribute("data-testid");
    floating.querySelectorAll('[id], [data-testid]').forEach(child => {child.removeAttribute("id"); child.removeAttribute("data-testid");});
    floating.setAttribute("aria-hidden", "true");
    floating.classList.remove("lightbox-photo");
    floating.classList.add("stage-hero");
    floating.style.borderRadius = getComputedStyle(thumbnail ?? node).borderRadius;
    host.appendChild(floating);
    clone.current = floating;
    node.classList.add("invisible");
    const frames = springFrames(from, to);
    const sourceRadius = getComputedStyle(thumbnail ?? node).borderRadius;
    frames[0].borderRadius = closing ? getComputedStyle(node).borderRadius : sourceRadius;
    frames[frames.length - 1].borderRadius = closing ? sourceRadius : getComputedStyle(node).borderRadius;
    const motion = floating.animate(frames, { duration: STAGE_HERO_WINDOW_MS, fill: "both" });
    const fades = [backdrop.current, scrim.current].filter((n): n is HTMLDivElement => n !== null).map(n =>
      n.animate([{ opacity: closing ? getComputedStyle(n).opacity : 0 }, { opacity: closing ? 0 : 1 }],
        { duration: STAGE_HERO_WINDOW_MS, fill: "both" }));
    animations.current = [motion, ...fades];
    motion.finished.then(done, () => {});
  }, [cleanup, send]);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      cleanup();
      wasOpen.current = true;
      const id = callbacks.current.selectedId;
      const thumbnail = id ? callbacks.current.source?.(id) : null;
      origin.current = thumbnail?.isConnected ? rectOf(thumbnail) : null;
      const next = initialStage(reduced());
      // Tickets are monotonic even when a Dialog is opened again before a late completion arrives.
      next.ticket = machine.current.ticket + 1;
      machine.current = next;
      setState(next);
    } else if (!open && wasOpen.current) {
      wasOpen.current = false;
      // A closed Dialog has no focus trap or controls. Its detached exit snapshot owns its animation.
      if (machine.current.phase !== "closing" && machine.current.phase !== "fitting") {
        cleanup();
        machine.current = { phase: "closed", ticket: machine.current.ticket + 1 };
        setState(machine.current);
      }
    }
  }, [open, cleanup]);
  useLayoutEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const change = () => {
      if (!query?.matches) return;
      const next = send({ type: "reduce" });
      cleanup();
      if (next.phase === "closed" && wasOpen.current) callbacks.current.onClose();
    };
    query?.addEventListener?.("change", change);
    return () => {
      query?.removeEventListener?.("change", change);
      machine.current = {phase: 'closed', ticket: machine.current.ticket + 1};
      wasOpen.current = false;
      cleanup();
    };
  }, [send, cleanup]);

  const enter = useCallback(() => {
    const current = machine.current;
    if (current.phase === "opening" && clone.current === null) animate(false, current.ticket);
  }, [animate]);
  const requestClose = useCallback((zoomed: boolean) => {
    const previous = machine.current;
    const next = send({ type: "close", zoomed, reduceMotion: reduced() });
    if (next === previous) return;
    const node = content.current;
    if (next.phase === "closed" || !node || !node.animate) {
      cleanup();
      send({type: "reduce"});
      callbacks.current.onClose();
      return;
    }
    const painted = clone.current ? rectOf(clone.current) : rectOf(node);
    const box = rectOf(node);
    // Layout dimensions exclude zoom; the painted center includes the current pan.
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    // A smooth zoom can be interrupted between frames: inline variables describe its TARGET,
    // whereas the computed transform describes the same painted instant as the bounding box.
    const matrix = getComputedStyle(node).transform.match(/^matrix(3d)?\((.+)\)$/);
    const values = matrix?.[2].split(",").map(Number);
    const panX = values?.[matrix?.[1] ? 12 : 4] ?? 0;
    const panY = values?.[matrix?.[1] ? 13 : 5] ?? 0;
    const fitted = {
      x: box.x + box.width / 2 - panX - width / 2,
      y: box.y + box.height / 2 - panY - height / 2,
      width, height,
    };
    const id = callbacks.current.selectedId;
    const thumbnail = id ? callbacks.current.source?.(id) : null;
    const destination = stageExitRect(thumbnail?.isConnected ? rectOf(thumbnail) : null,
      fitted, {width: innerWidth, height: innerHeight});
    const floating = node.cloneNode(true) as HTMLElement;
    floating.removeAttribute("id");
    floating.removeAttribute("data-testid");
    floating.classList.remove("lightbox-photo", "invisible");
    floating.classList.add("stage-hero");
    floating.setAttribute("aria-hidden", "true");
    const radius = getComputedStyle(thumbnail ?? node).borderRadius;
    const photoRadius = getComputedStyle(node).borderRadius;
    cleanup();
    const layer = document.createElement("div");
    layer.className = "stage-hero-layer layer-overlay-surface";
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    const backgrounds = [scrim.current, backdrop.current].filter((n): n is HTMLDivElement => n !== null)
      .map(original => {
        const background = original.cloneNode(true) as HTMLElement;
        // The detached layer supplies the modal elevation; its scrim must stay BELOW the photo.
        background.classList.remove("layer-overlay-scrim");
        return background;
      });
    layer.append(...backgrounds, floating);
    document.body.append(layer);
    exitLayer.current = layer;
    clone.current = floating;
    const ticket = next.ticket;
    const exit = () => {
      if (machine.current.ticket !== ticket) return;
      const closing = machine.current.phase === "fitting" ? send({type: "fit"}) : machine.current;
      const frames = springFrames(zoomed ? fitted : painted, destination);
      frames[0].borderRadius = photoRadius;
      frames[frames.length - 1].borderRadius = radius;
      const motion = floating.animate(frames, {duration: STAGE_HERO_WINDOW_MS, fill: "both"});
      animations.current.push(motion, ...backgrounds.map(background => background.animate(
        [{opacity: 1}, {opacity: 0}], {duration: STAGE_HERO_WINDOW_MS, fill: "both"})));
      void motion.finished.then(() => {
        if (machine.current.ticket !== closing.ticket) return;
        send({type: "arrived", ticket: closing.ticket});
        cleanup();
      }, () => {});
    };
    if (zoomed) {
      const fit = floating.animate(springFrames(painted, fitted), {duration: STAGE_HERO_WINDOW_MS, fill: "both"});
      animations.current.push(fit);
      void fit.finished.then(exit, () => {});
    } else exit();
    // This callback removes the Dialog now, including its Escape layer and focus trap.
    callbacks.current.onClose();
  }, [send, cleanup]);
  // Loading/error/empty states have no photograph to animate. They must still have a working close path.
  const noPhoto = useCallback(() => {
    if (machine.current.phase === "opening") send({ type: "arrived", ticket: machine.current.ticket });
  }, [send]);
  return { state, panel, scrim, backdrop, content, enter, noPhoto, requestClose };
}
