#!/usr/bin/env node
// =============================================================================
// 새 세션의 시작 위치 캡처와 실브라우저 확인 (#2775).
//
//   OUT_DIR=captures/2775 node scripts/capture-start-location.mjs   (build:design 뒤)
//
// `#/design/local-terminal?scene=start-*` 하네스를 Chromium으로 연다. 폴더 고르기·
// 폴더 검사·worktree 만들기는 흉내다(브라우저에는 셸이 없다). 실제 네이티브 폴더
// 대화상자와 `git worktree add`는 데스크탑 debug 앱에서 잰다(PR 본문, runtime-unverified).
//
// 장면(라이트·다크, 1280×800):
//   start-repo   git 저장소를 고른 상태의 메뉴 (최근 프로젝트, worktree 끔)
//   start-repo + 격리 켬 (체크 표시)
//   start-home   처음 쓰는 기기: 홈이 기본, 최근 없음, worktree는 이유와 함께 꺼짐
//   start-plain  git이 아닌 폴더: worktree는 이유와 함께 꺼짐
//   start-empty  커밋 없는 저장소: 이유와 함께 꺼짐
//   start-fail   격리를 켜고 열었는데 worktree를 못 만든 칸
//
// 재는 것: 메뉴가 뷰포트 안, 가로 넘침 0, 홈·최근·폴더 고르기·격리 줄이 있고 격리는
// 기본 꺼짐, 안 되는 폴더의 이유 문구, 클라우드 안내 한 줄.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/start-location");
const PORT = Number(process.env.CAPTURE_PORT || 5196);
const VIEWPORT = { width: 1280, height: 800 };

const failures = [];
const report = { scenes: [], checks: [] };

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, scene) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${origin}/#/design/local-terminal?scene=${scene}`);
  await newSessionButton(page).waitFor();
  return { context, page };
}

// 「새 세션」 단추는 세션 목록이 펴져 있으면 목록 바닥(`session-list-new`)에, 폭 규칙(#2856)으로
// 접혀 있으면 머리 줄(`local-terminal-new`)에 선다. 1280 창의 4×2 배치는 목록을 접으므로(#3294 이후)
// 캡처는 어느 쪽이든 지금 보이는 단추를 쓴다(#3332: 목록 바닥 단추만 기다리다 타임아웃).
function newSessionButton(page) {
  return page.locator('[data-testid="session-list-new"], [data-testid="local-terminal-new"]').first();
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  report.scenes.push(name);
}

async function openMenu(page) {
  await newSessionButton(page).click();
  await page.getByTestId("local-terminal-start-home").waitFor();
  // 폴더 검사(흉내)가 끝나 격리 줄의 상태가 정해질 때까지.
  await page.waitForTimeout(200);
}

async function menuBox(page) {
  return page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return null;
    const r = menu.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
  });
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function scene(browser, origin, scheme, name) {
  const { context, page } = await open(browser, origin, scheme, name);
  await openMenu(page);
  const tag = `${scheme}/${name}`;
  const box = await menuBox(page);
  check(`${tag}: 메뉴가 뷰포트 안`, !!box && box.left >= 0 && box.top >= 0 && box.right <= box.vw && box.bottom <= box.vh, box);
  check(`${tag}: 가로 넘침 0`, (await overflowX(page)) <= 0);
  const text = await page.locator('[role="menu"]').innerText();
  check(`${tag}: 홈에서 시작·폴더 고르기·격리 줄`, ["홈에서 시작", "폴더 고르기…", "새 worktree에서 격리"].every((t) => text.includes(t)));
  check(`${tag}: 클라우드 안내 한 줄`, text.includes("다른 기기·클라우드는 연결되면 나타나요"));
  const checkbox = page.getByTestId("local-terminal-start-worktree");
  check(`${tag}: 격리는 기본 꺼짐`, (await checkbox.getAttribute("aria-checked")) === "false");
  const note = await page.getByTestId("local-terminal-start-worktree-note").innerText();
  if (name === "start-repo") {
    check(`${tag}: 최근 프로젝트 네 줄`, (await page.getByTestId("local-terminal-start-recent").count()) === 4);
    check(`${tag}: git 저장소라 켤 수 있다`, (await checkbox.getAttribute("aria-disabled")) === null, { note });
  } else if (name === "start-home") {
    check(`${tag}: 최근 없음`, (await page.getByTestId("local-terminal-start-recent").count()) === 0 && !text.includes("최근 프로젝트"));
    check(`${tag}: 홈에서는 이유와 함께 꺼짐`, (await checkbox.getAttribute("aria-disabled")) === "true" && note === "홈에서는 쓸 수 없어요", { note });
  } else if (name === "start-plain") {
    check(`${tag}: git이 아니면 이유와 함께 꺼짐`, (await checkbox.getAttribute("aria-disabled")) === "true" && note === "git 저장소를 고르면 켤 수 있어요", { note });
  } else if (name === "start-empty") {
    check(`${tag}: 커밋 없으면 이유와 함께 꺼짐`, (await checkbox.getAttribute("aria-disabled")) === "true" && note === "아직 커밋이 없어서 쓸 수 없어요", { note });
  }
  await shot(page, `${name}-menu-${scheme}`);

  if (name === "start-repo") {
    await checkbox.click();
    check(`${tag}: 격리를 켜면 체크`, (await checkbox.getAttribute("aria-checked")) === "true");
    await shot(page, `${name}-worktree-on-${scheme}`);
    // 폴더 고르기(흉내) → 다른 프로젝트가 기본이 되고 메뉴는 열려 있다.
    await page.getByTestId("local-terminal-start-pick").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="local-terminal-start-label"]')?.textContent?.includes("momo-landing"));
    check(`${tag}: 고른 폴더가 시작 위치로 보임`, true);
    check(`${tag}: 폴더를 고른 뒤에도 메뉴가 열려 있음`, (await page.getByTestId("local-terminal-new-claude").count()) === 1);
    await shot(page, `${name}-picked-${scheme}`);
  }
  await context.close();
}

async function failScene(browser, origin, scheme) {
  const { context, page } = await open(browser, origin, scheme, "start-fail");
  await openMenu(page);
  await page.getByTestId("local-terminal-start-worktree").click();
  await page.getByTestId("local-terminal-new-shell").click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".xterm-rows")).some((el) => el.textContent?.includes("worktree를 만들지 못했어요"))
  );
  const failedStatus = page.getByTestId("local-terminal-status").filter({ hasText: "터미널을 열지 못했습니다" });
  await failedStatus.first().waitFor();
  const status = await failedStatus.first().innerText();
  check(`${scheme}/start-fail: 칸이 한국어로 이유를 말하고 다시 열기를 준다`, status.includes("터미널을 열지 못했습니다") && (await page.getByTestId("local-terminal-restart").count()) >= 1, { status });
  check(`${scheme}/start-fail: 가로 넘침 0`, (await overflowX(page)) <= 0);
  await shot(page, `start-fail-pane-${scheme}`);
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ 가 없다. npm run build:design 부터 돌린다.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      for (const scheme of ["light", "dark"]) {
        for (const name of ["start-repo", "start-home", "start-plain", "start-empty"]) {
          await scene(browser, preview.origin, scheme, name);
        }
        await failScene(browser, preview.origin, scheme);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\nFAIL ${failures.length}: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nOK ${report.checks.length} checks, ${report.scenes.length} shots → ${OUT_DIR}`);
}

await main();
