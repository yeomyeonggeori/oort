// GATE 3 — 1k-message timeline scroll profile (react-virtuoso) + web cold start.
// Runs headless Chromium (a headless page reports visibilityState "visible", so
// rAF and react-virtuoso's ResizeObserver run at full rate — unlike a
// backgrounded automation tab). Requires the preview server on
// http://127.0.0.1:5173 and MOMO_EMAIL/MOMO_PASSWORD in the env.
import { chromium } from "playwright";

const BASE = process.env.MOMO_WEB_BASE || "http://127.0.0.1:5173";
const email = process.env.MOMO_EMAIL;
const password = process.env.MOMO_PASSWORD;
if (!email || !password) {
  console.error("MOMO_EMAIL and MOMO_PASSWORD required.");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// ---- cold start: fresh navigation timing to first rendered row -------------
const navStart = Date.now();
await page.goto(`${BASE}/?stress=1000`, { waitUntil: "domcontentloaded" });
await page.fill('[data-testid="login-email"]', email);
await page.fill('[data-testid="login-password"]', password);
await page.click('[data-testid="login-submit"]');
await page.waitForFunction(() => window.__spike?.count === 1000, null, {
  timeout: 15000,
});
await page.waitForSelector('[data-testid="timeline-message"]', {
  timeout: 15000,
});
const timeToFirstRowMs = Date.now() - navStart;

const paint = await page.evaluate(() => {
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  return {
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
    loadEventMs: Math.round(nav.loadEventEnd || 0),
    firstContentfulPaintMs: fcp ? Math.round(fcp.startTime) : null,
  };
});

// ---- scroll profile: continuous rAF-timed scroll top→bottom ----------------
const scroll = await page.evaluate(async () => {
  const scroller = document.querySelector('[data-testid="timeline-virtuoso"]');
  const rowSel = '[data-testid="timeline-message"]';
  // let virtuoso measure item sizes so total height reflects 1000 rows
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise((r) => setTimeout(r, 150));
  scroller.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 150));

  const totalScroll = () => scroller.scrollHeight - scroller.clientHeight;
  const frames = [];
  let maxRows = 0;
  const durationMs = 3000;

  await new Promise((resolve) => {
    let last = performance.now();
    const start = last;
    function step(now) {
      frames.push(now - last);
      last = now;
      const n = document.querySelectorAll(rowSel).length;
      if (n > maxRows) maxRows = n;
      const t = (now - start) / durationMs;
      scroller.scrollTop = totalScroll() * Math.min(1, t);
      if (now - start < durationMs) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });

  frames.shift(); // warmup frame
  const sorted = frames.slice().sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const rows = [...document.querySelectorAll(rowSel)].map((r) =>
    Number(r.getAttribute("data-seq"))
  );
  const mem = performance.memory
    ? Math.round(performance.memory.usedJSHeapSize / 1048576)
    : null;
  return {
    loaded: window.__spike?.count,
    scrollHeightPx: Math.round(scroller.scrollHeight),
    maxDomRowsDuringScroll: maxRows,
    bottomWindow: [rows[0], rows[rows.length - 1]],
    frames: frames.length,
    avgFrameMs: +avg.toFixed(2),
    fps: +(1000 / avg).toFixed(1),
    p50FrameMs: +pct(0.5).toFixed(2),
    p95FrameMs: +pct(0.95).toFixed(2),
    p99FrameMs: +pct(0.99).toFixed(2),
    maxFrameMs: +Math.max(...frames).toFixed(2),
    framesOver16_7ms: frames.filter((f) => f > 16.7).length,
    framesOver33ms: frames.filter((f) => f > 33).length,
    usedJSHeapMB: mem,
  };
});

console.log(
  JSON.stringify(
    {
      gate: "1k-scroll+coldstart",
      coldStart: { timeToFirstRowMs, ...paint },
      scroll,
    },
    null,
    2
  )
);
await browser.close();
const smooth = scroll.fps >= 55 && scroll.framesOver33ms <= 2;
process.exit(smooth ? 0 : 1);
