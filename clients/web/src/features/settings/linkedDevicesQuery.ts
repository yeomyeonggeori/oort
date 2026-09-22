import type { LinkedDevice } from "@momo/core/features/auth/linkedDevices";
import { listLinkedDevices } from "@momo/core/features/auth/linkedDevices";

/** Settings query prefix so `resetSettingsQueries` covers this list. */
export const LINKED_DEVICES_QUERY_KEY = ["settings", "linked-devices"] as const;

/**
 * List options. Built at module scope so `queryFn` does not capture a render
 * (webhook list, same reason).
 */
export function linkedDevicesQuery() {
  return {
    queryKey: LINKED_DEVICES_QUERY_KEY,
    queryFn: async (): Promise<LinkedDevice[]> =>
      (await listLinkedDevices()).devices,
    retry: false,
  };
}
