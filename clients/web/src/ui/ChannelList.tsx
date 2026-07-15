import type { Channel } from "../api/client";
import { uuidEq } from "../api/client";

interface ChannelListProps {
  channels: Channel[];
  selectedChannelId: string | null;
  labelFor: (channel: Channel) => string;
  onSelect: (channelId: string) => void;
}

/**
 * Channels grouped like the server orders them (public -> private -> dm).
 * Read surface only for v0; unread badges arrive with the read-state ticket.
 */
export default function ChannelList({
  channels,
  selectedChannelId,
  labelFor,
  onSelect,
}: ChannelListProps) {
  const regular = channels.filter((channel) => channel.kind !== "dm");
  const dms = channels.filter((channel) => channel.kind === "dm");

  function renderGroup(title: string, group: Channel[]) {
    if (group.length === 0) return null;
    return (
      <section className="channel-group">
        <h2 className="channel-group-title">{title}</h2>
        <ul className="channel-items">
          {group.map((channel) => {
            const selected = uuidEq(channel.id, selectedChannelId ?? "");
            return (
              <li key={channel.id.toLowerCase()}>
                <button
                  type="button"
                  className={
                    selected ? "channel-item channel-item-selected" : "channel-item"
                  }
                  data-testid="channel-item"
                  data-channel-name={channel.name ?? ""}
                  data-channel-kind={channel.kind}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(channel.id)}
                >
                  {labelFor(channel)}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <nav className="channel-list" data-testid="channel-list">
      {renderGroup("채널", regular)}
      {renderGroup("다이렉트 메시지", dms)}
      {channels.length === 0 && (
        <p className="muted channel-empty">참여 중인 채널이 없습니다.</p>
      )}
    </nav>
  );
}
