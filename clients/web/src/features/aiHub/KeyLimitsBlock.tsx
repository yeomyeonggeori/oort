import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { putProviderBudget, type ProviderLimits } from "@momo/core/features/settings/api";
import { BUDGET_INPUT_ERROR, COMPANY_LABEL, budgetHint, limitsBlock, parseBudgetUsd } from "@momo/core/features/settings/keyLimits";
import type { TeamProbeDetail } from "@momo/core/features/settings/teamKeyForm";
import { errorMessage } from "@momo/core/features/settings/model";
import { formatMoment } from "@/features/settings/oauthGrant";

// =============================================================================
// 「한도·남은 크레딧」 (#3887, ADR-0147 증보 2026-10-16). 키 행 아래의 한 블록.
//
// 두 출처를 이름으로 가른다: 「공급사가 알려 준 숫자」(확인 호출이 키로 직접 읽은 것)와
// 「oort 추정」(이 워크스페이스의 사용 기록 × 단가표, 운영자가 적은 월 크레딧과 견줌).
// 추정은 공급사 잔액이 아니고, 둘을 한 숫자로 합치지 않는다. 문장은 keyLimits(코어)가 만든다.
// =============================================================================

export const LIMITS_QUERY_KEY = ["settings", "provider-limits"] as const;

