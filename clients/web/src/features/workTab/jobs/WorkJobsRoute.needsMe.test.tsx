// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Approval, type SharedWorkSession } from "@momo/core/lib/api";
import type { WorkSessionACPFrame } from "@momo/core/lib/realtimeEvents";
import { approvalItem } from "@momo/core/features/inbox/model";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { WORK_JOBS_COPY, WORK_FILTER_STORAGE_KEY } from "@momo/core/features/workbench/workJobs";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import type { RealtimeHandle } from "@/lib/realtime";
import { needsMeFrom } from "@/features/inbox/useNeedsMe";
import { approvalRowControl, awaitedApprovalId } from "@/features/inbox/approvalsPanel";
import { resetRunProgress, startRunProgress } from "@/features/agents/agentRunProgressStore";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { CH_AGENT_LAB, CH_WORKBENCH, ME, WS, agentRow, runRow, sharedRow } from "../teamBoard/teamBoardFixtures";

// 「작업 · 내 작업」의 「응답 필요」 구간(#5640, ADR-0202 D1·D5, ADR-0188 D5)을 실제 컴포넌트·훅으로 잰다. 네트워크 경계만 바꾼다:
// 보드 읽기(`fetchWorkJobs`)는 #5639 계약을 흉내 내는 가짜 서버(주인이 `include=jobs`로 읽을 때만 내 맥 세션 `waiting`), 승인 원장
// (`fetchApprovals`)은 인박스 배지가 읽는 그 원장이다. 작업 원장·세션 진행(스레드) 읽기(`fetchWorkSessions`·`fetchMessages`)는
// 세워 두기만 한다: 이 화면이 세션마다 진행을 읽어 짐작하는 순간 붉어진다.

