#!/usr/bin/env node
// =============================================================================
// A 칸 진행 뷰 캡처와 실브라우저 확인 (#2779).
//
//   npm run capture:agent-pane   build:design 뒤 → artifacts/agent-pane/*.png + report.json
//
// `#/design/local-terminal?scene=agent-*` 하네스를 Chromium으로 연다. 원천은 흉내다
// (`agentPaneFixtures`). 데스크탑 셸(Tauri) 안의 모습은 같은 React 트리이고, 실제
// workd 세션·서버 투영과의 왕복은 runtime-unverified다(PR 본문).
//
// 장면(라이트·다크): 1280×800 「내 작업」(로컬 1 + A 2) · 390×844 A 한 칸 ·
// 1280 소유자 아님 · 1280 결정 경로 없음 · 1280 긴 목록(600) · 1280 원문 펼침·무장.
// MOCKUP=<workspace-tab-mockups.html> 가 있으면 시안 ⑤ 스레드 카드와 나란히 놓는다.
//
// #3013 결정 상태(라이트·다크 × 1280·390): 결정 전 · 무장 · 확정(200) · 409 이미 결정 ·
// 409 닫힘 · 만료(630초) · 오프라인 잠금. 결정 라우트의 답은 흉내(`sceneActions`)다.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/agent-pane");
const PORT = Number(process.env.CAPTURE_PORT || 5196);
const MOCKUP = process.env.MOCKUP ?? "";
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const failures = [];
const report = { scenes: [], checks: [] };

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, scene, viewport = DESKTOP) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${origin}/#/design/local-terminal?scene=${scene}`);
  await page.getByTestId("my-work-tab").waitFor();
  await page.getByTestId("agent-pane").first().waitFor();
  return { context, page };
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  report.scenes.push(name);
}

/**
 * 권한 카드가 있는 칸의 자리(design-review R1·R2 B1): 카드 위로 진행 줄이 56px 이상,
 * 카드의 질문 줄과 모든 버튼이 칸 안에 보인다. 두 버튼 높이가 같다.
 */
