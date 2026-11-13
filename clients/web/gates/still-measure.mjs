// 흔들림 장면표의 재는 스크립트 (#5641) — 장면 게이트 · 실제 앱 공용.
//
// 「대화 흔들림 0」을 버그마다 따로 재지 않고 한 자로 잰다. 프레임마다 적은 위치 열(창 좌표의 px, 그 프레임에 줄이 없으면 null)에서
// 숫자 넷을 낸다(사람이 스크롤하지 않은 구간):
//   ① 되돌아옴 횟수 — 갔다가 돌아온 움직임. 마지막 꼭짓점에서 `MOVE_FLOOR_PX`(1px) 넘게 반대로 가면 1회다. 1px 아래의 떨림
//      (스크롤 위치는 정수, 상자 가장자리는 소수 — 지금 통과하는 장면도 0.75px 안팎이 남는다)은 세지 않는다.
//   ② 이유 없는 이동 px — 예상 이동이 0인 장면은 움직인 폭(최대−최소), 예상 이동이 있는 장면은 「움직인 폭 · 처음과 끝의 차이」가
//      예상과 다른 만큼(큰 쪽).
//   ③ 바닥 거리 — 모든 프레임의 `scrollHeight − scrollTop − clientHeight` 가운데 가장 큰 값.
//   ④ 저절로 선 「최신 메시지로 이동」 — 프레임에서 없다가 선 횟수와, 그 사이의 잠깐 붙음(MutationObserver) 중 큰 값.
// 예상 이동(새 줄이 붙어 위 줄이 올라감)은 「몇 번에 · 얼마나」를 따로 센다: `steps`(프레임 사이 0.5px 넘게 움직인 덩어리 수)와
// `net`(처음 → 끝). 한 사건이면 한 번 · 한 방향 · 기대 ± 1px 이어야 한다.
//
// 이 파일의 판정 함수는 순수하다(Playwright 없음). 브라우저 안에서 적는 쪽은 `startStillRecorder` 가 한다.
// 위치(px · 되돌아옴) 게이트다. 속도(fps) 게이트(`gate-scroll`)는 부하를 타는 본질이 달라 이 표에 섞지 않는다.

import { loadavg } from "node:os";

/** 되돌아옴 문턱(px). 이 폭을 넘게 반대로 가야 「돌아왔다」로 센다. */
export const MOVE_FLOOR_PX = 1;
/** 덩어리를 가르는 프레임 사이 변화(px). */
export const STEP_PX = 0.5;
/** 판정에 쓰는 기본 문턱(장면표 「0」 정의, screen-motion.md 5절). */
export const LIMITS = Object.freeze({ stillPx: 1, readingPx: 2, expectedPx: 1, gapPx: 1 });
/** 부하 문턱 기본값(1분 평균). 넘으면 그 장면은 「재지 않음」이다. */
export const DEFAULT_LOAD_MAX = 12;

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * 1 이상의 정수 환경 값(되풀이 횟수 같은 것). 비었으면 기본값, 숫자가 아니거나 1보다 작거나 정수가 아니면 **던진다** —
 * `REPEAT=abc` 가 NaN 이 되어 장면을 0번 돌고 PASS 를 내는 길을 막는다(#5644 검수 M1).
 */
export function positiveIntEnv(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${name}=${JSON.stringify(raw)}: 1 이상의 정수여야 한다`);
  }
  return Number(text);
}

/** 0보다 큰 수 환경 값(부하 문턱 같은 것). 비었으면 기본값, 아니면 던진다. */
export function positiveNumberEnv(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}=${JSON.stringify(raw)}: 0보다 큰 수여야 한다`);
  return value;
}

/** 쉼표 목록 환경 값. 허용 목록 밖의 이름이 하나라도 있으면 던진다(오타가 장면을 통째로 건너뛰지 않게). 비었으면 기본 목록. */
export function listEnv(name, allowed, fallback = allowed, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return [...fallback];
  const names = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error(`${name}=${JSON.stringify(raw)}: 빈 목록이다`);
  const unknown = names.filter((part) => !allowed.includes(part));
  if (unknown.length > 0) throw new Error(`${name}: 모르는 값 ${JSON.stringify(unknown)} (허용: ${allowed.join(",")})`);
  return names;
}

/**
 * 돈 장면이 0개면 통과가 아니다. 게이트의 마지막 판정 앞에서 부른다.
 * @returns {string | null} 실패 문장(0개일 때)
 */
export function nothingRan(count, label) {
  return count > 0 ? null : `${label}: 잰 장면이 0개다 — 0번 돌고 통과할 수 없다`;
}

/** 지금의 1분 평균 부하. */
export function loadNow() {
  return round2(loadavg()[0]);
}

/**
 * 위치 열 하나에서 움직임을 센다.
 * @param {(number|null|undefined)[]} series 프레임마다 한 값(창 좌표 px). null 은 그 프레임에 줄이 없음.
 * @returns {null | { samples: number, reversals: number, maxBackPx: number, range: number, net: number, steps: number, first: number, last: number, min: number, max: number }}
 */
export function motionOf(series, { floor = MOVE_FLOOR_PX, step = STEP_PX } = {}) {
  const values = series.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  let reversals = 0;
  let direction = 0;
  let pivot = values[0];
  // 한 방향으로 간 덩어리(다리)들: 되돌아감의 크기를 재려고 적는다(#5641 r1 M3 — 횟수만으로는 40px 되돌아감도 「2회」와 같다).
  const legs = [];
  let legStart = values[0];
  for (const value of values.slice(1)) {
    if (direction === 0) {
      if (value - pivot > floor) {
        direction = 1;
        pivot = value;
      } else if (pivot - value > floor) {
        direction = -1;
        pivot = value;
      }
    } else if (direction === 1) {
      if (value > pivot) pivot = value;
      else if (pivot - value > floor) {
        reversals += 1;
        legs.push({ direction: 1, size: pivot - legStart });
        legStart = pivot;
        direction = -1;
        pivot = value;
      }
    } else if (value < pivot) {
      pivot = value;
    } else if (value - pivot > floor) {
      reversals += 1;
      legs.push({ direction: -1, size: legStart - pivot });
      legStart = pivot;
      direction = 1;
      pivot = value;
    }
  }
  if (direction !== 0) legs.push({ direction, size: Math.abs(pivot - legStart) });
  // 되돌아감: 처음 → 끝의 방향(움직임이 없으면 첫 다리의 방향)과 반대로 간 다리 가운데 가장 큰 것.
  const netValue = values[values.length - 1] - values[0];
  const mainDirection = Math.abs(netValue) > floor ? Math.sign(netValue) : (legs[0]?.direction ?? 0);
  const maxBackPx = legs.filter((leg) => leg.direction !== mainDirection).reduce((most, leg) => Math.max(most, leg.size), 0);
  let steps = 0;
  let moving = false;
  for (let i = 1; i < values.length; i += 1) {
    const moved = Math.abs(values[i] - values[i - 1]) > step;
    if (moved && !moving) steps += 1;
    moving = moved;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    samples: values.length,
    reversals,
    maxBackPx: round2(maxBackPx),
    range: round2(max - min),
    net: round2(values[values.length - 1] - values[0]),
    steps,
    first: round2(values[0]),
    last: round2(values[values.length - 1]),
    min: round2(min),
    max: round2(max),
  };
}

