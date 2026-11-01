import {ApiError, fetchUnfurlPreview} from '@momo/core/lib/api';
import {containsSecretKey} from '@momo/core/features/chat/secretKey';
import {
  drawablePreviews,
  unfurlDrawsCards,
  type UnfurlPreview,
  type UnfurlPreviewCard,
} from '@momo/core/features/timeline/unfurl';
import {
  UNFURL_PREVIEW_DEBOUNCE_MS,
  UNFURL_PREVIEW_RETRY_CEILING_SECONDS,
  draftPreviewLinks,
  failedPreviewFor,
  unfurlPreviewMemoryMs,
} from '@momo/core/features/timeline/unfurlDraft';
import {useEffect, useMemo, useRef, useState} from 'react';

import {useLinkPreviewPreference} from './linkPreviewPreference';

// =============================================================================
// 보내기 전 입력칸의 링크 미리보기 — 폰 (#5016, ADR-0170 증보 2026-11-01 D14~D22).
//
// 웹 `clients/web/src/features/chat/useComposerLinkPreview.ts`(#5005) **와 같은 훅**이다. 무엇을 카드로 만들지(코어
// `draftPreviewLinks`), 얼마나 기다리고 얼마나 기억할지(코어 상수), 어떤 답이 카드를 그리는지(코어
// `drawablePreviews`)는 전부 코어가 정한다. 이 파일이 가진 것은 「언제 묻나」의 순서뿐이다: 글이 바뀔 때마다 처음부터
// 350ms, 주소는 한 번에 하나씩, 링크가 바뀌면 나가 있던 요청을 끊고 그 늦은 답은 기록도 후속 질문도 하지 않는다,
// 429는 `Retry-After` 뒤 **한 번**. 상태기계가 웹과 한 벌씩 두 곳에 있으므로 **고치면 두 곳을 함께 고친다**(코어의
// 순수 컨트롤러로 올리는 것은 후속이다 — #5005 인계 §7-2).
//
// **화면에 보이는 카드는 늘 「지금 글의 링크」와 「받아 둔 답」에서 그때그때 뽑는다.** 그래서 늦게 온 답이 이미
// 지워진 링크의 카드를 그릴 수 없다.
//
//   조용히           실패·거절·꺼진 스위치는 모두 카드가 없는 것이다. 입력을 막지 않고 문구도 없다.
//   키 모양이 든 글   어떤 링크도 서버로 보내지 않는다(입력칸은 그 글을 보내지도 초안으로 저장하지도 않는다).
//   방이 없을 때      보낼 방(`workspaceId`·`channelId`)을 모르면 물을 곳이 없다 — 아무것도 묻지 않는다.
//   ✕               지금 링크 구성에서만 「이번 메시지는 미리보기 없이 보내기」다. 링크를 지우거나 바꾸면(방을
//                   옮겨도, 스레드를 옮겨도) 다시 뜬다. 보내고 나면 글이 비어 구성이 달라지므로 저절로 풀린다.
//
// 폰에는 Esc가 없다 — 닫는 길은 ✕ 하나다.
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
  /** ✕. 그릴 카드가 없으면 아무 일도 하지 않는다. */
  dismiss: () => void;
}

