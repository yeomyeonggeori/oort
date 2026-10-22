#!/usr/bin/env node
// =============================================================================
// 배경화면(웹·데스크탑) 캡처와 실제 앱 위의 단정 (AP-4 #4191, ADR-0189 증보 3 D4).
//
//   npm run build
//   MODE=capture LABEL=after  DIST=dist node scripts/capture-4191.mjs     # 장면 캡처 + meta.json
//   MODE=capture LABEL=before DIST=<base 빌드> node scripts/capture-4191.mjs  # 같은 화면의 「전」
//   MODE=assert  DIST=dist node scripts/capture-4191.mjs                  # 실제 앱에서 단정(아래)
//   MODE=assert  SABOTAGE=scrim|band DIST=dist node scripts/capture-4191.mjs   # ⑥이 실제로 실패할 수 있음을 보이는 사보타주(아래)
//
// capture: 모양 설정과 대화 화면을 라이트/다크 × 1440/900으로 찍는다. 고르는 일은 전부 **설정 화면의 진짜 컨트롤**을
// 눌러서 한다(단색·기본 제공의 칩, 사진은 `setInputFiles`로 진짜 파일 선택 경로). 시드로 상태를 박지 않는다.
//
// assert: 아래를 진짜 번들·진짜 Chromium에서 단정하고 하나라도 어긋나면 exit 1이다.
//   ① 사진: 위치 태그가 든 JPEG를 고르면 IndexedDB에 저장된 바이트에 EXIF가 없고(전제: 입력에는 있다), 회전이 굽혀
//      있고, 긴 변 ≤ 2560, 1.5MB 이하다. 거대한 잡음 사진은 계단을 내려가 상한 안에 든다.
//   ② 새로고침 뒤에도 사진·선택이 유지된다.
//   ③ 로그아웃하면 IndexedDB의 사진이 지워지고 외양 레코드의 사진 참조와 루트 속성이 걷힌다(단색은 남는다).
//   ④ 네트워크: 사진을 고르고 적용하는 동안 바깥으로 나간 요청이 없다(본문 있는 요청 0, 다른 오리진 0).
//   ⑤ CSP: Tauri 셸의 정책(`tauri.conf.json`)을 그대로 붙인 번들에서도 사진 배경이 서고 위반 이벤트가 0이다.
//   ⑥ 읽힘: 순흑 사진·순백 사진 위에서 펼친·접은 사이드바·상단 줄과 설정 목록 열의 글자(4.5:1)와 아이콘(3:1)이 실제 렌더
//      픽셀 위에서 지켜진다(바탕은 글자를 투명하게 한 같은 장면에서 읽는다: `scripts/lib/legibility.mjs`). 새벽 하늘·흑연은
//      절대 기준이고, 띠가 있는 노을띠는 열의 호스트가 불투명한 띠라 「배경화면 없음」과 짝지어 나빠지지 않았는지를 잰다.
//   ⑦ 접근성: 대비 높이기·투명도 줄이기가 켜지면 그림이 서지 않고 선택은 남는다.
//
// 백엔드 없이 `/v1/**` 고정 응답 + 가짜 소켓. 벽시계·로케일·시간대를 고정한다.
// =============================================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import { exifSegment, injectExif, inspectJpeg } from "./lib/jpegExif.mjs";
import { measureLegibility } from "./lib/legibility.mjs";

const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.env.WEB_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.env.MODE || "capture";
const LABEL = process.env.LABEL || "after";
const DIST = process.env.DIST || "dist";
const OUT_ROOT = process.env.OUT_ROOT
  ? resolve(process.env.OUT_ROOT)
  : resolve(WEB_ROOT, "artifacts/ap4-4191");
const PORT = Number(process.env.CAPTURE_PORT || 5391);
// 데스크탑 앱은 macOS의 WKWebView(WebKit)이다. ENGINE=webkit 이면 같은 장면·단정을 WebKit으로 돈다(Chromium 전용인
// CDP 에뮬레이션은 건너뛰고 그 사실을 적는다). 진짜 Tauri 셸에서의 실행은 아니다(runtime-unverified).
const ENGINE = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
// SABOTAGE=scrim: ⑥을 재기 직전에 두 모드의 scrim을 투명하게 한다. 가드가 실제로 실패할 수 있다면 순흑·순백 사진이 그대로
// 비쳐 ⑥이 깨져야 한다(깨지지 않으면 ⑥이 아무것도 재지 않는다는 뜻이다). 정상 실행에서는 쓰지 않는다.
// SABOTAGE=band: 띠 표지(`data-wallpaper-band`)를 떼어, 띠 위 열에 보정색이 다시 얹히게 한다(수리 전의 모습). 띠가 있는 테마의
// 「배경화면 없음보다 나빠지지 않는다」 단정이 실제로 빨개져야 한다.
const SABOTAGE = process.env.SABOTAGE === "scrim" || process.env.SABOTAGE === "band" ? process.env.SABOTAGE : "";
const launcher = ENGINE === "webkit" ? webkit : chromium;

const FIXTURE_NOW = Date.parse("2026-10-22T09:30:00+09:00");
const SCHEMES = ["light", "dark"];
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "900", width: 900, height: 700 },
];

