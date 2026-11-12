// 뒤에 있던 앱의 새 글 표시와 앞으로 돌아왔을 때의 따라잡기 (#5660). 실제 번들 + 가짜 /v1 + 가짜 실시간 서버, 실제 Chromium.
//
//   npm run build && node gates/gate-background-resume.mjs                 (BACKGROUND_GATE_PORT 로 포트를 옮긴다)
//   BACKGROUND_GATE_DIST=<번들> node gates/gate-background-resume.mjs --measure   (단정 없이 숫자만: 수리 전 번들을 잴 때)
//   --scenes A,C  장면만 고른다 · --json <파일>  숫자를 남긴다 · BACKGROUND_GATE_DEBUG=<png>  로그인·채널 열기에서 막히면 그 화면을 남긴다
//
// **이 숫자는 번들의 판단만 잰다.** 헤드리스 Chromium 의 페이지는 진짜로 뒤로 가지 않고, WKWebView 의 비활성 스케줄링도 맥의 앱 낮잠도
// 돌지 않는다. 그래서 「뒤에 있음」은 사건으로 흉내 낸다: 보임·초점을 바꿔 그 사건을 쏘고(`__away`/`__back`), 웹뷰가 멈춘 시간은
// 페이지의 스크립트 줄을 그 시간만큼 붙잡아(`freezeFor`: 타이머도 소켓 처리도 돌지 못한다), 잠자기 뒤의 소켓은 닫히지 않고 조용히
// 죽은 소켓(`silenceSockets`)으로. CDP 의 페이지 얼림(`Page.setWebLifecycleState frozen`)은 쓰지 않는다: 헤드리스 Chromium 에서
// 재 보니 얼린 20초 동안 5초 타이머가 제때(늦음 ≤ 73ms) 울었다 — 멈춤이 아니다.
// 데스크탑 셸은 `__TAURI_INTERNALS__` 흉내로 서고, 메뉴 막대 아이콘에 보낸 상태(`tray_status_set`)를 시각과 함께 적는다.
//
// 장면(이슈 #5660 Acceptance):
//   A 뒤에 있고 소켓은 살아 있다 → 다른 사람이 나를 멘션 → 메뉴 막대 점이 켜지기까지(목표 5초)
//   B 뒤에 35초, 그동안 웹뷰가 멈췄고 소켓은 조용히 죽었다, 그 사이 연 채널에 새 글 → 앞으로 온 순간부터 그 글이 보이기까지
//     (목표 1초) + 「연결 중·끊김」 카드·띠가 한 번도 서지 않는다 + 바닥에 있던 목록은 바닥에 남는다(바닥 거리 ≤ 1px)
//   C 뒤에 20초(30초 문턱 아래), 그동안 네트워크가 끊겨 소켓이 다시 붙기를 기다리는 중 → 앞으로 온 순간부터 새 글이 보이기까지(목표 1초)
//   D 앱이 앞에 있는 채로 맥이 20초 잠들었다(창 사건 없음, 소켓은 조용히 죽음) → 깬 순간부터 새 글이 보이기까지(목표 5초)
//   E 뒤에 있는 동안 위로 올려 읽던 사람: 놓친 글 20건을 따라잡은 뒤 읽던 줄이 움직이지 않는다(≤ 2px)
//   G 뒤에 있는 동안 다른 사람이 DM → 메뉴 막대 점(owner 11-11 「켜줘」: 폰이 울리는 DM은 맥 표시도 켠다, 목표 5초)
//   H 뒤에 있는 동안 내가 따라가는 스레드에 남이 답글 → 메뉴 막대 점(같은 owner 결정, 서버 #5667 흉내: 투영 필드 + 개인 채널 신호),
//     이어서 다른 기기에서 그 스레드를 읽음 → 점이 꺼짐(각 목표 5초)
//   F 뒤에 40초, 웹뷰도 소켓도 살아 있었다(수리 뒤 데스크탑의 보통 경우) → 그 사이 온 글은 이미 들어와 있고, 돌아와도 소켓을 다시 열지
//     않는다(다시 붙기 0회, 연결 화면 0회). 소켓이 「들은 시각」(`lastHeardAt`)이 실제 엔진에서 잡히는지가 여기서 갈린다
//   I 창을 치운 채 **열어 둔 채널**에서 나를 멘션 → 메뉴 막대 점이 켜지고(목표 1초) 치워 둔 동안 읽음 요청(`PUT read-state`)이 한 건도 나가지
//     않는다. 앞으로 오면 그때 읽음이 오르고 점이 꺼진다(목표 5초)
//   J 같은 것을 **열어 둔 DM**으로(장면 G 는 열지 않은 DM 이다)
//
// 5분·30분 장면은 따로 재지 않는다: 번들의 판단은 「30초 넘게 자리를 비웠다」 한 갈래라 35초(B)와 같은 길을 간다. 실제 시간의 길이가
// 다르게 만드는 것(웹뷰 멈춤·앱 낮잠·잠자기)은 데스크탑 실물에서만 잴 수 있다(인계의 runtime-unverified 절차).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import {
  CHANNELS,
  GENERAL_ID,
  ME,
  PEER,
  WORKSPACE_ID,
  channelRail,
  installBackend,
  messageNewFrame,
  openGeneral,
  peerMessage,
  personalRail,
  signIn,
  sleep,
} from "./connection-harness.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.BACKGROUND_GATE_PORT || 5235);
const origin = `http://127.0.0.1:${port}`;
const measureOnly = process.argv.includes("--measure");
/** 번들 엔진: 기본 Chromium, `BACKGROUND_GATE_ENGINE=webkit`이면 번들 WebKit(데스크탑 웹뷰와 같은 엔진, 셸·스케줄링은 아님). */
const engine = process.env.BACKGROUND_GATE_ENGINE === "webkit" ? webkit : chromium;
const jsonOut = (() => {
  const at = process.argv.indexOf("--json");
  return at === -1 ? null : process.argv[at + 1];
})();
const only = (() => {
  const at = process.argv.indexOf("--scenes");
  return at === -1 ? null : new Set(process.argv[at + 1].split(","));
})();

