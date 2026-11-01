import { ApiError } from "../../lib/api";
import type { MessageService } from "../../i18n/types";

// =============================================================================
// 스레드 머리의 「따라가기 / 그만 따라가기」 (#4890, ADR-0206 증보 1 F8·F3) — 웹·데스크탑·폰이 같은 규칙을 한 곳에서
// 받는다. 화면은 이 파일이 낸 값을 **그리기만** 한다.
//
//   * **낙관적 갱신.** 누르면 화면이 먼저 바뀌고 요청이 나간다. 성공하면 서버가 말한 효과값(`following`)으로 확정하고,
//     실패하면 **누르기 전 값으로 되돌리고** `failed` 를 세운다(화면이 짧은 안내를 말한다).
//   * **요청이 나가 있는 동안 다시 눌러도 두 번째 요청은 없다.** 그래서 응답이 서로 앞지를 일이 없다.
//   * **404·405 와 400 `thread_follow_not_applicable` 은 「여기서는 쓸 수 없다」다**(옛 서버 / DM 스레드, api.ts 의 계약). 그 뒤로는
//     요청을 더 보내지 않고 `unavailable` 을 세운다 — 화면은 칸을 **숨긴다**(눌러도 안 되는 단추를 두지 않는다). 그 밖의 오류
//     (네트워크·5xx·403·429)는 `failed` 다.
//   * **서버가 알려 준 값은 사람이 누르기 전까지만 받는다**(`sync`). 한 번 눌린 뒤에는 이 컨트롤러가 값을 쥔다: 누르기 직전에
//     출발한 옛 읽기가 늦게 도착해 방금 확정한 값을 뒤집는 일을 막는다. 다른 기기에서 바꾼 값은 스레드를 다시 열 때 맞춘다
//     (개인 설정은 방송하지 않는다 — ADR-0206 증보 1 F8, ADR-0177 방식).
// =============================================================================

export interface ThreadFollowView {
  /** 화면이 지금 보여 주는 값(낙관값 포함). */
  following: boolean;
  /** 요청이 나가 있다. */
  pending: boolean;
  /** 마지막 시도가 실패해 되돌렸다. 다음 누르기·`dismissError` 가 지운다. */
  failed: boolean;
  /** 이 서버·이 스레드에서는 따라가기를 쓸 수 없다. 화면은 칸을 숨긴다. */
  unavailable: boolean;
}

export interface ThreadFollowController {
  /** 같은 상태에서는 같은 객체를 돌려준다(`useSyncExternalStore` 의 요구). */
  getSnapshot(): ThreadFollowView;
  subscribe(listener: () => void): () => void;
  /**
   * 서버가 알려 준 값(스레드 열기 응답의 `following`). 한 번 눌린 뒤·요청이 나가 있는 동안·쓸 수 없을 때는 받지 않는다.
   * 받았으면 `true` — 호출부가 그 값을 장부에 적을지(서버가 말한 값만 적는다) 이 반환으로 정한다.
   */
  sync(following: boolean): boolean;
  /** 한 번 누르기. 요청 중이거나 쓸 수 없으면 아무 일도 없다. */
  toggle(): Promise<void>;
  dismissError(): void;
}

/**
 * 이 채널의 스레드를 따라갈 수 있는가. DM 채널은 모든 메시지가 이미 알림이라 따라가기가 뜻이 없고 서버도 400
 * (`thread_follow_not_applicable`)이다. 채널 종류를 아직 모르면(명부를 받는 중) 둘 수 있다 — 틀리면 첫 누름의 400 이 칸을 숨긴다.
 */
export function threadsAreFollowable(channelKind: string | undefined | null): boolean {
  return channelKind !== "dm";
}

/** 칸을 숨겨야 하는 거절인가: 옛 서버(404·405)이거나 DM 스레드(400 `thread_follow_not_applicable`). */
export function followIsUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return error.status === 400 && error.code === "thread_follow_not_applicable";
}

export function createThreadFollowController(options: {
  initial: boolean;
  /** `true` 면 `PUT …/follow`, `false` 면 `DELETE …/follow`. 응답은 쓴 뒤의 효과값이다. */
  send: (follow: boolean) => Promise<{ following: boolean }>;
  /** 서버 응답으로 확정된 값. 호출부가 장부·질의 캐시를 맞춘다. 던져도 컨트롤러는 영향이 없다. */
  onSettled?: (following: boolean) => void;
}): ThreadFollowController {
  let view: ThreadFollowView = {
    following: options.initial,
    pending: false,
    failed: false,
    unavailable: false,
  };
  let touched = false;
  const listeners = new Set<() => void>();

  function set(next: Partial<ThreadFollowView>): void {
    const merged = { ...view, ...next };
    if (
      merged.following === view.following &&
      merged.pending === view.pending &&
      merged.failed === view.failed &&
      merged.unavailable === view.unavailable
    ) {
      return;
    }
    view = merged;
    for (const listener of [...listeners]) listener();
  }

  return {
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sync(following) {
      if (touched || view.pending || view.unavailable) return false;
      set({ following });
      return true;
    },
    async toggle() {
      if (view.pending || view.unavailable) return;
      touched = true;
      const before = view.following;
      set({ following: !before, pending: true, failed: false });
      try {
        const result = await options.send(!before);
        set({ following: result.following, pending: false });
        try {
          options.onSettled?.(result.following);
        } catch {
          /* 장부·캐시 반영의 실패는 따라가기의 실패가 아니다. */
        }
      } catch (error) {
        if (followIsUnavailable(error)) {
          set({ following: before, pending: false, unavailable: true });
        } else {
          set({ following: before, pending: false, failed: true });
        }
      }
    },
    dismissError() {
      set({ failed: false });
    },
  };
}

// ---- 문구 --------------------------------------------------------------------------------

export interface ThreadFollowCopy {
  /** 단추의 접근성 라벨 — **지금 상태를 말로** 하고 누르면 무엇이 되는지 잇는다. */
  label: string;
  /** 눈으로 보는 툴팁 — 누르면 하는 일(동작). */
  action: string;
  /** 되돌린 뒤의 짧은 안내. */
  failed: string;
  /** 안내를 닫는 단추의 글. */
  dismiss: string;
}

export function threadFollowCopy(
  following: boolean,
  formatMessage: MessageService["formatMessage"]
): ThreadFollowCopy {
  return {
    label: formatMessage(following ? "timeline.thread.followOn" : "timeline.thread.followOff"),
    action: formatMessage(following ? "timeline.thread.followStop" : "timeline.thread.followStart"),
    failed: formatMessage("timeline.thread.followFailed"),
    dismiss: formatMessage("timeline.thread.followDismiss"),
  };
}
