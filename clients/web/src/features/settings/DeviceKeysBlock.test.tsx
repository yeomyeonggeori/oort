// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import type { DesktopDeviceKeyStatus } from "@/lib/tauri";
import { DevicesSection } from "./DevicesSection";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const ROOT_ID = "00000000-0000-7000-8000-00000000d001";
const PHONE_ID = "00000000-0000-7000-8000-00000000d002";
const MAC_KEY = "Al5MJdwsIiT7groXgUDS9kC6VMwSS1QutnuZEZlbxi5S";
const PHONE_KEY = "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW";
const PHONE_LABEL = "성재의 iPhone 16 Pro";

const desktop = vi.hoisted(() => ({
  isDesktop: vi.fn(() => true),
  status: vi.fn(),
  create: vi.fn(),
  bindRoot: vi.fn(),
  signEndorse: vi.fn(),
  signRevoke: vi.fn(),
}));
const core = vi.hoisted(() => ({
  listDeviceKeys: vi.fn(),
  registerRootDeviceKey: vi.fn(),
  submitEndorsement: vi.fn(),
  submitRevocation: vi.fn(),
  listLinkedDevices: vi.fn(),
  revokeLinkedDevice: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isDesktop: () => desktop.isDesktop(),
    desktopDeviceKey: {
      status: (...a: unknown[]) => desktop.status(...a),
      create: (...a: unknown[]) => desktop.create(...a),
      bindRoot: (...a: unknown[]) => desktop.bindRoot(...a),
      signEndorse: (...a: unknown[]) => desktop.signEndorse(...a),
      signRevoke: (...a: unknown[]) => desktop.signRevoke(...a),
      signControl: vi.fn(),
      deliverRevocation: vi.fn(),
    },
  };
});

vi.mock("@momo/core/features/auth/deviceKeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/auth/deviceKeys")>();
  return {
    ...actual,
    listDeviceKeys: (...a: unknown[]) => core.listDeviceKeys(...a),
    registerRootDeviceKey: (...a: unknown[]) => core.registerRootDeviceKey(...a),
    submitEndorsement: (...a: unknown[]) => core.submitEndorsement(...a),
    submitRevocation: (...a: unknown[]) => core.submitRevocation(...a),
  };
});

vi.mock("@momo/core/features/auth/linkedDevices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/auth/linkedDevices")>();
  return {
    ...actual,
    listLinkedDevices: (...a: unknown[]) => core.listLinkedDevices(...a),
    revokeLinkedDevice: (...a: unknown[]) => core.revokeLinkedDevice(...a),
  };
});

vi.mock("@momo/core/features/auth/deviceLink", () => ({
  issueDeviceLink: vi.fn(),
  getDeviceLink: vi.fn(),
  confirmDeviceLinkSas: vi.fn(),
  DEVICE_LINK_POLL_INTERVAL_MS: 2_000,
}));

function localStatus(overrides: Partial<DesktopDeviceKeyStatus> = {}): DesktopDeviceKeyStatus {
  return {
    support: "ready",
    detail: null,
    publicKey: MAC_KEY,
    fingerprint: "6A1C 20F4 9B33 0D7E 51AA",
    root: { keyId: ROOT_ID, memberId: ME, publicKey: MAC_KEY },
    reuseWindowSeconds: 300,
    host: { running: true, matches: true, pinnedRootKeyId: ROOT_ID },
    ...overrides,
  };
}

function key(overrides: Record<string, unknown> = {}) {
  return {
    id: PHONE_ID,
    workspaceId: WS,
    memberId: ME,
    alg: "p256",
    publicKey: PHONE_KEY,
    platform: "ios",
    label: PHONE_LABEL,
    state: "unendorsed",
    canInstruct: false,
    current: false,
    createdAtMs: 1_790_550_000_000,
    ...overrides,
  };
}

const rootRow = key({
  id: ROOT_ID,
  platform: "macos",
  publicKey: MAC_KEY,
  label: "Mac",
  state: "root",
  canInstruct: true,
  current: true,
});

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let hostEl: HTMLElement | null = null;

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

