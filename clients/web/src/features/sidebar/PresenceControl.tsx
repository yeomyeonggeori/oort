import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import {
  setPresenceStatus,
  uuidEq,
  type EffectivePresence,
  type PresenceStatus,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  declaredStatusLabel,
  PRESENCE_MENU_LABEL,
  PRESENCE_OPTIONS,
} from "@momo/core/features/presence/model";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/design/ui/dropdown-menu";
import { InlineBanner } from "@/features/common/States";
import { cn } from "@/design/lib/cn";

// =============================================================================
// Self presence (ADR-0160 ③, 프레즌스 6b). UX-D4 (#1756) moved the trigger: the
// whole bottom identity row is now the profile card, and this file owns the
// two pieces that card composes — the avatar badge (effective dot) and the
// declared-status radio group inside that card's menu.
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
//
// Declared options stay auto/away/dnd (온라인 / 자리 비움 / 방해 금지). Buzz's
// Online/Away/Offline is the *effective* vocabulary; Offline is not a durable
// intent and is not offered as a radio (ADR-0160 D2/D3).
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

export function PresenceBadge({
  selfName,
  effective,
}: {
  selfName: string;
  effective: EffectivePresence;
}) {
  return (
    <span
      data-testid="presence-control"
      data-effective={effective}
      className="relative flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-meta font-semibold"
      aria-hidden="true"
    >
      {selfName.slice(0, 1)}
      {/* The presence badge. Bound to `effective`, ringed in the sidebar
          surface so it reads as a badge sitting on the avatar rather than a
          hole punched through it. Anchored to THIS span, not to the profile
          trigger: enlarging the hit area must not float the dot off the
          avatar (presence 6b H2). */}
      <span
        className={cn(
          "absolute bottom-0 right-0 size-2 rounded-full border",
          effectiveBadgeClass(effective)
        )}
      />
    </span>
  );
}

export function PresenceStatusItems({
  workspaceId,
  selfMemberId,
  selfMember,
  onWrote,
}: {
  workspaceId: string;
  selfMemberId: string;
  selfMember: RosterMember | null | undefined;
  /** Called after a successful durable write so the owning card can close. */
  onWrote?: () => void;
}) {
  const client = useQueryClient();
  const [failed, setFailed] = useState(false);
  const menuLabelId = useId();

  const declared = selfMember?.presenceStatus;
  const current: PresenceStatus = declared ?? "auto";

  const mutation = useMutation({
    mutationFn: (status: PresenceStatus) =>
      setPresenceStatus(workspaceId, { status }),
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
      onWrote?.();
      // The server broadcast is the truth co-members see; re-read so this device
      // matches it (and any change made on another device). PUT is the durable
      // ③ write (REST→PG→outbox→relay); availability ② is not this request.
      void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
    },
  });

  return (
    <>
      {/* The menu's title (이슈 #1383). The trigger is an avatar, so nothing
          in the open panel said what the three words are *about* — a person
          arriving at 온라인 / 자리 비움 / 방해 금지 had to infer the question
          from the answers. The title is the same name the trigger already
          speaks (`PRESENCE_MENU_LABEL`), and it is a real name rather than
          decoration: the radio group points back at it with
          `aria-labelledby`, the idiom `HostPicker` already uses.

          **It stands first, above the failure banner** (design-review M1). */}
      <DropdownMenuLabel id={menuLabelId}>
        {PRESENCE_MENU_LABEL}
      </DropdownMenuLabel>
      {failed && (
        <InlineBanner
          message="상태를 바꾸지 못했습니다. 다시 시도하세요."
          testId="presence-error"
        />
      )}
      {/* A single choice among three, so the rows are `menuitemradio` and the
          group's `value` is what computes `aria-checked` (design-review M1).
          Selection is still handled per-row in `onSelect` (not `onValueChange`)
          so a failed write can hold the menu open with its banner; the group's
          value is the a11y state, not a second event path. */}
      <DropdownMenuRadioGroup value={current} aria-labelledby={menuLabelId}>
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
                  onWrote?.();
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
              {isCurrent && (
                <Check className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              )}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
}
