import { useQueryClient } from "@tanstack/react-query";
import {
  listDeviceKeys,
  phoneKeyForLinkedDevice,
  submitRevocation,
} from "@momo/core/features/auth/deviceKeys";
import { desktopDeviceKey, isDesktop } from "@/lib/tauri";
import { SectionShell } from "./SettingsFields";
import { DeviceLinkCard } from "./DeviceLinkCard";
import { LinkedDevicesList, type BeforeUnlink } from "./LinkedDevicesList";
import { LINKED_DEVICES_QUERY_KEY } from "./linkedDevicesQuery";
import { DeviceKeysBlock } from "./DeviceKeysBlock";
import { DEVICE_KEYS_QUERY_KEY, hostDeliveryCopy } from "./deviceKeysShared";

export function DevicesSection({
  offline,
  workspaceId,
  memberId,
}: {
  offline: boolean;
  workspaceId?: string;
  memberId?: string;
}) {
  const client = useQueryClient();
  // The R2 root lives in the desktop shell (#3025). A browser tab shows the
  // linked devices as before and nothing about signing.
  const signing = isDesktop() && workspaceId && memberId ? { workspaceId, memberId } : null;

  // Unlinking a phone that is an instruction device: the root signs a
  // revocation letter first, so this Mac's workd learns it over the local
  // socket even if the server never passes it on (ADR-0146 D-7). Only when
  // exactly one live phone key matches the row (no shared id on the wire).
  const beforeUnlink: BeforeUnlink | undefined = signing
    ? async (device) => {
        try {
          const keys = await listDeviceKeys(signing.workspaceId);
          const key = phoneKeyForLinkedDevice(keys, device);
          if (!key || key.state !== "endorsed") return null;
          const letter = await desktopDeviceKey.signRevoke({
            workspaceId: signing.workspaceId,
            targetKeyId: key.id,
            targetPublicKey: key.publicKey,
            targetLabel: key.label,
          });
          await submitRevocation(signing.workspaceId, key.id, {
            rootKeyId: letter.rootKeyId,
            revokedAtMs: letter.revokedAtMs,
            signature: letter.signature,
          });
          return `그 폰의 지시 권한도 끊었습니다. ${hostDeliveryCopy(letter.host)}`;
        } catch {
          return "지시 권한 폐기서는 보내지 못했습니다. 연결 해제로 서버의 키는 함께 끝납니다.";
        } finally {
          void client.invalidateQueries({
            queryKey: DEVICE_KEYS_QUERY_KEY(signing.workspaceId),
          });
        }
      }
    : undefined;

  return (
    <SectionShell
      title="기기"
      lines={["이 계정에 QR로 붙인 기기입니다."]}
    >
      {signing && (
        <DeviceKeysBlock
          workspaceId={signing.workspaceId}
          memberId={signing.memberId}
          offline={offline}
        />
      )}
      <LinkedDevicesList offline={offline} beforeUnlink={beforeUnlink} />
      <DeviceLinkCard
        offline={offline}
        onLinked={() => {
          void client.invalidateQueries({ queryKey: LINKED_DEVICES_QUERY_KEY });
        }}
      />
    </SectionShell>
  );
}
