// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type AgentRunProgress, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { createAppLocale } from "@/i18n/localeStore";
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
const catalog = (locale: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), `../../packages/momo-core/src/i18n/catalogs/${locale}/timeline.json`), "utf8")) as Record<string, string>;
const CATALOG = { ko: catalog("ko-KR"), en: catalog("en-US") };
let korean: AppLocale;
let english: AppLocale;

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
  english = await createAppLocale(
    {
      readPreference: () => "en-US",
      writePreference: () => {},
      readDevice: () => ({ languages: ["en-US"], timeZone: "UTC" }),
    },
    { applyLang: () => {} }
  );
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

// ---- 열 때: 첫 프레임부터 닫힐 때까지 패널이 뛰지 않는다 (#5686 수리 1회차, 검수 H1) ---------------------------------
// 패널은 「지금」 읽기를 기다리지 않는다: 명부의 줄이 첫 프레임부터 서고, 읽기가 돌아오면 에이전트 줄의 둘째 줄만 채운다.
// 멤버 12명(에이전트 5)으로 읽기를 300ms·1500ms 늦춰 열고, 연 직후·기다리는 중·답이 온 뒤의 마크업을 실제 엔진에 올려
// 패널 높이와 발치 단추(「멤버 추가」「닫기」)의 자리를 잰다. 기대: 모든 순간 같은 값.

const EXTRA: RosterMember[] = [
  member("00000000-0000-7000-8000-000000000105", "human", "정하윤", "hayun", { online: true }),
  member("00000000-0000-7000-8000-000000000106", "human", "한지우", "jiwoo", { online: false }),
  member("00000000-0000-7000-8000-000000000107", "human", "오세린", "serin", { online: true }),
  member("00000000-0000-7000-8000-000000000304", "agent", "노을봇", "noeul"),
  member("00000000-0000-7000-8000-000000000305", "agent", "은하봇", "eunha"),
];
const TWELVE: RosterMember[] = [...FIRST, ...EXTRA];

/** 읽기를 `delayMs` 늦춘 채 패널을 열고, 연 직후부터 답이 온 뒤까지의 마크업을 차례로 모은다. */
async function openingFrames(
  delayMs: number,
  options: { fail?: boolean; members?: RosterMember[]; english?: boolean } = {}
): Promise<{ at: string; html: string }[]> {
  const members = options.members ?? TWELVE;
  api.fetchRoster.mockResolvedValue(members);
  api.fetchAllActiveAgentRuns.mockImplementation(
    () =>
      new Promise((resolve, reject) =>
        setTimeout(
          () =>
            options.fail === true
              ? reject(new ApiError(503, "unavailable"))
              : resolve({ runs: [run(), hermes()], truncated: false, pages: 1 }),
          delayMs
        )
      )
  );
  api.fetchAgentLiveness.mockImplementation(async (_ws: string, agentId: string) => {
    if (agentId.toLowerCase() === SAEBYEOK) throw new ApiError(404, "not hosted");
    return { agentMemberId: agentId, state: "alive_idle", lastSignalAtMs: Date.now() - 2 * MIN };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(LocaleProvider, {
          locale: options.english === true ? english : korean,
          children: createElement(
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
          ),
        })
      )
    );
  });
  await settle();
  const frames: { at: string; html: string }[] = [];
  const grab = (at: string) =>
    frames.push({ at, html: document.querySelector<HTMLElement>('[data-testid="channel-member-panel"]')!.outerHTML });
  const start = Date.now();
  // 연 직후(첫 커밋): 기다리는 일 없이 바로 잰다
  act(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="channel-member-count"]')!.click();
  });
  grab("연 직후");
  // 실패는 5xx라 한 번 더 묻고(1초 뒤) 서므로 그 뒤까지 본다
  while (Date.now() - start < delayMs + (options.fail === true ? 1_600 : 400)) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    grab(`${Math.round((Date.now() - start) / 100) * 100}ms`);
  }
  await settle();
  grab("답이 온 뒤");
  act(() => root?.unmount());
  root = null;
  host.remove();
  host = null;
  return frames;
}

