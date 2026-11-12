// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { focusPermissionCardWhenReady } from "./focusPermissionCard";

// 주소가 연 A 칸의 승인 카드 초점(#5640)을 손으로 세운 칸에서 잰다. 격자 자신의 초점 프레임과 섞이지 않게 함수만 부른다.

let root: HTMLElement;

function build(): { pane: HTMLElement; other: HTMLElement } {
  root = document.createElement("main");
  const pane = document.createElement("section");
  pane.dataset.paneId = "p2";
  pane.tabIndex = -1;
  const other = document.createElement("section");
  other.dataset.paneId = "p1";
  root.append(other, pane);
  document.body.append(root);
  return { pane, other };
}

function card(owner = true): HTMLElement {
  const el = document.createElement("section");
  el.dataset.testid = "agent-permission";
  if (owner) el.tabIndex = -1;
  return el;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  root?.remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe("A 칸 승인 카드 초점 (#5640)", () => {
  it("카드가 나중에 서면 그때 초점을 둔다 — 캐럿이 body나 그 칸 안에 있을 때", async () => {
    const { pane } = build();
    pane.focus();
    focusPermissionCardWhenReady(root, () => "p2");
    const el = card();
    pane.append(el);
    await flush();
    expect(document.activeElement).toBe(el);
  });

  it("카드가 이미 서 있으면 곧바로 둔다", () => {
    const { pane } = build();
    const el = card();
    pane.append(el);
    focusPermissionCardWhenReady(root, () => "p2");
    expect(document.activeElement).toBe(el);
  });

  it("그새 사람이 칸 밖(다른 칸·사이드바)으로 갔으면 캐럿을 빼앗지 않는다", async () => {
    const { pane } = build();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      focusPermissionCardWhenReady(root, () => "p2");
      outside.focus();
      pane.append(card());
      await flush();
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it("다른 칸의 카드·관전자 판(tabindex 없음)에는 두지 않는다", async () => {
    const { pane, other } = build();
    focusPermissionCardWhenReady(root, () => "p2");
    other.append(card());
    pane.append(card(false));
    await flush();
    expect(document.activeElement).toBe(document.body);
  });

  it("상한이 지나거나 멈추면 늦게 선 카드에 두지 않는다", async () => {
    const { pane } = build();
    focusPermissionCardWhenReady(root, () => "p2", 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    pane.append(card());
    await flush();
    expect(document.activeElement).toBe(document.body);

    root.remove();
    const fresh = build();
    const stop = focusPermissionCardWhenReady(root, () => "p2");
    stop();
    const late = card();
    fresh.pane.append(late);
    await flush();
    expect(document.activeElement).not.toBe(late);
  });
});
