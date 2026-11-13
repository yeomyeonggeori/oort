#!/usr/bin/env node
// =============================================================================
// 내려받기 페이지의 앱 화면 (#5562): 지금의 웹 클라이언트를 가상 인물로 찍는다.
//
//   npm --prefix clients/web ci && npm --prefix clients/web run build
//   CAPTURE_PORT=21401 node clients/site/scripts/capture-app.mjs
//   -> clients/site/assets/app-{ko,en}-{light,dark}.webp + app-shots.json
//
// 백엔드는 없다: `/v1/**` 는 이 파일 안의 고정 응답이고 소켓은 구독만 받는다. 앱은 지금 한국어·영어만
// 있으므로 ko 화면과 en 화면 두 벌이다(다른 언어 페이지는 en 화면을 쓴다). 인물·회사·대화는 전부 가상이고
// (이도현·최민수·박서연, 회사 「달무리 스튜디오」, 에이전트 코메토), 서버 주소·실제 대화는 넣지 않는다.
// =============================================================================

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = resolve(SITE, "../web");
const require = createRequire(resolve(WEB, "package.json"));
const { chromium } = require("playwright");
const { startGuardedPreview } = await import(resolve(WEB, "gates/preview-guard.mjs"));
const { advanceToAccount } = await import(resolve(WEB, "e2e/advanceOnboarding.mjs"));

const OUT = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(SITE, "assets");
const PORT = Number(process.env.CAPTURE_PORT || 21401);
const VIEW = { width: 1200, height: 760 };
const WIDTH = 1600; // 결과 그림의 가로(픽셀). 페이지 틀이 1130 CSS px 까지라 레티나에서도 충분하다.
const QUALITY = Number(process.env.WEBP_QUALITY || 0.82);
const MIN = 60_000;

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const MINSU = "00000000-0000-7000-8000-000000000102";
const SEOYEON = "00000000-0000-7000-8000-000000000103";
const KOMETTO = "00000000-0000-7000-8000-000000000401";
const REL = "00000000-0000-7000-8000-000000000201";
const PLAN = "00000000-0000-7000-8000-000000000202";
const DESIGN = "00000000-0000-7000-8000-000000000203";
const GENERAL = "00000000-0000-7000-8000-000000000204";
const NOW = Date.now();
// 어제 대화는 서울 달력의 어제 저녁에 둔다(캡처하는 시각과 상관없이 「어제」 구분선 아래에 선다).
const KST = 9 * 3_600_000;
const YESTERDAY_KST = Math.floor((NOW + KST) / 86_400_000) * 86_400_000 - KST - 86_400_000;
const agoAt = (hh, mm) => Math.round((NOW - (YESTERDAY_KST + (hh * 60 + mm) * MIN)) / MIN);

