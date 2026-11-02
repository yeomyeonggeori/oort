// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import { agentRunLedgerFromWire } from "@momo/core/lib/api";
import { workActivityRecord, type WorkActivityRecord } from "@momo/core/features/agents/workReport";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { AgentReportSection } from "./WorkTimelineView";

// =============================================================================
// 행이 붙어도 **위 행은 한 픽셀도 움직이지 않는다** (#4657 A1-U2, 계약: 「위 행 y 이동 0」). jsdom은 레이아웃을
// 못 잰다 — 그래서 `AgentReportSection`이 단계마다 그린 **진짜 마크업**(같은 뿌리에 다시 그린 결과라 도착 표지가
// 실제 앱과 같이 붙어 있다)을 `tokens.css`를 Tailwind로 컴파일한 CSS와 함께 실제 엔진(Chromium·WebKit 중
// 설치된 것 전부)에 올려, 320px 열에서 줄의 위치를 잰다. 시나리오는 줄이 붙고, 상태가 제자리에서 바뀌고, 계획이
// 제자리에서 바뀌고, 합계·상한 문장이 서고, 읽기·검색이 한 줄로 가라앉는 순간을 모두 지난다.
//
// 모션의 숫자도 여기서 **브라우저가 계산한 값**으로 잰다: 새 줄은 불투명도만 240ms(이동 키프레임 없음), 상태 칩의
// 전환은 120ms, 움직이는 점은 하나, 동작 줄이기에서는 전부 0ms·정지. (CSS 문자열을 읽는 시험은
// `WorkTimelineView.test.tsx`가 따로 갖는다 — 엔진이 없는 환경에서도 같은 계약을 지킨다.)
// =============================================================================

const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;

type Over = Partial<{ kind: string; label: string; status: string; n: number }>;
const act_ = (ordinal: number, id: string, over: Over = {}) => ({
  ordinal,
  kind: "activity",
  createdAtMs: T + ordinal * 1000,
  activity: { id, kind: "edit", status: "completed", n: 1, startedAtMs: T + ordinal * 1000, ...over },
});
const plan = (statuses: string[]) => ({
  ordinal: 99,
  kind: "plan",
  createdAtMs: T + 99_000,
  plan: statuses.map((status, index) => ({ text: `계획 ${index + 1}단계`, status })),
});

interface Step {
  name: string;
  record: WorkActivityRecord;
}

function step(name: string, events: unknown[], extra: Record<string, unknown> = {}): Step {
  return {
    name,
    record: workActivityRecord(agentRunLedgerFromWire({ runId: RUN, events, ...extra }), { open: true, working: true }),
  };
}

const P0 = ["completed", "in_progress", "pending", "pending"];
const P1 = ["completed", "completed", "in_progress", "pending"];
const r1 = act_(1, "r1", { kind: "read", n: 9 });
const e1 = act_(2, "e1", { kind: "edit", label: "리포트 고치기", status: "in_progress" });
const c1 = act_(3, "c1", { kind: "run", label: "테스트 돌리기", status: "in_progress" });
const e1Done = act_(2, "e1", { kind: "edit", label: "리포트 고치기" });
const f1 = act_(4, "f1", { kind: "run", label: "배포 점검", status: "failed" });
const r2 = act_(5, "r2", { kind: "read", n: 2 });
const s2 = act_(6, "s2", { kind: "search", n: 3 });
const TALLY = [
  { kind: "run", completed: 0, failed: 1 },
  { kind: "edit", completed: 1, failed: 0 },
  { kind: "read", completed: 9, failed: 0 },
];

/** 줄이 붙는 순서. 계획 블록은 처음부터 서 있고(줄 위), 줄이 붙는 동안 높이가 같다. */
const STEPS: Step[] = [
  step("처음 그릴 때 1줄", [r1, plan(P0)], { activityTally: [] }),
  step("새 줄(진행 중)", [r1, e1, plan(P0)], { activityTally: [] }),
  step("새 줄(진행 중, 점이 옮겨 감)", [r1, e1, c1, plan(P0)], { activityTally: [] }),
  step("제자리: 한 줄이 끝나고 계획의 지금 단계가 옮겨 감", [r1, e1Done, c1, plan(P1)], { activityTally: [] }),
  step("새 줄(실패)", [r1, e1Done, c1, f1, plan(P1)], { activityTally: [] }),
  step("합계가 선다(줄 아래)", [r1, e1Done, c1, f1, plan(P1)], { activityTally: TALLY }),
  step("상한 문장이 선다(줄 아래)", [r1, e1Done, c1, f1, plan(P1)], { activityTally: TALLY, activityRowsTrimmed: true }),
  step("새 줄(끝난 읽기)", [r1, e1Done, c1, f1, r2, plan(P1)], { activityTally: TALLY, activityRowsTrimmed: true }),
  step("끝난 검색이 앞의 읽기에 가라앉는다(맨 아래 줄이 사라짐)", [r1, e1Done, c1, f1, r2, s2, plan(P1)], {
    activityTally: TALLY,
    activityRowsTrimmed: true,
  }),
];

let korean: AppLocale;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

