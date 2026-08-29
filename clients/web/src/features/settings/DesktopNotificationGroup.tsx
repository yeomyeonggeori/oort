import { useEffect, useState } from "react";
import { Button } from "@/design/ui/button";
import { isDesktop } from "@/lib/tauri";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import type { NotifyKind } from "@momo/core/features/notifications/model";
import {
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  type DesktopNotificationPermissionView,
} from "@/features/notifications/permission";
import {
  setDesktopNotificationKind,
  useDesktopNotificationKinds,
} from "@/features/notifications/preference";
import { StatusChip, SettingsToggleRow, Subsection } from "./SettingsFields";

// Design Read: settings for internal team users on web+Tauri, density 6/10,
// motion 2/10.
//
// Permission copy follows buzz's group (Desktop / request / blocked /
// unsupported) with Korean house sentences. Sound pickers are out of scope.

export const DESKTOP_NOTIFICATION_ENABLE_LABEL = "알림 켜기";
export const DESKTOP_NOTIFICATION_REQUESTING_LABEL = "요청 중";
export const DESKTOP_NOTIFICATION_GRANTED_LABEL = "켜짐";
export const DESKTOP_NOTIFICATION_GRANTED_DETAIL =
  "이 기기에서 데스크톱 알림을 보낼 수 있습니다.";
export const DESKTOP_NOTIFICATION_DEFAULT_DETAIL =
  "새 멘션과 승인 요청이 오면 이 기기 밖으로 알리려면 알림을 켜세요.";
export const DESKTOP_NOTIFICATION_DENIED_MESSAGE =
  "알림이 브라우저에서 막혀 있습니다. 사이트 설정에서 알림을 허용한 다음 이 페이지를 새로고침하세요.";
export const DESKTOP_NOTIFICATION_UNSUPPORTED_MESSAGE =
  "이 화면에서는 데스크톱 알림을 쓸 수 없습니다. 데스크톱 앱을 쓰면 알림이 옵니다.";

export const DESKTOP_NOTIFICATION_KIND_ROWS: ReadonlyArray<{
  id: NotifyKind;
  name: string;
  description: string;
}> = [
  {
    id: "mention",
    name: "멘션",
    description: "나를 멘션한 메시지.",
  },
  {
    id: "approval",
    name: "승인 요청",
    description: "내 결정이 필요한 승인 요청.",
  },
];

export function DesktopNotificationPermissionPanel({
  permission,
  requesting,
  onRequest,
}: {
  permission: DesktopNotificationPermissionView | "loading";
  requesting: boolean;
  onRequest: () => void;
}) {
  if (permission === "loading") {
    return (
      <div data-testid="desktop-notifications-permission" data-state="loading">
        <SkeletonRows rows={1} className="p-0" />
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div
        className="overflow-hidden rounded-md border border-line"
        data-testid="desktop-notifications-permission"
        data-state="denied"
      >
        <InlineBanner
          separator={false}
          message={DESKTOP_NOTIFICATION_DENIED_MESSAGE}
          testId="desktop-notifications-denied"
        />
      </div>
    );
  }

  if (permission === "unsupported") {
    return (
      <div
        className="overflow-hidden rounded-md border border-line p-3"
        data-testid="desktop-notifications-permission"
        data-state="unsupported"
      >
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="desktop-notifications-unsupported"
        >
          {DESKTOP_NOTIFICATION_UNSUPPORTED_MESSAGE}
        </p>
      </div>
    );
  }

  const enableLabel = requesting
    ? DESKTOP_NOTIFICATION_REQUESTING_LABEL
    : DESKTOP_NOTIFICATION_ENABLE_LABEL;

  return (
    <div
      className="flex min-w-0 flex-col gap-3 overflow-hidden rounded-md border border-line p-3"
      data-testid="desktop-notifications-permission"
      data-state={permission}
    >
      {permission === "granted" ? (
        <div className="flex min-w-0 items-start gap-2">
          <StatusChip tone="ok">{DESKTOP_NOTIFICATION_GRANTED_LABEL}</StatusChip>
          <p className="min-w-0 break-keep text-meta text-ink-muted">
            {DESKTOP_NOTIFICATION_GRANTED_DETAIL}
          </p>
        </div>
      ) : (
        <>
          <p className="break-keep text-meta text-ink-muted">
            {DESKTOP_NOTIFICATION_DEFAULT_DETAIL}
          </p>
          <Button
            type="button"
            onClick={() => {
              if (requesting) return;
              onRequest();
            }}
            aria-busy={requesting || undefined}
            data-testid="desktop-notifications-enable"
          >
            {enableLabel}
          </Button>
        </>
      )}
    </div>
  );
}

export function DesktopNotificationGroup() {
  const [permission, setPermission] = useState<
    DesktopNotificationPermissionView | "loading"
  >(() => (isDesktop() ? "loading" : "unsupported"));
  const [requesting, setRequesting] = useState(false);
  const kinds = useDesktopNotificationKinds();

  useEffect(() => {
    let cancelled = false;
    void readDesktopNotificationPermission().then((next) => {
      if (!cancelled) setPermission(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onRequest() {
    if (requesting) return;
    setRequesting(true);
    try {
      const next = await requestDesktopNotificationPermission();
      setPermission(next);
    } finally {
      setRequesting(false);
    }
  }

  return (
    <>
      <Subsection
        title="이 기기 알림"
        lines={[
          "데스크톱 알림은 이 앱이 앞에 없을 때 멘션과 승인 요청을 알려 줍니다.",
        ]}
      >
        <div data-testid="desktop-notifications-permission-host">
          <DesktopNotificationPermissionPanel
            permission={permission}
            requesting={requesting}
            onRequest={() => void onRequest()}
          />
        </div>
      </Subsection>

      <Subsection
        title="종류별"
        lines={[
          "방해 금지와 멘션 예외는 서버에 하나만 있는 규칙입니다. 아래 종류를 끄는 선택은 이 기기에만 저장됩니다.",
        ]}
      >
        <div
          className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
          data-testid="desktop-notification-kinds"
        >
          {DESKTOP_NOTIFICATION_KIND_ROWS.map((row) => (
            <SettingsToggleRow
              key={row.id}
              testId={`desktop-notification-kind-${row.id}`}
              name={row.name}
              description={row.description}
              checked={kinds[row.id]}
              onToggle={(enabled) => setDesktopNotificationKind(row.id, enabled)}
            />
          ))}
        </div>
      </Subsection>
    </>
  );
}
