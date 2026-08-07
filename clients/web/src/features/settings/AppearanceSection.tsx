import {
  setTheme,
  useSystemScheme,
  useThemeChoice,
  type ThemeChoice,
} from "@/design/theme";
import { ChoiceRadios, SectionShell } from "./SettingsFields";

// =============================================================================
// 설정 > 테마 (U2). 팔레트는 처음부터 두 벌이었고(tokens.css), 없던 것은 고르는
// 자리뿐이었다. 그래서 이 패널이 하는 일은 하나다: 루트에 스탬프를 찍을지, 찍는다
// 면 어느 쪽으로 찍을지를 사람이 정하게 하는 것.
//
// 저장 버튼이 없다. 값이 하나이고, 그 결과가 누르는 즉시 화면 전체로 보이므로,
// 확인 절차를 하나 더 두면 사람이 이미 본 것을 다시 승인하게 된다. 되돌리는 길은
// 같은 자리에 그대로 있다.
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
  const system = useSystemScheme();

  // 고른 것이 지금 무엇을 뜻하는지 한 줄로 답한다. "시스템 설정 따르기"는 그
  // 자체로는 결과를 말해 주지 않는 문장이라, 지금 이 기기가 어느 쪽인지까지
  // 말해야 사람이 자기가 보게 될 화면을 안다.
  const hint =
    choice === "system"
      ? `지금 이 기기의 시스템은 ${system === "dark" ? "다크" : "라이트"}입니다.`
      : "이 브라우저에만 저장됩니다. 다른 기기에서는 각자 고릅니다.";

  return (
    <SectionShell
      title="테마"
      lines={["이 앱을 밝게 볼지 어둡게 볼지 고릅니다."]}
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
    </SectionShell>
  );
}
