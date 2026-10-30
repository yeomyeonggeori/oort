// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunProgress, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { UNCOLLECTED_AFTER_MS, UNCOLLECTED_WORD } from "@momo/core/features/agents/runWaiting";
import {
  TRIGGER_CHIP_FACES,
  TRIGGER_CHIP_KINDS,
  triggerChip,
  type AnswerRef,
  type TriggerChipKind,
} from "@momo/core/features/agents/triggerChip";
import {
  GutterTriggerChip,
  MessageTriggerChip,
  ThreadWorkChip,
  TriggerChipView,
} from "./TriggerChip";
import { TRIGGER_CHIP_TONE_CLASS } from "./triggerChipClasses";

// =============================================================================
// 트리거 메시지의 칩 (#4619 B)과 스레드 요약 줄의 「작업 중」 칩 (E). 칩이 낱말을 갈아 끼워도 폭이 변하지 않는
// 구조(모든 낱말을 같은 칸에 겹친다), 「답함 ✓」만 눌리는 단추라는 것, 「받음」이 유예 마감에 한 번만 다시
// 그려진다는 것을 잰다. 칩의 **픽셀** 크기는 jsdom이 잴 수 없어 `TriggerChip.browser.test.tsx`가 잰다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const TRIGGER = "00000000-0000-7000-8000-0000000a0001";
const SEC = 1000;
const MIN = 60 * SEC;
/** 이 파일의 시계. 가짜 타이머가 여기서 시작하므로 컴포넌트의 `Date.now()`와 시험의 `now`가 같은 시계다. */
const T0 = new Date("2026-10-27T03:00:00Z").getTime();

const bot = {
  id: AGENT,
  workspaceId: WS,
  kind: "agent",
  status: "active",
  displayName: "달무리봇",
  handle: "dalmuri-bot",
  channelCount: 1,
  channelIds: [CH],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
} as RosterMember;
const directory = makeDirectory([bot]);
const nameFor = () => ({ name: "달무리봇" });

let counter = 0;
function run(now: number, extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  counter += 1;
  return {
    id: `0199aa11-2222-7000-8000-${String(counter).padStart(12, "0")}`,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: TRIGGER,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: now - 20 * SEC,
    updatedAtMs: now - 20 * SEC,
    ...extra,
  };
}

const RUNNING = (now: number) =>
  ({ phase: "running", status: "running", leaseState: "live", startedAtMs: now - MIN }) as const;
const DONE = (now: number) =>
  ({ phase: "succeeded", status: "succeeded", finishedAtMs: now - SEC }) as const;
const FAILED = (now: number) =>
  ({ phase: "failed", status: "failed", endReason: "agent_error", finishedAtMs: now - SEC }) as const;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}
function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  if (root) unmount();
  vi.useRealTimers();
});

