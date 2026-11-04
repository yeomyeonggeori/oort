import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { channelHeaderControlClass } from "./channelHeaderControl";

/** Comments in this repository quote counter-examples verbatim; strip them. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

const SHELL = readFileSync(new URL("./ChatShell.tsx", import.meta.url), "utf8");
const SHELL_CODE = codeOnly(SHELL);
const TOKENS = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");

/** `@utility <name> { ... }`의 본문(첫 줄의 `{` 다음부터 열 0의 `}` 앞까지). 없으면 터진다. */
function utilityBody(name: string): string {
  const start = TOKENS.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`tokens.css에 @utility ${name}이 없다`);
  const end = TOKENS.indexOf("\n}", start);
  return TOKENS.slice(start, end);
}
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

/** `ChatShell`의 머리(`<header …>`부터 `</header>`까지) 코드. 없으면 터진다. */
const HEADER_CODE = (() => {
  const at = SHELL_CODE.indexOf('data-testid="channel-header"');
  if (at < 0) throw new Error("ChatShell에 channel-header가 없다");
  return SHELL_CODE.slice(at, SHELL_CODE.indexOf("</header>", at));
})();

/** `ChatShell`의 `renderControlsEnd`(멤버 수 · 허들 · ⋮) 본문. 없으면 터진다. */
function renderControlsEndCode(): string {
  const start = SHELL_CODE.indexOf("const renderControlsEnd");
  const end = SHELL_CODE.indexOf("const headerTailShown");
  if (start < 0 || end < start) throw new Error("ChatShell에 renderControlsEnd가 없다");
  return SHELL_CODE.slice(start, end);
}

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
      SHELL_CODE.indexOf('data-testid="channel-header-controls"')
    );
    // 끝 묶음(멤버 수 · 허들 · ⋮)은 `renderControlsEnd`가 그린다(#5206: ⋮가 외톨이가 되지 않게 묶는 곳). 묶음은 터미널·고정 목록 뒤다.
    const endAt = group.indexOf("renderControlsEnd(huddle)");
    expect(endAt).toBeGreaterThan(0);
    expect(group.indexOf("open-terminal-dock")).toBeGreaterThan(0);
    expect(group.indexOf("<PinListMenu")).toBeGreaterThan(group.indexOf("open-terminal-dock"));
    expect(endAt).toBeGreaterThan(group.indexOf("<PinListMenu"));
    // 끝 묶음 안의 순서: 멤버 수 → 허들 → ⋮.
    const end = renderControlsEndCode();
    const gluedAt = end.indexOf("huddleControlShown(huddle, offline)");
    expect(gluedAt).toBeGreaterThan(0);
    const glued = end.slice(gluedAt);
    const memberAt = glued.indexOf("{members}");
    const huddleAt = glued.indexOf("{huddleControl}");
    const menuAt = glued.indexOf("{menu}");
    expect(memberAt).toBeGreaterThan(0);
    expect(huddleAt).toBeGreaterThan(memberAt);
    expect(menuAt).toBeGreaterThan(huddleAt);
    // 세 단추의 실제 컴포넌트가 이 함수 안에 있다.
    expect(end.indexOf("<ChannelMemberPanel")).toBeGreaterThan(0);
    expect(end.indexOf("<HuddleHeaderControl")).toBeGreaterThan(end.indexOf("<ChannelMemberPanel"));
    expect(end.indexOf("<ChannelHeaderMenu")).toBeGreaterThan(end.indexOf("<HuddleHeaderControl"));
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

  it("keeps the control group able to wrap itself, so a live huddle cannot cover the title or leave the pane", () => {
    // #4230: 예전에는 오른쪽 무리가 `flex-1`(기준 0)로 남는 자리만 받아 컨트롤이 줄 안에서 넘쳤다. 지금은 컨트롤 묶음이
    // 제 폭을 먼저 갖고, 못 서면 줄이 바뀐다. 이 묶음 자신도 `flex-wrap`이라 아랫줄에서도 모자라면 단추가 다음 줄로 간다.
    const at = SHELL.indexOf('data-testid="channel-header-controls"');
    const window = SHELL.slice(Math.max(0, at - 200), at);
    expect(window).toMatch(/\bmin-w-0\b/);
    expect(window).toMatch(/\bflex-wrap\b/);
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
// #4230 — 긴 채널 이름에서도 머리 컨트롤이 판 안에 남는다: 컨트롤이 먼저 폭을 갖고, 제목이 남는 폭에서 한 줄로 줄어든다.
//
// 렌더된 상자(뷰포트 안·겹침 없음·눌림)는 `gates/gate-channel-header-fit.mjs`가 실브라우저에서 잰다(320~1440 × 글자 크기 3 ×
// 밀도 3 × 이름 종류 × 계획 독). 여기 있는 것은 그 기하를 만드는 **구조**의 약속이다: 한 줄만 바뀌어도 아래가 빨개진다.
// =============================================================================

describe("#4230 머리는 컨트롤 묶음이 먼저 폭을 갖고 제목이 남는 폭에서 한 줄로 줄어든다", () => {
  const AT_HEADER = SHELL_CODE.indexOf('data-testid="channel-header"');
  const HEADER = SHELL_CODE.slice(AT_HEADER, SHELL_CODE.indexOf("</header>", AT_HEADER));

  it("머리를 실제로 잘라 냈다(빈 조각 위의 초록 방지)", () => {
    expect(AT_HEADER).toBeGreaterThan(0);
    expect(HEADER).toContain('data-testid="channel-header-controls"');
    expect(HEADER).toContain("<h1");
  });

  it("머리는 줄이 바뀔 수 있고, 안에는 제목 묶음과 컨트롤 묶음 둘뿐이다", () => {
    expect(HEADER).toMatch(/className="channel-head flex min-w-0 flex-wrap items-center /);
    expect(HEADER.match(/className="channel-head-main /g)).toHaveLength(1);
    expect(HEADER.match(/className="channel-head-tools /g)).toHaveLength(1);
    // 제목 묶음이 먼저, 컨트롤 묶음이 나중이다(줄이 바뀌면 컨트롤이 제목 아래로 내려온다).
    expect(HEADER.indexOf("channel-head-main")).toBeLessThan(HEADER.indexOf("channel-head-tools"));
  });

  it("제목·핸들·토픽은 한 칸(기본 폭 0)에 있고, 컨트롤 묶음에는 토픽이 없다", () => {
    const bodyAt = HEADER.indexOf('className="channel-head-body ');
    const toolsAt = HEADER.indexOf('className="channel-head-tools ');
    expect(bodyAt).toBeGreaterThan(0);
    const body = HEADER.slice(bodyAt, toolsAt);
    const tools = HEADER.slice(toolsAt);
    expect(body).toContain("<h1");
    expect(body).toContain('data-testid="channel-handle"');
    expect(body).toContain('data-testid="channel-header-topic"');
    // 긴 토픽이 컨트롤 묶음을 부풀리면 이 결함이 돌아온다(예전 gate:channel-header 실측과 같은 이유).
    expect(tools).not.toContain('data-testid="channel-header-topic"');
    expect(tools).not.toContain("<h1");
  });

  it("세 칸의 flex 규칙: 제목 칸은 폭 0에서 남는 폭을 받고, 컨트롤 묶음은 제 폭이 기준이다", () => {
    const main = utilityBody("channel-head-main");
    expect(main).toMatch(/flex: 1 1 min-content;/);
    expect(main).toMatch(/min-inline-size: 0;/);
    // 제목 칸이 폭 0이어야 긴 이름의 글 폭이 윗 칸의 min-content 를 부풀리지 못한다.
    const body = utilityBody("channel-head-body");
    expect(body).toMatch(/flex: 1 1 0;/);
    expect(body).toMatch(/inline-size: 0;/);
    expect(body).toMatch(/min-inline-size: 3rem;/);
    const tools = utilityBody("channel-head-tools");
    expect(tools).toMatch(/flex: 0 1 auto;/);
    expect(tools).toMatch(/margin-inline-start: auto;/);
  });

  it("컨트롤 단추는 줄지 않는다(모든 머리 단추가 쓰는 클래스가 shrink-0이다)", () => {
    expect(channelHeaderControlClass()).toMatch(/\bshrink-0\b/);
    expect(channelHeaderControlClass({ wide: true })).toMatch(/\bshrink-0\b/);
    expect(channelHeaderControlClass({ pressed: true })).toMatch(/\bshrink-0\b/);
  });

  it("제목은 한 줄 말줄임이고 전문이 title 로 남는다(채널·DM·스트레스 세 변형 모두)", () => {
    const titles = [...HEADER.matchAll(/<h1[\s\S]*?>/g)].map((match) => match[0]);
    expect(titles).toHaveLength(3);
    for (const open of titles) {
      expect(open).toMatch(/\btitle=\{/);
      expect(open).toMatch(/channel-head-title/);
      expect(open).toMatch(/\bmin-w-0\b/);
    }
    // 채널·스트레스 제목은 한 줄 말줄임을 직접 든다. DM 은 안의 단추가 든다.
    expect(titles.filter((open) => /\btruncate\b/.test(open))).toHaveLength(2);
    expect(HEADER).toMatch(/data-testid="dm-profile-trigger"[\s\S]*?min-w-0 truncate/);
  });

  it("구분용 핸들은 제 칸(channel-head-handle) 안에 있고 줄지 않는다(말줄임 조각 금지)", () => {
    // #5206: 예전에는 핸들이 `min-w-0 truncate`라 좁은 폭에서 「@」 조각만 남았다. 지금은 핸들 자신이 줄지 않고(통째로),
    // 칸이 통째로 안 들어가면 핸들을 보이지 않는 둘째 줄로 보낸다.
    const slot = /<span className="channel-head-handle" data-testid="channel-handle-slot">([\s\S]*?)<\/span>\s*<\/span>/.exec(HEADER);
    expect(slot).not.toBeNull();
    const handle = /<span\s+className="([^"]*)"\s+data-testid="channel-handle"/.exec(slot?.[1] ?? "");
    expect(handle).not.toBeNull();
    const classes = (handle?.[1] ?? "").split(/\s+/);
    expect(classes).toContain("shrink-0");
    expect(classes).toContain("whitespace-nowrap");
    expect(classes).not.toContain("truncate");
    expect(classes).not.toContain("min-w-0");
  });
});

// =============================================================================
// #5206 · #5184 — 제목이 읽히는 몫을 지키고, 핸들은 통째로, 허들 이름은 제목 뒤 남는 폭만.
//
// 렌더된 기하(제목 몫·핸들 보임/숨음·칩 양보·머리 줄 수)는 `gate:channel-header-fit`이 크로미엄·웨빗에서 잰다. 여기 있는 것은
// 그 기하를 만드는 **구조**의 약속이다.
// =============================================================================

describe("#5206 제목 몫 문턱: 폰은 3rem, 넓은 창은 제목 글자 8자 몫", () => {
  it("제목 칸의 바닥은 폰 폭 3rem, 넓은 창(600 이상) --text-heading × 8이다", () => {
    const body = utilityBody("channel-head-body");
    expect(body).toMatch(/min-inline-size: 3rem;/);
    // 넓은 창의 바닥은 글자 크기 설정을 따른다: rem 고정값이 아니라 제목 글자 크기(--text-heading)의 8배.
    expect(body).toMatch(
      /@media \(width >= 600px\) \{\s*min-inline-size: calc\(var\(--text-heading\) \* 8\);\s*\}/
    );
    // 옛 3rem이 넓은 창에서도 이긴다면(미디어 규칙이 없다면) 720~768의 제목이 다시 53~101px로 줄어든다.
    expect(body.indexOf("3rem")).toBeLessThan(body.indexOf("* 8"));
  });
});

describe("#5206 같은 이름 DM의 핸들은 통째로 보이거나 통째로 숨고, title·낭독 이름에 든다", () => {
  const slot = utilityBody("channel-head-handle");

  it("핸들 칸은 한 줄 높이에서 줄바꿈하고 넘치는 둘째 줄을 숨긴다", () => {
    // 칸은 flex 상자다(핸들을 둘째 줄로 보내려면 `display: flex`가 있어야 하고, 없애면 핸들이 통째로 사라진다).
    expect(slot).toMatch(/display: flex;\s*flex-wrap: wrap;/);
    expect(slot).toMatch(/overflow: hidden;/);
    expect(slot).toMatch(/block-size: var\(--text-meta--line-height\);/);
    // 칸은 핸들의 글 폭까지만 자란다(그 이상은 제목의 몫).
    expect(slot).toMatch(/max-inline-size: max-content;/);
    expect(slot).toMatch(/flex: 100 1 0;/);
  });

  it("칸 맨 앞의 폭 0짜리 조각이 높이를 가져 첫 줄을 차지한다(없으면 핸들이 칸보다 넓어도 첫 줄에 남는다)", () => {
    const before = /&::before \{([\s\S]*?)\}/.exec(slot);
    expect(before).not.toBeNull();
    expect(before?.[1]).toMatch(/content: "";/);
    expect(before?.[1]).toMatch(/inline-size: 0;/);
    expect(before?.[1]).toMatch(/block-size: var\(--text-meta--line-height\);/);
  });

  it("DM 제목의 title은 핸들까지 담은 전체 이름(label)이고, 채널·스트레스 제목은 그대로다", () => {
    const titles = [...HEADER_CODE.matchAll(/<h1[\s\S]*?>/g)].map((match) => match[0]);
    expect(titles).toHaveLength(3);
    const dm = titles.filter((open) => /flex min-w-0 items-center/.test(open));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toMatch(/title=\{label\}/);
    expect(titles.filter((open) => /title=\{label\}/.test(open))).toHaveLength(1);
    // 낭독 이름도 label(핸들 포함): 이름 단추의 aria-label.
    expect(HEADER_CODE).toMatch(/aria-label=\{`\$\{label\} 프로필 열기`\}/);
  });
});

describe("#5184 허들 참가자 이름 글은 제목 칸의 꼬리에서 제목이 다 선 뒤 남는 폭만 받는다", () => {
  it("꼬리 칸은 기준 폭 0에서 남는 폭을 받고 스스로 컨테이너다", () => {
    const tail = utilityBody("channel-head-tail");
    expect(tail).toMatch(/flex: 1 1 0;/);
    expect(tail).toMatch(/min-inline-size: 0;/);
    expect(tail).toMatch(/container: channel-tail \/ inline-size;/);
    // 폰 폭에는 칸이 없다(안에 설 토픽·이름 글이 전부 `wide-only`라 빈 칸이 칸 틈 8을 제목에서 가져간다): 기본은 none, 600 이상에서 flex.
    expect(tail).toMatch(/display: none;/);
    expect(tail).toMatch(/@media \(width >= 600px\) \{\s*display: flex;\s*\}/);
  });

  it("이름 글은 꼬리 칸이 8rem 이상일 때만 선다(조각이 아니라 통째로 숨는다), 폰 폭에서는 서지 않는다", () => {
    const names = utilityBody("channel-head-names");
    // 기본은 숨김이다: 규칙의 맨 앞 선언이 `display: none`이어야 한다(중첩된 `[data-joined]` 규칙의 none과 헷갈리지 않게 맨 앞을 짚는다).
    expect(names).toMatch(/\{\s*display: none;\s*flex: 0 1 auto;/);
    expect(names).toMatch(
      /@media \(width >= 600px\) \{\s*@container channel-tail \(inline-size >= 8rem\) \{\s*display: block;/
    );
  });

  it("꼬리 칸에는 토픽과 허들 이름 글이 있고, 컨트롤 묶음에는 이름 글이 없다", () => {
    const tailAt = HEADER_CODE.indexOf('className="channel-head-tail"');
    const toolsAt = HEADER_CODE.indexOf('className="channel-head-tools ');
    expect(tailAt).toBeGreaterThan(0);
    const tail = HEADER_CODE.slice(tailAt, toolsAt);
    expect(tail).toContain('data-testid="channel-header-topic"');
    expect(tail).toContain("<HuddleHeaderNames");
    expect(HEADER_CODE.slice(toolsAt)).not.toContain("<HuddleHeaderNames");
    // 꼬리가 비면 칸 자체를 두지 않는다(빈 칸도 칸 틈 8을 제목에서 가져간다).
    expect(HEADER_CODE).toContain("headerTailShown(huddle) && (");
  });

  it("Live 칩은 이름 글을 품지 않는다(칩 폭이 컨트롤 묶음의 기본 폭을 부풀려 제목이 먼저 깎이던 결함)", () => {
    const chipAt = HUDDLE_CODE.indexOf("function HuddleLiveChip");
    const chip = HUDDLE_CODE.slice(chipAt, HUDDLE_CODE.indexOf("export function HuddleHeaderNames"));
    expect(chip).not.toContain('data-testid="huddle-participants"');
    expect(chip).not.toMatch(/truncate/);
    // 전문은 칩의 낭독과 title에 남는다.
    expect(chip).toMatch(/className="sr-only">\{huddleParticipantSummary\(huddle\)\}/);
    expect(chip).toMatch(/title=\{names\}/);
  });

  it("참가 중에는 전문이 칩 래퍼 밖의 sr-only 한 곳에 있다(칩이 양보해 display: none이 돼도 낭독에서 안 빠지고, 칩은 announce={false}라 둘로 안 읽힌다)", () => {
    expect(HUDDLE_CODE).toMatch(/<HuddleLiveChip huddle=\{huddle\.active\} announce=\{false\} \/>/);
    expect(HUDDLE_CODE).toMatch(/<span className="sr-only">\s*\{huddleParticipantSummary\(huddle\.active\)\}\s*<\/span>/);
    // 칩 자신의 낭독은 announce일 때만 선다.
    expect(HUDDLE_CODE).toMatch(/\{announce && \(\s*<span className="sr-only">\{huddleParticipantSummary\(huddle\)\}<\/span>\s*\)\}/);
  });

  it("이름 글은 aria-hidden(칩이 같은 전문을 낭독한다)이고, 참가 중에는 칩과 함께 양보한다", () => {
    const namesAt = HUDDLE_CODE.indexOf("export function HuddleHeaderNames");
    const names = HUDDLE_CODE.slice(namesAt, HUDDLE_CODE.indexOf("function HuddleIconButton"));
    expect(names).toMatch(/aria-hidden="true"/);
    // 참가 중이면 `data-joined`가 서고, tokens.css의 `[data-joined]` 규칙이 칩과 같은 문턱에서 이름 글을 접는다.
    expect(names).toMatch(/data-joined=\{huddle\.joined \|\| undefined\}/);
    // 참가 중 칩 래퍼도 같은 문턱의 규칙(`channel-head-live-joined`)을 받는다.
    expect(HUDDLE_CODE).toMatch(/className="wide-only channel-head-live-joined min-w-0"/);
  });

  it("참가 중 칩·이름은 머리 안쪽 폭이 26rem 밑이면 같은 문턱에서 양보하고, 머리가 그 컨테이너다", () => {
    const chip = utilityBody("channel-head-live-joined");
    expect(chip).toMatch(/@container channel-head \(inline-size < 26rem\) \{\s*display: none;/);
    // 이름 글은 속성 선택자(특이도가 높아 소스 순서와 무관하게 이긴다)로 같은 문턱에서 접는다.
    const names = utilityBody("channel-head-names");
    expect(names).toMatch(
      /&\[data-joined\] \{\s*@container channel-head \(inline-size < 26rem\) \{\s*display: none;/
    );
    expect(utilityBody("channel-head")).toMatch(/container: channel-head \/ inline-size;/);
  });
});

describe("#5206 ⋮는 혼자 한 줄에 서지 않는다: 바로 앞 컨트롤과 줄바꿈 한 덩어리다", () => {
  const end = renderControlsEndCode();

  it("허들 컨트롤이 있으면 허들과, 없으면 멤버 수와 한 덩어리(flex-nowrap)다", () => {
    // 덩어리는 줄지 않는 flex 한 줄이다(`shrink-0`): 단추를 줄이지 않고 줄바꿈 때 통째로 움직인다.
    expect(end.match(/className="flex shrink-0 items-center gap-1"/g)).toHaveLength(2);
    const glued = end.slice(end.indexOf("huddleControlShown(huddle, offline)"));
    // 감싸개에는 `data-testid`가 없다: 기존 `gate:channel-header`의 순서 읽기가 testid 없는 감싸개를 투명하게 걸어 들어간다.
    const unitOpen = '<div className="flex shrink-0 items-center gap-1">';
    // 첫 가지: 멤버 수는 덩어리 밖, 허들 + ⋮는 덩어리 안.
    const firstBranch = glued.slice(0, glued.indexOf(") : "));
    expect(firstBranch).toMatch(
      new RegExp(`\\{members\\}\\s*${unitOpen}\\s*\\{huddleControl\\}\\s*\\{menu\\}\\s*</div>`)
    );
    // 둘째 가지: 멤버 수 + ⋮가 덩어리 안.
    const secondBranch = glued.slice(glued.indexOf(") : "));
    expect(secondBranch).toMatch(
      new RegExp(`${unitOpen}\\s*\\{members\\}\\s*\\{menu\\}\\s*</div>`)
    );
  });

  it("⋮가 덩어리 밖에 따로 서는 곳이 없다(ChannelHeaderMenu는 이 함수 안에서 한 번만 만든다)", () => {
    expect(SHELL_CODE.match(/<ChannelHeaderMenu\b/g)).toHaveLength(1);
    expect(end.match(/<ChannelHeaderMenu\b/g)).toHaveLength(1);
    // 단추 크기·순서는 그대로: 덩어리는 단추를 줄이지 않는다.
    expect(end).not.toMatch(/\bhidden\b/);
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
