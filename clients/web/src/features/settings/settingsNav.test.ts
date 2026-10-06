import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_SECTION,
  LEGACY_SECTION_ALIAS,
  SCOPE_LABELS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  isReachableSettingsSection,
  reachableSettingsSections,
  resolveSettingsSection,
} from "./settingsNav";

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

const idsIn = (group: (typeof SETTINGS_SECTIONS)[number]["group"]) =>
  SETTINGS_SECTIONS.filter((item) => item.group === group).map((item) => item.id);

describe("settingsNav (#3578 S1: 12행, 세 그룹)", () => {
  it("개인 / 워크스페이스 / 앱·연결 세 그룹에 12행이다", () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe("profile");
    expect(SETTINGS_GROUPS).toEqual(["개인", "워크스페이스", "앱·연결"]);
    expect(SETTINGS_SECTIONS).toHaveLength(12);
    expect(idsIn("개인")).toEqual(["profile", "appearance", "notifications", "shortcuts", "devices"]);
    expect(idsIn("워크스페이스")).toEqual(["workspace", "members", "memory", "usage", "code"]);
    expect(idsIn("앱·연결")).toEqual(["updates", "ai"]);
    expect(SETTINGS_SECTIONS.map((item) => item.label)).toEqual([
      "프로필",
      "모양",
      "알림",
      "단축키",
      "기기",
      "워크스페이스",
      "멤버와 초대",
      "기억",
      "사용량",
      "실행 호스트",
      "업데이트",
      "AI 허브",
    ]);
  });

  it("모든 행은 범위 칩을 갖고, 링크 행(AI 허브)만 칩이 없다", () => {
    for (const item of SETTINGS_SECTIONS) {
      if (item.link) {
        expect(item.scope, item.id).toBeUndefined();
      } else {
        expect(item.scope, item.id).toBeDefined();
        expect(SCOPE_LABELS[item.scope!], item.id).toBeTruthy();
      }
    }
    expect(SETTINGS_SECTIONS.filter((item) => item.link).map((item) => item.id)).toEqual(["ai"]);
  });

  it("범위 문장에 em-dash가 없다", () => {
    for (const label of Object.values(SCOPE_LABELS)) {
      expect(label).not.toMatch(/[—–]/);
    }
  });

  it("합친 옛 구획은 별칭으로 새 페이지에 닿는다", () => {
    expect(LEGACY_SECTION_ALIAS).toEqual({
      account: "profile",
      "link-previews": "appearance",
      terminal: "shortcuts",
    });
    expect(resolveSettingsSection("account")).toEqual({ kind: "section", id: "profile", alias: "account" });
    expect(resolveSettingsSection("link-previews")).toEqual({ kind: "section", id: "appearance", alias: "link-previews" });
    expect(resolveSettingsSection("terminal")).toEqual({ kind: "section", id: "shortcuts", alias: "terminal" });
    expect(resolveSettingsSection("devices")).toEqual({ kind: "section", id: "devices", alias: null });
  });

  it("AI 허브로 옮겨 간 옛 구획은 허브 경로로 푼다", () => {
    expect(resolveSettingsSection("agents")).toEqual({ kind: "ai-hub", path: "/ai/external/agents" });
    expect(resolveSettingsSection("plugins")).toEqual({ kind: "ai-hub", path: "/ai/external/apps" });
    expect(resolveSettingsSection("webhooks")).toEqual({ kind: "ai-hub", path: "/ai/external/incoming" });
    expect(resolveSettingsSection("events")).toEqual({ kind: "ai-hub", path: "/ai/external/outgoing" });
    // `ai`는 링크 행이지만 옛 주소는 옛 AI 연결 화면을 연다(리다이렉트하지 않는다).
    expect(resolveSettingsSection("ai")).toEqual({ kind: "section", id: "ai", alias: null });
  });

  it("모르는 이름·빈 값은 unknown이다", () => {
    expect(resolveSettingsSection("invites")).toEqual({ kind: "unknown" });
    expect(resolveSettingsSection("")).toEqual({ kind: "unknown" });
    expect(resolveSettingsSection(null)).toEqual({ kind: "unknown" });
  });

  it("도착 가능 판정은 별칭과 옮겨 간 이름을 참으로, 모르는 이름을 거짓으로 답한다", () => {
    for (const id of ["profile", "account", "link-previews", "terminal", "agents", "ai"]) {
      expect(isReachableSettingsSection(id), id).toBe(true);
    }
    expect(isReachableSettingsSection("invites")).toBe(false);
    // 브라우저(데스크톱 아님)에는 업데이트·코드 실행 호스트가 목차에 없다.
    const reachable = reachableSettingsSections().map((item) => item.id);
    expect(reachable).not.toContain("updates");
    expect(reachable).not.toContain("code");
    expect(isReachableSettingsSection("updates")).toBe(false);
    expect(isReachableSettingsSection("code")).toBe(false);
  });

  it("목차 별칭의 목적지는 모두 목차에 있는 id다", () => {
    for (const target of Object.values(LEGACY_SECTION_ALIAS)) {
      expect(SETTINGS_SECTIONS.some((item) => item.id === target)).toBe(true);
    }
  });

  it("lays the phone nav in one scrolling row instead of a capped column (#3064)", () => {
    const css = readFileSync(join(WEB_SRC, "design/tokens.css"), "utf8");
    const start = css.indexOf("@utility settings-nav {");
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
    const phone = utility.slice(utility.indexOf("@media (width < 600px)"));
    expect(phone).toContain("display: flex");
    expect(phone).toContain("overflow-x: auto");
    expect(phone).toContain("overflow-y: hidden");
    // The capped column is what stacked two scroll panes on a 390 phone.
    expect(utility).not.toContain("max-block-size");
    expect(css).not.toContain("--spacing-settings-nav");
  });

  it("넓은 창의 목록에는 세로선이 없다 (허공에 뜬 구분선 회귀)", () => {
    const css = readFileSync(join(WEB_SRC, "design/tokens.css"), "utf8");
    const start = css.indexOf("@utility settings-nav {");
    const wide = css.slice(start, css.indexOf("@media (width < 600px)", start));
    expect(wide).not.toMatch(/border-inline-end|border-right/);
    // 설정 면은 평면 `--pane`이 아니라 창 바닥(그라데이션) 위의 떠 있는 판이다.
    const surface = css.slice(css.indexOf("&[data-settings-surface]"), css.indexOf("/* 폰 (B6)."));
    expect(surface).not.toContain("background: var(--pane)");
  });

  it("AppShell swaps app chrome for the settings surface", () => {
    const shell = readFileSync(join(WEB_SRC, "app/AppShell.tsx"), "utf8");
    expect(shell).toContain('routePath === "/settings"');
    expect(shell).toContain("data-settings-surface");
    expect(shell).toContain("{!isSettingsSurface && (");
    expect(shell).toContain("<Sidebar");
  });
});
