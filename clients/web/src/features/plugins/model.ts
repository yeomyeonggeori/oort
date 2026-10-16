import {
  ApiError,
  type MembershipRole,
  type PluginManifestTool,
  type PluginPolicyTool,
} from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";

export type PluginAction =
  | { kind: "install"; pluginId: string; pluginName: string }
  | { kind: "uninstall"; pluginId: string; pluginName: string }
  | { kind: "grantScopes"; pluginId: string; pluginName: string; scopes: string[] }
  | { kind: "revokeScopes"; pluginId: string; pluginName: string; scopes: string[] };

export type PluginScopeChangeKind = "grant" | "revoke";

export type PluginScopeChangeOutcome = {
  scope: string;
  succeeded: boolean;
  error?: unknown;
};

export type PluginRoleState = "checking" | "known" | "unknown";

type VerticalBounds = Pick<DOMRect, "top" | "bottom">;

/**
 * A selected detail needs a handoff whenever its heading is outside the
 * settings scroll viewport. This is deliberately independent of the CSS grid:
 * a two-column detail can be clipped above the fold after the catalog scrolls.
 */
export function pluginMarketplaceNeedsDetailFocus(
  detail: VerticalBounds,
  viewport: VerticalBounds
): boolean {
  return detail.top < viewport.top || detail.top >= viewport.bottom;
}

export type PluginActionFocusTarget = Pick<HTMLButtonElement, "isConnected" | "focus">;
export type PluginScopeFocusTarget = PluginActionFocusTarget & {
  disabled?: boolean;
  getAttribute?: (name: string) => string | null;
  ownerDocument?: Pick<Document, "activeElement">;
};

/** Keeps the keyboard position on the action that produced a dismissed error. */
export function focusPluginActionAfterErrorDismissal(
  actionButton: PluginActionFocusTarget | null
): boolean {
  if (!actionButton?.isConnected) return false;
  actionButton.focus();
  return true;
}

/** A completed scope change replaces its own action with the complementary one. */
export function pluginScopeChangeFallbackKind(
  kind: PluginScopeChangeKind
): PluginScopeChangeKind {
  return kind === "grant" ? "revoke" : "grant";
}

/** Keeps focus in the detail controls when a completed scope change unmounts its opener. */
export function focusPluginScopeChangeFallback(
  actionButton: PluginScopeFocusTarget | null
): boolean {
  if (
    !actionButton?.isConnected ||
    actionButton.disabled === true ||
    actionButton.getAttribute?.("aria-disabled") === "true"
  ) {
    return false;
  }
  actionButton.focus();
  return actionButton.ownerDocument?.activeElement === actionButton as unknown as Element;
}

/**
 * A write in progress is observable, not unavailable. Keeping the button
 * enabled preserves the focused element through both success and failure;
 * callers reject duplicate clicks while this state is true.
 */
export function pluginActionButtonState({
  busy,
  offline,
  blocked = false,
}: {
  busy: boolean;
  offline: boolean;
  /** A sibling mutation is in progress, so this action must not replace it. */
  blocked?: boolean;
}): { disabled: boolean; ariaBusy: true | undefined } {
  return { disabled: offline || blocked, ariaBusy: busy || undefined };
}

