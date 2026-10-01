import { useCallback, useEffect, useRef, useState } from "react";
import {
  prefersReducedMotion,
  shouldHideCollapsedSidebarTree,
} from "@/app/sidebarPane";

/**
 * Desktop fold paint (#1864 B1).
 *
 * The grid column animates 324→56 (#3280: 목록 열만 접고 레일은 남는다; 이전에는 240→0) while the tree is still in layout (clipped).
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
  // 기기별로 기억한 접힘(#3280)으로 시작하면 처음 그림부터 접힌 모양이다: 펼친 열이
  // 잠깐 서다가 접히는 번쩍임이 없다.
  const [trackCollapsed, setTrackCollapsed] = useState(() => collapsed && !asDrawer);
  const [paintSettled, setPaintSettled] = useState(() => collapsed && !asDrawer);

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

  // 이 훅을 거치지 않은 접힘 변화(「내 작업」의 ⌘J가 접힌 목록을 펴는 일, 다른 창의
  // 저장 상태)도 같은 모양으로 따라온다. 전환을 그리지 않고 곧바로 맞춘다.
  useEffect(() => {
    if (asDrawer) return;
    if (collapsed) {
      if (!trackCollapsed) {
        setTrackCollapsed(true);
        setPaintSettled(true);
      }
    } else if (paintSettled) {
      setPaintSettled(false);
    }
  }, [asDrawer, collapsed, trackCollapsed, paintSettled]);

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
