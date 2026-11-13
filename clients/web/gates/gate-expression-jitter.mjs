#!/usr/bin/env node
// GATE: #5575 — 이모티콘이 든 DM이 맨 아래에 붙어 있을 때, 일시적인 상태(연결 흔들림 · 목록 다시 읽기 · 창 포커스 ·
// 세대 교체 · 실시간 다시 연결 · 상대 「입력 중」)가 몇 번 지나가도
//   ① 아는 이모티콘이 `:이름:` 글자로 바뀌지 않는다(0회),
//   ② 목록이 맨 아래에서 떨어지지 않는다(거리 0),
//   ③ 「최신 메시지로 이동」이 서지 않는다(0회).
// 진짜로 목록 높이가 바뀌어도(등록으로 글자 → 그림, 숨김으로 그림 → 글자) 맨 아래는 맨 아래이고, 위로 올려 읽던 중이면
//   ④ 보던 메시지의 화면(창) 위치가 2px 넘게 움직이지 않는다(이 목록 안에서는 어느 엔진도 스크롤 앵커링을 하지 않는다 — 가상
//      목록이 줄마다, 타임라인이 스크롤러에 `overflow-anchor:none`을 건다, #5638).
// 연결이 끊겼다 돌아와도(기기 오프라인 · 서버에 닿지 못함) ⑤ 맨 아래의 마지막 줄과 위를 읽던 줄이 **창에서** 1px 넘게 움직이지
// 않는다 — 1280 · 900 · 390. 목록 안쪽 좌표(바닥 거리 · 스크롤러 위쪽에서 줄까지)는 목록 상자가 통째로 움직이면 0을 보고하므로
// (#5575 검수 H1: 입력창 위 오프라인 줄 26~44px, 머리 아래 허들 배너 39px), 마지막 줄의 아래 끝과 보던 줄의 위 끝을 창 좌표로도 잰다.
// 칸 안의 이름 표지(`data-expression-label`, 오래 가는 오프라인·실패에서 같은 크기 칸 안에 서는 `:이름:`)는 「글자로 바뀜」으로 세지
// 않는다 — 칸의 크기가 그대로이기 때문이다.
//
// 실제 번들 · 실제 가상 목록 · 실제 이모티콘 저장소/그림 칸을 **WebKit**(데스크탑 앱의 WKWebView와 같은 엔진)과 Chromium에서
// 잰다. 서버는 이 파일의 가짜 `/v1`과 가짜 실시간(센트리퓨고 JSON 프로토콜의 최소판, `routeWebSocket`)이다. 인물·대화는 지어낸 것이다.
//
// 사용: npm run build && node gates/gate-expression-jitter.mjs
//   EXPRESSION_JITTER_ENGINES=webkit,chromium   (기본 둘 다)
//   EXPRESSION_JITTER_PORT=<포트>               미리보기 포트(기본 5207)
//   EXPRESSION_JITTER_OUT=<폴더>                프레임 기록 JSON을 남긴다
//   EXPRESSION_JITTER_MEASURE_ONLY=1            단정 없이 숫자만 찍는다(원인 실측용, 메커니즘 탐침 포함)
//   EXPRESSION_JITTER_REAL_INTERVAL=1           30초 주기 다시 읽기를 실제로 한 번 기다린다(기본은 같은 함수를 부르는 창 포커스로 대신한다)
//   EXPRESSION_JITTER_DIST=<폴더>               dist 대신 이 번들을 띄운다(수리 전 번들로 RED 를 다시 보일 때)
//   EXPRESSION_JITTER_IMAGE_DELAY_MS=<ms>       그림 응답 지연(기본 250: 실제 망처럼 가상 목록의 100ms 따라붙기 창 밖에서 도착한다)
//   EXPRESSION_JITTER_CAPTURE=<폴더>            오프라인 흔들림 장면에서 대화 목록을 찍는다(온라인 · 오프라인 1초 · 돌아온 뒤)
//   EXPRESSION_JITTER_ONLY=connection           연결 끊김 → 돌아옴 장면(창 기준, 1280 · 900 · 390)만 돈다
//   EXPRESSION_JITTER_ONLY=bottom               맨 아래 장면(1~10, 등록 · 숨김 포함)만 돈다
//   EXPRESSION_JITTER_REPEAT=<N>                맨 아래 장면을 새 창으로 N번 되풀이한다(기본 1, 단정은 회차마다 같다 — #5638)
// 머리 출력: 엔진마다 `CSS.supports('overflow-anchor','auto')`와 타임라인 스크롤러의 계산값을 찍는다(#5638, `engine-anchor.mjs`).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { printEngineAnchorHeader, scrollerOverflowAnchor } from "./engine-anchor.mjs";
import { startGuardedPreview } from "./preview-guard.mjs";
import { nothingRan, positiveIntEnv } from "./still-measure.mjs";
import {
  ANCHOR_TEXT,
  BASE_IMAGES,
  focusEvent,
  installBackend as installSharedBackend,
  openDm as openSharedDm,
  placeAnchor,
  scrollerSelector,
  settleToBottom,
  untilTrue,
  wait,
} from "./timeline-fake-backend.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.EXPRESSION_JITTER_PORT || 5207);
const origin = `http://127.0.0.1:${port}`;
const engineNames = (process.env.EXPRESSION_JITTER_ENGINES || "webkit,chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const outDir = process.env.EXPRESSION_JITTER_OUT || null;
const measureOnly = process.env.EXPRESSION_JITTER_MEASURE_ONLY === "1";
const realInterval = process.env.EXPRESSION_JITTER_REAL_INTERVAL === "1";
const viewport = { width: 1280, height: 800 };
/** 연결 끊김 → 돌아옴을 창 기준으로 재는 폭들(넓은 창 · 좁은 창 · 폰 폭). 폰 폭에서는 셸 위쪽 연결 띠도 선다. */
const connectionViewports = [
  { width: 1280, height: 800 },
  { width: 900, height: 800 },
  { width: 390, height: 844 },
];
const onlyScene = process.env.EXPRESSION_JITTER_ONLY || null;
// 1 이상의 정수가 아니면 시작 전에 실패한다(#5644 검수 M1: `abc` 가 NaN 이 되어 장면 0번 · PASS 였다).
const bottomRepeat = positiveIntEnv("EXPRESSION_JITTER_REPEAT", 1);
const imageDelayMs = Number(process.env.EXPRESSION_JITTER_IMAGE_DELAY_MS || 250);
if (engineNames.length === 0) throw new Error("EXPRESSION_JITTER_ENGINES 가 비었다");
const distOverride = process.env.EXPRESSION_JITTER_DIST || null;
const captureDir = process.env.EXPRESSION_JITTER_CAPTURE || null;

async function capture(page, engine, name) {
  if (captureDir === null) return;
  mkdirSync(captureDir, { recursive: true });
  await page.locator('[data-testid="chat-timeline"]').screenshot({ path: resolve(captureDir, `${engine}-${name}.png`) });
}

/** 창 전체를 찍는다(창 기준 흔들림은 목록 밖 — 머리 · 배너 · 입력창 — 이 함께 보여야 읽힌다). */
async function captureWindow(page, engine, name) {
  if (captureDir === null) return;
  mkdirSync(captureDir, { recursive: true });
  await page.screenshot({ path: resolve(captureDir, `${engine}-${name}.png`) });
}


// 가짜 서버 · 대화 픽스처는 `timeline-fake-backend.mjs`(#5641 장면표 게이트와 공용)에 있다. 이 게이트는 그 기본값을 쓴다.
const installBackend = (context) => installSharedBackend(context, { port, imageDelayMs });
const openDm = (page, backend) => openSharedDm(page, backend, origin);

// ---------------------------------------------------------------------------------------------- 계측

/**
 * 프레임마다 그려진 모양을 적는다(rAF 안에서 게시한 메시지는 그 프레임의 그리기 · ResizeObserver 콜백이 끝난 뒤에 돈다).
 * 그 사이의 잠깐 값도 놓치지 않게 MutationObserver가 「글자 폴백이 붙은 횟수」와 「필이 선 횟수」를 따로 센다.
 */
async function installProbe(page) {
  await page.addInitScript(() => {
    window.__ej = { on: false, gen: 0 };
  });
}

async function startWindow(page, { expectImages, anchorText = null }) {
  await page.evaluate(
    ({ expectImages, anchorText }) => {
      const J = window.__ej;
      const timeline = document.querySelector('[data-testid="chat-timeline"]');
      const scroller = timeline?.querySelector("[data-virtuoso-scroller]");
      if (!timeline || !scroller) throw new Error("계측할 목록이 없다");
      const known = new Set(expectImages);
      const pattern = /:([a-z0-9_-]{2,30}):/g;
      /** 이 노드 아래의 「그림이어야 하는데 글자인」 이모티콘 이름들. */
      // 같은 크기 칸 안의 이름 표지는 세지 않는다(칸의 크기가 그대로다). 칸을 버리고 글자가 된 것만 센다.
      const inLabel = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest?.("[data-expression-label]") != null;
      const textHits = (root) => {
        const hits = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (inLabel(node)) continue;
          for (const match of node.data.matchAll(pattern)) if (known.has(match[1])) hits.push(match[1]);
        }
        return hits;
      };
      const anchorRow = () => {
        if (anchorText === null) return null;
        for (const row of scroller.querySelectorAll("[data-index]")) if (row.textContent?.includes(anchorText)) return row;
        return null;
      };
      J.frames = [];
      J.intermediate = [];
      J.scrolls = [];
      J.textInsertions = [];
      J.pillMounts = 0;
      J.on = true;
      J.gen += 1;
      const gen = J.gen;
      const live = () => J.on && J.gen === gen;
      const t0 = performance.now();
      const onScroll = () => {
        if (live()) J.scrolls.push({ t: Math.round(performance.now() - t0), top: scroller.scrollTop });
      };
      // 그려진 모양만 센다: 이 프레임의 rAF 뒤로 DOM 이 바뀌었으면(React 의 커밋이 그리기와 이 표본 사이에 끼었다) 그 표본은 아직 그려지지
      // 않은 중간 상태다(다음 그리기 전에 ResizeObserver 가 바로잡을 수 있다). 그런 표본은 따로 적는다.
      let dirty = false;
      const dirtyWatch = new MutationObserver(() => {
        dirty = true;
      });
      dirtyWatch.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      scroller.addEventListener("scroll", onScroll, { passive: true });
      const mo = new MutationObserver((records) => {
        if (!live()) return;
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 && (node.matches?.('[data-testid="jump-latest"]') || node.querySelector?.('[data-testid="jump-latest"]'))) J.pillMounts += 1;
            if (!scroller.contains(node) || inLabel(node)) continue;
            const hits = node.nodeType === 3 ? [...node.data.matchAll(pattern)].map((m) => m[1]).filter((n) => known.has(n)) : textHits(node);
            if (hits.length) J.textInsertions.push({ t: Math.round(performance.now() - t0), hits });
          }
          if (record.type === "characterData" && scroller.contains(record.target) && !inLabel(record.target)) {
            const hits = [...record.target.data.matchAll(pattern)].map((m) => m[1]).filter((n) => known.has(n));
            if (hits.length) J.textInsertions.push({ t: Math.round(performance.now() - t0), hits });
          }
        }
      });
      mo.observe(timeline, { childList: true, subtree: true, characterData: true });
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (!live()) return;
        const anchor = anchorRow();
        const scrollerBox = scroller.getBoundingClientRect();
        const scrollerTop = scrollerBox.top;
        const rows = scroller.querySelectorAll("[data-index]");
        const last = rows[rows.length - 1] ?? null;
        const round = (value) => Math.round(value * 100) / 100;
        (dirty ? J.intermediate : J.frames).push({
          t: Math.round(performance.now() - t0),
          top: scroller.scrollTop,
          sh: scroller.scrollHeight,
          gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          pill: document.querySelector('[data-testid="jump-latest"]') !== null,
          text: textHits(scroller).length,
          canvases: scroller.querySelectorAll("canvas.expression-image").length,
          images: scroller.querySelectorAll("img.expression-image").length,
          anchorY: anchor ? Math.round((anchor.getBoundingClientRect().top - scrollerTop) * 100) / 100 : null,
          // 창 좌표(#5575 검수 H1): 사람의 눈이 보는 자리. 목록 상자가 통째로 움직여도 잡힌다.
          anchorScreen: anchor ? round(anchor.getBoundingClientRect().top) : null,
          lastIndex: last?.getAttribute("data-index") ?? null,
          lastBottom: last ? round(last.getBoundingClientRect().bottom) : null,
          scrollerTop: round(scrollerTop),
          scrollerBottom: round(scrollerBox.bottom),
          typing: document.querySelector('[data-testid="typing-line"][data-state="on"], [data-testid="composer-typing"]') !== null,
          blocked: document.querySelector('[data-testid="composer-offline"]') !== null,
        });
      };
      // 창을 여는 순간의 그려진 모양을 첫 표본으로 둔다: 장면의 변화가 첫 rAF 보다 먼저 오더라도 「바뀌기 전」이 기록에 남는다.
      channel.port1.onmessage();
      const tick = () => {
        if (!live()) {
          scroller.removeEventListener("scroll", onScroll);
          mo.disconnect();
          dirtyWatch.disconnect();
          return;
        }
        dirty = false;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { expectImages, anchorText }
  );
}

