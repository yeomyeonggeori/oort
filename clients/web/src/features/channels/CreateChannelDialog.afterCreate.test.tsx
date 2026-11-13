// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidEq, type Channel, type RosterMember } from "@momo/core/lib/api";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { AddChannelMemberProvider } from "./AddChannelMemberDialog";
import { CreateChannelProvider } from "./CreateChannelDialog";
import { useOpenCreateChannel } from "./useCreateChannel";

// 채널을 만든 직후(#5784, QA 9·10).
//   1. 머리의 멤버 수는 명부의 `channelIds` 로 센다(ChatShell). 만든 사람은 서버에서 이미 멤버인데 명부를 그대로 두면 다음 명부
//      읽기까지 「멤버 0」이었다. 여기서는 명부 다시 읽기를 **붙잡아 두고** 세어, 다시 읽기 덕이 아니라 만든 순간 1임을 잰다.
//   2. 비공개 채널을 만들면 「멤버 추가」가 이어서 뜨고 「나중에」로 건너뛴다. 공개는 잇지 않는다(이슈 범위).
//   3. 그 잇기는 셸의 순서(멤버 추가 provider 가 만들기 provider 바깥)에 기대므로 그 순서를 소스로 잰다.

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEOYEON = "00000000-0000-7000-8000-000000000102";
const CREATED_ID = "00000000-0000-7000-8000-0000000003aa";
const LANDING = "/c/notification-destination";

const api = vi.hoisted(() => ({
  createChannel: vi.fn(),
  fetchRoster: vi.fn(),
  addChannelMember: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  createChannel: (...args: unknown[]) => api.createChannel(...args),
  fetchRoster: (...args: unknown[]) => api.fetchRoster(...args),
  addChannelMember: (...args: unknown[]) => api.addChannelMember(...args),
}));
vi.mock("@/features/common/useOffline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/common/useOffline")>()),
  useOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

const session: SessionContextValue = {
  session: {
    accessToken: "a",
    refreshToken: "r",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyeon" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

function rosterRow(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}
const ROSTER = [rosterRow(ME, "김도현", "dohyeon"), rosterRow(SEOYEON, "이서연", "seoyeon")];

function Opener() {
  const open = useOpenCreateChannel();
  return createElement(
    "button",
    { "data-testid": "opener", onClick: (e: React.MouseEvent<HTMLElement>) => open(e.currentTarget) },
    "열기"
  );
}
function Where() {
  return createElement("span", { "data-testid": "where" }, useLocation().pathname);
}
/** 머리의 멤버 수와 같은 셈: 명부에서 `channelIds` 에 이 채널이 든 사람(ChatShell `channelMembers`). */
function HeaderCount() {
  const { directory } = useDirectory(WS);
  const count = directory.members.filter((member) =>
    member.channelIds.some((id) => uuidEq(id, CREATED_ID))
  ).length;
  return createElement("span", { "data-testid": "count" }, String(count));
}
function Lander() {
  const navigate = useNavigate();
  return createElement(
    "button",
    {
      "data-testid": "land",
      onClick: () => {
        dismissTemporarySurfaces();
        navigate(LANDING);
      },
    },
    "알림 착지"
  );
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 셸과 같은 순서: 멤버 추가 provider 가 만들기 provider 바깥이다(AppShell.tsx).
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session },
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(
          AddChannelMemberProvider,
          null,
          createElement(
            CreateChannelProvider,
            null,
            createElement(Opener),
            createElement(Where),
            createElement(HeaderCount),
            createElement(Lander)
          )
        )
      )
    )
  );
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
  // 첫 명부 읽기가 내려앉을 때까지.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const text = (testId: string) => q(testId)?.textContent ?? null;
const click = (testId: string) =>
  act(async () => {
    q(testId)!.click();
    await Promise.resolve();
  });
