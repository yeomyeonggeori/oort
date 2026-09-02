import type { ReactNode } from "react";
import { cn } from "@/design/lib/cn";

/**
 * Agent Hub chips. Neutral uses a muted-soft vessel so the outline stays
 * visible on selected (`accent-soft`) and hovered rows (#1515 / UX-R4a M-3).
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
        tone === "neutral" &&
          "border border-ink-muted bg-muted-soft text-ink-muted",
        tone === "agent" && "bg-agent-soft text-agent",
        tone === "warn" && "border border-warn text-warn"
      )}
      data-testid={testId}
    >
      {children}
    </span>
  );
}
