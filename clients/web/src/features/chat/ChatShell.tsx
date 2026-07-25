import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Hash, Lock, MessageSquare } from "lucide-react";
import { updateReadState, uuidEq, type Message } from "@/lib/api";
import { useSession } from "@/app/session";
import {
  channelLabel,
  channelLabelParts,
  dmPeer,
  makeDirectory,
  memberFor,
  unreadFor,
  useChannels,
  useDirectory,
  useInvalidateReadStates,
  useReadStates,
} from "@/features/workspace/useWorkspace";
import { Timeline } from "@/features/timeline/Timeline";
import { ThreadPanel } from "@/features/timeline/ThreadPanel";
import { useTimeline } from "@/features/timeline/useTimeline";
import {
  makeStressRoster,
  makeSyntheticMessages,
} from "@/features/timeline/stress";
import { Composer } from "@/features/chat/Composer";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

// =============================================================================
// Channel surface (R-1 §3): header, offline banner, timeline, composer, thread
// panel. The realtime rail and the sidebar live in the shell above, so moving
// between channels never drops the connection.
// =============================================================================

export function ChatShell() {
  const { session, workspaceId, realtime, connStatus } = useSession();
  const params = useParams();
  const navigate = useNavigate();

  // ── 1k-scroll gate: ?stress=N renders synthetic rows, no network ───────────
  const stressCount = useMemo(() => {
    const n = Number(new URLSearchParams(location.search).get("stress"));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }, []);
  const stressMessages = useMemo(
    () => (stressCount > 0 ? makeSyntheticMessages(stressCount) : []),
    [stressCount]
  );

  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const readStates = useReadStates(workspaceId);
  const invalidateReadStates = useInvalidateReadStates(workspaceId);

  // The stress path never hits /roster, so it carries its own members: without
  // them every row would render a uuid stub and the dense capture would review
  // a surface nobody ships.
  const stressDirectory = useMemo(
    () => makeDirectory(stressCount > 0 ? makeStressRoster() : []),
    [stressCount]
  );
  const directory =
    stressCount > 0 ? stressDirectory : directoryQuery.directory;

  // The index route lands on the first channel the server actually returned.
  // Nothing is hardcoded: a workspace with no channels renders the empty state
  // instead of pointing at an id that may not exist here.
  const channelId =
    params.channelId ??
    channelsQuery.groups.channels[0]?.id ??
    channelsQuery.groups.dms[0]?.id ??
    null;

  const channel = useMemo(
    () =>
      channelId === null
        ? null
        : [...channelsQuery.groups.channels, ...channelsQuery.groups.dms].find(
            (c) => uuidEq(c.id, channelId)
          ) ?? null,
    [channelsQuery.groups, channelId]
  );
  // Two labels, one rule (channelLabelParts): the header renders the name and
  // the disambiguating handle as separate spans, and everything that can only
  // take a string (the composer placeholder, its sr-only label) gets them
  // joined. A DM in this workspace can be one of two 김인턴.
  const labelParts = channel
    ? channelLabelParts(channel, directory, session.member.id)
    : null;
  const label = channel
    ? channelLabel(channel, directory, session.member.id)
    : "채널";
  const peer = channel ? dmPeer(channel, directory, session.member.id) : null;

  const timeline = useTimeline(
    realtime,
    workspaceId,
    stressCount > 0 ? null : channelId,
    session.member.id
  );
  const messages = stressCount > 0 ? stressMessages : timeline.state.messages;

  // Unread boundary is the cursor as it stood when the channel was OPENED:
  // advancing the cursor below must not erase the divider under the reader.
  const [openedWith, setOpenedWith] = useState<{
    channelId: string;
    lastReadSeq: number | null;
    unreadCount: number;
  } | null>(null);
  const markedRef = useRef<string | null>(null);

  useEffect(() => {
    if (channelId === null) return;
    const read = unreadFor(readStates.byChannel, channelId);
    setOpenedWith((current) => {
      if (current && uuidEq(current.channelId, channelId)) return current;
      if (!read) return { channelId, lastReadSeq: null, unreadCount: 0 };
      return {
        channelId,
        lastReadSeq: read.lastReadSeq,
        unreadCount: read.unreadCount,
      };
    });
  }, [channelId, readStates.byChannel]);

  // Advance the server read cursor once history is on screen (P7: the server
  // owns unread, so the client reports a position instead of counting).
  const newestSeq = timeline.state.newestSeq;
  useEffect(() => {
    if (stressCount > 0 || newestSeq === null || channelId === null) return;
    const key = `${channelId}:${newestSeq}`;
    if (markedRef.current === key) return;
    markedRef.current = key;
    updateReadState(workspaceId, channelId, newestSeq)
      .then(() => invalidateReadStates())
      .catch(() => {
        /* the cursor is advisory; the next open retries it */
      });
  }, [workspaceId, channelId, newestSeq, stressCount, invalidateReadStates]);

  const [thread, setThread] = useState<Message | null>(null);
  useEffect(() => setThread(null), [channelId]);

  // The composer owns its own ref for the mention popover, so this reaches it
  // by the id it already publishes (its sr-only <label htmlFor> points at the
  // same one). Focus, not scroll or fake typing: the empty DM state's action is
  // "start writing", and writing happens in the composer that is already there.
  const focusComposer = useCallback(() => {
    const input = document.getElementById("composer-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
  }, []);

  // Re-send a row the SERVER stored as `failed`. That message is durable and
  // will not change, so this is a genuinely new send with a fresh idempotency
  // key, not a retry of the old one: it goes through the same send path as the
  // composer and appears as a local echo until its own seq arrives. (The retry
  // on an unconfirmed echo is the opposite case and reuses its key; see
  // model.ts retryPending.)
  const timelineSend = timeline.send;
  const onResend = useCallback(
    (message: Message) => {
      if (channelId === null || !message.body) return;
      return timelineSend(message.body);
    },
    [channelId, timelineSend]
  );

  // Read-only probe for the browser gate runner (DOM stays the primary source
  // of truth; this just avoids scraping when convenient).
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__spike = {
      count: messages.length,
      newestSeq: timeline.state.newestSeq,
      oldestSeq: timeline.state.oldestSeq,
      connStatus,
      resume: timeline.resume,
      recoveryMarkers: timeline.recoveryMarkers.length,
      // Local echoes still awaiting a seq. A gate that sees this fall back to 0
      // has watched the optimistic row reconcile into the confirmed stream.
      pending: timeline.pending.length,
      stress: stressCount,
    };
  }, [
    messages.length,
    timeline.state,
    timeline.resume,
    timeline.recoveryMarkers,
    timeline.pending,
    connStatus,
    stressCount,
  ]);

  const memberSummary = useMemo(() => {
    // A DM's participants are the title and me. Repeating "데모 사용자, 김인턴"
    // beside a title that already says 김인턴 @intern-kim adds a second, less
    // precise copy of the same fact.
    if (!channel || channel.kind === "dm") return "";
    const ids = directory.members
      .filter((m) => m.channelIds.some((id) => uuidEq(id, channel.id)))
      .map((m) => m.id);
    const names = ids
      .map((id) => memberFor(directory, id)?.displayName)
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) return "";
    if (names.length <= 3) return names.join(", ");
    return `${names.slice(0, 3).join(", ")} 외 ${names.length - 3}`;
  }, [channel, directory]);

  const offline = stressCount === 0 && connStatus === "disconnected";
  const hasChannel = stressCount > 0 || channelId !== null;

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="text-ink-muted">
              {channel?.kind === "dm" ? (
                <MessageSquare className="size-4" />
              ) : channel?.kind === "private" ? (
                <Lock className="size-4" />
              ) : (
                <Hash className="size-4" />
              )}
            </span>
            <h1
              className={cn(
                "truncate text-body font-semibold",
                labelParts?.isAgent && stressCount === 0 && "text-agent"
              )}
            >
              {stressCount > 0
                ? `스크롤 측정 (${stressCount})`
                : labelParts?.text ?? label}
            </h1>
            {stressCount === 0 && labelParts?.handle && (
              <span
                className="shrink-0 text-meta text-ink-muted"
                data-testid="channel-handle"
              >
                {labelParts.handle}
              </span>
            )}
            {memberSummary && (
              <span className="truncate text-meta text-ink-muted">
                {memberSummary}
              </span>
            )}
            <span className="sr-only" data-testid="message-count">
              메시지 {messages.length}개
            </span>
          </div>
          {timeline.resume.resubscribeCount > 0 && (
            <span
              className="shrink-0 text-timestamp text-ink-muted"
              data-numeric
              data-testid="resume-info"
            >
              재연결 {timeline.resume.resubscribeCount}회
            </span>
          )}
        </header>

        {offline && (
          <InlineBanner
            tone="neutral"
            message="연결 끊김, 재연결 중입니다. 지금 보이는 내용은 마지막으로 확인된 상태입니다."
            testId="offline-banner"
          />
        )}

        <div className="min-h-0 flex-1">
          {hasChannel ? (
            <Timeline
              messages={messages}
              directory={directory}
              status={stressCount > 0 ? "ready" : timeline.status}
              lastReadSeq={openedWith?.lastReadSeq ?? null}
              unreadCount={openedWith?.unreadCount ?? 0}
              recoveryMarkers={timeline.recoveryMarkers}
              pending={stressCount > 0 ? undefined : timeline.pending}
              onStartReached={stressCount > 0 ? undefined : timeline.loadOlder}
              onRetry={timeline.reload}
              onOpenThread={setThread}
              onResend={stressCount > 0 ? undefined : onResend}
              onResendPending={stressCount > 0 ? undefined : timeline.resend}
              channelKind={channel?.kind}
              peer={peer}
              onInviteMember={() => navigate("/settings?section=members")}
              onStartWriting={focusComposer}
            />
          ) : channelsQuery.isLoading ? (
            <SkeletonRows rows={6} className="p-4" />
          ) : channelsQuery.error ? (
            <InlineBanner
              message="채널을 불러오지 못했습니다."
              actionLabel="다시 시도"
              onAction={() => void channelsQuery.refetch()}
              testId="chat-channels-error"
            />
          ) : (
            <EmptyInvite
              headline="아직 채널이 없습니다. 첫 채널을 만들어 팀을 시작하세요."
              actions={
                <Button size="sm" onClick={() => navigate("/settings")}>
                  채널 만들기
                </Button>
              }
              testId="chat-no-channel"
            />
          )}
        </div>

        {stressCount === 0 && channelId !== null && (
          <Composer
            channelId={channelId}
            directory={directory}
            channelLabel={label}
            onSend={timeline.send}
          />
        )}
      </div>

      {thread && channelId !== null && (
        <ThreadPanel
          workspaceId={workspaceId}
          channelId={channelId}
          root={thread}
          directory={directory}
          onClose={() => setThread(null)}
        />
      )}
    </div>
  );
}
