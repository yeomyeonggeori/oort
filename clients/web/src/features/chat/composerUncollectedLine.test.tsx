// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentLiveness, AgentRunProgress, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import type { AgentLivenessLookup } from "@momo/core/features/agents/turnCopy";
import { AgentActivityBar } from "./Composer";

// =============================================================================
// 컴포저 위 활동 줄: 아무도 가져가지 않은 채 오래 머무는 사람 요청 (#4285, ADR-0200 증보 3 E6).
// 2026-10-24 성재의 DM 캡처 「grok: 대기 1번째 17시간째 기다려요」가 이 줄이다. 낱말은 5분을 넘으면
// 「아직 받지 않았어요」, 근거 줄은 서버의 생존 경고가 앞이고 경과 시간이 뒤이며 근거가 있으면 이유가
// 끝에 선다. 문구는 mock하지 않고 화면의 글자를 센다.
// =============================================================================

const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const AGENT_B = "00000000-0000-7000-8000-000000000302";
const T = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function member(id: string, name: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: "w",
    kind: "agent",
    status: "active",
    displayName: name,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const directory = makeDirectory([
  member(AGENT, "달무리봇", "dalmuri-bot"),
  member(AGENT_B, "모래시계봇", "sand-bot"),
]);

function turn(extra: Partial<AgentRunProgress> = {}) {
  const signal = signalFromProgress({
    id: "0199aa11-2222-7000-8000-0000000000a1",
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    queuePosition: 1,
    createdAtMs: T - 17 * HOUR,
    updatedAtMs: T - 17 * HOUR,
    ...extra,
  });
  if (signal === null) throw new Error("signal");
  return signal;
}

function liveness(state: AgentLiveness["state"]): AgentLiveness {
  return { agentMemberId: AGENT, state, lastSignalAtMs: T - 3 * HOUR };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(turns: ReturnType<typeof turn>[], livenessFor?: AgentLivenessLookup) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(AgentActivityBar, { turns, directory, nowMs: T, live: true, livenessFor })
    )
  );
  return host;
}

const detailOf = (el: HTMLElement) =>
  el.querySelector('[data-testid="composer-working-detail"]')?.textContent;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("아무도 가져가지 않은 채 5분을 넘은 사람 요청", () => {
  it("꼬리는 「아직 받지 않았어요」, 근거 줄은 경고 문구가 앞이고 이유가 끝이다", () => {
    const el = mount([turn()], (id) => (id === AGENT ? liveness("woken_not_collected") : undefined));
    expect(el.textContent).toContain("달무리봇: 아직 받지 않았어요");
    expect(el.textContent).not.toContain("대기 1번째");
    expect(detailOf(el)).toBe("깨웠지만 아직 안 가져감 · 17시간째 기다려요 · 연결이 꺼져 있을 수 있어요");
    // 접근성 이름·툴팁은 숫자 없이 같은 낱말이다.
    expect(el.querySelector("span[title]")?.getAttribute("title")).toBe("달무리봇: 아직 받지 않았어요");
  });

  it("생존 판정을 안 주면(생략) 낱말은 바뀌어도 경고 문구·이유는 없다", () => {
    const el = mount([turn()]);
    expect(el.textContent).toContain("달무리봇: 아직 받지 않았어요");
    expect(detailOf(el)).toBe("17시간째 기다려요");
  });

  it("호스티드가 아닌 에이전트(null)는 경고 문구도 이유도 없다", () => {
    const el = mount([turn()], () => null);
    expect(detailOf(el)).toBe("17시간째 기다려요");
  });

  it("살아 있는데 일을 안 가져가는 에이전트에는 이유를 붙이지 않는다", () => {
    const el = mount([turn()], () => liveness("work_waiting"));
    expect(detailOf(el)).toBe("일이 기다리는 중 · 17시간째 기다려요");
  });

  it("5분이 안 된 요청은 「대기 n번째」 그대로이고 근거 줄은 전과 같다", () => {
    const el = mount(
      [turn({ createdAtMs: T - 3 * MIN, queuePosition: 2, aheadTotal: 1 })],
      () => liveness("responsive")
    );
    expect(el.textContent).toContain("달무리봇: 대기 2번째");
    expect(detailOf(el)).toBe("3분째 기다려요 · 에이전트 앞에 1건");
  });

  it("시스템 작업(환영) 줄은 기존 말이다 — 카드만 숨기고 줄은 그대로 둔다", () => {
    const el = mount([turn({ triggerMessageId: undefined, system: true })], () =>
      liveness("woken_not_collected")
    );
    expect(el.textContent).toContain("달무리봇: 대기 1번째");
    expect(detailOf(el)).toBe("17시간째 기다려요");
  });

  it("가져간(claimed) run은 「받지 않았어요」가 아니다", () => {
    const el = mount(
      [
        turn({
          id: "0199aa11-2222-7000-8000-0000000000a2",
          agentMemberId: AGENT_B,
          phase: "claimed",
          leaseState: "stale",
          claimedAtMs: T - 34 * MIN,
          queuePosition: undefined,
        }),
      ],
      () => liveness("woken_not_collected")
    );
    expect(el.textContent).not.toContain("아직 받지 않았어요");
    expect(detailOf(el)).toBe("가져간 뒤 34분째 소식이 없어요");
  });
});