const MIN = 60_000;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(P("11"), "human", "이도현", "dohyun"),
  person(P("12"), "human", "박서연", "seoyeon"),
  person(P("13"), "human", "최민수", "minsu"),
  person(P("15"), "human", "정하윤", "hayun"),
  person(agentId, "agent", "그록", "grok", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "디자인-검수", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId, kind: "public", name: "배포", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ap4-4191-capture.invalid/connection/websocket",
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function messageRows() {
  const m = (n, author, body, ago) => ({
    id: `00000000-0000-7000-8000-0000000a00${String(n).padStart(2, "0")}`,
    channelId: CH, seq: 10 + n, hlcTs: FIXTURE_NOW - ago, hlcCount: 0, authorMemberId: author,
    type: "text", body, state: "sent", createdAtMs: FIXTURE_NOW - ago,
  });
  return [
    m(1, P("11"), "주간 회의 자료 올렸어요. 3쪽 숫자만 같이 봐 주세요.", 42 * MIN),
    m(2, P("12"), "확인했어요. 매출 표는 다시 계산해서 올릴게요.", 38 * MIN),
    m(3, P("13"), "저는 일정 쪽을 맡을게요. 배포 전날 점검은 제가 해요.", 31 * MIN),
    m(4, P("15"), "디자인 시안은 내일 오전에 공유해요. Figma 링크는 그때 붙일게요.", 24 * MIN),
    m(5, agentId, "요약해 둘게요. 필요한 일이 있으면 말씀해 주세요.", 12 * MIN),
    m(6, memberId, "이번 주 일정 정리해 줘", 4 * MIN),
  ];
}

/** 바깥으로 나간 요청을 센다(④). 모의 응답이 있는 same-origin `/v1`만 정상이다. */
const outbound = [];

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/logout") return json(route, {});
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: FIXTURE_NOW + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (/\/agents\/([^/]+)\/liveness$/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/hosted-agent-connections") && method === "GET") return json(route, { connections: [] });
    if (path.endsWith("/allowed-models")) return json(route, { allowedAgentModels: [] });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c, index) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: index === 1 ? 3 : 0, mention_count: index === 2 ? 1 : 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows() });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installPageFixtures(page) {
  await page.addInitScript((now) => {
    const NativeDate = Date;
    function FrozenDate(...args) {
      if (new.target) return Reflect.construct(NativeDate, args.length === 0 ? [now] : args);
      return new NativeDate(now).toString();
    }
    FrozenDate.now = () => now;
    FrozenDate.parse = NativeDate.parse.bind(NativeDate);
    FrozenDate.UTC = NativeDate.UTC.bind(NativeDate);
    FrozenDate.prototype = NativeDate.prototype;
    FrozenDate.prototype.constructor = FrozenDate;
    globalThis.Date = FrozenDate;
  }, FIXTURE_NOW);
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url); this.readyState = 0; window.__socket = this;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "4191-capture", version: "6" } };
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

async function openContext(browser, origin, scheme, viewport, extra = {}, seed = null) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    ...extra,
  });
  await installRoutes(context);
  const page = await context.newPage();
  await installPageFixtures(page);
  await page.addInitScript(
    ([server, appearance]) => {
      try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ }
      // 새로고침에도 같은 시드가 다시 박히지 않게 한 번만 쓴다.
      try {
        if (appearance && !sessionStorage.getItem("capture-4191-seeded")) {
          localStorage.setItem("momo.web.appearance.v2", appearance);
          sessionStorage.setItem("capture-4191-seeded", "1");
        }
      } catch { /* 저장소 없는 캡처 */ }
    },
    [origin, seed ? JSON.stringify({ v: 2, scheme: "system", signal: null, density: "comfortable", theme: "dawnsky", ...seed }) : null]
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  return { context, page };
}

const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });

async function goChat(page) {
  await page.evaluate((id) => { location.hash = `/c/${id}`; }, CH);
  await page.getByText("이번 주 일정 정리해 줘").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function goSettings(page) {
  await page.evaluate(() => { location.hash = "/settings?section=appearance"; });
  await page.waitForSelector('[data-testid="theme-choice"]', { timeout: 15_000 });
  await page.waitForTimeout(400);
}

/** 「배경」 카드가 한 화면에 들어오게 설정 본문을 스크롤한다(카드가 없는 「전」 빌드에서는 아무 일도 하지 않는다). */
async function scrollToBackdrop(page) {
  const found = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h2")].find((el) => el.textContent?.trim() === "배경");
    if (!heading) return false;
    const viewport = document.querySelector("[data-settings-scroll-viewport]");
    if (!viewport) return false;
    const top = heading.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 24;
    viewport.scrollTo({ top, behavior: "instant" });
    return true;
  });
  await page.waitForTimeout(200);
  return found;
}

// ---- 그림 고정물 -------------------------------------------------------------------------------

