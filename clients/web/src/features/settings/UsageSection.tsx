import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
// The one cost formatter in this client. A second rounding rule would mean two
// different answers to "how much did this cost" on two surfaces.
import { formatCount, formatMicroUsd } from "@momo/core/features/timeline/agentCardModel";
// The roster is what turns a member id into a name, and a name into an
// unambiguous one. It is already fetched for the sidebar and the directory, so
// this is a cache read, not a second request.
import {
  isAmbiguousName,
  memberFor,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { ApiError } from "@momo/core/lib/api";
import { fetchUsageSummary } from "@momo/core/features/settings/api";
import { errorMessage } from "@momo/core/features/settings/model";
import { ProviderQuotaBlock } from "./ProviderQuotaBlock";
import {
  SectionShell,
  SETTINGS_COLLAPSIBLE_CARD_CLASS,
  SETTINGS_COLLAPSIBLE_SUMMARY_CLASS,
  StatusChip,
} from "./SettingsFields";
import {
  USAGE_BUCKETS,
  USAGE_PERIODS,
  agentRowLabel,
  barShare,
  budgetGrainLabel,
  budgetStatus,
  costConfidence,
  formatBucketStart,
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
  type UsageScope,
  type UsageSummary,
} from "@momo/core/features/settings/usageModel";

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
// Two frames, separated (ADR-0135 D2, MOMO-628). 구독 잔여량 answers "can the
// agents keep running right now" as a ratio of a window the provider owns;
// everything under the rule answers "what did this workspace spend" in dollars
// over a window you pick. 레퍼런스 서베이 §5 found those two get read as one
// wherever a product stacks them without a break, so the rate frame is a block
// of its own on top, the 기간/단위 controls sit BELOW the rule where they can
// only be read as controls of the ledger they precede, and each frame says in
// its own prose that the other one is a different number.
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
  const scope: UsageScope = { period, bucket };

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

  // Every successful answer becomes the fallback for the next failed one, filed
  // under the window it actually covers so a 7일 failure can never be answered
  // with a 30일 total.
  useEffect(() => {
    if (query.data && query.dataUpdatedAt > 0) {
      rememberUsage(
        workspaceId,
        { period, bucket },
        query.data,
        query.dataUpdatedAt
      );
    }
  }, [query.data, query.dataUpdatedAt, workspaceId, period, bucket]);

  const liveError = query.isError
    ? usageErrorCopy(
        query.error instanceof ApiError ? query.error.status : null,
        errorMessage(query.error)
      )
    : null;

  // react-query clears the error the moment a data-less query refetches, so the
  // banner unmounted under the very button that started the retry and keyboard
  // focus fell to <body> (SKILL §6). The copy is held for exactly that window:
  // it is filed under the range it described, so switching 기간 still shows bars
  // rather than the previous range's failure, and it is dropped as soon as the
  // read finishes either way.
  const windowKey = `${period}|${bucket}`;
  const held = useRef<{ key: string; message: string } | null>(null);
  if (liveError) held.current = { key: windowKey, message: liveError };
  else if (!query.isFetching || query.data) held.current = null;

  const view = usageView({
    data: query.data ?? null,
    dataUpdatedAtMs: query.dataUpdatedAt,
    errorMessage:
      liveError ??
      (held.current?.key === windowKey ? held.current.message : null),
    // "paused" is react-query saying the browser is offline, so the request was
    // never sent: it will not fail and it will not finish. Anything else, the
    // realtime rail included, says nothing about whether this REST read works.
    paused: query.fetchStatus === "paused",
    lastKnown: recallUsage(workspaceId, scope),
  });

  // The lead is a static sentence and the block above it is a read that can
  // fail, so a lead that promises 잔여량 was false on every server that answers
  // 404 there, which today is all of them (R1 M9: the panel said "AI 구독의
  // 잔여량과 ... 비용입니다" two lines above "이 서버는 아직 구독 잔여량을
  // 제공하지 않습니다"). The ledger is what this section always has; the gauges
  // are conditional, and the sentence says so in that order.
  const lines = [
    "이 워크스페이스에서 에이전트가 쓴 비용입니다. 이 서버가 AI 구독 잔여량을 제공하면 위에 함께 표시됩니다.",
    "워크스페이스 멤버라면 누구나 볼 수 있습니다.",
  ];

  return (
    <SectionShell title="사용량" lines={lines}>
      {/* The rate frame, on its own above the rule. It is a read of its own with
          its own four states: a server that predates ADR-0135 answers 404 here
          and the ledger below still renders, because the two are separate
          contracts and one being absent is not the other failing. */}
      <ProviderQuotaBlock workspaceId={workspaceId} />

      {/* The rule is the frame boundary, and the controls are inside it: a
          기간 segment above the line would read as filtering the gauges, which
          it cannot do (그 읽기는 파라미터를 받지 않는다). */}
      <div
        className="flex flex-wrap items-center gap-4 border-t border-line pt-4"
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
            and a borderless label there does not read as something to press.

            It stays ENABLED while the read is in flight and reports the wait
            through aria-busy plus its own label. Disabling it moved keyboard
            focus to <body> the moment it was pressed and never gave it back, so
            every refresh cost a walk back down the page with Tab (SKILL §6). A
            second press while fetching is a no-op instead. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (!query.isFetching) void query.refetch();
          }}
          aria-busy={query.isFetching}
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

      {/* aria-busy follows the request, not the view: a refetch keeps the view
          at `ready` (the numbers stay on screen), and a panel whose button says
          불러오는 중 while its container says nothing is busy tells assistive
          tech the opposite of what it tells the eye. */}
      <div
        className="flex min-w-0 flex-col gap-4"
        aria-busy={query.isFetching}
        data-testid="usage-panel"
      >
        {view.kind === "loading" && <UsageSkeleton />}

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
                undimmed, and the banner carries the whole fallback in one line
                (what happened, and when the numbers were last confirmed). The
                clock used to be repeated on a second line underneath, which
                spent a row of a density-7 panel restating one fact. */}
            <InlineBanner
              tone="neutral"
              message={view.notice}
              actionLabel="다시 시도"
              onAction={() => void query.refetch()}
              testId="usage-last-known-banner"
            />
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
      <div className="flex min-w-0 flex-col gap-4" data-testid="usage-body">
        <div className="flex min-w-0 flex-col gap-2">
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
        {/* 예산 is a state of the workspace, not of the selected window. A
            workspace sitting on its hard limit still sits on it during a week
            nobody ran an agent, and hiding the limit exactly there was hiding
            it from the person most likely to be looking for it. */}
        <BudgetBlock summary={summary} />
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
        {/* The biggest number on the surface used to be the only block without
            a heading, so heading navigation skipped straight from 사용량 to
            예산 (SKILL §6: real heading hierarchy). It shares the row with the
            range rather than taking a line of its own. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            <h3 className="text-body font-medium text-ink">합계</h3>
            <p className="text-meta text-ink-muted">{formatRange(summary.range)}</p>
          </div>
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
        {/* "provider" is what the AI 연결 panel calls it to an operator, and
            this panel is read by every member (SKILL §7: internal vocabulary
            stays out of shared copy). */}
        <p className="text-meta text-ink-muted">
          {confidence.allSettled
            ? "AI 제공자가 확정한 청구 값입니다."
            : "AI 제공자가 아직 확정하지 않은 부분이 있어 두 값을 나눠 적습니다."}
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
        <details className={SETTINGS_COLLAPSIBLE_CARD_CLASS} data-testid="usage-buckets">
          <summary className={SETTINGS_COLLAPSIBLE_SUMMARY_CLASS}>
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

