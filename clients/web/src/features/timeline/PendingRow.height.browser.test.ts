// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { mkdirSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, MessageAttachment, RosterMember } from "@momo/core/lib/api";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { MessageRow } from "./MessageRow";
import { PendingRow } from "./PendingRow";

// =============================================================================
// 보낼 때 행이 튀지 않는다 (#4468, 폰 #4455와 같은 규칙) — 실제 Chromium 으로 잰 행의 기하.
//
// 정상 전송의 메아리는 몇백 ms 안에 서버 사본(`MessageRow`)으로 교체된다. 교체가 눈에 띄려면 **그 사이에 달라지는 것**이 있어야
// 한다: 행 높이, 본문이 앉은 자리, 본문 색(메아리 흐림). 이 시험은 진짜 `PendingRow` 와 진짜 `MessageRow` 를 jsdom 에서 한 번씩
// 그려 마크업을 얻고(시험이 따로 적은 사본이 아니다), 같은 CSS 로 Chromium 에 올려 두 행을 재서 맞댄다.
//
//   (1) 같은 글을 보낸 메아리(정상)와 서버 사본은 행 높이·본문 자리·본문 색·첨부 불투명도가 같다.
//       머리 행과 이어지는 행, 한 줄 글과 세 줄로 꺾이는 글, 이름이 길어 시각이 다음 줄로 꺾이는 머리, 첨부가 있는 글.
//   (2) 느린 전송의 시계는 높이도 자리도 움직이지 않는다(메아리 정상 ↔ 느린 전송이 같은 기하).
//   (3) 프레임 단위: 메아리 → 느린 전송 → 서버 사본으로 바꾸며 매 프레임(rAF) 재도 높이·본문 자리·색은 한 값이다.
//   (4) 실패는 그대로다: 실패 줄이 서서 정상보다 크고 본문은 흐리다 — 이것을 정상으로 되돌리는 수리는 이 시험을 통과하지 못한다.
//
// 번들 Chromium 헤드리스만 띄운다(WebKit 은 띄우지 않는다: 에이전트 격리 안에서 「예기치 않게 종료」 창을 낸다, #4861).
// 캡처: `CAP4468_DIR` 이 있으면 같은 마크업으로 라이트·다크 그림을 그 폴더에 쓴다(`CAP4468_TAG` 가 파일 이름 머리).
// =============================================================================

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const MSG = "0199eeee-0000-7000-8000-000000000501";
const T0 = new Date("2026-11-05T05:20:30Z").getTime();
/** 느린 전송의 기준(1.5초)을 확실히 넘긴 보낸 시각. */
const SLOW_AGE_MS = 5_000;