async function stopWindow(page) {
  return page.evaluate(() => {
    const J = window.__ej;
    J.on = false;
    return { frames: J.frames, intermediate: J.intermediate, scrolls: J.scrolls, textInsertions: J.textInsertions, pillMounts: J.pillMounts };
  });
}

function summarize(label, raw, extra = {}) {
  const frames = raw.frames;
  const gaps = frames.map((frame) => frame.gap);
  const anchors = frames.map((frame) => frame.anchorY).filter((value) => value !== null);
  const spread = (values) => (values.length ? Math.round((Math.max(...values) - Math.min(...values)) * 100) / 100 : null);
  const anchorScreens = frames.map((frame) => frame.anchorScreen).filter((value) => value !== null && value !== undefined);
  // 마지막 줄이 바뀌면(새 줄이 붙음) 같은 줄끼리만 견준다: 첫 표본의 마지막 줄.
  const firstLast = frames.find((frame) => frame.lastIndex !== null)?.lastIndex ?? null;
  const lastBottoms = frames.filter((frame) => frame.lastIndex === firstLast && frame.lastBottom !== null).map((frame) => frame.lastBottom);
  const pillFrames = frames.filter((frame) => frame.pill).length;
  let pillShows = 0;
  for (let i = 0; i < frames.length; i += 1) if (frames[i].pill && (i === 0 || !frames[i - 1].pill)) pillShows += 1;
  return {
    label,
    frames: frames.length,
    maxText: frames.length ? Math.max(...frames.map((frame) => frame.text)) : 0,
    textFrames: frames.filter((frame) => frame.text > 0).length,
    textInsertions: raw.textInsertions.length,
    textNames: [...new Set(raw.textInsertions.flatMap((entry) => entry.hits))],
    maxGap: gaps.length ? Math.max(...gaps) : null,
    gapFrames: frames.filter((frame) => frame.gap > 1).length,
    finalGap: frames.length ? frames[frames.length - 1].gap : null,
    pillShows,
    pillFrames,
    pillMounts: raw.pillMounts,
    scrollEvents: raw.scrolls.length,
    heights: [...new Set(frames.map((frame) => frame.sh))].slice(0, 12),
    maxCanvases: frames.length ? Math.max(...frames.map((frame) => frame.canvases)) : 0,
    minImages: frames.length ? Math.min(...frames.map((frame) => frame.images)) : 0,
    intermediateSamples: raw.intermediate.length,
    intermediateMaxGap: raw.intermediate.length ? Math.max(...raw.intermediate.map((frame) => frame.gap)) : null,
    anchorSpread: anchors.length ? Math.round((Math.max(...anchors) - Math.min(...anchors)) * 100) / 100 : null,
    anchorFirst: anchors[0] ?? null,
    anchorLast: anchors[anchors.length - 1] ?? null,
    anchorScreenSpread: spread(anchorScreens),
    anchorScreenRange: anchorScreens.length ? [Math.min(...anchorScreens), Math.max(...anchorScreens)] : null,
    lastBottomSpread: spread(lastBottoms),
    lastBottomRange: lastBottoms.length ? [Math.min(...lastBottoms), Math.max(...lastBottoms)] : null,
    lastRowChanged: frames.some((frame) => frame.lastIndex !== null && frame.lastIndex !== firstLast),
    scrollerTops: [...new Set(frames.map((frame) => frame.scrollerTop))].slice(0, 8),
    scrollerBottoms: [...new Set(frames.map((frame) => frame.scrollerBottom))].slice(0, 8),
    typingFrames: frames.filter((frame) => frame.typing).length,
    blockedFrames: frames.filter((frame) => frame.blocked).length,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------- 장면


async function runBottomScene(browser, engine, run = 1) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR" });
  const backend = await installBackend(context);
  const page = await context.newPage();
  await installProbe(page);
  await openDm(page, backend);
  if (run === 1) console.log(`[${engine}] 타임라인 스크롤러 overflow-anchor=${await scrollerOverflowAnchor(page, scrollerSelector)}`);
  const results = [];
  const record = async (label, body, { expect = BASE_IMAGES, settle = 1_200 } = {}) => {
    const before = { ...backend.state, sockets: undefined, active: undefined };
    const contentHeight = () => page.evaluate((selector) => document.querySelector(selector).scrollHeight, scrollerSelector);
    const heightBefore = await contentHeight();
    await startWindow(page, { expectImages: expect });
    await body();
    await wait(settle);
    const raw = await stopWindow(page);
    const extra = {
      heightBefore,
      heightAfter: await contentHeight(),
      listReads: backend.state.listReads - before.listReads,
      listReadsFailed: backend.state.listReadsFailed - before.listReadsFailed,
      imageReads: backend.state.imageReads - before.imageReads,
      imageReadsFailed: backend.state.imageReadsFailed - before.imageReadsFailed,
      handshakes: backend.state.handshakes - before.handshakes,
    };
    results.push({ summary: summarize(label, raw, extra), raw });
  };

  await record("1 포커스(30초 다시 읽기와 같은 함수) ×4", async () => {
    for (let i = 0; i < 4; i += 1) {
      await focusEvent(page);
      await wait(700);
    }
  });
  if (realInterval) {
    await record("1b 30초 주기 다시 읽기(실제)", async () => {
      await wait(31_000);
    });
  }
  await record("2 세대 교체(옛 변경 알림) ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      backend.bumpCatalog();
      await wait(900);
    }
  });
  await record("3 실시간 다시 연결 ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      const handshakes = backend.state.handshakes;
      backend.dropSockets();
      await untilTrue(async () => backend.state.handshakes > handshakes && backend.subscribed("expressions:"), "다시 연결");
      await wait(900);
    }
  });
  await record("4 다시 연결 + 그림 받기 실패(서버 재시작) ×2", async () => {
    for (let i = 0; i < 2; i += 1) {
      backend.images("abort");
      const handshakes = backend.state.handshakes;
      backend.dropSockets();
      await untilTrue(async () => backend.state.handshakes > handshakes && backend.subscribed("expressions:"), "다시 연결");
      await wait(1_200);
      backend.images("ok");
      await wait(800);
    }
  });
  await record("5 기기 오프라인 흔들림 ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      if (i === 0) await capture(page, engine, "1-online");
      await context.setOffline(true);
      await wait(1_000);
      if (i === 0) await capture(page, engine, "2-offline");
      await wait(300);
      await context.setOffline(false);
      await wait(1_800);
      if (i === 0) await capture(page, engine, "3-back-online");
    }
  }, { settle: 2_000 });
  await record("6 서버에 닿지 못함 선언 ×2", async () => {
    for (let i = 0; i < 2; i += 1) {
      backend.rest("abort");
      const deadline = Date.now() + 8_000;
      // 서로 다른 요청 3건이 연달아 닿지 못해야 선언이 선다: 포커스(목록 읽기 등)와 실시간 끊기(토큰·다시 읽기)로 요청을 낸다.
      backend.dropSockets();
      while (Date.now() < deadline) {
        await focusEvent(page);
        await wait(400);
        const blocked = await page.evaluate(() => document.querySelector('[data-testid="composer-offline"]') !== null);
        if (blocked) break;
      }
      await wait(1_200);
      backend.rest("ok");
      await focusEvent(page);
      await untilTrue(async () => page.evaluate(() => document.querySelector('[data-testid="composer-offline"]') === null), "선언이 풀림", 20_000);
      await wait(1_500);
    }
  }, { settle: 2_000 });
  await record("7 상대 「입력 중」 켜고 끄기 ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      backend.typing(700);
      await wait(1_700);
    }
  });

  // 진짜 높이 변화: 맨 아래에서.
  // 등록 전의 `:new_badge:` 는 모르는 이름이라 글자가 맞다. 그림이 됐는지는 다음 창(9)이 `new_badge` 까지 그림으로 센다.
  await record("8 등록: 글자였던 이름이 그림이 된다(목록이 자람)", async () => {
    backend.detail("created", "badge");
    await wait(1_500);
  });
  await record("9 숨김: 그림이 글자가 된다(목록이 줆)", async () => {
    backend.detail("hidden", "cat");
    await wait(1_500);
  }, { expect: [...BASE_IMAGES.filter((name) => name !== "sleepy_cat"), "new_badge"] });

  // 화면 밖으로 갔다 돌아오기(IntersectionObserver · 줄 다시 붙이기): 글자만 센다.
  await record("10 화면 밖 갔다 오기(보임 바뀜)", async () => {
    await page.evaluate((selector) => {
      document.querySelector(selector).scrollTop -= 1_600;
    }, scrollerSelector);
    await wait(900);
    await page.evaluate((selector) => {
      const scroller = document.querySelector(selector);
      scroller.scrollTop = scroller.scrollHeight;
    }, scrollerSelector);
    await wait(900);
  }, { expect: [...BASE_IMAGES.filter((name) => name !== "sleepy_cat"), "new_badge"] });

  if (measureOnly) results.push(...(await mechanismProbe(page)));
  await context.close();
  return results.map((entry) => ({ engine, scene: "bottom", run, ...entry }));
}


