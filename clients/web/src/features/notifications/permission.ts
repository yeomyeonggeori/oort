import {
  isDesktop,
  notificationPermission,
  requestNotificationPermission,
  type DesktopNotificationPermission,
} from "@/lib/tauri";
import { readBrowserPermission, requestBrowserPermission } from "./browserNotify";

// =============================================================================
// Desktop notification permission as the settings panel can show it (BF-A4).
//
// Inside the Tauri shell the three Notification-API values are the ones the OS
// returns: granted / default / denied. In a plain browser tab (#3340) they are
// the Notification API's own values, read live and requested only from the
// settings button; `unsupported` is a browser (or webview) without the API.
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
  if (!isDesktop()) return readBrowserPermission();
  return desktopNotificationPermissionView({
    desktop: true,
    native: await notificationPermission(),
  });
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermissionView> {
  if (!isDesktop()) return requestBrowserPermission();
  return desktopNotificationPermissionView({
    desktop: true,
    native: await requestNotificationPermission(),
  });
}
