import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import {
  DEFAULT_NOTIFICATION_RULES,
  fetchNotificationRules,
  putNotificationRules,
  type NotificationRules,
} from "@momo/core/features/settings/notificationRules";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import { cn } from "@/design/lib/cn";
import { SectionShell, Subsection } from "./SettingsFields";

// Design Read: settings for internal team users on web+Tauri, density 6/10,
// motion 2/10.
//
// =============================================================================
// 설정 > 알림 규칙 (ADR-0124 증보 1, W-B2-3). The panel that used to say "규칙을
// 이 화면에서 바꾸는 기능은 아직 없습니다" now writes the two member-global rules
// the notifier judges on: DND and the mention-exception-to-mute switch.
//
// Two facts this surface states out loud, neither guessable from the toggles:
//   1. 규칙은 서버에 하나. It is the same rule on every device, so the copy says
//      so rather than implying a per-device preference (P9).
//   2. 채널 하나만 조용히 = 채널 헤더. Per-channel mute (018) lives in the channel
//      name menu, not here; this panel is workspace-wide. Naming the boundary is
//      how the two surfaces stop being confused for each other.
//
// The switches are the platform checkbox, not a custom control: it already gives
// the space toggle, the accessible name, and a focus ring, and this bundle
// carries no Radix Switch. Each write replaces the whole rule (the server PUT is
// whole-object), applied optimistically so the toggle moves at click speed and
// rolls back if the round trip fails.
// =============================================================================

const LINES = [
  "알림 규칙은 서버에 하나만 있습니다. 기기를 바꿔도 같은 규칙이 적용됩니다.",
  "각 알림에는 왜 왔는지가 함께 기록되고, 인박스에서 그 이유를 볼 수 있습니다.",
];

const CHANNEL_NOTE =
  "채널 하나만 조용히 하려면 그 채널 이름을 눌러 알림 끄기를 고르세요. 이 화면은 워크스페이스 전체에 걸리는 규칙만 다룹니다.";

const OFFLINE_REASON = "연결이 끊겨 지금은 규칙을 바꿀 수 없습니다.";

export function NotificationRulesSection({ offline }: { offline: boolean }) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const queryKey = ["settings", "notification-rules", workspaceId];
  const rules = useQuery({
    queryKey,
    queryFn: () => fetchNotificationRules(workspaceId),
    retry: false,
  });

  const [issue, setIssue] = useState<string | null>(null);
  const offlineReasonId = useId();

  const save = useMutation({
    mutationFn: (next: NotificationRules) =>
      putNotificationRules(workspaceId, next),
    onMutate: async (next) => {
      setIssue(null);
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<NotificationRules>(queryKey);
      client.setQueryData<NotificationRules>(queryKey, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) client.setQueryData(queryKey, context.previous);
      setIssue("규칙을 저장하지 못했습니다. 잠시 후 다시 시도하세요.");
    },
    onSuccess: (saved) => client.setQueryData(queryKey, saved),
  });

  if (rules.isPending) {
    return (
      <SectionShell title="알림 규칙" lines={LINES}>
        <SkeletonRows rows={2} />
      </SectionShell>
    );
  }

  if (rules.isError) {
    return (
      <SectionShell title="알림 규칙" lines={LINES}>
        <InlineBanner
          message="알림 규칙을 불러오지 못했습니다."
          actionLabel="다시 불러오기"
          onAction={() => void rules.refetch()}
          testId="notification-rules-error"
        />
      </SectionShell>
    );
  }

  const current = rules.data ?? DEFAULT_NOTIFICATION_RULES;
  const disabled = offline || save.isPending;

  return (
    <SectionShell title="알림 규칙" lines={LINES}>
      {issue && (
        <InlineBanner
          separator={false}
          message={issue}
          testId="notification-rules-save-error"
        />
      )}

      <div
        className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
        data-testid="notification-rules"
      >
        <RuleToggle
          testId="notification-rules-dnd"
          name="방해 금지"
          description="켜면 이 워크스페이스의 모든 알림을 받지 않습니다. 멘션과 승인 요청도 포함됩니다. 읽지 않은 표시는 그대로 쌓입니다."
          checked={current.dnd}
          disabled={disabled}
          describedBy={offline ? offlineReasonId : undefined}
          onToggle={(dnd) => save.mutate({ ...current, dnd })}
        />
        <RuleToggle
          testId="notification-rules-mention"
          name="음소거한 채널에서도 멘션은 받기"
          description="채널을 음소거해도 나를 멘션한 알림은 옵니다. 방해 금지가 켜져 있으면 멘션도 오지 않습니다."
          checked={current.mentionOverridesMute}
          disabled={disabled}
          describedBy={offline ? offlineReasonId : undefined}
          onToggle={(mentionOverridesMute) =>
            save.mutate({ ...current, mentionOverridesMute })
          }
        />
      </div>

      {/* Both toggles go grey offline, so the reason stands with them: a control
          that greys with no sentence reads as "you may not", which is the wrong
          sentence about a setting this member owns. Written once, pointed at by
          both checkboxes via aria-describedby. */}
      {offline && (
        <p
          id={offlineReasonId}
          className="break-keep text-meta text-ink-muted"
          data-testid="notification-rules-offline"
        >
          {OFFLINE_REASON}
        </p>
      )}

      <Subsection title="채널 하나만 조용히">
        <p className="break-keep text-meta text-ink-muted">{CHANNEL_NOTE}</p>
      </Subsection>
    </SectionShell>
  );
}

function RuleToggle({
  testId,
  name,
  description,
  checked,
  disabled,
  describedBy,
  onToggle,
}: {
  testId: string;
  name: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  /** Id of the shared offline sentence, when offline. */
  describedBy?: string;
  onToggle: (next: boolean) => void;
}) {
  const nameId = `${testId}-name`;
  const descId = `${testId}-desc`;
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-3 border-b border-line p-3 last:border-b-0",
        checked ? "bg-accent-soft" : "hover:bg-surface-hover"
      )}
      data-state={checked ? "on" : "off"}
    >
      {/* The NAME is the checkbox's accessible name; the sentence is its
          description. Kept apart so a screen reader does not run the whole
          paragraph together as one label (EventSubscriptionSection R2 N-R2). */}
      <input
        type="checkbox"
        id={testId}
        checked={checked}
        disabled={disabled}
        aria-labelledby={nameId}
        aria-describedby={describedBy ? `${descId} ${describedBy}` : descId}
        onChange={(event) => onToggle(event.target.checked)}
        className="mt-1 accent-accent focus-visible:focus-ring"
        data-testid={testId}
      />
      <label htmlFor={testId} className="flex min-w-0 cursor-pointer flex-col gap-px">
        <span id={nameId} className="text-body text-ink">
          {name}
        </span>
        <span id={descId} className="break-keep text-meta text-ink-muted">
          {description}
        </span>
      </label>
    </div>
  );
}
