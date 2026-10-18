import type { PluginCatalogItem, PluginDetail, PluginManifestTool, PluginPolicyTool } from "../../lib/api";
import { pluginConnectionLabel, pluginConnectionState } from "./connectionState";

// =============================================================================
// 폰 「앱」 읽기 화면의 모델 (U-4 #3951, ADR-0113 증보 2 E4, ADR-0188 D5).
//
// 폰에는 동의 창이 없다(plans 2.6, v1.1 후보). 설치·허용·회수는 데스크탑이나 웹에서 하고,
// 폰은 **읽기와 승인**만 한다. 이 모듈은 그 읽기 화면이 말하는 문장과 판정을 한 곳에 둔다.
// UI 도 플랫폼 API 도 없는 순수 함수다.
//
// ## 웹 모델과의 관계
//
// 웹 `clients/web/src/features/plugins/model.ts`가 같은 사실을 말하는 문장을 갖고 있고, 폰은
// 웹 코드를 가져올 수 없다. 문장을 폰 쪽에 새로 짓지 않고 **같은 글자를 이 파일에 둔다.** 둘이
// 갈라지지 않게 웹 쪽 시험(`phoneAppsParity.test.ts`)이 두 모델의 답을 같은 입력으로 맞춰 본다.
// 그 시험이 실패하면 어느 한쪽의 문장이 바뀐 것이고, 고칠 곳은 두 파일이다.
//
// ## 폰이 하지 않는 것
//
// 설치·권한 변경·「항상 허용」은 이 모델에 없다. 쓰기 승인은 승인 카드가 맡는다(ADR-0188 D5).
// =============================================================================

/** 폰의 막힘 문장 — 앱 알림(`appNoticeFor` 의 `not_allowed`, 폰)과 같은 글자다. 시험이 맞춘다. */
export const PHONE_APP_BLOCKED_SENTENCE = "이 앱은 데스크탑이나 웹에서 허용해 주세요.";
/** 막힘 문장 옆의 행동 하나. */
export const PHONE_APP_WEB_ACTION = "웹에서 열기";

/**
 * 폰의 「웹에서 열기」 가 가는 웹 화면: 설정 section id 로 잇는다(경로가 아니다, plans 2.7).
 * `plugins` 는 `settings.open` 의 열두 section 중 하나이고, 웹이 이 id 를 AI 허브 › 외부 연결 ›
 * 앱 화면으로 풀어 준다(`resolveSettingsSection`). 경로(`/ai/external/apps`)를 폰이 외우면 웹이
 * 화면을 옮기는 날 폰의 링크만 낡는다.
 */
export const APPS_SETTINGS_SECTION = "plugins" as const;

export function appsOnWebPath(): string {
  return `/settings?section=${APPS_SETTINGS_SECTION}`;
}

export const PHONE_APPS_COPY = {
  title: "앱",
  subtitle: "공식 앱이 할 수 있는 일",
  lead: "공식 앱이 할 수 있는 일과 내가 허용한 권한을 확인해요.",
  readonlyNote: "폰에서는 보기와 승인만 해요. 설치와 허용은 데스크탑이나 웹에서 해요.",
  // 쓰기는 승인 카드로 묻는다. 「항상 허용」은 v1에 없다(티켓 #3951, ADR-0188 D5). 승인 범위
  // (이번 한 번 · 이 세션 동안)는 카드가 말한다: 여기서 하나만 있다고 단정하지 않는다.
  writeNote: "쓰기 도구는 승인 카드로 물어보고, 「항상 허용」은 없어요.",
  loading: "앱을 불러오는 중이에요.",
  emptyHeadline: "보여 줄 앱이 아직 없어요.",
  emptyDetail: "서버에 등록된 공식 앱이 생기면 여기에 나타나요.",
  errorHeadline: "앱 목록을 불러오지 못했어요.",
  errorDetail: "잠시 뒤에 다시 시도해 주세요.",
  offline: "오프라인이에요. 마지막으로 불러온 앱을 보여 드려요.",
  detailLoading: "앱 정보를 불러오는 중이에요.",
  detailErrorHeadline: "앱 정보를 읽지 못했어요.",
  detailErrorDetail: "잠시 뒤에 다시 시도해 주세요.",
  policyUnknown: "내 권한은 지금 확인하지 못했어요. 잠시 뒤에 다시 열어 주세요.",
  toolsHeading: "할 수 있는 일",
  toolsNone: "서버가 표시할 도구 정보를 보내지 않았어요.",
  toolAllowed: "내가 허용함",
  egressHeading: "연결하는 곳",
  egressLead:
    "이 앱을 쓰면 아래 주소로 요청이 나가요. 에이전트가 도구에 넘긴 검색어 같은 내용은 그 요청에 담기고, 돌아온 내용은 에이전트가 읽어요.",
  egressNone: "이 앱이 연결하는 주소를 서버가 알려 주지 않았어요.",
  publisherHeading: "배포자 정보",
  statusWorkspace: "이 워크스페이스",
  statusMine: "내 권한",
  official: "공식",
} as const;

