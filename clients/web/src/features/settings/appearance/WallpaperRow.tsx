import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ImageOff, ImagePlus, Image as ImageIcon, Info } from "lucide-react";
import {
  IMPORT_FAILURE_COPY,
  PRESET_IDS,
  SOLID_IDS,
  WALLPAPER_BAND_COPY,
  WALLPAPER_BLURRY_COPY,
  WALLPAPER_COPY,
  WALLPAPER_NARROW_COPY,
  WALLPAPER_OFF_COPY,
  WALLPAPER_PRESETS,
  WALLPAPER_SOLIDS,
  isKnownWallpaper,
  type PresetId,
  type SolidId,
} from "@momo/core/design/wallpaper";
import { useAppearance } from "@/design/theme";
import { useNarrowWindow, useWallpaperPlan } from "@/design/wallpaper/runtime";
import { usePhotoView, wallpaperStore } from "@/design/wallpaper/store";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { SettingsRow } from "../shell/SettingsRow";

// =============================================================================
// 배경화면 (AP-4 #4191, ADR-0189 증보 3 D4). 카드 「배경」의 첫 행.
//
// 사이드바 뒤와 창 가장자리에 깔 그림을 고른다: 없음 / 단색 8 / 기본 제공 6 / 내 사진, 그리고 「기본으로」.
// 컨트롤은 앱이 그 값을 **실제로 따를 때** 열린다(증보 1 「눌러도 안 바뀌는 컨트롤은 먼저 내보내지 않는다」).
// 따르는 쪽은 같은 PR의 `design/wallpaper/`(층·scrim·보정)이고, 고른 순간 사이드바가 바로 바뀐다.
//
// 선택은 외양 레코드(`wallpaper`), 사진 바이트는 IndexedDB에 산다. 사진은 이 기기를 떠나지 않는다.
// 이 행이 하는 일은 고르는 것과, 지금 배경이 왜 안 보이는지 한 줄로 말하는 것이다:
//   · 시스템 「투명도 줄이기」·「대비 높이기」가 켜져 있다 (선택은 남는다)
//   · 이 테마에서는 글자 대비 때문에 쓸 수 없다 (하한이 95%를 넘는다)
//   · 쓸 수는 있지만 사진이 많이 흐려진다 (하한 85~95%)
//   · 사이드바에 띠가 있는 테마라 가장자리에만 보인다
//   · 창이 좁아서(600px 미만) 바닥이 보이지 않는다
//   · 저장한 사진을 찾지 못했다 / 사진을 가져오지 못했다
//
// 네 상태: 빈 것은 「없음」이 고른 기본 상태, 불러오는 중은 사진을 줄이는 동안의 비활성 단추, 오류는 아래 한 줄,
// 오프라인은 모든 일이 이 기기 안이라 해당 없음(PR 본문).
// =============================================================================

/**
 * 소유 이슈가 이 행을 열 때 `true`로 바꾼다(컴포넌트를 채우는 같은 PR에서). 열린 행은 슬롯 시험의
 * 「아무것도 안 그린다」 단정에서 빠지고, 이 행을 부르는 합성 쪽 파일은 고치지 않는다.
 */
export const WALLPAPER_ROW_OPEN: boolean = true;

const GROUP_NAME = "appearance-wallpaper";

/**
 * 칩의 색은 core 표에서 온다(색 리터럴은 core에만 둔다). 정적 CSS도 JSX `style=`도 아니라 마운트할 때 CSS 변수 두 개로
 * 넘기고, 칠하는 규칙은 `wallpaper.css`의 `.wallpaper-chip`이 쥔다(값만 동적이고 속성은 스타일시트의 것이다).
 */
function Chip({
  shape,
  fill,
  children,
}: {
  shape: "circle" | "tile";
  fill?: { color?: string; image?: string };
  children?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const color = fill?.color ?? "";
  const image = fill?.image ?? "";
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    for (const [name, value] of [
      ["--wallpaper-chip-color", color],
      ["--wallpaper-chip-image", image],
    ] as const) {
      if (value === "") element.style.removeProperty(name);
      else element.style.setProperty(name, value);
    }
  }, [color, image]);
  return (
    <span ref={ref} className="wallpaper-chip" data-shape={shape}>
      {children}
      <span className="wallpaper-chip-check" aria-hidden="true">
        <Check className="size-4" aria-hidden="true" />
      </span>
    </span>
  );
}

