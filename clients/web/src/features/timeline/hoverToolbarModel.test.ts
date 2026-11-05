import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PICKER_EMOJI } from "@/features/emoji/EmojiPickerDialog";
import { HOVER_TOOLBAR_NEIGHBOR_SELECTOR } from "../../../scripts/lib/hoverToolbarOverlap.mjs";
import {
  belowStraddleRect,
  HOVER_TOOLBAR_NUDGE_VAR,
  HOVER_TOOLBAR_REACTION_SEED,
  HOVER_TOOLBAR_SLIDE_VAR,
  HOVER_TOOLBAR_SLOT_COUNT,
  placeToolbar,
  rectsIntersect,
  restToolbarRect,
  shouldFlipToolbarBelow,
  shouldShowHoverToolbar,
  slideToolbarDown,
  TOOLBAR_NEIGHBOR_SELECTOR,
  toolbarClipsScrollerTop,
} from "./hoverToolbarModel";

const actionsSource = readFileSync(
  fileURLToPath(new URL("./MessageActions.tsx", import.meta.url)),
  "utf8"
);

describe("shouldShowHoverToolbar", () => {
  const rest = {
    pointerCanHover: true,
    editing: false,
    rowHovered: false,
    rowFocused: false,
    overlayOpen: false,
    selecting: false,
  };

  it("비호버·비포커스 행에는 안 뜬다", () => {
    expect(shouldShowHoverToolbar(rest)).toBe(false);
  });

  it("hover 또는 focus-within 이면 뜬다", () => {
    expect(shouldShowHoverToolbar({ ...rest, rowHovered: true })).toBe(true);
    expect(shouldShowHoverToolbar({ ...rest, rowFocused: true })).toBe(true);
  });

  it("열린 오버레이가 있으면 포인터가 떠나도 유지한다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, overlayOpen: true })
    ).toBe(true);
  });

  it("본문 선택은 툴바를 내린다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, rowHovered: true, selecting: true })
    ).toBe(false);
  });

  it("선택은 열린 오버레이를 이기지 못한다", () => {
    expect(
      shouldShowHoverToolbar({
        ...rest,
        selecting: true,
        overlayOpen: true,
      })
    ).toBe(true);
  });

  it("이웃 행 배너가 열려 있으면 툴바를 달지 않는다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, rowHovered: true, neighborBannerOpen: true })
    ).toBe(false);
    expect(
      shouldShowHoverToolbar({
        ...rest,
        overlayOpen: true,
        neighborBannerOpen: true,
      })
    ).toBe(false);
  });

  it("터치와 편집 중에는 절대 안 뜬다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, pointerCanHover: false, rowHovered: true })
    ).toBe(false);
    expect(
      shouldShowHoverToolbar({ ...rest, editing: true, rowHovered: true })
    ).toBe(false);
    expect(
      shouldShowHoverToolbar({
        ...rest,
        pointerCanHover: false,
        overlayOpen: true,
      })
    ).toBe(false);
  });
});

describe("행 배너 「닫기」와 이웃 툴바 기하 (M-6, geometry-probe-only)", () => {
  it("probe 400 배너의 「닫기」와 위 straddle 툴바가 겹치면 실패한다", () => {
    const close = { left: 1840, right: 1973, top: 674, bottom: 706 };
    const toolbar = { left: 1693, right: 1973, top: 700, bottom: 750 };
    expect(rectsIntersect(close, toolbar)).toBe(true);
  });

  it("배너 아래에 스트래들 띠를 비우면 「닫기」와 툴바가 겹치지 않는다", () => {
    const close = { left: 1840, right: 1973, top: 642, bottom: 674 };
    const toolbar = { left: 1693, right: 1973, top: 700, bottom: 750 };
    expect(rectsIntersect(close, toolbar)).toBe(false);
  });

});

