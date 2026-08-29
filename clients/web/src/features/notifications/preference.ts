import { useSyncExternalStore } from "react";
import type { NotifyKind } from "@momo/core/features/notifications/model";

// =============================================================================
// This-device desktop notification kinds (BF-A4 / #1887).
//
// Survey of the fire path (`notifiableKind` / `notifyDecision`):
//   mention  — server-recorded `props.mention_member_ids`
//   approval — pending `approval_request`
// Ordinary channel traffic, a DM without a mention, a thread reply without a
// mention, and an edit never become a banner. There is no third kind to store.
//
// Workspace DND and the mention-exception live on the server. These switches
// are localStorage, key shape `momo.web.*`, this origin only.
// =============================================================================

export const DESKTOP_NOTIFICATION_STORAGE_KEY = "momo.web.notifications.v1";

export type DesktopNotificationKinds = Record<NotifyKind, boolean>;

export const DEFAULT_DESKTOP_NOTIFICATION_KINDS: DesktopNotificationKinds = {
  mention: true,
  approval: true,
};

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

function parseKinds(raw: string | null): DesktopNotificationKinds {
  if (raw === null || raw.trim() === "") {
    return { ...DEFAULT_DESKTOP_NOTIFICATION_KINDS };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ...DEFAULT_DESKTOP_NOTIFICATION_KINDS };
    }
    const record = value as Record<string, unknown>;
    return {
      mention:
        typeof record.mention === "boolean"
          ? record.mention
          : DEFAULT_DESKTOP_NOTIFICATION_KINDS.mention,
      approval:
        typeof record.approval === "boolean"
          ? record.approval
          : DEFAULT_DESKTOP_NOTIFICATION_KINDS.approval,
    };
  } catch {
    return { ...DEFAULT_DESKTOP_NOTIFICATION_KINDS };
  }
}

function read(
  storage: PreferenceStorage | null = browserStorage()
): DesktopNotificationKinds {
  try {
    return parseKinds(storage?.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY) ?? null);
  } catch {
    return { ...DEFAULT_DESKTOP_NOTIFICATION_KINDS };
  }
}

let kinds = read();
const listeners = new Set<() => void>();

export function desktopNotificationKinds(): DesktopNotificationKinds {
  return kinds;
}

export function subscribeDesktopNotificationKinds(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function write(
  next: DesktopNotificationKinds,
  storage: PreferenceStorage | null
): void {
  kinds = next;
  try {
    storage?.setItem(
      DESKTOP_NOTIFICATION_STORAGE_KEY,
      JSON.stringify(next)
    );
  } catch {
    // Storage denial only narrows persistence to this tab.
  }
  for (const listener of listeners) listener();
}

export function setDesktopNotificationKind(
  kind: NotifyKind,
  enabled: boolean,
  storage: PreferenceStorage | null = browserStorage()
): void {
  if (kinds[kind] === enabled) return;
  write({ ...kinds, [kind]: enabled }, storage);
}

export function useDesktopNotificationKinds(): DesktopNotificationKinds {
  return useSyncExternalStore(
    subscribeDesktopNotificationKinds,
    desktopNotificationKinds,
    desktopNotificationKinds
  );
}

/** Test seam that models a reload from persistent storage. */
export function reloadDesktopNotificationKindsForTest(
  storage: PreferenceStorage | null
): void {
  kinds = read(storage);
  for (const listener of listeners) listener();
}