/** 같은 뿌리에 단계마다 다시 그리고 그때그때의 마크업을 얻는다(실제 앱처럼 새 줄에만 도착 표지가 붙는다). */
function markups(): string[] {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const out: string[] = [];
  for (const { record } of STEPS) {
    act(() =>
      root.render(
        createElement(LocaleProvider, {
          locale: korean,
          children: createElement(AgentReportSection, { record, open: true, live: true, nowMs: T }),
        })
      )
    );
    out.push(host.innerHTML);
  }
  act(() => root.unmount());
  host.remove();
  return out;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, html: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#panel { width: 320px; }
</style></head><body><div id="panel"><div id="slot">${html}</div></div></body></html>`;
}

interface Geometry {
  rows: { id: string; top: number; height: number }[];
  planTop: number | null;
  planHeight: number | null;
  headTop: number;
  footerTop: number | null;
  lastRowBottom: number | null;
}

async function measure(p: import("playwright").Page): Promise<Geometry> {
  return p.evaluate(() => {
    const rect = (el: Element | null) => (el === null ? null : el.getBoundingClientRect());
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="work-timeline-row"]')].map((li) => ({
      id: li.dataset.rowId ?? "",
      top: li.getBoundingClientRect().top,
      height: li.getBoundingClientRect().height,
    }));
    const plan = rect(document.querySelector('[data-testid="agent-work-panel-plan"]'));
    const footer = rect(document.querySelector('[data-testid="agent-work-panel-agent-tally"]'));
    return {
      rows,
      planTop: plan?.top ?? null,
      planHeight: plan?.height ?? null,
      headTop: rect(document.querySelector('[data-testid="work-timeline-source-badge"]'))?.top ?? 0,
      footerTop: footer?.top ?? null,
      lastRowBottom: rows.length === 0 ? null : (rect([...document.querySelectorAll('[data-testid="work-timeline-row"]')].at(-1) ?? null)?.bottom ?? null),
    };
  });
}

describe("에이전트 보고 칸: 행이 붙어도 위 행 y 이동 0 (#4657)", () => {
  it.skipIf(ENGINES.length === 0)(
    "줄이 붙고·제자리에서 바뀌고·접혀도, 계획 블록·칸 머리·이전 줄의 위치가 그대로이며 합계·상한 문장은 줄 아래에 선다",
    async () => {
      const snapshots = markups();
      const css = await compileTokensCss(snapshots.flatMap(classesOf));
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme });
            try {
              const p = await ctx.newPage();
              await p.setContent(page(css, snapshots[0] as string));
              let prev = await measure(p);
              const at = `${engine} ${colorScheme}`;
              if (prev.rows.length !== 1 || prev.planTop === null) {
                problems.push(`${at} 처음 장면이 서지 않았다: 줄 ${prev.rows.length}, 계획 ${prev.planTop}`);
              }
              for (const [index, html] of snapshots.entries()) {
                if (index === 0) continue;
                const name = (STEPS[index] as Step).name;
                await p.evaluate((next) => {
                  document.getElementById("slot")!.innerHTML = next;
                }, html);
                const g = await measure(p);
                // 1) 칸 머리와 계획 블록(줄 위)은 줄이 붙는 동안 움직이지 않는다.
                if (Math.abs(g.headTop - prev.headTop) > 0.01) problems.push(`${at} 「${name}」: 칸 머리가 움직였다`);
                if (g.planTop !== prev.planTop || g.planHeight !== prev.planHeight) {
                  problems.push(`${at} 「${name}」: 계획 블록이 움직였다(${prev.planTop}→${g.planTop}, 높이 ${prev.planHeight}→${g.planHeight})`);
                }
                // 2) 앞 장면에도 있던 줄은 위치가 그대로다(위 행 y 이동 0). 이 장면에서 사라진 줄은 맨 아래 줄뿐이다.
                const now = new Map(g.rows.map((row) => [row.id, row]));
                for (const before of prev.rows) {
                  const same = now.get(before.id);
                  if (same === undefined) {
                    if (before.id !== (prev.rows.at(-1) as { id: string }).id) problems.push(`${at} 「${name}」: 중간 줄 ${before.id}이 사라졌다`);
                    continue;
                  }
                  if (Math.abs(same.top - before.top) > 0.01) problems.push(`${at} 「${name}」: ${before.id}이 ${same.top - before.top}px 움직였다`);
                  if (Math.abs(same.height - before.height) > 0.01) problems.push(`${at} 「${name}」: ${before.id}의 높이가 ${before.height}→${same.height}로 바뀌었다`);
                }
                // 3) 합계는 마지막 줄 **아래**다(줄 위에 있었다면 줄이 밀렸을 것이다).
                if (g.footerTop !== null && g.lastRowBottom !== null && g.footerTop < g.lastRowBottom - 0.01) {
                  problems.push(`${at} 「${name}」: 합계(${g.footerTop})가 마지막 줄 바닥(${g.lastRowBottom})보다 위다`);
                }
                prev = g;
              }
              // 줄은 시간순(오래된 것이 위)이고 새 줄은 맨 아래에 붙는다.
              const order = prev.rows.map((row) => row.id);
              if (order.join() !== ["agent|activity|r1", "agent|activity|e1", "agent|activity|c1", "agent|activity|f1", "agent|activity|r2"].join()) {
                problems.push(`${at} 줄 순서가 시간순이 아니다: ${order.join(", ")}`);
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
    180_000
  );

  it.skipIf(ENGINES.length === 0)(
    "모션: 새 줄은 불투명도만 240ms(이동 없음)이고 도착한 줄만이며, 상태 칩은 120ms로 바뀌고, 움직이는 점은 하나이며, 동작 줄이기에서는 전부 0ms·정지다",
    async () => {
      const snapshots = markups();
      const css = await compileTokensCss(snapshots.flatMap(classesOf));
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const reducedMotion of ["no-preference", "reduce"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, reducedMotion });
            try {
              const p = await ctx.newPage();
              // 둘째 장면: 새 줄(e1)이 막 도착한 마크업.
              await p.setContent(page(css, snapshots[1] as string));
              const at = `${engine} ${reducedMotion}`;
              const g = await p.evaluate(() => {
                const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="work-timeline-row"]')];
                const arrived = rows.filter((li) => li.hasAttribute("data-arrived"));
                const first = rows[0] as HTMLElement;
                const fresh = arrived[0] as HTMLElement | undefined;
                const animation = fresh?.getAnimations().find((a) => (a as CSSAnimation).animationName === "motion-fade-in");
                const frames = animation === undefined ? [] : (animation.effect as KeyframeEffect).getKeyframes();
                const chip = document.querySelector<HTMLElement>('[data-testid="work-timeline-status"]');
                const dots = [...document.querySelectorAll<HTMLElement>('[data-testid="work-timeline-dot"]')];
                return {
                  arrivedCount: arrived.length,
                  firstAnimation: first.getAnimations().length,
                  arrivedDuration: fresh === undefined ? null : getComputedStyle(fresh).animationDuration,
                  timing: animation === undefined ? null : (animation.effect as KeyframeEffect).getComputedTiming().duration,
                  keyframeProps: [...new Set(frames.flatMap((frame) => Object.keys(frame)))].filter(
                    (key) => !["offset", "computedOffset", "easing", "composite"].includes(key)
                  ),
                  chipTransition: chip === null ? null : getComputedStyle(chip).transitionDuration,
                  dotCount: dots.length,
                  dotAnimations: dots.map((dot) => getComputedStyle(dot).animationName),
                  running: document
                    .getAnimations()
                    .filter((a) => (a as CSSAnimation).animationName === "momo-responding").length,
                };
              });
              if (g.arrivedCount !== 1) problems.push(`${at} 도착 표지가 ${g.arrivedCount}개다(새 줄 하나뿐이어야 한다)`);
              if (g.firstAnimation !== 0) problems.push(`${at} 처음부터 있던 줄에 전환이 걸렸다(${g.firstAnimation})`);
              if (g.dotCount !== 1) problems.push(`${at} 점이 ${g.dotCount}개다`);
              if (reducedMotion === "no-preference") {
                if (g.timing !== 240) problems.push(`${at} 새 줄의 길이 ${g.timing}ms, 기대 240`);
                if (g.keyframeProps.join() !== "opacity") problems.push(`${at} 새 줄의 키프레임이 불투명도만이 아니다: ${g.keyframeProps.join()}`);
                if (g.chipTransition !== "0.12s") problems.push(`${at} 상태 칩의 전환 ${g.chipTransition}, 기대 0.12s`);
                if (g.dotAnimations.join() !== "momo-responding" || g.running !== 1) {
                  problems.push(`${at} 움직이는 점이 하나가 아니다: ${g.dotAnimations.join()} / 실행 중 ${g.running}`);
                }
              } else {
                if (g.arrivedDuration !== "0s") problems.push(`${at} 동작 줄이기에서 새 줄의 길이 ${g.arrivedDuration}, 기대 0s`);
                if (g.chipTransition !== "0s") problems.push(`${at} 동작 줄이기에서 상태 칩의 전환 ${g.chipTransition}, 기대 0s`);
                if (g.dotAnimations.join() !== "none" || g.running !== 0) {
                  problems.push(`${at} 동작 줄이기에서 점이 움직인다: ${g.dotAnimations.join()} / 실행 중 ${g.running}`);
                }
              }
              // 새 줄이 전환되는 동안에도(0ms·중간·끝) 위치는 같다: 이동 키프레임이 없다는 것을 실제 좌표로도 확인한다.
              if (reducedMotion === "no-preference") {
                const top = () =>
                  p.evaluate(() => {
                    const li = document.querySelector<HTMLElement>('[data-testid="work-timeline-row"][data-arrived]');
                    return li === null ? null : li.getBoundingClientRect().top;
                  });
                const t0 = await top();
                await p.waitForTimeout(120);
                const mid = await top();
                await p.waitForTimeout(300);
                const end = await top();
                if (t0 === null || t0 !== mid || mid !== end) problems.push(`${at} 새 줄의 y가 전환 중에 변했다(${t0}, ${mid}, ${end})`);
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
    180_000
  );
});
