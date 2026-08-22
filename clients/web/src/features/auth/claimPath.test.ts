import { describe, expect, it } from "vitest";
import { isClaimPath, readClaimToken } from "./claimPath";

const TOKEN = "A".repeat(43);

describe("claim path", () => {
  it("recognises the sealed /claim/<token> URL", () => {
    expect(isClaimPath(`/claim/${TOKEN}`)).toBe(true);
    expect(isClaimPath("/claim")).toBe(true);
    expect(isClaimPath("/login")).toBe(false);
  });

  it("reads a well-shaped token and rejects padding, short, or nested paths", () => {
    expect(readClaimToken(`/claim/${TOKEN}`)).toBe(TOKEN);
    expect(readClaimToken(`/claim/${TOKEN}/`)).toBe(TOKEN);
    expect(readClaimToken("/claim/")).toBeNull();
    expect(readClaimToken(`/claim/${TOKEN}=`)).toBeNull();
    expect(readClaimToken(`/claim/${TOKEN}/extra`)).toBeNull();
    expect(readClaimToken("/claim/short")).toBeNull();
  });
});
