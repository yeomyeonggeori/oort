// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
} from "@/design/motion";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  WELCOME_BACKSTOP_AFTER,
  WELCOME_BACKSTOP_BEFORE,
  WELCOME_BACKSTOP_HREF,
  WELCOME_BACKSTOP_LINK_LABEL,
  WELCOME_BACKSTOP_TITLE,
  WELCOME_BAND_JOY_COPY,
  WELCOME_BAND_JOY_HOLD_MS,
  WELCOME_BAND_SLEEPY_COPY,
  type WelcomeBandSpeaker,
} from "./welcomeKickoff";
import { AGENTS_NAV } from "@/features/sidebar/workspaceNav";
import { WelcomeKickoffStage } from "./WelcomeKickoffStage";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  vi.useRealTimers();
});

const AWAKE: WelcomeBandSpeaker = { name: "hermes", sleepy: false };

function render(props: {
  phase: "stage" | "exiting" | "backstop";
  reducedMotion: boolean;
  speaker?: WelcomeBandSpeaker;
  onExitComplete?: () => void;
}) {
  mountedRoot?.render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/c/general"] },
      createElement(WelcomeKickoffStage, {
        phase: props.phase,
        reducedMotion: props.reducedMotion,
        speaker: props.speaker ?? AWAKE,
        onExitComplete: props.onExitComplete ?? (() => undefined),
      })
    )
  );
}

function mount(props: Parameters<typeof render>[0]): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => render(props));
  return host;
}

function band(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    "[data-testid='welcome-kickoff-stage'], [data-testid='welcome-kickoff-backstop']"
  );
}

function face(root: HTMLElement): string | null {
  return root.querySelector("[data-testid='kometto-face']")?.getAttribute("data-expression") ?? null;
}

describe("WelcomeKickoffStage (첫 대화 코메토 띠, #2817)", () => {
  it("stage: working face + 「{name}가 인사하러 오고 있어요.」, band size, status line, no progress dots", () => {
    const root = mount({ phase: "stage", reducedMotion: false });
    expect(band(root)?.getAttribute("data-state")).toBe("working");
    expect(face(root)).toBe("working");
    expect(root.querySelector("[data-testid='kometto-face']")?.getAttribute("data-size")).toBe(
      "band"
    );
    expect(root.querySelector("[role='status']")?.textContent).toBe(
      "hermes가 인사하러 오고 있어요."
    );
    expect(root.querySelector("[data-testid='onboarding-dots']")).toBeNull();
    expect(band(root)?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(false);
  });

  it("consonant-final name takes 이; unknown speaker reads 에이전트가", () => {
    const named = mount({
      phase: "stage",
      reducedMotion: false,
      speaker: { name: "김인턴", sleepy: false },
    });
    expect(named.textContent).toContain("김인턴이 인사하러 오고 있어요.");
    act(() =>
      render({ phase: "stage", reducedMotion: false, speaker: { name: null, sleepy: false } })
    );
    expect(named.textContent).toContain("에이전트가 인사하러 오고 있어요.");
  });

  it("sleepy speaker: sleepy face + terminal sentence, in stage and in backstop", () => {
    const root = mount({
      phase: "stage",
      reducedMotion: false,
      speaker: { name: "곽성재의 Claude", sleepy: true },
    });
    expect(face(root)).toBe("sleepy");
    expect(root.textContent).toContain(WELCOME_BAND_SLEEPY_COPY);
    act(() =>
      render({
        phase: "backstop",
        reducedMotion: false,
        speaker: { name: "곽성재의 Claude", sleepy: true },
      })
    );
    expect(band(root)?.getAttribute("data-state")).toBe("sleepy");
    expect(root.textContent).toContain(WELCOME_BAND_SLEEPY_COPY);
    expect(root.textContent).not.toContain(WELCOME_BACKSTOP_TITLE);
  });

  it("exiting: joy face + sentence, holds, then collapses and completes on the collapse animationend only", () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const root = mount({
      phase: "exiting",
      reducedMotion: false,
      onExitComplete: () => calls.push(1),
    });
    const el = band(root);
    expect(el?.getAttribute("data-state")).toBe("joy");
    expect(face(root)).toBe("happy");
    expect(root.textContent).toContain(WELCOME_BAND_JOY_COPY);
    expect(el?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(false);
    act(() => {
      vi.advanceTimersByTime(WELCOME_BAND_JOY_HOLD_MS - 1);
    });
    // Joy is read before the band folds.
    expect(el?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(el?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(true);
    expect(calls.length).toBe(0);
    // A bubbling animationend from inside (the Kometto wag) is not the collapse.
    act(() => {
      const inner = new Event("animationend", { bubbles: true });
      Object.defineProperty(inner, "animationName", {
        value: WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
      });
      root.querySelector("[data-testid='kometto-face']")?.dispatchEvent(inner);
    });
    expect(calls.length).toBe(0);
    act(() => {
      const other = new Event("animationend", { bubbles: true });
      Object.defineProperty(other, "animationName", { value: "kometto-wag" });
      el?.dispatchEvent(other);
    });
    expect(calls.length).toBe(0);
    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
      });
      el?.dispatchEvent(event);
    });
    expect(calls.length).toBe(1);
  });

  it("reduced-motion exit: joy face swap only, completes after the hold without the collapse class", () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const root = mount({
      phase: "exiting",
      reducedMotion: true,
      onExitComplete: () => calls.push(1),
    });
    expect(face(root)).toBe("happy");
    act(() => {
      vi.advanceTimersByTime(WELCOME_BAND_JOY_HOLD_MS - 1);
    });
    expect(calls.length).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(calls.length).toBe(1);
    expect(band(root)?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(false);
  });

  it("backstop: working face, title + agents-hub link sentence, not a failure", () => {
    const root = mount({ phase: "backstop", reducedMotion: false });
    const card = root.querySelector("[data-testid='welcome-kickoff-backstop']");
    expect(face(root)).toBe("working");
    expect(card?.textContent).toContain(WELCOME_BACKSTOP_TITLE);
    expect(card?.textContent).toContain(
      `${WELCOME_BACKSTOP_BEFORE}${AGENTS_NAV.label}${WELCOME_BACKSTOP_AFTER}`
    );
    expect(card?.textContent).not.toMatch(/실패|오류|error|fail/i);
    expect((card?.textContent ?? "").split(AGENTS_NAV.label).length - 1).toBe(1);
    const link = card?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(AGENTS_NAV.to);
    expect(link?.getAttribute("href")).toBe(WELCOME_BACKSTOP_HREF);
    expect(link?.textContent).toBe(WELCOME_BACKSTOP_LINK_LABEL);
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../app/App.tsx"),
      "utf8"
    );
    expect(app).toContain(`path="agents"`);
    expect(WELCOME_BACKSTOP_HREF.replace(/^\//, "")).toBe("agents");
  });
});
