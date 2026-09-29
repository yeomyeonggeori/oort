// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import type { DesktopDeviceKeyStatus } from "@/lib/tauri";
import { DevicesSection } from "./DevicesSection";
import { resetAutoRebindForTests } from "./deviceKeysShared";

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
  signRebind: vi.fn(),
  resetSignatureRequirement: vi.fn(),
}));
const core = vi.hoisted(() => ({
  listDeviceKeys: vi.fn(),
  registerRootDeviceKey: vi.fn(),
  submitEndorsement: vi.fn(),
  submitRevocation: vi.fn(),
  fetchSigningContext: vi.fn(),
  rebindDeviceKey: vi.fn(),
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
      signRebind: (...a: unknown[]) => desktop.signRebind(...a),
      resetSignatureRequirement: (...a: unknown[]) => desktop.resetSignatureRequirement(...a),
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
    fetchSigningContext: (...a: unknown[]) => core.fetchSigningContext(...a),
    rebindDeviceKey: (...a: unknown[]) => core.rebindDeviceKey(...a),
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
    lineageLive: true,
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
  resetAutoRebindForTests();
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
    await waitFor(() => q(host, "device-key-phone-notice") !== null, "notice");
    expect(document.activeElement).toBe(q(host, "device-key-phone-notice"));
  });

  describe("#3145 승인 화면: 등록 시각과 이름의 출처", () => {
    const NOW = 1_790_550_000_000 + 12 * 60_000;
    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function openApprove() {
      const host = mount();
      await waitFor(() => q(host, "device-key-endorse-start") !== null, "phone row");
      await click(q(host, "device-key-endorse-start"), "start");
      await waitFor(() => q(host, "device-key-endorse-origin") !== null, "origin");
      return host;
    }

    it("등록 시각을 상대 시간과 함께 보인다", async () => {
      const host = await openApprove();
      const registered = q(host, "device-key-endorse-registered")!.textContent!;
      expect(registered).toContain("등록 시각");
      expect(registered).toContain("12분 전");
    });

    it("QR 연결 때 알린 이름과 같으면 그렇게 말하되, 이름은 확인된 값이 아니라고 함께 말한다", async () => {
      core.listLinkedDevices.mockResolvedValue({
        devices: [{ id: "l1", label: PHONE_LABEL, platform: "ios", linkedAt: 1, current: false }],
      });
      const host = await openApprove();
      await waitFor(
        () => q(host, "device-key-endorse-name")?.dataset.nameOrigin === "matchesLink",
        "matches"
      );
      const text = q(host, "device-key-endorse-origin")!.textContent!;
      expect(text).toContain("QR로 연결할 때 폰이 알린 이름과 같습니다");
      expect(text).toContain("믿을 것은 지문입니다");
      expect(text).toContain(PHONE_LABEL);
      expect(q(host, "device-key-endorse-name-warning")).toBeNull();
    });

    it("연결된 기기 목록에 없는 이름이면 승인하지 말라고 말한다", async () => {
      core.listLinkedDevices.mockResolvedValue({
        devices: [{ id: "l1", label: "다른 폰", platform: "ios", linkedAt: 1, current: false }],
      });
      const host = await openApprove();
      await waitFor(
        () => q(host, "device-key-endorse-name")?.dataset.nameOrigin === "notInLinks",
        "not in links"
      );
      expect(q(host, "device-key-endorse-origin")!.textContent).toContain(
        "연결된 기기 목록에 없습니다"
      );
      // #3154 M2: the mismatch is a warning block, not a grey aside; the match is not.
      const warning = q(host, "device-key-endorse-name-warning")!;
      expect(warning.textContent).toContain("승인하지 않아야 합니다");
      expect(warning.className).toContain("text-danger");
      expect(warning.className).toContain("font-medium");
    });

    it("목록을 못 읽으면 대조하지 못했다고만 말하고 일치한다고 하지 않는다", async () => {
      core.listLinkedDevices.mockRejectedValue(new Error("offline"));
      const host = await openApprove();
      await waitFor(
        () => q(host, "device-key-endorse-name")?.dataset.nameOrigin === "unknown",
        "unknown"
      );
      const text = q(host, "device-key-endorse-origin")!.textContent!;
      expect(text).toContain("대조하지 못했습니다");
      expect(text).not.toContain("알린 이름과 같습니다");
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

describe("다시 연결 — 계보만 끝난 뿌리 키 (#3103, ADR-0146 D-7 증보 #3097)", () => {
  const SESSION = "00000000-0000-7000-8000-00000000c001";
  const muteRoot = { ...rootRow, current: false, lineageLive: false };
  const context = {
    instanceId: "inst",
    serverTimeMs: 1,
    maxLifetimeMs: 600_000,
    maxClockSkewMs: 300_000,
    humanControlSignatureRequired: true,
    hostRegisterSignatureRequired: false,
    sessionId: SESSION,
  };
  const letter = { keyId: ROOT_ID, publicKey: MAC_KEY, signedAtMs: 1_790_550_000_000, signature: "c2ln" };

  it("「다시 연결 필요」를 말하고 스스로 한 번 옮긴다: 셸이 편지에 서명, 서버에 rebind, 같은 id라 다시 묶지 않는다", async () => {
    core.listDeviceKeys.mockResolvedValue([muteRoot, key()]);
    core.fetchSigningContext.mockResolvedValue(context);
    let release: () => void = () => undefined;
    desktop.signRebind.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(letter)))
    );
    core.rebindDeviceKey.mockImplementation(async () => {
      core.listDeviceKeys.mockResolvedValue([rootRow, key()]);
      return { ...rootRow, current: true, lineageLive: true };
    });
    const host = mount();
    await waitFor(() => q(host, "device-key-root-relink") !== null, "relink panel");
    // Never 「뿌리」 while it signs nothing; the phone actions stay locked.
    expect(q(host, "device-keys")?.dataset.deviceKeyBound).toBe("false");
    expect(q(host, "device-key-endorse-start")?.getAttribute("aria-disabled")).toBe("true");
    await waitFor(() => desktop.signRebind.mock.calls.length === 1, "auto sign");
    await waitFor(() => host.textContent?.includes("다시 연결 중") ?? false, "pending chip");
    expect(desktop.signRebind).toHaveBeenCalledWith({
      workspaceId: WS,
      memberId: ME,
      keyId: ROOT_ID,
      sessionId: SESSION,
    });
    await act(async () => release());
    await waitFor(() => q(host, "device-key-root-bound") !== null, "bound again");
    expect(core.rebindDeviceKey).toHaveBeenCalledWith(WS, {
      publicKey: MAC_KEY,
      platform: "macos",
      label: "Mac",
      rebind: { signedAtMs: letter.signedAtMs, signature: "c2ln" },
    });
    expect(desktop.bindRoot).not.toHaveBeenCalled();
    expect(host.textContent).toContain("이 맥의 서명 키를 이 로그인에 다시 연결했습니다.");
  });

  it("옮기지 못하면 정직하게 말하고, 다시 묻는 일은 버튼으로만 한다 (확인 창 폭주 없음)", async () => {
    core.listDeviceKeys.mockResolvedValue([muteRoot, key()]);
    core.fetchSigningContext.mockResolvedValue(context);
    desktop.signRebind.mockResolvedValue(letter);
    // The server answered 200 but the row is not this sign-in's.
    const { DeviceKeyRebindError } = await import("@momo/core/features/auth/deviceKeys");
    core.rebindDeviceKey.mockRejectedValue(new DeviceKeyRebindError());
    const host = mount();
    await waitFor(() => q(host, "device-key-relink-error") !== null, "error");
    expect(q(host, "device-key-relink-error")?.textContent).toBe(
      "서버가 이 키를 이 로그인으로 옮기지 않았습니다. 목록을 다시 불러와 다시 시도하세요."
    );
    expect(host.textContent).toContain("다시 연결 필요");
    // Settling refetched the list; the automatic attempt does not repeat.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(desktop.signRebind).toHaveBeenCalledTimes(1);
    desktop.signRebind.mockRejectedValue("device_key_declined");
    await click(q(host, "device-key-relink"), "retry");
    await waitFor(() => desktop.signRebind.mock.calls.length === 2, "manual");
    await waitFor(
      () => q(host, "device-key-relink-error")?.textContent === "서명을 취소했습니다.",
      "declined"
    );
  });

  it("세션 계보가 없는 로그인은 서명하지 않고 그 까닭을 말한다", async () => {
    core.listDeviceKeys.mockResolvedValue([muteRoot, key()]);
    core.fetchSigningContext.mockResolvedValue({ ...context, sessionId: null });
    const host = mount();
    await waitFor(() => q(host, "device-key-relink-error") !== null, "error");
    expect(desktop.signRebind).not.toHaveBeenCalled();
    expect(q(host, "device-key-relink-error")?.textContent).toContain("다시 로그인");
  });

  it("목록이 낡아 등록이 409 device_key_rebind_required를 받으면 비밀번호 대신 편지로 옮긴다", async () => {
    desktop.status.mockResolvedValue(localStatus({ root: null }));
    // The list is stale until the server says otherwise.
    let told = false;
    core.listDeviceKeys.mockImplementation(async () => (told ? [muteRoot, key()] : [key()]));
    core.registerRootDeviceKey.mockImplementation(async () => {
      told = true;
      throw new ApiError(409, "move it", "device_key_rebind_required");
    });
    core.fetchSigningContext.mockResolvedValue(context);
    desktop.signRebind.mockResolvedValue(letter);
    core.rebindDeviceKey.mockImplementation(async () => {
      core.listDeviceKeys.mockResolvedValue([rootRow, key()]);
      return { ...rootRow, current: true, lineageLive: true };
    });
    desktop.bindRoot.mockResolvedValue({ status: localStatus(), host: { state: "delivered" } });
    const host = mount();
    await waitFor(() => q(host, "device-key-root-start") !== null, "start");
    await click(q(host, "device-key-root-start"), "start");
    const input = q<HTMLInputElement>(host, "device-key-root-password")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "pw");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(q(host, "device-key-root-submit"), "submit");
    await waitFor(() => core.rebindDeviceKey.mock.calls.length === 1, "rebind");
    expect(core.registerRootDeviceKey).toHaveBeenCalledTimes(1);
    // No binding on this Mac for the row: bound after the move.
    await waitFor(() => desktop.bindRoot.mock.calls.length === 1, "bind");
    expect(desktop.bindRoot).toHaveBeenCalledWith({
      workspaceId: WS,
      memberId: ME,
      keyId: ROOT_ID,
      publicKey: MAC_KEY,
    });
    // One move, one prompt: the panel's own attempt does not follow it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(desktop.signRebind).toHaveBeenCalledTimes(1);
  });
});

// ---- #3129: 「QR 연결로만」과 작업 호스트 서명 검증 ----------------------------------

describe("#3129 — QR 아님 · 승인 불가 · 작업 호스트 서명 검증", () => {
  const OTHER_ID = "00000000-0000-7000-8000-00000000d003";

  it("QR 연결 전 규칙으로 승인된 폰은 그대로 두고 「QR 아님」과 권고를 단다", async () => {
    core.listDeviceKeys.mockResolvedValue([
      rootRow,
      key({ state: "endorsed", canInstruct: true, linkedSession: false, linkedFromMac: false }),
    ]);
    const host = mount();
    await waitFor(() => q(host, `device-key-phone-${PHONE_ID}`) !== null, "phone");
    const row = q(host, `device-key-phone-${PHONE_ID}`)!;
    expect(row.textContent).toContain("지시 기기");
    expect(row.textContent).toContain("QR 아님");
    expect(q(row, "device-key-phone-link-note")?.textContent).toBe(
      "QR 연결 전 규칙으로 등록된 폰입니다. 지시 권한을 끊고 다시 연결하는 것을 권합니다. 아래 「폰 연결」에서 QR을 만들고, 폰에서 로그아웃한 뒤 첫 화면의 「QR 찍기」로 찍으세요."
    );
    // The recommended next step is the button already on the row.
    expect(q(row, "device-key-revoke")).not.toBeNull();
  });

  it("맥이 아닌 곳의 QR로 승인된 폰은 「맥 QR 아님」, 옛 서버(값 없음)는 아무 표시도 없다", async () => {
    core.listDeviceKeys.mockResolvedValue([
      rootRow,
      key({ state: "endorsed", canInstruct: true, linkedSession: true, linkedFromMac: false }),
      key({ id: OTHER_ID, state: "endorsed", canInstruct: true, publicKey: MAC_KEY, label: "옛 폰" }),
    ]);
    const host = mount();
    await waitFor(() => q(host, `device-key-phone-${OTHER_ID}`) !== null, "phones");
    expect(q(host, `device-key-phone-${PHONE_ID}`)?.textContent).toContain("맥 QR 아님");
    expect(q(q(host, `device-key-phone-${OTHER_ID}`)!, "device-key-phone-link-note")).toBeNull();
    expect(q(host, `device-key-phone-${OTHER_ID}`)?.textContent).not.toContain("QR 아님");
  });

  it("승인할 수 없는 대기 폰은 숨기지 않고, 승인 단추 없이 까닭과 방법을 말한다", async () => {
    core.listDeviceKeys.mockResolvedValue([
      rootRow,
      key({ linkedSession: false, linkedFromMac: false }),
      key({ id: OTHER_ID, publicKey: MAC_KEY, label: "셀프 QR 폰", linkedSession: true, linkedFromMac: false }),
    ]);
    const host = mount();
    await waitFor(() => q(host, `device-key-unapprovable-${PHONE_ID}`) !== null, "unapprovable");
    const address = q(host, `device-key-unapprovable-${PHONE_ID}`)!;
    // The phone's word for the same state (design-review M1).
    expect(address.textContent).toContain("QR 연결 필요");
    expect(address.textContent).toContain("폰에서 로그아웃한 뒤 첫 화면의 「QR 찍기」");
    expect(address.textContent).toContain("QR로 연결하지 않은 로그인에서 등록된 폰이라 승인할 수 없습니다.");
    expect(q(address, "device-key-endorse-start")).toBeNull();
    const selfQr = q(host, `device-key-unapprovable-${OTHER_ID}`)!;
    expect(selfQr.textContent).toContain("맥이 아닌 곳에서 띄운 QR");
    expect(q(host, "device-keys-no-phone")).toBeNull();
    expect(q(host, "device-key-endorse-start")).toBeNull();
  });

  const hostPin = (over: Record<string, unknown>) =>
    localStatus({
      host: {
        running: true,
        matches: true,
        pinnedRootKeyId: ROOT_ID,
        workspaceMatches: true,
        ...over,
      } as DesktopDeviceKeyStatus["host"],
    });

  it("반쯤 상태: 뿌리가 없으면 「서버만 켜짐」과 뿌리 등록 안내를 보인다", async () => {
    desktop.status.mockResolvedValue({
      ...localStatus({ support: "absent", publicKey: null, fingerprint: null, root: null }),
      host: {
        running: true,
        matches: false,
        pinnedRootKeyId: null,
        signatureEnforcement: "server_only",
        workspaceMatches: true,
        serverRequiresSignatures: true,
        signaturesRequiredBy: null,
      },
    });
    core.listDeviceKeys.mockResolvedValue([key()]);
    const host = mount();
    await waitFor(() => q(host, "device-key-host-signatures") !== null, "host line");
    const line = q(host, "device-key-host-signatures")!;
    expect(line.dataset.signatureEnforcement).toBe("server_only");
    expect(line.textContent).toContain("서버만 켜짐");
    expect(line.textContent).toContain("이 맥을 뿌리로 등록하면 작업 호스트가 검증을 켭니다");
    expect(q(line, "device-key-host-signatures-reset")).toBeNull();
  });

  it("켜짐(서버가 계속 요구): 끄기 단추가 없고 까닭을 말한다", async () => {
    desktop.status.mockResolvedValue(
      hostPin({
        signatureEnforcement: "enforced",
        serverRequiresSignatures: true,
        signaturesRequiredBy: "server",
      })
    );
    const host = mount();
    await waitFor(() => q(host, "device-key-host-signatures") !== null, "host line");
    const line = q(host, "device-key-host-signatures")!;
    expect(line.textContent).toContain("켜짐");
    expect(line.textContent).toContain("서버가 서명을 요구하는 동안에는 끌 수 없습니다.");
    expect(q(line, "device-key-host-signatures-reset")).toBeNull();
  });

  it("켜짐(설정이 켬): 끄기 단추가 없다", async () => {
    desktop.status.mockResolvedValue(
      hostPin({
        signatureEnforcement: "enforced",
        serverRequiresSignatures: false,
        signaturesRequiredBy: "config",
      })
    );
    const host = mount();
    await waitFor(() => q(host, "device-key-host-signatures") !== null, "host line");
    expect(q(host, "device-key-host-signatures")!.textContent).toContain("작업 호스트 설정이 켜 두었습니다");
    expect(q(host, "device-key-host-signatures-reset")).toBeNull();
  });

  it("래칫만 남은 켜짐: 끄기는 셸 명령(네이티브 확인 창)을 거치고, 끝나면 상태를 다시 읽는다", async () => {
    desktop.status.mockResolvedValue(
      hostPin({
        signatureEnforcement: "enforced",
        serverRequiresSignatures: false,
        signaturesRequiredBy: "server",
      })
    );
    desktop.resetSignatureRequirement.mockResolvedValue({ required: false });
    const host = mount();
    await waitFor(() => q(host, "device-key-host-signatures-reset") !== null, "reset");
    const reads = desktop.status.mock.calls.length;
    await click(q(host, "device-key-host-signatures-reset"), "reset");
    await waitFor(() => host.textContent?.includes("검증을 껐습니다") ?? false, "notice");
    expect(desktop.resetSignatureRequirement).toHaveBeenCalledTimes(1);
    expect(desktop.resetSignatureRequirement).toHaveBeenCalledWith(WS);
    await waitFor(() => desktop.status.mock.calls.length > reads, "re-read");
  });

  it("확인 창에서 취소하면 「검증을 끄지 않았습니다」, 설정이 켜 두면 그렇다고 말한다", async () => {
    desktop.status.mockResolvedValue(
      hostPin({
        signatureEnforcement: "enforced",
        serverRequiresSignatures: false,
        signaturesRequiredBy: "unreadable",
      })
    );
    desktop.resetSignatureRequirement.mockRejectedValueOnce("device_key_declined");
    desktop.resetSignatureRequirement.mockResolvedValueOnce({ required: true });
    const host = mount();
    await waitFor(() => q(host, "device-key-host-signatures-reset") !== null, "reset");
    await click(q(host, "device-key-host-signatures-reset"), "reset");
    await waitFor(() => host.textContent?.includes("검증을 끄지 않았습니다.") ?? false, "declined");
    await click(q(host, "device-key-host-signatures-reset"), "reset again");
    await waitFor(
      () => host.textContent?.includes("작업 호스트 설정이 검증을 켜 두어 꺼지지 않았습니다.") ?? false,
      "still on"
    );
  });

  it("꺼짐, 그리고 다른 워크스페이스의 호스트나 옛 셸(값 없음)은 줄을 그리지 않는다", async () => {
    desktop.status.mockResolvedValue(hostPin({ signatureEnforcement: "off" }));
    let host = mount();
    await waitFor(() => q(host, "device-key-host-signatures") !== null, "off");
    expect(q(host, "device-key-host-signatures")!.textContent).toContain("꺼짐");
    act(() => root?.unmount());
    root = null;
    hostEl?.remove();

    desktop.status.mockResolvedValue(
      hostPin({ signatureEnforcement: "enforced", workspaceMatches: false, matches: false })
    );
    host = mount();
    await waitFor(() => q(host, "device-keys") !== null, "body");
    expect(q(host, "device-key-host-signatures")).toBeNull();
    act(() => root?.unmount());
    root = null;
    hostEl?.remove();

    desktop.status.mockResolvedValue(localStatus());
    host = mount();
    await waitFor(() => q(host, "device-keys") !== null, "body");
    expect(q(host, "device-key-host-signatures")).toBeNull();
  });
});
