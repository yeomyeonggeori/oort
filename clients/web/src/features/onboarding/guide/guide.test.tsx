// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KOMETTO_EXPRESSIONS,
  onboardingDots,
  type KomettoExpression,
} from "@momo/core/features/onboarding/guide";
import { KOMETTO_EXPRESSION_ASSETS } from "./komettoExpressions";
import { KomettoGuide } from "./KomettoGuide";
import { OnboardingDots } from "./OnboardingDots";

let reducedMotion = false;
let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(element: ReactElement) {
  act(() => root.render(element));
}

function guide(expression: KomettoExpression, line = "어디로 갈까요?") {
  return createElement(KomettoGuide, { expression, line });
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

function endAnimation(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new Event("animationend", { bubbles: true }));
  });
}

describe("KomettoGuide", () => {
  it("renders the head size with one sentence and a decorative Kometto", () => {
    render(createElement(KomettoGuide, { expression: "idle", line: "어디로 갈까요?", detail: "주소를 넣어요." }));
    expect(q("kometto-guide")?.getAttribute("data-size")).toBe("head");
    expect(q("kometto-guide-line")?.textContent).toBe("어디로 갈까요?");
    expect(q("kometto-guide-detail")?.textContent).toBe("주소를 넣어요.");
    const img = q("kometto-face-current") as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe("");
    expect(q("kometto-face")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts the sentence in one polite, atomic live region (read once)", () => {
    render(guide("idle"));
    const bubble = q("kometto-guide-bubble");
    expect(bubble?.getAttribute("aria-live")).toBe("polite");
    expect(bubble?.getAttribute("aria-atomic")).toBe("true");
    expect(host.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("refuses an expression without a sentence", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(guide("thinking", ""))).toThrow(/needs a line/);
      expect(() => render(guide("thinking", "  "))).toThrow(/needs a line/);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders the hero size when asked", () => {
    render(createElement(KomettoGuide, { expression: "happy", line: "반가워요.", size: "hero" }));
    expect(q("kometto-guide")?.getAttribute("data-size")).toBe("hero");
    expect(q("kometto-face")?.getAttribute("data-size")).toBe("hero");
  });

  it("does not fade or wag on first paint, even when mounted happy", () => {
    render(guide("happy"));
    expect(q("kometto-face-current")?.getAttribute("data-phase")).toBe("rest");
    expect(q("kometto-face-leaving")).toBeNull();
    expect(q("kometto-face")?.hasAttribute("data-wag")).toBe(false);
  });

  it("crossfades in place on an expression change, then drops the old layer", () => {
    render(guide("idle"));
    render(guide("thinking"));
    const face = q("kometto-face");
    expect(face?.getAttribute("data-expression")).toBe("thinking");
    expect(q("kometto-face-current")?.getAttribute("data-phase")).toBe("entering");
    expect(q("kometto-face-leaving")?.getAttribute("data-phase")).toBe("leaving");
    // Both layers share the one fixed box: the head does not move.
    expect(face?.querySelectorAll(".kometto-face-layer")).toHaveLength(2);
    expect(face?.hasAttribute("data-wag")).toBe(false);
    endAnimation(q("kometto-face-leaving"));
    expect(q("kometto-face-leaving")).toBeNull();
  });

  it("wags once when the change lands on happy, and the wag ends", () => {
    render(guide("thinking"));
    render(guide("happy", "찾았어요."));
    expect(q("kometto-face")?.getAttribute("data-wag")).toBe("true");
    endAnimation(q("kometto-face"));
    expect(q("kometto-face")?.hasAttribute("data-wag")).toBe(false);
  });

  it("does not let a layer's animationend end the wag early", () => {
    render(guide("thinking"));
    render(guide("happy", "찾았어요."));
    endAnimation(q("kometto-face-current"));
    expect(q("kometto-face")?.getAttribute("data-wag")).toBe("true");
  });

  it("has no motion at all under reduced motion: no leaving layer, no fade, no wag", () => {
    reducedMotion = true;
    render(guide("thinking"));
    render(guide("happy", "찾았어요."));
    expect(q("kometto-face")?.getAttribute("data-expression")).toBe("happy");
    expect(q("kometto-face-leaving")).toBeNull();
    expect(q("kometto-face-current")?.getAttribute("data-phase")).toBe("rest");
    expect(q("kometto-face")?.hasAttribute("data-wag")).toBe(false);
  });
});

describe("OnboardingDots", () => {
  it("renders nothing on the first screen and the first conversation", () => {
    render(createElement(OnboardingDots, { dots: onboardingDots("claim", "welcome") }));
    expect(q("onboarding-dots")).toBeNull();
    render(
      createElement(OnboardingDots, { dots: onboardingDots("invite", "first-conversation") })
    );
    expect(q("onboarding-dots")).toBeNull();
  });

  it("draws a bar for the current step, dots elsewhere, and a hidden sentence", () => {
    render(
      createElement(OnboardingDots, { dots: onboardingDots("claim", "workspace-profile") })
    );
    const states = [...host.querySelectorAll(".onboarding-dot")].map((d) =>
      d.getAttribute("data-state")
    );
    expect(states).toEqual(["done", "current", "todo", "todo"]);
    for (const dot of host.querySelectorAll(".onboarding-dot")) {
      expect(dot.getAttribute("aria-hidden")).toBe("true");
    }
    const label = q("onboarding-dots-label");
    expect(label?.textContent).toBe("4단계 중 2단계");
    expect(label?.className).toContain("sr-only");
  });
});

describe("표정 에셋 매핑은 한 곳이다", () => {
  it("maps every expression id, and nothing else", () => {
    expect(Object.keys(KOMETTO_EXPRESSION_ASSETS).sort()).toEqual(
      [...KOMETTO_EXPRESSIONS].sort()
    );
    for (const id of KOMETTO_EXPRESSIONS) {
      expect(KOMETTO_EXPRESSION_ASSETS[id]).toBeTruthy();
    }
  });

  it("no component outside the mapping picks a Kometto picture for an expression", () => {
    // jsdom gives import.meta.url an http scheme; vitest runs from clients/web.
    const srcRoot = join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(srcRoot);
    const importers = files
      .filter((file) => /assets\/brand\/kometto/.test(readFileSync(file, "utf8")))
      .map((file) => relative(srcRoot, file))
      .sort();
    // KomettoMark is the S0 hero logo (not an expression); the mapping is the
    // only other door. A new importer is a second mapping.
    expect(importers).toEqual([
      "design/brand/KomettoMark.tsx",
      "features/onboarding/guide/komettoExpressions.ts",
    ]);
  });
});
