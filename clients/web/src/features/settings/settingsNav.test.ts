import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
} from "./settingsNav";

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("settingsNav", () => {
  it("puts Profile first in 개인 and does not rename existing sections", () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe("profile");
    expect(SETTINGS_GROUPS).toEqual(["개인", "워크스페이스", "연결"]);
    expect(
      SETTINGS_SECTIONS.filter((item) => item.group === "개인").map(
        (item) => item.id
      )
    ).toEqual([
      "profile",
      "account",
      "appearance",
      "link-previews",
      "notifications",
      "updates",
    ]);
    expect(
      SETTINGS_SECTIONS.filter((item) => item.group === "워크스페이스").map(
        (item) => item.label
      )
    ).toEqual(["워크스페이스", "앱", "멤버와 초대"]);
    expect(
      SETTINGS_SECTIONS.filter((item) => item.group === "연결").map(
        (item) => item.label
      )
    ).toEqual([
      "AI 연결",
      "코드 실행 호스트",
      "사용량",
      "웹훅",
      "이벤트 구독",
    ]);
  });

  it("keeps relative order of the pre-#1867 section ids", () => {
    const ids = SETTINGS_SECTIONS.filter((item) => item.id !== "profile").map(
      (item) => item.id
    );
    const previous = [
      "account",
      "appearance",
      "link-previews",
      "notifications",
      "updates",
      "workspace",
      "plugins",
      "members",
      "ai",
      "code",
      "usage",
      "webhooks",
      "events",
    ];
    expect(ids.filter((id) => previous.includes(id)).sort()).toEqual(
      [...previous].sort()
    );
    const personal = ids.filter((id) =>
      [
        "account",
        "appearance",
        "link-previews",
        "notifications",
        "updates",
      ].includes(id)
    );
    expect(personal).toEqual([
      "account",
      "appearance",
      "link-previews",
      "notifications",
      "updates",
    ]);
  });

  it("AppShell swaps app chrome for the settings surface", () => {
    const shell = readFileSync(join(WEB_SRC, "app/AppShell.tsx"), "utf8");
    expect(shell).toContain('routePath === "/settings"');
    expect(shell).toContain("data-settings-surface");
    expect(shell).toContain("{!isSettingsSurface && (");
    expect(shell).toContain("<Sidebar");
  });
});
