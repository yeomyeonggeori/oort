// =============================================================================
// 이어지는 행의 시각 자리 (#6026, owner 데스크탑 QA 2026-11-20).
//
// 머리 줄이 없는 이어지는 행의 시각(`data-row-clock`)은 올림 · 키보드 초점에서 선다(H-3). 옛 자리는 왼쪽 거터였고 owner는 줄
// **오른쪽**에 서기를 바랐다. 오른쪽은 늘 비어 있지 않다: 본문은 줄 폭을 다 쓰고(꽉 찬 줄), 위 · 아래 경계 띠에는 이웃의 글과 호버
// 막대가 선다. 막대처럼 띠에 걸치면 이웃 글자를 덮고, 막대에 실으면 막대가 넓어져 이웃 글자를 새로 덮는다(실측: 720 창에서 0 → 5자).
//
// 그래서 **잰 빈자리에만** 오른쪽에 세운다: 그 행 본문의 줄을 **맨 아래 줄부터** 훑어, 줄 오른끝(본문 오른끝)에 시각 폭 + 틈만큼
// 아무것도 없는 첫 줄의 가운데 높이에 세운다. 막는 것은 글줄 조각, 칠해진 상자(반응 칩 · 그림 · 코드 · 카드), 그리고 서 있는 호버
// 막대(행 안으로 밀려 앉은 자리 포함)다. 그런 줄이 없으면(모든 줄이 끝까지 찬 드문 행) 옛 거터 자리에 둔다 — 그 자리는 글자와
// 겹친 적이 없다. 자리는 절대 배치라 글은 한 픽셀도 움직이지 않는다.
//
// 이 파일은 고르는 규칙(`placeRowClock`, 순수 함수)과 DOM에서 재고 적는 일(`applyRowClockPlacement`)을 함께 둔다.
// =============================================================================

import { useLayoutEffect, type RefObject } from "react";
import { neighborTextRects } from "./hoverToolbarModel";

export interface RowClockRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 시각과 그 왼쪽의 글 · 상자 사이에 두는 틈(px). 머리 줄의 이름과 시각 사이(`gap-2`)와 같다. */
export const ROW_CLOCK_GAP_PX = 8;

/** 오른쪽에 선 시각의 표지. `tokens.css`의 놓는 규칙이 이것에 걸리고, 게이트 · 캡처가 시각이 어느 자리에 섰는지 읽는다(없으면 거터). */
export const ROW_CLOCK_SIDE_ATTRIBUTE = "data-row-clock-side";
/** 잰 자리(거터 칸 기준 px, 단위 없는 수)를 건네는 CSS 변수. `tokens.css`의 `[data-row-clock][data-row-clock-side]`가 읽는다. */
export const ROW_CLOCK_X_VAR = "--row-clock-x";
export const ROW_CLOCK_Y_VAR = "--row-clock-y";

function overlaps(a: RowClockRect, b: RowClockRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * 시각이 설 자리(뷰포트 좌표의 왼쪽 위)를 고른다. 없으면 `null`(= 거터에 둔다).
 * `lines`는 본문 글줄 조각, `boxes`는 칠해진 상자와 호버 막대다. 줄은 세로로 겹치는 조각을 한 띠로 묶고, 아래 띠부터 본다.
 */
export function placeRowClock(input: {
  body: Pick<RowClockRect, "right">;
  clock: { width: number; height: number };
  lines: readonly RowClockRect[];
  boxes: readonly RowClockRect[];
}): { left: number; top: number } | null {
  const { body, clock } = input;
  if (clock.width <= 0 || clock.height <= 0) return null;
  const bands: { top: number; bottom: number }[] = [];
  for (const line of [...input.lines].sort((a, b) => a.top - b.top)) {
    const last = bands[bands.length - 1];
    if (last && line.top < last.bottom) last.bottom = Math.max(last.bottom, line.bottom);
    else bands.push({ top: line.top, bottom: line.bottom });
  }
  const left = body.right - clock.width;
  const walls = [...input.lines, ...input.boxes];
  for (const band of bands.reverse()) {
    const top = band.top + (band.bottom - band.top - clock.height) / 2;
    const room = { left: left - ROW_CLOCK_GAP_PX, right: body.right, top, bottom: top + clock.height };
    if (walls.some((wall) => overlaps(room, wall))) continue;
    return { left, top };
  }
  return null;
}

const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "PICTURE", "INPUT", "TEXTAREA", "svg"]);

function painted(style: CSSStyleDeclaration): boolean {
  const bg = style.backgroundColor;
  const hasFill = bg !== "" && bg !== "transparent" && !/(,\s*0\)|\/\s*0\))$/.test(bg);
  const hasBorder = ["Top", "Right", "Bottom", "Left"].some(
    (side) => Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
  );
  return hasFill || hasBorder || style.backgroundImage !== "none";
}

