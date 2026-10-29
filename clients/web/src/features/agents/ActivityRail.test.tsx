// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunProgress, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { activityRail } from "@momo/core/features/agents/activityRail";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import { UNCOLLECTED_AFTER_MS } from "@momo/core/features/agents/runWaiting";
import { TURN_STALE_SENTENCE } from "@momo/core/features/agents/turnCopy";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { adeDrawerSnapshot, resetAdeDrawer } from "@/features/ade/adeDrawerStore";
import {
  ActivityRailView,
  ComposerActivityRail,
} from "./ActivityRail";
import {
  clearAgentWorking,
  markAgentWorking,
  resetAgentWorking,
} from "./agentWorkingSignal";
import { channelHasAgent, isRailReserved } from "./railReservation";
import { closeWorkPanel, workPanelSnapshot } from "./workLogStore";

const api = vi.hoisted(() => ({ fetchApprovals: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchApprovals: api.fetchApprovals };
});

// =============================================================================
// 입력창 레일 (#4619 A). 칸은 줄이 없어도 선다(높이 예약의 글자 쪽), 줄은 코어 모델의 글자를 그대로 그린다,
// 합치면 한 줄이고, 끊긴 레일에서는 움직임을 두지 않으며, 팝오버의 행동이 기존 표면(작업 패널·활동 서랍)을
// 연다. 칸의 **높이**는 jsdom이 잴 수 없으므로 `ActivityRail.browser.test.tsx`가 실제 엔진에서 잰다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const A = "00000000-0000-7000-8000-000000000301";
const B = "00000000-0000-7000-8000-000000000302";
const RUN_A = "0199aa11-2222-7000-8000-0000000000a1";
const RUN_B = "0199aa11-2222-7000-8000-0000000000a2";
const T = 1_800_000_000_000;
const MIN = 60_000;

function agent(id: string, name: string, handle: string, channelIds: string[] = [CH]): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: name,
    handle,
    channelCount: channelIds.length,
    channelIds,
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const directory = makeDirectory([agent(A, "달무리봇", "dalmuri-bot"), agent(B, "모래시계봇", "sand-bot")]);
const nameFor = (id: string) => ({ name: directory.byId.get(id.toLowerCase())?.displayName ?? "" });

function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: RUN_A,
    channelId: CH,
    agentMemberId: A,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: T,
    updatedAtMs: T,
    ...extra,
  };
}

function turn(extra: Partial<AgentRunProgress> = {}) {
  const signal = signalFromProgress(progress(extra));
  if (signal === null) throw new Error("열린 턴이 아니다");
  return signal;
}

const RUNNING = {
  phase: "running",
  status: "running",
  leaseState: "live",
  claimedAtMs: T,
  startedAtMs: T,
  latestStage: "설계 문서 읽는 중",
  lastEventAtMs: T,
} as const satisfies Partial<AgentRunProgress>;

const NOW = T + 12 * MIN;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function reduceMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function mountView(
  turns: ReturnType<typeof turn>[],
  options: { live?: boolean; nowMs?: number } = {}
) {
  const rail = activityRail(turns, nameFor, options.nowMs ?? NOW);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(ActivityRailView, {
        rail,
        live: options.live ?? true,
        directory,
        channelId: CH,
      })
    )
  );
  return host;
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (el: ParentNode, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  resetAgentWorking();
  resetAdeDrawer();
  closeWorkPanel();
  api.fetchApprovals.mockReset();
  api.fetchApprovals.mockResolvedValue([]);
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  resetAgentWorking();
  resetAdeDrawer();
  closeWorkPanel();
});

