import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { uuidEq } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { ChatShell } from "@/features/chat/ChatShell";
import { useChannels } from "@/features/workspace/useWorkspace";
import { ChannelPreviewScreen } from "./ChannelPreviewScreen";

// =============================================================================
// `/c/{id}` 의 자리를 고르는 얇은 길 (ADR-0224 D5, #5844). 내 채널 목록에 있는 id 는 대화(`ChatShell`), 없는 id 는 미리 보기다.
// 미리 보기가 아닌 `ChatShell` 안에서 가르지 않은 까닭: `ChatShell` 은 마운트되는 순간 이력 읽기 · 실시간 구독 · 읽음 알림 · 보고 있음
// 신호를 건다. 참여하지 않은 채널에서 그것들이 돌면 403 이 나고 구독이 열린다 — 이 길은 그것들이 **아예 돌지 않게** 길 밖에서 고른다.
//
// 「내 목록에 없다」가 「멤버가 아니다」는 아니다. 목록은 주기적으로 다시 읽지 않아(30초 지나 다시 붙을 때만) 새로 추가된 채널이나 알림
// 링크가 낡은 목록과 만날 수 있다. 그래서 모르는 id 를 만나면 목록을 **한 번 새로 읽고**(그동안 골격) 그래도 없을 때만 미리 보기로 간다.
// 보관된 채널은 목록에 남아 있으므로(`groups` 가 거를 뿐) 원시 목록으로 가른다 — 예전 동작 그대로 `ChatShell` 이 맡는다.
// =============================================================================

/** 목록을 방금(이 시간 안에) 읽었으면 한 번 더 읽지 않는다 — 처음 열 때 목록 읽기와 겹치는 요청을 없앤다. */
const FRESH_LIST_MS = 3000;

export function ChannelRoute() {
  const { channelId } = useParams();
  const { workspaceId } = useSession();
  const channels = useChannels(workspaceId);
  const { refetch, dataUpdatedAt, isFetching } = channels;
  // 모르는 id 에 대해 목록을 새로 읽는 확인이 끝난 id. 확인은 id 마다 한 번이다.
  const [checked, setChecked] = useState<string | null>(null);
  const attempted = useRef<string | null>(null);

  const listed = channels.data !== undefined;
  const known = channelId === undefined || (listed && channels.data.some((c) => uuidEq(c.id, channelId)));
  const awaitingCheck =
    listed && !known && checked !== channelId && (isFetching || Date.now() - dataUpdatedAt >= FRESH_LIST_MS);

  useEffect(() => {
    if (!listed || known || channelId === undefined || checked === channelId) return;
    // 이미 다시 읽는 중이면(낡은 목록은 마운트가 먼저 다시 읽는다) 그 답을 기다린다 — 같은 읽기를 두 번 보내지 않는다.
    if (isFetching) return;
    if (Date.now() - dataUpdatedAt < FRESH_LIST_MS || attempted.current === channelId) {
      setChecked(channelId);
      return;
    }
    attempted.current = channelId;
    let live = true;
    void refetch().finally(() => {
      if (live) setChecked(channelId);
    });
    return () => {
      live = false;
    };
  }, [listed, known, channelId, checked, dataUpdatedAt, isFetching, refetch]);

  // 목록을 못 읽었으면(오프라인 · 실패) 예전처럼 `ChatShell` 이 자기 상태로 말한다.
  if (channels.isError && !listed) return <ChatShell />;
  if (known) return <ChatShell />;
  // 목록을 기다리거나 새로 읽는 동안은 골격만 서고 미리 보기 요청은 나가지 않는다.
  return <ChannelPreviewScreen channelId={channelId} loadingOnly={!listed || awaitingCheck} />;
}
