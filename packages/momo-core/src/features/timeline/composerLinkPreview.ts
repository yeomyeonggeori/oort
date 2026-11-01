import { ApiError } from "../../lib/api";
import { containsSecretKey } from "../chat/secretKey";
import { drawablePreviews, type UnfurlPreview, type UnfurlPreviewCard } from "./unfurl";
import {
  UNFURL_PREVIEW_DEBOUNCE_MS,
  UNFURL_PREVIEW_RETRY_CEILING_SECONDS,
  draftPreviewLinks,
  failedPreviewFor,
  unfurlPreviewMemoryMs,
} from "./unfurlDraft";

// =============================================================================
// 보내기 전 입력칸의 링크 미리보기 컨트롤러 (#5037, #5005·#5016의 상태기계를 코어로 올렸다. ADR-0170 증보
// 2026-11-01 D14~D22). 웹·데스크탑(채널·스레드 입력칸)과 폰 입력창이 **같은 한 벌**을 쓴다 — 화면 쪽 훅은 이 컨트롤러를
// 입력칸의 지금 상태로 불러 주기만 한다. 무엇을 카드로 만들지(`draftPreviewLinks`)·얼마나 기다리고 기억할지(코어
// 상수)·어떤 답이 카드를 그리는지(`drawablePreviews`)는 원래 코어였고, 이 파일이 「언제 묻나」의 차례까지 가져왔다.
//
// 글에서 서버가 카드로 만들 주소(앞의 서로 다른 3개)를 고르고, 입력을 멈춘 뒤에 **한 개씩 차례로** 묻는다.
// **화면에 보이는 카드는 늘 「지금 글의 링크」와 「받아 둔 답」에서 그때그때 뽑는다.** 그래서 늦게 온 답이 이미 지워진
// 링크의 카드를 그릴 수 없다. 그래도 링크가 바뀌면 진행 중 요청은 끊는다(서버 예산을 쓰지 않으려고) — 끊은 요청의 답이
// 오면 기록하지도, 다음 링크를 묻지도 않는다(`aborted` 줄이 그 가드다).
//
//   멈춘 뒤에만      글이 바뀔 때마다 기다림이 처음부터다(350ms). 링크가 그대로면 진행 중 요청은 두고, 그 요청이 끝난
//                   뒤에는 새로 묻지 않는다.
//   같은 주소         한 번 받아 둔 답(`ok` 25분, `failed` 2분)이 있으면 다시 묻지 않는다. 이 컨트롤러가 서 있는
//                   동안의 기억이고(워크스페이스별), 서버의 30분·2분보다 조금 짧다(죽은 그림 열쇠를 부르지 않으려고).
//   조용히           실패·거절·꺼진 스위치는 모두 카드가 없는 것이다. 입력을 막지 않고 문구도 없다.
//   키 모양이 든 글   어떤 링크도 서버로 보내지 않는다. 입력칸은 그 글을 보내지도 초안으로 저장하지도 않는데, 키가 링크의
//                   쿼리에 있으면 서버가 그 주소로 나가 바깥 사이트에 키를 건네는 셈이다.
//   방을 모를 때      보낼 방(`workspaceId`·`channelId`)을 모르면 물을 곳이 없다 — 아무것도 묻지 않는다(폰의 첨부
//                   대상 없는 하네스).
//   429             `Retry-After` 뒤에 **한 번** 다시 묻는다. 그동안 그 주소는 묻지 않고 카드 자리를 비운다. 초를
//                   말하지 않은 429는 기다림을 지어내지 않고 그냥 넘긴다(다음 글 변경이 다시 묻는다).
//   ✕               지금 링크 구성에서만 「이번 메시지는 미리보기 없이 보내기」다. 링크를 지우거나 바꾸면(방·스레드를
//                   옮겨도) 다시 뜬다. 보내고 나면 글이 비어 구성이 달라지므로 저절로 풀린다.
//
// ---- 호스트가 쓰는 법 -------------------------------------------------------------------
//
// 화면 쪽은 렌더와 효과를 이렇게 나눠 부른다(TanStack Query의 `getOptimisticResult` / `setOptions`와 같은 나눔이다).
//
//   `view(input)`   **렌더 중에 불러도 되는 읽기.** 지금 글의 링크 × 받아 둔 답에서 그릴 카드를 뽑는다. 상태를
//                   바꾸지도 요청을 내지도 않는다. 렌더마다 지금 글에서 뽑으므로 글을 지운 바로 그 렌더에 카드가 사라진다
//                   (효과로 늦게 갱신하면 한 프레임 동안 지운 링크의 카드가 남는다).
//   `sync(input)`   **효과에서 부른다.** 기다림·요청·재시도를 이 입력으로 맞춘다. 같은 입력으로 여러 번 불러도 같다.
//   `dispose()`     입력칸이 사라질 때(효과 정리). 진행 중 요청과 예약을 끊는다. 이후 `sync`가 다시 이어 간다(개발
//                   모드의 마운트→정리→마운트).
//   `subscribe`·`getSnapshot`  받아 둔 답이나 ✕가 바뀌면 호스트가 다시 그리게 한다(`useSyncExternalStore`). 판은 바뀐
//                   횟수 하나라 바뀐 것이 없으면 늘 같은 값이다 — 그릴 것은 `view`가 지금 입력에서 뽑는다.
//
// `sync`가 지키는 **두 가지 다른 열쇠**(둘을 하나로 합치면 시험이 붉어진다):
//   기다림은 글(`text`·`enabled`)·묻지 않는 때·방이 바뀔 때마다 처음부터다.
//   진행 중 요청과 재시도 예약을 끊는 것은 링크 구성·묻지 않는 때·방이 바뀔 때뿐이다 — 링크가 그대로인 글 고침은 요청을
//   끊지 않는다. `threadRootId`는 어느 쪽에도 들지 않고 ✕의 범위에만 든다.
// =============================================================================

