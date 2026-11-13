import { LocalTerminalDock, type LocalWorkbenchPresentation } from "../local/LocalTerminalDock";
import { useAgentPaneSource } from "./agentPaneSource";
import { useLocalShareSource } from "../local/share/useLocalShareSource";

// 제품의 도크·「내 작업」 탭(#2779). 로컬 칸에 더해 이 워크스페이스의 A 세션을
// 칸으로 열 수 있다. 하네스·시험은 `LocalTerminalDock`을 직접 쓰고 원천을 넘긴다.
export function ConnectedTerminalDock({
  presentation = "dock",
  openAgentSession = null,
  onAgentSessionOpened,
}: {
  presentation?: LocalWorkbenchPresentation;
  /** 작업 권한 요청 배너가 연 A 세션(#5595). 격자가 그 칸을 열고 `onAgentSessionOpened`를 부른다. */
  openAgentSession?: string | null;
  onAgentSessionOpened?: () => void;
}) {
  const agent = useAgentPaneSource();
  const share = useLocalShareSource();
  return (
    <LocalTerminalDock
      presentation={presentation}
      agent={agent}
      share={share}
      openAgentSession={openAgentSession}
      {...(onAgentSessionOpened ? { onAgentSessionOpened } : {})}
    />
  );
}