/** 본문 안의 칠해진 상자: 그림 · 입력 같은 대체 요소, 바탕색 · 테두리 · 바탕 그림이 있는 요소. SVG 안쪽 조각은 SVG 하나로 센다. */
function paintedBoxes(body: Element): RowClockRect[] {
  const boxes: RowClockRect[] = [];
  for (const element of Array.from(body.querySelectorAll("*"))) {
    if (element instanceof SVGElement && element.ownerSVGElement !== null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    if (REPLACED.has(element.tagName) || painted(getComputedStyle(element))) boxes.push(rect);
  }
  return boxes;
}

/** 거터 자리로 되돌린다(클래스가 정한 `right-0 top-0`). */
export function clearRowClockPlacement(clock: HTMLElement | null): void {
  if (!clock || !clock.hasAttribute(ROW_CLOCK_SIDE_ATTRIBUTE)) return;
  clock.removeAttribute(ROW_CLOCK_SIDE_ATTRIBUTE);
  clock.style.removeProperty(ROW_CLOCK_X_VAR);
  clock.style.removeProperty(ROW_CLOCK_Y_VAR);
}

/**
 * 행을 재서 시각을 오른쪽 빈자리에 세우거나 거터에 둔다. 잰 자리는 CSS 변수로 건네고 놓는 규칙은 `tokens.css`에 있다(호버 막대의
 * `applyToolbarPlacement`와 같은 나눔, JSX `style`은 쓰지 않는다). 시각 자신의 크기만 읽으므로 지금 선 자리와 무관하다.
 */
export function applyRowClockPlacement(row: Element, clock: HTMLElement): void {
  const body = row.querySelector("[data-row-body]");
  const anchor = clock.offsetParent;
  if (!body || !anchor) return;
  const size = clock.getBoundingClientRect();
  const bar = row.querySelector('[data-testid="message-hover-toolbar"]');
  const spot = placeRowClock({
    body: body.getBoundingClientRect(),
    clock: { width: size.width, height: size.height },
    lines: neighborTextRects(row).filter((rect) => rect.width > 1 && rect.height > 1),
    boxes: [...paintedBoxes(body), ...(bar ? [bar.getBoundingClientRect()] : [])],
  });
  if (!spot) {
    clearRowClockPlacement(clock);
    return;
  }
  const origin = anchor.getBoundingClientRect();
  const x = String(Math.round((spot.left - origin.left) * 100) / 100);
  const y = String(Math.round((spot.top - origin.top) * 100) / 100);
  if (
    clock.hasAttribute(ROW_CLOCK_SIDE_ATTRIBUTE) &&
    clock.style.getPropertyValue(ROW_CLOCK_X_VAR) === x &&
    clock.style.getPropertyValue(ROW_CLOCK_Y_VAR) === y
  ) {
    return;
  }
  clock.style.setProperty(ROW_CLOCK_X_VAR, x);
  clock.style.setProperty(ROW_CLOCK_Y_VAR, y);
  clock.setAttribute(ROW_CLOCK_SIDE_ATTRIBUTE, "end");
}

/** 시각이 사라지는 페이드(`transition-opacity`, 150ms)가 끝난 뒤에 거터로 되돌린다: 보이는 채로 자리를 옮기지 않는다. */
const CLEAR_AFTER_FADE_MS = 200;

/**
 * 행이 「서 있는」 동안(올림 · 키보드 초점) 시각의 자리를 재고, 행 · 막대가 바뀌면 다시 잰다. `reset`(고치는 중 · 글을 고르는 중)이면
 * 곧바로 거터로 되돌린다 — 편집기 · 고른 글 위에 낡은 자리가 남지 않게. 서지 않게 되면 페이드가 끝난 뒤 거터로 되돌린다: 그 뒤에
 * 마우스로 둔 초점(`focus-within`)만으로 시각이 보일 때 그 자리는 언제나 글자와 겹친 적이 없는 거터다.
 */
export function useRowClockPlacement(
  rowRef: RefObject<HTMLElement | null>,
  clockRef: RefObject<HTMLElement | null>,
  active: boolean,
  reset: boolean
): void {
  useLayoutEffect(() => {
    if (reset) clearRowClockPlacement(clockRef.current);
  }, [reset, clockRef]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const clock = clockRef.current;
    if (!row || !clock) return undefined;
    if (!active) {
      const timer = setTimeout(() => clearRowClockPlacement(clock), CLEAR_AFTER_FADE_MS);
      return () => clearTimeout(timer);
    }
    const place = () => applyRowClockPlacement(row, clock);
    place();
    const cleanups: (() => void)[] = [];
    const Resize = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Resize) {
      const body = row.querySelector("[data-row-body]");
      const resize = new Resize(() => place());
      resize.observe(row);
      if (body) resize.observe(body);
      cleanups.push(() => resize.disconnect());
    }
    // 막대가 서고 · 뒤집히고 · 안으로 밀리면(`data-straddle`, 막대의 CSS 변수) 다시 잰다. 시각 자신의 자리 적기는 세지 않는다.
    if (typeof MutationObserver !== "undefined") {
      const mutations = new MutationObserver((records) => {
        if (records.every((record) => record.target === clock)) return;
        place();
      });
      mutations.observe(row, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-straddle", "style"] });
      cleanups.push(() => mutations.disconnect());
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [active, rowRef, clockRef]);
}