async function permissionFit(page, paneId) {
  return page.evaluate((id) => {
    const root = document.querySelector(`[data-pane-id="${id}"]`);
    const pane = root.getBoundingClientRect();
    const scroll = root.querySelector(".agent-scroll").getBoundingClientRect();
    const card = root.querySelector('[data-testid="agent-permission"]');
    const cardBox = card.getBoundingClientRect();
    const head = card.querySelector(".agent-perm-l1").getBoundingClientRect();
    const firstBtn = card.querySelector("button")?.getBoundingClientRect();
    const btns = [...card.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    const within = (r) => r.top >= cardBox.top - 1 && r.bottom <= cardBox.bottom + 1 && r.top >= pane.top && r.bottom <= pane.bottom;
    const armBtns = [...card.querySelectorAll('[data-testid="agent-permission-allow"],[data-testid="agent-permission-reject"]')].map((b) => Math.round(b.getBoundingClientRect().height));
    // 일부러 접은 미리보기(거부 무장·낮은 칸)는 재지 않는다. 보이는 미리보기만 한 줄 이상이어야 한다.
    const preEl = card.querySelector('[data-testid="agent-permission-preview"]');
    const pre = preEl && getComputedStyle(preEl).display !== "none" ? preEl : null;
    const ta = card.querySelector('[data-testid="agent-permission-instruction"]');
    const bottomRow = card.querySelector(".agent-perm-sticky-bottom")?.getBoundingClientRect();
    let taClear = true;
    if (ta) {
      const r = ta.getBoundingClientRect();
      taClear = r.height >= 40 && (!bottomRow || r.bottom <= bottomRow.top + 1) && r.top >= head.bottom - 1;
    }
    return {
      previewLines: pre ? Math.floor(pre.clientHeight / parseFloat(getComputedStyle(pre).lineHeight)) : null,
      previewInView: pre ? pre.getBoundingClientRect().top >= head.bottom - 1 && pre.getBoundingClientRect().bottom <= (bottomRow?.top ?? cardBox.bottom) + 1 : null,
      textareaClear: taClear,
      feedVisible: Math.round(Math.min(scroll.bottom, cardBox.top) - scroll.top),
      headVisible: within(head) && (!firstBtn || head.bottom <= firstBtn.top + 1),
      buttonsVisible: btns.every(within),
      armHeights: armBtns,
    };
  }, paneId);
}

function fitOk(fit) {
  return (
    fit.feedVisible >= 56 &&
    fit.headVisible &&
    fit.buttonsVisible &&
    new Set(fit.armHeights).size <= 1 &&
    (fit.previewLines === null || (fit.previewLines >= 1 && fit.previewInView)) &&
    fit.textareaClear
  );
}

async function scenes(browser, origin) {
  for (const scheme of ["light", "dark"]) {
    {
      const { context, page } = await open(browser, origin, scheme, "agent-tab");
      const lanes = await page.$$eval('[data-testid="workbench-pane-lane"]', (els) => els.map((e) => e.getAttribute("data-lane")));
      check(`${scheme}/tab: 레인 표지(로컬 1, 에이전트 2)`, lanes.filter((l) => l === "agent").length === 2 && lanes.includes("local"), { lanes });
      const labels = await page.$$eval('[data-testid="workbench-pane"]', (els) => els.map((e) => e.getAttribute("aria-label")));
      check(`${scheme}/tab: A 칸 접근 이름에 「에이전트 · oort에 기록」`, labels.some((l) => l?.includes("에이전트 · oort에 기록")), { labels });
      const perm = await page.$$eval('[data-testid="agent-permission"]', (els) => els.length);
      check(`${scheme}/tab: 권한 카드 1(기다림 칸)`, perm === 1, { perm });
      const text = await page.textContent('[data-testid="agent-permission"]');
      check(`${scheme}/tab: 「항상 허용」 없음`, !/항상|Always/.test(text ?? ""), { text });
      check(`${scheme}/tab: 가로 넘침 0`, (await overflowX(page)) <= 0);
      const skipped = await page.textContent('[data-testid="agent-pane-skipped"]');
      check(`${scheme}/tab: 모르는 종류 한 줄 폴백`, skipped?.includes("1개") ?? false, { skipped });
      const waiting = await page.$$eval('[data-testid="workbench-pane"][data-waiting]', (els) => els.length);
      check(`${scheme}/tab: 기다림 칸 테두리·바닥 띠`, waiting === 1, { waiting });
      await shot(page, `agent-tab-1280-${scheme}`);

      const fit = await permissionFit(page, "p2");
      check(`${scheme}/tab 1280: 카드 위 진행 줄 56px+, 질문 줄·버튼 보임, 버튼 높이 같음`, fitOk(fit), fit);
      const strip = await page.$$eval('[data-pane-id="p2"] [data-testid="workbench-pane-waiting"]', (e) => e.length);
      check(`${scheme}/tab: A 칸은 바닥 띠 대신 카드`, strip === 0, { strip });

      // 거부 무장이 반 높이 칸에서 넘치지 않는다. 지시 입력 칸은 없다(#3013, R2 전 400).
      await page.getByTestId("agent-permission-reject").click();
      await page.getByTestId("agent-permission-confirm").waitFor();
      const ta = await page.$$eval('[data-testid="agent-permission"] textarea', (els) => els.length);
      check(`${scheme}/tab: 거부 무장에 지시 입력 칸 없음`, ta === 0, { ta });
      const rejectFit = await permissionFit(page, "p2");
      check(`${scheme}/tab 1280 거부 무장: 진행 줄·질문 줄·확정 버튼 보임`, fitOk(rejectFit), rejectFit);
      await shot(page, `agent-tab-1280-${scheme}-reject-armed`);
      await page.keyboard.press("Escape");

      // 원문 펼치기 + 허락 무장(두 번째 누름 전).
      await page.locator('[data-pane-id="p3"] [data-testid="agent-tool-card"] button').nth(2).click();
      await page.getByTestId("agent-tool-raw").waitFor();
      await page.getByTestId("agent-permission-allow").click();
      await page.getByTestId("agent-permission-confirm").waitFor();
      await shot(page, `agent-tab-1280-${scheme}-armed-raw`);
      await context.close();
    }
    {
      const { context, page } = await open(browser, origin, scheme, "agent-tab", { width: 900, height: 700 });
      check(`${scheme}/900: 가로 넘침 0`, (await overflowX(page)) <= 0);
      await shot(page, `agent-tab-900-${scheme}`);
      const fit900 = await permissionFit(page, "p2");
      // 낮은 칸(약 300): 요청을 다 보일 수 없으니 결정 버튼은 꺼지고 한 줄로 말한다.
      const cramped = await page.evaluate(() => {
        const card = document.querySelector('[data-pane-id="p2"] [data-testid="agent-permission"]');
        return {
          allowDisabled: card.querySelector('[data-testid="agent-permission-allow"]').disabled,
          rejectDisabled: card.querySelector('[data-testid="agent-permission-reject"]').disabled,
          line: card.querySelector('[data-testid="agent-permission-unavailable"]')?.textContent ?? null,
          lineInside: (() => {
            const el = card.querySelector('[data-testid="agent-permission-unavailable"]');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const c = card.getBoundingClientRect();
            return r.top >= c.top && r.bottom <= c.bottom && el.scrollWidth <= el.clientWidth + 1;
          })(),
        };
      });
      check(
        `${scheme}/900: 낮은 칸은 결정 버튼 꺼짐 + 칸 키우기 안내, 질문 줄·진행 줄 보임`,
        cramped.allowDisabled && cramped.rejectDisabled && (cramped.line ?? "").includes("칸을 키우면") && cramped.lineInside &&
          fit900.feedVisible >= 56 && fit900.headVisible && fit900.buttonsVisible,
        { ...cramped, ...fit900 }
      );
      await context.close();
    }
    {
      const { context, page } = await open(browser, origin, scheme, "agent-one", PHONE);
      check(`${scheme}/390: 가로 넘침 0`, (await overflowX(page)) <= 0);
      const buttons = await page.$$eval('[data-testid="agent-permission"] button', (els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { w: r.width, right: r.right };
        })
      );
      check(`${scheme}/390: 권한 버튼이 칸 안에`, buttons.every((b) => b.right <= 390), { buttons });
      const fit390 = await permissionFit(page, "p1");
      check(`${scheme}/390: 질문 줄·버튼 보임, 두 버튼 높이 같음`, fitOk(fit390), fit390);
      await shot(page, `agent-one-390-${scheme}`);
      await context.close();
    }
    for (const scene of ["observer", "unavailable"]) {
      const { context, page } = await open(browser, origin, scheme, `agent-${scene}`);
      if (scene === "observer") {
        const n = await page.$$eval('[data-testid="agent-permission"] button', (els) => els.length);
        check(`${scheme}/observer: 권한 버튼 0`, n === 0, { n });
        const raw = await page.$$eval('[data-testid="agent-tool-card"] button', (els) => els.length);
        check(`${scheme}/observer: 원문 보기 0`, raw === 0, { raw });
      } else {
        const disabled = await page.$eval('[data-testid="agent-permission-allow"]', (e) => e.disabled);
        check(`${scheme}/unavailable: 허락 버튼 보이되 꺼짐`, disabled === true);
      }
      await shot(page, `agent-${scene}-1280-${scheme}`);
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ viewport: DESKTOP, colorScheme: "light", reducedMotion: "reduce" });
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(`${origin}/#/design/local-terminal?scene=agent-long`);
    await page.getByTestId("agent-pane").waitFor();
    const cards = await page.$$eval('[data-testid="agent-tool-card"]', (els) => els.length);
    const ms = Date.now() - t0;
    check("long: 604 카드(고정 4 + 600)가 그려진다", cards === 604, { cards, ms });
    const scrollMs = await page.evaluate(async () => {
      const scroller = document.querySelector('[data-testid="agent-pane-feed"]').parentElement;
      const start = performance.now();
      for (let i = 0; i < 20; i += 1) {
        scroller.scrollTop = (scroller.scrollHeight / 20) * i;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return performance.now() - start;
    });
    check("long: 스크롤 20 프레임 1초 안", scrollMs < 1000, { scrollMs: Math.round(scrollMs) });
    await shot(page, "agent-long-1280-light");
    await context.close();
  }
}