const OTHER = CHANNELS[1]; // 「엔진」: 열려 있지 않은 채널
const SCROLLER = '[data-testid="timeline-virtuoso"]';

const results = [];
const failures = [];
function check(ok, label) {
  if (!ok) failures.push(label);
}

/** 데스크탑 셸 흉내 + 창 앞뒤 흉내 + 연결 화면 관찰. 페이지가 서기 전에 깔린다. */
async function installPageShims(page) {
  await page.addInitScript((server) => {
    // 데스크탑의 첫 화면은 「이 페이지의 서버」를 모른다(페이지가 tauri://localhost에서 온다): 고른 서버를 미리 적어 둔다.
    try {
      localStorage.setItem("momo.web.server.v1", server);
      // 「업데이트 소식」은 이 게이트가 재는 것이 아니다: 이미 본 것으로 둔다(엔진마다 뜨는 때가 달라 Escape 로 닫기가 흔들렸다).
      localStorage.setItem("momo.web.release-notes.seen.v1", "999.0.0");
    } catch {
      /* 저장소 없는 페이지 */
    }
    window.__invokes = [];
    const callbacks = new Map();
    let nextCallback = 1;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) {
        const id = nextCallback++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      convertFileSrc: (path) => path,
      async invoke(cmd, args) {
        window.__invokes.push({ cmd, args, at: Date.now() });
        if (cmd === "detect_local_harnesses") return { harnesses: [] };
        if (cmd === "detect_hosted_agents") return [];
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { window.__kc = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return window.__kc ? "shell:00000000000000000000000000000001" : null;
        if (cmd === "keychain_clear_refresh_token") { window.__kc = false; return null; }
        if (cmd === "deep_link_take_pending") return [];
        if (cmd === "app_version") return "0.1.46";
        if (cmd === "notification_permission") return "denied";
        if (cmd === "updater_check") return null;
        if (cmd.startsWith("plugin:event|")) return 1;
        return null;
      },
    };

    // 창의 앞뒤: 보임(visibilityState)과 초점(hasFocus)을 이 값이 정하고, 바뀔 때 브라우저와 같은 사건을 쏜다.
    const fg = { visible: true, focused: true };
    Object.defineProperty(Document.prototype, "visibilityState", {
      configurable: true,
      get: () => (fg.visible ? "visible" : "hidden"),
    });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => !fg.visible });
    Document.prototype.hasFocus = () => fg.focused;
    window.__away = () => {
      fg.focused = false;
      window.dispatchEvent(new Event("blur"));
      fg.visible = false;
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    };
    window.__back = () => {
      fg.visible = true;
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      fg.focused = true;
      window.dispatchEvent(new Event("focus"));
    };

    // 연결 카드·띠가 선 순간들(무엇이 섰는지와 시각). 늘 붙어 있다가 서는 것만 적는다.
    window.__connectionUi = [];
    let shown = "";
    const look = () => {
      const node = document.querySelector('[data-testid="connection-card"], [data-testid="connection-banner"]');
      const now = node === null ? "" : `${node.getAttribute("data-testid")}:${(node.textContent ?? "").trim().slice(0, 40)}`;
      if (now !== shown) {
        shown = now;
        if (now !== "") window.__connectionUi.push({ at: Date.now(), what: now });
      }
    };
    document.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    });
  }, origin);
}

