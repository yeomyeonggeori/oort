// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember, WorkHost } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";

const api = vi.hoisted(() => ({ fetchWorkHosts: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});
const shell = vi.hoisted(() => ({ desktop: true }));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, isDesktop: () => shell.desktop };
});
const signing = vi.hoisted(() => ({ required: null as boolean | null }));
vi.mock("@momo/core/features/auth/deviceKeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/auth/deviceKeys")>();
  return { ...actual, fetchHumanControlSignatureRequired: async () => signing.required };
});

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { Composer } from "./Composer";
import { usePersonalCall } from "./usePersonalCall";
import { CALL_NEEDS_APP_LINE } from "@momo/core/features/auth/personalAgentCall";

const ME = "00000000-0000-7000-8000-00000000000a";
const OTHER = "00000000-0000-7000-8000-00000000000b";
const FOLDER = "fld_0123456789abcdef0123";

function agent(handle: string, ownerId: string): RosterMember {
  return {
    id: `agent-${handle}`,
    workspaceId: "w",
    kind: "agent",
    status: "active",
    displayName: handle,
    handle,
    channelCount: 1,
    channelIds: ["c"],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    personalAgent: { label: handle, ownerId, ownerDisplayName: "x", harness: "claude", enabled: true, mentionable: true },
  } as unknown as RosterMember;
}

const MEMBERS = [agent("my-claude", ME), agent("their-claude", OTHER)];
const HOSTS: WorkHost[] = [
  {
    id: "h1",
    workspaceId: "w",
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재의 MacBook",
    capabilities: {},
    createdAtMs: 0,
    online: true,
    defaultFolderId: FOLDER,
  },
];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  shell.desktop = true;
  signing.required = null;
  api.fetchWorkHosts.mockReset().mockResolvedValue(HOSTS);
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: "w", kind: "human", displayName: "곽성재", handle: "kwak" },
    },
    workspaceId: "w",
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

const sends: Array<{ body: string; personalCall: unknown }> = [];

function Harness() {
  const directory = makeDirectory(MEMBERS);
  const personalCall = usePersonalCall({
    workspaceId: "w",
    channelId: "c",
    channelKind: "public",
    members: directory.members,
    selfId: ME,
    dmAgent: null,
  });
  return createElement(Composer, {
    workspaceId: "w",
    channelId: "c",
    directory,
    channels: [],
    channelLabel: "일반",
    recipient: "place",
    dmAgent: null,
    quote: null,
    onCancelQuote: () => undefined,
    onSend: (body, options) => {
      sends.push({ body, personalCall: options?.personalCall });
    },
    personalCall,
  });
}

async function mount(node: ReactElement): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(
          OpenAgentProfileContext.Provider,
          { value: () => undefined },
          createElement(SessionProvider, { value: session() }, node)
        ))
      )
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

async function type(root: HTMLElement, value: string) {
  const area = root.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(root: HTMLElement) {
  const form = root.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  sends.length = 0;
});

describe("composer: calling my personal agent (#3653)", () => {
  it("my @mention shows 「내 맥 · <기기> · Claude Code」 above the input and carries the call on send", async () => {
    const root = await mount(createElement(Harness));
    expect(root.querySelector("[data-testid='composer-call-preview']")).toBeNull();
    await type(root, "@my-claude 빌드를 봐 줘");
    expect(root.querySelector("[data-testid='composer-call-destination']")?.textContent).toBe(
      "내 맥 · 성재의 MacBook · Claude Code"
    );
    await submit(root);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toBe("@my-claude 빌드를 봐 줘");
    expect(sends[0]!.personalCall).toMatchObject({ agent: { handle: "my-claude", harness: "claude" } });
  });

  it("a teammate's personal agent is just a message: no line, no call on send", async () => {
    const root = await mount(createElement(Harness));
    await type(root, "@their-claude 빌드를 봐 줘");
    expect(root.querySelector("[data-testid='composer-call-preview']")).toBeNull();
    await submit(root);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.personalCall).toBeUndefined();
  });

  it("a plain message calls nothing", async () => {
    const root = await mount(createElement(Harness));
    await type(root, "안녕하세요");
    await submit(root);
    expect(sends[0]!.personalCall).toBeUndefined();
  });

  it("in a browser the line is honest before sending: message only, call from the app", async () => {
    shell.desktop = false;
    const root = await mount(createElement(Harness));
    await type(root, "@my-claude 빌드를 봐 줘");
    expect(root.querySelector("[data-testid='composer-call-destination']")).toBeNull();
    expect(root.querySelector("[data-testid='composer-call-blocked']")?.textContent).toContain(CALL_NEEDS_APP_LINE);
    await submit(root);
    expect(sends[0]!.personalCall).toMatchObject({ signer: null });
  });
});
