import { useCallback } from "react";
import {
  AI_HUB_ACCOUNTS_COPY as COPY,
  AI_HUB_COPY,
  AI_HUB_DESKTOP_APP,
  HARNESS_LABEL,
  aiHubSection,
  glossaryEntry,
  subscriptionAgentStatus,
  subscriptionAgentText,
  type AiHarness,
  type MySubscriptionAgent,
} from "@momo/core/features/ai/aiHubModel";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import { Button } from "@/design/ui/button";
import { AiFoot, AiLogo, AiPill, AiSection, AiSectionHead, AiSource } from "@/features/settings/aiAccountsParts";
import {
  AiMyAccountsSection,
  type AccountAgentLine,
  type AccountAgentLineFor,
} from "@/features/settings/AiMyAccountsSection";
import { readProbeFixture } from "@/features/settings/aiMyAccountsModel";
import { Skeleton } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { useMySubscriptionAgents, type MySubscriptionAgentsRead } from "./useMySubscriptionAgents";

const HARNESS_OF: Record<LocalHarnessId, AiHarness> = { claude: "claude_code", codex: "codex" };
const MARK: Record<AiHarness, string> = { claude_code: "C", codex: "X" };

/** 한 구독 줄의 에이전트 한 줄. 서버 값을 못 읽었으면 줄을 만들지 않는다(없다고 말하지 않는다). */
function accountAgentLine(harness: AiHarness, read: MySubscriptionAgentsRead): AccountAgentLine | null {
  if (read.state !== "ok") return null;
  const agent = read.agents.find((a) => a.harness === harness) ?? null;
  const status = subscriptionAgentStatus(harness, agent !== null);
  return {
    text: subscriptionAgentText(agent?.name),
    chip: status.chip ? { text: status.chip.text, tone: status.chip.tone === "ok" ? "ok" : "mute" } : null,
    detail: status.detail,
  };
}

function PaneHead({ subtitle }: { subtitle?: string }) {
  const entry = glossaryEntry(aiHubSection("accounts").glossaryId);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="ai-hub-pane-accounts">
      <h2 className="text-display font-bold text-ink">{entry.term}</h2>
      <p className="max-w-2xl break-keep text-body text-ink-muted">{subtitle ?? entry.meaning}</p>
    </div>
  );
}

/**
 * 「내 AI 계정」 (AIH-4, #3399). 데스크탑은 이 맥의 구독 줄에 로그인 상태와 연결된 에이전트를
 * 함께 그린다(로그인·다시 로그인·연결 해제는 #2816/#2878 부품 그대로). 웹은 로그인할 수
 * 없지만 막다른 길이 아니다: 데스크탑 앱으로 가는 길과 서버에 있는 내 에이전트를 보여준다.
 */
export function AiAccountsPane() {
  const desktop = IS_TAURI || readProbeFixture() !== null;
  return desktop ? <DesktopAccounts /> : <WebAccounts />;
}

function DesktopAccounts() {
  const read = useMySubscriptionAgents();
  const agentLineFor = useCallback<AccountAgentLineFor>(
    (harness) => accountAgentLine(HARNESS_OF[harness], read),
    [read]
  );
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="ai-accounts-desktop">
      <PaneHead subtitle={COPY.desktopSubtitle} />
      <AiMyAccountsSection
        title={COPY.subscriptionHead}
        scope={COPY.subscriptionScope}
        agentLineFor={agentLineFor}
      />
    </div>
  );
}

function WebAccounts() {
  const read = useMySubscriptionAgents();
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="ai-accounts-web">
      <PaneHead subtitle={COPY.webSubtitle} />
      <section
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface-muted p-4"
        aria-label={glossaryEntry("myAiAccount").term}
        data-testid="ai-accounts-web-notice"
      >
        <p className="max-w-2xl break-keep text-body text-ink">{AI_HUB_COPY.webAccountsNotice}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="tap-target">
            <a href={AI_HUB_DESKTOP_APP.downloadUrl} target="_blank" rel="noreferrer" data-testid="ai-accounts-get-app">
              {COPY.web.getApp}
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="tap-target">
            <a href={AI_HUB_DESKTOP_APP.openUrl} data-testid="ai-accounts-open-app">
              {COPY.web.openApp}
            </a>
          </Button>
        </div>
      </section>
      <MyAgentsList read={read} />
      <AiFoot>{COPY.web.apiKeyNote}</AiFoot>
    </div>
  );
}

function MyAgentsList({ read }: { read: MySubscriptionAgentsRead }) {
  return (
    <AiSection labelledBy="ai-accounts-my-agents" testId="ai-accounts-my-agents">
      <AiSectionHead id="ai-accounts-my-agents" title={COPY.web.myAgentsHead} scope={COPY.web.myAgentsScope} />
      {read.state === "loading" ? (
        <Skeleton ready={false} rows={1} className="py-3" />
      ) : read.state === "error" ? (
        <p className="py-3 text-body text-ink-muted" data-testid="ai-accounts-my-agents-error">
          {COPY.web.myAgentsFailed}
        </p>
      ) : read.agents.length === 0 ? (
        <p className="py-3 text-body text-ink-muted" data-testid="ai-accounts-my-agents-empty">
          {COPY.web.myAgentsEmpty}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {read.agents.map((agent) => (
            <MyAgentRow key={agent.agentId} agent={agent} />
          ))}
        </ul>
      )}
    </AiSection>
  );
}

function MyAgentRow({ agent }: { agent: MySubscriptionAgent }) {
  const status = subscriptionAgentStatus(agent.harness, true);
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-2 py-3"
      data-testid={`ai-accounts-agent-${agent.harness}`}
    >
      <AiLogo mark={MARK[agent.harness]} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="break-keep text-body font-semibold text-ink [overflow-wrap:anywhere]">@{agent.name}</span>
        <span className="text-meta text-ink-muted">
          <AiSource>구독</AiSource>
          {HARNESS_LABEL[agent.harness]}
        </span>
        {status.detail && (
          <span className="break-keep pt-1 text-meta text-ink-muted" data-testid={`ai-accounts-agent-${agent.harness}-detail`}>
            {status.detail}
          </span>
        )}
      </div>
      {status.chip && (
        <span data-testid={`ai-accounts-agent-${agent.harness}-chip`}>
          <AiPill tone={status.chip.tone === "ok" ? "ok" : "mute"}>{status.chip.text}</AiPill>
        </span>
      )}
    </li>
  );
}
