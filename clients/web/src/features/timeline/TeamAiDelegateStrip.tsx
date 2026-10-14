import { useState } from "react";
import { Loader2 } from "lucide-react";
import { sendMessage } from "@momo/core/lib/api";
import {
  canDelegate,
  delegateButtonLabel,
  delegateMessageBody,
  type TeamAiDelegate,
  type TeamAiDelegateCandidate,
} from "@momo/core/features/timeline/teamAi";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useOffline } from "@/features/common/useOffline";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 도우미가 넘기는 줄 아래의 「○○에게 맡기기」 (ADR-0201 D5, #3836).
//
// 본문(서버가 쓴 이유 한 문장)은 행이 그대로 그린다. 여기는 그 아래 두 가지뿐이다:
//   - 「넘긴 이유: …」 한 줄 (모르는 이유면 없음)
//   - 요청자 본인에게만 후보별 버튼. 누르면 `@대상 원래 요청` 을 원래 요청에 인용으로
//     달아 보낸다. `clientMsgId` 는 서버가 정한 값이라 두 번 눌러도 메시지는 하나다.
// 요청자가 아닌 사람에게는 버튼이 없다(눌러도 안 되는 버튼을 세우지 않는다).
// =============================================================================

type SendState =
  | { kind: "idle" }
  | { kind: "sending"; memberId: string }
  | { kind: "sent"; name: string }
  | { kind: "error"; memberId: string };

export function TeamAiDelegateStrip({
  delegate,
  workspaceId,
  channelId,
  authorMemberId,
  viewerMemberId,
  sourceBody,
  directory,
}: {
  delegate: TeamAiDelegate;
  workspaceId: string;
  channelId: string;
  /** 이 줄을 쓴 도우미. `props.agent_member_id` 가 없을 때의 대체다. */
  authorMemberId: string;
  viewerMemberId: string | undefined;
  /** 원래 요청의 본문. 화면이 들고 있지 않으면 null. */
  sourceBody: string | null;
  directory: Directory;
}) {
  const offline = useOffline();
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const showButtons = canDelegate(delegate, viewerMemberId);
  if (delegate.reasonLine === null && !showButtons) return null;

  const teamAi = memberFor(
    directory,
    delegate.teamAiMemberId ?? authorMemberId
  );

  function press(candidate: TeamAiDelegateCandidate) {
    if (offline || state.kind === "sending") return;
    setState({ kind: "sending", memberId: candidate.memberId });
    const body = delegateMessageBody({
      targetHandle: candidate.handle,
      sourceBody,
      teamAiHandles: teamAi?.handle ? [teamAi.handle] : [],
    });
    sendMessage(
      workspaceId,
      channelId,
      candidate.clientMsgId,
      body,
      delegate.sourceMessageId !== null
        ? { replyToId: delegate.sourceMessageId }
        : undefined
    )
      .then(() => setState({ kind: "sent", name: candidate.displayName }))
      .catch(() => setState({ kind: "error", memberId: candidate.memberId }));
  }

  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="team-ai-delegate">
      {delegate.reasonLine !== null && (
        <p
          className="text-meta text-ink-muted"
          data-testid="team-ai-delegate-reason"
        >
          {delegate.reasonLine}
        </p>
      )}
      {showButtons && state.kind === "sent" && (
        <p
          role="status"
          className="text-meta text-ink-muted"
          data-testid="team-ai-delegate-sent"
        >
          {state.name}에게 맡겼어요. 답은 이 채널에 와요.
        </p>
      )}
      {showButtons && state.kind !== "sent" && (
        <div className="flex flex-wrap items-center gap-2">
          {delegate.candidates.map((candidate) => {
            const sending =
              state.kind === "sending" && state.memberId === candidate.memberId;
            return (
              <Button
                key={candidate.memberId}
                type="button"
                variant="secondary"
                size="sm"
                data-row-action=""
                data-testid="team-ai-delegate-button"
                aria-disabled={offline || state.kind === "sending" || undefined}
                aria-busy={sending || undefined}
                className={cn(offline && "opacity-50")}
                onClick={() => press(candidate)}
              >
                {sending && (
                  <Loader2 aria-hidden="true" className="spinner-busy" />
                )}
                {delegateButtonLabel(candidate)}
              </Button>
            );
          })}
        </div>
      )}
      {showButtons && offline && state.kind !== "sent" && (
        <p className="text-meta text-ink-muted">
          연결이 끊겨 지금은 맡길 수 없어요.
        </p>
      )}
      {showButtons && state.kind === "error" && (
        <p
          role="alert"
          className="text-meta text-danger"
          data-testid="team-ai-delegate-error"
        >
          보내지 못했어요. 연결을 확인하고 다시 눌러 주세요.
        </p>
      )}
    </div>
  );
}
