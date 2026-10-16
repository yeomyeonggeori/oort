// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OortLoader } from "./OortLoader";

/**
 * 오르트 로더 (#3961): React 쪽 계약. 마크업, 움직임 선택(full · reduced · still),
 * 언마운트 정리. 움직임 자체(기하·등속·합성 속성)는 jsdom 이 못 잰다. 그 숫자는
 * OortLoader.motion.test.tsx 가 Chromium 에서 잰다.
 *
 * red proof (이 파일이 지키는 것):
 *   - `still` 분기를 지우면 → 「still 은 reduced 보다 먼저」 단정이 붉다
 *   - 훅 대신 `data-motion="full"` 고정 → 동작 줄이기 분기 단정이 붉다
 *   - 링을 hero 에도 그리면 → 「hero 는 링 대신 코메토」 단정이 붉다
 *   - 궤도 층을 링 뒤로 옮기면 → 「궤도가 링보다 먼저」 단정이 붉다
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 마크 정본 기하를 소스에서 읽는다(`brandMark.test.ts` 와 같은 방식: 이 파일의 path 가 정본이다). */
const MARK_SOURCE = readFileSync(
  join(HERE, "OortMark.tsx"),
  "utf8"
);
function markGeometry(optical: "small" | "display") {
  const block = MARK_SOURCE.match(new RegExp(`${optical}: \\{([\\s\\S]*?)\\n  \\}`))![1]!;
  return {
    viewBox: block.match(/viewBox: "([^"]+)"/)![1]!,
    ring: block.match(/ring: "([^"]+)"/)![1]!,
    satellite: block.match(/satellite: "([^"]+)"/)![1]!,
  };
}
const GEOMETRY = { small: markGeometry("small"), display: markGeometry("display") };

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type Listener = () => void;

