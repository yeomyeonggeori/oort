import { Bell, BellOff } from "lucide-react";
import type { ThreadFollowCopy, ThreadFollowView } from "@momo/core/features/timeline/threadFollow";
import { Tooltip } from "@/design/ui/tooltip";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";

// =============================================================================
// 스레드 패널 머리의 「따라가기 / 그만 따라가기」 단추 (#4890). 머리의 다른 단추(닫기)와 같은 문법이다: `.a-ibtn` 34px 둥근
// 사각 + 아주 연한 선, 툴팁은 아래(공유 `Tooltip`). 아이콘은 Lucide 의 기존 `Bell`·`BellOff` 이다 — 새로 그리지 않았다.
//
// 지금 상태가 한눈에 보인다: 따라가는 중이면 켜진 모양(`pressed`, `Bell`), 아니면 꺼진 모양(`BellOff`, 빗금). 색만으로 말하지
// 않는다 — 아이콘이 바뀌고, 접근성 라벨이 **상태를 말로** 한다(「이 스레드를 따라가고 있어요. 누르면 그만 따라가요.」).
// 툴팁은 눈으로 보는 보조라 누르면 하는 일을 쓴다(「그만 따라가기」·「따라가기」).
//
// 누르면 값이 바로 바뀌고(낙관적) 요청이 나가는 동안 다시 눌러도 요청은 한 번이다: 단추는 `aria-busy` 로 알리고 `disabled` 로
// 흐리지 않는다(눌러도 되는지 알 수 없는 회색이 되지 않게 — `InlineBanner.actionBusy` 와 같은 규칙).
// =============================================================================

export function ThreadFollowButton({
  view,
  copy,
  onToggle,
}: {
  view: ThreadFollowView;
  copy: ThreadFollowCopy;
  onToggle: () => void;
}) {
  const Icon = view.following ? Bell : BellOff;
  return (
    <Tooltip label={copy.action} side="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-label={copy.label}
        aria-busy={view.pending || undefined}
        data-testid="thread-follow"
        data-following={String(view.following)}
        className={channelHeaderControlClass({ pressed: view.following })}
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
