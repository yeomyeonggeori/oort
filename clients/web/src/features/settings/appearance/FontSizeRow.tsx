import { DEFAULT_FONT_SIZE_ID, type FontSizeId } from "@momo/core/design/appearance";
import { updateAppearance, useAppearance } from "@/design/theme";
import { SegmentedControl, type SegmentOption } from "@/design/ui/segmented-control";
import { SettingsRow } from "../shell/SettingsRow";

// 글자 크기: 작게·기본·크게 (AP-2a #4189, ADR-0189 증보 1 D2 · 증보 3 D8).
// 자리: 카드 「대화 표시」 맨 위. 값은 `@/design/theme`의 외양 저장소가 들고(`fontSize` 필드, 기본값이면
// 저장에서 빠진다), 루트 속성 `data-font-size`로 찍혀서 `design/appearance/typography-scale.css`가 글자
// 배율을 고른다. 이 행은 그 값을 쓰기만 한다.
//
// 컨트롤은 앱이 그 값을 **실제로 따를 때**만 연다(ADR-0189 증보 1 「눌러도 안 바뀌는 컨트롤은 먼저
// 내보내지 않는다」): 텍스트 역할 여덟 개가 모두 같은 배율을 곱하므로 이 한 번의 누름이 앱 전체의 글자에
// 닿는다. 그래서 별도 미리보기를 끌어당겨 보여 주지 않는다(Buzz의 끌어서 보는 미리보기는 가져오지
// 않았다). 누르면 곧바로 화면이 바뀌고 저장 버튼은 없다.

/**
 * 이 행이 열려 있다. 슬롯 시험의 「아무것도 안 그린다」 단정에서 빠지고, 이 행을 부르는 합성 쪽 파일은
 * 고치지 않는다.
 */
export const FONT_SIZE_ROW_OPEN: boolean = true;

const OPTIONS: readonly SegmentOption<FontSizeId>[] = [
  { value: "smaller", label: "작게" },
  { value: "default", label: "기본" },
  { value: "larger", label: "크게" },
];

export function FontSizeRow() {
  const { fontSize } = useAppearance();
  return (
    <SettingsRow
      label="글자 크기"
      description="대화와 화면의 글자에 모두 적용돼요."
      labelId="appearance-font-size-label"
      testId="font-size-row"
    >
      <SegmentedControl
        legend="글자 크기"
        name="font-size"
        options={OPTIONS}
        value={fontSize ?? DEFAULT_FONT_SIZE_ID}
        onValueChange={(next) => updateAppearance({ fontSize: next })}
        testId="font-size-choice"
      />
    </SettingsRow>
  );
}
