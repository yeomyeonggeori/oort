import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_USAGE_COPY as COPY, agentUsageKey, agentUsageLine, fetchAgentUsage,
  hiddenUsageLabel, saveSubscriptionFee, subscriptionAmount, usageForAgent, usageLine,
  type AgentUsage,
} from "@momo/core/features/settings/agentUsage";
import { useSession } from "@/app/session";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import type { components } from "@/lib/usage.generated";
import { SettingsSection } from "./shell/SettingsSection";

type UsageResponse = components["schemas"]["AgentUsageResponse"];

function useAgentUsage(workspaceId: string) {
  return useQuery<UsageResponse>({
    queryKey: agentUsageKey(workspaceId), queryFn: () => fetchAgentUsage(workspaceId),
    staleTime: 30_000, retry: false,
  });
}

/**
 * 에이전트 한 명의 이번 달 비용 한 줄.
 *
 * **가장자리 여백을 이 부품에 넣지 않는다.** 허브 표의 칸·허브 상세·프로필 대화가 함께 쓰는데, 앞의 둘은 칸이 제
 * 여백을 주므로 부품이 또 주면 이중 인셋이 된다. 자기 여백이 없는 자리(프로필 대화의 틀)가 `className` 으로 준다
 * (`InlineBanner`·`EmptyInvite` 의 `className` 과 같은 「자리 조정용」). 줄이 `null` 일 때(사용량 행이 없는 에이전트)
 * 아무것도 그려지지 않으므로, 줄 자신이 여백을 지면 빈 띠가 남지 않는다.
 */
export function AgentUsageLine({ agentId, className }: { agentId: string; className?: string }) {
  const { workspaceId } = useSession();
  const query = useAgentUsage(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const row = query.data && usageForAgent(query.data, agentId);
  if (query.data && !row) return null;
  return (
    <span className={cn("block whitespace-normal break-words text-meta text-ink-muted", className)} data-testid="agent-month-usage" data-numeric>
      {COPY.title}: {query.fetchStatus === "paused" ? COPY.offline : query.isError ? COPY.error : query.isPending ? COPY.loading : row ? agentUsageLine(row, memberFor(directory, agentId)?.brain) : COPY.unavailable}
    </span>
  );
}

/** Count only, independent of the roster's identities and never a derived cost. */
export function HiddenAgentUsage({ workspaceId }: { workspaceId: string }) {
  const query = useAgentUsage(workspaceId);
  const label = query.data && hiddenUsageLabel(query.data.hiddenPersonalAgents);
  const message = query.fetchStatus === "paused" ? COPY.offline : query.isError ? COPY.error : query.isPending ? COPY.loading : label;
  return message ? <div className="flex flex-wrap items-center gap-2 px-4 py-2">
    <p className="text-meta text-ink-muted" role="status" data-numeric>{message}</p>
    {query.isError && <Button variant="secondary" onClick={() => void query.refetch()}>다시 불러오기</Button>}
  </div> : null;
}

function SubscriptionEditor({ workspaceId, row }: { workspaceId: string; row: AgentUsage }) {
  const client = useQueryClient();
  const inputId = useId();
  const [value, setValue] = useState(row.subscriptionFee ? String(row.subscriptionFee.monthlyMicroUsd / 1_000_000) : "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async event => {
      event.preventDefault();
      if (saving) return;
      setMessage(""); setFailed(false);
      let amount: number | null;
      try { amount = subscriptionAmount(value); }
      catch (error) { setFailed(true); setMessage((error as Error).message); return; }
      setSaving(true);
      try {
        const saved = await saveSubscriptionFee(workspaceId, row.agentMemberId, amount);
        // Apply the response, including an explicit clear, before re-reading permission facts.
        client.setQueryData<Awaited<ReturnType<typeof fetchAgentUsage>>>(agentUsageKey(workspaceId), current => current ? {
          ...current, agents: current.agents.map(agent => {
            if (agent.agentMemberId.toLowerCase() !== saved.agentMemberId.toLowerCase()) return agent;
            const { subscriptionFee: _old, ...rest } = agent;
            return saved.subscriptionFee ? { ...rest, subscriptionFee: saved.subscriptionFee } : rest;
          }),
        } : current);
        setMessage(COPY.saved);
        void client.invalidateQueries({ queryKey: agentUsageKey(workspaceId) });
      } catch { setFailed(true); setMessage(COPY.saveError); }
      finally { setSaving(false); }
    }}>
      <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted" htmlFor={inputId}>
        {COPY.subscription}
        <Input id={inputId} inputMode="decimal" value={value} disabled={saving} onChange={event => setValue(event.target.value)} />
      </label>
      <Button type="submit" variant="secondary" disabled={saving}>{saving ? "저장하고 있어요" : "저장"}</Button>
      <span className="text-meta text-ink-muted">비워서 저장하면 정액을 지워요.</span>
      <p className={failed ? "w-full text-meta text-danger" : "w-full text-meta text-ink-muted"} role={failed ? "alert" : "status"}>{message}</p>
    </form>
  );
}

export function AgentMonthlyReport({ workspaceId }: { workspaceId: string }) {
  const query = useAgentUsage(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const data = query.data;
  const unavailable = query.isError || query.fetchStatus === "paused";
  return (
    <SettingsSection title={COPY.report} description={COPY.note} testId="agent-monthly-report">
      <div className="flex flex-col gap-3 p-4" aria-busy={query.isFetching}>
        <Button variant="secondary" disabled={query.isFetching || query.fetchStatus === "paused"} onClick={() => void query.refetch()}>다시 불러오기</Button>
        {unavailable ? <p role="status" className="text-meta text-ink-muted">{query.fetchStatus === "paused" ? COPY.offline : COPY.error}</p>
          : query.isPending ? <p role="status">{COPY.loading}</p> : data ? <>
            <p className="text-meta text-ink-muted">{data.range.from.slice(0, 10)} ~ {data.range.to.slice(0, 10)} (UTC)</p>
            {data.totals.workspace ? <p data-numeric>워크스페이스 전체 · {usageLine(data.totals.workspace)}</p> : <>
              <p data-numeric>내 에이전트 · {usageLine(data.totals.mine)}</p>
              <p data-numeric>공유 에이전트 · {usageLine(data.totals.shared)}</p>
            </>}
            {data.agents.length === 0 && <p>{COPY.empty}</p>}
            <ul className="divide-y divide-line">
              {data.agents.map(row => {
                const member = memberFor(directory, row.agentMemberId);
                // Ownership comes from the roster; absent facts never grant a write.
                const editable = data.totals.workspace !== undefined && member?.callableBy === "everyone";
                return <li className="min-w-0 py-3" key={row.agentMemberId}>
                  <p className="break-words font-medium">{member?.displayName ?? "에이전트"}{member?.handle ? ` (@${member.handle})` : ""}</p>
                  <p className="break-words text-meta text-ink-muted" data-numeric>{agentUsageLine(row, member?.brain)}</p>
                  {editable && <SubscriptionEditor key={row.agentMemberId} workspaceId={workspaceId} row={row} />}
                </li>;
              })}
            </ul>
            {hiddenUsageLabel(data.hiddenPersonalAgents) && <p className="text-meta text-ink-muted" data-numeric>{hiddenUsageLabel(data.hiddenPersonalAgents)}</p>}
          </> : null}
      </div>
    </SettingsSection>
  );
}
