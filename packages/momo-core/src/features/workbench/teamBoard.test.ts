import { describe, expect, it } from "vitest";
import type { SharedWorkSession } from "../../lib/api";
import { asWorkSessionShareChangedFrame } from "../../lib/realtimeEvents";
import {
  TEAM_BOARD_COPY,
  BOARD_SECTION_ORDER,
  boardSections,
  boardSummary,
  diffFacts,
  doneSummary,
  groupByOwner,
  itemsForView,
  laneLabel,
  ownedBy,
  prFacts,
  stageMarkers,
  stateChipLabel,
  stateSentence,
} from "./teamBoard";
import { SESSION_STATUS_LABEL } from "./sessionList";

const NOW = Date.parse("2026-10-02T12:00:00+09:00");
const SEC = (ms: number) => Math.floor(ms / 1000);

function row(overrides: Partial<SharedWorkSession> = {}): SharedWorkSession {
  return {
    sessionId: "00000000-0000-7000-8000-0000000000a1",
    origin: "local_pty",
    label: "한글 입력 이중 전송 수리",
    folderLabel: "momo",
    status: "running",
    owner: { memberId: "00000000-0000-7000-8000-000000000101", displayName: "곽성재" },
    homeChannel: { id: "00000000-0000-7000-8000-000000000201", name: "workbench" },
    startedAtMs: NOW - 3_600_000,
    endedAtMs: null,
    sharedAtMs: NOW - 3_000_000,
    repo: "momo",
    branch: "feat/2774-xterm",
    harness: "claude",
    state: "running",
    stages: ["세션 시작", "작업 중"],
    diff: { added: 128, deleted: 40, files: 9, ahead: 2, behind: 0, uncommitted: 1 },
    prUrl: null,
    lastActivityAt: SEC(NOW - 60_000),
    ...overrides,
  };
}

describe("팀 보드 말 (#2863)", () => {
  it("비개발자용 상태 말: 대기 상태는 내 작업과 같은 정본 「응답 필요」다", () => {
    expect(stateChipLabel(row({ state: "waiting" }))).toBe("응답 필요");
    expect(stateChipLabel(row({ state: "waiting" }))).toBe(SESSION_STATUS_LABEL.waiting);
    expect(stateChipLabel(row({ state: "done", prUrl: "https://github.com/a/b/pull/1" }))).toBe("끝남 · PR");
    expect(stateChipLabel(row({ state: "done" }))).toBe("끝남");
  });

  it("레인 말: 로컬은 「로컬 · 공유됨」, 에이전트는 주인이 시킨 말", () => {
    expect(laneLabel(row())).toBe("로컬 · 공유됨");
    expect(laneLabel(row({ origin: "host" }))).toBe("에이전트 · 곽성재가 시킴");
    expect(laneLabel(row({ origin: "host", owner: { memberId: "x", displayName: "김여명" } }))).toBe(
      "에이전트 · 김여명이 시킴"
    );
  });

  it("상태 문장: 기다림은 주인 이름과 분 단위 경과를 말한다", () => {
    const waiting = row({ state: "waiting", lastActivityAt: SEC(NOW - 3 * 60_000) });
    expect(stateSentence(waiting, NOW)).toBe("곽성재의 응답이 필요해요 · 3분째");
  });

  it("묶기: 서버 순서를 지키고 사람마다 한 묶음이다", () => {
    const other = { memberId: "00000000-0000-7000-8000-000000000102", displayName: "박세은" };
    const groups = groupByOwner([
      row({ sessionId: "a" }),
      row({ sessionId: "b", owner: other }),
      row({ sessionId: "c" }),
    ]);
    expect(groups.map((g) => [g.ownerName, g.items.map((i) => i.sessionId)])).toEqual([
      ["곽성재", ["a", "c"]],
      ["박세은", ["b"]],
    ]);
  });

  it("보기: 지금 = 안 끝난 것, 오늘 끝난 것 = 오늘 0시 이후에 끝난 것. 어느 쪽에도 없는 줄은 만들지 않는다", () => {
    const items = [
      row({ sessionId: "run", state: "running" }),
      row({ sessionId: "done-today", state: "done", lastActivityAt: SEC(NOW - 60_000) }),
      row({ sessionId: "done-old", state: "done", lastActivityAt: SEC(NOW - 3 * 86_400_000) }),
    ];
    expect(itemsForView(items, "now", NOW).map((i) => i.sessionId)).toEqual(["run"]);
    expect(itemsForView(items, "done", NOW).map((i) => i.sessionId)).toEqual(["done-today"]);
  });

  it("요약 문장은 도는 수와 응답 필요 수를 센다", () => {
    const items = [row({ state: "running" }), row({ state: "waiting" }), row({ state: "done" })];
    expect(boardSummary(items).sentence).toBe("지금 팀에서 2개가 돌고 있어요. 1개는 응답이 필요해요.");
    expect(boardSummary([row({ state: "done" })]).sentence).toBe("지금 도는 공유 세션이 없어요.");
  });

  it("오늘 끝난 것 요약은 그 보기의 숫자를 말한다", () => {
    expect(doneSummary(0)).toBe("오늘 끝난 공유 세션이 없어요.");
    expect(doneSummary(3)).toBe("오늘 3개가 끝났어요.");
  });

  it("diff: 에이전트 레인(모두 null)은 숫자를 말하지 않는다", () => {
    const none = { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null };
    expect(diffFacts(none)).toBeNull();
    expect(diffFacts(row().diff)).toEqual({ commits: 2, added: 128, deleted: 40, files: 9 });
  });

  it("PR: https 풀 요청 주소만 링크가 된다", () => {
    expect(prFacts("https://github.com/yeomyeonggeori/oort/pull/2851")).toMatchObject({
      number: "PR #2851",
      repo: "yeomyeonggeori/oort",
    });
    expect(prFacts("javascript:alert(1)")).toBeNull();
    expect(prFacts("http://github.com/a/b/pull/1")).toBeNull();
    expect(prFacts("https://github.com/a/b/issues/1")).toBeNull();
    expect(prFacts(null)).toBeNull();
  });

  it("단계 표지: 마지막만 지금 상태를 따른다. 끝난 세션은 전부 지난 단계", () => {
    expect(stageMarkers(row()).map((m) => m.tone)).toEqual(["done", "current"]);
    expect(stageMarkers(row({ state: "done" })).map((m) => m.tone)).toEqual(["done", "done"]);
    expect(stageMarkers(row({ stages: [] }))).toEqual([]);
  });

  it("빈 상태 말은 아직 없는 단추를 약속하지 않는다(#2867 전)", () => {
    expect(TEAM_BOARD_COPY.emptyBody).not.toMatch(/단추|버튼|눌러/);
    expect(TEAM_BOARD_COPY.emptyBody).toContain("공유를 켠 세션");
  });
});

