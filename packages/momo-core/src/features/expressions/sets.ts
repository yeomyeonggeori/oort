import type { Expression } from "./types";

// =============================================================================
// 묶음(세트)을 이름 앞머리로 나눈다 (#5453, owner 2026-11-07 · 규칙의 정본은 ADR-0218 §12 L9, 읽기만 하는 기준 핀 442b3da27).
//
// 규칙(L9): 세트의 모든 칸은 이름이 `<prefix>_<나머지>`이고, 앞머리 `prefix`는 `^[a-z0-9]{2,12}$`, 나머지는 1자 이상이며 전체는 D1의
// `[a-z0-9_-]{2,30}`이다. 서버는 세트의 공통 태그를 칸 태그 **앞에** 합친다(L9 태그) — 그래서 한 세트의 칸들은 공통 태그를 모두 가진다.
//
// 등록된 표현은 세트 소속을 따로 갖지 않는다(`approval_id`로만 추적, L9 마지막 줄). 그래서 클라이언트가 **이름으로 되짚는다**:
//   · 묶는 열쇠는 앞머리 하나다. 같은 앞머리를 둘 이상 가진 등록이 한 묶음이다(`EXPRESSION_SET_MIN_SIZE`). 하나뿐이면 묶음이 아니다.
//   · 묶음의 이름표는 묶음 안의 모든 등록이 함께 가진 첫 태그(L9의 공통 태그, 세트 이름 태그)이고, 없으면 앞머리다.
//   · 세트 제목은 카드에만 있고 등록된 표현에는 남지 않으므로(L9) 지어내지 않는다.
// 순수 모듈이다. 출처(우리 팀 · 기본)를 읽지 않는다.
// =============================================================================

/** 묶음이 되려면 같은 앞머리를 가진 등록이 이만큼은 있어야 한다. */
export const EXPRESSION_SET_MIN_SIZE = 2;

const SET_NAME = /^([a-z0-9]{2,12})_([a-z0-9_-]+)$/;

/** 이름의 세트 앞머리(L9). `<prefix>_<나머지>` 모양이 아니면 null. 앞머리는 첫 `_` 앞의 낱말이다. */
export function expressionSetPrefix(name: string): string | null {
  const match = SET_NAME.exec(name);
  return match === null ? null : match[1];
}

export interface ExpressionSetGroup<T> {
  prefix: string;
  /** 묶음 안의 모든 등록이 함께 가진 첫 태그, 없으면 앞머리. */
  label: string;
  items: T[];
}

export interface ExpressionSetGrouping<T> {
  /** 첫 등록이 나온 차례. */
  sets: ExpressionSetGroup<T>[];
  /** 묶음이 되지 못한 등록(앞머리가 없거나 혼자). 들어온 차례 그대로. */
  loose: T[];
}

function sharedTagLabel<T extends Pick<Expression, "tags">>(items: readonly T[]): string | null {
  const [first, ...rest] = items;
  if (first === undefined) return null;
  const key = (tag: string) => tag.normalize("NFC").toLowerCase();
  for (const tag of first.tags) {
    if (rest.every((item) => item.tags.some((other) => key(other) === key(tag)))) return tag;
  }
  return null;
}

/** 한 탭(또는 한 목록)의 등록을 묶음과 낱개로 나눈다. 모든 등록은 정확히 한 곳에 있다(시험이 센다). */
export function groupExpressionSets<T extends Pick<Expression, "name" | "tags">>(items: readonly T[]): ExpressionSetGrouping<T> {
  const byPrefix = new Map<string, T[]>();
  for (const item of items) {
    const prefix = expressionSetPrefix(item.name);
    if (prefix === null) continue;
    const bucket = byPrefix.get(prefix);
    if (bucket === undefined) byPrefix.set(prefix, [item]);
    else bucket.push(item);
  }
  const sets: ExpressionSetGroup<T>[] = [];
  const grouped = new Set<T>();
  for (const [prefix, members] of byPrefix) {
    if (members.length < EXPRESSION_SET_MIN_SIZE) continue;
    sets.push({ prefix, label: sharedTagLabel(members) ?? prefix, items: members });
    for (const member of members) grouped.add(member);
  }
  return { sets, loose: items.filter((item) => !grouped.has(item)) };
}
