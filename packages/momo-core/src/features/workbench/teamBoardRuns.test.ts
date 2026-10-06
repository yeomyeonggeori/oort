import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSharedWorkSessions,
  sharedWorkSessionFromWire,
  sharedWorkSessionPageFromWire,
  type AgentRun,
} from "../../lib/api";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import { asWorkRunUpdatedFrame } from "../../lib/realtimeEvents";
import { matchesActivityFilter } from "../inbox/activityFilter";
import { runItem } from "../inbox/model";
import {
  agentRunReport,
  artifactSummary,
} from "./runReport";
import {
  groupByOwner,
  isFinishedState,
  isRunItem,
  laneLabel,
  ownedBy,
  prFacts,
  stateChipLabel,
} from "./teamBoard";

const AGENT = "00000000-0000-7000-8000-0000000000aa";
const HUMAN = "00000000-0000-7000-8000-000000000101";
const RUN_ID = "00000000-0000-7000-8000-0000000000c1";

function wireRun(over: Record<string, unknown> = {}) {
  return {
    source: "run",
    runId: RUN_ID,
    requestedBy: { memberId: HUMAN, displayName: "곽성재" },
    stepCount: 3,
    commits: 2,
    pr: { url: "https://github.com/acme/oort/pull/12", number: 12 },
    origin: "agent_run",
    label: "온보딩 문구 다듬기",
    folderLabel: null,
    status: "done",
    owner: { memberId: AGENT, displayName: "그록봇" },
    homeChannel: { id: "c1", name: "agent-lab" },
    startedAtMs: 1,
    endedAtMs: 2,
    sharedAtMs: null,
    repo: null,
    branch: "feat/copy",
    harness: "hosted",
    state: "done",
    stages: ["읽는 중", "고치는 중"],
    diff: { added: 30, deleted: 4, files: null, ahead: null, behind: null, uncommitted: null },
    prUrl: "https://github.com/acme/oort/pull/12",
    lastActivityAt: 1_790_000_000,
    ...over,
  };
}

describe("보드 줄 읽기: 실행(run) 줄 (#3518)", () => {
  it("runId가 줄의 id가 되고 세션 모양에 맞춰진다", () => {
    const item = sharedWorkSessionFromWire(wireRun())!;
    expect(item.sessionId).toBe(RUN_ID);
    expect(isRunItem(item)).toBe(true);
    expect(item.diff.ahead).toBe(2);
    expect(item.requestedBy?.displayName).toBe("곽성재");
    expect(laneLabel(item)).toBe("에이전트 · 곽성재가 시킴");
    expect(stateChipLabel(item)).toBe("끝남 · PR");
  });

  it("보드 어휘 waiting은 「응답 필요」가 아니라 시작 전이다", () => {
    const item = sharedWorkSessionFromWire(wireRun({ state: "waiting", status: "waiting", prUrl: null, pr: null }))!;
    expect(item.state).toBe("idle");
    expect(stateChipLabel(item)).toBe("시작 전");
  });

  it("failed는 끝난 상태이고 칩이 말한다", () => {
    const item = sharedWorkSessionFromWire(wireRun({ state: "failed", status: "failed" }))!;
    expect(isFinishedState(item.state)).toBe(true);
    expect(stateChipLabel(item)).toBe("실패");
  });

  it("너그럽게 읽는다: 모르는 상태·빠진 키·모르는 키를 견디고 id 없는 줄만 버린다", () => {
    const page = sharedWorkSessionPageFromWire({
      sessions: [
        wireRun({ state: "from-the-future", extra: { a: 1 }, stages: ["ok", 3, null], diff: undefined }),
        { source: "run", label: "id 없음", owner: { memberId: "x", displayName: "y" }, homeChannel: { id: "c" } },
        "not-a-row",
      ],
      nextCursor: 5,
    });
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]!.state).toBe("idle");
    expect(page.sessions[0]!.stages).toEqual(["ok"]);
    expect(page.nextCursor).toBeNull();
  });

  it("옛 서버의 세션 줄(source·runId 없음)은 그대로 세션이다", () => {
    const item = sharedWorkSessionFromWire({
      sessionId: "s1",
      origin: "local_pty",
      label: "x",
      owner: { memberId: HUMAN, displayName: "곽성재" },
      homeChannel: { id: "c1", name: null },
      state: "waiting",
      stages: [],
      lastActivityAt: 1,
    })!;
    expect(item.source).toBe("session");
    expect(item.state).toBe("waiting");
    expect(isRunItem(item)).toBe(false);
  });

  it("사람별 묶음은 시킨 사람 밑이고 「내 것」도 시킨 사람 기준이다", () => {
    const run = sharedWorkSessionFromWire(wireRun())!;
    const orphan = sharedWorkSessionFromWire(wireRun({ runId: "r2", requestedBy: undefined }))!;
    const groups = groupByOwner([run, orphan]);
    expect(groups.map((g) => g.ownerName)).toEqual(["곽성재", "그록봇"]);
    expect(ownedBy([run, orphan], HUMAN)).toEqual([run]);
    expect(laneLabel(orphan)).toBe("에이전트 작업");
  });

  it("목록 읽기는 include=runs를 query로 보낸다", async () => {
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
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions: [wireRun()], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchSharedWorkSessions("ws", { limit: 50, include: "runs" });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("include=runs");
    expect(page.sessions[0]!.source).toBe("run");
    const plain = await fetchSharedWorkSessions("ws", {});
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).not.toContain("include=");
    expect(plain.sessions).toHaveLength(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

describe("에이전트 보고 읽기 (agent_run.output)", () => {
  it("단계와 산출물을 읽고 PR은 https 모양만 링크가 된다", () => {
    const report = agentRunReport({
      stages: ["a", "b"],
      artifacts: { prUrl: "https://github.com/acme/oort/pull/9", branch: "x", added: 5, deleted: 1, commits: 2 },
    });
    expect(report.stages).toEqual(["a", "b"]);
    expect(report.artifacts.pr?.href).toBe("https://github.com/acme/oort/pull/9");
    expect(artifactSummary(report)).toBe("PR #9 · 커밋 2개 · +5 −1");
  });

  it("javascript:·http:·자격증명·모양이 다른 주소는 링크가 되지 않는다", () => {
    for (const bad of [
      "javascript:alert(1)",
      "http://github.com/a/b/pull/1",
      "https://u:p@github.com/a/b/pull/1",
      "https://github.com/a/b/issues/1",
      "data:text/html,<script>1</script>",
      "https://github.com/a/b/pull/1/files",
      "https://github.com/a/b/pull/1x",
      "https://github.com:8443/a/b/pull/1",
      "https://github.com//a/b/pull/1",
      "https://github.com/a/b/pull/1/",
    ]) {
      expect(prFacts(bad)).toBeNull();
      expect(agentRunReport({ artifacts: { prUrl: bad } }).artifacts.pr).toBeNull();
    }
  });

  it("빈 보고는 얼려 있어 한 호출이 오염시킬 수 없다", () => {
    const report = agentRunReport(null);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.stages)).toBe(true);
    expect(Object.isFrozen(report.artifacts)).toBe(true);
  });

  it("모양이 틀린 output은 비어 있고 던지지 않는다", () => {
    for (const bad of [null, undefined, "x", 3, [], { stages: "no", artifacts: [] }, { artifacts: { added: -1, commits: "2" } }]) {
      const report = agentRunReport(bad);
      expect(report.stages).toEqual([]);
      expect(report.artifacts.added).toBeNull();
      expect(report.artifacts.commits).toBeNull();
    }
  });
});

