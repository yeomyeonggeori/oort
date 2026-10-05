import { describe, expect, it } from "vitest";
import { DOORBELL_PRECHECK_ITEMS, DOORBELL_PRECHECK_NOTE } from "./doorbell";
import { EXTERNAL_PICKER_COPY, externalPresetCards, externalPresetSeed } from "./externalPresets";

describe("externalPresetCards (#3523)", () => {
  it("추천은 감지가 앱을 봤을 때만 그록봇에 붙는다", () => {
    const detected = externalPresetCards("detected");
    expect(detected.filter((c) => c.recommended).map((c) => c.id)).toEqual(["grok"]);
    expect(detected[0]?.badge).toBe(EXTERNAL_PICKER_COPY.recommendedBadge);
    expect(detected[0]?.note).toContain(EXTERNAL_PICKER_COPY.detectedNote);
    for (const mode of ["not-found", "unavailable"] as const) {
      const cards = externalPresetCards(mode);
      expect(cards.some((c) => c.recommended || c.badge === EXTERNAL_PICKER_COPY.recommendedBadge)).toBe(false);
    }
  });

  it("웹(감지 없음)에서도 그록봇·일반 프리셋은 고를 수 있고 감지 문구가 없다", () => {
    const cards = externalPresetCards("unavailable");
    expect(cards.filter((c) => c.state === "available").map((c) => c.id)).toEqual(["grok", "generic"]);
    expect(cards[0]?.note).not.toContain("찾");
  });

  it("못 찾았을 때는 없다고 단정하지 않고 이 컴퓨터에서만 못 찾았다고 말한다", () => {
    const note = externalPresetCards("not-found")[0]?.note ?? "";
    expect(note).toContain("이 컴퓨터에서는 앱을 찾지 못했어요");
    expect(note).toContain("그대로 이어가도 돼요");
  });

  it("dots 는 곧 지원으로 고를 수 없고 위저드 시작 값이 없다", () => {
    const dots = externalPresetCards("detected").find((c) => c.id === "dots");
    expect(dots).toMatchObject({ state: "soon", recommended: false, badge: "곧 지원" });
    expect(externalPresetSeed("generic")).toEqual({ displayName: "", handle: "" });
  });

  it("그록봇 시작 값은 감지 서명의 이름과 같다", () => {
    expect(externalPresetSeed("grok")).toEqual({ displayName: "그록봇", handle: "grokbot" });
  });
});

describe("도어벨 사전 점검 문구 (#3523)", () => {
  it("켜졌다고 단정하지 않고 준비물 셋과 서버는 저장 때 안다는 한 줄을 둔다", () => {
    expect(DOORBELL_PRECHECK_ITEMS).toHaveLength(3);
    expect(DOORBELL_PRECHECK_ITEMS[0]).toContain("MOMO_DOORBELL_ENABLED");
    expect(DOORBELL_PRECHECK_NOTE).toContain("미리 알 수 없어요");
  });
});
