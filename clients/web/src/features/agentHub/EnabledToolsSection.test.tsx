// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DECLARED_ONLY_REASON } from "@momo/core/features/agents/toolCatalog";
import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import { INLINE_CONFIRM_MS } from "@/design/ui/inlineConfirm";
import { UNKNOWN_TOOL_CHIP } from "./enabledToolsModel";
import {
  EnabledToolsSection,
  type EnabledToolsSectionProps,
  type ToolsSaveResult,
} from "./EnabledToolsSection";

const LONG_NAME =
  "deploy.rollback.session-end-with-a-very-long-qualified-name";

const CATALOG: AgentToolCatalogEntry[] = [
  {
    name: LONG_NAME,
    description:
      "배포 전 롤백 절차를 확인한 뒤에만 쓰는 작업 세션 종료입니다. 호스트 상태와 정산 원장을 닫으며, 한 번 실행하면 같은 세션으로 되돌리지 못합니다.",
    executable: true,
    requiresApproval: true,
    unavailableReason: null,
  },
  {
    name: "work.session.spawn",
    description:
      "등록된 호스트에서 코딩 도구를 새 작업 세션으로 시작합니다. 승인하는 사람이 호스트를 고릅니다.",
    executable: true,
    requiresApproval: true,
    unavailableReason: null,
  },
  {
    name: "work.session.resume",
    description: "멈춘 작업 세션을 이어서 시작합니다.",
    executable: false,
    requiresApproval: true,
    unavailableReason: DECLARED_ONLY_REASON,
  },
];

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
  vi.useRealTimers();
});

function mount(
  over: Partial<EnabledToolsSectionProps> = {}
): {
  host: HTMLElement;
  save: ReturnType<typeof vi.fn<(tools: string[]) => Promise<ToolsSaveResult>>>;
  remount: (next?: Partial<EnabledToolsSectionProps>) => void;
} {
  const save = vi.fn<(tools: string[]) => Promise<ToolsSaveResult>>();
  save.mockResolvedValue({ ok: true });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  let props: EnabledToolsSectionProps = {
    catalog: CATALOG,
    catalogStatus: "ready",
    catalogMessage: null,
    enabledTools: ["work.session.spawn"],
    offline: false,
    editable: true,
    editDisabledReason: null,
    save,
    ...over,
  };
  const render = (next: EnabledToolsSectionProps) => {
    const tree: ReactElement = createElement(EnabledToolsSection, next);
    act(() => {
      mountedRoot?.render(tree);
    });
  };
  render(props);
  return {
    host,
    save,
    remount(next: Partial<EnabledToolsSectionProps> = {}) {
      props = { ...props, ...next };
      render(props);
    },
  };
}

