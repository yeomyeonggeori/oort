// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { AgentRunProgress, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { activityRail, type ActivityRail } from "@momo/core/features/agents/activityRail";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { ActivityRailView, RAIL_SHELL_CLASS } from "./ActivityRail";

// =============================================================================
// 레일이 서고 사라지고 바뀌고 합쳐지고 끊겨도 **타임라인의 바닥 행이 한 픽셀도 움직이지 않는다** (#4619 A,
// 계약: 「목록 맨 아래 행 y 이동 0」). jsdom은 레이아웃을 못 잰다 — 그래서 `ActivityRailView`가 그린 **진짜
// 마크업**을 `tokens.css`를 Tailwind로 컴파일한 CSS와 함께 실제 엔진(Chromium·WebKit 중 설치된 것 전부)에
// 올려, 채팅 열(바닥에 붙은 목록 + 레일 칸 + 입력창 카드)의 바닥 행 위치를 잰다.
//
// 이 시험이 지키는 것은 칸의 높이 클래스(`RAIL_SHELL_CLASS`의 `h-6`)다. 그 클래스를 빼면 칸이 비어 있을 때와
// 줄이 있을 때 높이가 달라져 바닥 행이 밀리고, 이 시험이 붉어진다(사보타주로 확인). 마크업은 컴포넌트가 낸
// 것이고 시험이 따로 적은 사본이 아니다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const A = "00000000-0000-7000-8000-000000000301";
const B = "00000000-0000-7000-8000-000000000302";
const C = "00000000-0000-7000-8000-000000000303";
const T = 1_800_000_000_000;
const MIN = 60_000;

function agent(id: string, name: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: name,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const directory = makeDirectory([
  agent(A, "달무리봇", "dalmuri-bot"),
  agent(B, "모래시계봇", "sand-bot"),
  agent(C, "구름봇", "cloud-bot"),
]);
const nameFor = (id: string) => ({ name: directory.byId.get(id.toLowerCase())?.displayName ?? "" });

function turn(id: string, memberId: string, extra: Partial<AgentRunProgress> = {}) {
  const signal = signalFromProgress({
    id,
    channelId: CH,
    agentMemberId: memberId,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 0,
    ahead: [],
    startedAtMs: T,
    claimedAtMs: T,
    createdAtMs: T,
    updatedAtMs: T,
    ...extra,
  });
  if (signal === null) throw new Error("열린 턴이 아니다");
  return signal;
}

const LONG_STAGE =
  "분기 회고 문서의 세 번째 절에 들어갈 표를 정리하면서 지난 분기와 이번 분기의 지표를 한꺼번에 맞춰 보는 중이라 이 줄은 한 줄에 다 들어가지 못해요";

interface Scenario {
  name: string;
  rail: ActivityRail | null;
  live: boolean;
}

function scenario(name: string, turns: ReturnType<typeof turn>[], live = true): Scenario {
  return { name, rail: activityRail(turns, nameFor, T + 12 * MIN), live };
}

const SCENARIOS: Scenario[] = [
  { name: "비어 있음(칸만)", rail: null, live: true },
  scenario("1명 작업 중", [turn("r1", A, { latestStage: "설계 문서 읽는 중" })]),
  scenario("1명 작업 중, 아주 긴 단계(한 줄에 안 들어감)", [turn("r1", A, { latestStage: LONG_STAGE })]),
  scenario("1명 작업 중, 단계 없음", [turn("r1", A)]),
  scenario("2명(합침)", [turn("r1", A), turn("r2", B, { latestStage: "표 정리하는 중" })]),
  scenario("3명(합침)", [turn("r1", A), turn("r2", B), turn("r3", C)]),
  scenario("승인 대기", [turn("r1", A, { phase: "awaiting_approval", status: "awaiting_approval" })]),
  scenario("받음", [
    turn("r1", A, { phase: "queued", status: "queued", leaseState: "none", startedAtMs: undefined, claimedAtMs: undefined, createdAtMs: T + 12 * MIN - 20_000 }),
  ]),
  scenario("가져감", [turn("r1", A, { phase: "claimed", status: "queued", startedAtMs: undefined })]),
  scenario("연결이 끊김(마지막 확인 문장이 같은 줄에 붙음)", [turn("r1", A, { latestStage: "설계 문서 읽는 중" })], false),
];

/** 레일을 실제로 한 번 그려 마크업을 얻는다(시험이 적은 사본이 아니라 컴포넌트가 낸 것). */
function markupOf(s: Scenario): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() =>
    root.render(
      createElement(ActivityRailView, { rail: s.rail, live: s.live, directory, channelId: CH })
    )
  );
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

