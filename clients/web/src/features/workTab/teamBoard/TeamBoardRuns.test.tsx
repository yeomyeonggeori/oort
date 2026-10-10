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
import { RunReportSection } from "@/features/agentHub/RunReportSection";
import { TeamBoardDrawer } from "./TeamBoardDrawer";
import { ME, WS, runRow, sharedRow } from "./teamBoardFixtures";

const api = vi.hoisted(() => ({
  fetchSharedWorkSessions: vi.fn(),
  fetchSharedWorkSession: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  ...api,
}));
const tauri = vi.hoisted(() => ({ desktop: false, open: vi.fn(async () => true) }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => tauri.desktop,
  openExternalUrl: tauri.open,
}));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => ({
    groups: {
      channels: [{ id: "00000000-0000-7000-8000-000000000202", kind: "public", name: "agent-lab" }],
      dms: [],
    },
  }),
}));

const { TeamBoardRoute } = await import("./TeamBoardRoute");

type Handlers = { onRunUpdated?: (frame: unknown) => void; onResync: () => void };
const subscriptions: Handlers[] = [];
const realtime = {
  subscribeWorkSession: vi.fn((_ws: string, _ch: string, handlers: Handlers) => {
    subscriptions.push(handlers);
    return vi.fn();
  }),
} as unknown as RealtimeHandle;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "s" },
      realtimeWebSocketUrl: "wss://x.test/connection/websocket",
    },
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mount(entry = "/work?view=team"): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SessionProvider value={sessionValue()}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/work" element={<TeamBoardRoute />} />
            <Route path="/c/:id" element={<div />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>
  );
}

