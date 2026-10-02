import { useSyncExternalStore } from "react";
import type { NotifyKind } from "@momo/core/features/notifications/model";

/**
 * A4 kinds plus the reminder poll (A-41). Mentions/approvals/DMs ride
 * message.new; the two local-pane kinds come from `paneAttention` (#3339).
 *
 *   pane-waiting    — a local pane is waiting for input (응답 필요)
 *   work-mine-done  — a local pane finished (내 작업 끝남)
 *
 * 팀 작업 끝남 has no client-side signal yet (the server judges it, #3341), so
 * it has no switch here: a toggle that does nothing is worse than a row that
 * says 준비 중.
 */
export type DesktopNotifyKind =
  | NotifyKind
  | "reminder"
  | "pane-waiting"
  | "work-mine-done";

/**
 * Dock badge switches (#3339). The badge is the needs-me count and nothing
 * else (`useNeedsMeCount`, one source); these only decide whether it is drawn
 * and whether unread DMs are added on top (default off, owner decision).
 */
export type DockPrefKey = "dockBadge" | "dockDm";
export type DesktopPrefKey = DesktopNotifyKind | DockPrefKey;

// =============================================================================
// This-device desktop notification kinds (BF-A4 / #1887).
//
// Survey of the fire path (`notifiableKind` / `notifyDecision`):
//   mention  — server-recorded `props.mention_member_ids`
//   approval — pending `approval_request`
// Ordinary channel traffic, a DM without a mention, a thread reply without a
// mention, and an edit never become a banner. Reminder dues are a third kind
// and ride the 30s poll, not message.new.
//
// Workspace DND and the mention-exception live on the server. These switches
// are localStorage, key shape `momo.web.*`, this origin only.
// =============================================================================

export const DESKTOP_NOTIFICATION_STORAGE_KEY = "momo.web.notifications.v1";

export type DesktopNotificationKinds = Record<DesktopPrefKey, boolean>;

export const DEFAULT_DESKTOP_NOTIFICATION_KINDS: DesktopNotificationKinds = {
  mention: true,
  approval: true,
  reminder: true,
  // 기본 켬: 승인·응답 필요·멘션·내 작업 끝남. 기본 끔: 새 DM(성재 결정 2026-10-02).
  "pane-waiting": true,
  "work-mine-done": true,
  dm: false,
  dockBadge: true,
  dockDm: false,
};

const PREFERENCE_KEYS = Object.keys(
  DEFAULT_DESKTOP_NOTIFICATION_KINDS
) as DesktopPrefKey[];

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
    const next = { ...DEFAULT_DESKTOP_NOTIFICATION_KINDS };
    for (const key of PREFERENCE_KEYS) {
      if (typeof record[key] === "boolean") next[key] = record[key];
    }
    return next;
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
  kind: DesktopPrefKey,
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
