// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { AgentWorkingSignal } from "@/features/agents/agentWorkingSignal";
import { TURN_STALE_SENTENCE } from "@/features/agents/turnCopy";
import { SidebarNowCard } from "./SidebarNowCard";

// 작업 중 카드 (DS2-6 #2718). 재는 것은 네 가지다: 열린 턴이 없으면 아무것도
// 없고, 있으면 가장 오래된 턴의 에이전트·상태·채널·마지막 줄을 싣고, 나머지는
// 수로 세며, 레일이 끊기면 확인된 상태처럼 말하지 않는다. 진행 막대는 없다(신호에
// 단계 수가 없다) — 그 부재도 단정한다.

const NOW = 1_800_000_000_000;
const CH = "00000000-0000-7000-8000-000000000201";
const CH2 = "00000000-0000-7000-8000-000000000202";
const AGENT = "00000000-0000-7000-8000-00000000a001";
const AGENT2 = "00000000-0000-7000-8000-00000000a002";

function member(id: string, name: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: "w",
    kind: "agent",
    status: "active",
    displayName: name,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
  } as unknown as RosterMember;
}

const directory = makeDirectory([
  member(AGENT, "hermes", "hermes"),
  member(AGENT2, "김인턴", "kim-intern"),
]);
const channels: Channel[] = [
  { id: CH, workspaceId: "w", kind: "public", name: "general", muted: false } as Channel,
  { id: CH2, workspaceId: "w", kind: "public", name: "엔진", muted: false } as Channel,
];

function signal(over: Partial<AgentWorkingSignal>): AgentWorkingSignal {
  return {
    memberId: AGENT,
    channelId: CH,
    state: "working",
    source: "run",
    startedAtMs: NOW - 60_000,
    headlines: ["outbox drain 워커 재시작 루프 원인 확인 중"],
    lastActivityAtMs: NOW - 1_000,
    ...over,
  } as AgentWorkingSignal;
}

function mount(signals: AgentWorkingSignal[], live = true) {
  const map = new Map(signals.map((s) => [`${s.channelId}|${s.memberId}`, s]));
  return render(
    <MemoryRouter>
      <SidebarNowCard
        signals={map}
        nowMs={NOW}
        live={live}
        directory={directory}
        channels={channels}
        selfMemberId="me"
      />
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe("SidebarNowCard", () => {
  it("열린 턴이 없으면 아무것도 그리지 않는다", () => {
    const { container } = mount([]);
    expect(container.innerHTML).toBe("");
  });

  it("오래 걸린 턴은 카드를 그리지 않는다(시효가 지난 신호)", () => {
    const { container } = mount([signal({ lastActivityAtMs: NOW - 10 * 60_000 })]);
    expect(container.innerHTML).toBe("");
  });

  it("에이전트 · 작업 중 · #채널 · 마지막 줄을 싣고, 그 채널로 간다", () => {
    mount([signal({})]);
    const card = screen.getByTestId("sidebar-now-card");
    expect(card.getAttribute("href")).toBe(`/c/${CH}`);
    expect(card.textContent).toContain("hermes");
    expect(screen.getByTestId("sidebar-now-state").textContent).toBe("작업 중");
    expect(screen.getByTestId("sidebar-now-line").textContent).toBe(
      "#general · outbox drain 워커 재시작 루프 원인 확인 중"
    );
    expect(card.getAttribute("aria-label")).toContain("hermes");
    expect(card.getAttribute("aria-label")).not.toContain(TURN_STALE_SENTENCE);
    // 진행 막대는 그리지 않는다: 신호에 단계 수가 없다.
    expect(card.querySelector("progress, [role='progressbar']")).toBeNull();
  });

  it("가장 오래된 턴을 싣고 나머지는 수로 센다", () => {
    mount([
      signal({ memberId: AGENT2, channelId: CH2, startedAtMs: NOW - 5_000 }),
      signal({ startedAtMs: NOW - 90_000 }),
    ]);
    const card = screen.getByTestId("sidebar-now-card");
    expect(card.getAttribute("href")).toBe(`/c/${CH}`);
    expect(screen.getByTestId("sidebar-now-line").textContent).toContain("외 1건");
  });

  it("승인 대기는 그 낱말로, 마지막 줄 없이 말한다", () => {
    mount([signal({ state: "awaiting_approval" })]);
    expect(screen.getByTestId("sidebar-now-state").textContent).toBe("승인 대기");
    expect(screen.getByTestId("sidebar-now-line").textContent).toBe("#general");
  });

  it("레일이 끊기면 상태를 흐린 글자로 두고 이름에 그 사실을 싣는다", () => {
    mount([signal({})], false);
    const card = screen.getByTestId("sidebar-now-card");
    expect(card.hasAttribute("data-live")).toBe(false);
    expect(screen.getByTestId("sidebar-now-state").className).toContain("text-ink-muted");
    expect(card.getAttribute("aria-label")).toContain(TURN_STALE_SENTENCE);
  });
});
