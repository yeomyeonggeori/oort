import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { isDesktop } from "@/lib/tauri";
import { readBrowserPermission } from "@/features/notifications/browserNotify";
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
import { Switch } from "@/design/ui/switch";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";

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
  "이 기기에서 데스크톱 알림을 보낼 수 있어요.";
export const DESKTOP_NOTIFICATION_DEFAULT_DETAIL =
  "이 앱이 앞에 없을 때 알려 주려면 알림을 켜세요.";
export const DESKTOP_NOTIFICATION_DENIED_MESSAGE =
  "이 앱의 알림이 macOS에서 막혀 있어요. 시스템 설정 › 알림에서 oort를 허용하세요.";
export const DESKTOP_NOTIFICATION_UNSUPPORTED_MESSAGE =
  "이 화면에서는 데스크톱 알림을 쓸 수 없어요. 데스크톱 앱을 쓰면 알림이 와요.";

// 브라우저 탭 문장(#3340). 권한은 이 단추를 누른 뒤에만 묻는다.
export const BROWSER_NOTIFICATION_GRANTED_DETAIL =
  "이 브라우저에서 알림을 보낼 수 있어요. 탭이 가려져 있을 때 알려요.";
export const BROWSER_NOTIFICATION_DEFAULT_DETAIL =
  "탭이 가려져 있을 때 알려 주려면 알림을 켜세요. 누르면 브라우저가 허용 여부를 물어요.";
export const BROWSER_NOTIFICATION_DENIED_MESSAGE =
  "이 브라우저에서 oort의 알림이 막혀 있어요. 주소창 왼쪽의 사이트 설정(자물쇠)에서 알림을 허용한 뒤 이 페이지를 새로 고치세요.";
export const BROWSER_NOTIFICATION_UNSUPPORTED_MESSAGE =
  "이 브라우저는 알림을 지원하지 않아요. 데스크탑 앱이나 최신 브라우저를 쓰세요.";

/** 로컬 칸·기한 확인은 데스크탑 앱만 신호를 갖는다. 브라우저 탭에서는 스위치가 아니라 안내다. */
const DESKTOP_ONLY_KINDS: ReadonlySet<string> = new Set(["pane-waiting", "work-mine-done", "reminder"]);

export type NotificationSurface = "desktop" | "browser";

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
  phone: "곧 열려요",
  "desktop-only": "데스크탑 전용",
  soon: "곧 열려요",
};

export function DesktopNotificationPermissionPanel({
  permission,
  requesting,
  onRequest,
  unsupportedReasonId,
  surface = "desktop",
}: {
  surface?: NotificationSurface;
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
      <CardBody>
        <div data-testid="desktop-notifications-permission" data-state="loading">
          <Skeleton ready={false} rows={1} className="p-0" />
        </div>
      </CardBody>
    );
  }

  if (permission === "denied") {
    return (
      <div data-testid="desktop-notifications-permission" data-state="denied">
        <InlineBanner
          separator={false}
          message={
            surface === "browser"
              ? BROWSER_NOTIFICATION_DENIED_MESSAGE
              : DESKTOP_NOTIFICATION_DENIED_MESSAGE
          }
          testId="desktop-notifications-denied"
        />
      </div>
    );
  }

  if (permission === "unsupported") {
    return (
      <CardBody>
        <div data-testid="desktop-notifications-permission" data-state="unsupported">
          <p
            id={unsupportedReasonId}
            className="break-keep text-meta text-ink-muted"
            data-testid="desktop-notifications-unsupported"
          >
            {surface === "browser"
              ? BROWSER_NOTIFICATION_UNSUPPORTED_MESSAGE
              : DESKTOP_NOTIFICATION_UNSUPPORTED_MESSAGE}
          </p>
        </div>
      </CardBody>
    );
  }

  const enableLabel = requesting
    ? DESKTOP_NOTIFICATION_REQUESTING_LABEL
    : DESKTOP_NOTIFICATION_ENABLE_LABEL;

  return (
    <div data-testid="desktop-notifications-permission" data-state={permission}>
      {permission === "granted" ? (
        <SettingsRow
          label="알림 권한"
          description={
            surface === "browser"
              ? BROWSER_NOTIFICATION_GRANTED_DETAIL
              : DESKTOP_NOTIFICATION_GRANTED_DETAIL
          }
          keep
        >
          <div
            ref={grantedRef}
            tabIndex={-1}
            role="status"
            className="rounded-sm focus-visible:focus-ring"
            data-testid="desktop-notifications-granted"
          >
            <span
              className={cn(CHIP_CLASS, "bg-ok-soft text-ok")}
              data-testid="desktop-notifications-granted-chip"
            >
              {DESKTOP_NOTIFICATION_GRANTED_LABEL}
            </span>
          </div>
        </SettingsRow>
      ) : (
        <SettingsRow
          label="알림 권한"
          description={
            surface === "browser"
              ? BROWSER_NOTIFICATION_DEFAULT_DETAIL
              : DESKTOP_NOTIFICATION_DEFAULT_DETAIL
          }
        >
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
        </SettingsRow>
      )}
    </div>
  );
}

