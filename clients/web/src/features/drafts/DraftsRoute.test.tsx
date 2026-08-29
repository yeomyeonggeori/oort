// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import {
  clearAllDrafts,
  readDraft,
  writeDraft,
} from "@/features/chat/draftStore";
import { makeDirectory } from "@/features/workspace/useWorkspace";
import { DraftsRoute } from "./DraftsRoute";
import { DraftsNavItem } from "./DraftsNavItem";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_GENERAL = "00000000-0000-7000-8000-000000000201";
const CH_ENGINE = "00000000-0000-7000-8000-000000000202";
const CH_GONE = "00000000-0000-7000-8000-00000000dead";
const NOW = 1_800_000_000_000;

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const channelsState: {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  data: Channel[] | undefined;
  groups: { channels: Channel[]; dms: Channel[] };
  refetch: () => void;
} = {
  isPending: false,
  isSuccess: true,
  isError: false,
  data: [],
  groups: { channels: [], dms: [] },
  refetch: () => undefined,
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsState,
    useDirectory: () => ({
      directory: makeDirectory([]),
      isPending: false,
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let store: Map<string, string>;

function channel(id: string, name: string): Channel {
  return { id, workspaceId: WS, kind: "public", name, muted: false };
}

function setLiveChannels(channels: Channel[]) {
  channelsState.isPending = false;
  channelsState.isSuccess = true;
  channelsState.isError = false;
  channelsState.data = channels;
  channelsState.groups = { channels, dms: [] };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function ComposerProbe() {
  const { channelId } = useParams();
  const text = readDraft(WS, channelId ?? "");
  return createElement("div", { "data-testid": "composer-probe" }, text);
}

async function mountAt(path: string): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/drafts", element: createElement(DraftsRoute) }),
        createElement(Route, {
          path: "/c/:channelId",
          element: createElement(ComposerProbe),
        }),
        createElement(Route, {
          path: "/nav",
          element: createElement("ul", null, createElement(DraftsNavItem)),
        })
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) {
        super(type, init);
      }
    } as unknown as typeof PointerEvent;
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("hover: none"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  setLiveChannels([
    channel(CH_GENERAL, "general"),
    channel(CH_ENGINE, "엔진"),
  ]);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  clearAllDrafts();
  vi.unstubAllGlobals();
});

describe("초안 패널 (#1901)", () => {
  it("여러 채널 초안을 최근 수정순으로 그리고 미리보기를 한 줄로 접는다", async () => {
    writeDraft(WS, CH_GENERAL, "배포 롤백 근거를 정리하면", NOW);
    writeDraft(WS, CH_ENGINE, "PR 본문에 게이트 증거를 붙이고\n두 번째 줄", NOW + 4_000);
    const host = await mountAt("/drafts");
    const rows = [...host.querySelectorAll('[data-testid="draft-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-channel-id")).toBe(CH_ENGINE);
    expect(rows[1]?.getAttribute("data-channel-id")).toBe(CH_GENERAL);
    expect(host.textContent).toContain("엔진");
    expect(host.textContent).toContain("general");
    expect(
      rows[0]?.querySelector('[data-testid="draft-row-preview"]')?.textContent
    ).toBe("PR 본문에 게이트 증거를 붙이고 두 번째 줄");
  });

  it("행을 누르면 그 채널로 가고 컴포저가 초안을 읽는다", async () => {
    writeDraft(WS, CH_ENGINE, "엔진 초안을 이어서 쓴다", NOW);
    const host = await mountAt("/drafts");
    const link = host.querySelector(
      `[data-testid="draft-row"][data-channel-id="${CH_ENGINE}"] a`
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    await act(async () => {
      link!.click();
    });
    const probe = host.querySelector('[data-testid="composer-probe"]');
    expect(probe?.textContent).toBe("엔진 초안을 이어서 쓴다");
  });

  it("⋯에서 지우면 저장소와 목록이 함께 비고, 마지막이면 빈 상태를 그린다", async () => {
    writeDraft(WS, CH_GENERAL, "지울 초안", NOW);
    const host = await mountAt("/drafts");
    expect(host.querySelector('[data-testid="drafts-list"]')).not.toBeNull();
    const menu = host.querySelector(
      '[data-testid="draft-row-menu"]'
    ) as HTMLButtonElement | null;
    expect(menu).not.toBeNull();
    await act(async () => {
      menu!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      );
      menu!.click();
    });
    const del = await vi.waitFor(() => {
      const item = document.querySelector(
        '[data-testid="draft-row-delete"]'
      ) as HTMLElement | null;
      expect(item).not.toBeNull();
      return item!;
    });
    await act(async () => {
      del.click();
    });
    await vi.waitFor(() => {
      expect(readDraft(WS, CH_GENERAL, NOW)).toBe("");
      expect(host.querySelector('[data-testid="drafts-empty"]')).not.toBeNull();
    });
    expect(host.textContent).toContain("아직 초안이 없습니다.");
    expect(host.textContent).toContain("쓰다 만 글은 자동으로 저장됩니다.");
  });

  it("진입 시 초안 0이면 사용법 카피를 그린다", async () => {
    const host = await mountAt("/drafts");
    expect(host.querySelector('[data-testid="drafts-empty"]')).not.toBeNull();
    expect(host.textContent).toContain("아직 초안이 없습니다.");
    expect(host.textContent).toContain("쓰다 만 글은 자동으로 저장됩니다.");
    expect(host.querySelector('[data-testid="drafts-list"]')).toBeNull();
  });

  it("초안이 없으면 사이드바 줄을 숨긴다", async () => {
    const host = await mountAt("/nav");
    expect(host.querySelector('[data-testid="nav-drafts"]')).toBeNull();
  });

  it("초안이 있으면 사이드바 줄을 세운다", async () => {
    writeDraft(WS, CH_GENERAL, "사이드바에 보일 초안", NOW);
    const host = await mountAt("/nav");
    expect(host.querySelector('[data-testid="nav-drafts"]')).not.toBeNull();
    expect(host.textContent).toContain("초안");
  });

  it("목록에 없는 채널의 초안은 출처 불명으로 두지 않는다", async () => {
    writeDraft(WS, CH_GONE, "떠난 채널의 글", NOW);
    writeDraft(WS, CH_GENERAL, "남아 있는 글", NOW + 1);
    const host = await mountAt("/drafts");
    const rows = [...host.querySelectorAll('[data-testid="draft-row"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-channel-id")).toBe(CH_GENERAL);
    expect(host.textContent).not.toContain("출처 불명");
    expect(host.textContent).not.toContain(CH_GONE);
  });
});
