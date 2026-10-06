// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Member } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LeaveWorkspaceRow } from "./LeaveWorkspaceRow";

const leaveWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, leaveWorkspace: (...a: unknown[]) => leaveWorkspace(...a) };
});

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
const logout = vi.fn();

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  leaveWorkspace.mockReset().mockResolvedValue(undefined);
  logout.mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function mount(offline = false): HTMLElement {
  const member: Member = {
    id: "u",
    workspaceId: "w",
    kind: "human",
    displayName: "곽성재",
    handle: "k",
  };
  const session: SessionContextValue = {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member,
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: "w",
    realtime: null,
    connStatus: "connected",
    logout,
    replaceSessionMember: () => undefined,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { mutations: { retry: false } } }) },
        createElement(
          SessionProvider,
          { value: session },
          createElement(LeaveWorkspaceRow, { workspaceId: "w", offline })
        )
      )
    )
  );
  return host;
}

async function confirmLeave(h: HTMLElement) {
  await act(async () => {
    h.querySelector<HTMLButtonElement>('[data-testid="workspace-leave"]')!.click();
  });
  const confirm = [...h.querySelectorAll("button")].find((b) => b.textContent === "나가기");
  expect(confirm, "제자리 확인의 「나가기」 단추").toBeTruthy();
  await act(async () => {
    confirm!.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe("LeaveWorkspaceRow", () => {
  it("한 번 누른 것만으로는 나가지 않는다", async () => {
    const h = mount();
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="workspace-leave"]')!.click();
    });
    expect(leaveWorkspace).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it("확인하면 나가고 세션을 끝낸다", async () => {
    const h = mount();
    await confirmLeave(h);
    expect(leaveWorkspace).toHaveBeenCalledWith("w");
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("마지막 소유자 409는 안내 문장을 보이고 로그아웃하지 않는다", async () => {
    leaveWorkspace.mockRejectedValue(new ApiError(409, "last owner"));
    const h = mount();
    await confirmLeave(h);
    expect(h.querySelector('[data-testid="workspace-leave-last-owner"]')?.textContent).toContain(
      "마지막 소유자는 나갈 수 없어요"
    );
    expect(logout).not.toHaveBeenCalled();
  });

  it("그 밖의 실패는 오류 줄을 보이고 로그아웃하지 않는다", async () => {
    leaveWorkspace.mockRejectedValue(new ApiError(500, "boom"));
    const h = mount();
    await confirmLeave(h);
    expect(h.querySelector('[data-testid="workspace-leave-error"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="workspace-leave-last-owner"]')).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it("오프라인이면 잠긴다", () => {
    const h = mount(true);
    const trigger = h.querySelector<HTMLButtonElement>('[data-testid="workspace-leave"]')!;
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    act(() => trigger.click());
    expect(h.querySelector('[data-testid="workspace-leave-question"]')).toBeNull();
  });
});