describe("칩의 그림", () => {
  const now = T0;
  const chipOf = (extra: Partial<AgentRunProgress>, at = now) =>
    triggerChip([run(now, extra)], nameFor, at)!;

  it("낱말과 표지: 점(작업 중) · 체크(답함) · 느낌표(아직 받지 않았어요) · 시계(시간 초과·신호 소실) · 가위표(실패) · 표지 없음(받음·가져감·승인 필요)", () => {
    const cases: [Partial<AgentRunProgress>, number, string, "dot" | "check" | "alert" | "clock" | "cross" | "none"][] = [
      [{}, now, "받음", "none"],
      [{ phase: "claimed", leaseState: "live" }, now, "가져감", "none"],
      [RUNNING(now), now, "작업 중", "dot"],
      [{ phase: "awaiting_approval", status: "awaiting_approval" }, now, "승인 필요", "none"],
      [DONE(now), now, "답함", "check"],
      [{}, now + 10 * MIN, UNCOLLECTED_WORD, "alert"],
      [{ phase: "timed_out", status: "timed_out" }, now, "시간 초과", "clock"],
      [{ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" }, now, "신호 소실", "clock"],
      [FAILED(now), now, "실패", "cross"],
    ];
    for (const [extra, at, word, mark] of cases) {
      const el = render(createElement(TriggerChipView, { chip: chipOf(extra, at) }));
      const visible = q(el, "trigger-chip-word");
      expect(visible?.textContent, word).toBe(word);
      // 보이는 낱말 쪽의 표지만 센다(유령 낱말들도 자기 표지를 안고 있다).
      expect(visible?.querySelectorAll("svg").length, `${word} 표지`).toBe(
        mark === "check" || mark === "alert" || mark === "clock" || mark === "cross" ? 1 : 0
      );
      // 아직 받지 않았어요(주의)와 실패(오류)는 같은 모양이 아니다: 색을 못 보는 사람에게 둘이 같은 말이 되지 않게.
      if (mark === "alert") expect(visible?.querySelector("svg")?.getAttribute("class")).toContain("circle-alert");
      if (mark === "clock") expect(visible?.querySelector("svg")?.getAttribute("class")).toContain("lucide-clock");
      if (mark === "cross") expect(visible?.querySelector("svg")?.getAttribute("class")).toContain("circle-x");
      expect(visible?.querySelector(".size-1.rounded-full") !== null, `${word} 점`).toBe(mark === "dot");
      unmount();
    }
  });

  it("서버가 일을 끝내지 못한 것(시간 초과·신호 소실)은 경고 톤이고 위험 톤은 서버가 failed로 끝낸 것에만 쓴다 (ADR-0132, design-review r1 H2)", () => {
    const toneOf = (extra: Partial<AgentRunProgress>) => chipOf(extra).tone;
    expect(toneOf({ phase: "timed_out", status: "timed_out" })).toBe("warn");
    expect(toneOf({ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" })).toBe("warn");
    expect(toneOf(FAILED(now))).toBe("danger");
    expect(TRIGGER_CHIP_TONE_CLASS.warn).toContain("text-warn");
    expect(TRIGGER_CHIP_TONE_CLASS.danger).toContain("text-danger");
    // 접근성 이름도 「실패」라 읽지 않는다.
    expect(chipOf({ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" }).label).toBe(
      "달무리봇 에이전트의 실행이 신호 소실로 끝났어요."
    );
    expect(chipOf({ phase: "timed_out", status: "timed_out" }).label).toBe(
      "달무리봇 에이전트의 실행이 시간 초과로 끝났어요."
    );
  });

  it("폭을 가장 넓은 낱말에 맞춘다: 지금 낱말 말고 가능한 모든 (낱말, 표지)가 겹쳐 있고 보이지 않으며 읽히지 않는다", () => {
    const el = render(createElement(TriggerChipView, { chip: chipOf(RUNNING(now)) }));
    const ghosts = [...el.querySelectorAll('[data-testid="trigger-chip-ghost"]')];
    expect(ghosts).toHaveLength(TRIGGER_CHIP_FACES.length - 1);
    for (const ghost of ghosts) {
      expect(ghost.className).toContain("invisible");
      expect(ghost.className).toContain("col-start-1 row-start-1");
      expect(ghost.getAttribute("aria-hidden")).toBe("true");
    }
    // 지금 낱말은 유령에 없다(같은 글자가 두 번 보이지 않는다).
    expect(ghosts.some((g) => g.textContent === "작업 중")).toBe(false);
    // 나머지 낱말은 모두 유령으로 있다.
    const ghostWords = new Set(ghosts.map((g) => g.textContent));
    for (const face of TRIGGER_CHIP_FACES) {
      if (face.word === "작업 중") continue;
      expect(ghostWords.has(face.word), face.word).toBe(true);
    }
    // 칩 전체가 한 칸 격자다.
    expect(q(el, "trigger-chip")?.className).toContain("inline-grid");
  });

  it("낱말이 바뀌어도 유령의 집합은 같다(받음 → 작업 중 → 답함)", () => {
    const sets: string[] = [];
    for (const extra of [{}, RUNNING(now), DONE(now)] as Partial<AgentRunProgress>[]) {
      const el = render(createElement(TriggerChipView, { chip: chipOf(extra) }));
      const all = [
        q(el, "trigger-chip-word")?.textContent,
        ...[...el.querySelectorAll('[data-testid="trigger-chip-ghost"]')].map((g) => g.textContent),
      ].sort();
      sets.push(all.join("|"));
      unmount();
    }
    expect(new Set(sets).size).toBe(1);
  });

  it("그릇은 칩 그릇 규칙의 넷뿐이다(muted·ok·warn·danger-soft)", () => {
    const fills = Object.values(TRIGGER_CHIP_TONE_CLASS).flatMap((cls) => cls.match(/\bbg-[a-z-]+/g) ?? []);
    expect(new Set(fills)).toEqual(new Set(["bg-muted-soft", "bg-ok-soft", "bg-warn-soft", "bg-danger-soft"]));
  });

  it("「답함 ✓」은 답을 알 때만 눌리는 단추다. 누르면 답을 넘긴다", () => {
    const answer: AnswerRef = { id: "answer-1", seq: 42 };
    const chip = triggerChip([run(now, DONE(now))], nameFor, now, { answerFor: () => answer })!;
    const jump = vi.fn();
    const el = render(createElement(TriggerChipView, { chip, onJump: jump }));
    const button = q(el, "trigger-chip");
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.getAttribute("aria-label")).toBe("달무리봇 에이전트가 답했어요. 답 메시지로 이동");
    act(() => button?.click());
    expect(jump).toHaveBeenCalledWith(answer);
    unmount();

    // 답을 모르면 같은 칩이 눌리지 않는다(죽은 단추를 세우지 않는다).
    const unknown = triggerChip([run(now, DONE(now))], nameFor, now)!;
    const plain = render(createElement(TriggerChipView, { chip: unknown, onJump: jump }));
    expect(q(plain, "trigger-chip")?.tagName).toBe("SPAN");
    expect(q(plain, "trigger-chip")?.getAttribute("role")).toBe("img");
    expect(q(plain, "trigger-chip")?.getAttribute("aria-label")).toBe("달무리봇 에이전트가 답했어요.");
    unmount();

    // 갈 곳(onJump)이 없어도 단추가 되지 않는다.
    const noHandler = render(createElement(TriggerChipView, { chip }));
    expect(q(noHandler, "trigger-chip")?.tagName).toBe("SPAN");
  });

  it("「답함」이 아닌 칩은 답을 알아도 눌리지 않는다", () => {
    const answer: AnswerRef = { id: "answer-1", seq: 42 };
    const chip = triggerChip([run(now, RUNNING(now))], nameFor, now, { answerFor: () => answer })!;
    const el = render(createElement(TriggerChipView, { chip, onJump: vi.fn() }));
    expect(q(el, "trigger-chip")?.tagName).toBe("SPAN");
  });
});

describe("메시지가 일으킨 run → 칩", () => {
  const now = T0;

  it("run이 없거나 전부 취소면 아무것도 그리지 않는다", () => {
    const empty = render(createElement(MessageTriggerChip, { runs: [], directory }));
    expect(empty.childElementCount).toBe(0);
    unmount();
    const cancelled = render(
      createElement(MessageTriggerChip, {
        runs: [run(now, { phase: "cancelled", status: "cancelled" })],
        directory,
      })
    );
    expect(cancelled.childElementCount).toBe(0);
  });

  it("「답함 ✓」을 누르면 그 run의 답 id와 seq로 onJump를 부른다", () => {
    const done = run(now, DONE(now));
    const jump = vi.fn();
    const el = render(
      createElement(MessageTriggerChip, {
        runs: [done],
        directory,
        runAnswers: new Map([[done.id.toLowerCase(), { id: "answer-1", seq: 42 }]]),
        onJump: jump,
      })
    );
    act(() => q(el, "trigger-chip")?.click());
    expect(jump).toHaveBeenCalledWith("answer-1", 42);
  });

  it("「받음」은 유예 마감에 한 번 다시 그려져 「아직 받지 않았어요」가 된다 — 매초 도는 시계 없이", () => {
    const waiting = run(now, { createdAtMs: now - (UNCOLLECTED_AFTER_MS - 5 * SEC) });
    const el = render(createElement(MessageTriggerChip, { runs: [waiting], directory }));
    expect(q(el, "trigger-chip-word")?.textContent).toBe("받음");
    act(() => {
      vi.advanceTimersByTime(4 * SEC);
    });
    expect(q(el, "trigger-chip-word")?.textContent).toBe("받음");
    act(() => {
      vi.advanceTimersByTime(2 * SEC);
    });
    expect(q(el, "trigger-chip-word")?.textContent).toBe(UNCOLLECTED_WORD);
    expect(q(el, "trigger-chip")?.getAttribute("data-kind")).toBe("uncollected");
  });
});

describe("스레드 요약 줄의 「작업 중」 칩 (E)", () => {
  const now = T0;
  const mount = (extra: Partial<AgentRunProgress>) =>
    render(createElement(ThreadWorkChip, { runs: [run(now, extra)], directory }));

  it("가져감·작업 중일 때만 선다", () => {
    const working = mount(RUNNING(now));
    expect(q(working, "thread-work-chip")).not.toBeNull();
    expect(q(working, "trigger-chip-word")?.textContent).toBe("작업 중");
    unmount();
    const claimed = mount({ phase: "claimed", leaseState: "live" });
    expect(q(claimed, "trigger-chip-word")?.textContent).toBe("가져감");
    unmount();
  });

  it("받음·승인 필요·답함·실패·아직 받지 않았어요에는 서지 않는다(그 말은 머리 줄의 칩이 한다)", () => {
    for (const extra of [
      {},
      { phase: "awaiting_approval", status: "awaiting_approval" },
      DONE(now),
      FAILED(now),
    ] as Partial<AgentRunProgress>[]) {
      const el = mount(extra);
      expect(el.childElementCount, JSON.stringify(extra)).toBe(0);
      unmount();
    }
    // 유예를 넘은 대기(아직 받지 않았어요)도 이 줄의 말이 아니다.
    const stuck = render(
      createElement(ThreadWorkChip, {
        runs: [run(now, { createdAtMs: now - 10 * MIN })],
        directory,
      })
    );
    expect(stuck.childElementCount).toBe(0);
  });

  it("눌리는 것이 아니다", () => {
    const el = mount(RUNNING(now));
    expect(q(el, "trigger-chip")?.tagName).toBe("SPAN");
  });
});

describe("아이콘 칩 (#4619 planner 결정 2·6): 좁은 머리 줄과 이어지는 행의 거터", () => {
  const now = T0;
  const chipOf = (extra: Partial<AgentRunProgress>, at = now) =>
    triggerChip([run(now, extra)], nameFor, at)!;
  const STATES: [string, Partial<AgentRunProgress>, number][] = [
    ["받음", {}, now],
    ["가져감", { phase: "claimed", leaseState: "live" }, now],
    ["작업 중", RUNNING(now), now],
    ["승인 필요", { phase: "awaiting_approval", status: "awaiting_approval" }, now],
    ["답함", DONE(now), now],
    [UNCOLLECTED_WORD, {}, now + 10 * MIN],
    ["시간 초과", { phase: "timed_out", status: "timed_out" }, now],
    ["실패", FAILED(now), now],
  ];
  const glyphOf = (el: ParentNode): string => {
    const svg = q(el, "trigger-chip-mark")?.querySelector("svg");
    return svg?.getAttribute("class") ?? "";
  };

  it("모든 kind는 좁은 머리 줄·거터에서 글리프와 접근성 이름을 갖는다", () => {
    const expected = {
      received: "eye", claimed: "hand", working: "circle-dot",
      approval: "shield-question", answered: "check", uncollected: "circle-alert",
      timed_out: "clock", failed: "circle-x", declined: "ban", expired: "clock",
    } satisfies Record<TriggerChipKind, string>;
    for (const kind of TRIGGER_CHIP_KINDS) {
      for (const variant of ["word", "mark"] as const) {
        const chip = { ...chipOf(RUNNING(now)), kind };
        const el = render(createElement(TriggerChipView, { chip, variant }));
        expect(q(el, "trigger-chip-mark")?.querySelectorAll("svg"), kind).toHaveLength(1);
        expect(glyphOf(el), kind).toContain(`lucide-${expected[kind]}`);
        expect(q(el, "trigger-chip")?.getAttribute("aria-label"), kind).toBe(chip.label);
        unmount();
      }
    }
  });

  it.each([
    ["cancelled", "approval_rejected", "declined", "거부", "ban"],
    ["timed_out", "approval_expired", "expired", "만료", "clock"],
  ] as const)("%s/%s는 낱말·표지·툴팁·접근성 이름에 같은 상태를 말한다", (phase, endReason, kind, word, glyph) => {
    const chip = chipOf({ phase, endReason });
    expect(chip.kind).toBe(kind);
    expect(chip.word).toBe(word);
    expect(chip.label).toContain(word);
    const el = render(createElement(TriggerChipView, { chip }));
    expect(q(el, "trigger-chip-word")?.textContent).toBe(word);
    expect(q(el, "trigger-chip-word")?.querySelector("svg")?.getAttribute("class")).toContain(`lucide-${glyph}`);
    expect(q(el, "trigger-chip-mark")?.getAttribute("title")).toBe(word);
    expect(glyphOf(el)).toContain(`lucide-${glyph}`);
  });

  it("낱말 칩은 아이콘 층을 함께 들고 있고, 좁은 줄(@max-sm)에서만 그 층이 서고 낱말 층이 접힌다", () => {
    const el = render(createElement(TriggerChipView, { chip: chipOf(RUNNING(now)) }));
    const mark = q(el, "trigger-chip-mark");
    expect(mark).not.toBeNull();
    // 넓은 줄에서는 숨고(hidden) 좁은 줄에서만 선다(@max-sm:inline-flex).
    expect(mark?.className).toContain("hidden");
    expect(mark?.className).toContain("@max-sm:inline-grid");
    // 낱말 층은 좁은 줄에서 접힌다.
    expect(q(el, "trigger-chip-word")?.parentElement?.className).toContain("@max-sm:hidden");
    // 아이콘 층은 보조기술에 나가지 않는다: 이름은 칩의 aria-label이 나른다.
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(q(el, "trigger-chip")?.getAttribute("aria-label")).toBe("달무리봇 에이전트가 작업 중이에요.");
    // 낱말은 툴팁으로 남는다.
    expect(mark?.getAttribute("title")).toBe("작업 중");
  });

  it("여덟 상태가 아이콘 모양만으로 갈린다(글자 없이)", () => {
    const glyphs = new Map<string, string>();
    for (const [name, extra, at] of STATES) {
      const el = render(createElement(TriggerChipView, { chip: chipOf(extra, at) }));
      glyphs.set(name, glyphOf(el));
      unmount();
    }
    expect(glyphs.get("받음")).toContain("lucide-eye");
    expect(glyphs.get("가져감")).toContain("lucide-hand");
    // 손으로 그린 `<svg>`가 아니라 lucide의 원 안의 점이다(ADR-0172 아이콘 경계, design-review r1 H1).
    expect(glyphs.get("작업 중")).toContain("lucide-circle-dot");
    expect(glyphs.get("승인 필요")).toContain("lucide-shield-question");
    expect(glyphs.get("답함")).toContain("lucide-check");
    expect(glyphs.get(UNCOLLECTED_WORD)).toContain("lucide-circle-alert");
    expect(glyphs.get("시간 초과")).toContain("lucide-clock");
    expect(glyphs.get("실패")).toContain("lucide-circle-x");
    expect(new Set(glyphs.values()).size).toBe(STATES.length);
  });

  it("variant=mark: 아이콘 층만 있고 낱말 층도 유령도 없으며, 답을 알아도 눌리지 않는다", () => {
    const answer: AnswerRef = { id: "answer-1", seq: 42 };
    const chip = triggerChip([run(now, DONE(now))], nameFor, now, { answerFor: () => answer })!;
    const jump = vi.fn();
    const el = render(createElement(TriggerChipView, { chip, onJump: jump, variant: "mark" }));
    expect(q(el, "trigger-chip")?.tagName).toBe("SPAN");
    expect(q(el, "trigger-chip")?.getAttribute("role")).toBe("img");
    expect(q(el, "trigger-chip-word")).toBeNull();
    expect(el.querySelectorAll('[data-testid="trigger-chip-ghost"]')).toHaveLength(0);
    expect(q(el, "trigger-chip-mark")?.className).toContain("inline-grid");
    expect(q(el, "trigger-chip-mark")?.className).not.toContain("hidden");
    act(() => q(el, "trigger-chip")?.click());
    expect(jump).not.toHaveBeenCalled();
  });

  it("아이콘 층의 높이는 낱말 칩과 같다: 폭 0으로 접은 낱말이 줄 상자를 지킨다(글자 없는 칩이 낮아지지 않는다)", () => {
    const el = render(createElement(TriggerChipView, { chip: chipOf(RUNNING(now)), variant: "mark" }));
    const keeper = q(el, "trigger-chip-mark-height");
    expect(keeper?.textContent).toBe("작업 중");
    expect(keeper?.className).toContain("w-0");
    expect(keeper?.className).toContain("overflow-hidden");
  });

  it("reserve=false: 폭을 고정하지 않는다(스레드 요약 줄의 칩)", () => {
    const el = render(createElement(TriggerChipView, { chip: chipOf(RUNNING(now)), reserve: false }));
    expect(el.querySelectorAll('[data-testid="trigger-chip-ghost"]')).toHaveLength(0);
    unmount();
    const thread = render(createElement(ThreadWorkChip, { runs: [run(now, RUNNING(now))], directory }));
    expect(thread.querySelectorAll('[data-testid="trigger-chip-ghost"]')).toHaveLength(0);
  });

  it("거터 칩: 이어지는 행의 시각 칸에 absolute로 서고(행 높이 불변), 행 hover·포커스에서는 시각에 자리를 내준다", () => {
    const el = render(createElement(GutterTriggerChip, { runs: [run(now, RUNNING(now))], directory }));
    const wrap = el.querySelector<HTMLElement>("[data-row-chip]");
    expect(wrap).not.toBeNull();
    for (const cls of ["absolute", "right-0", "group-hover:opacity-0", "group-focus-within:opacity-0", "motion-reduce:transition-none"]) {
      expect(wrap?.className, cls).toContain(cls);
    }
    expect(q(el, "trigger-chip")?.getAttribute("data-variant")).toBe("mark");
    expect(q(el, "trigger-chip")?.getAttribute("data-kind")).toBe("working");
    unmount();

    // run이 없거나 전부 취소면 아무것도 그리지 않는다.
    const empty = render(createElement(GutterTriggerChip, { runs: [], directory }));
    expect(empty.childElementCount).toBe(0);
  });

  it("hover가 없는 기기에서는 거터 칩을 세우지 않는다(그 자리는 늘 서 있는 시각의 것이다)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/design/tokens.css"), "utf8");
    expect(css).toMatch(/@media \(hover: none\)\s*\{[^}]*\[data-row-clock\][^}]*\}[^}]*\[data-row-chip\]\s*\{\s*display:\s*none;/s);
  });
});
