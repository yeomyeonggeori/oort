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
const PIN_CODE = codeOnly(
  readFileSync(new URL("../timeline/PinListMenu.tsx", import.meta.url), "utf8")
);
const MIC_CODE = codeOnly(
  readFileSync(new URL("../huddles/HuddleMicMenu.tsx", import.meta.url), "utf8")
);
const DOCK_CODE = codeOnly(
  readFileSync(new URL("../work/WorkPlanDock.tsx", import.meta.url), "utf8")
);
const ACTION_MODEL_CODE = codeOnly(
  readFileSync(
    new URL(
      "../../../../../packages/momo-core/src/features/channels/actionModel.ts",
      import.meta.url
    ),
    "utf8"
  )
);
const ACTION_MENU_CODE = codeOnly(
  readFileSync(new URL("./channelActions.tsx", import.meta.url), "utf8")
);

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

  it("draws huddle icon buttons like the other header controls (shared class, #4591)", () => {
    // 예전에는 `<Button variant="ghost" size="icon">`에 `rounded-md`를 덧댔다. 머리 단추의 선·상태 토큰이 한 곳
    // (`channelHeaderControlClass`)에서 바뀌므로 허들 단추도 같은 함수를 쓴다. 따로 복사하면 선이 한 쪽만 바뀐다.
    expect(HUDDLE_CODE).toMatch(/channelHeaderControlClass\(\)/);
    expect(HUDDLE_CODE).not.toMatch(/<Button\b/);
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
    expect(MENU_CODE).toMatch(/pendingHandOffRef/);
  });

  // #2741: 메뉴를 닫는 손과 다이얼로그를 여는 손이 같으면, 퇴장 모션 동안 남은
  // 메뉴 층이 Esc를 먹어 다이얼로그가 닫히지 않는다. 다이얼로그는 메뉴 콘텐츠가
  // 언마운트될 때 불리는 onCloseAutoFocus 에서만 연다. jsdom 은 Presence 를 즉시
  // 내리므로 경합 자체는 gate:channel-header 가 실브라우저에서 잰다.
  it("opens the handed-off dialog only after the menu has unmounted (#2741)", () => {
    // 자르는 기준이 사라지면 아래 not.toMatch 가 빈 조각 위에서 초록이 된다.
    expect(MENU_CODE).toContain("onHandOff={");
    expect(MENU_CODE).toContain("onCloseAutoFocus={");
    const handOff = MENU_CODE.slice(MENU_CODE.indexOf("onHandOff={"));
    const handOffBody = handOff.slice(0, handOff.indexOf("/>"));
    expect(handOffBody).not.toMatch(/setTopicOpen\(true\)/);
    expect(handOffBody).not.toMatch(/leave\.open\(\)/);
    const onClose = MENU_CODE.slice(
      MENU_CODE.indexOf("onCloseAutoFocus={"),
      MENU_CODE.indexOf("<ChannelActionMenuItems")
    );
    expect(onClose).toMatch(/setTopicOpen\(true\)/);
    expect(onClose).toMatch(/actions\.leave\.open\(\)/);
  });
});

// =============================================================================
// #4591 — 머리 단추는 전부 디자인 시스템 툴팁이고 네이티브 `title`은 없다.
//
// 「소스에 `<Tooltip`이 있다」만 세면 새 머리 단추가 툴팁 없이 들어와도 초록이다. 그래서 이 단정은 **단추를 만드는 쪽**에서
// 센다: `channelHeaderControlClass(`가 쓰인 자리마다 그 자리가 `<Tooltip …>…</Tooltip>` 안인지 잰다. 렌더로 문구·방향·
// 지연을 재는 짝은 `channelHeaderControls.tooltip.test.tsx`다.
// =============================================================================

/** `<Tooltip`부터 짝이 되는 `</Tooltip>`까지(중첩 없음). 짝이 없으면 터진다. */
function tooltipBlocks(code: string): Array<{ start: number; end: number; text: string }> {
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  let from = 0;
  for (;;) {
    const start = code.indexOf("<Tooltip", from);
    if (start < 0) return blocks;
    const close = code.indexOf("</Tooltip>", start);
    if (close < 0) throw new Error("`<Tooltip>`의 짝(`</Tooltip>`)이 없다");
    const end = close + "</Tooltip>".length;
    blocks.push({ start, end, text: code.slice(start, end) });
    from = end;
  }
}