/**
 * 숫자 넷.
 * @param {object} input
 * @param {(number|null)[]} input.series  지켜보는 줄의 위치 열(창 좌표)
 * @param {number} [input.expected]        예상 이동 폭(px, 0 = 움직이면 안 됨)
 * @param {(number|null)[]} [input.gaps]  프레임마다 바닥 거리
 * @param {boolean[]} [input.pills]        프레임마다 필이 섰는가
 * @param {number} [input.pillMounts]      프레임 사이의 필 붙음 횟수(MutationObserver)
 * @param {boolean} [input.pillAtStart]    창을 열 때 이미 필이 서 있었다(위를 읽는 중) — 「저절로 섬」은 그 뒤의 새로 섬만 센다
 */
export function stillNumbers({ series, expected = 0, gaps = [], pills = [], pillMounts = 0, pillAtStart = false }) {
  const motion = motionOf(series);
  const gapValues = gaps.filter((value) => typeof value === "number" && Number.isFinite(value));
  let pillShows = 0;
  for (let i = 0; i < pills.length; i += 1) if (pills[i] && (i === 0 ? !pillAtStart : !pills[i - 1])) pillShows += 1;
  const unexplained =
    motion === null ? null : expected === 0 ? motion.range : round2(Math.max(Math.abs(motion.range - expected), Math.abs(Math.abs(motion.net) - expected)));
  // 한 번 보인 줄이 뒤에 사라진 프레임 수: 보던 줄이 화면 밖(가상 목록의 붙임 범위 밖)으로 밀려 난 것이다. 그 프레임을 빼고 재면 0px 로 보인다.
  const firstSeen = series.findIndex((value) => typeof value === "number" && Number.isFinite(value));
  const vanished = firstSeen < 0 ? 0 : series.slice(firstSeen).filter((value) => !(typeof value === "number" && Number.isFinite(value))).length;
  return {
    reversals: motion?.reversals ?? null,
    unexplainedPx: unexplained,
    maxGapPx: gapValues.length ? round2(Math.max(...gapValues)) : null,
    // 필을 적지 않은 기록(옛 게이트의 프레임)은 「안 잼」(null)이다 — 0 으로 치지 않는다.
    pillShows: pills.length === 0 && pillMounts === 0 ? null : Math.max(pillShows, pillAtStart ? 0 : pillMounts),
    expectedPx: expected,
    vanishedFrames: vanished,
    motion,
  };
}

/**
 * 한 칸의 판정. `kind`:
 *   - "bottom"   맨 아래에 붙은 채: 되돌아옴 0 · 이유 없는 이동 ≤ 1px · 바닥 거리 ≤ 1px · 필 0
 *   - "reading"  위를 읽는 중: 되돌아옴 0 · 보던 줄 ≤ `limit`(기본 2px) · 필 새로 섬 0
 *   - "expected" 예상 이동이 있는 장면: 되돌아옴 0 · |움직인 폭 − 기대| ≤ 1px
 * 표본이 없으면 「장면 못 만듦」이다(0px 로 치지 않는다).
 * @returns {{ verdict: "PASS" | "FAIL" | "장면 못 만듦", reasons: string[] }}
 */
