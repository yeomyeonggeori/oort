// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// 층 요소의 배선 (AP-4 #4191): 마운트되면 런타임에 붙고, 셸이 사라지면(로그아웃) 뗀다.
//
// 런타임 자체(그림을 칠하고 속성을 켜는 순서)는 `runtime.test.ts`가 잰다. 여기서는 컴포넌트가 그 런타임을 올바른 요소로
// 부르는지만 잰다: 이 한 줄이 끊기면 배경은 영영 서지 않고, 떼지 않으면 앞 사람의 그림이 루트에 남는다.
// =============================================================================

const runtime = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn() }));
vi.mock("./runtime", () => ({ wallpaperRuntime: () => runtime }));

import { WallpaperLayer } from "./WallpaperLayer";

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  runtime.attach.mockReset();
  runtime.detach.mockReset();
  document.body.replaceChildren();
});

describe("WallpaperLayer", () => {
  it("마운트되면 자기 요소로 런타임에 붙고, 내려가면 뗀다", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(WallpaperLayer)));

    const element = host.querySelector("[data-wallpaper-layer]");
    expect(element).not.toBeNull();
    expect(element?.getAttribute("aria-hidden")).toBe("true");
    expect(runtime.attach).toHaveBeenCalledTimes(1);
    expect(runtime.attach.mock.calls[0]?.[0]).toBe(element);
    expect(runtime.detach).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(runtime.detach).toHaveBeenCalledTimes(1);
  });

  it("요소에는 내용도 인라인 스타일도 없다 (칠은 런타임이 CSSOM으로 한다)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(WallpaperLayer)));
    const element = host.querySelector("[data-wallpaper-layer]") as HTMLElement;
    expect(element.children.length).toBe(0);
    expect(element.textContent).toBe("");
    expect(element.getAttribute("style")).toBeNull();
    act(() => root.unmount());
  });
});
