import { Link } from "react-router-dom";
import { ArrowDownToLine } from "lucide-react";
import { badgeLabel, badgeWorthShowing } from "./model";
import { useUpdateState } from "./store";

// =============================================================================
// 새 버전 알림 (ADR-0133 P2, MOMO-606).
//
// One quiet row at the bottom of the sidebar, and only when there is something
// to act on. A permanent "up to date" chip in that corner is noise that trains
// people to stop reading it, so `badgeWorthShowing` keeps the surface silent
// the other 99% of the time; the full state lives in 설정 > 업데이트, where it
// was asked for.
//
// It is a link, not a button: an update is a place to go and look at, not an
// action to fire from a 240px column. The one-click install lives on the other
// end of it, next to the version numbers that justify pressing it.
// =============================================================================

export function UpdateBadge() {
  const state = useUpdateState();
  if (!badgeWorthShowing(state)) return null;
  const label = badgeLabel(state);
  if (!label) return null;

  return (
    <Link
      to="/settings?section=updates"
      data-testid="update-badge"
      data-update-state={state.kind}
      className="flex items-center gap-2 border-t border-line px-2 py-2 text-meta text-ink hover:bg-surface-hover focus-visible:focus-ring"
    >
      <ArrowDownToLine className="size-4 shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Link>
  );
}
