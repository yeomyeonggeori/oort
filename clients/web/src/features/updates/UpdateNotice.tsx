import { useEffect } from "react";
import { InlineBanner } from "@/features/common/States";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { badgeLabel, badgeWorthShowing } from "./model";
import {
  installUpdate,
  registerUpdateNoticeSurface,
  relaunchIntoUpdate,
  useRelaunchCountdown,
  useRelaunchHold,
  useUpdateState,
} from "./store";

// =============================================================================
// 연결 화면의 업데이트 알림 (ADR-0133 P2, MOMO-606).
//
// The sidebar badge lives behind a successful login, and that is exactly the
// wrong place for this channel's most likely reader. The internal alpha guide
// says out loud that "the server is unreachable when the operator is not at
// their desk", so a tester sitting on the connect screen unable to get in is a
// normal state, not an edge case. If the build that fixes their problem can
// only be announced after they get in, the update channel is useless precisely
// when it matters most.
//
// So the same store drives one quiet inline row here, with the same one click.
// No navigation: there is no 설정 to send them to before they are signed in.
// =============================================================================

export function UpdateNotice() {
  const state = useUpdateState();
  const countdown = useRelaunchCountdown();
  const hold = useRelaunchHold();
  const formatMessage = useFormatMessage();
  // 다시 시작 상태를 보이는 곳이다: 마운트돼 있으면 저장소가 카운트다운을 시작할 수 있다(수리 3회차).
  useEffect(() => registerUpdateNoticeSurface(), []);
  if (!badgeWorthShowing(state)) return null;

  // 이 맥의 작업이 끝나기를 기다리는 동안은 「곧 다시 시작」이 아니다(#5661).
  const holding = state.kind === "installed" && hold !== null && countdown === null;
  // 자동 다시 시작이 멈췄다(「지금 말고」·다시 시작 실패): 「곧 다시 시작」이 아니다(수리 2회차).
  const stopped = state.kind === "installed" && hold === null && countdown === null;
  const label = holding
    ? formatMessage("settings.updates.holdTitle")
    : stopped
      ? formatMessage("settings.updates.stoppedSentence")
      : badgeLabel(state);
  if (!label) return null;

  const action =
    state.kind === "available"
      ? { label: "지금 업데이트", run: () => void installUpdate() }
      : state.kind === "installed"
        ? {
            label: holding ? formatMessage("settings.updates.restartNow") : "지금 다시 시작",
            run: () => void relaunchIntoUpdate(),
          }
        : null;

  return (
    <InlineBanner
      tone="neutral"
      message={label}
      actionLabel={action?.label}
      onAction={action?.run}
      testId="connect-update-notice"
    />
  );
}
