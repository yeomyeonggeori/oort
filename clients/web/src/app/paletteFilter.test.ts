import { describe, expect, it } from "vitest";
import { paletteFilter } from "./paletteFilter";

// #4111: 명령 줄은 이름·별칭의 낱말 앞머리로만 걸린다. id는 재료가 아니다.
describe("paletteFilter (#4111)", () => {
  const inbox = ["인박스", "inbox"];
  const aiHub = ["AI", "ai 허브", "허브", "구독"];
  const aiLink = ["AI 연결", "ai", "hermes", "구독"];

  it("「ai」는 부분수열로만 걸리던 인박스를 숨기고 AI 줄은 남긴다", () => {
    expect(paletteFilter("nav.inbox", "ai", inbox)).toBe(0);
    expect(paletteFilter("nav.activity", "ai", ["활동", "activity"])).toBe(0);
    expect(paletteFilter("nav.ai", "ai", aiHub)).toBeGreaterThan(0);
    expect(paletteFilter("nav.settings.ai", "ai", aiLink)).toBeGreaterThan(0);
  });

  it("이름에 맞는 줄이 별칭에만 맞는 줄보다 높다", () => {
    expect(paletteFilter("a", "ai", aiHub)).toBeGreaterThan(
      paletteFilter("b", "ai", ["외부 연결", "ai", "앱"])
    );
  });

  it("질의 낱말이 전부 맞아야 한다", () => {
    expect(paletteFilter("nav.settings.ai", "ai 연결", aiLink)).toBeGreaterThan(0);
    expect(paletteFilter("nav.ai", "ai 연결", aiHub)).toBe(0);
  });

  it("id 조각은 재료가 아니다", () => {
    expect(paletteFilter("nav.inbox", "nav", inbox)).toBe(0);
  });

  it("키워드가 없는 줄(채널·사람)은 예전처럼 흐릿한 일치를 낮은 점수로 유지한다", () => {
    expect(paletteFilter("deploy 배포", "dpl")).toBeGreaterThan(0);
    expect(paletteFilter("deploy 배포", "dpl")).toBeLessThan(paletteFilter("deploy 배포", "dep"));
    expect(paletteFilter("deploy 배포", "zzq")).toBe(0);
  });

  it("빈 질의는 모두 남긴다", () => {
    expect(paletteFilter("x", "  ", inbox)).toBeGreaterThan(0);
  });
});
