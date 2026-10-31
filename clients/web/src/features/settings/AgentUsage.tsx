import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_USAGE_COPY as COPY, agentUsageKey, agentUsageLine, fetchAgentUsage,
  hiddenUsageLabel, saveSubscriptionFee, subscriptionAmount, usageForAgent, usageLine,
  type AgentUsage,
} from "@momo/core/features/settings/agentUsage";
import { subscriptionSaveError } from "@momo/core/features/settings/agentUsageErrors";
import { useSession } from "@/app/session";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import type { components } from "@/lib/usage.generated";
import { SettingsSection } from "./shell/SettingsSection";

type UsageResponse = components["schemas"]["AgentUsageResponse"];
// 잠금의 흐림은 잠금과 한 식이 켠다(#1486 문법). 클래스 글자는 상수로 둬서 JSX 식 안의 문자열로 세지 않는다.
const DIM = "opacity-50";

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
 *
 * `compact`(목록·표 안의 줄, #4986): 줄마다 같은 말을 되풀이하지 않는다. ① 열 머리가 이미 「비용」이라 긴 머리말
 * (「이번 달 비용·토큰·작업 수:」) 대신 짧은 기간 말(「이번 달 ·」)만 붙인다. ② 읽는 중·오류·오프라인은 줄이 말하지
 * 않는다: 그 말은 목록 위의 한 줄(`HiddenAgentUsage`)이 한 번 하고 거기에 다시 불러오기가 있다(열한 줄에 같은 오류
 * 문장이 열한 번 서던 것을 걷는다). 낱말은 한 덩어리로 줄바꿈한다(`break-keep`): 좁은 칸에서 「비/용」으로 끊기던 것을 막는다.
 */
export function AgentUsageLine({ agentId, className, compact = false }: { agentId: string; className?: string; compact?: boolean }) {
  const { workspaceId } = useSession();
  const query = useAgentUsage(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const row = query.data && usageForAgent(query.data, agentId);
  if (query.data && !row) return null;
  if (compact && !row) return null;
  return (
    <span className={cn("block whitespace-normal break-keep text-meta text-ink-muted", className)} data-testid="agent-month-usage" data-numeric>
      {compact ? COPY.period + " · " : COPY.title + ": "}{query.fetchStatus === "paused" ? COPY.offline : query.isError ? COPY.error : query.isPending ? COPY.loading : row ? agentUsageLine(row, memberFor(directory, agentId)?.brain) : COPY.unavailable}
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
    <form className="mt-2 flex flex-wrap items-end gap-2" aria-busy={saving || undefined} onSubmit={async event => {
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
      } catch (error) { setFailed(true); setMessage(subscriptionSaveError(error)); }
      finally { setSaving(false); }
    }}>
      <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted" htmlFor={inputId}>
        {COPY.subscription}
        {/* 저장 중에도 입력 칸은 native disabled가 아니라 readOnly다: 값 칸에서 Enter로 저장하면 초점이 이 칸에 있고, 칸이
            disabled가 되는 순간 초점이 body로 떨어졌다(#4986). 진행은 단추의 aria-busy + 바뀐 낱말이 말한다(#1486 문법). */}
        <Input id={inputId} inputMode="decimal" value={value} readOnly={saving} onChange={event => setValue(event.target.value)} />
      </label>
      <Button type="submit" variant="secondary" aria-busy={saving || undefined}>{saving ? "저장하고 있어요" : "저장"}</Button>
      <span className="text-meta text-ink-muted">비워서 저장하면 정액을 지워요.</span>
      <p className={failed ? "w-full text-meta text-danger" : "w-full text-meta text-ink-muted"} role={failed ? "alert" : "status"}>{message}</p>
    </form>
  );
}

export function AgentMonthlyReport({ workspaceId }: { workspaceId: string }) {
  const query = useAgentUsage(workspaceId);
  const roster = useDirectory(workspaceId);
  const { directory } = roster;
  const data = query.data;
  const offline = query.fetchStatus === "paused";
  const unavailable = query.isError || offline;
  // 명단을 못 읽었으면 보고는 남지만 어느 줄이 누구인지 모른다. 옛 명단이 있으면 이름은 아직 아는 것이라 말하지 않는다.
  // (이 문장은 보고가 있는 분기 안에만 선다: 보고가 없으면 이름이 빌 줄도 없다.)
  const rosterMissing = roster.isError && !roster.data;
  return (
    <SettingsSection title={COPY.report} description={COPY.note} testId="agent-monthly-report"
      // 다시 불러오기는 섹션 머리 오른쪽의 라벨 폭 단추 하나다(#4986). 예전에는 카드 맨 위의 카드 폭 단추였고 그 아래
      // 오류 줄이 다음 행동보다 늦게 읽혔다. 비용 집계·구독 잔여량의 새로 고침과 같은 자리·모양·낱말이다.
      // 진행·잠금 문법(#1486): 불러오는 동안은 aria-busy + 바뀐 낱말이고 잠그지 않는다(초점을 쥔 단추가 disabled가 되면
      // 초점이 body로 떨어진다). 연결이 없을 때만 aria-disabled + 흐림이고 가드가 누름을 막는다.
      action={
        <Button
          variant="outline"
          size="sm"
          aria-busy={query.isFetching || undefined}
          aria-disabled={offline || undefined}
          className={cn(offline && DIM)}
          data-testid="agent-usage-reload"
          onClick={() => {
            if (query.isFetching || offline) return;
            void query.refetch();
            if (rosterMissing) void roster.refetch();
          }}
        >
          {query.isFetching ? "불러오는 중" : "다시 불러오기"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-4" aria-busy={query.isFetching}>
        {unavailable ? <p role="status" className="text-meta text-ink-muted">{query.fetchStatus === "paused" ? COPY.offline : COPY.error}</p>
          : query.isPending ? <p role="status">{COPY.loading}</p> : data ? <>
            <p className="text-meta text-ink-muted">{data.range.from.slice(0, 10)} ~ {data.range.to.slice(0, 10)} (UTC)</p>
            {data.totals.workspace ? <p data-numeric>워크스페이스 전체 · {usageLine(data.totals.workspace)}</p> : <>
              <p data-numeric>내 에이전트 · {usageLine(data.totals.mine)}</p>
              <p data-numeric>공유 에이전트 · {usageLine(data.totals.shared)}</p>
            </>}
            {rosterMissing && <p role="status" className="text-meta text-ink-muted" data-testid="agent-usage-roster-error">{COPY.rosterError}</p>}
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
