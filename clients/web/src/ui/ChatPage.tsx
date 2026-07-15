import { useCallback, useEffect, useMemo, useState } from "react";
import type { Channel, RosterMember } from "../api/client";
import { fetchRoster, listChannels, logout, uuidEq } from "../api/client";
import type { SessionData } from "../auth/session";
import type { RealtimeHandle, RealtimeStatus } from "../realtime/realtime";
import { createRealtime } from "../realtime/realtime";
import ChannelList from "./ChannelList";
import Timeline from "./Timeline";

interface ChatPageProps {
  session: SessionData;
}

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  connecting: "연결 중",
  connected: "실시간 연결됨",
  disconnected: "연결 끊김",
};

export default function ChatPage({ session }: ChatPageProps) {
  const workspaceId = session.member.workspaceId;
  const [channels, setChannels] = useState<Channel[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(null);
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
    let cancelled = false;
    async function loadWorkspace() {
      try {
        const [channelsResponse, rosterResponse] = await Promise.all([
          listChannels(workspaceId),
          fetchRoster(workspaceId),
        ]);
        if (cancelled) return;
        setChannels(channelsResponse.channels);
        setRoster(rosterResponse.members);
        setSelectedChannelId(
          (current) => current ?? channelsResponse.channels[0]?.id ?? null
        );
      } catch {
        if (!cancelled) {
          setLoadError("워크스페이스 정보를 불러오지 못했습니다.");
        }
      }
    }
    void loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

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

  const selectedChannel =
    channels.find((channel) => uuidEq(channel.id, selectedChannelId ?? "")) ??
    null;

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="workspace-name">momo</span>
          <span
            className={`realtime-status realtime-${realtimeStatus}`}
            data-testid="realtime-status"
            data-status={realtimeStatus}
          >
            {STATUS_LABEL[realtimeStatus]}
          </span>
        </header>

        <ChannelList
          channels={channels}
          selectedChannelId={selectedChannelId}
          labelFor={channelLabelFor}
          onSelect={setSelectedChannelId}
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
        {loadError !== null && <p className="load-error">{loadError}</p>}
        {selectedChannel ? (
          <Timeline
            key={selectedChannel.id.toLowerCase()}
            workspaceId={workspaceId}
            channel={selectedChannel}
            channelLabel={channelLabelFor(selectedChannel)}
            displayNameFor={displayNameFor}
            realtime={realtime}
          />
        ) : (
          loadError === null && (
            <div className="screen-center">
              <p className="muted">채널을 불러오는 중…</p>
            </div>
          )
        )}
      </main>
    </div>
  );
}
