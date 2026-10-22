import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
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
import { ThemeTile, TileFace, type TileFaceKind } from "./ThemeTile";

// 테마 스타일 행과 갤러리 (AP-1b #4188, 청사진 §5.3-c · Buzz `SettingsPanels.tsx:561-726`을 우리 규칙으로).
//
// 접힌 행: 지금 고른 테마의 썸네일 + chevron(`aria-expanded`·`aria-controls`). 펴면 격자가 같은 카드 안에 선다.
// **탭이 색 모드를 따른다**(별도 탭 위젯이 없다): 시스템은 라이트·다크 짝이 있는 테마만(한 장이 대각 분할),
// 라이트·다크는 그 모드를 가진 테마 전부다. 고르면 전 화면이 바로 바뀌고(외양 저장소 `commit`) 새로고침 뒤에도
// 남는다(저장 + 부트 캐시). 단일 모드 테마를 고르면 색 모드를 그 모드로 맞추고 한 줄로 알린다(규칙 1).
//
// 이 파일은 지연 청크다(`ThemeStyleRow.tsx`가 `React.lazy`로 싣는다). 카탈로그 씨앗 표와 파생 엔진이 함께 실린다.
// 네 상태(SKILL §5): 목록은 로컬 데이터라 로딩·오프라인이 없다(청크를 받는 동안의 자리표시는 `ThemeStyleRow`).
// 빈 상태는 모드마다 항목이 0일 수 없어 해당 없음. 한 테마의 파생이 던지면 그 타일만 비워 두고(`paintFor`가
// `null`이면 층이 루트를 물려받는다) 나머지는 그대로 선다.

export default function ThemeGallery() {
  const { theme, scheme, signal } = useAppearance();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const regionId = useId();
  const groupName = `theme-style-${useId()}`;
  const tiles = useMemo(() => galleryTiles(scheme), [scheme]);

  const label = themeLabel(theme);
  // 단일 모드 테마는 그 모드 한 장, 짝이 있는 테마는 시스템일 때 분할 한 장이다.
  const pinned = effectiveScheme(scheme, modesOf(theme));
  const thumbKind: TileFaceKind = pinned ?? "split";

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
        label="테마 스타일"
        description="앱 전체에 쓰는 색 조합이에요. 라이트와 다크가 짝인 테마는 색 모드를 따라 같이 바뀌어요."
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
          className="press flex min-w-0 items-center gap-2 rounded-lg bg-transparent p-0 text-ink focus-visible:focus-ring"
        >
          <span data-testid="theme-style-selected-preview" className="flex">
            <TileFace themeRef={theme} kind={thumbKind} signal={signal} className="theme-style-thumb" />
          </span>
          {open ? (
            <ChevronUp aria-hidden className="size-4 shrink-0 text-ink-muted" />
          ) : (
            <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-muted" />
          )}
        </button>
      </SettingsRow>
      {open ? (
        <div
          id={regionId}
          className="theme-gallery-region"
          data-testid="theme-style-options"
          data-scheme={scheme}
          onKeyDown={onKeyDown}
        >
          {scheme === "system" ? (
            <p className="theme-gallery-hint break-keep text-meta text-ink-muted" data-testid="theme-style-hint">
              라이트와 다크가 짝인 테마만 보여요.
            </p>
          ) : null}
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
