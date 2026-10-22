// =============================================================================
// 신호 프리셋 id (ADR-0189 D3). 보정 엔진(`signal.ts`)과 따로 둔 이유: 외양 레코드(`appearance.ts`)와 루트 스탬프
// (`rootStamp.ts`)는 웹 메인 번들에 실리고 id 목록만 알면 된다. 같은 파일에 엔진(`resolveSignal`, OKLab 산수)이
// 있으면 쓰지 않는 메인 번들에도 gzip 1.3KB 가까이 끌려온다(AP-1b #4188 번들 예산: 메인 청크 증가 ≤ 2KB).
// 엔진을 쓰는 곳(갤러리·강조색 칩·파생 엔진, 폰)은 `signal.ts`를 그대로 가져온다.
// =============================================================================

/** ADR-0174 액센트에서 옮긴 네 프리셋(표 §4). `dawn`은 옮기지 않는다. */
export const SIGNAL_PRESET_IDS = ["seongun", "hongyeom", "hyeseong", "gamram"] as const;
export type SignalPresetId = (typeof SIGNAL_PRESET_IDS)[number];

export function isSignalPresetId(value: unknown): value is SignalPresetId {
  return typeof value === "string" && (SIGNAL_PRESET_IDS as readonly string[]).includes(value);
}
