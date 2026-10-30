// @vitest-environment jsdom

import { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SharedWorkSession, type WorkJobsMode } from "@momo/core/lib/api";
import { WORK_FILTER_STORAGE_KEY } from "@momo/core/features/workbench/workJobs";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import type { RealtimeHandle } from "@/lib/realtime";
import { CH_AGENT_LAB, ME, WS, runRow, sharedRow } from "../teamBoard/teamBoardFixtures";

// 「작업」 한 화면(ADR-0202 D1·D2, U1 #3842)을 실제 컴포넌트·훅으로 잰다. 네트워크 경계(코어
// `fetchWorkJobs`, 단건 `fetchSharedWorkSession`)만 바꾼다. 작업 원장 읽기(`fetchWorkSessions`)를
// 따로 세워 두는 이유는 팀 보드와 같다: 이 화면이 원장에서 줄을 가져오는 순간 붉어져야 한다.

const api = vi.hoisted(() => ({
  fetchWorkJobs: vi.fn(),
  fetchSharedWorkSession: vi.fn(),
  fetchWorkSessions: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  ...api,
}));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
const shell = vi.hoisted(() => ({ desktop: false }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => shell.desktop,
}));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => ({ groups: { channels: [{ id: CH_AGENT_LAB, kind: "public", name: "agent-lab" }], dms: [] } }),
}));

const { WorkJobsRoute } = await import("./WorkJobsRoute");

const OTHER = "00000000-0000-7000-8000-000000000102";
const realtime = {
  subscribeWorkSession: vi.fn(() => () => undefined),
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

const seen = { search: "" };
function Probe() {
  seen.search = useLocation().search;
  return null;
}

function mount(entry = "/work"): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
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
  );
}

/** 서버 흉내: `jobs` 모드면 `who`대로 이미 고른 줄을, `legacy`면 팀 보드 한 벌을 준다. */
function serve(byWho: { mine: SharedWorkSession[]; team: SharedWorkSession[] }, mode: WorkJobsMode = "jobs") {
  api.fetchWorkJobs.mockImplementation(async (_ws: string, opts: { who: "mine" | "team" }) => ({
    sessions: mode === "legacy" ? byWho.team : byWho[opts.who],
    nextCursor: null,
    mode,
  }));
}