/** 무장 → 400ms 가드 → 확정. */
async function commitAllow(page) {
  await page.getByTestId("agent-permission-allow").click();
  await page.getByTestId("agent-permission-confirm").waitFor();
  await page.waitForTimeout(450);
  await page.getByTestId("agent-permission-commit").click();
  await page.getByTestId("agent-permission-outcome").waitFor();
}

async function decisionScenes(browser, origin) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["1280", DESKTOP], ["390", PHONE]]) {
      const tag = `${label}-${scheme}`;
      {
        const { context, page } = await open(browser, origin, scheme, "agent-decided", viewport);
        const allow = await page.$eval('[data-testid="agent-permission-allow"]', (e) => !e.disabled);
        check(`${tag}/결정 전: 허락 버튼 켜짐`, allow);
        await shot(page, `decision-before-${tag}`);
        await page.getByTestId("agent-permission-allow").click();
        await page.getByTestId("agent-permission-confirm").waitFor();
        await shot(page, `decision-armed-${tag}`);
        await page.waitForTimeout(450);
        await page.getByTestId("agent-permission-commit").click();
        await page.getByTestId("agent-permission-outcome").waitFor();
        const text = await page.textContent('[data-testid="agent-permission-outcome"]');
        const buttons = await page.$$eval('[data-testid="agent-permission"] button', (els) => els.length);
        check(`${tag}/확정: 보냄 한 줄, 버튼 0`, (text ?? "").includes("허락을 보냈어요") && buttons === 0, { text, buttons });
        check(`${tag}/확정: 가로 넘침 0`, (await overflowX(page)) <= 0);
        await shot(page, `decision-sent-${tag}`);
        await context.close();
      }
      for (const [scene, needle] of [["conflict", "이미 다른 결정"], ["closed", "이미 닫혔어요"]]) {
        const { context, page } = await open(browser, origin, scheme, `agent-${scene}`, viewport);
        await commitAllow(page);
        const text = await page.textContent('[data-testid="agent-permission-outcome"]');
        const buttons = await page.$$eval('[data-testid="agent-permission"] button', (els) => els.length);
        check(`${tag}/409 ${scene}: 「${needle}」, 버튼 0`, (text ?? "").includes(needle) && buttons === 0, { text, buttons });
        await shot(page, `decision-409-${scene}-${tag}`);
        await context.close();
      }
      {
        const { context, page } = await open(browser, origin, scheme, "agent-lapsed", viewport);
        const text = await page.textContent('[data-testid="agent-permission-outcome"]');
        const buttons = await page.$$eval('[data-testid="agent-permission"] button', (els) => els.length);
        check(`${tag}/만료: 닫힘 한 줄, 버튼 0`, (text ?? "").includes("요청은 닫혔어요") && buttons === 0, { text, buttons });
        await shot(page, `decision-lapsed-${tag}`);
        await context.close();
      }
      {
        // #3029: 일반 브라우저 + 서명 요구 서버. 허락과 답장 칸이 같은 판정으로 안내가 되고, 거부는 켜져 있다.
        const { context, page } = await open(browser, origin, scheme, "agent-browser", viewport);
        const state = await page.evaluate(() => ({
          allow: document.querySelector('[data-testid="agent-permission-allow"]').disabled,
          reject: document.querySelector('[data-testid="agent-permission-reject"]').disabled,
          line: document.querySelector('[data-testid="agent-permission-in-app"]')?.textContent ?? null,
          input: document.querySelector('[data-testid="agent-pane-reply-input"]')?.disabled ?? null,
          hint: document.querySelector('[data-testid="agent-pane-reply-hint"]')?.hasAttribute("data-in-app") ?? false,
        }));
        check(
          `${tag}/브라우저: 허락 꺼짐 + 앱 안내, 거부 켜짐, 답장 칸도 안내`,
          state.allow && !state.reject && (state.line ?? "").includes("폰이나 데스크탑 앱에서") && state.input === true && state.hint,
          state
        );
        check(`${tag}/브라우저: 가로 넘침 0`, (await overflowX(page)) <= 0);
        await shot(page, `browser-in-app-${tag}`);
        await context.close();
      }
      {
        const { context, page } = await open(browser, origin, scheme, "agent-signature", viewport);
        await page.getByTestId("agent-permission-allow").click();
        await page.getByTestId("agent-permission-confirm").waitFor();
        await page.waitForTimeout(450);
        await page.getByTestId("agent-permission-commit").click();
        await page.getByTestId("agent-permission-error").waitFor();
        const text = await page.textContent('[data-testid="agent-permission-error"]');
        check(`${tag}/서명 필요: 앱 안내 문장, 「소유자만」 아님`, (text ?? "").includes("기기 서명") && !(text ?? "").includes("소유자만"), { text });
        await shot(page, `signature-required-${tag}`);
        // 제품처럼 플래그를 다시 읽은 뒤: 무장 풀림, 오류 줄 대신 안내 한 줄, 거부 켜짐(review M1).
        await page.getByTestId("agent-permission-in-app").waitFor();
        const after = await page.evaluate(() => ({
          confirm: document.querySelectorAll('[data-testid="agent-permission-confirm"]').length,
          error: document.querySelectorAll('[data-testid="agent-permission-error"]').length,
          reject: document.querySelector('[data-testid="agent-permission-reject"]')?.disabled ?? null,
          focusOnCard: document.activeElement?.getAttribute("data-testid") === "agent-permission",
        }));
        check(
          `${tag}/서명 필요 뒤: 무장 0, 오류 줄 0, 거부 켜짐, 캐럿은 카드`,
          after.confirm === 0 && after.error === 0 && after.reject === false && after.focusOnCard,
          after
        );
        await shot(page, `signature-required-after-${tag}`);
        await context.close();
      }
      {
        const { context, page } = await open(browser, origin, scheme, "agent-offline", viewport);
        const state = await page.evaluate(() => ({
          allow: document.querySelector('[data-testid="agent-permission-allow"]').disabled,
          reject: document.querySelector('[data-testid="agent-permission-reject"]').disabled,
          line: document.querySelector('[data-testid="agent-permission-unavailable"]')?.textContent ?? null,
        }));
        check(`${tag}/오프라인: 두 버튼 잠김 + 이유 한 줄`, state.allow && state.reject && (state.line ?? "").includes("연결이 끊겨"), state);
        await shot(page, `decision-offline-${tag}`);
        await context.close();
      }
    }
  }
}

