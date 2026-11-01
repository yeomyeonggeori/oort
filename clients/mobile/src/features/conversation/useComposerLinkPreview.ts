import {fetchUnfurlPreview} from '@momo/core/lib/api';
import {unfurlDrawsCards} from '@momo/core/features/timeline/unfurl';
import {
  createComposerLinkPreviewController,
  type ComposerLinkPreviewState,
} from '@momo/core/features/timeline/composerLinkPreview';
import {useEffect, useState, useSyncExternalStore} from 'react';

import {useLinkPreviewPreference} from './linkPreviewPreference';

// =============================================================================
// 보내기 전 입력칸의 링크 미리보기 — 폰 (#5016, ADR-0170 증보 2026-11-01 D14~D22).
//
// 웹 `clients/web/src/features/chat/useComposerLinkPreview.ts`(#5005)와 **같은 컨트롤러**를 쓴다(#5037): 코어
// `createComposerLinkPreviewController`(`@momo/core/features/timeline/composerLinkPreview`)가 규칙 전부 — 무엇을
// 묻나(앞의 서로 다른 3개)·언제 묻나(멈춘 뒤 350ms, 주소는 한 개씩 차례로)·같은 주소는 다시 묻지 않음·늦은 답 가드·
// 429 `Retry-After` 뒤 한 번·키 모양이 든 글은 묻지 않음·보낼 방을 모르면 묻지 않음·✕의 범위 — 를 정한다. 이 훅이
// 가진 것은 폰 몫뿐이다: 이 기기의 카드 설정(「끄기」인가)을 읽고, 렌더마다 지금 입력으로 그릴 것을 컨트롤러에게 묻고
// (`view`), 효과에서 묻기를 맞추고(`sync`), 입력창이 사라지면 끊는다(`dispose`). 예전에는 상태기계가 웹 훅과 한
// 벌씩 두 곳에 있어 고치면 두 곳을 함께 고쳐야 했다 — 이제 규칙을 바꾸려면 코어 컨트롤러 한 곳을 고친다.
//
// 폰에는 Esc가 없다 — 닫는 길은 ✕ 하나다.
// =============================================================================

export type {ComposerLinkPreviewState};

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
  // 「끄기」인 기기는 카드를 그리지 않는다. 그릴 수 없는 카드를 위해 초안의 링크를 서버로 보내지도,
  // 보이지 않는 카드를 ✕로 끄지도 않는다.
  const enabled = unfurlDrawsCards(useLinkPreviewPreference());
  // 입력창 하나에 컨트롤러 하나. 방·스레드를 옮겨도 새로 만들지 않는다 — 받아 둔 답은 워크스페이스·주소별이라 방을
  // 옮겨도 이어 쓴다.
  const [controller] = useState(() =>
    createComposerLinkPreviewController({
      // 부를 때 모듈에서 읽는다 — 시험이 이 함수를 바꿔 끼워도 닿는다.
      fetchPreview: (ws, ch, url, signal) => fetchUnfurlPreview(ws, ch, url, signal),
    }),
  );
  // 받아 둔 답이나 ✕가 바뀌면 다시 그린다. 그릴 것은 아래 `view`가 지금 입력에서 뽑는다.
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.sync({workspaceId, channelId, threadRootId, text, paused, enabled});
  }, [controller, workspaceId, channelId, threadRootId, text, paused, enabled]);
  useEffect(() => () => controller.dispose(), [controller]);
  return controller.view({workspaceId, channelId, threadRootId, text, paused, enabled});
}
