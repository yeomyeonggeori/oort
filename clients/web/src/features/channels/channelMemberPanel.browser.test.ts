// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type AgentRunProgress, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";

// =============================================================================
// 채널 멤버 패널: **줄 높이는 상태와 무관하게 같고, 열려 있는 동안 줄이 밀리지 않는다** (#5686).
//
// 진짜 `ChannelMemberPanel`을 jsdom에서 열어 둔 채로 사실을 바꿔 가며 마크업을 세 번 얻는다(같은 마운트라 묶음은
// 얼어 있다):
//
//   처음      달무리봇 작업 중(단계) · 새벽봇 요청 한 줄 · 별빛봇 생존 낱말 · 박서연 상태 글 · 이준호 자리 비움 · 최유나 오프라인
//   바뀐 뒤   달무리봇 run 끝남(생존 낱말) · 새벽봇 단계가 생김 + run 하나 더(+1) · 박서연 상태 글 지움 · 이준호 방해 금지 ·
//             최유나 온라인이 됨(묶음은 그대로) · 별빛봇 생존을 모름(둘째 줄 빔)
//   아주 김   모든 글이 칸보다 긴 글
//
// 세 마크업을 `tokens.css`를 Tailwind로 컴파일한 CSS와 함께 실제 엔진에 올리고, 줄마다 목록 위에서의 y와 높이를 잰다.
// 기대: 줄 높이가 모두 같고, 세 장면에서 모든 줄의 y가 같다(이동 0). 넓은 창·좁은 폭(360)·큰 글자(뿌리 글자 200%)에서.
// =============================================================================

