import { createContext, type ComponentType } from "react";
import type { CommandSuggestCard } from "@momo/core/features/timeline/commandSuggest";
import type { Directory } from "@momo/core/features/workspace/directory";

// =============================================================================
// 제안 카드의 자리 (#2948 GC-7).
//
// 행(`MessageRow`)은 카드 본체(`chat/AiConnectCard`)를 직접 import하지 않는다. 카드는
// 설정 부품·로그인 모달·구독 감지(온보딩 자산)까지 끌고 와서, 행 하나를 번들하는
// 하네스(Chromium 게이트)와 행을 빌려 쓰는 표면(디렉터리·설정 미리보기)에 그 그래프가
// 번진다. 그래서 채널 표면(`ChatShell`)이 이 컨텍스트로 카드 컴포넌트를 건네고, 없는
// 표면에서 행은 에이전트의 본문만 그린다(모르는 카드 = 본문 폴백과 같은 모양).
// =============================================================================

export interface CommandSuggestSlotProps {
  card: CommandSuggestCard;
  viewerMemberId: string | undefined;
  directory: Directory;
  channelId: string;
  /** 스레드 답글로 온 제안이면 그 스레드의 뿌리. 부탁 멘션은 그 스레드 입력창에 심는다. */
  rootId: string | undefined;
}

export const CommandSuggestSlot = createContext<ComponentType<CommandSuggestSlotProps> | null>(null);
