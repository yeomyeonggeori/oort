import { describe, expect, it } from "vitest";
import { channelHashPath, channelShareUrlFromServerBase } from "./shareLink";

describe("채널 링크 (#4229)", () => {
  it("서버 주소 뒤 `/#/c/{id}`", () => {
    expect(channelShareUrlFromServerBase("https://app.oor7.com", "abc")).toBe(
      "https://app.oor7.com/#/c/abc"
    );
  });

  it("끝 슬래시는 한 번만 선다", () => {
    expect(channelShareUrlFromServerBase("https://app.oor7.com//", "abc")).toBe(
      "https://app.oor7.com/#/c/abc"
    );
  });

  it("서버 주소를 모르면 지어내지 않는다", () => {
    expect(channelShareUrlFromServerBase("  ", "abc")).toBeNull();
  });

  it("id 는 인코딩한다", () => {
    expect(channelHashPath("a b/c")).toBe("/c/a%20b%2Fc");
  });
});
