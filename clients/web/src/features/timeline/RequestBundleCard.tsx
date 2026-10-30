import { useState, type ReactNode } from "react";
import { Ban, Check, CircleDot, CircleX, Clock, Octagon, ShieldQuestion, type LucideIcon } from "lucide-react";
import type { RequestBundleModel, RequestBundleState } from "@momo/core/features/timeline/requestBundle";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { isReachableHref } from "./ActionResultCard";

const ICON: Record<RequestBundleState, LucideIcon> = {
  thinking: CircleDot, approval: ShieldQuestion, executing: CircleDot, done: Check,
  declined: Ban, expired: Clock, failed: CircleX, cancelled: Octagon,
};
const TONE = {
  working: "text-warn", warn: "text-warn", ok: "text-ok", muted: "text-ink-muted", danger: "text-danger",
};

/** 상태의 판정·말·톤은 코어가 정하고, 이 표면은 lucide 글리프만 붙여요. */
export function RequestBundleMark({ bundle }: { bundle: RequestBundleModel }) {
  const Icon = ICON[bundle.state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-meta", TONE[bundle.tone])} data-testid="request-bundle-state">
      <Icon aria-hidden="true" className="size-4" />{bundle.word}
    </span>
  );
}

/** native details의 Enter/Space와 열림 상태를 쓰되, 닫힌 내용은 DOM에도 두지 않아요. */
export function RequestBundleCard({ bundle, children, raw, footer, note, onOpenStage }: {
  bundle: RequestBundleModel;
  children: ReactNode;
  raw?: ReactNode;
  footer?: ReactNode;
  note?: ReactNode;
  onOpenStage?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 text-body font-medium text-ink line-clamp-2" data-testid="request-bundle-headline">{bundle.headline}</span>
        <RequestBundleMark bundle={bundle} />
      </div>
      {bundle.valueChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2" data-testid="request-bundle-values">
          {bundle.valueChips.map((value, index) => (
            <span key={`${index}-${value.label}`} role="group" aria-label={value.labelText} className="inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-sm bg-muted-soft px-2 py-1 text-meta">
              <span aria-hidden="true" className="min-w-0 break-words">
                {value.before !== undefined && value.after !== undefined && <><s className="text-ink-muted">{value.before}</s><span className="mx-1 text-ink-muted">→</span></>}
                <span className="text-ink">{value.after ?? value.value}</span>
              </span>
            </span>
          ))}
          {bundle.moreValues > 0 && <span className="text-meta text-ink-muted" data-numeric>외 {bundle.moreValues}건</span>}
        </div>
      )}
      {bundle.state !== "approval" && <p className="px-3 pb-2 text-meta text-ink-muted" data-testid="request-bundle-result">{bundle.sentence}</p>}
      {note}
      {bundle.waitingFor && <p className="px-3 py-2 text-meta text-ink-muted">{bundle.waitingFor}</p>}
      {bundle.canDecide && onOpenStage ? <div className="px-3 pb-2"><Button size="sm" onClick={onOpenStage}>열어서 결정</Button></div> : footer}
      {bundle.next && isReachableHref(bundle.next.href) && <a className="mx-3 inline-flex text-meta text-ink underline press focus-visible:focus-ring" href={`#${bundle.next.href}`}>{bundle.next.label}</a>}
      <details data-testid="request-bundle-details" onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer px-3 py-2 text-meta text-ink-muted hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring">{bundle.quietLine}</summary>
        {expanded && <div className="border-t border-line"><dl className="py-1">{children}</dl>{bundle.details.approvalId !== undefined && raw}</div>}
      </details>
    </>
  );
}
