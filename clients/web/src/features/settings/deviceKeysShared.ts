import type { DesktopHostDelivery } from "@/lib/tauri";

/** The server's device key list for a workspace (settings prefix: reset with it). */
export const DEVICE_KEYS_QUERY_KEY = (workspaceId: string) =>
  ["settings", "device-keys", workspaceId] as const;

/** What the local workd did with a revocation letter, in one sentence (D-7). */
export function hostDeliveryCopy(host: DesktopHostDelivery): string {
  switch (host.state) {
    case "delivered":
      return "이 맥의 작업 호스트에도 바로 알렸어요.";
    case "notRunning":
      return "이 맥의 작업 호스트가 꺼져 있어서 서버를 거쳐 전달돼요.";
    case "otherHost":
      return "이 맥의 작업 호스트는 다른 워크스페이스 것이라 서버를 거쳐 전달돼요.";
    case "refused":
      return "이 맥의 작업 호스트가 받지 않았어요. 서버를 거쳐 전달돼요.";
  }
}

// ---- what the approve panel says about a waiting phone (#3145) -----------------
//
// The list row's name is whatever the registering sign-in sent — the QR redeem
// name, unchecked by the server — and a key registered by someone holding a
// stolen refresh token carries a name they chose (ADR-0146 증보 2026-09-29
// 「남는 위험: 먼저 등록하는 쪽이 자리를 잡는다」). So the panel shows WHEN it was
// registered and WHERE the name comes from, next to the fingerprint the person
// compares. Both are aids: the fingerprint is what is trusted.

const REGISTERED_AT = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** 「9월 29일 오후 2:03 (12분 전)」. */
export function registeredAtCopy(createdAtMs: number, nowMs: number): string {
  const ago = Math.max(0, nowMs - createdAtMs);
  const minutes = Math.floor(ago / 60_000);
  const relative =
    minutes < 1
      ? "방금"
      : minutes < 60
        ? `${minutes}분 전`
        : minutes < 60 * 24
          ? `${Math.floor(minutes / 60)}시간 전`
          : `${Math.floor(minutes / (60 * 24))}일 전`;
  return `${REGISTERED_AT.format(new Date(createdAtMs))} (${relative})`;
}

export type PhoneNameOrigin = "matchesLink" | "notInLinks" | "unknown";

/**
 * Whether a waiting phone's name is one the linked-device list also carries
 * (the QR redeem records the same name: `DeviceLinkDevice.name`). `undefined`
 * list = not loaded: say nothing more than that the name is the phone's own.
 */
export function phoneNameOrigin(
  key: { label: string },
  linked: readonly { label: string; platform: string }[] | undefined
): PhoneNameOrigin {
  if (linked === undefined) return "unknown";
  const same = linked.some((device) => {
    const platform = device.platform.trim().toLowerCase();
    return (platform === "ios" || platform === "iphone") && device.label === key.label;
  });
  return same ? "matchesLink" : "notInLinks";
}

export const PHONE_NAME_ORIGIN_COPY: Record<PhoneNameOrigin, string> = {
  matchesLink: "이 이름은 QR로 연결할 때 폰이 알린 이름과 같아요.",
  notInLinks:
    "이 이름은 연결된 기기 목록에 없어요. 방금 내가 연결한 폰이 아니라면 승인하지 마세요.",
  unknown: "연결된 기기 목록을 불러오지 못해서 이름을 맞춰 보지 못했어요.",
};

/** Always said: the name is not something the Mac or the server verified. */
export const PHONE_NAME_UNVERIFIED =
  "이름은 폰이 스스로 정한 값이라 확인된 게 아니에요. 믿을 수 있는 건 지문이에요.";

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
