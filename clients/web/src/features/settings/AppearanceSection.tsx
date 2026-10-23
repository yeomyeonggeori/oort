import { FontFamilyRows } from "./FontFamilyRows";
import { BackdropCard } from "./appearance/BackdropCard";
import { DisplayPrefs } from "./appearance/DisplayPrefs";
import { MyThemesCard } from "./appearance/MyThemesCard";
import { ThemeCard } from "./appearance/ThemeCard";
import { SettingsSection } from "./shell/SettingsSection";

// =============================================================================
// 설정 > 모양 (#3578 S3a; AP-1a #4186에서 합성 전용으로 줄였다).
//
// 이 파일은 카드를 **쌓기만** 한다. 병렬로 가는 이슈들이 서로 다른 파일만 만지도록(청사진
// §5.7.1) 카드와 행을 모듈로 나눴다: `appearance/ThemeCard`(색상)·`DisplayPrefs`(대화 표시)는
// 지금 있는 내용을 그대로 들고, 그 안의 행 슬롯과 `BackdropCard`·`MyThemesCard`는 소유 이슈가
// 열기 전까지 아무것도 그리지 않는다. 그래서 페이지의 DOM은 합성 전과 같다.
//
// 글꼴(#3774)은 시스템 서체가 기본이고 설치된 글꼴 이름을 적는 방식이다(FontFamilyRows).
// 카드 순서는 색상 → (배경) → 글꼴 → 대화 표시 → (내 테마)다. 청사진의 순서(글꼴을 대화 표시
// 아래로)는 보이는 변화라 이 이슈에서 바꾸지 않는다.
// =============================================================================

export function AppearanceSection() {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ThemeCard />
      <BackdropCard />
      <SettingsSection
        title="글꼴"
        description="이 기기에 설치된 글꼴 이름을 적으면 앱이 그 글꼴로 보여요. 앱은 글꼴을 내려받지 않고, 이름이 이 기기에 없으면 시스템 서체로 보여요."
      >
        <FontFamilyRows />
      </SettingsSection>
      <DisplayPrefs />
      <MyThemesCard />
    </div>
  );
}
