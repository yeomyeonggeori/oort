#!/usr/bin/env node
// =============================================================================
// 의사 언어 캡처 레인 (#5589, ADR-0213 §4).
//
// design 빌드(`--mode design`)를 가짜 `/v1` 위에 띄우고 `?pseudo=1`로 의사 언어(en-XA)를 켠 채 대표 화면을 찍는다
// (밝게, 1280×860). 사전에서 온 글은 모두 `[`…`]`로 감싸이고 악센트가 붙어 약 35% 길어진다. 그래서 화면에 보이는 글 중
// 대괄호가 없는 글은 사전을 거치지 않은 글이다. 화면마다 보이는 글(텍스트 + aria-label·placeholder·title·alt)을 셋으로 센다:
//   dictionary  통째로 `[`…`]`인 글 — 사전에서 왔다
//   mixed       `[`…`]` 조각에 다른 글이 붙은 글 — 사전 출력을 이어 붙였다(문장 조각 잇기)
//   direct      대괄호가 없는 글 — 사전 밖. 가짜 서버가 넣은 데이터(이름·채널·본문)는 fixture로 따로 센다
// 넘침·잘림은 찍힌 그림으로 본다(이 레인은 판정하지 않고 수와 그림을 남긴다).
//
//   npm run build:design && OUT_DIR=/절대/경로 node scripts/capture-pseudo.mjs
//   PSEUDO_CAPTURE_DIST=/절대/경로/dist-design OUT_DIR=/절대/경로 node scripts/capture-pseudo.mjs   (이미 만든 design 번들)
//
// 출시 빌드(`npm run build`)에는 의사 언어가 없다 — 이 레인을 그 번들에 먹이면 dictionary 0으로 실패한다.
// 자격 증명은 없다: `/v1`은 `gates/connection-harness.mjs`의 픽스처로만 답하고, 사람 이름은 아래 예시 이름으로 바꾼다.
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import { CHANNELS, ME, TIMELINE, WORKSPACE_ID, installBackend, openGeneral } from "../gates/connection-harness.mjs";
import { withCaptureLocale } from "./capture-locale.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PSEUDO_CAPTURE_PORT || 21615);
const distEnv = process.env.PSEUDO_CAPTURE_DIST || "";
const dist = distEnv ? (isAbsolute(distEnv) ? distEnv : resolve(webRoot, distEnv)) : resolve(webRoot, "dist");
const outDir = resolve(process.env.OUT_DIR || resolve(webRoot, "artifacts/pseudo"));

// 예시 사람들(실명 아님). 메시지 작성자 ID는 하네스의 것과 같아야 이름이 붙는다.
const PEER = "019F94E3-7B0F-7A22-9C13-4D5E6F708192";
const AGENT = "019F94E3-8B21-7AE0-B3C4-5F1A2D6E7C90";
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId: WORKSPACE_ID, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CHANNELS[0].id], capabilities: [], createdAtMs: 1_750_000_000_000, updatedAtMs: 1_750_000_000_000, ...extra,
});
const ROSTER = [
  person(ME, "human", "예시 사용자", "sample-user", { role: "owner" }),
  person(PEER, "human", "예시 동료", "sample-peer", { role: "member" }),
  person(AGENT, "agent", "코메토", "kometto", { ownerHumanId: ME, agentModel: "claude-opus-5" }),
];
const FIXTURE_TEXT = new Set([
  ...CHANNELS.map((channel) => channel.name),
  ...ROSTER.flatMap((member) => [member.displayName, `@${member.handle}`, member.handle]),
  ...TIMELINE.flatMap((message) => [message.body, message.props?.title, ...(message.props?.action?.rows ?? []).flatMap((row) => [row.label, row.value])]),
].filter(Boolean));