/**
 * 연결 끊김 → 돌아옴, **창 기준** (#5575 검수 H1). 맨 아래에 붙은 채(C1)와 위를 읽던 중(C2)에 기기 오프라인을 두 번 흔든다.
 * 오프라인이 되면 입력창 쪽 「보낼 수 없어요」 줄 · 머리 아래 허들 배너 · (폰 폭) 셸 위쪽 연결 띠가 서고 진다. 목록 안쪽 좌표는 목록 상자가
 * 통째로 움직이면 0을 보고하므로, 마지막 줄의 아래 끝과 보던 줄의 위 끝을 창 좌표로 잰다.
 */
async function runConnectionScene(browser, engine, vp) {
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, locale: "ko-KR" });
  const backend = await installBackend(context);
  const page = await context.newPage();
  await installProbe(page);
  await openDm(page, backend);
  const results = [];
  const record = async (label, body, { anchorText = null } = {}) => {
    await startWindow(page, { expectImages: BASE_IMAGES, anchorText });
    await body();
    await wait(1_500);
    const raw = await stopWindow(page);
    results.push({ summary: summarize(label, raw, { width: vp.width }), raw });
  };
  const flap = async (tag) => {
    for (let i = 0; i < 2; i += 1) {
      if (i === 0) await captureWindow(page, engine, `${tag}-${vp.width}-1-online`);
      await context.setOffline(true);
      await wait(1_500);
      if (i === 0) await captureWindow(page, engine, `${tag}-${vp.width}-2-offline`);
      await context.setOffline(false);
      await wait(2_500);
      if (i === 0) await captureWindow(page, engine, `${tag}-${vp.width}-3-back`);
    }
  };
  // 위 읽기를 먼저 잰다: 한 번 흔든 뒤에는 허들 상태가 「불러오지 못했습니다」 배너로 남아(검수 O2) 위 가장자리가 더 움직이지 않을 수 있다.
  await placeAnchor(page);
  await wait(1_500);
  await record(`C2 위 읽기: 연결 끊김 → 돌아옴 ×2 (창 기준, ${vp.width})`, () => flap("C2"), { anchorText: ANCHOR_TEXT });
  await settleToBottom(page);
  await record(`C1 맨 아래: 연결 끊김 → 돌아옴 ×2 (창 기준, ${vp.width})`, () => flap("C1"));
  await context.close();
  return results.map((entry) => ({ engine, scene: "connection", ...entry }));
}

