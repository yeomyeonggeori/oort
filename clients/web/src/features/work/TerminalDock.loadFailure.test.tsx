// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError, type WorkSession } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";

// =============================================================================
// #5279 B: 채널 하단 터미널 도크가 작업 세션 목록을 못 읽었을 때. 옛 「작업 세션을 불러오지 못했습니다.」는 이유가 없었다. 이제 같은 한 줄이 원인
// (오프라인 / 서버에 닿지 못함 / 그 밖)마다 다른 이유를 말하고 상태 코드는 없다. 받아 둔 세션이 있으면 줄이 서지 않고 탭이 그대로 선다.
// =============================================================================

const query = vi.hoisted(() => ({
  state: {} as { data: unknown; isPending: boolean; isError: boolean; error: unknown },
  refetch: vi.fn(),
}));

vi.mock("./useWorkSessions", () => ({
  useWorkSessions: () => ({ ...query.state, refetch: query.refetch }),
  useWorkHosts: () => ({ data: [] }),
}));
vi.mock("./ObserverTerminal", () => ({
  ObserverTerminal: () => null,
  TerminalShortNotice: () => null,
}));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/app/session", () => ({
  useSession: () => ({ workspaceId: "00000000-0000-7000-8000-000000000001" }),
}));

import { TerminalDock } from "./TerminalDock";

const CHANNEL = "00000000-0000-7000-8000-000000000201";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;
let onLine: MockInstance<() => boolean>;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});
beforeEach(() => {
  query.refetch.mockReset();
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  onLine.mockRestore();
});

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(LocaleProvider, {
        locale: ko,
        children: createElement(MemoryRouter, null, createElement(TerminalDock, { channelId: CHANNEL, onClose: () => undefined })),
      })
    );
    await Promise.resolve();
  });
  return host;
}

function failing(error: unknown, data: unknown = undefined): void {
  query.state = { data, isPending: false, isError: true, error };
}
function remount(): void {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

describe("터미널 도크: 작업 세션 목록 읽기 실패의 이유 (#5279 B)", () => {
  const causes: [string, () => unknown, boolean, string][] = [
    ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요."],
    ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
    ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
  ];

  it("원인마다 다른 이유를 말하고 상태 코드는 없다. 다시 시도는 목록을 다시 읽는다", async () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      failing(failure());
      const el = await mount();
      const line = el.querySelector('[data-testid="terminal-dock-error"]');
      expect(line?.textContent, name).toContain(`작업 세션을 불러오지 못했어요. ${reason}`);
      expect(line?.textContent, name).not.toMatch(/\d{3}/);
      const retry = line?.querySelector("button");
      expect(retry?.textContent, name).toBe("다시 시도");
      act(() => retry?.click());
      expect(query.refetch, name).toHaveBeenCalledTimes(1);
      query.refetch.mockReset();
      remount();
    }
  });

  it("받아 둔 세션이 있으면 읽기가 실패해도 줄이 탭을 덮지 않는다", async () => {
    onLine.mockReturnValue(true);
    const session = {
      id: "00000000-0000-7000-8000-000000000a01",
      channelId: CHANNEL,
      label: "UI 검수",
      status: "running",
      memberId: "00000000-0000-7000-8000-000000000101",
      rootMessageId: "00000000-0000-7000-8000-000000000b01",
      hostId: "00000000-0000-7000-8000-000000000301",
      tool: "codex",
      updatedAtMs: 1_800_000_000_000,
    } as unknown as WorkSession;
    failing(new NetworkError("unreachable", 15_000), [session]);
    const el = await mount();
    expect(el.querySelector('[data-testid="terminal-dock-error"]')).toBeNull();
    expect(el.querySelectorAll('[data-testid="terminal-dock-tab"]')).toHaveLength(1);
  });
});
