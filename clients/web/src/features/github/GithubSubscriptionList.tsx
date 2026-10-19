import { featuresSummary, type GithubSubscription } from "@momo/core/features/github/model";
import { ConfirmButton, StatusChip } from "@/features/settings/SettingsFields";

// =============================================================================
// 구독 목록 (ADR-0205 D5, #3955). 한 줄 = 저장소 하나 + 받는 알림 + 상태 칩.
// 해제는 되돌릴 수 있지만 알림이 끊기므로 두 단계다(ConfirmButton). 채널 이름은 호출부가 정한다:
// 채널 다이얼로그는 자기 채널이라 이름을 달지 않고, 허브는 채널 이름을 단다.
// =============================================================================

export function GithubSubscriptionList({
  subscriptions,
  channelName,
  onRemove,
  removingId,
  offline,
  testId = "github-subscriptions",
}: {
  subscriptions: GithubSubscription[];
  channelName?: (subscription: GithubSubscription) => string;
  onRemove: (subscription: GithubSubscription) => void;
  removingId: string | null;
  offline: boolean;
  testId?: string;
}) {
  return (
    <ul className="flex min-w-0 flex-col" data-testid={testId}>
      {subscriptions.map((subscription) => (
        <li
          key={subscription.id}
          className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line py-3 first:border-t"
          data-testid="github-subscription-row"
          data-subscription-id={subscription.id}
        >
          <div className="flex min-w-0 basis-pane-sm flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 break-all text-body font-semibold text-ink">
                {subscription.repository}
              </span>
              {subscription.privateConfirmed && <StatusChip tone="muted">비공개 확인함</StatusChip>}
              {!subscription.active && <StatusChip tone="warn">멈춤</StatusChip>}
            </div>
            <p className="break-keep text-meta text-ink-muted">
              {channelName !== undefined ? `${channelName(subscription)} · ` : ""}
              {featuresSummary(subscription.features)}
              {!subscription.active ? " · 설치가 멈춰 있어서 알림이 오지 않아요" : ""}
            </p>
          </div>
          <ConfirmButton
            label="해제"
            subject={subscription.repository}
            question={`${subscription.repository} 알림을 더는 받지 않을까요?`}
            confirmLabel="해제하기"
            busy={removingId === subscription.id}
            busyLabel="해제 중"
            disabled={offline}
            onConfirm={() => onRemove(subscription)}
            testId="github-subscription-remove"
          />
        </li>
      ))}
    </ul>
  );
}