// #3028 R2-E8: 데스크탑 셸이 서명하는 칸(라이트·다크 × 1280·390). 셸·서버 왕복은 흉내다.
async function signedScenes(browser, origin) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["1280", DESKTOP], ["390", PHONE]]) {
      const tag = `${label}-${scheme}`;
      {
        const { context, page } = await open(browser, origin, scheme, "agent-signed", viewport);
        const state = await page.evaluate(() => ({
          once: !document.querySelector('[data-testid="agent-permission-allow"]').disabled,
          session: !document.querySelector('[data-testid="agent-permission-allow-session"]')?.disabled,
          input: !document.querySelector('[data-testid="agent-pane-reply-input"]').disabled,
        }));
        check(`${tag}/서명 칸: 이번 한 번·이 세션 동안·지시 칸 켜짐`, state.once && state.session && state.input, state);
        check(`${tag}/서명 칸: 가로 넘침 0`, (await overflowX(page)) <= 0);
        await shot(page, `signed-before-${tag}`);
        await page.getByTestId("agent-permission-reject").click();
        await page.getByTestId("agent-permission-reject-note").fill("그 파일 말고 테스트만 고쳐 줘");
        const label = await page.textContent('[data-testid="agent-permission-commit"]');
        check(`${tag}/거부 + 지시: 확정 버튼 「거부하고 지시 보내기」`, label === "거부하고 지시 보내기", { label });
        check(`${tag}/거부 + 지시: 가로 넘침 0`, (await overflowX(page)) <= 0);
        await shot(page, `signed-reject-note-${tag}`);
        await page.getByRole("button", { name: "취소" }).click();
        await page.getByTestId("agent-permission-allow-session").click();
        await page.getByTestId("agent-permission-confirm").waitFor();
        await shot(page, `signed-session-armed-${tag}`);
        await page.waitForTimeout(450);
        await page.getByTestId("agent-permission-commit").click();
        await page.getByTestId("agent-permission-outcome").waitFor();
        const text = await page.textContent('[data-testid="agent-permission-outcome"]');
        check(`${tag}/이 세션 동안: 보냄 한 줄`, (text ?? "").includes("이 세션 동안 허락을 보냈어요"), { text });
        await shot(page, `signed-session-sent-${tag}`);
        await context.close();
      }
      {
        const { context, page } = await open(browser, origin, scheme, "agent-signed-fail", viewport);
        await page.getByTestId("agent-pane-reply-input").fill("이어서 lint까지 돌려 줘");
        await page.getByTestId("agent-pane-queue").click();
        await page.locator('[data-testid="agent-pane-reply-hint"][data-failed]').waitFor();
        const hint = await page.textContent('[data-testid="agent-pane-reply-hint"]');
        const kept = await page.inputValue('[data-testid="agent-pane-reply-input"]');
        check(`${tag}/지시 전달 안 됨: 사유 + 글 남음`, (hint ?? "").startsWith("전달 안 됨") && kept.length > 0, { hint, kept });
        await shot(page, `signed-reply-not-delivered-${tag}`);
        await context.close();
      }
      {
        // 장면을 섞지 않는다(design-review): 새 칸에서 「거부 + 지시」만.
        const { context, page } = await open(browser, origin, scheme, "agent-signed-fail", viewport);
        await page.getByTestId("agent-permission-reject").click();
        const caret = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
        check(`${tag}/거부 무장: 캐럿은 지시 칸`, caret === "agent-permission-reject-note", { caret });
        await page.getByTestId("agent-permission-reject-note").fill("다르게 해 줘");
        await page.waitForTimeout(450);
        await page.getByTestId("agent-permission-commit").click();
        await page.getByTestId("agent-permission-outcome").waitFor();
        const text = await page.textContent('[data-testid="agent-permission-outcome"]');
        const settled = await page.getAttribute('[data-testid="agent-permission"]', "data-settled");
        const moved = await page.inputValue('[data-testid="agent-pane-reply-input"]');
        check(`${tag}/거부 갔고 지시 전달 안 됨: 둘 다 말함, 글은 지시 칸으로`, settled === "partial" && (text ?? "").includes("전달 안 됨") && moved === "다르게 해 줘", { text, settled, moved });
        check(`${tag}/실패 장면: 가로 넘침 0`, (await overflowX(page)) <= 0);
        await shot(page, `signed-partial-${tag}`);
        await context.close();
      }
    }
  }
}

