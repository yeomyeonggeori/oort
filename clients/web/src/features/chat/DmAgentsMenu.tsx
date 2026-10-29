import { useState } from "react";
import { EllipsisVertical } from "lucide-react";
import { removeDmAgent, type Channel } from "@momo/core/lib/api";
import { removableDmAgents } from "@momo/core/features/agents/dmAdmission";
import type { Directory } from "@momo/core/features/workspace/directory";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { Tooltip } from "@/design/ui/tooltip";
import { channelHeaderControlClass } from "./channelHeaderControl";

export function DmAgentsMenu({
  workspaceId,
  channel,
  directory,
  onChanged,
}: {
  workspaceId: string;
  channel: Channel;
  directory: Directory;
  onChanged: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agents = removableDmAgents(channel, directory);
  if (agents.length === 0) return null;
  async function remove(agentId: string) {
    setPending(agentId);
    setError(null);
    try {
      await removeDmAgent(workspaceId, channel.id, agentId);
      await onChanged();
      setOpen(false);
    } catch {
      setError(
        "에이전트를 내보내지 못했어요. 연결을 확인하고 다시 시도해 주세요."
      );
    } finally {
      setPending(null);
    }
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip label="대화 멤버 관리" side="bottom" align="end">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={channelHeaderControlClass()}
            aria-label="대화 멤버 관리"
            data-testid="dm-agent-menu"
          >
            <EllipsisVertical className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>에이전트 · 이후 대화를 봐요</DropdownMenuLabel>
        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            disabled={pending !== null}
            onSelect={(event) => {
              event.preventDefault();
              void remove(agent.id);
            }}
          >
            {pending === agent.id
              ? "내보내는 중이에요"
              : `${agent.displayName} (@${agent.handle}) 내보내기`}
          </DropdownMenuItem>
        ))}
        {error !== null ? (
          <p className="px-2 py-2 text-meta text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