export function isWorkspaceAdmin(role: MembershipRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function pluginRoleState({
  isPending,
  isError,
  role,
}: {
  isPending: boolean;
  isError: boolean;
  role: MembershipRole | undefined;
}): PluginRoleState {
  if (isPending) return "checking";
  if (isError || role === undefined) return "unknown";
  return "known";
}

export function riskLabel(risk: string): string {
  if (risk === "read") return "읽기";
  if (risk === "write") return "쓰기";
  if (risk === "admin") return "관리자";
  return "정보 없음";
}

export function approvalLabel(tier: string | undefined): string | null {
  if (tier === "read_only") return "읽기 전용";
  if (tier === "workspace_write") return "워크스페이스 쓰기";
  if (tier === "network_write") return "네트워크 쓰기";
  return null;
}

/** Turns a manifest identifier into a short sentence; the exact id is separate metadata. */
export function scopeSentence(scope: string): string {
  const [resource, action] = scope.split(":", 2);
  if (!resource || !action) return "사용 권한";
  const name = resource.replaceAll("_", " ");
  if (action === "read") return `${name} 읽기 권한`;
  if (action === "write") return `${name} 쓰기 권한`;
  if (action === "admin") return `${name} 관리 권한`;
  if (action === "comment") return `${name} 댓글 권한`;
  const managed = action.match(/^manage_(.+)_permissions$/);
  if (managed) return `${name} ${managed[1].replaceAll("_", " ")} 관리 권한`;
  return `${name} ${action.replaceAll("_", " ")} 권한`;
}

/**
 * Compact summaries do not have the dialog's separate monospace id row.
 * Preserve malformed or delimiter-free identifiers there so two unknown
 * scopes never collapse into the same unreportable "사용 권한" label.
 */
export function identifiableScopeSentence(scope: string): string {
  const sentence = scopeSentence(scope);
  return sentence === "사용 권한" ? `${sentence} (${scope})` : sentence;
}

/** Manifest order is product order: it is the order the publisher declared. */
export function declaredPluginScopes(tools: readonly PluginManifestTool[]): string[] {
  return [...new Set(tools.flatMap((tool) => tool.scopes))];
}

/**
 * The catalog only projects tools that the calling member can actually use.
 * Joining those tool names back to manifest scope declarations gives the UI a
 * scope-level view without inventing a new read endpoint.
 */
export function activePluginScopes(
  tools: readonly PluginManifestTool[],
  policyTools: readonly PluginPolicyTool[]
): string[] {
  const activeToolNames = new Set(policyTools.map((tool) => tool.name));
  return declaredPluginScopes(tools).filter((scope) => tools.some(
    (tool) => activeToolNames.has(tool.name) && tool.scopes.includes(scope)
  ));
}

export function remainingPluginScopes(
  declaredScopes: readonly string[],
  activeScopes: readonly string[]
): string[] {
  const active = new Set(activeScopes);
  return declaredScopes.filter((scope) => !active.has(scope));
}

/**
 * A scope POST has exactly one construction path: an open consent surface
 * must have been explicitly confirmed, and its selection is intersected with
 * the manifest before it can become a mutation action.
 */
export function pluginConsentScopeAction({
  kind,
  pluginId,
  pluginName,
  declaredScopes,
  selectedScopes,
  confirmed,
}: {
  kind: PluginScopeChangeKind;
  pluginId: string;
  pluginName: string;
  declaredScopes: readonly string[];
  selectedScopes: readonly string[];
  confirmed: boolean;
}): Extract<PluginAction, { kind: "grantScopes" | "revokeScopes" }> | null {
  if (!confirmed) return null;
  const selected = new Set(selectedScopes);
  const scopes = declaredScopes.filter((scope) => selected.has(scope));
  if (scopes.length === 0) return null;
  return kind === "grant"
    ? { kind: "grantScopes", pluginId, pluginName, scopes }
    : { kind: "revokeScopes", pluginId, pluginName, scopes };
}

/**
 * The server accepts one scope per request. Continue after a failure so the
 * receipt names every confirmed server response instead of collapsing a
 * partial result into a misleading all-or-nothing state.
 */
export async function settlePluginScopeChanges(
  scopes: readonly string[],
  changeScope: (scope: string) => Promise<unknown>
): Promise<PluginScopeChangeOutcome[]> {
  const outcomes: PluginScopeChangeOutcome[] = [];
  for (const scope of new Set(scopes)) {
    try {
      await changeScope(scope);
      outcomes.push({ scope, succeeded: true });
    } catch (error) {
      outcomes.push({ scope, succeeded: false, error });
    }
  }
  return outcomes;
}

export type PluginScopeConsentFailure = {
  /** The one sentence that names what failed. Always the banner's message. */
  error: string;
  /** One entry per distinct cause, and empty when a single cause fits `error`. */
  causes: string[];
};

export type PluginScopeConsentCompletion =
  | { dismissDialog: true }
  | ({ dismissDialog: false } & PluginScopeConsentFailure);

/**
 * A scope POST settles independently, so a transport success can still contain
 * only failures. Keep that selection in the dialog when every request failed:
 * retrying the same checked scopes is the next useful action. Report every
 * distinct actionable cause: a mixed 403/404 batch must not sound as if all
 * requests failed for the first scope's reason.
 *
 * Both shapes group BY CAUSE, one cause once, with the scopes it hit listed
 * under it. The per-scope shape this replaced repeated a whole sentence of
 * remedy for every scope, so a four-scope failure ran 281px inside a 272px
 * scrollbox at 760x480 and lost its bottom padding (MOMO-642 5). Grouping is
 * also what the reader needs: the cause is the thing they can act on, and the
 * scopes are the set it applies to.
 *
 * What each shape returns is now the shape itself, not typography (MOMO-676
 * M-4). One cause is one sentence and stays prose; several causes are a LIST
 * and are handed over as one, for the banner to render as `ul`/`li`. The
 * previous version composed `"• " + sentence` and joined with `\n`, which gave
 * the reader a bullet drawn in text with no hanging indent and gave a screen
 * reader one long sentence inside a `role="alert"`. This function does not
 * decide how a list looks; it decides that there is one.
 */
export function pluginScopeConsentCompletion(
  outcomes: readonly PluginScopeChangeOutcome[]
): PluginScopeConsentCompletion {
  const failed = outcomes.filter((outcome) => !outcome.succeeded);
  if (outcomes.length > 0 && failed.length === outcomes.length) {
    const causes = [...new Set(failed.map((outcome) =>
      pluginActionErrorMessage(outcome.error)
    ))];
    const affectedBy = (cause: string) => failed
      .filter((outcome) => pluginActionErrorMessage(outcome.error) === cause)
      .map((outcome) => `${scopeSentence(outcome.scope)} (${outcome.scope})`)
      .join(", ");
    // A list of one is not a list: a lone bullet under a headline is a marker
    // pointing at nothing. The single-cause report stays one paragraph.
    if (causes.length === 1) {
      return {
        dismissDialog: false,
        error: `선택한 권한을 변경하지 못했어요. 원인: ${causes[0]} 영향받은 권한: ${affectedBy(causes[0])}`,
        causes: [],
      };
    }
    return {
      dismissDialog: false,
      error: `선택한 권한을 변경하지 못했어요. 원인 ${causes.length}가지를 확인하세요.`,
      causes: causes.map((cause) => `${cause} 영향받은 권한: ${affectedBy(cause)}`),
    };
  }
  return { dismissDialog: true };
}

export function pluginScopeChangeMessage(
  kind: PluginScopeChangeKind,
  outcomes: readonly PluginScopeChangeOutcome[]
): string {
  const completed = outcomes.filter((outcome) => outcome.succeeded);
  const failed = outcomes.filter((outcome) => !outcome.succeeded);
  const verb = kind === "grant" ? "허용" : "회수";
  const completedNames = completed.map((outcome) => scopeSentence(outcome.scope)).join(", ");
  if (failed.length === 0) {
    return `선택한 ${completed.length}개 권한을 ${verb}했어요: ${completedNames}`;
  }
  if (completed.length === 0) {
    return `선택한 권한을 ${verb}하지 못했어요. 현재 권한을 다시 확인하세요.`;
  }
  return `${completed.length}개 권한을 ${verb}했어요: ${completedNames}. ${failed.length}개는 변경하지 못했어요: ${failed.map((outcome) => scopeSentence(outcome.scope)).join(", ")}`;
}

export function pluginScopeChangeTone(
  outcomes: readonly PluginScopeChangeOutcome[]
): "error" | "neutral" {
  return outcomes.some((outcome) => !outcome.succeeded) ? "error" : "neutral";
}

export function toolsForPluginScope(
  tools: readonly PluginManifestTool[],
  scope: string
): PluginManifestTool[] {
  return tools.filter((tool) => tool.scopes.includes(scope));
}

/**
 * 목록 한 줄이 말하는 「내가 허용한 도구」. 위험도는 상세의 도구 줄이 칩으로 말한다.
 * 목록에서 위험도를 또 말하면 같은 사실이 두 곳에서 다른 모양이 된다.
 */
export function callerPolicySummary(
  tools: readonly { risk: string }[] | undefined
): string {
  if (!tools?.length) return "허용한 도구 없음";
  return `허용한 도구 ${tools.length}개`;
}

export function workspaceInstallationLabel({
  installed,
  enabled,
}: {
  installed: boolean;
  enabled: boolean;
}): string {
  if (!installed) return "워크스페이스 미설치";
  return enabled ? "워크스페이스 설치됨" : "워크스페이스 비활성";
}

export function administratorNames(
  members: readonly {
    displayName: string;
    handle: string;
    role?: MembershipRole;
    status: string;
  }[]
): string[] {
  return members
    .filter((member) => member.status === "active" && isWorkspaceAdmin(member.role))
    .map((member) => {
      const name = member.displayName.trim();
      return name ? `${name} (@${member.handle})` : `@${member.handle}`;
    });
}

export function nonAdminInstallGuidance(names: readonly string[]): string {
  const people = names.length <= 2
    ? names.join(", ")
    : `${names.slice(0, 2).join(", ")} 외 ${names.length - 2}명`;
  const next = people
    ? `${people}에게 설치를 요청하세요.`
    : "워크스페이스 관리자에게 설치를 요청하세요.";
  return `앱 설치는 워크스페이스 관리자만 할 수 있어요. ${next}`;
}

export function pluginActionErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return "앱이 선언하지 않은 권한은 변경할 수 없어요. 앱 정보를 다시 불러온 뒤 다시 시도하세요.";
      case 403:
        return "이 앱은 워크스페이스 정책이나 내 역할상 변경할 수 없어요. 관리자에게 정책과 권한을 확인하세요.";
      case 404:
        return "앱 또는 내 권한을 찾지 못했어요. 앱 목록을 다시 불러온 뒤 다시 시도하세요.";
      case 409:
        return "이 앱이 설치되어 활성화된 상태가 아니에요. 앱 목록을 다시 불러온 뒤 다시 시도하세요.";
      default:
        return "앱 변경을 완료하지 못했어요. 잠시 뒤에 다시 시도하세요.";
    }
  }
  return "앱 변경을 완료하지 못했어요. 잠시 뒤에 다시 시도하세요.";
}

