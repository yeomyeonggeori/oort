import type { MessageKey } from "@momo/core/i18n";
import { SegmentedControl, type SegmentOption } from "@/design/ui/segmented-control";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  LINK_PREVIEW_PREFERENCES,
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

// 저장되는 값은 rich·compact·off 그대로다(이름이 아니라 화면의 낱말만 작게·크게·끄기로 바뀌었다, #4882).
// 낱말과 설명은 사전 키다: 이 줄은 새 문구라 직접 문구 장부에 더하지 않는다.
const LINK_LABEL_KEY = {
  compact: "settings.appearance.linkPreviewCompact",
  rich: "settings.appearance.linkPreviewRich",
  off: "settings.appearance.linkPreviewOff",
} as const satisfies Record<LinkPreviewPreference, MessageKey>;

const LINK_HINT_KEY = {
  compact: "settings.appearance.linkPreviewCompactHint",
  rich: "settings.appearance.linkPreviewRichHint",
  off: "settings.appearance.linkPreviewOffHint",
} as const satisfies Record<LinkPreviewPreference, MessageKey>;

export function DisplayPrefs() {
  const linkPreview = useLinkPreviewPreference();
  const formatMessage = useFormatMessage();
  const linkOptions: readonly SegmentOption<LinkPreviewPreference>[] = LINK_PREVIEW_PREFERENCES.map(
    (value) => ({ value, label: formatMessage(LINK_LABEL_KEY[value]) })
  );
  return (
    <SettingsSection
      title="대화 표시"
      description="이 선택은 서버의 링크 확인이나 다른 멤버의 화면에 영향을 주지 않아요."
    >
      <FontSizeRow />
      <DensityRow />
      <SettingsRow
        label="링크 미리보기"
        description={formatMessage(LINK_HINT_KEY[linkPreview])}
        labelId="appearance-link-label"
      >
        <SegmentedControl
          legend="링크 미리보기 모양"
          name="link-preview"
          options={linkOptions}
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
