import { describe, expect, it } from "vitest";
import {
  isOauthConsentPath,
  OAUTH_CONSENT_PATH,
  readOauthRequestId,
} from "./oauthConsentPath";

// =============================================================================
// #1369 — consent 경로/요청 id 판정. window 없이 순수 함수로 검사한다.
// =============================================================================

describe("isOauthConsentPath", () => {
  it("정확한 경로와 끝 슬래시만 잡는다", () => {
    expect(isOauthConsentPath(OAUTH_CONSENT_PATH)).toBe(true);
    expect(isOauthConsentPath(`${OAUTH_CONSENT_PATH}/`)).toBe(true);
    expect(isOauthConsentPath("/")).toBe(false);
    expect(isOauthConsentPath("/oauth")).toBe(false);
    expect(isOauthConsentPath("/oauth/consent/extra")).toBe(false);
    expect(isOauthConsentPath("/c/123")).toBe(false);
  });
});

describe("readOauthRequestId", () => {
  it("request 쿼리 하나만 읽는다", () => {
    expect(readOauthRequestId("?request=signed.envelope")).toBe("signed.envelope");
  });

  it("다른 쿼리는 보지 않는다", () => {
    expect(
      readOauthRequestId("?code=leak&request=envelope&access_token=leak")
    ).toBe("envelope");
  });

  it("없거나 비면 null 이다", () => {
    expect(readOauthRequestId("")).toBeNull();
    expect(readOauthRequestId("?request=")).toBeNull();
    expect(readOauthRequestId("?other=1")).toBeNull();
  });
});
