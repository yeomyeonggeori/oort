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
import { ChoiceRadios, SectionShell } from "./SettingsFields";

// =============================================================================
// 설정 > 테마 (U2 + ADR-0174 BZ-5a). 팔레트는 처음부터 두 벌이었고(tokens.css),
// 없던 것은 고르는 자리뿐이었다. 컬러 모드는 그 자리이고, 액센트는 의미 토큰
// (`--accent`)의 바인딩만 바꾼다. 컴포넌트는 계속 토큰만 소비한다.
//
// 저장 버튼이 없다. 값이 하나이고, 그 결과가 누르는 즉시 화면 전체로 보이므로,
// 확인 절차를 하나 더 두면 사람이 이미 본 것을 다시 승인하게 된다. 되돌리는 길은
// 같은 자리에 그대로 있다. 기본 액센트는 항상 새벽(호박)이 첫 값이다.
// =============================================================================

const CHOICES = [
  {
    id: "system",
    label: "시스템 설정 따르기",
    detail: "이 기기의 라이트/다크 설정을 그대로 씁니다.",
  },
  {
    id: "light",
    label: "라이트",
    detail: "기기 설정과 상관없이 밝은 종이로 고정합니다.",
  },
  {
    id: "dark",
    label: "다크",
    detail: "기기 설정과 상관없이 어두운 하늘로 고정합니다.",
  },
];

export function AppearanceSection() {
  const choice = useThemeChoice();
  const accent = useAccentId();
  const system = useSystemScheme();

  // 고른 것이 지금 무엇을 뜻하는지 한 줄로 답한다. "시스템 설정 따르기"는 그
  // 자체로는 결과를 말해 주지 않는 문장이라, 지금 이 기기가 어느 쪽인지까지
  // 말해야 사람이 자기가 보게 될 화면을 안다.
  const hint =
    choice === "system"
      ? `지금 이 기기의 시스템은 ${system === "dark" ? "다크" : "라이트"}입니다.`
      : "다른 기기에서는 각자 고릅니다.";

  return (
    <SectionShell
      title="테마"
      lines={[
        "이 앱을 밝게 볼지 어둡게 볼지, 그리고 액센트 색을 고릅니다. 이 브라우저에만 저장됩니다.",
      ]}
    >
      <ChoiceRadios
        name="theme"
        legend="화면 밝기"
        choices={CHOICES}
        value={choice}
        onChange={(id) => setTheme(id as ThemeChoice)}
        hint={hint}
        testId="theme-choice"
      />
      <fieldset data-testid="accent-choice">
        <legend className="pb-1 text-meta text-ink-muted">액센트</legend>
        <div className="flex flex-wrap gap-2">
          {ACCENT_THEMES.map((theme) => (
            <label
              key={theme.id}
              data-accent-swatch={theme.id}
              data-testid={`accent-swatch-${theme.id}`}
              className={cn(
                "accent-swatch flex cursor-pointer flex-col items-center justify-center gap-1 rounded-sm border border-line p-1 text-meta hover:bg-surface-hover"
              )}
            >
              <input
                type="radio"
                name="appearance-accent"
                value={theme.id}
                checked={accent === theme.id}
                onChange={() => setAccent(theme.id as AccentId)}
                className="sr-only"
              />
              <span className="accent-swatch-chip rounded-sm" aria-hidden />
              <span className="text-meta text-ink">{theme.label}</span>
            </label>
          ))}
        </div>
        <p className="pt-1 text-meta text-ink-muted">기본은 새벽입니다.</p>
      </fieldset>
    </SectionShell>
  );
}
