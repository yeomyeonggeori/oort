import { useEffect, useRef } from "react";
import { keyPlatformOf } from "@momo/core/features/workbench/keymap";
import { shouldToggleSidebar } from "@/app/keyboardShortcuts";

/**
 * ⌘B / Ctrl+B: 목록 열 접고 펴기 (#3280). 판정은 `shouldToggleSidebar` 한 곳에 있다
 * (컴포저 굵게 우선, 터미널은 macOS만, IME·반복·다이얼로그 제외).
 *
 * 버블 단계다: 컴포저 등 입력 칸은 판정에서 어차피 빠지고, 위에서 이미 막힌 키는 보지
 * 않는다. 접힐 목록 열이 없는 곳(폰 서랍·설정 전면)은 `enabled`를 거짓으로 둔다.
 */
export function useSidebarShortcut({
  enabled,
  collapsed,
  onToggle,
}: {
  enabled: boolean;
  collapsed: boolean;
  onToggle: (nextCollapsed: boolean) => void;
}): void {
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  useEffect(() => {
    if (!enabled) return;
    const platform = keyPlatformOf(navigator.platform || navigator.userAgent);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const overlayOpen =
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
        ) !== null;
      if (!shouldToggleSidebar(event, platform, { overlayOpen })) return;
      event.preventDefault();
      onToggleRef.current(!collapsedRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
