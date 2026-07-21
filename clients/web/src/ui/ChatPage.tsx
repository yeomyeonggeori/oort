import { useCallback, useEffect, useMemo, useState } from "react";
import type { Channel, RosterMember } from "../api/client";
import {
  fetchRoster,
  listChannels,
  listDms,
  logout,
  openDm,
  uuidEq,
} from "../api/client";
import type { SessionData } from "../auth/session";
import type { RealtimeHandle, RealtimeStatus } from "../realtime/realtime";
import { createRealtime } from "../realtime/realtime";
import { useApprovals } from "../state/approvals";
import { useReadStates } from "../state/readStates";
import ApprovalsPanel from "./ApprovalsPanel";
import ChannelList from "./ChannelList";
import Timeline from "./Timeline";

interface ChatPageProps {
  session: SessionData;
  authExpired: boolean;
}

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  connecting: "연결 중",
  connected: "실시간 연결됨",
  disconnected: "연결 끊김",
};

export default function ChatPage({ session, authExpired }: ChatPageProps) {
  const workspaceId = session.member.workspaceId;
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDms] = useState<Channel[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null
  );
  const [view, setView] = useState<"channel" | "approvals">("channel");
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [realtimeStatus, setRealtimeStatus] =
    useState<RealtimeStatus>("connecting");
  const [realtime, setRealtime] = useState<RealtimeHandle | null>(null);

  // One realtime connection per session. The websocket address comes only
  // from the login response (ADR-0110).
  useEffect(() => {
    const handle = createRealtime(
      session.realtimeWebSocketUrl,
      setRealtimeStatus
    );
    setRealtime(handle);
    return () => {
      setRealtime(null);
      handle.dispose();
    };
  }, [session.realtimeWebSocketUrl]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const readStates = useReadStates(workspaceId, session.member.id, realtime);
  const approvals = useApprovals(workspaceId);
  const refreshPending = approvals.refreshPending;

  // Re-sync the pending list whenever the approvals surface opens.
  useEffect(() => {
    if (view === "approvals") void refreshPending();
  }, [refreshPending, view]);

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      setLoadingWorkspace(true);
      try {
        const [channelsResponse, dmsResponse, rosterResponse] =
          await Promise.all([
            listChannels(workspaceId),
            listDms(workspaceId),
            fetchRoster(workspaceId),
          ]);
        if (cancelled) return;
        // The DM sidebar section is fed by GET /dms; drop DMs from the
        // channels listing to avoid double entries.
        const regular = channelsResponse.channels.filter(
          (channel) => channel.kind !== "dm"
        );
        setChannels(regular);
        setDms(dmsResponse.channels);
        setRoster(rosterResponse.members);
        setSelectedChannelId(
          (current) =>
            current ?? regular[0]?.id ?? dmsResponse.channels[0]?.id ?? null
        );
        setLoadError(null);
      } catch {
        if (!cancelled) {
          setLoadError("워크스페이스 정보를 불러오지 못했습니다.");
        }
      } finally {
        if (!cancelled) setLoadingWorkspace(false);
      }
    }
    void loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, workspaceId]);

  const memberNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of roster) {
      names.set(member.id.toLowerCase(), member.displayName);
    }
    return names;
  }, [roster]);

  const displayNameFor = useCallback(
    (memberId: string) =>
      memberNames.get(memberId.toLowerCase()) ??
      `멤버 ${memberId.slice(0, 8).toLowerCase()}`,
    [memberNames]
  );

  const channelLabelFor = useCallback(
    (channel: Channel): string => {
      if (channel.kind === "dm") {
        const other = (channel.memberIds ?? []).find(
          (id) => !uuidEq(id, session.member.id)
        );
        return other ? displayNameFor(other) : "다이렉트 메시지";
      }
      return `#${channel.name ?? "이름 없음"}`;
    },
    [displayNameFor, session.member.id]
  );

  const dmCandidates = useMemo(
    () =>
      roster.filter(
        (member) =>
          member.status === "active" && !uuidEq(member.id, session.member.id)
      ),
    [roster, session.member.id]
  );

  const handleOpenDm = useCallback(
    async (memberId: string) => {
      try {
        const response = await openDm(workspaceId, memberId);
        setDms((current) =>
          current.some((channel) => uuidEq(channel.id, response.channel.id))
            ? current
            : [response.channel, ...current]
        );
        setSelectedChannelId(response.channel.id);
        setDmPickerOpen(false);
        setView("channel");
      } catch {
        setLoadError("대화를 열지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }
    },
    [workspaceId]
  );

  const handleSelectChannel = useCallback((channelId: string) => {
    setSelectedChannelId(channelId);
    setView("channel");
    setLoadError(null);
  }, []);

  const selectedChannel =
    [...channels, ...dms].find((channel) =>
      uuidEq(channel.id, selectedChannelId ?? "")
    ) ?? null;

  const pendingApprovalCount = approvals.pending.filter(
    (approval) => approvals.statusFor(approval.id) === "pending"
  ).length;

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="workspace-name">momo 워크스페이스</span>
          <span className="workspace-id">{workspaceId.slice(0, 8)}</span>
          <span
            className={`realtime-status realtime-${realtimeStatus}`}
            data-testid="realtime-status"
            data-status={realtimeStatus}
          >
            {STATUS_LABEL[realtimeStatus]}
          </span>
        </header>

        <button
          type="button"
          className={
            view === "approvals"
              ? "approvals-button approvals-button-active"
              : "approvals-button"
          }
          data-testid="approvals-button"
          onClick={() =>
            setView((current) =>
              current === "approvals" ? "channel" : "approvals"
            )
          }
        >
          승인 요청
          {pendingApprovalCount > 0 && (
            <span
              className="unread-badge"
              data-testid="approvals-pending-count"
              data-count={pendingApprovalCount}
            >
              {pendingApprovalCount}
            </span>
          )}
        </button>

        <ChannelList
          channels={channels}
          dms={dms}
          selectedChannelId={selectedChannelId}
          labelFor={channelLabelFor}
          onSelect={handleSelectChannel}
          unreadFor={readStates.entryFor}
          dmPickerOpen={dmPickerOpen}
          onToggleDmPicker={() => setDmPickerOpen((open) => !open)}
          dmCandidates={dmCandidates}
          onOpenDm={(memberId) => void handleOpenDm(memberId)}
        />

        <footer className="sidebar-footer">
          <span className="me-name" data-testid="me-name">
            {session.member.displayName}
          </span>
          <button
            type="button"
            className="ghost-button"
            data-testid="logout-button"
            onClick={() => void logout()}
          >
            로그아웃
          </button>
        </footer>
      </aside>

      <main className="main-pane">
        {!online && (
          <div className="status-banner" role="status">
            오프라인입니다. 기존 메시지는 계속 볼 수 있으며, 연결되면 새 내용을 동기화합니다.
          </div>
        )}
        {online && realtimeStatus === "disconnected" && (
          <div className="status-banner" role="status">
            실시간 연결이 끊겼습니다. REST 복구를 시도하고 있습니다.
          </div>
        )}
        {authExpired && (
          <div className="status-banner status-banner-auth" role="alert">
            세션이 만료되었습니다. 기존 메시지는 유지됩니다. 다시 로그인해 새 내용을 불러오세요.
            <button type="button" className="ghost-button" onClick={() => void logout()}>
              다시 로그인
            </button>
          </div>
        )}
        {loadError !== null && (
          <div className="inline-state" role="alert">
            <p className="load-error">{loadError} 서버 연결을 확인하고 다시 시도해 주세요.</p>
            <button type="button" className="ghost-button" onClick={() => setLoadAttempt((value) => value + 1)}>
              워크스페이스 다시 불러오기
            </button>
          </div>
        )}
        {view === "approvals" ? (
          <ApprovalsPanel
            approvals={approvals}
            displayNameFor={displayNameFor}
            onClose={() => setView("channel")}
          />
        ) : selectedChannel ? (
          <Timeline
            key={selectedChannel.id.toLowerCase()}
            workspaceId={workspaceId}
            channel={selectedChannel}
            channelLabel={channelLabelFor(selectedChannel)}
            currentMemberId={session.member.id}
            displayNameFor={displayNameFor}
            realtime={realtime}
            approvals={approvals}
            onLatestSeq={readStates.reportViewedSeq}
          />
        ) : (
          loadError === null && loadingWorkspace && (
            <div className="screen-center">
              <p className="muted">채널을 불러오는 중…</p>
            </div>
          )
        )}
      </main>
    </div>
  );
}
