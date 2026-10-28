// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AvatarWithPresence, HumanPresenceLabel } from "./HumanPresence";

// The two shapes a person's dot is drawn in (#4692, ADR-0160 ②③). The verdict is
// core's `humanPresenceDot`; what is under test here is what reaches the screen:
// which dot (tone, shape classes), the word on the tooltip, the viewer's own row
// following this client's connection, and a declared pause ending on the clock.

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const PEER = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-000000000103";
const NOW = 1_800_000_000_000;

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function member(over: Partial<RosterMember> & { id?: string }): RosterMember {
  return {
    id: PEER,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이도현",
    handle: "dohyun",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function sessionValue(connStatus: SessionContextValue["connStatus"]): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function render(
  ui: ReactElement,
  connStatus: SessionContextValue["connStatus"] = "connected"
): HTMLElement {
  if (root === null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root?.render(createElement(SessionProvider, { value: sessionValue(connStatus) }, ui)));
  return host as HTMLElement;
}

const avatar = (row: RosterMember) =>
  createElement(AvatarWithPresence, {
    member: row,
    children: createElement("span", { "data-testid": "face" }, "이"),
  });
const dotIn = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="presence-dot"]');

describe("AvatarWithPresence: the corner dot", () => {
  it.each([
    ["접속 중은 채운 초록", { online: true }, "ok", ["bg-ok"]],
    ["접속 없음은 속 빈 고리", { online: false }, "muted", ["bg-surface", "border-line-strong"]],
    ["자리 비움은 접속 여부보다 먼저", { online: true, presenceStatus: "away" as const }, "warn", ["bg-warn"]],
    ["방해 금지는 접속 중이어도", { online: true, presenceStatus: "dnd" as const }, "danger", ["bg-danger"]],
  ])("%s", (_name, patch, tone, classes) => {
    const el = render(avatar(member(patch)));
    const dot = dotIn(el);
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-tone")).toBe(tone);
    for (const cls of classes) expect(dot?.className).toContain(cls);
    expect(el.querySelector('[data-testid="face"]')).not.toBeNull(); // the face is still drawn
  });

  it("the hollow ring is not the offline of a filled dot: online and offline never share a class", () => {
    const online = dotIn(render(avatar(member({ online: true }))))!;
    const onlineClass = online.className;
    act(() => root?.unmount());
    root = null;
    host?.remove();
    const offline = dotIn(render(avatar(member({ online: false }))))!;
    expect(offline.className).not.toBe(onlineClass);
    expect(onlineClass).not.toContain("border-line-strong");
    expect(offline.className).not.toContain("bg-ok");
  });

  it("the word is on the tooltip, and the dot itself is hidden from assistive tech", () => {
    const el = render(avatar(member({ online: false })));
    expect(el.querySelector('[data-testid="avatar-with-presence"]')?.getAttribute("title")).toBe(
      "오프라인"
    );
    expect(dotIn(el)?.getAttribute("aria-hidden")).toBe("true");
  });

  it("unknown availability draws no dot and no tooltip: absence is not offline", () => {
    const el = render(avatar(member({})));
    expect(dotIn(el)).toBeNull();
    expect(el.querySelector('[data-testid="avatar-with-presence"]')?.hasAttribute("title")).toBe(false);
  });

  it("an agent never gets a person's dot, even if its row carries `online`", () => {
    const el = render(avatar(member({ id: AGENT, kind: "agent", online: true })));
    expect(dotIn(el)).toBeNull();
  });

  it("the viewer's own row follows THIS client's connection, not the broker's view", () => {
    const own = (patch: Partial<RosterMember>) => avatar(member({ id: ME, ...patch }));
    // The broker has not counted this app yet (absent), the socket is up: online.
    expect(dotIn(render(own({}), "connected"))?.getAttribute("data-tone")).toBe("ok");
    // The broker still lists us, but this client's socket is down: offline.
    expect(dotIn(render(own({ online: true }), "disconnected"))?.getAttribute("data-tone")).toBe(
      "muted"
    );
    // Someone else's row is never touched by this client's own connection.
    expect(dotIn(render(avatar(member({})), "connected"))).toBeNull();
  });

  it("a declared pause ends on the clock: the dot falls back to availability without a refetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const el = render(avatar(member({ online: true, presenceStatus: "dnd", dndUntilMs: NOW + 5_000 })));
    expect(dotIn(el)?.getAttribute("data-tone")).toBe("danger");
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(dotIn(el)?.getAttribute("data-tone")).toBe("danger"); // the instant itself is not yet past
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(dotIn(el)?.getAttribute("data-tone")).toBe("ok");
  });
});

describe("HumanPresenceLabel: dot and word on one line", () => {
  const label = (row: RosterMember) => createElement(HumanPresenceLabel, { member: row });
  const chip = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="human-presence"]');

  it("says the word beside the dot, every tone filled (the word carries the meaning)", () => {
    const online = chip(render(label(member({ online: true }))))!;
    expect(online.textContent).toBe("온라인");
    expect(online.getAttribute("data-tone")).toBe("ok");
    act(() => root?.unmount());
    root = null;
    host?.remove();
    const offline = chip(render(label(member({ online: false }))))!;
    expect(offline.textContent).toBe("오프라인");
    // Beside a word the offline dot is a filled grey, not the avatar corner's hollow ring.
    expect(offline.querySelector("span")?.className).toContain("bg-ink-muted");
  });

  it("a declared status wins and is named", () => {
    expect(chip(render(label(member({ online: true, presenceStatus: "away" }))))?.textContent).toBe(
      "자리 비움"
    );
  });

  it("draws nothing for an unknown person or an agent", () => {
    expect(chip(render(label(member({}))))).toBeNull();
    expect(chip(render(label(member({ id: AGENT, kind: "agent", online: true }))))).toBeNull();
  });
});
