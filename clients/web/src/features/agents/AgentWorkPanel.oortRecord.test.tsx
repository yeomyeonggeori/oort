// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRunLedgerFromWire } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ledgerRows } from "@momo/core/features/agents/runLedger";
import { workToolRecord } from "@momo/core/features/agents/workTimeline";
import type { ServerRunFacts } from "@momo/core/features/agents/workingSignal";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import type { RunLedgerView } from "./useRunLedger";
import { closeWorkPanel, openWorkPanel, resetWorkLogs } from "./workLogStore";
import { AgentWorkPanel } from "./AgentWorkPanel";

// =============================================================================
// 작업 패널에 「oort 기록」 칸이 **실제로 서는가**(#4654). 칸 안의 줄은 `WorkTimelineView.test`가,
// 규칙은 core가 잰다. 여기서 지키는 것: 칸이 패널에 붙어 있는가, 기존 「기록」 칸과 **따로** 서는가
// (도구 호출이 기록 칸에 섞이지 않는가), 서버가 모르는 run·아직 못 읽은 원장에는 서지 않는가.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const ME = "00000000-0000-7000-8000-000000000101";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;

const hoisted = vi.hoisted(() => ({
  facts: null as unknown,
  ledger: null as unknown,
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

function ledgerView(wire: Record<string, unknown>, read = true): RunLedgerView {
  const ledger = agentRunLedgerFromWire({ runId: RUN, ...wire });
  return {
    rows: ledgerRows(ledger.events),
    doorbell: null,
    tools: read ? workToolRecord(ledger) : null,
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
    connStatus: "connected",
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

const EVENTS = [
  { ordinal: 1, kind: "queued", createdAtMs: T },
  { ordinal: 2, kind: "claimed", createdAtMs: T + 1000 },
  { ordinal: 3, kind: "tool_call", tool: "oort_run_event", code: "ok", durationMs: 30, createdAtMs: T + 2000 },
  { ordinal: 4, kind: "tool_call", tool: "oort_run_event", code: "ok", durationMs: 31, createdAtMs: T + 3000 },
  { ordinal: 5, kind: "stage", stage: "프로필 읽기", createdAtMs: T + 4000 },
  { ordinal: 6, kind: "tool_call", tool: "oort_job_renew", code: "conflict", durationMs: 9, createdAtMs: T + 5000 },
];
const TALLY = [
  { tool: "oort_run_event", ok: 2, error: 0, durationMsSum: 61 },
  { tool: "oort_job_renew", ok: 0, error: 1, durationMsSum: 9 },
];

describe("작업 패널의 「oort 기록」 칸", () => {
  it("서버가 아는 run에는 「기록」 칸 바로 뒤에 따로 서고, 도구 호출은 「기록」 칸에 섞이지 않는다", () => {
    hoisted.facts = facts();
    hoisted.ledger = ledgerView({ events: EVENTS, toolTally: TALLY, toolCallRowsCapped: false });
    const el = mount();

    const record = q(el, "agent-work-panel-record");
    const oort = q(el, "agent-work-panel-oort-record");
    expect(record).not.toBeNull();
    expect(oort).not.toBeNull();
    // 문서 순서: 기록 칸이 먼저, oort 기록 칸이 그 뒤.
    expect((record as Element).compareDocumentPosition(oort as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 기록 칸의 줄에는 도구 호출 종류가 없다. 수명주기와 에이전트 단계만 서 있다.
    expect(qa(record as Element, "agent-work-panel-ledger-row").map((row) => row.getAttribute("data-kind"))).toEqual([
      "queued",
      "claimed",
      "stage",
    ]);
    // oort 기록 칸은 자기 출처의 줄만 갖는다.
    expect(qa(oort as Element, "work-timeline-row").map((row) => row.getAttribute("data-source"))).toEqual([
      "oort",
      "oort",
    ]);
    expect(qa(oort as Element, "work-timeline-label").map((label) => label.textContent)).toEqual([
      "진행 알리기 · 2번",
      "맡은 시간 늘리기",
    ]);
    expect(q(oort as Element, "agent-work-panel-oort-summary")?.textContent).toBe("도구 호출 3번 · 실패 1번");
  });

  it("구 서버(합계 없는 응답)에서도 칸이 서서 「서버 업데이트 뒤에 보여요」라고 말한다", () => {
    hoisted.facts = facts();
    hoisted.ledger = ledgerView({ events: EVENTS.slice(0, 2) });
    const el = mount();
    expect(q(el, "agent-work-panel-oort-unsupported")?.textContent).toBe(
      "oort 호출 기록은 서버 업데이트 뒤에 보여요."
    );
  });

  it("서버가 모르는 run이거나 원장을 아직 못 읽었으면 서지 않는다", () => {
    hoisted.facts = null;
    hoisted.ledger = ledgerView({ events: EVENTS, toolTally: TALLY });
    expect(q(mount(), "agent-work-panel-oort-record")).toBeNull();
    act(() => root?.unmount());
    host?.remove();

    hoisted.facts = facts();
    hoisted.ledger = ledgerView({ events: EVENTS, toolTally: TALLY }, false);
    expect(q(mount(), "agent-work-panel-oort-record")).toBeNull();
  });
});
