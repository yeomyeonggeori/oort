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
// #5279 B: 채널 오른쪽 작업 세션 패널이 세션·호스트 목록을 못 읽었을 때. 옛 「세션 목록을 불러오지 못했습니다.」 / 「호스트 상태를 불러오지
// 못했습니다.」는 이유가 없었다. 같은 한 줄이 원인(오프라인 / 서버에 닿지 못함 / 그 밖)을 말하고, 낱말은 작업 콘솔과 한 목소리다(작업 세션 / 실행 위치).
// 읽기 훅만 대역으로 바꾸고 화면은 진짜 `WorkPanel`이다.
// =============================================================================

type QueryState = { data: unknown; error: unknown; isPending: boolean; dataUpdatedAt: number; refetch: () => unknown };
const q = vi.hoisted(() => ({
  sessions: {} as QueryState,
  hosts: {} as QueryState,
  /** 미리보기(`SessionPeek`)가 읽는 세션 스레드. 못 읽으면 오류 객체가 있다. */
  events: { error: null as unknown },
}));

vi.mock("./useWorkSessions", () => ({
  useWorkSessions: () => q.sessions,
  useWorkHosts: () => q.hosts,
  useWorkSessionRail: () => ({ uncovered: [], liveEvents: [], controlFrames: [] }),
  useSessionEvents: () => ({ events: [], truncated: false, isPending: false, error: q.events.error, data: undefined }),
  useSessionVerification: () => null,
}));
vi.mock("./signedWork", () => ({
  useHumanControlSigning: () => ({ signatureRequired: false, signed: false, recheck: () => undefined }),
  useResumeWorkSession: () => async () => {
    throw new Error("unused");
  },
}));
vi.mock("./WorkSessionDetail", () => ({ WorkSessionDetail: () => null }));
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({ groups: { channels: [], dms: [] }, data: [], error: null }),
    useDirectory: () => ({ directory: makeDirectory([]), data: [], error: null }),
  };
});

import { WorkPanel } from "./WorkPanel";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;
let onLine: MockInstance<() => boolean>;
const sessionsRefetch = vi.fn();
const hostsRefetch = vi.fn();

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});
beforeEach(() => {
  sessionsRefetch.mockReset();
  hostsRefetch.mockReset();
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  onLine.mockRestore();
});

const running = {
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

const failed = (error: unknown, refetch: () => unknown): QueryState => ({ data: undefined, error, isPending: false, dataUpdatedAt: 0, refetch });
const ready = (refetch: () => unknown): QueryState => ({ data: [], error: null, isPending: false, dataUpdatedAt: 1_800_000_000_000, refetch });

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const session = { workspaceId: WS, connStatus: "connected", session: { member: { id: ME } } } as unknown as SessionContextValue;
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          SessionProvider,
          { value: session },
          createElement(LocaleProvider, {
            locale: ko,
            children: createElement(WorkPanel, {
              channelId: null,
              scope: "all",
              onScopeChange: () => undefined,
              selectedId: null,
              onSelectedIdChange: () => undefined,
              openingThreadId: null,
              threadOpenError: null,
              onOpenThread: () => undefined,
              onClose: () => undefined,
            }),
          })
        )
      )
    );
  });
  return host;
}
const lineOf = (el: ParentNode) => el.querySelector<HTMLElement>('[data-testid="work-panel-error"]');

describe("작업 세션 패널: 목록 읽기 실패의 이유 (#5279 B)", () => {
  const causes: [string, () => unknown, boolean, string][] = [
    ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
    ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
    ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
  ];

  it("세션 목록을 못 읽으면 원인마다 다른 이유를 말하고 다시 시도가 실패한 쪽을 다시 읽는다. 상태 코드는 없다", () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      q.sessions = failed(failure(), sessionsRefetch);
      q.hosts = ready(hostsRefetch);
      const line = lineOf(mount());
      expect(line?.textContent, name).toContain(`작업 세션을 불러오지 못했어요. ${reason}`);
      expect(line?.textContent, name).not.toMatch(/\d{3}/);
      act(() => line?.querySelector("button")?.click());
      expect(sessionsRefetch, name).toHaveBeenCalledTimes(1);
      expect(hostsRefetch, name).not.toHaveBeenCalled();
      sessionsRefetch.mockReset();
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("호스트 목록만 못 읽으면 제목이 「실행 위치」를 말한다", () => {
    onLine.mockReturnValue(true);
    q.sessions = ready(sessionsRefetch);
    q.hosts = failed(new NetworkError("unreachable", 15_000), hostsRefetch);
    const line = lineOf(mount());
    expect(line?.textContent).toContain("실행 위치를 불러오지 못했어요. 서버에 닿지 못했어요.");
    expect(line?.textContent).not.toContain("작업 세션을 불러오지 못했어요");
    act(() => line?.querySelector("button")?.click());
    expect(hostsRefetch).toHaveBeenCalledTimes(1);
  });
});

describe("세션 미리보기의 진행 내역 읽기 실패 (#5279 B)", () => {
  it("행을 펼쳤을 때 스레드를 못 읽으면 원인을 말한다. 단추가 없는 줄이라 이유가 다음 행동까지 말한다", () => {
    for (const [name, failure, online, sentence] of [
      ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "진행 내역을 불러오지 못했어요. 서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요."],
      ["오프라인", () => new NetworkError("unreachable", 15_000), false, "진행 내역을 불러오지 못했어요. 오프라인이에요. 연결되면 다시 불러올 수 있어요."],
      ["그 밖", () => new ApiError(500, "boom", "internal"), true, "진행 내역을 불러오지 못했어요. 문제가 생겼어요. 다시 시도해 주세요."],
    ] as [string, () => unknown, boolean, string][]) {
      onLine.mockReturnValue(online);
      q.sessions = { ...ready(sessionsRefetch), data: [running] };
      q.hosts = ready(hostsRefetch);
      q.events.error = failure();
      const el = mount();
      act(() => el.querySelector<HTMLElement>('[data-testid="work-session-row"]')?.click());
      const line = el.querySelector('[data-testid="work-session-peek"] [role="alert"]');
      expect(line?.textContent, name).toBe(sentence);
      expect(line?.textContent, name).not.toMatch(/\d{3}/);
      act(() => root?.unmount());
      host?.remove();
    }
    q.events.error = null;
  });
});
