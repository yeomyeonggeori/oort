// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  agentRunProgressFromWire,
  type AgentLiveness,
  type AgentRunProgress,
  type Channel,
  type RosterMember,
} from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import type { AgentWorkingSignal } from "@/features/agents/agentWorkingSignal";
import { SidebarNowCard } from "./SidebarNowCard";
import { nowCardWaitingAgentId } from "./nowCardLiveness";

// =============================================================================
// 작업 중 카드: 누가 기다리는 일만 싣고, 아무도 가져가지 않은 사람 요청은 정직하게 말한다
// (#4285, ADR-0200 증보 3 E6). 폰 홈 카드(`buildWorkingCard`)와 같은 코어 판정이다. 사이드바에는
// 시계가 없으므로 경과 시간은 싣지 않는다 — 「5시간째」는 대화 아래 활동 줄의 몫이다. 문구는 mock하지
// 않고 화면의 글자를 센다.
// =============================================================================

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const CH = "00000000-0000-7000-8000-000000000201";
const CH2 = "00000000-0000-7000-8000-000000000202";
const AGENT = "00000000-0000-7000-8000-00000000a001";
const AGENT2 = "00000000-0000-7000-8000-00000000a002";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const RUN2 = "0199aa11-2222-7000-8000-0000000000b2";

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
  member(AGENT, "달무리봇", "dalmuri-bot"),
  member(AGENT2, "모래시계봇", "sand-bot"),
]);
const channels: Channel[] = [
  { id: CH, workspaceId: "w", kind: "public", name: "general", muted: false } as Channel,
  { id: CH2, workspaceId: "w", kind: "public", name: "design", muted: false } as Channel,
];

/** 사람이 부른 대기 run(트리거 메시지가 있다). 서버가 알린 사실 그대로. */
function queued(over: Partial<AgentRunProgress> = {}): AgentWorkingSignal {
  const signal = signalFromProgress({
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    queuePosition: 1,
    createdAtMs: NOW - 5 * HOUR,
    updatedAtMs: NOW - 5 * HOUR,
    ...over,
  });
  if (signal === null) throw new Error("signal");
  return signal;
}

function liveness(state: AgentLiveness["state"]): AgentLiveness {
  return { agentMemberId: AGENT, state, lastSignalAtMs: NOW - 3 * HOUR };
}

function keyed(...signals: AgentWorkingSignal[]) {
  return new Map(signals.map((s) => [`${s.channelId}|${s.memberId}|${s.runId}`, s]));
}

