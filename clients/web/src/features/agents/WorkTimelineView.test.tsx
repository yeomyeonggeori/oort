// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRunLedgerFromWire } from "@momo/core/lib/api";
import {
  workTimelineSections,
  workToolRecord,
  type WorkTimelineRow,
} from "@momo/core/features/agents/workTimeline";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { OortRecordSection, WorkTimelineRows, WorkTimelineSections } from "./WorkTimelineView";

// =============================================================================
// 작업 타임라인의 칸과 줄 (#4654). 무엇을 접고 어떻게 가르는지는 core가 가진다
// (`workTimeline.test.ts`). 여기서 지키는 것은 그것이 **화면에 그대로 서는가**다: 칸이 출처마다
// 갈리고 배지가 하나씩 서는가, 에이전트가 쓴 글이 마크업이 되지 않는가, 실패가 개별 줄로 서는가,
// 구 서버의 「모름」이 「0번」으로 읽히지 않는가.
// =============================================================================

const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;

let korean: AppLocale;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function rerender(element: ReactElement): void {
  act(() => {
    root?.render(createElement(LocaleProvider, { locale: korean, children: element }));
  });
}

function render(element: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(LocaleProvider, { locale: korean, children: element }));
  });
  return host;
}

function row(
  over: Partial<WorkTimelineRow> & Pick<WorkTimelineRow, "id" | "source">
): WorkTimelineRow {
  return { kind: "tool", label: null, status: "done", atMs: T, count: 1, ...over };
}

const q = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)];
const text = (el: Element | null) => el?.textContent ?? "";

function call(n: number, tool: string, code = "ok", durationMs = 12) {
  return { ordinal: n, kind: "tool_call", tool, code, durationMs, createdAtMs: T + n * 1000 };
}

describe("칸은 출처마다 하나다", () => {
  it("세 출처가 세 칸으로 서고 칸마다 배지가 하나이며 줄은 자기 출처만 가진다", () => {
    const sections = workTimelineSections([
      row({ id: "o1", source: "oort", label: "oort_run_event", durationMs: 35 }),
      row({ id: "a1", source: "agent", toolKind: "read", count: 12 }),
      row({ id: "a2", source: "agent", toolKind: "search", count: 3 }),
      row({ id: "a3", source: "agent", toolKind: "edit", label: "<img src=x onerror=alert(1)>" }),
      row({ id: "c1", source: "computer", toolKind: "run", label: null }),
      row({ id: "o2", source: "oort", toolKind: "read", label: "oort_inbox_read", count: 3 }),
    ]);
    const el = render(createElement(WorkTimelineSections, { sections, nowMs: T }));

    const cells = qa(el, "work-timeline-section");
    expect(cells.map((c) => c.getAttribute("data-source"))).toEqual(["oort", "agent", "computer"]);
    for (const cell of cells) {
      expect(qa(cell, "work-timeline-source-badge")).toHaveLength(1);
      for (const line of qa(cell, "work-timeline-row")) {
        expect(line.getAttribute("data-source")).toBe(cell.getAttribute("data-source"));
      }
    }
    expect(cells.map((c) => text(q(c, "work-timeline-source-badge")))).toEqual([
      "oort 기록",
      "에이전트 보고",
      "내 컴퓨터",
    ]);
    // 에이전트의 「읽기 12 · 검색 3」과 oort의 「읽기 3」은 한 줄에 합쳐지지 않는다.
    const [oortCell, agentCell, computerCell] = cells as [Element, Element, Element];
    expect(qa(agentCell, "work-timeline-label").map(text)).toEqual([
      "읽기 12 · 검색 3",
      "<img src=x onerror=alert(1)>",
    ]);
    expect(qa(oortCell, "work-timeline-label").map(text)).toEqual(["진행 알리기", "읽기 3"]);
    expect(qa(computerCell, "work-timeline-label").map(text)).toEqual(["명령 실행"]);
    // 에이전트가 쓴 글은 마크업이 아니라 글자다.
    expect(el.querySelector("img")).toBeNull();
    // 칸마다 믿음의 정도를 말하는 한 줄이 선다.
    expect(text(q(oortCell, "work-timeline-source-note"))).toContain("인자와 내용은 기록하지 않아요");
    expect(text(q(agentCell, "work-timeline-source-note"))).toContain("oort가 확인한 것은 아니에요");
  });
});