/** 위로 올려 읽던 중: 보던 줄이 화면에서 움직이지 않아야 한다. */
async function runAnchorScene(browser, engine) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR" });
  const backend = await installBackend(context);
  const page = await context.newPage();
  await installProbe(page);
  await openDm(page, backend);
  await placeAnchor(page);
  await wait(1_500);
  const results = [];
  const record = async (label, body, { expect = BASE_IMAGES, settle = 1_200, extra = {} } = {}) => {
    await startWindow(page, { expectImages: expect, anchorText: ANCHOR_TEXT });
    await body();
    await wait(settle);
    const raw = await stopWindow(page);
    results.push({ summary: summarize(label, raw, extra), raw });
  };
  await record("A1 일시적 상태들(세대 교체 · 다시 연결 · 포커스 · 오프라인 흔들림 · 입력 중)", async () => {
    backend.bumpCatalog();
    await wait(900);
    const handshakes = backend.state.handshakes;
    backend.dropSockets();
    await untilTrue(async () => backend.state.handshakes > handshakes && backend.subscribed("expressions:"), "다시 연결");
    await wait(900);
    await focusEvent(page);
    await wait(700);
    await context.setOffline(true);
    await wait(1_300);
    await context.setOffline(false);
    await wait(1_800);
    backend.typing(700);
    await wait(1_500);
  });
  /** 바뀔 줄이 붙어 있고(가상 목록 안) 화면 위 밖에 있는가(바닥이 스크롤러 위쪽보다 위). */
  const above = (name) =>
    page.evaluate(
      ({ selector, name }) => {
        const scroller = document.querySelector(selector);
        const row = [...scroller.querySelectorAll("[data-index]")].find((node) => node.textContent?.includes(`:${name}:`) || node.querySelector(`[data-expression-name="${name}"]`));
        if (!row) return "붙어 있지 않다";
        const gap = scroller.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
        return gap > 0 ? true : `화면 안에 있다(위쪽에서 ${Math.round(-gap)}px 아래까지)`;
      },
      { selector: scrollerSelector, name }
    );
  // 등록 전의 `:late_star:` 는 모르는 이름이라 글자가 맞다(셀 이름에서 뺀다). 숨김 뒤의 `:old_flag:` 도 같다.
  const starAbove = await above("late_star");
  await record("A2 위쪽에서 등록(글자 → 그림, 보던 곳 위가 자람)", async () => {
    backend.detail("created", "star");
    await wait(1_500);
  }, { extra: { targetAbove: starAbove } });
  const flagAbove = await above("old_flag");
  await record("A3 위쪽에서 숨김(그림 → 글자, 보던 곳 위가 줆)", async () => {
    backend.detail("hidden", "flag");
    await wait(1_500);
  }, { expect: [...BASE_IMAGES.filter((name) => name !== "old_flag"), "late_star"], extra: { targetAbove: flagAbove } });
  await context.close();
  return results.map((entry) => ({ engine, scene: "anchor", ...entry }));
}

