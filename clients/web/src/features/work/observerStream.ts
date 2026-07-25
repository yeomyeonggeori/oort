import { ApiError, uuidEq, type WorkSession } from "@/lib/api";
import { NetworkError } from "@/lib/http";

// =============================================================================
// Read-only terminal observation (AX-3 / MOMO-619, ADR-0126 D1).
//
// THE INVARIANT THIS FILE EXISTS TO HOLD: an observer sends nothing.
//
// D1 grants an `observer` capability that carries stdout only, and it says the
// restriction is "각인" at the capability grade rather than a UI state. On the
// mac that is `MomoRemoteTerminalSession.sendInput`, which returns early unless
// `mode == .controller`. Here it is stronger and simpler: there is no encoder
// for `send_stdin`, `resize` or `kill` anywhere in this client. `connectFrame`
// below is the ONLY frame this codebase can build, so "the observer cannot send
// a keystroke" is not a guard someone can delete by accident, it is an absence.
// If a controller mode is ever added to the web, it belongs in a different
// module with its own review, not in a boolean flag added here.
//
// The stream itself never touches a momo server: the capability call hands back
// the HOST's own endpoint and the socket is dialled straight at it
// (TerminalAttachRoutes: "There is intentionally no stream, websocket, stdin,
// stdout, resize, or relay route in this server"). Everything below is either a
// pure function over that contract or the copy that states its outcome.
// =============================================================================

/**
 * The one frame an observer sends: the mac's `MomoTerminalAttachFrame.connect`,
 * byte for byte (`JSONSerialization` with `.sortedKeys` puts `pty_id` first).
 * A host that already speaks to the mac client needs no second dialect.
 */
export function connectFrame(ptyId: string): string {
  return JSON.stringify({ pty_id: ptyId, type: "connect" });
}

/**
 * Which keys the TERMINAL is allowed to have, for xterm's
 * `attachCustomKeyEventHandler` (it takes "should xterm process this", so a
 * `false` hands the key back to the browser untouched).
 *
 * This lives beside the connect frame because it is the same invariant seen
 * from the reader's side. xterm cancels the browser default for every key it
 * maps, and `disableStdin` does not change that: it drops the byte in
 * CoreService long after `preventDefault()` has already run. MOMO-619 R1
 * measured the result on the live build: once focus reached
 * `.xterm-helper-textarea` there was no way out, with six Tabs, Escape and
 * Shift+Tab all leaving `document.activeElement` on that textarea. 관전 중단,
 * the scope toggle and the panel's own Escape handler were unreachable without
 * a mouse, which is WCAG 2.1.2 and, on a surface with nothing listening for
 * those keys, keystrokes eaten on behalf of nobody.
 *
 * So the keys that MOVE a reader belong to the browser, and so do the copy
 * chords: Ctrl+C is `\x03` to xterm, which cancels the browser's own copy on
 * Linux and Windows in exchange for an interrupt this grade cannot send. What
 * xterm keeps is what it can honestly act on: PageUp/PageDown/Home/End scroll
 * its viewport, and printable keys land nowhere, exactly as before.
 */
export function terminalOwnsKey(event: KeyboardEvent): boolean {
  if (event.key === "Tab" || event.key === "Escape") return false;
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "c" || key === "insert") return false;
  }
  return true;
}

/** Host-side id grammar, mirrored from `RemotePTYBinding.validated`. */
export function isValidPtyId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

/**
 * WebSocket subprotocol carrying the capability bearer.
 *
 * The mac transport sends `Authorization: Bearer <capability>` on the upgrade
 * request. A browser cannot: the WebSocket API takes a url and a subprotocol
 * list and nothing else, and there is no header hook in any engine. The two
 * ways to get a bearer through a browser handshake are the subprotocol list and
 * a query parameter; the query parameter is worse in a specific way (it lands
 * in proxy and host access logs as part of the request line, and the server
 * deliberately rejects any stored endpoint that carries a query at all), so
 * this client uses the subprotocol.
 *
 * The token's own grammar makes it legal there: `momo_terminal_attach_v1.` plus
 * 43 base64url characters is an RFC 6455 token with no separator characters. It
 * is still a credential in a handshake header, with the same 60 second TTL and
 * the same single-host audience as the mac's Authorization header.
 *
 * A HOST IMPLEMENTATION DOES NOT EXIST IN THIS REPO YET (the server calls the
 * workd/provisioner PTY adapter a follow-up), so this is the web half of a
 * contract that still has to be agreed on the host side: a host must accept the
 * bearer from EITHER the Authorization header (mac/iOS) or this subprotocol
 * (browser/Tauri), then validate it through
 * POST /v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate exactly
 * as today. Nothing else about D10 changes.
 */
