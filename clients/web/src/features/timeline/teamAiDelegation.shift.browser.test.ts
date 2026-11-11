// @vitest-environment jsdom

import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { mkdirSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunProgress, AgentRunSpent, Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { defaultTeamAiRoles } from "@momo/core/features/settings/teamAiRoles";
import type { TeamAiDelegationStatus } from "@momo/core/features/settings/teamAiLimits";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TeamAiRolesList } from "@/features/settings/TeamAiRolesList";
import { TeamAiDelegationLimitItem } from "@/features/settings/TeamAiDelegationLimitItem";
import { MessageRow } from "./MessageRow";

// =============================================================================
// 맡겨 받은 그림·쓴 양 줄이 늦게 와도 대화가 밀리지 않는다 (#5375, 승격 목표 「대화 흔들림 0」) — 실제 Chromium 으로 잰다.
//
// 진짜 `MessageRow` 를 jsdom 에서 그려 마크업을 얻고(시험이 따로 적은 사본이 아니다), 같은 CSS 로 Chromium 에 올린다. 대화는
// 세 줄이다: 사람의 요청 → 도우미의 답(맡겨 받은 그림 한 장 + 칩 + 쓴 양 줄) → 다음 사람의 글. 재는 것:
//   (1) 그림이 「받는 중」 → 「도착(실제 PNG 디코드)」 → 「못 불러옴」으로 바뀌어도 답의 높이와 다음 글의 위치가 같다.
//       그림 비율 셋(정사각·가로 3:2·세로 2:3) × 열 폭 셋(300·480·720).
//   (2) 쓴 양의 숫자가 없음 → 도착(어림 아님·어림)으로 바뀌어도 같다.
//   (3) 대조: 칩 칸이 없는 답(예전 길)의 같은 그림은 「받는 중」 → 「도착」에서 실제로 자란다(이 시험의 자가 진짜 움직임을 잰다).
//   (4) 위임을 기다리는 진행 줄의 마감 안내가 스레드 패널 320·폭 390에서도 칸 안에 온전히 보이고 이름을 밀어내지 않는다(짧은 글),
//       넓은 열에서는 긴 문장이다(#5375 수리 1회차, 검수 M2).
//
// 캡처: `CAP5375_DIR` 이 있으면 대화(진행 중·끝 그림·끝 검색·실패·시간 초과)와 설정(켜짐·꺼짐·연결 안 됨) 판을 1280·390,
// 밝게·어둡게, 200%(640 CSS px · 배율 2)로, 진행 중 판은 스레드 패널 320으로도 그 폴더에 쓴다. 번들 Chromium 헤드리스만 띄운다.
// =============================================================================

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