// ---- 웹 `model.ts` 와 같은 글자 (parity 시험이 맞춘다) ------------------------------------

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

export function identifiableScopeSentence(scope: string): string {
  const sentence = scopeSentence(scope);
  return sentence === "사용 권한" ? `${sentence} (${scope})` : sentence;
}

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

const OFFICIAL_APP_SUBTITLE: Readonly<Record<string, string>> = {
  "com.momo.plugins.github": "코드 저장소와 이슈",
  "com.momo.plugins.notion": "문서와 페이지",
  "com.momo.plugins.linear": "이슈와 작업 추적",
  "com.momo.plugins.drive": "공유 드라이브의 파일",
};

export function pluginSubtitle(plugin: { pluginId: string; description: string }): string {
  return OFFICIAL_APP_SUBTITLE[plugin.pluginId.toLowerCase()] ?? plugin.description;
}

export function workspaceInstallSentence(plugin: { installed: boolean; enabled: boolean }): string {
  if (!plugin.installed) return "설치하지 않았어요";
  return plugin.enabled ? "설치돼 있어요" : "설치했지만 비활성이에요";
}

export function myGrantSentence(
  activeScopes: readonly string[],
  toolCount: number,
  plugin: { installed: boolean; enabled: boolean } = { installed: true, enabled: true },
): string {
  if (activeScopes.length === 0 && toolCount === 0) {
    return plugin.installed && !plugin.enabled
      ? "비활성인 동안은 적용되는 권한이 없어요"
      : "허용한 권한이 없어요";
  }
  if (activeScopes.length === 0) return `허용한 도구 ${toolCount}개`;
  return `${activeScopes.map(identifiableScopeSentence).join(", ")} (허용한 도구 ${toolCount}개)`;
}

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

export function pluginLicenseLabel(spdx: string): string {
  const named: Readonly<Record<string, string>> = {
    "LicenseRef-Linear-Hosted-Service": "Linear 호스팅 서비스 약관",
  };
  return named[spdx] ?? spdx;
}

function activeScopesOf(
  tools: readonly PluginManifestTool[],
  policyTools: readonly PluginPolicyTool[],
): string[] {
  const active = new Set(policyTools.map((tool) => tool.name));
  const declared = [...new Set(tools.flatMap((tool) => tool.scopes))];
  return declared.filter((scope) =>
    tools.some((tool) => active.has(tool.name) && tool.scopes.includes(scope)),
  );
}

// ---- 폰 목록 줄 ------------------------------------------------------------------------

export type PhoneAppTone = "neutral" | "ok" | "muted";

export interface PhoneAppRow {
  pluginId: string;
  name: string;
  iconText: string;
  subtitle: string;
  official: boolean;
  /** 네 칸 중 1·2·허용함 (`pluginConnectionLabel`). 웹 목록 줄과 같은 읽기. */
  chipLabel: string;
  tone: PhoneAppTone;
  /** 이 사람이 폰에서 이 앱으로 할 수 있는 일이 없다 → 막힘 문장과 「웹에서 열기」가 선다. */
  blocked: boolean;
  allowedToolCount: number;
  /** 한 줄 낭독. */
  spoken: string;
}

/** 내가 쓸 수 있는 도구 수가 0이면, 또는 설치가 꺼져 있으면 폰에서는 막힘이다. */
export function isPhoneAppBlocked(input: {
  installed: boolean;
  enabled: boolean;
  allowedToolCount: number;
}): boolean {
  return pluginConnectionState(input) !== "allowed";
}

