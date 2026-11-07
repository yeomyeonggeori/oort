#!/usr/bin/env node
// =============================================================================
// 이모티콘·GIF 누르기 캡처 (#5456, 웹·데스크탑 반쪽). 저장소 캡처 하네스 규약을 따른다:
// 번들 Chromium(또는 WebKit) 헤드리스 + 모의 `/v1`(gates/connection-harness.mjs, 시크릿 없음, 인물은 전부 가상).
// 그림 응답은 실제 HTTP 전송(`expressionHttpTransport`)으로 받는다: 요청 수를 네트워크 기록으로 센다.
//
//   node_modules/.bin/vite --host 127.0.0.1 --port 5456 --strictPort      # 자기 PID 로 띄우고 끝에 그 PID 만 끈다
//   node scripts/capture-5456.mjs --label after --engine chromium --assets <그림 폴더> --out <스크래치>/cap5456 --port 5456
//
// 그림 폴더는 `make_assets` 류 스크립트가 만든 프레임 번호가 색으로 읽히는 움직이는 GIF · 정지 PNG 여섯 장과 meta.json 이다
// (gif-small.gif · gif-large.gif · gif-thumb.png · static-small.png · static-large.png · static-thumb.png). 캡처는 저장소에 올리지 않는다.
//
// 재는 것(캡처가 곧 실행 증거다). 화면 갱신(requestAnimationFrame)마다 한 줄씩 적는다:
//   1. 정지 이모티콘: 누르기·올리기·창 초점 전후에 <img> 노드가 같은지, src 가 같은지, 상자 크기가 같은지.
//   2. GIF: 4회 재생 뒤 멈춘 그림을 누른 직후 1.5초 동안 그림이 빈 적이 있는지(<img> 없음 · 글자 자리표시 · 안 그려진 img),
//      <img> 노드가 바뀌었는지, 상자와 아래 줄이 움직였는지, 그림 요청이 나갔는지, 첫 장면부터 다시 도는지(캔버스로 모서리 근처 한 점의 색을 읽어 프레임 번호로 바꾼다).
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { GENERAL_ID, ME, TIMELINE, WORKSPACE_ID, installBackend, openGeneral, signIn, sleep } from "../gates/connection-harness.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const LABEL = String(arg("label", "after"));
const ENGINE = String(arg("engine", "chromium"));
const PORT = Number(arg("port", 5456));
const OUT = resolve(WEB_ROOT, String(arg("out", `captures/5456/${LABEL}`)));
const ASSETS = resolve(WEB_ROOT, String(arg("assets", "captures/5456/assets")));
const ORIGIN = `http://127.0.0.1:${PORT}`;
// 시험 그림의 프레임 색(make_assets 와 같은 순서). 글자(프레임 번호)를 피한 모서리 근처 한 점의 색으로 프레임 번호를 읽는다.
const FRAME_COLORS = [[230, 60, 60], [240, 150, 40], [230, 210, 50], [80, 190, 90], [50, 170, 210], [70, 100, 220], [140, 80, 200], [220, 80, 170]];
const PLAY_MS = 800;
// 그림 응답을 이만큼 늦춘다(ms). 지역 망은 0ms 라 실제 망의 「받는 동안」을 흉내 낼 때 쓴다.
const LATENCY = Number(arg("latency", 0));

