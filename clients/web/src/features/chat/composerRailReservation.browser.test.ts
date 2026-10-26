// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunProgress, Channel, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 레일 높이 예약은 **에이전트가 있는 대화에서만** 선다 (#4619 planner 결정 4). 진짜 `Composer`가 그린 마크업을 실제
// 엔진에 올려 「마지막 행의 바닥 ~ 입력창 카드 위」 간격을 잰다:
//
//   에이전트 대화(에이전트 DM·에이전트 멤버가 있는 채널): 레일이 서고 지고 단계가 바뀌어도 **간격 그대로**(이동 0): 칸 24px(폰 폭은 독 경계선 1px 더)
//   사람만 있는 대화: 레일도 칸도 없고 간격은 #1749대로 **폼의 윗 여백 그대로, 불변**(죽은 띠가 없다): 600px 이상의 창은 8px,
//     폰 폭(<600)은 13px(폼 `p-3` 12 + 독의 위 경계선 1)이다. 값은 `tokens.css`의 `composer-dock > form`(8·24·18)이 정하고,
//     시험은 간격이 「폼 윗 여백 + 독 경계선」과 같은지(그 밖에 띠가 없는지)를 잰다.
//   에이전트가 들어오고 나갈 때 예약이 바뀌는 것은 허용한다(대화가 바뀌는 시점이라 흔들림이 아니다) — 시험이 그 전이를 못 박는다.
//
// jsdom은 레이아웃을 못 재므로 컴포저를 jsdom에서 한 번씩 그려 마크업(`outerHTML`)을 얻고, `tokens.css`를 Tailwind로 컴파일한 CSS와
// 함께 엔진에 올린다. 사보타주: 예약 조건을 항상 참/거짓으로 바꾸면 이 시험이 붉다.
// =============================================================================

const scheduledApi = vi.hoisted(() => ({
  listAllScheduledMessages: vi.fn(),
  createScheduledMessage: vi.fn(),
  updateScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
  deleteScheduledMessage: vi.fn(),
}));
vi.mock("@momo/core/features/scheduled/api", () => scheduledApi);

const api = vi.hoisted(() => ({
  listChannels: vi.fn(),
  fetchRoster: vi.fn(),
  fetchWorkHosts: vi.fn(),
  fetchAgentLiveness: vi.fn(),
  fetchApprovals: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { markAgentWorking, resetAgentWorking } from "@/features/agents/agentWorkingSignal";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft } from "@/features/chat/draftStore";
import { Composer } from "./Composer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEOYEON = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const MIN = 60_000;

const CHANNELS: Channel[] = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel];
const member = (id: string, kind: "human" | "agent", name: string): RosterMember =>
  ({
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle: name,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  }) as unknown as RosterMember;
const HUMANS = [member(ME, "human", "정하윤"), member(SEOYEON, "human", "박서연")];
const BOT = member(AGENT, "agent", "달무리봇");

const LONG_STAGE =
  "분기 회고 문서의 세 번째 절에 들어갈 표를 정리하면서 지난 분기와 이번 분기의 지표를 한꺼번에 맞춰 보는 중이라 이 줄은 한 줄에 다 들어가지 못해요";

function turn(extra: Partial<AgentRunProgress> = {}) {
  const now = Date.now();
  const signal = signalFromProgress({
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 0,
    ahead: [],
    startedAtMs: now - 3 * MIN,
    latestStage: "설계 문서 읽는 중",
    createdAtMs: now - 3 * MIN,
    updatedAtMs: now - 3 * MIN,
    ...extra,
  });
  if (signal === null) throw new Error("signal");
  return signal;
}

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  api.fetchWorkHosts.mockResolvedValue([]);
  api.fetchApprovals.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  resetSchedulerDisabledForTest();
  clearDraft(WS, CH);
  resetAgentWorking();
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  resetAgentWorking();
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 컴포저를 한 번 그려 마크업을 얻는다. `activeTurn`이면 레일에 열린 턴을 올린 상태다. */
async function composerHtml(options: {
  members: RosterMember[];
  dmAgent?: RosterMember | null;
  activeTurn?: Partial<AgentRunProgress> | null;
}): Promise<string> {
  resetAgentWorking();
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [`/c/${CH}`] },
          createElement(
            OpenAgentProfileContext.Provider,
            { value: () => undefined },
            createElement(
              SessionProvider,
              { value: session() },
              createElement(Composer, {
                workspaceId: WS,
                channelId: CH,
                directory: makeDirectory(options.members),
                channels: CHANNELS,
                channelLabel: "일반",
                recipient: "place",
                dmAgent: options.dmAgent ?? null,
                quote: null,
                onCancelQuote: () => undefined,
                onSend: () => undefined,
              })
            )
          )
        )
      )
    );
  });
  await settle();
  if (options.activeTurn !== undefined && options.activeTurn !== null) {
    act(() => markAgentWorking(turn(options.activeTurn ?? {})));
    await settle();
  }
  const html = host.innerHTML;
  act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host.remove();
  host = null;
  return html;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, composer: string, width: number): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#chat { display: flex; flex-direction: column; height: 720px; width: ${width}px; box-sizing: border-box; }