/** 메커니즘 탐침(측정 전용): 줄 하나의 높이를 바꿨을 때 이 엔진 · 이 목록이 스크롤을 어떻게 다루는가. */
async function mechanismProbe(page) {
  const probe = await page.evaluate(async (selector) => {
    const scroller = document.querySelector(selector);
    const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    scroller.scrollTop = scroller.scrollHeight;
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    const rows = [...scroller.querySelectorAll("[data-index]")];
    const box = scroller.getBoundingClientRect();
    const inView = rows.filter((row) => row.getBoundingClientRect().bottom > box.top && row.getBoundingClientRect().top < box.bottom);
    const last = inView[inView.length - 1];
    const out = { atBottom: { start: { gap: gap(), top: scroller.scrollTop } } };
    // (a) 맨 아래: 화면 안 줄이 120px 줄었다가(그림 → 글자) 다시 자란다(글자 → 그림).
    const spacer = document.createElement("div");
    spacer.style.height = "120px";
    last.appendChild(spacer);
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    scroller.scrollTop = scroller.scrollHeight;
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    out.atBottom.withSpacer = { gap: gap(), top: scroller.scrollTop };
    spacer.remove();
    await frames();
    out.atBottom.shrunk = { gap: gap(), top: scroller.scrollTop };
    await new Promise((done) => setTimeout(done, 300));
    last.appendChild(spacer);
    await frames();
    out.atBottom.grownSameTask = { gap: gap(), top: scroller.scrollTop };
    await new Promise((done) => setTimeout(done, 400));
    out.atBottom.grownLater = { gap: gap(), top: scroller.scrollTop };
    spacer.remove();
    scroller.scrollTop = scroller.scrollHeight;
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    // (b) 위를 읽는 중: 화면 위쪽 밖의 줄이 120px 자란다.
    scroller.scrollTop -= 900;
    await frames();
    await new Promise((done) => setTimeout(done, 400));
    const rows2 = [...scroller.querySelectorAll("[data-index]")];
    const box2 = scroller.getBoundingClientRect();
    const above = rows2.filter((row) => row.getBoundingClientRect().bottom < box2.top - 10);
    const visible = rows2.find((row) => row.getBoundingClientRect().top >= box2.top);
    const before = visible.getBoundingClientRect().top;
    const topBefore = scroller.scrollTop;
    const grow = document.createElement("div");
    grow.style.height = "120px";
    above[above.length - 1]?.appendChild(grow);
    await frames();
    const sameFrames = visible.getBoundingClientRect().top - before;
    await new Promise((done) => setTimeout(done, 400));
    out.readingUp = {
      aboveRows: above.length,
      moveAfter2Frames: Math.round(sameFrames * 100) / 100,
      moveAfter400ms: Math.round((visible.getBoundingClientRect().top - before) * 100) / 100,
      scrollTopDelta: scroller.scrollTop - topBefore,
      overflowAnchorScroller: getComputedStyle(scroller).overflowAnchor,
      overflowAnchorRow: getComputedStyle(visible).overflowAnchor,
    };
    grow.remove();
    return out;
  }, scrollerSelector);
  return [{ summary: { label: "탐침", probe }, raw: null }];
}

