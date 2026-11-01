import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchUnfurlPreview } from "@momo/core/lib/api";
import { unfurlDrawsCards } from "@momo/core/features/timeline/unfurl";
import {
  createComposerLinkPreviewController,
  type ComposerLinkPreviewState,
} from "@momo/core/features/timeline/composerLinkPreview";
import { useLinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";

// =============================================================================
// 보내기 전 입력칸의 링크 미리보기 (#5005, ADR-0170 증보 2026-11-01 D14~D22).
//
// 규칙 전부 — 무엇을 묻나(앞의 서로 다른 3개)·언제 묻나(멈춘 뒤 350ms, 주소는 한 개씩 차례로)·같은 주소는 다시 묻지
// 않음·늦은 답 가드·429 `Retry-After` 뒤 한 번·키 모양이 든 글은 묻지 않음·✕의 범위 — 는 코어
// `createComposerLinkPreviewController`(`@momo/core/features/timeline/composerLinkPreview`)가 정한다. 폰 입력창이 같은
// 컨트롤러를 쓴다(#5037). 이 훅이 가진 것은 웹 몫뿐이다: 이 기기의 카드 설정(「끄기」인가)을 읽고, 렌더마다 지금
// 입력으로 그릴 것을 컨트롤러에게 묻고(`view`), 효과에서 묻기를 맞추고(`sync`), 입력칸이 사라지면 끊는다(`dispose`).
// 규칙을 바꾸려면 코어 컨트롤러를 고친다 — 이 파일을 고쳐서 규칙이 갈라지지 않는다.
//
// Esc는 웹에만 있다: 닫는 키 순서는 코어 `composerKeyIntent`의 `preview-dismiss`가 정하고, 호스트가 `dismiss`를 부른다.
// =============================================================================

export type { ComposerLinkPreviewState };

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
  const enabled = unfurlDrawsCards(useLinkPreviewPreference());
  // 입력칸 하나에 컨트롤러 하나. 채널·스레드를 옮겨도 새로 만들지 않는다 — 받아 둔 답은 워크스페이스·주소별이라
  // 방을 옮겨도 이어 쓴다(원래 훅이 `useRef`로 들고 있던 기억과 같은 수명).
  const [controller] = useState(() =>
    createComposerLinkPreviewController({
      // 부를 때 모듈에서 읽는다 — 시험이 이 함수를 바꿔 끼워도 닿는다.
      fetchPreview: (ws, ch, url, signal) => fetchUnfurlPreview(ws, ch, url, signal),
    })
  );
  // 받아 둔 답이나 ✕가 바뀌면 다시 그린다. 그릴 것은 아래 `view`가 지금 입력에서 뽑는다.
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.sync({ workspaceId, channelId, threadRootId, text, paused, enabled });
  }, [controller, workspaceId, channelId, threadRootId, text, paused, enabled]);
  useEffect(() => () => controller.dispose(), [controller]);
  return controller.view({ workspaceId, channelId, threadRootId, text, paused, enabled });
}
