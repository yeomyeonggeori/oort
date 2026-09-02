import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { sha256Utf8 } from "../../lib/sha256";
import {
  parseDeviceLinkDeepLink,
  type DeviceLinkPrefill,
} from "./deepLink";
import {
  DEVICE_LINK_EXPIRED_COPY,
  DEVICE_LINK_MALFORMED_COPY,
  DEVICE_LINK_TOKEN_LEN,
  DEVICE_LINK_USED_COPY,
  deviceLinkFailureCopy,
  deviceLinkSasDigits,
  isDeviceLinkToken,
} from "./deviceLinkModel";

const TOKEN = "A".repeat(DEVICE_LINK_TOKEN_LEN);
const SERVER = "https://api.example.com";
const ENCODED_SERVER = "https%3A%2F%2Fapi.example.com";

function expectPrefill(raw: string, expected: DeviceLinkPrefill): void {
  expect(parseDeviceLinkDeepLink(raw)).toEqual(expected);
}

describe("parseDeviceLinkDeepLink", () => {
  it("parses independently of parameter order", () => {
    const expected = { serverUrl: SERVER, token: TOKEN };
    expectPrefill(`oort://link?server=${ENCODED_SERVER}&token=${TOKEN}`, expected);
    expectPrefill(`oort://link?token=${TOKEN}&server=${ENCODED_SERVER}`, expected);
  });

  it("absorbs momo:// and the authority-less form", () => {
    const expected = { serverUrl: SERVER, token: TOKEN };
    expectPrefill(`momo://link?server=${ENCODED_SERVER}&token=${TOKEN}`, expected);
    expectPrefill(`oort:link?server=${ENCODED_SERVER}&token=${TOKEN}`, expected);
    expectPrefill(`momo:link?token=${TOKEN}&server=${ENCODED_SERVER}`, expected);
  });

  it("ignores unknown parameters", () => {
    expectPrefill(
      `oort://link?utm=mail&server=${ENCODED_SERVER}&ref=qr&token=${TOKEN}&x=1`,
      { serverUrl: SERVER, token: TOKEN }
    );
  });

  it("rejects an unusable server even when a token is present", () => {
    expect(
      parseDeviceLinkDeepLink(
        `oort://link?server=not%20a%20url&token=${TOKEN}`
      )
    ).toBeNull();
    expect(
      parseDeviceLinkDeepLink(`oort://link?server=ws%3A%2F%2Fapi.example.com&token=${TOKEN}`)
    ).toBeNull();
  });

  it("ignores join links, empty links, and other schemes", () => {
    expect(parseDeviceLinkDeepLink(`oort://join?server=${ENCODED_SERVER}&code=x`)).toBeNull();
    expect(parseDeviceLinkDeepLink("oort://link")).toBeNull();
    expect(parseDeviceLinkDeepLink("https://link?token=x")).toBeNull();
    expect(parseDeviceLinkDeepLink("not a url")).toBeNull();
  });
});

describe("device-link redeem copy", () => {
  it("speaks three distinct sentences for 401, 409, and malformed", () => {
    const expired = deviceLinkFailureCopy(
      new ApiError(401, "device link token is invalid")
    );
    const used = deviceLinkFailureCopy(
      new ApiError(409, "device link token has already been used")
    );
    const malformed = deviceLinkFailureCopy(new Error("bad qr"));
    expect(expired.message).toBe(DEVICE_LINK_EXPIRED_COPY);
    expect(used.message).toBe(DEVICE_LINK_USED_COPY);
    expect(malformed.message).toBe(DEVICE_LINK_MALFORMED_COPY);
    expect(new Set([expired.message, used.message, malformed.message]).size).toBe(
      3
    );
    expect(expired.retryable).toBe(false);
    expect(used.retryable).toBe(false);
  });

  it("does not surface the server English", () => {
    const expired = deviceLinkFailureCopy(
      new ApiError(401, "device link token is invalid")
    );
    expect(expired.message).not.toMatch(/invalid|expired|token/i);
  });

  it("passes a transport failure through as retryable", () => {
    const copy = deviceLinkFailureCopy(new NetworkError("unreachable", 15_000));
    expect(copy.retryable).toBe(true);
    expect(copy.message.length).toBeGreaterThan(0);
    expect(copy.message).not.toBe(DEVICE_LINK_EXPIRED_COPY);
  });
});

describe("device-link SAS digits", () => {
  it("hashes UTF-8 the same way Postgres digest(text) does", () => {
    const hex = Array.from(sha256Utf8("abc"))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches the server hash formula for a known token", () => {
    const token = "dEv1c3L1nkT0kenF1xtureDoN0tL0gOrSt0reXXXXXX";
    expect(token).toHaveLength(DEVICE_LINK_TOKEN_LEN);
    expect(isDeviceLinkToken(token)).toBe(true);
    expect(deviceLinkSasDigits(token)).toBe("9990");
  });
});
