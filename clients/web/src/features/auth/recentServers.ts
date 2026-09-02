import { normalizeServerUrl } from "@/lib/serverBase";

// Recent server chips on S1. URLs only, never credentials. Separate from
// `momo.web.server.v1`, which is the chosen base for this device.

const STORAGE_KEY = "momo.web.server.history.v1";
const MAX_RECENT = 5;

function readRaw(): unknown {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function readRecentServers(): string[] {
  const parsed = readRaw();
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const checked = normalizeServerUrl(item);
    if (!checked.ok || seen.has(checked.base)) continue;
    seen.add(checked.base);
    out.push(checked.base);
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

export function rememberRecentServer(base: string): void {
  const checked = normalizeServerUrl(base);
  if (!checked.ok) return;
  const next = [
    checked.base,
    ...readRecentServers().filter((item) => item !== checked.base),
  ].slice(0, MAX_RECENT);
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Same contract as serverBase: private mode just forgets the list.
  }
}

export function clearRecentServers(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