export const OBSERVER_SUBPROTOCOL = "momo.terminal.v1";

export function observerSubprotocols(capabilityToken: string): string[] {
  return [OBSERVER_SUBPROTOCOL, capabilityToken];
}

/**
 * The socket url for a grant, or null when the grant is not one we will dial.
 *
 * The server already validates what it stores (https/wss, a host, no
 * credentials, no query, no fragment). This re-checks the same shape on the way
 * out for the same reason the mac client does: the value crosses a trust
 * boundary (host-authored, server-stored) before a socket is opened with it.
 */
export function attachSocketUrl(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== "wss:" && scheme !== "https:") return null;
  if (url.hostname === "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  url.protocol = "wss:";
  return url.toString();
}

// ---- failures ---------------------------------------------------------------

/**
 * Every way watching can fail, kept apart because each one has a different next
 * step. Collapsing them into "터미널을 열지 못했습니다" would tell the reader to
 * retry a permission problem and to check their network for an ended session.
 */
export type ObserverFailure =
  /** The server refused the capability (403): closed session or no membership. */
  | "capability_denied"
  /** The server cannot issue one (404/409): not running, host revoked, no PTY. */
  | "session_unavailable"
  /** The grant body is not an endpoint/pty this client will dial. */
  | "grant_invalid"
  /** The capability call itself never reached the server. */
  | "server_unreachable"
  /** The socket never opened: the host address refused or could not be reached. */
  | "host_unreachable"
  /** The page's own Content-Security-Policy refused the connection. */
  | "host_blocked_by_policy"
  /** The socket was still connecting when the deadline blew. */
  | "host_timeout"
  /** The host rejected the bearer as expired. */
  | "grant_expired"
  /** The host says the session ended or the host registration was revoked. */
  | "host_revoked"
  /** The stream was open and then dropped. */
  | "stream_dropped"
  /** The host closed the stream cleanly. */
  | "stream_closed"
  /** The owner switched this session to owner-only while we were watching. */
  | "observation_closed"
  /** The ledger says the session ended while we were watching. */
  | "session_ended";

/**
 * Deadline on the socket handshake, the same 15 seconds every REST call in this
 * client gets (`http.ts` REQUEST_TIMEOUT_MS) and the same value the mac
 * transport puts on its attach request.
 *
 * A WebSocket has no timeout of its own, which is the MOMO-609 bug one protocol
 * over: a browser that cannot reach the host sits in CONNECTING until the OS
 * gives up (75 seconds on macOS for a dropped SYN), and a socket the page's own
 * CSP refuses reports NOTHING at all on the socket itself. Measured on
 * 2026-07-26 against the production connect-src (`'self'` plus the realtime
 * domain, which does not cover a host endpoint): the console logged the
 * refusal, the constructor threw nothing, no error or close event ever arrived,
 * and the panel sat on "호스트에 연결하는 중" indefinitely. A busy state with no
 * end is the same lie as a false live state, so the deadline is not optional.
 *
 * The deadline is the FLOOR, not the answer. A blocked connection does raise a
 * `securitypolicyviolation` event on the document (`cspBlockedHost` below), and
 * waiting 15 seconds to say "the host did not answer" when the browser already
 * said "I refused to ask" is an accurate sentence about the wrong thing.
 */
