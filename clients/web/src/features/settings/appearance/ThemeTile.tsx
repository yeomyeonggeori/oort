import { useLayoutEffect, useMemo, useRef } from "react";
import type { SignalChoice } from "@momo/core/design/appearance";
import type { GalleryTile } from "@momo/core/design/themeGallery";
import type { Mode } from "@momo/core/design/themes";
import { cn } from "@/design/lib/cn";
import { paintFor } from "@/design/themes/derived";
import { paintElement } from "@/design/themes/paint";
import { PreviewLayer } from "../shell/ThemePreviewCard";
import { tileTestId } from "./tileIds";

// 테마 타일 (AP-1b #4188, 청사진 §5.3-c). Buzz의 SVG 썸네일(`ThemePreviewFrame.tsx`)은 ADR-0172가 새 `<svg>`를
// 막아 **div와 토큰으로 다시 그렸다**: 기존 미리보기 카드의 한 층(바닥 + 목록 열 + 본문 판 + 신호 알약 + 에이전트 점)을
// 요소마다 변수 열셋을 꽂아 자기 테마의 색으로 칠한다. 첫 파티와 카탈로그가 같은 길이다.
//
// 라디오 그룹의 한 칸이다: 보이지 않는 `input[type=radio]` + 라벨 타일(`accent-swatch` 전례). 그룹은 탭 정지점이
// 하나이고 방향키가 칸을 옮긴다. 고른 칸은 잉크 링과 굵은 이름이 말한다(색만으로 말하지 않는다).
// 타일 안 신호 알약은 그 테마·모드에 사람이 고른 강조색을 올린 색이다(거절되면 그 테마의 기본 신호).

export type TileFaceKind = "split" | Mode;

/** 미리보기 한 장: `split`이면 라이트 층 위에 다크 층을 대각선으로 반만 겹치고, 아니면 그 모드 한 층이다. */
export function TileFace({
  themeRef,
  kind,
  signal,
  className,
}: {
  themeRef: GalleryTile["ref"];
  kind: TileFaceKind;
  signal: SignalChoice;
  className?: string;
}) {
  const modes: readonly Mode[] = kind === "split" ? ["light", "dark"] : [kind];
  return (
    <span aria-hidden="true" className={cn("theme-preview", className)} data-tile-kind={kind}>
      {modes.map((mode, index) => (
        <PaintedLayer
          key={mode}
          themeRef={themeRef}
          mode={mode}
          signal={signal}
          split={kind === "split" && index === 1}
        />
      ))}
    </span>
  );
}

function PaintedLayer({
  themeRef,
  mode,
  signal,
  split,
}: {
  themeRef: GalleryTile["ref"];
  mode: Mode;
  signal: SignalChoice;
  split: boolean;
}) {
  const paint = useMemo(() => paintFor(themeRef, mode, signal), [themeRef, mode, signal]);
  const node = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (node.current && paint) paintElement(node.current, paint);
  }, [paint]);
  // 변수는 층을 감싼 요소에 꽂는다(`display: contents`라 격자 배치를 건드리지 않고, 변수는 자손으로 물려 내려간다).
  return (
    <span ref={node} className="theme-tile-paint">
      <PreviewLayer mode={mode} split={split} />
    </span>
  );
}

export function ThemeTile({
  tile,
  selected,
  signal,
  name,
  onSelect,
}: {
  tile: GalleryTile;
  selected: boolean;
  signal: SignalChoice;
  /** 라디오 그룹 이름. */
  name: string;
  onSelect: (tile: GalleryTile) => void;
}) {
  return (
    <label
      className="theme-tile"
      data-selected={selected ? "" : undefined}
      data-testid={tileTestId(tile.ref)}
    >
      <input
        type="radio"
        name={name}
        value={tile.ref}
        checked={selected}
        onChange={() => onSelect(tile)}
        className="sr-only"
      />
      <TileFace themeRef={tile.ref} kind={tile.kind} signal={signal} className="theme-tile-frame" />
      <span className="theme-tile-name">{tile.label}</span>
    </label>
  );
}
