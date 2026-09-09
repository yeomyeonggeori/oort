// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TruncatingName } from "./TruncatingName";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function source(): string {
  return readFileSync(
    resolve(process.cwd(), "src/features/hostedAgents/TruncatingName.tsx"),
    "utf8"
  );
}

function mount(name: string): HTMLElement {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(TruncatingName, {
        name,
        className: "min-w-0 truncate text-body",
        testId: "truncating-name",
      })
    );
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

describe("TruncatingName 측정 title", () => {
  it("title 은 scrollWidth > clientWidth 일 때만 켠다", () => {
    const text = source();
    expect(text).toContain("el.scrollWidth > el.clientWidth");
    expect(text).toContain("title={truncated ? name : undefined}");
    expect(text).toContain("useLayoutEffect");
    expect(text).toContain("ResizeObserver");
    expect(text).not.toMatch(/name\.length\s*>/);
  });

  it("17자 한글은 길이 휴리스틱으로 title 을 켜지 않는다", () => {
    const name = "김인턴데이터플랫폼온콜대기열용자명";
    expect(name.length).toBe(17);
    const host = mount(name);
    const el = host.querySelector('[data-testid="truncating-name"]');
    expect(el).toBeTruthy();
    expect(el?.textContent).toBe(name);
    expect(el?.className.split(/\s+/)).toContain("truncate");
    expect(el?.className.split(/\s+/)).toContain("min-w-0");
    expect(el?.getAttribute("title")).toBeNull();
  });

  it("jsdom 은 60자에도 title 을 심지 않는다", () => {
    const name =
      "김인턴-데이터플랫폼-온콜 Agent Runtime Operations Assistant 김인턴-온콜대기열용자";
    expect(name.length).toBeGreaterThanOrEqual(60);
    const host = mount(name);
    expect(
      host.querySelector('[data-testid="truncating-name"]')?.getAttribute("title")
    ).toBeNull();
  });
});