export const HOST_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Whether a `securitypolicyviolation` is THIS socket being refused by the page's
 * own connect-src, rather than any other blocked request on the page.
 *
 * Measured in Chrome 2026-07-26 serving the built bundle behind the production
 * header (`connect-src 'self' wss://REALTIME https://REALTIME`): dialling
 * `wss://127.0.0.1:28443/v1/observer-terminal` fired one event carrying
 * `effectiveDirective: "connect-src"` and that whole url as `blockedURI`,
 * 38 to 51 ms after 관전 시작 (against the 15 second deadline it replaces). Other
 * engines report the ORIGIN only, so the comparison is scheme plus host and
 * never the path; a blockedURI that is not a url at all (Chrome uses bare
 * keywords such as "inline" for other directives) can match nothing.
 */
export function cspBlockedHost(
  violation: Pick<
    SecurityPolicyViolationEvent,
    "effectiveDirective" | "violatedDirective" | "blockedURI"
  >,
  socketUrl: string
): boolean {
  const directive = violation.effectiveDirective || violation.violatedDirective;
  if (!directive.startsWith("connect-src")) return false;
  let blocked: URL;
  let target: URL;
  try {
    blocked = new URL(violation.blockedURI);
    target = new URL(socketUrl);
  } catch {
    return false;
  }
  // Scheme is compared as ws/wss vs http/https folded onto each other: Chrome
  // reports the blocked origin with the scheme it was dialled with, but a proxy
  // or a future engine reporting `https:` for the same host is the same refusal.
  const fold = (value: string) =>
    value === "wss:" ? "https:" : value === "ws:" ? "http:" : value;
  return fold(blocked.protocol) === fold(target.protocol) && blocked.host === target.host;
}

/**
 * What happened, then what to do next (design-taste-web §5). No apology, no
 * "잠시 후 다시 시도" filler, and no sentence that blames the reader.
 */
export const OBSERVER_FAILURE_COPY: Readonly<Record<ObserverFailure, string>> = {
  capability_denied:
    "이 세션의 터미널을 관전할 권한이 없습니다. 세션 소유자가 관전을 닫았거나 이 채널의 멤버가 아닙니다.",
  session_unavailable:
    "지금은 관전할 수 없습니다. 세션이 끝났거나 호스트 연결이 해제됐습니다.",
  grant_invalid:
    "호스트 주소를 확인하지 못했습니다. 세션을 시작한 호스트의 등록 정보를 확인하세요.",
  server_unreachable:
    "서버에 관전 권한을 요청하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.",
  host_unreachable:
    "호스트에 닿지 못했습니다. 출력은 서버를 거치지 않고 호스트에서 직접 오므로, 이 브라우저가 호스트 주소에 닿을 수 있어야 합니다.",
  host_blocked_by_policy:
    "이 페이지의 보안 정책이 호스트 주소로의 연결을 막았습니다. 데스크톱 앱에서는 그대로 관전할 수 있고, 브라우저에서 열려면 이 웹을 서빙하는 서버가 호스트 주소를 허용해야 합니다.",
  host_timeout: `호스트가 ${Math.round(
    HOST_CONNECT_TIMEOUT_MS / 1000
  )}초 안에 응답하지 않았습니다. 호스트 주소와 네트워크를 확인한 뒤 다시 연결하세요.`,
  grant_expired: "연결 권한이 만료됐습니다. 다시 연결하세요.",
  host_revoked:
    "세션이 종료됐거나 호스트 연결이 해제됐습니다. 상태를 확인한 뒤 다시 연결하세요.",
  stream_dropped: "출력 스트림이 끊겼습니다. 다시 연결하세요.",
  stream_closed: "호스트가 출력 스트림을 닫았습니다.",
  observation_closed: "세션 소유자가 관전을 닫았습니다.",
  session_ended: "세션이 끝나 출력 스트림이 닫혔습니다.",
};

/**
 * The owner's own view of a failure they caused.
 *
 * `observation_closed` is written in the third person because that is what it
 * is for a teammate whose stream just went dark. Shown to the OWNER, one click
 * after they pressed 소유자만 보기, the same sentence reports their own action
 * back to them as someone else's and never says what to do next (§5). The gate
 * already carries the owner's version of this fact; the banner path needs its
 * own because a banner is what the reader is looking at.
 */
