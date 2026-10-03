import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  AI_HUB_COPY,
  AI_HUB_OVERVIEW_COPY,
  aiHubSection,
} from "@momo/core/features/ai/aiHubModel";
import { CHIP_CLASS } from "@/features/common/chip";
import { InlineBanner } from "@/features/common/States";
import type { ChipTone, HubCardView } from "./aiHubOverviewModel";
import { useAiHubOverview } from "./useAiHubOverview";

export const HUB_CHIP_TONE: Record<ChipTone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  signal: "bg-muted-soft text-ink",
  neutral: "bg-muted-soft text-ink-muted",
};

function Card({ card }: { card: HubCardView }) {
  const headingId = `ai-hub-card-${card.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`ai-hub-card-${card.id}`}
      className="flex min-w-0 flex-col gap-2 border-t border-line pt-4"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-title font-semibold text-ink">
          {card.title}
        </h2>
        {card.badge ? (
          <span className="shrink-0 text-meta text-ink-muted" data-numeric>
            {card.badge}
          </span>
        ) : null}
      </div>
      <p className="break-keep text-body text-ink-muted">{card.meaning}</p>
      {card.chips.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={`${card.title} 상태`}>
          {card.chips.map((chip) => (
            <li
              key={chip.text}
              className={cn(CHIP_CLASS, HUB_CHIP_TONE[chip.tone])}
              data-numeric
            >
              {chip.text}
            </li>
          ))}
        </ul>
      ) : null}
      {card.note ? <p className="break-keep text-meta text-ink-muted">{card.note}</p> : null}
      <Link
        to={card.to}
        data-testid={`ai-hub-open-${card.id}`}
        className="self-start text-body font-semibold text-ink underline underline-offset-4 press focus-visible:focus-ring"
      >
        {card.linkLabel}
      </Link>
    </section>
  );
}

export function AiHubOverview({ mayCreateAgent }: { mayCreateAgent: boolean }) {
  const overview = useAiHubOverview();
  const navigate = useNavigate();
  const accounts = aiHubSection("accounts");
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="ai-hub-overview">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl break-keep text-body text-ink-muted">{AI_HUB_COPY.subtitle}</p>
        {mayCreateAgent ? (
          <Button asChild size="sm" data-testid="ai-hub-create-agent">
            <Link to={`${aiHubSection("agents").path}?create=1`}>{AI_HUB_OVERVIEW_COPY.createAgent}</Link>
          </Button>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-x-8 gap-y-6 md:grid-cols-2">
        {overview.cards.map((card) => (
          <Card key={card.id} card={card} />
        ))}
      </div>
      {overview.nudge ? (
        <InlineBanner
          tone="neutral"
          message={AI_HUB_OVERVIEW_COPY.nextAction.loginNeeded}
          actionLabel={AI_HUB_OVERVIEW_COPY.nextAction.goAccounts}
          onAction={() => {
            navigate(accounts.path);
          }}
          testId="ai-hub-nudge"
        />
      ) : null}
    </div>
  );
}