const api = vi.hoisted(() => ({
  authedResponse: vi.fn(),
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

// 앱의 쿼리 기본값(`app/queryClient.ts`: 신선 시간 30초)과 같게 둔다 — 다시 들어올 때 다시 읽는지가 그 값에 달려 있다.
function mount(entry = "/work"): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  return (
    <LocaleProvider locale={locale}>
      <QueryClientProvider client={client}>
        <SessionProvider value={sessionValue()}>
          <MemoryRouter initialEntries={[entry]}>
            <Probe />
            <Routes>
              <Route path="/work" element={<WorkJobsRoute />} />
              <Route
                path="/c/:id"
                element={
                  <div data-testid="channel-page">
                    <Link to="/work" data-testid="back-to-work">
                      작업
                    </Link>
                  </div>
                }
              />
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
  resetRunProgress();
  resetSettledApprovalsForTest();
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
    expect(screen.queryByTestId("work-job-permission-tag")).toBeNull();
  });

  it("「팀 전체」에는 구간이 없다 — 내 맥 세션이 `waiting`이고 남의 터미널이 `waiting`이어도", async () => {
    board(new Set([macSession.sessionId]));
    render(mount("/work?who=team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(3));
    expect(sectionKeys()).toEqual(["now"]);
    expect(document.querySelector("[data-needs-me]")).toBeNull();
    expect(screen.queryByTestId("work-job-permission-tag")).toBeNull();
    expect(screen.queryByTestId("work-job-permission-open")).toBeNull();
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
    // 결과 칸이 종류를 말한다: 「권한 요청」. 목록이 요청 내용(도구·미리보기)을 싣지 않으니 내용 없이 허락 단추를 세우지 않고,
    // 「열어서 답하기」 하나가 줄의 Enter와 같은 길로 간다(데스크탑 앱만).
    expect(within(row).getAllByTestId("work-job-permission-tag")[0]!.textContent).toBe("권한 요청");
    expect(screen.queryByTestId("work-job-permission-in-app")).toBeNull();
    expect(screen.queryByTestId("work-job-approval-approve")).toBeNull();
    const open = screen.getByTestId("work-job-permission-open");
    expect(open.textContent).toBe("열어서 답하기");
    expect(row.contains(open)).toBe(false);
    fireEvent.click(open);
    await waitFor(() => expect(new URLSearchParams(seen.search).get("agent")).toBe(macSession.sessionId));
    expect(new URLSearchParams(seen.search).get("view")).toBe("terminals");
    expect(new URLSearchParams(seen.search).get("card")).toBeNull();
  });

  it("데스크탑: 줄의 Enter·클릭도 같은 A 칸 주소로 간다", async () => {
    shell.desktop = true;
    board(new Set([macSession.sessionId]));
    render(mount());
    const row = (await screen.findAllByTestId("work-job-row"))[0]!;
    fireEvent.click(row);
    await waitFor(() => expect(new URLSearchParams(seen.search).get("agent")).toBe(macSession.sessionId));
  });

  it("브라우저: 세션 화면으로 가고, 줄 아래 한 줄이 허락할 곳(폰·데스크탑 앱)을 말한다", async () => {
    board(new Set([macSession.sessionId]));
    render(mount());
    const row = (await screen.findAllByTestId("work-job-row"))[0]!;
    expect(row.dataset.permission).toBe("");
    // 결과 칸 안(줄 단추 안)에서 허락할 곳을 말한다. 좁은 폭용 같은 글이 첫 열에도 있어 둘이다.
    const lines = within(row).getAllByTestId("work-job-permission-in-app");
    expect(lines.map((l) => l.textContent)).toEqual([
      "허락은 폰이나 데스크탑 앱에서 보내 주세요",
      "허락은 폰이나 데스크탑 앱에서 보내 주세요",
    ]);
    // 브라우저는 허락을 보낼 수 없으니 「열어서 답하기」 단추도 없다(안내만).
    expect(screen.queryByTestId("work-job-permission-open")).toBeNull();
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

describe("다른 화면에서 답하고 돌아오면 다시 읽는다 (#5640)", () => {
  it("「작업」을 떠난 동안 온 결정은 실시간이 듣지 못한다 — 돌아오면 30초 안이어도 목록을 다시 읽어 줄이 「지금」으로 간다", async () => {
    const run = runRow({
      sessionId: "00000000-0000-7000-8000-0000000000c1",
      runId: "00000000-0000-7000-8000-0000000000c1",
      requestedBy: DOHYUN,
      owner: AGENT,
      label: "#launch 채널에 공지 올리기",
      phase: "awaiting_approval",
      trigger: "mention",
    });
    board(new Set([macSession.sessionId]), { mine: [run] });
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([macSession.sessionId]));
    // 카드가 있는 채널로 떠난다(데스크탑의 A 칸도 같다: 「작업」 화면이 내려간다).
    fireEvent.click(screen.getByTestId("work-job-approval-link"));
    await screen.findByTestId("channel-page");
    const reads = api.fetchWorkJobs.mock.calls.length;
    // 그동안 답했다: 서버는 이제 `running`을 준다.
    board(new Set(), { mine: [run] });
    fireEvent.click(screen.getByTestId("back-to-work"));
    await waitFor(() => expect(api.fetchWorkJobs.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(sectionKeys()).toEqual(["now"]));
  });
});

// ---- 그 자리 결정 (#5640 수리 1회차, ADR-0202 증보 2026-11-11) ---------------------------------------------

function httpResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text,
    json: () => JSON.parse(text) as unknown,
    jsonOrNull: () => JSON.parse(text) as unknown,
  };
}

const decisionCalls = () =>
  api.authedResponse.mock.calls.filter(([path]) => String(path).endsWith("/decision"));

describe("결과 칸의 그 자리 결정: 인박스와 같은 판정·같은 부품·같은 라우트 (#5640)", () => {
  const R = (n: number) => `00000000-0000-7000-8000-0000000000c${n}`;
  const A = (n: number) => `00000000-0000-7000-8000-0000000000f${n}`;
  const run = (n: number, phase: string, requestedBy = DOHYUN) =>
    runRow({
      sessionId: R(n),
      runId: R(n),
      requestedBy,
      owner: AGENT,
      label: `에이전트 작업 ${n}`,
      phase,
      trigger: "mention",
    });
  // R1 받은함에서 결정(tool_call) · R2 카드를 열어 결정(#5462) · R3 원장 줄이 이미 끝남 · R4 보드 phase만 승인 대기(원장에 없음).
  const runs = [run(1, "running"), run(2, "running"), run(3, "running"), run(4, "awaiting_approval")];
  const ledger = [
    approval({ id: A(1), runId: R(1) }),
    approval({ id: A(2), runId: R(2), actionType: "workspace_action", workspaceActionId: "expression.set.plan" }),
    approval({ id: A(3), runId: R(3), status: "expired" }),
  ];
  const jobOf = (runId: string) =>
    screen.getAllByTestId("work-job").find((li) => li.querySelector<HTMLElement>('[data-testid="work-job-row"]')!.dataset.jobId === runId)!;

  it("단추가 선 줄의 집합 = 인박스에서 내가 결정할 수 있는 승인의 집합(승인·거부 또는 「열기」)", async () => {
    board(new Set(), { mine: runs });
    api.fetchApprovals.mockResolvedValue(ledger);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(2)]));
    // 인박스의 판정 그대로: 행마다 `approvalRowControl`이 id를 실은 컨트롤(`decide`·`open`)을 준 승인의 run.
    const inbox = ledger
      .map((a) => approvalItem(a, { name: AGENT.displayName, isAgent: true }, "#agent-lab", Date.now()))
      .filter((item) => awaitedApprovalId(approvalRowControl(item, { offline: false })) !== null)
      .map((item) => item.runId);
    const withControls = screen
      .getAllByTestId("work-job")
      .filter((li) => li.querySelector('[data-testid="work-job-approval-approve"], [data-testid="work-job-approval-open"]'))
      .map((li) => li.querySelector<HTMLElement>('[data-testid="work-job-row"]')!.dataset.jobId);
    expect(new Set(withControls)).toEqual(new Set(inbox));
    expect(withControls.length).toBe(2);
    // R1: 승인·거부(받은함과 같은 부품). 줄 단추 밖에 선다(단추 안에 단추 없음).
    const r1 = jobOf(R(1));
    const r1Row = within(r1).getByTestId("work-job-row");
    expect(within(r1Row).getAllByTestId("work-job-approval-tag")[0]!.textContent).toBe("승인 요청");
    const approve = within(r1).getByTestId("work-job-approval-approve");
    expect(r1Row.contains(approve)).toBe(false);
    expect(within(r1).getByTestId("work-job-approval-reject")).toBeTruthy();
    // R2: 카드를 열어 결정하는 승인 — 승인·거부 없이 「열기」 하나.
    const r2 = jobOf(R(2));
    expect(within(r2).queryByTestId("work-job-approval-approve")).toBeNull();
    expect(within(r2).getByTestId("work-job-approval-open").textContent).toBe("열기");
    // R4: 결정이 내 몫이 아니다 — 단추 없이 대기 줄(카드와 같은 문장)과 카드 링크만.
    const r4 = jobOf(R(4));
    expect(within(r4).queryByTestId("work-job-approval-approve")).toBeNull();
    expect(within(r4).getAllByTestId("work-job-approval-waiting")[0]!.textContent).toBe("관리자의 승인을 기다려요");
    expect(within(r4).getByTestId("work-job-approval-link")).toBeTruthy();
  });

  it("서버가 보는 사람에게 「못 한다」고 한 승인(run 진행 `canDecide: false`)은 단추가 없고 「응답 필요」에 서지 않는다 — 카드와 같은 규칙", async () => {
    const refused = run(5, "awaiting_approval");
    board(new Set(), { mine: [refused] });
    api.fetchApprovals.mockResolvedValue([
      approval({ id: A(5), runId: R(5), actionType: "workspace_action", workspaceActionId: "message.pin" }),
    ]);
    const progress = {
      id: R(5),
      channelId: CH_AGENT_LAB,
      agentMemberId: AGENT.memberId,
      status: "running",
      phase: "awaiting_approval",
      leaseState: "live",
      stepCount: 0,
      ahead: [],
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      bundle: {
        approvalId: A(5),
        status: "pending",
        decisionMode: "inline",
        canDecide: false,
        actionType: "workspace_action",
        intent: "#launch 채널의 공지를 고정해도 될까요?",
      },
    } as AgentRunProgress;
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_AGENT_LAB],
      realtime: null,
      fetchProgress: async () => [progress],
    });
    try {
      render(mount());
      await waitFor(() =>
        expect(screen.getAllByTestId("work-job-approval-summary")[0]!.textContent).toBe("#launch 채널의 공지를 고정해도 될까요?")
      );
      expect(sectionKeys()).toEqual(["now"]);
      expect(screen.queryByTestId("work-job-approval-approve")).toBeNull();
      expect(screen.queryByTestId("work-job-approval-open")).toBeNull();
      expect(screen.getByTestId("work-job-approval-link")).toBeTruthy();
    } finally {
      stop();
    }
  });

  it("「팀 전체」와 남의 줄에는 단추가 없다 — 원장에 내가 결정할 승인이 있어도(대신 승인 없음)", async () => {
    const mineWaiting = run(6, "awaiting_approval");
    const othersWaiting = run(7, "awaiting_approval", SEOYEON);
    board(new Set(), { team: [mineWaiting, othersWaiting] });
    api.fetchApprovals.mockResolvedValue([
      approval({ id: A(6), runId: R(6) }),
      approval({ id: A(7), runId: R(7) }),
    ]);
    render(mount("/work?who=team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-approval-link")).toHaveLength(2));
    expect(screen.queryByTestId("work-job-approval-approve")).toBeNull();
    expect(screen.queryByTestId("work-job-approval-reject")).toBeNull();
    expect(screen.queryByTestId("work-job-approval-open")).toBeNull();
    // 내가 결정할 수 있는 승인에 「기다려요」를 지어내지 않는다.
    expect(screen.queryByTestId("work-job-approval-waiting")).toBeNull();
  });

  it("승인은 인박스와 같은 라우트(`POST …/approvals/{id}/decision`)로 나가고, 원장·목록을 다시 읽은 뒤 영수증을 보인 채 잠깐 그 자리에 남았다가 「지금」으로 가며 캐럿은 그 줄에 남는다", async () => {
    board(new Set(), { mine: runs });
    api.fetchApprovals.mockResolvedValue(ledger);
    api.authedResponse.mockImplementation(async (path: string) =>
      String(path).endsWith("/decision")
        ? httpResponse(200, { status: "approved", decided_by: ME, decided_at_ms: Date.now() })
        : httpResponse(404, {})
    );
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(2)]));
    const ledgerReads = api.fetchApprovals.mock.calls.length;
    // 결정이 닿은 뒤 서버는 그 승인을 대기에서 뺐고, run은 다시 돈다.
    api.fetchApprovals.mockResolvedValue(ledger.slice(1));
    fireEvent.click(within(jobOf(R(1))).getByTestId("work-job-approval-approve"));
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));
    const [path, init] = decisionCalls()[0]! as [string, { method: string; body: string }];
    expect(path).toBe(`/v1/workspaces/${encodeURIComponent(WS)}/approvals/${encodeURIComponent(A(1))}/decision`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ approval_id: A(1), approve: true });
    await waitFor(() => expect(api.fetchApprovals.mock.calls.length).toBeGreaterThan(ledgerReads));
    // 원장이 그 승인을 뺐어도 줄은 영수증을 보인 채 그 자리다(수리 3회차 H1).
    expect(rowsIn("needsMe")).toEqual([R(1), R(2)]);
    expect(within(jobOf(R(1))).getAllByTestId("work-job-approval-settled")[0]!.textContent).toBe("승인을 기록했어요.");
    expect(screen.getByTestId("work-jobs-decision-note").textContent).toBe("승인을 기록했어요.");
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(2)]), { timeout: 4000 });
    const moved = screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === R(1))!;
    expect(document.activeElement).toBe(moved);
  });

  it("결정 중에는 단추가 「보내는 중」으로 서고(두 번 나가지 않는다), 실패하면 단추 자리에서 말하고 단추는 남는다", async () => {
    board(new Set(), { mine: runs });
    api.fetchApprovals.mockResolvedValue(ledger);
    let answer: (value: ReturnType<typeof httpResponse>) => void = () => undefined;
    api.authedResponse.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          if (String(path).endsWith("/decision")) answer = resolve;
          else resolve(httpResponse(404, {}));
        })
    );
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(2)]));
    const approve = within(jobOf(R(1))).getByTestId("work-job-approval-approve");
    fireEvent.click(approve);
    await waitFor(() => expect(approve.textContent).toBe("보내는 중"));
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(approve);
    expect(decisionCalls()).toHaveLength(1);
    await act(async () => answer(httpResponse(500, {})));
    const error = await within(jobOf(R(1))).findByTestId("work-job-approval-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(within(jobOf(R(1))).getByTestId("work-job-approval-approve").textContent).toBe("승인");
    expect(rowsIn("needsMe")).toEqual([R(1), R(2)]);
  });

  it("키보드: 결정 단추는 그 줄 단추 다음 차례이고(거부 → 승인), j/k는 줄 사이만 옮겨 단추에 내려앉지 않는다", async () => {
    board(new Set(), { mine: runs });
    api.fetchApprovals.mockResolvedValue(ledger);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(2)]));
    const r1 = jobOf(R(1));
    const row = within(r1).getByTestId("work-job-row");
    const reject = within(r1).getByTestId("work-job-approval-reject");
    const approve = within(r1).getByTestId("work-job-approval-approve");
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(row, reject) && follows(reject, approve)).toBe(true);
    const nextRow = screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === R(2))!;
    expect(follows(approve, nextRow)).toBe(true);
    row.focus();
    fireEvent.keyDown(row, { key: "j" });
    expect(document.activeElement).toBe(nextRow);
    // Enter는 서랍을 열 뿐 결정하지 않는다.
    fireEvent.keyDown(nextRow, { key: "k" });
    fireEvent.click(row);
    expect(decisionCalls()).toHaveLength(0);
  });
});