/** 이 컨트롤러가 기억하는 주소의 상한. 넘으면 가장 오래된 것부터 잊는다. */
const MEMORY_LIMIT = 48;

/** 입력칸의 지금 상태. 호스트가 렌더마다 만들어 `view`와 `sync`에 같은 값을 준다. */
export interface ComposerLinkPreviewInput {
  /** 보낼 방. 둘 중 하나라도 모르면(폰의 첨부 대상 없는 하네스) 아무것도 묻지 않는다. */
  workspaceId: string | undefined;
  channelId: string | undefined;
  /**
   * 스레드 입력칸이면 그 스레드의 뿌리 메시지. ✕가 같은 방의 **다른 스레드**로 따라가지 않게 ✕의 범위에만 적는다 —
   * 받아 둔 답은 주소만의 것이라 스레드와 상관없이 나눠 쓴다.
   */
  threadRootId?: string | undefined;
  /** 입력칸의 지금 글(초안). */
  text: string;
  /** 오프라인처럼 지금은 묻지 않는 때. 풀리면 이어서 묻는다. 이미 받은 카드와 ✕는 그대로 둔다. */
  paused: boolean;
  /**
   * 이 기기가 카드를 그린다(`unfurlDrawsCards`, 「끄기」가 아니다). 그릴 수 없는 카드를 위해 초안의 링크를 서버로
   * 보내지도, 보이지 않는 카드를 ✕로 끄지도 않는다.
   */
  enabled: boolean;
}

export interface ComposerLinkPreviewState {
  /** 입력칸 위에 그릴 카드, 글에 나온 순서. 없거나 ✕로 껐으면 비어 있다. */
  cards: UnfurlPreviewCard[];
  /** 이 링크 구성에서 ✕를 눌렀다. 보낼 때 `suppressUnfurl`을 싣는다. */
  suppressed: boolean;
  /** ✕(웹은 Esc도). 그릴 카드가 없으면 아무 일도 하지 않는다. */
  dismiss: () => void;
}

export interface ComposerLinkPreviewController {
  subscribe(listener: () => void): () => void;
  /** 받아 둔 답이나 ✕가 바뀔 때만 바뀌는 숫자. 그릴 것은 `view`가 뽑는다. */
  getSnapshot(): number;
  /** 렌더 중에 불러도 되는 읽기(위 머리말). */
  view(input: ComposerLinkPreviewInput): ComposerLinkPreviewState;
  /** 효과에서 부른다(위 머리말). */
  sync(input: ComposerLinkPreviewInput): void;
  /** 입력칸이 사라질 때. 진행 중 요청과 예약을 끊는다. */
  dispose(): void;
}

export interface ComposerLinkPreviewOptions {
  /**
   * 서버에 주소 하나의 카드를 묻는다. 호스트가 `fetchUnfurlPreview`를 넘긴다 — 늦게 읽는 함수로 감싸 넘기면
   * 시험이 그 모듈 함수를 바꿔 끼워도 닿는다. 신호가 끊기면(`signal.aborted`) 던져도 되고 던지지 않아도 된다.
   */
  fetchPreview: (
    workspaceId: string,
    channelId: string,
    url: string,
    signal: AbortSignal
  ) => Promise<UnfurlPreview>;
  /** 시각(밀리초). 기본은 `Date.now()`를 **부를 때** 읽는다 — 시계를 가짜로 바꾼 시험이 닿는다. */
  now?: () => number;
}

