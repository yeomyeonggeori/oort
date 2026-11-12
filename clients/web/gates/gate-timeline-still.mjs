#!/usr/bin/env node
// GATE: #5641 — 흔들림 장면표 v0. 「대화 흔들림 0」을 버그마다 따로 재지 않고 한 표로 잰다.
//
// 표: 장면 × 엔진(WebKit · Chromium, Firefox 는 Playwright 가 기대하는 판이 캐시에 있을 때만 기록) × 폭(1280 · 900 · 390).
// 칸마다 숫자 넷(`still-measure.mjs`): ① 되돌아옴 횟수 ② 이유 없는 이동 px ③ 바닥 거리 ④ 저절로 선 「최신 메시지로 이동」.
// 예상 이동(새 줄이 붙어 위 줄이 올라감)은 「몇 번 · 몇 px」로 따로 적는다.
//
// 새 장면(이 파일이 잰다 — 실제 번들 · 실제 가상 목록, 가짜 서버는 `timeline-fake-backend.mjs`):
//   진입         대화에 들어갈 때, 첫 줄이 그려진 뒤 2초 동안 가장 새 줄의 아래 끝(창 좌표) 이동 ≤ 1px · 필 0. 재기 전에 바닥으로 다시
//                놓지 않는다. 「진입+카드」는 같은 장면에 링크 카드가 0.7초 늦게 오는 판(카드를 메시지마다 따로 읽는 길, #5469).
//   링크 카드    서버가 카드를 다 읽고 알림(`message.unfurl`) — 맨 아래: 마지막 줄 ≤ 1px · 바닥 거리 ≤ 1px · 되돌아옴 0 · 필 0 /
//                위 읽기: 화면 위 밖의 줄에 카드가 붙을 때 보던 줄(창 좌표) ≤ 2px · 되돌아옴 0.
//   반응         반응 하나가 붙고 떨어짐(`reaction.added` · `reaction.removed`) — 링크 카드와 같은 문턱.
//   더 불러오기  맨 위에 닿아 옛 쪽이 앞에 붙음(가상 목록의 `firstItemIndex` 보정) — 보던 줄 ≤ 2px · 되돌아옴 0.
// 기존 게이트 셋의 장면은 다시 짜지 않고 불러 합친다(자식 프로세스로 돌리고 `*_OUT` 의 프레임 기록에서 숫자 넷을 낸다). 칸의 판정은
// 그 게이트의 판정 그대로이고 숫자 넷은 곁에 적는다:
//   typing-jitter(입력 · 상대 작성 중) · expression-jitter(가만히 — 다시 읽기 · 포커스 · 세대 교체 · 다시 연결 · 오프라인 · 등록/숨김 ·
//   연결 끊김 1280 · 900 · 390) · send-follow(위에서 보내기 · 남의 말 · 스레드 · ⑤ 시계 어긋남 · ⑥ 스레드 위 읽기(기록만) ·
//   ⑦ 분 경계 연달아 두 번(기록만)).
//
// 부하 규칙: 장면마다 재기 전 1분 평균 부하를 적고, 문턱(`TIMELINE_STILL_LOAD_MAX`, 기본 12)을 넘으면 그 장면은 「재지 않음」이다 —
// 통과도 실패도 아니다. 마지막 판정은 `finalVerdict`(still-measure.mjs): 판정한 칸이 0이면 FAIL(종료 1), 재지 않음 · 알려진 장면 못
// 만듦 · 꼭 재야 하는 엔진(WebKit · Chromium)의 판 없음이 하나라도 있으면 PASS 가 아니라 NOT-MEASURED(종료 3)다.
// 위치(px · 되돌아옴) 게이트다. 속도(fps) 게이트(`gate:scroll`)는 부하를 타는 본질이 달라 이 표에 섞지 않는다.
//
// 알려진 실패(`TIMELINE_KNOWN_FAILURES`, still-measure.mjs)는 수리를 다른 칸에 둔 칸이다. 정확한 칸 키 · 수리 이슈 번호 · 잰 값에 붙인
// 상한과 함께 적고, 그 테두리 안일 때만 「알려진 실패」로 판정에서 뺀다. 고쳐져 통과하면 「목록에서 빼라」고 알린다.
//
// 사용: npm run build && node gates/gate-timeline-still.mjs
//   TIMELINE_STILL_PORT=<포트>        새 장면의 미리보기 포트(기본 5240). 기존 게이트는 +1 · +2 · +3 을 쓴다
//   TIMELINE_STILL_ENGINES=webkit,chromium,firefox   (기본 셋 다. firefox 는 판이 없으면 「못 잼」 한 줄)
//   TIMELINE_STILL_WIDTHS=1280,900,390               (기본 셋 다)
//   TIMELINE_STILL_SCENES=entry,entry-card,card,reaction,older   새 장면 고르기
//   TIMELINE_STILL_SETS=new,typing,expression,send   새 장면 · 불러올 기존 게이트 고르기
//   TIMELINE_STILL_LOAD_MAX=<수>       부하 문턱(기본 12)
//   TIMELINE_STILL_LOAD_WAIT=<초>      장면마다 부하가 문턱 아래로 내려오기를 기다리는 최대 시간(기본 0 = 기다리지 않음)
//   TIMELINE_STILL_REPEAT=<N>          새 장면을 N번 되풀이(1 이상의 정수, 기본 1)
//   TIMELINE_STILL_DIST=<폴더>         dist 대신 이 번들(기존 게이트에도 `*_DIST` 로 넘긴다 — 사보타주 번들)
//   TIMELINE_STILL_OUT=<폴더>          표(timeline-still.json · timeline-still.md)와 기존 게이트의 기록을 남긴다

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { printEngineAnchorHeader, scrollerOverflowAnchor } from "./engine-anchor.mjs";
import { startGuardedPreview } from "./preview-guard.mjs";
import {
  DEFAULT_LOAD_MAX,
  entrySettle,
  finalVerdict,
  frameGaps,
  installEntryRecorder,
  judgeCell,
  knownFailureFor,
  listEnv,
  loadNow,
  numbersFromRecord,
  positiveIntEnv,
  positiveNumberEnv,
  readEntryRecord,
  staleKnown,
  startStillRecorder,
  stillNumbers,
  stopStillRecorder,
  withinKnown,
} from "./still-measure.mjs";
import {
  ANCHOR_TEXT,
  BODIES,
  history,
  installBackend,
  openDm,
  placeAnchor,
  scrollerSelector,
  unfurlCard,
  wait,
} from "./timeline-fake-backend.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINES = ["webkit", "chromium", "firefox"];
const WIDTHS = ["1280", "900", "390"];
const SCENES = ["entry", "entry-card", "card", "reaction", "older"];
const SETS = ["new", "typing", "expression", "send"];
// 환경 값은 미리보기를 띄우기 전에 읽는다: 틀린 값은 장면을 건너뛰지 않고 여기서 실패한다.
const port = positiveIntEnv("TIMELINE_STILL_PORT", 5240);
const origin = `http://127.0.0.1:${port}`;
const engineNames = listEnv("TIMELINE_STILL_ENGINES", ENGINES);
const widths = listEnv("TIMELINE_STILL_WIDTHS", WIDTHS).map(Number);
const sceneNames = listEnv("TIMELINE_STILL_SCENES", SCENES);
const setNames = listEnv("TIMELINE_STILL_SETS", SETS);
const loadMax = positiveNumberEnv("TIMELINE_STILL_LOAD_MAX", DEFAULT_LOAD_MAX);
const loadWaitS = process.env.TIMELINE_STILL_LOAD_WAIT ? positiveIntEnv("TIMELINE_STILL_LOAD_WAIT", 0) : 0;
const repeat = positiveIntEnv("TIMELINE_STILL_REPEAT", 1);
const distOverride = process.env.TIMELINE_STILL_DIST ? resolve(process.env.TIMELINE_STILL_DIST) : null;
const outDir = process.env.TIMELINE_STILL_OUT ? resolve(process.env.TIMELINE_STILL_OUT) : null;

