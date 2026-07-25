import type { DiscoveredServer } from "./discovery";

/**
 * Servers advertising themselves on this LAN (`_momo._tcp`). Rendered only when
 * there is something to offer: the caller does not render this component with an
 * empty list, because discovery that found nothing is silence, not a state to
 * report (same contract as the mac chooser).
 *
 * A suggestion, not a decision: picking a row fills the server field, and the
 * person still signs in deliberately.
 */
export function DiscoveredServerList({
  servers,
  onSelect,
}: {
  servers: DiscoveredServer[];
  onSelect: (server: DiscoveredServer) => void;
}) {
  return (
    <section
      className="flex flex-col gap-1 rounded-sm border border-line p-2"
      aria-labelledby="discovered-servers-title"
      data-testid="connect-discovery"
    >
      {/* A label, not a heading: the connect screen has one title, and inventing
          an h2 under it would claim a document structure that is not there. */}
      <p id="discovered-servers-title" className="px-1 text-meta text-ink-muted">
        이 네트워크에서 찾은 서버
      </p>
      <ul className="flex flex-col">
        {servers.map((server) => (
          <li key={server.base}>
            <button
              type="button"
              onClick={() => onSelect(server)}
              data-testid="connect-discovery-item"
              className="flex w-full flex-col items-start gap-0 rounded-sm px-1 py-1 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="w-full truncate text-body text-ink">
                {server.displayHost}
              </span>
              <span className="w-full truncate text-meta text-ink-muted">
                {server.base}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
