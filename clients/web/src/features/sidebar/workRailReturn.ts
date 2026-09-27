// 「내 작업」 레일에서 떠날 때 캐럿이 돌아갈 자리 (#2854 design-review H1).

/**
 * 레일 단추로 「내 작업」을 떠나면 레일이 통째로 내려가고, 캐럿을 쥔 단추도 함께
 * 사라진다(design-review H1). 사이드바가 트리를 되살린 뒤 이 값으로 캐럿을 놓는다.
 * `undefined` = 레일에서 떠나지 않았다, `null` = 채널 목록에 같은 줄이 없다.
 */
let pendingRailReturn: string | null | undefined;

export function rememberRailReturn(testId: string | null) {
  pendingRailReturn = testId;
}

/** 한 번 읽으면 지운다. */
export function takeRailReturn(): string | null | undefined {
  const value = pendingRailReturn;
  pendingRailReturn = undefined;
  return value;
}
