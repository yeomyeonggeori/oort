import type { Channel, RosterMember } from "../api/client";
import { uuidEq } from "../api/client";
import type { ReadStateEntry } from "../state/readStates";

interface ChannelListProps {
  /** Non-DM channels (public/private), server order. */
  channels: Channel[];
  /** DM channels from GET /dms (newest-created first, server order). */
  dms: Channel[];
  selectedChannelId: string | null;
  labelFor: (channel: Channel) => string;
  onSelect: (channelId: string) => void;
  /** Server read-state projection; null until known. */
  unreadFor: (channelId: string) => ReadStateEntry | null;
  dmPickerOpen: boolean;
  onToggleDmPicker: () => void;
  /** Roster members a DM can be opened with (self excluded). */
  dmCandidates: RosterMember[];
  onOpenDm: (memberId: string) => void;
}

/**
 * Sidebar: channels + DMs with unread badges (ADR-0109 projection is the
 * authority — badges render exactly what the server computed). The badge is
 * hidden on the selected channel: viewing it is what advances the cursor.
 */
export default function ChannelList({
  channels,
  dms,
  selectedChannelId,
  labelFor,
  onSelect,
  unreadFor,
  dmPickerOpen,
  onToggleDmPicker,
  dmCandidates,
  onOpenDm,
}: ChannelListProps) {
  function renderItems(group: Channel[]) {
    return (
      <ul className="channel-items">
        {group.map((channel) => {
          const selected = uuidEq(channel.id, selectedChannelId ?? "");
          const readState = unreadFor(channel.id);
          const unread = readState?.unreadCount ?? 0;
          const mentions = readState?.mentionCount ?? 0;
          const showBadge = !selected && unread > 0;
          return (
            <li key={channel.id.toLowerCase()}>
              <button
                type="button"
                className={
                  selected ? "channel-item channel-item-selected" : "channel-item"
                }
                data-testid="channel-item"
                data-channel-name={channel.name ?? ""}
                data-channel-id={channel.id.toLowerCase()}
                data-channel-kind={channel.kind}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(channel.id)}
              >
                <span className="channel-item-label">
                  {labelFor(channel)}
                  {channel.muted && (
                    <svg className="muted-icon" viewBox="0 0 16 16" role="img" aria-label="알림 음소거됨">
                      <path d="M3 6.5h2L8 4v8L5 9.5H3zM11 6l3 3m0-3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                {showBadge && (
                  <span
                    className={
                      mentions > 0 ? "unread-badge unread-mention" : "unread-badge"
                    }
                    data-testid="unread-badge"
                    data-channel-name={channel.name ?? ""}
                    data-channel-id={channel.id.toLowerCase()}
                    data-count={unread}
                  >
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <nav className="channel-list" data-testid="channel-list">
      {channels.length > 0 && (
        <section className="channel-group">
          <h2 className="channel-group-title">채널</h2>
          {renderItems(channels)}
        </section>
      )}

      <section className="channel-group">
        <div className="channel-group-head">
          <h2 className="channel-group-title">다이렉트 메시지</h2>
          <button
            type="button"
            className="ghost-button dm-new-button"
            data-testid="dm-new-button"
            aria-expanded={dmPickerOpen}
            onClick={onToggleDmPicker}
          >
            새 대화
          </button>
        </div>
        {dmPickerOpen && (
          <ul className="dm-picker" data-testid="dm-picker">
            {dmCandidates.length === 0 && (
              <li className="muted dm-picker-empty">대화할 멤버가 없습니다.</li>
            )}
            {dmCandidates.map((member) => (
              <li key={member.id.toLowerCase()}>
                <button
                  type="button"
                  className="channel-item dm-candidate"
                  data-testid="dm-candidate"
                  data-member-handle={member.handle}
                  onClick={() => onOpenDm(member.id)}
                >
                  {member.displayName}
                  {member.kind === "agent" && (
                    <span className="muted dm-candidate-kind"> · 에이전트</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {dms.length > 0 ? (
          renderItems(dms)
        ) : (
          <p className="muted channel-empty">아직 대화가 없습니다.</p>
        )}
      </section>

      {channels.length === 0 && dms.length === 0 && (
        <p className="muted channel-empty">참여 중인 채널이 없습니다.</p>
      )}
    </nav>
  );
}
