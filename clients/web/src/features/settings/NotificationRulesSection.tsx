import { useId, useRef, useState } from "react";
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
import {
  PAUSE_ACTIVE_NOTE,
  PAUSE_UNTIL_CHANGE_ACTION,
  PAUSE_UNTIL_NONE_ACTION_LABEL,
  pauseUntilLabel,
} from "@momo/core/features/presence/pauseUntil";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { DesktopNotificationGroup } from "./DesktopNotificationGroup";
import { Button } from "@/design/ui/button";
import { Switch } from "@/design/ui/switch";
import { notificationRulesQueryKey } from "./notificationRulesKey";
import { PauseUntilDialog } from "./PauseUntilDialog";
import { useRecheckWhenElapsed } from "./useRecheckWhenElapsed";
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
//
// 알림 일시 중지는 **기한을 고르고 나서야 켜진다** (ADR-0204 D2, #2899). 스위치를 켜려
// 하면 쓰지 않고 `PauseUntilDialog` 가 열리며, 확인하면 `{dnd: true, dndUntilMs}` 를 보낸다.
// 끄는 쪽은 그대로 `{dnd: false}` 다. 켜져 있는 동안은 스위치 아래 한 줄이 기한을 말하고
// (기한 없는 행은 「기한 없음 · 기한 정하기」), 그 줄의 단추가 같은 다이얼로그를 연다.
// 방해 금지는 여기서 쓰지 않는다: 그 기한은 사이드바 프로필 메뉴가 `PUT /presence` 로
// 걸고, 서버가 이 규칙을 묶어 켠다(그래서 그 쓰기 뒤 이 질의가 무효화된다).
// =============================================================================

const CHANNEL_NOTE =
  "채널 하나만 조용히 하려면 그 채널 이름을 눌러 알림 끄기를 고르세요. 이 화면은 워크스페이스 전체에 걸리는 규칙만 다뤄요.";

const OFFLINE_REASON = "연결이 끊겨 지금은 규칙을 바꿀 수 없어요.";

// 서버는 「활성 사람 멤버」만 이 규칙을 읽고 쓰게 한다(notification_rules.rs). 403은 운영자 권한이
// 아니라 에이전트 계정이거나 멤버가 아니라는 뜻이라 「서버 운영자에게 문의」가 아니라 그 사실을 말한다.
const FORBIDDEN_COPY =
  "사람 멤버만 알림 규칙을 정할 수 있어요. 에이전트 계정이거나 이 워크스페이스의 멤버가 아니면 쓸 수 없어요. 멤버라면 워크스페이스에 다시 참여한 뒤 열어 보세요.";

function loadFailureCopy(error: unknown): { message: string; retry: boolean } {
  if (error instanceof ApiError && error.status === 403) {
    return { message: FORBIDDEN_COPY, retry: false };
  }
  return { message: "알림 규칙을 불러오지 못했어요.", retry: true };
}