export function useComposerLinkPreview({
  workspaceId,
  channelId,
  threadRootId,
  text,
  paused = false,
}: {
  /** 보낼 방. 둘 중 하나라도 모르면 아무것도 묻지 않는다. */
  workspaceId: string | undefined;
  channelId: string | undefined;
  /** 스레드 입력칸이면 그 스레드의 뿌리 메시지 — ✕가 같은 방의 다른 스레드로 따라가지 않게 ✕의 범위에만 적는다. */
  threadRootId?: string | undefined;
  /** 입력칸의 지금 글(초안). */
  text: string;
  /** 오프라인처럼 지금은 묻지 않는 때. 풀리면 이어서 묻는다. 이미 받은 카드와 ✕는 그대로 둔다. */
  paused?: boolean;
}): ComposerLinkPreviewState {
  const room = workspaceId !== undefined && channelId !== undefined;
  const ws = workspaceId ?? '';
  const ch = channelId ?? '';
  // 「끄기」인 기기는 카드를 그리지 않는다. 그릴 수 없는 카드를 위해 초안의 링크를 서버로 보내지도,
  // 보이지 않는 카드를 ✕로 끄지도 않는다.
  const preference = useLinkPreviewPreference();
  const enabled = unfurlDrawsCards(preference);
  const links = useMemo(() => (enabled ? draftPreviewLinks(text) : []), [enabled, text]);
  const linksKey = links.join('\n');
  // 지금은 묻지 않는 때: 오프라인이거나, 글에 키 모양이 있거나, 보낼 방을 모른다. 받아 둔 카드와 ✕는 그대로 둔다.
  const holdsSecret = useMemo(() => containsSecretKey(text), [text]);
  const quiet = paused || holdsSecret || !room;
  // 방(스레드 입력칸이면 스레드도)을 옮겨 같은 링크 구성의 다른 초안이 열려도 ✕가 따라가지 않게 함께 적는다.
  const scope = `${ws}\n${ch}\n${threadRootId ?? ''}\n${linksKey}`;

  const memory = useRef(new Map<string, Remembered>());
  const busyUntil = useRef(new Map<string, number>());
  const run = useRef<{controller: AbortController} | null>(null);
  const retry = useRef<{timer: ReturnType<typeof setTimeout> | undefined; key: string | null}>({
    timer: undefined,
    key: null,
  });
  const currentKey = useRef(linksKey);
  currentKey.current = linksKey;
  const [, repaint] = useState(0);

  const slotOf = (url: string) => `${ws}\n${url}`;
  const isFresh = (slot: string) => (memory.current.get(slot)?.until ?? 0) > Date.now();
  const isBusy = (slot: string) => (busyUntil.current.get(slot) ?? 0) > Date.now();
  const wantsAsk = (urls: readonly string[]) =>
    urls.some(url => !isFresh(slotOf(url)) && !isBusy(slotOf(url)));

  function remember(slot: string, preview: UnfurlPreview) {
    const map = memory.current;
    map.delete(slot);
    map.set(slot, {preview, until: Date.now() + unfurlPreviewMemoryMs(preview)});
    for (const oldest of map.keys()) {
      if (map.size <= MEMORY_LIMIT) break;
      map.delete(oldest);
    }
    repaint(count => count + 1);
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
    run.current = {controller};
    void (async () => {
      try {
        for (const url of urls) {
          const slot = slotOf(url);
          if (isFresh(slot) || isBusy(slot)) continue;
          let answer: UnfurlPreview;
          try {
            answer = await fetchUnfurlPreview(ws, ch, url, controller.signal);
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
  const latest = useRef({startRun, wantsAsk});
  latest.current = {startRun, wantsAsk};

  // 기다림: 글이 바뀔 때마다 처음부터. 묻을 것이 없으면(전부 받아 뒀거나 기다리는 중) 기다림도 없다.
  // 묻지 않는 때(`quiet`)에는 기다림도 없다. 풀리면 이 효과가 다시 돌아 이어서 묻는다.
  useEffect(() => {
    if (quiet || links.length === 0 || !latest.current.wantsAsk(links)) return undefined;
    const timer = setTimeout(
      () => latest.current.startRun(links, linksKey),
      UNFURL_PREVIEW_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [quiet, links, linksKey, ws, ch]);

  // 링크 구성·방이 바뀌거나, 묻지 않는 때가 되거나, 입력칸이 사라지면 진행 중 요청과 재시도 예약을 끊는다.
  useEffect(
    () => () => {
      run.current?.controller.abort();
      run.current = null;
      if (retry.current.timer !== undefined) clearTimeout(retry.current.timer);
      retry.current = {timer: undefined, key: null};
    },
    [linksKey, ws, ch, quiet],
  );

  // ✕는 눌렀을 때의 링크 구성에만 걸린다. 구성이 달라지면(지우기·바꾸기·방 이동·보내기) 그 자리에서 푼다.
  const [dismissedScope, setDismissedScope] = useState<string | null>(null);
  if (dismissedScope !== null && dismissedScope !== scope) setDismissedScope(null);
  const suppressed = linksKey !== '' && dismissedScope === scope;

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
