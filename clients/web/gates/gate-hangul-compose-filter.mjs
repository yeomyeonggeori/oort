#!/usr/bin/env node
// GATE: #5836 (ADR-0225 D12) — 한글 이름 채널을 찾는 동안 입력기의 조합 중간 상태에서도 줄이 한 프레임도 사라지지 않는다.
//
// 실제 걸러내기 함수(작성창 `#` 의 `matchChannels` · 빠른 이동의 `paletteFilter`)를 번들해 Chromium 과 WebKit 에서 돌린다.
// 「디자인」을 치는 입력기의 단계(`디` · `디ㅈ` · `디자` · `디장` · `디자이` · `디자인`)를 `compositionupdate` → `input` 차례로
// 보내고, 단계마다 두 프레임을 기다리며 **프레임마다** 목록에 「디자인」 줄이 있는지 기록한다(있어야 하고, 「디저트」는 `디자`부터 없어야 한다).
// Chromium 은 실제 입력기 조합(CDP `Input.imeSetComposition`)으로도 한 번 더 돈다. WebKit 은 입력기를 흉내 낼 길이 없어
// 이벤트를 손으로 보낸다 — 진짜 입력기 조합은 미검증이다.
//
// 사용: node gates/gate-hangul-compose-filter.mjs
//   HANGUL_COMPOSE_ENGINES=chromium,webkit   (기본 둘 다)
//   HANGUL_COMPOSE_NO_LOOSE=1                느슨한 견줌을 뺀 번들로 돌려 RED 를 보인다(사보타주)
//   HANGUL_COMPOSE_OUT=<폴더>                프레임 기록 JSON 을 남긴다

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");
const core = resolve(here, "../../../packages/momo-core/src");
const work = mkdtempSync(join(tmpdir(), "hangul-compose-"));
const noLoose = process.env.HANGUL_COMPOSE_NO_LOOSE === "1";

const STEPS = ["디", "디ㅈ", "디자", "디장", "디자이", "디자인"];
const NAMES = ["디자인", "디저트"];

writeFileSync(
  join(work, "entry.ts"),
  `import { matchChannels } from ${JSON.stringify(join(src, "features/chat/composerAutocomplete.ts"))};
import { paletteFilter } from ${JSON.stringify(join(src, "app/paletteFilter.ts"))};
const channels = ${JSON.stringify(NAMES)}.map((name, i) => ({ id: "c" + i, name, kind: "public" }));
(window as any).filterBoth = (query: string) => ({
  composer: matchChannels(channels as any, query).map((c: any) => c.name),
  palette: ${JSON.stringify(NAMES)}.filter((n) => paletteFilter(n + " 5f0c9e1a", query) > 0),
});
`
);
if (noLoose) {
  writeFileSync(
    join(work, "stub.ts"),
    "export const looseTailMatches = () => []; export const looseTailIncludes = () => false;\n"
  );
}
await build({
  entryPoints: [join(work, "entry.ts")],
  bundle: true,
  format: "iife",
  outfile: join(work, "bundle.js"),
  alias: { "@": src, "@momo/core": core },
  plugins: noLoose
    ? [{
        name: "no-loose",
        setup(b) {
          b.onResolve({ filter: /features\/channels\/nameSearch$/ }, () => ({ path: join(work, "stub.ts") }));
        },
      }]
    : [],
  logLevel: "error",
  loader: { ".json": "json" },
  define: { "import.meta.env": JSON.stringify({ MODE: "test", DEV: false, PROD: true, BASE_URL: "/" }), "import.meta.url": JSON.stringify("http://localhost/") },
});
const bundle = readFileSync(join(work, "bundle.js"), "utf8");

const PAGE = `<!doctype html><meta charset="utf-8"><input id="q"><ul id="composer"></ul><ul id="palette"></ul>`;

/** 한 단계를 보내고 두 프레임을 기다린다. 프레임마다 목록 DOM 을 기록한다. */
async function run(page, mode, cdp) {
  await page.evaluate(() => {
    window.__frames = [];
    const tick = () => {
      const names = (id) => [...document.querySelectorAll("#" + id + " li")].map((li) => li.textContent);
      window.__frames.push({ step: window.__step ?? null, composer: names("composer"), palette: names("palette") });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const input = document.getElementById("q");
    window.__render = () => {
      const result = window.filterBoth(input.value);
      for (const id of ["composer", "palette"]) {
        document.getElementById(id).innerHTML = result[id].map((n) => "<li>" + n + "</li>").join("");
      }
    };
    input.addEventListener("input", window.__render);
    window.__render();
  });
  await page.focus("#q");
  for (const step of STEPS) {
    // 단계 이름표는 입력이 목록에 반영된 **뒤** 붙인다(같은 작업 안에서). 먼저 붙이면 그 사이 프레임이 옛 목록을 새 단계로 센다.
    if (mode === "ime") {
      await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
      await page.evaluate((s) => { window.__step = s; }, step);
    } else {
      await page.evaluate((s) => {
        const input = document.getElementById("q");
        input.dispatchEvent(new CompositionEvent("compositionupdate", { data: s, bubbles: true }));
        input.value = s;
        input.dispatchEvent(new InputEvent("input", { data: s, inputType: "insertCompositionText", isComposing: true, bubbles: true }));
        window.__step = s;
      }, step);
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(40);
  }
  return page.evaluate(() => window.__frames.filter((f) => f.step !== null));
}

const engines = (process.env.HANGUL_COMPOSE_ENGINES ?? "chromium,webkit").split(",");
let failures = 0;
const record = {};
for (const name of engines) {
  const browser = await (name === "webkit" ? webkit : chromium).launch();
  const modes = name === "chromium" ? ["events", "ime"] : ["events"];
  for (const mode of modes) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("pageerror:", String(e).slice(0, 300)));
    await page.setContent(PAGE);
    await page.addScriptTag({ content: bundle });
    const cdp = mode === "ime" ? await context.newCDPSession(page) : null;
    const frames = await run(page, mode, cdp);
    const label = `${name}/${mode}`;
    record[label] = frames;
    const lost = frames.filter((f) => !f.composer.includes("디자인") || !f.palette.includes("디자인"));
    const dessertEarly = frames.filter(
      (f) => !["디", "디ㅈ"].includes(f.step) && (f.composer.includes("디저트") || f.palette.includes("디저트"))
    );
    const bySteps = STEPS.map((s) => frames.filter((f) => f.step === s).length);
    console.log(`${label}: 프레임 ${frames.length} (단계별 ${bySteps.join("/")}), 「디자인」이 사라진 프레임 ${lost.length}, 「디저트」가 남은 프레임(디자 이후) ${dessertEarly.length}`);
    if (frames.length < STEPS.length || lost.length > 0 || dessertEarly.length > 0) failures += 1;
    await context.close();
  }
  await browser.close();
}
if (process.env.HANGUL_COMPOSE_OUT) {
  mkdirSync(process.env.HANGUL_COMPOSE_OUT, { recursive: true });
  writeFileSync(join(process.env.HANGUL_COMPOSE_OUT, "frames.json"), JSON.stringify(record));
}
rmSync(work, { recursive: true });
if (failures > 0) {
  console.error(`FAIL: ${failures}개 장면`);
  process.exit(1);
}
console.log("PASS");
