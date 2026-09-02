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
const ACTION_MODEL_CODE = codeOnly(
  readFileSync(new URL("./channelActionModel.ts", import.meta.url), "utf8")
);
const ACTION_MENU_CODE = codeOnly(
  readFileSync(new URL("./channelActions.tsx", import.meta.url), "utf8")
);

describe("explicit_open 광고 재시도 (M-1)", () => {
  it("셸은 PUT 성공 헬퍼로만 광고 채널을 고정한다", () => {
    expect(SHELL_CODE).toContain("nextAdvertisedChannelId");
  });
});

describe("BZ-2 channel header is one title row", () => {
  it("does not keep the topic in the always-visible header", () => {
    expect(SHELL_CODE).not.toMatch(/ChannelTopicControl/);
    expect(SHELL_CODE).toMatch(/data-testid="channel-header"/);
    expect(SHELL_CODE).toMatch(/py-row/);
    expect(SHELL_CODE).not.toMatch(/flex-col gap-1/);
  });

  it("opens the existing topic dialog from the overflow menu", () => {
    // BT-1 (#1929): 항목의 낱말·열쇠는 이제 채널 액션 정본이 갖고, 이 파일에
    // 남는 것은 헤더가 헤더인 부분이다. 주장은 그대로다 — ⋮ 가 **기존** 읽기
    // 다이얼로그를 연다. 그래서 단정은 사실이 옮겨 간 자리를 따라간다.
    expect(MENU_CODE).toMatch(/<ChannelTopicDialog/);
    expect(MENU_CODE).toMatch(/EllipsisVertical/);
    expect(MENU_CODE).toMatch(/surface="header"/);
    expect(MENU_CODE).toMatch(/prefix="channel"/);
    expect(MENU).toMatch(/data-testid="channel-title-menu"/);
    // `channel-topic` = prefix + testKey. 두 조각이 각자 자기 자리에 있다.
    expect(ACTION_MODEL_CODE).toMatch(/CHANNEL_TOPIC_VIEW_LABEL/);
    expect(ACTION_MODEL_CODE).toMatch(/key: "topic", testKey: "topic"/);
    expect(ACTION_MENU_CODE).toMatch(/`\$\{prefix\}-\$\{item\.testKey\}`/);
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
    expect(HUDDLE_CODE).toMatch(/data-testid="huddle-microphone"/);
    expect(HUDDLE_CODE).toMatch(/HuddleMicMenu/);
    expect(HUDDLE_CODE).toMatch(/huddle-mic-cluster/);
    expect(HUDDLE_CODE).toMatch(/testId="huddle-leave"/);
  });

  it("lets the right group shrink so a live huddle cannot cover the title", () => {
    expect(SHELL_CODE).toMatch(
      /className="flex min-w-0 flex-1 items-center justify-end gap-2"/
    );
    const at = SHELL.indexOf('data-testid="channel-header-controls"');
    const window = SHELL.slice(Math.max(0, at - 200), at);
    expect(window).toMatch(/min-w-0/);
    expect(window).not.toMatch(/shrink-0/);
  });

  it("draws huddle icon buttons with the outline icon primitive", () => {
    expect(HUDDLE_CODE).toMatch(/variant="outline"/);
    expect(HUDDLE_CODE).toMatch(/size="icon"/);
    expect(HUDDLE_CODE).toMatch(/size-4 spinner-busy/);
  });

  it("paints Live as a shrinking status fill, not a control outline", () => {
    expect(HUDDLE_CODE).toMatch(/bg-ok-soft/);
    expect(HUDDLE_CODE).toMatch(/size-2 rounded-full bg-ok/);
    expect(HUDDLE_CODE).toMatch(/wide-only/);
    expect(HUDDLE_CODE).toMatch(/huddle-participant-count/);
    expect(HUDDLE_CODE).not.toMatch(/max-w-action/);
    expect(HUDDLE_CODE).not.toMatch(/<AudioLines[^/]*\/>\s*Live/);
  });

  it("restores dialog focus in the close commit, not a tick later", () => {
    expect(CONTROLS_CODE).toMatch(/useRestoreFocusOnClose/);
    expect(MENU_CODE).toMatch(/handingOffRef/);
  });
});
