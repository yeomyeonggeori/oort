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
// 언어 첫 방문·기억, 좁은 폭(주 버튼에 칩·터치 44·TestFlight 표지·분할 버튼 포커스·메뉴 포커스 빠짐·첫 화면에 「다른 기기」 없음·
// 웹 링크 아이콘의 툴팁과 언어 아이콘과 같은 모양·꼬리 언어 링크 왼쪽 끝과 간격), 제목 반쪽·리드 줄 수 기록(7개 언어 × 390·1280,
// 문구를 바꿀 때 줄바꿈을 보는 줄: ONLY=pages),
// 폰 흉내(첫 화면 주 행동이 웹, Mac 내려받기는 기기 목록, JS 없으면 Mac), WebKit 일본어 줄바꿈(조사 앞에서 안 끊김),
// 머리 줄(7개 언어 × 320·360·375·390·568·600 × 일반·폰 흉내: 로고 한 줄·마크 크기·컨트롤 화면 안·넘침 0·아이콘 44·폰 링크 하나),
// 머리 로고 배색(링은 글자색, 위성은 tokens.css 의 --signal: 메뉴 막대 oort-tray-unread-on-* 와 같은 값),
// 첫 화면 문구(#5568 문구 1안, 7개 언어 × 320·360·390·768·1280: 머리글·증거 칩 3이 사전 그대로·칩이 화면 밖으로 안 나감·
// 제목·머리글·칩 낱말 가운데 끊김 0·줄 머리 문장 부호 0·문서 넘침 0, 제목·리드·칩 줄 수 기록, 탭 제목 「oort」, meta description 150자 이하).
// 하나라도 어긋나면 exit 1.
// =============================================================================

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(SITE, "../web/package.json"));
const { chromium, webkit, devices } = require("playwright");

const BASE = (process.env.SITE_URL || "http://127.0.0.1:21410").replace(/\/$/, "");
const SHOTS = process.env.SHOTS_DIR ? resolve(process.env.SHOTS_DIR) : "";
const LANGS = ["ko", "en", "ja", "zh-Hans", "zh-Hant", "es", "fr"];
const SHOT_LANGS = new Set((process.env.SHOT_LANGS || "ko,en,ja,fr").split(",").map((s) => s.trim()));
const values = JSON.parse(readFileSync(resolve(SITE, "values.json"), "utf8"));
const cats = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(resolve(SITE, `i18n/${l}.json`), "utf8"))]));
const ko = cats.ko;
// ONLY=pages,copy,motion,webgl,chip,lang,narrow,phone,webkit,header,logo,weight 로 일부만 잰다(사보타주 확인용). 기본은 전부.
const ONLY = new Set((process.env.ONLY || "pages,copy,motion,webgl,chip,lang,narrow,phone,webkit,header,logo,weight").split(",").map((s) => s.trim()));

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
      // 제목 반쪽(블록 span)마다 줄 수: 높이 ÷ 줄 높이. 리드 줄 수는 기록용
      titleLines: [...document.querySelectorAll(".hero h1 span")].map((s) => Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight))),
      leadLines: (() => { const l = document.querySelector(".hero .lead"); return Math.round(l.getBoundingClientRect().height / parseFloat(getComputedStyle(l).lineHeight)); })(),
      vw,
    };
  });
}

/** 글자 뒤 바탕의 대비: 글자를 투명하게 한 장면을 찍어 상자 안 화소의 밝기를 잰다. */
async function heroContrast(page, decoder) {
  const boxes = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".hero .eyebrow, .hero h1 span, .hero .lead, .hero .proof li, .hero .spec, .hero .phone-note span")]
      .filter((el) => el.getBoundingClientRect().width > 0);
    const list = els.map((el) => {
      const r = el.getBoundingClientRect();
      const color = getComputedStyle(el).color;
      return { name: el.className || el.tagName.toLowerCase(), x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height, color };
    });
    document.documentElement.classList.add("probe-hide");
    const st = document.createElement("style");
    st.id = "probe-style";
    // 칩(li)은 글자색을 직접 가지므로 ul 이 아니라 li 를 가린다
    st.textContent = ".probe-hide .hero .eyebrow, .probe-hide .hero h1, .probe-hide .hero .lead, .probe-hide .hero .proof li, .probe-hide .hero .spec, .probe-hide .hero .phone-note { color: transparent !important; }";
    document.head.appendChild(st);
    return list;
  });
  await page.waitForTimeout(80);
  const results = [];
  for (const b of boxes) {
    // 첫 화면 아래로 내려간 글자(폰 흉내 664 높이의 안내 줄 등)는 그만큼 즉시 스크롤해 화면 안에서 찍는다
    const dy = Math.max(0, Math.ceil(b.y + b.h - page.viewportSize().height + 8));
    if (dy) {
      await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: "instant" }), dy);
      await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 1, dy);
      await page.waitForTimeout(80);
    }
    const png = await page.screenshot({ clip: { x: Math.max(0, b.x), y: b.y - dy, width: Math.max(1, b.w), height: Math.max(1, b.h) } });
    if (dy) await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
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

/** 머리 줄의 숫자. W 는 정해 둔 뷰포트 폭(폰 흉내가 레이아웃 폭을 넓혀도 속지 않게 이 값과 견준다).
 *  로고 글자는 플렉스 항목이라 getClientRects 가 줄 수를 못 센다 → 높이 ÷ 줄 높이로 센다. */
