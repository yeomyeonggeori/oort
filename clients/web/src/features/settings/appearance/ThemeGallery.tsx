import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { SchemeChoice } from "@momo/core/design/appearance";
import {
  galleryTiles,
  pickNotice,
  schemeForThemePick,
  themeLabel,
  type GalleryTile,
} from "@momo/core/design/themeGallery";
import { effectiveScheme, modesOf } from "@momo/core/design/themeResolve";
import { updateAppearance, useAppearance } from "@/design/theme";
import { SettingsRow } from "../shell/SettingsRow";
import { ROW_DESCRIPTION, ROW_LABEL } from "./ThemeStyleRow";
import { ThemeTile, TileFace, type TileFaceKind } from "./ThemeTile";

// 테마 스타일 행과 갤러리 (AP-1b #4188, 청사진 §5.3-c · Buzz `SettingsPanels.tsx:561-726`을 우리 규칙으로).
//
// 접힌 행: 지금 고른 테마의 이름과 썸네일 + chevron(`aria-expanded`·`aria-controls`). 펴면 격자가 같은 카드 안에 서고
// 고른 타일이 보이는 자리로 스크롤한다(43장 가운데 어디에 있든 찾을 수 있게).
// **탭이 색 모드를 따른다**(별도 탭 위젯이 없다): 시스템은 라이트·다크를 모두 가진 테마만(한 장이 대각 분할),
// 라이트·다크는 그 모드를 가진 테마 전부다. 안 보이는 테마가 어디 있는지는 탭마다 안내 한 줄이 말한다.
// 트리거 버튼은 안쪽 여백이 있다(`theme-style-trigger`): 집 규칙의 인셋 초점 링(안쪽 2)이 이름 글자와 썸네일 가장자리를 덮지 않게
// 한다. 배치는 카드 폭이 정한다: 좁으면 이름이 윗줄, 썸네일과 chevron이 한 덩이로 아랫줄이고(이름 길이와 무관하게 늘 같은 배치라 선택해도
// 행 높이가 뛰지 않는다), 넓으면 한 줄이다. 고르면 전 화면이 바로 바뀌고(외양 저장소 `commit`) 새로고침 뒤에도 남는다(저장 + 부트 캐시). 단일 모드 테마를 고르면 색 모드를 그 모드로 맞추고 한 줄로 알린다(규칙 1).
//
// 이 파일은 지연 청크다(`ThemeStyleRow.tsx`가 `React.lazy`로 싣는다). 카탈로그 씨앗 표와 파생 엔진이 함께 실린다.
// 네 상태(SKILL §5): 목록은 로컬 데이터라 로딩·오프라인이 없다(청크를 받는 동안의 자리표시는 `ThemeStyleRow`).
// 빈 상태는 모드마다 항목이 0일 수 없어 해당 없음. 한 테마의 파생이 던지면 그 타일만 비워 두고(`paintFor`가
// `null`이면 층이 루트를 물려받는다) 나머지는 그대로 선다.

/** 이 탭에서 안 보이는 테마가 어디서 보이는지(숨은 테마를 말하지 않으면 없는 줄 안다). */
const TAB_HINT: Readonly<Record<SchemeChoice, string>> = {
  system: "라이트와 다크를 모두 가진 테마만 보여요. 한쪽만 있는 테마는 라이트나 다크에서 골라요.",
  light: "라이트가 있는 테마만 보여요. 다크 전용 테마는 다크에서 골라요.",
  dark: "다크가 있는 테마만 보여요. 라이트 전용 테마는 라이트에서 골라요.",
};

export default function ThemeGallery() {
  const { theme, scheme, signal } = useAppearance();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const regionId = useId();
  const groupName = `theme-style-${useId()}`;
  const tiles = useMemo(() => galleryTiles(scheme), [scheme]);

  const label = themeLabel(theme);
  // 단일 모드 테마는 그 모드 한 장, 짝이 있는 테마는 시스템일 때 분할 한 장이다.
  const pinned = effectiveScheme(scheme, modesOf(theme));
  const thumbKind: TileFaceKind = pinned ?? "split";

  // 펼치면 고른 타일이 보이게 한다. `nearest`라서 이미 보이면 아무것도 움직이지 않는다.
  useEffect(() => {
    if (!open) return;
    region.current?.querySelector<HTMLElement>(".theme-tile[data-selected]")?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  function select(tile: GalleryTile) {
    const next = schemeForThemePick(scheme, tile.ref);
    updateAppearance({ theme: tile.ref, scheme: next.scheme });
    setNotice(next.adjusted ? pickNotice(next.adjusted) : null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <>
      <SettingsRow
        label={ROW_LABEL}
        description={<span className="block text-balance">{ROW_DESCRIPTION}</span>}
        testId="theme-style-row"
      >
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-controls={open ? regionId : undefined}
          aria-label={`테마 스타일, 지금은 ${label}`}
          data-testid="theme-style-trigger"
          onClick={() => setOpen((value) => !value)}
          className="theme-style-trigger press rounded-lg bg-transparent text-ink focus-visible:focus-ring"
        >
          {/* 이름은 한 줄이다(낱말 한가운데서 끊지 않는다). 배치는 카드 폭이 정하지(`theme-gallery.css`) 이름 길이가 정하지 않는다:
              좁은 카드에서는 이름이 윗줄이고 썸네일과 chevron이 한 덩이로 아랫줄이다. 그래도 모자라면(지원 폭 밖) 말줄임이다. */}
          <span data-testid="theme-style-selected-name" className="min-w-0 max-w-full truncate text-meta font-semibold text-ink">
            {label}
          </span>
          <span className="theme-style-trigger-tail">
            <span data-testid="theme-style-selected-preview" className="flex shrink-0">
              <TileFace themeRef={theme} kind={thumbKind} signal={signal} className="theme-style-thumb" />
            </span>
            {open ? (
              <ChevronUp aria-hidden className="size-4 shrink-0 text-ink-muted" />
            ) : (
              <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-muted" />
            )}
          </span>
        </button>
      </SettingsRow>
      {open ? (
        <div
          ref={region}
          id={regionId}
          className="theme-gallery-region"
          data-testid="theme-style-options"
          data-scheme={scheme}
          onKeyDown={onKeyDown}
        >
          <p className="theme-gallery-hint break-keep text-meta text-ink-muted" data-testid="theme-style-hint">
            {TAB_HINT[scheme]}
          </p>
          <div role="status" className="theme-gallery-notice break-keep text-meta text-ink" data-testid="theme-style-notice">
            {notice}
          </div>
          <fieldset className="m-0 min-w-0 border-0 p-0" data-testid="theme-style-group">
            <legend className="sr-only">테마 스타일</legend>
            <div className="theme-gallery-scroll">
              <div className="theme-gallery-grid" data-count={tiles.length}>
                {tiles.map((tile) => (
                  <ThemeTile
                    key={tile.ref}
                    tile={tile}
                    selected={tile.ref === theme}
                    signal={signal}
                    name={groupName}
                    onSelect={select}
                  />
                ))}
              </div>
            </div>
          </fieldset>
        </div>
      ) : null}
    </>
  );
}