describe("활동 「작업 끝남」: 호스팅 실행 (#3518)", () => {
  const hosted: AgentRun = {
    id: RUN_ID,
    workspaceId: "w",
    agentMemberId: AGENT,
    channelId: "c1",
    status: "succeeded",
    stepCount: 2,
    maxSteps: 12,
    input: { type: "work", title: "온보딩 문구 다듬기" },
    output: {
      stages: ["읽는 중", "PR 올림"],
      artifacts: { prUrl: "https://github.com/acme/oort/pull/12", commits: 1, added: 3, deleted: 0 },
    },
    createdAtMs: 1,
    finishedAtMs: 2,
    updatedAtMs: 2,
  };
  const actor = { name: "그록봇", handle: "grok", isAgent: true };

  it("끝난 호스팅 실행은 작업 끝남 칩을 통과하고 마지막 단계·결과를 말한다", () => {
    const item = runItem(hosted, actor, "#agent-lab", 10);
    expect(matchesActivityFilter(item, "done")).toBe(true);
    expect(item.detail).toBe("PR 올림 · PR #12 · 커밋 1개 · +3 −0");
    expect(item.outcome).toBe("완료");
  });

  it("보고가 없는 실행은 예전 문구 그대로다", () => {
    const item = runItem({ ...hosted, output: undefined }, actor, "#x", 10);
    expect(item.detail).toBe("2/12 단계");
  });
});

describe("work.run.updated 프레임", () => {
  it("run_id·channel_id가 있어야 신호다", () => {
    const ok = { type: "work.run.updated", v: 1, ts: 1, payload: { run_id: "r", channel_id: "c", to: "done" } };
    expect(asWorkRunUpdatedFrame(ok)).not.toBeNull();
    expect(asWorkRunUpdatedFrame({ ...ok, payload: { run_id: "r" } })).toBeNull();
    expect(asWorkRunUpdatedFrame({ ...ok, type: "work.session.share_changed" })).toBeNull();
    expect(asWorkRunUpdatedFrame(null)).toBeNull();
  });
});
