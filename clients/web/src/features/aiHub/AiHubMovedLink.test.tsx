// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AiHubMovedLink } from "./AiHubMovedLink";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
});
function mount(section: string): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(MemoryRouter, null, createElement(AiHubMovedLink, { section }))));
  return host;
}

describe("옛 설정 구획의 허브 안내 (AIH-3)", () => {
  it.each([
    ["ai", "/ai/accounts"],
    ["agents", "/ai/external"],
    ["plugins", "/ai/external"],
    ["webhooks", "/ai/external"],
    ["events", "/ai/external"],
  ])("설정 %s 위에 「AI 허브로 옮겼어요」와 %s 링크가 선다", (section, href) => {
    const el = mount(section);
    expect(el.textContent).toContain("AI 허브로 옮겼어요");
    expect(el.querySelector("a")?.getAttribute("href")).toBe(href);
  });

  it("허브로 옮기지 않은 구획에는 아무것도 그리지 않는다", () => {
    expect(mount("profile").innerHTML).toBe("");
  });
});