describe("채널 멤버 패널을 열 때 뛰지 않는다 (#5686 수리 1회차)", () => {
  it.skipIf(ENGINES.length === 0)(
    "멤버 12명, 「지금」 읽기 300ms·1500ms: 연 직후부터 답이 온 뒤까지 패널 높이와 발치 단추 자리가 한 번도 안 바뀐다(두 엔진)",
    async () => {
      const runs: Record<string, { at: string; html: string }[]> = {
        "300ms": await openingFrames(300),
        "1500ms": await openingFrames(1500),
      };
      for (const [delay, frames] of Object.entries(runs)) {
        const first = frames[0]!.html;
        const last = frames[frames.length - 1]!.html;
        // 시험이 헛돌지 않게: 연 직후에도 줄 12개가 서 있고, 답이 온 뒤에는 일하는 줄이 채워져 있다.
        expect((first.match(/data-testid="channel-member-item"/g) ?? []).length, `${delay} 연 직후 줄 수`).toBe(12);
        expect(first.includes('data-testid="skeleton-row"'), `${delay} 연 직후 막대`).toBe(false);
        expect(first.includes('data-now="run"'), `${delay} 연 직후에는 아직 답이 없다`).toBe(false);
        expect(last.includes('data-now="run"'), `${delay} 답이 온 뒤 채워진 줄`).toBe(true);
      }
      const css = await compileTokensCss(Object.values(runs).flat().flatMap((frame) => classesOf(frame.html)));
      const playwright = await import("playwright");
      const problems: string[] = [];
      const report: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
          try {
            const p = await ctx.newPage();
            for (const [delay, frames] of Object.entries(runs)) {
              const seen: { at: string; height: number; add: number; close: number }[] = [];
              for (const frame of frames) {
                await p.setContent(page(css, frame.html, 16));
                seen.push({
                  at: frame.at,
                  ...(await p.evaluate(() => {
                    const top = (id: string) =>
                      Math.round(document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top * 100) / 100;
                    return {
                      height:
                        Math.round(
                          document.querySelector('[data-testid="channel-member-panel"]')!.getBoundingClientRect().height * 100
                        ) / 100,
                      add: top("channel-member-add"),
                      close: top("channel-member-close"),
                    };
                  })),
                });
              }
              const base = seen[0]!;
              for (const s of seen) {
                if (s.height !== base.height || s.add !== base.add || s.close !== base.close) {
                  problems.push(
                    `${engine} ${delay} 「${s.at}」: 높이 ${base.height} → ${s.height}, 멤버 추가 y ${base.add} → ${s.add}, 닫기 y ${base.close} → ${s.close}`
                  );
                }
              }
              report.push(`${engine} ${delay}: ${seen.length}순간, 높이 ${base.height}px, 멤버 추가 y ${base.add}, 닫기 y ${base.close}`);
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      console.info(`[#5686 열 때]\n${report.join("\n")}`);
      if (problems.length > 0) console.info(`[#5686 열 때 문제 ${problems.length}건]\n${problems.slice(0, 20).join("\n")}`);
      expect(problems).toEqual([]);
    },
    240_000
  );
});

// ---- 360 폭에서 「지금」 읽기가 실패해도 패널 안 줄이 움직이지 않는다 (#5701) ---------------------------------------
// #5686 재검수: 360 폭에서 실패 줄이 서면 발치가 두 줄이 되어 패널이 36px 커졌다. 멤버 3명(작은 패널)과 12명(최대 높이)을
// 넓은 창·360 폭 × 읽기 성공·실패로 열어, 모든 순간의 패널 높이·목록 높이·발치 단추 자리·줄 자리가 한 값이고 실패 줄이
// 실제로 섰는지(시험이 헛돌지 않게)를 잰다.
describe("채널 멤버 패널: 읽기가 실패해도 좁은 폭에서 안 움직인다 (#5701)", () => {
  it.skipIf(ENGINES.length === 0)(
    "멤버 3명·12명 × 넓은 창·512·360 × 글자 기본·150%·200% × 읽기 성공·실패: 모든 순간 같은 값이고, 실패 글은 보이고 한 줄이며, 발치 단추 상자가 겹치지 않는다",
    async () => {
      const THREE = FIRST.filter((m) => [ME, DALMURI, SAEBYEOK].includes(m.id));
      const scenes: Record<string, { at: string; html: string }[]> = {};
      for (const [name, members] of [["3명", THREE], ["12명", TWELVE]] as const) {
        scenes[`${name} 성공`] = await openingFrames(300, { members });
        scenes[`${name} 실패`] = await openingFrames(300, { members, fail: true });
      }
      scenes["영어 3명 실패"] = await openingFrames(300, { members: THREE, fail: true, english: true });
      for (const [name, frames] of Object.entries(scenes)) {
        const last = frames[frames.length - 1]!.html;
        expect(last.includes('data-testid="channel-member-now-failed"'), `${name}: 실패 줄`).toBe(name.endsWith("실패"));
      }
      const css = await compileTokensCss(Object.values(scenes).flat().flatMap((frame) => classesOf(frame.html)));
      const playwright = await import("playwright");
      const problems: string[] = [];
      const report: string[] = [];
      const VIEWPORTS = [
        { name: "1280", width: 1280 },
        { name: "512", width: 512 },
        { name: "360", width: 360 },
        { name: "320", width: 320 },
      ];
      const FONTS = [
        { name: "기본", px: 16 },
        { name: "150%", px: 24 },
        { name: "200%", px: 32 },
      ];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const vp of VIEWPORTS) {
            for (const font of FONTS) {
              const ctx = await browser.newContext({ viewport: { width: vp.width, height: 2400 } });
              try {
                const p = await ctx.newPage();
                for (const [name, frames] of Object.entries(scenes)) {
                  const at = `${engine} ${vp.name} ${font.name} ${name}`;
                  const seen: string[] = [];
                  let last = "";
                  for (const frame of frames) {
                    // 같은 마크업은 같은 값이라 다시 재지 않는다
                    if (frame.html === last) {
                      seen.push(seen[seen.length - 1]!);
                      continue;
                    }
                    last = frame.html;
                    await p.setContent(page(css, frame.html, font.px));
                    seen.push(
                      await p.evaluate(() => {
                        const box = (sel: string) => {
                          const r = document.querySelector(sel)!.getBoundingClientRect();
                          return `${Math.round(r.top * 100) / 100}+${Math.round(r.height * 100) / 100}`;
                        };
                        const list = document.querySelector<HTMLElement>('[data-testid="channel-member-list"]')!;
                        const base = list.getBoundingClientRect().top - list.scrollTop;
                        const rows = [...list.querySelectorAll<HTMLElement>('[data-testid="channel-member-item"]')]
                          .map((row) => Math.round((row.getBoundingClientRect().top - base) * 100) / 100)
                          .join(",");
                        return [
                          `panel ${box('[data-testid="channel-member-panel"]')}`,
                          `list ${box('[data-testid="channel-member-list"]')}`,
                          `add ${box('[data-testid="channel-member-add"]')}`,
                          `close ${box('[data-testid="channel-member-close"]')}`,
                          `rows ${rows}`,
                        ].join(" | ");
                      })
                    );
                  }
                  const distinct = [...new Set(seen)];
                  report.push(`${at}: ${seen.length}순간 → ${distinct[0]}`);
                  if (distinct.length !== 1) problems.push(`${at}: 서로 다른 값 ${distinct.length}개\n  ${distinct.join("\n  ")}`);
                  // 마지막 마크업(실패가 선 뒤): 글이 눈에 보이고 한 줄이며, 발치 단추 상자가 서로·패널 밖으로 겹치지 않는다
                  if (name.endsWith("실패")) {
                    const foot = await p.evaluate(() => {
                      const rect = (sel: string) => {
                        const r = document.querySelector(sel)!.getBoundingClientRect();
                        return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height };
                      };
                      const failed = document.querySelector('[data-testid="channel-member-now-failed"]')!;
                      // 까닭 글 요소 자체(단추 안 라벨은 아니다): 보이는 것이 정확히 하나여야 한다
                      const reasons = [...failed.querySelectorAll<HTMLElement>('[data-testid="channel-member-now-failed-reason"]')];
                      const shown = reasons.filter((el) => getComputedStyle(el).display !== "none");
                      const text = shown[0] ?? reasons[0]!;
                      const style = getComputedStyle(text);
                      return {
                        textWidth: text.getBoundingClientRect().width,
                        textFull: text.scrollWidth,
                        textClient: text.clientWidth,
                        reasonCount: reasons.length,
                        shownCount: shown.length,
                        shownText: shown[0]?.textContent ?? "",
                        textHeight: text.getBoundingClientRect().height,
                        lineHeight: Number.parseFloat(style.lineHeight),
                        whiteSpace: style.whiteSpace,
                        retry: rect('[data-testid="channel-member-now-retry"]'),
                        add: rect('[data-testid="channel-member-add"]'),
                        close: rect('[data-testid="channel-member-close"]'),
                        panel: rect('[data-testid="channel-member-panel"]'),
                      };
                    });
                    const overlap = (a: { l: number; r: number }, b: { l: number; r: number }) => Math.min(a.r, b.r) - Math.max(a.l, b.l);
                    if (overlap(foot.retry, foot.add) > 0.5) problems.push(`${at}: 「다시 불러오기」와 「멤버 추가」 상자가 ${overlap(foot.retry, foot.add)}px 겹침`);
                    if (overlap(foot.add, foot.close) > 0.5) problems.push(`${at}: 「멤버 추가」와 「닫기」 상자가 겹침`);
                    if (foot.close.r > foot.panel.r + 0.5) problems.push(`${at}: 「닫기」가 패널 밖으로 넘침`);
                    if (foot.textHeight > foot.lineHeight * 1.5) problems.push(`${at}: 실패 글이 줄바꿈됨(높이 ${foot.textHeight})`);
                    if (foot.whiteSpace !== "nowrap") problems.push(`${at}: 실패 글 white-space ${foot.whiteSpace}`);
                    // 까닭 글 요소 자체를 잰다: 보이는 것이 정확히 하나이고, 글자가 사전의 짧은 글(640 미만)/긴 글(640 이상)이며,
                    // 기본 글자에서는 말줄임 없이 다 들어간다(320·360 × 한국어·영어). 글을 숨기거나 지우면 여기서 RED다.
                    const dict = name.startsWith("영어") ? CATALOG.en : CATALOG.ko;
                    const wanted = vp.width < 640 ? dict["timeline.memberPanel.nowFailedShort"] : dict["timeline.memberPanel.nowFailed"];
                    if (foot.reasonCount !== 2) problems.push(`${at}: 까닭 글 요소 ${foot.reasonCount}개(2개여야 함)`);
                    if (foot.shownCount !== 1) problems.push(`${at}: 보이는 까닭 글 ${foot.shownCount}개(1개여야 함)`);
                    if (foot.shownText !== wanted) problems.push(`${at}: 보이는 글 「${foot.shownText}」 ≠ 「${wanted}」`);
                    if (font.px === 16 && foot.textFull > foot.textClient) {
                      problems.push(`${at}: 기본 글자에서 까닭 글이 말줄임됨(칸 ${foot.textClient} < 글 ${foot.textFull})`);
                    }
                    report.push(`${at} 실패 글 칸 ${foot.textClient} / 글 전체 ${Math.round(foot.textFull)}px, 패널 ${Math.round(foot.panel.r - foot.panel.l)}px`);
                  }
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
      console.info(`[#5701·#5711 읽기 실패]\n${report.join("\n")}`);
      expect(problems).toEqual([]);
    },
    900_000
  );
});

// ---- 캡처 (선택): `MEMBER_PANEL_SHOTS=<폴더>`일 때만 돈다. 시험이 아니라 검수용 그림이다 ----------------------------
// 네 상태(로딩·빈·오류·오프라인)와 「지금」 읽기 실패, 아주 긴 글, 키보드 초점, 밝게·어둡게, 좁은 폭(360), 브라우저 확대 200%, 큰 글자(뿌리 200%).
const SHOTS = process.env.MEMBER_PANEL_SHOTS ?? "";

/** 패널 하나를 그 상태로 열어 마크업을 얻는다. */
async function stateHtml(options: {
  members: RosterMember[];
  status: "loading" | "ready" | "failed";
  offline?: boolean;
  nowFails?: boolean;
}): Promise<string> {
  api.fetchRoster.mockResolvedValue(options.members);
  if (options.nowFails === true) api.fetchAllActiveAgentRuns.mockRejectedValue(new ApiError(503, "unavailable"));
  else api.fetchAllActiveAgentRuns.mockResolvedValue({ runs: [run(), hermes()], truncated: false, pages: 1 });
  api.fetchAgentLiveness.mockImplementation(async (_ws: string, agentId: string) => {
    if (agentId.toLowerCase() === SAEBYEOK) throw new ApiError(404, "not hosted");
    return { agentMemberId: agentId, state: "alive_idle", lastSignalAtMs: Date.now() - 2 * MIN };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(LocaleProvider, {
          locale: korean,
          children: createElement(
            SessionProvider,
            { value: session() },
            createElement(ChannelMemberPanel, {
              channelId: CH,
              channelName: "design-lab",
              members: options.members,
              status: options.status,
              offline: options.offline ?? false,
              onRetry: () => undefined,
              onAddMember: () => undefined,
            })
          ),
        })
      )
    );
  });
  await settle();
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-testid="channel-member-count"]')!.click();
  });
  // 실패는 한 번 다시 묻고(1초) 기다림 상한(1.2초)을 넘긴다.
  for (let i = 0; i < (options.nowFails === true ? 40 : 1); i += 1) {
    await settle();
    if (options.nowFails !== true || document.querySelector('[data-testid="channel-member-now-failed"]')) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  }
  const html = document.querySelector<HTMLElement>('[data-testid="channel-member-panel"]')!.outerHTML;
  act(() => root?.unmount());
  root = null;
  host.remove();
  host = null;
  return html;
}

