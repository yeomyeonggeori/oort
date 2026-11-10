// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type Approval,
  type SharedWorkSession,
  type WorkSessionACPFrame,
} from "@momo/core/lib/api";
import { approvalItem } from "@momo/core/features/inbox/model";
import { WORK_JOBS_COPY, WORK_FILTER_STORAGE_KEY } from "@momo/core/features/workbench/workJobs";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import type { RealtimeHandle } from "@/lib/realtime";
import { needsMeFrom } from "@/features/inbox/useNeedsMe";
import { CH_AGENT_LAB, CH_WORKBENCH, ME, WS, agentRow, runRow, sharedRow } from "../teamBoard/teamBoardFixtures";

// 「작업 · 내 작업」의 「응답 필요」 구간(#5640, ADR-0202 D1·D5, ADR-0188 D5)을 실제 컴포넌트·훅으로 잰다. 네트워크 경계만 바꾼다:
// 보드 읽기(`fetchWorkJobs`)는 #5639 계약을 흉내 내는 가짜 서버(주인이 `include=jobs`로 읽을 때만 내 맥 세션 `waiting`), 승인 원장
// (`fetchApprovals`)은 인박스 배지가 읽는 그 원장이다. 작업 원장·세션 진행(스레드) 읽기(`fetchWorkSessions`·`fetchMessages`)는
// 세워 두기만 한다: 이 화면이 세션마다 진행을 읽어 짐작하는 순간 붉어진다.

const api = vi.hoisted(() => ({
  fetchWorkJobs: vi.fn(),
  fetchSharedWorkSession: vi.fn(),
  fetchWorkSessions: vi.fn(),
  fetchMessages: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchRoster: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  ...api,
}));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
const net = vi.hoisted(() => ({ offline: false }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => net.offline }));
const shell = vi.hoisted(() => ({ desktop: false }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => shell.desktop,
}));
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/workspace/useWorkspace")>()),
  useChannels: () => ({
    groups: {
      channels: [
        { id: CH_AGENT_LAB, kind: "public", name: "agent-lab" },
        { id: CH_WORKBENCH, kind: "public", name: "workbench" },
      ],
      dms: [],
    },
    isLoading: false,
  }),
  useDirectory: () => ({ directory: makeDirectory([]), isLoading: false }),
}));

const { WorkJobsRoute } = await import("./WorkJobsRoute");

// 가상 인물만 쓴다.
const DOHYUN = { memberId: ME, displayName: "김도현" };
const SEOYEON = { memberId: "00000000-0000-7000-8000-000000000102", displayName: "이서연" };
const AGENT = { memberId: "00000000-0000-7000-8000-0000000000aa", displayName: "그록봇" };

type Handlers = Parameters<RealtimeHandle["subscribeWorkSession"]>[2];
const subscribed: Handlers[] = [];
const realtime = {
  subscribeWorkSession: vi.fn((_ws: string, _ch: string, handlers: Handlers) => {
    subscribed.push(handlers);
    return () => undefined;
  }),
} as unknown as RealtimeHandle;

let locale: AppLocale;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: DOHYUN.displayName, handle: "dohyun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const seen = { pathname: "", search: "" };
function Probe() {
  const location = useLocation();
  seen.pathname = location.pathname;
  seen.search = location.search;
  return null;
}

function mount(entry = "/work"): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <LocaleProvider locale={locale}>
      <QueryClientProvider client={client}>
        <SessionProvider value={sessionValue()}>
          <MemoryRouter initialEntries={[entry]}>
            <Probe />
            <Routes>
              <Route path="/work" element={<WorkJobsRoute />} />
              <Route path="/c/:id" element={<div data-testid="channel-page" />} />
              <Route path="/" element={<div data-testid="home" />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
}

// ---- 가짜 서버(#5639 계약) ---------------------------------------------------------------

