import { RotateCcw } from "lucide-react";
import { GLASS_PAGE_STEP, GLASS_STEP } from "@momo/core/design/glass";
import { Button } from "@/design/ui/button";
import { Slider } from "@/design/ui/slider";
import { Switch } from "@/design/ui/switch";
import { SettingsRow } from "../shell/SettingsRow";
import { setGlassOn, setGlassOpacity, useGlassSnapshot } from "./desktopEffects";
import { GLASS_COPY } from "./glassCopy";

// 유리 배경 스위치와 유리 불투명도 슬라이더 (AP-3 #4190, ADR-0189 증보 1 D4 · 증보 3 D6).
// 자리: 카드 「색상」, 강조색 아래. 행 구조는 Buzz `AppearanceSettingsControls.tsx:396-494`를 우리 토큰과
// 해요체로 다시 쓴 것이다(코드를 옮기지 않았다).
//
// 이 파일은 **무엇을 보일지**만 안다. 그릴지·못 그릴지의 판정(`resolveGlass`)과 창 쪽 일은
// `desktopEffects.ts`가 하고, 행은 그 스냅샷을 읽는다. 그래서 행이 말하는 것과 창이 하는 일이 어긋날 수
// 없다. 배경화면(AP-4)과의 공존(결정 9)도 같은 판정의 한 칸(`wallpaper`)이라 여기서 따로 판정하지 않는다.
//
// 컨트롤은 앱이 실제로 따를 때만 공개한다: 켜진 동안에만 슬라이더가 서고, 시스템이 투명 효과를 끄고 있을 때는
// 눌러도 바뀌지 않으므로 슬라이더를 걷는다. 못 켜는 이유(미지원·불가·배경화면)는 스위치를 잠그고 이유를
// 문장으로 말한다. 켜기 실패는 토스트가 아니라 행 안의 문장이다.

/**
 * 소유 이슈가 이 행을 열 때 `true`로 바꾼다(컴포넌트를 채우는 같은 PR에서). 열린 행은 슬롯 시험의
 * 「아무것도 안 그린다」 단정에서 빠지고, 이 행을 부르는 합성 쪽 파일은 고치지 않는다.
 */
export const GLASS_ROWS_OPEN: boolean = true;

const SWITCH_LABEL_ID = "glass-background-label";
const SWITCH_DESCRIPTION_ID = "glass-background-description";
const OPACITY_LABEL_ID = "glass-opacity-label";
const OPACITY_DESCRIPTION_ID = "glass-opacity-description";

export function GlassRows() {
  const { status, view } = useGlassSnapshot();
  const { decision, range, opacity } = view;

  // 테마의 색을 아직 못 읽었다(파생 테마인데 엔진 조회가 꽂히지 않았다): 이때 스위치를 켠 채로 두면 눌러도 아무 일도
  // 없는 컨트롤이 된다(켠 채로 두는 것은 창 쪽 일이 기다린다는 뜻이고 화면은 아무것도 안 그린다). 컨트롤은 앱이 실제로
  // 따를 때만 공개하므로 행을 걷는다. 색이 읽히면(조회가 꽂히면) 행이 선다. 브라우저·다른 OS는 테마와 무관하게 「쓸 수
  // 없음」을 문장으로 말하므로 그대로 그린다.
  if (status.supported && range === null) return null;

  const description =
    decision.reason === "unsupported"
      ? GLASS_COPY.unsupported
      : decision.reason === "unusable"
        ? GLASS_COPY.unusable
        : decision.reason === "wallpaper"
          ? GLASS_COPY.wallpaper
          : decision.reason === "failed"
            ? (
                <span role="status" className="text-danger" data-testid="glass-background-failed">
                  {GLASS_COPY.failed}
                </span>
              )
            : decision.reason === "reduced-transparency"
              ? GLASS_COPY.reducedTransparency
              : GLASS_COPY.supported;

  const showSlider =
    decision.checked &&
    decision.reason === null &&
    range !== null &&
    range.usable &&
    opacity !== null;

  return (
    <>
      <SettingsRow
        label={GLASS_COPY.label}
        description={description}
        labelId={SWITCH_LABEL_ID}
        descriptionId={SWITCH_DESCRIPTION_ID}
        testId="glass-background-row"
        keep
      >
        <Switch
          checked={decision.checked}
          disabled={decision.toggleDisabled}
          labelledBy={SWITCH_LABEL_ID}
          describedBy={SWITCH_DESCRIPTION_ID}
          onCheckedChange={setGlassOn}
          testId="glass-background-toggle"
        />
      </SettingsRow>
      {showSlider ? (
        <SettingsRow
          label={GLASS_COPY.opacityLabel}
          description={GLASS_COPY.opacityHint(range.min)}
          labelId={OPACITY_LABEL_ID}
          descriptionId={OPACITY_DESCRIPTION_ID}
          testId="glass-opacity-row"
        >
          <Slider
            value={opacity}
            min={range.min}
            max={range.max}
            step={GLASS_STEP}
            pageStep={GLASS_PAGE_STEP}
            valueText={GLASS_COPY.valueText}
            labelledBy={OPACITY_LABEL_ID}
            describedBy={OPACITY_DESCRIPTION_ID}
            onValueChange={setGlassOpacity}
            testId="glass-opacity-slider"
          />
          <span
            data-numeric
            aria-hidden="true"
            data-testid="glass-opacity-value"
            className="min-w-8 text-right text-meta text-ink-muted"
          >
            {opacity}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={GLASS_COPY.reset}
            disabled={opacity === range.defaultPercent}
            onClick={() => setGlassOpacity(undefined)}
            data-testid="glass-opacity-reset"
          >
            <RotateCcw aria-hidden="true" />
          </Button>
        </SettingsRow>
      ) : null}
    </>
  );
}