export function judgeCell(numbers, { kind, limit, minSamples = 10 }) {
  const reasons = [];
  // 한 번 보인 줄이 사라졌으면(화면 밖으로 밀림) 표본이 적어도 「장면 못 만듦」이 아니라 실패다.
  if (numbers.motion !== null && numbers.vanishedFrames > 0 && numbers.motion.samples < minSamples) {
    return { verdict: "FAIL", reasons: [`지켜본 줄이 ${numbers.motion.samples}프레임 보인 뒤 ${numbers.vanishedFrames}프레임 동안 사라졌다(화면 밖으로 밀림)`] };
  }
  if (numbers.motion === null || numbers.motion.samples < minSamples) {
    return { verdict: "장면 못 만듦", reasons: [`지켜본 줄의 표본이 ${numbers.motion?.samples ?? 0}개뿐이다`] };
  }
  if (numbers.reversals !== 0) reasons.push(`되돌아옴 ${numbers.reversals}회`);
  if (numbers.vanishedFrames > 0) reasons.push(`지켜본 줄이 ${numbers.vanishedFrames}프레임 동안 사라졌다(화면 밖으로 밀림)`);
  if (kind === "entry") {
    // 대화 진입: 첫 줄이 그려진 뒤 마지막 줄이 창에서 움직인 폭 ≤ 1px · 필 0 · 자리 잡은 뒤 바닥 거리 ≤ 1px(#5679 — 진입 직후 바닥에서
    // 4px 모자란 채 서던 것. 예전에는 기록만 했다).
    const cap = limit ?? LIMITS.stillPx;
    if (numbers.unexplainedPx > cap) reasons.push(`마지막 줄 ${numbers.unexplainedPx}px(> ${cap})`);
    if (numbers.maxGapPx === null || numbers.maxGapPx > LIMITS.gapPx) reasons.push(`바닥 거리 ${numbers.maxGapPx}px(> ${LIMITS.gapPx})`);
    if (numbers.pillShows !== 0) reasons.push(`필 ${numbers.pillShows}번 섬`);
  } else if (kind === "bottom") {
    const cap = limit ?? LIMITS.stillPx;
    if (numbers.unexplainedPx > cap) reasons.push(`이유 없는 이동 ${numbers.unexplainedPx}px(> ${cap})`);
    if (numbers.maxGapPx === null || numbers.maxGapPx > LIMITS.gapPx) reasons.push(`바닥 거리 ${numbers.maxGapPx}px(> ${LIMITS.gapPx})`);
    if (numbers.pillShows !== 0) reasons.push(`필 ${numbers.pillShows}번 섬`);
  } else if (kind === "reading") {
    const cap = limit ?? LIMITS.readingPx;
    if (numbers.unexplainedPx > cap) reasons.push(`보던 줄 ${numbers.unexplainedPx}px(> ${cap})`);
  } else if (kind === "expected") {
    const cap = limit ?? LIMITS.expectedPx;
    if (numbers.unexplainedPx > cap) reasons.push(`예상 ${numbers.expectedPx}px 와 ${numbers.unexplainedPx}px 다름(> ${cap})`);
  } else {
    throw new Error(`모르는 판정 종류: ${kind}`);
  }
  return { verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}

// ---------------------------------------------------------------------------------------------- 브라우저 안에서 적기

// 표본을 뜨는 때(#5641 검수 r1 H1 · M1): **그리기 직전**. 프레임마다 rAF 에서 새 ResizeObserver 를 만들어 `<html>` 바로 아래의 1px
// 탐침을 관찰한다. 새 관찰자는 관찰자 목록의 맨 끝이라, 그 프레임의 다른 관찰자(가상 목록 · scrollHold)가 바로잡은 뒤 · 그리기 앞에
// 콜백이 돈다. 표본은 하나도 버리지 않는다 — 옛 판은 「rAF 뒤 DOM 이 바뀐 프레임」을 버려 실제로 그려진 첫 프레임(진입의 맨 위 ·
// 빈 목록)과 한 프레임 흔들림까지 지웠다. 곁에서 그리기 뒤(rAF 에서 게시한 메시지) 값을 한 번 더 떠, 그 사이 DOM 이 바뀌지 않았는데
// 값이 다르면 `cross: true` 로 적는다(그리기 직전 표본이 놓친 바로잡기가 있었다는 흔적 — 비고에 수를 낸다).
// 관찰자 콜백이 오지 않은 프레임은 프레임 번호(`n`)의 빈칸으로 남는다(`frameGaps`).

/**
 * 프레임마다 그려진 모양을 적기 시작한다(위 「표본을 뜨는 때」).
 * 지켜보는 줄은 **메시지 id** 로 찾는다(가상 목록의 `data-index`·「마지막 줄」은 확정 · 채우기 때 다른 줄이 된다).
 * @param {import("playwright").Page} page
 * @param {{ scroller: string, watch: { name: string, messageId?: string, text?: string, edge: "top" | "bottom" }[] }} spec
 */
export async function startStillRecorder(page, spec) {
  await page.evaluate((spec) => {
    const R = (window.__still ??= { gen: 0 });
    R.gen += 1;
    const gen = R.gen;
    R.frames = [];
    R.pillMounts = 0;
    R.scrolls = 0;
    R.on = true;
    const live = () => R.on && R.gen === gen;
    const t0 = performance.now();
    const scrollerNow = () => document.querySelector(spec.scroller);
    const rowOf = (scroller, target) => {
      if (target.messageId) {
        const node = scroller.querySelector(`[data-message-id="${target.messageId}"]`);
        return node?.closest("[data-index]") ?? node ?? null;
      }
      for (const row of scroller.querySelectorAll("[data-index]")) if (row.textContent?.includes(target.text)) return row;
      return null;
    };
    const pillNow = () => document.querySelector('[data-testid="jump-latest"]') !== null;
    R.pillAtStart = pillNow();
    const mo = new MutationObserver((records) => {
      if (!live()) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && (node.matches?.('[data-testid="jump-latest"]') || node.querySelector?.('[data-testid="jump-latest"]'))) R.pillMounts += 1;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    // 그리기 뒤 대조 표본이 믿을 만한가: 그리기 직전 표본을 뜬 뒤 DOM 이 바뀌었으면 대조하지 않는다.
    let changedAfter = false;
    const changeWatch = new MutationObserver(() => {
      changedAfter = true;
    });
    changeWatch.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    let watchedScroller = null;
    const onScroll = () => {
      if (live()) R.scrolls += 1;
    };
    const round = (value) => Math.round(value * 100) / 100;
    const read = () => {
      const scroller = scrollerNow();
      if (scroller !== watchedScroller) {
        watchedScroller?.removeEventListener("scroll", onScroll);
        scroller?.addEventListener("scroll", onScroll, { passive: true });
        watchedScroller = scroller;
      }
      const frame = { t: Math.round(performance.now() - t0), pill: pillNow(), watch: {} };
      if (scroller) {
        frame.top = scroller.scrollTop;
        frame.sh = scroller.scrollHeight;
        frame.gap = round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
        frame.scrollerTop = round(scroller.getBoundingClientRect().top);
        frame.rows = scroller.querySelectorAll("[data-index]").length;
        for (const target of spec.watch) {
          const row = rowOf(scroller, target);
          frame.watch[target.name] = row ? round(row.getBoundingClientRect()[target.edge]) : null;
        }
      }
      return frame;
    };
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-9px;top:0;width:1px;height:1px;pointer-events:none";
    document.documentElement.appendChild(probe);
    let n = 0;
    let pending = null;
    let previous = null;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (!live() || pending === null) return;
      const frame = pending;
      pending = null;
      if (changedAfter) return;
      const after = read();
      frame.cross = after.top !== frame.top || Object.keys(frame.watch).some((name) => {
        const a = frame.watch[name];
        const b = after.watch[name];
        return (a === null) !== (b === null) || (a !== null && Math.abs(a - b) > 0.5);
      });
    };
    // 시작 표본(지금, 바뀌기 전).
    R.frames.push({ ...read(), n: 0 });
    const tick = () => {
      previous?.disconnect();
      previous = null;
      if (!live()) {
        watchedScroller?.removeEventListener("scroll", onScroll);
        mo.disconnect();
        changeWatch.disconnect();
        probe.remove();
        return;
      }
      n += 1;
      const frameNo = n;
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        if (!live()) return;
        const frame = { ...read(), n: frameNo };
        R.frames.push(frame);
        pending = frame;
        changedAfter = false;
      });
      observer.observe(probe);
      previous = observer;
      channel.port2.postMessage(0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, spec);
}

/** 적기를 멈추고 모은 것을 돌려준다. */
export async function stopStillRecorder(page) {
  return page.evaluate(() => {
    const R = window.__still;
    R.on = false;
    return { frames: R.frames, pillMounts: R.pillMounts, pillAtStart: R.pillAtStart, scrolls: R.scrolls };
  });
}

/**
 * 대화 진입 장면: 페이지가 뜰 때부터 프레임마다(그리기 직전) 스크롤러를 적는다. 창을 고르는 일은 `entryWindow`(순수)가 한다 —
 * **이 대화의 줄이 처음 붙은 프레임**부터 `windowMs`(그 프레임이 깨끗한지와 무관하다, #5641 검수 r1 H1).
 * `spec.startSelector` 는 「이 대화의 줄」을 고르는 선택자다(로그인 뒤 먼저 열린 채널의 줄과 가른다).
 * 재기 전에 스크롤 위치를 바로잡지 않는다(그 바로잡기가 재려는 것을 가린다). 지켜보는 줄이 아직 붙지 않은 프레임은 `null` 로 남고
 * 따로 센다(`missing`) — 첫 그리기에 가장 새 줄이 없다가 나중에 서면 그것도 화면이 뛴 것이다.
 */
export async function installEntryRecorder(page, spec) {
  await page.addInitScript((spec) => {
    const E = (window.__stillEntry = { raw: [], done: false, pillMounts: 0, firstMatchAt: null });
    const round = (value) => Math.round(value * 100) / 100;
    const rowOf = (scroller) => {
      const node = scroller.querySelector(`[data-message-id="${spec.messageId}"]`);
      return node?.closest("[data-index]") ?? node ?? null;
    };
    let mo = null;
    let changeWatch = null;
    let changedAfter = false;
    let pending = null;
    const read = () => {
      const scroller = document.querySelector(spec.scroller);
      if (!scroller) return null;
      const rows = scroller.querySelectorAll("[data-index]").length;
      const row = rowOf(scroller);
      let topId = null;
      const edge = scroller.getBoundingClientRect().top;
      for (const node of scroller.querySelectorAll("[data-message-id]")) {
        if (node.getBoundingClientRect().top >= edge - 1) {
          topId = node.getAttribute("data-message-id");
          break;
        }
      }
      return {
        t: performance.now(),
        rows,
        match: rows > 0 && scroller.querySelector(spec.startSelector) !== null,
        top: scroller.scrollTop,
        topId,
        visible: getComputedStyle(scroller).visibility !== "hidden" && Number(getComputedStyle(scroller.closest('[data-testid="chat-timeline"]') ?? scroller).opacity) > 0,
        pill: document.querySelector('[data-testid="jump-latest"]') !== null,
        gap: round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        watch: { [spec.name]: row ? round(row.getBoundingClientRect()[spec.edge]) : null },
      };
    };
    const sample = (frameNo) => {
      const frame = read();
      if (frame === null) return;
      frame.n = frameNo;
      if (E.firstMatchAt === null && frame.match) {
        E.firstMatchAt = frame.t;
        mo = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType === 1 && (node.matches?.('[data-testid="jump-latest"]') || node.querySelector?.('[data-testid="jump-latest"]'))) E.pillMounts += 1;
            }
          }
        });
        mo.observe(document.body, { childList: true, subtree: true });
      }
      if (E.firstMatchAt !== null && frame.t - E.firstMatchAt > spec.windowMs + 50) {
        E.done = true;
        mo?.disconnect();
        changeWatch?.disconnect();
        return;
      }
      E.raw.push(frame);
      pending = frame;
      changedAfter = false;
    };
    const boot = () => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-9px;top:0;width:1px;height:1px;pointer-events:none";
      document.documentElement.appendChild(probe);
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (pending === null) return;
        const frame = pending;
        pending = null;
        if (changedAfter) return;
        const after = read();
        frame.cross = after === null || after.top !== frame.top || (after.watch[spec.name] === null) !== (frame.watch[spec.name] === null) ||
          (after.watch[spec.name] !== null && Math.abs(after.watch[spec.name] - frame.watch[spec.name]) > 0.5);
      };
      let n = 0;
      let previous = null;
      const tick = () => {
        previous?.disconnect();
        previous = null;
        if (E.done) {
          probe.remove();
          return;
        }
        if (changeWatch === null && document.body) {
          changeWatch = new MutationObserver(() => {
            changedAfter = true;
          });
          changeWatch.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        }
        n += 1;
        const frameNo = n;
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          if (!E.done) sample(frameNo);
        });
        observer.observe(probe);
        previous = observer;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (document.documentElement) boot();
    else document.addEventListener("DOMContentLoaded", boot);
  }, spec);
}

