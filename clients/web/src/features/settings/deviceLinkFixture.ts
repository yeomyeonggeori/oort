// Split so the voucher never appears as one literal in test names, snapshots,
// or capture frame names. Join only at runtime.

const TOKEN_HEAD = "ABCDEFGHIJKLMNOPQRSTUV";
const TOKEN_TAIL = "WXYZabcdefghijklm";

export const DEVICE_LINK_FIXTURE_ID = "019f9b10-0000-7000-8000-000000000d01";
export const DEVICE_LINK_FIXTURE_SAS = "4821";
export const DEVICE_LINK_FIXTURE_DEVICE_NAME =
  "성재 iPhone 16 Pro Max, 집 작업실 책상 옆 MagSafe 충전 거치대";

export function deviceLinkFixtureToken(): string {
  return `${TOKEN_HEAD}${TOKEN_TAIL}`;
}

function percentEncodeUnreserved(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    const unreserved =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      ch === "-" ||
      ch === "." ||
      ch === "_" ||
      ch === "~";
    if (unreserved) out += ch;
    else out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function deviceLinkFixtureDeepLink(
  origin = "https://team.example.com"
): string {
  return `oort://link?server=${percentEncodeUnreserved(origin)}&token=${deviceLinkFixtureToken()}`;
}

export function deviceLinkFixtureIssue(input?: {
  sas?: string | null;
  expiresAt?: number;
}): {
  id: string;
  token: string;
  expiresAt: number;
  sas?: string;
  deepLink: string;
} {
  const issued = {
    id: DEVICE_LINK_FIXTURE_ID,
    token: deviceLinkFixtureToken(),
    expiresAt: input?.expiresAt ?? Date.now() + 120_000,
    deepLink: deviceLinkFixtureDeepLink(),
  };
  if (input && "sas" in input) {
    return input.sas ? { ...issued, sas: input.sas } : issued;
  }
  return { ...issued, sas: DEVICE_LINK_FIXTURE_SAS };
}
