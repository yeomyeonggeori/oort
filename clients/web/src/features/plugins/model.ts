import { ApiError, type MembershipRole } from "@/lib/api";
import { NetworkError } from "@/lib/http";

export type PluginAction =
  | { kind: "install"; pluginId: string; pluginName: string }
  | { kind: "uninstall"; pluginId: string; pluginName: string }
  | { kind: "grant"; pluginId: string; pluginName: string; scope: string }
  | { kind: "revokeGrant"; pluginId: string; pluginName: string; scope: string };

export type PluginRoleState = "checking" | "known" | "unknown";

/**
 * The marketplace CSS owns the responsive boundary. JavaScript reads this
 * custom property from the rendered layout instead of carrying a second
 * viewport breakpoint that can drift from the grid.
 */
export const pluginMarketplaceColumnProperty = "--plugin-marketplace-columns";

/** A selected detail needs a viewport handoff only while CSS renders one column. */
export function pluginMarketplaceNeedsDetailFocus(columnCount: string | null): boolean {
  return columnCount?.trim() !== "2";
}

/**
 * A write in progress is observable, not unavailable. Keeping the button
 * enabled preserves the focused element through both success and failure;
 * callers reject duplicate clicks while this state is true.
 */
export function pluginActionButtonState({
  busy,
  offline,
}: {
  busy: boolean;
  offline: boolean;
}): { disabled: boolean; ariaBusy: true | undefined } {
  return { disabled: offline, ariaBusy: busy || undefined };
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

/** Swift marketplace's `github:read` → `github 읽기 권한` rule, unchanged. */
export function scopeSentence(scope: string): string {
  const [resource, action] = scope.split(":", 2);
  if (!resource || !action) return "사용 권한 1개";
  const name = resource.replaceAll("_", " ");
  if (action === "read") return `${name} 읽기 권한`;
  if (action === "write") return `${name} 쓰기 권한`;
  return `${name} 사용 권한`;
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
  kind: "uninstall" | "revokeGrant";
}>): { title: string; description: string; confirmLabel: string } {
  if (action.kind === "uninstall") {
    return {
      title: `${action.pluginName} 설치를 해제할까요?`,
      description: `${action.pluginName} 앱의 모든 멤버 권한이 함께 회수됩니다.`,
      confirmLabel: "설치 해제",
    };
  }
  return {
    title: `${action.pluginName} 권한을 회수할까요?`,
    description: `${action.pluginName}의 ${scopeSentence(action.scope)}을 회수하면 이 권한으로 사용할 수 있던 도구가 즉시 사라집니다.`,
    confirmLabel: "내 권한 회수",
  };
}
