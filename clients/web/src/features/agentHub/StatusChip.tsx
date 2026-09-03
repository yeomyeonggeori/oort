import type { ReactNode } from "react";
import { cn } from "@/design/lib/cn";

/**
 * Agent Hub chips. Neutral uses a muted-soft vessel so the chip stays
 * distinct on selected (`accent-soft`) and hovered rows (#1515 / UX-R4a M-3).
 * The vessel is the chip; a 1px outline would be control grammar (#1516).
 */
export function StatusChip({
  children,
  tone = "neutral",
  testId,
}: {
  children: ReactNode;
  tone?: "neutral" | "agent" | "warn";
  testId?: string;
}) {
  return (
    <span
      className={cn(
        "rounded-sm px-1 text-timestamp",
        tone === "neutral" && "bg-muted-soft text-ink-muted",
        tone === "agent" && "bg-agent-soft text-agent",
        tone === "warn" && "bg-warn-soft text-warn"
      )}
      data-testid={testId}
    >
      {children}
    </span>
  );
}
