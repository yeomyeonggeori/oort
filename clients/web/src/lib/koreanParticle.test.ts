import { describe, expect, it } from "vitest";
import { attachParticle, hasFinalConsonant, particleFor } from "./koreanParticle";

describe("koreanParticle", () => {
  it("picks the particle from the last spoken syllable, both branches", () => {
    // Both names are in the demo workspace roster, so both branches ship.
    expect(attachParticle("김인턴")).toBe("김인턴이");
    expect(attachParticle("Hermes")).toBe("Hermes가");
    expect(attachParticle("에이전트")).toBe("에이전트가");
    expect(attachParticle("곽성재")).toBe("곽성재가");
    expect(attachParticle("박지훈")).toBe("박지훈이");
  });

  it("covers the object and topic pairs the same way", () => {
    expect(attachParticle("김인턴", "object")).toBe("김인턴을");
    expect(attachParticle("Hermes", "object")).toBe("Hermes를");
    expect(attachParticle("김인턴", "topic")).toBe("김인턴은");
    expect(attachParticle("Hermes", "topic")).toBe("Hermes는");
  });

  it("ignores trailing punctuation and whitespace, as the mac rule does", () => {
    expect(attachParticle("김인턴 ")).toBe("김인턴 이");
    expect(particleFor("(김인턴)")).toBe("이");
    expect(particleFor("Hermes.")).toBe("가");
  });

  it("treats a non-Hangul or empty ending as having no final consonant", () => {
    expect(hasFinalConsonant("")).toBe(false);
    expect(hasFinalConsonant("   ")).toBe(false);
    expect(hasFinalConsonant("MOMO-613")).toBe(false);
    expect(hasFinalConsonant("김인턴")).toBe(true);
  });
});
