import { uuidEq } from "../../lib/api";

// =============================================================================
// 복구 표지를 **세울지**의 판정 — 웹·데스크탑·폰이 공유하는 정본 (#4328 · 폰 #4292 규칙을 코어로).
//
// ## 이 파일이 정하는 한 문장
//
// 「재연결됨, 여기까지 복구」 표지는 **복구가 다른 사람(또는 에이전트)의 새 메시지를 타임라인에
// 들였을 때만** 선다.
//
//   새것   타임라인에 이미 든 줄 id 의 집합에 없는 줄. **seq 로 가리지 않는다** — REST 응답이
//          먼저 들어와 seq 를 올려 둔 내 줄과, 더 작은 seq 로 뒤늦게 닿은 남의 줄을 seq 는
//          구별하지 못한다.
//   남     작성자가 나와 다르다. 에이전트도 남이다.
//
// 복구는 「끊긴 구간을 이을 수 있었다」(`recovered: true`)일 뿐 그 구간에 무엇이 있었다는 말이
// 아니다. 아무도 말하지 않은 구간의 복구에도 참이고, 내가 방금 보낸 줄은 되쏘기에도 꼬리 읽기에도
// 실려 오지만(내 REST 응답보다 먼저 올 수도, 뒤에 올 수도 있다) 복구한 것이 아니다. 그런데도
// 표지를 세우면 메시지가 하나도 안 왔는데 행이 하나 붙었다 12초 뒤 걷히며 목록이 그만큼 미끄러졌다
// 돌아온다(owner 10-24 실기: 내가 방금 보낸 두 줄 아래에 표지가 섰다, 서버 오류는 0건).
//
// ## 왜 코어인가
//
// 폰은 #4327 에서 이 규칙을 `useTimeline` 안에 직접 짰고 웹은 재구독마다 표지를 세웠다 — 같은
// 제품의 두 클라가 같은 사건에 다른 답을 하고 있었다. 판정을 호스트 훅 안에 두는 한 그 차이는
// 고쳐도 다시 벌어진다(`divider.ts` 머리말이 적은 실패 양식 그대로다). 그래서 **판정만** 여기로
// 올린다. 줄 id 집합·복구 구간을 지켜보는 창·표지를 실제로 세우는 일은 호스트의 것으로 남는다
// (ADR-0137 D3: react 훅은 호스트에 둔다).
//
// ## 부르는 쪽의 약속
//
// 1. `knownIds` 는 **접은 열쇠**(`messageIdKey`)의 집합이다. 줄을 들일 때 같은 함수로 등록한다 —
//    UUID 는 설계상 섞인 대소문자로 오간다(`uuidEq`). 판정은 줄 쪽 id 를 접어서 찾을 뿐, 집합
//    안쪽을 접어 주지 않는다.
// 2. 판정은 **병합 전에** 부른다. 병합하면 그 줄의 id 가 집합에 들어 「새것」이 사라진다.
// 3. 줄을 들이는 **모든** 길이 id 를 등록해야 한다. 위로 더 읽은 쪽(`loadOlder`)도 마찬가지다 —
//    끊긴 사이 그 오래된 줄이 수정돼 되쏘기로 오면 새 줄이 아니라 이미 든 줄의 수정이다.
// 4. 꼬리 읽기는 여러 페이지로 오고 되쏘기는 줄마다 병합 문을 지난다. 묶음마다 부르되 앞선
//    판정을 `before` 로 넘긴다 — 누계가 이어진다. 시작할 때는 `NO_RECOVERY` 다.
//
// 이 파일은 `seq`·시계·타이머·표지의 글귀를 모른다. 글귀는 `divider.ts`, 표지의 수명(걷힘)은
// `pruneRecoveryMarkers`·`RECOVERY_MARKER_TTL_MS`, 표지의 모양은 `model.ts` 의 `RecoveryMarker` 다.
// =============================================================================

/** 판정이 줄에서 읽는 두 필드. `Message` 가 그대로 들어간다. */
export interface RecoveredLine {
  id: string;
  authorMemberId: string;
}

/** 복구 한 번에 대한 판정. 묶음마다 이어 받아 누계가 된다. */
export interface RecoveryMarkerVerdict {
  /** 표지를 세운다 — 복구가 남의 새 줄을 하나 이상 들였다. */
  readonly show: boolean;
  /** 복구가 **새로** 들인 남의 줄 수(누계). */
  readonly fresh: number;
}

/** 아직 아무것도 들이지 않은 복구. 판정을 이어 받는 첫 `before` 다. */
export const NO_RECOVERY: RecoveryMarkerVerdict = Object.freeze({
  show: false,
  fresh: 0,
});

/**
 * 줄 id 를 집합의 열쇠로 접는다. 줄을 들일 때(등록)와 복구를 판정할 때(조회)가 **같은 접기**를 써야
 * 한다 — 한쪽만 접으면 대소문자만 다른 같은 줄이 새것으로 보인다.
 */
export function messageIdKey(id: string): string {
  return id.toLowerCase();
}

/**
 * 복구가 들인 줄 묶음 하나를 판정해 `before` 에 더한다.
 *
 * @param recovered 이 복구가 지금 타임라인에 들이려는 줄(병합 **전**).
 * @param knownIds 타임라인에 이미 든 줄 id 의 집합 — 접은 열쇠(`messageIdKey`). 바꾸지 않는다.
 * @param selfMemberId 내 멤버 id. 작성자 비교는 대소문자를 접는다(`uuidEq`). 비어 있으면 아무도
 *   「나」가 아니다.
 * @param before 앞선 묶음까지의 판정. 처음이면 `NO_RECOVERY`.
 * @returns `fresh` 는 `before.fresh` 에 이 묶음의 새 남의 줄을 더한 누계이고, `show` 는 그것이
 *   1 이상인가다. 이 묶음에 더할 것이 없으면 `before` 를 **그대로** 돌려준다.
 */
export function judgeRecoveryMarker(
  recovered: ReadonlyArray<RecoveredLine>,
  knownIds: ReadonlySet<string>,
  selfMemberId: string,
  before: RecoveryMarkerVerdict = NO_RECOVERY
): RecoveryMarkerVerdict {
  // 한 묶음 안에서 같은 새 id 가 두 번 실려 와도 한 줄이다 — 호스트가 줄마다 등록하며 지나가는
  // 때와 같은 셈이다(첫 줄이 들면 둘째는 이미 든 줄이다).
  const counted = new Set<string>();
  for (const line of recovered) {
    const key = messageIdKey(line.id);
    if (knownIds.has(key) || counted.has(key)) continue;
    if (uuidEq(line.authorMemberId, selfMemberId)) continue;
    counted.add(key);
  }
  if (counted.size === 0) return before;
  const fresh = before.fresh + counted.size;
  return { show: fresh > 0, fresh };
}
