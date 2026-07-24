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
    <nav className="flex flex-col gap-0.5 p-2" data-testid="channel-list">
      <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
        채널
      </div>
      {isLoading && (
        <p className="px-2 py-1 text-sm text-[var(--color-muted-foreground)]">
          불러오는 중…
        </p>
      )}
      {error && (
        <p className="px-2 py-1 text-sm text-[var(--color-destructive)]">
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
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              active
                ? "bg-[var(--color-accent)] text-[var(--color-accent-foreground)]"
                : "text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            )}
          >
            {channel.kind === "private" ? (
              <Lock className="size-3.5 opacity-60" />
            ) : (
              <Hash className="size-3.5 opacity-60" />
            )}
            <span className="truncate">{channel.name ?? "(dm)"}</span>
          </button>
        );
      })}
    </nav>
  );
}
