// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRunLedgerFromWire } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ledgerRows } from "@momo/core/features/agents/runLedger";
import { workToolRecord } from "@momo/core/features/agents/workTimeline";
import { runReportSummary, workActivityRecord } from "@momo/core/features/agents/workReport";
import type { ServerRunFacts } from "@momo/core/features/agents/workingSignal";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import type { RunLedgerView } from "./useRunLedger";
import { closeWorkPanel, openWorkPanel, recordAgentProgress, resetWorkLogs } from "./workLogStore";
import { AgentWorkPanel } from "./AgentWorkPanel";

// =============================================================================
// 작업 패널의 「에이전트 보고」 칸이 **실제로 서는가**(#4657). 줄·계획·접기의 규칙은 코어(`workReport.test`)가,
// 칸의 모양은 `WorkTimelineView.test`가 잰다. 여기서 지키는 것: 칸이 패널의 어디에 서는가(기록 뒤, oort 기록 앞),
// 서버가 지금 돈다고 말하고 연결이 살아 있을 때만 점이 서는가, 끊기면 「마지막으로 확인된 상태」가 말하는가,
// 서지 않는 때가 있는가, 건강 줄과 좁힌 「보낸 글과 도구 호출」 문장이 패널에 붙어 있는가.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const ME = "00000000-0000-7000-8000-000000000101";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;
const MIN = 60_000;

const hoisted = vi.hoisted(() => ({
  facts: null as unknown,
  ledger: null as unknown,
  conn: "connected" as "connected" | "disconnected",
}));

vi.mock("./agentRunProgressStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentRunProgressStore")>();
  return {
    ...actual,
    useRunFacts: () => hoisted.facts as ServerRunFacts | null,
    useChannelRuns: () => [],
    useRunRow: () => null,
  };
});
vi.mock("./useRunLedger", () => ({ useRunLedger: () => hoisted.ledger }));
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useDirectory: () => ({ directory: makeDirectory([]) }),
    useChannels: () => ({ groups: { channels: [], dms: [] } }),
  };
});
vi.mock("@/features/inbox/useInbox", () => ({ useApprovalCardPath: () => null }));
vi.mock("./AgentLivenessLabel", () => ({ AgentLivenessBar: () => null }));
vi.mock("./StopRunControl", () => ({ StopRunControl: () => null }));
vi.mock("@/features/common/MemberAvatar", () => ({ MemberAvatar: () => null }));

let korean: AppLocale;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  resetWorkLogs();
  hoisted.conn = "connected";
  openWorkPanel({ runId: RUN, memberId: AGENT, channelId: CH, origin: "activity" });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  closeWorkPanel();
  hoisted.facts = null;
  hoisted.ledger = null;
});

const facts = (extra: Partial<ServerRunFacts> = {}): ServerRunFacts => ({
  phase: "running",
  leaseState: "live",
  queuedAtMs: T,
  ...extra,
});

function view(
  wire: Record<string, unknown>,
  phase: ServerRunFacts["phase"] = "running",
  read = true
): RunLedgerView {
  const ledger = agentRunLedgerFromWire({ runId: RUN, ...wire });
  const open = phase === "running" || phase === "claimed" || phase === "awaiting_approval";
  return {
    rows: ledgerRows(ledger.events),
    events: ledger.events,
    doorbell: null,
    tools: read ? workToolRecord(ledger) : null,
    activity: read ? workActivityRecord(ledger, { open, working: phase === "running" }) : null,
    report: read ? runReportSummary(ledger) : null,
    isLoading: false,
    isError: false,
  };
}

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = {
    workspaceId: WS,
    connStatus: hoisted.conn,
    session: { member: { id: ME } },
  } as unknown as SessionContextValue;
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
        createElement(
          SessionProvider,
          { value: session },
          createElement(LocaleProvider, { locale: korean, children: createElement(AgentWorkPanel) })
        )
      )
    );
  });
  return host;
}

const q = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)];
const text = (el: Element | null) => el?.textContent ?? "";
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

