import { useSyncExternalStore } from "react";

export const LINK_PREVIEW_FOLDED_STORAGE_KEY =
  "momo.web.link-previews-folded.v1";

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

function read(storage: PreferenceStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(LINK_PREVIEW_FOLDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let folded = read();
const listeners = new Set<() => void>();

export function linkPreviewsFolded(): boolean {
  return folded;
}

export function subscribeLinkPreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLinkPreviewsFolded(
  next: boolean,
  storage: PreferenceStorage | null = browserStorage()
): void {
  if (next === folded) return;
  folded = next;
  try {
    storage?.setItem(LINK_PREVIEW_FOLDED_STORAGE_KEY, String(next));
  } catch {
    // Storage denial only narrows persistence to this tab; rendering still
    // follows the person's choice immediately.
  }
  for (const listener of listeners) listener();
}

export function useLinkPreviewsFolded(): boolean {
  return useSyncExternalStore(
    subscribeLinkPreviews,
    linkPreviewsFolded,
    linkPreviewsFolded
  );
}

/** Test seam that models a reload from persistent storage. */
export function reloadLinkPreviewPreferenceForTest(
  storage: PreferenceStorage | null
): void {
  folded = read(storage);
  for (const listener of listeners) listener();
}