async function compare(browser) {
  if (!MOCKUP || !existsSync(MOCKUP)) {
    console.log("MOCKUP 없음: 비교 이미지는 건너뛴다");
    return;
  }
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(pathToFileURL(MOCKUP).href, { waitUntil: "load" });
    if (scheme === "dark") await page.evaluate(() => document.querySelector("#d5")?.classList.add("dark"));
    const panel = page.locator("#d5 aside.tpanel");
    await panel.scrollIntoViewIfNeeded();
    const mock = await panel.screenshot();
    const impl = readFileSync(resolve(OUT_DIR, `agent-tab-1280-${scheme}.png`));
    const bg = scheme === "dark" ? "#111214" : "#e8e8eb";
    const fg = scheme === "dark" ? "#ededf0" : "#18181b";
    const html = `<!doctype html><html><body style="margin:0;background:${bg};font:14px -apple-system,sans-serif;color:${fg}">
      <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
        <figure style="margin:0"><figcaption style="margin-bottom:8px">시안 ⑤ 스레드 root 카드 (${scheme})</figcaption>
          <img style="width:420px" src="data:image/png;base64,${mock.toString("base64")}"></figure>
        <figure style="margin:0"><figcaption style="margin-bottom:8px">구현 #2779 「내 작업」 A 칸 (${scheme})</figcaption>
          <img style="width:1100px" src="data:image/png;base64,${impl.toString("base64")}"></figure>
      </div></body></html>`;
    const sheet = await context.newPage();
    await sheet.setContent(html, { waitUntil: "load" });
    await sheet.screenshot({ path: resolve(OUT_DIR, `compare-agent-pane-${scheme}.png`), fullPage: true });
    report.scenes.push(`compare-agent-pane-${scheme}`);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ 가 없다. npm run capture:agent-pane 으로 build:design 부터 돌린다.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      if (process.env.ONLY === "signed") {
        await signedScenes(browser, preview.origin);
      } else {
        if (process.env.ONLY !== "decision") await scenes(browser, preview.origin);
        await decisionScenes(browser, preview.origin);
        await signedScenes(browser, preview.origin);
      }
      if (process.env.ONLY !== "decision" && process.env.ONLY !== "signed") await compare(browser);
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