const SCREENS = [
  { name: "01-d0-welcome", note: "로그인 전 첫 화면(서버 고르기)" },
  { name: "02-d1-sign-in", note: "로그인" },
  { name: "03-channel", note: "채널 대화(general)" },
  { name: "04-inbox", hash: "#/inbox", note: "받은함" },
  { name: "05-settings-profile", hash: "#/settings", note: "설정 › 프로필(언어 행)" },
  // 「What's new」 목차는 사전 문구라 의사 언어로 찾는다(영어 사전 원문이 바뀌면 이 표지도 바뀐다).
  { name: "06-settings-whats-new", click: /^\[Ŵĥáţ.š~* ñéŵ/u, note: "설정 › 새 소식(업데이트 소식)" },
];

/** In the page: every visible string a person can read or hear. */
function visibleStrings() {
  const shown = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    if (box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    const parent = node.parentElement;
    if (!text || !/\p{L}/u.test(text) || !parent || parent.closest("script, style, noscript, template")) continue;
    if (shown(parent)) out.push({ kind: "text", text });
  }
  for (const element of document.querySelectorAll("[aria-label], [placeholder], [title], img[alt]")) {
    if (!shown(element)) continue;
    for (const name of ["aria-label", "placeholder", "title", "alt"]) {
      const value = element.getAttribute(name)?.replace(/\s+/g, " ").trim();
      if (value && /\p{L}/u.test(value)) out.push({ kind: name, text: value });
    }
  }
  return out;
}

const PSEUDO_WHOLE = /^\[[^[\]]*\]$/u;
const PSEUDO_PART = /\[[^[\]]*[À-ɏḀ-ỿ~][^[\]]*\]/u;
function classify(entry) {
  if (PSEUDO_WHOLE.test(entry.text)) return "dictionary";
  if (PSEUDO_PART.test(entry.text)) return "mixed";
  if (FIXTURE_TEXT.has(entry.text)) return "fixture";
  return "direct";
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot, port, portEnvVar: "PSEUDO_CAPTURE_PORT", extraArgs: distEnv ? ["--outDir", dist] : [],
  });
  const origin = preview.origin;
  let browser;
  const report = { origin, builtFrom: dist, capturedAt: new Date().toISOString(), screens: [] };
  try {
    browser = await chromium.launch();
    const context = await browser.newContext(withCaptureLocale({
      viewport: { width: 1280, height: 860 }, colorScheme: "light", reducedMotion: "reduce",
    }));
    await installBackend(context, port);
    // 하네스의 사람 이름 대신 예시 이름(나중에 건 길이 먼저 답한다).
    await context.route("**/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const reply = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (path.endsWith("/auth/login")) {
        return reply({
          accessToken: "gate-only-not-a-credential", refreshToken: "gate-only-not-a-credential",
          member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "예시 사용자", handle: "sample-user" },
          realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
        });
      }
      if (/\/workspaces\/[^/]+\/roster$/.test(path)) return reply({ members: ROSTER });
      return route.fallback();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error.message ?? error)));

    for (const screen of SCREENS) {
      if (screen.name === "01-d0-welcome") {
        await page.goto(`${origin}/?pseudo=1`, { waitUntil: "networkidle" });
        await page.locator('[data-testid="onboarding-welcome"], [data-testid="onboarding-sign-in"]').first().waitFor();
      } else if (screen.name === "02-d1-sign-in") {
        await advanceToAccount(page);
      } else if (screen.name === "03-channel") {
        await page.getByTestId("login-email").fill("sample@dawn.example");
        await page.getByTestId("login-password").fill("gate-only-not-a-credential");
        await page.getByTestId("login-submit").click();
        await page.getByTestId("channel-list").waitFor({ state: "visible", timeout: 20_000 });
        await openGeneral(page);
      } else if (screen.click) {
        await page.getByText(screen.click).first().click();
      } else {
        // 앱은 해시 경로다. 같은 문서 안에서 옮겨 의사 언어·로그인 상태를 그대로 둔다.
        await page.evaluate((hash) => { window.location.hash = hash; }, screen.hash);
      }
      await settle(page);
      const shot = resolve(outDir, `${screen.name}.png`);
      await page.screenshot({ path: shot });
      const lang = await page.evaluate(() => document.documentElement.lang);
      const strings = await page.evaluate(visibleStrings);
      const counts = { total: strings.length, dictionary: 0, mixed: 0, direct: 0, directHangul: 0, fixture: 0 };
      const direct = new Map();
      for (const entry of strings) {
        const kind = classify(entry);
        counts[kind] += 1;
        if (kind === "direct") {
          if (/[가-힯]/u.test(entry.text)) counts.directHangul += 1;
          direct.set(entry.text, (direct.get(entry.text) ?? 0) + 1);
        }
      }
      report.screens.push({
        ...screen, shot, lang, url: page.url(), counts,
        mixedSamples: strings.filter((entry) => classify(entry) === "mixed").slice(0, 10).map((entry) => entry.text),
        directSamples: [...direct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([text, n]) => `${n}× ${text}`),
      });
      console.log(`${screen.name.padEnd(22)} lang=${lang} total=${counts.total} dictionary=${counts.dictionary} `
        + `mixed=${counts.mixed} direct=${counts.direct} (hangul ${counts.directHangul}) fixture=${counts.fixture}`);
    }
    report.pageErrors = errors;
    writeFileSync(resolve(outDir, "pseudo-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const dictionary = report.screens.reduce((sum, screen) => sum + screen.counts.dictionary, 0);
    if (!dictionary) throw new Error("no pseudo-marked text at all: this bundle has no pseudo locale (a release build?)");
  } finally {
    await browser?.close();
    await preview.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