const VIEWPORTS = { 1280: { width: 1280, height: 800 }, 900: { width: 900, height: 800 }, 390: { width: 390, height: 844 } };
const TYPING_VIEWPORTS = { 1280: "1280x800", 900: "900x700", 390: "390x844" };

// ---------------------------------------------------------------------------------------------- 대화 픽스처

/**
 * 옛 줄 300개 + expression-jitter 의 62줄(첫 쪽 50줄 · 위로 일곱 쪽 더). 진입 때 가상 목록이 맨 위 줄을 한 번 그리며 옛 쪽을 스스로
 * 부르는 일이 있어(실측: 진입 첫 프레임 scrollTop 0), 위로 더 불러오기 장면에 늘 다음 쪽이 남게 넉넉히 둔다.
 */
const OLDER = 300;
const LAST = BODIES.length - 1;
const ANCHOR_INDEX = BODIES.indexOf(ANCHOR_TEXT);
/** 진입 장면에서 카드가 늦게 오는 줄(맨 아래 쪽). */
const ENTRY_CARD = 58;
const URL_BODIES = {
  [LAST]: "배포 노트 정리했어요 https://docs.example.test/notes/release",
  [ENTRY_CARD]: "체크리스트는 여기 있어요 https://docs.example.test/qa/checklist",
  // 위 읽기 장면의 재료: 보던 줄(30)보다 위, 화면 위 밖에 붙어 있을 만한 줄들(첫 쪽은 본문 12번부터). 어느 것이 화면 위 밖인지는 폭마다
  // 달라 재기 직전에 고른다(15 · 17 은 이모티콘 줄이라 비운다).
  12: "지난 회의 자료예요 https://docs.example.test/meetings/weekly",
  13: "설계 문서 링크예요 https://docs.example.test/design/timeline",
  14: "참고 글 하나 붙여요 https://docs.example.test/notes/anchoring",
  16: "로그 대시보드는 여기요 https://docs.example.test/ops/logs",
  18: "어제 정리한 표예요 https://docs.example.test/sheets/qa",
  20: "회고 문서예요 https://docs.example.test/retro/weekly",
  22: "일정표 링크예요 https://docs.example.test/plan/sprint",
};
const rows = history({ olderCount: OLDER, overrides: URL_BODIES });
const rowAt = (bodyIndex) => rows[bodyIndex + OLDER];
const urlOf = (row) => /https?:\/\/\S+/.exec(row.body)?.[0] ?? null;

// ---------------------------------------------------------------------------------------------- 부하

/** 재기 전 부하를 본다. 문턱 아래면 그 값을, 넘으면 null(기다릴 수 있으면 기다린 뒤). */
async function loadGate() {
  const deadline = Date.now() + loadWaitS * 1000;
  let load = loadNow();
  while (load > loadMax && Date.now() < deadline) {
    await wait(5_000);
    load = loadNow();
  }
  return { load, ok: load <= loadMax };
}

const cells = [];
/** 끝낼 때 함께 닫을 것(미리보기 · 자식 게이트). 신호로 끊겨도 남기지 않는다. */
let activeServer = null;
let activeChild = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    activeChild?.kill("SIGTERM");
    Promise.resolve(activeServer?.stop())
      .catch(() => {})
      .finally(() => process.exit(130));
  });
}

function pushCell(cell) {
  // 위를 읽는 장면의 바닥 거리는 재는 값이 아니다(일부러 떨어져 있다) — 어느 묶음의 칸이든 비운다.
  const numbers = cell.kind === "reading" && cell.numbers ? { ...cell.numbers, maxGapPx: null } : cell.numbers;
  cells.push({ known: null, note: "", ...cell, numbers });
}

/** 마지막으로 잰 창의 프레임(실패 칸의 흔적으로 남긴다). */
let lastRecord = null;

