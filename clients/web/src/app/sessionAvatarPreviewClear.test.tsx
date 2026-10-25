// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { clearSession } from "@/lib/session";
import { useRestoredSession, type SessionLifecycle } from "@/app/session";

// #4394 보안 검수 H1: 사진 주인 본인에게만 읽히는 승인 카드 사진은 계정 경계(로그인·로그아웃)
// 에서 캐시가 비워져야 한다. 비우는 함수가 있어도 **부르는 자리**가 빠지면 아무 일도 안 하므로
// 세션 훅 쪽을 따로 잠근다.

const clearPreviews = vi.hoisted(() => vi.fn());
vi.mock("@/features/timeline/useApprovalAvatarPreview", () => ({
  clearApprovalAvatarPreviews: clearPreviews,
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
  clearPreviews.mockClear();
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

describe("승인 카드 사진 캐시는 계정 경계에서 비워진다 (#4394 H1)", () => {
  it("로그인(계정 교체)과 로그아웃이 각각 비운다", async () => {
    const first = await mountProbe();
    expect(clearPreviews).not.toHaveBeenCalled();

    await act(async () => {
      first.signIn(LOGIN);
    });
    expect(clearPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      lifecycle?.signOut();
    });
    expect(clearPreviews).toHaveBeenCalledTimes(2);
  });
});
