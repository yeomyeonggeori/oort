import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FUNNEL_TURN_TLS_PORT,
  installHuddleTurnRewriteShim,
  rewriteIceServers,
  rewriteTurnsUrl,
  signalHostFromLivekitUrl,
} from "./huddleTurnRewrite";

const SIGNAL_HOST = "momo.tail123.ts.net";
const FUNNEL_SIGNAL = `wss://${SIGNAL_HOST}:10000`;
const FUNNEL_TURNS_443 = `turns:${SIGNAL_HOST}:443?transport=tcp`;
const FUNNEL_TURNS_8443 = `turns:${SIGNAL_HOST}:${FUNNEL_TURN_TLS_PORT}?transport=tcp`;

const USERNAME = "test-turn-user";
const CREDENTIAL = "test-turn-credential";

class FakePeerConnection {
  configuration: RTCConfiguration | undefined;
  constructor(configuration?: RTCConfiguration) {
    this.configuration = configuration;
  }
  setConfiguration(configuration?: RTCConfiguration): void {
    this.configuration = configuration;
  }
}

const originalPeerConnection = globalThis.RTCPeerConnection;

afterEach(() => {
  globalThis.RTCPeerConnection = originalPeerConnection;
});

describe("signal host parsing", () => {
  it("reads the wss host from a Funnel livekitUrl", () => {
    expect(signalHostFromLivekitUrl(FUNNEL_SIGNAL)).toBe(SIGNAL_HOST);
  });

  it("reads a LiveKit Cloud signal host", () => {
    expect(signalHostFromLivekitUrl("wss://proj.livekit.cloud")).toBe(
      "proj.livekit.cloud"
    );
  });

  it("reads a direct local signal host", () => {
    expect(signalHostFromLivekitUrl("ws://127.0.0.1:7880")).toBe("127.0.0.1");
  });

  it("returns null for a non-URL", () => {
    expect(signalHostFromLivekitUrl("not-a-url")).toBeNull();
  });
});

describe("turns URL rewrite", () => {
  it("rewrites same-host turns:443 and keeps the query", () => {
    expect(rewriteTurnsUrl(FUNNEL_TURNS_443, SIGNAL_HOST)).toBe(
      FUNNEL_TURNS_8443
    );
  });

  it("is case-insensitive on the host and the scheme", () => {
    expect(
      rewriteTurnsUrl(
        `TURNS:${SIGNAL_HOST.toUpperCase()}:443?transport=tcp`,
        SIGNAL_HOST
      )
    ).toBe(`TURNS:${SIGNAL_HOST.toUpperCase()}:${FUNNEL_TURN_TLS_PORT}?transport=tcp`);
  });

  it("leaves a Cloud TURN host unchanged", () => {
    const cloud =
      "turns:global.turn.livekit.cloud:443?transport=tcp";
    expect(rewriteTurnsUrl(cloud, "proj.livekit.cloud")).toBe(cloud);
  });

  it("leaves a regional Cloud TURN host unchanged", () => {
    const cloud =
      "turns:us-east.turn.livekit.cloud:443?transport=tcp";
    expect(rewriteTurnsUrl(cloud, "proj.livekit.cloud")).toBe(cloud);
  });

  it("leaves stun: unchanged", () => {
    const stun = `stun:${SIGNAL_HOST}:3478`;
    expect(rewriteTurnsUrl(stun, SIGNAL_HOST)).toBe(stun);
  });

  it("leaves turns on a non-443 port unchanged", () => {
    const already = FUNNEL_TURNS_8443;
    expect(rewriteTurnsUrl(already, SIGNAL_HOST)).toBe(already);
  });

  it("leaves turn: (not turns:) unchanged even on 443", () => {
    const udp = `turn:${SIGNAL_HOST}:443?transport=udp`;
    expect(rewriteTurnsUrl(udp, SIGNAL_HOST)).toBe(udp);
  });

  it("leaves a host ICE candidate string unchanged", () => {
    const candidate =
      "candidate:1 1 UDP 2130706431 192.168.1.5 54321 typ host";
    expect(rewriteTurnsUrl(candidate, SIGNAL_HOST)).toBe(candidate);
  });
});