/**
 * One dense key/value line. dt left and muted, dd right.
 *
 * `numeric` is the default because almost every value in these lists is a
 * figure, and figures want mono plus tabular-nums so a column of them lines up
 * and does not jitter as it changes. Not every value is: a grain label is a
 * Korean phrase, and monospacing Korean stretches the gaps between syllables
 * into something that reads as broken rather than as a number.
 */
function NumberRow({
  term,
  value,
  numeric = true,
  testId,
}: {
  term: string;
  value: ReactNode;
  numeric?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="min-w-0 truncate text-meta text-ink-muted">{term}</dt>
      <dd
        className={cn("shrink-0 text-meta text-ink", numeric && "font-mono")}
        data-numeric={numeric ? "" : undefined}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Loading state for this panel, not a generic five bars. The panel it replaces
 * is a tall stack (two grouped blocks then two lists), so a 168px placeholder
 * for a ~900px arrival threw the surface down the page the moment the read
 * landed. This mirrors the real block structure at roughly the real height
 * (SKILL §5: height-preserving neutral bars, never a shimmer).
 */
function UsageSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      aria-hidden="true"
      data-testid="usage-skeleton"
    >
      <div className="rounded-md border border-line bg-surface-raised p-4">
        <Skeleton ready={false} rows={7} />
      </div>
      <div className="rounded-md border border-line bg-surface-raised p-4">
        <Skeleton ready={false} rows={6} />
      </div>
      <Skeleton ready={false} rows={5} />
      <Skeleton ready={false} rows={4} />
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
 *
 * The bar owns its own line at the row's full width. It used to share a line
 * with the token counts, which made the track as long as that text was short:
 * three rows measured 474 / 474 / 494px at 1280, so the same share was drawn at
 * different lengths depending on how many digits sat beside it. A comparison
 * device on a variable scale is not a comparison device, and this bar is the
 * only one on the surface.
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
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-timestamp text-ink-muted">
                    입력{" "}
                    <span className="font-mono" data-numeric="">
                      {formatCount(row.promptTokens)}
                    </span>{" "}
                    · 출력{" "}
                    <span className="font-mono" data-numeric="">
                      {formatCount(row.completionTokens)}
                    </span>
                  </span>
                  <span
                    className="font-mono text-body text-ink"
                    data-numeric=""
                  >
                    {formatMicroUsd(row.costMicroUsd)}
                  </span>
                </span>
              </div>
              <progress
                className="progress-bar"
                data-tone="neutral"
                value={row.share}
                max={100}
                aria-hidden="true"
              />
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
      {/* The bar takes the chip's tone in every state, ok included (tokens.md
          §5a). Leaving `ok` untoned fell through to the accent default, so the
          most common state drew an amber bar next to a green 한도 안 chip,
          which is the same two-stories failure the rule exists to stop. */}
      <progress
        className="progress-bar"
        data-tone={status.tone}
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
        {/* The one value in this list that is a phrase, not a figure. */}
        <NumberRow
          term="적용 범위"
          value={budgetGrainLabel(budget.grain)}
          numeric={false}
        />
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
            className="border-l border-line first:border-l-0 active:bg-surface-pressed"
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
            <span className="flex h-control-sm cursor-pointer items-center px-3 text-meta text-ink-muted press hover:bg-surface-hover peer-checked:bg-accent-soft peer-checked:text-ink peer-checked:hover:bg-accent-soft peer-focus-visible:focus-ring">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
