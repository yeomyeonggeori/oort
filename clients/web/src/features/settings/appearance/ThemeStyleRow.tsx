import { Suspense, lazy } from "react";
import { SettingsRow } from "../shell/SettingsRow";

// 테마 스타일 행: 선택한 테마의 썸네일과 갤러리 격자 (AP-1a #4186 자리표시, AP-1b #4188이 채운다).
// 자리: 카드 「색상」, 색 모드 바로 아래. 합성하는 쪽(이 행을 부르는 카드)은 건드리지 않는다.
//
// 갤러리는 **지연 청크**다. 카탈로그 씨앗 표와 파생 엔진이 함께 실려서(테마 지연 청크 합 gzip 약 12KB) 메인 번들에 넣지 않는다
// (번들 예산: `gate:theme-bundle`, 설정 모양 청크 ≤ 25KB · 메인 청크 증가 ≤ 2KB). 청크를 받는 동안은 같은 라벨의
// 행과 중립 막대 자리가 서서 행 높이가 변하지 않는다. 청크를 받지 못하면(오프라인) 한 줄로 말한다.

/** 이 행을 열었다(AP-1b). 슬롯 시험(`appearanceSlots.test.tsx`)의 「아무것도 안 그린다」 단정에서 빠진다. */
export const THEME_STYLE_ROW_OPEN: boolean = true;

/** 접힌 행의 라벨과 설명. 갤러리(지연 청크)도 같은 글을 쓰려고 내보낸다(두 곳에서 어긋나지 않게). */
export const ROW_LABEL = "테마 스타일";
export const ROW_DESCRIPTION =
  "앱 전체에 쓰는 색 조합이에요. 라이트와 다크를 모두 가진 테마는 색 모드에 맞춰 바뀌어요.";

function Pending() {
  return (
    <SettingsRow label={ROW_LABEL} description={<span className="block text-balance">{ROW_DESCRIPTION}</span>} testId="theme-style-row-pending">
      {/* 접힌 행(`ThemeGallery`의 트리거)과 같은 배치: 이름 자리 막대 + 썸네일 자리 막대. 좁은 카드에서도 같이 세로로 쌓인다. */}
      <span aria-hidden="true" className="theme-style-trigger">
        <span className="theme-style-skeleton-name" />
        <span className="theme-style-trigger-tail">
          <span className="theme-style-skeleton" />
        </span>
      </span>
    </SettingsRow>
  );
}

function Unavailable() {
  return (
    <SettingsRow
      label={ROW_LABEL}
      description="테마 목록을 불러오지 못했어요. 앱을 새로 고치면 다시 불러와요."
      role="alert"
      testId="theme-style-row-failed"
    />
  );
}

// 받지 못한 import는 던지는 대신 안내 행을 낸다(설정 화면 전체가 무너지지 않는다).
const ThemeGallery = lazy(() =>
  import("./ThemeGallery").catch(() => ({ default: Unavailable }))
);

export function ThemeStyleRow() {
  return (
    <Suspense fallback={<Pending />}>
      <ThemeGallery />
    </Suspense>
  );
}
