import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { ApiError } from "@/lib/api";
import { fetchProviderQuotaSnapshots } from "./api";
import { errorMessage } from "./model";
import { StatusChip, type ChipTone } from "./SettingsFields";
import {
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
// this adds is honesty about the reading itself: a snapshot is a report from an
// adapter, so its age is on screen next to it, and a reading too old (or one
// whose window has already reset) keeps rendering with its state colour
// removed, because an hour-old 3% may have been 100% for the last 55 minutes.
// =============================================================================

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
  // banner would unmount under the very button that started the retry and drop
  // keyboard focus to <body> (SKILL §6). The copy is held for exactly that
  // window and dropped as soon as the read finishes either way.
  const held = useRef<string | null>(null);
  if (liveError) held.current = liveError;
  else if (!query.isFetching || query.data) held.current = null;

  // One clock for the whole render, so the two gauges of one provider cannot be
  // aged against two different instants.
  const nowMs = Date.now();
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
              provider subscriptions, not this workspace's ledger) and that they
              are not the money below, which is the one misread §5 found across
              the field. */}
          <p className="text-meta text-ink-muted">
            이 서버가 연결한 AI 구독의 창별 잔여 비율입니다. 아래 비용 집계와는
            다른 값입니다.
          </p>
        </div>
        {/* Its own refresh, not the cost block's: a gauge whose point is
            freshness needs a way to ask again without re-reading the ledger.
            Stays ENABLED while fetching and reports the wait through aria-busy,
            because disabling it moves focus to <body> and never gives it back
            (the 616 lesson, SKILL §6). */}
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

      {view.kind === "loading" && (
        <div
          className="rounded-md border border-line"
          aria-hidden="true"
          data-testid="usage-quota-skeleton"
        >
          <SkeletonRows rows={6} />
        </div>
      )}

      {view.kind === "error" && (
        <InlineBanner
          message={view.message}
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="usage-quota-error"
        />
      )}

      {view.kind === "last-known" && (
        <div
          className="flex min-w-0 flex-col gap-3"
          data-testid="usage-quota-last-known"
        >
          {/* P15 durability layer: the cached answer keeps rendering, undimmed,
              and the banner carries the whole fallback in one line. §5 records
              the same behaviour as Claude Code's `Showing last-known usage`. */}
          <InlineBanner
            tone="neutral"
            message={view.notice}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="usage-quota-last-known-banner"
          />
          <QuotaBody
            providers={view.providers}
            empty={view.empty}
            nowMs={nowMs}
            elapsedMs={view.elapsedMs}
            onRetry={() => void query.refetch()}
          />
        </div>
      )}

      {view.kind === "ready" && (
        <QuotaBody
          providers={view.providers}
          empty={view.empty}
          nowMs={nowMs}
          elapsedMs={view.elapsedMs}
          onRetry={() => void query.refetch()}
        />
      )}
    </section>
  );
}

// ---- body, shared by the fresh and the last-known views ----------------------

function QuotaBody({
  providers,
  empty,
  nowMs,
  elapsedMs,
  onRetry,
}: {
  providers: QuotaProvider[];
  empty: boolean;
  nowMs: number;
  elapsedMs: number;
  onRetry: () => void;
}) {
  if (empty) {
    // A 200 with an empty list is the honest answer of a server whose adapter
    // has not probed yet, and it is not a failure. One line and one action, no
    // centered poster (SKILL §5).
    return (
      <EmptyInvite
        headline="아직 보고된 구독 잔여량이 없습니다."
        detail="AI 어댑터가 잔여량을 보고하면 프로바이더별로 짧은 창과 주간 잔여 비율이 여기에 표시됩니다."
        testId="usage-quota-empty"
        actions={
          <Button variant="outline" size="sm" onClick={onRetry}>
            다시 불러오기
          </Button>
        }
      />
    );
  }

  return (
    <ul className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
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
            window="short"
            snapshot={provider.short}
            nowMs={nowMs}
            elapsedMs={elapsedMs}
          />
          <Gauge
            window="weekly"
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
 * exact figure is already text on the same line, and it carries the same
 * data-tone as the chip in every state including ok, so the two can never tell
 * different stories (tokens.md §5a).
 */
function Gauge({
  window,
  snapshot,
  nowMs,
  elapsedMs,
}: {
  window: QuotaWindow;
  snapshot: QuotaSnapshot | null;
  nowMs: number;
  elapsedMs: number;
}) {
  if (!snapshot) {
    // An adapter that reports one window and not the other leaves a real hole,
    // and a hole is stated. Drawing an empty bar here would read as 0% left.
    return (
      <div
        className="flex min-w-0 flex-wrap items-baseline justify-between gap-2"
        data-testid="usage-quota-gauge"
        data-window={window}
        data-missing=""
      >
        <span className="text-meta text-ink-muted">{windowLabel(window)}</span>
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
      <p className="text-timestamp text-ink-muted">
        {gauge.reset && <>{gauge.reset.text} · </>}
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
