#!/usr/bin/env node
// =============================================================================
// 코메토 표정 규격 시트 캡처 (#2806). 커밋된 웹 에셋(576 RGBA)을 그대로 <img>로 놓고
// 크로미움 스크린샷을 뜬다. 그림을 새로 그리지 않는다.
//
//   node scripts/kometto-faces-sheet.mjs
//     -> docs/brand/kometto/faces/sheets/
//          sizes-light.png  sizes-dark.png  sizes-transparent.png   크기 24·48·72·96·144
//          hero.png                                                   히어로 280(데스크탑)·200(폰)
//   node scripts/kometto-faces-sheet.mjs --candidates <dir>
//     -> <dir>/*.png(생성 원본 1254, 이름 {id}-dark-{a|b}.png)를 파이프라인과 같은
//        합성으로 얹어 후보 비교 시트 candidates.png를 같은 폴더에 쓴다
//
// 바닥은 새벽하늘 canvas 3정지점(docs/design-system/themes-2.0.md, 데스크탑 가운데 42%).
// 24px은 금지 크기다(32px 미만 사용 금지, docs/brand/mark/README.md). 금지 예시로만 보인다.
// =============================================================================

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ERODE, EYE_LUMA, FACE_IDS, GEN_CROP, WEB_SIZE, composeInPage, facePaths, faceThemes, webInPage } from "./kometto-faces.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const OUT = resolve(REPO_ROOT, "docs/brand/kometto/faces/sheets");
const P = facePaths(REPO_ROOT, WEB_ROOT);
const T = faceThemes(REPO_ROOT);

const NAMES = { idle: "대기", thinking: "생각", happy: "기쁨", flustered: "당황", working: "작업 중", sleepy: "졸림" };
const SIZES = [24, 48, 72, 96, 144];
const CANVAS = {
  light: { bg: "linear-gradient(180deg,#F7EADB 0%,#EFEDEA 42%,#E2E9F3 100%)", ink: "#1B1D21", muted: "#5B5F66" },
  dark: { bg: "linear-gradient(180deg,#231D1B 0%,#171A20 42%,#0F141C 100%)", ink: "#EDEEF0", muted: "#A3A8B0" },
  transparent: {
    bg: "repeating-conic-gradient(#d9d9d9 0% 25%, #ffffff 0% 50%) 0 0 / 16px 16px",
    ink: "#1B1D21",
    muted: "#5B5F66",
  },
};
const uri = (buf) => "data:image/png;base64," + Buffer.from(buf).toString("base64");
const asset = (id, theme) => uri(readFileSync(P.web(id, theme)));

