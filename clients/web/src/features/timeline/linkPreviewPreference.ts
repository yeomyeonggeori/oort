import { useSyncExternalStore } from "react";

// =============================================================================
// This-device link-preview layout (BF-A6 / #1903).
//
// Survey of the boolean era:
//   Store: localStorage `momo.web.link-previews-folded.v1` ("true" | anything else).
//   Settings: 설정 > 링크 미리보기 checkbox "링크 미리보기 접기".
//   Consume: Timeline.useLinkPreviewsFolded → MessageRow.foldLinkPreviews
//            → UnfurlCards.folded. ThreadPanel never subscribed, so a folded
//            main timeline still painted cards in a thread (now closed: the
//            card reads the store itself).
//   Meaning of the two stored values (copy + renderer, not the identifier):
//     "true"  = UnfurlCards returns null. Copy: "켜면 … 카드만 숨깁니다."
//               That is off, not a compact card.
//     "false"/missing/unknown = the existing horizontal compact card.
//   There was no separate off vs fold. Folding was hiding.
//
// Mapping (preserve the person's choice, not the identifier name):
//   new key valid            → as stored
//   old "true"               → off
//   old "false" / unknown    → compact  (they were seeing the compact card)
//   no keys                  → rich
//     미저장 → rich는 미토글 기존 사용자 포함 의도적 기본 상향
//     (제품 결정, 오케스트레이터 승인·성재 최종 확인 예정).
//     "미저장"은 신규 설치가 아니다. 옛 setter는 값이 바뀔 때만 썼으므로
//     키가 없다는 것은 "이 설정을 한 번도 열지 않았다"이고, 그쪽이 다수다.
// =============================================================================

export const LINK_PREVIEW_PREFERENCES = ["rich", "compact", "off"] as const;
export type LinkPreviewPreference = (typeof LINK_PREVIEW_PREFERENCES)[number];

export const LINK_PREVIEW_STORAGE_KEY = "momo.web.link-preview.v1";

/** Boolean-era key. Read only to migrate; new writes go to the 3-value key.
 *  The old key is left in place on purpose (rollback). A valid 3-value key
 *  wins, so nothing reads this after migration. */
export const LINK_PREVIEW_FOLDED_STORAGE_KEY =
  "momo.web.link-previews-folded.v1";

export const DEFAULT_LINK_PREVIEW_PREFERENCE: LinkPreviewPreference = "rich";

export type UnfurlCardLayout = "none" | "compact" | "rich";

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

export function isLinkPreviewPreference(
  value: string | null | undefined
): value is LinkPreviewPreference {
  return value === "rich" || value === "compact" || value === "off";
}

/**
 * Map stored strings onto the 3-value preference. Pure so the round-trip
 * tests can name both boolean-era values without a DOM.
 */
export function migrateLinkPreviewPreference(
  storedNew: string | null | undefined,
  storedFolded: string | null | undefined
): LinkPreviewPreference {
  if (isLinkPreviewPreference(storedNew)) return storedNew;
  if (storedFolded === "true") return "off";
  if (storedFolded != null && storedFolded !== "") return "compact";
  return DEFAULT_LINK_PREVIEW_PREFERENCE;
}

/**
 * What the card actually paints. `showHeroFrame` is the caller's job:
 * preference is rich AND an image URL exists AND fetch/decode has not failed.
 * Bytes may still be loading — the frame is reserved either way (H-1). An
 * empty hero is still forbidden: failure degrades to compact, and a missing
 * URL never opens the frame.
 */
export function unfurlCardLayout(
  preference: LinkPreviewPreference,
  showHeroFrame: boolean
): UnfurlCardLayout {
  if (preference === "off") return "none";
  if (preference === "rich" && showHeroFrame) return "rich";
  return "compact";
}

function persistMigrated(
  storage: PreferenceStorage | null,
  storedNew: string | null | undefined,
  next: LinkPreviewPreference
): void {
  if (isLinkPreviewPreference(storedNew)) return;
  try {
    storage?.setItem(LINK_PREVIEW_STORAGE_KEY, next);
  } catch {
    // Persistence is best-effort; the in-memory value still drives render.
  }
}

function read(
  storage: PreferenceStorage | null = browserStorage()
): LinkPreviewPreference {
  try {
    const storedNew = storage?.getItem(LINK_PREVIEW_STORAGE_KEY) ?? null;
    const storedFolded =
      storage?.getItem(LINK_PREVIEW_FOLDED_STORAGE_KEY) ?? null;
    const next = migrateLinkPreviewPreference(storedNew, storedFolded);
    if (storedFolded != null && storedFolded !== "") {
      persistMigrated(storage, storedNew, next);
    }
    return next;
  } catch {
    return DEFAULT_LINK_PREVIEW_PREFERENCE;
  }
}

let preference = read();
const listeners = new Set<() => void>();

export function linkPreviewPreference(): LinkPreviewPreference {
  return preference;
}

export function subscribeLinkPreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setLinkPreviewPreference(
  next: LinkPreviewPreference,
  storage: PreferenceStorage | null = browserStorage()
): void {
  // Always write, even when next equals the in-memory default. Choosing the
  // default explicitly ("사진 카드" on a fresh store) must persist; otherwise
  // the radio looks saved and a later default change would move this device.
  const changed = next !== preference;
  preference = next;
  try {
    storage?.setItem(LINK_PREVIEW_STORAGE_KEY, next);
  } catch {
    // Storage denial only narrows persistence to this tab; rendering still
    // follows the person's choice immediately.
  }
  if (!changed) return;
  for (const listener of listeners) listener();
}

export function useLinkPreviewPreference(): LinkPreviewPreference {
  return useSyncExternalStore(
    subscribeLinkPreviews,
    linkPreviewPreference,
    linkPreviewPreference
  );
}

/** Test seam that models a reload from persistent storage. */
export function reloadLinkPreviewPreferenceForTest(
  storage: PreferenceStorage | null
): void {
  preference = read(storage);
  for (const listener of listeners) listener();
}
