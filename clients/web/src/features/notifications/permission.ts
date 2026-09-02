import {
  isDesktop,
  notificationPermission,
  requestNotificationPermission,
  type DesktopNotificationPermission,
} from "@/lib/tauri";

// =============================================================================
// Desktop notification permission as the settings panel can show it (BF-A4).
//
// The rail only fires inside the Tauri shell (`notifyDecision` skip "browser").
// A tab therefore has no permission to request, and the honest state is
// `unsupported` (WKWebView without the shell, a plain browser, a missing API).
// Inside the shell the three Notification-API values are the ones the OS
// returns: granted / default / denied.
// =============================================================================

export type DesktopNotificationPermissionView =
  | DesktopNotificationPermission
  | "unsupported";

export function desktopNotificationPermissionView(input: {
  desktop: boolean;
  native?: DesktopNotificationPermission;
}): DesktopNotificationPermissionView {
  if (!input.desktop) return "unsupported";
  return input.native ?? "denied";
}

export async function readDesktopNotificationPermission(): Promise<DesktopNotificationPermissionView> {
  if (!isDesktop()) return "unsupported";
  return desktopNotificationPermissionView({
    desktop: true,
    native: await notificationPermission(),
  });
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermissionView> {
  if (!isDesktop()) return "unsupported";
  return desktopNotificationPermissionView({
    desktop: true,
    native: await requestNotificationPermission(),
  });
}
