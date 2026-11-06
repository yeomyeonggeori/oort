// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { agentRunLedgerFromWire, ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ledgerRows } from "@momo/core/features/agents/runLedger";
import type { ServerRunFacts } from "@momo/core/features/agents/workingSignal";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import type { RunLedgerView } from "./useRunLedger";
import { closeWorkPanel, openWorkPanel, resetWorkLogs } from "./workLogStore";
import { AgentWorkPanel } from "./AgentWorkPanel";

// =============================================================================
// #5279 B: 작업 패널의 「기록」 칸이 서버 원장을 못 읽었을 때. 옛 「기록을 읽지 못했어요.」는 이유가 없었다. 이제 같은 줄이 원인(오프라인 / 서버에
// 닿지 못함 / 그 밖)을 말하고, 그 뒤에 지킬 수 있는 약속 한 문장이 따른다(열린 run은 잠시 뒤 스스로 다시 읽고, 끝난 run은 패널을 다시 열어야 읽는다).
// 단추가 없는 줄이라 이유는 다음 행동을 뺀 문장이다. 받아 둔 줄이 있으면 줄은 그 위가 아니라 아래에서 말하고 기록은 그대로 서 있다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const ME = "00000000-0000-7000-8000-000000000101";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;

const hoisted = vi.hoisted(() => ({ facts: null as unknown, ledger: null as unknown }));

vi.mock("./agentRunProgressStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentRunProgressStore")>();
  return { ...actual, useRunFacts: () => hoisted.facts as ServerRunFacts | null, useChannelRuns: () => [], useRunRow: () => null };
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
let onLine: MockInstance<() => boolean>;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  resetWorkLogs();
  openWorkPanel({ runId: RUN, memberId: AGENT, channelId: CH, origin: "activity" });
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  closeWorkPanel();
  hoisted.facts = null;
  hoisted.ledger = null;
  onLine.mockRestore();
});

const facts = (phase: ServerRunFacts["phase"]): ServerRunFacts => ({ phase, leaseState: "live", queuedAtMs: T });

function failedLedger(error: unknown, withRows: boolean): RunLedgerView {
  const ledger = agentRunLedgerFromWire({
    runId: RUN,
    events: withRows ? [{ ordinal: 1, kind: "queued", createdAtMs: T }, { ordinal: 2, kind: "claimed", createdAtMs: T + 1000 }] : [],
  });
  return {
    rows: ledgerRows(ledger.events),
    events: ledger.events,
    doorbell: null,
    tools: null,
    activity: null,
    report: null,
    isLoading: false,
    isError: true,
    error,
  };
}

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = { workspaceId: WS, connStatus: "connected", session: { member: { id: ME } } } as unknown as SessionContextValue;
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
const lineOf = (el: ParentNode) => el.querySelector('[data-testid="agent-work-panel-ledger-error"]');

describe("작업 패널 기록 칸의 읽기 실패 (#5279 B)", () => {
  const causes: [string, () => unknown, boolean, string][] = [
    ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
    ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
    ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
  ];

  it("원인마다 다른 이유를 말하고, 열린 run은 스스로 다시 읽는다는 약속을 한다. 상태 코드는 없다", () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      hoisted.facts = facts("running");
      hoisted.ledger = failedLedger(failure(), false);
      const el = mount();
      const text = lineOf(el)?.textContent ?? "";
      expect(text, name).toBe(`기록을 불러오지 못했어요. ${reason} 잠시 뒤에 다시 읽어요.`);
      expect(text, name).not.toMatch(/\d{3}/);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("끝난 run은 스스로 다시 읽지 않으므로 지킬 수 있는 말만 한다: 패널을 다시 열면 다시 읽어요", () => {
    onLine.mockReturnValue(true);
    hoisted.facts = facts("succeeded");
    hoisted.ledger = failedLedger(new NetworkError("unreachable", 15_000), false);
    const text = lineOf(mount())?.textContent ?? "";
    expect(text).toBe("기록을 불러오지 못했어요. 서버에 닿지 못했어요. 패널을 다시 열면 다시 읽어요.");
    expect(text).not.toContain("잠시 뒤에");
  });

  it("받아 둔 기록 줄이 있으면 실패 줄이 그 줄을 지우지 않는다", () => {
    onLine.mockReturnValue(true);
    hoisted.facts = facts("running");
    hoisted.ledger = failedLedger(new NetworkError("unreachable", 15_000), true);
    const el = mount();
    expect(lineOf(el)).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="agent-work-panel-ledger-row"]').length).toBe(2);
  });
});
