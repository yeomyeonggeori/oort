import { uuidEq, type Channel, type ReadState } from "@momo/core/lib/api";
import {
  dmHiddenAsGone,
  rosterIsComplete,
  type ReadProjectionPhase,
} from "@momo/core/features/sidebar/goneDm";
import {
  channelLabelParts,
  idKey,
  unreadFor,
  type Directory,
} from "@momo/core/features/workspace/directory";
import { sidebarUnreadCounts } from "./sidebarUnread";

// =============================================================================
// 사이드바에서 「나간 멤버와의 대화」로 접히는 DM 들 (#4252). 판정은 코어 `dmHiddenAsGone` 한 함수이고
// (폰도 같은 함수를 읽는다), 이 파일은 그 입력을 웹이 가진 값에서 모아 주기만 한다.
//
// 입력은 행이 그리는 것과 **같은 값**이다: 이름 갈래는 `channelLabelParts`(사이드바 행과 같은 함수·같은
// 명부 도착 판정), 안 읽음은 `sidebarUnreadCounts`(열려 있는 DM 은 0 으로 접힌 값). 그래서 행의 알약과
// 접힘이 같은 사실을 말한다.
//
// 닫기 원장(`sidebarDmClosure.ts`)과의 순서: 원장이 사람이 X 로 닫은 대화를 먼저 거르고, 호출부는 그
// **남은** DM 만 여기에 넘긴다. 원장이 숨긴 나간 멤버 DM 은 접힌 줄의 수에도 들지 않는다(사람이 닫은 것을
// 이 줄이 도로 펼치지 않는다).
// =============================================================================

/** 접히는 DM 의 id(소문자). `openId` 가 곧 「지금 보고 있는 DM」이라 그 DM 은 접히지 않는다. */
export function goneDmIds(input: {
  dms: readonly Channel[];
  directory: Directory;
  selfMemberId: string;
  /**
   * 명부를 받았나(`rosterLoaded`). 못 받았으면 상대 없는 DM 은 「불러오는 중」이라 접히지 않는다. 조회가 실패했는데
   * 도착 판정만 참이면 모든 DM 이 「나간 멤버」로 읽히므로 호출부는 실패를 「못 받음」으로 넘긴다.
   */
  rosterReady: boolean;
  byChannel: Map<string, ReadState>;
  openId: string | null;
  phase: ReadProjectionPhase;
}): ReadonlySet<string> {
  const folded = new Set<string>();
  for (const dm of input.dms) {
    const label = channelLabelParts(dm, input.directory, input.selfMemberId, {
      rosterReady: input.rosterReady,
    });
    const counts = sidebarUnreadCounts(dm.id, input.openId, unreadFor(input.byChannel, dm.id));
    if (
      dmHiddenAsGone({
        labelKind: label.kind,
        rosterComplete: rosterIsComplete(input.directory.members.length),
        unreadCount: counts.unreadCount,
        mentionCount: counts.mentionCount,
        isOpen: input.openId !== null && uuidEq(dm.id, input.openId),
        phase: input.phase,
      })
    ) {
      folded.add(idKey(dm.id));
    }
  }
  return folded;
}
