import { useEffect, useState } from "react";
import { IS_TAURI } from "@/lib/env";
import {
  CMD_MDNS_START,
  CMD_MDNS_STOP,
  MDNS_SERVERS_EVENT,
  invokeTauri,
  listenTauri,
  toMdnsRecords,
  type MdnsServiceRecord,
} from "@/lib/tauri";

// =============================================================================
// LAN server discovery on the connect screen (W-O2 client side, web half).
//
// The internal-alpha stack advertises the server over Bonjour as `_momo._tcp`
// with a TXT record whose `base` key holds the API base URL. The mac chooser
// consumes exactly that (MomoServerDiscovery.swift); this is the same decision
// layer in TS, kept pure so it is testable without a network or a shell:
// validate, dedupe, preserve discovery order, and return an EMPTY list for
// anything doubtful. Empty means the card is not rendered at all — discovery is
// a quiet suggestion, never an announcement, and never an error.
//
// The TXT `base` key is the only address authority. A sighting without it is
// skipped rather than guessed at from host/port, because a wrong scheme would
// hand someone a suggestion that cannot connect, which is worse than silence.
//
// Browsers do not get this: there is no mDNS in a web page, so the hook exits
// before it listens and the card never appears.
// =============================================================================

export interface DiscoveredServer {
  /** Validated API base URL to fill into the server field. */
  base: string;
  /** Short human label, e.g. "macbook.local:28000". */
  displayHost: string;
}

function displayHost(url: URL): string {
  return url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
}

/** Raw sightings to the servers the connect screen is willing to offer. */
export function discoveredServers(
  records: MdnsServiceRecord[]
): DiscoveredServer[] {
  const seen = new Set<string>();
  const offered: DiscoveredServer[] = [];
  for (const record of records) {
    const raw = (record.txt?.base ?? record.base ?? "").trim();
    if (raw === "") continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.hostname === "") continue;
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    if (seen.has(base)) continue;
    seen.add(base);
    offered.push({ base, displayHost: displayHost(url) });
  }
  return offered;
}

/**
 * How long the shell is asked to keep browsing. Matches the mac chooser's 4s:
 * whatever was found by then stays offered, and a scan that found nothing stops
 * costing radio time while someone types their password.
 */
export const DISCOVERY_BROWSE_MS = 4_000;

/**
 * Servers seen on this LAN, or an empty list (browser, no shell support,
 * nothing found, permission denied — all the same silence).
 */
export function useDiscoveredServers(): DiscoveredServer[] {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);

  useEffect(() => {
    if (!IS_TAURI) return;

    const stopBrowsing = () => {
      invokeTauri(CMD_MDNS_STOP).catch(() => {});
    };
    // Best effort: a shell that browses on its own has no such command, and the
    // rejection is not a user-visible condition.
    invokeTauri(CMD_MDNS_START).catch(() => {});

    const unlisten = listenTauri(MDNS_SERVERS_EVENT, (payload) => {
      setServers(discoveredServers(toMdnsRecords(payload)));
    });
    const timer = setTimeout(stopBrowsing, DISCOVERY_BROWSE_MS);

    return () => {
      clearTimeout(timer);
      unlisten();
      stopBrowsing();
    };
  }, []);

  return servers;
}
