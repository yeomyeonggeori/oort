import { isDesktop, showNotification } from "@/lib/tauri";
import { showBrowserNotification, type BrowserNotifyTarget } from "./browserNotify";

// =============================================================================
// OS 알림의 마지막 관문: 같은 종류를 한 묶음으로 쌓는다 (#3339).
//
// 승인 세 건이 몇 초 안에 오면 배너 셋이 아니라 「승인 필요 3건」 하나다. macOS
// 알림 센터에는 앱이 스레드를 묶는 길이 없으므로(Tauri 알림 플러그인의 데스크탑
// 쪽은 그룹을 못 싣는다) 보내기 전에 여기서 묶는다. 창은 짧다: 길게 잡으면 한 건짜리
// 승인이 늦게 뜬다.
//
// 앱 안 토스트가 아니다. OS 알림이다(ADR-0182의 대상 밖, taste §8).
// =============================================================================

export type OsNotifyKind = "approval" | "mention" | "dm" | "waiting" | "done" | "thread-reply";

export interface OsNotifyItem {
  kind: OsNotifyKind;
  title: string;
  body?: string;
  /** 묶음 요약에 이름으로 올라가는 한 줄(보낸 사람, 칸 이름). */
  label: string;
  /** 브라우저 알림을 눌렀을 때 갈 곳(채널 경로). 데스크탑은 포커스 때 따로 간다. */
  route?: string;
  /**
   * 묶였을 때의 제목을 호출부가 정한다(#4890). 새 문구는 사전으로만 들어오므로 이 모듈의 고정 표(`SUMMARY_TITLE`)에
   * 한글을 더하지 않는다. 건수는 묶인 뒤에야 알아서 함수다. 없으면 표의 것이다.
   */
  summaryTitle?: (count: number) => string;
  /**
   * 이 알림이 어느 스레드의 답글인가(스레드 루트 id, #5017). 같은 스레드의 답글만 묶인 배너는 누르면 그 스레드로 간다:
   * 답글마다 `route` 의 카드가 달라 「한 곳을 가리킴」으로 읽히지 않던 것을 이 값이 잇는다.
   */
  rootId?: string;
}

/**
 * 여러 건이 한 곳을 가리키면 그곳, 흩어지면 멘션 인박스(데스크탑 `openTarget`과 같은 말). 같은 스레드의 답글만 묶였으면
 * 카드는 달라도 그 스레드다 — 가장 늦은 답글의 주소로 간다(#5017).
 */
export const MIXED_ROUTE = "/inbox?filter=mentions";

export function routeFor(items: readonly OsNotifyItem[]): string | undefined {
  const routes = items.map((i) => i.route);
  if (routes.some((r) => r === undefined)) return undefined;
  if (routes.every((r) => r === routes[0])) return routes[0];
  const root = items[0]?.rootId?.toLowerCase();
  if (root !== undefined && items.every((i) => i.rootId?.toLowerCase() === root)) return routes[routes.length - 1];
  return MIXED_ROUTE;
}

/** 묶였을 때의 제목. 「무엇이 일어났나」가 먼저, 건수가 뒤다. */
const SUMMARY_TITLE: Record<Exclude<OsNotifyKind, "thread-reply">, string> = {
  approval: "승인 필요",
  mention: "멘션",
  dm: "새 메시지",
  waiting: "응답 필요",
  done: "작업 끝남",
};

/** 요약 본문에 이름을 몇 개까지 싣는가. 나머지는 「외 n건」. */
export const SUMMARY_NAMES = 3;

/** 같은 종류를 한 묶음으로 보는 시간. */
export const COALESCE_MS = 1200;

/** 묶음 제목: 호출부가 준 것이 먼저, 없으면 표. 표에 없는 종류는 보낸 사람 이름으로 말한다(호출부가 늘 제목을 준다). */
function summaryTitleFor(first: OsNotifyItem, count: number): string {
  if (first.summaryTitle !== undefined) return first.summaryTitle(count);
  const base = first.kind === "thread-reply" ? first.title : SUMMARY_TITLE[first.kind];
  return `${base} ${count}건`;
}

/** 순수: 한 종류의 알림 여럿을 배너 하나로. 하나면 그대로다. */
export function summarize(items: readonly OsNotifyItem[]): { title: string; body?: string } {
  const first = items[0]!;
  if (items.length === 1) {
    return first.body === undefined ? { title: first.title } : { title: first.title, body: first.body };
  }
  const names = items.slice(0, SUMMARY_NAMES).map((i) => i.label);
  const rest = items.length - names.length;
  return {
    title: summaryTitleFor(first, items.length),
    body: rest > 0 ? `${names.join(", ")} 외 ${rest}건` : names.join(", "),
  };
}

export interface OsNotifierDeps {
  send: (title: string, body: string | undefined, target: BrowserNotifyTarget) => Promise<boolean>;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createOsNotifier(deps: OsNotifierDeps) {
  const windowMs = deps.windowMs ?? COALESCE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Map<OsNotifyKind, { items: OsNotifyItem[]; timer: unknown }>();

  function flushKind(kind: OsNotifyKind): void {
    const slot = pending.get(kind);
    if (!slot) return;
    pending.delete(kind);
    clearTimer(slot.timer);
    const { title, body } = summarize(slot.items);
    const route = routeFor(slot.items);
    void deps.send(title, body, { kind, ...(route === undefined ? {} : { route }) }).catch(() => false);
  }

  return {
    /** 종류별로 모은다. 그 종류의 첫 건이 창을 연다. */
    offer(item: OsNotifyItem): void {
      const slot = pending.get(item.kind);
      if (slot) {
        slot.items.push(item);
        return;
      }
      pending.set(item.kind, {
        items: [item],
        timer: setTimer(() => flushKind(item.kind), windowMs),
      });
    },
    /** 기다리는 묶음을 지금 보낸다(시험·창을 닫을 때). */
    flush(): void {
      for (const kind of [...pending.keys()]) flushKind(kind);
    },
  };
}

export type OsNotifier = ReturnType<typeof createOsNotifier>;

let shared: OsNotifier | null = null;

/** 앱에 하나다: 메시지 레일과 로컬 칸이 같은 묶음을 쓴다. */
export function osNotifier(): OsNotifier {
  shared ??= createOsNotifier({
    // 데스크탑은 셸로, 브라우저는 옵트인한 탭의 Notification API로(#3340). 같은 묶음 규칙이다.
    send: (title, body, target) =>
      isDesktop() ? showNotification(title, body) : showBrowserNotification(title, body, target),
  });
  return shared;
}