/**
 * 새 장면 한 칸: 부하를 보고, 재고, 숫자 넷과 판정을 적는다. 부하로 재지 않으면 `onSkip` 으로 장면의 손만 쓴다(뒤 장면이 기대는 상태 —
 * 반응 제거는 반응 추가가 붙인 것을 뗀다).
 */
async function measureCell(meta, run, { onSkip = null } = {}) {
  const gate = await loadGate();
  if (!gate.ok) {
    pushCell({ ...meta, verdict: "재지 않음", loadBefore: gate.load, loadAfter: null, numbers: null, note: `부하 ${gate.load} > ${loadMax}` });
    if (onSkip) await onSkip().catch(() => {});
    return;
  }
  lastRecord = null;
  let result;
  try {
    result = await run();
  } catch (error) {
    result = { numbers: null, verdict: { verdict: "장면 못 만듦", reasons: [String(error.message ?? error).split("\n")[0]] } };
  }
  const loadAfter = loadNow();
  // 그리기 직전 표본을 놓친 창은 통과로 치지 않는다(놓친 프레임에 흔들림이 숨을 수 있다 — #5641 검수 r1 M1). 실패는 그대로 실패다.
  const gaps = lastRecord === null ? null : frameGaps(lastRecord.frames);
  if (gaps?.reason && result.verdict.verdict === "PASS") result.verdict = { verdict: "장면 못 만듦", reasons: [gaps.reason] };
  else if (gaps?.reason) result.verdict.reasons.push(gaps.reason);
  let verdict = result.verdict.verdict;
  const known = knownFailureFor(meta.sceneKey, meta.engine, meta.width);
  if (meta.recordOnly && verdict !== "장면 못 만듦") verdict = `기록만(${verdict})`;
  else if (known?.notBuilt && verdict === "장면 못 만듦" && result.verdict.reasons.some((reason) => reason.startsWith(known.notBuilt))) verdict = "알려진 실패(장면 못 만듦)";
  else if (known !== null && verdict === "FAIL" && withinKnown(known, result.numbers, { kind: meta.kind, unsettled: result.extra?.unsettled ?? 0 })) verdict = "알려진 실패";
  else if (known !== null && verdict === "FAIL") result.verdict.reasons.push(`알려진 실패의 테두리(${known.key} ${known.issue}) 밖`);
  pushCell({
    ...meta,
    verdict,
    reasons: result.verdict.reasons,
    numbers: result.numbers,
    loadBefore: gate.load,
    loadAfter,
    known,
    note: [
      result.note,
      known !== null && verdict === "PASS" ? `알려진 실패 목록(${known.issue})에 있지만 통과` : "",
      gaps?.missed ? `놓친 프레임 ${gaps.missed}` : "",
      gaps?.cross ? `그리기 뒤 값이 달랐던 프레임 ${gaps.cross}` : "",
      loadAfter > loadMax ? `재는 동안 부하가 올랐다(${loadAfter})` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    // 실패 칸의 흔적(수리 칸이 볼 프레임): 판정이 PASS 가 아니면 남긴다(JSON 에만).
    trace: verdict === "PASS" || lastRecord === null ? undefined : lastRecord.frames.map((frame) => [frame.t, frame.watch?.w ?? frame.watch?.last ?? null, frame.top, frame.gap]),
    missed: gaps?.missed ?? null,
    cross: gaps?.cross ?? null,
  });
}

// ---------------------------------------------------------------------------------------------- 새 장면

async function newContext(browser, vp, { unfurls = {} } = {}) {
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, locale: "ko-KR" });
  // 옛 쪽 응답은 0.9초 늦게 온다(더 불러오기 장면만 2.5초로 늘려 재기 창 안에서 붙게 한다).
  const backend = await installBackend(context, { port, rows, paged: true, olderDelayMs: 900, unfurls });
  const page = await context.newPage();
  return { context, backend, page };
}

/** 대화 진입: 첫 줄이 그려진 뒤 2초. 재기 전에 바닥으로 다시 놓지 않는다. */
async function entryScene(browser, engine, vp, { withCard }) {
  const cardRow = rowAt(ENTRY_CARD);
  const unfurls = withCard ? { [cardRow.id]: { restDelayMs: 700, cards: [unfurlCard(cardRow, urlOf(cardRow))] } } : {};
  const { context, backend, page } = await newContext(browser, vp, { unfurls });
  try {
    const newest = rows[rows.length - 1];
    await installEntryRecorder(page, {
      scroller: scrollerSelector,
      startSelector: '[data-message-id^="0199eee"]',
      messageId: newest.id,
      name: "last",
      edge: "bottom",
      windowMs: 2_000,
    });
    await openDm(page, backend, origin, { settle: false });
    const record = await readEntryRecord(page, 20_000, 2_000);
    lastRecord = record;
    // 자리 잡기 전 프레임(머리)과 그 뒤(몸)를 가른다(`entrySettle`). 머리가 있으면 그것만으로 실패다 — 그 프레임들이 그려졌다(검수 r1 H1).
    // 몸의 숫자 넷은 평소 문턱으로 본다. 알려진 실패는 머리 프레임 수(`maxUnsettledFrames`)와 몸의 숫자에 따로 상한을 둔다.
    const settle = entrySettle(record.frames);
    if (settle.body.length === 0) {
      return { numbers: null, verdict: { verdict: "장면 못 만듦", reasons: [`창 안에서 가장 새 줄이 세 프레임 이어 제자리에 선 적이 없다(표본 ${record.frames.length})`] } };
    }
    const numbers = numbersFromRecord({ ...record, frames: settle.body }, { watch: "last" });
    const unsettled = settle.head.length;
    const verdict = judgeCell(numbers, { kind: "entry" });
    if (unsettled > 0 && verdict.verdict !== "장면 못 만듦") {
      verdict.verdict = "FAIL";
      verdict.reasons.push(`첫 줄이 그려진 뒤 ${unsettled}프레임(${settle.body[0].t}ms) 동안 자리 잡지 않은 모양이 그려졌다 — ${settle.summary}`);
    }
    if (withCard) {
      const cardShown = await page.locator(`[data-message-id="${cardRow.id}"] [data-testid="unfurl-card"]`).count();
      if (cardShown === 0 || backend.state.unfurlReads === 0) {
        return { numbers, verdict: { verdict: "장면 못 만듦", reasons: [`카드가 서지 않았다(읽기 ${backend.state.unfurlReads}, 카드 ${cardShown})`] } };
      }
    }
    if (process.env.TIMELINE_STILL_DEBUG === "1") console.log(JSON.stringify(record.frames.slice(0, 60).map((f) => [f.t, f.rows, f.top, f.gap, f.topId?.slice(-4), f.visible, f.watch.last])));
    return {
      numbers,
      verdict,
      extra: { unsettled },
      note: `표본 ${record.frames.length}프레임(그리기 직전) · 자리 잡기 전 ${unsettled}프레임 · 숫자 넷은 그 뒤 ${settle.body.length}프레임 · 진입 중 옛 쪽 읽기 ${backend.state.olderReads}번`,
    };
  } finally {
    await context.close();
  }
}