// ---- 누른 자리에 다른 결정이 서지 않는다 (#5640 수리 3회차 H1) ----------------------------------------------------------------
//
// jsdom에는 자리(좌표)가 없다. 「같은 자리」는 「응답 필요」 구간의 같은 칸(n번째 줄)으로 잰다 — 결정한 줄이 빠지면 다음 줄이 그 칸으로
// 올라오는 것이 검수가 잰 그 위험이다. 포인터 누름은 `detail: 1`, 키보드 누름(Enter)은 `detail: 0`이다. 좌표가 같은지는
// `scripts/capture-5640.mjs`(진짜 브라우저)가 잰다.

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("누른 자리에 다른 결정이 서지 않는다 (#5640 수리 3·4회차 H1)", () => {
  const R = (n: number) => `00000000-0000-7000-8000-0000000000c${n}`;
  const A = (n: number) => `00000000-0000-7000-8000-0000000000f${n}`;
  const runOf = (n: number) =>
    runRow({
      sessionId: R(n),
      runId: R(n),
      requestedBy: DOHYUN,
      owner: AGENT,
      label: `에이전트 작업 ${n}`,
      phase: "awaiting_approval",
      trigger: "mention",
    });
  const twoRuns = [runOf(1), runOf(8)];
  const twoApprovals = [approval({ id: A(1), runId: R(1) }), approval({ id: A(8), runId: R(8) })];
  /** 사람이 겨눈 점. jsdom에는 자리가 없어 「같은 점」은 같은 좌표·같은 칸(n번째 줄)으로 잰다. */
  const POINT = { clientX: 300, clientY: 120 };

  beforeAll(() => {
    // jsdom에는 PointerEvent가 없다: 좌표와 포인터 종류를 싣는 MouseEvent로 흉내 낸다.
    if (typeof globalThis.PointerEvent === "undefined") {
      class FakePointerEvent extends MouseEvent {
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerType = init.pointerType ?? "mouse";
        }
      }
      globalThis.PointerEvent = FakePointerEvent as unknown as typeof globalThis.PointerEvent;
    }
  });

  /**
   * 실제 서버 흉내(검수 2·3회차): 결정 POST·원장·목록 모두 `roundTripMs` 뒤에 답한다. **거부하면 그 run을 바로 끝낸다**(`rejected`, 보드
   * `stopped` — `reject_run` → `end_parked_run_in_tx(Cancelled)`). 승인하면 run은 줄을 서고(`queued` → 보드 `waiting` → 실행 줄은
   * `idle`(`sharedWorkSessionFromWire`), 칩 「시작 전」),
   * `finishOnApprove`면 곧바로 끝난다. 목록 순서도 실제처럼 **결정이 닿은 run이 맨 앞**이다(`ORDER BY activity_us DESC`, 결정이 그 run의
   * `updated_at`을 올린다 — `work_board.rs`).
   */
  function serveDecisions(roundTripMs: number, opts: { finishOnApprove?: boolean; runs?: SharedWorkSession[]; approvals?: Approval[] } = {}) {
    const decided = new Map<string, boolean>();
    const runs = opts.runs ?? twoRuns;
    const asks = opts.approvals ?? twoApprovals;
    const board = () => {
      const now = runs.map((r) => {
        const approve = decided.get(r.runId!);
        if (approve === undefined) return r;
        if (!approve) return { ...r, status: "cancelled", state: "stopped" as const, phase: "cancelled", endedAtMs: Date.now() };
        if (opts.finishOnApprove) return { ...r, status: "done", state: "done" as const, phase: "succeeded", endedAtMs: Date.now() };
        return { ...r, status: "queued", state: "idle" as const, phase: "queued" };
      });
      const touched = [...decided.keys()].reverse();
      return [...touched.map((id) => now.find((r) => r.runId === id)!).filter(Boolean), ...now.filter((r) => !decided.has(r.runId!))];
    };
    api.fetchWorkJobs.mockImplementation(async () => {
      await sleepMs(roundTripMs);
      return { sessions: board(), nextCursor: null, mode: "jobs" };
    });
    api.fetchApprovals.mockImplementation(async () => {
      await sleepMs(roundTripMs);
      return asks.filter((a) => !decided.has(a.runId!));
    });
    api.authedResponse.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (!String(path).endsWith("/decision")) return httpResponse(404, {});
      const approvalId = decodeURIComponent(String(path).split("/").at(-2)!);
      const approve = (JSON.parse(init?.body ?? "{}") as { approve?: boolean }).approve !== false;
      decided.set(asks.find((a) => a.id === approvalId)!.runId!, approve);
      await sleepMs(roundTripMs);
      return httpResponse(200, { status: approve ? "approved" : "rejected", decided_by: ME, decided_at_ms: Date.now() });
    });
  }
  const decidedIds = () => decisionCalls().map(([path]) => decodeURIComponent(String(path).split("/").at(-2)!));
  const decidedHow = () => decisionCalls().map(([, init]) => (JSON.parse((init as { body: string }).body) as { approve: boolean }).approve);
  const needsMeSlot = (n: number) =>
    within(screen.getAllByTestId("work-jobs-section").find((s) => s.dataset.section === "needsMe")!).getAllByTestId("work-job")[n]!;
  const list = () => screen.getByRole("region", { name: WORK_JOBS_COPY.listLabel });
  /** 그 칸을 포인터로 누른다(그 점에서): 결정 단추가 있으면 그 단추, 없으면 줄 자리(영수증)를. */
  const pressSlot = (n: number, which: "approve" | "reject" = "approve", at = POINT, pointerType = "mouse") => {
    const li = needsMeSlot(n);
    const target = li.querySelector<HTMLElement>(`[data-testid="work-job-approval-${which}"]`) ?? li;
    fireEvent.pointerDown(target, { ...at, pointerType });
    fireEvent.click(target, { detail: 1, ...at });
  };
  const receiptIn = (n: number) => within(needsMeSlot(n)).queryAllByTestId("work-job-approval-settled")[0]?.textContent ?? null;
  const needsMeCount = () => Number(screen.getAllByTestId("work-jobs-section-count")[0]!.textContent);
  const needsMeChips = () =>
    within(screen.getAllByTestId("work-jobs-section").find((s) => s.dataset.section === "needsMe")!)
      .getAllByTestId("team-board-state")
      .filter((chip) => chip.textContent === "응답 필요").length;
  const RECEIPT = { approve: "승인을 기록했어요.", reject: "거부를 기록했어요." } as const;

  it.each([
    ["approve", 40],
    ["approve", 100],
    ["approve", 300],
    ["reject", 40],
    ["reject", 100],
    ["reject", 300],
  ] as const)(
    "마우스 · %s · 서버 왕복 %ims: A를 결정하고 같은 점을 다시 누르면 나간 결정은 A 1건 — 거부해 run이 끝나도 A는 영수증만 보인 채 그 칸에 남고, 놓인 뒤 그 점에 올라온 B의 단추는 1초 동안 그 점의 누름을 받지 않는다",
    async (which, roundTripMs) => {
      board(new Set(), { mine: twoRuns });
      serveDecisions(roundTripMs);
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      fireEvent.pointerMove(list(), { ...POINT, pointerType: "mouse" });
      pressSlot(0, which);
      await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT[which]), { timeout: 3000 });
      // 원장·목록이 다시 읽혀(거부면 run이 끝남) 줄이 옮겨 갈 수 있는 때까지 기다린 뒤 본다.
      await sleepMs(roundTripMs * 2 + 50);
      expect(rowsIn("needsMe")[0]).toBe(R(1));
      expect(receiptIn(0)).toBe(RECEIPT[which]);
      // 붙든 줄은 결정된 모습만: 결정 단추·꼬리표·되돌릴 수 없음·만료가 없다(검수 2회차 M2).
      const held = needsMeSlot(0);
      expect(held.querySelector("[data-decision]")).toBeNull();
      expect(within(held).queryAllByTestId("work-job-approval-tag")).toHaveLength(0);
      expect(within(held).queryAllByTestId("work-job-approval-note")).toHaveLength(0);
      // 걷은 줄은 자리만 남는다(보이지 않고 낭독에서도 빠짐 — `invisible` + `aria-hidden`), 줄 높이를 지키려고.
      const expiry = [...held.querySelectorAll("span")].filter((e) => e.children.length === 0 && (e.textContent ?? "").includes("후 만료"));
      expect(expiry.length).toBeGreaterThan(0);
      expect(expiry.every((e) => e.closest('.invisible[aria-hidden="true"]') !== null)).toBe(true);
      // 「되돌릴 수 없음」도 자리만(수리 5회차 M2): 그 글이 있고, 모두 보이지 않고 낭독에서 빠진다.
      const irreversible = [...held.querySelectorAll("span")].filter((e) => e.children.length === 0 && e.textContent === "되돌릴 수 없음");
      expect(irreversible.length).toBeGreaterThan(0);
      expect(irreversible.every((e) => e.closest('.invisible[aria-hidden="true"]') !== null)).toBe(true);
      // 머리글 수 = 구간에서 「응답 필요」 칩이 선 줄 수(H2), 붙든 줄의 칩은 「응답 필요」가 아니다.
      expect(needsMeCount()).toBe(1);
      expect(needsMeChips()).toBe(needsMeCount());
      expect(within(held).getByTestId("team-board-state").textContent).not.toBe("응답 필요");
      pressSlot(0, which);
      // 그 점 밑이 줄 단추여도(폭·배너로 줄이 밀린 경우) 붙든 동안 같은 점을 다시 누르는 것은 아무 일도 아니다(서랍도 열지 않는다).
      fireEvent.click(within(needsMeSlot(0)).getByTestId("work-job-row"), { detail: 1, ...POINT });
      expect(new URLSearchParams(seen.search).get("card")).toBeNull();
      await sleepMs(roundTripMs * 2 + 50);
      expect(decidedIds()).toEqual([A(1)]);
      expect(decidedHow()).toEqual([which === "approve"]);
      // 잠깐 뒤 놓이면(jsdom에는 구간 상자가 없어 포인터가 구간 밖) A는 그 구간을 떠나고, 초점은 B의 단추가 아니라 A의 줄을 따라간다.
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]), { timeout: 4000 });
      expect(document.activeElement?.getAttribute("data-job-id")).toBe(R(1));
      // 그 점에 B의 단추가 올라왔다: 움직이지 않은 누름은 결정이 아니고, 막힌 모습을 보인다.
      pressSlot(0, which);
      await sleepMs(50);
      expect(decidedIds()).toEqual([A(1)]);
      expect(list().hasAttribute("data-shift-guard")).toBe(true);
    },
    15_000
  );

  it("마우스 · 승인한 run이 곧바로 끝나도(같은 길) 붙든 줄은 「끝난 일」로 가지 않고 영수증과 함께 그 칸에 남는다", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(60, { finishOnApprove: true });
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    fireEvent.pointerMove(list(), { ...POINT, pointerType: "mouse" });
    pressSlot(0);
    await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
    await sleepMs(250);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    expect(rowsIn("done")).not.toContain(R(1));
    pressSlot(0);
    await sleepMs(200);
    expect(decidedIds()).toEqual([A(1)]);
  });

  it.each(["approve", "reject"] as const)(
    "터치 · %s · 손떨림 1px: 붙든 줄은 시간으로 놓이지 않고(1.5초 뒤에도 그 칸), 다른 곳을 누르면 놓이며, 놓인 뒤 그 점의 탭은 손이 떨려도 1초 동안 결정이 아니다",
    async (which) => {
      board(new Set(), { mine: twoRuns });
      serveDecisions(40);
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      // 원장이 와서 줄이 막 「응답 필요」로 올라온 1초 동안의 탭은 삼킨다(터치는 움직임으로 풀리지 않는다). 사람이 본 뒤에 누른다.
      await sleepMs(1100);
      pressSlot(0, which, POINT, "touch");
      // 손을 떼면 포인터 자리가 없다.
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT[which]), { timeout: 3000 });
      await sleepMs(1500);
      expect(rowsIn("needsMe")[0]).toBe(R(1));
      // 둘째 탭(손떨림 1px): 그 칸에는 영수증뿐이다.
      const jitter = { clientX: POINT.clientX + 1, clientY: POINT.clientY + 1 };
      fireEvent.pointerMove(list(), { ...jitter, pointerType: "touch" });
      pressSlot(0, which, jitter, "touch");
      await sleepMs(100);
      expect(decidedIds()).toEqual([A(1)]);
      expect(rowsIn("needsMe")[0]).toBe(R(1));
      // 다른 곳을 누른다 → 놓인다.
      fireEvent.click(document.body, { detail: 1, clientX: 40, clientY: 600 });
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]), { timeout: 2000 });
      // 그 점에 올라온 B의 단추: 손떨림 1px 탭도 1초 동안 결정이 아니다.
      fireEvent.pointerMove(list(), { ...jitter, pointerType: "touch" });
      pressSlot(0, which, jitter, "touch");
      await sleepMs(100);
      expect(decidedIds()).toEqual([A(1)]);
      // 멀리 떨어진 점을 겨눈 탭은 결정이다(막기가 모든 탭을 삼키지 않는다).
      pressSlot(0, which, { clientX: 40, clientY: 400 }, "touch");
      await sleepMs(300);
      await waitFor(() => expect(decidedIds()).toEqual([A(1), A(8)]), { timeout: 3000 });
    },
    15_000
  );

  it("한 run에 승인이 둘이면(터치): 누른 자리(결정 단추 층)에는 첫 승인의 영수증이 남고 둘째 승인은 그 아래 새 줄에 바로 선다(머리글이 다시 센다). 새 요청이 왔다고 붙들기가 끝나지 않고(2.5초 뒤에도 영수증), 같은 자리 탭은 결정이 아니며, 새 줄의 단추는 받는다", async () => {
    const one = twoRuns[0]!;
    const second = approval({ id: A(2), runId: R(1) });
    const decided = new Set<string>();
    api.fetchWorkJobs.mockResolvedValue({ sessions: [one], nextCursor: null, mode: "jobs" });
    api.fetchApprovals.mockImplementation(async () => [twoApprovals[0]!, second].filter((a) => !decided.has(a.id)));
    api.authedResponse.mockImplementation(async (path: string) => {
      if (!String(path).endsWith("/decision")) return httpResponse(404, {});
      decided.add(decodeURIComponent(String(path).split("/").at(-2)!));
      return httpResponse(200, { status: "approved", decided_by: ME, decided_at_ms: Date.now() });
    });
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1)]));
    await sleepMs(1100);
    pressSlot(0, "approve", POINT, "touch");
    fireEvent.pointerLeave(list(), { pointerType: "touch" });
    await waitFor(() => expect(needsMeSlot(0).querySelector('[data-testid="work-job-next-ask"] [data-testid="work-job-approval-approve"]')).not.toBeNull());
    const actions = within(needsMeSlot(0)).getByTestId("work-job-actions");
    // 결정 단추 층의 첫 줄(방금 누른 자리)은 영수증이고, 둘째 승인은 그 아래 새 줄이다(수리 3회차가 잠갔던 「그 칸에는 영수증」, 수리 5회차 M3).
    expect(actions.firstElementChild?.textContent).toContain(RECEIPT.approve);
    expect(actions.firstElementChild?.querySelector("[data-decision]")).toBeNull();
    expect(actions.firstElementChild?.compareDocumentPosition(within(actions).getByTestId("work-job-next-ask")) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // 결과 칸은 방금 결정한 승인 그대로다(새 요청이 칸 높이를 바꾸지 않는다).
    expect(needsMeSlot(0).querySelector('[data-testid="work-job-result"][data-held]')).not.toBeNull();
    expect(needsMeCount()).toBe(1);
    await sleepMs(2500);
    expect(receiptIn(0)).toBe(RECEIPT.approve);
    // 같은 자리(영수증) 탭은 아무 일도 아니다.
    fireEvent.pointerDown(actions.firstElementChild!, { ...POINT, pointerType: "touch" });
    fireEvent.click(actions.firstElementChild!, { detail: 1, ...POINT });
    await sleepMs(100);
    expect(decidedIds()).toEqual([A(1)]);
    // 새 줄의 단추(다른 자리)는 받는다.
    pressSlot(0, "approve", { clientX: 300, clientY: 190 }, "touch");
    await waitFor(() => expect(decidedIds()).toEqual([A(1), A(2)]));
    await sleepMs(300);
  }, 15_000);

  it("Enter 연타(키보드): A의 승인에서 Enter를 거듭 쳐도 나간 결정은 1건이고 초점은 다음 줄의 결정 단추로 가지 않는다", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(40);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    within(needsMeSlot(0)).getByTestId("work-job-approval-approve").focus();
    for (const at of [0, 120, 200, 380]) {
      await sleepMs(at === 0 ? 0 : 120);
      // Enter = 초점이 있는 것을 키보드로 누름(`detail: 0`).
      fireEvent.click(document.activeElement!, { detail: 0 });
    }
    await sleepMs(300);
    expect(decidedIds()).toEqual([A(1)]);
    expect(document.activeElement?.hasAttribute("data-decision")).toBe(false);
  });

  it("서버의 「못 한다」가 늦게 와서 A가 빠지면 그 점에 올라온 B의 승인은 누름을 받지 않고 막힌 모습을 보인다 — 손떨림은 움직임이 아니고, 움직인 뒤에는 받는다", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(0);
    let deliver: (runs: AgentRunProgress[]) => void = () => undefined;
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_AGENT_LAB],
      realtime: null,
      fetchProgress: () => new Promise<AgentRunProgress[]>((resolve) => (deliver = resolve)),
    });
    try {
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      fireEvent.pointerMove(list(), { ...POINT, pointerType: "mouse" });
      await act(async () =>
        deliver([
          {
            id: R(1),
            channelId: CH_AGENT_LAB,
            agentMemberId: AGENT.memberId,
            status: "running",
            phase: "awaiting_approval",
            leaseState: "live",
            stepCount: 0,
            ahead: [],
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            bundle: { approvalId: A(1), status: "pending", decisionMode: "inline", canDecide: false, actionType: "tool_call" },
          } as AgentRunProgress,
        ])
      );
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]));
      expect(list().hasAttribute("data-shift-guard")).toBe(false);
      pressSlot(0);
      await sleepMs(50);
      expect(decisionCalls()).toHaveLength(0);
      // 삼킨 누름에는 표시가 있다(결정 단추가 막힌 승인의 모양), 막기가 끝나면 걷힌다.
      expect(list().hasAttribute("data-shift-guard")).toBe(true);
      const jitter = { clientX: 302, clientY: 121 };
      fireEvent.pointerMove(list(), { ...jitter, pointerType: "mouse" });
      pressSlot(0, "approve", jitter);
      await sleepMs(50);
      expect(decisionCalls()).toHaveLength(0);
      const away = { clientX: 300, clientY: 160 };
      fireEvent.pointerMove(list(), { ...away, pointerType: "mouse" });
      pressSlot(0, "approve", away);
      await waitFor(() => expect(decidedIds()).toEqual([A(8)]));
      await waitFor(() => expect(list().hasAttribute("data-shift-guard")).toBe(false), { timeout: 2000 });
    } finally {
      stop();
    }
  });

  it("터치 · 늦은 거절: 누른 적도 가리킨 적도 없는 손이(기준점 없음) 1px 떨며 그 칸을 탭해도 1초 동안은 결정이 아니다", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(0);
    let deliver: (runs: AgentRunProgress[]) => void = () => undefined;
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_AGENT_LAB],
      realtime: null,
      fetchProgress: () => new Promise<AgentRunProgress[]>((resolve) => (deliver = resolve)),
    });
    try {
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      await sleepMs(1100);
      await act(async () =>
        deliver([
          {
            id: R(1),
            channelId: CH_AGENT_LAB,
            agentMemberId: AGENT.memberId,
            status: "running",
            phase: "awaiting_approval",
            leaseState: "live",
            stepCount: 0,
            ahead: [],
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            bundle: { approvalId: A(1), status: "pending", decisionMode: "inline", canDecide: false, actionType: "tool_call" },
          } as AgentRunProgress,
        ])
      );
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]));
      fireEvent.pointerMove(list(), { clientX: 301, clientY: 121, pointerType: "touch" });
      pressSlot(0, "approve", { clientX: 301, clientY: 121 }, "touch");
      await sleepMs(50);
      expect(decisionCalls()).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("원장이 늦게 와서 줄이 「지금」에서 「응답 필요」로 올라와도, 막 선 승인은 짧은 보호 시간 동안 움직이지 않은 포인터 누름을 받지 않고 그 뒤에는 받는다", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(0);
    let answer: (approvals: Approval[]) => void = () => undefined;
    api.fetchApprovals.mockImplementationOnce(() => new Promise<Approval[]>((resolve) => (answer = resolve)));
    render(mount());
    await waitFor(() => expect(rowsIn("now")).toEqual([R(1), R(8)]));
    fireEvent.pointerMove(list(), { ...POINT, pointerType: "mouse" });
    await act(async () => answer(twoApprovals));
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]));
    pressSlot(0);
    await sleepMs(50);
    expect(decisionCalls()).toHaveLength(0);
    // 보호 시간이 지나면(포인터가 움직이지 않아도) 사람이 본 그 단추를 누를 수 있다.
    await sleepMs(1000);
    pressSlot(0);
    await waitFor(() => expect(decidedIds()).toEqual([A(1)]));
  });

  it("「응답 필요」와 상관없는 목록 변화(「지금」의 다른 작업이 끝남)에는 막기를 켜지 않는다", async () => {
    const other = runRow({ sessionId: R(5), runId: R(5), requestedBy: DOHYUN, owner: AGENT, label: "다른 작업", phase: "running", trigger: "work" });
    let otherDone = false;
    api.fetchWorkJobs.mockImplementation(async () => ({
      sessions: [...twoRuns, otherDone ? { ...other, status: "done", state: "done" as const, phase: "succeeded", endedAtMs: Date.now() } : other],
      nextCursor: null,
      mode: "jobs",
    }));
    api.fetchApprovals.mockResolvedValue(twoApprovals);
    api.authedResponse.mockImplementation(async (path: string) =>
      String(path).endsWith("/decision") ? httpResponse(200, { status: "approved", decided_by: ME, decided_at_ms: Date.now() }) : httpResponse(404, {})
    );
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]));
    fireEvent.pointerMove(list(), { ...POINT, pointerType: "mouse" });
    otherDone = true;
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(rowsIn("done")).toContain(R(5)));
    pressSlot(0);
    await waitFor(() => expect(decidedIds()).toEqual([A(1)]));
  });

  it("마우스: 포인터가 「응답 필요」 구간 위에 있는 동안은 붙든 줄을 놓지 않고, 구간을 떠나면 놓는다", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const box = this.dataset.section === "needsMe" ? { left: 0, right: 1000, top: 0, bottom: 500 } : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    board(new Set(), { mine: twoRuns });
    serveDecisions(40);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    fireEvent.pointerMove(list(), { ...POINT, pointerType: "mouse" });
    pressSlot(0);
    await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
    await sleepMs(1700);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    fireEvent.pointerMove(list(), { clientX: 300, clientY: 900, pointerType: "mouse" });
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]), { timeout: 2000 });
  });

  // ---- 수리 5회차 (검수 3회차 H1·M1·M2·M3) ------------------------------------------------------------------------------------

  /** n번째 「응답 필요」 줄의 자리 흉내: 줄(li)은 y 200n…200n+200, 그 줄의 「승인」은 x 260–340, 「거부」는 x 160–240, y 100…144(좁은 폭 44px 표적). */
  const SLOT_H = 200;
  const slotButton = (n: number, which: "approve" | "reject", shift = 0) => ({ x: which === "approve" ? 300 : 200, y: n * SLOT_H + 122 + shift });
  function mockSlotGeometry(opts: { shiftOf?: (slot: number) => number; sectionBox?: boolean } = {}) {
    const rect = (left: number, top: number, right: number, bottom: number) =>
      ({ left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (opts.sectionBox && this.dataset.section === "needsMe") return rect(0, 0, 1000, 800);
      const li = this.closest('[data-section="needsMe"] li');
      if (li === null) return rect(0, 0, 0, 0);
      const slot = [...li.parentElement!.children].indexOf(li);
      const top = slot * SLOT_H + (opts.shiftOf?.(slot) ?? 0);
      if (this === li) return rect(0, top, 1000, top + SLOT_H);
      const which = this.getAttribute("data-decision");
      if (which === "approve") return rect(260, top + 100, 340, top + 144);
      if (which === "reject") return rect(160, top + 100, 240, top + 144);
      return rect(0, 0, 0, 0);
    });
  }
  const at = (p: { x: number; y: number }) => ({ clientX: p.x, clientY: p.y });
  /** 시험이 끝나기 전에 나간 결정의 답이 닿게 한다(늦은 답이 다음 시험의 「이미 결정함」 저장소에 들어가지 않게). */
  const settleAnswers = () => sleepMs(300);

  it.each([
    ["approve", "0.7초 간격 3번", 700, [8, -8]],
    ["approve", "0.5초 간격 4번", 500, [9, -8, 7]],
    ["approve", "0.35초 간격 6번", 350, [8, -7, 5, 9, -6]],
    ["reject", "0.7초 간격 3번", 700, [8, -8]],
    ["reject", "0.5초 간격 4번", 500, [9, -8, 7]],
    ["reject", "0.35초 간격 6번", 350, [8, -7, 5, 9, -6]],
  ] as const)(
    "터치 · %s · %s(탭마다 5~9px 흩어짐): 붙든 줄 상자 안의 탭은 「다른 곳」이 아니다 — A만 결정되고 A는 그 칸에 남는다",
    async (which, _name, every, offsets) => {
      board(new Set(), { mine: twoRuns });
      serveDecisions(40);
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      await sleepMs(1100);
      pressSlot(0, which, POINT, "touch");
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      for (const [i, dx] of offsets.entries()) {
        await sleepMs(every);
        pressSlot(0, which, { clientX: POINT.clientX + dx, clientY: POINT.clientY + (i % 2 ? 3 : -2) }, "touch");
      }
      await sleepMs(1000);
      expect(decidedIds()).toEqual([A(1)]);
      expect(decidedHow()).toEqual([which === "approve"]);
      expect(rowsIn("needsMe")[0]).toBe(R(1));
    },
    15_000
  );

  it.each(["approve", "reject"] as const)(
    "터치 · %s: 붙든 줄을 떠나 A가 빠지면 그 자리에 선 B의 단추는 누른 단추의 상자 안 탭(6px 밖)을 1초 동안 받지 않고 막힌 모양을 보인다 — 상자 밖 탭은 받는다(모두 삼키지 않는다)",
    async (which) => {
      mockSlotGeometry();
      board(new Set(), { mine: twoRuns });
      serveDecisions(40);
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      await sleepMs(1100);
      const first = slotButton(0, which);
      pressSlot(0, which, at(first), "touch");
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT[which]), { timeout: 3000 });
      // 다른 곳(붙든 줄 상자 밖)을 누른다 → 놓인다 → B가 A의 자리로 올라온다.
      fireEvent.click(document.body, { detail: 1, clientX: 40, clientY: 900 });
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]), { timeout: 3000 });
      pressSlot(0, which, at({ x: first.x + 9, y: first.y + 4 }), "touch");
      await sleepMs(50);
      expect(decidedIds()).toEqual([A(1)]);
      expect(list().hasAttribute("data-shift-guard")).toBe(true);
      const other = which === "approve" ? "reject" : "approve";
      pressSlot(0, other, at(slotButton(0, other)), "touch");
      await waitFor(() => expect(decidedIds()).toEqual([A(1), A(8)]), { timeout: 3000 });
      await settleAnswers();
    },
    15_000
  );

  it("순서·승인·붙든 줄이 그대로여도 위 줄의 높이가 바뀌어 B의 「승인」이 포인터 밑에 서면, 그 단추가 선 때부터 1초 동안 그 자리의 누름을 받지 않고 그 뒤에는 받는다", async () => {
    let shrunk = false;
    mockSlotGeometry({ shiftOf: (slot) => (shrunk && slot === 1 ? -100 : 0) });
    let label = "에이전트 작업 1";
    api.fetchWorkJobs.mockImplementation(async () => ({ sessions: [{ ...twoRuns[0]!, label }, twoRuns[1]!], nextCursor: null, mode: "jobs" }));
    api.fetchApprovals.mockResolvedValue(twoApprovals);
    api.authedResponse.mockImplementation(async (path: string) =>
      String(path).endsWith("/decision") ? httpResponse(200, { status: "approved", decided_by: ME, decided_at_ms: Date.now() }) : httpResponse(404, {})
    );
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]));
    await sleepMs(1100);
    const spot = slotButton(1, "approve", -100);
    fireEvent.pointerMove(list(), { ...at(spot), pointerType: "mouse" });
    // A의 줄이 바뀌어(이름) 줄 높이가 줄었다 — 순서·승인·붙든 줄은 그대로, B의 「승인」만 포인터 밑으로 올라온다.
    shrunk = true;
    label = "에이전트 작업 1 (이름 바뀜)";
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.getAllByText("에이전트 작업 1 (이름 바뀜)").length).toBeGreaterThan(0));
    pressSlot(1, "approve", at(spot));
    await sleepMs(50);
    expect(decisionCalls()).toHaveLength(0);
    expect(list().hasAttribute("data-shift-guard")).toBe(true);
    await sleepMs(1000);
    pressSlot(1, "approve", at(spot));
    await waitFor(() => expect(decidedIds()).toEqual([A(8)]));
    await settleAnswers();
  }, 15_000);

  it("「응답 필요」 아래에 새 요청 줄이 서도 움직이지 않은 단추는 막지 않는다(포인터 밑의 B는 바로 눌린다)", async () => {
    const third = runOf(5);
    let withThird = false;
    api.fetchWorkJobs.mockImplementation(async () => ({ sessions: withThird ? [...twoRuns, third] : twoRuns, nextCursor: null, mode: "jobs" }));
    // 원장에는 처음부터 있고(인박스와 같은 원장), 목록에 그 run이 늦게 와서 구간 아래에 선다.
    api.fetchApprovals.mockResolvedValue([...twoApprovals, approval({ id: A(5), runId: R(5) })]);
    api.authedResponse.mockImplementation(async (path: string) =>
      String(path).endsWith("/decision") ? httpResponse(200, { status: "approved", decided_by: ME, decided_at_ms: Date.now() }) : httpResponse(404, {})
    );
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]));
    await sleepMs(1100);
    fireEvent.pointerMove(list(), { ...POINT, pointerType: "mouse" });
    withThird = true;
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8), R(5)]));
    pressSlot(1, "approve", POINT);
    await waitFor(() => expect(decidedIds()).toEqual([A(8)]));
    await settleAnswers();
  }, 15_000);

  it("마우스: 붙든 동안 목록을 굴려 다른 줄의 단추가 그 점에 오면, 굴림이 끝나고 1초 동안은 막힌 모양으로 삼키고 그 뒤에는 받는다", async () => {
    mockSlotGeometry({ sectionBox: true });
    board(new Set(), { mine: twoRuns });
    serveDecisions(40);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    const spot = slotButton(0, "approve");
    fireEvent.pointerMove(list(), { ...at(spot), pointerType: "mouse" });
    pressSlot(0, "approve", at(spot));
    await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
    await sleepMs(300);
    // 사람이 휠로 굴려 B의 「승인」이 포인터 밑에 왔다(포인터는 그대로).
    fireEvent.scroll(list());
    pressSlot(1, "approve", at(spot));
    await sleepMs(50);
    expect(decidedIds()).toEqual([A(1)]);
    expect(list().hasAttribute("data-shift-guard")).toBe(true);
    await sleepMs(1100);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    pressSlot(1, "approve", at(spot));
    await waitFor(() => expect(decidedIds()).toEqual([A(1), A(8)]));
    await settleAnswers();
  }, 15_000);

  it("실제 서버처럼 결정한 run이 목록 맨 앞으로 와도, 붙든 동안 「응답 필요」의 칸 순서는 그대로다(아래 줄 B를 결정해도 A의 단추가 B의 칸으로 내려오지 않는다)", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(40);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    await sleepMs(1100);
    pressSlot(1, "approve", POINT, "touch");
    fireEvent.pointerLeave(list(), { pointerType: "touch" });
    await waitFor(() => expect(receiptIn(1)).toBe(RECEIPT.approve), { timeout: 3000 });
    // 원장·목록을 다시 읽어 서버가 B를 맨 앞으로 보낸 뒤에도.
    await waitFor(() => expect(api.fetchWorkJobs.mock.calls.length).toBeGreaterThan(1));
    await sleepMs(200);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    await sleepMs(1100);
    pressSlot(1, "approve", POINT, "touch");
    await sleepMs(100);
    expect(decidedIds()).toEqual([A(8)]);
  }, 15_000);

  it("터치: 붙든 줄은 사람이 목록을 굴리면 놓이고, 놓인 run은 서버 말대로 「시작 전」이다", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(40);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    await sleepMs(1100);
    pressSlot(0, "approve", POINT, "touch");
    fireEvent.pointerLeave(list(), { pointerType: "touch" });
    await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
    await sleepMs(1300);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    fireEvent.scroll(list());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]), { timeout: 2000 });
    const chip = within(screen.getAllByTestId("work-job").find((li) => li.querySelector(`[data-job-id="${R(1)}"]`) !== null)!).getByTestId("team-board-state");
    expect(chip.textContent).toBe("시작 전");
  }, 15_000);

  it("터치: 화면이 스스로 맞춘 스크롤(보던 줄 고정)은 사람이 굴린 것이 아니다 — 붙든 줄을 놓지 않는다", async () => {
    const working = (n: number) => runRow({ sessionId: R(n), runId: R(n), requestedBy: DOHYUN, owner: AGENT, label: `진행 ${n}`, phase: "running", trigger: "work" });
    let firstDone = false;
    const decided = new Set<string>();
    api.fetchWorkJobs.mockImplementation(async () => ({
      sessions: [
        ...twoRuns.map((r) => (decided.has(r.runId!) ? { ...r, status: "queued", state: "idle" as const, phase: "queued" } : r)),
        firstDone ? { ...working(2), status: "done", state: "done" as const, phase: "succeeded", endedAtMs: Date.now() } : working(2),
        working(3),
        working(4),
      ],
      nextCursor: null,
      mode: "jobs",
    }));
    api.fetchApprovals.mockImplementation(async () => twoApprovals.filter((a) => !decided.has(a.runId!)));
    api.authedResponse.mockImplementation(async (path: string) => {
      if (!String(path).endsWith("/decision")) return httpResponse(404, {});
      decided.add(twoApprovals.find((a) => a.id === decodeURIComponent(String(path).split("/").at(-2)!))!.runId!);
      return httpResponse(200, { status: "approved", decided_by: ME, decided_at_ms: Date.now() });
    });
    // 목록 상자 0–600, 줄은 문서 순서대로 100px씩(스크롤만큼 위로).
    let scrollTop = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = (top: number, bottom: number) => ({ left: 0, right: 1000, top, bottom, x: 0, y: top, width: 1000, height: bottom - top, toJSON: () => ({}) }) as DOMRect;
      if (this.dataset.teamBoardList !== undefined) return rect(0, 600);
      if (this.dataset.testid === "work-job-row") {
        const index = [...document.querySelectorAll('[data-testid="work-job-row"]')].indexOf(this);
        return rect(index * 100 - scrollTop, index * 100 - scrollTop + 100);
      }
      return { ...rect(0, 0), right: 0, width: 0 };
    });
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    Object.defineProperty(list(), "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
    // 사람이 굴려 둔 목록(보던 줄은 「지금」의 진행 2·3).
    scrollTop = 250;
    fireEvent.scroll(list());
    await sleepMs(1100);
    firstDone = true;
    pressSlot(0, "approve", POINT, "touch");
    fireEvent.pointerLeave(list(), { pointerType: "touch" });
    await waitFor(() => expect(rowsIn("done")).toContain(R(2)), { timeout: 3000 });
    // 진행 2가 끝나 「끝난 일」로 가면 화면이 보던 줄(진행 3)을 제자리에 두려고 스크롤을 맞춘다 — 그 스크롤 사건이 와도 붙든 줄은 그대로다.
    expect(scrollTop).not.toBe(250);
    fireEvent.scroll(list());
    await sleepMs(1500);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    expect(receiptIn(0)).toBe(RECEIPT.approve);
  }, 15_000);

  it("붙든 줄의 새 요청 단추가 (배치가 바뀌어) 방금 누른 단추의 상자와 겹치면, 그 단추는 막힌 모양으로 서서 누름을 받지 않고 사람이 그 줄을 떠난 뒤에 받는다", async () => {
    mockSlotGeometry();
    const one = twoRuns[0]!;
    const second = approval({ id: A(2), runId: R(1) });
    const decided = new Set<string>();
    api.fetchWorkJobs.mockResolvedValue({ sessions: [one], nextCursor: null, mode: "jobs" });
    api.fetchApprovals.mockImplementation(async () => [twoApprovals[0]!, second].filter((a) => !decided.has(a.id)));
    api.authedResponse.mockImplementation(async (path: string) => {
      if (!String(path).endsWith("/decision")) return httpResponse(404, {});
      decided.add(decodeURIComponent(String(path).split("/").at(-2)!));
      return httpResponse(200, { status: "approved", decided_by: ME, decided_at_ms: Date.now() });
    });
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1)]));
    await sleepMs(1100);
    const spot = slotButton(0, "approve");
    pressSlot(0, "approve", at(spot), "touch");
    fireEvent.pointerLeave(list(), { pointerType: "touch" });
    await waitFor(() => expect(needsMeSlot(0).querySelector('[data-testid="work-job-next-ask"] [data-testid="work-job-approval-approve"]')).not.toBeNull());
    await waitFor(() => expect(within(needsMeSlot(0)).getByTestId("work-job-extras").hasAttribute("data-shift-guard")).toBe(true));
    await sleepMs(1200);
    pressSlot(0, "approve", at({ x: spot.x + 20, y: spot.y + 10 }), "touch");
    await sleepMs(100);
    expect(decidedIds()).toEqual([A(1)]);
    // 붙든 동안 같은 자리 삼킴이 결정 단추를 삼켰으면 목록에도 막힌 모양이 선다(#5712, 검수 4회차 L5 Z15).
    expect(list().hasAttribute("data-shift-guard")).toBe(true);
    fireEvent.click(document.body, { detail: 1, clientX: 40, clientY: 900 });
    await waitFor(() => expect(within(needsMeSlot(0)).getByTestId("work-job-extras").hasAttribute("data-shift-guard")).toBe(false));
    // 떠나면 붙들기가 끝나고(다음 박자) 새 요청의 단추가 그 자리로 올라온다 — 선 때부터 1초 막기가 맡는다.
    await waitFor(() => expect(within(needsMeSlot(0)).queryByTestId("work-job-next-ask")).toBeNull());
    await sleepMs(1100);
    pressSlot(0, "approve", at({ x: spot.x + 20, y: spot.y + 10 }), "touch");
    await waitFor(() => expect(decidedIds()).toEqual([A(1), A(2)]));
    await settleAnswers();
  }, 15_000);

  // ---- #5712 (검수 4회차 M1·M2): 입력 종류가 바뀌어도, 차례로 결정해도 ----------------------------------------------------------

  it.each(["approve", "reject"] as const)(
    "마우스로 %s한 뒤 손가락으로 두 번(8px 옆, 1.4초 안): 터치 탭이 끝나며 오는 pointerleave가 마우스 자리를 지우지 않아 붙든 줄이 그 칸에 남고 결정은 A 1건",
    async (which) => {
      mockSlotGeometry({ sectionBox: true });
      board(new Set(), { mine: twoRuns });
      serveDecisions(40);
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      const spot = slotButton(0, which);
      fireEvent.pointerMove(list(), { ...at(spot), pointerType: "mouse" });
      pressSlot(0, which, at(spot));
      await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT[which]), { timeout: 3000 });
      for (const [dx, dy, wait] of [[8, 3, 500], [-8, -2, 900]] as const) {
        await sleepMs(wait);
        pressSlot(0, which, at({ x: spot.x + dx, y: spot.y + dy }), "touch");
        fireEvent.pointerLeave(list(), { pointerType: "touch" });
      }
      await sleepMs(400);
      // 마우스는 그대로 구간 위다 — 붙든 줄은 1.2초가 지나도 놓이지 않는다.
      expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
      expect(receiptIn(0)).toBe(RECEIPT[which]);
      pressSlot(0, which, at({ x: spot.x + 7, y: spot.y + 3 }), "touch");
      await sleepMs(100);
      expect(decidedIds()).toEqual([A(1)]);
      await settleAnswers();
    },
    15_000
  );

  it.each(["approve", "reject"] as const)(
    "마우스로 %s하고 포인터가 구간을 떠나 A가 빠진 뒤, 그 자리에 선 B의 단추는 손가락 탭(누른 단추 상자 안, 6px 밖)을 1초 동안 받지 않는다 — 마우스 표지도 손가락 누름은 단추 상자로 잰다",
    async (which) => {
      mockSlotGeometry({ sectionBox: true });
      board(new Set(), { mine: twoRuns });
      serveDecisions(40);
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      const spot = slotButton(0, which);
      fireEvent.pointerMove(list(), { ...at(spot), pointerType: "mouse" });
      pressSlot(0, which, at(spot));
      await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT[which]), { timeout: 3000 });
      fireEvent.pointerMove(list(), { clientX: 300, clientY: 900, pointerType: "mouse" });
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]), { timeout: 3000 });
      const tapAt = at({ x: spot.x + 9, y: spot.y + 4 });
      pressSlot(0, which, tapAt, "touch");
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      await sleepMs(50);
      expect(decidedIds()).toEqual([A(1)]);
      expect(list().hasAttribute("data-shift-guard")).toBe(true);
      await sleepMs(1100);
      pressSlot(0, which, tapAt, "touch");
      await waitFor(() => expect(decidedIds()).toEqual([A(1), A(8)]), { timeout: 3000 });
      await settleAnswers();
    },
    15_000
  );

  it("펜으로 결정한 줄은 펜을 떼도(pointerleave) 시간으로 놓이지 않고, 누른 단추 상자 안의 다시 누름은 결정이 아니다 — 펜은 손가락과 같다", async () => {
    mockSlotGeometry({ sectionBox: true });
    board(new Set(), { mine: twoRuns });
    serveDecisions(40);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    await sleepMs(1100);
    const spot = slotButton(0, "approve");
    fireEvent.pointerMove(list(), { ...at(spot), pointerType: "pen" });
    pressSlot(0, "approve", at(spot), "pen");
    fireEvent.pointerLeave(list(), { pointerType: "pen" });
    await waitFor(() => expect(receiptIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
    await sleepMs(1500);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    pressSlot(0, "approve", at({ x: spot.x + 9, y: spot.y + 4 }), "pen");
    await sleepMs(100);
    expect(decidedIds()).toEqual([A(1)]);
    await settleAnswers();
  }, 15_000);

  const threeRuns = [runOf(1), runOf(8), runOf(5)];
  const threeApprovals = [...twoApprovals, approval({ id: A(5), runId: R(5) })];

  it.each([
    ["1.5초 간격", 1500, false],
    ["2.5초 간격", 2500, false],
    ["1.5초 간격, B를 결정한 뒤 B의 줄 안 다른 곳을 한 번 누름", 1500, true],
  ] as const)(
    "터치로 서로 다른 세 줄을 차례로(%s, 줄 높이가 같음): 손 밑의 붙든 줄이 있는 동안 앞 줄이 놓이지 않아 셋째 줄의 「승인」이 제자리에서 눌린다 — 3건",
    async (_name, gap, inRowTap) => {
      mockSlotGeometry();
      board(new Set(), { mine: threeRuns });
      serveDecisions(40, { runs: threeRuns, approvals: threeApprovals });
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8), R(5)]), { timeout: 3000 });
      await sleepMs(1100);
      pressSlot(0, "approve", at(slotButton(0, "approve")), "touch");
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      await sleepMs(gap);
      pressSlot(1, "approve", at(slotButton(1, "approve")), "touch");
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      await waitFor(() => expect(receiptIn(1)).toBe(RECEIPT.approve), { timeout: 3000 });
      // B의 줄 안, 누른 단추 상자 밖(줄 왼쪽)을 누른다: A는 떠났지만 B는 아직 손 밑이다.
      if (inRowTap) pressSlot(1, "approve", { clientX: 40, clientY: SLOT_H + 40 }, "touch");
      await sleepMs(gap);
      const c = rowsIn("needsMe").indexOf(R(5));
      pressSlot(c, "approve", at(slotButton(c, "approve")), "touch");
      await waitFor(() => expect(decidedIds()).toEqual([A(1), A(8), A(5)]), { timeout: 3000 });
      expect(rowsIn("needsMe")).toEqual([R(1), R(8), R(5)]);
      await settleAnswers();
    },
    20_000
  );

  it.each(["approve", "reject"] as const)(
    "터치 · %s: A를 결정하고 1.6초 뒤 B를 결정한 다음, B를 누른 자리(5px 옆)를 +250·+600·+1300·+2500·+4000ms에 다시 눌러도 나간 결정은 A·B 2건이고 그 자리에는 B의 영수증이 남는다",
    async (which) => {
      mockSlotGeometry();
      board(new Set(), { mine: threeRuns });
      serveDecisions(40, { runs: threeRuns, approvals: threeApprovals });
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8), R(5)]), { timeout: 3000 });
      await sleepMs(1100);
      pressSlot(0, which, at(slotButton(0, which)), "touch");
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      await sleepMs(1600);
      const b = slotButton(1, which);
      pressSlot(1, which, at(b), "touch");
      fireEvent.pointerLeave(list(), { pointerType: "touch" });
      let elapsed = 0;
      for (const t of [250, 600, 1300, 2500, 4000]) {
        await sleepMs(Math.max(0, t - elapsed));
        expect(decidedIds()).toEqual([A(1), A(8)]);
        // 그 자리는 여전히 B의 칸이다(줄이 움직이지 않는다).
        expect(rowsIn("needsMe").slice(0, 2)).toEqual([R(1), R(8)]);
        pressSlot(1, which, at({ x: b.x + 5, y: b.y + 3 }), "touch");
        fireEvent.pointerLeave(list(), { pointerType: "touch" });
        await sleepMs(100);
        elapsed = t + 100;
        // 누를 때마다 센다 — 셋째 줄이 그 자리로 올라와 결정되면 바로 여기서 드러난다.
        expect(decidedIds()).toEqual([A(1), A(8)]);
      }
      await sleepMs(200);
      expect(decidedIds()).toEqual([A(1), A(8)]);
      expect(rowsIn("needsMe")).toEqual([R(1), R(8), R(5)]);
      expect(receiptIn(1)).toBe(RECEIPT[which]);
    },
    20_000
  );
});