/** 진입 기록이 끝날 때까지 기다려 창(`entryWindow`)을 골라 돌려준다. */
export async function readEntryRecord(page, timeoutMs = 20_000, windowMs = 2_000) {
  await page.waitForFunction(() => window.__stillEntry?.done === true, null, { timeout: timeoutMs });
  const raw = await page.evaluate(() => ({ raw: window.__stillEntry.raw, pillMounts: window.__stillEntry.pillMounts }));
  const picked = entryWindow(raw.raw, { windowMs });
  return { frames: picked.frames, before: picked.before, hidden: picked.hidden, pillMounts: raw.pillMounts, pillAtStart: false };
}

// ---------------------------------------------------------------------------------------------- 창 고르기 · 놓친 프레임 (순수)

/**
 * 진입 장면의 창: **이 대화의 줄이 붙고 목록이 처음 보인 프레임**(`match` · `visible`)부터 `windowMs` 안의 프레임 전부. 그 프레임이
 * 「깨끗한지」는 보지 않고, 창 안의 프레임은 하나도 버리지 않는다(#5641 검수 r1 H1 — 옛 판은 처음 깨끗한 프레임에서 시작해 진입 첫
 * 2~3프레임을 창 밖에 뒀다).
 *
 * 「보인」(#5678): 줄이 붙었어도 스크롤 상자가 가려져 있으면(`visible: false` — `visibility: hidden` · 투명) 그 프레임에 그려진 줄은 없다.
 * 그 프레임들은 창에 넣지 않고 `hidden`(줄이 붙은 뒤 처음 보이기까지의 프레임 수 · ms)으로 따로 센다 — 가려 둔 채 오래 끌면 그것도
 * 실패다(`MAX_ENTRY_HIDDEN_FRAMES`). 한 번 보인 뒤 다시 가려진 프레임은 지켜보는 줄이 없는 프레임(`null`)으로 바꿔 둔다: 화면에서
 * 줄이 사라진 것이니 머리(자리 잡기 전)나 사라진 프레임으로 잡힌다. `visible` 을 적지 않은 기록(옛 판)은 보인 것으로 친다.
 * @param {{ t: number, match: boolean, visible?: boolean }[]} raw 페이지가 뜬 뒤 프레임마다 적은 것(`t` 는 performance.now)
 * @returns {{ frames: object[], before: number, hidden: { frames: number, ms: number, never: boolean } }}
 *   `frames` 의 `t` 는 시작 프레임 기준 ms, `before` 는 시작 앞 프레임 수
 */