/** 창 하나를 열고 몸을 돌린 뒤 멈춘다. */
async function recordWindow(page, watch, body, settleMs = 1_500) {
  await startStillRecorder(page, { scroller: scrollerSelector, watch: [watch] });
  await wait(120);
  await body();
  await wait(settleMs);
  const record = await stopStillRecorder(page);
  lastRecord = record;
  if (process.env.TIMELINE_STILL_DEBUG === "1") {
    // 움직인 프레임만 줄여 찍는다(원인 실측용).
    const moved = record.frames.filter((frame, i, all) => i === 0 || frame.watch.w !== all[i - 1].watch.w || frame.sh !== all[i - 1].sh || frame.top !== all[i - 1].top);
    console.log(`[debug] ${JSON.stringify(moved.map((frame) => [frame.t, frame.watch.w, frame.top, frame.sh, frame.gap]))}`);
  }
  return record;
}

const heightOf = (page, messageId) =>
  page.evaluate(
    ({ selector, id }) => {
      const node = document.querySelector(selector)?.querySelector(`[data-message-id="${id}"]`);
      const row = node?.closest("[data-index]") ?? node;
      return row ? Math.round(row.getBoundingClientRect().height * 100) / 100 : null;
    },
    { selector: scrollerSelector, id: messageId }
  );

/** 보던 줄(앵커)보다 위, 화면 위 밖에 **붙어 있는** 줄 가운데 가장 가까운 것(조건에 맞는 메시지 id). */
async function rowAboveViewport(page, candidates) {
  return page.evaluate(
    ({ selector, ids }) => {
      const scroller = document.querySelector(selector);
      const edge = scroller.getBoundingClientRect().top;
      let best = null;
      for (const id of ids) {
        const node = scroller.querySelector(`[data-message-id="${id}"]`);
        const row = node?.closest("[data-index]") ?? node;
        if (!row) continue;
        const bottom = row.getBoundingClientRect().bottom;
        if (bottom < edge - 4 && (best === null || bottom > best.bottom)) best = { id, bottom };
      }
      return best?.id ?? null;
    },
    { selector: scrollerSelector, ids: candidates }
  );
}

