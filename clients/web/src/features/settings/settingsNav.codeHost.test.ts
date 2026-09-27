import { beforeEach, describe, expect, it, vi } from "vitest";

// #2778 planner decision: on the desktop, 「코드 실행 호스트」 is the door to
// registering the first host, so it never waits for an online host.
const shell = vi.hoisted(() => ({ desktop: false }));
vi.mock("@/lib/tauri", () => ({ isDesktop: () => shell.desktop }));

import { reachableSettingsSections } from "./settingsNav";

const noOnlineHost = () => false;
const ids = () => reachableSettingsSections(noOnlineHost).map((item) => item.id);

describe("코드 실행 호스트 is reachable on desktop with no host (#2778)", () => {
  beforeEach(() => {
    shell.desktop = false;
  });

  it("desktop, zero hosts: the row stands", () => {
    shell.desktop = true;
    expect(ids()).toContain("code");
  });

  it("browser, zero hosts: still folded by the runtime judgement (#2780)", () => {
    expect(ids()).not.toContain("code");
  });

  it("browser with an online host: shown", () => {
    expect(reachableSettingsSections(() => true).map((item) => item.id)).toContain("code");
  });
});
