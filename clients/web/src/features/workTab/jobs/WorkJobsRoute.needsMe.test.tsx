// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
function mount(
  entry = "/work",
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
): ReactNode {
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
    // 결정이 오면 다시 읽는다. 화면에 떠 있는 동안 그 칸은 자리를 지키고 결과 줄이 된다(#5738) — 「응답 필요」 수는 0.
    board(new Set());
    act(() => {
      for (const h of subscribed) h.onAcpEvent(frame("approval.decided", macSession.sessionId));
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("work-job-approval-settled")[0]!.textContent).toBe("이제 응답하지 않아도 돼요")
    );
    expect(rowsIn("needsMe")).toEqual([macSession.sessionId]);
    expect(rowsIn("now")).not.toContain(macSession.sessionId);
    expect(screen.getAllByTestId("work-jobs-section-count")[0]!.textContent).toBe("0");
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
    // 돌아오는 것이 칸이 새로 서는 때다(#5738). 캐시의 낡은 목록으로 먼저 선 칸은 새로 읽은 목록이 오면 그 자리의 결과 줄이 되고
    // (아래 줄을 올리지 않는다), 아직 묻는 줄은 없다.
    await waitFor(() => expect(screen.getAllByTestId("work-jobs-section-count")[0]!.textContent).toBe("0"));
    expect(screen.queryByTestId("work-job-permission-open")).toBeNull();
    expect(rowsIn("now")).toContain(run.sessionId);
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

  it("승인은 인박스와 같은 라우트(`POST …/approvals/{id}/decision`)로 나가고, 원장·목록을 다시 읽어도 영수증을 보인 채 그 칸에 남으며(#5738) 캐럿은 그 줄에 남는다", async () => {
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
    // 원장이 그 승인을 뺐어도 줄은 영수증을 보인 채 그 자리다 — 화면에 떠 있는 동안 내내(#5738).
    await sleepMs(300);
    expect(rowsIn("needsMe")).toEqual([R(1), R(2)]);
    expect(within(jobOf(R(1))).getAllByTestId("work-job-approval-settled")[0]!.textContent).toBe("승인을 기록했어요.");
    expect(screen.getByTestId("work-jobs-decision-note").textContent).toBe("승인을 기록했어요.");
    const row = screen.getAllByTestId("work-job-row").find((r) => r.dataset.jobId === R(1))!;
    expect(document.activeElement).toBe(row);
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

// ---- 「응답 필요」의 칸은 화면에 떠 있는 동안 자리를 지킨다 (#5738) -------------------------------------------------------------
//
// jsdom에는 자리(좌표)가 없다. 그래서 여기서는 구조를 잰다: 칸의 순서(n번째 칸이 어느 작업인가)와 그 칸에 무엇이 섰는가(결정 단추 ·
// 결과 한 줄), 그리고 서버에 나간 결정. px(줄이 움직이지 않음)와 「그 점 밑」은 `scripts/capture-5640.mjs`(진짜 브라우저 두 엔진)가 잰다.
// 포인터 누름은 `detail: 1`, 키보드 누름(Enter)은 `detail: 0`이다.

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("「응답 필요」의 칸은 화면에 떠 있는 동안 자리를 지킨다 (#5738)", () => {
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

  /**
   * 실제 서버 흉내(검수 2·3회차): 결정 POST·원장·목록 모두 `roundTripMs` 뒤에 답한다. **거부하면 그 run을 바로 끝낸다**(보드 `stopped`).
   * 승인하면 run은 줄을 선다(`queued` → 실행 줄은 `idle`). 목록 순서도 실제처럼 **결정이 닿은 run이 맨 앞**이다(`ORDER BY activity_us
   * DESC`). `failFirst`면 첫 결정 POST가 그 상태로 실패한다(결정은 기록되지 않는다). `decideMs`는 결정 POST만의 왕복이다.
   */
  function serveDecisions(
    roundTripMs: number,
    opts: { runs?: SharedWorkSession[]; approvals?: Approval[]; failFirst?: 500 | 409; decideMs?: number } = {}
  ) {
    const decided = new Map<string, boolean>();
    const runs = opts.runs ?? twoRuns;
    const asks = opts.approvals ?? twoApprovals;
    let failures = opts.failFirst === undefined ? 0 : 1;
    const board = () => {
      const now = runs.map((r) => {
        const approve = decided.get(r.runId!);
        if (approve === undefined) return r;
        if (!approve) return { ...r, status: "cancelled", state: "stopped" as const, phase: "cancelled", endedAtMs: Date.now() };
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
      return asks.filter((a) => !decided.has(a.id));
    });
    api.authedResponse.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (!String(path).endsWith("/decision")) return httpResponse(404, {});
      const approvalId = decodeURIComponent(String(path).split("/").at(-2)!);
      const approve = (JSON.parse(init?.body ?? "{}") as { approve?: boolean }).approve !== false;
      await sleepMs(opts.decideMs ?? roundTripMs);
      if (failures > 0) {
        failures -= 1;
        return opts.failFirst === 409 ? httpResponse(409, { status: "pending" }) : httpResponse(500, {});
      }
      decided.set(approvalId, approve);
      const ask = asks.find((a) => a.id === approvalId);
      if (ask) decided.set(ask.runId!, approve);
      return httpResponse(200, { status: approve ? "approved" : "rejected", decided_by: ME, decided_at_ms: Date.now() });
    });
    return { decide: (approvalId: string) => decided.set(approvalId, true) };
  }
  const decidedIds = () => decisionCalls().map(([path]) => decodeURIComponent(String(path).split("/").at(-2)!));
  const decidedHow = () => decisionCalls().map(([, init]) => (JSON.parse((init as { body: string }).body) as { approve: boolean }).approve);
  const needsMe = () => screen.getAllByTestId("work-jobs-section").find((s) => s.dataset.section === "needsMe")!;
  const needsMeSlot = (n: number) => within(needsMe()).getAllByTestId("work-job")[n]!;
  /** 그 칸을 포인터로 누른다: 결정 단추가 있으면 그 단추, 없으면 그 칸의 결정 층(결과 한 줄). */
  const pressSlot = (n: number, which: "approve" | "reject" = "approve") => {
    const li = needsMeSlot(n);
    const target =
      li.querySelector<HTMLElement>(`[data-testid="work-job-approval-${which}"]`) ??
      li.querySelector<HTMLElement>('[data-testid="work-job-control-box"]') ??
      li;
    fireEvent.click(target, { detail: 1 });
  };
  const resultIn = (n: number) => within(needsMeSlot(n)).queryAllByTestId("work-job-approval-settled")[0]?.textContent ?? null;
  const needsMeCount = () => Number(within(needsMe()).getByTestId("work-jobs-section-count").textContent);
  const RECEIPT = { approve: "승인을 기록했어요.", reject: "거부를 기록했어요." } as const;
  const ELSEWHERE = "이제 응답하지 않아도 돼요";

  it.each([
    ["approve", 40],
    ["approve", 300],
    ["reject", 40],
    ["reject", 300],
  ] as const)(
    "%s · 서버 왕복 %ims: 결정한 칸은 빠지지 않고 같은 칸의 결과 줄이 된다 — 같은 자리를 몇 번 다시 눌러도 나간 결정은 A 1건, 거부해 run이 끝나도 칸 순서 그대로",
    async (which, roundTripMs) => {
      board(new Set(), { mine: twoRuns });
      serveDecisions(roundTripMs);
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      pressSlot(0, which);
      await waitFor(() => expect(resultIn(0)).toBe(RECEIPT[which]), { timeout: 3000 });
      // 원장·목록이 다시 읽혀(거부면 run이 끝나고, 결정한 run이 목록 맨 앞으로 옴) 줄이 옮겨 갈 수 있는 때가 지나도 그대로다.
      for (let i = 0; i < 6; i += 1) {
        await sleepMs(roundTripMs + 30);
        pressSlot(0, which);
      }
      expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
      expect(rowsIn("now")).not.toContain(R(1));
      expect(rowsIn("done")).not.toContain(R(1));
      expect(resultIn(0)).toBe(RECEIPT[which]);
      expect(needsMeSlot(0).querySelector("[data-decision]")).toBeNull();
      expect(needsMeSlot(1).querySelector("[data-decision]")).not.toBeNull();
      expect(decidedIds()).toEqual([A(1)]);
      expect(decidedHow()).toEqual([which === "approve"]);
      // 결과 줄은 단추가 서 있던 그 상자에 선다(같은 상자 = 같은 높이; px은 브라우저 하네스가 잰다).
      expect(within(needsMeSlot(0)).getAllByTestId("work-job-control-box")).toHaveLength(1);
      // 머리글 수 = 아직 묻는 칸, 결과 칸의 칩은 「응답 필요」가 아니다.
      expect(needsMeCount()).toBe(1);
      expect(within(needsMeSlot(0)).getByTestId("team-board-state").textContent).not.toBe("응답 필요");
    },
    15_000
  );

  it.each([60, 300, 600])(
    "네 줄을 차례로(결정 왕복 %ims): 누른 만큼 다 결정되고 칸 순서는 처음 그대로다",
    async (roundTripMs) => {
      const four = [runOf(1), runOf(2), runOf(3), runOf(4)];
      board(new Set(), { mine: four });
      serveDecisions(roundTripMs, {
        runs: four,
        approvals: [1, 2, 3, 4].map((n) => approval({ id: A(n), runId: R(n) })),
      });
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(2), R(3), R(4)]), { timeout: 3000 });
      for (let n = 0; n < 4; n += 1) {
        pressSlot(n, n % 2 === 0 ? "approve" : "reject");
        await sleepMs(300);
      }
      await waitFor(() => expect(decidedIds()).toHaveLength(4), { timeout: 5000 });
      await waitFor(() => expect([0, 1, 2, 3].map(resultIn).every((t) => t !== null)).toBe(true), { timeout: 5000 });
      expect(decidedIds()).toEqual([A(1), A(2), A(3), A(4)]);
      expect(rowsIn("needsMe")).toEqual([R(1), R(2), R(3), R(4)]);
    },
    20_000
  );

  it("느린 답(1.5초)이고 원장이 답보다 먼저 그 승인을 빼도: 보내는 칸은 「보내는 중」 단추를 지키고, 같은 자리를 다시 눌러도 두 번 나가지 않으며, 답이 오면 그 칸의 결과 줄", async () => {
    board(new Set(), { mine: twoRuns });
    const server = serveDecisions(20, { decideMs: 1500 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    render(mount("/work", client));
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    pressSlot(0);
    await waitFor(() => expect(within(needsMeSlot(0)).getByTestId("work-job-approval-approve").textContent).toBe("보내는 중"));
    // 다른 길(대화 카드의 같은 결정이 먼저 닿음)로 원장이 그 승인을 뺐다 — 그래도 칸은 답을 받을 때까지 그 칸이다.
    server.decide(A(1));
    await act(async () => {
      await client.invalidateQueries();
    });
    await sleepMs(100);
    expect(resultIn(0)).toBeNull();
    for (let i = 0; i < 4; i += 1) {
      pressSlot(0);
      await sleepMs(250);
    }
    expect(decidedIds()).toEqual([A(1)]);
    await waitFor(() => expect(resultIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
    pressSlot(0);
    await sleepMs(100);
    expect(decidedIds()).toEqual([A(1)]);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
  });

  it.each([500, 409] as const)(
    "결정이 %i로 실패하면 단추는 그 칸에 다시 서고 실패 문장은 단추 옆 한 줄(같은 상자) — 같은 자리를 다시 누르면 그 줄이 다시 시도된다(다른 줄 결정 0)",
    async (status) => {
      board(new Set(), { mine: twoRuns });
      serveDecisions(20, { failFirst: status, decideMs: 300 });
      render(mount());
      await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
      pressSlot(0);
      const error = await within(needsMeSlot(0)).findByTestId("work-job-approval-error", {}, { timeout: 3000 });
      expect(error.getAttribute("role")).toBe("alert");
      // 단추 옆(같은 줄의 형제)이지 단추 아래 새 줄이 아니다 — 상자가 하나뿐이다.
      expect(error.parentElement!.contains(within(needsMeSlot(0)).getByTestId("work-job-approval-approve"))).toBe(true);
      expect(within(needsMeSlot(0)).getAllByTestId("work-job-control-box")).toHaveLength(1);
      expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
      pressSlot(0);
      await waitFor(() => expect(resultIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
      expect(decidedIds()).toEqual([A(1), A(1)]);
      expect(needsMeSlot(1).querySelector("[data-decision]")).not.toBeNull();
    },
    15_000
  );

  it("내가 일으키지 않은 변화: 위 칸이 다른 곳에서 결정돼도 그 칸은 「이제 응답하지 않아도 돼요」 결과 줄로 남고, 새 요청은 맨 아래에 붙고, 서버가 순서를 바꿔도 칸은 그대로다", async () => {
    const three = [runOf(1), runOf(2), runOf(3)];
    let asks = [1, 2].map((n) => approval({ id: A(n), runId: R(n) }));
    let order = [runOf(1), runOf(2), runOf(3)];
    api.fetchWorkJobs.mockImplementation(async () => ({ sessions: order, nextCursor: null, mode: "jobs" }));
    api.fetchApprovals.mockImplementation(async () => asks);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    render(mount("/work", client));
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(2)]));
    const reread = async () => {
      await act(async () => {
        await client.invalidateQueries();
      });
      await sleepMs(50);
    };
    // (가) 다른 기기가 위 칸(A)을 결정했다.
    asks = asks.filter((a) => a.id !== A(1));
    await reread();
    expect(rowsIn("needsMe")).toEqual([R(1), R(2)]);
    expect(resultIn(0)).toBe(ELSEWHERE);
    expect(needsMeSlot(0).querySelector("[data-decision]")).toBeNull();
    expect(needsMeSlot(1).querySelector("[data-decision]")).not.toBeNull();
    // (나) 새 요청(C)이 왔다 — 서버는 그 run을 맨 앞에 준다.
    asks = [approval({ id: A(3), runId: R(3) }), ...asks];
    order = [runOf(3), runOf(1), runOf(2)];
    await reread();
    expect(rowsIn("needsMe")).toEqual([R(1), R(2), R(3)]);
    // (다) 서버가 순서를 바꿨다.
    order = [runOf(2), runOf(3), runOf(1)];
    asks = [...asks].reverse();
    await reread();
    expect(rowsIn("needsMe")).toEqual([R(1), R(2), R(3)]);
    expect(needsMeCount()).toBe(2);
    expect(decidedIds()).toEqual([]);
    void three;
  });

  it("같은 run의 다음 승인은 새 요청이라 맨 아래 새 칸에 서고, 방금 결정한 칸은 그 자리의 결과 줄이다", async () => {
    board(new Set(), { mine: twoRuns });
    const second = approval({ id: A(9), runId: R(1) });
    serveDecisions(40, { approvals: [...twoApprovals, second] });
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    pressSlot(0);
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8), R(1)]), { timeout: 3000 });
    expect(resultIn(0)).toBe(RECEIPT.approve);
    expect(resultIn(2)).toBeNull();
    pressSlot(0);
    await sleepMs(100);
    expect(decidedIds()).toEqual([A(1)]);
    pressSlot(2);
    await waitFor(() => expect(decidedIds()).toEqual([A(1), A(9)]), { timeout: 3000 });
    // 같은 작업이 칸 둘에 서도 줄 열쇠는 겹치지 않는다(로빙 초점·캐럿 복귀가 이 열쇠로 찾는다).
    const keys = within(needsMe()).getAllByTestId("work-job-row").map((r) => r.dataset.rowKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("칸이 정리되는 때는 「내 작업/팀 전체」를 갈아탈 때와 「작업」을 떠났다 돌아올 때뿐이다", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(20);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    pressSlot(0);
    await waitFor(() => expect(resultIn(0)).toBe(RECEIPT.approve), { timeout: 3000 });
    await sleepMs(200);
    expect(rowsIn("needsMe")).toEqual([R(1), R(8)]);
    fireEvent.click(screen.getByTestId("work-jobs-filter-team"));
    await waitFor(() => expect(sectionKeys()).not.toContain("needsMe"));
    fireEvent.click(screen.getByTestId("work-jobs-filter-mine"));
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(8)]), { timeout: 3000 });
    expect(rowsIn("now")).toContain(R(1));
  });

  it("Enter 연타(키보드): A의 승인에서 Enter를 거듭 쳐도 나간 결정은 1건이고 초점은 다음 줄의 결정 단추로 가지 않는다(A의 줄 → 그 서랍)", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(40);
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    within(needsMeSlot(0)).getByTestId("work-job-approval-approve").focus();
    for (const at of [0, 120, 200, 380]) {
      await sleepMs(at === 0 ? 0 : 120);
      fireEvent.click(document.activeElement!, { detail: 0 });
    }
    await sleepMs(300);
    expect(decidedIds()).toEqual([A(1)]);
    expect(document.activeElement?.hasAttribute("data-decision")).toBe(false);
    // 결정 뒤 초점은 A의 줄 단추가 받고, 이어진 Enter는 A의 서랍을 연다(다른 줄이 아니다).
    expect(new URLSearchParams(seen.search).get("card")).toBe(R(1));
  });

  it("끊겼을 때 단추 자리의 끊김 한 줄도 단추와 같은 상자 하나에 선다(이어지면 그 상자에 단추가 돌아온다)", async () => {
    board(new Set(), { mine: twoRuns });
    serveDecisions(20);
    net.offline = true;
    render(mount());
    await waitFor(() => expect(rowsIn("needsMe")).toEqual([R(1), R(8)]), { timeout: 3000 });
    await waitFor(() => expect(within(needsMeSlot(0)).queryByTestId("work-job-approval-offline")).not.toBeNull());
    expect(within(needsMeSlot(0)).getAllByTestId("work-job-control-box")).toHaveLength(1);
    expect(needsMeSlot(0).querySelector("[data-decision]")).toBeNull();
  });
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
