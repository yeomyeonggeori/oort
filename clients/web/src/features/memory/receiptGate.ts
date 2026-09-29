import { turnRecordRunId } from "@momo/core/features/timeline/cascadeModel";
import type { Message } from "@momo/core/lib/api";

/**
 * The run whose receipt this row should ask for, or null (no chip, no request).
 *
 * Only an agent's settled turn record asks: one run writes several rows with the
 * same `run_id` (approval request, tool rows, the turn record), and asking from
 * each would draw the chip three times and fan out three requests. A deleted row
 * and a server without the memory surface ask for nothing.
 */
export function receiptRunIdFor(input: {
  message: Message;
  isAgent: boolean;
  deleted: boolean;
  provided: boolean;
}): string | null {
  if (!input.provided || !input.isAgent || input.deleted) return null;
  return turnRecordRunId(input.message);
}
