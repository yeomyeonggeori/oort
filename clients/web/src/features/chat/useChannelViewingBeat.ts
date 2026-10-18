import { useEffect } from "react";
import {
  holdChannelViewing,
  type ForegroundPort,
} from "@momo/core/features/readState/viewingBeat";

// 「보고 있음」 존재 신호의 웹·데스크탑 어댑터 (ADR-0204 증보 3, #4063).
// 앞에 있다 = 탭이 보이고(visibilitychange) 창이 포커스를 가졌다(focus·blur).
// 둘 중 하나라도 아니면 사용자는 이 채널을 보고 있지 않으므로 신호를 멈춘다.
export const documentForeground: ForegroundPort = {
  isForeground: () =>
    document.visibilityState === "visible" && document.hasFocus(),
  subscribe: (onChange) => {
    const notify = () => onChange(documentForeground.isForeground());
    document.addEventListener("visibilitychange", notify);
    window.addEventListener("focus", notify);
    window.addEventListener("blur", notify);
    return () => {
      document.removeEventListener("visibilitychange", notify);
      window.removeEventListener("focus", notify);
      window.removeEventListener("blur", notify);
    };
  },
};

/** 채널이 화면에 있는 동안만 신호를 보낸다. `channelId`가 null이면 보내지 않는다. */
export function useChannelViewingBeat(
  workspaceId: string,
  channelId: string | null,
  enabled = true,
  foreground: ForegroundPort = documentForeground
): void {
  useEffect(() => {
    if (!enabled || channelId === null || workspaceId === "") return undefined;
    return holdChannelViewing(workspaceId, channelId, foreground);
  }, [workspaceId, channelId, enabled, foreground]);
}
