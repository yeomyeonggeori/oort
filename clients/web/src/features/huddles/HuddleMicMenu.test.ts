// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { catalog as enCatalog } from "@momo/core/i18n/generated/en-US";
import { createMessageCopy } from "@momo/core/testkit";
import { HuddleMicMenu } from "./HuddleMicMenu";
import { HUDDLE_MIC_KEYS } from "./micKeys";
import type { AudioInputDevicesState } from "./useAudioInputDevices";

// 공급자 없이 띄운 메뉴는 번들된 영어로 선다(`useFormatMessage`). 시험은 같은 생성물로 키를 풀어 그 문장을 찾는다.
const en = createMessageCopy({ messageLocale: "en-US", catalog: enCatalog });

const devicesState: AudioInputDevicesState = {
  permission: "granted",
  devices: [
    { deviceId: "mic-1", label: "MacBook Pro 마이크" },
    {
      deviceId: "mic-long",
      label: "A".repeat(66),
    },
  ],
};

vi.mock("./useAudioInputDevices", () => ({
  useAudioInputDevices: () => devicesState,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) {
        super(type, init);
      }
    } as unknown as typeof PointerEvent;
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

beforeEach(() => {
  devicesState.permission = "granted";
  devicesState.devices = [
    { deviceId: "mic-1", label: "MacBook Pro 마이크" },
    { deviceId: "mic-long", label: "A".repeat(66) },
  ];
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

afterAll(() => {
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

function Harness({
  gainStart = 50,
  busy = false,
  disabled = false,
  onGainChange,
}: {
  gainStart?: number;
  busy?: boolean;
  disabled?: boolean;
  onGainChange?: (gainPercent: number) => void;
}): ReactElement {
  const [gainPercent, setGainPercent] = useState(gainStart);
  return createElement(HuddleMicMenu, {
    selectedDeviceId: "mic-1",
    gainPercent,
    busy,
    disabled,
    onSelectDevice: () => undefined,
    onGainChange: (next) => {
      setGainPercent(next);
      onGainChange?.(next);
    },
  });
}

function mountMenu(props: Parameters<typeof Harness>[0] = {}): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(createElement(Harness, props)));
  return host;
}

async function openMenu(): Promise<HTMLElement> {
  const trigger = document.querySelector(
    '[data-testid="huddle-mic-devices"]'
  ) as HTMLButtonElement | null;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
    );
    trigger!.click();
  });
  return vi.waitFor(() => {
    const menu = document.querySelector('[data-testid="huddle-mic-menu"]');
    expect(menu).not.toBeNull();
    return menu as HTMLElement;
  });
}

async function pressKey(target: EventTarget, key: string) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("HuddleMicMenu copy and states", () => {
  it("names the pre-permission state as a sentence, not a radio list", async () => {
    devicesState.permission = "prompt";
    devicesState.devices = [];
    mountMenu();
    const menu = await openMenu();
    expect(menu.textContent).toContain(en(HUDDLE_MIC_KEYS.permissionPrompt));
    expect(menu.querySelector('[data-testid="huddle-mic-list"]')).toBeNull();
  });

  it("names a denied permission as a sentence", async () => {
    devicesState.permission = "denied";
    devicesState.devices = [];
    mountMenu();
    const menu = await openMenu();
    expect(menu.textContent).toContain(en(HUDDLE_MIC_KEYS.permissionDenied));
    expect(menu.querySelector('[data-testid="huddle-mic-list"]')).toBeNull();
  });

  it("names a device the browser left unnamed by its place in the list", async () => {
    devicesState.devices = [{ deviceId: "mic-x", label: "" }];
    mountMenu();
    const menu = await openMenu();
    const option = menu.querySelector('[data-testid="huddle-mic-option-mic-x"] .truncate');
    expect(option?.textContent).toBe(en("huddles.mic.unnamed", { number: 1 }));
    expect(option?.textContent).toBe("Microphone 1");
  });

  it("names an empty device list as a sentence", async () => {
    devicesState.permission = "granted";
    devicesState.devices = [];
    mountMenu();
    const menu = await openMenu();
    expect(menu.textContent).toContain(en(HUDDLE_MIC_KEYS.empty));
    expect(menu.querySelector('[data-testid="huddle-mic-list"]')).toBeNull();
  });

  it("lists devices as a radio group and keeps 100% on one line", async () => {
    mountMenu({ gainStart: 100 });
    const menu = await openMenu();
    expect(menu.querySelector('[data-testid="huddle-mic-list"]')).not.toBeNull();
    expect(menu.textContent).toContain(en(HUDDLE_MIC_KEYS.systemDefault));
    expect(menu.textContent).toContain(en(HUDDLE_MIC_KEYS.gain));
    expect(menu.className).toContain("max-w-menu-available");
    const value = menu.querySelector('[data-testid="huddle-mic-gain-value"]');
    expect(value?.textContent).toBe("100%");
    expect(value?.className).toContain("whitespace-nowrap");
    expect(value?.className).toContain("w-numeric-4");
    const long = menu.querySelector('[data-testid="huddle-mic-option-mic-long"]');
    expect(long?.querySelector(".truncate")?.textContent).toHaveLength(66);
  });
});

describe("HuddleMicMenu gain keyboard", () => {
  it("moves the slider from the focused menu item with ArrowLeft/ArrowRight", async () => {
    const seen: number[] = [];
    mountMenu({
      gainStart: 50,
      onGainChange: (value) => seen.push(value),
    });
    const menu = await openMenu();
    const item = menu.querySelector(
      '[data-testid="huddle-mic-gain-item"]'
    ) as HTMLElement | null;
    expect(item).not.toBeNull();
    item!.focus();
    await pressKey(item!, "ArrowRight");
    expect(seen.at(-1)).toBe(51);
    await pressKey(item!, "ArrowLeft");
    expect(seen.at(-1)).toBe(50);
  });

  it("locks picker rows and the slider with the same disabled flag", async () => {
    mountMenu({ disabled: true });
    const menu = await openMenu();
    const slider = menu.querySelector(
      '[data-testid="huddle-mic-gain"]'
    ) as HTMLInputElement | null;
    const option = menu.querySelector(
      '[data-testid="huddle-mic-option-default"]'
    ) as HTMLElement | null;
    expect(slider?.disabled).toBe(true);
    expect(option?.hasAttribute("data-disabled")).toBe(true);
  });
});