const api = vi.hoisted(() => ({
  fetchAllActiveAgentRuns: vi.fn(),
  fetchAgentLiveness: vi.fn(),
  fetchRoster: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { ChannelMemberPanel } from "./ChannelContextControls";
import { activeAgentRunsQueryKey } from "./useChannelMemberNow";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";
const SEOYEON = "00000000-0000-7000-8000-000000000102";
const JUNHO = "00000000-0000-7000-8000-000000000103";
const YUNA = "00000000-0000-7000-8000-000000000104";
const DALMURI = "00000000-0000-7000-8000-000000000301";
const SAEBYEOK = "00000000-0000-7000-8000-000000000302";
const BYEOLBIT = "00000000-0000-7000-8000-000000000303";
const MIN = 60_000;
const LONG =
  "분기 회고 문서의 세 번째 절에 들어갈 표를 정리하면서 지난 분기와 이번 분기의 지표를 한꺼번에 맞춰 보는 중이라 한 줄에 다 들어가지 못해요";

function member(id: string, kind: "human" | "agent", name: string, handle: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    ...over,
  } as RosterMember;
}

const FIRST: RosterMember[] = [
  member(ME, "human", "김도현", "dohyun", { role: "owner", online: true }),
  member(SEOYEON, "human", "박서연", "seoyeon", { online: true, statusEmoji: "📅", statusText: "회의 중" }),
  member(JUNHO, "human", "이준호", "junho", { online: true, presenceStatus: "away" }),
  member(YUNA, "human", "최유나", "yuna", { online: false }),
  member(DALMURI, "agent", "달무리봇", "dalmuri"),
  member(SAEBYEOK, "agent", "새벽봇", "saebyeok"),
  member(BYEOLBIT, "agent", "별빛봇", "byeolbit"),
];
const CHANGED: RosterMember[] = FIRST.map((m) =>
  m.id === SEOYEON
    ? { ...m, statusEmoji: undefined, statusText: undefined }
    : m.id === JUNHO
      ? { ...m, presenceStatus: "dnd" }
      : m.id === YUNA
        ? { ...m, online: true }
        : m
);
const LONGEST: RosterMember[] = FIRST.map((m) =>
  m.id === SEOYEON
    ? { ...m, displayName: `박서연 ${LONG}`, statusText: LONG }
    : m.id === DALMURI
      ? { ...m, displayName: `달무리봇 ${LONG}`, handle: `dalmuri-${"x".repeat(80)}` }
      : m
);

let seq = 0;
function run(over: Partial<AgentRunProgress> = {}): AgentRunProgress {
  seq += 1;
  const now = Date.now();
  return {
    id: `0199aa11-2222-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    agentMemberId: DALMURI,
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 1,
    ahead: [],
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    triggerSummary: "@달무리봇 분기 회고 정리해 줘",
    startedAtMs: now - 4 * MIN - 10_000,
    latestStage: "설계 문서 읽는 중",
    createdAtMs: now - 5 * MIN,
    updatedAtMs: now - MIN,
    ...over,
  };
}
const hermes = (over: Partial<AgentRunProgress> = {}) =>
  run({
    agentMemberId: SAEBYEOK,
    latestStage: undefined,
    triggerMessageId: undefined,
    triggerSummary: "배포 준비 체크리스트",
    startedAtMs: Date.now() - 2 * MIN - 5_000,
    ...over,
  });

let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyun" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

/** 패널을 열어 둔 채 사실을 바꿔 가며 세 장면의 마크업을 얻는다. */
async function scenes(): Promise<Record<"처음" | "바뀐 뒤" | "아주 김", string>> {
  api.fetchRoster.mockResolvedValue(FIRST);
  api.fetchAllActiveAgentRuns.mockResolvedValue({ runs: [run(), hermes()], truncated: false, pages: 1 });
  let byeolbitKnown = true;
  api.fetchAgentLiveness.mockImplementation(async (_ws: string, agentId: string) => {
    const id = agentId.toLowerCase();
    if (id === SAEBYEOK || (id === BYEOLBIT && !byeolbitKnown)) throw new ApiError(404, "not hosted");
    return { agentMemberId: agentId, state: "alive_idle", lastSignalAtMs: Date.now() - 2 * MIN };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (members: RosterMember[]) => {
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            LocaleProvider,
            { locale: korean, children: 
            createElement(
              SessionProvider,
              { value: session() },
              createElement(ChannelMemberPanel, {
                channelId: CH,
                channelName: "design-lab",
                members,
                status: "ready",
                offline: false,
                onRetry: () => undefined,
                onAddMember: () => undefined,
              })
            ) }
          )
        )
      );
    });
    await settle();
  };
  const panelHtml = () => document.querySelector<HTMLElement>('[data-testid="channel-member-panel"]')!.outerHTML;

  await render(FIRST);
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-testid="channel-member-count"]')!.click();
  });
  await settle();
  const first = panelHtml();

  // 바뀐 뒤: 달무리봇 끝, 새벽봇 단계 + run 하나 더, 별빛봇 생존 모름, 사람 셋의 사실이 바뀜
  byeolbitKnown = false;
  await act(async () => {
    client.setQueryData(activeAgentRunsQueryKey(WS), {
      runs: [hermes({ latestStage: "체크리스트 3번 확인 중" }), hermes({ createdAtMs: Date.now() - 9 * MIN })],
    });
    await client.invalidateQueries({ queryKey: ["agent-liveness"] });
  });
  await render(CHANGED);
  const changed = panelHtml();

  await act(async () => {
    client.setQueryData(activeAgentRunsQueryKey(WS), {
      runs: [
        run({ latestStage: LONG }),
        run({ createdAtMs: Date.now() - 30 * MIN }),
        run({ createdAtMs: Date.now() - 40 * MIN }),
        hermes({ triggerSummary: LONG, startedAtMs: Date.now() - 26 * 60 * MIN }),
      ],
    });
  });
  await render(LONGEST);
  const longest = panelHtml();
  return { 처음: first, "바뀐 뒤": changed, "아주 김": longest };
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, panel: string, rootFontPx: number): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html { font-size: ${rootFontPx}px; }
html, body { margin: 0; }
/* 다이얼로그의 여는 움직임(확대 95% → 100%)이 잰 값에 섞이지 않게 멈춘다: 재는 것은 끝난 자리다. */
*, *::before, *::after { animation: none !important; transition: none !important; }
</style></head><body class="bg-surface text-ink">${panel}</body></html>`;
}

interface Row {
  id: string;
  group: string;
  top: number;
  height: number;
  /** 둘째 줄의 높이(넘친 글이 아래로 흐르거나 대체 글꼴이 줄을 키우지 않는가). */
  lineHeight: number;
}

async function measure(p: import("playwright").Page): Promise<Row[]> {
  return p.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="channel-member-list"]')!;
    const base = list.getBoundingClientRect().top - list.scrollTop;
    return [...list.querySelectorAll<HTMLElement>('[data-testid="channel-member-item"]')].map((row) => {
      const rect = row.getBoundingClientRect();
      const now = row.querySelector<HTMLElement>('[data-testid="channel-member-now"]')!;
      // 묶음의 마지막 줄은 아래 구분선이 없다(`last:border-b-0`): 줄 높이는 구분선을 뺀 칸으로 잰다.
      const border = Number.parseFloat(getComputedStyle(row).borderBottomWidth) || 0;
      return {
        id: row.dataset.memberId ?? "",
        group: row.dataset.memberGroup ?? "",
        top: Math.round((rect.top - base) * 100) / 100,
        height: Math.round((rect.height - border) * 100) / 100,
        lineHeight: Math.round(now.getBoundingClientRect().height * 100) / 100,
      };
    });
  });
}