/** 내 맥의 내 세션(호스트 세션). 원장 낱말은 `running`이다. */
const macSession = agentRow({
  sessionId: "00000000-0000-7000-8000-0000000000e1",
  owner: DOHYUN,
  label: "결제 웹훅 재시도 고치기",
  harness: "claude",
  status: "running",
  state: "running",
});
/** 같은 맥의 다른 세션: 대기 요청이 없다. */
const macQuiet = agentRow({
  sessionId: "00000000-0000-7000-8000-0000000000e2",
  owner: DOHYUN,
  label: "릴리스 노트 초안 쓰기",
  harness: "codex",
  status: "running",
  state: "running",
});
/** 남(이서연)의 로컬 공유 터미널: 그 기기의 입력 대기라 누구에게나 `waiting`이다. */
const othersTerminal = sharedRow({
  sessionId: "00000000-0000-7000-8000-0000000000e3",
  owner: SEOYEON,
  label: "검색 색인 다시 만들기",
  state: "waiting",
});

/** 서버 흉내: 주인(나)이 `include=jobs`로 읽을 때만, 대기 요청이 있는 실행 중 맥 세션이 `waiting`이다. */
function board(waitingIds: ReadonlySet<string>, extra: { mine?: SharedWorkSession[]; team?: SharedWorkSession[] } = {}) {
  const view = (item: SharedWorkSession): SharedWorkSession =>
    item.origin === "host" && item.state === "running" && waitingIds.has(item.sessionId)
      ? { ...item, state: "waiting" }
      : item;
  const mine = [macSession, macQuiet, ...(extra.mine ?? [])].map(view);
  const team = [macSession, macQuiet, othersTerminal, ...(extra.team ?? [])].map(view);
  api.fetchWorkJobs.mockImplementation(async (_ws: string, opts: { who: "mine" | "team" }) => ({
    sessions: opts.who === "mine" ? mine : team,
    nextCursor: null,
    mode: "jobs",
  }));
}

function approval(over: Partial<Approval>): Approval {
  return {
    id: "00000000-0000-7000-8000-0000000000f1",
    workspaceId: WS,
    runId: "00000000-0000-7000-8000-0000000000c1",
    channelId: CH_AGENT_LAB,
    requestedBy: AGENT.memberId,
    actionType: "tool_call",
    status: "pending",
    expiresAtMs: Date.now() + 30 * 60_000,
    ...over,
  };
}

const sectionKeys = () => screen.getAllByTestId("work-jobs-section").map((s) => s.dataset.section);
const rowsIn = (key: string) => {
  const section = screen.getAllByTestId("work-jobs-section").find((s) => s.dataset.section === key);
  return section ? within(section).getAllByTestId("work-job-row").map((r) => r.dataset.jobId) : [];
};

