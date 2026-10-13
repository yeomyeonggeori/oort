// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentRunProgress, Channel } from "@momo/core/lib/api";
import { ledgerRows, runList } from "@momo/core/features/agents/runLedger";
import type { Directory } from "@/features/workspace/useWorkspace";
import {
  ApprovalLink,
  ApprovalMissing,
  LedgerView,
  QueueAheadView,
  RunListView,
} from "./AgentRunLedgerView";

// =============================================================================
// 작업 패널의 서버 기록 쪽 (ADR-0200 U2). 구역·순서·문장은 core가 가진다. 여기서
// 지키는 것은 그것이 **화면에 그대로 서는가**와, 에이전트가 쓴 문자열이 마크업이
// 되지 않는가다.
// =============================================================================

const T = 1_800_000_000_000;
const MIN = 60_000;
const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const CH_OTHER = "00000000-0000-7000-8000-000000000202";
const AGENT = "00000000-0000-7000-8000-000000000301";
const ME = "00000000-0000-7000-8000-000000000101";

function run(id: string, extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id,
    channelId: CH,
    agentMemberId: AGENT,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: T - 11 * MIN,
    updatedAtMs: T - 11 * MIN,
    ...extra,
  };
}

const channels: Channel[] = [
  { id: CH, workspaceId: WS, kind: "public", name: "계획", muted: false },
  { id: CH_OTHER, workspaceId: WS, kind: "public", name: "릴리스", muted: false },
];
const directory = { members: [], byId: new Map() } as unknown as Directory;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(ui: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(MemoryRouter, null, ui));
  });
  return host;
}

describe("여러 run 목록", () => {
  const rows = [
    run("r-run-a", { phase: "running", status: "running", leaseState: "live", triggerSummary: "채널 정리", startedAtMs: T - 5 * MIN, lastEventAtMs: T - MIN }),
    run("r-run-b", { phase: "awaiting_approval", status: "awaiting_approval", leaseState: "live", triggerSummary: "설정 변경", startedAtMs: T - 4 * MIN }),
    run("r-q1", { queuePosition: 1, triggerSummary: "릴리스 노트", aheadTotal: 0 }),
    run("r-q2", { queuePosition: 2, triggerSummary: "회의록", aheadTotal: 1 }),
    run("r-done", { phase: "timed_out", status: "timed_out", finishedAtMs: T - 2 * MIN, endReason: "approval_expired", triggerSummary: "채널 만들기" }),
  ];

  it("진행 중은 나란히(병렬), 대기열은 순번대로, 끝난 일은 사유와 함께", () => {
    const entries = runList(rows, AGENT);
    const el = render(
      createElement(RunListView, {
        entries,
        selectedRunId: "r-q1",
        nowMs: T,
        onSelect: () => undefined,
      })
    );
    const sections = [...el.querySelectorAll('[data-testid="agent-work-panel-runs-section"]')];
    expect(sections.map((s) => s.getAttribute("data-section"))).toEqual(["active", "queue", "done"]);
    const labels = (i: number) =>
      [...sections[i].querySelectorAll('[data-testid="agent-work-panel-run"]')].map((b) => b.textContent);
    expect(labels(0).join("|")).toContain("채널 정리");
    expect(labels(0)).toHaveLength(2);
    expect(labels(0).join("|")).toContain("승인 대기");
    expect(labels(1)[0]).toContain("대기 1번째");
    expect(labels(1)[1]).toContain("대기 2번째");
    expect(labels(2)[0]).toContain("시간 초과");
    expect(labels(2)[0]).toContain("승인이 만료됐어요");
    expect(el.querySelector('[data-selected]')?.getAttribute("data-run-id")).toBe("r-q1");
  });

  it("행을 누르면 그 run을 고른다", () => {
    let picked: string | null = null;
    const el = render(
      createElement(RunListView, {
        entries: runList(rows, AGENT),
        selectedRunId: "r-run-a",
        nowMs: T,
        onSelect: (r: AgentRunProgress) => {
          picked = r.id;
        },
      })
    );
    act(() => {
      (el.querySelector('[data-run-id="r-q2"]') as HTMLButtonElement).click();
    });
    expect(picked).toBe("r-q2");
  });
});

describe("대기열 앞: 내 채널은 자세히, 아니면 건수만", () => {
  it("내가 멤버인 채널의 일은 제목과 채널이 있고, 나머지는 「앞에 N건이 더」", () => {
    const target = run("r-me", {
      queuePosition: 4,
      aheadTotal: 3,
      ahead: [{ runId: "r-ahead", channelId: CH_OTHER }],
    });
    const el = render(
      createElement(QueueAheadView, {
        progress: target,
        channels,
        directory,
        selfMemberId: ME,
      })
    );
    const visible = el.querySelectorAll('[data-testid="agent-work-panel-ahead-row"]');
    expect(visible).toHaveLength(1);
    expect(visible[0].textContent).toContain("#릴리스");
    const hidden = el.querySelector('[data-testid="agent-work-panel-ahead-hidden"]');
    expect(hidden?.textContent).toContain("앞에 2건이 더 있어요");
    // 이름을 말할 수 없는 일의 제목·채널을 짐작해서 적지 않는다.
    expect(hidden?.textContent).not.toContain("#");
  });

  it("앞선 일이 없으면 아무것도 그리지 않는다", () => {
    const el = render(
      createElement(QueueAheadView, {
        progress: run("r-first", { queuePosition: 1, aheadTotal: 0 }),
        channels,
        directory,
        selfMemberId: ME,
      })
    );
    expect(el.querySelector('[data-testid="agent-work-panel-ahead"]')).toBeNull();
  });
});

describe("기록 줄과 승인 링크", () => {
  const events = ledgerRows([
    { ordinal: 1, kind: "queued", createdAtMs: T - 12 * MIN },
    { ordinal: 2, kind: "claimed", createdAtMs: T - MIN },
    { ordinal: 3, kind: "stage", stage: "<img src=x onerror=alert(1)>", createdAtMs: T - 30_000 },
    { ordinal: 4, kind: "approval_requested", approvalId: "ap-1", createdAtMs: T - 10_000 },
  ]);

  it("에이전트가 쓴 단계는 마크업이 아니라 글자로 선다", () => {
    const el = render(
      createElement(LedgerView, { rows: events, nowMs: T })
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("승인 대기 안내는 카드로 가는 링크를 둔다", () => {
    const el = render(createElement(ApprovalLink, { href: "/c/ch?msg=m1" }));
    expect(el.querySelector('[data-testid="agent-work-panel-approval-link"]')?.getAttribute("href")).toBe("/c/ch?msg=m1");
    expect(el.textContent).toContain("승인을 기다리고 있어요");
  });

  it("승인 대기인데 카드를 찾지 못하면 침묵하지 않고 이유를 말한다", () => {
    const el = render(createElement(ApprovalMissing));
    expect(el.querySelector('[data-testid="agent-work-panel-approval-missing"]')?.textContent).toContain(
      "이미 결정됐거나 만료됐을 수 있어요"
    );
    expect(el.querySelector("a")).toBeNull();
  });
});
