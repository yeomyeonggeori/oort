// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ENTER_CONVERSATION_ANIMATION_NAME,
  ENTER_CONVERSATION_CLASS,
} from "@/design/motion";
import { useConversationEntrance } from "./conversationEntrance";

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

function Probe({
  playEntrance,
  onConsumed,
}: {
  playEntrance: boolean;
  onConsumed?: () => void;
}): ReactElement {
  const entrance = useConversationEntrance(playEntrance, onConsumed);
  return createElement("article", {
    "data-testid": "entrance-probe",
    "data-entrance-play": entrance.playing ? "1" : "0",
    className: entrance.className,
    onAnimationEnd: entrance.onAnimationEnd,
  });
}

function mount(playEntrance: boolean, onConsumed?: () => void): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(Probe, { playEntrance, onConsumed })
    );
  });
  return host;
}

function playCount(root: HTMLElement): number {
  return root.querySelectorAll("[data-entrance-play='1']").length;
}

function classCount(root: HTMLElement): number {
  const el = root.querySelector("[data-testid='entrance-probe']");
  if (!(el instanceof HTMLElement)) return 0;
  return el.classList.contains(ENTER_CONVERSATION_CLASS) ? 1 : 0;
}

function dispatchEnd(root: HTMLElement, animationName: string): void {
  const el = root.querySelector("[data-testid='entrance-probe']");
  if (!(el instanceof HTMLElement)) throw new Error("missing probe");
  act(() => {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: animationName });
    el.dispatchEvent(event);
  });
}

describe("useConversationEntrance play count", () => {
  it("playEntrance true 는 재생 1 (클래스 1)", () => {
    const root = mount(true);
    expect(playCount(root)).toBe(1);
    expect(classCount(root)).toBe(1);
  });

  it("playEntrance false 는 재생 0", () => {
    const root = mount(false);
    expect(playCount(root)).toBe(0);
    expect(classCount(root)).toBe(0);
  });

  it("animationName 일치 animationend 후 재생 0", () => {
    const root = mount(true);
    expect(playCount(root)).toBe(1);
    dispatchEnd(root, ENTER_CONVERSATION_ANIMATION_NAME);
    expect(playCount(root)).toBe(0);
    expect(classCount(root)).toBe(0);
  });

  it("다른 animationName 의 animationend 는 재생 1 유지", () => {
    const root = mount(true);
    dispatchEnd(root, "motion-fade-in");
    expect(playCount(root)).toBe(1);
    expect(classCount(root)).toBe(1);
  });

  it("첫 마운트에서 플래그를 1회 소비한다", () => {
    const consumed: number[] = [];
    mount(true, () => consumed.push(1));
    expect(consumed.length).toBe(1);
  });

  it("playEntrance false 마운트는 소비 0", () => {
    const consumed: number[] = [];
    mount(false, () => consumed.push(1));
    expect(consumed.length).toBe(0);
  });
});

// duration / computed animationName: jsdom 은 빈 문자열을 돌려준다. 그 값을
// 500ms 로 읽는 폴백은 없다 — Playwright 레인이 숫자(500)와 animationName 을 잰다.
