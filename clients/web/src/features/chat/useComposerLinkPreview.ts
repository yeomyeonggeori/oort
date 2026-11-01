import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchUnfurlPreview } from "@momo/core/lib/api";
import { containsSecretKey } from "@momo/core/features/chat/secretKey";
import {
  drawablePreviews,
  unfurlDrawsCards,
  type UnfurlPreview,
  type UnfurlPreviewCard,
} from "@momo/core/features/timeline/unfurl";
import {
  UNFURL_PREVIEW_DEBOUNCE_MS,
  UNFURL_PREVIEW_RETRY_CEILING_SECONDS,
  draftPreviewLinks,
  failedPreviewFor,
  unfurlPreviewMemoryMs,
} from "@momo/core/features/timeline/unfurlDraft";
import { useLinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";

// =============================================================================
// 보내기 전 입력칸의 링크 미리보기 (#5005, ADR-0170 증보 2026-11-01 D14~D22).
//
// 글에서 서버가 카드로 만들 주소(코어 `draftPreviewLinks`, 앞의 서로 다른 3개)를 고르고, 입력을 멈춘
// 뒤에 한 개씩 차례로 묻는다. **화면에 보이는 카드는 늘 「지금 글의 링크」와 「받아 둔 답」에서 그때그때
// 뽑는다.** 그래서 늦게 온 답이 이미 지워진 링크의 카드를 그릴 수 없다. 그래도 링크가 바뀌면 진행 중
// 요청은 끊는다(서버 예산을 쓰지 않으려고) — 끊은 요청의 답이 오면 기록하지도, 다음 링크를 묻지도
// 않는다(`aborted` 줄이 그 가드다).
//
//   멈춘 뒤에만      글이 바뀔 때마다 기다림이 처음부터다(350ms). 링크가 그대로면 진행 중 요청은 두고,
//                   그 요청이 끝난 뒤에는 새로 묻지 않는다.
//   같은 주소는 한 번 받아 둔 답(`ok` 25분, `failed` 2분)이 있으면 다시 묻지 않는다. 이 훅이 서 있는 동안의
//                   기억이고, 서버의 30분·2분보다 조금 짧다(죽은 그림 열쇠를 부르지 않으려고).
//   조용히           실패·거절·꺼진 스위치는 모두 카드가 없는 것이다. 입력을 막지 않고 문구도 없다.
//   키 모양이 든 글   어떤 링크도 서버로 보내지 않는다. 입력칸은 그 글을 보내지도 초안으로 저장하지도 않는데,
//                   키가 링크의 쿼리에 있으면 서버가 그 주소로 나가 바깥 사이트에 키를 건네는 셈이다.
//   429             `Retry-After` 뒤에 **한 번** 다시 묻는다. 그동안 그 주소는 묻지 않고 카드 자리를 비운다.
//                   초를 말하지 않은 429는 기다림을 지어내지 않고 그냥 넘긴다(다음 글 변경이 다시 묻는다).
//   ✕·Esc           지금 링크 구성에서만 「이번 메시지는 미리보기 없이 보내기」다. 링크를 지우거나 바꾸면
//                   (채널을 옮겨도) 다시 뜬다. 보내고 나면 글이 비어 구성이 달라지므로 저절로 풀린다.
// =============================================================================

/** 이 훅이 기억하는 주소의 상한. 넘으면 가장 오래된 것부터 잊는다. */
const MEMORY_LIMIT = 48;

interface Remembered {
  preview: UnfurlPreview;
  /** 이 시각까지 다시 묻지 않는다(밀리초). */
  until: number;
}

export interface ComposerLinkPreviewState {
  /** 입력칸 위에 그릴 카드, 글에 나온 순서. 없거나 ✕로 껐으면 비어 있다. */
  cards: UnfurlPreviewCard[];
  /** 이 링크 구성에서 ✕를 눌렀다. 보낼 때 `suppressUnfurl`을 싣는다. */
  suppressed: boolean;
  /** ✕·Esc. 그릴 카드가 없으면 아무 일도 하지 않는다. */
  dismiss: () => void;
}

export function useComposerLinkPreview({
  workspaceId,
  channelId,
  threadRootId,
  text,
  paused = false,
}: {
  workspaceId: string;
  channelId: string;
  /**
   * 스레드 입력칸이면 그 스레드의 뿌리 메시지(#5016). ✕가 같은 채널의 **다른 스레드**로 따라가지 않게 ✕의 범위에만
   * 적는다 — 물어서 받아 둔 답은 주소만의 것이라 스레드와 상관없이 나눠 쓴다.
   */
  threadRootId?: string;
  /** 입력칸의 지금 글(초안). */
  text: string;
  /** 오프라인처럼 지금은 묻지 않는 때. 풀리면 이어서 묻는다. 이미 받은 카드와 ✕는 그대로 둔다. */
  paused?: boolean;
}): ComposerLinkPreviewState {
  // 「끄기」인 기기는 카드를 그리지 않는다. 그릴 수 없는 카드를 위해 초안의 링크를 서버로 보내지도,
  // 보이지 않는 카드를 ✕로 끄지도 않는다.
  const preference = useLinkPreviewPreference();
  const enabled = unfurlDrawsCards(preference);
  const links = useMemo(() => (enabled ? draftPreviewLinks(text) : []), [enabled, text]);
  const linksKey = links.join("\n");
  // 지금은 묻지 않는 때: 오프라인이거나, 글에 키 모양이 있다. 받아 둔 카드와 ✕는 그대로 둔다.
  const holdsSecret = useMemo(() => containsSecretKey(text), [text]);
  const quiet = paused || holdsSecret;
  // 채널(스레드 입력칸이면 스레드도)을 옮겨 같은 링크 구성의 다른 초안이 열려도 ✕가 따라가지 않게 함께 적는다.
  const scope = `${workspaceId}\n${channelId}\n${threadRootId ?? ""}\n${linksKey}`;

  const memory = useRef(new Map<string, Remembered>());
  const busyUntil = useRef(new Map<string, number>());
  const run = useRef<{ controller: AbortController } | null>(null);
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; key: string | null }>({
    timer: undefined,
    key: null,
  });
  const currentKey = useRef(linksKey);
  currentKey.current = linksKey;
  const [, repaint] = useState(0);

  const slotOf = (url: string) => `${workspaceId}\n${url}`;
  const isFresh = (slot: string) => (memory.current.get(slot)?.until ?? 0) > Date.now();
  const isBusy = (slot: string) => (busyUntil.current.get(slot) ?? 0) > Date.now();
  const wantsAsk = (urls: readonly string[]) =>
    urls.some((url) => !isFresh(slotOf(url)) && !isBusy(slotOf(url)));

  function remember(slot: string, preview: UnfurlPreview) {
    const map = memory.current;
    map.delete(slot);
    map.set(slot, { preview, until: Date.now() + unfurlPreviewMemoryMs(preview) });
    for (const oldest of map.keys()) {
      if (map.size <= MEMORY_LIMIT) break;
      map.delete(oldest);
    }
    repaint((count) => count + 1);
  }

  // 429: 그 주소는 `Retry-After` 동안 묻지 않고, 이 링크 구성에서 한 번만 다시 묻는다.
  function holdOff(slot: string, seconds: number | undefined, urls: readonly string[], key: string) {
    if (seconds === undefined) return;
    const wait = Math.min(Math.max(seconds, 1), UNFURL_PREVIEW_RETRY_CEILING_SECONDS) * 1000;
    busyUntil.current.set(slot, Date.now() + wait);
    if (retry.current.key === key) return;
    retry.current.key = key;
    retry.current.timer = setTimeout(() => {
      retry.current.timer = undefined;
      // 그 사이 사람이 링크를 바꿨다면 옛 링크를 다시 묻지 않는다.
      if (currentKey.current === key) startRun(urls, key);
    }, wait);
  }

  /** 한 번에 한 판. 링크가 바뀌면 효과 정리가 옛 판을 끊고 비운다. 주소는 차례로, 하나씩 묻는다. */
  function startRun(urls: readonly string[], key: string) {
    if (run.current) return;
    const controller = new AbortController();
    run.current = { controller };
    void (async () => {
      try {
        for (const url of urls) {
          const slot = slotOf(url);
          if (isFresh(slot) || isBusy(slot)) continue;
          let answer: UnfurlPreview;
          try {
            answer = await fetchUnfurlPreview(workspaceId, channelId, url, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof ApiError && error.status === 429) {
              holdOff(slot, error.retryAfterSeconds, urls, key);
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
        if (run.current?.controller === controller) run.current = null;
      }
    })();
  }

  // 같은 렌더의 함수를 효과가 부르게 한다(효과 의존성에 매 렌더 새로 만들어지는 함수를 넣으면 기다림이
  // 렌더마다 처음부터가 된다).
  const latest = useRef({ startRun, wantsAsk });
  latest.current = { startRun, wantsAsk };

  // 기다림: 글이 바뀔 때마다 처음부터. 묻을 것이 없으면(전부 받아 뒀거나 기다리는 중) 기다림도 없다.
  // 묻지 않는 때(`quiet`)에는 기다림도 없다. 풀리면 이 효과가 다시 돌아 이어서 묻는다.
  useEffect(() => {
    if (quiet || links.length === 0 || !latest.current.wantsAsk(links)) return;
    const timer = setTimeout(
      () => latest.current.startRun(links, linksKey),
      UNFURL_PREVIEW_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [quiet, links, linksKey, workspaceId, channelId]);

  // 링크 구성·채널이 바뀌거나, 묻지 않는 때가 되거나, 입력칸이 사라지면 진행 중 요청과 재시도 예약을 끊는다.
  useEffect(
    () => () => {
      run.current?.controller.abort();
      run.current = null;
      if (retry.current.timer !== undefined) clearTimeout(retry.current.timer);
      retry.current = { timer: undefined, key: null };
    },
    [linksKey, workspaceId, channelId, quiet]
  );

  // ✕는 눌렀을 때의 링크 구성에만 걸린다. 구성이 달라지면(지우기·바꾸기·채널 이동·보내기) 그 자리에서 푼다.
  const [dismissedScope, setDismissedScope] = useState<string | null>(null);
  if (dismissedScope !== null && dismissedScope !== scope) setDismissedScope(null);
  const suppressed = linksKey !== "" && dismissedScope === scope;

  const answers: UnfurlPreview[] = [];
  for (const url of links) {
    const remembered = memory.current.get(slotOf(url));
    if (remembered) answers.push(remembered.preview);
  }
  const cards = suppressed ? [] : drawablePreviews(answers);

  return {
    cards,
    suppressed,
    dismiss: () => {
      if (cards.length > 0) setDismissedScope(scope);
    },
  };
}
