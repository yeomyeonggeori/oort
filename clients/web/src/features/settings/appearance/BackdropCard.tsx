import { SettingsSection } from "../shell/SettingsSection";
import { SidebarColorRow } from "./SidebarColorRow";
import { WallpaperRow } from "./WallpaperRow";

// 카드 「배경」의 합성 (AP-1a #4186). 행은 AP-4(#4191)의 WallpaperRow와 AP-5(#4192)의
// SidebarColorRow다. 소유 이슈는 자기 행 파일만 채운다.
//
// 열린 행이 하나도 없는 동안은 카드 껍데기를 그리지 않는다(빈 카드는 가짜 컨트롤보다 나쁘다).
// 먼저 착륙하는 이슈가 행을 채우는 같은 PR에서 아래 한 줄을 `true`로 바꾼다. 둘이 같은 줄을
// 같은 값으로 바꾸므로 뒤에 오는 쪽과 합쳐도 충돌하지 않는다.
const OPEN = false;

/** `open`은 시험이 합성(어느 행을 어느 순서로 부르는가)을 재려고 쓰는 틈이다. 화면은 기본값을 쓴다. */
export function BackdropCard({ open = OPEN }: { open?: boolean }) {
  if (!open) return null;
  return (
    <SettingsSection title="배경">
      <WallpaperRow />
      <SidebarColorRow />
    </SettingsSection>
  );
}