function readStateRow(channelId, latest, read, mentions) {
  return {
    channel_id: channelId.toUpperCase(),
    last_read_seq: read,
    latest_seq: latest,
    unread_count: Math.max(0, latest - read),
    mention_count: mentions,
  };
}

/** 막혔을 때 그 화면과 셸에 간 명령들을 남긴다(`BACKGROUND_GATE_DEBUG`가 있을 때만). */
async function debugShot(page) {
  if (!process.env.BACKGROUND_GATE_DEBUG) return;
  await page.screenshot({ path: process.env.BACKGROUND_GATE_DEBUG });
  console.error(await page.evaluate(() => JSON.stringify(window.__invokes.map((c) => c.cmd))));
}

/** 장면 G 의 1:1 DM(나와 PEER). */
const DM_ID = "00000000-0000-7000-8000-0000000002d1";

/**
 * `PUT …/channels/{id}/read-state`(읽음 위치 올리기)를 받는 서버 흉내(장면 I·J). 받은 요청을 `puts`에 적고, 그 줄의 읽음 위치를 올린다.
 * 서버처럼 그 채널의 최신 번호까지만 올린다(`LEAST(요청, latest_seq)`). 위치가 최신에 닿으면 멘션 수도 0이 된다(서버는 위치 뒤의 멘션만 센다).
 */
async function installReadPut(context, backend, puts) {
  await context.route(/\/channels\/[^/]+\/read-state$/, async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.fallback();
    const channelId = new URL(request.url()).pathname.split("/channels/")[1].split("/")[0].toUpperCase();
    const body = JSON.parse(request.postData() ?? "{}");
    puts.push({ at: Date.now(), channelId, seq: body.last_read_seq, intent: body.read_intent ?? null });
    let row = null;
    backend.state.readStates = backend.state.readStates.map((r) => {
      if (r.channel_id !== channelId) return r;
      const read = Math.max(r.last_read_seq, Math.min(Number(body.last_read_seq), r.latest_seq));
      row = { ...r, last_read_seq: read, unread_count: Math.max(0, r.latest_seq - read), mention_count: read >= r.latest_seq ? 0 : r.mention_count };
      return row;
    });
    return route.fulfill({ status: row === null ? 404 : 200, contentType: "application/json", body: JSON.stringify(row ?? {}) });
  });
}

async function openScene(browser, { dm = false, readPuts = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const backend = await installBackend(context, port, { live: true, pingSeconds: 25 });
  backend.state.readStates = CHANNELS.map((channel) => readStateRow(channel.id, channel.id === GENERAL_ID ? 9 : 3, channel.id === GENERAL_ID ? 9 : 3, 0));
  if (dm) {
    // 나중에 건 길이 먼저 답한다(Playwright): 채널 목록에 DM 하나를 더한다.
    const direct = { id: DM_ID, workspaceId: WORKSPACE_ID, kind: "dm", name: "", muted: false, memberIds: [ME, PEER] };
    await context.route(/\/workspaces\/[^/]+\/channels$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [...CHANNELS, direct] }) })
    );
    backend.state.readStates.push(readStateRow(DM_ID, 2, 2, 0));
  }
  if (readPuts !== null) await installReadPut(context, backend, readPuts);
  const page = await context.newPage();
  await installPageShims(page);
  try {
    await signIn(page, origin);
  } catch (error) {
    await debugShot(page);
    throw error;
  }
  // 데스크탑은 처음 들어온 판에 「업데이트 소식」을 띄운다: 이 게이트가 재는 것이 아니므로 닫는다.
  for (let i = 0; i < 20; i += 1) {
    if ((await page.locator('[data-overlay-layer="scrim"][data-state="open"]').count()) === 0) break;
    await page.keyboard.press("Escape");
    await sleep(150);
  }
  try {
    await openGeneral(page);
  } catch (error) {
    await debugShot(page);
    throw error;
  }
  // 레일이 다 붙을 때까지(타임라인·알림 레일·개인 채널).
  await page.waitForFunction(() => window.__spike?.connStatus === "connected", null, { timeout: 15_000 });
  await sleep(1_500);
  return { context, page, backend };
}

/** 마지막으로 셸에 보낸 메뉴 막대 상태의 수(없으면 null). */
const trayUnread = (page) =>
  page.evaluate(() => {
    const sent = window.__invokes.filter((call) => call.cmd === "tray_status_set");
    return sent.length === 0 ? null : sent[sent.length - 1].args.status.unread;
  });