// ---------------------------------------------------------------------------------------------- 판정

function judge(all) {
  const failures = [];
  for (const entry of all) {
    const { summary, engine, scene, run } = entry;
    if (summary.probe) continue;
    const where = `${engine}${bottomRepeat > 1 ? ` #${run}` : ""} ${summary.label}`;
    if (summary.frames < 20) failures.push(`${where}: 그려진 프레임 표본이 ${summary.frames}개뿐이다(재기가 장면을 못 봤다)`);
    if (summary.maxText !== 0 || summary.textInsertions !== 0) {
      failures.push(`${where}: 아는 이모티콘이 :이름: 글자로 바뀌었다 (프레임 최대 ${summary.maxText}개, 붙은 횟수 ${summary.textInsertions}, ${JSON.stringify(summary.textNames)})`);
    }
    if (scene === "bottom" && !summary.label.startsWith("10")) {
      // 진짜 높이 변화(등록 · 숨김)도 두 엔진 모두 바닥 거리 ≤1px 이다(#5638). 예전에는 Chromium 만 기록만 했다(#5583 당시 가상 목록이
      // 바로잡은 scrollTop 을 한 프레임 되돌려 쓰고 끝맞춤이 2px 모자랐다). 2026-11-10 새 창 10번 되풀이
      // (`EXPRESSION_JITTER_ONLY=bottom EXPRESSION_JITTER_REPEAT=10`)에서 스크롤러 앵커링을 끈 번들도, 끄기 전 번들도 10/10 바닥 거리 0 ·
      // 마지막 줄 ≤0.75px 이라 단정으로 올렸다 — 2px 모자람은 지금 번들에서 재현되지 않는다. 바닥 붙이기(`scrollHold`)를 끈 번들에서는
      // Chromium 등록이 165px, 숨김이 2px 떨어져 이 단정이 빨개진다.
      if (summary.maxGap > 1) {
        failures.push(`${where}: 맨 아래에 붙은 목록이 ${summary.maxGap}px 떨어졌다(${summary.gapFrames}프레임)`);
      }
      if (summary.pillShows !== 0 || summary.pillMounts !== 0) {
        failures.push(`${where}: 「최신 메시지로 이동」이 ${Math.max(summary.pillShows, summary.pillMounts)}번 섰다`);
      }
      // 창 기준(#5575 검수 H1): 바닥 거리가 0이어도 목록 상자가 움직이면 마지막 줄이 화면에서 움직인다.
      if (summary.lastBottomSpread === null || summary.lastBottomSpread > 1) {
        failures.push(`${where}: 맨 아래의 마지막 줄이 창에서 ${summary.lastBottomSpread}px 움직였다 ${JSON.stringify(summary.lastBottomRange)}`);
      }
    }
    if (scene === "connection") {
      if (summary.blockedFrames === 0) failures.push(`${where}: 오프라인이 서지 않았다(장면을 못 만들었다)`);
      if (summary.label.startsWith("C1")) {
        // 맨 아래에서는 같은 마지막 줄을 재야 한다(위를 읽는 중에는 목록 상자 크기에 따라 붙는 줄이 바뀌어도 된다).
        if (summary.lastRowChanged) failures.push(`${where}: 마지막 줄이 바뀌었다(장면을 못 만들었다)`);
        if (summary.lastBottomSpread === null || summary.lastBottomSpread > 1) {
          failures.push(`${where}: 맨 아래의 마지막 줄이 창에서 ${summary.lastBottomSpread}px 움직였다 ${JSON.stringify(summary.lastBottomRange)}`);
        }
        if (summary.maxGap > 1) failures.push(`${where}: 맨 아래에 붙은 목록이 ${summary.maxGap}px 떨어졌다(${summary.gapFrames}프레임)`);
        if (summary.pillShows !== 0 || summary.pillMounts !== 0) {
          failures.push(`${where}: 「최신 메시지로 이동」이 ${Math.max(summary.pillShows, summary.pillMounts)}번 섰다`);
        }
      }
      if (summary.label.startsWith("C2") && (summary.anchorScreenSpread === null || summary.anchorScreenSpread > 1)) {
        failures.push(`${where}: 위를 읽던 줄이 창에서 ${summary.anchorScreenSpread}px 움직였다 ${JSON.stringify(summary.anchorScreenRange)}`);
      }
      // 장면이 실제로 만들어졌는가: 위를 읽는 동안 목록 상자의 위 가장자리가 한 번은 움직였어야 한다(배너 · 띠가 섰다).
      if (summary.label.startsWith("C2") && summary.scrollerTops.length < 2) {
        failures.push(`${where}: 목록의 위 가장자리가 한 번도 움직이지 않았다(장면을 못 만들었다)`);
      }
    }
    if (scene === "bottom" && summary.label.startsWith("10") && summary.finalGap > 1) {
      failures.push(`${where}: 돌아온 뒤 목록이 바닥에서 ${summary.finalGap}px 떨어져 있다`);
    }
    if (scene === "anchor" && summary.targetAbove !== undefined && summary.targetAbove !== true) {
      failures.push(`${where}: 바뀔 줄이 화면 위 밖에 붙어 있지 않다 — ${summary.targetAbove}(장면을 못 만들었다)`);
    }
    // 보던 줄의 자는 **창 좌표**다(#5575 검수 H1). 목록 안쪽 좌표(`anchorSpread`)는 기록만 한다: 목록 상자가 움직일 때(배너 · 띠) 줄을 창에서
    // 제자리에 두려면 목록 안쪽 좌표는 그만큼 바뀌어야 하고, 옛 판처럼 안쪽 좌표만 지키면 줄이 상자와 함께 창에서 움직인다.
    // 창 기준: 연결 흔들림이 든 A1은 1px, 진짜 높이 변화(A2 · A3)는 2px.
    const screenLimit = summary.label.startsWith("A1") ? 1 : 2;
    if (scene === "anchor" && (summary.anchorScreenSpread === null || summary.anchorScreenSpread > screenLimit)) {
      failures.push(`${where}: 보던 줄이 창에서 ${summary.anchorScreenSpread}px 움직였다(${screenLimit}px 이하여야 한다) ${JSON.stringify(summary.anchorScreenRange)}`);
    }
    // 장면이 실제로 만들어졌는가.
    if (summary.label.startsWith("5") && summary.blockedFrames === 0) failures.push(`${where}: 오프라인이 서지 않았다(장면을 못 만들었다)`);
    if (summary.label.startsWith("6") && summary.blockedFrames === 0) failures.push(`${where}: 서버에 닿지 못함 선언이 서지 않았다(장면을 못 만들었다)`);
    if ((summary.label.startsWith("4") || summary.label.startsWith("6")) && summary.imageReadsFailed === 0) {
      failures.push(`${where}: 그림 받기가 한 번도 실패하지 않았다(장면을 못 만들었다)`);
    }
    if (summary.label.startsWith("7") && summary.typingFrames === 0) failures.push(`${where}: 상대 「입력 중」이 그려지지 않았다(장면을 못 만들었다)`);
    if ((summary.label.startsWith("2") || summary.label.startsWith("3")) && summary.imageReads === 0) {
      failures.push(`${where}: 그림을 다시 받지 않았다 — 세대가 바뀌지 않았다(장면을 못 만들었다)`);
    }
    if (summary.label.startsWith("3") && summary.handshakes < 3) failures.push(`${where}: 실시간이 다시 붙지 않았다(장면을 못 만들었다)`);
    if (summary.label.startsWith("8") && summary.heightAfter <= summary.heightBefore) {
      failures.push(`${where}: 등록으로 목록이 자라지 않았다 ${summary.heightBefore}→${summary.heightAfter}(장면을 못 만들었다)`);
    }
    if (summary.label.startsWith("9") && summary.heightAfter >= summary.heightBefore) {
      failures.push(`${where}: 숨김으로 목록이 줄지 않았다 ${summary.heightBefore}→${summary.heightAfter}(장면을 못 만들었다)`);
    }
  }
  return failures;
}