describe("채널 멤버 패널 캡처 (#5686, 선택)", () => {
  it.skipIf(SHOTS === "" || !ENGINES.includes("chromium"))(
    "네 상태·「지금」 실패·키보드 초점 · 밝게/어둡게 · 넓은 창/360/큰 글자",
    async () => {
      const { mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      mkdirSync(SHOTS, { recursive: true });
      const listScenes = await scenes();
      const list = listScenes["처음"];
      const longest = listScenes["아주 김"];
      act(() => root?.unmount());
      root = null;
      host?.remove();
      host = null;
      const opening = await openingFrames(300);
      const states: Record<string, string> = {
        열때첫프레임: opening[0]!.html,
        열때채워진뒤: opening[opening.length - 1]!.html,
        목록: list,
        아주김: longest,
        로딩: await stateHtml({ members: [], status: "loading" }),
        빈: await stateHtml({ members: [], status: "ready" }),
        오류: await stateHtml({ members: [], status: "failed" }),
        오프라인: await stateHtml({ members: FIRST, status: "ready", offline: true }),
        지금실패: await stateHtml({ members: FIRST, status: "ready", nowFails: true }),
      };
      const css = await compileTokensCss(Object.values(states).flatMap(classesOf));
      const playwright = await import("playwright");
      const browser = await playwright.chromium.launch();
      const written: string[] = [];
      try {
        for (const colorScheme of ["light", "dark"] as const) {
          for (const vp of [
            { name: "wide", width: 1280, height: 900, rootFontPx: 16, scale: 1 },
            { name: "360", width: 360, height: 780, rootFontPx: 16, scale: 1 },
            { name: "320", width: 320, height: 780, rootFontPx: 16, scale: 1 },
            // 브라우저 확대 200%: 1280 창이 CSS 640px가 되고 화소는 두 배다.
            { name: "zoom200", width: 640, height: 450, rootFontPx: 16, scale: 2 },
            // 큰 글자(브라우저 기본 글자 200%): 확대와 다르다 — 틀은 그대로, rem만 두 배.
            { name: "bigtext200", width: 1280, height: 1400, rootFontPx: 32, scale: 1 },
          ]) {
            const ctx = await browser.newContext({
              viewport: { width: vp.width, height: vp.height },
              deviceScaleFactor: vp.scale,
              colorScheme,
            });
            try {
              const p = await ctx.newPage();
              const names =
                vp.name === "wide"
                  ? Object.keys(states)
                  : vp.name === "360"
                    ? ["열때첫프레임", "열때채워진뒤", "목록", "아주김", "지금실패"]
                    : ["목록", "아주김", "지금실패"];
              for (const name of names) {
                await p.setContent(page(css, states[name]!, vp.rootFontPx));
                const file = join(SHOTS, `${name}-${colorScheme}-${vp.name}.png`);
                await p.screenshot({ path: file });
                written.push(file);
              }
              if (vp.name === "wide") {
                // 키보드: 패널을 연 뒤 첫 Tab은 목록(굴릴 수 있는 칸)에 선다
                await p.setContent(page(css, states["목록"]!, vp.rootFontPx));
                await p.keyboard.press("Tab");
                const focused = await p.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
                const file = join(SHOTS, `키보드-${colorScheme}-${vp.name}-${focused}.png`);
                await p.screenshot({ path: file });
                written.push(file);
              }
            } finally {
              await ctx.close();
            }
          }
        }
      } finally {
        await browser.close();
      }
      console.info(`[#5686 캡처 ${written.length}장]\n${written.join("\n")}`);
      expect(written.length).toBeGreaterThan(0);
    },
    240_000
  );
});
