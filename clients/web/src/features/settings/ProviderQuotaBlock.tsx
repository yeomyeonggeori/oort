import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { ApiError } from "@/lib/api";
import { fetchProviderQuotaSnapshots } from "./api";
import { errorMessage } from "./model";
import { StatusChip, type ChipTone } from "./SettingsFields";
import {
  QUOTA_TICK_MS,
  parseQuotaSnapshots,
  providerLabel,
  quotaAnnouncement,
  quotaErrorCopy,
  quotaGauge,
  quotaView,
  recallQuota,
  rememberQuota,
  windowLabel,
  type QuotaGauge,
  type QuotaProvider,
  type QuotaSnapshot,
  type QuotaTone,
  type QuotaWindow,
} from "./quotaModel";

// =============================================================================
// 설정 > 사용량 > 구독 잔여량 (ADR-0135 D2, MOMO-628).
//
// Reading this as: a settings panel for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// This is the RATE frame and it sits above the currency frame with a rule
// between them, because 레퍼런스 서베이 §5 found the two get confused wherever a
// product puts them in one column: a subscription is spent as a ratio of a
// window the provider owns, a bill is spent in dollars over a window you pick,
// and one number cannot be read as the other. So nothing in this block is
// denominated in money, the 기간/단위 controls belong to the block below it and
// deliberately sit under the rule, and the two frames are separated in the
// prose as well as in the layout.
//
// The shape is the pair every surveyed product converged on (§5): a short
// rolling window and a weekly one, two gauges, remaining rather than consumed,
// with the reset written as an absolute instant rather than a countdown. What
// this adds is honesty about the reading itself: a snapshot is a report from the
// server's own probe, so its age is on screen next to it, and a reading too old
// (or one whose window has already reset) keeps rendering with its state colour
// removed, because an hour-old 3% may have been 100% for the last 55 minutes.
//
// All four states are drawn INSIDE one bordered frame (R1 M2). The frame rule
// under this block is the boundary between the two frames, and a banner that
// draws its own full-bleed rule 16px above it puts the louder of two parallel
// lines where no boundary is. One box, one rule.
// =============================================================================

/**
 * The block's own clock.
 *
 * Age, staleness suppression and the reset having passed are all read against
 * "now", and R1 H1 measured that in this panel nothing ever moved it: no
 * `refetchInterval`, `refetchOnWindowFocus: false` in queryClient.ts, and a
 * healthy realtime connection produces no incidental re-render either (measured
 * over 90s with the panel open: 0 fetches, 1 unrelated DOM change). The gauges
 * therefore kept saying 마지막 확인 3분 전 indefinitely, never crossed into
 * 오래된 값, and kept a danger chip on a window that had already reset.
 *
 * This is a clock, not an animation, so it has no `prefers-reduced-motion`
 * branch: a reader who asked for less motion did not ask to be told the wrong
 * time. It is one interval for the whole block, so the gauges of one provider
 * can never be aged against two different instants.
 */
function useQuotaClock(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), QUOTA_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

