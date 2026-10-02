import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { isDesktop } from "@/lib/tauri";
import { CHIP_CLASS } from "@/features/common/chip";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  type DesktopNotificationPermissionView,
} from "@/features/notifications/permission";
import {
  setDesktopNotificationKind,
  useDesktopNotificationKinds,
  type DesktopNotifyKind,
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

/** 독 배지 열의 모습: 수에 들어가는 종류, 세지 않는 종류, 사람이 켜는 종류(DM). */
type DockCell = "counted" | "never" | "dm";
/** 폰 푸시 열은 정보뿐이다(폰 설정은 #3342). */
type PhoneCell = "phone" | "desktop-only" | "soon";

export interface DesktopNotificationKindRow {
  /** 이 기기에 저장되는 스위치. 없으면 OS 알림 열도 「곧 열려요」. */
  id: DesktopNotifyKind | null;
  name: string;
  description: string;
  dock: DockCell;
  phone: PhoneCell;
}

// 종류 × 채널 표(#3339 시안 8번). 기본값은 preference.ts가 갖는다.
export const DESKTOP_NOTIFICATION_KIND_ROWS: ReadonlyArray<DesktopNotificationKindRow> = [
  { id: "approval", name: "승인 필요", description: "에이전트가 허용을 기다려요.", dock: "counted", phone: "phone" },
  { id: "pane-waiting", name: "응답 필요 (이 기기 세션)", description: "로컬 칸이 입력을 기다려요.", dock: "counted", phone: "desktop-only" },
  { id: "mention", name: "멘션", description: "나를 멘션한 메시지예요.", dock: "counted", phone: "phone" },
  { id: "work-mine-done", name: "내 작업 끝남", description: "이 기기에서 돌린 세션이 끝났어요.", dock: "never", phone: "phone" },
  { id: null, name: "팀 작업 끝남", description: "다른 사람의 세션이 끝났어요.", dock: "never", phone: "soon" },
  { id: "dm", name: "새 DM", description: "1:1 대화의 새 글이에요.", dock: "dm", phone: "phone" },
  { id: "reminder", name: "나중에 알림", description: "잡아 둔 메시지 기한이 됐어요. 창이 가려져 있어도 이 기기가 확인해요.", dock: "never", phone: "soon" },
];

const PHONE_CELL_TEXT: Record<PhoneCell, string> = {
  phone: "폰 앱에서 정해요",
  "desktop-only": "데스크탑 전용",
  soon: "곧 열려요",
};

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
        <Skeleton ready={false} rows={1} className="p-0" />
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
          "창이 앞에 있고 그 대상이 화면에 보이면 알리지 않아요. 같은 종류가 연달아 오면 한 묶음으로 보내요. 나중에 알림은 기한이 되면 앱이 앞에 있어도 알려요.",
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

      <Subsection
        title="종류별"
        lines={[
          "앱 안의 배지와 줄 표시는 항상 켜 있어요. 아래는 OS 알림과 독 배지만 정해요.",
        ]}
      >
        <div
          className="min-w-0 overflow-x-auto rounded-md border border-line"
          data-testid="desktop-notification-kinds"
        >
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">알림 종류별 OS 알림, 독 배지, 폰 푸시</caption>
            <thead>
              <tr className="border-b border-line bg-surface-sunken text-meta text-ink-muted">
                <th scope="col" className="p-3 font-normal">종류</th>
                <th scope="col" className="whitespace-nowrap p-3 text-center font-normal">OS 알림</th>
                <th scope="col" className="whitespace-nowrap p-3 text-center font-normal">독 배지</th>
                <th scope="col" className="whitespace-nowrap p-3 text-center font-normal">폰 푸시</th>
              </tr>
            </thead>
            <tbody>
              {DESKTOP_NOTIFICATION_KIND_ROWS.map((row) => {
                const rowKey = row.id ?? "team-work-done";
                return (
                  <tr key={rowKey} className="border-b border-line last:border-b-0">
                    <th scope="row" className="min-w-0 p-3 align-top font-normal">
                      <span className="block text-body text-ink">{row.name}</span>
                      <span className="block break-keep text-meta text-ink-muted">
                        {row.description}
                      </span>
                    </th>
                    <td className="whitespace-nowrap p-3 text-center align-top">
                      {row.id === null ? (
                        <span className="text-meta text-ink-muted">곧 열려요</span>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`${row.name} OS 알림`}
                          checked={kinds[row.id]}
                          disabled={kindsLocked}
                          aria-describedby={kindsLocked ? unsupportedReasonId : undefined}
                          onChange={(event) =>
                            setDesktopNotificationKind(row.id as DesktopNotifyKind, event.target.checked)
                          }
                          className="mt-1 accent-accent press focus-visible:focus-ring"
                          data-testid={`desktop-notification-kind-${row.id}`}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3 text-center align-top">
                      {row.dock === "dm" ? (
                        <input
                          type="checkbox"
                          aria-label={`${row.name} 독 배지`}
                          checked={kinds.dockDm}
                          disabled={kindsLocked || !kinds.dockBadge}
                          aria-describedby={kindsLocked ? unsupportedReasonId : undefined}
                          onChange={(event) => setDesktopNotificationKind("dockDm", event.target.checked)}
                          className="mt-1 accent-accent press focus-visible:focus-ring"
                          data-testid="desktop-notification-dock-dm"
                        />
                      ) : (
                        <span className="text-meta text-ink-muted">
                          {row.dock === "counted" ? "수에 포함" : "세지 않아요"}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3 text-center align-top text-meta text-ink-muted">
                      {PHONE_CELL_TEXT[row.phone]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
          <SettingsToggleRow
            testId="desktop-notification-dock-badge"
            name="독 배지"
            description="나에게 필요한 일(승인, 응답 필요, 안 읽은 멘션)의 수를 독 아이콘에 그려요."
            checked={kinds.dockBadge}
            disabled={kindsLocked}
            describedBy={kindsLocked ? unsupportedReasonId : undefined}
            onToggle={(enabled) => setDesktopNotificationKind("dockBadge", enabled)}
          />
        </div>
      </Subsection>
    </>
  );
}
