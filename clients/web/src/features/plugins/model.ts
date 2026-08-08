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
        error: `선택한 권한을 변경하지 못했습니다. 원인: ${causes[0]} 영향받은 권한: ${affectedBy(causes[0])}`,
        causes: [],
      };
    }
    return {
      dismissDialog: false,
      error: `선택한 권한을 변경하지 못했습니다. 원인 ${causes.length}가지를 확인하세요.`,
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
    return `선택한 ${completed.length}개 권한을 ${verb}했습니다: ${completedNames}`;
  }
  if (completed.length === 0) {
    return `선택한 권한을 ${verb}하지 못했습니다. 현재 권한을 다시 확인하세요.`;
  }
  return `${completed.length}개 권한을 ${verb}했습니다: ${completedNames}. ${failed.length}개는 변경하지 못했습니다: ${failed.map((outcome) => scopeSentence(outcome.scope)).join(", ")}`;
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

export function callerPolicySummary(
  tools: readonly { risk: string }[] | undefined
): string {
  if (!tools?.length) return "내 권한 도구: 없음";
  const risks = [...new Set(tools.map((tool) => riskLabel(tool.risk)))];
  return `내 권한 도구 위험도: ${risks.join(", ")}`;
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
  return `앱 설치는 워크스페이스 관리자만 할 수 있습니다. ${next}`;
}

export function pluginActionErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return "앱이 선언하지 않은 권한은 변경할 수 없습니다. 앱 정보를 다시 불러온 뒤 다시 시도하세요.";
      case 403:
        return "이 앱은 워크스페이스 정책이나 내 역할상 변경할 수 없습니다. 관리자에게 정책과 권한을 확인하세요.";
      case 404:
        return "앱 또는 내 권한을 찾지 못했습니다. 앱 목록을 다시 불러온 뒤 다시 시도하세요.";
      case 409:
        return "이 앱이 설치되어 활성화된 상태가 아닙니다. 앱 목록을 다시 불러온 뒤 다시 시도하세요.";
      default:
        return "앱 변경을 완료하지 못했습니다. 잠시 뒤에 다시 시도하세요.";
    }
  }
  return "앱 변경을 완료하지 못했습니다. 잠시 뒤에 다시 시도하세요.";
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
      return "이 앱의 상세 정보를 볼 권한이 없습니다. 워크스페이스 관리자에게 권한을 확인하세요.";
    }
    if (error.status === 404) {
      return "이 앱을 찾지 못했습니다. 앱 목록을 다시 불러온 뒤 다시 선택하세요.";
    }
  }
  return "앱 상세 정보를 읽지 못했습니다. 잠시 뒤에 다시 시도하세요.";
}

export function pluginActionConfirmation(action: Extract<PluginAction, {
  kind: "uninstall";
}>): { title: string; description: string; confirmLabel: string } {
  return {
    title: `${action.pluginName} 설치를 해제할까요?`,
    description: `${action.pluginName} 앱의 모든 멤버 권한이 함께 회수됩니다.`,
    confirmLabel: "설치 해제",
  };
}
