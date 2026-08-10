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
  DropdownMenuItem,
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
// connection dot (①) beside it: the connection dot says "am I attached", this
// says "what did I choose to appear as". ADR-0160 keeps them apart (guard 6), so
// the two indicators read differently by position and shape — the connection dot
// is a small square near the settings gear, this is a round badge on the avatar,
// the universally-read "presence badge" spot.
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
        <button
          type="button"
          data-testid="presence-control"
          data-effective={effective}
          aria-label={presenceTriggerLabel(effective)}
          className="relative flex size-6 shrink-0 items-center justify-center rounded-sm focus-visible:focus-ring"
        >
          <span
            className="flex size-6 items-center justify-center rounded-sm bg-surface-hover text-meta font-semibold"
            aria-hidden="true"
          >
            {selfName.slice(0, 1)}
          </span>
          {/* The presence badge. Bound to `effective`, punched out of the avatar
              with a 1px sidebar-colored ring so it reads as a badge, not a hole. */}
          <span
            aria-hidden="true"
            className={cn(
              "absolute bottom-0 right-0 size-2 rounded-full border",
              effectiveBadgeClass(effective)
            )}
          />
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
        {PRESENCE_OPTIONS.map((option) => {
          const isCurrent = option.status === current;
          return (
            <DropdownMenuItem
              key={option.status}
              data-testid={`presence-option-${option.status}`}
              data-current={isCurrent ? "" : undefined}
              disabled={mutation.isPending}
              onSelect={(event) => {
                // One REST round trip; keep the menu open on failure so the
                // banner above is readable (the mute toggle's discipline).
                event.preventDefault();
                if (option.status === current) {
                  setOpen(false);
                  return;
                }
                mutation.mutate(option.status);
              }}
            >
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0 rounded-full", optionDotClass(option.status))}
              />
              <span className="flex-1">{declaredStatusLabel(option.status)}</span>
              {isCurrent && (
                <Check className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
