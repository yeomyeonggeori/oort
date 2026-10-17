// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunProgress, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import { AgentActivityBar } from "./Composer";

// =============================================================================
// #4020 — 컴포저 위 활동 줄이 에이전트가 가져가 답을 쓰는 동안 「답하는 중」 + 얼굴 + 점을
// 그리고, 대기·승인 대기·끊긴 레일에서는 그리지 않는다. 동작 줄이기에서는 점이 움직이지
// 않는다(애니메이션 클래스가 붙지 않고, CSS도 같은 약속을 한다).
// =============================================================================

const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const T = 1_800_000_000_000;

const member: RosterMember = {
  id: AGENT,
  workspaceId: "w",
  kind: "agent",
  status: "active",
  displayName: "그록",
  handle: "grok",
  channelCount: 0,
  channelIds: [],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
} as RosterMember;
const directory = makeDirectory([member]);

function turn(extra: Partial<AgentRunProgress>) {
  const signal = signalFromProgress({
    id: "0199aa11-2222-7000-8000-0000000000a1",
    channelId: CH,
    agentMemberId: AGENT,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: T,
    updatedAtMs: T,
    ...extra,
  });
  if (signal === null) throw new Error("signal");
  return signal;
}

const RUNNING = { phase: "running", status: "running", leaseState: "live", startedAtMs: T } as const;

let root: Root | null = null;
let host: HTMLElement | null = null;

function reduceMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function mount(turns: ReturnType<typeof turn>[], live = true) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(AgentActivityBar, { turns, directory, nowMs: T + 5_000, live })
    )
  );
  return host;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

describe("컴포저 위 「답하는 중」", () => {
  it("가져가 쓰는 동안: 문장·얼굴·점이 서고, 점은 움직인다", () => {
    reduceMotion(false);
    const el = mount([turn(RUNNING)]);
    expect(el.textContent).toContain("그록이 답하는 중");
    expect(el.querySelector('[data-testid="responding-avatar"]')).not.toBeNull();
    const dots = el.querySelector('[data-testid="responding-dots"]');
    expect(dots?.getAttribute("data-motion")).toBe("full");
    expect([...(dots?.children ?? [])].every((d) => d.classList.contains("responding-dot"))).toBe(true);
    expect(dots?.children).toHaveLength(3);
    // 얼굴·점은 문장 밖의 표지다: 보조기술에는 나가지 않는다.
    expect(el.querySelector('[data-testid="responding-avatar"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(dots?.getAttribute("aria-hidden")).toBe("true");
  });

  it("동작 줄이기에서는 점이 멈춘 채 서고 애니메이션 클래스가 없다", () => {
    reduceMotion(true);
    const el = mount([turn(RUNNING)]);
    const dots = el.querySelector('[data-testid="responding-dots"]');
    expect(dots?.getAttribute("data-motion")).toBe("still");
    expect(dots?.querySelector(".responding-dot")).toBeNull();
    expect(dots?.children).toHaveLength(3);
  });

  it("CSS도 같은 약속을 한다: responding-dot은 reduced-motion에서 animation: none", () => {
    const css = readFileSync(resolve(process.cwd(), "src/design/tokens.css"), "utf8");
    const block = css.slice(css.indexOf("@utility responding-dot"));
    const end = block.indexOf("@keyframes momo-responding");
    const utility = block.slice(0, end);
    expect(utility).toMatch(/animation:\s*momo-responding[^;]*infinite/);
    expect(utility).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*animation:\s*none;/
    );
    // 투명도만 바꾼다: transform·layout을 움직이지 않는다.
    const frames = block.slice(end, block.indexOf("}\n\n", end) + 3);
    expect(frames).not.toMatch(/transform|margin|width|height|top|left/);
  });

  it("아직 아무도 가져가지 않은 대기·승인 대기에는 얼굴도 점도 없다", () => {
    reduceMotion(false);
    for (const extra of [
      { queuePosition: 1 },
      { phase: "awaiting_approval", status: "awaiting_approval" },
    ] as Partial<AgentRunProgress>[]) {
      const el = mount([turn(extra)]);
      expect(el.textContent).not.toContain("답하는 중");
      expect(el.querySelector('[data-testid="responding-avatar"]')).toBeNull();
      expect(el.querySelector('[data-testid="responding-dots"]')).toBeNull();
      act(() => root?.unmount());
      root = null;
      host?.remove();
    }
  });

  it("끊긴 레일에서는 움직임을 두지 않는다(마지막 확인 문장만 남는다)", () => {
    reduceMotion(false);
    const el = mount([turn(RUNNING)], false);
    expect(el.querySelector('[data-testid="responding-dots"]')).toBeNull();
    expect(el.querySelector('[data-testid="responding-avatar"]')).toBeNull();
    expect(el.querySelector('[data-testid="composer-working-stale"]')).not.toBeNull();
  });
});
