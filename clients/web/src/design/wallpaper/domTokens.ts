import type { Mode } from "@momo/core/design/themes";
import type { WallpaperFittedRole, WallpaperTokens } from "@momo/core/design/wallpaper";

// =============================================================================
// 지금 화면에 칠해진 색을 읽는다 (ADR-0189 증보 3 D2·D4, AP-4 #4191).
//
// 배경화면의 산수는 「이 테마의 바닥색·잉크·역할」이 필요하다. 첫 파티 3종은 core 표에 있지만, 카탈로그·사용자
// 테마(AP-1b·AP-5)는 런타임에 파생해 루트 변수로 꽂는다. 어느 쪽이든 **루트에 칠해진 변수가 그 순간의
// 사실**이므로, 산수는 표가 아니라 그 변수를 읽는다. 그러면 신호 프리셋·직접 고른 색(`--signal*`)과 파생
// 테마도 별도 연결 없이 따라온다.
//
// 읽을 수 있는 모양은 부트 캐시 계약과 같다(AP-1a #4186): 색 하나(`#rrggbb`) 또는 `light-dark(색, 색)`.
// 그 밖의 모양(이름 색, 함수형 색)은 읽지 못한 것으로 보고 `null`을 돌려준다. 산수가 틀린 색으로 대비를 보장하는
// 척하는 것보다 배경화면을 쓰지 않는 쪽이 정직하다(호출부가 「읽지 못했어요」를 말한다).
//
// 순수 함수다. `getComputedStyle(root).getPropertyValue`는 호출부가 읽어서 넘긴다.
// =============================================================================

const HEX = "#[0-9a-fA-F]{6}";
const SINGLE_RE = new RegExp(`^(${HEX})$`);
const PAIR_RE = new RegExp(`^light-dark\\(\\s*(${HEX})\\s*,\\s*(${HEX})\\s*\\)$`);

/** 변수 하나의 값을 [라이트, 다크]로. 읽을 수 없는 모양이면 `null`. */
export function parseColorPair(value: string): readonly [string, string] | null {
  const text = value.trim();
  const single = SINGLE_RE.exec(text);
  if (single) return [single[1], single[1]];
  const pair = PAIR_RE.exec(text);
  return pair ? [pair[1], pair[2]] : null;
}

const ROLE_VARS: Readonly<Record<WallpaperFittedRole, string>> = {
  "ink-muted": "--ink-muted",
  "signal-text": "--signal-text",
  agent: "--agent",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  icon: "--icon",
  signal: "--signal",
};

export interface DomTokens {
  /** 모드마다 산수의 입력. 읽은 변수가 두 모드를 다 가지므로 보통 둘 다 있다. */
  byMode: Readonly<Record<Mode, WallpaperTokens>>;
  /** 이 테마의 사이드바에 띠(`--band`)가 있는가. 띠는 불투명하게 위에 서서 사진을 가린다. */
  hasBand: boolean;
}

export function readDomTokens(read: (name: string) => string): DomTokens | null {
  const need = (name: string): readonly [string, string] | null => parseColorPair(read(name));
  const canvas = need("--canvas-mid");
  const ink = need("--ink");
  const onPrimary = need("--on-primary");
  const onSignal = need("--on-signal");
  if (!canvas || !ink || !onPrimary || !onSignal) return null;
  const roles: Partial<Record<WallpaperFittedRole, readonly [string, string]>> = {};
  for (const [role, name] of Object.entries(ROLE_VARS) as [WallpaperFittedRole, string][]) {
    const pair = need(name);
    if (!pair) return null;
    roles[role] = pair;
  }
  const at = (index: 0 | 1): WallpaperTokens => ({
    canvas: canvas[index],
    ink: ink[index],
    onPrimary: onPrimary[index],
    onSignal: onSignal[index],
    roles: Object.fromEntries(
      (Object.keys(ROLE_VARS) as WallpaperFittedRole[]).map((role) => [role, roles[role]![index]])
    ) as Record<WallpaperFittedRole, string>,
  });
  return {
    byMode: { light: at(0), dark: at(1) },
    hasBand: read("--band").trim() !== "",
  };
}
