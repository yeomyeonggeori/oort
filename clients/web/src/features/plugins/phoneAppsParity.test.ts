// 폰 「앱」 읽기 화면(U-4 #3951)의 문장은 코어 `phoneApps.ts` 에 있고, 웹 `model.ts` 가 같은 사실을
// 같은 글자로 말한다. 폰은 웹 코드를 가져올 수 없어서 글자를 한 번 더 두었다 — 이 시험이 둘이 갈라지는
// 날 실패한다. 고칠 곳은 두 파일이다.
import { describe, expect, it } from "vitest";
import * as phone from "@momo/core/features/plugins/phoneApps";
import * as web from "./model";
import { resolveSettingsSection } from "../settings/settingsNav";

const SCOPES = [
  "repo:read",
  "issues:write",
  "pages:admin",
  "comments:comment",
  "drive:manage_shared_permissions",
  "files:list_all",
  "broken",
  ":read",
  "",
];
const RISKS = ["read", "write", "admin", "", "weird"];
const TIERS = [undefined, "read_only", "workspace_write", "network_write", "weird"];
const IDS = [
  "com.momo.plugins.github",
  "com.momo.plugins.notion",
  "com.momo.plugins.linear",
  "com.momo.plugins.drive",
  "com.momo.plugins.gmail",
  "com.momo.plugins.google-calendar",
  "com.momo.plugins.google-drive",
  "COM.MOMO.PLUGINS.GITHUB",
  "other.app",
];

describe("폰 앱 모델 = 웹 앱 모델", () => {
  it("범위·위험도·승인 단계 문장", () => {
    for (const scope of SCOPES) {
      expect(phone.scopeSentence(scope)).toBe(web.scopeSentence(scope));
      expect(phone.identifiableScopeSentence(scope)).toBe(web.identifiableScopeSentence(scope));
    }
    for (const risk of RISKS) expect(phone.riskLabel(risk)).toBe(web.riskLabel(risk));
    for (const tier of TIERS) expect(phone.approvalLabel(tier)).toBe(web.approvalLabel(tier));
  });

  it("한 줄 소개·타일 글자·라이선스", () => {
    for (const pluginId of IDS) {
      expect(phone.pluginSubtitle({ pluginId, description: "D" })).toBe(web.pluginSubtitle({ pluginId, description: "D" }));
    }
    for (const name of ["GitHub", "Google Drive", "  ", "한글 앱", "x"]) {
      for (const iconText of [undefined, " ", "GH"]) {
        expect(phone.pluginIconText({ name, iconText })).toBe(web.pluginIconText({ name, iconText }));
      }
    }
    // 타일 글자 표(#3949): 같은 id는 폰과 웹이 같은 글자를 그린다.
    for (const pluginId of IDS) {
      for (const name of ["GitHub", "Gmail", "Google 내 드라이브"]) {
        expect(phone.pluginIconText({ pluginId, name })).toBe(web.pluginIconText({ pluginId, name }));
      }
    }
    for (const spdx of ["MIT", "LicenseRef-Linear-Hosted-Service"]) {
      expect(phone.pluginLicenseLabel(spdx)).toBe(web.pluginLicenseLabel(spdx));
    }
  });

  it("설치 상태·내 권한·도구 요약", () => {
    for (const installed of [true, false]) {
      for (const enabled of [true, false]) {
        expect(phone.workspaceInstallSentence({ installed, enabled })).toBe(web.workspaceInstallSentence({ installed, enabled }));
        for (const [scopes, count] of [[[], 0], [[], 2], [["repo:read", "broken"], 1]] as const) {
          expect(phone.myGrantSentence(scopes, count, { installed, enabled })).toBe(web.myGrantSentence(scopes, count, { installed, enabled }));
        }
      }
    }
    for (const tools of [[], [{ risk: "read" }], [{ risk: "read" }, { risk: "write" }], [{}]]) {
      expect(phone.pluginToolsSummary(tools)).toBe(web.pluginToolsSummary(tools));
    }
  });

  it("공용 문구 상수", () => {
    const copy = web.PLUGIN_READONLY_COPY;
    expect(phone.PHONE_APPS_COPY.toolsHeading).toBe(copy.tools.heading);
    expect(phone.PHONE_APPS_COPY.toolsNone).toBe(copy.tools.none);
    expect(phone.PHONE_APPS_COPY.toolAllowed).toBe(copy.tools.allowed);
    expect(phone.PHONE_APPS_COPY.egressHeading).toBe(copy.egress.heading);
    expect(phone.PHONE_APPS_COPY.egressLead).toBe(copy.egress.lead);
    expect(phone.PHONE_APPS_COPY.egressNone).toBe(copy.egress.none);
    expect(phone.PHONE_APPS_COPY.publisherHeading).toBe(copy.publisher.heading);
    expect(phone.PHONE_APPS_COPY.statusWorkspace).toBe(copy.status.workspace);
    expect(phone.PHONE_APPS_COPY.statusMine).toBe(copy.status.mine);
    expect(phone.PHONE_APPS_COPY.emptyHeadline).toBe(copy.empty.headline);
    expect(phone.PHONE_APPS_COPY.emptyDetail).toBe(copy.empty.noneRegistered);
  });

  it("폰 「웹에서 열기」의 section id 를 웹이 앱 화면으로 푼다", () => {
    const section = new URL(`https://x${phone.appsOnWebPath()}`).searchParams.get("section") ?? "";
    expect(resolveSettingsSection(section)).toEqual({ kind: "ai-hub", path: "/ai/external/apps" });
  });
});
