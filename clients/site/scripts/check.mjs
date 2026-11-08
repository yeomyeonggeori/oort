#!/usr/bin/env node
// =============================================================================
// 내려받기 페이지 확인 (#5562): 빌드 결과를 띄운 주소에서 숫자로 잰다. 번들 Chromium 헤드리스만 쓴다.
//
//   python3 clients/site/build.py
//   (cd clients/site/dist && python3 -m http.server 21410 --bind 127.0.0.1)
//   SITE_URL=http://127.0.0.1:21410 SHOTS_DIR=<dir> node clients/site/scripts/check.mjs
//
// 재는 것: 7개 언어 × 390·1280 × 밝게·어둡게의 가로 넘침·깨진 그림·콘솔 오류, 글자 뒤 바탕 대비,
// 움직임 줄이기(두 장면이 같다)·WebGL 끔(대체 바탕)·화면 밖·숨긴 탭(멈춤), 칩 고르기(키보드),
// 언어 첫 방문·기억. 하나라도 어긋나면 exit 1.
// =============================================================================

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(SITE, "../web/package.json"));
const { chromium } = require("playwright");

const BASE = (process.env.SITE_URL || "http://127.0.0.1:21410").replace(/\/$/, "");
const SHOTS = process.env.SHOTS_DIR ? resolve(process.env.SHOTS_DIR) : "";
const LANGS = ["ko", "en", "ja", "zh-Hans", "zh-Hant", "es", "fr"];
const SHOT_LANGS = new Set(["ko", "en", "ja", "fr"]);
const values = JSON.parse(readFileSync(resolve(SITE, "values.json"), "utf8"));
// ONLY=pages,motion,webgl,chip,lang,weight 로 일부만 잰다(사보타주 확인용). 기본은 전부.
const ONLY = new Set((process.env.ONLY || "pages,motion,webgl,chip,lang,weight").split(",").map((s) => s.trim()));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