describe("상태 칩·서랍의 낱말 (#5640 수리 3회차 H2·질문 ③)", () => {
  const R = (n: number) => `00000000-0000-7000-8000-0000000000c${n}`;
  const A = (n: number) => `00000000-0000-7000-8000-0000000000f${n}`;
  const run = (n: number, requestedBy = DOHYUN) =>
    runRow({ sessionId: R(n), runId: R(n), requestedBy, owner: AGENT, label: `에이전트 작업 ${n}`, phase: "awaiting_approval", trigger: "mention" });
  const chipOf = (runId: string) =>
    within(screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === runId)!).getByTestId("team-board-state").textContent;

  it("「응답 필요」는 그 구간의 줄만: 머리글 수 = 구간에서 「응답 필요」 칩이 선 줄 수, 구간 밖 승인 대기 줄(결정자 아님)은 「승인 대기」", async () => {
    // 내 맥 세션(권한 요청) + 내가 결정할 run R1 + 결정이 내 몫이 아닌 run R4.
    board(new Set([macSession.sessionId]), { mine: [run(1), run(4)] });
    api.fetchApprovals.mockResolvedValue([approval({ id: A(1), runId: R(1) })]);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([macSession.sessionId, R(1)]));
    const section = screen.getAllByTestId("work-jobs-section").find((s) => s.dataset.section === "needsMe")!;
    const count = Number(within(section).getByTestId("work-jobs-section-count").textContent);
    const chips = within(section).getAllByTestId("team-board-state").map((c) => c.textContent);
    expect(count).toBe(2);
    expect(chips.filter((c) => c === "응답 필요")).toHaveLength(count);
    expect(chipOf(R(4))).toBe("승인 대기");
    // 「되돌릴 수 없음」은 받은함과 같은 무게(`text-meta text-warn`)로 따로 선다(검수 M5).
    const note = within(screen.getAllByTestId("work-job").find((li) => li.querySelector<HTMLElement>('[data-testid="work-job-row"]')!.dataset.jobId === R(1))!).getAllByTestId("work-job-approval-note")[0]!;
    expect(note.textContent).toBe("되돌릴 수 없음");
    expect(note.className).toContain("text-warn");
    // 화면 전체에서 「응답 필요」 칩 = 머리글 수(이 픽스처에는 구간 밖 대기 세션이 없다).
    expect(screen.getAllByTestId("team-board-state").filter((c) => c.textContent === "응답 필요")).toHaveLength(count);
  });

  it("「팀 전체」의 승인 대기 줄은 「승인 대기」다(구간이 없다)", async () => {
    board(new Set(), { team: [run(6), run(7, SEOYEON)] });
    api.fetchApprovals.mockResolvedValue([approval({ id: A(6), runId: R(6) })]);
    render(mount("/work?who=team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-approval-link")).toHaveLength(2));
    expect(chipOf(R(6))).toBe("승인 대기");
    expect(chipOf(R(7))).toBe("승인 대기");
  });

  it("서랍은 연 줄과 같은 말을 한다: 결정자 줄은 칩 「응답 필요」와 「승인은 목록에서도 할 수 있어요」, 결정자가 아닌 줄은 「승인 대기」와 「승인은 그 카드에서 해요」", async () => {
    board(new Set(), { mine: [run(1), run(4)] });
    api.fetchApprovals.mockResolvedValue([approval({ id: A(1), runId: R(1) })]);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1)]));
    fireEvent.click(screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === R(1))!);
    let drawer = await screen.findByTestId("team-board-drawer");
    expect(within(drawer).getByTestId("team-board-state").textContent).toBe("응답 필요");
    expect(drawer.textContent).toContain("승인은 목록에서도 할 수 있어요");
    expect(drawer.textContent).not.toContain(WORK_JOBS_COPY.approvalHint);
    fireEvent.click(screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === R(4))!);
    await waitFor(() => expect(screen.getByTestId("team-board-drawer").dataset.sessionId).toBe(R(4)));
    drawer = screen.getByTestId("team-board-drawer");
    expect(within(drawer).getByTestId("team-board-state").textContent).toBe("승인 대기");
    expect(drawer.textContent).toContain(WORK_JOBS_COPY.approvalHint);
  });
});