/** An error stays with the plugin whose mutation produced it, even after the
 * person selects another catalog row. Showing GitHub's failure under Linear's
 * actions would make a failed change look like a problem with the wrong app. */
export function actionErrorForPlugin(
  action: PluginAction | undefined,
  selectedPluginId: string,
  error: unknown
): string | null {
  if (!action || action.pluginId !== selectedPluginId) return null;
  return pluginActionErrorMessage(error);
}

export function pluginDetailErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "이 앱의 상세 정보를 볼 권한이 없어요. 워크스페이스 관리자에게 권한을 확인하세요.";
    }
    if (error.status === 404) {
      return "이 앱을 찾지 못했어요. 앱 목록을 다시 불러온 뒤 다시 선택하세요.";
    }
  }
  return "앱 상세 정보를 읽지 못했어요. 잠시 뒤에 다시 시도하세요.";
}

export function pluginActionConfirmation(action: Extract<PluginAction, {
  kind: "uninstall";
}>): { title: string; description: string; confirmLabel: string } {
  return {
    title: `${action.pluginName} 설치를 해제할까요?`,
    description: `${action.pluginName} 앱의 모든 멤버 권한이 함께 회수돼요.`,
    confirmLabel: "설치 해제",
  };
}

// ---- 읽기 전용 카탈로그 (#3860, ADR-0113 증보 P-U1) ---------------------------------
//
// 서버가 설치·권한 경로를 싣지 않는 동안(`pluginInstall`) 「앱」 화면은 읽기만 한다. 아래는
// 그 화면이 말하는 문장들이다. 문장은 사실만 옮긴다: 매니페스트와 서버 답에 있는 것만
// 쓰고, 서버가 아직 하지 않는 일(에이전트가 이 앱을 실제로 부른다는 약속, 토큰을 어디에
// 둔다는 보증)은 말하지 않는다. 설치 화면이 열리면 같은 문장이 그대로 맞아야 한다.