const type = (testId: string, value: string) =>
  act(async () => {
    const input = q(testId) as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function createAs(kind: "public" | "private"): Promise<void> {
  await click("opener");
  await type("create-channel-name", "ops-room");
  if (kind === "private") {
    await act(async () => {
      document.querySelector<HTMLInputElement>("#create-channel-kind-private")!.click();
    });
  }
  await click("create-channel-submit");
  await settle();
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  api.createChannel.mockReset();
  api.fetchRoster.mockReset();
  api.addChannelMember.mockReset();
  // 첫 읽기만 답하고, 그 뒤의 다시 읽기는 끝나지 않는다 — 만든 직후의 수가 다시 읽기 덕이면 0으로 남는다.
  api.fetchRoster.mockResolvedValueOnce(ROSTER).mockImplementation(() => new Promise(() => undefined));
  api.createChannel.mockImplementation(
    async (_ws: string, input: { kind: "public" | "private"; name: string }) => ({
      channel: { id: CREATED_ID, workspaceId: WS, kind: input.kind, name: input.name, muted: false } as Channel,
    })
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("채널을 만든 직후 머리의 멤버 수 (#5784)", () => {
  it("명부 다시 읽기가 끝나지 않아도, 만든 사람 한 명이 세어진다", async () => {
    await mount();
    expect(text("count")).toBe("0");

    await createAs("public");

    expect(q("where")?.textContent).toBe(`/c/${CREATED_ID}`);
    expect(text("count")).toBe("1");
    // 명부는 다시 읽으러 나갔다(두 번째 읽기 — 붙잡혀 있다). 진짜 행이 오면 그 값으로 맞춰진다.
    expect(api.fetchRoster).toHaveBeenCalledTimes(2);
  });
});

describe("비공개 채널을 만들면 「멤버 추가」가 이어서 뜬다 (#5784)", () => {
  it("공개 채널은 잇지 않는다 — 만들기 창만 닫힌다", async () => {
    await mount();
    await createAs("public");
    expect(q("create-channel-dialog")).toBeNull();
    expect(q("add-channel-member-dialog")).toBeNull();
  });

  it("비공개 채널은 만든 채널을 말하는 「멤버 추가」가 뜨고, 아무도 넣지 않았으면 닫는 단추가 「나중에」다", async () => {
    await mount();
    await createAs("private");

    expect(q("create-channel-dialog")).toBeNull();
    expect(q("add-channel-member-dialog")).not.toBeNull();
    // 시험 환경의 문구는 영어 사전이다(`useFormatMessage` 의 fixture). 낱말이 아니라 「만든 채널 이름을 말한다」를 잰다.
    expect(text("add-member-description")).toContain("ops-room");
    expect(text("add-member-description")).toContain("Created");
    expect(text("add-member-close")).toBe("Later");
    // 캐럿은 이어 뜬 창 안에 있다.
    expect(q("add-channel-member-dialog")!.contains(document.activeElement)).toBe(true);

    await click("add-member-close");
    await settle();
    expect(q("add-channel-member-dialog")).toBeNull();
    // 건너뛰어도 채널로는 들어와 있다.
    expect(q("where")?.textContent).toBe(`/c/${CREATED_ID}`);
    // 캐럿은 만들기 창을 열었던 자리로 돌아간다(만들기 창이 넘긴 `opener`).
    expect(document.activeElement).toBe(q("opener"));
  });

  it("한 명을 추가하면 「나중에」가 평소의 「닫기」로 돌아간다", async () => {
    api.addChannelMember.mockResolvedValue({});
    await mount();
    await createAs("private");
    expect(text("add-member-close")).toBe("Later");

    const add = document.querySelector<HTMLElement>(
      `[data-testid="add-member-button"][data-member-id="${SEOYEON}"]`
    );
    expect(add).not.toBeNull();
    await act(async () => {
      add!.click();
      await Promise.resolve();
    });
    await settle();

    expect(api.addChannelMember).toHaveBeenCalledWith(WS, CREATED_ID, SEOYEON);
    expect(text("add-member-close")).toBe("닫기");
  });

  it("만드는 동안 알림이 착지해 창이 걷혔으면, 비공개여도 「멤버 추가」를 띄우지 않는다", async () => {
    let answer: (() => void) | null = null;
    api.createChannel.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              channel: { id: CREATED_ID, workspaceId: WS, kind: "private", name: "ops-room", muted: false } as Channel,
            });
        })
    );
    await mount();
    await click("opener");
    await type("create-channel-name", "ops-room");
    await act(async () => {
      document.querySelector<HTMLInputElement>("#create-channel-kind-private")!.click();
    });
    await click("create-channel-submit");
    await click("land");

    await act(async () => {
      answer?.();
      await Promise.resolve();
    });
    await settle();

    expect(q("where")?.textContent).toBe(LANDING);
    expect(q("add-channel-member-dialog")).toBeNull();
  });
});

describe("셸의 순서 — 멤버 추가 provider 가 만들기 provider 바깥 (#5784)", () => {
  it("AppShell 이 `AddChannelMemberProvider` 를 `CreateChannelProvider` 보다 먼저 연다", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "..", "app", "AppShell.tsx"), "utf8");
    const addAt = source.indexOf("<AddChannelMemberProvider>");
    const createAt = source.indexOf("<CreateChannelProvider>");
    const createCloseAt = source.indexOf("</CreateChannelProvider>");
    const addCloseAt = source.indexOf("</AddChannelMemberProvider>");
    expect(addAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(addAt).toBeLessThan(createAt);
    expect(createCloseAt).toBeLessThan(addCloseAt);
  });
});
