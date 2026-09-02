import { SectionShell } from "./SettingsFields";
import { DeviceLinkCard } from "./DeviceLinkCard";

export function DevicesSection({ offline }: { offline: boolean }) {
  return (
    <SectionShell
      title="기기"
      lines={["이 계정에 붙인 다른 기기를 이 자리에서 연결합니다."]}
    >
      <DeviceLinkCard offline={offline} />
    </SectionShell>
  );
}
