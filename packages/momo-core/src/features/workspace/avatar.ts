import type { RosterMember } from "../../lib/api";

// =============================================================================
// 아바타의 계약 — 무엇을 그리고, 무엇으로 물러나며, 무엇을 절대 그리지 않는가
// (chat-ui-audit H-11).
//
// ## 진단이 실측한 결함 셋
//
//   1. 웹의 아바타는 `size-6`(24×24) 정사각에 이니셜 한 글자다. Slack의 36px 대비
//      너무 작아 아바타로 읽히지 않고, 캡처 `chat-light.png` 에서 워크스페이스
//      스위처의 「곽」과 메시지 아바타의 「곽」이 **같은 크기·같은 모양**으로 충돌한다.
//   2. 폰에는 아바타가 아예 없다.
//   3. 작성자를 명부에서 못 찾으면 이니셜이 **uuid 첫 글자**가 된다
//      (`MessageRow.tsx:184`, `name.slice(0,1)` 에 uuid 앞 8자가 들어간다).
//   4. 그리고 **실제 이미지 경로 자체가 없다**: `RosterMember.avatarUrl` 은 타입에
//      선언돼 있으나 소비처 0, `<img>` 0.
//
// 3·4가 이 파일이 있는 이유다. 크기와 모양은 화면의 것이지만, **무엇을 이니셜로
// 삼는가**와 **어떤 주소를 이미지로 믿는가**는 판정이고, 두 클라가 각자 답하면
// 각자 다르게 틀린다 — 특히 4는 틀리는 방식이 조용하다.
//
// ## `avatarUrl` 을 그대로 믿지 않는 이유 (CSP)
//
// 이 제품의 배포 헤더는 `img-src 'self' data:` 다(`infra/prod/Caddyfile`,
// `clients/desktop/src-tauri/tauri.conf.json` 둘 다 같은 값). 즉 **다른 오리진의
// 이미지는 브라우저가 거절한다.** 거절은 조용하다: `<img>` 는 깨진 상자가 되고,
// 콘솔에만 위반이 찍히며, 사람은 「아바타가 없는 사람」과 「아바타가 막힌 사람」을
// 구별할 수 없다.
//
// 그래서 여기서 **먼저 판정한다**: 실을 수 없는 주소는 애초에 이미지가 아니고,
// 그 자리는 이니셜이 선다. 이니셜은 언제나 성립하는 폴백이므로 화면은 어느 경우에도
// 빈칸을 그리지 않는다.
//
// CSP를 넓히는 것은 이 배치의 결정이 아니다 — 배포 헤더 변경은 경계 변경이고
// Accepted ADR 없이 머지되지 않는다(ADR-0100). 그때까지 이 함수가 참인 것만 통과
// 시킨다. 서버가 자기 오리진으로 아바타를 서빙하기 시작하면 이 함수는 그날 아무
// 변경 없이 그 주소를 통과시킨다.
// =============================================================================

/** 아바타가 누구의 것인가. 색과 모양이 이 값에 따라 갈린다. */
export type AvatarKind = "human" | "agent" | "unknown";

/**
 * 이미지가 없을 때 서는 것.
 *
 * `unknown` 이 별도 갈래인 것이 H-11 3번의 수리다. 「모른다」를 이니셜로 흉내 내면
 * uuid의 첫 글자가 사람 이름의 첫 글자처럼 그려지고, 읽는 사람은 그것을 이름으로
 * 읽는다 — 화면이 모르는 것을 아는 척한다. 모를 때는 이니셜을 그리지 않는다.
 */
export type AvatarFallback =
  | { kind: "initial"; text: string }
  | { kind: "unknown" };

export interface AvatarIdentity {
  kind: AvatarKind;
  /** 실을 수 있는 이미지 주소. 없거나 실을 수 없으면 `null`. */
  imageUrl: string | null;
  fallback: AvatarFallback;
}

/**
 * 이 주소를 `<img src>` 로 실을 수 있는가 — `img-src 'self' data:` 아래에서.
 *
 * 통과시키는 것:
 *   * 같은 오리진의 **경로**(`/media/...`) — 상대 경로는 정의상 `'self'` 다.
 *   * `data:image/...` — 헤더가 명시적으로 허용한다.
 *
 * 막는 것과 그 이유:
 *   * 다른 오리진의 절대 주소(`https://cdn.example/...`) — CSP가 거절한다.
 *   * 프로토콜 상대 주소(`//cdn.example/...`) — 오리진이 주소에 없으므로 통과처럼
 *     보이지만 실제로는 다른 오리진이다. 이 한 줄이 없으면 `startsWith("/")` 검사가
 *     그것을 같은 오리진으로 읽는다.
 *   * `javascript:` · `blob:` · 그 외 스킴 — 이미지가 아니거나, 이미지라도 이
 *     헤더가 허용하지 않는다.
 *
 * @param origin 이 클라가 서 있는 오리진. 없으면(폰처럼 오리진 개념이 없는 호스트)
 *   절대 주소는 전부 막힌다 — 모르면 안 여는 쪽이 이 파일의 규율이다.
 */
