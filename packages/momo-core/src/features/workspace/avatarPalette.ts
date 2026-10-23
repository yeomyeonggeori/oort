// =============================================================================
// 아바타 배경 팔레트와 글자 잉크 (#4261). **이 파일이 아바타 편집기의 색 원천이다.**
//
// 이모지·코메토 아바타는 클라이언트가 한 번 그려 올린 PNG이고, 그 PNG는 라이트·다크 어느 바탕에
// 서도 같은 그림으로 남는다. (이름의 첫 글자는 굽지 않는다: 이름을 바꾸면 굽은 글자가 낡는다. 기본 이니셜은
// 늘 토큰 쌍 `--avatar-N` 대 `--avatar-N-soft` 로 그려지고 그 대비는 `tokens.contrast.test.ts` 가 잰다.) 그래서 여기 색은 `light-dark()` 토큰이 아니라 **테마와 무관한 고정
// 값**이다(`--avatar-N-soft` 같은 토큰은 모드마다 값이 달라서 구워 넣을 수 없다). 웹 컴포넌트는
// 색 리터럴을 못 쓰므로(`design_preflight_web.sh` raw_color) 이 표가 유일한 자리이고, 웹은 칩을
// 마운트할 때 CSS 변수로 넘겨 칠한다(`WallpaperRow` 와 같은 길). 폰도 같은 표를 읽는다.
//
// 열다섯 색은 두 단이다.
//   light  명도가 높은 파스텔. 어둡거나 진한 글리프(🖤, 진한 색 이모지)가 선다.
//   deep   명도가 낮은 진색. 밝은 글리프(노란 얼굴, 🔥, 🌕, 하얀 코메토 림)가 선다.
// 두 단이 모두 있는 이유는 실측이다(2026-10-23, 자주 쓰는 이모지 74종 × Chromium·WebKit, 면적의
// 절반 이상이 3:1을 넘는 기준): 60종은 deep 단에서만, 7종은 light 단에서만, 7종은 둘 다에서 서고
// 어느 단에도 못 서는 이모지는 없었다. 한 단만 두면 그 갈래의 이모지는 고를 수 있는 색이 0이 된다.
// 코메토는 후드·림이 밝아서 deep 단에서만 선다(light 단 여덟 색에서는 면적의 24~25%만 보인다).
//
// 이 표의 어떤 색도 모든 글리프에 통과하지는 않는다. 통과 여부는 색이 아니라 **(글리프, 배경)
// 쌍**의 판정이다(`avatarContrast.ts`). 여기는 후보를 정할 뿐이고 안전장치가 아니다.
//
// raw_color 예외: `scripts/design_preflight_core.mjs` 의 `AVATAR_PALETTE_FILES` 가 이 파일 이름을
// 닫힌 목록으로 든다. 같은 폴더의 다른 파일은 계속 색 글자를 못 적는다.
// =============================================================================

export const AVATAR_BACKGROUND_IDS = [
  "butter",
  "apricot",
  "rose",
  "lilac",
  "sky",
  "aqua",
  "mint",
  "sand",
  "navy",
  "plum",
  "wine",
  "clay",
  "forest",
  "teal",
  "slate",
] as const;

export type AvatarBackgroundId = (typeof AVATAR_BACKGROUND_IDS)[number];

export type AvatarBackgroundTier = "light" | "deep";

export interface AvatarBackground {
  readonly id: AvatarBackgroundId;
  /** 보조기술이 읽는 색 이름. 화면에 글자로 그리지는 않는다(칩이 색 자체다). */
  readonly label: string;
  /** 소문자 `#rrggbb`. */
  readonly hex: string;
  readonly tier: AvatarBackgroundTier;
}

/** 순서가 화면의 순서다: 연한 여덟, 진한 일곱. 한 줄이 여덟 칸이라 두 줄(여덟 + 일곱 + 자유 색)이 된다. */
export const AVATAR_BACKGROUNDS: readonly AvatarBackground[] = [
  { id: "butter", label: "버터", hex: "#f7e8af", tier: "light" },
  { id: "apricot", label: "살구", hex: "#ffd0ab", tier: "light" },
  { id: "rose", label: "장미", hex: "#ffc2c5", tier: "light" },
  { id: "lilac", label: "연보라", hex: "#dbc7f4", tier: "light" },
  { id: "sky", label: "하늘", hex: "#b4defc", tier: "light" },
  { id: "aqua", label: "물빛", hex: "#ade8e7", tier: "light" },
  { id: "mint", label: "박하", hex: "#b7edc9", tier: "light" },
  { id: "sand", label: "모래", hex: "#e1d6c6", tier: "light" },
  // 코메토 K6 배지 원판의 남색(`docs/brand/kometto/faces/expressions.md` 4절 `#222840`).
  { id: "navy", label: "남색", hex: "#222840", tier: "deep" },
  { id: "plum", label: "자두", hex: "#5f2a5e", tier: "deep" },
  { id: "wine", label: "포도주", hex: "#792637", tier: "deep" },
  { id: "clay", label: "점토", hex: "#934d2c", tier: "deep" },
  { id: "forest", label: "숲", hex: "#175533", tier: "deep" },
  { id: "teal", label: "청록", hex: "#066166", tier: "deep" },
  { id: "slate", label: "석판", hex: "#4e5c6f", tier: "deep" },
];

/** 코메토 프리셋의 처음 바탕: 원본 배지와 같은 남색이라 처음 보이는 모습이 정본이다. */
export const DEFAULT_PRESET_BACKGROUND: AvatarBackgroundId = "navy";

/**
 * 이모지의 처음 바탕. 진한 단에서 서는 이모지가 열에 여섯이라(실측 74종 중 67종) 남색에서 시작하면 처음 고른 이모지가
 * 바탕을 옮겨야 하는 일이 드물다. 연한 단에서만 서는 이모지(🖤 같은 어두운 그림)는 고르는 순간 편집기가 첫 통과 색으로 옮긴다.
 */
export const DEFAULT_EMOJI_BACKGROUND: AvatarBackgroundId = "navy";

/** 팔레트 칸의 색(소문자 `#rrggbb`). id 는 닫힌 목록이라 늘 있다. */
export function avatarBackgroundHex(id: AvatarBackgroundId): string {
  return AVATAR_BACKGROUNDS.find((entry) => entry.id === id)?.hex ?? AVATAR_BACKGROUNDS[0].hex;
}

export function avatarBackgroundById(id: string): AvatarBackground | undefined {
  return AVATAR_BACKGROUNDS.find((entry) => entry.id === id);
}

/** 이 색이 팔레트의 칸인가(대소문자 무관). 자유 색은 `undefined` 라 팔레트 칩이 아니라 「자유」 칩이 켜진다. */
export function avatarBackgroundByHex(hex: string): AvatarBackground | undefined {
  const lower = hex.trim().toLowerCase();
  return AVATAR_BACKGROUNDS.find((entry) => entry.hex === lower);
}