const HARNESS_CLASSES = ["p-3", "pt-0", "flex", "shrink-0"];

/** 채팅 열: 바닥에 붙은 목록, 레일 칸, 입력창 카드. 높이는 고정이라 칸의 높이가 바뀌면 목록이 밀린다. */
function page(css: string, railHtml: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#chat { display: flex; flex-direction: column; height: 520px; width: 720px; box-sizing: border-box; }
#list { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; }
#row-last { height: 48px; flex: none; }
#card { height: 72px; }
</style></head><body>
<div id="chat">
  <div id="list"><div id="row-prev" style="height:48px;flex:none">이전 행</div><div id="row-last">마지막 행</div></div>
  <div id="composer">
    <div id="rail-slot">${railHtml}</div>
    <form class="relative p-3 pt-0"><div id="card"></div></form>
  </div>
</div>
</body></html>`;
}

interface Geometry {
  rowLastTop: number;
  rowLastBottom: number;
  cardTop: number;
  shellHeight: number;
  shellOverflow: boolean;
  lineHeight: number | null;
}

async function measure(pageHandle: import("playwright").Page): Promise<Geometry> {
  return pageHandle.evaluate(() => {
    const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const shell = document.querySelector<HTMLElement>('[data-testid="composer-working"]')!;
    const line = shell.querySelector<HTMLElement>('[data-testid="composer-working-open"]');
    return {
      rowLastTop: rect("row-last").top,
      rowLastBottom: rect("row-last").bottom,
      cardTop: rect("card").top,
      shellHeight: shell.getBoundingClientRect().height,
      // 줄이 칸을 넘치면(칸의 높이를 키우지 않고 밖으로 삐져나오면) 이웃을 덮는다.
      shellOverflow: line !== null && line.getBoundingClientRect().height > shell.getBoundingClientRect().height + 0.5,
      lineHeight: line === null ? null : line.getBoundingClientRect().height,
    };
  });
}

describe("레일 칸의 높이 예약 (#4619 A)", () => {
  it.skipIf(ENGINES.length === 0)(
    "줄이 서고·사라지고·바뀌고·합쳐지고·끊겨도 바닥 행과 입력창 카드의 y 이동이 0이다",
    async () => {
      const markups = SCENARIOS.map((s) => ({ s, html: markupOf(s) }));
      const candidates = [
        ...HARNESS_CLASSES,
        ...RAIL_SHELL_CLASS.split(/\s+/),
        ...markups.flatMap(({ html }) => classesOf(html)),
      ];
      const css = await compileTokensCss(candidates);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, colorScheme });
            try {
              const p = await ctx.newPage();
              // 한 쪽에서 칸 안의 내용만 갈아 끼우며 같은 쪽의 바닥 행을 잰다: 서고 사라지는 전이 그 자체다.
              await p.setContent(page(css, markups[0]!.html));
              const base = await measure(p);
              const at = `${engine} ${colorScheme}`;
              if (!(Math.abs(base.shellHeight - 24) < 0.51)) {
                problems.push(`${at} 비어 있는 칸의 높이 ${base.shellHeight}, 기대 24`);
              }
              for (const { s, html } of markups) {
                await p.evaluate((next) => {
                  document.getElementById("rail-slot")!.innerHTML = next;
                }, html);
                const g = await measure(p);
                const dy = Math.max(
                  Math.abs(g.rowLastTop - base.rowLastTop),
                  Math.abs(g.rowLastBottom - base.rowLastBottom),
                  Math.abs(g.cardTop - base.cardTop)
                );
                if (dy > 0.01) {
                  problems.push(`${at} 「${s.name}」: 바닥 행·카드가 ${dy}px 움직였다`);
                }
                if (Math.abs(g.shellHeight - base.shellHeight) > 0.01) {
                  problems.push(`${at} 「${s.name}」: 칸의 높이 ${g.shellHeight}, 비어 있을 때 ${base.shellHeight}`);
                }
                if (g.shellOverflow) {
                  problems.push(`${at} 「${s.name}」: 줄(${g.lineHeight}px)이 칸(${g.shellHeight}px)을 넘친다`);
                }
              }
              // 칸 높이 24는 줄(글 18 + 얼굴 16)보다 크다: 넘치지 않는다는 위 단정이 의미를 가진다.
              const withLine = await measure(p);
              if (withLine.lineHeight === null || !(withLine.lineHeight <= 24)) {
                problems.push(`${at} 줄 높이 ${withLine.lineHeight}`);
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
    120_000
  );

  it.skipIf(ENGINES.length === 0)(
    "좁은 창(400)에서도 긴 단계는 줄 안에서 잘리고 칸 높이는 같고, 줄의 누르는 면은 44까지 칸 밖으로 고르게 넘친다",
    async () => {
      const long = SCENARIOS.find((s) => s.name.startsWith("1명 작업 중, 아주 긴"))!;
      const html = markupOf(long);
      const css = await compileTokensCss([...HARNESS_CLASSES, ...classesOf(html)]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 400, height: 700 } });
          try {
            const p = await ctx.newPage();
            await p.setContent(page(css, html).replace("width: 720px", "width: 368px"));
            const g = await p.evaluate(() => {
              const shell = document.querySelector<HTMLElement>('[data-testid="composer-working"]')!;
              const text = shell.querySelector<HTMLElement>('[data-testid="composer-working-text"]')!;
              const button = shell.querySelector("button")!;
              const b = button.getBoundingClientRect();
              const sh = shell.getBoundingClientRect();
              return {
                shellHeight: sh.height,
                textTruncated: text.scrollWidth > text.clientWidth,
                shellWidth: sh.width,
                lineRight: b.right,
                shellRight: sh.right,
                // 폰 폭(<600)에서 줄은 `tap-target`으로 44까지 자란다. 칸(24)은 그대로이고 줄은 칸의 가운데에서 위아래로 고르게 넘친다.
                lineHeight: b.height,
                centerOffset: Math.abs(b.top + b.height / 2 - (sh.top + sh.height / 2)),
              };
            });
            if (Math.abs(g.shellHeight - 24) > 0.51) problems.push(`${engine} 칸 높이 ${g.shellHeight}`);
            if (g.lineHeight < 43.5) problems.push(`${engine} 폰 폭에서 줄의 누르는 면이 44에 못 미친다(${g.lineHeight})`);
            if (g.centerOffset > 0.51) problems.push(`${engine} 줄이 칸의 가운데에서 넘치지 않는다(어긋남 ${g.centerOffset})`);
            if (!g.textTruncated) problems.push(`${engine} 긴 단계가 잘리지 않았다(한 줄을 넘는 글이 칸을 넘는다)`);
            if (g.lineRight > g.shellRight + 0.5) problems.push(`${engine} 줄이 칸 오른쪽을 넘친다`);
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    120_000
  );

  it.skipIf(ENGINES.length === 0)(
    "폼의 윗 여백은 레일 칸이 설 때만 0이다(칸 24 + 여백 12가 겹쳐 쌓이지 않는다)",
    async () => {
      // 클래스는 컴포저의 JSX 문자열 그대로다(소스에서 꺼내 엔진에 먹인다): `data-rail:pt-0`이 실제로 컴파일되어
      // 속성이 있을 때만 윗 여백을 0으로 만드는지 엔진이 계산한 값으로 잰다.
      const source = readFileSync(resolve(process.cwd(), "src/features/chat/Composer.tsx"), "utf8");
      const formClass = /<form\s+onSubmit=\{onSubmit\}\s+className="([^"]*)"/.exec(source)?.[1] ?? "";
      expect(formClass).toContain("data-rail:pt-0");
      const css = await compileTokensCss(formClass.split(/\s+/));
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext();
          try {
            const p = await ctx.newPage();
            for (const [attr, want] of [["", 0], [null, 12]] as const) {
              await p.setContent(
                `<!doctype html><html><head><style>${css}</style></head><body>` +
                  `<form id="f" class="${formClass}"${attr === null ? "" : " data-rail"}><div style="height:8px"></div></form></body></html>`
              );
              const pt = await p.evaluate(
                () => Number.parseFloat(getComputedStyle(document.getElementById("f")!).paddingTop)
              );
              const pl = await p.evaluate(
                () => Number.parseFloat(getComputedStyle(document.getElementById("f")!).paddingLeft)
              );
              if (Math.abs(pt - want) > 0.01) problems.push(`${engine} data-rail=${attr === null ? "없음" : "있음"}: 윗 여백 ${pt}, 기대 ${want}`);
              if (Math.abs(pl - 12) > 0.01) problems.push(`${engine} 옆 여백 ${pl}, 기대 12(윗 여백만 바뀐다)`);
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    120_000
  );
});
