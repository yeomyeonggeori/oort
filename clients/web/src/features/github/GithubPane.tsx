import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { startGithubLink, unsubscribeGithub } from "@momo/core/features/github/api";
import {
  GITHUB_PERMISSIONS_SENTENCE,
  GITHUB_SELECTED_ONLY_ADVICE,
  githubFailureMessage,
  githubReturnSentence,
  installationSelectionSentence,
  isGithubUnavailable,
  GITHUB_UNAVAILABLE_SENTENCE,
  type GithubLinkStart,
  type GithubReturnKind,
  type GithubWorkspaceOverview,
} from "@momo/core/features/github/model";
import { channelLabel, useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { StatusChip, Subsection } from "@/features/settings/SettingsFields";
import { GithubExternalLink } from "./GithubExternalLink";
import { GithubOperatorBlock } from "./GithubOperatorBlock";
import { GithubLoadFailure } from "./GithubStates";
import { GithubSubscriptionList } from "./GithubSubscriptionList";
import { githubOverviewPrefix, useGithubOverview } from "./githubQueries";

// =============================================================================
// AI › 외부 연결 › GitHub 알림 (ADR-0205 D10, #3955). 한 화면에 세 구역:
//   1. 운영자 구역  — 이 서버의 GitHub 앱 하나, 연결 안 된 설치 (운영자에게만 서고, 아니면 비어 있다)
//   2. 이 워크스페이스 — 「GitHub 연결」, 연결된 계정, 설치 권고
//   3. 구독        — 이 워크스페이스의 모든 구독. 추가는 채널 ⋮ › GitHub 알림에서 한다.
//
// 돌아온 길(`?githubInstall=` / `?githubApp=`)의 결과는 `GithubReturnLanding` 이 라우터 상태로
// 넘겨 준다. 주소에는 남지 않는다.
// =============================================================================

export interface GithubReturnState {
  githubReturn?: { kind: GithubReturnKind; word: string };
}

function ReturnBanner({ kind, word, onDismiss }: { kind: GithubReturnKind; word: string; onDismiss: () => void }) {
  const sentence = githubReturnSentence(kind, word);
  if (sentence === null) return null;
  const stop = sentence.tone === "stop";
  return (
    <div
      className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md border border-line p-3"
      role={stop ? "alert" : "status"}
      data-testid="github-return"
      data-return-word={word}
      data-return-tone={sentence.tone}
    >
      <div className="flex min-w-0 basis-pane-sm flex-1 flex-col gap-1">
        <p className="break-keep text-body font-semibold text-ink">{sentence.sentence}</p>
        {sentence.next !== undefined && <p className="break-keep text-meta text-ink-muted">{sentence.next}</p>}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss} data-testid="github-return-dismiss">
        닫기
      </Button>
    </div>
  );
}

