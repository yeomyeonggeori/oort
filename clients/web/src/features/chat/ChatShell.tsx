import { useEffect, useMemo, useRef, useState } from "react";
import type { Channel, LoginResponse } from "@/lib/api";
import {
  createRealtime,
  resolveSpikeRealtimeUrl,
  type RealtimeHandle,
  type RealtimeStatus,
} from "@/lib/realtime";
import { ChannelList } from "@/features/channels/ChannelList";
import { Timeline } from "@/features/timeline/Timeline";
import { Composer } from "@/features/chat/Composer";
import { useTimeline } from "@/features/timeline/useTimeline";
import { makeSyntheticMessages } from "@/features/timeline/stress";
import { RuntimeBadge } from "@/app/RuntimeBadge";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

const GENERAL_ID = "00000000-0000-7000-8000-000000000201";

function statusColor(s: RealtimeStatus): string {
  if (s === "connected") return "bg-ok";
  if (s === "connecting") return "bg-warn";
  return "bg-danger";
}

export function ChatShell({
  session,
  onLogout,
}: {
  session: LoginResponse;
  onLogout: () => void;
}) {
  const workspaceId = session.member.workspaceId;

  // ── 1k-scroll gate: ?stress=N renders synthetic rows, no network ───────────
  const stressCount = useMemo(() => {
    const n = Number(new URLSearchParams(location.search).get("stress"));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }, []);
  const stressMessages = useMemo(
    () => (stressCount > 0 ? makeSyntheticMessages(stressCount) : []),
    [stressCount]
  );

  // ── realtime rail (one handle per session) ─────────────────────────────────
  const [realtime, setRealtime] = useState<RealtimeHandle | null>(null);
  const [connStatus, setConnStatus] = useState<RealtimeStatus>("connecting");
  const realtimeRef = useRef<RealtimeHandle | null>(null);

  useEffect(() => {
    if (stressCount > 0) return; // skip WS in pure-scroll gate
    const handle = createRealtime(
      resolveSpikeRealtimeUrl(session.realtimeWebSocketUrl),
      setConnStatus
    );
    realtimeRef.current = handle;
    setRealtime(handle);
    return () => {
      handle.dispose();
      realtimeRef.current = null;
      setRealtime(null);
    };
  }, [session.realtimeWebSocketUrl, stressCount]);

  const [selected, setSelected] = useState<Channel | null>(null);
  const channelId = selected?.id ?? GENERAL_ID;

  const timeline = useTimeline(
    realtime,
    workspaceId,
    stressCount > 0 ? null : channelId
  );

  const messages = stressCount > 0 ? stressMessages : timeline.state.messages;

  // Expose a tiny read-only probe for the browser gate runner (DOM stays the
  // primary source of truth; this just avoids scraping when convenient).
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__spike = {
      count: messages.length,
      newestSeq: timeline.state.newestSeq,
      oldestSeq: timeline.state.oldestSeq,
      connStatus,
      resume: timeline.resume,
      stress: stressCount,
    };
  }, [messages.length, timeline.state, connStatus, timeline.resume, stressCount]);

  return (
    <div className="app-shell h-full">
      <aside className="flex flex-col border-r border-line bg-surface-sidebar">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <span className="truncate text-body font-semibold">
            {session.member.displayName}
          </span>
          <RuntimeBadge />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ChannelList
            workspaceId={workspaceId}
            selectedId={channelId}
            onSelect={setSelected}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="m-2 justify-start"
          onClick={onLogout}
          data-testid="logout"
        >
          로그아웃
        </Button>
      </aside>

      <main className="flex min-w-0 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold">
              {stressCount > 0
                ? `stress (${stressCount})`
                : `#${selected?.name ?? "general"}`}
            </span>
            <span
              className="text-meta text-ink-muted"
              data-numeric
              data-testid="message-count"
            >
              {messages.length} messages
            </span>
          </div>
          <div className="flex items-center gap-3">
            {timeline.resume.resubscribeCount > 0 && (
              <span
                className="text-timestamp text-ink-muted"
                data-numeric
                data-testid="resume-info"
              >
                resubscribe #{timeline.resume.resubscribeCount} · recovered=
                {String(timeline.resume.lastRecovered)} · backfill=
                {timeline.resume.lastBackfillCount}
              </span>
            )}
            <span className="flex items-center gap-2 text-meta text-ink-muted">
              <span
                className={cn("size-2 rounded-full", statusColor(connStatus))}
                data-testid="conn-status"
                data-status={stressCount > 0 ? "n/a" : connStatus}
              />
              {stressCount > 0 ? "n/a" : connStatus}
            </span>
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <Timeline
            messages={messages}
            selfMemberId={session.member.id}
            onStartReached={stressCount > 0 ? undefined : timeline.loadOlder}
          />
        </div>

        {stressCount === 0 && (
          <Composer workspaceId={workspaceId} channelId={channelId} />
        )}
      </main>
    </div>
  );
}