const results = [];
function note(id, value) {
  results.push({ id, value });
  console.log(`  ${id}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

const asset = (name) => readFileSync(join(ASSETS, name));
const meta = JSON.parse(readFileSync(join(ASSETS, "meta.json"), "utf8"));
const mediaOf = (prefix, ext, thumbExt, mime, durationMs, frameCount) => {
  const image = (file, kind) => ({ mime: kind, sha256: meta[file].sha256, bytes: meta[file].bytes, width: meta[file].width, height: meta[file].height, frameCount, durationMs });
  return {
    small: image(`${prefix}-small.${ext}`, mime),
    large: image(`${prefix}-large.${ext}`, mime),
    thumb: { ...image(`${prefix}-thumb.${thumbExt}`, "image/png"), frameCount: 1, durationMs: 0 },
  };
};
const ITEMS = [
  { id: "00000000-0000-4000-8000-0000000000a1", name: "party_gif", displayName: "파티 움짤", tags: ["축하"], kind: "sticker", media: mediaOf("gif", "gif", "png", "image/gif", PLAY_MS, 8), files: { small: "gif-small.gif", large: "gif-large.gif", thumb: "gif-thumb.png" } },
  { id: "00000000-0000-4000-8000-0000000000a2", name: "static_dot", displayName: "파란 점", tags: ["정지"], kind: "sticker", media: mediaOf("static", "png", "png", "image/png", 0, 1), files: { small: "static-small.png", large: "static-large.png", thumb: "static-thumb.png" } },
].map((item, index) => ({
  ...item,
  workspaceId: WORKSPACE_ID, version: String(index + 1), status: "active", origin: { kind: "upload", sourceUrl: null, prompt: null },
  subjectMemberId: null, createdBy: ME, createdAtMs: 1_793_314_800_000,
}));

const NOW = Date.now();
function message(seq, body, author = ME) {
  return {
    id: `0199aa11-2222-7000-8000-${String(seq).padStart(12, "0")}`, channelId: GENERAL_ID, seq, hlcTs: NOW - (20 - seq) * 60_000, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: NOW - (20 - seq) * 60_000,
  };
}
// 7·8 은 하네스 기본 대화, 10 은 GIF 한 장(large), 11 은 정지 한 장(large), 12 는 글 사이의 GIF·정지(inline), 13 은 마지막 줄(아래 줄 기준점).
const MESSAGES = [...TIMELINE.slice(0, 2), message(10, ":party_gif:"), message(11, ":static_dot:"), message(12, "좋아요 :party_gif: 그리고 :static_dot: 이에요"), message(13, "마지막 줄이에요")];

const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function installExpressions(context, log) {
  await context.route(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/expressions(\\?.*)?$`), (route) => json(route, {
    workspaceId: WORKSPACE_ID, version: "3", baseVersion: null, reset: true, addPolicy: "members", items: ITEMS.map((item) => { const wire = { ...item }; delete wire.files; return wire; }),
  }));
  await context.route(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/expressions/[^/]+/image`), async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").slice(-2)[0];
    const size = url.searchParams.get("size") ?? "";
    const item = ITEMS.find((entry) => entry.id === id);
    log.push({ at: Date.now(), size, name: item?.name ?? "?" });
    if (!item || !item.files[size]) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    const file = item.files[size];
    if (LATENCY > 0) await sleep(LATENCY);
    return route.fulfill({ status: 200, contentType: file.endsWith(".gif") ? "image/gif" : "image/png", headers: { "Cache-Control": "private, no-store" }, body: asset(file) });
  });
  await context.route(new RegExp(`/v1/workspaces/[^/]+/channels/${GENERAL_ID}/messages(\\?.*)?$`), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return json(route, { messages: MESSAGES });
  });
}

/**
 * 페이지 안 기록기. 화면 갱신마다 대상 줄(`data-seq`)의 상태를 한 줄 적는다. 눌러 보는 쪽이 `mark()` 로 사건 시각을 박는다.
 * 노드 신원은 WeakMap 번호로 센다: 같은 번호면 같은 DOM 노드다.
 */
const RECORDER = `(() => {
  const ids = new WeakMap(); let next = 1;
  const idOf = (node) => { if (!node) return null; if (!ids.has(node)) ids.set(node, next++); return ids.get(node); };
  const probe = {
    rows: {}, marks: [], running: false, mutations: [],
    watch(seq) { probe.rows[seq] = []; if (!probe.running) { probe.running = true; requestAnimationFrame(tick); } },
    mark(name) { probe.marks.push({ name, t: performance.now() }); },
  };
  function tick() {
    for (const seq of Object.keys(probe.rows)) {
      const row = document.querySelector('[data-testid="timeline-message"][data-seq="' + seq + '"]');
      if (!row) { probe.rows[seq].push({ t: performance.now(), row: false }); continue; }
      const root = row.querySelector("[data-expression-name]");
      const img = root ? root.querySelector("img") : null;
      const rowBox = row.getBoundingClientRect();
      const rootBox = root ? root.getBoundingClientRect() : null;
      const imgBox = img ? img.getBoundingClientRect() : null;
      const last = document.querySelector('[data-testid="timeline-message"][data-seq="13"]');
      const text = root ? root.textContent : null;
      probe.rows[seq].push({
        t: performance.now(), row: true, root: !!root, img: !!img, node: idOf(img),
        kind: img ? (img.src.startsWith("data:image/gif") ? "gif" : img.src.startsWith("data:image/png") ? "png" : "other") : null,
        srcTag: img ? img.src.slice(0, 40) : null, srcLen: img ? img.src.length : 0,
        complete: img ? img.complete : null, nat: img ? [img.naturalWidth, img.naturalHeight] : null,
        box: imgBox ? [Math.round(imgBox.width * 10) / 10, Math.round(imgBox.height * 10) / 10] : null,
        rootBox: rootBox ? [Math.round(rootBox.width * 10) / 10, Math.round(rootBox.height * 10) / 10] : null,
        rowTop: Math.round(rowBox.top * 10) / 10, rowHeight: Math.round(rowBox.height * 10) / 10,
        lastTop: last ? Math.round(last.getBoundingClientRect().top * 10) / 10 : null,
        placeholder: !!root && !img && /^:[a-z0-9_-]+:$/.test(text || ""),
      });
    }
    requestAnimationFrame(tick);
  }
  const nativeDecode = HTMLImageElement.prototype.decode;
  probe.decodes = [];
  HTMLImageElement.prototype.decode = function () {
    const started = performance.now(); const tag = this.src.slice(0, 30) + ":" + this.src.length;
    return nativeDecode.call(this).then((value) => { probe.decodes.push({ tag, ms: Math.round(performance.now() - started) }); return value; }, (error) => { probe.decodes.push({ tag, error: String(error) }); throw error; });
  };
  window.__probe5456 = probe;
  for (const seq of [10, 11, 12]) probe.watch(seq);
})();`;

/** 색 → 프레임 번호(가장 가까운 색). 못 읽으면 null. */
function frameIndex(rgba) {
  if (!rgba || rgba[3] < 200) return null;
  let best = -1; let bestDistance = Infinity;
  FRAME_COLORS.forEach((color, at) => {
    const distance = Math.abs(color[0] - rgba[0]) + Math.abs(color[1] - rgba[1]) + Math.abs(color[2] - rgba[2]);
    if (distance < bestDistance) { bestDistance = distance; best = at; }
  });
  return bestDistance < 90 ? best : null;
}

/** 최소 PNG 해독기(8비트·비인터레이스·RGB/RGBA): 화면 캡처의 한 점 색을 읽는다. 외부 의존을 늘리지 않으려고 둔다. */
function decodePng(buffer) {
  let at = 8; let width = 0; let height = 0; let type = 0; const idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at); const name = buffer.toString("ascii", at + 4, at + 8); const data = buffer.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; }
    if (name === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const bpp = type === 6 ? 4 : 3; const stride = width * bpp; const raw = inflateSync(Buffer.concat(idat)); const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[y * stride + x - bpp] : 0; const up = y > 0 ? out[(y - 1) * stride + x] : 0; const upLeft = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += left; else if (filter === 2) value += up; else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) { const p = left + up - upLeft; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft); value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; }
      out[y * stride + x] = value & 255;
    }
  }
  return { pixel: (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2], 255]; } };
}

/** 그림 모서리 근처 한 점을 화면 캡처로 `count` 번 연달아 읽어 프레임 번호의 줄을 돌려준다(dt: 첫 캡처부터 ms). 실제로 그려진 장면을 읽는다. */
async function sampleFrames(page, locator, count) {
  const box = await locator.boundingBox();
  const started = Date.now(); const samples = [];
  for (let at = 0; at < count; at++) {
    const shot = await page.screenshot({ clip: { x: box.x + 2, y: box.y + 2, width: 8, height: 8 }, animations: "allow", caret: "hide", scale: "css" });
    samples.push({ dt: Date.now() - started, frame: frameIndex(decodePng(shot).pixel(2, 2)) });
  }
  return samples;
}

const rowsOf = (page, seq) => page.evaluate((s) => window.__probe5456.rows[s].slice(), seq);
const markOf = (page, name) => page.evaluate((n) => window.__probe5456.marks.find((entry) => entry.name === n)?.t ?? null, name);
const stamp = (page, name) => page.evaluate((n) => window.__probe5456.mark(n), name);

function summarise(frames, from, to) {
  const window = frames.filter((frame) => frame.t >= from && frame.t <= to && frame.row);
  const nodes = [...new Set(window.map((frame) => frame.node).filter((id) => id !== null))];
  const boxes = window.filter((frame) => frame.box).map((frame) => frame.box);
  const heights = boxes.map((box) => box[1]); const widths = boxes.map((box) => box[0]);
  const lastTops = window.filter((frame) => frame.lastTop !== null).map((frame) => frame.lastTop);
  const blank = window.filter((frame) => !frame.img || frame.complete === false || (frame.nat && frame.nat[0] === 0));
  const kinds = []; for (const frame of window) { const kind = frame.img ? frame.kind : frame.placeholder ? "text" : "none"; if (kinds[kinds.length - 1] !== kind) kinds.push(kind); }
  return {
    frames: window.length,
    imgNodes: nodes.length, nodeIds: nodes,
    blankFrames: blank.length, placeholderFrames: window.filter((frame) => frame.placeholder).length, noImgFrames: window.filter((frame) => !frame.img).length,
    kindSequence: kinds,
    imgHeight: heights.length ? [Math.min(...heights), Math.max(...heights)] : null,
    imgWidth: widths.length ? [Math.min(...widths), Math.max(...widths)] : null,
    lastRowTopTravel: lastTops.length ? Math.round((Math.max(...lastTops) - Math.min(...lastTops)) * 10) / 10 : null,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const launcher = ENGINE === "webkit" ? webkit : chromium;
  const browser = await launcher.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", timezoneId: "Asia/Seoul", locale: "ko-KR" });
    const imageLog = [];
    await installBackend(context, PORT);
    await installExpressions(context, imageLog);
    await context.addInitScript(RECORDER);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`  [pageerror] ${String(error).slice(0, 200)}`));
    await signIn(page, ORIGIN);
    await openGeneral(page);
    note("engine", `${ENGINE} ${browser.version()}`);

    // ---- 1. 처음 그려질 때(마운트): 글자 자리표시가 서는지, 상자 크기가 바뀌는지 ----------------------------------------------
    await page.locator('[data-testid="timeline-message"][data-seq="10"] img').waitFor({ state: "visible", timeout: 15_000 });
    await sleep(1500);
    const mountFrames = await rowsOf(page, 10);
    const firstRow = mountFrames.find((frame) => frame.row)?.t ?? 0;
    note("mount-gif-large", summarise(mountFrames, firstRow, firstRow + 2500));
    note("decode-log", await page.evaluate(() => window.__probe5456.decodes.slice(0, 12)));
    note("mount-gif-large-sequence", mountFrames.filter((frame) => frame.row && frame.t <= firstRow + 2500).reduce((steps, frame) => {
      const step = `${frame.img ? frame.kind : frame.placeholder ? "text" : "none"}${frame.box ? ` ${frame.box[0]}x${frame.box[1]}` : ""}`;
      if (steps[steps.length - 1]?.step !== step) steps.push({ dt: Math.round(frame.t - firstRow), step });
      return steps;
    }, []));

    // ---- 2. 정지 이모티콘(한 장짜리 large): 누르기 · 올리기 · 창 초점 -------------------------------------------------------
    const still = page.locator('[data-testid="timeline-message"][data-seq="11"] [data-expression-name] img');
    await still.waitFor({ state: "visible", timeout: 10_000 });
    await sleep(600);
    await stamp(page, "still-before");
    await still.hover(); await sleep(150);
    await still.click(); await sleep(250);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await sleep(500);
    await stamp(page, "still-after");
    const stillFrames = await rowsOf(page, 11);
    const stillFrom = await markOf(page, "still-before"); const stillTo = await markOf(page, "still-after");
    note("static-press", summarise(stillFrames, stillFrom, stillTo));

    // ---- 3. GIF: 4회 재생이 끝나 멈출 때까지 기다린 뒤 누른다 -----------------------------------------------------------------
    const replayButton = page.locator('[data-testid="timeline-message"][data-seq="10"] button[aria-label$="다시 재생"]');
    await replayButton.waitFor({ state: "visible", timeout: 20_000 });
    await sleep(500);
    const stoppedFrames = await rowsOf(page, 10);
    note("stopped-state", summarise(stoppedFrames.slice(-30), 0, Infinity));
    await page.screenshot({ path: join(OUT, `web-${LABEL}-${ENGINE}-2-stopped.png`), clip: { x: 300, y: 0, width: 980, height: 900 }, animations: "allow", caret: "hide" });
    const requestsBefore = imageLog.length;
    await stamp(page, "press");
    await replayButton.click();
    // 눌린 직후 연달아 캡처해 실제로 그려진 프레임 번호를 읽는다(캔버스 drawImage 는 움직이는 <img> 에서 늘 첫 장면을 돌려주므로 증거가 못 된다).
    note("gif-press-restart-frames", await sampleFrames(page, page.locator('[data-testid="timeline-message"][data-seq="10"] [data-expression-name] img'), 8));
    await sleep(1000);
    await stamp(page, "after-press");
    const pressFrom = await markOf(page, "press"); const pressTo = await markOf(page, "after-press");
    const pressFrames = await rowsOf(page, 10);
    note("gif-press-1_5s", summarise(pressFrames, pressFrom, pressTo));
    note("gif-press-first-frames", pressFrames.filter((frame) => frame.t >= pressFrom).slice(0, 12).map((frame) => ({ dt: Math.round(frame.t - pressFrom), img: frame.img, kind: frame.kind, placeholder: frame.placeholder, node: frame.node, box: frame.box })));
    note("gif-press-image-requests", imageLog.slice(requestsBefore).map((entry) => `${entry.name}:${entry.size}`));
    note("gif-all-image-requests", imageLog.map((entry) => `${entry.name}:${entry.size}`));
    await page.screenshot({ path: join(OUT, `web-${LABEL}-${ENGINE}-3-after-press.png`), clip: { x: 300, y: 0, width: 980, height: 900 }, animations: "allow", caret: "hide" });

    // ---- 4. 두 번째 누르기: 다시 멈출 때까지 기다린 뒤 한 번 더 -------------------------------------------------------------------
    await replayButton.waitFor({ state: "visible", timeout: 20_000 });
    await sleep(300);
    const requestsBefore2 = imageLog.length;
    await stamp(page, "press2");
    await replayButton.click();
    await sleep(1500);
    await stamp(page, "after-press2");
    const press2Frames = await rowsOf(page, 10);
    note("gif-press2-1_5s", summarise(press2Frames, await markOf(page, "press2"), await markOf(page, "after-press2")));
    note("gif-press2-image-requests", imageLog.slice(requestsBefore2).map((entry) => `${entry.name}:${entry.size}`));
    writeFileSync(join(OUT, `web-${LABEL}-${ENGINE}-measure.json`), JSON.stringify(results, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
