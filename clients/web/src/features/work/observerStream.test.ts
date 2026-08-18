import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ApiError, type WorkSession } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  attachSocketUrl,
  canChangeObservation,
  classifyClose,
  classifyGrantFailure,
  classifyHostFrame,
  connectFrame,
  cspBlockedHost,
  HOST_CONNECT_TIMEOUT_MS,
  isValidPtyId,
  newlineCount,
  observationStillPermits,
  observerCountLabel,
  observerFailureCopy,
  observerLink,
  observerSubprotocols,
  observeGate,
  offersReload,
  offersRetry,
  quietLabel,
  terminalOwnsKey,
  OBSERVER_FAILURE_COPY,
  OBSERVER_LINK_NOTE,
  OBSERVER_LINK_STATUS,
  OBSERVER_SUBPROTOCOL,
  QUIET_AFTER_MS,
  type ObserverFailure,
} from "./observerStream";

/** Comments in this repository quote counter-examples verbatim; strip them. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

const OBSERVER_COMPONENT_CODE = codeOnly(
  readFileSync(new URL("./ObserverTerminal.tsx", import.meta.url), "utf8")
);

const OWNER = "00000000-0000-7000-8000-000000000101";

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "019F9AB9-6DA4-7BE7-9BC9-4A3872D921C3",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: "019F9AB9-6D9D-7A55-8AE8-4BD879349572",
    memberId: OWNER,
    hostId: "019F9AB9-6D96-7761-BB2C-4D1DF7D60A3A",
    rootMessageId: "019F9AB9-6DA4-7BE7-9BC9-4A3872D921C4",
    tool: "claude",
    label: "relay outbox_drain 재시작 루프 조사",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    remoteDisplayAvailable: false,
    startedAtMs: 1785007271329,
    ...over,
  };
}

describe("the observer sends nothing", () => {
  // The D1 contract says the observer grade cannot issue stdin/resize/kill
  // frames AT ALL. On this side that is enforced by absence, so the test that
  // protects it is a test about the source file: adding an encoder is the one
  // change that would silently turn a read-only surface into a writable one.
  it("has no encoder for stdin, resize or kill", () => {
    const source = readFileSync(
      new URL("./observerStream.ts", import.meta.url),
      "utf8"
    );
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toContain("send_stdin");
    expect(code).not.toContain('"resize"');
    expect(code).not.toContain('"kill"');
  });

  it("builds the mac's connect frame byte for byte", () => {
    expect(connectFrame("pty-619-abc")).toBe(
      '{"pty_id":"pty-619-abc","type":"connect"}'
    );
  });

  it("hands the keys that move a reader back to the browser", () => {
    const key = (init: Partial<KeyboardEvent>) =>
      terminalOwnsKey({
        key: "",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        ...init,
      } as KeyboardEvent);
    // WCAG 2.1.2: focus must be able to leave, and Escape must reach the panel.
    expect(key({ key: "Tab" })).toBe(false);
    expect(key({ key: "Escape" })).toBe(false);
    // Copy is the point of a read-only terminal, and Ctrl+C is ^C to xterm.
    expect(key({ key: "c", ctrlKey: true })).toBe(false);
    expect(key({ key: "C", metaKey: true })).toBe(false);
    expect(key({ key: "Insert", ctrlKey: true })).toBe(false);
    // Everything else stays with the terminal: scrolling and selection are its.
    expect(key({ key: "PageUp" })).toBe(true);
    expect(key({ key: "a" })).toBe(true);
    expect(key({ key: "c" })).toBe(true);
    expect(key({ key: "c", ctrlKey: true, altKey: true })).toBe(true);
  });

  it("mirrors the server pty id grammar", () => {
    expect(isValidPtyId("pty-619-abc")).toBe(true);
    expect(isValidPtyId("_leading")).toBe(false);
    expect(isValidPtyId("has space")).toBe(false);
    expect(isValidPtyId("")).toBe(false);
    expect(isValidPtyId(`a${"b".repeat(128)}`)).toBe(false);
  });
});

describe("attachSocketUrl", () => {
  it("promotes https to wss and keeps wss", () => {
    expect(attachSocketUrl("https://host.example/v1/pty")).toBe(
      "wss://host.example/v1/pty"
    );
    expect(attachSocketUrl("wss://host.example:8443/pty")).toBe(
      "wss://host.example:8443/pty"
    );
  });

  it("refuses anything the server would not have stored", () => {
    expect(attachSocketUrl("ws://host.example/pty")).toBeNull();
    expect(attachSocketUrl("http://host.example/pty")).toBeNull();
    expect(attachSocketUrl("wss://user:pw@host.example/pty")).toBeNull();
    expect(attachSocketUrl("wss://host.example/pty?token=x")).toBeNull();
    expect(attachSocketUrl("wss://host.example/pty#frag")).toBeNull();
    expect(attachSocketUrl("not a url")).toBeNull();
  });
});

describe("capability bearer transport", () => {
  it("carries the token as a subprotocol, since a browser has no headers", () => {
    const token = `momo_terminal_attach_v1.${"a".repeat(43)}`;
    expect(observerSubprotocols(token)).toEqual([OBSERVER_SUBPROTOCOL, token]);
  });

  it("keeps the token a legal websocket subprotocol token", () => {
    const token = `momo_terminal_attach_v1.${"aZ0_-".repeat(8)}abc`;
    for (const value of observerSubprotocols(token)) {
      expect(value).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
    }
  });
});

describe("classifyGrantFailure", () => {
  it("separates a refusal from an absence", () => {
    expect(classifyGrantFailure(new ApiError(403, "forbidden"))).toBe(
      "capability_denied"
    );
    expect(classifyGrantFailure(new ApiError(409, "unavailable"))).toBe(
      "session_unavailable"
    );
    expect(classifyGrantFailure(new ApiError(404, "not found"))).toBe(
      "session_unavailable"
    );
    expect(classifyGrantFailure(new NetworkError("timeout", 15_000))).toBe(
      "server_unreachable"
    );
    expect(classifyGrantFailure(new Error("boom"))).toBe("server_unreachable");
  });
});

describe("classifyClose", () => {
  it("never reads a socket that never opened as a dropped stream", () => {
    expect(classifyClose({ opened: false, code: 1006, reason: "" })).toBe(
      "host_unreachable"
    );
    expect(classifyClose({ opened: true, code: 1006, reason: "" })).toBe(
      "stream_dropped"
    );
    expect(classifyClose({ opened: true, code: 1000, reason: "" })).toBe(
      "stream_closed"
    );
  });

  it("keeps the mac's reason vocabulary", () => {
    expect(
      classifyClose({ opened: false, code: 1008, reason: "capability expired" })
    ).toBe("grant_expired");
    expect(
      classifyClose({ opened: true, code: 1008, reason: "host revoked" })
    ).toBe("host_revoked");
    expect(
      classifyClose({ opened: false, code: 1008, reason: "forbidden" })
    ).toBe("capability_denied");
  });
});

describe("failure copy", () => {
  const failures = Object.keys(OBSERVER_FAILURE_COPY) as ObserverFailure[];

  it("says what happened for every failure, with no em-dash and no apology", () => {
    for (const failure of failures) {
      const copy = OBSERVER_FAILURE_COPY[failure];
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toMatch(/[—–]/);
      expect(copy).not.toMatch(/죄송|불편|오류가 발생했습니다\.$/);
    }
  });

  it("names the deadline in the timeout copy, so the number cannot drift", () => {
    expect(OBSERVER_FAILURE_COPY.host_timeout).toContain(
      `${HOST_CONNECT_TIMEOUT_MS / 1000}초`
    );
  });

  it("offers a retry only where retrying can change the answer", () => {
    expect(offersRetry("stream_dropped", true)).toBe(true);
    expect(offersRetry("host_unreachable", true)).toBe(true);
    expect(offersRetry("host_timeout", true)).toBe(true);
    // A clean host close is not an ended session: the ledger can still say
    // running and the pty can still be there, so 다시 연결 is a real question
    // to ask the host (R1 H1: this used to be a banner with no action at all).
    expect(offersRetry("stream_closed", true)).toBe(true);
    // The endpoint and the pty id are the HOST's own registration columns, so a
    // host that fixes them makes the next capability call succeed (R2 M4).
    expect(offersRetry("grant_invalid", true)).toBe(true);
    // The owner closed observation or the session ended: the next step is not
    // a retry, it is a different fact on screen.
    expect(offersRetry("observation_closed", true)).toBe(false);
    expect(offersRetry("session_ended", true)).toBe(false);
    // A policy the page carries is not something a second attempt can change.
    expect(offersRetry("host_blocked_by_policy", true)).toBe(false);
  });

  it("offers the reload where only a new document can change the answer", () => {
    // A CSP arrives with the page. An operator who fixes connect-src changes
    // nothing for a tab that is already open, so this failure alone gets an
    // action that reloads rather than one that redials (R2 M4).
    expect(offersReload("host_blocked_by_policy")).toBe(true);
    for (const failure of failures.filter(
      (name) => name !== "host_blocked_by_policy"
    )) {
      expect(offersReload(failure)).toBe(false);
    }
    // The two never both offer an action: one banner, one next step.
    expect(offersRetry("host_blocked_by_policy", true)).toBe(false);
  });

  it("withdraws the retry when the ledger no longer permits watching", () => {
    // Same failure, both answers: the only difference is whether the session is
    // still running with observation open. A 다시 연결 that can only produce the
    // same error one round trip later is not an action.
    expect(offersRetry("stream_dropped", false)).toBe(false);
    expect(offersRetry("host_timeout", false)).toBe(false);
  });

  it("reports the owner's own close to the owner, with the way back", () => {
    const teammate = observerFailureCopy("observation_closed", false);
    const owner = observerFailureCopy("observation_closed", true);
    expect(teammate).toBe("세션 소유자가 관전을 닫았습니다.");
    expect(owner).not.toBe(teammate);
    expect(owner).toContain("팀원 관전을 허용하면");
    // Everything else reads the same for both sides.
    expect(observerFailureCopy("stream_dropped", true)).toBe(
      OBSERVER_FAILURE_COPY.stream_dropped
    );
  });
});

describe("cspBlockedHost", () => {
  const url = "wss://host.example:28443/v1/observer-terminal";

  it("recognises the page's own policy refusing THIS host", () => {
    // Chrome reports the origin only, and names the directive in
    // `effectiveDirective` (measured 2026-07-26 under the prod header).
    expect(
      cspBlockedHost(
        {
          effectiveDirective: "connect-src",
          violatedDirective: "connect-src",
          blockedURI: "wss://host.example:28443",
        },
        url
      )
    ).toBe(true);
    // Folded schemes: the same refusal reported as https is the same host.
    expect(
      cspBlockedHost(
        {
          effectiveDirective: "connect-src",
          violatedDirective: "connect-src",
          blockedURI: "https://host.example:28443/v1/observer-terminal",
        },
        url
      )
    ).toBe(true);
  });

  it("ignores every other violation the page may raise", () => {
    const other = (over: Partial<SecurityPolicyViolationEvent>) =>
      cspBlockedHost(
        {
          effectiveDirective: "connect-src",
          violatedDirective: "connect-src",
          blockedURI: "wss://host.example:28443",
          ...over,
        },
        url
      );
    expect(other({ blockedURI: "wss://other.example:28443" })).toBe(false);
    expect(other({ blockedURI: "wss://host.example:9443" })).toBe(false);
    expect(
      other({ effectiveDirective: "style-src", violatedDirective: "style-src" })
    ).toBe(false);
    // Chrome uses bare keywords for other directives; they parse as no url.
    expect(other({ blockedURI: "inline" })).toBe(false);
  });
});

describe("newlineCount", () => {
  it("counts LF and never a bare CR", () => {
    expect(newlineCount("a\r\nb\r\n")).toBe(2);
    expect(newlineCount("")).toBe(0);
    // A progress bar redrawing one row is one row, not four hundred lines.
    expect(newlineCount("50%\r60%\r70%\r")).toBe(0);
    expect(newlineCount(new TextEncoder().encode("한 줄\n두 줄\n"))).toBe(2);
  });
});

describe("observeGate", () => {
  it("offers watching for running and idle sessions with a host terminal", () => {
    expect(observeGate(session(), false).available).toBe(true);
    expect(observeGate(session({ status: "idle" }), false).available).toBe(true);
  });

  it("states the reason instead of a dead control", () => {
    expect(observeGate(session({ status: "ended" }), true).reason).toContain(
      "닫힌 세션"
    );
    expect(
      observeGate(session({ remoteAttachAvailable: false }), true).reason
    ).toContain("호스트 터미널");
    expect(
      observeGate(session({ observation: "owner_only" }), false).reason
    ).toBe("세션 소유자가 관전을 닫아 두었습니다.");
  });

  it("tells the owner what to do about their own closed session", () => {
    const gate = observeGate(session({ observation: "owner_only" }), true);
    expect(gate.available).toBe(false);
    expect(gate.reason).toContain("팀원 관전을 허용하면");
  });

  it("reports an ended session as ended even when it has a terminal binding", () => {
    const gate = observeGate(
      session({ status: "ended", observation: "owner_only" }),
      true
    );
    expect(gate.reason).toContain("닫힌 세션");
  });
});

describe("observation scope control", () => {
  it("belongs to the owner while a running or idle session keeps its PTY", () => {
    expect(canChangeObservation(session(), OWNER)).toBe(true);
    expect(canChangeObservation(session({ status: "idle" }), OWNER)).toBe(true);
    // Ids cross the wire in mixed case (uuidEq), so this must fold.
    expect(canChangeObservation(session(), OWNER.toUpperCase())).toBe(true);
    expect(canChangeObservation(session(), "00000000-0000-7000-8000-000000000102")).toBe(
      false
    );
    expect(canChangeObservation(session({ status: "ended" }), OWNER)).toBe(false);
  });
});

describe("observationStillPermits", () => {
  it("drops a live socket the ledger no longer allows", () => {
    expect(observationStillPermits(session())).toBeNull();
    expect(observationStillPermits(session({ status: "idle" }))).toBeNull();
    expect(observationStillPermits(session({ status: "ended" }))).toBe(
      "session_ended"
    );
    expect(observationStillPermits(session({ status: "orphaned" }))).toBe(
      "session_ended"
    );
    expect(
      observationStillPermits(session({ observation: "owner_only" }))
    ).toBe("observation_closed");
  });
});

describe("observerCountLabel", () => {
  it("carries its unit, because the number is not a headcount", () => {
    // The mac says 관전 N. Here the qualifier used to be a two line note under
    // the badge, which was a third of the fixed prose in a 320px column (R2
    // M5/M7). The word that made the note necessary is now in the label.
    expect(observerCountLabel(3)).toBe("관전 권한 3");
  });
});

describe("observerLink", () => {
  const base = { watching: true, online: true, quietMs: 0, doubted: false };

  it("claims nothing at all unless the socket is open", () => {
    expect(observerLink({ ...base, watching: false })).toBeNull();
    // Not even when everything else looks healthy.
    expect(
      observerLink({ watching: false, online: true, quietMs: 0, doubted: false })
    ).toBeNull();
  });

  it("stops claiming 관전 중 the moment the browser loses the network", () => {
    // R2 H1: with the network cut under a live stream no close event ever
    // arrived, so an OPEN socket alone kept 관전 중 frozen on screen while the
    // panel above it said the connection had dropped.
    expect(observerLink({ ...base, online: false })).toBe("offline");
    // Even mid-burst: onLine false means no socket on this page is going
    // anywhere, and under-claiming is the safe direction on this surface.
    expect(observerLink({ ...base, online: false, quietMs: 0 })).toBe("offline");
  });

  it("holds the doubt until a byte settles it", () => {
    expect(observerLink({ ...base, doubted: true })).toBe("unverified");
    // A byte arriving is what clears `doubted` (ObserverTerminal.markByte), so
    // the state cannot outlive the evidence against it.
    expect(observerLink({ ...base, doubted: false })).toBe("live");
  });

  it("names silence as silence, never as death", () => {
    expect(observerLink({ ...base, quietMs: QUIET_AFTER_MS - 1 })).toBe("live");
    expect(observerLink({ ...base, quietMs: QUIET_AFTER_MS })).toBe("quiet");
    // An idle agent is still being watched: the word does not change, only the
    // clause beside it does.
    expect(OBSERVER_LINK_STATUS.quiet).toBe(OBSERVER_LINK_STATUS.live);
    expect(OBSERVER_LINK_STATUS.live).toBe("관전 중");
    expect(OBSERVER_LINK_STATUS.offline).not.toBe(OBSERVER_LINK_STATUS.live);
    expect(OBSERVER_LINK_STATUS.unverified).not.toBe(OBSERVER_LINK_STATUS.live);
  });

  it("ranks the outage above the doubt above the silence", () => {
    expect(
      observerLink({ watching: true, online: false, quietMs: 60_000, doubted: true })
    ).toBe("offline");
    expect(
      observerLink({ watching: true, online: true, quietMs: 60_000, doubted: true })
    ).toBe("unverified");
  });
});

describe("quietLabel", () => {
  it("says nothing while output is arriving", () => {
    expect(quietLabel(0, true)).toBeNull();
    expect(quietLabel(QUIET_AFTER_MS - 1, true)).toBeNull();
  });

  it("distinguishes a stream that paused from one that never started", () => {
    expect(quietLabel(12_000, true)).toBe("마지막 출력 12초 전");
    // Nothing has arrived on this attempt, so there is no "마지막 출력" to date.
    expect(quietLabel(12_000, false)).toBe("12초째 출력 없음");
  });

  it("switches to minutes rather than counting to hundreds", () => {
    expect(quietLabel(59_000, true)).toBe("마지막 출력 59초 전");
    expect(quietLabel(60_000, true)).toBe("마지막 출력 1분 전");
    expect(quietLabel(605_000, false)).toBe("10분째 출력 없음");
  });
});

describe("link notes", () => {
  it("states the fact and the next step, with no em-dash and no blame", () => {
    for (const note of Object.values(OBSERVER_LINK_NOTE)) {
      expect(note).not.toMatch(/[—–]/);
      expect(note).not.toMatch(/죄송|불편|확인해 주세요/);
    }
    // Offline: nothing this client can do until the network returns, so it says
    // what becomes possible then rather than pointing at a dead control.
    expect(OBSERVER_LINK_NOTE.offline).toContain("다시 연결할 수 있습니다");
    // Unverified: the honest claim is that nobody knows yet.
    expect(OBSERVER_LINK_NOTE.unverified).toContain("다음 출력이 도착해야");
  });
});

describe("host frames", () => {
  // Byte for byte what the daemon encodes (PTYReplayEndFrame /
  // PTYReplayOverflowFrame, JSONEncoder with .sortedKeys).
  const REPLAY_END = '{"byte_offset":8317,"type":"replay_end"}';
  const REPLAY_OVERFLOW = '{"byte_offset":99,"type":"replay_overflow"}';

  it("recognizes the two markers the host sends as text frames", () => {
    expect(classifyHostFrame(REPLAY_END)).toEqual({
      kind: "replay_end",
      byteOffset: 8317,
    });
    expect(classifyHostFrame(REPLAY_OVERFLOW)).toEqual({
      kind: "replay_overflow",
      byteOffset: 99,
    });
  });

  it("treats everything else as output, including JSON a program printed", () => {
    // The failure this guards: a marker written into xterm shows the reader
    // JSON at the exact moment the panel should look like it caught up. The
    // mirror failure is worse, so the bar for claiming "marker" is the exact
    // shape and nothing looser.
    for (const text of [
      "npm ERR! code E404\r\n",
      '{"type":"replay_end"}', // no offset: not the frame this client knows
      '{"byte_offset":"8317","type":"replay_end"}',
      '{"byte_offset":1,"type":"replay_start"}',
      '{"ok":true}',
      "{ not json",
      "",
      // A program printing the marker's own text is still program output: it
      // arrived as terminal bytes, not as a control frame, and this classifier
      // only ever sees text frames.
      `$ echo '${REPLAY_END}'\r\n`,
    ]) {
      expect(classifyHostFrame(text)).toEqual({ kind: "output" });
    }
  });

  it("is refused by the panel before xterm ever sees it", () => {
    // Guard rope: the write path must consult the classifier. A future edit that
    // drops the check restores the JSON-in-scrollback bug silently otherwise.
    const source = readFileSync(
      new URL("./ObserverTerminal.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toContain("classifyHostFrame(data)");
    expect(source).toMatch(/if \(frame\.kind !== "output"\) return;/);
  });
});

// -----------------------------------------------------------------------------
// every way out of 연결 중 is a way out
// -----------------------------------------------------------------------------

/** The body of a `const NAME = useCallback(...)` in the component source. */
function callbackBody(name: string): string {
  const opening = `const ${name} = useCallback(`;
  const start = OBSERVER_COMPONENT_CODE.indexOf(opening);
  expect(start, name).toBeGreaterThan(-1);
  const end = OBSERVER_COMPONENT_CODE.indexOf("\n  }, [", start);
  expect(end, name).toBeGreaterThan(start);
  return OBSERVER_COMPONENT_CODE.slice(start, end);
}

