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
import { SegmentedControl } from "@/design/ui/segmented-control";
import { StatusChip } from "./SettingsFields";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";
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
// keep an agent running, so the panel is a ledger, not a dashboard: one card per
// question (합계, 예산, 모델별, 에이전트별), each a stack of rows split by the
// card's own rule, and never a bordered box inside a card (#3578 S5c). The bars are native <progress> elements because CSP is
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
// its own prose that the other one is a different number. In cards that is two
// groups with a gap: 구독 잔여량 on top, then 비용 집계 whose rows carry the
// 기간/단위 controls and everything under it.
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

  // The 비용 집계 sentence promises only the ledger, which is what this page
  // always has. The gauges above it are conditional (a server that predates
  // ADR-0135 answers 404 there), and a lead that promised 잔여량 was false on
  // every such server (R1 M9), so the gauges' own card describes itself.
  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="usage-page">
      {/* The rate frame, on its own above the ledger. It is a read of its own with
          its own four states: a server that predates ADR-0135 answers 404 here
          and the ledger below still renders, because the two are separate
          contracts and one being absent is not the other failing. */}
      <ProviderQuotaBlock workspaceId={workspaceId} />

      {/* The ledger's controls are the first card of the ledger: a 기간 segment
          above the gauges would read as filtering them, which it cannot do (그
          읽기는 파라미터를 받지 않는다). The sentence says so for both frames.

          The refresh button stays ENABLED while the read is in flight and
          reports the wait through aria-busy plus its own label. Disabling it
          moved keyboard focus to <body> the moment it was pressed and never gave
          it back, so every refresh cost a walk back down the page with Tab
          (SKILL §6). A second press while fetching is a no-op instead. */}
      <SettingsSection
        title="비용 집계"
        description="이 워크스페이스에서 에이전트가 쓴 비용이에요. 아래 숫자는 여기서 고른 기간과 단위로 모아요."
        testId="usage-controls"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!query.isFetching) void query.refetch();
            }}
            aria-busy={query.isFetching}
            data-testid="usage-refresh"
          >
            {query.isFetching ? "불러오는 중" : "새로 고치기"}
          </Button>
        }
      >
        <SettingsRow label="기간">
          <SegmentedControl
            legend="기간"
            name="usage-period"
            testId="usage-period"
            options={USAGE_PERIODS.map((p) => ({ value: p.id, label: p.label }))}
            value={period}
            onValueChange={setPeriod}
          />
        </SettingsRow>
        <SettingsRow label="단위">
          <SegmentedControl
            legend="단위"
            name="usage-bucket"
            testId="usage-bucket"
            options={USAGE_BUCKETS.map((b) => ({ value: b.id, label: b.label }))}
            value={bucket}
            onValueChange={setBucket}
          />
        </SettingsRow>
      </SettingsSection>

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
        className="flex min-w-0 flex-col gap-8"
        aria-busy={query.isFetching}
        data-testid="usage-panel"
      >
        {view.kind === "loading" && <UsageSkeleton />}

        {view.kind === "error" && (
          <SettingsSection title="합계">
            <CardBody>
              <InlineBanner
                message={view.message}
                actionLabel="다시 시도"
                onAction={() => void query.refetch()}
                separator={false}
                className="px-0"
                testId="usage-error"
              />
            </CardBody>
          </SettingsSection>
        )}

        {view.kind === "last-known" && (
          <div
            className="flex min-w-0 flex-col gap-8"
            data-testid="usage-last-known"
          >
            {/* P15 durability layer: the cached answer keeps rendering,
                undimmed, and the banner carries the whole fallback in one line
                (what happened, and when the numbers were last confirmed). */}
            <SettingsSection>
              <CardBody>
                <InlineBanner
                  tone="neutral"
                  message={view.notice}
                  actionLabel="다시 시도"
                  onAction={() => void query.refetch()}
                  separator={false}
                  className="px-0"
                  testId="usage-last-known-banner"
                />
              </CardBody>
            </SettingsSection>
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
    </div>
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
      <div className="flex min-w-0 flex-col gap-8" data-testid="usage-body">
        <SettingsSection title="합계" description={formatRange(summary.range)}>
          <EmptyInvite
            headline="이 기간에 기록된 사용량이 없어요."
            detail="에이전트가 실행되면 모델별, 에이전트별 비용이 여기에 쌓여요."
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
        </SettingsSection>
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
    <div className="flex min-w-0 flex-col gap-8" data-testid="usage-body">
      {/* The biggest number on the surface is the first thing in the first
          card, under a real heading (SKILL §6), with the range beside it. */}
      <SettingsSection
        title="합계"
        description={formatRange(summary.range)}
        testId="usage-totals"
        action={
          confidence.allSettled ? (
            <StatusChip tone="ok">확정 값</StatusChip>
          ) : (
            <StatusChip tone="warn">추정 포함</StatusChip>
          )
        }
      >
        <div className="flex min-w-0 flex-col gap-1 px-4 py-4">
          {/* text-display carries the emphasis; a third weight in this tree
              would be size inflation dressed as hierarchy (SKILL §3). */}
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
              ? "AI 제공자가 확정한 청구 값이에요."
              : "AI 제공자가 아직 확정하지 않은 부분이 있어 두 값을 나눠 적었어요."}
          </p>
        </div>
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
      </SettingsSection>

      <BudgetBlock summary={summary} />

      <Breakdown
        title="모델별"
        testId="usage-model"
        emptyCopy="이 기간에 기록된 모델이 없어요."
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
        emptyCopy="이 기간에 기록된 에이전트가 없어요."
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
        <SettingsSection>
          <details data-testid="usage-buckets">
            <summary className="cursor-pointer px-4 py-3 text-body font-semibold text-ink hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring">
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
                  className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0"
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
        </SettingsSection>
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
 * One key/value row of a card. Term left and muted, value right.
 *
 * `numeric` is the default because almost every value in these lists is a
 * figure, and figures want mono plus tabular-nums so a column of them lines up
 * and does not jitter as it changes. Not every value is: a grain label is a
 * Korean phrase, and monospacing Korean stretches the gaps between syllables
 * into something that reads as broken rather than as a number.
 *
 * `keep`: a term and its figure are one short line even in a phone-wide card,
 * so the value stays beside the term instead of dropping under it.
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
    <SettingsRow label={term} keep>
      <span
        className={cn("text-body text-ink", numeric && "font-mono")}
        data-numeric={numeric ? "" : undefined}
        data-testid={testId}
      >
        {value}
      </span>
    </SettingsRow>
  );
}

