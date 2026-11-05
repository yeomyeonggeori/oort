import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageKey } from "@momo/core/i18n";
import {
  fetchPhoneDelay,
  hidesPhoneDelayRow,
  PHONE_DELAY_OPTIONS,
  savePhoneDelay,
  type PhoneDelaySecs,
} from "@momo/core/features/settings/notificationPrefs";
import { useSession } from "@/app/session";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { SegmentedControl, type SegmentOption } from "@/design/ui/segmented-control";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { phoneDelayQueryKey, phoneDelayWriteKey } from "./notificationRulesKey";
import { SettingsRow } from "./shell/SettingsRow";
import { CardBody } from "./workTierPolicy";

// Design Read: settings for internal team users on web+Tauri, density 6/10, motion 2/10.
//
// =============================================================================
// 설정 › 알림 › 「데스크탑을 쓰는 동안 폰 알림 늦추기」 (ADR-0206 D4·D13, #4508 N12).
//
// 이 창이 앞에 있고 5분 안에 입력이 있으면 앱이 「지금 쓰는 중」 신호를 보낸다(`features/presence/
// ActivityBeat`). 서버는 그동안 이 사람의 폰 푸시(멘션·DM·스레드 답글)를 여기서 고른 시간만큼 늦추고, 그 사이에
// 이 컴퓨터에서 읽으면 폰 푸시를 보내지 않는다. 값은 서버의 닫힌 집합 {끔, 60초, 300초}이고 300초가 상한이다.
//
// 서버에 하나만 있는 값이라(모든 기기에서 같다) 이 칸은 로컬 저장소가 아니라 `PATCH notification-prefs` 로
// **이 필드만** 쓴다. 고르는 즉시 저장이고 저장 버튼은 없다(`SegmentedControl` 계약). 낙관 갱신 뒤 쓰기가
// 실패하면 이전 값으로 돌리고 한 줄로 말한다.
//
// 쓰는 동안 칸을 잠그지 않는다: 이 칸은 라디오 그룹이라 방향키가 한 칸 옮길 때마다 값이 골라지고, 잠그면(`fieldset
// disabled`) 첫 방향키에서 포커스가 사라져 「끔」까지 두 칸을 키보드로 갈 수 없다. 대신 같은 칸의 쓰기를 한 줄로 세워
// (`scope`) 고른 순서대로 내보내고, 화면은 늘 마지막으로 고른 값이며, 마지막 쓰기가 끝날 때만 서버의 답을 받는다.
//
// 네 가지 상태:
//   불러오는 중  높이를 지키는 막대 한 줄.
//   실패        무엇이 안 됐는지 한 줄 + 다시 시도(404·405·403 은 실패가 아니라 칸을 숨긴다).
//   오프라인     컨트롤을 잠그고 규칙 카드가 말하는 이유를 `aria-describedby` 로 가리킨다.
//   옛 서버      404·405 는 칸 자체를 그리지 않는다(수용 기준 38): 눌러도 안 되는 컨트롤을 내보내지 않는다.
// =============================================================================

/** 서버 값(초) → 고르는 칸의 문구 키. 값 하나에 칸 하나다. */
const OPTION_COPY = {
  0: "settings.notifications.phoneDelayOff",
  60: "settings.notifications.phoneDelayOneMinute",
  300: "settings.notifications.phoneDelayFiveMinutes",
} as const satisfies Record<PhoneDelaySecs, MessageKey>;

type Choice = `${PhoneDelaySecs}`;

const toChoice = (secs: PhoneDelaySecs): Choice => `${secs}`;
const fromChoice = (choice: Choice): PhoneDelaySecs =>
  PHONE_DELAY_OPTIONS.find((secs) => toChoice(secs) === choice) ?? PHONE_DELAY_OPTIONS[0];

