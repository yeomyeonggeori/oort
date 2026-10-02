// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SharedWorkSession } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import type { RealtimeHandle } from "@/lib/realtime";
import { CH_AGENT_LAB, CH_WORKBENCH, ME, WS, agentRow, sharedRow } from "./teamBoardFixtures";

// 보드의 몸을 실제 컴포넌트·훅으로 재는 시험 (#2863). 네트워크 경계(`@momo/core/lib/api`의 읽기
// 함수)만 바꾼다. 공유 읽기와 **작업 원장 읽기(`fetchWorkSessions`)를 따로 세워** 두는 이유:
// 보드가 원장에서 줄을 가져오는 순간(공유 안 한 세션이 보이는 사고) 이 시험이 빨개져야 한다.

const api = vi.hoisted(() => ({
  fetchSharedWorkSessions: vi.fn(),
  fetchSharedWorkSession: vi.fn(),
  fetchWorkSessions: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  ...api,
}));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
const offline = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => offline.value }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => ({
    groups: {
      channels: [
        { id: "00000000-0000-7000-8000-000000000201", kind: "public", name: "workbench" },
        { id: "00000000-0000-7000-8000-000000000202", kind: "public", name: "agent-lab" },
        { id: "00000000-0000-7000-8000-000000000203", kind: "public", name: "general" },
      ],
      dms: [],
    },
  }),
}));

const { TeamBoardRoute } = await import("./TeamBoardRoute");

type Handlers = {
  onShareChanged?: (frame: unknown) => void;
  onLifecycle: (frame: unknown) => void;
  onResync: () => void;
};
const subscriptions: { channelId: string; handlers: Handlers; stop: ReturnType<typeof vi.fn> }[] = [];
const realtime = {
  subscribeWorkSession: vi.fn((_ws: string, channelId: string, handlers: Handlers) => {
    const stop = vi.fn();
    subscriptions.push({ channelId, handlers, stop });
    return stop;
  }),
} as unknown as RealtimeHandle;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mount(entry = "/work?view=team"): { client: QueryClient; ui: ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={client}>
      <SessionProvider value={sessionValue()}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/work" element={<TeamBoardRoute />} />
            <Route path="/c/:id" element={<div data-testid="channel-page" />} />
            <Route path="/" element={<div data-testid="home" />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>
  );
  return { client, ui };
}

function board(rows: SharedWorkSession[], nextCursor: string | null = null) {
  api.fetchSharedWorkSessions.mockResolvedValue({ sessions: rows, nextCursor });
}

const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeEach(() => {
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  subscriptions.length = 0;
  offline.value = false;
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchSharedWorkSession.mockRejectedValue(new ApiError(404, "shared work session not found"));
  // 작업 원장에는 공유하지 않은 세션이 있다. 보드는 이것을 읽지 않는다.
  api.fetchWorkSessions.mockResolvedValue([
    { id: "ledger-private", label: "공유하지 않은 비밀 작업", channelId: CH_WORKBENCH, status: "running" },
  ]);
});

afterEach(() => {
  cleanup();
  resetEscapeLayers();
});

