import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { Avatar } from "@/features/timeline/MessageRow";
import { useTickingNow } from "@/features/agents/agentWorkingSignal";
import { canCreateAgentNow } from "@/features/agentHub/createModel";
import { uuidEq, type Message, type RosterMember } from "@momo/core/lib/api";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import {
  isSurfaceProvided,
  serverSaysAbsent,
} from "@momo/core/features/capabilities/serverSurfaces";
import { isHostedOperatorDenied } from "@momo/core/features/hostedAgents/model";
import {
  FIRST_MENTION_AGENT_BADGE,
  firstMentionDraft,
  firstMentionView,
  pickFirstMentionTarget,
  previewHintedAgent,
  type FirstMentionMessage,
} from "@momo/core/features/hostedAgents/firstMention";
import { hostedListQuery } from "./hostedCredentialScope";
import { seedComposerText } from "@/features/chat/draftStore";

// =============================================================================
// 호스티드 에이전트 초대 직후 첫 멘션 왕복 (T-6 / #1656).
//
// 위저드 단계 기계와 원클릭 초대 줄은 바꾸지 않는다. 이 표면은 그 흐름이
// 끝난 채널 위에 이어 붙는다. 네 상태(빈/로딩/오류/오프라인)와 에이전트
// 뱃지가 계약이다. 응답 시간 상한은 게이트가 아니다. 답이 안 오면 오류가
// 실존해야 할 뿐이다.
//
// Reading this as: onboarding for internal team users on web+Tauri, density 6/10, motion 2/10.
// =============================================================================

const hostedPairingProvided = isSurfaceProvided("hostedAgentPairing");

function asMentionMessages(
  messages: readonly Message[],
  pending: readonly PendingMessage[]
): FirstMentionMessage[] {
  return [
    ...pending.map((row) => ({
      authorMemberId: row.authorMemberId,
      createdAtMs: row.createdAtMs,
      body: row.body,
      state: "sent" as const,
    })),
    ...messages.map((row) => ({
      authorMemberId: row.authorMemberId,
      createdAtMs: row.createdAtMs,
      body: row.body,
      state: row.state,
      props: row.props,
    })),
  ];
}

function focusComposer(): void {
  const input = document.getElementById("composer-input");
  if (input instanceof HTMLTextAreaElement) input.focus();
}

export function FirstMentionOnboarding({
  workspaceId,
  channelId,
  members,
  selfMemberId,
  selfKind,
  selfRole,
  messages,
  pending,
  messagesStatus,
  hintedAgentMemberId,
  onRetryMessages,
}: {
  workspaceId: string;
  channelId: string;
  members: readonly RosterMember[];
  selfMemberId: string;
  selfKind: "human" | "agent";
  selfRole: RosterMember["role"];
  messages: readonly Message[];
  pending: readonly PendingMessage[];
  messagesStatus: "loading" | "ready" | "error";
  hintedAgentMemberId: string | null;
  onRetryMessages: () => void;
}) {
  const offline = useOffline();
  const mayOperate = canCreateAgentNow(true, selfKind, selfRole);
  const listEnabled =
    hostedPairingProvided &&
    (mayOperate || hintedAgentMemberId !== null);

  const list = useQuery({
    ...hostedListQuery(workspaceId),
    enabled: listEnabled,
  });

  const connectionsDenied =
    list.isError &&
    (isHostedOperatorDenied(list.error) || serverSaysAbsent(list.error));

  const connectionsStatus = !listEnabled
    ? "idle"
    : list.isPending
      ? "loading"
      : list.isError && !connectionsDenied
        ? "error"
        : "ready";

  const connections = useMemo(
    () => (connectionsDenied ? [] : (list.data ?? [])),
    [connectionsDenied, list.data]
  );
  const target = useMemo(
    () =>
      pickFirstMentionTarget({
        channelId,
        members,
        connections,
        hintedAgentMemberId,
      }),
    [channelId, members, connections, hintedAgentMemberId]
  );
  const previewAgent = useMemo(
    () => previewHintedAgent(members, hintedAgentMemberId),
    [members, hintedAgentMemberId]
  );

  const mentionRows = useMemo(
    () => asMentionMessages(messages, pending),
    [messages, pending]
  );

  const waiting =
    target !== null &&
    (messagesStatus === "ready" || messagesStatus === "loading");
  const nowMs = useTickingNow(waiting && !offline);

  const surface = firstMentionView({
    target,
    hintedAgentMemberId,
    previewAgent,
    connectionsStatus,
    messagesStatus,
    messages: mentionRows,
    selfMemberId,
    nowMs,
  });

  if (surface.phase === "hidden") return null;

  const rosterAgent =
    surface.agent === null
      ? null
      : (members.find((row) => uuidEq(row.id, surface.agent?.agentMemberId)) ??
        null);

  const startMention = () => {
    if (offline || !surface.agent) return;
    seedComposerText(
      workspaceId,
      channelId,
      firstMentionDraft(surface.agent.handle)
    );
    focusComposer();
  };

  const retry = () => {
    if (surface.errorKind === "connections") {
      void list.refetch();
      return;
    }
    if (surface.errorKind === "timeout") {
      startMention();
      return;
    }
    onRetryMessages();
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-3 border-b border-line px-4 py-3"
      data-testid="first-mention-onboarding"
      data-phase={surface.phase}
      data-error-kind={surface.errorKind ?? undefined}
    >
      {offline && (
        <InlineBanner
          tone="neutral"
          separator={false}
          message="연결이 끊겼습니다. 마지막으로 받은 내용은 계속 볼 수 있고, 멘션은 다시 연결된 뒤에 보낼 수 있습니다."
          testId="first-mention-offline"
        />
      )}

      {surface.agent && (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar member={rosterAgent} />
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
            <p className="text-body font-semibold text-agent">
              {surface.agent.displayName}
            </p>
            <span
              className="rounded-sm bg-agent-soft px-1 text-timestamp text-agent"
              data-testid="first-mention-agent-badge"
            >
              {FIRST_MENTION_AGENT_BADGE}
            </span>
            <span className="text-meta text-ink-muted">
              @{surface.agent.handle}
            </span>
          </div>
        </div>
      )}

      {surface.phase === "loading" ? (
        <div role="status">
          <span className="sr-only">{surface.headline}</span>
          <SkeletonRows rows={2} className="p-0" />
        </div>
      ) : surface.phase === "error" ? (
        <InlineBanner
          message={`${surface.headline} ${surface.detail}`.trim()}
          actionLabel={offline ? undefined : (surface.actionLabel ?? undefined)}
          onAction={offline ? undefined : retry}
          testId="first-mention-error"
        />
      ) : (
        <div className="flex min-w-0 flex-col items-start gap-3">
          <p className="break-keep text-body text-ink">{surface.headline}</p>
          {surface.detail !== "" && (
            <p className="break-keep text-body text-ink-muted">{surface.detail}</p>
          )}
          {surface.actionLabel && (
            <Button
              type="button"
              size="sm"
              aria-disabled={offline || undefined}
              aria-label={
                offline
                  ? `${surface.actionLabel}. 연결이 끊겨 지금은 할 수 없습니다`
                  : undefined
              }
              className={cn(offline && "opacity-50")}
              onClick={startMention}
              data-testid="first-mention-action"
            >
              {surface.actionLabel}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
