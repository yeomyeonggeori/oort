import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentReportedFromWire,
  fetchWorkJobs,
  resetWorkJobsDetection,
  sharedWorkSessionFromWire,
  workJobsKnownLegacy,
  type SharedWorkSession,
} from "../../lib/api";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import {
  WORK_JOBS_COPY,
  inProgressCount,
  inProgressLabel,
  initialWorkFilter,
  itemsForFilter,
  reportedSummary,
  requesterToAgent,
  searchWithFilter,
  toolCountsText,
  workFilterFromSearch,
  workJobRow,
  workJobSections,
} from "./workJobs";

const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-0000000000aa";
const NOW = 1_790_000_000_000;

function wireRun(over: Record<string, unknown> = {}) {
  return {
    source: "run",
    runId: "00000000-0000-7000-8000-0000000000c1",
    requestedBy: { memberId: ME, displayName: "구민수" },
    stepCount: 3,
    origin: "agent_run",
    label: "온보딩 문구 다듬기",
    folderLabel: null,
    status: "running",
    owner: { memberId: AGENT, displayName: "그록봇" },
    homeChannel: { id: "c1", name: "agent-lab" },
    startedAtMs: NOW - 12 * 60_000,
    endedAtMs: null,
    sharedAtMs: null,
    repo: null,
    branch: null,
    harness: "hosted",
    state: "running",
    stages: [],
    diff: { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null },
    prUrl: null,
    lastActivityAt: NOW / 1000,
    ...over,
  };
}

function wireSession(over: Record<string, unknown> = {}) {
  return {
    source: "session",
    sessionId: "00000000-0000-7000-8000-0000000000d1",
    origin: "local_pty",
    label: "결제 버그 고치기",
    folderLabel: "oort",
    status: "running",
    owner: { memberId: OTHER, displayName: "김민지" },
    homeChannel: { id: "c2", name: "workbench" },
    startedAtMs: NOW - 3 * 60_000,
    endedAtMs: null,
    sharedAtMs: NOW - 3 * 60_000,
    repo: "oort",
    branch: "fix/pay",
    harness: "claude",
    state: "running",
    stages: [],
    diff: { added: 3, deleted: 1, files: 1, ahead: 0, behind: 0, uncommitted: 1 },
    prUrl: null,
    lastActivityAt: NOW / 1000,
    ...over,
  };
}

function row(wire: Record<string, unknown>): SharedWorkSession {
  const item = sharedWorkSessionFromWire(wire);
  if (item === null) throw new Error("fixture did not parse");
  return item;
}

describe("에이전트 보고 칸 읽기 (ADR-0162 증보 5 C1·C2)", () => {
  it("닫힌 칸을 읽고 sha는 소문자로, 칸이 하나도 없으면 null", () => {
    expect(
      agentReportedFromWire({
        resultKind: "pr_opened",
        tests: { passed: 12, failed: 1, notRun: 0 },
        nextAction: "please_test",
        commitSha: "ABCDEF1",
        toolCounts: { run: 12, edit: 4, read: 30 },
      })
    ).toEqual({
      resultKind: "pr_opened",
      tests: { passed: 12, failed: 1, notRun: 0 },
      nextAction: "please_test",
      commitSha: "abcdef1",
      toolCounts: { run: 12, edit: 4, read: 30 },
    });
    expect(agentReportedFromWire({})).toBeNull();
    expect(agentReportedFromWire(null)).toBeNull();
    expect(agentReportedFromWire("pr_opened")).toBeNull();
  });

  it("모르는 값·범위 밖 숫자·모자란 tests는 그 칸만 비운다(예외 없음)", () => {
    const got = agentReportedFromWire({
      resultKind: "shipped_to_moon",
      tests: { passed: 3, failed: -1, notRun: 0 },
      nextAction: "merge_ok",
      commitSha: "xyz",
      toolCounts: { run: 100_001, teleport: 3 },
    });
    expect(got).toEqual({
      resultKind: null,
      tests: null,
      nextAction: "merge_ok",
      commitSha: null,
      toolCounts: null,
    });
  });

  it("세션 줄에는 에이전트 보고·trigger·phase가 실리지 않는다(run 줄에만)", () => {
    const s = row(wireSession({ agentReported: { resultKind: "no_change" }, trigger: "work", phase: "running" }));
    expect(s.agentReported).toBeNull();
    expect(s.trigger).toBeNull();
    expect(s.phase).toBeNull();
    const r = row(wireRun({ agentReported: { resultKind: "no_change" }, trigger: "thread_reply", phase: "awaiting_approval" }));
    expect(r.agentReported?.resultKind).toBe("no_change");
    expect(r.trigger).toBe("thread_reply");
    expect(r.phase).toBe("awaiting_approval");
  });

  it("옛 서버 줄(새 필드 없음)은 지금과 같은 줄로 읽힌다", () => {
    const r = row(wireRun());
    expect(r.agentReported).toBeNull();
    expect(r.trigger).toBeNull();
    expect(r.phase).toBeNull();
    expect(r.state).toBe("running");
  });
});