describe("팀 보드: 보는 사람 채널 멤버십 (#2863 Acceptance)", () => {
  it("서버가 준 줄만 그린다. 작업 원장의 공유하지 않은 세션은 화면에 없고 원장을 읽지도 않는다", async () => {
    board([sharedRow(), agentRow()]);
    const { ui } = mount();
    render(ui);
    await screen.findAllByTestId("team-board-row");
    expect(screen.getAllByTestId("team-board-row")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("공유하지 않은 비밀 작업");
    expect(api.fetchWorkSessions).not.toHaveBeenCalled();
    expect(api.fetchSharedWorkSessions).toHaveBeenCalledWith(WS, expect.objectContaining({ cursor: null }));
  });

  it("A 레인 세션도 같은 보드에 서고 레인 말이 다르다(#2779)", async () => {
    board([sharedRow(), agentRow()]);
    render(mount().ui);
    await screen.findAllByTestId("team-board-row");
    const lanes = screen.getAllByTestId("team-board-lane").map((el) => [el.dataset.lane, el.textContent]);
    expect(lanes).toContainEqual(["local", "로컬 · 공유됨"]);
    expect(lanes).toContainEqual(["agent", "에이전트 · 곽성재가 시킴"]);
    // 에이전트 줄은 저장소·브랜치·diff를 지어내지 않는다.
    const agent = document.querySelector('[data-origin="host"]')!;
    expect(agent.querySelector('[data-testid="team-board-diff"]')).toBeNull();
  });

  it("카드마다 소유자 묶음·저장소·브랜치·하네스·상태·diff·마지막 활동·집 채널이 있다", async () => {
    board([sharedRow()]);
    render(mount().ui);
    const row = await screen.findByTestId("team-board-row");
    const text = row.textContent ?? "";
    for (const part of ["한글 입력 이중 전송 수리", "momo", "feat/2774-xterm", "claude", "확인 기다림", "+128", "−40", "3분 전", "#workbench"]) {
      expect(text).toContain(part);
    }
    expect(screen.getByRole("heading", { name: /곽성재/ })).toBeTruthy();
  });

  it("열어 둔 줄이 공유 해제로 보이지 않게 되면(단건 404) 드로어가 닫히고 안내가 선다", async () => {
    const row = sharedRow();
    board([row]);
    const { client, ui } = mount();
    render(ui);
    api.fetchSharedWorkSession.mockResolvedValue(row);
    fireEvent.click(await screen.findByTestId("team-board-row"));
    await screen.findByTestId("team-board-drawer");
    // 서버가 이 줄을 더는 돌려주지 않는다: 목록에서 빠지고 단건은 404.
    board([]);
    api.fetchSharedWorkSession.mockRejectedValue(new ApiError(404, "shared work session not found"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["team-board", WS] });
    });
    await waitFor(() => expect(screen.queryByTestId("team-board-drawer")).toBeNull());
    expect(screen.queryAllByTestId("team-board-row")).toHaveLength(0);
    expect(screen.getByTestId("team-board-gone")).toBeTruthy();
  });
});

describe("팀 보드: 네 상태", () => {
  it("불러오는 중: 높이를 지키는 막대(skel)가 서고 줄은 없다", async () => {
    api.fetchSharedWorkSessions.mockReturnValue(new Promise(() => undefined));
    render(mount().ui);
    expect(document.querySelector(".skel")).not.toBeNull();
    expect(screen.queryAllByTestId("team-board-row")).toHaveLength(0);
  });

  it("비어 있음: 공유가 시작되는 방법을 말하되 없는 단추를 약속하지 않는다", async () => {
    board([]);
    render(mount().ui);
    const empty = await screen.findByTestId("team-board-empty");
    expect(empty.textContent).toContain("공유를 켠 세션이 여기에 보여요");
    expect(empty.textContent).not.toMatch(/공유 켜기|공유하기 단추|버튼/);
    fireEvent.click(screen.getByTestId("team-board-empty-action"));
    await screen.findByTestId("home");
  });

  it("오류: 무슨 일인지와 다음 행동을 말하고 다시 불러온다", async () => {
    api.fetchSharedWorkSessions.mockRejectedValueOnce(new ApiError(500, "boom"));
    board([sharedRow()]);
    render(mount().ui);
    const error = await screen.findByTestId("team-board-error");
    expect(error.textContent).toContain("팀 작업을 불러오지 못했어요");
    fireEvent.click(screen.getByTestId("team-board-retry"));
    await screen.findByTestId("team-board-row");
  });

  it("오프라인: 배너 한 줄이 서고 불러온 목록은 계속 그려진다", async () => {
    offline.value = true;
    board([sharedRow()]);
    render(mount().ui);
    await screen.findByTestId("team-board-row");
    expect(screen.getByTestId("team-board-offline").textContent).toContain("마지막으로 본 목록");
    expect(screen.getAllByTestId("team-board-row")).toHaveLength(1);
  });
});

