import { useSyncExternalStore } from "react";
import type { SidebarSectionId } from "./sidebarSectionModel";

// =============================================================================
// Section-collapse preference (#1756 UX-D4 M-3).
//
// The pane fold (`channelPaneCollapsed` in AppShell) is shell-lifetime only —
// it survives a route change and dies on reload, by that file's own comment.
// Section fold is the opposite job: someone with a long channel list folds
// "읽은 것" to keep the list usable, and a reload must not undo that work.
//
// Stamp is the house shell-preference store: localStorage, `momo.web.*` key,
// the same convention theme / link-preview / drafts already use. A missing or
// unreadable value is both-open, which is how the list first rendered.
// =============================================================================

export const SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY =
  "momo.web.sidebar-sections-collapsed.v1";

export type CollapsedSections = Record<SidebarSectionId, boolean>;

const OPEN: CollapsedSections = { channels: false, dms: false };

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseCollapsed(raw: string | null): CollapsedSections {
  if (raw === null) return { ...OPEN };
  try {
    const parsed = JSON.parse(raw) as Partial<CollapsedSections>;
    return {
      channels: parsed.channels === true,
      dms: parsed.dms === true,
    };
  } catch {
    return { ...OPEN };
  }
}

function read(
  storage: PreferenceStorage | null = browserStorage()
): CollapsedSections {
  try {
    return parseCollapsed(
      storage?.getItem(SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY) ?? null
    );
  } catch {
    return { ...OPEN };
  }
}

let collapsed: CollapsedSections = read();
const listeners = new Set<() => void>();

export function sidebarSectionsCollapsed(): CollapsedSections {
  return collapsed;
}

export function subscribeSidebarSections(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSidebarSectionCollapsed(
  id: SidebarSectionId,
  next: boolean,
  storage: PreferenceStorage | null = browserStorage()
): void {
  if (collapsed[id] === next) return;
  collapsed = { ...collapsed, [id]: next };
  try {
    storage?.setItem(
      SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY,
      JSON.stringify(collapsed)
    );
  } catch {
    // Storage denial only narrows persistence to this tab.
  }
  for (const listener of listeners) listener();
}

export function useSidebarSectionsCollapsed(): CollapsedSections {
  return useSyncExternalStore(
    subscribeSidebarSections,
    sidebarSectionsCollapsed,
    sidebarSectionsCollapsed
  );
}

/** Test seam that models a reload from persistent storage. */
export function reloadSidebarSectionPreferenceForTest(
  storage: PreferenceStorage | null
): void {
  collapsed = read(storage);
  for (const listener of listeners) listener();
}
