// 폰 「앱」 읽기 화면의 모델 (U-4 #3951, ADR-0113 증보 2 E4).
import { describe, expect, it } from "vitest";
import type { PluginCatalogItem, PluginDetail, PluginPolicyTool } from "../../lib/api";
import { aiExternalRowFromSettings } from "../ai/aiHubModel";
import { SETTINGS_OPEN_SECTIONS } from "../timeline/commandSuggest";
import { APPS_SCREEN_PATH, parseAppNotice } from "../timeline/appNotice";
import {
  APPS_SETTINGS_SECTION,
  PHONE_APP_BLOCKED_SENTENCE,
  PHONE_APP_WEB_ACTION,
  appsOnWebPath,
  isPhoneAppBlocked,
  phoneAppDetail,
  phoneAppRow,
  phoneAppRows,
} from "./phoneApps";

const GITHUB: PluginCatalogItem = {
  pluginId: "com.momo.plugins.github",
  name: "GitHub",
  version: "1.0.0",
  description: "Official GitHub hosted MCP integration",
  official: true,
  recommended: true,
  egressDomains: ["api.githubcopilot.com"],
  recommendedFor: [],
  installed: true,
  enabled: true,
};
const READ: PluginPolicyTool = { name: "github.list_repositories", risk: "read", approvalTier: "read_only" };

describe("폰 「웹에서 열기」 링크: 경로가 아니라 설정 section id", () => {
  it("section=plugins 로 잇고, 앱 화면 경로를 외우지 않는다", () => {
    expect(appsOnWebPath()).toBe("/settings?section=plugins");
    expect(appsOnWebPath()).not.toContain(APPS_SCREEN_PATH);
  });

  it("그 id 는 settings.open 의 열두 section 중 하나이고, 웹이 앱 화면으로 푼다", () => {
    expect(SETTINGS_OPEN_SECTIONS).toContain(APPS_SETTINGS_SECTION);
    // 웹 `resolveSettingsSection` 이 부르는 바로 그 표다 — id 가 앱 화면의 옛 구획 id 와 같다.
    expect(aiExternalRowFromSettings(APPS_SETTINGS_SECTION)?.path).toBe(APPS_SCREEN_PATH);
  });
});

describe("폰의 막힘 문장은 채팅의 막힘 문장과 같은 글자다", () => {
  it("appNoticeFor(not_allowed, 폰) 의 문장과 행동 이름", () => {
    const notice = parseAppNotice(
      { app_notice: { kind: "not_allowed" } },
      { surface: "phone", plugins: new Map(), nowMs: 0 },
    );
    expect(notice?.sentence).toBe(PHONE_APP_BLOCKED_SENTENCE);
    expect(notice?.action?.label).toBe(PHONE_APP_WEB_ACTION);
  });
});

describe("목록 줄", () => {
  it("설치돼 있고 내가 허용한 도구가 있으면 막힘이 아니다", () => {
    const row = phoneAppRow(GITHUB, [READ]);
    expect(row.blocked).toBe(false);
    expect(row.chipLabel).toBe("설치됨 · 내가 허용함");
    expect(row.subtitle).toBe("코드 저장소와 이슈");
    expect(row.iconText).toBe("GH");
  });

  it("미설치·내 허용 없음·비활성은 모두 막힘이고, 칩 글자가 서로 다르다", () => {
    const notInstalled = phoneAppRow({ ...GITHUB, installed: false, enabled: false }, undefined);
    const noGrant = phoneAppRow(GITHUB, []);
    const disabled = phoneAppRow({ ...GITHUB, enabled: false }, [READ]);
    expect([notInstalled, noGrant, disabled].map((row) => row.blocked)).toEqual([true, true, true]);
    expect([notInstalled.chipLabel, noGrant.chipLabel, disabled.chipLabel]).toEqual([
      "미설치",
      "설치됨 · 내 허용 없음",
      "설치했지만 비활성",
    ]);
  });

  it("막힘 판정은 한 함수다", () => {
    expect(isPhoneAppBlocked({ installed: true, enabled: true, allowedToolCount: 0 })).toBe(true);
    expect(isPhoneAppBlocked({ installed: true, enabled: true, allowedToolCount: 2 })).toBe(false);
  });

  it("정책 맵을 앱 id 로 이어 붙인다", () => {
    const rows = phoneAppRows([GITHUB], new Map([[GITHUB.pluginId, [READ]]]));
    expect(rows[0].allowedToolCount).toBe(1);
  });
});

describe("상세", () => {
  const detail: PluginDetail = {
    ...GITHUB,
    publisherName: "oort",
    publisherVerified: true,
    license: "MIT",
    tools: [
      { name: "github.list_repositories", description: "저장소 목록 읽기", scopes: ["repo:read"], risk: "read", approvalTier: "read_only" },
      { name: "github.create_issue", description: "이슈 만들기", scopes: ["issues:write"], risk: "write", approvalTier: "network_write" },
    ],
  };

  it("선언된 도구와 내가 허용한 도구는 다른 사실이다", () => {
    const view = phoneAppDetail(detail, [READ]);
    expect(view.tools.map((tool) => [tool.name, tool.allowed])).toEqual([
      ["github.list_repositories", true],
      ["github.create_issue", false],
    ]);
    expect(view.statusMine).toBe("repo 읽기 권한 (허용한 도구 1개)");
    expect(view.blocked).toBe(false);
  });

  it("읽기 칩은 말하지 않고, 쓰기·네트워크 쓰기 승인만 칩이 된다", () => {
    const view = phoneAppDetail(detail, [READ]);
    expect(view.tools[0].chips).toEqual([]);
    expect(view.tools[1].chips).toEqual([
      { label: "승인: 네트워크 쓰기", tone: "danger" },
      { label: "위험도: 쓰기", tone: "warn" },
    ]);
    expect(view.toolsSummary).toBe("이 앱의 도구는 2개예요: 읽기 1개, 쓰기 1개.");
  });

  it("쓰기 승인 한 줄은 읽기 아닌 도구가 있을 때만 선다", () => {
    expect(phoneAppDetail(detail, [READ]).hasWriteTools).toBe(true);
    expect(phoneAppDetail({ ...detail, tools: [detail.tools[0]] }, [READ]).hasWriteTools).toBe(false);
    // 위험도를 모르는 도구는 읽기로 단정하지 않는다.
    expect(phoneAppDetail({ ...detail, tools: [{ name: "x", scopes: [] }] }, []).hasWriteTools).toBe(true);
  });

  it("허용한 도구가 없으면 상세도 막힘이다", () => {
    expect(phoneAppDetail(detail, undefined).blocked).toBe(true);
  });

  it("설명이 없는 도구만 이름이 제목이 되고, 식별자는 설명이 있을 때만 따라온다", () => {
    const view = phoneAppDetail(
      { ...detail, tools: [{ name: "x.y", scopes: [], risk: "read" }, detail.tools[0]] },
      [],
    );
    expect(view.tools[0]).toMatchObject({ title: "x.y", identifier: null });
    expect(view.tools[1]).toMatchObject({ title: "저장소 목록 읽기", identifier: "github.list_repositories" });
  });

  it("배포자 줄은 있는 것만", () => {
    expect(phoneAppDetail(detail, []).publisher).toEqual([
      { label: "배포자", value: "oort, oort 레지스트리가 확인했어요" },
      { label: "라이선스", value: "MIT" },
    ]);
    expect(phoneAppDetail({ ...detail, publisherName: undefined, license: undefined }, []).publisher).toEqual([]);
  });
});
