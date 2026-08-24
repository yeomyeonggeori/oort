import { useCallback, useSyncExternalStore } from "react";
import type { SkinTone } from "./catalog";

// =============================================================================
// Global emoji skin tone (#1742). One value for the whole picker, persisted on
// this device. Applied to any catalog entry that ships skins.
// =============================================================================

export const EMOJI_SKIN_STORAGE_KEY = "momo.web.emoji.skin.v1";

const listeners = new Set<() => void>();

function readTone(): SkinTone {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(EMOJI_SKIN_STORAGE_KEY);
  if (raw === "1" || raw === "2" || raw === "3" || raw === "4" || raw === "5") {
    return Number(raw) as SkinTone;
  }
  return 0;
}

let tone: SkinTone = readTone();

function emit() {
  for (const listener of listeners) listener();
}

export function getEmojiSkinTone(): SkinTone {
  return tone;
}

export function setEmojiSkinTone(next: SkinTone): void {
  if (tone === next) return;
  tone = next;
  if (typeof localStorage !== "undefined") {
    if (next === 0) localStorage.removeItem(EMOJI_SKIN_STORAGE_KEY);
    else localStorage.setItem(EMOJI_SKIN_STORAGE_KEY, String(next));
  }
  emit();
}

export function subscribeEmojiSkinTone(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEmojiSkinTone(): [SkinTone, (next: SkinTone) => void] {
  const value = useSyncExternalStore(
    subscribeEmojiSkinTone,
    getEmojiSkinTone,
    (): SkinTone => 0
  );
  const set = useCallback((next: SkinTone) => {
    setEmojiSkinTone(next);
  }, []);
  return [value, set];
}

/** Test helper. Not for product code. */
export function resetEmojiSkinToneForTests(): void {
  tone = 0;
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(EMOJI_SKIN_STORAGE_KEY);
  }
  emit();
}
