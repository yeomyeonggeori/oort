import { createContext, useContext } from "react";
import type { DialogFocusTarget } from "@/design/ui/dialog";

// 새 DM 모달을 셸 어디서든 여는 문 (#3662). 진입점이 둘(사이드바 DM 머리의 +, ⌘⇧K)이라
// 다이얼로그는 셸이 한 벌만 들고 동사만 내려보낸다 — CreateChannelProvider와 같은 이유다.

export type OpenNewDm = (opener?: DialogFocusTarget | null) => void;

export const NewDmOpenContext = createContext<OpenNewDm | null>(null);

export function useOpenNewDm(): OpenNewDm {
  const open = useContext(NewDmOpenContext);
  if (!open) throw new Error("useOpenNewDm must be used inside NewDmProvider");
  return open;
}

/** 모달이 떠 있는가. 전역 단축키가 모달 위에서 물러서려고 읽는다(R2 M4와 같은 규칙). */
export const NewDmOpenStateContext = createContext(false);

export function useNewDmOpen(): boolean {
  return useContext(NewDmOpenStateContext);
}