beforeEach(async () => {
  locale ??= await koreanLocaleForTest();
  for (const fn of Object.values(api)) fn.mockReset();
  subscribed.length = 0;
  api.fetchSharedWorkSession.mockRejectedValue(new ApiError(404, "shared work session not found"));
  api.fetchWorkSessions.mockResolvedValue([]);
  api.fetchMessages.mockResolvedValue({ messages: [] });
  api.fetchApprovals.mockResolvedValue([]);
  api.fetchRoster.mockResolvedValue([]);
  shell.desktop = false;
  net.offline = false;
  try {
    window.localStorage.removeItem(WORK_FILTER_STORAGE_KEY);
  } catch {
    // 저장소가 없으면 기억도 없다.
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  resetEscapeLayers();
});

describe("「응답 필요」 구간: 내 맥 세션은 서버가 준 것만 (#5640)", () => {
  it("서버가 `waiting`을 준 내 맥 세션이 맨 위 「응답 필요」에 서고, 구간 순서는 응답 필요 → 지금", async () => {
    board(new Set([macSession.sessionId]));
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(sectionKeys()).toEqual(["needsMe", "now"]);
    expect(rowsIn("needsMe")).toEqual([macSession.sessionId]);
    expect(rowsIn("now")).toEqual([macQuiet.sessionId]);
    const header = screen.getAllByTestId("work-jobs-section")[0]!.querySelector("h2")!;
    expect(header.textContent).toBe(`${WORK_JOBS_COPY.sectionNeedsMe} 1`);
    const row = screen.getAllByTestId("work-job-row")[0]!;
    expect(within(row).getByTestId("team-board-state").textContent).toBe("응답 필요");
    // 작업 원장·세션 진행은 읽지 않는다(세션마다 읽어 짐작하지 않는다).
    expect(api.fetchWorkSessions).not.toHaveBeenCalled();
    expect(api.fetchMessages).not.toHaveBeenCalled();
  });

  it("서버가 `waiting`을 주지 않으면(원장 낱말 `running`) 구간도 머리글도 없다", async () => {
    board(new Set());
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(sectionKeys()).toEqual(["now"]);
    expect(screen.queryByText(new RegExp(`^${WORK_JOBS_COPY.sectionNeedsMe}`))).toBeNull();
    expect(screen.queryByTestId("work-job-permission-hint")).toBeNull();
  });

  it("「팀 전체」에는 구간이 없다 — 내 맥 세션이 `waiting`이고 남의 터미널이 `waiting`이어도", async () => {
    board(new Set([macSession.sessionId]));
    render(mount("/work?who=team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(3));
    expect(sectionKeys()).toEqual(["now"]);
    expect(document.querySelector("[data-needs-me]")).toBeNull();
    expect(screen.queryByTestId("work-job-permission-hint")).toBeNull();
  });

  it("남의 로컬 터미널은 「내 작업」에 와도(옛 서버 흉내) 구간에 서지 않는다", async () => {
    board(new Set(), { mine: [othersTerminal] });
    render(mount());
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(3));
    expect(sectionKeys()).toEqual(["now"]);
  });
});

describe("「응답 필요」 구간: run 줄은 인박스 배지와 같은 원장·같은 판정 (#5640)", () => {
  // run 넷: R1 결정 대기(받은함에서 결정), R2 카드를 열어 결정(#5462), R3 원장 줄이 이미 끝난 상태(대기 목록에 섞여 온 옛 줄),
  // R4 보드 phase만 승인 대기(원장에 줄 없음 — 내가 결정할 승인이 아니다).
  const R = (n: number) => `00000000-0000-7000-8000-0000000000c${n}`;
  const runs = [1, 2, 3, 4].map((n) =>
    runRow({
      sessionId: R(n),
      runId: R(n),
      requestedBy: DOHYUN,
      owner: AGENT,
      label: `에이전트 작업 ${n}`,
      phase: n === 4 ? "awaiting_approval" : "running",
      trigger: "mention",
    })
  );
  const ledger = [
    approval({ id: "00000000-0000-7000-8000-0000000000f1", runId: R(1) }),
    approval({ id: "00000000-0000-7000-8000-0000000000f2", runId: R(2), actionType: "workspace_action", workspaceActionId: "expression.set.plan" }),
    approval({ id: "00000000-0000-7000-8000-0000000000f3", runId: R(3), status: "expired" }),
  ];

  it("같은 원장에서 배지가 세는 승인의 run과 구간에 선 run 줄이 같은 집합이다", async () => {
    board(new Set(), { mine: runs });
    api.fetchApprovals.mockResolvedValue(ledger);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe").length).toBeGreaterThan(0));
    // 배지(`needsMeFrom`)가 셀 승인 — 승인마다 따로 물어 배지 쪽 판정만으로 고른다.
    const badgeRuns = ledger
      .filter(
        (a) =>
          needsMeFrom({
            approvalItems: [approvalItem(a, { name: AGENT.displayName, isAgent: true }, "#agent-lab", Date.now())],
            paneEntries: [],
            unreadMentions: 0,
            desktop: false,
          }).approvals === 1
      )
      .map((a) => a.runId);
    expect(new Set(rowsIn("needsMe"))).toEqual(new Set(badgeRuns));
    expect(badgeRuns.sort()).toEqual([R(1), R(2)]);
    // 원장에 없는 「승인 필요」(보드 phase)는 「지금」 맨 위에 남는다.
    expect(rowsIn("now")[0]).toBe(R(4));
    // run 줄은 서랍을 열고, 카드로 가는 길은 줄 아래 링크다(승인 단추는 없다).
    const needsMeRows = within(screen.getAllByTestId("work-jobs-section")[0]!);
    expect(needsMeRows.getAllByTestId("work-job-approval-link")).toHaveLength(2);
  });

  it("연결이 끊겨도 같은 집합이다(배지는 끊김과 무관하게 센다)", async () => {
    net.offline = true;
    board(new Set(), { mine: runs });
    api.fetchApprovals.mockResolvedValue(ledger);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(2)]));
  });
});