/** 조건이 참이 되기까지 걸린 시간(ms). 마감까지 안 되면 null. */
async function timeUntil(page, fn, arg, timeoutMs) {
  const started = Date.now();
  try {
    await page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 20 });
    return Date.now() - started;
  } catch {
    return null;
  }
}

const rowVisible = (id) => {
  const node = document.querySelector(`[data-message-id="${id}"]`);
  return node !== null;
};

async function scrollerMetrics(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    return { distance: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight), scrollTop: node.scrollTop };
  }, SCROLLER);
}

/** 다른 사람이 연 채널(general)에 보낸 새 글: 기록·REST 꼬리에 남기고 레일에 발행한다(죽은 소켓은 못 받는다). */
function peerSendsInGeneral(backend, seq, body) {
  const row = peerMessage(seq, body);
  backend.state.extraMessages.push(row);
  backend.state.readStates = backend.state.readStates.map((r) =>
    r.channel_id === GENERAL_ID.toUpperCase() ? { ...r, latest_seq: seq, unread_count: seq - r.last_read_seq } : r
  );
  backend.publish(channelRail(GENERAL_ID), messageNewFrame(row));
  return row;
}

async function sceneA(browser) {
  const { context, page, backend } = await openScene(browser);
  try {
    await page.evaluate(() => window.__away());
    await sleep(2_000);
    check((await trayUnread(page)) === 0, "A: 시작할 때 메뉴 막대 점이 이미 켜져 있다");
    // 다른 기기의 사람이 열려 있지 않은 채널에서 나를 멘션한다. 서버는 같은 트랜잭션에서 멘션 수를 올리고(읽음 투영),
    // 메시지 프레임(채널)과 인박스 신호(개인 채널)를 보낸다.
    const row = peerMessage(4, "확인 부탁해요", {
      channelId: OTHER.id,
      props: { mention_member_ids: [ME.toUpperCase()] },
    });
    backend.state.readStates = backend.state.readStates.map((r) =>
      r.channel_id === OTHER.id.toUpperCase() ? { ...r, latest_seq: 4, unread_count: 1, mention_count: 1 } : r
    );
    const t0 = Date.now();
    backend.publish(channelRail(OTHER.id), messageNewFrame(row));
    backend.publish(personalRail, { type: "inbox_item.created", v: 1, ts: t0, payload: { item_id: "0199aa11-4444-7000-8000-000000000001" } });
    const ms = await timeUntil(
      page,
      () => {
        const sent = window.__invokes.filter((call) => call.cmd === "tray_status_set");
        return sent.length > 0 && sent[sent.length - 1].args.status.unread > 0;
      },
      null,
      40_000
    );
    results.push({ scene: "A", label: "뒤에 있는 동안 멘션 → 메뉴 막대 점", ms, readStateFetches: backend.state.readStateFetches.filter((at) => at >= t0).length });
    check(ms !== null && ms <= 5_000, `A: 메뉴 막대 점까지 ${ms}ms (5초 안이어야)`);
  } finally {
    await context.close();
  }
}

/**
 * 웹뷰가 `ms` 동안 돌지 않은 것처럼: 페이지의 스크립트 줄을 그만큼 붙잡는다. 그동안 타이머도 소켓 처리도 돌지 못하고, 풀리면 밀린
 * 타이머가 늦게 운다(맥 잠자기·WKWebView 멈춤과 같은 모양). `onFrozen`은 붙잡힌 동안 서버 쪽에서 할 일이다.
 */
async function freezeFor(page, ms, onFrozen = () => {}) {
  const held = page.evaluate((until) => {
    while (Date.now() < until) {
      /* 붙잡는다 */
    }
  }, Date.now() + ms);
  await sleep(300);
  onFrozen();
  await held;
}

/** B·E 공통: 뒤로 → 웹뷰 멈춤 + 소켓 조용히 죽음 → 그 사이 새 글 → 풀림 → 앞으로(부르는 쪽). */
async function awayFrozen(page, backend, awayMs, bodies, firstSeq = 10) {
  await page.evaluate(() => window.__away());
  let rows = [];
  await freezeFor(page, awayMs, () => {
    backend.silenceSockets();
    rows = bodies.map((body, i) => peerSendsInGeneral(backend, firstSeq + i, body));
  });
  return rows;
}