export function DesktopNotificationGroup() {
  const desktop = isDesktop();
  const surface: NotificationSurface = desktop ? "desktop" : "browser";
  // 브라우저는 읽기가 동기라 첫 그림부터 실제 상태다(권한 요청과는 별개).
  const [permission, setPermission] = useState<
    DesktopNotificationPermissionView | "loading"
  >(() => (desktop ? "loading" : readBrowserPermission()));
  const [requesting, setRequesting] = useState(false);
  const requestingRef = useRef(false);
  const kinds = useDesktopNotificationKinds();
  const unsupportedReasonId = useId();
  const dockOffReasonId = useId();
  const dockLabelId = useId();
  const dockDescId = useId();
  const dockDmLabelId = useId();
  const dockDmDescId = useId();
  const kindsLocked = permission === "unsupported";
  const browser = surface === "browser";

  useEffect(() => {
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

  const lockedDescribedBy = kindsLocked ? unsupportedReasonId : undefined;
  const dockCellText = (row: DesktopNotificationKindRow): string => {
    if (!kinds.dockBadge) return "꺼짐";
    if (row.dock === "counted") return "수에 포함";
    if (row.dock === "dm") return kinds.dockDm ? "수에 포함" : "세지 않아요";
    return "세지 않아요";
  };
  // 좁은 카드에서 접힌 열의 내용을 이름 아래 한 줄로 말한다.
  const extraLine = (row: DesktopNotificationKindRow): string => {
    const parts = browser ? [] : [`독 배지 ${dockCellText(row)}`];
    parts.push(`폰 푸시 ${PHONE_CELL_TEXT[row.phone]}`);
    return parts.join(" · ");
  };

  return (
    <>
      <SettingsSection
        title="이 기기 알림"
        description={
          browser
            ? "탭이 앞에 있고 그 대상이 화면에 보이면 알리지 않아요. 같은 종류가 연달아 오면 한 묶음으로 보내요. 이 탭이 열려 있을 때만 와요. 탭 제목의 (숫자)는 알림 설정과 상관없이 항상 켜 있어요. OS 알림을 종류별로 끄는 선택은 이 기기에만 저장돼요."
            : "창이 앞에 있고 그 대상이 화면에 보이면 알리지 않아요. 같은 종류가 연달아 오면 한 묶음으로 보내요. 나중에 알림은 기한이 되면 앱이 앞에 있어도 알려요. OS 알림을 종류별로 끄는 선택은 이 기기에만 저장돼요."
        }
        testId="device-notifications-section"
      >
        <div data-testid="desktop-notifications-permission-host">
          <DesktopNotificationPermissionPanel
            permission={permission}
            requesting={requesting}
            onRequest={() => void onRequest()}
            unsupportedReasonId={unsupportedReasonId}
            surface={surface}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="종류별 알림"
        description={
          browser
            ? "앱 안의 배지와 줄 표시는 항상 켜 있어요. 아래는 이 브라우저의 OS 알림만 정해요."
            : "앱 안의 배지와 줄 표시는 항상 켜 있어요. 아래는 OS 알림과 독 배지만 정해요."
        }
      >
        <div
          className="min-w-0 overflow-x-auto focus-visible:focus-ring"
          data-testid="desktop-notification-kinds"
          role="region"
          aria-label="알림 종류별 설정 표"
          tabIndex={0}
        >
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              {browser ? "알림 종류별 OS 알림, 폰 푸시" : "알림 종류별 OS 알림, 독 배지, 폰 푸시"}
            </caption>
            <thead>
              <tr className="border-b border-line text-meta text-ink-muted">
                <th scope="col" className="min-w-pane-sm px-4 py-3 font-normal">종류</th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 text-center font-normal">OS 알림</th>
                {!browser && (
                  <th scope="col" className="kinds-extra-col whitespace-nowrap px-4 py-3 text-center font-normal">독 배지</th>
                )}
                <th scope="col" className="kinds-extra-col whitespace-nowrap px-4 py-3 text-center font-normal">폰 푸시</th>
              </tr>
            </thead>
            <tbody>
              {DESKTOP_NOTIFICATION_KIND_ROWS.map((row) => {
                const rowKey = row.id ?? "team-work-done";
                return (
                  <tr key={rowKey} className="border-b border-line last:border-b-0">
                    <th scope="row" className="min-w-0 px-4 py-3 align-top font-normal">
                      <span className="block text-body font-semibold text-ink">{row.name}</span>
                      <span className="block break-keep text-meta text-ink-muted">
                        {row.description}
                      </span>
                      <span className="kinds-extra-line block break-keep pt-1 text-meta text-ink-muted">
                        {extraLine(row)}
                      </span>
                    </th>
                    <td className="whitespace-nowrap px-4 py-3 text-center align-top">
                      {row.id === null ? (
                        <span className="text-meta text-ink-muted">연결 전</span>
                      ) : browser && DESKTOP_ONLY_KINDS.has(row.id) ? (
                        <span className="text-meta text-ink-muted">데스크탑 전용</span>
                      ) : (
                        <Switch
                          aria-label={`${row.name} OS 알림`}
                          checked={kinds[row.id]}
                          disabled={kindsLocked}
                          describedBy={lockedDescribedBy}
                          onCheckedChange={(next) =>
                            setDesktopNotificationKind(row.id as DesktopNotifyKind, next)
                          }
                          testId={`desktop-notification-kind-${row.id}`}
                        />
                      )}
                    </td>
                    {!browser && (
                      <td className="kinds-extra-col whitespace-nowrap px-4 py-3 text-center align-top text-meta text-ink-muted">
                        {dockCellText(row)}
                      </td>
                    )}
                    <td className="kinds-extra-col whitespace-nowrap px-4 py-3 text-center align-top text-meta text-ink-muted">
                      {PHONE_CELL_TEXT[row.phone]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      {!browser && (
        <SettingsSection title="독 배지">
          <SettingsRow
            label="독 배지"
            description="나에게 필요한 일(승인, 응답 필요, 안 읽은 멘션)의 수를 독 아이콘에 그려요."
            labelId={dockLabelId}
            descriptionId={dockDescId}
            keep
          >
            <Switch
              testId="desktop-notification-dock-badge"
              checked={kinds.dockBadge}
              disabled={kindsLocked}
              labelledBy={dockLabelId}
              describedBy={kindsLocked ? `${dockDescId} ${unsupportedReasonId}` : dockDescId}
              onCheckedChange={(enabled) => setDesktopNotificationKind("dockBadge", enabled)}
            />
          </SettingsRow>
          <SettingsRow
            label="새 DM도 독 배지에 세기"
            description="1:1 대화의 새 글을 독 배지 수에 더해요. 기본은 꺼짐이에요."
            labelId={dockDmLabelId}
            descriptionId={dockDmDescId}
            keep
          >
            <Switch
              testId="desktop-notification-dock-dm"
              checked={kinds.dockDm}
              disabled={kindsLocked || !kinds.dockBadge}
              labelledBy={dockDmLabelId}
              describedBy={
                kindsLocked
                  ? `${dockDmDescId} ${unsupportedReasonId}`
                  : !kinds.dockBadge
                    ? `${dockDmDescId} ${dockOffReasonId}`
                    : dockDmDescId
              }
              onCheckedChange={(next) => setDesktopNotificationKind("dockDm", next)}
            />
          </SettingsRow>
          {!kinds.dockBadge && (
            <CardBody>
              <p id={dockOffReasonId} className="break-keep text-meta text-ink-muted">
                독 배지가 꺼져 있어서 종류별 독 배지 표시도 모두 쉬어요.
              </p>
            </CardBody>
          )}
        </SettingsSection>
      )}
    </>
  );
}
