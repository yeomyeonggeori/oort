import type { LocaleService } from "@momo/core/i18n";
import type { LocalWorkVerdict } from "@momo/core/features/workbench/localWork";
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
//   off        this build never asks (no channel flag); new builds come by hand
//
// Collapsing `current` into `idle` is the tempting simplification and it is
// wrong: "up to date" is a fact worth showing, and "never asked" is not. The
// same goes for `off` (#5661): an owner's app said 「최신」 for six days while it
// had never looked at a feed.
// =============================================================================

/**
 * The rejection `updater_check` gives in a build that never asks the feed: a
 * local, dev or debug build, or a DMG built without the channel flag (#5661).
 * Same string as `UPDATER_DISABLED` in `clients/desktop/src-tauri/src/updater.rs`;
 * `shell_contract.rs` pins the pair. It lives here, not in `lib/tauri.ts`, so
 * the tests that mock the bridge module do not have to repeat it.
 */
export const UPDATER_DISABLED = "updater_disabled";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "off" }
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
      /**
       * Which act failed. `check` (the manifest was unreachable, e.g. offline)
       * says nothing about whether an update exists, so the sidebar pill stays
       * hidden for it; `install` means an update DID exist and the swap broke,
       * which is exactly when the pill must keep offering a retry.
       */
      phase: "check" | "install";
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
 * "3.2 / 12.4 MB" while a length is known, "받는 중" when it is not (#4019).
 *
 * The shared unit is printed once. Two units in one label ("3.2 MB / 12.4 MB")
 * makes the reader parse the string instead of the ratio, which is the only
 * thing the label is for.
 *
 * With no length there is no ratio, and a bare byte count is worse than none:
 * before the first chunk it read 「0 B」 and looked frozen (2026-10-16 staging
 * update run). The honest unknown is a word, not a number.
 */
export function progressLabel(
  downloaded: number,
  total: number | null
): string {
  if (total === null || total <= 0) return PROGRESS_UNKNOWN_LABEL;
  const done = formatBytes(downloaded);
  const all = formatBytes(total);
  const unit = all.slice(all.indexOf(" "));
  const short = done.endsWith(unit) ? done.slice(0, -unit.length) : done;
  return `${short} / ${all}`;
}

/** What the gauge says while the size is not known (no Content-Length yet). */
export const PROGRESS_UNKNOWN_LABEL = "받는 중";

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
 * When the last check ran, for 설정 > 업데이트 (#5661): month, day and minute in
 * the reader's locale. The point is to see that the app still asks — a date
 * that stopped moving is the six-day story told on screen. An unusable time is
 * dropped (null) rather than shown as "Invalid Date".
 */
export function formatCheckedAt(at: number, locale?: string): string | null {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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
      return "곧 다시 시작";
    default:
      return null;
  }
}

/** Seconds the 「곧 다시 시작돼요」 card counts down before restarting on its own. */
export const RELAUNCH_COUNTDOWN_SECONDS = 3;

/**
 * One line that says what 「지금 다시 시작」 stops while the restart waits for local work (#5661): terminal panes,
 * work sessions, and work it could not check. Counts come from the core verdict (`localWorkVerdict`).
 */
export function restartCutLine(
  cut: Extract<LocalWorkVerdict, { kind: "busy" }>,
  formatMessage: LocaleService["formatMessage"]
): string {
  const items: string[] = [];
  if (cut.panes > 0) items.push(formatMessage("settings.updates.cutPanes", { count: cut.panes }));
  if (cut.sessions > 0) items.push(formatMessage("settings.updates.cutSessions", { count: cut.sessions }));
  if (cut.unknown) items.push(formatMessage("settings.updates.cutUnknown"));
  return formatMessage("settings.updates.cutLine", { items: items.join(", ") });
}

/**
 * True when the profile row should carry the 「업데이트」 pill (owner 결정 2026-10-16).
 *
 * The pill stays for as long as an update exists: no dismiss, no snooze. That is
 * the three live states, plus an INSTALL failure (an update existed and the swap
 * broke). A failed CHECK is not on the list: an offline laptop does not know
 * there is an update, and a standing 「업데이트」 button it cannot honour would be
 * a regression from showing nothing.
 */
export function pillWorthShowing(state: UpdateState): boolean {
  return (
    state.kind === "available" ||
    state.kind === "installing" ||
    state.kind === "installed" ||
    (state.kind === "failed" && state.phase === "install")
  );
}

/**
 * The hover/focus tooltip for the pill. Plain sentences, no em-dash (house copy
 * rule), and one per state so the tooltip is the same fact the card will show.
 */
export function pillTooltip(state: UpdateState): string | null {
  switch (state.kind) {
    case "available":
      return `${state.update.version}로 업데이트할 수 있어요. 누르면 받고 다시 시작해요.`;
    case "installing": {
      const percent = progressPercent(state.downloaded, state.total);
      return percent === null ? "받는 중이에요." : `받는 중 ${percent}%`;
    }
    case "installed":
      return "곧 다시 시작돼요.";
    case "failed":
      return state.phase === "install"
        ? "업데이트하지 못했어요. 눌러서 다시 확인해요."
        : null;
    default:
      return null;
  }
}

export const RAIL_CARD_GAP = 8;
const RAIL_CARD_SIDE_OFFSET = 8;
/** 카드 폭(`w-pane-picker`)보다 넉넉한 값: 카드가 닿을 수 있는 가로 끝. */
const RAIL_CARD_REACH = 360;

/**
 * 접힌 레일의 카드가 아래쪽에 비워 둘 높이(#5661 수리 2회차 H2): 카드가 닿는 폭 안에 선 입력창 독(`data-composer-shell`) 가운데
 * 가장 높이 선 것의 위 끝보다 8px 위까지만 내려온다. 그래서 저절로 열린 카드가 쓰던 글을 가리지 않는다(대화 아래 귀퉁이는 덮을 수
 * 있다). 오른쪽 스레드 판처럼 카드가 닿지 않는 입력창과, 입력창이 없는 화면은 기본 여백 8px.
 */
export function railCardBottomPadding(pillRight: number, viewportHeight: number, composers: readonly DOMRectReadOnly[]): number {
  const reach = pillRight + RAIL_CARD_SIDE_OFFSET + RAIL_CARD_REACH;
  let top = viewportHeight;
  for (const r of composers) {
    if (r.width <= 0 || r.height <= 0 || r.left >= reach) continue;
    top = Math.min(top, r.top);
  }
  return Math.max(RAIL_CARD_GAP, viewportHeight - top + RAIL_CARD_GAP);
}
