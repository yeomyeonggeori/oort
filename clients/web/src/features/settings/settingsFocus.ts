import { restoreDialogOpenerFocus } from "@/design/ui/dialog";

// =============================================================================
// 설정 전면 전환의 포커스 기억 (#1867 M-4).
//
// 설정은 셸 안의 다른 라우트를 **통째로 갈아 끼운다**. 컴포저·프로필 카드처럼
// 떠나기 전에 포커스가 있던 노드는 언마운트되므로, 요소 참조를 들고 있으면
// 복귀 시 isConnected=false 다. 같은 data-testid/id 를 새 트리에서 다시 찾아
// 그 자리에 캐럿을 놓는다.
// =============================================================================

type SettingsOpener = { testId: string } | { id: string };

let opener: SettingsOpener | null = null;

function activeElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

function markerOf(el: HTMLElement): SettingsOpener | null {
  const testId = el.getAttribute("data-testid");
  if (testId) return { testId };
  if (el.id) return { id: el.id };
  return null;
}

function findOpener(saved: SettingsOpener): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const el =
    "testId" in saved
      ? document.querySelector(`[data-testid="${saved.testId}"]`)
      : document.getElementById(saved.id);
  return el instanceof HTMLElement ? el : null;
}

/** Remember the control that opened settings, by identity that survives remount. */
export function rememberSettingsOpener(node?: HTMLElement | null): void {
  const el = node ?? activeElement();
  opener = el ? markerOf(el) : null;
}

/** Restore focus after the previous route has remounted. */
export function restoreSettingsOpener(): boolean {
  const saved = opener;
  opener = null;
  if (!saved) return false;
  const tryFocus = (): boolean => {
    const el = findOpener(saved);
    return el ? restoreDialogOpenerFocus(el) : false;
  };
  if (tryFocus()) return true;
  if (typeof requestAnimationFrame !== "function") return false;
  requestAnimationFrame(() => {
    tryFocus();
  });
  return false;
}