/** 서버가 주는 `iconText`가 없을 때 쓰는 타일 글자: 이름의 머리글자 둘까지("Google Drive"는 "GD"). */
export function pluginIconText(plugin: { name: string; iconText?: string }): string {
  const given = plugin.iconText?.trim();
  if (given) return given;
  const initials = plugin.name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => [...word][0]?.toLocaleUpperCase() ?? "")
    .join("");
  return initials === "" ? "?" : initials;
}

/**
 * 공식 네 앱의 한 줄 소개. 서버가 주는 `description`은 영어 매니페스트 문구
 * ("Official GitHub hosted MCP integration")라서 한국어 목록에 그대로 서면 읽는 사람이
 * 영어와 내부 약어를 먼저 만난다. 이 표는 **서비스가 무엇인지**만 말하고 oort가 그것으로
 * 무엇을 하는지는 말하지 않는다(그건 아래 「할 수 있는 일」이 매니페스트에서 읽는다).
 * 그래서 도구가 늘어도 이 문장은 틀리지 않는다. 표에 없는 앱은 서버 문구로 돌아간다.
 */
const OFFICIAL_APP_SUBTITLE: Readonly<Record<string, string>> = {
  "com.momo.plugins.github": "코드 저장소와 이슈",
  "com.momo.plugins.notion": "문서와 페이지",
  "com.momo.plugins.linear": "이슈와 작업 추적",
  "com.momo.plugins.drive": "공유 드라이브의 파일",
};

