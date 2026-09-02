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
      "devices",
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

  it("keeps relative order of the pre-#1867 section ids inside each group", () => {
    const idsIn = (group: (typeof SETTINGS_SECTIONS)[number]["group"]) =>
      SETTINGS_SECTIONS.filter((item) => item.group === group).map(
        (item) => item.id
      );
    expect(idsIn("개인")).toEqual([
      "profile",
      "account",
      "devices",
      "appearance",
      "link-previews",
      "notifications",
      "updates",
    ]);
    expect(idsIn("워크스페이스")).toEqual(["workspace", "plugins", "members"]);
    expect(idsIn("연결")).toEqual([
      "ai",
      "code",
      "usage",
      "webhooks",
      "events",
    ]);
    expect(
      SETTINGS_SECTIONS.findIndex((item) => item.id === "webhooks")
    ).toBeGreaterThan(
      SETTINGS_SECTIONS.findIndex((item) => item.id === "members")
    );
  });

  it("caps the phone nav with this surface's named height, not pane-sm", () => {
    const css = readFileSync(join(WEB_SRC, "design/tokens.css"), "utf8");
    const start = css.indexOf("@utility settings-nav");
    let depth = 0;
    let end = css.indexOf("{", start);
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    const utility = css.slice(start, end);
    expect(utility).toContain("max-block-size: var(--spacing-settings-nav)");
    expect(utility).not.toContain("--spacing-pane-sm");
    expect(css).toMatch(/--spacing-settings-nav:\s*308px;/);
  });

  it("AppShell swaps app chrome for the settings surface", () => {
    const shell = readFileSync(join(WEB_SRC, "app/AppShell.tsx"), "utf8");
    expect(shell).toContain('routePath === "/settings"');
    expect(shell).toContain("data-settings-surface");
    expect(shell).toContain("{!isSettingsSurface && (");
    expect(shell).toContain("<Sidebar");
  });
});