async function sceneB(browser) {
  const { context, page, backend } = await openScene(browser);
  try {
    const before = await scrollerMetrics(page);
    const handshakes = backend.state.handshakes;
    const rows = await awayFrozen(page, backend, 35_000, ["뒤에 있는 동안 온 글 하나", "뒤에 있는 동안 온 글 둘"]);
    const uiBefore = await page.evaluate(() => window.__connectionUi.length);
    const t0 = Date.now();
    await page.evaluate(() => window.__back());
    const ms = await timeUntil(page, rowVisible, rows[rows.length - 1].id.toLowerCase(), 40_000);
    await sleep(2_500); // 카드가 1초 침묵 뒤에 서는지 지켜본다
    const ui = await page.evaluate((from) => window.__connectionUi.slice(from), uiBefore);
    const after = await scrollerMetrics(page);
    results.push({
      scene: "B",
      label: "35초 뒤(웹뷰 멈춤·소켓 조용히 죽음) → 앞으로 온 순간부터 새 글",
      ms,
      reconnects: backend.state.handshakes - handshakes,
      connectionUi: ui.map((u) => `${u.at - t0}ms ${u.what}`),
      bottomBefore: before?.distance,
      bottomAfter: after?.distance,
    });
    check(ms !== null && ms <= 1_000, `B: 앞으로 온 뒤 새 글까지 ${ms}ms (1초 안이어야)`);
    check(ui.length === 0, `B: 다시 붙는 화면이 섰다: ${ui.map((u) => u.what).join(" / ")}`);
    check(after !== null && after.distance <= 1, `B: 바닥에 있던 목록이 바닥에서 ${after?.distance}px 떨어졌다`);
  } finally {
    await context.close();
  }
}

async function sceneC(browser) {
  const { context, page, backend } = await openScene(browser);
  try {
    const handshakes = backend.state.handshakes;
    await page.evaluate(() => window.__away());
    // 네트워크가 끊겼다: 붙은 소켓이 닫히고 새 연결도 거절된다. 클라이언트는 다시 붙기를 미루며 기다린다.
    backend.socket("refuse");
    backend.dropSockets();
    await sleep(17_000);
    // 네트워크가 돌아왔다(아직 뒤에 있다). 그 사이 새 글.
    backend.socket("ok");
    const row = peerSendsInGeneral(backend, 10, "끊긴 동안 온 글");
    // 사람이 돌아오는 순간은 네트워크가 돌아온 직후다(깬 맥을 여는 순간). 클라이언트의 다음 시도는 백오프(최대 20초)에 달렸다.
    await sleep(200);
    const already = await page.evaluate(rowVisible, row.id.toLowerCase());
    const t0 = Date.now();
    await page.evaluate(() => window.__back());
    const ms = already ? 0 : await timeUntil(page, rowVisible, row.id.toLowerCase(), 40_000);
    results.push({
      scene: "C",
      label: "20초 뒤(그동안 네트워크 끊김, 다시 붙기 대기 중) → 앞으로 온 순간부터 새 글",
      ms,
      alreadyBeforeReturn: already,
      attempts: backend.state.handshakes - handshakes,
      at: t0,
    });
    check(ms !== null && ms <= 1_000, `C: 앞으로 온 뒤 새 글까지 ${ms}ms (1초 안이어야)`);
  } finally {
    await context.close();
  }
}

async function sceneD(browser) {
  const { context, page, backend } = await openScene(browser);
  try {
    // 창은 앞에 있다(사건 없음). 맥이 잠들었다: 웹뷰가 멈추고, 소켓은 닫힘 없이 죽는다. 그 사이 새 글.
    let row = null;
    await freezeFor(page, 20_000, () => {
      backend.silenceSockets();
      row = peerSendsInGeneral(backend, 10, "자는 동안 온 글");
    });
    const t0 = Date.now();
    const ms = await timeUntil(page, rowVisible, row.id.toLowerCase(), 45_000);
    results.push({ scene: "D", label: "앞에 둔 채 20초 잠자기 → 깬 순간부터 새 글", ms, at: t0 });
    check(ms !== null && ms <= 5_000, `D: 깬 뒤 새 글까지 ${ms}ms (5초 안이어야)`);
  } finally {
    await context.close();
  }
}

