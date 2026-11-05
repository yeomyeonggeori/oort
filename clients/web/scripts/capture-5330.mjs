#!/usr/bin/env node
// =============================================================================
// 표현 고르개 「이모티콘」 이름·간격·불러오기 캡처 (#5330, 웹 반쪽). 이 파일은 저장소의 캡처 하네스 규약을 따른다:
// 번들 Chromium 헤드리스 + 모의 `/v1`(gates/connection-harness.mjs, 시크릿 없음, 인물은 전부 가상) + 표현 보관함은 개발 서버 전용
// 고정 전송(`?expressions=fixture`, `import.meta.env.DEV`일 때만 켜진다). 그래서 이 캡처는 **vite 개발 서버**를 본다.
//
//   node_modules/.bin/vite --host 127.0.0.1 --port 5330 --strictPort      # 자기 PID 로 띄우고 끝에 그 PID 만 끈다
//   node scripts/capture-5330.mjs --label before --out <스크래치>/cap5330 --port 5330
//   node scripts/capture-5330.mjs --label after  --out <스크래치>/cap5330 --port 5330
//
// before 는 옛 이름(「이모지 넣기」 · 「우리 팀」), after 는 새 이름(「이모티콘 넣기」 · 「이모티콘」 · 「기본」 · 「GIF」)으로 찍는다.
// 찍으면서 **재는 것**(캡처가 곧 실행 증거다):
//   1. 간격: 고르개 안 블록들 사이의 세로 간격(탭 줄 ↔ 추가하기 줄 ↔ 검색 ↔ 안내 ↔ 목록)과 항목 그림 사이 간격.
//   2. 다시 불러오기: 창 초점이 돌아올 때(= 공급자가 하는 일상 새로 읽기) 이미 그려진 그림이 글자 자리표시(`:name:`)로 바뀌는지.
// 캡처는 저장소에 올리지 않는다: --out 을 스크래치로 준다.
// =============================================================================
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installBackend, openGeneral, signIn, sleep } from "../gates/connection-harness.mjs";
import { withCaptureLocale } from "./capture-locale.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const LABEL = String(arg("label", "after"));
const PORT = Number(arg("port", 5330));
const OUT = resolve(WEB_ROOT, String(arg("out", `captures/5330/${LABEL}`)));
const SCHEME = String(arg("scheme", "light"));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BEFORE = LABEL === "before";
// 옛 이름과 새 이름. 캡처가 사전을 읽지 않는 까닭: 이 파일은 화면에 선 글자를 눈으로 대조하는 쪽이다.
const TRIGGER_NAME = BEFORE ? "이모지 넣기" : "이모티콘 넣기";

