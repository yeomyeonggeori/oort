import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { fetchProviderChain } from "@momo/core/features/settings/api";
import { parseProviderChain } from "@momo/core/features/settings/chainModel";
import {
  agentOwnsModel,
  fetchAgentProviderPin,
  pinChoiceOf,
  pinOptions,
  pinSaveMessage,
  pinUnresolvedSentence,
  pinnableAgent,
  putAgentProviderPin,
  sameChoice,
  PIN_COPY,
  type PinChoice,
} from "@momo/core/features/settings/agentProviderPin";
import { fetchCohostedStatus } from "@momo/core/features/settings/cohostedAgent";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { useSession } from "@/app/session";

// Reading this as: agent settings section (operator only) for internal team users on
// web+Tauri, density 6/10, motion 1/10.

/**
 * 「이 에이전트가 쓸 AI」 (#3875, 서버 #3873 / ADR-0147 증보 2026-10-16).
 *
 * 인스턴스 운영자에게만 보인다. 판정은 서버 답이다: 읽기가 403 이면(운영자가 아니다) 404 이면
 * (이 서버에 길이 없다) 이 절은 아무것도 그리지 않는다. 그래서 옛 서버와 일반 멤버는 이 절의
 * 존재를 모른다. 읽는 동안에도 아무것도 그리지 않는다: 대부분의 보는 사람은 운영자가 아니라서
 * 뼈대를 먼저 보이면 곧 사라지는 깜빡임이 된다.
 *
 * 연결 목록은 운영자 전용 `GET /v1/provider/link/chain` 이다. 못 읽어도 「기본 AI 따르기」와
 * (있으면) 「같은 서버의 Hermes」는 고를 수 있다. 개인·구독 에이전트에는 절 자체를 그리지 않는다.
 */
export function AgentProviderPinSection({
  agent,
  offline,
}: {
  agent: RosterMember;
  offline: boolean;
}) {
  if (!pinnableAgent(agent)) return null;
  return <PinPicker agent={agent} offline={offline} />;
}

function PinPicker({ agent, offline }: { agent: RosterMember; offline: boolean }) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const groupId = useId();
  const noteId = `${groupId}-note`;
  const key = ["agent-provider-pin", workspaceId, agent.id];

  const read = useQuery({
    queryKey: key,
    queryFn: () => fetchAgentProviderPin(workspaceId, agent.id),
    retry: false,
  });
  const operator = read.data?.kind === "ready";
  // 목록과 같은 서버 카드의 선언은 운영자로 확인된 뒤에만 읽는다.
  const chainQuery = useQuery({
    queryKey: ["settings", "provider-chain"],
    queryFn: async () => parseProviderChain(await fetchProviderChain()),
    retry: false,
    enabled: operator,
  });
  const cohosted = useQuery({
    queryKey: ["cohosted-agent", workspaceId],
    queryFn: () => fetchCohostedStatus(workspaceId),
    retry: false,
    enabled: operator,
  });

  const [picked, setPicked] = useState<PinChoice | null>(null);
  const save = useMutation({
    mutationFn: (choice: PinChoice) => putAgentProviderPin(workspaceId, agent.id, choice),
    onSuccess: () => {
      setPicked(null);
      void client.invalidateQueries({ queryKey: key });
    },
  });

  if (read.isPending) return null;
  if (read.data?.kind === "forbidden" || read.data?.kind === "absent") return null;
  if (read.isError || read.data?.kind === "unknown") {
    return (
      <section className="flex flex-col gap-2 border-t border-line pt-4" data-testid="agent-pin-section">
        <h3 className="text-body font-semibold text-ink">{PIN_COPY.title}</h3>
        <InlineBanner
          message={PIN_COPY.readError}
          actionLabel={PIN_COPY.retry}
          onAction={() => void read.refetch()}
          testId="agent-pin-error"
        />
      </section>
    );
  }
  if (read.data?.kind !== "ready") return null;

  const pin = read.data.pin;
  const saved = pinChoiceOf(pin);
  const current = picked ?? saved;
  const chain = chainQuery.data ?? null;
  const options = pinOptions({
    pin,
    chain,
    envLinkAvailable: cohosted.data?.kind === "ready",
    ownsModel: agentOwnsModel(agent),
  });
  const dirty = !sameChoice(current, saved);
  const blocked = offline || save.isPending;
  const hasTeamLinks = options.some((option) => option.choice.kind === "team_link" && !option.disabled);

  return (
    <section className="flex min-w-0 flex-col gap-3 border-t border-line pt-4" data-testid="agent-pin-section">
      <div className="flex flex-col gap-1">
        <h3 className="text-body font-semibold text-ink">{PIN_COPY.title}</h3>
        <p id={noteId} className="break-keep text-meta text-ink-muted">
          {PIN_COPY.lead}
        </p>
      </div>

      {pin && !pin.linkResolved && (
        <InlineBanner
          tone="error"
          message={pinUnresolvedSentence(pin)}
          testId="agent-pin-unresolved"
        />
      )}

      <fieldset
        className="flex min-w-0 flex-col border-t border-line"
        disabled={blocked}
        aria-describedby={noteId}
        data-testid="agent-pin-options"
      >
        <legend className="sr-only">{PIN_COPY.title}</legend>
        {options.map((option) => {
          const checked = sameChoice(current, option.choice);
          const hintId = `${groupId}-${option.key}-hint`;
          return (
            <label
              key={option.key}
              className={cn(
                "press flex min-w-0 items-start gap-3 border-b border-line py-3",
                option.disabled ? "cursor-default" : "cursor-pointer hover:bg-surface-hover"
              )}
              data-testid={`agent-pin-option-${option.key}`}
            >
              <input
                type="radio"
                name={groupId}
                value={option.key}
                checked={checked}
                disabled={option.disabled}
                aria-describedby={option.hint ? hintId : undefined}
                onChange={() => setPicked(option.choice)}
                className="ai-connect-radio mt-1 focus-visible:focus-ring"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-keep text-body text-ink [overflow-wrap:anywhere]">{option.label}</span>
                {option.hint && (
                  <span id={hintId} className="break-keep text-meta text-ink-muted">
                    {option.hint}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>

      {!hasTeamLinks && chainQuery.isSuccess && (
        <p className="break-keep text-meta text-ink-muted" data-testid="agent-pin-no-links">
          {PIN_COPY.noTeamLinks}
        </p>
      )}

      {offline && <InlineBanner tone="neutral" message={PIN_COPY.offline} testId="agent-pin-offline" />}
      {save.isError && (
        <InlineBanner message={pinSaveMessage(save.error)} testId="agent-pin-save-error" />
      )}
      {save.isSuccess && !dirty && (
        <p role="status" className="text-meta text-ink-muted" data-testid="agent-pin-saved">
          {PIN_COPY.saved}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          className="tap-target"
          disabled={blocked || !dirty}
          aria-disabled={blocked || !dirty}
          onClick={() => save.mutate(current)}
          data-testid="agent-pin-save"
        >
          {save.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {save.isPending ? PIN_COPY.saving : PIN_COPY.save}
        </Button>
      </div>
    </section>
  );
}