describe("「응답 필요」 줄에서 승인 카드로 (#5640)", () => {
  it("데스크탑: Enter·클릭이 그 세션의 A 칸 주소로 간다(서랍을 열지 않는다)", async () => {
    shell.desktop = true;
    board(new Set([macSession.sessionId]));
    render(mount());
    const row = (await screen.findAllByTestId("work-job-row"))[0]!;
    expect(row.dataset.permission).toBe("");
    expect(row.hasAttribute("aria-expanded")).toBe(false);
    const hint = screen.getByTestId("work-job-permission-hint");
    expect(row.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.textContent).toBe(WORK_JOBS_COPY.permissionHint);
    fireEvent.click(row);
    await waitFor(() => expect(new URLSearchParams(seen.search).get("agent")).toBe(macSession.sessionId));
    expect(new URLSearchParams(seen.search).get("view")).toBe("terminals");
    expect(new URLSearchParams(seen.search).get("card")).toBeNull();
  });

  it("브라우저: 세션 화면으로 가고, 줄 아래 한 줄이 허락할 곳(폰·데스크탑 앱)을 말한다", async () => {
    board(new Set([macSession.sessionId]));
    render(mount());
    const row = (await screen.findAllByTestId("work-job-row"))[0]!;
    expect(row.dataset.permission).toBe("");
    expect(screen.getByTestId("work-job-permission-in-app").textContent).toBe(
      "허락은 폰이나 데스크탑 앱에서 보내 주세요"
    );
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.click(row);
    await waitFor(() => expect(new URLSearchParams(seen.search).get("session")).toBe(macSession.sessionId));
  });

  it("다른 줄(지금)은 그대로 서랍을 연다", async () => {
    board(new Set([macSession.sessionId]));
    render(mount());
    await screen.findAllByTestId("work-job-row");
    const quiet = screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === macQuiet.sessionId)!;
    expect(quiet.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(quiet);
    await waitFor(() => expect(new URLSearchParams(seen.search).get("card")).toBe(macQuiet.sessionId));
  });
});

describe("갱신: 권한 요청·결정이 실시간으로 오면 다시 읽는다 (#5640)", () => {
  const frame = (type: string, sessionId: string): WorkSessionACPFrame => ({
    type: type as WorkSessionACPFrame["type"],
    v: 1,
    ts: Date.now(),
    seq: 1,
    payload: {
      work_session_id: sessionId,
      run_id: "",
      channel_id: CH_AGENT_LAB,
      event_id: "e1",
      message_id: "m1",
      root_message_id: "r1",
    },
  });

  it("목록에 있는 세션의 `approval.requested`가 오면 다시 읽고 줄이 「응답 필요」로 옮긴다. 글 조각(`agent.partial`)과 목록 밖 세션은 읽지 않는다", async () => {
    board(new Set());
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(sectionKeys()).toEqual(["now"]);
    await waitFor(() => expect(subscribed.length).toBeGreaterThan(0));
    const before = api.fetchWorkJobs.mock.calls.length;
    act(() => {
      for (const h of subscribed) h.onAcpEvent(frame("agent.partial", macSession.sessionId));
      for (const h of subscribed) h.onAcpEvent(frame("approval.requested", "00000000-0000-7000-8000-0000000000ff"));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.fetchWorkJobs.mock.calls.length).toBe(before);
    board(new Set([macSession.sessionId]));
    act(() => {
      for (const h of subscribed) h.onAcpEvent(frame("approval.requested", macSession.sessionId.toUpperCase()));
    });
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([macSession.sessionId]));
    // 결정이 오면 다시 읽고 줄이 「지금」으로 돌아간다.
    board(new Set());
    act(() => {
      for (const h of subscribed) h.onAcpEvent(frame("approval.decided", macSession.sessionId));
    });
    await waitFor(() => expect(sectionKeys()).toEqual(["now"]));
  });

  it("줄이 「지금」에서 「응답 필요」로 옮겨도 그 줄의 캐럿을 잃지 않는다", async () => {
    board(new Set());
    render(mount());
    await screen.findAllByTestId("work-job-row");
    await waitFor(() => expect(subscribed.length).toBeGreaterThan(0));
    const before = screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === macSession.sessionId)!;
    before.focus();
    expect(document.activeElement).toBe(before);
    board(new Set([macSession.sessionId]));
    act(() => {
      for (const h of subscribed) h.onAcpEvent(frame("approval.requested", macSession.sessionId));
    });
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([macSession.sessionId]));
    const after = screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === macSession.sessionId)!;
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });
});