describe("work.session.share_changed 프레임", () => {
  const frame = (payload: unknown) => ({ type: "work.session.share_changed", v: 1, ts: 1, payload });
  it("세 종류를 받고, 모르는 종류·빠진 필드는 거절한다", () => {
    for (const kind of ["enabled", "state_changed", "disabled"]) {
      expect(asWorkSessionShareChangedFrame(frame({ session_id: "s", channel_id: "c", kind }))).not.toBeNull();
    }
    expect(asWorkSessionShareChangedFrame(frame({ session_id: "s", channel_id: "c", kind: "other" }))).toBeNull();
    expect(asWorkSessionShareChangedFrame(frame({ session_id: "s", kind: "enabled" }))).toBeNull();
    expect(asWorkSessionShareChangedFrame({ type: "work.session.ended", payload: {} })).toBeNull();
    expect(asWorkSessionShareChangedFrame(null)).toBeNull();
  });
});

describe("폰 한 열 판: 상태 순서와 내 것 (#2864)", () => {
  const ME = "00000000-0000-7000-8000-000000000101";
  const OTHER = "00000000-0000-7000-8000-000000000102";
  const at = (id: string, state: SharedWorkSession["state"], extra: Partial<SharedWorkSession> = {}) =>
    row({
      sessionId: `00000000-0000-7000-8000-0000000000${id}`,
      label: `세션 ${id}`,
      state,
      lastActivityAt: SEC(NOW - 60_000),
      ...extra,
    });

  it("순서는 응답 필요 → 실행 중 → 검토 대기 → 대기 → 오늘 끝난 것이다", () => {
    expect(BOARD_SECTION_ORDER).toEqual(["waiting", "running", "review", "idle", "finished"]);
    // 서버 순서(최신순)가 일부러 순서와 어긋나게 넣는다.
    const items = [
      at("c1", "review"),
      at("c2", "running"),
      at("c3", "done", { endedAtMs: NOW - 1000, lastActivityAt: SEC(NOW - 1000) }),
      at("c4", "waiting"),
      at("c5", "idle"),
    ];
    const sections = boardSections(items, NOW);
    expect(sections.map((s) => s.key)).toEqual(["waiting", "running", "review", "idle", "finished"]);
    expect(sections.map((s) => s.label)).toEqual([
      SESSION_STATUS_LABEL.waiting,
      SESSION_STATUS_LABEL.running,
      SESSION_STATUS_LABEL.review,
      SESSION_STATUS_LABEL.idle,
      TEAM_BOARD_COPY.viewDone,
    ]);
    expect(SESSION_STATUS_LABEL.waiting).toBe("응답 필요");
  });

  it("구간 안은 서버 순서를 지키고, 빈 구간은 없고, 오래전에 끝난 줄은 서지 않는다", () => {
    const a = at("d1", "running");
    const b = at("d2", "running");
    const old = at("d3", "done", { lastActivityAt: SEC(NOW - 3 * 86_400_000) });
    const sections = boardSections([a, old, b], NOW);
    expect(sections.map((s) => s.key)).toEqual(["running"]);
    expect(sections[0]?.items.map((i) => i.sessionId)).toEqual([a.sessionId, b.sessionId]);
  });

  it("내 것: 주인이 나인 줄만, 대소문자 무관. 에이전트 레인도 시킨 사람이 나면 내 것이다", () => {
    const mine = at("e1", "waiting");
    const agentMine = at("e2", "running", { origin: "host" });
    const theirs = at("e3", "running", { owner: { memberId: OTHER, displayName: "김인턴" } });
    const upper = at("e4", "review", { owner: { memberId: ME.toUpperCase(), displayName: "곽성재" } });
    expect(ownedBy([mine, theirs, agentMine, upper], ME).map((i) => i.sessionId)).toEqual([
      mine.sessionId,
      agentMine.sessionId,
      upper.sessionId,
    ]);
  });

  it("「확인 기다림」은 어디에도 없다(성재 결정 2026-10-01)", () => {
    expect(JSON.stringify(TEAM_BOARD_COPY)).not.toContain("확인 기다림");
    expect(JSON.stringify(SESSION_STATUS_LABEL)).not.toContain("확인 기다림");
  });
});