export function entryWindow(raw, { windowMs }) {
  const attached = raw.findIndex((frame) => frame.match === true);
  if (attached < 0) return { frames: [], before: raw.length, hidden: { frames: 0, ms: 0, never: false } };
  const start = raw.findIndex((frame, i) => i >= attached && frame.match === true && frame.visible !== false);
  const last = raw.length - 1;
  const hidden = {
    frames: (start < 0 ? raw.length : start) - attached,
    ms: Math.round(raw[start < 0 ? last : start].t - raw[attached].t),
    never: start < 0,
  };
  if (start < 0) return { frames: [], before: raw.length, hidden };
  const t0 = raw[start].t;
  const frames = raw
    .slice(start)
    .filter((frame) => frame.t - t0 <= windowMs)
    .map((frame) => {
      const shown = { ...frame, t: Math.round(frame.t - t0) };
      if (frame.visible === false) shown.watch = Object.fromEntries(Object.keys(frame.watch ?? {}).map((name) => [name, null]));
      return shown;
    });
  return { frames, before: start, hidden };
}

/**
 * 대화 진입에서 줄이 붙은 뒤 목록이 가려진 채 있어도 되는 프레임 수(#5678). 자리 잡기(가상 목록이 바닥으로 두 걸음 · 줄 다시 재기)는
 * 수리 전 실측 1~6프레임이었다. 그보다 오래 가리면 「흔들림 0」을 빈 화면으로 산 것이다 — 앱의 마지막 안전판(600ms)이 열리는 것도 여기에 걸린다.
 */
export const MAX_ENTRY_HIDDEN_FRAMES = 8;

/**
 * 진입 창을 「자리 잡기 전(머리)」과 「그 뒤(몸)」로 가른다. 몸은 가장 새 줄이 **세 프레임 이어** 보이고 그 셋이 1px 안에 있는 첫 프레임부터다.
 * 머리는 그 앞 프레임 전부다 — 가장 새 줄이 없거나(맨 위 · 빈 목록), 엉뚱한 곳에 있다가 사라지는 프레임(검수 r1 H1 의 WebKit 판 A).
 * @returns {{ head: object[], body: object[], summary: string, missing: number, maxOffsetPx: number, maxGapPx: number }}
 */
export function entrySettle(frames, watch = "last") {
  const at = (i) => frames[i]?.watch?.[watch];
  let start = -1;
  for (let i = 0; i + 2 < frames.length; i += 1) {
    const trio = [at(i), at(i + 1), at(i + 2)];
    if (trio.every((value) => typeof value === "number") && Math.max(...trio) - Math.min(...trio) <= MOVE_FLOOR_PX) {
      start = i;
      break;
    }
  }
  if (start < 0) return { head: frames, body: [], summary: "", missing: 0, maxOffsetPx: 0, maxGapPx: 0 };
  const head = frames.slice(0, start);
  const settled = at(start);
  const tops = [...new Set(head.map((frame) => frame.top))].join("→");
  const offsets = head.filter((frame) => typeof frame.watch?.[watch] === "number").map((frame) => Math.abs(frame.watch[watch] - settled));
  const summary = head.length
    ? `가장 새 줄 없음 ${head.filter((frame) => frame.watch?.[watch] === null || frame.watch?.[watch] === undefined).length}프레임` +
      `${offsets.length ? ` · 제자리에서 ${round2(Math.max(...offsets))}px 떨어져 보임 ${offsets.length}프레임` : ""} · scrollTop ${tops} · 바닥 거리 최대 ${Math.max(...head.map((frame) => frame.gap ?? 0))}px`
    : "";
  return {
    head,
    body: frames.slice(start),
    summary,
    missing: head.filter((frame) => frame.watch?.[watch] === null || frame.watch?.[watch] === undefined).length,
    maxOffsetPx: offsets.length ? round2(Math.max(...offsets)) : 0,
    maxGapPx: head.length ? Math.max(...head.map((frame) => frame.gap ?? 0)) : 0,
  };
}

/** 놓친 프레임을 이 수보다 많이 놓친 창은 「장면 못 만듦」이다(놓친 프레임에 흔들림이 숨을 수 있다). */
export const MAX_MISSED_FRAMES = 2;

/**
 * 창 안에서 그리기 직전 표본이 오지 않은 프레임(프레임 번호 `n` 의 빈칸)과, 그리기 뒤 대조가 달랐던 프레임 수.
 * @returns {{ missed: number, missedAtStart: number, cross: number, reason: string | null }}
 */
