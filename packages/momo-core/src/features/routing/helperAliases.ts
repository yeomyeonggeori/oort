// =============================================================================
// 도우미를 부르는 다른 이름 — 별칭 `@oort`·`@오르트`·`@claude` (ADR-0201 증보 v2 H2, #3893).
//
// 서버 쪽 계약 (S1, 이 PR이 먼저 정하고 엔진 슬라이스가 맞춘다):
//   - 로스터 행(`GET …/roster`)의 에이전트에 `aliases: string[]`가 실린다. 값은 서버가
//     **등록한** 별칭뿐이다(H2-3: 실제 멤버의 핸들과 겹치면 등록하지 않고, 나중에 겹치면
//     지운다). 그래서 이 배열에 있는 이름은 지금 그 멤버를 부른다.
//   - 옛 서버는 칸을 보내지 않는다. 그러면 이 파일의 모든 함수는 핸들만 본다(화면 변화 0).
//
// 화면이 지키는 것:
//   1. **삽입은 이 클라이언트가 다시 읽을 수 있는 글자만.** 멘션 문법(`mentionSyntax`)은
//      `[A-Za-z0-9_.-]`이라 `@오르트`는 토큰이 되지 않는다. 그래서 `오르`를 쳐도 후보는
//      뜨지만 넣는 글자는 ASCII 별칭(`@oort`), 없으면 핸들이다. 문법을 한글로 넓히는 일은
//      `@hermes에게` 같은 조사 붙임을 깨므로 이 PR이 하지 않는다(손으로 친 `@오르트`는
//      서버가 부르지만 화면에서 멘션 색이 안 입는다: PR 본문의 한계 항목).
//   2. 별칭은 표시만 거들고 신원을 바꾸지 않는다. 신원은 언제나 멤버 id와 핸들이다.
//
// 순수 모듈이다. 웹과 폰이 같은 함수를 부른다.
// =============================================================================

import type { RosterMember } from "../../lib/api";

/** H2-1: 핸들 글자(`[a-z0-9_-]`) 또는 한글 음절, 2~16자. */
const ALIAS_PATTERN = /^[a-z0-9_\-가-힣]{2,16}$/u;

/** 멘션 문법이 다시 읽을 수 있는 별칭(ASCII). `mentionSyntax`의 글자 집합 안이다. */
const ASCII_ALIAS = /^[a-z0-9_-]{2,16}$/;

/** 한 멤버가 들 수 있는 별칭 수의 상한. v2는 셋으로 고정이다(H2-2). 넘치는 것은 버린다. */
export const MAX_MEMBER_ALIASES = 8;

/** `alias_norm = lower(NFC(alias))` (H2-1). */
export function normalizeAlias(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

/**
 * 와이어의 `aliases`를 읽는다. 총 파싱: 배열이 아니면 null, 문법 밖 값은 버린다.
 * 남는 것이 없으면 null(칸 없음과 같다).
 */
export function parseAliases(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const alias = normalizeAlias(item);
    if (!ALIAS_PATTERN.test(alias) || seen.has(alias)) continue;
    seen.add(alias);
    out.push(alias);
    if (out.length >= MAX_MEMBER_ALIASES) break;
  }
  return out.length > 0 ? out : null;
}

/** 이 멤버의 별칭. 에이전트·활성 멤버만이다. 칸이 없으면 빈 목록. */
export function memberAliases(
  member: Pick<RosterMember, "kind" | "status" | "aliases">
): readonly string[] {
  if (member.kind !== "agent" || member.status !== "active") return [];
  return member.aliases ?? [];
}

/** 멘션 문법이 다시 읽을 수 있는 별칭만. */
export function asciiAliases(
  member: Pick<RosterMember, "kind" | "status" | "aliases">
): string[] {
  return memberAliases(member).filter((alias) => ASCII_ALIAS.test(alias));
}

/**
 * 이 멤버를 부를 때 컴포저에 넣을 이름(`@` 없이). ASCII 별칭이 있으면 첫 것, 없으면 핸들.
 * 서버가 별칭을 보내지 않으면 언제나 핸들이다.
 */
export function preferredMentionName(
  member: Pick<RosterMember, "kind" | "status" | "aliases" | "handle">
): string {
  return asciiAliases(member)[0] ?? member.handle;
}

/** 질의(이미 소문자·NFC)가 맞춘 별칭. 빈 질의는 별칭을 맞추지 않는다. */
export function matchedAlias(
  member: Pick<RosterMember, "kind" | "status" | "aliases">,
  needle: string
): string | null {
  const query = normalizeAlias(needle);
  if (query === "") return null;
  return memberAliases(member).find((alias) => alias.includes(query)) ?? null;
}

/**
 * 타임라인이 멘션 색을 입힐 이름들: 활성 멤버의 핸들 + ASCII 별칭. 한글 별칭은 문법이
 * 읽지 못하므로 넣지 않는다(넣어도 쓰이지 않는다).
 */
export function mentionableNames(members: readonly RosterMember[]): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    if (member.status !== "active") continue;
    names.add(member.handle.toLowerCase());
    for (const alias of asciiAliases(member)) names.add(alias);
  }
  return names;
}

/**
 * 후보 줄 오른쪽 흐린 자리. 별칭이 있으면 「oort 도우미 · @오르트」처럼 이름 뒤에 별칭을
 * 붙인다(H2-8 보조 줄). 맞춘 별칭이 있으면 그것을, 없으면 넣을 이름이 아닌 첫 별칭을 보인다.
 */
export function aliasHint(
  member: Pick<RosterMember, "kind" | "status" | "aliases" | "handle" | "displayName">,
  needle: string
): string {
  const aliases = memberAliases(member);
  if (aliases.length === 0) return member.displayName;
  const inserted = preferredMentionName(member);
  const matched = matchedAlias(member, needle);
  const shown =
    matched !== null && matched !== inserted
      ? matched
      : (aliases.find((alias) => alias !== inserted) ?? null);
  return shown === null
    ? member.displayName
    : `${member.displayName} · @${shown}`;
}

/**
 * 폰 후보 줄의 핸들 칸. 넣을 이름(`@oort`)이 먼저이고, 질의가 다른 별칭을 맞췄으면 그것을
 * 덧붙인다(`@oort · @오르트`). 왜 이 줄이 떴는지 친 글자로 답한다. 별칭이 없으면 `@핸들`.
 */
export function mentionHandleLabel(
  member: Pick<RosterMember, "kind" | "status" | "aliases" | "handle">,
  needle: string
): string {
  const inserted = preferredMentionName(member);
  const matched = matchedAlias(member, needle);
  return matched !== null && matched !== inserted
    ? `@${inserted} · @${matched}`
    : `@${inserted}`;
}
