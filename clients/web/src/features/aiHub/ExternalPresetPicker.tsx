import { useId } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import {
  EXTERNAL_PICKER_COPY as COPY,
  externalPresetCards,
  type ExternalDetection,
  type ExternalPresetCard,
} from "@momo/core/features/hostedAgents/externalPresets";
import { hostedAgentDetected } from "@momo/core/features/hostedAgents/detect";
import type { HostedPresetId } from "@momo/core/features/hostedAgents/presets";
import { useHostedAgentProbe } from "@/features/hostedAgents/useHostedAgentProbe";

// =============================================================================
// 「다른 곳에서 도는 에이전트」를 고른 뒤, 위저드 앞의 프리셋 고르기 (#3523).
// 감지는 데스크탑에서만 있고, 웹에서는 추천 없이 같은 프리셋을 그대로 보여 준다.
// 지원 전 줄(dots)은 숨기지 않고 aria-disabled + 사유로 세운다.
// =============================================================================

function PresetRow({
  card,
  onChoose,
}: {
  card: ExternalPresetCard;
  onChoose: (id: HostedPresetId) => void;
}) {
  const noteId = useId();
  const soon = card.state === "soon";
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-disabled={soon || undefined}
        aria-describedby={noteId}
        onClick={() => {
          if (!soon && card.id !== "dots") onChoose(card.id);
        }}
        data-testid={`external-preset-${card.id}`}
        data-state={card.state}
        data-recommended={card.recommended || undefined}
        className={cn(
          "tap-target flex w-full min-w-0 flex-col gap-1 px-1 py-3 text-left focus-visible:focus-ring",
          soon ? "cursor-not-allowed" : "hover:bg-surface-hover active:bg-surface-pressed"
        )}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn("break-keep text-body font-semibold", soon ? "text-ink-muted" : "text-ink")}>
            {card.title}
          </span>
          {soon && <Lock aria-hidden="true" className="size-3 shrink-0 text-ink-muted" />}
          {card.badge && (
            <span
              className={cn(
                "rounded-sm px-1 py-px text-timestamp font-semibold",
                card.recommended ? "bg-accent-soft text-signal-text" : "bg-muted-soft text-ink-muted"
              )}
              data-testid={`external-preset-${card.id}-badge`}
            >
              {card.badge}
            </span>
          )}
        </span>
        <span
          id={noteId}
          className={cn("break-keep text-meta", soon ? "text-ink-faint" : "text-ink-muted")}
        >
          {card.note}
        </span>
      </button>
    </li>
  );
}

export function ExternalPresetPicker({
  open,
  onOpenChange,
  onChoose,
  opener,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (id: HostedPresetId) => void;
  opener?: HTMLElement | null;
}) {
  const { desktop, ready, probes } = useHostedAgentProbe();
  const detection: ExternalDetection =
    !desktop || !ready ? "unavailable" : probes.some(hostedAgentDetected) ? "detected" : "not-found";
  const cards = externalPresetCards(detection);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 p-6" opener={opener} data-testid="external-preset-picker">
        <DialogTitle className="text-title font-bold">{COPY.title}</DialogTitle>
        <DialogDescription className="break-keep text-body text-ink-muted">
          {COPY.description}
        </DialogDescription>
        <ul aria-label={COPY.listLabel} className="flex min-w-0 flex-col border-t border-line">
          {cards.map((card) => (
            <PresetRow key={card.id} card={card} onChoose={onChoose} />
          ))}
        </ul>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {COPY.cancel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
