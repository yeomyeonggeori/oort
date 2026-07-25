import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import {
  Activity,
  Bot,
  Hash,
  Inbox,
  Lock,
  MessageSquare,
  Settings,
  User,
  Users,
} from "lucide-react";
import { useSession } from "@/app/session";
import {
  channelLabel,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { switcherPeople } from "@/features/directory/model";
import { useOpenDm } from "@/features/directory/useOpenDm";
import { InlineBanner } from "@/features/common/States";

// =============================================================================
// ⌘K quick switcher (R-1 §공통계약, ADR-0133 stack: cmdk). Channels, DMs, people
// and the global surfaces in one list. Arrow keys move, Enter opens, Esc closes:
// cmdk owns that grammar, so no custom key handling beyond the ⌘K toggle.
//
// 사람 (parity G-3/G-4) is a section of the SAME palette rather than a second
// picker: "누구와 이야기할까"는 "어디로 갈까"의 한 갈래다. Choosing a person goes
// through the same useOpenDm path a directory row uses, so an existing
// conversation is reused instead of a second one being created.
// =============================================================================

const itemClass =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1 text-body " +
  "text-ink data-[selected=true]:bg-accent-soft " +
  "data-[selected=true]:text-ink";

// cmdk renders the group label into a [cmdk-group-heading] element it owns, so
// it is styled from the list rather than by a className we could pass. Same
// weight as the sidebar section header (SidebarSection): a section label is a
// section label wherever it appears.
const groupHeadingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 " +
  "[&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium " +
  "[&_[cmdk-group-heading]]:text-ink-muted";

export function QuickSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session, workspaceId } = useSession();
  const navigate = useNavigate();
  const { groups } = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const dm = useOpenDm();
  const { clearError } = dm;

  // Who a DM can be opened with, decided by the directory's own rule rather
  // than by a second filter that would drift from it (model.switcherPeople).
  const people = useMemo(
    () => switcherPeople(directory.members, session.member.id),
    [directory.members, session.member.id]
  );

  // A failed DM belongs to the attempt that failed, not to the palette. The
  // palette outlives its openings — cmdk unmounts the dialog contents but this
  // component stays — so nothing else would ever clear the banner, and a ⌘K
  // opened to jump to a channel would start with an error already given up on.
  useEffect(() => {
    if (!open) clearError();
  }, [open, clearError]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      // ⌘⇧K = 새 다이렉트 메시지 (R-1 §1 키보드 경로). It lands on the member
      // directory, which is where a DM starts. Checked BEFORE ⌘K, because the
      // shifted key still reports as "k" and would otherwise toggle the palette.
      if (event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(false);
        navigate("/directory");
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
      // ⌘, opens settings (R-1 §1 keyboard path).
      if (event.key === ",") {
        event.preventDefault();
        navigate("/settings");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange, navigate]);

  function go(path: string) {
    onOpenChange(false);
    navigate(path);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="검색과 이동"
      overlayClassName="fixed inset-0 bg-ink/20"
      contentClassName="fixed left-1/2 top-8 w-full max-w-lg -translate-x-1/2 rounded-md border border-line bg-surface-raised text-ink shadow-lg"
      data-testid="quick-switcher"
    >
      <Command.Input
        placeholder="채널, 사람, 설정으로 이동"
        data-testid="quick-switcher-input"
        className="w-full border-b border-line bg-transparent px-4 py-3 text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-muted"
      />

      {/* A DM that failed to open keeps the palette up: the message belongs next
       * to the name that was picked, not behind a dialog that closed itself. */}
      {dm.error && (
        <InlineBanner message={dm.error.message} testId="switcher-dm-error" />
      )}

      <Command.List
        className={`max-h-pane overflow-y-auto p-2 ${groupHeadingClass}`}
      >
        <Command.Empty className="px-2 py-3 text-body text-ink-muted">
          일치하는 채널이나 사람이 없습니다. 다른 이름으로 검색하세요.
        </Command.Empty>

        <Command.Group heading="이동">
          <Command.Item className={itemClass} onSelect={() => go("/inbox")}>
            <Inbox className="size-4 opacity-70" />
            인박스
          </Command.Item>
          <Command.Item className={itemClass} onSelect={() => go("/activity")}>
            <Activity className="size-4 opacity-70" />
            활동
          </Command.Item>
          <Command.Item
            className={itemClass}
            value="멤버 디렉터리 명부"
            onSelect={() => go("/directory")}
          >
            <Users className="size-4 opacity-70" />
            멤버 디렉터리
          </Command.Item>
          <Command.Item className={itemClass} onSelect={() => go("/settings")}>
            <Settings className="size-4 opacity-70" />
            설정
          </Command.Item>
        </Command.Group>

        <Command.Group heading="채널">
          {groups.channels.map((channel) => (
            <Command.Item
              key={channel.id}
              value={`${channel.name ?? ""} ${channel.id}`}
              className={itemClass}
              onSelect={() => go(`/c/${channel.id}`)}
            >
              {channel.kind === "private" ? (
                <Lock className="size-4 opacity-70" />
              ) : (
                <Hash className="size-4 opacity-70" />
              )}
              {channel.name ?? "이름 없는 채널"}
            </Command.Item>
          ))}
        </Command.Group>

        {groups.dms.length > 0 && (
          <Command.Group heading="다이렉트 메시지">
            {groups.dms.map((channel) => {
              const label = channelLabel(channel, directory, session.member.id);
              return (
                <Command.Item
                  key={channel.id}
                  value={`${label} ${channel.id}`}
                  className={itemClass}
                  onSelect={() => go(`/c/${channel.id}`)}
                >
                  <MessageSquare className="size-4 opacity-70" />
                  {label}
                </Command.Item>
              );
            })}
          </Command.Group>
        )}

        {people.length > 0 && (
          <Command.Group heading="사람">
            {people.map(({ member, selectable, reason }) => (
              <Command.Item
                key={member.id}
                value={`${member.displayName} ${member.handle} ${member.id}`}
                className={itemClass}
                data-testid="switcher-person"
                data-member-id={member.id}
                data-member-kind={member.kind}
                // cmdk skips a disabled item for arrow keys, Enter and click,
                // while keeping it in the filtered list: the name is still
                // findable, it just is not an action.
                disabled={!selectable}
                onSelect={() => {
                  void dm.openDm(member).then((opened) => {
                    if (opened) onOpenChange(false);
                  });
                }}
              >
                {/* Agent identity is the --agent token on the glyph and nothing
                 * else: same row, same type as a human (design-taste-web §9). */}
                {member.kind === "agent" ? (
                  <Bot className="size-4 text-agent" />
                ) : (
                  <User className="size-4 opacity-70" />
                )}
                {member.displayName}
                <span className="text-meta text-ink-muted">
                  @{member.handle}
                </span>
                {/* Same word the directory row uses, same token, so the two
                 * surfaces do not invent two vocabularies for one status. */}
                {reason && <span className="text-meta text-warn">{reason}</span>}
                {dm.pendingMemberId === member.id && (
                  <span className="text-meta text-ink-muted">여는 중</span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
