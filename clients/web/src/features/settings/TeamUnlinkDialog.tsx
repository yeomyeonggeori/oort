import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TEAM_UNLINK_FIXED_COPY,
  TEAM_UNLINK_LIST_UNKNOWN,
  TEAM_UNLINK_NO_SILENT_SWITCH,
  teamLinkAffectedAgents,
  teamUnlinkBody,
  teamUnlinkTitle,
} from "@momo/core/features/settings/teamLinkImpact";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Skeleton } from "@/features/common/States";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 팀 키 「연결 끊기」 확인 창 (#2880 AA-7, 시안 §3 오른쪽).
//
// 끊기 전에 **이 키로 대답하는 팀 에이전트를 이름으로** 보인다. 이름은 누를 수 없는
// 글자다(링크·버튼이 아니다): 이 창에서 할 일은 끊거나 취소하는 것뿐이다.
// 영향 판정은 코어 `teamLinkAffectedAgents`(활성 에이전트 - 호스티드 연결)이고, 호스티드
// 목록을 못 읽으면 숫자를 지어내지 않는다.
//
// 다른 키로 조용히 넘어가지 않는다는 문장은 늘 선다(ADR-0135 D1, #2897).
// =============================================================================

const LOADING_REASON_ID = "ai-unlink-loading";

export function TeamUnlinkDialog({
  open,
  onOpenChange,
  opener,
  workspaceId,
  rowName,
  legacy,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: RefObject<HTMLButtonElement | null>;
  workspaceId: string;
  rowName: string;
  legacy: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          role="alertdialog"
          opener={opener.current}
          className="gap-3 p-5"
          data-testid="ai-link-unlink-dialog"
        >
          <UnlinkBody
            workspaceId={workspaceId}
            rowName={rowName}
            legacy={legacy}
            busy={busy}
            error={error}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function UnlinkBody({
  workspaceId,
  rowName,
  legacy,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  workspaceId: string;
  rowName: string;
  legacy: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const directory = useDirectory(workspaceId);
  const hosted = useQuery(hostedListQuery(workspaceId));
  const channels = useChannels(workspaceId);

  const loading = directory.isPending || hosted.isPending;
  const affected = loading
    ? null
    : teamLinkAffectedAgents({
        roster: directory.data,
        hostedAgentIds: hosted.isSuccess ? hosted.data.map((row) => row.agentMemberId) : null,
        channels: (channels.data ?? []).map((channel) => ({ id: channel.id, name: channel.name ?? "" })),
      });
  // 목록을 읽는 동안에는 끊기를 잠근다: 누가 멈추는지 보기 전에 끊지 않게. 읽기에
  // 실패하면 잠그지 않는다(끊기는 운영자의 결정이고, 창이 그 사실을 말한다).
  const locked = loading || busy;

  return (
    <>
      <DialogTitle className="text-title font-bold">{teamUnlinkTitle(rowName)}</DialogTitle>
      <DialogDescription className="break-keep text-body text-ink-muted" data-testid="ai-link-unlink-body">
        {loading ? "이 키를 쓰는 팀 에이전트를 찾고 있어요." : teamUnlinkBody(affected)}
      </DialogDescription>
      {legacy && (
        <p className="break-keep text-meta text-ink-muted">
          내부용 연결이라 같은 방식으로는 다시 만들 수 없어요. 끊은 뒤에는 API 키로 연결하세요.
        </p>
      )}
      {loading ? (
        <Skeleton ready={false} rows={2} className="py-1" />
      ) : (
        <ul
          className="flex min-w-0 list-disc flex-col gap-1 pl-5 text-body text-ink"
          data-testid="ai-link-unlink-impact"
        >
          {affected === null ? (
            <li className="break-keep text-ink-muted" data-testid="ai-link-unlink-unknown">
              {TEAM_UNLINK_LIST_UNKNOWN}
            </li>
          ) : (
            affected.map((agent) => (
              <li key={agent.id} className="break-keep" data-testid="ai-link-unlink-agent">
                <b className="font-semibold">@{agent.name}</b>
                {(agent.where || agent.paused) && (
                  <span className="text-ink-muted">
                    {" "}
                    ({[agent.where, agent.paused ? "일시정지" : null].filter(Boolean).join(" · ")})
                  </span>
                )}
              </li>
            ))
          )}
          <li className="break-keep">{TEAM_UNLINK_FIXED_COPY}</li>
          <li className="break-keep" data-testid="ai-link-unlink-no-switch">
            {TEAM_UNLINK_NO_SILENT_SWITCH}
          </li>
        </ul>
      )}
      {error && (
        <p className="break-keep text-meta text-danger" role="alert" data-testid="ai-link-unlink-error">
          {error}
        </p>
      )}
      {loading && (
        <p id={LOADING_REASON_ID} className="sr-only">
          영향 받는 에이전트를 불러오는 중이라 아직 끊을 수 없어요.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" className="tap-target" onClick={onCancel} data-testid="ai-link-unlink-cancel">
          취소
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className={cn("tap-target", loading && !busy && "opacity-50 hover:opacity-50")}
          aria-disabled={locked || undefined}
          aria-busy={busy || undefined}
          aria-describedby={loading ? LOADING_REASON_ID : undefined}
          onClick={() => {
            if (locked) return;
            onConfirm();
          }}
          data-testid="ai-link-unlink-confirm"
        >
          {busy ? "끊는 중" : "연결 끊기"}
        </Button>
      </div>
    </>
  );
}