describe("iceServers rewrite", () => {
  it("rewrites same-host turns:443 and keeps username/credential", () => {
    const servers: RTCIceServer[] = [
      {
        urls: FUNNEL_TURNS_443,
        username: USERNAME,
        credential: CREDENTIAL,
      },
    ];

    const rewritten = rewriteIceServers(servers, SIGNAL_HOST);

    expect(rewritten).toEqual([
      {
        urls: FUNNEL_TURNS_8443,
        username: USERNAME,
        credential: CREDENTIAL,
      },
    ]);
    expect(rewritten[0]?.username).toBe(USERNAME);
    expect(rewritten[0]?.credential).toBe(CREDENTIAL);
  });

  it("does not rewrite a Cloud iceServer next to a Funnel one", () => {
    const cloud: RTCIceServer = {
      urls: ["turns:global.turn.livekit.cloud:443?transport=tcp"],
      username: USERNAME,
      credential: CREDENTIAL,
    };
    const stun: RTCIceServer = { urls: `stun:${SIGNAL_HOST}:3478` };
    const funnel: RTCIceServer = {
      urls: [FUNNEL_TURNS_443],
      username: USERNAME,
      credential: CREDENTIAL,
    };

    const rewritten = rewriteIceServers(
      [cloud, stun, funnel],
      SIGNAL_HOST
    );

    expect(rewritten[0]).toBe(cloud);
    expect(rewritten[1]).toBe(stun);
    expect(rewritten[2]).toEqual({
      urls: [FUNNEL_TURNS_8443],
      username: USERNAME,
      credential: CREDENTIAL,
    });
  });

  it("returns the same array when nothing matches", () => {
    const servers: RTCIceServer[] = [
      { urls: "stun:stun.livekit.cloud:443" },
      {
        urls: "turns:global.turn.livekit.cloud:443?transport=tcp",
        username: USERNAME,
        credential: CREDENTIAL,
      },
    ];
    expect(rewriteIceServers(servers, "proj.livekit.cloud")).toBe(servers);
  });
});

describe("RTCPeerConnection shim", () => {
  it("rewrites constructor and setConfiguration iceServers", () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const restore = installHuddleTurnRewriteShim(FUNNEL_SIGNAL);

    const peer = new globalThis.RTCPeerConnection({
      iceServers: [
        {
          urls: FUNNEL_TURNS_443,
          username: USERNAME,
          credential: CREDENTIAL,
        },
      ],
    });
    const constructed = peer as unknown as FakePeerConnection;
    expect(constructed.configuration?.iceServers).toEqual([
      {
        urls: FUNNEL_TURNS_8443,
        username: USERNAME,
        credential: CREDENTIAL,
      },
    ]);

    peer.setConfiguration({
      iceServers: [
        {
          urls: FUNNEL_TURNS_443,
          username: USERNAME,
          credential: CREDENTIAL,
        },
      ],
    });
    expect(constructed.configuration?.iceServers?.[0]?.urls).toBe(
      FUNNEL_TURNS_8443
    );
    expect(constructed.configuration?.iceServers?.[0]?.credential).toBe(
      CREDENTIAL
    );

    restore();
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);
  });

  it("restores the original constructor and is leak-free after a second restore", () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const restore = installHuddleTurnRewriteShim(FUNNEL_SIGNAL);
    expect(globalThis.RTCPeerConnection).not.toBe(FakePeerConnection);

    restore();
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);
    restore();
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);
  });

  it("does not install when the signal URL has no host", () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const restore = installHuddleTurnRewriteShim("not-a-url");
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);
    restore();
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);
  });
});

describe("huddleRuntime wiring", () => {
  it("installs the shim around room.connect and restores in finally", () => {
    const source = readFileSync(
      new URL("./huddleRuntime.ts", import.meta.url),
      "utf8"
    );
    expect(source).toMatch(/installHuddleTurnRewriteShim/);
    expect(source).toMatch(/restoreTurnRewrite\(\)/);
    const connectIndex = source.indexOf("room.connect(");
    const installIndex = source.indexOf("installHuddleTurnRewriteShim(");
    const restoreIndex = source.indexOf("restoreTurnRewrite()");
    expect(installIndex).toBeGreaterThan(-1);
    expect(connectIndex).toBeGreaterThan(installIndex);
    expect(restoreIndex).toBeGreaterThan(connectIndex);
  });
});