describe("레일 칸과 한 줄", () => {
  it("줄이 없어도 칸은 선다(높이 예약): 비어 있고 idle이다", () => {
    const el = mountView([]);
    const shell = q(el, "composer-working");
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute("data-state")).toBe("idle");
    expect(shell?.childElementCount).toBe(0);
    expect(shell?.textContent).toBe("");
  });

  it("작업 중: 얼굴·이름·낱말·최근 단계가 한 줄에 서고, 점은 움직인다", () => {
    reduceMotion(false);
    const el = mountView([turn(RUNNING)]);
    expect(q(el, "composer-working")?.getAttribute("data-state")).toBe("active");
    expect(q(el, "composer-working-text")?.textContent).toBe("달무리봇 · 작업 중 · 설계 문서 읽는 중");
    expect(q(el, "composer-working-text")?.firstElementChild?.className).toContain("text-agent");
    // 살아 있는 줄에는 접히는 조각이 없다: 글이 칸에 맞춰 줄어드는 기존 그대로다(접는 것은 낡은 글인 끊긴 줄만).
    expect(q(el, "composer-working-tail")).toBeNull();
    expect(all(el, "responding-avatar")).toHaveLength(1);
    const dots = q(el, "responding-dots");
    expect(dots?.getAttribute("data-motion")).toBe("full");
    expect([...(dots?.children ?? [])].every((d) => d.classList.contains("responding-dot"))).toBe(true);
    // 보조기술 이름은 줄의 글이 아니라 상태 문장이고, 줄 글(숫자 없음)이 title로 남는다.
    const open = q(el, "composer-working-open");
    expect(open?.getAttribute("aria-label")).toBe(
      "달무리봇 에이전트가 작업 중이에요. 일하는 에이전트 보기"
    );
    expect(open?.getAttribute("title")).toBe("달무리봇 · 작업 중 · 설계 문서 읽는 중");
  });

  it("동작 줄이기에서는 점이 멈춘 채 서고 애니메이션 클래스가 없다", () => {
    reduceMotion(true);
    const el = mountView([turn(RUNNING)]);
    const dots = q(el, "responding-dots");
    expect(dots?.getAttribute("data-motion")).toBe("still");
    expect(dots?.querySelector(".responding-dot")).toBeNull();
    expect(dots?.children).toHaveLength(3);
  });

  it("CSS도 같은 약속을 한다: responding-dot은 reduced-motion에서 animation: none, 투명도만 바꾼다", () => {
    const css = readFileSync(resolve(process.cwd(), "src/design/tokens.css"), "utf8");
    const block = css.slice(css.indexOf("@utility responding-dot"));
    const end = block.indexOf("@keyframes momo-responding");
    const utility = block.slice(0, end);
    expect(utility).toMatch(/animation:\s*momo-responding[^;]*infinite/);
    expect(utility).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*animation:\s*none;/);
    const frames = block.slice(end, block.indexOf("}\n\n", end) + 3);
    expect(frames).not.toMatch(/transform|margin|width|height|top|left/);
  });

  it("받음·승인 대기에는 점이 없다(일하는 중이 아니다). 승인 대기는 사람 몫의 색이다", () => {
    reduceMotion(false);
    const received = mountView([turn()], { nowMs: T + 10_000 });
    expect(q(received, "composer-working-text")?.textContent).toBe("달무리봇 · 받음");
    expect(q(received, "responding-dots")).toBeNull();
    expect(q(received, "composer-working-open")?.className).toContain("text-ink-muted");
    act(() => root?.unmount());
    root = null;
    host?.remove();

    const waiting = mountView([turn({ phase: "awaiting_approval", status: "awaiting_approval", startedAtMs: T })]);
    expect(q(waiting, "composer-working-text")?.textContent).toBe("달무리봇 · 승인 대기");
    expect(q(waiting, "responding-dots")).toBeNull();
    expect(q(waiting, "composer-working-open")?.className).toContain("text-warn");
  });

  it("둘 이상이면 한 줄로 합친다: 「이름 +1」, 얼굴은 둘, 단계는 줄에 없다", () => {
    const el = mountView([
      turn(RUNNING),
      turn({ ...RUNNING, id: RUN_B, agentMemberId: B, startedAtMs: T + MIN, latestStage: "표 정리하는 중" }),
    ]);
    expect(q(el, "composer-working-text")?.textContent).toBe("달무리봇 +1");
    expect(all(el, "responding-avatar")).toHaveLength(2);
    expect(el.textContent).not.toContain("설계 문서");
    expect(all(el, "composer-working-open")).toHaveLength(1);
  });

  it("끊긴 레일에서는 움직임·얼굴을 두지 않고 마지막 확인 문장이 같은 줄에 선다", () => {
    reduceMotion(false);
    const el = mountView([turn(RUNNING)], { live: false });
    expect(q(el, "responding-dots")).toBeNull();
    expect(q(el, "responding-avatar")).toBeNull();
    expect(q(el, "composer-working-stale")?.textContent).toBe(TURN_STALE_SENTENCE);
    // 이름은 에이전트색에서 내려온다: 기억하던 주장을 확인된 것처럼 그리지 않는다.
    expect(q(el, "composer-working-text")?.firstElementChild?.className ?? "").not.toContain("text-agent");
    // 낱말·단계는 한 덩어리로 접히는 조각이다(design-review r2 B1-r2): 좁은 칸에서 「달무리봇 · 작…」처럼 낱말 중간에서 끊기지 않게
    // 이름 뒤를 통째로 접는다(`@max-lg:hidden`). 이름이 첫 자식, 이 조각이 바로 다음 자식이고 글은 한 글자도 줄지 않는다.
    const tail = q(el, "composer-working-tail");
    expect(tail?.className).toContain("@max-lg:hidden");
    expect(tail?.textContent).toBe(" · 작업 중 · 설계 문서 읽는 중");
    expect(q(el, "composer-working-text")?.firstElementChild?.nextElementSibling).toBe(tail);
    expect(q(el, "composer-working-text")?.textContent).toBe("달무리봇 · 작업 중 · 설계 문서 읽는 중");
    expect(q(el, "composer-working-open")?.getAttribute("aria-label")).toContain(TURN_STALE_SENTENCE);
    // 줄은 여전히 하나다(두 번째 줄을 세우지 않는다).
    expect(all(el, "composer-working-open")).toHaveLength(1);
  });
});

