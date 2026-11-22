// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { clearSession, markAuthExpired } from "@/lib/session";
import { useRestoredSession, type SessionLifecycle } from "@/app/session";
import { readDraft, writeDraft } from "@/features/chat/draftStore";

// #5799: 토큰 만료로 나가면 초안은 같은 사람이 이어 쓰게 남고, 다른 사람이 들어오면 지워진다. 실제 엔진 시험은 새로 고침 뒤의 만료를
// 재고, 여기는 새로 고침 없이 만료되는 길을 잠근다 — 만료 뒤의 마지막 저장도 그 사람의 것으로 적혀야 같은 사람이 이어 쓴다.

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
beforeEach(() => {
  localStorage.clear();
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
const CH = "00000000-0000-7000-8000-000000000201";
const person = (id: string, handle: string, displayName: string) =>
  ({
    accessToken: "access",
    refreshToken: "refresh",
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    member: { id, workspaceId: WS, kind: "human", displayName, handle },
  }) as unknown as LoginResponse;
const DOHYEON = person("019f94e3-7a10-79cd-9dee-208f47edd9a8", "dohyeon", "김도현");
const SEOYEON = person("019f94e3-7a10-79cd-9dee-208f47edd9b9", "seoyeon", "이서연");

async function signIn(who: LoginResponse): Promise<void> {
  await act(async () => {
    lifecycle?.signIn(who);
  });
}

async function expire(): Promise<void> {
  await act(async () => {
    markAuthExpired();
  });
}

describe("만료 뒤의 초안은 같은 사람에게만 (#5799)", () => {
  it("만료 뒤에 남긴 마지막 글은 같은 사람이 이어 쓰고, 다른 사람이 들어오면 지워진다", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Probe));
    });
    await signIn(DOHYEON);
    writeDraft(WS, CH, "쓰던 글");
    await expire();
    expect(lifecycle?.status).toBe("anonymous"); // 대조: 만료로 나갔다
    writeDraft(WS, CH, "만료 뒤에 남긴 마지막 글"); // 내려가는 입력창의 마지막 저장

    await signIn(DOHYEON);
    expect(readDraft(WS, CH)).toBe("만료 뒤에 남긴 마지막 글");

    await expire();
    await signIn(SEOYEON);
    expect(readDraft(WS, CH)).toBe("");
    expect(Object.values(localStorage).some((value) => value.includes("마지막 글"))).toBe(false);
  });
});
