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
const D = "00000000-0000-7000-8000-000000000304";
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
  // 이름이 긴 에이전트(16자): 끊긴 레일에서 한정 문장이 긴 이름에도 안 잘리는지 재는 데만 쓴다(`LONG_NAME_OFFLINE`).
  agent(D, "달무리 스튜디오 회의록 정리 봇", "minutes-bot"),
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

/** 이름이 긴 에이전트의 끊긴 레일. 다른 시험이 훑는 `SCENARIOS`에 넣지 않고 양보 계약 시험만 쓴다. */
const LONG_NAME_OFFLINE = scenario("연결이 끊김, 긴 이름", [turn("r1", D, { latestStage: "설계 문서 읽는 중" })], false);

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
    "좁은 창(400)에서도 긴 단계는 줄 안에서 잘리고 칸 높이는 같고, 줄의 누르는 면은 칸을 가득 채운다(24, 넘치지 않는다)",
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
                // 누르는 면은 칸을 가득 채운다(24): 글자 높이(18)가 아니라 칸 높이다. 칸 밖으로 넘치지 않는다(넘친 면은 타임라인·입력창
                // 카드가 가로채서 실제 표적이 되지 못한다, design-review r1 H3).
                lineHeight: b.height,
                lineTop: b.top - sh.top,
                lineBottom: sh.bottom - b.bottom,
                // 칸의 맨 위·맨 아래 1px 안쪽을 눌러도 이 단추가 맞는다.
                hitTop: document.elementFromPoint(b.left + 4, sh.top + 1)?.closest("button") === button,
                hitBottom: document.elementFromPoint(b.left + 4, sh.bottom - 1)?.closest("button") === button,
              };
            });
            if (Math.abs(g.shellHeight - 24) > 0.51) problems.push(`${engine} 칸 높이 ${g.shellHeight}`);
            if (Math.abs(g.lineHeight - 24) > 0.51) problems.push(`${engine} 줄의 누르는 면이 칸 높이(24)가 아니다(${g.lineHeight})`);
            if (g.lineTop < -0.01 || g.lineBottom < -0.01) problems.push(`${engine} 줄이 칸 밖으로 넘친다(위 ${g.lineTop}, 아래 ${g.lineBottom})`);
            if (!g.hitTop || !g.hitBottom) problems.push(`${engine} 칸의 위·아래 가장자리를 눌러도 단추가 맞지 않는다(위 ${g.hitTop}, 아래 ${g.hitBottom})`);
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
    "끊긴 레일: 폭을 훑어도 한정 문장은 전문이 잘리지 않고, 에이전트 글은 접힘·이름만·전문 중 하나이며 낱말 중간에서 끊기지 않는다 (design-review r1 B1, r2 B1-r2)",
    async () => {
      const offline = SCENARIOS.find((x) => x.name.startsWith("연결이 끊김"))!;
      expect(offline.live).toBe(false);
      const html = markupOf(offline);
      const css = await compileTokensCss([...HARNESS_CLASSES, ...classesOf(html)]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 1200, height: 700 } });
          try {
            const p = await ctx.newPage();
            // 열 폭 = 칸 안쪽 + 48(`px-6` 둘). 문턱 둘이 안쪽 20rem(320)·32rem(512)이라 열 폭으로는 368·560이다: 그 앞뒤 1px,
            // 지원하는 가장 좁은 폭(320)·360, 폰(375·390), 데스크탑 최소 창의 열(약 388), 중간 폭, 넓은 창(1000)을 훑는다.
            for (const width of [320, 360, 367, 368, 375, 390, 400, 440, 480, 559, 560, 600, 720, 1000]) {
              await p.setContent(page(css, html).replace("width: 720px", `width: ${width}px`));
              const g = await p.evaluate(() => {
                const shell = document.querySelector<HTMLElement>('[data-testid="composer-working"]')!;
                const stale = shell.querySelector<HTMLElement>('[data-testid="composer-working-stale"]')!;
                const text = shell.querySelector<HTMLElement>('[data-testid="composer-working-text"]')!;
                const tail = shell.querySelector<HTMLElement>('[data-testid="composer-working-tail"]');
                const button = shell.querySelector("button")!.getBoundingClientRect();
                const sh = shell.getBoundingClientRect();
                const cs = getComputedStyle(shell);
                const textRect = text.getBoundingClientRect();
                return {
                  staleClipped: stale.scrollWidth > stale.clientWidth + 0.5,
                  staleWidth: stale.getBoundingClientRect().width,
                  staleNatural: stale.scrollWidth,
                  textWidth: textRect.width,
                  textRight: textRect.right,
                  staleLeft: stale.getBoundingClientRect().left,
                  buttonRight: button.right,
                  shellRight: sh.right,
                  shellHeight: sh.height,
                  // 칸 안쪽 폭(컨테이너 쿼리가 묻는 폭)과 rem: 문턱은 rem이라 둘을 함께 잰다.
                  inner: shell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
                  rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
                  tailWidth: tail ? tail.getBoundingClientRect().width : -1,
                  // 접혀 그려지지 않는 글(`display: none`)은 `innerText`가 `textContent`로 되돌아가므로 폭 0이면 빈 글로 본다.
                  visible: textRect.width === 0 ? "" : text.innerText.replace(/\s+/g, " ").trim(),
                  lead: (text.firstElementChild?.textContent ?? "").trim(),
                  full: (text.textContent ?? "").replace(/\s+/g, " ").trim(),
                  // 서 있는 글이 칸보다 길어 줄임표를 받았는가(= 낱말 중간에서 끊겼는가).
                  textCut: textRect.width > 0 && text.scrollWidth > text.clientWidth + 0.5,
                };
              });
              const at = `${engine} 열 ${width}(안쪽 ${g.inner})`;
              if (g.staleClipped) problems.push(`${at}: 한정 문장이 잘렸다(${g.staleWidth} < ${g.staleNatural})`);
              if (g.textRight > g.staleLeft + 0.5) problems.push(`${at}: 에이전트 글이 한정 문장과 겹친다`);
              if (g.buttonRight > g.shellRight + 0.5) problems.push(`${at}: 줄이 칸 오른쪽을 넘친다`);
              if (Math.abs(g.shellHeight - 24) > 0.51) problems.push(`${at}: 칸 높이 ${g.shellHeight}`);
              // 에이전트 글은 양보한 쪽이다: 칸이 좁은 동안(안쪽 32rem 아래) 한정 문장보다 좁다.
              if (g.inner < 32 * g.rem && !(g.textWidth < g.staleNatural)) problems.push(`${at}: 에이전트 글(${g.textWidth})이 양보하지 않았다`);
              // 부스러기 금지: 서 있는 글은 이름이 읽힐 만큼(≥ 40)이다. 한 글자만 남아 선 줄임표는 안 된다(320에서 10px였다).
              if (!(g.textWidth === 0 || g.textWidth >= 40)) problems.push(`${at}: 에이전트 글이 ${g.textWidth}px 부스러기로 남았다`);
              // **낱말 중간에서 끊기지 않는다**(B1-r2): 서 있는 글은 줄임표를 받지 않고, 보이는 글은 접힘·이름만·전문 셋 중 하나다.
              // 「이름이 읽힌다」가 아니라 「잘리지 않았다」를 잰다(옛 단정은 「달무리봇 · 작…」에서도 통과했다).
              if (g.textCut) problems.push(`${at}: 에이전트 글이 줄임표로 잘렸다 — 「${g.visible}」`);
              if (!(g.visible === "" || g.visible === g.lead || g.visible === g.full)) {
                problems.push(`${at}: 보이는 에이전트 글 「${g.visible}」이 접힘·이름만·전문 어느 것도 아니다`);
              }
              // 단계: 안쪽 20rem 아래 접힘, 32rem 아래 이름만, 그 이상 전문.
              const tier = g.inner < 20 * g.rem ? "hidden" : g.inner < 32 * g.rem ? "name" : "full";
              if (tier === "hidden" && g.textWidth !== 0) problems.push(`${at}: 좁은 칸에서 에이전트 글이 접히지 않았다(${g.textWidth})`);
              if (tier === "name" && !(g.visible === g.lead && g.tailWidth === 0)) {
                problems.push(`${at}: 이름만 서야 하는 폭에서 「${g.visible}」(낱말·단계 폭 ${g.tailWidth})`);
              }
              if (tier === "full" && !(g.visible === g.full && g.tailWidth > 0)) {
                problems.push(`${at}: 전문이 서야 하는 폭에서 「${g.visible}」(낱말·단계 폭 ${g.tailWidth})`);
              }
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

  it.skipIf(ENGINES.length === 0)(
    "끊긴 레일: 이름이 길어도 한정 문장은 잘리지 않고 에이전트 글이 양보한다 (design-review r1 B1의 양보 계약, 문턱 아래 좁은 칸의 긴 이름)",
    async () => {
      // 낱말·단계 접기(`@max-lg:hidden`)는 기본 fixture(이름 4자)에서 에이전트 글이 양보할 일 자체를 없앴다. 그래서 `flex-1`(기준 폭 0에서
      // 남는 자리만 받기)을 지워도 위의 폭 훑기 시험은 통과했다(사보타주가 GREEN으로 드러냄). 이름이 길면(16자) 이름만 단계에서도
      // 남는 자리(칸 안쪽 - 262)보다 길어 에이전트 글이 줄어야 한다: 한정 문장은 전문이고 줄임표는 이름이 받는다(가변 문자열이라 낱말
      // 중간 끊김 규칙의 대상이 아니다, 문서 §9 7번).
      expect(LONG_NAME_OFFLINE.live).toBe(false);
      const html = markupOf(LONG_NAME_OFFLINE);
      const css = await compileTokensCss([...HARNESS_CLASSES, ...classesOf(html)]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 1200, height: 700 } });
          try {
            const p = await ctx.newPage();
            for (const width of [368, 375, 390, 440, 559, 560, 720, 1000]) {
              await p.setContent(page(css, html).replace("width: 720px", `width: ${width}px`));
              const g = await p.evaluate(() => {
                const shell = document.querySelector<HTMLElement>('[data-testid="composer-working"]')!;
                const stale = shell.querySelector<HTMLElement>('[data-testid="composer-working-stale"]')!;
                const text = shell.querySelector<HTMLElement>('[data-testid="composer-working-text"]')!;
                const button = shell.querySelector("button")!.getBoundingClientRect();
                const sh = shell.getBoundingClientRect();
                const cs = getComputedStyle(shell);
                return {
                  staleClipped: stale.scrollWidth > stale.clientWidth + 0.5,
                  staleWidth: stale.getBoundingClientRect().width,
                  staleNatural: stale.scrollWidth,
                  textWidth: text.getBoundingClientRect().width,
                  textRight: text.getBoundingClientRect().right,
                  staleLeft: stale.getBoundingClientRect().left,
                  buttonRight: button.right,
                  shellRight: sh.right,
                  shellHeight: sh.height,
                  inner: shell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
                  rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
                };
              });
              const at = `${engine} 열 ${width}(안쪽 ${g.inner}) 긴 이름`;
              if (g.staleClipped) problems.push(`${at}: 한정 문장이 잘렸다(${g.staleWidth} < ${g.staleNatural})`);
              if (g.textRight > g.staleLeft + 0.5) problems.push(`${at}: 에이전트 글이 한정 문장과 겹친다`);
              if (g.buttonRight > g.shellRight + 0.5) problems.push(`${at}: 줄이 칸 오른쪽을 넘친다`);
              if (Math.abs(g.shellHeight - 24) > 0.51) problems.push(`${at}: 칸 높이 ${g.shellHeight}`);
              // 양보: 칸이 좁은 동안(안쪽 32rem 아래) 에이전트 글이 한정 문장보다 좁다(이름이 줄어든다).
              if (g.inner < 32 * g.rem && !(g.textWidth < g.staleNatural)) problems.push(`${at}: 에이전트 글(${g.textWidth})이 양보하지 않았다`);
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

  it.skipIf(ENGINES.length === 0)(
    "popover-fit: 팝오버의 고정 폭(384)은 Radix가 준 남은 폭보다 넓을 때만 줄어든다 (design-review r1 B2)",
    async () => {
      // 레일 팝오버의 클래스는 컴포넌트 소스에서 꺼내고(시험이 따로 적은 사본이 아니다), 공용 `PopoverContent`의 폭 클래스를 함께 먹인다.
      const source = readFileSync(resolve(process.cwd(), "src/features/agents/ActivityRail.tsx"), "utf8");
      const popoverClass = /className="(popover-fit[^"]*)"\s+data-testid="composer-working-popover"/.exec(source)?.[1] ?? "";
      expect(popoverClass).toContain("popover-fit");
      const widthClass = "w-pane-picker";
      const css = await compileTokensCss([...popoverClass.split(/\s+/), widthClass]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext();
          try {
            const p = await ctx.newPage();
            for (const [available, want] of [
              [500, 384],
              [384, 384],
              [358, 358],
              [328, 328],
              [288, 288],
            ] as const) {
              await p.setContent(
                `<!doctype html><html><head><style>${css} body{margin:0}</style></head><body>` +
                  `<div id="wrap" style="--radix-popover-content-available-width:${available}px">` +
                  `<div id="pop" class="${widthClass} ${popoverClass}">x</div></div></body></html>`
              );
              const w = await p.evaluate(() => document.getElementById("pop")!.getBoundingClientRect().width);
              if (Math.abs(w - want) > 0.51) problems.push(`${engine} 남은 폭 ${available}: 폭 ${w}, 기대 ${want}`);
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