describe("팝오버: 일하는 에이전트와 행동", () => {
  function open(el: HTMLElement) {
    act(() => q(el, "composer-working-open")?.click());
    return q(document.body, "composer-working-popover");
  }

  it("눌러야 열린다: 에이전트마다 한 행(이끄는 쪽이 앞), 1분 단위 근거, 「활동 보기」", () => {
    const el = mountView([
      turn({ ...RUNNING, id: RUN_B, agentMemberId: B, startedAtMs: T + 2 * MIN, latestStage: "표 정리하는 중" }),
      turn(RUNNING),
    ]);
    expect(q(document.body, "composer-working-popover")).toBeNull();
    const popover = open(el);
    expect(popover).not.toBeNull();
    const rows = all(popover!, "composer-working-agent");
    expect(rows.map((row) => row.getAttribute("data-member-id"))).toEqual([A, B]);
    expect(rows[0]?.textContent).toContain("달무리봇 · 작업 중 · 설계 문서 읽는 중");
    // 경과는 팝오버에서만, 1분 단위로.
    expect(rows[0]?.textContent).toContain("12분째");
    expect(rows[1]?.textContent).toContain("10분째");
    expect(popover?.textContent).not.toMatch(/\d+\s*초/);
    expect(q(popover!, "composer-working-activity")?.textContent).toBe("활동 보기");
  });

  it("팝오버는 뷰포트 폭에 묶인다(popover-fit): 폰 폭에서 오른쪽이 화면 밖으로 나가지 않는다 (design-review r1 B2)", () => {
    const el = mountView([turn(RUNNING)]);
    const popover = open(el);
    // 공용 PopoverContent의 고정 폭(`w-pane-picker` 384)에 남은 폭 상한이 더해진다. 폭의 계산은 브라우저 시험이 잰다.
    expect(popover?.className).toContain("w-pane-picker");
    expect(popover?.className).toContain("popover-fit");
    // 그 유틸이 tokens.css에서 Radix의 남은 폭 변수를 읽는다(정본 파일을 읽는다, 기대값을 베끼지 않는다).
    const css = readFileSync(resolve(process.cwd(), "src/design/tokens.css"), "utf8");
    expect(css).toMatch(/@utility popover-fit \{\s*max-inline-size: var\(--radix-popover-content-available-width\);/);
  });

  it("에이전트 행을 누르면 그 run의 작업 패널이 열리고 팝오버는 닫힌다", () => {
    const el = mountView([turn(RUNNING)]);
    const popover = open(el);
    act(() => q(popover!, "composer-working-agent")?.click());
    expect(workPanelSnapshot()).toMatchObject({
      runId: RUN_A,
      memberId: A,
      channelId: CH,
      origin: "activity",
      startedAtMs: T,
    });
    expect(q(document.body, "composer-working-popover")).toBeNull();
    // 활동 서랍은 열리지 않는다.
    expect(adeDrawerSnapshot()).toBe(false);
  });

  it("「활동 보기」는 활동 서랍(AdeDrawer)을 연다", () => {
    const el = mountView([turn(RUNNING)]);
    const popover = open(el);
    act(() => q(popover!, "composer-working-activity")?.click());
    expect(adeDrawerSnapshot()).toBe(true);
    expect(workPanelSnapshot()).toBeNull();
    expect(q(document.body, "composer-working-popover")).toBeNull();
  });

  it("run을 특정하지 못한 턴의 행은 눌리지 않는다(눌러도 갈 곳이 없는 단추를 세우지 않는다)", () => {
    const { runId: _dropped, ...withoutRun } = turn(RUNNING);
    const el = mountView([withoutRun]);
    const popover = open(el);
    const row = q(popover!, "composer-working-agent");
    expect(row?.tagName).toBe("DIV");
  });
});

describe("컴포저가 꽂는 레일: 신호 스토어를 읽는다", () => {
  const session = {
    session: { member: { id: ME } },
    workspaceId: WS,
    connStatus: "connected",
  } as unknown as SessionContextValue;

  function mountRail(options: { reserved: boolean }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: session },
            createElement(ComposerActivityRail, {
              channelId: CH,
              directory,
              reserved: options.reserved,
              live: true,
            })
          )
        )
      )
    );
    return host;
  }

  it("에이전트가 없는 채널(예약 없음)에는 턴이 없으면 아무것도 서지 않는다", () => {
    const el = mountRail({ reserved: false });
    expect(el.childElementCount).toBe(0);
  });

  it("예약된 채널에는 턴이 없어도 칸이 선다", () => {
    const el = mountRail({ reserved: true });
    expect(q(el, "composer-working")?.getAttribute("data-state")).toBe("idle");
  });

  it("턴이 열리면 줄이 서고, 끝나면 줄만 사라지고 칸은 남는다", () => {
    const el = mountRail({ reserved: true });
    act(() => markAgentWorking(turn({ ...RUNNING, startedAtMs: Date.now() - 12 * MIN })));
    expect(q(el, "composer-working-text")?.textContent).toBe("달무리봇 · 작업 중 · 설계 문서 읽는 중");
    expect(q(el, "composer-working")?.getAttribute("data-state")).toBe("active");
    act(() => clearAgentWorking(CH, A));
    expect(q(el, "composer-working-text")).toBeNull();
    expect(q(el, "composer-working")?.getAttribute("data-state")).toBe("idle");
  });

  it("에이전트가 없는 채널에서도 턴이 열리면 줄은 선다(드문 경우)", () => {
    const el = mountRail({ reserved: false });
    act(() => markAgentWorking(turn({ ...RUNNING, startedAtMs: Date.now() - MIN })));
    expect(q(el, "composer-working-text")?.textContent).toContain("달무리봇 · 작업 중");
  });

  it("「아직 받지 않았어요」 유예(5분)를 넘은 대기 run은 레일에서 빠진다(예외 줄이 말한다)", () => {
    const el = mountRail({ reserved: true });
    act(() =>
      markAgentWorking(
        turn({
          createdAtMs: Date.now() - UNCOLLECTED_AFTER_MS,
          updatedAtMs: Date.now() - UNCOLLECTED_AFTER_MS,
          queuePosition: 1,
        })
      )
    );
    expect(q(el, "composer-working-text")).toBeNull();
    expect(q(el, "composer-working")?.getAttribute("data-state")).toBe("idle");
  });

  it("유예 안의 대기 run은 「받음」으로 선다", () => {
    const el = mountRail({ reserved: true });
    act(() =>
      markAgentWorking(
        turn({ createdAtMs: Date.now() - 20_000, updatedAtMs: Date.now() - 20_000, queuePosition: 1 })
      )
    );
    expect(q(el, "composer-working-text")?.textContent).toBe("달무리봇 · 받음");
  });
});