async function main() {
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "EXPRESSION_JITTER_PORT",
    extraArgs: distOverride ? ["--outDir", resolve(distOverride)] : [],
  });
  const all = [];
  try {
    for (const name of engineNames) {
      const type = name === "webkit" ? webkit : name === "chromium" ? chromium : null;
      if (type === null) throw new Error(`모르는 엔진: ${name}`);
      const browser = await type.launch({ headless: true });
      try {
        await printEngineAnchorHeader(browser, name);
        if (onlyScene !== null && onlyScene !== "connection" && onlyScene !== "bottom") throw new Error(`모르는 장면: ${onlyScene}`);
        if (onlyScene === null || onlyScene === "bottom") {
          for (let run = 1; run <= bottomRepeat; run += 1) all.push(...(await runBottomScene(browser, name, run)));
        }
        if (onlyScene === null) all.push(...(await runAnchorScene(browser, name)));
        if (onlyScene === null || onlyScene === "connection") {
          for (const vp of connectionViewports) all.push(...(await runConnectionScene(browser, name, vp)));
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }
  for (const entry of all) console.log(`[${entry.engine}${bottomRepeat > 1 && entry.run ? ` #${entry.run}` : ""}] ${JSON.stringify(entry.summary)}`);
  if (outDir !== null) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "expression-jitter.json"), JSON.stringify(all, null, 1));
    console.log(`프레임 기록: ${resolve(outDir, "expression-jitter.json")}`);
  }
  if (measureOnly) return;
  const failures = judge(all);
  const empty = nothingRan(all.filter((entry) => !entry.summary.probe).length, "expression-jitter");
  if (empty !== null) failures.push(empty);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  if (onlyScene === "bottom") {
    console.log(`PASS expression-jitter (맨 아래 장면만 × ${bottomRepeat}회): ${engineNames.join("·")} — 글자 0 · 바닥 거리 ≤1px · 필 0 · 마지막 줄 창 기준 ≤1px`);
    return;
  }
  console.log(
    `PASS expression-jitter: ${engineNames.join("·")} — 글자 0 · 바닥 거리 0 · 필 0 · 보던 줄 ≤2px · 연결 끊김 → 돌아옴에 마지막 줄·보던 줄 창 기준 ≤1px (${connectionViewports.map((vp) => vp.width).join(" · ")})`
  );
}

await main();