function watch(page) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => errors.push(`failed ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  return errors;
}

async function settle(page) {
  await page.waitForFunction(() => document.querySelector(".hero")?.getAttribute("data-webgl") !== "pending");
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null)))));
}

/** 한 화면의 숫자: 가로 넘침, 깨진 그림, 버튼이 화면 안에 있는가. */
async function measure(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5) && getComputedStyle(el).position !== "fixed" && !el.closest(".sprite, .menu, .hero");
    }).map((el) => el.className || el.tagName);
    return {
      overflow: document.documentElement.scrollWidth - vw,
      outside: out.slice(0, 5),
      broken: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
      shot: document.querySelector(".frame img")?.currentSrc.split("/").pop(),
      getRight: Math.round(document.querySelector(".get")?.getBoundingClientRect().right ?? 0),
      vw,
    };
  });
}

/** 글자 뒤 바탕의 대비: 글자를 투명하게 한 장면을 찍어 상자 안 화소의 밝기를 잰다. */
async function heroContrast(page, decoder) {
  const boxes = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".hero h1 span, .hero .lead, .hero .spec, .hero .spec-link")];
    const list = els.map((el) => {
      const r = el.getBoundingClientRect();
      const color = getComputedStyle(el).color;
      return { name: el.className || el.tagName.toLowerCase(), x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height, color };
    });
    document.documentElement.classList.add("probe-hide");
    const st = document.createElement("style");
    st.id = "probe-style";
    st.textContent = ".probe-hide .hero h1, .probe-hide .hero .lead, .probe-hide .hero .spec, .probe-hide .hero .spec-link { color: transparent !important; }";
    document.head.appendChild(st);
    return list;
  });
  await page.waitForTimeout(80);
  const results = [];
  for (const b of boxes) {
    const png = await page.screenshot({ clip: { x: Math.max(0, b.x), y: b.y, width: Math.max(1, b.w), height: Math.max(1, b.h) } });
    const lum = await decoder.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const L = [];
      for (let i = 0; i < d.length; i += 4) L.push(0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
      L.sort((a, z) => a - z);
      const at = (q) => L[Math.min(L.length - 1, Math.floor(q * L.length))];
      return { p02: at(0.02), p50: at(0.5), p98: at(0.98) };
    }, png.toString("base64"));
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(b.color);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const fg = 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
    const ratio = (a, z) => (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05);
    // 가장 나쁜 쪽: 밝은 글자면 가장 밝은 바탕 화소(98분위), 어두운 글자면 가장 어두운 바탕 화소(2분위)
    const worstBg = fg > lum.p50 ? lum.p98 : lum.p02;
    results.push({ name: b.name, median: ratio(fg, lum.p50), worst: ratio(fg, worstBg) });
  }
  await page.evaluate(() => { document.documentElement.classList.remove("probe-hide"); document.getElementById("probe-style")?.remove(); });
  return results;
}

async function canvasShot(page) {
  return page.locator("canvas.sky").screenshot();
}

async function main() {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const decoderCtx = await browser.newContext();
  const decoder = await decoderCtx.newPage();
  const summary = { pages: 0, overflow: 0, broken: 0, errors: 0, contrastWorst: Infinity, contrastMedianMin: Infinity };

  // 1) 7개 언어 × 390·1280 × 밝게·어둡게
  if (ONLY.has("pages")) for (const lang of LANGS) {
    for (const width of [390, 1280]) {
      for (const scheme of ["light", "dark"]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: width === 390 ? 2 : 1, locale: "en-US" });
        const page = await ctx.newPage();
        const errors = watch(page);
        await page.goto(`${BASE}/${lang}/`, { waitUntil: "load" });
        await settle(page);
        const m = await measure(page);
        const contrast = await heroContrast(page, decoder);
        const worst = Math.min(...contrast.map((c) => c.worst));
        const median = Math.min(...contrast.map((c) => c.median));
        summary.pages += 1;
        summary.overflow += m.overflow > 0 ? 1 : 0;
        summary.broken += m.broken.length;
        summary.errors += errors.length;
        summary.contrastWorst = Math.min(summary.contrastWorst, worst);
        summary.contrastMedianMin = Math.min(summary.contrastMedianMin, median);
        const wantShot = lang === "ko" ? "app-ko" : "app-en";
        const tag = `${lang}-${width}-${scheme}`;
        check(`${tag} 넘침·그림·오류·대비`,
          m.overflow <= 0 && m.outside.length === 0 && m.broken.length === 0 && errors.length === 0 && m.getRight <= m.vw && m.shot?.startsWith(`${wantShot}-${scheme}`) && median >= 4.5,
          `overflow=${m.overflow} outside=${m.outside.length} broken=${m.broken.length} errors=${errors.length} shot=${m.shot} contrast(median min)=${median.toFixed(2)} worst-pixel=${worst.toFixed(2)}${errors.length ? " " + errors.slice(0, 2).join(" | ") : ""}${m.outside.length ? " " + m.outside.join(",") : ""}`);
        if (SHOTS && SHOT_LANGS.has(lang)) await page.screenshot({ path: resolve(SHOTS, `${tag}.png`), fullPage: true });
        await ctx.close();
      }
    }
  }

  // 2) 움직임 줄이기: 두 장면이 같고 멈춰 있다. 줄이지 않으면 두 장면이 다르다(사보타주 방향).
  if (ONLY.has("motion")) for (const reduce of [true, false]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: reduce ? "reduce" : "no-preference" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ko/`, { waitUntil: "load" });
    await settle(page);
    await page.waitForTimeout(300);
    const a = await canvasShot(page);
    await page.waitForTimeout(1500);
    const b = await canvasShot(page);
    const running = await page.locator(".hero").getAttribute("data-running");
    const same = Buffer.compare(a, b) === 0;
    if (reduce) check("움직임 줄이기: 1.5초 사이 두 장면이 같고 멈춤", same && running === "0", `same=${same} running=${running}`);
    else check("움직임 그대로: 1.5초 사이 두 장면이 다르고 도는 중", !same && running === "1", `same=${same} running=${running}`);
    if (!reduce) {
      // 화면 밖이면 멈춘다
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(400);
      const offscreen = await page.locator(".hero").getAttribute("data-running");
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);
      const back = await page.locator(".hero").getAttribute("data-running");
      check("화면 밖이면 멈추고 돌아오면 다시 돈다", offscreen === "0" && back === "1", `offscreen=${offscreen} back=${back}`);
      // 숨긴 탭이면 멈춘다
      const hidden = await page.evaluate(async () => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((r) => setTimeout(r, 100));
        const h = document.querySelector(".hero").getAttribute("data-running");
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((r) => setTimeout(r, 100));
        return [h, document.querySelector(".hero").getAttribute("data-running")];
      });
      check("숨긴 탭이면 멈추고 다시 보이면 돈다", hidden[0] === "0" && hidden[1] === "1", `hidden=${hidden[0]} shown=${hidden[1]}`);
      const size = await page.evaluate(() => {
        const c = document.querySelector("canvas.sky");
        const r = c.getBoundingClientRect();
        return { w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height), dpr: devicePixelRatio };
      });
      check("캔버스 해상도가 DPR 1.5 상한 안", size.w <= Math.ceil(size.cssW * 1.5) && size.h <= Math.ceil(size.cssH * 1.5), JSON.stringify(size));
    }
    await ctx.close();
  }

  // 3) WebGL 끔: 대체 바탕이 보인다
  if (ONLY.has("webgl")) {
    const noGl = await chromium.launch({ args: ["--disable-webgl", "--disable-3d-apis"] });
    for (const scheme of ["light", "dark"]) {
      const ctx = await noGl.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors = watch(page);
      await page.goto(`${BASE}/en/`, { waitUntil: "load" });
      await settle(page);
      const st = await page.evaluate(() => {
        const hero = document.querySelector(".hero");
        return { webgl: hero.getAttribute("data-webgl"), canvas: getComputedStyle(document.querySelector("canvas.sky")).display, bg: getComputedStyle(hero).backgroundImage.includes("gradient") };
      });
      const contrast = await heroContrast(page, decoder);
      const median = Math.min(...contrast.map((c) => c.median));
      check(`WebGL 끔(${scheme}): 대체 바탕`, st.webgl === "off" && st.canvas === "none" && st.bg && errors.length === 0 && median >= 4.5, `${JSON.stringify(st)} errors=${errors.length} contrast=${median.toFixed(2)}`);
      if (SHOTS) await page.screenshot({ path: resolve(SHOTS, `nowebgl-en-1280-${scheme}.png`) });
      await ctx.close();
    }
    await noGl.close();
  }

  // 4) 칩 고르기: 기본 Apple Silicon, 키보드로 Intel, Escape, x86 자동 선택
  if (ONLY.has("chip")) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // 칩을 모르는 브라우저(Safari·Firefox, 또는 값을 거절하는 Chromium): 규칙은 「모르면 Apple Silicon」이다.
    // 이 Mac 의 실제 칩을 읽지 않게 거절로 고정한다(Intel 호스트에서도 같은 답).
    await ctx.addInitScript(() => {
      const fake = { brands: [], mobile: false, platform: "macOS", getHighEntropyValues: () => Promise.reject(new Error("unknown")) };
      Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => fake });
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ko/`, { waitUntil: "load" });
    await settle(page);
    await page.waitForTimeout(100);
    const href = () => page.locator("#get-mac").getAttribute("href");
    const label = () => page.locator("[data-chip-label]").textContent();
    check("칩을 모르면 Apple Silicon", (await href()) === values.DMG_ARM_URL && (await label()) === "Apple Silicon");
    await page.locator("#get-mac").focus();
    await page.keyboard.press("Tab");
    const onMore = await page.evaluate(() => document.activeElement?.classList.contains("get-more") && document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).outlineStyle !== "none");
    await page.keyboard.press("Enter");
    const opened = await page.evaluate(() => ({ hidden: document.getElementById("chip-menu").hidden, focused: document.activeElement?.getAttribute("data-chip"), expanded: document.querySelector(".get-more").getAttribute("aria-expanded") }));
    await page.keyboard.press("ArrowDown");
    const onIntel = await page.evaluate(() => ({ chip: document.activeElement?.getAttribute("data-chip"), ring: getComputedStyle(document.activeElement).outlineStyle !== "none" && document.activeElement.matches(":focus-visible") }));
    if (SHOTS) await page.screenshot({ path: resolve(SHOTS, "chip-menu-ko-1280-light.png"), clip: { x: 340, y: 300, width: 600, height: 420 } });
    await page.keyboard.press("Enter");
    const after = await page.evaluate(() => ({ hidden: document.getElementById("chip-menu").hidden, focus: document.activeElement?.id, checked: document.querySelector('.chip-menu [data-chip="x64"]').getAttribute("aria-checked") }));
    check("칩 펼침 단추에 포커스 고리", onMore === true);
    check("Enter 로 펼치면 고른 칩에 포커스", opened.hidden === false && opened.focused === "arm" && opened.expanded === "true", JSON.stringify(opened));
    check("화살표로 Intel 로 옮기고 포커스 고리가 보인다", onIntel.chip === "x64" && onIntel.ring === true, JSON.stringify(onIntel));
    check("Enter 로 Intel 을 고르면 주 버튼이 Intel 파일을 가리킨다", after.hidden && after.focus === "get-mac" && after.checked === "true" && (await href()) === values.DMG_X64_URL && (await label()) === "Intel", JSON.stringify(after));
    await page.locator(".get-more").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    const esc = await page.evaluate(() => ({ hidden: document.getElementById("chip-menu").hidden, focus: document.activeElement?.className }));
    check("Escape 로 닫고 펼침 단추로 돌아온다", esc.hidden && esc.focus === "get-more", JSON.stringify(esc));
    await ctx.close();

    // 폰 폭: 펼친 칩 메뉴가 앱 화면 틀에 가리지 않는다(가운데 점을 누르면 그 항목이 맞는다)
    const narrow = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const np = await narrow.newPage();
    await np.goto(`${BASE}/fr/`, { waitUntil: "load" });
    await settle(np);
    await np.locator(".get-more").click();
    const hit = await np.evaluate(() => {
      const menu = document.getElementById("chip-menu");
      const m = menu.getBoundingClientRect();
      const f = document.querySelector(".frame").getBoundingClientRect();
      // 메뉴 상자의 네 귀퉁이 안쪽과 항목 가운데가 모두 메뉴 자신이어야 한다(앱 화면 틀이 덮으면 아니다)
      const pts = [[m.left + 6, m.top + 6], [m.right - 6, m.top + 6], [m.left + 6, m.bottom - 3], [m.right - 6, m.bottom - 3]];
      for (const el of menu.querySelectorAll("[role=menuitemradio]")) {
        const r = el.getBoundingClientRect();
        pts.push([r.left + r.width / 2, r.top + r.height / 2]);
      }
      const visible = pts.every(([x, y]) => menu.contains(document.elementFromPoint(x, y)));
      return { visible, apart: m.bottom <= f.top || m.top >= f.bottom, up: menu.classList.contains("up") };
    });
    if (SHOTS) await np.screenshot({ path: resolve(SHOTS, "chip-menu-fr-390-light.png") });
    check("390 폭에서 펼친 칩 메뉴가 앱 화면 틀에 가려지지 않는다", hit.visible && hit.apart, JSON.stringify(hit));
    await narrow.close();

    const x86 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await x86.addInitScript(() => {
      const fake = { brands: [], mobile: false, platform: "macOS", getHighEntropyValues: () => Promise.resolve({ architecture: "x86" }) };
      Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => fake });
    });
    const p2 = await x86.newPage();
    await p2.goto(`${BASE}/en/`, { waitUntil: "load" });
    await settle(p2);
    await p2.waitForTimeout(100);
    check("Chromium 이 x86 이라고 하면 Intel 이 기본", (await p2.locator("#get-mac").getAttribute("href")) === values.DMG_X64_URL && (await p2.locator("[data-chip-label]").textContent()) === "Intel");
    await x86.close();
  }

  // 5) 언어: 첫 방문은 브라우저 언어, 고르면 기억, 저장소가 막혀도 페이지는 정상
  if (ONLY.has("lang")) {
    const cases = [["ja-JP", "/ja/"], ["zh-TW", "/zh-Hant/"], ["zh-CN", "/zh-Hans/"], ["ko-KR", "/ko/"], ["de-DE", "/"], ["es-MX", "/es/"]];
    for (const [locale, want] of cases) {
      const ctx = await browser.newContext({ locale });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      await page.waitForLoadState("load");
      check(`첫 방문 ${locale} -> ${want}`, new URL(page.url()).pathname === want, page.url());
      await ctx.close();
    }
    const ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.locator(".lang-btn").click();
    await page.locator('.lang-list a[data-lang="fr"]').click();
    await page.waitForURL(/\/fr\/$/);
    const stored = await page.evaluate(() => localStorage.getItem("oort.site.lang"));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForURL(/\/fr\/$/);
    const lang = await page.evaluate(() => document.documentElement.lang);
    check("언어 메뉴로 fr 을 고르면 /fr/ 로 가고, 다시 / 에 와도 fr", stored === "fr" && lang === "fr", `stored=${stored} lang=${lang}`);
    await ctx.close();

    const blocked = await browser.newContext({ locale: "ko-KR" });
    await blocked.addInitScript(() => {
      const no = () => { throw new DOMException("blocked", "SecurityError"); };
      Storage.prototype.getItem = no;
      Storage.prototype.setItem = no;
    });
    const bp = await blocked.newPage();
    const errors = watch(bp);
    await bp.goto(`${BASE}/`, { waitUntil: "load" });
    await bp.waitForURL(/\/ko\/$/);
    await settle(bp);
    await bp.locator(".lang-btn").click();
    await bp.locator('.lang-list a[data-lang="en"]').click();
    await bp.waitForURL(/\/en\/$/);
    check("저장소가 막혀도 첫 방문·언어 이동이 된다", errors.length === 0, `errors=${errors.length} ${errors.join(" | ")}`);
    await blocked.close();
  }

  // 6) 무게
  if (ONLY.has("weight")) {
    const dist = resolve(SITE, "dist");
    const html = LANGS.map((l) => statSync(resolve(dist, l, "index.html")).size);
    const img = (n) => statSync(resolve(dist, "assets", n)).size;
    const perPage = img("app-ko-light.webp") + img("app-icon-96.png");
    const all = ["app-ko-light.webp", "app-ko-dark.webp", "app-en-light.webp", "app-en-dark.webp", "app-icon-96.png", "favicon.svg", "favicon-32.png", "apple-touch-icon.png"].reduce((s, n) => s + img(n), 0);
    console.log(`무게: 페이지 HTML(글꼴·CSS·스크립트 포함) ${Math.min(...html)}~${Math.max(...html)} B · 한 페이지가 받는 그림 약 ${perPage} B · 그림 전체 ${all} B`);
  }

  console.log(`요약: 페이지 ${summary.pages} · 넘침 ${summary.overflow} · 깨진 그림 ${summary.broken} · 콘솔 오류 ${summary.errors} · 글자 대비 중앙값 최소 ${summary.contrastMedianMin.toFixed(2)} · 화소 최악 ${summary.contrastWorst.toFixed(2)}`);
  await browser.close();
  if (failed) {
    console.log(`FAIL ${failed}`);
    process.exit(1);
  }
  console.log("all ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
