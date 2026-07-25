import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { Activity, Hash, Inbox, Lock, MessageSquare, Settings } from "lucide-react";
import { useSession } from "@/app/session";
import {
  channelLabel,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";

// =============================================================================
// ⌘K quick switcher (R-1 §공통계약, ADR-0133 stack: cmdk). Channels, DMs and the
// global surfaces in one list. Arrow keys move, Enter opens, Esc closes: cmdk
// owns that grammar, so no custom key handling beyond the ⌘K toggle.
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
      // ⌘, opens settings (R-1 §1 keyboard path).
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
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
        placeholder="채널, 다이렉트 메시지, 설정으로 이동"
        data-testid="quick-switcher-input"
        className="w-full border-b border-line bg-transparent px-4 py-3 text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-muted"
      />
      <Command.List
        className={`max-h-pane overflow-y-auto p-2 ${groupHeadingClass}`}
      >
        <Command.Empty className="px-2 py-3 text-body text-ink-muted">
          일치하는 채널이 없습니다. 다른 이름으로 검색하세요.
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
      </Command.List>
    </Command.Dialog>
  );
}
