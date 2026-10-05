// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HostedWizardLaunch } from "@/features/hostedAgents/hostedWizardLaunch";
import { CreateAgentFlow } from "./CreateAgentFlow";

// #3523: 「외부」를 고르면 위저드 앞에 프리셋 고르기가 서고, 고른 프리셋이 위저드 시작 값이 된다.
// 추천은 감지가 앱을 봤을 때만, 웹에서도 프리셋은 고를 수 있다, dots 는 눌러도 아무 데도 안 간다.

const probe = vi.hoisted(() => ({ value: { desktop: false, ready: true, probes: [] as unknown[] } }));
const wizardLaunch = vi.hoisted(() => ({ value: undefined as HostedWizardLaunch | null | undefined, opens: 0 }));

vi.mock("@/features/hostedAgents/useHostedAgentProbe", () => ({ useHostedAgentProbe: () => probe.value }));
vi.mock("@/features/hostedAgents/HostedAgentWizard", () => ({
  HostedAgentWizard: ({ open, launch }: { open: boolean; launch?: HostedWizardLaunch | null }) => {
    if (open) {
      wizardLaunch.value = launch;
      wizardLaunch.opens += 1;
    }
    return open ? createElement("div", { "data-testid": "fake-wizard" }) : null;
  },
}));
vi.mock("@/features/agentHub/CreateAgentDialog", () => ({ CreateAgentDialog: () => null }));
vi.mock("@/features/welcome/harnessLogin/SubscriptionAgentStart", () => ({ SubscriptionAgentStart: () => null }));
vi.mock("@/features/welcome/SubscriptionAgentEntry", () => ({ useSubscriptionEntryState: () => "desktop-only" }));
vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>()),
  isSurfaceProvided: () => true,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = root = null;
  document.body.innerHTML = "";
  wizardLaunch.value = undefined;
  wizardLaunch.opens = 0;
});

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(CreateAgentFlow, { open: true, onOpenChange: () => {}, mayCreate: true }));
  });
}

function toPicker() {
  act(() => fireEvent.click(q("create-kind-external") as HTMLElement));
}

describe("CreateAgentFlow 외부 프리셋 (#3523)", () => {
  it("웹: 추천 없이 그록봇·일반을 고를 수 있고 dots 는 곧 지원으로 잠긴다", () => {
    probe.value = { desktop: false, ready: true, probes: [] };
    mount();
    toPicker();
    expect(q("external-preset-picker")).not.toBeNull();
    expect(q("external-preset-grok")?.getAttribute("data-state")).toBe("available");
    expect(q("external-preset-grok")?.getAttribute("data-recommended")).toBeNull();
    expect(q("external-preset-grok-badge")).toBeNull();
    expect(q("external-preset-dots")?.getAttribute("aria-disabled")).toBe("true");
    expect(q("external-preset-dots-badge")?.textContent).toBe("곧 지원");
    act(() => fireEvent.click(q("external-preset-dots") as HTMLElement));
    expect(q("fake-wizard")).toBeNull();
    expect(q("external-preset-picker")).not.toBeNull();
    act(() => fireEvent.click(q("external-preset-generic") as HTMLElement));
    expect(q("fake-wizard")).not.toBeNull();
    expect(wizardLaunch.value).toEqual({ presetId: "generic", displayName: "", handle: "" });
  });

  it("데스크탑에서 앱이 보이면 그록봇이 추천이고 위저드에 이름·핸들이 프리필된다", () => {
    probe.value = { desktop: true, ready: true, probes: [{ id: "grok", bundlePresent: true, processRunning: false }] };
    mount();
    toPicker();
    expect(q("external-preset-grok")?.getAttribute("data-recommended")).toBe("true");
    expect(q("external-preset-grok-badge")?.textContent).toBe("추천");
    act(() => fireEvent.click(q("external-preset-grok") as HTMLElement));
    expect(wizardLaunch.value).toEqual({ presetId: "grok", displayName: "그록봇", handle: "grokbot" });
  });

  it("데스크탑에서 앱을 못 찾았으면 추천하지 않고 이어갈 수 있다", () => {
    probe.value = { desktop: true, ready: true, probes: [{ id: "grok", bundlePresent: false, processRunning: false }] };
    mount();
    toPicker();
    expect(q("external-preset-grok")?.getAttribute("data-recommended")).toBeNull();
    expect(q("external-preset-grok")?.textContent).toContain("이 컴퓨터에서는 앱을 찾지 못했어요");
    expect(q("external-preset-grok")?.getAttribute("data-state")).toBe("available");
  });
});
