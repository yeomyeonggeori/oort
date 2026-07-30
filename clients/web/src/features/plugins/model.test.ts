import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import driveManifest from "../../../../../server/Fixtures/plugin-manifests/drive.json";
import githubManifest from "../../../../../server/Fixtures/plugin-manifests/github.json";
import linearManifest from "../../../../../server/Fixtures/plugin-manifests/linear.json";
import notionManifest from "../../../../../server/Fixtures/plugin-manifests/notion.json";
import {
  actionErrorForPlugin,
  activePluginScopes,
  administratorNames,
  callerPolicySummary,
  focusPluginActionAfterErrorDismissal,
  focusPluginScopeChangeFallback,
  identifiableScopeSentence,
  pluginActionButtonState,
  pluginActionConfirmation,
  pluginActionErrorMessage,
  pluginConsentScopeAction,
  pluginDetailErrorMessage,
  pluginMarketplaceNeedsDetailFocus,
  type PluginActionFocusTarget,
  pluginRoleState,
  pluginScopeChangeFallbackKind,
  pluginScopeConsentCompletion,
  pluginScopeChangeMessage,
  scopeSentence,
  settlePluginScopeChanges,
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
  });

  it("does not infer an administrator role after the roster read fails", () => {
    expect(pluginRoleState({ isPending: false, isError: true, role: "owner" }))
      .toBe("unknown");
    expect(pluginRoleState({ isPending: false, isError: false, role: undefined }))
      .toBe("unknown");
    expect(pluginRoleState({ isPending: false, isError: false, role: "owner" }))
      .toBe("known");
  });

  it("hands a detail off when its heading is clipped in either marketplace layout", () => {
    const viewport = { top: 45, bottom: 800 } as DOMRect;
    expect(pluginMarketplaceNeedsDetailFocus({ top: 56, bottom: 640 } as DOMRect, viewport)).toBe(false);
    expect(pluginMarketplaceNeedsDetailFocus({ top: -93, bottom: 580 } as DOMRect, viewport)).toBe(true);
    expect(pluginMarketplaceNeedsDetailFocus({ top: 816, bottom: 1200 } as DOMRect, viewport)).toBe(true);
  });

  it("keeps the active action focusable while locking its in-flight sibling", () => {
    expect(pluginActionButtonState({ busy: true, offline: false })).toEqual({
      disabled: false,
      ariaBusy: true,
    });
    expect(pluginActionButtonState({ busy: false, offline: false, blocked: true })).toEqual({
      disabled: true,
      ariaBusy: undefined,
    });
    expect(pluginActionButtonState({ busy: false, offline: true })).toEqual({
      disabled: true,
      ariaBusy: undefined,
    });
  });

  it("returns an error dismissal to the action that produced it", () => {
    const focus = vi.fn();
    const connected: PluginActionFocusTarget = { isConnected: true, focus };
    const disconnected: PluginActionFocusTarget = { isConnected: false, focus };
    expect(focusPluginActionAfterErrorDismissal(connected)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(focusPluginActionAfterErrorDismissal(disconnected)).toBe(false);
  });

  it("returns a completed grant to its still-present revoke control", () => {
    const ownerDocument = { activeElement: null as Element | null };
    const target = {
      isConnected: true,
      disabled: false,
      getAttribute: () => null,
      ownerDocument,
      focus: vi.fn(() => {
        ownerDocument.activeElement = target as unknown as Element;
      }),
    };
    expect(pluginScopeChangeFallbackKind("grant")).toBe("revoke");
    expect(pluginScopeChangeFallbackKind("revoke")).toBe("grant");
    expect(focusPluginScopeChangeFallback(target)).toBe(true);
    expect(target.focus).toHaveBeenCalledOnce();
  });

  it("does not claim focus arrived when the replacement is blocked or focus is a no-op", () => {
    const focus = vi.fn();
    const ownerDocument = { activeElement: null as Element | null };
    expect(focusPluginScopeChangeFallback({
      isConnected: true,
      disabled: true,
      getAttribute: () => null,
      ownerDocument,
      focus,
    })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(focusPluginScopeChangeFallback({
      isConnected: true,
      disabled: false,
      getAttribute: (name) => name === "aria-disabled" ? "true" : null,
      ownerDocument,
      focus,
    })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(focusPluginScopeChangeFallback({
      isConnected: true,
      disabled: false,
      getAttribute: () => null,
      ownerDocument,
      focus,
    })).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
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

  it("builds scope grants only after the consent surface explicitly confirms", () => {
    const input = {
      kind: "grant" as const,
      pluginId: "github",
      pluginName: "GitHub",
      declaredScopes: ["github:read", "github:write"],
      selectedScopes: ["github:read", "not-declared:admin"],
    };
    expect(pluginConsentScopeAction({ ...input, confirmed: false })).toBeNull();
    expect(pluginConsentScopeAction({ ...input, confirmed: true })).toEqual({
      kind: "grantScopes",
      pluginId: "github",
      pluginName: "GitHub",
      scopes: ["github:read"],
    });
  });

  it("derives active scopes from the effective tool policy rather than installation", () => {
    const tools = [
      { name: "github.list", scopes: ["github:read"] },
      { name: "github.create", scopes: ["github:write"] },
    ];
    expect(activePluginScopes(tools, [{
      name: "github.list", risk: "read", approvalTier: "read_only",
    }])).toEqual(["github:read"]);
  });

  it("gives every distinct seeded scope a distinct sentence without dropping unknown actions", () => {
    const scopes = [...new Set([
      githubManifest,
      notionManifest,
      linearManifest,
      driveManifest,
    ].flatMap((manifest) => manifest.mcp.tools.flatMap((tool) => tool.scopes)))];
    const sentences = scopes.map(scopeSentence);
    expect(new Set(sentences).size).toBe(scopes.length);
    expect(scopeSentence("github:read")).toBe("github 읽기 권한");
    expect(scopeSentence("github:write")).toBe("github 쓰기 권한");
    expect(scopeSentence("notion:comment")).toBe("notion 댓글 권한");
    expect(scopeSentence("notion:admin")).toBe("notion 관리 권한");
    expect(scopeSentence("google_workspace:manage_shared_drive_permissions"))
      .toBe("google workspace shared drive 관리 권한");
    expect(scopeSentence("no-separator")).toBe("사용 권한");
    expect(identifiableScopeSentence("no-separator"))
      .toBe("사용 권한 (no-separator)");
    expect(scopeSentence("notion:comment")).not.toBe(scopeSentence("notion:admin"));
  });

  it("keeps partial scope failures separate from completed server responses", async () => {
    const calls: string[] = [];
    const outcomes = await settlePluginScopeChanges(
      ["github:read", "github:issues", "github:write"],
      async (scope) => {
        calls.push(scope);
        if (scope === "github:issues") throw new Error("policy changed");
      }
    );
    expect(calls).toEqual(["github:read", "github:issues", "github:write"]);
    expect(outcomes.map((outcome) => [outcome.scope, outcome.succeeded])).toEqual([
      ["github:read", true],
      ["github:issues", false],
      ["github:write", true],
    ]);
    expect(pluginScopeChangeMessage("grant", outcomes))
      .toContain("2개 권한을 허용했습니다: github 읽기 권한, github 쓰기 권한. 1개는 변경하지 못했습니다");
  });

  it("keeps a full scope failure in the dialog and reports every distinct cause", () => {
    const repeatedCause = pluginActionErrorMessage(new ApiError(403, "not allowed"));
    const sameCauseCompletion = pluginScopeConsentCompletion([
      { scope: "notion:read", succeeded: false, error: new ApiError(403, "not allowed") },
      { scope: "notion:comment", succeeded: false, error: new ApiError(403, "not allowed") },
      { scope: "notion:write", succeeded: false, error: new ApiError(403, "not allowed") },
      { scope: "notion:admin", succeeded: false, error: new ApiError(403, "not allowed") },
    ]);
    expect(sameCauseCompletion.dismissDialog).toBe(false);
    if (sameCauseCompletion.dismissDialog) throw new Error("expected retained dialog");
    expect(sameCauseCompletion.error.split(repeatedCause)).toHaveLength(2);
    expect(sameCauseCompletion.error).toContain(
      "영향받은 권한: notion 읽기 권한 (notion:read), notion 댓글 권한 (notion:comment), notion 쓰기 권한 (notion:write), notion 관리 권한 (notion:admin)"
    );
    // 원인이 하나면 목록이 아니다: 표제 아래 홀로 선 불릿은 아무것도 가리키지
    // 않는다. 한 원인은 한 문단으로 남고, 배너는 ul을 그리지 않는다(MOMO-676 M-4).
    expect(sameCauseCompletion.causes).toEqual([]);

    const completion = pluginScopeConsentCompletion([
      { scope: "notion:comment", succeeded: false, error: new ApiError(403, "not allowed") },
      { scope: "notion:admin", succeeded: false, error: new ApiError(404, "not found") },
    ]);
    expect(completion.dismissDialog).toBe(false);
    if (completion.dismissDialog) throw new Error("expected retained dialog");
    expect(completion.error).toContain("원인 2가지를 확인하세요.");
    // 항목은 문장이지 서식이 아니다: "• "도 "\n"도 여기서 나오지 않는다.
    expect(completion.causes).toEqual([
      `${repeatedCause} 영향받은 권한: notion 댓글 권한 (notion:comment)`,
      `${pluginActionErrorMessage(new ApiError(404, "not found"))} 영향받은 권한: notion 관리 권한 (notion:admin)`,
    ]);
    expect(completion.error).not.toContain("\n");
  });

  // The banner lives inside a 272px scrollbox at 760x480, and a cause is a
  // sentence of remedy. Repeating it once per scope overflowed by 13px on a
  // four-scope failure (MOMO-642 5), so grouping is a height budget as much as
  // it is copy: N causes cost N sentences, never N x scopes.
  it("says each cause once no matter how many scopes it hit", () => {
    const policy = pluginActionErrorMessage(new ApiError(403, "not allowed"));
    const missing = pluginActionErrorMessage(new ApiError(404, "not found"));
    const completion = pluginScopeConsentCompletion([
      { scope: "notion:read", succeeded: false, error: new ApiError(403, "not allowed") },
      { scope: "notion:comment", succeeded: false, error: new ApiError(404, "not found") },
      { scope: "notion:write", succeeded: false, error: new ApiError(403, "not allowed") },
      { scope: "notion:admin", succeeded: false, error: new ApiError(403, "not allowed") },
    ]);
    if (completion.dismissDialog) throw new Error("expected retained dialog");
    const reported = [completion.error, ...completion.causes].join(" ");
    expect(reported.split(policy)).toHaveLength(2);
    expect(reported.split(missing)).toHaveLength(2);
    expect(completion.causes).toEqual([
      `${policy} 영향받은 권한: notion 읽기 권한 (notion:read), notion 쓰기 권한 (notion:write), notion 관리 권한 (notion:admin)`,
      `${missing} 영향받은 권한: notion 댓글 권한 (notion:comment)`,
    ]);
    // Four failures, one headline and one item per cause.
    expect(completion.causes).toHaveLength(2);
  });
});
