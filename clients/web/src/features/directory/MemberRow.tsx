import { uuidEq, type RosterMember } from "@momo/core/lib/api";
import { withOwnConnection } from "@momo/core/features/presence/statusDot";
import { cn } from "@/design/lib/cn";
import { ListRow } from "@/design/ui/list-row";
import { useSession } from "@/app/session";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { memberFor, type Directory, useRoleLabels } from "@/features/workspace/useWorkspace";
import { Avatar } from "@/features/timeline/MessageRow";
import { CustomStatusMark } from "@/features/sidebar/CustomStatusMark";
import { AgentLivenessLabel } from "@/features/agents/AgentLivenessLabel";
import { AvatarWithPresence } from "@/features/presence/HumanPresence";
import { useCustomStatusView } from "@/features/sidebar/useCustomStatusView";
import { CHIP_CLASS } from "@/features/common/chip";
import {
  memberRowLabel,
  roleLabel,
  statusLabel,
} from "@momo/core/features/directory/model";
import { visibleEmail } from "./memberListModel";

// =============================================================================
// One directory row (parity G-3), drawn with the shared list row (#5782,
// `design/ui/list-row.tsx`): avatar · two layers · trailing marks.
//
//   title     name (agent ink for an agent) · 「나」 on my own row · the custom
//             status emoji · a 초대됨/정지됨/삭제됨 chip when the member is not active
//   subtitle  people: 「@핸들 · 이메일」 (the email only when this viewer may see
//             it, `visibleEmail`) / agents: 「@핸들 · ○○ 님이 관리」
//   trailing  people: the role chip / agents: the liveness chip (ADR-0200 D4)
//
// Exactly two layers, always: the row's height is the two line boxes, so the
// skeleton (same component family) predicts it and the list does not move when
// the roster lands. The custom status TEXT is no longer a third line here; it
// stays in the accessible name and in the profile.
//
// Identity follows the timeline exactly: the shared Avatar carries --agent for
// an agent and nothing else does, and an agent is attributed to the human
// accountable for it with the same "{owner} 님이 관리" line the message row and
// the inbox already use.
//
// The row IS the action: the whole thing opens the shared identity card, so
// people, agents, self, and inactive members all have one row shape and one
// keyboard stop. The row runs the full pane (성재 결정 2026-08-10 검수 배치 2),
// inside its group card.
// =============================================================================

/** Status chip vessel by membership status: the not-active states are a warning, not a fact. */
const STATUS_CHIP_CLASS = cn(CHIP_CLASS, "bg-warn-soft text-warn");
const ROLE_CHIP_CLASS = cn(CHIP_CLASS, "bg-muted-soft text-ink-muted");

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
  const { workspaceId, connStatus } = useSession();
  const t = useFormatMessage();
  const labels = useRoleLabels(workspaceId);
  const isAgent = member.kind === "agent";
  const isSelf = uuidEq(member.id, selfMemberId);
  const owner = isAgent ? memberFor(directory, member.ownerHumanId) : null;
  const viewerRole = memberFor(directory, selfMemberId)?.role;
  const email = visibleEmail(viewerRole, member);
  const role = roleLabel(member, labels);
  const status = statusLabel(member);
  const { visible: custom, nowMs } = useCustomStatusView(member);

  const subtitle = [
    `@${member.handle}`,
    email,
    owner ? t("memberList.row.ownedBy", { name: owner.displayName }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  // `aria-label` REPLACES the subtree, so everything the eye gets from the row is
  // in it: the core sentence (name, handle, role, agent attribution, status,
  // presence, custom status) without its trailing action, then the email this
  // viewer can see, then this row's action (WCAG 2.5.3: the visible text is
  // inside the accessible name). The core sentence ends with its action by
  // contract (`memberRowLabel`: "the action comes last").
  const coreLabel = memberRowLabel(
    // 점이 눈에 말하는 것을 이름이 이어 말한다. 자기 행의 접속 여부는 이 클라이언트의 연결이다.
    withOwnConnection(member, selfMemberId, connStatus === "connected"),
    owner?.displayName ?? null,
    labels,
    nowMs
  ).replace(/, [^,]*$/, "");
  const ariaLabel = [
    coreLabel,
    email,
    t(isSelf ? "memberList.row.openOwnProfile" : "memberList.row.openProfile"),
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <ListRow
      data-testid="directory-row"
      data-member-id={member.id}
      data-member-kind={member.kind}
      data-directory-row=""
      aria-label={ariaLabel}
      onClick={(event) => onOpenProfile(member, event.currentTarget)}
      leading={
        // 사람에게만 모서리 점이 선다(모르면 점 없음). 점은 아바타 상자 안이라 행 높이가 움직이지 않는다.
        isAgent ? (
          <Avatar member={member} />
        ) : (
          <AvatarWithPresence member={member}>
            <Avatar member={member} />
          </AvatarWithPresence>
        )
      }
      title={
        <>
          <span
            className={cn(
              "min-w-0 truncate font-semibold",
              isAgent ? "text-agent" : "text-ink"
            )}
            data-testid="directory-row-name"
          >
            {member.displayName}
          </span>
          {isSelf ? (
            <span className="shrink-0 text-meta text-ink-muted" data-testid="directory-row-self">
              {t("memberList.row.self")}
            </span>
          ) : null}
          {custom ? (
            <CustomStatusMark status={custom} emojiOnly className="shrink-0 text-meta text-ink-muted" />
          ) : null}
          {status ? <span className={STATUS_CHIP_CLASS}>{status}</span> : null}
        </>
      }
      subtitle={<span data-testid="directory-row-subtitle">{subtitle}</span>}
      trailing={
        isAgent ? (
          // 「연결됨」이 아니라 「지금 살아 있는가」(ADR-0200 D4). hosted가 아닌 에이전트에는 서버가 답하지
          // 않아 아무것도 서지 않는다.
          <AgentLivenessLabel agentId={member.id} />
        ) : role ? (
          <span className={ROLE_CHIP_CLASS} data-testid="directory-row-role">
            {role}
          </span>
        ) : null
      }
    />
  );
}
