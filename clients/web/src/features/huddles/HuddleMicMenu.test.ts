import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("./HuddleMicMenu.tsx", import.meta.url), "utf8");
const HEADER = readFileSync(
  new URL("./HuddleHeaderControl.tsx", import.meta.url),
  "utf8"
);

describe("HuddleMicMenu copy and wiring", () => {
  it("names permission and empty states with sentences, not a radio list", () => {
    expect(SOURCE).toContain("data-testid=\"huddle-mic-permission\"");
    expect(SOURCE).toContain("data-testid=\"huddle-mic-empty\"");
    expect(SOURCE).toContain("마이크 사용을 허용하면 장치를 고를 수 있습니다.");
    expect(SOURCE).toContain(
      "마이크 권한이 없어 장치를 고를 수 없습니다. 브라우저 설정에서 허용하세요."
    );
    expect(SOURCE).toContain("연결된 마이크가 없습니다.");
    expect(SOURCE).not.toMatch(/[—–]/);
  });

  it("lists devices as a radio group inside the existing dropdown grammar", () => {
    expect(SOURCE).toContain("DropdownMenuRadioGroup");
    expect(SOURCE).toContain("DropdownMenuRadioItem");
    expect(SOURCE).toContain("data-testid=\"huddle-mic-devices\"");
    expect(SOURCE).toContain("data-testid=\"huddle-mic-gain\"");
    expect(SOURCE).toContain("HUDDLE_MIC_DEFAULT_LABEL");
    expect(HEADER).toContain("<HuddleMicMenu");
    expect(HEADER).toContain("huddle.setMicrophoneDevice");
  });
});