/** 브라우저의 캔버스로 JPEG를 만든다. 사진처럼 보이는 것(황혼 산)과 최악 입력(순흑·순백)과 잡음. */
async function makeJpeg(page, spec) {
  const base64 = await page.evaluate(async (s) => {
    const canvas = document.createElement("canvas");
    canvas.width = s.width;
    canvas.height = s.height;
    const g = canvas.getContext("2d");
    let seed = s.seed ?? 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    if (s.kind === "dusk") {
      const sky = g.createLinearGradient(0, 0, 0, s.height * 0.72);
      sky.addColorStop(0, "#1c2452");
      sky.addColorStop(0.45, "#7a4a8c");
      sky.addColorStop(0.8, "#f08a5d");
      sky.addColorStop(1, "#ffd08a");
      g.fillStyle = sky;
      g.fillRect(0, 0, s.width, s.height);
      for (let i = 0; i < 160; i += 1) {
        g.fillStyle = `rgba(255,255,255,${0.2 + rand() * 0.6})`;
        const r = 0.6 + rand() * 1.6;
        g.beginPath();
        g.arc(rand() * s.width, rand() * s.height * 0.42, r, 0, Math.PI * 2);
        g.fill();
      }
      const sun = g.createRadialGradient(s.width * 0.68, s.height * 0.62, 0, s.width * 0.68, s.height * 0.62, s.height * 0.34);
      sun.addColorStop(0, "rgba(255,244,214,1)");
      sun.addColorStop(0.18, "rgba(255,214,150,0.9)");
      sun.addColorStop(1, "rgba(255,160,90,0)");
      g.fillStyle = sun;
      g.fillRect(0, 0, s.width, s.height);
      const ridge = (base, amp, color, step) => {
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(0, s.height);
        let y = base;
        for (let x = 0; x <= s.width + step; x += step) {
          y += (rand() - 0.5) * amp;
          y = Math.min(base + amp * 2, Math.max(base - amp * 2, y));
          g.lineTo(x, y);
        }
        g.lineTo(s.width, s.height);
        g.closePath();
        g.fill();
      };
      ridge(s.height * 0.66, s.height * 0.07, "#5b3a63", 14);
      ridge(s.height * 0.74, s.height * 0.06, "#3a2a4f", 10);
      ridge(s.height * 0.84, s.height * 0.05, "#1d1830", 8);
    } else if (s.kind === "black") {
      g.fillStyle = "#000000";
      g.fillRect(0, 0, s.width, s.height);
    } else if (s.kind === "white") {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, s.width, s.height);
    } else if (s.kind === "arrow") {
      // 회전 확인용: 가로로 저장된 그림의 위쪽(왼쪽 위 모서리)이 빨갛다.
      g.fillStyle = "#1f6feb";
      g.fillRect(0, 0, s.width, s.height);
      g.fillStyle = "#ff3b30";
      g.fillRect(0, 0, s.width * 0.25, s.height * 0.25);
    } else if (s.kind === "noise") {
      const image = g.createImageData(s.width, s.height);
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = (rand() * 256) | 0;
        image.data[i + 1] = (rand() * 256) | 0;
        image.data[i + 2] = (rand() * 256) | 0;
        image.data[i + 3] = 255;
      }
      g.putImageData(image, 0, 0);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, spec);
  return Buffer.from(base64, "base64");
}

// ---- 장면의 사실을 모은다 -----------------------------------------------------------------------

async function sceneFacts(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const shell = document.querySelector(".app-shell");
    const layer = document.querySelector("[data-wallpaper-layer]");
    const style = (el) => (el ? getComputedStyle(el) : null);
    const ancestors = [];
    for (let el = shell?.parentElement; el; el = el.parentElement) {
      ancestors.push({ node: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`, bg: style(el).backgroundColor, bgImage: style(el).backgroundImage });
    }
    const ls = style(layer);
    const ss = style(shell);
    return {
      attrs: {
        wallpaper: root.getAttribute("data-wallpaper"),
        live: root.hasAttribute("data-wallpaper-live"),
        theme: root.getAttribute("data-theme"),
        palette: root.getAttribute("data-palette"),
      },
      shell: shell
        ? { backgroundColor: ss.backgroundColor, backgroundImage: ss.backgroundImage.slice(0, 160), scrimVar: ss.getPropertyValue("--shell-layer-canvas").trim().slice(0, 120) }
        : null,
      layer: layer
        ? {
            display: ls.display,
            position: ls.position,
            zIndex: ls.zIndex,
            backgroundColor: ls.backgroundColor,
            image: ls.backgroundImage === "none" ? "none" : `${ls.backgroundImage.slice(0, 48)}…(${ls.backgroundImage.length} chars)`,
            rect: (() => { const r = layer.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
          }
        : null,
      ancestors,
      rootVars: Object.fromEntries(
        [...root.style].filter((name) => name.startsWith("--wallpaper-")).map((name) => [name, root.style.getPropertyValue(name)])
      ),
      sceneColors: {
        sidebarText: (() => { const el = document.querySelector(".sidebar-drawer"); return el ? getComputedStyle(el).color : null; })(),
      },
    };
  });
}

const outDir = () => resolve(OUT_ROOT, ENGINE === "webkit" ? `${LABEL}-webkit` : LABEL);
const meta = [];

/** 화면에서 「시스템은 라이트예요/다크예요」를 말하는 말단 요소들의 글(식으로 평가한다). */
const SYSTEM_SCHEME_TEXTS = `[...document.querySelectorAll("p, span, div")]
  .filter((node) => node.children.length === 0 && /시스템은 (라이트|다크)예요/.test(node.textContent || ""))
  .map((node) => node.textContent || "")`;

/**
 * 설정의 「색 모드」 행은 「지금 이 기기의 시스템은 라이트예요」처럼 OS 모드를 말한다. 그 문장은 미디어 질의 알림을 받은 뒤에야
 * 바뀌어서, 부하가 큰 실행에서는 장면의 모드를 바꾼 직후 한 장을 찍으면 앞 모드의 문장이 찍힌다(실측: 두 실행을 겹쳤을 때
 * `settings-photo-light-900`이 「다크예요」로 찍혔다). 장면의 모드와 그 문장이 같아질 때까지 기다리고, 끝내 안 맞으면 던진다
 * (문장이 없는 장면은 기다릴 것이 없다).
 */
async function waitSystemSchemeText(page, scheme, name) {
  const word = scheme === "dark" ? "다크" : "라이트";
  try {
    await page.waitForFunction(`(${SYSTEM_SCHEME_TEXTS}).every((text) => text.includes("시스템은 ${word}예요"))`, undefined, { timeout: 10_000 });
  } catch (error) {
    const seen = await page.evaluate(SYSTEM_SCHEME_TEXTS);
    const dark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    throw new Error(`${name}: OS 모드 문장이 「${word}」가 되지 않았다. 본 것: ${JSON.stringify(seen)}, 미디어 질의는 ${dark ? "다크" : "라이트"} (${error.message})`);
  }
}

async function shoot(page, name, extra = {}) {
  await settle(page);
  if (extra.scheme) await waitSystemSchemeText(page, extra.scheme, name);
  const path = resolve(outDir(), `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  meta.push({ name, ...(await sceneFacts(page)), ...extra });
}

// ---- 설정 화면의 진짜 컨트롤 --------------------------------------------------------------------

async function pickKind(page, kind, id) {
  const testId = kind === "none" ? "wallpaper-none" : `wallpaper-${kind}-${id}`;
  // 라디오는 화면에서 숨겨져 있고 칩(라벨)이 얼굴이다. 라벨을 누른다.
  await page.getByTestId(testId).locator("xpath=ancestor::label").click();
  await page.waitForTimeout(200);
}

async function pickPhoto(page, buffer, name = "photo.jpg") {
  await page.getByTestId("wallpaper-file-input").setInputFiles({ name, mimeType: "image/jpeg", buffer });
}

async function waitLive(page, live = true, timeout = 15_000) {
  await page.waitForFunction((want) => document.documentElement.hasAttribute("data-wallpaper-live") === want, live, { timeout });
  await page.waitForTimeout(250);
}

// ---- capture ----------------------------------------------------------------------------------

async function viewportScenes(browser, origin, viewport) {
  const photoDusk = await (async () => {
    const holder = await browser.newPage();
    try { return await makeJpeg(holder, { kind: "dusk", width: 3200, height: 2000, seed: 11 }); } finally { await holder.close(); }
  })();
  const { context, page } = await openContext(browser, origin, "light", viewport);
  try {
    const hasWallpaperControl = LABEL !== "before";
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await goSettings(page);
      await shoot(page, `settings-none-${scheme}-${viewport.name}`, { scheme, viewport: viewport.name, wallpaper: "none" });
      if (hasWallpaperControl) {
        await scrollToBackdrop(page);
        await shoot(page, `settings-card-none-${scheme}-${viewport.name}`, { scheme, viewport: viewport.name, wallpaper: "none" });
      }
      await goChat(page);
      await shoot(page, `chat-none-${scheme}-${viewport.name}`, { scheme, viewport: viewport.name, wallpaper: "none" });
    }
    if (!hasWallpaperControl) return;

    const kinds = [
      { name: "solid", pick: () => pickKind(page, "solid", "slate") },
      { name: "preset", pick: () => pickKind(page, "preset", "bam") },
      { name: "photo", pick: async () => { await pickPhoto(page, photoDusk, "dusk.jpg"); await waitLive(page); } },
    ];
    for (const kind of kinds) {
      await page.emulateMedia({ colorScheme: "light" });
      await goSettings(page);
      await kind.pick();
      await waitLive(page);
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        await goSettings(page);
        await shoot(page, `settings-${kind.name}-${scheme}-${viewport.name}`, { scheme, viewport: viewport.name, wallpaper: kind.name });
        await scrollToBackdrop(page);
        await shoot(page, `settings-card-${kind.name}-${scheme}-${viewport.name}`, { scheme, viewport: viewport.name, wallpaper: kind.name });
        await goChat(page);
        await shoot(page, `chat-${kind.name}-${scheme}-${viewport.name}`, { scheme, viewport: viewport.name, wallpaper: kind.name });
      }
    }
  } finally {
    await context.close();
  }
}

/** 같은 테마의 바닥(배경화면 없음). 「전」과 「후」가 모두 찍어 짝으로 비교한다. 노을띠는 띠가 사이드바를 덮는다. */
async function themeBaselines(browser, origin) {
  const viewport = VIEWPORTS[0];
  for (const theme of ["noeul", "graphite"]) {
    const { context, page } = await openContext(browser, origin, "light", viewport, {}, { theme });
    try {
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        await goChat(page);
        await shoot(page, `chat-none-${theme}-${scheme}-1440`, { scheme, viewport: "1440", wallpaper: "none", theme });
        await goSettings(page);
        await shoot(page, `settings-none-${theme}-${scheme}-1440`, { scheme, viewport: "1440", wallpaper: "none", theme });
      }
    } finally {
      await context.close();
    }
  }
}

