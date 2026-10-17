// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestoringScreen } from "./RestoringScreen";

/**
 * 세션 복원 화면 (#3961). 첫 로딩에 오르트 로더가 서되, 그 아래의 뼈대(높이를 지키는
 * 막대)와 `session-restoring` 은 그대로여야 한다: 시험 여섯 곳이 그 testid 를 보고,
 * 막대는 셸이 뜰 때 아무것도 튀지 않게 하는 자리다.
 *
 * red proof (이 파일이 지키는 것):
 *   - RestoringScreen 에서 Skeleton 을 빼면 → 「막대는 그대로」 단정이 붉다
 *   - 로더 래퍼의 `fixed` 를 지우고 흐름 안에 두면 → 「흐름 밖」 단정이 붉다
 *   - 캡션 문구를 새로 지으면 → 「기존 문구만」 단정이 붉다
 *   - App.tsx 의 restoring 분기를 옛 인라인 막대로 되돌리면 → 「App 이 이 화면을 쓴다」가 붉다
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(<RestoringScreen />);
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("복원 화면", () => {
  it("session-restoring 가 그대로 있고 그 안에 높이를 지키는 막대가 그대로 있다", () => {
    const screen = host!.querySelector('[data-testid="session-restoring"]');
    expect(screen).not.toBeNull();
    // Skeleton(ready=false) 는 `skel` 호스트와 막대 층을 그린다.
    const skeleton = screen!.querySelector(".skel");
    expect(skeleton).not.toBeNull();
    expect(skeleton!.getAttribute("data-ready")).toBe("false");
    expect(skeleton!.querySelector(".skel-bars")).not.toBeNull();
  });

  it("큰 로더(코메토 + 위성)가 서고, 곁에 기존 문구 「불러오는 중」이 상태로 읽힌다", () => {
    const status = host!.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("불러오는 중");
    const loader = status.querySelector("[data-oort-loader]")!;
    expect(loader.getAttribute("data-oort-loader")).toBe("hero");
    expect(loader.getAttribute("aria-hidden")).toBe("true");
    expect(loader.querySelector("img.oort-loader-badge")).not.toBeNull();
  });

  it("로더는 뼈대의 높이를 건드리지 않는다: 흐름 밖(fixed)이고 클릭을 가로채지 않는다", () => {
    const status = host!.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.className).toContain("fixed");
    expect(status.className).toContain("pointer-events-none");
    const screen = host!.querySelector('[data-testid="session-restoring"]')!;
    // 복원 화면의 직계 자식은 둘뿐이다: 막대와 오버레이.
    expect([...screen.children].map((c) => c.getAttribute("role") ?? c.className.split(" ")[0])).toEqual([
      expect.stringContaining("skel"),
      "status",
    ]);
  });

  it("캡션과 로더는 같은 CSS 지연(깜빡임 방지)을 건다", () => {
    const caption = host!.querySelector('[role="status"] > span.oort-loader-caption');
    expect(caption).not.toBeNull();
    const hero = host!.querySelector("[data-oort-loader].oort-loader-hero");
    expect(hero).not.toBeNull();
  });

  it("App 의 restoring 분기가 이 화면을 쓴다(옛 인라인 막대로 돌아가지 않는다)", () => {
    const app = readFileSync(join(HERE, "App.tsx"), "utf8");
    expect(app).toMatch(/status === "restoring"\)\s*\{[\s\S]*?return <RestoringScreen \/>;/);
    expect(app).not.toMatch(/data-testid="session-restoring"/);
  });
});