export function pluginSubtitle(plugin: { pluginId: string; description: string }): string {
  return OFFICIAL_APP_SUBTITLE[plugin.pluginId.toLowerCase()] ?? plugin.description;
}

/**
 * 목록을 걸러 보는 컨트롤(검색, 보기)이 서는 최소 개수. 공식 네 앱은 한눈에 읽혀서 걸러 볼
 * 것이 없고, 컨트롤이 있으면 오히려 이 목록이 더 큰 마켓인 것처럼 말한다. 한 화면에 선 채
 * 읽히는 개수(여섯 줄)를 넘으면 컨트롤이 돌아온다(커뮤니티 앱이 들어오는 날).
 */
export const PLUGIN_CONTROLS_MAX_GLANCEABLE = 6;

export function pluginControlsVisible(catalogSize: number): boolean {
  return catalogSize > PLUGIN_CONTROLS_MAX_GLANCEABLE;
}

/** 서버가 허용한 라이선스 표기(`ALLOWED_SPDX`) 가운데 SPDX가 아닌 하나는 읽을 수 있는 이름으로 보인다. */
const LICENSE_LABEL: Readonly<Record<string, string>> = {
  "LicenseRef-Linear-Hosted-Service": "Linear 호스팅 서비스 약관",
};

export function pluginLicenseLabel(spdx: string): string {
  return LICENSE_LABEL[spdx] ?? spdx;
}

/** 이 워크스페이스에서의 설치 상태. 사람의 권한(`myGrantSentence`)과 따로 말한다. */
export function workspaceInstallSentence({
  installed,
  enabled,
}: {
  installed: boolean;
  enabled: boolean;
}): string {
  if (!installed) return "설치하지 않았어요";
  // 목록 칩(「워크스페이스 비활성」)과 같은 말이고, 설치가 열리면 돌아오는 「다시 활성화」 단추와도 짝이다.
  return enabled ? "설치돼 있어요" : "설치했지만 비활성이에요";
}