export function observerFailureCopy(
  failure: ObserverFailure,
  isOwner: boolean
): string {
  if (isOwner && failure === "observation_closed") {
    return "관전을 소유자만 보기로 닫았습니다. 팀원 관전을 허용하면 이 자리에서 다시 볼 수 있습니다.";
  }
  return OBSERVER_FAILURE_COPY[failure];
}

/**
 * Failures a retry can plausibly fix. The rest offer no retry control.
 *
 * `stream_closed` is in here, unlike its first shape. A host that closes the
 * stream cleanly (code 1000) has not ended the SESSION: the ledger can still say
 * running, the pty can still be there, and MOMO-619 R1 measured exactly that
 * dead end (a clean host close left a banner with no action and no 관전 시작,
 * with nothing on the panel able to get the stream back). Whether the retry can
 * succeed is the host's answer to give, and asking it costs one capability call.
 */
const RETRYABLE: ReadonlySet<ObserverFailure> = new Set<ObserverFailure>([
  "server_unreachable",
  "host_unreachable",
  "host_timeout",
  "grant_expired",
  "stream_dropped",
  "stream_closed",
  "capability_denied",
  "session_unavailable",
  "host_revoked",
]);

/**
 * Whether the failed state offers 다시 연결, which is TWO questions and not one.
 *
 * `gateAvailable` is the second, and it is why this takes an argument at all. A
 * retry control on a session the ledger has already ended, or whose owner has
 * already closed observation, is a button whose only possible outcome is the
 * same error one round trip later; `isRetryable` alone cannot see either fact.
 * When the gate is shut the panel states the reason instead (observeGate), and
 * when the gate REOPENS the component drops the stale failure entirely rather
 * than leaving a banner arguing with the controls beside it.
 */
export function offersRetry(
  failure: ObserverFailure,
  gateAvailable: boolean
): boolean {
  return gateAvailable && RETRYABLE.has(failure);
}

/** Why the capability call failed. Status codes are the server's own contract. */
export function classifyGrantFailure(error: unknown): ObserverFailure {
  if (error instanceof NetworkError) return "server_unreachable";
  if (error instanceof ApiError) {
    if (error.status === 403) return "capability_denied";
    if (error.status === 404 || error.status === 409) {
      return "session_unavailable";
    }
    if (error.status === 401) return "capability_denied";
  }
  return "server_unreachable";
}

/**
 * Why the socket ended. `opened` is the fact that separates "we never got
 * there" from "we were watching and lost it", and no close code can substitute
 * for it: a browser reports a refused TLS handshake, a blocked connect-src and
 * an unroutable address as the same anonymous 1006.
 *
 * The reason string is the mac's classifier (`MomoURLSessionRemoteTerminalTransport.classify`
 * reads `closeReason` for expired/revoked), extended with the ordinary clean
 * close a browser can see and the mac's URLSession stream cannot report.
 */
export function classifyClose(input: {
  opened: boolean;
  code: number;
  reason: string;
}): ObserverFailure {
  const reason = input.reason.toLowerCase();
  if (reason.includes("expired")) return "grant_expired";
  if (reason.includes("revoked") || reason.includes("ended")) {
    return "host_revoked";
  }
  if (reason.includes("forbidden") || reason.includes("unauthorized")) {
    return "capability_denied";
  }
  if (!input.opened) return "host_unreachable";
  return input.code === 1000 ? "stream_closed" : "stream_dropped";
}

// ---- what arrived, and how wide the window on it is -------------------------

/**
 * Lines in a chunk, counted so the surface can say how much output it holds and
 * how far behind a scrolled-back reader is.
 *
 * It counts LF and nothing else. A pty writes CRLF, a bare CR is a progress bar
 * redrawing the same row, and counting CR as a line would report a 3 second
 * spinner as four hundred lines of output.
 */
export function newlineCount(chunk: string | Uint8Array): number {
  let count = 0;
  if (typeof chunk === "string") {
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk.charCodeAt(i) === 10) count += 1;
    }
    return count;
  }
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk[i] === 10) count += 1;
  }
  return count;
}

