// =============================================================================
// 프로바이더 잔여량의 순수 로직 (ADR-0135 D2 / MOMO-628).
//
// 계약 정본: GET /v1/provider/quota-snapshots
//   server/Sources/MomoServer/Routes/ProviderQuotaSnapshotRoutes.swift
//   (ProviderQuotaSnapshotListResponse / ProviderQuotaSnapshotDTO, track/engine)
//   ADR-0135 D2 + docs/planning/ENGINE_HANDOFF.md X-14
//
// This is the 사용량 panel's SECOND frame and it is deliberately not the first
// one's units. 616 answers "이 워크스페이스가 얼마를 썼나" in dollars over a
// window you pick; this answers "지금 이 서버의 구독이 얼마나 남았나" as a
// ratio over windows the provider owns. 레퍼런스 서베이 §5 found that mixing the
// two frames is the failure mode across the field (Cursor dropped its request
// counter into a dollar pool and its own forum could not tell what was left), so
// nothing in this file is denominated in money and nothing in usageModel.ts is
// denominated in percent.
//
// Three rules the gauges live under:
//   - the server probes, the client renders. momo never calls a provider quota
//     API (ADR-0004: 자격증명 비유입); the adapter that already holds the
//     credential POSTs the numbers in, so a snapshot is a report, not a reading.
//   - a gauge that cannot be trusted is never toned as if it could. An old 3%
//     may already have reset to 100%, so age suppresses the state colour instead
//     of being drawn beside it.
//   - nothing is invented for an absent field. A row with no ratio is dropped
//     rather than rendered as 0%, because "0% 남음" is the single most expensive
//     sentence this surface can say by accident.
// =============================================================================

/** The two windows the contract accepts. 레퍼런스 §5: Claude and Codex both
 *  publish a short rolling window and a weekly one, and that pair has become the
 *  de facto standard. Anything else on the wire is not a gauge we can name. */
export type QuotaWindow = "short" | "weekly";

export interface QuotaSnapshot {
  /** Operator-chosen provider slug, lower-cased by the server (043 CHECK). */
  providerRef: string;
  window: QuotaWindow;
  /** 0..1 remaining, NOT consumed. Codex's status line reports remaining and so
   *  does this surface; flipping the sense between the two is how a full bar
   *  ends up meaning "you are out". */
  remainingRatio: number;
  /** Absolute reset instant, or null when the provider reported none. */
  resetsAt: string | null;
  probedAt: string;
  ingestedAt: string;
  /** Server-computed at response time. Age is NOT derived from probedAt here:
   *  the two clocks are the adapter's and the browser's, and a laptop that is
   *  four minutes fast would otherwise report a probe from the future. */
  ageSeconds: number;
}

export interface QuotaSnapshots {
  observedAt: string;
  snapshots: QuotaSnapshot[];
}

// ---- parsing ----------------------------------------------------------------
//
// Tolerant on absence, strict on shape, and strict in one more place than
// usageModel: a row whose window or ratio cannot be read is DROPPED rather than
// defaulted. usageModel can read a missing number as 0 because a cost of 0 is a
// true statement about an empty ledger. A remaining ratio of 0 is a claim that
// the subscription is exhausted, which is a different and much louder thing to
// say by accident.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown> | null, key: string): string {
  const raw = source?.[key];
  return typeof raw === "string" ? raw : "";
}