describe("레일 칸을 미리 잡는 판정", () => {
  it("이 채널의 활동 중인 에이전트 멤버가 있을 때만 참이다", () => {
    expect(channelHasAgent(directory, CH)).toBe(true);
    expect(channelHasAgent(directory, CH.toUpperCase())).toBe(true);
    expect(channelHasAgent(directory, "00000000-0000-7000-8000-0000000002ff")).toBe(false);
    const human = { ...agent(A, "사람", "human"), kind: "human" } as RosterMember;
    expect(channelHasAgent(makeDirectory([human]), CH)).toBe(false);
    const suspended = { ...agent(A, "정지", "paused"), status: "suspended" } as RosterMember;
    expect(channelHasAgent(makeDirectory([suspended]), CH)).toBe(false);
    expect(channelHasAgent(makeDirectory([]), CH)).toBe(false);
  });

  it("예약은 에이전트가 있는 대화에서만이다(planner 결정 4): 에이전트 DM, 에이전트 멤버가 있는 채널. 사람만 있는 대화는 아니다", () => {
    const bot = agent(A, "달무리봇", "dalmuri-bot");
    const human = { ...agent(B, "박서연", "seoyeon"), kind: "human" } as RosterMember;
    const reserved = (dmAgent: RosterMember | null, members: RosterMember[], channelId = CH) =>
      isRailReserved({ dmAgent, directory: makeDirectory(members), channelId });
    // 에이전트가 있는 대화.
    expect(reserved(null, [bot, human])).toBe(true);
    expect(reserved(bot, [])).toBe(true);
    expect(reserved(bot, [human])).toBe(true);
    // 사람만 있는 대화(DM이든 채널이든): 칸이 없다.
    expect(reserved(null, [human])).toBe(false);
    expect(reserved(null, [])).toBe(false);
    // 다른 채널의 에이전트·활동 중이 아닌 에이전트는 이 대화의 에이전트가 아니다.
    expect(reserved(null, [bot], "00000000-0000-7000-8000-0000000002ff")).toBe(false);
    expect(reserved(null, [{ ...bot, status: "suspended" } as RosterMember, human])).toBe(false);
  });
});
