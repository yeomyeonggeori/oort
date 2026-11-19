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
// 글자 없는 미니어처(`PreviewLayer bare`, #5783)로 그리고, 요소마다 변수 열셋을 꽂아 자기 테마의 색으로 칠한다. 첫 파티와
// 카탈로그가 같은 길이다.
//
// 라디오 그룹의 한 칸이다: 보이지 않는 `input[type=radio]`가 라벨 타일 전체를 덮는다(`radio-cover`, #5783: 초점 든 상자가 곧
// 타일이라 Tab으로 닿을 때 브라우저가 격자와 페이지를 따라 움직인다. `accent-swatch` 전례). 방향키는 그것만으로 모자란다: WebKit
// (데스크탑 앱의 WKWebView)은 방향키로 **일부만 보이는** 줄에 들어갈 때 따라오지 않아 고른 카드가 잘린 채 남는다(검수 r4 B-1d).
// 그래서 사람이 고른 순간(라디오의 change: 누름·방향키)에만 고른 카드를 가장 가까운 자리로 데려온다(`followPick`). 초점·마운트·
// 테마가 바뀐 효과에는 걸지 않는다: 거기에 단 손작업이 Tab 도착·색 모드로 돌아온 초점·처음 열 때를 깼다(검수 r2·r3). 그룹은 탭 정지점이
// 하나이고 방향키가 칸을 옮긴다. 고른 칸은 잉크 링과 잉크색 이름이 말한다(색만으로 말하지 않는다). 키보드 초점 링은
// 집 규칙의 인셋 링이고 라디오가 `peer`라서 마우스로 누른 뒤에는 전역 규칙이 걷는다(theme-gallery.css).
// 타일 안 신호 알약은 그 테마·모드에 사람이 고른 강조색을 올린 색이다(거절되면 그 테마의 기본 신호).

type TileFaceKind = "split" | Mode;

/** 타일의 미리보기 한 장: `split`이면 라이트 층 위에 다크 층을 대각선으로 반만 겹치고, 아니면 그 모드 한 층이다. */
function TileFace({
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
  // 타일 안은 글자 없는 미니어처다(#5783): 글자는 타일 아래 이름 한 줄뿐이다.
  return (
    <span ref={node} className="theme-tile-paint">
      <PreviewLayer mode={mode} split={split} bare />
    </span>
  );
}

/**
 * 사람이 고른 카드를 가장 가까운 자리로 데려온다(이미 온전히 보이면 아무것도 움직이지 않는다). 격자 안쪽과 바깥 페이지 가운데 모자란
 * 쪽만 움직이고, 격자 위아래 페이드 구간(`scroll-padding-block` 12)에 걸린 카드는 그 밖으로 12px 안에서 옮긴다(이름이 흐리지 않게).
 * 고르는 것은 타일의 크기·자리를 바꾸지 않아서(고름은 링과
 * 이름 색, 갤러리에서 고른 테마는 늘 지금 색 모드를 가져 안내 줄이 서지 않는다) 고른 결과를 그리기 전에 재도 같다. 부드러운 스크롤은
 * 쓰지 않는다(`behavior` 기본값, 이 화면의 스크롤 상자에는 `scroll-behavior: smooth`가 없다): 줄인 움직임 설정에서도 같다.
 */
function followPick(card: HTMLElement | null): void {
  card?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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
      className="theme-tile radio-cover press"
      data-selected={selected ? "" : undefined}
      data-testid={tileTestId(tile.ref)}
    >
      <input
        type="radio"
        name={name}
        value={tile.ref}
        checked={selected}
        onChange={(event) => {
          onSelect(tile);
          followPick(event.currentTarget.closest("label"));
        }}
        className="peer"
      />
      <TileFace themeRef={tile.ref} kind={tile.kind} signal={signal} className="theme-tile-frame" />
      <span className="theme-tile-name">{tile.label}</span>
    </label>
  );
}
