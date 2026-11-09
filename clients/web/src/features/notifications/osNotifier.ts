import { isDesktop } from "@/lib/tauri";
import { showBrowserNotification, type BrowserNotifyTarget } from "./browserNotify";
import { showDesktopBanner, type BannerArm } from "./bannerClicks";

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

/**
 * 묶음의 단위. `failed`는 로컬 칸의 실패한 턴이다(design-review #5584 r2 H1): 「끝남」과 같은 창에 와도
 * 따로 묶여 「작업 끝남 N건」에 섞이지 않는다.
 */
export type OsNotifyKind = "approval" | "mention" | "dm" | "waiting" | "done" | "failed" | "thread-reply";

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
  /**
   * 옛 어림(창이 앞에 온 순간 이동)이 쓰는 재료(#5059). 데스크탑 셸이 이 배너의 클릭을 알려 주지 못한다고 답했을 때만
   * 쓰인다 — 클릭이 오는 배너에는 필요 없다. 메시지에서 온 알림만 갖는다.
   */
  arm?: BannerArm;
}

/**
 * 묶인 배너가 보내질 때 함께 가는 정보. 브라우저 배너는 `kind`·`route` 만 읽는다. `arms` 는 묶음에 든 알림들의 어림 재료이고,
 * 하나라도 있을 때만 붙는다.
 */
export interface OsNotifyTarget extends BrowserNotifyTarget {
  arms?: readonly BannerArm[];
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

/** 표에 제목이 없는 종류: 묶음 제목은 그 알림의 제목(스레드 답글은 보낸 사람, 실패한 턴은 「실패」) + 건수다. */
type TitledByItem = "thread-reply" | "failed";

/** 묶였을 때의 제목. 「무엇이 일어났나」가 먼저, 건수가 뒤다. */
const SUMMARY_TITLE: Record<Exclude<OsNotifyKind, TitledByItem>, string> = {
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

/**
 * 묶음 제목: 호출부가 준 것이 먼저, 없으면 표. 표에 없는 종류는 그 알림의 제목으로 말한다(스레드 답글은 호출부가
 * 늘 제목을 준다. 실패한 턴은 알림 제목이 곧 「실패」라서 「실패 N건」이다).
 */
function summaryTitleFor(first: OsNotifyItem, count: number): string {
  if (first.summaryTitle !== undefined) return first.summaryTitle(count);
  const table: Partial<Record<OsNotifyKind, string>> = SUMMARY_TITLE;
  return `${table[first.kind] ?? first.title} ${count}건`;
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
  send: (title: string, body: string | undefined, target: OsNotifyTarget) => Promise<boolean>;
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
    const arms = slot.items.flatMap((item) => (item.arm === undefined ? [] : [item.arm]));
    void deps
      .send(title, body, {
        kind,
        ...(route === undefined ? {} : { route }),
        ...(arms.length === 0 ? {} : { arms }),
      })
      .catch(() => false);
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
    // 데스크탑은 셸로, 브라우저는 옵트인한 탭의 Notification API로(#3340). 같은 묶음 규칙이다. 셸이 클릭을 알려 주면
    // 배너의 클릭이 곧 이동이다(#5059, `bannerClicks.ts`).
    send: (title, body, target) =>
      isDesktop() ? showDesktopBanner(title, body, target) : showBrowserNotification(title, body, target),
  });
  return shared;
}
