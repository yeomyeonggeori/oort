// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { RequestThoughtLine } from "./RequestThoughtLine";

// =============================================================================
// Hermes를 기다리는 동안의 진행 줄 (#5375, planner 2026-11-10 답 ②).
//
// 서버는 위임 stage(「위임: {이름} · 그림」)를 한 번 쓰고 Hermes를 기다리는 동안 원장에 행을 쓰지 않는다. 그래서 줄은
//   - stage 시각부터 종류별 마감(그림 120초·검색 60초, ADR-0201 증보 v4 P4) 안이면 stage 글을 그대로 두고 「그림은 2분까지
//     걸릴 수 있어요」를 같은 줄에 붙인다 — 60초·100초(예전에는 「1분째 소식 없음」).
//   - 마감을 넘기면 원래의 90초 규칙(「N분째 소식 없음」)으로 돌아간다 — 130초. 그 순간을 분 시계보다 먼저 다시 그린다.
// 가짜 시계(`Date`·타이머)로 잰다.
// =============================================================================

vi.mock("./useRunLedger", () => ({ useRunLedger: () => ({ rows: [], report: null, isLoading: false, isError: false }) }));
vi.mock("./RespondingIndicator", async (original) => ({
  ...(await original<typeof import("./RespondingIndicator")>()),
  RespondingAvatar: () => <span aria-hidden="true" />,
}));

const directory = makeDirectory([{ id: "helper", kind: "agent", displayName: "오르트 도우미", channelIds: [] }] as never);
const STAGE_AT = new Date("2026-11-10T05:20:00Z").getTime();
let korean: AppLocale;

beforeAll(async () => {
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function run(stage: string): AgentRunProgress {
  return {
    id: "run",
    channelId: "channel",
    agentMemberId: "helper",
    triggerMessageId: "request",
    phase: "running",
    status: "running",
    leaseState: "live",
    ahead: [],
    stepCount: 1,
    latestStage: stage,
    lastEventAtMs: STAGE_AT,
    createdAtMs: STAGE_AT - 5_000,
    startedAtMs: STAGE_AT - 4_000,
    updatedAtMs: STAGE_AT,
    // 도우미 작업 run(서버가 `spent`를 싣는 run)이다.
    spent: { promptTokens: 3_000, completionTokens: 200, webSearches: 0, estimated: false, delegations: 0 },
  };
}

function mountAt(nowMs: number, stage = "위임: 팀 Hermes · 그림") {
  vi.useRealTimers();
  vi.useFakeTimers({ now: nowMs, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const value = {
    workspaceId: "workspace",
    session: { member: { id: "human", kind: "human" } },
    realtime: { subscribeAgent: () => () => undefined },
    connStatus: "connected",
  } as unknown as SessionContextValue;
  return render(
    <LocaleProvider locale={korean}>
      <SessionProvider value={value}>
        <RequestThoughtLine run={run(stage)} directory={directory} />
      </SessionProvider>
    </LocaleProvider>
  );
}

const line = () => screen.getByTestId("request-thought-line").textContent ?? "";

describe("위임을 기다리는 동안의 진행 줄", () => {
  it("그림 60초: stage 그대로 + 「그림은 2분까지 걸릴 수 있어요」", () => {
    mountAt(STAGE_AT + 60_000);
    expect(line()).toContain("위임: 팀 Hermes · 그림 · 그림은 2분까지 걸릴 수 있어요");
    expect(line()).not.toContain("소식 없음");
  });

  it("그림 100초: 90초를 넘었어도 마감 안이라 「소식 없음」으로 바꾸지 않는다", () => {
    mountAt(STAGE_AT + 100_000);
    expect(line()).toContain("위임: 팀 Hermes · 그림 · 그림은 2분까지 걸릴 수 있어요");
    expect(line()).not.toContain("소식 없음");
  });

  it("그림 130초: 마감을 넘기면 원래 규칙(「2분째 소식 없음」)", () => {
    mountAt(STAGE_AT + 130_000);
    expect(line()).toContain("2분째 소식 없음");
    expect(line()).not.toContain("2분까지 걸릴 수 있어요");
  });

  it("마감 순간에 분 시계를 기다리지 않고 다시 그린다(110초에 열어 둔 줄이 121초에 바뀐다)", () => {
    mountAt(STAGE_AT + 110_000);
    expect(line()).toContain("2분까지 걸릴 수 있어요");
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(line()).toContain("2분째 소식 없음");
  });

  it("검색은 1분: 50초에는 안내, 마감(60초) 뒤 90초 전에는 stage만", () => {
    mountAt(STAGE_AT + 50_000, "위임: 팀 Hermes · 검색");
    expect(line()).toContain("위임: 팀 Hermes · 검색 · 검색은 1분까지 걸릴 수 있어요");
    // 좁은 자리의 짧은 글(#5375 수리 1회차). 어느 쪽이 보이는지는 브라우저 시험(teamAiDelegation.shift)이 잰다.
    expect(line()).toContain("검색 최대 1분");
    cleanup();
    mountAt(STAGE_AT + 70_000, "위임: 팀 Hermes · 검색");
    expect(line()).toContain("위임: 팀 Hermes · 검색");
    expect(line()).not.toContain("1분까지");
  });

  it("위임이 아닌 stage는 예전 그대로(100초면 「1분째 소식 없음」)", () => {
    mountAt(STAGE_AT + 100_000, "조사 중 · 1／3 · 가격 비교");
    expect(line()).toContain("1분째 소식 없음");
  });
});