export function NotificationRulesSection({ offline }: { offline: boolean }) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const queryKey = notificationRulesQueryKey(workspaceId);
  const rules = useQuery({
    queryKey,
    queryFn: () => fetchNotificationRules(workspaceId),
    retry: false,
  });

  const [issue, setIssue] = useState<string | null>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  const pauseOpenerRef = useRef<HTMLElement | null>(null);
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
        client.setQueryData<NotificationRules>(queryKey, paintRules(previous, patch));
      }
      return { previous };
    },
    onError: (_error, patch, context) => {
      if (context?.previous) client.setQueryData(queryKey, context.previous);
      // 기한을 골라 거는 쓰기가 실패하면 다이얼로그가 그 이유를 말한다. 이 배너는 모달 뒤에
      // 가려 있어서 거기서 말하면 사람이 못 읽는다.
      if (patch.dndUntilMs === undefined) {
        setIssue("규칙을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
      }
    },
    onSuccess: (saved) => client.setQueryData(queryKey, saved),
  });

  const current = rules.data ?? DEFAULT_NOTIFICATION_RULES;
  // 일시 중지의 기한이 지나면 서버에 다시 묻는다(스위치가 서버의 새 답을 그린다, #2899 H3).
  useRecheckWhenElapsed(workspaceId, current.dnd ? current.dndUntilMs : undefined);
  const pauseSaveFailed = save.isError && save.variables?.dndUntilMs !== undefined;

  // 포커스를 돌려줄 자리는 호출한 단추다. 클릭이 단추에 포커스를 주지 않는 WebKit(데스크탑
  // 셸)에서도 돌아갈 곳이 있도록 `document.activeElement` 추정에 맡기지 않고 넘긴다.
  const openPauseDialog = (opener: HTMLElement | null) => {
    pauseOpenerRef.current = opener;
    save.reset();
    setPauseOpen(true);
  };
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
            {failure.retry ? (
            <InlineBanner
              message={failure.message}
              actionLabel="다시 불러오기"
              onAction={() => void rules.refetch()}
              separator={false}
              className="px-0"
              testId="notification-rules-error"
            />
            ) : (
              // 403은 실패가 아니라 이 계정에 닫힌 상태다: 경고색이 아니라 안내 톤으로 말한다.
              <p
                className="break-keep text-body text-ink-muted"
                role="status"
                data-testid="notification-rules-error"
              >
                {failure.message}
              </p>
            )}
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
                  onCheckedChange={(dnd) => {
                    // 켜기는 기한을 고르고 나서다: 쓰지 않고 다이얼로그를 연다. 스위치는
                    // 확인이 서버에 닿을 때까지 꺼진 채다. 끄기는 기한이 필요 없다.
                    if (dnd) {
                      openPauseDialog(
                        document.querySelector<HTMLElement>(
                          '[data-testid="notification-rules-dnd"]'
                        )
                      );
                      return;
                    }
                    save.mutate({ dnd: false });
                  }}
                />
              </SettingsRow>
              {current.dnd ? (
                <SettingsRow
                  label={
                    current.dndUntilMs !== undefined
                      ? pauseUntilLabel(current.dndUntilMs, Date.now())
                      : PAUSE_ACTIVE_NOTE
                  }
                  description={
                    current.dndUntilMs !== undefined ? PAUSE_ACTIVE_NOTE : undefined
                  }
                  plain={current.dndUntilMs === undefined}
                  testId="notification-rules-until"
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="tap-target"
                    disabled={disabled}
                    data-testid="notification-rules-until-edit"
                    onClick={(event) => openPauseDialog(event.currentTarget)}
                  >
                    {current.dndUntilMs !== undefined
                      ? PAUSE_UNTIL_CHANGE_ACTION
                      : PAUSE_UNTIL_NONE_ACTION_LABEL}
                  </Button>
                </SettingsRow>
              ) : null}
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

      <PauseUntilDialog
        kind="pause"
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        opener={pauseOpenerRef.current}
        running={current.dnd}
        currentUntilMs={current.dnd ? current.dndUntilMs : undefined}
        pending={save.isPending}
        failure={pauseSaveFailed ? PAUSE_SAVE_FAILED : null}
        offline={offline}
        onConfirm={(dndUntilMs) =>
          save.mutate(
            { dnd: true, dndUntilMs },
            { onSuccess: () => setPauseOpen(false) }
          )
        }
      />
    </div>
  );
}

const PAUSE_SAVE_FAILED = "알림 일시 중지를 걸지 못했어요. 잠시 후 다시 시도하세요.";

/**
 * 낙관 갱신: 쓰기가 닿기 전에 스위치와 기한 줄이 먼저 움직이게 한다. 기한은 켜져 있을 때만
 * 있다. 끄면 지우고, `null`(기한 없음)이어도 지우고, 숫자면 그 숫자다. 예전에는 기한을
 * 통째로 떼어 냈는데, 그러면 기한을 걸어도 서버 답이 오기 전까지 기한 줄이 비어 보였다.
 */
function paintRules(
  previous: NotificationRules,
  patch: NotificationRulesPatch
): NotificationRules {
  const next: NotificationRules = { ...previous };
  if (patch.dnd !== undefined) next.dnd = patch.dnd;
  if (patch.mentionOverridesMute !== undefined) {
    next.mentionOverridesMute = patch.mentionOverridesMute;
  }
  if (!next.dnd || patch.dndUntilMs === null) {
    delete next.dndUntilMs;
  } else if (patch.dndUntilMs !== undefined) {
    next.dndUntilMs = patch.dndUntilMs;
  }
  return next;
}
