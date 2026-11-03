// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadStates } from "./useWorkspace";

// =============================================================================
// #5196: 창을 치운 데스크탑 앱의 독 배지·메뉴 막대 점은 `useReadStates`의 30초 폴링에서만 새로 읽힌다(다른 길이 없다).
// 숨은 페이지는 interval을 멈추므로(앱 기본값이 포커스 복귀 재조회도 끈다) 데스크탑에서만 백그라운드 폴링을 켠다.
// 숨은 상태는 react-query의 포커스 관리자가 「안 보임」이라고 말하는 것으로 만든다(`visibilityState`와 같은 신호).
// =============================================================================

const hoisted = vi.hoisted(() => ({
  desktop: true,
  fetchReadStates: vi.fn(async (_workspaceId: string) => []),
}));

vi.mock("@/lib/tauri", () => ({ isDesktop: () => hoisted.desktop }));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchReadStates: (workspaceId: string) => hoisted.fetchReadStates(workspaceId),
}));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function Probe() {
  useReadStates("w");
  return null;
}

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  hoisted.fetchReadStates.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

/** 숨은 채로 마운트해서 31초를 흘린 뒤 읽음 상태를 몇 번 물었는가(마운트 때 한 번 + 30초 폴링). */
async function readsWhileHiddenFor31Seconds(desktop: boolean): Promise<number> {
  hoisted.desktop = desktop;
  focusManager.setFocused(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(31_000);
  });
  return hoisted.fetchReadStates.mock.calls.length;
}

describe("읽음 상태 폴링: 창이 숨은 동안 (#5196)", () => {
  it("데스크탑은 숨은 동안에도 30초마다 다시 읽는다 — 배지와 점이 낡지 않는다", async () => {
    expect(await readsWhileHiddenFor31Seconds(true)).toBe(2);
  });

  it("브라우저는 숨은 동안 멈춘다(기본 동작 그대로): 마운트 때 한 번뿐이다", async () => {
    expect(await readsWhileHiddenFor31Seconds(false)).toBe(1);
  });
});
