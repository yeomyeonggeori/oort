import { useState } from "react";
import { Button } from "@/design/ui/button";
import { useIsMobileShell } from "@/app/shellNav";
import { installInvite, pwaNotice } from "./model";
import {
  applyUpdate,
  dismissInstallInvite,
  isDesktopShell,
  isIosWebKit,
  promptInstall,
  usePwaState,
} from "./store";

// =============================================================================
// 셸 맨 윗줄에 서는 시스템 알림 한 줄 (goal B10).
//
// 두 가지만 말한다: 홈 화면에 추가할 수 있다는 사실(기기당 한 번), 그리고 새
// 버전이 준비됐다는 사실. 어느 쪽도 표면에 대한 이야기가 아니라 **앱 자체**에
// 대한 이야기라서, 채널이나 인박스 안이 아니라 셸 위에 선다(main.tsx).
//
// States.tsx의 InlineBanner를 쓰지 않는 이유는 모양이 아니라 개수다: 그 배너는
// 액션 하나를 위한 자리이고, 여기는 언제나 "할 것"과 "닫기" 둘이다. 닫을 수 없는
// 안내는 안내가 아니라 벽이므로 닫기는 뺄 수 없고, 공용 배너에 두 번째 액션을
// 가르치면 한 호출자를 위해 여덟 호출자의 모양이 바뀐다. 색·간격·경계는 그대로
// 그 배너의 neutral 톤을 따른다.
// =============================================================================

export function PwaBanner() {
  const { updateReady, canPrompt, inviteSeen, standalone } = usePwaState();
  const phone = useIsMobileShell();
  // 새 버전 알림을 닫는 것은 이 탭에서만이고 저장되지 않는다. 다음 새로고침이면
  // 어차피 새 버전이라 기억할 것이 남지 않는다.
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const invite = installInvite({
    standalone,
    desktopShell: isDesktopShell(),
    phone,
    seen: inviteSeen,
    deferredPrompt: canPrompt,
    ios: isIosWebKit(),
  });

  const notice = pwaNotice({
    updateReady: updateReady && !updateDismissed,
    invite,
  });
  if (!notice) return null;

  if (notice.kind === "update") {
    return (
      <Row
        // 다음에 할 일은 옆의 버튼이 이미 말한다. 한 줄에 같은 말을 두 번 쓰면
        // 폰에서 그 줄이 두 줄이 된다.
        message="새 버전이 준비됐습니다."
        testId="pwa-update-notice"
        onDismiss={() => setUpdateDismissed(true)}
        action={{
          label: "지금 새로고침",
          run: applyUpdate,
          testId: "pwa-update-reload",
        }}
      />
    );
  }

  if (notice.invite === "ios-share") {
    return (
      <Row
        // iOS에서 우리가 대신 눌러 줄 수 있는 버튼은 없다. 그래서 이 줄의 내용은
        // 권유가 아니라 경로다: 어디를 눌러야 하는지 그대로 적는다.
        message="공유 버튼에서 '홈 화면에 추가'를 고르면 주소창 없이 열립니다."
        testId="pwa-install-invite"
        onDismiss={dismissInstallInvite}
      />
    );
  }

  return (
    <Row
      message="홈 화면에 추가하면 주소창 없이 전체 화면으로 열립니다."
      testId="pwa-install-invite"
      onDismiss={dismissInstallInvite}
      action={{
        label: "홈 화면에 추가",
        run: () => void promptInstall(),
        testId: "pwa-install-accept",
      }}
    />
  );
}

/**
 * 한 줄의 모양. 액션은 있을 수도 없을 수도 있고(iOS), 닫기는 언제나 있다.
 *
 * 문장은 `flex-1 min-w-0`으로 남은 폭을 받아 그 안에서 접힌다. 폭을 주지 않으면
 * 390px에서 문장이 제 최대 너비를 주장하며 버튼 묶음을 통째로 아랫줄로 밀어내고,
 * 그 한 줄짜리 안내가 화면의 3분의 1을 가져간다(실측 88px). `flex-wrap`과
 * `ms-auto`는 그래도 못 담을 때의 안전망이다: 그때는 버튼이 아랫줄 오른쪽 끝에
 * 서고, 왼쪽에 홀로 떨어져 매달리지 않는다.
 */
function Row({
  message,
  action,
  onDismiss,
  testId,
}: {
  message: string;
  action?: { label: string; run: () => void; testId: string };
  onDismiss: () => void;
  testId: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex flex-wrap items-center justify-between gap-2 break-keep border-b border-line bg-surface-hover px-4 py-2 text-body text-ink"
    >
      <p className="min-w-0 flex-1 break-words">{message}</p>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        {action && (
          <Button
            variant="outline"
            size="sm"
            data-mobile-tap="primary"
            data-testid={action.testId}
            onClick={action.run}
          >
            {action.label}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          data-mobile-tap="primary"
          data-testid="pwa-notice-dismiss"
          onClick={onDismiss}
        >
          닫기
        </Button>
      </div>
    </div>
  );
}
