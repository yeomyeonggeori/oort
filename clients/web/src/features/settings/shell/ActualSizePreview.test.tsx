// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ActualSizeFigure, ActualSizePreview } from "./ActualSizePreview";

// 실제 크기 미리보기 틀 (#4261): 아바타 편집기가 처음 쓰고 다른 설정 미리보기(말풍선 꾸미기 등)가 틀만 가져다 쓴다.
// 이 시험이 못 박는 것: 틀은 장식(`aria-hidden`)이고, 안을 모르며(편집기·코어 모델을 가져오지 않는다), 호출자의 id·상태 속성·
// 클래스를 그대로 싣는다. 그림 칸은 이름표를 그림 밑에 둔다.

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

describe("ActualSizePreview", () => {
  it("장식이다: 보조기술에는 숨기고, 호출자의 testid 와 상태 속성을 싣는다", () => {
    const view = mount(
      <ActualSizePreview testId="any-preview" dataAttrs={{ "data-source": "draft" }}>
        <span>안</span>
      </ActualSizePreview>
    );
    const box = view.querySelector<HTMLElement>('[data-testid="any-preview"]');
    expect(box).not.toBeNull();
    expect(box?.getAttribute("aria-hidden")).toBe("true");
    expect(box?.getAttribute("data-source")).toBe("draft");
    expect(box?.textContent).toBe("안");
  });

  it("둥근 면 위에 그림들을 한 줄로 가운데에 늘어놓고, 호출자의 클래스가 더해진다", () => {
    const view = mount(
      <ActualSizePreview testId="p" className="gap-4">
        <i />
      </ActualSizePreview>
    );
    const box = view.querySelector<HTMLElement>('[data-testid="p"]');
    expect(box?.className).toMatch(/\brounded-lg\b/);
    expect(box?.className).toMatch(/\bbg-surface-muted\b/);
    expect(box?.className).toMatch(/\bjustify-center\b/);
    // 같은 축(gap)의 호출자 클래스가 틀의 기본을 덮는다(tailwind-merge).
    expect(box?.className).toMatch(/\bgap-4\b/);
    expect(box?.className).not.toMatch(/\bgap-8\b/);
  });

  it("속성을 안 주면 testid 도 상태 속성도 달지 않는다", () => {
    const view = mount(
      <ActualSizePreview>
        <i />
      </ActualSizePreview>
    );
    const box = view.firstElementChild as HTMLElement;
    expect(box.hasAttribute("data-testid")).toBe(false);
    expect([...box.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-"))).toEqual([]);
  });
});

describe("ActualSizeFigure", () => {
  it("그림 밑에 이름표를 둔다 (figure > 그림, figcaption)", () => {
    const view = mount(
      <ActualSizePreview>
        <ActualSizeFigure caption="메시지">
          <span data-testid="art">그림</span>
        </ActualSizeFigure>
      </ActualSizePreview>
    );
    const figure = view.querySelector("figure");
    expect(figure?.children).toHaveLength(2);
    expect(figure?.firstElementChild?.getAttribute("data-testid")).toBe("art");
    expect(figure?.lastElementChild?.tagName).toBe("FIGCAPTION");
    expect(figure?.lastElementChild?.textContent).toBe("메시지");
  });
});

describe("틀은 안을 모른다", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "ActualSizePreview.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const imports = [...source.matchAll(/^import\s+[^;]*?from\s+["']([^"']+)["']/gms)].map((match) => match[1]);

  it("가져오는 것은 react 와 클래스 합치기뿐이다 (편집기·아바타·코어 모델이 없다)", () => {
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.sort()).toEqual(["@/design/lib/cn", "react"]);
  });
});