const headMeasure = (W) => {
  const r = (el) => el.getBoundingClientRect();
  const vis = (el) => el && r(el).width > 0 && r(el).height > 0;
  const span = document.querySelector(".brand span");
  const brand = r(document.querySelector(".brand"));
  const mark = r(document.querySelector(".brand .mark"));
  const nav = r(document.querySelector(".top-nav"));
  const ctls = [...document.querySelectorAll(".top-nav .lang-btn, .top-nav .web-link")].filter(vis).map((el) => {
    const b = r(el);
    return { cls: el.classList.contains("web-link") ? "web" : "lang", left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, w: Math.round(b.width), h: Math.round(b.height) };
  });
  const webUrl = document.querySelector(".web-link").getAttribute("href");
  const wrapped = nav.top >= brand.bottom - 1;
  return {
    phone: document.documentElement.hasAttribute("data-phone"),
    lines: Math.round(r(span).height / parseFloat(getComputedStyle(span).lineHeight)),
    mark: `${Math.round(mark.width * 10) / 10}x${Math.round(mark.height * 10) / 10}`,
    ctls,
    navRight: Math.round(nav.right * 10) / 10,
    wrapped,
    overlap: !wrapped && ctls.some((c) => c.left < brand.right - 0.5),
    overflow: document.documentElement.scrollWidth - W,
    webLinks: [...document.querySelectorAll(`a[href="${webUrl}"]`)].filter((a) => vis(a) && r(a).top < innerHeight).length,
  };
};

/** 첫 화면 문구의 숫자(#5568 문구 1안). W 는 정해 둔 뷰포트 폭.
 *  글자마다 Range 로 줄을 세고, 줄이 바뀐 자리의 앞뒤 글자를 본다: 둘 다 글자·숫자이고 같은 글자 마디(<wbr> 로 갈리지 않음)면
 *  낱말 가운데 끊김이다. 중국어는 글자 사이 줄바꿈이 관례라 구절 힌트(<wbr>)가 없는 요소는 로마자·숫자 낱말 안만 보고,
 *  힌트가 있는 요소(제목)는 일본어처럼 힌트 밖 끊김을 본다. 줄 안 바꾸는 빈칸(U+00A0)·단어 결합 문자(U+2060) 앞뒤에서 바뀌어도 끊김이다.
 *  줄 머리에 가운뎃점·쉼표·닫는 부호가 오면 기록한다.
 *  .hero 는 overflow: hidden 이라 안에서 화면 밖으로 나간 글자·칩은 문서 넘침으로 안 잡힌다 → 글자 상자·칩·칩 줄을 폭과 직접 견준다. */