beforeEach(() => {
  for (const fn of [...Object.values(desktop), ...Object.values(core)]) fn.mockReset();
  desktop.isDesktop.mockReturnValue(true);
  desktop.status.mockResolvedValue(localStatus());
  core.listDeviceKeys.mockResolvedValue([rootRow, key()]);
  core.listLinkedDevices.mockResolvedValue({ devices: [] });
  core.revokeLinkedDevice.mockResolvedValue(undefined);
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
  if (root) act(() => root?.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  resetEscapeLayers();
});

function mount(): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DevicesSection, { offline: false, workspaceId: WS, memberId: ME })
      )
    )
  );
  return hostEl;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 4000) throw new Error(label);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function q<T extends HTMLElement = HTMLElement>(host: HTMLElement, testId: string): T | null {
  return host.querySelector<T>(`[data-testid="${testId}"]`);
}

async function click(el: HTMLElement | null, label: string) {
  expect(el, label).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

describe("설정 › 기기 › 지시 서명 (#3025)", () => {
  it("브라우저 탭에서는 그리지 않는다 (서명 키는 데스크탑 셸에만 있다)", async () => {
    desktop.isDesktop.mockReturnValue(false);
    const host = mount();
    await waitFor(() => host.textContent?.includes("연결된 기기") ?? false, "list");
    expect(q(host, "device-keys")).toBeNull();
    expect(desktop.status).not.toHaveBeenCalled();
  });

  it("서명 안 된 빌드는 서명 불가를 말하고 등록 문을 내지 않는다 (소프트웨어 대체 없음)", async () => {
    desktop.status.mockResolvedValue(
      localStatus({
        support: "unsigned_build",
        detail: "device_key_unsigned_build",
        publicKey: null,
        fingerprint: null,
        root: null,
      })
    );
    const host = mount();
    await waitFor(() => q(host, "device-key-root-unsupported") !== null, "unsupported");
    expect(host.textContent).toContain("서명되지 않아 Secure Enclave 키를 쓸 수 없습니다");
    expect(q(host, "device-key-root-start")).toBeNull();
    expect(q(host, "device-keys")?.dataset.deviceKeyBound).toBe("false");
    expect(q(host, "device-key-endorse-start")?.getAttribute("aria-disabled")).toBe("true");
    await click(q(host, "device-key-endorse-start"), "locked endorse");
    expect(q(host, "device-key-endorse-confirm")).toBeNull();
    expect(desktop.create).not.toHaveBeenCalled();
  });

  it("뿌리 등록: 키 생성 → 비밀번호와 함께 서버 등록 → 서버 key id로 셸에 묶는다", async () => {
    desktop.status.mockResolvedValue(
      localStatus({ support: "absent", publicKey: null, fingerprint: null, root: null })
    );
    core.listDeviceKeys.mockResolvedValue([key()]);
    desktop.create.mockResolvedValue(localStatus({ root: null }));
    core.registerRootDeviceKey.mockResolvedValue(rootRow);
    desktop.bindRoot.mockResolvedValue({
      status: localStatus(),
      host: { state: "delivered" },
    });
    const host = mount();
    await waitFor(() => q(host, "device-key-root-start") !== null, "start");
    await click(q(host, "device-key-root-start"), "start");
    const input = q<HTMLInputElement>(host, "device-key-root-password")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "correct horse");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(q(host, "device-key-root-submit"), "submit");
    await waitFor(() => desktop.bindRoot.mock.calls.length === 1, "bind");
    expect(desktop.create).toHaveBeenCalledTimes(1);
    expect(core.registerRootDeviceKey).toHaveBeenCalledWith(WS, {
      publicKey: MAC_KEY,
      label: "Mac",
      currentPassword: "correct horse",
    });
    expect(desktop.bindRoot).toHaveBeenCalledWith({
      workspaceId: WS,
      memberId: ME,
      keyId: ROOT_ID,
      publicKey: MAC_KEY,
    });
  });

  it("비밀번호가 틀리면 서버 거절을 문장으로 말하고 셸에 묶지 않는다", async () => {
    desktop.status.mockResolvedValue(localStatus({ root: null }));
    core.listDeviceKeys.mockResolvedValue([key()]);
    core.registerRootDeviceKey.mockRejectedValue(
      new ApiError(403, "needs password", "device_root_password_required")
    );
    const host = mount();
    await waitFor(() => q(host, "device-key-root-start") !== null, "start");
    await click(q(host, "device-key-root-start"), "start");
    const input = q<HTMLInputElement>(host, "device-key-root-password")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "wrong");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(q(host, "device-key-root-submit"), "submit");
    await waitFor(() => host.textContent?.includes("비밀번호가 맞지 않습니다") ?? false, "error");
    expect(desktop.bindRoot).not.toHaveBeenCalled();
  });

  it("셸에 묶인 키라도 서버 행이 끝났으면 뿌리가 아니다: 다시 등록을 묻고 승인은 잠근다", async () => {
    // Logout ends the lineage and the row (D-7); the shell still remembers the
    // old binding. Approving with it would sign under a key id the server
    // refuses, so the block must not read as bound.
    core.listDeviceKeys.mockResolvedValue([key(), { ...rootRow, state: "revoked" }]);
    const host = mount();
    await waitFor(() => q(host, "device-key-root-unbound") !== null, "unbound");
    expect(host.textContent).toContain("이 맥의 키 등록이 해제됐습니다");
    expect(q(host, "device-keys")?.dataset.deviceKeyBound).toBe("false");
    expect(q(host, "device-key-endorse-start")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("폰 승인: 지문을 보이고, 셸 서명 뒤 승인서를 서버에 낸다", async () => {
    desktop.signEndorse.mockResolvedValue({
      targetKeyId: PHONE_ID,
      rootKeyId: ROOT_ID,
      signature: "c2ln",
    });
    core.submitEndorsement.mockResolvedValue(key({ state: "endorsed" }));
    const host = mount();
    await waitFor(() => q(host, "device-key-endorse-start") !== null, "phone row");
    expect(q(host, "device-keys")?.dataset.deviceKeyBound).toBe("true");
    await click(q(host, "device-key-endorse-start"), "start");
    await waitFor(
      () => q(host, "device-key-endorse-fingerprint")?.textContent === "5BAF F89D E7DE 5C1D 7B61",
      "fingerprint"
    );
    await click(q(host, "device-key-endorse-submit"), "submit");
    await waitFor(() => core.submitEndorsement.mock.calls.length === 1, "submitted");
    expect(desktop.signEndorse).toHaveBeenCalledWith({
      workspaceId: WS,
      targetKeyId: PHONE_ID,
      targetAlg: "p256",
      targetPublicKey: PHONE_KEY,
      label: PHONE_LABEL,
    });
    expect(core.submitEndorsement).toHaveBeenCalledWith(WS, PHONE_ID, {
      rootKeyId: ROOT_ID,
      signature: "c2ln",
    });
  });

  it("승인 단계는 초점을 패널로 옮기고, 취소하면 승인 버튼으로 돌려놓는다", async () => {
    const host = mount();
    await waitFor(() => q(host, "device-key-endorse-start") !== null, "phone row");
    await click(q(host, "device-key-endorse-start"), "start");
    expect(document.activeElement).toBe(q(host, "device-key-endorse-confirm"));
    await act(async () => {
      q(host, "device-key-endorse-confirm")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(q(host, "device-key-endorse-confirm")).toBeNull();
    expect(document.activeElement).toBe(q(host, "device-key-endorse-start"));
  });

  it("네이티브 확인 창에서 취소하면 서버에 아무것도 내지 않는다", async () => {
    desktop.signEndorse.mockRejectedValue("device_key_declined");
    const host = mount();
    await waitFor(() => q(host, "device-key-endorse-start") !== null, "phone row");
    await click(q(host, "device-key-endorse-start"), "start");
    await click(q(host, "device-key-endorse-submit"), "submit");
    await waitFor(() => host.textContent?.includes("서명을 취소했습니다.") ?? false, "declined");
    expect(core.submitEndorsement).not.toHaveBeenCalled();
  });

  it("지시 권한 끊기: 폐기서를 서명해 서버에 내고, 로컬 작업 호스트 전달 결과를 말한다", async () => {
    core.listDeviceKeys.mockResolvedValue([rootRow, key({ state: "endorsed", canInstruct: true })]);
    desktop.signRevoke.mockResolvedValue({
      rootKeyId: ROOT_ID,
      targetKeyId: PHONE_ID,
      revokedAtMs: 1_790_551_000_000,
      signature: "cmV2",
      host: { state: "delivered" },
    });
    core.submitRevocation.mockResolvedValue(key({ state: "revoked" }));
    const host = mount();
    await waitFor(() => q(host, "device-key-revoke") !== null, "revoke");
    await click(q(host, "device-key-revoke"), "ask");
    await click(q(host, "device-key-revoke-confirm"), "confirm");
    await waitFor(() => core.submitRevocation.mock.calls.length === 1, "submitted");
    expect(desktop.signRevoke).toHaveBeenCalledWith({
      workspaceId: WS,
      targetKeyId: PHONE_ID,
      targetPublicKey: PHONE_KEY,
      targetLabel: PHONE_LABEL,
    });
    expect(core.submitRevocation).toHaveBeenCalledWith(WS, PHONE_ID, {
      rootKeyId: ROOT_ID,
      revokedAtMs: 1_790_551_000_000,
      signature: "cmV2",
    });
    await waitFor(
      () => host.textContent?.includes("이 맥의 작업 호스트에도 바로 알렸습니다.") ?? false,
      "delivery note"
    );
  });

  it("서버 제출이 실패하면 같은 폐기서로 다시 보내고, 다시 서명하지 않는다", async () => {
    core.listDeviceKeys.mockResolvedValue([rootRow, key({ state: "endorsed", canInstruct: true })]);
    desktop.signRevoke.mockResolvedValue({
      rootKeyId: ROOT_ID,
      targetKeyId: PHONE_ID,
      revokedAtMs: 9,
      signature: "cmV2",
      host: { state: "delivered" },
    });
    core.submitRevocation
      .mockRejectedValueOnce(new ApiError(500, "boom"))
      .mockResolvedValueOnce(key({ state: "revoked" }));
    const host = mount();
    await waitFor(() => q(host, "device-key-revoke") !== null, "revoke");
    await click(q(host, "device-key-revoke"), "ask");
    await click(q(host, "device-key-revoke-confirm"), "confirm");
    await waitFor(
      () => host.textContent?.includes("작업 호스트에는 알렸지만 서버에는 알리지 못했습니다") ?? false,
      "honest partial"
    );
    await click(q(host, "device-key-revoke"), "ask again");
    await click(q(host, "device-key-revoke-confirm"), "confirm again");
    await waitFor(() => core.submitRevocation.mock.calls.length === 2, "resubmitted");
    expect(desktop.signRevoke).toHaveBeenCalledTimes(1);
    expect(core.submitRevocation.mock.calls[1]).toEqual([
      WS,
      PHONE_ID,
      { rootKeyId: ROOT_ID, revokedAtMs: 9, signature: "cmV2" },
    ]);
  });

  it("연결 기기 해제: 같은 이름의 지시 기기 하나면 폐기서를 먼저 보내고 연결을 끊는다", async () => {
    core.listDeviceKeys.mockResolvedValue([rootRow, key({ state: "endorsed", canInstruct: true })]);
    core.listLinkedDevices.mockResolvedValue({
      devices: [
        { id: "link-1", label: PHONE_LABEL, platform: "ios", linkedAt: 1, current: false },
      ],
    });
    const order: string[] = [];
    desktop.signRevoke.mockImplementation(async () => {
      order.push("sign");
      return {
        rootKeyId: ROOT_ID,
        targetKeyId: PHONE_ID,
        revokedAtMs: 5,
        signature: "cmV2",
        host: { state: "notRunning" },
      };
    });
    core.submitRevocation.mockImplementation(async () => {
      order.push("letter");
      return key({ state: "revoked" });
    });
    core.revokeLinkedDevice.mockImplementation(async () => {
      order.push("unlink");
    });
    const host = mount();
    const trigger = () =>
      host.querySelector<HTMLButtonElement>(
        '[data-testid="linked-device-row-link-1"] [data-testid="linked-device-disconnect"]'
      );
    await waitFor(() => trigger() !== null, "linked row");
    await click(trigger(), "ask");
    await click(
      host.querySelector<HTMLButtonElement>(
        '[data-testid="linked-device-row-link-1"] [data-testid="linked-device-disconnect-confirm"]'
      ),
      "confirm"
    );
    await waitFor(() => order.length === 3, "all three");
    expect(order).toEqual(["sign", "letter", "unlink"]);
    await waitFor(() => q(host, "linked-devices-unlink-note") !== null, "note");
    expect(q(host, "linked-devices-unlink-note")?.textContent).toContain("지시 권한도 끊었습니다");
  });
});
