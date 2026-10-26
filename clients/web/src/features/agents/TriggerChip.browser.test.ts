// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { triggerChip, type TriggerChip } from "@momo/core/features/agents/triggerChip";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { MESSAGE_HEAD_CLASS } from "@/features/timeline/spacing";
import { TriggerChipView } from "./TriggerChip";

// =============================================================================
// 트리거 메시지의 칩은 **크기 고정**이다 (#4619 B, 계약: 「칩은 행 높이 불변」). 머리 줄(이름 · 시각)에 칩이
// 서고, 상태가 바뀌어 낱말이 갈려도, 줄의 높이와 칩의 크기가 변하지 않는다. jsdom은 레이아웃을 못 재므로
// `TriggerChipView`가 그린 **진짜 마크업**을 `MESSAGE_HEAD_CLASS`(MessageRow가 쓰는 바로 그 줄 클래스)와 함께
// `tokens.css` 컴파일 결과를 먹인 실제 엔진에 올려 잰다.
//
// 지키는 것: (1) 칩이 없는 머리 줄과 어떤 칩이 있는 머리 줄의 높이가 같다. (2) 모든 낱말의 칩이 같은 폭·같은
// 높이다(가장 넓은 낱말에 맞춘 격자). (3) 이름과 시각의 자리가 칩 때문에 움직이지 않는다.
// 사보타주: 유령 낱말(폭 고정)을 걷으면 (2)가 붉다.
// =============================================================================

const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const AGENT = "00000000-0000-7000-8000-000000000301";
const nameFor = () => ({ name: "달무리봇" });

function run(extra: Partial<AgentRunProgress>): AgentRunProgress {
  return {
    id: "0199aa11-2222-7000-8000-0000000000b1",
    channelId: "00000000-0000-7000-8000-000000000201",
    agentMemberId: AGENT,
    triggerMessageId: "00000000-0000-7000-8000-0000000a0001",
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: T - 10 * SEC,
    updatedAtMs: T - 10 * SEC,
    ...extra,
  };
}

interface Face {
  name: string;
  chip: TriggerChip;
}

function face(name: string, extra: Partial<AgentRunProgress>, now = T): Face {
  const chip = triggerChip([run(extra)], nameFor, now, {
    answerFor: () => ({ id: "answer-1", seq: 42 }),
  });
  if (chip === null) throw new Error(`칩이 없다: ${name}`);
  return { name, chip };
}

const FACES: Face[] = [
  face("받음", {}),
  face("가져감", { phase: "claimed", leaseState: "live", claimedAtMs: T }),
  face("작업 중", { phase: "running", status: "running", leaseState: "live", startedAtMs: T - MIN }),
  face("승인 대기", { phase: "awaiting_approval", status: "awaiting_approval" }),
  face("일시 정지", { phase: "paused", status: "paused" }),
  face("답함(눌리는 단추)", { phase: "succeeded", status: "succeeded", finishedAtMs: T - SEC }),
  face("못 가져감", {}, T + 10 * MIN),
  face("실패", { phase: "failed", status: "failed", endReason: "agent_error", finishedAtMs: T - SEC }),
];

function markupOf(chip: TriggerChip): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.render(createElement(TriggerChipView, { chip, onJump: () => undefined })));
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

const NAME_CLASSES = "flex min-w-0 items-baseline gap-1";
const NAME_TEXT_CLASSES = "truncate text-body font-semibold text-ink";
const TIME_CLASSES = "text-timestamp text-ink-muted";

