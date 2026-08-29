import {
  setLinkPreviewPreference,
  useLinkPreviewPreference,
  type LinkPreviewPreference,
} from "@/features/timeline/linkPreviewPreference";
import { ChoiceRadios, SectionShell } from "./SettingsFields";

// =============================================================================
// 설정 > 링크 미리보기 (BF-A6 / #1903).
//
// 형제 문법: 설정 > 테마(`AppearanceSection`)의 `ChoiceRadios`. 값이 하나이고
// 고른 즉시 타임라인이 따라가므로 저장 버튼은 없다. BZ-5a가 외양 패널로 옮길
// 때 이 섹션 단위 그대로 가져가면 된다.
// =============================================================================

const CHOICES = [
  {
    id: "rich",
    label: "사진 카드",
    detail:
      "이미지가 있으면 사진을 위에 두고, 제목과 설명을 그 아래에 둡니다. 사진이 없으면 작은 카드와 같습니다.",
  },
  {
    id: "compact",
    label: "작은 카드",
    detail: "제목, 설명, 작은 그림을 한 덩어리로 보여줍니다.",
  },
  {
    id: "off",
    label: "숨기기",
    detail: "메시지 속 링크만 남기고 카드는 그리지 않습니다.",
  },
];

export function LinkPreviewSection() {
  const preference = useLinkPreviewPreference();

  return (
    <SectionShell
      title="링크 미리보기"
      lines={[
        "메시지 아래 링크 미리보기 카드를 사진 카드, 작은 카드, 숨기기 중 하나로 고릅니다.",
        "이 선택은 서버의 링크 확인이나 다른 멤버의 화면에 영향을 주지 않습니다.",
      ]}
    >
      <ChoiceRadios
        name="link-preview"
        legend="미리보기 모양"
        choices={CHOICES}
        value={preference}
        onChange={(id) => setLinkPreviewPreference(id as LinkPreviewPreference)}
        hint="이 기기에만 저장됩니다. 다른 기기에서는 각자 고릅니다."
        testId="link-preview-choice"
      />
    </SectionShell>
  );
}
