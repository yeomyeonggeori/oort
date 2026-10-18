import { useId } from "react";
import { cn } from "@/design/lib/cn";
import { StatusChip } from "@/features/settings/SettingsFields";
import { serverSurface } from "@momo/core/features/capabilities/serverSurfaces";
import type { PluginManifestTool } from "@momo/core/lib/api";
import {
  PLUGIN_READONLY_COPY as COPY,
  approvalLabel,
  identifiableScopeSentence,
  myGrantSentence,
  pluginIconText,
  pluginToolsSummary,
  riskLabel,
  workspaceInstallSentence,
} from "./model";

// =============================================================================
// 「앱」 상세가 말하는 **사실 블록들** (#3860, ADR-0113 증보 P-U1).
//
// 이 파일의 블록은 설치가 열려 있든 닫혀 있든 같은 말을 한다: 앱이 무엇이고, 어디와
// 통신하고, 내 권한이 어떻고, 어떤 도구가 있는가. 그래서 읽기 전용 화면이 이 블록만으로
// 서고, 설치 화면이 열리는 날에는 그 위에 버튼 줄(`PluginActions`)이 얹힌다. 버튼을 위해
// 이 블록의 문장을 바꿔야 한다면 문장이 설치 가능 여부를 안고 있다는 뜻이고 그것이 버그다.
//
// 설치·권한 쓰기 흐름(버튼, 동의·해제 다이얼로그, 뮤테이션)은 `PluginSection.tsx`에 그대로
// 남는다. 그쪽으로 가는 문은 `useInstallAvailability`가 하나다.
// =============================================================================

/** 앱 타일. 서버가 글자를 주면 그것을, 아니면 이름의 머리글자를 쓴다(브랜드 이미지는 쓰지 않는다). */
export function PluginIcon({
  plugin,
  className,
}: {
  plugin: { name: string; iconText?: string };
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-control shrink-0 items-center justify-center rounded-sm border border-line bg-surface text-body font-semibold text-ink",
        className
      )}
      aria-hidden="true"
    >
      {pluginIconText(plugin)}
    </span>
  );
}

function StatusRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-px" data-testid={testId}>
      <dt className="text-meta text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-body text-ink">{value}</dd>
    </div>
  );
}

/**
 * 이 워크스페이스의 설치 상태와 내 권한. 둘을 한 곳에 따로 말한다: 설치는 워크스페이스의
 * 사실이고 권한은 사람의 사실이며, 하나가 다른 하나를 뜻하지 않는다(설치돼 있어도 내가
 * 허용한 것은 없을 수 있다).
 */
export function PluginStatusRows({
  plugin,
  activeScopes,
  toolCount,
}: {
  plugin: { installed: boolean; enabled: boolean };
  activeScopes: readonly string[];
  toolCount: number;
}) {
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="plugin-status">
      <StatusRow
        label={COPY.status.workspace}
        value={workspaceInstallSentence(plugin)}
        testId="plugin-status-workspace"
      />
      <StatusRow
        label={COPY.status.mine}
        value={myGrantSentence(activeScopes, toolCount, plugin)}
        testId="plugin-status-mine"
      />
    </dl>
  );
}

/**
 * 설치가 아직 열리지 않았을 때의 차분한 한 줄. 오류가 아니다(`role="alert"`도 위험 색도
 * 쓰지 않는다): 아직 만들지 않은 기능은 잘못된 것이 아니다. 문장은 이 표면의 판정표가
 * 갖고 있고(`serverSurface("pluginInstall")`), 화면이 따로 짓지 않는다.
 *
 * 설치 상태 바로 아래에 선다: 이 줄은 「왜 설치 버튼이 없는가」에 답하는 각주라서 그 상태 곁에
 * 있어야 읽힌다. 설치가 열리면 이 줄이 빠지고 버튼 줄이 헤더에 들어온다.
 */
export function PluginInstallClosedNotice() {
  return (
    <p className="text-meta text-ink-muted" data-testid="plugin-install-closed">
      {serverSurface("pluginInstall").fallback}
    </p>
  );
}

/**
 * 연결하는 곳 (ADR-0113 D5): 이 앱을 쓰면 어느 주소와 통신하는가. 설치 결정 앞에 서야 하는
 * 공개라서 설치가 닫혀 있어도 먼저 보인다. 주소는 서버가 매니페스트에서 준 그대로이고,
 * 문장은 그 주소로 무엇이 오가는지만 말한다(도구에 넘긴 내용이 요청에 담기고, 돌아온 내용을
 * 에이전트가 읽는다). 로그인 정보를 어디에 둔다는 말은 여기서 하지 않는다: 그것은 허용을
 * 결정하는 순간의 문장이라 허용 동의 창이 말한다(`PLUGIN_CONSENT_CUSTODY_LINES`).
 */
