import { InlineBanner } from "@/features/common/States";
import { badgeLabel, badgeWorthShowing } from "./model";
import { installUpdate, relaunchIntoUpdate, useUpdateState } from "./store";

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
  if (!badgeWorthShowing(state)) return null;

  const label = badgeLabel(state);
  if (!label) return null;

  const action =
    state.kind === "available"
      ? { label: "지금 업데이트", run: () => void installUpdate() }
      : state.kind === "installed"
        ? { label: "지금 재시작", run: () => void relaunchIntoUpdate() }
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
