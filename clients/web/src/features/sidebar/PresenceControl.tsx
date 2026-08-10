import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import {
  effectivePresence,
  setPresenceStatus,
  uuidEq,
  type EffectivePresence,
  type PresenceStatus,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  declaredStatusLabel,
  presenceTriggerLabel,
  PRESENCE_OPTIONS,
} from "@momo/core/features/presence/model";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { InlineBanner } from "@/features/common/States";
import { cn } from "@/design/lib/cn";

// =============================================================================
// Self presence control (ADR-0160 ③, 프레즌스 6b). The bottom profile panel's
// avatar becomes the status chip + status-change dropdown, the 6b seam the 6a
// move left open ("the avatar below becomes its click target").
//
// This is the DECLARED-status control (③), a separate vocabulary from the
// connection indicator (①) further along the row: that one says "am I attached",
// this says "what did I choose to appear as". ADR-0160 keeps them apart (guard
// 6), and design-review H1 is what made the separation visible rather than
// merely intended: the connection indicator is now a BAR that appears only when
// the rail is unhealthy, while this is a round badge on the avatar — the
// universally read presence spot. Two circles on one row, one of them
// permanently green, was the collision (see connStatusIndicator.ts).
//
// The badge is bound to REAL state, never decorative (SKILL §8): its color and
// accessible name always derive from the effective value `f(declared, connected)`
// — dnd wins, then away, then auto resolves to online/offline by whether this
// client is connected. Availability(②) for OTHER members rides the ephemeral
// rail and is rendered on member surfaces elsewhere; for the self chip the
// availability input is simply this client's own connection, which it already
// knows, so this control needs no realtime subscription of its own.
// =============================================================================

/** The badge color for an effective value. Filled for a live status, a hollow
 *  muted ring for offline (which is a real state, not missing data). */
function effectiveBadgeClass(effective: EffectivePresence): string {
  switch (effective) {
    case "online":
      return "bg-ok border-surface-sidebar";
    case "away":
      return "bg-warn border-surface-sidebar";
    case "dnd":
      return "bg-danger border-surface-sidebar";
    case "offline":
      // No fill, a muted outline: reads as "offline", distinct from a filled dot
      // and from nothing at all.
      return "bg-surface-sidebar border-line-strong";
  }
}

/** The small dot beside a declared option in the menu. `auto` shows as its
 *  online color, since online is what auto renders as. */
function optionDotClass(status: PresenceStatus): string {
  switch (status) {
    case "auto":
      return "bg-ok";
    case "away":
      return "bg-warn";
    case "dnd":
      return "bg-danger";
  }
}

export function PresenceControl({
  workspaceId,
  selfMemberId,
  selfMember,
  selfName,
  connected,
}: {
  workspaceId: string;
  /** Always known (from the session), so an optimistic write can find the row
   *  even before the roster query resolves. */
  selfMemberId: string;
  /** The roster row, once loaded; carries the durable declared status. `null`
   *  until the directory resolves (or if the self row is not on it yet). */
  selfMember: RosterMember | null | undefined;
  selfName: string;
  /** The realtime rail is connected — the availability input for the self dot. */
  connected: boolean;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const declared = selfMember?.presenceStatus;
  const current: PresenceStatus = declared ?? "auto";
  const effective = effectivePresence(declared, connected);

  const mutation = useMutation({
    mutationFn: (status: PresenceStatus) => setPresenceStatus(workspaceId, status),
    onMutate: async (status) => {
      // Optimistic: paint the new status onto the roster cache the profile row
      // and every member surface read from, then reconcile with the server.
      await client.cancelQueries({ queryKey: ["roster", workspaceId] });
      const previous = client.getQueryData<RosterMember[]>(["roster", workspaceId]);
      client.setQueryData<RosterMember[]>(["roster", workspaceId], (rows) =>
        rows?.map((row) =>
          uuidEq(row.id, selfMemberId) ? { ...row, presenceStatus: status } : row
        )
      );
      return { previous };
    },
    onError: (_error, _status, context) => {
      if (context?.previous) {
        client.setQueryData(["roster", workspaceId], context.previous);
      }
      setFailed(true);
    },
    onSuccess: () => {
      setFailed(false);
      setOpen(false);
      // The server broadcast is the truth co-members see; re-read so this device
      // matches it (and any change made on another device).
      void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
    },
  });

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFailed(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        {/* `tap-target` (44px under 600px wide) matches the settings gear beside
            it — design-review H2 measured this trigger at 24x24 on a touch
            viewport while its neighbour was 44x44, so the two controls a thumb
            reaches for on the same row had different odds of being hit. The
            avatar itself stays 24px; only the hit area grows. */}
        <button
          type="button"
          data-testid="presence-control"
          data-effective={effective}
          aria-label={presenceTriggerLabel(effective)}
          title={presenceTriggerLabel(effective)}
          className="tap-target flex size-6 shrink-0 items-center justify-center rounded-sm focus-visible:focus-ring"
        >
          {/* The badge anchors to THIS span, not to the button. On a touch
              viewport the button is 44px and the avatar is 24px, so a badge
              anchored to the button's corner would float away from the avatar it
              is supposed to sit on — the trap that makes "just enlarge the
              button" a half repair. */}
          <span
            className="relative flex size-6 items-center justify-center rounded-sm bg-surface-hover text-meta font-semibold"
            aria-hidden="true"
          >
            {selfName.slice(0, 1)}
            {/* The presence badge. Bound to `effective`, ringed in the sidebar
                surface so it reads as a badge sitting on the avatar rather than a
                hole punched through it. */}
            <span
              className={cn(
                "absolute bottom-0 right-0 size-2 rounded-full border",
                effectiveBadgeClass(effective)
              )}
            />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        data-testid="presence-menu"
      >
        {failed && (
          <InlineBanner
            message="상태를 바꾸지 못했습니다. 다시 시도하세요."
            testId="presence-error"
          />
        )}
        {/* A single choice among three, so the rows are `menuitemradio` and the
            group's `value` is what computes `aria-checked` (design-review M1).
            Before this, a screen-reader user heard three equal commands and had
            no way to learn which one they were already in — the check mark said
            it to sighted users only. Selection is still handled per-row in
            `onSelect` (not `onValueChange`) so a failed write can hold the menu
            open with its banner; the group's value is the a11y state, not a
            second event path. */}
        <DropdownMenuRadioGroup value={current}>
          {PRESENCE_OPTIONS.map((status) => {
            const isCurrent = status === current;
            return (
              <DropdownMenuRadioItem
                key={status}
                value={status}
                data-testid={`presence-option-${status}`}
                disabled={mutation.isPending}
                onSelect={(event) => {
                  // One REST round trip; keep the menu open on failure so the
                  // banner above is readable (the mute toggle's discipline).
                  event.preventDefault();
                  if (isCurrent) {
                    setOpen(false);
                    return;
                  }
                  mutation.mutate(status);
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-2 shrink-0 rounded-full", optionDotClass(status))}
                />
                <span className="flex-1">{declaredStatusLabel(status)}</span>
                {/* Decoration for the eye only: `aria-checked` above already
                    carries this fact to a screen reader. */}
                {isCurrent && (
                  <Check className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
