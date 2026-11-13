import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SchemeChoice } from "@momo/core/design/appearance";
import { galleryTiles, pickNotice, schemeForThemePick, type GalleryTile } from "@momo/core/design/themeGallery";
import { updateAppearance, useAppearance } from "@/design/theme";
import { SettingsRow } from "../shell/SettingsRow";
import { ROW_DESCRIPTION, ROW_LABEL } from "./ThemeStyleRow";
import { ThemeTile } from "./ThemeTile";

// 테마 스타일 행과 갤러리 (AP-1b #4188, 청사진 §5.3-c · Buzz `SettingsPanels.tsx:561-726`을 우리 규칙으로).
//
// **격자는 늘 펴져 있다**(#5783 QA 8, owner 2026-11-14 「늘 펴 둠(버즈식)」). 예전의 접힌 행(고른 테마 이름 + 썸네일 + chevron)은
// 걷었다: 고르는 자리가 곧 보이는 자리라 한 번 더 누를 까닭이 없다. 행은 라벨·설명 아래로 격자를 세로로 세운다(`stack`).
// 다크는 43장이라 격자는 높이 상한 안에서 안쪽으로 스크롤하고 위아래 페이드가 더 있음을 알린다(theme-gallery.css).
// 고른 타일은 처음 설 때와 목록이 바뀔 때(색 모드) 보이는 자리로 **격자 안쪽만** 스크롤한다: `scrollIntoView`는 바깥 설정
// 페이지까지 움직여서(390 폭·200% 확대) 설정을 연 순간 화면이 갤러리로 뛴다.
// **탭이 색 모드를 따른다**(별도 탭 위젯이 없다): 시스템은 라이트·다크를 모두 가진 테마만(한 장이 대각 분할),
// 라이트·다크는 그 모드를 가진 테마 전부다. 안 보이는 테마가 어디 있는지는 탭마다 안내 한 줄이 말한다.
// 고르면 전 화면이 바로 바뀌고(외양 저장소 `commit`) 새로고침 뒤에도 남는다(저장 + 부트 캐시). 단일 모드 테마를 고르면 색 모드를
// 그 모드로 맞추고 한 줄로 알린다(규칙 1). 타일 안은 글자 없는 미니어처이고 이름은 타일 아래 한 줄이다(`ThemeTile`).
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

/**
 * 고른 타일이 격자 안쪽 스크롤 상자에서 보이게 그 상자의 `scrollTop`만 옮긴다(이미 보이면 그대로). 바깥 페이지는 움직이지 않는다.
 * 페이드 구간(`scroll-padding-block`)에 걸리지 않게 그 폭만큼 안쪽에 세운다.
 */
function revealTileInside(box: HTMLElement, tile: HTMLElement): void {
  const outer = box.getBoundingClientRect();
  const inner = tile.getBoundingClientRect();
  const pad = Number.parseFloat(getComputedStyle(box).scrollPaddingBlockStart) || 0;
  if (inner.top < outer.top + pad) {
    box.scrollTop -= outer.top + pad - inner.top;
  } else if (inner.bottom > outer.bottom - pad) {
    box.scrollTop += inner.bottom - (outer.bottom - pad);
  }
}

export default function ThemeGallery() {
  const { theme, scheme, signal } = useAppearance();
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const groupName = `theme-style-${useId()}`;
  const tiles = useMemo(() => galleryTiles(scheme), [scheme]);

  // 처음 설 때와 색 모드가 바뀌어 목록이 바뀔 때만 잰다. 타일을 눌러 고를 때는 그 타일이 이미 보인다.
  useLayoutEffect(() => {
    const box = scroller.current;
    const tile = box?.querySelector<HTMLElement>(".theme-tile[data-selected]");
    if (box && tile) revealTileInside(box, tile);
  }, [scheme]);

  function select(tile: GalleryTile) {
    const next = schemeForThemePick(scheme, tile.ref);
    updateAppearance({ theme: tile.ref, scheme: next.scheme });
    setNotice(next.adjusted ? pickNotice(next.adjusted) : null);
  }

  return (
    <SettingsRow
      label={ROW_LABEL}
      description={<span className="block text-balance">{ROW_DESCRIPTION}</span>}
      testId="theme-style-row"
      stack
    >
      <div className="theme-gallery-region" data-testid="theme-style-options" data-scheme={scheme}>
        <p className="theme-gallery-hint break-keep text-meta text-ink-muted" data-testid="theme-style-hint">
          {TAB_HINT[scheme]}
        </p>
        <div role="status" className="theme-gallery-notice break-keep text-meta text-ink" data-testid="theme-style-notice">
          {notice}
        </div>
        <fieldset className="m-0 min-w-0 border-0 p-0" data-testid="theme-style-group">
          <legend className="sr-only">테마 스타일</legend>
          <div ref={scroller} className="theme-gallery-scroll" data-testid="theme-style-scroll">
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
    </SettingsRow>
  );
}
