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
import { SESSION_STATUS_LABEL } from "./sessionList";
import { TEAM_BOARD_COPY, stateChipLabel } from "./teamBoard";
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
  keepNeedsMeSlots,
  awaitingMeItem,
  rowNeedsMe,
  workJobResultHasControls,
  workJobResultKind,
  workJobStateLabel,
  type WorkJobRow,
} from "./workJobs";
import { approvalWaitingLine } from "../timeline/requestBundle";
import { createMessageService, loadMessageCatalog } from "../../i18n";

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

  it("phase=awaiting_approval인 run만 승인 대기이고 「지금」 맨 위에 선다", () => {
    const waiting = workJobRow(row(wireRun({ runId: "00000000-0000-7000-8000-0000000000c2", phase: "awaiting_approval" })), NOW);
    const working = workJobRow(row(wireRun()), NOW);
    const done = workJobRow(row(wireRun({ runId: "00000000-0000-7000-8000-0000000000c3", state: "done", endedAtMs: NOW })), NOW);
    expect(waiting.awaitingApproval).toBe(true);
    expect(working.awaitingApproval).toBe(false);
    const sections = workJobSections([working, done, waiting]);
    expect(sections.map((s) => s.key)).toEqual(["now", "done"]);
    expect(sections[0]!.rows.map((r) => r.id)).toEqual([waiting.id, working.id]);
    expect(inProgressCount([working, done, waiting])).toBe(2);
  });

  it("「응답 필요」(#5593): 호출자가 답한 줄이 맨 위 구간이고, 승인 대기 run 보다도 위다", () => {
    const approval = workJobRow(row(wireRun({ runId: "00000000-0000-7000-8000-0000000000c2", phase: "awaiting_approval" })), NOW);
    const quiet = workJobRow(row(wireSession({ sessionId: "00000000-0000-7000-8000-0000000000d1" })), NOW);
    const asking = workJobRow(row(wireSession({ sessionId: "00000000-0000-7000-8000-0000000000d2" })), NOW);
    const ended = workJobRow(
      row(wireSession({ sessionId: "00000000-0000-7000-8000-0000000000d3", state: "done", endedAtMs: NOW })),
      NOW
    );
    // 서버 순서(마지막 활동 최신순)로는 묻는 세션이 맨 끝이다. 끝난 줄은 물어도 「응답 필요」가 아니다(D5: 요청은 취소됐다).
    const rows = [approval, quiet, ended, asking];
    const needs = (r: typeof asking) => r.id === asking.id || r.id === ended.id;
    const sections = workJobSections(rows, needs);
    expect(sections.map((s) => [s.key, s.label, s.rows.map((r) => r.id)])).toEqual([
      ["needsMe", "응답 필요", [asking.id]],
      ["now", "지금", [approval.id, quiet.id]],
      ["done", "끝난 일", [ended.id]],
    ]);
    // 답하지 않으면(웹·옛 부름) 예전 두 구간 그대로다.
    expect(workJobSections(rows).map((s) => s.key)).toEqual(["now", "done"]);
    expect(workJobSections(rows, () => false).map((s) => s.key)).toEqual(["now", "done"]);
  });

  describe("「응답 필요」의 칸은 화면에 떠 있는 동안 자리를 지킨다 (#5738)", () => {
    const runRowOf = (n: number, over: Record<string, unknown> = {}) =>
      workJobRow(row(wireRun({ runId: `00000000-0000-7000-8000-0000000000c${n}`, phase: "awaiting_approval", ...over })), NOW);
    const ask = (n: number, approval: string | null = `a${n}`, over: Record<string, unknown> = {}) => ({
      row: runRowOf(n, over),
      askId: approval,
      facts: `facts-${n}-${approval}`,
    });
    const none = { decidedHere: new Set<string>(), sending: new Set<string>() };

    it("처음 본 순서를 지키고, 서버가 순서를 바꿔도 칸은 그대로다", () => {
      const first = keepNeedsMeSlots<string>([], [ask(1), ask(2), ask(3)], none);
      const reordered = keepNeedsMeSlots(first, [ask(3), ask(1), ask(2)], none);
      expect(reordered.map((s) => s.row.id)).toEqual(first.map((s) => s.row.id));
      // 같은 입력을 두 번 넣어도 같다(그리기가 두 번 돌아도 칸이 늘지 않는다).
      expect(keepNeedsMeSlots(reordered, [ask(3), ask(1), ask(2)], none)).toEqual(reordered);
    });

    it("내가 결정한 칸은 빠지지 않고 그 자리의 결과 칸이 되고, 원장이 그 승인을 다시 내놓아도 되살아나지 않는다", () => {
      const first = keepNeedsMeSlots<string>([], [ask(1), ask(2), ask(3)], none);
      const key1 = first[0]!.key;
      // 원장이 아직 A를 내놓는 동안에도(결정이 막 닿음) 내가 결정했으면 결과 칸이다.
      const decided = keepNeedsMeSlots(first, [ask(1), ask(2), ask(3)], { ...none, decidedHere: new Set([key1]) });
      expect(decided.map((s) => [s.askId, s.settled])).toEqual([["a1", "mine"], ["a2", null], ["a3", null]]);
      // 결정이 닿아 원장이 A를 뺐다 → 칸 셋 그대로. 다시 내놓아도(낡은 읽기) A는 새 칸으로 서지 않는다.
      const gone = keepNeedsMeSlots(decided, [ask(2), ask(3)], none);
      expect(gone.map((s) => s.settled)).toEqual(["mine", null, null]);
      expect(keepNeedsMeSlots(gone, [ask(1), ask(2), ask(3)], none)).toEqual(gone);
    });

    it("내가 결정하지 않았는데 묻지 않게 된 칸(다른 기기의 결정·만료·run 끝남)도 그 자리의 결과 칸이고, 아래 칸은 올라오지 않는다", () => {
      const first = keepNeedsMeSlots<string>([], [ask(1), ask(2), ask(3)], none);
      const elsewhere = keepNeedsMeSlots(first, [ask(1), ask(3)], none);
      expect(elsewhere.map((s) => [s.row.id, s.settled])).toEqual([
        [first[0]!.row.id, null],
        [first[1]!.row.id, "elsewhere"],
        [first[2]!.row.id, null],
      ]);
      // 칸은 처음 본 줄로 그린다(목록에서 줄이 빠지거나 바뀌어도).
      expect(elsewhere[1]!.row).toBe(first[1]!.row);
      expect(elsewhere[1]!.facts).toBe("facts-2-a2");
    });

    it("보내는 중인 칸은 원장이 답보다 먼저 그 승인을 빼도 「다른 곳에서」가 되지 않는다 — 답이 오면 결정이 닿았는지로 갈린다", () => {
      const first = keepNeedsMeSlots<string>([], [ask(1), ask(2)], none);
      const key1 = first[0]!.key;
      const sending = keepNeedsMeSlots(first, [ask(2)], { ...none, sending: new Set([key1]) });
      expect(sending.map((s) => s.settled)).toEqual([null, null]);
      expect(keepNeedsMeSlots(sending, [ask(2)], { ...none, decidedHere: new Set([key1]) }).map((s) => s.settled)).toEqual(["mine", null]);
      // 실패했는데 원장이 이미 그 승인을 뺐다면(다른 곳에서 끝남) 그때 결과 칸이 된다.
      expect(keepNeedsMeSlots(sending, [ask(2)], none).map((s) => s.settled)).toEqual(["elsewhere", null]);
    });

    it("새로 온 요청은 맨 아래에 붙는다 — 서버가 맨 앞에 줘도. 같은 run의 다음 승인도 새 요청이라 맨 아래 새 칸이다", () => {
      const first = keepNeedsMeSlots<string>([], [ask(1), ask(2)], none);
      const arrived = keepNeedsMeSlots(first, [ask(4), ask(1), ask(2)], none);
      expect(arrived.map((s) => s.row.id)).toEqual([first[0]!.row.id, first[1]!.row.id, runRowOf(4).id]);
      // A를 결정했고, 같은 run이 다음 승인(a9)을 묻는다: A의 결과 칸은 그 자리, 다음 승인은 맨 아래.
      const decided = keepNeedsMeSlots(arrived, [ask(2), ask(4), ask(1, "a9")], { ...none, decidedHere: new Set([first[0]!.key]) });
      expect(decided.map((s) => [s.row.id, s.askId, s.settled])).toEqual([
        [first[0]!.row.id, "a1", "mine"],
        [first[1]!.row.id, "a2", null],
        [runRowOf(4).id, "a4", null],
        [first[0]!.row.id, "a9", null],
      ]);
      expect(new Set(decided.map((s) => s.key)).size).toBe(4);
    });

    it("id가 없는 권한 요청(내 맥 세션)은 결과 칸이 된 뒤 다시 물으면 맨 아래 새 칸이다(열쇠가 겹치지 않는다)", () => {
      const session = workJobRow(row(wireSession({ sessionId: "00000000-0000-7000-8000-0000000000d2" })), NOW);
      const permission = { row: session, askId: null, facts: "p" };
      const first = keepNeedsMeSlots<string>([], [permission, ask(1)], none);
      const answered = keepNeedsMeSlots(first, [ask(1)], none);
      expect(answered.map((s) => s.settled)).toEqual(["elsewhere", null]);
      const again = keepNeedsMeSlots(answered, [ask(1), permission], none);
      expect(again.map((s) => [s.row.id, s.settled])).toEqual([
        [session.id, "elsewhere"],
        [first[1]!.row.id, null],
        [session.id, null],
      ]);
      expect(again[2]!.key).not.toBe(again[0]!.key);
      expect(keepNeedsMeSlots(again, [ask(1), permission], none)).toEqual(again);
    });
  });

  it("주인에게 열린 권한 요청이 있는 줄의 칩은 「응답 필요」다 — 돌거나 대기 중인 줄만(#5593 수리 M2)", () => {
    const running = row(wireSession({ sessionId: "00000000-0000-7000-8000-0000000000e1" }));
    expect(awaitingMeItem(running).state).toBe("waiting");
    expect(stateChipLabel(awaitingMeItem(running))).toBe("응답 필요");
    const idle = row(wireSession({ sessionId: "00000000-0000-7000-8000-0000000000e2", state: "idle" }));
    expect(awaitingMeItem(idle).state).toBe("waiting");
    const done = row(wireSession({ sessionId: "00000000-0000-7000-8000-0000000000e3", state: "done", endedAtMs: NOW }));
    expect(awaitingMeItem(done)).toBe(done);
  });

  it("상태 칩 낱말(수리 3회차): 「응답 필요」는 그 구간에 선 줄만, 구간 밖 승인 대기 run은 「승인 대기」, 이 화면 밖 낱말은 그대로", async () => {
    const ko = createMessageService({ messageLocale: "ko-KR", catalog: await loadMessageCatalog("ko-KR") });
    const en = createMessageService({ messageLocale: "en-US" });
    const approval = workJobRow(row(wireRun({ runId: "00000000-0000-7000-8000-0000000000c4", phase: "awaiting_approval" })), NOW);
    const permission = workJobRow(row(wireSession({ origin: "host", owner: { memberId: ME, displayName: "구민수" }, state: "waiting" })), NOW);
    // 구간 안: 두 종류 모두 구간 이름과 같은 낱말 하나.
    expect(workJobStateLabel(approval, true, ko.formatMessage)).toBe(SESSION_STATUS_LABEL.waiting);
    expect(workJobStateLabel(approval, true, ko.formatMessage)).toBe("응답 필요");
    expect(workJobStateLabel(permission, true, ko.formatMessage)).toBe("응답 필요");
    // 구간 밖(결정자가 아님·「팀 전체」): 내가 답할 수 없는 줄은 「응답 필요」가 아니다.
    expect(workJobStateLabel(approval, false, ko.formatMessage)).toBe("승인 대기");
    expect(workJobStateLabel(approval, false, en.formatMessage)).toBe("Awaiting approval");
    // 사이드바·서랍 기본값·폰이 읽는 공용 칩 낱말은 바꾸지 않는다(줄 모델의 `statusLabel`도 공용 낱말).
    expect(stateChipLabel(approval.item)).toBe("승인 필요");
    expect(approval.statusLabel).toBe("승인 필요");
    // 승인 대기가 아닌 줄은 공용 낱말 그대로.
    const running = workJobRow(row(wireRun()), NOW);
    expect(workJobStateLabel(running, false, ko.formatMessage)).toBe("실행 중");
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

describe("보기 전환 낱말 — owner 2026-11-09 「내것 -> 내 작업으로」", () => {
  it("작업 목록과 옛 팀 보드가 같은 낱말 「내 작업」을 쓴다 — 웹·데스크탑·폰이 이 상수를 읽는다", () => {
    expect(WORK_JOBS_COPY.filterMine).toBe("내 작업");
    expect(TEAM_BOARD_COPY.filterMine).toBe("내 작업");
  });
});

describe("맨 위 구간 낱말 — owner 2026-11-10 「응답 필요」", () => {
  it("구간 머리글은 세션 상태의 정본 낱말을 읽는다 — 글자를 따로 적지 않는다(정의 하나)", () => {
    expect(WORK_JOBS_COPY.sectionNeedsMe).toBe("응답 필요");
    expect(WORK_JOBS_COPY.sectionNeedsMe).toBe(SESSION_STATUS_LABEL.waiting);
  });
});

describe("「응답 필요」 한 판정 — 서버가 준 사실만 (#5640, ADR-0202 D1·D5)", () => {
  const RUN_ID = "00000000-0000-7000-8000-0000000000c1";
  const mine = (over: Record<string, unknown> = {}) =>
    workJobRow(
      row(
        wireSession({
          sessionId: "00000000-0000-7000-8000-0000000000e1",
          origin: "host",
          owner: { memberId: ME, displayName: "김도현" },
          harness: "claude",
          ...over,
        })
      ),
      NOW
    );
  const facts = (over: Partial<Parameters<typeof rowNeedsMe>[1]> = {}) => ({
    filter: "mine" as const,
    selfMemberId: ME,
    approvalRunIds: new Set<string>(),
    ...over,
  });

  it("내 맥 세션은 서버가 `waiting`을 준 것만 선다 — `running`은 요청이 있어도 화면이 짐작하지 않는다", () => {
    expect(rowNeedsMe(mine({ state: "waiting" }), facts())).toBe(true);
    expect(rowNeedsMe(mine({ state: "running" }), facts())).toBe(false);
    expect(rowNeedsMe(mine({ state: "idle" }), facts())).toBe(false);
  });

  it("「팀 전체」, 남의 세션, 로컬 공유 터미널, 끝난 줄에는 서지 않는다", () => {
    expect(rowNeedsMe(mine({ state: "waiting" }), facts({ filter: "team" }))).toBe(false);
    expect(
      rowNeedsMe(mine({ state: "waiting", owner: { memberId: OTHER, displayName: "김민지" } }), facts())
    ).toBe(false);
    // 로컬 공유 터미널의 `waiting`은 그 기기의 입력 대기다(보는 사람 누구에게나 같다).
    expect(rowNeedsMe(mine({ state: "waiting", origin: "local_pty" }), facts())).toBe(false);
    expect(rowNeedsMe(mine({ state: "done", endedAtMs: NOW - 1000 }), facts())).toBe(false);
  });

  it("에이전트 실행 줄은 승인 원장이 고른 run id로만 선다 — 보드의 phase만으로는 서지 않는다", () => {
    const run = workJobRow(row(wireRun({ phase: "running" })), NOW);
    const phaseOnly = workJobRow(row(wireRun({ phase: "awaiting_approval" })), NOW);
    expect(rowNeedsMe(run, facts({ approvalRunIds: new Set([RUN_ID]) }))).toBe(true);
    // 서버가 대문자 id를 내도 같은 run이다(id 비교는 소문자로).
    const upper = workJobRow(row(wireRun({ runId: RUN_ID.toUpperCase() })), NOW);
    expect(rowNeedsMe(upper, facts({ approvalRunIds: new Set([RUN_ID]) }))).toBe(true);
    expect(rowNeedsMe(phaseOnly, facts())).toBe(false);
    // 남이 맡긴 run은 내 결정 대기가 있어도 「내 작업」의 내 줄이 아니다.
    const others = workJobRow(row(wireRun({ requestedBy: { memberId: OTHER, displayName: "김민지" } })), NOW);
    expect(rowNeedsMe(others, facts({ approvalRunIds: new Set([RUN_ID]) }))).toBe(false);
    expect(rowNeedsMe(run, facts({ filter: "team", approvalRunIds: new Set([RUN_ID]) }))).toBe(false);
  });

  it("구간 순서는 응답 필요 → 지금 → 끝난 일이고, 비면 머리글도 없다", () => {
    const waiting = mine({ state: "waiting" });
    const running = mine({ sessionId: "00000000-0000-7000-8000-0000000000e2", state: "running" });
    const done = mine({ sessionId: "00000000-0000-7000-8000-0000000000e3", state: "done", endedAtMs: NOW - 1000 });
    const judge = (r: WorkJobRow) => rowNeedsMe(r, facts());
    expect(workJobSections([done, running, waiting], judge).map((s) => [s.key, s.rows.map((r) => r.id)])).toEqual([
      ["needsMe", [waiting.id]],
      ["now", [running.id]],
      ["done", [done.id]],
    ]);
    expect(workJobSections([done, running], judge).map((s) => s.key)).toEqual(["now", "done"]);
    expect(workJobSections([waiting], (r) => rowNeedsMe(r, facts({ filter: "team" }))).map((s) => s.key)).toEqual([
      "now",
    ]);
  });
});

describe("열 이름 — owner 2026-11-11 「작업」 · 「작업 시간」 · 「요청 채널」", () => {
  it("웹·데스크탑 머리 줄이 읽는 상수가 새 낱말이다(옛 「맡긴 일」 · 「걸린 시간」 · 「채널」이 아니다)", () => {
    expect([
      WORK_JOBS_COPY.colTask,
      WORK_JOBS_COPY.colResult,
      WORK_JOBS_COPY.colState,
      WORK_JOBS_COPY.colDuration,
      WORK_JOBS_COPY.colChannel,
    ]).toEqual(["작업", "결과", "상태", "작업 시간", "요청 채널"]);
  });
});

describe("결과 칸의 종류 — 한 판정 (#5640 수리 1회차)", () => {
  const session = (over: Record<string, unknown> = {}) =>
    workJobRow(
      row(
        wireSession({
          sessionId: "00000000-0000-7000-8000-0000000000e1",
          origin: "host",
          owner: { memberId: ME, displayName: "김도현" },
          harness: "claude",
          ...over,
        })
      ),
      NOW
    );
  const prUrl = "https://github.com/example/oort/pull/3521";

  it("「응답 필요」에 선 줄은 그 구간에 올린 사실이 곧 종류다: 맥 세션 → 권한 요청, run → 승인 요청", () => {
    expect(workJobResultKind(session({ state: "waiting" }), true)).toBe("permission");
    expect(workJobResultKind(workJobRow(row(wireRun({ phase: "running" })), NOW), true)).toBe("approval");
  });

  it("구간 밖에서는 서버 phase가 승인 대기인 run만 승인 요청이고, 그다음 에이전트 보고 → PR → 없음", () => {
    expect(workJobResultKind(workJobRow(row(wireRun({ phase: "awaiting_approval" })), NOW), false)).toBe("approval");
    // 맥 세션의 `waiting`은 구간 밖(「팀 전체」)에서 권한 요청 꼬리표를 얻지 않는다 — 답할 사람이 보는 구간에서만 말한다.
    expect(workJobResultKind(session({ state: "waiting" }), false)).toBe("none");
    const reported = workJobRow(
      row(wireRun({ phase: "succeeded", status: "done", agentReported: { resultKind: "pr_opened" } })),
      NOW
    );
    expect(workJobResultKind(reported, false)).toBe("reported");
    expect(workJobResultKind(workJobRow(row(wireRun({ phase: "running", pr: { url: prUrl } })), NOW), false)).toBe("pr");
    expect(workJobResultKind(workJobRow(row(wireRun({ phase: "running" })), NOW), false)).toBe("none");
  });

  it("결과 칸 아래층은 컨트롤이 있을 때만 선다 — 「열어서 답하기」는 데스크탑 앱에서만", () => {
    const waiting = session({ state: "waiting" });
    expect(workJobResultHasControls(waiting, "permission", true)).toBe(true);
    expect(workJobResultHasControls(waiting, "permission", false)).toBe(false);
    const run = workJobRow(row(wireRun({ phase: "running" })), NOW);
    expect(workJobResultHasControls(run, "approval", false)).toBe(true);
    expect(workJobResultHasControls(run, "none", true)).toBe(false);
  });

  it("결정자가 아닌 줄의 대기 줄은 카드의 문장 그대로다", () => {
    expect(approvalWaitingLine()).toBe("관리자의 승인을 기다려요");
    expect(approvalWaitingLine("이서연")).toBe("이서연 님의 승인을 기다려요");
  });
});
