import { Check, Moon, Sun, SunMoon } from "lucide-react";
import { DEFAULT_THEME_ID } from "@momo/core/design/themes";
import {
  ACCENT_THEMES,
  setAccent,
  setTheme,
  useAccentId,
  useSystemScheme,
  useThemeChoice,
  type AccentId,
  type ThemeChoice,
} from "@/design/theme";
import { cn } from "@/design/lib/cn";
import { SegmentedControl, type SegmentOption } from "@/design/ui/segmented-control";
import {
  setLinkPreviewPreference,
  useLinkPreviewPreference,
  type LinkPreviewPreference,
} from "@/features/timeline/linkPreviewPreference";
import { ConversationPreview } from "./shell/ConversationPreview";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { ThemePreviewCard } from "./shell/ThemePreviewCard";

// =============================================================================
// 설정 > 모양 (#3578 S3a; U2 + ADR-0174 BZ-5a의 테마 화면과 링크 미리보기를 한 페이지로).
// 팔레트는 처음부터 두 벌이었고(tokens.css), 없던 것은 고르는 자리뿐이었다. 색 모드는
// 그 자리이고, 강조색은 의미 토큰(`--accent`)의 바인딩만 바꾼다. 컴포넌트는 계속 토큰만
// 소비한다.
//
// 저장 버튼이 없다. 값이 하나이고, 그 결과가 누르는 즉시 화면 전체로 보이므로,
// 확인 절차를 하나 더 두면 사람이 이미 본 것을 다시 승인하게 된다. 되돌리는 길은
// 같은 자리에 그대로 있다. 저장은 전부 이 기기(`localStorage`)이고 페이지 머리의
// 범위 칩이 그것을 말한다.
//
// 이 슬라이스가 **열지 않는 것**: 팔레트(흑연·노을띠) 선택, 밀도, 글자 크기, 유리,
// hex 직접 입력은 앱이 실제로 따르는 S3b에서 함께 열린다. 눌러도 안 바뀌는 컨트롤을
// 먼저 두지 않는다.
// =============================================================================

const MODE_OPTIONS: readonly SegmentOption<ThemeChoice>[] = [
  { value: "system", label: "시스템", Icon: SunMoon },
  { value: "light", label: "라이트", Icon: Sun },
  { value: "dark", label: "다크", Icon: Moon },
];

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

export function AppearanceSection() {
  const choice = useThemeChoice();
  const accent = useAccentId();
  const system = useSystemScheme();
  const linkPreview = useLinkPreviewPreference();

  // 고른 것이 지금 무엇을 뜻하는지 한 줄로 답한다. 「시스템」은 그 자체로는 결과를 말해
  // 주지 않는 이름이라, 지금 이 기기가 어느 쪽인지까지 말해야 사람이 자기가 보게 될
  // 화면을 안다.
  const modeHint =
    choice === "system"
      ? `이 기기의 라이트/다크 설정을 그대로 써요. 지금 이 기기의 시스템은 ${
          system === "dark" ? "다크" : "라이트"
        }예요.`
      : choice === "light"
        ? "기기 설정과 상관없이 밝은 종이로 고정해요."
        : "기기 설정과 상관없이 어두운 하늘로 고정해요.";

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <SettingsSection title="색상">
        <SettingsRow
          label="색 모드"
          description={modeHint}
          labelId="appearance-mode-label"
          descriptionId="appearance-mode-hint"
        >
          <SegmentedControl
            legend="색 모드"
            name="theme"
            options={MODE_OPTIONS}
            value={choice}
            onValueChange={setTheme}
            testId="theme-choice"
          />
        </SettingsRow>
        <SettingsRow
          label="강조색"
          description="안 읽은 표시, 멘션, 선택 링에 쓰는 색이에요. 주 버튼의 색은 바뀌지 않아요. 기본은 새벽이에요."
          align="start"
          stack
        >
          <fieldset data-testid="accent-choice" className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">강조색</legend>
            <div className="flex flex-wrap gap-4">
              {ACCENT_THEMES.map((theme) => (
                <label
                  key={theme.id}
                  data-accent-swatch={theme.id}
                  data-testid={`accent-swatch-${theme.id}`}
                  className="accent-swatch flex cursor-pointer flex-col items-center justify-center gap-1 text-meta text-ink press"
                >
                  <input
                    type="radio"
                    name="appearance-accent"
                    value={theme.id}
                    checked={accent === theme.id}
                    onChange={() => setAccent(theme.id as AccentId)}
                    className="sr-only"
                  />
                  <span
                    className="accent-swatch-chip flex items-center justify-center rounded-full"
                    aria-hidden
                  >
                    <Check className={cn("accent-swatch-check size-4")} aria-hidden />
                  </span>
                  {theme.label}
                </label>
              ))}
            </div>
          </fieldset>
        </SettingsRow>
        <SettingsRow label="미리보기" description="고른 색 모드와 강조색으로 앱이 이렇게 보여요." stack>
          <ThemePreviewCard mode={choice} accent={accent} palette={DEFAULT_THEME_ID} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="대화 표시"
        description="이 선택은 서버의 링크 확인이나 다른 멤버의 화면에 영향을 주지 않아요."
      >
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
        <SettingsRow label="대화 미리보기" description="링크 카드가 메시지 아래에 이렇게 놓여요." stack>
          <ConversationPreview linkPreview={linkPreview} />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
