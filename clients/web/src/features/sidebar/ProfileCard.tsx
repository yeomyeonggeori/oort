import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Settings } from "lucide-react";
import { effectivePresence, type RosterMember } from "@momo/core/lib/api";
import { presenceTriggerLabel } from "@momo/core/features/presence/model";
import { useOpenAddWorkspace } from "@/features/workspace/useAddWorkspace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import {
  PresenceBadge,
  PresenceStatusItems,
} from "./PresenceControl";

// =============================================================================
// Bottom identity card (UX-D4 #1756, buzz 36). The trigger is the identity
// cluster (avatar + name + badge). `tap-target` grows that button to the row
// under 600px; the connection bar and help sit outside it. The open panel is
// a DropdownMenu (not a submenu, house rule #1383): declared status radios,
// then the real workspace verb that already lives on the rail (+), then
// settings.
//
// Invented surfaces stay off this card:
//   * workspace session swap (ADR-0161 4b-3) has not landed. The rail's [+]
//     adds a workspace; this item rewires that same opener. A second
//     switcher here would duplicate a surface that does not exist.
//   * product feedback (buzz Send-feedback class) has no surface.
//
// The panel is portaled and anchored to THIS trigger. It opens upward from the
// identity row, which sits *below* the channel-list scroller, so the collision
// boundary is the viewport (Radix default) rather than that list — flipping
// against the list would pin the card inside a box the trigger is not in.
// =============================================================================

export function ProfileCard({
  workspaceId,
  selfMemberId,
  selfMember,
  selfName,
  connected,
}: {
  workspaceId: string;
  selfMemberId: string;
  selfMember: RosterMember | null | undefined;
  selfName: string;
  connected: boolean;
}) {
  const navigate = useNavigate();
  const openAddWorkspace = useOpenAddWorkspace();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingWorkspaceRef = useRef(false);
  const [open, setOpen] = useState(false);
  const effective = effectivePresence(selfMember?.presenceStatus, connected);
  const triggerName = `${selfName}. ${presenceTriggerLabel(effective)}`;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {/* `tap-target` (44px under 600px) is the whole row now: the old
            24×24 avatar-only hit sat next to a 44px gear (6b H2). The avatar
            itself stays 24px; the badge stays on that span. */}
        <button
          ref={triggerRef}
          type="button"
          data-testid="profile-card"
          aria-label={triggerName}
          title={triggerName}
          className="tap-target flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left hover:bg-surface-hover focus-visible:focus-ring"
        >
          <PresenceBadge selfName={selfName} effective={effective} />
          <span className="min-w-0 flex-1 truncate text-body" data-testid="self-name">
            {selfName}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        data-testid="profile-card-menu"
        onCloseAutoFocus={(event) => {
          // The add-workspace item hands the next layer a dialog. If this
          // menu yanks focus back to the card, Esc lands on the trigger and
          // the form stays up (H-2).
          if (openingWorkspaceRef.current) {
            event.preventDefault();
            openingWorkspaceRef.current = false;
          }
        }}
      >
        <PresenceStatusItems
          workspaceId={workspaceId}
          selfMemberId={selfMemberId}
          selfMember={selfMember}
          onWrote={() => setOpen(false)}
        />
        <DropdownMenuSeparator />
        {/* Title over a visible row, not a submenu (#1383). The one real
            verb is the rail's 추가; switching workspaces is accrued. */}
        <DropdownMenuLabel>워크스페이스</DropdownMenuLabel>
        <DropdownMenuItem
          data-testid="profile-add-workspace"
          onSelect={() => {
            openingWorkspaceRef.current = true;
            const trigger =
              triggerRef.current ??
              document.querySelector<HTMLElement>('[data-testid="profile-card"]');
            openAddWorkspace(trigger);
          }}
        >
          <Plus className="size-4" aria-hidden="true" />
          워크스페이스 추가
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="nav-settings"
          title="설정 (⌘,)"
          onSelect={() => navigate("/settings")}
        >
          <Settings className="size-4" aria-hidden="true" />
          설정
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
