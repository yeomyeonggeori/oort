import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
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
  myGrantSentence,
  pluginActionButtonState,
  pluginActionConfirmation,
  pluginActionErrorMessage,
  pluginConsentScopeAction,
  pluginControlsVisible,
  pluginDetailErrorMessage,
  pluginIconText,
  pluginLicenseLabel,
  pluginMarketplaceNeedsDetailFocus,
  type PluginActionFocusTarget,
  pluginRoleState,
  pluginScopeChangeFallbackKind,
  pluginScopeConsentCompletion,
  pluginScopeChangeMessage,
  pluginSubtitle,
  pluginToolsSummary,
  scopeSentence,
  settlePluginScopeChanges,
  workspaceInstallSentence,
  pluginConnectionChipLabel,
  NO_INSTALLER_SENTENCE,
  nonAdminInstallGuidance,
  pluginConsentCustodyLines,
} from "./model";

describe("plugin marketplace copy", () => {
  it("names workspace installation separately from my permission", () => {
    expect(pluginConnectionChipLabel({ installed: true, enabled: true }, 0))
      .toBe("설치됨 · 내 허용 없음");
    expect(pluginConnectionChipLabel({ installed: true, enabled: true }, 2))
      .toBe("설치됨 · 내가 허용함");
    expect(pluginConnectionChipLabel({ installed: false, enabled: false }, 0)).toBe("미설치");
    expect(callerPolicySummary(undefined)).toBe("허용한 도구 없음");
    expect(callerPolicySummary([])).toBe("허용한 도구 없음");
    // 목록 줄은 개수만 말한다. 위험도는 상세의 도구 줄이 칩으로 말해서 같은 사실이 두 모양이 되지 않는다.
    expect(callerPolicySummary([{ risk: "read" }, { risk: "write" }]))
      .toBe("허용한 도구 2개");
  });

  it("keeps operator English out of action errors", () => {
    expect(pluginActionErrorMessage(new ApiError(
      403,
      "plugin serverPolicy rejects installation"
    ))).toBe("이 앱은 워크스페이스 정책이나 내 역할상 변경할 수 없어요. 관리자에게 정책과 권한을 확인하세요.");
    expect(pluginActionErrorMessage(new ApiError(
      409,
      "plugin is not installed and enabled"
    ))).toBe("이 앱이 설치되어 활성화된 상태가 아니에요. 앱 목록을 다시 불러온 뒤 다시 시도하세요.");
    expect(pluginActionErrorMessage(new ApiError(
      400,
      "scope is not declared by this plugin"
    ))).toBe("앱이 선언하지 않은 권한은 변경할 수 없어요. 앱 정보를 다시 불러온 뒤 다시 시도하세요.");
    expect(pluginDetailErrorMessage(new ApiError(
      403,
      "plugin is not installed and enabled"
    ))).toBe("이 앱의 상세 정보를 볼 권한이 없어요. 워크스페이스 관리자에게 권한을 확인하세요.");
  });

  it("names the destructive target and uses the action verb", () => {
    expect(pluginActionConfirmation({
      kind: "uninstall", pluginId: "linear", pluginName: "Linear",
    })).toEqual({
      title: "Linear 설치를 해제할까요?",
      description: "Linear 앱의 모든 멤버 권한이 함께 회수돼요.",
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
    }])).toEqual(["김인턴"]);
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
      .toContain("2개 권한을 허용했어요: github 읽기 권한, github 쓰기 권한. 1개는 변경하지 못했어요");
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

// ---- 읽기 전용 카탈로그 (#3860) ----------------------------------------------------------------
// 입력은 서버가 시드하는 매니페스트에서 가져온다. 지어낸 앱으로 문장을 재면 실제 네 앱에서
// 깨지는 문장을 놓친다.

const OFFICIAL_IDS = [
  driveManifest.plugin.id,
  githubManifest.plugin.id,
  linearManifest.plugin.id,
  notionManifest.plugin.id,
];

describe("읽기 전용 카탈로그의 문장", () => {
  it("공식 네 앱은 영어 매니페스트 문구 대신 한국어 한 줄 소개로 선다", () => {
    for (const manifest of [driveManifest, githubManifest, linearManifest, notionManifest]) {
      const line = pluginSubtitle({
        pluginId: manifest.plugin.id,
        description: manifest.plugin.description,
      });
      expect(line, manifest.plugin.id).not.toBe(manifest.plugin.description);
      // 한국어 목록에 영어 문장과 내부 약어를 먼저 보이지 않는다.
      expect(line).toMatch(/[가-힣]/);
      expect(line).not.toMatch(/MCP|Official|hosted/i);
    }
  });

  it("표에 없는 앱은 서버 문구로 돌아가고, 대소문자는 가리지 않는다", () => {
    expect(pluginSubtitle({ pluginId: "com.example.unknown", description: "Unknown app" }))
      .toBe("Unknown app");
    expect(pluginSubtitle({ pluginId: githubManifest.plugin.id.toUpperCase(), description: "x" }))
      .not.toBe("x");
  });

  it("앱 타일 글자는 서버가 준 것을 먼저 쓰고, 없으면 이름의 머리글자(최대 둘)다", () => {
    expect(pluginIconText({ name: "GitHub", iconText: " GH " })).toBe("GH");
    expect(pluginIconText({ name: "GitHub" })).toBe("G");
    // 「Google Drive」와 「GitHub」가 같은 「G」 타일이면 목록에서 서로 구별되지 않는다.
    expect(pluginIconText({ name: "Google Drive" })).toBe("GD");
    expect(pluginIconText({ name: "Google Drive" })).not.toBe(pluginIconText({ name: "GitHub" }));
    expect(pluginIconText({ name: "노션 앱 서비스" })).toBe("노앱");
    expect(pluginIconText({ name: "  " })).toBe("?");
  });

  it("공식 네 앱의 타일 글자는 서로 다르다", () => {
    const tiles = [driveManifest, githubManifest, linearManifest, notionManifest]
      .map((manifest) => pluginIconText({ name: manifest.plugin.name }));
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it("서버가 허용한 SPDX가 아닌 하나(Linear)는 읽을 수 있는 이름으로 보이고 나머지는 그대로다", () => {
    expect(pluginLicenseLabel(linearManifest.plugin.license.spdx)).toBe("Linear 호스팅 서비스 약관");
    expect(pluginLicenseLabel(githubManifest.plugin.license.spdx)).toBe("MIT");
    expect(pluginLicenseLabel(driveManifest.plugin.license.spdx)).toBe("Apache-2.0");
  });

  it("검색·보기 컨트롤은 목록이 한눈에 읽히는 길이(여섯 줄)를 넘을 때만 선다", () => {
    expect([0, 1, 4, 6].map(pluginControlsVisible)).toEqual([false, false, false, false]);
    expect([7, 12, 40].map(pluginControlsVisible)).toEqual([true, true, true]);
  });

  it("설치 상태는 설치·활성 두 사실을 세 문장으로 가른다", () => {
    expect(workspaceInstallSentence({ installed: false, enabled: false })).toBe("설치하지 않았어요");
    expect(workspaceInstallSentence({ installed: true, enabled: true })).toBe("설치돼 있어요");
    // 목록 칩(「워크스페이스 비활성」)과 같은 말이다: 같은 상태가 화면 둘에서 다른 낱말이 되지 않는다.
    expect(workspaceInstallSentence({ installed: true, enabled: false })).toBe("설치했지만 비활성이에요");
    expect(pluginConnectionChipLabel({ installed: true, enabled: false }, 0)).toContain("비활성");
  });

  it("내 권한은 정책이 싣는 것만 말한다: 설치와 무관하게 비어 있을 수 있다", () => {
    expect(myGrantSentence([], 0)).toBe("허용한 권한이 없어요");
    expect(myGrantSentence(["github:read"], 2)).toBe("github 읽기 권한 (허용한 도구 2개)");
    // 정책에는 도구가 있는데 매니페스트와 이어 보지 못한 경우: 권한 이름을 지어내지 않는다.
    expect(myGrantSentence([], 2)).toBe("허용한 도구 2개");
  });

  it("꺼진 설치에서 비어 있는 정책은 「허용한 적 없다」가 아니라 「지금 적용되는 것이 없다」다", () => {
    // 서버의 정책 질의는 grant를 설치가 켜져 있을 때만 센다. 꺼진 앱의 빈 정책에 「허용한 권한이 없어요」라고
    // 하면 이 화면이 모르는 사실(허용한 적이 없다)을 말하게 된다(독립 design-review #3860 M3).
    expect(myGrantSentence([], 0, { installed: true, enabled: false })).toBe("비활성인 동안은 적용되는 권한이 없어요");
    expect(myGrantSentence([], 0, { installed: false, enabled: false })).toBe("허용한 권한이 없어요");
    expect(myGrantSentence([], 0, { installed: true, enabled: true })).toBe("허용한 권한이 없어요");
  });

  it("도구 한 줄 요약: 읽기만 있으면 그렇게 말하고, 섞이면 종류별로 센다", () => {
    // 「이 앱의 도구」(선언된 수)는 내 권한 줄의 「허용한 도구」(허용된 수)와 다른 수다. 낱말로 갈라 둔다.
    expect(pluginToolsSummary(githubManifest.mcp.tools)).toBe("이 앱의 도구는 36개예요: 읽기 26개, 쓰기 10개.");
    expect(pluginToolsSummary(driveManifest.mcp.tools)).toBe("이 앱의 도구는 3개이고, 모두 읽기 도구예요.");
    expect(pluginToolsSummary([{ risk: "read" }, { risk: "write" }, { risk: "write" }]))
      .toBe("이 앱의 도구는 3개예요: 읽기 1개, 쓰기 2개.");
    expect(pluginToolsSummary([{ risk: "read" }, { risk: "admin" }]))
      .toBe("이 앱의 도구는 2개예요: 읽기 1개, 관리자 1개.");
    expect(pluginToolsSummary([])).toBeNull();
  });

  it("네 앱의 도구 설명은 이미 한국어 문장이다(화면이 영어를 번역하지 않는다)", () => {
    for (const manifest of [driveManifest, githubManifest, linearManifest, notionManifest]) {
      for (const tool of manifest.mcp.tools) expect(tool.description, tool.name).toMatch(/[가-힣]/);
    }
    expect(OFFICIAL_IDS).toHaveLength(4);
  });
});

describe("설치 요청 안내와 관리자 없음 상태 (#3943)", () => {
  const person = (
    displayName: string,
    handle: string,
    role: "owner" | "admin" | "member",
    over: Record<string, unknown> = {}
  ) => ({ displayName, handle, role, status: "active", kind: "human" as const, ...over });

  it("관리자가 있으면 「○○님(관리자)에게 설치를 요청하세요」", () => {
    expect(nonAdminInstallGuidance(["곽성재"])).toBe("곽성재님(관리자)에게 설치를 요청하세요.");
    expect(nonAdminInstallGuidance(["곽성재", "김인턴"])).toBe("곽성재님, 김인턴님(관리자)에게 설치를 요청하세요.");
    expect(nonAdminInstallGuidance(["가", "나", "다", "라"])).toBe("가님, 나님 외 2명(관리자)에게 설치를 요청하세요.");
  });

  it("활성 관리자가 없으면 부탁할 사람이 없다고 그대로 말한다", () => {
    expect(NO_INSTALLER_SENTENCE).toBe("이 워크스페이스에 앱을 설치할 사람이 없어요. 소유자 계정을 확인해 주세요.");
    expect(nonAdminInstallGuidance([])).toBe(NO_INSTALLER_SENTENCE);
  });

  it("설치할 사람은 활성 상태의 사람 owner·admin뿐이다: 멤버·정지·초대·에이전트는 아니다", () => {
    const names = administratorNames([
      person("소유자", "owner1", "owner"),
      person("관리자", "admin1", "admin"),
      person("일반", "mem", "member"),
      person("정지된 관리자", "susp", "admin", { status: "suspended" }),
      person("초대 중 관리자", "inv", "admin", { status: "invited" }),
      person("관리자 에이전트", "bot", "admin", { kind: "agent" }),
      { displayName: "역할 없음", handle: "norole", status: "active", kind: "human" as const },
    ]);
    expect(names).toEqual(["소유자", "관리자"]);
    expect(administratorNames([person("일반", "m", "member")])).toEqual([]);
  });

  it("이름이 같은 관리자 둘은 핸들로 구별하고, 이름이 비면 핸들이 이름이다", () => {
    expect(administratorNames([person("김", "a", "admin"), person("김", "b", "owner")]))
      .toEqual(["김 (@a)", "김 (@b)"]);
    expect(administratorNames([person("  ", "ghost", "admin")])).toEqual(["@ghost"]);
  });
});

describe("허용 동의 창의 두 줄 (#3943)", () => {
  it("D1-A 앱에는 두 줄을 그대로 보인다", () => {
    expect(pluginConsentCustodyLines({})).toEqual([
      "토큰은 oort에 없어요",
      "처음 쓸 때 실행 장소에서 로그인해요",
    ]);
    expect(pluginConsentCustodyLines({ hosted: false })).toHaveLength(2);
  });

  it("oort 서버가 연결을 들고 있는 앱(hosted)에는 맞지 않는 말이라 하지 않는다", () => {
    expect(pluginConsentCustodyLines({ hosted: true })).toEqual([]);
  });
});