async function sceneE(browser) {
  const { context, page, backend } = await openScene(browser);
  try {
    // 읽던 줄을 화면 가운데쯤에 둔다: 목록이 짧으면 위로 올릴 수 없으니 과거 글을 먼저 채운다.
    const filler = Array.from({ length: 30 }, (_, i) => peerSendsInGeneral(backend, 100 + i, `채우는 글 ${i + 1}`));
    await page.waitForFunction(rowVisible, filler[filler.length - 1].id.toLowerCase(), { timeout: 10_000 });
    await sleep(800);
    const anchor = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) / 2);
      return true;
    }, SCROLLER);
    await sleep(600);
    const pick = () =>
      page.evaluate((selector) => {
        const node = document.querySelector(selector);
        const box = node.getBoundingClientRect();
        const rows = [...node.querySelectorAll("[data-message-id]")];
        const row = rows.find((el) => {
          const r = el.getBoundingClientRect();
          return r.top > box.top + 40 && r.bottom < box.bottom - 40;
        });
        return row ? { id: row.getAttribute("data-message-id"), top: row.getBoundingClientRect().top - box.top } : null;
      }, SCROLLER);
    const start = await pick();
    // 새 글은 채운 글보다 뒤(seq)다: 따라잡은 글은 목록 아래에 붙고, 위에서 읽던 줄은 그대로여야 한다.
    const rows = await awayFrozen(
      page,
      backend,
      35_000,
      Array.from({ length: 20 }, (_, i) => `위로 올려 읽는 동안 온 글 ${i + 1}`),
      200
    );
    await page.evaluate(() => window.__back());
    await page.waitForFunction(
      (id) => {
        const node = document.querySelector('[data-testid="timeline-virtuoso"]');
        return node !== null && node.scrollHeight > 0 && id !== null;
      },
      rows[0].id,
      { timeout: 10_000 }
    );
    await sleep(2_500);
    const end = await page.evaluate(
      ({ selector, id }) => {
        const node = document.querySelector(selector);
        const box = node.getBoundingClientRect();
        const row = node.querySelector(`[data-message-id="${id}"]`);
        return row ? row.getBoundingClientRect().top - box.top : null;
      },
      { selector: SCROLLER, id: start?.id }
    );
    const shift = start && end !== null ? Math.round(Math.abs(end - start.top) * 10) / 10 : null;
    results.push({ scene: "E", label: "위로 올려 읽던 줄이 20건을 따라잡은 뒤 움직인 거리(px)", shift, anchor });
    check(shift !== null && shift <= 2, `E: 읽던 줄이 ${shift}px 움직였다(2px 안이어야)`);
  } finally {
    await context.close();
  }
}

async function sceneG(browser) {
  const { context, page, backend } = await openScene(browser, { dm: true });
  try {
    await page.evaluate(() => window.__away());
    await sleep(2_000);
    check((await trayUnread(page)) === 0, "G: 시작할 때 메뉴 막대 점이 이미 켜져 있다");
    // 다른 기기의 사람이 나에게 DM. 서버는 같은 트랜잭션에서 DM 의 안 읽음(읽음 투영)을 올리고, 메시지 프레임과 인박스 신호를 보낸다.
    const row = peerMessage(3, "잠깐 통화 돼요?", { channelId: DM_ID });
    backend.state.readStates = backend.state.readStates.map((r) =>
      r.channel_id === DM_ID.toUpperCase() ? { ...r, latest_seq: 3, unread_count: 1 } : r
    );
    const t0 = Date.now();
    backend.publish(channelRail(DM_ID), messageNewFrame(row));
    backend.publish(personalRail, { type: "inbox_item.created", v: 1, ts: t0, payload: { item_id: "0199aa11-4444-7000-8000-000000000002" } });
    const ms = await timeUntil(
      page,
      () => {
        const sent = window.__invokes.filter((call) => call.cmd === "tray_status_set");
        return sent.length > 0 && sent[sent.length - 1].args.status.unread > 0;
      },
      null,
      15_000
    );
    results.push({ scene: "G", label: "뒤에 있는 동안 DM → 메뉴 막대 점", ms });
    check(ms !== null && ms <= 5_000, `G: DM 뒤 메뉴 막대 점까지 ${ms}ms (5초 안이어야, null = 켜지지 않음)`);
  } finally {
    await context.close();
  }
}

/**
 * 뒤에 있는 동안 내가 따라가는 스레드에 남이 답글 → 메뉴 막대 점, 그리고 다른 기기에서 그 스레드를 읽음 → 점이 꺼짐(서버 #5667 흉내).
 * 서버는 읽음 투영 줄에 `followed_unread_reply_count`를 싣고, 값이 바뀌면 개인 채널로 id만 실은 `followed_unread.updated`를 보낸다.
 * 인박스 신호는 보내지 않는다: 직접 따라가기만 누른 사람에게는 인박스 항목이 없다(migration 126). 그래서 이 장면은 새 신호의 길만 잰다.
 * 멘션 수는 0 그대로다(겹침 빼기가 이 장면을 가리지 않게). 장면 A–G 의 투영 줄에는 이 필드가 없다(= #5667 전 서버, 그대로 통과해야 한다).
 */
