import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hash, Loader2, Lock } from "lucide-react";
import { Button } from "@/design/ui/button";
import { Select } from "@/design/ui/select";
import { useSession } from "@/app/session";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useChannels } from "@/features/workspace/useWorkspace";
import {
  addChannelMember,
  removeChannelMember,
  uuidEq,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  channelPlacement,
  placementFailure,
  placementReceipt,
  type PlacementAction,
} from "@momo/core/features/agents/channelPlacement";
import { normalizedId } from "@momo/core/features/agents/hubModel";

// =============================================================================
// 채널 배치 (goal B5.3b, D-4). The half of onboarding that `POST …/agents` does
// not do: creating an agent mints an identity and joins it to nothing, so this
// is where an agent stops being a name in the roster and becomes reachable.
//
// Two design decisions worth naming:
//
//   * There is no capability probe in front of these two buttons, unlike the
//     profile editor above them. `POST/DELETE …/channels/{ch}/members` have no
//     side-effect-free sibling to ask, and inventing one (a speculative POST) is
//     worse than the honest failure: `placementFailure` answers a 404 by naming
//     BOTH things it can mean, so a press on a server without the endpoints
//     produces a sentence that is true rather than a retry loop.
//   * Removal confirms in place rather than in an AlertDialog. Same reason the
//     approval card gives: the guard the rule asks for is that no destructive
//     action fires on one unguarded click, and keeping the question in the row
//     keeps it next to the channel name it is about.
// =============================================================================

function ChannelIcon({ kind }: { kind: string }) {
  return kind === "private" ? (
    <Lock className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
  ) : (
    <Hash className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
  );
}

