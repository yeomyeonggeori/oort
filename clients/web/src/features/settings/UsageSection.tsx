import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
// The one cost formatter in this client. A second rounding rule would mean two
// different answers to "how much did this cost" on two surfaces.
import { formatCount, formatMicroUsd } from "@/features/timeline/agentCardModel";
// The roster is what turns a member id into a name, and a name into an
// unambiguous one. It is already fetched for the sidebar and the directory, so
// this is a cache read, not a second request.
import {
  isAmbiguousName,
  memberFor,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { ApiError } from "@/lib/api";
import { fetchUsageSummary } from "./api";
import { errorMessage } from "./model";
import { SectionShell, StatusChip } from "./SettingsFields";
import {
  USAGE_BUCKETS,
  USAGE_PERIODS,
  agentRowLabel,
  barShare,
  budgetGrainLabel,
  budgetStatus,
  costConfidence,
  formatBucketStart,
  formatClock,
  formatIsoDay,
  formatRange,
  largestCost,
  modelRowLabel,
  parseUsageSummary,
  peakBucket,
  recallUsage,
  rememberUsage,
  usageAnnouncement,
  usageErrorCopy,
  usageQuery,
  usageView,
  type UsageBucketUnit,
  type UsagePeriodId,
  type UsageSummary,
} from "./usageModel";

// =============================================================================
// 설정 > 사용량 (AX-7 1층, MOMO-616).
//
// Reading this as: a settings panel for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// Costs are the one number in this product a person checks to decide whether to
// keep an agent running, so the panel is a dense ledger, not a dashboard: flat
// rows with a proportional bar, one grouped block for the totals, and no card
// per model. The bars are native <progress> elements because CSP is
// style-src 'self' and a data-driven width cannot come from an inline style;
// the platform control draws it from value/max.
//
// Everything on screen is server-reported. The client does not add up the
// ledger, does not decide which side of a budget limit the workspace is on, and
// does not turn an estimate into a bill: `estimatedMicroUsd` is stated as its
// own figure so the confidence of the total is visible rather than implied.
// =============================================================================

export function UsageSection({ workspaceId }: { workspaceId: string }) {
  const [period, setPeriod] = useState<UsagePeriodId>("30d");
  const [bucket, setBucket] = useState<UsageBucketUnit>("day");
  const { directory } = useDirectory(workspaceId);

  const query = useQuery({
    // The workspace id is lower-cased in the key: the same workspace arriving
    // upper-cased from a different surface must not open a second cache entry.
    queryKey: ["settings", "usage", workspaceId.toLowerCase(), period, bucket],
    queryFn: async () =>
      parseUsageSummary(
        await fetchUsageSummary(
          workspaceId,
          usageQuery(period, bucket, Date.now())
        )
      ),
    retry: false,
  });

  // Every successful answer becomes the fallback for the next failed one.
  useEffect(() => {
    if (query.data) {
      rememberUsage(workspaceId, query.data, query.dataUpdatedAt || Date.now());
    }
  }, [query.data, query.dataUpdatedAt, workspaceId]);

  const view = usageView({
    data: query.data ?? null,
    dataUpdatedAtMs: query.dataUpdatedAt,
    errorMessage: query.isError
      ? usageErrorCopy(
          query.error instanceof ApiError ? query.error.status : null,
          errorMessage(query.error)
        )
      : null,
    // "paused" is react-query saying the browser is offline, so the request was
    // never sent: it will not fail and it will not finish. Anything else, the
    // realtime rail included, says nothing about whether this REST read works.
    paused: query.fetchStatus === "paused",
    lastKnown: recallUsage(workspaceId),
    nowMs: Date.now(),
  });

  const lines = [
    "이 워크스페이스에서 에이전트가 쓴 비용과 토큰입니다.",
    "워크스페이스 멤버라면 누구나 볼 수 있습니다.",
  ];

  return (
    <SectionShell title="사용량" lines={lines}>
      <div
        className="flex flex-wrap items-center gap-4"
        data-testid="usage-controls"
      >
        <Segmented
          name="usage-period"
          label="기간"
          options={USAGE_PERIODS.map((p) => ({ id: p.id, label: p.label }))}
          value={period}
          onChange={(id) => setPeriod(id as UsagePeriodId)}
        />
        <Segmented
          name="usage-bucket"
          label="단위"
          options={USAGE_BUCKETS.map((b) => ({ id: b.id, label: b.label }))}
          value={bucket}
          onChange={(id) => setBucket(id as UsageBucketUnit)}
        />
        {/* Bordered, not ghost: this sits between two bordered segmented groups
            and a borderless label there does not read as something to press. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          data-testid="usage-refresh"
        >
          {query.isFetching ? "불러오는 중" : "새로 고치기"}
        </Button>
      </div>

      {/* The skeleton bars are aria-hidden and the deadline is 15 seconds, so
          without this the wait and the arrival are both silent. Error and
          마지막 확인값 stay out of it: their own banners are live regions. */}
      <p className="sr-only" role="status" data-testid="usage-status">
        {usageAnnouncement(view, formatMicroUsd)}
      </p>

      <div
        className="flex min-w-0 flex-col gap-4"
        aria-busy={view.kind === "loading"}
        data-testid="usage-panel"
      >
        {view.kind === "loading" && <SkeletonRows rows={5} />}

        {view.kind === "error" && (
          <InlineBanner
            message={view.message}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="usage-error"
          />
        )}

        {view.kind === "last-known" && (
          <div
            className="flex min-w-0 flex-col gap-3"
            data-testid="usage-last-known"
          >
            {/* P15 durability layer: the cached answer keeps rendering,
                undimmed, with the instant it was confirmed stated next to it.
                The range it covers is stated once, by the block below: the
                cached range and the selected one can differ, and the block
                header is where the numbers it labels actually are. */}
            <InlineBanner
              tone="neutral"
              message={view.notice}
              actionLabel="다시 시도"
              onAction={() => void query.refetch()}
              testId="usage-last-known-banner"
            />
            <p className="text-meta text-ink-muted">
              마지막 확인{" "}
              <time dateTime={new Date(view.checkedAtMs).toISOString()}>
                {formatClock(view.checkedAtMs)}
              </time>
            </p>
            <UsageBody
              summary={view.summary}
              empty={view.empty}
              period={period}
              directory={directory}
              onWiden={() => setPeriod("30d")}
              onRetry={() => void query.refetch()}
            />
          </div>
        )}

        {view.kind === "ready" && (
          <UsageBody
            summary={view.summary}
            empty={view.empty}
            period={period}
            directory={directory}
            onWiden={() => setPeriod("30d")}
            onRetry={() => void query.refetch()}
          />
        )}
      </div>
    </SectionShell>
  );
}

// ---- the panel body, shared by the fresh and the last-known views ------------

function UsageBody({
  summary,
  empty,
  period,
  directory,
  onWiden,
  onRetry,
}: {
  summary: UsageSummary;
  empty: boolean;
  period: UsagePeriodId;
  directory: Directory;
  onWiden: () => void;
  onRetry: () => void;
}) {
  if (empty) {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="usage-body">
        <p className="text-meta text-ink-muted">{formatRange(summary.range)}</p>
        <EmptyInvite
          headline="이 기간에 기록된 사용량이 없습니다."
          detail="에이전트가 실행되면 모델별, 에이전트별 비용이 여기에 쌓입니다."
          testId="usage-empty"
          actions={
            period === "7d" ? (
              <Button variant="outline" size="sm" onClick={onWiden}>
                30일로 보기
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onRetry}>
                다시 불러오기
              </Button>
            )
          }
        />
      </div>
    );
  }

  const confidence = costConfidence(summary.totals);
  const peak = peakBucket(summary.buckets);
  const modelMax = largestCost(summary.byModel);
  const agentMax = largestCost(summary.byAgent);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="usage-body">
      <div
        className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-raised p-4"
        data-testid="usage-totals"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-meta text-ink-muted">{formatRange(summary.range)}</p>
          {confidence.allSettled ? (
            <StatusChip tone="ok">확정 값</StatusChip>
          ) : (
            <StatusChip tone="warn">추정 포함</StatusChip>
          )}
        </div>

        {/* text-display carries the emphasis; a third weight in this tree would
            be size inflation dressed as hierarchy (SKILL §3: max 2 per
            component, and the h3s below are already the medium one). */}
        <p
          className="font-mono text-display font-medium text-ink"
          data-numeric=""
          data-testid="usage-total-cost"
        >
          {formatMicroUsd(summary.totals.costMicroUsd)}
        </p>
        <p className="text-meta text-ink-muted">
          {confidence.allSettled
            ? "provider가 확정한 청구 값입니다."
            : "provider가 아직 확정하지 않은 부분이 있어 두 값을 나눠 적습니다."}
        </p>

        <dl className="flex min-w-0 flex-col gap-2">
          {!confidence.allSettled && (
            <>
              <NumberRow
                term="확정"
                value={formatMicroUsd(confidence.settledMicroUsd)}
              />
              <NumberRow
                term="추정"
                value={`${formatMicroUsd(confidence.estimatedMicroUsd)} (${confidence.estimatedPercent}%)`}
                testId="usage-estimated"
              />
            </>
          )}
          <NumberRow
            term="입력 토큰"
            value={formatCount(summary.totals.promptTokens)}
          />
          <NumberRow
            term="출력 토큰"
            value={formatCount(summary.totals.completionTokens)}
          />
          {peak && (
            <NumberRow
              term={`가장 비쌌던 ${bucketNoun(summary.range.bucket)}`}
              value={`${formatBucketStart(peak.start, summary.range.bucket)} · ${formatMicroUsd(peak.costMicroUsd)}`}
            />
          )}
        </dl>
      </div>

      <BudgetBlock summary={summary} />

      <Breakdown
        title="모델별"
        testId="usage-model"
        emptyCopy="이 기간에 기록된 모델이 없습니다."
        rows={summary.byModel.map((row) => ({
          key: row.model,
          label: modelRowLabel(row.model),
          handle: null,
          costMicroUsd: row.costMicroUsd,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          share: barShare(row.costMicroUsd, modelMax),
        }))}
      />

      <Breakdown
        title="에이전트별"
        testId="usage-agent"
        emptyCopy="이 기간에 기록된 에이전트가 없습니다."
        rows={summary.byAgent.map((row) => {
          // The ledger sends an id and a name; the roster is what says whether
          // that name belongs to one member or to two of them.
          const member = memberFor(directory, row.agentMemberId);
          const label = agentRowLabel(
            row,
            member
              ? {
                  displayName: member.displayName,
                  handle: member.handle,
                  ambiguous: isAmbiguousName(directory, member),
                }
              : null
          );
          return {
            key: row.agentMemberId,
            label: label.text,
            handle: label.handle,
            costMicroUsd: row.costMicroUsd,
            promptTokens: row.promptTokens,
            completionTokens: row.completionTokens,
            share: barShare(row.costMicroUsd, agentMax),
          };
        })}
      />

      {summary.buckets.length > 0 && (
        <details className="min-w-0 rounded-md border border-line" data-testid="usage-buckets">
          <summary className="cursor-pointer px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            기간별로 자세히 보기 (
            <span className="font-mono" data-numeric="">
              {summary.buckets.length}
            </span>
            개 구간)
          </summary>
          <ul className="max-h-pane overflow-y-auto border-t border-line">
            {summary.buckets.map((row) => (
              <li
                key={row.start}
                className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line px-3 py-1 last:border-b-0"
                data-testid="usage-bucket-row"
              >
                <span className="min-w-0 truncate text-meta text-ink">
                  {formatBucketStart(row.start, summary.range.bucket)}
                </span>
                <span
                  className="shrink-0 font-mono text-meta text-ink"
                  data-numeric=""
                >
                  {formatMicroUsd(row.costMicroUsd)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function bucketNoun(bucket: UsageBucketUnit): string {
  if (bucket === "week") return "주";
  if (bucket === "month") return "달";
  return "날";
}

// ---- parts ------------------------------------------------------------------

/** One dense key/value line. dt left and muted, dd right and monospaced. */
function NumberRow({
  term,
  value,
  testId,
}: {
  term: string;
  value: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="min-w-0 truncate text-meta text-ink-muted">{term}</dt>
      <dd
        className="shrink-0 font-mono text-meta text-ink"
        data-numeric=""
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

interface BreakdownRow {
  key: string;
  label: string;
  /** "@handle", only where the label alone names two different members. */
  handle: string | null;
  costMicroUsd: number;
  promptTokens: number;
  completionTokens: number;
  share: number;
}

/**
 * Flat rows with a bar, not a card per row. The bar is relative to the largest
 * row rather than to the total, so the second and third lines stay readable
 * when one model dominates, and it is aria-hidden because the exact figure is
 * already text on the same line. It is toned neutral: this bar states a
 * proportion, and the accent belongs to the one bar on this surface that states
 * a state (예산).
 */
function Breakdown({
  title,
  rows,
  emptyCopy,
  testId,
}: {
  title: string;
  rows: BreakdownRow[];
  emptyCopy: string;
  testId: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-body font-medium text-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-meta text-ink-muted">{emptyCopy}</p>
      ) : (
        <ul className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex min-w-0 flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0"
              data-testid={`${testId}-row`}
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2 truncate">
                  <span className="min-w-0 truncate text-body text-ink">
                    {row.label}
                  </span>
                  {row.handle && (
                    <span className="shrink-0 text-meta text-ink-muted">
                      {row.handle}
                    </span>
                  )}
                </span>
                <span
                  className="shrink-0 font-mono text-body text-ink"
                  data-numeric=""
                >
                  {formatMicroUsd(row.costMicroUsd)}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-3">
                <progress
                  className="progress-bar min-w-0 flex-1"
                  data-tone="neutral"
                  value={row.share}
                  max={100}
                  aria-hidden="true"
                />
                <span className="shrink-0 text-timestamp text-ink-muted">
                  입력{" "}
                  <span className="font-mono" data-numeric="">
                    {formatCount(row.promptTokens)}
                  </span>{" "}
                  · 출력{" "}
                  <span className="font-mono" data-numeric="">
                    {formatCount(row.completionTokens)}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Budget state as the server projected it. No enforcement is claimed here. */
function BudgetBlock({ summary }: { summary: UsageSummary }) {
  const budget = summary.budget;
  if (!budget) {
    return (
      <p className="text-meta text-ink-muted" data-testid="usage-budget-none">
        이 워크스페이스에는 설정된 예산이 없습니다. 합계는 계속 기록됩니다.
      </p>
    );
  }

  const status = budgetStatus(budget, formatMicroUsd);

  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface-raised p-4"
      data-testid="usage-budget"
      data-budget-state={budget.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-medium text-ink">예산</h3>
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
      </div>
      {/* The bar takes the chip's tone. A full bar in the accent colour beside a
          red "한도 도달" chip reads as a finished download, and the same accent
          is already the share bars below, where it would mean a proportion. */}
      <progress
        className="progress-bar"
        data-tone={status.tone === "ok" ? undefined : status.tone}
        value={status.usedPercent}
        max={100}
        aria-hidden="true"
      />
      <p
        className={cn(
          "text-meta",
          status.tone === "danger" ? "text-danger" : "text-ink-muted"
        )}
      >
        {status.detail}
      </p>
      <dl className="flex min-w-0 flex-col gap-2">
        <NumberRow term="적용 범위" value={budgetGrainLabel(budget.grain)} />
        <NumberRow
          term="사용"
          value={formatMicroUsd(budget.spentMicroUsd)}
        />
        <NumberRow
          term="예약"
          value={formatMicroUsd(budget.reservedMicroUsd)}
        />
        <NumberRow term="한도" value={formatMicroUsd(budget.limitMicroUsd)} />
        {budget.periodStart && (
          <NumberRow
            term="예산 기간 시작"
            value={formatIsoDay(budget.periodStart)}
          />
        )}
      </dl>
    </section>
  );
}

/**
 * Segmented choice on native radios: the browser already gives one tab stop for
 * the group, arrow-key roving inside it, and the grouping a screen reader
 * announces. The input stays focusable and drives the label through `peer`, so
 * nothing about the keyboard path is reimplemented in JS.
 */
function Segmented({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const labelId = `${name}-label`;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span id={labelId} className="text-meta text-ink-muted">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex overflow-hidden rounded-sm border border-line"
      >
        {options.map((option) => (
          <label
            key={option.id}
            className="border-l border-line first:border-l-0"
            data-testid={`${name}-${option.id}`}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
              className="peer sr-only"
            />
            {/* h-control-sm, not padding: control height is its own axis
                (SKILL §3) and this option sits in a row with a size="sm"
                button. peer-checked:hover repeats the selected background on
                purpose: `hover:bg-surface-hover` and `peer-checked:bg-*` have
                the same specificity, so without it the hover rule (emitted
                later by Tailwind) wins and the selection marker disappears
                under the cursor. */}
            <span className="flex h-control-sm cursor-pointer items-center px-3 text-meta text-ink-muted hover:bg-surface-hover peer-checked:bg-accent-soft peer-checked:text-ink peer-checked:hover:bg-accent-soft peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-accent">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
