import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { isDesktop } from "@/lib/tauri";
import { CHIP_CLASS } from "@/features/common/chip";
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
import { SettingsToggleRow, Subsection } from "./SettingsFields";

// Design Read: settings for internal team users on web+Tauri, density 6/10,
// motion 2/10.
//
// Permission copy follows buzz's group (Desktop / request / blocked /
// unsupported) with Korean house sentences. Sound pickers are out of scope.
// denied is OS notification permission inside the Tauri shell, never a browser
// Notification API prompt (`permission.ts`).

export const DESKTOP_NOTIFICATION_ENABLE_LABEL = "알림 켜기";
export const DESKTOP_NOTIFICATION_REQUESTING_LABEL = "요청 중";
export const DESKTOP_NOTIFICATION_GRANTED_LABEL = "켜짐";
export const DESKTOP_NOTIFICATION_GRANTED_DETAIL =
  "이 기기에서 데스크톱 알림을 보낼 수 있습니다.";
export const DESKTOP_NOTIFICATION_DEFAULT_DETAIL =
  "이 앱이 앞에 없을 때 알려 주려면 알림을 켜세요.";
export const DESKTOP_NOTIFICATION_DENIED_MESSAGE =
  "이 앱의 알림이 macOS에서 막혀 있습니다. 시스템 설정 › 알림에서 oort를 허용하세요.";
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
  unsupportedReasonId,
}: {
  permission: DesktopNotificationPermissionView | "loading";
  requesting: boolean;
  onRequest: () => void;
  /** Shared lock reason for the kind toggles when this surface cannot notify. */
  unsupportedReasonId?: string;
}) {
  const grantedRef = useRef<HTMLDivElement>(null);
  const prevPermission = useRef(permission);

  useEffect(() => {
    const prev = prevPermission.current;
    prevPermission.current = permission;
    // The enable button unmounts on grant. Native disabled/unmount drops focus
    // to <body> (SaveButton / ConfirmButton docstring): land on the 켜짐 vessel
    // instead, and let role="status" name the new state.
    if (permission === "granted" && prev === "default") {
      grantedRef.current?.focus({ preventScroll: true });
    }
  }, [permission]);

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
          id={unsupportedReasonId}
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
        <div
          ref={grantedRef}
          tabIndex={-1}
          role="status"
          className="flex min-w-0 items-start gap-2 rounded-sm focus-visible:focus-ring"
          data-testid="desktop-notifications-granted"
        >
          <span
            className={cn(CHIP_CLASS, "bg-ok-soft text-ok")}
            data-testid="desktop-notifications-granted-chip"
          >
            {DESKTOP_NOTIFICATION_GRANTED_LABEL}
          </span>
          <p className="min-w-0 break-keep text-meta text-ink-muted">
            {DESKTOP_NOTIFICATION_GRANTED_DETAIL}
          </p>
        </div>
      ) : (
        <>
          <p className="break-keep text-meta text-ink-muted">
            {DESKTOP_NOTIFICATION_DEFAULT_DETAIL}
          </p>
          {/* InviteSection.tsx:287: 행 안 고유폭 버튼. flex-col stretch 는
              전폭 amber 바가 된다 (taste §8). */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (requesting) return;
                onRequest();
              }}
              aria-busy={requesting || undefined}
              data-testid="desktop-notifications-enable"
            >
              {enableLabel}
            </Button>
          </div>
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
  const requestingRef = useRef(false);
  const kinds = useDesktopNotificationKinds();
  const unsupportedReasonId = useId();
  const kindsLocked = permission === "unsupported";

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    async function refresh() {
      if (requestingRef.current) return;
      const next = await readDesktopNotificationPermission();
      if (!cancelled) setPermission(next);
    }
    void refresh();
    function onFocus() {
      void refresh();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") void refresh();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  async function onRequest() {
    if (requestingRef.current) return;
    requestingRef.current = true;
    setRequesting(true);
    try {
      const next = await requestDesktopNotificationPermission();
      setPermission(next);
    } finally {
      requestingRef.current = false;
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
            unsupportedReasonId={unsupportedReasonId}
          />
        </div>
      </Subsection>

      <Subsection title="종류별">
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
              disabled={kindsLocked}
              describedBy={kindsLocked ? unsupportedReasonId : undefined}
              onToggle={(enabled) => setDesktopNotificationKind(row.id, enabled)}
            />
          ))}
        </div>
      </Subsection>
    </>
  );
}
