// =============================================================================
// 보낸 메시지 등장 애니메이션의 「한 번만」 장부 (#4383).
//
// 보낸 행은 **낙관적 메아리(`PendingRow`)가 마운트되는 한 번**만 올라온다. 서버 사본이 그 행을
// 대체할 때는(`MessageRow`) 움직이지 않는다 — 같은 자리에 같은 모양으로 이어서 서므로 두 번째
// 움직임은 곧 깜빡임이다. 그런데 목록이 가상화되면 화면 밖으로 나갔다 돌아온 메아리가
// **다시 마운트**되어 또 올라올 수 있다. 그래서 이미 올라온 `clientMsgId` 를 여기 적어 두고 두 번째
// 마운트는 곧바로 자리에 앉힌다.
//
// 상한이 있는 이유: 앱이 사는 동안 쌓이면 새는 것이다. 메아리는 서버 사본이 오면 사라지므로 오래된
// 것부터 잊어도 다시 마운트될 일이 없다.
// =============================================================================

const MAX_REMEMBERED = 256;

const arrived = new Set<string>();

/** 이 메아리가 이미 올라온 적이 있는가. 읽기만 한다(렌더 중에 불러도 안전). */
export function hasArrived(clientMsgId: string): boolean {
  return arrived.has(clientMsgId);
}

/** 올라왔다고(또는 올라오지 않기로 했다고) 적는다. 효과에서 부른다. */
export function markArrived(clientMsgId: string): void {
  if (arrived.has(clientMsgId)) return;
  arrived.add(clientMsgId);
  if (arrived.size > MAX_REMEMBERED) {
    const oldest = arrived.values().next().value;
    if (oldest !== undefined) arrived.delete(oldest);
  }
}

/** 시험 전용. */
export function resetArrivedForTest(): void {
  arrived.clear();
}
