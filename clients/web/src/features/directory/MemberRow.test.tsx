// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { MemberRow } from "./MemberRow";

// The directory row (#4692): who is connected, said by the avatar-corner dot and
// carried into the row's accessible name. There was no render test of this row
// before (the model tests cover the label function, not what the row draws), so
// this is a new file for an existing target.

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const PEER = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-000000000103";

// An agent row also draws a liveness chip, which reads its own endpoint. This
// test is about the person's dot, so the chip is stood down.
vi.mock("@/features/agents/AgentLivenessLabel", () => ({
  AgentLivenessLabel: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이도현",
    handle: "dohyun",
    role: "member",
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
  row: RosterMember,
  connStatus: SessionContextValue["connStatus"] = "connected",
  roster: RosterMember[] = [row]
): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(workspaceIdentityKey(WS), {
    id: WS,
    slug: "dawn",
    name: "새벽팀",
    updatedAtMs: 0,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        LocaleProvider,
        { locale: ko },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: sessionValue(connStatus) },
            createElement(
              "ul",
              null,
              createElement(MemberRow, {
                member: row,
                directory: makeDirectory(roster),
                selfMemberId: ME,
                onOpenProfile: () => undefined,
              })
            )
          )
        )
      )
    )
  );
  return host;
}

const dot = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="presence-dot"]');
const name = (el: HTMLElement) =>
  el.querySelector('[data-testid="directory-row"]')?.getAttribute("aria-label") ?? "";

describe("MemberRow: a person's availability (#4692)", () => {
  it("a connected person has a filled green dot and the word in the accessible name", () => {
    const el = render(member({ id: PEER, online: true }));
    expect(dot(el)?.getAttribute("data-tone")).toBe("ok");
    expect(name(el)).toBe("이도현 @dohyun, 멤버, 온라인, 프로필 열기");
  });

  it("a person with no connection has the hollow ring, and the name says 오프라인", () => {
    const el = render(member({ id: PEER, online: false }));
    expect(dot(el)?.getAttribute("data-tone")).toBe("muted");
    expect(name(el)).toBe("이도현 @dohyun, 멤버, 오프라인, 프로필 열기");
  });

  it("a declared pause is drawn and named instead of the connection", () => {
    const el = render(member({ id: PEER, online: true, presenceStatus: "dnd" }));
    expect(dot(el)?.getAttribute("data-tone")).toBe("danger");
    expect(name(el)).toContain("방해 금지");
    expect(name(el)).not.toContain("온라인");
  });

  it("unknown availability draws no dot and says nothing: the row reads as it did before", () => {
    const el = render(member({ id: PEER }));
    expect(dot(el)).toBeNull();
    expect(name(el)).toBe("이도현 @dohyun, 멤버, 프로필 열기");
  });

  it("an agent row has no person's dot, even if it carries `online`", () => {
    const el = render(
      member({ id: AGENT, kind: "agent", displayName: "김인턴", handle: "kim-intern", online: true })
    );
    expect(dot(el)).toBeNull();
    expect(name(el)).not.toContain("온라인");
  });

  it("the viewer's own row is as online as this client's connection, whatever the broker says", () => {
    const own = member({ id: ME, displayName: "박서연", handle: "seoyeon" });
    const connected = render(own, "connected");
    expect(dot(connected)?.getAttribute("data-tone")).toBe("ok");
    expect(name(connected)).toBe("박서연 @seoyeon, 멤버, 온라인, 나, 프로필 열기");
    act(() => root?.unmount());
    root = null;
    host?.remove();
    const cut = render({ ...own, online: true }, "disconnected");
    expect(dot(cut)?.getAttribute("data-tone")).toBe("muted");
    expect(name(cut)).toContain("오프라인");
  });
});

// #5782: the row is the shared list row, two layers exactly, and the email is a
// member's to see but not a guest's (owner 2026-11-14, 제안서 12번 추천).
describe("MemberRow: two layers and the email (#5782)", () => {
  const subtitle = (el: HTMLElement) =>
    el.querySelector('[data-testid="directory-row-subtitle"]')?.textContent ?? "";
  const peer = () =>
    member({ id: PEER, displayName: "이서연", handle: "seoyeon", role: "admin", email: " seoyeon@example.com " });
  const viewer = (role: RosterMember["role"]) =>
    member({ id: ME, displayName: "김도현", handle: "dohyeon", role });

  it("a member viewer reads 「@핸들 · 이메일」, and the email is in the accessible name", () => {
    const el = render(peer(), "connected", [viewer("member"), peer()]);
    expect(subtitle(el)).toBe("@seoyeon · seoyeon@example.com");
    expect(name(el)).toBe("이서연 @seoyeon, 관리자, seoyeon@example.com, 프로필 열기");
  });

  it("a guest viewer does not see the email, on screen or in the accessible name", () => {
    const el = render(peer(), "connected", [viewer("guest"), peer()]);
    expect(subtitle(el)).toBe("@seoyeon");
    expect(el.textContent).not.toContain("example.com");
    expect(name(el)).not.toContain("example.com");
  });

  it("a viewer whose role is not known yet does not see it either (unknown is not open)", () => {
    const el = render(peer(), "connected", [peer()]);
    expect(subtitle(el)).toBe("@seoyeon");
  });

  it("an agent reads 「@핸들 · ○○ 님이 관리」 with no email, and no role chip", () => {
    const agent = member({
      id: AGENT,
      kind: "agent",
      displayName: "hermes",
      handle: "hermes",
      ownerHumanId: ME,
      email: "agent@example.com",
    });
    const el = render(agent, "connected", [viewer("owner"), agent]);
    expect(subtitle(el)).toBe("@hermes · 김도현 님이 관리");
    expect(el.querySelector('[data-testid="directory-row-role"]')).toBeNull();
  });

  it("the role is a chip at the end, and my own row says 「나」 beside the name", () => {
    const me = viewer("owner");
    const el = render(me, "connected", [me]);
    expect(el.querySelector('[data-testid="directory-row-role"]')?.textContent).toBe("소유자");
    expect(el.querySelector('[data-testid="directory-row-self"]')?.textContent).toBe("나");
    expect(name(el)).toMatch(/, 나, 프로필 열기$/);
  });

  it("exactly two text layers: a custom status adds no third line, a stale member adds a chip in the title", () => {
    const busy = member({
      id: PEER,
      displayName: "이서연",
      handle: "seoyeon",
      status: "suspended",
      statusEmoji: "🌴",
      statusText: "휴가",
    });
    const el = render(busy, "connected", [viewer("member"), busy]);
    const button = el.querySelector('[data-testid="directory-row"]');
    const stack = button?.children[1];
    expect(stack?.children.length).toBe(2);
    expect(stack?.children[0]?.textContent).toContain("정지됨");
    expect(el.querySelector('[data-testid="custom-status-text"]')).toBeNull();
  });
});