describe("팀 보드: 실시간은 신호이고 읽기가 진실이다", () => {
  it("work.session.share_changed를 받으면 GET으로 다시 읽는다. 프레임 안의 값은 쓰지 않는다", async () => {
    board([sharedRow()]);
    render(mount().ui);
    await screen.findByTestId("team-board-row");
    const before = api.fetchSharedWorkSessions.mock.calls.length;
    // 내가 속한 채널을 모두 듣는다(아직 줄이 없는 채널의 새 공유도 들어야 한다).
    expect(new Set(subscriptions.map((s) => s.channelId))).toEqual(
      new Set([CH_WORKBENCH, CH_AGENT_LAB, "00000000-0000-7000-8000-000000000203"])
    );
    board([sharedRow(), agentRow()]);
    act(() => {
      subscriptions[0]!.handlers.onShareChanged?.({
        type: "work.session.share_changed",
        v: 1,
        ts: Date.now(),
        payload: { session_id: "x", channel_id: CH_AGENT_LAB, kind: "enabled", label: "프레임에 실린 이름은 쓰지 않는다" },
      });
    });
    await waitFor(() => expect(screen.getAllByTestId("team-board-row")).toHaveLength(2));
    expect(api.fetchSharedWorkSessions.mock.calls.length).toBeGreaterThan(before);
    expect(document.body.textContent).not.toContain("프레임에 실린 이름");
  });

  it("겹쳐 오는 신호는 한 번의 읽기로 합쳐진다(재구독이 채널 수만큼 동시에 끝나도)", async () => {
    board([sharedRow()]);
    render(mount().ui);
    await screen.findByTestId("team-board-row");
    const before = api.fetchSharedWorkSessions.mock.calls.length;
    act(() => {
      for (const s of subscriptions) s.handlers.onResync();
    });
    await waitFor(() => expect(api.fetchSharedWorkSessions.mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 300));
    expect(api.fetchSharedWorkSessions.mock.calls.length - before).toBe(1);
  });

  it("떠날 때 구독을 모두 푼다", async () => {
    board([sharedRow()]);
    const view = render(mount().ui);
    await screen.findByTestId("team-board-row");
    view.unmount();
    expect(subscriptions.length).toBeGreaterThan(0);
    for (const s of subscriptions) expect(s.stop).toHaveBeenCalled();
  });
});

describe("팀 보드: 키보드", () => {
  async function rows() {
    board([sharedRow(), agentRow(), sharedRow({ sessionId: "00000000-0000-7000-8000-0000000000a2", label: "relay 중복 발행 수리", state: "running" })]);
    render(mount().ui);
    await screen.findAllByTestId("team-board-row");
    return screen.getAllByTestId("team-board-row");
  }

  it("줄은 로빙 탭 정지 한 곳이다(첫 줄만 tabindex 0)", async () => {
    const list = await rows();
    expect(list.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("j/k와 화살표가 줄을 옮기고 Home/End가 처음·끝으로 간다", async () => {
    const list = await rows();
    // 묶음은 소유자 기준이다: 곽성재(a1, a2) 다음 에이전트 줄이 아니라 같은 소유자라 한 묶음이다.
    const order = screen.getAllByTestId("team-board-row");
    order[0]!.focus();
    fireEvent.keyDown(order[0]!, { key: "j" });
    expect(document.activeElement).toBe(order[1]);
    fireEvent.keyDown(order[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(order[2]);
    fireEvent.keyDown(order[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(order[2]);
    fireEvent.keyDown(order[2]!, { key: "k" });
    expect(document.activeElement).toBe(order[1]);
    fireEvent.keyDown(order[1]!, { key: "End" });
    expect(document.activeElement).toBe(order[2]);
    fireEvent.keyDown(order[2]!, { key: "Home" });
    expect(document.activeElement).toBe(list[0]);
    expect(order[0]!.getAttribute("tabindex")).toBe("0");
  });

  it("Enter가 드로어를 열고 Esc가 닫고 열었던 줄로 포커스가 돌아온다", async () => {
    const list = await rows();
    api.fetchSharedWorkSession.mockResolvedValue(sharedRow());
    const target = list[0]!;
    target.focus();
    fireEvent.keyDown(target, { key: "Enter" });
    fireEvent.click(target); // 브라우저는 단추에서 Enter를 click으로 바꾼다.
    const drawer = await screen.findByTestId("team-board-drawer");
    await waitFor(() => expect(document.activeElement).toBe(drawer));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("team-board-drawer")).toBeNull());
    expect(document.activeElement).toBe(screen.getAllByTestId("team-board-row")[0]);
  });
});