/**
 * Loading state for this panel, not a generic five bars. The panel it replaces
 * is a tall stack (a totals card, then lists), so a 168px placeholder for a
 * ~900px arrival threw the surface down the page the moment the read landed.
 * This mirrors the real card structure at roughly the real height (SKILL §5:
 * height-preserving neutral bars, never a shimmer).
 */
function UsageSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-8"
      aria-hidden="true"
      data-testid="usage-skeleton"
    >
      <SettingsSection title="합계">
        <CardBody>
          <Skeleton ready={false} rows={7} />
        </CardBody>
      </SettingsSection>
      <SettingsSection title="예산">
        <CardBody>
          <Skeleton ready={false} rows={6} />
        </CardBody>
      </SettingsSection>
      <SettingsSection title="모델별">
        <CardBody>
          <Skeleton ready={false} rows={4} />
        </CardBody>
      </SettingsSection>
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
 * Rows with a bar inside one card, not a card per row. The bar is relative to
 * the largest row rather than to the total, so the second and third lines stay
 * readable when one model dominates, and it is aria-hidden because the exact
 * figure is already text on the same line. It is toned neutral: this bar states
 * a proportion, and the accent belongs to the one bar on this surface that
 * states a state (예산).
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
    <SettingsSection title={title}>
      {rows.length === 0 ? (
        <CardBody>
          <p className="text-meta text-ink-muted">{emptyCopy}</p>
        </CardBody>
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-line">
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex min-w-0 flex-col gap-1 px-4 py-3"
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
    </SettingsSection>
  );
}

/** Budget state as the server projected it. No enforcement is claimed here. */
function BudgetBlock({ summary }: { summary: UsageSummary }) {
  const budget = summary.budget;
  if (!budget) {
    return (
      <SettingsSection title="예산">
        <CardBody>
          <p className="text-meta text-ink-muted" data-testid="usage-budget-none">
            이 워크스페이스에는 설정된 예산이 없어요. 합계는 계속 기록돼요.
          </p>
        </CardBody>
      </SettingsSection>
    );
  }

  const status = budgetStatus(budget, formatMicroUsd);

  return (
    <div
      className="flex min-w-0 flex-col"
      data-testid="usage-budget"
      data-budget-state={budget.state}
    >
      <SettingsSection
        title="예산"
        action={<StatusChip tone={status.tone}>{status.label}</StatusChip>}
      >
        <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
          {/* The bar takes the chip's tone in every state, ok included
              (tokens.md §5a). Leaving `ok` untoned fell through to the accent
              default, so the most common state drew an amber bar next to a
              green 한도 안 chip, which is the same two-stories failure the
              rule exists to stop. */}
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
        </div>
        {/* The one value in this list that is a phrase, not a figure. */}
        <NumberRow
          term="적용 범위"
          value={budgetGrainLabel(budget.grain)}
          numeric={false}
        />
        <NumberRow term="사용" value={formatMicroUsd(budget.spentMicroUsd)} />
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
      </SettingsSection>
    </div>
  );
}
