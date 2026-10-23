import { SegmentedControl, type SegmentOption } from "@/design/ui/segmented-control";
import {
  setLinkPreviewPreference,
  useLinkPreviewPreference,
  type LinkPreviewPreference,
} from "@/features/timeline/linkPreviewPreference";
import { ConversationPreview } from "../shell/ConversationPreview";
import { SettingsRow } from "../shell/SettingsRow";
import { SettingsSection } from "../shell/SettingsSection";
import { DensityRow } from "./DensityRow";
import { FontSizeRow } from "./FontSizeRow";
import { ThreadLayoutRow } from "./ThreadLayoutRow";

// 카드 「대화 표시」 (#3578 S3a에서 옮김, AP-1a #4186). 링크 미리보기와 대화 미리보기는 그대로
// 있고, 슬롯(`FontSizeRow`·`DensityRow`·`ThreadLayoutRow`)은 소유 이슈가 열기 전까지 아무것도
// 그리지 않는다. 자리는 청사진 §5.3-a의 순서다: 글자 크기 → 대화 밀도 → 링크 미리보기 →
// 대화 미리보기 → 스레드 배치.

const LINK_OPTIONS: readonly SegmentOption<LinkPreviewPreference>[] = [
  { value: "rich", label: "사진 카드" },
  { value: "compact", label: "작은 카드" },
  { value: "off", label: "숨기기" },
];

const LINK_DETAIL: Record<LinkPreviewPreference, string> = {
  rich: "이미지가 있으면 사진을 위에 두고, 제목과 설명을 그 아래에 둬요. 사진이 없으면 작은 카드와 같아요.",
  compact: "제목, 설명, 작은 그림을 한 덩어리로 보여줘요.",
  off: "메시지 속 링크만 남기고 카드는 그리지 않아요.",
};

export function DisplayPrefs() {
  const linkPreview = useLinkPreviewPreference();
  return (
    <SettingsSection
      title="대화 표시"
      description="이 선택은 서버의 링크 확인이나 다른 멤버의 화면에 영향을 주지 않아요."
    >
      <FontSizeRow />
      <DensityRow />
      <SettingsRow
        label="링크 미리보기"
        description={LINK_DETAIL[linkPreview]}
        labelId="appearance-link-label"
      >
        <SegmentedControl
          legend="링크 미리보기 모양"
          name="link-preview"
          options={LINK_OPTIONS}
          value={linkPreview}
          onValueChange={setLinkPreviewPreference}
          testId="link-preview-choice"
        />
      </SettingsRow>
      <SettingsRow label="대화 미리보기" description="고른 글자 크기와 대화 밀도, 링크 카드가 이렇게 보여요." stack>
        <ConversationPreview linkPreview={linkPreview} />
      </SettingsRow>
      <ThreadLayoutRow />
    </SettingsSection>
  );
}