const mineRun = runRow({
  agentReported: {
    resultKind: "pr_opened",
    tests: { passed: 12, failed: 0, notRun: 2 },
    nextAction: "merge_ok",
    commitSha: "abcdef1234567",
    toolCounts: { run: 12, edit: 4, read: 30 },
  },
  prUrl: "https://github.com/yeomyeonggeori/oort/pull/3842",
  state: "done",
  endedAtMs: Date.now() - 60_000,
  startedAtMs: Date.now() - 25 * 60_000,
  trigger: "work",
  phase: "succeeded",
});
const otherSession = sharedRow({
  sessionId: "00000000-0000-7000-8000-0000000000a9",
  owner: { memberId: OTHER, displayName: "김민지" },
  label: "결제 웹훅 재시도 고치기",
  state: "running",
});
const approvalRun = runRow({
  sessionId: "00000000-0000-7000-8000-0000000000c7",
  runId: "00000000-0000-7000-8000-0000000000c7",
  label: "#launch 채널에 공지 올리기",
  phase: "awaiting_approval",
  trigger: "mention",
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchSharedWorkSession.mockRejectedValue(new ApiError(404, "shared work session not found"));
  api.fetchWorkSessions.mockResolvedValue([]);
  shell.desktop = false;
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

describe("「작업」 한 화면: 필터 (ADR-0202 D2)", () => {
  it("기본은 「내 것」이고 서버에 who=mine으로 묻는다. 작업 원장은 읽지 않는다", async () => {
    serve({ mine: [mineRun], team: [mineRun, otherSession] });
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(screen.getByTestId("work-jobs-route").dataset.filter).toBe("mine");
    expect(screen.getByTestId("work-jobs-filter-mine").getAttribute("aria-pressed")).toBe("true");
    expect(api.fetchWorkJobs).toHaveBeenCalledWith(WS, expect.objectContaining({ who: "mine" }));
    expect(api.fetchWorkJobs).not.toHaveBeenCalledWith(WS, expect.objectContaining({ who: "team" }));
    expect(api.fetchWorkJobs.mock.calls.every((call) => call[1].who === "mine")).toBe(true);
    expect(screen.getAllByTestId("work-job-row")).toHaveLength(1);
    expect(api.fetchWorkSessions).not.toHaveBeenCalled();
  });

  it("「팀 전체」를 누르면 who=team으로 읽고, 주소에 who=team이 서고, 기기에 기억한다", async () => {
    serve({ mine: [mineRun], team: [mineRun, otherSession] });
    render(mount());
    await screen.findAllByTestId("work-job-row");
    fireEvent.click(screen.getByTestId("work-jobs-filter-team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(2));
    expect(new URLSearchParams(seen.search).get("who")).toBe("team");
    expect(window.localStorage.getItem(WORK_FILTER_STORAGE_KEY)).toBe("team");
    expect(api.fetchWorkJobs).toHaveBeenCalledWith(WS, expect.objectContaining({ who: "team" }));
  });

  it("옛 팀 링크 ?view=team은 「팀 전체」로 연다", async () => {
    serve({ mine: [mineRun], team: [mineRun, otherSession] });
    render(mount("/work?view=team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(2));
    expect(screen.getByTestId("work-jobs-route").dataset.filter).toBe("team");
  });

  it("기기에 「팀 전체」를 기억했으면 주소가 말하지 않을 때 그것으로 연다", async () => {
    window.localStorage.setItem(WORK_FILTER_STORAGE_KEY, "team");
    serve({ mine: [mineRun], team: [mineRun, otherSession] });
    render(mount());
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(2));
  });

  it("저장소가 막혀도(읽기·쓰기 모두 던짐) 화면은 「내 것」으로 서고 필터도 바뀐다", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    serve({ mine: [mineRun], team: [mineRun, otherSession] });
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(screen.getByTestId("work-jobs-route").dataset.filter).toBe("mine");
    fireEvent.click(screen.getByTestId("work-jobs-filter-team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(2));
  });

  it("옛 서버(legacy): 안내가 서고, 「내 것」은 팀 보드 한 벌에서 화면이 고른다", async () => {
    serve({ mine: [], team: [mineRun, otherSession] }, "legacy");
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(screen.getByTestId("work-jobs-legacy").textContent).toContain("호스팅 에이전트의 작업만");
    expect(screen.getAllByTestId("work-job-row").map((r) => r.dataset.jobId)).toEqual([mineRun.sessionId]);
    fireEvent.click(screen.getByTestId("work-jobs-filter-team"));
    await waitFor(() => expect(screen.getAllByTestId("work-job-row")).toHaveLength(2));
  });
});

describe("「작업」 한 화면: 결과 중심 줄 (ADR-0202 D1)", () => {
  it("줄은 맡긴 사람 → 에이전트, 상태, 결과(에이전트 보고 꼬리표), 걸린 시간, 채널을 말하고 PR 링크가 형제로 선다", async () => {
    serve({ mine: [mineRun], team: [] });
    render(mount());
    const row = await screen.findByTestId("work-job-row");
    const text = row.textContent ?? "";
    for (const part of ["온보딩 문구 다듬기", "곽성재 → 그록봇", "끝남 · PR", "24분 동안 작업", "#agent-lab"]) {
      expect(text).toContain(part);
    }
    const result = within(row).getAllByTestId("work-job-result")[0]!;
    expect(result.textContent).toContain("에이전트 보고");
    expect(result.textContent).toContain("PR을 열었어요 · 테스트 통과 12 · 안 돌림 2 · 머지해도 된대요");
    const pr = screen.getByTestId("work-job-pr");
    expect(pr.getAttribute("href")).toBe("https://github.com/yeomyeonggeori/oort/pull/3842");
    expect(row.contains(pr)).toBe(false);
  });

  it("「지금 진행 n」은 보이는 줄 가운데 끝나지 않은 것만 센다", async () => {
    serve({ mine: [mineRun, approvalRun], team: [] });
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(screen.getByTestId("work-jobs-running").textContent).toBe("지금 진행 1");
  });

  it("승인 필요 줄은 맨 위에 서고, 승인 단추 없이 카드가 있는 채널로 간다(대신 승인 없음, D5)", async () => {
    serve({ mine: [mineRun, approvalRun], team: [] });
    render(mount());
    const rows = await screen.findAllByTestId("work-job-row");
    expect(rows[0]!.dataset.jobId).toBe(approvalRun.sessionId);
    expect(within(rows[0]!).getByTestId("team-board-state").textContent).toBe("승인 필요");
    const link = screen.getByTestId("work-job-approval-link");
    expect(link.getAttribute("href")).toBe(`/c/${CH_AGENT_LAB}`);
    // 「작업」 화면에는 결정 단추가 없다.
    const decisions = screen
      .queryAllByRole("button")
      .filter((b) => /^(승인|거부|허락)(하기)?$/.test((b.textContent ?? "").trim()));
    expect(decisions).toEqual([]);
    expect(document.querySelector('[data-testid^="approval-decision"]')).toBeNull();
    fireEvent.click(link);
    await screen.findByTestId("channel-page");
  });

  it("줄을 누르면 서랍이 열리고 「에이전트 보고」 절이 닫힌 칸만 키-값으로 말한다. Esc가 닫는다", async () => {
    serve({ mine: [mineRun], team: [] });
    render(mount());
    fireEvent.click(await screen.findByTestId("work-job-row"));
    const drawer = await screen.findByTestId("team-board-drawer");
    const reported = within(drawer).getByTestId("work-job-reported");
    for (const part of ["에이전트 보고", "PR을 열었어요", "테스트 통과 12", "머지해도 된대요", "abcdef123456", "명령 12 · 수정 4 · 읽기 30"]) {
      expect(reported.textContent).toContain(part);
    }
    expect(new URLSearchParams(seen.search).get("card")).toBe(mineRun.sessionId);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("team-board-drawer")).toBeNull());
  });

  it("옛 서버 줄(에이전트 보고 없음)은 꼬리표 없이 PR 번호만, 끝나지 않았으면 「아직 결과 없음」", async () => {
    serve({ mine: [runRow({ prUrl: "https://github.com/acme/oort/pull/12" }), otherSession], team: [] });
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(screen.queryByTestId("work-job-reported-tag")).toBeNull();
    const [first, second] = screen.getAllByTestId("work-job-row");
    expect(within(first!).getAllByTestId("work-job-result")[0]!.textContent).toBe("PR #12");
    expect(within(second!).getAllByTestId("work-job-result")[0]!.textContent).toBe("아직 결과 없음");
    expect(second!.textContent).toContain("김민지 → claude");
  });

  it("j/k로 줄을 옮긴다(로빙 탭 정지 한 곳)", async () => {
    serve({ mine: [mineRun, otherSession], team: [] });
    render(mount());
    const rows = await screen.findAllByTestId("work-job-row");
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "j" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "k" });
    expect(document.activeElement).toBe(rows[0]);
  });
});

describe("「작업」 한 화면: 네 상태", () => {
  it("비면 필터에 맞는 한 줄 + 채널로 가는 행동", async () => {
    serve({ mine: [], team: [] });
    render(mount());
    const empty = await screen.findByTestId("work-jobs-empty");
    expect(empty.textContent).toContain("내가 맡긴 작업이 아직 없어요");
  });

  it("처음 읽기가 실패하면 무슨 일인지와 다시 불러오기", async () => {
    api.fetchWorkJobs.mockRejectedValue(new ApiError(500, "boom"));
    render(mount());
    const error = await screen.findByTestId("work-jobs-error");
    expect(error.textContent).toContain("작업을 불러오지 못했어요");
    serve({ mine: [mineRun], team: [] });
    fireEvent.click(screen.getByTestId("work-jobs-retry"));
    await screen.findByTestId("work-job-row");
  });
});

describe("데스크탑 「내 것」의 「이 기기」 줄 (ADR-0202 D6)", () => {
  it("데스크탑 「내 것」에서만 서고 터미널 격자 주소로 간다", async () => {
    shell.desktop = true;
    serve({ mine: [mineRun], team: [mineRun] });
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(screen.getByTestId("work-jobs-open-terminals").getAttribute("href")).toBe("/work?view=terminals");
    fireEvent.click(screen.getByTestId("work-jobs-filter-team"));
    await waitFor(() => expect(screen.queryByTestId("work-jobs-this-device")).toBeNull());
  });

  it("웹에는 이 기기 터미널이 없어 줄이 없다", async () => {
    serve({ mine: [mineRun], team: [] });
    render(mount());
    await screen.findAllByTestId("work-job-row");
    expect(screen.queryByTestId("work-jobs-this-device")).toBeNull();
  });
});
