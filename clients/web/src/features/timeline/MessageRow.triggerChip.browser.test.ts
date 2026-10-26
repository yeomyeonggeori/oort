// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunProgress, Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { MessageRow } from "./MessageRow";

// =============================================================================
// 실제 `MessageRow` 마크업을 실제 엔진에 올려 잰 칩의 기하 (#4619 B·planner 결정 2·6).
//
//   (1) 이름이 어떤 길이든 칩이 있는 머리 줄은 **줄바꿈이 없다**(`it.fails`였던 「이름 17자 이상·창 368」). 칩은 줄
//       안에 있고, 시각은 이름과 겹치지 않으며, 이름은 **최소 열 글자는 보인다** — 줄바꿈을 이름을 잡아먹어서
//       없애는 수리(이름 폭 0, 칩 숨김)가 이 시험을 통과하지 못하게 하려는 단정이다.
//   (2) 이어지는 행의 거터 칩은 행 높이도 본문 자리도 움직이지 않고, 거터와 행 여백 안에 들어가며, 행에 포인터가
//       오면 시각에 자리를 내준다. hover가 없는 기기에서는 서지 않는다.
// 마크업은 jsdom에서 진짜 `MessageRow`가 그린 것이고 시험이 따로 적은 사본이 아니다.
// =============================================================================

