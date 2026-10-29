import { describe, expect, it } from "vitest";
import { CLI_CONSENT_PATH, isCliConsentPath, readCliRequestId } from "./cliConsentPath";

// oort CLI 로그인 동의 경로·요청 값 판정. window 없이 순수 함수로 본다.

describe("isCliConsentPath", () => {
  it("정확한 경로와 끝 슬래시만 잡는다", () => {
    expect(isCliConsentPath(CLI_CONSENT_PATH)).toBe(true);
    expect(isCliConsentPath(`${CLI_CONSENT_PATH}/`)).toBe(true);
  });

  it("호스티드 동의 경로와 그 밖의 경로는 잡지 않는다", () => {
    expect(isCliConsentPath("/")).toBe(false);
    expect(isCliConsentPath("/oauth")).toBe(false);
    expect(isCliConsentPath("/oauth/consent")).toBe(false);
    expect(isCliConsentPath("/oauth/cli/extra")).toBe(false);
    expect(isCliConsentPath("/oauth/client")).toBe(false);
    expect(isCliConsentPath("/OAUTH/CLI")).toBe(false);
    expect(isCliConsentPath("/c/123")).toBe(false);
  });
});

describe("readCliRequestId", () => {
  it("request 쿼리 하나만 읽는다", () => {
    expect(readCliRequestId("?request=signed.envelope")).toBe("signed.envelope");
  });

  it("다른 쿼리는 보지 않는다", () => {
    expect(
      readCliRequestId("?code=leak&request=envelope&access_token=leak&state=x")
    ).toBe("envelope");
  });

  it("없거나 비면 null 이다", () => {
    expect(readCliRequestId("")).toBeNull();
    expect(readCliRequestId("?request=")).toBeNull();
    expect(readCliRequestId("?other=1")).toBeNull();
    expect(readCliRequestId("?code=only")).toBeNull();
  });
});