function activity(
  ordinal: number,
  id: string,
  over: Partial<{ kind: string; label: string; status: string; n: number }> = {}
) {
  return {
    ordinal,
    kind: "activity",
    createdAtMs: T + ordinal * 1000,
    activity: { id, kind: "edit", status: "completed", n: 1, startedAtMs: T + ordinal * 1000, ...over },
  };
}

const EVENTS = [
  { ordinal: 1, kind: "queued", createdAtMs: T },
  { ordinal: 2, kind: "claimed", createdAtMs: T + 1000 },
  { ordinal: 3, kind: "stage", stage: "문서 읽는 중", createdAtMs: T + 2000 },
  activity(4, "r1", { kind: "read", n: 9 }),
  activity(5, "s1", { kind: "search", n: 3 }),
  activity(6, "e1", { kind: "edit", label: "리포트 고치기", status: "in_progress" }),
  activity(7, "c1", { kind: "run", label: "테스트 돌리기", status: "in_progress" }),
  {
    ordinal: 8,
    kind: "plan",
    createdAtMs: T + 8000,
    plan: [
      { text: "문서 읽기", status: "completed" },
      { text: "표 정리", status: "completed" },
      { text: "리포트 고치기", status: "in_progress" },
      { text: "요약 쓰기", status: "pending" },
    ],
  },
];
const TALLY = [
  { kind: "read", completed: 9, failed: 0 },
  { kind: "search", completed: 3, failed: 0 },
];