/** 링크 카드 · 반응(맨 아래 · 위 읽기) · 더 불러오기를 한 대화에서 차례로 잰다. */
async function contentScenes(browser, engine, vp, recordOnly) {
  const { context, backend, page } = await newContext(browser, vp);
  const width = vp.width;
  const meta = (sceneKey, scene, extra = {}) => ({ set: "new", sceneKey, scene, engine, width, recordOnly, ...extra });
  try {
    await openDm(page, backend, origin);
    const anchorValue = await scrollerOverflowAnchor(page, scrollerSelector);
    const last = rowAt(LAST);
    const lastWatch = { name: "w", messageId: last.id, edge: "bottom" };
    const lastCard = unfurlCard(last, urlOf(last));

    if (sceneNames.includes("card")) {
      await measureCell(meta("card-bottom", "링크 카드 늦게 옴 — 맨 아래", { kind: "bottom" }), async () => {
        const before = await heightOf(page, last.id);
        const record = await recordWindow(page, lastWatch, async () => backend.unfurl(last, [lastCard]));
        const after = await heightOf(page, last.id);
        const numbers = numbersFromRecord(record, { watch: "w" });
        const shown = await page.locator(`[data-message-id="${last.id}"] [data-testid="unfurl-card"]`).count();
        if (shown === 0 || after === null || before === null || after <= before) {
          return { numbers, verdict: { verdict: "장면 못 만듦", reasons: [`카드가 서지 않았다(카드 ${shown}, 줄 ${before}→${after})`] } };
        }
        return { numbers, verdict: judgeCell(numbers, { kind: "bottom" }), note: `줄 ${before}→${after}px · 스크롤러 overflow-anchor=${anchorValue}` };
      });
    }
    if (sceneNames.includes("reaction")) {
      for (const action of ["added", "removed"]) {
        const onSkip = async () => {
          backend.reaction(action, last, "👍");
          await wait(1_200);
        };
        await measureCell(meta(`reaction-bottom-${action}`, `반응 ${action === "added" ? "추가" : "제거"} — 맨 아래`, { kind: "bottom" }), async () => {
          const before = await heightOf(page, last.id);
          const record = await recordWindow(page, lastWatch, async () => backend.reaction(action, last, "👍"), 1_200);
          const after = await heightOf(page, last.id);
          const numbers = numbersFromRecord(record, { watch: "w" });
          const chips = await page.locator(`[data-message-id="${last.id}"] [data-testid="reaction-chip"]`).count();
          const made = action === "added" ? chips > 0 && after > before : chips === 0 && after < before;
          if (!made) return { numbers, verdict: { verdict: "장면 못 만듦", reasons: [`반응 칩 ${chips} · 줄 ${before}→${after}`] } };
          return { numbers, verdict: judgeCell(numbers, { kind: "bottom" }), note: `줄 ${before}→${after}px` };
        }, { onSkip });
      }
    }

    // 위 읽기: 보던 줄을 화면 가운데쯤에 둔다.
    if (sceneNames.includes("card") || sceneNames.includes("reaction")) {
      await placeAnchor(page);
      await wait(1_500);
      // 앵커를 찾아 올라가는 동안 가상 목록이 옛 쪽을 부를 수 있다. 그 응답이 붙기 전에 위 읽기 창을 열면 앞 붙이기가 장면에 섞인다(실측: 옛 쪽
      // 응답을 2.5초로 늦춘 판에서 Chromium 반응 위 읽기가 칩 높이만큼 밀림) — 날아가는 읽기가 끝나고 붙을 때까지 기다린다.
      const settleDeadline = Date.now() + 10_000;
      while (backend.state.olderInFlight > 0 && Date.now() < settleDeadline) await wait(100);
      await wait(600);
      const anchorRow = rowAt(ANCHOR_INDEX);
      const anchorWatch = { name: "w", messageId: anchorRow.id, edge: "top" };
      if (sceneNames.includes("card")) {
        await measureCell(meta("card-up", "링크 카드 늦게 옴 — 위 읽기", { kind: "reading" }), async () => {
          const candidates = Object.keys(URL_BODIES)
            .map(Number)
            .filter((index) => index < ANCHOR_INDEX)
            .map((index) => rowAt(index).id);
          const targetId = await rowAboveViewport(page, candidates);
          if (targetId === null) return { numbers: null, verdict: { verdict: "장면 못 만듦", reasons: ["화면 위 밖에 붙은 링크 줄이 없다"] } };
          const target = rows.find((row) => row.id === targetId);
          const before = await heightOf(page, target.id);
          const record = await recordWindow(page, anchorWatch, async () => backend.unfurl(target, [unfurlCard(target, urlOf(target))]));
          const after = await heightOf(page, target.id);
          const numbers = numbersFromRecord(record, { watch: "w" });
          if (after === null || before === null || after <= before) {
            return { numbers, verdict: { verdict: "장면 못 만듦", reasons: [`위쪽 줄이 자라지 않았다(${before}→${after})`] } };
          }
          return { numbers, verdict: judgeCell(numbers, { kind: "reading" }), note: `위쪽 줄 ${before}→${after}px` };
        });
      }
      if (sceneNames.includes("reaction")) {
        const candidates = rows.slice(OLDER, OLDER + ANCHOR_INDEX).map((row) => row.id);
        const targetId = await rowAboveViewport(page, candidates);
        const target = rows.find((row) => row.id === targetId) ?? null;
        for (const action of ["added", "removed"]) {
          const onSkip = async () => {
            if (target !== null) backend.reaction(action, target, "👍");
            await wait(1_200);
          };
          await measureCell(meta(`reaction-up-${action}`, `반응 ${action === "added" ? "추가" : "제거"} — 위 읽기`, { kind: "reading" }), async () => {
            if (target === null) return { numbers: null, verdict: { verdict: "장면 못 만듦", reasons: ["화면 위 밖에 붙은 줄이 없다"] } };
            const before = await heightOf(page, target.id);
            const record = await recordWindow(page, anchorWatch, async () => backend.reaction(action, target, "👍"), 1_200);
            const after = await heightOf(page, target.id);
            const numbers = numbersFromRecord(record, { watch: "w" });
            const made = after !== null && before !== null && (action === "added" ? after > before : after < before);
            if (!made) return { numbers, verdict: { verdict: "장면 못 만듦", reasons: [`위쪽 줄 ${before}→${after}`] } };
            return { numbers, verdict: judgeCell(numbers, { kind: "reading" }), note: `위쪽 줄 ${before}→${after}px` };
          }, { onSkip });
        }
      }
    }

    if (sceneNames.includes("older")) {
      await measureCell(meta("older", "위로 더 불러오기", { kind: "reading" }), async () => {
        const readsBefore = backend.state.olderReads;
        // 이 장면만 옛 쪽 응답을 2.5초로 늦춘다: 맨 위에 닿은 뒤 재기 창을 연 다음에 앞에 붙는다.
        backend.state.olderDelayMs = 2_500;
        // 사람이 맨 위까지 올린다(가상 목록이 위쪽 줄을 재며 스스로 바로잡는 동안을 지나 보낸다). 옛 쪽 응답은 0.9초 늦게 온다.
        await page.evaluate((selector) => {
          document.querySelector(selector).scrollTop = 0;
        }, scrollerSelector);
        // 맨 위에 닿아도 가상 목록이 옛 쪽을 부르지 않을 때가 있다(실측: WebKit 1280 에서 읽기 0 — 맨 위 줄이 붙은 채라 「맨 위에 닿음」이
        // 바뀌지 않는다). 그때는 2,000px 내렸다 다시 올린다(최대 두 번). 몇 번 그랬는지 비고에 적는다(장면의 숫자와 따로 보는 사실).
        let nudges = 0;
        for (; nudges < 2; nudges += 1) {
          await wait(1_000);
          if (backend.state.olderReads !== readsBefore) break;
          await page.evaluate((selector) => {
            document.querySelector(selector).scrollTop = 2_000;
          }, scrollerSelector);
          await wait(400);
          await page.evaluate((selector) => {
            document.querySelector(selector).scrollTop = 0;
          }, scrollerSelector);
        }
        await wait(300);
        const watchId = await page.evaluate((selector) => {
          const scroller = document.querySelector(selector);
          const edge = scroller.getBoundingClientRect().top;
          for (const node of scroller.querySelectorAll("[data-message-id]")) {
            if (node.getBoundingClientRect().top >= edge) return node.getAttribute("data-message-id");
          }
          return null;
        }, scrollerSelector);
        if (watchId === null) return { numbers: null, verdict: { verdict: "장면 못 만듦", reasons: ["맨 위에 보던 줄이 없다"] } };
        const heightNow = () => page.evaluate((selector) => document.querySelector(selector).scrollHeight, scrollerSelector);
        const heightAtOpen = await heightNow();
        const record = await recordWindow(page, { name: "w", messageId: watchId, edge: "top" }, async () => {
          // 옛 쪽이 실제로 앞에 붙을 때까지(목록 높이가 자람) 기다린다.
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline && (await heightNow()) - heightAtOpen < 500) await wait(100);
        }, 1_500);
        const numbers = numbersFromRecord(record, { watch: "w" });
        // 옛 쪽이 앞에 붙었는가: 목록 높이가 크게 자랐다(50줄).
        const heights = record.frames.map((frame) => frame.sh).filter((value) => typeof value === "number");
        const grew = heights.length ? heights[heights.length - 1] - heights[0] : 0;
        if (backend.state.olderReads === readsBefore || grew < 500) {
          const state = await page.evaluate((selector) => {
            const scroller = document.querySelector(selector);
            const first = scroller.querySelector("[data-index]");
            return { top: scroller.scrollTop, rows: scroller.querySelectorAll("[data-index]").length, firstIndex: first?.getAttribute("data-index"), firstText: first?.textContent?.slice(0, 30) };
          }, scrollerSelector);
          if (process.env.TIMELINE_STILL_DEBUG === "1") console.log(`[debug older] ${JSON.stringify(state)} reads=${backend.state.olderReads}`);
          return { numbers, verdict: { verdict: "장면 못 만듦", reasons: [`옛 쪽이 붙지 않았다(읽기 ${backend.state.olderReads - readsBefore}, 목록 높이 +${grew}px)`] } };
        }
        return {
          numbers,
          verdict: judgeCell(numbers, { kind: "reading" }),
          note: `옛 쪽 붙음: 목록 높이 +${grew}px · scrollTop ${record.frames[0]?.top}→${record.frames.at(-1)?.top}${nudges > 0 ? ` · 맨 위에 닿아도 안 불러 ${nudges}번 내렸다 올림` : ""}`,
        };
      });
    }
  } finally {
    await context.close();
  }
}