export function renderableAvatarUrl(
  avatarUrl: string | null | undefined,
  origin?: string | null
): string | null {
  const raw = avatarUrl?.trim();
  if (!raw) return null;
  if (raw.startsWith("//")) return null;
  if (raw.startsWith("/")) return raw;
  const lower = raw.toLowerCase();
  if (lower.startsWith("data:image/")) return raw;
  if (!origin) return null;
  // 절대 주소는 오리진이 정확히 같을 때만. 문자열 비교가 아니라 접두 비교인 이유는
  // `https://app.momo.dev.evil.com` 같은 주소가 `https://app.momo.dev` 로 시작하기
  // 때문이다 — 경계 문자까지 봐야 같은 오리진이다.
  const normalized = origin.replace(/\/+$/, "");
  if (raw === normalized) return raw;
  return raw.startsWith(`${normalized}/`) ? raw : null;
}

/**
 * 이니셜 한 글자.
 *
 * 자소가 아니라 **코드포인트**로 자른다: `slice(0, 1)` 은 서로게이트 쌍을 반으로
 * 갈라(이모지 이름, 일부 한자) 렌더할 수 없는 반쪽 글자를 남긴다.
 *
 * 빈 문자열이거나 글자가 아닌 것으로 시작하면 `null` — 「모른다」로 넘어간다.
 * 이니셜이 될 수 없는 것을 이니셜인 척 그리지 않는다.
 */
export function avatarInitial(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const first = [...trimmed][0];
  if (first === undefined) return null;
  // 숫자·기호로 시작하는 「이름」은 대개 이름이 아니라 id다(H-11 3번의 uuid가
  // 정확히 그 경우다: `0199dddd…` → `0`). 문자로 시작할 때만 이니셜로 친다.
  if (!/\p{L}/u.test(first)) return null;
  return first.toLocaleUpperCase();
}

/**
 * 한 멤버의 아바타 계약. 화면은 이 결과를 **그리기만** 한다.
 *
 * `member` 가 `null` 인 것은 「명부에 없다」이고, 그것은 `unknown` 이다 — 그 자리에
 * uuid 조각을 넣어 이니셜을 만들지 않는다(H-11 3번).
 */
export function avatarIdentity(
  member: RosterMember | null | undefined,
  origin?: string | null
): AvatarIdentity {
  if (!member) {
    return { kind: "unknown", imageUrl: null, fallback: { kind: "unknown" } };
  }
  const initial = avatarInitial(member.displayName);
  return {
    kind: member.kind === "agent" ? "agent" : "human",
    imageUrl: renderableAvatarUrl(member.avatarUrl, origin),
    fallback:
      initial === null
        ? { kind: "unknown" }
        : { kind: "initial", text: initial },
  };
}

/**
 * 아바타의 지름. **두 클라가 공유하는 밀도 독립 단위**(CSP px = RN pt).
 *
 * 진단 H-11 1번이 든 근거가 이 숫자의 전부다: 24px 정사각 이니셜은 아바타로 읽히지
 * 않고 워크스페이스 스위처의 같은 글자와 충돌한다. Slack이 36px을 쓰고, 이 앱의
 * 행 밀도는 그보다 촘촘하므로 그 사이를 고른다.
 *
 * 32는 이 레포의 간격 표에 있는 값이다(`--spacing-8`). 격자 밖 숫자를 새로 들이지
 * 않는 것이 웹에서 그 값이 **실제로 컴파일되는** 유일한 길이다(U4-4R W-1).
 */
export const AVATAR_SIZE = 32;

/**
 * 아바타의 **모양** — 사람과 에이전트를 색 말고 하나 더로 가른다.
 *
 * 색만으로 가르면 두 가지가 깨진다: 색각 이상이 있는 사람에게는 구분이 없고, 두
 * 스킴에서 같은 대비가 유지된다는 보장도 없다. 그래서 정체는 색(`--agent`)과
 * 모양 **둘로** 나른다.
 *
 * 방향이 이쪽인 이유: 원은 사진이 들어갈 자리의 관례이고 사람에게는 사진이 있다.
 * 에이전트에게는 사진이 없고 앞으로도 「얼굴」이 아니라 표식이므로 둥근 사각이다.
 *
 * `unknown` 은 사람 쪽 모양을 빌리되 **정체 색을 쓰지 않는다.** 모양은 색보다
 * 약한 주장이라(대부분의 미해결 작성자는 사람이다) 빌려도 거짓이 되지 않지만,
 * 색까지 주면 화면이 「이 사람은 사람이다」를 확인된 사실처럼 말하게 된다.
 */
export const AVATAR_SHAPE = {
  human: "round",
  agent: "rounded-square",
  unknown: "round",
} as const satisfies Record<AvatarKind, string>;

/** 아바타가 **정체 색**을 지는가. 모르는 것은 색을 갖지 않는다. */
export function avatarCarriesIdentityColor(kind: AvatarKind): boolean {
  return kind !== "unknown";
}
