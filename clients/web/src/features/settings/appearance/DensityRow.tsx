import { DENSITY_DISPLAY_ORDER, type DensityId } from "@momo/core/design/density";
import { updateAppearance, useAppearance } from "@/design/theme";
import { SegmentedControl, type SegmentOption } from "@/design/ui/segmented-control";
import { SettingsRow } from "../shell/SettingsRow";

// 대화 밀도: 촘촘하게·편하게·여유롭게 (AP-2a #4189, ADR-0189 증보 1 D1).
// 자리: 카드 「대화 표시」, 글자 크기 아래. 값은 `@/design/theme`의 외양 저장소가 들고(`density`
// 필드), 루트 속성 `data-density`로 찍혀서 `design/appearance/density.css`가 대화 표면의 간격 변수
// 다섯 개(행 사이·묶음 머리 위·아바타·문단·목록)를 고른다. 이 행은 그 값을 쓰기만 한다.
//
// 범위는 **대화 표면**이다(타임라인·스레드의 행, 메시지 안 문단·목록). 사이드바 행 높이·카드 여백·반경·채널 머리·컴포저 목록은
// 이 값을 따르지 않는다 — 그래서 설명이 「메시지 사이와 메시지 안 문단·목록 사이」라고만 말한다.
// 컨트롤은 앱이 실제로 따를 때만 열고, 누르면 곧바로 바뀌며 저장 버튼은 없다.
//
// 개념 출처: Buzz desktop `src/features/settings/ui/AppearanceSettingsControls.tsx:230-251`(Apache-2.0, Copyright 2026
// Block, Inc., 커밋 af5bb0a)의 「대화 밀도 세 칸」 행 구성. 코드는 복사하지 않았고 oort의 세그먼트 컨트롤·토큰·해요체로
// 다시 짰다(끌어서 보는 미리보기는 가져오지 않았다).

/**
 * 이 행이 열려 있다. 슬롯 시험의 「아무것도 안 그린다」 단정에서 빠지고, 이 행을 부르는 합성 쪽 파일은
 * 고치지 않는다.
 */
export const DENSITY_ROW_OPEN: boolean = true;

const LABELS: Readonly<Record<DensityId, string>> = {
  compact: "촘촘하게",
  comfortable: "편하게",
  spacious: "여유롭게",
};

const OPTIONS: readonly SegmentOption<DensityId>[] = DENSITY_DISPLAY_ORDER.map((value) => ({
  value,
  label: LABELS[value],
}));

export function DensityRow() {
  const { density } = useAppearance();
  return (
    <SettingsRow
      label="대화 밀도"
      description="메시지 사이와 메시지 안 문단·목록 사이의 간격이에요."
      labelId="appearance-density-label"
      testId="density-row"
    >
      <SegmentedControl
        legend="대화 밀도"
        name="density"
        options={OPTIONS}
        value={density}
        onValueChange={(next) => updateAppearance({ density: next })}
        testId="density-choice"
      />
    </SettingsRow>
  );
}