export function GithubPane({
  workspaceId,
  memberId,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
}) {
  const location = useLocation();
  const returned = (location.state as GithubReturnState | null)?.githubReturn;
  const [dismissed, setDismissed] = useState(false);
  const overview = useGithubOverview(workspaceId);

  // 키가 없는 서버(503)와 이 기능이 없는 서버(404·405·501)는 화면 전체의 사실이다.
  // 아래 구역을 줄줄이 세우면 같은 말을 세 번 하게 된다.
  if (overview.isError && (isGithubUnavailable(overview.error) || isAbsent(overview.error))) {
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="github-pane">
        {isGithubUnavailable(overview.error) ? (
          <InlineBanner tone="neutral" message={GITHUB_UNAVAILABLE_SENTENCE} testId="github-pane-unavailable" />
        ) : (
          <GithubLoadFailure error={overview.error} onRetry={() => void overview.refetch()} testId="github-pane-load" />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-2xl flex-col gap-8" data-testid="github-pane">
      {returned !== undefined && !dismissed && (
        <ReturnBanner kind={returned.kind} word={returned.word} onDismiss={() => setDismissed(true)} />
      )}
      <GithubOperatorBlock workspaceId={workspaceId} offline={offline} />
      <WorkspaceBlock workspaceId={workspaceId} memberId={memberId} offline={offline} overview={overview} />
    </div>
  );
}

function isAbsent(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 405 || status === 501;
}

// ---- 이 워크스페이스 --------------------------------------------------------------

function WorkspaceBlock({
  workspaceId,
  memberId,
  offline,
  overview,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
  overview: ReturnType<typeof useGithubOverview>;
}) {
  const data = overview.data;
  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="github-workspace">
      <Subsection
        title="이 워크스페이스의 GitHub"
        lines={["소유자와 관리자만 연결하고 구독할 수 있어요. 한 GitHub 계정은 한 워크스페이스에만 연결돼요."]}
      >
        {overview.isPending ? (
          <Skeleton ready={false} rows={3} />
        ) : overview.isError || data === undefined ? (
          <GithubLoadFailure error={overview.error} onRetry={() => void overview.refetch()} />
        ) : (
          <ConnectBlock workspaceId={workspaceId} offline={offline} data={data} />
        )}
      </Subsection>
      {data !== undefined && data.appRegistered && (
        <SubscriptionsBlock workspaceId={workspaceId} memberId={memberId} offline={offline} data={data} />
      )}
    </div>
  );
}

function ConnectBlock({
  workspaceId,
  offline,
  data,
}: {
  workspaceId: string;
  offline: boolean;
  data: GithubWorkspaceOverview;
}) {
  const [link, setLink] = useState<GithubLinkStart | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mint = useMutation({
    mutationFn: () => startGithubLink(workspaceId),
    onSuccess: (started) => {
      setMessage(null);
      setLink(started);
    },
    onError: (error) => setMessage(githubFailureMessage("link", error)),
  });

  if (!data.appRegistered) {
    return (
      <EmptyInvite
        className="px-0"
        headline="이 서버에는 아직 GitHub 앱이 없어요"
        detail="서버를 관리하는 분이 먼저 GitHub 앱을 만들어야 해요. 그다음에 이 워크스페이스에 GitHub 계정을 연결할 수 있어요."
        testId="github-no-app"
      />
    );
  }

  const minutes = link === null ? 10 : Math.max(1, Math.round(link.expiresInSeconds / 60));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {data.installations.length === 0 ? (
        <EmptyInvite
          className="px-0"
          headline="아직 연결된 GitHub 계정이 없어요"
          detail="연결하면 그 계정의 저장소 소식을 채널로 받을 수 있어요."
          testId="github-no-installation"
        />
      ) : (
        <ul className="flex min-w-0 flex-col" data-testid="github-installations">
          {data.installations.map((installation) => (
            <li
              key={installation.installationId}
              className="flex min-w-0 flex-col gap-1 border-b border-line py-3 first:border-t"
              data-testid="github-installation-row"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all text-body font-semibold text-ink">{installation.accountLogin}</span>
                <StatusChip tone="muted">{installation.accountType === "Organization" ? "조직" : "개인"}</StatusChip>
                {installation.suspended && <StatusChip tone="warn">멈춤</StatusChip>}
              </div>
              <p className="break-keep text-meta text-ink-muted">
                {installationSelectionSentence(installation.repositorySelection)}
                {installation.repositorySelection === "all"
                  ? " · 이름을 직접 적어 구독해요"
                  : ` · 저장소 ${installation.repositories.length}개`}
                {installation.suspended ? " · 설치가 멈춰 있어서 알림이 오지 않아요" : ""}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="flex min-w-0 flex-col gap-2 rounded-md bg-surface-muted p-3">
        <p className="break-keep text-meta text-ink">{GITHUB_SELECTED_ONLY_ADVICE}</p>
        <p className="break-keep text-meta text-ink-muted">{GITHUB_PERMISSIONS_SENTENCE}</p>
      </div>

      {link === null ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            aria-disabled={offline || undefined}
            aria-busy={mint.isPending || undefined}
            className={offline ? "opacity-50" : undefined}
            onClick={() => {
              if (mint.isPending || offline) return;
              mint.mutate();
            }}
            data-testid="github-link-start"
          >
            {mint.isPending ? "준비 중" : data.installations.length === 0 ? "GitHub 연결" : "GitHub 계정 더 연결"}
          </Button>
        </div>
      ) : (
        <div
          className="flex min-w-0 flex-col gap-2 rounded-md border border-line p-3"
          data-testid="github-link-ready"
        >
          <p className="break-keep text-body text-ink">
            GitHub에서 설치를 마쳐 주세요. {minutes}분 안에 마치면 이 화면으로 돌아와요.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setLink(null)}>
              취소
            </Button>
            <Button asChild size="sm">
              <GithubExternalLink href={link.installUrl} data-testid="github-link-open">
                GitHub에서 설치하기
              </GithubExternalLink>
            </Button>
          </div>
        </div>
      )}
      {message !== null && <InlineBanner message={message} testId="github-link-error" />}
    </div>
  );
}

// ---- 구독 --------------------------------------------------------------------------

function SubscriptionsBlock({
  workspaceId,
  memberId,
  offline,
  data,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
  data: GithubWorkspaceOverview;
}) {
  const client = useQueryClient();
  const channels = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const [message, setMessage] = useState<string | null>(null);
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const channel of [...channels.groups.channels, ...channels.groups.dms]) {
      map.set(channel.id.toLowerCase(), channelLabel(channel, directory, memberId));
    }
    return map;
  }, [channels.groups, directory, memberId]);
  const remove = useMutation({
    mutationFn: (subscriptionId: string) => unsubscribeGithub(workspaceId, subscriptionId),
    onSuccess: () => {
      setMessage(null);
      void client.invalidateQueries({ queryKey: githubOverviewPrefix(workspaceId) });
    },
    onError: (error) => setMessage(githubFailureMessage("unsubscribe", error)),
  });

  return (
    <Subsection
      title="구독"
      lines={["구독을 더하려면 채널 헤더의 ⋮ 메뉴에서 「GitHub 알림」을 열어요."]}
    >
      {data.subscriptions.length === 0 ? (
        <EmptyInvite
          className="px-0"
          headline="아직 구독한 저장소가 없어요"
          detail="채널을 열고 ⋮ 메뉴의 「GitHub 알림」에서 저장소를 골라요."
          testId="github-no-subscription"
        />
      ) : (
        <GithubSubscriptionList
          subscriptions={data.subscriptions}
          channelName={(subscription) => nameById.get(subscription.channelId.toLowerCase()) ?? "알 수 없는 채널"}
          onRemove={(subscription) => remove.mutate(subscription.id)}
          removingId={remove.isPending ? (remove.variables ?? null) : null}
          offline={offline}
        />
      )}
      {message !== null && <InlineBanner message={message} testId="github-subscription-error" />}
    </Subsection>
  );
}
