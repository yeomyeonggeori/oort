// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESTART_QUIET_MS, type LocalWorkFacts } from "@momo/core/features/workbench/localWork";
import type { PaneSignal, PaneStatusInput } from "@momo/core/features/workbench/paneStatus";

// 업데이트 뒤 자동 다시 시작이 이 맥의 로컬 작업을 끊지 않는가 (#5661, owner 2026-11-11). 실제 저장소 + 실제 카드에
// 가짜 시계와 가짜 「로컬 작업」 원천을 물린다. 판정은 코어(`localWork.ts`), 여기는 그 판정이 다시 시작을 실제로 막고 푸는지 잰다.

const tauri = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  onProgress: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  appVersion: () => Promise.resolve("0.1.45"),
  desktopUpdater: {
    check: tauri.check,
    install: tauri.install,
    relaunch: tauri.relaunch,
    onProgress: tauri.onProgress,
  },
}));

import { BEFORE_RELAUNCH_EVENT } from "./relaunchFlush";
import { UpdateButton } from "./UpdateButton";
import {
  RELAUNCH_AFTER_WAIT_SECONDS,
  RESTART_GATE_TICK_MS,
  checkForUpdate,
  installUpdate,
  resetUpdateStoreForTest,
  seedUpdateStateForTest,
  startUpdateWatch,
  type LocalWorkSource,
} from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE = { version: "0.1.46", currentVersion: "0.1.45", notes: null, publishedAt: null };

const pane = (signal: PaneSignal | null): PaneStatusInput => ({ phase: "running", exitCode: null, exitSignal: null, signal });
const NONE: LocalWorkFacts = { panes: [], workHost: { running: false }, hostSessions: null };

let facts: LocalWorkFacts = NONE;
const source: LocalWorkSource = { refresh: vi.fn(async () => undefined), read: () => facts };

let stop: (() => void) | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let composer: HTMLTextAreaElement | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** 새 판을 묻고 받아 설치까지 끝낸다(알약을 누른 것과 같다). */
async function installWith(start: LocalWorkFacts): Promise<void> {
  facts = start;
  stop = startUpdateWatch({ localWork: source });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(UpdateButton)));
  await advance(0);
  await act(async () => {
    await installUpdate();
  });
  await advance(0);
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 11, 3, 0, 0) });
  resetUpdateStoreForTest();
  for (const fn of Object.values(tauri)) fn.mockReset();
  tauri.check.mockResolvedValue(UPDATE);
  tauri.install.mockResolvedValue(undefined);
  tauri.onProgress.mockResolvedValue(() => undefined);
  facts = NONE;
});

afterEach(() => {
  stop?.();
  stop = null;
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  composer?.remove();
  composer = null;
  vi.useRealTimers();
});

function mountCard(): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(UpdateButton)));
}

/** 글을 쓰던 입력창(가짜가 아닌 실제 textarea). */
function typingInComposer(): HTMLTextAreaElement {
  composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  return composer;
}

/**
 * 키를 브라우저처럼 건넨다: 초점이 있는 요소로 가고, 초점이 단추에 있으면 Enter·Space가 그 단추를 누른다.
 * jsdom은 키보드로 단추를 누르지 않으므로 그 몫을 여기서 한다 — 빼면 「초점이 단추에 가도 아무 일 없음」이 되어 이 시험이 깨질 수 없다.
 */
function pressKey(key: "Enter" | " " | "Escape"): void {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  const proceed = target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  if (proceed && key !== "Escape" && target instanceof HTMLButtonElement) target.click();
}

const pillState = () => byId("update-pill")?.getAttribute("data-update-state") ?? null;