describe("채널 멤버 패널의 줄은 상태가 바뀌어도 밀리지 않는다 (#5686)", () => {
  it.skipIf(ENGINES.length === 0)(
    "줄 높이는 모두 같고, 열려 있는 동안 run이 끝나고·단계가 생기고·상태 글이 지워지고·접속이 바뀌어도 모든 줄의 y가 같다(넓은 창·360·큰 글자)",
    async () => {
      const shots = await scenes();
      const css = await compileTokensCss(Object.values(shots).flatMap(classesOf));
      const playwright = await import("playwright");
      const problems: string[] = [];
      const report: string[] = [];
      const VIEWPORTS = [
        { name: "넓은 창", width: 1280, rootFontPx: 16 },
        { name: "좁은 폭 360", width: 360, rootFontPx: 16 },
        { name: "큰 글자(뿌리 32px = 200%)", width: 1280, rootFontPx: 32 },
      ];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            for (const vp of VIEWPORTS) {
              const ctx = await browser.newContext({ viewport: { width: vp.width, height: 2400 }, colorScheme });
              try {
                const p = await ctx.newPage();
                const at = (scene: string) => `${engine} ${colorScheme} ${vp.name} 「${scene}」`;
                const measured = new Map<string, Row[]>();
                for (const [scene, html] of Object.entries(shots)) {
                  await p.setContent(page(css, html, vp.rootFontPx));
                  measured.set(scene, await measure(p));
                }
                const base = measured.get("처음")!;
                if (base.length !== 7) problems.push(`${at("처음")}: 줄 ${base.length}개`);
                const heights = new Set(base.map((row) => row.height));
                if (heights.size !== 1) problems.push(`${at("처음")}: 줄 높이가 여럿 ${[...heights].join(",")}`);
                for (const [scene, rows] of measured) {
                  for (const row of rows) {
                    const was = base.find((b) => b.id === row.id);
                    if (was === undefined) {
                      problems.push(`${at(scene)}: ${row.id} 줄이 처음에 없었다`);
                      continue;
                    }
                    if (row.group !== was.group) problems.push(`${at(scene)}: ${row.id} 묶음 ${was.group} → ${row.group}`);
                    if (Math.abs(row.top - was.top) > 0.01) problems.push(`${at(scene)}: ${row.id} y ${was.top} → ${row.top}`);
                    if (Math.abs(row.height - was.height) > 0.01) problems.push(`${at(scene)}: ${row.id} 높이 ${was.height} → ${row.height}`);
                    if (Math.abs(row.lineHeight - was.lineHeight) > 0.01) {
                      problems.push(`${at(scene)}: ${row.id} 둘째 줄 높이 ${was.lineHeight} → ${row.lineHeight}`);
                    }
                  }
                }
                report.push(
                  `${engine} ${colorScheme} ${vp.name}: 줄 높이 ${[...heights].join(",")}px, 둘째 줄 ${[...new Set(base.map((r) => r.lineHeight))].join(",")}px, 장면 ${measured.size}개 × 줄 ${base.length}개`
                );
              } finally {
                await ctx.close();
              }
            }
          }
        } finally {
          await browser.close();
        }
      }
      console.info(`[#5686 줄 높이]\n${report.join("\n")}`);
      if (problems.length > 0) console.info(`[#5686 문제 ${problems.length}건, 앞 30건]\n${problems.slice(0, 30).join("\n")}`);
      expect(problems).toEqual([]);
    },
    240_000
  );
});