async function sceneH(browser) {
  const { context, page, backend } = await openScene(browser);
  const followed = (n) => {
    backend.state.readStates = backend.state.readStates.map((r) => ({
      ...r,
      followed_unread_reply_count: r.channel_id === OTHER.id.toUpperCase() ? n : 0,
    }));
  };
  const signal = (ts) =>
    backend.publish(personalRail, {
      type: "followed_unread.updated",
      v: 1,
      ts,
      payload: {
        workspace_id: WORKSPACE_ID.toUpperCase(),
        member_id: ME.toUpperCase(),
        channel_id: OTHER.id.toUpperCase(),
        root_id: "00000000-0000-7000-8000-0000000003e1",
      },
    });
  const trayLit = (want) =>
    timeUntil(
      page,
      (on) => {
        const sent = window.__invokes.filter((call) => call.cmd === "tray_status_set");
        const unread = sent.length === 0 ? 0 : sent[sent.length - 1].args.status.unread;
        return on ? unread > 0 : sent.length > 0 && unread === 0;
      },
      want,
      15_000
    );
  try {
    followed(0);
    await page.evaluate(() => window.__away());
    await sleep(2_000);
    check((await trayUnread(page)) === 0, "H: 시작할 때 메뉴 막대 점이 이미 켜져 있다");
    followed(1);
    const t0 = Date.now();
    signal(t0);
    const onMs = await trayLit(true);
    const fetchesOn = backend.state.readStateFetches.filter((at) => at >= t0).length;
    let offMs = null;
    if (onMs !== null) {
      // 폰에서 그 스레드를 읽었다: 서버 값이 0이 되고 같은 신호가 온다.
      followed(0);
      signal(Date.now());
      offMs = await trayLit(false);
    }
    results.push({ scene: "H", label: "뒤에 있는 동안 따라가는 스레드에 답글 → 메뉴 막대 점, 다른 기기에서 읽음 → 꺼짐", ms: onMs, offMs, readStateFetches: fetchesOn });
    check(onMs !== null && onMs <= 5_000, `H: 답글 뒤 메뉴 막대 점까지 ${onMs}ms (5초 안이어야, null = 켜지지 않음)`);
    check(offMs !== null && offMs <= 5_000, `H: 다른 기기에서 읽은 뒤 점이 꺼지기까지 ${offMs}ms (5초 안이어야, null = 꺼지지 않음)`);
  } finally {
    await context.close();
  }
}

/**
 * 장면 I(열어 둔 채널에서 멘션)·J(열어 둔 DM): 창을 치운 채 열어 둔 대화에 나를 부르는 글이 온다. 예전에는 숨은 페이지가 곧바로 그 글까지
 * 읽음으로 올려서(`PUT read-state`) 점이 켜지지 않았고 서버의 안 읽음(다른 기기의 표시)까지 지워졌다. 이제는 점이 켜져 남고 읽음 요청은 0건,
 * 앞으로 오면 그때 읽음이 오르고 점이 꺼진다.
 */
async function openConversationScene(browser, { dm }) {
  const scene = dm ? "J" : "I";
  const channelId = (dm ? DM_ID : GENERAL_ID).toUpperCase();
  const puts = [];
  const { context, page, backend } = await openScene(browser, { dm, readPuts: puts });
  const trayLit = (on) =>
    timeUntil(
      page,
      (want) => {
        const sent = window.__invokes.filter((call) => call.cmd === "tray_status_set");
        const unread = sent.length === 0 ? 0 : sent[sent.length - 1].args.status.unread;
        return want ? unread > 0 : sent.length > 0 && unread === 0;
      },
      on,
      15_000
    );
  try {
    if (dm) {
      await page.locator(`[data-channel-id="${DM_ID}"]`).first().click();
      await page.getByTestId("composer-input").waitFor({ state: "visible" });
      await sleep(1_500);
    }
    await page.evaluate(() => window.__away());
    await sleep(2_000);
    check((await trayUnread(page)) === 0, `${scene}: 시작할 때 메뉴 막대 점이 이미 켜져 있다`);
    const seq = backend.state.readStates.find((r) => r.channel_id === channelId).latest_seq + 1;
    const row = dm
      ? peerMessage(seq, "열어 둔 DM 으로 온 글", { channelId: DM_ID })
      : peerMessage(seq, "열어 둔 채널에서 부르는 글", { props: { mention_member_ids: [ME.toUpperCase()] } });
    backend.state.extraMessages.push(row);
    backend.state.readStates = backend.state.readStates.map((r) =>
      r.channel_id === channelId
        ? { ...r, latest_seq: seq, unread_count: seq - r.last_read_seq, mention_count: r.mention_count + (dm ? 0 : 1) }
        : r
    );
    const t0 = Date.now();
    backend.publish(channelRail(channelId.toLowerCase()), messageNewFrame(row));
    backend.publish(personalRail, {
      type: "inbox_item.created",
      v: 1,
      ts: t0,
      payload: { item_id: dm ? "0199aa11-4444-7000-8000-000000000012" : "0199aa11-4444-7000-8000-000000000011" },
    });
    const onMs = await trayLit(true);
    await sleep(3_000); // 켜진 채 남는가, 그동안 숨은 페이지가 읽음을 올리는가
    const awayPuts = puts.filter((p) => p.at >= t0 && p.channelId === channelId).length;
    const litAfterHold = ((await trayUnread(page)) ?? 0) > 0;
    const tBack = Date.now();
    await page.evaluate(() => window.__back());
    const offMs = await trayLit(false);
    await sleep(500);
    const backPuts = puts.filter((p) => p.at >= tBack && p.channelId === channelId).map((p) => p.seq);
    const serverUnread = backend.state.readStates.find((r) => r.channel_id === channelId).unread_count;
    results.push({
      scene,
      label: `창을 치운 채 열어 둔 ${dm ? "DM 에 새 글" : "채널에서 멘션"} → 점, 앞으로 오면 읽음`,
      ms: onMs,
      awayPuts,
      litAfterHold,
      offMs,
      backPuts,
      serverUnreadAfterBack: serverUnread,
    });
    check(onMs !== null && onMs <= 1_000, `${scene}: 메뉴 막대 점까지 ${onMs}ms (1초 안이어야, null = 켜지지 않음)`);
    check(awayPuts === 0, `${scene}: 치워 둔 동안 읽음 요청 ${awayPuts}건 (0건이어야)`);
    check(litAfterHold, `${scene}: 점이 켜진 채 남지 않았다`);
    check(backPuts.includes(seq), `${scene}: 앞으로 온 뒤 읽음 요청이 새 글(${seq})까지 오르지 않았다: ${JSON.stringify(backPuts)}`);
    check(offMs !== null && offMs <= 5_000, `${scene}: 앞으로 온 뒤 점이 꺼지기까지 ${offMs}ms (5초 안이어야)`);
  } finally {
    await context.close();
  }
}
const sceneI = (browser) => openConversationScene(browser, { dm: false });
const sceneJ = (browser) => openConversationScene(browser, { dm: true });

