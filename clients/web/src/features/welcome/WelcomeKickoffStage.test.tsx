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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  WELCOME_BACKSTOP_COPY,
  WELCOME_BACKSTOP_HREF,
  WELCOME_BACKSTOP_LINK_LABEL,
  WELCOME_KICKOFF_SHAPES,
  WELCOME_STAGE_COPY,
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
  it("stage shows the sentence and constellation from CLOUD_BODIES", () => {
    const root = mount({ phase: "stage", reducedMotion: false });
    expect(root.textContent).toContain(WELCOME_STAGE_COPY);
    const marks = [...root.querySelectorAll(".welcome-kickoff [data-stagger-index]")];
    expect(marks.length).toBe(WELCOME_KICKOFF_SHAPES.length);
    expect(marks.map((el) => el.getAttribute("data-stagger-index"))).toEqual(
      WELCOME_KICKOFF_SHAPES.map((_, index) => String(index))
    );
    expect(marks.every((el) => el.classList.contains(WELCOME_KICKOFF_MARK_CLASS))).toBe(
      true
    );
    for (const [index, body] of WELCOME_KICKOFF_SHAPES.entries()) {
      expect(marks[index]?.getAttribute("data-onboarding-body")).toBe(String(body.index));
      expect(marks[index]?.className).toContain(
        body.tone === "accent" ? "text-accent" : "text-ink"
      );
    }
    const kinds = WELCOME_KICKOFF_SHAPES.map((body) => body.kind);
    expect(new Set(kinds).size).toBe(WELCOME_KICKOFF_SHAPES.length);
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

  it("backstop link href is the agents route and its label is the nav constant", () => {
    const root = mount({ phase: "backstop", reducedMotion: false });
    const card = root.querySelector("[data-testid='welcome-kickoff-backstop']");
    expect(card?.textContent).toContain(WELCOME_BACKSTOP_COPY);
    expect(card?.textContent).not.toMatch(/실패|오류|error|fail/i);
    expect((card?.textContent ?? "").split(AGENTS_NAV.label).length - 1).toBe(1);
    const link = card?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(AGENTS_NAV.to);
    expect(link?.getAttribute("href")).toBe(WELCOME_BACKSTOP_HREF);
    expect(link?.textContent).toBe(AGENTS_NAV.label);
    expect(link?.textContent).toBe(WELCOME_BACKSTOP_LINK_LABEL);
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../app/App.tsx"),
      "utf8"
    );
    expect(app).toContain(`path="agents"`);
    expect(WELCOME_BACKSTOP_HREF.replace(/^\//, "")).toBe("agents");
  });
});
