import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import {
  DEFAULT_NOTIFICATION_RULES,
  fetchNotificationRules,
  MENTION_OVERRIDES_MUTE_DESCRIPTION,
  NOTIFICATION_PAUSE_DESCRIPTION,
  NOTIFICATION_PAUSE_LABEL,
  NOTIFICATION_RULES_SERVER_NOTE,
  patchNotificationRules,
  type NotificationRules,
  type NotificationRulesPatch,
} from "@momo/core/features/settings/notificationRules";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { DesktopNotificationGroup } from "./DesktopNotificationGroup";
import { Switch } from "@/design/ui/switch";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";

// Design Read: settings for internal team users on web+Tauri, density 6/10,
// motion 2/10.
//
// =============================================================================
// 설정 > 알림 규칙 (ADR-0124 증보 1, W-B2-3). The panel that used to say "규칙을
// 이 화면에서 바꾸는 기능은 아직 없습니다" now writes the two member-global rules
// the notifier judges on: DND and the mention-exception-to-mute switch.
//
// Three facts this surface states out loud, none guessable from the toggles:
//   1. 규칙은 서버에 하나. DND and the mention exception are the same on every
//      device, so the copy says so rather than implying a per-device preference.
//   2. 종류별 끔은 이 기기. Mention/approval banners are a local preference
//      (`momo.web.notifications.v1`); the fire path consumes them.
//   3. 채널 하나만 조용히 = 채널 헤더. Per-channel mute (018) lives in the channel
//      name menu, not here; this panel is workspace-wide.
//
// 설정 > 알림 (#3578 S5a): 두 카드. 「내 알림 규칙」은 서버 규칙(모든 기기에서 같다),
// 「이 기기 알림」은 이 기기 로컬 선택이다(DesktopNotificationGroup). 스위치는 `design/ui/Switch`
// (네이티브 `button role="switch"`)다. Each write names only the switch it changed (PATCH,
// #3042): the phone writes the pause from its profile sheet, and a whole-object
// PUT of this panel's last read would erase whatever it changed since. Applied
// optimistically so the toggle moves at click speed, rolled back if the round
// trip fails, and replaced by the server's merged answer when it lands.
// =============================================================================

const CHANNEL_NOTE =
  "채널 하나만 조용히 하려면 그 채널 이름을 눌러 알림 끄기를 고르세요. 이 화면은 워크스페이스 전체에 걸리는 규칙만 다뤄요.";

const OFFLINE_REASON = "연결이 끊겨 지금은 규칙을 바꿀 수 없어요.";

// 서버는 「활성 사람 멤버」만 이 규칙을 읽고 쓰게 한다(notification_rules.rs). 403은 운영자 권한이
// 아니라 에이전트 계정이거나 멤버가 아니라는 뜻이라 「서버 운영자에게 문의」가 아니라 그 사실을 말한다.
const FORBIDDEN_COPY = "사람 멤버만 알림 규칙을 정할 수 있어요.";

function loadFailureCopy(error: unknown): { message: string; retry: boolean } {
  if (error instanceof ApiError && error.status === 403) {
    return { message: FORBIDDEN_COPY, retry: false };
  }
  return { message: "알림 규칙을 불러오지 못했어요.", retry: true };
}

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
  const dndIds = { label: useId(), desc: useId() };
  const mentionIds = { label: useId(), desc: useId() };

  const save = useMutation({
    mutationFn: (patch: NotificationRulesPatch) =>
      patchNotificationRules(workspaceId, patch),
    onMutate: async (patch) => {
      setIssue(null);
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<NotificationRules>(queryKey);
      if (previous) {
        const { dndUntilMs: _until, ...fields } = patch;
        client.setQueryData<NotificationRules>(queryKey, { ...previous, ...fields });
      }
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) client.setQueryData(queryKey, context.previous);
      setIssue("규칙을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
    },
    onSuccess: (saved) => client.setQueryData(queryKey, saved),
  });

  const current = rules.data ?? DEFAULT_NOTIFICATION_RULES;
  const disabled = offline || save.isPending;
  const failure = rules.isError ? loadFailureCopy(rules.error) : null;
  const describedBy = (descId: string) =>
    offline ? `${descId} ${offlineReasonId}` : descId;

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="notifications-page">
      <SettingsSection
        title="내 알림 규칙"
        description={NOTIFICATION_RULES_SERVER_NOTE}
        testId="notification-rules-section"
      >
        {rules.isPending ? (
          <CardBody>
            <Skeleton ready={false} rows={2} />
          </CardBody>
        ) : failure ? (
          <CardBody>
            <InlineBanner
              message={failure.message}
              actionLabel={failure.retry ? "다시 불러오기" : undefined}
              onAction={failure.retry ? () => void rules.refetch() : undefined}
              separator={false}
              className="px-0"
              testId="notification-rules-error"
            />
          </CardBody>
        ) : (
          <>
            {issue && (
              <CardBody>
                <InlineBanner
                  separator={false}
                  className="px-0"
                  message={issue}
                  testId="notification-rules-save-error"
                />
              </CardBody>
            )}
            <div className="flex min-w-0 flex-col divide-y divide-line" data-testid="notification-rules">
              <SettingsRow
                label={NOTIFICATION_PAUSE_LABEL}
                description={NOTIFICATION_PAUSE_DESCRIPTION}
                labelId={dndIds.label}
                descriptionId={dndIds.desc}
                keep
              >
                <Switch
                  testId="notification-rules-dnd"
                  checked={current.dnd}
                  disabled={disabled}
                  labelledBy={dndIds.label}
                  describedBy={describedBy(dndIds.desc)}
                  onCheckedChange={(dnd) => save.mutate({ dnd })}
                />
              </SettingsRow>
              <SettingsRow
                label="알림을 끈 채널에서도 멘션은 받기"
                description={MENTION_OVERRIDES_MUTE_DESCRIPTION}
                labelId={mentionIds.label}
                descriptionId={mentionIds.desc}
                keep
              >
                <Switch
                  testId="notification-rules-mention"
                  checked={current.mentionOverridesMute}
                  disabled={disabled}
                  labelledBy={mentionIds.label}
                  describedBy={describedBy(mentionIds.desc)}
                  onCheckedChange={(mentionOverridesMute) =>
                    save.mutate({ mentionOverridesMute })
                  }
                />
              </SettingsRow>
            </div>
            {/* 두 스위치가 오프라인에서 함께 회색이 되므로 이유를 한 문장으로 말한다. 설명 줄과
                함께 두 스위치가 aria-describedby로 가리킨다. */}
            {offline && (
              <CardBody>
                <p
                  id={offlineReasonId}
                  className="break-keep text-meta text-ink-muted"
                  data-testid="notification-rules-offline"
                >
                  {OFFLINE_REASON}
                </p>
              </CardBody>
            )}
          </>
        )}
      </SettingsSection>

      <DesktopNotificationGroup />

      <SettingsSection title="채널 하나만 조용히">
        <SettingsRow label="채널 이름 메뉴에서 정해요" description={CHANNEL_NOTE} />
      </SettingsSection>
    </div>
  );
}
