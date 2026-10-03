import type { PaneShare } from "./paneShare";
import type { ShareChannelOption } from "./ShareDialog";

// 도크가 「채널에 공유」에 필요한 것(#2867). 도크는 서버를 모른다: 제품은 `useLocalShareSource`가,
// 시험·캡처 하네스는 흉내 원천이 채운다(A 칸의 `AgentPaneSource`와 같은 자리).
export interface PaneShareSource {
  share: PaneShare;
  /** 고를 수 있는 채널(보관·DM 제외). */
  channels: readonly ShareChannelOption[];
  /** 「이 맥 등록하러 가기」: 설정의 「이 맥」으로. */
  openHostSettings: () => void;
  /** 클립보드에 쓴다. 실패하면 false. */
  copyText: (text: string) => Promise<boolean>;
}
