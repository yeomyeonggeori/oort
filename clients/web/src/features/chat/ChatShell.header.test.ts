import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Comments in this repository quote counter-examples verbatim; strip them. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

const SHELL = readFileSync(new URL("./ChatShell.tsx", import.meta.url), "utf8");
const SHELL_CODE = codeOnly(SHELL);
const MENU = readFileSync(
  new URL("./ChannelHeaderMenu.tsx", import.meta.url),
  "utf8"
);
const MENU_CODE = codeOnly(MENU);
const HUDDLE = readFileSync(
  new URL("../huddles/HuddleHeaderControl.tsx", import.meta.url),
  "utf8"
);
const HUDDLE_CODE = codeOnly(HUDDLE);
const CONTROLS = readFileSync(
  new URL("../channels/ChannelContextControls.tsx", import.meta.url),
  "utf8"
);
const CONTROLS_CODE = codeOnly(CONTROLS);

describe("BZ-2 channel header is one title row", () => {
  it("does not keep the topic in the always-visible header", () => {
    expect(SHELL_CODE).not.toMatch(/ChannelTopicControl/);
    expect(SHELL_CODE).toMatch(/data-testid="channel-header"/);
    expect(SHELL_CODE).toMatch(/py-row/);
    expect(SHELL_CODE).not.toMatch(/flex-col gap-1/);
  });

  it("opens the existing topic dialog from the overflow menu", () => {
    expect(MENU_CODE).toMatch(/CHANNEL_TOPIC_VIEW_LABEL/);
    expect(MENU_CODE).toMatch(/data-testid="channel-topic"/);
    expect(MENU_CODE).toMatch(/<ChannelTopicDialog/);
    expect(MENU_CODE).toMatch(/EllipsisVertical/);
    expect(MENU).toMatch(/data-testid="channel-title-menu"/);
  });
});

describe("BZ-2 right control group rearranges existing actions", () => {
  it("groups terminal, pins, member count, huddle, and overflow", () => {
    expect(SHELL_CODE).toMatch(/data-testid="channel-header-controls"/);
    expect(SHELL).toMatch(/aria-label="채널 도구"/);
    const group = SHELL_CODE.slice(
      SHELL_CODE.indexOf("channel-header-controls")
    );
    const memberAt = group.indexOf("ChannelMemberPanel");
    const huddleAt = group.indexOf("HuddleHeaderControl");
    const menuAt = group.indexOf("ChannelHeaderMenu");
    expect(memberAt).toBeGreaterThan(0);
    expect(huddleAt).toBeGreaterThan(memberAt);
    expect(menuAt).toBeGreaterThan(huddleAt);
  });

  it("keeps the member count on the existing list surface", () => {
    expect(CONTROLS_CODE).toMatch(/data-testid="channel-member-count"/);
    expect(CONTROLS_CODE).toMatch(/members\.length/);
    expect(CONTROLS_CODE).toMatch(/channel-member-panel/);
    expect(CONTROLS_CODE).toMatch(/channelHeaderControlClass\(\{ wide: true \}\)/);
  });

  it("keeps idle huddle as an icon control with the live surface's labels", () => {
    expect(HUDDLE_CODE).toMatch(/label=\{startOrJoinLabel\}/);
    expect(HUDDLE_CODE).toMatch(/"허들 시작"/);
    expect(HUDDLE_CODE).toMatch(/"허들 참가"/);
    expect(HUDDLE_CODE).toMatch(
      /testId=\{huddle\.active \? "huddle-join" : "huddle-start"\}/
    );
    expect(HUDDLE_CODE).toMatch(/data-testid="huddle-live"/);
    expect(HUDDLE_CODE).toMatch(/data-testid="huddle-participants"/);
    expect(HUDDLE_CODE).toMatch(/testId="huddle-microphone"/);
    expect(HUDDLE_CODE).toMatch(/testId="huddle-leave"/);
  });
});
