import { useCallback, useEffect, useRef, useState } from "react";
import {
  prefersReducedMotion,
  shouldHideCollapsedSidebarTree,
} from "@/app/sidebarPane";

/**
 * Desktop fold paint (#1864 B1).
 *
 * The grid column animates 240→0 while the tree is still in layout (clipped).
 * Once that transition ends — or immediately when motion is reduced — the tree
 * takes `hidden` so a 0-width `overflow-y: auto` box cannot keep a leftover
 * scrollWidth. Expanding reverses the order: drop `hidden` first, then start
 * the 0→240 transition on the next frame so the column has a real from-width.
 *
 * `inert` / aria stay on the intent flag (`collapsed`). This hook only times
 * paint and the `data-sidebar-collapsed` track. The mobile drawer never hides.
 */
export function useSidebarCollapsePaint({
  collapsed,
  asDrawer,
  setCollapsed,
}: {
  collapsed: boolean;
  asDrawer: boolean;
  setCollapsed: (next: boolean) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [trackCollapsed, setTrackCollapsed] = useState(false);
  const [paintSettled, setPaintSettled] = useState(false);

  const treeHidden = shouldHideCollapsedSidebarTree({
    asDrawer,
    collapsed,
    paintSettled,
  });

  const requestCollapsedChange = useCallback(
    (next: boolean) => {
      if (asDrawer) {
        setCollapsed(next);
        setPaintSettled(false);
        return;
      }
      if (next) {
        setCollapsed(true);
        setTrackCollapsed(true);
        if (prefersReducedMotion()) setPaintSettled(true);
        return;
      }
      setCollapsed(false);
      setPaintSettled(false);
      if (prefersReducedMotion()) setTrackCollapsed(false);
    },
    [asDrawer, setCollapsed]
  );

  useEffect(() => {
    if (asDrawer || collapsed || treeHidden || !trackCollapsed) return;
    if (prefersReducedMotion()) {
      setTrackCollapsed(false);
      return;
    }
    const frame = requestAnimationFrame(() => setTrackCollapsed(false));
    return () => cancelAnimationFrame(frame);
  }, [asDrawer, collapsed, treeHidden, trackCollapsed]);

  useEffect(() => {
    if (asDrawer || !collapsed || paintSettled || prefersReducedMotion()) return;
    const shell = shellRef.current;
    if (!shell) {
      setPaintSettled(true);
      return;
    }
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== shell) return;
      if (event.propertyName !== "grid-template-columns") return;
      setPaintSettled(true);
    };
    shell.addEventListener("transitionend", onEnd);
    return () => shell.removeEventListener("transitionend", onEnd);
  }, [asDrawer, collapsed, paintSettled]);

  const wasDrawerRef = useRef(asDrawer);
  useEffect(() => {
    const wasDrawer = wasDrawerRef.current;
    wasDrawerRef.current = asDrawer;
    if (asDrawer) {
      setPaintSettled(false);
      return;
    }
    if (wasDrawer && collapsed && trackCollapsed) setPaintSettled(true);
  }, [asDrawer, collapsed, trackCollapsed]);

  return {
    shellRef,
    trackCollapsed,
    treeHidden,
    requestCollapsedChange,
  };
}
