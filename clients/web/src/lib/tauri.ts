import { IS_TAURI } from "./env";

// =============================================================================
// The desktop shell bridge (ADR-0133 §2: native integrations live in the Rust
// plugin layer, the React tree only consumes them).
//
// This file is the WEB SIDE of the contract with the Tauri shell work
// (MOMO-603, issue 766), written against the conventional Tauri v2 shapes so the
// two halves meet without a private protocol:
//
//   EVENT  "deep-link://new-url"     payload string[]   (tauri-plugin-deep-link
//          v2 emits the opened URLs as an array; a bare string and
//          `{ urls: [...] }` are accepted too, since a hand-rolled emit is the
//          likely alternative)
//   EVENT  "mdns://servers-changed"  payload MdnsServersPayload — the full
//          current set of `_momo._tcp` sightings, replacing the previous set
//          (same semantics as NWBrowser's browseResultsChangedHandler, which
//          the mac client consumes). Each record carries its TXT map; the
//          `base` key holds the API base URL, exactly as
//          MomoServerDiscovery.txtBaseKey defines it for the mac chooser.
//
//   COMMAND "plugin:deep-link|get_current" -> string[] | null   (cold start:
//           the app was launched BY the link, so no event ever fires)
//   COMMAND "mdns_start" / "mdns_stop"     -> ()                (best effort:
//           if the shell browses on its own, these simply do not exist and the
//           rejection is swallowed; listening alone is enough)
//
// Everything here is failure-tolerant on purpose. A missing command, a shell
// that has not landed yet, or a payload in a shape we did not expect must
// degrade to "no deep link, no discovered servers" — never to a broken connect
// screen, and never to an error in front of the user.
// =============================================================================

export const DEEP_LINK_EVENT = "deep-link://new-url";
export const MDNS_SERVERS_EVENT = "mdns://servers-changed";
export const CMD_DEEP_LINK_CURRENT = "plugin:deep-link|get_current";
export const CMD_MDNS_START = "mdns_start";
export const CMD_MDNS_STOP = "mdns_stop";

/** One `_momo._tcp` sighting as the shell reports it. */
export interface MdnsServiceRecord {
  /** Bonjour instance name. Display fallback only, never an address. */
  name?: string;
  /** Resolved host, e.g. "macbook.local". */
  host?: string;
  port?: number;
  /** TXT record map. `base` holds the advertised API base URL. */
  txt?: Record<string, string>;
  /** Some shells flatten TXT `base` to the top level; both are read. */
  base?: string;
}

/** Array or `{ servers: [...] }`; both are read, neither is required. */
export type MdnsServersPayload =
  | MdnsServiceRecord[]
  | { servers?: MdnsServiceRecord[] };

// ---- normalisers (pure, unit-tested) ----------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Deep-link payload to the URLs it carries. Accepts the plugin's `string[]`, a
 * bare string, and `{ urls: [...] }`; anything else yields nothing.
 */
export function toDeepLinkUrls(payload: unknown): string[] {
  if (typeof payload === "string") return [payload];
  if (Array.isArray(payload)) {
    return payload.filter((entry): entry is string => typeof entry === "string");
  }
  const record = asRecord(payload);
  if (record && Array.isArray(record.urls)) {
    return record.urls.filter(
      (entry): entry is string => typeof entry === "string"
    );
  }
  return [];
}

/** mDNS payload to the sighting list. An unrecognised shape means silence. */
export function toMdnsRecords(payload: unknown): MdnsServiceRecord[] {
  const raw = Array.isArray(payload) ? payload : asRecord(payload)?.servers;
  if (!Array.isArray(raw)) return [];
  const records: MdnsServiceRecord[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const txt = asRecord(record.txt);
    records.push({
      name: typeof record.name === "string" ? record.name : undefined,
      host: typeof record.host === "string" ? record.host : undefined,
      port: typeof record.port === "number" ? record.port : undefined,
      base: typeof record.base === "string" ? record.base : undefined,
      txt: txt
        ? Object.fromEntries(
            Object.entries(txt).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string"
            )
          )
        : undefined,
    });
  }
  return records;
}

// ---- the transport seam -----------------------------------------------------
//
// Tauri v2 exposes `invoke` and `transformCallback` on `__TAURI_INTERNALS__`,
// which is what `@tauri-apps/api` itself calls. Going through the internals
// rather than the npm package keeps this ticket from adding a dependency to the
// same package.json the parallel shell ticket edits; when that package lands,
// these two functions are the only thing that has to change.

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  transformCallback?: (callback: (value: unknown) => void, once?: boolean) => number;
}

function internals(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  const shell = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__;
  return asRecord(shell) as TauriInternals | null;
}

/** Invoke a shell command. Rejects (never throws synchronously) off-shell. */
export async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const api = internals();
  if (!api?.invoke) throw new Error(`tauri command unavailable: ${cmd}`);
  return (await api.invoke(cmd, args ?? {})) as T;
}

export interface TauriEvent<T> {
  event: string;
  payload: T;
}

/**
 * Listen to a shell event. Returns an unsubscribe that is always safe to call,
 * including when the listen never took (browser, or the shell lacks the event
 * plugin). Listening is fire-and-forget: nothing on the connect screen waits on
 * it, so a slow or absent shell shows the plain form instead of a spinner.
 */
export function listenTauri<T>(
  event: string,
  handler: (payload: T) => void
): () => void {
  const api = internals();
  if (!IS_TAURI || !api?.invoke || !api.transformCallback) return () => {};

  let cancelled = false;
  let eventId: number | null = null;

  const unlisten = (id: number) => {
    api.invoke?.("plugin:event|unlisten", { event, eventId: id }).catch(() => {});
  };

  const rid = api.transformCallback((raw) => {
    if (cancelled) return;
    // Tauri delivers `{ event, id, payload }`; a hand-rolled emit may deliver
    // the payload bare. Both reach the handler as the payload.
    const message = asRecord(raw);
    handler((message && "payload" in message ? message.payload : raw) as T);
  });

  api
    .invoke("plugin:event|listen", {
      event,
      target: { kind: "Any" },
      handler: rid,
    })
    .then((id) => {
      if (typeof id !== "number") return;
      eventId = id;
      if (cancelled) unlisten(id);
    })
    .catch(() => {
      // No event plugin in this shell build: the surface stays static, which is
      // the same thing the browser sees.
    });

  return () => {
    cancelled = true;
    if (eventId !== null) unlisten(eventId);
  };
}
