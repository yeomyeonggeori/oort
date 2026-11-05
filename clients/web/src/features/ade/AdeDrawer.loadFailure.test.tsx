// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { AdeItem } from "@momo/core/features/work/adeControl";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";

// =============================================================================
// #5279 B: 작업 목록 서랍이 작업 세션 원장을 못 읽었을 때. 옛 「작업 세션 목록을 불러오지 못했습니다. 아래 목록에는 에이전트 턴만 있습니다.」는 이유가
// 없었다. 결과(에이전트 턴만 있다)는 정보라 제목이 그대로 말하고, 원인(오프라인 / 서버에 닿지 못함 / 그 밖)이 뒤에 붙는다. 아래 턴 카드는 그대로 선다.
// =============================================================================

const control = vi.hoisted(() => ({
  value: {} as {
    items: unknown[];
    nowMs: number;
    sessionsFailed: boolean;
    sessionsError: unknown;
    retrySessions: () => void;
  },
}));

vi.mock("./useAdeControl", () => ({ useAdeControl: () => control.value }));
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useDirectory: () => ({ directory: makeDirectory([]) }),
    useChannels: () => ({ groups: { channels: [], dms: [] } }),
  };
});

import { AdeDrawer } from "./AdeDrawer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;
let onLine: MockInstance<() => boolean>;
const retrySessions = vi.fn();

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});
beforeEach(() => {
  retrySessions.mockReset();
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  onLine.mockRestore();
});

const turn: AdeItem = {
  key: "run:agent-1",
  kind: "run",
  state: "working",
  durability: "unknown",
  channelId: "00000000-0000-7000-8000-000000000201",
  title: "김인턴",
  detail: "답을 쓰는 중",
  startedAtMs: 1_800_000_000_000,
  runId: "0199aa11-2222-7000-8000-0000000000b1",
  memberId: "00000000-0000-7000-8000-000000000301",
};

function mount(items: unknown[], error: unknown): HTMLElement {
  control.value = { items, nowMs: 1_800_000_060_000, sessionsFailed: true, sessionsError: error, retrySessions };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const session = { workspaceId: WS, connStatus: "connected", session: { member: { id: ME } } } as unknown as SessionContextValue;
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionProvider, { value: session }, createElement(LocaleProvider, { locale: ko, children: createElement(AdeDrawer) }))
      )
    );
  });
  return host;
}
const lineOf = (el: ParentNode) => el.querySelector('[data-testid="ade-sessions-error"]');

describe("작업 목록 서랍: 작업 세션 원장 읽기 실패의 이유 (#5279 B)", () => {
  const causes: [string, () => unknown, boolean, string][] = [
    ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요."],
    ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
    ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
  ];

  it("결과(에이전트 턴만 있다)와 원인을 함께 말하고, 아래 턴 카드는 그대로 서며, 다시 시도가 원장을 다시 읽는다", () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      const el = mount([turn], failure());
      const text = lineOf(el)?.textContent ?? "";
      expect(text, name).toContain(`작업 세션 목록을 불러오지 못해 아래 목록에는 에이전트 턴만 있어요. ${reason}`);
      expect(text, name).not.toMatch(/\d{3}/);
      // 받아 둔 턴 카드를 실패가 가리지 않는다.
      expect(el.querySelectorAll('[data-testid="ade-card-list"] li'), name).toHaveLength(1);
      const retry = lineOf(el)?.querySelector("button");
      expect(retry?.textContent, name).toBe("다시 시도");
      act(() => retry?.click());
      expect(retrySessions, name).toHaveBeenCalledTimes(1);
      retrySessions.mockReset();
      act(() => root?.unmount());
      host?.remove();
    }
  });
});