export function AgentChannelsSection({
  agent,
  offline,
}: {
  agent: RosterMember;
  offline: boolean;
}) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const channelsQuery = useChannels(workspaceId);
  const [addTarget, setAddTarget] = useState("");
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const placement = useMemo(
    () =>
      channelPlacement(
        agent,
        channelsQuery.groups.channels,
        channelsQuery.groups.dms
      ),
    [agent, channelsQuery.groups]
  );

  const mutation = useMutation({
    mutationFn: async (input: {
      action: PlacementAction;
      channelId: string;
      channelName: string;
    }) => {
      if (input.action === "add") {
        await addChannelMember(workspaceId, input.channelId, agent.id);
      } else {
        await removeChannelMember(workspaceId, input.channelId, agent.id);
      }
      return input;
    },
    onSuccess: async (input) => {
      setError(null);
      setConfirmingRemoval(null);
      setAddTarget("");
      setReceipt(
        placementReceipt(input.action, agent.displayName, input.channelName)
      );
      // The roster carries `channelIds`, so it is the row this edit changed.
      await client.invalidateQueries({ queryKey: ["roster", workspaceId] });
    },
    onError: (cause, input) => {
      setReceipt(null);
      setConfirmingRemoval(null);
      setError(placementFailure(input.action, cause));
    },
  });

  const busy = mutation.isPending;
  const pendingChannelId = busy ? mutation.variables?.channelId : undefined;

  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="agent-hub-channels"
    >
      <div>
        <h3 className="text-body font-semibold text-ink">채널</h3>
        <p className="text-meta text-ink-muted">
          이 에이전트가 들어가 있는 채널입니다. 채널에 있어야 그 채널에서 멘션할
          수 있습니다.
        </p>
      </div>

      {error && (
        <InlineBanner
          separator={false}
          message={error}
          actionLabel="닫기"
          onAction={() => setError(null)}
          testId="agent-hub-channels-error"
        />
      )}
      {receipt && (
        <InlineBanner
          tone="neutral"
          separator={false}
          message={receipt}
          actionLabel="닫기"
          onAction={() => setReceipt(null)}
          testId="agent-hub-channels-receipt"
        />
      )}

      {channelsQuery.isPending ? (
        <div role="status">
          <span className="sr-only">채널 목록을 불러오는 중입니다.</span>
          <SkeletonRows rows={3} className="p-0" />
        </div>
      ) : channelsQuery.isError ? (
        <InlineBanner
          separator={false}
          message="채널 목록을 불러오지 못해 어디에 들어가 있는지 확인할 수 없습니다."
          actionLabel="다시 시도"
          onAction={() => void channelsQuery.refetch()}
          testId="agent-hub-channels-list-error"
        />
      ) : placement.present.length === 0 ? (
        <EmptyInvite
          headline="아직 어떤 채널에도 들어가 있지 않습니다."
          detail="채널에 넣으면 그 채널의 멤버들이 이 에이전트를 멘션할 수 있습니다."
          testId="agent-hub-channels-empty"
        />
      ) : (
        <ul
          className="flex flex-col overflow-hidden rounded-md border border-line"
          data-testid="agent-hub-channel-list"
        >
          {placement.present.map((channel) => {
            const name = channel.name ?? "이름 없는 채널";
            const confirming = uuidEq(confirmingRemoval ?? undefined, channel.id);
            const rowBusy = busy && pendingChannelId === channel.id;
            return (
              <li
                key={normalizedId(channel.id)}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0"
                data-testid="agent-hub-channel-row"
                data-channel-id={normalizedId(channel.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ChannelIcon kind={channel.kind} />
                  <span className="min-w-0 truncate text-body text-ink">
                    {name}
                  </span>
                </span>
                {confirming ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-meta text-ink">
                      내보내면 이 채널의 멘션이 더 이상 전달되지 않습니다.
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={rowBusy}
                      onClick={() => setConfirmingRemoval(null)}
                    >
                      취소
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      aria-busy={rowBusy || undefined}
                      onClick={() => {
                        if (!busy) {
                          mutation.mutate({
                            action: "remove",
                            channelId: channel.id,
                            channelName: name,
                          });
                        }
                      }}
                      data-testid="agent-hub-channel-remove-confirm"
                    >
                      {rowBusy && (
                        <Loader2 aria-hidden="true" className="spinner-busy" />
                      )}
                      {rowBusy ? "내보내는 중" : "내보내기 확정"}
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={offline || busy}
                    onClick={() => {
                      setError(null);
                      setReceipt(null);
                      setConfirmingRemoval(normalizedId(channel.id));
                    }}
                    data-testid="agent-hub-channel-remove"
                  >
                    내보내기
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {placement.unresolved > 0 && (
        <p className="text-meta text-ink-muted" data-testid="agent-hub-channels-unresolved">
          이 밖에{" "}
          <span data-numeric>{placement.unresolved.toLocaleString("ko-KR")}</span>
          개의 대화에 더 들어가 있습니다. 회원님이 볼 수 없는 채널이거나 다이렉트
          메시지라 이름을 표시하지 않습니다.
        </p>
      )}

      {!channelsQuery.isPending && !channelsQuery.isError && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const channel = placement.available.find((candidate) =>
              uuidEq(candidate.id, addTarget)
            );
            if (!channel || busy || offline) return;
            setError(null);
            setReceipt(null);
            mutation.mutate({
              action: "add",
              channelId: channel.id,
              channelName: channel.name ?? "이름 없는 채널",
            });
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label
              htmlFor="agent-hub-channel-add"
              className="text-meta text-ink-muted"
            >
              채널에 추가
            </label>
            <Select
              id="agent-hub-channel-add"
              value={addTarget}
              disabled={offline || busy || placement.available.length === 0}
              onChange={(event) => {
                setAddTarget(event.target.value);
                setError(null);
              }}
              data-testid="agent-hub-channel-add"
            >
              <option value="">
                {placement.available.length === 0
                  ? "추가할 수 있는 채널이 없습니다"
                  : "채널 고르기"}
              </option>
              {/* The popup is OS-drawn and takes no markup, so the private
                  marker is a word rather than the lock icon the rows use. */}
              {placement.available.map((channel) => (
                <option key={normalizedId(channel.id)} value={channel.id}>
                  {`#${channel.name ?? "이름 없는 채널"}${
                    channel.kind === "private" ? " (비공개)" : ""
                  }`}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={offline || busy || addTarget === ""}
            aria-busy={busy && mutation.variables?.action === "add" ? true : undefined}
            data-testid="agent-hub-channel-add-submit"
          >
            {busy && mutation.variables?.action === "add" && (
              <Loader2 aria-hidden="true" className="spinner-busy" />
            )}
            {busy && mutation.variables?.action === "add" ? "추가 중" : "채널에 추가"}
          </Button>
        </form>
      )}
    </section>
  );
}
