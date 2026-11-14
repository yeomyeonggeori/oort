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

  // ADR-0225 D12: 채널·사람 줄(키워드 없음)은 한글 조합 중에도 남는다.
  it.each(["디", "디ㅈ", "디자", "디장", "디자이", "디자인"])(
    "한글 조합 중 `%s` 에서도 「디자인」 줄이 남고, 「디저트」는 `디자`부터 빠진다",
    (query) => {
      expect(paletteFilter("디자인 5f0c9e1a-0000", query)).toBeGreaterThan(0);
      const dessert = paletteFilter("디저트 5f0c9e1a-0001", query) > 0;
      expect(dessert).toBe(query === "디" || query === "디ㅈ");
    }
  );

  it("느슨한 견줌은 마지막 낱말의 마지막 글자만이다", () => {
    expect(paletteFilter("디자인-리뷰 id", "디자인 리ㅂ")).toBeGreaterThan(0);
    expect(paletteFilter("디자인-리뷰 id", "디장 리뷰")).toBe(0);
  });

  it("빈 질의는 모두 남긴다", () => {
    expect(paletteFilter("x", "  ", inbox)).toBeGreaterThan(0);
  });
});