export function frameGaps(frames) {
  const numbered = frames.filter((frame) => typeof frame.n === "number");
  let missed = 0;
  let missedAtStart = 0;
  for (let i = 1; i < numbered.length; i += 1) {
    const gap = Math.max(0, numbered[i].n - numbered[i - 1].n - 1);
    missed += gap;
    if (i <= 3) missedAtStart += gap;
  }
  const cross = frames.filter((frame) => frame.cross === true).length;
  const reason =
    missed > MAX_MISSED_FRAMES || missedAtStart > 0
      ? `그리기 직전 표본을 ${missed}프레임 놓쳤다(처음 세 프레임 사이 ${missedAtStart}) — 놓친 프레임에 흔들림이 숨을 수 있다`
      : null;
  return { missed, missedAtStart, cross, reason };
}

// ---------------------------------------------------------------------------------------------- 알려진 실패 (순수)

/**
 * 장면표의 알려진 실패: 지금 코드에서 실패하고 수리는 다른 칸에 있는 칸. 키는 **정확한** `장면|엔진|폭`이다(별표 없음 — 지금
 * 통과하는 칸을 덮지 않게, #5641 검수 r1 M2). 줄마다 수리 이슈 번호(`issue`)가 있다. `placeholder: true` 는 수리 이슈가 아직 없어
 * 찾은 칸(#5641)을 단 줄이다(planner 가 이슈를 열면 번호만 바꾼다). 적은 상한은 2026-11-12 이 게이트(그리기 직전 표본)로 잰 값에
 * 바짝 붙였다. **적지 않은 숫자는 보지 않는 것이 아니라 그 장면의 평소 문턱을 따른다**(`withinKnown`).
 * `notBuilt` 는 「장면을 못 만든 까닭」의 앞부분이다 — 그 까닭으로 못 만든 칸은 통과가 아니라 따로 센다(`finalVerdict`).
 */
const ENTRY_HEAD = "진입 첫 프레임: 이 대화의 줄이 붙은 첫 1~3프레임에 목록 맨 위 · 가장 새 줄 없는 목록이 그려지고 20~80ms 뒤 자리 잡음";
const NO_ISSUE = { issue: "#5641", placeholder: true };
export const TIMELINE_KNOWN_FAILURES = Object.freeze(
  [
    // 2026-11-12 실측: 이 게이트(그리기 직전 표본), Playwright Chromium 149 · WebKit 26.5. Chromium 은 세 폭 × 3번 같은 값(부하 8~39),
    // WebKit 은 낮은 부하(6~11) 3번 + 높은 부하(18~33) 2번 가운데 가장 큰 값. 자리 잡기 전 프레임은 `entrySettle` 의 머리다.
    { key: "entry|chromium|1280", ...NO_ISSUE, what: `${ENTRY_HEAD}(2프레임 · scrollTop 0 · 바닥 거리 2,038px)`, maxUnsettledFrames: 2 },
    { key: "entry|chromium|900", ...NO_ISSUE, what: `${ENTRY_HEAD}(2프레임 · scrollTop 0 · 바닥 거리 2,038px)`, maxUnsettledFrames: 2 },
    { key: "entry|chromium|390", ...NO_ISSUE, what: `${ENTRY_HEAD}(2프레임 · scrollTop 0 · 바닥 거리 2,297px)`, maxUnsettledFrames: 2 },
    { key: "entry|webkit|1280", ...NO_ISSUE, what: `${ENTRY_HEAD}(대개 1~2프레임 가장 새 줄 없음, 가끔 3프레임 — 맨 위 → 제자리에서 811px → 없음)`, maxUnsettledFrames: 3 },
    { key: "entry|webkit|900", ...NO_ISSUE, what: `${ENTRY_HEAD}(1~3프레임)`, maxUnsettledFrames: 3 },
    { key: "entry|webkit|390", ...NO_ISSUE, what: `${ENTRY_HEAD}(2~3프레임)`, maxUnsettledFrames: 3 },
    { key: "entry-card|chromium|1280", ...NO_ISSUE, what: `${ENTRY_HEAD}(2프레임) + 진입 중 링크 카드가 0.7초 늦게 서면 마지막 줄 4.75px`, maxUnsettledFrames: 2, maxUnexplainedPx: 4.75 },
    { key: "entry-card|chromium|900", ...NO_ISSUE, what: `${ENTRY_HEAD}(2프레임) + 진입 중 링크 카드가 0.7초 늦게 서면 마지막 줄 4.75px`, maxUnsettledFrames: 2, maxUnexplainedPx: 4.75 },
    { key: "entry-card|chromium|390", ...NO_ISSUE, what: `${ENTRY_HEAD}(2프레임)`, maxUnsettledFrames: 2 },
    // 가끔(앞 회차 K3 · 검수 r1: 세 번에 한 번꼴 — 카드가 서는 순간이 진입의 어느 프레임과 겹치느냐). 그리기 직전 표본으로 4.38px(11-12, 900),
    // 옛 기록기로 4px. 다른 회차는 1px.
    { key: "entry-card|webkit|1280", ...NO_ISSUE, what: `${ENTRY_HEAD}(1~3프레임) + 진입 중 카드가 서면 가끔 마지막 줄 4.38px`, maxUnsettledFrames: 3, maxUnexplainedPx: 4.38 },
    { key: "entry-card|webkit|900", ...NO_ISSUE, what: `${ENTRY_HEAD}(1~3프레임) + 진입 중 카드가 서면 가끔 마지막 줄 4.38px`, maxUnsettledFrames: 3, maxUnexplainedPx: 4.38 },
    { key: "entry-card|webkit|390", ...NO_ISSUE, what: `${ENTRY_HEAD}(2~3프레임)`, maxUnsettledFrames: 3 },
    { key: "older|chromium|1280", ...NO_ISSUE, what: "위로 더 불러오기: 옛 쪽이 붙은 다음 프레임에 보던 줄 5.25px 내려앉음", maxUnexplainedPx: 5.25 },
    { key: "older|chromium|900", ...NO_ISSUE, what: "위로 더 불러오기: 옛 쪽이 붙은 다음 프레임에 보던 줄 5.25px 내려앉음", maxUnexplainedPx: 5.25 },
    { key: "older|chromium|390", ...NO_ISSUE, what: "위로 더 불러오기: 옛 쪽이 붙은 다음 프레임에 보던 줄 5.25px 내려앉음", maxUnexplainedPx: 5.25 },
    {
      key: "older|webkit|1280",
      issue: "#5662",
      what: "맨 위에 닿아도 옛 쪽을 안 불러옴(빈 대화를 거쳐 첫 쪽이 한 프레임 안에 온 대화 — 낮은 부하 3/3) · 불러온 때(높은 부하 1/2)는 보던 줄 4.69px",
      maxUnexplainedPx: 4.69,
      notBuilt: "옛 쪽이 붙지 않았다(읽기 0",
    },
    {
      key: "older|webkit|900",
      issue: "#5662",
      what: "맨 위에 닿아도 옛 쪽을 안 불러옴(낮은 부하 3/3) · 불러온 때(높은 부하 1/1)는 보던 줄 4.69px",
      maxUnexplainedPx: 4.69,
      notBuilt: "옛 쪽이 붙지 않았다(읽기 0",
    },
    { key: "reaction-bottom-added|webkit|1280", ...NO_ISSUE, what: "WebKit 맨 아래 반응 추가: 마지막 줄 1.63px", maxUnexplainedPx: 1.63 },
    { key: "reaction-bottom-added|webkit|900", ...NO_ISSUE, what: "WebKit 맨 아래 반응 추가: 마지막 줄 1.63px", maxUnexplainedPx: 1.63 },
    { key: "reaction-bottom-removed|webkit|1280", ...NO_ISSUE, what: "WebKit 맨 아래 반응 제거: 바닥 거리 2px", maxGapPx: 2 },
    { key: "reaction-bottom-removed|webkit|900", ...NO_ISSUE, what: "WebKit 맨 아래 반응 제거: 바닥 거리 2px", maxGapPx: 2 },
  ].map((entry) => Object.freeze(entry))
);

