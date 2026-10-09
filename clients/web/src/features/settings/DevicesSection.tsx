import { useQueryClient } from "@tanstack/react-query";
import {
  listDeviceKeys,
  phoneKeyForLinkedDevice,
  submitRevocation,
} from "@momo/core/features/auth/deviceKeys";
import { desktopDeviceKey, isDesktop } from "@/lib/tauri";
import { SettingsSection } from "./shell/SettingsSection";
import { ThisMacHostBlock } from "./ThisMacHostBlock";
import { useWorkHosts } from "./workHostsQuery";
import { MyTierPolicySection } from "./workTierPolicy";
import { DeviceLinkCard } from "./DeviceLinkCard";
import { LinkedDevicesList, type BeforeUnlink } from "./LinkedDevicesList";
import { LINKED_DEVICES_QUERY_KEY } from "./linkedDevicesQuery";
import { DeviceKeysBlock } from "./DeviceKeysBlock";
import { DEVICE_KEYS_QUERY_KEY, hostDeliveryCopy } from "./deviceKeysShared";

// =============================================================================
// 설정 > 기기 (#3578 S4). 전부 **내 것**이다: 내 계정에 QR로 연결한 기기, 지시에 서명하는
// 키, 이 맥을 작업 호스트로 등록하는 일(`scope:"member"`, 소유자는 나), 그 호스트를
// 잃었을 때의 내 재개 정책. 워크스페이스에 하나라는 「실행 엔진」 선택은 없다
// (ADR-0198 D4: 하네스는 사람마다, 내 맥에서 돈다). 이 맥 블록은 AI 허브 「내 도구」
// 카드(T3)가 합쳐 가면 그쪽으로 옮긴다.
// =============================================================================

export function DevicesSection({
  offline,
  workspaceId,
  memberId,
  workPolicy = false,
}: {
  offline: boolean;
  workspaceId?: string;
  memberId?: string;
  /**
   * 이 서버·이 워크스페이스에 작업 표면이 서 있다(`code` 목차 행과 같은 판정). 서 있어야
   * 내 재개 정책 질의가 의미 있다. 데스크탑은 항상 서 있다.
   */
  workPolicy?: boolean;
}) {
  const client = useQueryClient();
  // The R2 root lives in the desktop shell (#3025). A browser tab shows the
  // linked devices as before and nothing about signing.
  const signing = isDesktop() && workspaceId && memberId ? { workspaceId, memberId } : null;
  // 작업 호스트 표면: 이 맥 블록은 데스크탑 셸에만 있고, 내 재개 정책은 작업 표면이 선
  // 곳(브라우저 포함)에 있다. 한 등록부 질의가 둘을 먹인다.
  const host = workspaceId && memberId ? { workspaceId, memberId } : null;
  const showThisMac = isDesktop() && host !== null;
  const showPolicy = (isDesktop() || workPolicy) && host !== null;
  const hosts = useWorkHosts(host?.workspaceId ?? "", showThisMac || showPolicy);

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
            targetLabel: key.label,
          });
          await submitRevocation(signing.workspaceId, key.id, {
            rootKeyId: letter.rootKeyId,
            revokedAtMs: letter.revokedAtMs,
            signature: letter.signature,
          });
          return `그 폰의 지시 권한도 끊었어요. ${hostDeliveryCopy(letter.host)}`;
        } catch {
          return "지시 권한 해제에 서명하지 못했어요. 연결을 끊으면 서버에서는 그 폰의 키도 함께 해제돼요.";
        } finally {
          void client.invalidateQueries({
            queryKey: DEVICE_KEYS_QUERY_KEY(signing.workspaceId),
          });
        }
      }
    : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="devices-page">
      {signing && (
        <DeviceKeysBlock
          workspaceId={signing.workspaceId}
          memberId={signing.memberId}
          offline={offline}
        />
      )}
      {showThisMac && host && (
        <ThisMacHostBlock workspaceId={host.workspaceId} hosts={hosts} offline={offline} />
      )}
      {showPolicy && host && (
        <MyTierPolicySection
          workspaceId={host.workspaceId}
          memberId={host.memberId}
          hosts={hosts}
          offline={offline}
        />
      )}
      <LinkedDevicesList offline={offline} beforeUnlink={beforeUnlink} />
      <SettingsSection
        title="폰 연결"
        description="이 계정을 폰에서도 쓰려면 QR을 만들어 폰으로 찍어요."
        testId="device-link-section"
      >
        <DeviceLinkCard
          offline={offline}
          onLinked={() => {
            void client.invalidateQueries({ queryKey: LINKED_DEVICES_QUERY_KEY });
            // A phone registers its key when it links (E6): it shows up for
            // approval in 지시 서명 without a reload (D-6 ②).
            if (signing) {
              void client.invalidateQueries({
                queryKey: DEVICE_KEYS_QUERY_KEY(signing.workspaceId),
              });
            }
          }}
        />
      </SettingsSection>
    </div>
  );
}