let previewStatus: "loading" | "ready" | "failed" = "loading";
/** 마크업 안의 자리 표지. Chromium 에서 진짜 PNG(요청한 가로세로)로 바꾼다. */
const PLACEHOLDER_SRC = "data:image/png;base64,UExBQ0VIT0xERVI=";
vi.mock("@/features/attachments/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/attachments/content")>();
  return {
    ...actual,
    useAttachmentPreview: () =>
      previewStatus === "ready"
        ? { status: "ready", dataUrl: PLACEHOLDER_SRC, retry: () => {} }
        : { status: previewStatus, retry: () => {} },
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const MINSU = "00000000-0000-7000-8000-0000000001ee";
const HELPER = "00000000-0000-7000-8000-0000000002aa";
const HERMES = "00000000-0000-7000-8000-0000000003bb";
const RUN = "0199eeee-0000-7000-8000-00000000a001";
const T0 = new Date("2026-11-10T05:20:30Z").getTime();

let korean: AppLocale;
beforeAll(async () => {
  korean = await koreanLocaleForTest();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
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

function member(id: string, kind: "human" | "agent", displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

const DIRECTORY = makeDirectory([
  member(ME, "human", "박서연", "seoyeon"),
  member(MINSU, "human", "김민수", "minsu"),
  member(HELPER, "agent", "오르트 도우미", "oort"),
  member(HERMES, "agent", "팀 Hermes", "hermes"),
]);

const SPENT: AgentRunSpent = { promptTokens: 9_000, completionTokens: 3_345, webSearches: 0, estimated: false, delegations: 1 };
const PICTURE = { id: "0199cccc-0000-7000-8000-0000000000a1", name: "picture.png", mime: "image/png", sizeBytes: 812_000 };
const MODEL = { model: "claude-sonnet-4-5", wire: "messages" };

function msg(id: string, seq: number, author: string, body: string, extra: Partial<Message> = {}): Message {
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
    createdAtMs: T0 + seq * 1_000,
    ...extra,
  };
}

const REQUEST = msg("0199eeee-0000-7000-8000-000000000600", 11, ME, "@오르트 도우미 창가에 앉은 고양이 그려 줘");
const NEXT = msg("0199eeee-0000-7000-8000-000000000602", 13, MINSU, "귀엽네요. 이번 소식지 표지로 써도 될까요?");

function pictureAnswer(delegated: boolean): Message {
  return msg("0199eeee-0000-7000-8000-000000000601", 12, HELPER, "창가에 앉은 고양이를 그렸어요. 오후 햇살이 들어오는 장면이에요.", {
    props: {
      source: "team_ai",
      run_id: RUN,
      team_ai_model: MODEL,
      ...(delegated ? { team_ai_delegated: [{ kind: "image", agent_member_id: HERMES }] } : {}),
    },
    attachments: [PICTURE],
  });
}

function searchAnswer(): Message {
  return msg("0199eeee-0000-7000-8000-000000000611", 12, HELPER, "이번 주 서울 날씨는 화요일까지 맑고 수요일 오후부터 비 소식이 있어요.", {
    props: {
      source: "team_ai",
      run_id: RUN,
      team_ai_model: MODEL,
      team_ai_delegated: [{ kind: "web_search", agent_member_id: HERMES }],
    },
  });
}

function closedAnswer(id: string, body: string): Message {
  return msg(id, 12, HELPER, body, { props: { source: "team_ai", run_id: RUN, team_ai_model: MODEL } });
}

function session(): SessionContextValue {
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

/** 진짜 부품을 한 번 그려 마크업을 얻는다. `spent` 가 `null` 이면 쓴 양이 아직 없다. */
function html(children: ReactNode, spent: AgentRunSpent | null = SPENT): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["agent-run-spent", WS, RUN], spent);
  const node: ReactElement = createElement(LocaleProvider, {
    locale: korean,
    children: createElement(
      SessionProvider,
      { value: session() },
      createElement(
        OpenMemberProfileContext.Provider,
        { value: () => undefined },
        createElement(QueryClientProvider, { client }, children)
      )
    ),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const out = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return out;
}

function row(message: Message, extra: Record<string, unknown> = {}): ReactElement {
  return createElement(MessageRow, { key: message.id, message, directory: DIRECTORY, startsGroup: true, ...extra });
}

function conversation(answer: Message, spent: AgentRunSpent | null = SPENT): string {
  return html([row(REQUEST), row(answer), row(NEXT)], spent);
}

const classesOf = (markup: string) =>
  [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, columnWidth: number): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#col { width: ${columnWidth}px; padding: 8px 0; }
</style></head><body class="bg-pane text-ink"><div id="col"></div></body></html>`;
}

type Page = import("playwright").Page;

interface Geometry {
  answerHeight: number;
  nextTop: number;
  pictureLoaded: boolean;
}

/** 마크업을 올리고, 자리 표지 그림을 요청한 가로세로의 진짜 PNG로 바꿔 디코드까지 기다린 뒤 잰다. */
async function show(p: Page, markup: string, size: { width: number; height: number }): Promise<Geometry> {
  return p.evaluate(
    async ({ markup, size, placeholder }) => {
      const col = document.getElementById("col")!;
      col.innerHTML = markup;
      const imgs = [...col.querySelectorAll<HTMLImageElement>("img")].filter((img) => img.src === placeholder);
      let pictureLoaded = false;
      for (const img of imgs) {
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const g = canvas.getContext("2d")!;
        // 색 글자 없이 픽셀 값으로 그린다(하늘색 바탕 + 가운데 밝은 창): 재는 것은 크기이고, 캡처에서 그림 자리가 보이면 된다.
        const pixels = g.createImageData(size.width, size.height);
        for (let y = 0; y < size.height; y += 1) {
          for (let x = 0; x < size.width; x += 1) {
            const inside = x > size.width * 0.2 && x < size.width * 0.8 && y > size.height * 0.3 && y < size.height * 0.8;
            const i = (y * size.width + x) * 4;
            pixels.data[i] = inside ? 242 : 106;
            pixels.data[i + 1] = inside ? 214 : 140;
            pixels.data[i + 2] = inside ? 162 : 175;
            pixels.data[i + 3] = 255;
          }
        }
        g.putImageData(pixels, 0, 0);
        img.src = canvas.toDataURL("image/png");
        await img.decode();
        pictureLoaded = img.naturalWidth === size.width;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const articles = [...col.querySelectorAll<HTMLElement>("article")];
      const answer = articles[1]!.getBoundingClientRect();
      const next = articles[2]!.getBoundingClientRect();
      return { answerHeight: answer.height, nextTop: next.top, pictureLoaded };
    },
    { markup, size, placeholder: PLACEHOLDER_SRC }
  );
}

function markupFor(status: typeof previewStatus, answer: Message, spent: AgentRunSpent | null = SPENT): string {
  previewStatus = status;
  try {
    return conversation(answer, spent);
  } finally {
    previewStatus = "loading";
  }
}

const SIZES = [
  { key: "정사각", width: 1024, height: 1024 },
  { key: "가로 3:2", width: 1024, height: 683 },
  { key: "세로 2:3", width: 683, height: 1024 },
];
const COLUMNS = [300, 480, 720];
const TOL = 0.5;

// ---- 캡처 판 --------------------------------------------------------------------------------------

function progressRun(lastEventAgoMs: number): AgentRunProgress {
  return {
    id: RUN,
    channelId: CH,
    agentMemberId: HELPER,
    triggerMessageId: REQUEST.id,
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 1,
    latestStage: "위임: 팀 Hermes · 그림",
    lastEventAtMs: T0 - lastEventAgoMs,
    startedAtMs: T0 - lastEventAgoMs - 4_000,
    createdAtMs: T0 - lastEventAgoMs - 5_000,
    updatedAtMs: T0 - lastEventAgoMs,
    ahead: [],
    spent: { ...SPENT, delegations: 0 },
  };
}

function delegation(over: Partial<TeamAiDelegationStatus> = {}): TeamAiDelegationStatus {
  return { known: true, limit: null, effective: 30, ceiling: 50, ceilingOff: false, today: 4, available: true, unavailableReason: null, ...over };
}

function settingsBoard(hermes: TeamAiDelegationStatus, hermesOn = true): string {
  return html(
    createElement(
      "div",
      { className: "flex min-w-0 flex-col gap-4" },
      createElement(TeamAiRolesList, {
        roles: { ...defaultTeamAiRoles(), hermes: hermesOn },
        rowNotices: true,
        testIdPrefix: "cap",
        onToggle: () => undefined,
        hermes,
      }),
      createElement("ul", { className: "flex min-w-0 flex-col" },
        hermes.known && !hermes.ceilingOff
          ? createElement(TeamAiDelegationLimitItem, { workspaceId: WS, status: hermes, offline: false })
          : null
      )
    )
  );
}

/** 진행 줄을 재는 때(위임 stage 뒤 초). 20초가 기준이다. */
const PROGRESS_AT = [20, 60, 100, 130] as const;

/**
 * 생각 줄이 서는 좁은 자리(#5375 수리 1회차, 검수 M2): 요청 스레드 패널의 기본 폭(`--spacing-pane` 320)과 폭 390 화면의 대화 열
 * (358 = 캡처의 390 판과 같은 열). 이 폭에서 마감 안내가 줄임표에 잘리지 않고 온전히 보여야 하고(짧은 글), 넓은 열(720)에서는
 * 긴 문장 그대로다.
 */
const WAIT_COLUMNS = [
  // 스레드 패널을 가장 좁힌 폭(`--spacing-pane-sm` 192, `thread-pane`의 min-inline-size): 이름까지 남길 자리는 없다(칸 안에서 겹치지만 않는다).
  { tag: "thread192", width: 192, long: false, nameFits: false },
  { tag: "thread320", width: 320, long: false, nameFits: true },
  { tag: "390", width: 358, long: false, nameFits: true },
  { tag: "wide720", width: 720, long: true, nameFits: true },
] as const;

interface ThoughtLineGeometry {
  slotLeft: number;
  slotRight: number;
  /** 마감 안내 꼬리(`request-thought-wait`). 없으면 null. */
  wait: { left: number; right: number; text: string } | null;
  /** 몸(이름·stage)이 받은 폭, 줄임표 없이 필요한 폭, 같은 글꼴의 에이전트 이름만의 폭. */
  body: { width: number; natural: number; name: number } | null;
  /** 몸·꼬리를 감싼 글 칸의 오른끝. 꼬리가 이보다 나가면 점·화살표를 덮는다. */
  boxRight: number;
}

/** 열에 올린 진행 줄의 생각 줄 한 줄을 잰다(`show` 뒤에 부른다). `name` 은 몸 앞의 에이전트 이름이다. */
async function thoughtLine(p: Page, name: string): Promise<ThoughtLineGeometry> {
  return p.evaluate((name) => {
    const slot = document.querySelector<HTMLElement>('[data-testid="request-thought-slot"]')!.getBoundingClientRect();
    const tail = document.querySelector<HTMLElement>('[data-testid="request-thought-wait"]');
    const bodyEl = tail?.previousElementSibling as HTMLElement | null | undefined;
    const t = tail?.getBoundingClientRect();
    let body: ThoughtLineGeometry["body"] = null;
    if (bodyEl) {
      // 몸 글의 첫 낱자부터 이름 길이만큼을 Range로 잰다(줄임표로 잘려도 글자는 제자리에 놓여 있다). 스타일은 쓰지 않는다.
      const text = [...bodyEl.childNodes].find((node): node is Text => node.nodeType === Node.TEXT_NODE);
      let nameWidth = Number.NaN;
      if (text !== undefined && text.data.startsWith(name)) {
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, name.length);
        nameWidth = range.getBoundingClientRect().width;
      }
      body = { width: bodyEl.getBoundingClientRect().width, natural: bodyEl.scrollWidth, name: nameWidth };
    }
    const box = tail?.parentElement?.getBoundingClientRect();
    return {
      slotLeft: slot.left,
      slotRight: slot.right,
      wait: tail && t ? { left: t.left, right: t.right, text: tail.innerText } : null,
      body,
      boxRight: box?.right ?? Number.NaN,
    };
  }, name);
}

function progressMarkups(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const at of PROGRESS_AT) {
    out[`progress-${at}`] = html([
      row(REQUEST, { runStatus: [progressRun(at * 1_000)], showThought: true }),
      row(NEXT),
      row(msg("0199eeee-0000-7000-8000-000000000603", 14, ME, "좋아요. 표지 시안 기다릴게요.")),
    ]);
  }
  return out;
}

describe("맡겨 받은 그림·쓴 양 줄이 늦게 와도 대화가 밀리지 않는다 (#5375)", () => {
  it.skipIf(!ENGINES.includes("chromium"))(
    "그림 받는 중 → 도착 → 못 불러옴, 쓴 양 없음 → 도착: 답의 높이와 다음 글의 자리가 같다 (실제 Chromium)",
    async () => {
      const delegated = pictureAnswer(true);
      const markups = {
        loading: markupFor("loading", delegated),
        ready: markupFor("ready", delegated),
        failed: markupFor("failed", delegated),
        noSpent: markupFor("ready", delegated, null),
        estimated: markupFor("ready", delegated, { ...SPENT, estimated: true }),
        legacyLoading: markupFor("loading", pictureAnswer(false)),
        legacyReady: markupFor("ready", pictureAnswer(false)),
      };
      // 진행 줄: 위임 stage 뒤 20·60·100초(마감 안 — 안내 한 줄)와 130초(마감 뒤 — 「소식 없음」). 대화는 요청 → 다음 글 둘.
      const progress = progressMarkups();
      const css = await compileTokensCss([...Object.values(markups), ...Object.values(progress)].flatMap(classesOf));
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      const problems: string[] = [];
      const measured: string[] = [];
      try {
        const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
        const p = await context.newPage();
        for (const columnWidth of COLUMNS) {
          await p.setContent(page(css, columnWidth));
          for (const size of SIZES) {
            const at = `${columnWidth}px·${size.key}`;
            const loading = await show(p, markups.loading, size);
            const ready = await show(p, markups.ready, size);
            const failed = await show(p, markups.failed, size);
            if (!ready.pictureLoaded) problems.push(`${at}: 그림이 디코드되지 않았다(시험의 자가 아무것도 재지 않는다)`);
            for (const [name, g] of [["도착", ready], ["못 불러옴", failed]] as const) {
              const moved = g.nextTop - loading.nextTop;
              if (Math.abs(moved) > TOL || Math.abs(g.answerHeight - loading.answerHeight) > TOL) {
                problems.push(`${at}: 받는 중 → ${name}에서 다음 글이 ${moved}px 움직였다(답 ${loading.answerHeight} → ${g.answerHeight})`);
              }
            }
            measured.push(`${at} 그림 이동 ${ready.nextTop - loading.nextTop}px`);
          }
          const square = SIZES[0]!;
          const noSpent = await show(p, markups.noSpent, square);
          const withSpent = await show(p, markups.ready, square);
          const estimated = await show(p, markups.estimated, square);
          for (const [name, g] of [["쓴 양 도착", withSpent], ["쓴 양 도착(어림)", estimated]] as const) {
            const moved = g.nextTop - noSpent.nextTop;
            if (Math.abs(moved) > TOL) problems.push(`${columnWidth}px: 쓴 양 없음 → ${name}에서 다음 글이 ${moved}px 움직였다`);
          }
          measured.push(`${columnWidth}px 쓴 양 이동 ${withSpent.nextTop - noSpent.nextTop}px / 어림 ${estimated.nextTop - noSpent.nextTop}px`);
          // 대조: 예전 길(칩 칸 없음)은 크기를 모르는 그림이 도착하며 실제로 자란다.
          const legacyLoading = await show(p, markups.legacyLoading, square);
          const legacyReady = await show(p, markups.legacyReady, square);
          const grew = legacyReady.nextTop - legacyLoading.nextTop;
          measured.push(`${columnWidth}px 대조(예전 길) 이동 ${grew}px`);
          if (grew <= TOL) problems.push(`${columnWidth}px: 대조가 움직이지 않았다(${grew}px) — 자가 실제 이동을 못 잰다`);
          // 진행 줄이 「위임: … · 그림」 → 「… · 그림은 2분까지 걸릴 수 있어요」 → 「2분째 소식 없음」으로 바뀌어도 다음 글이 그대로다.
          const first = await show(p, progress["progress-20"]!, square);
          for (const at of PROGRESS_AT) {
            const g = await show(p, progress[`progress-${at}`]!, square);
            const moved = g.nextTop - first.nextTop;
            if (Math.abs(moved) > TOL) problems.push(`${columnWidth}px: 진행 줄 20초 → ${at}초에서 다음 글이 ${moved}px 움직였다`);
          }
          measured.push(`${columnWidth}px 진행 줄 20→60→100→130초 이동 0px 확인`);
        }

        // 좁은 자리(스레드 패널 320·폭 390)와 넓은 열(720): 마감 안내가 온전히 보이고(줄임표 없이 칸 안, 이름을 밀어내지 않고),
        // 진행 줄이 바뀌어도 다음 글이 그대로다.
        for (const narrow of WAIT_COLUMNS) {
          await p.setContent(page(css, narrow.width));
          const square = SIZES[0]!;
          const first = await show(p, progress["progress-20"]!, square);
          for (const at of PROGRESS_AT) {
            const g = await show(p, progress[`progress-${at}`]!, square);
            const moved = g.nextTop - first.nextTop;
            if (Math.abs(moved) > TOL) problems.push(`${narrow.tag}(${narrow.width}px): 진행 줄 20초 → ${at}초에서 다음 글이 ${moved}px 움직였다`);
            const line = await thoughtLine(p, "오르트 도우미");
            if (at === 130) {
              if (line.wait !== null) problems.push(`${narrow.tag}: 마감 뒤(130초)에도 안내가 남았다`);
              continue;
            }
            const where = `${narrow.tag}(${narrow.width}px) ${at}초`;
            if (line.wait === null) {
              problems.push(`${where}: 마감 안내 꼬리가 없다`);
              continue;
            }
            const want = narrow.long ? "그림은 2분까지 걸릴 수 있어요" : "그림 최대 2분";
            if (line.wait.text.trim() !== `· ${want}`) problems.push(`${where}: 보이는 안내 글이 「${line.wait.text}」다(기대 「· ${want}」)`);
            if (line.wait.left < line.slotLeft - TOL || line.wait.right > line.slotRight + TOL) {
              problems.push(`${where}: 안내가 칸 밖으로 나갔다(안내 ${line.wait.left}~${line.wait.right}, 칸 ${line.slotLeft}~${line.slotRight})`);
            }
            // 꼬리가 글 칸을 넘어 점·화살표를 덮지 않는다.
            if (!(line.wait.right <= line.boxRight + TOL)) {
              problems.push(`${where}: 안내가 글 칸 오른끝(${line.boxRight})을 넘었다(${line.wait.right}) — 점·화살표를 덮는다`);
            }
            if (line.body === null || !(line.body.name > 0)) {
              problems.push(`${where}: 몸 글에서 이름 폭을 재지 못했다(자가 아무것도 재지 않는다)`);
            } else if (narrow.nameFits && line.body.width + TOL < line.body.name) {
              // 안내가 이름까지 밀어내지 않는다: 몸에 이름만큼의 폭은 남는다(긴 안내를 좁은 칸에 그대로 두면 몸이 줄임표 하나가 된다).
              problems.push(`${where}: 몸이 이름 폭(${line.body.name}px)보다 좁다(${line.body.width}px) — 안내가 이름을 밀어냈다`);
            }
            measured.push(
              `${where}: 칸 ${Math.round(line.slotRight - line.slotLeft)}px · 안내 「${line.wait.text.trim()}」 ${Math.round(line.wait.right - line.wait.left)}px` +
                (line.body ? ` · 몸 ${Math.round(line.body.width)}/${line.body.natural}px(이름 ${Math.round(line.body.name)}px)` : "") +
                ` · 안내 오른끝 ${Math.round(line.wait.right)} / 글 칸 오른끝 ${Math.round(line.boxRight)}` +
                ` · 다음 글 이동 ${moved}px`
            );
          }
        }

        const capDir = process.env.CAP5375_DIR;
        if (capDir !== undefined && capDir !== "") {
          mkdirSync(capDir, { recursive: true });
          const boards: Record<string, string> = {
            "timeline-progress-60s": progress["progress-60"]!,
            "timeline-progress-100s": progress["progress-100"]!,
            "timeline-progress-130s": progress["progress-130"]!,
            "timeline-done-picture": markups.ready,
            "timeline-done-search": html([row(REQUEST), row(searchAnswer()), row(NEXT)]),
            "timeline-failed": html([
              row(REQUEST),
              row(closedAnswer("0199eeee-0000-7000-8000-000000000621", "Hermes가 일을 끝내지 못했어요.")),
            ]),
            "timeline-timeout": html([
              row(REQUEST),
              row(closedAnswer("0199eeee-0000-7000-8000-000000000631", "Hermes가 제때 답하지 못했어요. 잠시 뒤에 다시 불러 주세요. (일은 끝났을 수 있어요)")),
            ]),
            "settings-on": settingsBoard(delegation()),
            "settings-bundle-off": settingsBoard(delegation(), false),
            "settings-ops-off": settingsBoard(delegation({ ceiling: null, ceilingOff: true, effective: 0, available: false, unavailableReason: "ceiling_unset" })),
            "settings-not-connected": settingsBoard(delegation({ available: false, unavailableReason: "hermes_not_connected" })),
          };
          const capCss = await compileTokensCss(Object.values(boards).flatMap(classesOf));
          const variants = [
            { tag: "1280", viewport: 1280, column: 760, scale: 2 },
            { tag: "390", viewport: 390, column: 358, scale: 2 },
            { tag: "zoom200", viewport: 640, column: 600, scale: 2 },
            // 요청 스레드 패널의 기본 폭(`--spacing-pane` 320): 생각 줄이 서는 판만(#5375 수리 1회차, 검수 M2).
            { tag: "thread320", viewport: 320, column: 320, scale: 2, only: "timeline-progress" },
          ];
          for (const variant of variants) {
            const c = await browser.newContext({ viewport: { width: variant.viewport, height: 900 }, deviceScaleFactor: variant.scale });
            const cp = await c.newPage();
            await cp.setContent(page(capCss, variant.column));
            for (const [name, markup] of Object.entries(boards)) {
              if (variant.only !== undefined && !name.startsWith(variant.only)) continue;
              for (const scheme of ["light", "dark"] as const) {
                if (variant.tag === "zoom200" && scheme === "dark") continue;
                await cp.emulateMedia({ colorScheme: scheme });
                await show(cp, markup, { width: 1024, height: 683 }).catch(() => undefined);
                await cp.locator("#col").screenshot({ path: `${capDir}/${name}-${variant.tag}-${scheme}.png` });
              }
            }
            await c.close();
          }
        }
        await context.close();
      } finally {
        await browser.close();
      }
      console.info(`[#5375 이동 실측]\n${measured.join("\n")}`);
      expect(problems).toEqual([]);
    },
    120_000
  );
});
