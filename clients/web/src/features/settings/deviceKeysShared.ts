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

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The fingerprint a person compares between the phone and this Mac: SHA-256
 * over the 33 compressed key bytes, the first 10 bytes as upper-case hex in five
 * groups of four. The desktop shell's native dialog computes the same value
 * (`device_key/payload.rs` `fingerprint`, shared case `5BAF F89D E7DE 5C1D 7B61`).
 *
 * Lives in the web client, not in core: the phone's export-compliance tripwire
 * (`clients/mobile/__tests__/projectShape.test.ts`) keeps WebCrypto out of every
 * tree the app ships, core included.
 */
export async function deviceKeyFingerprint(publicKeyB64: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", decodeBase64(publicKeyB64))
  );
  const hex = Array.from(digest.slice(0, 10), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}

/** Root rows this app already tried to move on its own (#3103): one Touch ID
 *  prompt per row per app run, never a loop of them (a declined prompt
 *  refetches the list, which would otherwise ask again). Later attempts are
 *  the button. */
export const autoRebindTried = new Set<string>();

/** Test seam: forget the automatic attempts. */
export function resetAutoRebindForTests(): void {
  autoRebindTried.clear();
}
