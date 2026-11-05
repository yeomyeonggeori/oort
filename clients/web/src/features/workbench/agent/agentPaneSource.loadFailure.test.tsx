// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";

// =============================================================================
// #5279 B: 제품 원천(`useAgentPaneSource`)이 칸의 세션 스레드를 못 읽었을 때, 스레드 읽기가 던진 오류 객체가 칸의 상자까지 간다(원인 분류의 재료).
// `PaneError.test.tsx`가 상자의 문장을 재고, 여기는 **배선**을 잰다: 오류 객체를 버리면(`failure`를 안 넘기면) 이유가 늘 「문제가 생겼어요」가 된다.
// =============================================================================

const SESSION_ID = "00000000-0000-7000-8000-0000000000a1";
const PANE = "pane-1";
const read = vi.hoisted(() => ({ failure: null as unknown, calls: 0 }));

vi.mock("@/app/session", () => ({
  useSession: () => ({
    workspaceId: "00000000-0000-7000-8000-000000000001",
    session: { member: { id: "00000000-0000-7000-8000-000000000101" } },
    connStatus: "connected",
  }),
}));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/features/capabilities/useSurfaceProvided", () => ({ useSurfaceProvided: () => true }));
vi.mock("@/features/work/useWorkSessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/work/useWorkSessions")>();
  return {
    ...actual,
    useWorkSessions: () => ({ data: [{ id: SESSION_ID, channelId: "c", rootMessageId: "r", memberId: "m", hostId: "h", tool: "codex", label: "UI 검수", status: "running" }] }),
    useWorkHosts: () => ({ data: [] }),
    useWorkSessionRail: () => ({ liveEvents: [], controlFrames: [], uncovered: [] }),
    fetchSessionEvents: async () => {
      read.calls += 1;
      throw read.failure;
    },
  };
});
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return { ...actual, useDirectory: () => ({ directory: makeDirectory([]) }) };
});
vi.mock("./agentPanes", () => ({
  agentPaneStore: () => ({ unbind: () => undefined }),
  useAgentPaneBindings: () => ({ [PANE]: SESSION_ID }),
}));
vi.mock("@/features/work/signedWork", () => ({
  desktopSigner: () => null,
  useHumanControlSigning: () => ({ signatureRequired: false, signed: false, recheck: () => undefined }),
  usePermissionPreviewGate: () => null,
}));
vi.mock("@/lib/tauri", () => ({ isDesktop: () => false }));

import { useAgentPaneSource } from "./agentPaneSource";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;
let onLine: MockInstance<() => boolean>;

function Probe() {
  const source = useAgentPaneSource();
  return createElement("div", null, source.render(SESSION_ID, PANE));
}

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});
beforeEach(() => {
  read.calls = 0;
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      createElement(QueryClientProvider, {
        client,
        children: createElement(LocaleProvider, { locale: ko, children: createElement(Probe) }),
      })
    );
    await Promise.resolve();
  });
  return host;
}

describe("에이전트 칸 원천: 스레드 읽기 실패의 오류 객체가 칸의 상자까지 간다 (#5279 B)", () => {
  it("읽기가 던진 오류가 이유를 정한다: 서버에 닿지 못함 / 그 밖", async () => {
    for (const [name, failure, reason] of [
      ["서버에 닿지 못함", new NetworkError("unreachable", 15_000), "서버에 닿지 못했어요."],
      ["그 밖", new ApiError(500, "boom", "internal"), "문제가 생겼어요."],
    ] as [string, unknown, string][]) {
      onLine.mockReturnValue(true);
      read.failure = failure;
      const el = await mount();
      // 읽기가 던지고 쿼리가 오류로 접히는 틱을 act 안에서 흘려보낸다.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 60));
      });
      expect(el.querySelector('[data-testid="agent-pane-error"]'), name).not.toBeNull();
      expect(el.querySelector('[data-testid="load-failure-reason"]')?.textContent, name).toBe(reason);
      expect(read.calls, name).toBeGreaterThan(0);
      act(() => root?.unmount());
      host?.remove();
    }
  });
});
