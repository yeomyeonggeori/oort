import { describe, expect, it } from "vitest";
import {
  attachDirection,
  attachParticle,
  directionParticle,
  hasFinalConsonant,
  particleFor,
} from "./koreanParticle";

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

  it("covers 과/와, whose forms sit the opposite way round from 이/가", () => {
    // The inversion is the whole reason this pair is in the table: writing it
    // from memory in one screen is how "Hermes과의 대화" reached a phone.
    expect(attachParticle("김인턴", "with")).toBe("김인턴과");
    expect(attachParticle("Hermes", "with")).toBe("Hermes와");
    expect(attachParticle("헤르메스", "with")).toBe("헤르메스와");
    expect(particleFor("곽성재", "with")).toBe("와");
    expect(particleFor("박지훈", "with")).toBe("과");
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

describe("directionParticle (로 / 으로)", () => {
  // The measured defect: "provider가 503로 답했습니다." was on screen, and the
  // status codes an operator meets most (500, 503, 400, 403, 406) are exactly
  // the ones whose last digit is read with a final consonant.
  it("reads the last digit the way it is spoken", () => {
    expect(attachDirection("500")).toBe("500으로"); // 영, ㅇ
    expect(attachDirection("503")).toBe("503으로"); // 삼, ㅁ
    expect(attachDirection("406")).toBe("406으로"); // 육, ㄱ
    expect(attachDirection("401")).toBe("401로"); // 일, ㄹ
    expect(attachDirection("502")).toBe("502로"); // 이
    expect(attachDirection("504")).toBe("504로"); // 사
    expect(attachDirection("429")).toBe("429로"); // 구
    expect(attachDirection("507")).toBe("507로"); // 칠, ㄹ
    expect(attachDirection("408")).toBe("408로"); // 팔, ㄹ
    expect(attachDirection("405")).toBe("405로"); // 오
  });

  // ㄹ is the one final consonant that keeps 로, which a two-slot 이/가-shaped
  // table cannot express.
  it("treats a ㄹ ending as open, and every other final consonant as closed", () => {
    expect(directionParticle("서울")).toBe("로");
    expect(directionParticle("목")).toBe("으로");
    expect(directionParticle("다음")).toBe("으로");
    expect(directionParticle("예비")).toBe("로");
  });

  it("leaves an anglicised or empty ending on the neutral form", () => {
    expect(directionParticle("gateway.dawn.internal")).toBe("로");
    expect(directionParticle("")).toBe("로");
    expect(directionParticle("(503)")).toBe("으로");
  });
});