describe("toolbarClipsScrollerTop", () => {
  it("스크롤러 높이가 없으면 뒤집지 않는다", () => {
    expect(
      toolbarClipsScrollerTop({ top: -10 }, { top: 0, height: 0 })
    ).toBe(false);
  });

  it("툴바 상단이 스크롤러 상단을 침범하면 뒤집는다", () => {
    expect(
      toolbarClipsScrollerTop({ top: 18 }, { top: 45, height: 700 })
    ).toBe(true);
  });

  it("여유가 있으면 위 straddle을 유지한다", () => {
    expect(
      toolbarClipsScrollerTop({ top: 80 }, { top: 45, height: 700 })
    ).toBe(false);
  });
});

// 390 열의 숫자 그대로(#5179 레인 실측): 막대 x 151~374, 위 자리 y 329~371(키 42), 포인터 행 y 365~399, 앞 행 마지막 줄 x 56~214 y 337~355.
describe("shouldFlipToolbarBelow (#5179)", () => {
  const bar = { left: 151, right: 374, top: 329, bottom: 371 };
  const row = { top: 365, bottom: 399 };
  const scroller = { top: 120, bottom: 800, height: 680 };
  const reaching = { left: 56, right: 214, top: 337, bottom: 355 };
  const short = { left: 56, right: 121, top: 337, bottom: 355 };
  const nextHead = { left: 56, right: 150, top: 415, bottom: 433 };
  const nextLong = { left: 56, right: 360, top: 410, bottom: 428 };
  const never = () => {
    throw new Error("이 이웃은 재면 안 된다");
  };

  it("아래 자리는 위 자리와 같은 산식으로 선다: 행 하단에서 행 안 깊이만큼 위", () => {
    // 위 자리의 막대 하단이 행 안으로 6 들어온다 → 아래 자리의 상단은 행 하단 − 6, 키는 그대로.
    expect(belowStraddleRect(bar, row)).toEqual({ left: 151, right: 374, top: 393, bottom: 435 });
  });

  it("앞 이웃 글자에 안 닿으면 위 그대로이고 뒤 이웃은 재지도 않는다", () => {
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [short], nextText: never })).toBe(false);
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [], nextText: never })).toBe(false);
  });

  it("앞 이웃 마지막 줄을 덮고 아래 자리는 뒤 이웃 글자를 안 덮으면 아래로 뒤집는다", () => {
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [reaching], nextText: () => [nextHead] })).toBe(true);
  });

  it("아래로 뒤집으면 뒤 이웃 글자를 새로 덮을 때는 위 그대로다(한 겹침을 다른 겹침으로 바꾸지 않는다)", () => {
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [reaching], nextText: () => [nextLong] })).toBe(false);
  });

  it("아래 자리가 스크롤러 아래로 잘리면 위 그대로다", () => {
    const tight = { top: 120, bottom: 420, height: 300 };
    expect(shouldFlipToolbarBelow({ bar, row, scroller: tight, prevText: () => [reaching], nextText: () => [] })).toBe(false);
  });

  it("위가 스크롤러 위에 막히면 이웃을 재기 전에 뒤집는다(옛 규칙 H-4가 먼저)", () => {
    const clipped = { top: 340, bottom: 800, height: 460 };
    expect(shouldFlipToolbarBelow({ bar, row, scroller: clipped, prevText: never, nextText: never })).toBe(true);
  });

  it("행을 못 찾으면(타임라인 밖) 이웃 글자는 보지 않고 위 그대로다", () => {
    expect(shouldFlipToolbarBelow({ bar, row: null, scroller, prevText: never, nextText: never })).toBe(false);
  });
});

