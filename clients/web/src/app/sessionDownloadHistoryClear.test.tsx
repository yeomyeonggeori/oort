// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { clearSession, markAuthExpired } from "@/lib/session";
import { useRestoredSession, type SessionLifecycle } from "@/app/session";

// #4587: 다운로드 기록은 「이 기기에서 이 사람이 받은 파일의 이름」이라 계정 경계에서 지워져야 한다.
// 지우는 함수가 있어도 **부르는 자리**가 빠지면 아무 일도 안 하므로 세션 훅 쪽을 따로 잠근다:
// 로그아웃과 로그인 만료(다른 사람이 같은 기기로 다시 로그인할 수 있다) 둘 다다.

const clearHistory = vi.hoisted(() => vi.fn());
vi.mock("@/features/downloads/downloadsStore", () => ({
  clearDownloadHistory: clearHistory,
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  logout: vi.fn(async () => undefined),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let lifecycle: SessionLifecycle | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  lifecycle = null;
  clearSession();
  clearHistory.mockClear();
});

function Probe() {
  lifecycle = useRestoredSession();
  return null;
}

async function mountProbe(): Promise<SessionLifecycle> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
  if (lifecycle === null) throw new Error("hook did not render");
  return lifecycle;
}

const LOGIN = {
  accessToken: "access",
  refreshToken: "refresh",
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  member: {
    id: "00000000-0000-7000-8000-0000000001ff",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "이도현",
    handle: "dohyun",
  },
} as unknown as LoginResponse;

describe("다운로드 기록은 계정 경계에서 지워진다 (#4587)", () => {
  it("로그아웃이 지운다. 로그인만으로는 지우지 않는다", async () => {
    const first = await mountProbe();
    await act(async () => {
      first.signIn(LOGIN);
    });
    expect(clearHistory).not.toHaveBeenCalled();

    await act(async () => {
      lifecycle?.signOut();
    });
    expect(clearHistory).toHaveBeenCalledTimes(1);
  });

  it("로그인이 만료돼 로그인 화면으로 돌아갈 때도 지운다", async () => {
    const first = await mountProbe();
    await act(async () => {
      first.signIn(LOGIN);
    });
    expect(clearHistory).not.toHaveBeenCalled();

    await act(async () => {
      markAuthExpired();
    });
    expect(clearHistory).toHaveBeenCalledTimes(1);
  });
});