function finiteNumber(
  source: Record<string, unknown> | null,
  key: string
): number | null {
  const raw = source?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parseWindow(raw: string): QuotaWindow | null {
  return raw === "short" || raw === "weekly" ? raw : null;
}

/** Ratio clamped into the track it is drawn in. The server already policed
 *  0...1; a value outside it is a contract violation, and the honest render of
 *  one is the nearest gauge the bar can actually draw. */
function clampRatio(ratio: number): number {
  return Math.min(1, Math.max(0, ratio));
}

export function parseQuotaSnapshots(raw: unknown): QuotaSnapshots {
  const root = asRecord(raw);
  if (!root) throw new Error("잔여량 응답을 읽지 못했습니다.");

  const rows = Array.isArray(root["snapshots"]) ? root["snapshots"] : [];
  const snapshots: QuotaSnapshot[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    const window = parseWindow(str(row, "window"));
    const ratio = finiteNumber(row, "remainingRatio");
    const providerRef = str(row, "providerRef").toLowerCase();
    // A window this client cannot name has no gauge to be drawn in, a row with
    // no ratio has no bar length, and a row with no provider has no heading.
    // All three are dropped: the panel then reports what it did receive and
    // says nothing about what it did not.
    if (!window || ratio === null || !providerRef) continue;
    const resets = str(row, "resetsAt");
    snapshots.push({
      providerRef,
      window,
      remainingRatio: clampRatio(ratio),
      resetsAt: resets || null,
      probedAt: str(row, "probedAt"),
      ingestedAt: str(row, "ingestedAt"),
      ageSeconds: Math.max(0, finiteNumber(row, "ageSeconds") ?? 0),
    });
  }

  return { observedAt: str(root, "observedAt"), snapshots };
}

// ---- grouping ---------------------------------------------------------------

/** One provider's pair of gauges. Either side can be absent: an adapter may
 *  report a weekly window and not a short one, and that is a fact to state
 *  rather than a hole to fill. */
export interface QuotaProvider {
  providerRef: string;
  short: QuotaSnapshot | null;
  weekly: QuotaSnapshot | null;
}

/**
 * Grouped in first-seen order. The server already sorts by provider_ref then
 * short-before-weekly, so preserving its order keeps the panel stable across
 * reads instead of re-sorting by a rule of our own that could disagree.
 */
export function groupByProvider(snapshots: QuotaSnapshot[]): QuotaProvider[] {
  const order: string[] = [];
  const byRef = new Map<string, QuotaProvider>();
  for (const snapshot of snapshots) {
    let provider = byRef.get(snapshot.providerRef);
    if (!provider) {
      provider = { providerRef: snapshot.providerRef, short: null, weekly: null };
      byRef.set(snapshot.providerRef, provider);
      order.push(snapshot.providerRef);
    }
    if (snapshot.window === "short") provider.short = snapshot;
    else provider.weekly = snapshot;
  }
  return order.map((ref) => byRef.get(ref)!);
}

/** An operator slug is the label. A row with no name gets a noun, never a blank
 *  heading (same rule as modelRowLabel in usageModel). */
export function providerLabel(providerRef: string): string {
  return providerRef.trim() || "이름 없는 프로바이더";
}

const WINDOW_LABELS: Record<QuotaWindow, string> = {
  short: "짧은 창",
  weekly: "주간",
};

export function windowLabel(window: QuotaWindow): string {
  return WINDOW_LABELS[window];
}

// ---- age --------------------------------------------------------------------

/**
 * Beyond an hour a remaining-ratio is telemetry, not a gauge: the short window
 * on every provider surveyed (§5) is measured in hours, so an hour-old reading
 * can be off by most of the window. Past this the number keeps rendering with
 * its age stated and loses its state colour.
 */
export const QUOTA_FRESH_SECONDS = 3_600;

/**
 * The server's age plus however long its answer has been sitting in this tab.
 *
 * Nothing re-renders this panel on a timer, so a bare `ageSeconds` would freeze
 * at whatever it said when the response landed and quietly start lying about its
 * own age. Adding the elapsed time means every render (react-query refetches on
 * window focus, so returning to the tab is one) recomputes it upward, and the
 * 마지막 확인값 branch is measured from the instant it was actually confirmed.
 */
export function agedSeconds(snapshot: QuotaSnapshot, elapsedMs: number): number {
  return snapshot.ageSeconds + Math.max(0, Math.floor(elapsedMs / 1000));
}

/**
 * The number and its unit, kept apart so the component can put `data-numeric`
 * on the figure alone. `amount: null` is "under a minute", which has a word
 * ("방금 전") and no number worth printing.
 */
export interface QuotaAge {
  amount: number | null;
  unit: string;
  /** Past QUOTA_FRESH_SECONDS: still shown, no longer toned. */
  stale: boolean;
}

export function quotaAge(seconds: number): QuotaAge {
  const stale = seconds >= QUOTA_FRESH_SECONDS;
  if (seconds < 60) return { amount: null, unit: "", stale };
  if (seconds < 3_600) {
    return { amount: Math.floor(seconds / 60), unit: "분", stale };
  }
  if (seconds < 86_400) {
    return { amount: Math.floor(seconds / 3_600), unit: "시간", stale };
  }
  return { amount: Math.floor(seconds / 86_400), unit: "일", stale };
}

// ---- reset instant ----------------------------------------------------------

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Whole local calendar days between two instants, so 23:59 to 00:01 is one day
 *  apart and not zero. */
function calendarDayDelta(fromMs: number, toMs: number): number {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toDay.getTime() - fromDay.getTime()) / 86_400_000);
}