function Lines({ lines, testId }: { lines: readonly { label: string; value: string }[]; testId: string }) {
  if (lines.length === 0) return null;
  return (
    <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-meta" data-testid={testId}>
      {lines.map((line) => (
        <div key={line.label} className="contents">
          <dt className="min-w-0 break-keep text-ink-muted">{line.label}</dt>
          <dd className="text-right tabular-nums text-ink" data-numeric>
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function KeyLimitsBlock({
  testId,
  baseUrl,
  detail,
  checked,
  limits,
  limitsState,
  estimateHere,
  checkedAtMs,
  checking,
  offline,
  offlineNoteId,
  onRefresh,
}: {
  testId: string;
  baseUrl: string;
  /** 이 키의 확인 세부. 아직 확인하지 않았으면 null. */
  detail: TeamProbeDetail | null;
  /** 방금 확인에서 이 키가 불렸는가(숫자가 없어도 true). */
  checked: boolean;
  limits: ProviderLimits | null;
  /** 월 크레딧·지출 추정을 서버에서 받는 중인가, 받았는가, 못 받았는가. */
  limitsState: "loading" | "ready" | "error";
  /**
   * oort 추정은 **회사 단위** 숫자다(원장에 키 칸이 없다). 같은 회사 키가 여럿이면 첫 키
   * 아래에서만 그리고, 나머지는 어디 있는지만 말한다(키마다 같은 숫자가 반복되면 키 숫자로 읽힌다).
   */
  estimateHere: boolean;
  offlineNoteId?: string;
  checkedAtMs: number | null;
  checking: boolean;
  offline: boolean;
  onRefresh: () => void;
}) {
  const client = useQueryClient();
  const block = limitsBlock({ baseUrl, detail, checked, limits });
  const budgetId = useId();
  const budgetHintId = useId();
  const budgetErrorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const company = block.company;
  const save = useMutation({
    mutationFn: (input: { company: NonNullable<typeof company>; usd: number | null }) =>
      putProviderBudget(input.company, input.usd),
    onSuccess: (value) => {
      client.setQueryData(LIMITS_QUERY_KEY, value);
      setDraft(null);
    },
  });
  const current = block.estimate?.budgetUsd ?? null;
  const shown = draft ?? (current === null ? "" : String(current));
  const dirty = draft !== null && draft !== (current === null ? "" : String(current));
  const refreshLocked = offline || checking;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!company || offline || save.isPending) return;
    const parsed = parseBudgetUsd(shown);
    if (parsed === undefined) {
      setFieldError(BUDGET_INPUT_ERROR);
      return;
    }
    setFieldError(null);
    save.mutate({ company, usd: parsed });
  }

  return (
    <section
      className="mt-1 flex min-w-0 flex-col gap-3 rounded-lg bg-surface-muted p-3"
      aria-label="한도·남은 크레딧"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="text-meta font-bold text-ink">한도·남은 크레딧</h4>
        <span className="flex-1" />
        <span className="text-timestamp text-ink-muted" data-testid={`${testId}-checked`}>
          {checkedAtMs ? `${formatMoment(checkedAtMs)} 확인` : "확인 전"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("tap-target bg-surface shadow-sm", refreshLocked && "opacity-50")}
          aria-disabled={refreshLocked || undefined}
          aria-busy={checking || undefined}
          aria-describedby={offline ? offlineNoteId : undefined}
          onClick={() => {
            if (!refreshLocked) onRefresh();
          }}
          data-testid={`${testId}-refresh`}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {checking ? "읽는 중" : "새로고침"}
        </Button>
      </div>

      <div className="flex min-w-0 flex-col gap-1" data-testid={`${testId}-provider`}>
        <h5 className="text-meta font-semibold text-ink">공급사가 알려 준 숫자</h5>
        <Lines lines={block.provider.lines} testId={`${testId}-provider-lines`} />
        {block.provider.note && (
          <p className="break-keep text-meta text-ink-muted" data-testid={`${testId}-provider-note`}>
            {block.provider.note}
          </p>
        )}
      </div>

      {block.estimate && !estimateHere ? (
        <p className="break-keep border-t border-line pt-3 text-meta text-ink-muted" data-testid={`${testId}-estimate-elsewhere`}>
          {COMPANY_LABEL[block.company ?? "anthropic"]} 전체의 oort 추정은 위쪽 {COMPANY_LABEL[block.company ?? "anthropic"]} 키 아래에 있어요.
        </p>
      ) : block.estimate ? (
        <div className="flex min-w-0 flex-col gap-2 border-t border-line pt-3" data-testid={`${testId}-estimate`}>
          <h5 className="text-meta font-semibold text-ink">
            oort 추정 <span className="font-normal text-ink-muted">· {COMPANY_LABEL[block.company ?? "anthropic"]} 전체 · 공급사 잔액이 아니에요</span>
          </h5>
          <Lines lines={block.estimate.lines} testId={`${testId}-estimate-lines`} />
          {block.estimate.usedRatio !== null && (
            <p
              className={cn("text-meta tabular-nums", block.estimate.over ? "text-danger" : "text-ink-muted")}
              data-numeric
              data-testid={`${testId}-ratio`}
            >
              월 크레딧의 약 {Math.round(block.estimate.usedRatio * 100)}% 사용
            </p>
          )}
          {block.estimate.hint && <p className="break-keep text-meta text-ink-muted">{block.estimate.hint}</p>}
          {block.estimate.unpriced && (
            <p className="break-keep text-meta text-warn" data-testid={`${testId}-unpriced`}>
              {block.estimate.unpriced}
            </p>
          )}
          <form className="flex min-w-0 flex-col gap-1" onSubmit={submit} noValidate>
            <label htmlFor={budgetId} className="text-meta font-semibold text-ink">
              월 크레딧(달러)
            </label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                id={budgetId}
                value={shown}
                inputMode="decimal"
                autoComplete="off"
                placeholder="예: 100"
                className="w-32 self-start tabular-nums"
                aria-describedby={fieldError ? `${budgetErrorId} ${budgetHintId}` : budgetHintId}
                aria-invalid={fieldError ? true : undefined}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setFieldError(null);
                }}
                data-testid={`${testId}-budget`}
              />
              <Button
                type="submit"
                size="sm"
                aria-busy={save.isPending || undefined}
                aria-disabled={offline || !dirty || save.isPending || undefined}
                className={cn((offline || !dirty) && "opacity-50 hover:opacity-50")}
                data-testid={`${testId}-budget-save`}
              >
                {save.isPending ? "저장 중" : "저장"}
              </Button>
            </div>
            {fieldError && (
              <p id={budgetErrorId} className="break-keep text-meta text-danger" role="alert">
                {fieldError}
              </p>
            )}
            {save.isError && (
              <p className="break-keep text-meta text-danger" role="alert" data-testid={`${testId}-budget-error`}>
                {errorMessage(save.error)}
              </p>
            )}
            <p id={budgetHintId} className="break-keep text-meta text-ink-muted">
              {budgetHint(block.company ?? "anthropic")}
            </p>
          </form>
          <p className="break-keep text-meta text-ink-muted">
            이 워크스페이스에서 집계한 사용량이에요. 같은 키를 다른 곳에서 쓴 몫은 빠져 있어요.
          </p>
        </div>
      ) : (
        company === null && (
          <p className="break-keep border-t border-line pt-3 text-meta text-ink-muted" data-testid={`${testId}-no-estimate`}>
            알려진 공급사 주소가 아니라서 사용량 추정은 하지 않아요.
          </p>
        )
      )}
      {block.estimate === null && company !== null && limitsState === "loading" && (
        <p className="break-keep border-t border-line pt-3 text-meta text-ink-muted" data-testid={`${testId}-estimate-loading`}>
          oort 추정을 불러오는 중이에요.
        </p>
      )}
      {block.estimate === null && company !== null && limitsState === "error" && (
        <p className="break-keep border-t border-line pt-3 text-meta text-ink-muted" data-testid={`${testId}-estimate-pending`}>
          oort 추정을 불러오지 못했어요. 새로고침을 눌러 다시 읽어 주세요.
        </p>
      )}

      <div className="flex min-w-0 flex-col gap-1">
        {block.console && (
          <a
            href={block.console.url}
            target="_blank"
            rel="noopener noreferrer"
            className="tap-target inline-flex w-max items-center gap-1 rounded-md text-meta font-semibold text-ink underline decoration-line-strong underline-offset-2 hover:text-ink-muted focus-visible:focus-ring"
            data-testid={`${testId}-console`}
          >
            {block.console.label}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
      </div>
    </section>
  );
}
