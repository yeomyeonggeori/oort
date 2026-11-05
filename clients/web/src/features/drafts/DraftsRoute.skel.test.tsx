// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "@momo/core/lib/http";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { DraftsPanelState } from "./useDraftsPanel";
import { DraftsRoute } from "./DraftsRoute";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const panel: DraftsPanelState = {
  items: [],
  showNav: false,
  isPending: false,
  isError: false,
  error: null,
  refetch: () => undefined,
};

vi.mock("./useDraftsPanel", () => ({
  useDraftsPanel: () => panel,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

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

/** `korean`은 사전 문장을 단정하는 시험만 켠다(공급자가 없으면 번들된 영어로 물러난다). */
async function mount(options: { korean?: boolean } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const page: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: ["/drafts"] },
      createElement(DraftsRoute)
    )
  );
  const tree: ReactElement = options.korean ? createElement(LocaleProvider, { locale: ko, children: page }) : page;
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  panel.items = [];
  panel.isPending = false;
  panel.isError = false;
  panel.error = null;
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
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

describe("DraftsRoute skeleton host", () => {
  it("wraps the empty state inside Skeleton (moving it out turns this red)", async () => {
    const host = await mount();
    const empty = host.querySelector('[data-testid="drafts-empty"]');
    const skel = host.querySelector(
      '[data-testid="drafts-route"] [data-testid="skeleton"]'
    );
    expect(empty).not.toBeNull();
    expect(skel).not.toBeNull();
    expect(skel?.contains(empty)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(skel?.querySelector(".skel-content")).toBeTruthy();
  });

  it("stays data-ready=false while drafts are loading (ready={true} turns this red)", async () => {
    panel.isPending = true;
    const host = await mount();
    const skel = host.querySelector(
      '[data-testid="drafts-route"] [data-testid="skeleton"]'
    );
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute("data-ready")).toBe("false");
  });
});

describe("DraftsRoute: 채널 목록을 못 읽어 초안 대상을 모른다 (#5279 A)", () => {
  const refetch = vi.fn();
  const noteOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="drafts-error"]');

  it("결과 문장이 제목이고 원인 이유가 뒤에 붙는다. 다음 행동은 단추가 말하고, 누르면 다시 읽는다", async () => {
    vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(true);
    panel.isError = true;
    panel.error = new NetworkError("unreachable", 15_000);
    panel.refetch = refetch;
    const host = await mount({ korean: true });
    const note = noteOf(host);
    expect(note?.textContent).toContain("채널 목록을 불러오지 못해 초안 대상을 확인할 수 없어요. 서버에 닿지 못했어요.");
    expect(note?.textContent).not.toContain("다시 시도해 주세요");
    expect(note?.getAttribute("role")).toBe("alert");
    expect(note?.textContent).not.toMatch(/\d{3}/);
    act(() => note?.querySelector("button")?.click());
    expect(refetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("기기가 꺼져 있으면 원인은 오프라인이다", async () => {
    vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(false);
    panel.isError = true;
    panel.error = new NetworkError("unreachable", 15_000);
    const host = await mount({ korean: true });
    expect(noteOf(host)?.textContent).toContain("채널 목록을 불러오지 못해 초안 대상을 확인할 수 없어요. 오프라인이에요. 연결되면 다시 불러올 수 있어요.");
    vi.restoreAllMocks();
  });
});
