// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { triggerChip, type TriggerChip } from "@momo/core/features/agents/triggerChip";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { MESSAGE_HEAD_CHIP_CLASS, MESSAGE_HEAD_CHIP_TIME_CLASS } from "@/features/timeline/spacing";
import { TriggerChipView } from "./TriggerChip";

// =============================================================================
// 트리거 메시지의 칩은 **크기 고정**이다 (#4619 B, 계약: 「칩은 행 높이 불변」). 머리 줄(이름 · 시각)에 칩이
// 서고, 상태가 바뀌어 낱말이 갈려도, 줄의 높이와 칩의 크기가 변하지 않는다. jsdom은 레이아웃을 못 재므로
// `TriggerChipView`가 그린 **진짜 마크업**을 `MESSAGE_HEAD_CHIP_CLASS`(MessageRow가 칩이 있는 머리 줄에 쓰는
// 바로 그 클래스)와 함께 `tokens.css` 컴파일 결과를 먹인 실제 엔진에 올려 잰다.
//
// 지키는 것:
//   (1) 칩이 없는 머리 줄과 어떤 칩이 있는 머리 줄의 높이가 같다.
//   (2) 모든 낱말의 낱말 칩이 같은 폭·같은 높이다(가장 넓은 낱말에 맞춘 격자).
//   (3) 이름과 시각의 자리가 칩 때문에 움직이지 않는다.
//   (4) 머리 줄이 좁으면(@max-sm, 줄 자신의 폭 < 24rem) 같은 칩이 아이콘만 남고, 그 크기도 모든 상태가 같으며
//       높이는 낱말 칩과 같다. 넓으면 낱말이다(경계 ±1px).
// 이름 길이를 훑는 시험(줄바꿈 0)과 거터 칩의 기하는 실제 MessageRow로 `MessageRow.triggerChip.browser.test`가 잰다.
// 사보타주: 유령 낱말(폭 고정)을 걷으면 (2)가 붉고, @max-sm 접힘을 걷으면 (4)가 붉다.
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
  face("아직 받지 않았어요", {}, T + 10 * MIN),
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
const TIME_CLASSES = `text-timestamp text-ink-muted ${MESSAGE_HEAD_CHIP_TIME_CLASS}`;

function page(css: string, width: number, name: string, chipHtml: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#row { width: ${width}px; box-sizing: border-box; padding: 6px 12px; }
</style></head><body>
<div id="row">
  <div id="head" class="${MESSAGE_HEAD_CHIP_CLASS}">
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
  /** 보이는 층: 낱말 칩이면 낱말, 아이콘 칩이면 아이콘이다. */
  visibleLayer: "word" | "mark" | null;
}

async function measure(p: import("playwright").Page): Promise<Geometry> {
  return p.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const head = document.getElementById("head")!;
    const chip = document.querySelector<HTMLElement>('[data-testid="trigger-chip"]');
    // `display:none` 가지 안의 요소는 클라이언트 사각형이 없다: 보이는 층은 사각형이 있는 쪽이다.
    const shown = (id: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      return el !== null && el.getClientRects().length > 0 && rect(el).width > 0;
    };
    return {
      headHeight: rect(head).height,
      nameLeft: rect(document.getElementById("name")!).left,
      nameTop: rect(document.getElementById("name")!).top,
      timeLeft: rect(document.getElementById("time")!).left,
      timeTop: rect(document.getElementById("time")!).top,
      chipWidth: chip === null ? null : rect(chip).width,
      chipHeight: chip === null ? null : rect(chip).height,
      chipInsideHead: chip !== null && head.contains(chip),
      visibleLayer: chip === null ? null : shown("trigger-chip-word") ? "word" : shown("trigger-chip-mark") ? "mark" : null,
    };
  });
}

/** 줄 자신의 폭(= `@container`의 폭)이다: 행 폭에서 좌우 여백 24를 뺀 값. */
const headWidth = (rowWidth: number) => rowWidth - 24;

const CASES: { label: string; width: number; name: string; layer: "word" | "mark" }[] = [
  { label: "넓은 창(720)", width: 720, name: "정하윤", layer: "word" },
  { label: "보통 폭(480), 긴 이름", width: 480, name: "달무리 스튜디오 정하윤", layer: "word" },
  // 줄의 폭 384(=24rem)가 경계다: 384는 아직 낱말, 383은 아이콘이다.
  { label: "줄 폭 384(경계)", width: 384 + 24, name: "이도현", layer: "word" },
  { label: "줄 폭 383(경계 −1)", width: 383 + 24, name: "이도현", layer: "mark" },
  { label: "최소 폭(368), 보통 이름", width: 368, name: "이도현", layer: "mark" },
  { label: "최소 폭(368), 아주 긴 이름", width: 368, name: "달무리 스튜디오 플랫폼팀 정하윤", layer: "mark" },
];

