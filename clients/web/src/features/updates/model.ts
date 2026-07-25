import type { AvailableUpdate } from "@/lib/tauri";

// =============================================================================
// Update channel state (ADR-0133 P2, MOMO-606).
//
// Pure: no React, no Tauri, no timers. Everything below is a value the store
// hands to a renderer, so the whole state machine can be asserted in a unit
// test instead of clicked through a signed build.
//
// The vocabulary is deliberately six states, not "loading / done". Each one
// answers a different question a tester actually has:
//
//   idle       nothing asked yet (a browser tab, or the first second of a run)
//   checking   asking the manifest
//   current    asked, and this IS the newest build
//   available  a newer build exists, nothing downloaded
//   installing bytes moving; the app is still fully usable
//   installed  swapped on disk, waiting for a restart THEY choose
//   failed     say what broke and offer the retry
//
// Collapsing `current` into `idle` is the tempting simplification and it is
// wrong: "up to date" is a fact worth showing, and "never asked" is not.
// =============================================================================

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: AvailableUpdate }
  | {
      kind: "installing";
      update: AvailableUpdate;
      downloaded: number;
      total: number | null;
    }
  | { kind: "installed"; update: AvailableUpdate }
  | {
      kind: "failed";
      /** A sentence for the person: what happened and what to do next. */
      message: string;
      /** The underlying error, for a bug report. Never the whole story alone. */
      detail: string | null;
      update: AvailableUpdate | null;
    };

/** The version on offer, when there is one. */
export function offeredVersion(state: UpdateState): string | null {
  switch (state.kind) {
    case "available":
    case "installing":
    case "installed":
      return state.update.version;
    default:
      return null;
  }
}

/**
 * True when the sidebar should show anything at all.
 *
 * A quiet channel is the normal case, and a permanent "up to date" chip in the
 * sidebar is noise that trains people to stop reading that corner. So the badge
 * appears only when there is something to act on, and the full state (including
 * "up to date" and any failure) lives in settings where it was asked for.
 */
export function badgeWorthShowing(state: UpdateState): boolean {
  return (
    state.kind === "available" ||
    state.kind === "installing" ||
    state.kind === "installed"
  );
}

/**
 * Download progress as a whole percent, or null when the server sent no length.
 *
 * Clamped, because a truncated Content-Length would otherwise render 130% and
 * make the one honest number on the screen the least believable thing on it.
 */
export function progressPercent(
  downloaded: number,
  total: number | null
): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
}

/**
 * Size for humans. Binary units (MiB) with SI names is the lie every download
 * UI tells; this one divides by 1000 so 12.4 MB means 12,400,000 bytes.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${Math.round(bytes / 1000)} KB`;
  return `${mb.toFixed(1)} MB`;
}

/**
 * "3.2 / 12.4 MB" while a length is known, "3.2 MB" when it is not.
 *
 * The shared unit is printed once. Two units in one label ("3.2 MB / 12.4 MB")
 * makes the reader parse the string instead of the ratio, which is the only
 * thing the label is for.
 */
export function progressLabel(
  downloaded: number,
  total: number | null
): string {
  if (total === null || total <= 0) return formatBytes(downloaded);
  const done = formatBytes(downloaded);
  const all = formatBytes(total);
  const unit = all.slice(all.indexOf(" "));
  const short = done.endsWith(unit) ? done.slice(0, -unit.length) : done;
  return `${short} / ${all}`;
}

/**
 * The publish date, rendered in the reader's locale, or null when the manifest
 * carried none or carried something unparseable. A bad timestamp is dropped
 * rather than shown as "Invalid Date", which tells a tester nothing and looks
 * like the app is broken.
 */
export function formatPublishedAt(
  value: string | null,
  locale = "ko-KR"
): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * One sentence for the sidebar badge. Short on purpose: the badge lives in a
 * 240px column next to a name that can already be truncating.
 */
export function badgeLabel(state: UpdateState): string | null {
  switch (state.kind) {
    case "available":
      return `새 버전 ${state.update.version}`;
    case "installing": {
      const percent = progressPercent(state.downloaded, state.total);
      return percent === null ? "업데이트 받는 중" : `업데이트 받는 중 ${percent}%`;
    }
    case "installed":
      return "재시작하면 적용";
    default:
      return null;
  }
}