/** 그 칸의 알려진 실패 항목(정확한 키만). */
export function knownFailureFor(scene, engine, width, list = TIMELINE_KNOWN_FAILURES) {
  return list.find((entry) => entry.key === `${scene}|${engine}|${width}`) ?? null;
}

/**
 * 알려진 실패의 테두리 안인가: 숫자마다 적은 상한(없으면 그 장면의 평소 문턱) 안일 때만이다. 지켜본 줄이 적어 둔 프레임 수(`maxVanishedFrames`,
 * 기본 0)보다 오래 사라졌으면(사보타주 · 새 회귀) 밖이다.
 * @param {object} known  `TIMELINE_KNOWN_FAILURES` 의 한 줄
 * @param {object|null} numbers  `stillNumbers` 의 결과
 * @param {{ kind: "entry" | "bottom" | "reading", unsettled?: number, hidden?: number }} cell  `unsettled` = 진입의 자리 잡기 전 프레임 수(`entrySettle`),
 *   `hidden` = 진입에서 줄이 붙은 뒤 목록이 가려져 있던 프레임 수(`entryWindow`, 상한 없으면 `MAX_ENTRY_HIDDEN_FRAMES`)
 */
export function withinKnown(known, numbers, { kind, unsettled = 0, hidden = 0 }) {
  if (numbers === null || numbers === undefined || numbers.vanishedFrames > (known.maxVanishedFrames ?? 0)) return false;
  const pxCap = known.maxUnexplainedPx ?? (kind === "reading" ? LIMITS.readingPx : LIMITS.stillPx);
  if ((numbers.unexplainedPx ?? Infinity) > pxCap) return false;
  if ((numbers.reversals ?? Infinity) > (known.maxReversals ?? 0)) return false;
  // 진입도 바닥 거리를 판정한다(#5679): 알려진 실패 줄이 진입의 바닥 거리 실패를 덮지 않는다.
  if ((kind === "bottom" || kind === "entry") && (numbers.maxGapPx ?? Infinity) > (known.maxGapPx ?? LIMITS.gapPx)) return false;
  if (unsettled > (known.maxUnsettledFrames ?? 0)) return false;
  if (hidden > (known.maxHiddenFrames ?? MAX_ENTRY_HIDDEN_FRAMES)) return false;
  if (kind !== "reading" && (numbers.pillShows ?? 0) > (known.maxPill ?? 0)) return false;
  return true;
}

/**
 * 고쳐졌는데 목록에 남은 항목: 이번 실행에서 그 키의 칸을 쟀고 모두 통과했으면(또는 `notBuilt` 칸이 이제 만들어졌으면) 「목록에서 빼라」.
 * @returns {string[]} 알릴 문장
 */
export function staleKnown(cells, list = TIMELINE_KNOWN_FAILURES) {
  const lines = [];
  for (const entry of list) {
    const hits = cells.filter((cell) => `${cell.sceneKey}|${cell.engine}|${cell.width}` === entry.key);
    if (hits.length === 0) continue;
    if (hits.every((cell) => cell.verdict === "PASS")) {
      lines.push(`알려진 실패 ${entry.key}(${entry.issue})가 이번 실행에서 ${hits.length}칸 모두 통과했다 — 고쳐졌으면 목록에서 빼라`);
    } else if (entry.notBuilt && hits.every((cell) => cell.verdict !== "알려진 실패(장면 못 만듦)")) {
      lines.push(`알려진 장면 못 만듦 ${entry.key}(${entry.issue})가 이번 실행에서 만들어졌다 — 고쳐졌으면 notBuilt 를 빼라`);
    }
  }
  return lines;
}

/** 판정한 칸(통과 · 실패 · 알려진 실패). 기록만 · 재지 않음 · 못 만듦 · 못 잼은 판정이 아니다. */
const judged = (cell) => cell.verdict.startsWith("PASS") || cell.verdict === "FAIL" || cell.verdict === "알려진 실패";

/**
 * 게이트의 마지막 판정(순수). 종료 코드 1 = FAIL, 3 = NOT-MEASURED(통과 아님), 0 = PASS.
 *   - 실패 칸이나 모르는 「장면 못 만듦」이 있으면 FAIL.
 *   - **판정한 칸이 0이면 FAIL** — 못 만듦 · 판 없음 · 기록만 어느 까닭이든 「0칸 PASS」는 없다(#5641 검수 r1 H2). 단 부하로 「재지 않음」인
 *     칸이 있으면 NOT-MEASURED 다(이슈 수용 기준: 부하가 높으면 통과도 실패도 아니다 — 부하가 내려온 뒤 다시 돈다).
 *   - 재지 않음(부하) · 알려진 장면 못 만듦 · 꼭 재야 하는 엔진(WebKit · Chromium)의 판 없음이 하나라도 있으면 NOT-MEASURED.
 * 「알려진 장면 못 만듦」은 통과로 세지 않고 따로 크게 적는다.
 * @returns {{ code: 0 | 1 | 3, out: string[], err: string[] }}
 */
