import { ChevronRight } from "lucide-react";
import { uuidEq, type RosterMember } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { Avatar } from "@/features/timeline/MessageRow";
import {
  memberRowLabel,
  roleLabel,
  statusLabel,
} from "@momo/core/features/directory/model";

// =============================================================================
// One directory row (parity G-3). Flat row, separator, hover background: a
// member list is a list, not a stack of cards (design-taste-web §8).
//
// Identity follows the timeline exactly: the shared Avatar carries --agent for
// an agent and nothing else does, the name sits in the same slot for both
// kinds, and an agent is attributed to the human accountable for it with the
// same "{owner} 님이 관리" line the message row and the inbox already use.
//
// The row IS the action: the whole thing opens the shared identity card. The
// card owns the DM action and its unavailable reason, so people, agents, self,
// and inactive members all have one consistent row shape and one keyboard stop.
//
// Measure: the row runs the full pane, matching 인박스 and 활동. The 640px
// content cap this row used to carry (tokens.md §4, "a card is not a banner")
// left a dead band on the right of every row on a wide window and stranded the
// hover in the left 640px; 성재 결정(2026-08-10 검수 배치 2)이 전체폭으로
// 통일했다. The avatar leads, the identity takes the slack, and the trailing
// chevron closes the row at the pane edge, one measure with the header and search.
// =============================================================================

// Exported because the loading state has to predict this exact geometry. A
// skeleton that guesses at the shape is a skeleton that moves the list when the
// roster lands, so DirectoryRoute builds its placeholder rows from the SAME two
// constants rather than from a second description of them.
export const ROW_CLASS =
  "flex w-full items-center border-b border-line px-4 py-2 text-left";

export const CONTENT_CLASS = "flex w-full items-center gap-3";

export function MemberRow({
  member,
  directory,
  selfMemberId,
  onOpenProfile,
}: {
  member: RosterMember;
  directory: Directory;
  selfMemberId: string;
  onOpenProfile: (member: RosterMember, opener: HTMLElement) => void;
}) {
  const isAgent = member.kind === "agent";
  const owner = isAgent ? memberFor(directory, member.ownerHumanId) : null;
  const role = roleLabel(member);
  const status = statusLabel(member);

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
          {owner.displayName} 님이 관리
        </span>
      )}
    </span>
  );

  const shared = {
    "data-testid": "directory-row",
    "data-member-id": member.id,
    "data-member-kind": member.kind,
  };

  return (
    <li>
      <button
        type="button"
        {...shared}
        data-directory-row=""
        aria-label={memberRowLabel(
          member,
          owner?.displayName ?? null
        ).replace(
          "다이렉트 메시지 열기",
          uuidEq(member.id, selfMemberId) ? "나, 프로필 열기" : "프로필 열기"
        )}
        onClick={(event) => onOpenProfile(member, event.currentTarget)}
        className={cn(
          ROW_CLASS,
          CONTENT_CLASS,
          "transition-colors hover:bg-surface-hover focus-visible:focus-ring"
        )}
      >
        <Avatar member={member} />
        {identity}
        {uuidEq(member.id, selfMemberId) && (
          <span className="shrink-0 text-meta text-ink-muted">나</span>
        )}
        <span className="shrink-0 text-ink-muted" aria-hidden="true">
          <ChevronRight className="size-4" />
        </span>
      </button>
    </li>
  );
}