export function ProviderQuotaBlock({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    // The endpoint takes no parameters, so the workspace is the whole key: the
    // 기간/단위 controls below the rule change the cost read and must not
    // invalidate this one.
    queryKey: ["settings", "quota", workspaceId.toLowerCase()],
    queryFn: async () => parseQuotaSnapshots(await fetchProviderQuotaSnapshots()),
    retry: false,
  });

  // Every successful answer becomes the fallback for the next failed one.
  useEffect(() => {
    if (query.data && query.dataUpdatedAt > 0) {
      rememberQuota(workspaceId, query.data, query.dataUpdatedAt);
    }
  }, [query.data, query.dataUpdatedAt, workspaceId]);

  const liveError = query.isError
    ? quotaErrorCopy(
        query.error instanceof ApiError ? query.error.status : null,
        errorMessage(query.error)
      )
    : null;

  // react-query clears the error the moment a data-less query refetches, so the
  // message would blink out and back for the length of every retry. The copy is
  // held for exactly that window and dropped as soon as the read finishes either
  // way.
  const held = useRef<string | null>(null);
  if (liveError) held.current = liveError;
  else if (!query.isFetching || query.data) held.current = null;

  const nowMs = useQuotaClock();
  const view = quotaView({
    data: query.data ?? null,
    dataUpdatedAtMs: query.dataUpdatedAt,
    errorMessage: liveError ?? held.current,
    // "paused" is react-query saying the browser is offline: the request was
    // never sent, so it will not fail and it will not finish.
    paused: query.fetchStatus === "paused",
    lastKnown: recallQuota(workspaceId),
    nowMs,
  });

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-busy={query.isFetching}
      data-testid="usage-quota"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-px">
          <h3 className="text-body font-medium text-ink">구독 잔여량</h3>
          {/* The frame statement. It says whose numbers these are (the server's
              provider subscriptions, not this workspace's ledger), which
              direction they fill (what is LEFT), and that they are not the money
              below, which is the one misread §5 found across the field. */}
          <p className="text-meta text-ink-muted">
            이 서버가 연결한 AI 구독에 지금 남은 비율입니다. 아래 비용 집계와는
            다른 값입니다.
          </p>
        </div>
        {/* The block's ONE refresh, in all four states (R1 M6). It used to share
            the job with a 다시 시도 in the error banner, a second 다시 시도 in the
            last-known banner and a 다시 불러오기 in the empty state, so one
            action carried three names and two of them were on screen at once.

            Stays ENABLED while fetching and reports the wait through aria-busy,
            because disabling it moves focus to <body> and never gives it back
            (the 616 lesson, SKILL §6). Being the only one, it also never
            unmounts, so a retry can no longer drop the keyboard. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (!query.isFetching) void query.refetch();
          }}
          aria-busy={query.isFetching}
          data-testid="usage-quota-refresh"
        >
          {query.isFetching ? "확인 중" : "다시 확인"}
        </Button>
      </div>

      {/* The skeleton bars are aria-hidden, so without this the wait and the
          arrival are both silent. Error and 마지막 확인값 stay out of it: their
          own banners are live regions. */}
      <p className="sr-only" role="status" data-testid="usage-quota-status">
        {quotaAnnouncement(view, nowMs)}
      </p>

      {/* One frame for every state, so the block is a box on the page rather
          than a stack of loose rules, and so the settled answer arrives inside
          the same boundary the wait was drawn in. */}
      <div
        className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
        data-testid="usage-quota-frame"
      >
        {view.kind === "loading" && <QuotaSkeleton />}

        {view.kind === "error" && (
          <InlineBanner
            message={view.message}
            separator={false}
            testId="usage-quota-error"
          />
        )}

        {view.kind === "last-known" && (
          <div className="flex min-w-0 flex-col" data-testid="usage-quota-last-known">
            {/* P15 durability layer: the cached answer keeps rendering,
                undimmed, and the banner carries the whole fallback in one line.
                §5 records the same behaviour as Claude Code's `Showing
                last-known usage`. Its border is a real separator here: the
                gauges it describes are directly underneath it. */}
            <InlineBanner
              tone="neutral"
              message={view.notice}
              testId="usage-quota-last-known-banner"
            />
            <QuotaBody
              providers={view.providers}
              empty={view.empty}
              nowMs={nowMs}
              elapsedMs={view.elapsedMs}
            />
          </div>
        )}

        {view.kind === "ready" && (
          <QuotaBody
            providers={view.providers}
            empty={view.empty}
            nowMs={nowMs}
            elapsedMs={view.elapsedMs}
          />
        )}
      </div>
    </section>
  );
}

// ---- loading ----------------------------------------------------------------