let korean: AppLocale;
beforeAll(async () => {
  korean = await koreanLocaleForTest();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
  // 시계만 고정한다: 메아리가 「지금 보냈다」(createdAtMs = T0)로 그려지게. 타이머는 진짜다(효과의 setTimeout 은 unmount 가 지운다).
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function member(name: string): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: name,
    handle: "seoyeon",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const SHORT = "금요일 배포 공지 초안이에요";
const WRAPPING =
  "금요일 배포 공지 초안이에요. 점검은 오전 열 시부터 열한 시까지이고 그동안 알림이 늦게 갈 수 있어요. 확인 부탁드려요. 일정이 겹치면 말해 주세요.";
const PDF: MessageAttachment = { id: "0199cccc-0000-7000-8000-0000000000f1", name: "견적서.pdf", mime: "application/pdf", sizeBytes: 48_213 };

interface Variant {
  key: string;
  startsGroup: boolean;
  body: string;
  columnWidth: number;
  /** 머리 줄에서 시각이 이름 옆에 설 수 있는가를 시험하려고 이름을 길게 한 변형. */
  name?: string;
  attachments?: MessageAttachment[];
}

const VARIANTS: Variant[] = [
  { key: "머리·한 줄", startsGroup: true, body: SHORT, columnWidth: 480 },
  { key: "이어지는 행·한 줄", startsGroup: false, body: SHORT, columnWidth: 480 },
  { key: "머리·여러 줄로 꺾이는 글", startsGroup: true, body: WRAPPING, columnWidth: 320 },
  { key: "머리·이름이 길어 시각이 꺾이는 폭", startsGroup: true, body: SHORT, columnWidth: 320, name: "가나다라마바사아자차카타파하가나" },
  { key: "머리·첨부", startsGroup: true, body: SHORT, columnWidth: 480, attachments: [PDF] },
];

type Kind = "echo" | "slow" | "failed" | "confirmed";

function pendingOf(variant: Variant, kind: Exclude<Kind, "confirmed">): PendingMessage {
  return {
    clientMsgId: "k-4468",
    channelId: CH,
    authorMemberId: ME,
    body: variant.body,
    createdAtMs: kind === "slow" ? T0 - SLOW_AGE_MS : T0,
    sinceSeq: 10,
    status: kind === "failed" ? "failed" : "sending",
    ...(variant.attachments !== undefined ? { attachments: variant.attachments } : {}),
  };
}

function confirmedOf(variant: Variant): Message {
  return {
    id: MSG,
    channelId: CH,
    seq: 11,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: variant.body,
    state: "sent",
    createdAtMs: T0,
    ...(variant.attachments !== undefined ? { attachments: variant.attachments } : {}),
  };
}

/** 진짜 행을 한 번 그려 마크업을 얻는다. */
function rowHtml(variant: Variant, kind: Kind): string {
  const directory = makeDirectory([member(variant.name ?? "박서연")]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const row =
    kind === "confirmed"
      ? createElement(MessageRow, { message: confirmedOf(variant), directory, startsGroup: variant.startsGroup })
      : createElement(PendingRow, {
          pending: pendingOf(variant, kind),
          directory,
          startsGroup: variant.startsGroup,
          ...(kind === "failed" ? { onResend: () => undefined, onDiscard: () => undefined } : {}),
        });
  const node: ReactElement = createElement(LocaleProvider, {
    locale: korean,
    children: createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        OpenMemberProfileContext.Provider,
        { value: () => undefined },
        createElement(QueryClientProvider, { client }, row)
      )
    ),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, columnWidth: number, html = ""): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#col { width: ${columnWidth}px; }
</style></head><body class="bg-pane text-ink"><div id="col">${html}</div></body></html>`;
}

type Page = import("playwright").Page;

interface Geometry {
  height: number;
  /** 본문 첫 줄 위쪽 = 행 위에서 본문까지 거리. 교체 때 글이 내려앉으면 이 값이 달라진다. */
  bodyOffset: number;
  /** 본문 왼쪽(화면 좌표). 확정 행은 바깥 여백 4를 지니므로 행 기준 거리가 아니라 눈에 보이는 위치를 맞댄다. */
  bodyLeft: number;
  bodyColor: string;
  /** 첨부 목록의 불투명도(없으면 null). */
  listOpacity: number | null;
  /** 눈에 보이는 시각 글자(머리 행). 이어지는 행의 거터 시각은 호버 전에 투명이라 null 이다. 교체 때 이 글자가 새로 생기면 그것도 깜빡임이다. */
  timeText: string | null;
  /** 그 시각의 왼쪽(화면 좌표). */
  timeLeft: number | null;
  /** 보이는 「전송 중」 글자가 행 안에 있는가. */
  sendingText: boolean;
  /** 시계 표지가 서 있는가. */
  mark: boolean;
}

/** `#col` 안의 첫 행을 잰다. 안정된 두 번의 프레임 뒤. */
async function measure(p: Page): Promise<Geometry> {
  return p.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const row = document.querySelector<HTMLElement>('#col > article')!;
    const rowRect = row.getBoundingClientRect();
    const body = row.querySelector<HTMLElement>("p")!;
    const bodyRect = body.getBoundingClientRect();
    const list = row.querySelector<HTMLElement>('[data-testid="attachment-list"]');
    const time = [...row.querySelectorAll<HTMLElement>("time")].find(
      (el) => el.getClientRects().length > 0 && Number(getComputedStyle(el).opacity) > 0
    );
    return {
      height: rowRect.height,
      bodyOffset: bodyRect.top - rowRect.top,
      bodyLeft: bodyRect.left,
      bodyColor: getComputedStyle(body).color,
      listOpacity: list === null ? null : Number(getComputedStyle(list).opacity),
      timeText: time === undefined ? null : (time.textContent ?? "").trim(),
      timeLeft: time === undefined ? null : time.getBoundingClientRect().left,
      sendingText: row.querySelector('[data-testid="pending-sending"]') !== null,
      mark: row.querySelector('[data-testid="pending-slow"]') !== null,
    };
  });
}

async function show(p: Page, html: string): Promise<Geometry> {
  await p.evaluate((markup) => {
    document.getElementById("col")!.innerHTML = markup;
  }, html);
  return measure(p);
}

const TOL = 0.5;

describe("보낼 때 행이 튀지 않는다 (#4468)", () => {
  it.skipIf(!ENGINES.includes("chromium"))(
    "정상 전송의 메아리는 서버 사본과 높이·본문 자리·색이 같고, 느린 전송의 시계와 실패의 줄은 약속대로다 (실제 Chromium)",
    async () => {
      const kinds: Kind[] = ["echo", "slow", "failed", "confirmed"];
      const markup = new Map<string, string>();
      for (const variant of VARIANTS) {
        for (const kind of kinds) markup.set(`${variant.key}|${kind}`, rowHtml(variant, kind));
      }
      const css = await compileTokensCss([...markup.values()].flatMap(classesOf));
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      const problems: string[] = [];
      try {
        const context = await browser.newContext({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 2 });
        try {
          const p = await context.newPage();
          const capDir = process.env.CAP4468_DIR;
          if (capDir !== undefined && capDir !== "") mkdirSync(capDir, { recursive: true });

          for (const variant of VARIANTS) {
            await p.setContent(page(css, variant.columnWidth));
            const html = (kind: Kind) => markup.get(`${variant.key}|${kind}`)!;
            const echo = await show(p, html("echo"));
            const slow = await show(p, html("slow"));
            const failed = await show(p, html("failed"));
            const confirmed = await show(p, html("confirmed"));
            const at = variant.key;

            // (1) 정상 전송 = 서버 사본
            if (Math.abs(echo.height - confirmed.height) > TOL) problems.push(`${at}: 메아리 높이 ${echo.height}, 서버 사본 ${confirmed.height}`);
            if (Math.abs(echo.bodyOffset - confirmed.bodyOffset) > TOL) problems.push(`${at}: 본문이 앉은 자리 ${echo.bodyOffset}, 서버 사본 ${confirmed.bodyOffset}`);
            if (Math.abs(echo.bodyLeft - confirmed.bodyLeft) > TOL) problems.push(`${at}: 본문 왼쪽 ${echo.bodyLeft}, 서버 사본 ${confirmed.bodyLeft}`);
            if (echo.bodyColor !== confirmed.bodyColor) problems.push(`${at}: 본문 색 ${echo.bodyColor}, 서버 사본 ${confirmed.bodyColor}`);
            if (echo.timeText !== confirmed.timeText) problems.push(`${at}: 시각 글자 ${String(echo.timeText)}, 서버 사본 ${String(confirmed.timeText)} — 교체 때 글자가 생기거나 바뀐다`);
            if (variant.startsGroup && (echo.timeText === null || echo.timeText === "")) problems.push(`${at}: 머리 행인데 보낸 시각 글자가 없다`);
            if (echo.timeLeft !== null && confirmed.timeLeft !== null && Math.abs(echo.timeLeft - confirmed.timeLeft) > TOL) {
              problems.push(`${at}: 시각이 앉은 자리 ${echo.timeLeft}, 서버 사본 ${confirmed.timeLeft}`);
            }
            if (echo.listOpacity !== confirmed.listOpacity) problems.push(`${at}: 첨부 불투명도 ${String(echo.listOpacity)}, 서버 사본 ${String(confirmed.listOpacity)}`);
            if (echo.sendingText) problems.push(`${at}: 정상 전송인데 「전송 중」 글자가 서 있다`);
            if (echo.mark) problems.push(`${at}: 정상 전송인데 시계가 서 있다`);

            // (2) 느린 전송: 시계가 서되 기하는 그대로
            if (!slow.mark) problems.push(`${at}: 느린 전송인데 시계가 없다`);
            if (slow.sendingText) problems.push(`${at}: 느린 전송에 「전송 중」 글자 줄이 있다(시계 하나여야 한다)`);
            if (Math.abs(slow.height - echo.height) > TOL) problems.push(`${at}: 시계가 서며 높이가 ${echo.height}에서 ${slow.height}로 바뀐다`);
            if (Math.abs(slow.bodyOffset - echo.bodyOffset) > TOL) problems.push(`${at}: 시계가 서며 본문 자리가 ${echo.bodyOffset}에서 ${slow.bodyOffset}로 바뀐다`);
            if (slow.bodyColor !== echo.bodyColor) problems.push(`${at}: 시계가 서며 본문 색이 바뀐다`);

            // (4) 실패는 그대로: 실패 줄이 서서 더 크고, 본문은 흐리다
            if (!(failed.height >= echo.height + 14)) problems.push(`${at}: 실패 줄이 서지 않았다(실패 ${failed.height}, 정상 ${echo.height})`);
            if (failed.bodyColor === echo.bodyColor) problems.push(`${at}: 실패한 행의 본문이 흐리지 않다(${failed.bodyColor})`);
            if (failed.mark) problems.push(`${at}: 실패한 행에 시계가 서 있다`);
          }

          // (3) 프레임 단위: 첫 변형에서 메아리 → 느린 전송 → 서버 사본으로 바꾸며 매 프레임 잰다.
          const frameVariant = VARIANTS[0]!;
          await p.setContent(page(css, frameVariant.columnWidth));
          const frames = await p.evaluate(
            async ({ stages }) => {
              const host = document.getElementById("col")!;
              const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const out: { stage: string; height: number; bodyOffset: number; color: string }[] = [];
              for (const stage of stages) {
                host.innerHTML = stage.html;
                for (let i = 0; i < 4; i += 1) {
                  await nextFrame();
                  const row = host.firstElementChild as HTMLElement;
                  const body = row.querySelector<HTMLElement>("p")!;
                  out.push({
                    stage: stage.name,
                    height: row.getBoundingClientRect().height,
                    bodyOffset: body.getBoundingClientRect().top - row.getBoundingClientRect().top,
                    color: getComputedStyle(body).color,
                  });
                }
              }
              return out;
            },
            {
              stages: [
                { name: "메아리", html: markup.get(`${frameVariant.key}|echo`)! },
                { name: "느린 전송", html: markup.get(`${frameVariant.key}|slow`)! },
                { name: "서버 사본", html: markup.get(`${frameVariant.key}|confirmed`)! },
              ],
            }
          );
          const heights = new Set(frames.map((f) => Math.round(f.height * 2)));
          const offsets = new Set(frames.map((f) => Math.round(f.bodyOffset * 2)));
          const colors = new Set(frames.map((f) => f.color));
          if (frames.length !== 12) problems.push(`프레임 ${frames.length}개만 쟀다`);
          if (heights.size !== 1) problems.push(`프레임마다 행 높이가 다르다: ${[...new Set(frames.map((f) => `${f.stage}:${f.height}`))].join(", ")}`);
          if (offsets.size !== 1) problems.push(`프레임마다 본문 자리가 다르다: ${[...offsets].join(", ")}`);
          if (colors.size !== 1) problems.push(`프레임마다 본문 색이 다르다: ${[...colors].join(", ")}`);

          // 캡처(전후 각 라이트·다크 = 4장): 같은 마크업을 한 장에 — 왼쪽은 머리 행, 오른쪽은 이어지는 행. 위에서 아래로 보내는 중 /
          // 느린 전송 / 서버 사본.
          if (capDir !== undefined && capDir !== "") {
            const tag = process.env.CAP4468_TAG ?? "run";
            const column = (key: string) => {
              const html = (kind: Kind) => markup.get(`${key}|${kind}`)!;
              return (
                `<div class="cap-col"><div class="cap">보내는 중 (1.5초 안)</div>${html("echo")}` +
                `<div class="cap">느린 전송 (1.5초 넘음)</div>${html("slow")}` +
                `<div class="cap">서버 사본</div>${html("confirmed")}</div>`
              );
            };
            const sheet = `<div class="cap-sheet">${column("머리·한 줄")}${column("이어지는 행·한 줄")}</div>`;
            const sheetCss = `${css}
.cap-sheet { display: flex; width: 960px; }
.cap-col { width: 480px; }
.cap { padding: 12px 16px 2px; font: 12px/16px system-ui, sans-serif; opacity: 0.6; }`;
            for (const scheme of ["light", "dark"] as const) {
              await p.emulateMedia({ colorScheme: scheme });
              await p.setContent(page(sheetCss, 960, sheet));
              await p.waitForTimeout(50);
              await p.locator("#col").screenshot({ path: `${capDir}/${tag}-${scheme}.png` });
            }
            await p.emulateMedia({ colorScheme: null });
          }
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
      expect(problems).toEqual([]);
    },
    120_000
  );
});