async function themeScenes(browser, origin) {
  // 띠가 있는 노을띠와 평면 흑연 위에서도 같은 장면(사진). 노을띠는 띠가 사진을 가리는 모습이 기대한 모습이다.
  const viewport = VIEWPORTS[0];
  const photo = await (async () => {
    const holder = await browser.newPage();
    try { return await makeJpeg(holder, { kind: "dusk", width: 3200, height: 2000, seed: 11 }); } finally { await holder.close(); }
  })();
  for (const theme of ["noeul", "graphite"]) {
    const { context, page } = await openContext(browser, origin, "light", viewport, {}, { theme });
    try {
      await goSettings(page);
      await pickPhoto(page, photo, "dusk.jpg");
      await waitLive(page);
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        await goChat(page);
        await shoot(page, `chat-photo-${theme}-${scheme}-1440`, { scheme, viewport: "1440", wallpaper: "photo", theme });
        await goSettings(page);
        await shoot(page, `settings-photo-${theme}-${scheme}-1440`, { scheme, viewport: "1440", wallpaper: "photo", theme });
        await scrollToBackdrop(page);
        await shoot(page, `settings-card-photo-${theme}-${scheme}-1440`, { scheme, viewport: "1440", wallpaper: "photo", theme });
      }
    } finally {
      await context.close();
    }
  }
}

