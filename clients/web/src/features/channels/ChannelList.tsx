import { useQuery } from "@tanstack/react-query";
import { listChannels, type Channel, uuidEq } from "@/lib/api";
import { cn } from "@/design/lib/cn";
import { Hash, Lock } from "lucide-react";

export function ChannelList({
  workspaceId,
  selectedId,
  onSelect,
}: {
  workspaceId: string;
  selectedId: string | null;
  onSelect: (channel: Channel) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["channels", workspaceId],
    queryFn: () => listChannels(workspaceId),
  });

  return (
    <nav className="flex flex-col gap-1 p-2" data-testid="channel-list">
      <div className="px-2 pb-1 pt-2 text-timestamp font-semibold text-ink-muted">
        채널
      </div>
      {isLoading && (
        <p className="px-2 py-1 text-body text-ink-muted">
          불러오는 중…
        </p>
      )}
      {error && (
        <p className="px-2 py-1 text-body text-danger">
          채널 로드 실패
        </p>
      )}
      {data?.map((channel) => {
        const active = uuidEq(channel.id, selectedId ?? undefined);
        return (
          <button
            key={channel.id}
            onClick={() => onSelect(channel)}
            data-testid="channel-item"
            data-channel-id={channel.id}
            className={cn(
              "flex items-center gap-2 rounded-sm px-2 py-1 text-left text-body transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              active
                ? "bg-accent-soft text-ink"
                : "text-ink hover:bg-surface-hover"
            )}
          >
            {channel.kind === "private" ? (
              <Lock className="size-4 text-ink-muted" />
            ) : (
              <Hash className="size-4 text-ink-muted" />
            )}
            <span className="truncate">{channel.name ?? "(dm)"}</span>
          </button>
        );
      })}
    </nav>
  );
}