function mount(signals: AgentWorkingSignal[], liveness?: AgentLiveness | null, live = true) {
  return render(
    <MemoryRouter>
      <SidebarNowCard
        signals={keyed(...signals)}
        nowMs={NOW}
        live={live}
        directory={directory}
        channels={channels}
        selfMemberId="me"
        liveness={liveness}
      />
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe("부른 사람이 없는 시스템 작업(환영)은 카드가 아니다", () => {
  it("5시간째 대기여도 카드를 그리지 않는다", () => {
    const { container } = mount([queued({ id: RUN, triggerMessageId: undefined, system: true })]);
    expect(container.innerHTML).toBe("");
  });

  it("서버가 알린 환영 작업의 와이어 모양(트리거 메시지도 제목도 없음)도 카드를 그리지 않는다 — 와이어 경계가 system을 달아야 한다", () => {
    // 위 시험은 `system: true`를 손으로 쥐여 준다. 이 시험은 서버가 실제로 보내는 모양을 와이어 경계
    // (`agentRunProgressFromWire`)에 통과시켜, 경계가 환영 run을 시스템으로 가르지 않으면 카드가 서서
    // 「아직 받지 않았어요」+이유를 말하게 되는 길(2026-10-23 폰 캡처의 5시간째 환영 작업)을 잠근다.
    const welcome = signalFromProgress(
      agentRunProgressFromWire({
        id: RUN,
        channelId: CH,
        agentMemberId: AGENT,
        status: "queued",
        phase: "queued",
        leaseState: "none",
        stepCount: 0,
        queuePosition: 1,
        createdAtMs: NOW - 5 * HOUR,
        updatedAtMs: NOW - 5 * HOUR,
      })
    );
    if (welcome === null) throw new Error("signal");
    const { container } = mount([welcome], liveness("woken_not_collected"));
    expect(container.innerHTML).toBe("");
  });

  it("제목이 U+FEFF뿐인 작업도 카드에 선다 — 서버가 제목으로 센 글자를 「없음」으로 읽으면 사람의 요청이 사라진다 (planner 결정 1)", () => {
    const work = signalFromProgress(
      agentRunProgressFromWire({
        id: RUN,
        channelId: CH,
        agentMemberId: AGENT,
        triggerSummary: "\uFEFF",
        status: "queued",
        phase: "queued",
        leaseState: "none",
        stepCount: 0,
        queuePosition: 1,
        createdAtMs: NOW - 10 * MIN,
        updatedAtMs: NOW - 10 * MIN,
      })
    );
    if (work === null) throw new Error("signal");
    mount([work]);
    expect(screen.getByTestId("sidebar-now-card").textContent).toContain("아직 받지 않았어요");
  });

  it("카드는 사람이 부른 요청이고 「외 n건」도 숨은 일을 세지 않는다", () => {
    mount([
      queued({
        id: RUN2,
        agentMemberId: AGENT2,
        channelId: CH2,
        triggerMessageId: undefined,
        system: true,
        createdAtMs: NOW - 30 * HOUR,
      }),
      queued({ createdAtMs: NOW - 6 * MIN }),
    ]);
    const card = screen.getByTestId("sidebar-now-card");
    expect(card.getAttribute("href")).toBe(`/c/${CH}`);
    expect(card.textContent).toContain("달무리봇");
    expect(card.textContent).not.toContain("모래시계봇");
    expect(card.textContent).not.toContain("외 ");
  });
});

describe("아무도 가져가지 않은 채 5분을 넘은 사람 요청", () => {
  it("끊긴 레일에서는 이유 줄이 서지 않는다 — 폰 카드와 같은 규칙이다 (design-review #4285 r1 M2·r2 N2)", () => {
    mount([queued()], liveness("woken_not_collected"), false);
    const card = screen.getByTestId("sidebar-now-card");
    // 낱말과 근거 문구는 마지막으로 확인된 사실 그대로 남고, 끊김은 카드가 따로 말한다.
    expect(screen.getByTestId("sidebar-now-state").textContent).toBe("아직 받지 않았어요");
    expect(screen.queryByTestId("sidebar-now-reason")).toBeNull();
    expect(card.getAttribute("aria-label")).not.toContain("연결이 꺼져 있을 수 있어요");
    // 살아 있을 때는 같은 입력에서 이유가 선다(대조).
    cleanup();
    mount([queued()], liveness("woken_not_collected"), true);
    expect(screen.getByTestId("sidebar-now-reason").textContent).toBe("연결이 꺼져 있을 수 있어요");
  });

  it("낱말은 한 덩어리로 서고(줄바꿈·줄어듦 없음) 좁은 열에서는 이름이 줄임표를 받는다 — 「아직 받지 않았어 / 요」로 꺾이지 않는다", () => {
    // design-review #4285 r1 H3. jsdom은 배치를 재지 못하므로 클래스를 잠그고, 실제 Chromium 폭 측정은
    // `scripts/capture-4285.mjs`의 긴 이름 장면이 한다(상태 낱말이 한 줄, 이름이 줄임표).
    mount([queued()], liveness("woken_not_collected"));
    const state = screen.getByTestId("sidebar-now-state");
    expect(state.className).toContain("shrink-0");
    expect(state.className).toContain("whitespace-nowrap");
    const name = screen.getByTestId("sidebar-now-card").querySelector(".sidebar-now-name");
    expect(name?.className).toContain("truncate");
  });

  it("낱말은 「아직 받지 않았어요」, 장소 줄에 서버의 경고가 짧은 낱말로 붙고, 이유 문장이 둘째 줄에 선다", () => {
    mount([queued()], liveness("woken_not_collected"));
    const card = screen.getByTestId("sidebar-now-card");
    expect(card.hasAttribute("data-uncollected")).toBe(true);
    expect(screen.getByTestId("sidebar-now-state").textContent).toBe("아직 받지 않았어요");
    expect(screen.getByTestId("sidebar-now-line").textContent).toBe("#general · 안 가져감");
    expect(screen.getByTestId("sidebar-now-reason").textContent).toBe("연결이 꺼져 있을 수 있어요");
    expect(card.textContent).not.toContain("대기 1번째");
    // 낭독 이름이 같은 사실을 한 문장으로 말한다.
    const label = card.getAttribute("aria-label") ?? "";
    expect(label).toContain("아직 받지 않았어요");
    expect(label).toContain("안 가져감");
    expect(label).toContain("연결이 꺼져 있을 수 있어요");
  });

  it("사이드바에는 시계가 없다 — 경과 시간(5시간째)도 숫자도 싣지 않는다", () => {
    mount([queued()], liveness("unresponsive"));
    const text = screen.getByTestId("sidebar-now-card").textContent ?? "";
    expect(text).not.toMatch(/[0-9]/);
    expect(text).not.toContain("째");
    expect(screen.getByTestId("sidebar-now-line").textContent).toBe("#general · 응답 없음");
  });

  it("호스티드가 아니거나(null) 아직 읽는 중이면(undefined) 낱말만 바뀌고 문구·이유는 지어내지 않는다", () => {
    for (const unknown of [null, undefined]) {
      cleanup();
      mount([queued()], unknown);
      expect(screen.getByTestId("sidebar-now-state").textContent).toBe("아직 받지 않았어요");
      expect(screen.getByTestId("sidebar-now-line").textContent).toBe("#general");
      expect(screen.queryByTestId("sidebar-now-reason")).toBeNull();
    }
  });

  it("살아 있는데 일을 안 가져가는 에이전트에는 「연결이 꺼져 있을 수 있어요」를 붙이지 않는다", () => {
    mount([queued()], liveness("work_waiting"));
    expect(screen.getByTestId("sidebar-now-line").textContent).toBe("#general · 일이 밀림");
    expect(screen.queryByTestId("sidebar-now-reason")).toBeNull();
  });

  it("5분이 안 된 요청은 서버가 말한 「대기 n번째」 그대로이고 이유가 없다", () => {
    mount([queued({ createdAtMs: NOW - 2 * MIN, queuePosition: 2 })], liveness("woken_not_collected"));
    const card = screen.getByTestId("sidebar-now-card");
    expect(card.hasAttribute("data-uncollected")).toBe(false);
    expect(screen.getByTestId("sidebar-now-state").textContent).toBe("대기 2번째");
    expect(screen.queryByTestId("sidebar-now-reason")).toBeNull();
    // 경고 라벨은 N과 무관하게 선다(E6) — 응답 없는 에이전트에게 방금 보낸 요청에도.
    expect(screen.getByTestId("sidebar-now-line").textContent).toBe("#general · 안 가져감");
  });

  it("가져간(claimed) run은 「받지 않았어요」가 아니다", () => {
    mount(
      [
        queued({
          phase: "claimed",
          status: "queued",
          leaseState: "live",
          claimedAtMs: NOW - 20_000,
          queuePosition: undefined,
        }),
      ],
      liveness("woken_not_collected")
    );
    expect(screen.getByTestId("sidebar-now-state").textContent).toBe("가져감");
    expect(screen.queryByTestId("sidebar-now-reason")).toBeNull();
  });
});

describe("nowCardWaitingAgentId — 사이드바가 생존 판정을 읽을 에이전트", () => {
  it("아무도 가져가지 않은 사람 요청의 에이전트만이다", () => {
    expect(nowCardWaitingAgentId(keyed(queued()), NOW)).toBe(AGENT);
    // 일하는 중·가져간 run·시스템 작업·열린 턴 없음은 읽지 않는다(쿼리를 세우지 않는다).
    expect(
      nowCardWaitingAgentId(
        keyed(queued({ phase: "running", status: "running", leaseState: "live", startedAtMs: NOW - MIN })),
        NOW
      )
    ).toBeNull();
    expect(
      nowCardWaitingAgentId(
        keyed(queued({ phase: "claimed", leaseState: "live", claimedAtMs: NOW - MIN })),
        NOW
      )
    ).toBeNull();
    expect(
      nowCardWaitingAgentId(keyed(queued({ triggerMessageId: undefined, system: true })), NOW)
    ).toBeNull();
    expect(nowCardWaitingAgentId(keyed(), NOW)).toBeNull();
  });
});

describe("사이드바 배선", () => {
  // `Sidebar` 전체를 그리는 하네스는 무겁고(수십 개의 mock) 이 배선은 세 줄이다. 소스에서 잠근다
  // (`desktopShell.ds2.test.ts`와 같은 방식): 이 줄이 빠지면 카드는 낱말만 바뀌고 서버의 경고 문구도
  // 이유 문장도 영영 서지 않는다.
  const SIDEBAR = readFileSync(resolve(__dirname, "Sidebar.tsx"), "utf8");

  it("카드 에이전트의 생존 판정을 읽어 카드에 넘긴다", () => {
    expect(SIDEBAR).toMatch(/nowCardWaitingAgentId\(turnSignals, nowMs\)/);
    expect(SIDEBAR).toMatch(/useAgentLiveness\(nowCardAgentId\)/);
    expect(SIDEBAR).toMatch(
      /<SidebarNowCard[\s\S]*?liveness=\{[^}]*nowCardLiveness\.liveness[^}]*\}[\s\S]*?\/>/
    );
  });
});