// 레인(`capture-5179.mjs`) 390 열 실측의 숫자 그대로: 막대 x 151~374(키 42), 포인터 행 y 365~401, 스크롤러 y 57~709. 앞 행 글줄은 막대 밑까지 오고(x 56~292),
// 짧은 포인터 행 글은 안 온다(x 56~116).
describe("slideToolbarDown (#5179 남은 경우 C·F·H)", () => {
  const bar = { left: 151, right: 374, top: 329, bottom: 371 };
  const row = { top: 365, bottom: 401 };
  const scroller = { bottom: 709, height: 652 };
  const prevLast = { left: 56, right: 292, top: 337, bottom: 355 };
  const ownShort = { left: 56, right: 116, top: 374, bottom: 392 };
  const nextLong = { left: 56, right: 360, top: 410, bottom: 428 };

  it("C: 앞 글줄 바로 밑으로 민다 — 앞 글줄 밑단 355 + 틈 2 = 막대 윗단 357(밀림 28)", () => {
    // 짧은 포인터 행 글(x 56~116)은 막대 가로 범위(151~374) 밖이라 막지 않는다. 막대 밑단 357 + 42 = 399 는 뒤 글줄 윗단 410 에 닿지 않는다.
    expect(slideToolbarDown({ bar, row, scroller, text: [prevLast, ownShort, nextLong] })).toBe(28);
  });

  it("F: 마지막 행 — 아래 여유 없이도 앞 글줄 밑 창에 선다(막대 밑단 707 ≤ 스크롤러 바닥 709)", () => {
    const lastBar = { left: 151, right: 374, top: 637, bottom: 679 };
    const lastRow = { top: 673, bottom: 709 };
    const text = [{ left: 56, right: 279, top: 645, bottom: 663 }, { left: 56, right: 116, top: 682, bottom: 700 }];
    expect(slideToolbarDown({ bar: lastBar, row: lastRow, scroller, text })).toBe(28);
  });

  it("H: 머리 행 — 머리 줄 이름(x 56~82)은 막대 밖이라 비어 있고, 본문 첫 줄 윗단이 창의 아래를 정한다(틈은 위 2 · 아래 3)", () => {
    const headBar = { left: 151, right: 374, top: 302, bottom: 344 };
    const headRow = { top: 338, bottom: 427 };
    const text = [
      { left: 56, right: 282, top: 311, bottom: 329 }, // 앞 행 끝줄
      { left: 56, right: 82, top: 352, bottom: 370 }, // 머리 줄: 이름
      { left: 56, right: 373, top: 376, bottom: 394 }, // 본문 첫 줄
      { left: 56, right: 335, top: 400, bottom: 418 }, // 본문 둘째 줄
      { left: 56, right: 360, top: 436, bottom: 454 }, // 뒤 행 첫 줄
    ];
    expect(slideToolbarDown({ bar: headBar, row: headRow, scroller, text })).toBe(29);
  });

  it("R: 이어짐 행의 한 줄 글이 막대 밑까지 오고 앞·뒤 글줄도 그렇다 — 세 줄 사이에 42px 창이 없다", () => {
    const text = [
      { left: 56, right: 271, top: 338, bottom: 356 },
      { left: 56, right: 254, top: 374, bottom: 392 },
      { left: 56, right: 241, top: 411, bottom: 429 },
    ];
    expect(slideToolbarDown({ bar, row: { top: 365, bottom: 402 }, scroller, text })).toBeNull();
  });

  it("막대 가로 범위에 걸치는 글만 막는다 — 같은 높이에 있어도 왼쪽 글은 비켜 선다", () => {
    const left = { left: 56, right: 120, top: 340, bottom: 400 };
    // 앞 글줄만 남기면 막대는 그 밑으로 내려오고, 왼쪽 글(x ≤ 120)은 몇 줄이 있어도 창을 줄이지 않는다.
    expect(slideToolbarDown({ bar, row, scroller, text: [prevLast, left, left, nextLong] })).toBe(28);
    // 같은 글을 막대 밑(x 160~300)으로 옮기면 막는다: 앞 글줄 밑 357~399 가 그 글(340~400)에 덮여 창이 없다.
    expect(slideToolbarDown({ bar, row, scroller, text: [prevLast, { ...left, left: 160, right: 300 }, nextLong] })).toBeNull();
  });

  it("창이 좁으면 위·아래 틈을 같게 나눈다(앞 글줄 밑단 355 ~ 뒤 글줄 윗단 400 사이 막대 키 42 → 여유 3 → 1.5씩)", () => {
    const tight = { left: 56, right: 360, top: 400, bottom: 418 };
    expect(slideToolbarDown({ bar, row, scroller, text: [prevLast, tight] })).toBe(27.5);
  });

  it("창이 막대 키보다 좁으면 없다(앞 글줄 밑단 355 ~ 뒤 글줄 윗단 396 = 41)", () => {
    expect(slideToolbarDown({ bar, row, scroller, text: [prevLast, { left: 56, right: 360, top: 396, bottom: 414 }] })).toBeNull();
  });

  it("스크롤러 바닥 밖으로 잘리는 자리는 뺀다(막대 밑단이 스크롤러 바닥을 넘으면 없다)", () => {
    const lastBar = { left: 151, right: 374, top: 637, bottom: 679 };
    const lastRow = { top: 673, bottom: 709 };
    const text = [{ left: 56, right: 279, top: 645, bottom: 663 }];
    expect(slideToolbarDown({ bar: lastBar, row: lastRow, scroller: { bottom: 709, height: 652 }, text })).toBe(28);
    expect(slideToolbarDown({ bar: lastBar, row: lastRow, scroller: { bottom: 700, height: 643 }, text })).toBeNull();
  });

  it("행에 붙은 채여야 한다 — 아래 자리(행 하단 − 행 안 깊이) 밑으로는 밀지 않는다", () => {
    // 막대 밑을 덮는 글 덩어리가 y 340~398 까지 이어져, 그 밑으로 내려오면 막대 윗단이 398 이다 — 아래 자리 윗단(행 하단 401 − 행 안 깊이 6 = 395)보다
    // 아래라 행에서 떨어진다.
    const tall = { left: 56, right: 292, top: 340, bottom: 398 };
    expect(slideToolbarDown({ bar, row, scroller, text: [tall] })).toBeNull();
    // 395 에서 끝나면 막대 윗단이 아래 자리 윗단(395)에 딱 선다(밀림 66, 틈은 0). 393 에서 끝나면 틈을 반으로 나눈다(밀림 65).
    expect(slideToolbarDown({ bar, row, scroller, text: [{ ...tall, bottom: 395 }] })).toBe(66);
    expect(slideToolbarDown({ bar, row, scroller, text: [{ ...tall, bottom: 393 }] })).toBe(65);
  });

  it("위 자리가 이미 비어 있으면 0이다(틈을 더하지 않는다)", () => {
    expect(slideToolbarDown({ bar, row, scroller, text: [{ left: 56, right: 121, top: 337, bottom: 355 }] })).toBe(0);
    expect(slideToolbarDown({ bar, row, scroller, text: [] })).toBe(0);
  });

  it("막대 CSS 변수 이름은 tokens.css 의 위 straddle 이 읽는 이름이다", () => {
    expect(HOVER_TOOLBAR_SLIDE_VAR).toBe("--hover-toolbar-slide");
    const css = readFileSync(fileURLToPath(new URL("../../design/tokens.css", import.meta.url)), "utf8");
    expect(css).toMatch(/@utility hover-toolbar-straddle \{[^}]*var\(--hover-toolbar-slide, 0\) \* 1px/);
    // 아래 자리는 밀지 않는다: 밀림은 위 자리에서 아래로만 민다.
    expect(css).not.toMatch(/@utility hover-toolbar-straddle-below \{[^}]*--hover-toolbar-slide/);
  });

  it("가로 비끼기 변수는 위·아래 두 straddle 이 모두 읽는다", () => {
    expect(HOVER_TOOLBAR_NUDGE_VAR).toBe("--hover-toolbar-nudge");
    const css = readFileSync(fileURLToPath(new URL("../../design/tokens.css", import.meta.url)), "utf8");
    expect(css).toMatch(/@utility hover-toolbar-straddle \{[^}]*var\(--hover-toolbar-nudge, 0\) \* 1px/);
    expect(css).toMatch(/@utility hover-toolbar-straddle-below \{[^}]*var\(--hover-toolbar-nudge, 0\) \* 1px/);
  });
});

