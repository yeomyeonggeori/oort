import type { DesktopHostDelivery } from "@/lib/tauri";

/** The server's device key list for a workspace (settings prefix: reset with it). */
export const DEVICE_KEYS_QUERY_KEY = (workspaceId: string) =>
  ["settings", "device-keys", workspaceId] as const;

/** What the local workd did with a revocation letter, in one sentence (D-7). */
export function hostDeliveryCopy(host: DesktopHostDelivery): string {
  switch (host.state) {
    case "delivered":
      return "이 맥의 작업 호스트에도 바로 알렸습니다.";
    case "notRunning":
      return "이 맥의 작업 호스트가 꺼져 있어 서버를 거쳐 전달됩니다.";
    case "otherHost":
      return "이 맥의 작업 호스트는 다른 워크스페이스 것이라 서버를 거쳐 전달됩니다.";
    case "refused":
      return "이 맥의 작업 호스트가 받지 않았습니다. 서버를 거쳐 전달됩니다.";
  }
}
