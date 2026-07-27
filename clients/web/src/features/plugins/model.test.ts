import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  actionErrorForPlugin,
  administratorNames,
  callerPolicySummary,
  pluginActionConfirmation,
  pluginActionErrorMessage,
  pluginDetailErrorMessage,
  pluginRoleState,
  workspaceInstallationLabel,
} from "./model";

describe("plugin marketplace copy", () => {
  it("names workspace installation separately from my permission", () => {
    expect(workspaceInstallationLabel({ installed: true, enabled: true }))
      .toBe("워크스페이스 설치됨");
    expect(callerPolicySummary(undefined)).toBe("내 권한 도구: 없음");
    expect(callerPolicySummary([{ risk: "read" }]))
      .toBe("내 권한 도구 위험도: 읽기");
  });

  it("keeps operator English out of action errors", () => {
    expect(pluginActionErrorMessage(new ApiError(
      403,
      "plugin serverPolicy rejects installation"
    ))).toBe("이 앱은 워크스페이스 정책이나 내 역할상 변경할 수 없습니다. 관리자에게 정책과 권한을 확인하세요.");
    expect(pluginActionErrorMessage(new ApiError(
      409,
      "plugin is not installed and enabled"
    ))).toBe("이 앱이 설치되어 활성화된 상태가 아닙니다. 앱 목록을 다시 불러온 뒤 다시 시도하세요.");
    expect(pluginActionErrorMessage(new ApiError(
      400,
      "scope is not declared by this plugin"
    ))).toBe("앱이 선언하지 않은 권한은 변경할 수 없습니다. 앱 정보를 다시 불러온 뒤 다시 시도하세요.");
    expect(pluginDetailErrorMessage(new ApiError(
      403,
      "plugin is not installed and enabled"
    ))).toBe("이 앱의 상세 정보를 볼 권한이 없습니다. 워크스페이스 관리자에게 권한을 확인하세요.");
  });

  it("names the destructive target and uses the action verb", () => {
    expect(pluginActionConfirmation({
      kind: "uninstall", pluginId: "linear", pluginName: "Linear",
    })).toEqual({
      title: "Linear 설치를 해제할까요?",
      description: "Linear 앱의 모든 멤버 권한이 함께 회수됩니다.",
      confirmLabel: "설치 해제",
    });
    expect(pluginActionConfirmation({
      kind: "revokeGrant", pluginId: "linear", pluginName: "Linear", scope: "linear:read",
    })).toMatchObject({
      title: "Linear 권한을 회수할까요?",
      confirmLabel: "내 권한 회수",
    });
  });

  it("does not infer an administrator role after the roster read fails", () => {
    expect(pluginRoleState({ isPending: false, isError: true, role: "owner" }))
      .toBe("unknown");
    expect(pluginRoleState({ isPending: false, isError: false, role: undefined }))
      .toBe("unknown");
    expect(pluginRoleState({ isPending: false, isError: false, role: "owner" }))
      .toBe("known");
  });

  it("identifies administrators by handle and keeps an action error with its app", () => {
    expect(administratorNames([{
      displayName: "김인턴", handle: "intern-kim", role: "admin", status: "active",
    }])).toEqual(["김인턴 (@intern-kim)"]);
    const action = { kind: "install", pluginId: "github", pluginName: "GitHub" } as const;
    const error = new ApiError(403, "plugin serverPolicy rejects installation");
    expect(actionErrorForPlugin(action, "linear", error)).toBeNull();
    expect(actionErrorForPlugin(action, "github", error)).toContain("워크스페이스 정책");
  });
});