/**
 * 내가 허용한 권한. 서버의 실효 정책(`toolPolicy`)이 말하는 것만 옮긴다. 설치가 아니라 정책에서
 * 읽으므로 설치돼 있어도 비어 있을 수 있다.
 *
 * **비활성인 설치는 따로 말한다.** 서버의 정책 질의는 grant를 설치가 켜져 있을 때만 센다
 * (`POLICY_SQL`: `wpi.enabled AND wpi.revoked_at IS NULL`). 그래서 꺼진 앱에서 비어 있는 정책은
 * 「허용한 적 없다」가 아니라 「지금 적용되는 것이 없다」다. 앞의 말은 이 화면이 모르는 사실이다.
 * 괄호 안은 「허용한 도구」로 쓴다: 「할 수 있는 일」 위의 「이 앱의 도구는 N개」(선언된 수)와
 * 같은 낱말이 다른 수를 가리키면 둘이 어긋나는 날 한쪽이 거짓으로 읽힌다.
 */
export function myGrantSentence(
  activeScopes: readonly string[],
  toolCount: number,
  plugin: { installed: boolean; enabled: boolean } = { installed: true, enabled: true }
): string {
  if (activeScopes.length === 0 && toolCount === 0) {
    return plugin.installed && !plugin.enabled
      ? "비활성인 동안은 적용되는 권한이 없어요"
      : "허용한 권한이 없어요";
  }
  if (activeScopes.length === 0) return `허용한 도구 ${toolCount}개`;
  return `${activeScopes.map(identifiableScopeSentence).join(", ")} (허용한 도구 ${toolCount}개)`;
}

/** 매니페스트의 도구를 한 줄로: 몇 개이고 어떤 종류인가. 도구가 없으면 줄 자체가 없다. */
export function pluginToolsSummary(tools: readonly { risk?: string }[]): string | null {
  if (tools.length === 0) return null;
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = riskLabel(tool.risk ?? "");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 1 && counts.has(riskLabel("read"))) {
    return `이 앱의 도구는 ${tools.length}개이고, 모두 읽기 도구예요.`;
  }
  const parts = [...counts].map(([label, count]) => `${label} ${count}개`);
  return `이 앱의 도구는 ${tools.length}개예요: ${parts.join(", ")}.`;
}

export const PLUGIN_READONLY_COPY = {
  tools: {
    heading: "할 수 있는 일",
    none: "서버가 표시할 도구 정보를 보내지 않았어요.",
    // 허용의 방향은 사람이 앱에 맡기는 쪽이다(설치가 열리면 돌아오는 「내 사용 허용」·「내 권한 회수」 단추와 같다).
    // 「내게 허용됨」은 거꾸로 읽혀서 쓰지 않는다.
    allowed: "내가 허용함",
  },
  egress: {
    heading: "연결하는 곳",
    // 괄호 바로 뒤에 조사를 두지 않는다: `)` 뒤는 keep-all에서도 줄바꿈이 허용돼 900px에서 「이」가
    // 줄 머리에 홀로 남았다(독립 design-review #3860 M1). 조사 고아는 `latin_particle`이 못 잡는다.
    lead: "이 앱을 쓰면 아래 주소로 요청이 나가요. 에이전트가 도구에 넘긴 검색어 같은 내용은 그 요청에 담기고, 돌아온 내용은 에이전트가 읽어요.",
    none: "이 앱이 연결하는 주소를 서버가 알려 주지 않았어요.",
  },
  publisher: {
    // 이용약관·개인정보 링크는 매니페스트가 줄 때만 선다. 네 앱 모두 주지 않는 오늘 「약관」을 제목에 두면 거짓이다.
    heading: "배포자 정보",
  },
  status: {
    workspace: "이 워크스페이스",
    mine: "내 권한",
  },
  empty: {
    headline: "보여 줄 앱이 아직 없어요.",
    noneRegistered: "서버에 등록된 공식 앱이 생기면 여기에 나타나요.",
    filtered: "검색어나 보기를 바꿔 다른 앱을 확인하세요.",
  },
} as const;
