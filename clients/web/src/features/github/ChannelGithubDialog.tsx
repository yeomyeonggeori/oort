import { useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  restoreDialogOpenerFocus,
  useRestoreFocusOnClose,
} from "@/design/ui/dialog";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { unsubscribeGithub } from "@momo/core/features/github/api";
import {
  CHANNEL_GITHUB_LABEL,
  GITHUB_PANE_PATH,
  githubFailureMessage,
} from "@momo/core/features/github/model";
import type { Channel } from "@momo/core/lib/api";
import { GithubLoadFailure } from "./GithubStates";
import { GithubSubscribeForm } from "./GithubSubscribeForm";
import { GithubSubscriptionList } from "./GithubSubscriptionList";
import { githubOverviewPrefix, useGithubOverview } from "./githubQueries";

// =============================================================================
// 채널 ⋮ › GitHub 알림 (ADR-0205 D10, #3955). 이 채널의 구독을 보고, 저장소를 더하고, 해제한다.
//
// 열린 동안만 질의한다(부모가 열릴 때만 세운다). 읽기는 소유자·관리자만 된다: 403 이면 누가 하는지
// 말하고 폼은 세우지 않는다. 앱도 연결도 없으면 이 채널에서 할 수 있는 일이 없으므로 허브 화면으로
// 가는 길 하나만 둔다(연결은 워크스페이스 단위의 일이다).
// =============================================================================

export function ChannelGithubDialog({
  workspaceId,
  channel,
  channelTitle,
  open,
  onOpenChange,
  opener,
}: {
  workspaceId: string;
  channel: Channel;
  channelTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: RefObject<HTMLElement | null>;
}) {
  useRestoreFocusOnClose(open, opener);
  const offline = useOffline();
  const client = useQueryClient();
  const overview = useGithubOverview(workspaceId, open, channel.id);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (subscriptionId: string) => unsubscribeGithub(workspaceId, subscriptionId),
    onSuccess: () => {
      setRemoveError(null);
      void client.invalidateQueries({ queryKey: githubOverviewPrefix(workspaceId) });
    },
    onError: (error) => setRemoveError(githubFailureMessage("unsubscribe", error)),
  });

  const data = overview.data;
  // 서버가 `?channelId=` 로 거르지 못하는 옛 응답에도 이 채널 것만 보인다.
  const mine = (data?.subscriptions ?? []).filter(
    (subscription) => subscription.channelId.toLowerCase() === channel.id.toLowerCase()
  );
  const hasUsableInstallation = (data?.installations ?? []).some((installation) => !installation.suspended);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        opener={opener.current}
        className="max-h-pane-lg gap-4 overflow-y-auto p-4"
        data-testid="channel-github-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreDialogOpenerFocus(opener.current);
        }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle>{CHANNEL_GITHUB_LABEL}</DialogTitle>
          <DialogDescription className="break-keep">
            {channelTitle} 채널에 저장소 소식이 「GitHub」 이름으로 와요. 사람이 쓴 글이 아니라 GitHub가 보낸 알림이에요.
          </DialogDescription>
        </div>

        {overview.isPending ? (
          <Skeleton ready={false} rows={3} />
        ) : overview.isError || data === undefined ? (
          <GithubLoadFailure
            error={overview.error}
            onRetry={() => void overview.refetch()}
            testId="channel-github-load"
          />
        ) : !data.appRegistered ? (
          <EmptyInvite
            className="px-0"
            headline="이 서버에는 아직 GitHub 앱이 없어요"
            detail="서버를 관리하는 분이 먼저 앱을 만들어야 해요."
            actions={
              <Button asChild variant="secondary" size="sm">
                <Link to={GITHUB_PANE_PATH} onClick={() => onOpenChange(false)}>
                  GitHub 설정 열기
                </Link>
              </Button>
            }
            testId="channel-github-no-app"
          />
        ) : !hasUsableInstallation ? (
          <EmptyInvite
            className="px-0"
            headline="연결된 GitHub 계정이 없어요"
            detail="먼저 이 워크스페이스에 GitHub 계정을 연결해야 저장소를 고를 수 있어요."
            actions={
              <Button asChild variant="secondary" size="sm">
                <Link to={GITHUB_PANE_PATH} onClick={() => onOpenChange(false)}>
                  GitHub 연결하러 가기
                </Link>
              </Button>
            }
            testId="channel-github-no-installation"
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            <section className="flex min-w-0 flex-col gap-1" aria-label="이 채널의 구독">
              <h3 className="text-body font-semibold text-ink">이 채널의 구독</h3>
              {mine.length === 0 ? (
                <p className="break-keep text-meta text-ink-muted" data-testid="channel-github-empty">
                  아직 구독한 저장소가 없어요. 아래에서 저장소를 골라 더해요.
                </p>
              ) : (
                <GithubSubscriptionList
                  subscriptions={mine}
                  onRemove={(subscription) => remove.mutate(subscription.id)}
                  removingId={remove.isPending ? (remove.variables ?? null) : null}
                  offline={offline}
                />
              )}
              {removeError !== null && (
                <InlineBanner message={removeError} testId="channel-github-remove-error" />
              )}
            </section>
            <section className="flex min-w-0 flex-col gap-2" aria-label="저장소 더하기">
              <h3 className="text-body font-semibold text-ink">저장소 더하기</h3>
              <GithubSubscribeForm
                workspaceId={workspaceId}
                channel={channel}
                channelTitle={channelTitle}
                overview={data}
                offline={offline}
              />
            </section>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="channel-github-close"
          >
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