function page(css: string, width: number, name: string, chipHtml: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#row { width: ${width}px; box-sizing: border-box; padding: 6px 12px; }
</style></head><body>
<div id="row">
  <div id="head" class="${MESSAGE_HEAD_CLASS}">
    <span id="name" class="${NAME_CLASSES}"><span class="${NAME_TEXT_CLASSES}">${name}</span></span>
    <time id="time" class="${TIME_CLASSES}" data-numeric>오후 3:07</time>
    ${chipHtml}
  </div>
</div>
</body></html>`;
}

interface Geometry {
  headHeight: number;
  nameLeft: number;
  nameTop: number;
  timeLeft: number;
  timeTop: number;
  chipWidth: number | null;
  chipHeight: number | null;
  chipInsideHead: boolean;
}

async function measure(p: import("playwright").Page): Promise<Geometry> {
  return p.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const head = document.getElementById("head")!;
    const chip = document.querySelector<HTMLElement>('[data-testid="trigger-chip"]');
    return {
      headHeight: rect(head).height,
      nameLeft: rect(document.getElementById("name")!).left,
      nameTop: rect(document.getElementById("name")!).top,
      timeLeft: rect(document.getElementById("time")!).left,
      timeTop: rect(document.getElementById("time")!).top,
      chipWidth: chip === null ? null : rect(chip).width,
      chipHeight: chip === null ? null : rect(chip).height,
      chipInsideHead: chip !== null && head.contains(chip),
    };
  });
}

const CASES: { label: string; width: number; name: string }[] = [
  { label: "넓은 창(720)", width: 720, name: "정하윤" },
  { label: "보통 폭(480), 긴 이름", width: 480, name: "달무리 스튜디오 정하윤" },
  { label: "최소 폭(368), 보통 이름", width: 368, name: "이도현" },
  { label: "최소 폭(368), 아주 긴 이름", width: 368, name: "달무리 스튜디오 플랫폼팀 정하윤" },
];

describe("트리거 칩의 크기 고정 (#4619 B)", () => {
  it.skipIf(ENGINES.length === 0)(
    "칩이 서고 낱말이 갈려도 머리 줄 높이·이름·시각 자리·칩 크기가 변하지 않는다",
    async () => {
      const markups = FACES.map((f) => ({ ...f, html: markupOf(f.chip) }));
      const css = await compileTokensCss([
        ...MESSAGE_HEAD_CLASS.split(/\s+/),
        ...NAME_CLASSES.split(/\s+/),
        ...NAME_TEXT_CLASSES.split(/\s+/),
        ...TIME_CLASSES.split(/\s+/),
        ...markups.flatMap((m) => classesOf(m.html)),
      ]);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 800, height: 400 }, colorScheme });
            try {
              const p = await ctx.newPage();
              for (const c of CASES) {
                const at = `${engine} ${colorScheme} ${c.label}`;
                await p.setContent(page(css, c.width, c.name, ""));
                const none = await measure(p);
                const sizes: { name: string; w: number; h: number }[] = [];
                for (const m of markups) {
                  await p.setContent(page(css, c.width, c.name, m.html));
                  const g = await measure(p);
                  if (!g.chipInsideHead) problems.push(`${at} 「${m.name}」: 칩이 머리 줄 안에 없다`);
                  if (Math.abs(g.headHeight - none.headHeight) > 0.01) {
                    problems.push(`${at} 「${m.name}」: 머리 줄 높이 ${g.headHeight}, 칩 없을 때 ${none.headHeight}`);
                  }
                  for (const key of ["nameLeft", "nameTop", "timeLeft", "timeTop"] as const) {
                    if (Math.abs(g[key] - none[key]) > 0.01) {
                      problems.push(`${at} 「${m.name}」: ${key} 이 ${g[key] - none[key]}px 움직였다`);
                    }
                  }
                  if (g.chipWidth !== null && g.chipHeight !== null) {
                    sizes.push({ name: m.name, w: g.chipWidth, h: g.chipHeight });
                  }
                }
                const first = sizes[0]!;
                for (const s of sizes) {
                  if (Math.abs(s.w - first.w) > 0.01) {
                    problems.push(`${at}: 「${s.name}」 칩 폭 ${s.w}, 「${first.name}」 ${first.w}`);
                  }
                  if (Math.abs(s.h - first.h) > 0.01) {
                    problems.push(`${at}: 「${s.name}」 칩 높이 ${s.h}, 「${first.name}」 ${first.h}`);
                  }
                }
                // 칩은 머리 줄의 한 줄 안에 들어간다: 줄 높이보다 높지 않다.
                if (!(first.h < none.headHeight)) {
                  problems.push(`${at}: 칩 높이 ${first.h}가 머리 줄 높이 ${none.headHeight}보다 작지 않다`);
                }
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

  /**
   * 이름 길이를 훑어 최소 폭(368)에서 칩 때문에 머리 줄이 늘어나는 길이를 찾는다. 가장 넓은 칩(「못 가져감」)이
   * 가장 나쁜 경우다. 이름이 시각까지는 한 줄에 들어가는데 칩이 붙으면 넘치는 길이에서, 칩이 혼자 다음 줄로
   * 내려가 줄이 늘어난다(머리 줄이 `flex-wrap`이라 이름이 줄어드는 대신 칩이 내려간다).
   */
  async function sweep(from: number, to: number): Promise<string[]> {
    const widest = markupOf(FACES.find((f) => f.name === "못 가져감")!.chip);
    const css = await compileTokensCss([
      ...MESSAGE_HEAD_CLASS.split(/\s+/),
      ...NAME_CLASSES.split(/\s+/),
      ...NAME_TEXT_CLASSES.split(/\s+/),
      ...TIME_CLASSES.split(/\s+/),
      ...classesOf(widest),
    ]);
    const playwright = await import("playwright");
    const problems: string[] = [];
    for (const engine of ENGINES) {
      const browser = await playwright[engine].launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 800, height: 400 } });
        try {
          const p = await ctx.newPage();
          for (let length = from; length <= to; length += 1) {
            const name = "가나다라마바사아자차카타파하".repeat(3).slice(0, length);
            await p.setContent(page(css, 368, name, ""));
            const none = await measure(p);
            await p.setContent(page(css, 368, name, widest));
            const g = await measure(p);
            if (Math.abs(g.headHeight - none.headHeight) > 0.01) {
              problems.push(`${engine} 이름 ${length}자: 머리 줄 ${none.headHeight} -> ${g.headHeight}`);
            }
          }
        } finally {
          await ctx.close();
        }
      } finally {
        await browser.close();
      }
    }
    return problems;
  }

  it.skipIf(ENGINES.length === 0)(
    "이름이 2자부터 16자까지면 최소 폭에서도 칩 때문에 머리 줄이 늘어나지 않는다",
    async () => {
      expect(await sweep(2, 16)).toEqual([]);
    },
    180_000
  );

  // 알려진 한계(#4619의 미결 결정): 이름이 17자 이상이고 창이 최소 폭(368)이면 칩이 혼자 다음 줄로 내려가 머리 줄이
  // 늘어난다. 머리 줄을 `flex-nowrap`으로 바꾸고 이름이 `truncate`되게 하면 사라지지만 모든 행의 머리 줄을 바꾸는
  // 일이라 이 이슈의 범위 밖이다. `it.fails`는 이 한계가 고쳐지는 날 **붉어져서** 이 줄을 지우라고 알린다.
  it.fails(
    "[알려진 한계] 이름이 17자 이상이고 최소 폭(368)이면 칩이 다음 줄로 내려간다",
    async () => {
      if (ENGINES.length === 0) throw new Error("엔진이 없어 한계를 재지 못했다(it.fails가 통과로 처리한다)");
      expect(await sweep(17, 22)).toEqual([]);
    },
    180_000
  );
});