const api = vi.hoisted(() => ({ fetchAgentLiveness: vi.fn(), fetchAgentRunEvents: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const AGENT = "00000000-0000-7000-8000-000000000102";
const MSG = "0199eeee-0000-7000-8000-000000000501";
const T0 = new Date("2026-10-27T03:00:00Z").getTime();
const MIN = 60_000;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  api.fetchAgentLiveness.mockRejectedValue(new Error("no liveness in this test"));
  api.fetchAgentRunEvents.mockResolvedValue({ runId: "x", events: [] });
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function member(id: string, kind: "human" | "agent", name: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

/** 한글 열네 글자를 돌려 쓴 이름: 글자 폭이 일정해서 길이 훑기가 폭을 단조롭게 늘린다. */
const nameOf = (length: number) => "가나다라마바사아자차카타파하".repeat(4).slice(0, length);

function message(): Message {
  return {
    id: MSG,
    channelId: CH,
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: "@달무리봇 이번 주 회의록 정리해 줘",
    state: "sent",
    createdAtMs: T0 - 30 * MIN,
  };
}

function run(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: "0199aa11-2222-7000-8000-0000000000b1",
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: MSG,
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 0,
    ahead: [],
    startedAtMs: T0 - 2 * MIN,
    createdAtMs: T0 - 3 * MIN,
    updatedAtMs: T0 - 3 * MIN,
    ...extra,
  };
}

// 가장 넓은 낱말(「아직 받지 않았어요」, 유예를 넘은 대기)과 가장 짧은 낱말(「받음」)을 모두 훑는다.
const RUNS: { label: string; run: AgentRunProgress }[] = [
  { label: "작업 중", run: run() },
  {
    label: "아직 받지 않았어요",
    run: run({ status: "queued", phase: "queued", leaseState: "none", startedAtMs: undefined, createdAtMs: T0 - 10 * MIN }),
  },
];

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

/** 진짜 MessageRow를 한 번 그려 마크업을 얻는다. */
function rowHtml(options: { name: string; startsGroup: boolean; runs?: AgentRunProgress[] }): string {
  const directory = makeDirectory([
    member(ME, "human", options.name, "hayun"),
    member(AGENT, "agent", "달무리봇", "dalmuri-bot"),
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const node: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      OpenMemberProfileContext.Provider,
      { value: () => undefined },
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageRow, {
          message: message(),
          directory,
          startsGroup: options.startsGroup,
          ...(options.runs !== undefined ? { runStatus: options.runs } : {}),
        })
      )
    )
  );
  act(() => root.render(node));
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, columnWidth: number, html: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#col { width: ${columnWidth}px; }
</style></head><body class="bg-surface text-ink"><div id="col">${html}</div></body></html>`;
}

type Page = import("playwright").Page;

interface HeadGeometry {
  headHeight: number;
  headLeft: number;
  headRight: number;
  nameRight: number;
  nameText: { width: number; clientWidth: number; scrollWidth: number };
  timeLeft: number;
  timeRight: number;
  chip: { left: number; right: number; top: number; bottom: number; width: number } | null;
  layer: "word" | "mark" | null;
}

async function measureHead(p: Page): Promise<HeadGeometry> {
  return p.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const time = document.querySelector<HTMLElement>('[data-testid="row-time"]')!;
    const head = time.parentElement!;
    const nameGroup = head.firstElementChild as HTMLElement;
    const nameText = nameGroup.firstElementChild as HTMLElement;
    const chip = document.querySelector<HTMLElement>('[data-testid="trigger-chip"]');
    const shown = (id: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      return el !== null && el.getClientRects().length > 0 && rect(el).width > 0;
    };
    return {
      headHeight: rect(head).height,
      headLeft: rect(head).left,
      headRight: rect(head).right,
      nameRight: rect(nameGroup).right,
      nameText: { width: rect(nameText).width, clientWidth: nameText.clientWidth, scrollWidth: nameText.scrollWidth },
      timeLeft: rect(time).left,
      timeRight: rect(time).right,
      chip:
        chip === null
          ? null
          : { left: rect(chip).left, right: rect(chip).right, top: rect(chip).top, bottom: rect(chip).bottom, width: rect(chip).width },
      layer: chip === null ? null : shown("trigger-chip-word") ? "word" : shown("trigger-chip-mark") ? "mark" : null,
    };
  });
}

/** 줄 자신의 폭(= `@container`의 폭)이 24rem(384) 미만이면 아이콘 칩이다. 열의 폭에서 행 여백·아바타·간격 72를 뺀 값이 줄의 폭이다. */
const HEAD_OVERHEAD_PX = 72;

describe("칩이 있는 머리 줄은 이름이 아무리 길어도 줄바꿈이 없다 (#4619 planner 결정 6)", () => {
  it.skipIf(ENGINES.length === 0)(
    "이름 2~40자 × 열 폭(320·368·420·460·480·720) × 두 낱말: 줄 높이 불변, 칩·시각이 줄 안, 이름은 열 글자 이상 보인다",
    async () => {
      const lengths = Array.from({ length: 39 }, (_, i) => i + 2);
      const widths = [320, 368, 420, 460, 480, 720];
      const cases: { key: string; html: string }[] = [];
      for (const length of lengths) {
        cases.push({ key: `plain|${length}`, html: rowHtml({ name: nameOf(length), startsGroup: true }) });
        for (const r of RUNS) {
          cases.push({ key: `${r.label}|${length}`, html: rowHtml({ name: nameOf(length), startsGroup: true, runs: [r.run] }) });
        }
      }
      const css = await compileTokensCss(cases.flatMap((c) => classesOf(c.html)));
      const playwright = await import("playwright");
      const problems: string[] = [];
      const seenLayers = new Set<string>();

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
          try {
            const p = await ctx.newPage();
            for (const width of widths) {
              const headWidth = width - HEAD_OVERHEAD_PX;
              const expectedLayer = headWidth < 384 ? "mark" : "word";
              // 열 글자의 자연 폭: 이 폭의 줄에서 칩 없이 열 글자 이름이 서는 폭이다.
              await p.setContent(page(css, width, cases.find((c) => c.key === "plain|10")!.html));
              const ten = (await measureHead(p)).nameText.width;
              // 한 줄의 높이: 이름이 짧은 칩 없는 줄이다.
              await p.setContent(page(css, width, cases.find((c) => c.key === "plain|2")!.html));
              const oneLine = (await measureHead(p)).headHeight;
              for (const length of lengths) {
                for (const r of RUNS) {
                  const at = `${engine} 열 ${width}(줄 ${headWidth}) ${r.label} 이름 ${length}자`;
                  await p.setContent(page(css, width, cases.find((c) => c.key === `${r.label}|${length}`)!.html));
                  const g = await measureHead(p);
                  if (g.chip === null) {
                    problems.push(`${at}: 칩이 없다`);
                    continue;
                  }
                  seenLayers.add(`${engine}|${width}|${g.layer}`);
                  if (g.layer !== expectedLayer) problems.push(`${at}: 보이는 층 ${g.layer}, 기대 ${expectedLayer}`);
                  if (Math.abs(g.headHeight - oneLine) > 0.5) {
                    problems.push(`${at}: 머리 줄 높이 ${g.headHeight}, 한 줄 ${oneLine} — 줄바꿈이 생겼다`);
                  }
                  if (g.chip.right > g.headRight + 0.5 || g.chip.left < g.headLeft - 0.5) {
                    problems.push(`${at}: 칩이 줄 밖이다(${g.chip.left}~${g.chip.right}, 줄 ${g.headLeft}~${g.headRight})`);
                  }
                  if (g.timeRight > g.chip.left + 0.5) problems.push(`${at}: 시각이 칩과 겹친다`);
                  if (g.nameRight > g.timeLeft + 0.5) problems.push(`${at}: 이름이 시각과 겹친다`);
                  // 이름은 열 글자 이상 보인다(열 글자보다 짧은 이름은 잘리지 않는다).
                  const wanted = Math.min(length, 10);
                  const visibleOk =
                    length <= 10
                      ? g.nameText.scrollWidth <= g.nameText.clientWidth + 0.5
                      : g.nameText.width >= ten - 1;
                  if (!visibleOk) {
                    problems.push(`${at}: 이름이 ${wanted}자도 안 보인다(보이는 폭 ${g.nameText.width}, 열 글자 ${ten})`);
                  }
                }
              }
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      // 시험이 두 층(낱말·아이콘)을 모두 실제로 지났다.
      for (const engine of ENGINES) {
        expect(seenLayers.has(`${engine}|368|mark`), `${engine} 368 아이콘`).toBe(true);
        expect(seenLayers.has(`${engine}|720|word`), `${engine} 720 낱말`).toBe(true);
      }
      expect(problems).toEqual([]);
    },
    280_000
  );
});

interface GutterGeometry {
  rowHeight: number;
  rowTop: number;
  bodyLeft: number;
  bodyTop: number;
  gutterLeft: number;
  gutterRight: number;
  rowLeft: number;
  chip: { left: number; right: number; top: number; bottom: number; opacity: number; display: string } | null;
  time: { opacity: number; left: number; right: number };
}

async function measureGutter(p: Page): Promise<GutterGeometry> {
  return p.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>("[data-row-body]")!;
    const rowEl = body.parentElement!;
    const time = document.querySelector<HTMLElement>('[data-testid="row-time"]')!;
    const gutter = time.parentElement!;
    const chipWrap = document.querySelector<HTMLElement>("[data-row-chip]");
    const chip = chipWrap?.querySelector<HTMLElement>('[data-testid="trigger-chip"]') ?? null;
    return {
      rowHeight: rect(rowEl).height,
      rowTop: rect(rowEl).top,
      bodyLeft: rect(body).left,
      bodyTop: rect(body).top,
      gutterLeft: rect(gutter).left,
      gutterRight: rect(gutter).right,
      rowLeft: rect(rowEl).left,
      chip:
        chipWrap === null || chip === null
          ? null
          : {
              left: rect(chip).left,
              right: rect(chip).right,
              top: rect(chip).top,
              bottom: rect(chip).bottom,
              opacity: Number.parseFloat(getComputedStyle(chipWrap).opacity),
              display: getComputedStyle(chipWrap).display,
            },
      time: { opacity: Number.parseFloat(getComputedStyle(time).opacity), left: rect(time).left, right: rect(time).right },
    };
  });
}

describe("이어지는 행의 거터 칩 (#4619 planner 결정 2)", () => {
  it.skipIf(ENGINES.length === 0)(
    "행 높이·본문 자리가 칩 때문에 움직이지 않고, 칩이 거터·행 여백 안에 들며, 포인터가 오면 시각에 자리를 내준다",
    async () => {
      const states = RUNS.map((r) => ({ ...r, html: rowHtml({ name: "정하윤", startsGroup: false, runs: [r.run] }) }));
      const failed = {
        label: "실패",
        html: rowHtml({
          name: "정하윤",
          startsGroup: false,
          runs: [run({ status: "failed", phase: "failed", endReason: "agent_error", finishedAtMs: T0 - 1_000 })],
        }),
      };
      const css = await compileTokensCss([...states.map((s) => s.html), failed.html].flatMap(classesOf));
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            // 움직임 줄이기: 페이드가 즉시 끝나 hover 직후의 값을 바로 잰다(`motion-reduce:transition-none`).
            const ctx = await browser.newContext({
              viewport: { width: 800, height: 400 },
              colorScheme,
              reducedMotion: "reduce",
            });
            try {
              const p = await ctx.newPage();
              for (const s of [...states, failed]) {
                const at = `${engine} ${colorScheme} 「${s.label}」`;
                await p.setContent(page(css, 480, s.html));
                const g = await measureGutter(p);
                if (g.chip === null) {
                  problems.push(`${at}: 거터 칩이 없다`);
                  continue;
                }
                // 같은 행에서 칩 마크업만 뗀 것이 기준이다(예외 줄처럼 행에 원래 있는 것은 그대로 남는다).
                await p.evaluate(() => document.querySelector("[data-row-chip]")!.remove());
                const base = await measureGutter(p);
                if (Math.abs(g.rowHeight - base.rowHeight) > 0.01) problems.push(`${at}: 행 높이 ${g.rowHeight}, 칩 없을 때 ${base.rowHeight}`);
                if (Math.abs(g.bodyLeft - base.bodyLeft) > 0.01) problems.push(`${at}: 본문 왼쪽이 ${g.bodyLeft - base.bodyLeft}px 움직였다`);
                if (Math.abs(g.bodyTop - base.bodyTop) > 0.01) problems.push(`${at}: 본문 위쪽이 ${g.bodyTop - base.bodyTop}px 움직였다`);
                // 거터(32)와 행 안쪽 여백 안: 칩이 본문으로 새지 않고 행 밖으로도 나가지 않는다.
                if (g.chip.right > g.gutterRight + 0.5) problems.push(`${at}: 칩이 거터 오른쪽을 넘는다`);
                if (g.chip.left < g.rowLeft - 0.5) problems.push(`${at}: 칩이 행 왼쪽 밖이다`);
                if (g.chip.right > g.bodyLeft + 0.5) problems.push(`${at}: 칩이 본문과 겹친다`);
                if (g.chip.top < g.rowTop - 0.5 || g.chip.bottom > g.rowTop + g.rowHeight + 0.5) problems.push(`${at}: 칩이 행 높이 밖이다`);
                // 쉬는 중: 칩이 보이고 시각은 숨는다.
                if (!(g.chip.opacity > 0.99)) problems.push(`${at}: 쉬는 중 칩 투명도 ${g.chip.opacity}`);
                if (!(g.time.opacity < 0.01)) problems.push(`${at}: 쉬는 중 시각 투명도 ${g.time.opacity}`);
                // 포인터가 행에 오면 시각이 서고 칩은 자리를 내준다(칩 마크업을 다시 세워 잰다).
                await p.setContent(page(css, 480, s.html));
                await p.hover("[data-row-body]");
                const hovered = await measureGutter(p);
                if (!(hovered.chip!.opacity < 0.01)) problems.push(`${at}: hover 중 칩 투명도 ${hovered.chip!.opacity}(자리를 내줘야 한다)`);
                if (!(hovered.time.opacity > 0.99)) problems.push(`${at}: hover 중 시각 투명도 ${hovered.time.opacity}`);
                if (Math.abs(hovered.rowHeight - base.rowHeight) > 0.01) problems.push(`${at}: hover 중 행 높이가 바뀌었다`);
                await p.mouse.move(0, 0);
              }
            } finally {
              await ctx.close();
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

  it.skipIf(ENGINES.length === 0)(
    "hover가 없는 기기(터치)에서는 거터 칩이 서지 않고 시각이 처음부터 서 있다",
    async () => {
      const html = rowHtml({ name: "정하윤", startsGroup: false, runs: [run()] });
      const css = await compileTokensCss(classesOf(html));
      const playwright = await import("playwright");
      const problems: string[] = [];
      let exercised = 0;
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          // `hasTouch`+`isMobile`은 `(hover: none)`을 켠다(엔진이 지원하면). 켜지지 않으면 이 엔진은 건너뛴다.
          const ctx = await browser.newContext({ viewport: { width: 480, height: 400 }, hasTouch: true, isMobile: true });
          try {
            const p = await ctx.newPage();
            await p.setContent(page(css, 480, html));
            const noHover = await p.evaluate(() => matchMedia("(hover: none)").matches);
            if (!noHover) continue;
            exercised += 1;
            const g = await measureGutter(p);
            if (g.chip === null) {
              problems.push(`${engine}: 거터 칩 마크업이 없다`);
              continue;
            }
            if (g.chip.display !== "none") problems.push(`${engine}: 터치 기기에서 칩의 display가 ${g.chip.display}`);
            if (!(g.time.opacity > 0.99)) problems.push(`${engine}: 터치 기기에서 시각 투명도 ${g.time.opacity}`);
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      // 한 엔진도 터치 에뮬레이션을 못 켰다면 이 시험은 아무것도 잰 것이 아니다.
      expect(exercised, "터치(hover: none)를 켠 엔진 수").toBeGreaterThan(0);
      expect(problems).toEqual([]);
    },
    120_000
  );
});
