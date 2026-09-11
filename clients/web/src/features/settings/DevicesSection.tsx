import { useQueryClient } from "@tanstack/react-query";
import { SectionShell } from "./SettingsFields";
import { DeviceLinkCard } from "./DeviceLinkCard";
import { LinkedDevicesList } from "./LinkedDevicesList";
import { LINKED_DEVICES_QUERY_KEY } from "./linkedDevicesQuery";

export function DevicesSection({ offline }: { offline: boolean }) {
  const client = useQueryClient();
  return (
    <SectionShell
      title="기기"
      lines={[
        "이 계정에 붙어 있는 기기입니다. 최근 활동 미기록.",
        "이 계정을 폰에서도 쓰려면 아래에서 QR을 만듭니다.",
      ]}
    >
      <LinkedDevicesList offline={offline} />
      <DeviceLinkCard
        offline={offline}
        onLinked={() => {
          void client.invalidateQueries({ queryKey: LINKED_DEVICES_QUERY_KEY });
        }}
      />
    </SectionShell>
  );
}
