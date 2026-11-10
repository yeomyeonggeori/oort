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
 * @returns {null | { samples: number, reversals: number, range: number, net: number, steps: number, first: number, last: number, min: number, max: number }}
 */
export function motionOf(series, { floor = MOVE_FLOOR_PX, step = STEP_PX } = {}) {
  const values = series.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  let reversals = 0;
  let direction = 0;
  let pivot = values[0];
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
        direction = -1;
        pivot = value;
      }
    } else if (value < pivot) {
      pivot = value;
    } else if (value - pivot > floor) {
      reversals += 1;
      direction = 1;
      pivot = value;
    }
  }
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
  return {
    reversals: motion?.reversals ?? null,
    unexplainedPx: unexplained,
    maxGapPx: gapValues.length ? round2(Math.max(...gapValues)) : null,
    // 필을 적지 않은 기록(옛 게이트의 프레임)은 「안 잼」(null)이다 — 0 으로 치지 않는다.
    pillShows: pills.length === 0 && pillMounts === 0 ? null : Math.max(pillShows, pillAtStart ? 0 : pillMounts),
    expectedPx: expected,
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
  if (numbers.motion === null || numbers.motion.samples < minSamples) {
    return { verdict: "장면 못 만듦", reasons: [`지켜본 줄의 표본이 ${numbers.motion?.samples ?? 0}개뿐이다`] };
  }
  if (numbers.reversals !== 0) reasons.push(`되돌아옴 ${numbers.reversals}회`);
  if (kind === "entry") {
    // 대화 진입: 첫 줄이 그려진 뒤 마지막 줄이 창에서 움직인 폭 ≤ 1px · 필 0. 바닥 거리는 기록만 한다(첫 착지의 몇 px 는 #5567 기록).
    const cap = limit ?? LIMITS.stillPx;
    if (numbers.unexplainedPx > cap) reasons.push(`마지막 줄 ${numbers.unexplainedPx}px(> ${cap})`);
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

/**
 * 프레임마다 그려진 모양을 적기 시작한다(rAF 안에서 게시한 메시지는 그 프레임의 그리기 · ResizeObserver 콜백이 끝난 뒤에 돈다).
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
    let watchedScroller = null;
    const onScroll = () => {
      if (live()) R.scrolls += 1;
    };
    const round = (value) => Math.round(value * 100) / 100;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (!live()) return;
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
      R.frames.push(frame);
    };
    channel.port1.onmessage();
    const tick = () => {
      if (!live()) {
        watchedScroller?.removeEventListener("scroll", onScroll);
        mo.disconnect();
        return;
      }
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
 * 대화 진입 장면: 페이지가 뜰 때부터 rAF 마다 스크롤러를 찾고, **처음 줄이 그려진 프레임부터** `windowMs` 동안 적는다.
 * `spec.startSelector` 는 「이 대화의 줄」을 고르는 선택자다(로그인 뒤 먼저 열린 채널의 줄과 가른다).
 * 재기 전에 스크롤 위치를 바로잡지 않는다(그 바로잡기가 재려는 것을 가린다). 지켜보는 줄이 아직 붙지 않은 프레임은 `null` 로 남고
 * 따로 센다(`missing`) — 첫 그리기에 가장 새 줄이 없다가 나중에 서면 그것도 화면이 뛴 것이다.
 */
export async function installEntryRecorder(page, spec) {
  await page.addInitScript((spec) => {
    const E = (window.__stillEntry = { frames: [], done: false, pillMounts: 0, startedAt: null });
    const round = (value) => Math.round(value * 100) / 100;
    const rowOf = (scroller) => {
      const node = scroller.querySelector(`[data-message-id="${spec.messageId}"]`);
      return node?.closest("[data-index]") ?? node ?? null;
    };
    let mo = null;
    const sample = () => {
      const scroller = document.querySelector(spec.scroller);
      const rows = scroller ? scroller.querySelectorAll("[data-index]").length : 0;
      if (E.startedAt === null) {
        // 시작: 이 대화의 줄이 처음 그려진 프레임(`startSelector`). 로그인 뒤 먼저 열린 다른 채널의 줄로 시작하지 않는다.
        if (rows === 0 || scroller.querySelector(spec.startSelector) === null) return;
        E.startedAt = performance.now();
        mo = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType === 1 && (node.matches?.('[data-testid="jump-latest"]') || node.querySelector?.('[data-testid="jump-latest"]'))) E.pillMounts += 1;
            }
          }
        });
        mo.observe(document.body, { childList: true, subtree: true });
      }
      const t = performance.now() - E.startedAt;
      if (t > spec.windowMs) {
        E.done = true;
        mo?.disconnect();
        return;
      }
      const row = scroller ? rowOf(scroller) : null;
      let topId = null;
      if (scroller) {
        const edge = scroller.getBoundingClientRect().top;
        for (const node of scroller.querySelectorAll("[data-message-id]")) {
          if (node.getBoundingClientRect().top >= edge - 1) {
            topId = node.getAttribute("data-message-id");
            break;
          }
        }
      }
      E.frames.push({
        t: Math.round(t),
        rows,
        top: scroller ? scroller.scrollTop : null,
        topId,
        visible: scroller ? getComputedStyle(scroller).visibility !== "hidden" && Number(getComputedStyle(scroller.closest('[data-testid="chat-timeline"]') ?? scroller).opacity) > 0 : null,
        pill: document.querySelector('[data-testid="jump-latest"]') !== null,
        gap: scroller ? round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : null,
        watch: { [spec.name]: row ? round(row.getBoundingClientRect()[spec.edge]) : null },
      });
    };
    const channel = new MessageChannel();
    channel.port1.onmessage = sample;
    const tick = () => {
      if (E.done) return;
      channel.port2.postMessage(0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, spec);
}

/** 진입 기록이 끝날 때까지 기다려 돌려준다. */
export async function readEntryRecord(page, timeoutMs = 20_000) {
  await page.waitForFunction(() => window.__stillEntry?.done === true, null, { timeout: timeoutMs });
  return page.evaluate(() => ({ frames: window.__stillEntry.frames, pillMounts: window.__stillEntry.pillMounts, pillAtStart: false }));
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