#list { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; }
#row-last { height: 48px; flex: none; }
</style></head><body class="bg-surface text-ink">
<div id="chat"><div id="list"><div id="row-prev" style="height:48px;flex:none">이전 행</div><div id="row-last">마지막 행</div></div><div id="composer-slot">${composer}</div></div>
</body></html>`;
}

interface Gap {
  rowLastTop: number;
  rowLastBottom: number;
  cardTop: number;
  /** 마지막 행 바닥과 입력창 카드 위 사이. */
  gap: number;
  hasRail: boolean;
  /** 폼이 스스로 갖는 윗 여백(계산된 값). */
  formPaddingTop: number;
  /** 폰 폭에서 컴포저 독이 위에 긋는 경계선 두께(넓은 창에서는 0). */
  dockBorderTop: number;
}

async function measure(p: import("playwright").Page): Promise<Gap> {
  return p.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const last = document.getElementById("row-last")!;
    const card = document.querySelector<HTMLElement>('[data-testid="composer-frame"]')!;
    return {
      rowLastTop: rect(last).top,
      rowLastBottom: rect(last).bottom,
      cardTop: rect(card).top,
      gap: rect(card).top - rect(last).bottom,
      hasRail: document.querySelector('[data-testid="composer-working"]') !== null,
      formPaddingTop: Number.parseFloat(getComputedStyle(card.closest("form")!).paddingTop),
      dockBorderTop: Number.parseFloat(getComputedStyle(card.closest("[data-composer-shell]")!).borderTopWidth),
    };
  });
}

describe("레일 높이 예약은 에이전트가 있는 대화에서만 (#4619 planner 결정 4)", () => {
  it.skipIf(ENGINES.length === 0)(
    "에이전트 대화는 레일이 서고 지고 바뀌어도 이동 0(간격 24), 사람만 있는 대화는 폼 윗 여백(8·폰 12) 불변, 에이전트가 들고 나면 그 사이를 오간다",
    async () => {
      const agentChannel = [...HUMANS, BOT];
      const scenes = {
        "에이전트 채널: 비어 있음": await composerHtml({ members: agentChannel }),
        "에이전트 채널: 1명 작업 중": await composerHtml({ members: agentChannel, activeTurn: {} }),
        "에이전트 채널: 아주 긴 단계": await composerHtml({ members: agentChannel, activeTurn: { latestStage: LONG_STAGE } }),
        "에이전트 채널: 단계 없음": await composerHtml({ members: agentChannel, activeTurn: { latestStage: undefined } }),
        "에이전트 채널: 승인 대기": await composerHtml({
          members: agentChannel,
          activeTurn: { phase: "awaiting_approval", status: "awaiting_approval" },
        }),
        "에이전트 DM: 비어 있음": await composerHtml({ members: [], dmAgent: BOT }),
        "에이전트 DM: 작업 중": await composerHtml({ members: [], dmAgent: BOT, activeTurn: {} }),
        "사람만: 비어 있음": await composerHtml({ members: HUMANS }),
        "사람만(다시 그림)": await composerHtml({ members: HUMANS }),
      } as const;
      const css = await compileTokensCss(Object.values(scenes).flatMap(classesOf));
      const playwright = await import("playwright");
      const problems: string[] = [];

      // 600px 이상(데스크탑·웹)과 폰 폭: 사람만 있는 대화의 간격이 8 / 13(폼 윗 여백 12 + 독의 위 경계선 1)으로 다르다.
      // 그 값을 시험이 따로 못 박는다.
      const VIEWPORTS = [
        { width: 900, humanGap: 8 },
        { width: 500, humanGap: 13 },
      ];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            for (const vp of VIEWPORTS) {
              const ctx = await browser.newContext({ viewport: { width: vp.width, height: 800 }, colorScheme });
              try {
                const p = await ctx.newPage();
                const at = (name: string) => `${engine} ${colorScheme} ${vp.width} 「${name}」`;
                const gaps = new Map<string, Gap>();
                for (const [name, html] of Object.entries(scenes)) {
                  await p.setContent(page(css, html, vp.width));
                  gaps.set(name, await measure(p));
                }
                const agentBase = gaps.get("에이전트 채널: 비어 있음")!;
                const humanBase = gaps.get("사람만: 비어 있음")!;
                // 에이전트 대화: 간격 24(칸 24 + 폼 윗 여백 0) + 독의 위 경계선(폰 폭 1), 모든 장면이 비어 있을 때와 같은 자리다(이동 0).
                const agentGap = 24 + agentBase.dockBorderTop;
                if (Math.abs(agentBase.gap - agentGap) > 0.51) problems.push(`${at("에이전트 채널: 비어 있음")}: 간격 ${agentBase.gap}, 기대 ${agentGap}`);
                for (const [name, g] of gaps) {
                  if (!name.startsWith("에이전트")) continue;
                  if (!g.hasRail) problems.push(`${at(name)}: 레일 칸이 없다`);
                  if (Math.abs(g.gap - agentBase.gap) > 0.01) problems.push(`${at(name)}: 간격 ${g.gap}, 비어 있을 때 ${agentBase.gap}`);
                  if (Math.abs(g.rowLastBottom - agentBase.rowLastBottom) > 0.01 || Math.abs(g.cardTop - agentBase.cardTop) > 0.01) {
                    problems.push(`${at(name)}: 마지막 행·입력창 카드가 움직였다`);
                  }
                }
                // 사람만 있는 대화: 칸이 없고 간격은 폼의 윗 여백 그대로다(#1749). 다시 그려도 같다.
                for (const name of ["사람만: 비어 있음", "사람만(다시 그림)"]) {
                  const g = gaps.get(name)!;
                  if (g.hasRail) problems.push(`${at(name)}: 사람만 있는 대화에 레일 칸이 있다(죽은 띠)`);
                  if (Math.abs(g.gap - vp.humanGap) > 0.51) problems.push(`${at(name)}: 간격 ${g.gap}, 기대 ${vp.humanGap}(폼의 윗 여백, #1749)`);
                  if (Math.abs(g.gap - (g.formPaddingTop + g.dockBorderTop)) > 0.01) {
                    problems.push(`${at(name)}: 간격 ${g.gap}이 폼 윗 여백 ${g.formPaddingTop} + 독 경계선 ${g.dockBorderTop}과 다르다 — 그 밖에 띠가 있다`);
                  }
                }
                // 에이전트가 들고 나면 예약이 바뀐다(허용): 사람 대화의 간격 ↔ 24.
                const delta = 24 - (vp.humanGap - humanBase.dockBorderTop);
                if (Math.abs(agentBase.gap - humanBase.gap - delta) > 0.51) {
                  problems.push(`${at("전이")}: 에이전트 대화(${agentBase.gap})와 사람 대화(${humanBase.gap})의 간격 차이가 ${delta}이 아니다`);
                }
              } finally {
                await ctx.close();
              }
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    240_000
  );
});