async function fallbackScenes(browser, origin) {
  const viewport = VIEWPORTS[0];
  // 대비 높이기: Playwright의 contrast 옵션. 투명도 줄이기: CDP의 미디어 특징 에뮬레이션.
  for (const kind of ["contrast", "transparency"]) {
    const { context, page } = await openContext(browser, origin, "light", viewport, kind === "contrast" ? { contrast: "more" } : {}, {
      wallpaper: { kind: "preset", id: "noeul" },
    });
    try {
      if (kind === "transparency") {
        if (ENGINE !== "chromium") continue;
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
        await page.waitForTimeout(300);
      }
      const matches = await page.evaluate(() => ({
        contrastMore: matchMedia("(prefers-contrast: more)").matches,
        reduceTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
      }));
      if (kind === "contrast" && !matches.contrastMore) throw new Error("prefers-contrast: more 가 켜지지 않았다. 이 장면은 폴백을 재지 못한다.");
      if (kind === "transparency" && !matches.reduceTransparency) throw new Error("prefers-reduced-transparency: reduce 가 켜지지 않았다. 이 장면은 폴백을 재지 못한다.");
      await goSettings(page);
      await scrollToBackdrop(page);
      await shoot(page, `fallback-${kind}-settings-1440`, { scheme: "light", viewport: "1440", wallpaper: "preset", fallback: kind, matches });
      await goChat(page);
      await shoot(page, `fallback-${kind}-chat-1440`, { scheme: "light", viewport: "1440", wallpaper: "preset", fallback: kind, matches });
    } finally {
      await context.close();
    }
  }
}

async function phoneScene(browser, origin) {
  const viewport = { name: "390", width: 390, height: 844 };
  const { context, page } = await openContext(browser, origin, "light", viewport, {}, { wallpaper: { kind: "preset", id: "noeul" } });
  try {
    await goChat(page);
    await shoot(page, "phone-preset-chat-light-390", { scheme: "light", viewport: "390", wallpaper: "preset" });
    // 폰 폭에서는 바닥이 보이지 않는다: 설정 행이 그 사실을 말한다.
    await goSettings(page);
    await scrollToBackdrop(page);
    await shoot(page, "phone-settings-card-preset-light-390", { scheme: "light", viewport: "390", wallpaper: "preset" });
  } finally {
    await context.close();
  }
  // 아무것도 고르지 않은 처음 상태(폰 폭): 「기본으로」가 잠긴 채 늘 있어서, 처음 고르는 순간 칩이 아래로 밀리지 않는다.
  const fresh = await openContext(browser, origin, "light", viewport);
  try {
    await goSettings(fresh.page);
    await scrollToBackdrop(fresh.page);
    await shoot(fresh.page, "phone-settings-card-none-light-390", { scheme: "light", viewport: "390", wallpaper: "none" });
  } finally {
    await fresh.context.close();
  }
}

/** 키보드로 칩에 닿았을 때의 초점 고리(Tab 한 번). */
async function focusScene(browser, origin) {
  const { context, page } = await openContext(browser, origin, "light", VIEWPORTS[0], {}, { wallpaper: { kind: "preset", id: "bam" } });
  try {
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await goSettings(page);
      await scrollToBackdrop(page);
      await page.getByTestId("wallpaper-reset").focus();
      await page.keyboard.press("Tab");
      await shoot(page, `settings-card-focus-${scheme}-1440`, { scheme, viewport: "1440", wallpaper: "preset", focus: true });
    }
  } finally {
    await context.close();
  }
}

async function capture() {
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  mkdirSync(outDir(), { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", distDir] });
  const browser = await launcher.launch();
  try {
    for (const viewport of VIEWPORTS) await viewportScenes(browser, preview.origin, viewport);
    await themeBaselines(browser, preview.origin);
    if (LABEL !== "before") {
      await themeScenes(browser, preview.origin);
      await fallbackScenes(browser, preview.origin);
      await focusScene(browser, preview.origin);
      await phoneScene(browser, preview.origin);
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(outDir(), "meta.json"), JSON.stringify({ label: LABEL, dist: DIST, shots: meta }, null, 1));
  console.log(`CAPTURE ${LABEL}: ${meta.length} shots -> ${outDir()}`);
}

// ---- assert -----------------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

async function readStoredPhoto(page) {
  return page.evaluate(
    () =>
      new Promise((resolveRead) => {
        const open = indexedDB.open("momo-appearance", 1);
        open.onerror = () => resolveRead({ error: String(open.error) });
        open.onupgradeneeded = () => {
          // 저장소가 아직 없다: 열기만 해도 만들어지므로 지워진 것과 같은 답이다.
        };
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("blobs")) {
            db.close();
            resolveRead({ record: null });
            return;
          }
          const request = db.transaction("blobs", "readonly").objectStore("blobs").get("wallpaper");
          request.onsuccess = () => {
            const value = request.result;
            db.close();
            if (!value) return resolveRead({ record: null });
            resolveRead({
              record: {
                rev: value.rev, type: value.type, width: value.width, height: value.height,
                size: value.bytes.byteLength, thumbHead: typeof value.thumb === "string" ? value.thumb.slice(0, 30) : null,
                bytes: Array.from(new Uint8Array(value.bytes)),
              },
            });
          };
          request.onerror = () => { db.close(); resolveRead({ error: String(request.error) }); };
        };
      })
  );
}

const storedAppearance = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("momo.web.appearance.v2") || "null"); } catch { return null; }
});