/**
 * The width host output is written for.
 *
 * 80 is not a preference, it is what the other side is doing: a pty created
 * without a size gets 80 columns, and this client sends no resize frame by
 * design (the observer grade has no encoder for one), so the host keeps writing
 * at its own width no matter how narrow this viewport is. Below this the
 * terminal is not showing the output, it is folding it, and MOMO-619 R1
 * measured what that costs: 37 columns inside the 320px pane at a 1280px
 * window, where a single pytest invocation wrapped onto two rows and an 79
 * character ruler onto three.
 */
export const HOST_COLUMNS = 80;

// ---- who may watch, who may change the scope --------------------------------

export interface ObserveGate {
  available: boolean;
  /** Why not, in words. Null when watching is available. */
  reason: string | null;
}

/**
 * Whether this session offers a terminal to watch AT ALL, before any permission
 * question the server will answer for itself.
 *
 * This is not an access check and must not read as one: the server decides, and
 * a 403 comes back as `capability_denied`. It only keeps the panel from
 * offering a control that cannot work, and states the reason instead, which is
 * the same rule 세션 종료 follows one block down (`SessionActions`).
 */
export function observeGate(
  session: Pick<WorkSession, "status" | "observation" | "remoteAttachAvailable">,
  isOwner: boolean
): ObserveGate {
  if (session.status !== "running") {
    return {
      available: false,
      reason: "끝난 세션은 관전할 수 없습니다. 진행 내역은 아래에 남아 있습니다.",
    };
  }
  if (!session.remoteAttachAvailable) {
    return {
      available: false,
      reason:
        "이 세션은 호스트 터미널을 열어 두지 않았습니다. 호스트가 터미널을 연 세션만 관전할 수 있습니다.",
    };
  }
  if (session.observation === "owner_only") {
    return {
      available: false,
      reason: isOwner
        ? "관전을 소유자만 보기로 닫아 두었습니다. 팀원 관전을 허용하면 이 자리에서 출력을 볼 수 있습니다."
        : "세션 소유자가 관전을 닫아 두었습니다.",
    };
  }
  return { available: true, reason: null };
}

/** The scope toggle is the OWNER's control, and only while the session runs. */
export function canChangeObservation(
  session: Pick<WorkSession, "status" | "memberId">,
  viewerMemberId: string
): boolean {
  return session.status === "running" && uuidEq(session.memberId, viewerMemberId);
}

/**
 * A watcher that is still allowed to be watching.
 *
 * The mac holds this rule in `reconcileObserverAccess` / `upsert`: a session
 * that stops running, or whose owner closes observation, drops every observer
 * socket it is holding. The same rule has to run here, because the server
 * revokes the CAPABILITY (it deletes the observer rows) but the socket already
 * dialled is between the browser and the host, and nothing on the momo side can
 * reach in and close it. Leaving it open would keep bytes flowing into a panel
 * whose own ledger says nobody is allowed to see them.
 */
export function observationStillPermits(
  session: Pick<WorkSession, "status" | "observation">
): ObserverFailure | null {
  if (session.status !== "running") return "session_ended";
  if (session.observation !== "open") return "observation_closed";
  return null;
}

// ---- the badge --------------------------------------------------------------

/**
 * "관전 N", the mac's own wording (`workSessionObservers`).
 *
 * WHAT THE NUMBER IS, EXACTLY: the server counts observer capability rows that
 * have not expired (`terminal_attach_capability.mode = 'observer' AND
 * expires_at > clock_timestamp()`), and a capability lives 60 seconds. So it is
 * "관전 권한이 최근 1분 안에 발급된 횟수", not "지금 보고 있는 사람 수": a
 * teammate who has been watching for ten minutes is NOT in it, and one who
 * retried twice in a minute is in it twice.
 *
 * That gap is why `observerNote` exists and is rendered next to the number
 * rather than in a tooltip. The alternative was to re-issue a capability every
 * 30 seconds so the count would track live watchers, which would mint tokens
 * and publish a realtime frame per observer per minute in order to make a badge
 * literal, and would still count a mac observer wrong. The number is the
 * server's, and the sentence says what the server counted.
 */
export function observerCountLabel(count: number): string {
  return `관전 ${count}`;
}

export const OBSERVER_COUNT_NOTE =
  "최근 1분 안에 발급된 관전 권한 수입니다. 계속 보고 있는 사람 수와는 다릅니다.";
