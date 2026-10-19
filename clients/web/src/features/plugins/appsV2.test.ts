import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginIconText, pluginNeedsAdminSetup, pluginRouteChip, pluginRunPlaces, pluginSubtitle } from "./model";

// 앱 화면 v2 (#3949)의 순수한 문장·판정. 화면에 올린 모양은 PluginSection.test.tsx가 잰다.

const surface = vi.hoisted(() => ({ driveTeamProvided: false }));
vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>();
  return {
    ...actual,
    isSurfaceProvided: (id: Parameters<typeof actual.isSurfaceProvided>[0]) =>
      id === "pluginDriveTeam" ? surface.driveTeamProvided : actual.isSurfaceProvided(id),
  };
});

// #3944 시드 일곱: 서버 매니페스트의 id와 이름이다.
const SEEDED_APPS = [
  { pluginId: "com.momo.plugins.drive", name: "Google Drive" },
  { pluginId: "com.momo.plugins.github", name: "GitHub" },
  { pluginId: "com.momo.plugins.gmail", name: "Gmail" },
  { pluginId: "com.momo.plugins.google-calendar", name: "Google Calendar" },
  { pluginId: "com.momo.plugins.google-drive", name: "Google 내 드라이브" },
  { pluginId: "com.momo.plugins.linear", name: "Linear" },
  { pluginId: "com.momo.plugins.notion", name: "Notion" },
];

describe("앱 타일 글자", () => {
  it("시드 일곱 앱의 타일은 모두 다르다: GitHub과 Gmail이 둘 다 「G」가 아니고, 두 Drive도 갈린다", () => {
    const tiles = SEEDED_APPS.map((app) => pluginIconText(app));
    expect(new Set(tiles).size).toBe(SEEDED_APPS.length);
    expect(pluginIconText({ pluginId: "com.momo.plugins.github", name: "GitHub" })).toBe("GH");
    expect(pluginIconText({ pluginId: "com.momo.plugins.gmail", name: "Gmail" })).toBe("Gm");
  });

  it("서버가 iconText를 주면 그것이 표보다 먼저고, id가 없으면 이름의 머리글자다", () => {
    expect(pluginIconText({ pluginId: "com.momo.plugins.gmail", name: "Gmail", iconText: "ML" })).toBe("ML");
    expect(pluginIconText({ name: "Gmail" })).toBe("G");
    // 대소문자: 서버 id는 소문자지만 표 조회는 가리지 않는다.
    expect(pluginIconText({ pluginId: "COM.MOMO.PLUGINS.GMAIL", name: "Gmail" })).toBe("Gm");
  });
});

describe("Google 세 앱의 한 줄 소개", () => {
  it("영어 매니페스트 문구 대신 한국어 한 줄이다", () => {
    for (const [pluginId, expected] of [
      ["com.momo.plugins.gmail", "메일 읽기와 초안"],
      ["com.momo.plugins.google-calendar", "일정과 초대"],
      ["com.momo.plugins.google-drive", "내 드라이브의 파일"],
    ] as const) {
      expect(pluginSubtitle({ pluginId, description: "Official Google remote MCP (Developer Preview)" })).toBe(expected);
    }
  });
});

describe("두 Drive를 가르는 연결 칩", () => {
  beforeEach(() => {
    surface.driveTeamProvided = false;
  });

  it("내 드라이브는 경로 A 문장이고, 다른 앱은 칩이 없다", () => {
    expect(pluginRouteChip("com.momo.plugins.google-drive"))
      .toEqual({ label: "내 드라이브 · 내 에이전트가 읽어요", tone: "muted" });
    for (const id of ["com.momo.plugins.github", "com.momo.plugins.gmail", "com.example.x"]) {
      expect(pluginRouteChip(id)).toBeNull();
    }
  });

  it("팀 공유 드라이브: 서버가 경로를 싣지 않으면 칩을 숨기고 「관리자 설정이 필요해요」다 (E-5 전)", () => {
    const chip = pluginRouteChip("com.momo.plugins.drive");
    expect(chip).toEqual({ label: "관리자 설정이 필요해요", tone: "warn" });
    expect(chip?.label).not.toContain("팀 전체");
  });

  it("관리자 설정이 먼저인 앱은 팀 공유 드라이브뿐이고, 경로가 서면 아니다", () => {
    expect(pluginNeedsAdminSetup("com.momo.plugins.drive")).toBe(true);
    expect(pluginNeedsAdminSetup("com.momo.plugins.google-drive")).toBe(false);
    expect(pluginNeedsAdminSetup("com.momo.plugins.github")).toBe(false);
    surface.driveTeamProvided = true;
    expect(pluginNeedsAdminSetup("com.momo.plugins.drive")).toBe(false);
  });

  it("팀 공유 드라이브: 경로가 서면 「팀 전체 · oort가 읽어요」다", () => {
    surface.driveTeamProvided = true;
    expect(pluginRouteChip("com.momo.plugins.drive"))
      .toEqual({ label: "팀 전체 · oort가 읽어요", tone: "muted" });
    expect(pluginRouteChip("COM.MOMO.PLUGINS.DRIVE")?.label).toBe("팀 전체 · oort가 읽어요");
  });
});

describe("실행하는 곳 줄", () => {
  it("세 곳을 모두 말한다: 강제 수준을 숨기지 않는다", () => {
    const places = pluginRunPlaces({}, true);
    expect(places).toEqual([
      { place: "내 맥", enforcement: "기기가 막아요" },
      { place: "Hermes 시험", enforcement: "나만 써요" },
      { place: "그록봇", enforcement: "앱 권한은 그록봇이 관리해요. oort는 허용 기록만 남겨요" },
    ]);
  });

  it("내 맥 길(#3957)이 서기 전에는 「기기가 막아요」라고 말하지 않는다", () => {
    const [mac] = pluginRunPlaces({});
    expect(mac).toEqual({ place: "내 맥", enforcement: "내 맥에서 앱 쓰기는 준비 중이에요" });
  });

  it("oort 서버가 연결을 들고 있는 앱(hosted)에는 줄이 없다", () => {
    expect(pluginRunPlaces({ hosted: true })).toEqual([]);
    expect(pluginRunPlaces({ hosted: false })).toHaveLength(3);
    expect(pluginRunPlaces({ hosted: undefined })).toHaveLength(3);
  });
});