export function phoneAppRow(
  plugin: PluginCatalogItem,
  policyTools: readonly PluginPolicyTool[] | undefined,
): PhoneAppRow {
  const allowedToolCount = policyTools?.length ?? 0;
  const input = { installed: plugin.installed, enabled: plugin.enabled, allowedToolCount };
  const state = pluginConnectionState(input);
  const chipLabel = pluginConnectionLabel(input);
  const subtitle = pluginSubtitle(plugin);
  return {
    pluginId: plugin.pluginId,
    name: plugin.name,
    iconText: pluginIconText(plugin),
    subtitle,
    official: plugin.official,
    chipLabel,
    tone: state === "allowed" ? "ok" : state === "notInstalled" ? "muted" : "neutral",
    blocked: state !== "allowed",
    allowedToolCount,
    spoken: `${plugin.name}, ${subtitle}, ${chipLabel}`,
  };
}

export function phoneAppRows(
  plugins: readonly PluginCatalogItem[],
  toolsByPlugin: ReadonlyMap<string, PluginPolicyTool[]>,
): PhoneAppRow[] {
  return plugins.map((plugin) => phoneAppRow(plugin, toolsByPlugin.get(plugin.pluginId)));
}

// ---- 폰 상세 ---------------------------------------------------------------------------

export interface PhoneAppToolRow {
  name: string;
  /** 사람이 읽는 문장이 먼저. 설명이 없는 도구만 이름이 제목이 된다. */
  title: string;
  /** 설명이 있을 때만 식별자(`github.list_repositories`)가 조용히 따라온다. */
  identifier: string | null;
  scopes: string;
  /** 말할 만한 칩만(읽기 도구·읽기 전용 승인은 위 한 줄 요약이 이미 말한다). */
  chips: { label: string; tone: "muted" | "warn" | "danger" }[];
  allowed: boolean;
}

export interface PhoneAppDetail {
  header: PhoneAppRow;
  version: string;
  statusWorkspace: string;
  statusMine: string;
  blocked: boolean;
  toolsSummary: string | null;
  /** 읽기 아닌 도구가 있다 → 「쓰기 도구는 승인 카드로 물어봐요」 한 줄이 선다. 모두 읽기면 말할 일이 없다. */
  hasWriteTools: boolean;
  tools: PhoneAppToolRow[];
  egressDomains: string[];
  publisher: { label: string; value: string }[];
}

function toolChips(tool: PluginManifestTool): PhoneAppToolRow["chips"] {
  const chips: PhoneAppToolRow["chips"] = [];
  const approval = tool.approvalTier === "read_only" ? null : approvalLabel(tool.approvalTier);
  if (approval) {
    chips.push({
      label: `승인: ${approval}`,
      tone: tool.approvalTier === "network_write" ? "danger" : "warn",
    });
  }
  if (tool.risk && tool.risk !== "read") {
    chips.push({
      label: `위험도: ${riskLabel(tool.risk)}`,
      tone: tool.risk === "admin" ? "danger" : "warn",
    });
  }
  return chips;
}

export function phoneAppDetail(
  detail: PluginDetail,
  policyTools: readonly PluginPolicyTool[] | undefined,
): PhoneAppDetail {
  const policy = policyTools ?? [];
  const allowedNames = new Set(policy.map((tool) => tool.name));
  const activeScopes = activeScopesOf(detail.tools, policy);
  const header = phoneAppRow({ ...detail, recommended: false }, policy);
  const publisher: { label: string; value: string }[] = [];
  if (detail.publisherName) {
    publisher.push({
      label: "배포자",
      value: detail.publisherVerified
        ? `${detail.publisherName}, oort 레지스트리가 확인했어요`
        : detail.publisherName,
    });
  }
  if (detail.license) publisher.push({ label: "라이선스", value: pluginLicenseLabel(detail.license) });
  return {
    header,
    version: detail.version,
    statusWorkspace: workspaceInstallSentence(detail),
    statusMine: myGrantSentence(activeScopes, policy.length, detail),
    blocked: header.blocked,
    toolsSummary: pluginToolsSummary(detail.tools),
    hasWriteTools: detail.tools.some((tool) => tool.risk !== "read"),
    tools: detail.tools.map((tool) => ({
      name: tool.name,
      title: tool.description ?? tool.name,
      identifier: tool.description ? tool.name : null,
      scopes: tool.scopes.map(identifiableScopeSentence).join(", "),
      chips: toolChips(tool),
      allowed: allowedNames.has(tool.name),
    })),
    egressDomains: detail.egressDomains,
    publisher,
  };
}