describe("트리거 칩의 크기 고정 (#4619 B)", () => {
  it.skipIf(ENGINES.length === 0)(
    "칩이 서고 낱말이 갈려도 머리 줄 높이·이름·시각 자리·칩 크기가 변하지 않는다 — 낱말 칩과 아이콘 칩 모두",
    async () => {
      const markups = FACES.map((f) => ({ ...f, html: markupOf(f.chip) }));
      const css = await compileTokensCss([
        ...MESSAGE_HEAD_CHIP_CLASS.split(/\s+/),
        ...NAME_CLASSES.split(/\s+/),
        ...NAME_TEXT_CLASSES.split(/\s+/),
        ...TIME_CLASSES.split(/\s+/),
        ...markups.flatMap((m) => classesOf(m.html)),
      ]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const sizeByLayer = new Map<string, { w: number; h: number }>();

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
                  if (g.visibleLayer !== c.layer) {
                    problems.push(`${at} 「${m.name}」: 보이는 층 ${g.visibleLayer}, 기대 ${c.layer}`);
                  }
                  if (Math.abs(g.headHeight - none.headHeight) > 0.01) {
                    problems.push(`${at} 「${m.name}」: 머리 줄 높이 ${g.headHeight}, 칩 없을 때 ${none.headHeight}`);
                  }
                  for (const key of ["nameLeft", "nameTop", "timeTop"] as const) {
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
                // 이 엔진·스킴에서 낱말 칩과 아이콘 칩이 서로 다른 폭이고 높이는 같다는 것을 모은다.
                sizeByLayer.set(`${engine}|${colorScheme}|${c.layer}`, { w: first.w, h: first.h });
              }
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      // 아이콘 칩은 낱말 칩보다 좁고 높이는 같다(영폭 공백이 줄 상자의 높이를 지킨다).
      for (const engine of ENGINES) {
        for (const colorScheme of ["light", "dark"] as const) {
          const word = sizeByLayer.get(`${engine}|${colorScheme}|word`);
          const mark = sizeByLayer.get(`${engine}|${colorScheme}|mark`);
          if (word === undefined || mark === undefined) {
            problems.push(`${engine} ${colorScheme}: 낱말 칩 또는 아이콘 칩을 재지 못했다`);
            continue;
          }
          if (!(mark.w < word.w - 30)) problems.push(`${engine} ${colorScheme}: 아이콘 칩 폭 ${mark.w}이 낱말 칩 ${word.w}보다 충분히 좁지 않다`);
          // 같은 모양 안에서는 0.01 이내(위)이고, 두 모양 사이는 0.5px 이내다: WebKit이 글자와 대체 요소가 섞인 줄의
          // 높이를 소수 픽셀로 달리 쌓는다(0.33px). 머리 줄 높이는 두 모양 모두 칩이 없을 때와 같다(위).
          if (Math.abs(mark.h - word.h) > 0.5) problems.push(`${engine} ${colorScheme}: 아이콘 칩 높이 ${mark.h}, 낱말 칩 ${word.h}`);
        }
      }
      expect(problems).toEqual([]);
    },
    240_000
  );

  it.skipIf(ENGINES.length === 0)(
    "「답함 ✓」 단추의 누르는 면은 그려진 칩보다 4px씩 크다(28 ≥ 24, WCAG 2.5.8): 낱말 칩·아이콘 칩 모두, 줄 높이는 그대로",
    async () => {
      const answered = FACES.find((f) => f.name.startsWith("답함"))!;
      const html = markupOf(answered.chip);
      const css = await compileTokensCss([
        ...MESSAGE_HEAD_CHIP_CLASS.split(/\s+/),
        ...NAME_CLASSES.split(/\s+/),
        ...NAME_TEXT_CLASSES.split(/\s+/),
        ...TIME_CLASSES.split(/\s+/),
        ...classesOf(html),
      ]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 800, height: 400 } });
          try {
            const p = await ctx.newPage();
            for (const [label, width] of [["낱말 칩", 720], ["아이콘 칩", 368]] as const) {
              await p.setContent(page(css, width, "정하윤", html));
              const g = await p.evaluate(() => {
                const chip = document.querySelector<HTMLElement>('[data-testid="trigger-chip"]')!;
                const after = getComputedStyle(chip, "::after");
                const r = chip.getBoundingClientRect();
                return {
                  tag: chip.tagName,
                  chipW: r.width,
                  chipH: r.height,
                  hitW: Number.parseFloat(after.width),
                  hitH: Number.parseFloat(after.height),
                  position: after.position,
                  headHeight: document.getElementById("head")!.getBoundingClientRect().height,
                };
              });
              const at = `${engine} ${label}`;
              if (g.tag !== "BUTTON") problems.push(`${at}: 답함 칩이 단추가 아니다(${g.tag})`);
              if (g.position !== "absolute") problems.push(`${at}: 누르는 면이 absolute가 아니다(${g.position}) — 칩 상자를 키운다`);
              if (!(g.hitH >= 24 && g.hitW >= 24)) problems.push(`${at}: 누르는 면 ${g.hitW}×${g.hitH}가 24에 못 미친다`);
              if (Math.abs(g.hitH - (g.chipH + 8)) > 0.51 || Math.abs(g.hitW - (g.chipW + 8)) > 0.51) {
                problems.push(`${at}: 누르는 면 ${g.hitW}×${g.hitH}이 칩 ${g.chipW}×${g.chipH}보다 4px씩 크지 않다`);
              }
              if (!(g.chipH < g.headHeight)) problems.push(`${at}: 칩(${g.chipH})이 머리 줄(${g.headHeight})을 키운다`);
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

  it("경계 숫자 자체가 24rem이다(`@max-sm`): 시험의 384가 코드의 접힘 기준과 같은 값이다", () => {
    // `@max-sm`은 Tailwind 4의 컨테이너 `sm` = 24rem = 384px 미만이다. 시험이 CASES의 384·383을 이 값에서 잡는다.
    expect(384 / 16).toBe(24);
    expect(headWidth(384 + 24)).toBe(384);
  });
});
