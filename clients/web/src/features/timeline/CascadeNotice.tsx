import { Shuffle } from "lucide-react";
import { useCascadeFallbacks } from "./cascadeContext";
import { cascadeNoticeText, cascadeRouteText } from "./cascadeModel";

// =============================================================================
// "2차 프로바이더로 처리됨" (ADR-0135 D1). The user-facing half of the audit rule
// the ADR states outright: 전환은 기록한다, 조용한 전환 금지.
//
// It sits UNDER the card rather than inside it, and that is a decision. The
// card's rows are the turn's own payload (model, tokens, cost); where the turn
// was served is provenance about the run, and it has to survive the row's
// precedence chain: a turn whose answer is a patch renders as an artifact card
// with no `dl` to put a row in (rowModel.ts), and losing the notice exactly
// when a patch was written by a second provider is the silent switch this line
// exists to prevent.
//
// --warn, not --danger: falling over is the cascade WORKING. The turn was
// served. What changed is which budget paid for it and which account it answers
// to, which is worth stating and is not a failure.
//
// Not a live region. This is a settled fact about a turn that already finished,
// and react-virtuoso re-mounts rows on every scroll pass, so role="status" here
// would read the same sentence aloud again every time the card came back into
// view. Same rule ArtifactCard's truncation banner and open-failure row already
// carry (MOMO-620 R1/R2); the frame that creates the notice arrives while the
// run is streaming, and the row that announces run outcome is the card itself.
// =============================================================================

export function CascadeNotice({ runId }: { runId: string | null }) {
  const fallbacks = useCascadeFallbacks(runId);
  const text = cascadeNoticeText(fallbacks);
  if (text === null) return null;
  const route = cascadeRouteText(fallbacks);

  return (
    <p
      data-testid="cascade-notice"
      data-hops={fallbacks.length}
      className="mt-1 flex max-w-pane-lg flex-wrap items-baseline gap-2 text-meta text-warn"
    >
      <Shuffle className="size-4 shrink-0 self-center" aria-hidden="true" />
      <span className="min-w-0 break-words">{text}</span>
      {route !== null && (
        // Endpoint labels only, which is all the server publishes: host and
        // port, never the path, the query or the key (ADR-0004).
        <span className="min-w-0 break-all text-ink-muted">{route}</span>
      )}
    </p>
  );
}
