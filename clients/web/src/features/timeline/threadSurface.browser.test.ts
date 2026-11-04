// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember, ThreadRollup } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ROW_SPACE } from "@momo/core/features/timeline/divider";
import { THREAD_FACE_OVERLAP, THREAD_FACE_SIZE } from "@momo/core/features/timeline/threadSummary";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { MessageRow } from "./MessageRow";
import { TOOLBAR_CLASS, toolbarItemClass } from "./MessageActions";
import { ThreadSummaryLine } from "./ThreadSummary";
import { THREAD_REPLIES_LEAD_CLASS } from "./spacing";

// =============================================================================
// 실제 마크업을 실제 엔진에 올려 잰 스레드 표면 (#4878, owner 10-31).
//
//   (1) 요약 줄의 겹친 얼굴: 한 변 20, 이웃과 −6 겹침(왼쪽 모서리 간격 14), 링은 레이아웃을 밀지 않는다.
//   (2) 스레드 패널의 루트→답글 띠: 뒤집힌 루트 호버 툴바(실제 클래스 `TOOLBAR_CLASS`·`toolbarItemClass`를 뒤집힌
//       위치 `hover-toolbar-straddle-below`에 둔다)가 첫 답글의 **머리 줄**(이름·시각 — 캡처 가드
//       `assertThreadRootHoverToolbar`의 「글자 교차 0」이 세는 `data-row-body` 안)을 가리지 않는다. 띠
//       (`THREAD_REPLIES_LEAD_CLASS`)를 줄이면 이 시험이 실제 엔진에서 붉어진다.
//   (3) 띠를 **더 줄일 수 없는** 이유도 같은 측정이다: 격자의 한 단계 아래(24)는 머리 줄에 닿는다.
// 마크업은 jsdom에서 진짜 `MessageRow`·`ThreadSummaryLine`이 그린 것이다.
// =============================================================================

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const THIRD = "00000000-0000-7000-8000-000000000103";
const T0 = new Date("2026-10-27T03:00:00Z").getTime();

beforeAll(() => {
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

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: name,
    handle: name,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
const directory = makeDirectory([member(ME, "정하윤"), member(OTHER, "김인턴"), member(THIRD, "박서연")]);

function message(id: string, seq: number, author: string, body: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: T0 - 30 * 60_000 + seq,
    ...extra,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

/** 진짜 컴포넌트를 한 번 그려 마크업을 얻는다. */
function html(node: ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(
          OpenMemberProfileContext.Provider,
          { value: () => undefined },
          createElement(QueryClientProvider, { client }, node)
        )
      )
    )
  );
  const out = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return out;
}