/**
 * 엔진 판 확인(미리보기를 띄우기 전): Playwright 가 기대하는 판이 캐시에 없는 엔진은 「못 잼」 한 줄로 적고 새 장면 · 기존 게이트 모두에서
 * 뺀다. WebKit · Chromium 은 꼭 재야 하는 엔진이라(`required`) 그 「못 잼」은 통과가 아니다(#5641 검수 r1 M4). Firefox 는 기록만이다.
 */
function availableEngines() {
  const live = [];
  for (const name of engineNames) {
    const path = { webkit, chromium, firefox }[name].executablePath();
    if (existsSync(path)) live.push(name);
    else pushCell({ set: "*", sceneKey: "*", scene: "(모든 장면)", engine: name, width: "*", verdict: "못 잼", required: name !== "firefox", numbers: null, note: `Playwright 가 기대하는 판이 캐시에 없다: ${path} (받지 않음)` });
  }
  return live;
}
let liveEngines = [];

async function runNewScenes() {
  if (liveEngines.length === 0) return;
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "TIMELINE_STILL_PORT",
    extraArgs: distOverride ? ["--outDir", distOverride] : [],
  });
  activeServer = server;
  try {
    for (const name of liveEngines) {
      const type = { webkit, chromium, firefox }[name];
      // Firefox 는 기록만 한다(Playwright 판과 데스크탑 엔진이 다르다 — 표에 함께 적어 엔진 차이를 본다).
      const recordOnly = name === "firefox";
      const browser = await type.launch({ headless: true });
      try {
        await printEngineAnchorHeader(browser, name);
        for (let run = 1; run <= repeat; run += 1) {
          for (const width of widths) {
            const vp = VIEWPORTS[width];
            const tag = { set: "new", engine: name, width, recordOnly, run };
            if (sceneNames.includes("entry")) {
              await measureCell({ ...tag, sceneKey: "entry", scene: "대화 진입", kind: "entry" }, () => entryScene(browser, name, vp, { withCard: false }));
            }
            if (sceneNames.includes("entry-card")) {
              await measureCell({ ...tag, sceneKey: "entry-card", scene: "대화 진입 + 링크 카드 0.7초 늦게", kind: "entry" }, () =>
                entryScene(browser, name, vp, { withCard: true })
              );
            }
            if (sceneNames.some((scene) => ["card", "reaction", "older"].includes(scene))) {
              const gate = await loadGate();
              if (!gate.ok) {
                pushCell({ ...tag, sceneKey: "content", scene: "링크 카드 · 반응 · 더 불러오기", verdict: "재지 않음", numbers: null, loadBefore: gate.load, note: `부하 ${gate.load} > ${loadMax}` });
              } else {
                const before = cells.length;
                await contentScenes(browser, name, vp, recordOnly).catch((error) => {
                  pushCell({ ...tag, sceneKey: "content", scene: "링크 카드 · 반응 · 더 불러오기", verdict: "장면 못 만듦", numbers: null, reasons: [String(error.message ?? error).split("\n")[0]] });
                });
                for (const cell of cells.slice(before)) cell.run = run;
              }
            }
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
    activeServer = null;
  }
}

// ---------------------------------------------------------------------------------------------- 기존 게이트 셋

function runChild(script, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(webRoot, "gates", script)], { cwd: webRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      activeChild = null;
      done({ code, stdout, stderr });
    });
  });
}

const childEngines = () => liveEngines.filter((name) => name !== "firefox");
const failLinesOf = (run) => run.stderr.split("\n").filter((line) => line.startsWith("FAIL "));