export function finalVerdict(cells, label = "timeline-still") {
  const failures = cells.filter((cell) => cell.verdict === "FAIL" || cell.verdict === "장면 못 만듦");
  const notMeasured = cells.filter((cell) => cell.verdict === "재지 않음");
  const notBuilt = cells.filter((cell) => cell.verdict === "알려진 실패(장면 못 만듦)");
  const noEngine = cells.filter((cell) => cell.verdict === "못 잼" && cell.required === true);
  const judgedCells = cells.filter(judged);
  const known = cells.filter((cell) => cell.verdict === "알려진 실패");
  const recordOnly = cells.filter((cell) => cell.verdict.startsWith("기록만"));
  const where = (cell) => `${cell.scene} [${cell.engine} ${cell.width}]`;
  const unmeasuredLine = `재지 않음(부하) ${notMeasured.length} · 알려진 장면 못 만듦 ${notBuilt.length} · 엔진 판 없음 ${noEngine.length}`;
  const err = [];
  for (const cell of failures) err.push(`FAIL ${cell.set} ${where(cell)} ${(cell.reasons ?? []).join(" · ")}`);
  const empty = notMeasured.length > 0 ? null : nothingRan(judgedCells.length, label);
  if (empty !== null) err.push(`FAIL ${empty} (${unmeasuredLine})`);
  if (err.length > 0) return { code: 1, out: [], err };
  const out = [];
  if (notBuilt.length + noEngine.length > 0) {
    out.push("================================================================");
    for (const cell of notBuilt) out.push(`!! 재지 못한 칸 — 알려진 장면 못 만듦: ${where(cell)} ${cell.known?.issue ?? ""} ${(cell.reasons ?? []).join(" · ")}`);
    for (const cell of noEngine) out.push(`!! 재지 못한 칸 — 꼭 재야 하는 엔진의 판이 없다: ${cell.engine} (${cell.note ?? ""})`);
    out.push("================================================================");
  }
  // 기존 묶음의 칸은 그 게이트의 판정 그대로다 — 숫자 넷이 이 표의 문턱 밖인 PASS 칸을 따로 센다(#5641 검수 r1 M5).
  const outside = judgedCells.filter((cell) => cell.set !== "new" && cell.verdict.startsWith("PASS") && outsideLimits(cell));
  const summary =
    `판정한 칸 ${judgedCells.length}(새 장면 ${judgedCells.filter((cell) => cell.set === "new").length} — 숫자 넷의 문턱 · 기존 묶음 ` +
    `${judgedCells.filter((cell) => cell.set !== "new").length} — 그 게이트의 판정) · 알려진 실패 ${known.length}(기록) · 기록만 ${recordOnly.length} · ` +
    `문턱 밖 숫자를 가진 기존 묶음 PASS ${outside.length}`;
  if (notMeasured.length + notBuilt.length + noEngine.length > 0) {
    out.push(`NOT-MEASURED ${label}: ${unmeasuredLine} — 통과로 치지 않는다 · ${summary}`);
    return { code: 3, out, err: [] };
  }
  out.push(`PASS ${label}: ${summary}`);
  return { code: 0, out, err: [] };
}

/** 숫자 넷이 이 표의 문턱(맨 아래 ≤ 1px · 바닥 ≤ 1px · 위 읽기 ≤ 2px · 되돌아옴 0) 밖인가. */
function outsideLimits(cell) {
  const n = cell.numbers;
  if (!n) return false;
  const cap = cell.kind === "reading" ? LIMITS.readingPx : cell.kind === "expected" ? LIMITS.expectedPx : LIMITS.stillPx;
  return (n.reversals ?? 0) > 0 || (n.unexplainedPx ?? 0) > cap || (cell.kind === "bottom" && (n.maxGapPx ?? 0) > LIMITS.gapPx);
}

/**
 * send-follow ⑤ 의 알려진 실패 테두리(#5641 검수 r1 M3). 옛 판은 연달아 장면의 되돌아옴을 몇 번이든 · 몇 px 이든 기록만 했다.
 * 실측(2026-11-10 · 11-12): 연달아 되돌아옴 2회 · 가장 큰 되돌아감 7.4px, 보낸 뒤 바닥 거리 8px.
 */
export const SEND_KNOWN = Object.freeze({
  rapidSettle: Object.freeze({ issue: "#5641", placeholder: true, what: "연달아 두 번: 첫 글이 붙은 다음 프레임 7.4px 내려앉음(#5617 에서 알려 둔 것)", maxReversals: 2, maxBackPx: 9 }),
  shortfall: Object.freeze({ issue: "#5641", placeholder: true, what: "바닥에서 보낸 뒤 8px 위에 앉음(#5617 에서 알려 둔 것)", maxGapPx: 9 }),
});

/** 연달아 장면의 되돌아옴이 알려진 테두리 안인가(횟수와 가장 큰 되돌아감 둘 다). */
export function rapidSettleWithin({ reversals, maxBackPx }, bound = SEND_KNOWN.rapidSettle) {
  return Number.isFinite(reversals) && Number.isFinite(maxBackPx) && reversals <= bound.maxReversals && maxBackPx <= bound.maxBackPx;
}

/** 바닥 거리가 알려진 모자람 안인가. 표본이 없으면(`null`) 안이 아니다 — 실패다. */
export function shortfallWithin(gapPx, bound = SEND_KNOWN.shortfall) {
  return typeof gapPx === "number" && Number.isFinite(gapPx) && gapPx <= bound.maxGapPx;
}

/** 모은 프레임에서 한 줄의 숫자 넷. */
export function numbersFromRecord(record, { watch, expected = 0 }) {
  return stillNumbers({
    series: record.frames.map((frame) => frame.watch?.[watch] ?? null),
    expected,
    gaps: record.frames.map((frame) => frame.gap ?? null),
    pills: record.frames.map((frame) => frame.pill),
    pillMounts: record.pillMounts,
    pillAtStart: record.pillAtStart,
  });
}