/**
 * The absolute reset instant, which is what every surveyed product prints
 * (§5: `resets 3:45pm`, `resets Mon 12:00am`, `Resets 10:16 PM`) and what a
 * countdown cannot be, because nothing re-renders this panel on a timer.
 *
 * The day word is only a weekday inside the week it can be read in. A bare
 * 월요일 six days out and a bare 월요일 next month are the same three
 * characters, so anything past this week falls back to the date.
 */
export interface QuotaReset {
  text: string;
  /** The instant is already behind us: the ratio beside it predates a reset. */
  passed: boolean;
}

export function quotaReset(iso: string | null, nowMs: number): QuotaReset | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;

  const at = new Date(ms);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const delta = calendarDayDelta(nowMs, ms);

  let day: string;
  if (delta === 0) day = "오늘";
  else if (delta === 1) day = "내일";
  else if (delta === -1) day = "어제";
  else if (delta > 1 && delta <= 6) day = `${WEEKDAYS[at.getDay()]}요일`;
  else {
    day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  }

  const passed = ms <= nowMs;
  return { text: `${day} ${clock} ${passed ? "리셋됨" : "리셋"}`, passed };
}

// ---- one gauge --------------------------------------------------------------

/** `neutral` is not a fourth severity, it is the absence of one: a reading old
 *  enough to have been overtaken by a reset gets no state colour at all. */
export type QuotaTone = "ok" | "warn" | "danger" | "neutral";

export interface QuotaGauge {
  window: QuotaWindow;
  windowLabel: string;
  /** 0..100, floored so 0.999 never rounds up into a 100% that is not true. */
  remainingPercent: number;
  /** The truth about the reading. Drives the figure's colour and the chip's. */
  tone: QuotaTone;
  /**
   * What the bar draws, which is the chip's tone or nothing.
   *
   * tokens.md §5a says a state bar names its tone in EVERY state including ok,
   * so a green chip never sits beside an amber bar. That rule was written for
   * the 예산 block, which is ONE bar; this block is up to two per provider, and
   * a column of 여유 chips over green bars is a status board reporting that
   * nothing is happening. So the calm state is given neither: no chip, a
   * neutral bar, and the figure in ink. The invariant §5a protects still holds
   * because the chip and the bar are still driven by one value, and colour here
   * only ever means "look at this one".
   */
  barTone: "neutral" | "warn" | "danger";
  /** Chip copy, null when the gauge has nothing the number does not say. */
  stateLabel: string | null;
  age: QuotaAge;
  reset: QuotaReset | null;
  /** The value is old, or its window has reset since it was taken. */
  outdated: boolean;
}

/** Under a tenth left is 임박, under a quarter is 주의. The split mirrors the
 *  예산 block's soft/hard shape so one panel does not carry two ideas of "close
 *  to the edge", and like that block it claims nothing about enforcement: momo
 *  does not block a run on a provider's say-so. */
export const QUOTA_DANGER_RATIO = 0.1;
export const QUOTA_WARN_RATIO = 0.25;

export function quotaGauge(
  snapshot: QuotaSnapshot,
  nowMs: number,
  elapsedMs: number
): QuotaGauge {
  const seconds = agedSeconds(snapshot, elapsedMs);
  const age = quotaAge(seconds);
  const reset = quotaReset(snapshot.resetsAt, nowMs);
  // Two independent ways to be out of date, and the second is the stronger one:
  // once the window's own reset instant is behind us the ratio is not stale, it
  // is about a window that no longer exists.
  const outdated = age.stale || reset?.passed === true;

  const tone: QuotaTone = outdated
    ? "neutral"
    : snapshot.remainingRatio < QUOTA_DANGER_RATIO
      ? "danger"
      : snapshot.remainingRatio < QUOTA_WARN_RATIO
        ? "warn"
        : "ok";

  const stateLabel =
    tone === "neutral"
      ? "오래된 값"
      : tone === "danger"
        ? "임박"
        : tone === "warn"
          ? "주의"
          : null;

  return {
    window: snapshot.window,
    windowLabel: windowLabel(snapshot.window),
    remainingPercent: Math.floor(snapshot.remainingRatio * 100),
    tone,
    barTone: tone === "warn" || tone === "danger" ? tone : "neutral",
    stateLabel,
    age,
    reset,
    outdated,
  };
}