const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
// 자정 직후(00:00~00:10)에는 `Date.now() - 10분` 이 어제가 되어 「오늘 끝난」 줄이 사라진다 — 제품의
// `startOfLocalDay` 는 옳고 시험의 시계가 흔들렸다. 시계는 흐르게 두되 오늘의 로컬 정오로 옮긴다.
const realNow = Date.now.bind(Date);
function noonShiftedNow(): () => number {
  const noon = new Date(realNow());
  noon.setHours(12, 0, 0, 0);
  const shift = noon.getTime() - realNow();
  return () => realNow() + shift;
}
beforeEach(() => {
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(Date, "now").mockImplementation(noonShiftedNow());
  subscriptions.length = 0;
  tauri.desktop = false;
  tauri.open.mockClear();
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchSharedWorkSession.mockRejectedValue(new ApiError(404, "nope"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanup();
  resetEscapeLayers();
});

function board(rows: SharedWorkSession[]) {
  api.fetchSharedWorkSessions.mockResolvedValue({ sessions: rows, nextCursor: null });
}

describe("팀 보드: 에이전트 작업 줄 (#3518)", () => {
  it("include=runs로 읽고, 실행 줄은 시킨 사람 밑에 상태·단계·PR 링크·시킨 사람 말로 선다", async () => {
    board([runRow({ state: "done", status: "done", prUrl: "https://github.com/acme/oort/pull/12" })]);
    render(mount());
    fireEvent.click(await screen.findByTestId("team-board-view-done"));
    await screen.findByTestId("team-board-row");
    expect(api.fetchSharedWorkSessions).toHaveBeenCalledWith(WS, expect.objectContaining({ include: "runs" }));
    const row = screen.getByTestId("team-board-row");
    expect(row.dataset.source).toBe("run");
    expect(screen.getByTestId("team-board-lane").textContent).toBe("에이전트 · 곽성재가 시킴");
    expect(screen.getByTestId("team-board-state").textContent).toContain("끝남 · PR");
    expect(screen.getByTestId("team-board-stage").textContent).toBe("문구 고치는 중");
    const link = screen.getByTestId("team-board-row-pr") as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/acme/oort/pull/12");
    expect(screen.getByTestId("team-board-group").textContent).toContain("곽성재");
  });

  it("실행 줄을 열어도 단건(세션 전용) 읽기를 하지 않고, 상세에 단계·결과가 선다", async () => {
    const run = runRow({ state: "done", status: "done", prUrl: "https://github.com/acme/oort/pull/12" });
    board([run]);
    render(mount());
    fireEvent.click(await screen.findByTestId("team-board-view-done"));
    fireEvent.click(await screen.findByTestId("team-board-row"));
    const drawer = await screen.findByTestId("team-board-drawer");
    expect(drawer.dataset.source).toBe("run");
    expect(api.fetchSharedWorkSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("team-board-stages").textContent).toContain("코드 읽는 중");
    expect(screen.getByTestId("team-board-pr").getAttribute("href")).toBe("https://github.com/acme/oort/pull/12");
    expect(screen.getByTestId("team-board-log").textContent).toContain("커밋 2개");
    expect(screen.getByTestId("team-board-terminal-note").textContent).not.toContain("주인의 기기");
  });

  it("work.run.updated 신호가 오면 보드를 다시 읽는다", async () => {
    board([runRow()]);
    render(mount());
    await screen.findByTestId("team-board-row");
    const before = api.fetchSharedWorkSessions.mock.calls.length;
    expect(subscriptions.length).toBeGreaterThan(0);
    act(() => {
      subscriptions[0]!.onRunUpdated?.({ type: "work.run.updated", payload: { run_id: "x", channel_id: "y", to: "done" } });
    });
    await waitFor(() => expect(api.fetchSharedWorkSessions.mock.calls.length).toBeGreaterThan(before));
  });
});

const XSS_STAGE = "[x](javascript:alert(1))";
const IMG_STAGE = "<img src=x onerror=alert(1)>";
const HOSTILE_BRANCH = "<b>evil</b>[b](https://evil.test)";
const HOSTILE_LABEL = "[label](javascript:alert(2)) <script>1</script>";

function expectInert(root: ParentNode) {
  expect(root.querySelector("img")).toBeNull();
  expect(root.querySelector("script")).toBeNull();
  expect(root.querySelector("b")).toBeNull();
  expect(root.querySelector('a[href^="javascript"]')).toBeNull();
  expect(root.querySelector('a[href*="evil.test"]')).toBeNull();
  const text = root.textContent ?? "";
  expect(text).toContain(XSS_STAGE);
  expect(text).toContain(IMG_STAGE);
}

describe("보안: 에이전트·요청자 문자열은 일반 텍스트로만 그린다 (#3518)", () => {
  const hostile = () =>
    runRow({
      label: HOSTILE_LABEL,
      branch: HOSTILE_BRANCH,
      stages: [XSS_STAGE, IMG_STAGE],
      prUrl: "javascript:alert(3)",
    });

  it("드로어: 단계·브랜치·이름이 글자 그대로이고 javascript: 링크가 없다", () => {
    const view = render(
      <MemoryRouter>
        <TeamBoardDrawer item={hostile()} nowMs={Date.now()} onClose={() => undefined} />
      </MemoryRouter>
    );
    expectInert(view.container);
    expect(view.container.textContent).toContain(HOSTILE_BRANCH);
    expect(view.container.textContent).toContain(HOSTILE_LABEL);
    expect(view.container.querySelector('[data-testid="team-board-pr"]')).toBeNull();
  });

  it("보드 줄: 단계·이름이 글자 그대로다", async () => {
    board([hostile()]);
    const view = render(mount());
    await screen.findByTestId("team-board-row");
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.getByTestId("team-board-row").textContent).toContain(HOSTILE_LABEL);
    expect(screen.getByTestId("team-board-stage").textContent).toBe(IMG_STAGE);
  });

  it("작업 상세 보고 구역: 단계·브랜치가 글자 그대로이고 잘못된 PR 주소는 링크가 아니다", () => {
    const view = render(
      <RunReportSection
        output={{
          stages: [XSS_STAGE, IMG_STAGE],
          artifacts: { prUrl: "javascript:alert(3)", branch: HOSTILE_BRANCH, added: 1, deleted: 2, commits: 1 },
        }}
      />
    );
    expectInert(view.container);
    expect(view.container.querySelector('[data-testid="run-report-branch"]')?.textContent).toBe(HOSTILE_BRANCH);
    expect(view.container.querySelector('[data-testid="run-report-pr"]')).toBeNull();
  });

  it("보고가 없으면 아무것도 그리지 않는다", () => {
    const view = render(<RunReportSection output={undefined} />);
    expect(view.container.innerHTML).toBe("");
    void sharedRow;
  });
});

const PR = "https://github.com/acme/oort/pull/12";

describe("데스크탑 셸: target=_blank가 죽은 컨트롤이라 OS 브라우저로 넘긴다 (#3518)", () => {
  function clickAndCheck(link: HTMLElement, desktop: boolean) {
    tauri.desktop = desktop;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    if (desktop) {
      expect(event.defaultPrevented).toBe(true);
      expect(tauri.open).toHaveBeenCalledTimes(1);
      expect(tauri.open).toHaveBeenCalledWith(PR);
    } else {
      expect(event.defaultPrevented).toBe(false);
      expect(tauri.open).not.toHaveBeenCalled();
    }
  }

  it.each([true, false])("드로어 PR 링크 (desktop=%s)", (desktop) => {
    const view = render(
      <MemoryRouter>
        <TeamBoardDrawer item={runRow({ state: "done", prUrl: PR })} nowMs={Date.now()} onClose={() => undefined} />
      </MemoryRouter>
    );
    clickAndCheck(view.getByTestId("team-board-pr"), desktop);
  });

  it.each([true, false])("작업 상세 PR 링크 (desktop=%s)", (desktop) => {
    const view = render(<RunReportSection output={{ artifacts: { prUrl: PR } }} />);
    clickAndCheck(view.getByTestId("run-report-pr"), desktop);
  });

  it.each([true, false])("보드 카드 PR 링크 (desktop=%s)", async (desktop) => {
    board([runRow({ state: "done", status: "done", prUrl: PR })]);
    render(mount());
    fireEvent.click(await screen.findByTestId("team-board-view-done"));
    clickAndCheck(await screen.findByTestId("team-board-row-pr"), desktop);
  });
});

describe("실시간 재읽기: 신호가 끊임없이 와도 굶지 않는다 (#3518)", () => {
  it("0.1초 간격 신호가 2.5초 계속돼도 최대 대기(2초) 안에 한 번은 읽는다", async () => {
    board([runRow()]);
    render(mount());
    await screen.findByTestId("team-board-row");
    const before = api.fetchSharedWorkSessions.mock.calls.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (let i = 0; i < 25; i++) {
      act(() => {
        subscriptions[0]!.onRunUpdated?.({ type: "work.run.updated", payload: { run_id: "x", channel_id: "y" } });
      });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(api.fetchSharedWorkSessions.mock.calls.length).toBeGreaterThan(before);
  });
});