describe("업데이트 뒤 다시 시작의 문 (저장소)", () => {
  it("로컬 작업이 없으면 설치가 끝나자마자 3초 카운트다운 뒤에 다시 시작한다", async () => {
    await installWith(NONE);
    expect(byId("update-card-subline")?.textContent).toContain("3초 뒤");
    await advance(2_999);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    await advance(1);
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });

  it("칸이 일하는 동안은 기다리고 끊길 것을 한 줄로 말한다. 끝난 뒤 쉬는 상태가 2분 이어지면 그때 다시 시작한다", async () => {
    await installWith({ ...NONE, panes: [pane("working"), pane("waiting-permission")] });
    expect(byId("update-card-now")?.getAttribute("data-hold")).toBe("true");
    expect(byId("update-card-title")?.textContent).toBe("Restarts when your work ends");
    expect(byId("update-card-subline")?.textContent).toBe("Restarting now stops: 2 terminal panes");
    await advance(30 * 60 * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();

    facts = { ...NONE, panes: [pane("turn-done"), pane("ready")] };
    await advance(RESTART_GATE_TICK_MS);
    // 쉬는 시간 동안에는 끊길 것이 없으니 부제가 없다.
    expect(byId("update-card-subline")).toBeNull();
    await advance(RESTART_QUIET_MS - RESTART_GATE_TICK_MS);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    // 기다린 뒤의 카운트다운은 길다(H3): 「지금 말고」에 손이 닿을 만큼.
    await advance(RESTART_GATE_TICK_MS + RELAUNCH_AFTER_WAIT_SECONDS * 1000 - 1);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    await advance(1);
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });

  it("모르면(작업 데몬을 못 읽음) 끊지 않는다", async () => {
    await installWith({ ...NONE, workHost: null });
    await advance(60 * 60 * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(byId("update-card-subline")?.textContent).toBe("Restarting now stops: work that could not be checked");
  });

  it("카운트다운 중에 작업 세션이 시작되면 다시 기다린다", async () => {
    await installWith(NONE);
    await advance(1_000);
    facts = { ...NONE, workHost: { running: true }, hostSessions: [{ status: "running" }] };
    await advance(10_000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(byId("update-card-subline")?.textContent).toBe("Restarting now stops: 1 work session");
  });

  it("「지금 다시 시작」은 기다리지 않고, 쓰던 글을 먼저 내린 뒤 한 번만 다시 시작한다", async () => {
    const order: string[] = [];
    const onFlush = () => order.push("flush");
    window.addEventListener(BEFORE_RELAUNCH_EVENT, onFlush);
    tauri.relaunch.mockImplementation(async () => {
      order.push("relaunch");
    });
    await installWith({ ...NONE, panes: [pane(null)] });
    await act(async () => {
      byId("update-card-now")?.click();
      await Promise.resolve();
    });
    await advance(RESTART_QUIET_MS * 3);
    window.removeEventListener(BEFORE_RELAUNCH_EVENT, onFlush);
    expect(order).toEqual(["flush", "relaunch"]);
  });

  it("다시 시작을 기다리는 동안(설치를 마친 뒤)에는 피드를 묻지 않는다", async () => {
    await installWith({ ...NONE, panes: [pane("working")] });
    tauri.check.mockClear();
    let result: unknown = null;
    await act(async () => {
      result = await checkForUpdate();
    });
    expect(result).toBe("refused");
    expect(tauri.check).not.toHaveBeenCalled();
    expect(byId("update-card-title")?.textContent).toBe("Restarts when your work ends");
  });

  it("「지금 다시 시작」 뒤에는 그때 판정 중이던 문이 끝나도 다시 시작을 한 번 더 걸지 않는다", async () => {
    tauri.relaunch.mockResolvedValue(undefined); // 셸의 request_restart는 곧바로 돌아온다
    await installWith({ ...NONE, panes: [pane("working")] });
    // 다음 판정의 데몬 다시 읽기가 늦다: 그 사이에 사람이 누른다.
    let release: () => void = () => undefined;
    vi.mocked(source.refresh).mockImplementationOnce(() => new Promise<void>((done) => (release = done)));
    await advance(RESTART_GATE_TICK_MS);
    await act(async () => {
      byId("update-card-now")?.click();
      await Promise.resolve();
    });
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
    facts = NONE;
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await advance(RESTART_QUIET_MS + RESTART_GATE_TICK_MS * 2 + RELAUNCH_AFTER_WAIT_SECONDS * 1000 + 1_000);
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("업데이트 수리 1회차: 설치는 한 번, 저절로 연 카드는 초점을 가져가지 않음, 기다린 뒤의 예고 (#5661)", () => {
  it("H1 새 판을 알리는 중의 다시 묻기 답이 받는 중을 덮지 않고, 다시 눌러도 설치는 한 번만 돈다", async () => {
    stop = startUpdateWatch({ localWork: source });
    mountCard();
    await advance(0);
    expect(pillState()).toBe("available");

    let answer: (value: unknown) => void = () => undefined;
    tauri.check.mockImplementationOnce(() => new Promise((done) => (answer = done)));
    tauri.install.mockImplementation(() => new Promise(() => undefined));
    // 창으로 돌아와 다시 묻는 중(알약은 그대로 선다) → 「업데이트」를 누른다.
    await act(async () => {
      void checkForUpdate();
      await Promise.resolve();
    });
    expect(pillState()).toBe("available");
    await act(async () => {
      byId("update-pill")?.click();
      await Promise.resolve();
    });
    await advance(0);
    expect(pillState()).toBe("installing");

    // 받는 중에 다시 묻기의 답이 도착한다.
    await act(async () => {
      answer(UPDATE);
      await Promise.resolve();
    });
    await advance(0);
    expect(pillState()).toBe("installing");
    expect(byId("update-card-title")?.textContent).toBe("새 버전을 받는 중");

    await act(async () => {
      byId("update-pill")?.click();
      await Promise.resolve();
    });
    await advance(0);
    expect(tauri.install).toHaveBeenCalledTimes(1);
  });

  it("H1 받는 중에 무엇이 상태를 「새 버전」으로 돌려놓아도 설치는 동시에 둘이 돌지 않는다", async () => {
    tauri.install.mockImplementation(() => new Promise(() => undefined));
    act(() => seedUpdateStateForTest({ kind: "available", update: UPDATE }));
    await act(async () => {
      void installUpdate();
      await Promise.resolve();
    });
    act(() => seedUpdateStateForTest({ kind: "available", update: UPDATE }));
    await act(async () => {
      void installUpdate();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tauri.install).toHaveBeenCalledTimes(1);
  });

  it("H2 받기가 끝나 카드가 저절로 열려도 입력창의 초점은 그대로이고, 그때 친 Enter·Space는 다시 시작을 부르지 않는다", async () => {
    facts = { ...NONE, panes: [pane("working")] };
    stop = startUpdateWatch({ localWork: source });
    mountCard();
    await advance(0);
    let finish: (value: unknown) => void = () => undefined;
    tauri.install.mockImplementation(() => new Promise((done) => (finish = done)));
    // 알약을 눌러 받기 시작 → 카드를 닫고 입력창으로 돌아가 글을 쓴다.
    await act(async () => {
      byId("update-pill")?.click();
      await Promise.resolve();
    });
    await advance(0);
    act(() => pressKey("Escape"));
    await advance(300);
    expect(byId("update-card")).toBeNull();
    const field = typingInComposer();

    await act(async () => {
      finish(undefined);
      await Promise.resolve();
    });
    await advance(50);
    // 카드는 열렸다(왜 다시 시작하지 않는지가 거기 있다). 초점은 입력창에 남는다.
    expect(byId("update-card-title")?.textContent).toBe("Restarts when your work ends");
    expect(document.activeElement).toBe(field);
    act(() => pressKey("Enter"));
    act(() => pressKey(" "));
    await advance(50);
    expect(tauri.relaunch).not.toHaveBeenCalled();

    // Esc로 닫아도 초점을 알약으로 끌어가지 않는다.
    act(() => pressKey("Escape"));
    await advance(50);
    expect(byId("update-card")).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("알약을 눌러 연 카드는 여전히 초점이 카드 안으로 간다", async () => {
    await installWith({ ...NONE, panes: [pane("working")] });
    act(() => pressKey("Escape"));
    await advance(50);
    await act(async () => {
      byId("update-pill")?.click();
      await Promise.resolve();
    });
    await advance(50);
    expect(byId("update-card")?.contains(document.activeElement)).toBe(true);
  });

  it("H3 기다린 뒤 카운트다운이 시작되면 닫아 둔 카드가 초점을 가져가지 않고 다시 열리고, 「지금 말고」로 미룰 수 있다", async () => {
    const field = typingInComposer();
    await installWith({ ...NONE, panes: [pane("working")] });
    expect(byId("update-card-title")?.textContent).toBe("Restarts when your work ends");
    expect(document.activeElement).toBe(field);
    // 기다리는 카드를 닫고 계속 일한다.
    act(() => pressKey("Escape"));
    await advance(50);
    expect(byId("update-card")).toBeNull();
    expect(document.activeElement).toBe(field);

    facts = { ...NONE, panes: [pane("turn-done")] };
    await advance(RESTART_GATE_TICK_MS + RESTART_QUIET_MS);
    // 예고: 카드가 다시 열리고 남은 시간을 말한다. 초점은 입력창 그대로다.
    expect(byId("update-card-title")?.textContent).toBe("곧 다시 실행돼요");
    expect(byId("update-card-subline")?.textContent).toContain(`${RELAUNCH_AFTER_WAIT_SECONDS}초 뒤`);
    expect(document.activeElement).toBe(field);
    expect(byId("update-card-defer")?.textContent).toBe("Not now");

    await advance((RELAUNCH_AFTER_WAIT_SECONDS - 1) * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    await act(async () => {
      byId("update-card-defer")?.click();
      await Promise.resolve();
    });
    await advance(60 * 60 * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(byId("update-card-title")?.textContent).toBe("다시 실행해 주세요");
    expect(byId("update-card-now")).not.toBeNull();
    expect(byId("update-card-defer")).toBeNull();
  });

  it("H3 설치 직후 곧바로 도는 3초 카운트다운(사람이 방금 누른 것)에는 「지금 말고」가 없다", async () => {
    await installWith(NONE);
    expect(byId("update-card-subline")?.textContent).toContain("3초 뒤");
    expect(byId("update-card-defer")).toBeNull();
  });
});

/** 바깥을 누른다: 브라우저처럼 누른 곳에 `pointerdown`이 가고, 누른 곳이 초점을 받을 수 있으면 초점이 그리로 간다. */
function pressOutside(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  if (target.tabIndex >= 0 || target instanceof HTMLTextAreaElement) target.focus();
  else (document.activeElement as HTMLElement | null)?.blur();
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("업데이트 수리 2회차: 바깥을 눌러 닫은 카드의 초점, 예고를 닫으면 멈춤, 다시 마운트 (#5661)", () => {
  it("H1 길①: 알약으로 연 기다림 카드를 입력창을 눌러 닫으면 초점은 입력창이고, 이어 친 Enter 두 번이 다시 시작을 부르지 않는다", async () => {
    await installWith({ ...NONE, panes: [pane("working")] });
    act(() => pressKey("Escape"));
    await advance(50);
    const field = typingInComposer();
    await act(async () => {
      byId("update-pill")?.click();
      await Promise.resolve();
    });
    await advance(50);
    expect(byId("update-card")?.contains(document.activeElement)).toBe(true);

    act(() => pressOutside(field));
    await advance(400);
    expect(byId("update-card")).toBeNull();
    expect(document.activeElement).toBe(field);
    act(() => pressKey("Enter"));
    await advance(50);
    act(() => pressKey("Enter"));
    await advance(50);
    act(() => pressKey(" "));
    await advance(50);
    act(() => pressKey(" "));
    await advance(50);
    expect(tauri.relaunch).not.toHaveBeenCalled();
  });

  it("H1 길②: 저절로 열린 카드를 대화의 글(초점을 받지 않는 곳)을 눌러 닫아도 초점은 알약으로 가지 않고, Space 두 번이 다시 시작을 부르지 않는다", async () => {
    const field = typingInComposer();
    const message = document.createElement("p");
    message.textContent = "지난 대화";
    document.body.append(message);
    await installWith({ ...NONE, panes: [pane("working")] });
    expect(byId("update-card-title")?.textContent).toBe("Restarts when your work ends");
    expect(document.activeElement).toBe(field);

    act(() => pressOutside(message));
    await advance(400);
    expect(byId("update-card")).toBeNull();
    expect(document.activeElement).not.toBe(byId("update-pill"));
    act(() => pressKey(" "));
    await advance(50);
    act(() => pressKey(" "));
    await advance(50);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    message.remove();
  });

  it("Esc로 닫으면 연 곳(알약)으로 초점이 돌아간다 — 알약으로 연 카드, 그리고 저절로 열린 카드 안으로 초점을 옮긴 뒤", async () => {
    await installWith({ ...NONE, panes: [pane("working")] });
    act(() => pressKey("Escape"));
    await advance(50);
    await act(async () => {
      byId("update-pill")?.click();
      await Promise.resolve();
    });
    await advance(50);
    act(() => pressKey("Escape"));
    await advance(50);
    expect(document.activeElement).toBe(byId("update-pill"));
  });

  it("기다린 뒤의 예고를 Esc로 닫으면 「지금 말고」와 같다: 다시 시작하지 않고, 알약은 「곧」이라고 하지 않는다", async () => {
    const field = typingInComposer();
    await installWith({ ...NONE, panes: [pane("working")] });
    act(() => pressKey("Escape"));
    await advance(50);
    facts = { ...NONE, panes: [pane("turn-done")] };
    await advance(RESTART_GATE_TICK_MS + RESTART_QUIET_MS);
    expect(byId("update-card-title")?.textContent).toBe("곧 다시 실행돼요");
    expect(document.activeElement).toBe(field);

    act(() => pressKey("Escape"));
    await advance(60 * 60 * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(byId("update-card")).toBeNull();
    expect(byId("update-pill")?.getAttribute("aria-label")).toBe("업데이트. Installed. Restart to open the new version.");
  });

  it("기다린 뒤의 예고를 바깥을 눌러 닫아도 「지금 말고」와 같다", async () => {
    const field = typingInComposer();
    await installWith({ ...NONE, panes: [pane("working")] });
    act(() => pressKey("Escape"));
    await advance(50);
    facts = { ...NONE, panes: [pane("turn-done")] };
    await advance(RESTART_GATE_TICK_MS + RESTART_QUIET_MS);
    expect(byId("update-card-defer")).not.toBeNull();
    await advance(50); // 바깥 누름을 듣기 시작하는 것은 카드가 열린 다음 틱부터다(Radix)
    act(() => pressOutside(field));
    await advance(60 * 60 * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it("사람이 닫은 카드는 알약이 다시 마운트돼도(목록 열 접기·펴기, 설정 화면) 저절로 열리지 않는다. 다음 예고 때는 열린다", async () => {
    await installWith({ ...NONE, panes: [pane("working")] });
    act(() => pressKey("Escape"));
    await advance(50);
    act(() => root?.unmount());
    host?.remove();
    mountCard();
    await advance(50);
    expect(byId("update-card")).toBeNull();
    expect(byId("update-pill")).not.toBeNull();

    facts = { ...NONE, panes: [pane("turn-done")] };
    await advance(RESTART_GATE_TICK_MS + RESTART_QUIET_MS);
    expect(byId("update-card-title")?.textContent).toBe("곧 다시 실행돼요");
  });

  it("설치가 한 번 실패한 뒤 다시 확인하면 다시 받을 수 있다(설치 잠금이 풀린다)", async () => {
    tauri.install.mockRejectedValueOnce(new Error("signature mismatch"));
    act(() => seedUpdateStateForTest({ kind: "available", update: UPDATE }));
    await act(async () => {
      await installUpdate();
    });
    await act(async () => {
      await checkForUpdate();
    });
    tauri.install.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      void installUpdate();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tauri.install).toHaveBeenCalledTimes(2);
  });
});