export function PluginEgressDisclosure({ domains }: { domains: readonly string[] }) {
  const headingId = useId();
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={headingId}
      data-testid="plugin-egress"
    >
      <h4 id={headingId} className="text-body font-semibold text-ink">
        {COPY.egress.heading}
      </h4>
      {domains.length === 0 ? (
        <p className="text-body text-ink-muted">{COPY.egress.none}</p>
      ) : (
        <>
          <p className="text-body text-ink-muted">{COPY.egress.lead}</p>
          <ul className="flex flex-col gap-1">
            {domains.map((domain) => (
              <li key={domain} className="break-all font-mono text-meta text-ink">
                {domain}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export type ScopeBadge = {
  label: string;
  tone: "muted" | "warn" | "danger";
};

/** 도구들의 승인·위험도 칩. 상세의 도구 줄과 권한 동의 다이얼로그가 같은 말을 쓴다. */
export function scopeRiskAndApprovalBadges(tools: readonly PluginManifestTool[]): ScopeBadge[] {
  const badges = tools.flatMap((tool): ScopeBadge[] => {
    const approval = approvalLabel(tool.approvalTier);
    const result: ScopeBadge[] = [];
    if (approval) {
      result.push({
        label: `승인: ${approval}`,
        tone: tool.approvalTier === "network_write"
          ? "danger"
          : tool.approvalTier === "workspace_write" ? "warn" : "muted",
      });
    }
    if (tool.risk) {
      result.push({
        label: `위험도: ${riskLabel(tool.risk)}`,
        tone: tool.risk === "admin" ? "danger" : tool.risk === "write" ? "warn" : "muted",
      });
    }
    return result;
  });
  return [...new Map(badges.map((badge) => [badge.label, badge])).values()];
}

/**
 * 이 줄에서 말할 만한 칩만 남긴다. 읽기 도구와 읽기 전용 승인은 위의 한 줄 요약(「모두 읽기
 * 도구예요」)이 이미 말하고, 일곱 도구가 똑같은 칩 둘을 달면 높이만 늘고 알려 주는 것이 없다(독립
 * design-review #3860 M7). 쓰기·관리자 도구나 쓰기 승인 단계는 그대로 칩이 된다. 결정 표면(권한
 * 동의 다이얼로그)은 이 규칙을 쓰지 않고 모든 칩을 보인다.
 */
function notableBadges(tool: PluginManifestTool): ScopeBadge[] {
  return scopeRiskAndApprovalBadges([
    {
      ...tool,
      risk: tool.risk === "read" ? undefined : tool.risk,
      approvalTier: tool.approvalTier === "read_only" ? undefined : tool.approvalTier,
    },
  ]);
}

function ToolRow({ tool, allowed }: { tool: PluginManifestTool; allowed: boolean }) {
  const badges = notableBadges(tool);
  return (
    <li className="flex flex-col gap-1 py-3">
      {/* 사람이 읽는 문장이 먼저다. 도구 이름(`github.list_repositories`)은 정책과 감사가 부르는
          식별자라서 아래에 조용히 선다. 설명이 없는 도구만 이름이 제목이 된다. */}
      <span className="text-body font-medium text-ink">{tool.description ?? tool.name}</span>
      <span className="text-meta text-ink-muted">
        {tool.description && (
          <>
            <span className="break-all font-mono">{tool.name}</span>
            <span aria-hidden="true">{" · "}</span>
          </>
        )}
        {tool.scopes.map(identifiableScopeSentence).join(", ")}
      </span>
      {(badges.length > 0 || allowed) && (
        <span className="flex flex-wrap gap-1">
          {badges.map((badge) => (
            <StatusChip key={badge.label} tone={badge.tone}>{badge.label}</StatusChip>
          ))}
          {allowed && <StatusChip tone="ok">{COPY.tools.allowed}</StatusChip>}
        </span>
      )}
    </li>
  );
}

/**
 * 할 수 있는 일: 매니페스트가 선언한 도구. 「내게 허용됨」은 서버의 실효 정책이 이 도구를
 * 싣고 있을 때만 붙는다. 선언된 도구와 허용된 도구는 다른 사실이다.
 */
export function PluginToolList({
  tools,
  allowedToolNames,
}: {
  tools: readonly PluginManifestTool[];
  allowedToolNames: ReadonlySet<string>;
}) {
  const headingId = useId();
  const summary = pluginToolsSummary(tools);
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={headingId}
      data-testid="plugin-tools"
    >
      <h4 id={headingId} className="text-body font-semibold text-ink">
        {COPY.tools.heading}
      </h4>
      {tools.length === 0 ? (
        <p className="text-body text-ink-muted">{COPY.tools.none}</p>
      ) : (
        <>
          {summary && <p className="text-meta text-ink-muted">{summary}</p>}
          {/* 칸막이 상자 안에 또 상자를 두지 않는다: 줄은 선으로 나뉜다. */}
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} allowed={allowedToolNames.has(tool.name)} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