describe("placeToolbar (#5179): 위 → 아래로 뒤집기 → 행 안쪽으로 밀기", () => {
  const bar = { left: 151, right: 374, top: 329, bottom: 371 };
  const row = { top: 365, bottom: 399 };
  const scroller = { top: 57, bottom: 709, height: 652 };
  const reaching = { left: 56, right: 214, top: 337, bottom: 355 };
  const short = { left: 56, right: 121, top: 337, bottom: 355 };
  const nextHead = { left: 56, right: 82, top: 415, bottom: 433 };
  const nextLong = { left: 56, right: 360, top: 410, bottom: 428 };
  const ownShort = { left: 56, right: 116, top: 374, bottom: 392 };
  const ownLong = { left: 56, right: 254, top: 374, bottom: 392 };
  const never = () => {
    throw new Error("이 글은 재면 안 된다");
  };

  it("A·B 회귀: 앞 글줄을 덮고 아래 자리가 비면 아래로 뒤집는다(밀지 않는다)", () => {
    expect(placeToolbar({ bar, row, scroller, prevText: () => [reaching], selfText: never, nextText: () => [nextHead] })).toEqual({ below: true, slide: 0, nudge: 0 });
  });

  it("E 회귀: 위가 스크롤러 위에 막히면 이웃을 재기 전에 뒤집는다", () => {
    const clipped = { top: 340, bottom: 800, height: 460 };
    expect(placeToolbar({ bar, row, scroller: clipped, prevText: never, selfText: never, nextText: never })).toEqual({ below: true, slide: 0, nudge: 0 });
  });

  it("D 회귀: 앞 글줄이 막대에 안 닿으면 위 그대로이고 포인터 행·뒤 이웃은 재지도 않는다", () => {
    expect(placeToolbar({ bar, row, scroller, prevText: () => [short], selfText: never, nextText: never })).toEqual({ below: false, slide: 0, nudge: 0 });
  });

  it("행을 못 찾으면(타임라인 밖) 이웃 글자는 보지 않고 위 그대로다", () => {
    expect(placeToolbar({ bar, row: null, scroller, prevText: never, selfText: never, nextText: never })).toEqual({ below: false, slide: 0, nudge: 0 });
  });

  it("C: 앞 글줄을 덮는데 아래 자리가 뒤 글줄을 덮으면 위 그대로 두지 않고 행 안쪽으로 민다", () => {
    expect(placeToolbar({ bar, row, scroller, prevText: () => [reaching], selfText: () => [ownShort], nextText: () => [nextLong] })).toEqual({ below: false, slide: 28, nudge: 0 });
  });

  it("F: 아래 자리가 스크롤러 밖으로 잘리는 마지막 행도 행 안쪽으로 민다", () => {
    const lastBar = { left: 151, right: 374, top: 637, bottom: 679 };
    const lastRow = { top: 673, bottom: 709 };
    const lastScroller = { top: 57, bottom: 709, height: 652 };
    const prev = { left: 56, right: 279, top: 645, bottom: 663 };
    expect(placeToolbar({ bar: lastBar, row: lastRow, scroller: lastScroller, prevText: () => [prev], selfText: () => [], nextText: () => [] })).toEqual({ below: false, slide: 28, nudge: 0 });
  });

  it("R: 포인터 행 글도 막대 밑까지 오면 창이 없다 — 위 그대로(겹침이 남는다)", () => {
    expect(placeToolbar({ bar, row, scroller, prevText: () => [reaching], selfText: () => [ownLong], nextText: () => [nextLong] })).toEqual({ below: false, slide: 0, nudge: 0 });
  });

  it("뒤 글줄이 가까워 창이 막대 키(42)보다 좁으면 밀지 않는다(앞 글줄 밑단 355 ~ 뒤 글줄 윗단 390 = 35)", () => {
    const nearNext = { left: 56, right: 360, top: 390, bottom: 408 };
    expect(placeToolbar({ bar, row, scroller, prevText: () => [reaching], selfText: () => [ownShort], nextText: () => [nearNext] })).toEqual({ below: false, slide: 0, nudge: 0 });
  });

  // 720 창(사이드바가 선 데스크탑 폭) 실측의 숫자 그대로: 막대 x 465~688, 3글자 이름의 머리 줄은 이름 x 388~427 · 시각 x 435~466 — 시각 오른끝이 막대 왼쪽 끝(465)을 1px 넘는다.
  describe("가로 비끼기 (720 창 + 3글자 이름 경계)", () => {
    const bar720 = { left: 465, right: 688, top: 340, bottom: 382 };
    const row720 = { top: 376, bottom: 412 };
    const scroller720 = { top: 68, bottom: 720, height: 652 };
    const head = (top: number) => [
      { left: 388, right: 427, top, bottom: top + 18 }, // 이름
      { left: 435, right: 466, top, bottom: top + 18 }, // 시각: 막대 왼쪽 끝 465 를 1px 넘는다
    ];

    it("A: 다음 행 머리 줄의 시각이 아래 자리를 1px 막으면 1px 비껴 아래로 뒤집는다", () => {
      const prev = [{ left: 388, right: 572, top: 348, bottom: 366 }];
      expect(placeToolbar({ bar: bar720, row: row720, scroller: scroller720, prevText: () => prev, selfText: never, nextText: () => head(426) })).toEqual({ below: true, slide: 0, nudge: 1 });
    });

    it("D: 앞 머리 줄의 시각이 위 자리를 1px 덮어도 1px 비껴 위 그대로 선다(밀지 않는다 — 움직임이 작은 쪽이 먼저)", () => {
      expect(placeToolbar({ bar: bar720, row: row720, scroller: scroller720, prevText: () => head(345), selfText: never, nextText: () => head(426) })).toEqual({ below: false, slide: 0, nudge: 1 });
    });

    it("H: 포인터 행 자신의 머리 줄 시각이 창을 1px 막으면 1px 비껴 앞 글줄 밑으로 민다", () => {
      const headBar = { left: 465, right: 688, top: 313, bottom: 355 };
      const headRow = { top: 349, bottom: 438 };
      const own = [...head(363), { left: 388, right: 680, top: 387, bottom: 405 }, { left: 388, right: 680, top: 411, bottom: 429 }];
      const prev = [{ left: 388, right: 627, top: 322, bottom: 340 }];
      const next = [{ left: 388, right: 679, top: 447, bottom: 465 }];
      expect(placeToolbar({ bar: headBar, row: headRow, scroller: scroller720, prevText: () => prev, selfText: () => own, nextText: () => next })).toEqual({ below: false, slide: 29, nudge: 1 });
    });

    it("2px보다 깊이 닿는 글은 비껴서 풀 일이 아니다 — 위 그대로(남은 경우)", () => {
      const deep = [{ left: 388, right: 470, top: 363, bottom: 381 }]; // 막대 왼쪽 끝을 5px 넘는 머리 줄
      const headBar = { left: 465, right: 688, top: 313, bottom: 355 };
      const own = [...deep, { left: 388, right: 680, top: 387, bottom: 405 }, { left: 388, right: 680, top: 411, bottom: 429 }];
      const prev = [{ left: 388, right: 627, top: 322, bottom: 340 }];
      const next = [{ left: 388, right: 679, top: 447, bottom: 465 }];
      expect(placeToolbar({ bar: headBar, row: { top: 349, bottom: 438 }, scroller: scroller720, prevText: () => prev, selfText: () => own, nextText: () => next })).toEqual({ below: false, slide: 0, nudge: 0 });
    });

    it("비끼지 않아도 되는 자리는 비끼지 않는다(390 열: 머리 줄 오른끝 134 < 막대 왼쪽 끝 151)", () => {
      const prev = [{ left: 56, right: 214, top: 337, bottom: 355 }];
      const next = [{ left: 56, right: 82, top: 415, bottom: 433 }, { left: 90, right: 121, top: 415, bottom: 433 }];
      expect(placeToolbar({ bar, row, scroller, prevText: () => prev, selfText: never, nextText: () => next })).toEqual({ below: true, slide: 0, nudge: 0 });
    });
  });

  it("앞 이웃·뒤 이웃은 각각 한 번만 잰다(뒤집기 판정과 밀기 판정이 같은 값을 나눠 쓴다)", () => {
    let prevReads = 0;
    let nextReads = 0;
    placeToolbar({
      bar,
      row,
      scroller,
      prevText: () => ((prevReads += 1), [reaching]),
      selfText: () => [ownShort],
      nextText: () => ((nextReads += 1), [nextLong]),
    });
    expect([prevReads, nextReads]).toEqual([1, 1]);
  });
});