const copyMeasure = (W) => {
  const zh = document.documentElement.lang.startsWith("zh");
  const WORD = /[\p{L}\p{N}’']/u;
  const LATIN = /[A-Za-z0-9’']/;
  const JOIN = String.fromCharCode(0xa0, 0x2060);
  const START = "·・,.;:!?、。，．；：！？)]}）」』’”%";
  const read = (el) => {
    const hinted = el.querySelector("wbr") !== null;
    const chars = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode(), node += 1) {
      for (let i = 0; i < n.data.length; i += 1) {
        const rg = document.createRange();
        rg.setStart(n, i);
        rg.setEnd(n, i + 1);
        const r = [...rg.getClientRects()].find((x) => x.width > 0);
        chars.push({ ch: n.data[i], node, top: r ? r.top : null });
      }
    }
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    let line = 0;
    let top = null;
    for (const c of chars) {
      if (c.top !== null) {
        if (top !== null && c.top > top + lh / 2) { line += 1; top = c.top; }
        if (top === null) top = c.top;
      }
      c.line = line;
    }
    const text = [];
    for (const c of chars) text[c.line] = (text[c.line] || "") + c.ch;
    const mid = [];
    for (let j = 1; j < chars.length; j += 1) {
      const a = chars[j - 1];
      const b = chars[j];
      if (b.line === a.line || b.top === null) continue;
      const inWord = zh && !hinted ? LATIN.test(a.ch) && LATIN.test(b.ch) : WORD.test(a.ch) && WORD.test(b.ch) && a.node === b.node;
      if (inWord || JOIN.includes(a.ch) || JOIN.includes(b.ch)) mid.push(`${text[a.line].slice(-4)}|${text[b.line].slice(0, 4)}`);
    }
    const head = text.slice(1).map((t) => (t || "").trimStart()).filter((t) => START.includes(t[0])).map((t) => t.slice(0, 5));
    return { lines: line + 1, mid, head };
  };
  const box = (el) => el.getBoundingClientRect();
  const seen = (el) => Boolean(el) && box(el).width > 0 && box(el).height > 0;
  const inside = (el) => box(el).left >= -0.5 && box(el).right <= W + 0.5;
  const eyebrow = document.querySelector(".hero .eyebrow");
  const h1 = document.querySelector(".hero h1");
  const spans = [...document.querySelectorAll(".hero h1 span")];
  const lead = document.querySelector(".hero .lead");
  const proof = document.querySelector(".hero .proof");
  const chips = proof ? [...proof.querySelectorAll("li")] : [];
  const cta = [document.querySelector(".hero .get"), document.querySelector(".hero .get-web")].find(seen);
  const title = spans.map(read);
  const eb = seen(eyebrow) ? read(eyebrow) : { lines: 0, mid: [], head: [] };
  const ld = read(lead);
  const cp = chips.map(read);
  // 글자 상자(Range)가 화면 밖으로 나간 요소: 끊을 자리가 없어 한 줄로 굳은 제목 등
  const inkOut = [eyebrow, ...spans, lead, ...chips].filter(seen).filter((el) => {
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const r = rg.getBoundingClientRect();
    return r.left < -0.5 || r.right > W + 0.5;
  }).map((el) => el.textContent.slice(0, 12));
  return {
    overflow: document.documentElement.scrollWidth - W,
    inkOut,
    eyebrow: seen(eyebrow) ? eyebrow.textContent : null,
    chips: chips.filter(seen).map((c) => c.textContent),
    // 자리: 머리글 → 제목 → 리드 → 칩 → 주 행동
    order: seen(eyebrow) && seen(proof) && Boolean(cta) && box(eyebrow).bottom <= box(h1).top && box(lead).bottom <= box(proof).top && box(proof).bottom <= box(cta).top,
    chipOut: chips.filter((c) => !inside(c) || c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent.slice(0, 12)),
    rowOut: !proof || !inside(proof) || proof.scrollWidth > proof.clientWidth + 1,
    titleLines: title.map((t) => t.lines).join("+"),
    leadLines: ld.lines,
    chipLines: cp.map((c) => c.lines).join("+"),
    chipRows: new Set(chips.map((c) => Math.round(box(c).top))).size,
    mid: [...title.flatMap((t) => t.mid), ...eb.mid, ...cp.flatMap((c) => c.mid)],
    head: [...eb.head, ...title.flatMap((t) => t.head), ...ld.head, ...cp.flatMap((c) => c.head)],
  };
};

async function canvasShot(page) {
  return page.locator("canvas.sky").screenshot();
}

async function main() {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const decoderCtx = await browser.newContext();
  const decoder = await decoderCtx.newPage();
  const summary = { pages: 0, overflow: 0, broken: 0, errors: 0, contrastWorst: Infinity, contrastMedianMin: Infinity };
  const titleLines = {};
  const leadLines = {};

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
        titleLines[`${lang}-${width}`] = m.titleLines.join("+");
        leadLines[`${lang}-${width}`] = m.leadLines;
        check(`${tag} 넘침·그림·오류·대비`,
          m.overflow <= 0 && m.outside.length === 0 && m.broken.length === 0 && errors.length === 0 && m.getRight <= m.vw && m.shot?.startsWith(`${wantShot}-${scheme}`) && median >= 4.5,
          `overflow=${m.overflow} outside=${m.outside.length} broken=${m.broken.length} errors=${errors.length} shot=${m.shot} contrast(median min)=${median.toFixed(2)} worst-pixel=${worst.toFixed(2)}${errors.length ? " " + errors.slice(0, 2).join(" | ") : ""}${m.outside.length ? " " + m.outside.join(",") : ""}`);
        if (SHOTS && SHOT_LANGS.has(lang)) await page.screenshot({ path: resolve(SHOTS, `${tag}.png`), fullPage: true });
        await ctx.close();
      }
    }
  }
  if (ONLY.has("pages")) {
    // 기록(막지 않음): 제목은 두 반쪽(블록 span)이라 「1+1」이 문구가 정한 두 줄이다. 문구를 바꾸면 이 두 줄과 위 넘침 단정을 본다.
    console.log(`제목 반쪽 줄 수: ${Object.entries(titleLines).map(([k, n]) => `${k}=${n}`).join(" ")}`);
    console.log(`리드 줄 수: ${Object.entries(leadLines).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  }

  // 1b) 첫 화면 문구(#5568 문구 1안): 7개 언어 × 320·360·390·768·1280(밝게, 움직임 줄이기). 줄 수는 기록(막지 않음)
  if (ONLY.has("copy")) {
    const bad = { present: [], chip: [], mid: [], head: [], overflow: [] };
    const rec = { title: [], lead: [], chip: [] };
    const titleBad = [];
    const metaBad = [];
    let scenes = 0;
    for (const lang of LANGS) {
      const plain = (key) => cats[lang][key].replaceAll("|", "");
      const want = { eyebrow: plain("hero_eyebrow"), chips: ["hero_proof_1", "hero_proof_2", "hero_proof_3"].map(plain) };
      for (const w of [320, 360, 390, 768, 1280]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, reducedMotion: "reduce", colorScheme: "light" });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/${lang}/`, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        const m = await page.evaluate(copyMeasure, w);
        const tag = `${lang}-${w}`;
        scenes += 1;
        if (m.eyebrow !== want.eyebrow || m.chips.length !== 3 || m.chips.some((c, i) => c !== want.chips[i]) || !m.order) bad.present.push(`${tag}:${JSON.stringify({ eyebrow: m.eyebrow, chips: m.chips, order: m.order })}`);
        if (m.chipOut.length || m.rowOut) bad.chip.push(`${tag}:${m.chipOut.join(",")}${m.rowOut ? " 칩 줄" : ""}`);
        if (m.mid.length) bad.mid.push(`${tag}:${m.mid.join(" ")}`);
        if (m.head.length) bad.head.push(`${tag}:${m.head.join(" ")}`);
        if (m.overflow > 0 || m.inkOut.length) bad.overflow.push(`${tag}:+${m.overflow}${m.inkOut.length ? " 글자 밖 " + m.inkOut.join(",") : ""}`);
        rec.title.push(`${tag}=${m.titleLines}`);
        rec.lead.push(`${tag}=${m.leadLines}`);
        rec.chip.push(`${tag}=${m.chipLines}/${m.chipRows}행`);
        if (w === 1280) {
          // 탭 제목은 7개 언어 모두 「oort」(owner 11-09), 링크 미리 보기 설명은 사전 그대로 150자 이하
          const meta = await page.evaluate(() => ({ title: document.title, desc: document.querySelector('meta[name="description"]')?.content ?? null }));
          if (meta.title !== "oort") titleBad.push(`${lang}:${meta.title}`);
          if (meta.desc !== cats[lang].meta_description || [...(meta.desc ?? "")].length > 150) metaBad.push(`${lang}:${meta.desc === null ? "없음" : [...meta.desc].length}`);
        }
        await ctx.close();
      }
    }
    // 루트(/)는 첫 방문이면 브라우저 언어로 옮기므로 HTML 을 직접 읽는다
    const rootTitle = /<title>([^<]*)<\/title>/.exec(await (await fetch(`${BASE}/`)).text())?.[1];
    if (rootTitle !== "oort") titleBad.push(`/:${rootTitle}`);
    const show = (list) => `${list.length}/${scenes}${list.length ? " " + list.slice(0, 4).join(" ") : ""}`;
    check("첫 화면 문구: 머리글 1·증거 칩 3이 7개 언어 사전 문구 그대로, 머리글 → 제목 → 리드 → 칩 → 주 행동 자리(5개 폭)", bad.present.length === 0, show(bad.present));
    check("첫 화면 문구: 칩이 화면 밖으로 안 나가고 칩·칩 줄의 가로 넘침 0", bad.chip.length === 0, show(bad.chip));
    check("첫 화면 문구: 제목·머리글·칩 낱말 가운데 끊김 0(ko keep-all·ja/zh 구절 힌트·줄 안 바꾸는 빈칸)", bad.mid.length === 0, show(bad.mid));
    check("첫 화면 문구: 줄 머리 문장 부호 0(머리글·제목·리드·칩)", bad.head.length === 0, show(bad.head));
    check("첫 화면 문구: 문서 가로 넘침 0, 머리글·제목·리드·칩 글자가 화면 안(7개 언어 × 320·360·390·768·1280)", bad.overflow.length === 0, show(bad.overflow));
    check("탭 제목이 「oort」(7개 언어 + 루트)", titleBad.length === 0, titleBad.length ? titleBad.join(" ") : `${LANGS.length + 1}/${LANGS.length + 1}`);
    check("meta description 이 사전 문구 그대로, 150자 이하(7개 언어)", metaBad.length === 0, metaBad.length ? metaBad.join(" ") : LANGS.map((l) => `${l}=${[...cats[l].meta_description].length}`).join(" "));
    console.log(`문구 제목 반쪽 줄 수: ${rec.title.join(" ")}`);
    console.log(`문구 리드 줄 수: ${rec.lead.join(" ")}`);
    console.log(`문구 칩 줄 수(칩마다/칩 줄 행 수): ${rec.chip.join(" ")}`);
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


  // 6) 좁은 폭(390, 폰이 아닌 브라우저): 주 버튼에 칩이 보이고, 터치 44, TestFlight 표지, 분할 버튼 포커스, 메뉴 포커스 빠짐
  if (ONLY.has("narrow")) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => {
      const fake = { brands: [], mobile: false, platform: "macOS", getHighEntropyValues: () => Promise.reject(new Error("unknown")) };
      Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => fake });
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ko/`, { waitUntil: "load" });
    await settle(page);
    const cdp = await ctx.newCDPSession(page);
    // 브라우저가 계산한 접근성 이름(숨긴 글자는 빠진다)
    const axName = async (selector) => {
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
      return nodes[0]?.name?.value ?? "";
    };
    const chipSeen = () => page.evaluate(() => {
      const chip = document.querySelector("[data-chip-label]").getBoundingClientRect();
      const main = document.querySelector("#get-mac").getBoundingClientRect();
      return { w: Math.round(chip.width), inside: chip.width > 0 && chip.left >= main.left && chip.right <= main.right && chip.top >= main.top && chip.bottom <= main.bottom, text: document.querySelector("[data-chip-label]").textContent };
    });
    const before = { name: await axName("#get-mac"), ...(await chipSeen()) };
    check("390: 주 버튼 글자·접근성 이름에 고른 칩(Apple Silicon)", before.inside && before.w > 0 && /Apple Silicon/.test(before.name), JSON.stringify(before));
    await page.locator(".get-more").click();
    await page.locator('.chip-menu [data-chip="x64"]').click();
    const after = { name: await axName("#get-mac"), href: await page.locator("#get-mac").getAttribute("href"), ...(await chipSeen()) };
    check("390: Intel 을 고르면 버튼 글자·접근성 이름도 Intel", after.inside && after.text === "Intel" && /Intel/.test(after.name) && !/Apple Silicon/.test(after.name) && after.href === values.DMG_X64_URL, JSON.stringify(after));

    // 터치 크기: 600px 아래 컨트롤은 44 이상(언어 단추·머리 「브라우저에서 열기」·기기 줄 단추·메뉴 항목·꼬리 언어 링크)
    const sizes = async (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }), sel);
    const tall = (list) => list.length > 0 && list.every(([w, h]) => w >= 44 && h >= 44);
    const top = { lang: await sizes(".lang-btn"), web: await sizes(".web-link"), rows: await sizes(".row .pill"), foot: await sizes(".foot-langs a") };
    await page.locator(".lang-btn").click();
    top.langItems = await sizes(".lang-list a");
    await page.keyboard.press("Escape");
    await page.locator(".get-more").click();
    top.chipItems = await sizes(".chip-menu button");
    await page.keyboard.press("Escape");
    const okTouch = tall(top.lang) && tall(top.web) && top.rows.length === 3 && tall(top.rows) && top.langItems.length === LANGS.length && tall(top.langItems) && tall(top.chipItems)
      && top.foot.length === LANGS.length && tall(top.foot);
    check("390: 컨트롤 터치 크기 44 이상(머리 「브라우저에서 열기」 아이콘·꼬리 언어 링크 포함)", okTouch, JSON.stringify(top));

    // 첫 화면에는 「다른 기기」 링크가 없다(기기 목록 자리는 그대로 있다)
    const more = await page.evaluate(() => ({
      heroLinks: [...document.querySelectorAll(".hero a")].map((a) => a.getAttribute("href")),
      toDevices: document.querySelectorAll('a[href="#devices"], .spec-link').length,
      devices: document.getElementById("devices") !== null,
    }));
    check("첫 화면에 「다른 기기」 링크 없음(기기 목록은 그대로)", more.toDevices === 0 && more.devices && !more.heroLinks.some((h) => h?.startsWith("#")), JSON.stringify(more));

    // 좁은 창의 웹 링크 아이콘: 툴팁(title)이 이름과 같고, 모양이 언어 아이콘과 같다(유리 원 없음, 마우스를 올리면 둘 다 같은 바탕)
    const look = (sel) => page.evaluate((s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return { bg: cs.backgroundColor, blur: cs.backdropFilter || cs.webkitBackdropFilter || "none", radius: cs.borderTopLeftRadius };
    }, sel);
    const webTitle = await page.locator(".web-link").getAttribute("title");
    const rest = { web: await look(".web-link"), lang: await look(".lang-btn") };
    await page.hover(".web-link");
    const hoverWeb = await look(".web-link");
    await page.hover(".lang-btn");
    const hoverLang = await look(".lang-btn");
    await page.mouse.move(1, 600);
    const same = (a, b) => a.bg === b.bg && a.blur === b.blur && a.radius === b.radius;
    check("390: 웹 링크 아이콘에 툴팁, 언어 아이콘과 같은 모양(가만히·마우스 올림)", webTitle === ko.nav_web && same(rest.web, rest.lang) && same(hoverWeb, hoverLang),
      JSON.stringify({ webTitle, rest, hoverWeb, hoverLang }));

    // L3: 사양 줄의 모노는 숫자·버전에만(칩 이름은 본문 글꼴)
    const spec = await page.evaluate(() => [...document.querySelectorAll(".hero .spec span")].map((s) => [s.textContent, /monospace/.test(getComputedStyle(s).fontFamily)]));
    const monoOk = spec.length === 4 && spec.every(([text, mono]) => mono === /\d/.test(text));
    check("사양 줄: 모노는 숫자·버전에만, 칩 이름은 본문 글꼴", monoOk, JSON.stringify(spec));

    // H1: TestFlight 표지는 버튼 문법(채움 + 알약)이 아니다
    const tag = await page.evaluate(() => {
      const el = document.querySelector(".row .tag");
      const cs = getComputedStyle(el);
      const a = /rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/.exec(cs.backgroundColor);
      const alpha = cs.backgroundColor === "transparent" ? 0 : a ? +a[1] : 1;
      return { bg: cs.backgroundColor, alpha, radius: parseFloat(cs.borderTopLeftRadius), interactive: el.closest("a,button") !== null };
    });
    check("TestFlight 표지가 채움 알약이 아니다(배경 투명 또는 반경 10 이하)", !tag.interactive && (tag.alpha === 0 || tag.radius <= 10), JSON.stringify(tag));

    // 좁은 폭의 언어 메뉴: 7개 언어 모두 판이 화면 안에 있고 항목이 한 줄이다
    // 꼬리 언어 링크: 줄마다 첫 링크의 글자 왼쪽 끝이 꼬리 판 번호(oort 0.1.45) 글자의 왼쪽 끝과 같다(44 상자 안 가운데 정렬로 어긋나지 않게)
    const menus = [];
    const footBad = [];
    let footFirst = null;
    for (const l of LANGS) {
      await page.goto(`${BASE}/${l}/`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const foot = await page.evaluate(() => {
        const text = (el) => {
          const rg = document.createRange();
          rg.selectNodeContents(el);
          return [...rg.getClientRects()].find((x) => x.width > 0) || { left: NaN, right: NaN };
        };
        const col = text(document.querySelector(".foot-v")).left;
        const rows = new Map();
        for (const a of document.querySelectorAll(".foot-langs a")) {
          const t = Math.round(a.getBoundingClientRect().top);
          if (!rows.has(t)) rows.set(t, []);
          rows.get(t).push(a);
        }
        const list = [...rows.values()];
        // 같은 줄 이웃 글자 사이 간격(글자 끝 → 다음 글자 시작)
        const gaps = list.flatMap((row) => row.slice(1).map((a, i) => Math.round((text(a).left - text(row[i]).right) * 10) / 10));
        return { col: Math.round(col * 10) / 10, firsts: list.map((row) => ({ name: row[0].textContent, dx: Math.round((text(row[0]).left - col) * 10) / 10 })), gaps };
      });
      if (l === "ko") footFirst = foot;
      const evenGaps = foot.gaps.length > 0 && Math.max(...foot.gaps) - Math.min(...foot.gaps) <= 1;
      if (!(Number.isFinite(foot.col) && foot.firsts.length > 0 && foot.firsts.every((f) => Math.abs(f.dx) <= 1) && evenGaps)) footBad.push(`${l}:${JSON.stringify(foot)}`);
      await page.locator(".lang-btn").click();
      menus.push(await page.evaluate((code) => {
        const m = document.getElementById("lang-list").getBoundingClientRect();
        const items = [...document.querySelectorAll(".lang-list a")].map((a) => a.getBoundingClientRect().height);
        return { code, left: Math.round(m.left), right: Math.round(m.right), vw: document.documentElement.clientWidth, oneLine: items.every((h) => h <= 48) };
      }, l));
    }
    check("390: 언어 메뉴가 7개 언어 모두 화면 안, 항목 한 줄", menus.every((m) => m.left >= 0 && m.right <= m.vw && m.oneLine), JSON.stringify(menus.filter((m) => !(m.left >= 0 && m.right <= m.vw && m.oneLine))));
    check("390: 꼬리 언어 링크 줄마다 첫 글자 왼쪽 끝이 꼬리 다른 줄과 같고, 글자 사이 간격이 고르다(7개 언어, 1px 안)", footBad.length === 0, footBad.length ? footBad.slice(0, 2).join(" ") : JSON.stringify(footFirst));
    await page.goto(`${BASE}/ko/`, { waitUntil: "load" });
    await settle(page);

    // L1: 언어 메뉴는 포커스가 판 밖으로 나가면 닫힌다
    await page.locator(".lang-btn").click();
    for (let i = 0; i < LANGS.length + 1; i++) await page.keyboard.press("Tab");
    const tabOut = await page.evaluate(() => ({ hidden: document.getElementById("lang-list").hidden, expanded: document.querySelector(".lang-btn").getAttribute("aria-expanded"), focus: document.activeElement?.className }));
    check("언어 메뉴: Tab 으로 판 밖에 나가면 닫힌다", tabOut.hidden === true && tabOut.expanded === "false" && /web-link/.test(tabOut.focus), JSON.stringify(tabOut));
    await ctx.close();

    // M1: 분할 버튼 포커스에도 반쪽 모서리가 그대로이고 링이 보인다(1280, 키보드)
    const wide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const wp = await wide.newPage();
    await wp.goto(`${BASE}/en/`, { waitUntil: "load" });
    await settle(wp);
    await wp.locator(".get-more").focus();
    await wp.keyboard.press("Shift+Tab");
    const ring = () => wp.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      const group = getComputedStyle(document.querySelector(".get"));
      return { id: el.id || el.className, fv: el.matches(":focus-visible"), tl: cs.borderTopLeftRadius, tr: cs.borderTopRightRadius, br: cs.borderBottomRightRadius, bl: cs.borderBottomLeftRadius, ring: cs.outlineStyle !== "none" || group.outlineStyle !== "none" };
    });
    const onMain = await ring();
    await wp.keyboard.press("Tab");
    const onMore = await ring();
    if (SHOTS) await wp.screenshot({ path: resolve(SHOTS, "focus-more-en-1280-light.png"), clip: { x: 340, y: 380, width: 600, height: 200 } });
    check("분할 버튼 포커스: 반쪽 모서리 그대로, 링 보임", onMain.id === "get-mac" && onMain.fv && onMain.tr === "0px" && onMain.br === "0px" && onMain.tl !== "0px" && onMain.ring
      && onMore.fv && onMore.tl === "0px" && onMore.bl === "0px" && onMore.tr !== "0px" && onMore.ring, JSON.stringify({ onMain, onMore }));
    await wide.close();
  }

  // 7) 폰 흉내(iPhone 14, 390): 첫 화면 주 행동은 웹으로 열기, Mac 내려받기는 기기 목록에서 닿는다. JS 가 없으면 Mac 이 기본
  if (ONLY.has("phone")) {
    const iphone = { ...devices["iPhone 14"] };
    delete iphone.defaultBrowserType;
    for (const lang of ["ko", "en"]) {
      const ctx = await browser.newContext({ ...iphone, colorScheme: "light" });
      const page = await ctx.newPage();
      const errors = watch(page);
      await page.goto(`${BASE}/${lang}/`, { waitUntil: "load" });
      await settle(page);
      const st = await page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const web = document.getElementById("get-web");
        const r = web.getBoundingClientRect();
        return {
          phone: document.documentElement.hasAttribute("data-phone"),
          webHref: web.getAttribute("href"), webVisible: vis(web), webInFirstScreen: r.bottom <= window.innerHeight, webH: Math.round(r.height),
          macHidden: !vis(document.getElementById("get-mac")),
          notes: [...document.querySelectorAll(".hero .phone-note")].filter(vis).length,
          installTitle: document.getElementById("install-title").textContent,
        };
      });
      // Mac 내려받기 두 줄: 스크롤해 닿으면 그 자리를 누를 수 있다
      const rows = [];
      for (const chip of ["arm", "x64"]) {
        const a = page.locator(`.row a[data-row="${chip}"]`);
        await a.scrollIntoViewIfNeeded();
        rows.push(await a.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { href: el.getAttribute("href"), hit: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), h: Math.round(r.height) };
        }));
      }
      // scroll-behavior: smooth 라 scrollTo 는 움직이는 중일 수 있다. 즉시 맨 위로 옮기고 닿은 뒤에 잰다(부하에서 대비를 스크롤 중에 재던 경주)
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
      await page.waitForFunction(() => window.scrollY === 0);
      const contrast = await heroContrast(page, decoder);
      const median = Math.min(...contrast.map((c) => c.median));
      const rowsOk = rows[0].href === values.DMG_ARM_URL && rows[1].href === values.DMG_X64_URL && rows.every((r) => r.hit && r.h >= 44);
      check(`iPhone 흉내 ${lang}: 첫 화면 주 행동은 웹(${values.WEB_URL}), Mac 내려받기는 기기 목록에서 닿음`,
        st.phone && st.webHref === values.WEB_URL && st.webVisible && st.webInFirstScreen && st.macHidden && st.notes === 2 && /Mac/.test(st.installTitle) && rowsOk && errors.length === 0 && median >= 4.5,
        `${JSON.stringify(st)} rows=${JSON.stringify(rows)} errors=${errors.length} contrast=${median.toFixed(2)}`);
      if (SHOTS) await page.screenshot({ path: resolve(SHOTS, `iphone-${lang}-390-light.png`), fullPage: true });
      await ctx.close();
    }
    // JS 가 없으면 표지가 없어 Mac 이 기본(폰 UA 여도)
    const nojs = await browser.newContext({ ...iphone, javaScriptEnabled: false });
    const np = await nojs.newPage();
    await np.goto(`${BASE}/ko/`, { waitUntil: "load" });
    const ns = await np.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return { phone: document.documentElement.hasAttribute("data-phone"), mac: vis(document.getElementById("get-mac")), web: vis(document.getElementById("get-web")), href: document.getElementById("get-mac").getAttribute("href") };
    });
    check("JS 없음: 폰이어도 첫 화면은 Mac 내려받기(Apple Silicon)", !ns.phone && ns.mac && !ns.web && ns.href === values.DMG_ARM_URL, JSON.stringify(ns));
    await nojs.close();
    // 폰이 아닌 좁은 창(390, 데스크탑 UA)은 Mac 이 첫 화면이다
    const desk = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const dp = await desk.newPage();
    await dp.goto(`${BASE}/ko/`, { waitUntil: "load" });
    await settle(dp);
    const ds = await dp.evaluate(() => ({ phone: document.documentElement.hasAttribute("data-phone"), mac: document.getElementById("get-mac").getBoundingClientRect().height > 0 }));
    check("데스크탑 브라우저 390 폭은 폰 표지 없이 Mac 이 첫 화면", !ds.phone && ds.mac, JSON.stringify(ds));
    await desk.close();
  }

  // 8) WebKit(사파리 엔진) 일본어 390: 줄이 조사·작은 가나·닫는 부호로 시작하거나 여는 괄호로 끝나지 않는다(구절 힌트 <wbr> + keep-all)
  if (ONLY.has("webkit")) {
    const wk = await webkit.launch();
    const iphone = { ...devices["iPhone 14"] };
    delete iphone.defaultBrowserType;
    for (const [name, opts] of [["390", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }], ["iPhone", iphone]]) {
      const ctx = await wk.newContext({ ...opts, colorScheme: "light" });
      const page = await ctx.newPage();
      const errors = watch(page);
      await page.goto(`${BASE}/ja/`, { waitUntil: "load" });
      await settle(page);
      const res = await page.evaluate(() => {
        const BAD_START = "はをのにでがともへやゃゅょっァィゥェォャュョッー、。）」』";
        const BAD_END = "（「『";
        const lines = (el) => {
          const out = []; let top = null, cur = "";
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            for (let i = 0; i < n.data.length; i++) {
              const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1);
              const r = [...rg.getClientRects()].find((x) => x.width > 0);
              if (r) {
                const t = Math.round(r.top);
                if (top !== null && t > top + 4) { out.push(cur); cur = ""; }
                if (top === null || t > top + 4) top = t;
              }
              cur += n.data[i];
            }
          }
          out.push(cur);
          return out.map((l) => l.replace(/[\s ⁠]+/g, " ").trim()).filter(Boolean);
        };
        const blocks = [...document.querySelectorAll(".hero .eyebrow, .hero h1 span, .hero .lead, .hero .proof li, .hero .phone-note span, .row-t span, .steps li > span:last-child")]
          .filter((el) => el.getBoundingClientRect().width > 0).map(lines);
        const bad = [];
        for (const ls of blocks) ls.forEach((l, i) => {
          if (i > 0 && BAD_START.includes(l[0])) bad.push(`…|${l.slice(0, 6)}`);
          if (i < ls.length - 1 && BAD_END.includes(l[l.length - 1])) bad.push(`${l.slice(-6)}|…`);
        });
        return { blocks: blocks.length, wrapped: blocks.filter((b) => b.length > 1).length, bad, lead: lines(document.querySelector(".hero .lead")), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check(`WebKit ja ${name}: 조사·부호 앞에서 줄이 끊기지 않는다`, res.bad.length === 0 && res.wrapped > 0 && res.overflow <= 0 && errors.length === 0, JSON.stringify(res));
      if (SHOTS && name === "390") await page.screenshot({ path: resolve(SHOTS, "webkit-ja-390-light.png"), fullPage: true });
      await ctx.close();
    }
    await wk.close();
  }

  // 9) 머리 줄: 7개 언어 × 320·360·375·390·568·600 × (일반·폰 흉내). 로고는 줄지도 꺾이지도 않고, 컨트롤은 화면 안,
  //    600 아래 컨트롤은 아이콘 44×44, 폰이면 머리 「브라우저에서 열기」를 숨겨 첫 화면의 웹 링크가 하나다.
  if (ONLY.has("header")) {
    const iphone = { ...devices["iPhone 14"] };
    delete iphone.defaultBrowserType;
    const modes = [
      ["일반", (w) => ({ viewport: { width: w, height: 700 } })],
      ["폰", (w) => ({ ...iphone, viewport: { width: w, height: 700 }, screen: { width: w, height: 700 } })],
    ];
    const bad = { lines: [], mark: [], ctl: [], overflow: [], icon: [], link: [], menu: [] };
    let scenes = 0;
    for (const [mode, opts] of modes) {
      for (const w of [320, 360, 375, 390, 568, 600]) {
        const ctx = await browser.newContext({ ...opts(w), reducedMotion: "reduce", colorScheme: "light" });
        const page = await ctx.newPage();
        for (const lang of LANGS) {
          await page.goto(`${BASE}/${lang}/`, { waitUntil: "load" });
          await page.evaluate(() => document.fonts.ready);
          const m = await page.evaluate(headMeasure, w);
          const tag = `${mode}-${w}-${lang}`;
          scenes += 1;
          if (m.lines !== 1) bad.lines.push(`${tag}:${m.lines}줄`);
          if (m.mark !== "26x26") bad.mark.push(`${tag}:${m.mark}`);
          if (m.overlap || m.ctls.some((c) => c.left < -0.5 || c.right > w + 0.5)) bad.ctl.push(`${tag}:${m.ctls.map((c) => `${c.cls}${c.left}..${c.right}`).join(",")}`);
          if (m.overflow > 0) bad.overflow.push(`${tag}:+${m.overflow}`);
          if (w < 600 && !m.ctls.every((c) => c.w >= 44 && c.w <= 48 && c.h >= 44)) bad.icon.push(`${tag}:${m.ctls.map((c) => `${c.cls}${c.w}x${c.h}`).join(",")}`);
          const web = m.ctls.some((c) => c.cls === "web");
          if (m.phone !== (mode === "폰") || web === m.phone || m.webLinks !== 1) bad.link.push(`${tag}:phone=${m.phone} head=${web} links=${m.webLinks}`);
          if (w === 320) {
            // 가장 좁은 폭에서 언어 판이 화면 안이고 항목이 한 줄이다(판을 머리 오른쪽에 맞춘 뒤)
            await page.locator(".lang-btn").click();
            const mm = await page.evaluate(() => {
              const b = document.getElementById("lang-list").getBoundingClientRect();
              return { left: Math.round(b.left), right: Math.round(b.right), oneLine: [...document.querySelectorAll(".lang-list a")].every((a) => a.getBoundingClientRect().height <= 48) };
            });
            if (mm.left < 0 || mm.right > w || !mm.oneLine) bad.menu.push(`${tag}:${mm.left}..${mm.right} oneLine=${mm.oneLine}`);
            await page.keyboard.press("Escape");
          }
        }
        await ctx.close();
      }
    }
    const show = (list) => `${list.length}/${scenes}${list.length ? " " + list.slice(0, 6).join(" ") : ""}`;
    check("머리 줄: 로고 글자 한 줄(높이로 잼)", bad.lines.length === 0, show(bad.lines));
    check("머리 줄: 로고 마크 26×26 그대로", bad.mark.length === 0, show(bad.mark));
    check("머리 줄: 컨트롤이 화면 안, 로고와 안 겹침", bad.ctl.length === 0, show(bad.ctl));
    check("머리 줄: 문서 가로 넘침 0", bad.overflow.length === 0, show(bad.overflow));
    check("머리 줄: 600 아래 컨트롤은 아이콘 44×44", bad.icon.length === 0, show(bad.icon));
    check("머리 줄: 폰이면 머리 「브라우저에서 열기」 숨김, 첫 화면 웹 링크 하나", bad.link.length === 0, show(bad.link));
    check("머리 줄: 320 언어 판이 화면 안, 항목 한 줄(7언어 × 일반·폰)", bad.menu.length === 0, `${bad.menu.length}/14 ${bad.menu.join(" ")}`);

    // 안전망: 자리가 모자라면 컨트롤 묶음이 아랫줄 오른쪽 끝으로 내려가고 넘치지 않는다(정본 #4230). 620 일반 창에서 언어 이름을 늘려 잰다
    const sx = await browser.newContext({ viewport: { width: 620, height: 700 }, reducedMotion: "reduce" });
    const sp = await sx.newPage();
    await sp.goto(`${BASE}/es/`, { waitUntil: "load" });
    await sp.evaluate(() => { document.querySelector(".lang-btn .lang-name").textContent = "Español (Latinoamérica) Latinoamérica"; });
    const s = await sp.evaluate(headMeasure, 620);
    check("머리 줄 안전망: 모자라면 컨트롤이 아랫줄 오른쪽 끝(넘침 0·로고 그대로)",
      s.wrapped && Math.abs(s.navRight - (620 - 24)) <= 1 && s.overflow <= 0 && s.lines === 1 && s.mark === "26x26" && s.ctls.every((c) => c.right <= 620),
      JSON.stringify({ wrapped: s.wrapped, navRight: s.navRight, overflow: s.overflow, lines: s.lines, mark: s.mark }));
    await sx.close();

    // 아이콘만 남은 단추도 이름을 낸다(브라우저가 계산한 접근성 이름, 일반 390 ko)
    const ax = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const ap = await ax.newPage();
    await ap.goto(`${BASE}/ko/`, { waitUntil: "load" });
    const cdp = await ax.newCDPSession(ap);
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const name = async (selector) => {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
      return nodes[0]?.name?.value ?? "";
    };
    const names = { lang: await name(".lang-btn"), web: await name(".web-link") };
    check("390: 아이콘 단추의 접근성 이름(언어 단추에 지금 언어, 머리 링크에 「브라우저에서 열기」)", names.lang.includes(ko.lang_name) && names.web === ko.nav_web, JSON.stringify(names));
    await ax.close();
  }

  // 10) 머리 로고 배색: 새 메시지 판. 링(꼬리 포함)은 글자색, 위성은 --signal 이고 그 값은 tokens.css 의
  //     `--signal: light-dark(라이트, 다크)` 한 줄과 같다(메뉴 막대 oort-tray-unread-on-* 를 그리는 render_tray_icons.sh 도 이 줄을 읽는다)
  if (ONLY.has("logo")) {
    const tokens = readFileSync(resolve(SITE, "../web/src/design/tokens.css"), "utf8");
    const sig = /--signal:\s*light-dark\((#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\);/.exec(tokens);
    const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    for (const [scheme, want] of [["light", sig && rgb(sig[1])], ["dark", sig && rgb(sig[2])]]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/ko/`, { waitUntil: "load" });
      const st = await page.evaluate(() => {
        const paths = [...document.querySelectorAll(".brand .mark path")];
        const sat = document.querySelector(".brand .mark .mark-sat");
        const ring = paths.find((p) => p !== sat);
        return { paths: paths.length, sat: sat ? getComputedStyle(sat).fill : null, ring: ring ? getComputedStyle(ring).fill : null, text: getComputedStyle(document.querySelector(".brand")).color };
      });
      check(`머리 로고(${scheme}): 링은 글자색, 위성은 --signal(tokens.css ${want})`, Boolean(sig) && st.paths === 2 && st.sat === want && st.ring === st.text && st.sat !== st.ring, JSON.stringify(st));
      await ctx.close();
    }
  }

  // 11) 무게
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