async function sceneF(browser) {
  const { context, page, backend } = await openScene(browser);
  try {
    const handshakes = backend.state.handshakes;
    await page.evaluate(() => window.__away());
    await sleep(20_000);
    const row = peerSendsInGeneral(backend, 10, "뒤에 있는 동안 바로 온 글");
    await sleep(20_000); // 그동안 서버 핑(25초 간격)이 적어도 한 번 온다
    const already = await page.evaluate(rowVisible, row.id.toLowerCase());
    const uiBefore = await page.evaluate(() => window.__connectionUi.length);
    await page.evaluate(() => window.__back());
    await sleep(2_500);
    const ui = await page.evaluate((from) => window.__connectionUi.slice(from), uiBefore);
    const reconnects = backend.state.handshakes - handshakes;
    results.push({
      scene: "F",
      label: "뒤에 40초(웹뷰·소켓 살아 있음) → 돌아와도 다시 붙지 않고 글은 이미 있다",
      alreadyBeforeReturn: already,
      reconnects,
      connectionUi: ui.map((u) => u.what),
    });
    check(already, "F: 살아 있는 소켓으로 온 글이 돌아오기 전에 들어와 있지 않다");
    check(reconnects === 0, `F: 살아 있는 소켓을 돌아온 순간 다시 열었다(다시 붙기 ${reconnects}회)`);
    check(ui.length === 0, `F: 돌아온 순간 연결 화면이 섰다: ${ui.map((u) => u.what).join(" / ")}`);
  } finally {
    await context.close();
  }
}

async function main() {
  const dist = process.env.BACKGROUND_GATE_DIST;
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "BACKGROUND_GATE_PORT",
    ...(dist ? { extraArgs: ["--outDir", resolve(dist)] } : {}),
  });
  try {
    const browser = await engine.launch();
    try {
      const scenes = { A: sceneA, B: sceneB, C: sceneC, D: sceneD, E: sceneE, F: sceneF, G: sceneG, H: sceneH, I: sceneI, J: sceneJ };
      for (const [name, run] of Object.entries(scenes)) {
        if (only !== null && !only.has(name)) continue;
        await run(browser);
        console.log(JSON.stringify(results[results.length - 1]));
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ dist: dist ?? "dist", engine: engine.name(), results, failures }, null, 2));
  }
  if (measureOnly) {
    for (const line of failures) console.log(`MEASURE (not asserted): ${line}`);
    return;
  }
  if (failures.length > 0) {
    for (const line of failures) console.error(`GATE FAIL: ${line}`);
    process.exit(1);
  }
  for (const r of results) console.log(`GATE PASS: ${r.scene} ${r.label}`);
}

await main();