/** 기존 게이트의 칸 판정: 그 게이트의 FAIL 줄 가운데 이 칸의 위치(`where`)로 시작하는 것이 있으면 FAIL. */
function legacyVerdict(run, where) {
  const hits = failLinesOf(run).filter((line) => line.slice(5).startsWith(`${where}:`));
  return hits.length ? { verdict: "FAIL", reasons: hits.map((line) => line.slice(5)) } : { verdict: "PASS", reasons: [] };
}

async function runLegacy(set, script, env, outFile, adapt) {
  if (childEngines().length === 0) return;
  const gate = await loadGate();
  if (!gate.ok) {
    pushCell({ set, sceneKey: set, scene: `${script} 전체`, engine: childEngines().join("·"), width: "*", verdict: "재지 않음", numbers: null, loadBefore: gate.load, note: `부하 ${gate.load} > ${loadMax}` });
    return;
  }
  const dir = resolve(childOut, set);
  mkdirSync(dir, { recursive: true });
  const run = await runChild(script, Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)));
  const loadAfter = loadNow();
  writeFileSync(resolve(dir, "stdout.log"), run.stdout);
  writeFileSync(resolve(dir, "stderr.log"), run.stderr);
  const file = resolve(dir, outFile);
  if (!existsSync(file)) {
    pushCell({ set, sceneKey: set, scene: `${script} 전체`, engine: childEngines().join("·"), width: "*", verdict: "FAIL", numbers: null, loadBefore: gate.load, loadAfter, reasons: [`기록이 없다(종료 ${run.code}): ${run.stderr.split("\n").slice(-3).join(" ")}`] });
    return;
  }
  const before = cells.length;
  adapt(JSON.parse(readFileSync(file, "utf8")), run, { loadBefore: gate.load, loadAfter });
  const added = cells.slice(before);
  // 칸에 걸리지 않은 FAIL 줄(장면을 못 만듦 등)도 놓치지 않는다.
  const unmatched = failLinesOf(run).filter((line) => !added.some((cell) => (cell.reasons ?? []).includes(line.slice(5))));
  if (unmatched.length > 0 || (run.code !== 0 && added.every((cell) => cell.verdict !== "FAIL"))) {
    pushCell({ set, sceneKey: set, scene: `${script} (칸 밖 실패)`, engine: childEngines().join("·"), width: "*", verdict: "FAIL", numbers: null, loadBefore: gate.load, loadAfter, reasons: unmatched.length ? unmatched : [`종료 ${run.code}`] });
  }
  if (added.length === 0) pushCell({ set, sceneKey: set, scene: `${script} 전체`, engine: childEngines().join("·"), width: "*", verdict: "FAIL", numbers: null, reasons: ["칸이 0개다 — 장면을 하나도 돌지 않았다"] });
}

function typingAdapter(entries, run, loads) {
  for (const entry of entries) {
    const { summary, raw, engine, viewport } = entry;
    const width = Number(viewport.split("x")[0]);
    const grows = summary.label.startsWith("D") || summary.label.startsWith("E");
    const docks = raw.frames.map((frame) => frame.dockH);
    const expected = grows ? Math.round((Math.max(...docks) - Math.min(...docks)) * 100) / 100 : 0;
    const numbers = stillNumbers({ series: raw.frames.map((frame) => frame.lastBottom), expected, gaps: raw.frames.map((frame) => frame.gap) });
    const verdict = legacyVerdict(run, `${engine} ${viewport} ${summary.label}`);
    pushCell({
      set: "typing",
      sceneKey: `typing-${summary.label[0]}`,
      scene: `입력 ${summary.label}`,
      engine,
      width,
      kind: grows ? "expected" : "bottom",
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      numbers,
      ...loads,
      note: grows ? `입력 독 ${expected}px 자람(여러 줄 — 줄마다 한 번)` : "",
    });
  }
}