describe("the connecting leg is released on every exit, not just the socket's", () => {
  // The measured hole this locks, and the twin of the one DisplayObserver
  // already closed (LIVE-2 M1). `connecting` hangs a `securitypolicyviolation`
  // listener on the DOCUMENT, which is a node that outlives this component, and
  // `closeSocket` deletes `onopen`/`onclose` BEFORE it closes the socket so that
  // a handler cannot report a failure the reader has already left behind. Every
  // exit that is not the socket settling — the handshake deadline giving up,
  // 관전 중단, the ledger revoking mid-handshake, a different session.id arriving
  // in the same mounted panel, a retry that closes the previous attempt —
  // therefore fires nothing on the socket at all. A cleanup reachable only from
  // those two handlers is a cleanup all of those exits skip, and the listener
  // then survives for the life of the tab, one more per retry and per session
  // switch.
  //
  // `gates/gate-work-console.mjs` counts the surviving listeners in a real
  // browser on the real bundle; these assertions hold the shape that makes the
  // count zero.
  it("hangs exactly one document listener, for the one event a socket cannot raise", () => {
    expect(
      OBSERVER_COMPONENT_CODE.match(/document\.addEventListener\(/g)
    ).toHaveLength(1);
    expect(OBSERVER_COMPONENT_CODE).toMatch(
      /document\.addEventListener\("securitypolicyviolation"/
    );
    expect(
      OBSERVER_COMPONENT_CODE.match(/document\.removeEventListener\(/g)
    ).toHaveLength(1);
  });

  it("hands that listener's removal to closeSocket rather than to the socket", () => {
    // Registration and drain are the two halves. Without the second one the
    // component still compiles, still passes every state assertion above, and
    // still leaks.
    expect(OBSERVER_COMPONENT_CODE).toMatch(/connectCleanupRef\.current = done/);
    const closeSocket = callbackBody("closeSocket");
    expect(closeSocket).toMatch(/connectCleanupRef\.current = null/);
    expect(closeSocket).toMatch(/connectCleanup\?\.\(\)/);
    // Released before the early return that a null socket takes: an attempt
    // whose socket is already gone still has a listener on the document.
    expect(closeSocket.indexOf("connectCleanup?.()")).toBeLessThan(
      closeSocket.indexOf("if (!socket) return;")
    );
    // ...and before the socket handlers are deleted: after that line there is
    // nothing left that could have run it.
    expect(closeSocket.indexOf("connectCleanup?.()")).toBeLessThan(
      closeSocket.indexOf("socket.onopen = null")
    );
  });

  it("leaves no exit that closes the socket around closeSocket", () => {
    // The unmount cleanup used to close the socket by hand, which made it the
    // one exit whose listener release depended on `onclose` arriving after the
    // component was already gone. Every door now goes through the same one.
    expect(OBSERVER_COMPONENT_CODE).not.toMatch(/socket\?\.close\(\)/);
  });

  it("clears the handshake deadline in exactly one place", () => {
    // `give` closes the socket and closeSocket runs the cleanup, so the deadline
    // has a single owner. Two owners is how the first one drifted out of date.
    expect(
      OBSERVER_COMPONENT_CODE.match(/window\.clearTimeout\(deadline\)/g)
    ).toHaveLength(1);
  });
});