describe("줄 모델 (ADR-0202 D1)", () => {
  it("run 줄: 맡긴 사람 → 에이전트, 걸린 시간은 공용 경과 함수, 결과는 에이전트 보고", () => {
    const job = workJobRow(
      row(
        wireRun({
          state: "done",
          endedAtMs: NOW - 2 * 60_000,
          prUrl: "https://github.com/acme/oort/pull/12",
          agentReported: {
            resultKind: "pr_opened",
            tests: { passed: 12, failed: 0, notRun: 2 },
            nextAction: "merge_ok",
          },
        })
      ),
      NOW
    );
    expect(requesterToAgent(job)).toBe("구민수 → 그록봇");
    expect(job.agentIsMember).toBe(true);
    expect(job.finished).toBe(true);
    expect(job.duration?.kind).toBe("worked");
    expect(job.duration?.label).toBe("10분 동안 작업");
    expect(job.durationText).toBe("10분 동안 작업");
    expect(job.pr?.number).toBe("PR #12");
    expect(reportedSummary(job.reported)).toBe("PR을 열었어요 · 테스트 통과 12 · 안 돌림 2 · 머지해도 된대요");
  });

  it("세션 줄: 주인이 맡긴 사람이고 하네스가 맡은 쪽, 도는 동안은 시계", () => {
    const job = workJobRow(row(wireSession()), NOW);
    expect(requesterToAgent(job)).toBe("김민지 → claude");
    expect(job.agentIsMember).toBe(false);
    expect(job.duration?.kind).toBe("clock");
    expect(job.durationText).toBe("3분째");
    expect(job.reported).toBeNull();
  });

  it("막 시작한 일은 시계 눈금이 아니라 「방금 시작」", () => {
    const job = workJobRow(row(wireSession({ startedAtMs: NOW - 20_000 })), NOW);
    expect(job.durationText).toBe("방금 시작");
  });

  it("맡긴 사람 기록이 없는 옛 run은 에이전트 이름만", () => {
    const job = workJobRow(row(wireRun({ requestedBy: null })), NOW);
    expect(requesterToAgent(job)).toBe("그록봇");
  });

  it("phase=awaiting_approval인 run만 「승인 필요」이고 「지금」 맨 위에 선다", () => {
    const waiting = workJobRow(row(wireRun({ runId: "00000000-0000-7000-8000-0000000000c2", phase: "awaiting_approval" })), NOW);
    const working = workJobRow(row(wireRun()), NOW);
    const done = workJobRow(row(wireRun({ runId: "00000000-0000-7000-8000-0000000000c3", state: "done", endedAtMs: NOW })), NOW);
    expect(waiting.awaitingApproval).toBe(true);
    expect(waiting.statusLabel).toBe("승인 필요");
    expect(working.awaitingApproval).toBe(false);
    const sections = workJobSections([working, done, waiting]);
    expect(sections.map((s) => s.key)).toEqual(["now", "done"]);
    expect(sections[0]!.rows.map((r) => r.id)).toEqual([waiting.id, working.id]);
    expect(inProgressCount([working, done, waiting])).toBe(2);
  });

  it("옛 서버(phase 없음)는 승인 필요를 지어내지 않는다", () => {
    const job = workJobRow(row(wireRun()), NOW);
    expect(job.awaitingApproval).toBe(false);
    expect(job.statusLabel).toBe("실행 중");
  });

  it("「지금 진행 n」은 다음 쪽이 남으면 n+", () => {
    expect(inProgressLabel(3, false)).toBe("지금 진행 3");
    expect(inProgressLabel(3, true)).toBe("지금 진행 3+");
  });

  it("테스트 수가 모두 0이면 줄 요약에서 테스트를 말하지 않는다", () => {
    expect(
      reportedSummary({ resultKind: "no_change", tests: { passed: 0, failed: 0, notRun: 0 }, nextAction: "none", commitSha: null, toolCounts: null })
    ).toBe("바꾼 것이 없어요");
  });

  it("VM 안 개수는 닫힌 범주 순서로 말한다", () => {
    expect(toolCountsText({ read: 30, run: 12, edit: 4 })).toBe("명령 12 · 수정 4 · 읽기 30");
  });
});