function expressionAdapter(entries, run, loads) {
  for (const entry of entries) {
    const { summary, raw, engine, scene } = entry;
    if (summary.probe || raw === null) continue;
    const frames = raw.frames;
    const firstLast = frames.find((frame) => frame.lastIndex !== null)?.lastIndex ?? null;
    const lastSeries = frames.map((frame) => (frame.lastIndex === firstLast ? frame.lastBottom : null));
    const anchorSeries = frames.map((frame) => frame.anchorScreen ?? null);
    const reading = scene === "anchor" || summary.label.startsWith("C2");
    const personScroll = scene === "bottom" && summary.label.startsWith("10");
    const numbers = personScroll
      ? null
      : stillNumbers({
          series: reading ? anchorSeries : lastSeries,
          gaps: frames.map((frame) => frame.gap),
          pills: frames.map((frame) => frame.pill),
          pillMounts: raw.pillMounts,
          pillAtStart: frames[0]?.pill === true,
        });
    const verdict = legacyVerdict(run, `${engine}${entry.run && entries.some((other) => other.run > 1) ? ` #${entry.run}` : ""} ${summary.label}`);
    pushCell({
      set: "expression",
      sceneKey: `expression-${scene}-${summary.label.split(" ")[0]}`,
      scene: `가만히 ${summary.label}`,
      engine,
      width: summary.width ?? 1280,
      kind: reading ? "reading" : "bottom",
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      numbers,
      ...loads,
      note: personScroll ? "사람이 스크롤하는 장면 — 숫자 넷 없음(글자만 셈)" : "",
    });
  }
}

function sendAdapter(entries, run, loads) {
  for (const entry of entries) {
    const numbers = entry.samples
      ? // send-follow ⑤ 의 표본은 rAF 안(그리기 · ResizeObserver 앞)에서 적은 값이라 바닥 거리 열은 비운다 — 끝 바닥 거리는 send-follow 가 따로 단정한다.
        stillNumbers({ series: entry.samples.map((one) => one.aboveTop), expected: entry.expected ?? 0 })
      : entry.distances || entry.unexplainedPx !== undefined
        ? {
            reversals: null,
            unexplainedPx: entry.unexplainedPx ?? null,
            maxGapPx: entry.distances?.length ? Math.max(...entry.distances) : null,
            pillShows: entry.pillShows ?? null,
            expectedPx: 0,
            motion: null,
          }
        : null;
    let verdict = entry.recordOnly ? { verdict: `기록만(${entry.record ?? "-"})`, reasons: [] } : legacyVerdict(run, entry.where);
    if (verdict.verdict === "PASS" && entry.known) verdict = { verdict: "PASS(알려진 실패 기록)", reasons: [entry.known] };
    pushCell({
      set: "send",
      sceneKey: `send-${entry.name}`,
      scene: entry.scene,
      engine: entry.engine,
      width: 1280,
      kind: entry.kind,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      numbers,
      ...loads,
      note: [entry.samples ? "" : "프레임 기록 없음 — 시점 값", entry.note ?? ""].filter(Boolean).join(" · "),
    });
  }
}

let childOut = null;

// ---------------------------------------------------------------------------------------------- 표

const fmt = (value) => (value === null || value === undefined ? "—" : String(value));

function markdown() {
  const lines = [
    `# 흔들림 장면표 (gate-timeline-still) — ${new Date().toISOString()}`,
    "",
    `부하 문턱 ${loadMax} · 엔진 ${engineNames.join("·")} · 폭 ${widths.join("·")}${distOverride ? ` · 번들 ${distOverride}` : ""}`,
    "",
    "| 묶음 | 장면 | 엔진 | 폭 | 판정 | 되돌아옴 | 이유 없는 이동 px | 바닥 거리 px | 필 | 예상 이동(번·px) | 부하 전→후 | 비고 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const cell of cells) {
    const n = cell.numbers;
    const expected = n && n.expectedPx ? `${fmt(n.motion?.steps)}번 · ${fmt(n.motion?.range)}px (기대 ${n.expectedPx})` : "—";
    const why = [...(cell.reasons ?? []), cell.note].filter(Boolean).join(" · ").replace(/\|/g, "/");
    lines.push(
      `| ${cell.set} | ${cell.scene}${cell.run > 1 ? ` #${cell.run}` : ""} | ${cell.engine} | ${cell.width} | ${cell.verdict} | ${fmt(n?.reversals)} | ${fmt(n?.unexplainedPx)} | ${fmt(n?.maxGapPx)} | ${fmt(n?.pillShows)} | ${expected} | ${fmt(cell.loadBefore)}→${fmt(cell.loadAfter)} | ${why} |`
    );
  }
  return lines.join("\n");
}

async function main() {
  childOut = outDir ? resolve(outDir, "children") : mkdtempSync(resolve(tmpdir(), "timeline-still-"));
  console.log(`[timeline-still] 부하 ${loadNow()} (문턱 ${loadMax}) · 엔진 ${engineNames.join(",")} · 폭 ${widths.join(",")} · 장면 ${sceneNames.join(",")} · 묶음 ${setNames.join(",")}`);
  liveEngines = availableEngines();
  try {
    if (setNames.includes("new")) await runNewScenes();
    const engines = childEngines().join(",");
    const dist = distOverride ?? undefined;
    if (setNames.includes("typing")) {
      await runLegacy(
        "typing",
        "gate-typing-jitter.mjs",
        { TYPING_JITTER_PORT: String(port + 1), TYPING_JITTER_ENGINES: engines, TYPING_JITTER_VIEWPORTS: widths.map((w) => TYPING_VIEWPORTS[w]).join(","), TYPING_JITTER_OUT: resolve(childOut, "typing"), TYPING_JITTER_DIST: dist },
        "typing-jitter.json",
        typingAdapter
      );
    }
    if (setNames.includes("expression")) {
      await runLegacy(
        "expression",
        "gate-expression-jitter.mjs",
        { EXPRESSION_JITTER_PORT: String(port + 2), EXPRESSION_JITTER_ENGINES: engines, EXPRESSION_JITTER_OUT: resolve(childOut, "expression"), EXPRESSION_JITTER_DIST: dist },
        "expression-jitter.json",
        expressionAdapter
      );
    }
    if (setNames.includes("send")) {
      for (const skew of [false, true]) {
        await runLegacy(
          "send",
          "gate-send-follow.mjs",
          { SEND_FOLLOW_PORT: String(port + 3), SEND_FOLLOW_ENGINES: engines, SEND_FOLLOW_OUT: resolve(childOut, "send"), SEND_FOLLOW_SKEW: skew ? "1" : "0", SEND_FOLLOW_DIST: dist },
          skew ? "send-follow-skew.json" : "send-follow.json",
          sendAdapter
        );
      }
    }
  } finally {
    if (!outDir) rmSync(childOut, { recursive: true, force: true });
  }

  // 고쳐졌는데 목록에 남은 알려진 실패 · 수리 이슈가 아직 없는 줄을 알린다(판정은 바꾸지 않는다).
  const notices = staleKnown(cells).map((line) => `[알려진 실패 → 통과] ${line}`);
  const placeholders = [...new Set(cells.filter((cell) => cell.known?.placeholder).map((cell) => cell.known.key))];
  if (placeholders.length > 0) notices.push(`[알려진 실패] 수리 이슈가 아직 없어 #5641 을 단 줄 ${placeholders.length}: ${placeholders.join(", ")}`);
  const verdict = finalVerdict(cells);
  const table = [markdown(), "", ...notices.map((line) => `- ${line}`), "", ...verdict.err, ...verdict.out].join("\n");
  console.log(markdown());
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "timeline-still.json"), JSON.stringify({ at: new Date().toISOString(), loadMax, engines: engineNames, widths, scenes: sceneNames, sets: setNames, dist: distOverride, cells, notices, verdict }, null, 1));
    writeFileSync(resolve(outDir, "timeline-still.md"), `${table}\n`);
    console.log(`표: ${resolve(outDir, "timeline-still.md")}`);
  }
  for (const line of notices) console.log(line);
  for (const line of verdict.err) console.error(line);
  for (const line of verdict.out) console.log(line);
  process.exit(verdict.code);
}

await main();