describe("다른 승인의 문장은 이 단추 위에 서지 않는다 (#5640 수리 3회차, 검수 M6)", () => {
  const R = (n: number) => `00000000-0000-7000-8000-0000000000c${n}`;
  const A = (n: number) => `00000000-0000-7000-8000-0000000000f${n}`;
  const run = (n: number) =>
    runRow({ sessionId: R(n), runId: R(n), requestedBy: DOHYUN, owner: AGENT, label: `에이전트 작업 ${n}`, phase: "awaiting_approval", trigger: "mention" });
  const progressOf = (n: number, approvalId: string, intent: string) =>
    ({
      id: R(n),
      channelId: CH_AGENT_LAB,
      agentMemberId: AGENT.memberId,
      status: "running",
      phase: "awaiting_approval",
      leaseState: "live",
      stepCount: 0,
      ahead: [],
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      bundle: { approvalId, status: "pending", decisionMode: "inline", canDecide: true, actionType: "tool_call", intent },
    }) as AgentRunProgress;

  it("run 진행의 카드 문장은 그 승인의 것일 때만 결과 칸에 선다 — 같은 run의 다른 승인 문장이면 원장 행의 문장", async () => {
    board(new Set(), { mine: [run(1), run(8)] });
    api.fetchApprovals.mockResolvedValue([approval({ id: A(1), runId: R(1) }), approval({ id: A(8), runId: R(8) })]);
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_AGENT_LAB],
      realtime: null,
      // R1의 진행은 앞선 다른 승인(A9)의 문장을 들고 있다. R8은 그 승인(A8)의 문장이다.
      fetchProgress: async () => [progressOf(1, A(9), "앞선 승인의 문장: 고객에게 메일을 보내도 될까요?"), progressOf(8, A(8), "#launch 채널에 공지를 올려도 될까요?")],
    });
    try {
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]));
      const summaryOf = (runId: string) =>
        within(screen.getAllByTestId("work-job").find((li) => li.querySelector<HTMLElement>('[data-testid="work-job-row"]')!.dataset.jobId === runId)!)
          .getAllByTestId("work-job-approval-summary")[0]!.textContent;
      await waitFor(() => expect(summaryOf(R(8))).toBe("#launch 채널에 공지를 올려도 될까요?"));
      expect(summaryOf(R(1))).not.toContain("앞선 승인의 문장");
      expect(summaryOf(R(1))).toBe(approvalItem(approval({ id: A(1), runId: R(1) }), { name: AGENT.displayName, isAgent: true }, "#agent-lab", Date.now()).predicate);
    } finally {
      stop();
    }
  });
});