const classesOf = (markup: string) =>
  [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, width: number, body: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#col { width: ${width}px; position: relative; }
</style></head><body class="bg-pane text-ink"><div id="col">${body}</div></body></html>`;
}

const rollup: ThreadRollup = {
  replyCount: 3,
  lastReplySeq: 10,
  lastReplyAtMs: T0 - 60_000,
  participantIds: [OTHER, THIRD, ME],
  participantCount: 3,
  unreadReplyCount: 2,
};

/** 스레드 패널의 스크롤 내용: 루트 행(+뒤집힌 호버 툴바) → 답글 목록 머리 → 첫 답글 행. */
function panelMarkup(leadClass: string): string {
  const root = html(
    createElement(MessageRow, {
      message: message("0199aaaa-0000-7000-8000-000000000001", 1, ME, "이번 주 회의록 정리해 줘요", { thread: { reply_count: 2, last_reply_seq: 3, last_reply_at: T0 } }),
      startsGroup: true,
      directory,
      showRollup: false,
    })
  );
  const reply = html(
    createElement(MessageRow, {
      message: message("0199aaaa-0000-7000-8000-000000000002", 2, OTHER, "네, 오늘 안에 올려 둘게요", { rootId: "0199aaaa-0000-7000-8000-000000000001" }),
      startsGroup: true,
      directory,
      showRollup: false,
    })
  );
  const items = ["👍", "✅", "🙏", "↩", "⋯"]
    .map((glyph) => `<button class="${toolbarItemClass}">${glyph}</button>`)
    .join("");
  const bar = `<div data-testid="message-hover-toolbar" class="hover-toolbar-straddle-below ${TOOLBAR_CLASS}">${items}</div>`;
  // 루트 행(<article class="… relative …">) 안에 뒤집힌 툴바를 둔다: 툴바는 행 기준 절대 배치다.
  const rootWithBar = root.replace(/^(<article[^>]*>)/, `$1${bar}`);
  return `<div data-message-scroll-container>${rootWithBar}<div class="${leadClass}" data-testid="thread-replies">${reply}</div></div>`;
}

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };

describe("겹친 얼굴의 기하 (실제 엔진)", () => {
  it.skipIf(ENGINES.length === 0)("한 변 20, 이웃과 −6 겹침(모서리 간격 14), 링은 자리를 밀지 않는다", async () => {
    const markup = html(createElement(ThreadSummaryLine, { rollup, directory, onOpen: () => undefined }));
    const css = await compileTokensCss(classesOf(markup));
    const playwright = await import("playwright");
    for (const engine of ENGINES) {
      const browser = await playwright[engine].launch();
      try {
        const p = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
        await p.setContent(page(css, 360, markup));
        const m = await p.evaluate(() => {
          const rect = (el: Element): Rect => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
          };
          const faces = [...document.querySelectorAll<HTMLElement>('[data-testid="thread-face"]')];
          return {
            faces: faces.map((f) => ({ ...rect(f), shadow: getComputedStyle(f).boxShadow, radius: getComputedStyle(f).borderTopLeftRadius })),
            group: rect(document.querySelector('[data-testid="thread-faces"]')!),
            count: rect(document.querySelector('[data-testid="thread-count"]')!),
          };
        });
        const at = `${engine}`;
        expect(m.faces, at).toHaveLength(3);
        for (const f of m.faces) {
          expect(f.width, `${at} 얼굴 폭`).toBeCloseTo(THREAD_FACE_SIZE.web, 1);
          expect(f.height, `${at} 얼굴 높이`).toBeCloseTo(THREAD_FACE_SIZE.web, 1);
          expect(f.shadow, `${at} 링`).toContain("2px");
        }
        expect(m.faces[1].left - m.faces[0].left, `${at} 둘째 얼굴 간격`).toBeCloseTo(THREAD_FACE_SIZE.web - THREAD_FACE_OVERLAP, 1);
        expect(m.faces[2].left - m.faces[1].left, `${at} 셋째 얼굴 간격`).toBeCloseTo(THREAD_FACE_SIZE.web - THREAD_FACE_OVERLAP, 1);
        // 세 얼굴이 차지하는 폭 = 20·3 − 6·2. 링은 박스 그림자라 이 폭에 들지 않는다.
        expect(m.group.width, `${at} 얼굴 묶음 폭`).toBeCloseTo(THREAD_FACE_SIZE.web * 3 - THREAD_FACE_OVERLAP * 2, 1);
        expect(m.count.left, `${at} 글은 얼굴 묶음 오른쪽`).toBeGreaterThanOrEqual(m.group.right);
      } finally {
        await browser.close();
      }
    }
  });
});

describe("스레드 패널의 루트→답글 띠 (실제 엔진)", () => {
  it.skipIf(ENGINES.length === 0)(
    "뒤집힌 루트 툴바가 첫 답글의 머리 줄(이름·시각)을 가리지 않고, 띠는 그 여유가 4~12인 가장 작은 격자 값이다",
    async () => {
      const slack = async (leadClass: string) => {
        const markup = panelMarkup(leadClass);
        const css = await compileTokensCss(classesOf(markup));
        const playwright = await import("playwright");
        const results: { engine: string; slack: number; lead: number; blank: number; barTopInRoot: boolean }[] = [];
        for (const engine of ENGINES) {
          const browser = await playwright[engine].launch();
          try {
            const p = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
            await p.setContent(page(css, 320, markup));
            const m = await p.evaluate(() => {
              const rect = (el: Element): Rect => {
                const r = el.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
              };
              const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="timeline-message"]')];
              const bodies = [...document.querySelectorAll<HTMLElement>("[data-row-body]")];
              // `data-row-body`의 첫 줄이 머리 줄(이름·시각)이다: 그 윗변이 첫 답글의 첫 글자 줄이다.
              return {
                rootRow: rect(rows[0]),
                replyRow: rect(rows[1]),
                rootBody: rect(bodies[0]),
                replyBody: rect(bodies[1]),
                bar: rect(document.querySelector('[data-testid="message-hover-toolbar"]')!),
              };
            });
            results.push({
              engine,
              // 툴바 아랫변과 첫 답글 머리 줄 윗변의 여유(px). 음수면 가린다.
              slack: m.replyBody.top - m.bar.bottom,
              lead: m.replyRow.top - m.rootRow.bottom,
              // 루트 글 끝에서 첫 답글 머리 줄까지의 빈 공간(= 루트 아래 패딩 + 띠 + 묶음 머리 패딩).
              blank: m.replyBody.top - m.rootBody.bottom,
              barTopInRoot: m.bar.top < m.rootRow.bottom,
            });
          } finally {
            await browser.close();
          }
        }
        return results;
      };

      for (const r of await slack(THREAD_REPLIES_LEAD_CLASS)) {
        expect(r.barTopInRoot, `${r.engine} 툴바 윗변이 루트 행 안(뒤집힘)`).toBe(true);
        expect(r.lead, `${r.engine} 띠 높이`).toBeCloseTo(32, 1);
        expect(r.slack, `${r.engine} 툴바가 첫 답글 머리 줄을 가린다`).toBeGreaterThanOrEqual(4);
        expect(r.slack, `${r.engine} 띠가 툴바보다 12 넘게 크다 — 더 줄일 수 있는 값이다`).toBeLessThanOrEqual(12);
        // 루트 글 끝 → 첫 답글 머리 줄: 6 + 32 + 12. 타임라인의 묶음 사이(18)에 툴바 띠(32)를 더한 값이다.
        expect(r.blank, `${r.engine} 빈 공간`).toBeCloseTo(ROW_SPACE.betweenGroups + 32, 1);
      }
      // 한 단계 아래(24)는 이 판정을 못 지난다: 가장 작은 값이라는 말의 증거다.
      for (const r of await slack("pt-6")) {
        expect(r.slack, `${r.engine} pt-6은 여유 4를 못 만든다`).toBeLessThan(4);
      }
      // 앞 판처럼 띠를 6(`pt-row`)으로 줄이면 툴바가 머리 줄을 덮는다.
      for (const r of await slack("pt-row")) {
        expect(r.slack, `${r.engine} pt-row는 첫 답글 머리를 덮는다`).toBeLessThan(0);
      }
    }
  );
});