/** The gauge a person needs to see first: the lowest live one, ignoring any
 *  reading too old to mean anything. Used for the live region sentence, never
 *  to replace a bar. */
export function lowestGauge(
  providers: QuotaProvider[],
  nowMs: number,
  elapsedMs: number
): { providerRef: string; gauge: QuotaGauge } | null {
  let lowest: { providerRef: string; gauge: QuotaGauge } | null = null;
  for (const provider of providers) {
    for (const snapshot of [provider.short, provider.weekly]) {
      if (!snapshot) continue;
      const gauge = quotaGauge(snapshot, nowMs, elapsedMs);
      if (gauge.outdated) continue;
      if (!lowest || gauge.remainingPercent < lowest.gauge.remainingPercent) {
        lowest = { providerRef: provider.providerRef, gauge };
      }
    }
  }
  return lowest;
}

// ---- failure copy -----------------------------------------------------------

/**
 * Two answers this endpoint gives that a bare status code would waste. 404 is
 * the live case for as long as a server predates the ADR-0135 engine layer
 * (momowebqa answers exactly this today), and 403 is a membership answer, not a
 * network one, so "다시 시도" would be the wrong next step to offer.
 */
export function quotaErrorCopy(status: number | null, fallback: string): string {
  if (status === 404) {
    return "이 서버는 아직 구독 잔여량을 제공하지 않습니다. 서버를 업데이트한 뒤 다시 열어보세요.";
  }
  if (status === 403) {
    return "이 워크스페이스의 멤버만 구독 잔여량을 볼 수 있습니다.";
  }
  return fallback;
}

// ---- 마지막 확인값 (the durability layer, P15) --------------------------------
//
// 616 grammar, reused: a failed read does not blank a surface that already had
// an answer, and the cached answer renders undimmed with the instant it was
// confirmed stated on it. 레퍼런스 §5 records the same behaviour as Claude Code's
// `Showing last-known usage`, and it matters more here than on the cost frame,
// because a product whose agents keep running must not show an empty quota
// screen at the moment someone is asking whether they can keep running.
//
// The 616 cache-key lesson, applied rather than copied. There the key had to
// carry the WINDOW as well as the workspace, because a 7일 failure answered with
// a 30일 total put the control and the number in disagreement. This read takes
// no parameters at all: one workspace has exactly one answer, so the workspace
// IS the whole key, and quotaModel.test.ts pins that the 사용량 기간/단위 controls
// cannot reach this cache.
//
// Memory only, never storage: `forgetQuota()` runs on sign-out beside
// queryClient.clear(), so no server's provider state survives into the next
// session in the same tab.

export interface LastKnownQuota {
  snapshots: QuotaSnapshots;
  checkedAtMs: number;
}

const lastKnown = new Map<string, LastKnownQuota>();

/** Lower-cased: the same workspace arrives upper-cased from other surfaces and
 *  must not open a second cache entry. */
function cacheKey(workspaceId: string): string {
  return workspaceId.toLowerCase();
}

export function rememberQuota(
  workspaceId: string,
  snapshots: QuotaSnapshots,
  checkedAtMs: number
): void {
  lastKnown.set(cacheKey(workspaceId), { snapshots, checkedAtMs });
}

export function recallQuota(workspaceId: string): LastKnownQuota | null {
  return lastKnown.get(cacheKey(workspaceId)) ?? null;
}

export function forgetQuota(workspaceId?: string): void {
  if (workspaceId === undefined) {
    lastKnown.clear();
    return;
  }
  lastKnown.delete(cacheKey(workspaceId));
}

// ---- which of the four states the block is in -------------------------------