async function legibility(browser, origin, helper) {
  const rows = [];
  // 바닥 위에 직접 서는 세 자리: 펼친 사이드바·상단 줄, 접은 사이드바(레일)·상단 줄, 설정의 목록 열.
  const CHAT = ".app-shell > .sidebar-drawer, .app-shell > .app-titlebar";
  const SETTINGS = ".app-shell .settings-nav";
  const statesOf = (page) => [
    ["펼친 사이드바", CHAT, async () => { await goChat(page); }],
    ["접은 사이드바", CHAT, async () => { await goChat(page); await page.getByTestId("sidebar-toggle").click(); await page.waitForTimeout(500); }],
    ["설정 목록 열", SETTINGS, async () => { await goSettings(page); }],
  ];
  const restore = async (page, name) => {
    // 접은 상태를 되돌린다.
    if (name === "접은 사이드바") { await page.getByTestId("sidebar-toggle").click(); await page.waitForTimeout(300); }
  };
  // 평평한 테마(새벽 하늘·흑연)는 열이 scrim 위에 선다: 절대 기준(글자 4.5:1·아이콘 3:1)을 잰다.
  // 띠가 있는 테마(노을띠)는 사이드바 열의 호스트가 **불투명한 띠**다: 배경화면이 scrim을 얹어도 그 열의 글자는 띠 위에 있다.
  // 그 열의 값은 테마 자신의 몫(설정 목록 열은 기준 빌드부터 라이트에서 읽히지 않는다)이므로, 배경화면 때문에 **나빠지지 않았는지**를
  // 같은 장면의 「배경화면 없음」과 짝지어 잰다(design-review H-1: 보정색이 띠 위 글자를 덮어 섹션 라벨 2.34 → 1.29).
  const CASES = [
    { theme: null, label: "새벽 하늘", compare: false },
    { theme: "graphite", label: "흑연", compare: false },
    { theme: "noeul", label: "노을띠", compare: true },
  ];
  for (const { theme, label, compare } of CASES) {
    const seed = theme ? { theme } : null;
    const baselines = new Map();
    if (compare) {
      const { context, page } = await openContext(browser, origin, "light", VIEWPORTS[0], {}, seed);
      try {
        for (const scheme of SCHEMES) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.waitForTimeout(400);
          for (const [name, region, prepare] of statesOf(page)) {
            await prepare();
            await settle(page);
            baselines.set(`${scheme}|${name}`, (await measureLegibility(page, helper, region)).measured);
            await restore(page, name);
          }
        }
      } finally {
        await context.close();
      }
    }
    for (const kind of ["black", "white"]) {
      const photo = await makeJpeg(helper, { kind, width: 2400, height: 1500 });
      const { context, page } = await openContext(browser, origin, "light", VIEWPORTS[0], {}, seed);
      try {
        await goSettings(page);
        await pickPhoto(page, photo, `${kind}.jpg`);
        await waitLive(page);
        for (const scheme of SCHEMES) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.waitForTimeout(400);
          for (const [name, region, prepare] of statesOf(page)) {
            await prepare();
            await settle(page);
            if (SABOTAGE === "scrim") {
              await page.evaluate(() => {
                document.documentElement.style.setProperty("--wallpaper-scrim-light", "transparent");
                document.documentElement.style.setProperty("--wallpaper-scrim-dark", "transparent");
              });
              await settle(page);
            }
            if (SABOTAGE === "band") {
              await page.evaluate(() => document.documentElement.removeAttribute("data-wallpaper-band"));
              await settle(page);
            }
            const { png, measured } = await measureLegibility(page, helper, region);
            let bad;
            let worst;
            if (compare) {
              const before = baselines.get(`${scheme}|${name}`) ?? [];
              // 짝이 안 맞으면(요소 수가 다르면) 비교가 성립하지 않는다: 통째로 나쁜 것으로 센다.
              if (before.length !== measured.length) {
                bad = [{ label: `요소 수가 다르다 (${before.length} → ${measured.length})` }];
                worst = 0;
              } else {
                // 이미 기준을 넘는 항목은 배경화면 때문에 조금 달라져도 괜찮다. 못 미치던 항목은 더 나빠지면 안 된다.
                bad = measured.filter((item, index) => item.ratio < item.min - 0.05 && item.ratio < before[index].ratio - 0.05);
                worst = Math.min(...measured.map((item, index) => Math.min(1, item.ratio / Math.min(before[index].ratio, item.min))));
              }
            } else {
              bad = measured.filter((item) => item.ratio < item.min - 0.05);
              worst = Math.min(...measured.map((item) => item.ratio / item.min));
            }
            rows.push({ theme: label, compare, kind, scheme, name, count: measured.length, worst, bad });
            const slug = `${theme ?? "dawnsky"}-${kind}-${scheme}-${name.replace(/\s+/g, "")}`;
            writeFileSync(resolve(outDir(), `legibility-${slug}.png`), png);
            writeFileSync(
              resolve(outDir(), `legibility-${slug}.json`),
              JSON.stringify(measured.map((item) => ({ kind: item.kind, label: item.label, color: item.color, bg: item.bg, ratio: Number(item.ratio.toFixed(2)), min: item.min })), null, 1)
            );
            await restore(page, name);
          }
        }
      } finally {
        await context.close();
      }
    }
  }
  return rows;
}