function injectSaveOpacityCss(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    button { opacity: 1; }
    .opacity-50 { opacity: 0.5; }
    .hover\\:opacity-90:hover, .is-hovered.hover\\:opacity-90 { opacity: 0.9; }
    .hover\\:opacity-50:hover, .is-hovered.hover\\:opacity-50 { opacity: 0.5; }
    .pointer-events-none { pointer-events: none; }
  `;
  document.head.append(style);
  return style;
}

function liveTabStops(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-tool-toggle]")].filter(
    (el) => el.tabIndex === 0
  );
}

function toggle(host: HTMLElement, name: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    `[data-testid="agent-hub-tool-toggle-${name}"]`
  );
  if (!input) throw new Error(`missing toggle ${name}`);
  return input;
}

describe("EnabledToolsSection", () => {
  it("토글 추가 후 저장하면 PUT 본문 enabledTools 에 그 이름이 실린다", async () => {
    const { host, save } = mount();
    act(() => {
      toggle(host, LONG_NAME).click();
    });
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-hub-enabled-tools-save"]'
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual([LONG_NAME, "work.session.spawn"]);
  });

  it("토글 제거 후 저장하면 PUT 본문에서 그 이름이 빠진다", async () => {
    const { host, save } = mount();
    act(() => {
      toggle(host, "work.session.spawn").click();
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-hub-enabled-tools-save"]'
        )
        ?.click();
    });
    expect(save.mock.calls[0]?.[0]).toEqual([]);
  });

  it("실행 불가 항목은 aria-disabled 이고 사유가 낭독되며 토글되지 않는다", () => {
    const { host } = mount();
    const input = toggle(host, "work.session.resume");
    expect(input.getAttribute("aria-disabled")).toBe("true");
    const described = input.getAttribute("aria-describedby") ?? "";
    const reason = described
      .split(" ")
      .map((id) => host.querySelector(`[id="${id}"]`)?.textContent ?? "")
      .join(" ");
    expect(reason).toContain(DECLARED_ONLY_REASON);
    const row = host.querySelector(
      '[data-testid="agent-hub-tool-row-work.session.resume"]'
    );
    expect(row?.textContent).toContain("실행 불가");
    expect(row?.textContent).not.toContain("선언만");
    const before = input.checked;
    act(() => {
      input.click();
    });
    expect(input.checked).toBe(before);
  });

  it("403 이면 읽기 전용으로 바뀌고 사유가 붙는다", async () => {
    const save = vi.fn<(tools: string[]) => Promise<ToolsSaveResult>>();
    save.mockResolvedValue({
      ok: false,
      forbidden: true,
      message: "이 계정으로는 이 에이전트의 도구 허용을 바꿀 수 없습니다.",
    });
    const { host } = mount({ save });
    act(() => {
      toggle(host, LONG_NAME).click();
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-hub-enabled-tools-save"]'
        )
        ?.click();
    });
    const banner = host.querySelector(
      '[data-testid="agent-hub-enabled-tools-forbidden"]'
    );
    expect(banner?.textContent).toContain(
      "이 계정으로는 이 에이전트의 도구 허용을 바꿀 수 없습니다."
    );
    expect(toggle(host, LONG_NAME).getAttribute("aria-disabled")).toBe("true");
    expect(toggle(host, "work.session.spawn").getAttribute("aria-disabled")).toBe(
      "true"
    );
  });

  it("저장 실패면 배너가 뜨고 토글은 편집 상태를 유지한다", async () => {
    const save = vi.fn<(tools: string[]) => Promise<ToolsSaveResult>>();
    save.mockResolvedValue({
      ok: false,
      forbidden: false,
      message: "도구 허용을 저장하지 못했습니다. 연결을 확인하고 다시 시도하세요.",
    });
    const { host } = mount({ save });
    act(() => {
      toggle(host, LONG_NAME).click();
    });
    expect(toggle(host, LONG_NAME).checked).toBe(true);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-hub-enabled-tools-save"]'
        )
        ?.click();
    });
    expect(
      host.querySelector('[data-testid="agent-hub-enabled-tools-error"]')
        ?.textContent
    ).toContain("도구 허용을 저장하지 못했습니다");
    expect(toggle(host, LONG_NAME).checked).toBe(true);
    expect(toggle(host, "work.session.spawn").checked).toBe(true);
  });

  it("서버가 보낸 모르는 도구 이름은 렌더하되 승인 필요 표지를 단다", () => {
    const { host } = mount({
      enabledTools: ["work.session.spawn", "web.search"],
    });
    const row = host.querySelector(
      '[data-testid="agent-hub-tool-row-web.search"]'
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("승인 필요");
    expect(toggle(host, "web.search").checked).toBe(true);
  });

  it("B-1: rest 저장은 aria-disabled 이고 흐리며, dirty 면 풀린다", () => {
    const style = injectSaveOpacityCss();
    const { host, save } = mount();
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-hub-enabled-tools-save"]'
    );
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.hasAttribute("disabled")).toBe(false);
    expect(Number(getComputedStyle(button!).opacity)).toBe(0.5);
    expect(getComputedStyle(button!).pointerEvents).toBe("none");
    act(() => {
      button?.click();
    });
    expect(save).not.toHaveBeenCalled();
    act(() => {
      toggle(host, LONG_NAME).click();
    });
    expect(button?.getAttribute("aria-disabled")).toBeNull();
    expect(Number(getComputedStyle(button!).opacity)).toBe(1);
    expect(getComputedStyle(button!).pointerEvents).not.toBe("none");
    expect(button?.className).not.toMatch(/(?:^|\s)opacity-50(?:\s|$)/);
    style.remove();
  });

  it("H-2: shell 이 카탈로그에 없으면 실행 가능 칩을 달지 않는다", () => {
    const { host } = mount({
      enabledTools: ["work.session.spawn", "shell"],
    });
    const row = host.querySelector('[data-testid="agent-hub-tool-row-shell"]');
    expect(row?.textContent).toContain(UNKNOWN_TOOL_CHIP);
    expect(row?.textContent).not.toContain("실행 가능");
  });

  it("H-3R: 켜진 행은 표준 링을 그리고 on-fill 은 없다", () => {
    const { host } = mount();
    const row = host.querySelector(
      '[data-testid="agent-hub-tool-row-work.session.spawn"]'
    );
    expect(row?.className).toMatch(/has-\[:focus-visible\]:focus-ring/);
    expect(row?.className).not.toContain("focus-ring-on-fill");
    expect(row?.className).toContain("bg-accent-soft");
  });

  it("H-4: 이름 클릭이 토글하고, 잠긴 행은 hover 틴트가 없다", () => {
    const { host } = mount();
    const name = host.querySelector("#agent-hub-tool-0-name");
    expect(toggle(host, LONG_NAME).checked).toBe(false);
    act(() => {
      (name as HTMLElement).click();
    });
    expect(toggle(host, LONG_NAME).checked).toBe(true);
    const locked = host.querySelector(
      '[data-testid="agent-hub-tool-row-work.session.resume"]'
    );
    expect(locked?.className).not.toMatch(/hover:bg-surface-hover/);
    expect(locked?.className).toMatch(/cursor-not-allowed/);
  });

  it("M-1: 빈 카탈로그는 한 문장이고 저장 버튼이 없다", () => {
    const { host } = mount({ catalog: [], enabledTools: [] });
    expect(host.textContent).toContain("이 서버가 공개한 도구가 없습니다");
    expect(
      host.querySelector('[data-testid="agent-hub-enabled-tools-save"]')
    ).toBeNull();
  });

  it("M-2: 첫 토글에서 Tab 한 번에 저장으로 간다", () => {
    const { host } = mount();
    const first = toggle(host, LONG_NAME);
    const save = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-hub-enabled-tools-save"]'
    );
    const tabbable = [
      ...host.querySelectorAll<HTMLElement>("input, button"),
    ].filter((el) => el.tabIndex !== -1);
    const index = tabbable.indexOf(first);
    expect(index).toBeGreaterThan(-1);
    expect(tabbable[index + 1]).toBe(save);
    expect(
      tabbable.filter((el) => el.hasAttribute("data-tool-toggle"))
    ).toHaveLength(1);
  });

  it("화살표로 토글을 로빙하고 Space 로 켜며 ⌘↵ 로 저장한다", async () => {
    const { host, save } = mount();
    const first = toggle(host, LONG_NAME);
    const second = toggle(host, "work.session.spawn");
    act(() => {
      first.focus();
    });
    expect(document.activeElement).toBe(first);
    act(() => {
      first.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(document.activeElement).toBe(second);
    act(() => {
      first.focus();
      first.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(first.checked).toBe(true);
    const section = host.querySelector(
      '[data-testid="agent-hub-enabled-tools"]'
    );
    await act(async () => {
      section?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(PRIMARY_ACTION_SHORTCUT.matches({ key: "Enter", metaKey: true })).toBe(
      true
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual([LONG_NAME, "work.session.spawn"]);
  });

  it("저장 성공은 토스트 없이 버튼 라벨이 저장됨으로 바뀌고 1.6초 뒤 돌아온다", async () => {
    vi.useFakeTimers();
    const { host } = mount();
    act(() => {
      toggle(host, LONG_NAME).click();
    });
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-hub-enabled-tools-save"]'
    );
    await act(async () => {
      button?.click();
    });
    expect(button?.textContent).toContain("도구 변경 저장됨");
    expect(button?.getAttribute("aria-live")).toBe("polite");
    act(() => {
      vi.advanceTimersByTime(INLINE_CONFIRM_MS);
    });
    expect(button?.textContent).toContain("도구 변경 저장");
    expect(button?.textContent).not.toContain("저장됨");
  });

  it("H-5: 잠긴 행에 포커스해도 Tab 정거장은 살아있는 행에 남는다", () => {
    const { host } = mount();
    act(() => {
      toggle(host, "work.session.resume").focus();
    });
    const stops = liveTabStops(host);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.getAttribute("data-tool-name")).not.toBe(
      "work.session.resume"
    );
    expect(stops[0]?.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("H-5: 첫 살아있는 토글에서 ArrowDown 은 두 번째로 가고 세 번째(잠긴 행)를 건너뛴다", () => {
    const { host } = mount();
    const first = toggle(host, LONG_NAME);
    const second = toggle(host, "work.session.spawn");
    const locked = toggle(host, "work.session.resume");
    act(() => {
      first.focus();
    });
    act(() => {
      first.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(document.activeElement).toBe(second);
    expect(document.activeElement).not.toBe(locked);
  });

  it("H-5: roveName 행이 사라지면 그룹에 Tab 정거장이 하나 남는다", () => {
    const { host, remount } = mount({
      enabledTools: ["work.session.spawn", "shell"],
    });
    act(() => {
      toggle(host, "shell").focus();
    });
    remount({ enabledTools: ["work.session.spawn"] });
    expect(liveTabStops(host)).toHaveLength(1);
  });

  it("M-7: 저장됨 수령증은 흐리지 않는다", async () => {
    vi.useFakeTimers();
    const style = injectSaveOpacityCss();
    const { host, remount } = mount();
    act(() => {
      toggle(host, LONG_NAME).click();
    });
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-hub-enabled-tools-save"]'
    );
    await act(async () => {
      button?.click();
    });
    remount({
      enabledTools: [LONG_NAME, "work.session.spawn"],
    });
    const receipt = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-hub-enabled-tools-save"]'
    );
    expect(receipt?.textContent).toContain("도구 변경 저장됨");
    expect(receipt?.getAttribute("aria-disabled")).toBe("true");
    expect(Number(getComputedStyle(receipt!).opacity)).toBe(1);
    expect(receipt?.className).not.toMatch(/(?:^|\s)opacity-50(?:\s|$)/);
    expect(getComputedStyle(receipt!).pointerEvents).toBe("none");
    style.remove();
  });

  it("M-8: 표시 전용은 저장을 약속하지 않는다", () => {
    const { host } = mount({
      catalog: null,
      catalogStatus: "absent",
      enabledTools: ["work.session.spawn"],
    });
    expect(host.textContent).not.toContain("저장해야");
    expect(host.textContent).toContain("이 에이전트에 허용된 도구입니다.");
    expect(
      host.querySelector('[data-testid="agent-hub-enabled-tools-save"]')
    ).toBeNull();
  });

  it("M-8: 카탈로그가 온 편집기만 저장 문장을 말한다", () => {
    const { host } = mount();
    expect(host.textContent).toContain(
      "바꾼 뒤에는 저장해야 반영됩니다"
    );
  });

  it("M-9: 모르는 표식은 중립 그릇이고 승인 필요는 warn 그릇이다", () => {
    const { host } = mount({
      enabledTools: ["work.session.spawn", "shell"],
    });
    const row = host.querySelector('[data-testid="agent-hub-tool-row-shell"]');
    const spans = [...(row?.querySelectorAll("span") ?? [])];
    const unknown = spans.find((el) => el.textContent === UNKNOWN_TOOL_CHIP);
    const approval = spans.find((el) => el.textContent === "승인 필요");
    expect(unknown?.className).toMatch(/bg-muted-soft/);
    expect(unknown?.className).not.toMatch(/border-warn/);
    expect(approval?.className).toMatch(/bg-warn-soft/);
    expect(approval?.className).toMatch(/text-warn/);
    expect(approval?.className).not.toMatch(/border-warn/);
  });

  it("M-10: 편집 잠금 사유는 형제처럼 눈에 보인다", () => {
    const reason = "이 서버가 프로필 편집을 받는지 확인 중입니다.";
    const { host } = mount({
      editable: false,
      editDisabledReason: reason,
    });
    const line = [...host.querySelectorAll("p")].find((el) =>
      el.textContent?.includes(reason)
    );
    expect(line).toBeDefined();
    expect(line?.className).not.toMatch(/\bsr-only\b/);
    expect(line?.className).toMatch(/text-meta/);
  });

  it("N-13: 잠긴 행에서 ArrowDown 은 DOM 아래의 다음 live 로 간다", () => {
    const { host } = mount();
    const locked = toggle(host, "work.session.resume");
    const first = toggle(host, LONG_NAME);
    const second = toggle(host, "work.session.spawn");
    act(() => {
      locked.focus();
    });
    act(() => {
      locked.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(document.activeElement).toBe(first);
    expect(document.activeElement).not.toBe(second);
  });

  it("N-15: 읽기 전용에서도 Tab 정거장이 하나 있다", () => {
    const { host } = mount({
      editable: false,
      editDisabledReason: "이 서버가 프로필 편집을 받는지 확인 중입니다.",
    });
    expect(liveTabStops(host)).toHaveLength(1);
  });
});