function Choice({
  label,
  name,
  selected,
  onSelect,
  testId,
  shape,
  fill,
  icon,
  caption,
}: {
  label: string;
  name: string;
  selected: boolean;
  onSelect: () => void;
  testId: string;
  shape: "circle" | "tile";
  fill?: { color?: string; image?: string };
  icon?: ReactNode;
  caption: string;
}) {
  return (
    <label className="wallpaper-choice press text-meta text-ink">
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onSelect}
        aria-label={label}
        data-testid={testId}
        className="sr-only"
      />
      <Chip shape={shape} fill={fill}>
        {selected ? null : icon}
      </Chip>
      <span className={cn("break-keep", selected && "font-semibold")}>{caption}</span>
    </label>
  );
}

export function WallpaperRow() {
  const appearance = useAppearance();
  const plan = useWallpaperPlan();
  const narrow = useNarrowWindow();
  const photo = usePhotoView();
  const store = wallpaperStore();
  const fileInput = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  // 사진을 가져오지 못한 이유. 다음 선택에서 지운다.
  const [notice, setNotice] = useState<string | null>(null);

  const chosen = isKnownWallpaper(appearance.wallpaper) ? appearance.wallpaper : undefined;
  const unavailable = plan.treatment?.verdict === "unavailable";
  const photoChosen = chosen?.kind === "image";

  // 지금 배경이 왜 안 보이는지, 또는 어떤 모습인지 한 줄. 위가 아래보다 먼저다.
  const status = (() => {
    if (notice !== null) return { text: notice, tone: "danger" as const };
    if (photo.status === "missing") return { text: WALLPAPER_OFF_COPY["no-photo"], tone: "muted" as const };
    // 창 폭과 무관하게 참인 이유가 먼저다: 좁은 창에서 「대비 높이기」가 켜져 있는데 「넓은 창에서는 보여요」라고 하면, 창을 넓혀도
    // 안 보여서 거짓말이 된다(design-review 최종 L-2).
    const reason = plan.decision.reason;
    if (reason !== null) return { text: WALLPAPER_OFF_COPY[reason], tone: "muted" as const };
    if (unavailable) return { text: WALLPAPER_OFF_COPY.unavailable, tone: "muted" as const };
    // 아무것도 고르지 않았으면 안 보이는 것이 정상이다: 좁은 창을 말할 일이 없다.
    if (narrow && chosen !== undefined) return { text: WALLPAPER_NARROW_COPY, tone: "muted" as const };
    if (plan.decision.live && plan.hasBand) return { text: WALLPAPER_BAND_COPY, tone: "muted" as const };
    if (plan.treatment?.verdict === "blurry") return { text: WALLPAPER_BLURRY_COPY, tone: "muted" as const };
    return null;
  })();

  function pick(action: () => void) {
    setNotice(null);
    action();
  }

  async function onFile(file: File | undefined) {
    if (file === undefined || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await store.importPhoto(file, file.size);
      if (!result.ok) setNotice(IMPORT_FAILURE_COPY[result.reason]);
    } finally {
      setBusy(false);
    }
  }

  const thumb = photo.status === "ready" ? photo.thumb : null;

  return (
    <>
      <SettingsRow
        label={WALLPAPER_COPY.label}
        description={WALLPAPER_COPY.description}
        labelId={labelId}
        descriptionId={descriptionId}
        testId="wallpaper-row"
      >
        {/* 늘 그려 둔다(고른 것이 없으면 잠긴다): 처음 고르는 순간 단추가 생겨 좁은 폭에서 칩이 아래로 밀리지 않게. */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="tap-target"
          disabled={chosen === undefined}
          onClick={() => pick(() => store.reset())}
          data-testid="wallpaper-reset"
        >
          {WALLPAPER_COPY.reset}
        </Button>
      </SettingsRow>
      <div className="settings-row" data-stack="" data-align="start" data-testid="wallpaper-choices">
        <fieldset
          data-testid="wallpaper-choice"
          disabled={unavailable}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-busy={busy}
          className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
        >
          <legend className="sr-only">{WALLPAPER_COPY.label}</legend>
          {/* 「기본」은 단색이 아니다: 폰처럼 자기 줄로 맨 위에 둔다(패리티). */}
          <div className="flex min-w-0 flex-wrap items-start gap-4">
            <Choice
              label={`${WALLPAPER_COPY.label} ${WALLPAPER_COPY.none}`}
              name={GROUP_NAME}
              selected={chosen === undefined}
              onSelect={() => pick(() => store.reset())}
              testId="wallpaper-none"
              shape="circle"
              icon={<ImageOff className="size-4 text-ink-muted" aria-hidden="true" />}
              caption={WALLPAPER_COPY.none}
            />
            <div className="flex min-h-control-lg items-center">
              <p className="break-keep text-meta text-ink-muted">{WALLPAPER_COPY.noneDetail}</p>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-meta font-semibold text-ink-muted">{WALLPAPER_COPY.solid}</p>
            <div className="flex flex-wrap gap-4">
              {SOLID_IDS.map((id: SolidId) => (
                <Choice
                  key={id}
                  label={`${WALLPAPER_COPY.solid} ${WALLPAPER_SOLIDS[id].label}`}
                  name={GROUP_NAME}
                  selected={chosen?.kind === "solid" && chosen.id === id}
                  onSelect={() => pick(() => store.choose({ kind: "solid", id }))}
                  testId={`wallpaper-solid-${id}`}
                  shape="circle"
                  fill={{ color: WALLPAPER_SOLIDS[id].hex }}
                  caption={WALLPAPER_SOLIDS[id].label}
                />
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-meta font-semibold text-ink-muted">{WALLPAPER_COPY.preset}</p>
            <div className="flex flex-wrap gap-4">
              {PRESET_IDS.map((id: PresetId) => (
                <Choice
                  key={id}
                  label={`${WALLPAPER_COPY.preset} ${WALLPAPER_PRESETS[id].label}`}
                  name={GROUP_NAME}
                  selected={chosen?.kind === "preset" && chosen.id === id}
                  onSelect={() => pick(() => store.choose({ kind: "preset", id }))}
                  testId={`wallpaper-preset-${id}`}
                  shape="tile"
                  fill={{ color: WALLPAPER_PRESETS[id].fallback, image: WALLPAPER_PRESETS[id].gradient }}
                  caption={WALLPAPER_PRESETS[id].label}
                />
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-meta font-semibold text-ink-muted">{WALLPAPER_COPY.photo}</p>
            <div className="flex flex-wrap items-start gap-4">
              {photoChosen ? (
                <Choice
                  label={WALLPAPER_COPY.photo}
                  name={GROUP_NAME}
                  selected
                  onSelect={() => undefined}
                  testId="wallpaper-photo"
                  shape="tile"
                  fill={thumb !== null ? { image: `url("${thumb}")` } : undefined}
                  icon={<ImageIcon className="size-4 text-ink-muted" aria-hidden="true" />}
                  caption={WALLPAPER_COPY.photo}
                />
              ) : null}
              <div className="flex min-h-control-lg items-center">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="tap-target"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => fileInput.current?.click()}
                  data-testid="wallpaper-pick-photo"
                >
                  <ImagePlus aria-hidden="true" />
                  {busy
                    ? WALLPAPER_COPY.busyPhoto
                    : photoChosen
                      ? WALLPAPER_COPY.pickAnotherPhoto
                      : WALLPAPER_COPY.pickPhoto}
                </Button>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                tabIndex={-1}
                className="sr-only"
                aria-hidden="true"
                data-testid="wallpaper-file-input"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  // 같은 사진을 다시 골라도 변경 이벤트가 오도록 비운다.
                  event.currentTarget.value = "";
                  void onFile(file);
                }}
              />
            </div>
            <p className="break-keep text-meta text-ink-muted">
              {WALLPAPER_COPY.privacy}
              {photoChosen ? ` ${WALLPAPER_COPY.replaceNote}` : ""}
            </p>
          </div>
        </fieldset>
        {/* 지금 배경이 왜 안 보이는지·어떤 모습인지 한 줄. 같은 행의 맨 아래에 서서 위의 안내 문장들과 한 덩어리로 읽힌다.
            알림 영역은 내용이 없을 때도 DOM에 있어야 한다(없던 영역이 내용과 함께 생기면 보조기기가 읽지 않는 일이 잦다).
            비었을 때는 `empty:hidden`이라 자리를 차지하지 않는다. */}
        <p
          role="status"
          data-testid="wallpaper-status"
          className={cn(
            "flex items-start gap-2 break-keep text-meta empty:hidden",
            status !== null && status.tone === "danger" ? "text-danger" : "text-ink"
          )}
        >
          {status !== null ? (
            <>
              <Info className="mt-px size-4 shrink-0" aria-hidden="true" />
              <span>{status.text}</span>
            </>
          ) : null}
        </p>
      </div>
    </>
  );
}
