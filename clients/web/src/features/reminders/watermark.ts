// =============================================================================
// Per-workspace last-check watermark for reminder due arrival (A-41).
//
// localStorage, `momo.web.*` key. A missing key is the first look: the due
// planner treats that as "notify nothing, badge the backlog".
// =============================================================================

export const REMINDER_WATERMARK_STORAGE_KEY = "momo.web.reminders.watermark.v1";

interface WatermarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): WatermarkStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseMap(raw: string | null): Record<string, number> {
  if (raw === null || raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const next: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "number" && Number.isFinite(entry)) next[key] = entry;
    }
    return next;
  } catch {
    return {};
  }
}

export function readReminderWatermark(
  workspaceId: string,
  storage: WatermarkStorage | null = browserStorage()
): number | null {
  try {
    const value = parseMap(storage?.getItem(REMINDER_WATERMARK_STORAGE_KEY) ?? null)[
      workspaceId
    ];
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

export function writeReminderWatermark(
  workspaceId: string,
  atMs: number,
  storage: WatermarkStorage | null = browserStorage()
): void {
  if (storage === null) return;
  try {
    const current = parseMap(storage.getItem(REMINDER_WATERMARK_STORAGE_KEY));
    current[workspaceId] = atMs;
    storage.setItem(REMINDER_WATERMARK_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage denial only narrows persistence to this tab.
  }
}
