import type { AvatarKind } from "@momo/core/features/workspace/avatar";

// 기본 아바타(사진이 없을 때)의 채움·테두리 문법 (#4148). 사이드바 DM·목록·타임라인의 세 아바타가 같은 함수를 쓴다.
//
// 성재(2026-10-20): 「원형 구분같은게 전혀없으니까 기본 프로필은 구분이 잘 안돼.」 바탕과 거의 같은 채움(`--surface-hover`)에
// 테두리가 없어 원이 보이지 않았다. 지금은 모든 아바타가 얇은 `--line` 테두리를 두르고(밝은 사진도 바탕에 녹지 않는다),
// 사람은 멤버 id 가 고르는 여섯 색조 중 하나로 채워 서로 구분된다. 색은 디자인 토큰(`--avatar-N`)이고 손기입이 없다.
//
// 모양이 정체를 나르는 규칙은 그대로다(`MessageRow` 의 `AVATAR_SHAPE` 문단): 사람은 원, 에이전트는 둥근 사각 + agent 토큰,
// 「없는 사람」(unknown)은 점선 테두리 원 + 흐린 글자 - 색각 이상이 있어도 모양과 선으로 읽힌다.

/** 정적 문자열이어야 Tailwind 가 클래스를 찾는다. 색조 수(6)는 `tokens.css` 의 `--avatar-1..6` 과 같다. */
export const HUMAN_TONE_CLASSES = [
  "bg-avatar-1-soft text-avatar-1",
  "bg-avatar-2-soft text-avatar-2",
  "bg-avatar-3-soft text-avatar-3",
  "bg-avatar-4-soft text-avatar-4",
  "bg-avatar-5-soft text-avatar-5",
  "bg-avatar-6-soft text-avatar-6",
] as const;

/** 멤버 id → 0..5. FNV-1a 32비트: 같은 id 는 언제나 같은 색조이고, 화면·세션·기기에 상관없다. */
export function avatarToneIndex(memberId: string | null | undefined): number {
  const id = (memberId ?? "").toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % HUMAN_TONE_CLASSES.length;
}

/**
 * 아바타 상자의 테두리·채움·글자 클래스. 모양(원/둥근 사각)과 크기는 호출한 쪽이 정한다.
 * 사진이 있어도 같은 테두리를 쓴다: 채움은 사진 뒤에 가려지고 테두리가 윤곽을 지킨다.
 */
export function avatarSurfaceClass(
  kind: AvatarKind,
  memberId: string | null | undefined,
  hasPhoto = false
): string {
  // 사진이 서면 테두리가 윤곽을 맡는다: 거의 흰 사진이 라이트 바탕에 녹지 않게 `--line` 대신 한 단 짙은 `--avatar-edge` (#4162).
  const edge = hasPhoto ? "border border-avatar-edge" : "border border-line";
  if (kind === "agent") return `${edge} bg-agent-soft text-agent`;
  if (kind === "unknown") {
    return hasPhoto
      ? "border border-avatar-edge bg-transparent text-ink-muted"
      : "border border-dashed border-line-strong bg-transparent text-ink-muted";
  }
  return `${edge} ${HUMAN_TONE_CLASSES[avatarToneIndex(memberId)]}`;
}

/** 채움·글자만(테두리 없음): 프로필 히어로처럼 자기 테두리·그림자를 따로 두르는 큰 상자용. */
export function avatarFillClass(memberId: string | null | undefined): string {
  return HUMAN_TONE_CLASSES[avatarToneIndex(memberId)];
}