describe("작업 패널의 「에이전트 보고」 칸", () => {
  it("기록 칸과 oort 기록 칸 사이에 따로 서고, 계획 블록 → 활동 줄 → 합계 순이며, 점은 진행 중인 마지막 행 하나다", () => {
    hoisted.facts = facts();
    hoisted.ledger = view({ events: EVENTS, activityTally: TALLY, activityRowsTrimmed: true, toolTally: [], toolCallRowsCapped: false });
    const el = mount();

    const record = q(el, "agent-work-panel-record") as Element;
    const report = q(el, "agent-work-panel-agent-report") as Element;
    const oort = q(el, "agent-work-panel-oort-record") as Element;
    expect(before(record, report) && before(report, oort)).toBe(true);
    expect(text(q(report, "work-timeline-source-badge"))).toBe("에이전트 보고");
    expect(text(q(report, "work-timeline-source-note"))).toContain("oort가 확인한 것은 아니에요");
    // 기록 칸에는 활동이 서지 않는다(수명주기와 단계만).
    expect(qa(record, "agent-work-panel-ledger-row").map((row) => row.getAttribute("data-kind"))).toEqual(["queued", "claimed", "stage"]);

    // 계획 블록: 줄 위. 완료·완료·지금·대기가 모양과 낱말로도 갈린다.
    const plan = q(report, "agent-work-panel-plan") as Element;
    const rows = q(report, "work-timeline-rows") as Element;
    expect(text(q(plan, "agent-work-panel-plan-title"))).toBe("계획 · 4단계 중 2단계 완료");
    expect(qa(plan, "agent-work-panel-plan-step").map((step) => step.getAttribute("data-step"))).toEqual(["done", "done", "current", "pending"]);
    expect(qa(plan, "agent-work-panel-plan-step").map((step) => text(step.querySelector(".sr-only")))).toEqual(["완료", "완료", "지금 단계", "대기"]);
    expect(before(plan, rows)).toBe(true);

    // 활동 줄: 끝난 읽기·검색은 한 줄로 가라앉고 진행 중은 개별 줄이다.
    expect(qa(rows, "work-timeline-label").map(text)).toEqual(["읽기 9 · 검색 3", "리포트 고치기", "테스트 돌리기"]);
    expect(qa(rows, "work-timeline-row").map((row) => row.getAttribute("data-status"))).toEqual(["done", "running", "running"]);
    // 움직이는 것은 진행 중인 마지막 행의 점 하나뿐이다.
    const dots = qa(report, "work-timeline-dot");
    expect(dots).toHaveLength(1);
    expect(qa(rows, "work-timeline-row")[2]?.contains(dots[0] as Element)).toBe(true);

    // 합계와 상한 문장은 줄 아래다(줄이 붙을 때 달라지는 것은 모두 줄 아래라서 위 행이 밀리지 않는다).
    const tally = q(report, "agent-work-panel-agent-tally") as Element;
    expect(text(tally)).toBe("끝낸 활동 합계 · 읽기 9 · 검색 3");
    expect(text(q(report, "agent-work-panel-agent-trimmed"))).toBe("오래된 활동 일부는 합계로만 남았어요.");
    expect(before(rows, tally)).toBe(true);
  });

  it("연결이 끊기면 점이 걷히고 진행 중 칩은 에이전트색을 잃으며 「마지막으로 확인된 상태」가 말한다. 서버가 돈다고 하지 않아도 점은 없다", () => {
    hoisted.facts = facts();
    hoisted.ledger = view({ events: EVENTS, activityTally: TALLY });
    hoisted.conn = "disconnected";
    const el = mount();
    expect(qa(el, "work-timeline-dot")).toHaveLength(0);
    const chips = qa(q(el, "agent-work-panel-agent-report") as Element, "work-timeline-status");
    expect(chips.map(text)).toEqual(["진행 중", "진행 중"]);
    expect(chips.every((chip) => !chip.hasAttribute("data-live"))).toBe(true);
    expect(text(q(el, "agent-work-panel-stale"))).toContain("마지막으로 확인된 상태예요");
    // 지난 계획도 그대로 서 있다(지운 것이 아니라 마지막으로 확인된 것이다).
    expect(q(el, "agent-work-panel-plan")).not.toBeNull();

    // 연결은 살아 있어도 서버가 승인을 기다린다고 하면 일하는 중이 아니다: 점이 없다.
    act(() => root?.unmount());
    host?.remove();
    hoisted.conn = "connected";
    hoisted.facts = facts({ phase: "awaiting_approval" });
    hoisted.ledger = view({ events: EVENTS, activityTally: TALLY }, "awaiting_approval");
    expect(qa(mount(), "work-timeline-dot")).toHaveLength(0);
  });

  it("끝난 run의 진행 중 활동은 「끝 보고 없음」이고 점도 지금 단계도 없으며, 서지 않는 때(대기·모르는 run·못 읽음)가 있다", () => {
    hoisted.facts = facts({ phase: "succeeded", finishedAtMs: T + MIN });
    hoisted.ledger = view({ events: EVENTS, activityTally: TALLY }, "succeeded");
    const ended = mount();
    const report = q(ended, "agent-work-panel-agent-report") as Element;
    expect(qa(report, "work-timeline-status").map(text)).toEqual(["끝 보고 없음", "끝 보고 없음"]);
    expect(qa(report, "work-timeline-dot")).toHaveLength(0);
    expect(qa(report, "agent-work-panel-plan-step").map((step) => step.getAttribute("data-step"))).toEqual(["done", "done", "pending", "pending"]);
    expect(text(q(report, "agent-work-panel-plan-note"))).toBe("지금은 돌고 있지 않아요. 마지막으로 알린 계획이에요.");

    for (const [name, f, v] of [
      ["가져가지 않은 요청", facts({ phase: "queued" }), view({ events: [], activityTally: [] }, "claimed")],
      ["서버가 모르는 run", null, view({ events: EVENTS, activityTally: TALLY })],
      ["원장을 아직 못 읽음", facts(), view({ events: EVENTS, activityTally: TALLY }, "running", false)],
    ] as const) {
      act(() => root?.unmount());
      host?.remove();
      hoisted.facts = f;
      hoisted.ledger = v;
      expect(q(mount(), "agent-work-panel-agent-report"), name).toBeNull();
    }
  });

  it("구 서버는 「서버 업데이트 뒤에 보여요」, 알린 것이 없으면 열린 run과 끝난 run이 다른 말을 하고 0이라 하지 않는다", () => {
    hoisted.facts = facts();
    hoisted.ledger = view({ events: EVENTS.slice(0, 3) });
    const old = mount();
    expect(text(q(old, "agent-work-panel-agent-unsupported"))).toBe("에이전트가 알린 활동은 서버 업데이트 뒤에 보여요.");
    expect(q(old, "work-timeline-rows")).toBeNull();
    expect(text(q(old, "agent-work-panel-agent-report"))).not.toMatch(/0/);

    act(() => root?.unmount());
    host?.remove();
    hoisted.ledger = view({ events: EVENTS.slice(0, 3), activityTally: [] });
    expect(text(q(mount(), "agent-work-panel-agent-empty"))).toBe("아직 에이전트가 알린 활동이 없어요.");
    act(() => root?.unmount());
    host?.remove();
    hoisted.facts = facts({ phase: "succeeded", finishedAtMs: T + MIN });
    hoisted.ledger = view({ events: EVENTS.slice(0, 3), activityTally: [] }, "succeeded");
    expect(text(q(mount(), "agent-work-panel-agent-empty"))).toBe("이 일에서 에이전트가 알린 활동은 없었어요.");
  });

  it("건강 줄은 서버 사실로 서고 신호가 없으면 없으며, 「보낸 글과 도구 호출」 칸의 문장은 그 칸이 보이는 것만 말한다", () => {
    const now = Date.now();
    hoisted.facts = facts({ lastEventAtMs: now - 8 * MIN });
    hoisted.ledger = view({
      events: [
        { ordinal: 1, kind: "stage", stage: "표 정리", createdAtMs: now - 12 * MIN },
        { ordinal: 2, kind: "activity", createdAtMs: now - 9 * MIN, activity: { id: "a1", kind: "edit", status: "failed", n: 1, startedAtMs: now - 10 * MIN } },
      ],
      activityTally: [{ kind: "edit", completed: 0, failed: 1 }],
    });
    const unmount = () => {
      act(() => root?.unmount());
      host?.remove();
    };
    // 머리 줄(`agent-work-panel-detail`)이 「마지막 보고 n분 전」을 이미 말해서 건강 줄은 그 시간을 되풀이하지 않는다(#5174 L1).
    const panelEl = mount();
    expect(text(q(panelEl, "agent-work-panel-health"))).toBe("조용해요 · 같은 단계에 12분째 · 실패한 활동 1");
    expect(text(q(panelEl, "agent-work-panel-detail"))).toContain("마지막 보고");
    expect(text(q(panelEl, "agent-work-panel-health"))).not.toContain("마지막 보고");
    // 연결이 끊기면 시간 신호는 서지 않고(끊긴 화면의 「n분 전」은 우리 시계 혼자 흘러간 숫자다) 개수만 남는다.
    unmount();
    hoisted.conn = "disconnected";
    expect(text(q(mount(), "agent-work-panel-health"))).toBe("실패한 활동 1");
    unmount();
    hoisted.conn = "connected";
    // 서버가 아는 run의 「보낸 글과 도구 호출」: 이 칸이 보이는 것(연 뒤에 도착한 글·도구 호출)만 말하고 저장 여부도 이 칸에 한정한다.
    const el = mount();
    act(() => {
      recordAgentProgress({
        type: "agent.partial",
        v: 1,
        ts: Date.now(),
        payload: { run_id: RUN, channel_id: CH, text_delta: "표를 정리했어요" },
      });
    });
    const limit = text(q(el, "agent-work-panel-stream-limit"));
    expect(limit).toBe("이 패널을 연 뒤에 도착한 흐르는 글과 도구 호출만 이 칸에 보이고, 이 칸의 내용은 저장하지 않아요.");
    expect(limit).not.toContain("도구 호출은 저장하지 않아요");

    unmount();
    hoisted.facts = facts({ lastEventAtMs: now - 30_000 });
    hoisted.ledger = view({ events: [{ ordinal: 1, kind: "stage", stage: "표 정리", createdAtMs: now - 30_000 }], activityTally: [] });
    expect(q(mount(), "agent-work-panel-health")).toBeNull();
  });
});