/** matchMedia 대역: 구독과 해제를 세고, 값을 바꾸면 구독자에게 change 를 보낸다. */
function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const added: Listener[] = [];
  const removed: Listener[] = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_type: string, fn: Listener) => {
      listeners.add(fn);
      added.push(fn);
    },
    removeEventListener: (_type: string, fn: Listener) => {
      listeners.delete(fn);
      removed.push(fn);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return {
    set(next: boolean) {
      matches = next;
      for (const fn of [...listeners]) fn();
    },
    added,
    removed,
    live: () => listeners.size,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

const loader = (el: HTMLElement) => el.querySelector<HTMLElement>("[data-oort-loader]")!;

describe("마크업", () => {
  it("기본은 24px 마크 로더이고 장식이다(aria-hidden, 이름은 곁의 문장이 진다)", () => {
    stubMatchMedia(false);
    const el = loader(mount(<OortLoader />));
    expect(el.getAttribute("data-oort-loader")).toBe("mark");
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.className).toContain("size-6");
    expect(el.className).toContain("oort-loader");
    expect(el.className).not.toContain("oort-loader-hero");
  });

  it("링은 OortMark 가 그린다: 마크 정본 small 링 path 그대로, 위성 path 는 없다", () => {
    stubMatchMedia(false);
    const root_ = mount(<OortLoader />);
    const ring = root_.querySelector("svg.oort-loader-ring")!;
    expect(ring.getAttribute("viewBox")).toBe(GEOMETRY.small.viewBox);
    const paths = [...ring.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    // 위성은 로더의 원 하나가 따로 움직인다. 링 SVG 에 위성이 또 있으면 홈에 하나가 박혀 있다.
    expect(paths).toEqual([GEOMETRY.small.ring]);
    expect(ring.getAttribute("aria-hidden")).toBe("true");
  });

  it("궤도 층이 링보다 먼저 온다: 링이 위에 그려져 위성이 꼬리 뒤로 지나간다", () => {
    stubMatchMedia(false);
    const body = loader(mount(<OortLoader />)).querySelector(".oort-loader-body")!;
    const kinds = [...body.children].map((c) => c.classList[0]);
    expect(kinds).toEqual(["oort-loader-orbit", "oort-loader-ring"]);
  });

  it("마크 로더에는 꼬리 점이 없다(24px 에서 번잡하다)", () => {
    stubMatchMedia(false);
    const el = loader(mount(<OortLoader />));
    expect(el.querySelectorAll(".oort-loader-dot")).toHaveLength(1);
  });

  it("hero 는 링 대신 코메토 배지가 서고 위성 머리 + 꼬리 점 둘이다", () => {
    stubMatchMedia(false);
    const el = loader(mount(<OortLoader variant="hero" />));
    expect(el.getAttribute("data-oort-loader")).toBe("hero");
    expect(el.className).toContain("oort-loader-hero");
    expect(el.className).toContain("size-loader-hero");
    expect(el.querySelector("svg.oort-loader-ring")).toBeNull();
    const badge = el.querySelector("img.oort-loader-badge");
    expect(badge).not.toBeNull();
    // 코메토는 장식이다(곁에 「불러오는 중」 문장이 있다). 이름을 두 번 읽히지 않는다.
    expect(badge!.getAttribute("alt")).toBe("");
    expect(el.querySelectorAll(".oort-loader-dot")).toHaveLength(3);
    expect(el.querySelectorAll(".oort-loader-trail-near, .oort-loader-trail-far")).toHaveLength(2);
  });

  it("호출자 className 이 뒤에 붙는다(정렬 여백 같은 것)", () => {
    stubMatchMedia(false);
    const el = loader(mount(<OortLoader className="mt-px" />));
    expect(el.className).toContain("mt-px");
    expect(el.className).toContain("size-6");
  });
});

describe("움직임 선택", () => {
  it("평소에는 full 이다", () => {
    stubMatchMedia(false);
    expect(loader(mount(<OortLoader />)).dataset.motion).toBe("full");
  });

  it("OS 「동작 줄이기」면 reduced 이고, 설정이 바뀌면 다시 그릴 때 따라간다", () => {
    const media = stubMatchMedia(true);
    const el = loader(mount(<OortLoader />));
    expect(el.dataset.motion).toBe("reduced");

    act(() => media.set(false));
    expect(el.dataset.motion).toBe("full");
    act(() => media.set(true));
    expect(el.dataset.motion).toBe("reduced");
  });

  it("still 은 reduced 보다 먼저다: 진행 중이 아닌 자리는 투명도도 숨 쉬지 않는다", () => {
    stubMatchMedia(true);
    expect(loader(mount(<OortLoader still />)).dataset.motion).toBe("still");
  });

  it("still 은 움직이는 설정에서도 still 이다", () => {
    stubMatchMedia(false);
    expect(loader(mount(<OortLoader still />)).dataset.motion).toBe("still");
  });

  it("hero 도 같은 세 갈래를 탄다", () => {
    stubMatchMedia(true);
    expect(loader(mount(<OortLoader variant="hero" />)).dataset.motion).toBe("reduced");
  });
});

describe("언마운트 정리", () => {
  it("움직임은 CSS 라 JS 타이머가 없고, 동작 줄이기 구독은 언마운트에서 풀린다", () => {
    const media = stubMatchMedia(false);
    const intervals = vi.spyOn(globalThis, "setInterval");
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    mount(<OortLoader />);
    const subscribed = media.added.length;
    expect(subscribed).toBeGreaterThan(0);
    expect(media.live()).toBe(subscribed);

    act(() => {
      root!.unmount();
    });
    root = null;

    // 구독한 만큼 풀렸고 남은 것이 없다.
    expect(media.removed).toEqual(media.added);
    expect(media.live()).toBe(0);
    // 로더가 JS 로 돌리는 것은 없다: 반복 타이머·rAF 호출 0.
    expect(intervals).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
    // 노드도 DOM 에서 사라진다(CSS 애니메이션은 노드와 함께 끝난다).
    expect(document.querySelector("[data-oort-loader]")).toBeNull();
  });
});