/**
 * The wait, shaped like what arrives (SKILL §5: height-preserving, no shimmer).
 *
 * Six generic `SkeletonRows` stood in for a shape they did not have, so every
 * arrival threw the whole ledger below it up or down the page by about 150px
 * (R1 M3). This mirrors the real structure instead: one provider heading and its
 * two gauges, each gauge a label line, a 4px bar and an 11px age line at the
 * real steps.
 *
 * One provider is what it stands in for, because that is what a server with one
 * AI 연결 sends, and it cannot stand in for all of them at once: the same read
 * answers with a 404, an empty list, one provider or several. Measured at 1280
 * (block height, wait -> settled): 404 231 -> 93, 빈 목록 231 -> 159, 1개
 * 231 -> 227, 2개 231 -> 400. The modal arrival now moves the ledger by 4px
 * instead of 157.
 */
function QuotaSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-3 px-3 py-3"
      aria-hidden="true"
      data-testid="usage-quota-skeleton"
    >
      <div className="h-6 w-pane-sm rounded-sm bg-surface-hover" />
      <GaugeSkeleton />
      <GaugeSkeleton />
    </div>
  );
}

function GaugeSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="h-6 rounded-sm bg-surface-hover" />
      <div className="h-1 rounded-sm bg-surface-hover" />
      <div className="h-4 w-pane rounded-sm bg-surface-hover" />
    </div>
  );
}

// ---- body, shared by the fresh and the last-known views ----------------------

function QuotaBody({
  providers,
  empty,
  nowMs,
  elapsedMs,
}: {
  providers: QuotaProvider[];
  empty: boolean;
  nowMs: number;
  elapsedMs: number;
}) {
  if (empty) {
    // A 200 with an empty list is the honest answer of a server that has not
    // probed its providers yet, and it is not a failure. One line, no centered
    // poster (SKILL §5). The action is the 다시 확인 in the header one row above:
    // this state has exactly the same next step as the other three, and giving
    // it a differently named button of its own was the R1 M6 finding.
    return (
      <EmptyInvite
        headline="아직 보고된 구독 잔여량이 없습니다."
        detail="이 서버가 AI 제공자에게서 잔여량을 받아오면 제공자별로 단기와 주간 남은 비율이 여기에 표시됩니다."
        testId="usage-quota-empty"
      />
    );
  }

  return (
    <ul className="flex min-w-0 flex-col">
      {providers.map((provider) => (
        <li
          key={provider.providerRef}
          className="flex min-w-0 flex-col gap-3 border-b border-line px-3 py-3 last:border-b-0"
          data-testid="usage-quota-provider"
          data-provider-ref={provider.providerRef}
        >
          {/* h4 under the block's h3: the section is 사용량 (h2), this block is
              구독 잔여량 (h3), and a provider is a thing inside it. Heading
              navigation lands on all three (SKILL §6). */}
          <h4 className="min-w-0 truncate text-body font-medium text-ink">
            {providerLabel(provider.providerRef)}
          </h4>
          <Gauge
            windowKind="short"
            snapshot={provider.short}
            nowMs={nowMs}
            elapsedMs={elapsedMs}
          />
          <Gauge
            windowKind="weekly"
            snapshot={provider.weekly}
            nowMs={nowMs}
            elapsedMs={elapsedMs}
          />
        </li>
      ))}
    </ul>
  );
}

/** The chip tone for a gauge that has one. `neutral` is the absence of a state
 *  rather than a fourth one, so it takes the muted chip: an outdated reading
 *  must not sit under a coloured chip it can no longer support. */
const CHIP_FOR_TONE: Record<QuotaTone, ChipTone> = {
  ok: "muted",
  warn: "warn",
  danger: "danger",
  neutral: "muted",
};

/** Only the two states worth colouring the figure for. An ok gauge keeps ink:
 *  green digits on every provider all day is colour with nothing to say. */
const PERCENT_TONE: Record<QuotaTone, string> = {
  ok: "text-ink",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-ink",
};

/**
 * One window's gauge: label and chip, the remaining figure, the bar, then the
 * two facts that decide whether the figure can be believed (when it resets, how
 * old it is).
 *
 * The bar is a native <progress>: CSP is style-src 'self' for anything this
 * codebase authors, so a data-driven width cannot come from an inline style and
 * the platform control draws it from value/max. It is aria-hidden because the
 * exact figure is already text on the same line, and its `data-tone` is driven
 * by the same value as the chip, so the two can never tell different stories
 * (tokens.md §5a).
 *
 * `windowKind`, not `window`: the parameter used to shadow the DOM global inside
 * this whole component, which reads as the global to anyone scanning it and
 * would have broken silently the first time anything here reached for
 * `window.matchMedia` (R1 M8).
 */
