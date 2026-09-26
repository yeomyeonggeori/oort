// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeDeviceLinkLive } from "@/features/settings/deviceLinkLive";
import { deviceLinkFixtureIssue } from "@/features/settings/deviceLinkFixture";
import { PhoneLinkChannelCard } from "./PhoneLinkChannelCard";
import {
  PHONE_LINK_CARD_COPY,
  PHONE_LINK_SETTINGS_HREF,
  shouldMountPhoneLinkCard,
} from "./phoneLinkCard";
import {
  clearPhoneLinkCardForTests,
  collapsePhoneLinkCard,
  dismissPhoneLinkCard,
  markPhoneLinkCardPending,
  phoneLinkCardKey,
  readPhoneLinkCard,
} from "./phoneLinkCardStore";

// =============================================================================
// #2818 (ADR-0193 D7): 「폰에서도」는 첫 대화 채널 카드다.
// 저장소(이 기기) · 마운트 조건(첫 대화 채널 + 킥오프 뒤) · 카드 상태(대기 →
// 접힘 → 닫힘, QR 만들기 → 기기 연결 흐름 → 기쁨)를 잰다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const OTHER_WS = "00000000-0000-7000-8000-000000000002";
const NOW = 1_800_000_000_000;

const issueDeviceLink = vi.hoisted(() => vi.fn());
const getDeviceLink = vi.hoisted(() => vi.fn());
const confirmDeviceLinkSas = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/auth/deviceLink", () => ({
  issueDeviceLink: (...args: unknown[]) => issueDeviceLink(...args),
  getDeviceLink: (...args: unknown[]) => getDeviceLink(...args),
  confirmDeviceLinkSas: (...args: unknown[]) => confirmDeviceLinkSas(...args),
  DEVICE_LINK_POLL_INTERVAL_MS: 2_000,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearPhoneLinkCardForTests(WS);
  clearPhoneLinkCardForTests(OTHER_WS);
  writeDeviceLinkLive(null);
  issueDeviceLink.mockReset();
  getDeviceLink.mockReset();
  confirmDeviceLinkSas.mockReset();
  issueDeviceLink.mockResolvedValue(
    deviceLinkFixtureIssue({ expiresAt: NOW + 120_000, sas: null })
  );
  getDeviceLink.mockResolvedValue({ status: "pending" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  clearPhoneLinkCardForTests(WS);
  writeDeviceLinkLive(null);
  vi.useRealTimers();
});

function mount(
  onDismissed?: () => void,
  strict = false,
  offline = false
): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const card = createElement(PhoneLinkChannelCard, {
    workspaceId: WS,
    offline,
    ...(onDismissed ? { onDismissed } : {}),
  });
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        strict ? createElement(StrictMode, null, card) : card
      )
    );
  });
  return host;
}