export interface QuotaViewInput {
  data: QuotaSnapshots | null;
  /** When `data` arrived. react-query keeps data across a failed refetch, and
   *  that data is by definition a last-known value, not a live one. */
  dataUpdatedAtMs: number;
  /** Already mapped to Korean copy by the caller. */
  errorMessage: string | null;
  /** react-query `fetchStatus === "paused"`: offline, so the request was never
   *  sent and no error will arrive either. Without this branch a paused query
   *  holds the skeleton for as long as the connection is out. */
  paused: boolean;
  lastKnown: LastKnownQuota | null;
  nowMs: number;
}

export type QuotaView =
  | { kind: "loading" }
  | {
      kind: "ready";
      providers: QuotaProvider[];
      empty: boolean;
      /** 0 for a live answer; how long a cached one has been held otherwise. */
      elapsedMs: number;
    }
  | {
      kind: "last-known";
      providers: QuotaProvider[];
      empty: boolean;
      notice: string;
      checkedAtMs: number;
      elapsedMs: number;
    }
  | { kind: "error"; message: string };

const OFFLINE_REASON = "연결이 끊겼습니다.";
const OFFLINE_EMPTY = "연결이 끊겼습니다. 다시 연결되면 잔여량을 불러옵니다.";

/** Local day and clock for "언제 확인한 값인가". Absolute, not relative: the
 *  banner is written once and nothing re-renders it on a timer. */
export function formatCheckedAt(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Fresh data wins, a stalled read falls back to the last confirmed answer with
 * a label on it, and nothing to fall back on says so plainly.
 *
 * The failure branches are checked BEFORE the ready branch on purpose: data on
 * screen while the current read cannot complete is a last-known value whether
 * the read failed or was never sent, and passing an old ratio off as the live
 * one is the failure this fallback exists to prevent.
 */
export function quotaView(input: QuotaViewInput): QuotaView {
  const fallback: LastKnownQuota | null =
    input.data && input.dataUpdatedAtMs > 0
      ? { snapshots: input.data, checkedAtMs: input.dataUpdatedAtMs }
      : input.lastKnown;

  const held = (reason: string, cached: LastKnownQuota): QuotaView => ({
    kind: "last-known",
    providers: groupByProvider(cached.snapshots.snapshots),
    empty: cached.snapshots.snapshots.length === 0,
    notice: `${reason} ${formatCheckedAt(cached.checkedAtMs)}에 확인한 값을 표시합니다.`,
    checkedAtMs: cached.checkedAtMs,
    elapsedMs: Math.max(0, input.nowMs - cached.checkedAtMs),
  });

  if (input.errorMessage) {
    return fallback
      ? held(input.errorMessage, fallback)
      : { kind: "error", message: input.errorMessage };
  }
  if (input.paused) {
    return fallback
      ? held(OFFLINE_REASON, fallback)
      : { kind: "error", message: OFFLINE_EMPTY };
  }
  if (input.data) {
    return {
      kind: "ready",
      providers: groupByProvider(input.data.snapshots),
      empty: input.data.snapshots.length === 0,
      elapsedMs:
        input.dataUpdatedAtMs > 0
          ? Math.max(0, input.nowMs - input.dataUpdatedAtMs)
          : 0,
    };
  }
  return { kind: "loading" };
}

/**
 * One sentence for the block's live region: the wait, then the number that
 * matters. Error and 마지막 확인값 stay silent here because each already renders
 * its own role=alert / role=status banner, and two live regions reading the same
 * sentence read it twice.
 */
export function quotaAnnouncement(view: QuotaView, nowMs: number): string {
  if (view.kind === "loading") return "구독 잔여량을 불러오는 중입니다.";
  if (view.kind !== "ready") return "";
  if (view.empty) return "보고된 구독 잔여량이 없습니다.";
  const lowest = lowestGauge(view.providers, nowMs, view.elapsedMs);
  if (!lowest) {
    return "구독 잔여량을 불러왔습니다. 모두 확인한 지 오래된 값입니다.";
  }
  return (
    `구독 잔여량을 불러왔습니다. 가장 적게 남은 창은 ` +
    `${providerLabel(lowest.providerRef)} ${lowest.gauge.windowLabel} ` +
    `${lowest.gauge.remainingPercent}% 남음입니다.`
  );
}
