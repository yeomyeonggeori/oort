import { isDesktop, showNotification } from "@/lib/tauri";

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

export type OsNotifyKind = "approval" | "mention" | "dm" | "waiting" | "done";

export interface OsNotifyItem {
  kind: OsNotifyKind;
  title: string;
  body?: string;
  /** 묶음 요약에 이름으로 올라가는 한 줄(보낸 사람, 칸 이름). */
  label: string;
}

/** 묶였을 때의 제목. 「무엇이 일어났나」가 먼저, 건수가 뒤다. */
const SUMMARY_TITLE: Record<OsNotifyKind, string> = {
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

/** 순수: 한 종류의 알림 여럿을 배너 하나로. 하나면 그대로다. */
export function summarize(items: readonly OsNotifyItem[]): { title: string; body?: string } {
  const first = items[0]!;
  if (items.length === 1) {
    return first.body === undefined ? { title: first.title } : { title: first.title, body: first.body };
  }
  const names = items.slice(0, SUMMARY_NAMES).map((i) => i.label);
  const rest = items.length - names.length;
  return {
    title: `${SUMMARY_TITLE[first.kind]} ${items.length}건`,
    body: rest > 0 ? `${names.join(", ")} 외 ${rest}건` : names.join(", "),
  };
}

export interface OsNotifierDeps {
  send: (title: string, body?: string) => Promise<boolean>;
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
    void deps.send(title, body).catch(() => false);
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
    send: (title, body) => (isDesktop() ? showNotification(title, body) : Promise.resolve(false)),
  });
  return shared;
}
