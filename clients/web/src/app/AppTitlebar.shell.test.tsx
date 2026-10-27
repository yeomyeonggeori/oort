// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// 셸(Tauri)일 때의 상단 줄 = 창 맨 위 잡기 띠 (#4591).
//
// `IS_TAURI`는 모듈 상수라 import보다 먼저 켠다(vi.mock은 호이스팅된다). 웹(IS_TAURI 거짓)의 시험은
// `AppTitlebar.test.tsx`다: 거기서는 띠도 오른쪽 자리도 없다. 지금까지 렌더 시험은 전부 IS_TAURI가 거짓이라
// 셸에서만 서는 가지(끌기 속성·오른쪽 자리)는 한 번도 재어진 적이 없었다.
// =============================================================================
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  IS_TAURI: true,
}));

import { AppTitlebar } from "./AppTitlebar";
import { DownloadButton } from "@/features/downloads/DownloadButton";
import { createDownloadsStore } from "@/features/downloads/downloadsStore";
import { ATTACHMENT, bytes, fake } from "@/features/downloads/downloadsTestKit";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

function mountTitlebar(options: {
  trailing?: ReactNode;
  onCollapsedChange?: (collapsed: boolean) => void;
} = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() =>
    mountedRoot?.render(
      createElement(AppTitlebar, {
        collapsed: false,
        onCollapsedChange: options.onCollapsedChange ?? (() => undefined),
        trailing: options.trailing,
      })
    )
  );
  const q = <T extends Element = HTMLElement>(testId: string) =>
    host.querySelector<T>(`[data-testid="${testId}"]`);
  return {
    host,
    titlebar: q("app-titlebar") as HTMLElement,
    toggle: q<HTMLButtonElement>("sidebar-toggle") as HTMLButtonElement,
    slot: q("app-titlebar-trailing"),
    q,
  };
}

// -----------------------------------------------------------------------------
// Tauri의 끌기 판정. 셸이 실제로 하는 일을 시험이 **같은 알고리즘으로** 묻는다.
//
// 아래는 Tauri 2.11.5 `src/window/scripts/drag.js`의 `isDragRegion`을 옮긴 것이다(이 레포의 Cargo.lock 버전).
//   · 속성만 있으면(`""`/`"true"`) **그 요소를 직접 누른 것**만 끌기다. 자식은 상속하지 않는다(`"deep"`이 아니다).
//   · 버튼·링크·입력 같은 클릭 가능한 요소는 속성이 없으면 끌기를 **막는다**.
// Tauri를 올릴 때 이 판정이 바뀌면 이 사본이 낡는다. 그때는 위 스크립트와 다시 대조한다.
// -----------------------------------------------------------------------------
const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
]);

function isClickable(el: HTMLElement): boolean {
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") ||
    (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
    INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "")
  );
}

/** `mousedown`이 `target`에서 났을 때 Tauri가 창 끌기를 시작하는가. */
function pressStartsWindowDrag(target: Element): boolean {
  const path: Element[] = [];
  for (let el: Element | null = target; el; el = el.parentElement) path.push(el);
  for (const el of path) {
    if (!(el instanceof HTMLElement)) continue; // svg 같은 비 HTML 요소는 건너뛴다(원본과 같다)
    const attr = el.getAttribute("data-tauri-drag-region");
    if (isClickable(el) && attr === null) return false;
    if (attr === null) continue;
    if (attr === "false") return false;
    if (attr === "deep") return true;
    if (attr === "" || attr === "true") return el === path[0];
  }
  return false;
}

