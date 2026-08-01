import { describe, expect, it } from "vitest";
import { installInvite, pwaNotice, type InstallContext } from "./model";

// 안내를 한 번도 못 본 폰 브라우저. 각 케이스는 여기서 한 가지 사실만 바꾼다.
const phoneBrowser: InstallContext = {
  standalone: false,
  desktopShell: false,
  phone: true,
  seen: false,
  deferredPrompt: false,
  ios: true,
};

describe("installInvite", () => {
  it("offers the share sheet route on a phone that has no install prompt", () => {
    expect(installInvite(phoneBrowser)).toBe("ios-share");
  });

  it("prefers the browser prompt when one was handed over", () => {
    expect(
      installInvite({ ...phoneBrowser, ios: false, deferredPrompt: true })
    ).toBe("prompt");
  });

  it("says nothing when there is no route to installing at all", () => {
    // 안드로이드 크롬이 아직 프롬프트를 주지 않은 상태. 사용자가 할 수 있는 일이
    // 없는데 권하는 줄은 소음이다.
    expect(installInvite({ ...phoneBrowser, ios: false })).toBeNull();
  });

  it("stays quiet once the app is already opened from the home screen", () => {
    expect(installInvite({ ...phoneBrowser, standalone: true })).toBeNull();
  });

  it("stays quiet in the desktop shell, which has no home screen", () => {
    expect(
      installInvite({ ...phoneBrowser, desktopShell: true, standalone: false })
    ).toBeNull();
  });

  it("stays quiet on a wide window", () => {
    expect(installInvite({ ...phoneBrowser, phone: false })).toBeNull();
  });

  it("never asks twice", () => {
    expect(installInvite({ ...phoneBrowser, seen: true })).toBeNull();
  });
});

describe("pwaNotice", () => {
  it("shows nothing when there is nothing to say", () => {
    expect(pwaNotice({ updateReady: false, invite: null })).toBeNull();
  });

  it("shows the install invite when that is the only news", () => {
    expect(pwaNotice({ updateReady: false, invite: "ios-share" })).toEqual({
      kind: "install",
      invite: "ios-share",
    });
  });

  it("lets a ready build win over the install invite", () => {
    // 한 줄만 설 수 있다. 낡은 셸로 계속 쓰는 것이 나중에 설치하는 것보다 급하다.
    expect(pwaNotice({ updateReady: true, invite: "prompt" })).toEqual({
      kind: "update",
    });
  });
});