function unmount(): void {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

function q(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function click(id: string): void {
  const node = q(id);
  expect(node, id).not.toBeNull();
  act(() => {
    node?.click();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("phoneLinkCardStore (이 기기에 저장)", () => {
  it("접힘은 localStorage 에 남아 새로 읽어도 접힘이다", () => {
    markPhoneLinkCardPending(WS);
    collapsePhoneLinkCard(WS);
    expect(localStorage.getItem(phoneLinkCardKey(WS))).toBe("collapsed");
    expect(readPhoneLinkCard(WS)).toBe("collapsed");
    expect(readPhoneLinkCard(OTHER_WS)).toBeNull();
  });

  it("다시 가입해도 접거나 닫은 카드를 되살리지 않는다", () => {
    collapsePhoneLinkCard(WS);
    markPhoneLinkCardPending(WS);
    expect(readPhoneLinkCard(WS)).toBe("collapsed");
    dismissPhoneLinkCard(WS);
    markPhoneLinkCardPending(WS);
    expect(readPhoneLinkCard(WS)).toBe("dismissed");
  });

  it("모르는 값은 없음으로 읽는다", () => {
    localStorage.setItem(phoneLinkCardKey(WS), "done");
    expect(readPhoneLinkCard(WS)).toBeNull();
  });
});

describe("shouldMountPhoneLinkCard (첫 대화 채널, 킥오프 뒤)", () => {
  const general = { kind: "public", name: "general" };

  it("기본 공개 채널 + 킥오프가 끝났으면 선다", () => {
    expect(
      shouldMountPhoneLinkCard({
        channel: general,
        kickoffPhase: "hidden",
        kickoffSettled: true,
      })
    ).toBe(true);
  });

  it("다른 채널·DM에는 서지 않는다", () => {
    for (const channel of [
      { kind: "public", name: "엔진" },
      { kind: "private", name: "general" },
      { kind: "dm", name: undefined },
      null,
    ]) {
      expect(
        shouldMountPhoneLinkCard({
          channel,
          kickoffPhase: "hidden",
          kickoffSettled: true,
        })
      ).toBe(false);
    }
  });

  it("킥오프 띠가 서 있거나 판정 전이면 서지 않는다(오프너가 먼저)", () => {
    for (const kickoffPhase of ["stage", "backstop", "exiting"]) {
      expect(
        shouldMountPhoneLinkCard({
          channel: general,
          kickoffPhase,
          kickoffSettled: true,
        })
      ).toBe(false);
    }
    expect(
      shouldMountPhoneLinkCard({
        channel: general,
        kickoffPhase: "hidden",
        kickoffSettled: false,
      })
    ).toBe(false);
  });
});

describe("PhoneLinkChannelCard", () => {
  it("pending 이 아니면 아무것도 그리지 않는다", () => {
    mount();
    expect(q("phone-link-card")).toBeNull();
    expect(q("phone-link-card-collapsed")).toBeNull();
  });

  it("대기: 코메토(대기) + 문장 + [QR 만들기] + [나중에], 문장 칸이 한 번 읽힌다", () => {
    markPhoneLinkCardPending(WS);
    mount();
    const card = q("phone-link-card");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-state")).toBe("idle");
    expect(q("phone-link-card-kometto")?.getAttribute("data-expression")).toBe(
      "idle"
    );
    expect(q("phone-link-card-kometto")?.getAttribute("aria-hidden")).toBe("true");
    // 킥오프 띠(#2817)와 같은 그림: KomettoFace band(52), 표정도 같이 간다.
    const face = q("phone-link-card-kometto")?.querySelector("[data-testid='kometto-face']");
    expect(face?.getAttribute("data-size")).toBe("band");
    expect(face?.getAttribute("data-expression")).toBe("idle");
    const status = card?.querySelector('[role="status"]');
    expect(status?.textContent).toContain(PHONE_LINK_CARD_COPY.title);
    expect(q("phone-link-card-create")?.textContent).toBe("QR 만들기");
    expect(q("phone-link-card-later")?.textContent).toBe("나중에");
    // 발급은 사용자가 [QR 만들기]를 누르기 전에는 일어나지 않는다.
    expect(issueDeviceLink).not.toHaveBeenCalled();
    expect(q("device-link-card")).toBeNull();
  });

  it("[나중에]: 접힌 한 줄이 「설정 › 기기」를 말하고, 이 기기에 남아 다시 열어도 접혀 있다", () => {
    markPhoneLinkCardPending(WS);
    mount();
    click("phone-link-card-later");
    expect(q("phone-link-card")).toBeNull();
    const collapsed = q("phone-link-card-collapsed");
    expect(collapsed).not.toBeNull();
    expect(collapsed?.textContent).toContain(
      "설정 › 기기에서 언제든 연결할 수 있어요."
    );
    expect(
      q("phone-link-card-kometto")?.getAttribute("data-expression")
    ).toBe("sleepy");
    const small = q("phone-link-card-kometto")?.querySelector("[data-testid='kometto-face']");
    expect(small?.getAttribute("data-size")).toBe("band-small");
    expect(small?.getAttribute("data-expression")).toBe("sleepy");
    const link = q("phone-link-card-settings") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe(PHONE_LINK_SETTINGS_HREF);
    // 사라진 [나중에] 대신 포커스가 재진입 링크로 간다.
    expect(document.activeElement).toBe(link);
    expect(readPhoneLinkCard(WS)).toBe("collapsed");

    unmount();
    mount();
    expect(q("phone-link-card")).toBeNull();
    expect(q("phone-link-card-collapsed")).not.toBeNull();
  });

  it("접힌 줄의 [닫기]: 사라지고 다시 서지 않으며, 포커스를 돌려준다", () => {
    collapsePhoneLinkCard(WS);
    const onDismissed = vi.fn();
    mount(onDismissed);
    click("phone-link-card-close");
    expect(q("phone-link-card-collapsed")).toBeNull();
    expect(readPhoneLinkCard(WS)).toBe("dismissed");
    expect(onDismissed).toHaveBeenCalledTimes(1);
    unmount();
    mount();
    expect(q("phone-link-card")).toBeNull();
    expect(q("phone-link-card-collapsed")).toBeNull();
  });

  it("[QR 만들기]: 기기 연결 카드를 띠 안에 열고 한 번만 발급한다(StrictMode 포함)", async () => {
    markPhoneLinkCardPending(WS);
    mount(undefined, true);
    click("phone-link-card-create");
    await flush();
    expect(issueDeviceLink).toHaveBeenCalledTimes(1);
    const card = q("phone-link-card");
    expect(card?.getAttribute("data-state")).toBe("open");
    const device = card?.querySelector('[data-testid="device-link-card"]');
    expect(device).not.toBeNull();
    // 띠 안에서는 머리 「폰 연결」을 다시 말하지 않는다.
    expect(device?.querySelector("h3")).toBeNull();
    expect(q("device-link-qr")).not.toBeNull();
    // 두 번째 「QR 만들기」를 누르게 하지 않는다: 띠의 버튼은 사라진다.
    expect(q("phone-link-card-create")).toBeNull();
    // 살아 있는 QR 옆 카드 안의 「QR 만들기」도 서지 않는다.
    expect(q("device-link-create")).toBeNull();
    expect(readPhoneLinkCard(WS)).toBe("pending");
  });

  it("[QR 만들기]를 누르면 포커스가 body가 아니라 QR 영역으로 간다", async () => {
    markPhoneLinkCardPending(WS);
    mount();
    q("phone-link-card-create")?.focus();
    click("phone-link-card-create");
    await flush();
    expect(document.activeElement).toBe(q("phone-link-card-body"));
  });

  it("첫 발급이 도는 동안 카드 안에 두 번째 「QR 만들기」가 뜨지 않는다", async () => {
    markPhoneLinkCardPending(WS);
    let resolve: (value: unknown) => void = () => undefined;
    issueDeviceLink.mockReturnValue(new Promise((r) => (resolve = r)));
    mount();
    click("phone-link-card-create");
    await flush();
    expect(issueDeviceLink).toHaveBeenCalledTimes(1);
    expect(q("device-link-create")).toBeNull();
    resolve(deviceLinkFixtureIssue({ expiresAt: NOW + 120_000, sas: null }));
    await flush();
    expect(q("device-link-qr")).not.toBeNull();
  });

  it("발급이 실패하면 카드 안에서 다시 만들 수 있다", async () => {
    markPhoneLinkCardPending(WS);
    issueDeviceLink.mockRejectedValue(new Error("boom"));
    mount();
    click("phone-link-card-create");
    await flush();
    expect(q("device-link-banner")).not.toBeNull();
    expect(q("device-link-create")).not.toBeNull();
  });

  it("오프라인이면 발급하지 않고 사유를 말하며, 다시 연결되면 한 번 발급한다", async () => {
    markPhoneLinkCardPending(WS);
    mount(undefined, false, true);
    click("phone-link-card-create");
    await flush();
    expect(issueDeviceLink).not.toHaveBeenCalled();
    expect(q("device-link-offline")).not.toBeNull();
    mount(undefined, false, false);
    await flush();
    expect(issueDeviceLink).toHaveBeenCalledTimes(1);
  });

  it("띠 바닥은 신호색이 아니다(ADR-0193 D11: 오렌지는 진행 점과 포커스만)", () => {
    markPhoneLinkCardPending(WS);
    mount();
    const cls = q("phone-link-card")?.className ?? "";
    expect(cls).toContain("bg-surface-muted");
    expect(cls).not.toMatch(/\bbg-(signal|accent)/);
  });

  it("폴링이 연결을 알려도 컴포저에서 쓰던 포커스를 빼앗지 않는다(R2 H2-R)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    markPhoneLinkCardPending(WS);
    const composer = document.createElement("textarea");
    document.body.append(composer);
    try {
      mount();
      click("phone-link-card-create");
      await flush();
      expect(q("device-link-qr")).not.toBeNull();
      composer.focus();
      expect(document.activeElement).toBe(composer);
      getDeviceLink.mockResolvedValue({
        status: "consumed",
        device: { id: "d1", name: "성재 iPhone" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      await flush();
      expect(q("phone-link-card")?.getAttribute("data-state")).toBe("linked");
      expect(document.activeElement).toBe(composer);
    } finally {
      composer.remove();
    }
  });

  it("발급이 도는 동안 띠 안 문장은 「QR을 만들고 있습니다.」다", async () => {
    markPhoneLinkCardPending(WS);
    issueDeviceLink.mockReturnValue(new Promise(() => undefined));
    mount();
    click("phone-link-card-create");
    await flush();
    const body = q("phone-link-card-body")?.textContent ?? "";
    expect(body).toContain("QR을 만들고 있습니다.");
    expect(body).not.toContain("QR을 만드세요");
  });

  it("살아 있는 연결의 복원이 실패하면 사유와 다시 만들기가 선다(R3 M3-1)", async () => {
    markPhoneLinkCardPending(WS);
    writeDeviceLinkLive({
      id: "019f9b10-0000-7000-8000-000000000d01",
      expiresAt: Date.now() + 60_000,
      deepLink: "oort://link?server=x&token=y",
    });
    getDeviceLink.mockRejectedValue(new Error("boom"));
    mount();
    click("phone-link-card-create");
    await flush();
    expect(issueDeviceLink).not.toHaveBeenCalled();
    expect(q("device-link-banner")).not.toBeNull();
    expect(q("device-link-create")).not.toBeNull();
  });

  it("띠 안 기기 연결 카드는 없는 버튼을 약속하지 않는다(발급 중·오프라인)", async () => {
    markPhoneLinkCardPending(WS);
    mount(undefined, false, true);
    click("phone-link-card-create");
    await flush();
    const body = q("phone-link-card-body")?.textContent ?? "";
    expect(body).not.toContain("QR을 만드세요");
    expect(body).toContain("다시 연결되면 QR을 만듭니다.");
  });

  it("살아 있는 연결이 있으면 [QR 만들기]가 새로 발급하지 않고 복원한다", async () => {
    markPhoneLinkCardPending(WS);
    writeDeviceLinkLive({
      id: "019f9b10-0000-7000-8000-000000000d01",
      expiresAt: Date.now() + 60_000,
      deepLink: "oort://link?server=x&token=y",
    });
    mount();
    click("phone-link-card-create");
    await flush();
    expect(issueDeviceLink).not.toHaveBeenCalled();
    expect(getDeviceLink).toHaveBeenCalled();
  });

  it("폰이 연결되면 기쁨 띠 + [닫기], 저장소는 곧바로 dismissed", async () => {
    markPhoneLinkCardPending(WS);
    getDeviceLink.mockResolvedValue({
      status: "consumed",
      device: { id: "d1", name: "성재 iPhone" },
    });
    mount();
    click("phone-link-card-create");
    await flush();
    await flush();
    const card = q("phone-link-card");
    expect(card?.getAttribute("data-state")).toBe("linked");
    expect(card?.textContent).toContain(PHONE_LINK_CARD_COPY.linkedTitle);
    expect(
      q("phone-link-card-kometto")?.getAttribute("data-expression")
    ).toBe("happy");
    expect(readPhoneLinkCard(WS)).toBe("dismissed");
    // 누른 컨트롤이 사라진 자리 대신 [닫기]로 포커스가 온다.
    expect(document.activeElement).toBe(q("phone-link-card-close"));
    click("phone-link-card-close");
    expect(q("phone-link-card")).toBeNull();
  });
});
