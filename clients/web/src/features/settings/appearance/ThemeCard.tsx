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
import { SettingsRow } from "../shell/SettingsRow";
import { SettingsSection } from "../shell/SettingsSection";
import { ThemePreviewCard } from "../shell/ThemePreviewCard";
import { GlassRows } from "./GlassRows";
import { ProminentRow } from "./ProminentRow";
import { ThemeStyleRow } from "./ThemeStyleRow";

// 카드 「색상」 (#3578 S3a에서 옮김, AP-1a #4186). 색 모드와 강조색은 의미 토큰(`--accent`)의
// 바인딩만 바꾸고, 컴포넌트는 계속 토큰만 소비한다. 저장 버튼이 없다: 값이 하나이고, 그 결과가
// 누르는 즉시 화면 전체로 보이므로 확인 절차를 하나 더 두면 사람이 이미 본 것을 다시 승인하게
// 된다. 저장은 전부 이 기기(`localStorage`)이고 페이지 머리의 범위 칩이 그것을 말한다.
//
// 슬롯(`ThemeStyleRow`·`GlassRows`·`ProminentRow`)은 소유 이슈가 열기 전까지 아무것도 그리지
// 않는다. 자리는 청사진 §5.3-a의 순서다: 색 모드 → 테마 스타일 → 강조색 → 유리 → 선택한 항목 강조.

const MODE_OPTIONS: readonly SegmentOption<ThemeChoice>[] = [
  { value: "system", label: "시스템", Icon: SunMoon },
  { value: "light", label: "라이트", Icon: Sun },
  { value: "dark", label: "다크", Icon: Moon },
];

export function ThemeCard() {
  const choice = useThemeChoice();
  const accent = useAccentId();
  const system = useSystemScheme();

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
      <ThemeStyleRow />
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
      <GlassRows />
      <ProminentRow />
      <SettingsRow label="미리보기" description="고른 색 모드와 강조색으로 앱이 이렇게 보여요." stack>
        <ThemePreviewCard mode={choice} accent={accent} palette={DEFAULT_THEME_ID} />
      </SettingsRow>
    </SettingsSection>
  );
}
