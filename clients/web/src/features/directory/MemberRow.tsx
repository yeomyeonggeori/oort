import { MessageSquare } from "lucide-react";
import type { RosterMember } from "@/lib/api";
import { cn } from "@/design/lib/cn";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { Avatar } from "@/features/timeline/MessageRow";
import {
  dmAvailability,
  memberRowLabel,
  roleLabel,
  statusLabel,
} from "./model";

// =============================================================================
// One directory row (parity G-3). Flat row, separator, hover background: a
// member list is a list, not a stack of cards (design-taste-web §8).
//
// Identity follows the timeline exactly: the shared Avatar carries --agent for
// an agent and nothing else does, the name sits in the same slot for both
// kinds, and an agent is attributed to the human accountable for it with the
// same "managed by {owner}" line the message row and the inbox already use.
//
// The row IS the action (parity G-4): the whole thing is one button that opens
// the DM, because opening a conversation with someone is the only thing this
// surface exists to do. Rows that cannot be a DM target (yourself, a member who
// is not active) render as plain rows instead of dead buttons, and say why.
//
// Measure: the hover background and the separator run the full pane, but the
// CONTENT is capped at max-w-pane-lg, the same 640px the search field above it
// uses. Left full-bleed on a 1600px window the trailing glyph landed ~900px
// from the name it belongs to, which is the exact failure tokens.md §4 names
// (a right-aligned column a screen away from its label stops reading as a row
// and starts reading as a banner).
// =============================================================================

// Exported because the loading state has to predict this exact geometry. A
// skeleton that guesses at the shape is a skeleton that moves the list when the
// roster lands, so DirectoryRoute builds its placeholder rows from the SAME two
// constants rather than from a second description of them.
export const ROW_CLASS =
  "flex w-full items-center border-b border-line px-4 py-2 text-left";

export const CONTENT_CLASS = "flex w-full max-w-pane-lg items-center gap-3";

export function MemberRow({
  member,
  directory,
  selfMemberId,
  pending,
  onOpenDm,
}: {
  member: RosterMember;
  directory: Directory;
  selfMemberId: string;
  /** This row's DM request is in flight. */
  pending: boolean;
  onOpenDm: (member: RosterMember) => void;
}) {
  const isAgent = member.kind === "agent";
  const owner = isAgent ? memberFor(directory, member.ownerHumanId) : null;
  const role = roleLabel(member);
  const status = statusLabel(member);
  const availability = dmAvailability(member, selfMemberId);

  const identity = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "text-body font-semibold",
            isAgent ? "text-agent" : "text-ink"
          )}
        >
          {member.displayName}
        </span>
        <span className="text-meta text-ink-muted">@{member.handle}</span>
        {role && <span className="text-meta text-ink-muted">{role}</span>}
        {status && <span className="text-meta text-warn">{status}</span>}
      </span>
      {owner && (
        <span className="text-meta text-ink-muted">
          managed by {owner.displayName}
        </span>
      )}
    </span>
  );

  const shared = {
    "data-testid": "directory-row",
    "data-member-id": member.id,
    "data-member-kind": member.kind,
  };

  if (availability.kind !== "ready") {
    return (
      <li>
        <div {...shared} className={ROW_CLASS}>
          <span className={CONTENT_CLASS}>
            <Avatar member={member} name={member.displayName} />
            {identity}
            {/* Self is marked here; an inactive member already carries its
                status beside the name, so the trailing slot stays empty rather
                than saying 초대됨 twice on one row. */}
            {availability.kind === "self" && (
              <span className="shrink-0 text-meta text-ink-muted">나</span>
            )}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        {...shared}
        data-directory-row=""
        disabled={pending}
        // Name AND handle AND attribution: two rows here really do share a
        // display name, so a label of the name alone would offer a screen
        // reader two identical actions (model.memberRowLabel).
        aria-label={memberRowLabel(member, owner?.displayName ?? null)}
        onClick={() => onOpenDm(member)}
        className={cn(
          ROW_CLASS,
          "transition-colors hover:bg-surface-hover",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          "disabled:cursor-default disabled:opacity-50"
        )}
      >
        <span className={CONTENT_CLASS}>
          <Avatar member={member} name={member.displayName} />
          {identity}
          {pending ? (
            <span className="shrink-0 text-meta text-ink-muted">여는 중</span>
          ) : (
            <span className="shrink-0 text-ink-muted" aria-hidden="true">
              <MessageSquare className="size-4" />
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