describe("필터 (ADR-0202 D2)", () => {
  it("주소 → 기기 기억 → 기본 「내 것」", () => {
    expect(initialWorkFilter("", null)).toBe("mine");
    expect(initialWorkFilter("", "team")).toBe("team");
    expect(initialWorkFilter("", "garbage")).toBe("mine");
    expect(initialWorkFilter("?view=team", "mine")).toBe("team");
    expect(initialWorkFilter("?who=mine", "team")).toBe("mine");
    expect(workFilterFromSearch("?view=console")).toBeNull();
  });

  it("필터를 바꾸면 옛 view=team은 걷히고 who만 남는다(서랍 card는 그대로)", () => {
    expect(searchWithFilter("?view=team&card=x", "mine")).toBe("?card=x&who=mine");
    expect(searchWithFilter("", "team")).toBe("?who=team");
  });

  it("새 서버는 who로 골라 보냈으니 다시 거르지 않고, 옛 서버만 「내 것」을 화면이 고른다", () => {
    const mineRun = row(wireRun());
    const otherSession = row(wireSession());
    expect(itemsForFilter([mineRun, otherSession], "mine", ME, "jobs")).toHaveLength(2);
    expect(itemsForFilter([mineRun, otherSession], "mine", ME, "legacy")).toEqual([mineRun]);
    expect(itemsForFilter([mineRun, otherSession], "team", ME, "legacy")).toHaveLength(2);
  });

  it("문구에 「명사+중」 진행 낱말이 없다", () => {
    for (const text of Object.values(WORK_JOBS_COPY)) expect(text).not.toMatch(/[가-힣] 중$/);
  });
});

describe("fetchWorkJobs 기능 감지 (ADR-0202 D4)", () => {
  beforeEach(() => {
    resetWorkJobsDetection();
    installCoreHost({
      apiBase: () => "https://oort.test",
      absoluteApiBase: () => "https://oort.test",
      buildMode: () => "test",
      session: {
        getAccessToken: () => "t",
        getRefreshToken: () => null,
        getPersistedSession: () => null,
        applyLogin: () => {},
        applyRotation: () => {},
        markAuthExpired: () => {},
        clearSession: () => {},
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCoreHost();
    resetWorkJobsDetection();
  });

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("새 서버: include=runs,jobs·who를 보내고, who를 되울리면 그 답을 그대로 쓴다", async () => {
    const fetchMock = vi.fn(async () => json({ sessions: [wireRun()], nextCursor: null, who: "mine" }));
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchWorkJobs("ws", { who: "mine", limit: 50 });
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("include=runs%2Cjobs");
    expect(url).toContain("who=mine");
    expect(page.mode).toBe("jobs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("배포된 서버(include=runs만 알아봄, who를 되울리지 않음): include=runs로 다시 읽고, 다음부터는 묻지 않는다", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      // 실제 배포 서버처럼: "runs"가 아니면 run 줄을 빼고 세션 줄만, who는 모른다.
      return url.includes("include=runs&") || url.endsWith("include=runs")
        ? json({ sessions: [wireSession(), wireRun()], nextCursor: null })
        : json({ sessions: [wireSession()], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchWorkJobs("WS", { who: "mine" });
    expect(page.mode).toBe("legacy");
    // 소리 없이 run 줄을 잃지 않는다.
    expect(page.sessions.map((s) => s.source)).toEqual(["session", "run"]);
    expect(workJobsKnownLegacy("ws")).toBe(true);
    await fetchWorkJobs("ws", { who: "team" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String((fetchMock.mock.calls[2] as unknown[])[0])).not.toContain("jobs");
  });

  it("400(모르는 include 값)도 같은 물러서기다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "unknown include" }, 400))
      .mockResolvedValueOnce(json({ sessions: [wireRun()], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchWorkJobs("ws", { who: "team" });
    expect(page.mode).toBe("legacy");
    expect(page.sessions).toHaveLength(1);
  });

  it("400이 아닌 실패는 물러서지 않고 그대로 올린다(아픈 서버를 옛 서버로 만들지 않는다)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    await expect(fetchWorkJobs("ws", { who: "mine" })).rejects.toBeTruthy();
    expect(workJobsKnownLegacy("ws")).toBe(false);
  });
});
