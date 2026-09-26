import { useEffect, useState } from "react";
import { IS_TAURI } from "@/lib/env";
import {
  onDiscovery,
  startDiscovery,
  stopDiscovery,
  type DiscoveredServer as ShellServer,
} from "@/lib/tauri";

// =============================================================================
// LAN server discovery on the connect screen (W-O2 client side, web half).
//
// The internal-alpha stack advertises the server over Bonjour as `_momo._tcp`
// with two TXT keys: `base`, the machine's `.local` NAME, and `ipv4`, its LAN
// ADDRESS. This is the decision layer in TS, kept pure so it is testable without
// a network or a shell: validate, dedupe, preserve discovery order, and return
// an EMPTY list for anything doubtful. Empty means the card is not rendered at
// all — discovery is a quiet suggestion, never an announcement, never an error.
//
// The shell (clients/desktop/src-tauri/src/discovery.rs) has already picked
// which of the two this runtime can DIAL — the address first, the name as the
// fallback, because the webview resolves a `.local` name to a link-local IPv6
// address it cannot reach (MOMO-609) — and reports the winner as `baseUrl`. That
// field is the only address authority here. A sighting without a usable one is
// skipped rather than guessed at from host/port, because a wrong scheme would
// hand someone a suggestion that cannot connect, which is worse than silence.
// The shell does not trust the advertisement either — anything on the LAN can
// advertise — so the check below stays, exactly as the mac chooser re-checks its
// own sightings.
//
// Browsers do not get this: there is no mDNS in a web page, so the hook exits
// before it listens and the card never appears.
// =============================================================================

export interface DiscoveredServer {
  /** Validated API base URL to fill into the server field, and to dial. */
  base: string;
  /** Short label naming the machine, e.g. "MacBook-Pro-2.local:28000". */
  displayHost: string;
}

function hostLabel(url: URL): string {
  return url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
}

/** Shell sightings to the servers the connect screen is willing to offer. */
export function discoveredServers(
  records: readonly Partial<ShellServer>[]
): DiscoveredServer[] {
  const seen = new Set<string>();
  const offered: DiscoveredServer[] = [];
  for (const record of records) {
    const raw = (record.baseUrl ?? "").trim();
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
    // The shell's label is preferred when it sent one — it is the Bonjour
    // sighting as advertised — and derived from the validated URL otherwise.
    const label = (record.displayHost ?? "").trim();
    offered.push({ base, displayHost: label === "" ? hostLabel(url) : label });
  }
  return offered;
}

/**
 * How long the shell is asked to keep browsing. Matches the mac chooser's 4s:
 * whatever was found by then stays offered, and a scan that found nothing stops
 * costing radio time while someone types their password.
 */
export const DISCOVERY_BROWSE_MS = 4_000;

export interface DiscoveryState {
  servers: DiscoveredServer[];
  /** mDNS가 이 런타임에 있나. 브라우저 탭에는 없다. */
  available: boolean;
  /** 셸이 아직 찾는 중인가(첫 `DISCOVERY_BROWSE_MS`). */
  searching: boolean;
}

/**
 * Servers seen on this LAN, plus whether the scan is still running.
 *
 * D0(#2808)은 발견 목록이 비었을 때 무엇을 하면 되는지 말한다. 그 문장은 셸이
 * 실제로 찾아본 뒤에만 선다: 찾는 동안「없어요」를 말하면 1초 뒤 줄이 나타날 때
 * 거짓말이 되고, 브라우저에서는 찾아보지도 않았다.
 */
export function useDiscovery(): DiscoveryState {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [searching, setSearching] = useState(IS_TAURI);

  useEffect(() => {
    if (!IS_TAURI) return;

    // Contract (clients/desktop/README.md, "Bridge contract"): SUBSCRIBE FIRST,
    // then start. The shell emits the full current set on every change, so the
    // first event replaces the empty list and each later one replaces the last.
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const settle = window.setTimeout(() => {
      if (!cancelled) setSearching(false);
    }, DISCOVERY_BROWSE_MS);

    onDiscovery(({ servers: found }) => {
      if (!cancelled) setServers(discoveredServers(found));
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      // Listening is fire-and-forget: nothing on the connect screen waits on it,
      // so a shell without the event plugin shows the plain form, not a spinner.
      .catch(() => {})
      // The shell stops itself once the timeout elapses, so this is the whole
      // lifetime of the scan; `startDiscovery` never rejects.
      .finally(() => {
        if (!cancelled) void startDiscovery(DISCOVERY_BROWSE_MS);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(settle);
      unlisten?.();
      void stopDiscovery();
    };
  }, []);

  return { servers, available: IS_TAURI, searching };
}