function Gauge({
  windowKind,
  snapshot,
  nowMs,
  elapsedMs,
}: {
  windowKind: QuotaWindow;
  snapshot: QuotaSnapshot | null;
  nowMs: number;
  elapsedMs: number;
}) {
  if (!snapshot) {
    // A server that reports one window and not the other leaves a real hole,
    // and a hole is stated. Drawing an empty bar here would read as 0% left.
    return (
      <div
        className="flex min-w-0 flex-wrap items-baseline justify-between gap-2"
        data-testid="usage-quota-gauge"
        data-window={windowKind}
        data-missing=""
      >
        <span className="text-meta text-ink-muted">{windowLabel(windowKind)}</span>
        <span className="text-meta text-ink-muted">
          아직 보고되지 않았습니다
        </span>
      </div>
    );
  }

  const gauge: QuotaGauge = quotaGauge(snapshot, nowMs, elapsedMs);

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="usage-quota-gauge"
      data-window={gauge.window}
      data-tone={gauge.tone}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-meta text-ink-muted">{gauge.windowLabel}</span>
          {/* Only where there is something the figure does not already say. A
              column of 여유 chips is a status board reporting that nothing is
              happening; colour on this block means "look at this one". */}
          {gauge.stateLabel && (
            <StatusChip tone={CHIP_FOR_TONE[gauge.tone]}>
              {gauge.stateLabel}
            </StatusChip>
          )}
        </span>
        {/* font-mono on the digits only. Monospacing 남음 stretches the gap
            between the two syllables into something that reads as broken, which
            is the same rule NumberRow keeps for its Korean values. */}
        <span
          className={cn("shrink-0 text-body", PERCENT_TONE[gauge.tone])}
          data-testid="usage-quota-remaining"
        >
          <span className="font-mono" data-numeric="">
            {gauge.remainingPercent}%
          </span>{" "}
          남음
        </span>
      </div>
      <progress
        className="progress-bar"
        data-tone={gauge.barTone}
        value={gauge.remainingPercent}
        max={100}
        aria-hidden="true"
      />
      {/* One 11px line, one treatment for the numbers in it: the clock and the
          age are both figures and both carry data-numeric (tokens.md §4). The
          clock used to be prose while the age beside it was tabular mono, which
          is visible at 11px as two different typefaces in one sentence
          (R1 M7). */}
      <p className="text-timestamp text-ink-muted">
        {gauge.reset && (
          <span data-testid="usage-quota-reset">
            {gauge.reset.day && `${gauge.reset.day} `}
            <span className="font-mono" data-numeric="">
              {gauge.reset.clock}
            </span>{" "}
            {gauge.reset.verb} ·{" "}
          </span>
        )}
        <span data-testid="usage-quota-age">
          마지막 확인{" "}
          {gauge.age.amount === null ? (
            "방금 전"
          ) : (
            <>
              <span className="font-mono" data-numeric="">
                {gauge.age.amount}
              </span>
              {gauge.age.unit} 전
            </>
          )}
        </span>
      </p>
      {/* The stronger of the two ways to be out of date gets its own line: once
          the window's reset instant is behind us the figure is not merely old,
          it describes a window that no longer exists. Said in words rather than
          left to the removed colour, because a missing colour is not a
          statement. */}
      {gauge.reset?.passed && (
        <p className="text-timestamp text-warn" data-testid="usage-quota-reset-passed">
          리셋 시각이 지나 지금 잔여율은 이 값과 다릅니다.
        </p>
      )}
      {gauge.age.stale && !gauge.reset?.passed && (
        <p className="text-timestamp text-warn" data-testid="usage-quota-outdated">
          확인한 지 오래된 값이라 지금 잔여율과 다를 수 있습니다.
        </p>
      )}
    </div>
  );
}