const page0 = (bg, ink, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0}
  body{background:${bg};color:${ink};font:14px/1.4 -apple-system,"Apple SD Gothic Neo","Pretendard",system-ui,sans-serif;padding:32px;display:inline-block}
  h1{font-size:18px;margin:0 0 4px} p{margin:0 0 20px;opacity:.75}
  table{border-collapse:collapse} td,th{padding:10px 14px;text-align:center;vertical-align:middle}
  th{font-weight:600;font-size:13px;white-space:nowrap} th.row{text-align:left;white-space:nowrap}
  .ban{outline:2px dashed #D14343;outline-offset:3px}
  .cap{font-size:12px;opacity:.7;margin-top:6px}
  img{display:block;margin:0 auto}
</style></head><body>${body}</body></html>`;

async function shoot(page, html, path) {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.setContent(html, { waitUntil: "load" });
  const box = await page.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
  });
  await page.setViewportSize({ width: box.w, height: box.h });
  writeFileSync(path, await page.screenshot({ type: "png", fullPage: true }));
  console.log(`wrote ${path.replace(REPO_ROOT + "/", "")}`);
}

function sizesSheet(bgKey) {
  const c = CANVAS[bgKey];
  const themes = bgKey === "transparent" ? ["light", "dark"] : [bgKey];
  const head = `<tr><th></th>${SIZES.map((s) => `<th>${s}px${s < 32 ? " · 금지" : ""}</th>`).join("")}</tr>`;
  const rows = themes
    .flatMap((th) =>
      FACE_IDS.map(
        (id) =>
          `<tr><th class="row">${NAMES[id]} <span style="opacity:.6">${id}${themes.length > 1 ? " · " + th : ""}</span></th>${SIZES.map(
            (s) => `<td><img class="${s < 32 ? "ban" : ""}" src="${asset(id, th)}" width="${s}" height="${s}" alt=""></td>`
          ).join("")}</tr>`
      )
    )
    .join("");
  const title =
    bgKey === "transparent"
      ? "투명 — 배지 밖 알파(체커보드 위)"
      : `새벽하늘 canvas ${bgKey === "light" ? "라이트" : "다크"} — ${bgKey} 에셋`;
  return page0(
    c.bg,
    c.ink,
    `<h1>코메토 표정 6종 · ${title}</h1><p>웹 에셋 576px(1x 원본 픽셀)을 CSS 크기로 줄였다. 빨간 점선 = 32px 미만 금지 크기(비교용).</p><table>${head}${rows}</table>`
  );
}

function heroSheet() {
  const cell = (theme, id, px) =>
    `<td><img src="${asset(id, theme)}" width="${px}" height="${px}" alt=""><div class="cap">${NAMES[id]} · ${px}px</div></td>`;
  const block = (theme) => {
    const c = CANVAS[theme];
    return `<div style="background:${c.bg};color:${c.ink};padding:24px;border-radius:12px;margin-bottom:16px">
      <h1>히어로 · ${theme === "light" ? "라이트" : "다크"}</h1><p>데스크탑 280px(첫 줄), 폰 200px(둘째 줄) — ADR-0193 D11</p>
      <table><tr>${FACE_IDS.map((id) => cell(theme, id, 280)).join("")}</tr>
      <tr>${FACE_IDS.map((id) => cell(theme, id, 200)).join("")}</tr></table></div>`;
  };
  return page0("#ffffff", "#1B1D21", block("light") + block("dark"));
}

async function candidatesSheet(page, dir) {
  const files = readdirSync(dir).filter((f) => /^[a-z]+-dark-[a-z]\.png$/.test(f)).sort();
  const byId = {};
  for (const f of files) {
    const [id, , v] = f.replace(".png", "").split("-");
    (byId[id] ??= []).push([v, resolve(dir, f)]);
  }
  const b64 = (p) => readFileSync(p).toString("base64");
  const crop = async (path) =>
    page.evaluate(
      async ({ src, c }) => {
        const img = await new Promise((ok) => {
          const i = new Image();
          i.onload = () => ok(i);
          i.src = "data:image/png;base64," + src;
        });
        const cv = document.createElement("canvas");
        cv.width = c.w;
        cv.height = c.h;
        cv.getContext("2d").drawImage(img, -c.x, -c.y);
        return cv.toDataURL("image/png").split(",")[1];
      },
      { src: b64(path), c: GEN_CROP }
    );
  const render = async (gen, theme) => {
    const comp = await page.evaluate(composeInPage, {
      src: b64(T[theme].source),
      gen,
      theme: T[theme],
      dark: T.dark,
      crop: GEN_CROP,
      erode: ERODE,
      luma: EYE_LUMA,
      mode: "compose",
    });
    const w = await page.evaluate(webInPage, { src: comp.png, badge: T[theme].badge, cut: T[theme].cut, size: WEB_SIZE, mode: "render" });
    return "data:image/png;base64," + w.png;
  };
  const rows = [];
  for (const id of FACE_IDS.filter((i) => byId[i])) {
    const cells = [];
    for (const [v, path] of byId[id]) {
      const gen = await crop(path);
      const [d, l] = [await render(gen, "dark"), await render(gen, "light")];
      cells.push(`<td><div style="display:flex;gap:10px;align-items:center;justify-content:center">
        <div style="background:${CANVAS.dark.bg};padding:10px;border-radius:10px"><img src="${d}" width="144" height="144"><img src="${d}" width="72" height="72" style="margin-top:8px"></div>
        <div style="background:${CANVAS.light.bg};padding:10px;border-radius:10px"><img src="${l}" width="144" height="144"><img src="${l}" width="72" height="72" style="margin-top:8px"></div>
        </div><div class="cap">${id}-${v}</div></td>`);
    }
    rows.push(`<tr><th class="row">${NAMES[id]}<br><span style="opacity:.6">${id}</span></th>${cells.join("")}</tr>`);
  }
  const html = page0(
    "#ffffff",
    "#1B1D21",
    `<h1>코메토 표정 후보 비교</h1><p>후보마다 파이프라인과 같은 합성(얼굴 창 밖 = K6 원본). 왼쪽 다크, 오른쪽 라이트. 144px·72px.</p><table>${rows.join("")}</table>`
  );
  await shoot(page, html, resolve(dir, "candidates.png"));
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  try {
    const ci = process.argv.indexOf("--candidates");
    if (ci > 0) {
      await candidatesSheet(page, resolve(process.argv[ci + 1]));
      return;
    }
    mkdirSync(OUT, { recursive: true });
    for (const bg of ["light", "dark", "transparent"]) await shoot(page, sizesSheet(bg), resolve(OUT, `sizes-${bg}.png`));
    await shoot(page, heroSheet(), resolve(OUT, "hero.png"));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
