// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { clearSession, markAuthExpired } from "@/lib/session";
import { useRestoredSession, type SessionLifecycle } from "@/app/session";
import { addFiles, readSurface, surfaceKey } from "@/features/attachments/draftStore";

// #5799: 올리던 첨부(메모리 트레이)는 열쇠에 사람이 없어서, 세션이 끝날 때 비우지 않으면 같은 페이지에서 다음 사람이 같은 대화를 열 때
// 앞 사람의 파일이 보인다. 로그아웃 길은 실제 엔진 시험(`signOutDrafts.browser.test.ts`)이 재고, 여기는 로그인 만료 길을 잠근다.

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  logout: vi.fn(async () => undefined),
  // 올리기는 끝나지 않는다: 트레이에 칩이 그대로 있는 동안을 잰다.
  createAttachmentUpload: vi.fn(() => new Promise(() => undefined)),
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
});

function Probe() {
  lifecycle = useRestoredSession();
  return null;
}

const WS = "00000000-0000-7000-8000-000000000001";
const LOGIN = {
  accessToken: "access",
  refreshToken: "refresh",
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  member: { id: "00000000-0000-7000-8000-0000000001ff", workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyeon" },
} as unknown as LoginResponse;

describe("올리던 첨부는 세션이 끝나면 비워진다 (#5799)", () => {
  it("로그인이 만료돼 로그인 화면으로 돌아갈 때 트레이가 빈다", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Probe));
    });
    await act(async () => {
      lifecycle?.signIn(LOGIN);
    });
    const key = surfaceKey(WS, "00000000-0000-7000-8000-000000000201");
    addFiles(key, { workspaceId: WS, channelId: "00000000-0000-7000-8000-000000000201" }, [
      { name: "앞 사람의 파일.log", size: 8, type: "text/plain" } as unknown as File,
    ]);
    expect(readSurface(key).drafts).toHaveLength(1); // 대조

    await act(async () => {
      markAuthExpired();
    });
    expect(readSurface(key).drafts).toHaveLength(0);
  });
});