export function PhoneDelayRow({
  offline,
  offlineReasonId,
}: {
  offline: boolean;
  /** 규칙 카드가 오프라인 이유를 말하는 문장의 id. 컨트롤이 잠긴 이유로 가리킨다. */
  offlineReasonId: string;
}) {
  const { workspaceId } = useSession();
  const formatMessage = useFormatMessage();
  const client = useQueryClient();
  const queryKey = phoneDelayQueryKey(workspaceId);
  const descriptionId = useId();

  const delay = useQuery({
    queryKey,
    queryFn: () => fetchPhoneDelay(workspaceId),
    retry: false,
  });

  const writeKey = phoneDelayWriteKey(workspaceId);
  const save = useMutation({
    mutationKey: writeKey,
    // 같은 칸의 쓰기는 한 줄로 선다. `onMutate` 의 낙관 갱신은 줄을 서기 전에 바로 일어난다.
    scope: { id: writeKey.join(":") },
    mutationFn: (secs: PhoneDelaySecs) => savePhoneDelay(workspaceId, secs),
    onMutate: async (secs) => {
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<PhoneDelaySecs>(queryKey);
      client.setQueryData<PhoneDelaySecs>(queryKey, secs);
      return { previous };
    },
    onSuccess: (saved) => {
      // 뒤에 줄 선 쓰기가 있으면 화면은 이미 마지막으로 고른 값이다: 앞 쓰기의 답으로 덮어 되돌리지 않는다.
      if (client.isMutating({ mutationKey: writeKey }) === 1) {
        client.setQueryData<PhoneDelaySecs>(queryKey, saved);
      }
    },
    onError: (_error, _secs, context) => {
      // 뒤에 줄 선 쓰기가 있으면 마지막 값은 그 쓰기가 맡는다: 앞 쓰기의 실패로 화면을 되돌리지 않는다.
      if (client.isMutating({ mutationKey: writeKey }) !== 1) return;
      if (context?.previous !== undefined) {
        client.setQueryData<PhoneDelaySecs>(queryKey, context.previous);
      }
      // 앞 쓰기가 섞여 있으면 되돌린 값이 서버와 다를 수 있다: 서버의 값을 다시 읽어 맞춘다.
      void client.invalidateQueries({ queryKey });
    },
  });

  // 옛 서버(404·405)와 이 계정에 닫힌 설정(403)은 고칠 수 있는 실패가 아니라 열 수 없는 칸이다.
  if (delay.isError && hidesPhoneDelayRow(delay.error)) return null;

  // 아는 값이 아직 없을 때만 막대·실패 줄이다. 값이 있는 채 다시 읽기가 실패하면(저장 실패 뒤의 맞추기·창 포커스 복귀) 마지막으로 아는 값을 그대로 보인다.
  const value = delay.data;
  if (value === undefined) {
    if (delay.isError) {
      return (
        <CardBody>
          <InlineBanner
            separator={false}
            className="px-0"
            message={formatMessage("settings.notifications.phoneDelayLoadFailed")}
            actionLabel={formatMessage("settings.notifications.phoneDelayRetry")}
            onAction={() => void delay.refetch()}
            testId="phone-delay-error"
          />
        </CardBody>
      );
    }
    return (
      <CardBody>
        <div data-testid="phone-delay-loading">
          <Skeleton ready={false} rows={1} />
        </div>
      </CardBody>
    );
  }

  const options: SegmentOption<Choice>[] = PHONE_DELAY_OPTIONS.map((secs) => ({
    value: toChoice(secs),
    label: formatMessage(OPTION_COPY[secs]),
  }));
  const label = formatMessage("settings.notifications.phoneDelayLabel");

  return (
    <>
      <SettingsRow
        label={label}
        description={formatMessage("settings.notifications.phoneDelayDescription")}
        descriptionId={descriptionId}
        testId="phone-delay-row"
      >
        <SegmentedControl
          legend={label}
          name="phone-delay"
          options={options}
          value={toChoice(value)}
          disabled={offline}
          describedBy={offline ? `${descriptionId} ${offlineReasonId}` : descriptionId}
          onValueChange={(choice) => save.mutate(fromChoice(choice))}
          testId="phone-delay-choice"
        />
      </SettingsRow>
      {save.isError ? (
        <CardBody>
          <InlineBanner
            separator={false}
            className="px-0"
            message={formatMessage("settings.notifications.phoneDelaySaveFailed")}
            testId="phone-delay-save-error"
          />
        </CardBody>
      ) : null}
    </>
  );
}
