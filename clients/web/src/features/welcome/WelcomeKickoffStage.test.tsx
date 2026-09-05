// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
  WELCOME_KICKOFF_MARK_CLASS,
} from "@/design/motion";
import {
  WELCOME_BACKSTOP_COPY,
  WELCOME_KICKOFF_SHAPES,
  WELCOME_STAGE_COPY,
} from "./welcomeKickoff";
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
});

function mount(props: {
  phase: "stage" | "exiting" | "backstop";
  reducedMotion: boolean;
  onExitComplete?: () => void;
}): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/c/general"] },
        createElement(WelcomeKickoffStage, {
          phase: props.phase,
          reducedMotion: props.reducedMotion,
          onExitComplete: props.onExitComplete ?? (() => undefined),
        })
      )
    );
  });
  return host;
}

describe("WelcomeKickoffStage", () => {
  it("stage shows the sentence and 4 marks with stagger indexes", () => {
    const root = mount({ phase: "stage", reducedMotion: false });
    expect(root.textContent).toContain(WELCOME_STAGE_COPY);
    const marks = [...root.querySelectorAll("[data-stagger-index]")];
    expect(marks.length).toBe(WELCOME_KICKOFF_SHAPES.length);
    expect(marks.map((el) => el.getAttribute("data-stagger-index"))).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
    expect(marks.every((el) => el.classList.contains(WELCOME_KICKOFF_MARK_CLASS))).toBe(
      true
    );
  });

  it("reduced-motion has no stagger custom property and no rise class", () => {
    const root = mount({ phase: "stage", reducedMotion: true });
    const svgs = [...root.querySelectorAll("svg")];
    expect(svgs.length).toBe(WELCOME_KICKOFF_SHAPES.length);
    for (const svg of svgs) {
      const wrap = svg.parentElement;
      expect(wrap?.getAttribute("data-stagger-index")).toBeNull();
      expect(wrap?.classList.contains(WELCOME_KICKOFF_MARK_CLASS)).toBe(false);
      expect(
        getComputedStyle(wrap as Element).getPropertyValue("--stagger-index").trim()
      ).toBe("");
    }
  });

  it("reduced-motion exit calls onExitComplete without the exit class", () => {
    const calls: number[] = [];
    const root = mount({
      phase: "exiting",
      reducedMotion: true,
      onExitComplete: () => calls.push(1),
    });
    expect(calls.length).toBe(1);
    const stage = root.querySelector("[data-testid='welcome-kickoff-stage']");
    expect(stage?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(false);
  });

  it("motion exit waits for motion-fade-out animationend", () => {
    const calls: number[] = [];
    const root = mount({
      phase: "exiting",
      reducedMotion: false,
      onExitComplete: () => calls.push(1),
    });
    expect(calls.length).toBe(0);
    const stage = root.querySelector("[data-testid='welcome-kickoff-stage']");
    expect(stage).not.toBeNull();
    expect(stage?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(true);
    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: "motion-welcome-kickoff-rise",
      });
      stage?.dispatchEvent(event);
    });
    expect(calls.length).toBe(0);
    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
      });
      stage?.dispatchEvent(event);
    });
    expect(calls.length).toBe(1);
  });

  it("backstop shows the guidance sentence and no failure wording", () => {
    const root = mount({ phase: "backstop", reducedMotion: false });
    const card = root.querySelector("[data-testid='welcome-kickoff-backstop']");
    expect(card?.textContent).toContain(WELCOME_BACKSTOP_COPY);
    expect(card?.textContent).not.toMatch(/실패|오류|error|fail/i);
    expect(card?.querySelector("a")?.getAttribute("href")).toBe("/agents");
  });
});