async function assertions() {
  mkdirSync(outDir(), { recursive: true });
  const distDir = resolve(WEB_ROOT, DIST);
  if (!existsSync(resolve(distDir, "index.html"))) throw new Error(`${distDir}/index.html 이 없다. 먼저 빌드한다.`);
  const tauriConf = JSON.parse(readFileSync(resolve(WEB_ROOT, "../desktop/src-tauri/tauri.conf.json"), "utf8"));
  const tauriCsp = tauriConf.app.security.csp;
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: ["--outDir", distDir],
    env: { ...process.env, NO_COLOR: "1", MOMO_CSP_GATE_HEADER: tauriCsp },
  });
  const browser = await launcher.launch();
  const helper = await browser.newPage();
  try {
    // ① 사진 처리: 위치 태그가 든, 가로로 저장된 세로 사진.
    const baseJpeg = await makeJpeg(helper, { kind: "arrow", width: 1200, height: 800 });
    const withExif = injectExif(baseJpeg, exifSegment({ orientation: 6, gps: { lat: [37, 34, 12], lon: [126, 58, 30] } }));
    const before = inspectJpeg(withExif);
    check("전제: 픽스처에는 EXIF·GPS·회전 태그가 실제로 든다", before.exif && before.gps && before.orientation === 6 && before.width === 1200 && before.height === 800, JSON.stringify({ exif: before.exif, gps: before.gps, orientation: before.orientation, size: `${before.width}x${before.height}` }));
    // 대조군: 메타데이터 세그먼트가 하나도 없는 손으로 만든 JPEG 구조. 엔진이 캔버스 출력에 자기 Exif를 쓰기도 해서(WebKit)
    // 캔버스가 만든 JPEG를 「깨끗한 것」으로 가정하지 않는다.
    const bare = inspectJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
    check("전제: 검사기가 메타데이터 없는 JPEG 구조는 EXIF 없다고 읽는다 (가드가 실패할 수 있다)", bare.isJpeg && !bare.exif && !bare.gps);

    const { context, page } = await openContext(browser, preview.origin, "light", VIEWPORTS[0]);
    const violations = [];
    await page.exposeFunction("__reportCsp", (v) => violations.push(v));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__reportCsp?.(`${event.violatedDirective} ${event.blockedURI}`.slice(0, 120));
      });
    });
    let requestsAfterPick = [];
    try {
      await goSettings(page);
      // 폰 보관함 같은 외부는 없다. 선택부터 적용까지 바깥으로 나가는 요청을 기록한다.
      let recording = false;
      page.on("request", (request) => {
        if (!recording) return;
        const url = new URL(request.url());
        outbound.push({ method: request.method(), host: url.host, path: url.pathname, body: (request.postData() || "").length });
      });
      recording = true;
      await pickPhoto(page, Buffer.from(withExif), "portrait-gps.jpg");
      await waitLive(page);
      await page.waitForTimeout(600);
      recording = false;
      requestsAfterPick = [...outbound];
      const stored = await readStoredPhoto(page);
      const record = stored.record;
      check("① IndexedDB에 사진 한 장이 저장됐다", Boolean(record), record ? `rev=${record.rev} ${record.width}x${record.height} ${record.size}B` : JSON.stringify(stored));
      if (record) {
        const out = inspectJpeg(Uint8Array.from(record.bytes));
        check("① 저장된 바이트는 JPEG이고 EXIF·GPS가 없다", out.isJpeg && !out.exif && !out.gps, JSON.stringify({ markers: out.markers }));
        check("① 회전이 픽셀에 구워졌다 (1200x800 + Orientation 6 → 800x1200)", out.width === 800 && out.height === 1200, `${out.width}x${out.height}`);
        check("① 긴 변 ≤ 2560, 크기 ≤ 1.5MB", Math.max(out.width, out.height) <= 2560 && record.size <= 1_500_000, `${record.size}B`);
        check("① 레코드의 크기 필드가 실제 JPEG와 같다", record.width === out.width && record.height === out.height);
        check("① 설정 화면용 썸네일이 data:image/jpeg다", record.thumbHead?.startsWith("data:image/jpeg;base64,") === true, String(record.thumbHead));
      }
      const appearance = await storedAppearance(page);
      check("① 외양 레코드에는 참조만 있고 바이트는 없다", appearance?.wallpaper?.kind === "image" && JSON.stringify(appearance).length < 2000, JSON.stringify(appearance?.wallpaper));
      check("④ 사진을 고르고 적용하는 동안 바깥으로 나간 요청이 없다 (본문 있는 요청 0, 다른 오리진 0)",
        requestsAfterPick.every((r) => r.host === new URL(preview.origin).host && r.body === 0 && r.method === "GET"), JSON.stringify(requestsAfterPick.slice(0, 5)));
      const facts = await sceneFacts(page);
      check("⑤ Tauri CSP 아래에서 사진 배경이 서고 CSP 위반 이벤트가 0이다", facts.attrs.live && facts.layer?.image.startsWith("url(") && violations.length === 0, JSON.stringify({ live: facts.attrs.live, image: facts.layer?.image, violations }));

      // 거대한 잡음 사진: 계단을 내려가 상한 안에 든다.
      const noise = await makeJpeg(helper, { kind: "noise", width: 5200, height: 3400, seed: 3 });
      const noiseExif = inspectJpeg(noise);
      check("전제: 잡음 사진은 원본이 1.5MB를 훨씬 넘는다", noise.length > 3_000_000, `${noise.length}B ${noiseExif.width}x${noiseExif.height}`);
      await pickPhoto(page, noise, "noise.jpg");
      await page.waitForFunction(() => document.querySelector('[data-testid="wallpaper-pick-photo"]')?.hasAttribute("disabled") === false, null, { timeout: 60_000 });
      await page.waitForTimeout(800);
      const big = (await readStoredPhoto(page)).record;
      check("① 잡음 사진도 상한 안에 들어 저장된다", Boolean(big) && big.size <= 1_500_000 && Math.max(big.width, big.height) <= 2560, big ? `${big.size}B ${big.width}x${big.height}` : "저장 안 됨");

      // ② 새로고침 뒤에도 사진이 유지된다.
      await page.reload({ waitUntil: "domcontentloaded" });
      try {
        // 새로고침은 설정 라우트에 그대로 돌아온다(설정은 사이드바를 대신하므로 프로필 카드는 없다).
        await page.waitForSelector('[data-testid="theme-choice"]', { timeout: 20_000 });
      } catch (error) {
        // 새로고침 뒤 화면이 무엇인지 남긴다(세션 복원이 어디서 멈췄는지).
        await page.screenshot({ path: resolve(outDir(), "reload-failure.png") });
        const text = await page.evaluate(() => document.body.innerText.slice(0, 300));
        console.log(`새로고침 뒤 화면: ${page.url()} :: ${text.replace(/\s+/g, " ")}`);
        throw error;
      }
      await page.waitForFunction(() => document.documentElement.hasAttribute("data-wallpaper-live"), null, { timeout: 15_000 });
      const reloaded = await sceneFacts(page);
      check("② 새로고침 뒤에도 사진 배경이 서 있다", reloaded.attrs.live && reloaded.layer?.image.startsWith("url(\"data:image/jpeg"), JSON.stringify(reloaded.layer));
      const afterReload = (await readStoredPhoto(page)).record;
      check("② 새로고침 뒤에도 IndexedDB의 사진이 같다", Boolean(afterReload) && afterReload.rev === big.rev, afterReload ? `rev=${afterReload.rev}` : "없음");

      // 사진을 단색으로 바꾸면 이전 사진이 지워진다.
      await goSettings(page);
      await pickKind(page, "solid", "slate");
      await page.waitForTimeout(500);
      check("단색으로 바꾸면 이전 사진이 지워진다", (await readStoredPhoto(page)).record === null);
      const solidFacts = await sceneFacts(page);
      check("단색 배경이 서 있다 (층 요소의 바탕색, 그림은 none)", solidFacts.attrs.live && solidFacts.layer?.image === "none" && solidFacts.layer?.backgroundColor === "rgb(91, 107, 140)", JSON.stringify(solidFacts.layer));

      // ③ 로그아웃: 사진을 다시 고른 뒤 로그아웃하면 사진이 지워진다. 단색은 남는다.
      await pickPhoto(page, baseJpeg, "again.jpg");
      await waitLive(page);
      await page.waitForTimeout(400);
      check("전제: 로그아웃 전에 사진이 저장돼 있다", (await readStoredPhoto(page)).record !== null);
      await goChat(page);
      await page.getByTestId("profile-card").click();
      await page.getByTestId("profile-logout").click();
      await page.getByTestId("profile-logout-confirm-action").click();
      await page.getByTestId("login-submit").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
      const afterLogout = await readStoredPhoto(page);
      const rootAfter = await page.evaluate(() => ({ live: document.documentElement.hasAttribute("data-wallpaper-live"), kind: document.documentElement.getAttribute("data-wallpaper"), varCount: [...document.documentElement.style].filter((n) => n.startsWith("--wallpaper-")).length }));
      const recordAfter = await storedAppearance(page);
      check("③ 로그아웃하면 IndexedDB의 사진이 지워진다", afterLogout.record === null, JSON.stringify(afterLogout.error ?? null));
      check("③ 외양 레코드의 사진 참조와 루트의 속성·변수가 걷힌다", !recordAfter?.wallpaper && rootAfter.live === false && rootAfter.kind === null && rootAfter.varCount === 0, JSON.stringify({ wallpaper: recordAfter?.wallpaper, rootAfter }));
    } finally {
      await context.close();
    }

    // 단색은 로그아웃에도 남는다(취향이다).
    {
      const { context: c2, page: p2 } = await openContext(browser, preview.origin, "light", VIEWPORTS[0]);
      try {
        await goSettings(p2);
        await pickKind(p2, "preset", "bam");
        await waitLive(p2);
        await goChat(p2);
        await p2.getByTestId("profile-card").click();
        await p2.getByTestId("profile-logout").click();
        await p2.getByTestId("profile-logout-confirm-action").click();
        await p2.getByTestId("login-submit").waitFor({ timeout: 20_000 });
        await p2.waitForTimeout(400);
        const recordAfter = await storedAppearance(p2);
        check("③ 단색·기본 제공 선택은 로그아웃에도 남는다 (취향이다)", recordAfter?.wallpaper?.kind === "preset", JSON.stringify(recordAfter?.wallpaper));
      } finally {
        await c2.close();
      }
    }

    // ⑥ 읽힘: 순흑·순백 사진 위의 실제 렌더 픽셀.
    const rows = await legibility(browser, preview.origin, helper);
    for (const row of rows) {
      const rule = row.compare ? "배경화면 없음보다 나빠지지 않는다 (띠 위 열은 테마의 몫)" : "글자 4.5:1·아이콘 3:1";
      check(`⑥ ${row.theme} × ${row.kind} 사진 × ${row.scheme} × ${row.name}: ${rule}`, row.bad.length === 0 && row.count >= (row.name === "접은 사이드바" ? 2 : 8),
        `항목 ${row.count}개, 가장 낮은 (대비/기준) = ${row.worst.toFixed(2)}${row.bad.length ? `, 미달: ${JSON.stringify(row.bad.slice(0, 4).map((b) => [b.label, b.color, b.bg, b.ratio === undefined ? null : Number(b.ratio.toFixed(2))]))}` : ""}`);
    }

    // ⑦ 접근성 폴백: 그림이 서지 않고 선택은 남는다.
    for (const kind of ["contrast", "transparency"]) {
      const { context: c3, page: p3 } = await openContext(browser, preview.origin, "light", VIEWPORTS[0], kind === "contrast" ? { contrast: "more" } : {}, { wallpaper: { kind: "solid", id: "slate" } });
      try {
        if (kind === "transparency") {
          if (ENGINE !== "chromium") {
            console.log("SKIP  ⑦ 투명도 줄이기: CDP 에뮬레이션은 Chromium 전용이다 (WebKit에는 이 미디어 특징의 에뮬레이션 길이 없다)");
            continue;
          }
          const cdp = await c3.newCDPSession(p3);
          await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
        }
        await goSettings(p3);
        await p3.waitForTimeout(500);
        const facts = await sceneFacts(p3);
        const status = await p3.getByTestId("wallpaper-status").textContent().catch(() => null);
        check(`⑦ ${kind === "contrast" ? "대비 높이기" : "투명도 줄이기"}: 그림이 서지 않고(live 0) 선택은 남고 이유를 말한다`,
          !facts.attrs.live && facts.attrs.wallpaper === "solid" && facts.layer?.display === "none" && Boolean(status), JSON.stringify({ live: facts.attrs.live, kind: facts.attrs.wallpaper, display: facts.layer?.display, status }));
      } finally {
        await c3.close();
      }
    }
  } finally {
    await helper.close().catch(() => undefined);
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(outDir(), "assert.json"), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(`\nRESULT ${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

(MODE === "assert" ? assertions() : capture()).catch((error) => {
  console.error(error);
  process.exit(1);
});