const results = [];
function note(id, value) {
  results.push({ id, value });
  console.log(`  ${id}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/** 블록 사이의 세로 간격을 읽는다: 컨테이너의 직계 자식을 위에서 아래로, 앞 자식 바닥 ↔ 이 자식 위. */
async function gapsOf(page, selector) {
  return page.evaluate((css) => {
    const root = document.querySelector(css);
    if (!root) return null;
    const rows = [];
    let previous = null;
    for (const child of root.children) {
      const box = child.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (child.classList.contains("sr-only")) continue;
      const name = child.getAttribute("data-testid") ?? child.getAttribute("aria-label") ?? child.tagName.toLowerCase();
      rows.push({ name, top: Math.round(box.top * 10) / 10, height: Math.round(box.height * 10) / 10, gap: previous === null ? null : Math.round((box.top - previous) * 10) / 10 });
      previous = box.bottom;
    }
    return rows;
  }, selector);
}

/** 목록의 그림 사이 간격(그림 바닥 ↔ 다음 그림 위)과 항목 높이. */
async function itemGaps(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll("ul[aria-label='팀 표현 목록'] > li")];
    const rows = items.map((li) => {
      const image = li.querySelector("[data-expression-name]");
      const box = li.getBoundingClientRect();
      const pic = image ? image.getBoundingClientRect() : null;
      return { height: Math.round(box.height * 10) / 10, picTop: pic ? Math.round(pic.top * 10) / 10 : null, picBottom: pic ? Math.round(pic.bottom * 10) / 10 : null };
    });
    return rows.map((row, at) => ({ ...row, gapToNextPicture: at + 1 < rows.length && row.picBottom !== null && rows[at + 1].picTop !== null ? Math.round((rows[at + 1].picTop - row.picBottom) * 10) / 10 : null }));
  });
}

/**
 * 창 초점이 돌아올 때 일어나는 일상 새로 읽기에서, 이미 그려진 그림이 글자 자리표시로 바뀌는지 잰다.
 * 그려진 `<img>`의 집합을 잡아 두고, 초점 신호를 보낸 뒤 그 집합이 사라졌는지(제거된 img 수)와 자리표시가 선 적이 있는지 센다.
 */
async function flickerProbe(page, root) {
  await page.evaluate((css) => {
    const host = document.querySelector(css);
    window.__flicker = { removedImages: 0, placeholders: 0, startImages: host ? host.querySelectorAll("img").length : 0 };
    if (!host) return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element && (node.tagName === "IMG" || node.querySelector("img"))) window.__flicker.removedImages += node.tagName === "IMG" ? 1 : node.querySelectorAll("img").length;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element && /^:[a-z0-9_-]+:$/.test(node.textContent ?? "") && node.tagName === "SPAN") window.__flicker.placeholders += 1;
        }
      }
    });
    observer.observe(host, { childList: true, subtree: true });
    window.__flickerObserver = observer;
  }, root);
  // 공급자가 하는 일상 새로 읽기: 창 초점(그리고 30초마다)이 부른다.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(900);
  const probe = await page.evaluate(() => {
    window.__flickerObserver?.disconnect();
    return { ...window.__flicker, endImages: document.querySelectorAll("[data-testid='composer-emoji-picker'] img").length };
  });
  return probe;
}

/**
 * before 는 **고치기 전 제품**을 찍어야 한다. 그런데 공용 사전은 이 작업의 다른 반쪽이 이미 바꿨고(옛 이름의 키가 지워졌다), 옛 웹 소스는
 * 지워진 키를 부르면 대체 문장(영어 오류)을 낸다. 그래서 before 에서만 사전 모듈 둘(한국어 문장 · 키 장부)을 **HEAD 의 판**으로 갈아 끼워
 * 응답한다. 읽기 전용 `git show` 만 쓰고 작업 트리는 건드리지 않는다. 생성 파일은 타입 전용 줄만 빼면 그대로 ESM 이다.
 */
async function serveHeadDictionary(context) {
  const head = (path) => execFileSync("git", ["show", `HEAD:${path}`], { cwd: WEB_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const dictionary = head("packages/momo-core/src/i18n/generated/ko-KR.ts")
    .replace(/^import type .*$/m, "")
    .replace("export const catalog: MessageCatalog =", "export const catalog =");
  // 키 장부: 값은 `messageKeys` · `argumentSpecs` 둘이고, `export type MessageKey` 한 줄과 `export interface MessageArgs` 이후는 타입뿐이다.
  const registryFull = head("packages/momo-core/src/i18n/generated/messages.ts");
  const registry = registryFull.slice(0, registryFull.indexOf("export interface MessageArgs")).replace(/^export type MessageKey .*$/m, "").replaceAll("] as const;", "];").replaceAll("} as const;", "};");
  if (!dictionary.includes("export const catalog =") || !registry.includes("export const argumentSpecs")) throw new Error("HEAD 의 사전 모양이 달라졌다");
  const served = { dictionary: 0, registry: 0 };
  await context.route(/\/i18n\/generated\/ko-KR\.ts(\?.*)?$/, (route) => {
    served.dictionary += 1;
    return route.fulfill({ status: 200, contentType: "text/javascript", body: dictionary });
  });
  await context.route(/\/i18n\/generated\/messages\.ts(\?.*)?$/, (route) => {
    served.registry += 1;
    return route.fulfill({ status: 200, contentType: "text/javascript", body: registry });
  });
  return () => served;
}

async function shoot(popover, name) {
  const path = join(OUT, `web-${LABEL}-${name}.png`);
  await popover.screenshot({ path, animations: "disabled", caret: "hide" });
  console.log(`  shot: ${path}`);
  return path;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(
      withCaptureLocale({
        viewport: { width: 1280, height: 860 },
        deviceScaleFactor: 2,
        colorScheme: SCHEME,
        reducedMotion: "reduce",
        timezoneId: "Asia/Seoul",
      })
    );
    const dictionaryServed = BEFORE ? await serveHeadDictionary(context) : () => ({});
    await installBackend(context, PORT);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`  [pageerror] ${String(error).slice(0, 200)}`));
    // 고정 전송 표지는 공급자가 만들어질 때 주소에서 읽는다: 로그인 화면이 이 주소로 서 있는 동안 로그인이 끝나야 한다.
    await signIn(page, `${ORIGIN}/?expressions=fixture`);
    await openGeneral(page);

    const trigger = page.getByTestId("composer-emoji-trigger");
    if (BEFORE) note("head-dictionary-served-times", dictionaryServed());
    note("trigger-accessible-name", await trigger.getAttribute("aria-label"));
    note("trigger-title", await trigger.getAttribute("title"));
    await trigger.click();
    const popover = page.getByTestId("composer-emoji-picker");
    await popover.waitFor({ state: "visible", timeout: 15_000 });
    note("popover-aria-label", await popover.getAttribute("aria-label"));
    note("trigger-matches-expected-name", (await trigger.getAttribute("aria-label")) === TRIGGER_NAME);

    if (BEFORE) {
      const toggles = (await popover.getByRole("button").allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
      note("toggle-buttons", toggles.slice(0, 3));
      await popover.getByRole("button", { name: "우리 팀", exact: true }).click();
      await popover.getByTestId("team-expressions").waitFor({ state: "visible", timeout: 10_000 });
      await popover.locator("img").first().waitFor({ state: "visible", timeout: 10_000 });
      await sleep(600);
      note("panel-blocks (dialog panel children)", await gapsOf(page, "[data-testid='composer-emoji-picker'] > div:not(.sr-only):not([aria-hidden])"));
      note("team-panel-blocks", await gapsOf(page, "[data-testid='team-expressions']"));
      note("item-gaps", await itemGaps(page));
      note("flicker-after-focus", await flickerProbe(page, "[data-testid='composer-emoji-picker']"));
      await shoot(popover, "team-panel");
      // 옛 보기 셋 가운데 GIF: 목록에 항목이 둘 이상 서는 보기라 항목 사이 간격이 보인다.
      await popover.locator("label", { hasText: "GIF" }).first().click();
      await popover.locator("ul[aria-label='팀 표현 목록'] li").nth(1).waitFor({ state: "visible", timeout: 10_000 });
      await sleep(600);
      note("gif-view-item-gaps", await itemGaps(page));
      await shoot(popover, "team-panel-gif-view");
    } else {
      const group = popover.getByRole("group").first();
      note("tab-group-name", await group.getAttribute("aria-label"));
      const buttons = group.getByRole("button");
      note("tab-buttons", (await buttons.allTextContents()).map((text) => text.trim()));
      note("tab-pressed", await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-pressed"))));

      // 기본 (기본값)
      await popover.getByTestId("emoji-search").waitFor({ state: "visible", timeout: 10_000 });
      await sleep(500);
      await shoot(popover, "basic");

      // 이모티콘
      await group.getByRole("button", { name: "이모티콘", exact: true }).click();
      await popover.getByTestId("team-expressions").waitFor({ state: "visible", timeout: 10_000 });
      await popover.locator("img").first().waitFor({ state: "visible", timeout: 10_000 });
      await sleep(600);
      note("emoticon-dialog-panel-blocks", await gapsOf(page, "[data-testid='composer-emoji-picker'] > div:not(.sr-only):not([aria-hidden])"));
      note("emoticon-team-panel-blocks", await gapsOf(page, "[data-testid='team-expressions']"));
      note("emoticon-item-gaps", await itemGaps(page));
      note("emoticon-segmented-in-panel", await popover.locator("fieldset").count());
      note("emoticon-flicker-after-focus", await flickerProbe(page, "[data-testid='composer-emoji-picker']"));
      await shoot(popover, "emoticon");

      // GIF
      await group.getByRole("button", { name: "GIF", exact: true }).click();
      await popover.locator("ul[aria-label='팀 표현 목록']").waitFor({ state: "visible", timeout: 10_000 });
      await popover.locator("img").first().waitFor({ state: "visible", timeout: 10_000 });
      await sleep(600);
      note("gif-item-gaps", await itemGaps(page));
      await shoot(popover, "gif");
    }
    writeFileSync(join(OUT, `web-${LABEL}-measure.json`), JSON.stringify(results, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