/** `needle`이 나오는 모든 위치. */
function indexesOf(code: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = code.indexOf(needle); at >= 0; at = code.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

describe("#4591 every header control wears the design-system tooltip", () => {
  // 머리 단추를 만드는 파일들. ChatShell은 머리 컨트롤 묶음부터 머리 끝까지만 본다(그 앞의 토픽 한 줄 `title`은 단추가 아니다).
  const CONTROL_GROUP_AT = SHELL_CODE.indexOf("channel-header-controls");
  const FILES: Record<string, { code: string; sites: number }> = {
    "ChatShell.tsx(터미널)": {
      code: SHELL_CODE.slice(CONTROL_GROUP_AT, SHELL_CODE.indexOf("</header>", CONTROL_GROUP_AT)),
      sites: 1,
    },
    "PinListMenu.tsx": { code: PIN_CODE, sites: 1 },
    "ChannelContextControls.tsx(멤버)": { code: CONTROLS_CODE, sites: 1 },
    "ChannelHeaderMenu.tsx(⋮)": { code: MENU_CODE, sites: 1 },
    "HuddleHeaderControl.tsx(허들)": { code: HUDDLE_CODE, sites: 1 },
    "WorkPlanDock.tsx(계획 독, #4578)": { code: DOCK_CODE, sites: 1 },
  };

  it("ChatShell의 머리 컨트롤 묶음을 실제로 잘라 냈다(빈 조각 위의 초록 방지)", () => {
    expect(CONTROL_GROUP_AT).toBeGreaterThan(0);
    expect(FILES["ChatShell.tsx(터미널)"].code).toContain("open-terminal-dock");
    expect(FILES["ChatShell.tsx(터미널)"].code).toContain("<PinListMenu");
  });

  for (const [name, { code, sites }] of Object.entries(FILES)) {
    it(`${name}: channelHeaderControlClass 를 쓰는 자리는 전부 <Tooltip> 안이다`, () => {
      const calls = indexesOf(code, "channelHeaderControlClass(");
      // 자리 수를 못 박는다: 센 것이 0이면 아래 반복이 비어 항상 초록이다.
      expect(calls).toHaveLength(sites);
      const blocks = tooltipBlocks(code);
      for (const at of calls) {
        const inside = blocks.some((block) => block.start < at && at < block.end);
        expect(inside, `${name}: ${at}번째 글자의 머리 단추가 <Tooltip> 밖이다`).toBe(true);
      }
    });

    it(`${name}: 툴팁 안의 단추에 네이티브 title 이 없다, 방향은 아래다`, () => {
      const blocks = tooltipBlocks(code);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        // `title` 을 같이 두면 운영체제 툴팁과 디자인 시스템 툴팁이 둘 다 뜬다.
        expect(block.text).not.toMatch(/\btitle=/);
        // 판이 `overflow: clip`이고 머리 위 여백(13)이 툴팁 높이보다 낮아 위로는 잘린다.
        expect(block.text).toMatch(/side="bottom"/);
      }
    });
  }

  it("툴팁은 DropdownMenuTrigger 바깥이다(안에 두면 래퍼가 Radix 트리거가 된다)", () => {
    for (const code of [PIN_CODE, MENU_CODE, MIC_CODE]) {
      const blocks = tooltipBlocks(code);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].text).toMatch(/<DropdownMenuTrigger\b/);
      // 트리거가 툴팁 밖에서 열리는 모양(`<DropdownMenuTrigger><Tooltip>`)이 아니다.
      const triggerAt = code.indexOf("<DropdownMenuTrigger");
      expect(blocks[0].start).toBeLessThan(triggerAt);
    }
  });

  it("맨 오른쪽 ⋮ 단추는 툴팁 오른쪽 끝을 맞춘다(판의 오른쪽 여백 18에서 잘리지 않게)", () => {
    expect(tooltipBlocks(MENU_CODE)[0].text).toMatch(/align="end"/);
  });

  it("허들의 마이크 묶음은 툴팁을 자르는 overflow-hidden 이 아니다", () => {
    const cluster = HUDDLE_CODE.slice(
      HUDDLE_CODE.indexOf('data-testid="huddle-mic-cluster"') - 120,
      HUDDLE_CODE.indexOf('data-testid="huddle-mic-cluster"')
    );
    expect(cluster).toContain("border-line-strong");
    expect(cluster).not.toMatch(/overflow-hidden/);
    // 대신 양 끝 단추가 자기 바깥 모서리를 둥글게 한다.
    expect(HUDDLE_CODE).toMatch(/rounded-s-sm/);
    expect(MIC_CODE).toMatch(/rounded-e-sm/);
  });

  it("마이크 선택·마이크 단추·허들 단추 어디에도 title 이 남지 않았다", () => {
    const triggers = MIC_CODE.slice(
      MIC_CODE.indexOf("const trigger ="),
      MIC_CODE.indexOf("const tipped =")
    );
    expect(triggers).toContain('data-testid="huddle-mic-devices"');
    expect(triggers).not.toMatch(/\btitle=/);
    const micButton = HUDDLE_CODE.slice(
      HUDDLE_CODE.indexOf('data-testid="huddle-microphone"') - 400,
      HUDDLE_CODE.indexOf('data-testid="huddle-microphone"') + 200
    );
    expect(micButton).not.toMatch(/\btitle=/);
  });
});
