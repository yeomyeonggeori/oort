// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError, type WorkSession } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";

// =============================================================================
// #5279 B: 작업 세션 상세가 진행 내역(세션 스레드)을 못 읽었을 때. 옛 「진행 내역을 불러오지 못했습니다.」는 이유가 없었다. 이제 같은 한 줄이 원인(오프라인 /
// 서버에 닿지 못함 / 그 밖)을 말하고 다시 시도가 스레드를 다시 읽는다. 받아 둔 단계가 있으면 줄이 그 단계를 지우지 않는다(상자가 아니라 한 줄이다).
// 읽기 훅과 자식 표면(터미널·화면 관전)만 대역으로 바꾸고 화면은 진짜 `WorkSessionDetail`이다.
// =============================================================================

const q = vi.hoisted(() => ({
  events: { error: null as unknown, isPending: false, rows: [] as unknown[], refetch: vi.fn() },
}));

vi.mock("./useWorkSessions", () => ({
  useSessionEvents: () => ({
    events: q.events.rows,
    truncated: false,
    isPending: q.events.isPending,
    error: q.events.error,
    data: q.events.error === null ? { events: q.events.rows, truncated: false } : undefined,
    refetch: q.events.refetch,
  }),
  useSessionVerification: () => null,
}));
vi.mock("./signedWork", () => ({
  useHumanControlSigning: () => ({ signatureRequired: false, signed: false, recheck: () => undefined }),
  useResumeWorkSession: () => async () => {
    throw new Error("unused");
  },
}));
vi.mock("@/features/workstreams/useWorkstreams", () => ({ useSessionWorkstream: () => ({ data: undefined }) }));
vi.mock("./DisplayObserver", () => ({ DisplayObserver: () => null }));
vi.mock("./DisplayController", () => ({ ControlInvite: () => null, DisplayController: () => null }));
vi.mock("./ObserverTerminal", () => ({ ObserverTerminal: () => null, TerminalShortNotice: () => null }));
vi.mock("./TakeoverBlock", () => ({ TakeoverBlock: () => null }));

import { WorkSessionDetail } from "./WorkSessionDetail";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;
let onLine: MockInstance<() => boolean>;

const session = {
  id: "00000000-0000-7000-8000-0000000000a1",
  workspaceId: WS,
  channelId: "00000000-0000-7000-8000-000000000201",
  memberId: ME,
  hostId: "00000000-0000-7000-8000-000000000302",
  rootMessageId: "00000000-0000-7000-8000-0000000000b1",
  tool: "codex",
  label: "UI 검수",
  status: "running",
  observation: "open",
  observerGrantCount: 0,
  remoteAttachAvailable: false,
  remoteDisplayAvailable: false,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
} as unknown as WorkSession;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});
beforeEach(() => {
  q.events = { error: null, isPending: false, rows: [], refetch: vi.fn() };
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  onLine.mockRestore();
});

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const value = { workspaceId: WS, connStatus: "connected", session: { member: { id: ME } } } as unknown as SessionContextValue;
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionProvider, {
          value,
          children: createElement(LocaleProvider, {
            locale: ko,
            children: createElement(WorkSessionDetail, {
              session,
              hosts: [],
              directory: makeDirectory([]),
              channelName: "릴리스",
              liveEvents: [],
              controlFrames: [],
              live: true,
              nowMs: 1_800_000_060_000,
              wide: false,
              onWideChange: () => undefined,
              onBack: () => undefined,
              openingThread: false,
              onOpenThread: () => undefined,
              onResumed: () => undefined,
            }),
          }),
        })
      )
    );
  });
  return host;
}
const lineOf = (el: ParentNode) => el.querySelector<HTMLElement>('[data-testid="work-detail-error"]');

describe("작업 세션 상세: 진행 내역 읽기 실패의 이유 (#5279 B)", () => {
  const causes: [string, () => unknown, boolean, string][] = [
    ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
    ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
    ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
  ];

  it("원인마다 다른 이유를 한 줄로 말하고 다시 시도가 스레드를 다시 읽는다. 상태 코드는 없다", () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      q.events.error = failure();
      const refetch = vi.fn();
      q.events.refetch = refetch;
      const line = lineOf(mount());
      expect(line?.textContent, name).toContain(`진행 내역을 불러오지 못했어요. ${reason}`);
      expect(line?.textContent, name).not.toMatch(/\d{3}/);
      act(() => line?.querySelector("button")?.click());
      expect(refetch, name).toHaveBeenCalledTimes(1);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("읽기가 실패하지 않았으면 줄이 없다", () => {
    onLine.mockReturnValue(true);
    expect(lineOf(mount())).toBeNull();
  });
});
