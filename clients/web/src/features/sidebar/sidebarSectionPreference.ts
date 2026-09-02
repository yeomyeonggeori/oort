import { useSyncExternalStore } from "react";
import type { SidebarSectionId } from "./sidebarSectionModel";

// =============================================================================
// Section-collapse preference (#1756 UX-D4 M-3, ADR-0177 D4로 확장).
//
// The pane fold (`channelPaneCollapsed` in AppShell) is shell-lifetime only —
// it survives a route change and dies on reload, by that file's own comment.
// Section fold is the opposite job: someone with a long channel list folds
// "읽은 것" to keep the list usable, and a reload must not undo that work.
//
// Stamp is the house shell-preference store: localStorage, `momo.web.*` key,
// the same convention theme / link-preview / drafts already use. A missing or
// unreadable value is both-open, which is how the list first rendered.
//
// ## 왜 여기 남는가 (ADR-0177 D4)
//
// BT-4 가 섹션 **구조**를 서버로 올렸다(`member_sidebar_prefs`). 접힘은 따라가지
// 않는다: 구조는 「내 사이드바」라 기기를 건너 로밍해야 하지만, 접힘은 기기 성향
// 이다 - 27인치에서 펼쳐 두는 섹션을 폰에서도 펼쳐 두어야 할 이유가 없다. ADR 이
// 그 갈래를 명시했고, 이 파일이 그 절반이다. 서버 payload 에 접힘을 넣지 말 것.
//
// ## 커스텀 섹션
//
// 원장은 이제 임의의 섹션 id 를 받는다. 기본 두 종(`channels`/`dms`)만 **언제나**
// 항목으로 서고(없으면 「둘 다 펼침」이라는 첫 렌더의 뜻이 사라진다), 커스텀은
// 접힌 것만 적힌다 - 지운 섹션의 접힘이 원장에 영원히 남지 않게. 지운 섹션의
// 열쇠가 남더라도 그 섹션이 다시 그려지지 않으므로 읽는 쪽은 아무 일도 없다.
// =============================================================================

export const SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY =
  "momo.web.sidebar-sections-collapsed.v1";

export type CollapsedSections = Record<SidebarSectionId, boolean>;

/** 언제나 원장에 서는 두 열쇠. 나머지는 접힌 것만 적힌다. */
const BASE_SECTION_IDS = ["channels", "dms"] as const;

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
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return { ...OPEN };
    const collapsed: CollapsedSections = { ...OPEN };
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      // `=== true` 이므로 예전 값이든 남의 값이든 접힘으로 읽히지 않는다.
      if (value === true) collapsed[id] = true;
    }
    return collapsed;
  } catch {
    return { ...OPEN };
  }
}

/**
 * 적어 둘 것만 남긴다: 기본 둘은 언제나, 커스텀은 **접힌 것만**.
 *
 * 커스텀을 전부 적으면 섹션을 지웠다 만들 때마다 원장이 자라고, 그 쓰레기는
 * 아무도 치우지 않는다. 접힘의 기본값이 「펼침」이므로 없는 열쇠는 곧 펼침이다.
 */
function persistable(collapsed: CollapsedSections): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of BASE_SECTION_IDS) out[id] = collapsed[id] === true;
  for (const [id, value] of Object.entries(collapsed)) {
    if (value === true && !(id in out)) out[id] = true;
  }
  return out;
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
  if ((collapsed[id] ?? false) === next) return;
  collapsed = { ...collapsed, [id]: next };
  try {
    storage?.setItem(
      SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY,
      JSON.stringify(persistable(collapsed))
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