interface Remembered {
  preview: UnfurlPreview;
  /** 이 시각까지 다시 묻지 않는다(밀리초). */
  until: number;
}

/** 한 입력에서 뽑은 값들. 글이 같으면 링크·키 판정도 같아서 한 칸만 기억한다(렌더마다 다시 훑지 않으려고). */
interface Derived {
  ws: string;
  ch: string;
  links: string[];
  linksKey: string;
  /** 지금은 묻지 않는 때: 오프라인이거나, 글에 키 모양이 있거나, 보낼 방을 모른다. */
  quiet: boolean;
  /** ✕의 범위: 방(스레드 입력칸이면 스레드도)과 링크 구성. */
  scope: string;
}

/** 마지막 `sync`가 본 입력. 무엇이 바뀌었는지 가르는 기준이다. */
interface Synced extends Derived {
  text: string;
  enabled: boolean;
}

export function createComposerLinkPreviewController(
  options: ComposerLinkPreviewOptions
): ComposerLinkPreviewController {
  const now = () => (options.now !== undefined ? options.now() : Date.now());

  const memory = new Map<string, Remembered>();
  const busyUntil = new Map<string, number>();
  const listeners = new Set<() => void>();
  let revision = 0;

  let run: { controller: AbortController } | null = null;
  let retry: { timer: ReturnType<typeof setTimeout> | undefined; key: string | null } = {
    timer: undefined,
    key: null,
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let dismissedScope: string | null = null;
  let synced: Synced | null = null;

  // ---- 입력에서 뽑기 ----------------------------------------------------------------

  let memo: { enabled: boolean; text: string; links: string[]; linksKey: string; holdsSecret: boolean } | null =
    null;

  function derive(input: ComposerLinkPreviewInput): Derived {
    if (memo === null || memo.text !== input.text || memo.enabled !== input.enabled) {
      const links = input.enabled ? draftPreviewLinks(input.text) : [];
      memo = {
        enabled: input.enabled,
        text: input.text,
        links,
        linksKey: links.join("\n"),
        holdsSecret: containsSecretKey(input.text),
      };
    }
    const room = input.workspaceId !== undefined && input.channelId !== undefined;
    const ws = input.workspaceId ?? "";
    const ch = input.channelId ?? "";
    return {
      ws,
      ch,
      links: memo.links,
      linksKey: memo.linksKey,
      quiet: input.paused || memo.holdsSecret || !room,
      scope: `${ws}\n${ch}\n${input.threadRootId ?? ""}\n${memo.linksKey}`,
    };
  }

  // ---- 기억 ---------------------------------------------------------------------------

  const slotOf = (ws: string, url: string) => `${ws}\n${url}`;
  const isFresh = (slot: string) => (memory.get(slot)?.until ?? 0) > now();
  const isBusy = (slot: string) => (busyUntil.get(slot) ?? 0) > now();
  const wantsAsk = (ws: string, urls: readonly string[]) =>
    urls.some((url) => !isFresh(slotOf(ws, url)) && !isBusy(slotOf(ws, url)));

  function changed(): void {
    revision += 1;
    for (const listener of [...listeners]) listener();
  }

  function remember(slot: string, preview: UnfurlPreview): void {
    memory.delete(slot);
    memory.set(slot, { preview, until: now() + unfurlPreviewMemoryMs(preview) });
    for (const oldest of memory.keys()) {
      if (memory.size <= MEMORY_LIMIT) break;
      memory.delete(oldest);
    }
    changed();
  }

  function setDismissed(scope: string): void {
    if (dismissedScope === scope) return;
    dismissedScope = scope;
    changed();
  }

  // ---- 묻기 ---------------------------------------------------------------------------

  function abortRun(): void {
    run?.controller.abort();
    run = null;
  }

  function clearRetry(): void {
    if (retry.timer !== undefined) clearTimeout(retry.timer);
    retry = { timer: undefined, key: null };
  }

  // 429: 그 주소는 `Retry-After` 동안 묻지 않고, 이 링크 구성에서 한 번만 다시 묻는다. 예약은 링크 구성·방·묻지 않는 때가
  // 바뀌는 `sync`가 지우므로(`clearRetry`), 불리는 예약은 늘 지금 구성의 것이다.
  function holdOff(
    ws: string,
    ch: string,
    slot: string,
    seconds: number | undefined,
    urls: readonly string[],
    key: string
  ): void {
    if (seconds === undefined) return;
    const wait = Math.min(Math.max(seconds, 1), UNFURL_PREVIEW_RETRY_CEILING_SECONDS) * 1000;
    busyUntil.set(slot, now() + wait);
    if (retry.key === key) return;
    retry.key = key;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      startRun(ws, ch, urls, key);
    }, wait);
  }

  /** 한 번에 한 판. 링크가 바뀌면 `sync`가 옛 판을 끊고 비운다. 주소는 차례로, 하나씩 묻는다. */
  function startRun(ws: string, ch: string, urls: readonly string[], key: string): void {
    if (run) return;
    const controller = new AbortController();
    run = { controller };
    void (async () => {
      try {
        for (const url of urls) {
          const slot = slotOf(ws, url);
          if (isFresh(slot) || isBusy(slot)) continue;
          let answer: UnfurlPreview;
          try {
            answer = await options.fetchPreview(ws, ch, url, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof ApiError && error.status === 429) {
              holdOff(ws, ch, slot, error.retryAfterSeconds, urls, key);
              return;
            }
            // 사이트·권한·옛 서버의 4xx는 글을 고치기 전에는 그대로라 잠깐 기억한다. 5xx와 끊긴
            // 연결은 기억하지 않는다: 다음 글 변경이 다시 묻는다.
            if (error instanceof ApiError && error.status < 500) {
              remember(slot, failedPreviewFor(url));
            }
            continue;
          }
          // 링크가 바뀌어 끊은 요청의 늦은 답이다: 기록하지 않고, 옛 링크의 나머지도 묻지 않는다.
          if (controller.signal.aborted) return;
          remember(slot, answer);
        }
      } finally {
        if (run?.controller === controller) run = null;
      }
    })();
  }

  // ---- 공개 -----------------------------------------------------------------------------

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => revision,

    view(input) {
      const d = derive(input);
      // ✕는 카드가 그려진 구성에서만 눌린다(`dismiss`): 링크가 없는 구성의 범위와는 같아질 수 없다.
      const suppressed = dismissedScope === d.scope;
      const answers: UnfurlPreview[] = [];
      for (const url of d.links) {
        const remembered = memory.get(slotOf(d.ws, url));
        if (remembered) answers.push(remembered.preview);
      }
      const cards = suppressed ? [] : drawablePreviews(answers);
      return {
        cards,
        suppressed,
        dismiss: () => {
          if (cards.length > 0) setDismissed(d.scope);
        },
      };
    },

    sync(input) {
      const next = derive(input);
      const prev = synced;

      // 링크 구성·방·묻지 않는 때가 바뀌면 진행 중 요청과 재시도 예약을 끊는다. 링크가 그대로인 글 고침은 끊지 않는다.
      if (
        prev === null ||
        prev.linksKey !== next.linksKey ||
        prev.ws !== next.ws ||
        prev.ch !== next.ch ||
        prev.quiet !== next.quiet
      ) {
        abortRun();
        clearRetry();
      }

      // 기다림: 글이 바뀔 때마다 처음부터. 묻을 것이 없으면(전부 받아 뒀거나 기다리는 중) 기다림도 없고, 묻지
      // 않는 때(`quiet`)에도 없다. 풀리면 이 자리가 다시 돌아 이어서 묻는다.
      if (
        prev === null ||
        prev.text !== input.text ||
        prev.enabled !== input.enabled ||
        prev.quiet !== next.quiet ||
        prev.ws !== next.ws ||
        prev.ch !== next.ch
      ) {
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = undefined;
        if (!next.quiet && next.links.length > 0 && wantsAsk(next.ws, next.links)) {
          const { ws, ch, links, linksKey } = next;
          debounce = setTimeout(() => {
            debounce = undefined;
            startRun(ws, ch, links, linksKey);
          }, UNFURL_PREVIEW_DEBOUNCE_MS);
        }
      }

      // ✕는 눌렀을 때의 구성에만 걸린다. 구성이 달라졌으면(지우기·바꾸기·방·스레드 이동·보내기) 그 자리에서 푼다 —
      // `view`는 같은 구성인지 비교해서 그리므로 풀리는 것은 눈에 보이지 않지만, 같은 구성으로 되돌아와도 ✕가
      // 되살아나지 않게 여기서 잊는다.
      if (dismissedScope !== null && dismissedScope !== next.scope) dismissedScope = null;

      synced = { ...next, text: input.text, enabled: input.enabled };
    },

    dispose() {
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = undefined;
      abortRun();
      clearRetry();
      synced = null;
    },
  };
}