describe("restToolbarRect (#5307 M1): 서 있는 자리에서 위 자리 상자를 되돌린다", () => {
  const rest = { left: 151, right: 374, top: 329, bottom: 371 };
  const row = { top: 365, bottom: 399 };
  const scroller = { top: 57, bottom: 709, height: 652 };
  const shift = (r: typeof rest, dx: number, dy: number) => ({ left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy });
  const reaching = { left: 56, right: 214, top: 337, bottom: 355 };
  const nextHead = { left: 56, right: 82, top: 415, bottom: 433 };
  const nextLong = { left: 56, right: 360, top: 410, bottom: 428 };
  const ownShort = { left: 56, right: 116, top: 374, bottom: 392 };

  it("위 자리 그대로(밀림·비낌 없음)면 서 있는 상자가 곧 위 자리 상자다", () => {
    expect(restToolbarRect({ bar: rest, row, placed: { below: false, slide: 0, nudge: 0 } })).toEqual(rest);
  });

  it("밀려 앉고 비껴 선 자리에서도 위 자리 상자를 되돌린다(밀림 28 · 비낌 1)", () => {
    expect(restToolbarRect({ bar: shift(rest, 1, 28), row, placed: { below: false, slide: 28, nudge: 1 } })).toEqual(rest);
  });

  it("아래로 뒤집힌 자리에서도 되돌린다: `belowStraddleRect`의 역이다", () => {
    const below = shift(belowStraddleRect(rest, row), 2, 0);
    expect(restToolbarRect({ bar: below, row, placed: { below: true, slide: 0, nudge: 2 } })).toEqual(rest);
  });

  it("행 밑단이 움직여도(행이 자라거나 줄어도) 위 자리 상자는 행 윗단에 매인다 — 다시 잴 때 옛 깊이를 끌고 가지 않는다", () => {
    const grown = { top: 365, bottom: 480 };
    const below = belowStraddleRect(rest, grown);
    expect(restToolbarRect({ bar: below, row: grown, placed: { below: true, slide: 0, nudge: 0 } })).toEqual(rest);
  });

  // 다시 재도 흔들리지 않는다: 어느 자리가 나오든 그 자리에 선 상자에서 되돌려 다시 재면 같은 자리다(깜빡임·핑퐁이 없다는 뜻).
  it.each([
    ["A·B 아래로 뒤집힘", { prev: [reaching], self: [], next: [nextHead] }],
    ["C 행 안쪽으로 밀림", { prev: [reaching], self: [ownShort], next: [nextLong] }],
    ["D 위 그대로", { prev: [], self: [], next: [] }],
  ])("%s: 되돌려 다시 재면 같은 자리다", (_name, text) => {
    const input = { row, scroller, prevText: () => text.prev, selfText: () => text.self, nextText: () => text.next };
    const first = placeToolbar({ ...input, bar: rest });
    const placedRect = shift(first.below ? belowStraddleRect(rest, row) : shift(rest, 0, first.slide), first.nudge, 0);
    const back = restToolbarRect({ bar: placedRect, row, placed: first });
    expect(back).toEqual(rest);
    expect(placeToolbar({ ...input, bar: back })).toEqual(first);
  });

  it("레이아웃이 바뀐 뒤에는 자리가 바뀐다: 마운트 때 아래 자리가 스크롤러 안이었어도 스크롤러가 줄어 밖이 되면 아래로 두지 않는다(M1)", () => {
    const text = { prevText: () => [reaching], selfText: () => [ownShort], nextText: () => [nextHead] };
    const mounted = placeToolbar({ bar: rest, row, scroller, ...text });
    expect(mounted).toEqual({ below: true, slide: 0, nudge: 0 });
    // 입력창 위에 작업 띠가 서서 스크롤러 바닥이 행 밑단(399) 근처로 올라온다. 아래 자리 밑단(399 − 6 + 42 = 435)이 바닥(420)을 넘는다.
    const shrunk = { top: 57, bottom: 420, height: 363 };
    const placedRect = belowStraddleRect(rest, row);
    const back = restToolbarRect({ bar: placedRect, row, placed: mounted });
    const again = placeToolbar({ bar: back, row, scroller: shrunk, ...text });
    expect(again.below).toBe(false);
    // 아래로 둔 채였다면 막대 밑단이 스크롤러 밖이다 — 이것이 검수가 본 「단추 0/6」이다.
    expect(placedRect.bottom).toBeGreaterThan(shrunk.bottom);
    const settled = shift(rest, again.nudge, again.slide);
    expect(settled.bottom).toBeLessThanOrEqual(shrunk.bottom);
    expect(settled.top).toBeGreaterThanOrEqual(shrunk.top);
  });
});