const COPY = {
  ko: {
    locale: "ko-KR",
    workspace: "달무리 스튜디오",
    names: { [ME]: "이도현", [MINSU]: "최민수", [SEOYEON]: "박서연", [KOMETTO]: "코메토" },
    channels: { [REL]: "릴리스", [PLAN]: "계획", [DESIGN]: "design", [GENERAL]: "general" },
    before: [
      [SEOYEON, agoAt(18, 12), "내일 배포 노트 초안 올려 뒀어요. 빠진 항목 있으면 알려 주세요."],
      [ME, agoAt(18, 20), "좋아요, 내일 오전에 같이 봐요."],
    ],
    lines: [
      [ME, 52, "@kometto 스테이징 로그랑 마이그레이션 상태를 정리해 줄래요?"],
      [KOMETTO, 51, "네, 지금 볼게요. 스테이징 로그부터 훑고 마이그레이션 상태를 확인할게요."],
      [KOMETTO, 42, "정리했어요. 마이그레이션은 전부 적용됐고, 결제 화면 오류가 한 건 남아 있어요. 점검 이야기는 따로 모아 두는 게 좋겠어서 채널 하나를 제안할게요."],
    ],
    approval: {
      title: "채널 만들기",
      summary: "코메토가 제안했어요. 승인하면 관리자 권한으로 채널을 만들어요.",
      rows: [["채널", "#배포-점검"], ["공개 범위", "비공개"], ["주제", "내일 오전 배포 점검"]],
      rationale: "점검 이야기를 한곳에 모아 두면 좋겠다고 하셔서",
    },
    after: [MINSU, 36, "결제 오류는 제가 볼게요. 채널은 도현 님이 승인해 주세요."],
  },
  en: {
    locale: "en-US",
    workspace: "Dalmuri Studio",
    names: { [ME]: "Dohyun Lee", [MINSU]: "Minsu Choi", [SEOYEON]: "Seoyeon Park", [KOMETTO]: "Kometto" },
    channels: { [REL]: "release", [PLAN]: "planning", [DESIGN]: "design", [GENERAL]: "general" },
    before: [
      [SEOYEON, agoAt(18, 12), "The draft release notes for tomorrow are up. Tell me if anything is missing."],
      [ME, agoAt(18, 20), "Great, let's go through them together in the morning."],
    ],
    lines: [
      [ME, 52, "@kometto can you pull together the staging logs and where the migrations stand?"],
      [KOMETTO, 51, "On it. I'll skim the staging logs first, then check the migrations."],
      [KOMETTO, 42, "Done. Every migration is applied, and one checkout page error is still open. The release check deserves its own place, so I'm proposing a channel."],
    ],
    approval: {
      title: "Create channel",
      summary: "Kometto proposed this. Approving creates the channel with admin rights.",
      rows: [["Channel", "#release-check"], ["Visibility", "Private"], ["Topic", "Tomorrow morning's release check"]],
      rationale: "You asked to keep the release check talk in one place",
    },
    after: [MINSU, 36, "I'll take the checkout error. Dohyun, could you approve the channel?"],
  },
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function fixture(lang) {
  const c = COPY[lang];
  const person = (id, kind, handle, extra = {}) => ({
    id, workspaceId: WS, kind, status: "active", displayName: c.names[id], handle, role: "member",
    channelCount: 4, channelIds: [REL, PLAN, DESIGN, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
  });
  const roster = [
    person(ME, "human", "dohyun", { role: "owner" }),
    person(MINSU, "human", "minsu"),
    person(SEOYEON, "human", "seoyeon"),
    person(KOMETTO, "agent", "kometto", { ownerMemberId: ME, capabilities: ["code"] }),
  ];
  const channels = [REL, PLAN, DESIGN, GENERAL].map((id) => ({ id, workspaceId: WS, kind: "public", name: c.channels[id], muted: false }));
  let seq = 400;
  const row = (author, minAgo, body, extra = {}) => {
    seq += 1;
    const at = NOW - minAgo * MIN;
    return {
      id: `00000000-0000-7000-8000-0000000a${String(seq).padStart(4, "0")}`, channelId: REL, seq, hlcTs: at, hlcCount: 0,
      authorMemberId: author, type: "text", body, state: "sent", createdAtMs: at, ...extra,
    };
  };
  const messages = [...c.before, ...c.lines].map(([author, ago, body]) => row(author, ago, body));
  messages.push(row(KOMETTO, 42, c.approval.title, {
    type: "approval_request",
    props: {
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      channel_id: REL,
      action_type: "workspace_action",
      status: "pending",
      expires_at_ms: NOW + 3 * 3_600_000,
      title: c.approval.title,
      summary: c.approval.summary,
      action: {
        id: "channel.create",
        rows: c.approval.rows.map(([label, value]) => ({ label, value })),
        rationale: c.approval.rationale,
        required_role: "admin",
      },
    },
  }));
  messages.push(row(...c.after));
  const latest = seq;
  const auth = {
    accessToken: "capture-only-not-a-credential",
    refreshToken: "capture-only-not-a-credential",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: c.names[ME], handle: "dohyun" },
    realtimeWebSocketUrl: "ws://capture-site.invalid/connection/websocket",
  };
  const readStates = channels.map((ch) => ({
    channel_id: ch.id, last_read_seq: ch.id === PLAN ? latest - 2 : latest, latest_seq: latest,
    unread_count: ch.id === PLAN ? 2 : 0, mention_count: 0, marked_unread_before_seq: null,
  }));
  return { c, roster, channels, messages, auth, readStates };
}

async function installMocks(context, fx) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, fx.auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: fx.auth.accessToken, refreshToken: fx.auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: NOW + 600_000, ttlSeconds: 60, workspaceId: WS, memberId: ME });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (/\/channels\/[^/]+\/read-state$/.test(path)) return json(route, fx.readStates[0]);
    if (path.endsWith("/read-state")) return json(route, { read_states: fx.readStates });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: fx.channels });
    if (path.endsWith("/roster")) return json(route, { members: fx.roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${WS}`)) return json(route, { workspace: { id: WS, name: fx.c.workspace } });
    if (path.includes(`/channels/${REL}/messages`)) return json(route, { messages: fx.messages });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "capture-site", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

/** PNG 를 같은 브라우저에서 줄이고 WebP 로 바꾼다(추가 도구 없음). */
async function toWebp(page, png) {
  return page.evaluate(async ({ b64, width, quality }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const height = Math.round((img.naturalHeight * width) / img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    const url = canvas.toDataURL("image/webp", quality);
    if (!url.startsWith("data:image/webp")) throw new Error("this browser cannot encode WebP");
    return { data: url.slice(url.indexOf(",") + 1), width, height };
  }, { b64: png.toString("base64"), width: WIDTH, quality: QUALITY });
}

async function shoot(browser, origin, lang, scheme) {
  const fx = fixture(lang);
  const context = await browser.newContext({
    viewport: VIEW, deviceScaleFactor: 2, colorScheme: scheme, locale: fx.c.locale,
    timezoneId: "Asia/Seoul", serviceWorkers: "block", reducedMotion: "reduce",
  });
  await installMocks(context, fx);
  // 앱 언어는 저장된 선택이 먼저다(clients/web/src/i18n/localeStore.ts). 캡처는 언어를 못 박는다.
  await context.addInitScript(({ base, locale }) => {
    try {
      localStorage.setItem("momo.web.server.v1", base);
      localStorage.setItem("oort.locale.preference", locale);
    } catch { /* 저장소 없는 캡처 */ }
  }, { base: origin, locale: fx.c.locale });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("dohyun@dalmuri.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, `/c/${REL}`);
  await page.getByTestId("composer").waitFor({ timeout: 20_000 });
  await page.getByTestId("agent-card").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(VIEW.width - 4, 4);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.waitForTimeout(600);
  const png = await page.screenshot();
  const webp = await toWebp(page, png);
  const file = resolve(OUT, `app-${lang}-${scheme}.webp`);
  writeFileSync(file, Buffer.from(webp.data, "base64"));
  await context.close();
  if (errors.length) throw new Error(`${lang}-${scheme}: page errors\n${errors.join("\n")}`);
  console.log(`${file}  ${webp.width}x${webp.height}`);
  return { width: webp.width, height: webp.height };
}

const preview = await startGuardedPreview({ webRoot: WEB, port: PORT, portEnvVar: "CAPTURE_PORT" });
try {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  let size = null;
  try {
    for (const lang of ["ko", "en"]) {
      for (const scheme of ["light", "dark"]) {
        size = await shoot(browser, preview.origin, lang, scheme);
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(resolve(OUT, "app-shots.json"), JSON.stringify(size) + "\n");
} finally {
  await preview.stop();
}
