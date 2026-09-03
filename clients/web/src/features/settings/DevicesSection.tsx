import { SectionShell } from "./SettingsFields";
import { DeviceLinkCard } from "./DeviceLinkCard";

// Linked-device list + revoke are #2029 (GET /v1/auth/devices,
// DELETE /v1/auth/devices/{id}). This surface only issues a phone-link QR.
export function DevicesSection({ offline }: { offline: boolean }) {
  return (
    <SectionShell
      title="기기"
      lines={["이 계정을 폰에서도 쓰려면 여기서 QR을 만듭니다."]}
    >
      <DeviceLinkCard offline={offline} />
    </SectionShell>
  );
}