describe("이웃 목록 (#5179)", () => {
  it("뒤집기 규칙의 이웃 목록은 겹침 단정의 자와 같은 목록이다(자가 본 칸을 규칙도 본다)", () => {
    expect(TOOLBAR_NEIGHBOR_SELECTOR).toBe(HOVER_TOOLBAR_NEIGHBOR_SELECTOR);
  });
});

describe("슬롯 시드", () => {
  it("큐레이션 3종은 피커 어휘 안에 있다", () => {
    expect(HOVER_TOOLBAR_REACTION_SEED).toHaveLength(HOVER_TOOLBAR_SLOT_COUNT);
    for (const glyph of HOVER_TOOLBAR_REACTION_SEED) {
      expect(PICKER_EMOJI).toContain(glyph);
    }
  });
});

describe("B11 리버트 원인 — 소스 계약", () => {
  it("툴바는 단일 frequency store 를 쓰고 새 store 를 만들지 않는다", () => {
    expect(actionsSource).toContain("useFrequentEmojis");
    expect(actionsSource).toContain("HOVER_TOOLBAR_REACTION_SEED");
    expect(actionsSource).not.toContain("localStorage");
  });

  it("MessageHoverToolbar 본체는 opacity/visibility 트릭을 쓰지 않는다", () => {
    const start = actionsSource.indexOf("export function MessageHoverToolbar");
    expect(start).toBeGreaterThan(0);
    const next = actionsSource.indexOf("\nexport function", start + 1);
    const body = actionsSource.slice(start, next === -1 ? undefined : next);
    expect(body).not.toMatch(/opacity-0|invisible|visibility-hidden/);
    expect(body).toContain('role="toolbar"');
    expect(body).toContain("data-toolbar-item");
    expect(body).not.toContain("stopPropagation");
  });
});