describe("「oort 기록」 칸의 네 상태", () => {
  it("반복은 한 줄로 접히고 실패는 개별 줄에 칩과 이유가 서며, 합계는 서버가 센 값이고 줄 상한은 한 줄로 알린다", () => {
    const events = [
      call(1, "oort_jobs_claim"),
      ...[2, 3, 4].map((n) => call(n, "oort_run_event", "ok", 35)),
      call(5, "oort_job_renew", "conflict", 1234),
      call(6, "oort_job_renew"),
    ];
    const record = workToolRecord(
      agentRunLedgerFromWire({
        runId: RUN,
        events,
        toolTally: [
          { tool: "oort_jobs_claim", ok: 1, error: 0, durationMsSum: 12 },
          { tool: "oort_run_event", ok: 120, error: 0, durationMsSum: 4200 },
          { tool: "oort_job_renew", ok: 9, error: 1, durationMsSum: 1500 },
        ],
        toolCallRowsCapped: true,
      })
    );
    const el = render(createElement(OortRecordSection, { record, open: true, nowMs: T }));

    const lines = qa(el, "work-timeline-row");
    expect(lines.map((l) => text(q(l, "work-timeline-label")))).toEqual([
      "일 가져가기",
      "진행 알리기 3",
      "맡은 시간 늘리기",
      "맡은 시간 늘리기",
    ]);
    const failed = lines[2] as Element;
    expect(failed.getAttribute("data-status")).toBe("failed");
    expect(text(q(failed, "work-timeline-status"))).toBe("실패");
    expect(text(q(failed, "work-timeline-failure"))).toBe("다른 변경과 겹쳤어요");
    expect(text(q(failed, "work-timeline-duration"))).toBe("1.2초");
    // 접힌 줄에는 시간이 없고 실패하지 않은 줄에는 칩이 없다.
    expect(q(lines[1] as Element, "work-timeline-duration")).toBeNull();
    expect(q(lines[3] as Element, "work-timeline-status")).toBeNull();
    // 합계는 서버가 센 값(행 상한을 넘은 호출까지)이고, 상한 문장은 줄로 선 수를 말한다.
    expect(text(q(el, "agent-work-panel-oort-summary"))).toBe("도구 호출 131 · 실패 1");
    expect(text(q(el, "agent-work-panel-oort-capped"))).toContain("처음 6번만 줄로 보여요");
    expect(q(el, "agent-work-panel-oort-unsupported")).toBeNull();
  });

  it("합계 없는 응답(구 서버)은 「서버 업데이트 뒤에 보여요」이고 0번이라고 말하지 않는다", () => {
    const record = workToolRecord(
      agentRunLedgerFromWire({ runId: RUN, events: [{ ordinal: 1, kind: "queued", createdAtMs: T }] })
    );
    const el = render(createElement(OortRecordSection, { record, open: true, nowMs: T }));
    expect(text(q(el, "agent-work-panel-oort-unsupported"))).toBe("oort 호출 기록은 서버 업데이트 뒤에 보여요.");
    expect(q(el, "agent-work-panel-oort-summary")).toBeNull();
    expect(q(el, "agent-work-panel-oort-empty")).toBeNull();
    expect(q(el, "work-timeline-rows")).toBeNull();
    expect(text(el)).not.toMatch(/0번/);
    // 칸 머리는 구 서버에서도 서서 이 칸이 무엇인지 말한다.
    expect(text(q(el, "work-timeline-source-badge"))).toBe("oort 기록");
  });

  it("빈 합계는 「호출 없음」이다: 열린 run과 끝난 run의 말이 다르고 합계 줄은 서지 않는다", () => {
    const record = workToolRecord(
      agentRunLedgerFromWire({ runId: RUN, events: [], toolTally: [], toolCallRowsCapped: false })
    );
    const open = render(createElement(OortRecordSection, { record, open: true, nowMs: T }));
    expect(text(q(open, "agent-work-panel-oort-empty"))).toBe("아직 oort가 잰 도구 호출이 없어요.");
    expect(q(open, "agent-work-panel-oort-summary")).toBeNull();
    expect(q(open, "agent-work-panel-oort-unsupported")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const ended = render(createElement(OortRecordSection, { record, open: false, nowMs: T }));
    expect(text(q(ended, "agent-work-panel-oort-empty"))).toBe("이 일에서 oort가 잰 도구 호출은 없었어요.");
  });
});

describe("줄의 모션 (#4657, A1 모션 규칙)", () => {
  const rowsOf = (...over: Array<Partial<WorkTimelineRow> & Pick<WorkTimelineRow, "id">>) =>
    over.map((o, index) => row({ source: "agent", toolKind: "edit", atMs: T + index, ...o }));
  const li = (el: ParentNode) => qa(el, "work-timeline-row");

  it("같은 id의 줄은 같은 DOM 노드에서 상태만 바뀌고, 새로 도착한 줄만 도착 표지를 받으며, 점은 진행 중인 마지막 행 하나뿐이다", () => {
    const first = rowsOf(
      { id: "agent|activity|a1", label: "리포트 고치기", status: "running" },
      { id: "agent|activity|a2", label: "테스트 돌리기", status: "running", toolKind: "run" }
    );
    const el = render(createElement(WorkTimelineRows, { rows: first, nowMs: T, live: true }));
    const [a1, a2] = li(el) as [Element, Element];
    // 처음 그릴 때 이미 있던 줄은 움직이지 않는다. 점은 진행 중인 마지막 행(a2) 하나.
    expect(li(el).map((node) => node.hasAttribute("data-arrived"))).toEqual([false, false]);
    expect(qa(el, "work-timeline-dot")).toHaveLength(1);
    expect(a2.contains(q(el, "work-timeline-dot"))).toBe(true);

    // a1이 끝나고 새 줄 a3이 붙는다.
    rerender(
      createElement(WorkTimelineRows, {
        rows: rowsOf(
          { id: "agent|activity|a1", label: "리포트 고치기", status: "done" },
          { id: "agent|activity|a2", label: "테스트 돌리기", status: "running", toolKind: "run" },
          { id: "agent|activity|a3", label: "요약 쓰기", status: "running", toolKind: "other" }
        ),
        nowMs: T,
        live: true,
      })
    );
    const after = li(el);
    expect(after[0]).toBe(a1); // 제자리 행: 같은 노드
    expect(after[1]).toBe(a2);
    expect(a1.getAttribute("data-status")).toBe("done");
    expect(q(a1, "work-timeline-status")).toBeNull(); // 끝남은 조용하다
    expect(after.map((node) => node.hasAttribute("data-arrived"))).toEqual([false, false, true]);
    // 점은 새로 진행 중인 마지막 행으로 옮겨 갔다: 여전히 하나다.
    expect(qa(el, "work-timeline-dot")).toHaveLength(1);
    expect((after[2] as Element).contains(q(el, "work-timeline-dot"))).toBe(true);

    // 연결이 끊기면 점이 걷히고 칩은 에이전트색(data-live)을 잃는다. 줄은 그대로다.
    rerender(createElement(WorkTimelineRows, { rows: rowsOf(
      { id: "agent|activity|a1", label: "리포트 고치기", status: "done" },
      { id: "agent|activity|a2", label: "테스트 돌리기", status: "running", toolKind: "run" },
      { id: "agent|activity|a3", label: "요약 쓰기", status: "running", toolKind: "other" }
    ), nowMs: T, live: false }));
    expect(qa(el, "work-timeline-dot")).toHaveLength(0);
    expect(qa(el, "work-timeline-status").some((chip) => chip.hasAttribute("data-live"))).toBe(false);
    expect(li(el)[0]).toBe(a1);
  });

  it("동작 줄이기에서는 점이 멈춘 채 서고, 시각·개수는 초 단위 숫자 없이 고정 폭 숫자다", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      addEventListener() {},
      removeEventListener() {},
    }));
    const el = render(
      createElement(WorkTimelineRows, {
        rows: rowsOf({ id: "agent|activity|a1", label: "리포트 고치기", status: "running", count: 3 }),
        nowMs: T,
        live: true,
      })
    );
    const dot = q(el, "work-timeline-dot") as Element;
    expect(dot.hasAttribute("data-still")).toBe(true);
    expect(text(q(el, "work-timeline-time"))).toMatch(/^\d{2}:\d{2}$/);
    expect(q(el, "work-timeline-time")?.hasAttribute("data-numeric")).toBe(true);
    expect(text(q(el, "work-timeline-repeat")).trim()).toBe("3");
    expect(text(el)).not.toMatch(/\d+초/);
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const moving = render(
      createElement(WorkTimelineRows, {
        rows: rowsOf({ id: "agent|activity|a1", label: "리포트 고치기", status: "running" }),
        nowMs: T,
        live: true,
      })
    );
    expect(q(moving, "work-timeline-dot")?.hasAttribute("data-still")).toBe(false);
  });

  it("모션의 값은 새 숫자가 아니라 기존 사다리다: 새 줄은 불투명도만 표준 길이, 상태는 즉시 길이, 동작 줄이기는 0 (숫자는 브라우저 시험이 잰다)", () => {
    // 이 계약의 숫자(A1 모션 규칙 1·2). 숫자 손기입은 `motion.css`에만 두는 것이 규칙이라(`raw_motion`) 시험도 상수와
    // 조립한 정규식으로 읽는다.
    const STANDARD = 240;
    const INSTANT = 120;
    const motion = readFileSync(resolve(process.cwd(), "src/design/motion.css"), "utf8");
    const tokens = readFileSync(resolve(process.cwd(), "src/design/tokens.css"), "utf8");
    const view = readFileSync(resolve(process.cwd(), "src/features/agents/WorkTimelineView.tsx"), "utf8");
    // 새 줄: `motion-enter` = 불투명도 키프레임 + `--motion-standard`. 이동(transform)이 없다.
    expect(motion).toMatch(/@utility motion-enter \{\s*animation: motion-fade-in var\(--motion-standard\)/);
    const fade = motion.slice(motion.indexOf("@keyframes motion-fade-in"), motion.indexOf("@keyframes motion-fade-out"));
    expect(fade).toMatch(/opacity/);
    expect(fade).not.toMatch(/transform|translate|margin|top|height/);
    expect(motion).toMatch(new RegExp(`--motion-standard:\\s*${STANDARD}ms`));
    expect(motion).toMatch(new RegExp(`--motion-instant:\\s*${INSTANT}ms`));
    // 상태 변화: 색 전환만이고 기본 전환 길이가 `--motion-instant`다.
    expect(tokens).toMatch(/--default-transition-duration:\s*var\(--motion-instant\)/);
    expect(view).toContain("transition-colors");
    expect(view).toContain("data-arrived:motion-enter");
    // 동작 줄이기: 사다리가 0ms가 된다.
    const reduced = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(new RegExp(`--motion-instant:\\s*${0}ms`));
    expect(reduced).toMatch(new RegExp(`--motion-standard:\\s*${0}ms`));
  });
});