describe("셸의 상단 줄: 창 맨 위 잡기 띠 (#4591)", () => {
  it("줄 자신과 오른쪽 자리가 끌기 영역이고, 토글은 아니다", () => {
    const { titlebar, toggle, slot } = mountTitlebar();
    expect(titlebar.getAttribute("data-tauri-drag-region")).toBe("");
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute("data-tauri-drag-region")).toBe("");
    expect(toggle.hasAttribute("data-tauri-drag-region")).toBe(false);
    // 자리는 줄의 마지막 자식이다: 줄 왼쪽의 신호등 인셋·토글 뒤로 오른쪽 끝에 선다.
    expect(titlebar.lastElementChild).toBe(slot);
    // 자리는 띠의 윗줄(전폭) 위에 선다: 글자 역할은 상단 줄이 이미 띠 쪽으로 묶는다(`data-desktop-shell`).
    // `band-surface`를 들면 그 묶음과 유리·배경화면의 보정이 지워져 원래 역할로 돌아간다.
    expect(slot?.className).not.toContain("band-surface");
    expect(slot?.className).toContain("app-titlebar-trailing");
  });

  it("띠의 빈 곳을 누르면 창이 끌리고, 토글과 그 아이콘을 누르면 끌리지 않는다 (Tauri drag.js 판정)", () => {
    const { titlebar, toggle, slot } = mountTitlebar();
    expect(pressStartsWindowDrag(titlebar)).toBe(true);
    expect(pressStartsWindowDrag(slot as Element)).toBe(true);
    expect(pressStartsWindowDrag(toggle)).toBe(false);
    const icon = toggle.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(pressStartsWindowDrag(icon as Element)).toBe(false);
  });

  it("오른쪽 자리에 채운 단추는 그대로 그려지고 끌기에서 빠진다 (#4587이 쓰는 입구)", () => {
    const onDownload = vi.fn();
    const { slot } = mountTitlebar({
      trailing: createElement(
        "button",
        { type: "button", "data-testid": "download-probe", onClick: onDownload },
        createElement("svg", { "aria-hidden": "true" })
      ),
    });
    const probe = slot?.querySelector<HTMLButtonElement>('[data-testid="download-probe"]');
    expect(probe).not.toBeNull();
    expect(pressStartsWindowDrag(probe as Element)).toBe(false);
    expect(pressStartsWindowDrag(probe?.querySelector("svg") as Element)).toBe(false);
    // 자리 자신은 여전히 끌기다: 단추 사이 틈을 잡아도 창이 움직인다.
    expect(pressStartsWindowDrag(slot as Element)).toBe(true);
    act(() => probe?.click());
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("비어 있는 자리는 아무것도 그리지 않는다(자식 0)", () => {
    const { slot } = mountTitlebar();
    expect(slot?.childElementCount).toBe(0);
  });

  it("토글은 끌기 속성이 없어서 눌림이 접힘을 바꾼다", () => {
    const onCollapsedChange = vi.fn();
    const { toggle } = mountTitlebar({ onCollapsedChange });
    act(() => toggle.click());
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });
});

describe("오른쪽 자리를 채운 다운로드 단추 (#4587)", () => {
  // 위 「#4587이 쓰는 입구」 시험은 자리에 임의의 단추를 꽂았다. 여기는 진짜 단추다: 링과 점까지 서 있는
  // 상태에서도 단추 안의 어느 조각을 눌러도 창이 끌리지 않고, 단추 사이 틈은 여전히 끌린다.
  it("아이콘·링·점 어디를 눌러도 끌리지 않고, 칸은 그대로 끌기 영역이다", async () => {
    const f = fake();
    const store = createDownloadsStore(f.deps);
    const first = store.start({ workspaceId: "ws", channelId: "ch", attachment: ATTACHMENT });
    f.fetches[0]?.resolve(bytes(10));
    await first; // 끝났는데 안 본 것: 점
    void store.start({ workspaceId: "ws", channelId: "ch", attachment: { ...ATTACHMENT, id: "att-2" } }); // 받는 중: 링

    const { slot, titlebar } = mountTitlebar({ trailing: createElement(DownloadButton, { store }) });
    const downloadButton = slot?.querySelector<HTMLButtonElement>('[data-testid="download-button"]');
    expect(downloadButton).not.toBeNull();
    const ring = slot?.querySelector('[data-testid="download-ring"]');
    const dot = slot?.querySelector('[data-testid="download-dot"]');
    const icon = downloadButton?.querySelector("svg");
    expect(ring).not.toBeNull();
    expect(dot).not.toBeNull();
    expect(icon).not.toBeNull();

    for (const part of [downloadButton, ring, dot, icon]) {
      expect(pressStartsWindowDrag(part as Element)).toBe(false);
    }
    expect(pressStartsWindowDrag(slot as Element)).toBe(true);
    expect(pressStartsWindowDrag(titlebar)).toBe(true);
    expect(titlebar.lastElementChild).toBe(slot);
    // 단추는 자리 안에 서고 끌기 속성을 갖지 않는다.
    expect(slot?.contains(downloadButton as Node)).toBe(true);
    expect(downloadButton?.hasAttribute("data-tauri-drag-region")).toBe(false);
  });
});

describe("끌기 판정 모형의 자기 검증", () => {
  // 모형이 항상 true/false만 답하면 위 단정은 아무것도 지키지 않는다. 같은 모형이 속성이 있는 단추는 끌기라고,
  // 속성이 없는 자식은 끌기가 아니라고 답하는지 따로 잰다(Tauri 문서의 세 규칙).
  it("속성이 있는 단추는 끌기이고, 속성만 있는 칸의 자식과 `false`·클릭 가능한 칸은 끌기가 아니다", () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <div id="bare" data-tauri-drag-region><span id="child">글</span><button id="btn-with" data-tauri-drag-region>x</button></div>
      <div id="deep" data-tauri-drag-region="deep"><span id="deep-child">글</span><button id="deep-btn">x</button></div>
      <div id="off" data-tauri-drag-region="false"></div>`;
    document.body.append(host);
    try {
      const get = (id: string) => host.querySelector(`#${id}`) as Element;
      expect(pressStartsWindowDrag(get("bare"))).toBe(true);
      expect(pressStartsWindowDrag(get("child"))).toBe(false); // 자식은 상속하지 않는다
      expect(pressStartsWindowDrag(get("btn-with"))).toBe(true); // 속성이 있는 단추는 끌기다
      expect(pressStartsWindowDrag(get("deep-child"))).toBe(true);
      expect(pressStartsWindowDrag(get("deep-btn"))).toBe(false); // deep이어도 단추는 막는다
      expect(pressStartsWindowDrag(get("off"))).toBe(false);
    } finally {
      host.remove();
    }
  });
});
