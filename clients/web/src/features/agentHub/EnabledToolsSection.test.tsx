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
} {
  const save = vi.fn<(tools: string[]) => Promise<ToolsSaveResult>>();
  save.mockResolvedValue({ ok: true });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const props: EnabledToolsSectionProps = {
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
  const tree: ReactElement = createElement(EnabledToolsSection, props);
  act(() => {
    mountedRoot?.render(tree);
  });
  return { host, save };
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
    const style = document.createElement("style");
    style.textContent = ".opacity-50 { opacity: 0.5; }";
    document.head.append(style);
    const { host } = mount();
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-hub-enabled-tools-save"]'
    );
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.className).toMatch(/\bopacity-50\b/);
    expect(Number(getComputedStyle(button!).opacity)).toBeLessThan(1);
    act(() => {
      toggle(host, LONG_NAME).click();
    });
    expect(button?.getAttribute("aria-disabled")).toBeNull();
    expect(button?.className).not.toMatch(/\bopacity-50\b/);
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

  it("H-3: 켜진 토글의 클래스 목록에 on-fill 포커스 링이 있다", () => {
    const { host } = mount();
    const checked = toggle(host, "work.session.spawn");
    const row = host.querySelector(
      '[data-testid="agent-hub-tool-row-work.session.spawn"]'
    );
    const classes = `${checked.className} ${row?.className ?? ""}`;
    expect(classes).toContain("focus-ring-on-fill");
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
    expect(locked?.className).toMatch(/cursor-default/);
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
    first.focus();
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
});
